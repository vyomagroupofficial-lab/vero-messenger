/**
 * Resolves device public keys with trust-on-first-use pinning.
 *
 * Device identity keys are immutable on the server (a new key = a new device
 * row). If the server ever returns a different key for a device id we have
 * already pinned, that's tampering, and we refuse to use it.
 */

import { supabase } from '../../core/network/supabase';
import { databaseService, PinnedDeviceKey } from '../../core/storage/DatabaseService';
import type { DeviceKeyRef } from '../../core/crypto/CryptoManager';

export class KeyMismatchError extends Error {
  constructor(deviceId: string) {
    super(`Identity key for device ${deviceId} changed unexpectedly`);
    this.name = 'KeyMismatchError';
  }
}

class KeyDirectory {
  private memory = new Map<string, PinnedDeviceKey>();

  reset(): void {
    this.memory.clear();
  }

  private pinAndCheck(fresh: PinnedDeviceKey[], pinned: Map<string, PinnedDeviceKey>): PinnedDeviceKey[] {
    const accepted: PinnedDeviceKey[] = [];
    for (const k of fresh) {
      const known = pinned.get(k.deviceId);
      if (known && (known.publicKey !== k.publicKey || known.userId !== k.userId)) {
        console.warn('[KeyDirectory] refusing key change for device', k.deviceId);
        continue;
      }
      accepted.push(k);
    }
    return accepted;
  }

  /** Keys for specific (sender) devices. Unknown/foreign devices are simply omitted. */
  async getKeys(deviceIds: string[]): Promise<Map<string, PinnedDeviceKey>> {
    const result = new Map<string, PinnedDeviceKey>();
    const unique = [...new Set(deviceIds)];

    const missingFromMemory = unique.filter((id) => !this.memory.has(id));
    if (missingFromMemory.length) {
      for (const k of await databaseService.getDeviceKeys(missingFromMemory)) this.memory.set(k.deviceId, k);
    }

    const missing = unique.filter((id) => !this.memory.has(id));
    if (missing.length) {
      const { data, error } = await supabase.rpc('get_device_keys', { p_device_ids: missing });
      if (!error && data) {
        const fresh: PinnedDeviceKey[] = (data as any[]).map((r) => ({
          deviceId: r.device_id,
          userId: r.user_id,
          publicKey: r.identity_public_key,
          revokedAt: r.revoked_at,
        }));
        const accepted = this.pinAndCheck(fresh, this.memory);
        await databaseService.saveDeviceKeys(accepted);
        for (const k of accepted) this.memory.set(k.deviceId, k);
      }
    }

    for (const id of unique) {
      const k = this.memory.get(id);
      if (k) result.set(id, k);
    }
    return result;
  }

  /** Every active device of every current member: who a new message is encrypted for. */
  async getConversationRecipients(conversationId: string): Promise<DeviceKeyRef[]> {
    const { data, error } = await supabase.rpc('get_conversation_devices', { p_conversation_id: conversationId });
    if (error) throw error;
    const fresh: PinnedDeviceKey[] = (data as any[]).map((r) => ({
      deviceId: r.device_id,
      userId: r.user_id,
      publicKey: r.identity_public_key,
    }));
    const pinned = new Map(
      (await databaseService.getDeviceKeys(fresh.map((k) => k.deviceId))).map((k) => [k.deviceId, k])
    );
    for (const k of fresh) {
      const known = pinned.get(k.deviceId);
      if (known && known.publicKey !== k.publicKey) throw new KeyMismatchError(k.deviceId);
    }
    await databaseService.saveDeviceKeys(fresh);
    for (const k of fresh) this.memory.set(k.deviceId, k);
    return fresh.map((k) => ({ deviceId: k.deviceId, publicKey: k.publicKey }));
  }

  /** Active device keys of one user (for safety numbers). */
  async getUserKeys(userId: string): Promise<string[]> {
    const { data, error } = await supabase.rpc('get_user_device_keys', { p_user_id: userId });
    if (error) throw error;
    return (data as any[]).map((r) => r.identity_public_key as string);
  }
}

export const keyDirectory = new KeyDirectory();
