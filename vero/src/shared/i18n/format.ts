import type { TFunction } from 'i18next';
import dayjs from 'dayjs';
import type { IconName } from '../ui/Icon';
import type { Conversation, MessageType } from '../models/Message';

const TIMER_KEYS: Record<number, string> = {
  0: 'timer.off',
  3600: 'timer.1h',
  86400: 'timer.24h',
  [7 * 86400]: 'timer.7d',
  [90 * 86400]: 'timer.90d',
};

export function timerText(t: TFunction, seconds: number): string {
  const key = TIMER_KEYS[seconds];
  return key ? t(key) : t('timer.hours', { count: Math.round(seconds / 3600) });
}

/** "Today", "Yesterday", weekday, or a short date — in the current dayjs locale. */
export function dayLabel(t: TFunction, iso: string): string {
  const d = dayjs(iso);
  if (d.isSame(dayjs(), 'day')) return t('time.today');
  if (d.isSame(dayjs().subtract(1, 'day'), 'day')) return t('time.yesterday');
  if (d.isAfter(dayjs().subtract(6, 'day'))) return d.format('dddd');
  return d.format('ddd, D MMM');
}

/** Compact timestamp for list rows. */
export function listTime(t: TFunction, iso?: string): string {
  if (!iso) return '';
  const d = dayjs(iso);
  if (d.isSame(dayjs(), 'day')) return d.format('h:mm A');
  if (d.isSame(dayjs().subtract(1, 'day'), 'day')) return t('time.yesterday');
  if (d.isAfter(dayjs().subtract(6, 'day'))) return d.format('ddd');
  return d.format('D MMM');
}

export function clockTime(iso: string): string {
  return dayjs(iso).format('h:mm A');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Repository previews arrive pre-formatted ("📷 Photo", "📄 name.pdf"); peel off the emoji.
const stripEmoji = (s?: string) => (s || '').replace(/^\S+\s/, '');

export function typeLabel(t: TFunction, type: MessageType, content?: string): { icon?: IconName; text: string } {
  switch (type) {
    case 'image':
      return { icon: 'image', text: t('preview.photo') };
    case 'video':
      return { icon: 'video', text: t('preview.video') };
    case 'voice':
      return { icon: 'mic', text: t('preview.voice') };
    case 'document':
      return { icon: 'file', text: stripEmoji(content) || t('preview.document') };
    case 'unavailable':
      return { icon: 'lock', text: t('preview.unavailable') };
    default:
      return { text: content || '' };
  }
}

export function conversationPreview(t: TFunction, c: Conversation): { icon?: IconName; text: string } {
  const m = c.lastMessage;
  if (!m) return { icon: 'lock', text: t('preview.empty') };
  const base = typeLabel(t, m.messageType, m.content);
  if (m.isOwn) return { ...base, text: t('preview.you', { text: base.text }) };
  if (c.conversationType === 'group' && m.senderName) {
    return { ...base, text: t('preview.from', { name: m.senderName.split(' ')[0], text: base.text }) };
  }
  return base;
}
