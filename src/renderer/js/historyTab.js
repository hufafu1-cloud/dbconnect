// 查询历史标签页：浏览 / 搜索 / 复制 / 在查询中重新打开
import { el, iconEl, debounce } from './util.js';
import { state, on } from './state.js';
import { addTab } from './tabs.js';
import { toast, confirmDialog, cellViewer } from './toast.js';
import { showMenu } from './contextmenu.js';
import { openQueryTab } from './queryTab.js';

let listEl = null;
let searchEl = null;
let countEl = null;
let opened = false;

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function refresh() {
  if (!listEl) return;
  let items = [];
  try {
    items = await window.api.history.list({ search: searchEl.value || '', limit: 300 });
  } catch (e) {
    listEl.innerHTML = '';
    listEl.append(el('div', { class: 'obj-placeholder' }, '读取历史失败: ' + e.message));
    return;
  }
  countEl.textContent = items.length ? `${items.length} 条` : '';
  listEl.innerHTML = '';
  if (!items.length) {
    listEl.append(el('div', { class: 'obj-placeholder' }, '暂无查询历史。在查询标签页执行过的 SQL 会自动记录在这里。'));
    return;
  }
  const table = el('table', { class: 'obj-table' },
    el('thead', {}, el('tr', {},
      el('th', { style: { width: '150px' } }, '时间'),
      el('th', { style: { width: '40px' } }, '状态'),
      el('th', { style: { width: '14%' } }, '连接'),
      el('th', { style: { width: '12%' } }, '数据库'),
      el('th', {}, 'SQL'),
      el('th', { style: { width: '76px', textAlign: 'right' } }, '耗时'))));
  const tb = el('tbody');
  for (const it of items) {
    const sqlOneLine = String(it.sql || '').replace(/\s+/g, ' ').trim();
    const tr = el('tr', { title: '双击在查询中打开' },
      el('td', { style: { fontFamily: 'var(--mono)', fontSize: '12px' } }, fmtTime(it.ts)),
      el('td', { style: { textAlign: 'center' } }, it.ok ? '✅' : '❌'),
      el('td', {}, it.connName || '(未知)'),
      el('td', {}, it.db || ''),
      el('td', { style: { fontFamily: 'var(--mono)', fontSize: '12px', maxWidth: '400px' } },
        sqlOneLine.length > 120 ? sqlOneLine.slice(0, 120) + '…' : sqlOneLine),
      el('td', { style: { textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '12px' } }, `${it.ms} ms`));
    tr.addEventListener('dblclick', () => reopen(it));
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: '在查询中打开', icon: 'query', onClick: () => reopen(it) },
        { label: '查看完整 SQL', icon: 'info', onClick: () => cellViewer('SQL', it.sql + (it.error ? '\n\n-- 错误: ' + it.error : '')) },
        { label: '复制 SQL', icon: 'copy', onClick: () => { navigator.clipboard.writeText(it.sql); toast.success('已复制'); } },
      ]);
    });
    tb.append(tr);
  }
  table.append(tb);
  listEl.append(table);
}

function reopen(it) {
  if (!state.open.has(it.connId)) {
    toast.info(`连接 “${it.connName}” 未打开，请先在左侧打开连接（SQL 已复制到新查询中）`);
  }
  openQueryTab({ connId: it.connId, db: it.db || null }, it.sql);
}

export function openHistoryTab() {
  const tab = addTab({ id: 'history', title: '历史', icon: 'history' });
  tab.setRecovery('history', () => ({}));
  if (tab.pane.childElementCount) { refresh(); return tab; }

  const pane = tab.pane;
  pane.classList.add('objects-pane');
  countEl = el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '');
  searchEl = el('input', { type: 'text', placeholder: '搜索 SQL / 连接 / 库…', style: { width: '220px' } });
  searchEl.addEventListener('input', debounce(refresh, 250));
  const toolbar = el('div', { class: 'pane-toolbar' },
    el('button', { class: 'pbtn', onClick: refresh }, iconEl('refresh'), '刷新'),
    el('button', { class: 'pbtn danger', onClick: async () => {
      const ok = await confirmDialog('清空历史', '确定清空全部查询历史吗？', { danger: true, okLabel: '清空' });
      if (!ok) return;
      await window.api.history.clear();
      refresh();
    } }, iconEl('trash'), '清空'),
    el('span', { class: 'spring' }),
    countEl,
    searchEl,
  );
  listEl = el('div', { class: 'obj-list' });
  pane.append(toolbar, listEl);
  tab.setOnShow(() => refresh());

  if (!opened) {
    opened = true;
    on('history-changed', () => { if (listEl && listEl.isConnected) refresh(); });
  }
  refresh();
  return tab;
}
