/**
 * Per-remote-device session records on top of X3DH + Double Ratchet.
 *
 * A record holds the ACTIVE session (used for sending) plus a few PREVIOUS
 * ones, as libsignal does. Keeping previous sessions is what makes these cases
 * work:
 *   - both devices start X3DH at the same time (each ends up with two sessions;
 *     whichever one a message decrypts under becomes active, so they converge)
 *   - a session reset while older messages from the old session are in flight
 *
 * The initiator attaches its X3DH header (PreKeyHeader) to every message until
 * it receives a reply, so the responder can build the session from whichever
 * message arrives first. The responder finds an existing session for repeated
 * X3DH headers by the initiator's ephemeral "base key".
 *
 * All functions are pure (records in, records out); persistence and locking
 * live in SessionManager.
 */

import type { Sodium } from '../primitives';
import { DecryptionError } from '../primitives';
import { concat, unb64 } from './bytes';
import {
  DuplicateMessageError,
  PreKeyNotFoundError,
  SessionMismatchError,
  SessionNotFoundError,
  TooManySkippedMessagesError,
  UntrustedIdentityError,
} from './errors';
import { HEADER_LEN, RatchetState, initAlice, initBob, ratchetDecrypt, ratchetEncrypt, canSend } from './doubleRatchet';
import { KeyPairB64, PreKeyBundle } from './keys';
import { PreKeyHeader, x3dhInitiate, x3dhRespond } from './x3dh';

export const MAX_PREVIOUS_SESSIONS = 5;

export interface SessionState {
  v: 1;
  ratchet: RatchetState;
  /** base64 X3DH associated data */
  ad: string;
  /** initiator's ephemeral key EK_A: identifies the X3DH run on both sides */
  baseKey: string;
  remoteIdentityKey: string;
  /** set on the initiator's side until the first reply arrives */
  pendingPreKey: PreKeyHeader | null;
  createdAt: number;
}

export interface SessionRecord {
  active: SessionState | null;
  previous: SessionState[];
}

/** One recipient's slot in a v3 envelope (Double Ratchet message). */
export interface RatchetSlot {
  /** base64 ratchet header (40 bytes) */
  h: string;
  /** base64 ratchet ciphertext */
  c: string;
  /** X3DH header, present until the session is confirmed */
  p?: PreKeyHeader;
}

export interface LocalDevice {
  identity: KeyPairB64;
  deviceId: string;
}

export function emptyRecord(): SessionRecord {
  return { active: null, previous: [] };
}

/** Makes `state` the active session, archiving the old one. */
export function installSession(record: SessionRecord | null, state: SessionState): SessionRecord {
  const rec = record ?? emptyRecord();
  const previous = [rec.active, ...rec.previous]
    .filter((s): s is SessionState => !!s && s.baseKey !== state.baseKey)
    .slice(0, MAX_PREVIOUS_SESSIONS);
  return { active: state, previous };
}

/** Moves the active session to `previous` so the next send starts a fresh X3DH. */
export function archiveActive(record: SessionRecord | null): SessionRecord {
  const rec = record ?? emptyRecord();
  if (!rec.active) return rec;
  return { active: null, previous: [rec.active, ...rec.previous].slice(0, MAX_PREVIOUS_SESSIONS) };
}

/** Alice's side: X3DH with Bob's (already claimed) bundle, then RatchetInitAlice. */
export function initiateSession(
  sodium: Sodium,
  local: LocalDevice,
  bundle: PreKeyBundle,
  pinned: { identityKey: string; signingKey?: string | null },
  now = Date.now()
): SessionState {
  const x = x3dhInitiate(sodium, local, bundle, pinned);
  const ratchet = initAlice(sodium, x.sk, bundle.signedPreKey);
  sodium.memzero(x.sk);
  return {
    v: 1,
    ratchet,
    ad: sodium.to_base64(x.ad),
    baseKey: x.header.ek,
    remoteIdentityKey: bundle.identityKey,
    pendingPreKey: x.header,
    createdAt: now,
  };
}

export function encryptSlot(
  sodium: Sodium,
  record: SessionRecord,
  payload: Uint8Array,
  binding: Uint8Array
): { slot: RatchetSlot; record: SessionRecord } {
  const active = record.active;
  if (!active || !canSend(active.ratchet)) throw new SessionNotFoundError();
  const r = ratchetEncrypt(sodium, active.ratchet, payload, concat(unb64(sodium, active.ad), binding));
  const slot: RatchetSlot = { h: sodium.to_base64(r.header), c: sodium.to_base64(r.ciphertext) };
  if (active.pendingPreKey) slot.p = { ...active.pendingPreKey };
  return { slot, record: { ...record, active: { ...active, ratchet: r.state } } };
}

export interface DecryptDeps {
  local: LocalDevice;
  remoteDeviceId: string;
  /** Identity key pinned for the sender device (from the key directory). */
  remoteIdentityKey: string;
  loadSignedPreKey(id: number): Promise<KeyPairB64 | null>;
  loadOneTimePreKey(id: number): Promise<KeyPairB64 | null>;
  now?: number;
}

export interface DecryptSlotResult {
  payload: Uint8Array;
  record: SessionRecord;
  /** one-time prekey that must now be deleted (committed together with the record) */
  consumedOneTimePreKey?: number;
}

function decryptWith(
  sodium: Sodium,
  state: SessionState,
  slot: RatchetSlot,
  binding: Uint8Array,
  now: number
): { state: SessionState; payload: Uint8Array } {
  const r = ratchetDecrypt(
    sodium,
    state.ratchet,
    unb64(sodium, slot.h, HEADER_LEN),
    unb64(sodium, slot.c),
    concat(unb64(sodium, state.ad), binding),
    now
  );
  return { state: { ...state, ratchet: r.state }, payload: r.plaintext };
}

function promote(record: SessionRecord, state: SessionState): SessionRecord {
  return installSession(record, state);
}

export async function decryptSlot(
  sodium: Sodium,
  record: SessionRecord | null,
  slot: RatchetSlot,
  binding: Uint8Array,
  deps: DecryptDeps
): Promise<DecryptSlotResult> {
  const now = deps.now ?? Date.now();
  const rec = record ?? emptyRecord();
  const sessions = [rec.active, ...rec.previous].filter((s): s is SessionState => !!s);

  if (slot.p) {
    const p = slot.p;
    if (p.ik !== deps.remoteIdentityKey) throw new UntrustedIdentityError();

    // Repeated X3DH header for a session we already built.
    const existing = sessions.find((s) => s.baseKey === p.ek && s.remoteIdentityKey === p.ik);
    if (existing) {
      const out = decryptWith(sodium, existing, slot, binding, now);
      return { payload: out.payload, record: promote(rec, out.state) };
    }

    const spk = await deps.loadSignedPreKey(p.s);
    if (!spk) throw new PreKeyNotFoundError(`signed prekey ${p.s}`);
    let opk: KeyPairB64 | null = null;
    if (p.o !== undefined) {
      opk = await deps.loadOneTimePreKey(p.o);
      if (!opk) throw new PreKeyNotFoundError(`one-time prekey ${p.o}`);
    }

    let x;
    try {
      x = x3dhRespond(sodium, deps.local, deps.remoteDeviceId, p, spk, opk);
    } catch {
      throw new DecryptionError('Invalid X3DH header');
    }
    const fresh: SessionState = {
      v: 1,
      ratchet: initBob(sodium, x.sk, spk),
      ad: sodium.to_base64(x.ad),
      baseKey: p.ek,
      remoteIdentityKey: p.ik,
      pendingPreKey: null,
      createdAt: now,
    };
    sodium.memzero(x.sk);
    const out = decryptWith(sodium, fresh, slot, binding, now);
    return {
      payload: out.payload,
      record: installSession(rec, out.state),
      consumedOneTimePreKey: p.o,
    };
  }

  if (sessions.length === 0) throw new SessionNotFoundError();

  let duplicate = false;
  let tooMany = false;
  for (const s of sessions) {
    if (s.remoteIdentityKey !== deps.remoteIdentityKey) continue;
    try {
      const out = decryptWith(sodium, s, slot, binding, now);
      // A reply in this session: the initiator stops sending X3DH headers.
      const confirmed = { ...out.state, pendingPreKey: null };
      return { payload: out.payload, record: promote(rec, confirmed) };
    } catch (e) {
      if (e instanceof DuplicateMessageError) duplicate = true;
      if (e instanceof TooManySkippedMessagesError) tooMany = true;
    }
  }
  if (duplicate) throw new DuplicateMessageError();
  if (tooMany) throw new TooManySkippedMessagesError();
  throw new SessionMismatchError();
}
