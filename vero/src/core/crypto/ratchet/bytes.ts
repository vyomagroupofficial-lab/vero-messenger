/**
 * Byte helpers shared by the ratchet modules. All keys travel as URL-safe,
 * unpadded base64 (libsodium's default variant), like the rest of Vero.
 */

import type { Sodium } from '../primitives';
import { DecryptionError } from '../primitives';

export const KEY_LEN = 32;

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError('u32 out of range');
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

export function readU32(b: Uint8Array, offset: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(offset, false);
}

/** Length-prefixed encoding so concatenated fields stay unambiguous. */
export function lp(b: Uint8Array): Uint8Array {
  return concat(u32(b.length), b);
}

/** Decodes base64 and (optionally) enforces the length. Malformed input is a decryption failure. */
export function unb64(sodium: Sodium, s: unknown, expectedLength?: number): Uint8Array {
  if (typeof s !== 'string') throw new DecryptionError('Malformed key material');
  let out: Uint8Array;
  try {
    out = sodium.from_base64(s);
  } catch {
    throw new DecryptionError('Malformed key material');
  }
  if (expectedLength !== undefined && out.length !== expectedLength) {
    throw new DecryptionError('Key material has the wrong length');
  }
  return out;
}

export function isB64Key(sodium: Sodium, s: unknown, length = KEY_LEN): s is string {
  if (typeof s !== 'string' || s.length > 128) return false;
  try {
    return sodium.from_base64(s).length === length;
  } catch {
    return false;
  }
}
