/**
 * Horizontal stories tray (rings per contact: unseen first, muted last).
 * Self-contained so a screen only has to render <StoriesTray />.
 */

import React, { useCallback } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Colors, Spacing, Typography } from '../../../shared/theme/theme';
import { useAuthStore } from '../../auth/useAuthStore';
import { useStoriesLive, useStoryTray } from '../hooks';
import { StoryGroup, useStoriesStore } from '../useStoriesStore';
import { StoryRing } from './StoryRing';

export function confirmToggleMute(group: Pick<StoryGroup, 'userId' | 'displayName' | 'muted'>) {
  const action = group.muted ? 'Unmute' : 'Mute';
  Alert.alert(
    `${action} ${group.displayName}'s stories?`,
    group.muted
      ? 'Their new stories will appear with everyone else’s again.'
      : 'Their stories move to the end of the list. They won’t be told.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: action,
        onPress: () =>
          void useStoriesStore
            .getState()
            .toggleMute(group.userId)
            .catch((e) => Alert.alert('Couldn’t save', e?.message ?? 'Try again.')),
      },
    ]
  );
}

export function StoriesTray() {
  const userId = useAuthStore((s) => s.user?.id);
  const unavailable = useStoriesStore((s) => s.unavailable);
  const load = useStoriesStore((s) => s.load);
  const { mine, groups } = useStoryTray();
  useStoriesLive();

  useFocusEffect(
    useCallback(() => {
      if (userId) void load();
    }, [userId, load])
  );

  if (!userId || unavailable) return null;

  const openMine = () => router.push(mine.length ? `/stories/${userId}` : '/stories/new');

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Stories</Text>
        <TouchableOpacity onPress={() => router.push('/stories')} hitSlop={8}>
          <Text style={styles.link}>See all</Text>
        </TouchableOpacity>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        <TouchableOpacity style={styles.item} onPress={openMine} onLongPress={() => router.push('/stories/new')}>
          <StoryRing userId={userId} name="Me" state={mine.length ? 'seen' : 'none'} showAdd={mine.length === 0} />
          <Text style={styles.name} numberOfLines={1}>
            {mine.length ? 'My story' : 'Add story'}
          </Text>
        </TouchableOpacity>
        {groups.map((g) => (
          <TouchableOpacity
            key={g.userId}
            style={styles.item}
            onPress={() => router.push(`/stories/${g.userId}`)}
            onLongPress={() => confirmToggleMute(g)}
            accessibilityLabel={`${g.displayName}'s story${g.hasUnseen ? ', new' : ''}${g.muted ? ', muted' : ''}`}
          >
            <StoryRing userId={g.userId} name={g.displayName} state={g.hasUnseen ? 'unseen' : 'seen'} muted={g.muted} />
            <Text style={[styles.name, g.muted && styles.nameMuted]} numberOfLines={1}>
              {g.displayName}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingTop: Spacing.xs, paddingBottom: Spacing.sm },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    marginBottom: Spacing.xs,
  },
  title: { color: Colors.textSecondary, fontSize: Typography.sm, fontWeight: Typography.semibold, letterSpacing: 0.4 },
  link: { color: Colors.accentLight, fontSize: Typography.sm, fontWeight: Typography.medium },
  row: { paddingHorizontal: Spacing.md, gap: Spacing.md },
  item: { alignItems: 'center', width: 68 },
  name: { color: Colors.textPrimary, fontSize: Typography.xs, marginTop: Spacing.xs, maxWidth: 68 },
  nameMuted: { color: Colors.textTertiary },
});
