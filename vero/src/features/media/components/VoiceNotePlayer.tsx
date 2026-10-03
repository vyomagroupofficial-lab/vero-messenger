/**
 * <VoiceNotePlayer>: play/pause, drag-to-seek on the waveform, 1x/1.5x/2x
 * speed, progress drawn over the sender's waveform, and a "played" state.
 *
 * The encrypted file is downloaded and decrypted only when the user presses
 * play (then cached per account). The native audio player is created only for
 * the note that is playing, and only one note plays at a time.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, LayoutChangeEvent, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { friendlyError } from '../../../core/network/supabase';
import { Colors, Spacing, Typography } from '../../../shared/theme/theme';
import type { MediaAttachment } from '../../../shared/models/Message';
import { mediaRepository } from '../MediaRepository';
import { formatDuration, nextRate, PlaybackRate, resampleForDisplay } from '../waveform';

/** Remembered across notes for this app session (like other messengers do). */
let preferredRate: PlaybackRate = 1;
/** Pauses whichever note is playing right now. */
let pauseActive: (() => void) | null = null;

const BARS = 40;

interface Props {
  media: MediaAttachment;
  isOwn: boolean;
  /** Called the first time this device starts playing the note. */
  onPlayed?: () => void;
}

interface ViewProps {
  waveform: number[];
  progress: number;
  playing: boolean;
  loading: boolean;
  error: string | null;
  positionMs: number;
  durationMs: number;
  rate: PlaybackRate;
  isOwn: boolean;
  unplayed: boolean;
  onToggle: () => void;
  onSeek?: (fraction: number) => void;
  onRate: () => void;
}

function Waveform({
  bars,
  progress,
  isOwn,
  onSeek,
}: {
  bars: number[];
  progress: number;
  isOwn: boolean;
  onSeek?: (fraction: number) => void;
}) {
  const width = useRef(1);
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !!onSeekRef.current,
      onMoveShouldSetPanResponder: () => !!onSeekRef.current,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => setDragFraction(clamp(e.nativeEvent.locationX / width.current)),
      onPanResponderMove: (e) => setDragFraction(clamp(e.nativeEvent.locationX / width.current)),
      onPanResponderRelease: (e) => {
        const f = clamp(e.nativeEvent.locationX / width.current);
        setDragFraction(null);
        onSeekRef.current?.(f);
      },
      onPanResponderTerminate: () => setDragFraction(null),
    })
  ).current;

  const shown = dragFraction ?? progress;
  const played = isOwn ? Colors.white : Colors.accentLight;
  const rest = isOwn ? 'rgba(255,255,255,0.4)' : Colors.textTertiary;

  return (
    <View
      style={styles.wave}
      onLayout={(e: LayoutChangeEvent) => (width.current = Math.max(1, e.nativeEvent.layout.width))}
      {...responder.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel="Voice message position"
    >
      {bars.map((v, i) => (
        <View
          key={i}
          pointerEvents="none"
          style={[
            styles.bar,
            { height: 3 + Math.round((v / 100) * 23), backgroundColor: (i + 0.5) / bars.length <= shown ? played : rest },
          ]}
        />
      ))}
    </View>
  );
}

const clamp = (f: number) => (Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0);

function VoiceNoteView(p: ViewProps) {
  const bars = resampleForDisplay(p.waveform, BARS);
  const tint = p.isOwn ? Colors.white : Colors.textPrimary;
  return (
    <View style={styles.row}>
      <Pressable
        onPress={p.onToggle}
        style={[styles.play, p.isOwn ? styles.playOwn : styles.playOther]}
        accessibilityLabel={p.playing ? 'Pause voice message' : 'Play voice message'}
      >
        {p.loading ? (
          <ActivityIndicator size="small" color={tint} />
        ) : (
          <Ionicons
            name={p.error ? 'refresh' : p.playing ? 'pause' : 'play'}
            size={20}
            color={p.isOwn ? Colors.bubbleSent : Colors.white}
          />
        )}
      </Pressable>
      <View style={styles.middle}>
        <Waveform bars={bars} progress={p.progress} isOwn={p.isOwn} onSeek={p.onSeek} />
        <View style={styles.meta}>
          {p.unplayed && <View style={styles.unplayedDot} />}
          <Text style={[styles.time, p.isOwn && styles.timeOwn]} numberOfLines={1}>
            {p.error ?? (p.positionMs > 0 || p.playing
              ? `${formatDuration(p.positionMs)} / ${formatDuration(p.durationMs)}`
              : formatDuration(p.durationMs))}
          </Text>
        </View>
      </View>
      <Pressable onPress={p.onRate} style={[styles.rate, p.isOwn && styles.rateOwn]} accessibilityLabel={`Playback speed ${p.rate}x`}>
        <Text style={[styles.rateText, p.isOwn && styles.rateTextOwn]}>{p.rate}x</Text>
      </Pressable>
    </View>
  );
}

/** Mounted only while a note is the active one: owns the native player. */
function ActiveVoicePlayer({
  uri,
  media,
  isOwn,
  unplayed,
  rate,
  onRate,
  onStarted,
  onDone,
}: {
  uri: string;
  media: MediaAttachment;
  isOwn: boolean;
  unplayed: boolean;
  rate: PlaybackRate;
  onRate: () => void;
  onStarted: () => void;
  onDone: () => void;
}) {
  const player = useAudioPlayer({ uri }, { updateInterval: 100 });
  const status = useAudioPlayerStatus(player);
  const started = useRef(false);

  const claim = useCallback(() => {
    const mine = () => player.pause();
    if (pauseActive) pauseActive();
    pauseActive = mine;
    return mine;
  }, [player]);
  const claimed = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false })
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        claimed.current = claim();
        player.setPlaybackRate(rate, 'high');
        player.play();
      });
    return () => {
      cancelled = true;
      if (pauseActive && pauseActive === claimed.current) pauseActive = null;
    };
    // Start once per player; rate changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);

  useEffect(() => {
    player.setPlaybackRate(rate, 'high');
  }, [player, rate]);

  useEffect(() => {
    if (status.playing && !started.current) {
      started.current = true;
      onStarted();
    }
  }, [status.playing, onStarted]);

  useEffect(() => {
    if (status.didJustFinish) {
      void player.seekTo(0).catch(() => undefined);
      player.pause();
      onDone();
    }
  }, [status.didJustFinish, player, onDone]);

  const durationMs = status.duration > 0 ? status.duration * 1000 : media.durationMs ?? 0;
  const positionMs = Math.min(durationMs, status.currentTime * 1000);
  const progress = durationMs > 0 ? positionMs / durationMs : 0;

  return (
    <VoiceNoteView
      waveform={media.waveform ?? []}
      progress={progress}
      playing={status.playing}
      loading={!status.isLoaded}
      error={null}
      positionMs={positionMs}
      durationMs={durationMs}
      rate={rate}
      isOwn={isOwn}
      unplayed={unplayed}
      onToggle={() => {
        if (status.playing) {
          player.pause();
        } else {
          claimed.current = claim();
          player.play();
        }
      }}
      onSeek={(f) => {
        if (durationMs > 0) void player.seekTo((f * durationMs) / 1000).catch(() => undefined);
      }}
      onRate={onRate}
    />
  );
}

export function VoiceNotePlayer({ media, isOwn, onPlayed }: Props) {
  const [uri, setUri] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState<PlaybackRate>(preferredRate);
  const unplayed = !isOwn && !media.playedAt;

  const cycleRate = useCallback(() => {
    setRate((r) => {
      const n = nextRate(r);
      preferredRate = n;
      return n;
    });
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (uri) {
      setActive(true);
      return;
    }
    setLoading(true);
    try {
      const local = await mediaRepository.downloadDecrypted(media);
      setUri(local);
      setActive(true);
    } catch (e) {
      setError(friendlyError(e, 'Could not load'));
    } finally {
      setLoading(false);
    }
  }, [uri, media]);

  const onStarted = useCallback(() => {
    if (unplayed) onPlayed?.();
  }, [unplayed, onPlayed]);
  const onDone = useCallback(() => setActive(false), []);

  if (active && uri) {
    return (
      <ActiveVoicePlayer
        uri={uri}
        media={media}
        isOwn={isOwn}
        unplayed={unplayed}
        rate={rate}
        onRate={cycleRate}
        onStarted={onStarted}
        onDone={onDone}
      />
    );
  }

  return (
    <VoiceNoteView
      waveform={media.waveform ?? []}
      progress={0}
      playing={false}
      loading={loading}
      error={error}
      positionMs={0}
      durationMs={media.durationMs ?? 0}
      rate={rate}
      isOwn={isOwn}
      unplayed={unplayed}
      onToggle={() => void start()}
      onRate={cycleRate}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minWidth: 230, paddingVertical: 2 },
  play: { width: 38, height: 38, borderRadius: 19, justifyContent: 'center', alignItems: 'center' },
  playOwn: { backgroundColor: Colors.white },
  playOther: { backgroundColor: Colors.accent },
  middle: { flex: 1 },
  wave: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 30 },
  bar: { width: 2.5, borderRadius: 1.5 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  unplayedDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: Colors.accentLight },
  time: { fontSize: Typography.xs, color: Colors.textSecondary, fontVariant: ['tabular-nums'] },
  timeOwn: { color: 'rgba(255,255,255,0.8)' },
  rate: {
    minWidth: 38,
    paddingHorizontal: 6,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  rateOwn: { backgroundColor: 'rgba(255,255,255,0.2)' },
  rateText: { fontSize: Typography.xs, fontWeight: '700', color: Colors.textPrimary },
  rateTextOwn: { color: Colors.white },
});
