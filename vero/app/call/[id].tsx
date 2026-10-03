import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeInUp, ZoomIn, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { callService, ActiveCall } from '../../src/features/calls/CallService';
import { Colors, Fonts, Type } from '../../src/shared/theme/theme';
import { Avatar, Grain, Icon, IconName, Pill, Pressy, Ripple, useLayout } from '../../src/shared/ui';

function Level({ delay }: { delay: number }) {
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withDelay(delay, withRepeat(withSequence(withTiming(1, { duration: 420 }), withTiming(0, { duration: 420 })), -1));
  }, []);
  const a = useAnimatedStyle(() => ({ height: 4 + v.value * 10 }));
  return <Animated.View style={[{ width: 4, borderRadius: 2, backgroundColor: Colors.sage }, a]} />;
}

function Control({ icon, label, active, onPress, big, danger }: {
  icon: IconName;
  label: string;
  active?: boolean;
  onPress: () => void;
  big?: boolean;
  danger?: boolean;
}) {
  const size = big ? 76 : 64;
  return (
    <View style={styles.ctlWrap}>
      <Pressy
        onPress={onPress}
        scaleTo={0.88}
        accessibilityLabel={label}
        accessibilityState={{ selected: active }}
        hoverStyle={!active && !danger ? { backgroundColor: 'rgba(237,231,217,0.18)' } : undefined}
        style={[
          styles.ctl,
          { width: danger && !big ? 84 : size, height: size, borderRadius: big ? size / 2 : 22 },
          active && { backgroundColor: Colors.cream },
          danger && { backgroundColor: Colors.emberDeep },
        ]}
      >
        <Icon name={icon} size={big ? 30 : 26} color={active ? Colors.ink : danger ? '#FBEFE6' : Colors.cream} style={icon === 'phone' && danger ? { transform: [{ rotate: '135deg' }] } : undefined} />
      </Pressy>
      {!danger && <Text style={styles.ctlLabel}>{label}</Text>}
    </View>
  );
}

function SelfView({ off }: { off: boolean }) {
  return (
    <Animated.View entering={FadeInUp.delay(300).springify().damping(16)} style={styles.self}>
      {off ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: Colors.raised, alignItems: 'center', justifyContent: 'center' }]}>
          <Text style={Type.caption}>Camera off</Text>
        </View>
      ) : (
        <Svg width="100%" height="100%" viewBox="0 0 240 150" preserveAspectRatio="xMidYMid slice">
          <Rect width={240} height={150} fill="#3A3542" />
          <Rect width={240} height={60} fill="#463F4E" />
          <Circle cx={120} cy={70} r={26} fill="#5C4A6B" />
          <Path d="M64 150c4-34 28-52 56-52s52 18 56 52z" fill="#5C4A6B" />
        </Svg>
      )}
      <Text style={styles.selfLabel}>You</Text>
    </Animated.View>
  );
}

export default function CallScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const [call, setCall] = useState<ActiveCall | null>(callService.getActiveCall());
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(true);
  const [videoOn, setVideoOn] = useState(callService.getActiveCall()?.callType === 'video');
  const [facing, setFacing] = useState<'front' | 'back'>('front');

  useEffect(() => {
    const unsub = callService.subscribe((c) => {
      setCall(c);
      if (!c || c.status === 'ended' || c.status === 'rejected') {
        setTimeout(() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/calls')), 1200);
      }
    });
    return () => unsub();
  }, []);

  const name = call?.peerName || 'Contact';
  const ringing = call?.status === 'ringing' && !call?.isInitiator;
  const connected = call?.status === 'connected';
  const d = call?.duration || 0;
  const status = connected
    ? `${String(Math.floor(d / 60)).padStart(2, '0')}:${String(d % 60).padStart(2, '0')}`
    : call?.status === 'ringing'
    ? call?.isInitiator
      ? 'Ringing…'
      : `Incoming ${call?.callType === 'video' ? 'video' : 'voice'} call`
    : call?.status === 'calling'
    ? 'Calling…'
    : call?.status === 'ended'
    ? 'Call ended'
    : call?.status === 'rejected'
    ? 'Declined'
    : 'Connecting…';

  const avatarSize = isWide ? 180 : 150;

  return (
    <View style={styles.stage}>
      <Grain opacity={0.08} />
      <View style={[styles.top, { paddingTop: insets.top + 14 }]}>
        <Pressy onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))} style={styles.minimise} accessibilityLabel="Minimise call">
          <Icon name={isWide ? 'back' : 'down'} size={20} color={Colors.cream} />
          {isWide && <Text style={[Type.label, { color: Colors.cream }]}>Back</Text>}
        </Pressy>
        <Pill icon="lock" label="End-to-end encrypted" tone="cream" style={{ backgroundColor: 'rgba(12,14,13,0.45)' }} />
        <View style={{ width: isWide ? 80 : 44 }} />
      </View>

      <View style={styles.center}>
        <Animated.View entering={ZoomIn.springify().damping(14)}>
          <Ripple size={avatarSize} duration={2600}>
            <Avatar name={name} size={avatarSize} />
          </Ripple>
        </Animated.View>
        <Animated.View entering={FadeInDown.delay(100)} style={{ alignItems: 'center', gap: 10 }}>
          <Text style={[Type.hero, { fontSize: isWide ? 44 : 34, textAlign: 'center' }]}>{name}</Text>
          <View style={styles.statusRow}>
            {connected && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: 14 }}>
                <Level delay={0} />
                <Level delay={150} />
                <Level delay={300} />
              </View>
            )}
            <Animated.Text key={status.length > 6 ? status : 'clock'} entering={FadeIn} style={styles.status}>
              {status}
            </Animated.Text>
          </View>
          {muted && (
            <Animated.Text entering={FadeIn} style={[Type.caption, { color: Colors.brassLight }]}>
              You’re muted
            </Animated.Text>
          )}
        </Animated.View>
      </View>

      {videoOn && !ringing && isWide && (
        <View style={{ position: 'absolute', right: 32, bottom: 150 }}>
          <SelfView off={false} />
        </View>
      )}

      <Animated.View entering={FadeInUp.delay(200).springify().damping(18)} style={[styles.dock, { marginBottom: insets.bottom + 28 }, isWide && styles.dockWide]}>
        {ringing ? (
          <View style={styles.incoming}>
            <View style={styles.ctlWrap}>
              <Control icon="close" label="Decline" big danger onPress={() => callService.endCall()} />
              <Text style={styles.ctlLabel}>Decline</Text>
            </View>
            <View style={styles.ctlWrap}>
              <Pressy onPress={() => callService.acceptCall()} scaleTo={0.88} style={styles.accept} accessibilityLabel="Accept">
                <Icon name="phone" size={30} color={Colors.ink} />
              </Pressy>
              <Text style={styles.ctlLabel}>Accept</Text>
            </View>
          </View>
        ) : isWide ? (
          <View style={styles.row}>
            <Control icon={muted ? 'micOff' : 'mic'} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={() => setMuted((m) => !m)} />
            <Control icon={videoOn ? 'video' : 'videoOff'} label="Camera" active={!videoOn} onPress={() => setVideoOn((v) => !v)} />
            <Control icon="cameraFlip" label="Flip" onPress={() => setFacing(facing === 'front' ? 'back' : 'front')} />
            <Control icon="speaker" label="Speaker" active={speaker} onPress={() => setSpeaker((s) => !s)} />
            <Control icon="phone" label="End call" danger onPress={() => callService.endCall()} />
          </View>
        ) : (
          <View style={{ alignItems: 'center', gap: 24, width: '100%' }}>
            <View style={styles.grid}>
              <Control icon="speaker" label="Speaker" active={speaker} onPress={() => setSpeaker((s) => !s)} />
              <Control icon={videoOn ? 'video' : 'videoOff'} label="Video" active={videoOn} onPress={() => setVideoOn((v) => !v)} />
              <Control icon={muted ? 'micOff' : 'mic'} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={() => setMuted((m) => !m)} />
            </View>
            <Control icon="phone" label="End call" big danger onPress={() => callService.endCall()} />
          </View>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: Colors.stage },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  minimise: {
    height: 44,
    minWidth: 44,
    paddingHorizontal: 12,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(12,14,13,0.45)',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 30, paddingHorizontal: 24 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  status: { fontFamily: Fonts.mono, fontSize: 17, color: '#D9D2C1' },
  dock: {
    marginHorizontal: 14,
    paddingVertical: 24,
    paddingHorizontal: 18,
    borderRadius: 34,
    backgroundColor: 'rgba(12,14,13,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(237,231,217,0.1)',
    alignItems: 'center',
  },
  dockWide: { alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 14, borderRadius: 30 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  grid: { flexDirection: 'row', justifyContent: 'space-around', width: '100%' },
  incoming: { flexDirection: 'row', justifyContent: 'space-around', width: '100%' },
  ctlWrap: { alignItems: 'center', gap: 8 },
  ctl: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(237,231,217,0.1)' },
  ctlLabel: { fontFamily: Fonts.medium, fontSize: 12.5, color: '#D9D2C1' },
  accept: { width: 76, height: 76, borderRadius: 38, backgroundColor: Colors.sage, alignItems: 'center', justifyContent: 'center' },
  self: {
    width: 240,
    height: 150,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: '#2A2F3A',
    borderWidth: 1,
    borderColor: 'rgba(237,231,217,0.12)',
  },
  selfLabel: {
    position: 'absolute',
    left: 12,
    bottom: 10,
    fontFamily: Fonts.medium,
    fontSize: 12,
    color: Colors.cream,
    backgroundColor: 'rgba(12,14,13,0.55)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
});
