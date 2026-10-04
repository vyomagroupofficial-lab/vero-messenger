import React from 'react';
import {AbsoluteFill} from 'remotion';
import {Phone} from '../components/Phone';
import {useLayout} from './helpers';
import {C} from '../theme';

/**
 * Phone + copy layout that adapts to 16:9 (side by side) and 9:16 (stacked).
 * `side` picks which side the phone sits on in landscape.
 */
export const Stage: React.FC<{
  screen: React.ReactNode;
  copy: React.ReactNode;
  side?: 'left' | 'right';
  phoneTransform?: string;
  phoneScale?: number;
  glow?: string;
  glowAmount?: number;
  screenBg?: string;
  copyStyle?: React.CSSProperties;
}> = ({screen, copy, side = 'right', phoneTransform = '', phoneScale = 1, glow = C.accent, glowAmount = 0.7, screenBg, copyStyle}) => {
  const {vertical, u} = useLayout();
  const scale = (vertical ? 1.42 : 1.08) * u * phoneScale;
  const phone = (
    <div style={{transform: phoneTransform, transformStyle: 'preserve-3d'}}>
      <Phone scale={scale} glow={glow} glowAmount={glowAmount} screenBg={screenBg}>
        {screen}
      </Phone>
    </div>
  );
  if (vertical) {
    return (
      <AbsoluteFill style={{perspective: 1800}}>
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'flex-start', paddingTop: 150 * u, ...copyStyle}}>{copy}</AbsoluteFill>
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 0, transform: `translateY(${-20 * u}px)`}}>{phone}</AbsoluteFill>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{flexDirection: side === 'right' ? 'row' : 'row-reverse', alignItems: 'center', perspective: 1800}}>
      <div style={{flex: 1, display: 'flex', flexDirection: 'column', alignItems: side === 'right' ? 'flex-start' : 'flex-start', paddingLeft: side === 'right' ? 170 * u : 40 * u, paddingRight: side === 'right' ? 0 : 120 * u, ...copyStyle}}>
        {copy}
      </div>
      <div style={{width: 820 * u, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>{phone}</div>
    </AbsoluteFill>
  );
};
