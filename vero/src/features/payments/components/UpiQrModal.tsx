/**
 * Shows a upi://pay link as a QR code (web/desktop, or to pay from another
 * phone). Any UPI app's "Scan & pay" understands it.
 */

import React, { useMemo } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import qrcode from 'qrcode-generator';
import { Colors } from '../../../shared/theme/theme';
import type { PaymentCard } from '../../../shared/models/payloadExtensions';
import { formatINR, upiUrlForCard } from '../upi';

export function upiQrDataUrl(url: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(url, 'Byte');
  qr.make();
  return qr.createDataURL(8, 4);
}

export function UpiQrModal({ card, visible, onClose }: { card: PaymentCard | null; visible: boolean; onClose: () => void }) {
  const url = card ? upiUrlForCard(card) : null;
  const dataUrl = useMemo(() => (url ? upiQrDataUrl(url) : null), [url]);
  if (!card || !url || !dataUrl) return null;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title}>Scan with any UPI app</Text>
          <Text style={styles.amount}>{formatINR(card.amountPaise)}</Text>
          <View style={styles.qrWrap}>
            <Image source={{ uri: dataUrl }} style={styles.qr} resizeMode="contain" accessibilityLabel="UPI payment QR code" />
          </View>
          <Text style={styles.vpa} selectable>
            {card.payeeName ? `${card.payeeName} · ` : ''}
            {card.payeeVpa}
          </Text>
          {card.note ? <Text style={styles.note}>{card.note}</Text> : null}
          <View style={styles.row}>
            <TouchableOpacity style={styles.secondary} onPress={() => void Clipboard.setStringAsync(card.payeeVpa ?? '')}>
              <Text style={styles.secondaryText}>Copy UPI id</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primary} onPress={onClose}>
              <Text style={styles.primaryText}>Done</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>After paying, come back and mark the payment as paid.</Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 360, backgroundColor: Colors.surfaceElevated, borderRadius: 20, padding: 20, alignItems: 'center' },
  title: { color: Colors.textSecondary, fontSize: 14, marginBottom: 4 },
  amount: { color: Colors.textPrimary, fontSize: 28, fontWeight: '700', marginBottom: 12 },
  qrWrap: { backgroundColor: '#fff', borderRadius: 12, padding: 8 },
  qr: { width: 240, height: 240 },
  vpa: { color: Colors.textPrimary, fontSize: 14, marginTop: 12, textAlign: 'center' },
  note: { color: Colors.textSecondary, fontSize: 13, marginTop: 4, textAlign: 'center' },
  row: { flexDirection: 'row', gap: 10, marginTop: 16 },
  primary: { backgroundColor: Colors.accent, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 20 },
  primaryText: { color: Colors.white, fontWeight: '600' },
  secondary: { borderColor: Colors.border, borderWidth: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 16 },
  secondaryText: { color: Colors.textPrimary },
  hint: { color: Colors.textTertiary, fontSize: 12, marginTop: 12, textAlign: 'center' },
});
