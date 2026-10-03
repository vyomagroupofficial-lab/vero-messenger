/**
 * Stories: post / fetch / view / delete against Supabase.
 *
 * Post:  resolve audience on device -> fetch every audience device key
 *        (pinned, like messages) -> encrypt the payload ONCE for all of them
 *        (CryptoManager.encryptMessage with a story-bound context) -> split the
 *        key slots per recipient -> post_story RPC.
 * Read:  RLS returns only live stories we're in the audience of, plus only
 *        our own key slots -> verify the author device key (pinned) -> decrypt.
 */

import { supabase } from '../../core/network/supabase';
import { cryptoManager } from '../../core/crypto/CryptoManager';
import { DecryptionError, NotAddressedToDeviceError, parseEnvelope, serializeEnvelope } from '../../core/crypto/primitives';
import { databaseService, PinnedDeviceKey } from '../../core/storage/DatabaseService';
import type { SessionContext } from '../../core/session';
import { generateUUID } from '../../shared/utils/uuid';
import { keyDirectory, KeyMismatchError } from '../keys/KeyDirectory';
import { StoryPrivacy, normalizePrivacy } from './audience';
import { isExpired } from './expiry';
import { MAX_STORY_CAPTION, MAX_STORY_TEXT, StoryFont, StoryPayload, parseStoryPayload, serverStoryType } from './payload';
import { AudienceDevice, assembleStoryEnvelope, splitStoryEnvelope, storyContext } from './storyCrypto';
import { PickedStoryMedia, uploadStoryMedia } from './storyMedia';

export interface Story {
  id: string;
  authorId: string;
  authorDeviceId: string;
  createdAt: string;
  expiresAt: string;
  isOwn: boolean;
  /** null when the story could not be decrypted on this device. */
  payload: StoryPayload | null;
  error?: string;
}

export type StoryDraft =
  | { kind: 'text'; text: string; bg: string; font: StoryFont }
  | { kind: 'media'; media: PickedStoryMedia; caption?: string };

export interface StoryViewer {
  userId: string;
  displayName: string;
  viewedAt: string;
}

interface ServerStoryRow {
  id: string;
  author_id: string;
  author_device_id: string;
  story_type: 'text' | 'media';
  ciphertext: string;
  media_path: string | null;
  created_at: string;
  expires_at: string;
}

const STORY_COLUMNS = 'id, author_id, author_device_id, story_type, ciphertext, media_path, created_at, expires_at';
const CHUNK = 100;

function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

class StoryRepository {
  /** Decrypted payloads are immutable per story id; keep them for the session. */
  private decrypted = new Map<string, { payload: StoryPayload | null; error?: string }>();

  reset(): void {
    this.decrypted.clear();
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  async fetchLive(session: SessionContext): Promise<Story[]> {
    const { data, error } = await supabase
      .from('stories')
      .select(STORY_COLUMNS)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(1000);
    if (error) throw error;
    const rows = (data ?? []) as ServerStoryRow[];

    const needSlots = rows.filter((r) => r.author_id !== session.userId && !this.decrypted.has(r.id)).map((r) => r.id);
    const slots = new Map<string, Record<string, string>>();
    for (const ids of chunks(needSlots)) {
      const { data: slotRows, error: slotError } = await supabase
        .from('story_recipients')
        .select('story_id, key_slots')
        .eq('recipient_id', session.userId)
        .in('story_id', ids);
      if (slotError) throw slotError;
      for (const r of slotRows ?? []) slots.set((r as any).story_id, (r as any).key_slots);
    }

    const authorKeys = await keyDirectory.getKeys(
      rows.filter((r) => !this.decrypted.has(r.id)).map((r) => r.author_device_id)
    );

    const stories: Story[] = [];
    for (const row of rows) {
      if (isExpired(row.expires_at)) continue;
      let result = this.decrypted.get(row.id);
      if (!result) {
        result = await this.decryptRow(session, row, slots.get(row.id) ?? null, authorKeys);
        // Only cache successes: a transient key-fetch failure should retry next load.
        if (result.payload) this.decrypted.set(row.id, result);
      }
      stories.push({
        id: row.id,
        authorId: row.author_id,
        authorDeviceId: row.author_device_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        isOwn: row.author_id === session.userId,
        payload: result.payload,
        error: result.error,
      });
    }
    return stories;
  }

  private async decryptRow(
    session: SessionContext,
    row: ServerStoryRow,
    mySlots: Record<string, string> | null,
    authorKeys: Map<string, PinnedDeviceKey>
  ): Promise<{ payload: StoryPayload | null; error?: string }> {
    try {
      const key = authorKeys.get(row.author_device_id);
      if (!key || key.userId !== row.author_id) throw new Error('Unknown author device');
      const isOwn = row.author_id === session.userId;
      if (!isOwn && !mySlots) throw new NotAddressedToDeviceError();
      const envelope = assembleStoryEnvelope(row.ciphertext, isOwn ? null : mySlots);
      const plaintext = await cryptoManager.decryptMessage(
        session.userId,
        session.deviceId,
        serializeEnvelope(envelope),
        storyContext(row.author_id, row.id, row.author_device_id),
        key.publicKey
      );
      const payload = parseStoryPayload(plaintext);
      if (!payload) throw new DecryptionError('Unreadable story');
      if ((payload.kind === 'text') !== (row.story_type === 'text')) throw new DecryptionError('Story type mismatch');
      if (payload.kind !== 'text' && payload.media.path !== row.media_path) throw new DecryptionError('Media mismatch');
      return { payload };
    } catch (e) {
      return {
        payload: null,
        error:
          e instanceof NotAddressedToDeviceError
            ? 'This story was shared before this device was linked.'
            : "This story couldn't be decrypted.",
      };
    }
  }

  // ── Posting ────────────────────────────────────────────────────────────────

  /** Active, pinned device keys for me + the audience. Throws on a changed key (like messages). */
  private async audienceDevices(audienceIds: string[]): Promise<AudienceDevice[]> {
    const { data, error } = await supabase.rpc('get_story_audience_devices', { p_user_ids: audienceIds });
    if (error) throw error;
    const fresh: PinnedDeviceKey[] = ((data as any[]) ?? []).map((r) => ({
      deviceId: r.device_id,
      userId: r.user_id,
      publicKey: r.identity_public_key,
    }));
    const pinned = new Map((await databaseService.getDeviceKeys(fresh.map((k) => k.deviceId))).map((k) => [k.deviceId, k]));
    for (const k of fresh) {
      const known = pinned.get(k.deviceId);
      if (known && (known.publicKey !== k.publicKey || known.userId !== k.userId)) throw new KeyMismatchError(k.deviceId);
    }
    await databaseService.saveDeviceKeys(fresh);
    return fresh.map((k) => ({ deviceId: k.deviceId, userId: k.userId, publicKey: k.publicKey }));
  }

  async post(
    session: SessionContext,
    draft: StoryDraft,
    audienceIds: string[],
    onStage?: (stage: 'uploading' | 'encrypting' | 'sending') => void
  ): Promise<{ story: Story; recipients: number }> {
    const storyId = generateUUID().toLowerCase();

    let payload: StoryPayload;
    if (draft.kind === 'text') {
      const text = draft.text.trim();
      if (!text) throw new Error('Write something first.');
      if (text.length > MAX_STORY_TEXT) throw new Error(`Text stories can be up to ${MAX_STORY_TEXT} characters.`);
      payload = { t: 'story', kind: 'text', text, bg: draft.bg, font: draft.font };
    } else {
      const caption = draft.caption?.trim() || undefined;
      if (caption && caption.length > MAX_STORY_CAPTION) {
        throw new Error(`Captions can be up to ${MAX_STORY_CAPTION} characters.`);
      }
      onStage?.('uploading');
      const media = await uploadStoryMedia(draft.media, session.userId, storyId);
      payload = { t: 'story', kind: draft.media.kind, caption, media };
    }

    onStage?.('encrypting');
    const devices = await this.audienceDevices(audienceIds);
    const serialized = await cryptoManager.encryptMessage(
      session.userId,
      JSON.stringify(payload),
      storyContext(session.userId, storyId, session.deviceId),
      devices
    );
    const split = splitStoryEnvelope(parseEnvelope(serialized), devices, session.userId);

    onStage?.('sending');
    const { data, error } = await supabase.rpc('post_story', {
      p_story_id: storyId,
      p_device_id: session.deviceId,
      p_story_type: serverStoryType(payload),
      p_ciphertext: split.storyCiphertext,
      p_media_path: payload.kind === 'text' ? null : payload.media.path,
      p_recipients: Object.entries(split.recipientSlots).map(([user_id, key_slots]) => ({ user_id, key_slots })),
    });
    if (error) throw error;

    this.decrypted.set(storyId, { payload });
    const now = Date.now();
    return {
      recipients: typeof data === 'number' ? data : 0,
      story: {
        id: storyId,
        authorId: session.userId,
        authorDeviceId: session.deviceId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 24 * 3600 * 1000).toISOString(),
        isOwn: true,
        payload,
      },
    };
  }

  async delete(storyId: string): Promise<void> {
    const { error } = await supabase.rpc('delete_story', { p_story_id: storyId });
    if (error) throw error;
    this.decrypted.delete(storyId);
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  async markViewed(storyId: string): Promise<void> {
    const { error } = await supabase.rpc('mark_story_viewed', { p_story_id: storyId });
    if (error) console.warn('[stories] view receipt failed:', error.message);
  }

  async viewCounts(storyIds: string[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const ids of chunks(storyIds)) {
      const { data, error } = await supabase.from('story_views').select('story_id').in('story_id', ids);
      if (error) throw error;
      for (const r of data ?? []) counts[(r as any).story_id] = (counts[(r as any).story_id] ?? 0) + 1;
    }
    return counts;
  }

  async viewers(storyId: string): Promise<StoryViewer[]> {
    const { data, error } = await supabase
      .from('story_views')
      .select('viewer_id, viewed_at, profiles ( display_name, username )')
      .eq('story_id', storyId)
      .order('viewed_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r: any) => {
      const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
      return {
        userId: r.viewer_id,
        displayName: p?.display_name || p?.username || 'Unknown',
        viewedAt: r.viewed_at,
      };
    });
  }

  // ── Privacy (synced own row) ──────────────────────────────────────────────

  async loadPrivacy(): Promise<StoryPrivacy | null> {
    const { data, error } = await supabase
      .from('story_privacy')
      .select('audience, except_user_ids, only_user_ids, muted_user_ids')
      .maybeSingle();
    if (error) throw error;
    return data ? normalizePrivacy(data) : null;
  }

  async savePrivacy(userId: string, p: StoryPrivacy): Promise<void> {
    const { error } = await supabase.from('story_privacy').upsert(
      {
        user_id: userId,
        audience: p.audience,
        except_user_ids: p.exceptUserIds,
        only_user_ids: p.onlyUserIds,
        muted_user_ids: p.mutedUserIds,
      },
      { onConflict: 'user_id' }
    );
    if (error) throw error;
  }
}

export const storyRepository = new StoryRepository();
