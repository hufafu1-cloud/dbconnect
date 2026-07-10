// 表数据标签页：分页浏览 + 筛选 + 排序 + 行内编辑
import { el, iconEl, fmtCount } from './util.js';
import { connLabel, connColor, state } from './state.js';
import { addTab } from './tabs.js';
import { DataGrid } from './grid.js';
import { toast, confirmDialog } from './toast.js';
import { statusbar } from './statusbar.js';
import { authorizeOperation } from './danger.js';

const PAGE_SIZES = [100, 500, 1000];

export function openTableTab(target, openOpts) {
  const tabId = `table:${target.connId}|${target.db}|${target.schema || ''}|${target.table}`;
  const tab = addTab({ id: tabId, title: target.table, icon: 'table', color: connColor(target.connId), tooltip: `${connLabel(target.connId)} / ${target.db || ''} / ${target.table}` });
  if (tab.pane.childElementCount) {
    // 已存在：若带新筛选条件则套用并重载
    if (openOpts && openOpts.initialWhere && tab._applyWhere) tab._applyWhere(openOpts.initialWhere);
    return tab;
  }

  let page = 1;
  let pageSize = 500;
  let total = null;
  let where = (openOpts && openOpts.initialWhere) || '';
  let orderBy = null, orderDir = null;
  let readonly = true;
  let loading = false;
  let viewMode = 'grid'; // grid | form

  const pageInput = el('input', { type: 'text', value: '1', style: { width: '44px', textAlign: 'center' } });
  const pageLabel = el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '');
  const whereInput = el('input', { type: 'text', value: where, placeholder: 'WHERE 条件，如: id > 100 AND name LIKE \'%张%\'', style: { width: '300px', fontFamily: 'var(--mono)' } });
  const roBadge = el('span', { class: 'readonly-badge', style: { display: 'none' } }, '只读（无主键）');
  const infoEl = el('span', {}, '');

  const blobCtxFor = (rowIdx, colName) => {
    const pk = grid._pkOf(rowIdx, false);
    if (!pk) return null;
    return { connId: target.connId, db: target.db, schema: target.schema, table: target.table, column: colName, pk };
  };

  const grid = new DataGrid(el('div'), {
    editable: true,
    onSort: (col, dir) => { orderBy = col; orderDir = dir; load(); },
    onChange: () => { updateDirty(); if (viewMode === 'form') { /* 网格已更新模型，表单下次渲染读取最新值 */ } },
    copyContext: {
      table: target.table,
      connId: target.connId,
      db: target.db,
      schema: target.schema,
      connType: (state.connections.find((c) => c.id === target.connId) || {}).type,
    },
    onJumpFk: (fk, value) => {
      const cond = `${qi(fk.refColumn)} = ${numOrLit(value)}`;
      openTableTab({ connId: target.connId, db: target.db, schema: fk.refSchema || target.schema, table: fk.refTable }, { initialWhere: cond });
    },
  });

  const mkBtn = (icon, label, onClick, extra) =>
    el('button', { class: 'pbtn' + (extra ? ' ' + extra : ''), onClick }, iconEl(icon), label);

  const btnApply = mkBtn('check', '应用', applyChanges, 'success');
  const btnDiscard = mkBtn('cross', '放弃', discardChanges, 'danger');
  const btnAdd = mkBtn('plus', '添加行', () => { if (canEdit()) grid.addNewRow(); });
  const btnDel = mkBtn('minus', '删除行', () => { if (canEdit()) { grid.deleteSelected(); updateDirty(); } });
  const btnView = mkBtn('objects', '表单视图', () => toggleView());

  function canEdit() {
    if (readonly) { toast.info(roBadge.textContent || '该表没有主键，数据为只读'); return false; }
    return true;
  }

  const toolbar = el('div', { class: 'pane-toolbar' },
    mkBtn('refresh', '刷新', () => load()),
    el('span', { class: 'sep' }),
    mkBtn('filter', '条件', () => toggleBuilder()),
    whereInput,
    mkBtn('run', '应用筛选', () => { where = whereInput.value.trim(); page = 1; load(); }),
    el('span', { class: 'sep' }),
    btnAdd, btnDel, btnApply, btnDiscard,
    el('span', { class: 'sep' }),
    btnView,
    mkBtn('importIcon', '导入', async () => {
      const { openImportWizard } = await import('./importWizard.js');
      openImportWizard(target);
    }),
    mkBtn('exportIcon', '导出', async (e) => {
      const { showTableExportMenu } = await import('./exportMenu.js');
      showTableExportMenu(e.clientX, e.clientY, target, where);
    }),
    el('span', { class: 'spring' }),
    roBadge,
  );

  // ---------- 筛选构建器 ----------
  const connType = (state.connections.find((c) => c.id === target.connId) || {}).type || 'mysql';
  const BACKSLASH_ESC = ['mysql', 'oceanbase', 'clickhouse'].includes(connType);
  const qi = (n) => connType === 'mssql' ? '[' + String(n).replace(/]/g, ']]') + ']'
    : ['mysql', 'oceanbase', 'clickhouse'].includes(connType) ? '`' + String(n).replace(/`/g, '``') + '`'
    : '"' + String(n).replace(/"/g, '""') + '"';
  const lit = (v) => {
    let s = String(v).replace(/'/g, "''");
    if (BACKSLASH_ESC) s = s.replace(/\\/g, '\\\\');
    return "'" + s + "'";
  };
  const numOrLit = (v) => (/^-?\d+(\.\d+)?$/.test(String(v).trim()) ? String(v).trim() : lit(v));
  const OPS = [
    ['=', '='], ['<>', '<>'], ['>', '>'], ['>=', '>='], ['<', '<'], ['<=', '<='],
    ['contains', '包含'], ['starts', '开头是'], ['in', 'IN 列表'], ['null', '为空'], ['notnull', '不为空'],
  ];
  const builderRows = [];
  const builderRowsHost = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
  const builderPanel = el('div', { class: 'filter-builder', style: { display: 'none' } },
    builderRowsHost,
    el('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
      el('button', { class: 'pbtn', onClick: () => { addBuilderRow(); } }, iconEl('plus'), '添加条件'),
      el('button', { class: 'pbtn success', onClick: applyBuilder }, iconEl('check'), '应用'),
      el('button', { class: 'pbtn', onClick: () => { builderRows.length = 0; renderBuilder(); whereInput.value = ''; where = ''; page = 1; load(); } }, iconEl('cross'), '清除')));

  function toggleBuilder() {
    const show = builderPanel.style.display === 'none';
    builderPanel.style.display = show ? '' : 'none';
    if (show && !builderRows.length) addBuilderRow();
    if (show) renderBuilder();
  }

  function addBuilderRow() {
    builderRows.push({ conn: 'AND', col: '', op: '=', val: '' });
    renderBuilder();
  }

  function renderBuilder() {
    builderRowsHost.innerHTML = '';
    const colNames = grid.columns.map((c) => c.name);
    builderRows.forEach((r, i) => {
      const connSel = el('select', { style: { width: '64px', visibility: i === 0 ? 'hidden' : 'visible' } },
        el('option', { value: 'AND' }, 'AND'), el('option', { value: 'OR' }, 'OR'));
      connSel.value = r.conn;
      connSel.addEventListener('change', () => { r.conn = connSel.value; });
      const colSel = el('select', { style: { minWidth: '130px' } },
        ...colNames.map((n) => el('option', { value: n }, n)));
      if (r.col && colNames.includes(r.col)) colSel.value = r.col; else r.col = colNames[0] || '';
      colSel.addEventListener('change', () => { r.col = colSel.value; });
      const opSel = el('select', {}, ...OPS.map(([v, label]) => el('option', { value: v }, label)));
      opSel.value = r.op;
      const valInput = el('input', { type: 'text', value: r.val, placeholder: 'IN 用逗号分隔', style: { width: '180px', fontFamily: 'var(--mono)' } });
      valInput.addEventListener('input', () => { r.val = valInput.value; });
      valInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyBuilder(); });
      const syncVal = () => { valInput.disabled = r.op === 'null' || r.op === 'notnull'; };
      opSel.addEventListener('change', () => { r.op = opSel.value; syncVal(); });
      syncVal();
      builderRowsHost.append(el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        connSel, colSel, opSel, valInput,
        el('button', { class: 'pbtn danger', title: '移除', onClick: () => { builderRows.splice(i, 1); renderBuilder(); } }, '✕')));
    });
    if (!builderRows.length) {
      builderRowsHost.append(el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '点击“添加条件”开始构建筛选'));
    }
  }

  function buildCond(r) {
    if (!r.col) return null;
    const c = qi(r.col);
    switch (r.op) {
      case 'contains': return `${c} LIKE ${lit('%' + r.val + '%')}`;
      case 'starts': return `${c} LIKE ${lit(r.val + '%')}`;
      case 'in': {
        const parts = String(r.val).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        if (!parts.length) return null;
        return `${c} IN (${parts.map(numOrLit).join(', ')})`;
      }
      case 'null': return `${c} IS NULL`;
      case 'notnull': return `${c} IS NOT NULL`;
      default: return r.val === '' ? null : `${c} ${r.op} ${numOrLit(r.val)}`;
    }
  }

  function applyBuilder() {
    const parts = [];
    builderRows.forEach((r, i) => {
      const cond = buildCond(r);
      if (!cond) return;
      parts.push(parts.length ? `${r.conn} ${cond}` : cond);
    });
    whereInput.value = parts.join(' ');
    where = whereInput.value.trim();
    page = 1;
    load();
  }

  const gridHost = grid.host;
  gridHost.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;';
  // 表单视图宿主
  const formHost = el('div', { style: { flex: '1', minHeight: '0', overflow: 'auto', display: 'none' } });
  let formView = null;

  async function toggleView() {
    if (viewMode === 'grid') {
      const { FormView } = await import('./formView.js');
      if (!formView) formView = new FormView(formHost, grid, { isReadonly: () => readonly, blobCtx: blobCtxFor });
      viewMode = 'form';
      gridHost.style.display = 'none';
      formHost.style.display = '';
      btnView.classList.add('active');
      formView.setIndex(0);
    } else {
      viewMode = 'grid';
      formHost.style.display = 'none';
      gridHost.style.display = 'flex';
      btnView.classList.remove('active');
      grid.render(); // 同步表单中所做的编辑
    }
  }

  // FK 跳转用的列映射 + 重载筛选
  async function loadFkMap() {
    try {
      const fks = await window.api.db.foreignKeys(target.connId, { db: target.db, schema: target.schema, table: target.table });
      const map = {};
      for (const fk of fks) {
        fk.columns.forEach((c, i) => { map[c] = { refTable: fk.refTable, refColumn: fk.refColumns[i], refSchema: fk.refSchema }; });
      }
      grid.opts.fkMap = map;
    } catch (e) { grid.opts.fkMap = null; }
  }
  tab._applyWhere = (cond) => {
    whereInput.value = cond;
    where = cond;
    page = 1;
    tab.activate();
    load();
  };

  const pager = el('div', { class: 'pane-info' },
    el('span', { style: { display: 'inline-flex', gap: '2px', alignItems: 'center' } },
      el('button', { class: 'pbtn', title: '第一页', onClick: () => goPage(1) }, '⏮'),
      el('button', { class: 'pbtn', title: '上一页', onClick: () => goPage(page - 1) }, '◀'),
      pageInput,
      pageLabel,
      el('button', { class: 'pbtn', title: '下一页', onClick: () => goPage(page + 1) }, '▶'),
      el('button', { class: 'pbtn', title: '最后一页', onClick: () => goPage(Infinity) }, '⏭')),
    el('span', {}, '每页',
      (() => {
        const sel = el('select', {}, ...PAGE_SIZES.map((n) => el('option', { value: n, selected: n === pageSize ? 'selected' : null }, n)));
        sel.value = String(pageSize);
        sel.addEventListener('change', () => { pageSize = Number(sel.value); page = 1; load(); });
        return sel;
      })(), '行'),
    infoEl,
  );

  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const n = parseInt(pageInput.value, 10);
      if (n >= 1) goPage(n);
    }
  });
  whereInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { where = whereInput.value.trim(); page = 1; load(); }
  });

  tab.pane.append(toolbar, builderPanel, gridHost, formHost, pager);
  tab.setIsDirty(() => grid.isDirty());
  tab.setOnShow(() => statusbar.setLeft(`${connLabel(target.connId)} › ${target.db || ''} › ${target.table}`));

  function pageCount() {
    return total === null ? null : Math.max(1, Math.ceil(total / pageSize));
  }

  async function goPage(n) {
    if (grid.isDirty()) {
      const ok = await confirmDialog('未应用的更改', '当前页有未应用的更改，翻页将丢失。继续吗？', { danger: true, okLabel: '继续' });
      if (!ok) return;
    }
    const pc = pageCount() || 1;
    page = Math.min(Math.max(1, n === Infinity ? pc : n), pc);
    load();
  }

  async function load() {
    if (loading) return;
    loading = true;
    infoEl.textContent = '加载中…';
    try {
      const r = await window.api.db.tableData(target.connId, {
        db: target.db, schema: target.schema, table: target.table,
        page, pageSize, where, orderBy: orderBy || '', orderDir: orderDir || 'asc',
      });
      total = r.total;
      readonly = !r.pk || !r.pk.length;
      roBadge.textContent = r.readonlyReason || '只读（无主键）';
      roBadge.title = roBadge.textContent;
      roBadge.style.display = readonly ? '' : 'none';
      grid.opts.editable = !readonly;
      grid.setSort(orderBy, orderDir);
      grid.setData({ columns: r.columns, rows: r.rows, pk: r.pk });
      pageInput.value = String(page);
      pageLabel.textContent = `/ ${pageCount()} 页`;
      infoEl.textContent = `共 ${fmtCount(total)} 行 · 本页 ${r.rows.length} 行 · 查询耗时 ${r.ms} ms`;
      statusbar.setRight(`${fmtCount(total)} 行 · ${r.ms} ms`);
      if (viewMode === 'form' && formView) formView.setIndex(0);
      updateDirty();
    } catch (e) {
      infoEl.textContent = '';
      toast.error('加载失败: ' + e.message);
    } finally {
      loading = false;
    }
  }

  function updateDirty() {
    tab.setDirty(grid.isDirty());
    const n = grid.cellEdits.size + grid.newRows.length + grid.deletedRows.size;
    btnApply.disabled = !grid.isDirty();
    btnDiscard.disabled = !grid.isDirty();
    if (grid.isDirty()) infoEl.textContent = `待应用更改: ${n} 处（点击“应用”提交）`;
  }

  async function applyChanges() {
    const edits = grid.getPendingEdits();
    if (!edits.length) return;
    try {
      const approved = await authorizeOperation('db.applyEdits', {
        connId: target.connId,
        db: target.db, schema: target.schema, table: target.table, edits,
      });
      if (!approved) return;
      const r = await window.api.db.applyEdits(target.connId, approved);
      toast.success(`已应用 ${r.count} 处更改`);
      await load();
    } catch (e) {
      toast.error('应用失败（已回滚）:\n' + e.message, 12000);
    }
  }

  async function discardChanges() {
    grid.clearPending();
    grid.render();
    updateDirty();
    infoEl.textContent = '已放弃全部更改';
  }

  load();
  loadFkMap();
  return tab;
}
