// DBA 工具界面：数据传输 / 转储 SQL 文件 / 运行 SQL 文件
import { el } from './util.js';
import { openModal, toast, confirmDialog } from './toast.js';
import { state, emit, connLabel, objectsCacheKey } from './state.js';
import { authorizeOperation } from './danger.js';
import { startTask } from './taskCenter.js';
import { hasCap } from './dbTypes.js';

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
    const isPg = hasCap(connTypeOf(connSel.value), 'schemas');
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
    // 同时登记到任务中心：对话框关掉后，任务在主进程照样跑，状态栏还能看到
    const task = startTask({ title: '数据传输', kind: 'transfer', connName: connLabel(dstConn.value) });
    const off = window.api.dba.onProgress((p) => {
      if (p.taskId) return;
      if (p.tablesTotal) fill.style.width = Math.round((p.tablesDone / p.tablesTotal) * 100) + '%';
      text.textContent = `[${p.tablesDone}/${p.tablesTotal}] ${p.table || ''} — ${p.phase}${p.rows ? ` (${p.rows.toLocaleString()} 行)` : ''}`;
      task.progress(text.textContent, p.tablesTotal ? (p.tablesDone / p.tablesTotal) * 100 : undefined);
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
      task.done(msg.split('\n')[0]);
      emit('objects-changed', { connId: dstConn.value, db: dstDb.value, schema: dstSchema.value || null });
    } catch (e) {
      toast.error('传输失败：\n' + e.message, 15000);
      text.textContent = '失败：' + e.message;
      task.fail(e);
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
    const task = startTask({ title: '转储 SQL 文件', kind: 'dump', connName: connLabel(target.connId) });
    const off = window.api.dba.onProgress((p) => {
      if (p.taskId) return;
      if (p.tablesTotal) fill.style.width = Math.round((p.tablesDone / p.tablesTotal) * 100) + '%';
      text.textContent = `[${p.tablesDone}/${p.tablesTotal}] ${p.table || ''} — ${p.phase}${p.rows ? ` (${p.rows.toLocaleString()} 行)` : ''}`;
      task.progress(text.textContent, p.tablesTotal ? (p.tablesDone / p.tablesTotal) * 100 : undefined);
    });
    try {
      const r = await window.api.dba.dump(target.connId, approvedDump);
      const mode = chkData.checked ? '结构和数据' : '仅结构';
      toast.success(`转储完成（${mode}）：${r.tables} 个表，${r.rows.toLocaleString()} 行\n${r.file}`, 8000);
      text.textContent = `完成（${mode}）：${r.tables} 个表，${r.rows.toLocaleString()} 行`;
      task.done(text.textContent);
    } catch (e) {
      toast.error('转储失败：\n' + e.message, 15000);
      text.textContent = '失败：' + e.message;
      task.fail(e);
    } finally {
      off();
      running = false;
    }
  }
}

// ---------------- 运行 SQL 文件 ----------------
export async function openRunSqlFileDialog(target, options = {}) {
  const file = options.file || await window.api.dlg.openFile({
    title: '选择 SQL 文件',
    filters: [{ name: 'SQL 文件', extensions: ['sql', 'txt'] }, { name: '所有文件', extensions: ['*'] }],
  });
  if (!file) return;

  const encSel = el('select', {},
    el('option', { value: 'utf-8' }, 'UTF-8'),
    el('option', { value: 'gbk' }, 'GBK / GB2312'));
  const chkContinue = el('input', { type: 'checkbox' });
  const transactionName = `sql-file-transaction-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const txAuto = el('input', { type: 'radio', name: transactionName, value: 'auto' });
  const txSingle = el('input', { type: 'radio', name: transactionName, value: 'single' });
  txAuto.checked = true;
  const conn = state.connections.find((item) => item.id === target.connId);
  const transactionSupported = !conn || hasCap(conn.type, 'transactions');
  txSingle.disabled = !transactionSupported;
  const transactionNote = el('div', {
    style: { color: 'var(--text-muted)', fontSize: '12px' },
  }, transactionSupported
    ? '单一事务：遇到错误或停止时回滚；MySQL / Oracle 的部分 DDL 仍可能按数据库规则隐式提交。'
    : 'ClickHouse 当前连接模式不支持跨语句事务，只能使用自动提交。');
  const syncTransactionOptions = () => {
    const single = txSingle.checked;
    if (single) chkContinue.checked = false;
    chkContinue.disabled = single;
    chkContinue.parentElement.title = single ? '单一事务遇错必须停止并回滚' : '';
  };
  txAuto.addEventListener('change', syncTransactionOptions);
  txSingle.addEventListener('change', syncTransactionOptions);

  const { bar, text, fill } = progressBarPair();
  const logEl = el('textarea', {
    class: 'sql-file-log',
    readOnly: true,
    spellcheck: false,
    'aria-label': 'SQL 文件执行日志',
  });
  const logLines = [];
  let running = false;
  let preparing = false;
  let stopping = false;
  let activeTaskId = null;
  let modal;
  let closeBtn;
  let copyBtn;
  let saveBtn;
  let stopBtn;
  let runBtn;

  modal = openModal({
    title: `运行 SQL 文件 — ${connLabel(target.connId)}${target.db ? ' › ' + target.db : ''}${target.schema ? ' › ' + target.schema : ''}`,
    width: 760,
    body: el('div', { class: 'sql-file-runner' },
      el('div', { style: { fontSize: '12.5px', wordBreak: 'break-all' } }, el('b', {}, '文件: '), file),
      el('div', { class: 'sql-file-options' },
        el('span', { style: { color: 'var(--text-muted)', fontSize: '12.5px' } }, '编码:'), encSel,
        el('label', { class: 'form-check' }, chkContinue, '出错继续')),
      el('div', { class: 'sql-file-transaction' },
        el('span', { style: { color: 'var(--text-muted)', fontSize: '12.5px' } }, '事务方式:'),
        el('label', { class: 'form-check' }, txAuto, '自动提交'),
        el('label', { class: 'form-check' }, txSingle, '单一事务')),
      transactionNote,
      bar,
      text,
      el('div', { class: 'sql-file-log-label' }, '执行日志'),
      logEl),
    buttons: [
      { label: '关闭', onClick: () => !(running || preparing) },
      { label: '复制日志', onClick: () => { copyLog(); return false; } },
      { label: '保存日志…', onClick: () => { saveLog(); return false; } },
      { label: '停止', onClick: () => { stop(); return false; } },
      { label: '开始', primary: true, onClick: () => { run(); return false; } },
    ],
  });
  [closeBtn, copyBtn, saveBtn, stopBtn, runBtn] = [...modal.overlay.querySelectorAll('.modal-foot .btn')];
  stopBtn.disabled = true;
  copyBtn.disabled = true;
  saveBtn.disabled = true;
  syncTransactionOptions();

  function appendLog(line) {
    logLines.push(line);
    logEl.value = logLines.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
    copyBtn.disabled = false;
    saveBtn.disabled = false;
  }

  function formatLogEntry(entry, total) {
    const stateLabel = entry.status === 'success' ? '成功'
      : (entry.status === 'cancelled' ? '停止' : '失败');
    const detail = `[${entry.index}/${total}] ${stateLabel} · ${entry.ms} ms · ${entry.sql}`;
    return entry.error ? `${detail}\n    ${entry.error}` : detail;
  }

  async function copyLog() {
    if (!logLines.length) return;
    try {
      await navigator.clipboard.writeText(logLines.join('\n'));
      toast.success('执行日志已复制');
    } catch (error) {
      toast.error(`复制日志失败：${error.message}`);
    }
  }

  async function saveLog() {
    if (!logLines.length) return;
    const now = new Date().toISOString().replace(/[:.]/g, '-');
    const output = await window.api.dlg.saveFile({
      title: '保存 SQL 文件执行日志',
      defaultPath: `SQL执行日志-${now}.txt`,
      filters: [{ name: '文本文件', extensions: ['txt', 'log'] }],
    });
    if (!output) return;
    await window.api.file.write(output, logLines.join('\r\n') + '\r\n');
    toast.success('执行日志已保存');
  }

  async function stop() {
    if (!running || !activeTaskId || stopping) return;
    stopping = true;
    stopBtn.disabled = true;
    text.textContent = '正在停止；当前数据库语句可能需要等待服务器响应…';
    appendLog(`${new Date().toLocaleString()} 用户请求停止执行`);
    try {
      const result = await window.api.dba.cancelSqlFile(target.connId, activeTaskId);
      if (result && result.driverCancelled === false) {
        text.textContent = '已停止后续语句；当前驱动无法中断正在执行的语句，正在等待其返回…';
      }
    } catch (error) {
      stopping = false;
      if (running) stopBtn.disabled = false;
      toast.error(`停止失败：${error.message}`);
    }
  }

  async function run() {
    if (running || preparing) return;
    preparing = true;
    runBtn.disabled = true;
    activeTaskId = `sql-file-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const transactionMode = txSingle.checked ? 'single' : 'auto';
    const sqlFilePayload = {
      connId: target.connId,
      db: target.db || null,
      schema: target.schema || null,
      file,
      encoding: encSel.value,
      stopOnError: !chkContinue.checked,
      transactionMode,
      taskId: activeTaskId,
    };
    let approvedFile;
    try {
      approvedFile = await authorizeOperation('dba.runSqlFile', sqlFilePayload);
    } catch (e) {
      toast.error('生产库安全检查失败：' + e.message);
      preparing = false;
      activeTaskId = null;
      runBtn.disabled = false;
      return;
    }
    if (!approvedFile) {
      preparing = false;
      activeTaskId = null;
      runBtn.disabled = false;
      return;
    }
    preparing = false;
    running = true;
    stopping = false;
    logLines.length = 0;
    logEl.value = '';
    appendLog(`${new Date().toLocaleString()} 开始执行 SQL 文件`);
    appendLog(`目标：${connLabel(target.connId)}${target.db ? ' › ' + target.db : ''}${target.schema ? ' › ' + target.schema : ''}`);
    appendLog(`文件：${file}`);
    appendLog(`编码：${encSel.value.toUpperCase()}；事务：${transactionMode === 'single' ? '单一事务' : '自动提交'}；错误处理：${sqlFilePayload.stopOnError ? '遇错停止' : '出错继续'}`);
    appendLog('');
    bar.style.display = '';
    fill.style.width = '0%';
    runBtn.disabled = true;
    stopBtn.disabled = false;
    encSel.disabled = true;
    chkContinue.disabled = true;
    txAuto.disabled = true;
    txSingle.disabled = true;
    const seenLogs = new Set();
    // SQL 文件执行是少数支持中途取消的任务，把取消能力一并交给任务中心
    const task = startTask({
      title: '运行 SQL 文件', kind: 'sqlfile', connName: connLabel(target.connId), detail: file,
      cancel: () => window.api.dba.cancelSqlFile(target.connId, activeTaskId),
    });
    const off = window.api.dba.onProgress((p) => {
      if (p.total) fill.style.width = Math.round((p.done / p.total) * 100) + '%';
      text.textContent = `${p.phase || '执行'}：${p.done} / ${p.total} 条语句`;
      task.progress(text.textContent, p.total ? (p.done / p.total) * 100 : undefined);
      if (p.log) {
        const key = `${p.log.index}:${p.log.status}`;
        if (!seenLogs.has(key)) {
          seenLogs.add(key);
          appendLog(formatLogEntry(p.log, p.total));
        }
      }
    }, activeTaskId);
    try {
      const r = await window.api.dba.runSqlFile(target.connId, approvedFile);
      for (const entry of r.logs || []) {
        const key = `${entry.index}:${entry.status}`;
        if (!seenLogs.has(key)) appendLog(formatLogEntry(entry, r.total));
      }
      let msg;
      if (r.cancelled) {
        const outcome = r.rollbackUnconfirmed
          ? '；事务会话已隔离，回滚结果未确认'
          : (r.rolledBack ? '；本次事务已回滚' : '；自动提交下已成功的语句可能已经生效');
        msg = `执行已停止：成功 ${r.executed}/${r.total} 条${outcome} · ${r.ms} ms`;
      } else if (r.failed) {
        const outcome = r.rollbackUnconfirmed
          ? '；事务会话已隔离，回滚结果未确认'
          : (r.rolledBack ? '；本次事务已回滚' : '');
        msg = `${r.stoppedOnError ? '执行因错误停止' : '执行完成'}：成功 ${r.executed}/${r.total} 条，失败 ${r.failed} 条${outcome} · ${r.ms} ms`;
      } else {
        msg = `执行完成：成功 ${r.executed}/${r.total} 条${r.committed ? '；事务已提交' : ''} · ${r.ms} ms`;
      }
      appendLog('');
      appendLog(msg);
      if (r.cancelled) toast.info(msg, 8000);
      else (r.failed ? toast.error : toast.success)(msg, r.failed ? 15000 : 6000);
      text.textContent = msg;
      if (r.cancelled) task.cancelled(msg);
      else task.done(msg);
      emit('objects-changed', { connId: target.connId, db: target.db, schema: target.schema || null });
    } catch (e) {
      toast.error('执行失败：\n' + e.message, 15000);
      text.textContent = '失败：' + e.message;
      appendLog('');
      appendLog(`执行失败：${e.message}`);
      task.fail(e);
    } finally {
      off();
      preparing = false;
      running = false;
      stopping = false;
      activeTaskId = null;
      closeBtn.disabled = false;
      runBtn.disabled = false;
      stopBtn.disabled = true;
      encSel.disabled = false;
      txAuto.disabled = false;
      txSingle.disabled = !transactionSupported;
      syncTransactionOptions();
    }
  }
}
