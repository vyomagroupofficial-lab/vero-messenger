import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import dayjs from 'dayjs';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { ChatThread, NoChatSelected } from '../../src/features/chats/ChatThread';
import { databaseService } from '../../src/core/storage/DatabaseService';
import { DEMO_CONVERSATIONS, DEMO_ONLINE, DEMO_USER_ID } from '../../src/features/demo/demoData';
import { Conversation, Message } from '../../src/shared/models/Message';
import { Colors, Fonts, Type } from '../../src/shared/theme/theme';
import {
  Avatar,
  Badge,
  Chip,
  EmptyState,
  Grain,
  Icon,
  IconButton,
  IconName,
  Pressy,
  Rise,
  SearchField,
  VeroMark,
  useLayout,
} from '../../src/shared/ui';

const CATEGORIES = ['All', 'Unread', 'Groups', 'Direct'] as const;
type Category = (typeof CATEGORIES)[number];

function nameOf(c: Conversation) {
  return c.conversationType === 'direct' ? c.otherUser?.displayName || 'Unknown' : c.groupName || 'Group';
}

function timeOf(iso?: string) {
  if (!iso) return '';
  const d = dayjs(iso);
  if (d.isSame(dayjs(), 'day')) return d.format('h:mm A');
  if (d.isSame(dayjs().subtract(1, 'day'), 'day')) return 'Yesterday';
  if (d.isAfter(dayjs().subtract(6, 'day'))) return d.format('ddd');
  return d.format('D MMM');
}

function previewOf(c: Conversation): { icon?: IconName; text: string } {
  const m = c.lastMessage;
  if (!m) return { icon: 'lock', text: 'End-to-end encrypted' };
  const who = c.conversationType === 'group' && !m.isOwn && m.senderDisplayName ? `${m.senderDisplayName.split(' ')[0]}: ` : '';
  switch (m.messageType) {
    case 'image':
      return { icon: 'image', text: `${who}Photo` };
    case 'video':
      return { icon: 'video', text: `${who}Video` };
    case 'voice':
    case 'audio':
      return { icon: 'mic', text: `${who}Voice message` };
    case 'document':
      return { icon: 'file', text: `${who}${m.content || 'Document'}` };
    default:
      return { text: `${who}${m.content || 'Message'}` };
  }
}

// ── Row ─────────────────────────────────────────────────────────────────────

function ChatRow({ c, index, selected, onPress }: { c: Conversation; index: number; selected: boolean; onPress: () => void }) {
  const name = nameOf(c);
  const unread = c.unreadCount || 0;
  const typing = !!c.isTyping;
  const online = c.conversationType === 'direct' && (c.isOnline || (c.otherUser ? DEMO_ONLINE.has(c.otherUser.id) : false));
  const pv = previewOf(c);
  const own = c.lastMessage?.isOwn;

  return (
    <Rise index={index}>
      <Pressy
        onPress={onPress}
        scaleTo={0.98}
        accessibilityLabel={`${name}${unread ? `, ${unread} unread` : ''}`}
        accessibilityState={{ selected }}
        hoverStyle={!selected ? { backgroundColor: Colors.creamTint } : undefined}
        style={[styles.row, selected && styles.rowSelected]}
      >
        <Avatar name={name} size={52} square={c.conversationType === 'group'} online={online} cutout={selected ? Colors.raised : Colors.panel} />
        <View style={styles.rowMain}>
          <View style={styles.rowTop}>
            <Text style={styles.rowName} numberOfLines={1}>
              {name}
            </Text>
            <Text style={[styles.rowTime, unread > 0 && { color: Colors.brass }]}>{timeOf(c.lastMessage?.createdAt)}</Text>
          </View>
          <View style={styles.rowBottom}>
            {typing ? (
              <Animated.Text entering={FadeIn} style={[styles.preview, { color: Colors.brass, fontFamily: Fonts.medium }]}>
                typing…
              </Animated.Text>
            ) : (
              <>
                {own && <Icon name="checks" size={16} color={Colors.sage} />}
                {pv.icon && <Icon name={pv.icon} size={15} color={unread ? Colors.cream : Colors.faint} />}
                <Text style={[styles.preview, unread > 0 && { color: Colors.cream }]} numberOfLines={1}>
                  {own ? `You: ${pv.text}` : pv.text}
                </Text>
              </>
            )}
            {unread > 0 && !selected && <Badge count={unread} />}
          </View>
        </View>
      </Pressy>
    </Rise>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────

export default function ChatsScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { user } = useAuthStore();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [category, setCategory] = useState<Category>('All');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [matched, setMatched] = useState<Message[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!user?.id) return;
    if (user.id === DEMO_USER_ID) {
      setConversations(DEMO_CONVERSATIONS);
      setIsLoading(false);
      setIsRefreshing(false);
      return;
    }
    try {
      const data = await conversationRepository.getConversations(user.id);
      setConversations(data && data.length > 0 ? data : DEMO_CONVERSATIONS);
    } catch {
      setConversations(DEMO_CONVERSATIONS);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [user?.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Desktop opens the first conversation so the right pane is never empty on arrival.
  useEffect(() => {
    if (isWide && !selectedId && conversations.length > 0) setSelectedId(conversations[0].id);
  }, [isWide, conversations]);

  useEffect(() => {
    if (!query.trim()) {
      setMatched([]);
      return;
    }
    databaseService.searchMessages(query).then(setMatched).catch(() => setMatched([]));
  }, [query]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations
      .map((c) => (readIds.has(c.id) ? { ...c, unreadCount: 0 } : c))
      .filter((c) => {
        if (q && !nameOf(c).toLowerCase().includes(q)) return false;
        if (category === 'Unread') return (c.unreadCount || 0) > 0;
        if (category === 'Groups') return c.conversationType === 'group';
        if (category === 'Direct') return c.conversationType === 'direct';
        return true;
      });
  }, [conversations, category, query, readIds]);

  const active = useMemo(
    () => conversations.filter((c) => c.conversationType === 'direct' && (c.isOnline || (c.otherUser && DEMO_ONLINE.has(c.otherUser.id)))),
    [conversations]
  );

  const unreadTotal = conversations.filter((c) => !readIds.has(c.id) && (c.unreadCount || 0) > 0).length;

  const open = (c: Conversation) => {
    setReadIds((s) => new Set(s).add(c.id));
    if (isWide) {
      setSelectedId(c.id);
      return;
    }
    router.push({
      pathname: '/chat/[id]',
      params: { id: c.id, name: nameOf(c), group: c.conversationType === 'group' ? '1' : '0' },
    } as any);
  };

  const selected = conversations.find((c) => c.id === selectedId);

  const header = (
    <View>
      <View style={[styles.header, { paddingTop: (isWide ? 24 : 16) + (isWide ? 0 : insets.top) }]}>
        <View style={styles.brand}>
          {!isWide && <VeroMark size={34} />}
          <Text style={Type.title}>Chats</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <IconButton icon="users" label="New group" variant="filled" onPress={() => router.push('/new-group' as any)} />
          {isWide && <IconButton icon="plus" label="New chat" variant="brass" onPress={() => router.push('/(tabs)/contacts' as any)} />}
        </View>
      </View>

      <View style={{ paddingHorizontal: 20, gap: 14 }}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search chats and messages" />

        {!query && active.length > 0 && !isWide && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingVertical: 4 }}>
            {active.map((c, i) => {
              const n = nameOf(c);
              return (
                <Animated.View key={c.id} entering={ZoomIn.delay(80 + i * 60).springify().damping(14)}>
                  <Pressy onPress={() => open(c)} style={styles.story} accessibilityLabel={`${n}, online`}>
                    <Avatar name={n} size={54} ring ringColor={Colors.sage} />
                    <Text style={styles.storyName} numberOfLines={1}>
                      {n.split(' ')[0]}
                    </Text>
                  </Pressy>
                </Animated.View>
              );
            })}
          </ScrollView>
        )}

        <View style={styles.chips}>
          {CATEGORIES.map((cat) => (
            <Chip
              key={cat}
              label={cat === 'Unread' && unreadTotal > 0 ? `Unread · ${unreadTotal}` : cat}
              active={category === cat}
              onPress={() => setCategory(cat)}
            />
          ))}
        </View>
      </View>
    </View>
  );

  const list = (
    <FlatList
      data={visible}
      keyExtractor={(c) => c.id}
      renderItem={({ item, index }) => <ChatRow c={item} index={index} selected={isWide && item.id === selectedId} onPress={() => open(item)} />}
      ListHeaderComponent={header}
      ListHeaderComponentStyle={{ marginBottom: 8 }}
      contentContainerStyle={{ paddingBottom: isWide ? 24 : 110 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={() => {
            setIsRefreshing(true);
            load();
          }}
          tintColor={Colors.brass}
        />
      }
      ListEmptyComponent={
        isLoading ? null : (
          <EmptyState
            icon={query ? 'search' : 'chat'}
            title={query ? 'Nothing matches' : 'No chats yet'}
            body={query ? 'Try a different name or word.' : 'Start a conversation — everything you send is end-to-end encrypted.'}
          />
        )
      }
      ListFooterComponent={
        matched.length > 0 ? (
          <View style={styles.matches}>
            <Text style={[Type.eyebrow, { paddingHorizontal: 12, marginBottom: 6 }]}>MESSAGES</Text>
            {matched.map((m) => (
              <Pressy
                key={m.id}
                onPress={() => (isWide ? setSelectedId(m.conversationId) : router.push(`/chat/${m.conversationId}` as any))}
                scaleTo={0.98}
                hoverStyle={{ backgroundColor: Colors.creamTint }}
                style={styles.match}
              >
                <View style={styles.matchIcon}>
                  <Icon name="chat" size={18} color={Colors.brass} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={Type.body} numberOfLines={1}>
                    {m.content}
                  </Text>
                  <Text style={Type.caption}>{dayjs(m.createdAt).format('D MMM, h:mm A')}</Text>
                </View>
              </Pressy>
            ))}
          </View>
        ) : null
      }
    />
  );

  if (isWide) {
    return (
      <View style={styles.split}>
        <View style={styles.listPane}>
          <Grain />
          {list}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {selected ? (
            <ChatThread
              key={selected.id}
              conversationId={selected.id}
              embedded
              title={nameOf(selected)}
              isGroup={selected.conversationType === 'group'}
            />
          ) : (
            <NoChatSelected />
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Grain />
      {list}
      <Animated.View entering={ZoomIn.delay(450).springify().damping(12)} style={styles.fab}>
        <Pressy onPress={() => router.push('/(tabs)/contacts' as any)} accessibilityLabel="New chat" scaleTo={0.9} style={styles.fabBtn}>
          <Icon name="chatPlus" size={25} color={Colors.brassInk} />
        </Pressy>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.ink },
  split: { flex: 1, flexDirection: 'row', backgroundColor: Colors.ink },
  listPane: { width: 380, backgroundColor: Colors.panel, borderRightWidth: 1, borderRightColor: Colors.line },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 14 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  story: { alignItems: 'center', gap: 6, width: 64 },
  storyName: { fontFamily: Fonts.medium, fontSize: 12, color: Colors.muted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 18 },
  rowSelected: { backgroundColor: Colors.raised, borderWidth: 1, borderColor: Colors.line },
  rowMain: { flex: 1, minWidth: 0, gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  rowName: { flex: 1, fontFamily: Fonts.semibold, fontSize: 16, color: Colors.cream },
  rowTime: { fontFamily: Fonts.body, fontSize: 12, color: Colors.faint },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 22 },
  preview: { flex: 1, fontFamily: Fonts.body, fontSize: 14, color: Colors.muted },
  matches: { marginTop: 12, paddingHorizontal: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: Colors.line },
  match: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14 },
  matchIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.brassTint, alignItems: 'center', justifyContent: 'center' },
  fab: { position: 'absolute', right: 20, bottom: 24 },
  fabBtn: {
    width: 60,
    height: 60,
    borderRadius: 20,
    backgroundColor: Colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
    elevation: 10,
  },
});
