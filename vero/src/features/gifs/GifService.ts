/**
 * GIF search + sending.
 *
 * Search, trending, previews and the GIF download all go through the
 * `gif-search` Edge Function (privacy proxy). Sending downloads the GIF (MP4)
 * on this device, encrypts it and uploads it like any attachment, so the
 * recipient never receives the provider URL and the provider never learns
 * who received it.
 */

import { Platform } from 'react-native';
import { supabase, SUPABASE_URL } from '../../core/network/supabase';
import { requireSession } from '../../core/session';
import type { Message } from '../../shared/models/Message';
import { useMessagesStore } from '../messages/useMessagesStore';
import { functionError, rememberWebUri, uploadEncryptedBytes } from '../stickers/extMedia';

export type GifProvider = 'tenor' | 'giphy';

export interface GifItem {
  id: string;
  title: string;
  width: number;
  height: number;
  previewUri: string;
  previewMime: string;
  sendUri: string;
  sendMime: string;
  sendWidth: number;
  sendHeight: number;
}

export interface GifPage {
  items: GifItem[];
  next: string | null;
  provider: GifProvider | null;
}

export class GifNotConfiguredError extends Error {
  constructor() {
    super('GIF search isn’t set up on this server yet.');
  }
}

/** Parses the function's response defensively (it's our server, but still). */
export function parseGifPage(data: any): GifPage {
  const proxied = (p: unknown) =>
    typeof p === 'string' && p.startsWith('/functions/v1/gif-search?') ? `${SUPABASE_URL}${p}` : null;
  const items: GifItem[] = [];
  for (const r of Array.isArray(data?.results) ? data.results : []) {
    const previewUri = proxied(r?.preview?.path);
    const sendUri = proxied(r?.send?.path);
    if (!previewUri || !sendUri || typeof r.id !== 'string') continue;
    items.push({
      id: r.id,
      title: typeof r.title === 'string' ? r.title.slice(0, 140) : '',
      width: Number(r.width) || 1,
      height: Number(r.height) || 1,
      previewUri,
      previewMime: String(r.preview.mimeType ?? 'image/gif'),
      sendUri,
      sendMime: String(r.send.mimeType ?? 'video/mp4'),
      sendWidth: Number(r.send.width) || Number(r.width) || 0,
      sendHeight: Number(r.send.height) || Number(r.height) || 0,
    });
  }
  return {
    items,
    next: typeof data?.next === 'string' && data.next ? data.next : null,
    provider: data?.provider === 'tenor' || data?.provider === 'giphy' ? data.provider : null,
  };
}

class GifService {
  private statusCache: { configured: boolean; provider: GifProvider | null; at: number } | null = null;

  async status(): Promise<{ configured: boolean; provider: GifProvider | null }> {
    if (this.statusCache && Date.now() - this.statusCache.at < 5 * 60_000) return this.statusCache;
    const { data, error } = await supabase.functions.invoke('gif-search', { body: { action: 'status' } });
    if (error) throw new Error(await functionError(error, 'GIF search is unavailable'));
    this.statusCache = {
      configured: data?.configured === true,
      provider: data?.provider === 'tenor' || data?.provider === 'giphy' ? data.provider : null,
      at: Date.now(),
    };
    return this.statusCache;
  }

  async fetchPage(query: string, pos?: string | null): Promise<GifPage> {
    const q = query.trim();
    const { data, error } = await supabase.functions.invoke('gif-search', {
      body: { action: q ? 'search' : 'trending', q: q || undefined, pos: pos || undefined, limit: 24 },
    });
    if (error) {
      const status = (error as any)?.context?.status;
      if (status === 503) throw new GifNotConfiguredError();
      throw new Error(await functionError(error, 'GIF search failed'));
    }
    return parseGifPage(data);
  }

  async send(conversationId: string, gif: GifItem, replyTo?: Message | null): Promise<void> {
    const session = requireSession();
    if (session.isDemo) throw new Error('GIFs need a real account so they can be encrypted and uploaded.');
    const res = await fetch(gif.sendUri);
    if (!res.ok) throw new Error('Could not download the GIF');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mimeType = /^(video\/mp4|image\/gif|image\/webp)$/.test(gif.sendMime) ? gif.sendMime : 'video/mp4';
    const media = await uploadEncryptedBytes(bytes, conversationId, {
      mimeType,
      width: gif.sendWidth || undefined,
      height: gif.sendHeight || undefined,
    });
    const localUri = await this.cacheLocally(media.mediaId, bytes, mimeType);
    await useMessagesStore
      .getState()
      .send(conversationId, { t: 'gif', media, title: gif.title || undefined }, { mediaId: media.mediaId, localUri, replyTo });
  }

  /** Lets the sender show the GIF without downloading their own upload again. */
  private async cacheLocally(mediaId: string, bytes: Uint8Array, mimeType: string): Promise<string | undefined> {
    try {
      if (Platform.OS === 'web') {
        rememberWebUri(mediaId, URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType })));
        return undefined;
      }
      const { Directory, File, Paths } = await import('expo-file-system');
      const dir = new Directory(Paths.cache, 'vero-media');
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      const ext = mimeType === 'video/mp4' ? 'mp4' : mimeType === 'image/webp' ? 'webp' : 'gif';
      const file = new File(dir, `${mediaId.replace(/[^a-zA-Z0-9-]/g, '')}.${ext}`);
      file.create({ overwrite: true });
      file.write(bytes);
      return file.uri;
    } catch {
      return undefined;
    }
  }
}

export const gifService = new GifService();
