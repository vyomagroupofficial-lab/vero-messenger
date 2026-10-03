/**
 * Channel state (following list, directory, open channel feeds). Vanilla
 * zustand store built from an injected API for unit tests; the app binding is
 * useChannelsStore.ts.
 */

import { createStore } from 'zustand/vanilla';
import { applyReactionChange, mergePosts, parseChannelPost } from './channelUtils';
import type { ChannelPost, ChannelSummary } from './types';

export interface ChannelApi {
  myChannels(): Promise<ChannelSummary[]>;
  search(query: string): Promise<ChannelSummary[]>;
  getDetails(channelId: string): Promise<ChannelSummary | null>;
  loadPosts(channelId: string, before?: string): Promise<{ posts: ChannelPost[]; hasMore: boolean }>;
  myReactions(postIds: string[]): Promise<Record<string, string>>;
  follow(channelId: string): Promise<void>;
  unfollow(channelId: string): Promise<void>;
  setMuted(channelId: string, muted: boolean): Promise<void>;
  react(postId: string, emoji: string | null): Promise<void>;
  publish(channelId: string, body: string | null, media?: { path: string; mime: string } | null): Promise<ChannelPost>;
  deletePost(post: Pick<ChannelPost, 'id' | 'mediaPath'>): Promise<void>;
}

export interface ChannelsState {
  mine: ChannelSummary[];
  directory: ChannelSummary[];
  isLoadingMine: boolean;
  isSearching: boolean;
  channels: Record<string, ChannelSummary | null>;
  posts: Record<string, ChannelPost[]>;
  hasMore: Record<string, boolean>;
  /** postId -> my emoji */
  myReactions: Record<string, string>;
  /** channelId -> true once the channel was deleted while open */
  deleted: Record<string, boolean>;

  loadMine: () => Promise<void>;
  search: (query: string) => Promise<void>;
  open: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  follow: (channelId: string) => Promise<void>;
  unfollow: (channelId: string) => Promise<void>;
  setMuted: (channelId: string, muted: boolean) => Promise<void>;
  react: (channelId: string, postId: string, emoji: string | null) => Promise<void>;
  publish: (channelId: string, body: string | null, media?: { path: string; mime: string } | null) => Promise<ChannelPost>;
  deletePost: (channelId: string, post: ChannelPost) => Promise<void>;
  /** Applies a broadcast from the `channel:<id>` topic. */
  applyRealtime: (channelId: string, event: string, payload: any) => void;
  reset: () => void;
}

const initial = () => ({
  mine: [] as ChannelSummary[],
  directory: [] as ChannelSummary[],
  isLoadingMine: false,
  isSearching: false,
  channels: {} as Record<string, ChannelSummary | null>,
  posts: {} as Record<string, ChannelPost[]>,
  hasMore: {} as Record<string, boolean>,
  myReactions: {} as Record<string, string>,
  deleted: {} as Record<string, boolean>,
});

export function createChannelsStore(api: ChannelApi) {
  return createStore<ChannelsState>()((set, get) => {
    const patchChannel = (id: string, patch: Partial<ChannelSummary>) =>
      set((s) => {
        const current = s.channels[id];
        const update = (c: ChannelSummary) => (c.id === id ? { ...c, ...patch } : c);
        return {
          channels: current ? { ...s.channels, [id]: { ...current, ...patch } } : s.channels,
          mine: s.mine.map(update),
          directory: s.directory.map(update),
        };
      });

    const setPosts = (id: string, fn: (posts: ChannelPost[]) => ChannelPost[]) =>
      set((s) => ({ posts: { ...s.posts, [id]: fn(s.posts[id] ?? []) } }));

    let searchSeq = 0;

    return {
      ...initial(),

      loadMine: async () => {
        set({ isLoadingMine: true });
        try {
          set({ mine: await api.myChannels() });
        } finally {
          set({ isLoadingMine: false });
        }
      },

      search: async (query) => {
        const seq = ++searchSeq;
        set({ isSearching: true });
        try {
          const results = await api.search(query);
          if (seq === searchSeq) set({ directory: results });
        } finally {
          if (seq === searchSeq) set({ isSearching: false });
        }
      },

      open: async (id) => {
        const [details, page] = await Promise.all([api.getDetails(id), api.loadPosts(id)]);
        set((s) => ({
          channels: { ...s.channels, [id]: details },
          posts: { ...s.posts, [id]: mergePosts(s.posts[id] ?? [], page.posts) },
          hasMore: { ...s.hasMore, [id]: page.hasMore },
        }));
        const mine = await api.myReactions(page.posts.map((p) => p.id)).catch(() => ({}));
        set((s) => ({ myReactions: { ...s.myReactions, ...mine } }));
      },

      loadOlder: async (id) => {
        const posts = get().posts[id] ?? [];
        if (!get().hasMore[id] || !posts.length) return;
        const page = await api.loadPosts(id, posts[posts.length - 1].createdAt);
        setPosts(id, (p) => mergePosts(p, page.posts));
        set((s) => ({ hasMore: { ...s.hasMore, [id]: page.hasMore } }));
        const mine = await api.myReactions(page.posts.map((p) => p.id)).catch(() => ({}));
        set((s) => ({ myReactions: { ...s.myReactions, ...mine } }));
      },

      follow: async (id) => {
        const before = get().channels[id];
        patchChannel(id, { isFollowing: true, followerCount: (before?.followerCount ?? 0) + (before?.isFollowing ? 0 : 1) });
        try {
          await api.follow(id);
        } catch (e) {
          if (before) patchChannel(id, { isFollowing: before.isFollowing, followerCount: before.followerCount });
          throw e;
        }
        void get().loadMine().catch(() => undefined);
      },

      unfollow: async (id) => {
        const before = get().channels[id];
        patchChannel(id, {
          isFollowing: false,
          muted: false,
          followerCount: Math.max(0, (before?.followerCount ?? 0) - (before?.isFollowing ? 1 : 0)),
        });
        try {
          await api.unfollow(id);
        } catch (e) {
          if (before) patchChannel(id, { isFollowing: before.isFollowing, followerCount: before.followerCount, muted: before.muted });
          throw e;
        }
        set((s) => ({ mine: s.mine.filter((c) => c.id !== id || c.myRole !== null) }));
      },

      setMuted: async (id, muted) => {
        const before = get().channels[id]?.muted ?? !muted;
        patchChannel(id, { muted });
        try {
          await api.setMuted(id, muted);
        } catch (e) {
          patchChannel(id, { muted: before });
          throw e;
        }
      },

      react: async (id, postId, emoji) => {
        const previous = get().myReactions[postId] ?? null;
        const next = emoji === previous ? null : emoji; // tapping your reaction again removes it
        const apply = (from: string | null, to: string | null) => {
          setPosts(id, (posts) =>
            posts.map((p) => (p.id === postId ? { ...p, reactionCounts: applyReactionChange(p.reactionCounts, from, to) } : p))
          );
          set((s) => {
            const myReactions = { ...s.myReactions };
            if (to) myReactions[postId] = to;
            else delete myReactions[postId];
            return { myReactions };
          });
        };
        apply(previous, next);
        try {
          await api.react(postId, next);
        } catch (e) {
          apply(next, previous);
          throw e;
        }
      },

      publish: async (id, body, media) => {
        const post = await api.publish(id, body, media);
        setPosts(id, (posts) => mergePosts(posts, [post]));
        patchChannel(id, { lastPostAt: post.createdAt });
        return post;
      },

      deletePost: async (id, post) => {
        await api.deletePost(post);
        setPosts(id, (posts) => posts.filter((p) => p.id !== post.id));
      },

      applyRealtime: (id, event, payload) => {
        switch (event) {
          case 'post.new':
          case 'post.updated': {
            const post = parseChannelPost(payload);
            if (post && post.channelId === id) setPosts(id, (posts) => mergePosts(posts, [post]));
            if (post && event === 'post.new') patchChannel(id, { lastPostAt: post.createdAt });
            break;
          }
          case 'post.deleted':
            if (payload?.id) setPosts(id, (posts) => posts.filter((p) => p.id !== payload.id));
            break;
          case 'post.reactions': {
            if (!payload?.id) break;
            const parsed = parseChannelPost({ id: payload.id, channel_id: id, reaction_counts: payload.reaction_counts });
            if (parsed) {
              setPosts(id, (posts) => posts.map((p) => (p.id === payload.id ? { ...p, reactionCounts: parsed.reactionCounts } : p)));
            }
            break;
          }
          case 'channel.deleted':
            set((s) => ({
              deleted: { ...s.deleted, [id]: true },
              mine: s.mine.filter((c) => c.id !== id),
              directory: s.directory.filter((c) => c.id !== id),
            }));
            break;
        }
      },

      reset: () => set(initial()),
    };
  });
}

export type ChannelsStore = ReturnType<typeof createChannelsStore>;
