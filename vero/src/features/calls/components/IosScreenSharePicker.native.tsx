/**
 * iOS only: the (invisible) system broadcast picker that starts the Broadcast
 * Upload Extension when the user shares their screen. Rendered only when the
 * build declares an extension (see webrtc.native.ts screenShareSupport()).
 */

import React, { useEffect, useRef } from 'react';
import { findNodeHandle, Platform, StyleSheet } from 'react-native';
import { mediaAdapter, nativeScreenCapturePickerView } from '../webrtc.native';
import { registerIosScreenSharePicker } from '../screenSharePicker';

export function IosScreenSharePicker() {
  const ref = useRef<any>(null);
  const enabled = Platform.OS === 'ios' && mediaAdapter.screenShareSupport().supported;
  const Picker = enabled ? nativeScreenCapturePickerView() : null;

  useEffect(() => {
    if (!Picker) return;
    registerIosScreenSharePicker(findNodeHandle(ref.current));
    return () => registerIosScreenSharePicker(null);
  }, [Picker]);

  if (!Picker) return null;
  return <Picker ref={ref} style={styles.hidden} />;
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0, left: -10, top: -10 },
});
