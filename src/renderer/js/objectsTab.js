// “对象”标签页：Navicat 式多类型对象列表（表/视图/函数/触发器/事件/序列/用户/查询）
// 工具栏大图标按钮通过 setObjectKind() 切换显示类型
import { el, iconEl, fmtCount } from './util.js';
import { state, on, emit, connLabel, objectsCacheKey } from './state.js';
import { addTab } from './tabs.js';
import * as actions from './actions.js';
import { showMenu } from './contextmenu.js';
import { toast, confirmDialog } from './toast.js';
import { authorizeOperation } from './danger.js';

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
let loadGeneration = 0;

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
  renderWorkspaceOverview();

  on('target-selected', (t) => {
    if (!t) {
      loadGeneration++;
      current = null;
      items = [];
      selected = null;
      renderWorkspaceOverview();
      if (pathEl) pathEl.textContent = '';
      return;
    }
    current = { connId: t.connId, db: t.db, schema: t.schema };
    load(false);
  });
  on('objects-changed', (t) => {
    if (current && t.connId === current.connId && t.db === current.db) load(true);
  });
  on('queries-changed', () => { if (currentKind === 'query') load(false); });
  on('conn-closed', (t) => {
    if (current && current.connId === t.connId) {
      loadGeneration++;
      current = null;
      items = [];
      selected = null;
      renderWorkspaceOverview();
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
  const context = it && it._context || current;
  if (!context) return null;
  return { connId: context.connId, db: context.db, schema: it.schema || context.schema, table: it.name };
}

function renderPlaceholder(text) {
  listEl.innerHTML = '';
  listEl.append(el('div', { class: 'obj-placeholder' }, text));
}

function renderWorkspaceOverview() {
  listEl.innerHTML = '';
  const opened = [...state.open.keys()];
  const target = state.activeTarget || (opened[0] ? { connId: opened[0] } : null);
  const metric = (value, label) => el('div', { class: 'overview-metric' }, el('b', {}, value), el('span', {}, label));
  const actionsEl = el('div', { class: 'overview-actions' });
  if (target) actionsEl.append(el('button', { class: 'btn primary', onClick: () => actions.newQuery(target) }, '新建查询'));
  actionsEl.append(el('button', { class: 'btn', onClick: () => document.querySelector('.tbtn-big')?.click() }, '新建连接'));
  listEl.append(el('div', { class: 'workspace-overview' },
    el('div', { class: 'overview-eyebrow' }, 'DBPANDA 工作区'),
    el('div', { class: 'overview-title' }, opened.length ? '从一个连接开始工作' : '建立你的第一个数据库连接'),
    el('div', { class: 'overview-copy' }, opened.length ? '在左侧选择数据库或对象，或者直接开始一段新查询。' : '连接后可浏览对象、执行查询、导入数据或进行跨库传输。'),
    el('div', { class: 'overview-metrics' }, metric(String(state.connections.length), '已保存连接'), metric(String(opened.length), '当前已打开')),
    actionsEl));
}

function renderObjectEmptyState(kind) {
  listEl.innerHTML = '';
  const title = kind === 'table' ? '这个数据库里还没有表' : `还没有${KINDS[kind].label}`;
  const hint = kind === 'table' ? '可以先新建一张表，或从文件导入数据开始。' : '切换对象类型，或创建一个新的对象开始。';
  const actionsEl = el('div', { class: 'obj-empty-actions' });
  if (kind === 'table' && current) {
    actionsEl.append(
      el('button', { class: 'btn primary', onClick: () => actions.newTable(current) }, '新建表'),
      el('button', { class: 'btn', onClick: () => actions.importTable(current) }, '导入数据'),
      el('button', { class: 'btn', onClick: () => actions.newQuery(current) }, '新建查询'),
    );
  } else if (current) {
    actionsEl.append(el('button', { class: 'btn primary', onClick: () => actions.newQuery(current) }, '新建查询'));
  }
  listEl.append(el('div', { class: 'obj-empty-state' },
    el('div', { class: 'obj-empty-title' }, title),
    el('div', { class: 'obj-empty-hint' }, hint), actionsEl));
}

// ---------------- 数据加载 ----------------
async function load(force) {
  const generation = ++loadGeneration;
  // Context/kind 一旦变化，旧选择必须同步失效；不能等新请求返回后再清，
  // 否则工具栏会把 A 库旧对象名和 B 库新 current 组合成危险目标。
  selected = null;
  items = [];
  if (listEl) renderPlaceholder('正在加载…');
  const kind = currentKind;
  const k = KINDS[kind];
  const context = current ? { ...current } : null;
  const cid = connIdNow();
  if (!cid) { renderWorkspaceOverview(); return; }
  const stillCurrent = () => generation === loadGeneration && currentKind === kind
    && JSON.stringify(current) === JSON.stringify(context);

  if (k.needDb) {
    if (!context || context.connId !== cid || !context.db) {
      renderWorkspaceOverview();
      return;
    }
  }
  if (k.capsKey) {
    const caps = await getCaps(cid);
    if (!stillCurrent()) return;
    if (!caps[k.capsKey]) {
      renderPlaceholder(`当前数据库类型不支持「${k.label}」`);
      pathEl.textContent = connLabel(cid);
      return;
    }
  }
  if (!stillCurrent()) return;
  pathEl.textContent = k.needDb
    ? `${connLabel(cid)} › ${context.db || ''}${context.schema ? ' › ' + context.schema : ''}`
    : connLabel(cid);

  try {
    const loaded = await fetchItems(kind, cid, context, force);
    if (!stillCurrent()) return;
    const itemContext = { connId: cid, db: context && context.db, schema: context && context.schema };
    items = loaded.map((item) => ({ ...item, _context: itemContext }));
    renderList();
  } catch (e) {
    if (!stillCurrent()) return;
    renderPlaceholder('加载失败: ' + e.message);
  }
}

async function fetchItems(kind, cid, context, force) {
  const db = context && context.db;
  const schema = context && context.schema;
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
  const context = it._context || current;
  const cid = context && context.connId;
  if (!cid) return;
  const { openDefTab } = await import('./defTab.js');
  const kindMap = {
    routine: it.type === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION',
    trigger: 'TRIGGER', event: 'EVENT', sequence: 'SEQUENCE', user: 'USER',
  };
  openDefTab({
    connId: cid,
    db: KINDS[it.kind].needDb ? context.db : null,
    schema: it.schema || context.schema,
    kind: kindMap[it.kind],
    name: it.name,
    extra: it.kind === 'user' ? it.host : it.extra,
  });
}

async function openSavedQuery(it) {
  const context = it._context || current;
  const cid = context && context.connId;
  if (!cid) return;
  const { openQueryTab } = await import('./queryTab.js');
  openQueryTab({ connId: cid, db: context.db }, it.sql, { saved: { id: it.id, name: it.name } });
}

async function deleteSavedQuery(it) {
  const ok = await confirmDialog('删除查询', `确定删除查询 “${it.name}” 吗？`, { danger: true, okLabel: '删除' });
  if (!ok) return;
  try {
    await window.api.queries.remove(it.id);
    emit('queries-changed', { connId: it._context && it._context.connId || connIdNow() });
    toast.success('查询已删除');
    load(false);
  } catch (e) { toast.error(e.message); }
}

async function deleteGeneric(it) {
  const context = it._context || current;
  const cid = context && context.connId;
  if (!cid) return;
  const k = it.kind;
  const label = KINDS[k].label;
  const actionMap = {
    routine: { action: 'dropRoutine', routineType: it.type, name: it.name },
    trigger: { action: 'dropTrigger', name: it.name, table: it.table },
    event: { action: 'dropEvent', name: it.name },
    sequence: { action: 'dropSequence', name: it.name },
    user: { action: 'dropUser', name: it.name, host: it.host },
  };
  try {
    const payload = {
      connId: cid,
      db: KINDS[k].needDb ? context.db : null,
      schema: it.schema || context.schema,
      ...actionMap[k],
    };
    const approved = await authorizeOperation('db.action', payload, {
      title: `删除${label}`,
      confirmSafe: () => confirmDialog(`删除${label}`, `确定删除${label} “${it.name}” 吗？该操作不可撤销！`, { danger: true, okLabel: '删除' }),
    });
    if (!approved) return;
    await window.api.db.action(cid, approved);
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
    if (items.length) renderPlaceholder('（无匹配项）');
    else renderObjectEmptyState(currentKind);
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
