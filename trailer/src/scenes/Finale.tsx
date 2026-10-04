import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {useBeat, pulse, step, FPS} from '../timing';
import {C} from '../theme';
import {MONO, UI, WIDE} from '../fonts';
import {CyberBackground, Flash, Glitch, RGBSplit, Shake, SlamWord, SpeedLines} from '../fx';
import {Phone} from '../components/Phone';
import {ChatsList} from '../screens/ChatsList';
import {Chat} from '../screens/Chat';
import {CallScreen, SafetyScreen, SettingsScreen, ShieldMark} from '../screens/Other';
import {Icon} from '../components/Icon';
import {hit, ramp, springAt, Tag, useLayout} from './helpers';

const screens = (frame: number) => [
  {el: <ChatsList t={1} />, bg: C.bg, glow: C.accent},
  {el: <Chat frame={frame} shown={6} />, bg: C.bg, glow: C.accent},
  {el: <CallScreen frame={frame} seconds={frame / FPS + 312} beatPulse={0.4} />, bg: C.callBg, glow: C.emerald},
  {el: <SafetyScreen frame={frame} reveal={1} verified={1} />, bg: C.bg, glow: C.emerald},
  {el: <SettingsScreen t={1} />, bg: C.bg, glow: C.purple},
];

/** Beats 80–88: build-up. Fanned phones, then cuts that accelerate into the finale. */
export const MontageScene: React.FC = () => {
  const beat = useBeat('montage');
  const frame = useCurrentFrame();
  const {u, vertical} = useLayout();
  const all = screens(frame);
  const kick = pulse(beat, 6);

  if (beat < 4) {
    // three phones fan out, one per beat, rotating slowly
    const fan = [-1, 0, 1];
    return (
      <AbsoluteFill>
        <CyberBackground intensity={0.6 + kick * 0.3} speed={3} />
        <Shake amount={kick * 0.2}>
          <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', perspective: 2000}}>
            {fan.map((f, i) => {
              const s = springAt(beat, i * 0.5, {damping: 13, stiffness: 140});
              const scr = all[[0, 2, 4][i]];
              const spread = (vertical ? 330 : 470) * u;
              return (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    transform: `translateX(${f * spread * s}px) translateY(${(1 - s) * 800 + Math.abs(f) * 60 * u}px) rotateY(${f * -18}deg) rotateZ(${f * 6 * s}deg) scale(${f === 0 ? 1.04 : 0.9})`,
                    zIndex: f === 0 ? 2 : 1,
                  }}
                >
                  <Phone scale={(vertical ? 0.95 : 0.95) * u} glow={scr.glow} screenBg={scr.bg}>
                    {scr.el}
                  </Phone>
                </div>
              );
            })}
          </AbsoluteFill>
        </Shake>
        <AbsoluteFill style={{alignItems: 'center', justifyContent: vertical ? 'flex-start' : 'flex-end', padding: (vertical ? 180 : 60) * u}}>
          <div style={{opacity: ramp(beat, 1.5, 2), fontFamily: WIDE, fontWeight: 900, fontSize: 52 * u, letterSpacing: 10 * u, color: C.white, textShadow: `0 0 30px ${C.accent}`}}>
            ONE APP. ZERO EXPOSURE.
          </div>
        </AbsoluteFill>
        <Flash amount={hit(beat, 0, 5) * 0.4} />
      </AbsoluteFill>
    );
  }

  // beats 84–88: half-beat cuts, then 16ths in the last beat
  const every = beat < 7 ? 0.5 : 0.25;
  const local = beat < 7 ? beat - 4 : beat - 7;
  const i = step(local, every) + (beat < 7 ? 0 : 6);
  const scr = all[i % all.length];
  const words = ['PRIVATE', 'SECURE', 'FAST', 'YOURS', 'VERIFIED', 'ENCRYPTED', 'PRIVATE', 'BY', 'DEFAULT', '.'];
  const word = words[i % words.length];
  const phase = (local / every) % 1;
  const k = Math.exp(-phase * 4);
  const angle = (i % 2 ? 1 : -1) * 10;
  return (
    <AbsoluteFill style={{background: C.bg}}>
      <CyberBackground hue={scr.glow} intensity={0.8} speed={6} />
      <Shake amount={k * 0.7}>
        <RGBSplit amount={k * 0.8}>
          <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
            <div style={{transform: `rotate(${angle}deg) scale(${(vertical ? 1.5 : 1.15) * u * (1.08 - phase * 0.08)})`}}>
              <Phone glow={scr.glow} screenBg={scr.bg}>
                {scr.el}
              </Phone>
            </div>
          </AbsoluteFill>
          <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', mixBlendMode: 'difference'}}>
            <SlamWord text={word} size={(vertical ? 230 : 330) * u} color="#fff" />
          </AbsoluteFill>
        </RGBSplit>
      </Shake>
      <Flash amount={k * 0.25 + ramp(beat, 7.5, 8, (t) => t * t) * 1.2} />
    </AbsoluteFill>
  );
};

/** Beats 88–104: final logo slam + call to action. */
export const FinaleScene: React.FC = () => {
  const beat = useBeat('finale');
  const frame = useCurrentFrame();
  const {u, vertical} = useLayout();
  const kick = beat < 14 ? pulse(beat, 5) : 0;
  const impact = hit(beat, 0, 1.8);
  const s = springAt(beat, 0, {damping: 8, stiffness: 120});
  const all = screens(frame);
  const out = ramp(beat, 14.5, 16, (t) => t);
  const phonesIn = springAt(beat, 6, {damping: 15, stiffness: 80});
  return (
    <AbsoluteFill style={{background: '#000'}}>
      <AbsoluteFill style={{opacity: 1 - out}}>
        <CyberBackground intensity={0.8 + kick * 0.4} speed={1.2} />
        {/* phones rise behind the logo */}
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', perspective: 2200, opacity: phonesIn * 0.55}}>
          {[-2, -1, 1, 2].map((f, i) => {
            const scr = all[[0, 1, 2, 3][i]];
            return (
              <div
                key={f}
                style={{
                  position: 'absolute',
                  transform: `translateX(${f * (vertical ? 260 : 420) * u}px) translateY(${(1 - phonesIn) * 900 + Math.abs(f) * 80 * u + 120 * u}px) rotateY(${f * -14}deg) rotateZ(${f * 4}deg)`,
                  filter: 'blur(2px)',
                }}
              >
                <Phone scale={0.8 * u} glow={scr.glow} screenBg={scr.bg} glowAmount={0.3}>
                  {scr.el}
                </Phone>
              </div>
            );
          })}
        </AbsoluteFill>
        <AbsoluteFill style={{background: 'radial-gradient(circle at 50% 45%, rgba(3,7,18,0.2) 0%, rgba(3,7,18,0.92) 55%)'}} />
        <SpeedLines amount={impact} color={C.accentLight} />
        <Shake amount={impact * 1.6 + kick * 0.2}>
          <Glitch amount={hit(beat, 0, 3) * 0.8} seed="fin">
            <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', transform: `scale(${1 + kick * 0.03 + beat * 0.006})`}}>
              <div style={{transform: `scale(${interpolate(s, [0, 1], [4, 1])})`, marginBottom: 40 * u}}>
                <ShieldMark size={210 * u} glow={1.2 + kick} />
              </div>
              <div
                style={{
                  fontFamily: WIDE,
                  fontWeight: 900,
                  fontSize: (vertical ? 190 : 230) * u,
                  lineHeight: 1,
                  color: C.white,
                  letterSpacing: `${0.12 + (1 - s) * 0.5}em`,
                  textShadow: `0 0 ${60 * u}px ${C.accent}`,
                  opacity: Math.min(1, s * 2),
                  marginRight: '-0.12em',
                }}
              >
                VERO
              </div>
              <div style={{height: 120 * u, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
                {beat >= 2 && beat < 6 && (
                  <div style={{transform: `scale(${1 + hit(beat, 2, 6) * 0.3})`}}>
                    <SlamWord text="PROVABLY PRIVATE." size={(vertical ? 80 : 100) * u} color={C.accentLight} fringe={hit(beat, 2, 5)} />
                  </div>
                )}
                {beat >= 6 && (
                  <div style={{fontFamily: UI, fontWeight: 600, fontSize: 40 * u, color: C.text, opacity: ramp(beat, 6, 6.5), letterSpacing: 1 * u, textAlign: 'center'}}>
                    The messenger only <span style={{color: C.accentLight}}>you</span> can read.
                  </div>
                )}
              </div>
              <div style={{display: 'flex', gap: 16 * u, flexWrap: 'wrap', justifyContent: 'center', maxWidth: '88%', marginTop: 10 * u}}>
                {['E2EE', 'P2P CALLS', 'SAFETY NUMBERS', 'DISAPPEARING', 'ZERO-KNOWLEDGE'].map((t, i) => (
                  <div key={t} style={{opacity: ramp(beat, 8 + i * 0.25, 8.4 + i * 0.25), transform: `translateY(${(1 - ramp(beat, 8 + i * 0.25, 8.4 + i * 0.25)) * 30}px)`}}>
                    <Tag size={20 * u} text={t} color={[C.accentLight, C.emerald, C.accentLight, C.warning, C.purpleLight][i]} />
                  </div>
                ))}
              </div>
              <div
                style={{
                  marginTop: 50 * u,
                  opacity: ramp(beat, 10, 10.5),
                  transform: `scale(${0.8 + 0.2 * springAt(beat, 10, {damping: 10})})`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16 * u,
                  padding: `${20 * u}px ${44 * u}px`,
                  borderRadius: 999,
                  background: `linear-gradient(135deg, ${C.accent}, ${C.bubbleSent})`,
                  boxShadow: `0 0 ${(40 + kick * 40) * u}px ${C.accent}`,
                  fontFamily: WIDE,
                  fontWeight: 900,
                  fontSize: 34 * u,
                  letterSpacing: 4 * u,
                  color: '#fff',
                }}
              >
                <Icon name="download-outline" size={36 * u} color="#fff" />
                COMING SOON
              </div>
              <div style={{marginTop: 26 * u, opacity: ramp(beat, 11, 11.5), fontFamily: MONO, fontSize: 22 * u, color: C.text3, letterSpacing: 3 * u}}>
                iOS · ANDROID · WEB
              </div>
            </AbsoluteFill>
          </Glitch>
        </Shake>
      </AbsoluteFill>
      <Flash amount={impact * 1.3 + hit(beat, 2, 5) * 0.3} />
    </AbsoluteFill>
  );
};
