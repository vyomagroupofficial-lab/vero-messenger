import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import dayjs from 'dayjs';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { friendlyError } from '../../src/core/network/supabase';
import { MyUpiProfile, paymentService } from '../../src/features/payments/PaymentService';
import { statusText } from '../../src/features/payments/components/PaymentCardBubble';
import { formatINR } from '../../src/features/payments/upi';
import { ScreenHeader } from '../../src/features/groups/components/GroupComponents';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button, EmptyState, Eyebrow, Grain, Hatch, Icon, IconButton, Pressy, Rise, TextField, confirmAction } from '../../src/shared/ui';

type HistoryItem = Awaited<ReturnType<typeof paymentService.history>>[number];

export default function PaymentsScreen() {
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const user = useAuthStore((st) => st.user);
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
    confirmAction({
      title: t('payments.removeTitle'),
      message: t('payments.removeBody'),
      confirmLabel: t('groups.removeConfirm'),
      destructive: true,
      onConfirm: async () => {
        await paymentService.clearMyUpi();
        setProfile(null);
        setVpa('');
        setEditing(true);
      },
    });

  const header = (
    <View style={{ gap: 14 }}>
      <View style={s.card}>
        <Hatch gap={12} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={s.walletIcon}>
            <Icon name="wallet" size={22} color={c.onAccent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[type.name, { fontSize: 17 }]}>{t('payments.yourUpi')}</Text>
            <Text style={type.caption}>{t('payments.upiNote')}</Text>
          </View>
        </View>
        {profile === undefined ? (
          <ActivityIndicator color={c.accent} />
        ) : editing ? (
          <Animated.View entering={FadeIn} style={{ gap: 10 }}>
            <TextField icon="at" value={vpa} onChangeText={setVpa} placeholder="yourname@okbank" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" maxLength={100} />
            <TextField icon="user" value={name} onChangeText={setName} placeholder={t('payments.nameShown')} maxLength={64} />
            {error ? <Text style={[type.caption, { color: c.danger }]}>{error}</Text> : null}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {profile ? <Button label={t('common.cancel')} variant="secondary" size="md" style={{ flex: 1 }} onPress={() => setEditing(false)} /> : null}
              <Button label={t('common.save')} size="md" style={{ flex: 1 }} onPress={save} />
            </View>
          </Animated.View>
        ) : profile ? (
          <View style={s.saved}>
            <View style={{ flex: 1 }}>
              <Text style={s.vpa}>{profile.vpa}</Text>
              {profile.name ? <Text style={type.caption}>{profile.name}</Text> : null}
            </View>
            <IconButton icon="edit" label={t('payments.editUpi')} color={c.accentText} onPress={() => setEditing(true)} />
            <IconButton icon="trash" label={t('payments.removeTitle')} color={c.danger} onPress={remove} />
          </View>
        ) : null}
      </View>
      <View style={s.note}>
        <Icon name="info" size={14} color={c.faint} />
        <Text style={[type.caption, { flex: 1 }]}>{t('payments.disclaimer')}</Text>
      </View>
      <Eyebrow style={{ marginTop: 6 }}>{t('payments.history')}</Eyebrow>
    </View>
  );

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <Grain />
      <ScreenHeader title={t('payments.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/settings'))} />
      <FlatList
        data={history ?? []}
        keyExtractor={(m) => m.id}
        ListHeaderComponent={header}
        contentContainerStyle={[s.list, { paddingBottom: insets.bottom + 40 }]}
        ListEmptyComponent={history === null ? <ActivityIndicator color={c.accent} /> : <EmptyState icon="wallet" title={t('payments.noneTitle')} body={t('payments.none')} />}
        renderItem={({ item, index }) => {
          const { card, state } = item.ext;
          const outgoing = card.kind === 'request' ? !item.isOwn : item.isOwn;
          const who = item.senderName ?? t('common.someone');
          const title =
            card.kind === 'request'
              ? item.isOwn
                ? t('payments.youRequested')
                : t('payments.theyRequested', { name: who })
              : item.isOwn
              ? t('payments.youPaid', { name: card.payeeName ?? card.payeeVpa ?? '' })
              : t('payments.paidYou', { name: who });
          return (
            <Rise index={Math.min(index, 10)}>
              <Pressy style={s.item} onPress={() => router.push(`/chat/${item.conversationId}`)} scaleTo={0.98} hoverStyle={{ backgroundColor: c.tint }} accessibilityLabel={title}>
                <View style={[s.dir, { backgroundColor: outgoing ? c.accentTint : c.successTint }]}>
                  <Icon name={outgoing ? 'arrowOut' : 'arrowIn'} size={18} color={outgoing ? c.accentText : c.success} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.itemTitle} numberOfLines={1}>
                    {title}
                  </Text>
                  <Text style={type.caption} numberOfLines={1}>
                    {statusText(t, card, state)} · {dayjs(item.createdAt).format('D MMM YYYY, HH:mm')}
                    {card.note ? ` · ${card.note}` : ''}
                  </Text>
                </View>
                <Text style={[s.amount, { color: outgoing ? c.text : c.success }]}>
                  {outgoing ? '−' : '+'}
                  {formatINR(card.amountPaise)}
                </Text>
              </Pressy>
            </Rise>
          );
        }}
      />
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  root: { flex: 1, backgroundColor: c.bg },
  list: { padding: 16, width: '100%', maxWidth: 680, alignSelf: 'center' },
  card: { backgroundColor: c.panel, borderRadius: 24, padding: 16, gap: 14, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
  walletIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
  saved: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: 12, borderRadius: 16, backgroundColor: c.raised },
  vpa: { fontFamily: f.mono, color: c.text, fontSize: 15 },
  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 8, borderRadius: 16 },
  dir: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  itemTitle: { fontFamily: f.medium, color: c.text, fontSize: 14.5 },
  amount: { fontFamily: f.display, fontSize: 16 },
}));
