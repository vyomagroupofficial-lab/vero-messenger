/**
 * Vero Media Repository
 *
 * Upload:   read file -> encrypt with a fresh random key (XChaCha20-Poly1305)
 *           -> media-upload Edge Function (stores ciphertext in Google Drive)
 *           -> the key/nonce go into the E2EE message payload only.
 * Download: media-download Edge Function (membership-checked proxy)
 *           -> verify hash -> decrypt -> cache file on this device.
 */

import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { supabase, SUPABASE_URL } from '../../core/network/supabase';
import { cryptoManager } from '../../core/crypto/CryptoManager';
import { MediaAttachment } from '../../shared/models/Message';
import { MediaKind } from '../../shared/models/payload';

/** Edge Function request bodies are capped; base64 adds ~33%. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export interface PickedMedia {
  uri: string;
  kind: MediaKind;
  mimeType: string;
  size: number;
  fileName?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export class MediaTooLargeError extends Error {
  constructor() {
    super(`Files larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB can't be sent yet.`);
  }
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
};

function cacheDir(): Directory {
  const dir = new Directory(Paths.cache, 'vero-media');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
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

class MediaRepository {
  // ── Picking ──────────────────────────────────────────────────────────────

  async pickFromLibrary(): Promise<PickedMedia | null> {
    const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!granted) throw new Error('Allow photo library access in Settings to send photos.');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.85,
      videoMaxDuration: 120,
    });
    return result.canceled || !result.assets[0] ? null : fromAsset(result.assets[0]);
  }

  async pickFromCamera(): Promise<PickedMedia | null> {
    const { granted } = await ImagePicker.requestCameraPermissionsAsync();
    if (!granted) throw new Error('Allow camera access in Settings to take photos.');
    const result = await ImagePicker.launchCameraAsync({ quality: 0.85 });
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

  // ── Upload ───────────────────────────────────────────────────────────────

  /** Encrypts and uploads; returns the attachment description for the E2EE payload. */
  async uploadEncrypted(picked: PickedMedia, conversationId: string): Promise<Omit<MediaAttachment, 'localUri'>> {
    const file = new File(picked.uri);
    const plain = await file.bytes();
    if (plain.byteLength > MAX_UPLOAD_BYTES) throw new MediaTooLargeError();

    const blob = await cryptoManager.encryptFile(plain);
    const { data, error } = await supabase.functions.invoke('media-upload', {
      body: {
        conversationId,
        data: await cryptoManager.toBase64Standard(blob.ciphertext),
        hash: blob.hash,
      },
    });
    if (error) throw new Error(await functionErrorMessage(error, 'Upload failed'));
    if (!data?.mediaId || !data?.objectId) throw new Error('Upload failed: unexpected response');

    return {
      mediaId: data.mediaId,
      objectId: data.objectId,
      key: blob.key,
      nonce: blob.nonce,
      hash: blob.hash,
      mimeType: picked.mimeType,
      size: plain.byteLength,
      fileName: picked.fileName,
      width: picked.width,
      height: picked.height,
      durationMs: picked.durationMs,
    };
  }

  // ── Download ─────────────────────────────────────────────────────────────

  /** Returns a local file URI with the decrypted content (cached per media id). */
  async getDecryptedFile(media: MediaAttachment): Promise<string> {
    if (media.localUri && new File(media.localUri).exists) return media.localUri;

    const ext = EXTENSIONS[media.mimeType] || media.fileName?.split('.').pop()?.slice(0, 8) || 'bin';
    const target = new File(cacheDir(), `${media.mediaId.replace(/[^a-zA-Z0-9-]/g, '')}.${ext}`);
    if (target.exists) return target.uri;

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new Error('Not signed in');

    const res = await fetch(`${SUPABASE_URL}/functions/v1/media-download?id=${encodeURIComponent(media.mediaId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(res.status === 404 ? 'This file is no longer available.' : 'Download failed');

    const ciphertext = new Uint8Array(await res.arrayBuffer());
    const plain = await cryptoManager.decryptFile(ciphertext, media.key, media.nonce, media.hash);
    target.create({ overwrite: true });
    target.write(plain);
    return target.uri;
  }

  /**
   * Removes the decrypted copy of one attachment from this device's cache
   * (message deleted for everyone / for me). Files outside the app's media
   * cache (e.g. the sender's original photo) are never touched.
   */
  deleteCachedFile(media: Pick<MediaAttachment, 'mediaId' | 'localUri'>): void {
    try {
      const dir = cacheDir();
      const prefix = media.mediaId.replace(/[^a-zA-Z0-9-]/g, '');
      if (prefix) {
        for (const entry of dir.list()) {
          if (entry instanceof File && entry.name.startsWith(`${prefix}.`)) entry.delete();
        }
      }
      if (media.localUri && media.localUri.startsWith(dir.uri)) {
        const f = new File(media.localUri);
        if (f.exists) f.delete();
      }
    } catch (e) {
      console.warn('[MediaRepository] cache cleanup failed:', (e as Error)?.message);
    }
  }

  clearCache(): void {
    const dir = new Directory(Paths.cache, 'vero-media');
    if (dir.exists) dir.delete();
  }
}

async function functionErrorMessage(error: any, fallback: string): Promise<string> {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return body.error;
  } catch {
    // ignore
  }
  return error?.message || fallback;
}

export const mediaRepository = new MediaRepository();
