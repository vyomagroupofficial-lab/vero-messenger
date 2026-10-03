import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProfileQr,
  buildProfileWebLink,
  buildLinkQr,
  buildTransferQr,
  parseQrPayload,
} from '../src/features/linking/qrPayloads';
import { qrMatrix, qrPath } from '../src/features/linking/qrMatrix';
import { readFileSync, existsSync } from 'node:fs';

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

// ── QR rendering ──────────────────────────────────────────────────────────────

test('qrMatrix produces a valid symbol with finder patterns', () => {
  const m = qrMatrix(buildLinkQr({ linkId: ID, secret: SECRET, publicKey: PUB }));
  assert.equal((m.size - 17) % 4, 0, 'size = 17 + 4 * version');
  assert.equal(m.modules.length, m.size * m.size);
  const at = (x: number, y: number) => m.modules[y * m.size + x];
  for (let i = 0; i < 7; i++) {
    assert.equal(at(i, 0), 1);
    assert.equal(at(0, i), 1);
    assert.equal(at(m.size - 1 - i, 0), 1);
  }
  assert.equal(at(1, 1), 0);
  assert.equal(at(3, 3), 1);
  assert.match(qrPath(m), /^M4 4h7v1h-7z/);
});

// zxing-wasm ships with expo-camera (web barcode scanning); decode what we render.
const ZXING_WASM = 'node_modules/zxing-wasm/dist/reader/zxing_reader.wasm';
test(
  'rendered QR codes decode back to the payload (zxing)',
  { skip: existsSync(ZXING_WASM) ? false : 'zxing-wasm not installed' },
  async () => {
    const { prepareZXingModule, readBarcodes } = await import('zxing-wasm/reader');
    const wasm = readFileSync(ZXING_WASM);
    await prepareZXingModule({
      overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer },
      fireImmediately: true,
    });
    for (const text of [buildLinkQr({ linkId: ID, secret: SECRET, publicKey: PUB }), buildProfileQr('alice_1', FP)]) {
      const m = qrMatrix(text);
      const scale = 4;
      const margin = 4;
      const dim = (m.size + margin * 2) * scale;
      const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
      for (let y = 0; y < m.size; y++) {
        for (let x = 0; x < m.size; x++) {
          if (!m.modules[y * m.size + x]) continue;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const o = (((y + margin) * scale + dy) * dim + (x + margin) * scale + dx) * 4;
              data[o] = data[o + 1] = data[o + 2] = 0;
            }
          }
        }
      }
      const image = { data, width: dim, height: dim, colorSpace: 'srgb' } as unknown as ImageData;
      const results = await readBarcodes(image, { formats: ['QRCode'] });
      assert.equal(results[0]?.text, text);
      assert.deepEqual(parseQrPayload(results[0].text), parseQrPayload(text));
    }
  }
);
