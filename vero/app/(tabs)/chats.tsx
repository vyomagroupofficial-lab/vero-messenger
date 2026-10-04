import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import dayjs from 'dayjs';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { ChatThread, NoChatSelected } from '../../src/features/chats/ChatThread';
import { Conversation, conversationTitle } from '../../src/shared/models/Message';
import { splitArchived } from '../../src/features/chats/chatList';
import { ArchivedEntry, ChatActionSheet, ChatListRow } from '../../src/features/chats/components/ChatRowParts';
import { useMessageSearch } from '../../src/features/search/useMessageSearch';
import { makeSnippet } from '../../src/features/search/searchQuery';
import { HighlightedText } from '../../src/features/search/components/HighlightedText';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { listTime } from '../../src/shared/i18n/format';
import { StoriesTray } from '../../src/features/stories/components/StoriesTray';
import { Button, Chip, EmptyState, Grain, Icon, IconButton, Pill, Pressy, SearchField, VeroMark, useLayout } from '../../src/shared/ui';

type Category = 'all' | 'unread' | 'groups' | 'direct';

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [jump, setJump] = useState<{ messageId: string; q: string } | null>(null);
  const [actionChat, setActionChat] = useState<Conversation | null>(null);
  // Local (on-device) full-text search over decrypted messages.
  const { results: matched } = useMessageSearch(query, undefined, 50);
  const { active, archived } = useMemo(() => splitArchived(conversations), [conversations]);

  useFocusEffect(
    useCallback(() => {
      if (userId) void load({ sync: true });
    }, [userId, load])
  );

  // Desktop opens the first conversation so the right pane is never empty on arrival.
  useEffect(() => {
    if (isWide && !selectedId && active.length > 0) setSelectedId(active[0].id);
  }, [isWide, active.length]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Search covers archived chats too; the normal list hides them behind the "Archived" row.
    let list = q ? conversations.filter((cv) => conversationTitle(cv).toLowerCase().includes(q)) : active;
    if (category === 'direct') list = list.filter((cv) => cv.conversationType === 'direct');
    else if (category === 'groups') list = list.filter((cv) => cv.conversationType === 'group');
    else if (category === 'unread') list = list.filter((cv) => cv.unreadCount > 0);
    return list;
  }, [conversations, active, query, category]);

  const unreadTotal = active.filter((cv) => cv.unreadCount > 0).length;
  const archivedUnread = archived.reduce((n, cv) => n + cv.unreadCount, 0);

  const open = (id: string) => {
    setJump(null);
    if (isWide) setSelectedId(id);
    else router.push(`/chat/${id}`);
  };

  const openMatch = (conversationId: string, messageId: string) => {
    const q = query.trim();
    if (isWide) {
      setJump({ messageId, q });
      setSelectedId(conversationId);
    } else {
      router.push({ pathname: '/chat/[id]', params: { id: conversationId, messageId, q } });
    }
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
          <IconButton icon="star" label={t('thread.starred')} variant="filled" onPress={() => router.push('/starred')} />
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
      {!query && category === 'all' && (
        <ArchivedEntry count={archived.length} unread={archivedUnread} onPress={() => router.push('/archived')} />
      )}

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
      renderItem={({ item, index }) => (
        <ChatListRow conversation={item} index={index} selected={isWide && item.id === selectedId} onPress={() => open(item.id)} onLongPress={() => setActionChat(item)} />
      )}
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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, marginBottom: 6 }}>
              <Icon name="lock" size={12} color={c.accentText} />
              <Text style={type.eyebrow}>{t('chats.messagesOnDevice').toUpperCase()}</Text>
            </View>
            {matched.map((m) => {
              const chat = conversations.find((cv) => cv.id === m.conversationId);
              const who = m.isOwn ? t('common.you') : m.senderName;
              return (
                <Pressy key={m.id} onPress={() => openMatch(m.conversationId, m.id)} scaleTo={0.98} hoverStyle={{ backgroundColor: c.tint }} style={s.match}>
                  <View style={s.matchIcon}>
                    <Icon name="search" size={18} color={c.accentText} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Text style={[s.rowName, { flex: 1, fontSize: 14.5 }]} numberOfLines={1}>
                        {chat ? conversationTitle(chat) : t('chats.title')}
                      </Text>
                      <Text style={s.rowTime}>{listTime(t, m.createdAt)}</Text>
                    </View>
                    <HighlightedText
                      style={type.caption}
                      highlightStyle={s.hit}
                      numberOfLines={2}
                      text={`${chat?.conversationType === 'group' && who ? `${who}: ` : ''}${makeSnippet(m.content ?? '', query)}`}
                      query={query}
                    />
                  </View>
                </Pressy>
              );
            })}
          </View>
        ) : null
      }
    />
  );

  const sheet = <ChatActionSheet conversation={actionChat} onClose={() => setActionChat(null)} />;

  if (isWide) {
    return (
      <View style={s.split}>
        <View style={s.listPane}>
          <Grain />
          {list}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>{selectedId ? <ChatThread key={`${selectedId}:${jump?.messageId ?? ''}`} conversationId={selectedId} embedded jumpMessageId={jump?.messageId} jumpQuery={jump?.q} /> : <NoChatSelected />}</View>
        {sheet}
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
      {sheet}
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
  rowName: { flex: 1, fontFamily: f.semibold, fontSize: 16, color: c.text },
  hit: { backgroundColor: c.accentTint2, color: c.text, fontFamily: f.semibold },
  rowTime: { fontFamily: f.body, fontSize: 12, color: c.faint },
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
