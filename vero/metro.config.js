// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// expo-sqlite on web runs SQLite as WebAssembly in a worker.
config.resolver.assetExts.push('wasm');

// ...which needs SharedArrayBuffer, i.e. a cross-origin isolated page.
config.server.enhanceMiddleware = (middleware) => (req, res, next) => {
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  middleware(req, res, next);
};

// The Electron wrapper (desktop/) has its own dependencies and build output.
config.resolver.blockList = [].concat(config.resolver.blockList || [], [/[\\/]desktop[\\/](node_modules|release)[\\/].*/]);

module.exports = config;
