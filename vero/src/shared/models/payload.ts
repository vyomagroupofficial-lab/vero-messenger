/**
 * The plaintext that goes INSIDE an encrypted envelope.
 * Nothing in here is ever visible to Supabase or Google Drive.
 */

import type { MediaAttachment, ServerMessageType } from './Message';
import { isValidChunkSize } from '../../core/crypto/attachments';
import { sanitizeWaveform } from '../../features/media/waveform';

export type MediaKind = 'image' | 'video' | 'voice' | 'document';

/** What goes on the wire for an attachment: everything except device-local fields. */
export type MessageMedia = Omit<MediaAttachment, 'localUri' | 'playedAt'>;

export type MessagePayload =
  | { t: 'text'; body: string }
  | { t: 'media'; kind: MediaKind; caption?: string; media: MessageMedia }
  | { t: 'reaction'; target: string; emoji: string | null }
  | { t: 'timer'; seconds: number };

export const MAX_TEXT_LENGTH = 5000;

export function serverTypeFor(payload: MessagePayload): ServerMessageType {
  switch (payload.t) {
    case 'text':
      return 'text';
    case 'media':
      return 'media';
    case 'reaction':
      return 'reaction';
    case 'timer':
      return 'system';
  }
}

const str = (v: unknown, max = 10_000): v is string => typeof v === 'string' && v.length <= max;

/** Thumbnails are tiny (~48 px JPEG); this bounds the payload. */
export const MAX_THUMB_LENGTH = 24_000;
const MAX_DURATION_MS = 24 * 3600 * 1000;
const MAX_DIMENSION = 30_000;
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

const dimension = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_DIMENSION ? Math.round(v) : undefined;

/**
 * File names come from the sender: strip paths, control and bidi-override
 * characters (which can disguise "evil‮fdp.exe" as "evilexe.pdf").
 */
export function sanitizeFileName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 255);
  return clean || undefined;
}

/** Strips device-local fields before an attachment is (re-)sent. */
export function toMessageMedia(media: MediaAttachment): MessageMedia {
  const { localUri: _localUri, playedAt: _playedAt, ...wire } = media;
  return wire;
}

/** Defensive parse: a malicious sender controls every byte of the payload. */
export function parsePayload(raw: string): MessagePayload | null {
  let p: any;
  try {
    p = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!p || typeof p !== 'object') return null;
  switch (p.t) {
    case 'text':
      return str(p.body, MAX_TEXT_LENGTH) ? { t: 'text', body: p.body } : null;
    case 'reaction':
      return str(p.target, 64) && (p.emoji === null || str(p.emoji, 16))
        ? { t: 'reaction', target: p.target, emoji: p.emoji }
        : null;
    case 'timer':
      return Number.isInteger(p.seconds) && p.seconds >= 0 && p.seconds <= 90 * 86400
        ? { t: 'timer', seconds: p.seconds }
        : null;
    case 'media': {
      const m = p.media;
      if (!['image', 'video', 'voice', 'document'].includes(p.kind) || !m || typeof m !== 'object') return null;
      if (![m.mediaId, m.objectId, m.key, m.nonce, m.hash, m.mimeType].every((v) => str(v, 512))) return null;
      if (typeof m.size !== 'number' || !Number.isInteger(m.size) || m.size < 0) return null;
      // Unknown attachment formats can't be decrypted: reject rather than fail later.
      const v = m.v === undefined || m.v === 1 ? undefined : m.v === 2 ? 2 : null;
      if (v === null) return null;
      if (v === 2 && !isValidChunkSize(m.chunkSize)) return null;
      const fileName = sanitizeFileName(m.fileName);
      const media: MessageMedia = {
        mediaId: m.mediaId,
        objectId: m.objectId,
        key: m.key,
        nonce: m.nonce,
        hash: m.hash,
        mimeType: m.mimeType,
        size: m.size,
      };
      if (v === 2) {
        media.v = 2;
        media.chunkSize = m.chunkSize;
      }
      if (fileName) media.fileName = fileName;
      const width = dimension(m.width);
      const height = dimension(m.height);
      if (width && height) {
        media.width = width;
        media.height = height;
      }
      if (typeof m.durationMs === 'number' && Number.isFinite(m.durationMs) && m.durationMs >= 0 && m.durationMs <= MAX_DURATION_MS) {
        media.durationMs = Math.round(m.durationMs);
      }
      if (p.kind === 'voice') {
        const waveform = sanitizeWaveform(m.waveform);
        if (waveform) media.waveform = waveform;
      }
      if ((p.kind === 'image' || p.kind === 'video') && str(m.thumb, MAX_THUMB_LENGTH) && BASE64_RE.test(m.thumb)) {
        media.thumb = m.thumb;
      }
      return {
        t: 'media',
        kind: p.kind,
        caption: str(p.caption, MAX_TEXT_LENGTH) ? p.caption : undefined,
        media,
      };
    }
    default:
      return null;
  }
}

export const DISAPPEARING_OPTIONS: { label: string; seconds: number }[] = [
  { label: 'Off', seconds: 0 },
  { label: '1 hour', seconds: 3600 },
  { label: '24 hours', seconds: 86400 },
  { label: '7 days', seconds: 7 * 86400 },
  { label: '90 days', seconds: 90 * 86400 },
];

export function timerLabel(seconds: number): string {
  return DISAPPEARING_OPTIONS.find((o) => o.seconds === seconds)?.label ?? `${Math.round(seconds / 3600)} h`;
}
