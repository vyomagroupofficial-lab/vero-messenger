import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import {useBeat, pulse} from '../timing';
import {C} from '../theme';
import {MONO, UI, WIDE} from '../fonts';
import {CyberBackground, Flash, Glitch, Shake, SlamWord, SpeedLines} from '../fx';
import {Icon} from '../components/Icon';
import {ShieldMark} from '../screens/Other';
import {hit, ramp, springAt, Tag, useLayout, within} from './helpers';

/** Beats 0–16: cold open. One word per beat, then the "intercept" tease. */
export const Intro: React.FC = () => {
  const beat = useBeat('intro');
  const {u, vertical} = useLayout();
  const big = (vertical ? 230 : 300) * u;

  const words: Array<[number, number, string, string?]> = [
    [0, 1, 'EVERY'],
    [1, 2, 'MESSAGE'],
    [2, 3, 'YOU'],
    [3, 4, 'SEND'],
    [8, 9, 'IS BEING'],
    [9, 10, 'WATCHED.', C.error],
    [10, 11, 'STORED.', C.error],
    [11, 12, 'READ.', C.error],
    [12, 13, 'NOT'],
    [13, 14, 'ANYMORE.', C.accentLight],
  ];
  const current = words.find(([a, b]) => within(beat, a, b));
  const kick = pulse(beat, 7);

  // beats 4–8: hacker terminal "intercepting" a plaintext message
  const lines = [
    '> tap --iface wan0 --capture all',
    '> decoding packet 0x7f3a ...',
    "> plaintext: \"meet me at 9? don't tell anyone\"",
    '> sender: you  |  status: EXPOSED',
  ];
  const term = within(beat, 4, 8);

  // beats 14–16: shield strobes on 8ths and rushes the camera
  const rush = within(beat, 14, 16);
  const rushP = ramp(beat, 14, 16, (t) => t * t * t);

  return (
    <AbsoluteFill style={{background: '#000'}}>
      <CyberBackground hue={beat >= 9 && beat < 12 ? C.error : C.accent} intensity={0.25 + kick * 0.25} speed={0.5} />
      <Shake amount={kick * (beat >= 9 && beat < 12 ? 0.8 : 0.35)}>
        <Glitch amount={beat >= 9 && beat < 12 ? 0.4 + kick * 0.6 : kick * 0.15} seed="intro">
          <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
            {current && (
              <div style={{transform: `scale(${1 + kick * 0.12})`}}>
                <SlamWord text={current[2]} size={big} color={current[3] ?? C.white} fringe={kick * 1.2} />
              </div>
            )}
            {term && (
              <div style={{fontFamily: MONO, fontSize: (vertical ? 30 : 38) * u, color: '#7CFFB2', lineHeight: 1.6, width: vertical ? '88%' : '70%'}}>
                {lines.map((l, i) => {
                  const start = 4 + i * 0.85;
                  const chars = Math.floor(interpolate(beat, [start, start + 0.7], [0, l.length], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}));
                  const danger = i >= 2;
                  return (
                    <div key={i} style={{color: danger ? C.error : '#7CFFB2', textShadow: `0 0 18px ${danger ? C.error : '#22c55e'}88`}}>
                      {l.slice(0, chars)}
                      {chars > 0 && chars < l.length ? '█' : ''}
                    </div>
                  );
                })}
                {beat > 7.2 && (
                  <div style={{marginTop: 30 * u, fontFamily: WIDE, fontWeight: 900, fontSize: 64 * u, color: C.error, letterSpacing: 6, opacity: Math.floor(beat * 8) % 2 ? 1 : 0.2}}>
                    ⚠ INTERCEPTED
                  </div>
                )}
              </div>
            )}
            {rush && (
              <div style={{transform: `scale(${0.6 + rushP * 7})`, opacity: Math.floor(beat * 4) % 2 === 0 ? 1 : 0.35, filter: `blur(${rushP * 6}px)`}}>
                <ShieldMark size={180 * u} glow={1.5} />
              </div>
            )}
          </AbsoluteFill>
        </Glitch>
      </Shake>
      <Flash amount={hit(beat, 12, 6) * 0.5 + hit(beat, 4, 8) * 0.25 + hit(beat, 8, 8) * 0.3 + rushP * rushP * 0.9} />
      <Flash amount={hit(beat, 9, 4) * 0.35 + hit(beat, 10, 4) * 0.35 + hit(beat, 11, 4) * 0.35} color={C.error} />
    </AbsoluteFill>
  );
};

/** Beats 16–24: THE DROP — logo slam straight out of splash.tsx. */
export const LogoDrop: React.FC = () => {
  const beat = useBeat('logo');
  const {u, vertical} = useLayout();
  const kick = pulse(beat, 6);
  const impact = hit(beat, 0, 2.2);
  const s = springAt(beat, 0, {damping: 9, stiffness: 140});
  const shieldScale = interpolate(s, [0, 1], [3.2, 1]);
  const letters = 'VERO'.split('');
  const push = ramp(beat, 6, 8, (t) => t * t * t);

  return (
    <AbsoluteFill>
      <CyberBackground intensity={0.7 + kick * 0.5} speed={2} />
      <SpeedLines amount={impact} color={C.accentLight} />
      <Shake amount={impact * 1.4 + kick * 0.25}>
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            transform: `scale(${1 + kick * 0.04 + push * 2.5})`,
            filter: push > 0.05 ? `blur(${push * 18}px)` : undefined,
            opacity: 1 - push * 0.6,
          }}
        >
          {/* radar rings — one per beat */}
          {[0, 1, 2, 3].map((i) => {
            const ph = (beat + i * 0.25) % 1;
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  width: (300 + ph * 900) * u,
                  height: (300 + ph * 900) * u,
                  borderRadius: '50%',
                  border: `${2 * u}px solid ${i % 2 ? C.accent : C.accentLight}`,
                  opacity: (1 - ph) * 0.5,
                  marginTop: -170 * u,
                }}
              />
            );
          })}
          <div style={{transform: `scale(${shieldScale}) rotate(${(1 - s) * -25}deg)`, marginBottom: 46 * u}}>
            <ShieldMark size={200 * u} glow={1 + kick} />
          </div>
          <div style={{display: 'flex', gap: 40 * u}}>
            {letters.map((l, i) => {
              const ls = springAt(beat, 0.5 + i * 0.25, {damping: 11, stiffness: 300});
              return (
                <div
                  key={l}
                  style={{
                    fontFamily: WIDE,
                    fontWeight: 900,
                    fontSize: (vertical ? 150 : 170) * u,
                    lineHeight: 1,
                    color: C.white,
                    transform: `translateY(${(1 - ls) * 160 * u}px) scale(${0.4 + ls * 0.6})`,
                    opacity: Math.min(1, ls * 2),
                    textShadow: `0 0 ${40 * u}px ${C.accent}`,
                  }}
                >
                  {l}
                </div>
              );
            })}
          </div>
          <div style={{opacity: ramp(beat, 2, 2.5), transform: `translateY(${(1 - ramp(beat, 2, 2.5)) * 30}px)`, marginTop: 26 * u, fontFamily: UI, fontWeight: 500, fontSize: 34 * u, color: C.text2, letterSpacing: 1.5 * u, textAlign: 'center'}}>
            Provably Private • End-to-End Encrypted
          </div>
          <div style={{marginTop: 28 * u, opacity: ramp(beat, 3, 3.5), transform: `scale(${0.8 + 0.2 * ramp(beat, 3, 3.5)})`}}>
            <Tag
              size={22 * u}
              text="LIBSODIUM • CURVE25519 • WEBRTC P2P"
              icon={<div style={{width: 10 * u, height: 10 * u, borderRadius: '50%', background: C.emerald, boxShadow: `0 0 10px ${C.emerald}`}} />}
            />
          </div>
          <div style={{position: 'absolute', bottom: 70 * u, display: 'flex', alignItems: 'center', gap: 10 * u, opacity: ramp(beat, 4, 4.5)}}>
            <Icon name="lock-closed" size={22 * u} color={C.emerald} />
            <span style={{fontFamily: UI, fontSize: 22 * u, color: C.emerald, fontWeight: 600, letterSpacing: 1}}>Zero-Knowledge Client Architecture</span>
          </div>
        </AbsoluteFill>
      </Shake>
      <Flash amount={impact * 1.2 + push * push} />
    </AbsoluteFill>
  );
};
