/**
 * In-call controls, each wired to the real media (CallService -> LocalMedia):
 * mute, camera on/off, flip camera, speaker/earpiece, screen share, hang up.
 * Drawn for the dark call stage in both themes.
 */

import React from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { Icon, IconName, Pressy, useLayout } from '../../../shared/ui';
import { callService, type ActiveCall } from '../CallService';
import { IosScreenSharePicker } from './IosScreenSharePicker';

export function CallButton({
  icon,
  label,
  active,
  disabled,
  danger,
  big,
  showLabel = true,
  onPress,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  big?: boolean;
  showLabel?: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const s = useStyles();
  const size = big ? 74 : 60;
  return (
    <View style={s.item}>
      <Pressy
        onPress={onPress}
        disabled={disabled}
        scaleTo={0.88}
        accessibilityLabel={label}
        accessibilityState={{ selected: !!active, disabled: !!disabled }}
        hoverStyle={!active && !danger ? { backgroundColor: 'rgba(237,231,217,0.18)' } : undefined}
        style={[
          s.btn,
          { width: danger && !big ? 78 : size, height: size, borderRadius: big ? size / 2 : 22 },
          active && { backgroundColor: c.onStage },
          danger && { backgroundColor: c.dangerFill },
          disabled && { opacity: 0.35 },
        ]}
      >
        <Icon
          name={icon}
          size={big ? 30 : 24}
          color={active ? '#0C0E0D' : danger ? c.onDanger : c.onStage}
          style={icon === 'phone' && danger ? { transform: [{ rotate: '135deg' }] } : undefined}
        />
      </Pressy>
      {showLabel && (
        <Text style={s.label} numberOfLines={1}>
          {label}
        </Text>
      )}
    </View>
  );
}

export function CallControls({ call }: { call: ActiveCall }) {
  const s = useStyles();
  const t = useT();
  const { isWide } = useLayout();
  const { local } = call;
  const live = ['calling', 'connecting', 'connected', 'reconnecting'].includes(call.status);
  const endLabel = call.kind === 'group' ? t('call.leave') : t('call.end');
  const end = () => void callService.endCall();

  const toggles = live ? (
    <>
      <CallButton icon={local.micMuted ? 'micOff' : 'mic'} label={local.micMuted ? t('call.unmute') : t('call.mute')} active={local.micMuted} onPress={() => callService.toggleMute()} />
      <CallButton icon={local.cameraOn ? 'video' : 'videoOff'} label={t('call.camera')} active={local.cameraOn} onPress={() => void callService.toggleCamera()} />
      {local.cameraOn && <CallButton icon="cameraFlip" label={t('call.flip')} onPress={() => void callService.flipCamera()} />}
      {local.speakerToggleSupported && (
        <CallButton icon="speaker" label={local.speakerOn ? t('call.speaker') : t('call.earpiece')} active={local.speakerOn} onPress={() => callService.toggleSpeaker()} />
      )}
      <CallButton
        icon="screen"
        label={local.screenSharing ? t('call.stopSharing') : t('call.shareScreen')}
        active={local.screenSharing}
        disabled={!local.canScreenShare}
        onPress={() => void callService.toggleScreenShare()}
      />
    </>
  ) : null;

  return (
    <View style={s.container}>
      <IosScreenSharePicker />
      {!!call.notice && (
        <Animated.Text entering={FadeIn} style={s.notice}>
          {call.notice}
        </Animated.Text>
      )}
      {isWide ? (
        <View style={s.row}>
          {toggles}
          <CallButton icon="phone" label={endLabel} danger onPress={end} />
        </View>
      ) : (
        <>
          {toggles && <View style={s.grid}>{toggles}</View>}
          <CallButton icon="phone" label={endLabel} big danger showLabel={false} onPress={end} />
        </>
      )}
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  container: { gap: 22, alignItems: 'center', width: '100%' },
  notice: { fontFamily: f.medium, color: '#E7BD72', fontSize: 13, textAlign: 'center' },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 14, width: '100%' },
  item: { alignItems: 'center', gap: 8, minWidth: 64 },
  btn: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(237,231,217,0.1)' },
  label: { fontFamily: f.medium, fontSize: 12, color: c.onStageMuted, maxWidth: 84, textAlign: 'center' },
}));
