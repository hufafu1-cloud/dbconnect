// 进程/会话监控页（MySQL/OB、PostgreSQL、SQL Server、ClickHouse）
import { el, iconEl, fmtCount } from './util.js';
import { connLabel, connColor } from './state.js';
import { addTab } from './tabs.js';
import { DataGrid } from './grid.js';
import { toast, confirmDialog } from './toast.js';
import { authorizeOperation } from './danger.js';

const COLS = [
  { name: 'ID', type: '' },
  { name: '用户', type: '' },
  { name: '数据库', type: '' },
  { name: '状态', type: '' },
  { name: '耗时(秒)', type: 'int' },
  { name: 'SQL / 信息', type: '' },
];

export function openProcTab(connId) {
  const tab = addTab({
    id: `proc:${connId}`,
    title: `进程 - ${connLabel(connId)}`,
    icon: 'monitor',
    color: connColor(connId),
    tooltip: `${connLabel(connId)} 进程列表`,
  });
  if (tab.pane.childElementCount) return tab;

  let procs = [];
  let timer = null;
  let loading = false;

  const grid = new DataGrid(el('div'), { editable: false });
  grid.host.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;';

  const filterInput = el('input', { type: 'text', placeholder: '过滤（用户/库/SQL）…', style: { width: '180px' } });
  const autoChk = el('input', { type: 'checkbox' });
  const infoEl = el('span', {}, '');

  const btnKill = el('button', { class: 'pbtn danger', onClick: killSelected }, iconEl('cross'), '结束进程');

  const toolbar = el('div', { class: 'pane-toolbar' },
    el('button', { class: 'pbtn', onClick: load }, iconEl('refresh'), '刷新'),
    el('label', { class: 'form-check' }, autoChk, '自动刷新 (5s)'),
    el('span', { class: 'sep' }),
    btnKill,
    el('span', { class: 'spring' }),
    filterInput,
  );
  const footer = el('div', { class: 'pane-info' }, infoEl);
  tab.pane.append(toolbar, grid.host, footer);

  filterInput.addEventListener('input', render);

  function filtered() {
    const q = filterInput.value.trim().toLowerCase();
    if (!q) return procs;
    return procs.filter((p) =>
      (p.user || '').toLowerCase().includes(q) ||
      (p.db || '').toLowerCase().includes(q) ||
      (p.info || '').toLowerCase().includes(q) ||
      String(p.id).includes(q));
  }

  function render() {
    const list = filtered();
    grid.setData({
      columns: COLS,
      rows: list.map((p) => [p.id, p.user, p.db, p.state, p.timeSec, p.info]),
      pk: [],
    });
    infoEl.textContent = `共 ${fmtCount(procs.length)} 个会话${filterInput.value.trim() ? ` · 显示 ${list.length}` : ''} · ${new Date().toLocaleTimeString('zh-CN')}`;
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      procs = await window.api.db.processes(connId);
      render();
    } catch (e) {
      infoEl.textContent = '加载失败: ' + e.message;
    } finally {
      loading = false;
    }
  }

  async function killSelected() {
    const list = filtered();
    const sel = [...grid.selection].map((i) => list[i]).filter(Boolean);
    if (!sel.length) { toast.info('请先选中要结束的会话行'); return; }
    const payload = { connId, pids: sel.map((p) => p.id) };
    try {
      const approved = await authorizeOperation('db.killProcesses', payload, {
        confirmSafe: () => confirmDialog('结束进程',
          `确定结束 ${sel.length} 个会话吗？\n${sel.map((p) => `#${p.id} ${p.user || ''}`).join('\n')}`,
          { danger: true, okLabel: '结束' }),
      });
      if (!approved) return;
      const result = await window.api.db.killProcesses(connId, approved.pids, approved.approvalToken);
      if (result.count) toast.success(`已结束 ${result.count} 个会话`);
    } catch (e) {
      toast.error('结束会话失败: ' + e.message);
    }
    await load();
  }

  autoChk.addEventListener('change', () => {
    if (autoChk.checked) {
      timer = setInterval(() => {
        if (tab.pane.classList.contains('active')) load();
      }, 5000);
    } else {
      clearInterval(timer);
      timer = null;
    }
  });
  tab.setOnClose(() => clearInterval(timer));
  tab.setOnShow(() => load());

  load();
  return tab;
}
