/**
 * Encrypted attachment helpers for stickers and GIFs.
 *
 * Thin adapter over MediaRepository (features/media): fresh key per file,
 * chunked encryption, signed direct upload + server-side hash check, signed
 * downloads into the per-account decrypted cache. Works from raw bytes, so it
 * also runs on web.
 */

import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { currentSession } from '../../core/session';
import type { MediaAttachment } from '../../shared/models/Message';
import type { WireMedia } from '../../shared/models/payloadExtensions';
import { mediaCache } from '../media/mediaCache';
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
  return mediaRepository.uploadEncrypted(
    {
      uri: '',
      bytes: plain,
      kind: meta.mimeType.startsWith('video/') ? 'video' : 'image',
      mimeType: meta.mimeType,
      size: plain.byteLength,
      fileName: meta.fileName,
      width: meta.width,
      height: meta.height,
      durationMs: meta.durationMs,
    },
    conversationId,
    { skipPreview: true }
  );
}

/** Web: lets the sender reuse the plaintext it just uploaded (object URLs die on reload). */
export function rememberWebUri(mediaId: string, url: string): void {
  const accountId = currentSession()?.userId;
  if (accountId) mediaCache.rememberWeb(accountId, mediaId, url);
}

export function getDecryptedUri(media: MediaAttachment): Promise<string> {
  if (Platform.OS === 'web' && media.localUri?.startsWith('data:')) return Promise.resolve(media.localUri);
  return mediaRepository.downloadDecrypted(media);
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
