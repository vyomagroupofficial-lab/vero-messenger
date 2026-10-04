/**
 * Full-mesh peer layer: one PeerSession (RTCPeerConnection) per remote
 * DEVICE in the call. Used for 1:1 calls (one peer) and group calls (up to 7
 * peers). Platform independent and unit-tested with a fake adapter
 * (tests/callMesh.test.ts).
 *
 * Who offers first: the device that joins later calls connect(initiator) for
 * everyone already in the call; existing devices create their side lazily
 * when the (authenticated) offer arrives. If both sides start at once,
 * perfect negotiation inside PeerSession resolves the glare; politeness is
 * derived from the two device ids so both ends agree without coordination.
 *
 * Signals for one device are processed strictly in order (a per-device
 * queue), so candidates never overtake the offer they belong to.
 */

import type { MediaAdapter, PeerConfig, StreamLike, TrackLike } from './mediaTypes';
import { PeerSession, type MediaKind, type OutgoingSignal, type PeerConnectionState } from './PeerSession';
import { parseCandidates, parseSdpPayload, type SignalMessage } from './signalingCrypto';

export type MeshSignal = OutgoingSignal | 'bye';

export interface MeshPeerView {
  deviceId: string;
  userId: string;
  stream: StreamLike | null;
  state: PeerConnectionState;
}

export interface PeerMeshOptions {
  myDeviceId: string;
  adapter: MediaAdapter;
  config: PeerConfig;
  localStream: StreamLike;
  /** Most remote devices this device connects to (group calls: 7 = 8 people). */
  maxPeers: number;
  /** The tracks a new connection should send right away. */
  getTracks(): { audio: TrackLike | null; video: TrackLike | null };
  send(toDeviceId: string, type: MeshSignal, data: unknown): void;
  onChange(): void;
  onPeerState?(deviceId: string, state: PeerConnectionState): void;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export type ConnectResult = 'started' | 'exists' | 'full' | 'self';
export type SignalResult = 'handled' | 'ignored' | 'rejected';

/** Deterministic politeness: both ends compute opposite answers. */
export function isPolite(myDeviceId: string, remoteDeviceId: string): boolean {
  return myDeviceId > remoteDeviceId;
}

interface MeshPeer {
  userId: string;
  session: PeerSession;
  stream: StreamLike | null;
}

export class PeerMesh {
  private readonly opts: PeerMeshOptions;
  private readonly peers = new Map<string, MeshPeer>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private config: PeerConfig;
  private closed = false;

  constructor(opts: PeerMeshOptions) {
    this.opts = opts;
    this.config = opts.config;
  }

  setConfig(config: PeerConfig): void {
    this.config = config;
  }

  get size(): number {
    return this.peers.size;
  }

  has(deviceId: string): boolean {
    return this.peers.has(deviceId);
  }

  session(deviceId: string): PeerSession | null {
    return this.peers.get(deviceId)?.session ?? null;
  }

  list(): MeshPeerView[] {
    return [...this.peers.entries()].map(([deviceId, p]) => ({
      deviceId,
      userId: p.userId,
      stream: p.stream,
      state: p.session.connectionState,
    }));
  }

  /** Opens a connection to a device (offering first when `initiator`). */
  connect(deviceId: string, userId: string, initiator: boolean): ConnectResult {
    if (this.closed) return 'full';
    if (deviceId === this.opts.myDeviceId) return 'self';
    if (this.peers.has(deviceId)) return 'exists';
    if (this.peers.size >= this.opts.maxPeers) return 'full';
    const session = this.create(deviceId, userId);
    if (initiator) void this.enqueue(deviceId, () => session.negotiate(false));
    return 'started';
  }

  private create(deviceId: string, userId: string): PeerSession {
    const session = new PeerSession({
      adapter: this.opts.adapter,
      remoteDeviceId: deviceId,
      polite: isPolite(this.opts.myDeviceId, deviceId),
      config: this.config,
      localStream: this.opts.localStream,
      tracks: this.opts.getTracks(),
      send: (type, data) => this.opts.send(deviceId, type, data),
      onRemoteStream: (stream) => {
        const p = this.peers.get(deviceId);
        if (!p || p.session !== session) return;
        p.stream = stream;
        this.opts.onChange();
      },
      onConnectionChange: (state) => {
        const p = this.peers.get(deviceId);
        if (!p || p.session !== session) return;
        this.opts.onPeerState?.(deviceId, state);
        this.opts.onChange();
      },
      timers: this.opts.timers,
    });
    this.peers.set(deviceId, { userId, session, stream: null });
    this.opts.onChange();
    return session;
  }

  /**
   * Handles an authenticated signal from `from`. `admit` decides whether a
   * device we don't have a connection with yet may join (it's a call
   * participant); it's only consulted for offers.
   */
  handleSignal(
    from: { deviceId: string; userId: string },
    message: SignalMessage,
    admit: () => boolean | Promise<boolean>
  ): Promise<SignalResult> {
    return this.enqueue(from.deviceId, () => this.process(from, message, admit));
  }

  private async process(
    from: { deviceId: string; userId: string },
    message: SignalMessage,
    admit: () => boolean | Promise<boolean>
  ): Promise<SignalResult> {
    if (this.closed || from.deviceId === this.opts.myDeviceId) return 'ignored';
    let peer = this.peers.get(from.deviceId);
    if (peer && peer.userId !== from.userId) return 'rejected';

    switch (message.type) {
      case 'offer': {
        const offer = parseSdpPayload(message.data, 'offer');
        if (!offer) return 'rejected';
        if (!peer) {
          if (this.peers.size >= this.opts.maxPeers) return 'rejected';
          if (!(await admit()) || this.closed) return 'rejected';
          if (this.peers.has(from.deviceId)) {
            peer = this.peers.get(from.deviceId)!; // created while we awaited admit()
          } else {
            this.create(from.deviceId, from.userId);
            peer = this.peers.get(from.deviceId)!;
          }
        }
        await peer.session.handleOffer(offer);
        return 'handled';
      }
      case 'answer': {
        const answer = parseSdpPayload(message.data, 'answer');
        if (!peer || !answer) return 'ignored';
        await peer.session.handleAnswer(answer);
        return 'handled';
      }
      case 'candidates': {
        if (!peer) return 'ignored';
        await peer.session.addRemoteCandidates(parseCandidates(message.data));
        return 'handled';
      }
      case 'restart': {
        if (!peer) return 'ignored';
        peer.session.onRestartRequested();
        return 'handled';
      }
      case 'bye': {
        if (!peer) return 'ignored';
        this.remove(from.deviceId);
        return 'handled';
      }
      default:
        return 'ignored';
    }
  }

  private enqueue<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(deviceId) ?? Promise.resolve();
    const next = prev.then(task, task);
    const settled = next.then(
      () => undefined,
      (e) => console.info('[Calls] signal handling failed:', (e as Error)?.message)
    );
    this.queues.set(deviceId, settled);
    void settled.then(() => {
      if (this.queues.get(deviceId) === settled) this.queues.delete(deviceId);
    });
    return next;
  }

  /** Closes the connection to one device (it left / was removed). */
  remove(deviceId: string, sayBye = false): void {
    const peer = this.peers.get(deviceId);
    if (!peer) return;
    if (sayBye) this.opts.send(deviceId, 'bye', {});
    peer.session.close();
    this.peers.delete(deviceId);
    this.opts.onChange();
  }

  /** Sends `track` as our audio/video on every connection. */
  async setTrack(kind: MediaKind, track: TrackLike | null): Promise<void> {
    await Promise.all([...this.peers.values()].map((p) => p.session.setTrack(kind, track).catch(() => {})));
  }

  /** Audio level (0..1) received from each device. */
  async remoteAudioLevels(): Promise<Map<string, number>> {
    const entries = await Promise.all(
      [...this.peers.entries()].map(async ([id, p]) => [id, await p.session.getRemoteAudioLevel()] as const)
    );
    return new Map(entries);
  }

  /** Our microphone level, measured on any connected peer. */
  async localAudioLevel(): Promise<number> {
    for (const p of this.peers.values()) {
      if (p.session.connectionState === 'connected') return p.session.getLocalAudioLevel();
    }
    return 0;
  }

  closeAll(sayBye: boolean): void {
    if (this.closed) return;
    for (const id of [...this.peers.keys()]) this.remove(id, sayBye);
    this.closed = true;
  }
}
