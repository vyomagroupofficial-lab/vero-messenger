/**
 * Vero cryptographic primitives (platform independent).
 *
 * Everything here is a pure function of its inputs plus libsodium, so it can be
 * unit-tested under Node and reused on device. Key storage lives in
 * CryptoManager; this file never touches storage or the network.
 *
 * ── Message envelope (v2) ────────────────────────────────────────────────────
 * Every message is encrypted once and readable by every authorised device
 * (all recipients' devices AND the sender's own devices, so history survives
 * reinstalls on other devices and group chats work):
 *
 *   contentKey  = random 32 bytes
 *   ad          = "vero/v2|<conversationId>|<messageId>|<senderDeviceId>"
 *   body        = XChaCha20-Poly1305(plaintext, ad, nonce, contentKey)
 *   slot[dev]   = crypto_box(contentKey || BLAKE2b(ad), senderSK, devPK)
 *
 * crypto_box authenticates the sender device's static X25519 key, and the
 * BLAKE2b(ad) binding means a slot cannot be replayed into another message,
 * conversation or sender. The server only ever sees the envelope.
 *
 * Limitation (documented in README): static-key boxes provide no forward
 * secrecy. Moving to a Double Ratchet / MLS session layer is the next step.
 */

import type * as SodiumModule from 'libsodium-wrappers';

export type Sodium = typeof SodiumModule;

export const ENVELOPE_VERSION = 2 as const;
const AD_PREFIX = 'vero/v2';
const KEY_BYTES = 32;
const BINDING_BYTES = 32;

export interface DeviceKeyRef {
  deviceId: string;
  /** base64 (URL-safe, unpadded) X25519 public key */
  publicKey: string;
}

export interface EnvelopeContext {
  conversationId: string;
  messageId: string;
  senderDeviceId: string;
}

export interface EnvelopeV2 {
  v: typeof ENVELOPE_VERSION;
  /** base64 24-byte XChaCha20 nonce */
  n: string;
  /** base64 ciphertext of the payload */
  c: string;
  /** deviceId -> base64(boxNonce || box(contentKey || binding)) */
  k: Record<string, string>;
}

export class NotAddressedToDeviceError extends Error {
  constructor() {
    super('Message was not encrypted for this device');
    this.name = 'NotAddressedToDeviceError';
  }
}

export class DecryptionError extends Error {
  constructor(message = 'Decryption failed - message may have been tampered with') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export function associatedData(ctx: EnvelopeContext): string {
  return `${AD_PREFIX}|${ctx.conversationId}|${ctx.messageId}|${ctx.senderDeviceId}`;
}

export function generateIdentityKeyPair(sodium: Sodium): { publicKey: string; secretKey: string } {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: sodium.to_base64(kp.publicKey), secretKey: sodium.to_base64(kp.privateKey) };
}

export function encryptEnvelope(
  sodium: Sodium,
  plaintext: string,
  ctx: EnvelopeContext,
  senderSecretKey: string,
  recipients: DeviceKeyRef[]
): EnvelopeV2 {
  if (recipients.length === 0) throw new Error('No recipient devices to encrypt for');

  const sk = sodium.from_base64(senderSecretKey);
  const ad = associatedData(ctx);
  const contentKey = sodium.randombytes_buf(KEY_BYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);

  const body = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, ad, null, nonce, contentKey);

  const slotPlaintext = new Uint8Array(KEY_BYTES + BINDING_BYTES);
  slotPlaintext.set(contentKey, 0);
  slotPlaintext.set(sodium.crypto_generichash(BINDING_BYTES, ad, null), KEY_BYTES);

  const k: Record<string, string> = {};
  for (const r of recipients) {
    if (k[r.deviceId]) continue;
    const boxNonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
    const box = sodium.crypto_box_easy(slotPlaintext, boxNonce, sodium.from_base64(r.publicKey), sk);
    const slot = new Uint8Array(boxNonce.length + box.length);
    slot.set(boxNonce, 0);
    slot.set(box, boxNonce.length);
    k[r.deviceId] = sodium.to_base64(slot);
  }

  sodium.memzero(contentKey);
  sodium.memzero(slotPlaintext);
  sodium.memzero(sk);

  return { v: ENVELOPE_VERSION, n: sodium.to_base64(nonce), c: sodium.to_base64(body), k };
}

export function decryptEnvelope(
  sodium: Sodium,
  envelope: EnvelopeV2,
  ctx: EnvelopeContext,
  myDeviceId: string,
  mySecretKey: string,
  senderPublicKey: string
): string {
  const slotB64 = envelope.k[myDeviceId];
  if (!slotB64) throw new NotAddressedToDeviceError();

  const ad = associatedData(ctx);
  let slotPlaintext: Uint8Array;
  try {
    const slot = sodium.from_base64(slotB64);
    const boxNonce = slot.subarray(0, sodium.crypto_box_NONCEBYTES);
    const box = slot.subarray(sodium.crypto_box_NONCEBYTES);
    slotPlaintext = sodium.crypto_box_open_easy(
      box,
      boxNonce,
      sodium.from_base64(senderPublicKey),
      sodium.from_base64(mySecretKey)
    );
  } catch {
    throw new DecryptionError('Key slot could not be opened (wrong sender key or tampered)');
  }

  if (slotPlaintext.length !== KEY_BYTES + BINDING_BYTES) throw new DecryptionError();
  const contentKey = slotPlaintext.subarray(0, KEY_BYTES);
  const binding = slotPlaintext.subarray(KEY_BYTES);
  if (!sodium.memcmp(binding, sodium.crypto_generichash(BINDING_BYTES, ad, null))) {
    throw new DecryptionError('Key slot is bound to a different message');
  }

  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      sodium.from_base64(envelope.c),
      ad,
      sodium.from_base64(envelope.n),
      contentKey,
      'text'
    );
  } catch {
    throw new DecryptionError();
  } finally {
    sodium.memzero(slotPlaintext);
  }
}

export function serializeEnvelope(envelope: EnvelopeV2): string {
  return JSON.stringify(envelope);
}

export function parseEnvelope(raw: string): EnvelopeV2 {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DecryptionError('Malformed envelope');
  }
  if (
    !parsed ||
    parsed.v !== ENVELOPE_VERSION ||
    typeof parsed.n !== 'string' ||
    typeof parsed.c !== 'string' ||
    typeof parsed.k !== 'object' ||
    parsed.k === null
  ) {
    throw new DecryptionError('Unsupported envelope version');
  }
  return parsed as EnvelopeV2;
}

// ──────────────────────────────────────────────────────────────────────────────
// Media (attachments are encrypted with a fresh random key per file; the key
// travels inside the E2EE message payload, never to Drive or Supabase)
// ──────────────────────────────────────────────────────────────────────────────

export interface EncryptedBlob {
  ciphertext: Uint8Array;
  /** base64 32-byte key */
  key: string;
  /** base64 24-byte nonce */
  nonce: string;
  /** hex BLAKE2b-256 of the ciphertext (lets the recipient detect corruption early) */
  hash: string;
}

export function encryptBlob(sodium: Sodium, plain: Uint8Array): EncryptedBlob {
  const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, null, null, nonce, key);
  return {
    ciphertext,
    key: sodium.to_base64(key),
    nonce: sodium.to_base64(nonce),
    hash: blobHash(sodium, ciphertext),
  };
}

export function blobHash(sodium: Sodium, data: Uint8Array): string {
  return sodium.to_hex(sodium.crypto_generichash(32, data, null));
}

export function decryptBlob(
  sodium: Sodium,
  ciphertext: Uint8Array,
  key: string,
  nonce: string,
  expectedHash?: string
): Uint8Array {
  if (expectedHash) {
    if (blobHash(sodium, ciphertext) !== expectedHash.toLowerCase()) {
      throw new DecryptionError('Media integrity check failed');
    }
  }
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      null,
      sodium.from_base64(nonce),
      sodium.from_base64(key)
    );
  } catch {
    throw new DecryptionError('Media decryption failed');
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Safety numbers (modelled on Signal's NumericFingerprint, with BLAKE2b-512
// since the standard libsodium.js build ships no SHA-512)
// ──────────────────────────────────────────────────────────────────────────────

const FINGERPRINT_ITERATIONS = 5200;
const FINGERPRINT_VERSION = new Uint8Array([0, 1]);

/**
 * 30-digit fingerprint for one party, covering ALL of that user's active
 * device identity keys, so adding/replacing a device changes the number.
 */
export function partyFingerprint(sodium: Sodium, userId: string, devicePublicKeys: string[]): string {
  if (devicePublicKeys.length === 0) throw new Error('No identity keys to fingerprint');
  const keys = [...devicePublicKeys].sort().map((k) => sodium.from_base64(k));
  const keyBytes = concat(keys);
  let hash = sodium.crypto_generichash(64, concat([FINGERPRINT_VERSION, keyBytes, sodium.from_string(userId)]), null);
  for (let i = 0; i < FINGERPRINT_ITERATIONS; i++) {
    hash = sodium.crypto_generichash(64, concat([hash, keyBytes]), null);
  }
  let digits = '';
  for (let chunk = 0; chunk < 6; chunk++) {
    let value = 0;
    for (let b = 0; b < 5; b++) value = value * 256 + hash[chunk * 5 + b];
    digits += String(value % 100000).padStart(5, '0');
  }
  return digits;
}

/** 60-digit safety number; identical on both sides regardless of who computes it. */
export function safetyNumber(
  sodium: Sodium,
  a: { userId: string; keys: string[] },
  b: { userId: string; keys: string[] }
): string {
  const fa = partyFingerprint(sodium, a.userId, a.keys);
  const fb = partyFingerprint(sodium, b.userId, b.keys);
  const combined = fa < fb ? fa + fb : fb + fa;
  return combined.match(/.{5}/g)!.join(' ');
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
