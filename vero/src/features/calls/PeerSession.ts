/**
 * One WebRTC peer connection to ONE remote device (platform independent; the
 * platform specifics live in webrtc.native.ts / webrtc.web.ts). PeerMesh
 * keeps one of these per remote device in a call.
 *
 * Negotiation follows the W3C "perfect negotiation" pattern so offers from
 * both sides can't deadlock (glare). Which side is polite is decided by the
 * mesh from the two device ids, so both ends always agree:
 *   - impolite: on an offer collision it ignores the incoming offer;
 *   - polite: it rolls back its own offer and answers.
 * ICE restarts are driven by the impolite peer; the polite one asks for one
 * with a `restart` signal, which avoids most collisions in the first place.
 *
 * All SDP / candidates leave through `send`, which seals them end-to-end
 * (see signalingCrypto.ts) before they touch the network.
 */

import type {
  IceCandidateInit,
  MediaAdapter,
  PeerConfig,
  PeerLike,
  SenderLike,
  SessionDescriptionInit,
  StatsReportLike,
  StreamLike,
  TrackLike,
} from './mediaTypes';
import type { CandidatePayload, SdpPayload } from './signalingCrypto';

export type PeerConnectionState = 'connecting' | 'connected' | 'interrupted' | 'failed';
export type OutgoingSignal = 'offer' | 'answer' | 'candidates' | 'restart';
export type MediaKind = 'audio' | 'video';

export interface PeerSessionOptions {
  adapter: MediaAdapter;
  remoteDeviceId: string;
  polite: boolean;
  config: PeerConfig;
  /** Stream our tracks are announced in (one per call, so the remote groups them). */
  localStream: StreamLike;
  tracks: { audio: TrackLike | null; video: TrackLike | null };
  send(type: OutgoingSignal, data: unknown): void;
  onRemoteStream(stream: StreamLike): void;
  onConnectionChange(state: PeerConnectionState): void;
  /** Overridable for tests. */
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export const MAX_ICE_RESTARTS = 3;
const DISCONNECT_GRACE_MS = 3000;
const RESTART_CHECK_MS = 8000;
const CANDIDATE_BATCH_MS = 120;

/** Highest audio level (0..1) in a stats report: inbound = what we hear from the peer. */
export function audioLevelFromStats(report: StatsReportLike, direction: 'inbound' | 'outbound'): number {
  let level = 0;
  report.forEach((s: any) => {
    if (!s || typeof s.audioLevel !== 'number') return;
    const isAudio = s.kind === 'audio' || s.mediaType === 'audio';
    const match =
      direction === 'inbound'
        ? (s.type === 'inbound-rtp' && isAudio) || (s.type === 'track' && s.remoteSource === true && isAudio)
        : (s.type === 'media-source' && isAudio) || (s.type === 'track' && s.remoteSource === false && isAudio);
    if (match) level = Math.max(level, Math.min(1, Math.max(0, s.audioLevel)));
  });
  return level;
}

export class PeerSession {
  readonly remoteDeviceId: string;
  private readonly pc: PeerLike;
  private readonly opts: PeerSessionOptions;
  private readonly t: NonNullable<PeerSessionOptions['timers']>;
  private readonly senders = new Map<MediaKind, SenderLike>();
  private makingOffer = false;
  private ignoreOffer = false;
  private renegotiatePending = false;
  private restartPending = false;
  private pendingRemoteCandidates: IceCandidateInit[] = [];
  private outgoingCandidates: IceCandidateInit[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private restartCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempts = 0;
  private everConnected = false;
  private remoteStream: StreamLike | null = null;
  private closed = false;
  private state: PeerConnectionState = 'connecting';

  constructor(opts: PeerSessionOptions) {
    this.opts = opts;
    this.remoteDeviceId = opts.remoteDeviceId;
    // Wrapped: browsers throw "Illegal invocation" if the globals are called with another `this`.
    this.t = opts.timers ?? {
      setTimeout: ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout,
      clearTimeout: ((id: ReturnType<typeof setTimeout>) => clearTimeout(id)) as typeof clearTimeout,
    };
    this.pc = opts.adapter.createPeer(opts.config, {
      onIceCandidate: (c) => this.onLocalCandidate(c),
      onTrack: (track, streams) => this.onRemoteTrack(track, streams),
      onConnectionStateChange: (s) => {
        if (s === 'failed') this.onIceState('failed');
      },
      onIceConnectionStateChange: (s) => this.onIceState(s),
    });
    for (const kind of ['audio', 'video'] as const) {
      const track = opts.tracks[kind];
      if (track) this.senders.set(kind, this.pc.addTrack(track, opts.localStream));
    }
  }

  get peer(): PeerLike {
    return this.pc;
  }

  get polite(): boolean {
    return this.opts.polite;
  }

  get connectionState(): PeerConnectionState {
    return this.state;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ── Offers / answers ──────────────────────────────────────────────────────

  /** Creates and sends an offer (initial, renegotiation or ICE restart). */
  async negotiate(iceRestart = false): Promise<void> {
    if (this.closed) return;
    if (this.makingOffer || this.pc.signalingState !== 'stable') {
      // Try again once the current exchange completes.
      if (iceRestart) this.restartPending = true;
      else this.renegotiatePending = true;
      return;
    }
    this.makingOffer = true;
    try {
      const offer = await this.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (this.closed || this.pc.signalingState !== 'stable') return; // an offer arrived meanwhile
      await this.pc.setLocalDescription(offer);
      this.opts.send('offer', { type: 'offer', sdp: offer.sdp ?? this.pc.localDescription?.sdp });
    } finally {
      this.makingOffer = false;
    }
  }

  async handleOffer(desc: SdpPayload): Promise<void> {
    if (this.closed) return;
    const pc = this.pc;
    // Duplicate of an offer we already answered: answer again.
    if (pc.signalingState === 'stable' && pc.remoteDescription?.sdp === desc.sdp && pc.localDescription?.type === 'answer') {
      this.opts.send('answer', { type: 'answer', sdp: pc.localDescription.sdp });
      return;
    }
    const collision = this.makingOffer || pc.signalingState !== 'stable';
    this.ignoreOffer = !this.opts.polite && collision;
    if (this.ignoreOffer) return;

    if (collision) {
      try {
        await pc.setLocalDescription({ type: 'rollback' });
      } catch {
        // Some stacks roll back implicitly in setRemoteDescription.
      }
      this.renegotiatePending = true; // our own change still needs to go out
    }
    await pc.setRemoteDescription(desc as SessionDescriptionInit);
    await this.flushRemoteCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.opts.send('answer', { type: 'answer', sdp: answer.sdp ?? pc.localDescription?.sdp });
    this.afterStable();
  }

  async handleAnswer(desc: SdpPayload): Promise<void> {
    if (this.closed || this.pc.signalingState !== 'have-local-offer') return; // stale or duplicate
    await this.pc.setRemoteDescription(desc as SessionDescriptionInit);
    await this.flushRemoteCandidates();
    this.afterStable();
  }

  private afterStable() {
    if (this.restartPending) {
      this.restartPending = false;
      this.renegotiatePending = false; // an ICE-restart offer carries every change too
      void this.negotiate(true);
    } else if (this.renegotiatePending) {
      this.renegotiatePending = false;
      void this.negotiate(false);
    }
  }

  // ── ICE candidates ────────────────────────────────────────────────────────

  private onLocalCandidate(candidate: IceCandidateInit | null) {
    if (!candidate || !candidate.candidate || this.closed) return;
    this.outgoingCandidates.push({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    });
    // Batch trickled candidates to keep the number of broadcasts low.
    if (!this.flushTimer) {
      this.flushTimer = this.t.setTimeout(() => {
        this.flushTimer = null;
        const batch = this.outgoingCandidates.splice(0);
        if (batch.length && !this.closed) this.opts.send('candidates', { candidates: batch });
      }, CANDIDATE_BATCH_MS);
    }
  }

  async addRemoteCandidates(list: CandidatePayload[]): Promise<void> {
    for (const c of list) {
      if (this.closed) return;
      if (!this.pc.remoteDescription) {
        this.pendingRemoteCandidates.push(c);
        continue;
      }
      try {
        await this.pc.addIceCandidate(c);
      } catch (e) {
        if (!this.ignoreOffer) console.info('[Calls] ignored ICE candidate:', (e as Error)?.message);
      }
    }
  }

  private async flushRemoteCandidates() {
    const queued = this.pendingRemoteCandidates.splice(0);
    if (queued.length) await this.addRemoteCandidates(queued);
  }

  // ── Connection monitoring / ICE restart ───────────────────────────────────

  private setState(state: PeerConnectionState) {
    if (this.state === state || this.closed) return;
    this.state = state;
    this.opts.onConnectionChange(state);
  }

  private onIceState(state: string) {
    if (this.closed) return;
    if (state === 'connected' || state === 'completed') {
      this.clearTimer('disconnectTimer');
      this.clearTimer('restartCheckTimer');
      this.restartAttempts = 0;
      this.everConnected = true;
      this.setState('connected');
    } else if (state === 'disconnected') {
      if (this.everConnected) this.setState('interrupted');
      // "disconnected" often heals by itself within a second or two.
      if (!this.disconnectTimer) {
        this.disconnectTimer = this.t.setTimeout(() => {
          this.disconnectTimer = null;
          const s = this.pc.iceConnectionState;
          if (s === 'disconnected' || s === 'failed') this.restartIce();
        }, DISCONNECT_GRACE_MS);
      }
    } else if (state === 'failed') {
      if (this.everConnected) this.setState('interrupted');
      this.restartIce();
    }
  }

  /** Begins an ICE restart (impolite peer) or asks the peer for one (polite). */
  restartIce(): void {
    if (this.closed || this.restartCheckTimer) return;
    if (this.restartAttempts >= MAX_ICE_RESTARTS) {
      this.setState('failed');
      return;
    }
    this.restartAttempts++;
    if (this.opts.polite) this.opts.send('restart', {});
    else void this.negotiate(true);
    this.restartCheckTimer = this.t.setTimeout(() => {
      this.restartCheckTimer = null;
      const s = this.pc.iceConnectionState;
      if (s !== 'connected' && s !== 'completed') this.restartIce();
    }, RESTART_CHECK_MS);
  }

  /** The polite peer asked us (impolite) to restart ICE. */
  onRestartRequested(): void {
    if (this.closed || this.opts.polite) return; // restarting from both sides would collide
    void this.negotiate(true);
  }

  // ── Tracks ────────────────────────────────────────────────────────────────

  private onRemoteTrack(track: TrackLike, streams: StreamLike[]) {
    let stream = streams[0] ?? this.remoteStream;
    if (!stream) stream = this.opts.adapter.createStream([track]);
    if (!stream.getTracks().some((t) => t.id === track.id)) stream.addTrack(track);
    this.remoteStream = stream;
    this.opts.onRemoteStream(stream);
  }

  /**
   * Sends `track` as our audio / video (null stops sending, e.g. camera off).
   * Swapping tracks (camera <-> screen, front <-> back) uses replaceTrack and
   * needs no renegotiation; the first video track in a voice call adds a
   * transceiver and renegotiates.
   */
  async setTrack(kind: MediaKind, track: TrackLike | null): Promise<void> {
    if (this.closed) return;
    const sender = this.senders.get(kind);
    if (sender) {
      if (sender.track !== track) await sender.replaceTrack(track);
      return;
    }
    if (!track) return;
    this.senders.set(kind, this.pc.addTrack(track, this.opts.localStream));
    await this.negotiate(false);
  }

  getRemoteStream(): StreamLike | null {
    return this.remoteStream;
  }

  /** Audio level (0..1) of what we receive from this peer. */
  async getRemoteAudioLevel(): Promise<number> {
    if (this.closed) return 0;
    try {
      return audioLevelFromStats(await this.pc.getStats(), 'inbound');
    } catch {
      return 0;
    }
  }

  /** Audio level (0..1) of our own microphone as sent to this peer. */
  async getLocalAudioLevel(): Promise<number> {
    if (this.closed) return 0;
    try {
      return audioLevelFromStats(await this.pc.getStats(), 'outbound');
    } catch {
      return 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const name of ['flushTimer', 'disconnectTimer', 'restartCheckTimer'] as const) this.clearTimer(name);
    try {
      this.pc.close();
    } catch {
      // already closed
    }
  }

  private clearTimer(name: 'flushTimer' | 'disconnectTimer' | 'restartCheckTimer') {
    const timer = this[name];
    if (timer) this.t.clearTimeout(timer);
    this[name] = null;
  }
}
