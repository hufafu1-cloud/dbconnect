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

// ---------------- 工具栏 ----------------
function buildToolbar() {
  const tb = $('#toolbar');
  const btnConn = el('button', { class: 'tbtn primary' }, iconEl('plus'), '新建连接', el('span', { style: { fontSize: '9px' } }, '▾'));
  btnConn.addEventListener('click', () => {
    const r = btnConn.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, [
      { label: 'MySQL / MariaDB', icon: 'mysql', onClick: () => openConnDialog(null, 'mysql') },
      { label: 'PostgreSQL', icon: 'postgres', onClick: () => openConnDialog(null, 'postgres') },
      { label: 'SQLite', icon: 'sqlite', onClick: () => openConnDialog(null, 'sqlite') },
      { label: 'SQL Server', icon: 'mssql', onClick: () => openConnDialog(null, 'mssql') },
      { label: 'ClickHouse', icon: 'clickhouse', onClick: () => openConnDialog(null, 'clickhouse') },
      { label: 'OceanBase (MySQL 模式)', icon: 'oceanbase', onClick: () => openConnDialog(null, 'oceanbase') },
      { label: 'OceanBase (Oracle 模式)', icon: 'oboracle', onClick: () => openConnDialog(null, 'oboracle') },
    ]);
  });

  const btnQuery = el('button', { class: 'tbtn', onClick: () => {
    let t = state.activeTarget;
    if (!t || !state.open.has(t.connId)) {
      const first = [...state.open.keys()][0];
      if (!first) { toast.info('请先打开一个连接'); return; }
      const oc = state.open.get(first);
      t = { connId: first, db: (oc.databases && oc.databases[0]) || null };
    }
    actions.newQuery(t);
  } }, iconEl('query'), '新建查询');

  const btnHistory = el('button', { class: 'tbtn', onClick: async () => {
    const { openHistoryTab } = await import('./historyTab.js');
    openHistoryTab();
  } }, iconEl('history'), '历史');

  const btnAbout = el('button', { class: 'tbtn', onClick: showAbout }, iconEl('info'), '关于');

  tb.append(btnConn, btnQuery, btnHistory, el('span', { class: 'toolbar-spring' }), btnAbout);
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
      document.querySelector('#toolbar .tbtn').click();
      return true;
    },
    closeMenus: () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return true;
    },
  };
}

// ---------------- 启动 ----------------
async function boot() {
  buildToolbar();
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
