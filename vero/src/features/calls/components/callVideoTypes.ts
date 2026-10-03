import type { StyleProp, ViewStyle } from 'react-native';
import type { StreamLike } from '../mediaTypes';

export interface CallVideoViewProps {
  stream: StreamLike | null;
  /** Mirror the local front camera preview. */
  mirror?: boolean;
  /** 'contain' for shared screens (nothing cropped), 'cover' for faces. */
  objectFit?: 'cover' | 'contain';
  /** Native: stacking of overlapping video surfaces (picture-in-picture = 1). */
  zOrder?: number;
  style?: StyleProp<ViewStyle>;
}

/** Changes whenever the stream's video track changes, so views re-attach. Empty = no video. */
export function videoTrackKey(stream: StreamLike | null): string {
  if (!stream) return '';
  return stream
    .getVideoTracks()
    .filter((t) => t.readyState !== 'ended')
    .map((t) => t.id)
    .join(',');
}
