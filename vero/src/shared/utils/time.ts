/**
 * Timestamp helpers. Server timestamps come as "2026-01-02T03:04:05.123456+00:00",
 * local ones as "2026-01-02T03:04:05.123Z"; comparing those as strings is
 * wrong, so compare milliseconds.
 */

/** Milliseconds since epoch, or NaN. Tolerates microsecond precision. */
export function toMillis(ts: string | null | undefined): number {
  if (!ts) return NaN;
  return Date.parse(ts.replace(/(\.\d{3})\d+/, '$1').replace(' ', 'T'));
}

/** a > b for timestamps (missing/invalid values sort first). */
export function isAfter(a: string | null | undefined, b: string | null | undefined): boolean {
  const ma = toMillis(a);
  const mb = toMillis(b);
  if (Number.isNaN(ma)) return false;
  if (Number.isNaN(mb)) return true;
  return ma > mb;
}

/** Comparator: newest first. */
export function compareDesc(a: string | null | undefined, b: string | null | undefined): number {
  const ma = toMillis(a);
  const mb = toMillis(b);
  return (Number.isNaN(mb) ? -Infinity : mb) - (Number.isNaN(ma) ? -Infinity : ma) || 0;
}

/** Canonical ISO form (UTC, milliseconds) for storage/cursors. */
export function toIso(ts: string): string {
  const ms = toMillis(ts);
  return Number.isNaN(ms) ? ts : new Date(ms).toISOString();
}
