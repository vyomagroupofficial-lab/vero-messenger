import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import sodiumModule from 'libsodium-wrappers';
import { Sodium, generateIdentityKeyPair } from '../src/core/crypto/primitives';
import {
  sealSignal,
  openSignal,
  SignalAuthError,
  SignalReplayGuard,
  parseSdpPayload,
  parseCandidates,
  type SealedSignal,
} from '../src/features/calls/signalingCrypto';

let sodium: Sodium;
let caller: { publicKey: string; secretKey: string };
let callee: { publicKey: string; secretKey: string };
let calleeOtherDevice: { publicKey: string; secretKey: string };
let mallory: { publicKey: string; secretKey: string };

before(async () => {
  await sodiumModule.ready;
  sodium = sodiumModule as unknown as Sodium;
  caller = generateIdentityKeyPair(sodium);
  callee = generateIdentityKeyPair(sodium);
  calleeOtherDevice = generateIdentityKeyPair(sodium);
  mallory = generateIdentityKeyPair(sodium);
});

const CALL = '33333333-3333-4333-8333-333333333333';
const OTHER_CALL = '44444444-4444-4444-8444-444444444444';
const route = { callId: CALL, fromDeviceId: 'caller-dev', toDeviceId: 'callee-dev' };
const offer = { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AB:CD\r\n' };

function sealOffer(): SealedSignal {
  return sealSignal(sodium, route, { type: 'offer', data: offer, sid: 's1', seq: 1 }, caller.secretKey, callee.publicKey);
}

function openAsCallee(sealed: SealedSignal, overrides: Partial<Parameters<typeof openSignal>[2]> = {}, sk?: string) {
  return openSignal(
    sodium,
    sealed,
    {
      callId: CALL,
      myDeviceId: 'callee-dev',
      senderDeviceId: sealed?.from,
      senderPublicKey: caller.publicKey,
      ...overrides,
    },
    sk ?? callee.secretKey
  );
}

test('sealed offer round-trips and hides the SDP', () => {
  const sealed = sealOffer();
  assert.equal(JSON.stringify(sealed).includes('fingerprint'), false, 'SDP must not be visible on the wire');
  const msg = openAsCallee(sealed);
  assert.equal(msg.type, 'offer');
  assert.deepEqual(msg.data, offer);
  assert.equal(msg.seq, 1);
});

test('tampered ciphertext is rejected', () => {
  const sealed = sealOffer();
  const bytes = sodium.from_base64(sealed.c);
  bytes[bytes.length - 1] ^= 0x01;
  assert.throws(() => openAsCallee({ ...sealed, c: sodium.to_base64(bytes) }), SignalAuthError);
});

test('tampered nonce is rejected', () => {
  const sealed = sealOffer();
  const n = sodium.from_base64(sealed.n);
  n[0] ^= 0xff;
  assert.throws(() => openAsCallee({ ...sealed, n: sodium.to_base64(n) }), SignalAuthError);
});

test('a signal forged with another key (server MITM) is rejected', () => {
  // Mallory (e.g. a compromised relay) seals her own SDP claiming to be the caller device.
  const forged = sealSignal(
    sodium,
    route,
    { type: 'offer', data: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 EV:IL\r\n' }, sid: 'x', seq: 1 },
    mallory.secretKey,
    callee.publicKey
  );
  // The receiver resolves the *pinned* key for "caller-dev", which is the real caller's key.
  assert.throws(() => openAsCallee(forged), SignalAuthError);
});

test('wrong device: signal addressed to another device is rejected', () => {
  const sealed = sealOffer();
  assert.throws(
    () => openAsCallee(sealed, { myDeviceId: 'callee-other-dev' }, calleeOtherDevice.secretKey),
    /another device/
  );
  // Even if the routing field is rewritten, the other device cannot open the box.
  assert.throws(
    () => openAsCallee({ ...sealed, to: 'callee-other-dev' }, { myDeviceId: 'callee-other-dev' }, calleeOtherDevice.secretKey),
    SignalAuthError
  );
});

test('wrong sender device: re-attributing a signal to another device is rejected', () => {
  const sealed = sealOffer();
  // Claimed sender differs from what the receiver expects (e.g. not the device that answered).
  assert.throws(() => openAsCallee(sealed, { senderDeviceId: 'some-other-device' }), /Unexpected sender/);
  // Rewriting the outer "from" to another device of the same user with that device's key fails too.
  assert.throws(
    () => openAsCallee({ ...sealed, from: 'caller-dev-2' }, { senderDeviceId: 'caller-dev-2', senderPublicKey: mallory.publicKey }),
    SignalAuthError
  );
});

test('outer routing fields are bound to the encrypted body', () => {
  const sealed = sealOffer();
  // Same keys, but outer "from" rewritten: the box opens (same key pair) but the binding check fails.
  assert.throws(() => openAsCallee({ ...sealed, from: 'caller-dev-renamed' }), /binding mismatch/);
});

test('a signal cannot be replayed into another call', () => {
  const sealed = sealOffer();
  assert.throws(() => openAsCallee({ ...sealed, call: OTHER_CALL }, { callId: OTHER_CALL }), /binding mismatch/);
  assert.throws(() => openAsCallee(sealed, { callId: OTHER_CALL }), /another call/);
});

test('malformed payloads are rejected', () => {
  assert.throws(() => openAsCallee({ v: 2 } as any), SignalAuthError);
  assert.throws(() => openAsCallee(null as any), SignalAuthError);
});

test('replay guard drops duplicates but accepts a new session', () => {
  const guard = new SignalReplayGuard();
  assert.equal(guard.accept('dev', { sid: 'a', seq: 1 }), true);
  assert.equal(guard.accept('dev', { sid: 'a', seq: 1 }), false);
  assert.equal(guard.accept('dev', { sid: 'a', seq: 2 }), true);
  assert.equal(guard.accept('dev', { sid: 'b', seq: 1 }), true, 'app restart = new sid');
  assert.equal(guard.accept('dev2', { sid: 'a', seq: 1 }), true);
});

test('payload validators', () => {
  assert.deepEqual(parseSdpPayload(offer, 'offer'), offer);
  assert.equal(parseSdpPayload(offer, 'answer'), null);
  assert.equal(parseSdpPayload({ type: 'offer', sdp: 42 }, 'offer'), null);
  const c = parseCandidates({ candidates: [{ candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 }, { bad: true }] });
  assert.equal(c.length, 1);
  assert.equal(c[0].sdpMid, '0');
  assert.deepEqual(parseCandidates('nope'), []);
});
