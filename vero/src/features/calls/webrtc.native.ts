/**
 * Native (iOS / Android) media adapter: react-native-webrtc for media and
 * react-native-incall-manager for audio routing, ringtone and proximity.
 *
 * Both are native modules, so they exist only in a development / production
 * build (`npx expo run:android`, EAS Build), never in Expo Go. They're loaded
 * lazily so the rest of the app still runs in Expo Go; calls then report a
 * clear "needs a development build" error instead of crashing at import.
 */

import { NativeModules } from 'react-native';
import type {
  AudioRouter,
  CameraFacing,
  MediaAdapter,
  PeerConfig,
  PeerHandlers,
  PeerLike,
  StreamLike,
} from './mediaTypes';

type WebRTCModule = typeof import('react-native-webrtc');
type InCallManagerModule = typeof import('react-native-incall-manager').default;

let webrtc: WebRTCModule | null = null;
let loadError: string | null = null;

function lib(): WebRTCModule {
  if (webrtc) return webrtc;
  if (!NativeModules.WebRTCModule) {
    loadError = 'Calls need the Vero development build (react-native-webrtc is not available in Expo Go).';
    throw new Error(loadError);
  }
  try {
    webrtc = require('react-native-webrtc') as WebRTCModule;
    return webrtc;
  } catch (e) {
    loadError = (e as Error)?.message || 'WebRTC failed to load';
    throw new Error(loadError);
  }
}

let incall: InCallManagerModule | null | undefined;
function inCallManager(): InCallManagerModule | null {
  if (incall !== undefined) return incall;
  try {
    incall = NativeModules.InCallManager
      ? ((require('react-native-incall-manager').default ?? require('react-native-incall-manager')) as InCallManagerModule)
      : null;
  } catch {
    incall = null;
  }
  return incall;
}

const audio: AudioRouter = {
  supportsSpeakerToggle: true,
  startOutgoing(kind) {
    const m = inCallManager();
    // '_DTMF_' = the standard ringback tone generated natively (no bundled file needed).
    m?.start({ media: kind, auto: true, ringback: '_DTMF_' });
  },
  startRingtone() {
    // Plays the system ringtone and vibrates; seconds is Android only.
    inCallManager()?.startRingtone('_DEFAULT_', [0, 800, 1200], 'playback', 45);
  },
  stopRingtone() {
    inCallManager()?.stopRingtone();
  },
  startInCall(kind) {
    const m = inCallManager();
    if (!m) return;
    m.stopRingtone();
    m.stopRingback();
    // auto: InCallManager handles proximity (screen off at the ear) and routing.
    m.start({ media: kind, auto: true });
    m.setKeepScreenOn(true);
  },
  setSpeakerphone(on) {
    inCallManager()?.setForceSpeakerphoneOn(on);
  },
  stop() {
    const m = inCallManager();
    if (!m) return;
    m.stopRingtone();
    m.setKeepScreenOn(false);
    m.stop();
  },
};

export const mediaAdapter: MediaAdapter = {
  unavailableReason() {
    try {
      lib();
      return null;
    } catch {
      return loadError;
    }
  },

  createPeer(config: PeerConfig, handlers: PeerHandlers): PeerLike {
    const { RTCPeerConnection } = lib();
    const pc: any = new RTCPeerConnection({
      iceServers: config.iceServers,
      iceTransportPolicy: config.iceTransportPolicy ?? 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    pc.addEventListener('icecandidate', (e: any) => {
      handlers.onIceCandidate(e.candidate ? (e.candidate.toJSON?.() ?? e.candidate) : null);
    });
    pc.addEventListener('track', (e: any) => handlers.onTrack(e.track, e.streams ?? []));
    pc.addEventListener('connectionstatechange', () => handlers.onConnectionStateChange(pc.connectionState));
    pc.addEventListener('iceconnectionstatechange', () => handlers.onIceConnectionStateChange(pc.iceConnectionState));
    return pc as PeerLike;
  },

  async getUserMedia({ audio: wantAudio, video, facing }): Promise<StreamLike> {
    const { mediaDevices } = lib();
    const stream: any = await mediaDevices.getUserMedia({
      audio: wantAudio,
      video: video ? { facingMode: facing, width: 1280, height: 720, frameRate: 30 } : false,
    });
    // react-native-webrtc silently drops a kind whose permission was denied.
    if (wantAudio && stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t: any) => t.stop());
      throw new Error('Microphone permission is needed for calls. Enable it in Settings.');
    }
    return stream as StreamLike;
  },

  async switchCamera(stream: StreamLike, _peer, current: CameraFacing): Promise<CameraFacing> {
    const track: any = stream.getVideoTracks()[0];
    if (!track) return current;
    const next: CameraFacing = current === 'user' ? 'environment' : 'user';
    if (typeof track._switchCamera === 'function') {
      track._switchCamera();
    } else {
      await track.applyConstraints({ facingMode: next });
    }
    return next;
  },

  attachRemoteAudio() {
    // Native WebRTC plays remote audio tracks automatically.
  },

  audio,
};

/** For <VideoSurface/>: the RTCView component (null when unavailable). */
export function nativeRTCView(): any {
  try {
    return lib().RTCView;
  } catch {
    return null;
  }
}
