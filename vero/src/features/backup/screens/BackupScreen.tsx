/**
 * Chat backup: set up (passphrase and/or recovery key), back up now, daily
 * auto-backup, change secrets, turn off. See BackupService.ts.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Share, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import dayjs from 'dayjs';
import { friendlyError } from '../../../core/network/supabase';
import { useAuthStore } from '../../auth/useAuthStore';
import { Button, Card, Note, ScreenHeader, useUi } from '../../linking/ui';
import { MIN_PASSPHRASE_LENGTH, validatePassphrase } from '../backupCrypto';
import {
  getRemoteBackupInfo,
  isBackupConfigured,
  RemoteBackupInfo,
  runBackup,
  setupBackup,
  turnOffBackup,
} from '../BackupService';
import { generateRecoveryKey } from '../recoveryKey';
import { getSumoSodium } from '../sodiumSumo';
import { useBackupStatus, useBackupStore } from '../useBackupStore';
import { makeStyles, useLegacyColors } from '../../../shared/theme/ThemeProvider';
import { BorderRadius, Spacing, Typography, legacyColors } from '../../../shared/theme/theme';
import { Glyph } from '../../../shared/ui';

type Phase = 'deriving' | 'encrypting' | 'uploading';
const PHASE_TEXT: Record<Phase, string> = {
  deriving: 'Protecting your backup key… (this can take a while)',
  encrypting: 'Encrypting your chats…',
  uploading: 'Uploading…',
};

function formatBytes(n: number | null | undefined): string {
  if (!n) return '—';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

type Step = 'overview' | 'choose' | 'passphrase' | 'recovery' | 'working';

export default function BackupScreen() {
  const Colors = useLegacyColors();
  const styles = useStyles();
  const ui = useUi();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const isDemo = useAuthStore((s) => s.isDemo);
  const status = useBackupStatus(userId);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [remote, setRemote] = useState<RemoteBackupInfo | null | undefined>(undefined);
  const [step, setStep] = useState<Step>('overview');
  const [phase, setPhase] = useState<Phase | null>(null);

  // setup wizard state
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [useRecovery, setUseRecovery] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [savedIt, setSavedIt] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || isDemo) return;
    setConfigured(await isBackupConfigured(userId));
    try {
      setRemote(await getRemoteBackupInfo(userId));
    } catch {
      setRemote(null);
    }
  }, [userId, isDemo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetWizard = () => {
    setPassphrase('');
    setConfirm('');
    setRecoveryKey(null);
    setSavedIt(false);
  };

  const startSetup = () => {
    resetWizard();
    setStep('choose');
  };

  const afterChoose = async () => {
    if (!usePassphrase && !useRecovery) return Alert.alert('Backup', 'Choose at least one way to unlock your backup.');
    if (usePassphrase) return setStep('passphrase');
    await prepareRecoveryKey();
  };

  const prepareRecoveryKey = async () => {
    const sodium = await getSumoSodium();
    setRecoveryKey(generateRecoveryKey(sodium));
    setSavedIt(false);
    setStep('recovery');
  };

  const afterPassphrase = async () => {
    const problem = validatePassphrase(passphrase);
    if (problem) return Alert.alert('Passphrase', problem);
    if (passphrase !== confirm) return Alert.alert('Passphrase', 'The two passphrases do not match.');
    if (useRecovery) return prepareRecoveryKey();
    await finishSetup();
  };

  const finishSetup = async () => {
    if (!userId) return;
    setStep('working');
    try {
      await setupBackup(
        userId,
        { passphrase: usePassphrase ? passphrase : undefined, recoveryKey: useRecovery ? recoveryKey ?? undefined : undefined },
        setPhase
      );
      resetWizard();
      setStep('overview');
      Alert.alert('Backup is on', 'Your chats are backed up, end-to-end encrypted.');
    } catch (e) {
      setStep('overview');
      Alert.alert('Backup failed', friendlyError(e));
    } finally {
      setPhase(null);
      void refresh();
    }
  };

  const backupNow = async () => {
    if (!userId) return;
    setStep('working');
    try {
      await runBackup(userId, setPhase);
    } catch (e) {
      Alert.alert('Backup failed', friendlyError(e));
    } finally {
      setPhase(null);
      setStep('overview');
      void refresh();
    }
  };

  const turnOff = () => {
    if (!userId) return;
    Alert.alert('Turn off backup', 'Stop backing up from this device?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Keep the backup on the server', onPress: () => void turnOffBackup(userId, false).then(refresh) },
      {
        text: 'Delete the backup too',
        style: 'destructive',
        onPress: () =>
          void turnOffBackup(userId, true)
            .then(refresh)
            .catch((e) => Alert.alert('Could not delete the backup', friendlyError(e))),
      },
    ]);
  };

  const copyKey = async () => {
    if (!recoveryKey) return;
    await Clipboard.setStringAsync(recoveryKey);
    Alert.alert('Copied', 'Paste it into your password manager, then clear your clipboard.');
  };

  const shareKey = async () => {
    if (!recoveryKey) return;
    await Share.share({ message: `Vero backup recovery key:\n\n${recoveryKey}` });
  };

  if (isDemo) {
    return (
      <SafeAreaView style={ui.screen} edges={['top']}>
        <ScreenHeader title="Chat backup" />
        <ScrollView contentContainerStyle={ui.content}>
          <Note icon="sparkles">Backups need a real account.</Note>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const on = configured === true && status.methods.length > 0;
  const methodsText = status.methods
    .map((m) => (m === 'passphrase' ? 'passphrase' : 'recovery key'))
    .join(' or ');

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader
        title="Chat backup"
        onBack={step === 'overview' || step === 'working' ? undefined : () => (resetWizard(), setStep('overview'))}
      />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        {step === 'working' ? (
          <Card style={{ alignItems: 'center' }}>
            <ActivityIndicator color={Colors.accent} size="large" />
            <Text style={ui.body}>{phase ? PHASE_TEXT[phase] : 'Working…'}</Text>
          </Card>
        ) : step === 'choose' ? (
          <>
            <Text style={ui.title}>How do you want to unlock your backup?</Text>
            <Text style={ui.body}>
              Your backup is encrypted on this phone. Vero cannot read it and cannot reset these secrets: lose them and
              the backup is gone.
            </Text>
            <Card>
              <OptionRow
                icon="key-outline"
                title="Recovery key (recommended)"
                desc="A 64-character key generated for you. Store it in a password manager or on paper."
                value={useRecovery}
                onChange={setUseRecovery}
              />
              <OptionRow
                icon="text-outline"
                title="Passphrase"
                desc={`At least ${MIN_PASSPHRASE_LENGTH} characters that you choose. Use a long, unique phrase.`}
                value={usePassphrase}
                onChange={setUsePassphrase}
              />
            </Card>
            <Text style={ui.muted}>Choose both and either one will unlock the backup.</Text>
            <Button label="Continue" onPress={() => void afterChoose()} disabled={!usePassphrase && !useRecovery} />
          </>
        ) : step === 'passphrase' ? (
          <>
            <Text style={ui.title}>Choose a passphrase</Text>
            <Text style={ui.body}>At least {MIN_PASSPHRASE_LENGTH} characters. Vero can't recover it for you.</Text>
            <TextInput
              style={ui.input}
              value={passphrase}
              onChangeText={setPassphrase}
              placeholder="Passphrase"
              placeholderTextColor={Colors.textTertiary}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="newPassword"
            />
            <TextInput
              style={ui.input}
              value={confirm}
              onChangeText={setConfirm}
              placeholder="Repeat passphrase"
              placeholderTextColor={Colors.textTertiary}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="newPassword"
            />
            <Text style={ui.muted}>
              {passphrase.length > 0 && validatePassphrase(passphrase) ? validatePassphrase(passphrase) : ' '}
            </Text>
            <Button label="Continue" onPress={() => void afterPassphrase()} disabled={!passphrase || !confirm} />
          </>
        ) : step === 'recovery' && recoveryKey ? (
          <>
            <Text style={ui.title}>Your recovery key</Text>
            <Text style={ui.body}>
              This is the only time it is shown. Anyone with this key and access to your account can read your backup.
            </Text>
            <Card>
              <Text style={styles.key} selectable>
                {recoveryKey}
              </Text>
            </Card>
            <View style={{ flexDirection: 'row', gap: Spacing.md }}>
              <View style={{ flex: 1 }}>
                <Button label="Copy" icon="copy-outline" variant="secondary" onPress={() => void copyKey()} />
              </View>
              <View style={{ flex: 1 }}>
                <Button label="Share" icon="share-outline" variant="secondary" onPress={() => void shareKey()} />
              </View>
            </View>
            <TouchableOpacity style={styles.check} onPress={() => setSavedIt((v) => !v)} activeOpacity={0.8}>
              <Glyph name={savedIt ? 'checkbox' : 'square-outline'} size={22} color={savedIt ? Colors.accent : Colors.textTertiary} />
              <Text style={[ui.label, { flex: 1 }]}>I've saved my recovery key somewhere safe</Text>
            </TouchableOpacity>
            <Button label="Turn on backup" onPress={() => void finishSetup()} disabled={!savedIt} />
          </>
        ) : (
          <>
            <Card>
              <View style={styles.statusRow}>
                <Glyph name={on ? 'cloud-done-outline' : 'cloud-offline-outline'} size={26} color={on ? Colors.emerald : Colors.textTertiary} />
                <View style={{ flex: 1 }}>
                  <Text style={ui.label}>{configured === null ? 'Checking…' : on ? 'Backup is on' : 'Backup is off'}</Text>
                  <Text style={ui.muted}>
                    {on
                      ? `Last backup: ${status.lastBackupAt ? dayjs(status.lastBackupAt).format('D MMM YYYY, HH:mm') : 'never'} · ${formatBytes(status.lastBackupBytes)}`
                      : 'Back up your chats, end-to-end encrypted, to restore them on a new phone.'}
                  </Text>
                  {on ? <Text style={ui.muted}>Unlocks with your {methodsText}.</Text> : null}
                </View>
              </View>
            </Card>

            {on ? (
              <>
                <Button label="Back up now" icon="cloud-upload-outline" onPress={() => void backupNow()} />
                <Card>
                  <View style={styles.statusRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={ui.label}>Back up daily</Text>
                      <Text style={ui.muted}>When you open Vero and the last backup is over a day old.</Text>
                    </View>
                    <Switch
                      value={status.autoDaily}
                      onValueChange={(v) => {
                        if (userId) useBackupStore.getState().update(userId, { autoDaily: v });
                      }}
                      trackColor={{ false: Colors.border, true: `${Colors.accent}80` }}
                      thumbColor={status.autoDaily ? Colors.accent : Colors.textTertiary}
                    />
                  </View>
                </Card>
                <Button label="Change passphrase or recovery key" icon="key-outline" variant="secondary" onPress={startSetup} />
                <Button label="Turn off backup" icon="trash-outline" variant="danger" onPress={turnOff} />
              </>
            ) : (
              <>
                <Button label="Set up backup" icon="shield-checkmark-outline" onPress={startSetup} disabled={configured === null} />
                {remote ? (
                  <Note icon="cloud-download-outline">
                    A backup from {remote.updatedAt ? dayjs(remote.updatedAt).format('D MMM YYYY') : 'an earlier device'} exists.
                    Restore it first if you want those chats here - setting up a new backup replaces it.
                  </Note>
                ) : null}
                {remote ? (
                  <Button label="Restore from backup" icon="cloud-download-outline" variant="secondary" onPress={() => router.push('/backup/restore')} />
                ) : null}
              </>
            )}

            <Note icon="lock-closed-outline">
              The backup contains your messages, chat list, call history, verified contact keys and preferences. It never
              contains your private keys - a restored phone registers its own keys. Photos and files are not copied into the
              backup; they download again from the server while they are still there.
            </Note>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function OptionRow({
  icon,
  title,
  desc,
  value,
  onChange,
}: {
  icon: import('../../../shared/ui').GlyphName;
  title: string;
  desc: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const Colors = useLegacyColors();
  const styles = useStyles();
  const ui = useUi();
  return (
    <TouchableOpacity style={styles.option} onPress={() => onChange(!value)} activeOpacity={0.8}>
      <Glyph name={icon} size={22} color={Colors.accent} />
      <View style={{ flex: 1 }}>
        <Text style={ui.label}>{title}</Text>
        <Text style={ui.muted}>{desc}</Text>
      </View>
      <Glyph name={value ? 'checkbox' : 'square-outline'} size={22} color={value ? Colors.accent : Colors.textTertiary} />
    </TouchableOpacity>
  );
}

const useStyles = makeStyles((c) => {
  const Colors = legacyColors(c);
  return {
  key: {
    fontFamily: 'monospace',
    fontSize: Typography.base,
    color: Colors.accentLight,
    letterSpacing: 1,
    lineHeight: 26,
    textAlign: 'center',
  },
  check: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.sm },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
  },
} as const;
});
