/**
 * Encrypted sync between the signed-in user's OWN devices (stars today).
 *
 * Each event is a normal Vero envelope whose key is wrapped only for the
 * user's other active devices and bound to `self:<userId>|<eventId>|<device>`,
 * stored in self_sync_events (own-row RLS) and announced with a `self.sync`
 * ping on the user's private topic. The server sees that *something* was
 * synced, not what. With a single device nothing is uploaded at all.
 */

import { supabase } from '../../core/network/supabase';
import { cryptoManager, DeviceKeyRef } from '../../core/crypto/CryptoManager';
import { NotAddressedToDeviceError } from '../../core/crypto/primitives';
import { messagingStore } from '../../core/storage/messagingStore';
import { SessionContext } from '../../core/session';
import { generateUUID } from '../../shared/utils/uuid';
import { keyDirectory } from '../keys/KeyDirectory';
import {
  chunkStarItems,
  parseSelfSyncPayload,
  SelfSyncPayload,
  shouldApplyStar,
  StarItem,
} from './selfSyncPayload';

const CURSOR_KEY = 'self_sync_cursor';
const PAGE = 100;
const MAX_PAGES = 20;

type StarsListener = (items: StarItem[]) => void;

const ctxFor = (userId: string, eventId: string, deviceId: string) => ({
  conversationId: `self:${userId}`,
  messageId: eventId,
  senderDeviceId: deviceId,
});

class SelfSync {
  private listeners = new Set<StarsListener>();
  private pulling: Promise<void> | null = null;

  onStarsChanged(fn: StarsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** My other active devices, with pinned keys. */
  private async otherDevices(session: SessionContext): Promise<DeviceKeyRef[]> {
    const { data, error } = await supabase.from('devices').select('id').is('revoked_at', null);
    if (error) throw error;
    const ids = (data ?? []).map((d: any) => d.id as string).filter((id) => id !== session.deviceId);
    if (ids.length === 0) return [];
    const keys = await keyDirectory.getKeys(ids);
    return ids
      .map((id) => keys.get(id))
      .filter((k): k is NonNullable<typeof k> => !!k && k.userId === session.userId && !k.revokedAt)
      .map((k) => ({ deviceId: k.deviceId, publicKey: k.publicKey }));
  }

  async publish(session: SessionContext, payload: SelfSyncPayload): Promise<void> {
    if (session.isDemo) return;
    const recipients = await this.otherDevices(session);
    if (recipients.length === 0) return;
    const id = generateUUID();
    const ciphertext = await cryptoManager.encryptMessage(
      session.userId,
      JSON.stringify(payload),
      ctxFor(session.userId, id, session.deviceId),
      recipients
    );
    const { error } = await supabase
      .from('self_sync_events')
      .insert({ id, sender_device_id: session.deviceId, ciphertext });
    if (error) throw error;
  }

  async publishStars(session: SessionContext, items: StarItem[]): Promise<void> {
    for (const payload of chunkStarItems(items)) await this.publish(session, payload);
  }

  /** Fetches and applies events newer than the local cursor. Safe to call repeatedly. */
  pull(session: SessionContext): Promise<void> {
    if (session.isDemo) return Promise.resolve();
    if (!this.pulling) {
      this.pulling = this.doPull(session)
        .catch((e) => console.warn('[SelfSync] pull failed:', (e as Error)?.message))
        .finally(() => {
          this.pulling = null;
        });
    }
    return this.pulling;
  }

  private async doPull(session: SessionContext): Promise<void> {
    let cursor = await messagingStore.getState(CURSOR_KEY);
    for (let page = 0; page < MAX_PAGES; page++) {
      let query = supabase
        .from('self_sync_events')
        .select('id, sender_device_id, ciphertext, created_at')
        .order('created_at', { ascending: true })
        .limit(PAGE);
      if (cursor) query = query.gt('created_at', cursor);
      const { data, error } = await query;
      if (error) throw error;
      const rows = (data ?? []) as { id: string; sender_device_id: string; ciphertext: string; created_at: string }[];
      if (rows.length === 0) return;

      const keys = await keyDirectory.getKeys(rows.map((r) => r.sender_device_id));
      for (const row of rows) {
        if (row.sender_device_id === session.deviceId) continue;
        const key = keys.get(row.sender_device_id);
        if (!key || key.userId !== session.userId) continue; // never trust another account's device
        try {
          const plain = await cryptoManager.decryptMessage(
            session.userId,
            session.deviceId,
            row.ciphertext,
            ctxFor(session.userId, row.id, row.sender_device_id),
            key.publicKey
          );
          const payload = parseSelfSyncPayload(plain);
          if (payload?.t === 'stars') await this.applyStars(payload.items);
        } catch (e) {
          if (!(e instanceof NotAddressedToDeviceError)) {
            console.warn('[SelfSync] skipped an event:', (e as Error)?.message);
          }
        }
      }
      cursor = rows[rows.length - 1].created_at;
      await messagingStore.setState(CURSOR_KEY, cursor);
      if (rows.length < PAGE) return;
    }
  }

  private async applyStars(items: StarItem[]): Promise<void> {
    const local = await messagingStore.getStarStates(items.map((i) => i.id));
    const apply = items.filter((i) => shouldApplyStar(local.get(i.id)?.updatedAt, i.at));
    if (apply.length === 0) return;
    await messagingStore.setStars(
      apply.map((i) => ({ messageId: i.id, conversationId: i.c, starred: i.s, updatedAt: i.at }))
    );
    this.listeners.forEach((fn) => fn(apply));
  }
}

export const selfSync = new SelfSync();
