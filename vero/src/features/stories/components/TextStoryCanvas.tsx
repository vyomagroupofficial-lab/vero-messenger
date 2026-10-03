import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Grain } from '../../../shared/ui';
import { useTheme } from '../../../shared/theme/ThemeProvider';
import { storyFontStyle } from '../hooks';
import type { StoryFont } from '../payload';

export function textStoryFontSize(text: string): number {
  const n = text.length;
  if (n < 40) return 36;
  if (n < 120) return 29;
  if (n < 300) return 22;
  return 18;
}

/** The "sans" and "bold" story fonts render in Vero's display face (or the script's own face). */
export function useStoryFont(font: StoryFont) {
  const { f } = useTheme();
  if (font === 'sans') return { fontFamily: f.script === 'latin' ? f.display : f.semibold };
  if (font === 'bold') return { fontFamily: f.script === 'latin' ? f.displayHeavy : f.bold };
  if (font === 'mono') return { fontFamily: f.mono };
  return storyFontStyle(font);
}

export function TextStoryCanvas({ text, bg, font }: { text: string; bg: string; font: StoryFont }) {
  const fontStyle = useStoryFont(font);
  return (
    <View style={[styles.canvas, { backgroundColor: bg }]}>
      <Grain tone="light" opacity={0.09} />
      <Text style={[styles.text, fontStyle, { fontSize: textStoryFontSize(text), lineHeight: textStoryFontSize(text) * 1.25 }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  text: { color: '#FFFFFF', textAlign: 'center' },
});
