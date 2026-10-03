/**
 * Web media adapter: the browser's own RTCPeerConnection / getUserMedia.
 * (Needs a secure context: https:// or http://localhost.)
 */

import type {
  AudioRouter,
  CameraFacing,
  MediaAdapter,
  PeerConfig,
  PeerHandlers,
  PeerLike,
  StreamLike,
} from './mediaTypes';

let remoteAudio: HTMLAudioElement | null = null;
let ringTimer: ReturnType<typeof setInterval> | null = null;

const audio: AudioRouter = {
  supportsSpeakerToggle: false,
  startOutgoing() {},
  startRingtone() {
    // No bundled ringtone on web: vibrate where supported (mobile browsers).
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;
    if (!nav?.vibrate) return;
    nav.vibrate([800, 1200]);
    ringTimer = setInterval(() => nav.vibrate([800, 1200]), 2000);
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

export const mediaAdapter: MediaAdapter = {
  unavailableReason() {
    if (typeof window === 'undefined' || typeof (window as any).RTCPeerConnection === 'undefined') {
      return 'This browser does not support WebRTC calls.';
    }
    if (!navigator.mediaDevices?.getUserMedia) {
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
    pc.addEventListener('icecandidate', (e) => handlers.onIceCandidate(e.candidate ? e.candidate.toJSON() as any : null));
    pc.addEventListener('track', (e) => handlers.onTrack(e.track, [...e.streams]));
    pc.addEventListener('connectionstatechange', () => handlers.onConnectionStateChange(pc.connectionState));
    pc.addEventListener('iceconnectionstatechange', () => handlers.onIceConnectionStateChange(pc.iceConnectionState));
    return pc as unknown as PeerLike;
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
        throw new Error('Allow microphone (and camera for video) access in your browser to make calls.');
      }
      if (name === 'NotFoundError') throw new Error('No microphone or camera was found.');
      throw e;
    }
  },

  async switchCamera(stream: StreamLike, peer: PeerLike | null, current: CameraFacing): Promise<CameraFacing> {
    const old = stream.getVideoTracks()[0];
    if (!old) return current;
    const next: CameraFacing = current === 'user' ? 'environment' : 'user';
    let fresh: MediaStream;
    try {
      fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: next } }, audio: false });
    } catch {
      return current; // only one camera (typical on desktop)
    }
    const track = fresh.getVideoTracks()[0];
    track.enabled = old.enabled;
    const sender = peer?.getSenders().find((s) => s.track?.kind === 'video');
    await sender?.replaceTrack(track as any);
    stream.removeTrack(old);
    stream.addTrack(track as any);
    old.stop();
    return next;
  },

  attachRemoteAudio(stream: StreamLike | null) {
    if (typeof document === 'undefined') return;
    if (!stream) {
      if (remoteAudio) {
        remoteAudio.srcObject = null;
        remoteAudio.remove();
      }
      remoteAudio = null;
      return;
    }
    if (!remoteAudio) {
      remoteAudio = document.createElement('audio');
      remoteAudio.autoplay = true;
      remoteAudio.setAttribute('playsinline', 'true');
      remoteAudio.style.display = 'none';
      document.body.appendChild(remoteAudio);
    }
    if (remoteAudio.srcObject !== (stream as unknown as MediaStream)) {
      remoteAudio.srcObject = stream as unknown as MediaStream;
    }
    void remoteAudio.play().catch(() => {
      // Autoplay blocked until the next user gesture; the call screen's buttons count.
      const resume = () => {
        void remoteAudio?.play().catch(() => {});
        document.removeEventListener('click', resume);
      };
      document.addEventListener('click', resume);
    });
  },

  audio,
};

export function nativeRTCView(): any {
  return null;
}
