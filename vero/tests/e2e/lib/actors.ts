/**
 * Test users and devices built from the app's REAL modules:
 *   - identity keys: core/crypto/primitives (generateIdentityKeyPair)
 *   - forward secrecy: core/crypto/ratchet SessionManager + MemoryRatchetStore
 *     (or SqliteRatchetStore over node:sqlite), prekeys via serverApi
 *   - payloads: shared/models/payload (serverTypeFor / parsePayload)
 * Each Device is its own signed-in Supabase client (own session, own realtime
 * socket), exactly like a separate phone / browser of the same account.
 */

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import sodiumModule from 'libsodium-wrappers';
import { generateIdentityKeyPair, type DeviceKeyRef, type EnvelopeContext, type Sodium } from '../../../src/core/crypto/primitives';
import { generateSigningKeyPair, type KeyPairB64 } from '../../../src/core/crypto/ratchet/keys';
import { MemoryRatchetStore, type RatchetStore } from '../../../src/core/crypto/ratchet/store';
import { SessionManager, parseControlPlaintext, type TrustedDevice } from '../../../src/core/crypto/ratchet/SessionManager';
import { createPreKeyServer } from '../../../src/core/crypto/ratchet/serverApi';
import { MessagePayload, parsePayload, serverTypeFor } from '../../../src/shared/models/payload';
import { env, RUN_ID } from './env';
import { join, mustJoin, type JoinResult, type Listener } from './realtime';

let sodiumReady: Promise<Sodium> | null = null;
export function sodium(): Promise<Sodium> {
  sodiumReady ??= sodiumModule.ready.then(() => sodiumModule as unknown as Sodium);
  return sodiumReady;
}

export function newClient(): SupabaseClient {
  return createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function adminClient(): SupabaseClient | null {
  if (!env.serviceKey) return null;
  return createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

const created: string[] = [];
const openClients: SupabaseClient[] = [];

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_device_id: string;
  sender_user_id: string;
  ciphertext: string;
  message_type: string;
  media_id: string | null;
  reply_to_message_id: string | null;
  created_at: string;
  expires_at: string | null;
  deleted_at?: string | null;
}

export const MESSAGE_COLUMNS =
  'id, conversation_id, sender_device_id, sender_user_id, ciphertext, message_type, media_id, reply_to_message_id, created_at, expires_at, deleted_at';

export class User {
  readonly devices: Device[] = [];
  constructor(
    readonly name: string,
    readonly id: string,
    readonly email: string,
    readonly password: string,
    readonly username: string
  ) {}

  /**
   * Creates an account. With the service key: a confirmed user via the admin
   * API (no e-mail). Without it: a real auth.signUp (needs auto-confirm).
   */
  static async create(name: string, opts: { confirmed?: boolean } = {}): Promise<User> {
    const username = `e2e_${RUN_ID}_${name}`.toLowerCase().slice(0, 30);
    const email = `${username}@${env.emailDomain}`;
    const password = `pw-${randomUUID()}`;
    const meta = { username, display_name: `E2E ${name}` };
    const admin = adminClient();
    let id: string;
    if (admin) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: opts.confirmed ?? true,
        user_metadata: meta,
      });
      if (error || !data.user) throw new Error(`createUser ${name}: ${error?.message}`);
      id = data.user.id;
    } else {
      const c = newClient();
      const { data, error } = await c.auth.signUp({ email, password, options: { data: meta } });
      if (error || !data.user) throw new Error(`signUp ${name}: ${error?.message}`);
      if (!data.session) throw new Error('signUp returned no session: enable auto-confirm or provide SUPABASE_SERVICE_ROLE_KEY');
      id = data.user.id;
    }
    created.push(id);
    return new User(name, id, email, password, username);
  }

  /** Registers a device (keys + prekeys), like a fresh install signing in. */
  async addDevice(label = `${this.name}-d${this.devices.length + 1}`, opts: { store?: RatchetStore; preKeys?: boolean } = {}): Promise<Device> {
    const d = new Device(this, label);
    await d.signIn();
    await d.register(opts);
    this.devices.push(d);
    return d;
  }

  /** A signed-in client without a registered device (for plain RPC / RLS checks). */
  async client(): Promise<SupabaseClient> {
    const c = newClient();
    const { error } = await c.auth.signInWithPassword({ email: this.email, password: this.password });
    if (error) throw new Error(`sign in ${this.name}: ${error.message}`);
    openClients.push(c);
    return c;
  }

  get d1(): Device {
    return this.devices[0];
  }

  get d2(): Device {
    return this.devices[1];
  }
}

export class Device {
  readonly client: SupabaseClient;
  deviceId!: string;
  identity!: { publicKey: string; secretKey: string };
  signing!: KeyPairB64;
  sessions!: SessionManager;
  store!: RatchetStore;
  /** deviceId -> pinned keys (trust on first use, like KeyDirectory / the bot SDK). */
  readonly pinned = new Map<string, { userId: string; publicKey: string; signingKey?: string }>();
  readonly resets: string[] = [];

  constructor(readonly user: User, readonly label: string) {
    this.client = newClient();
    openClients.push(this.client);
  }

  get userId(): string {
    return this.user.id;
  }

  async signIn(): Promise<void> {
    const { error } = await this.client.auth.signInWithPassword({ email: this.user.email, password: this.user.password });
    if (error) throw new Error(`sign in ${this.label}: ${error.message}`);
  }

  /** Same steps as AuthRepository.ensureDeviceRegistered + SessionService start. */
  async register(opts: { store?: RatchetStore; preKeys?: boolean } = {}): Promise<void> {
    const s = await sodium();
    this.identity = generateIdentityKeyPair(s);
    this.signing = generateSigningKeyPair(s);
    const { data, error } = await this.client
      .from('devices')
      .insert({ identity_public_key: this.identity.publicKey, device_label: this.label.slice(0, 64) })
      .select('id')
      .single();
    if (error || !data) throw new Error(`device registration ${this.label}: ${error?.message}`);
    this.deviceId = data.id;
    this.store = opts.store ?? new MemoryRatchetStore();
    this.sessions = new SessionManager({
      sodium: s,
      local: {
        userId: this.userId,
        deviceId: this.deviceId,
        identity: { pub: this.identity.publicKey, priv: this.identity.secretKey },
        signing: this.signing,
      },
      store: this.store,
      directory: {
        trusted: (id) => this.trusted(id),
        pinSigningKey: async (id, _userId, signingKey) => {
          const k = this.pinned.get(id);
          if (!k) return;
          if (k.signingKey && k.signingKey !== signingKey) throw new Error(`signing key of ${id} changed`);
          k.signingKey = signingKey;
        },
      },
      server: createPreKeyServer(this.client),
      hooks: { onSessionBroken: (remote) => void this.resets.push(remote) },
    });
    if (opts.preKeys !== false) await this.sessions.refreshPreKeys();
  }

  private async trusted(deviceId: string): Promise<TrustedDevice | null> {
    const k = await this.keyOf(deviceId);
    return k ? { userId: k.userId, identityKey: k.publicKey, signingKey: k.signingKey ?? null } : null;
  }

  async keyOf(deviceId: string): Promise<{ userId: string; publicKey: string; signingKey?: string } | null> {
    const known = this.pinned.get(deviceId);
    if (known) return known;
    const { data, error } = await this.client.rpc('get_device_keys', { p_device_ids: [deviceId] });
    if (error || !data?.[0]) return null;
    const k = { userId: data[0].user_id as string, publicKey: data[0].identity_public_key as string };
    this.pinned.set(deviceId, k);
    return k;
  }

  /** Recipients of a conversation (every active device of every member), pinned. */
  async recipients(conversationId: string): Promise<DeviceKeyRef[]> {
    const { data, error } = await this.client.rpc('get_conversation_devices', { p_conversation_id: conversationId });
    if (error) throw new Error(`get_conversation_devices: ${error.message}`);
    return (data as any[]).map((r) => {
      const known = this.pinned.get(r.device_id);
      if (known && known.publicKey !== r.identity_public_key) throw new Error(`key of ${r.device_id} changed`);
      if (!known) this.pinned.set(r.device_id, { userId: r.user_id, publicKey: r.identity_public_key });
      return { deviceId: r.device_id, publicKey: r.identity_public_key };
    });
  }

  /** Encrypts with the v3 session layer and inserts, like MessageRepository.deliver. */
  async send(
    conversationId: string,
    payload: MessagePayload,
    opts: { id?: string; replyTo?: string | null; mediaId?: string | null; expiresAt?: string | null; recipients?: DeviceKeyRef[] } = {}
  ): Promise<MessageRow> {
    const id = opts.id ?? randomUUID();
    const sealed = await this.seal(conversationId, id, payload, opts.recipients);
    const { data, error } = await this.client
      .from('messages')
      .insert({
        id,
        conversation_id: conversationId,
        sender_device_id: this.deviceId,
        sender_user_id: this.userId,
        ciphertext: sealed,
        message_type: serverTypeFor(payload),
        media_id: opts.mediaId ?? null,
        reply_to_message_id: opts.replyTo ?? null,
        expires_at: opts.expiresAt ?? null,
      })
      .select(MESSAGE_COLUMNS)
      .single();
    if (error) throw Object.assign(new Error(`send: ${error.message}`), { code: error.code });
    return data as MessageRow;
  }

  async seal(conversationId: string, messageId: string, payload: MessagePayload, recipients?: DeviceKeyRef[]): Promise<string> {
    const ctx: EnvelopeContext = { conversationId, messageId, senderDeviceId: this.deviceId };
    return this.sessions.encrypt(ctx, JSON.stringify(payload), recipients ?? (await this.recipients(conversationId)));
  }

  /** Verifies the sender device (pinned), decrypts and parses. */
  async open(row: Pick<MessageRow, 'id' | 'conversation_id' | 'sender_device_id' | 'sender_user_id' | 'ciphertext'>): Promise<{
    plaintext: string;
    payload: MessagePayload | null;
    control: boolean;
  }> {
    const key = await this.keyOf(row.sender_device_id);
    if (!key || key.userId !== row.sender_user_id) throw new Error(`unknown sender device ${row.sender_device_id}`);
    const plaintext = await this.sessions.decrypt(
      { conversationId: row.conversation_id, messageId: row.id, senderDeviceId: row.sender_device_id },
      row.ciphertext,
      key.publicKey
    );
    const control = !!parseControlPlaintext(plaintext);
    return { plaintext, payload: control ? null : parsePayload(plaintext), control };
  }

  async fetch(messageId: string): Promise<MessageRow | null> {
    const { data, error } = await this.client.from('messages').select(MESSAGE_COLUMNS).eq('id', messageId).maybeSingle();
    if (error) throw new Error(`fetch message: ${error.message}`);
    return data as MessageRow | null;
  }

  async rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) throw Object.assign(new Error(`${fn}: ${error.message}`), { code: error.code, details: error });
    return data as T;
  }

  join(topic: string, opts?: Parameters<typeof join>[2]): Promise<JoinResult> {
    return join(this.client, topic, opts);
  }

  listen(topic: string, opts?: Parameters<typeof join>[2]): Promise<Listener> {
    return mustJoin(this.client, topic, opts);
  }

  async accessToken(): Promise<string> {
    const { data } = await this.client.auth.getSession();
    return data.session!.access_token;
  }
}

/** Expect a Supabase call to fail; returns the error (code/message). */
export async function rejects(p: PromiseLike<{ error: any; data?: any }> | Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    const r: any = await p;
    if (r && typeof r === 'object' && 'error' in r) {
      if (r.error) return { code: r.error.code, message: r.error.message };
      throw new Error(`expected an error, got data ${JSON.stringify(r.data)?.slice(0, 200)}`);
    }
  } catch (e: any) {
    if (/^expected an error/.test(e?.message)) throw e;
    return { code: e?.code, message: e?.message ?? String(e) };
  }
  throw new Error('expected an error, but the call succeeded');
}

/** Signs out every client and (with the service key) deletes the users created by this run. */
export async function cleanup(): Promise<void> {
  for (const c of openClients.splice(0)) {
    try {
      c.realtime.disconnect();
    } catch {
      /* ignore */
    }
  }
  const admin = adminClient();
  if (!admin || env.keep) return;
  for (const id of created.splice(0)) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
