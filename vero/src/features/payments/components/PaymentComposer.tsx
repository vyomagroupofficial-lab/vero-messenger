/**
 * "Request money" / "Pay" form shown in the chat extras sheet.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { friendlyError } from '../../../core/network/supabase';
import { Colors } from '../../../shared/theme/theme';
import type { Conversation } from '../../../shared/models/Message';
import { isPaymentMessage, MyUpiProfile, paymentService } from '../PaymentService';
import { formatINR, normalizeVpa, parseAmount } from '../upi';
import { UpiQrModal } from './UpiQrModal';
import type { PaymentCard } from '../../../shared/models/payloadExtensions';

export function PaymentComposer({
  conversation,
  isDemo,
  onDone,
}: {
  conversation: Conversation;
  isDemo: boolean;
  onDone: () => void;
}) {
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
          setError('Enter the UPI id of the person you’re paying (e.g. name@okbank).');
          return;
        }
        const sent = await paymentService.pay(conversation.id, {
          amountPaise: a.paise,
          note,
          payeeVpa,
          payeeName,
          to: other?.id,
        });
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

  return (
    <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      <View style={styles.segment}>
        {(['request', 'pay'] as const).map((m) => (
          <TouchableOpacity key={m} style={[styles.segBtn, mode === m && styles.segActive]} onPress={() => setMode(m)}>
            <Text style={[styles.segText, mode === m && styles.segTextActive]}>{m === 'request' ? 'Request money' : 'Pay'}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.label}>Amount (₹1 – ₹1,00,000)</Text>
      <TextInput
        style={[styles.input, styles.amountInput]}
        value={amount}
        onChangeText={setAmount}
        placeholder="₹0"
        placeholderTextColor={Colors.textTertiary}
        keyboardType="decimal-pad"
        maxLength={12}
      />
      {parsed && parsed.ok ? <Text style={styles.preview}>{formatINR(parsed.paise)}</Text> : null}

      <Text style={styles.label}>Note</Text>
      <TextInput
        style={styles.input}
        value={note}
        onChangeText={setNote}
        placeholder={mode === 'request' ? 'What’s it for?' : 'Add a note'}
        placeholderTextColor={Colors.textTertiary}
        maxLength={80}
      />

      {mode === 'request' ? (
        useLink ? (
          <Text style={styles.info}>A Razorpay payment page (cards, netbanking, UPI) will be created. Money goes to this server’s Razorpay account.</Text>
        ) : myUpi === undefined ? (
          <ActivityIndicator color={Colors.accent} />
        ) : myUpi ? (
          <Text style={styles.info}>
            They’ll pay to your UPI id <Text style={styles.strong}>{myUpi.vpa}</Text>. It’s shared only inside this encrypted chat.
          </Text>
        ) : (
          <TouchableOpacity onPress={() => { onDone(); router.push('/payments'); }}>
            <Text style={[styles.info, styles.link]}>Add your UPI id first (Settings → Payments) →</Text>
          </TouchableOpacity>
        )
      ) : (
        <>
          <Text style={styles.label}>Pay to UPI id</Text>
          <TextInput
            style={styles.input}
            value={payeeVpa}
            onChangeText={setPayeeVpa}
            placeholder="name@bank"
            placeholderTextColor={Colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            maxLength={100}
          />
          <Text style={styles.info}>
            {Platform.OS === 'web'
              ? 'You’ll get a QR code to scan with a UPI app on your phone.'
              : 'Your UPI app opens to complete the payment. Vero never sees your bank details.'}
          </Text>
        </>
      )}

      {mode === 'request' && links.allowed ? (
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Card / netbanking link (Razorpay, optional)</Text>
          <Switch value={useLink} onValueChange={setUseLink} />
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity
        style={[styles.submit, (busy || (mode === 'request' && !useLink && !myUpi)) && styles.submitDisabled]}
        disabled={busy || (mode === 'request' && !useLink && !myUpi)}
        onPress={submit}
      >
        {busy ? <ActivityIndicator color={Colors.white} /> : (
          <Text style={styles.submitText}>{mode === 'request' ? 'Send request' : 'Continue to pay'}</Text>
        )}
      </TouchableOpacity>

      <UpiQrModal card={qrCard} visible={!!qrCard} onClose={() => { setQrCard(null); onDone(); }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 16, paddingBottom: 32 },
  segment: { flexDirection: 'row', backgroundColor: Colors.surface, borderRadius: 12, padding: 4, marginBottom: 12 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  segActive: { backgroundColor: Colors.accent },
  segText: { color: Colors.textSecondary, fontWeight: '500' },
  segTextActive: { color: Colors.white, fontWeight: '600' },
  label: { color: Colors.textSecondary, fontSize: 12, marginTop: 10, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    color: Colors.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  amountInput: { fontSize: 24, fontWeight: '600' },
  preview: { color: Colors.textTertiary, fontSize: 12, marginTop: 4 },
  info: { color: Colors.textSecondary, fontSize: 12, marginTop: 10, lineHeight: 17 },
  strong: { color: Colors.textPrimary, fontWeight: '600' },
  link: { color: Colors.accent },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  switchLabel: { color: Colors.textPrimary, fontSize: 13, flex: 1, marginRight: 8 },
  error: { color: Colors.error, fontSize: 13, marginTop: 10 },
  submit: { backgroundColor: Colors.accent, borderRadius: 12, alignItems: 'center', paddingVertical: 13, marginTop: 16 },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: Colors.white, fontWeight: '600', fontSize: 15 },
});
