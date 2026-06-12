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

// ---------------- Navicat 风格原生菜单 ----------------
function buildAppMenu() {
  const send = (id) => () => {
    if (win && !win.isDestroyed()) win.webContents.send('menu:action', id);
  };
  const template = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '新建连接…', accelerator: 'CmdOrCtrl+N', click: send('new-conn') },
        { label: '新建查询', accelerator: 'CmdOrCtrl+Q', click: send('new-query') },
        { type: 'separator' },
        { label: '运行 SQL 文件…', click: send('run-sql-file') },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '查看(&V)',
      submenu: [
        { label: '刷新当前库对象', click: send('refresh') },
        { label: '切换浅色 / 深色主题', accelerator: 'CmdOrCtrl+D', click: send('toggle-theme') },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
      ],
    },
    {
      label: '工具(&T)',
      submenu: [
        { label: '数据传输…', click: send('transfer') },
        { label: '结构同步 / 数据同步…', click: send('sync') },
        { type: 'separator' },
        { label: '导入向导…', click: send('import') },
        { label: '转储 SQL 文件…', click: send('dump') },
        { type: 'separator' },
        { label: '查询历史', click: send('history') },
        { label: '进程列表', click: send('processes') },
      ],
    },
    {
      label: '窗口(&W)',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '关闭窗口', role: 'close' },
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          label: 'GitHub 仓库',
          click: () => require('electron').shell.openExternal('https://github.com/hufafu1-cloud/dbconnect'),
        },
        { type: 'separator' },
        { label: '关于 DBConnect', click: send('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

buildAppMenu();
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
