/**
 * Payloads synced between the user's OWN devices (encrypted to those devices
 * only, stored in self_sync_events). Pure parsing + merge rules, unit-tested.
 */

import { toMillis } from '../../shared/utils/time';

export interface StarItem {
  /** message id */
  id: string;
  /** conversation id */
  c: string;
  /** starred? */
  s: boolean;
  /** when the user (un)starred it, sender clock (last writer wins) */
  at: string;
}

export type SelfSyncPayload = { t: 'stars'; items: StarItem[] };

export const MAX_STAR_ITEMS = 200;

const ID_RE = /^[0-9a-zA-Z-]{1,64}$/;

export function parseSelfSyncPayload(raw: string): SelfSyncPayload | null {
  let p: any;
  try {
    p = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!p || typeof p !== 'object') return null;
  if (p.t === 'stars') {
    if (!Array.isArray(p.items) || p.items.length === 0 || p.items.length > MAX_STAR_ITEMS) return null;
    const items: StarItem[] = [];
    for (const it of p.items) {
      if (!it || typeof it !== 'object') return null;
      if (typeof it.id !== 'string' || !ID_RE.test(it.id)) return null;
      if (typeof it.c !== 'string' || !ID_RE.test(it.c)) return null;
      if (typeof it.s !== 'boolean') return null;
      if (typeof it.at !== 'string' || Number.isNaN(toMillis(it.at))) return null;
      items.push({ id: it.id, c: it.c, s: it.s, at: it.at });
    }
    return { t: 'stars', items };
  }
  return null;
}

/** Last-writer-wins: apply `incoming` unless the local state is newer. */
export function shouldApplyStar(localUpdatedAt: string | null | undefined, incomingAt: string): boolean {
  if (!localUpdatedAt) return true;
  return toMillis(incomingAt) > toMillis(localUpdatedAt);
}

/** Splits a large change into payloads that respect MAX_STAR_ITEMS. */
export function chunkStarItems(items: StarItem[]): SelfSyncPayload[] {
  const out: SelfSyncPayload[] = [];
  for (let i = 0; i < items.length; i += MAX_STAR_ITEMS) {
    out.push({ t: 'stars', items: items.slice(i, i + MAX_STAR_ITEMS) });
  }
  return out;
}
