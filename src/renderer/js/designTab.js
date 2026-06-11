// 可视化表设计器：栏位 / 索引 / SQL 预览，支持新建表与修改表
import { el, iconEl, debounce } from './util.js';
import { connLabel, emit } from './state.js';
import { addTab, uid } from './tabs.js';
import { toast, confirmDialog } from './toast.js';

/**
 * target: {connId, db, schema, table?}  table 为空 = 新建表
 */
export function openDesignTab(target) {
  const isNew = !target.table;
  const tabId = isNew ? uid('design-new') : `design:${target.connId}|${target.db}|${target.schema || ''}|${target.table}`;
  const tab = addTab({
    id: tabId,
    title: isNew ? '新建表' : `设计 - ${target.table}`,
    icon: 'struct',
    tooltip: `${connLabel(target.connId)} / ${target.db || ''}`,
  });
  if (tab.pane.childElementCount) return tab;

  let meta = null;        // {dialect, types, caps}
  let original = null;    // 修改表时的原始模型
  let model = null;       // 当前编辑模型
  let dirty = false;
  let selColIdx = -1;
  let selIxIdx = -1;

  const pane = tab.pane;
  pane.classList.add('design-pane');

  // ---------- 工具栏 ----------
  const btnSave = el('button', { class: 'pbtn success', onClick: save }, iconEl('save'), '保存');
  const btnAddCol = el('button', { class: 'pbtn', onClick: () => { addColumn(); } }, iconEl('plus'), '添加栏位');
  const btnDelCol = el('button', { class: 'pbtn', onClick: removeColumn }, iconEl('minus'), '删除栏位');
  const btnUp = el('button', { class: 'pbtn', onClick: () => moveColumn(-1) }, '▲ 上移');
  const btnDown = el('button', { class: 'pbtn', onClick: () => moveColumn(1) }, '▼ 下移');
  const tableNameInput = el('input', { type: 'text', placeholder: '表名', style: { width: '180px', fontWeight: '600' } });
  const toolbar = el('div', { class: 'pane-toolbar' },
    btnSave, el('span', { class: 'sep' }),
    el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '表名:'), tableNameInput,
    el('span', { class: 'sep' }),
    btnAddCol, btnDelCol, btnUp, btnDown,
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
  // SQL 预览页
  const previewBox = el('div', { class: 'ddl-box', style: { margin: '10px', flex: '1', overflow: 'auto', whiteSpace: 'pre' } }, '');
  const warnBox = el('div', { style: { margin: '0 10px 10px', color: 'var(--orange)', fontSize: '12px', whiteSpace: 'pre-wrap' } }, '');
  const previewPage = el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } }, previewBox, warnBox);

  addPage('栏位', colsPage);
  addPage('索引', ixPage);
  addPage('SQL 预览', previewPage);

  pane.append(toolbar, subTabs, subBody);
  activatePage(0);

  tab.setIsDirty(() => dirty);

  function markDirty() {
    dirty = true;
    tab.setDirty(true);
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
      const tr = el('tr', { 'data-i': i });
      if (i === selColIdx) tr.classList.add('selected');
      tr.addEventListener('mousedown', (e) => {
        selColIdx = i;
        for (const x of tb.querySelectorAll('tr')) x.classList.toggle('selected', Number(x.dataset.i) === i);
      });
      tr.append(
        el('td', { style: { textAlign: 'center' } }, cellCheck(c.pk, (v) => { c.pk = v; })),
        el('td', {}, cellInput(c.name, (v) => { c.name = v.trim(); })),
        el('td', {}, cellInput(c.type, (v) => { c.type = v.trim(); }, { list: 'design-types' })),
        el('td', {}, cellInput(c.length, (v) => { c.length = v.trim(); })),
        el('td', {}, cellInput(c.scale, (v) => { c.scale = v.trim(); })),
        el('td', { style: { textAlign: 'center' } }, cellCheck(c.notNull, (v) => { c.notNull = v; })),
        cap.autoInc ? el('td', { style: { textAlign: 'center' } }, cellCheck(c.autoInc, (v) => { c.autoInc = v; })) : null,
        el('td', {}, cellInput(c.def, (v) => { c.def = v; })),
        el('td', {}, cellInput(c.comment, (v) => { c.comment = v; }, cap.comments ? {} : { attrs: { placeholder: '（该库不支持）' } })),
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
    model.columns.splice(selColIdx, 1);
    selColIdx = Math.min(selColIdx, model.columns.length - 1);
    renderColumns();
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

  // ---------- SQL 预览 / 保存 ----------
  async function refreshPreview() {
    if (!model) return;
    try {
      const r = await window.api.design.ddl(target.connId, {
        db: target.db, schema: target.schema, original, model,
      });
      previewBox.textContent = r.sqls.length ? r.sqls.map((s) => s + ';').join('\n\n') : '-- （没有需要执行的变更）';
      warnBox.textContent = r.warnings.length ? '⚠ ' + r.warnings.join('\n⚠ ') : '';
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
    const ok = await confirmDialog(isNew ? '创建表' : '保存表结构',
      `将执行 ${preview.sqls.length} 条语句：\n\n${preview.sqls.map((s) => s + ';').join('\n')}` +
      (preview.warnings.length ? `\n\n⚠ ${preview.warnings.join('\n⚠ ')}` : ''),
      { okLabel: '执行' });
    if (!ok) return;
    try {
      const r = await window.api.design.apply(target.connId, { db: target.db, schema: target.schema, original, model });
      toast.success(`已执行 ${r.executed} 条语句`);
      emit('objects-changed', { connId: target.connId, db: target.db, schema: target.schema });
      // 重新加载为编辑模式
      target.table = model.table;
      tab.setTitle(`设计 - ${target.table}`);
      await loadExisting();
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
    refreshPreview();
  }

  (async () => {
    try {
      meta = await window.api.design.meta(target.connId);
      // 类型 datalist（全局唯一即可）
      let dl = document.getElementById('design-types');
      if (!dl) { dl = el('datalist', { id: 'design-types' }); document.body.append(dl); }
      dl.innerHTML = '';
      for (const t of meta.types) dl.append(el('option', { value: t }));

      if (isNew) {
        model = { table: '', comment: '', options: '', columns: [], indexes: [] };
        original = null;
        addColumn();
        dirty = false;
        tab.setDirty(false);
      } else {
        await loadExisting();
      }
    } catch (e) {
      pane.innerHTML = '';
      pane.append(el('div', { class: 'obj-placeholder' }, '加载失败: ' + e.message));
    }
  })();

  return tab;
}
