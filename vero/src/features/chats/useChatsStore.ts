/**
 * Chat list state. Refreshed on focus and by inbox pings on the user's
 * private realtime topic (works for conversations that aren't open).
 */

import { create } from 'zustand';
import { currentSession } from '../../core/session';
import { userChannel } from '../../core/network/realtime';
import { Conversation } from '../../shared/models/Message';
import { conversationRepository } from './ConversationRepository';
import { messageRepository } from '../messages/MessageRepository';
import { seedDemoData } from '../demo/demoData';

interface ChatsState {
  conversations: Conversation[];
  isLoading: boolean;
  isOffline: boolean;
  /** Conversation currently on screen (its own channel handles live updates). */
  openConversationId: string | null;

  load: (opts?: { sync?: boolean }) => Promise<void>;
  refreshLocal: () => Promise<void>;
  setOpenConversation: (id: string | null) => void;
  reset: () => void;
}

export function memberNames(c: Conversation | undefined): Record<string, string> {
  return Object.fromEntries((c?.members || []).map((m) => [m.id, m.displayName]));
}

export const useChatsStore = create<ChatsState>((set, get) => ({
  conversations: [],
  isLoading: true,
  isOffline: false,
  openConversationId: null,

  load: async ({ sync = true } = {}) => {
    const session = currentSession();
    if (!session) return;

    if (session.isDemo) {
      await seedDemoData();
      set({
        conversations: await conversationRepository.getCachedConversations(session.userId),
        isLoading: false,
        isOffline: false,
      });
      return;
    }

    // Show the cached list instantly, then go to the network.
    if (get().conversations.length === 0) {
      const cached = await conversationRepository.getCachedConversations(session.userId);
      if (cached.length) set({ conversations: cached });
    }

    try {
      const list = await conversationRepository.getConversations(session.userId);
      set({ conversations: list, isOffline: false });
      if (sync) {
        // Decrypt anything new so previews and unread counts are accurate.
        let changed = false;
        await Promise.all(
          list.map(async (c) => {
            const n = await messageRepository.syncLatest(session, c.id, memberNames(c)).catch(() => 0);
            if (n > 0) changed = true;
          })
        );
        if (changed) await get().refreshLocal();
      }
    } catch (e) {
      console.warn('[ChatsStore] load failed, showing cached list:', (e as Error)?.message);
      set({ isOffline: true });
    } finally {
      set({ isLoading: false });
    }
  },

  refreshLocal: async () => {
    const session = currentSession();
    if (!session) return;
    const cached = await conversationRepository.getCachedConversations(session.userId);
    if (cached.length) set({ conversations: cached });
  },

  setOpenConversation: (id) => set({ openConversationId: id }),

  reset: () => set({ conversations: [], isLoading: true, isOffline: false, openConversationId: null }),
}));

/** Subscribes to inbox pings for the signed-in user. Returns an unsubscribe function. */
export function startInbox(): () => void {
  return userChannel.on('inbox.message', async (payload: { conversation_id?: string; message_id?: string }) => {
    const session = currentSession();
    if (!session || !payload?.conversation_id || !payload.message_id) return;
    const store = useChatsStore.getState();
    if (store.openConversationId === payload.conversation_id) return;

    const known = store.conversations.find((c) => c.id === payload.conversation_id);
    if (!known) {
      await store.load({ sync: true }); // brand-new conversation
      return;
    }
    await messageRepository.fetchOne(session, payload.message_id, memberNames(known));
    void messageRepository.markReceipt(payload.conversation_id, 'delivered');
    await store.refreshLocal();
  });
}
