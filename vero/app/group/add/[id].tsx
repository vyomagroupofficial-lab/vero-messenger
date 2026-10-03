import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { friendlyError } from '../../../src/core/network/supabase';
import { conversationRepository } from '../../../src/features/chats/ConversationRepository';
import { useChatsStore } from '../../../src/features/chats/useChatsStore';
import { ScreenHeader, useGroupStyles } from '../../../src/features/groups/components/GroupComponents';
import { notify } from '../../../src/features/groups/components/ui';
import { groupStore, useGroupStore } from '../../../src/features/groups/useGroupStore';
import { User } from '../../../src/shared/models/Message';
import { makeStyles, useTheme } from '../../../src/shared/theme/ThemeProvider';
import { useT } from '../../../src/shared/i18n';
import { Avatar, Button, EmptyState, Icon, Pressy, Rise, SearchField } from '../../../src/shared/ui';

/** Admins add people (from recent chats or the directory) to a group. */
export default function AddGroupMembersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id ?? '';
  const insets = useSafeAreaInsets();
  const { c } = useTheme();
  const gs = useGroupStyles();
  const s = useStyles();
  const t = useT();
  const details = useGroupStore((st) => st.details[conversationId]);
  const conversations = useChatsStore((st) => st.conversations);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Map<string, User>>(new Map());
  const [saving, setSaving] = useState(false);

  const existing = useMemo(() => new Set((details?.members ?? []).map((m) => m.id)), [details]);
  const contacts = useMemo(() => {
    const seen = new Map<string, User>();
    for (const cv of conversations) if (cv.otherUser && !existing.has(cv.otherUser.id)) seen.set(cv.otherUser.id, cv.otherUser);
    return [...seen.values()];
  }, [conversations, existing]);

  useEffect(() => {
    if (!details && conversationId) void groupStore.getState().load(conversationId);
  }, [details, conversationId]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const found = await conversationRepository.searchUsers(q);
        if (!cancelled) setResults(found.filter((u) => !existing.has(u.id)));
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, existing]);

  const list = query.trim().length >= 2 ? results : contacts;

  const toggle = (u: User) => {
    const next = new Map(selected);
    if (next.has(u.id)) next.delete(u.id);
    else next.set(u.id, u);
    setSelected(next);
  };

  const save = async () => {
    setSaving(true);
    try {
      await groupStore.getState().addMembers(conversationId, [...selected.keys()]);
      router.back();
    } catch (e) {
      notify(t('groups.addFailed'), friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[gs.container, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('groups.addMembers')} subtitle={details?.name} onBack={() => router.back()} />
      <View style={s.inner}>
        <SearchField value={query} onChangeText={setQuery} placeholder={t('newGroup.search')} onClear={() => setQuery('')} style={{ marginHorizontal: 16, marginTop: 14, marginBottom: 6 }} />
        <FlatList
          data={list}
          keyExtractor={(u) => u.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingVertical: 6 }}
          ListEmptyComponent={
            searching ? (
              <ActivityIndicator color={c.accent} style={{ marginTop: 24 }} />
            ) : (
              <EmptyState icon="search" title={query.trim().length >= 2 ? t('newGroup.empty') : t('newGroup.addPeople')} body={query.trim().length >= 2 ? t('newGroup.emptyBody') : t('newGroup.noContacts')} />
            )
          }
          renderItem={({ item, index }) => {
            const on = selected.has(item.id);
            return (
              <Rise index={Math.min(index, 10)}>
                <Pressy
                  onPress={() => toggle(item)}
                  scaleTo={0.98}
                  hoverStyle={!on ? { backgroundColor: c.tint } : undefined}
                  style={[s.row, on && s.rowOn]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={item.displayName}
                >
                  <Avatar name={item.displayName} size={44} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.name} numberOfLines={1}>
                      {item.displayName}
                    </Text>
                    <Text style={s.handle}>@{item.username}</Text>
                  </View>
                  <View style={[s.box, on && s.boxOn]}>
                    {on && (
                      <Animated.View entering={ZoomIn.springify().damping(14)}>
                        <Icon name="check" size={14} color={c.onAccent} strokeWidth={2.6} />
                      </Animated.View>
                    )}
                  </View>
                </Pressy>
              </Rise>
            );
          }}
        />
        <View style={{ padding: 16, paddingBottom: insets.bottom + 16 }}>
          <Button
            label={selected.size ? t('groups.addCount', { count: selected.size }) : t('groups.add')}
            icon="userPlus"
            loading={saving}
            disabled={!selected.size}
            onPress={() => void save()}
          />
        </View>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  inner: { flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 18, borderWidth: 1, borderColor: 'transparent' },
  rowOn: { backgroundColor: c.accentTint, borderColor: c.accentTint2 },
  name: { fontFamily: f.semibold, fontSize: 15.5, color: c.text },
  handle: { fontFamily: f.script === 'latin' ? f.mono : f.body, fontSize: 12.5, color: c.muted },
  box: { width: 24, height: 24, borderRadius: 8, borderWidth: 1.5, borderColor: c.line3, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: c.accent, borderColor: c.accent },
}));
