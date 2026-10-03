/**
 * Sender-side message actions: edit, delete for everyone (with its edit
 * records), forward, star, and catching up on deletions after being offline.
 */

import { supabase } from '../../core/network/supabase';
import { databaseService } from '../../core/storage/DatabaseService';
import { messagingStore } from '../../core/storage/messagingStore';
import { SessionContext } from '../../core/session';
import type { Message } from '../../shared/models/Message';
import { toIso, toMillis } from '../../shared/utils/time';
import { canEditMessage, normalizeEditText } from './edits';
import { canDeleteForEveryone, DELETE_FOR_EVERYONE_WINDOW_MS } from './deletion';
import { buildForwardPayload, checkForwardSelection } from './forward';
import { messageRepository, ServerMessageRow } from './MessageRepository';
import { revokeMessage } from './messageEffects';
import { selfSync } from './selfSync';

export class MessageActionError extends Error {}


/**
 * Edits the text/caption of one of our messages. Applied locally at once and
 * reverted if the encrypted edit can't be sent. Returns the updated message.
 */
export async function editMessage(session: SessionContext, target: Message, newText: string): Promise<Message> {
  const check = canEditMessage(target, session.userId);
  if (!check.ok) throw new MessageActionError(check.reason);
  const text = normalizeEditText(target, newText);
  if (text === null) return target;

  const localAt = new Date().toISOString();
  const previous = { content: target.content ?? null, editedAt: target.editedAt ?? null };
  await messagingStore.applyEdit(target.id, text, localAt);
  try {
    const sent = await messageRepository.sendControl(
      session,
      target.conversationId,
      { t: 'edit', targetId: target.id, newText: text, editedAt: localAt },
      target.expiresAt ?? null
    );
    await messagingStore.recordEdit({
      id: sent.id,
      targetId: target.id,
      conversationId: target.conversationId,
      senderUserId: session.userId,
      previousText: previous.content ?? '',
      newText: text,
      editedAt: sent.createdAt,
    });
    await messagingStore.applyEdit(target.id, text, sent.createdAt);
    return { ...target, content: text, editedAt: sent.createdAt };
  } catch (e) {
    await messagingStore.revertEdit(target.id, previous.content, previous.editedAt);
    throw e;
  }
}

/**
 * Deletes for everyone. Also deletes our edit control messages for it, so
 * the old/new texts don't linger on the server as ciphertext.
 */
export async function deleteForEveryone(session: SessionContext, message: Message): Promise<Message | null> {
  if (!canDeleteForEveryone(message, session.userId)) {
    throw new MessageActionError('Messages can only be deleted for everyone within 48 hours of sending.');
  }
  const edits = (await messagingStore.getEdits(message.id)).filter((e) => e.senderUserId === session.userId);
  const tombstone = await messageRepository.deleteForEveryone(session, message);
  if (!session.isDemo) {
    for (const e of edits) {
      const { error } = await supabase.rpc('delete_message', { p_message_id: e.id });
      if (error) console.warn('[messageActions] could not delete edit record:', error.message);
    }
  }
  return tombstone;
}

export interface ForwardResult {
  sent: Message[];
  failed: number;
}

/**
 * Forwards messages (oldest first) to each chat. Media is not re-uploaded:
 * forward_media() authorises the existing encrypted blob for the target chat
 * and the file key is re-wrapped inside the new E2EE payload.
 */
export async function forwardMessages(
  session: SessionContext,
  messages: Message[],
  conversationIds: string[],
  sendOne: (conversationId: string, payload: NonNullable<ReturnType<typeof buildForwardPayload>>, mediaId?: string, localUri?: string) => Promise<Message | null>
): Promise<ForwardResult> {
  const check = checkForwardSelection(messages, conversationIds.length);
  if (!check.ok) throw new MessageActionError(check.reason);
  if (session.isDemo && messages.some((m) => m.media)) {
    throw new MessageActionError('Attachments need a real account to be forwarded.');
  }
  const ordered = [...messages].sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));
  const sent: Message[] = [];
  let failed = 0;
  for (const conversationId of conversationIds) {
    for (const m of ordered) {
      try {
        let mediaId: string | undefined;
        if (m.media) {
          const { data, error } = await supabase.rpc('forward_media', {
            p_media_id: m.media.mediaId,
            p_conversation_id: conversationId,
          });
          if (error) throw error;
          mediaId = data as string;
        }
        const payload = buildForwardPayload(m, mediaId);
        if (!payload) throw new MessageActionError('Message can’t be forwarded');
        const result = await sendOne(conversationId, payload, mediaId, m.media?.localUri);
        if (!result || result.status === 'failed') failed++;
        else sent.push(result);
      } catch (e) {
        console.warn('[messageActions] forward failed:', (e as Error)?.message);
        failed++;
      }
    }
  }
  return { sent, failed };
}

/** Stars / unstars locally and syncs the change (encrypted) to our other devices. */
export async function setStarred(session: SessionContext, messages: Message[], starred: boolean): Promise<void> {
  const at = new Date().toISOString();
  const items = messages.filter((m) => !m.revokedAt);
  await messagingStore.setStars(
    items.map((m) => ({ messageId: m.id, conversationId: m.conversationId, starred, updatedAt: at }))
  );
  try {
    await selfSync.publishStars(
      session,
      items.map((m) => ({ id: m.id, c: m.conversationId, s: starred, at }))
    );
  } catch (e) {
    // Stars stay on this device; other devices catch up the next time this one stars something.
    console.warn('[messageActions] star sync failed:', (e as Error)?.message);
  }
}

const DELETION_CURSOR = 'deletions_cursor';
const DELETION_OVERLAP_MS = 5 * 60 * 1000;

/**
 * Devices that were offline when a message was deleted for everyone catch up
 * here: rows with deleted_at newer than the last sync (RLS: my chats only).
 * Returns the ids of conversations that changed.
 */
export async function syncDeletions(session: SessionContext): Promise<Set<string>> {
  const changed = new Set<string>();
  if (session.isDemo) return changed;
  let cursor = await messagingStore.getState(DELETION_CURSOR);
  // Deletions are only possible within 48 h of sending, so a fresh device only needs that far back.
  if (!cursor) cursor = new Date(Date.now() - DELETE_FOR_EVERYONE_WINDOW_MS - 60 * 60 * 1000).toISOString();

  for (let page = 0; page < 5; page++) {
    const since = new Date(toMillis(cursor) - DELETION_OVERLAP_MS).toISOString();
    const { data, error } = await supabase
      .from('messages')
      .select(
        'id, conversation_id, sender_device_id, sender_user_id, ciphertext, message_type, media_id, reply_to_message_id, created_at, expires_at, deleted_at'
      )
      .not('deleted_at', 'is', null)
      .gt('deleted_at', since)
      .order('deleted_at', { ascending: true })
      .limit(200);
    if (error) {
      console.warn('[messageActions] deletion sync failed:', error.message);
      break;
    }
    const rows = (data ?? []) as ServerMessageRow[];
    for (const row of rows) {
      const local = await databaseService.getMessage(row.id);
      if (local && !local.revokedAt) {
        await revokeMessage(row.id, row.deleted_at);
        changed.add(row.conversation_id);
      }
    }
    const last = rows[rows.length - 1]?.deleted_at;
    if (last && toMillis(last) > toMillis(cursor)) cursor = toIso(last);
    if (rows.length < 200) break;
  }
  await messagingStore.setState(DELETION_CURSOR, cursor);
  return changed;
}
