import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {useBeat, pulse, step} from '../timing';
import {C} from '../theme';
import {MONO, UI} from '../fonts';
import {CyberBackground, Flash, Glitch, RGBSplit, Shake, SlamWord} from '../fx';
import {ChatsList} from '../screens/ChatsList';
import {Chat} from '../screens/Chat';
import {Icon} from '../components/Icon';
import {cipher, hit, ramp, Slam, springAt, Sub, Tag, Title, useLayout, within} from './helpers';
import {Stage} from './Stage';

/** Beats 24–32: the chat list. */
export const ChatsScene: React.FC = () => {
  const beat = useBeat('chats');
  const frame = useCurrentFrame();
  const {u, vertical} = useLayout();
  const kick = pulse(beat, 6);
  const enter = springAt(beat, 0, {damping: 15, stiffness: 120});
  const zoomOut = ramp(beat, 7, 8, (t) => t * t * t);
  const tilt = interpolate(enter, [0, 1], [-35, -14]) + Math.sin(frame / 25) * 2;
  const active = beat >= 4 ? ['All', 'Direct', 'Groups', 'Unread'][step(beat - 4) % 4] : 'All';
  return (
    <AbsoluteFill>
      <CyberBackground intensity={0.6 + kick * 0.4} glowX={vertical ? 50 : 70} />
      <Shake amount={kick * 0.2 + hit(beat, 0, 4) * 0.6}>
        <AbsoluteFill style={{transform: `scale(${1 + kick * 0.025 + zoomOut * 1.8})`, filter: zoomOut > 0.05 ? `blur(${zoomOut * 14}px)` : undefined}}>
          <Stage
            screen={<ChatsList t={(beat + 0.2) / 2.2} active={active} highlightRow={0} highlight={hit(beat, 6, 1.5)} />}
            phoneTransform={`translateY(${(1 - enter) * 900}px) rotateY(${tilt}deg) rotateX(${(1 - enter) * 30 + 4}deg)`}
            copy={
              <>
                <Slam beat={beat} at={0}>
                  <Title size={(vertical ? 150 : 170) * u}>ALL YOUR</Title>
                </Slam>
                <Slam beat={beat} at={1}>
                  <Title size={(vertical ? 150 : 170) * u}>CHATS.</Title>
                </Slam>
                <Slam beat={beat} at={2}>
                  <Title size={(vertical ? 150 : 170) * u} color={C.accentLight} glow={C.accent}>
                    LOCKED.
                  </Title>
                </Slam>
                <div style={{opacity: ramp(beat, 3, 3.5), marginTop: 30 * u}}>
                  <Sub size={32 * u}>Encrypted on your device before they ever leave it.</Sub>
                </div>
                <div style={{opacity: ramp(beat, 4, 4.5), marginTop: 26 * u}}>
                  <Tag size={20 * u} text="E2EE ACTIVE" color={C.emerald} icon={<Icon name="shield-checkmark" size={20 * u} color={C.emerald} />} />
                </div>
              </>
            }
          />
        </AbsoluteFill>
      </Shake>
      <Flash amount={hit(beat, 0, 5) * 0.6 + zoomOut * zoomOut} />
    </AbsoluteFill>
  );
};

/** Beats 32–40: a live conversation, one bubble per beat. */
export const ChatScene: React.FC = () => {
  const beat = useBeat('chat');
  const frame = useCurrentFrame();
  const {u, vertical} = useLayout();
  const kick = pulse(beat, 6);
  const shown = interpolate(beat, [0, 1, 1.5, 2, 3, 4, 5], [0.6, 1, 1, 2, 3, 4, 5.99], {extrapolateRight: 'clamp'});
  const typing = within(beat, 1, 1.6) || within(beat, 3.4, 4);
  const draftText = 'Not even Vero. Only us. ⚡';
  const draft = within(beat, 2.3, 3) ? draftText.slice(0, Math.floor(ramp(beat, 2.3, 2.85, (t) => t) * draftText.length)) : '';
  const words: Array<[number, string, string]> = [
    [0, 'TEXT.', C.white],
    [4, 'VOICE.', C.white],
    [5, 'MEDIA.', C.white],
    [6, 'SEALED.', C.accentLight],
  ];
  const exit = ramp(beat, 7.5, 8, (t) => t * t);
  return (
    <AbsoluteFill>
      <CyberBackground intensity={0.6 + kick * 0.3} hue={C.accent} glowX={vertical ? 50 : 30} />
      {/* floating ciphertext streams */}
      <AbsoluteFill style={{opacity: 0.18, fontFamily: MONO, fontSize: 18 * u, color: C.accent, overflow: 'hidden'}}>
        {new Array(16).fill(0).map((_, i) => (
          <div key={i} style={{position: 'absolute', left: `${(i * 6.3) % 100}%`, top: `${((frame * (1.2 + (i % 3) * 0.5) + i * 140) % 1400) - 200}px`, writingMode: 'vertical-rl', letterSpacing: 4}}>
            {cipher(40, i + 3)}
          </div>
        ))}
      </AbsoluteFill>
      <Shake amount={kick * 0.18}>
        <AbsoluteFill style={{transform: `translateX(${exit * -2200}px)`, filter: exit > 0.05 ? `blur(${exit * 20}px)` : undefined}}>
          <Stage
            side="left"
            screen={<Chat frame={frame} shown={shown} typing={typing} draft={draft} />}
            phoneTransform={`rotateY(${10 + Math.sin(frame / 30) * 3}deg) scale(${1 + kick * 0.015})`}
            copy={
              <div style={{display: 'flex', flexDirection: 'column', alignItems: vertical ? 'center' : 'flex-start'}}>
                {words.map(([at, w, col]) =>
                  beat >= at ? (
                    <Slam key={w} beat={beat} at={at}>
                      <Title size={(vertical ? 150 : 180) * u} color={col} glow={col === C.white ? undefined : C.accent}>
                        {w}
                      </Title>
                    </Slam>
                  ) : null,
                )}
                <div style={{opacity: ramp(beat, 6.5, 7), marginTop: 24 * u}}>
                  <Tag size={20 * u} text="READ RECEIPTS · TYPING · REACTIONS" />
                </div>
              </div>
            }
          />
        </AbsoluteFill>
      </Shake>
      <Flash amount={hit(beat, 0, 6) * 0.4 + hit(beat, 6, 5) * 0.5} />
    </AbsoluteFill>
  );
};

/** Beats 40–44: plaintext → ciphertext. */
export const CipherScene: React.FC = () => {
  const beat = useBeat('cipher');
  const frame = useCurrentFrame();
  const {u, vertical} = useLayout();
  const kick = pulse(beat, 6);
  const plain = 'meet me at 9?';
  const encrypted = cipher(plain.length * 2, 42);
  const scramble = ramp(beat, 0.5, 2, (t) => t);
  const shownText = plain
    .split('')
    .map((ch, i) => (i / plain.length < scramble ? encrypted.slice(i * 2, i * 2 + 2) : ch))
    .join('');
  const lock = springAt(beat, 2, {damping: 9, stiffness: 220});
  const out = ramp(beat, 3.5, 4, (t) => t * t);
  return (
    <AbsoluteFill style={{background: C.bg}}>
      <CyberBackground intensity={0.4 + kick * 0.5} hue={scramble > 0.5 ? C.emerald : C.accent} speed={3} />
      <Shake amount={kick * 0.5 + hit(beat, 2, 4) * 1.2}>
        <RGBSplit amount={hit(beat, 2, 6) * 1.5 + (within(beat, 0.5, 2) ? 0.25 : 0)}>
          <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 50 * u, transform: `translateX(${out * 2400}px)`}}>
            <div style={{fontFamily: UI, fontSize: 30 * u, color: C.text3, letterSpacing: 8 * u, fontWeight: 700}}>
              {scramble < 1 ? 'PLAINTEXT' : 'CIPHERTEXT'}
            </div>
            <div
              style={{
                fontFamily: MONO,
                fontWeight: 800,
                fontSize: (vertical ? 66 : 110) * u * (scramble > 0 ? 0.82 : 1),
                color: scramble > 0.99 ? C.emeraldLight : C.white,
                textShadow: `0 0 30px ${scramble > 0.5 ? C.emerald : C.accent}`,
                padding: `${24 * u}px ${48 * u}px`,
                border: `2px solid ${scramble > 0.5 ? C.emerald : C.accent}66`,
                borderRadius: 24 * u,
                background: 'rgba(8,14,26,0.7)',
                maxWidth: '90%',
                wordBreak: 'break-all',
                textAlign: 'center',
              }}
            >
              {shownText}
              <span style={{opacity: frame % 10 < 5 ? 1 : 0, color: C.accent}}>▌</span>
            </div>
            <div style={{display: 'flex', gap: 24 * u, flexWrap: 'wrap', justifyContent: 'center'}}>
              <div style={{opacity: ramp(beat, 0.5, 1)}}>
                <Tag size={24 * u} text="X25519 KEY EXCHANGE" />
              </div>
              <div style={{opacity: ramp(beat, 1, 1.5)}}>
                <Tag size={24 * u} text="XSALSA20-POLY1305" color={C.purpleLight} />
              </div>
            </div>
          </AbsoluteFill>
        </RGBSplit>
        {beat >= 2 && (
          <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', pointerEvents: 'none'}}>
            <div style={{transform: `scale(${interpolate(lock, [0, 1], [4, 1])}) translateY(${-330 * u}px)`, opacity: Math.min(1, lock * 2) * (1 - out)}}>
              <div style={{width: 120 * u, height: 120 * u, borderRadius: 30 * u, background: C.emerald, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 60px ${C.emerald}`}}>
                <Icon name="lock-closed" size={70 * u} color="#fff" />
              </div>
            </div>
          </AbsoluteFill>
        )}
      </Shake>
      <Flash amount={hit(beat, 2, 4) * 0.8 + out * 0.6} color={beat >= 2 ? '#bbffe6' : '#fff'} />
    </AbsoluteFill>
  );
};

/** Beats 44–48: one media type per beat. */
export const MediaScene: React.FC = () => {
  const beat = useBeat('media');
  const {u, vertical} = useLayout();
  const items: Array<[string, string, string]> = [
    ['PHOTOS', 'image', C.accent],
    ['VIDEOS', 'videocam', C.purple],
    ['VOICE', 'mic', C.emerald],
    ['FILES', 'document-text', C.warning],
  ];
  // the last beat stutters on 8ths through all four again
  const idx = beat < 3 ? step(beat) : step((beat - 3) * 4) % 4;
  const local = beat < 3 ? beat % 1 : ((beat - 3) * 4) % 1;
  const [word, icon, col] = items[Math.min(idx, 3)];
  const k = Math.exp(-local * 5);
  const s = springAt(local, 0, {damping: 10, stiffness: 300});
  return (
    <AbsoluteFill style={{background: `radial-gradient(circle at 50% 50%, ${col}55 0%, ${C.bg} 60%)`}}>
      <CyberBackground hue={col} intensity={0.7} speed={4} />
      <Shake amount={k * 0.6}>
        <Glitch amount={k * 0.4} seed={word}>
          <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', flexDirection: vertical ? 'column' : 'row', gap: 60 * u}}>
            <div
              style={{
                width: 260 * u,
                height: 260 * u,
                borderRadius: 70 * u,
                background: `${col}22`,
                border: `3px solid ${col}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transform: `scale(${0.5 + s * 0.5}) rotate(${(1 - s) * -30}deg)`,
                boxShadow: `0 0 ${80 * u}px ${col}88`,
              }}
            >
              <Icon name={icon} size={140 * u} color={col} />
            </div>
            <div>
              <SlamWord text={word} size={(vertical ? 220 : 300) * u} fringe={k * 1.4} style={{transform: `scale(${1.25 - s * 0.25})`}} />
              <div style={{display: 'flex', alignItems: 'center', gap: 12 * u, justifyContent: 'center', marginTop: 10 * u}}>
                <Icon name="lock-closed" size={26 * u} color={col} />
                <span style={{fontFamily: MONO, fontWeight: 700, fontSize: 26 * u, color: col, letterSpacing: 3 * u}}>AES-256-GCM · BEFORE UPLOAD</span>
              </div>
            </div>
          </AbsoluteFill>
        </Glitch>
      </Shake>
      <Flash amount={k * 0.35} color={col} />
    </AbsoluteFill>
  );
};
