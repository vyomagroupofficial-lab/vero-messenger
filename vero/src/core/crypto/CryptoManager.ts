/**
 * Vero CryptoManager
 *
 * Owns this device's identity key pair (X25519), its signing key (Ed25519,
 * signs the identity key and signed prekeys) and the storage key for the
 * local session store, and exposes the E2EE operations the repositories
 * need. Algorithms live in ./primitives and ./ratchet (unit-tested).
 *
 * Messages: encryptMessage() produces v3 envelopes through the session
 * layer (X3DH + Double Ratchet, forward secret) once a SessionManager is
 * attached for the account (src/features/keys/SessionService.ts does that at
 * sign-in). decryptMessage() reads v3 and legacy v2 envelopes.
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
  safetyNumber,
  serializeEnvelope,
  type Sodium,
} from './primitives';

import { generateSigningKeyPair, KeyPairB64 } from './ratchet/keys';
import { ControlMessageHandled } from './ratchet/errors';
import { isEnvelopeV3, parseAnyEnvelope } from './ratchet/envelope';
import { parseControlPlaintext, SessionManager } from './ratchet/SessionManager';

export type { DeviceKeyRef, EnvelopeContext } from './primitives';

const k = (userId: string, name: string) => `vero.${userId}.${name}`;

/** Every key this module keeps in the platform keystore for an account. */
const KEY_NAMES = ['identity_sk', 'identity_pk', 'device_id', 'signing_sk', 'signing_pk', 'ratchet_store_key'];

class CryptoManager {
  private sessions = new Map<string, Promise<SessionManager>>();

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
    // Deleting the store key crypto-shreds the local session store.
    this.sessions.delete(userId);
    for (const name of KEY_NAMES) {
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

  // ── Session layer keys ───────────────────────────────────────────────────

  /** Identity (X25519) + signing (Ed25519) key pairs, creating the signing key on first use. */
  async getSessionKeys(userId: string): Promise<{ identity: KeyPairB64; signing: KeyPairB64 }> {
    const identityPub = await secureStorage.get(k(userId, 'identity_pk'));
    const identityPriv = await this.secretKey(userId);
    if (!identityPub) throw new Error('[Vero Crypto] Identity key not found on this device');
    let signingPub = await secureStorage.get(k(userId, 'signing_pk'));
    let signingPriv = await secureStorage.get(k(userId, 'signing_sk'));
    if (!signingPub || !signingPriv) {
      const kp = generateSigningKeyPair(await getSodium());
      await secureStorage.set(k(userId, 'signing_sk'), kp.priv);
      await secureStorage.set(k(userId, 'signing_pk'), kp.pub);
      signingPub = kp.pub;
      signingPriv = kp.priv;
    }
    return { identity: { pub: identityPub, priv: identityPriv }, signing: { pub: signingPub, priv: signingPriv } };
  }

  /**
   * 32-byte key sealing the local session store (sessions, prekey private
   * keys, plaintext cache). Returns `created: true` if it had to be made, in
   * which case any rows sealed with a previous key are unreadable and must be wiped.
   */
  async getSessionStoreKey(userId: string): Promise<{ key: Uint8Array; created: boolean }> {
    const sodium = await getSodium();
    const existing = await secureStorage.get(k(userId, 'ratchet_store_key'));
    if (existing) return { key: sodium.from_base64(existing), created: false };
    const key = sodium.randombytes_buf(32);
    await secureStorage.set(k(userId, 'ratchet_store_key'), sodium.to_base64(key));
    return { key, created: true };
  }

  /** Registers the (possibly still starting) session layer for an account. */
  attachSessions(userId: string, manager: Promise<SessionManager>): void {
    manager.catch(() => {
      if (this.sessions.get(userId) === manager) this.sessions.delete(userId);
    });
    this.sessions.set(userId, manager);
  }

  detachSessions(userId?: string): void {
    if (userId) this.sessions.delete(userId);
    else this.sessions.clear();
  }

  async sessionsFor(userId: string): Promise<SessionManager | null> {
    const p = this.sessions.get(userId);
    if (!p) return null;
    try {
      return await p;
    } catch {
      return null;
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  /**
   * Encrypts once for every recipient device (v3: content key ratchet-encrypted
   * per device; X3DH with a claimed prekey bundle where there is no session yet).
   */
  async encryptMessage(
    userId: string,
    plaintext: string,
    ctx: EnvelopeContext,
    recipients: DeviceKeyRef[]
  ): Promise<string> {
    const sessions = await this.sessionsFor(userId);
    if (!sessions) throw new Error('[Vero Crypto] Secure sessions are not ready yet');
    return sessions.encrypt(ctx, plaintext, recipients);
  }

  /**
   * Decrypts a v3 or legacy v2 envelope. Session-layer control messages
   * ("session reset") are handled here and surface as ControlMessageHandled.
   */
  async decryptMessage(
    userId: string,
    myDeviceId: string,
    rawEnvelope: string,
    ctx: EnvelopeContext,
    senderPublicKey: string
  ): Promise<string> {
    const sessions = await this.sessionsFor(userId);
    let plaintext: string;
    if (sessions && sessions.deviceId === myDeviceId) {
      plaintext = await sessions.decrypt(ctx, rawEnvelope, senderPublicKey);
    } else {
      const envelope = parseAnyEnvelope(rawEnvelope);
      if (isEnvelopeV3(envelope)) throw new Error('[Vero Crypto] Secure sessions are not ready yet');
      plaintext = decryptEnvelope(
        await getSodium(),
        envelope,
        ctx,
        myDeviceId,
        await this.secretKey(userId),
        senderPublicKey
      );
    }
    const control = parseControlPlaintext(plaintext);
    if (control) throw new ControlMessageHandled(control.op);
    return plaintext;
  }

  /** Legacy v2 (static-key) encryption. Kept for tests/tools; the app sends v3. */
  async encryptStaticEnvelope(
    userId: string,
    plaintext: string,
    ctx: EnvelopeContext,
    recipients: DeviceKeyRef[]
  ): Promise<string> {
    const sodium = await getSodium();
    return serializeEnvelope(encryptEnvelope(sodium, plaintext, ctx, await this.secretKey(userId), recipients));
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
