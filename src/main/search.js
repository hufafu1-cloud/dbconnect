// 在库中查找：对象名（表/视图/列）与数据内容搜索
const { sanitizeValue } = require('./db/sqlutil');

const TEXT_TYPE_RE = /char|text|varchar|varchar2|nvarchar|nchar|string|clob|nclob|json|enum|uuid|inet/i;

function snippet(v, keyword) {
  let s = sanitizeValue(v);
  if (s && typeof s === 'object' && s.__blob) return null;
  s = String(s === null || s === undefined ? '' : s);
  const lk = keyword.toLowerCase();
  const idx = s.toLowerCase().indexOf(lk);
  if (idx < 0) return s.length > 120 ? s.slice(0, 120) + '…' : s;
  const start = Math.max(0, idx - 30);
  const end = Math.min(s.length, idx + keyword.length + 60);
  return (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : '');
}

/**
 * @param args {db, schema, keyword, mode:'name'|'data', maxPerTable, tables?}
 */
async function searchDatabase(ad, args, progress) {
  const { db, schema, keyword, mode } = args;
  if (!keyword || !keyword.trim()) throw new Error('请输入要查找的内容');
  const kw = keyword.trim();

  if (mode === 'name') {
    const objs = await ad.listObjects(db, schema);
    const cols = await ad.listAllColumns(db, schema).catch(() => ({}));
    const low = kw.toLowerCase();
    const results = [];
    for (const t of objs.tables) {
      if (t.name.toLowerCase().includes(low)) results.push({ kind: 'table', table: t.name, schema: t.schema || schema || null });
    }
    for (const v of objs.views) {
      if (v.name.toLowerCase().includes(low)) results.push({ kind: 'view', table: v.name, schema: v.schema || schema || null });
    }
    for (const [tbl, cs] of Object.entries(cols)) {
      for (const c of cs) {
        if (String(c).toLowerCase().includes(low)) results.push({ kind: 'column', table: tbl, column: c });
      }
    }
    return { mode, results };
  }

  // ---- 数据内容搜索 ----
  const objs = await ad.listObjects(db, schema);
  const tableList = (args.tables && args.tables.length)
    ? args.tables
    : objs.tables.map((t) => ({ name: t.name, schema: t.schema || schema || null }));
  const maxPerTable = Math.min(Math.max(args.maxPerTable || 50, 1), 500);
  const likeOp = ad.dialect === 'postgres' ? 'ILIKE' : 'LIKE';
  const likeVal = ad.literal('%' + kw + '%');
  const results = [];
  let done = 0;

  for (const t of tableList) {
    progress({ phase: '搜索', table: t.name, done, total: tableList.length, hits: results.length });
    try {
      const info = await ad.tableInfo(db, t.schema, t.name);
      const textCols = info.columns.filter((c) => TEXT_TYPE_RE.test(c.type || ''));
      if (!textCols.length) { done++; continue; }
      const conds = textCols.map((c) => `${ad.quoteIdent(c.name)} ${likeOp} ${likeVal}`).join(' OR ');
      const T = ad.qualify(db, t.schema, t.name);
      const sql = ad.pageSql(`SELECT * FROM ${T} WHERE ${conds}`, '', maxPerTable, 0);
      const r = await ad.exec(db, sql);
      // 剔除 Oracle 分页辅助列
      const rnIdx = r.columns.findIndex((c) => c.name === 'RN__');
      if (rnIdx >= 0) { r.columns.splice(rnIdx, 1); for (const row of r.rows) row.splice(rnIdx, 1); }
      const nameIdx = {};
      r.columns.forEach((c, i) => { nameIdx[c.name] = i; });
      const pkCols = info.pk || [];
      for (const row of r.rows) {
        let matchedCol = null;
        for (const tc of textCols) {
          const i = nameIdx[tc.name];
          if (i >= 0 && row[i] != null && String(row[i]).toLowerCase().includes(kw.toLowerCase())) { matchedCol = tc.name; break; }
        }
        if (!matchedCol) continue;
        const pk = {};
        let pkOk = pkCols.length > 0;
        for (const pc of pkCols) {
          const i = nameIdx[pc];
          if (i < 0) { pkOk = false; break; }
          pk[pc] = sanitizeValue(row[i]);
        }
        results.push({
          kind: 'data', table: t.name, schema: t.schema, column: matchedCol,
          snippet: snippet(row[nameIdx[matchedCol]], kw),
          pk: pkOk ? pk : null,
        });
        if (results.length >= 2000) break;
      }
    } catch (e) { /* 跳过无权限/异常表 */ }
    done++;
    if (results.length >= 2000) break;
  }
  progress({ phase: '完成', done, total: tableList.length, hits: results.length });
  return { mode, results, truncated: results.length >= 2000 };
}

module.exports = { searchDatabase };
