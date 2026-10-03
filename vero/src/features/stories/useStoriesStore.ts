/**
 * Stories state: live decrypted stories, what I've seen (device-local), my
 * story privacy (device-local + synced to my own story_privacy row) and view
 * counts for my own stories. Kept fresh by `story.*` pings on user:<id>.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { currentSession } from '../../core/session';
import { userChannel } from '../../core/network/realtime';
import { friendlyError } from '../../core/network/supabase';
import { useAuthStore } from '../auth/useAuthStore';
import { conversationRepository } from '../chats/ConversationRepository';
import { useChatsStore } from '../chats/useChatsStore';
import { useSettingsStore } from '../settings/useSettingsStore';
import type { Conversation } from '../../shared/models/Message';
import { DEFAULT_PRIVACY, StoryPrivacy, normalizePrivacy, resolveAudience } from './audience';
import { isExpired } from './expiry';
import { Story, StoryDraft, storyRepository } from './StoryRepository';
import { clearStoryMediaCache, purgeStoryMediaCache } from './storyMedia';
import { TrayEntry, orderTray } from './tray';

export interface Contact {
  id: string;
  displayName: string;
}

export interface StoryGroup extends TrayEntry {
  displayName: string;
  stories: Story[];
}

interface StoriesState {
  /** Account the persisted data belongs to (reset when another account signs in). */
  ownerId: string | null;
  /** storyId -> expiresAt, so the map can be pruned. */
  seen: Record<string, string>;
  privacy: StoryPrivacy;

  stories: Story[];
  names: Record<string, string>;
  viewCounts: Record<string, number>;
  isLoading: boolean;
  loaded: boolean;
  error: string | null;
  /** Set when stories can't work here (offline demo account). */
  unavailable: string | null;

  load: () => Promise<void>;
  markSeen: (story: Story) => void;
  post: (draft: StoryDraft, onStage?: (stage: 'uploading' | 'encrypting' | 'sending') => void) => Promise<number>;
  deleteStory: (storyId: string) => Promise<void>;
  setPrivacy: (patch: Partial<StoryPrivacy>) => Promise<void>;
  toggleMute: (userId: string) => Promise<void>;
  removeLocal: (storyId: string) => void;
  dropExpired: () => void;
  reset: () => void;
}

/** Respects the read-receipt setting when the settings store provides one; defaults to on. */
export function storyViewReceiptsEnabled(): boolean {
  try {
    const s: any = useSettingsStore.getState();
    if (typeof s?.storyViewReceipts === 'boolean') return s.storyViewReceipts;
    return typeof s?.readReceipts === 'boolean' ? s.readReceipts : true;
  } catch {
    return true;
  }
}

/** Contacts for stories = people I share a direct chat with. */
export function contactsFromConversations(conversations: Conversation[]): Contact[] {
  const out = new Map<string, Contact>();
  for (const c of conversations) {
    if (c.conversationType === 'direct' && c.otherUser) {
      out.set(c.otherUser.id, { id: c.otherUser.id, displayName: c.otherUser.displayName });
    }
  }
  return [...out.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function contactsFromChats(): Contact[] {
  return contactsFromConversations(useChatsStore.getState().conversations);
}

let loading: Promise<void> | null = null;
let privacySyncedFor: string | null = null;

export const useStoriesStore = create<StoriesState>()(
  persist(
    (set, get) => {
      const ensureOwner = (userId: string) => {
        if (get().ownerId === userId) return;
        storyRepository.reset();
        clearStoryMediaCache();
        privacySyncedFor = null;
        set({
          ownerId: userId,
          seen: {},
          privacy: DEFAULT_PRIVACY,
          stories: [],
          names: {},
          viewCounts: {},
          loaded: false,
          error: null,
        });
      };

      const syncPrivacy = async (userId: string) => {
        if (privacySyncedFor === userId) return;
        const remote = await storyRepository.loadPrivacy();
        if (remote) set({ privacy: remote });
        else await storyRepository.savePrivacy(userId, get().privacy);
        privacySyncedFor = userId;
      };

      const doLoad = async () => {
        await whenHydrated();
        const session = currentSession();
        if (!session) return;
        if (session.isDemo) {
          set({ unavailable: 'Stories need a connected account — the offline demo has no server to share them through.', isLoading: false, loaded: true });
          return;
        }
        ensureOwner(session.userId);
        set({ isLoading: true, unavailable: null });
        try {
          await syncPrivacy(session.userId).catch((e) => console.warn('[stories] privacy sync failed:', e?.message));

          const stories = await storyRepository.fetchLive(session);
          const live = new Set(stories.map((s) => s.id));
          purgeStoryMediaCache(live);

          const names: Record<string, string> = { ...get().names };
          for (const c of contactsFromChats()) names[c.id] = c.displayName;
          const unknown = [...new Set(stories.map((s) => s.authorId))].filter((id) => id !== session.userId && !names[id]);
          await Promise.all(
            unknown.map(async (id) => {
              const p = await conversationRepository.getProfile(id).catch(() => null);
              names[id] = p?.displayName ?? 'Unknown';
            })
          );
          names[session.userId] = 'My story';

          const seen = Object.fromEntries(Object.entries(get().seen).filter(([, exp]) => !isExpired(exp)));
          const own = stories.filter((s) => s.isOwn).map((s) => s.id);
          const viewCounts = own.length ? await storyRepository.viewCounts(own).catch(() => get().viewCounts) : {};

          set({ stories, names, seen, viewCounts, error: null, loaded: true });
        } catch (e) {
          set({ error: friendlyError(e, "Couldn't load stories"), loaded: true });
        } finally {
          set({ isLoading: false });
        }
      };

      const saveRemotePrivacy = async () => {
        const session = currentSession();
        if (!session || session.isDemo) return;
        await storyRepository.savePrivacy(session.userId, get().privacy);
      };

      return {
        ownerId: null,
        seen: {},
        privacy: DEFAULT_PRIVACY,
        stories: [],
        names: {},
        viewCounts: {},
        isLoading: false,
        loaded: false,
        error: null,
        unavailable: null,

        load: () => {
          if (!loading) loading = doLoad().finally(() => (loading = null));
          return loading;
        },

        markSeen: (story) => {
          if (story.isOwn || get().seen[story.id]) return;
          set({ seen: { ...get().seen, [story.id]: story.expiresAt } });
          if (storyViewReceiptsEnabled()) void storyRepository.markViewed(story.id);
        },

        post: async (draft, onStage) => {
          await whenHydrated();
          const session = currentSession();
          if (!session) throw new Error('Not signed in');
          if (session.isDemo) throw new Error('Stories need a connected account.');
          ensureOwner(session.userId);
          const audience = resolveAudience(
            contactsFromChats().map((c) => c.id),
            get().privacy,
            session.userId
          );
          const { story, recipients } = await storyRepository.post(session, draft, audience, onStage);
          set({ stories: [...get().stories.filter((s) => s.id !== story.id), story] });
          return recipients;
        },

        deleteStory: async (storyId) => {
          await storyRepository.delete(storyId);
          get().removeLocal(storyId);
        },

        setPrivacy: async (patch) => {
          set({ privacy: normalizePrivacy({ ...get().privacy, ...patch }) });
          await saveRemotePrivacy();
        },

        toggleMute: async (userId) => {
          const muted = new Set(get().privacy.mutedUserIds);
          if (muted.has(userId)) muted.delete(userId);
          else muted.add(userId);
          await get().setPrivacy({ mutedUserIds: [...muted] });
        },

        removeLocal: (storyId) => {
          const { [storyId]: _gone, ...viewCounts } = get().viewCounts;
          set({ stories: get().stories.filter((s) => s.id !== storyId), viewCounts });
        },

        dropExpired: () => {
          const now = Date.now();
          const stories = get().stories;
          const live = stories.filter((s) => !isExpired(s.expiresAt, now));
          if (live.length !== stories.length) set({ stories: live });
        },

        reset: () => {
          storyRepository.reset();
          clearStoryMediaCache();
          privacySyncedFor = null;
          set({ stories: [], names: {}, viewCounts: {}, loaded: false, error: null, unavailable: null });
        },
      };
    },
    {
      name: 'vero-stories',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ ownerId: s.ownerId, seen: s.seen, privacy: s.privacy }),
    }
  )
);

/** Persisted seen/privacy state is read asynchronously; don't act before it's there. */
function whenHydrated(): Promise<void> {
  if (useStoriesStore.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = useStoriesStore.persist.onFinishHydration(() => {
      unsub();
      resolve();
    });
  });
}

// Decrypted stories never outlive the session in memory.
useAuthStore.subscribe((state, prev) => {
  if (prev.user && !state.user) useStoriesStore.getState().reset();
});

// ── Selectors ────────────────────────────────────────────────────────────────

export function myStories(stories: Story[]): Story[] {
  return stories.filter((s) => s.isOwn).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Other people's stories grouped per author, in tray order. */
export function storyGroups(
  stories: Story[],
  seen: Record<string, string>,
  privacy: StoryPrivacy,
  names: Record<string, string>
): StoryGroup[] {
  const byAuthor = new Map<string, Story[]>();
  for (const s of stories) {
    if (s.isOwn) continue;
    const list = byAuthor.get(s.authorId) ?? [];
    list.push(s);
    byAuthor.set(s.authorId, list);
  }
  const muted = new Set(privacy.mutedUserIds);
  const groups: StoryGroup[] = [...byAuthor.entries()].map(([userId, list]) => {
    const sorted = list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      userId,
      displayName: names[userId] ?? 'Unknown',
      stories: sorted,
      latestAt: sorted[sorted.length - 1].createdAt,
      hasUnseen: sorted.some((s) => !seen[s.id]),
      muted: muted.has(userId),
    };
  });
  return orderTray(groups);
}

// ── Live updates (one shared subscription, ref-counted) ──────────────────────

let liveRefs = 0;
let stopLive: (() => void) | null = null;

export function startStoriesLive(): () => void {
  liveRefs += 1;
  if (liveRefs === 1) {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleLoad = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void useStoriesStore.getState().load(), 600);
    };
    const offNew = userChannel.on('story.new', scheduleLoad);
    const offDeleted = userChannel.on('story.deleted', (p) => {
      if (typeof p?.story_id === 'string') useStoriesStore.getState().removeLocal(p.story_id);
    });
    const offViewed = userChannel.on('story.viewed', (p) => {
      const id = p?.story_id;
      const state = useStoriesStore.getState();
      if (typeof id === 'string' && state.stories.some((s) => s.id === id && s.isOwn)) {
        useStoriesStore.setState({ viewCounts: { ...state.viewCounts, [id]: (state.viewCounts[id] ?? 0) + 1 } });
      }
    });
    const expiryTimer = setInterval(() => useStoriesStore.getState().dropExpired(), 60_000);
    stopLive = () => {
      offNew();
      offDeleted();
      offViewed();
      clearInterval(expiryTimer);
      if (debounce) clearTimeout(debounce);
    };
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    liveRefs -= 1;
    if (liveRefs === 0) {
      stopLive?.();
      stopLive = null;
    }
  };
}
