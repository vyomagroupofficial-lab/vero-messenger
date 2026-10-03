/**
 * Download + decrypt an attachment on demand (or automatically for small
 * images), with progress. Returns the cached local URI once available.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { friendlyError } from '../../core/network/supabase';
import type { MediaAttachment } from '../../shared/models/Message';
import { mediaRepository } from './MediaRepository';
import type { TransferPhase } from './transfer';

export interface DecryptedMediaState {
  uri: string | null;
  loading: boolean;
  /** 0..1 across download + decrypt */
  progress: number;
  phase: TransferPhase | null;
  error: string | null;
  load: () => Promise<string | null>;
}

export function useDecryptedMedia(media: MediaAttachment | undefined, autoLoad: boolean): DecryptedMediaState {
  const [uri, setUri] = useState<string | null>(() => (media ? mediaRepository.findCached(media) : null));
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<TransferPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    []
  );

  // A different attachment (e.g. list cell reuse) starts from its own cache state.
  const mediaId = media?.mediaId;
  useEffect(() => {
    setUri(media ? mediaRepository.findCached(media) : null);
    setError(null);
    setProgress(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId]);

  const load = useCallback(async () => {
    if (!media) return null;
    setLoading(true);
    setError(null);
    try {
      const file = await mediaRepository.downloadDecrypted(media, {
        onProgress: (p, f) => {
          if (!mounted.current) return;
          setPhase(p);
          // Download is most of the wait; decrypting is the rest.
          setProgress(p === 'downloading' ? f * 0.8 : p === 'decrypting' ? 0.8 + f * 0.2 : 0);
        },
      });
      if (mounted.current) setUri(file);
      return file;
    } catch (e) {
      if (mounted.current) setError(friendlyError(e, 'Could not load media'));
      return null;
    } finally {
      if (mounted.current) {
        setLoading(false);
        setPhase(null);
      }
    }
  }, [media]);

  useEffect(() => {
    if (autoLoad && media && !uri && !loading && !error) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoad, mediaId, uri]);

  return { uri, loading, progress, phase, error, load };
}
