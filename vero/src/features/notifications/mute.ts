/**
 * Pure helpers for muting chats (unit-tested in tests/settings.test.ts).
 * The server stores `conversation_members.muted_until`; 'infinity' = always.
 */

export type MuteOption = '8h' | '1w' | 'always' | 'off';

export const MUTE_OPTIONS: { value: Exclude<MuteOption, 'off'>; label: string }[] = [
  { value: '8h', label: '8 hours' },
  { value: '1w', label: '1 week' },
  { value: 'always', label: 'Always' },
];

/** Value for mute_conversation(p_until): ISO time, 'infinity', or null (unmute). */
export function muteUntilFor(option: MuteOption, now: Date = new Date()): string | null {
  switch (option) {
    case '8h':
      return new Date(now.getTime() + 8 * 3600_000).toISOString();
    case '1w':
      return new Date(now.getTime() + 7 * 86400_000).toISOString();
    case 'always':
      return 'infinity';
    case 'off':
      return null;
  }
}

/** True while a stored muted_until value is in the future. */
export function isMutedUntil(mutedUntil: string | null | undefined, now: Date = new Date()): boolean {
  if (!mutedUntil) return false;
  if (mutedUntil === 'infinity') return true;
  const t = Date.parse(mutedUntil);
  return Number.isFinite(t) && t > now.getTime();
}

/** "Muted until Fri 18:30" / "Muted" / null. */
export function muteLabel(mutedUntil: string | null | undefined, now: Date = new Date()): string | null {
  if (!isMutedUntil(mutedUntil, now)) return null;
  if (mutedUntil === 'infinity') return 'Muted';
  const d = new Date(mutedUntil as string);
  // Postgres returns far-future timestamps for "always" set by other clients.
  if (d.getFullYear() - now.getFullYear() > 50) return 'Muted';
  const sameDay = d.toDateString() === now.toDateString();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `Muted until ${time}`;
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `Muted until ${day} ${time}`;
}
