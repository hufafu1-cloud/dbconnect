// 可视化表设计器：栏位 / 索引 / SQL 预览，支持新建表与修改表
import { el, iconEl, debounce } from './util.js';
import { connLabel, connColor, emit, setActiveTarget } from './state.js';
import { addTab, uid } from './tabs.js';
import { toast, confirmDialog } from './toast.js';
import { authorizeOperation } from './danger.js';

/**
 * target: {connId, db, schema, table?}  table 为空 = 新建表
 */
export function openDesignTab(target, opts = {}) {
  setActiveTarget(target, 'design-tab');
  let isNew = !target.table;
  let restoreState = opts && opts.restoreState;
  const tabId = (opts && opts.restoreId)
    || (isNew ? uid('design-new') : `design:${target.connId}|${target.db}|${target.schema || ''}|${target.table}`);
  const tab = addTab({
    id: tabId,
    title: isNew ? '新建表' : `设计 - ${target.table}`,
    icon: 'struct',
    color: connColor(target.connId),
    tooltip: `${connLabel(target.connId)} / ${target.db || ''}`,
  });
  if (tab.pane.childElementCount) return tab;
  if (!restoreState && tab.deferredWorkspaceEntry && tab.deferredWorkspaceEntry.type === 'design') {
    restoreState = tab.deferredWorkspaceEntry.state;
  }

  let meta = null;        // {dialect, types, caps}
  let original = null;    // 修改表时的原始模型
  let model = null;       // 当前编辑模型
  let dirty = false;
  let recoveryConflictWarning = '';
  let selColIdx = -1;
  let selIxIdx = -1;
  let selFkIdx = -1;
  let selConstraintIdx = -1;

  const pane = tab.pane;
  pane.classList.add('design-pane');

  // ---------- 工具栏 ----------
  const btnSave = el('button', { class: 'pbtn success', onClick: save }, iconEl('save'), '保存');
  const btnAddCol = el('button', { class: 'pbtn', onClick: () => { addColumn(); } }, iconEl('plus'), '添加栏位');
  const btnDelCol = el('button', { class: 'pbtn', onClick: removeColumn }, iconEl('minus'), '删除栏位');
  const btnUp = el('button', { class: 'pbtn', onClick: () => moveColumn(-1) }, '▲ 上移');
  const btnDown = el('button', { class: 'pbtn', onClick: () => moveColumn(1) }, '▼ 下移');
  const tableNameInput = el('input', { type: 'text', placeholder: '表名', style: { width: '180px', fontWeight: '600' } });
  const recoveryNotice = el('span', {
    style: { color: 'var(--orange)', fontSize: '12px', whiteSpace: 'nowrap' },
  });
  const toolbar = el('div', { class: 'pane-toolbar' },
    btnSave, el('span', { class: 'sep' }),
    el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '表名:'), tableNameInput,
    el('span', { class: 'sep' }),
    btnAddCol, btnDelCol, btnUp, btnDown, recoveryNotice,
  );
  tableNameInput.addEventListener('input', () => { if (model) { model.table = tableNameInput.value.trim(); markDirty(); } });

  // ---------- 子标签 ----------
  const subTabs = el('div', { class: 'result-tabs' });
  const subBody = el('div', { class: 'result-body' });
  const pages = [];
  function addPage(title, contentEl) {
    const idx = pages.length;
    const rt = el('div', { class: 'rtab', onClick: () => activatePage(idx) }, title);
    const pg = el('div', { class: 'result-page' }, contentEl);
    subTabs.append(rt);
    subBody.append(pg);
    pages.push({ rt, pg, title });
    return idx;
  }
  function activatePage(idx) {
    pages.forEach((p, i) => {
      p.rt.classList.toggle('active', i === idx);
      p.pg.classList.toggle('active', i === idx);
    });
    if (model && meta && pages[idx].title === '索引') renderIndexes();
    if (model && meta && pages[idx].title === '外键') renderForeignKeys();
    if (model && meta && pages[idx].title === '约束') renderConstraints();
    if (pages[idx].title === 'SQL 预览') refreshPreview();
  }

  // 栏位页
  const colsHost = el('div', { class: 'design-grid-host' });
  const commentRow = el('div', { class: 'design-footer' });
  const colsPage = el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } }, colsHost, commentRow);
  // 索引页
  const ixHost = el('div', { class: 'design-grid-host' });
  const ixToolbar = el('div', { style: { padding: '6px 10px', display: 'flex', gap: '6px' } },
    el('button', { class: 'pbtn', onClick: addIndex }, iconEl('plus'), '添加索引'),
    el('button', { class: 'pbtn', onClick: removeIndex }, iconEl('minus'), '删除索引'));
  const ixPage = el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } }, ixToolbar, ixHost);
  // 外键页
  const fkHost = el('div', { class: 'design-grid-host' });
  const fkToolbar = el('div', { style: { padding: '6px 10px', display: 'flex', gap: '6px', alignItems: 'center' } },
    el('button', { class: 'pbtn', onClick: addForeignKey }, iconEl('plus'), '添加外键'),
    el('button', { class: 'pbtn', onClick: removeForeignKey }, iconEl('minus'), '删除外键'));
  const fkPage = el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } }, fkToolbar, fkHost);
  // UNIQUE / CHECK 约束页
  const constraintHost = el('div', { class: 'design-grid-host' });
  const constraintToolbar = el('div', { style: { padding: '6px 10px', display: 'flex', gap: '6px', alignItems: 'center' } },
    el('button', { class: 'pbtn', onClick: addConstraint }, iconEl('plus'), '添加约束'),
    el('button', { class: 'pbtn', onClick: removeConstraint }, iconEl('minus'), '删除约束'));
  const constraintPage = el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } }, constraintToolbar, constraintHost);
  // SQL 预览页
  const previewBox = el('div', { class: 'ddl-box', style: { margin: '10px', flex: '1', overflow: 'auto', whiteSpace: 'pre' } }, '');
  const warnBox = el('div', { style: { margin: '0 10px 10px', color: 'var(--orange)', fontSize: '12px', whiteSpace: 'pre-wrap' } }, '');
  const previewPage = el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } }, previewBox, warnBox);

  addPage('栏位', colsPage);
  addPage('索引', ixPage);
  addPage('外键', fkPage);
  addPage('约束', constraintPage);
  addPage('SQL 预览', previewPage);

  pane.append(toolbar, subTabs, subBody);
  activatePage(0);

  tab.setIsDirty(() => dirty);
  tab.setRecovery('design', () => (model ? {
    target: {
      connId: target.connId,
      db: target.db || null,
      schema: target.schema || null,
      table: target.table || null,
    },
    model: JSON.parse(JSON.stringify(model)),
    original: original ? JSON.parse(JSON.stringify(original)) : null,
    dirty,
  } : null));
  tab.setOnShow(() => setActiveTarget(target, 'design-tab'));

  function markDirty() {
    dirty = true;
    tab.setDirty(true);
    if (tab.touchRecovery) tab.touchRecovery();
    schedulePreview();
  }
  const schedulePreview = debounce(() => {
    const active = pages.findIndex((p) => p.rt.classList.contains('active'));
    if (pages[active] && pages[active].title === 'SQL 预览') refreshPreview();
  }, 400);

  // ---------- 栏位编辑表格 ----------
  function cellInput(value, onChange, opts = {}) {
    const input = el('input', {
      type: 'text', value: value === null || value === undefined ? '' : String(value),
      style: { width: '100%', border: 'none', outline: 'none', background: 'transparent', fontSize: '12.5px', padding: '2px 2px' },
      spellcheck: false, ...(opts.attrs || {}),
    });
    if (opts.list) input.setAttribute('list', opts.list);
    input.addEventListener('input', () => { onChange(input.value); markDirty(); });
    return input;
  }
  function cellCheck(checked, onChange, disabled) {
    const c = el('input', { type: 'checkbox' });
    c.checked = !!checked;
    if (disabled) c.disabled = true;
    c.addEventListener('change', () => { onChange(c.checked); markDirty(); });
    return c;
  }

  function cellSelect(value, values, onChange, disabled) {
    const select = el('select', {}, ...values.map((v) => el('option', { value: v }, v)));
    select.value = values.includes(value) ? value : values[0];
    select.disabled = !!disabled;
    select.addEventListener('change', () => { onChange(select.value); markDirty(); });
    return select;
  }

  function renameLocalColumnRefs(from, to) {
    if (!from || !to || from === to) return;
    for (const ix of model.indexes || []) ix.columns = (ix.columns || []).map((name) => name === from ? to : name);
    for (const fk of model.foreignKeys || []) {
      fk.columns = (fk.columns || []).map((name) => name === from ? to : name);
      if (fk.refTable === model.table && (!fk.refSchema || fk.refSchema === target.schema)) {
        fk.refColumns = (fk.refColumns || []).map((name) => name === from ? to : name);
      }
    }
    for (const item of model.constraints || []) {
      if (item.kind === 'unique') item.columns = (item.columns || []).map((name) => name === from ? to : name);
    }
  }

  function removeLocalColumnRefs(name) {
    model.indexes = (model.indexes || []).filter((ix) => !(ix.columns || []).includes(name));
    model.foreignKeys = (model.foreignKeys || []).filter((fk) => !(fk.columns || []).includes(name));
    model.constraints = (model.constraints || []).filter((item) => item.kind !== 'unique' || !(item.columns || []).includes(name));
  }

  function renderColumns() {
    colsHost.innerHTML = '';
    const cap = meta.caps;
    const table = el('table', { class: 'design-table' });
    table.append(el('thead', {}, el('tr', {},
      el('th', { style: { width: '34px' } }, '🔑'),
      el('th', { style: { width: '22%' } }, '名称'),
      el('th', { style: { width: '16%' } }, '类型'),
      el('th', { style: { width: '70px' } }, '长度'),
      el('th', { style: { width: '64px' } }, '小数点'),
      el('th', { style: { width: '64px' } }, '不是 null'),
      cap.autoInc ? el('th', { style: { width: '60px' } }, '自增') : null,
      el('th', { style: { width: '15%' } }, '默认值'),
      el('th', {}, '注释'),
    )));
    const tb = el('tbody');
    model.columns.forEach((c, i) => {
      let lastRefName = c.name;
      const rowEditable = isNew || !c.origName || c.editSafe !== false;
      const readOnlyTitle = c.editUnsafeReason || '该栏位含设计器无法无损表示的高级属性；请使用迁移 SQL 修改';
      const inputOpts = { attrs: { disabled: !rowEditable, title: rowEditable ? '' : readOnlyTitle } };
      const tr = el('tr', { 'data-i': i, title: rowEditable ? '' : readOnlyTitle });
      if (i === selColIdx) tr.classList.add('selected');
      tr.addEventListener('mousedown', (e) => {
        selColIdx = i;
        for (const x of tb.querySelectorAll('tr')) x.classList.toggle('selected', Number(x.dataset.i) === i);
      });
      tr.append(
        el('td', { style: { textAlign: 'center' } }, cellCheck(c.pk, (v) => { c.pk = v; }, !rowEditable)),
        el('td', {}, cellInput(c.name, (v) => {
          const next = v.trim();
          renameLocalColumnRefs(lastRefName, next);
          c.name = next;
          if (next) lastRefName = next;
        }, inputOpts)),
        el('td', {}, cellInput(c.type, (v) => { c.type = v.trim(); }, { ...inputOpts, list: 'design-types' })),
        el('td', {}, cellInput(c.length, (v) => { c.length = v.trim(); }, inputOpts)),
        el('td', {}, cellInput(c.scale, (v) => { c.scale = v.trim(); }, inputOpts)),
        el('td', { style: { textAlign: 'center' } }, cellCheck(c.notNull, (v) => { c.notNull = v; }, !rowEditable)),
        cap.autoInc ? el('td', { style: { textAlign: 'center' } }, cellCheck(c.autoInc, (v) => { c.autoInc = v; }, !rowEditable)) : null,
        el('td', {}, cellInput(c.def, (v) => { c.def = v; }, inputOpts)),
        el('td', {}, cellInput(c.comment, (v) => { c.comment = v; }, rowEditable
          ? (cap.comments ? {} : { attrs: { placeholder: '（该库不支持）' } })
          : inputOpts)),
      );
      tb.append(tr);
    });
    table.append(tb);
    colsHost.append(table);
    if (!model.columns.length) {
      colsHost.append(el('div', { class: 'obj-placeholder' }, '点击“添加栏位”开始'));
    }
    // 表注释 / 选项
    commentRow.innerHTML = '';
    const cInput = el('input', { type: 'text', value: model.comment || '', placeholder: meta.caps.comments ? '表注释' : '（该库不支持表注释）', style: { flex: '1' } });
    cInput.addEventListener('input', () => { model.comment = cInput.value; markDirty(); });
    commentRow.append(el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '表注释:'), cInput);
    if (meta.dialect === 'clickhouse') {
      const oInput = el('input', { type: 'text', value: model.options || '', placeholder: 'ENGINE = MergeTree ORDER BY tuple()', style: { flex: '1', fontFamily: 'var(--mono)' } });
      oInput.addEventListener('input', () => { model.options = oInput.value; markDirty(); });
      commentRow.append(el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '表选项:'), oInput);
    }
  }

  function addColumn() {
    model.columns.push({
      name: '', origName: null, type: meta.dialect === 'sqlite' ? 'TEXT' : (meta.types[0] || 'varchar'),
      length: '', scale: '', notNull: false, pk: false, autoInc: false, def: '', comment: '',
    });
    selColIdx = model.columns.length - 1;
    renderColumns();
    markDirty();
    const rows = colsHost.querySelectorAll('tbody tr');
    const last = rows[rows.length - 1];
    if (last) { last.scrollIntoView({ block: 'nearest' }); const inp = last.querySelectorAll('input[type=text]')[0]; if (inp) inp.focus(); }
  }
  function removeColumn() {
    if (selColIdx < 0 || selColIdx >= model.columns.length) { toast.info('请先选中一行'); return; }
    if (!isNew && model.columns[selColIdx].origName && model.columns[selColIdx].editSafe === false) {
      toast.info(model.columns[selColIdx].editUnsafeReason || '该栏位含高级属性，不能在设计器中删除');
      return;
    }
    removeLocalColumnRefs(model.columns[selColIdx].name);
    model.columns.splice(selColIdx, 1);
    selColIdx = Math.min(selColIdx, model.columns.length - 1);
    renderColumns();
    renderIndexes();
    renderForeignKeys();
    renderConstraints();
    markDirty();
  }
  function moveColumn(dir) {
    const i = selColIdx;
    const j = i + dir;
    if (i < 0 || j < 0 || j >= model.columns.length) return;
    const [c] = model.columns.splice(i, 1);
    model.columns.splice(j, 0, c);
    selColIdx = j;
    renderColumns();
    markDirty();
    if (original) toast.info('提示：已有表的栏位顺序调整不会生成 ALTER（仅影响新建表）', 4000);
  }

  // ---------- 索引编辑 ----------
  function renderIndexes() {
    ixHost.innerHTML = '';
    if (!meta.caps.indexes) {
      ixHost.append(el('div', { class: 'obj-placeholder' }, '该数据库的索引不支持在设计器中管理'));
      return;
    }
    const table = el('table', { class: 'design-table' });
    table.append(el('thead', {}, el('tr', {},
      el('th', { style: { width: '30%' } }, '名称'),
      el('th', {}, '栏位（逗号分隔）'),
      el('th', { style: { width: '70px' } }, '唯一'))));
    const tb = el('tbody');
    model.indexes.forEach((ix, i) => {
      const tr = el('tr', { 'data-i': i });
      if (i === selIxIdx) tr.classList.add('selected');
      tr.addEventListener('mousedown', () => {
        selIxIdx = i;
        for (const x of tb.querySelectorAll('tr')) x.classList.toggle('selected', Number(x.dataset.i) === i);
      });
      tr.append(
        el('td', {}, cellInput(ix.name, (v) => { ix.name = v.trim(); })),
        el('td', {}, cellInput(ix.columns.join(', '), (v) => {
          ix.columns = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        })),
        el('td', { style: { textAlign: 'center' } }, cellCheck(ix.unique, (v) => { ix.unique = v; })),
      );
      tb.append(tr);
    });
    table.append(tb);
    ixHost.append(table);
    if (!model.indexes.length) ixHost.append(el('div', { class: 'obj-placeholder' }, '（无索引）'));
  }
  function addIndex() {
    if (!meta.caps.indexes) return;
    model.indexes.push({ name: '', origName: null, columns: [], unique: false });
    selIxIdx = model.indexes.length - 1;
    renderIndexes();
    markDirty();
  }
  function removeIndex() {
    if (selIxIdx < 0 || selIxIdx >= model.indexes.length) { toast.info('请先选中一行'); return; }
    model.indexes.splice(selIxIdx, 1);
    selIxIdx = -1;
    renderIndexes();
    markDirty();
  }

  // ---------- 外键编辑 ----------
  function splitColumns(value) {
    return String(value || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  }

  function renderForeignKeys() {
    fkHost.innerHTML = '';
    const cap = meta.caps;
    const editable = !!cap.foreignKeys && (isNew || !!cap.foreignKeyAlter);
    for (const button of fkToolbar.querySelectorAll('button')) button.disabled = !editable;
    if (!cap.foreignKeys) {
      fkHost.append(el('div', { class: 'obj-placeholder' }, '该数据库不支持外键，设计器不会生成相关 DDL'));
      return;
    }
    if (!isNew && !cap.foreignKeyAlter) {
      fkHost.append(el('div', { style: { padding: '8px 10px', color: 'var(--orange)', fontSize: '12px' } },
        '该数据库只能在 CREATE TABLE 时声明外键；既有表需要重建，当前为只读查看。'));
    }
    const table = el('table', { class: 'design-table', style: { minWidth: '1040px' } });
    table.append(el('thead', {}, el('tr', {},
      el('th', { style: { width: '15%' } }, '名称'),
      el('th', { style: { width: '17%' } }, '本表栏位'),
      el('th', { style: { width: '12%' } }, '引用 Schema'),
      el('th', { style: { width: '15%' } }, '引用表'),
      el('th', { style: { width: '17%' } }, '引用栏位'),
      el('th', { style: { width: '12%' } }, 'ON UPDATE'),
      el('th', { style: { width: '12%' } }, 'ON DELETE'))));
    const tb = el('tbody');
    (model.foreignKeys || []).forEach((fk, i) => {
      const rowEditable = editable && fk.rebuildSafe !== false;
      const tr = el('tr', {
        'data-i': i,
        title: fk.rebuildSafe === false ? '该外键含设计器无法无损表示的高级属性；可查看或删除，请用 SQL 修改' : '',
      });
      if (i === selFkIdx) tr.classList.add('selected');
      tr.addEventListener('mousedown', () => {
        selFkIdx = i;
        for (const row of tb.querySelectorAll('tr')) row.classList.toggle('selected', Number(row.dataset.i) === i);
      });
      const updateActions = [...new Set([fk.onUpdate || 'NO ACTION', ...(cap.fkUpdateActions || ['NO ACTION'])])];
      const deleteActions = [...new Set([fk.onDelete || 'NO ACTION', ...(cap.fkDeleteActions || ['NO ACTION'])])];
      tr.append(
        el('td', {}, cellInput(fk.name, (v) => { fk.name = v.trim(); }, { attrs: { disabled: !rowEditable, placeholder: '自动生成' } })),
        el('td', {}, cellInput((fk.columns || []).join(', '), (v) => { fk.columns = splitColumns(v); }, { attrs: { disabled: !rowEditable } })),
        el('td', {}, cellInput(fk.refSchema || '', (v) => { fk.refSchema = v.trim(); }, { attrs: { disabled: !rowEditable, placeholder: target.schema || '同 Schema' } })),
        el('td', {}, cellInput(fk.refTable || '', (v) => { fk.refTable = v.trim(); }, { attrs: { disabled: !rowEditable } })),
        el('td', {}, cellInput((fk.refColumns || []).join(', '), (v) => { fk.refColumns = splitColumns(v); }, { attrs: { disabled: !rowEditable } })),
        el('td', {}, cellSelect(fk.onUpdate || 'NO ACTION', updateActions, (v) => { fk.onUpdate = v; }, !rowEditable)),
        el('td', {}, cellSelect(fk.onDelete || 'NO ACTION', deleteActions, (v) => { fk.onDelete = v; }, !rowEditable)),
      );
      tb.append(tr);
    });
    table.append(tb);
    fkHost.append(table);
    if (!(model.foreignKeys || []).length) fkHost.append(el('div', { class: 'obj-placeholder' }, '（无外键）'));
  }

  function addForeignKey() {
    if (!meta.caps.foreignKeys || (!isNew && !meta.caps.foreignKeyAlter)) {
      toast.info('该数据库不能在当前表上直接添加外键');
      return;
    }
    if (!model.foreignKeys) model.foreignKeys = [];
    model.foreignKeys.push({
      name: '', origName: null, columns: [], refSchema: '', refTable: '', refColumns: [],
      onUpdate: 'NO ACTION', onDelete: 'NO ACTION',
    });
    selFkIdx = model.foreignKeys.length - 1;
    renderForeignKeys();
    markDirty();
  }

  function removeForeignKey() {
    if (!meta.caps.foreignKeys || (!isNew && !meta.caps.foreignKeyAlter)) return;
    if (selFkIdx < 0 || selFkIdx >= (model.foreignKeys || []).length) { toast.info('请先选中一个外键'); return; }
    model.foreignKeys.splice(selFkIdx, 1);
    selFkIdx = -1;
    renderForeignKeys();
    markDirty();
  }

  // ---------- UNIQUE / CHECK 约束编辑 ----------
  function constraintKinds() {
    const out = [];
    if (meta.caps.uniqueConstraints) out.push('UNIQUE');
    if (meta.caps.checkConstraints) out.push('CHECK');
    return out;
  }

  function renderConstraints() {
    constraintHost.innerHTML = '';
    const kinds = constraintKinds();
    const editable = kinds.length > 0 && (isNew || !!meta.caps.constraintAlter);
    for (const button of constraintToolbar.querySelectorAll('button')) button.disabled = !editable;
    if (!kinds.length) {
      constraintHost.append(el('div', { class: 'obj-placeholder' }, '该数据库不支持在设计器中管理 UNIQUE / CHECK 约束'));
      return;
    }
    if (!isNew && !meta.caps.constraintAlter) {
      constraintHost.append(el('div', { style: { padding: '8px 10px', color: 'var(--orange)', fontSize: '12px' } },
        '该数据库只能在 CREATE TABLE 时声明 UNIQUE / CHECK；既有表需要重建，当前为只读查看。'));
    }
    const table = el('table', { class: 'design-table' });
    table.append(el('thead', {}, el('tr', {},
      el('th', { style: { width: '24%' } }, '名称'),
      el('th', { style: { width: '120px' } }, '类型'),
      el('th', { style: { width: '32%' } }, 'UNIQUE 栏位（逗号分隔）'),
      el('th', {}, 'CHECK 表达式'))));
    const tb = el('tbody');
    (model.constraints || []).forEach((item, i) => {
      const rowEditable = editable && item.rebuildSafe !== false;
      const tr = el('tr', {
        'data-i': i,
        title: item.rebuildSafe === false ? '该约束含设计器无法无损表示的高级属性；可查看或删除，请用 SQL 修改' : '',
      });
      if (i === selConstraintIdx) tr.classList.add('selected');
      tr.addEventListener('mousedown', () => {
        selConstraintIdx = i;
        for (const row of tb.querySelectorAll('tr')) row.classList.toggle('selected', Number(row.dataset.i) === i);
      });
      const kind = String(item.kind || kinds[0]).toUpperCase();
      const availableKinds = [...new Set([kind, ...kinds])];
      tr.append(
        el('td', {}, cellInput(item.name || '', (v) => { item.name = v.trim(); }, { attrs: { disabled: !rowEditable, placeholder: '自动生成' } })),
        el('td', {}, cellSelect(kind, availableKinds, (v) => { item.kind = v.toLowerCase(); renderConstraints(); }, !rowEditable)),
        el('td', {}, cellInput((item.columns || []).join(', '), (v) => { item.columns = splitColumns(v); }, {
          attrs: { disabled: !rowEditable || kind !== 'UNIQUE', placeholder: kind === 'UNIQUE' ? '如: tenant_id, code' : '（CHECK 不使用）' },
        })),
        el('td', {}, cellInput(item.expression || '', (v) => { item.expression = v; }, {
          attrs: { disabled: !rowEditable || kind !== 'CHECK', placeholder: kind === 'CHECK' ? '如: amount >= 0' : '（UNIQUE 不使用）' },
        })),
      );
      tb.append(tr);
    });
    table.append(tb);
    constraintHost.append(table);
    if (!(model.constraints || []).length) constraintHost.append(el('div', { class: 'obj-placeholder' }, '（无 UNIQUE / CHECK 约束）'));
  }

  function addConstraint() {
    const kinds = constraintKinds();
    if (!kinds.length || (!isNew && !meta.caps.constraintAlter)) {
      toast.info('该数据库不能在当前表上直接添加约束');
      return;
    }
    if (!model.constraints) model.constraints = [];
    model.constraints.push({
      kind: kinds[0].toLowerCase(), name: '', origName: null, columns: [], expression: '',
    });
    selConstraintIdx = model.constraints.length - 1;
    renderConstraints();
    markDirty();
  }

  function removeConstraint() {
    if (!meta.caps.constraintAlter && !isNew) return;
    if (selConstraintIdx < 0 || selConstraintIdx >= (model.constraints || []).length) { toast.info('请先选中一个约束'); return; }
    model.constraints.splice(selConstraintIdx, 1);
    selConstraintIdx = -1;
    renderConstraints();
    markDirty();
  }

  // ---------- SQL 预览 / 保存 ----------
  async function refreshPreview() {
    if (!model) return;
    try {
      const r = await window.api.design.ddl(target.connId, {
        db: target.db, schema: target.schema, original, model,
      });
      previewBox.textContent = r.sqls.length ? r.sqls.map((s) => s + ';').join('\n\n') : '-- （没有需要执行的变更）';
      const warnings = [...(r.warnings || [])];
      if (recoveryConflictWarning) warnings.unshift(recoveryConflictWarning);
      warnBox.textContent = warnings.length ? '⚠ ' + warnings.join('\n⚠ ') : '';
    } catch (e) {
      previewBox.textContent = '-- 生成失败: ' + e.message;
      warnBox.textContent = '';
    }
  }

  async function save() {
    if (!model.table || !model.table.trim()) { toast.error('请填写表名'); return; }
    if (!model.columns.some((c) => c.name && c.name.trim())) { toast.error('至少需要一个栏位'); return; }
    let preview;
    try {
      preview = await window.api.design.ddl(target.connId, { db: target.db, schema: target.schema, original, model });
    } catch (e) { toast.error(e.message); return; }
    if (!preview.sqls.length) { toast.info('没有需要保存的变更'); return; }
    const applyPayload = { connId: target.connId, db: target.db, schema: target.schema, original, model };
    let approved;
    try {
      approved = await authorizeOperation('design.apply', applyPayload, {
        title: isNew ? '创建表' : '保存表结构',
        confirmSafe: () => confirmDialog(isNew ? '创建表' : '保存表结构',
          `将执行 ${preview.sqls.length} 条语句：\n\n${preview.sqls.map((s) => s + ';').join('\n')}` +
          (preview.warnings.length ? `\n\n⚠ ${preview.warnings.join('\n⚠ ')}` : ''),
          { okLabel: '执行' }),
      });
    } catch (e) {
      toast.error('生产库安全检查失败：' + e.message);
      return;
    }
    if (!approved) return;
    try {
      const r = await window.api.design.apply(target.connId, approved);
      toast.success(`已执行 ${r.executed} 条语句`);
      emit('objects-changed', { connId: target.connId, db: target.db, schema: target.schema });
      // 重新加载为编辑模式
      target.table = model.table;
      isNew = false;
      tab.setTitle(`设计 - ${target.table}`);
      await loadExisting();
      recoveryConflictWarning = '';
      recoveryNotice.textContent = '';
      dirty = false;
      tab.setDirty(false);
    } catch (e) {
      toast.error('保存失败：\n' + e.message, 15000);
      refreshPreview();
    }
  }

  // ---------- 加载 ----------
  async function loadExisting() {
    model = await window.api.design.model(target.connId, { db: target.db, schema: target.schema, table: target.table });
    original = JSON.parse(JSON.stringify(model));
    tableNameInput.value = model.table;
    renderColumns();
    renderIndexes();
    renderForeignKeys();
    renderConstraints();
    refreshPreview();
  }

  tab.workspaceReady = (async () => {
    try {
      meta = await window.api.design.meta(target.connId);
      // 类型 datalist（全局唯一即可）
      let dl = document.getElementById('design-types');
      if (!dl) { dl = el('datalist', { id: 'design-types' }); document.body.append(dl); }
      dl.innerHTML = '';
      for (const t of meta.types) dl.append(el('option', { value: t }));

      const recoveredModel = restoreState && restoreState.model
        && Array.isArray(restoreState.model.columns) ? JSON.parse(JSON.stringify(restoreState.model)) : null;
      const restoreDirty = !!(restoreState && restoreState.dirty);
      if (recoveredModel && (isNew || (restoreDirty && restoreState.original && typeof restoreState.original === 'object'))) {
        if (!isNew && restoreDirty) {
          try {
            const live = await window.api.design.model(target.connId, {
              db: target.db, schema: target.schema, table: target.table,
            });
            if (JSON.stringify(live) !== JSON.stringify(restoreState.original)) {
              recoveryConflictWarning = '数据库中的表结构已在草稿保存后发生变化；保存前请先核对，系统会再次阻止覆盖。';
            }
          } catch (error) {
            recoveryConflictWarning = `暂时无法核对数据库当前结构：${error.message || error}`;
          }
          recoveryNotice.textContent = recoveryConflictWarning ? '⚠ 恢复草稿与当前结构需核对' : '';
          recoveryNotice.title = recoveryConflictWarning;
        }
        model = recoveredModel;
        model.indexes = Array.isArray(model.indexes) ? model.indexes : [];
        model.foreignKeys = Array.isArray(model.foreignKeys) ? model.foreignKeys : [];
        model.constraints = Array.isArray(model.constraints) ? model.constraints : [];
        original = restoreState.original ? JSON.parse(JSON.stringify(restoreState.original)) : null;
        tableNameInput.value = model.table || '';
        renderColumns();
        renderIndexes();
        renderForeignKeys();
        renderConstraints();
        dirty = restoreDirty;
        tab.setDirty(dirty);
        refreshPreview();
      } else if (isNew) {
        model = { table: '', comment: '', options: '', columns: [], indexes: [], foreignKeys: [], constraints: [] };
        original = null;
        addColumn();
        renderIndexes();
        renderForeignKeys();
        renderConstraints();
        dirty = false;
        tab.setDirty(false);
      } else {
        // A clean existing design is only navigation state, not a draft. Read
        // the live catalog so a stale cached model is never presented as current.
        await loadExisting();
      }
      return true;
    } catch (e) {
      pane.innerHTML = '';
      pane.append(el('div', { class: 'obj-placeholder' }, '加载失败: ' + e.message));
      return false;
    }
  })();

  return tab;
}
