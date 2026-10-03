/**
 * End-to-end encryption + authentication for call signalling (pure; tested in
 * tests/callSignaling.test.ts).
 *
 * WebRTC's DTLS-SRTP protects the media, but DTLS only authenticates the
 * fingerprint that is carried in the SDP. If the SDP travelled in clear (or
 * merely over TLS to our server), whoever runs the relay could swap
 * fingerprints and sit in the middle of the call. So every signalling message
 * (offer, answer, ICE candidates, ...) is sealed device-to-device:
 *
 *   inner  = JSON { v, call, from, to, sid, seq, type, data }
 *   sealed = crypto_box(inner, nonce, recipientDevicePK, senderDeviceSK)
 *   wire   = { v, call, from, to, n, c }
 *
 * - crypto_box (X25519 + XSalsa20-Poly1305) authenticates the sender's
 *   long-term device identity key, which the receiver resolves through
 *   KeyDirectory (trust-on-first-use pinning, covered by safety numbers).
 * - The inner copy of call/from/to must match the outer routing fields and
 *   the receiver's expectations, so a box can't be replayed into another call,
 *   re-attributed to another device, or redirected to another device.
 * - (sid, seq) lets the receiver drop replays within a call.
 */

import type { Sodium } from '../../core/crypto/primitives';

export const SIGNAL_VERSION = 1 as const;

export type SignalType =
  | 'ringing' // callee device -> caller device: "I'm ringing"
  | 'ready' // answering device -> caller device: accepted, send me the offer
  | 'offer'
  | 'answer'
  | 'candidates'
  | 'media' // mic / camera state for the peer's UI
  | 'restart'; // polite peer asks the impolite one for an ICE restart

const SIGNAL_TYPES: readonly SignalType[] = ['ringing', 'ready', 'offer', 'answer', 'candidates', 'media', 'restart'];

/** What travels over the `call:<id>` broadcast channel. */
export interface SealedSignal {
  v: typeof SIGNAL_VERSION;
  call: string;
  from: string;
  to: string;
  /** base64 crypto_box nonce */
  n: string;
  /** base64 crypto_box ciphertext */
  c: string;
}

export interface SignalMessage {
  type: SignalType;
  data: unknown;
  /** Random per-session id of the sender (so seq can restart after an app restart). */
  sid: string;
  seq: number;
}

interface InnerSignal extends SignalMessage {
  v: typeof SIGNAL_VERSION;
  call: string;
  from: string;
  to: string;
}

export class SignalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalAuthError';
  }
}

export function sealSignal(
  sodium: Sodium,
  route: { callId: string; fromDeviceId: string; toDeviceId: string },
  message: SignalMessage,
  senderSecretKey: string,
  recipientPublicKey: string
): SealedSignal {
  const inner: InnerSignal = {
    v: SIGNAL_VERSION,
    call: route.callId,
    from: route.fromDeviceId,
    to: route.toDeviceId,
    sid: message.sid,
    seq: message.seq,
    type: message.type,
    data: message.data ?? null,
  };
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const sk = sodium.from_base64(senderSecretKey);
  try {
    const box = sodium.crypto_box_easy(
      sodium.from_string(JSON.stringify(inner)),
      nonce,
      sodium.from_base64(recipientPublicKey),
      sk
    );
    return {
      v: SIGNAL_VERSION,
      call: route.callId,
      from: route.fromDeviceId,
      to: route.toDeviceId,
      n: sodium.to_base64(nonce),
      c: sodium.to_base64(box),
    };
  } finally {
    sodium.memzero(sk);
  }
}

/** Structural check of an untrusted broadcast payload. */
export function isSealedSignal(x: any): x is SealedSignal {
  return (
    !!x &&
    x.v === SIGNAL_VERSION &&
    typeof x.call === 'string' &&
    typeof x.from === 'string' &&
    typeof x.to === 'string' &&
    typeof x.n === 'string' &&
    typeof x.c === 'string' &&
    x.c.length <= 200_000
  );
}

export function openSignal(
  sodium: Sodium,
  sealed: SealedSignal,
  expect: {
    callId: string;
    myDeviceId: string;
    /** The device the sender claims to be (sealed.from), resolved via KeyDirectory. */
    senderDeviceId: string;
    senderPublicKey: string;
  },
  mySecretKey: string
): SignalMessage {
  if (!isSealedSignal(sealed)) throw new SignalAuthError('Malformed signal');
  if (sealed.call !== expect.callId) throw new SignalAuthError('Signal belongs to another call');
  if (sealed.to !== expect.myDeviceId) throw new SignalAuthError('Signal is addressed to another device');
  if (sealed.from !== expect.senderDeviceId) throw new SignalAuthError('Unexpected sender device');

  let plaintext: string;
  const sk = sodium.from_base64(mySecretKey);
  try {
    plaintext = sodium.to_string(
      sodium.crypto_box_open_easy(
        sodium.from_base64(sealed.c),
        sodium.from_base64(sealed.n),
        sodium.from_base64(expect.senderPublicKey),
        sk
      )
    );
  } catch {
    throw new SignalAuthError('Signal failed authentication (wrong sender key or tampered)');
  } finally {
    sodium.memzero(sk);
  }

  let inner: InnerSignal;
  try {
    inner = JSON.parse(plaintext);
  } catch {
    throw new SignalAuthError('Malformed signal body');
  }
  if (
    !inner ||
    inner.v !== SIGNAL_VERSION ||
    inner.call !== sealed.call ||
    inner.from !== sealed.from ||
    inner.to !== sealed.to ||
    typeof inner.sid !== 'string' ||
    typeof inner.seq !== 'number' ||
    !SIGNAL_TYPES.includes(inner.type)
  ) {
    throw new SignalAuthError('Signal binding mismatch');
  }
  return { type: inner.type, data: inner.data, sid: inner.sid, seq: inner.seq };
}

/** Drops duplicate / replayed signals within one call. */
export class SignalReplayGuard {
  private seen = new Set<string>();

  /** Returns true the first time a (device, sid, seq) is seen. */
  accept(fromDeviceId: string, message: Pick<SignalMessage, 'sid' | 'seq'>): boolean {
    const key = `${fromDeviceId}|${message.sid}|${message.seq}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

// ── Payload validation for decrypted signal data ────────────────────────────

export interface SdpPayload {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface CandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export function parseSdpPayload(data: unknown, expected: 'offer' | 'answer'): SdpPayload | null {
  const d = data as any;
  if (!d || d.type !== expected || typeof d.sdp !== 'string' || d.sdp.length === 0 || d.sdp.length > 100_000) {
    return null;
  }
  return { type: expected, sdp: d.sdp };
}

export function parseCandidates(data: unknown): CandidatePayload[] {
  const list = (data as any)?.candidates;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c: any) => c && typeof c.candidate === 'string' && c.candidate.length < 2048)
    .slice(0, 100)
    .map((c: any) => ({
      candidate: c.candidate,
      sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid : null,
      sdpMLineIndex: typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : null,
    }));
}
