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
const updater = require('./updater');

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

ipcMain.handle('app:update-check', async () => {
  try { return { ok: true, data: await updater.check() }; }
  catch (error) { return { ok: false, error: error && error.message ? error.message : String(error) }; }
});
ipcMain.handle('app:update-download', async () => {
  try { return { ok: true, data: await updater.download() }; }
  catch (error) { return { ok: false, error: error && error.message ? error.message : String(error) }; }
});
ipcMain.handle('app:update-cancel', () => {
  try { return { ok: true, data: updater.cancel() }; }
  catch (error) { return { ok: false, error: error && error.message ? error.message : String(error) }; }
});
ipcMain.handle('app:update-install', async () => {
  try {
    allowClose = true;
    return { ok: true, data: updater.install() };
  } catch (error) {
    allowClose = false;
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
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
      // CI 的 Windows Runner 初始化设置/工作区可能比本机慢，固定等待会在
      // 页面已经可交互但 __APP_READY 尚未置位时误报 smoke 失败。
      await new Promise((r) => setTimeout(r, 1500));
      try {
        let domOk = false;
        for (let attempt = 0; attempt < 26; attempt++) {
          domOk = await win.webContents.executeJavaScript(
            'window.__APP_READY === true && !!document.getElementById("tree") && !!document.getElementById("tabbar")');
          if (domOk) break;
          await new Promise((r) => setTimeout(r, 250));
        }
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
          // 期望项数来自渲染层的类型注册表（dbTypes.js），不写死数字；
          // 同时要求每项都有图标且各不相同——新增类型忘了配图标会在这里暴露
          const expectedTypes = window.__test.dbTypeCount();
          const databaseIconsOk = databaseIconMarkup.length === expectedTypes
            && databaseIconMarkup.every(Boolean)
            && new Set(databaseIconMarkup).size === expectedTypes;
          window.__test.closeMenus();
          window.__test.openConnDialog();
          const modal = document.querySelector('.modal');
          const form = modal && modal.querySelector('.form-grid');
          const modalRect = modal && modal.getBoundingClientRect();
          const formRect = form && form.getBoundingClientRect();
          const formLeft = modalRect && formRect ? Math.round(formRect.left - modalRect.left) : -1;
          const formRight = modalRect && formRect ? Math.round(modalRect.right - formRect.right) : -1;
          // Windows CI 可能启用经典滚动条，弹窗内容区会产生约 15px 的单侧偏差；
          // 这里验证表单仍在弹窗内且基本居中，不把滚动条/DPI 差异误判为布局失败。
          const formBalanced = formLeft >= 0 && formRight >= 0 && Math.abs(formLeft - formRight) <= 20;
          const passwordRow = form && form.querySelector('.password-row');
          const passwordInput = passwordRow && passwordRow.querySelector('input[type="password"]');
          const passwordSave = passwordRow && passwordRow.querySelector('.password-save-check input[type="checkbox"]');
          const passwordRowRect = passwordRow && passwordRow.getBoundingClientRect();
          const passwordOptionFits = !!(passwordRowRect && formRect && passwordRowRect.right <= formRect.right + 1);
          // 新建连接默认不保存密码；这里只验证选项可见、未默认勾选且不会挤压输入框。
          const passwordOptionOk = !!(passwordSave && !passwordSave.checked && passwordInput
            && passwordInput.getBoundingClientRect().width >= 180 && passwordOptionFits);
          window.__test.closeMenus();
          // 实验性类型必须在连接对话框里明说未经完整验证：下拉带「（实验性）」后缀，
          // 且正文出现醒目提醒。未验证的类型如果看起来和已验证的一样，用户连不上时
          // 会以为是自己配错了。
          window.__test.openConnDialog('opengauss');
          const expModal = document.querySelector('.modal');
          const expSelect = expModal && expModal.querySelector('select');
          const expSelected = expSelect && expSelect.options[expSelect.selectedIndex];
          const expText = expModal ? expModal.textContent : '';
          const experimentalNoticeOk = !!(expSelected && /（实验性）/.test(expSelected.textContent)
            && /实验性支持：尚未在真实实例上完整验证/.test(expText)
            && /password_encryption_type/.test(expText));
          window.__test.closeMenus();
          // 已验证的类型不应出现这些字样，否则等于所有类型都在喊狼来了
          window.__test.openConnDialog('mysql');
          const plainModal = document.querySelector('.modal');
          const plainText = plainModal ? plainModal.textContent : '';
          // 注意：不能用裸词「实验性」判断——类型下拉里所有 option 的文本都算进
          // modal.textContent，其中就包含别的实验性类型。只匹配提醒正文。
          const plainTypeOk = !/实验性支持：尚未在真实实例上完整验证/.test(plainText);
          window.__test.closeMenus();
          return {
            textOnly, textInset, iconColumns, databaseIconsOk, formBalanced, formLeft, formRight,
            passwordOptionOk, experimentalNoticeOk, plainTypeOk,
          };
        })()`);
        const menuOk = menuLayout.textOnly && menuLayout.textInset === 12 && menuLayout.iconColumns;
        const experimentalOk = menuLayout.experimentalNoticeOk && menuLayout.plainTypeOk;
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
        // 数据网格虚拟滚动：大表只渲染可见窗口，但行号定位/键盘导航/离屏编辑必须照常
        const grid = await win.webContents.executeJavaScript(`(async () => {
          const { DataGrid } = await import('./js/grid.js');
          const mkHost = () => {
            const host = document.createElement('div');
            host.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:400px;display:flex;flex-direction:column';
            document.body.append(host);
            return host;
          };
          const columns = [{ name: 'id', type: 'int' }, { name: 'name', type: 'varchar' }];
          const rows = Array.from({ length: 5000 }, (_, i) => [i + 1, 'n' + i]);
          const bigHost = mkHost();
          const smallHost = mkHost();
          try {
            const g = new DataGrid(bigHost, { editable: true });
            g.setData({ columns, rows, pk: ['id'] });
            const rendered = () => g.tbody.querySelectorAll('tr[data-dr]').length;
            const firstDr = () => Number(g.tbody.querySelector('tr[data-dr]').dataset.dr);
            const out = { rowHeight: g._rowHeight, renderedBig: rendered(), firstDrTop: firstDr() };
            // 占位行必须把没渲染的行数撑出来，滚动条长度才是对的
            out.scrollHeightOk =
              Math.abs(g.wrap.scrollHeight - (5000 * g._rowHeight + g._theadHeight())) < 4;
            // 滚到中间：渲染的应当是中间那批行
            g.wrap.scrollTop = 2000 * g._rowHeight;
            g._renderWindow();
            out.midFirstDr = firstDr();
            out.renderedMid = rendered();
            out.midRowNum = g.tbody.querySelector('tr[data-dr] td.rownum').textContent;
            // 跨窗口键盘导航：跳到最后一行也要能拿到单元格
            g._setFocus(4999, 1);
            out.tailFocusFound = !!g._tdAt(4999, 1);
            out.tailFocusDr = g.focus.dr;
            // 此时第 0 行早已不在 DOM 里：改它不能抛错，模型必须照常更新
            g._setCell(0, 1, null, false, g._tdAt(0, 1));
            out.offscreenEdit = g._currentVal(0, 1, false) === null;
            out.pendingOps = g.getPendingEdits().length;
            // 虚拟化窗口内的行内编辑：双击进入、提交后模型与单元格样式都要更新
            g.wrap.scrollTop = 1000 * g._rowHeight;
            g._renderWindow();
            const editDr = Number(g.tbody.querySelector('tr[data-dr]').dataset.dr);
            g._beginEdit(g._tdAt(editDr, 1), editDr, 1, false);
            out.editorOpened = !!g._editor;
            g._editor.ta.value = '改过了';
            g._removeEditor(true);
            out.inlineEditValue = g._currentVal(editDr, 1, false);
            out.inlineEditMarked = g._tdAt(editDr, 1).classList.contains('cell-modified');
            // 编辑中滚走：编辑器要重新挂到新窗口的 td 上，滚出范围则安全置空
            g._beginEdit(g._tdAt(editDr, 1), editDr, 1, false);
            g.wrap.scrollTop = 4000 * g._rowHeight;
            g._renderWindow();
            out.editorReanchored = g._editor.td === null;
            g._editor.ta.value = '滚走后提交';
            g._removeEditor(true);
            out.editAfterScroll = g._currentVal(editDr, 1, false);
            // ---- 列操作：冻结 / 隐藏 / 调序 / 多列排序 ----
            // 关键约束：隐藏或调序后，按列取单元格必须仍然按模型下标 data-c 定位
            const colHost = mkHost();
            const sorted = [];
            const g2 = new DataGrid(colHost, { onSort: (list) => sorted.push(list) });
            g2.setData({
              columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
              rows: Array.from({ length: 300 }, (_, i) => [i, 'b' + i, 'c' + i, 'd' + i]),
              pk: [],
            });
            const headers = () => [...colHost.querySelectorAll('thead th[data-c]')]
              .map((th) => th.querySelector('.th-inner span').textContent);
            out.colsInitial = headers().join('');

            g2.setColumnHidden(1, true);
            out.colsAfterHide = headers().join('');
            // 隐藏第 2 列后，第 3 列(c)的单元格仍要能按模型下标取到
            out.hiddenCellGone = g2._tdAt(0, 1) === null;
            out.laterCellStillFound = !!g2._tdAt(0, 2);
            out.cellValueByModelIndex = g2._tdAt(0, 2).textContent;

            g2.moveColumn(3, 0);   // 把 d 移到最前
            out.colsAfterMove = headers().join('');
            out.movedCellFound = !!g2._tdAt(0, 3);

            g2.freezeUpTo(0);      // 冻结第一列（此时是 d）
            const frozenTh = colHost.querySelector('thead th.col-frozen');
            const frozenTd = colHost.querySelector('tbody td.col-frozen');
            out.frozenHeader = frozenTh ? frozenTh.getAttribute('data-c') : null;
            out.frozenLeft = frozenTd ? frozenTd.style.left : null;

            g2.showAllColumns();
            out.colsAfterShowAll = headers().join('');

            // 隐藏列必须被键盘导航跳过
            g2.setColumnHidden(1, true);
            out.skipHidden = g2._colByOffset(0, 1);
            g2.showAllColumns();

            // 多列排序：Shift 追加，序号标出优先级
            g2._toggleSort('a', false);
            g2._toggleSort('b', true);
            out.sortList = g2.sortList.map((s) => s.col + ':' + s.dir).join(',');
            out.sortEmitted = sorted.length;
            // 真实流程里 onSort 会触发重新查询再渲染；这里手动渲染一次再看标记
            g2.render();
            out.sortBadges = colHost.querySelectorAll('thead .sort-order').length;
            g2._toggleSort('a', true);   // asc -> desc
            g2._toggleSort('a', true);   // desc -> 移除
            out.sortAfterCycle = g2.sortList.map((s) => s.col).join(',');
            // 右键菜单里的显式入口：多列排序不能只有 Shift+单击这一个没有提示的手势
            g2._appendSort('c', 'desc');
            out.afterAppend = g2.sortList.map((s) => s.col + ':' + s.dir).join(',');
            g2._removeSort('b');
            out.afterRemove = g2.sortList.map((s) => s.col).join(',');
            g2.render();
            out.sortTitle = colHost.querySelector('thead .sort-mark').title;

            // 布局往返：导出再导入必须一致
            g2.setColumnHidden(2, true);
            g2.freezeUpTo(0);
            const layout = g2.getLayout();
            const g3 = new DataGrid(mkHost(), {});
            g3.setData({ columns: g2.columns, rows: [[1, 2, 3, 4]], pk: [] });
            g3.setLayout(layout);
            out.layoutRoundTrip = JSON.stringify(g3.getLayout()) === JSON.stringify(layout);
            // 列数对不上的布局要被整体忽略，不能套到别的表上
            const g4 = new DataGrid(mkHost(), {});
            g4.setData({ columns: [{ name: 'x' }, { name: 'y' }], rows: [[1, 2]], pk: [] });
            g4.setLayout({ order: [3, 2, 1, 0], hidden: [0, 1], frozen: 3 });
            out.mismatchIgnored = g4.colOrder === null && g4._visibleCols().length === 2;

            // ---- 列头筛选行 ----
            const filterHost = mkHost();
            const emitted = [];
            const g5 = new DataGrid(filterHost, { onFilter: (f) => emitted.push(f) });
            g5.setData({
              columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
              rows: [[1, 2, 3]], pk: [],
            });
            out.filterRowHiddenByDefault = filterHost.querySelectorAll('.grid-filter-input').length === 0;
            g5.toggleFilterRow(true);
            out.filterInputs = filterHost.querySelectorAll('.grid-filter-input').length;
            // 隐藏的列不应该还有筛选框
            g5.setColumnHidden(1, true);
            out.filterInputsAfterHide = filterHost.querySelectorAll('.grid-filter-input').length;
            g5.showAllColumns();
            // 输入并回车：应当把原文交给标签页（网格自己不拼 SQL）
            const firstInput = filterHost.querySelector('.grid-filter-input');
            firstInput.value = '北京';
            firstInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            out.filterEmitted = JSON.stringify(emitted[emitted.length - 1] || {});
            // 关掉筛选行必须连带清空条件，否则数据被筛着但界面看不出为什么
            g5.toggleFilterRow(false);
            out.filterClearedOnHide = JSON.stringify(emitted[emitted.length - 1] || {}) === '{}'
              && Object.keys(g5.filters).length === 0;

            // ---- 单元格区域选择 + 选区统计 ----
            // 关键：选区可以跨越大量未渲染的行，统计必须基于模型而不是屏幕上的 DOM
            const statsSeen = [];
            const rangeHost = mkHost();
            const g6 = new DataGrid(rangeHost, { onSelectionStats: (s) => statsSeen.push(s) });
            g6.setData({
              columns: [{ name: 'n' }, { name: 'txt' }],
              rows: Array.from({ length: 2000 }, (_, i) => [i + 1, 't' + i]),
              pk: [],
            });
            // 选中第 1..1000 行的数值列——远超渲染窗口
            g6._setRange({ dr: 0, vi: 0 }, { dr: 999, vi: 0 });
            const st = g6.getSelectionStats();
            out.rangeCells = st.cells;
            out.rangeSum = st.sum;          // 1..1000 求和 = 500500
            out.rangeAvg = st.avg;
            out.rangeMin = st.min;
            out.rangeMax = st.max;
            out.rangeRenderedRows = g6.tbody.querySelectorAll('tr[data-dr]').length;
            out.statsEmitted = statsSeen.length;
            // 文本列不能被当成 0 参与求和
            g6._setRange({ dr: 0, vi: 1 }, { dr: 9, vi: 1 });
            const textStats = g6.getSelectionStats();
            out.textNumeric = textStats.numeric;
            out.textCells = textStats.cells;
            // 选区内容用于复制：按显示顺序取列
            g6._setRange({ dr: 0, vi: 0 }, { dr: 1, vi: 1 });
            const rangeRows = g6._rangeRows();
            out.rangeCopy = JSON.stringify(rangeRows.names) + JSON.stringify(rangeRows.rows);
            g6.clearRange();
            out.rangeCleared = g6.getSelectionStats() === null;

            // 小表保持整表渲染，行为与改造前完全一致
            const small = new DataGrid(smallHost, {});
            small.setData({ columns, rows: rows.slice(0, 100), pk: ['id'] });
            out.renderedSmall = small.tbody.querySelectorAll('tr[data-dr]').length;
            return out;
          } finally {
            bigHost.remove();
            smallHost.remove();
          }
        })()`);
        const gridOk = grid.rowHeight > 0
          && grid.renderedBig > 0 && grid.renderedBig < 120   // 5000 行只渲染一屏多一点
          && grid.firstDrTop === 0 && grid.scrollHeightOk
          && grid.midFirstDr > 1900 && grid.midFirstDr < 2000  // 滚到中间就渲染中间
          && grid.renderedMid < 120
          && grid.midRowNum === String(grid.midFirstDr + 1)    // 行号仍是真实行号
          && grid.tailFocusFound && grid.tailFocusDr === 4999
          && grid.offscreenEdit && grid.pendingOps === 1
          && grid.editorOpened && grid.inlineEditValue === '改过了' && grid.inlineEditMarked
          && grid.editorReanchored && grid.editAfterScroll === '滚走后提交'
          && grid.colsInitial === 'abcd' && grid.colsAfterHide === 'acd'
          && grid.hiddenCellGone && grid.laterCellStillFound && grid.cellValueByModelIndex === 'c0'
          && grid.colsAfterMove === 'dac' && grid.movedCellFound
          && grid.frozenHeader === '3' && grid.frozenLeft === '46px'
          && grid.colsAfterShowAll === 'dabc'
          && grid.skipHidden === 2
          && grid.sortList === 'a:asc,b:asc' && grid.sortEmitted === 2 && grid.sortBadges === 2
          && grid.sortAfterCycle === 'b'
          && grid.afterAppend === 'b:asc,c:desc' && grid.afterRemove === 'c'
          && /右键列头/.test(grid.sortTitle)
          && grid.layoutRoundTrip && grid.mismatchIgnored
          && grid.filterRowHiddenByDefault && grid.filterInputs === 3
          && grid.filterInputsAfterHide === 2
          && grid.filterEmitted === '{"a":"北京"}' && grid.filterClearedOnHide
          && grid.rangeCells === 1000 && grid.rangeSum === 500500 && grid.rangeAvg === 500.5
          && grid.rangeMin === 1 && grid.rangeMax === 1000
          && grid.rangeRenderedRows < 120        // 统计覆盖 1000 行，但只渲染了几十行
          && grid.statsEmitted === 1
          && grid.textNumeric === 0 && grid.textCells === 10
          && grid.rangeCopy === '["n","txt"][[1,"t0"],[2,"t1"]]'
          && grid.rangeCleared
          && grid.renderedSmall === 100;
        console.log('[SMOKE][grid]', JSON.stringify(grid));

        // 命令面板：命令那一半直接来自命令注册表，快捷键提示必须和注册表一致
        const palette = await win.webContents.executeJavaScript(`(async () => {
          const { openCommandPalette } = await import('./js/commandPalette.js');
          openCommandPalette('command');
          await new Promise((r) => setTimeout(r, 50));
          const input = document.querySelector('.palette-input');
          const out = { opened: !!input, total: document.querySelectorAll('.palette-item').length };
          input.value = '>新建查询';
          input.dispatchEvent(new Event('input'));
          const first = document.querySelector('.palette-item');
          out.topLabel = first ? first.querySelector('.palette-label').textContent : null;
          out.topHint = first && first.querySelector('.palette-hint')
            ? first.querySelector('.palette-hint').textContent : null;
          input.value = '>不存在的命令名';
          input.dispatchEvent(new Event('input'));
          out.emptyShown = document.querySelector('.palette-empty').style.display !== 'none';
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          out.closed = !document.querySelector('.palette');
          return out;
        })()`);
        const paletteOk = palette.opened && palette.total > 10
          && palette.topLabel === '新建查询' && palette.topHint === 'Ctrl+Q'
          && palette.emptyShown && palette.closed;

        // 键位方案：切换后必须真的改到活的命令注册表，切回来要完整还原
        const keymap = await win.webContents.executeJavaScript(`(async () => {
          const cmds = await import('./js/commands.js');
          const { updateSettings } = await import('./js/settings.js');
          const refresh = () => cmds.getCommand('refresh');
          const out = {
            commentAddon: typeof CodeMirror.prototype.toggleComment === 'function',
            openTableAccel: cmds.getCommand('open-table') && cmds.getCommand('open-table').accel,
            defaultScope: refresh().scope,
            defaultConflicts: cmds.accelConflicts().length,
          };
          await updateSettings({ keymap: 'navicat' });
          out.navicatScope = refresh().scope;
          out.navicatAccel = refresh().accel;
          out.navicatConflicts = cmds.accelConflicts().length;
          // 换方案后菜单要重建，否则提示里还是旧键位
          const view = [...document.querySelectorAll('#menubar .menu-item')].find((n) => n.textContent === '查看');
          view.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          const items = [...document.querySelectorAll('.ctx-menu .ctx-item')];
          const open = items.find((n) => n.querySelector('.ctx-label').textContent === '打开表');
          out.menuOpenTableHint = open ? open.querySelector('.ctx-hint').textContent : null;
          window.__test.closeMenus();
          await updateSettings({ keymap: 'dbpanda' });
          out.restoredScope = refresh().scope;
          out.restoredConflicts = cmds.accelConflicts().length;
          return out;
        })()`);
        const keymapOk = keymap.commentAddon
          && keymap.openTableAccel === 'Ctrl+Shift+O'
          && keymap.defaultScope === 'notInEditor' && keymap.defaultConflicts === 0
          && keymap.navicatScope === 'global' && keymap.navicatAccel === 'F5'
          && keymap.navicatConflicts === 0
          && keymap.menuOpenTableHint === 'Ctrl+Shift+O'
          && keymap.restoredScope === 'notInEditor' && keymap.restoredConflicts === 0;
        console.log('[SMOKE][keymap]', JSON.stringify(keymap));

        // 外观：行高档位真的改变网格行高；空连接时显示引导而不是一棵空树
        const appearance = await win.webContents.executeJavaScript(`(async () => {
          const { DataGrid } = await import('./js/grid.js');
          const { state } = await import('./js/state.js');
          const { renderTree } = await import('./js/tree.js');
          const host = document.createElement('div');
          host.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;display:flex;flex-direction:column';
          document.body.append(host);
          const saved = state.connections;
          const root = document.documentElement;
          try {
            const g = new DataGrid(host, {});
            g.setData({ columns: [{ name: 'a' }], rows: Array.from({ length: 400 }, (_, i) => [i]), pk: [] });
            const standard = g._rowHeight;
            root.setAttribute('data-density', 'compact');
            g.render();
            const compact = g._rowHeight;
            root.setAttribute('data-density', 'comfortable');
            g.render();
            const comfortable = g._rowHeight;
            root.removeAttribute('data-density');
            // 树行加了 contain: paint（配合滚动容器提层修重绘残影），
            // 必须确认行内的绝对定位标记没有被裁掉：生产库红条、连接状态灯
            // 冒烟用的连接里没有生产库，临时给一行打上标记，直接验 CSS 规则本身
            const anyRow = document.querySelector('.tree-node > .tree-row');
            if (anyRow) anyRow.parentElement.classList.add('env-prod');
            // getComputedStyle 返回的是实时对象，必须在标记还在时就取成字符串
            const prodBar = anyRow ? getComputedStyle(anyRow, '::before') : null;
            const prodBarWidth = prodBar ? prodBar.width : null;
            const prodBarBg = prodBar ? prodBar.backgroundColor : '';
            if (anyRow) anyRow.parentElement.classList.remove('env-prod');
            const connIcon = document.querySelector('.tree-node[data-conn] > .tree-row .tree-icon');
            const connDot = connIcon ? getComputedStyle(connIcon, '::after') : null;
            const treeMarks = {
              prodBarWidth,
              prodBarVisible: prodBarBg !== '' && prodBarBg !== 'rgba(0, 0, 0, 0)',
              dotWidth: connDot ? connDot.width : null,
              dotVisible: !!connDot && connDot.content !== 'none',
              treeComposited: getComputedStyle(document.querySelector('#tree')).willChange,
            };

            state.connections = [];
            renderTree();
            const card = document.querySelector('.tree-onboarding');
            return {
              standard, compact, comfortable, ...treeMarks,
              onboarding: !!card,
              onboardingActions: card ? card.querySelectorAll('.tree-onboarding-actions .btn').length : 0,
              importFirst: card
                ? card.querySelector('.tree-onboarding-actions .btn').textContent.includes('Navicat')
                : false,
            };
          } finally {
            root.removeAttribute('data-density');
            state.connections = saved;
            renderTree();
            host.remove();
          }
        })()`);
        const appearanceOk = appearance.compact < appearance.standard
          && appearance.comfortable > appearance.standard
          && appearance.prodBarWidth === '3px' && appearance.prodBarVisible
          && appearance.dotWidth === '6px' && appearance.dotVisible
          && appearance.treeComposited === 'transform'
          && appearance.onboarding && appearance.onboardingActions === 2 && appearance.importFirst;
        // 操作审计：第一步埋的日志现在应当能读出来并渲染
        const audit = await win.webContents.executeJavaScript(`(async () => {
          const { openAuditTab } = await import('./js/auditTab.js');
          await openAuditTab();
          await new Promise((r) => setTimeout(r, 300));
          const rows = [...document.querySelectorAll('.audit-grid tr[data-dr]')];
          const header = [...document.querySelectorAll('.audit-grid thead th')].map((n) => n.textContent.trim());
          const search = document.querySelector('.audit-search');
          const before = rows.length;
          search.value = '绝不可能匹配到的关键字';
          search.dispatchEvent(new Event('input'));
          await new Promise((r) => setTimeout(r, 250));
          const afterFilter = document.querySelectorAll('.audit-grid tr[data-dr]').length;
          search.value = '';
          search.dispatchEvent(new Event('input'));
          await new Promise((r) => setTimeout(r, 250));
          return {
            header, rendered: before, afterFilter,
            restored: document.querySelectorAll('.audit-grid tr[data-dr]').length,
            count: (document.querySelector('.audit-count') || {}).textContent || '',
            path: (document.querySelector('.audit-path') || {}).textContent || '',
          };
        })()`);
        const auditOk = audit.rendered > 0 && audit.afterFilter === 0 && audit.restored === audit.rendered
          // header[0] 是网格自带的行号列 '#'
          && audit.header[1] === '时间' && audit.header.includes('生产审批')
          && /audit\.log$/.test(audit.path) && /条/.test(audit.count);
        // 连接安全体检：结论必须来自主进程的真实事实，且不能泄漏任何凭据
        const security = await win.webContents.executeJavaScript(`(async () => {
          const raw = await window.api.security.review();
          const { openSecurityDialog } = await import('./js/securityDialog.js');
          await openSecurityDialog();
          await new Promise((r) => setTimeout(r, 120));
          const cards = document.querySelectorAll('.sec-card').length;
          const checks = document.querySelectorAll('.sec-card .sec-check').length;
          const text = (document.querySelector('.sec-body') || {}).textContent || '';
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          return {
            connections: raw.length, cards, checks,
            // review() 只能返回结论。needsPassword / passwordOnDisk 是布尔判断，
            // 真正要防的是 password / passphrase / apiKey 这些携带凭据内容的字段。
            leaks: raw.filter((c) => /"(password|passphrase|apiKey|secret|token)"\s*:/i.test(JSON.stringify(c))).length,
            typesOk: raw.every((c) => typeof c.passwordOnDisk === 'boolean' && typeof c.readOnly === 'boolean'),
            fourChecksEach: raw.length > 0 && checks === raw.length * 4,
            mentionsReadOnly: /访问权限/.test(text),
          };
        })()`);
        const securityOk = security.connections > 0 && security.cards === security.connections
          && security.leaks === 0 && security.typesOk && security.fourChecksEach && security.mentionsReadOnly;
        // 任务中心：关掉对话框后任务仍要可见，这是「长任务后台化」的全部意义
        const taskCenter = await win.webContents.executeJavaScript(`(async () => {
          const tc = await import('./js/taskCenter.js');
          const { openTaskTab } = await import('./js/taskTab.js');
          const indicator = document.querySelector('#status-tasks');
          const before = indicator.hidden;
          const running = tc.startTask({ title: '冒烟任务', kind: 'test', connName: 'demo' });
          running.progress('处理中 3/10', 30);
          const finished = tc.startTask({ title: '已完成任务', kind: 'test' });
          finished.done('完成 42 行');
          const failing = tc.startTask({ title: '失败任务', kind: 'test' });
          failing.fail(new Error('模拟失败原因'));
          openTaskTab();
          await new Promise((r) => setTimeout(r, 150));
          const out = {
            hiddenBefore: before,
            indicatorShown: !indicator.hidden,
            indicatorText: indicator.textContent,
            items: document.querySelectorAll('.task-item').length,
            runningItems: document.querySelectorAll('.task-item.task-running').length,
            failedShown: /模拟失败原因/.test(document.querySelector('.task-failed .task-msg').textContent),
            barWidth: (document.querySelector('.task-bar-fill') || {}).style?.width || '',
          };
          running.done('收尾完成');
          await new Promise((r) => setTimeout(r, 80));
          out.indicatorHiddenAfter = indicator.hidden;
          tc.clearFinished();
          await new Promise((r) => setTimeout(r, 80));
          out.afterClear = document.querySelectorAll('.task-item').length;
          return out;
        })()`);
        const taskOk = taskCenter.hiddenBefore && taskCenter.indicatorShown
          && /1 个任务运行中/.test(taskCenter.indicatorText)
          && taskCenter.items === 3 && taskCenter.runningItems === 1
          && taskCenter.failedShown && taskCenter.barWidth === '30%'
          && taskCenter.indicatorHiddenAfter && taskCenter.afterClear === 0;
        // 标签页拖拽排序与左右分屏
        const tabsProbe = await win.webContents.executeJavaScript(`(async () => {
          const tabs = await import('./js/tabs.js');
          const a = tabs.addTab({ id: 'probe-a', title: 'A' });
          const b = tabs.addTab({ id: 'probe-b', title: 'B' });
          const c = tabs.addTab({ id: 'probe-c', title: 'C' });
          const order = () => [...document.querySelectorAll('#tabbar .tab .tab-title')].map((n) => n.textContent);
          const before = order();
          tabs.moveTab('probe-c', 'probe-a');           // C 拖到 A 前面
          const afterMove = order();
          const draggable = [...document.querySelectorAll('#tabbar .tab')].every((n) => n.draggable);
          tabs.activate('probe-a');
          tabs.setSecondaryTab('probe-b');
          const panes = document.querySelector('#tabpanes');
          const split = {
            splitClass: panes.classList.contains('split'),
            activePane: !!document.querySelector('.tabpane.active'),
            secondaryPane: !!document.querySelector('.tabpane.secondary'),
            secondaryId: tabs.getSecondaryTabId(),
          };
          // 激活副标签应当自动退出分屏，否则同一个 pane 会出现在两边
          tabs.activate('probe-b');
          split.clearedOnActivate = !panes.classList.contains('split') && tabs.getSecondaryTabId() === null;
          tabs.setSecondaryTab('probe-a');
          await tabs.closeTab('probe-a', true);
          split.clearedOnClose = !panes.classList.contains('split');
          await tabs.closeTab('probe-b', true);
          await tabs.closeTab('probe-c', true);
          return { before, afterMove, draggable, ...split };
        })()`);
        const tabsOk = tabsProbe.draggable
          && tabsProbe.before.slice(-3).join() === 'A,B,C'
          && tabsProbe.afterMove.slice(-3).join() === 'C,A,B'
          && tabsProbe.splitClass && tabsProbe.activePane && tabsProbe.secondaryPane
          && tabsProbe.secondaryId === 'probe-b'
          && tabsProbe.clearedOnActivate && tabsProbe.clearedOnClose;
        // 最近 / 收藏 + 图表：都是新增的独立模块，这里验核心不变量
        const extras = await win.webContents.executeJavaScript(`(async () => {
          const store = await import('./js/recentStore.js');
          const { openChartDialog } = await import('./js/chartDialog.js');
          const out = {};
          let persisted = 0;
          store.initRecentStore({}, () => { persisted++; });
          const a = { connId: 'c1', db: 'd', schema: null, table: 't1', kind: 'table' };
          store.noteOpened(a);
          store.noteOpened({ connId: 'c1', db: 'd', schema: null, table: 't2', kind: 'table' });
          store.noteOpened(a);   // 重复打开只应挪到最前，不堆重复项
          out.recent = store.recentItems().map((x) => x.table).join(',');
          out.persisted = persisted > 0;
          out.favBefore = store.isFavorite(a);
          store.toggleFavorite(a);
          out.favAfter = store.isFavorite(a);
          store.toggleFavorite(a);
          out.favToggledOff = store.isFavorite(a);
          store.toggleFavorite(a);
          // 连接被删掉后，它名下的条目要一起清掉，免得点了打不开
          store.dropConnection('c1');
          out.afterDrop = store.recentItems().length + store.favoriteItems().length;
          // 快照往返
          store.initRecentStore({ recent: [a], favorites: [a] }, () => {});
          out.snapshotRoundTrip = store.snapshotRecentStore().recent[0].table === 't1';

          // 图表：数值列识别 + 无数值时不画
          const m = openChartDialog({
            columns: [{ name: 'city' }, { name: 'amount' }],
            rows: [['北京', 120], ['上海', 80], ['广州', '45']],
          });
          out.chartOpened = !!document.querySelector('.chart-svg');
          out.chartBars = document.querySelectorAll('.chart-svg rect').length;
          if (m) m.close();
          const none = openChartDialog({ columns: [{ name: 'a' }], rows: [['x'], ['y']] });
          out.chartRejectsNonNumeric = none === null;
          return out;
        })()`);
        const extrasOk = extras.recent === 't1,t2' && extras.persisted
          && !extras.favBefore && extras.favAfter && !extras.favToggledOff
          && extras.afterDrop === 0 && extras.snapshotRoundTrip
          && extras.chartOpened && extras.chartBars === 3
          && extras.chartRejectsNonNumeric;
        console.log('[SMOKE][extras]', JSON.stringify(extras));
        console.log('[SMOKE][tabs]', JSON.stringify(tabsProbe));
        console.log('[SMOKE][tasks]', JSON.stringify(taskCenter));
        console.log('[SMOKE][security]', JSON.stringify(security));
        console.log('[SMOKE][audit]', JSON.stringify(audit));
        console.log('[SMOKE][palette]', JSON.stringify(palette));
        console.log('[SMOKE][appearance]', JSON.stringify(appearance));

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
        console.log(`[SMOKE] dom=${domOk} codemirror=${cmOk} title=${titleOk} menus=${menuOk} databaseIcons=${menuLayout.databaseIconsOk} form=${menuLayout.formBalanced} formMargins=${menuLayout.formLeft}/${menuLayout.formRight} passwordOption=${menuLayout.passwordOptionOk} experimental=${experimentalOk} workspace=${workspaceOk} grid=${gridOk} palette=${paletteOk} appearance=${appearanceOk} keymap=${keymapOk} audit=${auditOk} security=${securityOk} tasks=${taskOk} tabs=${tabsOk} extras=${extrasOk} passwordPrompt=${passwordPromptOk} failedSessionRetry=${failedSessionRetryPrompt} errors=${errors.length}`);
        errors.forEach((m) => console.log('[SMOKE][console.error]', m));
        app.exit(domOk && cmOk && titleOk && menuOk && menuLayout.databaseIconsOk
          && menuLayout.formBalanced && menuLayout.passwordOptionOk && experimentalOk
          && workspaceOk && passwordPromptOk && failedSessionRetryPrompt && errors.length === 0 ? 0 : 1);
      } catch (err) {
        console.error('[SMOKE] 失败:', err);
        app.exit(1);
      }
    });
    return;
  }
  createWindow(true);
  updater.setup(win);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(true);
      updater.setup(win);
    }
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
  // 退出时只取消未完成的下载，完整下载的更新由用户明确确认后安装。
  updater.cancel();
  require('./store').clearSessionPasswords();
  Promise.race([
    dbm.closeAll(),
    new Promise((r) => setTimeout(r, 1500)),
  ]).finally(() => app.exit(0));
});
