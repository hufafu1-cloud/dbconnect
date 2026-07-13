// 主进程入口
const { app, BrowserWindow, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { migrateLegacyUserData } = require('./userDataMigration');

const isSmoke = process.argv.includes('--smoke');
const isSelfTest = process.argv.includes('--selftest');
const isDemo = process.argv.includes('--demo');

// 测试/演示模式使用临时用户数据目录，避免污染真实配置
if (isSmoke || isSelfTest || isDemo) {
  app.setPath('userData', path.join(os.tmpdir(), 'dbpanda-test-' + process.pid));
} else {
  // 将 Datavia / DBConnect 的本地配置一次性迁移到 DBPanda，避免已存连接“丢失”
  migrateOldData();
}

// 只分离 Chromium 磁盘缓存，不迁移 sessionData：safeStorage 依赖原有 profile
// 的安全状态，迁移整个会话目录会令已保存的数据库密码无法解密。
function configureDiskCache() {
  try {
    const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
    const base = isSmoke || isSelfTest || isDemo
      ? app.getPath('userData')
      : path.join(localAppData, 'DBPanda');
    const diskCache = path.join(base, 'ChromiumCache');
    fs.mkdirSync(diskCache, { recursive: true });
    app.commandLine.appendSwitch('disk-cache-dir', diskCache);
  } catch (e) {
    // 无法创建独立缓存目录时保留 Electron 默认路径，不能阻断数据库客户端启动。
  }
}
configureDiskCache();

// productName 改名后 userData 目录变为 %APPDATA%/DBPanda，迁移历史数据
function migrateOldData() {
  try {
    const newDir = app.getPath('userData');
    const parent = path.dirname(newDir);
    migrateLegacyUserData(newDir, [path.join(parent, 'Datavia'), path.join(parent, 'DBConnect')]);
  } catch (e) { /* 迁移失败不影响启动 */ }
}

const ipc = require('./ipc');
const dbm = require('./db');

let win = null;
let allowClose = false;
let closeRequestSeq = 0;
let pendingClose = null;
const WINDOW_TITLE = `DBPanda v${app.getVersion()}`;

function clearPendingClose() {
  if (pendingClose && pendingClose.timer) clearTimeout(pendingClose.timer);
  pendingClose = null;
}

function createWindow(show) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: WINDOW_TITLE,
    icon: path.join(__dirname, '../../assets/icon.ico'),
    backgroundColor: '#f3f4f6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle(WINDOW_TITLE);
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.once('ready-to-show', () => { if (show) win.show(); });

  // F12 开发者工具（菜单为应用内自绘，无原生加速键）
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  win.webContents.on('render-process-gone', () => {
    if (!pendingClose || !win || win.isDestroyed()) return;
    clearPendingClose();
    allowClose = true;
    win.close();
  });

  // 关闭前询问渲染进程（有未保存更改时由渲染进程弹确认框）
  win.on('close', (e) => {
    if (allowClose || isSmoke || isDemo) return;
    e.preventDefault();
    if (pendingClose) return;
    const id = `close-${++closeRequestSeq}`;
    pendingClose = { id, acknowledged: false, timer: null };
    win.webContents.send('app:close-request', id);
    pendingClose.timer = setTimeout(() => { // 仅在渲染进程完全无响应时兜底
      if (pendingClose && pendingClose.id === id && !pendingClose.acknowledged
          && win && !win.isDestroyed()) {
        clearPendingClose();
        allowClose = true;
        win.close();
      }
    }, 3000);
  });
  win.on('closed', () => { clearPendingClose(); win = null; });
  return win;
}

const { ipcMain } = require('electron');
ipcMain.on('app:close-ack', (event, id) => {
  if (!pendingClose || pendingClose.id !== id || !win || event.sender !== win.webContents) return;
  pendingClose.acknowledged = true;
  if (pendingClose.timer) clearTimeout(pendingClose.timer);
  pendingClose.timer = null;
});
ipcMain.on('app:cancel-close', (event, id) => {
  if (!pendingClose || pendingClose.id !== id || !win || event.sender !== win.webContents) return;
  clearPendingClose();
});
ipcMain.on('app:confirm-close', (event, id) => {
  if (!pendingClose || pendingClose.id !== id || !win || event.sender !== win.webContents) return;
  clearPendingClose();
  allowClose = true;
  if (win && !win.isDestroyed()) win.close();
});

// 单实例
if (!isSmoke && !isSelfTest && !isDemo) {
  const got = app.requestSingleInstanceLock();
  if (!got) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    });
  }
}

Menu.setApplicationMenu(null); // 菜单为应用内自绘（renderer menubar.js）
ipc.register(() => win);

app.whenReady().then(async () => {
  if (isSelfTest) {
    try {
      const { runSelfTest } = require('./selftest');
      const code = await runSelfTest();
      app.exit(code);
    } catch (err) {
      console.error('[SELFTEST] 未捕获异常:', err && err.stack || err);
      app.exit(1);
    }
    return;
  }
  if (isDemo) {
    const { runDemo } = require('./demo');
    try {
      const code = await runDemo(createWindow);
      app.exit(code);
    } catch (err) {
      console.error('[DEMO] 失败:', err);
      app.exit(1);
    }
    return;
  }
  if (isSmoke) {
    const smokeStore = require('./store');
    const passwordPromptConnection = smokeStore.save({
      name: 'Smoke session password', type: 'mysql', host: '127.0.0.1', port: 1,
      user: 'smoke', password: 'not-persisted', savePassword: false,
    });
    smokeStore.clearSessionPasswords();
    const failedSessionConnection = smokeStore.save({
      name: 'Smoke failed session password', type: 'mysql', host: '127.0.0.1', port: 1,
      user: 'smoke', password: 'wrong-session-password', savePassword: false,
    });
    createWindow(false);
    const errors = [];
    win.webContents.on('console-message', (...a) => {
      // 新旧两种事件签名兼容
      const ev = a[0];
      const level = typeof a[1] === 'number' ? a[1] : (ev && ev.level);
      const message = typeof a[2] === 'string' ? a[2] : (ev && ev.message);
      if (level === 3 || level === 'error') errors.push(message || '');
    });
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const domOk = await win.webContents.executeJavaScript(
          'window.__APP_READY === true && !!document.getElementById("tree") && !!document.getElementById("tabbar")');
        const cmOk = await win.webContents.executeJavaScript('typeof CodeMirror === "function"');
        const titleOk = win.getTitle() === WINDOW_TITLE;
        const menuLayout = await win.webContents.executeJavaScript(`(() => {
          const top = document.querySelector('#menubar .menu-item');
          top.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          const textMenu = document.querySelector('.ctx-menu');
          const textItem = textMenu && textMenu.querySelector('.ctx-item');
          const textLabel = textItem && textItem.querySelector('.ctx-label');
          const textOnly = !!textMenu && !textMenu.querySelector('.ctx-icon');
          const textInset = textItem && textLabel
            ? Math.round(textLabel.getBoundingClientRect().left - textItem.getBoundingClientRect().left)
            : -1;
          window.__test.closeMenus();
          window.__test.openConnMenu();
          const iconItems = [...document.querySelectorAll('.ctx-menu .ctx-item')];
          const iconColumns = iconItems.length > 0 && iconItems.every((item) => item.querySelector('.ctx-icon'));
          const databaseIconMarkup = iconItems.map((item) => item.querySelector('.ctx-icon svg')?.outerHTML || '');
          const databaseIconsOk = databaseIconMarkup.length === 7
            && databaseIconMarkup.every(Boolean) && new Set(databaseIconMarkup).size === 7;
          window.__test.closeMenus();
          window.__test.openConnDialog();
          const modal = document.querySelector('.modal');
          const form = modal && modal.querySelector('.form-grid');
          const labels = form ? [...form.querySelectorAll('label')].filter((label) => (
            label.textContent.trim() && getComputedStyle(label).display !== 'none'
          )) : [];
          const labelTextLeft = labels.length ? Math.min(...labels.map((label) => {
            const range = document.createRange();
            range.selectNodeContents(label);
            return range.getBoundingClientRect().left;
          }).filter((left) => left > 0)) : 0;
          const modalRect = modal && modal.getBoundingClientRect();
          const formRect = form && form.getBoundingClientRect();
          const formLeft = modalRect ? Math.round(labelTextLeft - modalRect.left) : -1;
          const formRight = modalRect && formRect ? Math.round(modalRect.right - formRect.right) : -1;
          const formBalanced = formLeft > 0 && Math.abs(formLeft - formRight) <= 6;
          const passwordRow = form && form.querySelector('.password-row');
          const passwordInput = passwordRow && passwordRow.querySelector('input[type="password"]');
          const passwordSave = passwordRow && passwordRow.querySelector('.password-save-check input[type="checkbox"]');
          const passwordRowRect = passwordRow && passwordRow.getBoundingClientRect();
          const passwordOptionFits = !!(passwordRowRect && formRect && passwordRowRect.right <= formRect.right + 1);
          // 新建连接默认不保存密码；这里只验证选项可见、未默认勾选且不会挤压输入框。
          const passwordOptionOk = !!(passwordSave && !passwordSave.checked && passwordInput
            && passwordInput.getBoundingClientRect().width >= 180 && passwordOptionFits);
          window.__test.closeMenus();
          return { textOnly, textInset, iconColumns, databaseIconsOk, formBalanced, formLeft, formRight, passwordOptionOk };
        })()`);
        const menuOk = menuLayout.textOnly && menuLayout.textInset === 12 && menuLayout.iconColumns;
        const workspaceOk = await win.webContents.executeJavaScript(`(async () => {
          const sql = 'x'.repeat(1200 * 1024);
          const snapshot = { version: 1, savedAt: Date.now(), activeId: 'query-large', context: {}, tabs: [
            { id: 'query-large', type: 'query', state: { sql } },
          ] };
          await window.api.workspace.write(snapshot);
          const restored = await window.api.workspace.read();
          await window.api.workspace.clear();
          return !!(restored && restored.tabs && restored.tabs[0]
            && restored.tabs[0].state.sql.length === sql.length);
        })()`);
        await win.webContents.executeJavaScript(
          `window.__test.openConnection(${JSON.stringify(passwordPromptConnection.id)}).catch(() => {}); true`);
        await new Promise((r) => setTimeout(r, 100));
        const passwordPromptOk = await win.webContents.executeJavaScript(`(() => {
          const prompt = document.querySelector('.password-prompt');
          const input = prompt && prompt.querySelector('input[type="password"]');
          return !!(prompt && input && document.querySelector('.modal-head').textContent.includes('Smoke session password'));
        })()`);
        await win.webContents.executeJavaScript('window.__test.closeMenus()');
        await win.webContents.executeJavaScript(
          `window.__test.openConnection(${JSON.stringify(failedSessionConnection.id)})`);
        await win.webContents.executeJavaScript(
          `window.__test.openConnection(${JSON.stringify(failedSessionConnection.id)}).catch(() => {}); true`);
        await new Promise((r) => setTimeout(r, 100));
        const failedSessionRetryPrompt = await win.webContents.executeJavaScript(
          `!!document.querySelector('.password-prompt') && document.querySelector('.modal-head').textContent.includes('Smoke failed session password')`);
        await win.webContents.executeJavaScript('window.__test.closeMenus()');
        console.log(`[SMOKE] dom=${domOk} codemirror=${cmOk} title=${titleOk} menus=${menuOk} databaseIcons=${menuLayout.databaseIconsOk} form=${menuLayout.formBalanced} passwordOption=${menuLayout.passwordOptionOk} workspace=${workspaceOk} passwordPrompt=${passwordPromptOk} failedSessionRetry=${failedSessionRetryPrompt} errors=${errors.length}`);
        errors.forEach((m) => console.log('[SMOKE][console.error]', m));
        app.exit(domOk && cmOk && titleOk && menuOk && menuLayout.databaseIconsOk
          && menuLayout.formBalanced && menuLayout.passwordOptionOk
          && workspaceOk && passwordPromptOk && failedSessionRetryPrompt && errors.length === 0 ? 0 : 1);
      } catch (err) {
        console.error('[SMOKE] 失败:', err);
        app.exit(1);
      }
    });
    return;
  }
  createWindow(true);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(true);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  require('./store').clearSessionPasswords();
  Promise.race([
    dbm.closeAll(),
    new Promise((r) => setTimeout(r, 1500)),
  ]).finally(() => app.exit(0));
});
