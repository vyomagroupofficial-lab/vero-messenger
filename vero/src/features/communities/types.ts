/** Communities: related groups + an E2EE announcements group (admins post). */

export type CommunityRole = 'owner' | 'admin' | 'member';

export interface CommunitySummary {
  id: string;
  name: string;
  description: string | null;
  avatarData: string | null;
  announcementsConversationId: string | null;
  memberCount: number;
  groupCount: number;
  myRole: CommunityRole | null;
}

export interface CommunityGroup {
  conversationId: string;
  name: string;
  description: string | null;
  avatarData: string | null;
  memberCount: number;
  isAnnouncements: boolean;
  isMember: boolean;
  joinApprovalRequired: boolean;
  hasPendingRequest: boolean;
}

export interface CommunityMember {
  userId: string;
  username: string;
  displayName: string;
  role: CommunityRole;
  joinedAt: string;
}

export function parseCommunity(row: any): CommunitySummary | null {
  if (!row || typeof row.id !== 'string') return null;
  return {
    id: row.id,
    name: String(row.name ?? ''),
    description: row.description ?? null,
    avatarData: row.avatar_data ?? null,
    announcementsConversationId: row.announcements_conversation_id ?? null,
    memberCount: Number(row.member_count ?? 0),
    groupCount: Number(row.group_count ?? 0),
    myRole: ['owner', 'admin', 'member'].includes(row.my_role) ? row.my_role : null,
  };
}

export function parseCommunityGroup(row: any): CommunityGroup | null {
  if (!row || typeof row.conversation_id !== 'string') return null;
  return {
    conversationId: row.conversation_id,
    name: String(row.group_name ?? 'Group'),
    description: row.description ?? null,
    avatarData: row.avatar_data ?? null,
    memberCount: Number(row.member_count ?? 0),
    isAnnouncements: !!row.is_announcements,
    isMember: !!row.is_member,
    joinApprovalRequired: !!row.join_approval_required,
    hasPendingRequest: !!row.has_pending_request,
  };
}

/** What the join button should say for a group in the community list. */
export function communityGroupAction(g: CommunityGroup): 'open' | 'join' | 'request' | 'requested' {
  if (g.isMember) return 'open';
  if (g.hasPendingRequest) return 'requested';
  return g.joinApprovalRequired ? 'request' : 'join';
}

export const isCommunityAdmin = (role: CommunityRole | null | undefined) => role === 'owner' || role === 'admin';
