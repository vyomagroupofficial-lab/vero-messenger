/**
 * Native (iOS / Android) media adapter: react-native-webrtc for media and
 * react-native-incall-manager for audio routing, ringtone and proximity.
 *
 * Both are native modules, so they exist only in a development / production
 * build (`npx expo run:android`, EAS Build), never in Expo Go. They're loaded
 * lazily so the rest of the app still runs in Expo Go; calls then report a
 * clear "needs a development build" error instead of crashing at import.
 *
 * Screen sharing
 *   Android: getDisplayMedia() asks for MediaProjection consent; the library
 *     runs its own `mediaProjection` foreground service (permissions added by
 *     plugins/withVeroCalls.js).
 *   iOS: needs a Broadcast Upload Extension (not part of this repo yet, see
 *     README "Calls"). Sharing is offered only when the build declares one
 *     (Info.plist RTCScreenSharingExtension, set by the config plugin's
 *     `iosScreenShareExtension` option).
 */

import { NativeModules, Platform } from 'react-native';
import Constants from 'expo-constants';
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
import { showIosScreenSharePicker } from './screenSharePicker';

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
    // '_DTMF_' = the standard ringback tone generated natively (no bundled file needed).
    inCallManager()?.start({ media: kind, auto: true, ringback: '_DTMF_' });
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

function iosScreenShareExtension(): string | null {
  const plist = (Constants.expoConfig?.ios?.infoPlist ?? {}) as Record<string, unknown>;
  const ext = plist.RTCScreenSharingExtension;
  return typeof ext === 'string' && ext ? ext : null;
}

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
    } as any);
    pc.addEventListener('icecandidate', (e: any) => {
      handlers.onIceCandidate(e.candidate ? (e.candidate.toJSON?.() ?? e.candidate) : null);
    });
    pc.addEventListener('track', (e: any) => handlers.onTrack(e.track, e.streams ?? []));
    pc.addEventListener('connectionstatechange', () => handlers.onConnectionStateChange(pc.connectionState));
    pc.addEventListener('iceconnectionstatechange', () => handlers.onIceConnectionStateChange(pc.iceConnectionState));
    return pc as PeerLike;
  },

  createStream(tracks: TrackLike[]): StreamLike {
    const { MediaStream } = lib();
    return new MediaStream(tracks as any) as unknown as StreamLike;
  },

  async getUserMedia({ audio: wantAudio, video, facing }): Promise<StreamLike> {
    const { mediaDevices } = lib();
    let stream: any;
    try {
      stream = await mediaDevices.getUserMedia({
        audio: wantAudio,
        video: video ? { facingMode: facing, width: 1280, height: 720, frameRate: 30 } : false,
      } as any);
    } catch (e) {
      const msg = (e as Error)?.message ?? '';
      if (/permission/i.test(msg)) {
        throw new Error(
          video
            ? 'Camera and microphone permission are needed for video calls. Enable them in Settings.'
            : 'Microphone permission is needed for calls. Enable it in Settings.'
        );
      }
      throw e;
    }
    // react-native-webrtc silently drops a kind whose permission was denied.
    if (wantAudio && stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t: any) => t.stop());
      throw new Error('Microphone permission is needed for calls. Enable it in Settings.');
    }
    if (video && stream.getVideoTracks().length === 0 && !wantAudio) {
      throw new Error('Camera permission is needed. Enable it in Settings.');
    }
    return stream as StreamLike;
  },

  screenShareSupport(): ScreenShareSupport {
    if (this.unavailableReason()) return { supported: false, reason: this.unavailableReason() ?? undefined };
    if (Platform.OS === 'android') {
      return Number(Platform.Version) >= 21
        ? { supported: true }
        : { supported: false, reason: 'Screen sharing needs Android 5 or later.' };
    }
    if (Platform.OS === 'ios') {
      return iosScreenShareExtension()
        ? { supported: true }
        : {
            supported: false,
            reason: 'Screen sharing on iPhone needs a Broadcast Upload Extension, which this build does not include yet.',
          };
    }
    return { supported: false, reason: 'Screen sharing is not available on this device.' };
  },

  async getDisplayMedia(): Promise<StreamLike> {
    const support = this.screenShareSupport();
    if (!support.supported) throw new Error(support.reason || 'Screen sharing is not available.');
    const { mediaDevices } = lib();
    // iOS: the user starts the broadcast from the system picker; the extension
    // then streams frames to the app through the shared App Group.
    if (Platform.OS === 'ios') showIosScreenSharePicker();
    try {
      return (await mediaDevices.getDisplayMedia({ video: true } as any)) as unknown as StreamLike;
    } catch (e) {
      const msg = (e as Error)?.message ?? '';
      if (/denied|cancel|permission/i.test(msg)) throw new Error('Screen sharing was cancelled.');
      throw e;
    }
  },

  async switchCamera(track: TrackLike, current: CameraFacing) {
    const next: CameraFacing = current === 'user' ? 'environment' : 'user';
    const t: any = track;
    if (typeof t.applyConstraints === 'function') {
      await t.applyConstraints({ facingMode: next });
    } else if (typeof t._switchCamera === 'function') {
      t._switchCamera();
    } else {
      return { facing: current };
    }
    return { facing: next };
  },

  attachRemoteAudio() {
    // Native WebRTC plays remote audio tracks automatically.
  },

  audio,
};

/** For <CallVideoView/>: the RTCView component (null when unavailable). */
export function nativeRTCView(): any {
  try {
    return lib().RTCView;
  } catch {
    return null;
  }
}

/** For the iOS broadcast picker (rendered only when an extension is configured). */
export function nativeScreenCapturePickerView(): any {
  try {
    return (lib() as any).ScreenCapturePickerView ?? null;
  } catch {
    return null;
  }
}
