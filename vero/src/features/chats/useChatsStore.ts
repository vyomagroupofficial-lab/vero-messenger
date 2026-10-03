/**
 * Chat list state. Refreshed on focus and by inbox pings on the user's
 * private realtime topic (works for conversations that aren't open).
 */

import { create } from 'zustand';
import { currentSession } from '../../core/session';
import { userChannel } from '../../core/network/realtime';
import { messagingStore } from '../../core/storage/messagingStore';
import { Conversation } from '../../shared/models/Message';
import { conversationRepository } from './ConversationRepository';
import { messageRepository } from '../messages/MessageRepository';
import { syncDeletions } from '../messages/messageActions';
import { selfSync } from '../messages/selfSync';
import { seedDemoData } from '../demo/demoData';
import { canPin, shouldAutoUnarchive, sortConversations, totalUnread } from './chatList';
import { useChatPrefsStore } from './useChatPrefsStore';

interface ChatsState {
  conversations: Conversation[];
  isLoading: boolean;
  isOffline: boolean;
  /** Conversation currently on screen (its own channel handles live updates). */
  openConversationId: string | null;

  load: (opts?: { sync?: boolean }) => Promise<void>;
  refreshLocal: () => Promise<void>;
  setOpenConversation: (id: string | null) => void;
  /** Pin / unpin (max 3; server-enforced). Throws with a user-facing message. */
  setPinned: (conversationId: string, pinned: boolean) => Promise<void>;
  setArchived: (conversationId: string, archived: boolean) => Promise<void>;
  reset: () => void;
}

export function memberNames(c: Conversation | undefined): Record<string, string> {
  return Object.fromEntries((c?.members || []).map((m) => [m.id, m.displayName]));
}

/** Unread messages across non-archived chats (Chats tab badge). */
export function useTotalUnread(): number {
  return useChatsStore((s) => totalUnread(s.conversations));
}

export const useChatsStore = create<ChatsState>((set, get) => {
  const patchConversation = (id: string, patch: Partial<Conversation>) =>
    set((s) => ({
      conversations: sortConversations(s.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c))),
    }));

  /** Archived chats come back when someone writes, unless "keep archived" is on. */
  const autoUnarchive = async () => {
    const session = currentSession();
    if (!session || session.isDemo) return;
    const archived = get().conversations.filter((c) => c.archivedAt);
    if (archived.length === 0) return;
    const keep = useChatPrefsStore.getState().keepArchived;
    const lastIncoming = await messagingStore.getLastIncomingTimes();
    for (const c of archived) {
      if (shouldAutoUnarchive(c.archivedAt, lastIncoming[c.id], keep)) {
        await get().setArchived(c.id, false).catch(() => undefined);
      }
    }
  };

  return {
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
          // Deletions that happened while this device was offline, and stars from my other devices.
          const deleted = await syncDeletions(session).catch(() => new Set<string>());
          void selfSync.pull(session);
          if (changed || deleted.size > 0) await get().refreshLocal();
          await autoUnarchive();
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
      const fresh = await conversationRepository.getCachedConversations(session.userId);
      if (!fresh.length) return;
      // Keep the latest server-side pin/archive/mute state we already know about.
      const known = new Map(get().conversations.map((c) => [c.id, c]));
      set({
        conversations: sortConversations(
          fresh.map((c) => {
            const k = known.get(c.id);
            return k ? { ...c, pinnedAt: k.pinnedAt, archivedAt: k.archivedAt, mutedUntil: k.mutedUntil } : c;
          })
        ),
      });
    },

    setOpenConversation: (id) => set({ openConversationId: id }),

    setPinned: async (conversationId, pinned) => {
      const session = currentSession();
      if (!session) return;
      if (pinned) {
        const check = canPin(get().conversations, conversationId);
        if (!check.ok) throw new Error(check.reason);
      }
      const before = get().conversations.find((c) => c.id === conversationId);
      const nowIso = new Date().toISOString();
      patchConversation(conversationId, {
        pinnedAt: pinned ? before?.pinnedAt ?? nowIso : null,
        archivedAt: pinned ? null : before?.archivedAt ?? null,
      });
      if (session.isDemo) return;
      try {
        const pinnedAt = await conversationRepository.setPinned(conversationId, pinned);
        patchConversation(conversationId, { pinnedAt });
      } catch (e) {
        if (before) patchConversation(conversationId, { pinnedAt: before.pinnedAt, archivedAt: before.archivedAt });
        throw e;
      }
    },

    setArchived: async (conversationId, archived) => {
      const session = currentSession();
      if (!session) return;
      const before = get().conversations.find((c) => c.id === conversationId);
      patchConversation(conversationId, {
        archivedAt: archived ? before?.archivedAt ?? new Date().toISOString() : null,
        pinnedAt: archived ? null : before?.pinnedAt ?? null,
      });
      if (session.isDemo) return;
      try {
        const archivedAt = await conversationRepository.setArchived(conversationId, archived);
        patchConversation(conversationId, { archivedAt });
      } catch (e) {
        if (before) patchConversation(conversationId, { pinnedAt: before.pinnedAt, archivedAt: before.archivedAt });
        throw e;
      }
    },

    reset: () => set({ conversations: [], isLoading: true, isOffline: false, openConversationId: null }),
  };
});

/** Subscribes to inbox pings for the signed-in user. Returns an unsubscribe function. */
export function startInbox(): () => void {
  const offMessage = userChannel.on(
    'inbox.message',
    async (payload: { conversation_id?: string; message_id?: string }) => {
      const session = currentSession();
      if (!session || !payload?.conversation_id || !payload.message_id) return;
      const store = useChatsStore.getState();
      if (store.openConversationId === payload.conversation_id) return;

      const known = store.conversations.find((c) => c.id === payload.conversation_id);
      if (!known) {
        await store.load({ sync: true }); // brand-new conversation
        return;
      }
      const applied = await messageRepository.fetchOne(session, payload.message_id, memberNames(known));
      void messageRepository.markReceipt(payload.conversation_id, 'delivered');
      await store.refreshLocal();
      if (
        applied.kind === 'message' &&
        !applied.message.isOwn &&
        known.archivedAt &&
        shouldAutoUnarchive(known.archivedAt, applied.message.createdAt, useChatPrefsStore.getState().keepArchived)
      ) {
        await store.setArchived(known.id, false).catch(() => undefined);
      }
    }
  );

  // A message was deleted for everyone (also from my other devices).
  const offDeleted = userChannel.on(
    'inbox.deleted',
    async (payload: { conversation_id?: string; message_id?: string }) => {
      const session = currentSession();
      if (!session || !payload?.conversation_id || !payload.message_id) return;
      const store = useChatsStore.getState();
      if (store.openConversationId === payload.conversation_id) return; // the open chat's channel handles it
      const known = store.conversations.find((c) => c.id === payload.conversation_id);
      // Verified against the server row (deleted_at), never trusted from the ping alone.
      await messageRepository.fetchOne(session, payload.message_id, memberNames(known));
      await store.refreshLocal();
    }
  );

  const offSync = userChannel.on('self.sync', () => {
    const session = currentSession();
    if (session) void selfSync.pull(session);
  });

  const offPrefs = userChannel.on(
    'prefs.changed',
    (payload: { conversation_id?: string; pinned_at?: string | null; archived_at?: string | null }) => {
      if (!payload?.conversation_id) return;
      useChatsStore.setState((s) => ({
        conversations: sortConversations(
          s.conversations.map((c) =>
            c.id === payload.conversation_id
              ? { ...c, pinnedAt: payload.pinned_at ?? null, archivedAt: payload.archived_at ?? null }
              : c
          )
        ),
      }));
    }
  );

  return () => {
    offMessage();
    offDeleted();
    offSync();
    offPrefs();
  };
}
