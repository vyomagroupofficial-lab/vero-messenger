/**
 * The plaintext that goes INSIDE an encrypted envelope.
 * Nothing in here is ever visible to Supabase or Google Drive.
 */

import type { MediaAttachment, ServerMessageType } from './Message';
import { ExtensionPayload, extensionServerType, parseExtensionPayload } from './payloadExtensions';

export type MediaKind = 'image' | 'video' | 'voice' | 'document';

export type MessagePayload =
  | { t: 'text'; body: string }
  | { t: 'media'; kind: MediaKind; caption?: string; media: Omit<MediaAttachment, 'localUri'> }
  | { t: 'reaction'; target: string; emoji: string | null }
  | { t: 'timer'; seconds: number }
  | ExtensionPayload;

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
    default:
      return extensionServerType(payload);
  }
}

const str = (v: unknown, max = 10_000): v is string => typeof v === 'string' && v.length <= max;

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
      if (typeof m.size !== 'number' || m.size < 0) return null;
      return {
        t: 'media',
        kind: p.kind,
        caption: str(p.caption, MAX_TEXT_LENGTH) ? p.caption : undefined,
        media: {
          mediaId: m.mediaId,
          objectId: m.objectId,
          key: m.key,
          nonce: m.nonce,
          hash: m.hash,
          mimeType: m.mimeType,
          size: m.size,
          fileName: str(m.fileName, 255) ? m.fileName : undefined,
          width: typeof m.width === 'number' ? m.width : undefined,
          height: typeof m.height === 'number' ? m.height : undefined,
          durationMs: typeof m.durationMs === 'number' ? m.durationMs : undefined,
        },
      };
    }
    default:
      return parseExtensionPayload(p);
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
