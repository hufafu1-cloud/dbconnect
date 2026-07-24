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
} from './tabs.js';
import { openConnDialog } from './connDialog.js';
import * as actions from './actions.js';
import { openQueryTab } from './queryTab.js';
import { openTableTab } from './tableTab.js';
import { statusbar } from './statusbar.js';

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

const kindBtns = new Map();
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

function buildToolbar() {
  const tb = $('#toolbar');
  tb.innerHTML = '';
  const big = (icon, label, onClick, title) => {
    const span = el('span', {}, label);
    return el('button', { class: 'tbtn-big', onClick, title: title || label }, iconEl(icon), span);
  };

  const btnConn = big('connection', '连接', () => showConnMenu(btnConn), '新建连接');
  btnConn.querySelector('span').append(el('span', { class: 'caret' }, ' ▾'));
  const btnQuery = big('query', '新建查询', newQueryFromToolbar);

  // 对象类型切换（Navicat 式：表/视图/函数/…）
  const kindDefs = [
    ['table', 'table', '表'],
    ['view', 'view', '视图'],
    ['routine', 'func', '函数'],
    ['trigger', 'trigger', '触发器'],
    ['event', 'eventIcon', '事件'],
    ['sequence', 'sequence', '序列'],
    ['user', 'user', '用户'],
    ['query', 'query', '查询'],
  ];
  kindBtns.clear();
  const kindEls = [];
  for (const [kind, icon, label] of kindDefs) {
    const b = big(icon, label, async () => {
      const { setObjectKind } = await import('./objectsTab.js');
      const { activate } = await import('./tabs.js');
      activate('objects');
      await setObjectKind(kind);
    }, `查看${label}`);
    if (kind === 'table') b.classList.add('active');
    kindBtns.set(kind, b);
    kindEls.push(b);
  }
  on('objkind-changed', (k) => {
    for (const [kk, b] of kindBtns) b.classList.toggle('active', kk === k);
  });

  const btnAi = big('ai', 'AI 助手', openAiPanelFromToolbar, 'AI 助手：优化 / 解释 / 生成 SQL');
  const btnHistory = big('history', '历史', openHistory);
  const btnTheme = big('theme', '主题', toggleTheme, '切换浅色/深色主题');
  const btnAbout = big('info', '关于', showAbout);

  tb.append(
    btnConn, btnQuery,
    el('span', { class: 'toolbar-sep' }),
    ...kindEls,
    el('span', { class: 'toolbar-spring' }),
    btnAi, btnHistory, btnTheme, btnAbout,
  );
}

// ---------------- 主题 ----------------
export function applyTheme(t) {
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('dbc-theme', t); } catch (e) { /* ignore */ }
  // Chromium 对 sticky 合成层在 CSS 变量切换后可能不重绘：整页强制重排（单帧内完成，无闪烁）
  const b = document.body;
  if (b) {
    b.style.display = 'none';
    void b.offsetHeight;
    b.style.display = '';
  }
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
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
  try {
    const savedWidth = Number(localStorage.getItem('dbpanda-sidebar-width'));
    if (Number.isFinite(savedWidth) && savedWidth >= 170 && savedWidth <= 560) sidebar.style.width = `${savedWidth}px`;
  } catch (e) { /* localStorage may be unavailable */ }
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
      try { localStorage.setItem('dbpanda-sidebar-width', String(Math.round(sidebar.getBoundingClientRect().width))); } catch (e) { /* ignore */ }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// ---------------- 快捷键 ----------------
function setupShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (window.__APP_READY !== true) return;
    const t = e.target;
    // SQL 编辑器内的按键交给 CodeMirror（F5 运行、Ctrl+F 编辑器内查找等）
    const inEditor = !!(t && t.closest && t.closest('.CodeMirror'));
    const inInput = inEditor || !!(t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable));
    if (e.key === 'F5' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (!inEditor) { e.preventDefault(); runMenuAction('refresh'); }
      return;
    }
    if (e.ctrlKey && !e.altKey && e.key === 'Tab') {
      e.preventDefault();
      activateRelative(e.shiftKey ? -1 : 1);
      return;
    }
    if (!e.ctrlKey || e.shiftKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'w') { e.preventDefault(); closeActive(); }
    else if (k === 'n') { e.preventDefault(); runMenuAction('new-conn'); }
    else if (k === 'q') { e.preventDefault(); runMenuAction('new-query'); }
    else if (k === 'd') { if (!inInput) { e.preventDefault(); runMenuAction('design-table'); } }
    else if (k === 'f') { if (!inEditor) { e.preventDefault(); runMenuAction('search'); } }
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

export async function runMenuAction(id) {
  const t = firstOpenTarget();
  const needConn = () => {
    if (t) return true;
    firstOpenTarget(true);
    return false;
  };
  switch (id) {
      case 'new-conn': openConnDialog(); break;
      case 'import-navicat': (await import('./navicatImport.js')).openNavicatImport(); break;
      case 'new-query': newQueryFromToolbar(); break;
      case 'search': {
        if (!needConn()) break;
        const { openSearchDialog } = await import('./searchDialog.js');
        openSearchDialog(t);
        break;
      }
      case 'run-sql-file': if (needConn()) (await import('./dbaTools.js')).openRunSqlFileDialog(t); break;
      case 'transfer': if (needConn()) (await import('./dbaTools.js')).openTransferDialog(t); break;
      case 'sync': if (needConn()) (await import('./syncDialog.js')).openSyncDialog(t); break;
      case 'dump': if (needConn() && t.db) (await import('./dbaTools.js')).openDumpDialog(t); else if (t && !t.db) toast.info('请先在左侧选择数据库'); break;
      case 'import': if (needConn() && t.db) (await import('./importWizard.js')).openImportWizard(t); else if (t && !t.db) toast.info('请先在左侧选择数据库'); break;
      case 'history': openHistory(); break;
      case 'ai-panel': openAiPanelFromToolbar(); break;
      case 'ai-config': { const { openAiConfigDialog } = await import('./aiConfigDialog.js'); openAiConfigDialog(); break; }
      case 'processes': {
        if (!needConn()) break;
        const conn = state.connections.find((c) => c.id === t.connId);
        if (conn && ['mysql', 'oceanbase', 'postgres', 'mssql', 'clickhouse'].includes(conn.type)) {
          (await import('./procTab.js')).openProcTab(t.connId);
        } else {
          toast.info('当前连接类型不支持进程列表');
        }
        break;
      }
      case 'refresh': if (t && t.db) emit('objects-changed', t); break;
      case 'design-table': {
        const cur = state.activeTarget;
        if (!cur || !cur.table || !state.open.has(cur.connId)) { toast.info('请先在左侧选择一个表'); break; }
        const oc = state.open.get(cur.connId);
        const objs = oc && oc.objectsCache && oc.objectsCache.get(objectsCacheKey(cur.db, cur.schema));
        const isView = !!(objs && objs.views && objs.views.some((v) => v.name === cur.table));
        actions.designTable({ connId: cur.connId, db: cur.db, schema: cur.schema, table: cur.table }, isView);
        break;
      }
      case 'editor-find':
      case 'editor-replace': {
        const active = getActiveTab();
        const cmi = active && active.handle && active.handle._cm;
        if (!cmi) { toast.info('请先打开一个查询标签页'); break; }
        const { openEditorSearch } = await import('./editorSearch.js');
        openEditorSearch(cmi, { replace: id === 'editor-replace' });
        break;
      }
      case 'next-tab': activateRelative(1); break;
      case 'prev-tab': activateRelative(-1); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'about': showAbout(); break;
      case 'check-update': checkForUpdates(true); break;
      default: break;
    }
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
      const b = document.querySelector('#toolbar .tbtn-big') || document.querySelector('#toolbar .tbtn');
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
  try { applyTheme(localStorage.getItem('dbc-theme') || 'light'); } catch (e) { /* ignore */ }
  const { buildMenuBar } = await import('./menubar.js');
  buildMenuBar(runMenuAction);
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
  setWorkspaceContextProvider(() => ({
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
on('conn-closed', touchWorkspacePersistence);
on('target-selected', touchWorkspacePersistence);
boot().catch((e) => {
  $('#app').classList.remove('workspace-loading');
  if (e && e.code === 'WORKSPACE_READ_FAILED') {
    window.__APP_READY = true;
    statusbar.setLeft('工作区自动恢复/保存已停用，本次可继续手动使用');
  }
  console.error(e);
  toast.error((e && e.code === 'WORKSPACE_READ_FAILED' ? '工作区恢复失败: ' : '初始化失败: ') + e.message, 15000);
});
