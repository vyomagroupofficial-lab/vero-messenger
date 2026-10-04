import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, ZoomIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isSupabaseConfigured } from '../../src/core/network/supabase';
import { NewDeviceLinkSession, LinkState } from '../../src/features/linking/NewDeviceLink';
import { QrCodeView } from '../../src/features/linking/QrCodeView';
import { FlowCard, Note, ProgressBar, ScreenHeader, useLinkStyles } from '../../src/features/linking/ui';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button, DotWall, Wordmark, useLayout } from '../../src/shared/ui';

function useCountdown(until?: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, Math.round((until - now) / 1000)) : 0;
}

/** Signed-out device: show a QR code, let a signed-in phone approve it. */
export default function QrLoginScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { c, type } = useTheme();
  const ui = useLinkStyles();
  const s = useStyles();
  const t = useT();
  const [state, setState] = useState<LinkState>({ phase: 'creating' });
  const session = useRef<NewDeviceLinkSession | null>(null);
  const secondsLeft = useCountdown(state.phase === 'waiting' ? state.expiresAt : undefined);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    const sess = new NewDeviceLinkSession(setState);
    session.current = sess;
    void sess.start();
    return () => sess.stop();
  }, []);

  useEffect(() => {
    if (state.phase !== 'done') return;
    void useChatsStore.getState().load({ sync: true });
    const timer = setTimeout(() => router.replace('/(tabs)/chats'), state.historyFailed ? 2500 : 800);
    return () => clearTimeout(timer);
  }, [state.phase, state.historyFailed]);

  const progress = state.progress;
  const progressValue = progress?.total ? progress.done / progress.total : null;
  const steps = [t('qrLogin.step1'), t('qrLogin.step2'), t('qrLogin.step3')];

  const waiting = state.phase === 'waiting' && state.qr ? (
    <View style={[s.split, isWide && s.splitWide]}>
      <Animated.View entering={ZoomIn.springify().damping(15)} style={s.qrCard}>
        <View style={s.qrFrame}>
          <QrCodeView value={state.qr} size={isWide ? 280 : 240} />
        </View>
        <Animated.Text key={String(secondsLeft > 10)} entering={FadeIn} style={[type.caption, secondsLeft <= 10 && { color: c.accentText }]}>
          {t('qrLogin.refreshes', { count: secondsLeft })}
        </Animated.Text>
      </Animated.View>
      <View style={{ flex: isWide ? 1 : undefined, gap: 18, minWidth: 0 }}>
        {isWide && <Text style={[type.hero, { fontSize: 36, lineHeight: 42 }]}>{t('qrLogin.headline')}</Text>}
        <View style={{ gap: 14 }}>
          {steps.map((step, i) => (
            <Animated.View key={step} entering={FadeInDown.delay(120 + i * 70)} style={s.step}>
              <View style={s.stepNum}>
                <Text style={s.stepNumText}>{i + 1}</Text>
              </View>
              <Text style={[type.body, { flex: 1 }]}>{step}</Text>
            </Animated.View>
          ))}
        </View>
        <Note icon="key">{t('qrLogin.keysNote')}</Note>
      </View>
    </View>
  ) : null;

  return (
    <View style={[ui.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('auth.qrLogin')} onBack={() => router.replace('/(auth)/login')} />
      <View style={{ flex: 1 }}>
        <DotWall />
        <ScrollView contentContainerStyle={[ui.content, isWide && { maxWidth: 960, paddingTop: 48 }, { paddingBottom: insets.bottom + 40 }]}>
          {isWide && (
            <View style={{ alignItems: 'flex-start', marginBottom: 8 }}>
              <Wordmark size={30} />
            </View>
          )}
          {!isSupabaseConfigured ? (
            <Note tone="warning">{t('qrLogin.noServer')}</Note>
          ) : state.phase === 'creating' || (state.phase === 'waiting' && !state.qr) ? (
            <ActivityIndicator color={c.accent} style={{ marginTop: 60 }} />
          ) : state.phase === 'waiting' ? (
            waiting
          ) : state.phase === 'signing-in' ? (
            <FlowCard icon="check" tone="success" title={t('qrLogin.signingIn')}>
              <ActivityIndicator color={c.accent} />
            </FlowCard>
          ) : state.phase === 'history' ? (
            <FlowCard
              icon="download"
              title={t('qrLogin.receiving')}
              body={
                progress?.phase === 'waiting' || !progress
                  ? t('qrLogin.waitingPhone')
                  : progress.phase === 'importing'
                  ? t('transfer.importing')
                  : progress.total
                  ? t('transfer.downloadedOf', { done: progress.done, total: progress.total })
                  : t('transfer.downloaded', { done: progress.done })
              }
            >
              <ProgressBar value={progressValue} />
              <Button label={t('qrLogin.skip')} variant="secondary" size="md" onPress={() => session.current?.skipHistory()} />
              <Text style={[type.caption, { textAlign: 'center' }]}>{t('qrLogin.skipNote')}</Text>
            </FlowCard>
          ) : state.phase === 'done' ? (
            <FlowCard icon="check" tone="success" title={t('approve.done')} body={state.historyFailed ? t('qrLogin.historyFailed') : undefined} />
          ) : (
            <>
              <FlowCard icon="info" tone="danger" title={t('qrLogin.failed')} body={state.error || t('transfer.somethingWrong')} />
              <Button label={t('qrLogin.newCode')} icon="qr" onPress={() => void session.current?.restart()} />
            </>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  split: { gap: 20 },
  splitWide: { flexDirection: 'row', alignItems: 'center', gap: 48 },
  qrCard: { alignItems: 'center', gap: 14, padding: 22, borderRadius: 30, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line },
  qrFrame: { padding: 14, borderRadius: 24, backgroundColor: '#FFFFFF', borderWidth: 3, borderColor: c.accent },
  step: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stepNum: { width: 34, height: 34, borderRadius: 12, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2, alignItems: 'center', justifyContent: 'center' },
  stepNumText: { fontFamily: f.display, fontSize: 16, color: c.accentText },
}));
