import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { takeHandOff } from '../../src/features/linking/scanHandoff';
import { approveTransferAndSend } from '../../src/features/transfer/flows';
import type { TransferProgress } from '../../src/features/transfer/TransferService';
import { friendlyError } from '../../src/core/network/supabase';
import { FlowCard, Note, ProgressBar, ScreenHeader, useLinkStyles } from '../../src/features/linking/ui';
import { useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button } from '../../src/shared/ui';

type Phase = 'confirm' | 'sending' | 'done' | 'error';

/** OLD phone: send the whole local chat history to the new phone. */
export default function SendTransferScreen() {
  const insets = useSafeAreaInsets();
  const { type } = useTheme();
  const ui = useLinkStyles();
  const t = useT();
  const [payload] = useState(() => takeHandOff('transfer'));
  const [phase, setPhase] = useState<Phase>(payload ? 'confirm' : 'error');
  const [error, setError] = useState<string | null>(payload ? null : t('transfer.scanFirst'));
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const cancel = useRef({ cancelled: false });

  useEffect(
    () => () => {
      cancel.current.cancelled = true;
    },
    []
  );

  const send = async () => {
    if (!payload) return;
    setPhase('sending');
    try {
      await approveTransferAndSend(payload, { onProgress: setProgress, cancel: cancel.current });
      setPhase('done');
    } catch (e) {
      setError(friendlyError(e));
      setPhase('error');
    }
  };

  return (
    <View style={[ui.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('scan.title_transfer')} />
      <ScrollView contentContainerStyle={[ui.content, { paddingBottom: insets.bottom + 40 }]}>
        {phase === 'confirm' && (
          <>
            <FlowCard icon="smartphone" title={t('transfer.sendTitle')} body={t('transfer.sendBody')} />
            <Note icon="key">{t('transfer.keysNote')}</Note>
            <Button label={t('transfer.start')} icon="cloudUp" onPress={send} />
            <Button label={t('common.cancel')} variant="secondary" onPress={() => router.back()} />
          </>
        )}
        {phase === 'sending' && (
          <FlowCard icon="cloudUp" title={t('transfer.sending')}>
            <View style={{ alignSelf: 'stretch', gap: 8, alignItems: 'center' }}>
              <ProgressBar value={progress?.total ? progress.done / progress.total : null} />
              <Text style={type.caption}>{progress?.phase === 'preparing' || !progress ? t('transfer.encryptingChats') : t('transfer.uploaded', { done: progress.done, total: progress.total ?? '?' })}</Text>
              <Text style={type.caption}>{t('transfer.keepBothOpen')}</Text>
            </View>
          </FlowCard>
        )}
        {phase === 'done' && (
          <>
            <FlowCard icon="check" tone="success" title={t('transfer.sent')} body={t('transfer.sentBody')} />
            <Button label={t('common.done')} onPress={() => router.back()} />
          </>
        )}
        {phase === 'error' && (
          <>
            <FlowCard icon="info" tone="danger" title={t('transfer.failed')} body={error ?? undefined} />
            <Button label={t('approve.scanAgain')} icon="scan" onPress={() => router.replace({ pathname: '/qr/scan', params: { expect: 'transfer' } })} />
          </>
        )}
      </ScrollView>
    </View>
  );
}
