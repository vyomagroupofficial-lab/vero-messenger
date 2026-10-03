/**
 * Invite link host. Set EXPO_PUBLIC_INVITE_HOST (e.g. `vero.example.com`) to
 * share https links that open the app (universal/app links) or the web build.
 * Without it, links use the `vero://join/<token>` scheme.
 */

import { buildInviteUrl, normalizeInviteHost } from './inviteLinks';

export const INVITE_HOST: string | null = normalizeInviteHost(process.env.EXPO_PUBLIC_INVITE_HOST);

export function shareableInviteUrl(token: string): string {
  return buildInviteUrl(token, INVITE_HOST);
}
