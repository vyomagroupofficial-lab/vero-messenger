/** Translated labels for the stories UI (the pure helpers in expiry.ts/payload.ts stay English-free of UI). */

import type { TFunction } from 'i18next';
import { remainingMs } from './expiry';
import type { StoryPayload } from './payload';

const toMs = (t: string | number | Date) => (typeof t === 'number' ? t : t instanceof Date ? t.getTime() : Date.parse(t));

/** "Just now", "12m", "5h". */
export function storyAge(t: TFunction, createdAt: string | number | Date, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - toMs(createdAt)) / 60_000);
  if (minutes < 1) return t('stories.justNow');
  if (minutes < 60) return t('stories.minutesAgo', { count: minutes });
  return t('stories.hoursAgo', { count: Math.min(23, Math.floor(minutes / 60)) });
}

/** "23h left", "45m left". */
export function storyTimeLeft(t: TFunction, expiresAt: string | number | Date, now: number = Date.now()): string {
  const left = remainingMs(expiresAt, now);
  if (left <= 0) return t('stories.expired');
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return t('stories.minutesLeft', { count: minutes });
  return t('stories.hoursLeft', { count: Math.floor(minutes / 60) });
}

export function storyPreviewText(t: TFunction, payload: StoryPayload | null, maxLength = 60): string {
  if (!payload) return t('stories.encrypted');
  const clip = (s: string) => (s.length > maxLength ? `${s.slice(0, maxLength - 1)}…` : s);
  if (payload.kind === 'text') return clip(payload.text.replace(/\s+/g, ' ').trim());
  const label = payload.kind === 'image' ? t('preview.photo') : t('preview.video');
  return payload.caption ? clip(payload.caption) : label;
}

import { resolveAudience, type StoryPrivacy } from './audience';

export function audienceText(t: TFunction, contactIds: string[], privacy: StoryPrivacy, selfId: string): string {
  const count = resolveAudience(contactIds, privacy, selfId).length;
  const people = t('groups.people', { count });
  if (privacy.audience === 'contacts_except') return t('stories.audienceExcept', { count: privacy.exceptUserIds.length, people });
  if (privacy.audience === 'only') return t('stories.audienceOnly', { people });
  return t('stories.audienceContacts', { people });
}

/** Text-story backgrounds offered by the composer: deep, warm tones that keep white type readable. */
export const STORY_PALETTE = ['#1F4E40', '#8A5F1E', '#9C5B43', '#3F5A73', '#6B4A5E', '#2F5F5F', '#4D4A73', '#14231E'] as const;
