import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { qrMatrix, qrPath } from './qrMatrix';

const MARGIN = 4;

/** Dark-on-white QR code (scanners need the contrast, whatever the app theme). */
export function QrCodeView({ value, size = 240 }: { value: string; size?: number }) {
  const { path, dim } = useMemo(() => {
    const m = qrMatrix(value);
    return { path: qrPath(m, MARGIN), dim: m.size + MARGIN * 2 };
  }, [value]);

  return (
    <View style={[styles.frame, { width: size, height: size }]} accessibilityRole="image" accessibilityLabel="QR code">
      <Svg width={size} height={size} viewBox={`0 0 ${dim} ${dim}`}>
        <Rect x={0} y={0} width={dim} height={dim} fill="#FFFFFF" />
        <Path d={path} fill="#000000" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
  },
});
