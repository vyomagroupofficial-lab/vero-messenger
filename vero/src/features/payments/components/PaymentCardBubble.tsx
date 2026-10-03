/**
 * Encrypted payment card in a chat: amount, note, payee, status and the
 * actions available to the viewer (see paymentCard.ts for the rules).
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../auth/useAuthStore';
import { friendlyError } from '../../../core/network/supabase';
import { Colors } from '../../../shared/theme/theme';
import type { Message } from '../../../shared/models/Message';
import type { PaymentStatus } from '../../../shared/models/payloadExtensions';
import { allowedTransitions, statusLabel } from '../paymentCard';
import { isPaymentMessage, paymentService } from '../PaymentService';
import { formatINR } from '../upi';
import { UpiQrModal } from './UpiQrModal';

const STATUS_COLORS: Record<PaymentStatus, string> = {
  pending: Colors.warning,
  paid: Colors.emerald,
  failed: Colors.error,
  declined: Colors.textTertiary,
  cancelled: Colors.textTertiary,
};

export function PaymentCardBubble({ message }: { message: Message }) {
  const myId = useAuthStore((s) => s.user?.id);
  const [busy, setBusy] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [askResult, setAskResult] = useState(false);
  const [txnRef, setTxnRef] = useState('');

  if (!isPaymentMessage(message) || !myId) return null;
  const { card, state } = message.ext;
  const isCreator = message.senderUserId === myId;
  const can = allowedTransitions(card, state, { userId: myId, isCreator });
  const iAmPayer = card.kind === 'request' ? !isCreator : isCreator;
  const failed = message.status === 'failed' || message.status === 'sending';

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      Alert.alert('Payment', friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (status: Exclude<PaymentStatus, 'pending'>, ref?: string) =>
    run(() => paymentService.setStatus(message, status, ref));

  const payNow = () =>
    run(async () => {
      if (card.method === 'link') {
        await paymentService.openLink(card);
        setAskResult(true);
      } else if (Platform.OS === 'web') {
        setShowQr(true);
      } else {
        await paymentService.openUpiApp(card);
        // Shown underneath the UPI app; the user sees it when they come back.
        setAskResult(true);
      }
    });

  const confirm = (title: string, body: string, action: () => void) =>
    Platform.OS === 'web'
      ? globalThis.confirm?.(`${title}\n\n${body}`) !== false && action()
      : Alert.alert(title, body, [{ text: 'Back', style: 'cancel' }, { text: 'Confirm', onPress: action }]);

  const actions: { label: string; onPress: () => void; primary?: boolean }[] = [];
  if (!failed && can.length > 0) {
    if (iAmPayer && can.includes('paid')) {
      actions.push({ label: card.method === 'link' ? 'Open payment page' : `Pay ${formatINR(card.amountPaise)}`, onPress: payNow, primary: true });
      if (card.method === 'upi' && Platform.OS !== 'web') actions.push({ label: 'QR code', onPress: () => setShowQr(true) });
      actions.push({ label: 'I’ve paid', onPress: () => setAskResult(true) });
    }
    if (!iAmPayer && can.includes('paid')) {
      if (card.method === 'link' && isCreator) {
        actions.push({ label: 'Check payment', primary: true, onPress: () => run(async () => {
          const status = await paymentService.checkLink(message);
          if (status !== 'paid') Alert.alert('Payment link', `Status: ${status.replace('_', ' ')}`);
        }) });
      }
      actions.push({
        label: 'Mark received',
        onPress: () => confirm('Mark as received?', 'Only do this after checking your bank or UPI app.', () => void setStatus('paid')),
      });
    }
    if (can.includes('declined')) actions.push({ label: 'Decline', onPress: () => confirm('Decline this request?', '', () => void setStatus('declined')) });
    if (can.includes('cancelled')) actions.push({ label: 'Cancel', onPress: () => confirm('Cancel this payment?', '', () => void setStatus('cancelled')) });
  }

  const title = card.kind === 'request'
    ? isCreator ? 'You requested' : `${message.senderName || 'They'} requested`
    : isCreator ? 'You’re paying' : `${message.senderName || 'They'} is paying you`;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name={card.kind === 'request' ? 'arrow-down-circle' : 'arrow-up-circle'} size={18} color={Colors.accent} />
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.method}>{card.method === 'upi' ? 'UPI' : 'Link'}</Text>
      </View>
      <Text style={styles.amount}>{formatINR(card.amountPaise)}</Text>
      {card.note ? <Text style={styles.note}>{card.note}</Text> : null}
      {card.method === 'upi' && card.payeeVpa ? (
        <Text style={styles.meta} selectable>
          To {card.payeeName ? `${card.payeeName} · ` : ''}
          {card.payeeVpa}
        </Text>
      ) : null}
      <View style={styles.statusRow}>
        <View style={[styles.dot, { backgroundColor: STATUS_COLORS[state.status] }]} />
        <Text style={[styles.status, { color: STATUS_COLORS[state.status] }]}>{statusLabel(card, state)}</Text>
        {state.txnRef ? <Text style={styles.meta}> · Ref {state.txnRef}</Text> : null}
      </View>
      {state.status === 'paid' && !state.verified ? (
        <Text style={styles.hint}>Reported by a member. Check your UPI app to confirm.</Text>
      ) : null}

      {busy ? (
        <ActivityIndicator color={Colors.accent} style={{ marginTop: 10 }} />
      ) : actions.length > 0 ? (
        <View style={styles.actions}>
          {actions.map((a) => (
            <TouchableOpacity key={a.label} onPress={a.onPress} style={[styles.btn, a.primary && styles.btnPrimary]}>
              <Text style={[styles.btnText, a.primary && styles.btnTextPrimary]}>{a.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      <Text style={styles.footer}>🔒 End-to-end encrypted · Ref {card.ref}</Text>

      <UpiQrModal card={showQr ? card : null} visible={showQr} onClose={() => setShowQr(false)} />

      <Modal visible={askResult} transparent animationType="fade" onRequestClose={() => setAskResult(false)}>
        <Pressable style={styles.backdrop} onPress={() => setAskResult(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetTitle}>Did the payment go through?</Text>
            <Text style={styles.sheetBody}>
              Vero can’t see your bank. Check your UPI app, then let {card.kind === 'request' ? 'them' : 'the chat'} know.
            </Text>
            <TextInput
              style={styles.input}
              value={txnRef}
              onChangeText={setTxnRef}
              placeholder="UPI reference no. (optional)"
              placeholderTextColor={Colors.textTertiary}
              maxLength={40}
              autoCapitalize="characters"
            />
            <View style={styles.actions}>
              <TouchableOpacity
                style={[styles.btn, styles.btnPrimary]}
                onPress={() => {
                  setAskResult(false);
                  void setStatus('paid', txnRef);
                }}
              >
                <Text style={[styles.btnText, styles.btnTextPrimary]}>Paid</Text>
              </TouchableOpacity>
              {can.includes('failed') ? (
                <TouchableOpacity
                  style={styles.btn}
                  onPress={() => {
                    setAskResult(false);
                    void setStatus('failed', txnRef);
                  }}
                >
                  <Text style={styles.btnText}>Failed</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={styles.btn} onPress={() => setAskResult(false)}>
                <Text style={styles.btnText}>Not yet</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 260,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { color: Colors.textSecondary, fontSize: 13, flex: 1 },
  method: { color: Colors.textTertiary, fontSize: 11, fontWeight: '600' },
  amount: { color: Colors.textPrimary, fontSize: 28, fontWeight: '700', marginTop: 6 },
  note: { color: Colors.textPrimary, fontSize: 14, marginTop: 2 },
  meta: { color: Colors.textTertiary, fontSize: 12, marginTop: 4 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, flexWrap: 'wrap' },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  status: { fontSize: 13, fontWeight: '600' },
  hint: { color: Colors.textTertiary, fontSize: 11, marginTop: 4 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  btn: { borderWidth: 1, borderColor: Colors.border, borderRadius: 10, paddingVertical: 7, paddingHorizontal: 12 },
  btnPrimary: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  btnText: { color: Colors.textPrimary, fontSize: 13, fontWeight: '500' },
  btnTextPrimary: { color: Colors.white, fontWeight: '600' },
  footer: { color: Colors.textTertiary, fontSize: 10, marginTop: 10 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  sheet: { backgroundColor: Colors.surfaceElevated, borderRadius: 18, padding: 20, maxWidth: 420, width: '100%', alignSelf: 'center' },
  sheetTitle: { color: Colors.textPrimary, fontSize: 17, fontWeight: '600' },
  sheetBody: { color: Colors.textSecondary, fontSize: 13, marginTop: 6 },
  input: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    color: Colors.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
});
