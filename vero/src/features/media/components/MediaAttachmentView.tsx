/**
 * Chat bubble content for encrypted photos, videos and documents.
 *
 * Photos/videos show the sender's tiny encrypted preview, blurred and at the
 * right aspect ratio, until the real file is downloaded and decrypted (small
 * photos automatically, everything else on tap). Videos then open in the
 * media viewer from the decrypted cache; documents open in the system
 * share/open sheet under their real name.
 */

import React from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { friendlyError } from '../../../core/network/supabase';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { Icon, notify } from '../../../shared/ui';
import type { MediaAttachment, MessageType } from '../../../shared/models/Message';
import { AUTO_DOWNLOAD_MAX_BYTES, formatBytes } from '../limits';
import { mediaRepository } from '../MediaRepository';
import { useDecryptedMedia } from '../useDecryptedMedia';
import { formatDuration } from '../waveform';

const MAX_W = 240;
const MAX_H = 300;
const MIN_SIDE = 120;

/** Bubble size for a picture with the given dimensions. */
export function bubbleSize(width?: number, height?: number): { width: number; height: number } {
  if (!width || !height) return { width: MAX_W, height: 180 };
  const ratio = width / height;
  let w = MAX_W;
  let h = w / ratio;
  if (h > MAX_H) {
    h = MAX_H;
    w = h * ratio;
  }
  return { width: Math.max(MIN_SIDE, Math.round(w)), height: Math.max(MIN_SIDE * 0.6, Math.round(h)) };
}

interface Props {
  type: Extract<MessageType, 'image' | 'video' | 'document'>;
  media: MediaAttachment;
  caption?: string;
  isOwn: boolean;
  /** Render the caption under the picture (the chat bubble may render it itself). */
  showCaption?: boolean;
  /** Bubble size multiplier (desktop chats show pictures larger). */
  scale?: number;
  /** Shown in the media viewer's header. */
  viewerName?: string;
  viewerDate?: string;
}

function ProgressBadge({ progress, label }: { progress: number; label?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.badge}>
      <ActivityIndicator size="small" color="#EDE7D9" />
      <Text style={styles.badgeText}>{label ?? `${Math.round(progress * 100)}%`}</Text>
    </View>
  );
}

function VisualAttachment({ type, media, caption, showCaption = true, scale = 1, viewerName, viewerDate, isOwn }: Props) {
  const { c } = useTheme();
  const styles = useStyles();
  const t = useT();
  const isImage = type === 'image';
  const auto = isImage && media.size <= AUTO_DOWNLOAD_MAX_BYTES;
  const { uri, loading, progress, error, load } = useDecryptedMedia(media, auto);
  const base = bubbleSize(media.width, media.height);
  const size = { width: Math.round(base.width * scale), height: Math.round(base.height * scale) };

  const open = async () => {
    const file = uri ?? (await load());
    if (!file) return;
    router.push({ pathname: '/media-viewer', params: { uri: file, type, caption: caption ?? '', name: viewerName ?? '', date: viewerDate ?? '' } });
  };

  const showFull = isImage && !!uri;
  return (
    <Pressable onPress={open} style={styles.visual} accessibilityLabel={isImage ? t('thread.openPhoto') : t('thread.playVideo')}>
      <View style={[styles.frame, size]}>
        {showFull ? (
          <Animated.View entering={FadeIn.duration(260)} style={StyleSheet.absoluteFill}>
            <Image source={{ uri: uri! }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          </Animated.View>
        ) : media.thumb ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${media.thumb}` }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            blurRadius={uri ? 0 : 12}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.placeholder]}>
            <Icon name={isImage ? 'image' : 'video'} size={30} color={c.faint} />
          </View>
        )}

        {!showFull && (
          <View style={styles.center}>
            {loading ? (
              <ProgressBadge progress={progress} />
            ) : error ? (
              <View style={styles.badge}>
                <Icon name="refresh" size={15} color="#EDE7D9" />
                <Text style={styles.badgeText}>{t('thread.tapRetry')}</Text>
              </View>
            ) : !isImage ? (
              <View style={styles.play}>
                <Icon name={uri ? 'play' : 'download'} size={22} color="#0C0E0D" style={uri ? { marginLeft: 3 } : undefined} />
              </View>
            ) : (
              <View style={styles.badge}>
                <Icon name="download" size={15} color="#EDE7D9" />
                <Text style={styles.badgeText}>{formatBytes(media.size)}</Text>
              </View>
            )}
          </View>
        )}

        {!isImage && (
          <View style={styles.corner}>
            <Icon name="video" size={12} color="#EDE7D9" />
            <Text style={styles.cornerText}>
              {media.durationMs ? formatDuration(media.durationMs) : ''}
              {media.durationMs ? ' · ' : ''}
              {formatBytes(media.size)}
            </Text>
          </View>
        )}
      </View>
      {showCaption && caption ? <Text style={[styles.caption, { color: isOwn ? c.onMine : c.text }]}>{caption}</Text> : null}
    </Pressable>
  );
}

function DocumentAttachment({ media, caption, isOwn }: Props) {
  const { c } = useTheme();
  const styles = useStyles();
  const t = useT();
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const name = media.fileName || caption || t('preview.document');
  const ext = name.includes('.') ? name.split('.').pop()!.toUpperCase().slice(0, 5) : '';

  const open = async () => {
    if (busy) return;
    setBusy(true);
    setProgress(0);
    try {
      await mediaRepository.openDocument(media, {
        onProgress: (p, f) => setProgress(p === 'downloading' ? f * 0.8 : p === 'decrypting' ? 0.8 + f * 0.2 : 0),
      });
    } catch (e) {
      notify(t('media.openFailed'), friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable style={styles.doc} onPress={open} accessibilityLabel={t('media.documentA11y', { name })}>
      <View style={[styles.docIcon, isOwn && { backgroundColor: 'rgba(0,0,0,0.2)' }]}>
        {busy ? <ActivityIndicator color={isOwn ? c.onMine : c.accent} /> : <Icon name="file" size={21} color={isOwn ? c.onMine : c.accentText} />}
        {!busy && !!ext && <Text style={[styles.docExt, { color: isOwn ? c.onMine : c.accentText }]}>{ext}</Text>}
      </View>
      <View style={styles.docInfo}>
        <Text style={[styles.docName, { color: isOwn ? c.onMine : c.text }]} numberOfLines={2}>
          {name}
        </Text>
        <Text style={[styles.docMeta, { color: isOwn ? c.mineMeta : c.muted }]}>
          {[formatBytes(media.size), busy ? `${Math.round(progress * 100)}%` : t('media.tapOpen')].filter(Boolean).join(' · ')}
        </Text>
        {busy && (
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${Math.round(progress * 100)}%`, backgroundColor: isOwn ? c.onMine : c.accent }]} />
          </View>
        )}
      </View>
    </Pressable>
  );
}

export function MediaAttachmentView(props: Props) {
  return props.type === 'document' ? <DocumentAttachment {...props} /> : <VisualAttachment {...props} />;
}

const useStyles = makeStyles((c, t, f) => ({
  visual: { marginBottom: 2 },
  frame: { borderRadius: 16, overflow: 'hidden', backgroundColor: c.field, justifyContent: 'center', alignItems: 'center' },
  placeholder: { justifyContent: 'center', alignItems: 'center', backgroundColor: c.field },
  center: { justifyContent: 'center', alignItems: 'center' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 16, backgroundColor: 'rgba(12,14,13,0.62)' },
  badgeText: { fontFamily: f.semibold, color: '#EDE7D9', fontSize: 12 },
  play: { width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(237,231,217,0.92)', justifyContent: 'center', alignItems: 'center' },
  corner: { position: 'absolute', left: 8, bottom: 8, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 9, backgroundColor: 'rgba(12,14,13,0.62)' },
  cornerText: { fontFamily: f.mono, color: '#EDE7D9', fontSize: 10.5 },
  caption: { fontFamily: f.body, fontSize: 15, marginTop: 6, paddingHorizontal: 6 },
  doc: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 2, minWidth: 220 },
  docIcon: { width: 46, height: 52, borderRadius: 12, backgroundColor: c.accentTint2, justifyContent: 'center', alignItems: 'center', gap: 1 },
  docExt: { fontFamily: f.mono, fontSize: 8.5, letterSpacing: 0.4 },
  docInfo: { flex: 1, minWidth: 0 },
  docName: { fontFamily: f.semibold, fontSize: 14 },
  docMeta: { fontFamily: f.body, fontSize: 12, marginTop: 2 },
  track: { height: 3, borderRadius: 2, backgroundColor: c.tint2, marginTop: 6, overflow: 'hidden' },
  fill: { height: 3, borderRadius: 2 },
}));
