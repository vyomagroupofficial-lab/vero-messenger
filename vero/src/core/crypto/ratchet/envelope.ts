/**
 * Message envelope v3 (forward-secret fan-out).
 *
 *   contentKey = random 32 bytes
 *   ad         = "vero/v3|<conversationId>|<messageId>|<senderDeviceId>"
 *   body       = XChaCha20-Poly1305(plaintext, ad, nonce, contentKey)
 *   slot[dev]  = DoubleRatchetEncrypt(session(dev), contentKey, AD = X3DH_AD || BLAKE2b-256(ad))
 *
 * The payload is encrypted ONCE; only the 32-byte content key goes through
 * the per-device ratchet. Because BLAKE2b(ad) is part of every slot's AEAD
 * associated data, a slot can't be moved to another message, conversation or
 * sender device. The sending device itself gets no slot (it keeps the
 * plaintext locally); the sender's OTHER devices are ordinary recipients.
 *
 * Wire format (JSON, same outer shape as v2 so per-device slot splitting -
 * e.g. for stories - works unchanged):
 *   { v: 3, n: b64 nonce, c: b64 body, k: { deviceId: "<b64 slot>" } }
 *   slot = flag | [X3DH header: IK_A, EK_A, signed prekey id, one-time prekey id?]
 *          | ratchet header (DH pub, PN, N) | ratchet ciphertext   (see serializeSlot)
 */

import type { EnvelopeContext, EnvelopeV2, Sodium } from '../primitives';
import { DecryptionError, ENVELOPE_VERSION } from '../primitives';
import { concat, KEY_LEN, readU32, u32 } from './bytes';
import { HEADER_LEN } from './doubleRatchet';
import type { RatchetSlot } from './session';
import type { PreKeyHeader } from './x3dh';

export const ENVELOPE_V3 = 3 as const;
const AD_PREFIX_V3 = 'vero/v3';

export interface EnvelopeV3 {
  v: typeof ENVELOPE_V3;
  n: string;
  c: string;
  /** deviceId -> serialized RatchetSlot */
  k: Record<string, string>;
}

export type AnyEnvelope = EnvelopeV2 | EnvelopeV3;

export function associatedDataV3(ctx: EnvelopeContext): string {
  return `${AD_PREFIX_V3}|${ctx.conversationId}|${ctx.messageId}|${ctx.senderDeviceId}`;
}

/** Bytes mixed into every slot's ratchet AEAD associated data. */
export function slotBinding(sodium: Sodium, ctx: EnvelopeContext): Uint8Array {
  return sodium.crypto_generichash(32, associatedDataV3(ctx), null);
}

export function encryptBody(
  sodium: Sodium,
  plaintext: string,
  ctx: EnvelopeContext
): { n: string; c: string; contentKey: Uint8Array } {
  const contentKey = sodium.randombytes_buf(KEY_LEN);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const body = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    associatedDataV3(ctx),
    null,
    nonce,
    contentKey
  );
  return { n: sodium.to_base64(nonce), c: sodium.to_base64(body), contentKey };
}

export function decryptBody(sodium: Sodium, env: EnvelopeV3, ctx: EnvelopeContext, contentKey: Uint8Array): string {
  if (contentKey.length !== KEY_LEN) throw new DecryptionError('Malformed content key');
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      sodium.from_base64(env.c),
      associatedDataV3(ctx),
      sodium.from_base64(env.n),
      contentKey,
      'text'
    );
  } catch {
    throw new DecryptionError();
  }
}

const SLOT_PLAIN = 1;
const SLOT_PREKEY = 2;
const SLOT_PREKEY_OPK = 3;

/**
 * Compact binary slot, base64:
 *   flag(1) [ ik(32) ek(32) u32 spkId [u32 opkId] ] header(40) ciphertext
 * flag 1 = no X3DH header, 2 = X3DH header without, 3 = with one-time prekey.
 */
export function serializeSlot(sodium: Sodium, slot: RatchetSlot): string {
  const header = sodium.from_base64(slot.h);
  const ct = sodium.from_base64(slot.c);
  const parts: Uint8Array[] = [];
  if (!slot.p) parts.push(new Uint8Array([SLOT_PLAIN]));
  else {
    parts.push(new Uint8Array([slot.p.o === undefined ? SLOT_PREKEY : SLOT_PREKEY_OPK]));
    parts.push(sodium.from_base64(slot.p.ik), sodium.from_base64(slot.p.ek), u32(slot.p.s));
    if (slot.p.o !== undefined) parts.push(u32(slot.p.o));
  }
  parts.push(header, ct);
  return sodium.to_base64(concat(...parts));
}

/** Defensive parse: every byte of a slot is attacker-controlled. */
export function parseSlot(sodium: Sodium, raw: unknown): RatchetSlot {
  if (typeof raw !== 'string' || raw.length > 4096) throw new DecryptionError('Malformed key slot');
  let b: Uint8Array;
  try {
    b = sodium.from_base64(raw);
  } catch {
    throw new DecryptionError('Malformed key slot');
  }
  const flag = b[0];
  let offset = 1;
  let p: PreKeyHeader | undefined;
  if (flag === SLOT_PREKEY || flag === SLOT_PREKEY_OPK) {
    const need = 1 + 64 + 4 + (flag === SLOT_PREKEY_OPK ? 4 : 0);
    if (b.length < need) throw new DecryptionError('Malformed key slot');
    p = {
      ik: sodium.to_base64(b.subarray(1, 33)),
      ek: sodium.to_base64(b.subarray(33, 65)),
      s: readU32(b, 65),
    };
    offset = 69;
    if (flag === SLOT_PREKEY_OPK) {
      p.o = readU32(b, 69);
      offset = 73;
    }
    if (p.s > 0x7fffffff || (p.o !== undefined && p.o > 0x7fffffff)) throw new DecryptionError('Malformed X3DH header');
  } else if (flag !== SLOT_PLAIN) {
    throw new DecryptionError('Malformed key slot');
  }
  // header (40) + at least the AEAD tag (16)
  if (b.length < offset + HEADER_LEN + 16) throw new DecryptionError('Malformed key slot');
  const slot: RatchetSlot = {
    h: sodium.to_base64(b.subarray(offset, offset + HEADER_LEN)),
    c: sodium.to_base64(b.subarray(offset + HEADER_LEN)),
  };
  if (p) slot.p = p;
  return slot;
}

export function serializeEnvelopeV3(env: EnvelopeV3): string {
  return JSON.stringify(env);
}

/** Parses a v2 or v3 envelope (anything else is rejected). */
export function parseAnyEnvelope(raw: string): AnyEnvelope {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DecryptionError('Malformed envelope');
  }
  if (
    !parsed ||
    (parsed.v !== ENVELOPE_VERSION && parsed.v !== ENVELOPE_V3) ||
    typeof parsed.n !== 'string' ||
    typeof parsed.c !== 'string' ||
    typeof parsed.k !== 'object' ||
    parsed.k === null ||
    Array.isArray(parsed.k)
  ) {
    throw new DecryptionError('Unsupported envelope version');
  }
  return parsed as AnyEnvelope;
}

export function isEnvelopeV3(env: AnyEnvelope): env is EnvelopeV3 {
  return env.v === ENVELOPE_V3;
}
