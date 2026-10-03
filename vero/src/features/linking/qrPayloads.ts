/**
 * QR code payloads (pure; unit-tested in tests/linking.test.ts).
 *
 *   profile   vero://u/<username>[?fp=<30-digit fingerprint>]
 *             https://<web host>/u/<username>          (fallback link, same route)
 *   link      vero-link:<linkId>:<secret>:<ephemeralPublicKey>
 *   transfer  vero-transfer:<transferId>:<secret>:<ephemeralPublicKey>
 *
 * secret / ephemeralPublicKey are 32-byte values in unpadded URL-safe base64
 * (libsodium's default), i.e. exactly 43 characters.
 */

export const USERNAME_RE = /^[a-z0-9_]{3,30}$/;
export const FINGERPRINT_RE = /^\d{30}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KEY32_B64_RE = /^[A-Za-z0-9_-]{43}$/;

export type QrPayload =
  | { kind: 'profile'; username: string; fingerprint?: string }
  | { kind: 'link'; linkId: string; secret: string; publicKey: string }
  | { kind: 'transfer'; transferId: string; secret: string; publicKey: string };

export function buildProfileQr(username: string, fingerprint?: string | null): string {
  const u = username.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) throw new Error('Invalid username');
  if (fingerprint && !FINGERPRINT_RE.test(fingerprint)) throw new Error('Invalid fingerprint');
  return `vero://u/${u}${fingerprint ? `?fp=${fingerprint}` : ''}`;
}

/** Shareable https link (needs EXPO_PUBLIC_WEB_URL to point at the hosted web build). */
export function buildProfileWebLink(baseUrl: string, username: string): string {
  const u = username.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) throw new Error('Invalid username');
  return `${baseUrl.replace(/\/+$/, '')}/u/${u}`;
}

export function buildLinkQr(p: { linkId: string; secret: string; publicKey: string }): string {
  assertTriple(p.linkId, p.secret, p.publicKey);
  return `vero-link:${p.linkId.toLowerCase()}:${p.secret}:${p.publicKey}`;
}

export function buildTransferQr(p: { transferId: string; secret: string; publicKey: string }): string {
  assertTriple(p.transferId, p.secret, p.publicKey);
  return `vero-transfer:${p.transferId.toLowerCase()}:${p.secret}:${p.publicKey}`;
}

function assertTriple(id: string, secret: string, publicKey: string) {
  if (!UUID_RE.test(id)) throw new Error('Invalid id');
  if (!KEY32_B64_RE.test(secret)) throw new Error('Invalid secret');
  if (!KEY32_B64_RE.test(publicKey)) throw new Error('Invalid public key');
}

function parseTriple(rest: string): { id: string; secret: string; publicKey: string } | null {
  const parts = rest.split(':');
  if (parts.length !== 3) return null;
  const [id, secret, publicKey] = parts;
  if (!UUID_RE.test(id) || !KEY32_B64_RE.test(secret) || !KEY32_B64_RE.test(publicKey)) return null;
  if (secret === publicKey) return null;
  return { id: id.toLowerCase(), secret, publicKey };
}

function parseProfilePath(path: string, query: string): QrPayload | null {
  const m = /^\/?u\/([^/?#]+)\/?$/.exec(path);
  if (!m) return null;
  let username: string;
  try {
    username = decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return null;
  }
  if (!USERNAME_RE.test(username)) return null;
  const fp = /(?:^|&)fp=([^&]*)/.exec(query)?.[1];
  if (fp !== undefined && !FINGERPRINT_RE.test(fp)) return null; // a corrupted fingerprint must not be ignored silently
  return fp ? { kind: 'profile', username, fingerprint: fp } : { kind: 'profile', username };
}

/** Parses any Vero QR code / link. Returns null for anything unrecognised or malformed. */
export function parseQrPayload(raw: string | null | undefined): QrPayload | null {
  if (!raw) return null;
  const text = raw.trim();
  if (text.length > 512) return null;

  if (text.startsWith('vero-link:')) {
    const t = parseTriple(text.slice('vero-link:'.length));
    return t ? { kind: 'link', linkId: t.id, secret: t.secret, publicKey: t.publicKey } : null;
  }
  if (text.startsWith('vero-transfer:')) {
    const t = parseTriple(text.slice('vero-transfer:'.length));
    return t ? { kind: 'transfer', transferId: t.id, secret: t.secret, publicKey: t.publicKey } : null;
  }

  const deep = /^vero:\/\/(.*)$/i.exec(text);
  if (deep) {
    const [pathPart, query = ''] = deep[1].split('?', 2);
    return parseProfilePath(pathPart, query);
  }

  const web = /^https:\/\/[a-z0-9.-]+(?::\d+)?(\/[^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(text);
  if (web) return parseProfilePath(web[1], web[2] ?? '');

  // A bare "@username" typed or pasted by hand.
  const at = /^@([a-z0-9_]{3,30})$/i.exec(text);
  if (at) return { kind: 'profile', username: at[1].toLowerCase() };
  return null;
}
