/**
 * Stories overview: my status (with view counts), then recent updates,
 * viewed updates and muted authors.
 */

import React, { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { EmptyState, Grain, Hatch, Icon, IconButton, Pressy, Rise } from '../../../shared/ui';
import { useAuthStore } from '../../auth/useAuthStore';
import { useStoriesLive, useStoryTray } from '../hooks';
import { StoryGroup, useStoriesStore } from '../useStoriesStore';
import { traySection } from '../tray';
import { storyAge, storyPreviewText, storyTimeLeft } from '../storyText';
import { confirmToggleMute } from './StoriesTray';
import { StoryRing } from './StoryRing';

export function StoriesList() {
  const insets = useSafeAreaInsets();
  const { c, type, f } = useTheme();
  const s = useStyles();
  const t = useT();
  const userId = useAuthStore((st) => st.user?.id) ?? '';
  const isLoading = useStoriesStore((st) => st.isLoading);
  const loaded = useStoriesStore((st) => st.loaded);
  const error = useStoriesStore((st) => st.error);
  const unavailable = useStoriesStore((st) => st.unavailable);
  const viewCounts = useStoriesStore((st) => st.viewCounts);
  const load = useStoriesStore((st) => st.load);
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
    { title: t('stories.recent'), key: 'unseen', data: bySection('unseen') },
    { title: t('stories.viewed'), key: 'seen', data: bySection('seen') },
    { title: t('stories.mutedCount', { count: mutedGroups.length }), key: 'muted', data: showMuted ? mutedGroups : [] },
  ].filter((sec) => sec.data.length > 0 || (sec.key === 'muted' && mutedGroups.length > 0));

  const latest = mine[mine.length - 1];
  const totalViews = mine.reduce((n, st) => n + (viewCounts[st.id] ?? 0), 0);
  const upper = (x: string) => (f.script === 'latin' ? x.toUpperCase() : x);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'));

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <Grain />
      <View style={s.header}>
        <IconButton icon="back" label={t('common.back')} onPress={back} />
        <Text style={[type.title, { flex: 1, fontSize: 26 }]} accessibilityRole="header">
          {t('stories.title')}
        </Text>
        <IconButton icon="lock" label={t('stories.privacy')} variant="filled" onPress={() => router.push('/stories/privacy')} />
        <IconButton icon="plus" label={t('stories.new')} variant="brass" onPress={() => router.push('/stories/new')} />
      </View>

      {unavailable ? (
        <EmptyState icon="cloud" title={t('stories.title')} body={t('stories.demo')} />
      ) : !loaded ? (
        <ActivityIndicator color={c.accent} style={{ marginTop: 48 }} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(g) => g.userId}
          refreshControl={<RefreshControl refreshing={isLoading && loaded} onRefresh={load} tintColor={c.accent} />}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={[s.list, { paddingBottom: insets.bottom + 40 }]}
          ListHeaderComponent={
            <View style={{ gap: 12 }}>
              <Pressy style={s.mine} onPress={() => router.push(mine.length ? `/stories/${userId}` : '/stories/new')} scaleTo={0.98} hoverStyle={{ borderColor: c.accentLine }} accessibilityLabel={t('stories.mine')}>
                <Hatch gap={12} />
                <StoryRing userId={userId} name={t('common.you')} size={58} state={mine.length ? 'seen' : 'none'} showAdd={!mine.length} cutout={c.panel} />
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <Text style={[type.name, { fontSize: 16.5 }]}>{t('stories.mine')}</Text>
                  <Text style={type.caption} numberOfLines={1}>
                    {latest ? `${t('stories.updates', { count: mine.length })} · ${storyTimeLeft(t, latest.expiresAt)}` : t('stories.addHint')}
                  </Text>
                </View>
                {mine.length > 0 && (
                  <View style={s.views}>
                    <Icon name="eye" size={15} color={c.muted} />
                    <Text style={s.viewsText}>{totalViews}</Text>
                  </View>
                )}
              </Pressy>
              {error && <Text style={[type.caption, { color: c.danger }]}>{error}</Text>}
              <View style={s.e2ee}>
                <Icon name="lock" size={12} color={c.success} />
                <Text style={[type.caption, { flex: 1 }]}>{t('stories.e2ee')}</Text>
              </View>
              {groups.length === 0 && <EmptyState icon="users" title={t('stories.noneTitle')} body={t('stories.none')} />}
            </View>
          }
          renderSectionHeader={({ section }) =>
            section.key === 'muted' ? (
              <Pressy style={s.sectionRow} onPress={() => setShowMuted((v) => !v)} accessibilityLabel={section.title}>
                <Text style={s.section}>{upper(section.title)}</Text>
                <Icon name="down" size={14} color={c.faint} style={showMuted ? { transform: [{ rotate: '180deg' }] } : undefined} />
              </Pressy>
            ) : (
              <View style={s.sectionRow}>
                <Text style={s.section}>{upper(section.title)}</Text>
              </View>
            )
          }
          renderItem={({ item, index }) => <GroupRow group={item} index={index} />}
        />
      )}
    </View>
  );
}

function GroupRow({ group, index }: { group: StoryGroup; index: number }) {
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const latest = group.stories[group.stories.length - 1];
  return (
    <Rise index={Math.min(index, 10)}>
      <Pressy style={s.row} onPress={() => router.push(`/stories/${group.userId}`)} onLongPress={() => confirmToggleMute(group)} scaleTo={0.98} hoverStyle={{ backgroundColor: c.tint }} accessibilityLabel={group.displayName}>
        <StoryRing userId={group.userId} name={group.displayName} state={group.hasUnseen ? 'unseen' : 'seen'} muted={group.muted} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={[type.name, { fontSize: 15.5 }, group.muted && { color: c.muted }]} numberOfLines={1}>
            {group.displayName}
          </Text>
          <Text style={type.caption} numberOfLines={1}>
            {storyAge(t, latest.createdAt)} · {storyPreviewText(t, latest.payload, 40)}
          </Text>
        </View>
        {group.hasUnseen && <Animated.View entering={FadeIn} style={s.unseenDot} />}
      </Pressy>
    </Rise>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  root: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 8 },
  list: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 12, paddingTop: 6 },
  mine: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 24, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
  views: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: c.raised, borderRadius: 14, paddingHorizontal: 10, height: 28 },
  viewsText: { fontFamily: f.mono, fontSize: 12.5, color: c.muted },
  e2ee: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, marginTop: 18, marginBottom: 4 },
  section: { ...t.eyebrow },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 18 },
  unseenDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: c.accent },
}));
