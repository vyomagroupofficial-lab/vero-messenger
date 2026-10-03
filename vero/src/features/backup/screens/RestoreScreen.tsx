/**
 * Restore an encrypted backup after signing in on a new device: download,
 * unlock with the recovery key or passphrase, verify + decrypt, import.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import dayjs from 'dayjs';
import { friendlyError } from '../../../core/network/supabase';
import { BorderRadius, Colors, Spacing, Typography } from '../../../shared/theme/theme';
import { useAuthStore } from '../../auth/useAuthStore';
import { useChatsStore } from '../../chats/useChatsStore';
import { Button, Card, Note, ScreenHeader, ui } from '../../linking/ui';
import { loadPrivacySettings } from '../../settings/settingsSync';
import { BackupError, SlotType } from '../backupCrypto';
import { backupMethods, dismissRestoreOffer, downloadBackup, restoreBackup } from '../BackupService';
import { RecoveryKeyError } from '../recoveryKey';

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; bytes: Uint8Array; methods: SlotType[]; createdAt: string }
  | { kind: 'restoring'; bytes: Uint8Array; methods: SlotType[]; createdAt: string }
  | { kind: 'done'; rows: number };

export default function RestoreScreen() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [method, setMethod] = useState<SlotType>('recovery');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!userId) return;
    setState({ kind: 'loading' });
    try {
      const bytes = await downloadBackup(userId);
      const { methods, createdAt } = await backupMethods(bytes);
      setMethod(methods.includes('recovery') ? 'recovery' : 'passphrase');
      setState({ kind: 'ready', bytes, methods, createdAt });
    } catch (e) {
      if (e instanceof BackupError) setState({ kind: 'error', message: e.message });
      else if (/no backup/i.test((e as Error)?.message ?? '')) setState({ kind: 'missing' });
      else setState({ kind: 'error', message: friendlyError(e) });
    }
  };

  useEffect(() => {
    void load();
  }, [userId]);

  const restore = async () => {
    if (!userId || (state.kind !== 'ready' && state.kind !== 'restoring')) return;
    setError(null);
    const ready = state;
    setState({ ...ready, kind: 'restoring' });
    try {
      const { rows } = await restoreBackup(
        userId,
        ready.bytes,
        method === 'recovery' ? { recoveryKey: secret } : { passphrase: secret }
      );
      setSecret('');
      void loadPrivacySettings();
      void useChatsStore.getState().refreshLocal();
      setState({ kind: 'done', rows });
    } catch (e) {
      setState({ ...ready, kind: 'ready' });
      setError(e instanceof BackupError || e instanceof RecoveryKeyError ? e.message : friendlyError(e));
    }
  };

  const skip = () => {
    Alert.alert('Skip restore', 'Continue without your old chats? You can restore later from Settings → Chat backup.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Skip',
        style: 'destructive',
        onPress: () => {
          if (userId) dismissRestoreOffer(userId);
          router.replace('/(tabs)/chats');
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title="Restore chats" />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        {state.kind === 'loading' ? (
          <Card style={{ alignItems: 'center' }}>
            <ActivityIndicator color={Colors.accent} />
            <Text style={ui.body}>Looking for your backup…</Text>
          </Card>
        ) : state.kind === 'missing' ? (
          <>
            <Note icon="cloud-offline-outline">There is no backup for this account.</Note>
            <Button label="Continue" onPress={() => router.replace('/(tabs)/chats')} />
          </>
        ) : state.kind === 'error' ? (
          <>
            <Note icon="alert-circle" tone="warning">
              {state.message}
            </Note>
            <Button label="Try again" onPress={() => void load()} />
            <Button label="Skip" variant="secondary" onPress={skip} />
          </>
        ) : state.kind === 'done' ? (
          <>
            <Text style={ui.title}>Chats restored</Text>
            <Text style={ui.body}>{state.rows.toLocaleString()} items were restored on this device.</Text>
            <Button label="Open chats" onPress={() => router.replace('/(tabs)/chats')} />
          </>
        ) : (
          <>
            <Text style={ui.title}>Restore your chats</Text>
            <Text style={ui.body}>Backup from {dayjs(state.createdAt).format('D MMM YYYY, HH:mm')}</Text>

            {state.methods.length > 1 ? (
              <View style={styles.tabs}>
                {(['recovery', 'passphrase'] as SlotType[]).map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={[styles.tab, method === m && styles.tabActive]}
                    onPress={() => {
                      setMethod(m);
                      setSecret('');
                      setError(null);
                    }}
                  >
                    <Text style={[styles.tabText, method === m && styles.tabTextActive]}>
                      {m === 'recovery' ? 'Recovery key' : 'Passphrase'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}

            <TextInput
              style={[ui.input, method === 'recovery' && styles.keyInput]}
              value={secret}
              onChangeText={setSecret}
              placeholder={method === 'recovery' ? 'XXXX-XXXX-XXXX-…' : 'Backup passphrase'}
              placeholderTextColor={Colors.textTertiary}
              secureTextEntry={method === 'passphrase'}
              autoCapitalize={method === 'recovery' ? 'characters' : 'none'}
              autoCorrect={false}
              multiline={method === 'recovery'}
              editable={state.kind === 'ready'}
            />
            {error ? (
              <Note icon="alert-circle" tone="warning">
                {error}
              </Note>
            ) : null}
            {state.kind === 'restoring' ? (
              <Card style={{ alignItems: 'center' }}>
                <ActivityIndicator color={Colors.accent} />
                <Text style={ui.body}>
                  {method === 'passphrase' ? 'Checking passphrase and decrypting… this can take a while.' : 'Decrypting…'}
                </Text>
              </Card>
            ) : (
              <>
                <Button label="Restore" icon="cloud-download-outline" onPress={() => void restore()} disabled={!secret.trim()} />
                <Button label="Skip" variant="secondary" onPress={skip} />
              </>
            )}
            <Note icon="lock-closed-outline">
              Your backup is decrypted on this device. Vero never sees your recovery key or passphrase.
            </Note>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: 4,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tab: { flex: 1, paddingVertical: Spacing.sm, alignItems: 'center', borderRadius: BorderRadius.md },
  tabActive: { backgroundColor: Colors.accentSubtle },
  tabText: { color: Colors.textSecondary, fontSize: Typography.sm, fontWeight: Typography.semibold },
  tabTextActive: { color: Colors.accentLight },
  keyInput: { height: 96, paddingTop: Spacing.md, fontFamily: 'monospace', textAlignVertical: 'top' },
});
