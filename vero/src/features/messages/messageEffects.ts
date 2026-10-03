/**
 * Local effects of received / sent message events: edits, deletions
 * (for everyone and for me) and attachment cache cleanup. Called from
 * MessageRepository.applyRows and from the message actions.
 */

import { databaseService } from '../../core/storage/DatabaseService';
import { messagingStore } from '../../core/storage/messagingStore';
import type { Message } from '../../shared/models/Message';
import type { EditPayload } from '../../shared/models/messageExtras';
import { isAfter } from '../../shared/utils/time';
import { mediaRepository } from '../media/MediaRepository';
import { isIncomingEditValid, isNewerEdit } from './edits';

function dropCachedMedia(m: Message | null | undefined): void {
  if (m?.media) mediaRepository.deleteCachedFile(m.media);
}

/** Deleted for everyone: keep a "This message was deleted" tombstone, drop content + cached file. */
export async function revokeMessage(id: string, at?: string | null): Promise<Message | null> {
  const before = await messagingStore.revoke(id, at ?? undefined);
  dropCachedMedia(before);
  return before ? databaseService.getMessage(id) : null;
}

/** Delete for me: hidden on this device only. */
export async function hideMessageLocally(id: string): Promise<void> {
  const before = await databaseService.getMessage(id);
  await databaseService.markMessageDeleted(id);
  dropCachedMedia(before);
}

export interface EditRow {
  id: string;
  conversation_id: string;
  sender_user_id: string;
  created_at: string;
}

/**
 * Applies a received `edit` control message. Returns the updated target, or
 * null when it doesn't apply (yet): unknown targets are remembered and
 * applied when the original arrives (see applyPendingEdits).
 */
export async function applyIncomingEdit(row: EditRow, payload: EditPayload): Promise<Message | null> {
  const target = await databaseService.getMessage(payload.targetId);
  const incoming = { conversationId: row.conversation_id, senderUserId: row.sender_user_id, createdAt: row.created_at };
  const valid = target ? isIncomingEditValid(target, incoming) : false;

  if (target && !valid) return null; // wrong sender / chat / too late / deleted: ignore

  await messagingStore.recordEdit({
    id: row.id,
    targetId: payload.targetId,
    conversationId: row.conversation_id,
    senderUserId: row.sender_user_id,
    previousText: target ? (target.content ?? '') : null,
    newText: payload.newText,
    editedAt: row.created_at,
  });
  if (!target) return null;
  if (!isNewerEdit(target.editedAt, row.created_at)) return null; // an older edit arriving late
  await messagingStore.applyEdit(target.id, payload.newText, row.created_at);
  return { ...target, content: payload.newText, editedAt: row.created_at };
}

/** Applies edits that arrived before their original message. */
export async function applyPendingEdits(message: Message): Promise<Message> {
  if (message.messageType === 'unavailable' || message.revokedAt) return message;
  const edits = await messagingStore.getEdits(message.id);
  if (edits.length === 0) return message;
  const valid = edits.filter((e) =>
    isIncomingEditValid(message, { conversationId: e.conversationId, senderUserId: e.senderUserId, createdAt: e.editedAt })
  );
  for (const e of edits) if (!valid.includes(e)) await messagingStore.removeEdit(e.id);
  if (valid.length === 0) return message;

  const earliest = valid.reduce((a, b) => (isAfter(a.editedAt, b.editedAt) ? b : a));
  if (earliest.previousText === null) await messagingStore.setEditPreviousText(earliest.id, message.content ?? '');
  const latest = valid.reduce((a, b) => (isAfter(b.editedAt, a.editedAt) ? b : a));
  if (!isNewerEdit(message.editedAt, latest.editedAt)) return message;
  await messagingStore.applyEdit(message.id, latest.newText, latest.editedAt);
  return { ...message, content: latest.newText, editedAt: latest.editedAt };
}
