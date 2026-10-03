/**
 * Group admin tools, invite links and join requests (migration 007).
 * Every write is an RPC that re-checks authorization server-side.
 */

import { supabase } from '../../core/network/supabase';
import { parseGroupEvent } from './groupEvents';
import { expiryFromNow, InviteOptions } from './inviteLinks';
import {
  DEFAULT_GROUP_SETTINGS,
  GroupDetails,
  GroupEvent,
  GroupInvite,
  GroupMemberInfo,
  GroupSettings,
  InvitePreview,
  JoinRequest,
} from './types';

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export function mapSettings(row: any): GroupSettings {
  if (!row) return { ...DEFAULT_GROUP_SETTINGS };
  return {
    description: row.description ?? null,
    avatarData: row.avatar_data ?? null,
    onlyAdminsSend: !!row.only_admins_send,
    onlyAdminsEditInfo: row.only_admins_edit_info !== false,
    joinApprovalRequired: !!row.join_approval_required,
    deletedAt: row.deleted_at ?? null,
  };
}

export function mapInvite(row: any): GroupInvite {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    token: row.token,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    maxUses: row.max_uses ?? null,
    uses: row.uses ?? 0,
    requiresApproval: !!row.requires_approval,
    revokedAt: row.revoked_at ?? null,
  };
}

const EVENT_SELECT =
  'id, conversation_id, actor_id, target_id, event_type, details, created_at, ' +
  'actor:profiles!group_events_actor_id_fkey(display_name), target:profiles!group_events_target_id_fkey(display_name)';

class GroupRepository {
  // ── Info & settings ─────────────────────────────────────────────────────

  async getDetails(conversationId: string): Promise<GroupDetails | null> {
    const { data, error } = await supabase
      .from('conversations')
      .select(
        `id, group_name, created_at,
         group_settings ( description, avatar_data, only_admins_send, only_admins_edit_info, join_approval_required, deleted_at ),
         community_groups ( community_id, is_announcements ),
         conversation_members ( user_id, role, joined_at, left_at,
           profiles ( id, username, display_name, avatar_reference, about ) )`
      )
      .eq('id', conversationId)
      .eq('conversation_type', 'group')
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const raw: any = data;
    const members: GroupMemberInfo[] = (raw.conversation_members || [])
      .filter((m: any) => !m.left_at)
      .map((m: any) => ({
        id: m.user_id,
        username: m.profiles?.username ?? '',
        displayName: m.profiles?.display_name || m.profiles?.username || 'Unknown',
        avatarReference: m.profiles?.avatar_reference ?? null,
        about: m.profiles?.about ?? null,
        role: m.role,
        joinedAt: m.joined_at,
      }));
    const link = one<any>(raw.community_groups);
    return {
      id: raw.id,
      name: raw.group_name || 'Group',
      createdAt: raw.created_at,
      settings: mapSettings(one(raw.group_settings)),
      members,
      community: link ? { id: link.community_id, isAnnouncements: !!link.is_announcements } : null,
    };
  }

  async getSettings(conversationId: string): Promise<GroupSettings | null> {
    const { data, error } = await supabase
      .from('group_settings')
      .select('description, avatar_data, only_admins_send, only_admins_edit_info, join_approval_required, deleted_at')
      .eq('conversation_id', conversationId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapSettings(data) : null;
  }

  async updateInfo(
    conversationId: string,
    patch: { name?: string; description?: string; avatarData?: string; clearAvatar?: boolean }
  ): Promise<void> {
    const { error } = await supabase.rpc('update_group_info', {
      p_conversation_id: conversationId,
      p_name: patch.name ?? null,
      p_description: patch.description ?? null,
      p_avatar_data: patch.avatarData ?? null,
      p_clear_avatar: !!patch.clearAvatar,
    });
    if (error) throw error;
  }

  async setPermissions(
    conversationId: string,
    patch: { onlyAdminsSend?: boolean; onlyAdminsEditInfo?: boolean; joinApprovalRequired?: boolean }
  ): Promise<void> {
    const { error } = await supabase.rpc('set_group_permissions', {
      p_conversation_id: conversationId,
      p_only_admins_send: patch.onlyAdminsSend ?? null,
      p_only_admins_edit_info: patch.onlyAdminsEditInfo ?? null,
      p_join_approval_required: patch.joinApprovalRequired ?? null,
    });
    if (error) throw error;
  }

  // ── Members & roles ─────────────────────────────────────────────────────

  async addMembers(conversationId: string, userIds: string[]): Promise<void> {
    const { error } = await supabase.rpc('add_group_members', {
      p_conversation_id: conversationId,
      p_member_ids: userIds,
    });
    if (error) throw error;
  }

  async removeMember(conversationId: string, userId: string): Promise<void> {
    const { error } = await supabase.rpc('remove_group_member', {
      p_conversation_id: conversationId,
      p_user_id: userId,
    });
    if (error) throw error;
  }

  async setRole(conversationId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
    const { error } = await supabase.rpc('set_group_member_role', {
      p_conversation_id: conversationId,
      p_user_id: userId,
      p_role: role,
    });
    if (error) throw error;
  }

  async transferOwnership(conversationId: string, newOwnerId: string): Promise<void> {
    const { error } = await supabase.rpc('transfer_group_ownership', {
      p_conversation_id: conversationId,
      p_new_owner_id: newOwnerId,
    });
    if (error) throw error;
  }

  /** Leaving as owner hands the group to the longest-serving admin/member. */
  async leave(conversationId: string): Promise<void> {
    const { error } = await supabase.rpc('leave_group', { p_conversation_id: conversationId });
    if (error) throw error;
  }

  async deleteGroup(conversationId: string): Promise<void> {
    const { error } = await supabase.rpc('delete_group', { p_conversation_id: conversationId });
    if (error) throw error;
  }

  // ── Invite links ────────────────────────────────────────────────────────

  async listInvites(conversationId: string): Promise<GroupInvite[]> {
    const { data, error } = await supabase.rpc('list_group_invites', { p_conversation_id: conversationId });
    if (error) throw error;
    return ((data as any[]) || []).map(mapInvite);
  }

  async createInvite(conversationId: string, opts: InviteOptions): Promise<GroupInvite> {
    const { data, error } = await supabase.rpc('create_group_invite', {
      p_conversation_id: conversationId,
      p_expires_at: expiryFromNow(opts.expiresInSeconds),
      p_max_uses: opts.maxUses,
      p_requires_approval: opts.requiresApproval,
    });
    if (error) throw error;
    return mapInvite(one<any>(data as any));
  }

  async revokeInvite(inviteId: string): Promise<void> {
    const { error } = await supabase.rpc('revoke_group_invite', { p_invite_id: inviteId });
    if (error) throw error;
  }

  async previewInvite(token: string): Promise<InvitePreview> {
    const { data, error } = await supabase.rpc('preview_group_invite', { p_token: token });
    if (error) throw error;
    const r = one<any>(data as any) ?? { status: 'invalid' };
    return {
      status: r.status,
      conversationId: r.conversation_id ?? null,
      groupName: r.group_name ?? null,
      description: r.description ?? null,
      avatarData: r.avatar_data ?? null,
      memberCount: r.member_count ?? null,
      requiresApproval: !!r.requires_approval,
      isMember: !!r.is_member,
      hasPendingRequest: !!r.has_pending_request,
    };
  }

  async joinViaInvite(token: string): Promise<{ status: string; conversationId: string | null; requestId: string | null }> {
    const { data, error } = await supabase.rpc('join_group_via_invite', { p_token: token });
    if (error) throw error;
    const r = one<any>(data as any) ?? { status: 'invalid' };
    return { status: r.status, conversationId: r.conversation_id ?? null, requestId: r.request_id ?? null };
  }

  // ── Join requests ───────────────────────────────────────────────────────

  async listPendingRequests(conversationId: string): Promise<JoinRequest[]> {
    const { data, error } = await supabase
      .from('group_join_requests')
      .select('id, conversation_id, user_id, via, status, created_at, profiles!group_join_requests_user_id_fkey ( id, username, display_name )')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return ((data as any[]) || []).map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      userId: r.user_id,
      via: r.via,
      status: r.status,
      createdAt: r.created_at,
      user: r.profiles
        ? { id: r.profiles.id, username: r.profiles.username, displayName: r.profiles.display_name || r.profiles.username }
        : undefined,
    }));
  }

  async decideRequest(requestId: string, approve: boolean): Promise<void> {
    const { error } = await supabase.rpc(approve ? 'approve_group_join_request' : 'deny_group_join_request', {
      p_request_id: requestId,
    });
    if (error) throw error;
  }

  async cancelRequest(requestId: string): Promise<void> {
    const { error } = await supabase.rpc('cancel_group_join_request', { p_request_id: requestId });
    if (error) throw error;
  }

  // ── Events ──────────────────────────────────────────────────────────────

  /** Events visible to the caller (server limits them to "since I joined"). */
  async fetchEvents(conversationId: string, since?: string | null): Promise<GroupEvent[]> {
    let q = supabase
      .from('group_events')
      .select(EVENT_SELECT)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (since) q = q.gt('created_at', since);
    const { data, error } = await q;
    if (error) throw error;
    return ((data as any[]) || [])
      .map(parseGroupEvent)
      .filter((e): e is GroupEvent => !!e)
      .reverse();
  }

  async fetchEvent(eventId: string): Promise<GroupEvent | null> {
    const { data, error } = await supabase.from('group_events').select(EVENT_SELECT).eq('id', eventId).maybeSingle();
    if (error || !data) return null;
    return parseGroupEvent(data);
  }
}

export const groupRepository = new GroupRepository();
