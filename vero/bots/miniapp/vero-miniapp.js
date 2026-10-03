// Vero mini-app client. Include it in your mini-app page (required on web/desktop;
// the mobile app also injects it). Generated from src/features/bots/miniAppBridge.ts
// by scripts/write-miniapp-client.ts - do not edit by hand.
(function () {
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
})();
