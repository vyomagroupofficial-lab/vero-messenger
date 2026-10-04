import {continueRender, delayRender, staticFile} from 'remotion';

// Fonts are bundled in public/fonts (all SIL Open Font License) so renders
// work offline and never depend on a CDN being reachable.
const FONTS: Array<[family: string, file: string, weight: string]> = [
  ['Inter', 'Inter.woff2', '100 900'],
  ['Anton', 'Anton.woff2', '400'],
  ['JetBrains Mono', 'JetBrainsMono.woff2', '100 800'],
  ['Unbounded', 'Unbounded.woff2', '200 900'],
];

if (typeof document !== 'undefined') {
  const handle = delayRender('Loading fonts');
  Promise.all(
    FONTS.map(([family, file, weight]) => {
      const face = new FontFace(family, `url(${staticFile(`fonts/${file}`)}) format('woff2')`, {weight});
      document.fonts.add(face);
      return face.load();
    }),
  )
    .then(() => continueRender(handle))
    .catch((err) => {
      console.error(err);
      continueRender(handle);
    });
}

export const UI = 'Inter, system-ui, sans-serif';
export const DISPLAY = 'Anton, Impact, sans-serif';
export const MONO = "'JetBrains Mono', monospace";
export const WIDE = 'Unbounded, Inter, sans-serif';
