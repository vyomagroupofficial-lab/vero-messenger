/** Auto-backup schedule (pure; unit-tested in tests/settings.test.ts). */

export const AUTO_BACKUP_INTERVAL_MS = 24 * 3600_000;

/** Daily auto-backup is due when the last one is older than 24 h. Pure. */
export function isAutoBackupDue(status: { methods: readonly string[]; autoDaily: boolean; lastBackupAt: string | null }, now = Date.now()): boolean {
  if (!status.autoDaily || status.methods.length === 0) return false;
  if (!status.lastBackupAt) return true;
  const last = Date.parse(status.lastBackupAt);
  return !Number.isFinite(last) || now - last >= AUTO_BACKUP_INTERVAL_MS;
}
