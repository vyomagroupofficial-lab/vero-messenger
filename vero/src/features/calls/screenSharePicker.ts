/**
 * iOS screen sharing: react-native-webrtc's getDisplayMedia() waits for a
 * Broadcast Upload Extension to start streaming. The system broadcast picker
 * (RPSystemBroadcastPickerView) is a native view, rendered invisibly by
 * <IosScreenSharePicker/>, which registers its node handle here so the media
 * adapter can open it. Elsewhere this is a no-op.
 */

import { NativeModules } from 'react-native';

let pickerHandle: number | null = null;

export function registerIosScreenSharePicker(handle: number | null): void {
  pickerHandle = handle;
}

export function showIosScreenSharePicker(): boolean {
  const manager = (NativeModules as any).ScreenCapturePickerViewManager;
  if (pickerHandle == null || typeof manager?.show !== 'function') return false;
  manager.show(pickerHandle);
  return true;
}
