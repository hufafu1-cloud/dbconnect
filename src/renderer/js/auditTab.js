// 操作审计标签页：谁、什么时候、对哪个库、做了什么、成没成。
//
// 数据来自第一步就埋好的主进程审计日志（%APPDATA%/DBPanda/audit.log），
// 所以这个界面一打开就有真实历史，而不是从今天开始记。
//
// 用虚拟滚动的 DataGrid 承载：审计日志动辄上万条，整表渲染会直接卡死。
// 审计日志刻意不提供「清空」按钮——能一键抹掉的审计等于没有审计。
import { el, iconEl, debounce, fmtCount } from './util.js';
import { state } from './state.js';
import { addTab } from './tabs.js';
import { DataGrid } from './grid.js';
import { toast, cellViewer } from './toast.js';
import { t } from './i18n.js';

const TAB_ID = 'audit-log';
const COLUMNS = [
  { name: '时间', type: 'text' },
  { name: '结果', type: 'text' },
  { name: '操作', type: 'text' },
  { name: '连接', type: 'text' },
  { name: '数据库', type: 'text' },
  { name: '耗时(ms)', type: 'int' },
  { name: '生产审批', type: 'text' },
  { name: '详情', type: 'text' },
];

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function connName(connId) {
  if (!connId) return '';
  const conn = state.connections.find((c) => c.id === connId);
  return conn ? conn.name : connId;
}

/** 一条记录里最有排查价值的那段文本：SQL 优先，其次错误，再次参数摘要 */
function detailOf(entry) {
  const args = entry.args || {};
  if (args.sql) return String(args.sql).replace(/\s+/g, ' ').trim();
  if (!entry.ok && entry.error) return String(entry.error);
  if (args.table) return `${args.schema ? args.schema + '.' : ''}${args.table}`;
  if (args.file) return String(args.file);
  try { return JSON.stringify(args); } catch (e) { return ''; }
}

function toRow(entry) {
  return [
    fmtTime(entry.at),
    entry.ok === false ? '失败' : '成功',
    entry.channel || '',
    connName(entry.connId),
    entry.db || '',
    Number.isFinite(entry.ms) ? entry.ms : null,
    entry.approved || '',
    detailOf(entry),
  ];
}

function matches(entry, keyword, failedOnly) {
  if (failedOnly && entry.ok !== false) return false;
  if (!keyword) return true;
  const hay = [
    entry.channel, entry.db, entry.approved, entry.error,
    connName(entry.connId), detailOf(entry),
  ].join(' ').toLowerCase();
  return hay.includes(keyword);
}

export async function openAuditTab() {
  const tab = addTab({ id: TAB_ID, title: t('操作审计'), icon: 'monitor', tooltip: t('本机操作审计日志') });
  if (tab.pane.childElementCount) { if (tab._reload) tab._reload(); return tab; }

  let all = [];
  let shown = [];

  const search = el('input', {
    type: 'text', class: 'audit-search', spellcheck: false,
    placeholder: t('搜索操作 / 连接 / 库 / SQL / 错误…'),
  });
  const failedOnly = el('input', { type: 'checkbox' });
  const countEl = el('span', { class: 'audit-count' });
  const pathEl = el('span', { class: 'audit-path' });

  const gridHost = el('div', { class: 'audit-grid' });
  const grid = new DataGrid(gridHost, {
    onSelect: () => {},
  });

  function apply() {
    const keyword = search.value.trim().toLowerCase();
    shown = all.filter((entry) => matches(entry, keyword, failedOnly.checked));
    grid.setData({ columns: COLUMNS, rows: shown.map(toRow), pk: [] });
    countEl.textContent = shown.length === all.length
      ? t('共 {n} 条', { n: fmtCount(all.length) })
      : t('{n} / {total} 条', { n: fmtCount(shown.length), total: fmtCount(all.length) });
  }

  async function reload() {
    try {
      const result = await window.api.audit.read({ limit: 20000 });
      all = Array.isArray(result.entries) ? result.entries : [];
      pathEl.textContent = result.file || '';
      pathEl.title = t('审计日志文件位置。审计日志不提供清空功能，需要清理请直接删除该文件。');
      if (result.unparsable) {
        console.warn(`[audit] 跳过 ${result.unparsable} 行无法解析的记录`);
      }
      apply();
      if (!all.length) toast.info(t('还没有审计记录。执行查询、修改数据等操作后会自动记录。'));
    } catch (error) {
      toast.error(t('读取审计日志失败：') + (error && error.message ? error.message : error));
    }
  }
  tab._reload = reload;

  async function exportJson() {
    if (!shown.length) { toast.info(t('当前没有可导出的记录')); return; }
    const file = await window.api.dlg.saveFile({
      title: t('导出审计日志'),
      defaultPath: `dbpanda-audit-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!file) return;
    try {
      await window.api.file.write(file, JSON.stringify(shown, null, 2));
      toast.success(t('已导出 {n} 条记录', { n: shown.length }));
    } catch (error) {
      toast.error(t('导出失败：') + (error && error.message ? error.message : error));
    }
  }

  search.addEventListener('input', debounce(apply, 150));
  failedOnly.addEventListener('change', apply);

  tab.pane.append(
    el('div', { class: 'pane-toolbar' },
      el('button', { class: 'pbtn', onClick: reload }, iconEl('refresh'), t('刷新')),
      el('span', { class: 'sep' }),
      search,
      el('label', { class: 'audit-failed' }, failedOnly, el('span', {}, t('只看失败'))),
      countEl,
      el('span', { class: 'spring' }),
      el('button', { class: 'pbtn', onClick: exportJson }, iconEl('exportIcon'), t('导出')),
    ),
    gridHost,
    el('div', { class: 'audit-foot' }, pathEl),
  );

  // 双击看完整详情（SQL 可能很长，网格里是截断的一行）
  gridHost.addEventListener('dblclick', () => {
    const focus = grid.focus;
    const entry = focus && shown[focus.dr];
    if (!entry) return;
    const text = [
      `时间: ${fmtTime(entry.at)}`,
      `操作: ${entry.channel || ''}`,
      `连接: ${connName(entry.connId)}`,
      `数据库: ${entry.db || ''}`,
      `结果: ${entry.ok === false ? '失败' : '成功'}${entry.error ? ` — ${entry.error}` : ''}`,
      entry.approved ? `生产审批: ${entry.approved}` : '',
      '',
      JSON.stringify(entry.args || {}, null, 2),
    ].filter(Boolean).join('\n');
    cellViewer(t('审计记录详情'), text, null);
  });

  await reload();
  return tab;
}
