/**
 * Voice-note waveform helpers (pure, unit-tested).
 *
 * The recorder samples the input level (dBFS, from expo-audio metering) a few
 * times per second. We normalise each sample to 0..1 and downsample the whole
 * recording to a fixed number of peaks, which travel (encrypted) inside the
 * message payload as integers 0..WAVEFORM_MAX.
 */

export const WAVEFORM_BARS = 64;
export const WAVEFORM_MAX = 100;
/** Anything quieter than this is drawn as silence. */
export const METERING_FLOOR_DB = -60;

/** Maps a metering value in dBFS (-160..0) to 0..1. Non-finite input is silence. */
export function meteringToLevel(db: number | null | undefined, floorDb = METERING_FLOOR_DB): number {
  if (typeof db !== 'number' || !Number.isFinite(db)) return 0;
  if (db >= 0) return 1;
  if (db <= floorDb) return 0;
  // Linear in dB reads better than amplitude for speech.
  return (db - floorDb) / -floorDb;
}

/**
 * Reduces `samples` (levels 0..1) to exactly `bars` peaks scaled to
 * 0..WAVEFORM_MAX integers. Each output bar takes the MAX of its bucket, so
 * short syllables are not averaged away. With fewer samples than bars, the
 * samples are stretched (nearest neighbour). The result is normalised so the
 * loudest bar is full height (a quiet recording still shows its shape).
 */
export function downsampleWaveform(samples: readonly number[], bars = WAVEFORM_BARS): number[] {
  if (!Number.isInteger(bars) || bars <= 0) return [];
  const clean = samples.map((v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0));
  if (clean.length === 0) return new Array(bars).fill(0);

  const out: number[] = new Array(bars);
  for (let i = 0; i < bars; i++) {
    const start = Math.floor((i * clean.length) / bars);
    const end = Math.max(start + 1, Math.floor(((i + 1) * clean.length) / bars));
    let peak = 0;
    for (let j = start; j < end && j < clean.length; j++) peak = Math.max(peak, clean[j]);
    out[i] = peak;
  }

  const loudest = Math.max(...out);
  return out.map((v) => (loudest > 0 ? Math.round((v / loudest) * WAVEFORM_MAX) : 0));
}

/** Validates a waveform received from someone else; returns undefined if unusable. */
export function sanitizeWaveform(raw: unknown, maxBars = 256): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > maxBars) return undefined;
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > WAVEFORM_MAX) return undefined;
    out.push(v);
  }
  return out;
}

/** Resamples a stored waveform to the number of bars the UI has room for. */
export function resampleForDisplay(waveform: readonly number[] | undefined, bars: number): number[] {
  if (!waveform?.length || bars <= 0) return new Array(Math.max(0, bars)).fill(0);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const start = Math.floor((i * waveform.length) / bars);
    const end = Math.max(start + 1, Math.floor(((i + 1) * waveform.length) / bars));
    let peak = 0;
    for (let j = start; j < end && j < waveform.length; j++) peak = Math.max(peak, waveform[j]);
    out.push(peak);
  }
  return out;
}

/** mm:ss (or h:mm:ss) for durations in milliseconds. */
export function formatDuration(ms: number | undefined): string {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Voice-note playback speeds, cycled by the speed button. */
export const PLAYBACK_RATES = [1, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export function nextRate(rate: number): PlaybackRate {
  const i = PLAYBACK_RATES.indexOf(rate as PlaybackRate);
  return PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length];
}
