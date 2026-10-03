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
 *   { v: 3, n: b64 nonce, c: b64 body, k: { deviceId: "<slot json>" } }
 *   slot json = { h: b64 ratchet header, c: b64 ratchet ciphertext, p?: X3DH header }
 */

import type { EnvelopeContext, EnvelopeV2, Sodium } from '../primitives';
import { DecryptionError, ENVELOPE_VERSION } from '../primitives';
import { isB64Key, KEY_LEN } from './bytes';
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

export function serializeSlot(slot: RatchetSlot): string {
  return JSON.stringify(slot);
}

function parsePreKeyHeader(sodium: Sodium, p: any): PreKeyHeader {
  const okId = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 0x7fffffff;
  if (!p || typeof p !== 'object' || !isB64Key(sodium, p.ik) || !isB64Key(sodium, p.ek) || !okId(p.s)) {
    throw new DecryptionError('Malformed X3DH header');
  }
  if (p.o !== undefined && !okId(p.o)) throw new DecryptionError('Malformed X3DH header');
  const out: PreKeyHeader = { ik: p.ik, ek: p.ek, s: p.s };
  if (p.o !== undefined) out.o = p.o;
  return out;
}

/** Defensive parse: every byte of a slot is attacker-controlled. */
export function parseSlot(sodium: Sodium, raw: unknown): RatchetSlot {
  if (typeof raw !== 'string' || raw.length > 64 * 1024) throw new DecryptionError('Malformed key slot');
  let s: any;
  try {
    s = JSON.parse(raw);
  } catch {
    throw new DecryptionError('Malformed key slot');
  }
  if (!s || typeof s !== 'object' || typeof s.h !== 'string' || typeof s.c !== 'string') {
    throw new DecryptionError('Malformed key slot');
  }
  const slot: RatchetSlot = { h: s.h, c: s.c };
  if (s.p !== undefined) slot.p = parsePreKeyHeader(sodium, s.p);
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
