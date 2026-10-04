#!/usr/bin/env node
/**
 * Beat-syncs the trailer to a song.
 *
 *   npm run sync                       # uses public/music.(mp3|wav|m4a|ogg|flac)
 *   npm run sync -- public/song.mp3    # explicit file
 *   npm run sync -- --bpm 130          # force the tempo
 *   npm run sync -- --drop 41.5        # force the drop time (seconds into the song)
 *   npm run sync -- --placeholder      # switch back to the generated beat
 *
 * Detects the tempo and the biggest energy jump (the drop), snaps the drop to
 * the beat grid and writes src/music.json so the drop lands on beat 16 — the
 * moment the VERO logo slams in. Every cut is derived from that grid.
 */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CONFIG = path.join(ROOT, 'src', 'music.json');
const DROP_BEAT = 16; // must match SECTIONS.logo[0] in src/timing.ts
const TRAILER_BEATS = 106;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

if (args.includes('--placeholder')) {
  Object.assign(config, {file: 'placeholder-beat.mp3', bpm: 130, startFrom: 0, source: 'placeholder'});
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
  console.log('Switched back to the placeholder beat.');
  process.exit(0);
}

const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
let file = positional[0];
if (!file) {
  const found = fs.readdirSync(PUBLIC).find((f) => /^music\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i.test(f));
  if (!found) {
    console.error('No song found. Put it at trailer/public/music.mp3 (or pass a path).');
    process.exit(1);
  }
  file = path.join(PUBLIC, found);
}
file = path.resolve(file);
if (!file.startsWith(PUBLIC + path.sep)) {
  const dest = path.join(PUBLIC, 'music' + path.extname(file).toLowerCase());
  fs.copyFileSync(file, dest);
  file = dest;
}

// ── decode ───────────────────────────────────────────────────────────────────
const SR = 11025;
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], {
  maxBuffer: 1 << 30,
});
const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const duration = pcm.length / SR;

// ── onset envelope (low band + full band log-energy flux) ────────────────────
const HOP = 128;
const WIN = 512;
const hopSec = HOP / SR;
const nFrames = Math.floor((pcm.length - WIN) / HOP);
const low = new Float32Array(pcm.length);
{
  const a = Math.exp((-2 * Math.PI * 150) / SR);
  let acc = 0;
  for (let i = 0; i < pcm.length; i++) low[i] = acc = (1 - a) * pcm[i] + a * acc;
}
const eFull = new Float64Array(nFrames);
const eLow = new Float64Array(nFrames);
for (let f = 0; f < nFrames; f++) {
  let s = 0;
  let l = 0;
  for (let i = f * HOP, end = i + WIN; i < end; i++) {
    s += pcm[i] * pcm[i];
    l += low[i] * low[i];
  }
  eFull[f] = Math.log(1e-9 + s);
  eLow[f] = l;
}
const onset = new Float64Array(nFrames);
for (let f = 1; f < nFrames; f++) {
  onset[f] = Math.max(0, eFull[f] - eFull[f - 1]) + 2 * Math.max(0, Math.log(1e-9 + eLow[f]) - Math.log(1e-9 + eLow[f - 1]));
}
const mean = onset.reduce((a, b) => a + b, 0) / nFrames;
for (let f = 0; f < nFrames; f++) onset[f] -= mean;

// ── tempo ────────────────────────────────────────────────────────────────────
const combScore = (bpm) => {
  // sum the onset envelope on a beat grid, best phase wins
  const period = 60 / bpm / hopSec;
  let best = -Infinity;
  for (let ph = 0; ph < period; ph += 1) {
    let s = 0;
    for (let t = ph; t < nFrames; t += period) s += onset[Math.round(t)] ?? 0;
    best = Math.max(best, s);
  }
  return best;
};
let bpm = Number(flag('bpm'));
if (!bpm) {
  let best = {bpm: 0, score: -Infinity};
  for (let b = 70; b <= 180; b += 0.5) {
    // prefer the 100–160 range phonk/funk usually sits in
    const prior = Math.exp(-0.5 * (Math.log2(b / 128) / 0.45) ** 2);
    const score = combScore(b) * (0.6 + 0.4 * prior);
    if (score > best.score) best = {bpm: b, score};
  }
  let fine = best;
  for (let b = best.bpm - 0.6; b <= best.bpm + 0.6; b += 0.02) {
    const score = combScore(b);
    if (score > fine.score) fine = {bpm: b, score};
  }
  bpm = Math.round(fine.bpm * 100) / 100;
}
const beatSec = 60 / bpm;

// ── beat phase (global best grid offset) ────────────────────────────────────
const periodF = beatSec / hopSec;
let phase = 0;
{
  let best = -Infinity;
  for (let ph = 0; ph < periodF; ph += 0.25) {
    let s = 0;
    for (let t = ph; t < nFrames; t += periodF) s += onset[Math.round(t)] ?? 0;
    if (s > best) {
      best = s;
      phase = ph * hopSec;
    }
  }
}

// ── drop: first sustained loud section after a quieter part ────────────────
let drop = Number(flag('drop'));
if (!drop) {
  const beatEnergy = [];
  for (let t = phase; t + beatSec < duration; t += beatSec) {
    const a = Math.floor(t / hopSec);
    const b = Math.floor((t + beatSec) / hopSec);
    let s = 0;
    for (let f = a; f < b && f < nFrames; f++) s += eLow[f];
    beatEnergy.push({t, e: Math.log(1e-9 + s / Math.max(1, b - a))});
  }
  const sorted = beatEnergy.map((b) => b.e).sort((x, y) => x - y);
  const loud = sorted[Math.floor(sorted.length * 0.8)]; // typical drop-level energy
  const e = (i) => Math.max(beatEnergy[i]?.e ?? -Infinity, loud - 4); // clamp silence
  const avg = (from, n) => {
    let s = 0;
    for (let k = 0; k < n; k++) s += e(from + k);
    return s / n;
  };
  const fits = (t) => t >= DROP_BEAT * beatSec - 0.01 && t + (TRAILER_BEATS - DROP_BEAT) * beatSec <= duration + 2;
  const candidates = [];
  for (let i = 4; i < beatEnergy.length - 8; i++) {
    if (!fits(beatEnergy[i].t)) continue;
    // every pair of beats in the next bar-pair must be near drop level
    // (pairs, so off-beats without a kick don't break it)
    let sustained = true;
    for (let k = 0; k < 8; k += 2) if ((e(i + k) + e(i + k + 1)) / 2 < loud - 0.7) sustained = false;
    const contrast = avg(i, 8) - avg(i - 4, 4);
    if (sustained && contrast > 0.5) candidates.push({i, t: beatEnergy[i].t, contrast});
  }
  if (candidates.length) {
    // the first drop is the one people know; within its first few beats,
    // snap to the beat with the hardest bass hit (build-ups often bleed in early)
    const run = candidates.filter((c) => c.i - candidates[0].i <= 3);
    const jump = (c) => e(c.i) - e(c.i - 1) + 0.25 * c.contrast;
    drop = run.reduce((a, b) => (jump(b) > jump(a) ? b : a)).t;
  } else {
    // no clean drop: fall back to the single biggest energy jump
    let best = {t: phase + DROP_BEAT * beatSec, score: -Infinity};
    for (let i = 8; i < beatEnergy.length - 8; i++) {
      if (!fits(beatEnergy[i].t)) continue;
      const score = avg(i, 8) - avg(i - 8, 8);
      if (score > best.score) best = {t: beatEnergy[i].t, score};
    }
    drop = best.t;
  }
}
if (!flag('drop')) {
  // snap to the strongest transient within ±70 ms of the grid position
  const c = Math.round(drop / hopSec);
  const r = Math.round(0.07 / hopSec);
  let bestF = c;
  for (let f = c - r; f <= c + r; f++) if ((onset[f] ?? -Infinity) > (onset[bestF] ?? -Infinity)) bestF = f;
  drop = bestF * hopSec + WIN / SR / 2 - hopSec;
}
const startFrom = Math.max(0, drop - DROP_BEAT * beatSec);

Object.assign(config, {
  file: path.relative(PUBLIC, file).split(path.sep).join('/'),
  bpm,
  startFrom: Math.round(startFrom * 1000) / 1000,
  source: 'synced',
});
fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');

const need = startFrom + TRAILER_BEATS * beatSec;
console.log(`song:       ${path.relative(ROOT, file)} (${duration.toFixed(1)}s)`);
console.log(`tempo:      ${bpm} BPM`);
console.log(`drop:       ${drop.toFixed(2)}s  → lands on beat ${DROP_BEAT} (logo slam)`);
console.log(`trailer:    song ${startFrom.toFixed(2)}s → ${need.toFixed(2)}s`);
if (need > duration) console.warn('warning: the song ends before the trailer does');
console.log('Wrote src/music.json — reopen the studio or run `npm run render`.');
console.log('Not the drop you wanted? Re-run with --drop <seconds> (and --bpm <n>).');
