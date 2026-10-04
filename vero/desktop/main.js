// Vero Desktop: Electron shell around the exported Expo web build.
//
// Security posture
//   * renderer: contextIsolation, sandbox, no Node integration, webSecurity on
//   * the app is served from a private app://vero origin (never file://) with a
//     strict CSP; navigation away from it is blocked, external links open in
//     the system browser, new windows are denied
//   * only camera/microphone (QR scanning, calls) and notifications may be
//     granted to the app origin; everything else is denied
//   * single instance; vero:// deep links are routed to the running window
'use strict';

const { app, BrowserWindow, protocol, net, session, shell, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startAutoUpdates } = require('./updater');
const { APP_ORIGIN, contentSecurityPolicy, resolveAppFile, deepLinkToRoute, isAppUrl } = require('./security');

const WEB_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(__dirname, '..', 'dist');
const CSP = contentSecurityPolicy(process.env.VERO_CSP_CONNECT || '');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Register as the handler for vero:// links.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('vero', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('vero');
}
if (process.platform === 'win32') app.setAppUserModelId('com.vero.messenger.desktop');

let mainWindow = null;
let pendingRoute = deepLinkToRoute(process.argv.find((a) => a.startsWith('vero://')));

function openRoute(route) {
  if (!route) return;
  if (!mainWindow) {
    pendingRoute = route;
    return;
  }
  void mainWindow.loadURL(APP_ORIGIN + route);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

app.on('second-instance', (_event, argv) => {
  openRoute(deepLinkToRoute(argv.find((a) => a.startsWith('vero://'))));
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// macOS delivers deep links here.
app.on('open-url', (event, url) => {
  event.preventDefault();
  openRoute(deepLinkToRoute(url));
});

function serveApp() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'vero') return new Response('Not found', { status: 404 });
    const file = resolveAppFile(WEB_ROOT, url.pathname, (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CSP);
    // expo-sqlite (WebAssembly in a worker) needs a cross-origin isolated page.
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('X-Content-Type-Options', 'nosniff');
    if (file.endsWith('.webmanifest')) headers.set('Content-Type', 'application/manifest+json');
    return new Response(response.body, { status: response.status, headers });
  });
}

function lockDownSession() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isAppUrl(webContents.getURL()) && allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_webContents, permission, origin) => isAppUrl(origin) && allowed.has(permission));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#050A14',
    title: 'Vero',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // No pop-ups; https links open in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    else {
      const route = deepLinkToRoute(url);
      if (route) openRoute(route);
    }
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const route = pendingRoute || '/';
  pendingRoute = null;
  void mainWindow.loadURL(APP_ORIGIN + route);
}

app.whenReady().then(() => {
  if (!fs.existsSync(path.join(WEB_ROOT, 'index.html'))) {
    console.error(`[vero-desktop] Web build not found at ${WEB_ROOT}. Run "npm run web:export" first.`);
  }
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  lockDownSession();
  serveApp();
  createWindow();
  startAutoUpdates(() => mainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Defence in depth: no other web contents may run with Node or open windows.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
