import React from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Typography, Spacing, BorderRadius } from '../../../shared/theme/theme';
import type { StreamLike } from '../mediaTypes';
import { CallVideoView } from './CallVideoView';
import { videoTrackKey } from './callVideoTypes';

export interface ParticipantTileProps {
  name: string;
  stream: StreamLike | null;
  /** The participant says their camera / screen is on. */
  videoEnabled: boolean;
  audioMuted: boolean;
  screenSharing?: boolean;
  isLocal?: boolean;
  mirror?: boolean;
  /** Active speaker: highlighted border. */
  active?: boolean;
  speaking?: boolean;
  connection?: 'connecting' | 'connected' | 'interrupted' | 'failed' | 'waiting';
  compact?: boolean;
  zOrder?: number;
  style?: StyleProp<ViewStyle>;
}

const CONNECTION_LABEL: Record<string, string> = {
  waiting: 'Connecting…',
  connecting: 'Connecting…',
  interrupted: 'Reconnecting…',
  failed: "Can't connect",
};

export function ParticipantTile(props: ParticipantTileProps) {
  const { name, stream, videoEnabled, audioMuted, screenSharing, isLocal, mirror, active, speaking, connection, compact, zOrder, style } =
    props;
  const hasVideo = videoEnabled && !!videoTrackKey(stream) && (isLocal || connection === 'connected');
  const initials = name.trim().slice(0, 2).toUpperCase() || '?';
  const label = isLocal ? 'You' : name;
  const status = !isLocal && connection && connection !== 'connected' ? CONNECTION_LABEL[connection] : null;

  return (
    <View style={[styles.tile, active && styles.tileActive, style]}>
      {hasVideo ? (
        <CallVideoView
          stream={stream}
          mirror={mirror}
          objectFit={screenSharing ? 'contain' : 'cover'}
          zOrder={zOrder}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <View style={styles.avatarWrap}>
          <View style={[styles.avatar, compact && styles.avatarCompact, speaking && styles.avatarSpeaking]}>
            <Text style={[styles.avatarText, compact && styles.avatarTextCompact]}>{initials}</Text>
          </View>
        </View>
      )}

      {status && (
        <View style={styles.statusBadge}>
          <Text style={styles.statusText}>{status}</Text>
        </View>
      )}

      <View style={styles.footer}>
        {audioMuted && <Ionicons name="mic-off" size={12} color={Colors.error} />}
        {!videoEnabled && !compact && <Ionicons name="videocam-off" size={12} color={Colors.textSecondary} />}
        {screenSharing && <Ionicons name="desktop-outline" size={12} color={Colors.accentLight} />}
        <Text style={styles.name} numberOfLines={1}>
          {screenSharing ? `${label} · presenting` : label}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    margin: 3,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surfaceElevated,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  tileActive: {
    borderColor: Colors.accent,
  },
  avatarWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#0284C7',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: 'transparent',
  },
  avatarCompact: { width: 40, height: 40, borderRadius: 20, borderWidth: 2 },
  avatarSpeaking: { borderColor: Colors.accentLight },
  avatarText: { color: Colors.white, fontSize: Typography.xl, fontWeight: Typography.bold },
  avatarTextCompact: { fontSize: Typography.sm },
  statusBadge: {
    position: 'absolute',
    top: Spacing.sm,
    alignSelf: 'center',
    backgroundColor: Colors.overlay,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: BorderRadius.full,
  },
  statusText: { color: Colors.textSecondary, fontSize: Typography.xs },
  footer: {
    position: 'absolute',
    left: Spacing.xs,
    right: Spacing.xs,
    bottom: Spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(3, 7, 18, 0.6)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: BorderRadius.sm,
    alignSelf: 'flex-start',
  },
  name: { color: Colors.textPrimary, fontSize: Typography.xs, flexShrink: 1 },
});
