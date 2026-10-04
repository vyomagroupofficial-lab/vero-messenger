/**
 * Shows a upi://pay link as a QR code (web/desktop, or to pay from another
 * phone). Any UPI app's "Scan & pay" understands it.
 */

import React, { useMemo } from 'react';
import { Image, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import qrcode from 'qrcode-generator';
import { useT } from '../../../shared/i18n';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { Button, Sheet, notify } from '../../../shared/ui';
import type { PaymentCard } from '../../../shared/models/payloadExtensions';
import { formatINR, upiUrlForCard } from '../upi';

export function upiQrDataUrl(url: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(url, 'Byte');
  qr.make();
  return qr.createDataURL(8, 4);
}

export function UpiQrModal({ card, visible, onClose }: { card: PaymentCard | null; visible: boolean; onClose: () => void }) {
  const { type } = useTheme();
  const s = useStyles();
  const t = useT();
  const url = card ? upiUrlForCard(card) : null;
  const dataUrl = useMemo(() => (url ? upiQrDataUrl(url) : null), [url]);
  if (!card || !url || !dataUrl) return null;
  return (
    <Sheet visible={visible} onClose={onClose} title={t('payments.scanTitle')}>
      <View style={{ alignItems: 'center', gap: 12 }}>
        <Text style={s.amount}>{formatINR(card.amountPaise)}</Text>
        <View style={s.qrWrap}>
          <Image source={{ uri: dataUrl }} style={s.qr} resizeMode="contain" accessibilityLabel={t('payments.qrA11y')} />
        </View>
        <Text style={[type.body, { textAlign: 'center' }]} selectable>
          {card.payeeName ? `${card.payeeName} · ` : ''}
          {card.payeeVpa}
        </Text>
        {card.note ? <Text style={[type.caption, { textAlign: 'center' }]}>{card.note}</Text> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button
          label={t('payments.copyVpa')}
          icon="copy"
          variant="secondary"
          size="md"
          style={{ flex: 1 }}
          onPress={() => {
            void Clipboard.setStringAsync(card.payeeVpa ?? '');
            notify(t('verify.copied'));
          }}
        />
        <Button label={t('common.done')} size="md" style={{ flex: 1 }} onPress={onClose} />
      </View>
      <Text style={[type.caption, { textAlign: 'center' }]}>{t('payments.markAfter')}</Text>
    </Sheet>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  amount: { fontFamily: f.display, fontSize: 34, color: c.text },
  qrWrap: { backgroundColor: '#FFFFFF', borderRadius: 22, padding: 12, borderWidth: 3, borderColor: c.accent },
  qr: { width: 232, height: 232 },
}));
