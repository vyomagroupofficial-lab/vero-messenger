import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import sodiumModule from 'libsodium-wrappers';
import {
  Sodium,
  generateIdentityKeyPair,
  encryptEnvelope,
  decryptEnvelope,
  serializeEnvelope,
  parseEnvelope,
  encryptBlob,
  decryptBlob,
  safetyNumber,
  partyFingerprint,
  NotAddressedToDeviceError,
  DecryptionError,
  EnvelopeContext,
} from '../src/core/crypto/primitives';

let sodium: Sodium;
before(async () => {
  await sodiumModule.ready;
  sodium = sodiumModule as unknown as Sodium;
});

const ctx: EnvelopeContext = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  messageId: '22222222-2222-4222-8222-222222222222',
  senderDeviceId: 'alice-phone',
};

function setup() {
  const alicePhone = generateIdentityKeyPair(sodium);
  const aliceLaptop = generateIdentityKeyPair(sodium);
  const bobPhone = generateIdentityKeyPair(sodium);
  const carol = generateIdentityKeyPair(sodium);
  const recipients = [
    { deviceId: 'alice-phone', publicKey: alicePhone.publicKey },
    { deviceId: 'alice-laptop', publicKey: aliceLaptop.publicKey },
    { deviceId: 'bob-phone', publicKey: bobPhone.publicKey },
  ];
  return { alicePhone, aliceLaptop, bobPhone, carol, recipients };
}

test('every addressed device (including sender devices) can decrypt', () => {
  const { alicePhone, aliceLaptop, bobPhone, recipients } = setup();
  const plaintext = JSON.stringify({ t: 'text', body: 'Top secret 🔒' });
  const env = encryptEnvelope(sodium, plaintext, ctx, alicePhone.secretKey, recipients);
  const wire = serializeEnvelope(env);

  assert.ok(!wire.includes('Top secret'), 'no plaintext on the wire');
  for (const [deviceId, kp] of [
    ['alice-phone', alicePhone],
    ['alice-laptop', aliceLaptop],
    ['bob-phone', bobPhone],
  ] as const) {
    const out = decryptEnvelope(sodium, parseEnvelope(wire), ctx, deviceId, kp.secretKey, alicePhone.publicKey);
    assert.equal(out, plaintext, `${deviceId} decrypts`);
  }
});

test('a device without a key slot cannot decrypt', () => {
  const { alicePhone, carol, recipients } = setup();
  const env = encryptEnvelope(sodium, 'hi', ctx, alicePhone.secretKey, recipients);
  assert.throws(
    () => decryptEnvelope(sodium, env, ctx, 'carol', carol.secretKey, alicePhone.publicKey),
    NotAddressedToDeviceError
  );
});

test('a forged sender key is rejected', () => {
  const { alicePhone, bobPhone, carol, recipients } = setup();
  const env = encryptEnvelope(sodium, 'hi', ctx, alicePhone.secretKey, recipients);
  assert.throws(
    () => decryptEnvelope(sodium, env, ctx, 'bob-phone', bobPhone.secretKey, carol.publicKey),
    DecryptionError
  );
});

test('replaying an envelope into another message/conversation fails', () => {
  const { alicePhone, bobPhone, recipients } = setup();
  const env = encryptEnvelope(sodium, 'hi', ctx, alicePhone.secretKey, recipients);
  for (const other of [
    { ...ctx, messageId: '33333333-3333-4333-8333-333333333333' },
    { ...ctx, conversationId: '44444444-4444-4444-8444-444444444444' },
    { ...ctx, senderDeviceId: 'mallory' },
  ]) {
    assert.throws(
      () => decryptEnvelope(sodium, env, other, 'bob-phone', bobPhone.secretKey, alicePhone.publicKey),
      DecryptionError
    );
  }
});

test('tampered ciphertext is rejected', () => {
  const { alicePhone, bobPhone, recipients } = setup();
  const env = encryptEnvelope(sodium, 'hello world', ctx, alicePhone.secretKey, recipients);
  const body = sodium.from_base64(env.c);
  body[0] ^= 0xff;
  const tampered = { ...env, c: sodium.to_base64(body) };
  assert.throws(
    () => decryptEnvelope(sodium, tampered, ctx, 'bob-phone', bobPhone.secretKey, alicePhone.publicKey),
    DecryptionError
  );
});

test('parseEnvelope rejects garbage and old versions', () => {
  assert.throws(() => parseEnvelope('not json'), DecryptionError);
  assert.throws(() => parseEnvelope(JSON.stringify({ v: 1, ciphertext: 'x' })), DecryptionError);
});

test('media blobs round-trip and detect corruption', () => {
  const plain = sodium.randombytes_buf(10_000);
  const blob = encryptBlob(sodium, plain);
  assert.deepEqual(decryptBlob(sodium, blob.ciphertext, blob.key, blob.nonce, blob.hash), plain);

  const corrupted = new Uint8Array(blob.ciphertext);
  corrupted[42] ^= 1;
  assert.throws(() => decryptBlob(sodium, corrupted, blob.key, blob.nonce, blob.hash), DecryptionError);
  assert.throws(() => decryptBlob(sodium, corrupted, blob.key, blob.nonce), DecryptionError);
});

test('safety number is symmetric, 60 digits, and changes when a device is added', () => {
  const a = generateIdentityKeyPair(sodium);
  const a2 = generateIdentityKeyPair(sodium);
  const b = generateIdentityKeyPair(sodium);
  const alice = { userId: 'alice', keys: [a.publicKey] };
  const bob = { userId: 'bob', keys: [b.publicKey] };

  const s1 = safetyNumber(sodium, alice, bob);
  const s2 = safetyNumber(sodium, bob, alice);
  assert.equal(s1, s2);
  assert.match(s1, /^(\d{5} ){11}\d{5}$/);

  const withNewDevice = safetyNumber(sodium, { userId: 'alice', keys: [a.publicKey, a2.publicKey] }, bob);
  assert.notEqual(withNewDevice, s1);

  // key order must not matter
  assert.equal(
    partyFingerprint(sodium, 'alice', [a.publicKey, a2.publicKey]),
    partyFingerprint(sodium, 'alice', [a2.publicKey, a.publicKey])
  );
});
