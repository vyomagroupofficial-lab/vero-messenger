/**
 * Group events (membership / role / info changes) are logged server-side by
 * triggers and rendered client-side as system messages in the chat. They are
 * server-visible metadata (like membership itself), not message content.
 *
 * Pure module: mapping + wording only.
 */

import type { Message } from '../../shared/models/Message';
import type { GroupEvent, GroupEventType } from './types';

const EVENT_TYPES: GroupEventType[] = [
  'created',
  'added',
  'joined',
  'left',
  'removed',
  'promoted',
  'demoted',
  'owner_changed',
  'renamed',
  'description_changed',
  'avatar_changed',
  'settings_changed',
];

/** Maps a server row (REST or realtime payload). Returns null if malformed. */
export function parseGroupEvent(row: any): GroupEvent | null {
  if (!row || typeof row !== 'object') return null;
  if (typeof row.id !== 'string' || typeof row.conversation_id !== 'string') return null;
  if (!EVENT_TYPES.includes(row.event_type)) return null;
  if (typeof row.created_at !== 'string') return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    actorId: typeof row.actor_id === 'string' ? row.actor_id : null,
    targetId: typeof row.target_id === 'string' ? row.target_id : null,
    eventType: row.event_type,
    details: row.details && typeof row.details === 'object' ? row.details : {},
    createdAt: row.created_at,
    actorName: row.actor?.display_name ?? null,
    targetName: row.target?.display_name ?? null,
  };
}

/** "You added Bob", "Alice made you an admin", ... */
export function describeGroupEvent(
  ev: GroupEvent,
  names: Record<string, string>,
  myUserId: string | null
): string {
  const who = (id: string | null, fallback?: string | null, capital = true): string => {
    if (id && id === myUserId) return capital ? 'You' : 'you';
    return (id && names[id]) || fallback || (capital ? 'Someone' : 'someone');
  };
  const actor = who(ev.actorId, ev.actorName);
  const target = who(ev.targetId, ev.targetName, false);
  const via = ev.details?.via;

  switch (ev.eventType) {
    case 'created':
      return `${actor} created the group`;
    case 'added':
      return via === 'request'
        ? `${actor} approved ${target}'s request to join`
        : via === 'community'
          ? `${capitalize(target)} joined from the community`
          : `${actor} added ${target}`;
    case 'joined':
      return via === 'invite'
        ? `${capitalize(target)} joined using an invite link`
        : via === 'community'
          ? `${capitalize(target)} joined from the community`
          : `${capitalize(target)} joined`;
    case 'left':
      return `${capitalize(target)} left`;
    case 'removed':
      return `${actor} removed ${target}`;
    case 'promoted':
      return `${actor} made ${target} an admin`;
    case 'demoted':
      return ev.actorId && ev.actorId === ev.targetId
        ? `${actor} ${actor === 'You' ? 'are' : 'is'} no longer an admin`
        : `${actor} dismissed ${target} as admin`;
    case 'owner_changed':
      return `${capitalize(target)} ${target === 'you' ? 'are' : 'is'} now the group owner`;
    case 'renamed': {
      const name = typeof ev.details?.name === 'string' ? ev.details.name : null;
      return name ? `${actor} renamed the group to "${name}"` : `${actor} renamed the group`;
    }
    case 'description_changed':
      return `${actor} changed the group description`;
    case 'avatar_changed':
      return ev.details?.removed ? `${actor} removed the group photo` : `${actor} changed the group photo`;
    case 'settings_changed': {
      const d = ev.details || {};
      const parts: string[] = [];
      if (typeof d.only_admins_send === 'boolean')
        parts.push(d.only_admins_send ? 'only admins can send messages' : 'all members can send messages');
      return parts.length ? `${actor} changed group settings: ${parts.join(', ')}` : `${actor} changed group settings`;
    }
  }
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Local-only system message for the chat timeline (id = event id, so idempotent). */
export function groupEventToMessage(
  ev: GroupEvent,
  names: Record<string, string>,
  myUserId: string | null
): Message {
  return {
    id: ev.id,
    conversationId: ev.conversationId,
    senderDeviceId: 'group-event',
    senderUserId: ev.actorId ?? 'system',
    senderName: ev.actorId ? names[ev.actorId] || ev.actorName || undefined : undefined,
    content: describeGroupEvent(ev, names, myUserId),
    messageType: 'system',
    createdAt: ev.createdAt,
    status: 'read',
    // Treated as "own" so system lines never count as unread.
    isOwn: true,
    reactions: [],
  };
}
