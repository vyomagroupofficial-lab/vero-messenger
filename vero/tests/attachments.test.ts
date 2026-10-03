import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import sodiumModule from 'libsodium-wrappers';
import {
  AttachmentDecryptor,
  chunkCount,
  ChunkReader,
  ChunkWriter,
  decryptAttachment,
  decryptStream,
  encryptAttachment,
  encryptedSizeFor,
  encryptStream,
  isValidChunkSize,
  STREAM_ABYTES,
} from '../src/core/crypto/attachments';
import { DecryptionError, encryptBlob, type Sodium } from '../src/core/crypto/primitives';
import { exceedsUploadLimit, MAX_ENCRYPTED_BYTES, MediaTooLargeError } from '../src/features/media/limits';

let sodium: Sodium;
before(async () => {
  await sodiumModule.ready;
  sodium = sodiumModule as unknown as Sodium;
});

const CS = 1024; // small chunks keep the tests fast but exercise many chunks

function randomBytes(n: number): Uint8Array {
  return n === 0 ? new Uint8Array(0) : sodium.randombytes_buf(n);
}

function chunksOf(ct: Uint8Array, chunkSize = CS): Uint8Array[] {
  const size = chunkSize + STREAM_ABYTES;
  const out: Uint8Array[] = [];
  for (let o = 0; o < ct.length; o += size) out.push(ct.slice(o, o + size));
  return out;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const hashOf = (b: Uint8Array) => sodium.to_hex(sodium.crypto_generichash(32, b, null));

describe('chunked attachment encryption (format v2)', () => {
  test('round-trips every interesting size', () => {
    for (const n of [0, 1, CS - 1, CS, CS + 1, 3 * CS, 3 * CS + 17, 10 * CS + 5]) {
      const plain = randomBytes(n);
      const enc = encryptAttachment(sodium, plain, CS);
      assert.equal(enc.ciphertext.length, encryptedSizeFor(n, CS), `size for ${n}`);
      assert.equal(enc.encryptedSize, enc.ciphertext.length);
      assert.equal(enc.plainSize, n);
      assert.equal(enc.hash, hashOf(enc.ciphertext), 'hash covers the whole ciphertext');
      const out = decryptAttachment(sodium, enc.ciphertext, enc.key, enc.header, CS, enc.hash);
      assert.deepEqual(out, plain, `round-trip ${n}`);
    }
  });

  test('chunk arithmetic', () => {
    assert.equal(chunkCount(0, CS), 1, 'empty file is one (final) chunk');
    assert.equal(chunkCount(CS, CS), 1);
    assert.equal(chunkCount(CS + 1, CS), 2);
    assert.equal(encryptedSizeFor(0, CS), STREAM_ABYTES);
    assert.equal(encryptedSizeFor(2 * CS, CS), 2 * CS + 2 * STREAM_ABYTES);
    assert.ok(isValidChunkSize(65536));
    for (const bad of [0, 100, 1.5, '65536', 8 * 1024 * 1024, null]) assert.ok(!isValidChunkSize(bad));
  });

  test('every encryption uses a fresh key and header', () => {
    const plain = randomBytes(100);
    const a = encryptAttachment(sodium, plain, CS);
    const b = encryptAttachment(sodium, plain, CS);
    assert.notEqual(a.key, b.key);
    assert.notEqual(a.header, b.header);
    assert.notDeepEqual(a.ciphertext, b.ciphertext);
  });

  test('truncation is detected (dropped final chunk, cut chunk, empty)', () => {
    const enc = encryptAttachment(sodium, randomBytes(4 * CS + 10), CS);
    const parts = chunksOf(enc.ciphertext);
    const cases: [string, Uint8Array][] = [
      ['drop last chunk', join(parts.slice(0, -1))],
      ['drop last two chunks', join(parts.slice(0, -2))],
      ['cut inside last chunk', enc.ciphertext.slice(0, enc.ciphertext.length - 5)],
      ['cut inside a middle chunk', enc.ciphertext.slice(0, CS + STREAM_ABYTES + 100)],
      ['nothing', new Uint8Array(0)],
    ];
    for (const [name, ct] of cases) {
      // Without the hash, the stream structure alone must catch it.
      assert.throws(() => decryptAttachment(sodium, ct, enc.key, enc.header, CS), DecryptionError, name);
      assert.throws(() => decryptAttachment(sodium, ct, enc.key, enc.header, CS, enc.hash), DecryptionError, name);
    }
  });

  test('a file that ends exactly on a chunk boundary still needs its final tag', () => {
    const enc = encryptAttachment(sodium, randomBytes(3 * CS), CS);
    const parts = chunksOf(enc.ciphertext);
    assert.equal(parts.length, 3);
    assert.throws(() => decryptAttachment(sodium, join(parts.slice(0, 2)), enc.key, enc.header, CS), /truncated/);
  });

  test('reordered or duplicated chunks fail', () => {
    const enc = encryptAttachment(sodium, randomBytes(4 * CS + 10), CS);
    const [a, b, c, d, e] = chunksOf(enc.ciphertext);
    for (const [name, parts] of [
      ['swap', [b, a, c, d, e]],
      ['swap middle', [a, c, b, d, e]],
      ['duplicate', [a, a, b, c, d, e]],
      ['replay first as last', [a, b, c, d, a]],
    ] as const) {
      assert.throws(() => decryptAttachment(sodium, join([...parts]), enc.key, enc.header, CS), DecryptionError, name);
    }
  });

  test('data appended after the final chunk is rejected', () => {
    const extra = encryptAttachment(sodium, randomBytes(10), CS).ciphertext;
    // Final chunk is full-size: the extra bytes arrive as a separate chunk.
    const aligned = encryptAttachment(sodium, randomBytes(CS), CS);
    assert.throws(
      () => decryptAttachment(sodium, join([aligned.ciphertext, extra]), aligned.key, aligned.header, CS),
      /after the end/
    );
    // Final chunk is short: the extra bytes are glued onto it and break its MAC.
    const short = encryptAttachment(sodium, randomBytes(CS + 3), CS);
    assert.throws(
      () => decryptAttachment(sodium, join([short.ciphertext, extra]), short.key, short.header, CS),
      DecryptionError
    );
  });

  test('chunks from another file (same key size, different stream) fail', () => {
    const one = encryptAttachment(sodium, randomBytes(2 * CS), CS);
    const two = encryptAttachment(sodium, randomBytes(2 * CS), CS);
    const mixed = join([chunksOf(one.ciphertext)[0], chunksOf(two.ciphertext)[1]]);
    assert.throws(() => decryptAttachment(sodium, mixed, one.key, one.header, CS), DecryptionError);
  });

  test('flipping any byte fails authentication; wrong key, header or chunk size fail', () => {
    const plain = randomBytes(2 * CS + 7);
    const enc = encryptAttachment(sodium, plain, CS);
    for (const pos of [0, 1, 17, CS, CS + STREAM_ABYTES, enc.ciphertext.length - 1]) {
      const bad = enc.ciphertext.slice();
      bad[pos] ^= 0x01;
      assert.throws(() => decryptAttachment(sodium, bad, enc.key, enc.header, CS), DecryptionError, `flip ${pos}`);
    }
    const other = encryptAttachment(sodium, plain, CS);
    assert.throws(() => decryptAttachment(sodium, enc.ciphertext, other.key, enc.header, CS), DecryptionError);
    assert.throws(() => decryptAttachment(sodium, enc.ciphertext, enc.key, other.header, CS), DecryptionError);
    assert.throws(() => decryptAttachment(sodium, enc.ciphertext, enc.key, enc.header, 2 * CS), DecryptionError);
    assert.throws(() => decryptAttachment(sodium, enc.ciphertext, 'not-a-key', enc.header, CS), /Malformed/);
  });

  test('hash mismatch is reported even when the stream itself is intact', () => {
    const enc = encryptAttachment(sodium, randomBytes(100), CS);
    assert.throws(
      () => decryptAttachment(sodium, enc.ciphertext, enc.key, enc.header, CS, 'ab'.repeat(32)),
      /integrity/
    );
  });

  test('a failed decryptor stays failed', () => {
    const enc = encryptAttachment(sodium, randomBytes(3 * CS), CS);
    const dec = new AttachmentDecryptor(sodium, enc.key, enc.header, CS);
    const parts = chunksOf(enc.ciphertext);
    assert.throws(() => dec.pull(parts[1]));
    assert.throws(() => dec.pull(parts[0]), DecryptionError, 'no recovery after a failure');
    assert.throws(() => dec.finish(), DecryptionError);
  });

  test('format v1 (single-shot) attachments still decrypt through the v1 path', async () => {
    const { decryptBlob } = await import('../src/core/crypto/primitives');
    const plain = randomBytes(5000);
    const old = encryptBlob(sodium, plain);
    assert.deepEqual(decryptBlob(sodium, old.ciphertext, old.key, old.nonce, old.hash), plain);
  });
});

describe('streaming drivers (what runs against FileHandles on device)', () => {
  function memReader(src: Uint8Array): ChunkReader & { reads: number[] } {
    let pos = 0;
    const reads: number[] = [];
    return {
      reads,
      read(n) {
        reads.push(n);
        const out = src.slice(pos, pos + n);
        pos += out.length;
        return out;
      },
    };
  }
  function memWriter(): ChunkWriter & { parts: Uint8Array[]; all(): Uint8Array } {
    const parts: Uint8Array[] = [];
    return { parts, write: (b) => parts.push(b.slice()), all: () => join(parts) };
  }

  test('stream encrypt -> stream decrypt round-trips with bounded reads', async () => {
    for (const n of [0, 5, CS, 7 * CS + 3]) {
      const plain = randomBytes(n);
      const reader = memReader(plain);
      const w = memWriter();
      const progress: number[] = [];
      const res = await encryptStream(sodium, reader, w, n, CS, { onChunk: (f) => void progress.push(f), yieldEvery: 2 });
      assert.ok(reader.reads.every((r) => r <= CS), 'never reads more than one chunk');
      assert.equal(progress[progress.length - 1], 1);
      const ct = w.all();
      assert.equal(ct.length, res.encryptedSize);
      assert.equal(res.hash, hashOf(ct));
      // Interoperable with the in-memory decryptor ...
      assert.deepEqual(decryptAttachment(sodium, ct, res.key, res.header, CS, res.hash), plain);
      // ... and with the streaming one.
      const out = memWriter();
      const cr = memReader(ct);
      await decryptStream(sodium, cr, out, ct.length, { key: res.key, header: res.header, chunkSize: CS, hash: res.hash });
      assert.ok(cr.reads.every((r) => r <= CS + STREAM_ABYTES));
      assert.deepEqual(out.all(), plain);
    }
  });

  test('a source that shrinks while encrypting is an error', async () => {
    const plain = randomBytes(2 * CS);
    await assert.rejects(
      encryptStream(sodium, memReader(plain), memWriter(), 3 * CS, CS),
      /changed while it was being encrypted/
    );
  });

  test('stream decrypt rejects truncated / reordered input', async () => {
    const plain = randomBytes(3 * CS + 1);
    const enc = encryptAttachment(sodium, plain, CS);
    const params = { key: enc.key, header: enc.header, chunkSize: CS, hash: enc.hash };
    const short = enc.ciphertext.slice(0, 2 * (CS + STREAM_ABYTES));
    await assert.rejects(decryptStream(sodium, memReader(short), memWriter(), short.length, params), DecryptionError);
    // Reader returns less than the declared size (download cut off).
    await assert.rejects(
      decryptStream(sodium, memReader(short), memWriter(), enc.ciphertext.length, params),
      /truncated/
    );
    const [a, b, c, d] = chunksOf(enc.ciphertext);
    const swapped = join([a, c, b, d]);
    await assert.rejects(decryptStream(sodium, memReader(swapped), memWriter(), swapped.length, params), DecryptionError);
  });
});

describe('upload limit', () => {
  test('the 50 MB cap applies to the ciphertext and has a friendly message', () => {
    assert.equal(MAX_ENCRYPTED_BYTES, 50 * 1024 * 1024);
    assert.ok(!exceedsUploadLimit(10 * 1024 * 1024));
    assert.ok(exceedsUploadLimit(50 * 1024 * 1024), 'exactly 50 MB of plaintext no longer fits once encrypted');
    assert.ok(!exceedsUploadLimit(49 * 1024 * 1024));
    assert.match(new MediaTooLargeError(60 * 1024 * 1024).message, /60\.0 MB.*up to 50 MB/);
  });
});
