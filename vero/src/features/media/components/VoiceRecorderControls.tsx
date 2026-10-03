/**
 * Voice-note composer controls.
 *
 * <VoiceRecordButton>   the mic. Hold to record, release to send; slide left
 *                       to cancel; slide up (or just tap the mic) to lock,
 *                       i.e. keep recording hands-free.
 * <VoiceRecordingBar>   replaces the text field while recording: timer, live
 *                       waveform, "slide to cancel" hint, or (locked) delete +
 *                       send buttons.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, Typography } from '../../../shared/theme/theme';
import type { VoiceRecorderController } from '../useVoiceRecorder';
import { formatDuration } from '../waveform';

/** Slide this far left to cancel / up to lock. */
const CANCEL_DX = -110;
const LOCK_DY = -80;
/** A press shorter than this is a tap: start a hands-free (locked) recording. */
const TAP_MS = 250;

export function VoiceRecordButton({ voice, disabled }: { voice: VoiceRecorderController; disabled?: boolean }) {
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const pressedAt = useRef(0);
  const decided = useRef(false);
  const [dragY, setDragY] = useState(0);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        pressedAt.current = Date.now();
        decided.current = false;
        setDragY(0);
        void voiceRef.current.start();
      },
      onPanResponderMove: (_e, g) => {
        if (decided.current) return;
        const v = voiceRef.current;
        v.dragX.setValue(Math.min(0, g.dx));
        setDragY(Math.min(0, g.dy));
        if (g.dx <= CANCEL_DX) {
          decided.current = true;
          void v.cancel();
        } else if (g.dy <= LOCK_DY) {
          decided.current = true;
          v.lock();
        }
      },
      onPanResponderRelease: () => {
        setDragY(0);
        voiceRef.current.dragX.setValue(0);
        if (decided.current) return;
        decided.current = true;
        if (Date.now() - pressedAt.current < TAP_MS) voiceRef.current.lock();
        else void voiceRef.current.finish();
      },
      onPanResponderTerminate: () => {
        setDragY(0);
        if (decided.current) return;
        decided.current = true;
        void voiceRef.current.cancel();
      },
    })
  ).current;

  const holding = voice.status === 'recording' || voice.status === 'starting';

  return (
    <View>
      {holding && (
        <View style={[styles.lockHint, { transform: [{ translateY: Math.max(dragY, LOCK_DY) / 2 }] }]} pointerEvents="none">
          <Ionicons name="lock-open-outline" size={16} color={Colors.textSecondary} />
          <Ionicons name="chevron-up" size={14} color={Colors.textTertiary} />
        </View>
      )}
      <View
        {...(disabled ? {} : responder.panHandlers)}
        style={[styles.mic, holding && styles.micActive, disabled && styles.disabled]}
        accessibilityRole="button"
        accessibilityLabel="Record voice message. Hold to record, or tap for hands-free recording."
      >
        <Ionicons name="mic" size={20} color={Colors.white} />
      </View>
    </View>
  );
}

function PulsingDot() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.2, duration: 500, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 500, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);
  return <Animated.View style={[styles.dot, { opacity }]} />;
}

export function VoiceRecordingBar({ voice }: { voice: VoiceRecorderController }) {
  const hintShift = voice.dragX.interpolate({ inputRange: [CANCEL_DX, 0], outputRange: [CANCEL_DX / 2, 0], extrapolate: 'clamp' });
  const hintOpacity = voice.dragX.interpolate({ inputRange: [CANCEL_DX, 0], outputRange: [0.2, 1], extrapolate: 'clamp' });

  return (
    <View style={styles.bar}>
      {voice.isLocked ? (
        <Pressable onPress={() => void voice.cancel()} style={styles.iconBtn} accessibilityLabel="Delete recording">
          <Ionicons name="trash-outline" size={22} color={Colors.error} />
        </Pressable>
      ) : null}
      <PulsingDot />
      <Text style={styles.timer}>{formatDuration(voice.durationMs)}</Text>
      <View style={styles.levels}>
        {voice.levels.map((l, i) => (
          <View key={i} style={[styles.level, { height: 3 + Math.round(l * 21) }]} />
        ))}
      </View>
      {voice.isLocked ? (
        <Pressable onPress={() => void voice.finish()} style={styles.send} accessibilityLabel="Send voice message">
          <Ionicons name="send" size={18} color={Colors.white} />
        </Pressable>
      ) : (
        <Animated.View style={[styles.hint, { opacity: hintOpacity, transform: [{ translateX: hintShift }] }]}>
          <Ionicons name="chevron-back" size={14} color={Colors.textSecondary} />
          <Text style={styles.hintText}>Slide to cancel</Text>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  mic: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  micActive: {
    backgroundColor: Colors.error,
    transform: [{ scale: 1.15 }],
  },
  disabled: { opacity: 0.5 },
  lockHint: {
    position: 'absolute',
    bottom: 52,
    left: 6,
    width: 28,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
  },
  bar: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    borderRadius: 22,
    backgroundColor: Colors.inputBackground,
    borderWidth: 1,
    borderColor: Colors.inputBorder,
  },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.error },
  timer: {
    color: Colors.textPrimary,
    fontSize: Typography.base,
    fontVariant: ['tabular-nums'],
    minWidth: 42,
  },
  levels: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 26, overflow: 'hidden' },
  level: { width: 2, borderRadius: 1, backgroundColor: Colors.accentLight },
  hint: { flexDirection: 'row', alignItems: 'center' },
  hintText: { color: Colors.textSecondary, fontSize: Typography.sm },
  iconBtn: { width: 32, height: 32, justifyContent: 'center', alignItems: 'center' },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
