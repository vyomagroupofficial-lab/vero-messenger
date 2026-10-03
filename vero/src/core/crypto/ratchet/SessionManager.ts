/**
 * Session layer: per-remote-device X3DH + Double Ratchet sessions, v3
 * envelope fan-out, prekey maintenance and recovery.
 *
 * Platform independent: storage (RatchetStore), the key directory (pinned
 * keys) and the server API (prekey upload/claim) are injected, so the same
 * code runs in the app (SQLite + SecureStore), in the bot SDK (state file)
 * and in unit tests (memory + fake server).
 *
 * Invariants
 *  - Every read-modify-write of a remote device's session runs under that
 *    device's mutex.
 *  - Decrypt = (dedupe by message) -> ratchet-decrypt the content key ->
 *    decrypt the body -> commit {session, consumed one-time prekey,
 *    plaintext} in ONE atomic store write. If anything fails nothing is
 *    committed, so a forged body can't burn a message key, and a crash can't
 *    lose a plaintext whose key was already consumed.
 *  - Message keys are single-use, so the plaintext cache is what answers a
 *    duplicate delivery (realtime + history fetch) of the same message.
 */

import type { DeviceKeyRef, EnvelopeContext, Sodium } from '../primitives';
import { NotAddressedToDeviceError, decryptEnvelope } from '../primitives';
import { canSend } from './doubleRatchet';
import {
  AnyEnvelope,
  EnvelopeV3,
  ENVELOPE_V3,
  decryptBody,
  encryptBody,
  isEnvelopeV3,
  parseAnyEnvelope,
  parseSlot,
  serializeEnvelopeV3,
  serializeSlot,
  slotBinding,
} from './envelope';
import {
  InvalidBundleError,
  NoReachableDevicesError,
  OwnMessageUnavailableError,
  isSessionBroken,
} from './errors';
import {
  KeyPairB64,
  OneTimePreKeyRecord,
  PreKeyBundle,
  SignedPreKeyRecord,
  generateOneTimePreKeys,
  generateSignedPreKey,
  signIdentityKey,
  verifyIdentityBinding,
} from './keys';
import { KeyedMutex } from './mutex';
import {
  SessionRecord,
  archiveActive,
  decryptSlot,
  encryptSlot,
  initiateSession,
  installSession,
} from './session';
import type { RatchetStore, StoreWrite } from './store';

// ── Tunables ──────────────────────────────────────────────────────────────────

export const SIGNED_PREKEY_ROTATE_MS = 7 * 24 * 3600 * 1000;
/** Replaced signed prekeys are kept this long for X3DH messages still in flight. */
export const SIGNED_PREKEY_RETAIN_MS = 30 * 24 * 3600 * 1000;
export const ONE_TIME_PREKEY_TARGET = 100;
export const ONE_TIME_PREKEY_LOW_WATER = 25;
export const ONE_TIME_PREKEY_MAX_LOCAL = 500;
/** Decrypted plaintext is kept for dedupe/crash-safety; stories expire sooner. */
export const PLAINTEXT_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
export const STORY_PLAINTEXT_CACHE_TTL_MS = 48 * 3600 * 1000;
/** At most one automatic session reset per remote device in this window. */
export const SESSION_RESET_INTERVAL_MS = 10 * 60 * 1000;
const CLAIM_CHUNK = 200;

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface LocalKeys {
  userId: string;
  deviceId: string;
  /** X25519 identity key (the device key registered in `devices`). */
  identity: KeyPairB64;
  /** Ed25519 signing key that signs the identity key and the signed prekeys. */
  signing: KeyPairB64;
}

export interface TrustedDevice {
  userId: string;
  identityKey: string;
  /** null until first seen (then pinned, trust on first use). */
  signingKey: string | null;
}

export interface SessionDirectory {
  /** Pinned keys for a device, or null if unknown. */
  trusted(deviceId: string): Promise<TrustedDevice | null>;
  /** Pins a device's signing key the first time it's seen (after the binding signature verified). */
  pinSigningKey(deviceId: string, userId: string, signingKey: string): Promise<void>;
}

export interface PreKeyStatus {
  oneTime: number;
  signedPreKeyId: number | null;
}

export interface PreKeyServer {
  /** claim_prekey_bundle: consumes one one-time prekey per device (if any left). */
  claimBundles(deviceIds: string[]): Promise<PreKeyBundle[]>;
  publishSigningKey(deviceId: string, signingKey: string, identitySignature: string): Promise<void>;
  uploadPreKeys(
    deviceId: string,
    signedPreKey: { id: number; publicKey: string; signature: string } | null,
    oneTimePreKeys: { id: number; publicKey: string }[]
  ): Promise<number>;
  preKeyStatus(deviceId: string): Promise<PreKeyStatus>;
}

export interface SessionHooks {
  /**
   * Our session with `remoteDeviceId` is broken (state lost / out of sync). The
   * active session was archived, so the next message to that device starts a
   * new X3DH. Rate-limited per device. The app sends an encrypted "session
   * reset" control message from here.
   */
  onSessionBroken?(remoteDeviceId: string, ctx: EnvelopeContext): void;
  /** A one-time prekey was consumed; time to check the server pool. */
  onPreKeysConsumed?(): void;
  log?(message: string, detail?: unknown): void;
}

export interface SessionManagerOptions {
  sodium: Sodium;
  local: LocalKeys;
  store: RatchetStore;
  directory: SessionDirectory;
  server: PreKeyServer;
  hooks?: SessionHooks;
  now?: () => number;
}

interface PreKeyMeta {
  nextSpkId: number;
  nextOpkId: number;
  currentSpkId: number | null;
  retired: { id: number; at: number }[];
  signingPublished: string | null;
}

// ── Control messages ─────────────────────────────────────────────────────────

const CONTROL_TYPE = '_vero.session';

/** Plaintext of an encrypted "session reset" control message. */
export function sessionResetPlaintext(): string {
  return JSON.stringify({ t: CONTROL_TYPE, op: 'reset' });
}

/** Recognises session-layer control messages (never shown to the user). */
export function parseControlPlaintext(plaintext: string): { op: 'reset' } | null {
  if (!plaintext.startsWith(`{"t":"${CONTROL_TYPE}"`)) return null;
  try {
    const p = JSON.parse(plaintext);
    return p && p.t === CONTROL_TYPE && p.op === 'reset' ? { op: 'reset' } : null;
  } catch {
    return null;
  }
}

export function cacheKeyFor(ctx: EnvelopeContext): string {
  return `${ctx.conversationId}|${ctx.messageId}|${ctx.senderDeviceId}`;
}

function cacheTtl(ctx: EnvelopeContext): number {
  return ctx.conversationId.startsWith('story:') ? STORY_PLAINTEXT_CACHE_TTL_MS : PLAINTEXT_CACHE_TTL_MS;
}

function randomStartId(sodium: Sodium): number {
  // 24 random bits: ids from a wiped/reinstalled store won't collide with old ones.
  return 1 + (sodium.randombytes_uniform(0xffffff) >>> 0);
}

// ── Manager ──────────────────────────────────────────────────────────────────

export class SessionManager {
  private readonly sodium: Sodium;
  private readonly local: LocalKeys;
  private readonly store: RatchetStore;
  private readonly directory: SessionDirectory;
  private readonly server: PreKeyServer;
  private readonly hooks: SessionHooks;
  private readonly now: () => number;
  private readonly mutex = new KeyedMutex();
  private refreshing: Promise<PreKeyStatus> | null = null;

  constructor(opts: SessionManagerOptions) {
    this.sodium = opts.sodium;
    this.local = opts.local;
    this.store = opts.store;
    this.directory = opts.directory;
    this.server = opts.server;
    this.hooks = opts.hooks ?? {};
    this.now = opts.now ?? Date.now;
  }

  get deviceId(): string {
    return this.local.deviceId;
  }

  private log(message: string, detail?: unknown): void {
    this.hooks.log?.(message, detail);
  }

  // ── Encrypt ────────────────────────────────────────────────────────────────

  /**
   * Encrypts `plaintext` once and ratchet-encrypts its content key for every
   * recipient device except this one. Devices without a session get a fresh
   * X3DH from a claimed prekey bundle; devices that publish no (valid) bundle
   * are skipped. Throws NoReachableDevicesError if other devices were listed
   * but none could be reached.
   */
  async encrypt(ctx: EnvelopeContext, plaintext: string, recipients: DeviceKeyRef[]): Promise<string> {
    if (ctx.senderDeviceId !== this.local.deviceId) throw new Error('Sender device does not match this device');
    const sodium = this.sodium;
    const seen = new Set<string>();
    const others = recipients.filter((r) => {
      if (r.deviceId === this.local.deviceId || seen.has(r.deviceId)) return false;
      seen.add(r.deviceId);
      return true;
    });

    // Claim bundles in bulk for devices we have no usable session with.
    const need: string[] = [];
    for (const r of others) {
      const rec = await this.store.get<SessionRecord>('session', r.deviceId);
      if (!rec?.active || !canSend(rec.active.ratchet)) need.push(r.deviceId);
    }
    const bundles = new Map<string, PreKeyBundle>();
    for (let i = 0; i < need.length; i += CLAIM_CHUNK) {
      for (const b of await this.server.claimBundles(need.slice(i, i + CLAIM_CHUNK))) bundles.set(b.deviceId, b);
    }

    const body = encryptBody(sodium, plaintext, ctx);
    const binding = slotBinding(sodium, ctx);
    const k: Record<string, string> = {};
    try {
      for (const r of others) {
        await this.mutex.run(r.deviceId, async () => {
          let rec = await this.store.get<SessionRecord>('session', r.deviceId);
          if (!rec?.active || !canSend(rec.active.ratchet)) {
            const bundle = bundles.get(r.deviceId);
            if (!bundle) {
              this.log('no prekey bundle for device; skipped', r.deviceId);
              return;
            }
            const state = await this.establish(r, bundle);
            if (!state) return;
            rec = installSession(rec, state);
          }
          const out = encryptSlot(sodium, rec!, body.contentKey, binding);
          await this.store.write([{ ns: 'session', key: r.deviceId, value: out.record }]);
          k[r.deviceId] = serializeSlot(sodium, out.slot);
        });
      }
    } finally {
      sodium.memzero(body.contentKey);
    }

    if (others.length > 0 && Object.keys(k).length === 0) throw new NoReachableDevicesError();

    // This device gets no slot: keep the plaintext so it can be shown again.
    await this.store.write([this.cacheWrite(ctx, plaintext)]);
    const env: EnvelopeV3 = { v: ENVELOPE_V3, n: body.n, c: body.c, k };
    return serializeEnvelopeV3(env);
  }

  /** Verifies a claimed bundle against the pinned keys (TOFU for the signing key) and runs X3DH. */
  private async establish(r: DeviceKeyRef, bundle: PreKeyBundle) {
    const trusted = await this.directory.trusted(r.deviceId);
    const identityKey = trusted?.identityKey ?? r.publicKey;
    if (identityKey !== r.publicKey) {
      this.log('recipient identity key differs from pinned key; skipped', r.deviceId);
      return null;
    }
    try {
      const state = initiateSession(
        this.sodium,
        { identity: this.local.identity, deviceId: this.local.deviceId },
        bundle,
        { identityKey, signingKey: trusted?.signingKey ?? null },
        this.now()
      );
      if (!trusted?.signingKey) {
        await this.directory.pinSigningKey(r.deviceId, trusted?.userId ?? bundle.userId ?? '', bundle.signingKey);
      }
      return state;
    } catch (e) {
      if (e instanceof InvalidBundleError) {
        this.log('rejected prekey bundle', { deviceId: r.deviceId, reason: e.message });
        return null;
      }
      throw e;
    }
  }

  private cacheWrite(ctx: EnvelopeContext, plaintext: string): StoreWrite {
    return {
      ns: 'pt',
      key: cacheKeyFor(ctx),
      value: plaintext,
      ref: ctx.messageId,
      expiresAt: this.now() + cacheTtl(ctx),
    };
  }

  // ── Decrypt ────────────────────────────────────────────────────────────────

  /**
   * Decrypts a v2 (static-key, legacy) or v3 (ratchet) envelope from
   * `ctx.senderDeviceId`, whose pinned identity key is `senderIdentityKey`.
   */
  async decrypt(ctx: EnvelopeContext, raw: string, senderIdentityKey: string): Promise<string> {
    const env = parseAnyEnvelope(raw);
    if (!isEnvelopeV3(env)) return this.decryptV2(env, ctx, senderIdentityKey);

    const cacheKey = cacheKeyFor(ctx);
    if (ctx.senderDeviceId === this.local.deviceId) {
      const own = await this.store.get<string>('pt', cacheKey);
      if (own !== null) return own;
      throw new OwnMessageUnavailableError();
    }
    const rawSlot = env.k[this.local.deviceId];
    if (typeof rawSlot !== 'string') {
      const cached = await this.store.get<string>('pt', cacheKey);
      if (cached !== null) return cached;
      throw new NotAddressedToDeviceError();
    }

    return this.mutex.run(ctx.senderDeviceId, async () => {
      // Dedupe BEFORE touching the ratchet: message keys are single-use.
      const cached = await this.store.get<string>('pt', cacheKey);
      if (cached !== null) return cached;

      const sodium = this.sodium;
      const slot = parseSlot(sodium, rawSlot);
      const record = await this.store.get<SessionRecord>('session', ctx.senderDeviceId);
      let result;
      try {
        result = await decryptSlot(sodium, record, slot, slotBinding(sodium, ctx), {
          local: { identity: this.local.identity, deviceId: this.local.deviceId },
          remoteDeviceId: ctx.senderDeviceId,
          remoteIdentityKey: senderIdentityKey,
          loadSignedPreKey: (id) => this.store.get<SignedPreKeyRecord>('spk', String(id)),
          loadOneTimePreKey: (id) => this.store.get<OneTimePreKeyRecord>('opk', String(id)),
          now: this.now(),
        });
      } catch (e) {
        if (isSessionBroken(e)) await this.markBroken(ctx);
        throw e;
      }

      let plaintext: string;
      try {
        plaintext = decryptBody(sodium, env, ctx, result.payload);
      } finally {
        sodium.memzero(result.payload);
      }

      const writes: StoreWrite[] = [
        { ns: 'session', key: ctx.senderDeviceId, value: result.record },
        this.cacheWrite(ctx, plaintext),
      ];
      if (result.consumedOneTimePreKey !== undefined) {
        writes.push({ ns: 'opk', key: String(result.consumedOneTimePreKey), value: null });
      }
      await this.store.write(writes);
      if (result.consumedOneTimePreKey !== undefined) this.hooks.onPreKeysConsumed?.();
      return plaintext;
    });
  }

  private decryptV2(env: AnyEnvelope, ctx: EnvelopeContext, senderIdentityKey: string): string {
    return decryptEnvelope(
      this.sodium,
      env as any,
      ctx,
      this.local.deviceId,
      this.local.identity.priv,
      senderIdentityKey
    );
  }

  /** Archives the active session (next send re-runs X3DH) and asks the app to send a reset, rate-limited. */
  private async markBroken(ctx: EnvelopeContext): Promise<void> {
    const deviceId = ctx.senderDeviceId;
    const record = await this.store.get<SessionRecord>('session', deviceId);
    const last = (await this.store.get<number>('meta', `reset:${deviceId}`)) ?? 0;
    const now = this.now();
    const writes: StoreWrite[] = [];
    if (record?.active) writes.push({ ns: 'session', key: deviceId, value: archiveActive(record) });
    const notify = now - last >= SESSION_RESET_INTERVAL_MS;
    if (notify) writes.push({ ns: 'meta', key: `reset:${deviceId}`, value: now, expiresAt: now + SESSION_RESET_INTERVAL_MS });
    if (writes.length) await this.store.write(writes);
    this.log('session with device is broken; reset scheduled', deviceId);
    if (notify) this.hooks.onSessionBroken?.(deviceId, ctx);
  }

  // ── Session admin ──────────────────────────────────────────────────────────

  async hasSession(deviceId: string): Promise<boolean> {
    const rec = await this.store.get<SessionRecord>('session', deviceId);
    return !!rec?.active;
  }

  /** Forces a new X3DH with `deviceId` on the next send (keeps old sessions for in-flight messages). */
  async resetSession(deviceId: string): Promise<void> {
    await this.mutex.run(deviceId, async () => {
      const rec = await this.store.get<SessionRecord>('session', deviceId);
      if (rec?.active) await this.store.write([{ ns: 'session', key: deviceId, value: archiveActive(rec) }]);
    });
  }

  /** Cached plaintext of a message (own sends and already-decrypted messages). */
  cachedPlaintext(ctx: EnvelopeContext): Promise<string | null> {
    return this.store.get<string>('pt', cacheKeyFor(ctx));
  }

  // ── Prekeys ────────────────────────────────────────────────────────────────

  /**
   * Publishes the signing key, rotates the signed prekey (weekly) and tops up
   * the one-time prekey pool. Safe to call often (single-flight).
   */
  refreshPreKeys(): Promise<PreKeyStatus> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<PreKeyStatus> {
    const sodium = this.sodium;
    const { deviceId, identity, signing } = this.local;
    const now = this.now();
    let meta: PreKeyMeta = (await this.store.get<PreKeyMeta>('meta', 'prekeys')) ?? {
      nextSpkId: randomStartId(sodium),
      nextOpkId: randomStartId(sodium),
      currentSpkId: null,
      retired: [],
      signingPublished: null,
    };

    if (meta.signingPublished !== signing.pub) {
      const signature = signIdentityKey(sodium, identity.pub, signing.priv);
      if (!verifyIdentityBinding(sodium, identity.pub, signing.pub, signature)) throw new Error('Signing key self-check failed');
      await this.server.publishSigningKey(deviceId, signing.pub, signature);
      meta = { ...meta, signingPublished: signing.pub };
      await this.store.write([{ ns: 'meta', key: 'prekeys', value: meta }]);
    }

    const status = await this.server.preKeyStatus(deviceId);
    const current =
      meta.currentSpkId !== null ? await this.store.get<SignedPreKeyRecord>('spk', String(meta.currentSpkId)) : null;

    const writes: StoreWrite[] = [];
    let uploadSpk: SignedPreKeyRecord | null = null;
    if (!current || now - current.createdAt > SIGNED_PREKEY_ROTATE_MS) {
      const spk = generateSignedPreKey(sodium, meta.nextSpkId, signing.priv, now);
      writes.push({ ns: 'spk', key: String(spk.id), value: spk });
      meta = {
        ...meta,
        nextSpkId: (meta.nextSpkId % 0x7ffffffe) + 1,
        currentSpkId: spk.id,
        retired: current ? [...meta.retired, { id: current.id, at: now }] : meta.retired,
      };
      uploadSpk = spk;
    } else if (status.signedPreKeyId !== current.id) {
      uploadSpk = current; // the server lost it (or never got it): publish again
    }

    let uploadOpks: OneTimePreKeyRecord[] = [];
    if (status.oneTime < ONE_TIME_PREKEY_LOW_WATER) {
      uploadOpks = generateOneTimePreKeys(sodium, meta.nextOpkId, ONE_TIME_PREKEY_TARGET - status.oneTime, now);
      for (const o of uploadOpks) writes.push({ ns: 'opk', key: String(o.id), value: o });
      meta = { ...meta, nextOpkId: ((meta.nextOpkId + uploadOpks.length) % 0x7ffffffe) + 1 };
    }

    // Private halves are stored BEFORE the public halves are published.
    writes.push({ ns: 'meta', key: 'prekeys', value: meta });
    await this.store.write(writes);

    let result = status;
    if (uploadSpk || uploadOpks.length) {
      const count = await this.server.uploadPreKeys(
        deviceId,
        uploadSpk ? { id: uploadSpk.id, publicKey: uploadSpk.pub, signature: uploadSpk.signature } : null,
        uploadOpks.map((o) => ({ id: o.id, publicKey: o.pub }))
      );
      result = { oneTime: count, signedPreKeyId: uploadSpk?.id ?? status.signedPreKeyId };
    }

    await this.cleanupPreKeys(meta, now);
    await this.store.purge(now);
    return result;
  }

  private async cleanupPreKeys(meta: PreKeyMeta, now: number): Promise<void> {
    const writes: StoreWrite[] = [];
    const expired = meta.retired.filter((r) => now - r.at > SIGNED_PREKEY_RETAIN_MS);
    for (const r of expired) writes.push({ ns: 'spk', key: String(r.id), value: null });
    const opkIds = (await this.store.keys('opk')).map(Number).sort((a, b) => a - b);
    for (const id of opkIds.slice(0, Math.max(0, opkIds.length - ONE_TIME_PREKEY_MAX_LOCAL))) {
      writes.push({ ns: 'opk', key: String(id), value: null });
    }
    if (writes.length === 0) return;
    writes.push({ ns: 'meta', key: 'prekeys', value: { ...meta, retired: meta.retired.filter((r) => !expired.includes(r)) } });
    await this.store.write(writes);
  }
}

