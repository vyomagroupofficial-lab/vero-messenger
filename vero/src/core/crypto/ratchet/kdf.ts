/**
 * HMAC-SHA-512 (RFC 2104) and HKDF-SHA-512 (RFC 5869).
 *
 * The standard libsodium.js build has no HMAC-SHA-256/512 helpers, but it does
 * ship SHA-512 (`crypto_hash`). These are the textbook constructions on top of
 * it, checked against Node's implementations in tests/ratchet.test.ts. The
 * Signal X3DH and Double Ratchet specifications both recommend HKDF/HMAC with
 * SHA-256 or SHA-512.
 */

import type { Sodium } from '../primitives';
import { concat } from './bytes';

const BLOCK = 128; // SHA-512 block size
export const HASH_LEN = 64; // SHA-512 output size

export function hmacSha512(sodium: Sodium, key: Uint8Array, data: Uint8Array): Uint8Array {
  const k = key.length > BLOCK ? sodium.crypto_hash(key) : key;
  const ipad = new Uint8Array(BLOCK);
  const opad = new Uint8Array(BLOCK);
  ipad.set(k);
  opad.set(k);
  for (let i = 0; i < BLOCK; i++) {
    ipad[i] ^= 0x36;
    opad[i] ^= 0x5c;
  }
  const inner = sodium.crypto_hash(concat(ipad, data));
  const out = sodium.crypto_hash(concat(opad, inner));
  sodium.memzero(ipad);
  sodium.memzero(opad);
  sodium.memzero(inner);
  return out;
}

export function hkdfSha512(
  sodium: Sodium,
  salt: Uint8Array | null,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number
): Uint8Array {
  if (length <= 0 || length > 255 * HASH_LEN) throw new RangeError('HKDF length out of range');
  // RFC 5869 §2.2: an absent salt is HashLen zero bytes.
  const prk = hmacSha512(sodium, salt && salt.length ? salt : new Uint8Array(HASH_LEN), ikm);
  const out = new Uint8Array(length);
  let prev: Uint8Array = new Uint8Array(0);
  let offset = 0;
  for (let i = 1; offset < length; i++) {
    prev = hmacSha512(sodium, prk, concat(prev, info, new Uint8Array([i])));
    const take = Math.min(prev.length, length - offset);
    out.set(prev.subarray(0, take), offset);
    offset += take;
  }
  sodium.memzero(prk);
  return out;
}
