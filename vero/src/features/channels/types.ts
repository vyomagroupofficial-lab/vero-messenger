/** Channels: one-to-many broadcast. Server-readable (not E2EE) by design. */

export type ChannelVisibility = 'public' | 'private';

export interface ChannelSummary {
  id: string;
  handle: string;
  name: string;
  description: string | null;
  avatarData: string | null;
  visibility: ChannelVisibility;
  followerCount: number;
  /** null when the caller isn't an admin. */
  myRole: 'owner' | 'admin' | null;
  isFollowing: boolean;
  muted: boolean;
  lastPostAt: string | null;
}

export interface ChannelPost {
  id: string;
  channelId: string;
  body: string | null;
  mediaPath: string | null;
  mediaMime: string | null;
  reactionCounts: Record<string, number>;
  createdAt: string;
  editedAt: string | null;
}

export interface ChannelInvitePreview {
  status: string;
  channelId: string | null;
  name: string | null;
  handle: string | null;
  description: string | null;
  avatarData: string | null;
  followerCount: number | null;
  isFollowing: boolean;
}
