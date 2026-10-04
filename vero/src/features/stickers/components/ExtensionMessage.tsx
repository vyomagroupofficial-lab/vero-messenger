/**
 * Renders sticker / GIF / payment / bot-data messages in the chat list.
 * Hooked into the chat screen's bubble with a single early return.
 */

import React from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import dayjs from 'dayjs';
import { friendlyError } from '../../../core/network/supabase';
import i18n, { useT } from '../../../shared/i18n';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { Icon, Pressy, confirmAction, notify } from '../../../shared/ui';
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
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
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
      confirmAction({ title: t('stickers.sticker'), message: t('stickers.addFavouriteQ'), confirmLabel: t('stickers.addFavourite'), onConfirm: () => useStickerStore.getState().toggleFavourite(session.userId, item) });
    } else if (message.media && !message.isOwn) {
      confirmAction({
        title: t('stickers.sticker'),
        message: t('stickers.saveQ'),
        confirmLabel: t('stickers.save'),
        onConfirm: () =>
          void stickerService
            .saveReceived(message)
            .then(() => notify(t('thread.savedTitle'), t('stickers.saved')))
            .catch((e) => notify(t('stickers.saveFailed'), friendlyError(e))),
      });
    }
  };

  const source = bundled ?? (uri ? { uri } : null);
  return (
    <Pressy onPress={error ? retry : onPress} scaleTo={0.94} accessibilityLabel={message.content || t('stickers.sticker')}>
      {source ? (
        <Image source={source} style={s.sticker} contentFit="contain" />
      ) : (
        <View style={[s.sticker, s.placeholder]}>
          {error ? (
            <>
              <Icon name="info" size={26} color={c.danger} />
              <Text style={s.placeholderText}>{t('thread.tapRetry')}</Text>
            </>
          ) : ref ? (
            <Text style={s.emojiFallback}>{message.ext?.t === 'sticker' ? message.ext.emoji ?? '🙂' : '🙂'}</Text>
          ) : (
            <ActivityIndicator color={c.accent} />
          )}
        </View>
      )}
    </Pressy>
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
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const { uri, error, retry } = useDecryptedUri(message.media);
  const w0 = message.media?.width || 200;
  const h0 = message.media?.height || 200;
  const width = 240;
  const height = Math.round(Math.max(120, Math.min(320, (width * h0) / w0)));
  return (
    <Pressy onPress={error ? retry : undefined} scaleTo={0.98} style={[s.gifBox, { width, height }]} accessibilityLabel="GIF">
      {uri ? (
        message.media?.mimeType === 'video/mp4' ? <GifVideo uri={uri} width={width} height={height} /> : <Image source={{ uri }} style={{ width, height }} contentFit="cover" autoplay />
      ) : error ? (
        <Text style={s.placeholderText}>{t('stickers.gifFailed')}</Text>
      ) : (
        <ActivityIndicator color={c.accent} />
      )}
      <View style={s.gifTag}>
        <Text style={s.gifTagText}>GIF</Text>
      </View>
    </Pressy>
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
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
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
        <View style={s.dataPill}>
          <Icon name="grid" size={13} color={c.muted} />
          <Text style={s.dataText}>{own ? t('stickers.sentMiniApp') : t('stickers.miniAppData')}</Text>
        </View>
      );
  }
  const statusIcon = status === 'read' ? 'checks' : status === 'delivered' ? 'checks' : status === 'sending' ? 'clock' : status === 'failed' ? null : 'check';
  return (
    <Animated.View entering={FadeInDown.springify().damping(17)} style={[s.row, own ? s.rowOwn : s.rowOther]}>
      <Pressable onLongPress={() => onLongPress(message)} onPress={status === 'failed' ? () => onRetry(message) : undefined} delayLongPress={300} style={own ? s.alignEnd : s.alignStart}>
        {!own && showSenderName && message.senderName ? <Text style={s.sender}>{message.senderName}</Text> : null}
        {body}
        <View style={[s.footer, own && { justifyContent: 'flex-end' }]}>
          {status === 'failed' ? <Text style={s.failed}>{t('thread.notSent')}</Text> : null}
          <Text style={s.time}>{dayjs(message.createdAt).format('HH:mm')}</Text>
          {own && statusIcon ? <Icon name={statusIcon} size={14} color={status === 'read' ? c.success : c.faint} /> : null}
        </View>
        {message.reactions?.length ? (
          <View style={[s.reactions, own && { alignSelf: 'flex-end' }]}>
            <Text style={{ fontSize: 13 }}>{message.reactions.map((r) => r.emoji).join(' ')}</Text>
          </View>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  row: { flexDirection: 'row', paddingHorizontal: 14, marginVertical: 4 },
  rowOwn: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  alignEnd: { alignItems: 'flex-end' },
  alignStart: { alignItems: 'flex-start' },
  sender: { fontFamily: f.semibold, color: c.accentText, fontSize: 12.5, marginBottom: 4, marginLeft: 4 },
  sticker: { width: STICKER_DISPLAY_SIZE, height: STICKER_DISPLAY_SIZE },
  placeholder: { alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: c.raised, gap: 4 },
  placeholderText: { fontFamily: f.body, color: c.muted, fontSize: 12, textAlign: 'center', paddingHorizontal: 8 },
  emojiFallback: { fontSize: 72 },
  gifBox: { borderRadius: 20, overflow: 'hidden', backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.line },
  gifTag: { position: 'absolute', left: 8, bottom: 8, backgroundColor: 'rgba(12,14,13,0.6)', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  gifTagText: { fontFamily: f.mono, color: '#EDE7D9', fontSize: 10, letterSpacing: 1 },
  dataPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.raised, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: c.line },
  dataText: { fontFamily: f.medium, color: c.muted, fontSize: 12.5 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4, paddingHorizontal: 4 },
  time: { fontFamily: f.mono, color: c.faint, fontSize: 10.5 },
  failed: { fontFamily: f.medium, color: c.danger, fontSize: 11 },
  reactions: { marginTop: -2, backgroundColor: c.raised, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1, borderColor: c.line },
}));
