import React from 'react';
import {Easing, interpolate, spring, useVideoConfig} from 'remotion';
import {FPS, FRAMES_PER_BEAT} from '../timing';
import {C} from '../theme';
import {DISPLAY, MONO, UI} from '../fonts';

/** Spike at beat `at` that decays exponentially (0 before it). */
export const hit = (beat: number, at: number, decay = 5) => (beat < at ? 0 : Math.exp(-(beat - at) * decay));

/** Spring that starts on beat `at`. */
export const springAt = (beat: number, at: number, cfg: {damping?: number; stiffness?: number; mass?: number} = {}) =>
  beat < at
    ? 0
    : spring({
        frame: (beat - at) * FRAMES_PER_BEAT,
        fps: FPS,
        config: {damping: 14, stiffness: 160, mass: 0.7, ...cfg},
      });

/** 0→1 eased ramp from beat `a` to beat `b`. */
export const ramp = (beat: number, a: number, b: number, ease = Easing.out(Easing.cubic)) =>
  interpolate(beat, [a, b], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease});

/** Whether the beat is inside [a, b). */
export const within = (beat: number, a: number, b: number) => beat >= a && beat < b;

export const useLayout = () => {
  const {width, height} = useVideoConfig();
  const vertical = height > width;
  return {width, height, vertical, u: Math.min(width, height) / 1080};
};

/** Small mono caption chip, e.g. "X25519 · XSALSA20". */
export const Tag: React.FC<{text: string; color?: string; icon?: React.ReactNode; size?: number; style?: React.CSSProperties}> = ({
  text,
  color = C.accentLight,
  icon,
  size = 22,
  style,
}) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: size * 0.5,
      padding: `${size * 0.45}px ${size * 0.9}px`,
      borderRadius: 999,
      border: `1.5px solid ${color}66`,
      background: `${color}14`,
      color,
      fontFamily: MONO,
      fontWeight: 700,
      fontSize: size,
      letterSpacing: size * 0.08,
      whiteSpace: 'nowrap',
      ...style,
    }}
  >
    {icon}
    {text}
  </div>
);

/** A word that slams in on `at` (scale-down from big + blur clearing). */
export const Slam: React.FC<{
  beat: number;
  at: number;
  children: React.ReactNode;
  from?: number;
  style?: React.CSSProperties;
}> = ({beat, at, children, from = 2.2, style}) => {
  if (beat < at) return null;
  const s = springAt(beat, at, {damping: 13, stiffness: 260, mass: 0.6});
  const scale = interpolate(s, [0, 1], [from, 1]);
  const blur = interpolate(s, [0, 0.6], [16, 0], {extrapolateRight: 'clamp'});
  return (
    <div style={{transform: `scale(${scale})`, filter: blur > 0.3 ? `blur(${blur}px)` : undefined, opacity: Math.min(1, s * 3), ...style}}>
      {children}
    </div>
  );
};

/** Title in the Anton display face. */
export const Title: React.FC<{size: number; color?: string; children: React.ReactNode; style?: React.CSSProperties; glow?: string}> = ({
  size,
  color = C.white,
  children,
  style,
  glow,
}) => (
  <div
    style={{
      fontFamily: DISPLAY,
      fontSize: size,
      lineHeight: 0.92,
      color,
      textTransform: 'uppercase',
      letterSpacing: '0.01em',
      textShadow: glow ? `0 0 ${size * 0.35}px ${glow}` : undefined,
      whiteSpace: 'pre',
      ...style,
    }}
  >
    {children}
  </div>
);

export const Sub: React.FC<{size: number; children: React.ReactNode; style?: React.CSSProperties; color?: string}> = ({
  size,
  children,
  style,
  color = C.text2,
}) => <div style={{fontFamily: UI, fontWeight: 500, fontSize: size, color, letterSpacing: '0.01em', ...style}}>{children}</div>;

const HEX = '0123456789abcdef';
/** Deterministic pseudo-ciphertext. */
export const cipher = (len: number, seed: number) => {
  let s = '';
  let x = seed * 9301 + 49297;
  for (let i = 0; i < len; i++) {
    x = (x * 9301 + 49297) % 233280;
    s += HEX[Math.floor((x / 233280) * 16)];
  }
  return s;
};
