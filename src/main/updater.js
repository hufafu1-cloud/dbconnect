const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const { CancellationToken } = require('builder-util-runtime');
const { getFeedOptions, isConfigured, validateUpdateInfo } = require('./updateConfig');

let targetWindow = null;
let configured = false;
let downloadToken = null;
let downloadedReady = false;
let compatibleUpdate = false;

function updateInfo(info) {
  if (!info) return null;
  const notes = Array.isArray(info.releaseNotes)
    ? info.releaseNotes
      .filter((item) => item && (item.note || item.version))
      .map((item) => ({ version: String(item.version || ''), note: String(item.note || '') }))
    : (typeof info.releaseNotes === 'string' ? info.releaseNotes : '');
  return {
    version: info.version || '',
    releaseDate: info.releaseDate || '',
    releaseName: info.releaseName || '',
    releaseNotes: notes,
  };
}

function send(event, payload = {}) {
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send('app:update', { event, ...payload });
  }
}

function setup(win) {
  targetWindow = win;
  const feed = getFeedOptions();
  configured = !!(app.isPackaged && !process.argv.includes('--smoke')
    && !process.argv.includes('--selftest') && !process.argv.includes('--demo')
    && isConfigured(feed));
  if (!configured) return false;

  autoUpdater.autoDownload = false;
  // 下载未完成时退出不能触发安装，避免把临时包当成完整安装包。
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  // 安装包文件名不带版本号（对外只发一个固定下载链接），electron-updater 的增量下载
  // 靠把新包 URL 里的版本号替换成旧版本来定位旧 blockmap，文件名里没有版本号就替换不出来，
  // 只会拿同一个 blockmap 算出「零差异」，再靠 sha512 校验失败兜底回全量——白跑一趟。
  // 何况 feed 走的是 generic + releases/latest，旧版本的 blockmap 本来就取不到。
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.setFeedURL(feed);
  autoUpdater.removeAllListeners('checking-for-update');
  autoUpdater.removeAllListeners('update-available');
  autoUpdater.removeAllListeners('update-not-available');
  autoUpdater.removeAllListeners('download-progress');
  autoUpdater.removeAllListeners('update-downloaded');
  autoUpdater.removeAllListeners('update-cancelled');
  autoUpdater.removeAllListeners('error');
  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) => {
    validateUpdateInfo(info);
    compatibleUpdate = true;
    send('available', { info: updateInfo(info) });
  });
  autoUpdater.on('update-not-available', (info) => send('not-available', { info: updateInfo(info) }));
  autoUpdater.on('download-progress', (progress) => send('progress', {
    percent: Number(progress.percent || 0),
    transferred: Number(progress.transferred || 0),
    total: Number(progress.total || 0),
    bytesPerSecond: Number(progress.bytesPerSecond || 0),
  }));
  autoUpdater.on('update-downloaded', (info) => {
    downloadedReady = true;
    send('downloaded', { info: updateInfo(info) });
  });
  autoUpdater.on('update-cancelled', (info) => send('cancelled', { info: updateInfo(info) }));
  autoUpdater.on('error', (error) => send('error', { message: error && error.message ? error.message : String(error) }));
  return true;
}

async function check() {
  if (!configured) return { configured: false, updateAvailable: false };
  compatibleUpdate = false;
  const result = await autoUpdater.checkForUpdates();
  const info = result && result.updateInfo;
  // 不把回滚版本误报为更新；以 updater 的 semver 判定为准。
  return { configured: true, updateAvailable: !!(result && result.isUpdateAvailable), info: updateInfo(info) };
}

async function download() {
  if (!configured) return { configured: false };
  if (!compatibleUpdate) throw new Error('请先检查并确认与当前平台匹配的更新');
  if (downloadToken) return { configured: true, downloading: true };
  downloadedReady = false;
  downloadToken = new CancellationToken();
  try {
    await autoUpdater.downloadUpdate(downloadToken);
    return { configured: true, downloaded: true };
  } finally {
    downloadToken = null;
  }
}

function cancel() {
  if (!downloadToken) return { configured, cancelled: false };
  downloadToken.cancel();
  return { configured, cancelled: true };
}

function install() {
  if (!configured) return { configured: false };
  if (!downloadedReady) throw new Error('更新包尚未完整下载，暂不能安装');
  autoUpdater.quitAndInstall(false, true);
  return { configured: true };
}

module.exports = { setup, check, download, cancel, install };
