/** App lock rules (pure; unit-tested in tests/settings.test.ts). */

export const APP_LOCK_TIMEOUTS: { seconds: number; label: string }[] = [
  { seconds: 0, label: 'Immediately' },
  { seconds: 60, label: 'After 1 minute' },
  { seconds: 300, label: 'After 5 minutes' },
  { seconds: 1800, label: 'After 30 minutes' },
];

/** Should the app be locked when it comes back to the foreground? */
export function shouldLock(p: {
  enabled: boolean;
  timeoutSeconds: number;
  backgroundedAt: number | null;
  now: number;
}): boolean {
  if (!p.enabled) return false;
  if (p.backgroundedAt === null) return false;
  return p.now - p.backgroundedAt >= Math.max(0, p.timeoutSeconds) * 1000;
}
