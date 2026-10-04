import React from 'react';
import {AbsoluteFill, Audio, interpolate, Sequence, staticFile} from 'remotion';
import music from './music.json';
import {bf, DURATION, FPS, SECTIONS, SectionName} from './timing';
import {FilmOverlay} from './fx';
import {Intro, LogoDrop} from './scenes/Open';
import {ChatScene, ChatsScene, CipherScene, MediaScene} from './scenes/Features';
import {CallsScene, SafetyScene, VanishScene, ZeroKnowledgeScene} from './scenes/Security';
import {FinaleScene, MontageScene} from './scenes/Finale';
import './fonts';

const SCENES: Record<SectionName, React.FC> = {
  intro: Intro,
  logo: LogoDrop,
  chats: ChatsScene,
  chat: ChatScene,
  cipher: CipherScene,
  media: MediaScene,
  calls: CallsScene,
  safety: SafetyScene,
  vanish: VanishScene,
  zk: ZeroKnowledgeScene,
  montage: MontageScene,
  finale: FinaleScene,
};

// Sound design hits, in beats. They sit on top of whatever song is used.
const SFX: Array<[number, 'impact' | 'whoosh' | 'glitch' | 'riser', number?]> = [
  [9, 'glitch'], [10, 'glitch'], [11, 'glitch'],
  [12, 'riser', 0.5],
  [16, 'impact'],
  [23.4, 'whoosh'], [31.4, 'whoosh'], [39.5, 'whoosh'], [42, 'impact', 0.5],
  [47.4, 'whoosh'], [55.4, 'whoosh'], [61, 'impact', 0.6], [63.5, 'whoosh'],
  [68, 'glitch'], [71.5, 'whoosh'], [76, 'impact', 0.5], [79.5, 'whoosh'],
  [88, 'impact'],
];

export const Trailer: React.FC = () => {
  const lastSection = Object.keys(SECTIONS).length - 1;
  return (
    <AbsoluteFill style={{background: '#000'}}>
      {(Object.keys(SECTIONS) as SectionName[]).map((name, i) => {
        const [a, b] = SECTIONS[name];
        const Scene = SCENES[name];
        const from = bf(a);
        const dur = (i === lastSection ? DURATION : bf(b)) - from;
        return (
          <Sequence key={name} from={from} durationInFrames={dur} name={name}>
            <Scene />
          </Sequence>
        );
      })}
      <FilmOverlay />
      <Audio
        src={staticFile(music.file)}
        trimBefore={Math.round(music.startFrom * FPS)}
        volume={(f) =>
          music.musicVolume * interpolate(f, [DURATION - bf(3), DURATION], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
        }
      />
      {music.sfxVolume > 0 &&
        SFX.map(([at, name, vol = 1], i) => (
          <Sequence key={i} from={bf(at)} durationInFrames={FPS * 3} name={`sfx ${name}`} layout="none">
            <Audio src={staticFile(`sfx/${name}.wav`)} volume={music.sfxVolume * vol} />
          </Sequence>
        ))}
    </AbsoluteFill>
  );
};
