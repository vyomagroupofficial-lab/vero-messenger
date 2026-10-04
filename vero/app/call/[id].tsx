import React, { useEffect, useState } from 'react';
import { StatusBar, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeInUp, ZoomIn, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { callService, ActiveCall, callMediaUnavailableReason } from '../../src/features/calls/CallService';
import { CallButton, CallControls } from '../../src/features/calls/components/CallControls';
import { CallStage, callHasStage } from '../../src/features/calls/components/CallStage';
import { callStatusText } from '../../src/features/calls/components/callText';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Avatar, Grain, Icon, Pill, Pressy, Ripple, useLayout } from '../../src/shared/ui';

// The call stage stays dark in both themes: it's an immersive surface, like the camera.

function Level({ delay }: { delay: number }) {
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withDelay(delay, withRepeat(withSequence(withTiming(1, { duration: 420 }), withTiming(0, { duration: 420 })), -1));
  }, []);
  const a = useAnimatedStyle(() => ({ height: 4 + v.value * 10 }));
  return <Animated.View style={[{ width: 4, borderRadius: 2, backgroundColor: '#86C09F' }, a]} />;
}

export default function CallScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [call, setCall] = useState<ActiveCall | null>(callService.getActiveCall());

  useEffect(() => {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      const failed = callService.getActiveCall()?.status === 'failed';
      setTimeout(() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/calls')), failed ? 2500 : 1200);
    };
    const unsub = callService.subscribe((current) => {
      setCall(current);
      if (!current || current.id !== id || ['ended', 'rejected', 'missed', 'failed'].includes(current.status)) leave();
    });
    return () => unsub();
  }, [id]);

  const group = call?.kind === 'group';
  const name = call?.peerName || t('call.contact');
  const ringingIn = call?.status === 'ringing' && !call?.isInitiator;
  const connected = call?.status === 'connected';
  const status =
    group && call?.status === 'ringing' && !call.isInitiator
      ? t('call.groupRinging', { name: call.inviterName ?? t('common.someone') })
      : callStatusText(t, call);
  const stage = callHasStage(call);
  const mediaNote = callMediaUnavailableReason();
  const avatarSize = isWide ? 180 : 150;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      <Grain tone="light" opacity={0.08} />
      <View style={[s.top, { paddingTop: insets.top + 14 }]}>
        <Pressy onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))} style={s.minimise} accessibilityLabel={t('call.minimise')}>
          <Icon name={isWide ? 'back' : 'down'} size={20} color={c.onStage} />
          {isWide && <Text style={[type.label, { color: c.onStage }]}>{t('call.back')}</Text>}
        </Pressy>
        <Pill icon="lock" label={t('call.private')} tone="stage" />
        <View style={{ width: isWide ? 80 : 44 }} />
      </View>

      {stage && call ? (
        <Animated.View entering={FadeIn.duration(300)} style={[s.stage, isWide && s.stageWide]}>
          <CallStage call={call} />
          <View style={s.stageStatus} accessibilityLiveRegion="polite">
            {connected && <View style={s.liveDot} />}
            <Text style={s.stageStatusText} numberOfLines={1}>
              {group ? `${name} · ` : ''}
              {status}
            </Text>
          </View>
        </Animated.View>
      ) : (
        <View style={s.center}>
          <Animated.View entering={ZoomIn.springify().damping(14)}>
            <Ripple size={avatarSize} duration={2600}>
              <Avatar name={name} size={avatarSize} square={group} icon={group ? 'users' : undefined} />
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
            {call?.callType === 'video' && !connected && (
              <View style={s.badge}>
                <Icon name="video" size={14} color={c.onStageMuted} />
                <Text style={s.sub}>{t('call.videoCall')}</Text>
              </View>
            )}
            {call?.local.micMuted && connected && (
              <Animated.Text entering={FadeIn} style={[s.sub, { color: '#E7BD72' }]}>
                {t('call.muted')}
              </Animated.Text>
            )}
          </Animated.View>
        </View>
      )}

      <Animated.View entering={FadeInUp.delay(200).springify().damping(18)} style={[s.dock, { marginBottom: insets.bottom + (isWide ? 24 : 20) }, isWide && s.dockWide]}>
        {ringingIn ? (
          <View style={s.incoming}>
            <CallButton icon="close" label={t('call.decline')} big danger onPress={() => void callService.rejectCall()} />
            <View style={s.acceptWrap}>
              <Pressy onPress={() => void callService.acceptCall()} scaleTo={0.88} style={s.accept} accessibilityLabel={group ? t('call.join') : t('call.accept')}>
                <Icon name={call?.callType === 'video' ? 'video' : 'phone'} size={30} color="#0C0E0D" />
              </Pressy>
              <Text style={s.acceptLabel}>{group ? t('call.join') : t('call.accept')}</Text>
            </View>
          </View>
        ) : (
          <View style={{ alignItems: 'center', gap: 16, width: '100%' }}>
            {!!mediaNote && (
              <View style={s.note}>
                <Icon name="info" size={15} color={c.onStageMuted} />
                <Text style={s.noteText}>{mediaNote}</Text>
              </View>
            )}
            {call && <CallControls call={call} />}
          </View>
        )}
      </Animated.View>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  root: { flex: 1, backgroundColor: c.stage },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  minimise: { height: 44, minWidth: 44, paddingHorizontal: 12, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(12,14,13,0.45)' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 30, paddingHorizontal: 24 },
  stage: { flex: 1, marginHorizontal: 10, marginTop: 14, marginBottom: 12, gap: 10 },
  stageWide: { width: '100%', maxWidth: 1180, alignSelf: 'center', paddingHorizontal: 24 },
  stageStatus: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  stageStatusText: { fontFamily: f.script === 'latin' ? f.mono : f.medium, fontSize: 14, color: c.onStageMuted },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#86C09F' },
  name: { color: c.onStage, textAlign: 'center' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  status: { fontFamily: f.script === 'latin' ? f.mono : f.medium, fontSize: 17, color: c.onStageMuted },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sub: { fontFamily: f.medium, fontSize: 13, color: c.onStageMuted },
  dock: { marginHorizontal: 14, paddingVertical: 22, paddingHorizontal: 16, borderRadius: 34, backgroundColor: 'rgba(12,14,13,0.55)', borderWidth: 1, borderColor: 'rgba(237,231,217,0.1)', alignItems: 'center' },
  dockWide: { alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 18, borderRadius: 30, minWidth: 380 },
  incoming: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', minWidth: 280 },
  acceptWrap: { alignItems: 'center', gap: 8 },
  accept: { width: 74, height: 74, borderRadius: 37, backgroundColor: '#86C09F', alignItems: 'center', justifyContent: 'center' },
  acceptLabel: { fontFamily: f.medium, fontSize: 12, color: c.onStageMuted },
  note: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, maxWidth: 520 },
  noteText: { fontFamily: f.body, fontSize: 13, color: c.onStageMuted, textAlign: 'center', flexShrink: 1 },
}));
