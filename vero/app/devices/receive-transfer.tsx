import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TransferReceiver } from '../../src/features/transfer/flows';
import { TransferCancelledError, TransferProgress } from '../../src/features/transfer/TransferService';
import { QrCodeView } from '../../src/features/linking/QrCodeView';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { friendlyError } from '../../src/core/network/supabase';
import { FlowCard, Note, ProgressBar, ScreenHeader, useLinkStyles } from '../../src/features/linking/ui';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button } from '../../src/shared/ui';

type Phase = 'preparing' | 'waiting' | 'receiving' | 'done' | 'error';

/** NEW phone: show a QR for the old phone, then import its chats. */
export default function ReceiveTransferScreen() {
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const ui = useLinkStyles();
  const s = useStyles();
  const t = useT();
  const isDemo = useAuthStore((st) => st.isDemo);
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

  const status =
    progress?.phase === 'importing'
      ? t('transfer.importing')
      : progress?.phase === 'waiting' || !progress
      ? t('transfer.waitingOld')
      : progress.total
      ? t('transfer.downloadedOf', { done: progress.done, total: progress.total })
      : t('transfer.downloaded', { done: progress.done });

  return (
    <View style={[ui.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('transfer.receiveTitle')} />
      <ScrollView contentContainerStyle={[ui.content, { paddingBottom: insets.bottom + 40 }]}>
        {isDemo ? (
          <Note icon="info">{t('transfer.demo')}</Note>
        ) : phase === 'preparing' ? (
          <ActivityIndicator color={c.accent} style={{ marginTop: 40 }} />
        ) : phase === 'waiting' && qr ? (
          <>
            <Animated.View entering={ZoomIn.springify().damping(15)} style={s.card}>
              <View style={s.qrFrame}>
                <QrCodeView value={qr} size={240} />
              </View>
              <Text style={[type.body, { textAlign: 'center', color: c.muted }]}>{t('transfer.receiveHint')}</Text>
            </Animated.View>
            <Note icon="lock">{t('transfer.receiveNote')}</Note>
          </>
        ) : phase === 'receiving' ? (
          <FlowCard icon="download" title={t('transfer.receiving')}>
            <View style={{ alignSelf: 'stretch', gap: 8, alignItems: 'center' }}>
              <ProgressBar value={progress?.total ? progress.done / progress.total : null} />
              <Text style={type.caption}>{status}</Text>
              <Text style={type.caption}>{t('transfer.resumeHint')}</Text>
            </View>
          </FlowCard>
        ) : phase === 'done' ? (
          <>
            <FlowCard icon="check" tone="success" title={t('transfer.received')} body={t('transfer.receivedBody', { count: rows })} />
            <Button label={t('transfer.goToChats')} iconRight="arrowRight" onPress={() => router.replace('/(tabs)/chats')} />
          </>
        ) : (
          <>
            <FlowCard icon="info" tone="danger" title={t('transfer.failed')} body={error || t('transfer.somethingWrong')} />
            <Button label={t('common.retry')} onPress={() => void run(false)} />
            <Button label={t('transfer.startOver')} variant="secondary" onPress={() => void startOver()} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  card: { alignItems: 'center', gap: 16, padding: 22, borderRadius: 28, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line },
  qrFrame: { padding: 14, borderRadius: 24, backgroundColor: '#FFFFFF', borderWidth: 3, borderColor: c.accent },
}));
