/**
 * Vero Media Repository: end-to-end encrypted attachments.
 *
 * Upload (uploadEncrypted):
 *   1. preview: tiny blurred thumbnail + dimensions for images/videos
 *   2. encrypt on device with a fresh key, 64 KiB secretstream chunks (format v2)
 *   3. media-upload {create}: membership + size check, pending `media` row,
 *      one-off signed upload URL
 *   4. PUT the ciphertext straight to Storage (never through a function)
 *   5. media-upload {confirm}: server re-hashes the stored object (BLAKE2b-256)
 *   -> key, header, hash, preview, waveform... go ONLY into the E2EE payload.
 *
 * Download (downloadDecrypted):
 *   media-download (membership check) -> short-lived signed URL -> native
 *   download to a temp file -> verify hash + decrypt chunk by chunk into the
 *   per-account decrypted cache (mediaCache). Old v1 attachments still work.
 *
 * Stable API for other features (stickers, GIFs, ...):
 *   uploadEncrypted(source, conversationId, opts) -> MessageMedia
 *   downloadDecrypted(media, opts) -> local URI
 */

import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { File } from 'expo-file-system';
import { supabase, SUPABASE_URL } from '../../core/network/supabase';
import { currentSession } from '../../core/session';
import { databaseService } from '../../core/storage/DatabaseService';
import type { MediaAttachment } from '../../shared/models/Message';
import { MediaKind, MessageMedia, sanitizeFileName } from '../../shared/models/payload';
import { exceedsUploadLimit, MAX_ENCRYPTED_BYTES, MediaTooLargeError } from './limits';
import { mediaCache } from './mediaCache';
import { imagePreview, videoPreview } from './thumbnails';
import {
  decryptToLocal,
  encryptForUpload,
  fetchCiphertext,
  isWeb,
  MediaUnavailableError,
  putCiphertext,
  TransferProgress,
} from './transfer';

export { MediaTooLargeError, MediaUnavailableError, MAX_ENCRYPTED_BYTES };
export type { TransferPhase, TransferProgress } from './transfer';

/** Something to send: a local file URI (or raw bytes) plus what we know about it. */
export interface PickedMedia {
  uri: string;
  /** Raw plaintext instead of reading `uri` (e.g. a sticker rendered in memory). */
  bytes?: Uint8Array;
  kind: MediaKind;
  mimeType: string;
  /** Plaintext size if known (0 = unknown; measured while encrypting). */
  size: number;
  fileName?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Voice notes: 64 peaks 0..100. */
  waveform?: number[];
  /** Precomputed preview (base64 JPEG); computed automatically for images/videos otherwise. */
  thumb?: string;
}

export interface UploadOptions {
  onProgress?: TransferProgress;
  /** Skip thumbnail generation (e.g. stickers that are tiny anyway). */
  skipPreview?: boolean;
}

export interface DownloadOptions {
  onProgress?: TransferProgress;
}

function fromAsset(asset: ImagePicker.ImagePickerAsset): PickedMedia {
  const isVideo = asset.type === 'video';
  return {
    uri: asset.uri,
    kind: isVideo ? 'video' : 'image',
    mimeType: asset.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
    size: asset.fileSize ?? 0,
    fileName: asset.fileName ?? undefined,
    width: asset.width,
    height: asset.height,
    durationMs: asset.duration ?? undefined,
  };
}

function requireAccount(): string {
  const s = currentSession();
  if (!s) throw new Error('Not signed in');
  return s.userId;
}

async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');
  return token;
}

async function functionErrorMessage(error: any, fallback: string): Promise<{ message: string; status?: number }> {
  const status: number | undefined = error?.context?.status;
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return { message: body.error, status };
  } catch {
    // ignore
  }
  return { message: error?.message || fallback, status };
}

async function invoke<T>(fn: string, body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    const { message, status } = await functionErrorMessage(error, fallback);
    if (status === 413) throw new MediaTooLargeError();
    throw new Error(message);
  }
  return data as T;
}

interface CreateResponse {
  mediaId: string;
  objectId: string;
  upload: { url: string; method: 'PUT'; headers: Record<string, string> };
}

const inflight = new Map<string, Promise<string>>();

class MediaRepository {
  // ── Picking ──────────────────────────────────────────────────────────────

  async pickFromLibrary(): Promise<PickedMedia | null> {
    const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!granted) throw new Error('Allow photo library access in Settings to send photos.');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.85,
      videoMaxDuration: 600,
    });
    return result.canceled || !result.assets[0] ? null : fromAsset(result.assets[0]);
  }

  async pickFromCamera(): Promise<PickedMedia | null> {
    const { granted } = await ImagePicker.requestCameraPermissionsAsync();
    if (!granted) throw new Error('Allow camera access in Settings to take photos.');
    const result = await ImagePicker.launchCameraAsync({ quality: 0.85, mediaTypes: ['images', 'videos'] });
    return result.canceled || !result.assets[0] ? null : fromAsset(result.assets[0]);
  }

  async pickDocument(): Promise<PickedMedia | null> {
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return null;
    const asset = result.assets[0];
    return {
      uri: asset.uri,
      kind: 'document',
      mimeType: asset.mimeType || 'application/octet-stream',
      size: asset.size ?? 0,
      fileName: asset.name,
    };
  }

  /** Friendly pre-check before any work (the server enforces the same cap). */
  assertSendable(picked: Pick<PickedMedia, 'size'>): void {
    if (picked.size > 0 && exceedsUploadLimit(picked.size)) throw new MediaTooLargeError(picked.size);
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  /**
   * Encrypts and uploads; returns the attachment description for the E2EE
   * payload. The sender's plaintext is kept in the cache as `localUri` by
   * `rememberSent()`.
   */
  async uploadEncrypted(picked: PickedMedia, conversationId: string, opts: UploadOptions = {}): Promise<MessageMedia> {
    const accountId = requireAccount();
    this.assertSendable(picked);
    const { onProgress } = opts;

    onProgress?.('preparing', 0);
    let { thumb, width, height } = picked;
    if (!opts.skipPreview && !thumb && (picked.kind === 'image' || picked.kind === 'video')) {
      const preview =
        picked.kind === 'image'
          ? await imagePreview(picked.uri, width, height)
          : await videoPreview(picked.uri, width, height);
      thumb = preview.thumb;
      width = preview.width ?? width;
      height = preview.height ?? height;
    }

    const enc = await encryptForUpload({ uri: picked.uri, bytes: picked.bytes }, accountId, onProgress);
    try {
      const created = await invoke<CreateResponse>(
        'media-upload',
        { action: 'create', conversationId, size: enc.encryptedSize, hash: enc.hash },
        'Upload failed'
      );
      if (!created?.mediaId || !created.upload?.url) throw new Error('Upload failed: unexpected response');

      await putCiphertext(enc, created.upload.url, created.upload.headers ?? {}, onProgress);

      onProgress?.('verifying', 0);
      const confirmed = await this.confirm(created.mediaId);
      onProgress?.('verifying', 1);

      const media: MessageMedia = {
        mediaId: created.mediaId,
        objectId: confirmed.objectId,
        v: 2,
        chunkSize: enc.chunkSize,
        key: enc.key,
        nonce: enc.header,
        hash: enc.hash,
        mimeType: picked.mimeType,
        size: enc.plainSize,
      };
      const fileName = sanitizeFileName(picked.fileName);
      if (fileName) media.fileName = fileName;
      if (width && height) {
        media.width = Math.round(width);
        media.height = Math.round(height);
      }
      if (picked.durationMs && picked.durationMs > 0) media.durationMs = Math.round(picked.durationMs);
      if (picked.kind === 'voice' && picked.waveform?.length) media.waveform = picked.waveform;
      if (thumb) media.thumb = thumb;
      return media;
    } finally {
      enc.dispose();
    }
  }

  /** Confirm, retrying briefly if Storage hasn't made the object visible yet. */
  private async confirm(mediaId: string): Promise<{ objectId: string }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await invoke<{ objectId: string }>('media-upload', { action: 'confirm', mediaId }, 'Upload failed');
        if (res?.objectId) return res;
        lastError = new Error('Upload failed: unexpected response');
      } catch (e) {
        lastError = e;
        if (!/not arrived/i.test((e as Error)?.message ?? '')) break;
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    throw lastError;
  }

  /**
   * After sending: keeps the sender's plaintext in the account's cache under
   * the media id (moved for files we created, like voice recordings; copied
   * for picker files). Returns the local URI to show immediately.
   */
  rememberSent(media: MessageMedia, sourceUri: string, move = false): string {
    if (isWeb) {
      const accountId = currentSession()?.userId;
      if (accountId && sourceUri.startsWith('blob:')) mediaCache.rememberWeb(accountId, media.mediaId, sourceUri);
      return sourceUri;
    }
    const accountId = currentSession()?.userId;
    if (!accountId) return sourceUri;
    return mediaCache.store(accountId, sourceUri, media, move) ?? sourceUri;
  }

  // ── Download ─────────────────────────────────────────────────────────────

  /** Decrypted local copy if we already have one (no network). */
  findCached(media: MediaAttachment | MessageMedia): string | null {
    const accountId = currentSession()?.userId;
    const local = (media as MediaAttachment).localUri;
    if (isWeb) return (accountId && mediaCache.findWeb(accountId, media.mediaId)) || local || null;
    if (local) {
      try {
        if (new File(local).exists) return local;
      } catch {
        // fall through
      }
    }
    if (!accountId) return null;
    return mediaCache.find(accountId, media)?.uri ?? null;
  }

  /** Returns a local URI with the decrypted content (cached per account + media id). */
  downloadDecrypted(media: MediaAttachment | MessageMedia, opts: DownloadOptions = {}): Promise<string> {
    const cached = this.findCached(media);
    if (cached) return Promise.resolve(cached);
    const accountId = requireAccount();
    const key = `${accountId}:${media.mediaId}`;
    let p = inflight.get(key);
    if (!p) {
      p = this.fetchAndDecrypt(accountId, media, opts).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  /** @deprecated use downloadDecrypted */
  getDecryptedFile(media: MediaAttachment): Promise<string> {
    return this.downloadDecrypted(media);
  }

  private async fetchAndDecrypt(
    accountId: string,
    media: MediaAttachment | MessageMedia,
    opts: DownloadOptions
  ): Promise<string> {
    const token = await accessToken();
    const base = `${SUPABASE_URL}/functions/v1/media-download?id=${encodeURIComponent(media.mediaId)}`;
    const authHeaders = { Authorization: `Bearer ${token}` };

    // Ask for a short-lived signed URL; Drive (no signed URLs) falls back to the proxy.
    const res = await fetch(`${base}&mode=url`, { headers: authHeaders });
    if (res.status === 404) throw new MediaUnavailableError();
    if (!res.ok) throw new Error('Download failed. Please try again.');
    const info = (await res.json()) as { url: string | null };

    const downloaded = info.url
      ? await fetchCiphertext(info.url, accountId, {}, opts.onProgress)
      : await fetchCiphertext(base, accountId, authHeaders, opts.onProgress);
    try {
      const target = isWeb ? null : mediaCache.fileFor(accountId, media);
      const uri = await decryptToLocal(downloaded, media, target, opts.onProgress);
      if (isWeb) mediaCache.rememberWeb(accountId, media.mediaId, uri);
      return uri;
    } finally {
      downloaded.dispose();
    }
  }

  // ── Documents ────────────────────────────────────────────────────────────

  /** Opens the system share/open sheet for a decrypted document under its real name. */
  async openDocument(media: MediaAttachment | MessageMedia, opts: DownloadOptions = {}): Promise<void> {
    const uri = await this.downloadDecrypted(media, opts);
    const name = sanitizeFileName(media.fileName) || `file-${media.mediaId.slice(0, 8)}`;
    if (isWeb) {
      const a = document.createElement('a');
      a.href = uri;
      a.download = name;
      a.rel = 'noopener';
      a.click();
      return;
    }
    if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
    const accountId = requireAccount();
    const copy = mediaCache.shareCopy(accountId, new File(uri), name);
    await Sharing.shareAsync(copy.uri, { mimeType: media.mimeType, dialogTitle: name });
  }

  // ── Cache ────────────────────────────────────────────────────────────────

  /** Drops the decrypted copy of one attachment (message deleted/expired). */
  evict(media: Pick<MediaAttachment, 'mediaId' | 'mimeType' | 'fileName'> | undefined | null): void {
    const accountId = currentSession()?.userId;
    if (!media || !accountId) return;
    mediaCache.evict(accountId, media);
  }

  /**
   * Deletes decrypted files no longer referenced by any local message
   * (deleted, expired, cleared chats), plus stale temp files.
   */
  async sweepCache(): Promise<number> {
    const accountId = currentSession()?.userId;
    if (!accountId) return 0;
    const live = await databaseService.getLiveMediaIds();
    if (!live) return 0;
    return mediaCache.sweep(accountId, live);
  }

  /** Removes this account's decrypted media (Settings → Clear media cache). */
  clearMediaCache(): void {
    mediaCache.clearAccount(currentSession()?.userId ?? null);
  }

  /** @deprecated use clearMediaCache */
  clearCache(): void {
    this.clearMediaCache();
  }
}

export const mediaRepository = new MediaRepository();

/** For Settings: removes the signed-in account's decrypted media cache. */
export function clearMediaCache(): void {
  mediaRepository.clearMediaCache();
}
