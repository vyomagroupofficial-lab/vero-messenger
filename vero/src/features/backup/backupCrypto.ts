/**
 * Encrypted backup file format (pure; unit-tested in tests/backup.test.ts).
 *
 *   "VEROBAK1"                      8-byte magic
 *   u32 BE  headerLength
 *   header                          UTF-8 JSON (BackupHeader, below)
 *   secretstream header             24 bytes
 *   frames                          u32 BE length || XChaCha20-Poly1305 secretstream
 *                                   ciphertext of <= 64 KiB of plaintext; the last
 *                                   frame carries TAG_FINAL
 *
 * A random 256-bit BACKUP KEY encrypts the stream. It is stored in the header
 * wrapped (XChaCha20-Poly1305, associated data "vero-backup/v1|slot|<type>|<userId>")
 * once per secret the user chose:
 *   passphrase  KEK = Argon2id(passphrase, salt) - crypto_pwhash, MODERATE limits
 *   recovery    KEK = BLAKE2b-256(key = 300-bit recovery key, "vero-backup/v1|recovery|" || salt)
 * so EITHER secret unlocks the backup. The whole header (slots, user id,
 * parameters) is the associated data of the first frame, so any change to it
 * - or to any frame, their order, or a truncation - fails decryption.
 *
 * The server stores only this file; it never sees a passphrase, the recovery
 * key or the backup key.
 */

import type * as SumoModule from 'libsodium-wrappers-sumo';

export type SumoSodium = typeof SumoModule;

const MAGIC = 'VEROBAK1';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_CHUNK_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
export const MIN_PASSPHRASE_LENGTH = 12;

export type SlotType = 'passphrase' | 'recovery';

export interface PassphraseSlot {
  type: 'passphrase';
  kdf: 'argon2id13';
  opslimit: number;
  memlimit: number;
  salt: string;
  nonce: string;
  wrappedKey: string;
}

export interface RecoverySlot {
  type: 'recovery';
  kdf: 'blake2b';
  salt: string;
  nonce: string;
  wrappedKey: string;
}

export type KeySlot = PassphraseSlot | RecoverySlot;

export interface BackupHeader {
  v: 1;
  userId: string;
  createdAt: string;
  chunkBytes: number;
  slots: KeySlot[];
}

export class BackupError extends Error {
  constructor(
    message: string,
    readonly reason: 'format' | 'wrong-secret' | 'corrupt' | 'account' | 'input'
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface KdfLimits {
  opslimit: number;
  memlimit: number;
}

/** Argon2id MODERATE (3 passes, 256 MiB): the default for new passphrase slots. */
export function moderateLimits(sodium: SumoSodium): KdfLimits {
  return { opslimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE, memlimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE };
}

function slotAd(type: SlotType, userId: string): string {
  return `vero-backup/v1|slot|${type}|${userId}`;
}

export function validatePassphrase(passphrase: string): string | null {
  const p = passphrase.normalize('NFKC');
  if ([...p].length < MIN_PASSPHRASE_LENGTH) return `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  if (/^(.)\1+$/u.test(p)) return 'Choose a passphrase that is not a single repeated character.';
  return null;
}

function passphraseKek(sodium: SumoSodium, passphrase: string, salt: Uint8Array, limits: KdfLimits): Uint8Array {
  return sodium.crypto_pwhash(
    KEY_BYTES,
    sodium.from_string(passphrase.normalize('NFKC')),
    salt,
    limits.opslimit,
    limits.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
}

/** `recoverySecret` = the 60 data characters returned by parseRecoveryKey(). */
function recoveryKek(sodium: SumoSodium, recoverySecret: string, salt: Uint8Array): Uint8Array {
  const prefix = sodium.from_string('vero-backup/v1|recovery|');
  const msg = new Uint8Array(prefix.length + salt.length);
  msg.set(prefix);
  msg.set(salt, prefix.length);
  return sodium.crypto_generichash(KEY_BYTES, msg, sodium.from_string(recoverySecret));
}

function wrap(sodium: SumoSodium, kek: Uint8Array, backupKey: Uint8Array, type: SlotType, userId: string) {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const wrapped = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(backupKey, slotAd(type, userId), null, nonce, kek);
  return { nonce: sodium.to_base64(nonce), wrappedKey: sodium.to_base64(wrapped) };
}

export function generateBackupKey(sodium: SumoSodium): Uint8Array {
  return sodium.randombytes_buf(KEY_BYTES);
}

export function createPassphraseSlot(
  sodium: SumoSodium,
  backupKey: Uint8Array,
  userId: string,
  passphrase: string,
  limits: KdfLimits = moderateLimits(sodium)
): PassphraseSlot {
  const problem = validatePassphrase(passphrase);
  if (problem) throw new BackupError(problem, 'input');
  const salt = sodium.randombytes_buf(SALT_BYTES);
  const kek = passphraseKek(sodium, passphrase, salt, limits);
  try {
    return {
      type: 'passphrase',
      kdf: 'argon2id13',
      opslimit: limits.opslimit,
      memlimit: limits.memlimit,
      salt: sodium.to_base64(salt),
      ...wrap(sodium, kek, backupKey, 'passphrase', userId),
    };
  } finally {
    sodium.memzero(kek);
  }
}

export function createRecoverySlot(sodium: SumoSodium, backupKey: Uint8Array, userId: string, recoverySecret: string): RecoverySlot {
  const salt = sodium.randombytes_buf(SALT_BYTES);
  const kek = recoveryKek(sodium, recoverySecret, salt);
  try {
    return { type: 'recovery', kdf: 'blake2b', salt: sodium.to_base64(salt), ...wrap(sodium, kek, backupKey, 'recovery', userId) };
  } finally {
    sodium.memzero(kek);
  }
}

// ── Container ────────────────────────────────────────────────────────────────

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new BackupError('The backup file is truncated.', 'corrupt');
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function encryptBackup(
  sodium: SumoSodium,
  p: { backupKey: Uint8Array; userId: string; slots: KeySlot[]; plaintext: Uint8Array; createdAt?: string }
): Uint8Array {
  if (!p.slots.length) throw new BackupError('A backup needs a passphrase or a recovery key.', 'input');
  const header: BackupHeader = {
    v: BACKUP_FORMAT_VERSION,
    userId: p.userId,
    createdAt: p.createdAt ?? new Date().toISOString(),
    chunkBytes: BACKUP_CHUNK_BYTES,
    slots: p.slots,
  };
  const headerBytes = sodium.from_string(JSON.stringify(header));
  if (headerBytes.length > MAX_HEADER_BYTES) throw new BackupError('Backup header too large', 'input');

  const { state, header: streamHeader } = sodium.crypto_secretstream_xchacha20poly1305_init_push(p.backupKey);
  const parts: Uint8Array[] = [sodium.from_string(MAGIC), u32(headerBytes.length), headerBytes, streamHeader];
  const total = p.plaintext.length;
  let offset = 0;
  let first = true;
  do {
    const end = Math.min(offset + BACKUP_CHUNK_BYTES, total);
    const last = end >= total;
    const frame = sodium.crypto_secretstream_xchacha20poly1305_push(
      state,
      p.plaintext.subarray(offset, end),
      first ? headerBytes : null,
      last ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
    );
    parts.push(u32(frame.length), frame);
    offset = end;
    first = false;
  } while (offset < total);
  return concat(parts);
}

const B64_RE = /^[A-Za-z0-9_-]+$/;
const isB64 = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length <= max && B64_RE.test(v);

function parseSlot(raw: any): KeySlot | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!isB64(raw.salt) || !isB64(raw.nonce) || !isB64(raw.wrappedKey)) return null;
  if (raw.type === 'passphrase' && raw.kdf === 'argon2id13') {
    const ops = raw.opslimit;
    const mem = raw.memlimit;
    // Bounds keep a tampered header from making the device hash for minutes or
    // allocate gigabytes; weaker parameters just fail to unwrap the key.
    if (!Number.isInteger(ops) || ops < 1 || ops > 10) return null;
    if (!Number.isInteger(mem) || mem < 8192 || mem > 1024 * 1024 * 1024) return null;
    return { type: 'passphrase', kdf: 'argon2id13', opslimit: ops, memlimit: mem, salt: raw.salt, nonce: raw.nonce, wrappedKey: raw.wrappedKey };
  }
  if (raw.type === 'recovery' && raw.kdf === 'blake2b') {
    return { type: 'recovery', kdf: 'blake2b', salt: raw.salt, nonce: raw.nonce, wrappedKey: raw.wrappedKey };
  }
  return null;
}

export interface ParsedBackup {
  header: BackupHeader;
  headerBytes: Uint8Array;
  body: Uint8Array;
}

/** Reads the plaintext header (no secret needed): who it belongs to, when, which secrets unlock it. */
export function parseBackup(sodium: SumoSodium, bytes: Uint8Array): ParsedBackup {
  if (bytes.length < MAGIC.length + 4 || sodium.to_string(bytes.subarray(0, MAGIC.length)) !== MAGIC) {
    throw new BackupError('This is not a Vero backup.', 'format');
  }
  const headerLength = readU32(bytes, MAGIC.length);
  const headerStart = MAGIC.length + 4;
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || headerStart + headerLength > bytes.length) {
    throw new BackupError('The backup file is damaged.', 'corrupt');
  }
  const headerBytes = bytes.slice(headerStart, headerStart + headerLength);
  let raw: any;
  try {
    raw = JSON.parse(sodium.to_string(headerBytes));
  } catch {
    throw new BackupError('The backup file is damaged.', 'corrupt');
  }
  if (!raw || raw.v !== BACKUP_FORMAT_VERSION) throw new BackupError('This backup was made by a newer version of Vero.', 'format');
  if (typeof raw.userId !== 'string' || typeof raw.createdAt !== 'string' || !Array.isArray(raw.slots)) {
    throw new BackupError('The backup file is damaged.', 'corrupt');
  }
  if (!Number.isInteger(raw.chunkBytes) || raw.chunkBytes < 1 || raw.chunkBytes > 4 * 1024 * 1024) {
    throw new BackupError('The backup file is damaged.', 'corrupt');
  }
  const slots = (raw.slots as unknown[]).map(parseSlot).filter((s): s is KeySlot => s !== null);
  if (!slots.length || slots.length > 4) throw new BackupError('The backup file is damaged.', 'corrupt');
  return {
    header: { v: 1, userId: raw.userId, createdAt: raw.createdAt, chunkBytes: raw.chunkBytes, slots },
    headerBytes,
    body: bytes.subarray(headerStart + headerLength),
  };
}

export type BackupSecret = { passphrase: string } | { recoverySecret: string };

/** Unwraps the backup key with a passphrase or recovery key. Throws BackupError('wrong-secret'). */
export function unlockBackupKey(sodium: SumoSodium, header: BackupHeader, secret: BackupSecret): Uint8Array {
  const type: SlotType = 'passphrase' in secret ? 'passphrase' : 'recovery';
  const slot = header.slots.find((s) => s.type === type);
  if (!slot) {
    throw new BackupError(
      type === 'passphrase' ? 'This backup has no passphrase. Use your recovery key.' : 'This backup has no recovery key. Use your passphrase.',
      'input'
    );
  }
  const salt = sodium.from_base64(slot.salt);
  const kek =
    slot.type === 'passphrase'
      ? passphraseKek(sodium, (secret as { passphrase: string }).passphrase, salt, slot)
      : recoveryKek(sodium, (secret as { recoverySecret: string }).recoverySecret, salt);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      sodium.from_base64(slot.wrappedKey),
      slotAd(slot.type, header.userId),
      sodium.from_base64(slot.nonce),
      kek
    );
  } catch {
    throw new BackupError(
      type === 'passphrase' ? 'Wrong passphrase.' : 'Wrong recovery key for this backup.',
      'wrong-secret'
    );
  } finally {
    sodium.memzero(kek);
  }
}

/** Decrypts and authenticates the whole stream. Throws BackupError('corrupt') on any tampering. */
export function decryptBackupBody(sodium: SumoSodium, parsed: ParsedBackup, backupKey: Uint8Array): Uint8Array {
  const { body, headerBytes } = parsed;
  const HEADER_BYTES = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
  if (body.length < HEADER_BYTES) throw new BackupError('The backup file is truncated.', 'corrupt');
  let state;
  try {
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(body.subarray(0, HEADER_BYTES), backupKey);
  } catch {
    throw new BackupError('The backup file is damaged.', 'corrupt');
  }
  const maxFrame = parsed.header.chunkBytes + sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
  const parts: Uint8Array[] = [];
  let offset = HEADER_BYTES;
  let first = true;
  let finished = false;
  while (offset < body.length) {
    if (finished) throw new BackupError('The backup file has unexpected trailing data.', 'corrupt');
    const len = readU32(body, offset);
    offset += 4;
    if (len < sodium.crypto_secretstream_xchacha20poly1305_ABYTES || len > maxFrame || offset + len > body.length) {
      throw new BackupError('The backup file is damaged.', 'corrupt');
    }
    let res: { message: Uint8Array; tag: number } | false;
    try {
      res = sodium.crypto_secretstream_xchacha20poly1305_pull(state, body.subarray(offset, offset + len), first ? headerBytes : null);
    } catch {
      res = false;
    }
    if (!res) throw new BackupError('The backup was modified or is damaged.', 'corrupt');
    parts.push(res.message);
    offset += len;
    first = false;
    if (res.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) finished = true;
  }
  if (!finished) throw new BackupError('The backup file is truncated.', 'corrupt');
  return concat(parts);
}

/** parse + unlock + decrypt, checking that the backup belongs to `expectedUserId`. */
export function decryptBackup(
  sodium: SumoSodium,
  bytes: Uint8Array,
  secret: BackupSecret,
  expectedUserId: string
): { header: BackupHeader; plaintext: Uint8Array; backupKey: Uint8Array } {
  const parsed = parseBackup(sodium, bytes);
  if (parsed.header.userId !== expectedUserId) throw new BackupError('This backup belongs to a different account.', 'account');
  const backupKey = unlockBackupKey(sodium, parsed.header, secret);
  return { header: parsed.header, plaintext: decryptBackupBody(sodium, parsed, backupKey), backupKey };
}
