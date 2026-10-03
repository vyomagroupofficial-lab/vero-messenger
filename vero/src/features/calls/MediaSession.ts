/**
 * One WebRTC peer connection for a call (platform independent; the platform
 * specifics live in webrtc.native.ts / webrtc.web.ts).
 *
 * Negotiation follows the W3C "perfect negotiation" pattern so offers from
 * both sides can't deadlock (glare):
 *   - the caller is the *impolite* peer: on an offer collision it ignores the
 *     incoming offer and keeps its own;
 *   - the callee is *polite*: it rolls back its own offer and answers.
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
  SessionDescriptionInit,
  StreamLike,
  TrackLike,
} from './mediaTypes';
import type { CandidatePayload, SdpPayload } from './signalingCrypto';

export type MediaConnectionState = 'connected' | 'interrupted' | 'failed';
export type OutgoingSignal = 'offer' | 'answer' | 'candidates' | 'restart';

export interface MediaSessionOptions {
  adapter: MediaAdapter;
  /** Callee = polite. */
  polite: boolean;
  config: PeerConfig;
  localStream: StreamLike;
  send(type: OutgoingSignal, data: unknown): void;
  onRemoteStream(stream: StreamLike): void;
  onConnectionChange(state: MediaConnectionState): void;
  /** Overridable for tests. */
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

const MAX_ICE_RESTARTS = 3;
const DISCONNECT_GRACE_MS = 3000;
const RESTART_CHECK_MS = 8000;
const CANDIDATE_BATCH_MS = 120;

export class MediaSession {
  private readonly pc: PeerLike;
  private readonly opts: MediaSessionOptions;
  private readonly t: NonNullable<MediaSessionOptions['timers']>;
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

  constructor(opts: MediaSessionOptions) {
    this.opts = opts;
    this.t = opts.timers ?? { setTimeout, clearTimeout };
    this.pc = opts.adapter.createPeer(opts.config, {
      onIceCandidate: (c) => this.onLocalCandidate(c),
      onTrack: (track, streams) => this.onRemoteTrack(track, streams),
      onConnectionStateChange: (s) => {
        if (s === 'failed') this.onIceState('failed');
      },
      onIceConnectionStateChange: (s) => this.onIceState(s),
    });
    for (const track of opts.localStream.getTracks()) this.pc.addTrack(track, opts.localStream);
  }

  get peer(): PeerLike {
    return this.pc;
  }

  get polite(): boolean {
    return this.opts.polite;
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

  /** Re-sends our pending offer (the peer may have missed it). */
  resendOffer(): boolean {
    const local = this.pc.localDescription;
    if (this.pc.signalingState === 'have-local-offer' && local?.sdp) {
      this.opts.send('offer', { type: 'offer', sdp: local.sdp });
      return true;
    }
    return false;
  }

  hasRemoteDescription(): boolean {
    return !!this.pc.remoteDescription;
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

  private onIceState(state: string) {
    if (this.closed) return;
    if (state === 'connected' || state === 'completed') {
      this.clearTimer('disconnectTimer');
      this.clearTimer('restartCheckTimer');
      this.restartAttempts = 0;
      this.everConnected = true;
      this.opts.onConnectionChange('connected');
    } else if (state === 'disconnected') {
      this.opts.onConnectionChange('interrupted');
      // "disconnected" often heals by itself within a second or two.
      if (!this.disconnectTimer) {
        this.disconnectTimer = this.t.setTimeout(() => {
          this.disconnectTimer = null;
          const s = this.pc.iceConnectionState;
          if (s === 'disconnected' || s === 'failed') this.restartIce();
        }, DISCONNECT_GRACE_MS);
      }
    } else if (state === 'failed') {
      if (this.everConnected) this.opts.onConnectionChange('interrupted');
      this.restartIce();
    }
  }

  /** Begins an ICE restart (impolite peer) or asks the peer for one (polite). */
  restartIce(): void {
    if (this.closed || this.restartCheckTimer) return;
    if (this.restartAttempts >= MAX_ICE_RESTARTS) {
      this.opts.onConnectionChange('failed');
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
    if (this.closed) return;
    if (this.opts.polite) {
      // Shouldn't happen; restarting from both sides would collide.
      return;
    }
    void this.negotiate(true);
  }

  // ── Tracks ────────────────────────────────────────────────────────────────

  private onRemoteTrack(track: TrackLike, streams: StreamLike[]) {
    const stream = streams[0] ?? this.remoteStream;
    if (!stream) return;
    if (!stream.getTracks().some((t) => t.id === track.id)) stream.addTrack(track);
    this.remoteStream = stream;
    this.opts.onRemoteStream(stream);
  }

  /** Adds a new local track (voice -> video upgrade) and renegotiates. */
  async addLocalTrack(track: TrackLike): Promise<void> {
    this.opts.localStream.addTrack(track);
    this.pc.addTrack(track, this.opts.localStream);
    await this.negotiate(false);
  }

  getRemoteStream(): StreamLike | null {
    return this.remoteStream;
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
