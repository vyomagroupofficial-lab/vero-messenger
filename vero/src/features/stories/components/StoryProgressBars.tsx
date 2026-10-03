import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Colors } from '../../../shared/theme/theme';

/** One segment per story in the current group; `progress(i)` is 0..1. */
export function StoryProgressBars({ count, progress }: { count: number; progress: (i: number) => number }) {
  return (
    <View style={styles.row}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.track}>
          <View style={[styles.fill, { width: `${Math.round(progress(i) * 1000) / 10}%` }]} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 4 },
  track: { flex: 1, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: Colors.white },
});
