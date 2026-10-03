import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, SectionList, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import dayjs from 'dayjs';
import { databaseService, LocalCallRecord } from '../../src/core/storage/DatabaseService';
import { callService } from '../../src/features/calls/CallService';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { DEMO_CALLS, DEMO_USER_ID, demoConversationFor } from '../../src/features/demo/demoData';
import { Colors, Fonts, Type } from '../../src/shared/theme/theme';
import {
  Avatar,
  Chip,
  EmptyState,
  Grain,
  Icon,
  IconButton,
  IconName,
  Pill,
  Pressy,
  Rise,
  Ripple,
  DotWall,
  useLayout,
} from '../../src/shared/ui';

type Filter = 'All' | 'Missed';

const dirIcon = (d: LocalCallRecord['direction']): IconName => (d === 'outgoing' ? 'arrowOut' : 'arrowIn');
const dirColor = (d: LocalCallRecord['direction']) => (d === 'missed' ? Colors.ember : d === 'incoming' ? Colors.sage : Colors.brass);

function durationOf(sec: number) {
  if (!sec) return '';
  if (sec < 60) return `${sec} s`;
  return `${Math.round(sec / 60)} min`;
}

function clock(sec: number) {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function sectionOf(iso: string) {
  const d = dayjs(iso);
  if (d.isSame(dayjs(), 'day')) return 'Today';
  if (d.isSame(dayjs().subtract(1, 'day'), 'day')) return 'Yesterday';
  return 'Earlier';
}

function whenOf(iso: string) {
  const d = dayjs(iso);
  if (d.isSame(dayjs(), 'day')) return d.format('h:mm A');
  if (d.isSame(dayjs().subtract(1, 'day'), 'day')) return `Yesterday, ${d.format('h:mm A')}`;
  return d.format('ddd D MMM, h:mm A');
}

function CallRow({ call, index, selected, onPress, onCall }: {
  call: LocalCallRecord;
  index: number;
  selected: boolean;
  onPress: () => void;
  onCall: () => void;
}) {
  const missed = call.direction === 'missed';
  const meta = missed ? `${dayjs(call.createdAt).format('h:mm A')} · Missed` : `${dayjs(call.createdAt).format('h:mm A')} · ${durationOf(call.duration)}`;
  return (
    <Rise index={index}>
      <View style={[styles.row, selected && styles.rowSelected]}>
        <Pressy
          onPress={onPress}
          scaleTo={0.98}
          style={styles.rowMain}
          accessibilityLabel={`${call.peerName}, ${call.direction} ${call.callType} call`}
        >
          <Avatar name={call.peerName} size={48} />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text style={[styles.name, missed && { color: Colors.ember }]} numberOfLines={1}>
              {call.peerName}
            </Text>
            <View style={styles.metaRow}>
              <Icon name={dirIcon(call.direction)} size={15} color={dirColor(call.direction)} />
              <Text style={styles.meta}>{meta}</Text>
            </View>
          </View>
        </Pressy>
        <IconButton
          icon={call.callType === 'video' ? 'video' : 'phone'}
          label={`${call.callType === 'video' ? 'Video call' : 'Call'} ${call.peerName}`}
          color={Colors.brass}
          onPress={onCall}
        />
      </View>
    </Rise>
  );
}

export default function CallsScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { user } = useAuthStore();
  const [calls, setCalls] = useState<LocalCallRecord[]>([]);
  const [filter, setFilter] = useState<Filter>('All');
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (user?.id === DEMO_USER_ID) {
      setCalls(DEMO_CALLS);
      setRefreshing(false);
      return;
    }
    const logs = await databaseService.getCallLogs(50).catch(() => []);
    setCalls(logs.length ? logs : DEMO_CALLS);
    setRefreshing(false);
  }, [user?.id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (isWide && !selectedId && calls.length) setSelectedId(calls[0].id);
  }, [isWide, calls]);

  const startCall = async (peerId: string, peerName: string, callType: 'voice' | 'video' = 'voice') => {
    if (!user?.id) return;
    const callId = await callService.startCall({
      peerId,
      peerName,
      callType,
      currentUserId: user.id,
      currentUserName: user.displayName || user.username || 'You',
    });
    router.push(`/call/${callId}` as any);
  };

  const sections = useMemo(() => {
    const list = calls.filter((c) => filter === 'All' || c.direction === 'missed');
    const order = ['Today', 'Yesterday', 'Earlier'];
    return order
      .map((title) => ({ title, data: list.filter((c) => sectionOf(c.createdAt) === title) }))
      .filter((s) => s.data.length > 0);
  }, [calls, filter]);

  const favourites = useMemo(() => {
    const seen = new Map<string, LocalCallRecord>();
    calls.forEach((c) => {
      if (!seen.has(c.peerId)) seen.set(c.peerId, c);
    });
    return [...seen.values()].slice(0, 5);
  }, [calls]);

  const selected = calls.find((c) => c.id === selectedId);
  const history = selected ? calls.filter((c) => c.peerId === selected.peerId) : [];

  const listHeader = (
    <View>
      <View style={[styles.header, { paddingTop: (isWide ? 24 : 16) + (isWide ? 0 : insets.top) }]}>
        <Text style={Type.title}>Calls</Text>
        <IconButton icon="phonePlus" label="New call" variant="brass" onPress={() => router.push('/(tabs)/contacts' as any)} />
      </View>
      <View style={{ paddingHorizontal: 20, gap: 16 }}>
        {!isWide && favourites.length > 0 && (
          <View style={{ gap: 10 }}>
            <Text style={Type.eyebrow}>FAVOURITES</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14 }}>
              {favourites.map((f, i) => (
                <Animated.View key={f.peerId} entering={ZoomIn.delay(60 + i * 50).springify().damping(14)}>
                  <Pressy onPress={() => startCall(f.peerId, f.peerName, f.callType)} style={styles.fav} accessibilityLabel={`Call ${f.peerName}`}>
                    <Avatar name={f.peerName} size={58} square />
                    <Text style={styles.favName} numberOfLines={1}>
                      {f.peerName.split(' ')[0]}
                    </Text>
                  </Pressy>
                </Animated.View>
              ))}
            </ScrollView>
          </View>
        )}
        <Pressy style={styles.linkCard} scaleTo={0.98} hoverStyle={{ backgroundColor: 'rgba(214,166,87,0.12)' }} accessibilityLabel="Create a call link">
          <View style={styles.linkIcon}>
            <Icon name="link" size={21} color={Colors.brassInk} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[Type.name, { fontSize: 15 }]}>Create a call link</Text>
            <Text style={Type.caption}>Anyone with Vero can join</Text>
          </View>
          <Icon name="forwardChevron" size={18} color={Colors.faint} />
        </Pressy>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['All', 'Missed'] as Filter[]).map((f) => (
            <Chip key={f} label={f} active={filter === f} onPress={() => setFilter(f)} />
          ))}
        </View>
      </View>
    </View>
  );

  const list = (
    <SectionList
      sections={sections}
      keyExtractor={(c) => c.id}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={listHeader}
      renderSectionHeader={({ section }) => <Text style={styles.section}>{section.title.toUpperCase()}</Text>}
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
      ListEmptyComponent={<EmptyState icon="phone" title="No calls yet" body="Voice and video calls are end-to-end encrypted, just like your messages." />}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
          tintColor={Colors.brass}
        />
      }
    />
  );

  if (!isWide) {
    return (
      <View style={styles.container}>
        <Grain />
        {list}
      </View>
    );
  }

  return (
    <View style={[styles.container, { flexDirection: 'row' }]}>
      <View style={styles.listPane}>
        <Grain />
        {list}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <DotWall />
        {selected ? (
          <ScrollView contentContainerStyle={styles.detail} key={selected.peerId}>
            <Animated.View entering={ZoomIn.springify().damping(16)}>
              <Ripple size={132}>
                <Avatar name={selected.peerName} size={132} />
              </Ripple>
            </Animated.View>
            <Animated.View entering={FadeIn.delay(80)} style={{ alignItems: 'center', gap: 8 }}>
              <Text style={[Type.title, { fontSize: 34, textAlign: 'center' }]}>{selected.peerName}</Text>
              <Pill icon="lock" label="Calls are end-to-end encrypted" />
            </Animated.View>
            <Rise delay={120} style={styles.actions}>
              {(
                [
                  ['phone', 'Voice', () => startCall(selected.peerId, selected.peerName, 'voice')],
                  ['video', 'Video', () => startCall(selected.peerId, selected.peerName, 'video')],
                  [
                    'chat',
                    'Message',
                    () => {
                      const cid = demoConversationFor(selected.peerId);
                      router.push((cid ? `/chat/${cid}` : '/(tabs)/chats') as any);
                    },
                  ],
                  ['user', 'Profile', () => router.push(`/profile/${selected.peerId}?name=${encodeURIComponent(selected.peerName)}` as any)],
                ] as [IconName, string, () => void][]
              ).map(([icon, label, fn]) => (
                <Pressy key={label} onPress={fn} style={styles.action} hoverStyle={{ backgroundColor: Colors.field }} scaleTo={0.95}>
                  <Icon name={icon} size={22} color={Colors.brass} />
                  <Text style={styles.actionLabel}>{label}</Text>
                </Pressy>
              ))}
            </Rise>
            <Rise delay={180} style={styles.historyCard}>
              <Text style={[Type.eyebrow, { paddingTop: 16, paddingBottom: 4 }]}>CALL HISTORY</Text>
              {history.map((h, i) => (
                <View key={h.id} style={[styles.historyRow, i > 0 && { borderTopWidth: 1, borderTopColor: Colors.divider }]}>
                  <Icon name={dirIcon(h.direction)} size={20} color={dirColor(h.direction)} />
                  <View style={{ flex: 1 }}>
                    <Text style={[Type.body, { fontFamily: Fonts.medium }, h.direction === 'missed' && { color: Colors.ember }]}>
                      {h.direction === 'missed' ? 'Missed' : h.direction === 'incoming' ? 'Incoming' : 'Outgoing'} {h.callType} call
                    </Text>
                    <Text style={Type.caption}>{whenOf(h.createdAt)}</Text>
                  </View>
                  <Text style={[Type.mono, { fontSize: 13, color: Colors.muted }]}>{clock(h.duration)}</Text>
                </View>
              ))}
            </Rise>
          </ScrollView>
        ) : (
          <EmptyState icon="phone" title="Your calls" body="Pick a call on the left to see its history." />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.ink },
  listPane: { width: 380, backgroundColor: Colors.panel, borderRightWidth: 1, borderRightColor: Colors.line },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 14 },
  fav: { alignItems: 'center', gap: 6, width: 66 },
  favName: { fontFamily: Fonts.medium, fontSize: 12, color: Colors.muted },
  linkCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 18,
    backgroundColor: Colors.brassTint,
    borderWidth: 1,
    borderColor: 'rgba(214,166,87,0.2)',
  },
  linkIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: Colors.brass, alignItems: 'center', justifyContent: 'center' },
  section: { ...Type.eyebrow, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 18 },
  rowMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 13 },
  rowSelected: { backgroundColor: Colors.raised, borderWidth: 1, borderColor: Colors.line },
  name: { fontFamily: Fonts.semibold, fontSize: 16, color: Colors.cream },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { fontFamily: Fonts.body, fontSize: 13, color: Colors.muted },
  detail: { alignItems: 'center', gap: 24, paddingTop: 110, paddingBottom: 64, paddingHorizontal: 32, maxWidth: 620, width: '100%', alignSelf: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, width: '100%' },
  action: {
    flex: 1,
    minWidth: 110,
    height: 80,
    borderRadius: 18,
    backgroundColor: Colors.raised,
    borderWidth: 1,
    borderColor: Colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },
  actionLabel: { fontFamily: Fonts.medium, fontSize: 13, color: Colors.cream },
  historyCard: {
    width: '100%',
    borderRadius: 22,
    backgroundColor: Colors.panel,
    borderWidth: 1,
    borderColor: Colors.line,
    paddingHorizontal: 22,
    paddingBottom: 8,
  },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
});
