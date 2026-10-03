/**
 * Double Ratchet (https://signal.org/docs/specifications/doubleratchet/),
 * without header encryption.
 *
 *   GENERATE_DH  X25519 (crypto_box_keypair)
 *   DH           X25519 (crypto_scalarmult)
 *   KDF_RK       HKDF-SHA-512(salt = rk, IKM = dh_out, info = "VeroRatchet_v1") -> 64 bytes: rk' || ck
 *   KDF_CK       mk = HMAC-SHA-512(ck, 0x01)[0..32], ck' = HMAC-SHA-512(ck, 0x02)[0..32]
 *   ENCRYPT      key || nonce = HKDF-SHA-512(salt = 0, IKM = mk, info = "VeroMessageKeys_v1", 56)
 *                XChaCha20-Poly1305(plaintext, AD = CONCAT(ad, header))   (spec §5.2: the nonce may be
 *                derived from mk because every message key is used exactly once)
 *   CONCAT       u32(len(ad)) || ad || header
 *   HEADER       dh (32) || u32 pn || u32 n
 *
 * Every function here is PURE: it takes a state and returns a new one. A
 * failure (bad MAC, too many skipped keys, ...) throws and leaves the caller's
 * state untouched, exactly as the spec requires ("changes to the state object
 * are discarded").
 *
 * Skipped message keys (spec §3.2, §6.5): at most MAX_SKIP per chain step,
 * at most MAX_STORED_SKIPPED_KEYS overall (oldest evicted first), and each one
 * expires after SKIPPED_KEY_MAX_AGE_MS.
 */

import type { Sodium } from '../primitives';
import { DecryptionError } from '../primitives';
import { concat, readU32, u32, unb64 } from './bytes';
import { DuplicateMessageError, TooManySkippedMessagesError } from './errors';
import { hkdfSha512, hmacSha512 } from './kdf';
import { KeyPairB64, generateX25519KeyPair } from './keys';

export const MAX_SKIP = 1000;
export const MAX_STORED_SKIPPED_KEYS = 1000;
export const SKIPPED_KEY_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
export const HEADER_LEN = 40;

const RK_INFO = 'VeroRatchet_v1';
const MK_INFO = 'VeroMessageKeys_v1';

export interface SkippedKey {
  /** remote ratchet public key of the chain */
  dh: string;
  n: number;
  mk: string;
  /** time stored (ms) */
  t: number;
}

/** JSON-serialisable ratchet state; all keys base64. */
export interface RatchetState {
  rk: string;
  dhs: KeyPairB64;
  dhr: string | null;
  cks: string | null;
  ckr: string | null;
  ns: number;
  nr: number;
  pn: number;
  skipped: SkippedKey[];
  /** Previous remote ratchet keys (newest last), so replays from old chains are recognised. */
  old?: string[];
}

const MAX_OLD_RATCHET_KEYS = 50;

export interface Header {
  dh: string;
  pn: number;
  n: number;
}

export function encodeHeader(sodium: Sodium, h: Header): Uint8Array {
  return concat(unb64(sodium, h.dh, 32), u32(h.pn), u32(h.n));
}

export function decodeHeader(sodium: Sodium, bytes: Uint8Array): Header {
  if (bytes.length !== HEADER_LEN) throw new DecryptionError('Malformed ratchet header');
  return { dh: sodium.to_base64(bytes.subarray(0, 32)), pn: readU32(bytes, 32), n: readU32(bytes, 36) };
}

function cloneState(s: RatchetState): RatchetState {
  return {
    ...s,
    dhs: { ...s.dhs },
    skipped: s.skipped.map((k) => ({ ...k })),
    old: [...(s.old ?? [])],
  };
}

function dh(sodium: Sodium, pair: KeyPairB64, pub: string): Uint8Array {
  try {
    return sodium.crypto_scalarmult(unb64(sodium, pair.priv, 32), unb64(sodium, pub, 32));
  } catch {
    throw new DecryptionError('Invalid ratchet public key');
  }
}

function kdfRk(sodium: Sodium, rk: string, dhOut: Uint8Array): { rk: string; ck: string } {
  const out = hkdfSha512(sodium, unb64(sodium, rk, 32), dhOut, sodium.from_string(RK_INFO), 64);
  sodium.memzero(dhOut);
  const res = { rk: sodium.to_base64(out.subarray(0, 32)), ck: sodium.to_base64(out.subarray(32, 64)) };
  sodium.memzero(out);
  return res;
}

function kdfCk(sodium: Sodium, ck: string): { ck: string; mk: Uint8Array } {
  const key = unb64(sodium, ck, 32);
  const mk = hmacSha512(sodium, key, new Uint8Array([0x01])).slice(0, 32);
  const next = hmacSha512(sodium, key, new Uint8Array([0x02])).slice(0, 32);
  sodium.memzero(key);
  return { ck: sodium.to_base64(next), mk };
}

function messageKeys(sodium: Sodium, mk: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const out = hkdfSha512(sodium, null, mk, sodium.from_string(MK_INFO), 56);
  return { key: out.slice(0, 32), nonce: out.slice(32, 56) };
}

function concatAd(ad: Uint8Array, header: Uint8Array): Uint8Array {
  return concat(u32(ad.length), ad, header);
}

function aeadEncrypt(sodium: Sodium, mk: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): Uint8Array {
  const { key, nonce } = messageKeys(sodium, mk);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, ad, null, nonce, key);
  } finally {
    sodium.memzero(key);
    sodium.memzero(mk);
  }
}

function aeadDecrypt(sodium: Sodium, mk: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array): Uint8Array {
  const { key, nonce } = messageKeys(sodium, mk);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, ad, nonce, key);
  } catch {
    throw new DecryptionError();
  } finally {
    sodium.memzero(key);
  }
}

/** Spec §3.3 RatchetInitAlice. `remoteRatchetKey` is Bob's signed prekey. */
export function initAlice(sodium: Sodium, sk: Uint8Array, remoteRatchetKey: string): RatchetState {
  const dhs = generateX25519KeyPair(sodium);
  const { rk, ck } = kdfRk(sodium, sodium.to_base64(sk), dh(sodium, dhs, remoteRatchetKey));
  return { rk, dhs, dhr: remoteRatchetKey, cks: ck, ckr: null, ns: 0, nr: 0, pn: 0, skipped: [] };
}

/** Spec §3.3 RatchetInitBob. `ownRatchetKeyPair` is Bob's signed prekey pair. */
export function initBob(sodium: Sodium, sk: Uint8Array, ownRatchetKeyPair: KeyPairB64): RatchetState {
  return {
    rk: sodium.to_base64(sk),
    dhs: { ...ownRatchetKeyPair },
    dhr: null,
    cks: null,
    ckr: null,
    ns: 0,
    nr: 0,
    pn: 0,
    skipped: [],
  };
}

export function canSend(state: RatchetState): boolean {
  return state.cks !== null;
}

/** Spec §3.4 RatchetEncrypt. */
export function ratchetEncrypt(
  sodium: Sodium,
  state: RatchetState,
  plaintext: Uint8Array,
  ad: Uint8Array
): { state: RatchetState; header: Uint8Array; ciphertext: Uint8Array } {
  if (!state.cks) throw new Error('Session cannot send yet (no sending chain)');
  const s = cloneState(state);
  const { ck, mk } = kdfCk(sodium, s.cks!);
  s.cks = ck;
  const header = encodeHeader(sodium, { dh: s.dhs.pub, pn: s.pn, n: s.ns });
  s.ns += 1;
  const ciphertext = aeadEncrypt(sodium, mk, plaintext, concatAd(ad, header));
  return { state: s, header, ciphertext };
}

function pruneSkipped(s: RatchetState, now: number): void {
  s.skipped = s.skipped.filter((k) => now - k.t <= SKIPPED_KEY_MAX_AGE_MS);
  if (s.skipped.length > MAX_STORED_SKIPPED_KEYS) s.skipped = s.skipped.slice(s.skipped.length - MAX_STORED_SKIPPED_KEYS);
}

/** Spec §3.5 SkipMessageKeys. */
function skipMessageKeys(sodium: Sodium, s: RatchetState, until: number, now: number): void {
  if (s.nr + MAX_SKIP < until) throw new TooManySkippedMessagesError();
  if (s.ckr !== null) {
    while (s.nr < until) {
      const { ck, mk } = kdfCk(sodium, s.ckr);
      s.ckr = ck;
      s.skipped.push({ dh: s.dhr!, n: s.nr, mk: sodium.to_base64(mk), t: now });
      sodium.memzero(mk);
      s.nr += 1;
    }
    pruneSkipped(s, now);
  }
}

/** Spec §3.5 DHRatchet. */
function dhRatchet(sodium: Sodium, s: RatchetState, header: Header): void {
  s.pn = s.ns;
  s.ns = 0;
  s.nr = 0;
  if (s.dhr) s.old = [...(s.old ?? []), s.dhr].slice(-MAX_OLD_RATCHET_KEYS);
  s.dhr = header.dh;
  const recv = kdfRk(sodium, s.rk, dh(sodium, s.dhs, s.dhr));
  s.rk = recv.rk;
  s.ckr = recv.ck;
  s.dhs = generateX25519KeyPair(sodium);
  const send = kdfRk(sodium, s.rk, dh(sodium, s.dhs, s.dhr));
  s.rk = send.rk;
  s.cks = send.ck;
}

/** Spec §3.5 RatchetDecrypt. Throws (state untouched) on any failure. */
export function ratchetDecrypt(
  sodium: Sodium,
  state: RatchetState,
  headerBytes: Uint8Array,
  ciphertext: Uint8Array,
  ad: Uint8Array,
  now = Date.now()
): { state: RatchetState; plaintext: Uint8Array } {
  const header = decodeHeader(sodium, headerBytes);
  const s = cloneState(state);
  pruneSkipped(s, now);
  const fullAd = concatAd(ad, headerBytes);

  // TrySkippedMessageKeys
  const idx = s.skipped.findIndex((k) => k.dh === header.dh && k.n === header.n);
  if (idx >= 0) {
    const mk = unb64(sodium, s.skipped[idx].mk, 32);
    const plaintext = aeadDecrypt(sodium, mk, ciphertext, fullAd);
    s.skipped.splice(idx, 1);
    return { state: s, plaintext };
  }

  // A message from the current receiving chain whose key is gone was already
  // decrypted (or evicted): reject it explicitly as a replay.
  if (header.dh === s.dhr && header.n < s.nr) throw new DuplicateMessageError();
  if (header.dh !== s.dhr && s.old?.includes(header.dh)) throw new DuplicateMessageError();

  if (header.dh !== s.dhr) {
    skipMessageKeys(sodium, s, header.pn, now);
    dhRatchet(sodium, s, header);
  }
  skipMessageKeys(sodium, s, header.n, now);
  const { ck, mk } = kdfCk(sodium, s.ckr!);
  s.ckr = ck;
  s.nr += 1;
  const plaintext = aeadDecrypt(sodium, mk, ciphertext, fullAd);
  sodium.memzero(mk);
  return { state: s, plaintext };
}
