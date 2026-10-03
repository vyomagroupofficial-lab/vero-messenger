import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import dayjs from 'dayjs';
import { BorderRadius, Colors, Spacing, Typography } from '../../../shared/theme/theme';
import { StoryViewer, storyRepository } from '../StoryRepository';
import { StoryRing } from './StoryRing';

/** Author-only list of who viewed a story (RLS hides it from everyone else). */
export function ViewersSheet({ storyId, visible, onClose }: { storyId: string | null; visible: boolean; onClose: () => void }) {
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
      .catch((e) => alive && setError(e?.message ?? "Couldn't load viewers"));
    return () => {
      alive = false;
    };
  }, [visible, storyId]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <Ionicons name="eye-outline" size={18} color={Colors.textPrimary} />
          <Text style={styles.title}>{viewers ? `Viewed by ${viewers.length}` : 'Viewers'}</Text>
        </View>
        {error ? (
          <Text style={styles.muted}>{error}</Text>
        ) : !viewers ? (
          <ActivityIndicator color={Colors.accent} style={{ marginVertical: Spacing.xl }} />
        ) : viewers.length === 0 ? (
          <Text style={styles.muted}>No views yet. People who turned off read receipts aren’t shown.</Text>
        ) : (
          <FlatList
            data={viewers}
            keyExtractor={(v) => v.userId}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <StoryRing userId={item.userId} name={item.displayName} state="none" size={42} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.displayName}</Text>
                  <Text style={styles.time}>{dayjs(item.viewedAt).format('h:mm A')}</Text>
                </View>
              </View>
            )}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: Colors.overlay },
  sheet: {
    maxHeight: '60%',
    backgroundColor: Colors.surfaceElevated,
    borderTopLeftRadius: BorderRadius['2xl'],
    borderTopRightRadius: BorderRadius['2xl'],
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing['2xl'],
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.borderLight,
    marginVertical: Spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.sm },
  title: { color: Colors.textPrimary, fontSize: Typography.md, fontWeight: Typography.semibold },
  muted: { color: Colors.textSecondary, fontSize: Typography.sm, paddingVertical: Spacing.lg, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.sm },
  name: { color: Colors.textPrimary, fontSize: Typography.base, fontWeight: Typography.medium },
  time: { color: Colors.textTertiary, fontSize: Typography.xs, marginTop: 2 },
});
