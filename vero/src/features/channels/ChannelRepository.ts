/**
 * Channels (migration 007). Posts are server-readable by design - NOT
 * end-to-end encrypted - so they can reach thousands of followers. Images go
 * to the private `vero-channel-media` bucket; storage policies let channel
 * readers download and channel admins upload into `<channelId>/...`.
 */

import { File } from 'expo-file-system';
import { supabase } from '../../core/network/supabase';
import { generateUUID } from '../../shared/utils/uuid';
import { channelMediaPath, parseChannelPost, parseChannelSummary } from './channelUtils';
import type { ChannelInvitePreview, ChannelPost, ChannelSummary, ChannelVisibility } from './types';

export const CHANNEL_MEDIA_BUCKET = 'vero-channel-media';
const POST_COLUMNS = 'id, channel_id, body, media_path, media_mime, reaction_counts, created_at, edited_at';
export const POSTS_PAGE = 30;

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

class ChannelRepository {
  async myChannels(): Promise<ChannelSummary[]> {
    const { data, error } = await supabase.rpc('my_channels');
    if (error) throw error;
    return ((data as any[]) || []).map(parseChannelSummary).filter((c): c is ChannelSummary => !!c);
  }

  /** Public directory. Empty query = most followed. */
  async search(query: string): Promise<ChannelSummary[]> {
    const { data, error } = await supabase.rpc('search_channels', { p_query: query.trim(), p_limit: 30 });
    if (error) throw error;
    return ((data as any[]) || [])
      .map((r) => parseChannelSummary({ ...r, visibility: 'public' }))
      .filter((c): c is ChannelSummary => !!c);
  }

  async getDetails(channelId: string): Promise<ChannelSummary | null> {
    const { data, error } = await supabase.rpc('get_channel_details', { p_channel_id: channelId });
    if (error) throw error;
    return parseChannelSummary(one<any>(data as any));
  }

  async handleAvailable(handle: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('channel_handle_available', { p_handle: handle });
    if (error) throw error;
    return !!data;
  }

  async create(input: { name: string; handle: string; description?: string; visibility: ChannelVisibility }): Promise<string> {
    const { data, error } = await supabase.rpc('create_channel', {
      p_name: input.name,
      p_handle: input.handle,
      p_description: input.description ?? null,
      p_visibility: input.visibility,
    });
    if (error) throw error;
    return data as string;
  }

  async update(
    channelId: string,
    patch: { name?: string; description?: string; avatarData?: string; clearAvatar?: boolean; visibility?: ChannelVisibility }
  ): Promise<void> {
    const { error } = await supabase.rpc('update_channel', {
      p_channel_id: channelId,
      p_name: patch.name ?? null,
      p_description: patch.description ?? null,
      p_avatar_data: patch.avatarData ?? null,
      p_clear_avatar: !!patch.clearAvatar,
      p_visibility: patch.visibility ?? null,
    });
    if (error) throw error;
  }

  async remove(channelId: string): Promise<void> {
    // Best effort: remove uploaded images first (rows cascade server-side).
    try {
      const { data } = await supabase.storage.from(CHANNEL_MEDIA_BUCKET).list(channelId, { limit: 1000 });
      if (data?.length) {
        await supabase.storage.from(CHANNEL_MEDIA_BUCKET).remove(data.map((o) => `${channelId}/${o.name}`));
      }
    } catch {
      // ignore - the channel row delete below is what matters
    }
    const { error } = await supabase.rpc('delete_channel', { p_channel_id: channelId });
    if (error) throw error;
  }

  async getInviteToken(channelId: string): Promise<string | null> {
    const { data, error } = await supabase.rpc('get_channel_invite_token', { p_channel_id: channelId });
    if (error) throw error;
    return (data as string) || null;
  }

  async rotateInvite(channelId: string): Promise<string> {
    const { data, error } = await supabase.rpc('rotate_channel_invite', { p_channel_id: channelId });
    if (error) throw error;
    return data as string;
  }

  async previewInvite(token: string): Promise<ChannelInvitePreview> {
    const { data, error } = await supabase.rpc('preview_channel_invite', { p_token: token });
    if (error) throw error;
    const r = one<any>(data as any) ?? { status: 'invalid' };
    return {
      status: r.status,
      channelId: r.channel_id ?? null,
      name: r.name ?? null,
      handle: r.handle ?? null,
      description: r.description ?? null,
      avatarData: r.avatar_data ?? null,
      followerCount: r.follower_count ?? null,
      isFollowing: !!r.is_following,
    };
  }

  async followViaInvite(token: string): Promise<{ status: string; channelId: string | null }> {
    const { data, error } = await supabase.rpc('follow_channel_via_invite', { p_token: token });
    if (error) throw error;
    const r = one<any>(data as any) ?? { status: 'invalid' };
    return { status: r.status, channelId: r.channel_id ?? null };
  }

  async follow(channelId: string): Promise<void> {
    const { error } = await supabase.rpc('follow_channel', { p_channel_id: channelId });
    if (error) throw error;
  }

  async unfollow(channelId: string): Promise<void> {
    const { error } = await supabase.rpc('unfollow_channel', { p_channel_id: channelId });
    if (error) throw error;
  }

  async setMuted(channelId: string, muted: boolean): Promise<void> {
    const { error } = await supabase.rpc('set_channel_muted', { p_channel_id: channelId, p_muted: muted });
    if (error) throw error;
  }

  async addAdmin(channelId: string, userId: string): Promise<void> {
    const { error } = await supabase.rpc('add_channel_admin', { p_channel_id: channelId, p_user_id: userId });
    if (error) throw error;
  }

  async removeAdmin(channelId: string, userId: string): Promise<void> {
    const { error } = await supabase.rpc('remove_channel_admin', { p_channel_id: channelId, p_user_id: userId });
    if (error) throw error;
  }

  async listAdmins(channelId: string): Promise<{ userId: string; role: 'owner' | 'admin'; displayName: string; username: string }[]> {
    const { data, error } = await supabase
      .from('channel_admins')
      .select('user_id, role, profiles ( username, display_name )')
      .eq('channel_id', channelId);
    if (error) throw error;
    return ((data as any[]) || []).map((r) => ({
      userId: r.user_id,
      role: r.role,
      displayName: r.profiles?.display_name || r.profiles?.username || 'Unknown',
      username: r.profiles?.username || '',
    }));
  }

  // ── Posts ───────────────────────────────────────────────────────────────

  async loadPosts(channelId: string, before?: string): Promise<{ posts: ChannelPost[]; hasMore: boolean }> {
    let q = supabase
      .from('channel_posts')
      .select(POST_COLUMNS)
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(POSTS_PAGE);
    if (before) q = q.lt('created_at', before);
    const { data, error } = await q;
    if (error) throw error;
    const posts = ((data as any[]) || []).map(parseChannelPost).filter((p): p is ChannelPost => !!p);
    return { posts, hasMore: posts.length === POSTS_PAGE };
  }

  /** The caller's reactions on these posts (others' reactions are only counts). */
  async myReactions(postIds: string[]): Promise<Record<string, string>> {
    if (!postIds.length) return {};
    const { data, error } = await supabase.from('channel_post_reactions').select('post_id, emoji').in('post_id', postIds);
    if (error) throw error;
    return Object.fromEntries(((data as any[]) || []).map((r) => [r.post_id, r.emoji]));
  }

  async uploadImage(channelId: string, uri: string, mime: string): Promise<string> {
    const path = channelMediaPath(channelId, mime, generateUUID());
    const bytes = await new File(uri).bytes();
    const { error } = await supabase.storage.from(CHANNEL_MEDIA_BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
    if (error) throw error;
    return path;
  }

  async publish(channelId: string, body: string | null, media?: { path: string; mime: string } | null): Promise<ChannelPost> {
    const { data, error } = await supabase
      .from('channel_posts')
      .insert({
        channel_id: channelId,
        body: body?.trim() ? body.trim() : null,
        media_path: media?.path ?? null,
        media_mime: media?.mime ?? null,
      })
      .select(POST_COLUMNS)
      .single();
    if (error) throw error;
    const post = parseChannelPost(data);
    if (!post) throw new Error('Unexpected server response');
    return post;
  }

  async editPost(postId: string, body: string): Promise<void> {
    const { error } = await supabase.from('channel_posts').update({ body }).eq('id', postId);
    if (error) throw error;
  }

  async deletePost(post: Pick<ChannelPost, 'id' | 'mediaPath'>): Promise<void> {
    const { error } = await supabase.from('channel_posts').delete().eq('id', post.id);
    if (error) throw error;
    if (post.mediaPath) await supabase.storage.from(CHANNEL_MEDIA_BUCKET).remove([post.mediaPath]).catch(() => undefined);
  }

  async react(postId: string, emoji: string | null): Promise<void> {
    const { error } = await supabase.rpc('react_to_channel_post', { p_post_id: postId, p_emoji: emoji });
    if (error) throw error;
  }

  /** Short-lived URL for a post image (bucket is private; RLS checks readership). */
  async imageUrl(path: string): Promise<string | null> {
    const { data, error } = await supabase.storage.from(CHANNEL_MEDIA_BUCKET).createSignedUrl(path, 3600);
    if (error) return null;
    return data?.signedUrl ?? null;
  }
}

export const channelRepository = new ChannelRepository();
