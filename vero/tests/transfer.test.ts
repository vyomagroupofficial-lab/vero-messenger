import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sodiumModule from 'libsodium-wrappers';
import { Sodium, DecryptionError } from '../src/core/crypto/primitives';
import {
  generateEphemeralKeyPair,
  generateQrSecret,
  deriveClaimKey,
  claimKeyHash,
  deriveTransferKey,
  encryptChunk,
  decryptChunk,
  encryptPayload,
  decryptPayload,
} from '../src/features/transfer/transferCrypto';
import {
  encodeSnapshot,
  decodeSnapshot,
  buildImportStatement,
  SnapshotError,
  TransferSnapshot,
} from '../src/features/transfer/snapshot';

let sodium: Sodium;
before(async () => {
  await sodiumModule.ready;
  sodium = sodiumModule as unknown as Sodium;
});

const TID = '3f2b8c1e-9d4a-4b7e-8f00-0123456789ab';

function session() {
  const receiver = generateEphemeralKeyPair(sodium);
  const sender = generateEphemeralKeyPair(sodium);
  const secret = generateQrSecret(sodium);
  const common = { transferId: TID, secret, receiverPublicKey: receiver.publicKey, senderPublicKey: sender.publicKey };
  const senderKey = deriveTransferKey(sodium, { ...common, mySecretKey: sender.secretKey, theirPublicKey: receiver.publicKey });
  const receiverKey = deriveTransferKey(sodium, { ...common, mySecretKey: receiver.secretKey, theirPublicKey: sender.publicKey });
  return { receiver, sender, secret, common, senderKey, receiverKey };
}

test('both sides derive the same key; it depends on the QR secret and the transfer id', () => {
  const s = session();
  assert.deepEqual(s.senderKey, s.receiverKey);
  const otherSecret = deriveTransferKey(sodium, {
    ...s.common,
    secret: generateQrSecret(sodium),
    mySecretKey: s.sender.secretKey,
    theirPublicKey: s.receiver.publicKey,
  });
  assert.notDeepEqual(otherSecret, s.senderKey, 'server-side forgery without the QR secret yields another key');
  const otherId = deriveTransferKey(sodium, {
    ...s.common,
    transferId: '00000000-0000-4000-8000-000000000000',
    mySecretKey: s.sender.secretKey,
    theirPublicKey: s.receiver.publicKey,
  });
  assert.notDeepEqual(otherId, s.senderKey);
});

test('an observer with the QR secret but no ephemeral private key derives a different key', () => {
  const s = session();
  const eve = generateEphemeralKeyPair(sodium);
  const eveKey = deriveTransferKey(sodium, { ...s.common, mySecretKey: eve.secretKey, theirPublicKey: s.sender.publicKey });
  assert.notDeepEqual(eveKey, s.receiverKey);
});

test('payload round-trip across multiple chunks', () => {
  const s = session();
  const payload = sodium.randombytes_buf(10_000);
  const chunks = encryptPayload(sodium, s.senderKey, TID, payload, 4096);
  assert.equal(chunks.length, 3);
  assert.deepEqual(decryptPayload(sodium, s.receiverKey, TID, chunks), payload);
  // empty payload still produces one authenticated chunk
  const empty = encryptPayload(sodium, s.senderKey, TID, new Uint8Array(0));
  assert.equal(empty.length, 1);
  assert.equal(decryptPayload(sodium, s.receiverKey, TID, empty).length, 0);
});

test('tampering, reordering, truncation, extension and wrong keys are detected', () => {
  const s = session();
  const payload = sodium.randombytes_buf(9000);
  const chunks = encryptPayload(sodium, s.senderKey, TID, payload, 4096);

  // bit flip
  const raw = sodium.from_base64(chunks[1]);
  raw[raw.length - 5] ^= 1;
  const flipped = [...chunks];
  flipped[1] = sodium.to_base64(raw);
  assert.throws(() => decryptPayload(sodium, s.receiverKey, TID, flipped), DecryptionError);

  // reorder
  assert.throws(() => decryptPayload(sodium, s.receiverKey, TID, [chunks[1], chunks[0], chunks[2]]), DecryptionError);
  // truncation (server drops the last chunk and lies about the total)
  assert.throws(() => decryptPayload(sodium, s.receiverKey, TID, chunks.slice(0, 2)), DecryptionError);
  // extension (extra chunk appended)
  assert.throws(() => decryptPayload(sodium, s.receiverKey, TID, [...chunks, chunks[2]]), DecryptionError);
  // moved to another transfer id
  assert.throws(
    () => decryptPayload(sodium, s.receiverKey, '00000000-0000-4000-8000-000000000000', chunks),
    DecryptionError
  );
  // wrong key
  const other = session();
  assert.throws(() => decryptPayload(sodium, other.receiverKey, TID, chunks), DecryptionError);
  // garbage
  assert.throws(() => decryptChunk(sodium, s.receiverKey, TID, 0, 1, 'AAAA'), DecryptionError);
  // invalid positions
  assert.throws(() => encryptChunk(sodium, s.senderKey, TID, 3, 3, new Uint8Array(1)));
  assert.throws(() => encryptChunk(sodium, s.senderKey, TID, 0, 0, new Uint8Array(1)));
});

test('a low-order (all-zero) public key is rejected', () => {
  const s = session();
  assert.throws(
    () =>
      deriveTransferKey(sodium, {
        ...s.common,
        mySecretKey: s.receiver.secretKey,
        theirPublicKey: sodium.to_base64(new Uint8Array(32)),
      }),
    DecryptionError
  );
});

test('claim key is derived from the QR secret and its hash matches SHA-256 (server side)', () => {
  const secret = generateQrSecret(sodium);
  const claimKey = deriveClaimKey(sodium, secret);
  assert.match(claimKey, /^[0-9a-f]{64}$/);
  assert.notEqual(claimKey, sodium.to_hex(sodium.from_base64(secret)), 'the server never sees the raw secret');
  assert.equal(deriveClaimKey(sodium, secret), claimKey, 'deterministic');
  assert.equal(claimKeyHash(claimKey), createHash('sha256').update(claimKey, 'utf8').digest('hex'));
});

// ── Snapshot ──────────────────────────────────────────────────────────────────

const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const snapshot: TransferSnapshot = {
  v: 1,
  kind: 'full',
  userId: USER,
  createdAt: '2026-10-03T10:00:00.000Z',
  tables: {
    messages: { columns: ['id', 'content', 'message_type', 'is_own'], rows: [['m1', 'héllo 👋', 'text', 1]] },
    device_keys: { columns: ['device_id', 'user_id', 'public_key'], rows: [['d1', 'u1', 'pk']] },
  },
  settings: { readReceipts: false, defaultTimerSeconds: 3600 },
};

test('snapshot survives encrypt -> chunk -> decrypt -> decode', () => {
  const s = session();
  const chunks = encryptPayload(sodium, s.senderKey, TID, encodeSnapshot(sodium, snapshot), 64);
  assert.ok(chunks.length > 1);
  const decoded = decodeSnapshot(sodium, decryptPayload(sodium, s.receiverKey, TID, chunks), USER);
  assert.deepEqual(decoded, snapshot);
});

test('snapshot validation rejects foreign accounts, bad identifiers and odd values', () => {
  const enc = (o: unknown) => sodium.from_string(JSON.stringify(o));
  assert.throws(() => decodeSnapshot(sodium, encodeSnapshot(sodium, snapshot), 'someone-else'), SnapshotError);
  assert.throws(() => decodeSnapshot(sodium, enc({ ...snapshot, v: 2 }), USER), SnapshotError);
  assert.throws(() => decodeSnapshot(sodium, sodium.from_string('{nope'), USER), SnapshotError);
  assert.throws(
    () =>
      decodeSnapshot(sodium, enc({ ...snapshot, tables: { messages: { columns: ['id', 'x"; DROP TABLE messages; --'], rows: [] } } }), USER),
    SnapshotError
  );
  assert.throws(
    () => decodeSnapshot(sodium, enc({ ...snapshot, tables: { messages: { columns: ['id'], rows: [[{ evil: 1 }]] } } }), USER),
    SnapshotError
  );
  assert.throws(
    () => decodeSnapshot(sodium, enc({ ...snapshot, tables: { messages: { columns: ['id', 'a'], rows: [['x']] } } }), USER),
    SnapshotError
  );
  // unknown tables (e.g. key material) are dropped, never imported
  const d = decodeSnapshot(sodium, enc({ ...snapshot, tables: { ...snapshot.tables, ratchet_sessions: { columns: ['id'], rows: [['s']] } } }), USER);
  assert.deepEqual(Object.keys(d.tables).sort(), ['device_keys', 'messages']);
});

test('import statements use only local columns and the right conflict policy', () => {
  const m = buildImportStatement('messages', snapshot.tables.messages, ['id', 'content', 'message_type'])!;
  assert.deepEqual(m.columnIndexes, [0, 1, 2]);
  assert.match(m.sql, /^INSERT INTO "messages" \("id", "content", "message_type"\)/);
  assert.match(m.sql, /ON CONFLICT\("id"\) DO UPDATE SET .* WHERE "messages"\."message_type" = 'unavailable'$/);
  const k = buildImportStatement('device_keys', snapshot.tables.device_keys, ['device_id', 'user_id', 'public_key', 'revoked_at'])!;
  assert.match(k.sql, /^INSERT OR IGNORE INTO "device_keys"/, 'existing key pins are never overwritten');
  assert.equal(buildImportStatement('messages', snapshot.tables.messages, ['content']), null, 'no key column locally');
  assert.equal(buildImportStatement('secrets', { columns: ['id'], rows: [] }, ['id']), null);
});
