/**
 * Resolves device public keys with trust-on-first-use pinning.
 *
 * Device identity keys are immutable on the server (a new key = a new device
 * row). If the server ever returns a different key for a device id we have
 * already pinned, that's tampering, and we refuse to use it.
 *
 * Each device also has an Ed25519 SIGNING key (003_ratchet.sql) that signs its
 * identity key and its signed prekeys. It is pinned the same way (first use,
 * after the identity-binding signature verifies) in its own small table, and
 * it is part of the safety number: getUserKeys() returns identity keys AND
 * signing keys, so a substituted signing key changes the number.
 */

import { supabase } from '../../core/network/supabase';
import { databaseService, PinnedDeviceKey } from '../../core/storage/DatabaseService';
import type { DeviceKeyRef } from '../../core/crypto/CryptoManager';
import { getSodium } from '../../core/crypto/sodium';
import { verifyIdentityBinding } from '../../core/crypto/ratchet/keys';
import type { SessionDirectory, TrustedDevice } from '../../core/crypto/ratchet/SessionManager';

const SIGNING_PIN_TABLE = 'vero_signing_key_pins';

export class KeyMismatchError extends Error {
  constructor(deviceId: string) {
    super(`Identity key for device ${deviceId} changed unexpectedly`);
    this.name = 'KeyMismatchError';
  }
}

class KeyDirectory implements SessionDirectory {
  private memory = new Map<string, PinnedDeviceKey>();
  private signingPins = new Map<string, string>();
  private pinTableReady: Promise<void> | null = null;

  reset(): void {
    this.memory.clear();
    this.signingPins.clear();
    this.pinTableReady = null;
  }

  // ── Signing keys (session layer) ─────────────────────────────────────────

  private async pinTable<T>(fn: (db: Parameters<Parameters<typeof databaseService.withConnection>[0]>[0]) => Promise<T>) {
    return databaseService.withConnection(async (db) => {
      if (!this.pinTableReady) {
        this.pinTableReady = db.execAsync(
          `CREATE TABLE IF NOT EXISTS ${SIGNING_PIN_TABLE} (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, signing_key TEXT NOT NULL)`
        );
        this.pinTableReady.catch(() => {
          this.pinTableReady = null;
        });
      }
      await this.pinTableReady;
      return fn(db);
    });
  }

  private async pinnedSigningKey(deviceId: string): Promise<string | null> {
    const cached = this.signingPins.get(deviceId);
    if (cached) return cached;
    const row = await this.pinTable((db) =>
      db.getFirstAsync<{ signing_key: string }>(`SELECT signing_key FROM ${SIGNING_PIN_TABLE} WHERE device_id = ?`, [
        deviceId,
      ])
    );
    if (row?.signing_key) this.signingPins.set(deviceId, row.signing_key);
    return row?.signing_key ?? null;
  }

  /** SessionDirectory: pinned identity key (+ signing key if already pinned) of a device. */
  async trusted(deviceId: string): Promise<TrustedDevice | null> {
    const key = (await this.getKeys([deviceId])).get(deviceId);
    if (!key) return null;
    return { userId: key.userId, identityKey: key.publicKey, signingKey: await this.pinnedSigningKey(deviceId) };
  }

  /** SessionDirectory: first-use pin; an existing pin is never overwritten. */
  async pinSigningKey(deviceId: string, userId: string, signingKey: string): Promise<void> {
    await this.pinTable((db) =>
      db.runAsync(`INSERT OR IGNORE INTO ${SIGNING_PIN_TABLE} (device_id, user_id, signing_key) VALUES (?, ?, ?)`, [
        deviceId,
        userId,
        signingKey,
      ])
    );
    const pinned = await this.pinnedSigningKey(deviceId);
    if (pinned !== signingKey) throw new KeyMismatchError(deviceId);
  }

  /**
   * Verified signing keys for devices (identity binding checked against the
   * pinned identity key). Newly seen keys are pinned; a key that differs from
   * the pin is still returned (so safety numbers show the change) but the
   * session layer never uses it.
   */
  async getSigningKeys(deviceIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (deviceIds.length === 0) return out;
    const { data, error } = await supabase.rpc('get_device_signing_keys', { p_device_ids: deviceIds });
    if (error) throw error;
    if (!data) return out;
    const sodium = await getSodium();
    const identities = await this.getKeys(deviceIds);
    for (const r of data as any[]) {
      const identity = identities.get(r.device_id);
      if (!identity || identity.publicKey !== r.identity_public_key) continue;
      if (!verifyIdentityBinding(sodium, r.identity_public_key, r.signing_public_key, r.identity_signature)) {
        console.warn('[KeyDirectory] invalid identity binding for device', r.device_id);
        continue;
      }
      const pinned = await this.pinnedSigningKey(r.device_id);
      if (!pinned) await this.pinSigningKey(r.device_id, identity.userId, r.signing_public_key);
      else if (pinned !== r.signing_public_key) console.warn('[KeyDirectory] signing key changed for device', r.device_id);
      out.set(r.device_id, r.signing_public_key);
    }
    return out;
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

  /**
   * Key material of one user's active devices, for safety numbers and QR
   * fingerprints: every identity key plus every (verified) signing key.
   */
  async getUserKeys(userId: string): Promise<string[]> {
    const { data, error } = await supabase.rpc('get_user_device_keys', { p_user_id: userId });
    if (error) throw error;
    const rows = data as any[];
    const identityKeys = rows.map((r) => r.identity_public_key as string);
    // Devices that haven't published a signing key yet contribute only their identity key.
    const signingKeys = await this.getSigningKeys(rows.map((r) => r.device_id as string));
    return [...identityKeys, ...signingKeys.values()];
  }
}

export const keyDirectory = new KeyDirectory();
