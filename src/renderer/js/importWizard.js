// 数据导入向导：选择文件 → 解析选项/预览 → 目标与字段映射 → 执行
import { el } from './util.js';
import { openModal, toast } from './toast.js';
import { state, emit, objectsCacheKey } from './state.js';
import { authorizeOperation } from './danger.js';

export async function openImportWizard(target) {
  // target: {connId, db, schema, table?}
  if (!target || !state.open.has(target.connId)) { toast.info('请先打开一个连接'); return; }

  const file = await window.api.dlg.openFile({
    title: '选择要导入的文件',
    filters: [
      { name: '支持的文件', extensions: ['csv', 'txt', 'tsv', 'json', 'xlsx'] },
      { name: 'CSV / 文本', extensions: ['csv', 'txt', 'tsv'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'Excel', extensions: ['xlsx'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (!file) return;
  const ext = file.split('.').pop().toLowerCase();
  const format = ext === 'json' ? 'json' : ext === 'xlsx' ? 'xlsx' : 'csv';

  // ---------- 解析参数控件 ----------
  const delimSel = el('select', {},
    el('option', { value: ',' }, '逗号 ,'),
    el('option', { value: ';' }, '分号 ;'),
    el('option', { value: '\\t' }, 'Tab 制表符'),
    el('option', { value: '|' }, '竖线 |'));
  if (ext === 'tsv') delimSel.value = '\\t';
  const encSel = el('select', {},
    el('option', { value: 'utf-8' }, 'UTF-8'),
    el('option', { value: 'gbk' }, 'GBK / GB2312'));
  const headerChk = el('input', { type: 'checkbox' });
  headerChk.checked = true;
  const sheetSel = el('select', { style: { minWidth: '120px' } });

  // ---------- 目标控件 ----------
  const oc = state.open.get(target.connId);
  const cacheKey = objectsCacheKey(target.db, target.schema);
  let tableNames = [];
  try {
    let objs = oc.objectsCache.get(cacheKey);
    if (!objs) {
      objs = await window.api.db.objects(target.connId, target.db, target.schema);
      oc.objectsCache.set(cacheKey, objs);
    }
    tableNames = objs.tables.map((t) => t.name);
  } catch (e) { /* ignore */ }

  const modeSel = el('select', {},
    el('option', { value: 'existing' }, '导入到现有表'),
    el('option', { value: 'new' }, '创建新表'));
  const tableSel = el('select', { style: { minWidth: '160px' } },
    ...tableNames.map((n) => el('option', { value: n, selected: n === target.table ? 'selected' : null }, n)));
  if (target.table && tableNames.includes(target.table)) tableSel.value = target.table;
  const newNameInput = el('input', { type: 'text', placeholder: '新表名', style: { width: '160px', display: 'none' } });
  modeSel.addEventListener('change', () => {
    const isNew = modeSel.value === 'new';
    tableSel.style.display = isNew ? 'none' : '';
    newNameInput.style.display = isNew ? '' : 'none';
    refreshMapping();
  });
  if (!tableNames.length) { modeSel.value = 'new'; tableSel.style.display = 'none'; newNameInput.style.display = ''; }

  // ---------- 选项 ----------
  const emptyNullChk = el('input', { type: 'checkbox' }); emptyNullChk.checked = true;
  const truncateChk = el('input', { type: 'checkbox' });
  const errorSel = el('select', {},
    el('option', { value: 'abort' }, '终止导入'),
    el('option', { value: 'skip' }, '跳过错误行'));

  // ---------- 预览 / 映射区域 ----------
  const previewBox = el('div', { style: { maxHeight: '160px', overflow: 'auto', border: '1px solid var(--border-light)', borderRadius: '6px' } });
  const mapBox = el('div', { style: { maxHeight: '200px', overflow: 'auto', border: '1px solid var(--border-light)', borderRadius: '6px' } });
  const statusLine = el('div', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, '');

  let parsed = null;       // {columns, rows(preview), totalRows, sheets}
  let targetCols = [];     // 现有表的列信息 [{name,type}]
  let mapSelects = [];     // 每个目标列一个 select

  const parseOpts = () => ({
    file, format,
    delimiter: delimSel.value,
    encoding: encSel.value,
    headerRow: headerChk.checked,
    sheet: sheetSel.value || undefined,
  });

  async function reparse() {
    statusLine.textContent = '解析中…';
    try {
      parsed = await window.api.imp.parse({ ...parseOpts(), preview: 30 });
      if (parsed.sheets && !sheetSel.childElementCount) {
        for (const s of parsed.sheets) sheetSel.append(el('option', { value: s }, s));
      }
      statusLine.textContent = `共 ${parsed.totalRows.toLocaleString()} 行 · ${parsed.columns.length} 列（下方预览前 ${Math.min(30, parsed.rows.length)} 行）`;
      renderPreview();
      await refreshMapping();
    } catch (e) {
      statusLine.textContent = '';
      previewBox.innerHTML = '';
      previewBox.append(el('div', { style: { padding: '14px', color: 'var(--danger)' } }, '解析失败: ' + e.message));
    }
  }

  function renderPreview() {
    previewBox.innerHTML = '';
    const t = el('table', { class: 'obj-table', style: { fontSize: '12px' } });
    t.append(el('thead', {}, el('tr', {}, ...parsed.columns.map((c) => el('th', {}, c)))));
    const tb = el('tbody');
    for (const r of parsed.rows.slice(0, 30)) {
      tb.append(el('tr', {}, ...r.map((v) => el('td', { style: { maxWidth: '160px' } },
        v === null || v === undefined ? '' : String(v).slice(0, 80)))));
    }
    t.append(tb);
    previewBox.append(t);
  }

  async function refreshMapping() {
    mapBox.innerHTML = '';
    mapSelects = [];
    if (!parsed) return;
    const isNew = modeSel.value === 'new';
    if (isNew) {
      mapBox.append(el('div', { style: { padding: '10px', fontSize: '12.5px', color: 'var(--text-muted)' } },
        `将按文件列名创建新表（全部为文本类型，可后续在设计器中调整），共 ${parsed.columns.length} 列。`));
      return;
    }
    const tableName = tableSel.value;
    if (!tableName) return;
    try {
      const info = await window.api.db.tableInfo(target.connId, { db: target.db, schema: target.schema, table: tableName });
      targetCols = info.columns;
    } catch (e) {
      mapBox.append(el('div', { style: { padding: '10px', color: 'var(--danger)' } }, '读取目标表结构失败: ' + e.message));
      return;
    }
    const t = el('table', { class: 'obj-table', style: { fontSize: '12.5px' } });
    t.append(el('thead', {}, el('tr', {},
      el('th', { style: { width: '40%' } }, '目标栏位'),
      el('th', {}, '来源列'))));
    const tb = el('tbody');
    const lowerSrc = parsed.columns.map((c) => String(c).toLowerCase());
    for (const tc of targetCols) {
      const sel = el('select', { style: { width: '95%' } }, el('option', { value: '-1' }, '〈忽略〉'));
      parsed.columns.forEach((sc, i) => sel.append(el('option', { value: String(i) }, sc)));
      const hit = lowerSrc.indexOf(String(tc.name).toLowerCase());
      sel.value = String(hit);
      mapSelects.push({ target: tc.name, sel });
      tb.append(el('tr', {},
        el('td', {}, `${tc.name}  `, el('span', { style: { color: 'var(--text-muted)', fontSize: '11px' } }, tc.type || '')),
        el('td', {}, sel)));
    }
    t.append(tb);
    mapBox.append(t);
  }

  tableSel.addEventListener('change', refreshMapping);
  delimSel.addEventListener('change', reparse);
  encSel.addEventListener('change', reparse);
  headerChk.addEventListener('change', reparse);
  sheetSel.addEventListener('change', reparse);

  // ---------- 布局 ----------
  const optRow = (label, ...ctrl) => el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
    el('span', { style: { color: 'var(--text-muted)', fontSize: '12.5px', minWidth: '64px', textAlign: 'right' } }, label), ...ctrl);

  const parseRow = el('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } });
  if (format === 'csv') {
    parseRow.append(optRow('分隔符', delimSel), optRow('编码', encSel),
      el('label', { class: 'form-check' }, headerChk, '首行为字段名'));
  } else if (format === 'json') {
    parseRow.append(optRow('编码', encSel));
  } else {
    parseRow.append(optRow('工作表', sheetSel), el('label', { class: 'form-check' }, headerChk, '首行为字段名'));
  }

  const progressBar = el('div', { style: { height: '6px', borderRadius: '3px', background: 'var(--border-light)', overflow: 'hidden', display: 'none' } },
    el('div', { style: { height: '100%', width: '0%', background: 'var(--accent)', transition: 'width .15s' } }));
  const progressText = el('div', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, '');

  const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', width: '640px', maxWidth: '80vw' } },
    el('div', { style: { fontSize: '12.5px' } },
      el('b', {}, '文件: '), file,
      el('span', { style: { color: 'var(--text-muted)' } }, `　(${format.toUpperCase()})`)),
    parseRow,
    statusLine,
    previewBox,
    el('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
      optRow('目标', modeSel, tableSel, newNameInput)),
    mapBox,
    el('div', { style: { display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } },
      el('label', { class: 'form-check' }, emptyNullChk, '空字符串视为 NULL'),
      el('label', { class: 'form-check' }, truncateChk, '导入前清空目标表'),
      optRow('出错时', errorSel)),
    progressBar, progressText,
  );

  let running = false;
  const m = openModal({
    title: '导入向导',
    body,
    buttons: [
      { label: '取消', onClick: () => !running },
      {
        label: '开始导入', primary: true,
        onClick: () => { runImport(); return false; },
      },
    ],
  });

  async function runImport() {
    if (running || !parsed) return;
    const isNew = modeSel.value === 'new';
    let tableName = isNew ? newNameInput.value.trim() : tableSel.value;
    if (!tableName) { toast.error(isNew ? '请填写新表名' : '请选择目标表'); return; }

    let mapping;
    if (isNew) {
      // 用设计器接口建新表（全部文本列）
      const dialectMeta = await window.api.design.meta(target.connId);
      const textType = { sqlite: 'TEXT', clickhouse: 'String', oracle: 'VARCHAR2', mssql: 'nvarchar' }[dialectMeta.dialect] || 'varchar';
      const len = ['varchar', 'nvarchar', 'VARCHAR2'].includes(textType) ? '255' : '';
      try {
        const createPayload = {
          connId: target.connId,
          db: target.db, schema: target.schema, original: null,
          model: {
            table: tableName, comment: '', options: '',
            columns: parsed.columns.map((c) => ({
              name: String(c).slice(0, 60), origName: null, type: textType, length: len, scale: '',
              notNull: false, pk: false, autoInc: false, def: '', comment: '',
            })),
            indexes: [],
          },
        };
        const approvedCreate = await authorizeOperation('design.apply', createPayload, { title: `在生产库创建导入目标表「${tableName}」` });
        if (!approvedCreate) return;
        await window.api.design.apply(target.connId, approvedCreate);
        emit('objects-changed', { connId: target.connId, db: target.db, schema: target.schema });
      } catch (e) { toast.error('创建新表失败: ' + e.message); return; }
      mapping = parsed.columns.map((c, i) => ({ target: String(c).slice(0, 60), sourceIndex: i }));
    } else {
      mapping = mapSelects
        .map((x) => ({ target: x.target, sourceIndex: Number(x.sel.value) }))
        .filter((x) => x.sourceIndex >= 0);
      if (!mapping.length) { toast.error('请至少映射一个栏位'); return; }
    }
    const importPayload = {
      connId: target.connId,
      db: target.db, schema: target.schema, table: tableName,
      mapping,
      emptyAsNull: emptyNullChk.checked,
      truncate: truncateChk.checked,
      errorMode: errorSel.value,
      batchSize: 500,
      file,
      parseOpts: parseOpts(),
    };
    let approvedImport;
    try {
      approvedImport = await authorizeOperation('import.run', importPayload, {
        title: `向生产表「${tableName}」导入数据`,
        confirmSafe: truncateChk.checked
          ? async () => {
            const { confirmDialog } = await import('./toast.js');
            return confirmDialog('清空目标表', `确定导入前清空表 “${tableName}” 吗？`, { danger: true, okLabel: '清空并导入' });
          }
          : null,
      });
    } catch (e) {
      toast.error('生产库安全检查失败：' + e.message);
      return;
    }
    if (!approvedImport) return;

    running = true;
    progressBar.style.display = '';
    const fill = progressBar.firstChild;
    const off = window.api.imp.onProgress((p) => {
      fill.style.width = Math.round((p.done / Math.max(p.total, 1)) * 100) + '%';
      progressText.textContent = `已处理 ${p.done.toLocaleString()} / ${p.total.toLocaleString()} 行`;
    });
    try {
      const r = await window.api.imp.run(target.connId, approvedImport);
      let msg = `导入完成：成功 ${r.ok.toLocaleString()} 行`;
      if (r.failed) msg += `，失败 ${r.failed.toLocaleString()} 行\n${(r.errors || []).join('\n')}`;
      (r.failed ? toast.error : toast.success)(msg, r.failed ? 12000 : 5000);
      emit('objects-changed', { connId: target.connId, db: target.db, schema: target.schema });
      m.close();
    } catch (e) {
      toast.error('导入失败：\n' + e.message, 15000);
    } finally {
      off();
      running = false;
    }
  }

  await reparse();
}
