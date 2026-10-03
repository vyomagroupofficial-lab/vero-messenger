/**
 * Forwarding rules (pure, unit-tested).
 *
 * The hop count travels inside the encrypted payload (`fwd`), so only chat
 * members ever see how often something was forwarded.
 */

import type { Message } from '../../shared/models/Message';
import { MessagePayload, toMessageMedia } from '../../shared/models/payload';
import { MAX_FORWARD_HOPS } from '../../shared/models/messageExtras';

/** From this many hops on, the label reads "Forwarded many times". */
export const FREQUENTLY_FORWARDED_HOPS = 5;
/** Chats a message can be forwarded to in one go. */
export const MAX_FORWARD_CHATS = 5;
/** Frequently forwarded messages can only go to one chat at a time. */
export const MAX_FREQUENT_FORWARD_CHATS = 1;
/** Messages that can be forwarded in one go. */
export const MAX_FORWARD_MESSAGES = 30;

export function isFrequentlyForwarded(hops: number | undefined): boolean {
  return (hops ?? 0) >= FREQUENTLY_FORWARDED_HOPS;
}

export function forwardLabel(hops: number | undefined): string | null {
  if (!hops || hops < 1) return null;
  return isFrequentlyForwarded(hops) ? 'Forwarded many times' : 'Forwarded';
}

export function nextHopCount(m: Pick<Message, 'forwardCount'>): number {
  return Math.min((m.forwardCount ?? 0) + 1, MAX_FORWARD_HOPS);
}

const FORWARDABLE = ['text', 'image', 'video', 'voice', 'document'];

export function isForwardable(m: Message): boolean {
  if (m.revokedAt || m.deletedAt) return false;
  if (m.status === 'sending' || m.status === 'failed') return false;
  if (!FORWARDABLE.includes(m.messageType)) return false;
  if (m.messageType === 'text') return !!m.content;
  return !!m.media;
}

/** How many chats this selection may be forwarded to at once. */
export function maxForwardTargets(messages: Message[]): number {
  return messages.some((m) => isFrequentlyForwarded(nextHopCount(m))) ? MAX_FREQUENT_FORWARD_CHATS : MAX_FORWARD_CHATS;
}

export type ForwardSelectionCheck = { ok: true } | { ok: false; reason: string };

export function checkForwardSelection(messages: Message[], targetCount: number): ForwardSelectionCheck {
  if (messages.length === 0) return { ok: false, reason: 'Select at least one message.' };
  if (messages.length > MAX_FORWARD_MESSAGES) {
    return { ok: false, reason: `You can forward up to ${MAX_FORWARD_MESSAGES} messages at a time.` };
  }
  if (!messages.every(isForwardable)) return { ok: false, reason: 'Some of these messages can’t be forwarded.' };
  if (targetCount === 0) return { ok: false, reason: 'Choose at least one chat.' };
  const max = maxForwardTargets(messages);
  if (targetCount > max) {
    return {
      ok: false,
      reason:
        max === 1
          ? 'Messages forwarded many times can only be sent to one chat at a time.'
          : `You can forward to up to ${max} chats at a time.`,
    };
  }
  return { ok: true };
}

/**
 * Builds the new payload for a forwarded message. For media, `mediaId` is the
 * id of the media row authorised in the TARGET chat (forward_media RPC); the
 * file key, nonce and hash are reused, so the encrypted blob isn't re-uploaded.
 */
export function buildForwardPayload(m: Message, targetMediaId?: string): MessagePayload | null {
  if (!isForwardable(m)) return null;
  const fwd = nextHopCount(m);
  if (m.messageType === 'text') return { t: 'text', body: m.content!, fwd };
  if (!m.media || !targetMediaId) return null;
  const media = toMessageMedia(m.media);
  const kind = m.messageType as 'image' | 'video' | 'voice' | 'document';
  const caption = kind === 'document' ? undefined : m.content || undefined;
  return { t: 'media', kind, caption, media: { ...media, mediaId: targetMediaId }, fwd };
}
