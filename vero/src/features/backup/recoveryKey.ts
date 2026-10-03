/**
 * Backup recovery key: 64 Crockford base32 characters shown as 16 groups of
 * four (XXXX-XXXX-…). The first 60 characters are 300 random bits; the last
 * 4 are a 20-bit BLAKE2b checksum of those 60, so a mistyped key is reported
 * as a typo instead of "wrong key" (and a typo slips through only with
 * probability ~1e-6).
 *
 * Input is forgiving: case, spaces and dashes are ignored, and the usual
 * look-alikes are mapped (O -> 0, I/L -> 1). Pure; unit-tested.
 */

import type { Sodium } from '../../core/crypto/primitives';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_DATA_CHARS = 60;
export const RECOVERY_CHECK_CHARS = 4;
export const RECOVERY_KEY_CHARS = RECOVERY_DATA_CHARS + RECOVERY_CHECK_CHARS;
const CHECK_CONTEXT = 'vero-recovery-key/v1|';

export class RecoveryKeyError extends Error {
  constructor(
    message: string,
    readonly reason: 'length' | 'characters' | 'checksum'
  ) {
    super(message);
    this.name = 'RecoveryKeyError';
  }
}

type HashSodium = Pick<Sodium, 'crypto_generichash' | 'from_string'>;

/** Packs bytes into base32 symbols (5 bits each), most significant bits first. */
function toBase32(bytes: Uint8Array, chars: number): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= chars) break;
  }
  if (out.length < chars) throw new Error('not enough bytes');
  return out;
}

function checksum(sodium: HashSodium, data: string): string {
  const digest = sodium.crypto_generichash(32, sodium.from_string(CHECK_CONTEXT + data), null);
  return toBase32(digest, RECOVERY_CHECK_CHARS);
}

export function formatRecoveryKey(compact: string): string {
  return compact.match(/.{1,4}/g)!.join('-');
}

/** A new random recovery key, formatted for display. */
export function generateRecoveryKey(sodium: HashSodium & Pick<Sodium, 'randombytes_buf' | 'memzero'>): string {
  const random = sodium.randombytes_buf(38); // 304 bits; 300 are used
  try {
    const data = toBase32(random, RECOVERY_DATA_CHARS);
    return formatRecoveryKey(data + checksum(sodium, data));
  } finally {
    sodium.memzero(random);
  }
}

/** Uppercases, strips separators and maps look-alike characters. */
export function normalizeRecoveryKeyInput(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/**
 * Validates a typed recovery key and returns its 60 data characters - the
 * secret that unlocks the backup. Throws RecoveryKeyError with a reason.
 */
export function parseRecoveryKey(sodium: HashSodium, input: string): string {
  const compact = normalizeRecoveryKeyInput(input);
  if ([...compact].some((c) => !ALPHABET.includes(c))) {
    throw new RecoveryKeyError('The recovery key contains characters that are not part of a key.', 'characters');
  }
  if (compact.length !== RECOVERY_KEY_CHARS) {
    throw new RecoveryKeyError(
      `A recovery key has ${RECOVERY_KEY_CHARS} characters; you entered ${compact.length}.`,
      'length'
    );
  }
  const data = compact.slice(0, RECOVERY_DATA_CHARS);
  if (checksum(sodium, data) !== compact.slice(RECOVERY_DATA_CHARS)) {
    throw new RecoveryKeyError('This recovery key has a typo. Check each group of four characters.', 'checksum');
  }
  return data;
}
