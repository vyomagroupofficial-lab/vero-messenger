import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import dayjs from 'dayjs';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { ChatThread, NoChatSelected } from '../../src/features/chats/ChatThread';
import { Conversation, MessageStatus, conversationTitle } from '../../src/shared/models/Message';
import { isMuted, splitArchived } from '../../src/features/chats/chatList';
import { useMuteStore } from '../../src/features/notifications/useMuteStore';
import { useMessagesStore } from '../../src/features/messages/useMessagesStore';
import { useMessageSearch } from '../../src/features/search/useMessageSearch';
import { makeSnippet } from '../../src/features/search/searchQuery';
import { HighlightedText } from '../../src/features/search/components/HighlightedText';
import { friendlyError } from '../../src/core/network/supabase';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { conversationPreview, listTime } from '../../src/shared/i18n/format';
import { StoriesTray } from '../../src/features/stories/components/StoriesTray';
import { Avatar, Badge, Button, Chip, EmptyState, Grain, Icon, IconButton, Pill, Pressy, Rise, SearchField, Sheet, SheetRow, VeroMark, notify, useLayout } from '../../src/shared/ui';

type Category = 'all' | 'unread' | 'groups' | 'direct';

function Ticks({ status }: { status?: MessageStatus }) {
  const { c } = useTheme();
  if (status === 'sending') return <Icon name="clock" size={14} color={c.faint} />;
  if (status === 'failed') return <Icon name="info" size={14} color={c.danger} />;
  if (status === 'delivered') return <Icon name="checks" size={15} color={c.faint} />;
  if (status === 'read') return <Icon name="checks" size={15} color={c.success} />;
  return <Icon name="check" size={15} color={c.faint} />;
}

function ChatRow({ c: conv, index, selected, onPress, onLongPress }: { c: Conversation; index: number; selected: boolean; onPress: () => void; onLongPress: () => void }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const name = conversationTitle(conv);
  const unread = conv.unreadCount || 0;
  const pv = conversationPreview(t, conv);
  const own = conv.lastMessage?.isOwn;
  const group = conv.conversationType === 'group';
  const mutedUntil = useMuteStore((st) => st.mutes[conv.id] ?? null);
  const muted = isMuted({ mutedUntil: mutedUntil ?? conv.mutedUntil });

  return (
    <Rise index={index}>
      <Pressy
        onPress={onPress}
        onLongPress={onLongPress}
        scaleTo={0.98}
        accessibilityLabel={unread ? t('chats.unreadA11y', { name, count: unread }) : name}
        accessibilityHint={t('chats.longPressHint')}
        accessibilityState={{ selected }}
        hoverStyle={!selected ? { backgroundColor: c.tint } : undefined}
        style={[s.row, selected && s.rowSelected]}
      >
        <Avatar name={name} size={52} square={group} icon={group ? 'users' : undefined} />
        <View style={s.rowMain}>
          <View style={s.rowTop}>
            <Text style={[s.rowName, unread > 0 && s.rowNameUnread]} numberOfLines={1}>
              {name}
            </Text>
            {muted && <Icon name="bellOff" size={14} color={c.faint} />}
            {!!conv.pinnedAt && <Icon name="pin" size={14} color={c.accentText} />}
            <Text style={[s.rowTime, unread > 0 && { color: c.accentText }]}>{listTime(t, conv.lastMessage?.createdAt)}</Text>
          </View>
          <View style={s.rowBottom}>
            {own && <Ticks status={conv.lastMessage?.status} />}
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

  const chatAction = (fn: () => Promise<void>, failTitle: string) => () => {
    setActionChat(null);
    void fn().catch((e) => notify(failTitle, friendlyError(e)));
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
      {!query && category === 'all' && archived.length > 0 && (
        <Pressy onPress={() => router.push('/archived')} scaleTo={0.98} hoverStyle={{ backgroundColor: c.tint }} style={s.archivedRow} accessibilityLabel={t('chats.archived')}>
          <View style={s.archivedIcon}>
            <Icon name="archive" size={20} color={c.accentText} />
          </View>
          <Text style={[s.rowName, { flex: 1 }]}>{t('chats.archived')}</Text>
          {archivedUnread > 0 ? <Badge count={archivedUnread} /> : <Text style={s.rowTime}>{archived.length}</Text>}
        </Pressy>
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
        <ChatRow c={item} index={index} selected={isWide && item.id === selectedId} onPress={() => open(item.id)} onLongPress={() => setActionChat(item)} />
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

  const sheet = (
    <Sheet visible={!!actionChat} onClose={() => setActionChat(null)} title={actionChat ? conversationTitle(actionChat) : undefined}>
      {actionChat && !actionChat.archivedAt && (
        <SheetRow
          icon="pin"
          label={actionChat.pinnedAt ? t('chats.unpin') : t('chats.pin')}
          onPress={chatAction(() => useChatsStore.getState().setPinned(actionChat.id, !actionChat.pinnedAt), t('chats.pinFailed'))}
        />
      )}
      {actionChat && (
        <SheetRow
          icon="archive"
          label={actionChat.archivedAt ? t('chats.unarchive') : t('chats.archive')}
          onPress={chatAction(() => useChatsStore.getState().setArchived(actionChat.id, !actionChat.archivedAt), t('chats.archiveFailed'))}
        />
      )}
      {actionChat && actionChat.unreadCount > 0 && (
        <SheetRow
          icon="checks"
          label={t('chats.markRead')}
          onPress={chatAction(() => useMessagesStore.getState().markConversationRead(actionChat.id), t('chats.markReadFailed'))}
        />
      )}
    </Sheet>
  );

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
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 18 },
  rowSelected: { backgroundColor: c.raised, borderWidth: 1, borderColor: c.line },
  rowMain: { flex: 1, minWidth: 0, gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  rowName: { flex: 1, fontFamily: f.semibold, fontSize: 16, color: c.text },
  rowNameUnread: { fontFamily: f.bold },
  archivedRow: { flexDirection: 'row', alignItems: 'center', gap: 13, marginHorizontal: 8, marginTop: 10, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 18 },
  archivedIcon: { width: 52, height: 52, borderRadius: 18, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2, alignItems: 'center', justifyContent: 'center' },
  hit: { backgroundColor: c.accentTint2, color: c.text, fontFamily: f.semibold },
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
