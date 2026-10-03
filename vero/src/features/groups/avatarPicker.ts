/**
 * Picks a photo and shrinks it to a small square JPEG data URI suitable for a
 * group / channel / community avatar.
 *
 * Trade-off (documented in the README): these avatars are server-visible
 * metadata like group names - stored inline (<= ~96 KB) in the group's row
 * and shown to members and to anyone holding an invite link. They are NOT
 * end-to-end encrypted. Profile photos and attachments are unaffected.
 */

import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

const SIZE = 256;
const MAX_DATA_URI = 131072;

export async function pickAvatarDataUri(): Promise<string | null> {
  const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!granted) throw new Error('Allow photo library access in Settings to choose a photo.');
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });
  if (result.canceled || !result.assets?.[0]) return null;

  for (const compress of [0.7, 0.5, 0.3]) {
    const ref = await ImageManipulator.manipulate(result.assets[0].uri).resize({ width: SIZE, height: SIZE }).renderAsync();
    const saved = await ref.saveAsync({ compress, format: SaveFormat.JPEG, base64: true });
    if (!saved.base64) break;
    const uri = `data:image/jpeg;base64,${saved.base64.replace(/\s+/g, '')}`;
    if (uri.length <= MAX_DATA_URI) return uri;
  }
  throw new Error("That photo couldn't be made small enough. Try another one.");
}
