#!/usr/bin/env node
// Real-browser check of the web call stack (optional; needs Playwright +
// Chromium, not part of `npm test`):
//   node scripts/calls-browser-check.mjs
// Bundles tests/browser/callsHarness.ts with esbuild and runs it in headless
// Chromium with fake camera/microphone: real RTCPeerConnections, real
// libsodium-sealed signalling, mesh of 3, renegotiation, screen share via
// replaceTrack, glare, leave. Set PLAYWRIGHT_MODULE to Playwright's path if
// it isn't resolvable from here.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let playwright;
try {
  playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch {
  console.log('SKIP: playwright is not installed (npm i -g playwright && npx playwright install chromium)');
  process.exit(0);
}
const chromium = playwright.chromium ?? playwright.default?.chromium;

const bundle = await build({
  entryPoints: [path.join(root, 'tests/browser/callsHarness.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'error',
});
const js = bundle.outputFiles[0].text;

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.route('http://localhost/**', (route) =>
    route.request().url().endsWith('.js')
      ? route.fulfill({ contentType: 'text/javascript', body: js })
      : route.fulfill({ contentType: 'text/html', body: '<!doctype html><script src="/harness.js"></script>' })
  );
  await page.goto('http://localhost/');
  const results = await page.evaluate(() => window.runCallsCheck());
  for (const line of results) console.log(line);
  console.log('ALL BROWSER CALL CHECKS PASSED');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
