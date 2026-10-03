/**
 * Vero Messages Store (Zustand)
 *
 * Manages per-conversation message state, realtime subscriptions,
 * typing indicators, and presence.
 */

import { create } from 'zustand';
import { supabase } from '../../core/network/supabase';
import { messageRepository, SendMessageParams } from './MessageRepository';
import { Message, Conversation } from '../../shared/models/Message';
import { RealtimeChannel } from '@supabase/supabase-js';

interface ConversationMessages {
  messages: Message[];
  isLoading: boolean;
  hasMore: boolean;
  isTyping: boolean;
  typingUsers: string[];
}

interface MessagesState {
  conversations: Record<string, ConversationMessages>;
  activeChannels: Record<string, RealtimeChannel>;

  // Actions
  loadMessages: (
    conversationId: string,
    currentUserId: string,
    currentDeviceId: string
  ) => Promise<void>;

  loadMoreMessages: (
    conversationId: string,
    currentUserId: string,
    currentDeviceId: string
  ) => Promise<void>;

  sendMessage: (params: SendMessageParams) => Promise<{ success: boolean; messageId?: string; error?: string }>;

  subscribeToConversation: (
    conversationId: string,
    currentUserId: string,
    currentDeviceId: string
  ) => void;

  unsubscribeFromConversation: (conversationId: string) => void;

  appendMessage: (conversationId: string, message: Message) => void;
  seedMessages: (conversationId: string, messages: Message[]) => void;
  setTyping: (conversationId: string, users: string[]) => void;
}

export const useMessagesStore = create<MessagesState>((set, get) => ({
  conversations: {},
  activeChannels: {},

  loadMessages: async (conversationId, currentUserId, currentDeviceId) => {
    // Initialize conversation state
    set((state) => ({
      conversations: {
        ...state.conversations,
        [conversationId]: state.conversations[conversationId]
          ? { ...state.conversations[conversationId], isLoading: true }
          : {
              messages: [],
              isLoading: true,
              hasMore: true,
              isTyping: false,
              typingUsers: [],
            },
      },
    }));

    const messages = await messageRepository.getMessages(
      conversationId,
      currentUserId,
      currentDeviceId
    );

    set((state) => ({
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...state.conversations[conversationId],
          messages,
          isLoading: false,
          hasMore: messages.length >= 50,
        },
      },
    }));
  },

  loadMoreMessages: async (conversationId, currentUserId, currentDeviceId) => {
    const conv = get().conversations[conversationId];
    if (!conv || !conv.hasMore || conv.isLoading) return;

    const oldestMessage = conv.messages[0];
    if (!oldestMessage) return;

    set((state) => ({
      conversations: {
        ...state.conversations,
        [conversationId]: { ...state.conversations[conversationId], isLoading: true },
      },
    }));

    const older = await messageRepository.getMessages(
      conversationId,
      currentUserId,
      currentDeviceId,
      50,
      oldestMessage.createdAt
    );

    set((state) => ({
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...state.conversations[conversationId],
          messages: [...older, ...state.conversations[conversationId].messages],
          isLoading: false,
          hasMore: older.length >= 50,
        },
      },
    }));
  },

  sendMessage: async (params) => {
    return await messageRepository.sendMessage(params);
  },

  subscribeToConversation: (conversationId, currentUserId, currentDeviceId) => {
    const existing = get().activeChannels[conversationId];
    if (existing) return; // Already subscribed

    const channel = supabase
      .channel(`private:conversation:${conversationId}`)
      .on('broadcast', { event: 'message.new' }, async (payload) => {
        const rawMsg = payload.payload;
        if (!rawMsg) return;

        // Decrypt and append new message
        const message = await messageRepository.decryptRawMessage(
          rawMsg,
          currentUserId,
          currentDeviceId
        );
        if (message) {
          get().appendMessage(conversationId, message);

          // Mark as delivered
          if (!message.isOwn) {
            await messageRepository.markAsRead(message.id, currentDeviceId);
          }
        }
      })
      .on('broadcast', { event: 'typing.start' }, (payload) => {
        const conv = get().conversations[conversationId];
        const userId = payload.payload?.userId;
        if (userId && userId !== currentUserId) {
          const users = [...new Set([...(conv?.typingUsers || []), userId])];
          get().setTyping(conversationId, users);
        }
      })
      .on('broadcast', { event: 'typing.stop' }, (payload) => {
        const conv = get().conversations[conversationId];
        const userId = payload.payload?.userId;
        if (userId) {
          const users = (conv?.typingUsers || []).filter((u) => u !== userId);
          get().setTyping(conversationId, users);
        }
      })
      .subscribe();

    set((state) => ({
      activeChannels: { ...state.activeChannels, [conversationId]: channel },
    }));
  },

  unsubscribeFromConversation: (conversationId) => {
    const channel = get().activeChannels[conversationId];
    if (channel) {
      supabase.removeChannel(channel);
      set((state) => {
        const channels = { ...state.activeChannels };
        delete channels[conversationId];
        return { activeChannels: channels };
      });
    }
  },

  appendMessage: (conversationId, message) => {
    set((state) => {
      const conv = state.conversations[conversationId] || {
        messages: [],
        isLoading: false,
        hasMore: false,
        isTyping: false,
        typingUsers: [],
      };

      // Avoid duplicates
      const exists = conv.messages.some((m) => m.id === message.id);
      if (exists) return state;

      return {
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...conv,
            messages: [...conv.messages, message],
          },
        },
      };
    });
  },

  seedMessages: (conversationId, messages) => {
    set((state) => ({
      conversations: {
        ...state.conversations,
        [conversationId]: {
          typingUsers: state.conversations[conversationId]?.typingUsers ?? [],
          isTyping: state.conversations[conversationId]?.isTyping ?? false,
          messages,
          isLoading: false,
          hasMore: false,
        },
      },
    }));
  },

  setTyping: (conversationId, users) => {
    set((state) => ({
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...state.conversations[conversationId],
          typingUsers: users,
          isTyping: users.length > 0,
        },
      },
    }));
  },
}));
