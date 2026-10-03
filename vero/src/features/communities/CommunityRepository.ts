/**
 * Communities (migration 007). Membership: joining any linked group (or the
 * announcements group via an invite link) makes you a community member; the
 * announcements group is a regular E2EE group where only admins can send.
 */

import { supabase } from '../../core/network/supabase';
import {
  CommunityGroup,
  CommunityMember,
  CommunitySummary,
  parseCommunity,
  parseCommunityGroup,
} from './types';

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

class CommunityRepository {
  async mine(): Promise<CommunitySummary[]> {
    const { data, error } = await supabase.rpc('my_communities');
    if (error) throw error;
    return ((data as any[]) || []).map(parseCommunity).filter((c): c is CommunitySummary => !!c);
  }

  async details(communityId: string): Promise<CommunitySummary | null> {
    const { data, error } = await supabase.rpc('get_community_details', { p_community_id: communityId });
    if (error) throw error;
    return parseCommunity(one<any>(data as any));
  }

  async groups(communityId: string): Promise<CommunityGroup[]> {
    const { data, error } = await supabase.rpc('get_community_groups', { p_community_id: communityId });
    if (error) throw error;
    return ((data as any[]) || []).map(parseCommunityGroup).filter((g): g is CommunityGroup => !!g);
  }

  async members(communityId: string): Promise<CommunityMember[]> {
    const { data, error } = await supabase.rpc('list_community_members', { p_community_id: communityId });
    if (error) throw error;
    return ((data as any[]) || []).map((r) => ({
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name || r.username,
      role: r.role,
      joinedAt: r.joined_at,
    }));
  }

  async create(name: string, description?: string): Promise<string> {
    const { data, error } = await supabase.rpc('create_community', {
      p_name: name,
      p_description: description ?? null,
    });
    if (error) throw error;
    return data as string;
  }

  async update(communityId: string, patch: { name?: string; description?: string; avatarData?: string; clearAvatar?: boolean }): Promise<void> {
    const { error } = await supabase.rpc('update_community', {
      p_community_id: communityId,
      p_name: patch.name ?? null,
      p_description: patch.description ?? null,
      p_avatar_data: patch.avatarData ?? null,
      p_clear_avatar: !!patch.clearAvatar,
    });
    if (error) throw error;
  }

  async remove(communityId: string): Promise<void> {
    const { error } = await supabase.rpc('delete_community', { p_community_id: communityId });
    if (error) throw error;
  }

  async linkGroup(communityId: string, conversationId: string): Promise<void> {
    const { error } = await supabase.rpc('link_group_to_community', {
      p_community_id: communityId,
      p_conversation_id: conversationId,
    });
    if (error) throw error;
  }

  async unlinkGroup(communityId: string, conversationId: string): Promise<void> {
    const { error } = await supabase.rpc('unlink_group_from_community', {
      p_community_id: communityId,
      p_conversation_id: conversationId,
    });
    if (error) throw error;
  }

  async createGroup(communityId: string, name: string, description?: string): Promise<string> {
    const { data, error } = await supabase.rpc('create_community_group', {
      p_community_id: communityId,
      p_name: name,
      p_description: description ?? null,
    });
    if (error) throw error;
    return data as string;
  }

  async joinGroup(communityId: string, conversationId: string): Promise<{ status: string; requestId: string | null }> {
    const { data, error } = await supabase.rpc('join_community_group', {
      p_community_id: communityId,
      p_conversation_id: conversationId,
    });
    if (error) throw error;
    const r = one<any>(data as any) ?? { status: 'invalid' };
    return { status: r.status, requestId: r.request_id ?? null };
  }

  async setRole(communityId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
    const { error } = await supabase.rpc('set_community_member_role', {
      p_community_id: communityId,
      p_user_id: userId,
      p_role: role,
    });
    if (error) throw error;
  }

  async removeMember(communityId: string, userId: string): Promise<void> {
    const { error } = await supabase.rpc('remove_community_member', { p_community_id: communityId, p_user_id: userId });
    if (error) throw error;
  }

  async leave(communityId: string): Promise<void> {
    const { error } = await supabase.rpc('leave_community', { p_community_id: communityId });
    if (error) throw error;
  }
}

export const communityRepository = new CommunityRepository();
