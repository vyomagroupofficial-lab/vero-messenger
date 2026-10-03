/**
 * Extra payload kinds (stickers, GIFs, payment cards, bot mini-app data).
 *
 * Like everything in payload.ts these travel ONLY inside the encrypted
 * envelope. The server sees the coarse type from extensionServerType():
 *   sticker / gif     -> 'media'    (same as a photo)
 *   payment / bot_data-> 'text'     (indistinguishable from a text message)
 *   payment_status    -> 'reaction' (a control message, like a reaction)
 *
 * Parsing is defensive: a malicious sender controls every byte.
 */

import type { MediaAttachment, ServerMessageType } from './Message';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ExtensionMessageType = 'sticker' | 'gif' | 'payment' | 'bot_data';

export interface StickerRef {
  pack: string;
  id: string;
}

export type WireMedia = Omit<MediaAttachment, 'localUri'>;

export type PaymentKind = 'request' | 'pay';
export type PaymentMethod = 'upi' | 'link';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'declined' | 'cancelled';

export interface PaymentCard {
  /** Reference id; also used as the UPI `tr` parameter. */
  ref: string;
  kind: PaymentKind;
  method: PaymentMethod;
  /** Integer paise (₹1 = 100). */
  amountPaise: number;
  currency: 'INR';
  note?: string;
  /** Payee UPI id. Present for method 'upi'. */
  payeeVpa?: string;
  payeeName?: string;
  /** Razorpay payment link (method 'link', optional server feature). */
  linkUrl?: string;
  linkId?: string;
  /** Optional counterpart user id (the payer of a request / payee of a payment) in group chats. */
  to?: string;
}

export type ExtensionPayload =
  | { t: 'sticker'; ref?: StickerRef; media?: WireMedia; emoji?: string }
  | { t: 'gif'; media: WireMedia; title?: string }
  | { t: 'payment'; card: PaymentCard }
  | { t: 'payment_status'; target: string; status: PaymentStatus; txnRef?: string; verified?: boolean }
  | { t: 'bot_data'; data: string };

export interface PaymentState {
  status: PaymentStatus;
  txnRef?: string;
  verified?: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

/** Structured data stored with a decrypted message (local only). */
export type MessageExt =
  | { t: 'sticker'; ref?: StickerRef; emoji?: string }
  | { t: 'gif'; title?: string }
  | { t: 'payment'; card: PaymentCard; state: PaymentState }
  | { t: 'bot_data'; data: string };

// ── Limits & validators ───────────────────────────────────────────────────────

export const MAX_BOT_DATA_BYTES = 4096;
export const MIN_PAYMENT_PAISE = 100; // ₹1
export const MAX_PAYMENT_PAISE = 100_000_00; // ₹1,00,000
export const MAX_PAYMENT_NOTE = 80;

/** NPCI handle format: local part + '@' + PSP handle. */
export const VPA_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
const REF_RE = /^[A-Za-z0-9]{8,35}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MSG_ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const PAYMENT_STATUSES: PaymentStatus[] = ['pending', 'paid', 'failed', 'declined', 'cancelled'];

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const optStr = (v: unknown, max: number): string | undefined => (str(v, max) && v.length > 0 ? v : undefined);

/** Same rules as the core 'media' payload; unknown fields (e.g. localUri) are dropped. */
export function parseWireMedia(m: any): WireMedia | null {
  if (!m || typeof m !== 'object') return null;
  if (![m.mediaId, m.objectId, m.key, m.nonce, m.hash, m.mimeType].every((v) => str(v, 512))) return null;
  if (typeof m.size !== 'number' || !Number.isFinite(m.size) || m.size < 0) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? v : undefined);
  return {
    mediaId: m.mediaId,
    objectId: m.objectId,
    key: m.key,
    nonce: m.nonce,
    hash: m.hash,
    mimeType: m.mimeType,
    size: m.size,
    fileName: str(m.fileName, 255) ? m.fileName : undefined,
    width: num(m.width),
    height: num(m.height),
    durationMs: num(m.durationMs),
  };
}

export function isValidVpa(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 320 && VPA_RE.test(v);
}

export function isValidAmountPaise(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= MIN_PAYMENT_PAISE && (v as number) <= MAX_PAYMENT_PAISE;
}

export function parsePaymentCard(c: any): PaymentCard | null {
  if (!c || typeof c !== 'object') return null;
  if (!str(c.ref, 35) || !REF_RE.test(c.ref)) return null;
  if (c.kind !== 'request' && c.kind !== 'pay') return null;
  if (c.method !== 'upi' && c.method !== 'link') return null;
  if (!isValidAmountPaise(c.amountPaise)) return null;
  if (c.currency !== 'INR') return null;
  const card: PaymentCard = {
    ref: c.ref,
    kind: c.kind,
    method: c.method,
    amountPaise: c.amountPaise,
    currency: 'INR',
    note: optStr(c.note, MAX_PAYMENT_NOTE),
    payeeName: optStr(c.payeeName, 64),
  };
  if (c.to !== undefined) {
    if (!str(c.to, 64) || !MSG_ID_RE.test(c.to)) return null;
    card.to = c.to;
  }
  if (c.method === 'upi') {
    if (!isValidVpa(c.payeeVpa)) return null;
    card.payeeVpa = c.payeeVpa;
  } else {
    // Only Razorpay-hosted https links are accepted, so a hostile sender can't
    // dress up a phishing URL as a payment button.
    if (!isTrustedPaymentLink(c.linkUrl)) return null;
    card.linkUrl = c.linkUrl;
    card.linkId = optStr(c.linkId, 64);
  }
  return card;
}

export function isTrustedPaymentLink(u: unknown): u is string {
  if (!str(u, 256)) return false;
  const m = /^https:\/\/([a-z0-9.-]+)(\/[A-Za-z0-9/_\-.]*)?$/.exec(u);
  return !!m && (m[1] === 'rzp.io' || m[1] === 'razorpay.com' || m[1].endsWith('.razorpay.com'));
}

/** Returns null unless `p` is a well-formed extension payload. */
export function parseExtensionPayload(p: any): ExtensionPayload | null {
  if (!p || typeof p !== 'object') return null;
  switch (p.t) {
    case 'sticker': {
      const emoji = optStr(p.emoji, 16);
      if (p.ref !== undefined) {
        const r = p.ref;
        if (!r || !str(r.pack, 48) || !str(r.id, 48) || !ID_RE.test(r.pack) || !ID_RE.test(r.id)) return null;
        return { t: 'sticker', ref: { pack: r.pack, id: r.id }, emoji };
      }
      const media = parseWireMedia(p.media);
      if (!media || !/^image\/(webp|png|gif|jpeg)$/.test(media.mimeType)) return null;
      return { t: 'sticker', media, emoji };
    }
    case 'gif': {
      const media = parseWireMedia(p.media);
      if (!media || !/^(video\/mp4|image\/gif|image\/webp)$/.test(media.mimeType)) return null;
      return { t: 'gif', media, title: optStr(p.title, 140) };
    }
    case 'payment': {
      const card = parsePaymentCard(p.card);
      return card ? { t: 'payment', card } : null;
    }
    case 'payment_status': {
      if (!str(p.target, 64) || !MSG_ID_RE.test(p.target)) return null;
      if (!PAYMENT_STATUSES.includes(p.status) || p.status === 'pending') return null;
      const txnRef = optStr(p.txnRef, 64);
      if (txnRef !== undefined && !/^[A-Za-z0-9 _\-/]+$/.test(txnRef)) return null;
      return { t: 'payment_status', target: p.target, status: p.status, txnRef, verified: p.verified === true || undefined };
    }
    case 'bot_data': {
      if (!str(p.data, MAX_BOT_DATA_BYTES) || utf8Length(p.data) > MAX_BOT_DATA_BYTES) return null;
      try {
        JSON.parse(p.data);
      } catch {
        return null;
      }
      return { t: 'bot_data', data: p.data };
    }
    default:
      return null;
  }
}

export function extensionServerType(p: ExtensionPayload): ServerMessageType {
  switch (p.t) {
    case 'sticker':
    case 'gif':
      return 'media';
    case 'payment_status':
      return 'reaction';
    default:
      return 'text';
  }
}

/** Control payloads update another message and never get a bubble of their own. */
export function isControlPayload(p: { t: string }): boolean {
  return p.t === 'payment_status';
}

export function formatINR(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const fraction = paise % 100;
  // Indian digit grouping: 1,00,000
  const s = String(rupees);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `₹${grouped}${fraction ? `.${String(fraction).padStart(2, '0')}` : ''}`;
}

/** Local message view for an extension payload (type, preview text, structured data, attachment). */
export function extensionContent(payload: { t: string }): {
  type: ExtensionMessageType | 'system';
  content?: string;
  ext?: MessageExt;
  media?: WireMedia;
} {
  const p = payload as ExtensionPayload;
  switch (p.t) {
    case 'sticker':
      return {
        type: 'sticker',
        content: p.emoji ? `${p.emoji} Sticker` : 'Sticker',
        ext: { t: 'sticker', ref: p.ref, emoji: p.emoji },
        media: p.media,
      };
    case 'gif':
      return { type: 'gif', content: 'GIF', ext: { t: 'gif', title: p.title }, media: p.media };
    case 'payment':
      return {
        type: 'payment',
        content: `${formatINR(p.card.amountPaise)} · ${p.card.kind === 'request' ? 'Payment request' : 'Payment'}`,
        ext: { t: 'payment', card: p.card, state: { status: 'pending' } },
      };
    case 'bot_data':
      return { type: 'bot_data', content: 'Sent data to the bot', ext: { t: 'bot_data', data: p.data } };
    default:
      return { type: 'system' };
  }
}

/** Rebuilds the payload of a failed outgoing message so it can be retried. */
export function extensionPayloadFromMessage(m: { ext?: MessageExt; media?: MediaAttachment }): ExtensionPayload | null {
  const ext = m.ext;
  if (!ext) return null;
  const media = m.media ? (({ localUri: _l, ...rest }) => rest)(m.media) : undefined;
  switch (ext.t) {
    case 'sticker':
      return ext.ref ? { t: 'sticker', ref: ext.ref, emoji: ext.emoji } : media ? { t: 'sticker', media, emoji: ext.emoji } : null;
    case 'gif':
      return media ? { t: 'gif', media, title: ext.title } : null;
    case 'payment':
      return { t: 'payment', card: ext.card };
    case 'bot_data':
      return { t: 'bot_data', data: ext.data };
  }
}

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
