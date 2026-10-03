import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BorderRadius, Colors, Typography } from '../../../shared/theme/theme';

const AVATAR_COLORS = [Colors.accent, Colors.purple, Colors.emerald, Colors.warning, Colors.teal];

function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

interface Props {
  userId: string;
  name: string;
  size?: number;
  /** 'unseen' = bright ring, 'seen' = subtle ring, 'none' = no stories. */
  state: 'unseen' | 'seen' | 'none';
  muted?: boolean;
  /** Shows a "+" badge (my own ring). */
  showAdd?: boolean;
}

export function StoryRing({ userId, name, size = 60, state, muted, showAdd }: Props) {
  const inner = size - 8;
  const ringColor = state === 'unseen' ? Colors.accentLight : state === 'seen' ? Colors.borderLight : 'transparent';
  return (
    <View style={{ opacity: muted ? 0.45 : 1 }}>
      <View
        style={[
          styles.ring,
          { width: size, height: size, borderRadius: size / 2, borderColor: ringColor, borderWidth: state === 'unseen' ? 2.5 : 1.5 },
        ]}
      >
        <View
          style={[
            styles.avatar,
            { width: inner, height: inner, borderRadius: inner / 2, backgroundColor: colorFor(userId) },
          ]}
        >
          <Text style={[styles.initials, { fontSize: inner * 0.34 }]}>{name.slice(0, 2).toUpperCase()}</Text>
        </View>
      </View>
      {showAdd && (
        <View style={styles.addBadge}>
          <Ionicons name="add" size={14} color={Colors.textInverse} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { alignItems: 'center', justifyContent: 'center' },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  initials: { color: Colors.white, fontWeight: Typography.bold },
  addBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.accentLight,
    borderWidth: 2,
    borderColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
