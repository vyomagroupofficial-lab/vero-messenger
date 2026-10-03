/**
 * "Who can see my stories" + muted authors. Saved on this device and synced to
 * the user's own story_privacy row; applied when the next story is posted.
 */

import React, { useMemo, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BorderRadius, Colors, Spacing, Typography } from '../../../shared/theme/theme';
import { useAuthStore } from '../../auth/useAuthStore';
import { AUDIENCE_LABELS, AudienceMode, StoryPrivacy, resolveAudience } from '../audience';
import { useStoryContacts } from '../hooks';
import { useStoriesStore } from '../useStoriesStore';
import { StoryRing } from './StoryRing';

const MODES: { mode: AudienceMode; hint: string }[] = [
  { mode: 'contacts', hint: 'Everyone you have a direct chat with' },
  { mode: 'contacts_except', hint: 'Your contacts, minus the people you pick' },
  { mode: 'only', hint: 'Only the contacts you pick' },
];

export function StoryPrivacySettings() {
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const privacy = useStoriesStore((s) => s.privacy);
  const names = useStoriesStore((s) => s.names);
  const contacts = useStoryContacts();
  const [saving, setSaving] = useState(false);

  const save = async (patch: Partial<StoryPrivacy>) => {
    setSaving(true);
    try {
      await useStoriesStore.getState().setPrivacy(patch);
    } catch (e: any) {
      Alert.alert('Saved on this device only', e?.message ?? 'Couldn’t sync your story privacy. It will be applied here.');
    } finally {
      setSaving(false);
    }
  };

  const listKey = privacy.audience === 'contacts_except' ? 'exceptUserIds' : 'onlyUserIds';
  const selected = new Set(privacy[listKey]);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    void save({ [listKey]: [...next] });
  };

  const audienceCount = resolveAudience(contacts.map((c) => c.id), privacy, userId).length;
  const contactNames = useMemo(() => Object.fromEntries(contacts.map((c) => [c.id, c.displayName])), [contacts]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Story privacy</Text>
        <Text style={styles.saving}>{saving ? 'Saving…' : ''}</Text>
      </View>

      <FlatList
        data={privacy.audience === 'contacts' ? [] : contacts}
        keyExtractor={(c) => c.id}
        ListHeaderComponent={
          <View>
            <Text style={styles.section}>WHO CAN SEE MY STORIES</Text>
            {MODES.map(({ mode, hint }) => (
              <TouchableOpacity key={mode} style={styles.option} onPress={() => save({ audience: mode })}>
                <Ionicons
                  name={privacy.audience === mode ? 'radio-button-on' : 'radio-button-off'}
                  size={22}
                  color={privacy.audience === mode ? Colors.accentLight : Colors.textTertiary}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.optionTitle}>{AUDIENCE_LABELS[mode]}</Text>
                  <Text style={styles.optionHint}>{hint}</Text>
                </View>
              </TouchableOpacity>
            ))}
            <Text style={styles.note}>
              Your next story will be encrypted for {audienceCount} {audienceCount === 1 ? 'person' : 'people'}. Changes
              don’t affect stories you already shared. The server can see who a story is shared with, never its content.
            </Text>
            {privacy.audience !== 'contacts' && (
              <Text style={styles.section}>
                {privacy.audience === 'contacts_except' ? 'HIDE MY STORIES FROM' : 'SHARE ONLY WITH'}
              </Text>
            )}
            {privacy.audience !== 'contacts' && contacts.length === 0 && (
              <Text style={styles.note}>Start a direct chat with someone to add them here.</Text>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => toggle(item.id)}>
            <StoryRing userId={item.id} name={item.displayName} state="none" size={40} />
            <Text style={styles.rowName}>{item.displayName}</Text>
            <Ionicons
              name={selected.has(item.id) ? 'checkbox' : 'square-outline'}
              size={22}
              color={selected.has(item.id) ? Colors.accentLight : Colors.textTertiary}
            />
          </TouchableOpacity>
        )}
        ListFooterComponent={
          <View>
            <Text style={styles.section}>MUTED STORIES</Text>
            {privacy.mutedUserIds.length === 0 ? (
              <Text style={styles.note}>Long-press someone in the stories tray to mute their stories.</Text>
            ) : (
              privacy.mutedUserIds.map((id) => (
                <View key={id} style={styles.row}>
                  <StoryRing userId={id} name={contactNames[id] ?? names[id] ?? '?'} state="none" size={40} muted />
                  <Text style={styles.rowName}>{contactNames[id] ?? names[id] ?? 'Unknown'}</Text>
                  <TouchableOpacity onPress={() => void useStoriesStore.getState().toggleMute(id)} style={styles.unmute}>
                    <Text style={styles.unmuteText}>Unmute</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        }
        contentContainerStyle={{ paddingBottom: Spacing['3xl'] }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.base, paddingVertical: Spacing.md },
  title: { flex: 1, color: Colors.textPrimary, fontSize: Typography.xl, fontWeight: Typography.bold },
  saving: { color: Colors.textTertiary, fontSize: Typography.xs },
  section: {
    color: Colors.textTertiary,
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    letterSpacing: 0.8,
    paddingHorizontal: Spacing.base,
    marginTop: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginHorizontal: Spacing.base,
    marginBottom: Spacing.sm,
    padding: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  optionTitle: { color: Colors.textPrimary, fontSize: Typography.base, fontWeight: Typography.medium },
  optionHint: { color: Colors.textSecondary, fontSize: Typography.xs, marginTop: 2 },
  note: { color: Colors.textSecondary, fontSize: Typography.xs, paddingHorizontal: Spacing.base, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.base, paddingVertical: Spacing.sm },
  rowName: { flex: 1, color: Colors.textPrimary, fontSize: Typography.base },
  unmute: { borderWidth: 1, borderColor: Colors.borderAccent, borderRadius: BorderRadius.full, paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs },
  unmuteText: { color: Colors.accentLight, fontSize: Typography.sm },
});
