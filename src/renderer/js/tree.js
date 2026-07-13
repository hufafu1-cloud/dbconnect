// 左侧连接树
import { $, el, iconEl } from './util.js';
import { state, emit, on, objectsCacheKey, setActiveTarget } from './state.js';
import { toast, promptDialog, confirmDialog, passwordDialog } from './toast.js';
import { showMenu } from './contextmenu.js';
import * as actions from './actions.js';
import { openConnDialog } from './connDialog.js';
import { statusbar } from './statusbar.js';
import { authorizeOperation } from './danger.js';

let treeRoot = null;
const connNodes = new Map(); // connId -> node element记录

function nodeRow({ depth, icon, label, meta, twisty, onToggle, onSelect, onDblClick, onMenu, cls }) {
  const tw = el('span', { class: 'tree-twisty' + (twisty ? '' : ' leaf') }, '▶');
  const row = el('div', { class: 'tree-row' + (cls ? ' ' + cls : ''), style: { paddingLeft: depth * 16 + 6 + 'px' } },
    tw, iconEl(icon, 'tree-icon'),
    el('span', { class: 'tree-label' }, label),
    meta ? el('span', { class: 'tree-meta' }, meta) : null);
  row.addEventListener('click', (e) => {
    selectRow(row);
    if (onSelect) onSelect(e);
  });
  if (onToggle) {
    tw.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); });
  }
  if (onDblClick) row.addEventListener('dblclick', onDblClick);
  if (onMenu) row.addEventListener('contextmenu', (e) => { e.preventDefault(); selectRow(row); onMenu(e); });
  return { row, tw };
}

function selectRow(row) {
  for (const r of treeRoot.querySelectorAll('.tree-row.selected')) r.classList.remove('selected');
  row.classList.add('selected');
}

// ---------------- 键盘导航（Navicat 式：上下移动、左右展折、Enter 打开、字母定位） ----------------
let typeBuf = '';
let typeTimer = null;

function visibleTreeRows() {
  return [...treeRoot.querySelectorAll('.tree-row')].filter((r) => r.offsetParent !== null);
}

function rowParts(row) {
  const node = row.parentElement; // .tree-node
  const tw = row.querySelector('.tree-twisty');
  const children = node && node.querySelector(':scope > .tree-children');
  return {
    tw,
    children,
    hasTwisty: tw && !tw.classList.contains('leaf'),
    isOpen: !!(children && children.classList.contains('open')),
  };
}

function focusTreeRow(row) {
  row.click(); // 复用行选中 + onSelect（同步激活目标）
  row.scrollIntoView({ block: 'nearest' });
}

function treeKeyDown(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const rows = visibleTreeRows();
  if (!rows.length) return;
  const cur = treeRoot.querySelector('.tree-row.selected');
  const idx = cur ? rows.indexOf(cur) : -1;
  const key = e.key;

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    e.preventDefault();
    const next = rows[Math.min(rows.length - 1, Math.max(0, idx + (key === 'ArrowDown' ? 1 : -1)))];
    if (next && next !== cur) focusTreeRow(next);
    else if (!cur && rows[0]) focusTreeRow(rows[0]);
  } else if (key === 'ArrowRight') {
    if (!cur) return;
    e.preventDefault();
    const p = rowParts(cur);
    if (p.hasTwisty && !p.isOpen) p.tw.click();
    else if (p.isOpen && idx + 1 < rows.length) focusTreeRow(rows[idx + 1]); // 已展开 → 进入第一个子节点
  } else if (key === 'ArrowLeft') {
    if (!cur) return;
    e.preventDefault();
    const p = rowParts(cur);
    if (p.hasTwisty && p.isOpen) p.tw.click();
    else {
      // 折叠态/叶子 → 回到父节点
      const parentChildren = cur.parentElement && cur.parentElement.closest('.tree-children');
      const parentRow = parentChildren && parentChildren.parentElement
        && parentChildren.parentElement.querySelector(':scope > .tree-row');
      if (parentRow) focusTreeRow(parentRow);
    }
  } else if (key === 'Enter') {
    if (!cur) return;
    e.preventDefault();
    cur.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  } else if (key.length === 1 && !/\s/.test(key)) {
    // typeahead：连续输入字母跳到匹配节点
    typeBuf += key.toLowerCase();
    if (typeTimer) clearTimeout(typeTimer);
    typeTimer = setTimeout(() => { typeBuf = ''; }, 800);
    const start = idx >= 0 ? idx : 0;
    const order = [...rows.slice(start + 1), ...rows.slice(0, start + 1)];
    const hit = order.find((r) => {
      const label = r.querySelector('.tree-label');
      return label && label.textContent.toLowerCase().startsWith(typeBuf);
    });
    if (hit) { e.preventDefault(); focusTreeRow(hit); }
  }
}

function makeBranch() {
  return el('div', { class: 'tree-children' });
}

function setOpen(twisty, childrenEl, open) {
  twisty.classList.toggle('open', open);
  childrenEl.classList.toggle('open', open);
}

// ---------------- 连接节点 ----------------
function renderConnNode(conn) {
  const isOpen = state.open.has(conn.id);
  const container = el('div', { class: 'tree-node ' + (isOpen ? 'conn-open' : 'conn-closed'), 'data-conn': conn.id });
  const children = makeBranch();
  let loaded = false;

  const typeIcons = { mysql: 'mysql', postgres: 'postgres', sqlite: 'sqlite', mssql: 'mssql', clickhouse: 'clickhouse', oceanbase: 'oceanbase', oboracle: 'oboracle' };
  const typeLabels = { mysql: 'MySQL', postgres: 'PostgreSQL', sqlite: 'SQLite', mssql: 'SQL Server', clickhouse: 'ClickHouse', oceanbase: 'OceanBase', oboracle: 'OB·Oracle' };
  const { row, tw } = nodeRow({
    depth: 0,
    icon: typeIcons[conn.type] || 'connection',
    label: conn.name,
    meta: typeLabels[conn.type] || conn.type,
    cls: conn.color ? 'conn-colored' : '',
    twisty: true,
    onToggle: () => toggle(),
    onSelect: () => { setActiveTarget({ connId: conn.id }, 'tree-connection'); },
    onDblClick: () => toggle(),
    onMenu: (e) => connMenu(e, conn, isOpenNow(), toggle),
  });

  if (conn.color) row.style.setProperty('--conn-color', conn.color);
  if (conn.env === 'prod' || conn.env === 'test') {
    container.classList.add('env-' + conn.env);
    const label = row.querySelector('.tree-label');
    const tag = el('span', { class: 'tree-env env-' + conn.env, title: conn.env === 'prod' ? '生产库：危险 SQL 需二次确认' : '测试库' }, conn.env === 'prod' ? '生产' : '测试');
    label.after(tag);
  }

  const isOpenNow = () => state.open.has(conn.id);

  async function toggle() {
    if (!isOpenNow()) {
      await openConnection(conn);
      return;
    }
    const opened = children.classList.contains('open');
    if (!opened && !loaded) await loadDatabases();
    setOpen(tw, children, !opened);
  }

  async function openConnection(c) {
    row.style.opacity = '0.6';
    statusbar.setLeft(`正在连接 ${c.name} …`);
    try {
      let r = await window.api.db.open(c.id);
      if (r && r.needsPassword) {
        const password = await passwordDialog(
          `输入数据库密码 — ${c.name}`,
          '该连接未将数据库密码保存到本地。密码仅用于本次连接，关闭后需重新输入。',
        );
        if (password === null) {
          statusbar.setLeft('已取消连接');
          return;
        }
        statusbar.setLeft(`正在连接 ${c.name} …`);
        r = await window.api.db.open(c.id, password);
      }
      state.open.set(c.id, { version: r.version, databases: [], objectsCache: new Map() });
      setActiveTarget({ connId: c.id }, 'connection-opened');
      c.hasSessionPassword = false;
      container.classList.remove('conn-closed');
      container.classList.add('conn-open');
      toast.success(`已连接：${c.name}\n${r.version}`);
      // OceanBase 连到 sys 管理租户时提示：业务表在业务租户里
      if ((c.type === 'oceanbase' || c.type === 'oboracle') && /@sys($|#)/i.test(c.user || '')) {
        toast.info('当前连接的是 OceanBase 的 sys 管理租户（只有系统库）。\n业务表在业务租户中，用户名请写成 用户@业务租户名，如 root@tenant1', 12000);
      }
      statusbar.setLeft(`${c.name} — ${r.version}`);
      await loadDatabases();
      setOpen(tw, children, true);
      emit('conn-opened', { connId: c.id });
    } catch (err) {
      toast.error(`连接失败：${err.message}`);
      statusbar.setLeft('连接失败');
    } finally {
      row.style.opacity = '';
    }
  }

  async function loadDatabases() {
    children.innerHTML = '';
    const loading = el('div', { class: 'tree-loading', style: { paddingLeft: '38px' } }, '加载中…');
    children.append(loading);
    try {
      const dbs = await window.api.db.databases(conn.id);
      const oc = state.open.get(conn.id);
      if (oc) oc.databases = dbs;
      loading.remove();
      for (const db of dbs) children.append(renderDbNode(conn, db));
      children.append(renderQueriesFolder(conn));
      const caps = await getObjectCaps(conn.id);
      if (caps.users) children.append(renderUsersFolder(conn));
      loaded = true;
    } catch (err) {
      loading.textContent = '加载失败: ' + err.message;
    }
  }

  async function closeConnection() {
    const result = await window.api.db.close(conn.id);
    if (result && result.cancelled) return;
    state.open.delete(conn.id);
    if (state.activeTarget && state.activeTarget.connId === conn.id) setActiveTarget(null, 'connection-closed');
    container.classList.add('conn-closed');
    container.classList.remove('conn-open');
    children.innerHTML = '';
    loaded = false;
    setOpen(tw, children, false);
    emit('conn-closed', { connId: conn.id });
    statusbar.setLeft('已断开 ' + conn.name);
  }

  function connMenu(e, c, opened) {
    showMenu(e.clientX, e.clientY, [
      opened
        ? { label: '关闭连接', icon: 'unlink', onClick: closeConnection }
        : { label: '打开连接', icon: 'link', onClick: () => openConnection(c) },
      { sep: true },
      { label: '新建查询', icon: 'query', disabled: !opened, onClick: () => actions.newQuery({ connId: c.id, db: c.type === 'sqlite' ? 'main' : (c.database || null) }) },
      (c.type !== 'sqlite' && c.type !== 'oboracle') && { label: '新建数据库…', icon: 'database', disabled: !opened, onClick: () => actions.createDatabase(c.id) },
      { sep: true },
      { label: '数据传输…', icon: 'transfer', disabled: !opened, onClick: async () => {
        const { openTransferDialog } = await import('./dbaTools.js');
        openTransferDialog({ connId: c.id });
      } },
      { label: '结构同步 / 数据同步…', icon: 'transfer', disabled: !opened, onClick: async () => {
        const { openSyncDialog } = await import('./syncDialog.js');
        openSyncDialog({ connId: c.id });
      } },
      { label: '运行 SQL 文件…', icon: 'openFile', disabled: !opened, onClick: async () => {
        const { openRunSqlFileDialog } = await import('./dbaTools.js');
        openRunSqlFileDialog({ connId: c.id, db: c.type === 'sqlite' ? 'main' : (c.database || null) });
      } },
      ['mysql', 'oceanbase', 'postgres', 'mssql', 'clickhouse'].includes(c.type) &&
        { label: '进程列表', icon: 'monitor', disabled: !opened, onClick: async () => {
          const { openProcTab } = await import('./procTab.js');
          openProcTab(c.id);
        } },
      { label: '刷新', icon: 'refresh', disabled: !opened, onClick: loadDatabases },
      { sep: true },
      { label: '编辑连接…', icon: 'edit', onClick: () => openConnDialog(c) },
      { label: '删除连接', icon: 'trash', danger: true, onClick: async () => {
        const { confirmDialog } = await import('./toast.js');
        const ok = await confirmDialog('删除连接', `确定删除连接 “${c.name}” 吗？`, { danger: true, okLabel: '删除' });
        if (!ok) return;
        await window.api.conn.remove(c.id);
        state.open.delete(c.id);
        emit('conn-closed', { connId: c.id });
        const { reloadConnections } = await import('./state.js');
        await reloadConnections();
        toast.success('连接已删除');
      } },
    ].filter(Boolean));
  }

  container.append(row, children);
  connNodes.set(conn.id, { container, reload: loadDatabases, open: () => openConnection(conn) });
  return container;
}

// ---------------- 数据库节点 ----------------
function renderDbNode(conn, db) {
  const container = el('div', { class: 'tree-node' });
  const children = makeBranch();
  let loaded = false;

  const { row, tw } = nodeRow({
    depth: 1,
    icon: 'database',
    label: db,
    cls: 'dim',
    twisty: true,
    onToggle: () => toggle(),
    onDblClick: () => toggle(),
    onSelect: () => {
      setActiveTarget({ connId: conn.id, db }, 'tree-database');
    },
    onMenu: (e) => {
      showMenu(e.clientX, e.clientY, [
        { label: '新建查询', icon: 'query', onClick: () => actions.newQuery({ connId: conn.id, db }) },
        { label: 'ER 关系图', icon: 'er', onClick: async () => {
          const { openErTab } = await import('./erTab.js');
          openErTab({ connId: conn.id, db, schema: null });
        } },
        { label: '刷新', icon: 'refresh', onClick: reload },
        { sep: true },
        { label: '转储 SQL 文件…', icon: 'save', onClick: async () => {
          const { openDumpDialog } = await import('./dbaTools.js');
          openDumpDialog({ connId: conn.id, db, schema: null });
        } },
        { label: '数据传输（以此为源）…', icon: 'transfer', onClick: async () => {
          const { openTransferDialog } = await import('./dbaTools.js');
          openTransferDialog({ connId: conn.id, db });
        } },
        { label: '同步到其它库…', icon: 'transfer', onClick: async () => {
          const { openSyncDialog } = await import('./syncDialog.js');
          openSyncDialog({ connId: conn.id, db });
        } },
        { label: '运行 SQL 文件…', icon: 'openFile', onClick: async () => {
          const { openRunSqlFileDialog } = await import('./dbaTools.js');
          openRunSqlFileDialog({ connId: conn.id, db });
        } },
        { sep: true },
        (conn.type !== 'sqlite' && conn.type !== 'oboracle') &&
          { label: '删除数据库', icon: 'trash', danger: true, onClick: () => actions.dropDatabase({ connId: conn.id, db }) },
      ].filter(Boolean));
    },
  });

  async function toggle() {
    const opened = children.classList.contains('open');
    if (!opened && !loaded) await load();
    setOpen(tw, children, !opened);
  }

  async function load() {
    children.innerHTML = '';
    const loading = el('div', { class: 'tree-loading', style: { paddingLeft: '54px' } }, '加载中…');
    children.append(loading);
    try {
      if (conn.type === 'postgres') {
        const schemas = await window.api.db.schemas(conn.id, db);
        loading.remove();
        for (const sch of schemas) children.append(renderSchemaNode(conn, db, sch));
      } else {
        const objs = await fetchObjects(conn.id, db, null);
        const caps = await getObjectCaps(conn.id);
        loading.remove();
        children.append(renderFolders(conn, db, null, objs, 2, caps));
      }
      loaded = true;
      row.classList.remove('dim'); // 已打开的库点亮
    } catch (err) {
      loading.textContent = '加载失败: ' + err.message;
    }
  }

  async function reload() {
    const oc = state.open.get(conn.id);
    if (oc) oc.objectsCache.clear();
    loaded = false;
    children.innerHTML = '';
    await load();
    setOpen(tw, children, true);
  }

  container.append(row, children);
  container.dataset.reloadKey = `${conn.id}|${db}`;
  container.dataset.connId = conn.id;
  container.dataset.db = db;
  container._reload = reload;
  container._openBranch = async () => {
    if (!loaded) await load();
    setOpen(tw, children, true);
  };
  return container;
}

// ---------------- 模式节点（PostgreSQL） ----------------
function renderSchemaNode(conn, db, schema) {
  const container = el('div', { class: 'tree-node' });
  const children = makeBranch();
  let loaded = false;

  const { row, tw } = nodeRow({
    depth: 2,
    icon: 'schema',
    label: schema,
    cls: 'dim',
    twisty: true,
    onToggle: () => toggle(),
    onDblClick: () => toggle(),
    onSelect: () => {
      setActiveTarget({ connId: conn.id, db, schema }, 'tree-schema');
    },
    onMenu: (e) => {
      showMenu(e.clientX, e.clientY, [
        { label: '新建查询', icon: 'query', onClick: () => actions.newQuery({ connId: conn.id, db, schema }) },
        { label: 'ER 关系图', icon: 'er', onClick: async () => {
          const { openErTab } = await import('./erTab.js');
          openErTab({ connId: conn.id, db, schema });
        } },
        { label: '转储 SQL 文件…', icon: 'save', onClick: async () => {
          const { openDumpDialog } = await import('./dbaTools.js');
          openDumpDialog({ connId: conn.id, db, schema });
        } },
        { label: '刷新', icon: 'refresh', onClick: reload },
      ]);
    },
  });

  async function toggle() {
    const opened = children.classList.contains('open');
    if (!opened && !loaded) await load();
    setOpen(tw, children, !opened);
  }
  async function load() {
    children.innerHTML = '';
    const loading = el('div', { class: 'tree-loading', style: { paddingLeft: '70px' } }, '加载中…');
    children.append(loading);
    try {
      const objs = await fetchObjects(conn.id, db, schema);
      const caps = await getObjectCaps(conn.id);
      loading.remove();
      children.append(renderFolders(conn, db, schema, objs, 3, caps));
      loaded = true;
      row.classList.remove('dim'); // 已打开的模式点亮
    } catch (err) {
      loading.textContent = '加载失败: ' + err.message;
    }
  }
  async function reload() {
    const oc = state.open.get(conn.id);
    if (oc) oc.objectsCache.delete(objectsCacheKey(db, schema));
    loaded = false;
    children.innerHTML = '';
    await load();
    setOpen(tw, children, true);
  }

  container.append(row, children);
  container.dataset.reloadKey = `${conn.id}|${db}|${schema}`;
  container.dataset.connId = conn.id;
  container.dataset.db = db;
  container.dataset.schema = schema;
  container._reload = reload;
  container._openBranch = async () => {
    if (!loaded) await load();
    setOpen(tw, children, true);
  };
  return container;
}

// ---------------- 保存的查询 ----------------
function renderQueriesFolder(conn) {
  const container = el('div', { class: 'tree-node' });
  const children = makeBranch();
  let loaded = false;

  const { row, tw } = nodeRow({
    depth: 1,
    icon: 'query',
    label: '查询',
    twisty: true,
    onToggle: () => toggle(),
    onDblClick: () => toggle(),
    onMenu: (e) => {
      showMenu(e.clientX, e.clientY, [
        { label: '新建查询', icon: 'plus', onClick: () => actions.newQuery(defaultTarget()) },
        { label: '刷新', icon: 'refresh', onClick: reload },
      ]);
    },
  });

  function defaultTarget() {
    const oc = state.open.get(conn.id);
    return { connId: conn.id, db: (oc && oc.databases && oc.databases[0]) || null };
  }

  async function toggle() {
    const opened = children.classList.contains('open');
    if (!opened && !loaded) await load();
    setOpen(tw, children, !opened);
  }

  async function load() {
    children.innerHTML = '';
    try {
      const qs = await window.api.queries.list(conn.id);
      for (const q of qs) children.append(renderQueryLeaf(conn, q, defaultTarget));
      if (!qs.length) {
        children.append(el('div', { class: 'tree-loading', style: { paddingLeft: '54px' } }, '（无保存的查询）'));
      }
      loaded = true;
    } catch (err) {
      children.append(el('div', { class: 'tree-loading', style: { paddingLeft: '54px' } }, '加载失败: ' + err.message));
    }
  }

  async function reload() {
    loaded = false;
    children.innerHTML = '';
    await load();
    setOpen(tw, children, true);
  }

  container.append(row, children);
  container.dataset.reloadKey = `queries|${conn.id}`;
  container._reload = reload;
  return container;
}

function renderQueryLeaf(conn, q, defaultTarget) {
  const openIt = () => actions.openSavedQuery(defaultTarget(), q.sql, { id: q.id, name: q.name });
  const { row } = nodeRow({
    depth: 2,
    icon: 'query',
    label: q.name,
    twisty: false,
    onDblClick: openIt,
    onMenu: (e) => {
      showMenu(e.clientX, e.clientY, [
        { label: '打开', icon: 'query', onClick: openIt },
        { label: '重命名…', icon: 'rename', onClick: async () => {
          const name = await promptDialog('重命名查询', '查询名:', q.name);
          if (!name || name === q.name) return;
          try {
            await window.api.queries.rename(q.id, name);
            emit('queries-changed', { connId: conn.id });
          } catch (err) { toast.error(err.message); }
        } },
        { sep: true },
        { label: '删除', icon: 'trash', danger: true, onClick: async () => {
          const ok = await confirmDialog('删除查询', `确定删除查询 “${q.name}” 吗？`, { danger: true, okLabel: '删除' });
          if (!ok) return;
          await window.api.queries.remove(q.id);
          emit('queries-changed', { connId: conn.id });
          toast.success('已删除');
        } },
      ]);
    },
  });
  row.dataset.leaf = q.name.toLowerCase();
  return el('div', { class: 'tree-node', 'data-leaf-node': '1' }, row);
}

// ---------------- 用户（连接级） ----------------
function renderUsersFolder(conn) {
  const container = el('div', { class: 'tree-node' });
  const children = makeBranch();
  let loaded = false;

  const { row, tw } = nodeRow({
    depth: 1,
    icon: 'user',
    label: '用户',
    twisty: true,
    onToggle: () => toggle(),
    onDblClick: () => toggle(),
    onMenu: (e) => {
      showMenu(e.clientX, e.clientY, [
        { label: '刷新', icon: 'refresh', onClick: reload },
      ]);
    },
  });

  async function toggle() {
    const opened = children.classList.contains('open');
    if (!opened && !loaded) await load();
    setOpen(tw, children, !opened);
  }

  async function load() {
    children.innerHTML = '';
    const loading = el('div', { class: 'tree-loading', style: { paddingLeft: '54px' } }, '加载中…');
    children.append(loading);
    try {
      const users = await window.api.db.users(conn.id);
      loading.remove();
      for (const u of users) {
        const label = u.host ? `${u.name}@${u.host}` : u.name;
        const openDef = async () => {
          const { openDefTab } = await import('./defTab.js');
          openDefTab({ connId: conn.id, db: null, kind: 'USER', name: u.name, extra: u.host });
        };
        const { row: r } = nodeRow({
          depth: 2,
          icon: 'user',
          label,
          meta: u.note || '',
          twisty: false,
          onDblClick: openDef,
          onMenu: (e) => {
            showMenu(e.clientX, e.clientY, [
              { label: '查看权限 / 定义', icon: 'struct', onClick: openDef },
              { label: '复制名称', icon: 'copy', onClick: () => navigator.clipboard.writeText(label) },
              { sep: true },
              { label: '删除用户', icon: 'trash', danger: true, onClick: async () => {
                try {
                  const payload = { connId: conn.id, action: 'dropUser', name: u.name, host: u.host };
                  const approved = await authorizeOperation('db.action', payload, {
                    title: '删除用户',
                    confirmSafe: () => confirmDialog('删除用户', `确定删除用户 “${label}” 吗？该操作不可撤销！`, { danger: true, okLabel: '删除' }),
                  });
                  if (!approved) return;
                  await window.api.db.action(conn.id, approved);
                  toast.success(`用户 ${label} 已删除`);
                  reload();
                } catch (err) { toast.error(err.message); }
              } },
            ]);
          },
        });
        r.dataset.leaf = label.toLowerCase();
        children.append(el('div', { class: 'tree-node', 'data-leaf-node': '1' }, r));
      }
      if (!users.length) {
        children.append(el('div', { class: 'tree-loading', style: { paddingLeft: '54px' } }, '（无权限查看或无用户）'));
      }
      const old = row.querySelector('.tree-meta');
      if (old) old.remove();
      row.append(el('span', { class: 'tree-meta' }, String(users.length)));
      loaded = true;
    } catch (err) {
      loading.textContent = '加载失败: ' + err.message;
    }
  }

  async function reload() {
    loaded = false;
    children.innerHTML = '';
    await load();
    setOpen(tw, children, true);
  }

  container.append(row, children);
  return container;
}

// ---------------- 表/视图 文件夹与叶子 ----------------
async function fetchObjects(connId, db, schema, force) {
  const oc = state.open.get(connId);
  const key = objectsCacheKey(db, schema);
  if (!force && oc && oc.objectsCache.has(key)) return oc.objectsCache.get(key);
  const objs = await window.api.db.objects(connId, db, schema);
  if (oc) oc.objectsCache.set(key, objs);
  return objs;
}

async function getObjectCaps(connId) {
  const oc = state.open.get(connId);
  if (!oc) return {};
  if (!oc.objectCaps) {
    try { oc.objectCaps = await window.api.db.objectCaps(connId); } catch (e) { oc.objectCaps = {}; }
  }
  return oc.objectCaps;
}

function renderFolders(conn, db, schema, objs, depth, caps) {
  const frag = document.createDocumentFragment();
  frag.append(renderFolder(conn, db, schema, '表', 'folder', objs.tables, depth, false));
  frag.append(renderFolder(conn, db, schema, '视图', 'folder', objs.views, depth, true));
  caps = caps || {};
  if (caps.routines) frag.append(renderObjFolder(conn, db, schema, depth, OBJ_KINDS.routine));
  if (caps.triggers) frag.append(renderObjFolder(conn, db, schema, depth, OBJ_KINDS.trigger));
  if (caps.events && !schema) frag.append(renderObjFolder(conn, db, schema, depth, OBJ_KINDS.event));
  if (caps.sequences) frag.append(renderObjFolder(conn, db, schema, depth, OBJ_KINDS.sequence));
  return frag;
}

// ---------------- 扩展对象文件夹（函数/触发器/事件/序列） ----------------
const OBJ_KINDS = {
  routine: {
    key: 'routine', title: '函数', icon: 'func', tplKind: 'routine',
    load: (c, db, sch) => window.api.db.routines(c, db, sch),
    leafKind: (it) => it.type === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION',
    meta: (it) => it.type === 'PROCEDURE' ? '过程' : '函数',
    dropAction: (it) => ({ action: 'dropRoutine', routineType: it.type, name: it.name }),
  },
  trigger: {
    key: 'trigger', title: '触发器', icon: 'trigger', tplKind: 'trigger',
    load: (c, db, sch) => window.api.db.triggers(c, db, sch),
    leafKind: () => 'TRIGGER',
    meta: (it) => it.table || '',
    dropAction: (it) => ({ action: 'dropTrigger', name: it.name, table: it.table }),
  },
  event: {
    key: 'event', title: '事件', icon: 'eventIcon', tplKind: 'event',
    load: (c, db) => window.api.db.events(c, db),
    leafKind: () => 'EVENT',
    meta: (it) => it.schedule || it.status || '',
    dropAction: (it) => ({ action: 'dropEvent', name: it.name }),
  },
  sequence: {
    key: 'sequence', title: '序列', icon: 'sequence', tplKind: 'sequence',
    load: (c, db, sch) => window.api.db.sequences(c, db, sch),
    leafKind: () => 'SEQUENCE',
    meta: () => '',
    dropAction: (it) => ({ action: 'dropSequence', name: it.name }),
  },
};

function renderObjFolder(conn, db, schema, depth, kindDef) {
  const container = el('div', { class: 'tree-node' });
  const children = makeBranch();
  let loaded = false;
  const metaEl = { current: null };

  const { row, tw } = nodeRow({
    depth,
    icon: kindDef.icon,
    label: kindDef.title,
    twisty: true,
    onToggle: () => toggle(),
    onDblClick: () => toggle(),
    onMenu: (e) => {
      showMenu(e.clientX, e.clientY, [
        kindDef.tplKind && { label: `新建${kindDef.title}（模板）`, icon: 'plus', onClick: async () => {
          const { objTemplate } = await import('./objTemplates.js');
          const tpl = objTemplate(conn.type, kindDef.tplKind);
          actions.newQuery({ connId: conn.id, db, schema }, tpl || `-- 该数据库暂无${kindDef.title}模板`);
        } },
        { label: '刷新', icon: 'refresh', onClick: reload },
      ].filter(Boolean));
    },
  });

  async function toggle() {
    const opened = children.classList.contains('open');
    if (!opened && !loaded) await load();
    setOpen(tw, children, !opened);
  }

  async function load() {
    children.innerHTML = '';
    const loading = el('div', { class: 'tree-loading', style: { paddingLeft: depth * 16 + 38 + 'px' } }, '加载中…');
    children.append(loading);
    try {
      const items = await kindDef.load(conn.id, db, schema);
      loading.remove();
      for (const it of items) children.append(renderObjLeaf(conn, db, schema, depth + 1, kindDef, it, reload));
      if (!items.length) {
        children.append(el('div', { class: 'tree-loading', style: { paddingLeft: depth * 16 + 38 + 'px' } }, `（无${kindDef.title}）`));
      }
      // 更新数量
      const old = row.querySelector('.tree-meta');
      if (old) old.remove();
      row.append(el('span', { class: 'tree-meta' }, String(items.length)));
      loaded = true;
    } catch (err) {
      loading.textContent = '加载失败: ' + err.message;
    }
  }

  async function reload() {
    loaded = false;
    children.innerHTML = '';
    await load();
    setOpen(tw, children, true);
  }

  container.append(row, children);
  return container;
}

function renderObjLeaf(conn, db, schema, depth, kindDef, it, reloadFolder) {
  const kind = kindDef.leafKind(it);
  const openDef = async () => {
    const { openDefTab } = await import('./defTab.js');
    openDefTab({ connId: conn.id, db, schema: it.schema || schema, kind, name: it.name, extra: it.extra });
  };
  const { row } = nodeRow({
    depth,
    icon: kindDef.icon,
    label: it.name,
    meta: kindDef.meta(it),
    twisty: false,
    onDblClick: openDef,
    onMenu: (e) => {
      showMenu(e.clientX, e.clientY, [
        { label: '查看定义', icon: 'struct', onClick: openDef },
        { label: '复制名称', icon: 'copy', onClick: () => navigator.clipboard.writeText(it.name) },
        { sep: true },
        { label: `删除${kindDef.title}`, icon: 'trash', danger: true, onClick: async () => {
          try {
            const payload = { connId: conn.id, db, schema: it.schema || schema, ...kindDef.dropAction(it) };
            const approved = await authorizeOperation('db.action', payload, {
              title: `删除${kindDef.title}`,
              confirmSafe: () => confirmDialog(`删除${kindDef.title}`, `确定删除 “${it.name}” 吗？该操作不可撤销！`, { danger: true, okLabel: '删除' }),
            });
            if (!approved) return;
            await window.api.db.action(conn.id, approved);
            toast.success(`${kindDef.title} ${it.name} 已删除`);
            reloadFolder();
          } catch (err) { toast.error(err.message); }
        } },
      ]);
    },
  });
  row.dataset.leaf = it.name.toLowerCase();
  return el('div', { class: 'tree-node', 'data-leaf-node': '1' }, row);
}

function renderFolder(conn, db, schema, title, icon, items, depth, isView) {
  const container = el('div', { class: 'tree-node' });
  const children = makeBranch();
  const { row, tw } = nodeRow({
    depth,
    icon,
    label: title,
    meta: String(items.length),
    twisty: true,
    onToggle: () => toggleNow(),
    onDblClick: () => toggleNow(),
    onSelect: () => {
      setActiveTarget({ connId: conn.id, db, schema }, 'tree-object-group');
    },
    onMenu: (e) => {
      showMenu(e.clientX, e.clientY, [
        !isView && { label: '新建表…', icon: 'plus', onClick: () => actions.newTable({ connId: conn.id, db, schema }) },
        !isView && { label: '导入数据…', icon: 'importIcon', onClick: () => actions.importTable({ connId: conn.id, db, schema }) },
        { label: '刷新', icon: 'refresh', onClick: () => emit('objects-changed', { connId: conn.id, db, schema }) },
      ].filter(Boolean));
    },
  });
  function toggleNow() {
    const opened = children.classList.contains('open');
    setOpen(tw, children, !opened);
  }
  for (const it of items) {
    children.append(renderLeaf(conn, db, schema || it.schema, it, depth + 1, isView));
  }
  // 表夹默认展开
  if (!isView) setOpen(tw, children, true);
  container.append(row, children);
  return container;
}

function renderLeaf(conn, db, schema, item, depth, isView) {
  const target = { connId: conn.id, db, schema: item.schema || schema, table: item.name };
  const label = (conn.type === 'mssql' && item.schema && item.schema !== 'dbo')
    ? `${item.schema}.${item.name}` : item.name;
  const { row } = nodeRow({
    depth,
    icon: isView ? 'view' : 'table',
    label,
    meta: item.rows !== null && item.rows !== undefined ? String(item.rows) : '-',
    twisty: false,
    onSelect: () => {
      setActiveTarget({ connId: conn.id, db, schema: target.schema, table: target.table }, 'tree-object');
    },
    onDblClick: () => actions.openTable(target),
    onMenu: (e) => leafMenu(e, target, isView),
  });
  row.dataset.leaf = label.toLowerCase();
  return el('div', {
    class: 'tree-node',
    'data-leaf-node': '1',
    'data-conn-id': conn.id,
    'data-db': db,
    'data-schema': target.schema || '',
    'data-table': target.table,
  }, row);
}

function leafMenu(e, target, isView) {
  const x = e.clientX, y = e.clientY;
  showMenu(x, y, [
    { label: isView ? '打开视图' : '打开表', icon: 'table', onClick: () => actions.openTable(target) },
    { label: isView ? '查看定义' : '设计表', icon: 'struct', onClick: () => actions.designTable(target, isView) },
    { label: '新建查询', icon: 'query', onClick: () => actions.newQuery(target, `SELECT * FROM ${target.table};`) },
    { sep: true },
    !isView && { label: '导入数据…', icon: 'importIcon', onClick: () => actions.importTable(target) },
    { label: '导出…', icon: 'exportIcon', onClick: async () => {
      const { showTableExportMenu } = await import('./exportMenu.js');
      showTableExportMenu(x, y, target);
    } },
    { label: '复制名称', icon: 'copy', onClick: () => navigator.clipboard.writeText(target.table) },
    { sep: true },
    !isView && { label: '重命名…', icon: 'rename', onClick: () => actions.renameTable(target) },
    !isView && { label: '清空表', icon: 'cross', danger: true, onClick: () => actions.truncateTable(target) },
    { label: isView ? '删除视图' : '删除表', icon: 'trash', danger: true, onClick: () => actions.dropTable(target, isView) },
  ].filter(Boolean));
}

// ---------------- 分组节点 ----------------
function renderGroupNode(gname, conns) {
  const container = el('div', { class: 'tree-node' });
  const children = el('div', { class: 'tree-children open', style: { paddingLeft: '14px' } });
  const { row, tw } = nodeRow({
    depth: 0,
    icon: 'folder',
    label: gname,
    meta: String(conns.length),
    twisty: true,
    cls: 'tree-group',
    onToggle: () => setOpen(tw, children, !children.classList.contains('open')),
    onDblClick: () => setOpen(tw, children, !children.classList.contains('open')),
    onMenu: (e) => {
      showMenu(e.clientX, e.clientY, [
        { label: '在此分组新建连接…', icon: 'plus', onClick: () => openConnDialog(null, null, gname) },
        { sep: true },
        { label: '重命名分组…', icon: 'rename', onClick: async () => {
          const { promptDialog } = await import('./toast.js');
          const name = await promptDialog('重命名分组', '分组名:', gname);
          if (!name || name === gname) return;
          try {
            await window.api.groups.rename(gname, name);
            const { reloadConnections } = await import('./state.js');
            await reloadConnections();
          } catch (err) { toast.error(err.message); }
        } },
        { label: '删除分组', icon: 'trash', danger: true, onClick: async () => {
          const ok = await confirmDialog('删除分组',
            conns.length
              ? `分组 “${gname}” 中有 ${conns.length} 个连接，删除后它们将移到未分组（连接本身不会删除）。继续吗？`
              : `确定删除空分组 “${gname}” 吗？`,
            { danger: true, okLabel: '删除' });
          if (!ok) return;
          try {
            await window.api.groups.remove(gname);
            const { reloadConnections } = await import('./state.js');
            await reloadConnections();
            toast.success(`分组 ${gname} 已删除`);
          } catch (err) { toast.error(err.message); }
        } },
      ]);
    },
  });
  tw.classList.add('open');
  for (const conn of conns) children.append(renderConnNode(conn));
  if (!conns.length) {
    children.append(el('div', { class: 'tree-loading', style: { paddingLeft: '24px' } }, '（空分组，右键新建连接）'));
  }
  container.append(row, children);
  return container;
}

// ---------------- 入口与刷新 ----------------
export function renderTree() {
  treeRoot = $('#tree');
  if (!treeRoot.hasAttribute('tabindex')) {
    treeRoot.setAttribute('tabindex', '0');
    treeRoot.addEventListener('keydown', treeKeyDown);
  }
  treeRoot.innerHTML = '';
  connNodes.clear();
  if (!state.connections.length) {
    treeRoot.append(el('div', { style: { padding: '24px 16px', color: 'var(--text-muted)', fontSize: '12.5px', lineHeight: '1.8' } },
      '还没有连接。', el('br'), '点击工具栏“新建连接”开始。'));
  }
  // 按分组渲染：声明的分组（含空组）+ 连接上使用的分组，未分组连接在根
  const groups = new Map();
  for (const g of state.groups || []) {
    if (g && g.trim()) groups.set(g.trim(), []);
  }
  const ungrouped = [];
  for (const conn of state.connections) {
    if (conn.group && conn.group.trim()) {
      const g = conn.group.trim();
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(conn);
    } else {
      ungrouped.push(conn);
    }
  }
  for (const [gname, conns] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    treeRoot.append(renderGroupNode(gname, conns));
  }
  for (const conn of ungrouped) {
    treeRoot.append(renderConnNode(conn));
  }
  // 空白处右键
  treeRoot.oncontextmenu = (e) => {
    if (e.target !== treeRoot) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: '新建连接…', icon: 'plus', onClick: () => openConnDialog() },
      { label: '新建组…', icon: 'folder', onClick: async () => {
        const { promptDialog } = await import('./toast.js');
        const name = await promptDialog('新建组', '分组名:');
        if (!name) return;
        try {
          await window.api.groups.add(name);
          const { reloadConnections } = await import('./state.js');
          await reloadConnections();
          toast.success(`分组 ${name} 已创建`);
        } catch (err) { toast.error(err.message); }
      } },
    ]);
  };
}

export async function reloadDbBranch(connId, db, schema) {
  // 找到对应数据库/模式节点刷新
  const key1 = schema ? `${connId}|${db}|${schema}` : null;
  const key2 = `${connId}|${db}`;
  const nodes = treeRoot.querySelectorAll('.tree-node');
  for (const n of nodes) {
    if (key1 && n.dataset.reloadKey === key1 && n._reload) { await n._reload(); return; }
  }
  for (const n of nodes) {
    if (n.dataset.reloadKey === key2 && n._reload) { await n._reload(); return; }
  }
}

export function openConnectionById(connId) {
  const rec = connNodes.get(connId);
  if (rec) return rec.open();
  throw new Error('连接不存在: ' + connId);
}

/** 展开并选中工作区中保存的连接 / 数据库 / 模式 / 表上下文。 */
export async function revealTarget(target) {
  if (!target || !target.connId || !state.open.has(target.connId)) return false;
  const nodes = [...treeRoot.querySelectorAll('.tree-node')];
  let selectedNode = nodes.find((n) => n.dataset.conn === target.connId) || null;
  if (target.db) {
    const dbNode = nodes.find((n) => n.dataset.connId === target.connId && n.dataset.db === target.db && !n.dataset.schema && !n.dataset.table);
    if (!dbNode) return false;
    if (dbNode._openBranch && (target.schema || target.table)) await dbNode._openBranch();
    selectedNode = dbNode;
  }
  if (target.schema) {
    const schemaNode = [...treeRoot.querySelectorAll('.tree-node')]
      .find((n) => n.dataset.connId === target.connId && n.dataset.db === target.db && n.dataset.schema === target.schema && !n.dataset.table);
    if (schemaNode) {
      if (schemaNode._openBranch && target.table) await schemaNode._openBranch();
      selectedNode = schemaNode;
    }
  }
  if (target.table) {
    const leaf = [...treeRoot.querySelectorAll('[data-leaf-node]')]
      .find((n) => n.dataset.connId === target.connId && n.dataset.db === target.db
        && (n.dataset.schema || '') === (target.schema || '') && n.dataset.table === target.table);
    if (leaf) selectedNode = leaf;
  }
  const row = selectedNode && selectedNode.querySelector(':scope > .tree-row');
  if (row) selectRow(row);
  setActiveTarget(target, 'workspace-restore');
  return !!row;
}

export function setupTreeFilter() {
  const input = $('#tree-filter');
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    // 过滤连接与表叶子
    for (const node of treeRoot.querySelectorAll('[data-conn]')) {
      const conn = state.connections.find((c) => c.id === node.dataset.conn);
      const matchConn = !q || (conn && conn.name.toLowerCase().includes(q));
      let anyLeaf = false;
      for (const leaf of node.querySelectorAll('[data-leaf-node]')) {
        const m = !q || leaf.querySelector('.tree-row').dataset.leaf.includes(q);
        leaf.style.display = m ? '' : 'none';
        if (m) anyLeaf = true;
      }
      node.style.display = matchConn || anyLeaf || !q ? '' : (node.querySelector('[data-leaf-node]') ? '' : 'none');
      if (!matchConn && !anyLeaf && q) node.style.display = 'none';
    }
  });
}

// 事件联动
on('connections-changed', () => {
  renderTree();
});
on('objects-changed', async (t) => {
  await reloadDbBranch(t.connId, t.db, t.schema);
});
on('databases-changed', async (t) => {
  const rec = connNodes.get(t.connId);
  if (rec) await rec.reload();
});
on('queries-changed', async (t) => {
  const key = `queries|${t.connId}`;
  for (const n of treeRoot.querySelectorAll('.tree-node')) {
    if (n.dataset.reloadKey === key && n._reload) { await n._reload(); return; }
  }
});
