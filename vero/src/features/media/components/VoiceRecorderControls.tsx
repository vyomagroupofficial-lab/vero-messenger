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
import { Animated, PanResponder, Text, View } from 'react-native';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { Icon, IconButton, Ripple } from '../../../shared/ui';
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

  const { c } = useTheme();
  const styles = useStyles();
  const t = useT();
  const holding = voice.status === 'recording' || voice.status === 'starting';

  return (
    <View>
      {holding && (
        <View style={[styles.lockHint, { transform: [{ translateY: Math.max(dragY, LOCK_DY) / 2 }] }]} pointerEvents="none">
          <Icon name="lock" size={15} color={c.muted} />
          <Icon name="chevronUp" size={14} color={c.faint} />
        </View>
      )}
      {holding && (
        <View style={styles.ripple} pointerEvents="none">
          <Ripple size={46} color={c.danger} />
        </View>
      )}
      <View
        {...(disabled ? {} : responder.panHandlers)}
        style={[styles.mic, holding && styles.micActive, disabled && styles.disabled]}
        accessibilityRole="button"
        accessibilityLabel={t('voice.recordA11y')}
      >
        <Icon name="mic" size={21} color={holding ? c.onDanger : c.onAccent} />
      </View>
    </View>
  );
}

function PulsingDot() {
  const styles = useStyles();
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
  const { c } = useTheme();
  const styles = useStyles();
  const t = useT();
  const hintShift = voice.dragX.interpolate({ inputRange: [CANCEL_DX, 0], outputRange: [CANCEL_DX / 2, 0], extrapolate: 'clamp' });
  const hintOpacity = voice.dragX.interpolate({ inputRange: [CANCEL_DX, 0], outputRange: [0.2, 1], extrapolate: 'clamp' });

  return (
    <View style={styles.bar}>
      {voice.isLocked ? <IconButton icon="trash" label={t('voice.discard')} color={c.danger} size={38} onPress={() => void voice.cancel()} /> : null}
      <PulsingDot />
      <Text style={styles.timer}>{formatDuration(voice.durationMs)}</Text>
      <View style={styles.levels}>
        {voice.levels.map((l, i) => (
          <View key={i} style={[styles.level, { height: 3 + Math.round(l * 21) }]} />
        ))}
      </View>
      {voice.isLocked ? (
        <IconButton icon="send" label={t('voice.send')} variant="brass" size={38} onPress={() => void voice.finish()} />
      ) : (
        <Animated.View style={[styles.hint, { opacity: hintOpacity, transform: [{ translateX: hintShift }] }]}>
          <Icon name="back" size={14} color={c.muted} />
          <Text style={styles.hintText}>{t('voice.slideCancel')}</Text>
        </Animated.View>
      )}
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  mic: { width: 46, height: 46, borderRadius: 23, backgroundColor: c.accent, justifyContent: 'center', alignItems: 'center' },
  micActive: { backgroundColor: c.dangerFill, transform: [{ scale: 1.18 }] },
  disabled: { opacity: 0.5 },
  ripple: { position: 'absolute', top: 0, left: 0, width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  lockHint: { position: 'absolute', bottom: 60, left: 9, width: 28, paddingVertical: 7, gap: 2, borderRadius: 14, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, alignItems: 'center' },
  bar: { flex: 1, minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, borderRadius: 23, backgroundColor: c.raised, borderWidth: 1, borderColor: c.dangerTint },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.danger },
  timer: { fontFamily: f.mono, color: c.text, fontSize: 15, fontVariant: ['tabular-nums'], minWidth: 44 },
  levels: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 26, overflow: 'hidden' },
  level: { width: 2.5, borderRadius: 1.25, backgroundColor: c.accent },
  hint: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  hintText: { fontFamily: f.medium, color: c.muted, fontSize: 13 },
}));
