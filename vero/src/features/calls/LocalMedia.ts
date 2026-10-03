/**
 * This device's microphone, camera and screen for one call. Every change of
 * what we send goes through `onSendTrack`, which PeerMesh applies to every
 * peer connection (replaceTrack, or addTrack + renegotiation the first time a
 * voice call gets video).
 *
 * Camera off really releases the camera (the track is stopped, the privacy
 * light goes out) instead of sending black frames.
 */

import type { CameraFacing, MediaAdapter, StreamLike, TrackLike } from './mediaTypes';

export interface LocalMediaState {
  micMuted: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  facing: CameraFacing;
}

export interface LocalMediaOptions {
  adapter: MediaAdapter;
  onSendTrack(kind: 'audio' | 'video', track: TrackLike | null): Promise<void>;
  onChange(): void;
}

export class LocalMedia {
  private readonly opts: LocalMediaOptions;
  private audioTrack: TrackLike | null = null;
  private cameraTrack: TrackLike | null = null;
  private screenTrack: TrackLike | null = null;
  private callStream: StreamLike | null = null;
  private onScreenEnded: (() => void) | null = null;
  private busy = false;
  private stopped = false;
  state: LocalMediaState = { micMuted: false, cameraOn: false, screenSharing: false, facing: 'user' };

  constructor(opts: LocalMediaOptions) {
    this.opts = opts;
  }

  /** Opens the microphone (and camera for video calls). Throws a user-facing error. */
  async start(video: boolean): Promise<void> {
    const stream = await this.opts.adapter.getUserMedia({ audio: true, video, facing: this.state.facing });
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.audioTrack = stream.getAudioTracks()[0] ?? null;
    this.cameraTrack = video ? stream.getVideoTracks()[0] ?? null : null;
    // Stream that groups our tracks for the peers (and the local preview).
    this.callStream = stream;
    this.state = { ...this.state, cameraOn: !!this.cameraTrack };
    this.opts.onChange();
  }

  get started(): boolean {
    return !!this.callStream;
  }

  /** Stream announced to peers; also the local preview (camera or screen). */
  get stream(): StreamLike | null {
    return this.callStream;
  }

  /** What we currently send as video. */
  get videoTrack(): TrackLike | null {
    return this.screenTrack ?? (this.state.cameraOn ? this.cameraTrack : null);
  }

  get tracks(): { audio: TrackLike | null; video: TrackLike | null } {
    return { audio: this.audioTrack, video: this.videoTrack };
  }

  setMicMuted(muted: boolean): void {
    if (this.audioTrack) this.audioTrack.enabled = !muted;
    this.state = { ...this.state, micMuted: muted };
    this.opts.onChange();
  }

  private swapStreamVideo(next: TrackLike | null) {
    const stream = this.callStream;
    if (!stream) return;
    for (const t of stream.getVideoTracks()) if (t !== next) stream.removeTrack(t);
    if (next && !stream.getVideoTracks().includes(next)) stream.addTrack(next);
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (this.busy || this.stopped) return undefined;
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  async setCameraOn(on: boolean): Promise<void> {
    await this.exclusive(async () => {
      if (on === this.state.cameraOn) return;
      if (on) {
        const stream = await this.opts.adapter.getUserMedia({ audio: false, video: true, facing: this.state.facing });
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('Camera unavailable');
        if (this.stopped) {
          track.stop();
          return;
        }
        this.cameraTrack = track;
        this.state = { ...this.state, cameraOn: true };
        if (!this.screenTrack) {
          this.swapStreamVideo(track);
          await this.opts.onSendTrack('video', track);
        }
      } else {
        const old = this.cameraTrack;
        this.cameraTrack = null;
        this.state = { ...this.state, cameraOn: false };
        if (!this.screenTrack) {
          this.swapStreamVideo(null);
          await this.opts.onSendTrack('video', null);
        }
        old?.stop();
      }
      this.opts.onChange();
    });
  }

  async flipCamera(): Promise<void> {
    await this.exclusive(async () => {
      const cam = this.cameraTrack;
      if (!cam || !this.state.cameraOn) return;
      const { facing, replacement } = await this.opts.adapter.switchCamera(cam, this.state.facing);
      if (replacement) {
        this.cameraTrack = replacement;
        if (!this.screenTrack) {
          this.swapStreamVideo(replacement);
          await this.opts.onSendTrack('video', replacement);
        }
        cam.stop();
      }
      this.state = { ...this.state, facing };
      this.opts.onChange();
    });
  }

  async startScreenShare(): Promise<void> {
    await this.exclusive(async () => {
      if (this.screenTrack) return;
      const stream = await this.opts.adapter.getDisplayMedia();
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('Nothing to share');
      if (this.stopped) {
        track.stop();
        return;
      }
      this.screenTrack = track;
      // The browser's / system's own "Stop sharing" button ends the track.
      this.onScreenEnded = () => void this.stopScreenShare();
      track.addEventListener?.('ended', this.onScreenEnded);
      this.state = { ...this.state, screenSharing: true };
      this.swapStreamVideo(track);
      await this.opts.onSendTrack('video', track);
      this.opts.onChange();
    });
  }

  async stopScreenShare(): Promise<void> {
    const track = this.screenTrack;
    if (!track) return;
    this.screenTrack = null;
    if (this.onScreenEnded) track.removeEventListener?.('ended', this.onScreenEnded);
    this.onScreenEnded = null;
    this.state = { ...this.state, screenSharing: false };
    const camera = this.state.cameraOn ? this.cameraTrack : null;
    this.swapStreamVideo(camera);
    if (!this.stopped) await this.opts.onSendTrack('video', camera);
    track.stop();
    this.opts.onChange();
  }

  stop(): void {
    this.stopped = true;
    for (const t of [this.audioTrack, this.cameraTrack, this.screenTrack]) {
      try {
        t?.stop();
      } catch {
        // already stopped
      }
    }
    this.callStream?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // already stopped
      }
    });
    this.audioTrack = this.cameraTrack = this.screenTrack = null;
    this.callStream = null;
  }
}
