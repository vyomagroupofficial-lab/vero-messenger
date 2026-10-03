/**
 * Wires the forward-secret session layer (src/core/crypto/ratchet) into the
 * app for the signed-in account:
 *
 *   store      SqliteRatchetStore in the account's local database, sealed with
 *              a storage key from SecureStore
 *   directory  KeyDirectory (pinned identity + signing keys)
 *   server     003_ratchet.sql RPCs (claim/upload prekeys)
 *
 * start() is called after sign-in (useAuthStore). It publishes the device's
 * signing key and prekeys in the background and attaches the SessionManager to
 * CryptoManager, which MessageRepository / StoryRepository already use.
 *
 * Recovery: when a message from a device can't be decrypted because our
 * session with it is gone or out of sync, SessionManager archives the session
 * and calls onSessionBroken; we then send that ONE device an encrypted
 * "session reset" control message in the same conversation (new X3DH). It is
 * stored with the coarse server type 'reaction', so it triggers no push and
 * every client ignores it silently. The failed message itself stays marked
 * undecryptable.
 */

import { cryptoManager } from '../../core/crypto/CryptoManager';
import { getSodium } from '../../core/crypto/sodium';
import type { EnvelopeContext } from '../../core/crypto/primitives';
import { SessionManager, sessionResetPlaintext } from '../../core/crypto/ratchet/SessionManager';
import { SqliteRatchetStore } from '../../core/crypto/ratchet/SqliteRatchetStore';
import { createPreKeyServer } from '../../core/crypto/ratchet/serverApi';
import { supabase } from '../../core/network/supabase';
import { databaseService } from '../../core/storage/DatabaseService';
import { generateUUID } from '../../shared/utils/uuid';
import { keyDirectory } from './KeyDirectory';

const REFRESH_EVERY_MS = 6 * 3600 * 1000;
const REFRESH_DEBOUNCE_MS = 5000;
const RETRY_MS = 30_000;

class SessionService {
  private active: { userId: string; deviceId: string; manager: SessionManager } | null = null;
  private starting: { userId: string; deviceId: string; promise: Promise<SessionManager> } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;

  /**
   * Idempotent; never throws. CryptoManager waits for the returned work, so
   * a message sent right after sign-in is encrypted once sessions are ready.
   * A failed start is retried on the next call.
   */
  start(userId: string, deviceId: string): Promise<void> {
    if (this.active?.userId === userId && this.active.deviceId === deviceId) return Promise.resolve();
    if (this.starting?.userId === userId && this.starting.deviceId === deviceId) {
      return this.starting.promise.then(
        () => undefined,
        () => undefined
      );
    }
    this.stop();
    const promise = this.doStart(userId, deviceId);
    const entry = { userId, deviceId, promise };
    this.starting = entry;
    cryptoManager.attachSessions(userId, promise);
    return promise.then(
      () => {
        if (this.starting === entry) this.starting = null;
      },
      (e) => {
        console.warn('[SessionService] start failed:', (e as Error)?.message);
        if (this.starting !== entry) return;
        this.starting = null;
        this.retry = setTimeout(() => {
          this.retry = null;
          void this.start(userId, deviceId);
        }, RETRY_MS);
      }
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.retry) clearTimeout(this.retry);
    this.timer = null;
    this.debounce = null;
    this.retry = null;
    this.active = null;
    this.starting = null;
    cryptoManager.detachSessions();
  }

  private async doStart(userId: string, deviceId: string): Promise<SessionManager> {
    const sodium = await getSodium();
    const keys = await cryptoManager.getSessionKeys(userId);
    const { key, created } = await cryptoManager.getSessionStoreKey(userId);
    const store = new SqliteRatchetStore(sodium, () => databaseService.withConnection(async (db) => db), key);

    // Rows sealed with a lost key, or state that belongs to an older device
    // registration of this account, are useless: start clean.
    const owner = created ? null : await store.get<string>('meta', 'owner').catch(() => null);
    if (owner !== deviceId) {
      await store.wipe();
      await store.write([{ ns: 'meta', key: 'owner', value: deviceId }]);
    }

    const manager: SessionManager = new SessionManager({
      sodium,
      local: { userId, deviceId, identity: keys.identity, signing: keys.signing },
      store,
      directory: keyDirectory,
      server: createPreKeyServer(supabase),
      hooks: {
        onSessionBroken: (remote, ctx) => void this.sendReset(manager, userId, deviceId, remote, ctx),
        onPreKeysConsumed: () => this.scheduleRefresh(),
        log: (m, d) => console.warn(`[Sessions] ${m}`, d ?? ''),
      },
    });
    if (this.starting?.userId !== userId || this.starting.deviceId !== deviceId) {
      throw new Error('superseded by another sign-in');
    }
    this.active = { userId, deviceId, manager };

    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_EVERY_MS);
    return manager;
  }

  private async refresh(): Promise<void> {
    try {
      await this.active?.manager.refreshPreKeys();
    } catch (e) {
      console.warn('[SessionService] prekey refresh failed:', (e as Error)?.message);
    }
  }

  private scheduleRefresh(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  private async sendReset(
    manager: SessionManager,
    userId: string,
    deviceId: string,
    remoteDeviceId: string,
    ctx: EnvelopeContext
  ): Promise<void> {
    if (ctx.conversationId.startsWith('story:')) return; // next message to them re-runs X3DH anyway
    try {
      const remote = await keyDirectory.trusted(remoteDeviceId);
      if (!remote) return;
      const id = generateUUID();
      const ciphertext = await manager.encrypt(
        { conversationId: ctx.conversationId, messageId: id, senderDeviceId: deviceId },
        sessionResetPlaintext(),
        [{ deviceId: remoteDeviceId, publicKey: remote.identityKey }]
      );
      const { error } = await supabase.from('messages').insert({
        id,
        conversation_id: ctx.conversationId,
        sender_device_id: deviceId,
        sender_user_id: userId,
        ciphertext,
        message_type: 'reaction',
      });
      if (error) throw error;
    } catch (e) {
      // e.g. an admins-only group: the next message we send that device re-runs X3DH instead.
      console.warn('[SessionService] session reset not sent:', (e as Error)?.message);
    }
  }
}

export const sessionService = new SessionService();
