/**
 * Story media: pick -> encrypt on device -> upload ciphertext; and
 * signed download -> verify hash -> decrypt -> local file.
 *
 * Encryption and transport use the shared attachment pipeline
 * (features/media/transfer): chunked secretstream encryption (format v2)
 * straight from/to disk, a signed upload URL and a native PUT, so even a
 * 50 MB video never sits in JS memory. Older stories (format v1, single-shot)
 * still decrypt.
 *
 * Why not mediaRepository.uploadEncrypted()? That API (and the media-upload /
 * media-download functions behind it) is scoped to a *conversation*: the row
 * needs a conversation_id and downloads are membership-checked. A story's
 * audience is not a conversation, so story blobs go to the private
 * `vero-stories` bucket, whose storage policies (008_stories.sql) allow
 * uploads only into <me>/<storyId>/ and downloads only by the story's author
 * and recipients. Keys travel only inside the story envelope.
 *
 * Everything that touches transport lives in uploadStoryMedia() /
 * downloadStoryMedia() so it can be pointed at the media module once it
 * supports non-conversation scopes.
 */

import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { supabase } from '../../core/network/supabase';
import { currentSession } from '../../core/session';
import { generateUUID } from '../../shared/utils/uuid';
import { exceedsUploadLimit, MediaTooLargeError } from '../media/limits';
import { decryptToLocal, encryptForUpload, fetchCiphertext, MediaUnavailableError, putCiphertext } from '../media/transfer';
import { MAX_STORY_VIDEO_MS, StoryMediaRef } from './payload';

export const STORY_MEDIA_BUCKET = 'vero-stories';
/** Plaintext cap; the ciphertext (slightly larger) must fit the bucket's 50 MB. */
export const MAX_STORY_MEDIA_BYTES = 49 * 1024 * 1024;

export interface PickedStoryMedia {
  uri: string;
  kind: 'image' | 'video';
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

export class StoryMediaError extends Error {}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

// ── Picking ────────────────────────────────────────────────────────────────

export async function pickStoryMedia(source: 'library' | 'camera'): Promise<PickedStoryMedia | null> {
  const permission =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new StoryMediaError(
      source === 'camera' ? 'Allow camera access in Settings to post stories.' : 'Allow photo library access in Settings to post stories.'
    );
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images', 'videos'],
    quality: 0.85,
    videoMaxDuration: MAX_STORY_VIDEO_MS / 1000,
  };
  const result =
    source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;

  const isVideo = asset.type === 'video';
  const picked: PickedStoryMedia = {
    uri: asset.uri,
    kind: isVideo ? 'video' : 'image',
    mimeType: asset.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
    size: asset.fileSize ?? 0,
    width: asset.width,
    height: asset.height,
    durationMs: asset.duration ?? undefined,
  };
  validatePicked(picked);
  return picked;
}

export function validatePicked(p: PickedStoryMedia): void {
  // Small tolerance: pickers report e.g. 30.02 s for a 30 s trim.
  if (p.kind === 'video' && p.durationMs && p.durationMs > MAX_STORY_VIDEO_MS + 500) {
    throw new StoryMediaError('Story videos can be up to 30 seconds. Trim it and try again.');
  }
  if (p.size > MAX_STORY_MEDIA_BYTES || (p.size > 0 && exceedsUploadLimit(p.size))) {
    throw new StoryMediaError(`Story media can be up to ${MAX_STORY_MEDIA_BYTES / 1024 / 1024} MB.`);
  }
}

function accountId(): string {
  const s = currentSession();
  if (!s) throw new StoryMediaError('Not signed in');
  return s.userId;
}

// ── Upload ─────────────────────────────────────────────────────────────────

/** Encrypts on device and uploads the ciphertext; returns the ref that goes INSIDE the story envelope. */
export async function uploadStoryMedia(picked: PickedStoryMedia, authorId: string, storyId: string): Promise<StoryMediaRef> {
  let enc;
  try {
    enc = await encryptForUpload({ uri: picked.uri }, accountId());
  } catch (e) {
    if (e instanceof MediaTooLargeError) {
      throw new StoryMediaError(`Story media can be up to ${MAX_STORY_MEDIA_BYTES / 1024 / 1024} MB.`);
    }
    throw e;
  }
  try {
    const path = `${authorId}/${storyId}/${generateUUID().toLowerCase()}.bin`;
    // Storage policies (008) allow this insert only under <me>/<storyId>/.
    const { data, error } = await supabase.storage.from(STORY_MEDIA_BUCKET).createSignedUploadUrl(path);
    if (error || !data?.signedUrl) throw new StoryMediaError(`Upload failed: ${error?.message ?? 'no upload URL'}`);
    await putCiphertext(enc, data.signedUrl, { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' });

    return {
      path,
      v: 2,
      chunkSize: enc.chunkSize,
      key: enc.key,
      nonce: enc.header,
      hash: enc.hash,
      mimeType: picked.mimeType,
      size: enc.plainSize,
      width: picked.width,
      height: picked.height,
      durationMs: picked.durationMs,
    };
  } finally {
    enc.dispose();
  }
}

// ── Download ───────────────────────────────────────────────────────────────

const decrypted = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function cacheDir(): Directory {
  const dir = new Directory(Paths.cache, 'vero-stories');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Returns a local URI with the decrypted media (cached per story for its lifetime). */
export function downloadStoryMedia(storyId: string, ref: StoryMediaRef): Promise<string> {
  const cached = decrypted.get(storyId);
  if (cached) return Promise.resolve(cached);
  let p = inflight.get(storyId);
  if (!p) {
    p = fetchAndDecrypt(storyId, ref).finally(() => inflight.delete(storyId));
    inflight.set(storyId, p);
  }
  return p;
}

async function fetchAndDecrypt(storyId: string, ref: StoryMediaRef): Promise<string> {
  const safeId = storyId.replace(/[^a-zA-Z0-9-]/g, '');
  const ext = EXT[ref.mimeType] ?? 'bin';

  if (Platform.OS !== 'web') {
    const existing = new File(cacheDir(), `${safeId}.${ext}`);
    if (existing.exists) {
      decrypted.set(storyId, existing.uri);
      return existing.uri;
    }
  }

  const { data, error } = await supabase.storage.from(STORY_MEDIA_BUCKET).createSignedUrl(ref.path, 60);
  if (error || !data?.signedUrl) throw new StoryMediaError('This story is no longer available.');
  let downloaded;
  try {
    downloaded = await fetchCiphertext(data.signedUrl, accountId());
  } catch (e) {
    throw new StoryMediaError(e instanceof MediaUnavailableError ? 'This story is no longer available.' : 'Download failed');
  }
  let uri: string;
  try {
    uri = await decryptToLocal(
      downloaded,
      ref,
      Platform.OS === 'web' ? null : new File(cacheDir(), `${safeId}.${ext}`)
    );
  } finally {
    downloaded.dispose();
  }
  decrypted.set(storyId, uri);
  return uri;
}

/** Drops decrypted copies of stories that are gone (expired, deleted, or no longer shared). */
export function purgeStoryMediaCache(liveStoryIds: Set<string>): void {
  for (const [id, uri] of decrypted) {
    if (liveStoryIds.has(id)) continue;
    decrypted.delete(id);
    if (Platform.OS === 'web') URL.revokeObjectURL(uri);
  }
  if (Platform.OS === 'web') return;
  try {
    const dir = new Directory(Paths.cache, 'vero-stories');
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      const id = entry.name.replace(/\.[^.]+$/, '');
      if (entry instanceof File && !liveStoryIds.has(id)) entry.delete();
    }
  } catch (e) {
    console.warn('[stories] cache purge failed:', (e as Error)?.message);
  }
}

export function clearStoryMediaCache(): void {
  purgeStoryMediaCache(new Set());
}
