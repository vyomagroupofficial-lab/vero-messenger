/**
 * Pure helpers for channels: handles, counts, reactions, post parsing.
 *
 * Channel posts are NOT end-to-end encrypted (see CHANNELS_E2EE_NOTICE):
 * per-device key fan-out doesn't scale to thousands of followers, so - like
 * WhatsApp Channels - the server can read channel posts.
 */

import type { ChannelPost, ChannelSummary } from './types';

export const CHANNELS_E2EE_NOTICE = "Channel updates aren't end-to-end encrypted. Vero's servers can read them.";

export const HANDLE_RE = /^[a-z0-9_]{3,32}$/;
export const MAX_POST_LENGTH = 4096;
export const CHANNEL_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** "@Trail News!" -> "trail_news" (what the server will store). */
export function normalizeHandle(input: string): string {
  return input
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 32);
}

export function isValidHandle(handle: string): boolean {
  return HANDLE_RE.test(handle);
}

/** Suggests a handle from a channel name. */
export function suggestHandle(name: string): string {
  const h = normalizeHandle(name).replace(/_+/g, '_').replace(/^_|_$/g, '');
  return h.length >= 3 ? h : (h + '_channel').slice(0, 32);
}

/** 999, 1.2K, 34K, 1.5M */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? Math.floor(k * 10) / 10 : Math.floor(k)}K`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? Math.floor(m * 10) / 10 : Math.floor(m)}M`;
}

export function followersLabel(n: number): string {
  return `${formatCount(n)} follower${n === 1 ? '' : 's'}`;
}

export type ReactionCounts = Record<string, number>;

/** Optimistic update mirroring the server trigger: one reaction per user. */
export function applyReactionChange(
  counts: ReactionCounts,
  previous: string | null,
  next: string | null
): ReactionCounts {
  if (previous === next) return counts;
  const out: ReactionCounts = { ...counts };
  if (previous) {
    const v = (out[previous] ?? 0) - 1;
    if (v > 0) out[previous] = v;
    else delete out[previous];
  }
  if (next) out[next] = (out[next] ?? 0) + 1;
  return out;
}

/** Highest counts first; ties keep emoji order stable. */
export function sortedReactions(counts: ReactionCounts): { emoji: string; count: number }[] {
  return Object.entries(counts || {})
    .filter(([, c]) => typeof c === 'number' && c > 0)
    .map(([emoji, count]) => ({ emoji, count }))
    .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
}

export function totalReactions(counts: ReactionCounts): number {
  return Object.values(counts || {}).reduce((s, c) => s + (typeof c === 'number' && c > 0 ? c : 0), 0);
}

/** Defensive parse of a post row (REST or realtime payload). */
export function parseChannelPost(row: any): ChannelPost | null {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || typeof row.channel_id !== 'string') return null;
  const counts: ReactionCounts = {};
  if (row.reaction_counts && typeof row.reaction_counts === 'object') {
    for (const [k, v] of Object.entries(row.reaction_counts)) {
      if (typeof v === 'number' && v > 0 && k.length <= 16) counts[k] = v;
    }
  }
  return {
    id: row.id,
    channelId: row.channel_id,
    body: typeof row.body === 'string' ? row.body : null,
    mediaPath: typeof row.media_path === 'string' ? row.media_path : null,
    mediaMime: typeof row.media_mime === 'string' ? row.media_mime : null,
    reactionCounts: counts,
    createdAt: String(row.created_at ?? ''),
    editedAt: typeof row.edited_at === 'string' ? row.edited_at : null,
  };
}

export function parseChannelSummary(row: any): ChannelSummary | null {
  if (!row || typeof row.id !== 'string') return null;
  return {
    id: row.id,
    handle: String(row.handle ?? ''),
    name: String(row.name ?? ''),
    description: row.description ?? null,
    avatarData: row.avatar_data ?? null,
    visibility: row.visibility === 'private' ? 'private' : 'public',
    followerCount: Number(row.follower_count ?? 0),
    myRole: row.my_role === 'owner' || row.my_role === 'admin' ? row.my_role : null,
    isFollowing: !!row.is_following,
    muted: !!row.muted,
    lastPostAt: row.last_post_at ?? null,
  };
}

/** Newest first, de-duplicated by id (realtime + REST may overlap). */
export function mergePosts(existing: ChannelPost[], incoming: ChannelPost[]): ChannelPost[] {
  const byId = new Map<string, ChannelPost>();
  for (const p of existing) byId.set(p.id, p);
  for (const p of incoming) byId.set(p.id, { ...byId.get(p.id), ...p });
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Storage object path for a new post image: <channelId>/<random>.<ext> */
export function channelMediaPath(channelId: string, mime: string, random: string): string {
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';
  return `${channelId}/${random.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}.${ext}`;
}
