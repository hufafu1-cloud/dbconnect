const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const { getUpdateUrl, isConfigured } = require('./updateConfig');

let targetWindow = null;
let configured = false;

function updateInfo(info) {
  if (!info) return null;
  return {
    version: info.version || '',
    releaseDate: info.releaseDate || '',
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
  };
}

function send(event, payload = {}) {
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send('app:update', { event, ...payload });
  }
}

function setup(win) {
  targetWindow = win;
  const url = getUpdateUrl();
  configured = !!(app.isPackaged && !process.argv.includes('--smoke')
    && !process.argv.includes('--selftest') && !process.argv.includes('--demo')
    && isConfigured(url));
  if (!configured) return false;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({ provider: 'generic', url });
  autoUpdater.removeAllListeners('checking-for-update');
  autoUpdater.removeAllListeners('update-available');
  autoUpdater.removeAllListeners('update-not-available');
  autoUpdater.removeAllListeners('download-progress');
  autoUpdater.removeAllListeners('update-downloaded');
  autoUpdater.removeAllListeners('error');
  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) => send('available', { info: updateInfo(info) }));
  autoUpdater.on('update-not-available', (info) => send('not-available', { info: updateInfo(info) }));
  autoUpdater.on('download-progress', (progress) => send('progress', {
    percent: Number(progress.percent || 0),
    transferred: Number(progress.transferred || 0),
    total: Number(progress.total || 0),
    bytesPerSecond: Number(progress.bytesPerSecond || 0),
  }));
  autoUpdater.on('update-downloaded', (info) => send('downloaded', { info: updateInfo(info) }));
  autoUpdater.on('error', (error) => send('error', { message: error && error.message ? error.message : String(error) }));
  return true;
}

async function check() {
  if (!configured) return { configured: false, updateAvailable: false };
  const result = await autoUpdater.checkForUpdates();
  const info = result && result.updateInfo;
  return { configured: true, updateAvailable: !!info && info.version !== app.getVersion(), info: updateInfo(info) };
}

async function download() {
  if (!configured) return { configured: false };
  await autoUpdater.downloadUpdate();
  return { configured: true };
}

function install() {
  if (!configured) return { configured: false };
  autoUpdater.quitAndInstall(false, true);
  return { configured: true };
}

module.exports = { setup, check, download, install };
