/**
 * Web video surface: a muted <video> element (audio plays through the hidden
 * per-participant <audio> elements, see webrtc.web.ts).
 */

import React, { useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import type { CallVideoViewProps } from './callVideoTypes';
import { videoTrackKey } from './callVideoTypes';

export function CallVideoView({ stream, mirror, objectFit = 'cover', style }: CallVideoViewProps) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const key = videoTrackKey(stream);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const media = (stream as unknown as MediaStream | null) ?? null;
    // Re-assign when the video track changes (camera <-> screen) so the element restarts.
    el.srcObject = null;
    el.srcObject = media;
    if (media) void el.play().catch(() => {});
  }, [stream, key]);

  if (!stream || !key) return null;
  return (
    <View style={[styles.fill, style]} pointerEvents="none">
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        style={{
          width: '100%',
          height: '100%',
          objectFit,
          backgroundColor: '#000',
          transform: mirror ? 'scaleX(-1)' : undefined,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden', backgroundColor: '#000' },
});
