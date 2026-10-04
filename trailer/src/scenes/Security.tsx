import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {useBeat, pulse, FPS} from '../timing';
import {C} from '../theme';
import {MONO, WIDE} from '../fonts';
import {CyberBackground, Flash, Glitch, Shake, SpeedLines} from '../fx';
import {CallScreen, NewGroupScreen, SafetyScreen} from '../screens/Other';
import {Chat, Msg} from '../screens/Chat';
import {Icon} from '../components/Icon';
import {cipher, hit, ramp, Slam, springAt, Sub, Tag, Title, useLayout} from './helpers';
import {Stage} from './Stage';

/** Beats 48–56: encrypted P2P calls. */
export const CallsScene: React.FC = () => {
  const beat = useBeat('calls');
  const frame = useCurrentFrame();
  const {u, vertical} = useLayout();
  const kick = pulse(beat, 5);
  const enter = springAt(beat, 0, {damping: 13, stiffness: 110});
  const exit = ramp(beat, 7.5, 8, (t) => t * t);
  return (
    <AbsoluteFill>
      <CyberBackground hue={C.emerald} intensity={0.6 + kick * 0.4} glowX={vertical ? 50 : 68} />
      <Shake amount={kick * 0.22 + hit(beat, 0, 4) * 0.7}>
        <AbsoluteFill style={{transform: `translateY(${exit * -1400}px)`, filter: exit > 0.05 ? `blur(${exit * 16}px)` : undefined}}>
          <Stage
            glow={C.emerald}
            screenBg={C.callBg}
            screen={<CallScreen frame={frame} seconds={(frame / FPS) * 7 + 64} beatPulse={kick} />}
            phoneTransform={`scale(${interpolate(enter, [0, 1], [0.3, 1]) + kick * 0.02}) rotateZ(${(1 - enter) * 20}deg) rotateY(${-12 + Math.sin(frame / 28) * 3}deg)`}
            copy={
              <>
                <Slam beat={beat} at={0}>
                  <Title size={(vertical ? 140 : 160) * u}>CRYSTAL</Title>
                </Slam>
                <Slam beat={beat} at={1}>
                  <Title size={(vertical ? 140 : 160) * u}>CLEAR CALLS.</Title>
                </Slam>
                <Slam beat={beat} at={2}>
                  <Title size={(vertical ? 140 : 160) * u} color={C.emeraldLight} glow={C.emerald}>
                    PEER-TO-PEER.
                  </Title>
                </Slam>
                <div style={{opacity: ramp(beat, 3, 3.5), marginTop: 30 * u}}>
                  <Sub size={32 * u}>Voice &amp; video stream device-to-device. No central relays.</Sub>
                </div>
                <div style={{display: 'flex', gap: 16 * u, marginTop: 26 * u, opacity: ramp(beat, 4, 4.5)}}>
                  <Tag size={20 * u} text="WEBRTC" color={C.emerald} />
                  <Tag size={20 * u} text="DTLS-SRTP" color={C.emerald} />
                  <Tag size={20 * u} text="STUN / TURN" color={C.emerald} />
                </div>
              </>
            }
          />
        </AbsoluteFill>
      </Shake>
      <Flash amount={hit(beat, 0, 6) * 0.5 + exit * 0.5} color="#c8ffe9" />
    </AbsoluteFill>
  );
};

/** Beats 56–64: verify safety number. */
export const SafetyScene: React.FC = () => {
  const beat = useBeat('safety');
  const frame = useCurrentFrame();
  const {u, vertical} = useLayout();
  const kick = pulse(beat, 6);
  const reveal = ramp(beat, 0.2, 4, (t) => t);
  const verified = beat >= 5 ? 1 : 0;
  const stamp = springAt(beat, 5, {damping: 8, stiffness: 260});
  const enter = springAt(beat, 0, {damping: 14, stiffness: 120});
  return (
    <AbsoluteFill>
      <CyberBackground hue={verified ? C.emerald : C.accent} intensity={0.6 + kick * 0.4} glowX={vertical ? 50 : 30} />
      <Shake amount={kick * 0.2 + hit(beat, 5, 3) * 1.4}>
        <Stage
          side="left"
          glow={verified ? C.emerald : C.accent}
          screen={<SafetyScreen frame={frame} reveal={reveal} verified={verified ? 1 : 0} />}
          phoneTransform={`translateX(${(1 - enter) * -1200}px) rotateY(${14 + (1 - enter) * 40}deg) scale(${1 + kick * 0.015})`}
          copy={
            <div style={{display: 'flex', flexDirection: 'column', alignItems: vertical ? 'center' : 'flex-start'}}>
              <Slam beat={beat} at={0}>
                <Title size={(vertical ? 140 : 165) * u}>60-DIGIT</Title>
              </Slam>
              <Slam beat={beat} at={1}>
                <Title size={(vertical ? 140 : 165) * u}>SAFETY</Title>
              </Slam>
              <Slam beat={beat} at={2}>
                <Title size={(vertical ? 140 : 165) * u} color={C.accentLight} glow={C.accent}>
                  NUMBERS.
                </Title>
              </Slam>
              <div style={{opacity: ramp(beat, 3, 3.5), marginTop: 26 * u}}>
                <Sub size={32 * u}>Scan. Compare. Verified. No man in the middle.</Sub>
              </div>
            </div>
          }
        />
      </Shake>
      {beat >= 5 && (
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', pointerEvents: 'none'}}>
          <div
            style={{
              transform: `rotate(-12deg) scale(${interpolate(stamp, [0, 1], [3.5, 1])})`,
              opacity: Math.min(1, stamp * 2) * (1 - ramp(beat, 7.4, 8)),
              border: `${10 * u}px solid ${C.emerald}`,
              borderRadius: 30 * u,
              padding: `${10 * u}px ${50 * u}px`,
              display: 'flex',
              alignItems: 'center',
              gap: 24 * u,
              background: 'rgba(3,7,18,0.6)',
              boxShadow: `0 0 80px ${C.emerald}aa`,
            }}
          >
            <Icon name="checkmark-circle" size={150 * u} color={C.emerald} />
            <div style={{fontFamily: WIDE, fontWeight: 900, fontSize: 150 * u, color: C.emerald, letterSpacing: 6 * u}}>VERIFIED</div>
          </div>
        </AbsoluteFill>
      )}
      <Flash amount={hit(beat, 5, 3) * 0.9} color="#a7ffd9" />
      <Flash amount={hit(beat, 0, 6) * 0.4 + ramp(beat, 7.6, 8) * 0.8} />
    </AbsoluteFill>
  );
};

const VANISH_THREAD: Msg[] = [
  {kind: 'text', own: false, text: 'Launch codes are in the doc 🤫', time: '9:41'},
  {kind: 'doc', own: false, name: 'launch_plan_v3.pdf', time: '9:41'},
  {kind: 'text', own: true, text: 'Got it. Burning this chat in 3… 2… 1…', time: '9:42'},
  {kind: 'text', own: false, text: '🔥🔥🔥', time: '9:42'},
];

/** Beats 64–72: groups (64–68) then disappearing messages (68–72). */
export const VanishScene: React.FC = () => {
  const beat = useBeat('vanish');
  const frame = useCurrentFrame();
  const {u, vertical} = useLayout();
  const kick = pulse(beat, 6);
  const groups = beat < 4;
  const name = 'Launch Squad';
  const typed = name.slice(0, Math.floor(ramp(beat, 0.3, 1.6, (t) => t) * name.length));
  const selected = interpolate(beat, [1.5, 2, 2.5, 3, 3.5], [0, 1, 2, 3, 4], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const vanish = VANISH_THREAD.map((_, i) => ramp(beat, 6 + i * 0.4, 6.4 + i * 0.4, (t) => t));
  const swap = hit(beat, 4, 5);
  return (
    <AbsoluteFill>
      <CyberBackground hue={groups ? C.purple : C.warning} intensity={0.6 + kick * 0.4} />
      <Shake amount={kick * 0.2 + swap * 0.9}>
        <Glitch amount={swap * 0.8} seed="vanish">
          <AbsoluteFill>
            {groups ? (
              <Stage
                glow={C.purple}
                screen={<NewGroupScreen frame={frame} selected={selected} typed={typed} />}
                phoneTransform={`rotateY(${-14 + Math.sin(frame / 30) * 3}deg) scale(${springAt(beat, 0, {damping: 12}) * 0.1 + 0.9 + kick * 0.015})`}
                copy={
                  <>
                    <Slam beat={beat} at={0}>
                      <Title size={(vertical ? 150 : 175) * u}>GROUPS.</Title>
                    </Slam>
                    <Slam beat={beat} at={1}>
                      <Title size={(vertical ? 150 : 175) * u} color={C.purpleLight} glow={C.purple}>
                        STILL E2EE.
                      </Title>
                    </Slam>
                    <div style={{opacity: ramp(beat, 2, 2.5), marginTop: 26 * u}}>
                      <Tag size={20 * u} text="PAIRWISE DOUBLE RATCHET" color={C.purpleLight} />
                    </div>
                  </>
                }
              />
            ) : (
              <Stage
                side="left"
                glow={C.warning}
                screen={<Chat frame={frame} shown={9} thread={VANISH_THREAD} vanish={vanish} name="Launch Squad" timerBanner="5 minutes" />}
                phoneTransform={`rotateY(${12 + Math.sin(frame / 30) * 3}deg) scale(${1 + kick * 0.015})`}
                copy={
                  <div style={{display: 'flex', flexDirection: 'column', alignItems: vertical ? 'center' : 'flex-start'}}>
                    <Slam beat={beat} at={4}>
                      <Title size={(vertical ? 140 : 165) * u}>MESSAGES</Title>
                    </Slam>
                    <Slam beat={beat} at={5}>
                      <Title size={(vertical ? 140 : 165) * u}>THAT</Title>
                    </Slam>
                    <div
                      style={{
                        opacity: beat < 6 ? 0 : 1 - ramp(beat, 7, 7.9) * 0.9,
                        filter: `blur(${ramp(beat, 7, 7.9) * 20}px)`,
                        letterSpacing: `${ramp(beat, 7, 7.9) * 0.3}em`,
                      }}
                    >
                      <Slam beat={beat} at={6}>
                        <Title size={(vertical ? 140 : 165) * u} color={C.warning} glow={C.warning}>
                          VANISH.
                        </Title>
                      </Slam>
                    </div>
                    <div style={{opacity: ramp(beat, 6.5, 7), marginTop: 26 * u}}>
                      <Tag size={20 * u} text="DISAPPEARING TIMERS" color={C.warning} icon={<Icon name="timer-outline" size={20 * u} color={C.warning} />} />
                    </div>
                  </div>
                }
              />
            )}
          </AbsoluteFill>
        </Glitch>
      </Shake>
      <Flash amount={swap * 0.5 + hit(beat, 0, 6) * 0.4} color={groups ? '#e2d5ff' : '#ffe9b8'} />
    </AbsoluteFill>
  );
};

/** Beats 72–80: zero-knowledge architecture diagram. */
export const ZeroKnowledgeScene: React.FC = () => {
  const beat = useBeat('zk');
  const frame = useCurrentFrame();
  const {u, vertical} = useLayout();
  const kick = pulse(beat, 6);
  const nodeIn = (at: number) => springAt(beat, at, {damping: 12, stiffness: 200});
  const node = (icon: string, label: string, sub: string, col: string, at: number) => {
    const s = nodeIn(at);
    return (
      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 * u, transform: `scale(${s})`, opacity: Math.min(1, s * 2), width: 300 * u}}>
        <div style={{width: 150 * u, height: 150 * u, borderRadius: 40 * u, border: `3px solid ${col}`, background: `${col}1c`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 ${(40 + kick * 40) * u}px ${col}66`}}>
          <Icon name={icon} size={80 * u} color={col} />
        </div>
        <div style={{fontFamily: WIDE, fontWeight: 900, fontSize: 30 * u, color: C.white, letterSpacing: 2 * u}}>{label}</div>
        <div style={{fontFamily: MONO, fontSize: 18 * u, color: C.text2, textAlign: 'center'}}>{sub}</div>
      </div>
    );
  };
  // packets travel left→right, one per beat
  const packets = new Array(8).fill(0).map((_, i) => {
    const p = (beat - 1 - i) / 1.6;
    if (p < 0 || p > 1) return null;
    return (
      <div key={i} style={{position: 'absolute', left: `${p * 100}%`, top: '50%', transform: 'translate(-50%, -50%)', display: 'flex', alignItems: 'center', gap: 8 * u, padding: `${6 * u}px ${12 * u}px`, borderRadius: 999, background: C.surfaceElevated, border: `1.5px solid ${C.accent}`, boxShadow: `0 0 20px ${C.accent}`}}>
        <Icon name="lock-closed" size={20 * u} color={C.accentLight} />
        <span style={{fontFamily: MONO, fontSize: 16 * u, color: C.accentLight}}>{cipher(6, i + Math.floor(frame / 3))}</span>
      </div>
    );
  });
  const lineW = vertical ? 2 : 1;
  const title2 = beat >= 4;
  return (
    <AbsoluteFill>
      <CyberBackground intensity={0.5 + kick * 0.3} speed={1.5} />
      <Shake amount={kick * 0.25 + hit(beat, 4, 3) * 0.8}>
        <Glitch amount={hit(beat, 4, 3)} seed="zk">
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 70 * u}}>
          <div style={{textAlign: 'center', height: 170 * u}}>
            {!title2 ? (
              <Slam beat={beat} at={0}>
                <Title size={(vertical ? 110 : 150) * u}>THE SERVER DELIVERS.</Title>
              </Slam>
            ) : (
              <Slam beat={beat} at={4}>
                <Title size={(vertical ? 110 : 150) * u} color={C.accentLight} glow={C.accent}>
                  IT CAN&apos;T READ A THING.
                </Title>
              </Slam>
            )}
          </div>
          <div style={{position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: (vertical ? 980 : 1500) * u}}>
            <div style={{position: 'absolute', left: 150 * u, right: 150 * u, top: 75 * u, height: 0}}>
              <div style={{position: 'absolute', left: 0, right: 0, top: -lineW, height: lineW * 2, background: `linear-gradient(90deg, ${C.accent}, ${C.emerald})`, opacity: ramp(beat, 0.5, 1), boxShadow: `0 0 12px ${C.accent}`}} />
              {packets}
            </div>
            {node('phone-portrait', 'YOU', 'encrypts on-device', C.accent, 0.25)}
            {node('server', 'SUPABASE', 'routes ciphertext only', C.purpleLight, 0.75)}
            {node('phone-portrait', 'THEM', 'decrypts on-device', C.emerald, 1.25)}
          </div>
          <div style={{display: 'flex', gap: 18 * u, flexWrap: 'wrap', justifyContent: 'center', opacity: ramp(beat, 2, 2.5), maxWidth: '90%'}}>
            <Tag size={20 * u} text="ZERO PLAINTEXT ON SERVERS" color={C.emerald} />
            <Tag size={20 * u} text="ROW-LEVEL SECURITY" />
            <Tag size={20 * u} text="DRIVE = ENCRYPTED BLOBS" color={C.purpleLight} icon={<Icon name="cloud-done" size={20 * u} color={C.purpleLight} />} />
            <Tag size={20 * u} text="KEYS NEVER LEAVE YOUR DEVICE" color={C.warning} icon={<Icon name="key" size={20 * u} color={C.warning} />} />
          </div>
        </AbsoluteFill>
        </Glitch>
      </Shake>
      <SpeedLines amount={hit(beat, 4, 2.5)} color={C.accentLight} />
      <Flash amount={hit(beat, 4, 3.5) * 0.8 + hit(beat, 0, 6) * 0.4} />
    </AbsoluteFill>
  );
};
