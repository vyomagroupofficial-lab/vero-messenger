import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256Hex, sha256, toHex, utf8Bytes } from '../src/features/discovery/sha256';
import { normalizeEmail, normalizePhone } from '../src/features/discovery/normalize';
import {
  identifierHash,
  hashPrefix,
  buildLookupPlan,
  batchPrefixes,
  matchLookupResults,
  LookupRow,
} from '../src/features/discovery/hashing';

// ── SHA-256 ───────────────────────────────────────────────────────────────────

test('sha256 matches node:crypto for edge-case lengths and unicode', () => {
  const inputs = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'नमस्ते 👋 émoji'];
  for (const s of inputs) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s));
  }
  for (let i = 0; i < 20; i++) {
    const buf = randomBytes(i * 13);
    assert.equal(toHex(sha256(new Uint8Array(buf))), createHash('sha256').update(buf).digest('hex'));
  }
});

test('utf8Bytes matches Buffer encoding (incl. surrogate pairs)', () => {
  const s = 'a€𝄞हिन्दी';
  assert.deepEqual([...utf8Bytes(s)], [...Buffer.from(s, 'utf8')]);
});

// ── Normalisation ─────────────────────────────────────────────────────────────

test('Indian numbers in every common format normalise to the same E.164', () => {
  const forms = [
    '98765 43210',
    '9876543210',
    '098765-43210',
    '+91 98765 43210',
    '+91-98765-43210',
    '+91 (0) 98765 43210',
    '0091 98765 43210',
    '919876543210',
    '(+91) 9876543210',
  ];
  for (const f of forms) assert.equal(normalizePhone(f), '+919876543210', f);
});

test('Indian landlines with STD code', () => {
  assert.equal(normalizePhone('011 2345 6789'), '+911123456789');
  assert.equal(normalizePhone('+91 11 2345 6789'), '+911123456789');
});

test('foreign numbers keep their country code; implausible numbers are rejected', () => {
  assert.equal(normalizePhone('+1 (415) 555-0100'), '+14155550100');
  assert.equal(normalizePhone('+44 (0)20 7946 0018'), '+442079460018');
  assert.equal(normalizePhone('0044 20 7946 0018'), '+442079460018');
  assert.equal(normalizePhone('(415) 555-0100', 'US'), '+14155550100');
  assert.equal(normalizePhone('1-415-555-0100', 'US'), '+14155550100');
  assert.equal(normalizePhone('+91 98765 4321'), null, 'too short for India');
  assert.equal(normalizePhone('+91 98765 432100'), null, 'too long for India');
  assert.equal(normalizePhone('121'), null, 'short code');
  assert.equal(normalizePhone('1-800-FLOWERS'), null, 'vanity number');
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});

test('extensions are dropped', () => {
  assert.equal(normalizePhone('+91 98765 43210 ext. 12'), '+919876543210');
  assert.equal(normalizePhone('9876543210;55'), '+919876543210');
});

test('emails are trimmed and lower-cased', () => {
  assert.equal(normalizeEmail('  Dana@Example.COM '), 'dana@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('a@b'), null);
});

// ── Hashing (vectors shared with supabase/tests/discovery_linking_test.sql) ───

test('identifier hashes match the server vectors', () => {
  assert.equal(identifierHash('email', 'dana@example.com'), '645e345205eccdcd97958f6766b048d6add440894c96d549646681f4c461604b');
  assert.equal(identifierHash('phone', '+919876543210'), 'cb6ccfcd02605c85f8eac961890666fdef76db77fab037b15381b7d7be74ec5c');
  assert.equal(identifierHash('phone', '+14155550100'), 'ed36fa59de1a3bbeef436f1b46e8183eafd470a8d0f2390ee589188b996eab7e');
});

test('hashPrefix only allows short prefixes', () => {
  const h = identifierHash('email', 'dana@example.com');
  assert.equal(hashPrefix(h), '645e');
  assert.equal(hashPrefix(h, 3), '645');
  assert.throws(() => hashPrefix(h, 6));
  assert.throws(() => hashPrefix(h, 2));
  assert.throws(() => hashPrefix('xyz'));
});

// ── Lookup plan & k-anonymous matching ───────────────────────────────────────

const contacts = [
  { id: 'c1', name: 'Dana', phones: ['098765 43210'], emails: ['DANA@example.com'] },
  { id: 'c2', name: 'Dana (work)', phones: ['+91 98765 43210'], emails: [] },
  { id: 'c3', name: 'Ravi', phones: ['99999 00000', 'garbage'], emails: ['ravi@example.in'] },
  { id: 'me', name: 'Me', phones: ['+91 90000 11111'], emails: ['me@example.com'] },
];

test('the plan sends only de-duplicated short prefixes, never full hashes or identifiers', () => {
  const plan = buildLookupPlan(contacts, { exclude: { emails: ['me@example.com'], phones: ['9000011111'] } });
  // Dana's phone appears twice (two contacts) -> one hash with two contacts.
  const danaPhone = identifierHash('phone', '+919876543210');
  assert.deepEqual(plan.byHash.get(danaPhone)!.map((p) => p.contactId), ['c1', 'c2']);
  assert.equal(plan.byHash.size, 4, 'dana phone, dana email, ravi phone, ravi email (own identifiers excluded)');
  assert.ok(plan.prefixes.every((p) => /^[0-9a-f]{4}$/.test(p)));
  assert.deepEqual(plan.prefixes, [...new Set(plan.prefixes)].sort());
  const sent = JSON.stringify(plan.prefixes);
  for (const forbidden of ['9876543210', 'dana', danaPhone]) assert.ok(!sent.includes(forbidden));
});

test('batchPrefixes respects the server cap', () => {
  const many = Array.from({ length: 4500 }, (_, i) => i.toString(16).padStart(4, '0'));
  const batches = batchPrefixes(many);
  assert.deepEqual(batches.map((b) => b.length), [2000, 2000, 500]);
});

test('matching keeps only full-hash hits and ignores bucket neighbours', () => {
  const plan = buildLookupPlan(contacts);
  const danaPhone = identifierHash('phone', '+919876543210');
  const danaEmail = identifierHash('email', 'dana@example.com');
  // A different hash in the same bucket (same 4-char prefix): someone else's identifier.
  const neighbour = danaPhone.slice(0, 4) + 'f'.repeat(60);
  const rows: LookupRow[] = [
    { identifier_hash: danaPhone, user_id: 'u-dana', username: 'dana_d', display_name: 'Dana' },
    { identifier_hash: danaEmail.toUpperCase(), user_id: 'u-dana', username: 'dana_d', display_name: 'Dana' },
    { identifier_hash: neighbour, user_id: 'u-stranger', username: 'stranger', display_name: 'Stranger' },
  ];
  const friends = matchLookupResults(plan, rows);
  assert.equal(friends.length, 1);
  assert.equal(friends[0].userId, 'u-dana');
  assert.deepEqual(friends[0].contactNames.sort(), ['Dana', 'Dana (work)']);
  assert.deepEqual(friends[0].matchedBy.sort(), ['email', 'phone']);
});

test('k-anonymity: each 4-hex prefix is shared by many possible phone numbers', () => {
  // Hash 20,000 consecutive Indian mobile numbers; prefixes must collide a lot,
  // i.e. a prefix never pins down a single number.
  const counts = new Map<string, number>();
  for (let i = 0; i < 20000; i++) {
    const p = hashPrefix(identifierHash('phone', `+9198${String(i).padStart(8, '0')}`));
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  // 20,000 numbers over 65,536 buckets: about 26% of buckets used, uniformly.
  assert.ok(counts.size > 15000 && counts.size < 18000, `buckets used: ${counts.size}`);
  // Across the full Indian mobile space (~10^9 numbers) each bucket holds ~15k numbers.
  assert.ok(1e9 / 65536 > 10000);
});
