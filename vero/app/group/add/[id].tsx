import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { friendlyError } from '../../../src/core/network/supabase';
import { conversationRepository } from '../../../src/features/chats/ConversationRepository';
import { useChatsStore } from '../../../src/features/chats/useChatsStore';
import { groupStyles as gs, PrimaryButton, Row, ScreenHeader } from '../../../src/features/groups/components/GroupComponents';
import { notify } from '../../../src/features/groups/components/ui';
import { groupStore, useGroupStore } from '../../../src/features/groups/useGroupStore';
import { User } from '../../../src/shared/models/Message';
import { Colors } from '../../../src/shared/theme/theme';

/** Admins add people (from recent chats or the directory) to a group. */
export default function AddGroupMembersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id ?? '';
  const details = useGroupStore((s) => s.details[conversationId]);
  const conversations = useChatsStore((s) => s.conversations);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Map<string, User>>(new Map());
  const [saving, setSaving] = useState(false);

  const existing = useMemo(() => new Set((details?.members ?? []).map((m) => m.id)), [details]);
  const contacts = useMemo(() => {
    const seen = new Map<string, User>();
    for (const c of conversations) if (c.otherUser && !existing.has(c.otherUser.id)) seen.set(c.otherUser.id, c.otherUser);
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
    const t = setTimeout(async () => {
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
      clearTimeout(t);
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
      notify('Could not add members', friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={gs.container} edges={['top']}>
      <ScreenHeader title="Add members" subtitle={details?.name} onBack={() => router.back()} />
      <TextInput
        style={[gs.input, { marginTop: 12 }]}
        value={query}
        onChangeText={setQuery}
        placeholder="Search by name or @username"
        placeholderTextColor={Colors.textTertiary}
        autoCapitalize="none"
      />
      <FlatList
        data={list}
        keyExtractor={(u) => u.id}
        ListEmptyComponent={
          searching ? (
            <ActivityIndicator color={Colors.accent} style={{ marginTop: 24 }} />
          ) : (
            <View style={gs.centered}>
              <Text style={gs.muted}>{query.trim().length >= 2 ? 'No one found' : 'Search the directory to add people'}</Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <Row
            label={item.displayName}
            sublabel={`@${item.username}`}
            onPress={() => toggle(item)}
            right={
              <Ionicons
                name={selected.has(item.id) ? 'checkmark-circle' : 'ellipse-outline'}
                size={22}
                color={selected.has(item.id) ? Colors.accent : Colors.textTertiary}
              />
            }
          />
        )}
      />
      <PrimaryButton
        label={selected.size ? `Add ${selected.size} ${selected.size === 1 ? 'person' : 'people'}` : 'Add'}
        onPress={() => void save()}
        disabled={!selected.size || saving}
      />
    </SafeAreaView>
  );
}
