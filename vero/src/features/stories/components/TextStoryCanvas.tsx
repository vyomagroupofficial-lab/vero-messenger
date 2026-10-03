import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Colors, Spacing } from '../../../shared/theme/theme';
import { storyFontStyle } from '../hooks';
import type { StoryFont } from '../payload';

export function textStoryFontSize(text: string): number {
  const n = text.length;
  if (n < 40) return 34;
  if (n < 120) return 28;
  if (n < 300) return 22;
  return 18;
}

export function TextStoryCanvas({ text, bg, font }: { text: string; bg: string; font: StoryFont }) {
  return (
    <View style={[styles.canvas, { backgroundColor: bg }]}>
      <Text style={[styles.text, storyFontStyle(font), { fontSize: textStoryFontSize(text) }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing['2xl'] },
  text: { color: Colors.white, textAlign: 'center', lineHeight: undefined },
});
