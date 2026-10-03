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
import { messagingStore } from '../../core/storage/messagingStore';
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
import type { EditPayload } from '../../shared/models/messageExtras';
import { MessagePayload, parsePayload, serverTypeFor, timerLabel, toMessageMedia } from '../../shared/models/payload';
import { extensionContent, extensionPayloadFromMessage, isControlPayload } from '../../shared/models/payloadExtensions';
import { applyExtensionControl, finalizeExtensionMessage } from '../payments/paymentControl';
import { keyDirectory } from '../keys/KeyDirectory';
import { useSettingsStore } from '../settings/useSettingsStore';
import { receiptKindToSend, visibleStatus } from '../settings/privacy';
import { computeStatus } from './status';
import { applyIncomingEdit, applyPendingEdits, hideMessageLocally, revokeMessage } from './messageEffects';
import { decryptFailureText } from './decryptStatus';

export const PAGE_SIZE = 50;
const SYNC_MAX_PAGES = 6;

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
  | { kind: 'edited'; target: Message }
  /** Deleted for everyone; `tombstone` is the "This message was deleted" placeholder to show. */
  | { kind: 'deleted'; id: string; tombstone?: Message | null }
  | { kind: 'ignored' };

/** Payloads that show up as a message bubble (reactions and edits modify other messages). */
const isVisiblePayload = (p: MessagePayload) => p.t !== 'reaction' && p.t !== 'edit' && !isControlPayload(p);

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
      forwardCount: payload.t === 'text' || payload.t === 'media' ? payload.fwd : undefined,
    };
    const visible = isVisiblePayload(payload);

    if (visible) {
      await databaseService.saveMessage(local);
      onLocal?.(local);
    }

    if (session.isDemo) {
      const done = { ...local, status: 'read' as MessageStatus };
      if (visible) await databaseService.saveMessage(done);
      return done;
    }

    try {
      const serverAt = await this.deliver(session, local, payload, opts.mediaId ?? null);
      // Adopt the server's timestamp: receipts, ordering and sync cursors all use server time.
      const sent = { ...local, status: 'sent' as MessageStatus, createdAt: serverAt ?? local.createdAt };
      if (visible) await messagingStore.confirmSent(id, serverAt);
      return sent;
    } catch (e) {
      console.warn('[MessageRepository] send failed:', (e as Error)?.message);
      if (!visible) throw e;
      await databaseService.updateMessageStatus(id, 'failed');
      return { ...local, status: 'failed' };
    }
  }

  /**
   * Sends an encrypted control payload (e.g. an edit) that changes another
   * message instead of showing up itself. Returns the control row id and its
   * server time. Throws on failure.
   */
  async sendControl(
    session: SessionContext,
    conversationId: string,
    payload: EditPayload,
    expiresAt: string | null
  ): Promise<{ id: string; createdAt: string }> {
    const control: Message = {
      id: generateUUID(),
      conversationId,
      senderDeviceId: session.deviceId,
      senderUserId: session.userId,
      messageType: 'system',
      createdAt: new Date().toISOString(),
      expiresAt,
      status: 'sending',
      isOwn: true,
    };
    if (session.isDemo) return { id: control.id, createdAt: control.createdAt };
    const serverAt = await this.deliver(session, control, payload, null);
    return { id: control.id, createdAt: serverAt ?? control.createdAt };
  }

  private async deliver(
    session: SessionContext,
    local: Message,
    payload: MessagePayload,
    mediaId: string | null
  ): Promise<string | null> {
    const recipients = await keyDirectory.getConversationRecipients(local.conversationId);
    const ciphertext = await cryptoManager.encryptMessage(
      session.userId,
      JSON.stringify(payload),
      { conversationId: local.conversationId, messageId: local.id, senderDeviceId: session.deviceId },
      recipients
    );
    const { data, error } = await supabase.from('messages').insert({
      id: local.id,
      conversation_id: local.conversationId,
      sender_device_id: session.deviceId,
      sender_user_id: session.userId,
      ciphertext,
      message_type: serverTypeFor(payload),
      media_id: mediaId,
      reply_to_message_id: local.replyToMessageId,
      expires_at: local.expiresAt,
    }).select('created_at').maybeSingle();
    if (error) throw error;
    return (data as { created_at?: string } | null)?.created_at ?? null;
  }

  /**
   * Re-sends a failed text/media message with the SAME id, so a send that
   * actually reached the server before the error (e.g. lost response) is
   * deduplicated instead of appearing twice.
   */
  async retry(session: SessionContext, failed: Message, onLocal?: (m: Message) => void): Promise<Message | null> {
    let payload: MessagePayload | null = null;
    const fwd = failed.forwardCount || undefined;
    if (failed.messageType === 'text' && failed.content) payload = { t: 'text', body: failed.content, ...(fwd ? { fwd } : {}) };
    else if (failed.media && ['image', 'video', 'voice', 'document'].includes(failed.messageType)) {
      const caption = failed.messageType === 'document' ? undefined : failed.content;
      payload = { t: 'media', kind: failed.messageType as any, caption, media: toMessageMedia(failed.media), ...(fwd ? { fwd } : {}) };
    } else payload = extensionPayloadFromMessage(failed);
    if (!payload) return null;

    const sending: Message = { ...failed, status: 'sending' };
    await databaseService.updateMessageStatus(failed.id, 'sending');
    onLocal?.(sending);
    if (session.isDemo) {
      await databaseService.updateMessageStatus(failed.id, 'read');
      return { ...failed, status: 'read' };
    }
    try {
      const serverAt = await this.deliver(session, sending, payload, failed.media?.mediaId ?? null);
      await messagingStore.confirmSent(failed.id, serverAt);
      return { ...failed, status: 'sent', createdAt: serverAt ?? failed.createdAt };
    } catch (e) {
      if ((e as { code?: string })?.code === '23505') {
        // Already on the server: the earlier attempt went through.
        await messagingStore.confirmSent(failed.id, null);
        return { ...failed, status: 'sent' };
      }
      console.warn('[MessageRepository] retry failed:', (e as Error)?.message);
      await databaseService.updateMessageStatus(failed.id, 'failed');
      return { ...failed, status: 'failed' };
    }
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

  /** Server-side delete (48 h window, 006) + local tombstone. Returns the tombstone. */
  async deleteForEveryone(session: SessionContext, message: Message): Promise<Message | null> {
    if (!session.isDemo) {
      const { error } = await supabase.rpc('delete_message', { p_message_id: message.id });
      if (error) throw error;
    }
    return revokeMessage(message.id);
  }

  async deleteForMe(messageId: string): Promise<void> {
    await hideMessageLocally(messageId);
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

  /**
   * Fetches anything newer than what we have locally (chat list previews and
   * unread counts). Walks back up to SYNC_MAX_PAGES pages so a long offline
   * period doesn't leave a gap; first sync of a chat takes only the newest page.
   */
  async syncLatest(session: SessionContext, conversationId: string, names: Record<string, string>): Promise<number> {
    if (session.isDemo) return 0;
    const newest = await databaseService.getNewestMessageTime(conversationId);
    let applied = 0;
    let before: string | null = null;
    for (let page = 0; page < SYNC_MAX_PAGES; page++) {
      let query = supabase
        .from('messages')
        .select(SELECT_COLUMNS)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);
      if (newest) query = query.gt('created_at', newest);
      if (before) query = query.lt('created_at', before);
      const { data, error } = await query;
      if (error || !data?.length) break;
      const rows = data as ServerMessageRow[];
      await this.applyRows(session, [...rows].reverse(), names);
      applied += rows.length;
      if (!newest || rows.length < PAGE_SIZE) break;
      before = rows[rows.length - 1].created_at;
    }
    if (applied > 0) await this.markReceipt(conversationId, 'delivered');
    return applied;
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
      const isOwn = row.sender_user_id === session.userId;

      if (row.deleted_at) {
        out.push(await this.applyDeletedRow(session, row, names));
        continue;
      }

      const existing = await databaseService.getMessage(row.id);
      if (existing && existing.messageType !== 'unavailable') {
        if (existing.status === 'sending' || existing.status === 'failed') {
          await messagingStore.confirmSent(row.id, row.created_at);
          existing.status = 'sent';
          existing.createdAt = row.created_at;
        }
        if (!existing.deletedAt) out.push({ kind: 'message', message: existing });
        continue;
      }

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
        if (row.message_type === 'reaction' || row.message_type === 'control') {
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

      if (payload.t === 'edit') {
        const target = await applyIncomingEdit(row, payload);
        out.push(target ? { kind: 'edited', target } : { kind: 'ignored' });
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
        forwardCount: payload.t === 'text' || payload.t === 'media' ? payload.fwd : undefined,
      };
      await databaseService.saveMessage(message);
      out.push({ kind: 'message', message: await applyPendingEdits(message) });
    }
    return out;
  }

  /** A row deleted for everyone: tombstone the local copy (or create one for a text/media row we never saw). */
  private async applyDeletedRow(
    session: SessionContext,
    row: ServerMessageRow,
    names: Record<string, string>
  ): Promise<AppliedRow> {
    const existing = await databaseService.getMessage(row.id);
    if (existing) {
      const tombstone = existing.revokedAt ? existing : await revokeMessage(row.id, row.deleted_at);
      return { kind: 'deleted', id: row.id, tombstone: tombstone && !tombstone.deletedAt ? tombstone : null };
    }
    if (row.message_type !== 'text' && row.message_type !== 'media') return { kind: 'deleted', id: row.id };
    const isOwn = row.sender_user_id === session.userId;
    const tombstone: Message = {
      id: row.id,
      conversationId: row.conversation_id,
      senderDeviceId: row.sender_device_id,
      senderUserId: row.sender_user_id,
      senderName: isOwn ? 'You' : names[row.sender_user_id] || 'Unknown',
      messageType: 'text',
      createdAt: row.created_at,
      expiresAt: null,
      status: isOwn ? 'sent' : 'delivered',
      isOwn,
      reactions: [],
      revokedAt: row.deleted_at,
    };
    await databaseService.saveMessage(tombstone);
    return { kind: 'deleted', id: row.id, tombstone };
  }

  // ── Receipts ───────────────────────────────────────────────────────────────

  async markReceipt(conversationId: string, kind: 'delivered' | 'read'): Promise<void> {
    kind = receiptKindToSend(kind, useSettingsStore.getState());
    const { error } = await supabase.rpc('mark_conversation_receipt', {
      p_conversation_id: conversationId,
      p_kind: kind,
    });
    if (error) console.warn('[MessageRepository] receipt failed:', error.message);
  }

  /** Status of one of OUR messages, derived from the other members' watermarks. */
  statusFor(message: Message, members: ConversationMember[], myUserId: string): MessageStatus {
    // Read receipts off: other people's read ticks are hidden too (reciprocal).
    return visibleStatus(computeStatus(message, members, myUserId), useSettingsStore.getState());
  }
}

export const messageRepository = new MessageRepository();
