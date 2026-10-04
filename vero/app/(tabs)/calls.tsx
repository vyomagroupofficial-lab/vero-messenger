import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, SectionList, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import dayjs from 'dayjs';
import { databaseService, LocalCallRecord } from '../../src/core/storage/DatabaseService';
import { callService } from '../../src/features/calls/CallService';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { friendlyError } from '../../src/core/network/supabase';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Avatar, Chip, DotWall, EmptyState, Grain, Icon, IconButton, IconName, Pill, Pressy, Rise, Ripple, notify, useLayout } from '../../src/shared/ui';

type Filter = 'all' | 'missed';
const dirIcon = (d: LocalCallRecord['direction']): IconName => (d === 'outgoing' ? 'arrowOut' : 'arrowIn');

function clock(sec: number) {
  if (!sec) return '—';
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function CallRow({ call, index, selected, onPress, onCall }: { call: LocalCallRecord; index: number; selected: boolean; onPress: () => void; onCall: () => void }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const missed = call.direction === 'missed';
  const dirColor = missed ? c.danger : call.direction === 'incoming' ? c.success : c.accentText;
  const dur = call.duration >= 60 ? t('calls.minutes', { count: Math.round(call.duration / 60) }) : call.duration ? t('calls.seconds', { count: call.duration }) : '';
  const meta = `${dayjs(call.createdAt).format('h:mm A')} · ${missed ? t('calls.missedShort') : dur}`;
  const kind = t(`calls.${call.direction}${call.callType === 'video' ? 'Video' : 'Voice'}`);
  return (
    <Rise index={index}>
      <View style={[s.row, selected && s.rowSelected]}>
        <Pressy onPress={onPress} scaleTo={0.98} style={s.rowMain} accessibilityLabel={t('calls.callA11y', { name: call.peerName, kind })}>
          <Avatar name={call.peerName} size={48} />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text style={[s.name, missed && { color: c.danger }]} numberOfLines={1}>
              {call.peerName}
            </Text>
            <View style={s.metaRow}>
              <Icon name={dirIcon(call.direction)} size={15} color={dirColor} />
              <Text style={s.meta}>{meta}</Text>
            </View>
          </View>
        </Pressy>
        <IconButton
          icon={call.callType === 'video' ? 'video' : 'phone'}
          label={call.callType === 'video' ? t('calls.videoCallPerson', { name: call.peerName }) : t('calls.callPerson', { name: call.peerName })}
          color={c.accentText}
          onPress={onCall}
        />
      </View>
    </Rise>
  );
}

export default function CallsScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { c, type, f } = useTheme();
  const s = useStyles();
  const t = useT();
  const user = useAuthStore((st) => st.user);
  const isDemo = useAuthStore((st) => st.isDemo);
  const [calls, setCalls] = useState<LocalCallRecord[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setCalls(await databaseService.getCallLogs(50).catch(() => []));
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  useEffect(() => {
    if (isWide && !selectedId && calls.length) setSelectedId(calls[0].id);
  }, [isWide, calls.length]);

  const conversationFor = (peerId: string) => useChatsStore.getState().conversations.find((cv) => cv.otherUser?.id === peerId)?.id;

  const startCall = async (peerId: string, peerName: string, callType: 'voice' | 'video' = 'voice') => {
    if (!user?.id) return;
    try {
      if (peerId.startsWith('group:')) {
        // Group call log entry (see CallService.finish): call the group again.
        const groupCallId = await callService.startGroupCall({ conversationId: peerId.slice(6), groupName: peerName, callType });
        router.push(`/call/${groupCallId}`);
        return;
      }
      const conversationId = conversationFor(peerId) ?? (isDemo ? null : await conversationRepository.createDirectConversation(peerId));
      if (!conversationId) return;
      const callId = await callService.startCall({ conversationId, peerId, peerName, callType });
      router.push(`/call/${callId}`);
    } catch (e) {
      notify(t('calls.failed'), friendlyError(e));
    }
  };

  const sections = useMemo(() => {
    const list = calls.filter((cl) => filter === 'all' || cl.direction === 'missed');
    const bucket = (iso: string) => {
      const d = dayjs(iso);
      if (d.isSame(dayjs(), 'day')) return 'today';
      if (d.isSame(dayjs().subtract(1, 'day'), 'day')) return 'yesterday';
      return 'earlier';
    };
    return (['today', 'yesterday', 'earlier'] as const)
      .map((k) => ({ key: k, title: t(`calls.${k}`), data: list.filter((cl) => bucket(cl.createdAt) === k) }))
      .filter((sec) => sec.data.length > 0);
  }, [calls, filter, t]);

  const people = useMemo(() => {
    const seen = new Map<string, LocalCallRecord>();
    calls.forEach((cl) => !seen.has(cl.peerId) && seen.set(cl.peerId, cl));
    return [...seen.values()].slice(0, 6);
  }, [calls]);

  const selected = calls.find((cl) => cl.id === selectedId);
  const history = selected ? calls.filter((cl) => cl.peerId === selected.peerId) : [];

  const listHeader = (
    <View>
      <View style={[s.header, { paddingTop: isWide ? 24 : 16 + insets.top }]}>
        <Text style={type.title} accessibilityRole="header">
          {t('calls.title')}
        </Text>
        <IconButton icon="phonePlus" label={t('calls.newCall')} variant="brass" onPress={() => router.push('/(tabs)/contacts')} />
      </View>
      <View style={{ paddingHorizontal: 20, gap: 16 }}>
        <View style={s.beta}>
          <View style={s.betaIcon}>
            <Icon name="info" size={19} color={c.accentText} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[type.name, { fontSize: 14.5 }]}>{t('calls.betaTitle')}</Text>
            <Text style={type.caption}>{t('calls.betaBody')}</Text>
          </View>
        </View>
        {!isWide && people.length > 0 && (
          <View style={{ gap: 10 }}>
            <Text style={type.eyebrow}>{f.script === 'latin' ? t('calls.favourites').toUpperCase() : t('calls.favourites')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14 }}>
              {people.map((p, i) => (
                <Animated.View key={p.peerId} entering={ZoomIn.delay(60 + i * 50).springify().damping(14)}>
                  <Pressy onPress={() => startCall(p.peerId, p.peerName, p.callType)} style={s.fav} accessibilityLabel={t('calls.callPerson', { name: p.peerName })}>
                    <Avatar name={p.peerName} size={58} square />
                    <Text style={s.favName} numberOfLines={1}>
                      {p.peerName.split(' ')[0]}
                    </Text>
                  </Pressy>
                </Animated.View>
              ))}
            </ScrollView>
          </View>
        )}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Chip label={t('calls.all')} active={filter === 'all'} onPress={() => setFilter('all')} />
          <Chip label={t('calls.missed')} active={filter === 'missed'} onPress={() => setFilter('missed')} />
        </View>
      </View>
    </View>
  );

  const list = (
    <SectionList
      sections={sections}
      keyExtractor={(cl) => cl.id}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={listHeader}
      renderSectionHeader={({ section }) => <Text style={s.section}>{f.script === 'latin' ? section.title.toUpperCase() : section.title}</Text>}
      renderItem={({ item, index }) => (
        <CallRow
          call={item}
          index={index}
          selected={isWide && item.id === selectedId}
          onPress={() => (isWide ? setSelectedId(item.id) : startCall(item.peerId, item.peerName, item.callType))}
          onCall={() => startCall(item.peerId, item.peerName, item.callType)}
        />
      )}
      contentContainerStyle={{ paddingBottom: 32 }}
      showsVerticalScrollIndicator={false}
      ListEmptyComponent={<EmptyState icon="phone" title={t('calls.empty')} body={t('calls.emptyBody')} />}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load();
          }}
          tintColor={c.accent}
        />
      }
    />
  );

  if (!isWide) {
    return (
      <View style={s.container}>
        <Grain />
        {list}
      </View>
    );
  }

  const isGroup = !!selected?.peerId.startsWith('group:');
  const cid = selected ? (isGroup ? selected.peerId.slice(6) : conversationFor(selected.peerId)) : undefined;
  const actions: [IconName, string, () => void][] = selected
    ? [
        ['phone', t('calls.voice'), () => startCall(selected.peerId, selected.peerName, 'voice')],
        ['video', t('calls.video'), () => startCall(selected.peerId, selected.peerName, 'video')],
        ['chat', t('calls.message'), () => (cid ? router.push(`/chat/${cid}`) : router.push('/(tabs)/chats'))],
        ...(isGroup ? [] : [['user', t('calls.profile'), () => router.push(`/profile/${selected.peerId}`)] as [IconName, string, () => void]]),
      ]
    : [];

  return (
    <View style={[s.container, { flexDirection: 'row' }]}>
      <View style={s.listPane}>
        <Grain />
        {list}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <DotWall />
        {selected ? (
          <ScrollView contentContainerStyle={s.detail} key={selected.peerId}>
            <Animated.View entering={ZoomIn.springify().damping(16)}>
              <Ripple size={132} color={c.accentLine}>
                <Avatar name={selected.peerName} size={132} />
              </Ripple>
            </Animated.View>
            <Animated.View entering={FadeIn.delay(80)} style={{ alignItems: 'center', gap: 8 }}>
              <Text style={[type.title, { fontSize: 34, textAlign: 'center' }]}>{selected.peerName}</Text>
              <Pill icon="lock" label={t('calls.encrypted')} />
            </Animated.View>
            <Rise delay={120} style={s.actions}>
              {actions.map(([icon, label, fn]) => (
                <Pressy key={label} onPress={fn} style={s.action} hoverStyle={{ backgroundColor: c.field }} scaleTo={0.95} accessibilityLabel={label}>
                  <Icon name={icon} size={22} color={c.accentText} />
                  <Text style={s.actionLabel}>{label}</Text>
                </Pressy>
              ))}
            </Rise>
            <Rise delay={180} style={s.historyCard}>
              <Text style={[type.eyebrow, { paddingTop: 16, paddingBottom: 4 }]}>{f.script === 'latin' ? t('calls.history').toUpperCase() : t('calls.history')}</Text>
              {history.map((h, i) => (
                <View key={h.id} style={[s.historyRow, i > 0 && { borderTopWidth: 1, borderTopColor: c.line }]}>
                  <Icon name={dirIcon(h.direction)} size={20} color={h.direction === 'missed' ? c.danger : h.direction === 'incoming' ? c.success : c.accentText} />
                  <View style={{ flex: 1 }}>
                    <Text style={[type.body, { fontFamily: f.medium }, h.direction === 'missed' && { color: c.danger }]}>
                      {t(`calls.${h.direction}${h.callType === 'video' ? 'Video' : 'Voice'}`)}
                    </Text>
                    <Text style={type.caption}>{dayjs(h.createdAt).format('ddd D MMM, h:mm A')}</Text>
                  </View>
                  <Text style={[type.mono, { fontSize: 13, color: c.muted }]}>{clock(h.duration)}</Text>
                </View>
              ))}
            </Rise>
          </ScrollView>
        ) : (
          <EmptyState icon="phone" title={t('calls.pick')} body={calls.length ? t('calls.pickBody') : t('calls.emptyBody')} />
        )}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  container: { flex: 1, backgroundColor: c.bg },
  listPane: { width: 380, backgroundColor: c.panel, borderRightWidth: 1, borderRightColor: c.line },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 14 },
  beta: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 12, borderRadius: 18, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2 },
  betaIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center' },
  fav: { alignItems: 'center', gap: 6, width: 66 },
  favName: { fontFamily: f.medium, fontSize: 12, color: c.muted },
  section: { ...t.eyebrow, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 18 },
  rowSelected: { backgroundColor: c.raised, borderWidth: 1, borderColor: c.line },
  rowMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 13 },
  name: { fontFamily: f.semibold, fontSize: 16, color: c.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { fontFamily: f.body, fontSize: 13, color: c.muted },
  detail: { alignItems: 'center', gap: 24, paddingTop: 110, paddingBottom: 64, paddingHorizontal: 32, maxWidth: 620, width: '100%', alignSelf: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, width: '100%' },
  action: { flex: 1, minWidth: 110, height: 80, borderRadius: 18, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center', gap: 7 },
  actionLabel: { fontFamily: f.medium, fontSize: 13, color: c.text },
  historyCard: { width: '100%', borderRadius: 22, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, paddingHorizontal: 22, paddingBottom: 8 },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
}));
