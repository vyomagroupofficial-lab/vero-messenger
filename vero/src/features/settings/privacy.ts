/**
 * Privacy settings: the shape synced with `public.user_settings`
 * (005_settings_push_backup.sql) and the pure rules that enforce them.
 * Unit-tested in tests/settings.test.ts.
 */

import type { MessageStatus } from '../../shared/models/Message';
import { DISAPPEARING_OPTIONS } from '../../shared/models/payload';

export type LastSeenVisibility = 'everyone' | 'contacts' | 'nobody';

export interface PrivacySettings {
  readReceipts: boolean;
  typingIndicators: boolean;
  lastSeen: LastSeenVisibility;
  showOnline: boolean;
  defaultDisappearingSeconds: number;
  /** Show the sender's name in push notifications (never content). */
  notificationPreviews: boolean;
}

export const DEFAULT_PRIVACY: PrivacySettings = {
  readReceipts: true,
  typingIndicators: true,
  lastSeen: 'everyone',
  showOnline: true,
  defaultDisappearingSeconds: 0,
  notificationPreviews: false,
};

export const LAST_SEEN_OPTIONS: { value: LastSeenVisibility; label: string; description: string }[] = [
  { value: 'everyone', label: 'Everyone', description: 'Anyone on Vero' },
  { value: 'contacts', label: 'My contacts', description: 'People you have a direct chat with' },
  { value: 'nobody', label: 'Nobody', description: "You won't see other people's last seen either" },
];

const MAX_TIMER = 31536000;

export interface UserSettingsRow {
  read_receipts: boolean;
  typing_indicators: boolean;
  last_seen: string;
  show_online: boolean;
  default_disappearing_seconds: number;
  notification_previews: boolean;
}

const isLastSeen = (v: unknown): v is LastSeenVisibility => v === 'everyone' || v === 'contacts' || v === 'nobody';

export function isValidDisappearingSeconds(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_TIMER;
}

/** Server row -> settings; anything malformed falls back to the default. */
export function fromRow(row: Partial<UserSettingsRow> | null | undefined): PrivacySettings {
  const r = row ?? {};
  return {
    readReceipts: typeof r.read_receipts === 'boolean' ? r.read_receipts : DEFAULT_PRIVACY.readReceipts,
    typingIndicators: typeof r.typing_indicators === 'boolean' ? r.typing_indicators : DEFAULT_PRIVACY.typingIndicators,
    lastSeen: isLastSeen(r.last_seen) ? r.last_seen : DEFAULT_PRIVACY.lastSeen,
    showOnline: typeof r.show_online === 'boolean' ? r.show_online : DEFAULT_PRIVACY.showOnline,
    defaultDisappearingSeconds: isValidDisappearingSeconds(r.default_disappearing_seconds)
      ? r.default_disappearing_seconds
      : DEFAULT_PRIVACY.defaultDisappearingSeconds,
    notificationPreviews:
      typeof r.notification_previews === 'boolean' ? r.notification_previews : DEFAULT_PRIVACY.notificationPreviews,
  };
}

/** Settings patch -> server columns (only the keys present in the patch). */
export function toRow(patch: Partial<PrivacySettings>): Partial<UserSettingsRow> {
  const row: Partial<UserSettingsRow> = {};
  if (patch.readReceipts !== undefined) row.read_receipts = patch.readReceipts;
  if (patch.typingIndicators !== undefined) row.typing_indicators = patch.typingIndicators;
  if (patch.lastSeen !== undefined) {
    if (!isLastSeen(patch.lastSeen)) throw new Error('Invalid last seen setting');
    row.last_seen = patch.lastSeen;
  }
  if (patch.showOnline !== undefined) row.show_online = patch.showOnline;
  if (patch.defaultDisappearingSeconds !== undefined) {
    if (!isValidDisappearingSeconds(patch.defaultDisappearingSeconds)) throw new Error('Invalid timer');
    row.default_disappearing_seconds = patch.defaultDisappearingSeconds;
  }
  if (patch.notificationPreviews !== undefined) row.notification_previews = patch.notificationPreviews;
  return row;
}

// ── Enforcement ─────────────────────────────────────────────────────────────

/** Read receipts off: we only ever tell others a message was delivered. */
export function receiptKindToSend(kind: 'delivered' | 'read', s: Pick<PrivacySettings, 'readReceipts'>): 'delivered' | 'read' {
  return kind === 'read' && !s.readReceipts ? 'delivered' : kind;
}

/** Reciprocal: with read receipts off you don't see other people's read ticks either. */
export function visibleStatus(status: MessageStatus, s: Pick<PrivacySettings, 'readReceipts'>): MessageStatus {
  return status === 'read' && !s.readReceipts ? 'delivered' : status;
}

/** Typing indicators off: never broadcast typing. */
export function mayBroadcastTyping(s: Pick<PrivacySettings, 'typingIndicators'>): boolean {
  return s.typingIndicators === true;
}

/** Online status is tracked only while the user shares it. */
export function mayShareOnline(s: Pick<PrivacySettings, 'showOnline'>): boolean {
  return s.showOnline === true;
}

/**
 * Timer to apply to a chat the user just created: the default, but only for
 * a brand-new chat (no messages yet and no timer set).
 */
export function defaultTimerForNewChat(
  s: Pick<PrivacySettings, 'defaultDisappearingSeconds'>,
  chat: { hasMessages: boolean; currentTimerSeconds: number }
): number | null {
  if (!isValidDisappearingSeconds(s.defaultDisappearingSeconds) || s.defaultDisappearingSeconds === 0) return null;
  if (chat.hasMessages || chat.currentTimerSeconds > 0) return null;
  return s.defaultDisappearingSeconds;
}

/** Timer choices offered as the default (same as the per-chat menu). */
export const DEFAULT_DISAPPEARING_OPTIONS = DISAPPEARING_OPTIONS;
