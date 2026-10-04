// In-app updates for the desktop app, from GitHub Releases (electron-updater).
//   Windows (NSIS) and Linux (AppImage): download in the background, then offer
//   "Restart to update".
//   macOS builds are unsigned, so Squirrel.Mac can't install updates: we only
//   check, and offer to open the download page.
const { app, dialog, shell } = require('electron');

const RELEASES_URL = 'https://github.com/vyomagroupofficial-lab/vero-messenger/releases/latest';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function startAutoUpdates(getWindow) {
  if (!app.isPackaged) return; // dev builds have nothing to update from
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.warn('[vero-desktop] electron-updater unavailable:', e);
    return;
  }
  const manualInstall = process.platform === 'darwin' || (process.platform === 'linux' && !process.env.APPIMAGE);
  autoUpdater.autoDownload = !manualInstall;
  autoUpdater.autoInstallOnAppQuit = !manualInstall;

  autoUpdater.on('update-available', async (info) => {
    if (!manualInstall) return; // downloading in the background
    const { response } = await dialog.showMessageBox(getWindow(), {
      type: 'info',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      message: `Vero ${info.version} is available`,
      detail: 'Open the download page to get the new version.',
    });
    if (response === 0) void shell.openExternal(RELEASES_URL);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox(getWindow(), {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      message: `Vero ${info.version} is ready to install`,
      detail: 'Restart Vero to finish updating. Otherwise it installs the next time you quit.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (e) => console.warn('[vero-desktop] update check failed:', e?.message ?? e));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10_000);
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = { startAutoUpdates };
