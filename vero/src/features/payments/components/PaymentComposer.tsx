/**
 * "Request money" / "Pay" form shown in the chat extras sheet.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { friendlyError } from '../../../core/network/supabase';
import { useT } from '../../../shared/i18n';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { Button, Icon, Pressy, Segmented, TextField, Toggle } from '../../../shared/ui';
import type { Conversation } from '../../../shared/models/Message';
import { isPaymentMessage, MyUpiProfile, paymentService } from '../PaymentService';
import { formatINR, normalizeVpa, parseAmount } from '../upi';
import { UpiQrModal } from './UpiQrModal';
import type { PaymentCard } from '../../../shared/models/payloadExtensions';

export function PaymentComposer({ conversation, isDemo, onDone }: { conversation: Conversation; isDemo: boolean; onDone: () => void }) {
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const [mode, setMode] = useState<'request' | 'pay'>('request');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [payeeVpa, setPayeeVpa] = useState('');
  const [payeeName, setPayeeName] = useState('');
  const [myUpi, setMyUpi] = useState<MyUpiProfile | null | undefined>(undefined);
  const [links, setLinks] = useState<{ configured: boolean; allowed: boolean }>({ configured: false, allowed: false });
  const [useLink, setUseLink] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qrCard, setQrCard] = useState<PaymentCard | null>(null);

  const other = conversation.conversationType === 'direct' ? conversation.otherUser : undefined;

  useEffect(() => {
    void paymentService.getMyUpi().then(setMyUpi).catch(() => setMyUpi(null));
    if (!isDemo) void paymentService.linkStatus().then(setLinks);
    if (other) {
      void paymentService.knownPayee(conversation.id, other.id).then((p) => {
        if (p) {
          setPayeeVpa(p.vpa);
          setPayeeName(p.name ?? other.displayName);
        } else setPayeeName(other.displayName);
      });
    }
  }, [conversation.id]);

  const parsed = amount ? parseAmount(amount) : null;

  const submit = async () => {
    setError(null);
    const a = parseAmount(amount);
    if (!a.ok) return setError(a.error);
    setBusy(true);
    try {
      if (mode === 'request') {
        if (useLink) await paymentService.requestViaLink(conversation.id, a.paise, note, other?.id);
        else await paymentService.requestMoney(conversation.id, a.paise, note, other?.id);
        onDone();
      } else {
        if (!normalizeVpa(payeeVpa)) {
          setError(t('payments.enterVpa'));
          return;
        }
        const sent = await paymentService.pay(conversation.id, { amountPaise: a.paise, note, payeeVpa, payeeName, to: other?.id });
        if (isPaymentMessage(sent)) {
          if (Platform.OS === 'web') setQrCard(sent.ext.card);
          else {
            onDone();
            await paymentService.openUpiApp(sent.ext.card);
          }
        } else onDone();
      }
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const blocked = busy || (mode === 'request' && !useLink && !myUpi);

  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
      <View style={{ alignItems: 'center' }}>
        <Segmented
          label={t('payments.mode')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'request', label: t('payments.request') },
            { value: 'pay', label: t('payments.pay') },
          ]}
        />
      </View>

      <View style={s.amountBox}>
        <Text style={s.rupee}>₹</Text>
        <TextInput style={s.amountInput} value={amount} onChangeText={setAmount} placeholder="0" placeholderTextColor={c.placeholder} keyboardType="decimal-pad" maxLength={12} accessibilityLabel={t('payments.amount')} />
      </View>
      <Text style={[type.caption, { textAlign: 'center' }]}>{parsed && parsed.ok ? formatINR(parsed.paise) : t('payments.range')}</Text>

      <TextField icon="edit" value={note} onChangeText={setNote} placeholder={mode === 'request' ? t('payments.whatFor') : t('payments.addNote')} maxLength={80} />

      {mode === 'request' ? (
        useLink ? (
          <Text style={s.info}>{t('payments.linkInfo')}</Text>
        ) : myUpi === undefined ? (
          <ActivityIndicator color={c.accent} />
        ) : myUpi ? (
          <View style={s.infoRow}>
            <Icon name="lock" size={14} color={c.success} />
            <Text style={[s.info, { flex: 1 }]}>
              {t('payments.payTo')} <Text style={s.strong}>{myUpi.vpa}</Text>. {t('payments.sharedInChat')}
            </Text>
          </View>
        ) : (
          <Pressy
            onPress={() => {
              onDone();
              router.push('/payments');
            }}
            style={s.addUpi}
            accessibilityRole="link"
          >
            <Icon name="wallet" size={17} color={c.accentText} />
            <Text style={[s.info, { color: c.accentText, flex: 1, marginTop: 0 }]}>{t('payments.addUpiFirst')}</Text>
            <Icon name="forwardChevron" size={16} color={c.accentText} />
          </Pressy>
        )
      ) : (
        <Animated.View entering={FadeIn} style={{ gap: 8 }}>
          <TextField label={t('payments.payToVpa')} icon="at" value={payeeVpa} onChangeText={setPayeeVpa} placeholder="name@bank" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" maxLength={100} />
          <Text style={s.info}>{Platform.OS === 'web' ? t('payments.webQr') : t('payments.appOpens')}</Text>
        </Animated.View>
      )}

      {mode === 'request' && links.allowed ? (
        <View style={s.switchRow}>
          <Text style={s.switchLabel}>{t('payments.linkOption')}</Text>
          <Toggle label={t('payments.linkOption')} value={useLink} onValueChange={setUseLink} />
        </View>
      ) : null}

      {error ? (
        <Animated.Text entering={FadeIn} style={[type.caption, { color: c.danger }]}>
          {error}
        </Animated.Text>
      ) : null}

      <Button label={mode === 'request' ? t('payments.sendRequest') : t('payments.continuePay')} icon={mode === 'request' ? 'send' : 'wallet'} loading={busy} disabled={blocked} onPress={submit} />

      <UpiQrModal
        card={qrCard}
        visible={!!qrCard}
        onClose={() => {
          setQrCard(null);
          onDone();
        }}
      />
    </ScrollView>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  wrap: { padding: 16, paddingBottom: 32, gap: 12 },
  amountBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8 },
  rupee: { fontFamily: f.display, fontSize: 36, color: c.accentText },
  amountInput: { fontFamily: f.display, fontSize: 48, color: c.text, minWidth: 80, textAlign: 'center', outlineStyle: 'none' } as any,
  info: { fontFamily: f.body, color: c.muted, fontSize: 12.5, lineHeight: f.script === 'latin' ? 18 : 21 },
  infoRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  strong: { fontFamily: f.semibold, color: c.text },
  addUpi: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  switchLabel: { fontFamily: f.medium, color: c.text, fontSize: 13.5, flex: 1 },
}));
