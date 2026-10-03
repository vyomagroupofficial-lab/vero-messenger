// Pure helpers for the Electron main process (unit-tested in test/security.test.js).
'use strict';

const path = require('node:path');

const APP_ORIGIN = 'app://vero';

/**
 * Content-Security-Policy for the bundled web app.
 * - scripts: only our own files (+ WebAssembly for libsodium / SQLite / QR decoding)
 * - network: Supabase (REST + realtime websockets), plus extra origins from
 *   VERO_CSP_CONNECT (space separated) for self-hosted backends, plus the CDN
 *   the web barcode scanner loads its WebAssembly decoder from.
 */
function contentSecurityPolicy(extraConnect = '') {
  const connect = [
    "'self'",
    'https://*.supabase.co',
    'wss://*.supabase.co',
    'https://fastly.jsdelivr.net',
    ...extraConnect.split(/\s+/).filter((s) => /^(https|wss):\/\/[a-z0-9.*:-]+$/i.test(s)),
  ];
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    `connect-src ${connect.join(' ')}`,
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: mediastream:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Maps a request path of app://vero/<path> to a file inside `root`.
 * Unknown paths (client-side routes) fall back to index.html. Never escapes root.
 */
function resolveAppFile(root, urlPath, exists) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return path.join(root, 'index.html');
  }
  const rel = path.posix.normalize('/' + decoded).replace(/^\/+/, '');
  const candidate = path.join(root, rel);
  if (!candidate.startsWith(path.resolve(root) + path.sep) && candidate !== path.resolve(root)) {
    return path.join(root, 'index.html');
  }
  if (rel && exists(candidate)) return candidate;
  return path.join(root, 'index.html');
}

/** vero://u/<username>[?fp=...] -> app route, or null for anything else. */
function deepLinkToRoute(url) {
  const m = /^vero:\/\/u\/([a-z0-9_]{3,30})\/?(?:\?fp=(\d{30}))?$/i.exec(String(url || '').trim());
  if (!m) return null;
  return `/u/${m[1].toLowerCase()}${m[2] ? `?fp=${m[2]}` : ''}`;
}

function isAppUrl(url) {
  return typeof url === 'string' && (url === APP_ORIGIN || url.startsWith(APP_ORIGIN + '/'));
}

module.exports = { APP_ORIGIN, contentSecurityPolicy, resolveAppFile, deepLinkToRoute, isAppUrl };
