/**
 * Encryption at rest for the local session store.
 *
 * Session state and prekey private keys are too large for the platform
 * keystore (SecureStore values should stay small), so they live in the
 * per-account SQLite database, each row sealed with a 32-byte storage key
 * that IS kept in the keystore:
 *
 *   row = base64( nonce(24) || XChaCha20-Poly1305(json, AD = "vero-store/v1|<ns>|<key>", nonce, storageKey) )
 *
 * Binding the namespace and row key into the AD stops rows from being
 * swapped (e.g. one device's session presented as another's). Deleting the
 * storage key from the keystore crypto-shreds the whole store.
 */

import type { Sodium } from '../primitives';
import { DecryptionError } from '../primitives';

const AD_PREFIX = 'vero-store/v1';

function rowAd(ns: string, key: string): string {
  return `${AD_PREFIX}|${ns}|${key}`;
}

export function sealRow(sodium: Sodium, storageKey: Uint8Array, ns: string, key: string, value: unknown): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(JSON.stringify(value), rowAd(ns, key), null, nonce, storageKey);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return sodium.to_base64(out);
}

export function openRow<T>(sodium: Sodium, storageKey: Uint8Array, ns: string, key: string, sealed: string): T {
  try {
    const raw = sodium.from_base64(sealed);
    const n = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    const json = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      raw.subarray(n),
      rowAd(ns, key),
      raw.subarray(0, n),
      storageKey,
      'text'
    );
    return JSON.parse(json) as T;
  } catch {
    throw new DecryptionError('Local session store row could not be opened');
  }
}
