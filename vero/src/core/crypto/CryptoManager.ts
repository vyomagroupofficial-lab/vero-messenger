/**
 * Vero CryptoManager
 *
 * Owns this device's identity key pair and exposes the E2EE operations the
 * repositories need. Algorithms live in ./primitives (unit-tested); this class
 * only adds key storage.
 *
 * Keys are scoped per account, so logging into a second account on the same
 * phone never reuses (or leaks) the first account's identity.
 */

import { secureStorage } from '../storage/secureStorage';
import { getSodium } from './sodium';
import {
  DeviceKeyRef,
  EnvelopeContext,
  EncryptedBlob,
  decryptBlob,
  decryptEnvelope,
  encryptBlob,
  encryptEnvelope,
  generateIdentityKeyPair,
  parseEnvelope,
  safetyNumber,
  serializeEnvelope,
  type Sodium,
} from './primitives';

export type { DeviceKeyRef, EnvelopeContext } from './primitives';

const k = (userId: string, name: string) => `vero.${userId}.${name}`;

class CryptoManager {
  /** Returns this device's identity public key for `userId`, creating the key pair on first use. */
  async getOrCreateIdentity(userId: string): Promise<{ publicKey: string; created: boolean }> {
    const existing = await secureStorage.get(k(userId, 'identity_pk'));
    const existingSk = await secureStorage.get(k(userId, 'identity_sk'));
    if (existing && existingSk) return { publicKey: existing, created: false };

    const sodium = await getSodium();
    const kp = generateIdentityKeyPair(sodium);
    await secureStorage.set(k(userId, 'identity_sk'), kp.secretKey);
    await secureStorage.set(k(userId, 'identity_pk'), kp.publicKey);
    // A new key pair invalidates any previously registered device row.
    await secureStorage.remove(k(userId, 'device_id'));
    return { publicKey: kp.publicKey, created: true };
  }

  async getIdentityPublicKey(userId: string): Promise<string | null> {
    return secureStorage.get(k(userId, 'identity_pk'));
  }

  async getDeviceId(userId: string): Promise<string | null> {
    return secureStorage.get(k(userId, 'device_id'));
  }

  async setDeviceId(userId: string, deviceId: string): Promise<void> {
    await secureStorage.set(k(userId, 'device_id'), deviceId);
  }

  /** Wipes this account's identity from the device (used when the device is revoked). */
  async clearIdentity(userId: string): Promise<void> {
    for (const name of ['identity_sk', 'identity_pk', 'device_id']) {
      try {
        await secureStorage.remove(k(userId, name));
      } catch {
        // best effort
      }
    }
  }

  private async secretKey(userId: string): Promise<string> {
    const sk = await secureStorage.get(k(userId, 'identity_sk'));
    if (!sk) throw new Error('[Vero Crypto] Identity key not found on this device');
    return sk;
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async encryptMessage(
    userId: string,
    plaintext: string,
    ctx: EnvelopeContext,
    recipients: DeviceKeyRef[]
  ): Promise<string> {
    const sodium = await getSodium();
    const envelope = encryptEnvelope(sodium, plaintext, ctx, await this.secretKey(userId), recipients);
    return serializeEnvelope(envelope);
  }

  async decryptMessage(
    userId: string,
    myDeviceId: string,
    rawEnvelope: string,
    ctx: EnvelopeContext,
    senderPublicKey: string
  ): Promise<string> {
    const sodium = await getSodium();
    return decryptEnvelope(
      sodium,
      parseEnvelope(rawEnvelope),
      ctx,
      myDeviceId,
      await this.secretKey(userId),
      senderPublicKey
    );
  }

  // ── Media ─────────────────────────────────────────────────────────────────

  async encryptFile(plain: Uint8Array): Promise<EncryptedBlob> {
    return encryptBlob(await getSodium(), plain);
  }

  async decryptFile(ciphertext: Uint8Array, key: string, nonce: string, hash?: string): Promise<Uint8Array> {
    return decryptBlob(await getSodium(), ciphertext, key, nonce, hash);
  }

  async toBase64Standard(bytes: Uint8Array): Promise<string> {
    const sodium = await getSodium();
    return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
  }

  async fromBase64Standard(b64: string): Promise<Uint8Array> {
    const sodium = await getSodium();
    return sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
  }

  // ── Verification ──────────────────────────────────────────────────────────

  async computeSafetyNumber(
    me: { userId: string; keys: string[] },
    them: { userId: string; keys: string[] }
  ): Promise<string> {
    return safetyNumber(await getSodium(), me, them);
  }

  // ── Feature-level crypto (e.g. call signalling, src/features/calls) ───────

  /**
   * Runs a synchronous crypto operation with this device's identity secret
   * key. The key is only passed to `fn` (never returned or stored elsewhere).
   */
  async withIdentitySecretKey<T>(userId: string, fn: (sodium: Sodium, secretKey: string) => T): Promise<T> {
    const sodium = await getSodium();
    return fn(sodium, await this.secretKey(userId));
  }
}

export const cryptoManager = new CryptoManager();
