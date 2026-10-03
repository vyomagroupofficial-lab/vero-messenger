/**
 * Vero bot SDK (Node 20+).
 *
 * A bot is a normal Vero account whose process holds its own device key:
 *   1. signs in with the token from the app's "Create bot" screen
 *   2. creates (once) an X25519 identity key pair, stored in a local state
 *      file, and registers it as a device
 *   3. listens on its private realtime topic (user:<botId>) for new-message
 *      pings, fetches the ciphertext, verifies the sender device key (pinned
 *      on first use, like the app) and decrypts it
 *   4. replies by encrypting for every device in the conversation
 * The server never sees plaintext - only this process can read the chats.
 *
 * Messages use the app's forward-secret session layer (v3 envelopes: X3DH +
 * Double Ratchet, src/core/crypto/ratchet). The bot has an Ed25519 signing
 * key, publishes signed/one-time prekeys, and keeps its sessions, prekey
 * private keys and a short plaintext cache in the state file - so the state
 * file is now as sensitive as the identity key, must be persistent, and must
 * not be shared between two running processes (sessions would fork).
 * Legacy v2 messages are still read.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import sodiumModule from 'libsodium-wrappers';
import { generateIdentityKeyPair, NotAddressedToDeviceError, type EnvelopeContext } from '../../src/core/crypto/primitives';
import { generateSigningKeyPair, type KeyPairB64 } from '../../src/core/crypto/ratchet/keys';
import { MemoryRatchetStore, type MemorySnapshot } from '../../src/core/crypto/ratchet/store';
import { SessionManager, sessionResetPlaintext, type TrustedDevice } from '../../src/core/crypto/ratchet/SessionManager';
import { createPreKeyServer } from '../../src/core/crypto/ratchet/serverApi';
import {
  DeviceKeyRef,
  MessagePayload,
  Sodium,
  openSessionPayload,
  parseBotToken,
  parseCommand,
  sealSessionPayload,
} from './envelope';

export interface VeroBotOptions {
  supabaseUrl: string;
  /** The project's anon/publishable key (same one the app uses). */
  anonKey: string;
  /** Token shown once when the bot was created (or rotated). */
  token: string;
  /** Where the bot's private key and cursors are kept. Keep it secret and persistent. */
  stateFile?: string;
  deviceLabel?: string;
  /** Re-check conversations this often in case a realtime ping was missed (ms). */
  pollIntervalMs?: number;
  log?: (...args: unknown[]) => void;
}

export interface IncomingMessage {
  id: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  createdAt: string;
  payload: MessagePayload;
  /** Text of a text message. */
  text?: string;
  /** Parsed "/command args" for text messages starting with '/'. */
  command?: { command: string; args: string };
  /** Parsed JSON sent by the bot's mini-app via Vero.sendData(). */
  data?: unknown;
}

export interface BotContext {
  bot: VeroBot;
  message: IncomingMessage;
  /** Sends an encrypted text reply to the same conversation (as a reply). */
  reply: (text: string) => Promise<string>;
}

type Handler = (ctx: BotContext) => unknown | Promise<unknown>;

interface PinnedKey {
  userId: string;
  publicKey: string;
  /** Ed25519 signing key, pinned on first use (session layer). */
  signingKey?: string;
}

interface BotState {
  userId?: string;
  identity?: { publicKey: string; secretKey: string };
  /** Ed25519 key that signs the identity key and the signed prekeys. */
  signing?: KeyPairB64;
  deviceId?: string;
  pinned: Record<string, PinnedKey>;
  cursors: Record<string, string>;
  processed: string[];
  /** Session layer store: sessions, prekey private keys, plaintext cache. */
  ratchet?: MemorySnapshot;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_device_id: string;
  sender_user_id: string;
  ciphertext: string;
  created_at: string;
  deleted_at: string | null;
}

const COLUMNS = 'id, conversation_id, sender_device_id, sender_user_id, ciphertext, created_at, deleted_at';
const MAX_TEXT = 5000;

export class VeroBot {
  readonly supabase: SupabaseClient;
  private sodium!: Sodium;
  private state: BotState;
  private readonly stateFile: string;
  private readonly creds: { userId: string; email: string; password: string };
  private channel: RealtimeChannel | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private handlers: Handler[] = [];
  private commands = new Map<string, Handler>();
  private dataHandlers: Handler[] = [];
  private queue: Promise<void> = Promise.resolve();
  private username: string | undefined;
  private sessions!: SessionManager;
  private readonly log: (...args: unknown[]) => void;

  constructor(private readonly opts: VeroBotOptions) {
    if (!opts.supabaseUrl || !opts.anonKey) throw new Error('supabaseUrl and anonKey are required');
    this.creds = parseBotToken(opts.token);
    this.stateFile = opts.stateFile ?? `.vero-bot-${this.creds.userId}.json`;
    this.log = opts.log ?? ((...a) => console.log('[vero-bot]', ...a));
    this.state = this.loadState();
    this.supabase = createClient(opts.supabaseUrl, opts.anonKey, {
      auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }

  get userId(): string {
    return this.creds.userId;
  }

  // ── Handlers ───────────────────────────────────────────────────────────────

  /** Every decrypted text / sticker / GIF / payment message (after command handlers). */
  onMessage(handler: Handler): this {
    this.handlers.push(handler);
    return this;
  }

  /** "/name args" text messages. */
  command(name: string, handler: Handler): this {
    this.commands.set(name.replace(/^\//, '').toLowerCase(), handler);
    return this;
  }

  /** JSON posted by the bot's mini-app (Vero.sendData). */
  onData(handler: Handler): this {
    this.dataHandlers.push(handler);
    return this;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await sodiumModule.ready;
    this.sodium = sodiumModule as unknown as Sodium;

    const { data, error } = await this.supabase.auth.signInWithPassword({
      email: this.creds.email,
      password: this.creds.password,
    });
    if (error || !data.user) throw new Error(`Bot sign-in failed: ${error?.message ?? 'unknown error'} (token rotated?)`);
    if (data.user.id !== this.creds.userId) throw new Error('Token does not match the signed-in bot');
    if (this.state.userId && this.state.userId !== data.user.id) throw new Error(`State file ${this.stateFile} belongs to another bot`);
    this.state.userId = data.user.id;

    const { data: profile } = await this.supabase.from('profiles').select('username').eq('id', this.userId).maybeSingle();
    this.username = profile?.username ?? undefined;

    await this.ensureDevice();
    this.startSessions();
    await this.sessions.refreshPreKeys();
    await this.catchUp(true);

    await this.supabase.realtime.setAuth();
    this.channel = this.supabase
      .channel(`user:${this.userId}`, { config: { private: true } })
      .on('broadcast', { event: 'inbox.message' }, ({ payload }) => {
        if (typeof payload?.message_id === 'string') this.enqueue(() => this.handleMessageId(payload.message_id));
      })
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') this.log(`listening as @${this.username ?? this.userId}`);
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') this.log('realtime problem:', status, err?.message ?? '');
      });

    const every = this.opts.pollIntervalMs ?? 60_000;
    if (every > 0) {
      let ticks = 0;
      this.poller = setInterval(() => {
        this.enqueue(() => this.catchUp(false));
        // Top up one-time prekeys / rotate the signed prekey about hourly.
        if (++ticks % Math.max(1, Math.round(3_600_000 / every)) === 0) {
          this.enqueue(async () => void (await this.sessions.refreshPreKeys()));
        }
      }, every);
    }
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    if (this.channel) await this.supabase.removeChannel(this.channel);
    this.channel = null;
    await this.queue;
    await this.supabase.auth.signOut();
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  async sendText(conversationId: string, text: string, replyTo?: string): Promise<string> {
    const body = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text;
    return this.sendPayload(conversationId, { t: 'text', body }, replyTo);
  }

  async sendPayload(conversationId: string, payload: MessagePayload, replyTo?: string): Promise<string> {
    const recipients = await this.recipients(conversationId);
    const id = randomUUID();
    const { ciphertext, messageType } = await sealSessionPayload(
      this.sessions,
      payload,
      { conversationId, messageId: id, senderDeviceId: this.state.deviceId! },
      recipients
    );
    const { error } = await this.supabase.from('messages').insert({
      id,
      conversation_id: conversationId,
      sender_device_id: this.state.deviceId,
      sender_user_id: this.userId,
      ciphertext,
      message_type: messageType,
      reply_to_message_id: replyTo ?? null,
    });
    if (error) throw new Error(`send failed: ${error.message}`);
    return id;
  }

  /** Updates the command menu / description / mini-app shown in the app. */
  async setProfile(patch: { commands?: { command: string; description: string }[]; description?: string; miniAppUrl?: string | null }) {
    const { error } = await this.supabase.functions.invoke('bot-admin', { body: { action: 'set_profile', ...patch } });
    if (error) throw new Error(`set_profile failed: ${error.message}`);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((e) => this.log('error:', e instanceof Error ? e.message : e));
  }

  private loadState(): BotState {
    const empty: BotState = { pinned: {}, cursors: {}, processed: [] };
    if (!existsSync(this.stateFile)) return empty;
    try {
      return { ...empty, ...JSON.parse(readFileSync(this.stateFile, 'utf8')) };
    } catch {
      throw new Error(`Cannot read bot state file ${this.stateFile}`);
    }
  }

  private saveState(): void {
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.stateFile);
    try {
      chmodSync(this.stateFile, 0o600);
    } catch {
      // best effort on platforms without chmod
    }
  }

  private async ensureDevice(): Promise<void> {
    if (this.state.identity && this.state.deviceId) {
      const { data } = await this.supabase
        .from('devices')
        .select('id, identity_public_key, revoked_at')
        .eq('id', this.state.deviceId)
        .maybeSingle();
      if (data && !data.revoked_at && data.identity_public_key === this.state.identity.publicKey) {
        await this.supabase.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', data.id);
        return;
      }
      this.log('stored device is gone or revoked; registering a new device key');
    }
    // A fresh key pair for every (re-)registration: revoked keys stay revoked.
    this.state.identity = generateIdentityKeyPair(this.sodium);
    // A new device: fresh signing key, no sessions or prekeys from the old one.
    this.state.signing = generateSigningKeyPair(this.sodium);
    this.state.ratchet = {};
    const { data, error } = await this.supabase
      .from('devices')
      .insert({ identity_public_key: this.state.identity.publicKey, device_label: (this.opts.deviceLabel ?? 'Bot server').slice(0, 64) })
      .select('id')
      .single();
    if (error || !data) throw new Error(`device registration failed: ${error?.message}`);
    this.state.deviceId = data.id;
    this.saveState();
  }

  private startSessions(): void {
    if (!this.state.signing) {
      this.state.signing = generateSigningKeyPair(this.sodium);
      this.saveState();
    }
    const store = new MemoryRatchetStore(this.state.ratchet ?? {}, (snapshot) => {
      this.state.ratchet = snapshot;
      this.saveState();
    });
    const sessions: SessionManager = new SessionManager({
      sodium: this.sodium,
      local: {
        userId: this.userId,
        deviceId: this.state.deviceId!,
        identity: { pub: this.state.identity!.publicKey, priv: this.state.identity!.secretKey },
        signing: this.state.signing,
      },
      store,
      directory: {
        trusted: async (deviceId) => this.trustedDevice(deviceId),
        pinSigningKey: async (deviceId, userId, signingKey) => {
          const known = this.state.pinned[deviceId];
          if (!known) return;
          if (known.signingKey && known.signingKey !== signingKey) throw new Error(`signing key for ${deviceId} changed`);
          known.signingKey = signingKey;
          this.saveState();
        },
      },
      server: createPreKeyServer(this.supabase),
      hooks: {
        onSessionBroken: (remote, ctx) => this.enqueue(() => this.sendSessionReset(remote, ctx)),
        onPreKeysConsumed: () => this.enqueue(async () => void (await this.sessions.refreshPreKeys())),
        log: (m, d) => this.log(m, d ?? ''),
      },
    });
    this.sessions = sessions;
  }

  private async trustedDevice(deviceId: string): Promise<TrustedDevice | null> {
    const k = await this.senderKey(deviceId);
    return k ? { userId: k.userId, identityKey: k.publicKey, signingKey: k.signingKey ?? null } : null;
  }

  /** Our session with `remote` broke: send it an encrypted reset (new X3DH). */
  private async sendSessionReset(remote: string, ctx: EnvelopeContext): Promise<void> {
    const key = await this.senderKey(remote);
    if (!key || ctx.conversationId.startsWith('story:')) return;
    const id = randomUUID();
    const ciphertext = await this.sessions.encrypt(
      { conversationId: ctx.conversationId, messageId: id, senderDeviceId: this.state.deviceId! },
      sessionResetPlaintext(),
      [{ deviceId: remote, publicKey: key.publicKey }]
    );
    const { error } = await this.supabase.from('messages').insert({
      id,
      conversation_id: ctx.conversationId,
      sender_device_id: this.state.deviceId,
      sender_user_id: this.userId,
      ciphertext,
      message_type: 'reaction',
    });
    if (error) this.log('session reset not sent:', error.message);
  }

  /** Fetches anything newer than our cursor in every conversation the bot is in. */
  private async catchUp(initial: boolean): Promise<void> {
    const { data: memberships, error } = await this.supabase
      .from('conversation_members')
      .select('conversation_id')
      .eq('user_id', this.userId)
      .is('left_at', null);
    if (error) throw error;
    for (const { conversation_id } of memberships ?? []) {
      // A chat we haven't seen yet: answer only the last few minutes, never old history.
      if (!this.state.cursors[conversation_id]) {
        this.state.cursors[conversation_id] = new Date(Date.now() - (initial ? 2 : 10) * 60_000).toISOString();
      }
      const { data: rows } = await this.supabase
        .from('messages')
        .select(COLUMNS)
        .eq('conversation_id', conversation_id)
        .gt('created_at', this.state.cursors[conversation_id])
        .order('created_at', { ascending: true })
        .limit(100);
      for (const row of (rows ?? []) as MessageRow[]) await this.handleRow(row);
    }
    this.saveState();
  }

  private async handleMessageId(id: string): Promise<void> {
    const { data } = await this.supabase.from('messages').select(COLUMNS).eq('id', id).maybeSingle();
    if (data) await this.handleRow(data as MessageRow);
    this.saveState();
  }

  private async handleRow(row: MessageRow): Promise<void> {
    const cursor = this.state.cursors[row.conversation_id];
    if (!cursor || row.created_at > cursor) this.state.cursors[row.conversation_id] = row.created_at;
    if (row.deleted_at || row.sender_user_id === this.userId || this.state.processed.includes(row.id)) return;
    this.state.processed = [...this.state.processed.slice(-499), row.id];

    const senderKey = await this.senderKey(row.sender_device_id);
    if (!senderKey || senderKey.userId !== row.sender_user_id) {
      this.log('skipping message from unknown/changed device', row.sender_device_id);
      return;
    }
    let opened: MessagePayload | null | 'control';
    try {
      opened = await openSessionPayload(
        this.sessions,
        row.ciphertext,
        { conversationId: row.conversation_id, messageId: row.id, senderDeviceId: row.sender_device_id },
        senderKey.publicKey
      );
    } catch (e) {
      if (!(e instanceof NotAddressedToDeviceError)) this.log('could not decrypt', row.id, (e as Error)?.message ?? '');
      return;
    }
    if (opened === 'control') return;
    const payload = opened;
    if (!payload || payload.t === 'reaction' || payload.t === 'timer' || payload.t === 'payment_status') return;

    const message: IncomingMessage = {
      id: row.id,
      conversationId: row.conversation_id,
      senderUserId: row.sender_user_id,
      senderDeviceId: row.sender_device_id,
      createdAt: row.created_at,
      payload,
    };
    if (payload.t === 'text') {
      message.text = payload.body;
      message.command = parseCommand(payload.body, this.username) ?? undefined;
    }
    if (payload.t === 'bot_data') {
      try {
        message.data = JSON.parse(payload.data);
      } catch {
        return;
      }
    }
    const ctx: BotContext = {
      bot: this,
      message,
      reply: (text) => this.sendText(row.conversation_id, text, row.id),
    };

    if (message.data !== undefined) {
      for (const h of this.dataHandlers) await h(ctx);
      return;
    }
    const cmd = message.command && this.commands.get(message.command.command);
    if (cmd) {
      await cmd(ctx);
      return;
    }
    for (const h of this.handlers) await h(ctx);
  }

  private async senderKey(deviceId: string): Promise<PinnedKey | null> {
    const known = this.state.pinned[deviceId];
    if (known) return known;
    const { data, error } = await this.supabase.rpc('get_device_keys', { p_device_ids: [deviceId] });
    if (error || !data?.[0]) return null;
    const k = { userId: data[0].user_id as string, publicKey: data[0].identity_public_key as string };
    this.state.pinned[deviceId] = k;
    return k;
  }

  private async recipients(conversationId: string): Promise<DeviceKeyRef[]> {
    const { data, error } = await this.supabase.rpc('get_conversation_devices', { p_conversation_id: conversationId });
    if (error) throw new Error(`could not load recipients: ${error.message}`);
    const out: DeviceKeyRef[] = [];
    for (const r of (data ?? []) as { device_id: string; user_id: string; identity_public_key: string }[]) {
      const known = this.state.pinned[r.device_id];
      if (known && (known.publicKey !== r.identity_public_key || known.userId !== r.user_id)) {
        throw new Error(`identity key for device ${r.device_id} changed - refusing to send`);
      }
      this.state.pinned[r.device_id] = { userId: r.user_id, publicKey: r.identity_public_key };
      out.push({ deviceId: r.device_id, publicKey: r.identity_public_key });
    }
    return out;
  }
}

/** Reads VERO_SUPABASE_URL / VERO_SUPABASE_ANON_KEY / VERO_BOT_TOKEN / VERO_BOT_STATE from the environment. */
export function botFromEnv(extra: Partial<VeroBotOptions> = {}): VeroBot {
  const env = process.env;
  const supabaseUrl = env.VERO_SUPABASE_URL ?? env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = env.VERO_SUPABASE_ANON_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  const token = env.VERO_BOT_TOKEN ?? '';
  if (!supabaseUrl || !anonKey || !token) {
    throw new Error('Set VERO_SUPABASE_URL, VERO_SUPABASE_ANON_KEY and VERO_BOT_TOKEN (see bots/README.md).');
  }
  return new VeroBot({ supabaseUrl, anonKey, token, stateFile: env.VERO_BOT_STATE, ...extra });
}
