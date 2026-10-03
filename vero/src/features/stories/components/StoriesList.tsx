/**
 * Stories overview: my status (with view counts), then recent updates,
 * viewed updates and muted authors.
 */

import React, { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BorderRadius, Colors, Spacing, Typography } from '../../../shared/theme/theme';
import { useAuthStore } from '../../auth/useAuthStore';
import { storyAgeLabel, timeLeftLabel } from '../expiry';
import { useStoriesLive, useStoryTray } from '../hooks';
import { storyPreview } from '../payload';
import { StoryGroup, useStoriesStore } from '../useStoriesStore';
import { traySection } from '../tray';
import { confirmToggleMute } from './StoriesTray';
import { StoryRing } from './StoryRing';

export function StoriesList() {
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const isLoading = useStoriesStore((s) => s.isLoading);
  const loaded = useStoriesStore((s) => s.loaded);
  const error = useStoriesStore((s) => s.error);
  const unavailable = useStoriesStore((s) => s.unavailable);
  const viewCounts = useStoriesStore((s) => s.viewCounts);
  const load = useStoriesStore((s) => s.load);
  const { mine, groups } = useStoryTray();
  const [showMuted, setShowMuted] = useState(false);
  useStoriesLive();

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const bySection = (key: 'unseen' | 'seen' | 'muted') => groups.filter((g) => traySection(g) === key);
  const mutedGroups = bySection('muted');
  const sections = [
    { title: 'RECENT UPDATES', key: 'unseen', data: bySection('unseen') },
    { title: 'VIEWED UPDATES', key: 'seen', data: bySection('seen') },
    { title: `MUTED (${mutedGroups.length})`, key: 'muted', data: showMuted ? mutedGroups : [] },
  ].filter((s) => s.data.length > 0 || (s.key === 'muted' && mutedGroups.length > 0));

  const latest = mine[mine.length - 1];
  const totalViews = mine.reduce((n, s) => n + (viewCounts[s.id] ?? 0), 0);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Stories</Text>
        <TouchableOpacity onPress={() => router.push('/stories/privacy')} hitSlop={10} accessibilityLabel="Story privacy">
          <Ionicons name="lock-closed-outline" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.push('/stories/new')} hitSlop={10} accessibilityLabel="New story">
          <Ionicons name="add-circle" size={28} color={Colors.accentLight} />
        </TouchableOpacity>
      </View>

      {unavailable ? (
        <View style={styles.empty}>
          <Ionicons name="cloud-offline-outline" size={36} color={Colors.textSecondary} />
          <Text style={styles.emptyText}>{unavailable}</Text>
        </View>
      ) : !loaded ? (
        <ActivityIndicator color={Colors.accent} style={{ marginTop: Spacing['3xl'] }} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(g) => g.userId}
          refreshControl={<RefreshControl refreshing={isLoading && loaded} onRefresh={load} tintColor={Colors.accent} />}
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={
            <View>
              <TouchableOpacity
                style={styles.row}
                onPress={() => router.push(mine.length ? `/stories/${userId}` : '/stories/new')}
              >
                <StoryRing userId={userId} name="Me" state={mine.length ? 'seen' : 'none'} showAdd={!mine.length} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>My story</Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {latest
                      ? `${mine.length} ${mine.length === 1 ? 'update' : 'updates'} · ${timeLeftLabel(latest.expiresAt)}`
                      : 'Tap to add a text, photo or video story'}
                  </Text>
                </View>
                {mine.length > 0 && (
                  <View style={styles.views}>
                    <Ionicons name="eye-outline" size={16} color={Colors.textSecondary} />
                    <Text style={styles.viewsText}>{totalViews}</Text>
                  </View>
                )}
              </TouchableOpacity>
              {error && <Text style={styles.error}>{error}</Text>}
              <View style={styles.e2ee}>
                <Ionicons name="lock-closed" size={12} color={Colors.emerald} />
                <Text style={styles.e2eeText}>Stories are end-to-end encrypted and disappear after 24 hours.</Text>
              </View>
              {groups.length === 0 && (
                <Text style={styles.emptyText}>No updates from your contacts right now.</Text>
              )}
            </View>
          }
          renderSectionHeader={({ section }) =>
            section.key === 'muted' ? (
              <TouchableOpacity style={styles.sectionRow} onPress={() => setShowMuted((v) => !v)}>
                <Text style={styles.section}>{section.title}</Text>
                <Ionicons name={showMuted ? 'chevron-up' : 'chevron-down'} size={14} color={Colors.textTertiary} />
              </TouchableOpacity>
            ) : (
              <Text style={[styles.section, styles.sectionRow]}>{section.title}</Text>
            )
          }
          renderItem={({ item }) => <GroupRow group={item} />}
          contentContainerStyle={{ paddingBottom: Spacing['3xl'] }}
        />
      )}
    </SafeAreaView>
  );
}

function GroupRow({ group }: { group: StoryGroup }) {
  const latest = group.stories[group.stories.length - 1];
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={() => router.push(`/stories/${group.userId}`)}
      onLongPress={() => confirmToggleMute(group)}
    >
      <StoryRing userId={group.userId} name={group.displayName} state={group.hasUnseen ? 'unseen' : 'seen'} muted={group.muted} />
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>{group.displayName}</Text>
        <Text style={styles.sub} numberOfLines={1}>
          {storyAgeLabel(latest.createdAt)} · {latest.payload ? storyPreview(latest.payload, 40) : '🔒 Encrypted story'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.base, paddingVertical: Spacing.md },
  title: { flex: 1, color: Colors.textPrimary, fontSize: Typography.xl, fontWeight: Typography.bold },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.base, paddingVertical: Spacing.sm },
  name: { color: Colors.textPrimary, fontSize: Typography.md, fontWeight: Typography.semibold },
  sub: { color: Colors.textSecondary, fontSize: Typography.sm, marginTop: 2 },
  views: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  viewsText: { color: Colors.textSecondary, fontSize: Typography.sm },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: Spacing.base, marginTop: Spacing.lg, marginBottom: Spacing.xs },
  section: { color: Colors.textTertiary, fontSize: Typography.xs, fontWeight: Typography.semibold, letterSpacing: 0.8 },
  e2ee: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: Spacing.base, marginTop: Spacing.xs },
  e2eeText: { color: Colors.textTertiary, fontSize: Typography.xs },
  error: { color: Colors.error, fontSize: Typography.sm, paddingHorizontal: Spacing.base, marginTop: Spacing.sm },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md, padding: Spacing.xl },
  emptyText: { color: Colors.textSecondary, fontSize: Typography.sm, textAlign: 'center', padding: Spacing.xl },
});
