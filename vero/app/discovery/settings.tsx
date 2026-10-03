import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, Switch, TextInput, Alert, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { discoveryRepository, DiscoverabilityStatus } from '../../src/features/discovery/DiscoveryRepository';
import { friendlyError } from '../../src/core/network/supabase';
import { Button, Card, Note, ScreenHeader, ui } from '../../src/features/linking/ui';
import { Colors, Spacing } from '../../src/shared/theme/theme';

export default function DiscoverySettingsScreen() {
  const isDemo = useAuthStore((s) => s.isDemo);
  const [status, setStatus] = useState<DiscoverabilityStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [phone, setPhone] = useState('');
  const [pendingPhone, setPendingPhone] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await discoveryRepository.getStatus());
    } catch (e) {
      Alert.alert('Could not load settings', friendlyError(e));
    }
  }, []);

  useEffect(() => {
    if (!isDemo) void load();
  }, [isDemo, load]);

  const update = async (byEmail: boolean, byPhone: boolean) => {
    setSaving(true);
    try {
      setStatus(await discoveryRepository.setDiscoverable(byEmail, byPhone));
    } catch (e) {
      Alert.alert('Could not save', friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  const sendCode = async () => {
    setBusy(true);
    try {
      setPendingPhone(await discoveryRepository.startPhoneVerification(phone));
    } catch (e) {
      Alert.alert('Could not send code', friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmCode = async () => {
    if (!pendingPhone) return;
    setBusy(true);
    try {
      await discoveryRepository.confirmPhoneVerification(pendingPhone, code);
      setPendingPhone(null);
      setCode('');
      setPhone('');
      // A verified phone is listed only if phone discovery is on.
      setStatus(await discoveryRepository.setDiscoverable(status?.discoverableByEmail ?? false, true));
      Alert.alert('Phone verified', 'Friends who have your number can now find you on Vero.');
    } catch (e) {
      Alert.alert('Verification failed', friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title="Who can find me" />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        {isDemo ? (
          <Note icon="sparkles">Discovery settings need a real account.</Note>
        ) : !status ? (
          <ActivityIndicator color={Colors.accent} />
        ) : (
          <>
            <Text style={ui.body}>
              Off by default. When on, Vero stores only a SHA-256 hash of your verified email or phone so friends who
              have it in their contacts can find you. Your username search is unaffected.
            </Text>

            <Card>
              <View style={styles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={ui.label}>Find me by email</Text>
                  <Text style={ui.muted}>
                    {!status.emailVerified
                      ? 'Confirm your email address first.'
                      : status.emailListed
                        ? 'On - your email hash is listed.'
                        : 'Off'}
                  </Text>
                </View>
                <Switch
                  value={status.discoverableByEmail}
                  disabled={saving}
                  onValueChange={(v) => void update(v, status.discoverableByPhone)}
                  trackColor={{ true: Colors.accent, false: Colors.surfaceHighlight }}
                />
              </View>
              <View style={styles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={ui.label}>Find me by phone number</Text>
                  <Text style={ui.muted}>
                    {!status.phoneVerified
                      ? 'Verify a phone number below first.'
                      : status.phoneListed
                        ? `On - ${status.phoneHint ?? 'your number'} is listed (hashed).`
                        : `Off (${status.phoneHint ?? 'verified number'})`}
                  </Text>
                </View>
                <Switch
                  value={status.discoverableByPhone}
                  disabled={saving}
                  onValueChange={(v) => void update(status.discoverableByEmail, v)}
                  trackColor={{ true: Colors.accent, false: Colors.surfaceHighlight }}
                />
              </View>
            </Card>

            <Card>
              <Text style={ui.label}>{status.phoneVerified ? 'Change phone number' : 'Verify your phone number'}</Text>
              {!pendingPhone ? (
                <>
                  <TextInput
                    style={ui.input}
                    value={phone}
                    onChangeText={setPhone}
                    placeholder="+91 98765 43210"
                    placeholderTextColor={Colors.textTertiary}
                    keyboardType="phone-pad"
                    autoComplete="tel"
                  />
                  <Button label="Send code by SMS" variant="secondary" onPress={sendCode} loading={busy} disabled={!phone.trim()} />
                </>
              ) : (
                <>
                  <Text style={ui.muted}>Enter the code sent to {pendingPhone}.</Text>
                  <TextInput
                    style={ui.input}
                    value={code}
                    onChangeText={setCode}
                    placeholder="123456"
                    placeholderTextColor={Colors.textTertiary}
                    keyboardType="number-pad"
                    autoComplete="sms-otp"
                    textContentType="oneTimeCode"
                    maxLength={10}
                  />
                  <Button label="Verify" onPress={confirmCode} loading={busy} disabled={code.length < 4} />
                  <Button label="Use a different number" variant="secondary" onPress={() => setPendingPhone(null)} />
                </>
              )}
              <Text style={ui.muted}>
                Numbers without a country code are treated as Indian (+91). Phone verification needs an SMS provider
                on the Vero server; if it isn't set up yet, email discovery still works.
              </Text>
            </Card>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
});
