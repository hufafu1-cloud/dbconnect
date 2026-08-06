// 渲染进程入口：装配工具栏、树、标签页、快捷键与自动化测试钩子
import { $, el, iconEl } from './util.js';
import { state, reloadConnections, on, emit, getActiveTarget, setActiveTarget, objectsCacheKey } from './state.js';
import { toast, openModal, confirmDialog } from './toast.js';
import { showMenu } from './contextmenu.js';
import { renderTree, setupTreeFilter, openConnectionById, revealTarget } from './tree.js';
import { initObjectsTab } from './objectsTab.js';
import {
  addTab, closeActive, anyDirty, getActiveTab, activateRelative,
  getStoredWorkspace, restoreWorkspaceTabs, retryDeferredWorkspaceTabs,
  setWorkspaceContextProvider, touchWorkspacePersistence, persistWorkspaceNow, runBeforeCloseGuards,
  setSecondaryTab, getSecondaryTabId,
} from './tabs.js';
import { openConnDialog } from './connDialog.js';
import * as actions from './actions.js';
import { openQueryTab } from './queryTab.js';
import { openTableTab } from './tableTab.js';
import { statusbar, setupTaskIndicator } from './statusbar.js';
import {
  registerCommands, runCommand, matchShortcut, isEnabled,
  setCommandContextProvider, accelHint, applyKeymap, accelConflicts,
} from './commands.js';
import { KEYMAPS, DEFAULT_KEYMAP } from './keymaps.js';
import { buildMenuBar } from './menubar.js';
import { loadSettings, getSetting, updateSettings, onSettingsChange } from './settings.js';
import { initRecentStore, snapshotRecentStore, dropConnection } from './recentStore.js';

// ---------------- 工具栏（Navicat 风格大图标） ----------------
function newQueryFromToolbar() {
  const t = firstOpenTarget(true);
  if (!t) return;
  actions.newQuery(t);
}

async function openHistory() {
  const { openHistoryTab } = await import('./historyTab.js');
  return openHistoryTab();
}

/** 编辑菜单的剪贴板动作交给浏览器原生实现（按键本身也由浏览器处理） */
function execEditCommand(cmd) {
  try { document.execCommand(cmd); } catch (e) { /* ignore */ }
}

async function openAiPanelFromToolbar() {
  const { openAiPanel } = await import('./aiPanel.js');
  const t = firstOpenTarget();
  openAiPanel(t || {});
}

function showConnMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, [
    { label: 'MySQL / MariaDB', icon: 'mysql', onClick: () => openConnDialog(null, 'mysql') },
    { label: 'PostgreSQL', icon: 'postgres', onClick: () => openConnDialog(null, 'postgres') },
    { label: 'SQLite', icon: 'sqlite', onClick: () => openConnDialog(null, 'sqlite') },
    { label: 'SQL Server', icon: 'mssql', onClick: () => openConnDialog(null, 'mssql') },
    { label: 'ClickHouse', icon: 'clickhouse', onClick: () => openConnDialog(null, 'clickhouse') },
    { label: 'OceanBase (MySQL 模式)', icon: 'oceanbase', onClick: () => openConnDialog(null, 'oceanbase') },
    { label: 'OceanBase (Oracle 模式)', icon: 'oboracle', onClick: () => openConnDialog(null, 'oboracle') },
  ]);
}

let toolbarContextButton = null;
let toolbarContextLabel = null;
let toolbarContextEnv = null;
let toolbarActionEls = {};
let updateCheckBusy = false;
let updateDownloadBusy = false;
let updateDownloaded = false;
let updatePromptOpen = false;
let cachedAppVersion = null;

function updateVersion(info) {
  return info && info.version ? `v${info.version}` : '新版本';
}

function updateNotes(info) {
  const notes = info && info.releaseNotes;
  if (Array.isArray(notes)) {
    return notes
      .map((item) => item && item.note ? `${item.version ? `${item.version}：` : ''}${item.note}` : '')
      .filter(Boolean)
      .join('\n\n');
  }
  return typeof notes === 'string' ? notes.trim() : '';
}

async function currentAppVersion() {
  if (cachedAppVersion) return cachedAppVersion;
  try {
    const info = await window.api.app.info();
    cachedAppVersion = `v${info.version}`;
  } catch (e) { cachedAppVersion = '当前版本'; }
  return cachedAppVersion;
}

async function offerUpdate(info) {
  if (updatePromptOpen || updateDownloaded) return;
  updatePromptOpen = true;
  try {
    const notes = updateNotes(info);
    const message = [
      `当前版本 ${await currentAppVersion()}，发现 ${updateVersion(info)}。`,
      notes ? `\n更新内容：\n${notes}` : '\n本次版本暂无更新日志。',
      '\n现在下载更新吗？',
    ].join('\n');
    const ok = await confirmDialog('发现新版本', message, { okLabel: '下载更新' });
    if (!ok) {
      // 用户取消下载后，恢复检查更新前的状态提示。
      statusbar.setLeft('就绪');
      return;
    }
    updateDownloadBusy = true;
    statusbar.setLeft(`正在下载 ${updateVersion(info)}…`);
    await window.api.app.updateDownload();
  } catch (e) {
    statusbar.setLeft('就绪');
    const message = e && e.message ? e.message : String(e);
    if (!/cancelled|canceled/i.test(message)) toast.error('更新下载失败：' + message);
  } finally {
    updateDownloadBusy = false;
    updatePromptOpen = false;
  }
}

async function checkForUpdates(manual = true) {
  if (updateCheckBusy || updateDownloadBusy) return;
  updateCheckBusy = true;
  if (manual) statusbar.setLeft('正在检查更新…');
  try {
    const result = await window.api.app.updateCheck();
    if (!result || !result.configured) {
      if (manual) {
        statusbar.setLeft('就绪');
        toast.info('更新服务尚未配置');
      }
      return;
    }
    if (!result.updateAvailable) {
      if (manual) {
        statusbar.setLeft('就绪');
        toast.info('当前已是最新版本');
      }
      return;
    }
    await offerUpdate(result.info);
  } catch (e) {
    if (manual) {
      statusbar.setLeft('就绪');
      toast.error('检查更新失败：' + (e && e.message ? e.message : e));
    }
  } finally {
    updateCheckBusy = false;
  }
}

function setupUpdaterEvents() {
  if (!window.api.app.onUpdate) return;
  window.api.app.onUpdate(async (payload = {}) => {
    if (payload.event === 'progress') {
      const percent = Math.max(0, Math.min(100, Number(payload.percent || 0)));
      statusbar.setLeft(`正在下载更新 ${percent.toFixed(0)}%…`);
    } else if (payload.event === 'downloaded') {
      updateDownloaded = true;
      statusbar.setLeft(`更新 ${updateVersion(payload.info)} 已下载`);
      const ok = await confirmDialog('更新已下载', `${updateVersion(payload.info)} 已准备好，是否立即重启安装？`, { okLabel: '立即重启' });
      if (ok) {
        try { await window.api.app.updateInstall(); }
        catch (e) { toast.error('安装更新失败：' + (e && e.message ? e.message : e)); }
      } else toast.info('更新已下载，退出程序时将自动安装');
    } else if (payload.event === 'error') {
      updateDownloadBusy = false;
      toast.error('自动更新失败：' + (payload.message || '未知错误'));
    } else if (payload.event === 'cancelled') {
      updateDownloadBusy = false;
      updateDownloaded = false;
      statusbar.setLeft('更新下载已取消');
    }
  });
}

function connectionForTarget(target) {
  return target && state.connections.find((item) => item.id === target.connId);
}

function targetContextParts(target) {
  if (!target || !target.connId) return [];
  const conn = connectionForTarget(target);
  return [conn ? conn.name : target.connId, target.db, target.schema, target.table].filter(Boolean);
}

function targetContextLabel(target) {
  if (!target || !target.connId) return '未选择数据库';
  const parts = targetContextParts(target);
  return parts.length ? parts.join(' / ') : `${target.connId}（未选择数据库）`;
}

function renderToolbarContext(target) {
  if (!toolbarContextLabel) return;
  const parts = targetContextParts(target);
  toolbarContextLabel.replaceChildren();
  if (!parts.length) {
    toolbarContextLabel.append('未选择数据库');
    return;
  }
  parts.forEach((part, index) => {
    if (index) toolbarContextLabel.append(el('span', { class: 'toolbar-context-separator' }, ' / '));
    toolbarContextLabel.append(el('span', {
      class: index === 0 ? 'toolbar-context-connection' : 'toolbar-context-object',
    }, part));
  });
}

// 工具栏按钮的灰不灰由命令注册表的 enabled() 决定，和菜单用的是同一份判断
function updateToolbarActions() {
  for (const [commandId, btn] of Object.entries(toolbarActionEls)) {
    if (btn) btn.disabled = !isEnabled(commandId);
  }
}

function updateToolbarContext(target = state.activeTarget) {
  if (!toolbarContextButton || !toolbarContextLabel) return;
  const conn = connectionForTarget(target);
  const label = targetContextLabel(target);
  renderToolbarContext(target);
  toolbarContextButton.title = target && target.connId
    ? `当前上下文：${label}\n点击切换已打开的连接或数据库`
    : '当前未选择数据库；点击选择已打开的连接或数据库';
  toolbarContextButton.classList.toggle('empty', !target || !target.connId);
  if (toolbarContextEnv) {
    const env = conn && conn.env;
    toolbarContextEnv.textContent = env === 'prod' ? '生产' : (env === 'test' ? '测试' : '');
    toolbarContextEnv.className = 'toolbar-context-env' + (env ? ` env-${env}` : '');
    toolbarContextEnv.style.display = env ? '' : 'none';
  }
  updateToolbarActions();
}

function showToolbarContextMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const entries = [];
  for (const [connId, opened] of state.open) {
    const conn = connectionForTarget({ connId });
    const databases = Array.isArray(opened && opened.databases) ? opened.databases : [];
    const choose = (db) => setActiveTarget({ connId, db }, 'toolbar-context');
    if (databases.length) {
      entries.push({
        label: conn ? conn.name : connId,
        icon: conn && conn.type || 'connection',
        submenu: databases.map((db) => ({ label: db, onClick: () => choose(db) })),
      });
    } else {
      entries.push({
        label: conn ? conn.name : connId,
        icon: conn && conn.type || 'connection',
        onClick: () => choose(null),
      });
    }
  }
  if (!entries.length) entries.push({ label: '请先打开一个连接', disabled: true });
  showMenu(r.left, r.bottom + 4, entries);
}

function showToolbarMoreMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, [
    { label: '运行 SQL 文件…', icon: 'openFile', onClick: () => runMenuAction('run-sql-file') },
    { label: '导入向导…', icon: 'importIcon', onClick: () => runMenuAction('import') },
    { label: '转储 SQL 文件…', icon: 'exportIcon', onClick: () => runMenuAction('dump') },
    { label: '进程列表', icon: 'monitor', onClick: () => runMenuAction('processes') },
    { sep: true },
    { label: '选项…', icon: 'theme', onClick: () => runMenuAction('open-settings') },
    { label: 'AI 助手设置…', icon: 'ai', onClick: () => runMenuAction('ai-config') },
    { label: '快捷键说明', icon: 'info', onClick: () => showAbout() },
  ]);
}

function buildToolbar() {
  const tb = $('#toolbar');
  tb.innerHTML = '';
  const main = (icon, label, onClick, title, cls = '') => {
    return el('button', {
      class: 'tbtn-main' + (cls ? ` ${cls}` : ''),
      type: 'button',
      onClick,
      title: title || label,
    }, iconEl(icon), el('span', { class: 'tbtn-label' }, label));
  };

  // 提示里的快捷键统一从注册表取，避免按钮上写的和实际生效的对不上
  const tip = (commandId, text) => {
    const accel = accelHint(commandId);
    return accel ? `${text} (${accel})` : text;
  };

  const btnConn = main('connection', '连接', () => showConnMenu(btnConn), '新建连接', 'toolbar-connection');
  btnConn.querySelector('.tbtn-label').append(el('span', { class: 'caret' }, ' ▾'));
  const btnQuery = main('query', '新建查询', newQueryFromToolbar, tip('new-query', '新建查询'), 'toolbar-query');

  toolbarContextLabel = el('span', { class: 'toolbar-context-label' });
  toolbarContextEnv = el('span', { class: 'toolbar-context-env', style: { display: 'none' } });
  toolbarContextButton = el('button', {
    class: 'toolbar-context empty',
    type: 'button',
    onClick: () => showToolbarContextMenu(toolbarContextButton),
    title: '当前未选择数据库；点击选择已打开的连接或数据库',
    'aria-label': '当前数据库上下文',
  }, iconEl('connection', 'toolbar-context-icon'), toolbarContextLabel, toolbarContextEnv);

  const btnRefresh = main('refresh', '刷新', () => runMenuAction('refresh'), tip('refresh', '刷新当前对象'));
  const btnSearch = main('filter', '查找', () => runMenuAction('search'), tip('search', '在库中查找'));
  const btnTransfer = main('transfer', '传输', () => runMenuAction('transfer'), '数据传输');
  const btnSync = main('sync', '同步', () => runMenuAction('sync'), '结构/数据同步');
  const btnAi = main('ai', 'AI 助手', openAiPanelFromToolbar, 'AI 助手：优化 / 解释 / 生成 SQL');
  const btnHistory = main('history', '历史', openHistory, '查询历史');
  const btnMore = main('more', '更多', () => showToolbarMoreMenu(btnMore), '更多工具');

  toolbarActionEls = { refresh: btnRefresh, search: btnSearch, transfer: btnTransfer, sync: btnSync };

  tb.append(
    btnConn, btnQuery,
    el('span', { class: 'toolbar-sep' }),
    toolbarContextButton,
    el('span', { class: 'toolbar-sep' }),
    btnRefresh, btnSearch, btnTransfer, btnSync,
    el('span', { class: 'toolbar-spring' }),
    btnAi, btnHistory, btnMore,
  );
  updateToolbarContext();
}

// ---------------- 主题 ----------------
/** 只负责改 DOM。持久化统一走设置中心（setTheme），避免两套存储各写各的。 */
export function applyTheme(t) {
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  // Chromium 对 sticky 合成层在 CSS 变量切换后可能不重绘：整页强制重排（单帧内完成，无闪烁）
  const b = document.body;
  if (b) {
    b.style.display = 'none';
    void b.offsetHeight;
    b.style.display = '';
  }
}
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

// 系统深浅色由主进程的 nativeTheme 判定；这里缓存最近一次结果，
// 设置为「跟随系统」时用它决定实际主题。
let systemPrefersDark = false;

/** 把设置里的 theme（light/dark/system）解析成实际要应用的主题 */
function resolveTheme(value) {
  const setting = value || getSetting('theme');
  if (setting === 'system') return systemPrefersDark ? 'dark' : 'light';
  return setting === 'dark' ? 'dark' : 'light';
}

/** 写设置；实际的 DOM 切换由 onSettingsChange 订阅统一执行，不会重复重排。 */
async function setTheme(next) {
  try { await updateSettings({ theme: next }); }
  catch (error) { toast.error('主题保存失败：' + (error && error.message ? error.message : error)); }
}
/** 手动切换总是切到明确的浅色/深色，从「跟随系统」里跳出来 */
function toggleTheme() {
  return setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

/** 界面缩放：走 Electron 的 setZoomFactor，整体等比放大，不用逐处改 px */
function applyUiScale(percent) {
  const value = Number(percent) || 100;
  if (window.api.app.setZoom) {
    window.api.app.setZoom(value).catch(() => { /* 缩放失败不影响其它功能 */ });
  }
}

/** 套用快捷键方案，并在开发期把键位冲突暴露出来 */
function applyKeymapSetting(name) {
  const scheme = KEYMAPS[name] || KEYMAPS[DEFAULT_KEYMAP];
  applyKeymap(scheme.overrides);
  const conflicts = accelConflicts();
  if (conflicts.length) {
    console.error('[keymap] 键位冲突:', conflicts.map((c) => `${c.accel} → ${c.ids.join(' / ')}`).join('；'));
  }
  // 菜单里的快捷键提示直接来自注册表，换方案后要重建才能显示新键位
  const bar = $('#menubar');
  if (bar && bar.childElementCount) buildMenuBar();
  if (toolbarContextButton) buildToolbar();
}

/** 网格行高档位：只改 CSS 变量，已打开的网格需要重排一次才能量到新行高 */
async function applyGridDensity(density) {
  const value = ['compact', 'default', 'comfortable'].includes(density) ? density : 'default';
  document.documentElement.setAttribute('data-density', value);
  const { refreshAllGrids } = await import('./grid.js');
  refreshAllGrids();
}

async function showAbout() {
  const info = await window.api.app.info();
  openModal({
    title: '关于 DBPanda',
    body: el('div', { style: { lineHeight: '2', fontSize: '13px', minWidth: '320px' } },
      el('div', { style: { fontSize: '17px', fontWeight: '700', letterSpacing: '0.5px' } }, `DBPanda`),
      el('div', { style: { color: 'var(--text-muted)', marginTop: '-4px' } }, `数据之道 · v${info.version}`),
      el('div', { style: { color: 'var(--text-muted)' } }, 'Navicat 风格的数据库管理工具'),
      el('div', {}, `支持: MySQL / MariaDB · PostgreSQL · SQLite · SQL Server · ClickHouse · OceanBase`),
      el('div', { style: { color: 'var(--accent-dark)' } }, '内置 AI 助手：SQL 优化 / 解释 / 排查 / 自然语言生成'),
      el('div', { style: { color: 'var(--text-muted)', fontSize: '12px' } },
        `Electron ${info.electron} · Node ${info.node} · Chromium ${info.chrome}`),
      el('div', { style: { color: 'var(--text-muted)', fontSize: '12px' } },
        '快捷键: Ctrl+R/F5 运行 · Ctrl+Shift+R 运行选中 · Ctrl+F 查找 · Ctrl+H 替换 · Ctrl+D 设计表 · F5 刷新对象 · Ctrl+S 保存 SQL · Ctrl+Tab 切换标签 · Ctrl+W 关闭标签')),
    buttons: [{ label: '确定', primary: true }],
  });
}

// ---------------- 侧栏拖拽 ----------------
function setupSplitter() {
  const splitter = $('#splitter-v');
  const sidebar = $('#sidebar');
  const savedWidth = Number(getSetting('sidebarWidth'));
  if (Number.isFinite(savedWidth) && savedWidth >= 170 && savedWidth <= 560) sidebar.style.width = `${savedWidth}px`;
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebar.getBoundingClientRect().width;
    const move = (ev) => {
      sidebar.style.width = Math.min(560, Math.max(170, startW + ev.clientX - startX)) + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      updateSettings({ sidebarWidth: Math.round(sidebar.getBoundingClientRect().width) })
        .catch(() => { /* 宽度保存失败不影响本次拖拽结果 */ });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// ---------------- 快捷键 ----------------
// 键位不再写死在这里：全部来自命令注册表的 accel 字段，
// 菜单上显示的提示和实际生效的按键因此永远是同一份数据。
function setupShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (window.__APP_READY !== true) return;
    const t = e.target;
    // SQL 编辑器内的按键交给 CodeMirror（Ctrl+R 运行、Ctrl+F 编辑器内查找等）
    const inEditor = !!(t && t.closest && t.closest('.CodeMirror'));
    const inInput = inEditor || !!(t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable));
    const cmd = matchShortcut(e, { inEditor, inInput });
    if (!cmd) return;
    e.preventDefault();
    runCommand(cmd.id);
  });
}

// ---------------- 原生菜单动作 ----------------
function firstOpenTarget(notify = false) {
  const active = getActiveTarget({ requireOpen: true });
  if (active) return active;
  const ids = [...state.open.keys()];
  if (!ids.length) {
    if (notify) toast.info('请先打开一个连接');
    return null;
  }
  if (ids.length > 1) {
    if (notify) toast.info('请先在左侧选择要使用的连接或数据库');
    return null;
  }
  const connId = ids[0];
  const oc = state.open.get(connId);
  const target = { connId, db: (oc.databases && oc.databases[0]) || null };
  setActiveTarget(target, 'single-open-connection');
  return target;
}

/** 执行一条命令。保留这个名字是为了让既有调用点（工具栏等）不必全改。 */
export async function runMenuAction(id) {
  return runCommand(id);
}

// ---------------- 命令登记 ----------------
// 全应用的功能表。新增功能在这里加一条即可：菜单项、快捷键提示、
// 可用状态和（后续的）命令面板都会自动跟上，不必再分头去改三个地方。
const hasOpenConnection = () => state.open.size > 0;

function openEditorSearchFor(replace) {
  const active = getActiveTab();
  const cmi = active && active.handle && active.handle._cm;
  if (!cmi) { toast.info('请先打开一个查询标签页'); return null; }
  return import('./editorSearch.js').then(({ openEditorSearch }) => openEditorSearch(cmi, { replace }));
}

function registerAppCommands() {
  // 每次执行命令时重新解析当前上下文，语义与改造前 runMenuAction 开头的那两行完全一致
  setCommandContextProvider(() => {
    const target = firstOpenTarget();
    return {
      target,
      needConn: () => {
        if (target) return true;
        firstOpenTarget(true);
        return false;
      },
    };
  });

  registerCommands([
    // ---- 文件 ----
    { id: 'new-conn', label: '新建连接…', menu: '文件', accel: 'Ctrl+N', run: () => openConnDialog() },
    { id: 'import-navicat', label: '导入 Navicat 连接…', menu: '文件', run: async () => (await import('./navicatImport.js')).openNavicatImport() },
    { id: 'new-query', label: '新建查询', menu: '文件', accel: 'Ctrl+Q', run: () => newQueryFromToolbar() },
    { id: 'exit', label: '退出', menu: '文件', sepBefore: true, run: () => window.api.app.winCmd('close') },

    // ---- 编辑（由浏览器/CodeMirror 自己处理按键，这里只登记菜单项与提示） ----
    { id: 'edit-undo', label: '撤销', menu: '编辑', accel: 'Ctrl+Z', bind: false, run: () => execEditCommand('undo') },
    { id: 'edit-redo', label: '重做', menu: '编辑', accel: 'Ctrl+Y', bind: false, run: () => execEditCommand('redo') },
    { id: 'edit-cut', label: '剪切', menu: '编辑', accel: 'Ctrl+X', bind: false, sepBefore: true, run: () => execEditCommand('cut') },
    { id: 'edit-copy', label: '复制', menu: '编辑', accel: 'Ctrl+C', bind: false, run: () => execEditCommand('copy') },
    { id: 'edit-paste', label: '粘贴', menu: '编辑', accel: 'Ctrl+V', bind: false, run: () => execEditCommand('paste') },
    { id: 'edit-select-all', label: '全选', menu: '编辑', accel: 'Ctrl+A', bind: false, run: () => execEditCommand('selectAll') },
    // 改名以和「工具 → 在库中查找」区分：两者都是 Ctrl+F，差别在焦点是否在 SQL 编辑器里
    { id: 'editor-find', label: '在编辑器中查找…', menu: '编辑', accel: 'Ctrl+F', bind: false, sepBefore: true, run: () => openEditorSearchFor(false) },
    { id: 'editor-replace', label: '在编辑器中替换…', menu: '编辑', accel: 'Ctrl+H', bind: false, run: () => openEditorSearchFor(true) },

    // ---- 查看 ----
    {
      id: 'refresh', label: '刷新当前库对象', menu: '查看', accel: 'F5', scope: 'notInEditor',
      enabled: hasOpenConnection,
      run: ({ target }) => { if (target && target.db) emit('objects-changed', target); },
    },
    {
      id: 'design-table', label: '设计表', menu: '查看', accel: 'Ctrl+D', scope: 'notInInput',
      run: () => {
        const cur = state.activeTarget;
        if (!cur || !cur.table || !state.open.has(cur.connId)) { toast.info('请先在左侧选择一个表'); return; }
        const oc = state.open.get(cur.connId);
        const objs = oc && oc.objectsCache && oc.objectsCache.get(objectsCacheKey(cur.db, cur.schema));
        const isView = !!(objs && objs.views && objs.views.some((v) => v.name === cur.table));
        actions.designTable({ connId: cur.connId, db: cur.db, schema: cur.schema, table: cur.table }, isView);
      },
    },
    {
      id: 'open-table', label: '打开表', menu: '查看', accel: 'Ctrl+Shift+O', scope: 'notInInput',
      run: () => {
        const cur = state.activeTarget;
        if (!cur || !cur.table || !state.open.has(cur.connId)) { toast.info('请先在左侧选择一个表'); return; }
        openTableTab({ connId: cur.connId, db: cur.db, schema: cur.schema, table: cur.table });
      },
    },
    { id: 'toggle-theme', label: '切换浅色 / 深色主题', menu: '查看', run: () => toggleTheme() },
    { id: 'devtools', label: '开发者工具', menu: '查看', accel: 'F12', bind: false, sepBefore: true, run: () => window.api.app.winCmd('devtools') },

    // ---- 工具 ----
    { id: 'ai-panel', label: 'AI 助手', menu: '工具', run: () => openAiPanelFromToolbar() },
    { id: 'ai-config', label: 'AI 助手设置…', menu: '工具', run: async () => (await import('./aiConfigDialog.js')).openAiConfigDialog() },
    {
      id: 'search', label: '在库中查找…', menu: '工具', accel: 'Ctrl+F', scope: 'notInEditor', sepBefore: true,
      enabled: hasOpenConnection,
      run: async ({ target, needConn }) => {
        if (!needConn()) return;
        const { openSearchDialog } = await import('./searchDialog.js');
        openSearchDialog(target);
      },
    },
    {
      id: 'transfer', label: '数据传输…', menu: '工具', sepBefore: true, enabled: hasOpenConnection,
      run: async ({ target, needConn }) => { if (needConn()) (await import('./dbaTools.js')).openTransferDialog(target); },
    },
    {
      id: 'sync', label: '结构同步 / 数据同步…', menu: '工具', enabled: hasOpenConnection,
      run: async ({ target, needConn }) => { if (needConn()) (await import('./syncDialog.js')).openSyncDialog(target); },
    },
    {
      id: 'goto-table', label: '跳转到表…', menu: '工具', accel: 'Ctrl+P', scope: 'notInInput', sepBefore: true,
      run: async () => (await import('./commandPalette.js')).openCommandPalette('object'),
    },
    {
      id: 'command-palette', label: '命令面板…', menu: '工具', accel: 'Ctrl+Shift+P',
      run: async () => (await import('./commandPalette.js')).openCommandPalette('command'),
    },
    { id: 'history', label: '查询历史', menu: '工具', sepBefore: true, run: () => openHistory() },
    {
      id: 'task-center', label: '任务中心…', menu: '工具',
      run: async () => (await import('./taskTab.js')).openTaskTab(),
    },
    {
      id: 'audit-log', label: '操作审计…', menu: '工具',
      run: async () => (await import('./auditTab.js')).openAuditTab(),
    },
    {
      id: 'security-review', label: '连接安全体检…', menu: '工具',
      run: async () => (await import('./securityDialog.js')).openSecurityDialog(),
    },
    {
      id: 'backup', label: '备份 / 还原…', menu: '工具', sepBefore: true,
      run: async ({ target, needConn }) => {
        if (!needConn()) return;
        if (!target.db) { toast.info('请先在左侧选择数据库'); return; }
        (await import('./backupDialog.js')).openBackupDialog(target);
      },
    },
    {
      id: 'schedule', label: '定时任务…', menu: '工具',
      run: async () => (await import('./scheduleDialog.js')).openScheduleDialog(),
    },
    {
      id: 'data-dict', label: '导出数据字典…', menu: '工具',
      run: async ({ target, needConn }) => {
        if (!needConn()) return;
        if (!target.db) { toast.info('请先在左侧选择数据库'); return; }
        (await import('./dataDictDialog.js')).openDataDictDialog(target);
      },
    },
    { id: 'open-settings', label: '选项…', menu: '工具', sepBefore: true, run: async () => (await import('./settingsDialog.js')).openSettingsDialog() },

    // ---- 窗口 ----
    { id: 'next-tab', label: '下一个标签页', menu: '窗口', accel: 'Ctrl+Tab', run: () => activateRelative(1) },
    { id: 'prev-tab', label: '上一个标签页', menu: '窗口', accel: 'Ctrl+Shift+Tab', run: () => activateRelative(-1) },
    // Ctrl+W 一直是生效的，但过去没出现在任何菜单里，用户无从发现
    { id: 'close-tab', label: '关闭当前标签页', menu: '窗口', accel: 'Ctrl+W', run: () => closeActive() },
    {
      id: 'split-right', label: '在右侧拆分当前标签页', menu: '窗口', accel: 'Ctrl+\\', sepBefore: true,
      run: () => {
        const active = getActiveTab();
        if (!active) { toast.info('请先打开一个标签页'); return; }
        if (getSecondaryTabId() === active.id) { setSecondaryTab(null); return; }
        setSecondaryTab(active.id);
      },
    },
    { id: 'split-none', label: '取消拆分', menu: '窗口', run: () => setSecondaryTab(null) },
    { id: 'win-minimize', label: '最小化', menu: '窗口', sepBefore: true, run: () => window.api.app.winCmd('minimize') },
    { id: 'win-maximize', label: '最大化 / 还原', menu: '窗口', run: () => window.api.app.winCmd('maximize') },
    { id: 'win-close', label: '关闭窗口', menu: '窗口', sepBefore: true, run: () => window.api.app.winCmd('close') },

    // ---- 帮助 ----
    { id: 'check-update', label: '检查更新', menu: '帮助', run: () => checkForUpdates(true) },
    { id: 'github', label: 'GitHub 仓库', menu: '帮助', sepBefore: true, run: () => window.api.app.openExternal('https://github.com/hufafu1-cloud/dbconnect') },
    { id: 'about', label: '关于 DBPanda', menu: '帮助', sepBefore: true, run: () => showAbout() },

    // ---- 不进菜单：只从工具栏「更多」或其它入口调用 ----
    {
      id: 'run-sql-file', label: '运行 SQL 文件…', enabled: hasOpenConnection,
      run: async ({ target, needConn }) => { if (needConn()) (await import('./dbaTools.js')).openRunSqlFileDialog(target); },
    },
    {
      id: 'import', label: '导入向导…',
      run: async ({ target, needConn }) => {
        if (!needConn()) return;
        if (!target.db) { toast.info('请先在左侧选择数据库'); return; }
        (await import('./importWizard.js')).openImportWizard(target);
      },
    },
    {
      id: 'dump', label: '转储 SQL 文件…',
      run: async ({ target, needConn }) => {
        if (!needConn()) return;
        if (!target.db) { toast.info('请先在左侧选择数据库'); return; }
        (await import('./dbaTools.js')).openDumpDialog(target);
      },
    },
    {
      id: 'processes', label: '进程列表', enabled: hasOpenConnection,
      run: async ({ target, needConn }) => {
        if (!needConn()) return;
        const conn = state.connections.find((c) => c.id === target.connId);
        if (conn && ['mysql', 'oceanbase', 'postgres', 'mssql', 'clickhouse'].includes(conn.type)) {
          (await import('./procTab.js')).openProcTab(target.connId);
        } else {
          toast.info('当前连接类型不支持进程列表');
        }
      },
    },
  ]);
}

// ---------------- 退出确认 ----------------
function setupCloseGuard() {
  window.api.app.onCloseRequest(async (requestId) => {
    // Acknowledge before showing a modal: users may legitimately spend longer
    // than the main-process no-response timeout reading the warning.
    window.api.app.ackClose(requestId);
    try {
      if (updateDownloadBusy) {
        const cancelUpdate = await confirmDialog(
          '更新下载中',
          '更新尚未下载完成，退出程序将取消本次更新。是否取消下载并退出？',
          { danger: true, okLabel: '取消下载并退出' },
        );
        if (!cancelUpdate) { window.api.app.cancelClose(requestId); return; }
        try { await window.api.app.updateCancel(); } catch (e) { /* 主进程退出时会再次取消 */ }
        updateDownloadBusy = false;
      }
      if (anyDirty()) {
        const ok = await confirmDialog('退出 DBPanda', '有未保存/未应用的更改，确定退出吗？', { danger: true, okLabel: '退出' });
        if (!ok) { window.api.app.cancelClose(requestId); return; }
      }
      const tabsReady = await runBeforeCloseGuards({ reason: 'app-close' });
      if (!tabsReady) { window.api.app.cancelClose(requestId); return; }
      let timer = null;
      const saved = await Promise.race([
        persistWorkspaceNow(),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (!saved) {
        const exitAnyway = await confirmDialog(
          '工作区草稿未保存',
          '恢复快照写入失败或超时。现在退出可能丢失未保存的 SQL 或设计草稿，是否仍要退出？',
          { danger: true, okLabel: '仍然退出' },
        );
        if (!exitAnyway) { window.api.app.cancelClose(requestId); return; }
      }
      window.api.app.confirmClose(requestId);
    } catch (error) {
      window.api.app.cancelClose(requestId);
      toast.error('退出检查失败，已取消关闭：' + (error && error.message ? error.message : error));
    }
  });
}

// ---------------- 自动化测试钩子（演示/截图模式用） ----------------
function setupTestHooks() {
  window.__test = {
    openConnection: (id) => openConnectionById(id),
    expandDatabase: async (connId, db) => {
      // 找到数据库节点并展开 + 选中
      const node = document.querySelector(`.tree-node[data-reload-key]`);
      const all = document.querySelectorAll('.tree-node');
      for (const n of all) {
        if (n.dataset.reloadKey === `${connId}|${db}`) {
          const row = n.querySelector('.tree-row');
          row.click();
          row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          return true;
        }
      }
      return !!node;
    },
    openTable: (connId, db, schema, table) => {
      openTableTab({ connId, db, schema, table });
      return true;
    },
    openDesigner: async (connId, db, schema, table) => {
      const { openDesignTab } = await import('./designTab.js');
      openDesignTab({ connId, db, schema, table });
      return true;
    },
    runQuery: async (connId, db, sql) => {
      const tab = openQueryTab({ connId, db }, sql);
      await tab._run(false);
      return true;
    },
    openConnDialog: (type) => { openConnDialog(null, type); return true; },
    openTransfer: async (connId, db) => {
      const { openTransferDialog } = await import('./dbaTools.js');
      await openTransferDialog({ connId, db });
      return true;
    },
    openSync: async (connId, db) => {
      const { openSyncDialog } = await import('./syncDialog.js');
      await openSyncDialog({ connId, db });
      return true;
    },
    openSearch: async (connId, db) => {
      const { openSearchDialog } = await import('./searchDialog.js');
      await openSearchDialog({ connId, db });
      return true;
    },
    openEr: async (connId, db) => {
      const { openErTab } = await import('./erTab.js');
      openErTab({ connId, db, schema: null });
      return true;
    },
    openExplain: async (connId, db, sql) => {
      const { openExplainTab } = await import('./explainTab.js');
      openExplainTab({ connId, db }, sql);
      return true;
    },
    testHint: async (connId, db, text) => {
      const { openQueryTab } = await import('./queryTab.js');
      const tab = openQueryTab({ connId, db });
      await tab._loadHints();
      await new Promise((r) => setTimeout(r, 100));
      const cm = tab._cm;
      cm.setValue(text);
      const lines = text.split('\n');
      cm.setCursor({ line: lines.length - 1, ch: lines[lines.length - 1].length });
      cm.focus();
      tab._triggerHint();
      await new Promise((r) => setTimeout(r, 150));
      const items = [...document.querySelectorAll('.CodeMirror-hints li')].map((x) => x.textContent);
      return { count: items.length, items: items.slice(0, 12) };
    },
    openHistory: async () => {
      const { openHistoryTab } = await import('./historyTab.js');
      openHistoryTab();
      return true;
    },
    openAi: async (connId, db, sql, action) => {
      const { openAiPanel } = await import('./aiPanel.js');
      openAiPanel({ connId, db, sql, action });
      return true;
    },
    openAiConfig: async () => {
      const { openAiConfigDialog } = await import('./aiConfigDialog.js');
      openAiConfigDialog();
      return true;
    },
    openSettings: async () => {
      const { openSettingsDialog } = await import('./settingsDialog.js');
      openSettingsDialog();
      return true;
    },
    runCommand: (id) => runCommand(id),
    analyzeDanger: async (sql) => {
      const { analyzeDanger } = await import('./danger.js');
      return analyzeDanger(sql);
    },
    openDangerConfirm: async (connName, sql) => {
      const { analyzeDanger, confirmDangerExecution } = await import('./danger.js');
      const items = analyzeDanger(sql);
      confirmDangerExecution(connName, items.length ? items : [{ level: 'high', reason: '示例危险语句', sql }]);
      return items.length;
    },
    saveDemoQuery: async (connId, name, sql) => {
      await window.api.queries.save({ connId, name, sql });
      emit('queries-changed', { connId });
      return true;
    },
    openConnMenu: () => {
      const b = document.querySelector('#toolbar .toolbar-connection') || document.querySelector('#toolbar .tbtn');
      if (b) b.click();
      return !!b;
    },
    closeMenus: () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return true;
    },
    setTheme: (t) => { applyTheme(t); return true; },
  };
}

// ---------------- 启动 ----------------
let workspaceEntryRestorer = null;
let workspaceBooted = false;
const pendingRestoreConnectionIds = new Set();

async function boot() {
  window.__APP_READY = false;
  $('#app').classList.add('workspace-loading');
  // 设置先于任何界面构建载入：主题、侧栏宽度都要用到，晚一步就会先闪一下默认样式
  await loadSettings();
  try { systemPrefersDark = await window.api.app.systemDark(); } catch (e) { /* 取不到就按浅色 */ }
  applyTheme(resolveTheme());
  applyUiScale(getSetting('uiScale'));
  document.documentElement.setAttribute('data-density', getSetting('gridDensity') || 'default');
  onSettingsChange((next, changed) => {
    if (changed.includes('theme')) applyTheme(resolveTheme(next.theme));
    if (changed.includes('uiScale')) applyUiScale(next.uiScale);
    if (changed.includes('gridDensity')) applyGridDensity(next.gridDensity);
    if (changed.includes('keymap')) applyKeymapSetting(next.keymap);
  });
  // 系统深浅色变了，只有设置为「跟随系统」时才跟着切
  if (window.api.app.onSystemTheme) {
    window.api.app.onSystemTheme((dark) => {
      systemPrefersDark = dark;
      if (getSetting('theme') === 'system') applyTheme(resolveTheme());
    });
  }
  // 菜单栏和工具栏都从命令注册表生成，必须先登记
  registerAppCommands();
  applyKeymapSetting(getSetting('keymap'));
  buildMenuBar();
  buildToolbar();
  setupUpdaterEvents();
  // 侧栏标题（Navicat 的“我的连接”）
  const head = $('#sidebar-head');
  if (head && !head.querySelector('.sidebar-title')) {
    const locateButton = el('button', {
      class: 'sidebar-locate',
      title: '在目录树中定位当前打开的表',
      'aria-label': '在目录树中定位当前打开的表',
      onClick: async () => {
        const activeTab = getActiveTab();
        const target = activeTab && activeTab.target && activeTab.target.table
          ? activeTab.target
          : null;
        if (!target || !target.table) {
          toast.info('请先打开一个表标签');
          return;
        }
        if (!state.open.has(target.connId)) {
          toast.info('该表所属连接已关闭');
          return;
        }
        const found = await revealTarget(target).catch(() => false);
        if (!found) toast.info('目录树中未找到该表，请先刷新对象列表');
      },
    }, iconEl('locate'));
    head.prepend(el('div', { class: 'sidebar-title' }, iconEl('connection'), el('span', {}, '我的连接'), locateButton));
  }
  initObjectsTab();
  setupTaskIndicator();
  setupSplitter();
  setupShortcuts();
  setupCloseGuard();
  setupTestHooks();
  await reloadConnections();
  setupTreeFilter();
  const savedWorkspace = await getStoredWorkspace();
  const knownIds = new Set(state.connections.map((c) => c.id));
  const restoreIds = Array.isArray(savedWorkspace.context && savedWorkspace.context.openConnectionIds)
    ? [...new Set(savedWorkspace.context.openConnectionIds.filter((id) => typeof id === 'string' && knownIds.has(id)))]
    : [];
  for (const id of restoreIds) pendingRestoreConnectionIds.add(id);
  // 收藏 / 最近跟着工作区一起存：它们是会增长的条目列表，不适合放白名单式的设置中心
  initRecentStore(savedWorkspace.context && savedWorkspace.context.shortcuts, touchWorkspacePersistence);
  setWorkspaceContextProvider(() => ({
    shortcuts: snapshotRecentStore(),
    openConnectionIds: [...new Set([
      ...state.open.keys(),
      ...[...pendingRestoreConnectionIds].filter((id) => state.connections.some((c) => c.id === id)),
    ])],
    activeTarget: state.activeTarget ? { ...state.activeTarget } : null,
  }));

  if (restoreIds.length) statusbar.setLeft(`正在恢复工作区连接（0/${restoreIds.length}）…`);
  for (let i = 0; i < restoreIds.length; i++) {
    try { await openConnectionById(restoreIds[i]); } catch (e) { /* 单个连接失败不阻止草稿恢复 */ }
    if (state.open.has(restoreIds[i])) pendingRestoreConnectionIds.delete(restoreIds[i]);
    statusbar.setLeft(`正在恢复工作区连接（${i + 1}/${restoreIds.length}）…`);
  }

  workspaceEntryRestorer = async (entry) => {
    const s = entry && entry.state;
    if (!s || typeof s !== 'object') return false;
    if (entry.type === 'query') return openQueryTab(s.target || null, s.sql || '', { restoreId: entry.id, restoreState: s });
    if (entry.type === 'table') {
      if (!s.target || !knownIds.has(s.target.connId)) return false;
      if (!state.open.has(s.target.connId)) return null;
      return openTableTab(s.target, { restoreId: entry.id, restoreState: s });
    }
    if (entry.type === 'history') return openHistory();
    if (entry.type === 'design') {
      if (!s.target) return false;
      if (!knownIds.has(s.target.connId)) {
        // New/dirty designs are self-contained user drafts. Keep them orphaned
        // until the connection is recreated or the user explicitly discards
        // them; a missing connection record must not silently erase work.
        const recoverableDraft = s.model && typeof s.model === 'object'
          && (s.dirty === true || !s.target.table);
        return recoverableDraft ? null : false;
      }
      if (!state.open.has(s.target.connId)) return null;
      const { openDesignTab } = await import('./designTab.js');
      const handle = openDesignTab(s.target, { restoreId: entry.id, restoreState: s });
      if (handle.workspaceReady && !(await handle.workspaceReady)) {
        await handle.close(true);
        return null;
      }
      return handle;
    }
    return false;
  };
  const recovery = await restoreWorkspaceTabs(workspaceEntryRestorer);
  workspaceBooted = true;
  const savedTarget = savedWorkspace.context && savedWorkspace.context.activeTarget;
  if (savedTarget && state.open.has(savedTarget.connId)) await revealTarget(savedTarget).catch(() => {});
  statusbar.setLeft(recovery.restored || state.open.size
    ? `工作区已恢复 · ${state.open.size} 个连接 · ${recovery.restored} 个标签${recovery.deferred ? ` · ${recovery.deferred} 个待连接后恢复` : ''}`
    : '就绪 — 新建或打开一个连接开始使用');
  $('#app').classList.remove('workspace-loading');
  window.__APP_READY = true;
  setTimeout(() => checkForUpdates(false), 5000);
}

on('conn-opened', async ({ connId } = {}) => {
  updateToolbarContext();
  if (connId) pendingRestoreConnectionIds.delete(connId);
  touchWorkspacePersistence();
  if (workspaceBooted && workspaceEntryRestorer && connId) {
    const retried = await retryDeferredWorkspaceTabs(
      workspaceEntryRestorer,
      (entry) => entry && entry.state && entry.state.target && entry.state.target.connId === connId,
    );
    if (retried.restored) toast.success(`已继续恢复 ${retried.restored} 个工作标签`);
  }
});
on('conn-closed', (detail) => { updateToolbarContext(); touchWorkspacePersistence(detail); });
on('connections-changed', () => updateToolbarContext());
// 连接删掉后，它名下的收藏/最近一并清掉，免得点了打不开
on('conn-removed', (detail) => { if (detail && detail.connId) dropConnection(detail.connId); });
on('target-selected', (detail) => { updateToolbarContext(detail); touchWorkspacePersistence(detail); });
boot().catch((e) => {
  $('#app').classList.remove('workspace-loading');
  if (e && e.code === 'WORKSPACE_READ_FAILED') {
    window.__APP_READY = true;
    statusbar.setLeft('工作区自动恢复/保存已停用，本次可继续手动使用');
  }
  console.error(e);
  toast.error((e && e.code === 'WORKSPACE_READ_FAILED' ? '工作区恢复失败: ' : '初始化失败: ') + e.message, 15000);
});
