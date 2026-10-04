/**
 * Media + signalling for ONE call on this device:
 *   - the private realtime topic `call:<id>` (authorised in 001 / 002),
 *   - end-to-end sealed signalling (signalingCrypto.ts) using this device's
 *     identity key and the peers' pinned keys from KeyDirectory,
 *   - the PeerMesh (one RTCPeerConnection per remote device),
 *   - audio-level polling for the active-speaker highlight.
 *
 * Call lifecycle (ringing, statuses, history) lives in CallService.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../../core/network/supabase';
import { privateChannel } from '../../core/network/realtime';
import { cryptoManager } from '../../core/crypto/CryptoManager';
import { keyDirectory } from '../keys/KeyDirectory';
import { generateUUID } from '../../shared/utils/uuid';
import { getPeerConfig } from './iceServers';
import type { LocalMedia } from './LocalMedia';
import type { MediaAdapter } from './mediaTypes';
import { PeerMesh, type MeshSignal } from './PeerMesh';
import type { PeerConnectionState } from './PeerSession';
import {
  createSignalCodec,
  SignalAuthError,
  type OpenedSignal,
  type PeerIdentity,
  type SignalCodec,
} from './signalingCrypto';

const LEVEL_POLL_MS = 500;
const SUBSCRIBE_TIMEOUT_MS = 10_000;

export interface CallEngineCallbacks {
  /** `call.status` broadcast on call:<id> (untrusted shape; validate). */
  onStatus(payload: any): void;
  /** `call.participant` broadcast on call:<id>. */
  onParticipant(payload: any): void;
  /** A callee device says it is ringing (authenticated). */
  onRinging(from: PeerIdentity): void;
  /** A device said goodbye (authenticated). */
  onBye(from: PeerIdentity): void;
  /** May this (authenticated) device connect to us? Consulted for new devices. */
  admitPeer(deviceId: string, userId: string): Promise<boolean>;
  /** An admitted device sent its first offer. */
  onPeerAdmitted(deviceId: string, userId: string): void;
  onPeerState(deviceId: string, state: PeerConnectionState): void;
  /** Peers / streams changed: re-render. */
  onChange(): void;
  /** Audio levels by device id, plus 'local'. */
  onLevels(levels: Record<string, number>): void;
}

export class CallEngine {
  readonly callId: string;
  private readonly me: { userId: string; deviceId: string };
  private readonly adapter: MediaAdapter;
  private readonly cb: CallEngineCallbacks;
  private readonly maxPeers: number;
  private readonly codec: SignalCodec;
  private readonly keys = new Map<string, PeerIdentity | null>();
  private channel: RealtimeChannel | null = null;
  private sendQueue: Promise<void> = Promise.resolve();
  private recvQueue: Promise<void> = Promise.resolve();
  private buffered: OpenedSignal[] = [];
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private local: LocalMedia | null = null;
  mesh: PeerMesh | null = null;
  private closed = false;

  constructor(params: {
    callId: string;
    me: { userId: string; deviceId: string };
    adapter: MediaAdapter;
    maxPeers: number;
    callbacks: CallEngineCallbacks;
  }) {
    this.callId = params.callId;
    this.me = params.me;
    this.adapter = params.adapter;
    this.cb = params.callbacks;
    this.maxPeers = params.maxPeers;
    this.codec = createSignalCodec({
      callId: params.callId,
      myDeviceId: params.me.deviceId,
      sessionId: generateUUID(),
      withSecretKey: (fn) => cryptoManager.withIdentitySecretKey(params.me.userId, fn),
      resolveDevice: (deviceId) => this.resolveDevice(deviceId),
    });
  }

  /** Pinned key of a device (TOFU via KeyDirectory); revoked devices are refused. */
  private async resolveDevice(deviceId: string): Promise<PeerIdentity | null> {
    if (this.keys.has(deviceId)) return this.keys.get(deviceId) ?? null;
    let identity: PeerIdentity | null = null;
    try {
      const k = (await keyDirectory.getKeys([deviceId])).get(deviceId);
      if (k && !k.revokedAt) identity = { deviceId: k.deviceId, userId: k.userId, publicKey: k.publicKey };
    } catch {
      return null; // network error: don't cache
    }
    this.keys.set(deviceId, identity);
    return identity;
  }

  /** Joins call:<id>. Resolves once subscribed (or after a timeout; sends then fall back to REST). */
  open(): Promise<void> {
    if (this.channel) return Promise.resolve();
    const channel = privateChannel(`call:${this.callId}`);
    channel
      .on('broadcast', { event: 'signal' }, ({ payload }) => this.receive(payload))
      .on('broadcast', { event: 'call.status' }, ({ payload }) => {
        if (!this.closed) this.cb.onStatus(payload);
      })
      .on('broadcast', { event: 'call.participant' }, ({ payload }) => {
        if (!this.closed) this.cb.onParticipant(payload);
      });
    this.channel = channel;
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, SUBSCRIBE_TIMEOUT_MS);
      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[Calls] call channel', status, err?.message);
        }
      });
    });
  }

  /** Builds the peer mesh around this device's local media. */
  async startMedia(local: LocalMedia): Promise<void> {
    if (this.mesh || this.closed) return;
    this.local = local;
    const config = await getPeerConfig();
    if (this.closed || !local.stream) return;
    this.mesh = new PeerMesh({
      myDeviceId: this.me.deviceId,
      adapter: this.adapter,
      config,
      localStream: local.stream,
      maxPeers: this.maxPeers,
      getTracks: () => local.tracks,
      send: (to, type, data) => this.send(to, type, data),
      onChange: () => this.cb.onChange(),
      onPeerState: (deviceId, state) => this.cb.onPeerState(deviceId, state),
    });
    const pending = this.buffered.splice(0);
    for (const s of pending) this.dispatch(s);
    this.levelTimer = setInterval(() => void this.pollLevels(), LEVEL_POLL_MS);
  }

  connect(deviceId: string, userId: string, initiator: boolean): void {
    this.mesh?.connect(deviceId, userId, initiator);
  }

  removePeer(deviceId: string): void {
    this.mesh?.remove(deviceId);
  }

  sendRinging(toDeviceId: string): void {
    this.send(toDeviceId, 'ringing', {});
  }

  /** Seals and broadcasts, strictly in call order (an offer never trails its candidates). */
  private send(toDeviceId: string, type: MeshSignal | 'ringing', data: unknown): void {
    if (this.closed && type !== 'bye') return;
    this.sendQueue = this.sendQueue.then(async () => {
      const channel = this.channel;
      if (!channel) return;
      try {
        const sealed = await this.codec.seal(toDeviceId, type, data);
        await channel.send({ type: 'broadcast', event: 'signal', payload: sealed });
      } catch (e) {
        console.info('[Calls] could not send signal:', (e as Error)?.message);
      }
    });
  }

  private receive(raw: unknown): void {
    if (this.closed) return;
    // Decrypt in arrival order; per-device processing order is kept by the mesh.
    this.recvQueue = this.recvQueue.then(async () => {
      let opened: OpenedSignal | null;
      try {
        opened = await this.codec.open(raw);
      } catch (e) {
        if (e instanceof SignalAuthError) console.warn('[Calls] rejected signal:', e.message);
        return;
      }
      if (opened && !this.closed) this.dispatch(opened);
    });
  }

  private dispatch(s: OpenedSignal): void {
    const { from, message } = s;
    if (message.type === 'ringing') {
      this.cb.onRinging(from);
      return;
    }
    if (message.type === 'bye') {
      this.mesh?.remove(from.deviceId);
      this.cb.onBye(from);
      return;
    }
    if (!this.mesh) {
      // Media not started yet (e.g. still ringing): keep for later, bounded.
      if (this.buffered.length < 200) this.buffered.push(s);
      return;
    }
    const isNew = !this.mesh.has(from.deviceId);
    void this.mesh
      .handleSignal(from, message, () => this.cb.admitPeer(from.deviceId, from.userId))
      .then((result) => {
        if (isNew && message.type === 'offer' && result === 'handled') this.cb.onPeerAdmitted(from.deviceId, from.userId);
        if (result === 'rejected') console.warn('[Calls] refused signalling from device', from.deviceId);
      })
      .catch(() => {});
  }

  private async pollLevels(): Promise<void> {
    const mesh = this.mesh;
    if (!mesh || this.closed || mesh.size === 0) return;
    const remote = await mesh.remoteAudioLevels();
    const levels: Record<string, number> = {};
    remote.forEach((v, k) => (levels[k] = v));
    levels.local = this.local?.state.micMuted ? 0 : await mesh.localAudioLevel();
    if (!this.closed) this.cb.onLevels(levels);
  }

  /** Leaves the call topic and closes every peer connection (saying bye first). */
  close(sayBye: boolean): void {
    if (this.closed) return;
    this.mesh?.closeAll(sayBye);
    this.closed = true;
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.buffered = [];
    // Let queued "bye"s go out before leaving the topic.
    const channel = this.channel;
    void this.sendQueue.then(() => {
      this.channel = null;
      if (channel) void supabase.removeChannel(channel);
    });
  }
}
