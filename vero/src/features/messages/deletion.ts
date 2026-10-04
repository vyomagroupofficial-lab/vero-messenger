/**
 * Delete-for-everyone rule (pure, unit-tested). The server enforces the same
 * window in delete_message() (006_messaging.sql).
 */

import type { Message } from '../../shared/models/Message';
import { toMillis } from '../../shared/utils/time';

export const DELETE_FOR_EVERYONE_WINDOW_MS = 48 * 60 * 60 * 1000;

export function canDeleteForEveryone(m: Message, myUserId: string, nowMs: number = Date.now()): boolean {
  if (!m.isOwn || m.senderUserId !== myUserId || m.revokedAt || m.deletedAt) return false;
  if (m.status === 'sending' || m.status === 'failed') return false;
  const sent = toMillis(m.createdAt);
  return Number.isFinite(sent) && nowMs - sent <= DELETE_FOR_EVERYONE_WINDOW_MS;
}
