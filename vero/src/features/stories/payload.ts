/**
 * The plaintext INSIDE a story envelope. Nothing here reaches the server:
 * it only sees `story_type` ('text' | 'media') and the encrypted blob path.
 */

import { isValidChunkSize } from '../../core/crypto/attachments';

export type StoryKind = 'text' | 'image' | 'video';

export const STORY_FONTS = ['sans', 'serif', 'mono', 'bold'] as const;
export type StoryFont = (typeof STORY_FONTS)[number];

/** Text-story backgrounds offered by the composer (any #rrggbb is accepted on parse). */
export const STORY_BACKGROUNDS = [
  '#0E7490',
  '#6D28D9',
  '#047857',
  '#B45309',
  '#BE123C',
  '#1E293B',
  '#4338CA',
  '#0F766E',
] as const;

export const MAX_STORY_TEXT = 700;
export const MAX_STORY_CAPTION = 500;
export const MAX_STORY_VIDEO_MS = 30_000;

/** Encrypted blob in the `vero-stories` bucket; key/nonce never leave the envelope. */
export interface StoryMediaRef {
  path: string;
  /** Attachment format (see core/crypto/attachments): absent/1 single-shot, 2 chunked secretstream. */
  v?: 1 | 2;
  /** v2 only: plaintext chunk size. */
  chunkSize?: number;
  key: string;
  nonce: string;
  hash: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

export type StoryPayload =
  | { t: 'story'; kind: 'text'; text: string; bg: string; font: StoryFont }
  | { t: 'story'; kind: 'image' | 'video'; caption?: string; media: StoryMediaRef };

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Defensive parse: the author controls every byte of the payload. */
export function parseStoryPayload(raw: string): StoryPayload | null {
  let p: any;
  try {
    p = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!p || typeof p !== 'object' || p.t !== 'story') return null;

  if (p.kind === 'text') {
    if (!str(p.text, MAX_STORY_TEXT) || p.text.trim().length === 0) return null;
    return {
      t: 'story',
      kind: 'text',
      text: p.text,
      bg: typeof p.bg === 'string' && HEX_COLOR.test(p.bg) ? p.bg : STORY_BACKGROUNDS[0],
      font: (STORY_FONTS as readonly string[]).includes(p.font) ? p.font : 'sans',
    };
  }

  if (p.kind === 'image' || p.kind === 'video') {
    const m = p.media;
    if (!m || typeof m !== 'object') return null;
    if (![m.path, m.key, m.nonce, m.hash, m.mimeType].every((v) => str(v, 512) && v.length > 0)) return null;
    if (!num(m.size)) return null;
    const expectedPrefix = p.kind === 'image' ? 'image/' : 'video/';
    if (!m.mimeType.startsWith(expectedPrefix)) return null;
    // Unknown formats can't be decrypted: reject rather than fail later.
    const v = m.v === undefined || m.v === 1 ? undefined : m.v === 2 ? 2 : null;
    if (v === null || (v === 2 && !isValidChunkSize(m.chunkSize))) return null;
    return {
      t: 'story',
      kind: p.kind,
      caption: str(p.caption, MAX_STORY_CAPTION) && p.caption.length > 0 ? p.caption : undefined,
      media: {
        path: m.path,
        key: m.key,
        nonce: m.nonce,
        hash: m.hash,
        mimeType: m.mimeType,
        size: m.size,
        width: num(m.width) ? m.width : undefined,
        height: num(m.height) ? m.height : undefined,
        durationMs: num(m.durationMs) ? m.durationMs : undefined,
        ...(v === 2 ? { v: 2 as const, chunkSize: m.chunkSize as number } : {}),
      },
    };
  }
  return null;
}

/** Short description used when quoting a story in a reply DM or listing it. */
export function storyPreview(payload: StoryPayload | null, maxLength = 60): string {
  if (!payload) return 'Story';
  const clip = (s: string) => (s.length > maxLength ? `${s.slice(0, maxLength - 1)}…` : s);
  switch (payload.kind) {
    case 'text':
      return clip(payload.text.replace(/\s+/g, ' ').trim());
    case 'image':
      return payload.caption ? `📷 ${clip(payload.caption)}` : '📷 Photo';
    case 'video':
      return payload.caption ? `🎥 ${clip(payload.caption)}` : '🎥 Video';
  }
}

/** Coarse type the server is allowed to know. */
export function serverStoryType(payload: StoryPayload): 'text' | 'media' {
  return payload.kind === 'text' ? 'text' : 'media';
}

// ── Replies (sent as an ordinary E2EE text DM quoting the story) ─────────────

export const STORY_QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '👏', '🔥'] as const;

export function storyReplyText(payload: StoryPayload | null, reply: string): string {
  return `↩️ Replied to your story · “${storyPreview(payload, 80)}”\n${reply.trim()}`;
}

export function storyReactionText(payload: StoryPayload | null, emoji: string): string {
  return `${emoji} Reacted to your story · “${storyPreview(payload, 80)}”`;
}
