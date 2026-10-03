/**
 * Encrypted attachment helpers for stickers and GIFs.
 *
 * Same pipeline as MediaRepository (fresh key per file -> media-upload ->
 * key only inside the E2EE payload), but works from raw bytes so it also
 * runs on web, where expo-file-system's File API isn't available.
 */

import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { supabase, SUPABASE_URL } from '../../core/network/supabase';
import { cryptoManager } from '../../core/crypto/CryptoManager';
import type { MediaAttachment } from '../../shared/models/Message';
import type { WireMedia } from '../../shared/models/payloadExtensions';
import { mediaRepository } from '../media/MediaRepository';

export const MAX_EXT_MEDIA_BYTES = 8 * 1024 * 1024;

export async function functionError(error: any, fallback: string): Promise<string> {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return body.error;
  } catch {
    // ignore
  }
  return error?.message || fallback;
}

/** Reads a local (file:, blob:, data:) URI into bytes. */
export async function readUriBytes(uri: string): Promise<Uint8Array> {
  if (Platform.OS !== 'web' && uri.startsWith('file:')) {
    const { File } = await import('expo-file-system');
    return new File(uri).bytes();
  }
  const res = await fetch(uri);
  return new Uint8Array(await res.arrayBuffer());
}

export async function uploadEncryptedBytes(
  plain: Uint8Array,
  conversationId: string,
  meta: { mimeType: string; width?: number; height?: number; durationMs?: number; fileName?: string }
): Promise<WireMedia> {
  if (plain.byteLength === 0) throw new Error('Empty file');
  if (plain.byteLength > MAX_EXT_MEDIA_BYTES) throw new Error('This file is too large to send.');
  const blob = await cryptoManager.encryptFile(plain);
  const { data, error } = await supabase.functions.invoke('media-upload', {
    body: { conversationId, data: await cryptoManager.toBase64Standard(blob.ciphertext), hash: blob.hash },
  });
  if (error) throw new Error(await functionError(error, 'Upload failed'));
  if (!data?.mediaId || !data?.objectId) throw new Error('Upload failed: unexpected response');
  return {
    mediaId: data.mediaId,
    objectId: data.objectId,
    key: blob.key,
    nonce: blob.nonce,
    hash: blob.hash,
    mimeType: meta.mimeType,
    size: plain.byteLength,
    fileName: meta.fileName,
    width: meta.width,
    height: meta.height,
    durationMs: meta.durationMs,
  };
}

// Web: decrypted blobs live in memory as object URLs for the session.
const webCache = new Map<string, string>();

async function decryptForWeb(media: MediaAttachment): Promise<string> {
  const cached = webCache.get(media.mediaId);
  if (cached) return cached;
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Not signed in');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/media-download?id=${encodeURIComponent(media.mediaId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(res.status === 404 ? 'No longer available' : 'Download failed');
  const plain = await cryptoManager.decryptFile(new Uint8Array(await res.arrayBuffer()), media.key, media.nonce, media.hash);
  const url = URL.createObjectURL(new Blob([plain as BlobPart], { type: media.mimeType }));
  webCache.set(media.mediaId, url);
  return url;
}

export function getDecryptedUri(media: MediaAttachment): Promise<string> {
  if (media.localUri && (Platform.OS === 'web' || !media.localUri.startsWith('file:'))) {
    return Promise.resolve(media.localUri);
  }
  return Platform.OS === 'web' ? decryptForWeb(media) : mediaRepository.getDecryptedFile(media);
}

/** Downloads + decrypts automatically (stickers and GIFs are small). */
export function useDecryptedUri(media: MediaAttachment | undefined) {
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!media) return;
    let cancelled = false;
    setError(null);
    getDecryptedUri(media)
      .then((u) => !cancelled && setUri(u))
      .catch((e) => !cancelled && setError(e?.message || 'Could not decrypt'));
    return () => {
      cancelled = true;
    };
  }, [media?.mediaId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { uri, error, retry };
}
