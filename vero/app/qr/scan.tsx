import React, { useCallback, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, ScrollView, Platform } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { parseQrPayload, QrPayload } from '../../src/features/linking/qrPayloads';
import { handOff } from '../../src/features/linking/scanHandoff';
import { Button, Card, Note, ScreenHeader, ui } from '../../src/features/linking/ui';
import { Colors, BorderRadius, Spacing } from '../../src/shared/theme/theme';

type Expect = QrPayload['kind'] | undefined;

const TITLES: Record<string, string> = {
  link: 'Link a device',
  transfer: 'Transfer chats',
  profile: 'Scan a friend',
};

const HINTS: Record<string, string> = {
  link: 'On your computer, open Vero (web or desktop) and choose "Link with QR code". Point your camera at the code.',
  transfer: 'On your NEW phone, sign in and open Settings → Devices & transfer → "Receive chats from old phone".',
  profile: 'Scan a friend\'s Vero QR code (Contacts → My QR) to start a chat and verify their keys.',
};

export default function ScanScreen() {
  const { expect } = useLocalSearchParams<{ expect?: string }>();
  const expected: Expect = expect === 'link' || expect === 'transfer' || expect === 'profile' ? expect : undefined;
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState('');
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);

  const dispatch = useCallback(
    (raw: string) => {
      if (locked.current) return;
      const payload = parseQrPayload(raw);
      if (!payload) {
        setError('That is not a Vero code.');
        return;
      }
      if (expected && payload.kind !== expected) {
        setError(
          payload.kind === 'profile'
            ? 'That is a contact code, not a device code.'
            : payload.kind === 'link'
              ? 'That code links a computer. Use "Link a device" for it.'
              : 'That code is for transferring chats to a new phone.'
        );
        return;
      }
      locked.current = true;
      if (payload.kind === 'profile') {
        router.replace({
          pathname: '/u/[username]',
          params: payload.fingerprint ? { username: payload.username, fp: payload.fingerprint } : { username: payload.username },
        });
      } else if (payload.kind === 'link') {
        handOff(payload);
        router.replace('/devices/approve');
      } else {
        handOff(payload);
        router.replace('/devices/send-transfer');
      }
    },
    [expected]
  );

  const cameraReady = permission?.granted;

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title={TITLES[expected ?? 'profile']} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <View style={styles.cameraBox}>
          {cameraReady ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => dispatch(data)}
            />
          ) : (
            <View style={styles.cameraPlaceholder}>
              <Ionicons name="camera-outline" size={42} color={Colors.textTertiary} />
              <Text style={ui.body}>
                {permission && !permission.canAskAgain
                  ? 'Camera access is blocked. Enable it in your system settings, or paste the code below.'
                  : 'Vero needs your camera to scan QR codes. Nothing is recorded or uploaded.'}
              </Text>
              {(!permission || permission.canAskAgain) && (
                <Button label="Allow camera" icon="camera" onPress={() => void requestPermission()} />
              )}
            </View>
          )}
          {cameraReady && <View pointerEvents="none" style={styles.reticle} />}
        </View>

        <Text style={ui.body}>{HINTS[expected ?? 'profile']}</Text>
        {error && <Note icon="alert-circle" tone="warning">{error}</Note>}

        <Card>
          <Text style={ui.label}>{Platform.OS === 'web' ? 'No camera? Paste a link instead' : 'Or paste a link'}</Text>
          <TextInput
            style={ui.input}
            value={manual}
            onChangeText={(t) => {
              setManual(t);
              setError(null);
            }}
            placeholder={expected === 'profile' || !expected ? 'vero://u/username or @username' : 'Paste the code text'}
            placeholderTextColor={Colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={() => dispatch(manual)}
          />
          <Button label="Continue" variant="secondary" onPress={() => dispatch(manual)} disabled={!manual.trim()} />
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  cameraBox: {
    width: '100%',
    aspectRatio: 1,
    maxWidth: 420,
    alignSelf: 'center',
    borderRadius: BorderRadius['2xl'],
    overflow: 'hidden',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderAccent,
  },
  cameraPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md, padding: Spacing.xl },
  reticle: {
    position: 'absolute',
    top: '18%',
    left: '18%',
    right: '18%',
    bottom: '18%',
    borderWidth: 3,
    borderColor: Colors.accentLight,
    borderRadius: BorderRadius.xl,
  },
});
