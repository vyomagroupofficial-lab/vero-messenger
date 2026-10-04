/**
 * Encrypted payment card in a chat: amount, note, payee, status and the
 * actions available to the viewer (see paymentCard.ts for the rules).
 */

import React, { useState } from 'react';
import { ActivityIndicator, Platform, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useAuthStore } from '../../auth/useAuthStore';
import { friendlyError } from '../../../core/network/supabase';
import { useT } from '../../../shared/i18n';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { Button, Hatch, Icon, Sheet, TextField, confirmAction, notify } from '../../../shared/ui';
import type { Message } from '../../../shared/models/Message';
import type { PaymentCard, PaymentState, PaymentStatus } from '../../../shared/models/payloadExtensions';
import { allowedTransitions } from '../paymentCard';
import { isPaymentMessage, paymentService } from '../PaymentService';
import { formatINR } from '../upi';
import { UpiQrModal } from './UpiQrModal';

export function statusText(t: (k: string) => string, card: PaymentCard, state: PaymentState): string {
  if (state.status === 'pending') return card.kind === 'request' ? t('payments.status_requested') : t('payments.status_awaiting');
  if (state.status === 'paid') return state.verified ? t('payments.status_verified') : t('payments.status_marked');
  return t(`payments.status_${state.status}`);
}

export function PaymentCardBubble({ message }: { message: Message }) {
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const myId = useAuthStore((st) => st.user?.id);
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
  const statusColor: Record<PaymentStatus, string> = { pending: c.accentText, paid: c.success, failed: c.danger, declined: c.faint, cancelled: c.faint };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(t('payments.title'), friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (status: Exclude<PaymentStatus, 'pending'>, ref?: string) => run(() => paymentService.setStatus(message, status, ref));

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

  const confirm = (title: string, body: string, action: () => void) => confirmAction({ title, message: body, confirmLabel: t('payments.confirm'), onConfirm: action });

  const actions: { label: string; onPress: () => void; primary?: boolean }[] = [];
  if (!failed && can.length > 0) {
    if (iAmPayer && can.includes('paid')) {
      actions.push({ label: card.method === 'link' ? t('payments.openPage') : t('payments.payAmount', { amount: formatINR(card.amountPaise) }), onPress: payNow, primary: true });
      if (card.method === 'upi' && Platform.OS !== 'web') actions.push({ label: t('payments.qr'), onPress: () => setShowQr(true) });
      actions.push({ label: t('payments.ivePaid'), onPress: () => setAskResult(true) });
    }
    if (!iAmPayer && can.includes('paid')) {
      if (card.method === 'link' && isCreator) {
        actions.push({
          label: t('payments.check'),
          primary: true,
          onPress: () =>
            run(async () => {
              const status = await paymentService.checkLink(message);
              if (status !== 'paid') notify(t('payments.linkTitle'), t('payments.linkStatus', { status: status.replace('_', ' ') }));
            }),
        });
      }
      actions.push({ label: t('payments.markReceived'), onPress: () => confirm(t('payments.markReceivedQ'), t('payments.markReceivedBody'), () => void setStatus('paid')) });
    }
    if (can.includes('declined')) actions.push({ label: t('payments.decline'), onPress: () => confirm(t('payments.declineQ'), '', () => void setStatus('declined')) });
    if (can.includes('cancelled')) actions.push({ label: t('common.cancel'), onPress: () => confirm(t('payments.cancelQ'), '', () => void setStatus('cancelled')) });
  }

  const who = message.senderName || t('payments.they');
  const title = card.kind === 'request' ? (isCreator ? t('payments.youRequested') : t('payments.theyRequested', { name: who })) : isCreator ? t('payments.youPaying') : t('payments.theyPaying', { name: who });

  return (
    <View style={s.card}>
      <Hatch gap={12} />
      <View style={s.header}>
        <View style={s.dirIcon}>
          <Icon name={card.kind === 'request' ? 'arrowIn' : 'arrowOut'} size={15} color={c.accentText} />
        </View>
        <Text style={[type.caption, { flex: 1 }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={s.method}>{card.method === 'upi' ? 'UPI' : t('payments.linkShort')}</Text>
      </View>
      <Text style={s.amount}>{formatINR(card.amountPaise)}</Text>
      {card.note ? <Text style={[type.body, { fontSize: 14.5 }]}>{card.note}</Text> : null}
      {card.method === 'upi' && card.payeeVpa ? (
        <Text style={s.meta} selectable>
          {t('payments.to')} {card.payeeName ? `${card.payeeName} · ` : ''}
          {card.payeeVpa}
        </Text>
      ) : null}
      <View style={s.statusRow}>
        <View style={[s.dot, { backgroundColor: statusColor[state.status] }]} />
        <Text style={[s.status, { color: statusColor[state.status] }]}>{statusText(t, card, state)}</Text>
        {state.txnRef ? <Text style={s.meta}> · {t('payments.ref', { ref: state.txnRef })}</Text> : null}
      </View>
      {state.status === 'paid' && !state.verified ? <Text style={type.caption}>{t('payments.reportedHint')}</Text> : null}

      {busy ? (
        <ActivityIndicator color={c.accent} style={{ marginTop: 10 }} />
      ) : actions.length > 0 ? (
        <Animated.View entering={FadeIn} style={s.actions}>
          {actions.map((a) => (
            <Button key={a.label} label={a.label} size="sm" variant={a.primary ? 'primary' : 'secondary'} onPress={a.onPress} />
          ))}
        </Animated.View>
      ) : null}
      <View style={s.footer}>
        <Icon name="lock" size={11} color={c.faint} />
        <Text style={s.footerText}>{t('payments.footer', { ref: card.ref })}</Text>
      </View>

      <UpiQrModal card={showQr ? card : null} visible={showQr} onClose={() => setShowQr(false)} />

      <Sheet visible={askResult} onClose={() => setAskResult(false)} title={t('payments.didGoThrough')}>
        <Text style={type.bodyMuted}>{card.kind === 'request' ? t('payments.letThemKnow') : t('payments.letChatKnow')}</Text>
        <TextField icon="file" value={txnRef} onChangeText={setTxnRef} placeholder={t('payments.refPlaceholder')} maxLength={40} autoCapitalize="characters" />
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Button
            label={t('payments.paid')}
            size="md"
            style={{ flex: 1 }}
            onPress={() => {
              setAskResult(false);
              void setStatus('paid', txnRef);
            }}
          />
          {can.includes('failed') ? (
            <Button
              label={t('payments.failed')}
              variant="dangerSoft"
              size="md"
              style={{ flex: 1 }}
              onPress={() => {
                setAskResult(false);
                void setStatus('failed', txnRef);
              }}
            />
          ) : null}
          <Button label={t('payments.notYet')} variant="secondary" size="md" style={{ flex: 1 }} onPress={() => setAskResult(false)} />
        </View>
      </Sheet>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  card: { width: 272, backgroundColor: c.panel, borderRadius: 22, borderWidth: 1, borderColor: c.accentTint2, padding: 14, gap: 4, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dirIcon: { width: 26, height: 26, borderRadius: 9, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center' },
  method: { fontFamily: f.mono, color: c.faint, fontSize: 10.5, letterSpacing: 0.8 },
  amount: { fontFamily: f.display, color: c.text, fontSize: 32, marginTop: 6 },
  meta: { fontFamily: f.body, color: c.muted, fontSize: 12, marginTop: 2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, flexWrap: 'wrap' },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  status: { fontFamily: f.semibold, fontSize: 13 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 10 },
  footerText: { fontFamily: f.mono, color: c.faint, fontSize: 10 },
}));
