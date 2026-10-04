/**
 * Native video surface: react-native-webrtc's RTCView (only in a development
 * build; renders nothing in Expo Go).
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { nativeRTCView } from '../webrtc.native';
import type { CallVideoViewProps } from './callVideoTypes';
import { videoTrackKey } from './callVideoTypes';

export function CallVideoView({ stream, mirror, objectFit = 'cover', zOrder = 0, style }: CallVideoViewProps) {
  const RTCView = nativeRTCView();
  const key = videoTrackKey(stream);
  if (!RTCView || !stream || !key || typeof stream.toURL !== 'function') return null;
  return (
    <View style={[styles.fill, style]} pointerEvents="none">
      <RTCView
        key={key}
        streamURL={stream.toURL()}
        style={StyleSheet.absoluteFill}
        objectFit={objectFit}
        mirror={!!mirror}
        zOrder={zOrder}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden', backgroundColor: '#000' },
});
