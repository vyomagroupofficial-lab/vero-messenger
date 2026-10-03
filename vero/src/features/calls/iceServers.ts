/**
 * ICE servers for calls: public STUN always, plus short-lived TURN
 * credentials from the `turn-credentials` Edge Function when the backend has
 * TURN configured. If the function is missing or fails, calls fall back to
 * STUN only (works on most networks; strict NATs / some mobile carriers need
 * TURN).
 */

import { supabase } from '../../core/network/supabase';
import type { IceServer, PeerConfig } from './mediaTypes';

export const DEFAULT_STUN: IceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/** EXPO_PUBLIC_CALL_RELAY_ONLY=true: route all media via TURN so peers never learn each other's IP. */
const RELAY_ONLY = process.env.EXPO_PUBLIC_CALL_RELAY_ONLY === 'true';

let cache: { servers: IceServer[]; expiresAt: number } | null = null;
let inflight: Promise<IceServer[]> | null = null;

export function sanitizeIceServers(input: unknown): IceServer[] {
  if (!Array.isArray(input)) return [];
  const out: IceServer[] = [];
  for (const s of input) {
    const urls = Array.isArray(s?.urls) ? s.urls : typeof s?.urls === 'string' ? [s.urls] : [];
    const valid = urls.filter((u: unknown) => typeof u === 'string' && /^(stun|turn|turns):/i.test(u));
    if (!valid.length) continue;
    out.push({
      urls: valid,
      ...(typeof s.username === 'string' ? { username: s.username } : {}),
      ...(typeof s.credential === 'string' ? { credential: s.credential } : {}),
    });
  }
  return out;
}

async function fetchTurn(): Promise<IceServer[]> {
  const { data, error } = await supabase.functions.invoke('turn-credentials', { method: 'POST', body: {} });
  if (error) throw error;
  const servers = sanitizeIceServers((data as any)?.iceServers);
  const ttl = Number((data as any)?.ttl) || 3600;
  // Refresh well before the credentials expire.
  cache = { servers, expiresAt: Date.now() + Math.max(60, ttl / 2) * 1000 };
  return servers;
}

/** Fetch (or reuse) TURN servers. Never throws. */
export async function getTurnServers(): Promise<IceServer[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.servers;
  if (!inflight) {
    inflight = fetchTurn()
      .catch((e) => {
        console.info('[Calls] TURN unavailable, using STUN only:', (e as Error)?.message);
        return [] as IceServer[];
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function getPeerConfig(): Promise<PeerConfig> {
  const turn = await getTurnServers();
  const hasTurn = turn.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(u)));
  return {
    iceServers: [...DEFAULT_STUN, ...turn],
    iceTransportPolicy: RELAY_ONLY && hasTurn ? 'relay' : 'all',
  };
}

/** Warm the cache when a call starts ringing so accepting is instant. */
export function prefetchIceServers(): void {
  void getTurnServers();
}
