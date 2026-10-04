import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import dayjs from 'dayjs';
import { useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { Avatar, Sheet } from '../../../shared/ui';
import { StoryViewer, storyRepository } from '../StoryRepository';

/** Author-only list of who viewed a story (RLS hides it from everyone else). */
export function ViewersSheet({ storyId, visible, onClose }: { storyId: string | null; visible: boolean; onClose: () => void }) {
  const { c, type, f } = useTheme();
  const t = useT();
  const [viewers, setViewers] = useState<StoryViewer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !storyId) return;
    let alive = true;
    setViewers(null);
    setError(null);
    storyRepository
      .viewers(storyId)
      .then((v) => alive && setViewers(v))
      .catch((e) => alive && setError(e?.message ?? t('stories.viewersFailed')));
    return () => {
      alive = false;
    };
  }, [visible, storyId]);

  return (
    <Sheet visible={visible} onClose={onClose} title={viewers ? t('stories.viewedBy', { count: viewers.length }) : t('stories.viewers')}>
      {error ? (
        <Text style={[type.caption, { textAlign: 'center' }]}>{error}</Text>
      ) : !viewers ? (
        <ActivityIndicator color={c.accent} style={{ marginVertical: 20 }} />
      ) : viewers.length === 0 ? (
        <Text style={[type.caption, { textAlign: 'center', paddingVertical: 12 }]}>{t('stories.noViews')}</Text>
      ) : (
        <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 4 }}>
          {viewers.map((v, i) => (
            <Animated.View key={v.userId} entering={FadeInDown.delay(Math.min(i, 8) * 40)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 }}>
              <Avatar name={v.displayName} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={[type.name, { fontSize: 15 }]}>{v.displayName}</Text>
                <Text style={[type.caption, { fontFamily: f.mono }]}>{dayjs(v.viewedAt).format('HH:mm')}</Text>
              </View>
            </Animated.View>
          ))}
        </ScrollView>
      )}
    </Sheet>
  );
}
