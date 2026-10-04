import React from 'react';
import {AbsoluteFill, Img, random, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../theme';
import {DISPLAY} from '../fonts';

/** Random camera shake. `amount` 0..1, usually driven by a beat pulse. */
export const Shake: React.FC<{amount: number; px?: number; rot?: number; children: React.ReactNode}> = ({
  amount,
  px = 26,
  rot = 1.2,
  children,
}) => {
  const frame = useCurrentFrame();
  const x = (random(`sx${frame}`) - 0.5) * 2 * px * amount;
  const y = (random(`sy${frame}`) - 0.5) * 2 * px * amount;
  const r = (random(`sr${frame}`) - 0.5) * 2 * rot * amount;
  return (
    <AbsoluteFill style={{transform: `translate(${x}px, ${y}px) rotate(${r}deg)`}}>{children}</AbsoluteFill>
  );
};

/** Full-frame flash overlay. */
export const Flash: React.FC<{amount: number; color?: string}> = ({amount, color = '#fff'}) =>
  amount <= 0.01 ? null : (
    <AbsoluteFill style={{background: color, opacity: Math.min(1, amount), mixBlendMode: 'screen', pointerEvents: 'none'}} />
  );

/**
 * Chromatic aberration: renders the children three times (R, G, B) with an
 * offset that follows `amount`.
 */
export const RGBSplit: React.FC<{amount: number; children: React.ReactNode; px?: number}> = ({
  amount,
  children,
  px = 14,
}) => {
  if (amount < 0.02) return <AbsoluteFill>{children}</AbsoluteFill>;
  const d = amount * px;
  const layer = (dx: number, matrix: string) => (
    <AbsoluteFill style={{transform: `translateX(${dx}px)`, mixBlendMode: 'screen'}}>
      <AbsoluteFill style={{filter: `url(#${matrix})`}}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
  return (
    <AbsoluteFill style={{isolation: 'isolate', background: 'transparent'}}>
      <svg width="0" height="0" style={{position: 'absolute'}}>
        <filter id="only-r">
          <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" />
        </filter>
        <filter id="only-g">
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" />
        </filter>
        <filter id="only-b">
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" />
        </filter>
      </svg>
      {layer(-d, 'only-r')}
      {layer(0, 'only-g')}
      {layer(d, 'only-b')}
    </AbsoluteFill>
  );
};

/** Horizontal slice glitch. Cuts the children into bands and jitters them. */
export const Glitch: React.FC<{amount: number; seed?: string; children: React.ReactNode; bands?: number}> = ({
  amount,
  seed = 'g',
  children,
  bands = 9,
}) => {
  const frame = useCurrentFrame();
  if (amount < 0.05) return <AbsoluteFill>{children}</AbsoluteFill>;
  // re-roll the slicing every 2 frames so it reads as digital tearing
  const f = Math.floor(frame / 2);
  const cuts = new Array(bands - 1)
    .fill(0)
    .map((_, i) => random(`${seed}c${i}${f}`) * 100)
    .sort((a, b) => a - b);
  const edges = [0, ...cuts, 100];
  return (
    <AbsoluteFill>
      {edges.slice(0, -1).map((top, i) => {
        const bottom = edges[i + 1];
        const jitter = random(`${seed}j${i}${f}`) > 0.55 ? (random(`${seed}x${i}${f}`) - 0.5) * 160 * amount : 0;
        return (
          <AbsoluteFill
            key={i}
            style={{
              clipPath: `polygon(0 ${top}%, 100% ${top}%, 100% ${bottom}%, 0 ${bottom}%)`,
              transform: `translateX(${jitter}px)`,
            }}
          >
            {children}
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};

/** Animated film grain, vignette and faint scanlines — sits on top of everything. */
export const FilmOverlay: React.FC<{grain?: number}> = ({grain = 0.09}) => {
  const frame = useCurrentFrame();
  const ox = Math.floor(random(`gx${frame}`) * 320);
  const oy = Math.floor(random(`gy${frame}`) * 320);
  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      <AbsoluteFill
        style={{
          backgroundImage: `url(${staticFile('noise.png')})`,
          backgroundPosition: `${ox}px ${oy}px`,
          opacity: grain,
          mixBlendMode: 'overlay',
        }}
      />
      <AbsoluteFill
        style={{
          background:
            'repeating-linear-gradient(0deg, rgba(0,0,0,0.16) 0px, rgba(0,0,0,0.16) 1px, transparent 1px, transparent 4px)',
          opacity: 0.35,
        }}
      />
      <AbsoluteFill
        style={{background: 'radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,0.75) 100%)'}}
      />
    </AbsoluteFill>
  );
};

/** Cyber backdrop: perspective grid floor + ambient glows. */
export const CyberBackground: React.FC<{
  hue?: string;
  intensity?: number;
  speed?: number;
  glowX?: number;
  glowY?: number;
}> = ({hue = C.accent, intensity = 1, speed = 1, glowX = 50, glowY = 45}) => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  const offset = (frame * 2.2 * speed) % 80;
  return (
    <AbsoluteFill style={{background: C.bg, overflow: 'hidden'}}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${glowX}% ${glowY}%, ${hue}33 0%, transparent ${Math.max(width, height) * 0.035}%)`,
          opacity: intensity,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: '-50%',
          width: '200%',
          bottom: '-10%',
          height: '62%',
          transform: 'perspective(600px) rotateX(68deg)',
          transformOrigin: 'center top',
          backgroundImage: `linear-gradient(${hue}40 2px, transparent 2px), linear-gradient(90deg, ${hue}40 2px, transparent 2px)`,
          backgroundSize: '80px 80px',
          backgroundPosition: `0 ${offset}px`,
          maskImage: 'linear-gradient(to bottom, transparent 0%, black 40%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 40%)',
          opacity: 0.55 * intensity,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(${hue}22 1.5px, transparent 1.5px)`,
          backgroundSize: '36px 36px',
          opacity: 0.5 * intensity,
          maskImage: 'radial-gradient(ellipse at center, black 20%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse at center, black 20%, transparent 75%)',
        }}
      />
    </AbsoluteFill>
  );
};

/** Speed lines radiating from the centre — for impacts. */
export const SpeedLines: React.FC<{amount: number; color?: string}> = ({amount, color = '#ffffff'}) => {
  const frame = useCurrentFrame();
  if (amount < 0.03) return null;
  const lines = new Array(70).fill(0).map((_, i) => {
    const a = random(`sl${i}${Math.floor(frame / 2)}`) * 360;
    const w = 1 + random(`sw${i}`) * 3;
    const len = 30 + random(`sL${i}${frame}`) * 40;
    return (
      <div
        key={i}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: `${len}%`,
          height: w,
          background: `linear-gradient(90deg, transparent, ${color})`,
          transformOrigin: '0 50%',
          transform: `rotate(${a}deg) translateX(${40 + (1 - amount) * 30}%)`,
          opacity: 0.6 * amount,
        }}
      />
    );
  });
  return <AbsoluteFill style={{overflow: 'hidden', pointerEvents: 'none'}}>{lines}</AbsoluteFill>;
};

/** Huge slammed word with chromatic fringe, used for the beat-cut titles. */
export const SlamWord: React.FC<{
  text: string;
  size: number;
  color?: string;
  fringe?: number;
  style?: React.CSSProperties;
  font?: string;
  tracking?: number;
}> = ({text, size, color = C.white, fringe = 0, style, font = DISPLAY, tracking = 0.01}) => {
  const base: React.CSSProperties = {
    fontFamily: font,
    fontSize: size,
    lineHeight: 0.95,
    letterSpacing: `${tracking}em`,
    textTransform: 'uppercase',
    whiteSpace: 'pre',
    textAlign: 'center',
  };
  return (
    <div style={{position: 'relative', ...style}}>
      {fringe > 0.02 && (
        <>
          <div style={{...base, position: 'absolute', inset: 0, color: '#ff2a6d', transform: `translate(${-fringe * 10}px, ${fringe * 2}px)`, mixBlendMode: 'screen', opacity: 0.9}}>
            {text}
          </div>
          <div style={{...base, position: 'absolute', inset: 0, color: C.accentLight, transform: `translate(${fringe * 10}px, ${-fringe * 2}px)`, mixBlendMode: 'screen', opacity: 0.9}}>
            {text}
          </div>
        </>
      )}
      <div style={{...base, position: 'relative', color}}>{text}</div>
    </div>
  );
};
