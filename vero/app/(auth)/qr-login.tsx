import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { isSupabaseConfigured } from '../../src/core/network/supabase';
import { NewDeviceLinkSession, LinkState } from '../../src/features/linking/NewDeviceLink';
import { QrCodeView } from '../../src/features/linking/QrCodeView';
import { Button, Card, Note, ProgressBar, ScreenHeader, ui } from '../../src/features/linking/ui';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { Colors, Spacing, Typography } from '../../src/shared/theme/theme';

function useCountdown(until?: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.round((until - now) / 1000)) : 0;
}

/** Signed-out device: show a QR code, let a signed-in phone approve it. */
export default function QrLoginScreen() {
  const [state, setState] = useState<LinkState>({ phase: 'creating' });
  const session = useRef<NewDeviceLinkSession | null>(null);
  const secondsLeft = useCountdown(state.phase === 'waiting' ? state.expiresAt : undefined);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    const s = new NewDeviceLinkSession(setState);
    session.current = s;
    void s.start();
    return () => s.stop();
  }, []);

  useEffect(() => {
    if (state.phase !== 'done') return;
    void useChatsStore.getState().load({ sync: true });
    const t = setTimeout(() => router.replace('/(tabs)/chats'), state.historyFailed ? 2500 : 800);
    return () => clearTimeout(t);
  }, [state.phase, state.historyFailed]);

  const progress = state.progress;
  const progressValue = progress?.total ? progress.done / progress.total : null;

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title="Link with QR code" onBack={() => router.replace('/(auth)/login')} />
      <ScrollView contentContainerStyle={ui.content}>
        {!isSupabaseConfigured ? (
          <Note tone="warning">This build has no Vero server configured.</Note>
        ) : state.phase === 'creating' || (state.phase === 'waiting' && !state.qr) ? (
          <ActivityIndicator color={Colors.accent} style={{ marginTop: 60 }} />
        ) : state.phase === 'waiting' && state.qr ? (
          <>
            <Card style={ui.center}>
              <QrCodeView value={state.qr} size={260} />
              <Text style={ui.muted}>Code refreshes in {secondsLeft}s</Text>
            </Card>
            <Card>
              {[
                'Open Vero on your phone',
                'Go to Settings → Devices & transfer → Link a device',
                'Point your phone at this code and confirm',
              ].map((step, i) => (
                <View key={step} style={styles.step}>
                  <View style={styles.stepNum}>
                    <Text style={styles.stepNumText}>{i + 1}</Text>
                  </View>
                  <Text style={styles.stepText}>{step}</Text>
                </View>
              ))}
            </Card>
            <Note icon="key-outline">
              This device creates its own encryption keys. Your password and your phone's private keys are never
              shared; your phone sends recent chats encrypted to a one-time key in this code.
            </Note>
          </>
        ) : state.phase === 'signing-in' ? (
          <Card style={ui.center}>
            <ActivityIndicator color={Colors.accent} />
            <Text style={ui.title}>Approved - signing in…</Text>
          </Card>
        ) : state.phase === 'history' ? (
          <Card style={ui.center}>
            <Ionicons name="cloud-download-outline" size={40} color={Colors.accent} />
            <Text style={ui.title}>Receiving recent chats</Text>
            <Text style={ui.body}>
              {progress?.phase === 'waiting' || !progress
                ? 'Waiting for your phone to encrypt your recent messages…'
                : progress.phase === 'importing'
                  ? 'Decrypting and saving…'
                  : `Downloaded ${progress.done}${progress.total ? ` of ${progress.total}` : ''} parts`}
            </Text>
            <ProgressBar value={progressValue} />
            <Button label="Skip" variant="secondary" onPress={() => session.current?.skipHistory()} />
            <Text style={ui.muted}>Skipping means older messages won't be readable on this device.</Text>
          </Card>
        ) : state.phase === 'done' ? (
          <Card style={ui.center}>
            <Ionicons name="checkmark-circle" size={48} color={Colors.emerald} />
            <Text style={ui.title}>Device linked</Text>
            {state.historyFailed && <Text style={ui.body}>Recent chats couldn't be transferred; new messages will arrive normally.</Text>}
          </Card>
        ) : (
          <>
            <Note icon="alert-circle" tone="warning">{state.error || 'Something went wrong.'}</Note>
            <Button label="New code" icon="refresh" onPress={() => void session.current?.restart()} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  step: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  stepNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: Colors.accentSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: { color: Colors.accentLight, fontWeight: Typography.bold, fontSize: Typography.sm },
  stepText: { flex: 1, color: Colors.textSecondary, fontSize: Typography.sm },
});
