import React from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { Avatar, Icon } from '../../../shared/ui';
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

const CONNECTION_KEY: Record<string, string> = {
  waiting: 'call.connecting',
  connecting: 'call.connecting',
  interrupted: 'call.reconnecting',
  failed: 'call.cantConnect',
};

/** One person in a call: their video, or their avatar on the dark stage. Stays dark in both themes. */
export function ParticipantTile(props: ParticipantTileProps) {
  const { name, stream, videoEnabled, audioMuted, screenSharing, isLocal, mirror, active, speaking, connection, compact, zOrder, style } = props;
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const hasVideo = videoEnabled && !!videoTrackKey(stream) && (isLocal || connection === 'connected');
  const label = isLocal ? t('common.you') : name;
  const status = !isLocal && connection && connection !== 'connected' ? t(CONNECTION_KEY[connection]) : null;
  const size = compact ? 44 : 84;

  return (
    <View style={[s.tile, active && s.tileActive, style]}>
      {hasVideo ? (
        <CallVideoView stream={stream} mirror={mirror} objectFit={screenSharing ? 'contain' : 'cover'} zOrder={zOrder} style={StyleSheet.absoluteFill} />
      ) : (
        <View style={s.avatarWrap}>
          <View style={[s.ring, { width: size + 10, height: size + 10, borderRadius: (size + 10) / 2 }, speaking && { borderColor: c.success }]}>
            <Avatar name={isLocal ? name || label : name} size={size} />
          </View>
        </View>
      )}
      {status && (
        <View style={s.statusBadge}>
          <Text style={s.statusText}>{status}</Text>
        </View>
      )}
      <View style={s.footer}>
        {audioMuted && <Icon name="micOff" size={12} color="#E5A08A" />}
        {!videoEnabled && !compact && <Icon name="videoOff" size={12} color={c.onStageMuted} />}
        {screenSharing && <Icon name="screen" size={12} color="#E7BD72" />}
        <Text style={s.name} numberOfLines={1}>
          {screenSharing ? t('call.presenting', { name: label }) : label}
        </Text>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  tile: { flex: 1, margin: 4, borderRadius: 22, backgroundColor: '#1A1D1B', overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  tileActive: { borderColor: '#D6A657' },
  avatarWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  ring: { alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  statusBadge: { position: 'absolute', top: 10, alignSelf: 'center', backgroundColor: 'rgba(12,14,13,0.62)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  statusText: { fontFamily: f.medium, color: c.onStageMuted, fontSize: 11.5 },
  footer: { position: 'absolute', left: 8, bottom: 8, maxWidth: '90%', flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(12,14,13,0.62)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10 },
  name: { fontFamily: f.medium, color: c.onStage, fontSize: 12, flexShrink: 1 },
}));
