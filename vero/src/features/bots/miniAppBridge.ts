/**
 * Mini-app JS bridge (pure, unit-tested).
 *
 * A bot can attach an https mini-app. Vero shows it in a WebView (native) or
 * a sandboxed iframe (web) and exposes a deliberately tiny API:
 *
 *   Vero.close()            closes the sheet
 *   Vero.getUser()          -> { displayName, id } after the user consents;
 *                              `id` is opaque and different for every bot
 *   Vero.sendData(json)     posts an E2EE message ({t:'bot_data'}) to the
 *                              bot chat; max 4 KB of JSON
 *
 * The page never gets keys, tokens, the real user id or other chats.
 * Navigation is locked to the origin of the bot's registered mini-app URL.
 */

import type { Sodium } from '../../core/crypto/primitives';
import { MAX_BOT_DATA_BYTES, utf8Length } from '../../shared/models/payloadExtensions';

export type BridgeRequest =
  | { id: string; method: 'close' }
  | { id: string; method: 'getUser' }
  | { id: string; method: 'sendData'; data: string };

export type BridgeResponse = { vero: 1; id: string; ok: true; result: unknown } | { vero: 1; id: string; ok: false; error: string };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validates one message from the page. Accepts the raw WebView string or a
 * postMessage object. Returns null for anything malformed or unknown.
 */
export function parseBridgeMessage(raw: unknown): BridgeRequest | null {
  let msg: any = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_BOT_DATA_BYTES * 2 + 512) return null;
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!msg || typeof msg !== 'object' || msg.vero !== 1 || typeof msg.id !== 'string' || !ID_RE.test(msg.id)) return null;
  switch (msg.method) {
    case 'close':
    case 'getUser':
      return { id: msg.id, method: msg.method };
    case 'sendData': {
      if (msg.data === undefined || typeof msg.data === 'function') return null;
      let data: string | undefined;
      try {
        data = JSON.stringify(msg.data);
      } catch {
        return null;
      }
      if (typeof data !== 'string' || utf8Length(data) > MAX_BOT_DATA_BYTES) return null;
      return { id: msg.id, method: 'sendData', data };
    }
    default:
      return null;
  }
}

/** Lower-cased https origin ("https://host[:port]"), or null. */
export function httpsOrigin(url: string): string | null {
  const m = /^https:\/\/([a-z0-9.-]+(:\d{1,5})?)(?=[/?#]|$)/i.exec(url);
  return m ? `https://${m[1].toLowerCase()}` : null;
}

/** The WebView may only show pages from the mini-app's own origin. */
export function isAllowedNavigation(url: string, miniAppUrl: string): boolean {
  if (url === 'about:blank') return true;
  const a = httpsOrigin(url);
  return !!a && a === httpsOrigin(miniAppUrl);
}

/** Stable, per-bot pseudonymous id: the page can't learn or correlate the real user id. */
export function opaqueUserId(sodium: Sodium, userId: string, botUserId: string): string {
  return sodium.to_hex(sodium.crypto_generichash(16, `vero/miniapp/v1|${botUserId}|${userId}`, null));
}

export function bridgeResponse(id: string, result: { ok: true; result: unknown } | { ok: false; error: string }): BridgeResponse {
  return { vero: 1, id, ...result } as BridgeResponse;
}

/** JS evaluated in the WebView to deliver a response (JSON is a JS literal; line separators escaped). */
export function responseInjection(resp: BridgeResponse): string {
  const json = JSON.stringify(resp).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `window.__veroBridge && window.__veroBridge.receive(${json}); true;`;
}

/**
 * The page-side client. Injected before content loads in native WebViews;
 * web mini-apps include the same file (bots/miniapp/vero-miniapp.js) because
 * a cross-origin iframe can't be injected into.
 */
export const BRIDGE_CLIENT_JS = `(function () {
  if (window.Vero && window.__veroBridge) return;
  var pending = {};
  var seq = 0;
  function post(msg) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, '*');
    } else {
      throw new Error('Not running inside Vero');
    }
  }
  function call(method, data) {
    return new Promise(function (resolve, reject) {
      var id = 'r' + (++seq) + '_' + Date.now().toString(36);
      pending[id] = { resolve: resolve, reject: reject };
      var msg = { vero: 1, id: id, method: method };
      if (data !== undefined) msg.data = data;
      try { post(msg); } catch (e) { delete pending[id]; reject(e); }
    });
  }
  window.__veroBridge = {
    receive: function (resp) {
      if (!resp || resp.vero !== 1 || !pending[resp.id]) return;
      var p = pending[resp.id];
      delete pending[resp.id];
      if (resp.ok) p.resolve(resp.result); else p.reject(new Error(resp.error));
    }
  };
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    window.__veroBridge.receive(event.data);
  });
  window.Vero = {
    close: function () { return call('close'); },
    getUser: function () { return call('getUser'); },
    sendData: function (data) { return call('sendData', data); }
  };
})();`;
