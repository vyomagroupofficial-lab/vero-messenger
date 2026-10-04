import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { parseQrPayload, QrPayload } from '../../src/features/linking/qrPayloads';
import { handOff } from '../../src/features/linking/scanHandoff';
import { Card, Note, ScreenHeader, useLinkStyles } from '../../src/features/linking/ui';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button, Icon, TextField } from '../../src/shared/ui';

type Expect = QrPayload['kind'] | undefined;

/** Four brass corner brackets with a sweeping scan line. */
function Viewfinder() {
  const s = useStyles();
  const y = useSharedValue(0);
  useEffect(() => {
    y.value = withRepeat(withTiming(1, { duration: 2200, easing: Easing.bezier(0.6, 0, 0.4, 1) }), -1, true);
  }, []);
  const line = useAnimatedStyle(() => ({ top: `${8 + y.value * 84}%` }));
  return (
    <View pointerEvents="none" style={s.reticle}>
      <View style={[s.corner, { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 22 }]} />
      <View style={[s.corner, { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 22 }]} />
      <View style={[s.corner, { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 22 }]} />
      <View style={[s.corner, { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 22 }]} />
      <Animated.View style={[s.scanLine, line]} />
    </View>
  );
}

export default function ScanScreen() {
  const { expect } = useLocalSearchParams<{ expect?: string }>();
  const expected: Expect = expect === 'link' || expect === 'transfer' || expect === 'profile' ? expect : undefined;
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const ui = useLinkStyles();
  const s = useStyles();
  const t = useT();
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState('');
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const mode = expected ?? 'profile';

  const dispatch = useCallback(
    (raw: string) => {
      if (locked.current) return;
      const payload = parseQrPayload(raw);
      if (!payload) {
        setError(t('scan.notVero'));
        return;
      }
      if (expected && payload.kind !== expected) {
        setError(payload.kind === 'profile' ? t('scan.wrongProfile') : payload.kind === 'link' ? t('scan.wrongLink') : t('scan.wrongTransfer'));
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
    [expected, t]
  );

  const cameraReady = permission?.granted;

  return (
    <View style={[ui.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={t(`scan.title_${mode}`)} />
      <ScrollView contentContainerStyle={[ui.content, { paddingBottom: insets.bottom + 40 }]} keyboardShouldPersistTaps="handled">
        <View style={s.cameraBox}>
          {cameraReady ? (
            <>
              <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => dispatch(data)} />
              <Viewfinder />
            </>
          ) : (
            <View style={s.placeholder}>
              <View style={s.camIcon}>
                <Icon name="camera" size={32} color="#E7BD72" />
              </View>
              <Text style={[type.body, { color: c.onStageMuted, textAlign: 'center' }]}>
                {permission && !permission.canAskAgain ? t('scan.blocked') : t('scan.needCamera')}
              </Text>
              {(!permission || permission.canAskAgain) && <Button label={t('scan.allow')} icon="camera" size="md" onPress={() => void requestPermission()} />}
            </View>
          )}
        </View>

        <Text style={ui.body}>{t(`scan.hint_${mode}`)}</Text>
        {error && (
          <Animated.View entering={FadeIn}>
            <Note icon="info" tone="warning">
              {error}
            </Note>
          </Animated.View>
        )}

        <Card>
          <TextField
            label={Platform.OS === 'web' ? t('scan.pasteWeb') : t('scan.paste')}
            icon="link"
            value={manual}
            onChangeText={(v) => {
              setManual(v);
              setError(null);
            }}
            placeholder={mode === 'profile' ? t('scan.placeholderProfile') : t('scan.placeholderCode')}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={() => dispatch(manual)}
          />
          <Button label={t('common.next')} iconRight="arrowRight" variant="secondary" onPress={() => dispatch(manual)} disabled={!manual.trim()} />
        </Card>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  cameraBox: { width: '100%', aspectRatio: 1, maxWidth: 420, alignSelf: 'center', borderRadius: 30, overflow: 'hidden', backgroundColor: c.stage },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 28 },
  camIcon: { width: 76, height: 76, borderRadius: 26, backgroundColor: 'rgba(237,231,217,0.08)', borderWidth: 1, borderColor: 'rgba(237,231,217,0.12)', alignItems: 'center', justifyContent: 'center' },
  reticle: { position: 'absolute', top: '16%', left: '16%', right: '16%', bottom: '16%' },
  corner: { position: 'absolute', width: 44, height: 44, borderColor: c.accent },
  scanLine: { position: 'absolute', left: 10, right: 10, height: 2, borderRadius: 1, backgroundColor: c.accentHover, opacity: 0.85 },
}));
