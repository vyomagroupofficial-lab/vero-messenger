import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, SectionList, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { callService } from '../../src/features/calls/CallService';
import { DEMO_CONTACTS, DEMO_ONLINE, DEMO_USER_ID, demoConversationFor } from '../../src/features/demo/demoData';
import { User } from '../../src/shared/models/Message';
import { Colors, Fonts, Type } from '../../src/shared/theme/theme';
import {
  Avatar,
  EmptyState,
  Grain,
  Icon,
  IconButton,
  IconName,
  Pressy,
  Rise,
  SearchField,
  notify,
  useLayout,
} from '../../src/shared/ui';

function groupByLetter(users: User[]) {
  const map = new Map<string, User[]>();
  [...users]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .forEach((u) => {
      const l = (u.displayName[0] || '#').toUpperCase();
      map.set(l, [...(map.get(l) || []), u]);
    });
  return [...map.entries()].map(([title, data]) => ({ title, data }));
}

function QuickAction({ icon, title, sub, tone, onPress, index, wide }: {
  icon: IconName;
  title: string;
  sub: string;
  tone: 'brass' | 'pine' | 'raised';
  onPress: () => void;
  index: number;
  wide: boolean;
}) {
  const bg = tone === 'brass' ? Colors.brass : tone === 'pine' ? Colors.pine : Colors.raised;
  const fg = tone === 'brass' ? Colors.brassInk : tone === 'pine' ? Colors.cream : Colors.brass;
  return (
    <Rise index={index} style={wide ? { flex: 1, minWidth: 220 } : undefined}>
      <Pressy
        onPress={onPress}
        scaleTo={0.97}
        hoverStyle={{ backgroundColor: '#161917' }}
        style={[styles.quick, wide && styles.quickWide]}
        accessibilityLabel={title}
      >
        <View style={[styles.quickIcon, { backgroundColor: bg }, tone === 'raised' && { borderWidth: 1, borderColor: Colors.line2 }]}>
          <Icon name={icon} size={22} color={fg} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[Type.name, { fontSize: 15.5 }]}>{title}</Text>
          <Text style={Type.caption}>{sub}</Text>
        </View>
        {!wide && <Icon name="forwardChevron" size={18} color={Colors.faint} />}
      </Pressy>
    </Rise>
  );
}

export default function ContactsScreen() {
  const insets = useSafeAreaInsets();
  const { isWide, width } = useLayout();
  const { user } = useAuthStore();
  const isDemo = user?.id === DEMO_USER_ID;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (!q || !user?.id) {
      setResults([]);
      return;
    }
    if (isDemo) {
      const lq = q.toLowerCase();
      setResults(DEMO_CONTACTS.filter((c) => c.displayName.toLowerCase().includes(lq) || c.username.toLowerCase().includes(lq)));
      return;
    }
    let live = true;
    conversationRepository
      .searchUsers(q, user.id)
      .then((r) => live && setResults(r))
      .catch(() => live && setResults([]));
    return () => {
      live = false;
    };
  }, [query, user?.id]);

  const people = query ? results : DEMO_CONTACTS;
  const sections = useMemo(() => groupByLetter(people), [people]);

  const startChat = async (other: User) => {
    if (!user?.id) return;
    if (isDemo) {
      const cid = demoConversationFor(other.id) || `demo-chat-${other.username}`;
      router.push({ pathname: '/chat/[id]', params: { id: cid, name: other.displayName, group: '0' } } as any);
      return;
    }
    const res = await conversationRepository.createDirectConversation(user.id, other.id);
    if (res) router.push({ pathname: '/chat/[id]', params: { id: res.conversationId, name: other.displayName, group: '0' } } as any);
    else notify('Couldn’t start chat', 'Check your connection and try again.');
  };

  const call = async (other: User) => {
    if (!user?.id) return;
    const callId = await callService.startCall({
      peerId: other.id,
      peerName: other.displayName,
      callType: 'voice',
      currentUserId: user.id,
      currentUserName: user.displayName || 'You',
    });
    router.push(`/call/${callId}` as any);
  };

  const openProfile = (u: User) => router.push(`/profile/${u.id}?name=${encodeURIComponent(u.displayName)}` as any);

  const quick = (
    <View style={[styles.quickRow, isWide && { flexDirection: 'row', flexWrap: 'wrap' }]}>
      <QuickAction index={0} wide={isWide} icon="userPlus" title="New group" sub="Up to 1,000 people" tone="brass" onPress={() => router.push('/new-group' as any)} />
      <QuickAction
        index={1}
        wide={isWide}
        icon="qr"
        title="New contact"
        sub="By username or QR code"
        tone="pine"
        onPress={() => notify('Add a contact', 'Search for their username above, or scan their Vero QR code from Settings.')}
      />
      <QuickAction
        index={2}
        wide={isWide}
        icon="link"
        title="Invite to Vero"
        sub="Share a private link"
        tone="raised"
        onPress={() => notify('Invite link copied', 'Send it to anyone you’d like to talk to privately.')}
      />
    </View>
  );

  const header = (
    <View style={{ gap: 18, paddingBottom: 6 }}>
      <View style={[styles.header, { paddingTop: (isWide ? 32 : 16) + (isWide ? 0 : insets.top) }, isWide && { alignItems: 'flex-end' }]}>
        <View style={{ gap: 2 }}>
          <Text style={isWide ? [Type.title, { fontSize: 40 }] : Type.title}>Contacts</Text>
          <Text style={Type.caption}>
            {DEMO_CONTACTS.length} people on Vero · {DEMO_CONTACTS.filter((c) => DEMO_ONLINE.has(c.id)).length} online now
          </Text>
        </View>
        {isWide && (
          <SearchField value={query} onChangeText={setQuery} placeholder="Search by name or username" style={{ width: 380 }} />
        )}
      </View>
      {!isWide && (
        <View style={{ paddingHorizontal: 20 }}>
          <SearchField value={query} onChangeText={setQuery} placeholder="Search by name or username" />
        </View>
      )}
      {!query && <View style={{ paddingHorizontal: isWide ? 0 : 20 }}>{quick}</View>}
      {query ? (
        <Text style={[Type.eyebrow, { paddingHorizontal: isWide ? 4 : 20 }]}>
          {results.length} {results.length === 1 ? 'RESULT' : 'RESULTS'}
        </Text>
      ) : null}
    </View>
  );

  if (isWide) {
    const cols = Math.max(1, Math.floor((Math.min(width, 1400) - 80 - 80) / 330));
    return (
      <View style={styles.container}>
        <Grain />
        <ScrollView contentContainerStyle={styles.wideScroll} showsVerticalScrollIndicator={false}>
          <View style={styles.wideInner}>
            {header}
            {people.length === 0 ? (
              <EmptyState icon="search" title="No one found" body="Try their full username." />
            ) : (
              <View style={[styles.grid, { marginTop: 12 }]}>
                {[...people]
                  .sort((a, b) => a.displayName.localeCompare(b.displayName))
                  .map((c, i) => (
                    <Rise key={c.id} index={i} style={{ width: `${100 / cols}%`, padding: 6 }}>
                      <View style={styles.card}>
                        <Pressy onPress={() => openProfile(c)} scaleTo={0.98} style={styles.cardWho} accessibilityLabel={`${c.displayName} profile`}>
                          <Avatar name={c.displayName} size={52} online={DEMO_ONLINE.has(c.id)} cutout={Colors.panel} />
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={Type.name} numberOfLines={1}>
                              {c.displayName}
                            </Text>
                            <Text style={Type.caption} numberOfLines={1}>
                              {c.about || `@${c.username}`}
                            </Text>
                          </View>
                        </Pressy>
                        <IconButton icon="chat" label={`Message ${c.displayName}`} size={40} color={Colors.muted} onPress={() => startChat(c)} />
                        <IconButton icon="phone" label={`Call ${c.displayName}`} size={40} color={Colors.muted} onPress={() => call(c)} />
                      </View>
                    </Rise>
                  ))}
              </View>
            )}
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Grain />
      <SectionList
        sections={sections}
        keyExtractor={(u) => u.id}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        renderSectionHeader={({ section }) => <Text style={[styles.letter, { paddingHorizontal: 20 }]}>{section.title}</Text>}
        renderItem={({ item, index }) => (
          <Rise index={index}>
            <View style={styles.row}>
              <Pressy onPress={() => startChat(item)} onLongPress={() => openProfile(item)} scaleTo={0.98} style={styles.cardWho} accessibilityLabel={`Message ${item.displayName}`}>
                <Avatar name={item.displayName} size={50} online={DEMO_ONLINE.has(item.id)} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={Type.name} numberOfLines={1}>
                    {item.displayName}
                  </Text>
                  <Text style={Type.caption} numberOfLines={1}>
                    {item.about || `@${item.username}`}
                  </Text>
                </View>
              </Pressy>
              <IconButton icon="phone" label={`Call ${item.displayName}`} size={42} color={Colors.brass} onPress={() => call(item)} />
            </View>
          </Rise>
        )}
        ListEmptyComponent={<EmptyState icon="search" title="No one found" body="Try their full username." />}
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.ink },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 20, paddingHorizontal: 20 },
  quickRow: { gap: 10 },
  quick: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 12,
    borderRadius: 18,
    backgroundColor: Colors.panel,
    borderWidth: 1,
    borderColor: Colors.line,
  },
  quickWide: { padding: 16, borderRadius: 20 },
  quickIcon: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  letter: { fontFamily: Fonts.display, fontSize: 20, color: Colors.brass, paddingTop: 18, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 8 },
  wideScroll: { paddingHorizontal: 40, paddingBottom: 48 },
  wideInner: { width: '100%', maxWidth: 1240, alignSelf: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -6 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 12,
    borderRadius: 20,
    backgroundColor: Colors.panel,
    borderWidth: 1,
    borderColor: Colors.line,
  },
  cardWho: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 },
});
