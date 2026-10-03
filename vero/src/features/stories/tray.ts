/**
 * Stories tray ordering (pure): unseen first, then seen, muted authors last;
 * newest first within each section.
 */

export interface TrayEntry {
  userId: string;
  /** ISO time of the author's newest live story. */
  latestAt: string;
  hasUnseen: boolean;
  muted: boolean;
}

export type TraySection = 'unseen' | 'seen' | 'muted';

export function traySection(e: TrayEntry): TraySection {
  if (e.muted) return 'muted';
  return e.hasUnseen ? 'unseen' : 'seen';
}

const RANK: Record<TraySection, number> = { unseen: 0, seen: 1, muted: 2 };

export function orderTray<T extends TrayEntry>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const r = RANK[traySection(a)] - RANK[traySection(b)];
    if (r !== 0) return r;
    const t = Date.parse(b.latestAt) - Date.parse(a.latestAt);
    return t !== 0 ? t : a.userId.localeCompare(b.userId);
  });
}

/** Index of the first story the viewer should open in a group (first unseen, else the first). */
export function firstUnseenIndex(storyIds: string[], seen: (id: string) => boolean): number {
  const i = storyIds.findIndex((id) => !seen(id));
  return i < 0 ? 0 : i;
}
