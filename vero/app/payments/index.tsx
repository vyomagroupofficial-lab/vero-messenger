import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import dayjs from 'dayjs';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { friendlyError } from '../../src/core/network/supabase';
import { MyUpiProfile, paymentService } from '../../src/features/payments/PaymentService';
import { statusLabel } from '../../src/features/payments/paymentCard';
import { formatINR } from '../../src/features/payments/upi';
import { Colors } from '../../src/shared/theme/theme';

type HistoryItem = Awaited<ReturnType<typeof paymentService.history>>[number];

export default function PaymentsScreen() {
  const user = useAuthStore((s) => s.user);
  const [profile, setProfile] = useState<MyUpiProfile | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [vpa, setVpa] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[] | null>(null);

  useEffect(() => {
    void paymentService.getMyUpi().then((p) => {
      setProfile(p);
      setVpa(p?.vpa ?? '');
      setName(p?.name || user?.displayName || '');
      setEditing(!p);
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      void paymentService.history().then(setHistory).catch(() => setHistory([]));
    }, [])
  );

  const save = async () => {
    setError(null);
    try {
      const p = await paymentService.setMyUpi(vpa, name);
      setProfile(p);
      setEditing(false);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const remove = () =>
    Alert.alert('Remove UPI id?', 'You won’t be able to request money until you add one again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await paymentService.clearMyUpi();
          setProfile(null);
          setVpa('');
          setEditing(true);
        },
      },
    ]);

  const header = (
    <View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Your UPI id</Text>
        <Text style={styles.cardBody}>
          Used when you request money. It’s stored only in this device’s secure keystore and shared only inside
          end-to-end encrypted payment requests - never on Vero’s servers.
        </Text>
        {profile === undefined ? (
          <ActivityIndicator color={Colors.accent} style={{ marginTop: 12 }} />
        ) : editing ? (
          <>
            <TextInput
              style={styles.input}
              value={vpa}
              onChangeText={setVpa}
              placeholder="yourname@okbank"
              placeholderTextColor={Colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              maxLength={100}
            />
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Name shown to payers"
              placeholderTextColor={Colors.textTertiary}
              maxLength={64}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.row}>
              <TouchableOpacity style={styles.primary} onPress={save}>
                <Text style={styles.primaryText}>Save</Text>
              </TouchableOpacity>
              {profile ? (
                <TouchableOpacity style={styles.secondary} onPress={() => setEditing(false)}>
                  <Text style={styles.secondaryText}>Cancel</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </>
        ) : profile ? (
          <View style={styles.saved}>
            <View style={{ flex: 1 }}>
              <Text style={styles.vpa}>{profile.vpa}</Text>
              {profile.name ? <Text style={styles.meta}>{profile.name}</Text> : null}
            </View>
            <TouchableOpacity onPress={() => setEditing(true)} style={styles.iconBtn}>
              <Ionicons name="create-outline" size={20} color={Colors.accent} />
            </TouchableOpacity>
            <TouchableOpacity onPress={remove} style={styles.iconBtn}>
              <Ionicons name="trash-outline" size={20} color={Colors.error} />
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
      <Text style={styles.note}>
        Payments use your own UPI app. Vero can’t see or reverse transactions - a card marked “paid” is what a member
        reported unless it says “verified”.
      </Text>
      <Text style={styles.section}>History (this device)</Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Payments</Text>
      </View>
      <FlatList
        data={history ?? []}
        keyExtractor={(m) => m.id}
        ListHeaderComponent={header}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          history === null ? <ActivityIndicator color={Colors.accent} /> : <Text style={styles.empty}>No payments yet.</Text>
        }
        renderItem={({ item }) => {
          const { card, state } = item.ext;
          const outgoing = card.kind === 'request' ? !item.isOwn : item.isOwn;
          return (
            <TouchableOpacity style={styles.item} onPress={() => router.push(`/chat/${item.conversationId}`)}>
              <Ionicons
                name={outgoing ? 'arrow-up-circle' : 'arrow-down-circle'}
                size={28}
                color={outgoing ? Colors.warning : Colors.emerald}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.itemTitle} numberOfLines={1}>
                  {card.kind === 'request'
                    ? item.isOwn ? 'You requested' : `${item.senderName ?? 'Someone'} requested`
                    : item.isOwn ? `You paid ${card.payeeName ?? card.payeeVpa ?? ''}` : `${item.senderName ?? 'Someone'} paid you`}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {statusLabel(card, state)} · {dayjs(item.createdAt).format('D MMM YYYY, HH:mm')}
                  {card.note ? ` · ${card.note}` : ''}
                </Text>
              </View>
              <Text style={[styles.amount, outgoing && { color: Colors.textPrimary }]}>
                {outgoing ? '−' : '+'}
                {formatINR(card.amountPaise)}
              </Text>
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, gap: 4 },
  title: { color: Colors.textPrimary, fontSize: 20, fontWeight: '700' },
  list: { padding: 16 },
  card: { backgroundColor: Colors.surfaceElevated, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: Colors.border },
  cardTitle: { color: Colors.textPrimary, fontSize: 16, fontWeight: '600' },
  cardBody: { color: Colors.textSecondary, fontSize: 13, marginTop: 4, lineHeight: 18 },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    color: Colors.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginTop: 10,
  },
  error: { color: Colors.error, marginTop: 8, fontSize: 13 },
  row: { flexDirection: 'row', gap: 10, marginTop: 12 },
  primary: { backgroundColor: Colors.accent, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 },
  primaryText: { color: Colors.white, fontWeight: '600' },
  secondary: { borderWidth: 1, borderColor: Colors.border, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16 },
  secondaryText: { color: Colors.textPrimary },
  saved: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  vpa: { color: Colors.textPrimary, fontSize: 16, fontWeight: '600' },
  meta: { color: Colors.textTertiary, fontSize: 12, marginTop: 2 },
  iconBtn: { padding: 8 },
  note: { color: Colors.textTertiary, fontSize: 12, marginTop: 12, lineHeight: 17 },
  section: { color: Colors.textSecondary, fontSize: 13, fontWeight: '600', marginTop: 20, marginBottom: 8 },
  empty: { color: Colors.textTertiary, textAlign: 'center', padding: 20 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.border },
  itemTitle: { color: Colors.textPrimary, fontSize: 14, fontWeight: '500' },
  amount: { color: Colors.emerald, fontSize: 15, fontWeight: '700' },
});
