import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeInUp, ZoomIn, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { callService, ActiveCall, CALL_MEDIA_AVAILABLE } from '../../src/features/calls/CallService';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Avatar, Grain, Icon, IconName, Pill, Pressy, Ripple, useLayout } from '../../src/shared/ui';

// The call stage stays dark in both themes: it's an immersive surface, like the camera.

function Level({ delay }: { delay: number }) {
  const { c } = useTheme();
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withDelay(delay, withRepeat(withSequence(withTiming(1, { duration: 420 }), withTiming(0, { duration: 420 })), -1));
  }, []);
  const a = useAnimatedStyle(() => ({ height: 4 + v.value * 10 }));
  return <Animated.View style={[{ width: 4, borderRadius: 2, backgroundColor: '#86C09F' }, a]} />;
}

function Control({ icon, label, active, onPress, big, danger, showLabel = true }: {
  icon: IconName;
  label: string;
  active?: boolean;
  onPress: () => void;
  big?: boolean;
  danger?: boolean;
  showLabel?: boolean;
}) {
  const { c } = useTheme();
  const s = useStyles();
  const size = big ? 76 : 64;
  return (
    <View style={s.ctlWrap}>
      <Pressy
        onPress={onPress}
        scaleTo={0.88}
        accessibilityLabel={label}
        accessibilityState={{ selected: active }}
        hoverStyle={!active && !danger ? { backgroundColor: 'rgba(237,231,217,0.18)' } : undefined}
        style={[
          s.ctl,
          { width: danger && !big ? 84 : size, height: size, borderRadius: big ? size / 2 : 22 },
          active && { backgroundColor: c.onStage },
          danger && { backgroundColor: c.dangerFill },
        ]}
      >
        <Icon
          name={icon}
          size={big ? 30 : 26}
          color={active ? '#0C0E0D' : danger ? c.onDanger : c.onStage}
          style={icon === 'phone' && danger ? { transform: [{ rotate: '135deg' }] } : undefined}
        />
      </Pressy>
      {showLabel && <Text style={s.ctlLabel}>{label}</Text>}
    </View>
  );
}

export default function CallScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [call, setCall] = useState<ActiveCall | null>(callService.getActiveCall());
  // Local control state — wired to real tracks once CALL_MEDIA_AVAILABLE lands.
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(true);
  const [videoOn, setVideoOn] = useState(callService.getActiveCall()?.callType === 'video');

  useEffect(() => {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      setTimeout(() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/calls')), 1200);
    };
    const unsub = callService.subscribe((current) => {
      setCall(current);
      if (!current || current.id !== id || ['ended', 'rejected', 'missed', 'failed'].includes(current.status)) leave();
    });
    return () => unsub();
  }, [id]);

  const name = call?.peerName || t('call.contact');
  const ringingIn = call?.status === 'ringing' && !call?.isInitiator;
  const connected = call?.status === 'connected';
  const d = call?.duration || 0;
  const status = connected
    ? `${String(Math.floor(d / 60)).padStart(2, '0')}:${String(d % 60).padStart(2, '0')}`
    : call?.status === 'ringing'
    ? call?.isInitiator
      ? t('call.ringing')
      : call?.callType === 'video'
      ? t('call.incomingVideo')
      : t('call.incomingVoice')
    : call?.status === 'calling'
    ? t('call.calling')
    : call?.status === 'ended'
    ? t('call.ended')
    : call?.status === 'rejected'
    ? t('call.declined')
    : call?.status === 'missed'
    ? t('call.noAnswer')
    : call?.status === 'failed'
    ? t('call.failed')
    : t('call.connecting');

  const avatarSize = isWide ? 180 : 150;
  const end = () => void callService.endCall();

  return (
    <View style={s.stage}>
      <Grain tone="light" opacity={0.08} />
      <View style={[s.top, { paddingTop: insets.top + 14 }]}>
        <Pressy onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))} style={s.minimise} accessibilityLabel={t('call.minimise')}>
          <Icon name={isWide ? 'back' : 'down'} size={20} color={c.onStage} />
          {isWide && <Text style={[type.label, { color: c.onStage }]}>{t('call.back')}</Text>}
        </Pressy>
        <Pill icon="lock" label={t('call.private')} tone="stage" />
        <View style={{ width: isWide ? 80 : 44 }} />
      </View>

      <View style={s.center}>
        <Animated.View entering={ZoomIn.springify().damping(14)}>
          <Ripple size={avatarSize} duration={2600}>
            <Avatar name={name} size={avatarSize} />
          </Ripple>
        </Animated.View>
        <Animated.View entering={FadeInDown.delay(100)} style={{ alignItems: 'center', gap: 10 }}>
          <Text style={[type.hero, s.name, { fontSize: isWide ? 44 : 34 }]}>{name}</Text>
          <View style={s.statusRow} accessibilityLiveRegion="polite">
            {connected && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: 14 }}>
                <Level delay={0} />
                <Level delay={150} />
                <Level delay={300} />
              </View>
            )}
            <Animated.Text key={connected ? 'clock' : status} entering={FadeIn} style={s.status}>
              {status}
            </Animated.Text>
          </View>
          {call?.callType === 'video' && !connected && <Text style={s.sub}>{t('call.videoCall')}</Text>}
          {muted && CALL_MEDIA_AVAILABLE && (
            <Animated.Text entering={FadeIn} style={[s.sub, { color: '#E7BD72' }]}>
              {t('call.muted')}
            </Animated.Text>
          )}
        </Animated.View>
      </View>

      <Animated.View entering={FadeInUp.delay(200).springify().damping(18)} style={[s.dock, { marginBottom: insets.bottom + 28 }, isWide && s.dockWide]}>
        {ringingIn ? (
          <View style={s.incoming}>
            <Control icon="close" label={t('call.decline')} big danger onPress={() => void callService.rejectCall()} />
            <View style={s.ctlWrap}>
              <Pressy onPress={() => void callService.acceptCall()} scaleTo={0.88} style={s.accept} accessibilityLabel={t('call.accept')}>
                <Icon name="phone" size={30} color="#0C0E0D" />
              </Pressy>
              <Text style={s.ctlLabel}>{t('call.accept')}</Text>
            </View>
          </View>
        ) : !CALL_MEDIA_AVAILABLE ? (
          <View style={{ alignItems: 'center', gap: 18, width: '100%' }}>
            <View style={s.note}>
              <Icon name="info" size={15} color={c.onStageMuted} />
              <Text style={s.noteText}>{t('call.noMedia')}</Text>
            </View>
            <Control icon="phone" label={t('call.end')} big danger showLabel={false} onPress={end} />
          </View>
        ) : isWide ? (
          <View style={s.row}>
            <Control icon={muted ? 'micOff' : 'mic'} label={muted ? t('call.unmute') : t('call.mute')} active={muted} onPress={() => setMuted((m) => !m)} />
            <Control icon={videoOn ? 'video' : 'videoOff'} label={t('call.camera')} active={!videoOn} onPress={() => setVideoOn((v) => !v)} />
            <Control icon="speaker" label={t('call.speaker')} active={speaker} onPress={() => setSpeaker((v) => !v)} />
            <Control icon="phone" label={t('call.end')} danger onPress={end} />
          </View>
        ) : (
          <View style={{ alignItems: 'center', gap: 24, width: '100%' }}>
            <View style={s.grid}>
              <Control icon="speaker" label={t('call.speaker')} active={speaker} onPress={() => setSpeaker((v) => !v)} />
              <Control icon={videoOn ? 'video' : 'videoOff'} label={t('call.camera')} active={videoOn} onPress={() => setVideoOn((v) => !v)} />
              <Control icon={muted ? 'micOff' : 'mic'} label={muted ? t('call.unmute') : t('call.mute')} active={muted} onPress={() => setMuted((m) => !m)} />
            </View>
            <Control icon="phone" label={t('call.end')} big danger showLabel={false} onPress={end} />
          </View>
        )}
      </Animated.View>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  stage: { flex: 1, backgroundColor: c.stage },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  minimise: { height: 44, minWidth: 44, paddingHorizontal: 12, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(12,14,13,0.45)' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 30, paddingHorizontal: 24 },
  name: { color: c.onStage, textAlign: 'center' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  status: { fontFamily: f.script === 'latin' ? f.mono : f.medium, fontSize: 17, color: c.onStageMuted },
  sub: { fontFamily: f.medium, fontSize: 13, color: c.onStageMuted },
  dock: { marginHorizontal: 14, paddingVertical: 24, paddingHorizontal: 18, borderRadius: 34, backgroundColor: 'rgba(12,14,13,0.55)', borderWidth: 1, borderColor: 'rgba(237,231,217,0.1)', alignItems: 'center' },
  dockWide: { alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 14, borderRadius: 30, minWidth: 360 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  grid: { flexDirection: 'row', justifyContent: 'space-around', width: '100%' },
  incoming: { flexDirection: 'row', justifyContent: 'space-around', width: '100%' },
  ctlWrap: { alignItems: 'center', gap: 8 },
  ctl: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(237,231,217,0.1)' },
  ctlLabel: { fontFamily: f.medium, fontSize: 12.5, color: c.onStageMuted },
  accept: { width: 76, height: 76, borderRadius: 38, backgroundColor: '#86C09F', alignItems: 'center', justifyContent: 'center' },
  note: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  noteText: { fontFamily: f.body, fontSize: 13, color: c.onStageMuted, textAlign: 'center', flexShrink: 1 },
}));
