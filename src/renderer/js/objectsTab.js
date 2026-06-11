// “对象”标签页：当前数据库的表/视图列表（常驻第一个标签）
import { el, iconEl, fmtCount } from './util.js';
import { state, on, connLabel, objectsCacheKey } from './state.js';
import { addTab } from './tabs.js';
import * as actions from './actions.js';
import { showMenu } from './contextmenu.js';

let pane = null;
let listEl = null;
let pathEl = null;
let searchEl = null;
let current = null;   // {connId, db, schema}
let items = [];       // [{name, schema, rows, comment, kind}]
let selected = null;
let btns = {};

export function initObjectsTab() {
  const tab = addTab({ id: 'objects', title: '对象', icon: 'objects', permanent: true, onShow: () => {} });
  pane = tab.pane;
  pane.classList.add('objects-pane');

  const mkBtn = (key, icon, label, onClick) => {
    btns[key] = el('button', { class: 'pbtn', onClick, disabled: true }, iconEl(icon), label);
    return btns[key];
  };
  const toolbar = el('div', { class: 'pane-toolbar' },
    mkBtn('open', 'table', '打开表', () => selected && actions.openTable(targetOf(selected))),
    mkBtn('design', 'struct', '设计表', () => selected && actions.designTable(targetOf(selected), selected.kind === 'view')),
    el('button', { class: 'pbtn', onClick: () => current && actions.newTable(current) }, iconEl('plus'), '新建表'),
    el('button', { class: 'pbtn', onClick: () => actions.newQuery(current || state.activeTarget) }, iconEl('query'), '新建查询'),
    el('span', { class: 'sep' }),
    el('button', { class: 'pbtn', onClick: () => current && actions.importTable({ ...current, table: selected && selected.kind !== 'view' ? selected.name : undefined }) }, iconEl('importIcon'), '导入'),
    mkBtn('export', 'exportIcon', '导出', async (e) => {
      if (!selected) return;
      const { showTableExportMenu } = await import('./exportMenu.js');
      const r = btns.export.getBoundingClientRect();
      showTableExportMenu(r.left, r.bottom + 4, targetOf(selected));
    }),
    mkBtn('drop', 'trash', '删除', () => selected && actions.dropTable(targetOf(selected), selected.kind === 'view')),
    el('button', { class: 'pbtn', onClick: refresh }, iconEl('refresh'), '刷新'),
    el('span', { class: 'spring' }),
    pathEl = el('span', { class: 'obj-path' }, ''),
    searchEl = el('input', { type: 'text', placeholder: '筛选…', style: { width: '150px' }, onInput: renderList }),
  );
  listEl = el('div', { class: 'obj-list' },
    el('div', { class: 'obj-placeholder' }, '在左侧打开连接并选择数据库，这里会显示其中的表'));
  pane.append(toolbar, listEl);

  on('target-selected', (t) => { current = { connId: t.connId, db: t.db, schema: t.schema }; load(); });
  on('objects-changed', (t) => {
    if (current && t.connId === current.connId && t.db === current.db) load(true);
  });
  on('conn-closed', (t) => {
    if (current && current.connId === t.connId) {
      current = null; items = []; selected = null;
      renderList();
      pathEl.textContent = '';
    }
  });
}

function targetOf(it) {
  return { connId: current.connId, db: current.db, schema: it.schema || current.schema, table: it.name };
}

async function load(force) {
  if (!current) return;
  const oc = state.open.get(current.connId);
  if (!oc) return;
  pathEl.textContent = `${connLabel(current.connId)} › ${current.db || ''}${current.schema ? ' › ' + current.schema : ''}`;
  try {
    const key = objectsCacheKey(current.db, current.schema);
    let objs;
    if (!force && oc.objectsCache.has(key)) {
      objs = oc.objectsCache.get(key);
    } else {
      objs = await window.api.db.objects(current.connId, current.db, current.schema);
      oc.objectsCache.set(key, objs);
    }
    items = [
      ...objs.tables.map((t) => ({ ...t, kind: 'table' })),
      ...objs.views.map((v) => ({ ...v, kind: 'view' })),
    ];
    selected = null;
    renderList();
  } catch (e) {
    listEl.innerHTML = '';
    listEl.append(el('div', { class: 'obj-placeholder' }, '加载失败: ' + e.message));
  }
}

async function refresh() {
  if (!current) return;
  const oc = state.open.get(current.connId);
  if (oc) oc.objectsCache.delete(objectsCacheKey(current.db, current.schema));
  await load(true);
}

function updateBtns() {
  const has = !!selected;
  btns.open.disabled = !has;
  btns.design.disabled = !has;
  btns.export.disabled = !has || selected.kind === 'view';
  btns.drop.disabled = !has;
}

function renderList() {
  listEl.innerHTML = '';
  const q = (searchEl.value || '').trim().toLowerCase();
  const shown = items.filter((it) => !q || it.name.toLowerCase().includes(q));
  if (!shown.length) {
    listEl.append(el('div', { class: 'obj-placeholder' }, current ? '（没有表）' : '在左侧打开连接并选择数据库，这里会显示其中的表'));
    updateBtns();
    return;
  }
  const table = el('table', { class: 'obj-table' },
    el('thead', {}, el('tr', {},
      el('th', { style: { width: '34%' } }, '名称'),
      el('th', { style: { width: '12%' } }, '类型'),
      el('th', { style: { width: '14%', textAlign: 'right' } }, '行数(约)'),
      el('th', {}, '注释 / 引擎'))));
  const tbody = el('tbody');
  for (const it of shown) {
    const tr = el('tr', {},
      el('td', {}, el('span', { class: 'obj-name' }, iconEl(it.kind === 'view' ? 'view' : 'table'),
        (it.schema && it.schema !== 'public' && it.schema !== 'dbo' ? it.schema + '.' : '') + it.name)),
      el('td', {}, it.kind === 'view' ? '视图' : '表'),
      el('td', { style: { textAlign: 'right', fontFamily: 'var(--mono)' } }, it.kind === 'view' ? '-' : fmtCount(it.rows)),
      el('td', { style: { color: 'var(--text-muted)' } }, [it.comment, it.engine].filter(Boolean).join(' · ')));
    tr.addEventListener('click', () => {
      for (const x of tbody.querySelectorAll('tr.selected')) x.classList.remove('selected');
      tr.classList.add('selected');
      selected = it;
      updateBtns();
    });
    tr.addEventListener('dblclick', () => actions.openTable(targetOf(it)));
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      tr.click();
      const t = targetOf(it);
      const isView = it.kind === 'view';
      const mx = e.clientX, my = e.clientY;
      showMenu(mx, my, [
        { label: isView ? '打开视图' : '打开表', icon: 'table', onClick: () => actions.openTable(t) },
        { label: isView ? '查看定义' : '设计表', icon: 'struct', onClick: () => actions.designTable(t, isView) },
        { sep: true },
        !isView && { label: '导入数据…', icon: 'importIcon', onClick: () => actions.importTable(t) },
        { label: '导出…', icon: 'exportIcon', onClick: async () => {
          const { showTableExportMenu } = await import('./exportMenu.js');
          showTableExportMenu(mx, my, t);
        } },
        !isView && { label: '重命名…', icon: 'rename', onClick: () => actions.renameTable(t) },
        !isView && { label: '清空表', icon: 'cross', danger: true, onClick: () => actions.truncateTable(t) },
        { label: isView ? '删除视图' : '删除表', icon: 'trash', danger: true, onClick: () => actions.dropTable(t, isView) },
      ].filter(Boolean));
    });
    tbody.append(tr);
  }
  table.append(tbody);
  listEl.append(table);
  updateBtns();
}
