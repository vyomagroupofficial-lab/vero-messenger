/**
 * Web media adapter: the browser's own RTCPeerConnection / getUserMedia /
 * getDisplayMedia. Needs a secure context (https:// or http://localhost),
 * which the Electron shell (app://vero) also is.
 */

import type {
  AudioRouter,
  CameraFacing,
  MediaAdapter,
  PeerConfig,
  PeerHandlers,
  PeerLike,
  ScreenShareSupport,
  StreamLike,
  TrackLike,
} from './mediaTypes';

const remoteAudio = new Map<string, HTMLAudioElement>();
let ringTimer: ReturnType<typeof setInterval> | null = null;
let pendingResume: (() => void) | null = null;

function nav(): any {
  return typeof navigator !== 'undefined' ? (navigator as any) : null;
}

const audio: AudioRouter = {
  supportsSpeakerToggle: false,
  startOutgoing() {},
  startRingtone() {
    // No bundled ringtone on web: vibrate where supported (mobile browsers).
    const n = nav();
    if (!n?.vibrate) return;
    n.vibrate([800, 1200]);
    ringTimer = setInterval(() => n.vibrate([800, 1200]), 2000);
  },
  stopRingtone() {
    if (ringTimer) clearInterval(ringTimer);
    ringTimer = null;
  },
  startInCall() {
    this.stopRingtone();
  },
  setSpeakerphone() {},
  stop() {
    this.stopRingtone();
  },
};

function isMobileBrowser(): boolean {
  const ua = nav()?.userAgent ?? '';
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

export const mediaAdapter: MediaAdapter = {
  unavailableReason() {
    if (typeof window === 'undefined' || typeof (window as any).RTCPeerConnection === 'undefined') {
      return 'This browser does not support WebRTC calls.';
    }
    if (!nav()?.mediaDevices?.getUserMedia) {
      return 'Calls need a secure (https) connection and microphone access.';
    }
    return null;
  },

  createPeer(config: PeerConfig, handlers: PeerHandlers): PeerLike {
    const pc = new RTCPeerConnection({
      iceServers: config.iceServers,
      iceTransportPolicy: config.iceTransportPolicy ?? 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    pc.addEventListener('icecandidate', (e) => handlers.onIceCandidate(e.candidate ? (e.candidate.toJSON() as any) : null));
    pc.addEventListener('track', (e) => handlers.onTrack(e.track as any, [...e.streams] as any));
    pc.addEventListener('connectionstatechange', () => handlers.onConnectionStateChange(pc.connectionState));
    pc.addEventListener('iceconnectionstatechange', () => handlers.onIceConnectionStateChange(pc.iceConnectionState));
    return pc as unknown as PeerLike;
  },

  createStream(tracks: TrackLike[]): StreamLike {
    return new MediaStream(tracks as unknown as MediaStreamTrack[]) as unknown as StreamLike;
  },

  async getUserMedia({ audio: wantAudio, video, facing }): Promise<StreamLike> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: wantAudio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
        video: video ? { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
      return stream as unknown as StreamLike;
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new Error(
          video
            ? 'Allow camera and microphone access in your browser to make video calls.'
            : 'Allow microphone access in your browser to make calls.'
        );
      }
      if (name === 'NotFoundError') throw new Error(video ? 'No camera was found.' : 'No microphone was found.');
      if (name === 'NotReadableError') throw new Error('Your microphone or camera is in use by another app.');
      throw e;
    }
  },

  screenShareSupport(): ScreenShareSupport {
    if (!nav()?.mediaDevices?.getDisplayMedia) {
      return { supported: false, reason: 'This browser cannot share its screen.' };
    }
    if (isMobileBrowser()) {
      return { supported: false, reason: 'Mobile browsers cannot share the screen. Use the Vero app or a computer.' };
    }
    return { supported: true };
  },

  async getDisplayMedia(): Promise<StreamLike> {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } } as MediaTrackConstraints,
        audio: false,
      });
      return stream as unknown as StreamLike;
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'AbortError') throw new Error('Screen sharing was cancelled.');
      throw e;
    }
  },

  async switchCamera(track: TrackLike, current: CameraFacing) {
    const next: CameraFacing = current === 'user' ? 'environment' : 'user';
    let fresh: MediaStream;
    try {
      fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: next } }, audio: false });
    } catch {
      return { facing: current }; // only one camera (typical on desktop)
    }
    const replacement = fresh.getVideoTracks()[0] as unknown as TrackLike;
    replacement.enabled = track.enabled;
    return { facing: next, replacement };
  },

  attachRemoteAudio(key: string, stream: StreamLike | null) {
    if (typeof document === 'undefined') return;
    let el = remoteAudio.get(key);
    if (!stream) {
      if (el) {
        el.srcObject = null;
        el.remove();
        remoteAudio.delete(key);
      }
      return;
    }
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.setAttribute('playsinline', 'true');
      el.style.display = 'none';
      document.body.appendChild(el);
      remoteAudio.set(key, el);
    }
    if (el.srcObject !== (stream as unknown as MediaStream)) el.srcObject = stream as unknown as MediaStream;
    void el.play().catch(() => {
      // Autoplay blocked until the next user gesture; any tap on the call screen counts.
      if (pendingResume) return;
      pendingResume = () => {
        remoteAudio.forEach((a) => void a.play().catch(() => {}));
        document.removeEventListener('click', pendingResume!);
        pendingResume = null;
      };
      document.addEventListener('click', pendingResume);
    });
  },

  audio,
};
