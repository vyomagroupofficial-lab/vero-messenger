import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View, ViewStyle, StyleProp } from 'react-native';
import Svg, { Path, Rect, Circle, Defs, Pattern } from 'react-native-svg';
import { Colors, Fonts } from '../theme/theme';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const CHECK = 'M9 11.5l6 9.5L23.5 8';
const CHECK_LEN = 28;

/** The Vero mark: a brass tile with a V that doubles as a check. */
export function VeroMark({ size = 40, animate = false }: { size?: number; animate?: boolean }) {
  const draw = useRef(new Animated.Value(animate ? CHECK_LEN : 0)).current;

  useEffect(() => {
    if (!animate) return;
    Animated.timing(draw, {
      toValue: 0,
      duration: 800,
      delay: 450,
      easing: Easing.bezier(0.6, 0, 0.2, 1),
      useNativeDriver: false,
    }).start();
  }, [animate]);

  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Rect width={32} height={32} rx={10} fill={Colors.brass} />
      <AnimatedPath
        d={CHECK}
        fill="none"
        stroke={Colors.ink}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={`${CHECK_LEN}`}
        strokeDashoffset={draw as any}
      />
    </Svg>
  );
}

export function Wordmark({ size = 28, color = Colors.cream }: { size?: number; color?: string }) {
  return (
    <Text style={{ fontFamily: Fonts.displayHeavy, fontSize: size, letterSpacing: -size * 0.045, color }}>
      vero
    </Text>
  );
}

// ── Textures ────────────────────────────────────────────────────────────────

// Deterministic speckle tile: reads as film grain without an image asset.
const GRAIN_DOTS = (() => {
  let seed = 11;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  return Array.from({ length: 150 }, () => ({
    x: +(rnd() * 96).toFixed(1),
    y: +(rnd() * 96).toFixed(1),
    r: +(0.35 + rnd() * 0.55).toFixed(2),
    o: +(0.35 + rnd() * 0.65).toFixed(2),
  }));
})();

/** Film grain overlay. Place inside a relatively positioned container. */
export function Grain({ opacity = 0.07, style }: { opacity?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }, style]}>
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern id="vero-grain" width={96} height={96} patternUnits="userSpaceOnUse">
            {GRAIN_DOTS.map((d, i) => (
              <Circle key={i} cx={d.x} cy={d.y} r={d.r} fill={Colors.cream} opacity={d.o} />
            ))}
          </Pattern>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#vero-grain)" />
      </Svg>
    </View>
  );
}

/** Quiet dotted wallpaper used behind conversations. */
export function DotWall({ gap = 22, style }: { gap?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: Colors.wallpaper }, style]}>
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern id="vero-dots" width={gap} height={gap} patternUnits="userSpaceOnUse">
            <Circle cx={gap / 2} cy={gap / 2} r={1} fill="rgba(237,231,217,0.06)" />
          </Pattern>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#vero-dots)" />
      </Svg>
    </View>
  );
}

/** Fine diagonal hatch — used on brand panels and hero cards. */
export function Hatch({ color = 'rgba(237,231,217,0.04)', gap = 14 }: { color?: string; gap?: number }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern id={`vero-hatch-${gap}`} width={gap} height={gap} patternUnits="userSpaceOnUse">
            <Path d={`M0 ${gap}L${gap} 0`} stroke={color} strokeWidth={1} />
          </Pattern>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#vero-hatch-${gap})`} />
      </Svg>
    </View>
  );
}
