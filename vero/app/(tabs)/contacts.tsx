import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, SectionList, Share, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { callService } from '../../src/features/calls/CallService';
import { DEMO_CONTACTS } from '../../src/features/demo/demoData';
import { friendlyError } from '../../src/core/network/supabase';
import { User } from '../../src/shared/models/Message';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Avatar, EmptyState, Grain, Icon, IconButton, IconName, Pressy, Rise, SearchField, notify, useLayout } from '../../src/shared/ui';

function QuickAction({ icon, title, body, onPress, index }: { icon: IconName; title: string; body: string; onPress: () => void; index: number }) {
  const { c } = useTheme();
  const { isWide } = useLayout();
  const s = useStyles();
  return (
    <Rise index={index} style={{ flex: 1 }}>
      <Pressy onPress={onPress} style={[s.quick, !isWide && s.quickStack]} hoverStyle={{ borderColor: c.accentLine }} scaleTo={0.97} accessibilityLabel={title}>
        <View style={s.quickIcon}>
          <Icon name={icon} size={21} color={c.accentText} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={s.quickTitle} numberOfLines={isWide ? 1 : 2}>
            {title}
          </Text>
          <Text style={s.quickBody} numberOfLines={2}>
            {body}
          </Text>
        </View>
      </Pressy>
    </Rise>
  );
}

function PersonRow({ user, index, busy, onMessage, onCall }: { user: User; index: number; busy: boolean; onMessage: () => void; onCall: () => void }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  return (
    <Rise index={index}>
      <View style={s.row}>
        <Pressy onPress={onMessage} scaleTo={0.98} style={s.rowMain} hoverStyle={{ backgroundColor: c.tint }} accessibilityLabel={t('contacts.messagePerson', { name: user.displayName })}>
          <Avatar name={user.displayName} size={46} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={s.name} numberOfLines={1}>
              {user.displayName}
            </Text>
            <Text style={s.handle} numberOfLines={1}>
              @{user.username}
              {user.about ? <Text style={s.about}>{`  ·  ${user.about}`}</Text> : null}
            </Text>
          </View>
        </Pressy>
        {busy ? (
          <View style={s.busy}>
            <ActivityIndicator size="small" color={c.accent} />
          </View>
        ) : (
          <IconButton icon="phone" label={t('contacts.callPerson', { name: user.displayName })} color={c.accentText} onPress={onCall} />
        )}
      </View>
    </Rise>
  );
}

function PersonCard({ user, index, busy, onMessage, onCall }: { user: User; index: number; busy: boolean; onMessage: () => void; onCall: () => void }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  return (
    <Rise index={index} style={s.cardWrap}>
      <View style={s.card}>
        <Pressy onPress={() => router.push(`/profile/${user.id}`)} scaleTo={0.97} style={{ alignItems: 'center', gap: 10 }} accessibilityLabel={user.displayName}>
          <Avatar name={user.displayName} size={72} />
          <View style={{ alignItems: 'center', gap: 2, maxWidth: '100%' }}>
            <Text style={[s.name, { textAlign: 'center' }]} numberOfLines={1}>
              {user.displayName}
            </Text>
            <Text style={s.handle} numberOfLines={1}>
              @{user.username}
            </Text>
          </View>
        </Pressy>
        <View style={s.cardActions}>
          <Pressy onPress={onMessage} style={s.cardBtn} hoverStyle={{ backgroundColor: c.accentTint2 }} accessibilityLabel={t('contacts.messagePerson', { name: user.displayName })}>
            {busy ? <ActivityIndicator size="small" color={c.accent} /> : <Icon name="chat" size={18} color={c.accentText} />}
            <Text style={s.cardBtnLabel}>{t('contacts.message')}</Text>
          </Pressy>
          <IconButton icon="phone" label={t('contacts.callPerson', { name: user.displayName })} variant="outline" color={c.accentText} onPress={onCall} />
        </View>
      </View>
    </Rise>
  );
}

export default function ContactsScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { c, type, f } = useTheme();
  const s = useStyles();
  const t = useT();
  const user = useAuthStore((st) => st.user);
  const isDemo = useAuthStore((st) => st.isDemo);
  const conversations = useChatsStore((st) => st.conversations);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  // People you already talk to (from your direct chats).
  const knownContacts = useMemo<User[]>(() => {
    if (isDemo) return DEMO_CONTACTS;
    const seen = new Map<string, User>();
    for (const cv of conversations) if (cv.otherUser) seen.set(cv.otherUser.id, cv.otherUser);
    return [...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [conversations, isDemo]);

  // Debounced directory search.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    if (isDemo) {
      setSearchResults(DEMO_CONTACTS.filter((u) => `${u.displayName} ${u.username}`.toLowerCase().includes(q.toLowerCase())));
      return;
    }
    setIsSearching(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const results = await conversationRepository.searchUsers(q);
        if (!cancelled) setSearchResults(results);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, isDemo]);

  const existingConversation = (peerId: string) => conversations.find((cv) => cv.otherUser?.id === peerId)?.id;

  // Resolves (or creates) the direct conversation with someone. Demo mode can only open existing chats.
  const openConversation = async (other: User): Promise<string | null> => {
    const existing = existingConversation(other.id);
    if (existing) return existing;
    if (isDemo) {
      notify(t('contacts.demoTitle'), t('contacts.demoBody'));
      return null;
    }
    setOpeningId(other.id);
    try {
      return await conversationRepository.createDirectConversation(other.id);
    } catch (e) {
      notify(t('contacts.startFailed'), friendlyError(e));
      return null;
    } finally {
      setOpeningId(null);
    }
  };

  const handleStartChat = async (other: User) => {
    const id = await openConversation(other);
    if (id) router.push(`/chat/${id}`);
  };

  const handleCall = async (other: User) => {
    if (!user?.id) return;
    const conversationId = await openConversation(other);
    if (!conversationId) return;
    try {
      const callId = await callService.startCall({ conversationId, peerId: other.id, peerName: other.displayName, callType: 'voice' });
      router.push(`/call/${callId}`);
    } catch (e) {
      notify(t('calls.failed'), friendlyError(e));
    }
  };

  const invite = async () => {
    const message = t('contacts.inviteMessage');
    try {
      if (Platform.OS === 'web' && !(typeof navigator !== 'undefined' && 'share' in navigator)) throw new Error('no share');
      await Share.share({ message });
    } catch {
      await Clipboard.setStringAsync(message).catch(() => undefined);
      notify(t('contacts.inviteCopied'), t('contacts.inviteCopiedBody'));
    }
  };

  const searching = searchQuery.trim().length >= 2;
  const displayed = searching ? searchResults : knownContacts;
  const upper = (text: string) => (f.script === 'latin' ? text.toUpperCase() : text);

  const caption = searching
    ? isSearching
      ? t('contacts.searching')
      : t('contacts.results', { count: searchResults.length })
    : searchQuery.trim().length === 1
    ? t('contacts.minChars')
    : knownContacts.length
    ? t('contacts.count', { count: knownContacts.length })
    : '';

  const empty = searching ? (
    isSearching ? null : <EmptyState icon="search" title={t('contacts.noResults')} body={t('contacts.noResultsBody')} />
  ) : (
    <EmptyState icon="users" title={t('contacts.emptyTitle')} body={t('contacts.emptyBody')} />
  );

  const sections = useMemo(() => {
    if (searching) return displayed.length ? [{ key: 'results', title: '', data: displayed }] : [];
    const groups = new Map<string, User[]>();
    for (const u of displayed) {
      const first = (u.displayName.trim()[0] || '#').toLocaleUpperCase();
      const letter = /\p{L}/u.test(first) ? first : '#';
      groups.set(letter, [...(groups.get(letter) ?? []), u]);
    }
    return [...groups.entries()].map(([letter, data]) => ({ key: letter, title: letter, data }));
  }, [displayed, searching]);

  const header = (
    <View style={{ gap: 16, paddingBottom: 6 }}>
      <View style={[s.header, { paddingTop: isWide ? 24 : 16 + insets.top }]}>
        <View style={{ gap: 2 }}>
          <Text style={type.title} accessibilityRole="header">
            {t('contacts.title')}
          </Text>
          {!!caption && (
            <Animated.Text key={caption} entering={FadeIn} style={type.caption} accessibilityLiveRegion="polite">
              {caption}
            </Animated.Text>
          )}
        </View>
        <IconButton icon="users" label={t('contacts.newGroup')} variant="brass" onPress={() => router.push('/new-group')} />
      </View>
      <View style={[s.pad, isWide && s.wideTop]}>
        <SearchField value={searchQuery} onChangeText={setSearchQuery} placeholder={t('contacts.search')} onClear={() => setSearchQuery('')} style={{ flex: 1, maxWidth: isWide ? 520 : undefined }} />
        {isSearching && <ActivityIndicator size="small" color={c.accent} />}
      </View>
      {!searching && (
        <View style={[s.pad, { flexDirection: 'row', gap: 10 }, isWide && { maxWidth: 760 }]}>
          <QuickAction index={0} icon="users" title={t('contacts.newGroup')} body={t('contacts.newGroupBody')} onPress={() => router.push('/new-group')} />
          <QuickAction index={1} icon="userPlus" title={t('contacts.invite')} body={t('contacts.inviteBody')} onPress={invite} />
        </View>
      )}
    </View>
  );

  if (isWide) {
    return (
      <View style={s.container}>
        <Grain />
        <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
          <View style={s.wideInner}>
            {header}
            {displayed.length === 0 ? (
              <View style={{ paddingTop: 40 }}>{empty}</View>
            ) : (
              <View style={{ gap: 12, paddingHorizontal: 20, paddingTop: 14 }}>
                <Text style={type.eyebrow}>{upper(searching ? t('contacts.results', { count: displayed.length }) : t('contacts.known'))}</Text>
                <View style={s.grid}>
                  {displayed.map((u, i) => (
                    <PersonCard key={u.id} user={u} index={Math.min(i, 12)} busy={openingId === u.id} onMessage={() => handleStartChat(u)} onCall={() => handleCall(u)} />
                  ))}
                </View>
              </View>
            )}
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <Grain />
      <SectionList
        sections={sections}
        keyExtractor={(u) => u.id}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        renderSectionHeader={({ section }) => (section.title ? <Text style={s.letter}>{section.title}</Text> : <View style={{ height: 8 }} />)}
        renderItem={({ item, index }) => (
          <PersonRow user={item} index={Math.min(index, 10)} busy={openingId === item.id} onMessage={() => handleStartChat(item)} onCall={() => handleCall(item)} />
        )}
        ListEmptyComponent={empty}
        contentContainerStyle={{ paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20 },
  pad: { paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', gap: 12 },
  wideTop: { justifyContent: 'flex-start' },
  wideInner: { width: '100%', maxWidth: 1180, alignSelf: 'center', paddingHorizontal: 12 },
  quick: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 18, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, minHeight: 72 },
  quickStack: { flexDirection: 'column', alignItems: 'flex-start', gap: 10, padding: 14 },
  quickIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2, alignItems: 'center', justifyContent: 'center' },
  quickTitle: { fontFamily: f.semibold, fontSize: 14.5, color: c.text },
  quickBody: { fontFamily: f.body, fontSize: 12, lineHeight: f.script === 'latin' ? 16 : 19, color: c.muted },
  letter: { fontFamily: f.display, fontSize: 15, color: c.accentText, paddingHorizontal: 22, paddingTop: 18, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 8, paddingRight: 8 },
  rowMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 18 },
  name: { fontFamily: f.semibold, fontSize: 16, color: c.text },
  handle: { fontFamily: f.script === 'latin' ? f.mono : f.body, fontSize: 12.5, color: c.muted },
  about: { fontFamily: f.body, color: c.faint },
  busy: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  cardWrap: { flexGrow: 1, flexBasis: 210, maxWidth: 280 },
  card: { alignItems: 'center', gap: 16, paddingTop: 22, paddingBottom: 14, paddingHorizontal: 14, borderRadius: 24, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch' },
  cardBtn: { flex: 1, height: 44, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2 },
  cardBtnLabel: { fontFamily: f.semibold, fontSize: 14, color: c.accentText },
}));
