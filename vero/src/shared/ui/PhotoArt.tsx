import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

// Drawn stand-ins for encrypted photos that haven't been decrypted on this device yet.

export const SCENES = [
  { bg: '#2B3B44', sky: '#3C4C52', sun: '#E7BD72', cx: 228, hill: '#1F4E40', front: '#132B24' },
  { bg: '#3A3542', sky: '#463F4E', sun: '#D6A657', cx: 90, hill: '#5C4A6B', front: '#2E2536' },
  { bg: '#43302A', sky: '#55392F', sun: '#E7BD72', cx: 160, hill: '#7D4B3B', front: '#3A231C' },
  { bg: '#24303A', sky: '#2E3D49', sun: '#86C09F', cx: 260, hill: '#3F5A73', front: '#1A2631' },
  { bg: '#2E2E22', sky: '#3A3A2B', sun: '#D6A657', cx: 70, hill: '#5E6B3A', front: '#25291A' },
  { bg: '#1F2A24', sky: '#27352E', sun: '#EDE7D9', cx: 200, hill: '#2A6352', front: '#143027' },
];

export function sceneFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 33 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % SCENES.length;
}

export function PhotoArt({
  scene = 0,
  width,
  height,
  style,
  city = true,
}: {
  scene?: number;
  width: number | string;
  height: number | string;
  style?: StyleProp<ViewStyle>;
  city?: boolean;
}) {
  const s = SCENES[scene % SCENES.length];
  return (
    <Svg width={width as any} height={height as any} viewBox="0 0 320 210" preserveAspectRatio="xMidYMid slice" style={style as any}>
      <Rect width={320} height={210} fill={s.bg} />
      <Rect width={320} height={70} fill={s.sky} />
      <Circle cx={s.cx} cy={96} r={44} fill={s.sun} opacity={0.14} />
      <Circle cx={s.cx} cy={96} r={30} fill={s.sun} />
      <Path d="M0 150 L40 112 L72 132 L118 84 L160 126 L196 104 L240 140 L282 110 L320 132 L320 210 L0 210Z" fill={s.hill} />
      <Path d="M0 176 L52 150 L110 170 L170 142 L236 172 L292 156 L320 166 L320 210 L0 210Z" fill={s.front} />
      {city && (
        <>
          <Rect x={22} y={160} width={14} height={50} fill="#0C0E0D" />
          <Rect x={40} y={148} width={22} height={62} fill="#0C0E0D" />
          <Rect x={250} y={164} width={18} height={46} fill="#0C0E0D" />
          <Rect x={272} y={152} width={12} height={58} fill="#0C0E0D" />
        </>
      )}
    </Svg>
  );
}
