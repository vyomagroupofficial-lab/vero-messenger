import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import sumoModule from 'libsodium-wrappers-sumo';
import {
  BackupError,
  SumoSodium,
  createPassphraseSlot,
  createRecoverySlot,
  decryptBackup,
  encryptBackup,
  generateBackupKey,
  parseBackup,
  unlockBackupKey,
  validatePassphrase,
  BACKUP_CHUNK_BYTES,
} from '../src/features/backup/backupCrypto';
import {
  RecoveryKeyError,
  RECOVERY_KEY_CHARS,
  generateRecoveryKey,
  normalizeRecoveryKeyInput,
  parseRecoveryKey,
} from '../src/features/backup/recoveryKey';

let sodium: SumoSodium;
// Fast Argon2id limits for most tests; one test uses the real MODERATE default.
let fast: { opslimit: number; memlimit: number };

before(async () => {
  await sumoModule.ready;
  sodium = sumoModule as unknown as SumoSodium;
  fast = { opslimit: sodium.crypto_pwhash_OPSLIMIT_MIN, memlimit: sodium.crypto_pwhash_MEMLIMIT_MIN };
});

const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const PASS = 'correct horse battery staple';

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function makeBackup(plaintext: Uint8Array, opts: { passphrase?: boolean; recovery?: string } = { passphrase: true }) {
  const key = generateBackupKey(sodium);
  const slots = [];
  if (opts.passphrase) slots.push(createPassphraseSlot(sodium, key, USER, PASS, fast));
  if (opts.recovery) slots.push(createRecoverySlot(sodium, key, USER, parseRecoveryKey(sodium, opts.recovery)));
  return encryptBackup(sodium, { backupKey: key, userId: USER, slots, plaintext });
}

// ── recovery key ──────────────────────────────────────────────────────────────

test('recovery key: 64 characters in 16 groups of 4, unique each time', () => {
  const a = generateRecoveryKey(sodium);
  const b = generateRecoveryKey(sodium);
  assert.match(a, /^([0-9A-HJKMNP-TV-Z]{4}-){15}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(normalizeRecoveryKeyInput(a).length, RECOVERY_KEY_CHARS);
  assert.notEqual(a, b);
});

test('recovery key: round trip, forgiving input', () => {
  const key = generateRecoveryKey(sodium);
  const secret = parseRecoveryKey(sodium, key);
  assert.equal(secret.length, 60);
  // lower case, spaces instead of dashes, look-alikes
  const sloppy = key.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
  assert.equal(parseRecoveryKey(sodium, sloppy), secret);
  assert.equal(parseRecoveryKey(sodium, `  ${key.replace(/-/g, '')}\n`), secret);
});

test('recovery key: checksum catches typos', () => {
  const key = generateRecoveryKey(sodium);
  const compact = normalizeRecoveryKeyInput(key);
  let caught = 0;
  for (let i = 0; i < compact.length; i++) {
    const swapped = compact[i] === 'A' ? 'B' : 'A';
    const typo = compact.slice(0, i) + swapped + compact.slice(i + 1);
    try {
      parseRecoveryKey(sodium, typo);
    } catch (e) {
      assert.ok(e instanceof RecoveryKeyError);
      assert.equal((e as RecoveryKeyError).reason, 'checksum');
      caught++;
    }
  }
  assert.equal(caught, compact.length, 'every single-character typo is detected');
  // transposition of two different neighbouring characters
  const j = [...compact].findIndex((c, i) => i < 59 && c !== compact[i + 1]);
  const transposed = compact.slice(0, j) + compact[j + 1] + compact[j] + compact.slice(j + 2);
  assert.throws(() => parseRecoveryKey(sodium, transposed), RecoveryKeyError);
});

test('recovery key: wrong length and bad characters are reported', () => {
  const key = generateRecoveryKey(sodium);
  assert.throws(() => parseRecoveryKey(sodium, key.slice(0, -5)), (e: any) => e.reason === 'length');
  assert.throws(() => parseRecoveryKey(sodium, `${key}-AAAA`), (e: any) => e.reason === 'length');
  assert.throws(() => parseRecoveryKey(sodium, key.replace(/^./, 'U')), (e: any) => e.reason === 'characters');
  assert.throws(() => parseRecoveryKey(sodium, ''), (e: any) => e.reason === 'length');
});

// ── passphrase rules ─────────────────────────────────────────────────────────

test('passphrase: at least 12 characters, not a single repeated character', () => {
  assert.ok(validatePassphrase('short pass'));
  assert.ok(validatePassphrase('aaaaaaaaaaaaaaaa'));
  assert.equal(validatePassphrase(PASS), null);
  assert.throws(() => createPassphraseSlot(sodium, generateBackupKey(sodium), USER, 'too short', fast), BackupError);
});

// ── backup round trip ────────────────────────────────────────────────────────

test('backup: round trip with passphrase (Argon2id MODERATE default)', () => {
  const plaintext = bytesOf(JSON.stringify({ hello: 'world', n: 42 }));
  const key = generateBackupKey(sodium);
  const slot = createPassphraseSlot(sodium, key, USER, PASS); // default limits
  assert.equal(slot.opslimit, sodium.crypto_pwhash_OPSLIMIT_MODERATE);
  assert.equal(slot.memlimit, sodium.crypto_pwhash_MEMLIMIT_MODERATE);
  const file = encryptBackup(sodium, { backupKey: key, userId: USER, slots: [slot], plaintext });
  const out = decryptBackup(sodium, file, { passphrase: PASS }, USER);
  assert.deepEqual(out.plaintext, plaintext);
  assert.deepEqual(out.backupKey, key);
});

test('backup: either secret unlocks the same backup', () => {
  const recovery = generateRecoveryKey(sodium);
  const plaintext = sodium.randombytes_buf(BACKUP_CHUNK_BYTES * 3 + 123); // several frames
  const file = makeBackup(plaintext, { passphrase: true, recovery });
  assert.deepEqual(decryptBackup(sodium, file, { passphrase: PASS }, USER).plaintext, plaintext);
  assert.deepEqual(
    decryptBackup(sodium, file, { recoverySecret: parseRecoveryKey(sodium, recovery) }, USER).plaintext,
    plaintext
  );
});

test('backup: empty plaintext and exact chunk multiples work', () => {
  for (const size of [0, 1, BACKUP_CHUNK_BYTES, BACKUP_CHUNK_BYTES * 2]) {
    const plaintext = sodium.randombytes_buf(size);
    const file = makeBackup(plaintext);
    assert.deepEqual(decryptBackup(sodium, file, { passphrase: PASS }, USER).plaintext, plaintext, `size ${size}`);
  }
});

test('backup: the file reveals no plaintext or secrets', () => {
  const recovery = generateRecoveryKey(sodium);
  const marker = 'super-secret-message-text';
  const file = makeBackup(bytesOf(marker.repeat(10)), { passphrase: true, recovery });
  const asText = Buffer.from(file).toString('latin1');
  assert.ok(!asText.includes(marker));
  assert.ok(!asText.includes(PASS));
  assert.ok(!asText.includes(normalizeRecoveryKeyInput(recovery).slice(0, 20)));
  const { header } = parseBackup(sodium, file);
  assert.equal(header.userId, USER);
  assert.deepEqual(header.slots.map((s) => s.type).sort(), ['passphrase', 'recovery']);
});

test('backup: wrong passphrase / wrong recovery key are rejected', () => {
  const recovery = generateRecoveryKey(sodium);
  const file = makeBackup(bytesOf('hi'), { passphrase: true, recovery });
  assert.throws(
    () => decryptBackup(sodium, file, { passphrase: 'correct horse battery stapler' }, USER),
    (e: any) => e instanceof BackupError && e.reason === 'wrong-secret'
  );
  const other = parseRecoveryKey(sodium, generateRecoveryKey(sodium));
  assert.throws(
    () => decryptBackup(sodium, file, { recoverySecret: other }, USER),
    (e: any) => e instanceof BackupError && e.reason === 'wrong-secret'
  );
});

test('backup: asking for a secret the backup does not have', () => {
  const file = makeBackup(bytesOf('hi'), { passphrase: true });
  assert.throws(
    () => decryptBackup(sodium, file, { recoverySecret: parseRecoveryKey(sodium, generateRecoveryKey(sodium)) }, USER),
    (e: any) => e.reason === 'input'
  );
});

test('backup: another account cannot restore it', () => {
  const file = makeBackup(bytesOf('hi'));
  assert.throws(
    () => decryptBackup(sodium, file, { passphrase: PASS }, 'bbbbbbbb-0000-4000-8000-000000000002'),
    (e: any) => e.reason === 'account'
  );
});

test('backup: tampering anywhere is detected', () => {
  const plaintext = sodium.randombytes_buf(BACKUP_CHUNK_BYTES * 2 + 10);
  const file = makeBackup(plaintext);
  const { headerBytes } = parseBackup(sodium, file);
  const bodyStart = 8 + 4 + headerBytes.length;

  // flip a byte in each frame region and in the stream header
  for (const pos of [bodyStart + 3, bodyStart + 24 + 4 + 10, file.length - 5, Math.floor((bodyStart + file.length) / 2)]) {
    const t = file.slice();
    t[pos] ^= 0x01;
    assert.throws(() => decryptBackup(sodium, t, { passphrase: PASS }, USER), BackupError, `byte ${pos}`);
  }

  // truncation (drop the final frame) and trailing garbage
  const lastFrameLen = (() => {
    let off = bodyStart + 24;
    let last = 0;
    while (off < file.length) {
      const len = new DataView(file.buffer, file.byteOffset + off, 4).getUint32(0);
      last = len + 4;
      off += len + 4;
    }
    return last;
  })();
  assert.throws(
    () => decryptBackup(sodium, file.slice(0, file.length - lastFrameLen), { passphrase: PASS }, USER),
    (e: any) => e.reason === 'corrupt'
  );
  const extra = new Uint8Array(file.length + 30);
  extra.set(file);
  assert.throws(() => decryptBackup(sodium, extra, { passphrase: PASS }, USER), (e: any) => e.reason === 'corrupt');
});

test('backup: header changes are detected (header is bound to the stream)', () => {
  const file = makeBackup(bytesOf('payload'));
  const parsed = parseBackup(sodium, file);
  // Rewrite createdAt (same length) - the passphrase still unwraps the key,
  // but the first frame's associated data no longer matches.
  const headerText = Buffer.from(parsed.headerBytes).toString('utf8');
  const changed = headerText.replace(/"createdAt":"(\d)/, (_m, d) => `"createdAt":"${d === '1' ? '2' : '1'}`);
  assert.notEqual(changed, headerText);
  const t = file.slice();
  t.set(Buffer.from(changed, 'utf8'), 12);
  assert.throws(() => decryptBackup(sodium, t, { passphrase: PASS }, USER), (e: any) => e.reason === 'corrupt');

  // Weakened Argon2 parameters only make the passphrase fail.
  const weak = headerText.replace(/"opslimit":\d+/, '"opslimit":2');
  if (weak !== headerText && weak.length === headerText.length) {
    const w = file.slice();
    w.set(Buffer.from(weak, 'utf8'), 12);
    assert.throws(() => decryptBackup(sodium, w, { passphrase: PASS }, USER), BackupError);
  }
});

test('backup: not a backup / damaged header', () => {
  assert.throws(() => parseBackup(sodium, bytesOf('hello world, not a backup')), (e: any) => e.reason === 'format');
  const file = makeBackup(bytesOf('x'));
  const t = file.slice();
  t[12] = 0x7b + 1; // break the JSON
  assert.throws(() => parseBackup(sodium, t), (e: any) => e.reason === 'corrupt');
});

test('backup: unlockBackupKey returns the same key from both slots', () => {
  const recovery = generateRecoveryKey(sodium);
  const file = makeBackup(bytesOf('x'), { passphrase: true, recovery });
  const { header } = parseBackup(sodium, file);
  const k1 = unlockBackupKey(sodium, header, { passphrase: PASS });
  const k2 = unlockBackupKey(sodium, header, { recoverySecret: parseRecoveryKey(sodium, recovery) });
  assert.deepEqual(k1, k2);
});
