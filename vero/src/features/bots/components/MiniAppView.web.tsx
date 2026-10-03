/**
 * Web/desktop mini-app host: a sandboxed cross-origin iframe. The page must
 * include bots/miniapp/vero-miniapp.js (it can't be injected cross-origin).
 * Messages are accepted only from this iframe's window AND the mini-app's
 * origin; responses are posted back to that origin only.
 */

import React, { useEffect, useRef } from 'react';
import { BridgeRequest, BridgeResponse, httpsOrigin, parseBridgeMessage } from '../miniAppBridge';

export function MiniAppView({ url, onRequest }: { url: string; onRequest: (req: BridgeRequest) => Promise<BridgeResponse> }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const origin = httpsOrigin(url);

  useEffect(() => {
    if (!origin) return;
    const listener = (event: MessageEvent) => {
      if (event.origin.toLowerCase() !== origin || event.source !== frame.current?.contentWindow) return;
      const req = parseBridgeMessage(event.data);
      if (!req) return;
      void onRequest(req)
        .catch(() => ({ vero: 1 as const, id: req.id, ok: false as const, error: 'Request failed' }))
        .then((resp) => frame.current?.contentWindow?.postMessage(resp, origin));
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [origin, onRequest]);

  if (!origin) return null;
  return React.createElement('iframe', {
    ref: frame,
    src: url,
    title: 'Mini-app',
    // allow-same-origin keeps the page's OWN origin (needed for event.origin
    // checks); it's cross-origin to Vero, so it still can't touch the app.
    // No allow-top-navigation / allow-popups.
    sandbox: 'allow-scripts allow-forms allow-same-origin',
    referrerPolicy: 'no-referrer',
    allow: '',
    style: { flex: 1, width: '100%', height: '100%', border: 0, backgroundColor: '#fff' },
  });
}
