// 结构同步 / 数据同步对话框
import { el } from './util.js';
import { openModal, toast, confirmDialog } from './toast.js';
import { state, emit, connLabel, objectsCacheKey } from './state.js';

function openConnsOptions(selected) {
  return [...state.open.keys()].map((id) =>
    el('option', { value: id, selected: id === selected ? 'selected' : null }, connLabel(id)));
}

function connTypeOf(connId) {
  const c = state.connections.find((x) => x.id === connId);
  return c ? c.type : null;
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

export async function openSyncDialog(preset) {
  if (state.open.size < 1) { toast.info('请先打开连接'); return; }
  const mode = (preset && preset.mode) || 'struct'; // struct | data
  let running = false;
  let diffResult = null; // 结构比对结果

  // ---- 源 / 目标选择（与传输一致的两行布局） ----
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

  async function fillDbSel(connSel, dbSel, schemaSel, presetDb) {
    const oc = state.open.get(connSel.value);
    const dbs = (oc && oc.databases) || [];
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

  // ---- 表选择 ----
  const tablesBox = el('div', { style: { maxHeight: '140px', overflow: 'auto', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '6px 10px' } });
  const filterInput = el('input', { type: 'text', placeholder: '过滤表名…', style: { width: '140px' } });
  let tableChecks = [];
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
          el('span', {}, (t.schema && t.schema !== 'public' && t.schema !== 'dbo' ? t.schema + '.' : '') + t.name));
        tableChecks.push({ cb, table: t, row });
        tablesBox.append(row);
      }
    } catch (e) {
      tablesBox.innerHTML = '';
      tablesBox.append('加载失败: ' + e.message);
    }
  }
  filterInput.addEventListener('input', () => {
    const q = filterInput.value.trim().toLowerCase();
    for (const x of tableChecks) x.row.style.display = !q || x.table.name.toLowerCase().includes(q) ? 'flex' : 'none';
  });
  srcConn.addEventListener('change', async () => { await fillDbSel(srcConn, srcDb, srcSchema); refreshTables(); });
  srcDb.addEventListener('change', async () => { await fillSchemaSel(srcConn, srcDb, srcSchema); refreshTables(); });
  srcSchema.addEventListener('change', refreshTables);
  dstConn.addEventListener('change', () => fillDbSel(dstConn, dstDb, dstSchema));
  dstDb.addEventListener('change', () => fillSchemaSel(dstConn, dstDb, dstSchema));

  // ---- 模式与选项 ----
  const modeStruct = el('input', { type: 'radio', name: 'sync-mode' });
  const modeData = el('input', { type: 'radio', name: 'sync-mode' });
  (mode === 'data' ? modeData : modeStruct).checked = true;

  // 结构选项
  const chkDropCols = el('input', { type: 'checkbox' });
  const chkDropTables = el('input', { type: 'checkbox' });
  const structOpts = el('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } },
    el('label', { class: 'form-check' }, chkDropCols, '删除目标多余的栏位/索引'),
    el('label', { class: 'form-check' }, chkDropTables, '删除目标多余的表'));

  // 数据选项
  const dataModeSel = el('select', {},
    el('option', { value: 'count' }, '仅统计差异'),
    el('option', { value: 'script' }, '生成脚本文件'),
    el('option', { value: 'apply' }, '直接应用到目标'));
  const chkIns = el('input', { type: 'checkbox' }); chkIns.checked = true;
  const chkUpd = el('input', { type: 'checkbox' }); chkUpd.checked = true;
  const chkDel = el('input', { type: 'checkbox' });
  const dataOpts = el('div', { style: { display: 'none', gap: '16px', flexWrap: 'wrap', alignItems: 'center' } },
    el('span', { style: { color: 'var(--text-muted)', fontSize: '12.5px' } }, '方式:'), dataModeSel,
    el('label', { class: 'form-check' }, chkIns, 'INSERT 缺失行'),
    el('label', { class: 'form-check' }, chkUpd, 'UPDATE 差异行'),
    el('label', { class: 'form-check' }, chkDel, 'DELETE 多余行'));

  function syncModeUI() {
    const isData = modeData.checked;
    structOpts.style.display = isData ? 'none' : 'flex';
    dataOpts.style.display = isData ? 'flex' : 'none';
    btnExec.style.display = 'none';
    btnSave.style.display = 'none';
    resultBox.style.display = 'none';
  }
  modeStruct.addEventListener('change', syncModeUI);
  modeData.addEventListener('change', syncModeUI);

  // ---- 结果区 ----
  const progressText = el('div', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, '');
  const resultBox = el('div', { style: { display: 'none', flexDirection: 'column', gap: '6px' } });
  const resultList = el('div', { style: { maxHeight: '130px', overflow: 'auto', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '6px 10px', fontSize: '12.5px' } });
  const sqlPreview = el('div', { class: 'ddl-box', style: { maxHeight: '150px', overflow: 'auto', whiteSpace: 'pre', fontSize: '11.5px' } });
  resultBox.append(resultList, sqlPreview);

  const btnExec = el('button', { class: 'btn primary', style: { display: 'none' }, onClick: execStruct }, '执行到目标');
  const btnSave = el('button', { class: 'btn', style: { display: 'none' }, onClick: saveScript }, '保存脚本…');

  const lblRow = (label, c, d, s) => el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
    el('span', { style: { color: 'var(--text-muted)', fontSize: '12.5px', flex: '0 0 36px', textAlign: 'right' } }, label), c, d, s);

  const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', width: '640px', maxWidth: '82vw' } },
    lblRow('源:', srcConn, srcDb, srcSchema),
    lblRow('目标:', dstConn, dstDb, dstSchema),
    el('div', { style: { display: 'flex', gap: '18px', alignItems: 'center' } },
      el('label', { class: 'form-check' }, modeStruct, el('b', {}, '结构同步')),
      el('label', { class: 'form-check' }, modeData, el('b', {}, '数据同步')),
      el('span', { class: 'spring', style: { flex: '1' } }),
      el('button', { class: 'pbtn', onClick: () => tableChecks.forEach((x) => { x.cb.checked = true; }) }, '全选'),
      el('button', { class: 'pbtn', onClick: () => tableChecks.forEach((x) => { x.cb.checked = !x.cb.checked; }) }, '反选'),
      filterInput),
    tablesBox,
    structOpts,
    dataOpts,
    progressText,
    resultBox,
  );

  const m = openModal({
    title: '同步（结构 / 数据）',
    body,
    buttons: [
      { label: '关闭', onClick: () => !running },
      { label: '开始比对', primary: true, onClick: () => { start(); return false; } },
    ],
  });
  // 把执行/保存按钮插入底部按钮区左侧
  const foot = m.overlay.querySelector('.modal-foot');
  foot.insertBefore(btnSave, foot.firstChild);
  foot.insertBefore(btnExec, foot.firstChild);

  function pickedTables() {
    return tableChecks.filter((x) => x.cb.checked).map((x) => ({ name: x.table.name, schema: x.table.schema || null }));
  }

  function commonArgs() {
    return {
      srcConnId: srcConn.value, dstConnId: dstConn.value,
      srcDb: srcDb.value, srcSchema: srcSchema.value || null,
      dstDb: dstDb.value, dstSchema: dstSchema.value || null,
      tables: pickedTables(),
    };
  }

  async function start() {
    if (running) return;
    const tables = pickedTables();
    if (!tables.length) { toast.error('请至少选择一个表'); return; }
    if (srcConn.value === dstConn.value && srcDb.value === dstDb.value && (srcSchema.value || '') === (dstSchema.value || '')) {
      toast.error('源与目标相同'); return;
    }
    if (modeData.checked) await runData();
    else await runStruct();
  }

  // ---------- 结构同步 ----------
  async function runStruct() {
    running = true;
    btnExec.style.display = 'none';
    btnSave.style.display = 'none';
    const off = window.api.dba.onProgress((p) => {
      if (p.tablesTotal !== undefined) progressText.textContent = `[${p.tablesDone}/${p.tablesTotal}] ${p.table || ''} — ${p.phase}`;
      else if (p.total) progressText.textContent = `执行 ${p.done}/${p.total}`;
    });
    try {
      diffResult = await window.api.dba.structDiff({
        ...commonArgs(),
        dropExtraColumns: chkDropCols.checked,
        dropExtraTables: chkDropTables.checked,
      });
      const statusLabel = { create: '新建', alter: '修改', same: '相同', error: '出错' };
      resultList.innerHTML = '';
      let sqlCount = 0;
      for (const t of diffResult.tables) {
        sqlCount += t.sqls.length;
        const color = t.status === 'same' ? 'var(--text-muted)' : t.status === 'error' ? 'var(--danger)' : 'var(--accent-dark)';
        resultList.append(el('div', { style: { color } },
          `${t.status === 'same' ? '·' : t.status === 'error' ? '✗' : '●'} ${t.table} — ${statusLabel[t.status]}` +
          (t.sqls.length ? `（${t.sqls.length} 条语句）` : '') +
          (t.warnings.length ? `  ⚠ ${t.warnings.join('；')}` : '')));
      }
      for (const e of diffResult.extraTables) {
        sqlCount += e.sqls.length;
        resultList.append(el('div', { style: { color: 'var(--danger)' } }, `● ${e.table} — 删除目标多余表`));
      }
      const allSqls = collectSqls();
      sqlPreview.textContent = allSqls.length ? allSqls.map((s) => s + ';').join('\n') : '-- 两侧结构一致，无需变更';
      resultBox.style.display = 'flex';
      progressText.textContent = `比对完成：${diffResult.tables.filter((t) => t.status !== 'same').length + diffResult.extraTables.length} 个表有差异，共 ${allSqls.length} 条语句`;
      if (allSqls.length) {
        btnExec.style.display = '';
        btnExec.textContent = `执行到目标（${allSqls.length} 条）`;
        btnSave.style.display = '';
      }
    } catch (e) {
      toast.error('比对失败：\n' + e.message, 12000);
      progressText.textContent = '失败：' + e.message;
    } finally {
      off();
      running = false;
    }
  }

  function collectSqls() {
    if (!diffResult) return [];
    const sqls = [];
    for (const t of diffResult.tables) sqls.push(...t.sqls);
    for (const e of diffResult.extraTables) sqls.push(...e.sqls);
    return sqls;
  }

  async function execStruct() {
    const sqls = collectSqls();
    if (!sqls.length || running) return;
    const ok = await confirmDialog('执行结构同步',
      `将对目标 ${connLabel(dstConn.value)} › ${dstDb.value} 执行 ${sqls.length} 条 DDL。\nDDL 不可回滚，确定继续吗？`,
      { danger: true, okLabel: '执行' });
    if (!ok) return;
    running = true;
    const off = window.api.dba.onProgress((p) => {
      if (p.total) progressText.textContent = `执行 ${p.done}/${p.total}`;
    });
    try {
      const r = await window.api.dba.execSqls(dstConn.value, dstDb.value, sqls);
      toast.success(`结构同步完成：已执行 ${r.executed} 条语句`);
      progressText.textContent = `已执行 ${r.executed} 条语句`;
      btnExec.style.display = 'none';
      emit('objects-changed', { connId: dstConn.value, db: dstDb.value, schema: dstSchema.value || null });
    } catch (e) {
      toast.error('执行失败：\n' + e.message, 15000);
      progressText.textContent = '失败：' + e.message;
    } finally {
      off();
      running = false;
    }
  }

  async function saveScript() {
    const sqls = collectSqls();
    if (!sqls.length) return;
    const file = await window.api.dlg.saveFile({
      title: '保存同步脚本',
      defaultPath: `sync-${dstDb.value || 'target'}.sql`,
      filters: [{ name: 'SQL 文件', extensions: ['sql'] }],
    });
    if (!file) return;
    await window.api.file.write(file, sqls.map((s) => s + ';').join('\r\n') + '\r\n');
    toast.success('脚本已保存\n' + file);
  }

  // ---------- 数据同步 ----------
  async function runData() {
    let file = null;
    const dataMode = dataModeSel.value;
    if (dataMode === 'script') {
      file = await window.api.dlg.saveFile({
        title: '保存数据同步脚本',
        defaultPath: `datasync-${dstDb.value || 'target'}.sql`,
        filters: [{ name: 'SQL 文件', extensions: ['sql'] }],
      });
      if (!file) return;
    }
    if (dataMode === 'apply') {
      const ok = await confirmDialog('直接应用',
        `将直接修改目标 ${connLabel(dstConn.value)} › ${dstDb.value} 的数据${chkDel.checked ? '（含删除多余行）' : ''}。\n建议先用「仅统计差异」预览。确定继续吗？`,
        { danger: true, okLabel: '应用' });
      if (!ok) return;
    }
    running = true;
    const off = window.api.dba.onProgress((p) => {
      if (p.tablesTotal !== undefined) {
        progressText.textContent = `[${p.tablesDone}/${p.tablesTotal}] ${p.table || ''} — ${p.phase}` +
          (p.inserts !== undefined ? `　插入 ${p.inserts} · 更新 ${p.updates} · 删除 ${p.deletes}` : '');
      }
    });
    try {
      const r = await window.api.dba.dataSync({
        ...commonArgs(),
        mode: dataMode, file,
        doInsert: chkIns.checked, doUpdate: chkUpd.checked, doDelete: chkDel.checked,
      });
      resultList.innerHTML = '';
      let ti = 0, tu = 0, td = 0;
      for (const t of r.tables) {
        if (t.skipped) {
          resultList.append(el('div', { style: { color: 'var(--orange)' } }, `⚠ ${t.table} — 跳过：${t.skipped}`));
          continue;
        }
        ti += t.inserts; tu += t.updates; td += t.deletes;
        const diff = t.inserts + t.updates + t.deletes;
        resultList.append(el('div', { style: { color: diff ? 'var(--accent-dark)' : 'var(--text-muted)' } },
          `${diff ? '●' : '·'} ${t.table} — 插入 ${t.inserts.toLocaleString()} · 更新 ${t.updates.toLocaleString()} · 删除 ${t.deletes.toLocaleString()}` +
          (dataMode === 'apply' ? `（已应用 ${t.applied.toLocaleString()} 条）` : '')));
      }
      sqlPreview.textContent = dataMode === 'script' && r.file ? `-- 脚本已写入：${r.file}` :
        dataMode === 'count' ? '-- 仅统计模式：未对目标做任何修改' : '-- 已直接应用到目标';
      resultBox.style.display = 'flex';
      const summary = `比对完成：插入 ${ti.toLocaleString()} · 更新 ${tu.toLocaleString()} · 删除 ${td.toLocaleString()}`;
      progressText.textContent = summary;
      toast.success(summary, 8000);
    } catch (e) {
      toast.error('数据同步失败：\n' + e.message, 15000);
      progressText.textContent = '失败：' + e.message;
    } finally {
      off();
      running = false;
    }
  }

  syncModeUI();
  await fillDbSel(srcConn, srcDb, srcSchema, preset && preset.db);
  await fillDbSel(dstConn, dstDb, dstSchema);
  await refreshTables();
}
