import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUpiUrl,
  formatINR,
  generatePaymentRef,
  isValidVpa,
  normalizeVpa,
  parseAmount,
  sanitizeUpiText,
  upiAmount,
  upiUrlForCard,
} from '../src/features/payments/upi';
import { allowedTransitions, applyPaymentUpdate, statusLabel } from '../src/features/payments/paymentCard';
import type { PaymentCard, PaymentState } from '../src/shared/models/payloadExtensions';

// ── UPI ids ──────────────────────────────────────────────────────────────────

test('VPA regex accepts real-world UPI ids', () => {
  for (const v of ['alice@okicici', 'a.b-c_d@ybl', '9876543210@paytm', 'shop.name@okhdfcbank', 'x1@upi', 'user@oksbi']) {
    assert.ok(isValidVpa(v), v);
  }
});

test('VPA regex rejects malformed or injected ids', () => {
  for (const v of [
    '', 'alice', '@okicici', 'alice@', 'a@b', 'alice@@ok', 'ali ce@ok', 'alice@ok icici', 'alice@1bank',
    'alice@ok&am=1', 'alice@ok?x', 'alice@ok#', '.alice@ok', 'alice@ok/../', 'ålice@ok', `${'a'.repeat(300)}@ok`,
  ]) {
    assert.equal(isValidVpa(v), false, v);
  }
});

test('normalizeVpa trims and lower-cases the PSP handle only', () => {
  assert.equal(normalizeVpa('  Alice.K@OKICICI '), 'Alice.K@okicici');
  assert.equal(normalizeVpa('not a vpa'), null);
});

// ── Amounts ──────────────────────────────────────────────────────────────────

test('amounts are parsed into integer paise', () => {
  assert.deepEqual(parseAmount('250'), { ok: true, paise: 25000 });
  assert.deepEqual(parseAmount('99.5'), { ok: true, paise: 9950 });
  assert.deepEqual(parseAmount('₹ 1,250.75'), { ok: true, paise: 125075 });
  assert.deepEqual(parseAmount('1'), { ok: true, paise: 100 });
  assert.deepEqual(parseAmount('100000'), { ok: true, paise: 10000000 });
});

test('amount bounds are ₹1 – ₹1,00,000 and junk is rejected', () => {
  for (const bad of ['0', '0.99', '100000.01', '200000', '-5', '1.234', 'abc', '', '1e5', '0x10', '12..5', 'NaN']) {
    assert.equal(parseAmount(bad).ok, false, bad);
  }
});

test('formatting uses Indian digit grouping', () => {
  assert.equal(formatINR(100), '₹1');
  assert.equal(formatINR(125075), '₹1,250.75');
  assert.equal(formatINR(10000000), '₹1,00,000');
  assert.equal(formatINR(1234567), '₹12,345.67');
  assert.equal(upiAmount(9950), '99.50');
  assert.equal(upiAmount(100), '1.00');
});

// ── upi://pay links ──────────────────────────────────────────────────────────

test('buildUpiUrl produces the standard intent with encoded fields', () => {
  const url = buildUpiUrl({ vpa: 'alice@okicici', name: 'Alice K', amountPaise: 25050, note: 'Dinner & movie', ref: 'VRO1234567890' });
  assert.equal(url, 'upi://pay?pa=alice@okicici&pn=Alice%20K&am=250.50&cu=INR&tn=Dinner%20movie&tr=VRO1234567890');
});

test('hostile names and notes cannot inject extra parameters', () => {
  const url = buildUpiUrl({ vpa: 'bob@ybl', name: 'Bob&pa=evil@ybl', amountPaise: 100, note: 'x&am=99999#frag?y=1' });
  const params = new URLSearchParams(url.slice('upi://pay?'.length));
  assert.equal(params.getAll('pa').length, 1);
  assert.equal(params.get('pa'), 'bob@ybl');
  assert.equal(params.getAll('am').length, 1);
  assert.equal(params.get('am'), '1.00');
  assert.ok(!url.includes('#'));
  assert.equal(sanitizeUpiText('  a\u0000b\nc  ', 10), 'a b c');
});

test('buildUpiUrl refuses invalid VPA, amount or reference', () => {
  assert.throws(() => buildUpiUrl({ vpa: 'evil@ok&pa=x@y', amountPaise: 100 }));
  assert.throws(() => buildUpiUrl({ vpa: 'a@okaxis', amountPaise: 99 }));
  assert.throws(() => buildUpiUrl({ vpa: 'a@okaxis', amountPaise: 10000001 }));
  assert.throws(() => buildUpiUrl({ vpa: 'a@okaxis', amountPaise: 150.5 }));
  assert.throws(() => buildUpiUrl({ vpa: 'a@okaxis', amountPaise: 100, ref: 'bad ref!' }));
});

test('payment references are 20 unambiguous alphanumerics', () => {
  let i = 0;
  const ref = generatePaymentRef((n) => Uint8Array.from({ length: n }, () => i++ * 37));
  assert.match(ref, /^VRO[A-Z2-9]{17}$/);
});

// ── Card state machine ───────────────────────────────────────────────────────

const card = (over: Partial<PaymentCard> = {}): PaymentCard => ({
  ref: 'VRO12345678901234567',
  kind: 'request',
  method: 'upi',
  amountPaise: 50000,
  currency: 'INR',
  payeeVpa: 'alice@okicici',
  ...over,
});
const pending: PaymentState = { status: 'pending' };
const payee = { userId: 'alice', isCreator: true, at: '2026-01-01T00:00:00Z' };
const payer = { userId: 'bob', isCreator: false, at: '2026-01-01T00:01:00Z' };

test('request: payer can pay/fail/decline, requester can confirm or cancel', () => {
  assert.deepEqual(allowedTransitions(card(), pending, payer), ['paid', 'failed', 'declined']);
  assert.deepEqual(allowedTransitions(card(), pending, payee), ['paid', 'cancelled']);
  const paid = applyPaymentUpdate(card(), pending, { status: 'paid', txnRef: '412345678901' }, payer);
  assert.deepEqual(paid, { status: 'paid', txnRef: '412345678901', verified: undefined, updatedBy: 'bob', updatedAt: payer.at });
  assert.equal(statusLabel(card(), paid!), 'Marked as paid');
});

test('requester cannot decline, payer cannot cancel someone else’s request', () => {
  assert.equal(applyPaymentUpdate(card(), pending, { status: 'declined' }, payee), null);
  assert.equal(applyPaymentUpdate(card(), pending, { status: 'cancelled' }, payer), null);
});

test('failed payments can be retried; terminal states never change', () => {
  const failed = applyPaymentUpdate(card(), pending, { status: 'failed' }, payer)!;
  assert.equal(failed.status, 'failed');
  const paid = applyPaymentUpdate(card(), failed, { status: 'paid' }, payer)!;
  assert.equal(paid.status, 'paid');
  for (const s of ['failed', 'declined', 'cancelled', 'paid'] as const) {
    assert.equal(applyPaymentUpdate(card(), paid, { status: s }, payer), null, `paid -> ${s}`);
    assert.equal(applyPaymentUpdate(card(), paid, { status: s }, payee), null, `paid -> ${s} (payee)`);
  }
  const cancelled = applyPaymentUpdate(card(), pending, { status: 'cancelled' }, payee)!;
  assert.equal(applyPaymentUpdate(card(), cancelled, { status: 'paid' }, payer), null);
});

test('re-applying the same update is a no-op (idempotent replays)', () => {
  const failed = applyPaymentUpdate(card(), pending, { status: 'failed' }, payer)!;
  assert.equal(applyPaymentUpdate(card(), failed, { status: 'failed' }, payer), null);
});

test('pay cards: payer reports, payee may only confirm receipt', () => {
  const pay = card({ kind: 'pay' });
  const payerCreator = { userId: 'bob', isCreator: true };
  const payeeOther = { userId: 'alice', isCreator: false };
  assert.deepEqual(allowedTransitions(pay, pending, payerCreator), ['paid', 'failed', 'cancelled']);
  assert.deepEqual(allowedTransitions(pay, pending, payeeOther), ['paid']);
  assert.equal(applyPaymentUpdate(pay, pending, { status: 'declined' }, payeeOther), null);
});

test('only the payee can mark a payment verified', () => {
  const byPayer = applyPaymentUpdate(card(), pending, { status: 'paid', verified: true }, payer)!;
  assert.equal(byPayer.verified, undefined);
  const byPayee = applyPaymentUpdate(card({ method: 'link', payeeVpa: undefined, linkUrl: 'https://rzp.io/i/x' }), pending, { status: 'paid', verified: true }, payee)!;
  assert.equal(byPayee.verified, true);
  assert.equal(statusLabel(card(), byPayee), 'Paid · verified');
});

test('cards addressed to one member (groups) ignore everyone else', () => {
  const addressed = card({ to: 'bob' });
  assert.deepEqual(allowedTransitions(addressed, pending, { userId: 'carol', isCreator: false }), []);
  assert.ok(allowedTransitions(addressed, pending, { userId: 'bob', isCreator: false }).includes('paid'));
});

test('upiUrlForCard only builds links for UPI cards', () => {
  assert.match(upiUrlForCard(card({ note: 'Rent' }))!, /^upi:\/\/pay\?pa=alice@okicici&am=500\.00&cu=INR&tn=Rent&tr=VRO/);
  assert.equal(upiUrlForCard(card({ method: 'link', payeeVpa: undefined, linkUrl: 'https://rzp.io/i/x' })), null);
});
