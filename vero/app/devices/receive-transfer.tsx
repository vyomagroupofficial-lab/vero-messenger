import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, ScrollView, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { TransferReceiver } from '../../src/features/transfer/flows';
import { TransferCancelledError, TransferProgress } from '../../src/features/transfer/TransferService';
import { QrCodeView } from '../../src/features/linking/QrCodeView';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { friendlyError } from '../../src/core/network/supabase';
import { Button, Card, Note, ProgressBar, ScreenHeader, ui } from '../../src/features/linking/ui';
import { Colors } from '../../src/shared/theme/theme';

type Phase = 'preparing' | 'waiting' | 'receiving' | 'done' | 'error';

/** NEW phone: show a QR for the old phone, then import its chats. */
export default function ReceiveTransferScreen() {
  const isDemo = useAuthStore((s) => s.isDemo);
  const receiver = useRef<TransferReceiver | null>(null);
  const [phase, setPhase] = useState<Phase>('preparing');
  const [qr, setQr] = useState<string | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState(0);

  const run = useCallback(async (forceNew: boolean) => {
    const r = receiver.current ?? new TransferReceiver();
    receiver.current = r;
    setError(null);
    setPhase('preparing');
    try {
      const prepared = await r.prepare(forceNew);
      setQr(prepared.qr);
      setPhase(prepared.resumed ? 'receiving' : 'waiting');
      const result = await r.receive((p) => {
        setProgress(p);
        if (p.phase !== 'waiting') setPhase('receiving');
      });
      setRows(result.rows);
      setPhase('done');
      void useChatsStore.getState().load({ sync: true });
    } catch (e) {
      if (e instanceof TransferCancelledError) return;
      setError(friendlyError(e));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    if (isDemo) return;
    void run(false);
    return () => {
      // Leaving the screen stops polling; a started transfer can be resumed by opening it again.
      if (receiver.current) receiver.current.cancel.cancelled = true;
      receiver.current = null;
    };
  }, [isDemo, run]);

  const startOver = async () => {
    await receiver.current?.abort();
    receiver.current = null;
    void run(true);
  };

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title="Receive chats" />
      <ScrollView contentContainerStyle={ui.content}>
        {isDemo ? (
          <Note icon="sparkles">Transfers need a real account.</Note>
        ) : phase === 'preparing' ? (
          <ActivityIndicator color={Colors.accent} style={{ marginTop: 40 }} />
        ) : phase === 'waiting' && qr ? (
          <>
            <Card style={ui.center}>
              <QrCodeView value={qr} size={250} />
              <Text style={ui.body}>
                On your OLD phone open Settings → Devices & transfer → "Transfer chats to a new phone" and scan this code.
              </Text>
            </Card>
            <Note icon="lock-closed-outline">
              The old phone encrypts everything to a one-time key that exists only on this phone. Private keys are not
              copied: this phone already has its own.
            </Note>
          </>
        ) : phase === 'receiving' ? (
          <Card style={ui.center}>
            <Ionicons name="cloud-download-outline" size={40} color={Colors.accent} />
            <Text style={ui.title}>Receiving chats…</Text>
            <ProgressBar value={progress?.total ? progress.done / progress.total : null} />
            <Text style={ui.muted}>
              {progress?.phase === 'importing'
                ? 'Decrypting and saving…'
                : progress?.phase === 'waiting' || !progress
                  ? 'Waiting for the old phone…'
                  : `${progress.done}${progress.total ? ` of ${progress.total}` : ''} parts downloaded`}
            </Text>
            <Text style={ui.muted}>If the connection drops, reopen this screen to resume.</Text>
          </Card>
        ) : phase === 'done' ? (
          <>
            <Card style={ui.center}>
              <Ionicons name="checkmark-circle" size={48} color={Colors.emerald} />
              <Text style={ui.title}>Chats transferred</Text>
              <Text style={ui.body}>{rows} items imported. Media will download again when you open it.</Text>
            </Card>
            <Button label="Go to chats" onPress={() => router.replace('/(tabs)/chats')} />
          </>
        ) : (
          <>
            <Note icon="alert-circle" tone="warning">{error || 'Something went wrong.'}</Note>
            <Button label="Try again" icon="refresh" onPress={() => void run(false)} />
            <Button label="Start over with a new code" variant="secondary" onPress={() => void startOver()} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
