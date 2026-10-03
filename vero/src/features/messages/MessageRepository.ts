/**
 * Vero Message Repository
 *
 * Send: payload -> encrypt once for every recipient device (incl. our own
 *       other devices) -> insert ciphertext. The server broadcasts it.
 * Receive: ciphertext -> verify sender device key (pinned) -> decrypt ->
 *       apply (message / reaction / timer change) -> local SQLite.
 *
 * The server only ever sees envelopes; the local DB holds the plaintext view.
 */

import { supabase } from '../../core/network/supabase';
import { cryptoManager } from '../../core/crypto/CryptoManager';
import { databaseService } from '../../core/storage/DatabaseService';
import { SessionContext } from '../../core/session';
import { generateUUID } from '../../shared/utils/uuid';
import {
  ConversationMember,
  Message,
  MessageReaction,
  MessageStatus,
  MessageType,
  messagePreview,
} from '../../shared/models/Message';
import { MessagePayload, parsePayload, serverTypeFor, timerLabel, toMessageMedia } from '../../shared/models/payload';
import { extensionContent, extensionPayloadFromMessage, isControlPayload } from '../../shared/models/payloadExtensions';
import { applyExtensionControl, finalizeExtensionMessage } from '../payments/paymentControl';
import { keyDirectory } from '../keys/KeyDirectory';
import { useSettingsStore } from '../settings/useSettingsStore';
import { computeStatus } from './status';
import { decryptFailureText } from './decryptStatus';

export const PAGE_SIZE = 50;

export interface ServerMessageRow {
  id: string;
  conversation_id: string;
  sender_device_id: string;
  sender_user_id: string;
  ciphertext: string;
  message_type: string;
  media_id: string | null;
  reply_to_message_id: string | null;
  created_at: string;
  expires_at: string | null;
  deleted_at?: string | null;
}

/** Result of applying one server row locally. */
export type AppliedRow =
  | { kind: 'message'; message: Message }
  | { kind: 'reaction'; target: Message }
  | { kind: 'deleted'; id: string }
  | { kind: 'ignored' };

const SELECT_COLUMNS =
  'id, conversation_id, sender_device_id, sender_user_id, ciphertext, message_type, media_id, reply_to_message_id, created_at, expires_at, deleted_at';

export interface SendOptions {
  replyTo?: Message | null;
  mediaId?: string;
  /** Local file to show immediately for the sender's own media message. */
  localUri?: string;
}

function contentFor(payload: MessagePayload): Pick<Message, 'content' | 'ext'> & { type: MessageType; media?: Message['media'] } {
  switch (payload.t) {
    case 'text':
      return { type: 'text', content: payload.body };
    case 'media':
      return {
        type: payload.kind,
        content: payload.kind === 'document' ? payload.media.fileName || payload.caption : payload.caption,
      };
    case 'timer':
      return { type: 'system', content: `Disappearing messages: ${timerLabel(payload.seconds)}` };
    default:
      return extensionContent(payload);
  }
}

function applyReaction(list: MessageReaction[] | undefined, userId: string, emoji: string | null): MessageReaction[] {
  const others = (list || []).filter((r) => r.userId !== userId);
  return emoji ? [...others, { userId, emoji }] : others;
}

class MessageRepository {
  // ── Sending ────────────────────────────────────────────────────────────────

  /**
   * Encrypts and sends. `onLocal` fires immediately with the optimistic
   * message (status 'sending') so the UI can render it before the network.
   */
  async send(
    session: SessionContext,
    conversationId: string,
    payload: MessagePayload,
    opts: SendOptions = {},
    onLocal?: (m: Message) => void
  ): Promise<Message> {
    const id = generateUUID();
    const timer = await databaseService.getDisappearingTimer(conversationId);
    const expiresAt =
      timer > 0 && payload.t !== 'timer' ? new Date(Date.now() + timer * 1000).toISOString() : null;
    const { type, content, ext, media: extMedia } = contentFor(payload);
    const control = payload.t === 'reaction' || isControlPayload(payload);

    const local: Message = {
      id,
      conversationId,
      senderDeviceId: session.deviceId,
      senderUserId: session.userId,
      senderName: 'You',
      content,
      messageType: type,
      media: payload.t === 'media' ? { ...payload.media, localUri: opts.localUri } : extMedia ? { ...extMedia, localUri: opts.localUri } : undefined,
      ext,
      replyToMessageId: opts.replyTo?.id ?? null,
      replyPreview: opts.replyTo ? messagePreview(opts.replyTo.messageType, opts.replyTo.content) : null,
      createdAt: new Date().toISOString(),
      expiresAt,
      status: 'sending',
      isOwn: true,
      reactions: [],
    };

    if (!control) {
      await databaseService.saveMessage(local);
      onLocal?.(local);
    }

    if (session.isDemo) {
      const done = { ...local, status: 'read' as MessageStatus };
      if (!control) await databaseService.saveMessage(done);
      return done;
    }

    try {
      await this.deliver(session, local, payload, opts.mediaId ?? null);
      const sent = { ...local, status: 'sent' as MessageStatus };
      if (!control) await databaseService.updateMessageStatus(id, 'sent');
      return sent;
    } catch (e) {
      console.warn('[MessageRepository] send failed:', (e as Error)?.message);
      if (!control) await databaseService.updateMessageStatus(id, 'failed');
      if (control) throw e;
      return { ...local, status: 'failed' };
    }
  }

  private async deliver(
    session: SessionContext,
    local: Message,
    payload: MessagePayload,
    mediaId: string | null
  ): Promise<void> {
    const recipients = await keyDirectory.getConversationRecipients(local.conversationId);
    const ciphertext = await cryptoManager.encryptMessage(
      session.userId,
      JSON.stringify(payload),
      { conversationId: local.conversationId, messageId: local.id, senderDeviceId: session.deviceId },
      recipients
    );
    const { error } = await supabase.from('messages').insert({
      id: local.id,
      conversation_id: local.conversationId,
      sender_device_id: session.deviceId,
      sender_user_id: session.userId,
      ciphertext,
      message_type: serverTypeFor(payload),
      media_id: mediaId,
      reply_to_message_id: local.replyToMessageId,
      expires_at: local.expiresAt,
    });
    if (error) throw error;
  }

  /** Re-sends a failed text/media message with a fresh id. */
  async retry(session: SessionContext, failed: Message, onLocal?: (m: Message) => void): Promise<Message | null> {
    let payload: MessagePayload | null = null;
    if (failed.messageType === 'text' && failed.content) payload = { t: 'text', body: failed.content };
    else if (failed.media && ['image', 'video', 'voice', 'document'].includes(failed.messageType)) {
      payload = { t: 'media', kind: failed.messageType as any, caption: failed.content, media: toMessageMedia(failed.media) };
    } else payload = extensionPayloadFromMessage(failed);
    if (!payload) return null;
    await databaseService.markMessageDeleted(failed.id);
    return this.send(
      session,
      failed.conversationId,
      payload,
      { mediaId: failed.media?.mediaId, localUri: failed.media?.localUri },
      onLocal
    );
  }

  async react(session: SessionContext, target: Message, emoji: string | null): Promise<Message> {
    const reactions = applyReaction(target.reactions, session.userId, emoji);
    await databaseService.setReactions(target.id, reactions);
    const updated = { ...target, reactions };
    await this.send(session, target.conversationId, { t: 'reaction', target: target.id, emoji });
    return updated;
  }

  async setDisappearingTimer(
    session: SessionContext,
    conversationId: string,
    seconds: number,
    onLocal?: (m: Message) => void
  ): Promise<void> {
    await databaseService.setDisappearingTimer(conversationId, seconds);
    await this.send(session, conversationId, { t: 'timer', seconds }, {}, onLocal);
  }

  async deleteForEveryone(session: SessionContext, message: Message): Promise<void> {
    if (!session.isDemo) {
      const { error } = await supabase.rpc('delete_message', { p_message_id: message.id });
      if (error) throw error;
    }
    await databaseService.markMessageDeleted(message.id);
  }

  async deleteForMe(messageId: string): Promise<void> {
    await databaseService.markMessageDeleted(messageId);
  }

  // ── Receiving ──────────────────────────────────────────────────────────────

  /**
   * Pulls a page from the server (newest first), decrypts it into the local
   * DB, then returns the local view. Falls back to local data when offline.
   */
  async loadPage(
    session: SessionContext,
    conversationId: string,
    names: Record<string, string>,
    before?: string
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    if (!session.isDemo) {
      let query = supabase
        .from('messages')
        .select(SELECT_COLUMNS)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);
      if (before) query = query.lt('created_at', before);
      const { data, error } = await query;
      if (!error && data) {
        await this.applyRows(session, (data as ServerMessageRow[]).reverse(), names);
        const messages = await databaseService.getMessages(conversationId, PAGE_SIZE, before);
        return { messages, hasMore: data.length === PAGE_SIZE };
      }
    }
    const messages = await databaseService.getMessages(conversationId, PAGE_SIZE, before);
    return { messages, hasMore: messages.length === PAGE_SIZE };
  }

  /** Fetches anything newer than what we have locally (used for chat list previews). */
  async syncLatest(session: SessionContext, conversationId: string, names: Record<string, string>): Promise<number> {
    if (session.isDemo) return 0;
    const newest = await databaseService.getNewestMessageTime(conversationId);
    let query = supabase
      .from('messages')
      .select(SELECT_COLUMNS)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);
    if (newest) query = query.gt('created_at', newest);
    const { data, error } = await query;
    if (error || !data?.length) return 0;
    await this.applyRows(session, (data as ServerMessageRow[]).reverse(), names);
    await this.markReceipt(conversationId, 'delivered');
    return data.length;
  }

  async fetchOne(session: SessionContext, messageId: string, names: Record<string, string>): Promise<AppliedRow> {
    const { data, error } = await supabase.from('messages').select(SELECT_COLUMNS).eq('id', messageId).maybeSingle();
    if (error || !data) return { kind: 'ignored' };
    const [applied] = await this.applyRows(session, [data as ServerMessageRow], names);
    return applied ?? { kind: 'ignored' };
  }

  /** Decrypts rows (oldest first) and writes them to the local DB. */
  async applyRows(
    session: SessionContext,
    rows: ServerMessageRow[],
    names: Record<string, string>
  ): Promise<AppliedRow[]> {
    const senderKeys = await keyDirectory.getKeys(rows.map((r) => r.sender_device_id));
    const out: AppliedRow[] = [];

    for (const row of rows) {
      if (row.deleted_at) {
        await databaseService.markMessageDeleted(row.id);
        out.push({ kind: 'deleted', id: row.id });
        continue;
      }

      const existing = await databaseService.getMessage(row.id);
      if (existing && existing.messageType !== 'unavailable') {
        if (existing.status === 'sending' || existing.status === 'failed') {
          await databaseService.updateMessageStatus(row.id, 'sent');
          existing.status = 'sent';
        }
        if (!existing.deletedAt) out.push({ kind: 'message', message: existing });
        continue;
      }

      const isOwn = row.sender_user_id === session.userId;
      const base: Message = {
        id: row.id,
        conversationId: row.conversation_id,
        senderDeviceId: row.sender_device_id,
        senderUserId: row.sender_user_id,
        senderName: isOwn ? 'You' : names[row.sender_user_id] || 'Unknown',
        messageType: 'unavailable',
        replyToMessageId: row.reply_to_message_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        status: isOwn ? 'sent' : 'delivered',
        isOwn,
        reactions: [],
      };

      let payload: MessagePayload | null = null;
      const key = senderKeys.get(row.sender_device_id);
      try {
        if (!key || key.userId !== row.sender_user_id) throw new Error('Unknown sender device');
        const plaintext = await cryptoManager.decryptMessage(
          session.userId,
          session.deviceId,
          row.ciphertext,
          { conversationId: row.conversation_id, messageId: row.id, senderDeviceId: row.sender_device_id },
          key.publicKey
        );
        payload = parsePayload(plaintext);
        if (!payload) throw new Error('Unreadable payload');
      } catch (e) {
        base.content = decryptFailureText(e);
        if (row.message_type === 'reaction') {
          out.push({ kind: 'ignored' });
          continue;
        }
        await databaseService.saveMessage(base);
        out.push({ kind: 'message', message: base });
        continue;
      }

      if (isControlPayload(payload)) {
        const target = await applyExtensionControl(row, payload);
        out.push(target ? { kind: 'reaction', target } : { kind: 'ignored' });
        continue;
      }

      if (payload.t === 'reaction') {
        const target = await databaseService.getMessage(payload.target);
        if (target && target.conversationId === row.conversation_id) {
          target.reactions = applyReaction(target.reactions, row.sender_user_id, payload.emoji);
          await databaseService.setReactions(target.id, target.reactions);
          out.push({ kind: 'reaction', target });
        } else {
          out.push({ kind: 'ignored' });
        }
        continue;
      }

      if (payload.t === 'timer' && !isOwn) {
        await databaseService.setDisappearingTimer(row.conversation_id, payload.seconds);
      }

      const { type, content, ext, media: extMedia } = contentFor(payload);
      const replyTarget = row.reply_to_message_id ? await databaseService.getMessage(row.reply_to_message_id) : null;
      const message: Message = {
        ...base,
        messageType: type,
        content: payload.t === 'timer' ? `${isOwn ? 'You' : base.senderName} set ${content?.toLowerCase()}` : content,
        media: payload.t === 'media' ? { ...payload.media } : extMedia ? { ...extMedia } : undefined,
        ext: ext && (await finalizeExtensionMessage(row, ext)),
        replyPreview: replyTarget ? messagePreview(replyTarget.messageType, replyTarget.content) : null,
      };
      await databaseService.saveMessage(message);
      out.push({ kind: 'message', message });
    }
    return out;
  }

  // ── Receipts ───────────────────────────────────────────────────────────────

  async markReceipt(conversationId: string, kind: 'delivered' | 'read'): Promise<void> {
    if (kind === 'read' && !useSettingsStore.getState().readReceipts) kind = 'delivered';
    const { error } = await supabase.rpc('mark_conversation_receipt', {
      p_conversation_id: conversationId,
      p_kind: kind,
    });
    if (error) console.warn('[MessageRepository] receipt failed:', error.message);
  }

  /** Status of one of OUR messages, derived from the other members' watermarks. */
  statusFor(message: Message, members: ConversationMember[], myUserId: string): MessageStatus {
    return computeStatus(message, members, myUserId);
  }
}

export const messageRepository = new MessageRepository();
