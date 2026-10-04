/**
 * Private realtime channels for the E2E suite: subscribe exactly like the app
 * (src/core/network/realtime.ts: `{ private: true }`) and collect broadcasts so
 * steps can wait for them.
 */

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

export interface Received {
  event: string;
  payload: any;
  at: number;
}

export class Listener {
  readonly received: Received[] = [];
  private waiters: { match: (r: Received) => boolean; resolve: (r: Received) => void }[] = [];

  constructor(readonly topic: string, readonly channel: RealtimeChannel, private readonly client: SupabaseClient) {}

  push(r: Received): void {
    this.received.push(r);
    for (const w of [...this.waiters]) {
      if (w.match(r)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(r);
      }
    }
  }

  /** Resolves with the first broadcast (already received or future) matching event + predicate. */
  waitFor(event: string, pred: (payload: any) => boolean = () => true, timeoutMs = 10_000): Promise<Received> {
    const match = (r: Received) => r.event === event && pred(r.payload);
    const hit = this.received.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: (r: Received) => (clearTimeout(timer), resolve(r)) };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`timed out after ${timeoutMs} ms waiting for "${event}" on ${this.topic}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** True if nothing matching arrives within `ms` (for negative checks). */
  async nothing(event: string, pred: (payload: any) => boolean = () => true, ms = 2500): Promise<boolean> {
    try {
      await this.waitFor(event, pred, ms);
      return false;
    } catch {
      return true;
    }
  }

  async send(event: string, payload: unknown): Promise<string> {
    return this.channel.send({ type: 'broadcast', event, payload });
  }

  async close(): Promise<void> {
    await this.client.removeChannel(this.channel);
  }
}

export type JoinResult = { ok: true; listener: Listener } | { ok: false; status: string; error: string };

/**
 * Joins a private topic. Resolves ok:false (never throws) when the server
 * refuses the join, so negative tests can assert on it.
 */
export async function join(
  client: SupabaseClient,
  topic: string,
  opts: { presenceKey?: string; self?: boolean; timeoutMs?: number } = {}
): Promise<JoinResult> {
  await client.realtime.setAuth();
  const channel = client.channel(topic, {
    config: {
      private: true,
      broadcast: { self: opts.self ?? false, ack: true },
      ...(opts.presenceKey ? { presence: { key: opts.presenceKey } } : {}),
    },
  });
  const listener = new Listener(topic, channel, client);
  channel.on('broadcast', { event: '*' }, (msg: any) => listener.push({ event: msg.event, payload: msg.payload, at: Date.now() }));
  return new Promise<JoinResult>((resolve) => {
    let done = false;
    const finish = (r: JoinResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!r.ok) void client.removeChannel(channel);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, status: 'TIMED_OUT', error: 'no reply' }), opts.timeoutMs ?? 10_000);
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') finish({ ok: true, listener });
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        finish({ ok: false, status, error: err?.message ?? status });
      }
    });
  });
}

export async function mustJoin(client: SupabaseClient, topic: string, opts?: Parameters<typeof join>[2]): Promise<Listener> {
  const r = await join(client, topic, opts);
  if (!r.ok) throw new Error(`could not join ${topic}: ${r.status} ${r.error}`);
  return r.listener;
}
