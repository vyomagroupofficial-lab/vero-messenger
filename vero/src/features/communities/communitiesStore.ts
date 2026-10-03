/**
 * Community state. Vanilla zustand store from an injected API (unit-tested);
 * app binding in useCommunitiesStore.ts.
 */

import { createStore } from 'zustand/vanilla';
import type { CommunityGroup, CommunityMember, CommunitySummary } from './types';

export interface CommunityApi {
  mine(): Promise<CommunitySummary[]>;
  details(communityId: string): Promise<CommunitySummary | null>;
  groups(communityId: string): Promise<CommunityGroup[]>;
  members(communityId: string): Promise<CommunityMember[]>;
  create(name: string, description?: string): Promise<string>;
  linkGroup(communityId: string, conversationId: string): Promise<void>;
  unlinkGroup(communityId: string, conversationId: string): Promise<void>;
  createGroup(communityId: string, name: string, description?: string): Promise<string>;
  joinGroup(communityId: string, conversationId: string): Promise<{ status: string; requestId: string | null }>;
  setRole(communityId: string, userId: string, role: 'admin' | 'member'): Promise<void>;
  removeMember(communityId: string, userId: string): Promise<void>;
  leave(communityId: string): Promise<void>;
  remove(communityId: string): Promise<void>;
}

export interface CommunitiesState {
  list: CommunitySummary[];
  isLoading: boolean;
  details: Record<string, CommunitySummary | null>;
  groups: Record<string, CommunityGroup[]>;
  members: Record<string, CommunityMember[]>;

  loadMine: () => Promise<void>;
  open: (communityId: string) => Promise<void>;
  loadMembers: (communityId: string) => Promise<void>;
  create: (name: string, description?: string) => Promise<string>;
  joinGroup: (communityId: string, conversationId: string) => Promise<string>;
  linkGroup: (communityId: string, conversationId: string) => Promise<void>;
  unlinkGroup: (communityId: string, conversationId: string) => Promise<void>;
  createGroup: (communityId: string, name: string) => Promise<string>;
  setRole: (communityId: string, userId: string, role: 'admin' | 'member') => Promise<void>;
  removeMember: (communityId: string, userId: string) => Promise<void>;
  leave: (communityId: string) => Promise<void>;
  remove: (communityId: string) => Promise<void>;
  reset: () => void;
}

export function createCommunitiesStore(api: CommunityApi) {
  return createStore<CommunitiesState>()((set, get) => {
    const forget = (id: string) =>
      set((s) => {
        const { [id]: _d, ...details } = s.details;
        const { [id]: _g, ...groups } = s.groups;
        const { [id]: _m, ...members } = s.members;
        return { list: s.list.filter((c) => c.id !== id), details, groups, members };
      });

    return {
      list: [],
      isLoading: false,
      details: {},
      groups: {},
      members: {},

      loadMine: async () => {
        set({ isLoading: true });
        try {
          set({ list: await api.mine() });
        } finally {
          set({ isLoading: false });
        }
      },

      open: async (id) => {
        const [details, groups] = await Promise.all([api.details(id), api.groups(id)]);
        set((s) => ({ details: { ...s.details, [id]: details }, groups: { ...s.groups, [id]: groups } }));
      },

      loadMembers: async (id) => {
        const members = await api.members(id);
        set((s) => ({ members: { ...s.members, [id]: members } }));
      },

      create: async (name, description) => {
        const id = await api.create(name.trim(), description?.trim() || undefined);
        void get().loadMine().catch(() => undefined);
        return id;
      },

      joinGroup: async (id, conversationId) => {
        const { status } = await api.joinGroup(id, conversationId);
        set((s) => ({
          groups: {
            ...s.groups,
            [id]: (s.groups[id] ?? []).map((g) =>
              g.conversationId !== conversationId
                ? g
                : status === 'joined' || status === 'already_member'
                  ? { ...g, isMember: true, memberCount: g.memberCount + (g.isMember || status === 'already_member' ? 0 : 1) }
                  : status === 'requested' || status === 'already_requested'
                    ? { ...g, hasPendingRequest: true }
                    : g
            ),
          },
        }));
        return status;
      },

      linkGroup: async (id, conversationId) => {
        await api.linkGroup(id, conversationId);
        await get().open(id);
      },

      unlinkGroup: async (id, conversationId) => {
        await api.unlinkGroup(id, conversationId);
        set((s) => ({ groups: { ...s.groups, [id]: (s.groups[id] ?? []).filter((g) => g.conversationId !== conversationId) } }));
      },

      createGroup: async (id, name) => {
        const conversationId = await api.createGroup(id, name.trim());
        await get().open(id);
        return conversationId;
      },

      setRole: async (id, userId, role) => {
        await api.setRole(id, userId, role);
        set((s) => ({
          members: { ...s.members, [id]: (s.members[id] ?? []).map((m) => (m.userId === userId ? { ...m, role } : m)) },
        }));
      },

      removeMember: async (id, userId) => {
        await api.removeMember(id, userId);
        set((s) => ({ members: { ...s.members, [id]: (s.members[id] ?? []).filter((m) => m.userId !== userId) } }));
      },

      leave: async (id) => {
        await api.leave(id);
        forget(id);
      },

      remove: async (id) => {
        await api.remove(id);
        forget(id);
      },

      reset: () => set({ list: [], isLoading: false, details: {}, groups: {}, members: {} }),
    };
  });
}

export type CommunitiesStore = ReturnType<typeof createCommunitiesStore>;
