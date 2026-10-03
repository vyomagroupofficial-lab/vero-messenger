/**
 * Renders sticker / GIF / payment / bot-data messages in the chat list.
 * Hooked into the chat screen's MessageBubble with a single early return.
 */

import React from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import dayjs from 'dayjs';
import { friendlyError } from '../../../core/network/supabase';
import { Colors } from '../../../shared/theme/theme';
import type { Message, MessageStatus, MessageType } from '../../../shared/models/Message';
import { PaymentCardBubble } from '../../payments/components/PaymentCardBubble';
import { BUNDLED_STICKER_ASSETS } from '../bundledAssets';
import { useDecryptedUri } from '../extMedia';
import { findBundledSticker } from '../packs';
import { stickerService } from '../StickerService';
import { useStickerStore } from '../useStickerStore';
import { requireSession } from '../../../core/session';

export const STICKER_DISPLAY_SIZE = 160;

export function isExtensionMessageType(t: MessageType): boolean {
  return t === 'sticker' || t === 'gif' || t === 'payment' || t === 'bot_data';
}

function StickerContent({ message }: { message: Message }) {
  const ref = message.ext?.t === 'sticker' ? message.ext.ref : undefined;
  const { uri, error, retry } = useDecryptedUri(ref ? undefined : message.media);
  const bundled = ref ? BUNDLED_STICKER_ASSETS[`${ref.pack}/${ref.id}`] : undefined;

  const onPress = () => {
    let session;
    try {
      session = requireSession();
    } catch {
      return;
    }
    if (ref) {
      const def = findBundledSticker(ref);
      if (!def) return;
      const item = { kind: 'bundled' as const, pack: def.pack, id: def.id, emoji: def.emoji };
      if (Platform.OS === 'web') {
        if (globalThis.confirm?.('Add this sticker to favourites?')) useStickerStore.getState().toggleFavourite(session.userId, item);
        return;
      }
      Alert.alert('Sticker', undefined, [
        { text: 'Add to favourites', onPress: () => useStickerStore.getState().toggleFavourite(session.userId, item) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    } else if (message.media && !message.isOwn) {
      const save = () =>
        stickerService
          .saveReceived(message)
          .then(() => Alert.alert('Saved', 'Added to My stickers.'))
          .catch((e) => Alert.alert('Could not save', friendlyError(e)));
      if (Platform.OS === 'web') {
        if (globalThis.confirm?.('Save this sticker to My stickers?')) void save();
        return;
      }
      Alert.alert('Sticker', undefined, [{ text: 'Save to My stickers', onPress: () => void save() }, { text: 'Cancel', style: 'cancel' }]);
    }
  };

  const source = bundled ?? (uri ? { uri } : null);
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={error ? retry : onPress} accessibilityLabel={message.content || 'Sticker'}>
      {source ? (
        <Image source={source} style={styles.sticker} contentFit="contain" />
      ) : (
        <View style={[styles.sticker, styles.placeholder]}>
          {error ? (
            <>
              <Ionicons name="alert-circle-outline" size={28} color={Colors.error} />
              <Text style={styles.placeholderText}>Tap to retry</Text>
            </>
          ) : ref ? (
            <Text style={styles.emojiFallback}>{message.ext?.t === 'sticker' ? message.ext.emoji ?? '🙂' : '🙂'}</Text>
          ) : (
            <ActivityIndicator color={Colors.accent} />
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

function GifVideo({ uri, width, height }: { uri: string; width: number; height: number }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  return <VideoView player={player} style={{ width, height }} nativeControls={false} contentFit="cover" />;
}

function GifContent({ message }: { message: Message }) {
  const { uri, error, retry } = useDecryptedUri(message.media);
  const w0 = message.media?.width || 200;
  const h0 = message.media?.height || 200;
  const width = 220;
  const height = Math.round(Math.max(110, Math.min(300, (width * h0) / w0)));
  return (
    <TouchableOpacity activeOpacity={0.9} onPress={error ? retry : undefined} style={[styles.gifBox, { width, height }]}>
      {uri ? (
        message.media?.mimeType === 'video/mp4' ? (
          <GifVideo uri={uri} width={width} height={height} />
        ) : (
          <Image source={{ uri }} style={{ width, height }} contentFit="cover" autoplay />
        )
      ) : error ? (
        <Text style={styles.placeholderText}>Couldn’t load GIF · tap to retry</Text>
      ) : (
        <ActivityIndicator color={Colors.accent} />
      )}
      <View style={styles.gifTag}>
        <Text style={styles.gifTagText}>GIF</Text>
      </View>
    </TouchableOpacity>
  );
}

export function ExtensionMessage({
  message,
  status,
  onLongPress,
  onRetry,
  showSenderName,
}: {
  message: Message;
  status: MessageStatus;
  showSenderName?: boolean;
  onLongPress: (m: Message) => void;
  onRetry: (m: Message) => void;
}) {
  const own = message.isOwn;
  let body: React.ReactNode;
  switch (message.messageType) {
    case 'sticker':
      body = <StickerContent message={message} />;
      break;
    case 'gif':
      body = <GifContent message={message} />;
      break;
    case 'payment':
      body = <PaymentCardBubble message={message} />;
      break;
    default:
      body = (
        <View style={styles.dataPill}>
          <Ionicons name="apps-outline" size={13} color={Colors.textSecondary} />
          <Text style={styles.dataText}>{own ? 'Sent data from the mini-app' : 'Mini-app data'}</Text>
        </View>
      );
  }
  return (
    <View style={[styles.row, own ? styles.rowOwn : styles.rowOther]}>
      <Pressable
        onLongPress={() => onLongPress(message)}
        onPress={status === 'failed' ? () => onRetry(message) : undefined}
        delayLongPress={300}
        style={own ? styles.alignEnd : styles.alignStart}
      >
        {!own && showSenderName && message.senderName ? <Text style={styles.sender}>{message.senderName}</Text> : null}
        {body}
        <View style={styles.footer}>
          {status === 'failed' ? <Text style={styles.failed}>Not sent · tap to retry</Text> : null}
          <Text style={styles.time}>
            {dayjs(message.createdAt).format('HH:mm')}
            {own ? (status === 'sending' ? ' · sending' : status === 'read' ? ' · read' : '') : ''}
          </Text>
        </View>
        {message.reactions?.length ? (
          <Text style={styles.reactions}>{message.reactions.map((r) => r.emoji).join(' ')}</Text>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingHorizontal: 12, marginVertical: 4 },
  rowOwn: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start', paddingLeft: 48 },
  alignEnd: { alignItems: 'flex-end' },
  alignStart: { alignItems: 'flex-start' },
  sender: { color: Colors.accent, fontSize: 12, marginBottom: 2 },
  sticker: { width: STICKER_DISPLAY_SIZE, height: STICKER_DISPLAY_SIZE },
  placeholder: { alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: Colors.surface },
  placeholderText: { color: Colors.textTertiary, fontSize: 12, marginTop: 4, textAlign: 'center' },
  emojiFallback: { fontSize: 72 },
  gifBox: { borderRadius: 14, overflow: 'hidden', backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  gifTag: { position: 'absolute', left: 6, bottom: 6, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 6, paddingHorizontal: 5 },
  gifTagText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  dataPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  dataText: { color: Colors.textSecondary, fontSize: 12 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  time: { color: Colors.textTertiary, fontSize: 10 },
  failed: { color: Colors.error, fontSize: 10 },
  reactions: { fontSize: 13, marginTop: 2 },
});
