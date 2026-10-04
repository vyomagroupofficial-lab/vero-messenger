import React from 'react';
import {C} from '../theme';
import {UI} from '../fonts';

export const SCREEN_W = 390;
export const SCREEN_H = 844;

const StatusBar: React.FC = () => (
  <div
    style={{
      height: 50,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 30px 0 34px',
      color: C.text,
      fontFamily: UI,
      fontWeight: 600,
      fontSize: 16,
      flexShrink: 0,
    }}
  >
    <span>9:41</span>
    <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
      <div style={{display: 'flex', alignItems: 'flex-end', gap: 2, height: 12}}>
        {[5, 7, 9, 12].map((h) => (
          <div key={h} style={{width: 3, height: h, background: C.text, borderRadius: 1}} />
        ))}
      </div>
      <div style={{fontSize: 12, fontWeight: 700, letterSpacing: 0.3}}>5G</div>
      <div
        style={{
          width: 25,
          height: 12,
          border: `1.5px solid ${C.text}88`,
          borderRadius: 4,
          padding: 1.5,
          position: 'relative',
        }}
      >
        <div style={{width: '82%', height: '100%', background: C.text, borderRadius: 1.5}} />
      </div>
    </div>
  </div>
);

/**
 * iPhone-style device frame. Children render at the app's native 390×844
 * point size so the recreated screens use the exact dimensions from the code.
 */
export const Phone: React.FC<{
  children: React.ReactNode;
  scale?: number;
  glow?: string;
  glowAmount?: number;
  style?: React.CSSProperties;
  hideStatusBar?: boolean;
  screenBg?: string;
}> = ({children, scale = 1, glow = C.accent, glowAmount = 0.6, style, hideStatusBar, screenBg = C.bg}) => {
  const bezel = 13;
  return (
    <div
      style={{
        width: SCREEN_W + bezel * 2,
        height: SCREEN_H + bezel * 2,
        transform: `scale(${scale})`,
        transformStyle: 'preserve-3d',
        position: 'relative',
        flexShrink: 0,
        ...style,
      }}
    >
      {/* glow */}
      <div
        style={{
          position: 'absolute',
          inset: 30,
          borderRadius: 80,
          boxShadow: `0 0 140px 40px ${glow}`,
          opacity: glowAmount * 0.55,
        }}
      />
      {/* titanium frame */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 64,
          background: 'linear-gradient(145deg, #3a4150 0%, #12161f 30%, #0b0e14 60%, #2b3240 100%)',
          boxShadow: '0 50px 120px rgba(0,0,0,0.7), inset 0 0 0 1.5px rgba(255,255,255,0.18)',
        }}
      />
      {/* side buttons */}
      <div style={{position: 'absolute', left: -3, top: 190, width: 4, height: 64, borderRadius: 2, background: '#2a303c'}} />
      <div style={{position: 'absolute', left: -3, top: 270, width: 4, height: 64, borderRadius: 2, background: '#2a303c'}} />
      <div style={{position: 'absolute', right: -3, top: 230, width: 4, height: 100, borderRadius: 2, background: '#2a303c'}} />
      {/* screen */}
      <div
        style={{
          position: 'absolute',
          left: bezel,
          top: bezel,
          width: SCREEN_W,
          height: SCREEN_H,
          borderRadius: 52,
          overflow: 'hidden',
          background: screenBg,
          display: 'flex',
          flexDirection: 'column',
          fontFamily: UI,
          color: C.text,
        }}
      >
        {!hideStatusBar && <StatusBar />}
        <div style={{flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden'}}>
          {children}
        </div>
        {/* home indicator */}
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: '50%',
            width: 134,
            height: 5,
            marginLeft: -67,
            borderRadius: 3,
            background: 'rgba(255,255,255,0.85)',
          }}
        />
        {/* dynamic island */}
        <div
          style={{
            position: 'absolute',
            top: 11,
            left: '50%',
            width: 122,
            height: 35,
            marginLeft: -61,
            borderRadius: 20,
            background: '#000',
          }}
        />
        {/* glass glare */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(115deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0) 28%, rgba(255,255,255,0) 70%, rgba(255,255,255,0.04) 100%)',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
};
