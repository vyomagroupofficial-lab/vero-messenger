import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, LinearTransition, ZoomIn, ZoomOut } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../src/features/auth/useAuthStore';
import { conversationRepository } from '../src/features/chats/ConversationRepository';
import { useChatsStore } from '../src/features/chats/useChatsStore';
import { friendlyError } from '../src/core/network/supabase';
import { User } from '../src/shared/models/Message';
import { makeStyles, useTheme } from '../src/shared/theme/ThemeProvider';
import { useT } from '../src/shared/i18n';
import { Avatar, Button, EmptyState, Eyebrow, Grain, Hatch, Icon, IconButton, Pressy, Rise, SearchField, notify, useLayout } from '../src/shared/ui';

const NAME_LIMIT = 50;

function PersonRow({ user, selected, index, onPress }: { user: User; selected: boolean; index: number; onPress: () => void }) {
  const { c } = useTheme();
  const s = useStyles();
  return (
    <Rise index={Math.min(index, 10)}>
      <Pressy
        onPress={onPress}
        scaleTo={0.98}
        hoverStyle={!selected ? { backgroundColor: c.tint } : undefined}
        style={[s.row, selected && s.rowOn]}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={user.displayName}
      >
        <Avatar name={user.displayName} size={44} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={s.name} numberOfLines={1}>
            {user.displayName}
          </Text>
          <Text style={s.handle} numberOfLines={1}>
            @{user.username}
          </Text>
        </View>
        <View style={[s.box, selected && s.boxOn]}>
          {selected && (
            <Animated.View entering={ZoomIn.springify().damping(14)}>
              <Icon name="check" size={14} color={c.onAccent} strokeWidth={2.6} />
            </Animated.View>
          )}
        </View>
      </Pressy>
    </Rise>
  );
}

export default function NewGroupScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const isDemo = useAuthStore((st) => st.isDemo);
  const conversations = useChatsStore((st) => st.conversations);
  const [groupName, setGroupName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [selected, setSelected] = useState<Map<string, User>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);

  const knownContacts = useMemo<User[]>(() => {
    const seen = new Map<string, User>();
    for (const cv of conversations) if (cv.otherUser) seen.set(cv.otherUser.id, cv.otherUser);
    return [...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [conversations]);

  // Directory search for people you haven't chatted with yet.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2 || isDemo) {
      setSearchResults([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const results = await conversationRepository.searchUsers(q);
        if (!cancelled) setSearchResults(results);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, isDemo]);

  const toggle = (u: User) => {
    const next = new Map(selected);
    if (next.has(u.id)) next.delete(u.id);
    else next.set(u.id, u);
    setSelected(next);
  };

  const handleCreateGroup = async () => {
    if (isDemo) return notify(t('newGroup.demoTitle'), t('newGroup.demoBody'));
    if (!groupName.trim()) return notify(t('newGroup.nameRequired'), t('newGroup.nameRequiredBody'));
    if (selected.size === 0) return notify(t('newGroup.membersRequired'), t('newGroup.membersRequiredBody'));
    setIsCreating(true);
    try {
      const conversationId = await conversationRepository.createGroupConversation(groupName.trim(), [...selected.keys()]);
      void useChatsStore.getState().load({ sync: false });
      router.replace(`/chat/${conversationId}`);
    } catch (e) {
      notify(t('newGroup.failed'), friendlyError(e));
    } finally {
      setIsCreating(false);
    }
  };

  const members = [...selected.values()];
  const q = searchQuery.trim().toLowerCase();
  const pool = q.length >= 2 ? [...knownContacts, ...searchResults.filter((r) => !knownContacts.some((k) => k.id === r.id))] : knownContacts;
  const people = pool.filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q));
  const canCreate = !!groupName.trim() && selected.size > 0 && !isCreating;

  const groupCard = (
    <View style={s.groupCard}>
      <Hatch gap={12} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
        <Animated.View key={groupName.trim() ? 'named' : 'blank'} entering={ZoomIn.springify().damping(14)}>
          {groupName.trim() ? <Avatar name={groupName} size={64} square /> : (
            <View style={s.groupGlyph}>
              <Icon name="users" size={28} color={c.accentText} />
            </View>
          )}
        </Animated.View>
        <View style={{ flex: 1, gap: 6 }}>
          <Eyebrow>{t('newGroup.name')}</Eyebrow>
          <View style={[s.nameField, nameFocused && { borderColor: c.accentLine }]}>
            <TextInput
              value={groupName}
              onChangeText={setGroupName}
              placeholder={t('newGroup.namePlaceholder')}
              placeholderTextColor={c.placeholder}
              maxLength={NAME_LIMIT}
              onFocus={() => setNameFocused(true)}
              onBlur={() => setNameFocused(false)}
              style={s.nameInput}
              accessibilityLabel={t('newGroup.name')}
              numberOfLines={1}
            />
            <Text style={s.counter}>{`${groupName.length}/${NAME_LIMIT}`}</Text>
          </View>
        </View>
      </View>
      <View style={s.note}>
        <Icon name="shieldCheck" size={15} color={c.success} />
        <Text style={[type.caption, { flex: 1 }]}>{t('newGroup.keysNote')}</Text>
      </View>
    </View>
  );

  const selectedStrip = (
    <View style={{ gap: 10 }}>
      <Eyebrow style={{ paddingHorizontal: 4 }}>{members.length ? t('newGroup.membersCount', { count: members.length }) : t('newGroup.members')}</Eyebrow>
      {members.length === 0 ? (
        <Text style={[type.caption, { paddingHorizontal: 4 }]}>{t('newGroup.pickHint')}</Text>
      ) : isWide ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {members.map((u) => (
            <Animated.View key={u.id} entering={ZoomIn.springify().damping(15)} exiting={ZoomOut.duration(140)} layout={LinearTransition}>
              <Pressy onPress={() => toggle(u)} style={s.chip} hoverStyle={{ borderColor: c.dangerTint }} accessibilityLabel={t('newGroup.remove', { name: u.displayName })}>
                <Avatar name={u.displayName} size={26} />
                <Text style={s.chipName} numberOfLines={1}>
                  {u.displayName}
                </Text>
                <Icon name="close" size={14} color={c.faint} />
              </Pressy>
            </Animated.View>
          ))}
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingHorizontal: 4 }}>
          {members.map((u) => (
            <Animated.View key={u.id} entering={ZoomIn.springify().damping(15)} exiting={ZoomOut.duration(140)} layout={LinearTransition}>
              <Pressy onPress={() => toggle(u)} style={s.bubble} accessibilityLabel={t('newGroup.remove', { name: u.displayName })}>
                <View>
                  <Avatar name={u.displayName} size={52} />
                  <View style={s.bubbleX}>
                    <Icon name="close" size={10} color={c.bg} strokeWidth={2.6} />
                  </View>
                </View>
                <Text style={s.bubbleName} numberOfLines={1}>
                  {u.displayName.split(' ')[0]}
                </Text>
              </Pressy>
            </Animated.View>
          ))}
        </ScrollView>
      )}
    </View>
  );

  const empty = isLoading ? (
    <ActivityIndicator color={c.accent} style={{ marginTop: 30 }} />
  ) : (
    <EmptyState icon="search" title={q.length >= 2 ? t('newGroup.empty') : t('newGroup.addPeople')} body={q.length >= 2 ? t('newGroup.emptyBody') : t('newGroup.noContacts')} />
  );

  const list = (
    <FlatList
      data={people}
      keyExtractor={(u) => u.id}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: insets.bottom + 32, gap: 2 }}
      showsVerticalScrollIndicator={false}
      ListHeaderComponent={
        <View style={{ gap: 12, paddingBottom: 10 }}>
          {!isWide && groupCard}
          {!isWide && selectedStrip}
          <Eyebrow style={{ paddingHorizontal: 4, marginTop: isWide ? 0 : 8 }}>{t('newGroup.addPeople')}</Eyebrow>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <SearchField value={searchQuery} onChangeText={setSearchQuery} placeholder={t('newGroup.search')} onClear={() => setSearchQuery('')} style={{ flex: 1 }} />
            {isLoading && <ActivityIndicator size="small" color={c.accent} />}
          </View>
        </View>
      }
      ListEmptyComponent={empty}
      renderItem={({ item, index }) => <PersonRow user={item} index={index} selected={selected.has(item.id)} onPress={() => toggle(item)} />}
    />
  );

  return (
    <View style={s.container}>
      <Grain />
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <IconButton icon="back" label={t('common.back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))} />
        <View style={{ flex: 1, alignItems: isWide ? 'flex-start' : 'center' }}>
          <Text style={[type.h3, { fontSize: 18 }]} accessibilityRole="header">
            {t('newGroup.title')}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Icon name="lock" size={11} color={c.success} />
            <Text style={[type.caption, { fontSize: 12 }]}>{t('newGroup.sub')}</Text>
          </View>
        </View>
        <Button label={t('newGroup.create')} size="md" loading={isCreating} disabled={!canCreate} onPress={handleCreateGroup} />
      </View>
      {isWide ? (
        <View style={s.wide}>
          <Animated.View entering={FadeIn} style={{ width: 400, gap: 22 }}>
            {groupCard}
            {selectedStrip}
          </Animated.View>
          <View style={s.wideList}>{list}</View>
        </View>
      ) : (
        <View style={{ flex: 1, paddingHorizontal: 12 }}>{list}</View>
      )}
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingBottom: 12 },
  wide: { flex: 1, flexDirection: 'row', gap: 28, paddingHorizontal: 28, paddingTop: 12, maxWidth: 1180, width: '100%', alignSelf: 'center' },
  wideList: { flex: 1, minWidth: 0, backgroundColor: c.panel, borderRadius: 24, borderWidth: 1, borderColor: c.line, padding: 16, paddingBottom: 0, marginBottom: 24 },
  groupCard: { gap: 16, padding: 18, borderRadius: 24, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
  groupGlyph: { width: 64, height: 64, borderRadius: 20, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  nameField: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 48, paddingHorizontal: 14, borderRadius: 14, backgroundColor: c.field, borderWidth: 1, borderColor: c.line },
  nameInput: { flex: 1, minWidth: 0, fontFamily: f.semibold, fontSize: 16, color: c.text, outlineStyle: 'none' } as any,
  counter: { fontFamily: f.mono, fontSize: 11.5, color: c.faint },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, paddingLeft: 6, paddingRight: 12, borderRadius: 19, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, maxWidth: 220 },
  chipName: { fontFamily: f.medium, fontSize: 13.5, color: c.text, flexShrink: 1 },
  bubble: { alignItems: 'center', gap: 6, width: 62 },
  bubbleX: { position: 'absolute', right: -2, top: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: c.muted, borderWidth: 2, borderColor: c.bg, alignItems: 'center', justifyContent: 'center' },
  bubbleName: { fontFamily: f.medium, fontSize: 12, color: c.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 18, borderWidth: 1, borderColor: 'transparent' },
  rowOn: { backgroundColor: c.accentTint, borderColor: c.accentTint2 },
  name: { fontFamily: f.semibold, fontSize: 15.5, color: c.text },
  handle: { fontFamily: f.script === 'latin' ? f.mono : f.body, fontSize: 12.5, color: c.muted },
  box: { width: 24, height: 24, borderRadius: 8, borderWidth: 1.5, borderColor: c.line3, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: c.accent, borderColor: c.accent },
}));
