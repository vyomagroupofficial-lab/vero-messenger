/**
 * UPI deep links (pure, unit-tested).
 *
 * Standard NPCI "UPI linking specification" intent:
 *   upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR&tn=<note>&tr=<ref>
 * Every UPI app (BHIM, PhonePe, Google Pay, Paytm, bank apps) handles it,
 * and it needs no merchant account. Vero never sees the transaction: the
 * user confirms the outcome themselves.
 */

import {
  MAX_PAYMENT_NOTE,
  MAX_PAYMENT_PAISE,
  MIN_PAYMENT_PAISE,
  PaymentCard,
  formatINR,
  isValidVpa,
} from '../../shared/models/payloadExtensions';

export { formatINR, isValidVpa };

export type AmountResult = { ok: true; paise: number } | { ok: false; error: string };

/** Parses user input like "1,250.50" or "₹ 99" into integer paise and checks ₹1–₹1,00,000. */
export function parseAmount(input: string): AmountResult {
  const cleaned = input.replace(/[₹,\s]/g, '').replace(/^INR/i, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(cleaned)) return { ok: false, error: 'Enter an amount like 250 or 99.50' };
  const [rupees, fraction = ''] = cleaned.split('.');
  const paise = parseInt(rupees, 10) * 100 + parseInt(fraction.padEnd(2, '0') || '0', 10);
  if (paise < MIN_PAYMENT_PAISE) return { ok: false, error: 'The minimum amount is ₹1' };
  if (paise > MAX_PAYMENT_PAISE) return { ok: false, error: 'The maximum amount is ₹1,00,000' };
  return { ok: true, paise };
}

/** "1234.50" style amount for the `am` parameter. */
export function upiAmount(paise: number): string {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}

/** Normalises a typed UPI id (trim, lower-case the PSP handle). Returns null if invalid. */
export function normalizeVpa(input: string): string | null {
  const v = input.trim();
  const at = v.lastIndexOf('@');
  if (at < 0) return null;
  const normalized = `${v.slice(0, at)}@${v.slice(at + 1).toLowerCase()}`;
  return isValidVpa(normalized) ? normalized : null;
}

/** Strips characters UPI apps commonly reject in names/notes. */
export function sanitizeUpiText(s: string, max: number): string {
  return s
    .replace(/[\u0000-\u001f\u007f&?=#%+<>"`{}|^~[\]\\;:*$!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 20-char alphanumeric reference (UPI `tr`), unique per card. */
export function generatePaymentRef(random: (n: number) => Uint8Array): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = random(16);
  let out = 'VRO';
  for (let i = 0; i < 17; i++) out += alphabet[bytes[i % bytes.length] % alphabet.length];
  return out;
}

export interface UpiParams {
  vpa: string;
  name?: string;
  amountPaise: number;
  note?: string;
  ref?: string;
}

/**
 * Builds the upi://pay link. Values are percent-encoded except the '@' in the
 * VPA (validated to contain no other special characters), because several
 * UPI apps fail to decode "%40".
 */
export function buildUpiUrl(p: UpiParams): string {
  if (!isValidVpa(p.vpa)) throw new Error('Invalid UPI id');
  if (!Number.isInteger(p.amountPaise) || p.amountPaise < MIN_PAYMENT_PAISE || p.amountPaise > MAX_PAYMENT_PAISE) {
    throw new Error('Amount must be between ₹1 and ₹1,00,000');
  }
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const parts = [`pa=${p.vpa}`];
  const name = p.name ? sanitizeUpiText(p.name, 64) : '';
  if (name) parts.push(`pn=${enc(name)}`);
  parts.push(`am=${upiAmount(p.amountPaise)}`, 'cu=INR');
  const note = p.note ? sanitizeUpiText(p.note, MAX_PAYMENT_NOTE) : '';
  if (note) parts.push(`tn=${enc(note)}`);
  if (p.ref) {
    if (!/^[A-Za-z0-9]{8,35}$/.test(p.ref)) throw new Error('Invalid reference');
    parts.push(`tr=${p.ref}`);
  }
  return `upi://pay?${parts.join('&')}`;
}

export function upiUrlForCard(card: PaymentCard): string | null {
  if (card.method !== 'upi' || !card.payeeVpa) return null;
  return buildUpiUrl({
    vpa: card.payeeVpa,
    name: card.payeeName,
    amountPaise: card.amountPaise,
    note: card.note,
    ref: card.ref,
  });
}
