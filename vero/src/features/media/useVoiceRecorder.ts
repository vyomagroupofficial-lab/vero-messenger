/**
 * Voice-note recording (expo-audio).
 *
 *   start()   ask for the mic (first time only: the press that triggers the
 *             permission prompt does not record), then record AAC mono with
 *             metering enabled
 *   lock()    hands-free: keep recording after the finger is lifted
 *   finish()  stop and hand the recording to `onRecorded`
 *   cancel()  stop and delete the file
 *
 * While recording, the input level (dBFS) is sampled every ~80 ms; on finish
 * the samples are reduced to 64 peaks (waveform.ts) that travel, encrypted,
 * inside the message payload.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform } from 'react-native';
import {
  getRecordingPermissionsAsync,
  RecordingOptions,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { downsampleWaveform, meteringToLevel, WAVEFORM_BARS } from './waveform';

export type VoiceRecorderStatus = 'idle' | 'starting' | 'recording' | 'locked' | 'stopping';

export interface VoiceRecording {
  uri: string;
  mimeType: string;
  durationMs: number;
  /** WAVEFORM_BARS peaks, 0..100 */
  waveform: number[];
  /** Bytes, if known */
  size: number;
}

export interface UseVoiceRecorderOptions {
  onRecorded: (recording: VoiceRecording) => void;
  /** Recordings shorter than this are discarded (accidental taps). */
  minDurationMs?: number;
  /** Recording stops (and is sent) automatically at this length. */
  maxDurationMs?: number;
  onError?: (message: string) => void;
}

const METERING_INTERVAL_MS = 80;
/** Number of live bars shown while recording. */
export const LIVE_BARS = 36;

export const VOICE_RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  android: { ...RecordingPresets.HIGH_QUALITY.android, outputFormat: 'mpeg4', audioEncoder: 'aac' },
  web: { mimeType: 'audio/webm', bitsPerSecond: 64000 },
};

const VOICE_MIME = Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4';

function deleteQuietly(uri: string | null | undefined): void {
  if (!uri || Platform.OS === 'web') return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // ignore
  }
}

function fileSize(uri: string): number {
  if (Platform.OS === 'web') return 0;
  try {
    const f = new File(uri);
    return f.exists ? f.size : 0;
  } catch {
    return 0;
  }
}

export function useVoiceRecorder({
  onRecorded,
  minDurationMs = 700,
  maxDurationMs = 15 * 60 * 1000,
  onError,
}: UseVoiceRecorderOptions) {
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder, METERING_INTERVAL_MS);
  const [status, setStatus] = useState<VoiceRecorderStatus>('idle');
  const [levels, setLevels] = useState<number[]>(() => new Array(LIVE_BARS).fill(0));
  const samples = useRef<number[]>([]);
  const statusRef = useRef<VoiceRecorderStatus>('idle');
  /** What the user did while the recorder was still starting. */
  const pendingStop = useRef<null | 'finish' | 'cancel' | 'lock'>(null);
  const startedAt = useRef(0);
  /** Horizontal drag of the mic button (for the slide-to-cancel hint). */
  const dragX = useRef(new Animated.Value(0)).current;
  const callbacks = useRef({ onRecorded, onError });
  callbacks.current = { onRecorded, onError };

  const setBoth = (s: VoiceRecorderStatus) => {
    statusRef.current = s;
    setStatus(s);
  };

  // Collect metering samples while recording.
  useEffect(() => {
    if (!recorderState.isRecording) return;
    const level = meteringToLevel(recorderState.metering);
    samples.current.push(level);
    setLevels((prev) => [...prev.slice(1), level]);
  }, [recorderState.durationMillis, recorderState.isRecording, recorderState.metering]);

  const stop = useCallback(
    async (mode: 'finish' | 'cancel') => {
      const s = statusRef.current;
      if (s === 'starting') {
        pendingStop.current = mode;
        return;
      }
      if (s !== 'recording' && s !== 'locked') return;
      setBoth('stopping');
      dragX.setValue(0);
      let durationMs = Date.now() - startedAt.current;
      try {
        const st = recorder.getStatus();
        if (st.durationMillis > 0) durationMs = st.durationMillis;
      } catch {
        // use wall clock
      }
      let uri: string | null = null;
      try {
        await recorder.stop();
        uri = recorder.uri;
      } catch (e) {
        callbacks.current.onError?.('Recording failed. Please try again.');
        console.warn('[voice] stop failed:', (e as Error)?.message);
      }
      setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      const collected = samples.current;
      samples.current = [];
      setLevels(new Array(LIVE_BARS).fill(0));
      setBoth('idle');

      if (!uri) return;
      if (mode === 'cancel' || durationMs < minDurationMs) {
        deleteQuietly(uri);
        return;
      }
      callbacks.current.onRecorded({
        uri,
        mimeType: VOICE_MIME,
        durationMs: Math.round(durationMs),
        waveform: downsampleWaveform(collected, WAVEFORM_BARS),
        size: fileSize(uri),
      });
    },
    [recorder, minDurationMs, dragX]
  );

  const start = useCallback(async (): Promise<boolean> => {
    if (statusRef.current !== 'idle') return false;
    pendingStop.current = null;
    setBoth('starting');
    try {
      const current = await getRecordingPermissionsAsync();
      if (!current.granted) {
        // The press that shows the system prompt doesn't record.
        const asked = current.canAskAgain ? await requestRecordingPermissionsAsync() : current;
        setBoth('idle');
        if (!asked.granted) {
          callbacks.current.onError?.('Allow microphone access in Settings to record voice messages.');
        }
        return false;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      samples.current = [];
      startedAt.current = Date.now();
      recorder.record();
      setBoth('recording');
    } catch (e) {
      setBoth('idle');
      console.warn('[voice] start failed:', (e as Error)?.message);
      callbacks.current.onError?.('Could not start recording.');
      return false;
    }
    const pending = pendingStop.current;
    pendingStop.current = null;
    if (pending === 'lock') setBoth('locked');
    // Let go before the recorder was ready: nothing worth sending was recorded.
    else if (pending) await stop('cancel');
    return true;
  }, [recorder, stop]);

  const lock = useCallback(() => {
    if (statusRef.current === 'starting') {
      pendingStop.current = 'lock';
    } else if (statusRef.current === 'recording') {
      setBoth('locked');
      dragX.setValue(0);
    }
  }, [dragX]);

  const finish = useCallback(() => stop('finish'), [stop]);
  const cancel = useCallback(() => stop('cancel'), [stop]);

  // Hard cap on length.
  const durationMs = recorderState.isRecording ? recorderState.durationMillis : 0;
  useEffect(() => {
    if (durationMs >= maxDurationMs && (statusRef.current === 'recording' || statusRef.current === 'locked')) {
      void stop('finish');
    }
  }, [durationMs, maxDurationMs, stop]);

  // Never leave the mic running when the screen goes away.
  useEffect(
    () => () => {
      if (statusRef.current === 'recording' || statusRef.current === 'locked') {
        statusRef.current = 'stopping';
        recorder
          .stop()
          .then(() => deleteQuietly(recorder.uri))
          .catch(() => undefined);
        setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      }
    },
    [recorder]
  );

  return useMemo(
    () => ({
      status,
      /** true while the recording UI should replace the composer */
      isActive: status !== 'idle',
      isLocked: status === 'locked',
      durationMs,
      /** last LIVE_BARS input levels, 0..1 */
      levels,
      dragX,
      start,
      lock,
      finish,
      cancel,
    }),
    [status, durationMs, levels, dragX, start, lock, finish, cancel]
  );
}

export type VoiceRecorderController = ReturnType<typeof useVoiceRecorder>;
