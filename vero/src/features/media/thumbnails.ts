/**
 * Tiny previews for images and videos.
 *
 * The preview is a ~48 px JPEG (1-3 KB) that travels INSIDE the encrypted
 * message payload, so recipients can show a blurred placeholder with the right
 * aspect ratio before the real file is downloaded. Re-encoding also means no
 * EXIF data ends up in the preview.
 */

import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { MAX_THUMB_LENGTH } from '../../shared/models/payload';

const THUMB_PX = 48;

export interface Preview {
  thumb?: string;
  width?: number;
  height?: number;
}

function removeQuietly(uri: string | undefined): void {
  if (!uri || Platform.OS === 'web') return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // ignore
  }
}

export async function imagePreview(uri: string, knownWidth?: number, knownHeight?: number): Promise<Preview> {
  try {
    let width = knownWidth;
    let height = knownHeight;
    if (!width || !height) {
      const full = await ImageManipulator.manipulate(uri).renderAsync();
      width = full.width;
      height = full.height;
      full.release?.();
    }
    const landscape = (width ?? 1) >= (height ?? 1);
    const small = await ImageManipulator.manipulate(uri)
      .resize(landscape ? { width: THUMB_PX } : { height: THUMB_PX })
      .renderAsync();
    const saved = await small.saveAsync({ format: SaveFormat.JPEG, compress: 0.6, base64: true });
    small.release?.();
    removeQuietly(saved.uri);
    const thumb = saved.base64 && saved.base64.length <= MAX_THUMB_LENGTH ? saved.base64 : undefined;
    return { thumb, width, height };
  } catch (e) {
    console.warn('[thumbnails] image preview failed:', (e as Error)?.message);
    return { width: knownWidth, height: knownHeight };
  }
}

export async function videoPreview(uri: string, knownWidth?: number, knownHeight?: number): Promise<Preview> {
  if (Platform.OS === 'web') return { width: knownWidth, height: knownHeight };
  let frameUri: string | undefined;
  try {
    const frame = await VideoThumbnails.getThumbnailAsync(uri, { time: 0, quality: 0.7 });
    frameUri = frame.uri;
    const preview = await imagePreview(frame.uri, frame.width, frame.height);
    return {
      thumb: preview.thumb,
      // The frame has the display orientation; the picker's numbers may not.
      width: frame.width || knownWidth,
      height: frame.height || knownHeight,
    };
  } catch (e) {
    console.warn('[thumbnails] video preview failed:', (e as Error)?.message);
    return { width: knownWidth, height: knownHeight };
  } finally {
    removeQuietly(frameUri);
  }
}
