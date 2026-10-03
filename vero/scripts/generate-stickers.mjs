#!/usr/bin/env node
/**
 * Generates Vero's bundled sticker packs (original artwork, drawn here as SVG
 * and rasterised to 512x512 WebP with a transparent background).
 *
 *   npm i --no-save sharp && node scripts/generate-stickers.mjs
 *
 * Output:
 *   assets/stickers/<pack>/<id>.webp
 *   src/features/stickers/bundledAssets.ts   (static require() map for Metro)
 *
 * The artwork is deterministic, so re-running produces the same files.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(process.env.SHARP_FROM ? join(process.env.SHARP_FROM, 'x.js') : join(root, 'x.js'));
let sharp;
try {
  sharp = require('sharp');
} catch {
  console.error('sharp is not installed. Run: npm i --no-save sharp');
  process.exit(1);
}

const NAVY = '#0B1324';
const S = 512;

// ── building blocks ───────────────────────────────────────────────────────────

const wrap = (inner, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
<defs>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity="0.28"/>
  </filter>
  ${defs}
</defs>
<g filter="url(#shadow)">${inner}</g>
</svg>`;

const faceDefs = (a, b) => `<radialGradient id="skin" cx="38%" cy="30%" r="80%">
  <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient>`;

/** Face disc with a white die-cut border. */
const face = (inner, { a = '#7DEBFF', b = '#06B6D4', defs = '' } = {}) => ({
  defs: faceDefs(a, b) + defs,
  body: `<circle cx="256" cy="262" r="206" fill="#fff"/>
<circle cx="256" cy="262" r="190" fill="url(#skin)"/>
<ellipse cx="200" cy="160" rx="70" ry="34" fill="#fff" opacity="0.28" transform="rotate(-20 200 160)"/>
${inner}`,
});

const eye = {
  dot: (x, y = 230, r = 20) => `<ellipse cx="${x}" cy="${y}" rx="${r * 0.85}" ry="${r * 1.15}" fill="${NAVY}"/><circle cx="${x + 6}" cy="${y - 8}" r="${r * 0.3}" fill="#fff"/>`,
  happy: (x, y = 232) => `<path d="M${x - 26} ${y + 8} Q${x} ${y - 26} ${x + 26} ${y + 8}" stroke="${NAVY}" stroke-width="14" fill="none" stroke-linecap="round"/>`,
  closed: (x, y = 236) => `<path d="M${x - 26} ${y - 6} Q${x} ${y + 20} ${x + 26} ${y - 6}" stroke="${NAVY}" stroke-width="12" fill="none" stroke-linecap="round"/>`,
  heart: (x, y = 228, s = 1) => `<path transform="translate(${x} ${y}) scale(${s})" d="M0 30 C-50 -5 -30 -42 0 -20 C30 -42 50 -5 0 30 Z" fill="#FF3B6B" stroke="#fff" stroke-width="5"/>`,
  star: (x, y = 228) => `<path transform="translate(${x} ${y})" d="${starPath(36, 15)}" fill="#FFD23F" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>`,
  round: (x, y = 228) => `<circle cx="${x}" cy="${y}" r="30" fill="#fff"/><circle cx="${x}" cy="${y + 4}" r="16" fill="${NAVY}"/>`,
};

const brow = (x, y, angle, len = 46) =>
  `<line x1="${x - len / 2}" y1="${y}" x2="${x + len / 2}" y2="${y}" stroke="${NAVY}" stroke-width="12" stroke-linecap="round" transform="rotate(${angle} ${x} ${y})"/>`;

const mouth = {
  smile: (w = 70, y = 320) => `<path d="M${256 - w} ${y} Q256 ${y + w * 0.9} ${256 + w} ${y}" stroke="${NAVY}" stroke-width="14" fill="none" stroke-linecap="round"/>`,
  grin: (y = 300) => `<path d="M176 ${y} Q256 ${y + 4} 336 ${y} Q330 ${y + 96} 256 ${y + 98} Q182 ${y + 96} 176 ${y} Z" fill="${NAVY}"/>
<path d="M188 ${y + 4} Q256 ${y + 8} 324 ${y + 4} L320 ${y + 26} Q256 ${y + 32} 192 ${y + 26} Z" fill="#fff"/>
<path d="M214 ${y + 78} Q256 ${y + 52} 298 ${y + 78} Q280 ${y + 96} 256 ${y + 97} Q232 ${y + 96} 214 ${y + 78} Z" fill="#FF6B8A"/>`,
  o: (y = 330, r = 26) => `<ellipse cx="256" cy="${y}" rx="${r * 0.8}" ry="${r}" fill="${NAVY}"/>`,
  frown: (y = 350) => `<path d="M206 ${y} Q256 ${y - 44} 306 ${y}" stroke="${NAVY}" stroke-width="14" fill="none" stroke-linecap="round"/>`,
  flat: (y = 336) => `<line x1="216" y1="${y}" x2="296" y2="${y + 6}" stroke="${NAVY}" stroke-width="13" stroke-linecap="round"/>`,
  wavy: (y = 340) => `<path d="M200 ${y} q14 -16 28 0 t28 0 t28 0 t28 0" stroke="${NAVY}" stroke-width="12" fill="none" stroke-linecap="round"/>`,
  tongue: (y = 318) => `<path d="M196 ${y} Q256 ${y + 56} 316 ${y}" stroke="${NAVY}" stroke-width="14" fill="none" stroke-linecap="round"/>
<path d="M262 ${y + 24} q24 4 30 34 q-4 26 -28 20 q-20 -8 -16 -30 Z" fill="#FF6B8A" stroke="${NAVY}" stroke-width="6"/>`,
  kiss: (y = 334) => `<path d="M246 ${y - 26} q30 4 6 22 q30 6 -4 28" stroke="${NAVY}" stroke-width="12" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  smirk: (y = 330) => `<path d="M212 ${y + 10} Q270 ${y + 28} 310 ${y - 14}" stroke="${NAVY}" stroke-width="14" fill="none" stroke-linecap="round"/>`,
};

const blush = `<ellipse cx="160" cy="300" rx="30" ry="18" fill="#FF6B8A" opacity="0.55"/><ellipse cx="352" cy="300" rx="30" ry="18" fill="#FF6B8A" opacity="0.55"/>`;
const tear = (x, y, s = 1) => `<path transform="translate(${x} ${y}) scale(${s})" d="M0 -28 C14 -6 22 6 22 16 A22 22 0 0 1 -22 16 C-22 6 -14 -6 0 -28 Z" fill="#9BE7FF" stroke="#fff" stroke-width="5"/>`;

function starPath(outer, inner, points = 5) {
  let d = '';
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / points) * i - Math.PI / 2;
    d += `${i === 0 ? 'M' : 'L'}${(r * Math.cos(a)).toFixed(1)} ${(r * Math.sin(a)).toFixed(1)} `;
  }
  return d + 'Z';
}

// ── Pack 1: Vero Faces ────────────────────────────────────────────────────────

const faces = [
  ['grin', '😀', face(eye.dot(196) + eye.dot(316) + mouth.grin())],
  ['joy', '😂', face(eye.happy(196) + eye.happy(316) + mouth.grin(296) + tear(130, 268, 1.1) + tear(382, 268, 1.1))],
  ['love', '😍', face(eye.heart(192) + eye.heart(320) + mouth.smile(66, 322))],
  ['wink', '😜', face(eye.dot(196) + eye.closed(316) + mouth.tongue())],
  [
    'cool',
    '😎',
    face(
      `<path d="M120 206 H392 V224 Q392 290 330 290 Q276 290 270 236 H242 Q236 290 182 290 Q120 290 120 224 Z" fill="${NAVY}"/>
<path d="M146 222 L176 222 L160 260 Z" fill="#fff" opacity="0.35"/><path d="M298 222 L328 222 L312 260 Z" fill="#fff" opacity="0.35"/>` +
        mouth.smirk()
    ),
  ],
  ['wow', '😮', face(brow(196, 170, -8) + brow(316, 170, 8) + eye.round(196) + eye.round(316) + mouth.o(336, 32))],
  ['sad', '😢', face(brow(196, 182, -16) + brow(316, 182, 16) + eye.dot(196, 236, 17) + eye.dot(316, 236, 17) + mouth.frown() + tear(330, 296, 0.9), { a: '#A9C9FF', b: '#4F7FE0' })],
  [
    'cry',
    '😭',
    face(
      eye.closed(196) + eye.closed(316) +
        `<path d="M176 250 Q170 330 160 410" stroke="#9BE7FF" stroke-width="26" fill="none" stroke-linecap="round" opacity="0.95"/>
<path d="M336 250 Q342 330 352 410" stroke="#9BE7FF" stroke-width="26" fill="none" stroke-linecap="round" opacity="0.95"/>` +
        mouth.wavy(342),
      { a: '#A9C9FF', b: '#4F7FE0' }
    ),
  ],
  [
    'angry',
    '😠',
    face(
      brow(196, 196, 22, 60) + brow(316, 196, -22, 60) + eye.dot(200, 244, 17) + eye.dot(312, 244, 17) + mouth.frown(356) +
        `<g transform="translate(372 132)" stroke="#fff" stroke-width="10" stroke-linecap="round"><path d="M-22 -6 q10 -2 14 -14"/><path d="M6 -22 q2 10 14 14"/><path d="M22 6 q-10 2 -14 14"/><path d="M-6 22 q-2 -10 -14 -14"/></g>`,
      { a: '#FFB199', b: '#F0442E' }
    ),
  ],
  [
    'think',
    '🤔',
    face(
      brow(196, 186, -14) + brow(316, 170, 10) + eye.dot(196, 236, 17) + eye.dot(316, 230, 17) + mouth.flat() +
        `<path d="M226 420 q-10 -60 40 -64 q46 -2 46 26 q0 20 -30 22 l-40 4 z" fill="#FFD9A8" stroke="#fff" stroke-width="10"/>
<path d="M266 370 q30 -46 64 -34" stroke="#FFD9A8" stroke-width="26" fill="none" stroke-linecap="round"/>`
    ),
  ],
  [
    'sleepy',
    '😴',
    face(
      eye.closed(196) + eye.closed(316) + mouth.o(334, 16) +
        `<g fill="none" stroke="${NAVY}" stroke-width="11" stroke-linejoin="round" stroke-linecap="round">
<path d="M352 84 h40 l-40 40 h40"/><path d="M410 40 h28 l-28 28 h28"/></g>`,
      { a: '#C9B8FF', b: '#7C5CE0' }
    ),
  ],
  [
    'party',
    '🥳',
    face(
      eye.happy(196) + eye.happy(316) + mouth.grin(300) +
        `<path d="M250 96 L316 -6 L362 112 Z" fill="#FF3B6B" stroke="#fff" stroke-width="10" stroke-linejoin="round" transform="translate(0 30) rotate(18 316 60)"/>
<circle cx="352" cy="22" r="18" fill="#FFD23F" stroke="#fff" stroke-width="6"/>
<rect x="96" y="96" width="18" height="34" rx="6" fill="#FFD23F" transform="rotate(-30 105 113)"/>
<rect x="420" y="190" width="16" height="30" rx="6" fill="#8BFF9C" transform="rotate(25 428 205)"/>
<circle cx="80" cy="220" r="10" fill="#FF3B6B"/><circle cx="440" cy="300" r="9" fill="#7C5CE0"/>`
    ),
  ],
  ['blush', '😊', face(eye.happy(196) + eye.happy(316) + blush + mouth.smile(44, 330))],
  [
    'kiss',
    '😘',
    face(eye.dot(196) + eye.closed(316) + blush + mouth.kiss() + `<g transform="translate(380 360) rotate(18)">${eye.heart(0, 0, 0.9)}</g>`),
  ],
  [
    'sweat',
    '😅',
    face(eye.happy(196) + eye.happy(316) + mouth.grin(300) + tear(372, 160, 1.3)),
  ],
  ['starstruck', '🤩', face(eye.star(192) + eye.star(320) + mouth.grin(304), { a: '#FFE58F', b: '#FFB020' })],
];

// ── Pack 2: Vero Things ───────────────────────────────────────────────────────

const cut = (shape, fill, extra = '') =>
  `<g>${shape.replace('FILL', '#fff').replace(/STROKE/g, 'stroke="#fff" stroke-width="32" stroke-linejoin="round"')}${shape
    .replace('FILL', fill)
    .replace(/STROKE/g, '')}${extra}</g>`;

const HEART = 'M256 440 C40 300 70 90 256 170 C442 90 472 300 256 440 Z';

const things = [
  ['heart', '❤️', { body: cut(`<path d="${HEART}" fill="FILL" STROKE/>`, 'url(#g)', `<ellipse cx="176" cy="200" rx="40" ry="24" fill="#fff" opacity="0.35" transform="rotate(-35 176 200)"/>`), defs: lg('#FF7A9A', '#E8174B') }],
  [
    'broken-heart',
    '💔',
    {
      body: cut(
        `<path d="M246 440 C40 300 70 90 246 170 L226 250 L270 300 L236 440 Z" fill="FILL" STROKE transform="translate(-14 0) rotate(-6 246 300)"/>`,
        'url(#g)'
      ) + cut(`<path d="M266 170 C442 90 472 300 266 440 L296 320 L250 270 Z" fill="FILL" STROKE transform="translate(14 0) rotate(6 266 300)"/>`, 'url(#g)'),
      defs: lg('#FF7A9A', '#E8174B'),
    },
  ],
  [
    'fire',
    '🔥',
    {
      body: cut(`<path d="M256 470 C140 470 92 380 112 300 C130 230 186 210 180 130 C250 160 270 230 262 280 C290 250 300 210 290 170 C380 230 420 330 392 390 C370 440 320 470 256 470 Z" fill="FILL" STROKE/>`, 'url(#g)',
        `<path d="M256 450 C200 450 180 400 196 360 C210 330 240 320 236 280 C290 310 312 360 300 400 C292 430 280 450 256 450 Z" fill="#FFE066"/>`),
      defs: lg('#FFB020', '#F0442E'),
    },
  ],
  ['star', '⭐', { body: cut(`<path transform="translate(256 270)" d="${starPath(210, 92)}" fill="FILL" STROKE/>`, 'url(#g)', `<ellipse cx="220" cy="200" rx="34" ry="18" fill="#fff" opacity="0.4" transform="rotate(-30 220 200)"/>`), defs: lg('#FFE58F', '#FFB020') }],
  [
    'rocket',
    '🚀',
    {
      body: `<g transform="rotate(40 256 256)">` +
        cut(`<path d="M256 40 C330 110 340 220 320 340 H192 C172 220 182 110 256 40 Z" fill="FILL" STROKE/>`, '#EEF4FF',
          `<circle cx="256" cy="190" r="40" fill="#06B6D4" stroke="${NAVY}" stroke-width="10"/>
<path d="M192 300 L130 380 L196 360 Z" fill="#FF3B6B" stroke="#fff" stroke-width="8"/><path d="M320 300 L382 380 L316 360 Z" fill="#FF3B6B" stroke="#fff" stroke-width="8"/>
<path d="M214 350 Q256 480 298 350 Z" fill="#FFB020"/><path d="M234 350 Q256 430 278 350 Z" fill="#FFE066"/>`) + `</g>`,
      defs: '',
    },
  ],
  [
    'coffee',
    '☕',
    {
      body: cut(`<path d="M110 200 H360 V330 Q360 430 235 430 Q110 430 110 330 Z" fill="FILL" STROKE/>`, '#fff',
        `<path d="M360 240 Q440 240 430 300 Q420 350 360 350" stroke="#fff" stroke-width="56" fill="none"/>
<path d="M360 240 Q420 240 412 300 Q404 340 360 340" stroke="#C97B4A" stroke-width="22" fill="none"/>
<path d="M110 200 H360 V330 Q360 430 235 430 Q110 430 110 330 Z" fill="#C97B4A"/>
<ellipse cx="235" cy="204" rx="125" ry="22" fill="#5A321C"/>
<path d="M190 160 q-20 -30 0 -60 q20 -30 0 -60" stroke="#fff" stroke-width="14" fill="none" stroke-linecap="round" opacity="0.9"/>
<path d="M262 160 q-20 -30 0 -60 q20 -30 0 -60" stroke="#fff" stroke-width="14" fill="none" stroke-linecap="round" opacity="0.9"/>`),
      defs: '',
    },
  ],
  [
    'pizza',
    '🍕',
    {
      body: cut(`<path d="M256 470 L90 130 Q256 60 422 130 Z" fill="FILL" STROKE/>`, '#FFD166',
        `<path d="M90 130 Q256 60 422 130 L406 166 Q256 104 106 166 Z" fill="#E0A458"/>
<circle cx="220" cy="210" r="26" fill="#E8174B"/><circle cx="300" cy="230" r="24" fill="#E8174B"/><circle cx="256" cy="320" r="22" fill="#E8174B"/>
<circle cx="180" cy="260" r="8" fill="#2E8B57"/><circle cx="330" cy="290" r="8" fill="#2E8B57"/><circle cx="270" cy="400" r="7" fill="#2E8B57"/>`),
      defs: '',
    },
  ],
  [
    'gift',
    '🎁',
    {
      body: cut(`<rect x="96" y="190" width="320" height="250" rx="22" fill="FILL" STROKE/>`, '#7C5CE0',
        `<rect x="80" y="170" width="352" height="80" rx="18" fill="#9B82F0" stroke="#fff" stroke-width="12"/>
<rect x="232" y="170" width="48" height="270" fill="#FFD23F"/>
<path d="M256 170 C190 90 140 140 180 170 Z M256 170 C322 90 372 140 332 170 Z" fill="#FFD23F" stroke="#fff" stroke-width="10" stroke-linejoin="round"/>`),
      defs: '',
    },
  ],
  [
    'cake',
    '🎂',
    {
      body: cut(`<rect x="96" y="220" width="320" height="220" rx="28" fill="FILL" STROKE/>`, '#FFC2D1',
        `<path d="M96 260 q40 40 80 0 t80 0 t80 0 t80 0 V248 Q416 220 388 220 H124 Q96 220 96 248 Z" fill="#fff"/>
<rect x="96" y="360" width="320" height="22" fill="#FF6B8A"/>
<rect x="244" y="130" width="24" height="90" rx="8" fill="#06B6D4" stroke="#fff" stroke-width="6"/>
<path d="M256 70 Q284 110 256 128 Q228 110 256 70 Z" fill="#FFB020" stroke="#fff" stroke-width="6"/>`),
      defs: '',
    },
  ],
  [
    'balloon',
    '🎈',
    {
      body: cut(`<ellipse cx="256" cy="200" rx="140" ry="160" fill="FILL" STROKE/>`, 'url(#g)',
        `<path d="M240 356 L272 356 L262 376 L250 376 Z" fill="#E8174B"/>
<path d="M256 376 q-30 40 0 70 q30 30 0 60" stroke="#fff" stroke-width="10" fill="none"/>
<ellipse cx="200" cy="130" rx="34" ry="54" fill="#fff" opacity="0.35" transform="rotate(20 200 130)"/>`),
      defs: lg('#FF7A9A', '#E8174B'),
    },
  ],
  ['zap', '⚡', { body: cut(`<path d="M290 40 L120 290 H240 L210 470 L392 210 H272 Z" fill="FILL" STROKE/>`, 'url(#g)'), defs: lg('#FFE066', '#FFB020') }],
  [
    'check',
    '✅',
    {
      body: cut(`<circle cx="256" cy="256" r="196" fill="FILL" STROKE/>`, 'url(#g)',
        `<path d="M160 262 L230 332 L360 192" stroke="#fff" stroke-width="44" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
      defs: lg('#5EE6A0', '#10B981'),
    },
  ],
  [
    'sun',
    '☀️',
    {
      body: `<g>${Array.from({ length: 12 }, (_, i) => `<path transform="rotate(${i * 30} 256 256)" d="M240 50 L272 50 L264 120 L248 120 Z" fill="#FFB020" stroke="#fff" stroke-width="8" stroke-linejoin="round"/>`).join('')}</g>` +
        cut(`<circle cx="256" cy="256" r="136" fill="FILL" STROKE/>`, 'url(#g)',
          eye.happy(214, 248) + eye.happy(298, 248) + `<path d="M216 300 Q256 336 296 300" stroke="${NAVY}" stroke-width="12" fill="none" stroke-linecap="round"/>`),
      defs: lg('#FFE58F', '#FFB020'),
    },
  ],
  [
    'moon',
    '🌙',
    {
      body: cut(`<path d="M300 60 A200 200 0 1 0 452 330 A160 160 0 1 1 300 60 Z" fill="FILL" STROKE/>`, 'url(#g)',
        `<path transform="translate(400 110)" d="${starPath(30, 12)}" fill="#FFE066" stroke="#fff" stroke-width="5"/>
<path transform="translate(440 210)" d="${starPath(20, 8)}" fill="#FFE066" stroke="#fff" stroke-width="4"/>`),
      defs: lg('#C9B8FF', '#7C5CE0'),
    },
  ],
  [
    'vero-shield',
    '🔒',
    {
      body: cut(`<path d="M256 40 L430 104 V250 Q430 400 256 470 Q82 400 82 250 V104 Z" fill="FILL" STROKE/>`, 'url(#g)',
        `<rect x="186" y="236" width="140" height="110" rx="20" fill="#fff"/>
<path d="M212 236 V200 A44 44 0 0 1 300 200 V236" stroke="#fff" stroke-width="22" fill="none"/>
<circle cx="256" cy="282" r="16" fill="${NAVY}"/><rect x="249" y="286" width="14" height="34" rx="6" fill="${NAVY}"/>`),
      defs: lg('#7DEBFF', '#0E7490'),
    },
  ],
  [
    'sparkles',
    '✨',
    {
      body: cut(`<path transform="translate(220 280)" d="${fourStar(170)}" fill="FILL" STROKE/>`, 'url(#g)') +
        cut(`<path transform="translate(390 120)" d="${fourStar(80)}" fill="FILL" STROKE/>`, 'url(#g)') +
        cut(`<path transform="translate(400 400)" d="${fourStar(56)}" fill="FILL" STROKE/>`, 'url(#g)'),
      defs: lg('#FFE58F', '#FFB020'),
    },
  ],
];

function fourStar(r) {
  const k = r * 0.22;
  return `M0 ${-r} Q${k} ${-k} ${r} 0 Q${k} ${k} 0 ${r} Q${-k} ${k} ${-r} 0 Q${-k} ${-k} 0 ${-r} Z`;
}

function lg(a, b) {
  return `<linearGradient id="g" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
}

// ── write ─────────────────────────────────────────────────────────────────────

const packs = [
  { id: 'vero-faces', items: faces },
  { id: 'vero-things', items: things },
];

mkdirSync(join(root, 'src', 'features', 'stickers'), { recursive: true });
const manifest = [];
for (const pack of packs) {
  const dir = join(root, 'assets', 'stickers', pack.id);
  mkdirSync(dir, { recursive: true });
  for (const [id, emoji, art] of pack.items) {
    const svg = wrap(art.body, art.defs);
    const out = join(dir, `${id}.webp`);
    await sharp(Buffer.from(svg)).resize(S, S).webp({ quality: 82, alphaQuality: 90, effort: 6 }).toFile(out);
    manifest.push({ pack: pack.id, id, emoji });
  }
}

const lines = manifest.map(
  (m) => `  '${m.pack}/${m.id}': require('../../../assets/stickers/${m.pack}/${m.id}.webp'),`
);
writeFileSync(
  join(root, 'src', 'features', 'stickers', 'bundledAssets.ts'),
  `// GENERATED by scripts/generate-stickers.mjs - do not edit by hand.
// Static require() calls so Metro bundles every sticker image.

/* eslint-disable @typescript-eslint/no-require-imports */
export const BUNDLED_STICKER_ASSETS: Record<string, number> = {
${lines.join('\n')}
};
`
);
console.log(`Generated ${manifest.length} stickers.`);
