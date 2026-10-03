/**
 * Encryption for device-to-device transfer (linked-device history and
 * "move chats to a new phone"). Pure functions of libsodium; unit-tested in
 * tests/transfer.test.ts.
 *
 * The RECEIVING device shows a QR code with
 *   - R_pk: a fresh ephemeral X25519 public key (its secret never leaves it)
 *   - S:    32 random bytes
 * The SENDING device scans it, creates its own ephemeral key pair (S_pk) and
 * derives
 *   key = BLAKE2b-256( key = S,
 *                      "vero-transfer/v1|<transferId>|" || R_pk || S_pk || X25519(s_sk, R_pk) )
 * so the key needs BOTH the receiver's ephemeral private key and the QR
 * secret: the server (which relays S_pk and the ciphertext but never sees S)
 * can neither read nor forge the transfer, and someone who merely saw the QR
 * can't decrypt it either.
 *
 * Each chunk is XChaCha20-Poly1305 with a random nonce and associated data
 *   "vero-transfer/v1|<transferId>|<index>|<total>"
 * so chunks can't be modified, reordered, moved to another transfer, dropped
 * or appended without decryption failing.
 *
 * For device LINKING the same QR secret also yields the claim key that the
 * new device presents to the server (deriveClaimKey); the server stores only
 * sha256(claimKey), and the claim key reveals nothing about S.
 */

import type { Sodium } from '../../core/crypto/primitives';
import { DecryptionError } from '../../core/crypto/primitives';
import { sha256Hex } from '../discovery/sha256';

const AD_PREFIX = 'vero-transfer/v1';
export const TRANSFER_CHUNK_BYTES = 192 * 1024;
export const MAX_TRANSFER_CHUNKS = 1024;

export interface EphemeralKeyPair {
  publicKey: string; // base64url, 43 chars
  secretKey: string; // base64url
}

export function generateEphemeralKeyPair(sodium: Sodium): EphemeralKeyPair {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: sodium.to_base64(kp.publicKey), secretKey: sodium.to_base64(kp.privateKey) };
}

/** 32 random bytes, base64url (the QR secret). */
export function generateQrSecret(sodium: Sodium): string {
  return sodium.to_base64(sodium.randombytes_buf(32));
}

/** Claim key for device linking: hex BLAKE2b-256 keyed with the QR secret. */
export function deriveClaimKey(sodium: Sodium, secret: string): string {
  return sodium.to_hex(sodium.crypto_generichash(32, sodium.from_string('vero-link/claim/v1'), sodium.from_base64(secret)));
}

/** What the server stores for a link request: sha256(claimKey) (matches PostgreSQL sha256()). */
export function claimKeyHash(claimKey: string): string {
  return sha256Hex(claimKey);
}

export function deriveTransferKey(
  sodium: Sodium,
  p: {
    transferId: string;
    secret: string;
    receiverPublicKey: string;
    senderPublicKey: string;
    /** my ephemeral secret key */
    mySecretKey: string;
    /** the other side's ephemeral public key */
    theirPublicKey: string;
  }
): Uint8Array {
  const mySk = sodium.from_base64(p.mySecretKey);
  let shared: Uint8Array;
  try {
    // libsodium rejects low-order points ("weak public key").
    shared = sodium.crypto_scalarmult(mySk, sodium.from_base64(p.theirPublicKey));
  } catch {
    throw new DecryptionError('Invalid transfer public key');
  } finally {
    sodium.memzero(mySk);
  }
  if (shared.every((b) => b === 0)) throw new DecryptionError('Invalid transfer public key');

  const label = sodium.from_string(`${AD_PREFIX}|${p.transferId.toLowerCase()}|`);
  const rpk = sodium.from_base64(p.receiverPublicKey);
  const spk = sodium.from_base64(p.senderPublicKey);
  const input = new Uint8Array(label.length + rpk.length + spk.length + shared.length);
  input.set(label, 0);
  input.set(rpk, label.length);
  input.set(spk, label.length + rpk.length);
  input.set(shared, label.length + rpk.length + spk.length);

  const key = sodium.crypto_generichash(32, input, sodium.from_base64(p.secret));
  sodium.memzero(shared);
  sodium.memzero(input);
  return key;
}

function chunkAd(transferId: string, index: number, total: number): string {
  return `${AD_PREFIX}|${transferId.toLowerCase()}|${index}|${total}`;
}

function checkPosition(index: number, total: number) {
  if (!Number.isInteger(total) || total < 1 || total > MAX_TRANSFER_CHUNKS) throw new Error('Invalid chunk count');
  if (!Number.isInteger(index) || index < 0 || index >= total) throw new Error('Invalid chunk index');
}

export function encryptChunk(
  sodium: Sodium,
  key: Uint8Array,
  transferId: string,
  index: number,
  total: number,
  plain: Uint8Array
): string {
  checkPosition(index, total);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, chunkAd(transferId, index, total), null, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return sodium.to_base64(out);
}

export function decryptChunk(
  sodium: Sodium,
  key: Uint8Array,
  transferId: string,
  index: number,
  total: number,
  encoded: string
): Uint8Array {
  checkPosition(index, total);
  try {
    const raw = sodium.from_base64(encoded);
    const n = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    if (raw.length <= n) throw new Error('short');
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      raw.subarray(n),
      chunkAd(transferId, index, total),
      raw.subarray(0, n),
      key
    );
  } catch {
    throw new DecryptionError('Transfer chunk failed authentication (tampered, reordered or wrong key)');
  }
}

/** Splits and encrypts a whole payload; returns the chunk ciphertexts in order. */
export function encryptPayload(
  sodium: Sodium,
  key: Uint8Array,
  transferId: string,
  payload: Uint8Array,
  chunkBytes = TRANSFER_CHUNK_BYTES
): string[] {
  const total = Math.max(1, Math.ceil(payload.length / chunkBytes));
  if (total > MAX_TRANSFER_CHUNKS) throw new Error('This chat history is too large to transfer in one go.');
  const out: string[] = [];
  for (let i = 0; i < total; i++) {
    out.push(encryptChunk(sodium, key, transferId, i, total, payload.subarray(i * chunkBytes, (i + 1) * chunkBytes)));
  }
  return out;
}

/** Decrypts chunks 0..n-1 (n = chunks.length) and concatenates them. */
export function decryptPayload(sodium: Sodium, key: Uint8Array, transferId: string, chunks: string[]): Uint8Array {
  const total = chunks.length;
  const parts = chunks.map((c, i) => decryptChunk(sodium, key, transferId, i, total, c));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
