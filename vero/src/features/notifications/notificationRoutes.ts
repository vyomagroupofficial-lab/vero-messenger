/**
 * Where a tapped notification should take the user. Pure; unit-tested.
 * Payloads come from supabase/functions/_shared/pushPayload.ts and carry ids only.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NotificationRoute =
  | { pathname: '/chat/[id]'; params: { id: string } }
  | { pathname: '/call/[id]'; params: { id: string } }
  | { pathname: '/channels/[id]'; params: { id: string } };

const isId = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export function routeForNotification(data: unknown): NotificationRoute | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  switch (d.type) {
    case 'message':
      return isId(d.conversationId) ? { pathname: '/chat/[id]', params: { id: d.conversationId } } : null;
    case 'call':
      return isId(d.callId) ? { pathname: '/call/[id]', params: { id: d.callId } } : null;
    case 'channel_post':
      return isId(d.channelId) ? { pathname: '/channels/[id]', params: { id: d.channelId } } : null;
    default:
      return null;
  }
}

/**
 * Whether a notification that arrives while the app is open should be shown.
 * Messages for the chat on screen or for a muted chat are not.
 */
export function shouldPresentInForeground(
  data: unknown,
  ctx: { openConversationId: string | null; isMuted: (conversationId: string) => boolean }
): boolean {
  if (!data || typeof data !== 'object') return true;
  const d = data as Record<string, unknown>;
  if (d.type === 'message' && typeof d.conversationId === 'string') {
    if (d.conversationId === ctx.openConversationId) return false;
    if (ctx.isMuted(d.conversationId)) return false;
  }
  // Incoming calls are shown by the call screen itself while the app is open.
  if (d.type === 'call') return false;
  return true;
}
