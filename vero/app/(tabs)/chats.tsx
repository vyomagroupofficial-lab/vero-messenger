import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import dayjs from 'dayjs';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { ChatThread, NoChatSelected } from '../../src/features/chats/ChatThread';
import { databaseService } from '../../src/core/storage/DatabaseService';
import { Conversation, Message, conversationTitle } from '../../src/shared/models/Message';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { conversationPreview, listTime, typeLabel } from '../../src/shared/i18n/format';
import { StoriesTray } from '../../src/features/stories/components/StoriesTray';
import { Avatar, Badge, Button, Chip, EmptyState, Grain, Icon, IconButton, Pill, Pressy, Rise, SearchField, VeroMark, useLayout } from '../../src/shared/ui';

type Category = 'all' | 'unread' | 'groups' | 'direct';

function ChatRow({ c: conv, index, selected, onPress }: { c: Conversation; index: number; selected: boolean; onPress: () => void }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const name = conversationTitle(conv);
  const unread = conv.unreadCount || 0;
  const pv = conversationPreview(t, conv);
  const own = conv.lastMessage?.isOwn;
  const group = conv.conversationType === 'group';

  return (
    <Rise index={index}>
      <Pressy
        onPress={onPress}
        scaleTo={0.98}
        accessibilityLabel={unread ? t('chats.unreadA11y', { name, count: unread }) : name}
        accessibilityState={{ selected }}
        hoverStyle={!selected ? { backgroundColor: c.tint } : undefined}
        style={[s.row, selected && s.rowSelected]}
      >
        <Avatar name={name} size={52} square={group} icon={group ? 'users' : undefined} />
        <View style={s.rowMain}>
          <View style={s.rowTop}>
            <Text style={s.rowName} numberOfLines={1}>
              {name}
            </Text>
            <Text style={[s.rowTime, unread > 0 && { color: c.accentText }]}>{listTime(t, conv.lastMessage?.createdAt)}</Text>
          </View>
          <View style={s.rowBottom}>
            {own && <Icon name="check" size={15} color={c.faint} />}
            {pv.icon && <Icon name={pv.icon} size={15} color={unread ? c.text : c.faint} />}
            <Text style={[s.preview, unread > 0 && { color: c.text }]} numberOfLines={1}>
              {pv.text}
            </Text>
            {unread > 0 && !selected && <Badge count={unread} />}
          </View>
        </View>
      </Pressy>
    </Rise>
  );
}

export default function ChatsScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const userId = useAuthStore((st) => st.user?.id);
  const isDemo = useAuthStore((st) => st.isDemo);
  const conversations = useChatsStore((st) => st.conversations);
  const isLoading = useChatsStore((st) => st.isLoading);
  const isOffline = useChatsStore((st) => st.isOffline);
  const load = useChatsStore((st) => st.load);

  const [category, setCategory] = useState<Category>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [matched, setMatched] = useState<Message[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (userId) void load({ sync: true });
    }, [userId, load])
  );

  // Local (on-device) full-text search over decrypted messages, debounced.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setMatched([]);
      return;
    }
    const tm = setTimeout(() => void databaseService.searchMessages(q).then(setMatched).catch(() => setMatched([])), 250);
    return () => clearTimeout(tm);
  }, [query]);

  // Desktop opens the first conversation so the right pane is never empty on arrival.
  useEffect(() => {
    if (isWide && !selectedId && conversations.length > 0) setSelectedId(conversations[0].id);
  }, [isWide, conversations.length]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = q ? conversations.filter((cv) => conversationTitle(cv).toLowerCase().includes(q)) : conversations;
    if (category === 'direct') list = list.filter((cv) => cv.conversationType === 'direct');
    else if (category === 'groups') list = list.filter((cv) => cv.conversationType === 'group');
    else if (category === 'unread') list = list.filter((cv) => cv.unreadCount > 0);
    return list;
  }, [conversations, query, category]);

  const unreadTotal = conversations.filter((cv) => cv.unreadCount > 0).length;

  const open = (id: string) => {
    if (isWide) setSelectedId(id);
    else router.push(`/chat/${id}`);
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load({ sync: true });
    } finally {
      setRefreshing(false);
    }
  };

  const categories: { key: Category; label: string }[] = [
    { key: 'all', label: t('chats.all') },
    { key: 'unread', label: unreadTotal ? t('chats.unreadCount', { count: unreadTotal }) : t('chats.unread') },
    { key: 'groups', label: t('chats.groups') },
    { key: 'direct', label: t('chats.direct') },
  ];

  const header = (
    <View>
      <View style={[s.header, { paddingTop: isWide ? 24 : 16 + insets.top }]}>
        <View style={s.brand}>
          {!isWide && <VeroMark size={34} />}
          <Text style={type.title} accessibilityRole="header">
            {t('chats.title')}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <IconButton icon="megaphone" label={t('chats.channels')} variant="filled" onPress={() => router.push('/channels')} />
          <IconButton icon="users" label={t('chats.newGroup')} variant="filled" onPress={() => router.push('/new-group')} />
          {isWide && <IconButton icon="plus" label={t('chats.newChat')} variant="brass" onPress={() => router.push('/(tabs)/contacts')} />}
        </View>
      </View>

      <View style={{ paddingHorizontal: 20, gap: 14 }}>
        {(isDemo || isOffline) && (
          <Animated.View entering={FadeIn}>
            <Pill icon={isDemo ? 'info' : 'cloud'} label={isDemo ? t('chats.demo') : t('chats.offline')} tone="brass" />
          </Animated.View>
        )}
        {!query && <StoriesTray />}
        <SearchField value={query} onChangeText={setQuery} placeholder={t('chats.search')} />
        <View style={s.chips}>
          {categories.map((cat) => (
            <Chip key={cat.key} label={cat.label} active={category === cat.key} onPress={() => setCategory(cat.key)} />
          ))}
        </View>
      </View>
    </View>
  );

  const list = isLoading ? (
    <View style={{ flex: 1 }}>
      {header}
      <View style={s.loading}>
        <ActivityIndicator color={c.accent} />
        <Text style={type.caption}>{t('chats.loading')}</Text>
      </View>
    </View>
  ) : (
    <FlatList
      data={visible}
      keyExtractor={(cv) => cv.id}
      renderItem={({ item, index }) => <ChatRow c={item} index={index} selected={isWide && item.id === selectedId} onPress={() => open(item.id)} />}
      ListHeaderComponent={header}
      ListHeaderComponentStyle={{ marginBottom: 8 }}
      contentContainerStyle={{ paddingBottom: isWide ? 24 : 110 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.accent} />}
      ListEmptyComponent={
        matched.length ? null : (
          <EmptyState
            icon={query ? 'search' : 'chat'}
            title={query ? t('chats.nothing') : t('chats.empty')}
            body={query ? t('chats.nothingBody') : t('chats.emptyBody')}
            action={!query ? <Button label={t('chats.start')} icon="chatPlus" size="md" onPress={() => router.push('/(tabs)/contacts')} /> : undefined}
          />
        )
      }
      ListFooterComponent={
        matched.length > 0 ? (
          <View style={s.matches}>
            <Text style={[type.eyebrow, { paddingHorizontal: 12, marginBottom: 6 }]}>{t('chats.messages').toUpperCase()}</Text>
            {matched.map((m) => {
              const label = typeLabel(t, m.messageType, m.content);
              return (
                <Pressy key={m.id} onPress={() => open(m.conversationId)} scaleTo={0.98} hoverStyle={{ backgroundColor: c.tint }} style={s.match}>
                  <View style={s.matchIcon}>
                    <Icon name={label.icon ?? 'chat'} size={18} color={c.accentText} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={type.body} numberOfLines={1}>
                      {label.text}
                    </Text>
                    <Text style={type.caption}>{dayjs(m.createdAt).format('D MMM, h:mm A')}</Text>
                  </View>
                </Pressy>
              );
            })}
          </View>
        ) : null
      }
    />
  );

  if (isWide) {
    return (
      <View style={s.split}>
        <View style={s.listPane}>
          <Grain />
          {list}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>{selectedId ? <ChatThread key={selectedId} conversationId={selectedId} embedded /> : <NoChatSelected />}</View>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <Grain />
      {list}
      <Animated.View entering={ZoomIn.delay(450).springify().damping(12)} style={s.fab}>
        <Pressy onPress={() => router.push('/(tabs)/contacts')} accessibilityLabel={t('chats.newChat')} scaleTo={0.9} style={s.fabBtn}>
          <Icon name="chatPlus" size={25} color={c.onAccent} />
        </Pressy>
      </Animated.View>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  container: { flex: 1, backgroundColor: c.bg },
  split: { flex: 1, flexDirection: 'row', backgroundColor: c.bg },
  listPane: { width: 380, backgroundColor: c.panel, borderRightWidth: 1, borderRightColor: c.line },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 14 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  loading: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingTop: 80 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 18 },
  rowSelected: { backgroundColor: c.raised, borderWidth: 1, borderColor: c.line },
  rowMain: { flex: 1, minWidth: 0, gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  rowName: { flex: 1, fontFamily: f.semibold, fontSize: 16, color: c.text },
  rowTime: { fontFamily: f.body, fontSize: 12, color: c.faint },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 22 },
  preview: { flex: 1, fontFamily: f.body, fontSize: 14, color: c.muted },
  matches: { marginTop: 12, paddingHorizontal: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.line },
  match: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14 },
  matchIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center' },
  fab: { position: 'absolute', right: 20, bottom: 24 },
  fabBtn: {
    width: 60,
    height: 60,
    borderRadius: 20,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: c.name === 'dark' ? 0.45 : 0.2,
    shadowRadius: 24,
    elevation: 10,
  },
}));
