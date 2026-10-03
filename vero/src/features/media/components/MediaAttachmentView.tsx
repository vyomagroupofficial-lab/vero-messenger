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
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { friendlyError } from '../../../core/network/supabase';
import { Colors, BorderRadius, Spacing, Typography } from '../../../shared/theme/theme';
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
}

function ProgressBadge({ progress, label }: { progress: number; label?: string }) {
  return (
    <View style={styles.badge}>
      <ActivityIndicator size="small" color={Colors.white} />
      <Text style={styles.badgeText}>{label ?? `${Math.round(progress * 100)}%`}</Text>
    </View>
  );
}

function VisualAttachment({ type, media, caption }: Props) {
  const isImage = type === 'image';
  const auto = isImage && media.size <= AUTO_DOWNLOAD_MAX_BYTES;
  const { uri, loading, progress, error, load } = useDecryptedMedia(media, auto);
  const size = bubbleSize(media.width, media.height);

  const open = async () => {
    const file = uri ?? (await load());
    if (!file) return;
    router.push({ pathname: '/media-viewer', params: { uri: file, type, caption: caption ?? '' } });
  };

  const showFull = isImage && !!uri;
  return (
    <Pressable onPress={open} style={styles.visual} accessibilityLabel={isImage ? 'Photo' : 'Video'}>
      <View style={[styles.frame, size]}>
        {showFull ? (
          <Image source={{ uri: uri! }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : media.thumb ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${media.thumb}` }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            blurRadius={uri ? 0 : 12}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.placeholder]}>
            <Ionicons name={isImage ? 'image' : 'videocam'} size={34} color={Colors.accent} />
          </View>
        )}

        {!showFull && (
          <View style={styles.center}>
            {loading ? (
              <ProgressBadge progress={progress} />
            ) : error ? (
              <View style={styles.badge}>
                <Ionicons name="alert-circle-outline" size={18} color={Colors.white} />
                <Text style={styles.badgeText}>Tap to retry</Text>
              </View>
            ) : !isImage ? (
              <View style={styles.play}>
                <Ionicons name={uri ? 'play' : 'arrow-down'} size={24} color={Colors.white} />
              </View>
            ) : (
              <View style={styles.badge}>
                <Ionicons name="arrow-down" size={16} color={Colors.white} />
                <Text style={styles.badgeText}>{formatBytes(media.size)}</Text>
              </View>
            )}
          </View>
        )}

        {!isImage && (
          <View style={styles.corner}>
            <Ionicons name="videocam" size={12} color={Colors.white} />
            <Text style={styles.cornerText}>
              {media.durationMs ? formatDuration(media.durationMs) : ''}
              {media.durationMs ? ' · ' : ''}
              {formatBytes(media.size)}
            </Text>
          </View>
        )}
      </View>
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </Pressable>
  );
}

function DocumentAttachment({ media, caption, isOwn }: Props) {
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const name = media.fileName || caption || 'Document';
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
      Alert.alert('Could not open file', friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable style={styles.doc} onPress={open} accessibilityLabel={`Document ${name}`}>
      <View style={styles.docIcon}>
        {busy ? <ActivityIndicator color={Colors.accent} /> : <Ionicons name="document-text" size={24} color={Colors.accent} />}
      </View>
      <View style={styles.docInfo}>
        <Text style={[styles.docName, isOwn && styles.docNameOwn]} numberOfLines={2}>
          {name}
        </Text>
        <Text style={styles.docMeta}>
          {[ext, formatBytes(media.size), busy ? `${Math.round(progress * 100)}%` : 'tap to open'].filter(Boolean).join(' · ')}
        </Text>
      </View>
    </Pressable>
  );
}

export function MediaAttachmentView(props: Props) {
  return props.type === 'document' ? <DocumentAttachment {...props} /> : <VisualAttachment {...props} />;
}

const styles = StyleSheet.create({
  visual: { marginBottom: 4 },
  frame: {
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholder: { justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.surface },
  center: { justifyContent: 'center', alignItems: 'center' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  badgeText: { color: Colors.white, fontSize: Typography.xs, fontWeight: '600' },
  play: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  corner: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  cornerText: { color: Colors.white, fontSize: 10, fontWeight: '600' },
  caption: { fontSize: Typography.sm, color: Colors.textPrimary, marginTop: 4 },
  doc: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xs, minWidth: 200 },
  docIcon: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.accentSubtle,
    justifyContent: 'center',
    alignItems: 'center',
  },
  docInfo: { flex: 1 },
  docName: { fontSize: Typography.sm, fontWeight: '600', color: Colors.textPrimary },
  docNameOwn: { color: Colors.white },
  docMeta: { fontSize: Typography.xs, color: Colors.textSecondary, marginTop: 2 },
});
