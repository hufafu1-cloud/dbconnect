// 执行计划（EXPLAIN）可视化：树 / 表 / 文本三种形态
import { el, iconEl } from './util.js';
import { connLabel, connColor } from './state.js';
import { addTab, uid } from './tabs.js';
import { toast } from './toast.js';

function maxCost(node, m = { v: 0 }) {
  if (node.cost != null && node.cost > m.v) m.v = node.cost;
  (node.children || []).forEach((c) => maxCost(c, m));
  return m.v;
}

function heatColor(ratio) {
  // 0→绿, 0.5→黄, 1→红
  const r = Math.round(ratio < 0.5 ? 60 + ratio * 2 * 195 : 255);
  const g = Math.round(ratio < 0.5 ? 158 : 158 - (ratio - 0.5) * 2 * 120);
  return `rgb(${r}, ${g}, 70)`;
}

function renderTree(root) {
  const max = maxCost(root) || 1;
  const wrap = el('div', { class: 'plan-tree' });
  const build = (node, depth) => {
    const ratio = node.cost != null ? Math.min(1, node.cost / max) : 0;
    const metrics = [];
    if (node.rows != null) metrics.push(`行 ${Number(node.rows).toLocaleString()}`);
    if (node.cost != null) metrics.push(`代价 ${Number(node.cost).toFixed(2)}`);
    const bar = node.cost != null
      ? el('span', { class: 'plan-bar', title: '相对代价', style: { width: Math.max(4, ratio * 80) + 'px', background: heatColor(ratio) } })
      : null;
    const row = el('div', { class: 'plan-row' + (node.warn ? ' warn' : ''), style: { paddingLeft: (depth * 22 + 8) + 'px' } },
      node.warn ? el('span', { class: 'plan-warn', title: '全表扫描' }, '⚠') : null,
      el('span', { class: 'plan-title' }, node.title || '?'),
      node.detail ? el('span', { class: 'plan-detail' }, node.detail) : null,
      el('span', { class: 'plan-metrics' }, ...metrics.map((m) => el('span', { class: 'plan-chip' }, m)), bar));
    wrap.append(row);
    (node.children || []).forEach((c) => build(c, depth + 1));
  };
  build(root, 0);
  return wrap;
}

function renderTable(plan) {
  const t = el('table', { class: 'obj-table', style: { fontSize: '12.5px' } });
  t.append(el('thead', {}, el('tr', {}, ...plan.columns.map((c) => el('th', {}, c)))));
  const hi = plan.columns.indexOf(plan.highlightCol);
  const good = new Set(plan.goodValues || []);
  const bad = new Set(plan.badValues || []);
  const tb = el('tbody');
  for (const row of plan.rows) {
    const tr = el('tr', {}, ...row.map((v, i) => {
      const td = el('td', { style: { fontFamily: 'var(--mono)', whiteSpace: 'pre' } }, v === null || v === undefined ? '' : String(v));
      if (i === hi && v != null) {
        if (bad.has(String(v))) td.style.color = 'var(--danger)', td.style.fontWeight = '600';
        else if (good.has(String(v))) td.style.color = 'var(--green)';
      }
      return td;
    }));
    tb.append(tr);
  }
  t.append(tb);
  return el('div', { style: { overflow: 'auto', flex: '1' } }, t);
}

export function openExplainTab(target, sql) {
  const tab = addTab({ id: uid('explain'), title: '执行计划', icon: 'explain', color: connColor(target.connId), tooltip: `${connLabel(target.connId)} 执行计划` });
  const pane = tab.pane;
  pane.style.display = 'flex';
  pane.style.flexDirection = 'column';

  const sqlBox = el('div', { class: 'ddl-box', style: { margin: '8px 10px', maxHeight: '90px', overflow: 'auto', flex: '0 0 auto' } }, sql);
  const body = el('div', { class: 'plan-body', style: { flex: '1', minHeight: '0', overflow: 'auto' } }, '解析中…');
  pane.append(
    el('div', { class: 'pane-toolbar' },
      el('button', { class: 'pbtn', onClick: load }, iconEl('refresh'), '重新解释'),
      el('span', { class: 'spring' }),
      el('span', { class: 'obj-path' }, `${connLabel(target.connId)} › ${target.db || ''}`)),
    sqlBox, body);

  async function load() {
    body.innerHTML = '';
    body.append(el('div', { style: { padding: '12px', color: 'var(--text-muted)' } }, '解析中…'));
    try {
      const plan = await window.api.db.explain(target.connId, target.db, sql);
      body.innerHTML = '';
      if (plan.format === 'tree') body.append(renderTree(plan.root));
      else if (plan.format === 'table') body.append(renderTable(plan));
      else body.append(el('pre', { class: 'plan-text' }, plan.text || '(空)'));
    } catch (e) {
      body.innerHTML = '';
      body.append(el('div', { style: { padding: '14px', color: 'var(--danger)', whiteSpace: 'pre-wrap' } }, '无法获取执行计划:\n' + e.message));
    }
  }
  load();
  return tab;
}
