// Renders individual frames for quick review: node scripts/stills.mjs <comp> <outDir> <frame...>
import {bundle} from '@remotion/bundler';
import {renderStill, selectComposition} from '@remotion/renderer';
import path from 'node:path';

const [comp = 'VeroTrailer', outDir = 'out/stills', ...frames] = process.argv.slice(2);
const serveUrl = await bundle({entryPoint: path.resolve('src/index.ts')});
const browserExecutable = process.env.REMOTION_BROWSER ?? null;
const composition = await selectComposition({serveUrl, id: comp, browserExecutable});
for (const f of frames.map(Number)) {
  const output = path.join(outDir, `${comp}-${String(f).padStart(4, '0')}.jpg`);
  await renderStill({composition, serveUrl, frame: f, output, imageFormat: 'jpeg', jpegQuality: 80, browserExecutable, scale: 0.5});
  console.log(output);
}
