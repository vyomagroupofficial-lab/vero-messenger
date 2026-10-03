import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, hkdfSync } from 'node:crypto';
import sodiumModule from 'libsodium-wrappers';
import {
  Sodium,
  DecryptionError,
  NotAddressedToDeviceError,
  EnvelopeContext,
  encryptEnvelope,
  serializeEnvelope,
  generateIdentityKeyPair,
} from '../src/core/crypto/primitives';
import { hkdfSha512, hmacSha512 } from '../src/core/crypto/ratchet/kdf';
import {
  KeyPairB64,
  PreKeyBundle,
  generateOneTimePreKeys,
  generateSignedPreKey,
  generateSigningKeyPair,
  generateX25519KeyPair,
  signIdentityKey,
  verifyBundle,
} from '../src/core/crypto/ratchet/keys';
import { x3dhInitiate, x3dhRespond } from '../src/core/crypto/ratchet/x3dh';
import {
  MAX_SKIP,
  MAX_STORED_SKIPPED_KEYS,
  SKIPPED_KEY_MAX_AGE_MS,
  initAlice,
  initBob,
  ratchetDecrypt,
  ratchetEncrypt,
  RatchetState,
} from '../src/core/crypto/ratchet/doubleRatchet';
import {
  DuplicateMessageError,
  InvalidBundleError,
  NoReachableDevicesError,
  OwnMessageUnavailableError,
  PreKeyNotFoundError,
  SessionNotFoundError,
  TooManySkippedMessagesError,
  UntrustedIdentityError,
} from '../src/core/crypto/ratchet/errors';
import { MemoryRatchetStore, RatchetStore } from '../src/core/crypto/ratchet/store';
import { MinimalSqlDb, SqliteRatchetStore, RATCHET_TABLE } from '../src/core/crypto/ratchet/SqliteRatchetStore';
import { bundleFromRow } from '../src/core/crypto/ratchet/serverApi';
import { openRow, sealRow } from '../src/core/crypto/ratchet/atRest';
import { KeyedMutex } from '../src/core/crypto/ratchet/mutex';
import { parseAnyEnvelope, parseSlot } from '../src/core/crypto/ratchet/envelope';
import {
  PreKeyServer,
  PreKeyStatus,
  SessionDirectory,
  SessionManager,
  SIGNED_PREKEY_RETAIN_MS,
  SIGNED_PREKEY_ROTATE_MS,
  ONE_TIME_PREKEY_TARGET,
  parseControlPlaintext,
  sessionResetPlaintext,
} from '../src/core/crypto/ratchet/SessionManager';
import { SessionRecord } from '../src/core/crypto/ratchet/session';
import {
  AudienceDevice,
  assembleStoryEnvelope,
  splitStoryEnvelope,
  storyContext,
} from '../src/features/stories/storyCrypto';

let sodium: Sodium;
before(async () => {
  await sodiumModule.ready;
  sodium = sodiumModule as unknown as Sodium;
});

const CONV = '11111111-1111-4111-8111-111111111111';
let msgCounter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++msgCounter).padStart(12, '0')}`;

// ── Fake backend: devices table + prekey RPCs ────────────────────────────────

interface ServerDevice {
  userId: string;
  identityKey: string;
  signingKey?: string;
  identitySignature?: string;
  spk?: { id: number; publicKey: string; signature: string };
  opks: { id: number; publicKey: string }[];
}

class FakeBackend {
  devices = new Map<string, ServerDevice>();
  claims = 0;
  /** test hook to corrupt bundles in transit */
  tamper: ((b: PreKeyBundle) => PreKeyBundle) | null = null;

  register(deviceId: string, userId: string, identityKey: string) {
    this.devices.set(deviceId, { userId, identityKey, opks: [] });
  }

  api(): PreKeyServer {
    return {
      claimBundles: async (ids) => {
        this.claims++;
        const out: PreKeyBundle[] = [];
        for (const id of ids) {
          const d = this.devices.get(id);
          if (!d || !d.signingKey || !d.identitySignature || !d.spk) continue;
          const opk = d.opks.shift();
          let b: PreKeyBundle = {
            deviceId: id,
            userId: d.userId,
            identityKey: d.identityKey,
            signingKey: d.signingKey,
            identitySignature: d.identitySignature,
            signedPreKeyId: d.spk.id,
            signedPreKey: d.spk.publicKey,
            signedPreKeySignature: d.spk.signature,
            oneTimePreKeyId: opk?.id ?? null,
            oneTimePreKey: opk?.publicKey ?? null,
          };
          if (this.tamper) b = this.tamper(b);
          out.push(b);
        }
        return out;
      },
      publishSigningKey: async (deviceId, signingKey, identitySignature) => {
        const d = this.devices.get(deviceId)!;
        if (d.signingKey && d.signingKey !== signingKey) throw new Error('signing key already set');
        d.signingKey = signingKey;
        d.identitySignature = identitySignature;
      },
      uploadPreKeys: async (deviceId, spk, opks) => {
        const d = this.devices.get(deviceId)!;
        if (spk) d.spk = spk;
        d.opks.push(...opks);
        return d.opks.length;
      },
      preKeyStatus: async (deviceId): Promise<PreKeyStatus> => {
        const d = this.devices.get(deviceId)!;
        return { oneTime: d.opks.length, signedPreKeyId: d.spk?.id ?? null };
      },
    };
  }
}

interface Device {
  userId: string;
  deviceId: string;
  identity: KeyPairB64;
  store: RatchetStore;
  manager: SessionManager;
  broken: string[];
  pins: Map<string, string>;
  clock: { now: number };
}

function makeDevice(
  backend: FakeBackend,
  userId: string,
  deviceId: string,
  opts: { store?: RatchetStore; identity?: KeyPairB64; signing?: KeyPairB64; clock?: { now: number } } = {}
): Device {
  const identity = opts.identity ?? generateX25519KeyPair(sodium);
  const signing = opts.signing ?? generateSigningKeyPair(sodium);
  if (!backend.devices.has(deviceId)) backend.register(deviceId, userId, identity.pub);
  const pins = new Map<string, string>();
  const clock = opts.clock ?? { now: Date.now() };
  const directory: SessionDirectory = {
    trusted: async (id) => {
      const d = backend.devices.get(id);
      return d ? { userId: d.userId, identityKey: d.identityKey, signingKey: pins.get(id) ?? null } : null;
    },
    pinSigningKey: async (id, _u, key) => {
      if (!pins.has(id)) pins.set(id, key);
    },
  };
  const store = opts.store ?? new MemoryRatchetStore({}, undefined, () => clock.now);
  const broken: string[] = [];
  const manager = new SessionManager({
    sodium,
    local: { userId, deviceId, identity, signing },
    store,
    directory,
    server: backend.api(),
    hooks: { onSessionBroken: (id) => broken.push(id) },
    now: () => clock.now,
  });
  return { userId, deviceId, identity, store, manager, broken, pins, clock };
}

const ref = (d: Device) => ({ deviceId: d.deviceId, publicKey: d.identity.pub });
const ctxFrom = (d: Device, messageId = nextId(), conversationId = CONV): EnvelopeContext => ({
  conversationId,
  messageId,
  senderDeviceId: d.deviceId,
});

async function send(from: Device, to: Device[], text: string, ctx = ctxFrom(from)) {
  const raw = await from.manager.encrypt(ctx, text, to.map(ref));
  return { ctx, raw };
}
const open = (to: Device, from: Device, m: { ctx: EnvelopeContext; raw: string }) =>
  to.manager.decrypt(m.ctx, m.raw, from.identity.pub);

async function pair() {
  const backend = new FakeBackend();
  const alice = makeDevice(backend, 'alice', 'alice-phone');
  const bob = makeDevice(backend, 'bob', 'bob-phone');
  await alice.manager.refreshPreKeys();
  await bob.manager.refreshPreKeys();
  return { backend, alice, bob };
}

async function sessionOf(d: Device, remote: string) {
  return d.store.get<SessionRecord>('session', remote);
}

/** Removes a cached plaintext so the next decrypt has to hit the ratchet. */
async function forget(d: Device, m: { ctx: EnvelopeContext }) {
  await d.store.write([
    { ns: 'pt', key: `${m.ctx.conversationId}|${m.ctx.messageId}|${m.ctx.senderDeviceId}`, value: null },
  ]);
}

// ── KDFs ─────────────────────────────────────────────────────────────────────

describe('KDF', () => {
  test('HMAC-SHA-512 matches Node (short and long keys)', () => {
    for (const keyLen of [0, 32, 128, 200]) {
      const key = sodium.randombytes_buf(keyLen);
      const data = sodium.randombytes_buf(77);
      const expected = createHmac('sha512', Buffer.from(key)).update(Buffer.from(data)).digest();
      assert.deepEqual(Buffer.from(hmacSha512(sodium, key, data)), expected);
    }
  });

  test('HKDF-SHA-512 matches Node', () => {
    const ikm = sodium.randombytes_buf(64);
    const salt = sodium.randombytes_buf(32);
    const info = sodium.from_string('VeroTest');
    for (const len of [32, 56, 64, 200]) {
      const expected = Buffer.from(hkdfSync('sha512', Buffer.from(ikm), Buffer.from(salt), Buffer.from(info), len));
      assert.deepEqual(Buffer.from(hkdfSha512(sodium, salt, ikm, info, len)), expected);
    }
    // absent salt = HashLen zero bytes
    const zero = Buffer.from(hkdfSync('sha512', Buffer.from(ikm), Buffer.alloc(64), Buffer.from(info), 32));
    assert.deepEqual(Buffer.from(hkdfSha512(sodium, null, ikm, info, 32)), zero);
  });
});

// ── X3DH ─────────────────────────────────────────────────────────────────────

describe('X3DH', () => {
  function bundleFor(withOpk: boolean) {
    const identity = generateX25519KeyPair(sodium);
    const signing = generateSigningKeyPair(sodium);
    const spk = generateSignedPreKey(sodium, 7, signing.priv);
    const [opk] = generateOneTimePreKeys(sodium, 40, 1);
    const bundle: PreKeyBundle = {
      deviceId: 'bob-phone',
      identityKey: identity.pub,
      signingKey: signing.pub,
      identitySignature: signIdentityKey(sodium, identity.pub, signing.priv),
      signedPreKeyId: spk.id,
      signedPreKey: spk.pub,
      signedPreKeySignature: spk.signature,
      oneTimePreKeyId: withOpk ? opk.id : null,
      oneTimePreKey: withOpk ? opk.pub : null,
    };
    return { identity, signing, spk, opk, bundle };
  }

  for (const withOpk of [true, false]) {
    test(`both sides derive the same SK and AD (${withOpk ? 'with' : 'without'} one-time prekey)`, () => {
      const bob = bundleFor(withOpk);
      const alice = { identity: generateX25519KeyPair(sodium), deviceId: 'alice-phone' };
      const a = x3dhInitiate(sodium, alice, bob.bundle, { identityKey: bob.identity.pub, signingKey: bob.signing.pub });
      assert.equal(a.header.o, withOpk ? bob.opk.id : undefined);
      const b = x3dhRespond(
        sodium,
        { identity: bob.identity, deviceId: 'bob-phone' },
        'alice-phone',
        a.header,
        bob.spk,
        withOpk ? bob.opk : null
      );
      assert.deepEqual(b.sk, a.sk);
      assert.deepEqual(b.ad, a.ad);
    });
  }

  test('with and without the one-time prekey give different keys', () => {
    const bob = bundleFor(true);
    const alice = { identity: generateX25519KeyPair(sodium), deviceId: 'alice-phone' };
    const a = x3dhInitiate(sodium, alice, bob.bundle, { identityKey: bob.identity.pub });
    const b = x3dhRespond(sodium, { identity: bob.identity, deviceId: 'bob-phone' }, 'alice-phone', a.header, bob.spk, null);
    assert.notDeepEqual(b.sk, a.sk);
  });

  test('bundle verification rejects forged signatures, swapped keys and unpinned identities', () => {
    const bob = bundleFor(true);
    const pinned = { identityKey: bob.identity.pub, signingKey: bob.signing.pub };
    verifyBundle(sodium, bob.bundle, pinned);
    const other = generateX25519KeyPair(sodium);
    const otherSigning = generateSigningKeyPair(sodium);
    const cases: PreKeyBundle[] = [
      { ...bob.bundle, signedPreKey: other.pub },
      { ...bob.bundle, signedPreKeyId: 8 },
      { ...bob.bundle, identityKey: other.pub },
      { ...bob.bundle, signingKey: otherSigning.pub },
      // server substitutes its own signing key AND re-signs: caught by the pinned signing key
      {
        ...bob.bundle,
        signingKey: otherSigning.pub,
        identitySignature: signIdentityKey(sodium, bob.identity.pub, otherSigning.priv),
        signedPreKeySignature: generateSignedPreKey(sodium, 7, otherSigning.priv).signature,
      },
      { ...bob.bundle, identitySignature: bob.bundle.signedPreKeySignature },
      { ...bob.bundle, oneTimePreKey: 'not-a-key' },
    ];
    for (const c of cases) assert.throws(() => verifyBundle(sodium, c, pinned), InvalidBundleError);
  });
});

// ── Double Ratchet (pure) ────────────────────────────────────────────────────

describe('Double Ratchet core', () => {
  function init(): { a: RatchetState; b: RatchetState } {
    const sk = sodium.randombytes_buf(32);
    const bobSpk = generateX25519KeyPair(sodium);
    return { a: initAlice(sodium, sk, bobSpk.pub), b: initBob(sodium, sk, bobSpk) };
  }
  const AD = new Uint8Array([1, 2, 3]);
  const enc = (s: RatchetState, text: string) => ratchetEncrypt(sodium, s, sodium.from_string(text), AD);

  test('ping-pong with DH ratchet steps', () => {
    let { a, b } = init();
    for (let round = 0; round < 5; round++) {
      const m = enc(a, `a${round}`);
      a = m.state;
      const r = ratchetDecrypt(sodium, b, m.header, m.ciphertext, AD);
      b = r.state;
      assert.equal(sodium.to_string(r.plaintext), `a${round}`);
      const n = enc(b, `b${round}`);
      b = n.state;
      const s = ratchetDecrypt(sodium, a, n.header, n.ciphertext, AD);
      a = s.state;
      assert.equal(sodium.to_string(s.plaintext), `b${round}`);
    }
  });

  test('skip cap: a gap larger than MAX_SKIP is refused', () => {
    let { a, b } = init();
    const first = enc(a, 'first');
    a = first.state;
    b = ratchetDecrypt(sodium, b, first.header, first.ciphertext, AD).state;
    for (let i = 0; i < MAX_SKIP + 1; i++) a = enc(a, 'x').state;
    const far = enc(a, 'far');
    assert.throws(() => ratchetDecrypt(sodium, b, far.header, far.ciphertext, AD), TooManySkippedMessagesError);
  });

  test('stored skipped keys are capped and expire', () => {
    let { a, b } = init();
    const msgs: ReturnType<typeof enc>[] = [];
    for (let i = 0; i < 1200; i++) {
      const m = enc(a, `m${i}`);
      a = m.state;
      msgs.push(m);
    }
    // Deliver 900, then 1199 (skips 299), then a new chain to push more skipped keys.
    const t0 = Date.now();
    let r = ratchetDecrypt(sodium, b, msgs[900].header, msgs[900].ciphertext, AD, t0);
    assert.equal(r.state.skipped.length, 900);
    r = ratchetDecrypt(sodium, r.state, msgs[1199].header, msgs[1199].ciphertext, AD, t0);
    assert.equal(r.state.skipped.length, MAX_STORED_SKIPPED_KEYS); // 900 + 298 capped
    // Oldest were evicted: message 0 is gone, message 1198 still decrypts.
    assert.throws(() => ratchetDecrypt(sodium, r.state, msgs[0].header, msgs[0].ciphertext, AD, t0), DuplicateMessageError);
    assert.equal(
      sodium.to_string(ratchetDecrypt(sodium, r.state, msgs[1198].header, msgs[1198].ciphertext, AD, t0).plaintext),
      'm1198'
    );
    // After the max age everything skipped is dropped.
    const later = t0 + SKIPPED_KEY_MAX_AGE_MS + 1;
    assert.throws(() => ratchetDecrypt(sodium, r.state, msgs[1198].header, msgs[1198].ciphertext, AD, later), DecryptionError);
  });

  test('a failed decrypt leaves the state untouched', () => {
    let { a, b } = init();
    const m = enc(a, 'hello');
    const bad = new Uint8Array(m.ciphertext);
    bad[3] ^= 1;
    assert.throws(() => ratchetDecrypt(sodium, b, m.header, bad, AD), DecryptionError);
    const before = JSON.stringify(b);
    assert.throws(() => ratchetDecrypt(sodium, b, m.header, m.ciphertext, new Uint8Array([9])), DecryptionError);
    assert.equal(JSON.stringify(b), before);
    assert.equal(sodium.to_string(ratchetDecrypt(sodium, b, m.header, m.ciphertext, AD).plaintext), 'hello');
  });
});

// ── Session manager: fan-out, ordering, recovery ─────────────────────────────

describe('session layer (v3 envelopes)', () => {
  test('first message runs X3DH (consuming a one-time prekey), the reply confirms the session', async () => {
    const { backend, alice, bob } = await pair();
    const bobOpksBefore = backend.devices.get('bob-phone')!.opks.length;
    const m1 = await send(alice, [bob], 'hi bob');
    assert.equal(backend.devices.get('bob-phone')!.opks.length, bobOpksBefore - 1);
    const slot = parseSlot(sodium, parseAnyEnvelope(m1.raw).k['bob-phone']);
    assert.ok(slot.p, 'first message carries the X3DH header');
    assert.equal(await open(bob, alice, m1), 'hi bob');
    // Bob consumed the matching one-time prekey locally.
    assert.equal(await bob.store.get('opk', String(slot.p!.o)), null);

    const m2 = await send(alice, [bob], 'still pending');
    assert.ok(parseSlot(sodium, parseAnyEnvelope(m2.raw).k['bob-phone']).p, 'header repeated until a reply');
    assert.equal(await open(bob, alice, m2), 'still pending');

    const r1 = await send(bob, [alice], 'hi alice');
    assert.equal(parseSlot(sodium, parseAnyEnvelope(r1.raw).k['alice-phone']).p, undefined, 'responder sends no header');
    assert.equal(await open(alice, bob, r1), 'hi alice');
    const m3 = await send(alice, [bob], 'confirmed');
    assert.equal(parseSlot(sodium, parseAnyEnvelope(m3.raw).k['bob-phone']).p, undefined);
    assert.equal(await open(bob, alice, m3), 'confirmed');
    assert.equal(backend.claims, 1, 'only the initiator claimed a bundle');
  });

  test('in-order conversation over many DH ratchet steps', async () => {
    const { alice, bob } = await pair();
    for (let i = 0; i < 20; i++) {
      const [from, to] = i % 3 === 2 ? [bob, alice] : [alice, bob];
      const m = await send(from, [to], `msg ${i}`);
      assert.equal(await open(to, from, m), `msg ${i}`);
    }
  });

  test('out-of-order delivery (including across ratchet steps)', async () => {
    const { alice, bob } = await pair();
    const first = await send(alice, [bob], 'm0');
    assert.equal(await open(bob, alice, first), 'm0');
    const batch1 = [];
    for (let i = 1; i <= 5; i++) batch1.push(await send(alice, [bob], `m${i}`));
    const reply = await send(bob, [alice], 'reply');
    // Alice sees Bob's reply before Bob sees batch1; she ratchets and sends batch2.
    assert.equal(await open(alice, bob, reply), 'reply');
    const batch2 = [];
    for (let i = 6; i <= 8; i++) batch2.push(await send(alice, [bob], `m${i}`));
    const order = [batch2[1], batch1[4], batch1[1], batch2[0], batch1[0], batch1[3], batch2[2], batch1[2]];
    for (const m of order) {
      const n = m.ctx.messageId;
      assert.match(await open(bob, alice, m), /^m\d$/, n);
    }
  });

  test('lost messages do not block later ones', async () => {
    const { alice, bob } = await pair();
    assert.equal(await open(bob, alice, await send(alice, [bob], 'a')), 'a');
    await send(alice, [bob], 'lost 1');
    await send(alice, [bob], 'lost 2');
    assert.equal(await open(bob, alice, await send(alice, [bob], 'b')), 'b');
    const rec = await sessionOf(bob, 'alice-phone');
    assert.equal(rec!.active!.ratchet.skipped.length, 2);
    assert.equal(await open(alice, bob, await send(bob, [alice], 'c')), 'c');
  });

  test('simultaneous first messages: both sides converge', async () => {
    const { alice, bob } = await pair();
    const [ma, mb] = await Promise.all([send(alice, [bob], 'from alice'), send(bob, [alice], 'from bob')]);
    assert.equal(await open(bob, alice, ma), 'from alice');
    assert.equal(await open(alice, bob, mb), 'from bob');
    for (let i = 0; i < 6; i++) {
      const [from, to] = i % 2 ? [bob, alice] : [alice, bob];
      const m = await send(from, [to], `after ${i}`);
      assert.equal(await open(to, from, m), `after ${i}`);
    }
    // Another simultaneous burst after convergence.
    const [x, y] = await Promise.all([send(alice, [bob], 'x'), send(bob, [alice], 'y')]);
    assert.equal(await open(bob, alice, x), 'x');
    assert.equal(await open(alice, bob, y), 'y');
  });

  test('duplicates are answered from the plaintext cache; replays after the cache are refused', async () => {
    const { alice, bob } = await pair();
    const m = await send(alice, [bob], 'once');
    const [p1, p2] = await Promise.all([open(bob, alice, m), open(bob, alice, m)]);
    assert.equal(p1, 'once');
    assert.equal(p2, 'once');
    assert.equal(await open(bob, alice, m), 'once');
    const m2 = await send(alice, [bob], 'twice');
    assert.equal(await open(bob, alice, m2), 'twice');
    await forget(bob, m2);
    await assert.rejects(open(bob, alice, m2), DuplicateMessageError);
    // Replaying the slot under another message id fails the binding.
    await assert.rejects(open(bob, alice, { ...m2, ctx: { ...m2.ctx, messageId: nextId() } }), DecryptionError);
  });

  test('tampered header, slot ciphertext or body: rejected without burning the key', async () => {
    const { alice, bob } = await pair();
    assert.equal(await open(bob, alice, await send(alice, [bob], 'setup')), 'setup');
    assert.equal(await open(alice, bob, await send(bob, [alice], 'ack')), 'ack');
    const m = await send(alice, [bob], 'secret');
    const env = JSON.parse(m.raw);
    const slot = JSON.parse(env.k['bob-phone']);
    const flip = (b64: string, i: number) => {
      const b = sodium.from_base64(b64);
      b[i] ^= 0x01;
      return sodium.to_base64(b);
    };
    const variants = [
      { ...env, k: { 'bob-phone': JSON.stringify({ ...slot, h: flip(slot.h, 35) }) } }, // pn/n changed
      { ...env, k: { 'bob-phone': JSON.stringify({ ...slot, h: flip(slot.h, 39) }) } },
      { ...env, k: { 'bob-phone': JSON.stringify({ ...slot, c: flip(slot.c, 5) }) } },
      { ...env, c: flip(env.c, 5) },
      { ...env, n: flip(env.n, 0) },
      { ...env, k: { 'bob-phone': 'garbage' } },
    ];
    for (const v of variants) {
      await assert.rejects(open(bob, alice, { ctx: m.ctx, raw: JSON.stringify(v) }), DecryptionError);
    }
    // The genuine message still decrypts afterwards.
    assert.equal(await open(bob, alice, m), 'secret');
  });

  test('multi-device: recipient devices and the sender\'s second device all decrypt', async () => {
    const backend = new FakeBackend();
    const alicePhone = makeDevice(backend, 'alice', 'alice-phone');
    const aliceLaptop = makeDevice(backend, 'alice', 'alice-laptop');
    const bobPhone = makeDevice(backend, 'bob', 'bob-phone');
    const bobTablet = makeDevice(backend, 'bob', 'bob-tablet');
    for (const d of [alicePhone, aliceLaptop, bobPhone, bobTablet]) await d.manager.refreshPreKeys();
    const all = [alicePhone, aliceLaptop, bobPhone, bobTablet];

    const m = await send(alicePhone, all, 'to everyone');
    const env = parseAnyEnvelope(m.raw);
    assert.deepEqual(Object.keys(env.k).sort(), ['alice-laptop', 'bob-phone', 'bob-tablet']);
    for (const d of [aliceLaptop, bobPhone, bobTablet]) assert.equal(await open(d, alicePhone, m), 'to everyone');
    // The sending device reads its own message from its local cache.
    assert.equal(await open(alicePhone, alicePhone, m), 'to everyone');
    // A fresh install of the sender device (empty store) can't: clear status.
    const reinstalled = makeDevice(backend, 'alice', 'alice-phone', { identity: alicePhone.identity });
    await assert.rejects(open(reinstalled, alicePhone, m), OwnMessageUnavailableError);

    const r = await send(bobTablet, all, 'reply from tablet');
    for (const d of [alicePhone, aliceLaptop, bobPhone]) assert.equal(await open(d, bobTablet, r), 'reply from tablet');

    // A device added later sees only what was sent after it was linked.
    const bobDesktop = makeDevice(backend, 'bob', 'bob-desktop');
    await bobDesktop.manager.refreshPreKeys();
    await assert.rejects(open(bobDesktop, alicePhone, m), NotAddressedToDeviceError);
    const later = await send(alicePhone, [...all, bobDesktop], 'welcome desktop');
    assert.equal(await open(bobDesktop, alicePhone, later), 'welcome desktop');
  });

  test('one-time prekey exhaustion falls back to X3DH without a one-time prekey', async () => {
    const { backend, alice, bob } = await pair();
    backend.devices.get('bob-phone')!.opks = [];
    const m = await send(alice, [bob], 'no opk');
    assert.equal(parseSlot(sodium, parseAnyEnvelope(m.raw).k['bob-phone']).p!.o, undefined);
    assert.equal(await open(bob, alice, m), 'no opk');
    // Bob's next refresh refills the pool.
    const status = await bob.manager.refreshPreKeys();
    assert.equal(status.oneTime, ONE_TIME_PREKEY_TARGET);
  });

  test('devices without a valid bundle are skipped; none reachable is an error', async () => {
    const { backend, alice, bob } = await pair();
    const legacy = makeDevice(backend, 'bob', 'bob-old-app'); // never published prekeys
    const m = await send(alice, [bob, legacy], 'partial');
    assert.deepEqual(Object.keys(parseAnyEnvelope(m.raw).k), ['bob-phone']);
    await assert.rejects(send(alice, [legacy], 'nobody'), NoReachableDevicesError);

    // A bundle whose signed prekey was swapped by the server is rejected.
    const carol = makeDevice(backend, 'carol', 'carol-phone');
    await carol.manager.refreshPreKeys();
    backend.tamper = (b) => ({ ...b, signedPreKey: generateX25519KeyPair(sodium).pub });
    await assert.rejects(send(alice, [carol], 'mitm?'), NoReachableDevicesError);
    backend.tamper = null;
    // A note-to-self (only this device) is fine.
    const self = await send(alice, [alice], 'note');
    assert.deepEqual(parseAnyEnvelope(self.raw).k, {});
    assert.equal(await open(alice, alice, self), 'note');
  });

  test('the signing key is pinned on first use; a later substitution is refused', async () => {
    const { backend, alice, bob } = await pair();
    assert.equal(await open(bob, alice, await send(alice, [bob], 'pin it')), 'pin it');
    assert.equal(alice.pins.get('bob-phone'), backend.devices.get('bob-phone')!.signingKey);
    // Server swaps Bob's signing key (consistent signatures) and Alice must re-run X3DH.
    const evil = generateSigningKeyPair(sodium);
    const d = backend.devices.get('bob-phone')!;
    d.signingKey = evil.pub;
    d.identitySignature = signIdentityKey(sodium, d.identityKey, evil.priv);
    const spk = generateSignedPreKey(sodium, 99, evil.priv);
    d.spk = { id: 99, publicKey: spk.pub, signature: spk.signature };
    await alice.manager.resetSession('bob-phone');
    await assert.rejects(send(alice, [bob], 'refused'), NoReachableDevicesError);
  });

  test('identity mismatch in an X3DH header is refused', async () => {
    const { alice, bob } = await pair();
    const m = await send(alice, [bob], 'hello');
    await assert.rejects(bob.manager.decrypt(m.ctx, m.raw, generateX25519KeyPair(sodium).pub), UntrustedIdentityError);
    assert.equal(await open(bob, alice, m), 'hello');
  });

  test('v2 envelopes still decrypt', async () => {
    const backend = new FakeBackend();
    const bob = makeDevice(backend, 'bob', 'bob-phone');
    const aliceV2 = generateIdentityKeyPair(sodium);
    const ctx: EnvelopeContext = { conversationId: CONV, messageId: nextId(), senderDeviceId: 'alice-old' };
    const raw = serializeEnvelope(
      encryptEnvelope(sodium, 'legacy', ctx, aliceV2.secretKey, [{ deviceId: 'bob-phone', publicKey: bob.identity.pub }])
    );
    assert.equal(await bob.manager.decrypt(ctx, raw, aliceV2.publicKey), 'legacy');
    // ...repeatedly (static keys, no ratchet state involved)
    assert.equal(await bob.manager.decrypt(ctx, raw, aliceV2.publicKey), 'legacy');
    await assert.rejects(bob.manager.decrypt(ctx, raw, generateIdentityKeyPair(sodium).publicKey), DecryptionError);
  });

  test('session state survives a persistence round-trip', async () => {
    const backend = new FakeBackend();
    let saved = '';
    const persist = (snap: unknown) => {
      saved = JSON.stringify(snap);
    };
    const bobIdentity = generateX25519KeyPair(sodium);
    const bobSigning = generateSigningKeyPair(sodium);
    const alice = makeDevice(backend, 'alice', 'alice-phone');
    let bob = makeDevice(backend, 'bob', 'bob-phone', {
      identity: bobIdentity,
      signing: bobSigning,
      store: new MemoryRatchetStore({}, persist),
    });
    await alice.manager.refreshPreKeys();
    await bob.manager.refreshPreKeys();
    assert.equal(await open(bob, alice, await send(alice, [bob], 'one')), 'one');
    const pending = await send(alice, [bob], 'in flight');
    assert.equal(await open(alice, bob, await send(bob, [alice], 'two')), 'two');

    // "Restart" Bob from the serialized snapshot.
    bob = makeDevice(backend, 'bob', 'bob-phone', {
      identity: bobIdentity,
      signing: bobSigning,
      store: new MemoryRatchetStore(JSON.parse(saved), persist),
    });
    assert.equal(await open(bob, alice, pending), 'in flight');
    assert.equal(await open(bob, alice, await send(alice, [bob], 'three')), 'three');
    assert.equal(await open(alice, bob, await send(bob, [alice], 'four')), 'four');
    // Prekey bookkeeping survived too: no new signing key publish or rotation.
    const status = await bob.manager.refreshPreKeys();
    assert.equal(status.signedPreKeyId, backend.devices.get('bob-phone')!.spk!.id);
  });

  test('broken session: undecryptable, archived, reset control message re-establishes it', async () => {
    const { alice, bob } = await pair();
    assert.equal(await open(bob, alice, await send(alice, [bob], 'a')), 'a');
    assert.equal(await open(alice, bob, await send(bob, [alice], 'b')), 'b');

    // Bob loses his session state (e.g. restored an old backup).
    await bob.store.write([{ ns: 'session', key: 'alice-phone', value: null }]);
    const lost = await send(alice, [bob], 'lost');
    await assert.rejects(open(bob, alice, lost), SessionNotFoundError);
    assert.deepEqual(bob.broken, ['alice-phone']);
    // Rate-limited: another failure doesn't ask for a second reset.
    await assert.rejects(open(bob, alice, await send(alice, [bob], 'lost too')), SessionNotFoundError);
    assert.equal(bob.broken.length, 1);

    // The app sends an encrypted reset to that device (new X3DH).
    const reset = await send(bob, [alice], sessionResetPlaintext());
    const plain = await open(alice, bob, reset);
    assert.deepEqual(parseControlPlaintext(plain), { op: 'reset' });
    assert.equal(parseControlPlaintext('{"t":"text","body":"{\\"t\\":\\"_vero.session\\"}"}'), null);

    // Alice now uses the new session; Bob decrypts again.
    assert.equal(await open(bob, alice, await send(alice, [bob], 'back')), 'back');
    assert.equal(await open(alice, bob, await send(bob, [alice], 'yes')), 'yes');
  });

  test('X3DH message for a one-time prekey we no longer have is reported as broken', async () => {
    const { alice, bob } = await pair();
    const m = await send(alice, [bob], 'hello');
    const o = parseSlot(sodium, parseAnyEnvelope(m.raw).k['bob-phone']).p!.o!;
    await bob.store.write([{ ns: 'opk', key: String(o), value: null }]);
    await assert.rejects(open(bob, alice, m), PreKeyNotFoundError);
    assert.deepEqual(bob.broken, ['alice-phone']);
  });

  test('signed prekeys rotate weekly; old ones decrypt in-flight X3DH messages until retired', async () => {
    const clock = { now: Date.now() };
    const backend = new FakeBackend();
    const alice = makeDevice(backend, 'alice', 'alice-phone', { clock });
    const bob = makeDevice(backend, 'bob', 'bob-phone', { clock });
    await alice.manager.refreshPreKeys();
    const first = await bob.manager.refreshPreKeys();
    const inFlight = await send(alice, [bob], 'sent before rotation');

    clock.now += SIGNED_PREKEY_ROTATE_MS + 1000;
    const second = await bob.manager.refreshPreKeys();
    assert.notEqual(second.signedPreKeyId, first.signedPreKeyId);
    assert.equal(backend.devices.get('bob-phone')!.spk!.id, second.signedPreKeyId);
    assert.equal(await open(bob, alice, inFlight), 'sent before rotation');

    // A new initiator uses the new signed prekey.
    const carol = makeDevice(backend, 'carol', 'carol-phone', { clock });
    await carol.manager.refreshPreKeys();
    const c = await send(carol, [bob], 'hi');
    assert.equal(parseSlot(sodium, parseAnyEnvelope(c.raw).k['bob-phone']).p!.s, second.signedPreKeyId);
    assert.equal(await open(bob, carol, c), 'hi');

    // After the retention window the old signed prekey's private key is deleted.
    clock.now += SIGNED_PREKEY_RETAIN_MS + 1000;
    await bob.manager.refreshPreKeys();
    assert.equal(await bob.store.get('spk', String(first.signedPreKeyId)), null);
  });

  test('stories: v3 envelope split per user still decrypts for every audience device', async () => {
    const backend = new FakeBackend();
    const author = makeDevice(backend, 'alice', 'alice-phone');
    const authorLaptop = makeDevice(backend, 'alice', 'alice-laptop');
    const bob = makeDevice(backend, 'bob', 'bob-phone');
    const carol = makeDevice(backend, 'carol', 'carol-phone');
    for (const d of [author, authorLaptop, bob, carol]) await d.manager.refreshPreKeys();
    const devices: AudienceDevice[] = [author, authorLaptop, bob, carol].map((d) => ({
      ...ref(d),
      userId: d.userId,
    }));
    const storyId = nextId();
    const ctx = storyContext('alice', storyId, 'alice-phone');
    const raw = await author.manager.encrypt(ctx, '{"t":"story"}', devices);
    const split = splitStoryEnvelope(parseAnyEnvelope(raw), devices, 'alice');
    assert.deepEqual(Object.keys(split.recipientSlots).sort(), ['bob', 'carol']);

    const read = (d: Device, mine: Record<string, string> | null) =>
      d.manager.decrypt(ctx, JSON.stringify(assembleStoryEnvelope(split.storyCiphertext, mine)), author.identity.pub);
    // Someone else's slots don't work.
    await assert.rejects(read(carol, split.recipientSlots.bob), NotAddressedToDeviceError);
    assert.equal(await read(bob, split.recipientSlots.bob), '{"t":"story"}');
    assert.equal(await read(carol, split.recipientSlots.carol), '{"t":"story"}');
    assert.equal(await read(authorLaptop, null), '{"t":"story"}');
    assert.equal(await read(author, null), '{"t":"story"}'); // own device: local cache
    // Re-reading (every fetch of the tray) is served from the cache.
    assert.equal(await read(bob, split.recipientSlots.bob), '{"t":"story"}');
  });
});

// ── Storage helpers ──────────────────────────────────────────────────────────

describe('storage', () => {
  test('rows sealed at rest round-trip and cannot be swapped or tampered', () => {
    const key = sodium.randombytes_buf(32);
    const sealed = sealRow(sodium, key, 'session', 'dev-1', { a: 1 });
    assert.deepEqual(openRow(sodium, key, 'session', 'dev-1', sealed), { a: 1 });
    assert.throws(() => openRow(sodium, key, 'session', 'dev-2', sealed), DecryptionError);
    assert.throws(() => openRow(sodium, key, 'opk', 'dev-1', sealed), DecryptionError);
    assert.throws(() => openRow(sodium, sodium.randombytes_buf(32), 'session', 'dev-1', sealed), DecryptionError);
    const b = sodium.from_base64(sealed);
    b[b.length - 1] ^= 1;
    assert.throws(() => openRow(sodium, key, 'session', 'dev-1', sodium.to_base64(b)), DecryptionError);
  });

  test('memory store: atomic batches, expiry and snapshots', async () => {
    let now = 1000;
    const store: RatchetStore = new MemoryRatchetStore({}, undefined, () => now);
    await store.write([
      { ns: 'pt', key: 'a', value: 'x', expiresAt: 2000 },
      { ns: 'pt', key: 'b', value: 'y' },
      { ns: 'opk', key: '1', value: { id: 1 } },
    ]);
    assert.deepEqual((await store.keys('pt')).sort(), ['a', 'b']);
    now = 2500;
    assert.equal(await store.get('pt', 'a'), null);
    await store.write([{ ns: 'opk', key: '1', value: null }]);
    assert.equal(await store.get('opk', '1'), null);
    await store.purge(now);
    assert.deepEqual(await store.keys('pt'), ['b']);
  });

  test('SQLite store: sealed rows, atomic batches with tombstones, purge follows the messages table', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(':memory:');
    const db: MinimalSqlDb = {
      execAsync: async (sql) => void raw.exec(sql),
      runAsync: async (sql, params) => raw.prepare(sql).run(...params),
      getFirstAsync: async <T>(sql: string, params: (string | number | null)[]) =>
        ((raw.prepare(sql).get(...params) as T) ?? null),
      getAllAsync: async <T>(sql: string, params: (string | number | null)[]) => raw.prepare(sql).all(...params) as T[],
    };
    raw.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, deleted_at TEXT, expires_at TEXT)');
    let now = Date.now();
    const key = sodium.randombytes_buf(32);
    const store = new SqliteRatchetStore(sodium, async () => db, key, () => now);

    await store.write([
      { ns: 'session', key: 'dev-1', value: { secret: 'state' } },
      { ns: 'opk', key: '5', value: { id: 5 } },
      { ns: 'pt', key: `${CONV}|m-live|dev-1`, value: 'kept', ref: 'm-live' },
      { ns: 'pt', key: `${CONV}|m-deleted|dev-1`, value: 'gone', ref: 'm-deleted' },
      { ns: 'pt', key: `${CONV}|m-reaction|dev-1`, value: 'orphan', ref: 'm-reaction' },
      { ns: 'pt', key: `story:alice|s1|dev-1`, value: 'story', ref: 's1', expiresAt: now + 1000 },
    ]);
    raw.exec(`INSERT INTO messages VALUES ('m-live', NULL, NULL), ('m-deleted', '2020-01-01', NULL)`);
    // Values are sealed at rest.
    const stored = raw.prepare(`SELECT v FROM ${RATCHET_TABLE} WHERE ns = 'session'`).get() as { v: string };
    assert.ok(!stored.v.includes('state'));
    assert.deepEqual(await store.get('session', 'dev-1'), { secret: 'state' });
    // A different storage key can't read the rows.
    await assert.rejects(new SqliteRatchetStore(sodium, async () => db, sodium.randombytes_buf(32)).get('session', 'dev-1'));

    // Deleting inside a batch writes a tombstone in the same statement.
    await store.write([
      { ns: 'session', key: 'dev-1', value: { secret: 'next' } },
      { ns: 'opk', key: '5', value: null },
    ]);
    assert.equal(await store.get('opk', '5'), null);
    assert.deepEqual(await store.keys('opk'), []);
    assert.deepEqual(await store.get('session', 'dev-1'), { secret: 'next' });

    now += 11 * 60 * 1000;
    await store.purge(now);
    assert.equal(await store.get('pt', `${CONV}|m-live|dev-1`), 'kept');
    assert.equal(await store.get('pt', `${CONV}|m-deleted|dev-1`), null);
    assert.equal(await store.get('pt', `${CONV}|m-reaction|dev-1`), null);
    assert.equal(await store.get('pt', 'story:alice|s1|dev-1'), null);
    const count = raw.prepare(`SELECT count(*) AS n FROM ${RATCHET_TABLE}`).get() as { n: number };
    assert.equal(count.n, 2, 'tombstones and expired rows are removed');
    await store.wipe();
    assert.equal(await store.get('session', 'dev-1'), null);

    // And a full conversation runs on it.
    const backend = new FakeBackend();
    const alice = makeDevice(backend, 'alice', 'alice-phone');
    const bob = makeDevice(backend, 'bob', 'bob-phone', { store: new SqliteRatchetStore(sodium, async () => db, key) });
    await alice.manager.refreshPreKeys();
    await bob.manager.refreshPreKeys();
    for (let i = 0; i < 4; i++) {
      assert.equal(await open(bob, alice, await send(alice, [bob], `a${i}`)), `a${i}`);
      assert.equal(await open(alice, bob, await send(bob, [alice], `b${i}`)), `b${i}`);
    }
  });

  test('bundle rows from claim_prekey_bundle are parsed defensively', () => {
    assert.equal(bundleFromRow(null), null);
    assert.equal(bundleFromRow({ device_id: 'd', identity_public_key: 'k' }), null);
    const b = bundleFromRow({
      device_id: 'd',
      user_id: 'u',
      identity_public_key: 'ik',
      signing_public_key: 'sk',
      identity_signature: 'sig',
      signed_prekey_id: 3,
      signed_prekey: 'spk',
      signed_prekey_signature: 'spks',
      one_time_prekey_id: null,
      one_time_prekey: null,
    });
    assert.equal(b!.oneTimePreKey, null);
    assert.equal(b!.signedPreKeyId, 3);
  });

  test('keyed mutex serialises per key and runs different keys concurrently', async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    const task = (key: string, name: string, ms: number) =>
      m.run(key, async () => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${name}`);
      });
    await Promise.all([task('a', 'a1', 20), task('a', 'a2', 1), task('b', 'b1', 5)]);
    assert.ok(log.indexOf('end a1') < log.indexOf('start a2'));
    assert.ok(log.indexOf('start b1') < log.indexOf('end a1'));
  });
});
