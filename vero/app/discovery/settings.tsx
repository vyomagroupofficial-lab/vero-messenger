import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { discoveryRepository, DiscoverabilityStatus } from '../../src/features/discovery/DiscoveryRepository';
import { friendlyError } from '../../src/core/network/supabase';
import { Card, Note, ScreenHeader, useLinkStyles } from '../../src/features/linking/ui';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button, Icon, IconName, TextField, Toggle, notify } from '../../src/shared/ui';

export default function DiscoverySettingsScreen() {
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const ui = useLinkStyles();
  const s = useStyles();
  const t = useT();
  const isDemo = useAuthStore((st) => st.isDemo);
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
      notify(t('discovery.loadFailed'), friendlyError(e));
    }
  }, [t]);

  useEffect(() => {
    if (!isDemo) void load();
  }, [isDemo, load]);

  const update = async (byEmail: boolean, byPhone: boolean) => {
    setSaving(true);
    try {
      setStatus(await discoveryRepository.setDiscoverable(byEmail, byPhone));
    } catch (e) {
      notify(t('groups.saveFailed'), friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  const sendCode = async () => {
    setBusy(true);
    try {
      setPendingPhone(await discoveryRepository.startPhoneVerification(phone));
    } catch (e) {
      notify(t('discovery.codeFailed'), friendlyError(e));
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
      notify(t('discovery.phoneVerified'), t('discovery.phoneVerifiedBody'));
    } catch (e) {
      notify(t('discovery.verifyFailed'), friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleLine = ({ icon, label, hint, value, onChange, first }: { icon: IconName; label: string; hint: string; value: boolean; onChange: (v: boolean) => void; first?: boolean }) => (
    <View style={[s.toggleRow, !first && s.border]}>
      <View style={s.rowIcon}>
        <Icon name={icon} size={18} color={c.accentText} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={ui.label}>{label}</Text>
        <Text style={type.caption}>{hint}</Text>
      </View>
      <Toggle label={label} value={value} onValueChange={onChange} disabled={saving} />
    </View>
  );

  return (
    <View style={[ui.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('settings.findMe')} />
      <ScrollView contentContainerStyle={[ui.content, { paddingBottom: insets.bottom + 40 }]} keyboardShouldPersistTaps="handled">
        {isDemo ? (
          <Note icon="info">{t('discovery.settingsDemo')}</Note>
        ) : !status ? (
          <ActivityIndicator color={c.accent} style={{ marginTop: 40 }} />
        ) : (
          <>
            <Note icon="eyeOff">{t('discovery.offByDefault')}</Note>

            <Card style={{ paddingVertical: 6 }}>
              {toggleLine({
                first: true,
                icon: 'mail',
                label: t('discovery.byEmail'),
                hint: !status.emailVerified ? t('discovery.confirmEmailFirst') : status.emailListed ? t('discovery.emailOn') : t('timer.off'),
                value: status.discoverableByEmail,
                onChange: (v) => void update(v, status.discoverableByPhone),
              })}
              {toggleLine({
                icon: 'phone',
                label: t('discovery.byPhone'),
                hint: !status.phoneVerified
                  ? t('discovery.verifyPhoneFirst')
                  : status.phoneListed
                  ? t('discovery.phoneOn', { phone: status.phoneHint ?? t('discovery.yourNumber') })
                  : t('discovery.phoneOff', { phone: status.phoneHint ?? t('discovery.verifiedNumber') }),
                value: status.discoverableByPhone,
                onChange: (v) => void update(status.discoverableByEmail, v),
              })}
            </Card>

            <Card>
              <Text style={type.eyebrow}>{status.phoneVerified ? t('discovery.changePhone') : t('discovery.verifyPhone')}</Text>
              {!pendingPhone ? (
                <Animated.View key="phone" entering={FadeIn} style={{ gap: 12 }}>
                  <TextField icon="phone" value={phone} onChangeText={setPhone} placeholder="+91 98765 43210" keyboardType="phone-pad" autoComplete="tel" />
                  <Button label={t('discovery.sendCode')} variant="secondary" icon="send" onPress={sendCode} loading={busy} disabled={!phone.trim()} />
                </Animated.View>
              ) : (
                <Animated.View key="code" entering={FadeIn} style={{ gap: 12 }}>
                  <Text style={type.caption}>{t('discovery.enterCode', { phone: pendingPhone })}</Text>
                  <TextField icon="key" value={code} onChangeText={setCode} placeholder="123456" keyboardType="number-pad" autoComplete="sms-otp" textContentType="oneTimeCode" maxLength={10} />
                  <Button label={t('discovery.verify')} onPress={confirmCode} loading={busy} disabled={code.length < 4} />
                  <Button label={t('discovery.differentNumber')} variant="secondary" onPress={() => setPendingPhone(null)} />
                </Animated.View>
              )}
              <Text style={type.caption}>{t('discovery.phoneNote')}</Text>
            </Card>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  border: { borderTopWidth: 1, borderTopColor: c.line },
  rowIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center' },
}));
