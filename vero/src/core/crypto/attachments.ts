/**
 * Chunked attachment encryption (attachment format v2).
 *
 * Large files (videos, documents) must not be loaded into JS memory in one
 * piece, so attachments are encrypted as a libsodium secretstream
 * (crypto_secretstream_xchacha20poly1305):
 *
 *   key     = random 32 bytes                      (travels in the E2EE payload)
 *   header  = secretstream header, 24 bytes        (travels in the E2EE payload as `nonce`)
 *   file    = chunk_0 || chunk_1 || ... || chunk_n (what is uploaded)
 *   chunk_i = push(plain[i*CS .. (i+1)*CS], tag)   (CS + 17 bytes, the last one may be shorter)
 *
 * Every plaintext chunk except the last is exactly `chunkSize` bytes; the last
 * one carries TAG_FINAL (an empty file is a single, empty, final chunk).
 * secretstream derives a fresh nonce per chunk from an internal counter, so:
 *   - reordering or duplicating chunks fails authentication,
 *   - truncation is detected (no chunk with TAG_FINAL),
 *   - appending data after the final chunk is rejected,
 *   - flipping any bit fails authentication.
 * The BLAKE2b-256 of the whole ciphertext is also carried in the payload so the
 * server can check the upload and the recipient can detect a swapped object.
 *
 * Format v1 (single-shot XChaCha20-Poly1305 over the whole file, see
 * primitives.encryptBlob/decryptBlob) is still decrypted for old messages.
 *
 * Pure: no storage or network. The device code drives these classes with
 * expo-file-system FileHandles; tests drive them with in-memory arrays.
 */

import { DecryptionError, type Sodium } from './primitives';

export const ATTACHMENT_FORMAT_V2 = 2 as const;
/** 64 KiB: small enough for the asm.js heap on Hermes, large enough to keep JSI calls cheap. */
export const DEFAULT_CHUNK_SIZE = 64 * 1024;
export const MIN_CHUNK_SIZE = 1024;
export const MAX_CHUNK_SIZE = 4 * 1024 * 1024;
/** crypto_secretstream_xchacha20poly1305_ABYTES (tag byte + 16-byte MAC). */
export const STREAM_ABYTES = 17;
const HASH_BYTES = 32;

export function isValidChunkSize(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_CHUNK_SIZE && n <= MAX_CHUNK_SIZE;
}

/** Number of chunks a plaintext of `plainSize` bytes is split into (always >= 1). */
export function chunkCount(plainSize: number, chunkSize = DEFAULT_CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(plainSize / chunkSize));
}

/** Exact ciphertext size for a v2 attachment. */
export function encryptedSizeFor(plainSize: number, chunkSize = DEFAULT_CHUNK_SIZE): number {
  return plainSize + chunkCount(plainSize, chunkSize) * STREAM_ABYTES;
}

export interface StreamEncryptionResult {
  /** base64 (URL-safe, unpadded) 32-byte key */
  key: string;
  /** base64 secretstream header (stored in the payload's `nonce` field) */
  header: string;
  /** hex BLAKE2b-256 of the complete ciphertext */
  hash: string;
  /** total ciphertext bytes produced */
  encryptedSize: number;
  plainSize: number;
}

/**
 * Incremental encryptor. Call `push(chunk, isLast)` with chunks of exactly
 * `chunkSize` bytes (the last one may be shorter) and write each returned
 * ciphertext chunk out in order; then call `finish()`.
 */
export class AttachmentEncryptor {
  readonly chunkSize: number;
  private readonly sodium: Sodium;
  private readonly key: Uint8Array;
  private readonly header: Uint8Array;
  private readonly state: ReturnType<Sodium['crypto_secretstream_xchacha20poly1305_init_push']>['state'];
  private readonly hashState: ReturnType<Sodium['crypto_generichash_init']>;
  private finished = false;
  private encryptedSize = 0;
  private plainSize = 0;

  constructor(sodium: Sodium, chunkSize = DEFAULT_CHUNK_SIZE) {
    if (!isValidChunkSize(chunkSize)) throw new Error('Invalid chunk size');
    this.sodium = sodium;
    this.chunkSize = chunkSize;
    this.key = sodium.crypto_secretstream_xchacha20poly1305_keygen();
    const init = sodium.crypto_secretstream_xchacha20poly1305_init_push(this.key);
    this.state = init.state;
    this.header = init.header;
    this.hashState = sodium.crypto_generichash_init(null, HASH_BYTES);
  }

  push(plain: Uint8Array, isLast: boolean): Uint8Array {
    if (this.finished) throw new Error('Stream already finished');
    if (plain.length > this.chunkSize) throw new Error('Chunk larger than chunk size');
    if (!isLast && plain.length !== this.chunkSize) throw new Error('Only the last chunk may be short');
    const s = this.sodium;
    const tag = isLast
      ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    const out = s.crypto_secretstream_xchacha20poly1305_push(this.state, plain, null, tag);
    s.crypto_generichash_update(this.hashState, out);
    this.encryptedSize += out.length;
    this.plainSize += plain.length;
    if (isLast) this.finished = true;
    return out;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  finish(): StreamEncryptionResult {
    if (!this.finished) throw new Error('Last chunk was never pushed');
    const s = this.sodium;
    const result: StreamEncryptionResult = {
      key: s.to_base64(this.key),
      header: s.to_base64(this.header),
      hash: s.to_hex(s.crypto_generichash_final(this.hashState, HASH_BYTES)),
      encryptedSize: this.encryptedSize,
      plainSize: this.plainSize,
    };
    s.memzero(this.key);
    return result;
  }
}

/**
 * Incremental decryptor. Feed it ciphertext chunks of `cipherChunkSize` bytes
 * (the last may be shorter) in order; each `pull` returns the plaintext. Call
 * `finish()` at the end: it throws if the stream was truncated or the hash
 * does not match. Never treat output as valid before `finish()` succeeds.
 */
export class AttachmentDecryptor {
  readonly chunkSize: number;
  readonly cipherChunkSize: number;
  private readonly sodium: Sodium;
  private readonly state: ReturnType<Sodium['crypto_secretstream_xchacha20poly1305_init_pull']>;
  private readonly hashState: ReturnType<Sodium['crypto_generichash_init']>;
  private readonly expectedHash?: string;
  private sawFinal = false;
  private failed = false;

  constructor(sodium: Sodium, key: string, header: string, chunkSize: number, expectedHash?: string) {
    if (!isValidChunkSize(chunkSize)) throw new DecryptionError('Unsupported attachment chunk size');
    this.sodium = sodium;
    this.chunkSize = chunkSize;
    this.cipherChunkSize = chunkSize + STREAM_ABYTES;
    this.expectedHash = expectedHash?.toLowerCase();
    let keyBytes: Uint8Array;
    let headerBytes: Uint8Array;
    try {
      keyBytes = sodium.from_base64(key);
      headerBytes = sodium.from_base64(header);
    } catch {
      throw new DecryptionError('Malformed attachment key');
    }
    if (
      keyBytes.length !== sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES ||
      headerBytes.length !== sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES
    ) {
      throw new DecryptionError('Malformed attachment key');
    }
    this.state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(headerBytes, keyBytes);
    this.hashState = sodium.crypto_generichash_init(null, HASH_BYTES);
    sodium.memzero(keyBytes);
  }

  pull(cipher: Uint8Array): Uint8Array {
    if (this.failed) throw new DecryptionError('Media decryption failed');
    if (this.sawFinal) return this.fail('Unexpected data after the end of the attachment');
    if (cipher.length < STREAM_ABYTES || cipher.length > this.cipherChunkSize) {
      return this.fail('Attachment chunk has an invalid size');
    }
    const s = this.sodium;
    s.crypto_generichash_update(this.hashState, cipher);
    let res: { message: Uint8Array; tag: number } | false;
    try {
      res = s.crypto_secretstream_xchacha20poly1305_pull(this.state, cipher, null);
    } catch {
      res = false;
    }
    if (!res) return this.fail('Media decryption failed (tampered, reordered or corrupt)');
    if (res.tag === s.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
      this.sawFinal = true;
    } else if (res.tag !== s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE) {
      return this.fail('Unsupported attachment chunk tag');
    } else if (cipher.length !== this.cipherChunkSize) {
      // A short chunk must be the last one.
      return this.fail('Attachment was truncated');
    }
    return res.message;
  }

  finish(): void {
    if (this.failed) throw new DecryptionError('Media decryption failed');
    if (!this.sawFinal) this.fail('Attachment was truncated');
    const hash = this.sodium.to_hex(this.sodium.crypto_generichash_final(this.hashState, HASH_BYTES));
    if (this.expectedHash && hash !== this.expectedHash) this.fail('Media integrity check failed');
  }

  private fail(message: string): never {
    this.failed = true;
    throw new DecryptionError(message);
  }
}

// ── In-memory helpers (web, tests, small files) ─────────────────────────────

export function encryptAttachment(
  sodium: Sodium,
  plain: Uint8Array,
  chunkSize = DEFAULT_CHUNK_SIZE
): StreamEncryptionResult & { ciphertext: Uint8Array } {
  const enc = new AttachmentEncryptor(sodium, chunkSize);
  const ciphertext = new Uint8Array(encryptedSizeFor(plain.length, chunkSize));
  let offset = 0;
  let out = 0;
  do {
    const end = Math.min(offset + chunkSize, plain.length);
    const c = enc.push(plain.subarray(offset, end), end >= plain.length);
    ciphertext.set(c, out);
    out += c.length;
    offset = end;
  } while (!enc.isFinished);
  return { ...enc.finish(), ciphertext };
}

export function decryptAttachment(
  sodium: Sodium,
  ciphertext: Uint8Array,
  key: string,
  header: string,
  chunkSize: number,
  expectedHash?: string
): Uint8Array {
  const dec = new AttachmentDecryptor(sodium, key, header, chunkSize, expectedHash);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let offset = 0; offset < ciphertext.length; offset += dec.cipherChunkSize) {
    const part = dec.pull(ciphertext.subarray(offset, offset + dec.cipherChunkSize));
    parts.push(part);
    total += part.length;
  }
  dec.finish();
  const plain = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    plain.set(p, o);
    o += p.length;
  }
  return plain;
}
