import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { useTheme } from '../../../shared/theme/ThemeProvider';
import { Avatar, Icon } from '../../../shared/ui';

interface Props {
  userId: string;
  name: string;
  size?: number;
  /** 'unseen' = brass ring, 'seen' = quiet ring, 'none' = no stories. */
  state: 'unseen' | 'seen' | 'none';
  muted?: boolean;
  /** Shows a "+" badge (my own ring). */
  showAdd?: boolean;
  /** Background behind the ring, for the gap and badge cutout. */
  cutout?: string;
}

export function StoryRing({ userId, name, size = 60, state, muted, showAdd, cutout }: Props) {
  const { c } = useTheme();
  const bg = cutout ?? c.bg;
  const glow = useSharedValue(1);
  useEffect(() => {
    if (state === 'unseen') glow.value = withRepeat(withSequence(withTiming(0.55, { duration: 1400 }), withTiming(1, { duration: 1400 })), -1);
    else glow.value = 1;
  }, [state]);
  const ringStyle = useAnimatedStyle(() => ({ opacity: glow.value }));
  const ring = state === 'unseen' ? 2.5 : state === 'seen' ? 1.5 : 0;
  const inner = size - (state === 'none' ? 0 : 8);

  return (
    <View style={{ width: size, height: size, opacity: muted ? 0.45 : 1 }}>
      {state !== 'none' && (
        <Animated.View
          style={[
            { position: 'absolute', top: 0, left: 0, width: size, height: size, borderRadius: size / 2, borderWidth: ring, borderColor: state === 'unseen' ? c.accent : c.line3 },
            state === 'unseen' && ringStyle,
          ]}
        />
      )}
      <View style={{ position: 'absolute', left: (size - inner) / 2, top: (size - inner) / 2 }}>
        <Avatar name={name || userId} size={inner} />
      </View>
      {showAdd && (
        <View style={{ position: 'absolute', right: -2, bottom: -2, width: 24, height: 24, borderRadius: 12, backgroundColor: c.accent, borderWidth: 2.5, borderColor: bg, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="plus" size={13} color={c.onAccent} strokeWidth={2.6} />
        </View>
      )}
    </View>
  );
}
