/** Client-side shapes for group admin tools (server rows mapped to camelCase). */

import type { User } from '../../shared/models/Message';

export type GroupRole = 'owner' | 'admin' | 'member';

export interface GroupSettings {
  description: string | null;
  avatarData: string | null;
  onlyAdminsSend: boolean;
  onlyAdminsEditInfo: boolean;
  joinApprovalRequired: boolean;
  deletedAt: string | null;
}

export const DEFAULT_GROUP_SETTINGS: GroupSettings = {
  description: null,
  avatarData: null,
  onlyAdminsSend: false,
  onlyAdminsEditInfo: true,
  joinApprovalRequired: false,
  deletedAt: null,
};

export interface GroupMemberInfo extends User {
  role: GroupRole;
  joinedAt: string;
}

export interface GroupDetails {
  id: string;
  name: string;
  createdAt: string;
  settings: GroupSettings;
  members: GroupMemberInfo[];
  /** Community this group belongs to (only visible to community members). */
  community: { id: string; isAnnouncements: boolean } | null;
}

export interface GroupInvite {
  id: string;
  conversationId: string;
  token: string;
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  requiresApproval: boolean;
  revokedAt: string | null;
}

export interface JoinRequest {
  id: string;
  conversationId: string;
  userId: string;
  via: 'invite' | 'community';
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
  createdAt: string;
  user?: User;
}

export interface InvitePreview {
  status: string;
  conversationId: string | null;
  groupName: string | null;
  description: string | null;
  avatarData: string | null;
  memberCount: number | null;
  requiresApproval: boolean;
  isMember: boolean;
  hasPendingRequest: boolean;
}

export type GroupEventType =
  | 'created'
  | 'added'
  | 'joined'
  | 'left'
  | 'removed'
  | 'promoted'
  | 'demoted'
  | 'owner_changed'
  | 'renamed'
  | 'description_changed'
  | 'avatar_changed'
  | 'settings_changed';

export interface GroupEvent {
  id: string;
  conversationId: string;
  actorId: string | null;
  targetId: string | null;
  eventType: GroupEventType;
  details: Record<string, unknown>;
  createdAt: string;
  actorName?: string | null;
  targetName?: string | null;
}
