'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { contentSecurityPolicy, resolveAppFile, deepLinkToRoute, isAppUrl } = require('../security');

test('CSP forbids remote scripts and eval, allows Supabase', () => {
  const csp = contentSecurityPolicy('https://api.example.com javascript:alert(1) wss://rt.example.com');
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.doesNotMatch(csp, /'unsafe-eval'/);
  assert.match(csp, /connect-src [^;]*wss:\/\/\*\.supabase\.co/);
  assert.match(csp, /https:\/\/api\.example\.com/);
  assert.match(csp, /wss:\/\/rt\.example\.com/);
  assert.doesNotMatch(csp, /javascript:/);
  assert.match(csp, /object-src 'none'/);
});

test('app file resolution stays inside the web root and falls back to index.html', () => {
  const root = path.resolve('/srv/web');
  const files = new Set([path.join(root, 'index.html'), path.join(root, '_expo/static/js/web/entry.js')]);
  const exists = (p) => files.has(p);
  assert.equal(resolveAppFile(root, '/_expo/static/js/web/entry.js', exists), path.join(root, '_expo/static/js/web/entry.js'));
  assert.equal(resolveAppFile(root, '/chat/123', exists), path.join(root, 'index.html'));
  assert.equal(resolveAppFile(root, '/../../etc/passwd', exists), path.join(root, 'index.html'));
  assert.equal(resolveAppFile(root, '/%2e%2e/%2e%2e/etc/passwd', exists), path.join(root, 'index.html'));
  assert.equal(resolveAppFile(root, '/%E0%A4%A', exists), path.join(root, 'index.html'));
});

test('only vero://u/<username> deep links are routed', () => {
  assert.equal(deepLinkToRoute('vero://u/Alice_1'), '/u/alice_1');
  assert.equal(deepLinkToRoute('vero://u/alice?fp=123456789012345678901234567890'), '/u/alice?fp=123456789012345678901234567890');
  assert.equal(deepLinkToRoute('vero://u/../../x'), null);
  assert.equal(deepLinkToRoute('vero://settings'), null);
  assert.equal(deepLinkToRoute('https://evil.example/u/alice'), null);
  assert.equal(deepLinkToRoute(undefined), null);
});

test('isAppUrl', () => {
  assert.ok(isAppUrl('app://vero/chat/1'));
  assert.ok(!isAppUrl('app://vero.evil/'));
  assert.ok(!isAppUrl('https://vero/'));
});
