/**
 * Device signing key, identity binding, signed prekeys and one-time prekeys.
 *
 * Vero devices already have an X25519 identity key (IK) used for the v2
 * envelope. X3DH needs the identity key to sign the signed prekey; the Signal
 * spec does that with XEdDSA on the X25519 key. libsodium has no XEdDSA, so a
 * device instead has a separate Ed25519 signing key and BINDS the two:
 *
 *   identity_signature = Ed25519.sign("VeroIdentityBinding_v1" || IK, signingKey)
 *   spk_signature      = Ed25519.sign("VeroSignedPreKey_v1" || u32(spkId) || SPK, signingKey)
 *
 * A client accepts a bundle only if both signatures verify under the device's
 * signing key, and the IK equals the identity key pinned for that device.
 */

import type { Sodium } from '../primitives';
import { concat, isB64Key, u32, unb64 } from './bytes';
import { InvalidBundleError } from './errors';

export const IDENTITY_BINDING_CONTEXT = 'VeroIdentityBinding_v1';
export const SIGNED_PREKEY_CONTEXT = 'VeroSignedPreKey_v1';
const SIGNATURE_LEN = 64;

/** base64 key pair (X25519 or Ed25519). `priv` never leaves the device. */
export interface KeyPairB64 {
  pub: string;
  priv: string;
}

export interface SignedPreKeyRecord extends KeyPairB64 {
  id: number;
  signature: string;
  createdAt: number;
}

export interface OneTimePreKeyRecord extends KeyPairB64 {
  id: number;
  createdAt: number;
}

/** What the server hands out (claim_prekey_bundle) for one device. */
export interface PreKeyBundle {
  deviceId: string;
  userId?: string;
  identityKey: string;
  signingKey: string;
  identitySignature: string;
  signedPreKeyId: number;
  signedPreKey: string;
  signedPreKeySignature: string;
  oneTimePreKeyId?: number | null;
  oneTimePreKey?: string | null;
}

export function generateX25519KeyPair(sodium: Sodium): KeyPairB64 {
  const kp = sodium.crypto_box_keypair();
  return { pub: sodium.to_base64(kp.publicKey), priv: sodium.to_base64(kp.privateKey) };
}

export function generateSigningKeyPair(sodium: Sodium): KeyPairB64 {
  const kp = sodium.crypto_sign_keypair();
  return { pub: sodium.to_base64(kp.publicKey), priv: sodium.to_base64(kp.privateKey) };
}

function identityBindingMessage(sodium: Sodium, identityKey: string): Uint8Array {
  return concat(sodium.from_string(IDENTITY_BINDING_CONTEXT), unb64(sodium, identityKey, 32));
}

function signedPreKeyMessage(sodium: Sodium, id: number, pub: string): Uint8Array {
  return concat(sodium.from_string(SIGNED_PREKEY_CONTEXT), u32(id), unb64(sodium, pub, 32));
}

export function signIdentityKey(sodium: Sodium, identityKey: string, signingPriv: string): string {
  return sodium.to_base64(
    sodium.crypto_sign_detached(identityBindingMessage(sodium, identityKey), sodium.from_base64(signingPriv))
  );
}

function verifyDetached(sodium: Sodium, sig: unknown, message: Uint8Array, signingKey: unknown): boolean {
  if (!isB64Key(sodium, signingKey) || !isB64Key(sodium, sig, SIGNATURE_LEN)) return false;
  try {
    return sodium.crypto_sign_verify_detached(sodium.from_base64(sig), message, sodium.from_base64(signingKey));
  } catch {
    return false;
  }
}

export function verifyIdentityBinding(
  sodium: Sodium,
  identityKey: string,
  signingKey: string,
  signature: string
): boolean {
  if (!isB64Key(sodium, identityKey)) return false;
  return verifyDetached(sodium, signature, identityBindingMessage(sodium, identityKey), signingKey);
}

export function generateSignedPreKey(
  sodium: Sodium,
  id: number,
  signingPriv: string,
  now = Date.now()
): SignedPreKeyRecord {
  const kp = generateX25519KeyPair(sodium);
  const signature = sodium.to_base64(
    sodium.crypto_sign_detached(signedPreKeyMessage(sodium, id, kp.pub), sodium.from_base64(signingPriv))
  );
  return { id, ...kp, signature, createdAt: now };
}

export function verifySignedPreKey(sodium: Sodium, signingKey: string, id: number, pub: string, signature: string): boolean {
  if (!Number.isInteger(id) || id < 0 || id > 0x7fffffff || !isB64Key(sodium, pub)) return false;
  return verifyDetached(sodium, signature, signedPreKeyMessage(sodium, id, pub), signingKey);
}

export function generateOneTimePreKeys(sodium: Sodium, startId: number, count: number, now = Date.now()): OneTimePreKeyRecord[] {
  const out: OneTimePreKeyRecord[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ id: (startId + i) % 0x7fffffff, ...generateX25519KeyPair(sodium), createdAt: now });
  }
  return out;
}

/**
 * Full bundle check: identity key matches what we pinned, the signing key is
 * bound to it, and the signed prekey is signed by it. Throws InvalidBundleError.
 */
export function verifyBundle(
  sodium: Sodium,
  bundle: PreKeyBundle,
  expected: { identityKey: string; signingKey?: string | null }
): void {
  if (bundle.identityKey !== expected.identityKey) throw new InvalidBundleError('identity key does not match pinned key');
  if (expected.signingKey && bundle.signingKey !== expected.signingKey) {
    throw new InvalidBundleError('signing key does not match pinned key');
  }
  if (!verifyIdentityBinding(sodium, bundle.identityKey, bundle.signingKey, bundle.identitySignature)) {
    throw new InvalidBundleError('identity binding signature is invalid');
  }
  if (
    !verifySignedPreKey(sodium, bundle.signingKey, bundle.signedPreKeyId, bundle.signedPreKey, bundle.signedPreKeySignature)
  ) {
    throw new InvalidBundleError('signed prekey signature is invalid');
  }
  if (bundle.oneTimePreKey != null) {
    if (!isB64Key(sodium, bundle.oneTimePreKey) || !Number.isInteger(bundle.oneTimePreKeyId)) {
      throw new InvalidBundleError('malformed one-time prekey');
    }
  }
}
