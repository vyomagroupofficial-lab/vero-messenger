/**
 * Group info / admin state. A vanilla zustand store built from an injected
 * API so it can be unit-tested without Supabase (see useGroupStore.ts for the
 * app binding).
 */

import { createStore } from 'zustand/vanilla';
import type { InviteOptions } from './inviteLinks';
import { isAdminRole } from './permissions';
import type { GroupDetails, GroupInvite, GroupRole, GroupSettings, JoinRequest } from './types';

export interface GroupApi {
  getDetails(conversationId: string): Promise<GroupDetails | null>;
  updateInfo(conversationId: string, patch: { name?: string; description?: string; avatarData?: string; clearAvatar?: boolean }): Promise<void>;
  setPermissions(conversationId: string, patch: { onlyAdminsSend?: boolean; onlyAdminsEditInfo?: boolean; joinApprovalRequired?: boolean }): Promise<void>;
  addMembers(conversationId: string, userIds: string[]): Promise<void>;
  removeMember(conversationId: string, userId: string): Promise<void>;
  setRole(conversationId: string, userId: string, role: 'admin' | 'member'): Promise<void>;
  transferOwnership(conversationId: string, newOwnerId: string): Promise<void>;
  leave(conversationId: string): Promise<void>;
  deleteGroup(conversationId: string): Promise<void>;
  listInvites(conversationId: string): Promise<GroupInvite[]>;
  createInvite(conversationId: string, opts: InviteOptions): Promise<GroupInvite>;
  revokeInvite(inviteId: string): Promise<void>;
  listPendingRequests(conversationId: string): Promise<JoinRequest[]>;
  decideRequest(requestId: string, approve: boolean): Promise<void>;
}

export interface GroupState {
  details: Record<string, GroupDetails | null>;
  invites: Record<string, GroupInvite[]>;
  requests: Record<string, JoinRequest[]>;
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;

  load: (conversationId: string) => Promise<void>;
  myRole: (conversationId: string) => GroupRole | null;
  updateInfo: GroupApi['updateInfo'];
  setPermissions: (conversationId: string, patch: Partial<Pick<GroupSettings, 'onlyAdminsSend' | 'onlyAdminsEditInfo' | 'joinApprovalRequired'>>) => Promise<void>;
  addMembers: (conversationId: string, userIds: string[]) => Promise<void>;
  removeMember: (conversationId: string, userId: string) => Promise<void>;
  setRole: (conversationId: string, userId: string, role: 'admin' | 'member') => Promise<void>;
  transferOwnership: (conversationId: string, newOwnerId: string) => Promise<void>;
  leave: (conversationId: string) => Promise<void>;
  deleteGroup: (conversationId: string) => Promise<void>;
  createInvite: (conversationId: string, opts: InviteOptions) => Promise<GroupInvite>;
  revokeInvite: (conversationId: string, inviteId: string) => Promise<void>;
  decideRequest: (conversationId: string, requestId: string, approve: boolean) => Promise<void>;
  forget: (conversationId: string) => void;
}

const message = (e: unknown) => ((e as any)?.message as string) || 'Something went wrong';

export function createGroupStore(api: GroupApi, myUserId: () => string | null) {
  return createStore<GroupState>()((set, get) => {
    const setKey = <K extends 'details' | 'invites' | 'requests' | 'loading' | 'errors'>(
      key: K,
      id: string,
      value: GroupState[K][string]
    ) => set((s) => ({ [key]: { ...s[key], [id]: value } }) as Partial<GroupState>);

    const reloadAdminData = async (id: string) => {
      if (!isAdminRole(get().myRole(id))) {
        setKey('invites', id, []);
        setKey('requests', id, []);
        return;
      }
      const [invites, requests] = await Promise.all([
        api.listInvites(id).catch(() => get().invites[id] ?? []),
        api.listPendingRequests(id).catch(() => get().requests[id] ?? []),
      ]);
      setKey('invites', id, invites);
      setKey('requests', id, requests);
    };

    /** Runs a mutation, then re-reads the group so the UI shows server truth. */
    const mutate = async (id: string, fn: () => Promise<void>) => {
      setKey('errors', id, null);
      try {
        await fn();
      } catch (e) {
        setKey('errors', id, message(e));
        throw e;
      }
      await get().load(id);
    };

    return {
      details: {},
      invites: {},
      requests: {},
      loading: {},
      errors: {},

      load: async (id) => {
        setKey('loading', id, true);
        try {
          const details = await api.getDetails(id);
          setKey('details', id, details);
          setKey('errors', id, null);
          await reloadAdminData(id);
        } catch (e) {
          setKey('errors', id, message(e));
        } finally {
          setKey('loading', id, false);
        }
      },

      myRole: (id) => {
        const me = myUserId();
        return get().details[id]?.members.find((m) => m.id === me)?.role ?? null;
      },

      updateInfo: (id, patch) => mutate(id, () => api.updateInfo(id, patch)),

      setPermissions: async (id, patch) => {
        // Optimistic toggle; reverted if the server refuses.
        const before = get().details[id];
        if (before) setKey('details', id, { ...before, settings: { ...before.settings, ...patch } });
        try {
          await api.setPermissions(id, patch);
        } catch (e) {
          if (before) setKey('details', id, before);
          setKey('errors', id, message(e));
          throw e;
        }
      },

      addMembers: (id, userIds) => mutate(id, () => api.addMembers(id, userIds)),
      removeMember: (id, userId) => mutate(id, () => api.removeMember(id, userId)),
      setRole: (id, userId, role) => mutate(id, () => api.setRole(id, userId, role)),
      transferOwnership: (id, newOwnerId) => mutate(id, () => api.transferOwnership(id, newOwnerId)),

      leave: async (id) => {
        await api.leave(id);
        get().forget(id);
      },

      deleteGroup: async (id) => {
        await api.deleteGroup(id);
        get().forget(id);
      },

      createInvite: async (id, opts) => {
        const invite = await api.createInvite(id, opts);
        setKey('invites', id, [invite, ...(get().invites[id] ?? [])]);
        return invite;
      },

      revokeInvite: async (id, inviteId) => {
        await api.revokeInvite(inviteId);
        const now = new Date().toISOString();
        setKey(
          'invites',
          id,
          (get().invites[id] ?? []).map((i) => (i.id === inviteId ? { ...i, revokedAt: i.revokedAt ?? now } : i))
        );
      },

      decideRequest: async (id, requestId, approve) => {
        await api.decideRequest(requestId, approve);
        setKey('requests', id, (get().requests[id] ?? []).filter((r) => r.id !== requestId));
        if (approve) await get().load(id);
      },

      forget: (id) =>
        set((s) => {
          const strip = <T,>(r: Record<string, T>) => {
            const { [id]: _drop, ...rest } = r;
            return rest;
          };
          return {
            details: strip(s.details),
            invites: strip(s.invites),
            requests: strip(s.requests),
            loading: strip(s.loading),
            errors: strip(s.errors),
          };
        }),
    };
  });
}

export type GroupStore = ReturnType<typeof createGroupStore>;
