/**
 * Conversations, members and the user directory.
 * Membership changes go through server RPCs that enforce authorization.
 */

import { supabase } from '../../core/network/supabase';
import { databaseService } from '../../core/storage/DatabaseService';
import {
  Conversation,
  ConversationMember,
  User,
  messagePreview,
} from '../../shared/models/Message';

function toUser(p: any): User {
  return {
    id: p.id,
    username: p.username ?? '',
    displayName: p.display_name || p.username || 'Unknown',
    avatarReference: p.avatar_reference ?? null,
    about: p.about ?? null,
  };
}

class ConversationRepository {
  /** Server conversations + locally decrypted previews/unread counts. */
  async getConversations(currentUserId: string): Promise<Conversation[]> {
    const { data, error } = await supabase
      .from('conversations')
      .select(
        `id, conversation_type, group_name, created_at, updated_at,
         conversation_members ( user_id, role, left_at, last_delivered_at, last_read_at,
           profiles ( id, username, display_name, avatar_reference, about ) )`
      )
      .order('updated_at', { ascending: false });
    if (error) throw error;

    const conversations: Conversation[] = (data || []).map((raw: any) => {
      const members: ConversationMember[] = (raw.conversation_members || [])
        .filter((m: any) => !m.left_at)
        .map((m: any) => ({
          ...toUser(m.profiles ?? { id: m.user_id }),
          id: m.user_id,
          role: m.role,
          lastDeliveredAt: m.last_delivered_at,
          lastReadAt: m.last_read_at,
        }));
      return {
        id: raw.id,
        conversationType: raw.conversation_type,
        groupName: raw.group_name,
        otherUser:
          raw.conversation_type === 'direct' ? members.find((m) => m.id !== currentUserId) : undefined,
        members,
        unreadCount: 0,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
      };
    });

    await databaseService.saveConversations(conversations);
    return this.withLocalState(conversations, currentUserId);
  }

  /** Offline start-up: last known list from the local cache. */
  async getCachedConversations(currentUserId: string): Promise<Conversation[]> {
    return this.withLocalState(await databaseService.getCachedConversations(), currentUserId);
  }

  private async withLocalState(list: Conversation[], currentUserId: string): Promise<Conversation[]> {
    const [lastMessages, unread] = await Promise.all([
      databaseService.getLastMessages(),
      databaseService.getUnreadCounts(),
    ]);
    return list.map((c) => {
      const last = lastMessages[c.id];
      return {
        ...c,
        unreadCount: unread[c.id] || 0,
        lastMessage: last
          ? {
              content: messagePreview(last.messageType, last.content),
              messageType: last.messageType,
              senderName: last.senderUserId === currentUserId ? 'You' : last.senderName,
              createdAt: last.createdAt,
              isOwn: last.senderUserId === currentUserId,
            }
          : undefined,
      };
    });
  }

  async getConversation(conversationId: string, currentUserId: string): Promise<Conversation | null> {
    const all = await this.getConversations(currentUserId).catch(() => this.getCachedConversations(currentUserId));
    return all.find((c) => c.id === conversationId) ?? null;
  }

  async createDirectConversation(otherUserId: string): Promise<string> {
    const { data, error } = await supabase.rpc('create_direct_conversation', { p_other_user_id: otherUserId });
    if (error) throw error;
    return data as string;
  }

  async createGroupConversation(name: string, memberIds: string[]): Promise<string> {
    const { data, error } = await supabase.rpc('create_group_conversation', {
      p_name: name,
      p_member_ids: memberIds,
    });
    if (error) throw error;
    return data as string;
  }

  async leaveConversation(conversationId: string, currentUserId: string): Promise<void> {
    const { error } = await supabase.rpc('remove_group_member', {
      p_conversation_id: conversationId,
      p_user_id: currentUserId,
    });
    if (error) throw error;
  }

  /** Directory search (server escapes LIKE wildcards; no client-built filters). */
  async searchUsers(query: string): Promise<User[]> {
    if (query.trim().length < 2) return [];
    const { data, error } = await supabase.rpc('search_profiles', { p_query: query.trim() });
    if (error) throw error;
    return (data || []).map(toUser);
  }

  async getProfile(userId: string): Promise<User | null> {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_reference, about')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) return null;
    return toUser(data);
  }

  async blockUser(userId: string): Promise<void> {
    const { error } = await supabase.from('blocks').insert({ blocked_user_id: userId });
    if (error && error.code !== '23505') throw error;
  }

  async unblockUser(userId: string): Promise<void> {
    const { error } = await supabase.from('blocks').delete().eq('blocked_user_id', userId);
    if (error) throw error;
  }

  async isBlocked(userId: string): Promise<boolean> {
    const { data } = await supabase.from('blocks').select('blocked_user_id').eq('blocked_user_id', userId).maybeSingle();
    return !!data;
  }

  async reportUser(userId: string, reason: string, conversationId?: string): Promise<void> {
    const { error } = await supabase.from('reports').insert({
      reported_user_id: userId,
      reason,
      conversation_id: conversationId ?? null,
    });
    if (error) throw error;
  }
}

export const conversationRepository = new ConversationRepository();
