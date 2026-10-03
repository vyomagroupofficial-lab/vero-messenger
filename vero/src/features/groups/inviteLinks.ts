/**
 * Invite links: `vero://join/<token>` (always works when the app is
 * installed) and `https://<EXPO_PUBLIC_INVITE_HOST>/join/<token>` (universal /
 * app link; needs the host to serve the association files, see README).
 *
 * The same `/join/<token>` route serves group invites and private-channel
 * invites; the join screen asks the server which one it is.
 *
 * Pure module (no Expo imports) so it can be unit-tested.
 */

/** Server-generated tokens are 43 base64url chars; accept 22-64 like the DB. */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;

export function isValidInviteToken(token: unknown): boolean {
  return typeof token === 'string' && INVITE_TOKEN_RE.test(token);
}

/** `vero.example.com` (no scheme, no path), or null when not configured. */
export function normalizeInviteHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return /^[a-z0-9.-]+(:\d+)?$/i.test(h) && h.includes('.') ? h.toLowerCase() : null;
}

/** The link to share. Prefers https when a host is configured. */
export function buildInviteUrl(token: string, host?: string | null): string {
  if (!isValidInviteToken(token)) throw new Error('Invalid invite token');
  const h = normalizeInviteHost(host);
  return h ? `https://${h}/join/${token}` : `vero://join/${token}`;
}

/**
 * Extracts a token from anything a user might paste or open:
 * `vero://join/<t>`, `vero:///join/<t>`, `https://host/join/<t>?x=y`,
 * `host/join/<t>`, `/join/<t>` or a bare token. Returns null otherwise.
 * When `allowedHost` is given, https links from other hosts are rejected.
 */
export function parseInviteLink(input: string | null | undefined, allowedHost?: string | null): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (isValidInviteToken(raw)) return raw;

  const m = raw.match(/^(?:([a-z][a-z0-9+.-]*):\/\/\/?)?([^/?#]*)\/?(?:.*?\/)?join\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i);
  if (!m) return null;
  const [, scheme, authority, token] = m;
  if (!isValidInviteToken(token)) return null;

  const s = scheme?.toLowerCase();
  if (s === 'vero' || s === 'exp' || s === 'exps') return token;
  if (s && s !== 'https' && s !== 'http') return null;

  const expected = normalizeInviteHost(allowedHost);
  if (expected && authority && authority.toLowerCase() !== expected) return null;
  return token;
}

export type InviteJoinStatus =
  | 'joined'
  | 'already_member'
  | 'requested'
  | 'already_requested'
  | 'invalid'
  | 'revoked'
  | 'expired'
  | 'full'
  | 'group_full'
  | 'rate_limited'
  | 'following';

/** User-facing explanation for a preview/join status. */
export function inviteStatusMessage(status: string): string {
  switch (status) {
    case 'joined':
      return 'You joined the group.';
    case 'already_member':
      return "You're already in this group.";
    case 'requested':
      return 'Request sent. An admin needs to approve it.';
    case 'already_requested':
      return 'Your request is waiting for an admin.';
    case 'following':
      return "You're following this channel.";
    case 'revoked':
      return 'This invite link was reset by an admin.';
    case 'expired':
      return 'This invite link has expired.';
    case 'full':
      return 'This invite link has reached its usage limit.';
    case 'group_full':
      return 'This group is full.';
    case 'rate_limited':
      return 'Too many attempts. Try again later.';
    default:
      return "This invite link isn't valid.";
  }
}

export interface InviteOptions {
  /** Seconds until expiry; null = never. */
  expiresInSeconds: number | null;
  maxUses: number | null;
  requiresApproval: boolean;
}

export const INVITE_EXPIRY_CHOICES: { label: string; seconds: number | null }[] = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 7 * 86400 },
  { label: 'Never', seconds: null },
];

export const INVITE_MAX_USES_CHOICES: { label: string; uses: number | null }[] = [
  { label: '1 person', uses: 1 },
  { label: '10 people', uses: 10 },
  { label: '100 people', uses: 100 },
  { label: 'No limit', uses: null },
];

export function expiryFromNow(seconds: number | null, now: number = Date.now()): string | null {
  return seconds == null ? null : new Date(now + seconds * 1000).toISOString();
}

export interface InviteLike {
  revokedAt: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
}

/** Mirrors the server's group_invite_problem(). */
export function inviteState(i: InviteLike, now: number = Date.now()): 'active' | 'revoked' | 'expired' | 'full' {
  if (i.revokedAt) return 'revoked';
  if (i.expiresAt && Date.parse(i.expiresAt) <= now) return 'expired';
  if (i.maxUses != null && i.uses >= i.maxUses) return 'full';
  return 'active';
}
