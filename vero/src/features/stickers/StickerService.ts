/**
 * Sticker actions: send (bundled by reference, custom as an encrypted
 * attachment), create a sticker from a photo, save a received sticker.
 */

import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { requireSession } from '../../core/session';
import type { Message } from '../../shared/models/Message';
import { generateUUID } from '../../shared/utils/uuid';
import { useMessagesStore } from '../messages/useMessagesStore';
import { getDecryptedUri, readUriBytes, uploadEncryptedBytes } from './extMedia';
import { StickerItem, useStickerStore } from './useStickerStore';

export const STICKER_SIZE = 512;

type CustomSticker = Extract<StickerItem, { kind: 'custom' }>;

async function persistImage(id: string, uri: string): Promise<string> {
  if (Platform.OS === 'web') {
    if (uri.startsWith('data:')) return uri;
    const blob = await (await fetch(uri)).blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read image'));
      reader.readAsDataURL(blob);
    });
  }
  const { Directory, File, Paths } = await import('expo-file-system');
  const dir = new Directory(Paths.document, 'vero-stickers');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const target = new File(dir, `${id}.webp`);
  if (target.exists) target.delete();
  new File(uri).copy(target);
  return target.uri;
}

async function deleteImage(uri: string): Promise<void> {
  if (Platform.OS === 'web' || !uri.startsWith('file:')) return;
  try {
    const { File } = await import('expo-file-system');
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // best effort
  }
}

class StickerService {
  /** Lets the user pick a photo, crops it square and converts it to a 512px WebP sticker. */
  async createFromPhoto(): Promise<CustomSticker | null> {
    const session = requireSession();
    if (Platform.OS !== 'web') {
      const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!granted) throw new Error('Allow photo library access in Settings to make stickers.');
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    });
    const asset = result.canceled ? null : result.assets[0];
    if (!asset) return null;

    const ctx = ImageManipulator.manipulate(asset.uri);
    const side = Math.min(asset.width, asset.height);
    if (asset.width && asset.height && asset.width !== asset.height) {
      ctx.crop({
        originX: Math.floor((asset.width - side) / 2),
        originY: Math.floor((asset.height - side) / 2),
        width: side,
        height: side,
      });
    }
    ctx.resize({ width: STICKER_SIZE, height: STICKER_SIZE });
    const image = await ctx.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.WEBP, compress: 0.8 });

    const id = generateUUID();
    const sticker: CustomSticker = { kind: 'custom', id, uri: await persistImage(id, saved.uri) };
    useStickerStore.getState().addCustom(session.userId, sticker);
    return sticker;
  }

  /** Copies a received sticker into "My stickers". */
  async saveReceived(message: Message): Promise<CustomSticker | null> {
    if (message.messageType !== 'sticker' || !message.media) return null;
    const session = requireSession();
    const uri = await getDecryptedUri(message.media);
    const id = generateUUID();
    const sticker: CustomSticker = {
      kind: 'custom',
      id,
      uri: await persistImage(id, uri),
      emoji: message.ext?.t === 'sticker' ? message.ext.emoji : undefined,
    };
    useStickerStore.getState().addCustom(session.userId, sticker);
    return sticker;
  }

  async removeCustom(sticker: CustomSticker): Promise<void> {
    useStickerStore.getState().removeCustom(requireSession().userId, sticker.id);
    await deleteImage(sticker.uri);
  }

  async send(conversationId: string, item: StickerItem, replyTo?: Message | null): Promise<void> {
    const session = requireSession();
    const send = useMessagesStore.getState().send;
    if (item.kind === 'bundled') {
      await send(conversationId, { t: 'sticker', ref: { pack: item.pack, id: item.id }, emoji: item.emoji }, { replyTo });
    } else {
      if (session.isDemo) throw new Error('Custom stickers need a real account so they can be encrypted and uploaded.');
      const bytes = await readUriBytes(item.uri);
      const media = await uploadEncryptedBytes(bytes, conversationId, {
        mimeType: 'image/webp',
        width: STICKER_SIZE,
        height: STICKER_SIZE,
      });
      await send(conversationId, { t: 'sticker', media, emoji: item.emoji }, { mediaId: media.mediaId, localUri: item.uri, replyTo });
    }
    useStickerStore.getState().addRecent(session.userId, item);
  }
}

export const stickerService = new StickerService();
