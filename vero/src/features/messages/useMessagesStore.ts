/**
 * State for the open conversation: messages, members (for receipts and
 * names), typing indicators and the private realtime channel.
 */

import { create } from 'zustand';
import { AppState } from 'react-native';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../../core/network/supabase';
import { privateChannel } from '../../core/network/realtime';
import { currentSession, requireSession } from '../../core/session';
import { databaseService } from '../../core/storage/DatabaseService';
import { messagingStore } from '../../core/storage/messagingStore';
import { Conversation, ConversationMember, Message } from '../../shared/models/Message';
import { MessagePayload } from '../../shared/models/payload';
import { conversationRepository } from '../chats/ConversationRepository';
import { memberNames, useChatsStore } from '../chats/useChatsStore';
import { useSettingsStore } from '../settings/useSettingsStore';
import { mayBroadcastTyping } from '../settings/privacy';
import { mediaRepository } from '../media/MediaRepository';
import { AppliedRow, messageRepository, SendOptions, ServerMessageRow } from './MessageRepository';
import {
  deleteForEveryone as deleteForEveryoneAction,
  editMessage as editMessageAction,
  forwardMessages,
  ForwardResult,
  setStarred,
} from './messageActions';
import { selfSync } from './selfSync';
import { toMillis } from '../../shared/utils/time';

/** Messages still 'sending' after this long (app killed mid-send) become retryable. */
const STALE_SENDING_MS = 2 * 60 * 1000;

/** Read receipts only while the chat is actually on screen with the app in the foreground. */
const appIsVisible = () => AppState.currentState === 'active';

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
  /** Set after jumping to an old message (search/starred): the id to scroll to and highlight. */
  focusMessageId?: string | null;
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
  edit: (message: Message, newText: string) => Promise<void>;
  forward: (messages: Message[], conversationIds: string[]) => Promise<ForwardResult>;
  star: (messages: Message[], starred: boolean) => Promise<void>;
  /** Loads the chat around `messageId` (from local storage) and marks it as the focus. */
  jumpTo: (conversationId: string, messageId: string) => Promise<boolean>;
  clearFocus: (conversationId: string) => void;
  /** Explicit "mark as read" from the chat list. */
  markConversationRead: (conversationId: string) => Promise<void>;
  clearLocalHistory: (conversationId: string) => Promise<void>;
  sendTyping: (conversationId: string, isTyping: boolean) => void;
  upsert: (conversationId: string, message: Message) => void;
  remove: (conversationId: string, messageId: string) => void;
}

const channels: Record<string, RealtimeChannel> = {};

/** Updates the star flag of loaded messages (local action or another device). */
function markStarred(ids: string[], starred: boolean): void {
  const set = new Set(ids);
  useMessagesStore.setState((s) => {
    let changed = false;
    const chats = { ...s.chats };
    for (const [id, chat] of Object.entries(chats)) {
      if (!chat.messages.some((m) => set.has(m.id))) continue;
      changed = true;
      chats[id] = {
        ...chat,
        messages: chat.messages.map((m) => (set.has(m.id) ? { ...m, starred: starred || undefined } : m)),
      };
    }
    return changed ? { chats } : s;
  });
}

export const useMessagesStore = create<MessagesState>((set, get) => {
  const patch = (id: string, fn: (c: ChatState) => Partial<ChatState>) =>
    set((s) => {
      const chat = s.chats[id] ?? emptyChat();
      return { chats: { ...s.chats, [id]: { ...chat, ...fn(chat) } } };
    });

  const names = (id: string) => memberNames(get().chats[id]?.conversation ?? undefined);

  const markRead = async (conversationId: string) => {
    if (!appIsVisible() || useChatsStore.getState().openConversationId !== conversationId) return;
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

  const applyToChat = (conversationId: string, applied: AppliedRow) => {
    switch (applied.kind) {
      case 'message':
        get().upsert(conversationId, applied.message);
        break;
      case 'reaction':
      case 'edited':
        get().upsert(conversationId, applied.target);
        break;
      case 'deleted':
        if (applied.tombstone) get().upsert(conversationId, applied.tombstone);
        else get().remove(conversationId, applied.id);
        break;
    }
  };

  const subscribe = (conversationId: string) => {
    if (channels[conversationId]) return;
    const channel = privateChannel(`conversation:${conversationId}`);

    channel
      .on('broadcast', { event: 'message.new' }, async ({ payload }) => {
        const session = currentSession();
        if (!session) return;
        const [applied] = await messageRepository.applyRows(session, [payload as ServerMessageRow], names(conversationId));
        if (applied) applyToChat(conversationId, applied);
        if (applied?.kind === 'message' && !applied.message.isOwn) void markRead(conversationId);
      })
      .on('broadcast', { event: 'message.deleted' }, async ({ payload }) => {
        const session = currentSession();
        if (!payload?.id || !session) return;
        // Members can broadcast on this topic, so confirm with the server before removing anything.
        const applied = await messageRepository.fetchOne(session, payload.id, names(conversationId));
        if (applied.kind === 'deleted') applyToChat(conversationId, applied);
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
                // Merge (don't replace): keeps older pages / a jumpTo() window in place.
                const fresh = await databaseService.getMessages(conversationId);
                for (const m of fresh) get().upsert(conversationId, m);
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
      await messagingStore.failStaleSending(conversationId, new Date(Date.now() - STALE_SENDING_MS).toISOString());
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
      patch(conversationId, (c) =>
        // Keep a window loaded by jumpTo() (search / starred) instead of resetting to the newest page.
        c.focusMessageId && c.messages.some((m) => m.id === c.focusMessageId)
          ? { isLoading: false }
          : { messages: page.messages, hasMore: page.hasMore, isLoading: false }
      );

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
      patch(conversationId, () => ({ focusMessageId: null }));
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
      if (payload.t !== 'reaction' && payload.t !== 'edit') get().upsert(conversationId, result);
      void useChatsStore.getState().refreshLocal();
      return result;
    },

    retry: async (message) => {
      const result = await messageRepository.retry(requireSession(), message, (local) =>
        get().upsert(message.conversationId, local)
      );
      if (result) get().upsert(message.conversationId, result);
      void useChatsStore.getState().refreshLocal();
    },

    react: async (message, emoji) => {
      const updated = await messageRepository.react(requireSession(), message, emoji);
      get().upsert(message.conversationId, updated);
    },

    deleteMessage: async (message, forEveryone) => {
      const session = requireSession();
      if (forEveryone) {
        const tombstone = await deleteForEveryoneAction(session, message);
        if (tombstone) get().upsert(message.conversationId, tombstone);
        else get().remove(message.conversationId, message.id);
      } else {
        await messageRepository.deleteForMe(message.id);
        get().remove(message.conversationId, message.id);
      }
      void useChatsStore.getState().refreshLocal();
    },

    edit: async (message, newText) => {
      const updated = await editMessageAction(requireSession(), message, newText);
      get().upsert(message.conversationId, updated);
      void useChatsStore.getState().refreshLocal();
    },

    forward: async (messages, conversationIds) => {
      const session = requireSession();
      const result = await forwardMessages(session, messages, conversationIds, (conversationId, payload, mediaId, localUri) =>
        get().send(conversationId, payload, { mediaId, localUri })
      );
      void useChatsStore.getState().refreshLocal();
      return result;
    },

    star: async (messages, starred) => {
      await setStarred(requireSession(), messages, starred);
      markStarred(messages.map((m) => m.id), starred);
    },

    jumpTo: async (conversationId, messageId) => {
      const loaded = get().chats[conversationId]?.messages.some((m) => m.id === messageId);
      if (!loaded) {
        const target = await databaseService.getMessage(messageId);
        if (!target || target.conversationId !== conversationId || target.deletedAt) return false;
        const window = await messagingStore.getMessagesFrom(conversationId, target.createdAt);
        if (!window.some((m) => m.id === messageId)) return false;
        patch(conversationId, () => ({ messages: window, hasMore: true, isLoading: false }));
      }
      patch(conversationId, () => ({ focusMessageId: messageId }));
      return true;
    },

    clearFocus: (conversationId) => patch(conversationId, () => ({ focusMessageId: null })),

    markConversationRead: async (conversationId) => {
      await databaseService.markConversationRead(conversationId);
      const session = currentSession();
      if (session && !session.isDemo) await messageRepository.markReceipt(conversationId, 'read');
      await useChatsStore.getState().refreshLocal();
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
        const byTime = (a: Message, b: Message) => toMillis(a.createdAt) - toMillis(b.createdAt);
        const idx = c.messages.findIndex((m) => m.id === message.id);
        if (idx >= 0) {
          const messages = [...c.messages];
          const moved = messages[idx].createdAt !== message.createdAt;
          messages[idx] = { ...messages[idx], ...message };
          // A confirmed send adopts the server timestamp, which can change its position.
          return { messages: moved ? messages.sort(byTime) : messages };
        }
        return { messages: [...c.messages, message].sort(byTime) };
      }),

    remove: (conversationId, messageId) =>
      patch(conversationId, (c) => ({ messages: c.messages.filter((m) => m.id !== messageId) })),
  };
});

// Stars changed on another of my devices.
selfSync.onStarsChanged((items) => {
  markStarred(items.filter((i) => i.s).map((i) => i.id), true);
  markStarred(items.filter((i) => !i.s).map((i) => i.id), false);
});

// Coming back to the foreground with a chat open counts as reading it.
AppState.addEventListener('change', (state) => {
  const open = useChatsStore.getState().openConversationId;
  if (state !== 'active' || !open) return;
  const session = currentSession();
  if (!session) return;
  void databaseService.markConversationRead(open).then(() => {
    if (!session.isDemo) void messageRepository.markReceipt(open, 'read');
    void useChatsStore.getState().refreshLocal();
  });
});

/** Tears down every conversation channel (on sign-out). */
export function closeAllConversationChannels(): void {
  for (const id of Object.keys(channels)) {
    void supabase.removeChannel(channels[id]);
    delete channels[id];
  }
  useMessagesStore.setState({ chats: {} });
}
