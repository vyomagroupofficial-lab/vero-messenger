/**
 * In-call controls, each wired to the real media (CallService -> LocalMedia):
 * mute, camera on/off, flip camera, speaker/earpiece, screen share, hang up.
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Typography, Spacing, BorderRadius } from '../../../shared/theme/theme';
import { callService, type ActiveCall } from '../CallService';
import { IosScreenSharePicker } from './IosScreenSharePicker';

function ControlButton({
  icon,
  label,
  active,
  disabled,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <View style={styles.item}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: !!active, disabled: !!disabled }}
        style={[styles.btn, active && styles.btnActive, disabled && styles.btnDisabled]}
        onPress={onPress}
        activeOpacity={0.8}
      >
        <Ionicons name={icon} size={22} color={active ? Colors.textInverse : Colors.textPrimary} />
      </TouchableOpacity>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function CallControls({ call }: { call: ActiveCall }) {
  const { local } = call;
  const live = ['calling', 'connecting', 'connected', 'reconnecting'].includes(call.status);

  return (
    <View style={styles.container}>
      <IosScreenSharePicker />
      {!!call.notice && <Text style={styles.notice}>{call.notice}</Text>}
      {live && (
        <View style={styles.row}>
          <ControlButton
            icon={local.micMuted ? 'mic-off' : 'mic'}
            label={local.micMuted ? 'Unmute' : 'Mute'}
            active={local.micMuted}
            onPress={() => callService.toggleMute()}
          />
          <ControlButton
            icon={local.cameraOn ? 'videocam' : 'videocam-off'}
            label={local.cameraOn ? 'Camera off' : 'Camera'}
            active={local.cameraOn}
            onPress={() => void callService.toggleCamera()}
          />
          {local.cameraOn && (
            <ControlButton icon="camera-reverse" label="Flip" onPress={() => void callService.flipCamera()} />
          )}
          {local.speakerToggleSupported && (
            <ControlButton
              icon={local.speakerOn ? 'volume-high' : 'ear'}
              label={local.speakerOn ? 'Speaker' : 'Earpiece'}
              active={local.speakerOn}
              onPress={() => callService.toggleSpeaker()}
            />
          )}
          <ControlButton
            icon="desktop-outline"
            label={local.screenSharing ? 'Stop sharing' : 'Share screen'}
            active={local.screenSharing}
            disabled={!local.canScreenShare}
            onPress={() => void callService.toggleScreenShare()}
          />
        </View>
      )}
      <View style={styles.endWrap}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={call.kind === 'group' ? 'Leave call' : 'End call'}
          style={styles.endBtn}
          onPress={() => void callService.endCall()}
          activeOpacity={0.8}
        >
          <Ionicons name="call" size={30} color={Colors.white} style={styles.endIcon} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: Spacing.lg },
  notice: {
    color: Colors.warning,
    fontSize: Typography.sm,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: Spacing.md,
  },
  item: { alignItems: 'center', width: 64, gap: 4 },
  btn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  btnActive: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  btnDisabled: { opacity: 0.4 },
  label: { color: Colors.textSecondary, fontSize: Typography.xs },
  endWrap: { alignItems: 'center' },
  endBtn: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: Colors.error,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
  },
  endIcon: { transform: [{ rotate: '135deg' }] },
});
