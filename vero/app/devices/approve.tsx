import React, { useEffect, useRef, useState } from 'react';
import { Text, ScrollView, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { takeHandOff } from '../../src/features/linking/scanHandoff';
import { deviceLinkApi } from '../../src/features/linking/deviceLinkApi';
import { approveLinkAndSendHistory } from '../../src/features/transfer/flows';
import type { TransferProgress } from '../../src/features/transfer/TransferService';
import { friendlyError } from '../../src/core/network/supabase';
import { Button, Card, Note, ProgressBar, ScreenHeader, ui } from '../../src/features/linking/ui';
import { Colors } from '../../src/shared/theme/theme';

type Phase = 'loading' | 'confirm' | 'approving' | 'sending' | 'done' | 'error';

/** Signed-in phone: confirm and approve a new web/desktop device. */
export default function ApproveLinkScreen() {
  const [payload] = useState(() => takeHandOff('link'));
  const [phase, setPhase] = useState<Phase>('loading');
  const [label, setLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const cancel = useRef({ cancelled: false });

  useEffect(() => {
    if (!payload) {
      setError('Scan the code shown on the device you want to link.');
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
        setError(e?.status === 404 ? 'This code has expired or was already used. Show a new code and scan again.' : friendlyError(e));
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
      await approveLinkAndSendHistory(payload, {
        onApproved: () => setPhase('sending'),
        onProgress: setProgress,
        cancel: cancel.current,
      });
      setPhase('done');
    } catch (e) {
      setError(friendlyError(e));
      setPhase('error');
    }
  };

  const value = progress?.total ? progress.done / progress.total : null;

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title="Link new device" />
      <ScrollView contentContainerStyle={ui.content}>
        {phase === 'loading' && <ActivityIndicator color={Colors.accent} />}
        {phase === 'confirm' && (
          <>
            <Card style={ui.center}>
              <Ionicons name="desktop-outline" size={44} color={Colors.accent} />
              <Text style={ui.title}>Link {label || 'this device'}?</Text>
              <Text style={ui.body}>
                It will be signed in to your account, get its own encryption keys and receive your recent chats
                (encrypted for it only).
              </Text>
            </Card>
            <Note icon="warning-outline" tone="warning">
              Only link devices you own and are in front of. Anyone with access to a linked device can read your
              messages. You can unlink it any time in Settings → Linked devices.
            </Note>
            <Button label="Link device" icon="link" onPress={approve} />
            <Button label="Cancel" variant="secondary" onPress={() => router.back()} />
          </>
        )}
        {(phase === 'approving' || phase === 'sending') && (
          <Card style={ui.center}>
            <ActivityIndicator color={Colors.accent} />
            <Text style={ui.title}>{phase === 'approving' ? 'Approving…' : 'Sending recent chats…'}</Text>
            {phase === 'sending' && (
              <>
                <ProgressBar value={value} />
                <Text style={ui.muted}>
                  {progress?.phase === 'preparing' || !progress ? 'Encrypting…' : `${progress.done} of ${progress.total ?? '?'} parts`}
                </Text>
                <Text style={ui.muted}>Keep Vero open until this finishes.</Text>
              </>
            )}
          </Card>
        )}
        {phase === 'done' && (
          <>
            <Card style={ui.center}>
              <Ionicons name="checkmark-circle" size={48} color={Colors.emerald} />
              <Text style={ui.title}>Device linked</Text>
              <Text style={ui.body}>It now appears in your linked devices.</Text>
            </Card>
            <Button label="Done" onPress={() => router.back()} />
          </>
        )}
        {phase === 'error' && (
          <>
            <Note icon="alert-circle" tone="warning">{error}</Note>
            <Button label="Scan again" icon="scan-outline" onPress={() => router.replace({ pathname: '/qr/scan', params: { expect: 'link' } })} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
