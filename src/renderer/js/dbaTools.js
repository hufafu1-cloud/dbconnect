// DBA 工具界面：数据传输 / 转储 SQL 文件 / 运行 SQL 文件
import { el } from './util.js';
import { openModal, toast, confirmDialog } from './toast.js';
import { state, emit, connLabel, objectsCacheKey } from './state.js';
import { authorizeOperation } from './danger.js';

function openConnsOptions(selected) {
  return [...state.open.keys()].map((id) =>
    el('option', { value: id, selected: id === selected ? 'selected' : null }, connLabel(id)));
}

function progressBarPair() {
  const bar = el('div', { style: { height: '6px', borderRadius: '3px', background: 'var(--border-light)', overflow: 'hidden', display: 'none' } },
    el('div', { style: { height: '100%', width: '0%', background: 'var(--accent)', transition: 'width .15s' } }));
  const text = el('div', { style: { fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', maxHeight: '90px', overflow: 'auto' } }, '');
  return { bar, text, fill: bar.firstChild };
}

async function loadDbs(connId) {
  const oc = state.open.get(connId);
  return (oc && oc.databases) || [];
}

async function loadTables(connId, db, schema) {
  const oc = state.open.get(connId);
  const key = objectsCacheKey(db, schema);
  let objs = oc && oc.objectsCache.get(key);
  if (!objs) {
    objs = await window.api.db.objects(connId, db, schema);
    if (oc) oc.objectsCache.set(key, objs);
  }
  return objs.tables;
}

function connTypeOf(connId) {
  const c = state.connections.find((x) => x.id === connId);
  return c ? c.type : null;
}

// ---------------- 数据传输 ----------------
export async function openTransferDialog(preset) {
  if (state.open.size < 1) { toast.info('请先打开连接'); return; }
  let running = false;

  // 源/目标各占一行：连接定宽、库自适应、模式定宽，避免长库名挤压换行
  const selStyles = {
    conn: { width: '170px', flex: '0 0 170px' },
    db: { flex: '1 1 auto', minWidth: '0' },
    schema: { width: '120px', flex: '0 0 120px', display: 'none' },
  };
  const srcConn = el('select', { style: selStyles.conn }, ...openConnsOptions(preset && preset.connId));
  const srcDb = el('select', { style: selStyles.db });
  const srcSchema = el('select', { style: { ...selStyles.schema } });
  const dstConn = el('select', { style: selStyles.conn }, ...openConnsOptions());
  const dstDb = el('select', { style: selStyles.db });
  const dstSchema = el('select', { style: { ...selStyles.schema } });

  const tablesBox = el('div', { style: { maxHeight: '180px', overflow: 'auto', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '6px 10px' } });
  const filterInput = el('input', { type: 'text', placeholder: '过滤表名…', style: { width: '140px' } });
  let tableChecks = [];

  const chkCreate = el('input', { type: 'checkbox' }); chkCreate.checked = true;
  const chkDrop = el('input', { type: 'checkbox' });
  const chkData = el('input', { type: 'checkbox' }); chkData.checked = true;
  const chkContinue = el('input', { type: 'checkbox' });

  const { bar, text, fill } = progressBarPair();
  const preflight = el('div', { class: 'transfer-preflight' });

  function endpointLabel(connSel, dbSel, schemaSel) {
    const schema = schemaSel.value ? ` / ${schemaSel.value}` : '';
    return `${connLabel(connSel.value)} / ${dbSel.value || '未选择数据库'}${schema}`;
  }
  function updatePreflight() {
    const picked = tableChecks.filter((x) => x.cb.checked);
    const knownRows = picked.reduce((sum, x) => sum + (Number.isFinite(x.table.rows) ? x.table.rows : 0), 0);
    const unknownRows = picked.some((x) => !Number.isFinite(x.table.rows));
    preflight.innerHTML = '';
    preflight.append(
      el('span', { class: 'transfer-endpoint source' }, endpointLabel(srcConn, srcDb, srcSchema)),
      el('span', { class: 'transfer-arrow' }, '→'),
      el('span', { class: 'transfer-endpoint target' }, endpointLabel(dstConn, dstDb, dstSchema)),
      el('span', { class: 'transfer-summary' }, `已选 ${picked.length} 张表 · ${unknownRows ? `至少 ${knownRows.toLocaleString()}` : knownRows.toLocaleString()} 行`),
    );
  }

  async function fillDbSel(connSel, dbSel, schemaSel, presetDb) {
    const dbs = await loadDbs(connSel.value);
    dbSel.innerHTML = '';
    for (const d of dbs) dbSel.append(el('option', { value: d, selected: d === presetDb ? 'selected' : null }, d));
    if (presetDb && dbs.includes(presetDb)) dbSel.value = presetDb;
    await fillSchemaSel(connSel, dbSel, schemaSel);
  }
  async function fillSchemaSel(connSel, dbSel, schemaSel) {
    const isPg = connTypeOf(connSel.value) === 'postgres';
    schemaSel.style.display = isPg ? '' : 'none';
    schemaSel.innerHTML = '';
    if (isPg && dbSel.value) {
      try {
        const schemas = await window.api.db.schemas(connSel.value, dbSel.value);
        for (const s of schemas) schemaSel.append(el('option', { value: s, selected: s === 'public' ? 'selected' : null }, s));
      } catch (e) { /* ignore */ }
    }
  }

  async function refreshTables() {
    tablesBox.innerHTML = '加载中…';
    tableChecks = [];
    try {
      const tables = await loadTables(srcConn.value, srcDb.value, srcSchema.value || undefined);
      tablesBox.innerHTML = '';
      if (!tables.length) { tablesBox.append('（该库没有表）'); return; }
      for (const t of tables) {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = true;
        const row = el('label', { class: 'form-check', style: { display: 'flex', padding: '1px 0' } }, cb,
          el('span', {}, (t.schema && t.schema !== 'public' && t.schema !== 'dbo' ? t.schema + '.' : '') + t.name),
          el('span', { style: { color: 'var(--text-muted)', fontSize: '11px', marginLeft: 'auto' } }, t.rows === null || t.rows === undefined ? '' : `${t.rows} 行`));
        tableChecks.push({ cb, table: t, row });
        cb.addEventListener('change', updatePreflight);
        tablesBox.append(row);
      }
      updatePreflight();
    } catch (e) {
      tablesBox.innerHTML = '';
      tablesBox.append('加载失败: ' + e.message);
    }
  }
  filterInput.addEventListener('input', () => {
    const q = filterInput.value.trim().toLowerCase();
    for (const x of tableChecks) x.row.style.display = !q || x.table.name.toLowerCase().includes(q) ? 'flex' : 'none';
  });

  srcConn.addEventListener('change', async () => { await fillDbSel(srcConn, srcDb, srcSchema); await refreshTables(); updatePreflight(); });
  srcDb.addEventListener('change', async () => { await fillSchemaSel(srcConn, srcDb, srcSchema); await refreshTables(); updatePreflight(); });
  srcSchema.addEventListener('change', async () => { await refreshTables(); updatePreflight(); });
  dstConn.addEventListener('change', async () => { await fillDbSel(dstConn, dstDb, dstSchema); updatePreflight(); });
  dstDb.addEventListener('change', async () => { await fillSchemaSel(dstConn, dstDb, dstSchema); updatePreflight(); });

  const lbl = (s) => el('span', { style: { color: 'var(--text-muted)', fontSize: '12.5px' } }, s);
  const pairRow = (label, c, d, s) => el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
    el('span', { style: { color: 'var(--text-muted)', fontSize: '12.5px', flex: '0 0 36px', textAlign: 'right' } }, label),
    c, d, s);
  let transferStage = 1;
  const steps = el('div', { class: 'transfer-steps' },
    el('span', { class: 'active' }, '1 选择来源与目标'), el('span', {}, '2 确认策略并传输'));
  const selectionStage = el('div', { class: 'transfer-stage' },
    pairRow('源:', srcConn, srcDb, srcSchema),
    pairRow('目标:', dstConn, dstDb, dstSchema),
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      lbl('表:'),
      el('button', { class: 'pbtn', onClick: () => { tableChecks.forEach((x) => { x.cb.checked = true; }); updatePreflight(); } }, '全选'),
      el('button', { class: 'pbtn', onClick: () => { tableChecks.forEach((x) => { x.cb.checked = !x.cb.checked; }); updatePreflight(); } }, '反选'),
      el('span', { class: 'spring', style: { flex: '1' } }),
      filterInput),
    tablesBox,
    preflight,
    el('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } },
      el('label', { class: 'form-check' }, chkCreate, '创建表'),
      el('label', { class: 'form-check' }, chkDrop, '先删除已存在的目标表'),
      el('label', { class: 'form-check' }, chkData, '复制数据'),
      el('label', { class: 'form-check' }, chkContinue, '出错继续')),
    bar, text);
  const reviewStage = el('div', { class: 'transfer-review', style: { display: 'none' } });
  const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', width: '620px', maxWidth: '80vw' } },
    steps, selectionStage, reviewStage,
  );

  const m = openModal({
    title: '数据传输',
    body,
    buttons: [
      { label: '关闭', onClick: () => !running },
      { label: '下一步：确认策略', primary: true, onClick: () => {
        if (transferStage === 1) { showReview(); return false; }
        run(); return false;
      } },
    ],
  });

  function showReview() {
    const picked = tableChecks.filter((x) => x.cb.checked);
    if (!picked.length) { toast.error('请至少选择一张表'); return; }
    if (srcConn.value === dstConn.value && srcDb.value === dstDb.value && (srcSchema.value || '') === (dstSchema.value || '')) {
      toast.error('来源与目标相同'); return;
    }
    const rows = picked.reduce((sum, x) => sum + (Number.isFinite(x.table.rows) ? x.table.rows : 0), 0);
    reviewStage.innerHTML = '';
    reviewStage.append(
      el('div', { class: 'transfer-review-title' }, '请核对本次传输'),
      el('div', { class: 'transfer-review-route' },
        el('div', {}, el('small', {}, '来源'), el('b', {}, endpointLabel(srcConn, srcDb, srcSchema))),
        el('span', {}, '→'),
        el('div', {}, el('small', {}, '目标'), el('b', {}, endpointLabel(dstConn, dstDb, dstSchema)))),
      el('div', { class: 'transfer-review-summary' }, `${picked.length} 张表 · 已知约 ${rows.toLocaleString()} 行 · ${chkData.checked ? '复制结构和数据' : '仅复制结构'}`),
      chkDrop.checked ? el('div', { class: 'transfer-review-warning' }, '将覆盖目标中的同名表，原有数据会被删除。') : null);
    selectionStage.style.display = 'none';
    reviewStage.style.display = '';
    transferStage = 2;
    steps.children[0].classList.remove('active');
    steps.children[0].classList.add('done');
    steps.children[1].classList.add('active');
    const primary = [...m.overlay.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.includes('下一步'));
    if (primary) primary.textContent = '开始传输';
  }

  async function run() {
    if (running) return;
    const picked = tableChecks.filter((x) => x.cb.checked).map((x) => ({ name: x.table.name, schema: x.table.schema || null }));
    if (!picked.length) { toast.error('请至少选择一个表'); return; }
    if (srcConn.value === dstConn.value && srcDb.value === dstDb.value && (srcSchema.value || '') === (dstSchema.value || '')) {
      toast.error('源与目标相同'); return;
    }
    const knownRows = tableChecks.filter((x) => x.cb.checked).reduce((sum, x) => sum + (Number.isFinite(x.table.rows) ? x.table.rows : 0), 0);
    const preflightMessage = [
      `来源：${endpointLabel(srcConn, srcDb, srcSchema)}`,
      `目标：${endpointLabel(dstConn, dstDb, dstSchema)}`,
      `内容：${picked.length} 张表，已知约 ${knownRows.toLocaleString()} 行`,
      `策略：${chkCreate.checked ? '创建目标表' : '不创建目标表'}；${chkData.checked ? '复制数据' : '仅复制结构'}${chkDrop.checked ? '；覆盖目标中的同名表' : ''}`,
    ].join('\n');
    const confirmed = await confirmDialog('传输预检查', preflightMessage, {
      danger: chkDrop.checked, okLabel: '确认并继续',
    });
    if (!confirmed) return;
    const transferPayload = {
      srcConnId: srcConn.value, dstConnId: dstConn.value,
      srcDb: srcDb.value, srcSchema: srcSchema.value || null,
      dstDb: dstDb.value, dstSchema: dstSchema.value || null,
      tables: picked,
      createTable: chkCreate.checked, dropExisting: chkDrop.checked,
      copyData: chkData.checked, stopOnError: !chkContinue.checked, batchSize: 500,
    };
    let approvedTransfer;
    try {
      approvedTransfer = await authorizeOperation('dba.transfer', transferPayload, {
        confirmSafe: chkDrop.checked
          ? () => confirmDialog('确认覆盖', `将先删除目标库中同名的 ${picked.length} 个表，确定吗？`, { danger: true, okLabel: '继续' })
          : null,
      });
    } catch (e) {
      toast.error('生产库安全检查失败：' + e.message);
      return;
    }
    if (!approvedTransfer) return;
    running = true;
    bar.style.display = '';
    const off = window.api.dba.onProgress((p) => {
      if (p.tablesTotal) fill.style.width = Math.round((p.tablesDone / p.tablesTotal) * 100) + '%';
      text.textContent = `[${p.tablesDone}/${p.tablesTotal}] ${p.table || ''} — ${p.phase}${p.rows ? ` (${p.rows.toLocaleString()} 行)` : ''}`;
    });
    try {
      const r = await window.api.dba.transfer(approvedTransfer);
      const okTables = r.tables.filter((t) => t.status === 'ok');
      const totalRows = okTables.reduce((a, t) => a + t.rows, 0);
      let msg = `传输完成：${okTables.length}/${r.tables.length} 个表，共 ${totalRows.toLocaleString()} 行`;
      if (r.warnings.length) msg += `\n⚠ ${r.warnings.slice(0, 5).join('\n⚠ ')}${r.warnings.length > 5 ? `\n…共 ${r.warnings.length} 条警告` : ''}`;
      if (r.errors.length) msg += `\n✗ ${r.errors.slice(0, 5).join('\n✗ ')}`;
      (r.errors.length ? toast.error : toast.success)(msg, r.errors.length ? 15000 : 8000);
      text.textContent = msg;
      emit('objects-changed', { connId: dstConn.value, db: dstDb.value, schema: dstSchema.value || null });
    } catch (e) {
      toast.error('传输失败：\n' + e.message, 15000);
      text.textContent = '失败：' + e.message;
    } finally {
      off();
      running = false;
    }
  }

  await fillDbSel(srcConn, srcDb, srcSchema, preset && preset.db);
  await fillDbSel(dstConn, dstDb, dstSchema);
  await refreshTables();
}

// ---------------- 转储 SQL 文件 ----------------
/**
 * 打开 SQL 转储对话框。
 * options.tables 传入时只转储指定表（用于表右键菜单），否则转储当前库/模式下的全部表。
 */
export async function openDumpDialog(target, options = {}) {
  const presetTables = Array.isArray(options.tables) ? options.tables : null;
  const defaultName = options.defaultName || target.db || 'dump';
  const file = await window.api.dlg.saveFile({
    title: '转储 SQL 文件',
    defaultPath: `${defaultName}.sql`,
    filters: [{ name: 'SQL 文件', extensions: ['sql'] }],
  });
  if (!file) return;

  const chkDrop = el('input', { type: 'checkbox' }); chkDrop.checked = true;
  const chkData = el('input', { type: 'checkbox' }); chkData.checked = options.includeData !== false;
  const { bar, text, fill } = progressBarPair();
  let running = false;
  let preparing = false;

  const m = openModal({
    title: `转储 SQL — ${connLabel(target.connId)} › ${target.db || ''}${target.schema ? ' › ' + target.schema : ''}${presetTables && presetTables.length === 1 ? ' › ' + presetTables[0].name : ''}`,
    body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', width: '460px' } },
      el('div', { style: { fontSize: '12.5px' } }, el('b', {}, '输出: '), file),
      el('div', { style: { display: 'flex', gap: '16px' } },
        el('label', { class: 'form-check' }, chkDrop, '包含 DROP TABLE'),
        el('label', { class: 'form-check' }, chkData, '包含数据 (INSERT)')),
      bar, text),
    buttons: [
      { label: '关闭', onClick: () => !running && !preparing },
      { label: '开始转储', primary: true, onClick: () => { run(); return false; } },
    ],
  });

  async function run() {
    if (running || preparing) return;
    preparing = true;
    let approvedDump;
    try {
      const tables = (presetTables || (await loadTables(target.connId, target.db, target.schema)))
        .map((t) => ({ name: t.name, schema: t.schema || null }));
      if (!tables.length) { toast.info('该库没有表'); return; }
      approvedDump = await authorizeOperation('dba.dump', {
        connId: target.connId,
        db: target.db, schema: target.schema || null, tables, file,
        includeDrop: chkDrop.checked, includeData: chkData.checked,
      });
    } catch (e) {
      toast.error('转储安全检查失败：\n' + e.message, 15000);
      text.textContent = '失败：' + e.message;
      return;
    } finally {
      preparing = false;
    }
    if (!approvedDump) return;
    running = true;
    bar.style.display = '';
    const off = window.api.dba.onProgress((p) => {
      if (p.tablesTotal) fill.style.width = Math.round((p.tablesDone / p.tablesTotal) * 100) + '%';
      text.textContent = `[${p.tablesDone}/${p.tablesTotal}] ${p.table || ''} — ${p.phase}${p.rows ? ` (${p.rows.toLocaleString()} 行)` : ''}`;
    });
    try {
      const r = await window.api.dba.dump(target.connId, approvedDump);
      const mode = chkData.checked ? '结构和数据' : '仅结构';
      toast.success(`转储完成（${mode}）：${r.tables} 个表，${r.rows.toLocaleString()} 行\n${r.file}`, 8000);
      text.textContent = `完成（${mode}）：${r.tables} 个表，${r.rows.toLocaleString()} 行`;
    } catch (e) {
      toast.error('转储失败：\n' + e.message, 15000);
      text.textContent = '失败：' + e.message;
    } finally {
      off();
      running = false;
    }
  }
}

// ---------------- 运行 SQL 文件 ----------------
export async function openRunSqlFileDialog(target) {
  const file = await window.api.dlg.openFile({
    title: '选择 SQL 文件',
    filters: [{ name: 'SQL 文件', extensions: ['sql', 'txt'] }, { name: '所有文件', extensions: ['*'] }],
  });
  if (!file) return;

  const encSel = el('select', {},
    el('option', { value: 'utf-8' }, 'UTF-8'),
    el('option', { value: 'gbk' }, 'GBK / GB2312'));
  const chkContinue = el('input', { type: 'checkbox' });
  const { bar, text, fill } = progressBarPair();
  let running = false;

  openModal({
    title: `运行 SQL 文件 — ${connLabel(target.connId)}${target.db ? ' › ' + target.db : ''}`,
    body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', width: '480px' } },
      el('div', { style: { fontSize: '12.5px', wordBreak: 'break-all' } }, el('b', {}, '文件: '), file),
      el('div', { style: { display: 'flex', gap: '16px', alignItems: 'center' } },
        el('span', { style: { color: 'var(--text-muted)', fontSize: '12.5px' } }, '编码:'), encSel,
        el('label', { class: 'form-check' }, chkContinue, '出错继续')),
      bar, text),
    buttons: [
      { label: '关闭', onClick: () => !running },
      { label: '执行', primary: true, onClick: () => { run(); return false; } },
    ],
  });

  async function run() {
    if (running) return;
    const sqlFilePayload = {
      connId: target.connId,
      db: target.db || null, file, encoding: encSel.value, stopOnError: !chkContinue.checked,
    };
    let approvedFile;
    try {
      approvedFile = await authorizeOperation('dba.runSqlFile', sqlFilePayload);
    } catch (e) {
      toast.error('生产库安全检查失败：' + e.message);
      return;
    }
    if (!approvedFile) return;
    running = true;
    bar.style.display = '';
    const off = window.api.dba.onProgress((p) => {
      if (p.total) fill.style.width = Math.round((p.done / p.total) * 100) + '%';
      text.textContent = `已执行 ${p.done} / ${p.total} 条语句`;
    });
    try {
      const r = await window.api.dba.runSqlFile(target.connId, approvedFile);
      let msg = `执行完成：成功 ${r.executed}/${r.total} 条 · ${r.ms} ms`;
      if (r.failed) msg += `\n失败 ${r.failed} 条：\n${r.errors.join('\n')}`;
      (r.failed ? toast.error : toast.success)(msg, r.failed ? 15000 : 6000);
      text.textContent = msg;
      emit('objects-changed', { connId: target.connId, db: target.db, schema: target.schema || null });
    } catch (e) {
      toast.error('执行失败：\n' + e.message, 15000);
      text.textContent = '失败：' + e.message;
    } finally {
      off();
      running = false;
    }
  }
}
