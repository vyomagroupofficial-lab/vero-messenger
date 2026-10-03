/** "last seen …" text for chat headers. Pure; unit-tested. */

export function formatLastSeen(lastSeenAt: string | null | undefined, now: Date = new Date()): string | null {
  if (!lastSeenAt) return null;
  const t = new Date(lastSeenAt);
  if (Number.isNaN(t.getTime())) return null;
  const diffMs = now.getTime() - t.getTime();
  if (diffMs < 60_000) return 'last seen just now';
  if (diffMs < 3600_000) {
    const m = Math.floor(diffMs / 60_000);
    return `last seen ${m} min ago`;
  }
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t.getTime() >= startOfToday) return `last seen today at ${hh}:${mm}`;
  if (t.getTime() >= startOfToday - 86400_000) return `last seen yesterday at ${hh}:${mm}`;
  const sameYear = t.getFullYear() === now.getFullYear();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const date = `${t.getDate()} ${months[t.getMonth()]}${sameYear ? '' : ` ${t.getFullYear()}`}`;
  return `last seen ${date} at ${hh}:${mm}`;
}

/** Header subtitle for a direct chat: online wins over last seen. */
export function presenceSubtitle(p: { online: boolean; lastSeenAt: string | null }, now: Date = new Date()): string | null {
  if (p.online) return 'online';
  return formatLastSeen(p.lastSeenAt, now);
}
