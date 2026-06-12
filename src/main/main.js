// 主进程入口
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const os = require('os');

const isSmoke = process.argv.includes('--smoke');
const isSelfTest = process.argv.includes('--selftest');
const isDemo = process.argv.includes('--demo');

// 测试/演示模式使用临时用户数据目录，避免污染真实配置
if (isSmoke || isSelfTest || isDemo) {
  app.setPath('userData', path.join(os.tmpdir(), 'dbconnect-test-' + process.pid));
}

const ipc = require('./ipc');
const dbm = require('./db');

let win = null;
let allowClose = false;

function createWindow(show) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'DBConnect',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    backgroundColor: '#f3f4f6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
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

  // 关闭前询问渲染进程（有未保存更改时由渲染进程弹确认框）
  win.on('close', (e) => {
    if (allowClose || isSmoke || isDemo) return;
    e.preventDefault();
    win.webContents.send('app:close-request');
    setTimeout(() => { // 渲染进程无响应时兜底强制关闭
      if (!allowClose && win && !win.isDestroyed()) { allowClose = true; win.close(); }
    }, 3000);
  });
  win.on('closed', () => { win = null; });
  return win;
}

const { ipcMain } = require('electron');
ipcMain.on('app:confirm-close', () => {
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
    const { runSelfTest } = require('./selftest');
    const code = await runSelfTest();
    app.exit(code);
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
        console.log(`[SMOKE] dom=${domOk} codemirror=${cmOk} errors=${errors.length}`);
        errors.forEach((m) => console.log('[SMOKE][console.error]', m));
        app.exit(domOk && cmOk && errors.length === 0 ? 0 : 1);
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
  Promise.race([
    dbm.closeAll(),
    new Promise((r) => setTimeout(r, 1500)),
  ]).finally(() => app.exit(0));
});
