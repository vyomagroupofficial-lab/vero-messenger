import React, { useEffect, useRef, useState } from 'react';
import { Text, ScrollView, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { takeHandOff } from '../../src/features/linking/scanHandoff';
import { approveTransferAndSend } from '../../src/features/transfer/flows';
import type { TransferProgress } from '../../src/features/transfer/TransferService';
import { friendlyError } from '../../src/core/network/supabase';
import { Button, Card, Note, ProgressBar, ScreenHeader, ui } from '../../src/features/linking/ui';
import { Colors } from '../../src/shared/theme/theme';

type Phase = 'confirm' | 'sending' | 'done' | 'error';

/** OLD phone: send the whole local chat history to the new phone. */
export default function SendTransferScreen() {
  const [payload] = useState(() => takeHandOff('transfer'));
  const [phase, setPhase] = useState<Phase>(payload ? 'confirm' : 'error');
  const [error, setError] = useState<string | null>(payload ? null : 'Scan the code shown on your new phone.');
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const cancel = useRef({ cancelled: false });

  useEffect(() => () => {
    cancel.current.cancelled = true;
  }, []);

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
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title="Transfer chats" />
      <ScrollView contentContainerStyle={ui.content}>
        {phase === 'confirm' && (
          <>
            <Card style={ui.center}>
              <Ionicons name="phone-portrait-outline" size={44} color={Colors.accent} />
              <Text style={ui.title}>Send your chats to the new phone?</Text>
              <Text style={ui.body}>
                All messages and chat settings on this phone are encrypted to a one-time key from the QR code and
                uploaded in parts. Only the new phone can decrypt them; the server deletes them after the import (or
                within an hour).
              </Text>
            </Card>
            <Note icon="key-outline">
              Your private keys stay on this phone. The new phone registers its own keys, so contacts will see that
              your safety number changed.
            </Note>
            <Button label="Start transfer" icon="cloud-upload-outline" onPress={send} />
            <Button label="Cancel" variant="secondary" onPress={() => router.back()} />
          </>
        )}
        {phase === 'sending' && (
          <Card style={ui.center}>
            <ActivityIndicator color={Colors.accent} />
            <Text style={ui.title}>Sending…</Text>
            <ProgressBar value={progress?.total ? progress.done / progress.total : null} />
            <Text style={ui.muted}>
              {progress?.phase === 'preparing' || !progress ? 'Encrypting your chats…' : `${progress.done} of ${progress.total ?? '?'} parts uploaded`}
            </Text>
            <Text style={ui.muted}>Keep Vero open on both phones.</Text>
          </Card>
        )}
        {phase === 'done' && (
          <>
            <Card style={ui.center}>
              <Ionicons name="checkmark-circle" size={48} color={Colors.emerald} />
              <Text style={ui.title}>Sent</Text>
              <Text style={ui.body}>Your new phone is importing the chats. Once it shows them, you can unlink this phone in Settings → Linked devices.</Text>
            </Card>
            <Button label="Done" onPress={() => router.back()} />
          </>
        )}
        {phase === 'error' && (
          <>
            <Note icon="alert-circle" tone="warning">{error}</Note>
            <Button label="Scan again" icon="scan-outline" onPress={() => router.replace({ pathname: '/qr/scan', params: { expect: 'transfer' } })} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
