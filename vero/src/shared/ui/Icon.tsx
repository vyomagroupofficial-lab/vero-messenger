import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

// Line icons drawn on a 24px grid, 1.75 stroke, round caps — one family across the app.

const c = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const rr = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;

const PHONE = 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2';
const BUBBLE = 'M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z';
const LOCK = [rr(5, 11, 14, 10, 2), 'M8 11V8a4 4 0 0 1 8 0v3'];
const SHIELD = 'M12 3 4.5 6v6c0 4.5 3.2 8 7.5 9 4.3-1 7.5-4.5 7.5-9V6z';

const ICONS = {
  chat: [BUBBLE],
  chatPlus: [BUBBLE, 'M12 8v6M9 11h6'],
  phone: [PHONE],
  phonePlus: [PHONE, 'M16 3v6M13 6h6'],
  video: [rr(3, 6, 13, 12, 2), 'm16 10 5-3v10l-5-3'],
  videoOff: [rr(3, 6, 13, 12, 2), 'm16 10 5-3v10l-5-3', 'M2 2l20 20'],
  users: [c(9, 8, 3.5), 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5'],
  userPlus: [c(9, 8, 3.5), 'M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6'],
  user: [c(12, 8, 4), 'M4 21a8 8 0 0 1 16 0'],
  sliders: ['M4 7h10M18 7h2M4 17h4M12 17h8', c(16, 7, 2), c(10, 17, 2)],
  lock: LOCK,
  shield: [SHIELD],
  shieldCheck: [SHIELD, 'm9 12 2 2 4-4'],
  search: [c(11, 11, 7), 'm20 20-3.5-3.5'],
  plus: ['M12 5v14M5 12h14'],
  send: ['M4 12 20 4l-6 16-3-7z', 'm11 13 4.5-4.5'],
  clip: ['M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7'],
  mic: [rr(9, 3, 6, 11, 3), 'M5 11a7 7 0 0 0 14 0M12 18v3'],
  micOff: ['M15 9.5V6a3 3 0 0 0-5.8-1M9 9v2a3 3 0 0 0 4.7 2.5M5 11a7 7 0 0 0 11 5.7M19 11a7 7 0 0 1-.5 2.5M12 18v3M3 3l18 18'],
  smile: [c(12, 12, 9), 'M8.5 14.5a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01'],
  more: ['M5 12h.01M12 12h.01M19 12h.01'],
  check: ['m5 12 5 5 9-10'],
  checks: ['M2 13l4 4 9-10M10 16l1 1 9-10'],
  clock: [c(12, 12, 9), 'M12 7v5l3 2'],
  back: ['m15 5-7 7 7 7'],
  forwardChevron: ['m9 5 7 7-7 7'],
  down: ['m6 9 6 6 6-6'],
  arrowRight: ['M5 12h14M13 6l6 6-6 6'],
  camera: ['M4 8h3l2-3h6l2 3h3v11H4z', c(12, 13, 3.5)],
  cameraFlip: ['M4 8h3l2-3h6l2 3h3v11H4z', 'M9 12.5a3 3 0 0 1 5.2-2M15 13.5a3 3 0 0 1-5.2 2M14.5 9v1.6h-1.6M9.5 17v-1.6h1.6'],
  pin: ['M12 17v4M8 3h8l-1 6 3 3v2H6v-2l3-3z'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 21h4'],
  bellOff: ['M6 16V11a6 6 0 0 1 9-5.2M18 11v5l2 2H8M10 21h4M3 3l18 18'],
  arrowIn: ['M17 7 7 17M7 9v8h8'],
  arrowOut: ['M7 17 17 7M9 7h8v8'],
  key: [c(8, 15, 4), 'm11 12 9-9M16 7l3 3M14 9l2 2'],
  devices: [rr(3, 4, 13, 10, 1.5), 'M7 18h5', rr(16, 9, 5, 11, 1.5)],
  laptop: [rr(3, 4, 18, 12, 1.5), 'M2 20h20'],
  smartphone: [rr(7, 2, 10, 20, 2), 'M11 18h2'],
  cloud: ['M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 8a4.5 4.5 0 0 1 0 10z'],
  cloudUp: ['M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 8a4.5 4.5 0 0 1 0 10z', 'M12 15v-5M9.5 12.5 12 10l2.5 2.5'],
  timer: [c(12, 13, 8), 'M12 9v4l2.5 2.5M9 2h6'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', c(12, 12, 3)],
  eyeOff: ['M2 12s3.5-7 10-7c2 0 3.7.6 5.1 1.5M22 12s-3.5 7-10 7c-2 0-3.7-.6-5.1-1.5', 'M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18'],
  logout: ['M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10'],
  close: ['M6 6l12 12M18 6 6 18'],
  download: ['M12 4v11M7 10l5 5 5-5M5 20h14'],
  share: ['M12 15V4M8 8l4-4 4 4M5 13v7h14v-7'],
  image: [rr(3, 4, 18, 16, 2), c(9, 10, 2), 'm21 16-5-5-9 9'],
  file: ['M14 3H6v18h12V7z', 'M14 3v4h4M9 13h6M9 17h4'],
  qr: [rr(4, 4, 6, 6, 0.5), rr(14, 4, 6, 6, 0.5), rr(4, 14, 6, 6, 0.5), 'M14 14h2v2M18 14h2M14 18v2h2M18 18h2v2'],
  scan: ['M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3M4 12h16'],
  reply: ['M9 7 4 12l5 5', 'M4 12h10a6 6 0 0 1 6 6v1'],
  forward: ['m15 7 5 5-5 5', 'M20 12H10a6 6 0 0 0-6 6v1'],
  mail: [rr(3, 5, 18, 14, 2), 'm3 7 9 6 9-6'],
  at: [c(12, 12, 4), 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8'],
  speaker: ['M4 9v6h4l5 4V5L8 9z', 'M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11'],
  globe: [c(12, 12, 9), 'M3 12h18', 'M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z'],
  moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  archive: [rr(3, 4, 18, 5, 1.5), 'M5 9v10h14V9M10 13h4'],
  trash: ['M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'],
  copy: [rr(8, 8, 12, 12, 2), 'M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3'],
  flag: ['M5 21V4h11l-1.5 4L16 12H5'],
  ban: [c(12, 12, 9), 'm5.6 5.6 12.8 12.8'],
  screen: [rr(3, 4, 18, 13, 2), 'M8 21h8M12 17v4M12 13V8M9.5 10.5 12 8l2.5 2.5'],
  help: [c(12, 12, 9), 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6M12 17h.01'],
  database: ['M4 7c0-2 3.6-3 8-3s8 1 8 3-3.6 3-8 3-8-1-8-3z', 'M4 7v10c0 2 3.6 3 8 3s8-1 8-3V7M4 12c0 2 3.6 3 8 3s8-1 8-3'],
  info: [c(12, 12, 9), 'M12 11v6M12 7.5h.01'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'm13.5 6.5 4 4'],
  heart: ['M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'],
  grid: [rr(4, 4, 7, 7, 1.5), rr(13, 4, 7, 7, 1.5), rr(4, 13, 7, 7, 1.5), rr(13, 13, 7, 7, 1.5)],
} as const;

const FILLED = {
  play: 'M7 4.5v15l12-7.5z',
  pause: `${rr(6, 5, 4, 14, 1)}${rr(14, 5, 4, 14, 1)}`,
  heartFilled: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
} as const;

export type IconName = keyof typeof ICONS | keyof typeof FILLED;

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: StyleProp<ViewStyle>;
}

export function Icon({ name, size = 22, color = '#EDE7D9', strokeWidth = 1.75, style }: IconProps) {
  if (name in FILLED) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" style={style as any}>
        <Path d={FILLED[name as keyof typeof FILLED]} fill={color} />
      </Svg>
    );
  }
  const paths = ICONS[name as keyof typeof ICONS];
  const sw = name === 'more' ? 3 : strokeWidth;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={style as any}>
      {paths.map((d, i) => (
        <Path
          key={i}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}
