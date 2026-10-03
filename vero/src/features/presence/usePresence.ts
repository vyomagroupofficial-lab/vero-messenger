/**
 * usePresence(userId) -> { online, lastSeenAt } for chat headers.
 *
 *   online      Realtime Presence on presence:<userId>. The server only lets
 *               you watch people you share a chat with, and only while both
 *               of you share your online status; otherwise this stays false.
 *   lastSeenAt  get_last_seen(userId): null when that user hides it from you
 *               (or you hide yours - reciprocal), refreshed when they go
 *               offline and every minute.
 *
 * One realtime subscription per watched user, shared between components.
 */

import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../../core/network/supabase';
import { currentSession } from '../../core/session';
import { presenceTopic } from './presenceService';

export interface PresenceInfo {
  online: boolean;
  lastSeenAt: string | null;
}

interface Watch {
  channel: RealtimeChannel | null;
  info: PresenceInfo;
  listeners: Set<(p: PresenceInfo) => void>;
  refresh: ReturnType<typeof setInterval> | null;
}

const OFFLINE: PresenceInfo = { online: false, lastSeenAt: null };
const watches = new Map<string, Watch>();

function emit(w: Watch, patch: Partial<PresenceInfo>) {
  const next = { ...w.info, ...patch };
  if (next.online === w.info.online && next.lastSeenAt === w.info.lastSeenAt) return;
  w.info = next;
  w.listeners.forEach((l) => l(next));
}

async function fetchLastSeen(userId: string, w: Watch): Promise<void> {
  const { data, error } = await supabase.rpc('get_last_seen', { p_user_id: userId });
  if (error) return;
  if (watches.get(userId) === w) emit(w, { lastSeenAt: (data as string | null) ?? null });
}

function startWatch(userId: string): Watch {
  const w: Watch = { channel: null, info: OFFLINE, listeners: new Set(), refresh: null };
  watches.set(userId, w);
  void fetchLastSeen(userId, w);
  w.refresh = setInterval(() => {
    if (!w.info.online) void fetchLastSeen(userId, w);
  }, 60_000);

  void supabase.realtime.setAuth().then(() => {
    if (watches.get(userId) !== w) return;
    const channel = supabase.channel(presenceTopic(userId), { config: { private: true } });
    w.channel = channel;
    channel
      .on('presence', { event: 'sync' }, () => {
        const online = Object.keys(channel.presenceState()).length > 0;
        const wasOnline = w.info.online;
        emit(w, { online });
        if (wasOnline && !online) setTimeout(() => void fetchLastSeen(userId, w), 1500);
      })
      .subscribe((status) => {
        // Not allowed to watch (no shared chat, or someone hides online status).
        if (status === 'CHANNEL_ERROR' || status === 'CLOSED') emit(w, { online: false });
      });
  });
  return w;
}

function stopWatch(userId: string, w: Watch): void {
  if (watches.get(userId) === w) watches.delete(userId);
  if (w.refresh) clearInterval(w.refresh);
  if (w.channel) void supabase.removeChannel(w.channel);
}

export function usePresence(userId: string | null | undefined): PresenceInfo {
  const [info, setInfo] = useState<PresenceInfo>(() => (userId && watches.get(userId)?.info) || OFFLINE);

  useEffect(() => {
    const session = currentSession();
    // Our own topic is used by presenceService for tracking.
    if (!userId || !session || session.isDemo || userId === session.userId) {
      setInfo(OFFLINE);
      return;
    }
    const w = watches.get(userId) ?? startWatch(userId);
    w.listeners.add(setInfo);
    setInfo(w.info);
    return () => {
      w.listeners.delete(setInfo);
      if (w.listeners.size === 0) stopWatch(userId, w);
    };
  }, [userId]);

  return info;
}

/** Drops every watch (on sign-out). */
export function stopAllPresenceWatches(): void {
  for (const [userId, w] of [...watches]) stopWatch(userId, w);
}
