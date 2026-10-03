/**
 * Story lifetime math. The server is authoritative (expires_at is set by
 * post_story and enforced by RLS); the client uses these helpers to hide
 * stories the moment they lapse and to label them.
 */

export const STORY_TTL_MS = 24 * 60 * 60 * 1000;

const toMs = (t: string | number | Date): number =>
  typeof t === 'number' ? t : t instanceof Date ? t.getTime() : Date.parse(t);

export function expiresAtFor(createdAt: string | number | Date): string {
  return new Date(toMs(createdAt) + STORY_TTL_MS).toISOString();
}

export function isExpired(expiresAt: string | number | Date, now: number = Date.now()): boolean {
  const t = toMs(expiresAt);
  return !Number.isFinite(t) || t <= now;
}

export function remainingMs(expiresAt: string | number | Date, now: number = Date.now()): number {
  const t = toMs(expiresAt);
  return Number.isFinite(t) ? Math.max(0, t - now) : 0;
}

/** "Just now", "12m", "5h" — how long ago a story was posted. */
export function storyAgeLabel(createdAt: string | number | Date, now: number = Date.now()): string {
  const diff = Math.max(0, now - toMs(createdAt));
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.min(23, Math.floor(minutes / 60))}h`;
}

/** "23h left", "45m left" — for the author's own stories. */
export function timeLeftLabel(expiresAt: string | number | Date, now: number = Date.now()): string {
  const left = remainingMs(expiresAt, now);
  if (left <= 0) return 'Expired';
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.floor(minutes / 60)}h left`;
}
