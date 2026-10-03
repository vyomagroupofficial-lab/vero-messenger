/**
 * State for the open conversation: messages, members (for receipts and
 * names), typing indicators and the private realtime channel.
 */

import { create } from 'zustand';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../../core/network/supabase';
import { privateChannel } from '../../core/network/realtime';
import { currentSession, requireSession } from '../../core/session';
import { databaseService } from '../../core/storage/DatabaseService';
import { Conversation, ConversationMember, Message } from '../../shared/models/Message';
import { MessagePayload } from '../../shared/models/payload';
import { conversationRepository } from '../chats/ConversationRepository';
import { memberNames, useChatsStore } from '../chats/useChatsStore';
import { useSettingsStore } from '../settings/useSettingsStore';
import { mayBroadcastTyping } from '../settings/privacy';
import { mediaRepository } from '../media/MediaRepository';
import { messageRepository, SendOptions, ServerMessageRow } from './MessageRepository';

const TYPING_TTL_MS = 6000;

export interface ChatState {
  conversation: Conversation | null;
  messages: Message[];
  isLoading: boolean;
  isLoadingOlder: boolean;
  hasMore: boolean;
  /** userId -> expiry timestamp */
  typing: Record<string, number>;
  timerSeconds: number;
}

const emptyChat = (): ChatState => ({
  conversation: null,
  messages: [],
  isLoading: true,
  isLoadingOlder: false,
  hasMore: false,
  typing: {},
  timerSeconds: 0,
});

interface MessagesState {
  chats: Record<string, ChatState>;
  open: (conversationId: string) => Promise<void>;
  close: (conversationId: string) => void;
  loadOlder: (conversationId: string) => Promise<void>;
  send: (conversationId: string, payload: MessagePayload, opts?: SendOptions) => Promise<Message | null>;
  retry: (message: Message) => Promise<void>;
  react: (message: Message, emoji: string | null) => Promise<void>;
  deleteMessage: (message: Message, forEveryone: boolean) => Promise<void>;
  setTimer: (conversationId: string, seconds: number) => Promise<void>;
  clearLocalHistory: (conversationId: string) => Promise<void>;
  sendTyping: (conversationId: string, isTyping: boolean) => void;
  upsert: (conversationId: string, message: Message) => void;
  remove: (conversationId: string, messageId: string) => void;
}

const channels: Record<string, RealtimeChannel> = {};

export const useMessagesStore = create<MessagesState>((set, get) => {
  const patch = (id: string, fn: (c: ChatState) => Partial<ChatState>) =>
    set((s) => {
      const chat = s.chats[id] ?? emptyChat();
      return { chats: { ...s.chats, [id]: { ...chat, ...fn(chat) } } };
    });

  const names = (id: string) => memberNames(get().chats[id]?.conversation ?? undefined);

  const markRead = async (conversationId: string) => {
    await databaseService.markConversationRead(conversationId);
    const session = currentSession();
    if (session && !session.isDemo) await messageRepository.markReceipt(conversationId, 'read');
    void useChatsStore.getState().refreshLocal();
  };

  const refreshMembers = async (conversationId: string) => {
    const session = currentSession();
    if (!session || session.isDemo) return;
    const conversation = await conversationRepository.getConversation(conversationId, session.userId);
    if (conversation) patch(conversationId, () => ({ conversation }));
  };

  const subscribe = (conversationId: string) => {
    if (channels[conversationId]) return;
    const channel = privateChannel(`conversation:${conversationId}`);

    channel
      .on('broadcast', { event: 'message.new' }, async ({ payload }) => {
        const session = currentSession();
        if (!session) return;
        const [applied] = await messageRepository.applyRows(session, [payload as ServerMessageRow], names(conversationId));
        if (applied?.kind === 'message') get().upsert(conversationId, applied.message);
        if (applied?.kind === 'reaction') get().upsert(conversationId, applied.target);
        if (applied && !(applied.kind === 'message' && applied.message.isOwn)) void markRead(conversationId);
      })
      .on('broadcast', { event: 'message.deleted' }, async ({ payload }) => {
        if (!payload?.id) return;
        await databaseService.markMessageDeleted(payload.id);
        get().remove(conversationId, payload.id);
      })
      .on('broadcast', { event: 'receipt' }, ({ payload }) => {
        if (!payload?.user_id) return;
        patch(conversationId, (c) => {
          if (!c.conversation) return {};
          const members = c.conversation.members.map((m): ConversationMember =>
            m.id !== payload.user_id
              ? m
              : {
                  ...m,
                  lastDeliveredAt: payload.at,
                  lastReadAt: payload.kind === 'read' ? payload.at : m.lastReadAt,
                }
          );
          return { conversation: { ...c.conversation, members } };
        });
      })
      .on('broadcast', { event: 'members.changed' }, () => void refreshMembers(conversationId))
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        const me = currentSession()?.userId;
        if (!payload?.userId || payload.userId === me) return;
        patch(conversationId, (c) => {
          const typing = { ...c.typing };
          if (payload.typing) typing[payload.userId] = Date.now() + TYPING_TTL_MS;
          else delete typing[payload.userId];
          return { typing };
        });
      })
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR') console.warn('[Realtime] conversation channel error', err?.message);
        // Catch up on anything missed while (re)connecting.
        if (status === 'SUBSCRIBED') {
          const session = currentSession();
          if (session) {
            void messageRepository.syncLatest(session, conversationId, names(conversationId)).then(async (n) => {
              if (n > 0) {
                const fresh = await databaseService.getMessages(conversationId);
                patch(conversationId, () => ({ messages: fresh }));
                void markRead(conversationId);
              }
            });
          }
        }
      });

    channels[conversationId] = channel;
  };

  return {
    chats: {},

    open: async (conversationId) => {
      const session = requireSession();
      useChatsStore.getState().setOpenConversation(conversationId);
      patch(conversationId, () => ({ isLoading: true, typing: {} }));

      await databaseService.purgeExpired();
      void mediaRepository.sweepCache(); // decrypted files of expired/deleted messages
      const cachedConv = useChatsStore.getState().conversations.find((c) => c.id === conversationId) ?? null;
      const cachedMessages = await databaseService.getMessages(conversationId);
      patch(conversationId, () => ({
        conversation: cachedConv,
        messages: cachedMessages,
        isLoading: cachedMessages.length === 0,
      }));

      const [conversation, timerSeconds] = await Promise.all([
        session.isDemo
          ? Promise.resolve(cachedConv)
          : conversationRepository.getConversation(conversationId, session.userId).catch(() => cachedConv),
        databaseService.getDisappearingTimer(conversationId),
      ]);
      patch(conversationId, () => ({ conversation: conversation ?? cachedConv, timerSeconds }));

      const page = await messageRepository.loadPage(session, conversationId, names(conversationId));
      patch(conversationId, () => ({ messages: page.messages, hasMore: page.hasMore, isLoading: false }));

      if (!session.isDemo) subscribe(conversationId);
      void markRead(conversationId);
    },

    close: (conversationId) => {
      if (useChatsStore.getState().openConversationId === conversationId) {
        useChatsStore.getState().setOpenConversation(null);
      }
      const channel = channels[conversationId];
      if (channel) {
        void supabase.removeChannel(channel);
        delete channels[conversationId];
      }
      void useChatsStore.getState().refreshLocal();
    },

    loadOlder: async (conversationId) => {
      const chat = get().chats[conversationId];
      if (!chat || !chat.hasMore || chat.isLoadingOlder || chat.messages.length === 0) return;
      patch(conversationId, () => ({ isLoadingOlder: true }));
      try {
        const page = await messageRepository.loadPage(
          requireSession(),
          conversationId,
          names(conversationId),
          chat.messages[0].createdAt
        );
        patch(conversationId, (c) => {
          const known = new Set(c.messages.map((m) => m.id));
          return {
            messages: [...page.messages.filter((m) => !known.has(m.id)), ...c.messages],
            hasMore: page.hasMore,
          };
        });
      } finally {
        patch(conversationId, () => ({ isLoadingOlder: false }));
      }
    },

    send: async (conversationId, payload, opts) => {
      const session = requireSession();
      const result = await messageRepository.send(session, conversationId, payload, opts, (local) =>
        get().upsert(conversationId, local)
      );
      if (payload.t !== 'reaction') get().upsert(conversationId, result);
      void useChatsStore.getState().refreshLocal();
      return result;
    },

    retry: async (message) => {
      get().remove(message.conversationId, message.id);
      const result = await messageRepository.retry(requireSession(), message, (local) =>
        get().upsert(message.conversationId, local)
      );
      if (result) get().upsert(message.conversationId, result);
    },

    react: async (message, emoji) => {
      const updated = await messageRepository.react(requireSession(), message, emoji);
      get().upsert(message.conversationId, updated);
    },

    deleteMessage: async (message, forEveryone) => {
      const session = requireSession();
      if (forEveryone) await messageRepository.deleteForEveryone(session, message);
      else await messageRepository.deleteForMe(message.id);
      mediaRepository.evict(message.media);
      get().remove(message.conversationId, message.id);
      void useChatsStore.getState().refreshLocal();
    },

    setTimer: async (conversationId, seconds) => {
      patch(conversationId, () => ({ timerSeconds: seconds }));
      await messageRepository.setDisappearingTimer(requireSession(), conversationId, seconds, (local) =>
        get().upsert(conversationId, local)
      );
    },

    clearLocalHistory: async (conversationId) => {
      await databaseService.clearConversation(conversationId);
      void mediaRepository.sweepCache();
      patch(conversationId, () => ({ messages: [], hasMore: false }));
      void useChatsStore.getState().refreshLocal();
    },

    sendTyping: (conversationId, isTyping) => {
      const channel = channels[conversationId];
      const session = currentSession();
      if (!channel || !session || !mayBroadcastTyping(useSettingsStore.getState())) return;
      void channel.send({ type: 'broadcast', event: 'typing', payload: { userId: session.userId, typing: isTyping } });
    },

    upsert: (conversationId, message) =>
      patch(conversationId, (c) => {
        const idx = c.messages.findIndex((m) => m.id === message.id);
        if (idx >= 0) {
          const messages = [...c.messages];
          messages[idx] = { ...messages[idx], ...message };
          return { messages };
        }
        const messages = [...c.messages, message].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return { messages };
      }),

    remove: (conversationId, messageId) =>
      patch(conversationId, (c) => ({ messages: c.messages.filter((m) => m.id !== messageId) })),
  };
});

/** Tears down every conversation channel (on sign-out). */
export function closeAllConversationChannels(): void {
  for (const id of Object.keys(channels)) {
    void supabase.removeChannel(channels[id]);
    delete channels[id];
  }
  useMessagesStore.setState({ chats: {} });
}
