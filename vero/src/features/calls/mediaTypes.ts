/**
 * Minimal structural types shared by the WebRTC platform adapters
 * (webrtc.native.ts = react-native-webrtc, webrtc.web.ts = browser WebRTC).
 * Both libraries implement the W3C API; these types cover only what Vero uses
 * so the call logic is platform independent.
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
}

export interface StreamLike {
  readonly id: string;
  getTracks(): TrackLike[];
  getAudioTracks(): TrackLike[];
  getVideoTracks(): TrackLike[];
  addTrack(track: TrackLike): void;
  removeTrack(track: TrackLike): void;
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

export interface MediaAdapter {
  /** null when real-time media works here; otherwise a user-facing reason. */
  unavailableReason(): string | null;
  createPeer(config: PeerConfig, handlers: PeerHandlers): PeerLike;
  getUserMedia(options: { audio: boolean; video: boolean; facing: CameraFacing }): Promise<StreamLike>;
  /** Switches the camera of the local video track in place; returns the new facing. */
  switchCamera(stream: StreamLike, peer: PeerLike | null, current: CameraFacing): Promise<CameraFacing>;
  /** Plays remote audio where the platform doesn't do it automatically (web). */
  attachRemoteAudio(stream: StreamLike | null): void;
  readonly audio: AudioRouter;
}
