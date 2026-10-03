/**
 * Vero Message Repository
 *
 * Handles message sending (with E2EE), fetching, decrypting,
 * and syncing with Supabase Realtime.
 *
 * KEY PRINCIPLE: The server only sees ciphertext. Decryption happens here on-device.
 */

import { supabase } from '../../core/network/supabase';
import { cryptoManager, EncryptedMessage } from '../../core/crypto/CryptoManager';
import { Message, MessageType, MessageStatus, MediaAttachment } from '../../shared/models/Message';
import { conversationRepository } from '../chats/ConversationRepository';
import * as SecureStore from 'expo-secure-store';
import { generateUUID } from '../../shared/utils/uuid';
import { databaseService } from '../../core/storage/DatabaseService';

const DEVICE_ID_KEY = 'vero_device_id';

export interface SendMessageParams {
  conversationId: string;
  plaintext: string;
  messageType?: MessageType;
  replyToMessageId?: string;
  recipientUserId: string;
  mediaAttachment?: MediaAttachment;
}

const DEMO_CHAT_MESSAGES: Record<string, Message[]> = {
  'demo-chat-sarah': [
    {
      id: 'demo-msg-1',
      conversationId: 'demo-chat-sarah',
      senderDeviceId: 'sarah_dev_1',
      senderUserId: 'sarah-connor-01',
      senderProfile: { id: 'sarah-connor-01', displayName: 'Sarah Connor', username: 'sarah_c' },
      content: 'Hey Alex! Did you review the latest E2EE protocol specification?',
      messageType: 'text',
      status: 'read',
      isOwn: false,
      createdAt: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
    },
    {
      id: 'demo-msg-2',
      conversationId: 'demo-chat-sarah',
      senderDeviceId: 'dev_local_primary',
      senderUserId: 'demo-user-id-001',
      senderProfile: { id: 'demo-user-id-001', displayName: 'Alex Chen', username: 'alexchen' },
      content: 'Yes! The X25519 ECDH pairwise exchange and XSalsa20 symmetric encryption are rock solid.',
      messageType: 'text',
      status: 'read',
      isOwn: true,
      createdAt: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
    },
    {
      id: 'demo-msg-3',
      conversationId: 'demo-chat-sarah',
      senderDeviceId: 'sarah_dev_1',
      senderUserId: 'sarah-connor-01',
      senderProfile: { id: 'sarah-connor-01', displayName: 'Sarah Connor', username: 'sarah_c' },
      content: 'Awesome. Verified our 60-digit safety number fingerprint! All green 🔒',
      messageType: 'text',
      status: 'read',
      isOwn: false,
      createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    },
  ],
  'demo-chat-marcus': [
    {
      id: 'demo-msg-m1',
      conversationId: 'demo-chat-marcus',
      senderDeviceId: 'marcus_dev_1',
      senderUserId: 'marcus-vance-02',
      senderProfile: { id: 'marcus-vance-02', displayName: 'Marcus Vance', username: 'marcus_v' },
      content: 'Media attachment encrypted using AES-256-GCM before Drive proxy upload.',
      messageType: 'text',
      status: 'read',
      isOwn: false,
      createdAt: new Date(Date.now() - 1000 * 60 * 50).toISOString(),
    },
    {
      id: 'demo-msg-m2',
      conversationId: 'demo-chat-marcus',
      senderDeviceId: 'dev_local_primary',
      senderUserId: 'demo-user-id-001',
      senderProfile: { id: 'demo-user-id-001', displayName: 'Alex Chen', username: 'alexchen' },
      content: 'Zero knowledge achieved. Google Drive only sees encrypted blobs.',
      messageType: 'text',
      status: 'delivered',
      isOwn: true,
      createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    },
  ],
};

class MessageRepository {
  // ──────────────────────────────────────────────────────────────────────────
  // Send message with E2EE
  // ──────────────────────────────────────────────────────────────────────────

  async sendMessage(params: SendMessageParams): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const senderDeviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
      if (!senderDeviceId) throw new Error('Device not registered');

      // 1. Get recipient's public key
      const recipientPublicKey = await conversationRepository.getRecipientPublicKey(
        params.recipientUserId
      );
      if (!recipientPublicKey) {
        throw new Error('Recipient public key not found - cannot establish E2EE session');
      }

      // 2. Encrypt the message
      const encryptedEnvelope: EncryptedMessage = await cryptoManager.encryptMessage(
        params.plaintext,
        recipientPublicKey
      );

      // 3. Build ciphertext payload (never contains plaintext)
      const ciphertext = JSON.stringify(encryptedEnvelope);

      // 4. Insert into Supabase (only ciphertext)
      const messageId = generateUUID();
      const now = new Date().toISOString();

      const { error } = await supabase
        .from('messages')
        .insert({
          id: messageId,
          conversation_id: params.conversationId,
          sender_device_id: senderDeviceId,
          ciphertext,
          message_type: params.messageType || 'text',
          media_id: params.mediaAttachment?.mediaId || null,
          reply_to_message_id: params.replyToMessageId || null,
        });

      if (error) throw error;

      // Save plaintext locally in SQLite so sender can read own sent message
      const userRes = await supabase.auth.getUser();
      await databaseService.saveMessage({
        id: messageId,
        conversationId: params.conversationId,
        senderDeviceId,
        senderUserId: userRes.data.user?.id,
        content: params.plaintext,
        messageType: params.messageType || 'text',
        media: params.mediaAttachment,
        replyToMessageId: params.replyToMessageId,
        status: 'sent',
        isOwn: true,
        createdAt: now,
      });

      // 5. Update conversation updated_at for ordering
      await supabase
        .from('conversations')
        .update({ updated_at: now })
        .eq('id', params.conversationId);

      return { success: true, messageId };
    } catch (e: any) {
      console.error('[MessageRepository] sendMessage error:', e);
      return { success: false, error: e.message };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Fetch and decrypt messages for a conversation
  // ──────────────────────────────────────────────────────────────────────────

  async getMessages(
    conversationId: string,
    currentUserId: string,
    currentDeviceId: string,
    limit: number = 50,
    beforeDate?: string
  ): Promise<Message[]> {
    try {
      // 1. Instant load from local SQLite database
      const cached = await databaseService.getMessages(conversationId, limit, beforeDate);

      // 2. Fetch from Supabase
      let query = supabase
        .from('messages')
        .select(`
          id,
          conversation_id,
          sender_device_id,
          ciphertext,
          message_type,
          media_id,
          reply_to_message_id,
          created_at,
          expires_at,
          deleted_at,
          devices:sender_device_id (
            user_id,
            profiles:user_id (
              id,
              username,
              display_name,
              avatar_reference
            )
          )
        `)
        .eq('conversation_id', conversationId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (beforeDate) {
        query = query.lt('created_at', beforeDate);
      }

      const { data, error } = await query;
      if (error) {
        // If network error, return cached messages or demo messages
        if (cached.length > 0) return cached;
        return DEMO_CHAT_MESSAGES[conversationId] || [];
      }

      // Decrypt each message and update local cache
      const messages: Message[] = [];
      for (const raw of (data || [])) {
        const message = await this.decryptRawMessage(raw as any, currentUserId, currentDeviceId);
        if (message) {
          // If own message was already stored in local cache, retain plaintext content
          const localMatch = cached.find((c) => c.id === message.id);
          if (localMatch?.content && message.isOwn) {
            message.content = localMatch.content;
          }
          await databaseService.saveMessage(message);
          messages.push(message);
        }
      }

      // Return chronological order
      if (messages.length > 0) return messages.reverse();
      if (cached.length > 0) return cached;
      return DEMO_CHAT_MESSAGES[conversationId] || [];
    } catch (e) {
      console.error('[MessageRepository] getMessages error:', e);
      const fallback = await databaseService.getMessages(conversationId, limit, beforeDate);
      if (fallback.length > 0) return fallback;
      return DEMO_CHAT_MESSAGES[conversationId] || [];
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Decrypt a raw message from Supabase
  // ──────────────────────────────────────────────────────────────────────────

  async decryptRawMessage(
    raw: any,
    currentUserId: string,
    currentDeviceId: string
  ): Promise<Message | null> {
    try {
      const senderUserId = raw.devices?.user_id;
      const senderProfile = raw.devices?.profiles;
      const isOwn = senderUserId === currentUserId;

      let content: string | undefined;
      let status: MessageStatus = 'sent';

      // Only decrypt if the message is for us (or we sent it)
      // Our own messages were encrypted with recipient's key,
      // so we need to store a copy encrypted with our own key in production.
      // For this implementation, we decrypt if we have the session key.
      try {
        const envelope: EncryptedMessage = JSON.parse(raw.ciphertext);
        if (isOwn) {
          // For own messages, we show the plaintext from local cache
          // In a full implementation, sender encrypts a copy for themselves too
          content = '[Sent message]'; // Placeholder until local cache is implemented
          status = 'sent';
        } else {
          const decrypted = await cryptoManager.decryptMessage(envelope);
          content = decrypted.plaintext;
          status = 'read';
        }
      } catch {
        // Decryption failed - show placeholder
        content = undefined;
        status = 'failed';
      }

      return {
        id: raw.id,
        conversationId: raw.conversation_id,
        senderDeviceId: raw.sender_device_id,
        senderUserId,
        senderProfile: senderProfile ? {
          id: senderProfile.id,
          username: senderProfile.username,
          displayName: senderProfile.display_name,
          avatarReference: senderProfile.avatar_reference,
        } : undefined,
        content,
        messageType: raw.message_type,
        replyToMessageId: raw.reply_to_message_id,
        createdAt: raw.created_at,
        expiresAt: raw.expires_at,
        deletedAt: raw.deleted_at,
        status,
        isOwn,
        reactions: [],
      };
    } catch {
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Update receipt status
  // ──────────────────────────────────────────────────────────────────────────

  async markAsRead(messageId: string, deviceId: string): Promise<void> {
    try {
      await supabase
        .from('message_receipts')
        .upsert({
          message_id: messageId,
          device_id: deviceId,
          status: 'read',
          updated_at: new Date().toISOString(),
        });
    } catch (e) {
      console.error('[MessageRepository] markAsRead error:', e);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Delete message
  // ──────────────────────────────────────────────────────────────────────────
  async deleteMessage(messageId: string, forEveryone: boolean = false): Promise<boolean> {
    try {
      if (forEveryone) {
        // Mark as deleted in DB (ciphertext remains but deleted_at is set)
        await supabase
          .from('messages')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', messageId);
      }
      // Always mark as deleted locally in SQLite
      await databaseService.markMessageDeleted(messageId);
      return true;
    } catch {
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Reactions (Section 30 of Plan)
  // ──────────────────────────────────────────────────────────────────────────

  async addReaction(conversationId: string, messageId: string, emoji: string, userId: string): Promise<void> {
    try {
      const channel = supabase.channel(`private:conversation:${conversationId}`);
      await channel.send({
        type: 'broadcast',
        event: 'message.reaction',
        payload: {
          messageId,
          emoji,
          userId,
          createdAt: new Date().toISOString(),
        },
      });
    } catch (e) {
      console.error('[MessageRepository] addReaction error:', e);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Local message search (Section 28 of Plan)
  // ──────────────────────────────────────────────────────────────────────────

  async searchLocalMessages(query: string): Promise<Message[]> {
    return await databaseService.searchMessages(query);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Realtime broadcast helper
  // ──────────────────────────────────────────────────────────────────────────

  async broadcastTyping(conversationId: string, userId: string, isTyping: boolean): Promise<void> {
    try {
      const channel = supabase.channel(`private:conversation:${conversationId}`);
      await channel.send({
        type: 'broadcast',
        event: isTyping ? 'typing.start' : 'typing.stop',
        payload: { userId },
      });
    } catch {
      // Typing indicators are ephemeral, failure is acceptable
    }
  }
}

export const messageRepository = new MessageRepository();
