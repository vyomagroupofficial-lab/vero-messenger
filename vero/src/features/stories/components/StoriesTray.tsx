/**
 * Horizontal stories tray (rings per contact: unseen first, muted last).
 * Self-contained so a screen only has to render <StoriesTray />.
 */

import React, { useCallback } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router, useFocusEffect } from 'expo-router';
import i18n, { useT } from '../../../shared/i18n';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { Pressy } from '../../../shared/ui';
import { useAuthStore } from '../../auth/useAuthStore';
import { confirmAction, notify } from '../confirm';
import { useStoriesLive, useStoryTray } from '../hooks';
import { StoryGroup, useStoriesStore } from '../useStoriesStore';
import { StoryRing } from './StoryRing';

export async function confirmToggleMute(group: Pick<StoryGroup, 'userId' | 'displayName' | 'muted'>): Promise<void> {
  const t = i18n.t.bind(i18n);
  const ok = await confirmAction(
    group.muted ? t('stories.unmuteTitle', { name: group.displayName }) : t('stories.muteTitle', { name: group.displayName }),
    group.muted ? t('stories.unmuteBody') : t('stories.muteBody'),
    group.muted ? t('channels.unmute') : t('channels.mute')
  );
  if (!ok) return;
  try {
    await useStoriesStore.getState().toggleMute(group.userId);
  } catch (e: any) {
    notify(t('stories.localOnly'), e?.message ?? t('stories.syncFailed'));
  }
}

export function StoriesTray() {
  const { f } = useTheme();
  const s = useStyles();
  const t = useT();
  const userId = useAuthStore((st) => st.user?.id);
  const unavailable = useStoriesStore((st) => st.unavailable);
  const load = useStoriesStore((st) => st.load);
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
    <Animated.View entering={FadeIn} style={s.container}>
      <View style={s.headerRow}>
        <Text style={s.title}>{f.script === 'latin' ? t('stories.title').toUpperCase() : t('stories.title')}</Text>
        <Pressy onPress={() => router.push('/stories')} accessibilityRole="link" accessibilityLabel={t('stories.seeAll')}>
          <Text style={s.link}>{t('stories.seeAll')}</Text>
        </Pressy>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
        <Animated.View entering={ZoomIn.springify().damping(14)}>
          <Pressy style={s.item} onPress={openMine} onLongPress={() => router.push('/stories/new')} scaleTo={0.92} accessibilityLabel={mine.length ? t('stories.mine') : t('stories.add')}>
            <StoryRing userId={userId} name={t('common.you')} state={mine.length ? 'seen' : 'none'} showAdd={mine.length === 0} />
            <Text style={s.name} numberOfLines={1}>
              {mine.length ? t('stories.mine') : t('stories.add')}
            </Text>
          </Pressy>
        </Animated.View>
        {groups.map((g, i) => (
          <Animated.View key={g.userId} entering={ZoomIn.delay(40 + i * 40).springify().damping(14)}>
            <Pressy
              style={s.item}
              onPress={() => router.push(`/stories/${g.userId}`)}
              onLongPress={() => confirmToggleMute(g)}
              scaleTo={0.92}
              accessibilityLabel={`${g.displayName}${g.hasUnseen ? `, ${t('stories.unseen')}` : ''}${g.muted ? `, ${t('channels.muted')}` : ''}`}
            >
              <StoryRing userId={g.userId} name={g.displayName} state={g.hasUnseen ? 'unseen' : 'seen'} muted={g.muted} />
              <Text style={[s.name, g.muted && s.nameMuted]} numberOfLines={1}>
                {g.displayName.split(' ')[0]}
              </Text>
            </Pressy>
          </Animated.View>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  container: { gap: 10 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { ...t.eyebrow },
  link: { fontFamily: f.medium, fontSize: 13, color: c.accentText },
  row: { gap: 14, paddingRight: 8 },
  item: { alignItems: 'center', width: 66, gap: 6 },
  name: { fontFamily: f.medium, fontSize: 12, color: c.text, maxWidth: 66 },
  nameMuted: { color: c.faint },
}));
