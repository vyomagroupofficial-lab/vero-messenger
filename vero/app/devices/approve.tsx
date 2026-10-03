import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { takeHandOff } from '../../src/features/linking/scanHandoff';
import { deviceLinkApi } from '../../src/features/linking/deviceLinkApi';
import { approveLinkAndSendHistory } from '../../src/features/transfer/flows';
import type { TransferProgress } from '../../src/features/transfer/TransferService';
import { friendlyError } from '../../src/core/network/supabase';
import { FlowCard, Note, ProgressBar, ScreenHeader, useLinkStyles } from '../../src/features/linking/ui';
import { useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button } from '../../src/shared/ui';

type Phase = 'loading' | 'confirm' | 'approving' | 'sending' | 'done' | 'error';

/** Signed-in phone: confirm and approve a new web/desktop device. */
export default function ApproveLinkScreen() {
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const ui = useLinkStyles();
  const t = useT();
  const [payload] = useState(() => takeHandOff('link'));
  const [phase, setPhase] = useState<Phase>('loading');
  const [label, setLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const cancel = useRef({ cancelled: false });

  useEffect(() => {
    if (!payload) {
      setError(t('approve.scanFirst'));
      setPhase('error');
      return;
    }
    deviceLinkApi
      .inspect(payload.linkId)
      .then((info) => {
        setLabel(info.deviceLabel);
        setPhase('confirm');
      })
      .catch((e) => {
        setError(e?.status === 404 ? t('approve.expired') : friendlyError(e));
        setPhase('error');
      });
    return () => {
      cancel.current.cancelled = true;
    };
  }, [payload]);

  const approve = async () => {
    if (!payload) return;
    setPhase('approving');
    try {
      await approveLinkAndSendHistory(payload, { onApproved: () => setPhase('sending'), onProgress: setProgress, cancel: cancel.current });
      setPhase('done');
    } catch (e) {
      setError(friendlyError(e));
      setPhase('error');
    }
  };

  const value = progress?.total ? progress.done / progress.total : null;

  return (
    <View style={[ui.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('approve.title')} />
      <ScrollView contentContainerStyle={[ui.content, { paddingBottom: insets.bottom + 40 }]}>
        {phase === 'loading' && <ActivityIndicator color={c.accent} style={{ marginTop: 40 }} />}
        {phase === 'confirm' && (
          <>
            <FlowCard icon="laptop" title={t('approve.confirm', { name: label || t('approve.thisDevice') })} body={t('approve.confirmBody')} />
            <Note icon="info" tone="warning">
              {t('approve.warning')}
            </Note>
            <Button label={t('approve.link')} icon="link" onPress={approve} />
            <Button label={t('common.cancel')} variant="secondary" onPress={() => router.back()} />
          </>
        )}
        {(phase === 'approving' || phase === 'sending') && (
          <FlowCard icon="laptop" title={phase === 'approving' ? t('approve.approving') : t('approve.sending')}>
            {phase === 'sending' ? (
              <View style={{ alignSelf: 'stretch', gap: 8, alignItems: 'center' }}>
                <ProgressBar value={value} />
                <Text style={type.caption}>{progress?.phase === 'preparing' || !progress ? t('transfer.encrypting') : t('transfer.parts', { done: progress.done, total: progress.total ?? '?' })}</Text>
                <Text style={type.caption}>{t('transfer.keepOpen')}</Text>
              </View>
            ) : (
              <ActivityIndicator color={c.accent} />
            )}
          </FlowCard>
        )}
        {phase === 'done' && (
          <>
            <FlowCard icon="check" tone="success" title={t('approve.done')} body={t('approve.doneBody')} />
            <Button label={t('common.done')} onPress={() => router.back()} />
          </>
        )}
        {phase === 'error' && (
          <>
            <FlowCard icon="info" tone="danger" title={t('approve.failed')} body={error ?? undefined} />
            <Button label={t('approve.scanAgain')} icon="scan" onPress={() => router.replace({ pathname: '/qr/scan', params: { expect: 'link' } })} />
          </>
        )}
      </ScrollView>
    </View>
  );
}
