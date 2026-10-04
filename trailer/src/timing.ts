import {useCurrentFrame} from 'remotion';
import music from './music.json';

export const FPS = 30;
export const BPM: number = music.bpm;
export const FRAMES_PER_BEAT = (60 / BPM) * FPS;

/** Frame on which beat `b` lands (b may be fractional). */
export const bf = (b: number) => Math.round(b * FRAMES_PER_BEAT);

/**
 * Song structure, in beats. Beat 16 is "the drop" — `npm run sync` lines the
 * song's drop up with it. Every cut in the trailer is derived from this map.
 */
export const SECTIONS = {
  intro: [0, 16],
  logo: [16, 24],
  chats: [24, 32],
  chat: [32, 40],
  cipher: [40, 44],
  media: [44, 48],
  calls: [48, 56],
  safety: [56, 64],
  vanish: [64, 72],
  zk: [72, 80],
  montage: [80, 88],
  finale: [88, 104],
} as const satisfies Record<string, readonly [number, number]>;

export type SectionName = keyof typeof SECTIONS;
export const TOTAL_BEATS = 104;
export const TAIL_FRAMES = FPS; // let the last hit ring out
export const DURATION = bf(TOTAL_BEATS) + TAIL_FRAMES;

/**
 * Beats elapsed since the start of a section, as a float, computed from the
 * section's absolute start so rounding never drifts away from the music.
 */
export const useBeat = (section: SectionName) => {
  const frame = useCurrentFrame();
  const start = SECTIONS[section][0];
  return (frame + bf(start)) / FRAMES_PER_BEAT - start;
};

/** 1 on every beat, decaying towards 0 before the next one. */
export const pulse = (beat: number, decay = 6, every = 1) => {
  if (beat < 0) return 0;
  const phase = (beat / every) % 1;
  return Math.exp(-phase * every * decay);
};

/** Index of the current step when cutting every `every` beats. */
export const step = (beat: number, every = 1) => Math.max(0, Math.floor(beat / every));
