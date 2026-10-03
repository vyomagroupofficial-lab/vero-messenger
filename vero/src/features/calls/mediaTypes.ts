/**
 * Minimal structural types shared by the WebRTC platform adapters
 * (webrtc.native.ts = react-native-webrtc, webrtc.web.ts = browser WebRTC).
 * Both libraries implement the W3C API; these types cover only what Vero uses
 * so the call logic (and its unit tests, which use fakes) is platform
 * independent.
 */

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface PeerConfig {
  iceServers: IceServer[];
  /** 'relay' hides both parties' IP addresses from each other (needs TURN). */
  iceTransportPolicy?: 'all' | 'relay';
}

export interface SessionDescriptionInit {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

export interface IceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface TrackLike {
  readonly id: string;
  readonly kind: string;
  enabled: boolean;
  readonly readyState?: string;
  stop(): void;
  addEventListener?(type: 'ended', listener: () => void): void;
  removeEventListener?(type: 'ended', listener: () => void): void;
}

export interface StreamLike {
  readonly id: string;
  getTracks(): TrackLike[];
  getAudioTracks(): TrackLike[];
  getVideoTracks(): TrackLike[];
  addTrack(track: TrackLike): void;
  removeTrack(track: TrackLike): void;
  /** react-native-webrtc only: the URL an RTCView renders. */
  toURL?(): string;
}

export interface SenderLike {
  readonly track: TrackLike | null;
  replaceTrack(track: TrackLike | null): Promise<void>;
}

export interface PeerHandlers {
  onIceCandidate(candidate: IceCandidateInit | null): void;
  onTrack(track: TrackLike, streams: StreamLike[]): void;
  onConnectionStateChange(state: string): void;
  onIceConnectionStateChange(state: string): void;
}

/** Iterable stats (RTCStatsReport is a Map on both platforms). */
export interface StatsReportLike {
  forEach(cb: (value: any) => void): void;
}

export interface PeerLike {
  readonly signalingState: string;
  readonly iceConnectionState: string;
  readonly connectionState: string;
  readonly localDescription: { type: string | null; sdp: string } | null;
  readonly remoteDescription: { type: string | null; sdp: string } | null;
  createOffer(options?: { iceRestart?: boolean }): Promise<SessionDescriptionInit>;
  createAnswer(): Promise<SessionDescriptionInit>;
  setLocalDescription(description: SessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: SessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: IceCandidateInit): Promise<void>;
  addTrack(track: TrackLike, stream: StreamLike): SenderLike;
  getSenders(): SenderLike[];
  getStats(): Promise<StatsReportLike>;
  close(): void;
}

export type CameraFacing = 'user' | 'environment';

export interface AudioRouter {
  /** Outgoing call placed: start the in-call audio session and ringback tone. */
  startOutgoing(kind: 'audio' | 'video'): void;
  /** Incoming call ringing in the app (not a push). */
  startRingtone(): void;
  stopRingtone(): void;
  /** Call answered/connected: in-call audio session, stop tones. */
  startInCall(kind: 'audio' | 'video'): void;
  setSpeakerphone(on: boolean): void;
  /** Whether the speaker/earpiece toggle means anything on this platform. */
  readonly supportsSpeakerToggle: boolean;
  stop(): void;
}

export interface ScreenShareSupport {
  supported: boolean;
  /** User-facing reason when unsupported. */
  reason?: string;
}

export interface MediaAdapter {
  /** null when real-time media works here; otherwise a user-facing reason. */
  unavailableReason(): string | null;
  createPeer(config: PeerConfig, handlers: PeerHandlers): PeerLike;
  /** An empty stream that local tracks are grouped in (one stream id per call). */
  createStream(tracks: TrackLike[]): StreamLike;
  getUserMedia(options: { audio: boolean; video: boolean; facing: CameraFacing }): Promise<StreamLike>;
  screenShareSupport(): ScreenShareSupport;
  /** Asks the user what to share and returns a stream with one video track. */
  getDisplayMedia(): Promise<StreamLike>;
  /**
   * Flips the camera. Returns the facing now in use and, when the platform had
   * to create a new track (web), that track: the caller must swap it into
   * every peer connection.
   */
  switchCamera(track: TrackLike, current: CameraFacing): Promise<{ facing: CameraFacing; replacement?: TrackLike }>;
  /** Plays a remote participant's audio where the platform doesn't do it automatically (web). */
  attachRemoteAudio(key: string, stream: StreamLike | null): void;
  readonly audio: AudioRouter;
}
