/**
 * Private realtime channels.
 *
 * Topics are authorised server-side by policies on realtime.messages
 * (see migration): conversation:<id>, user:<id>, call:<id>.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type BroadcastHandler = (payload: any) => void;

/** Server-sent events on the personal user:<id> topic (story.* from 008_stories.sql). */
const USER_EVENTS = ['inbox.message', 'call.invite', 'story.new', 'story.deleted', 'story.viewed'] as const;
export type UserEvent = (typeof USER_EVENTS)[number];

export function privateChannel(topic: string): RealtimeChannel {
  return supabase.channel(topic, { config: { private: true, broadcast: { self: false } } });
}

/** Personal topic: inbox pings + incoming call invites. One subscription per session. */
class UserChannel {
  private channel: RealtimeChannel | null = null;
  private userId: string | null = null;
  private handlers = new Map<string, Set<BroadcastHandler>>();

  async start(userId: string): Promise<void> {
    if (this.userId === userId && this.channel) return;
    this.stop();
    this.userId = userId;
    await supabase.realtime.setAuth();
    const channel = privateChannel(`user:${userId}`);
    for (const event of USER_EVENTS) {
      channel.on('broadcast', { event }, ({ payload }) => {
        this.handlers.get(event)?.forEach((h) => h(payload));
      });
    }
    channel.subscribe((status, err) => {
      if (status === 'CHANNEL_ERROR') console.warn('[Realtime] user channel error', err?.message);
    });
    this.channel = channel;
  }

  stop(): void {
    if (this.channel) void supabase.removeChannel(this.channel);
    this.channel = null;
    this.userId = null;
  }

  on(event: UserEvent, handler: BroadcastHandler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }
}

export const userChannel = new UserChannel();
