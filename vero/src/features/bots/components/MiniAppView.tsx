/**
 * Native mini-app host (react-native-webview).
 *   - only https pages from the mini-app's own origin may load
 *   - incognito: no cookies/storage shared with anything else
 *   - the bridge client is injected before the page's own scripts
 *   - messages are accepted only from frames on the allowed origin
 */

import React, { useRef } from 'react';
import { Linking, StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { BRIDGE_CLIENT_JS, BridgeRequest, BridgeResponse, isAllowedNavigation, parseBridgeMessage, responseInjection } from '../miniAppBridge';

export function MiniAppView({ url, onRequest }: { url: string; onRequest: (req: BridgeRequest) => Promise<BridgeResponse> }) {
  const ref = useRef<WebView>(null);

  const onMessage = (event: WebViewMessageEvent) => {
    if (!isAllowedNavigation(event.nativeEvent.url, url)) return;
    const req = parseBridgeMessage(event.nativeEvent.data);
    if (!req) return;
    void onRequest(req)
      .catch(() => ({ vero: 1 as const, id: req.id, ok: false as const, error: 'Request failed' }))
      .then((resp) => ref.current?.injectJavaScript(responseInjection(resp)));
  };

  return (
    <WebView
      ref={ref}
      source={{ uri: url }}
      style={styles.web}
      originWhitelist={['https://*']}
      onShouldStartLoadWithRequest={(req) => {
        if (isAllowedNavigation(req.url, url)) return true;
        // Other https links open in the system browser, never inside the sheet.
        if (req.isTopFrame !== false && /^https:\/\//i.test(req.url)) void Linking.openURL(req.url);
        return false;
      }}
      injectedJavaScriptBeforeContentLoaded={BRIDGE_CLIENT_JS}
      onMessage={onMessage}
      javaScriptEnabled
      incognito
      allowFileAccess={false}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      mixedContentMode="never"
      allowsLinkPreview={false}
      mediaPlaybackRequiresUserAction
      geolocationEnabled={false}
    />
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: '#fff' },
});
