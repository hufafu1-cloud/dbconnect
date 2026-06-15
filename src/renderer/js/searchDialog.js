// 在库中查找：对象名（表/视图/列）与数据内容搜索
import { el, iconEl } from './util.js';
import { openModal, toast } from './toast.js';
import { state, connLabel } from './state.js';

function connTypeOf(connId) {
  const c = state.connections.find((x) => x.id === connId);
  return c ? c.type : null;
}

function makeQi(connType) {
  return (n) => connType === 'mssql' ? '[' + String(n).replace(/]/g, ']]') + ']'
    : ['mysql', 'oceanbase', 'clickhouse'].includes(connType) ? '`' + String(n).replace(/`/g, '``') + '`'
    : '"' + String(n).replace(/"/g, '""') + '"';
}
function makeLit(connType) {
  const bs = ['mysql', 'oceanbase', 'clickhouse'].includes(connType);
  return (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    let s = String(v).replace(/'/g, "''");
    if (bs) s = s.replace(/\\/g, '\\\\');
    return "'" + s + "'";
  };
}

export async function openSearchDialog(preset) {
  if (state.open.size < 1) { toast.info('请先打开连接'); return; }
  let running = false;

  const connSel = el('select', { style: { width: '180px' } },
    ...[...state.open.keys()].map((id) => el('option', { value: id, selected: id === (preset && preset.connId) ? 'selected' : null }, connLabel(id))));
  const dbSel = el('select', { style: { minWidth: '130px' } });
  const schemaSel = el('select', { style: { minWidth: '100px', display: 'none' } });
  const kwInput = el('input', { type: 'text', placeholder: '输入要查找的内容…', style: { flex: '1', minWidth: '0' } });
  const modeName = el('input', { type: 'radio', name: 'search-mode' }); modeName.checked = true;
  const modeData = el('input', { type: 'radio', name: 'search-mode' });

  const progressText = el('div', { style: { fontSize: '12px', color: 'var(--text-muted)', minHeight: '16px' } }, '');
  const resultList = el('div', { style: { flex: '1', minHeight: '180px', maxHeight: '46vh', overflow: 'auto', border: '1px solid var(--border-light)', borderRadius: '6px', marginTop: '4px' } });

  async function fillDb() {
    const oc = state.open.get(connSel.value);
    const dbs = (oc && oc.databases) || [];
    dbSel.innerHTML = '';
    for (const d of dbs) dbSel.append(el('option', { value: d, selected: d === (preset && preset.db) ? 'selected' : null }, d));
    await fillSchema();
  }
  async function fillSchema() {
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
  connSel.addEventListener('change', fillDb);
  dbSel.addEventListener('change', fillSchema);
  kwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  const lbl = (s) => el('span', { style: { color: 'var(--text-muted)', fontSize: '12.5px' } }, s);
  const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', width: '660px', maxWidth: '84vw' } },
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, lbl('连接:'), connSel, lbl('库:'), dbSel, schemaSel),
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, lbl('查找:'), kwInput),
    el('div', { style: { display: 'flex', gap: '18px', alignItems: 'center' } },
      el('label', { class: 'form-check' }, modeName, '对象名（表 / 视图 / 列）'),
      el('label', { class: 'form-check' }, modeData, '数据内容（遍历各表文本列）')),
    progressText,
    resultList,
  );

  const m = openModal({
    title: '在库中查找',
    body,
    buttons: [
      { label: '关闭', onClick: () => !running },
      { label: '查找', primary: true, onClick: () => { run(); return false; } },
    ],
  });

  function openTarget(connId, db, schema, table, where) {
    import('./tableTab.js').then(({ openTableTab }) => {
      openTableTab({ connId, db, schema, table }, where ? { initialWhere: where } : undefined);
    });
    m.close();
  }

  function renderResults(data, kw) {
    resultList.innerHTML = '';
    const rs = data.results || [];
    if (!rs.length) { resultList.append(el('div', { class: 'obj-placeholder' }, '没有匹配结果')); return; }
    const connId = connSel.value, db = dbSel.value, schema = schemaSel.value || null;
    const qi = makeQi(connTypeOf(connId)), lit = makeLit(connTypeOf(connId));
    const table = el('table', { class: 'obj-table', style: { fontSize: '12.5px' } });
    if (data.mode === 'name') {
      table.append(el('thead', {}, el('tr', {}, el('th', { style: { width: '20%' } }, '类型'), el('th', { style: { width: '40%' } }, '对象'), el('th', {}, '所在'))));
      const tb = el('tbody');
      for (const r of rs) {
        const typeLabel = r.kind === 'table' ? '表' : r.kind === 'view' ? '视图' : '列';
        const icon = r.kind === 'column' ? 'struct' : r.kind === 'view' ? 'view' : 'table';
        const tr = el('tr', {},
          el('td', {}, el('span', { class: 'obj-name' }, iconEl(icon), typeLabel)),
          el('td', {}, r.kind === 'column' ? r.column : r.table),
          el('td', { style: { color: 'var(--text-muted)' } }, r.kind === 'column' ? `${r.table} 表` : ''));
        const tbl = r.kind === 'column' ? r.table : r.table;
        tr.addEventListener('dblclick', () => openTarget(connId, db, r.schema || schema, tbl));
        tb.append(tr);
      }
      table.append(tb);
    } else {
      table.append(el('thead', {}, el('tr', {}, el('th', { style: { width: '24%' } }, '表'), el('th', { style: { width: '18%' } }, '列'), el('th', {}, '匹配内容'))));
      const tb = el('tbody');
      for (const r of rs) {
        const tr = el('tr', {},
          el('td', {}, el('span', { class: 'obj-name' }, iconEl('table'), r.table)),
          el('td', { style: { fontFamily: 'var(--mono)' } }, r.column),
          el('td', { style: { color: 'var(--text-muted)' } }, r.snippet || ''));
        tr.addEventListener('dblclick', () => {
          let where;
          if (r.pk) {
            where = Object.entries(r.pk).map(([c, v]) => (v === null ? `${qi(c)} IS NULL` : `${qi(c)} = ${lit(v)}`)).join(' AND ');
          } else {
            where = `${qi(r.column)} LIKE ${lit('%' + kw + '%')}`;
          }
          openTarget(connId, db, r.schema || schema, r.table, where);
        });
        tb.append(tr);
      }
      table.append(tb);
    }
    resultList.append(table);
    const tip = data.truncated ? '（结果较多，已截断；双击结果可打开所在表）' : '（双击结果打开所在表）';
    progressText.textContent = `找到 ${rs.length} 项 ${tip}`;
  }

  async function run() {
    if (running) return;
    const kw = kwInput.value.trim();
    if (!kw) { toast.error('请输入要查找的内容'); return; }
    if (!dbSel.value && connTypeOf(connSel.value) !== 'sqlite') { /* sqlite db 为 main */ }
    running = true;
    resultList.innerHTML = '';
    progressText.textContent = '搜索中…';
    const mode = modeData.checked ? 'data' : 'name';
    const off = mode === 'data' ? window.api.db.onSearchProgress((p) => {
      progressText.textContent = `[${p.done}/${p.total}] 正在搜索 ${p.table || ''} … 已找到 ${p.hits}`;
    }) : null;
    try {
      const data = await window.api.db.search(connSel.value, {
        db: dbSel.value, schema: schemaSel.value || null, keyword: kw, mode, maxPerTable: 50,
      });
      renderResults(data, kw);
    } catch (e) {
      progressText.textContent = '';
      resultList.innerHTML = '';
      resultList.append(el('div', { style: { padding: '14px', color: 'var(--danger)' } }, '搜索失败: ' + e.message));
    } finally {
      if (off) off();
      running = false;
    }
  }

  await fillDb();
  setTimeout(() => kwInput.focus(), 30);
}
