import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProfileQr,
  buildProfileWebLink,
  buildLinkQr,
  buildTransferQr,
  parseQrPayload,
} from '../src/features/linking/qrPayloads';

const ID = '3f2b8c1e-9d4a-4b7e-8f00-0123456789ab';
const SECRET = 'A'.repeat(42) + 'g';
const PUB = 'B'.repeat(42) + 'Q';
const FP = '123456789012345678901234567890';

test('profile QR round-trips with and without fingerprint', () => {
  assert.equal(buildProfileQr('Alice_1'), 'vero://u/alice_1');
  assert.deepEqual(parseQrPayload(buildProfileQr('alice_1')), { kind: 'profile', username: 'alice_1' });
  assert.deepEqual(parseQrPayload(buildProfileQr('alice_1', FP)), { kind: 'profile', username: 'alice_1', fingerprint: FP });
});

test('https fallback links and @handles parse as profiles', () => {
  const link = buildProfileWebLink('https://chat.example.com/', 'bob_b');
  assert.equal(link, 'https://chat.example.com/u/bob_b');
  assert.deepEqual(parseQrPayload(link), { kind: 'profile', username: 'bob_b' });
  assert.deepEqual(parseQrPayload('https://chat.example.com:8443/u/Bob_B/?fp=' + FP), {
    kind: 'profile',
    username: 'bob_b',
    fingerprint: FP,
  });
  assert.deepEqual(parseQrPayload('@Carol_C'), { kind: 'profile', username: 'carol_c' });
});

test('malformed profile payloads are rejected', () => {
  for (const bad of [
    'vero://u/ab', // too short
    'vero://u/alice!',
    'vero://u/alice/extra',
    'vero://x/alice',
    'vero://u/alice?fp=123', // corrupted fingerprint must not be silently dropped
    'http://chat.example.com/u/alice', // plain http
    'https://chat.example.com/profile/alice',
    'javascript:alert(1)',
    '',
    'a'.repeat(600),
  ]) {
    assert.equal(parseQrPayload(bad), null, bad);
  }
  assert.throws(() => buildProfileQr('no spaces allowed'));
  assert.throws(() => buildProfileQr('alice', '12'));
});

test('link and transfer QR round-trip', () => {
  const link = buildLinkQr({ linkId: ID.toUpperCase(), secret: SECRET, publicKey: PUB });
  assert.equal(link, `vero-link:${ID}:${SECRET}:${PUB}`);
  assert.deepEqual(parseQrPayload(link), { kind: 'link', linkId: ID, secret: SECRET, publicKey: PUB });
  const xfer = buildTransferQr({ transferId: ID, secret: SECRET, publicKey: PUB });
  assert.deepEqual(parseQrPayload(xfer), { kind: 'transfer', transferId: ID, secret: SECRET, publicKey: PUB });
});

test('link/transfer payload validation', () => {
  for (const bad of [
    `vero-link:not-a-uuid:${SECRET}:${PUB}`,
    `vero-link:${ID}:${SECRET.slice(1)}:${PUB}`, // 42 chars
    `vero-link:${ID}:${SECRET}:${PUB}=`, // padded
    `vero-link:${ID}:${SECRET}:${PUB}:extra`,
    `vero-link:${ID}:${SECRET}`,
    `vero-link:${ID}:${SECRET}:${SECRET}`, // secret reused as key
    `vero-link:${ID}:${SECRET.replace('A', '+')}:${PUB}`, // non-url-safe base64
    `vero-transfer:${ID}:${SECRET}:${PUB.replace('B', '/')}`,
  ]) {
    assert.equal(parseQrPayload(bad), null, bad);
  }
  assert.throws(() => buildLinkQr({ linkId: 'x', secret: SECRET, publicKey: PUB }));
  assert.throws(() => buildTransferQr({ transferId: ID, secret: 'short', publicKey: PUB }));
});
