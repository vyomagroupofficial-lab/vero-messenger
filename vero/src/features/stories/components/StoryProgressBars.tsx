import React from 'react';
import { StyleSheet, View } from 'react-native';

/** One segment per story in the current group; `progress(i)` is 0..1. Always on a dark stage. */
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
  track: { flex: 1, height: 3, borderRadius: 2, backgroundColor: 'rgba(237,231,217,0.28)', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 2, backgroundColor: '#EDE7D9' },
});
