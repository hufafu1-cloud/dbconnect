// “对象”标签页：Navicat 式多类型对象列表（表/视图/函数/触发器/事件/序列/用户/查询）
// 工具栏大图标按钮通过 setObjectKind() 切换显示类型
import { el, iconEl, fmtCount } from './util.js';
import { state, on, emit, connLabel, objectsCacheKey } from './state.js';
import { addTab } from './tabs.js';
import * as actions from './actions.js';
import { showMenu } from './contextmenu.js';
import { toast, confirmDialog } from './toast.js';

const KINDS = {
  table: { label: '表', icon: 'table', needDb: true, capsKey: null },
  view: { label: '视图', icon: 'view', needDb: true, capsKey: null },
  routine: { label: '函数', icon: 'func', needDb: true, capsKey: 'routines' },
  trigger: { label: '触发器', icon: 'trigger', needDb: true, capsKey: 'triggers' },
  event: { label: '事件', icon: 'eventIcon', needDb: true, capsKey: 'events' },
  sequence: { label: '序列', icon: 'sequence', needDb: true, capsKey: 'sequences' },
  user: { label: '用户', icon: 'user', needDb: false, capsKey: 'users' },
  query: { label: '查询', icon: 'query', needDb: false, capsKey: null },
};

let pane = null;
let toolbarEl = null;
let listEl = null;
let pathEl = null;
let searchEl = null;
let current = null;      // {connId, db, schema}
let currentKind = 'table';
let items = [];
let selected = null;

export function getObjectKind() { return currentKind; }

export async function setObjectKind(kind) {
  if (!KINDS[kind]) return;
  currentKind = kind;
  selected = null;
  emit('objkind-changed', kind);
  renderToolbar();
  await load(false);
}

async function getCaps(connId) {
  const oc = state.open.get(connId);
  if (!oc) return {};
  if (!oc.objectCaps) {
    try { oc.objectCaps = await window.api.db.objectCaps(connId); } catch (e) { oc.objectCaps = {}; }
  }
  return oc.objectCaps;
}

function connIdNow() {
  if (current && state.open.has(current.connId)) return current.connId;
  const t = state.activeTarget;
  if (t && state.open.has(t.connId)) return t.connId;
  return [...state.open.keys()][0] || null;
}

export function initObjectsTab() {
  const tab = addTab({ id: 'objects', title: '对象', icon: 'objects', permanent: true, onShow: () => {} });
  pane = tab.pane;
  pane.classList.add('objects-pane');

  toolbarEl = el('div', { class: 'pane-toolbar' });
  listEl = el('div', { class: 'obj-list' });
  pane.append(toolbarEl, listEl);

  renderToolbar();
  renderPlaceholder('在左侧打开连接并选择数据库');

  on('target-selected', (t) => {
    current = { connId: t.connId, db: t.db, schema: t.schema };
    load(false);
  });
  on('objects-changed', (t) => {
    if (current && t.connId === current.connId && t.db === current.db) load(true);
  });
  on('queries-changed', () => { if (currentKind === 'query') load(false); });
  on('conn-closed', (t) => {
    if (current && current.connId === t.connId) {
      current = null;
      items = [];
      selected = null;
      renderPlaceholder('在左侧打开连接并选择数据库');
      pathEl && (pathEl.textContent = '');
    }
  });
}

// ---------------- 工具栏（按类型自适应） ----------------
function renderToolbar() {
  toolbarEl.innerHTML = '';
  const k = currentKind;
  const mk = (icon, label, onClick, cls) =>
    el('button', { class: 'pbtn' + (cls ? ' ' + cls : ''), onClick }, iconEl(icon), label);

  const btns = [];
  if (k === 'table') {
    btns.push(
      mk('table', '打开表', () => selected && actions.openTable(targetOf(selected))),
      mk('struct', '设计表', () => selected && actions.designTable(targetOf(selected), false)),
      mk('plus', '新建表', () => current && actions.newTable(current)),
      mk('trash', '删除表', () => selected && actions.dropTable(targetOf(selected), false), 'danger'),
      el('span', { class: 'sep' }),
      mk('importIcon', '导入向导', () => current && actions.importTable({ ...current, table: selected ? selected.name : undefined })),
      mk('exportIcon', '导出向导', async () => {
        if (!selected) { toast.info('请先选中一个表'); return; }
        const { showTableExportMenu } = await import('./exportMenu.js');
        const r = toolbarEl.getBoundingClientRect();
        showTableExportMenu(r.left + 200, r.bottom + 4, targetOf(selected));
      }),
    );
  } else if (k === 'view') {
    btns.push(
      mk('view', '打开视图', () => selected && actions.openTable(targetOf(selected))),
      mk('struct', '查看定义', () => selected && actions.designTable(targetOf(selected), true)),
      mk('trash', '删除视图', () => selected && actions.dropTable(targetOf(selected), true), 'danger'),
    );
  } else if (k === 'query') {
    btns.push(
      mk('query', '打开查询', () => selected && openSavedQuery(selected)),
      mk('plus', '新建查询', () => actions.newQuery(current || state.activeTarget)),
      mk('trash', '删除查询', () => selected && deleteSavedQuery(selected), 'danger'),
    );
  } else if (k === 'user') {
    btns.push(
      mk('user', '查看权限', () => selected && openDef(selected)),
      mk('trash', '删除用户', () => selected && deleteGeneric(selected), 'danger'),
    );
  } else {
    btns.push(
      mk('struct', '查看定义', () => selected && openDef(selected)),
      mk('plus', `新建${KINDS[k].label}`, async () => {
        const cid = connIdNow();
        if (!cid) { toast.info('请先打开连接'); return; }
        const { objTemplate } = await import('./objTemplates.js');
        const conn = state.connections.find((c) => c.id === cid);
        const tplKind = k === 'routine' ? 'routine' : k;
        const tpl = objTemplate(conn ? conn.type : 'mysql', tplKind);
        actions.newQuery(current || { connId: cid }, tpl || `-- 暂无${KINDS[k].label}模板`);
      }),
      mk('trash', `删除${KINDS[k].label}`, () => selected && deleteGeneric(selected), 'danger'),
    );
  }
  btns.push(mk('refresh', '刷新', () => load(true)));

  pathEl = el('span', { class: 'obj-path' }, pathEl ? pathEl.textContent : '');
  searchEl = el('input', { type: 'text', placeholder: '筛选…', style: { width: '150px' }, onInput: renderList, value: searchEl ? searchEl.value : '' });
  toolbarEl.append(...btns, el('span', { class: 'spring' }), pathEl, searchEl);
}

function targetOf(it) {
  return { connId: current.connId, db: current.db, schema: it.schema || (current && current.schema), table: it.name };
}

function renderPlaceholder(text) {
  listEl.innerHTML = '';
  listEl.append(el('div', { class: 'obj-placeholder' }, text));
}

// ---------------- 数据加载 ----------------
async function load(force) {
  const k = KINDS[currentKind];
  const cid = connIdNow();
  if (!cid) { renderPlaceholder('请先打开一个连接'); return; }

  if (k.needDb) {
    if (!current || current.connId !== cid || !current.db) {
      renderPlaceholder(`在左侧选择数据库后查看${k.label}`);
      return;
    }
  }
  if (k.capsKey) {
    const caps = await getCaps(cid);
    if (!caps[k.capsKey]) {
      renderPlaceholder(`当前数据库类型不支持「${k.label}」`);
      pathEl.textContent = connLabel(cid);
      return;
    }
  }
  pathEl.textContent = k.needDb
    ? `${connLabel(cid)} › ${current.db || ''}${current.schema ? ' › ' + current.schema : ''}`
    : connLabel(cid);

  try {
    items = await fetchItems(currentKind, cid, force);
    selected = null;
    renderList();
  } catch (e) {
    renderPlaceholder('加载失败: ' + e.message);
  }
}

async function fetchItems(kind, cid, force) {
  const db = current && current.db;
  const schema = current && current.schema;
  if (kind === 'table' || kind === 'view') {
    const oc = state.open.get(cid);
    const key = objectsCacheKey(db, schema);
    let objs = !force && oc && oc.objectsCache.get(key);
    if (!objs) {
      objs = await window.api.db.objects(cid, db, schema);
      if (oc) oc.objectsCache.set(key, objs);
    }
    return kind === 'table'
      ? objs.tables.map((t) => ({ ...t, kind: 'table' }))
      : objs.views.map((v) => ({ ...v, kind: 'view' }));
  }
  if (kind === 'routine') return (await window.api.db.routines(cid, db, schema)).map((x) => ({ ...x, kind }));
  if (kind === 'trigger') return (await window.api.db.triggers(cid, db, schema)).map((x) => ({ ...x, kind }));
  if (kind === 'event') return (await window.api.db.events(cid, db)).map((x) => ({ ...x, kind }));
  if (kind === 'sequence') return (await window.api.db.sequences(cid, db, schema)).map((x) => ({ ...x, kind }));
  if (kind === 'user') return (await window.api.db.users(cid)).map((x) => ({ ...x, kind }));
  if (kind === 'query') return (await window.api.queries.list(cid)).map((x) => ({ ...x, kind }));
  return [];
}

// ---------------- 行为 ----------------
async function openDef(it) {
  const cid = connIdNow();
  const { openDefTab } = await import('./defTab.js');
  const kindMap = {
    routine: it.type === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION',
    trigger: 'TRIGGER', event: 'EVENT', sequence: 'SEQUENCE', user: 'USER',
  };
  openDefTab({
    connId: cid,
    db: KINDS[it.kind].needDb ? current.db : null,
    schema: it.schema || (current && current.schema),
    kind: kindMap[it.kind],
    name: it.name,
    extra: it.kind === 'user' ? it.host : it.extra,
  });
}

async function openSavedQuery(it) {
  const cid = connIdNow();
  const { openQueryTab } = await import('./queryTab.js');
  openQueryTab({ connId: cid, db: current && current.db }, it.sql, { saved: { id: it.id, name: it.name } });
}

async function deleteSavedQuery(it) {
  const ok = await confirmDialog('删除查询', `确定删除查询 “${it.name}” 吗？`, { danger: true, okLabel: '删除' });
  if (!ok) return;
  try {
    await window.api.queries.remove(it.id);
    emit('queries-changed', { connId: connIdNow() });
    toast.success('查询已删除');
    load(false);
  } catch (e) { toast.error(e.message); }
}

async function deleteGeneric(it) {
  const cid = connIdNow();
  const k = it.kind;
  const label = KINDS[k].label;
  const ok = await confirmDialog(`删除${label}`, `确定删除${label} “${it.name}” 吗？该操作不可撤销！`, { danger: true, okLabel: '删除' });
  if (!ok) return;
  const actionMap = {
    routine: { action: 'dropRoutine', routineType: it.type, name: it.name },
    trigger: { action: 'dropTrigger', name: it.name, table: it.table },
    event: { action: 'dropEvent', name: it.name },
    sequence: { action: 'dropSequence', name: it.name },
    user: { action: 'dropUser', name: it.name, host: it.host },
  };
  try {
    await window.api.db.action(cid, {
      db: KINDS[k].needDb ? current.db : null,
      schema: it.schema || (current && current.schema),
      ...actionMap[k],
    });
    toast.success(`${label} ${it.name} 已删除`);
    load(true);
  } catch (e) { toast.error(e.message); }
}

function dblClickOf(it) {
  if (it.kind === 'table' || it.kind === 'view') return () => actions.openTable(targetOf(it));
  if (it.kind === 'query') return () => openSavedQuery(it);
  return () => openDef(it);
}

// ---------------- 列表渲染 ----------------
const COLUMNS = {
  table: [['名称', '40%'], ['行数(约)', '14%', 'right'], ['注释 / 引擎', '']],
  view: [['名称', '50%'], ['模式', '']],
  routine: [['名称', '40%'], ['类型', '14%'], ['注释', '']],
  trigger: [['名称', '40%'], ['所属表', '24%'], ['时机 / 事件', '']],
  event: [['名称', '40%'], ['状态', '20%'], ['调度', '']],
  sequence: [['名称', '']],
  user: [['名称', '40%'], ['备注', '']],
  query: [['名称', '40%'], ['更新时间', '']],
};

function cellsOf(it) {
  switch (it.kind) {
    case 'table': return [null, fmtCount(it.rows), [it.comment, it.engine].filter(Boolean).join(' · ')];
    case 'view': return [null, it.schema || ''];
    case 'routine': return [null, it.type === 'PROCEDURE' ? '过程' : '函数', it.comment || ''];
    case 'trigger': return [null, it.table || '', [it.timing, it.event].filter(Boolean).join(' ')];
    case 'event': return [null, it.status || '', it.schedule || ''];
    case 'sequence': return [null];
    case 'user': return [null, it.note || ''];
    case 'query': return [null, it.updatedAt ? new Date(it.updatedAt).toLocaleString('zh-CN') : ''];
    default: return [null];
  }
}

function nameOf(it) {
  if (it.kind === 'user' && it.host) return `${it.name}@${it.host}`;
  if ((it.kind === 'table' || it.kind === 'view') && it.schema && it.schema !== 'public' && it.schema !== 'dbo') {
    return `${it.schema}.${it.name}`;
  }
  return it.name;
}

function renderList() {
  listEl.innerHTML = '';
  const k = KINDS[currentKind];
  const q = (searchEl.value || '').trim().toLowerCase();
  const shown = items.filter((it) => !q || it.name.toLowerCase().includes(q));
  if (!shown.length) {
    renderPlaceholder(items.length ? '（无匹配项）' : `（没有${k.label}）`);
    return;
  }
  const cols = COLUMNS[currentKind];
  const table = el('table', { class: 'obj-table' },
    el('thead', {}, el('tr', {}, ...cols.map(([name, w, align]) =>
      el('th', { style: { width: w || 'auto', textAlign: align || 'left' } }, name)))));
  const tbody = el('tbody');
  for (const it of shown) {
    const cells = cellsOf(it);
    const tr = el('tr', {},
      el('td', {}, el('span', { class: 'obj-name' }, iconEl(k.icon), nameOf(it))),
      ...cells.slice(1).map((c, i) =>
        el('td', { style: { color: 'var(--text-muted)', textAlign: (cols[i + 1] && cols[i + 1][2]) || 'left', fontFamily: cols[i + 1] && cols[i + 1][2] === 'right' ? 'var(--mono)' : '' } }, c === null ? '' : String(c))));
    tr.addEventListener('click', () => {
      for (const x of tbody.querySelectorAll('tr.selected')) x.classList.remove('selected');
      tr.classList.add('selected');
      selected = it;
    });
    tr.addEventListener('dblclick', dblClickOf(it));
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      tr.click();
      rowMenu(e, it);
    });
    tbody.append(tr);
  }
  table.append(tbody);
  listEl.append(table);
}

function rowMenu(e, it) {
  const mx = e.clientX, my = e.clientY;
  if (it.kind === 'table' || it.kind === 'view') {
    const t = targetOf(it);
    const isView = it.kind === 'view';
    showMenu(mx, my, [
      { label: isView ? '打开视图' : '打开表', icon: 'table', onClick: () => actions.openTable(t) },
      { label: isView ? '查看定义' : '设计表', icon: 'struct', onClick: () => actions.designTable(t, isView) },
      { sep: true },
      !isView && { label: '导入向导…', icon: 'importIcon', onClick: () => actions.importTable(t) },
      { label: '导出向导…', icon: 'exportIcon', onClick: async () => {
        const { showTableExportMenu } = await import('./exportMenu.js');
        showTableExportMenu(mx, my, t);
      } },
      { label: '复制名称', icon: 'copy', onClick: () => navigator.clipboard.writeText(t.table) },
      { sep: true },
      !isView && { label: '重命名…', icon: 'rename', onClick: () => actions.renameTable(t) },
      !isView && { label: '清空表', icon: 'cross', danger: true, onClick: () => actions.truncateTable(t) },
      { label: isView ? '删除视图' : '删除表', icon: 'trash', danger: true, onClick: () => actions.dropTable(t, isView) },
    ].filter(Boolean));
    return;
  }
  if (it.kind === 'query') {
    showMenu(mx, my, [
      { label: '打开查询', icon: 'query', onClick: () => openSavedQuery(it) },
      { label: '复制名称', icon: 'copy', onClick: () => navigator.clipboard.writeText(it.name) },
      { sep: true },
      { label: '删除查询', icon: 'trash', danger: true, onClick: () => deleteSavedQuery(it) },
    ]);
    return;
  }
  showMenu(mx, my, [
    { label: it.kind === 'user' ? '查看权限 / 定义' : '查看定义', icon: 'struct', onClick: () => openDef(it) },
    { label: '复制名称', icon: 'copy', onClick: () => navigator.clipboard.writeText(it.name) },
    { sep: true },
    { label: `删除${KINDS[it.kind].label}`, icon: 'trash', danger: true, onClick: () => deleteGeneric(it) },
  ]);
}
