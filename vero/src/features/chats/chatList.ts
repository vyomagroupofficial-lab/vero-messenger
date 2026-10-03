/**
 * Chat list rules (pure, unit-tested): previews, unread counts, pin ordering,
 * archive behaviour.
 */

import type { Conversation, Message, MessageType } from '../../shared/models/Message';
import { compareDesc, isAfter } from '../../shared/utils/time';

/** Must match public.pinned_conversation_limit() in 006_messaging.sql. */
export const PINNED_LIMIT = 3;

/** System lines (timer changes, group events) never count as unread. */
const NOT_UNREAD: MessageType[] = ['system'];

/** Body of a preview line (without the sender prefix). */
export function previewBody(m: Pick<Message, 'messageType' | 'content' | 'revokedAt' | 'isOwn'>): string {
  if (m.revokedAt) return m.isOwn ? '🚫 You deleted this message' : '🚫 This message was deleted';
  switch (m.messageType) {
    case 'image':
      return m.content ? `📷 ${m.content}` : '📷 Photo';
    case 'video':
      return m.content ? `🎥 ${m.content}` : '🎥 Video';
    case 'voice':
      return '🎤 Voice message';
    case 'document':
      return `📄 ${m.content || 'Document'}`;
    case 'unavailable':
      return '🔒 Encrypted message';
    default:
      return m.content || '';
  }
}

/**
 * Full preview line: "Alice: 📷 Photo" in groups, "You: hi" for own
 * messages in groups, plain body in direct chats and for system lines.
 */
export function previewLine(
  m: Pick<Message, 'messageType' | 'content' | 'revokedAt' | 'isOwn' | 'senderName'>,
  isGroup: boolean
): string {
  const body = previewBody(m);
  if (!isGroup || m.messageType === 'system' || m.revokedAt) return body;
  const who = m.isOwn ? 'You' : m.senderName || 'Someone';
  return `${who}: ${body}`;
}

/** Does this message count towards the unread badge? */
export function countsAsUnread(
  m: Pick<Message, 'isOwn' | 'messageType' | 'createdAt' | 'deletedAt' | 'revokedAt' | 'expiresAt'>,
  lastReadAt: string | null | undefined,
  nowIso: string = new Date().toISOString()
): boolean {
  if (m.isOwn || m.deletedAt || m.revokedAt) return false;
  if (NOT_UNREAD.includes(m.messageType)) return false;
  if (m.expiresAt && !isAfter(m.expiresAt, nowIso)) return false;
  return !lastReadAt || isAfter(m.createdAt, lastReadAt);
}

/** Unread = messages from others after my read watermark. */
export function computeUnreadCount(
  messages: Pick<Message, 'isOwn' | 'messageType' | 'createdAt' | 'deletedAt' | 'revokedAt' | 'expiresAt'>[],
  lastReadAt: string | null | undefined,
  nowIso?: string
): number {
  return messages.reduce((n, m) => (countsAsUnread(m, lastReadAt, nowIso) ? n + 1 : n), 0);
}

/** Latest timestamp that orders a chat in the list. */
export function activityTime(c: Pick<Conversation, 'lastMessage' | 'updatedAt' | 'createdAt'>): string {
  return c.lastMessage?.createdAt ?? c.updatedAt ?? c.createdAt;
}

/** Pinned first (most recently pinned on top), then by latest activity. */
export function sortConversations<T extends Conversation>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const pa = a.pinnedAt ?? '';
    const pb = b.pinnedAt ?? '';
    if (pa || pb) {
      if (!pa) return 1;
      if (!pb) return -1;
      const byPin = compareDesc(pa, pb);
      if (byPin !== 0) return byPin;
    }
    return compareDesc(activityTime(a), activityTime(b));
  });
}

export function splitArchived<T extends Conversation>(list: T[]): { active: T[]; archived: T[] } {
  const active: T[] = [];
  const archived: T[] = [];
  for (const c of list) (c.archivedAt ? archived : active).push(c);
  return { active, archived };
}

export type PinCheck = { ok: true } | { ok: false; reason: string };

export function canPin(list: Conversation[], conversationId: string): PinCheck {
  const target = list.find((c) => c.id === conversationId);
  if (target?.pinnedAt) return { ok: true };
  const pinned = list.filter((c) => c.pinnedAt && c.id !== conversationId).length;
  if (pinned >= PINNED_LIMIT) return { ok: false, reason: `You can only pin up to ${PINNED_LIMIT} chats.` };
  return { ok: true };
}

/**
 * Archived chats come back to the main list when someone else sends a new
 * message after they were archived, unless the user chose "keep archived".
 */
export function shouldAutoUnarchive(
  archivedAt: string | null | undefined,
  lastIncomingAt: string | null | undefined,
  keepArchived: boolean
): boolean {
  if (keepArchived || !archivedAt || !lastIncomingAt) return false;
  return isAfter(lastIncomingAt, archivedAt);
}

/** Total for the Chats tab badge: unread messages outside archived chats. */
export function totalUnread(list: Pick<Conversation, 'unreadCount' | 'archivedAt'>[]): number {
  return list.reduce((n, c) => (c.archivedAt ? n : n + (c.unreadCount || 0)), 0);
}

export function isMuted(c: Pick<Conversation, 'mutedUntil'>, nowIso: string = new Date().toISOString()): boolean {
  if (!c.mutedUntil) return false;
  return c.mutedUntil === 'infinity' || isAfter(c.mutedUntil, nowIso);
}
