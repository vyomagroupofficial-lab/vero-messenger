/**
 * Vero Conversation Repository
 *
 * Manages conversations, fetching members, and last message resolution.
 * All message content is decrypted locally - only ciphertext touches Supabase.
 */

import { supabase } from '../../core/network/supabase';
import { Conversation, User, Message, MessageType } from '../../shared/models/Message';
import { cryptoManager } from '../../core/crypto/CryptoManager';

class ConversationRepository {
  // ──────────────────────────────────────────────────────────────────────────
  // Fetch conversations for the current user
  // ──────────────────────────────────────────────────────────────────────────

  async getConversations(currentUserId: string): Promise<Conversation[]> {
    try {
      // Get conversation IDs the user is a member of
      const { data: memberData, error: memberError } = await supabase
        .from('conversation_members')
        .select('conversation_id, joined_at')
        .eq('user_id', currentUserId)
        .is('left_at', null);

      if (memberError) throw memberError;
      if (!memberData?.length) return [];

      const conversationIds = memberData.map((m: any) => m.conversation_id);

      // Fetch conversation details
      const { data: convData, error: convError } = await supabase
        .from('conversations')
        .select('*')
        .in('id', conversationIds)
        .order('updated_at', { ascending: false });

      if (convError) throw convError;

      // Fetch members for each conversation
      const conversations: Conversation[] = [];
      for (const conv of (convData || [])) {
        const conversation = await this.buildConversation(conv, currentUserId);
        if (conversation) conversations.push(conversation);
      }

      return conversations;
    } catch (e) {
      console.error('[ConversationRepository] getConversations error:', e);
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Build conversation object with members and last message
  // ──────────────────────────────────────────────────────────────────────────

  private async buildConversation(
    raw: any,
    currentUserId: string
  ): Promise<Conversation | null> {
    try {
      const members = await this.getConversationMembers(raw.id);
      const otherMembers = members.filter((m) => m.id !== currentUserId);

      let otherUser: User | undefined;
      if (raw.conversation_type === 'direct' && otherMembers.length > 0) {
        otherUser = otherMembers[0];
      }

      // Get last message (ciphertext only from DB)
      const lastMsgData = await this.getLastMessage(raw.id, currentUserId);

      return {
        id: raw.id,
        conversationType: raw.conversation_type,
        otherUser,
        memberCount: members.length,
        lastMessage: lastMsgData || undefined,
        unreadCount: 0, // TODO: calculate from receipts
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
      };
    } catch {
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Members
  // ──────────────────────────────────────────────────────────────────────────

  async getConversationMembers(conversationId: string): Promise<User[]> {
    const { data, error } = await supabase
      .from('conversation_members')
      .select(`
        user_id,
        profiles:user_id (
          id,
          username,
          display_name,
          avatar_reference,
          about
        )
      `)
      .eq('conversation_id', conversationId)
      .is('left_at', null);

    if (error) return [];

    return (data || []).map((m: any) => ({
      id: m.profiles?.id || m.user_id,
      username: m.profiles?.username || '',
      displayName: m.profiles?.display_name || 'Unknown',
      avatarReference: m.profiles?.avatar_reference,
      about: m.profiles?.about,
    }));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Create conversation
  // ──────────────────────────────────────────────────────────────────────────

  async createDirectConversation(
    currentUserId: string,
    otherUserId: string
  ): Promise<{ conversationId: string } | null> {
    try {
      // Check if conversation already exists
      const existing = await this.findDirectConversation(currentUserId, otherUserId);
      if (existing) return { conversationId: existing };

      // Create new conversation
      const { data: conv, error: convError } = await supabase
        .from('conversations')
        .insert({ conversation_type: 'direct' })
        .select('id')
        .single();

      if (convError || !conv) throw convError;

      // Add members
      const { error: memberError } = await supabase
        .from('conversation_members')
        .insert([
          { conversation_id: conv.id, user_id: currentUserId, role: 'member' },
          { conversation_id: conv.id, user_id: otherUserId, role: 'member' },
        ]);

      if (memberError) throw memberError;

      return { conversationId: conv.id };
    } catch (e) {
      console.error('[ConversationRepository] createDirectConversation error:', e);
      return null;
    }
  }

  private async findDirectConversation(
    userId1: string,
    userId2: string
  ): Promise<string | null> {
    const { data } = await supabase.rpc('find_direct_conversation', {
      user_a: userId1,
      user_b: userId2,
    });
    return data || null;
  }

  async createGroupConversation(
    currentUserId: string,
    memberUserIds: string[],
    groupName: string
  ): Promise<{ conversationId: string } | null> {
    try {
      const { data: conv, error: convError } = await supabase
        .from('conversations')
        .insert({
          conversation_type: 'group',
          group_name: groupName,
        })
        .select('id')
        .single();

      if (convError || !conv) throw convError;

      const allMembers = Array.from(new Set([currentUserId, ...memberUserIds]));
      const memberInserts = allMembers.map((uid) => ({
        conversation_id: conv.id,
        user_id: uid,
        role: uid === currentUserId ? 'admin' : 'member',
      }));

      const { error: memberError } = await supabase
        .from('conversation_members')
        .insert(memberInserts);

      if (memberError) throw memberError;

      return { conversationId: conv.id };
    } catch (e) {
      console.error('[ConversationRepository] createGroupConversation error:', e);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Last message (for chat list preview)
  // ──────────────────────────────────────────────────────────────────────────

  private async getLastMessage(
    conversationId: string,
    currentUserId: string
  ): Promise<Conversation['lastMessage'] | null> {
    const { data } = await supabase
      .from('messages')
      .select(`
        id,
        ciphertext,
        message_type,
        created_at,
        sender_device_id,
        devices:sender_device_id (
          user_id,
          profiles:user_id (
            display_name
          )
        )
      `)
      .eq('conversation_id', conversationId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!data) return null;

    const senderUserId = (data as any).devices?.user_id;
    const senderDisplayName = (data as any).devices?.profiles?.display_name || 'Unknown';
    const isOwn = senderUserId === currentUserId;

    // Note: We don't decrypt the last message here for performance.
    // The chat list shows a generic preview.
    return {
      content: undefined, // Will be decrypted when needed
      messageType: (data as any).message_type as MessageType,
      senderDisplayName: isOwn ? 'You' : senderDisplayName,
      createdAt: (data as any).created_at,
      isOwn,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // User search (for starting new chats)
  // ──────────────────────────────────────────────────────────────────────────

  async searchUsers(query: string, currentUserId: string): Promise<User[]> {
    if (query.trim().length < 2) return [];

    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_reference')
      .neq('id', currentUserId)
      .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
      .limit(20);

    if (error) return [];

    return (data || []).map((u: any) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      avatarReference: u.avatar_reference,
    }));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Recipient public key (for E2EE session establishment)
  // ──────────────────────────────────────────────────────────────────────────

  async getRecipientPublicKey(userId: string): Promise<string | null> {
    const { data, error } = await supabase
      .from('devices')
      .select('identity_public_key')
      .eq('user_id', userId)
      .is('revoked_at', null)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .single();

    if (error) return null;
    return data?.identity_public_key || null;
  }
}

export const conversationRepository = new ConversationRepository();
