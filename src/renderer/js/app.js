// 渲染进程入口：装配工具栏、树、标签页、快捷键与自动化测试钩子
import { $, el, iconEl } from './util.js';
import { state, reloadConnections, on, emit } from './state.js';
import { toast, openModal, confirmDialog } from './toast.js';
import { showMenu } from './contextmenu.js';
import { renderTree, setupTreeFilter, openConnectionById } from './tree.js';
import { initObjectsTab } from './objectsTab.js';
import { addTab, closeActive, anyDirty, getActiveTab } from './tabs.js';
import { openConnDialog } from './connDialog.js';
import * as actions from './actions.js';
import { openQueryTab } from './queryTab.js';
import { openTableTab } from './tableTab.js';
import { statusbar } from './statusbar.js';

// ---------------- 工具栏（Navicat 风格大图标） ----------------
function newQueryFromToolbar() {
  let t = state.activeTarget;
  if (!t || !state.open.has(t.connId)) {
    const first = [...state.open.keys()][0];
    if (!first) { toast.info('请先打开一个连接'); return; }
    const oc = state.open.get(first);
    t = { connId: first, db: (oc.databases && oc.databases[0]) || null };
  }
  actions.newQuery(t);
}

async function openHistory() {
  const { openHistoryTab } = await import('./historyTab.js');
  openHistoryTab();
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

  const btnHistory = big('history', '历史', openHistory);
  const btnTheme = big('theme', '主题', toggleTheme, '切换浅色/深色主题');
  const btnAbout = big('info', '关于', showAbout);

  tb.append(
    btnConn, btnQuery,
    el('span', { class: 'toolbar-sep' }),
    ...kindEls,
    el('span', { class: 'toolbar-spring' }),
    btnHistory, btnTheme, btnAbout,
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
    title: '关于 DBConnect',
    body: el('div', { style: { lineHeight: '2', fontSize: '13px', minWidth: '320px' } },
      el('div', { style: { fontSize: '16px', fontWeight: '600' } }, `DBConnect v${info.version}`),
      el('div', { style: { color: 'var(--text-muted)' } }, 'Navicat 风格的数据库管理工具'),
      el('div', {}, `支持: MySQL / MariaDB · PostgreSQL · SQLite · SQL Server`),
      el('div', { style: { color: 'var(--text-muted)', fontSize: '12px' } },
        `Electron ${info.electron} · Node ${info.node} · Chromium ${info.chrome}`),
      el('div', { style: { color: 'var(--text-muted)', fontSize: '12px' } },
        '快捷键: F5/Ctrl+Enter 运行查询 · Ctrl+S 保存 SQL · Ctrl+W 关闭标签 · F12 开发者工具')),
    buttons: [{ label: '确定', primary: true }],
  });
}

// ---------------- 侧栏拖拽 ----------------
function setupSplitter() {
  const splitter = $('#splitter-v');
  const sidebar = $('#sidebar');
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
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// ---------------- 快捷键 ----------------
function setupShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      closeActive();
    }
  });
}

// ---------------- 原生菜单动作 ----------------
function firstOpenTarget() {
  let t = state.activeTarget;
  if (t && state.open.has(t.connId)) return t;
  const first = [...state.open.keys()][0];
  if (!first) return null;
  const oc = state.open.get(first);
  return { connId: first, db: (oc.databases && oc.databases[0]) || null };
}

function setupMenuActions() {
  if (!window.api.app.onMenuAction) return;
  window.api.app.onMenuAction(async (id) => {
    const t = firstOpenTarget();
    const needConn = () => { if (!t) toast.info('请先打开一个连接'); return !!t; };
    switch (id) {
      case 'new-conn': openConnDialog(); break;
      case 'new-query': newQueryFromToolbar(); break;
      case 'run-sql-file': if (needConn()) (await import('./dbaTools.js')).openRunSqlFileDialog(t); break;
      case 'transfer': if (needConn()) (await import('./dbaTools.js')).openTransferDialog(t); break;
      case 'sync': if (needConn()) (await import('./syncDialog.js')).openSyncDialog(t); break;
      case 'dump': if (needConn() && t.db) (await import('./dbaTools.js')).openDumpDialog(t); else if (t && !t.db) toast.info('请先在左侧选择数据库'); break;
      case 'import': if (needConn() && t.db) (await import('./importWizard.js')).openImportWizard(t); else if (t && !t.db) toast.info('请先在左侧选择数据库'); break;
      case 'history': openHistory(); break;
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
      case 'toggle-theme': toggleTheme(); break;
      case 'about': showAbout(); break;
      default: break;
    }
  });
}

// ---------------- 退出确认 ----------------
function setupCloseGuard() {
  window.api.app.onCloseRequest(async () => {
    if (!anyDirty()) { window.api.app.confirmClose(); return; }
    const ok = await confirmDialog('退出 DBConnect', '有未保存/未应用的更改，确定退出吗？', { danger: true, okLabel: '退出' });
    if (ok) window.api.app.confirmClose();
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
    openHistory: async () => {
      const { openHistoryTab } = await import('./historyTab.js');
      openHistoryTab();
      return true;
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
async function boot() {
  try { applyTheme(localStorage.getItem('dbc-theme') || 'light'); } catch (e) { /* ignore */ }
  buildToolbar();
  // 侧栏标题（Navicat 的“我的连接”）
  const head = $('#sidebar-head');
  if (head && !head.querySelector('.sidebar-title')) {
    head.prepend(el('div', { class: 'sidebar-title' }, iconEl('connection'), '我的连接'));
  }
  setupMenuActions();
  initObjectsTab();
  setupSplitter();
  setupShortcuts();
  setupCloseGuard();
  setupTestHooks();
  await reloadConnections();
  setupTreeFilter();
  statusbar.setLeft('就绪 — 新建或打开一个连接开始使用');
  window.__APP_READY = true;
}

on('conn-opened', () => {});
boot().catch((e) => {
  console.error(e);
  toast.error('初始化失败: ' + e.message);
});
