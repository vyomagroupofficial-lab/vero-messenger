/**
 * X3DH key agreement (https://signal.org/docs/specifications/x3dh/).
 *
 * Parameters (spec §2.1):
 *   curve  X25519
 *   hash   SHA-512
 *   info   "VeroX3DH_v1"
 *
 *   DH1 = DH(IK_A, SPK_B)   DH2 = DH(EK_A, IK_B)   DH3 = DH(EK_A, SPK_B)   [DH4 = DH(EK_A, OPK_B)]
 *   SK  = HKDF(salt = 64 zero bytes, IKM = F || DH1 || DH2 || DH3 [|| DH4], info, 32)   F = 32 x 0xFF
 *   AD  = Encode(IK_A) || Encode(IK_B) || lp(deviceId_A) || lp(deviceId_B)
 *
 * The signed prekey signature is checked with the device's Ed25519 signing key
 * (see keys.ts) instead of XEdDSA. Alice deletes EK_A's private key and the DH
 * outputs right after computing SK.
 */

import type { Sodium } from '../primitives';
import { concat, lp, unb64 } from './bytes';
import { InvalidBundleError } from './errors';
import { hkdfSha512, HASH_LEN } from './kdf';
import { KeyPairB64, PreKeyBundle, verifyBundle } from './keys';

export const X3DH_INFO = 'VeroX3DH_v1';

/** Sent by the initiator with every message until the responder replies. */
export interface PreKeyHeader {
  /** initiator identity key IK_A */
  ik: string;
  /** initiator ephemeral key EK_A (also identifies the session: "base key") */
  ek: string;
  /** signed prekey id used */
  s: number;
  /** one-time prekey id used, if any */
  o?: number;
}

export interface X3DHResult {
  sk: Uint8Array;
  ad: Uint8Array;
}

function dh(sodium: Sodium, priv: Uint8Array, pub: Uint8Array): Uint8Array {
  // libsodium refuses low-order points (all-zero output) by throwing.
  return sodium.crypto_scalarmult(priv, pub);
}

function deriveSk(sodium: Sodium, dhs: Uint8Array[]): Uint8Array {
  const f = new Uint8Array(32).fill(0xff);
  const ikm = concat(f, ...dhs);
  const sk = hkdfSha512(sodium, new Uint8Array(HASH_LEN), ikm, sodium.from_string(X3DH_INFO), 32);
  sodium.memzero(ikm);
  for (const d of dhs) sodium.memzero(d);
  return sk;
}

export function x3dhAssociatedData(
  sodium: Sodium,
  initiatorIdentity: string,
  responderIdentity: string,
  initiatorDeviceId: string,
  responderDeviceId: string
): Uint8Array {
  return concat(
    unb64(sodium, initiatorIdentity, 32),
    unb64(sodium, responderIdentity, 32),
    lp(sodium.from_string(initiatorDeviceId)),
    lp(sodium.from_string(responderDeviceId))
  );
}

/** Alice: verify Bob's bundle, then derive SK. Returns the header to attach to her first messages. */
export function x3dhInitiate(
  sodium: Sodium,
  local: { identity: KeyPairB64; deviceId: string },
  bundle: PreKeyBundle,
  pinned: { identityKey: string; signingKey?: string | null }
): X3DHResult & { header: PreKeyHeader } {
  verifyBundle(sodium, bundle, pinned);
  const ek = sodium.crypto_box_keypair();
  const ikA = unb64(sodium, local.identity.priv, 32);
  const ikB = unb64(sodium, bundle.identityKey, 32);
  const spkB = unb64(sodium, bundle.signedPreKey, 32);
  let dhs: Uint8Array[];
  try {
    dhs = [dh(sodium, ikA, spkB), dh(sodium, ek.privateKey, ikB), dh(sodium, ek.privateKey, spkB)];
    if (bundle.oneTimePreKey != null) {
      dhs.push(dh(sodium, ek.privateKey, unb64(sodium, bundle.oneTimePreKey, 32)));
    }
  } catch {
    throw new InvalidBundleError('bundle contains an invalid public key');
  } finally {
    sodium.memzero(ikA);
  }
  const sk = deriveSk(sodium, dhs);
  sodium.memzero(ek.privateKey);

  const header: PreKeyHeader = { ik: local.identity.pub, ek: sodium.to_base64(ek.publicKey), s: bundle.signedPreKeyId };
  if (bundle.oneTimePreKey != null && bundle.oneTimePreKeyId != null) header.o = bundle.oneTimePreKeyId;
  return {
    sk,
    ad: x3dhAssociatedData(sodium, local.identity.pub, bundle.identityKey, local.deviceId, bundle.deviceId),
    header,
  };
}

/** Bob: recompute SK from Alice's header and his prekey private keys. */
export function x3dhRespond(
  sodium: Sodium,
  local: { identity: KeyPairB64; deviceId: string },
  remoteDeviceId: string,
  header: PreKeyHeader,
  signedPreKey: KeyPairB64,
  oneTimePreKey: KeyPairB64 | null
): X3DHResult {
  const ikA = unb64(sodium, header.ik, 32);
  const ekA = unb64(sodium, header.ek, 32);
  const ikB = unb64(sodium, local.identity.priv, 32);
  const spkB = unb64(sodium, signedPreKey.priv, 32);
  const dhs = [dh(sodium, spkB, ikA), dh(sodium, ikB, ekA), dh(sodium, spkB, ekA)];
  if (oneTimePreKey) {
    const opk = unb64(sodium, oneTimePreKey.priv, 32);
    dhs.push(dh(sodium, opk, ekA));
    sodium.memzero(opk);
  }
  sodium.memzero(ikB);
  sodium.memzero(spkB);
  return {
    sk: deriveSk(sodium, dhs),
    ad: x3dhAssociatedData(sodium, header.ik, local.identity.pub, remoteDeviceId, local.deviceId),
  };
}
