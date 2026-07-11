// 结构同步 / 数据同步：比对两个库（可跨连接、跨方言），生成并执行同步脚本
const fs = require('fs');
const ddl = require('./db/ddl');
const { valueLiteral } = require('./transfer');
const { tableProjection } = require('./exporter');
const { formatDate } = require('./db/sqlutil');

// ---------------- 工具 ----------------

/** 数字比较（支持超出 2^53 的整数字符串） */
function cmpNum(a, b) {
  const sa = String(a).trim();
  const sb = String(b).trim();
  const parse = (text) => {
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match || (!match[2] && !match[3])) return null;
    const exponent = Number(match[4] || 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) return null;
    const fraction = match[3] || '';
    let digits = (match[2] || '0') + fraction;
    let scale = fraction.length - exponent;
    if (scale < 0) { digits += '0'.repeat(-scale); scale = 0; }
    digits = digits.replace(/^0+/, '') || '0';
    const negative = match[1] === '-' && digits !== '0';
    return { negative, digits, scale };
  };
  const left = parse(sa);
  const right = parse(sb);
  if (left && right) {
    if (left.negative !== right.negative) return left.negative ? -1 : 1;
    const scale = Math.max(left.scale, right.scale);
    const la = BigInt(left.digits + '0'.repeat(scale - left.scale));
    const rb = BigInt(right.digits + '0'.repeat(scale - right.scale));
    const cmp = la < rb ? -1 : la > rb ? 1 : 0;
    return left.negative ? -cmp : cmp;
  }
  const na = Number(sa);
  const nb = Number(sb);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return sa.localeCompare(sb);
}

/** 单元格值归一化（用于跨库判断“值是否相同”） */
function normVal(v) {
  if (v === null || v === undefined) return '\u0000';
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return 'b:' + Buffer.from(v).toString('hex');
  if (v instanceof Date) return 'd:' + formatDate(v);
  if (typeof v === 'boolean') return 'n:' + (v ? '1' : '0');
  const s = typeof v === 'number' ? String(v) : String(v);
  // 数字样式统一（去小数尾零/整数前导零），让 '3.50' 与 3.5 相等
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    let [int, frac = ''] = s.replace(/^-/, '').split('.');
    int = int.replace(/^0+(?=\d)/, '');
    frac = frac.replace(/0+$/, '');
    return 'n:' + (s.startsWith('-') && (int !== '0' || frac) ? '-' : '') + int + (frac ? '.' + frac : '');
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(s)) {
    return 'd:' + s.replace('T', ' ').replace(/\.0+$/, '').slice(0, 19);
  }
  return 's:' + s;
}

/** 表是否存在 + tableInfo（不存在返回 null） */
async function tryTableInfo(ad, db, schema, table) {
  try {
    const info = await ad.tableInfo(db, schema, table);
    if (!info.columns || !info.columns.length) return null;
    return info;
  } catch (e) {
    return null;
  }
}

// ---------------- 结构同步 ----------------

/** 让“期望模型”的 origName 指向目标现有对象（按名匹配），可选保留目标多余栏位/索引 */
function matchModels(targetModel, sourceModel, { dropExtraColumns = false } = {}) {
  const desired = JSON.parse(JSON.stringify(sourceModel));
  const tCols = new Map(targetModel.columns.map((c) => [c.name, c]));
  const matched = new Set();
  for (const col of desired.columns) {
    const hit = tCols.get(col.name);
    col.origName = hit ? hit.name : null;
    if (hit) matched.add(hit.name);
  }
  if (!dropExtraColumns) {
    for (const tc of targetModel.columns) {
      if (!matched.has(tc.name)) {
        desired.columns.push(JSON.parse(JSON.stringify({ ...tc, origName: tc.name })));
      }
    }
  }
  const tIx = new Map((targetModel.indexes || []).map((i) => [i.name, i]));
  const ixMatched = new Set();
  for (const ix of desired.indexes || []) {
    ix.origName = tIx.has(ix.name) ? ix.name : null;
    if (ix.origName) ixMatched.add(ix.name);
  }
  if (!dropExtraColumns) {
    for (const ti of targetModel.indexes || []) {
      if (!ixMatched.has(ti.name)) {
        desired.indexes.push(JSON.parse(JSON.stringify({ ...ti, origName: ti.name })));
      }
    }
  }
  return desired;
}

/**
 * 结构比对
 * args: {srcDb, srcSchema, dstDb, dstSchema, tables:[{name, schema?}], dropExtraColumns, dropExtraTables}
 * 返回 {tables:[{table, status, sqls, warnings}], extraTables:[{table, sqls}]}
 */
async function diffStructure(srcAd, dstAd, args, progress) {
  const { srcDb, srcSchema, dstDb, dstSchema, tables, dropExtraColumns = false, dropExtraTables = false } = args;
  const out = { tables: [], extraTables: [] };
  let done = 0;
  for (const t of tables) {
    const table = typeof t === 'string' ? t : t.name;
    const sSchema = (typeof t === 'object' && t.schema) || srcSchema || null;
    const dSchema = dstSchema !== undefined && dstSchema !== null && dstSchema !== ''
      ? dstSchema : ((typeof t === 'object' && t.schema) || null);
    progress({ table, phase: '比对结构', tablesDone: done, tablesTotal: tables.length });
    const item = { table, status: 'same', sqls: [], warnings: [] };
    try {
      const srcInfo = await srcAd.tableInfo(srcDb, sSchema, table);
      const srcModel = ddl.infoToModel(srcInfo, table, srcAd.dialect);
      const tr = ddl.translateModel(srcModel, srcAd.dialect, dstAd.dialect);
      item.warnings.push(...tr.warnings);

      const dstInfo = await tryTableInfo(dstAd, dstDb, dSchema, table);
      if (!dstInfo) {
        const built = ddl.buildCreateTable(dstAd, dstDb, dSchema, tr.model);
        item.status = 'create';
        item.sqls = built.sqls;
        item.warnings.push(...built.warnings);
      } else {
        const dstModel = ddl.infoToModel(dstInfo, table, dstAd.dialect);
        const desired = matchModels(dstModel, tr.model, { dropExtraColumns });
        const built = ddl.buildAlterTable(dstAd, dstDb, dSchema, dstModel, desired);
        if (built.sqls.length) {
          item.status = 'alter';
          item.sqls = built.sqls;
        }
        item.warnings.push(...built.warnings);
      }
    } catch (err) {
      item.status = 'error';
      item.warnings.push((err && err.message) || String(err));
    }
    out.tables.push(item);
    done++;
  }
  // 目标多余的表
  if (dropExtraTables) {
    try {
      const dstObjs = await dstAd.listObjects(dstDb, dstSchema || undefined);
      const srcNames = new Set(tables.map((t) => (typeof t === 'string' ? t : t.name)));
      for (const dt of dstObjs.tables) {
        if (!srcNames.has(dt.name)) {
          out.extraTables.push({
            table: dt.name,
            sqls: [`DROP TABLE ${dstAd.qualify(dstDb, dt.schema || dstSchema || null, dt.name)}`],
          });
        }
      }
    } catch (e) { /* ignore */ }
  }
  return out;
}

/** 顺序执行一组语句（带进度），出错即停 */
async function execMany(ad, db, sqls, progress) {
  let done = 0;
  await ad.withSession(db, async (run) => {
    for (const s of sqls) {
      try {
        await run(s);
        done++;
      } catch (err) {
        throw new Error(`第 ${done + 1}/${sqls.length} 条失败: ${(err && err.message) || err}\nSQL: ${s}\n（前 ${done} 条已执行）`);
      }
      if (done % 10 === 0) progress({ phase: '执行', done, total: sqls.length });
    }
  });
  progress({ phase: '完成', done, total: sqls.length });
  return { executed: done };
}

// ---------------- 数据同步 ----------------

const NUMERIC_TYPE_RE = /int|number|numeric|decimal|serial|real|double|float/i;

async function fetchPage(ad, db, schema, table, cols, columnInfos, pkCols, page, pageSize) {
  const colSql = ad.dialect === 'mssql'
    ? tableProjection(ad, columnInfos)
    : cols.map((c) => ad.quoteIdent(c)).join(', ');
  const order = ' ORDER BY ' + pkCols.map((c) => ad.quoteIdent(c)).join(', ');
  const sql = ad.pageSql(`SELECT ${colSql} FROM ${ad.qualify(db, schema, table)}`, order, pageSize, (page - 1) * pageSize);
  const r = await ad.exec(db, sql);
  const rnIdx = r.columns.findIndex((c) => c.name === 'RN__');
  if (rnIdx >= 0) {
    r.columns.splice(rnIdx, 1);
    for (const row of r.rows) row.splice(rnIdx, 1);
  }
  return r.rows;
}

/** 流式读取器：按页供行 */
function makeReader(ad, db, schema, table, cols, columnInfos, pkCols, pageSize) {
  let page = 1;
  let buf = [];
  let idx = 0;
  let eof = false;
  return {
    async peek() {
      if (idx >= buf.length && !eof) {
        buf = await fetchPage(ad, db, schema, table, cols, columnInfos, pkCols, page++, pageSize);
        idx = 0;
        if (buf.length < pageSize) eof = true;
        if (!buf.length) return null;
      }
      return idx < buf.length ? buf[idx] : null;
    },
    next() { idx++; },
  };
}

/**
 * 数据同步
 * args: {srcDb, srcSchema, dstDb, dstSchema, tables, mode:'count'|'script'|'apply',
 *        doInsert, doUpdate, doDelete, file?, batchSize}
 */
async function syncData(srcAd, dstAd, args, progress) {
  const {
    srcDb, srcSchema, dstDb, dstSchema, tables,
    mode = 'count', doInsert = true, doUpdate = true, doDelete = false,
    file, batchSize = 500,
  } = args;
  const MAP_CAP = 500000;
  const out = { tables: [], file: mode === 'script' ? file : undefined };
  let ws = null;
  if (mode === 'script') {
    ws = fs.createWriteStream(file, { encoding: 'utf8' });
    ws.write(`-- DBPanda 数据同步脚本 ${new Date().toLocaleString('zh-CN')}\r\n\r\n`);
  }
  const writeLn = (s) => ws && ws.write(s + '\r\n');

  let tDone = 0;
  try {
    for (const t of tables) {
      const table = typeof t === 'string' ? t : t.name;
      const sSchema = (typeof t === 'object' && t.schema) || srcSchema || null;
      const dSchema = dstSchema !== undefined && dstSchema !== null && dstSchema !== ''
        ? dstSchema : ((typeof t === 'object' && t.schema) || null);
      const item = { table, inserts: 0, updates: 0, deletes: 0, applied: 0, skipped: '' };
      const report = (phase) => progress({
        table, phase, tablesDone: tDone, tablesTotal: tables.length,
        inserts: item.inserts, updates: item.updates, deletes: item.deletes,
      });
      try {
        const srcInfo = await srcAd.tableInfo(srcDb, sSchema, table);
        const dstInfo = await tryTableInfo(dstAd, dstDb, dSchema, table);
        if (!dstInfo) { item.skipped = '目标表不存在（请先结构同步）'; out.tables.push(item); tDone++; continue; }
        const pk = srcInfo.pk || [];
        if (!pk.length) { item.skipped = '无主键，无法按行比对'; out.tables.push(item); tDone++; continue; }
        if (JSON.stringify([...pk].sort()) !== JSON.stringify([...(dstInfo.pk || [])].sort())) {
          item.skipped = '两侧主键不一致';
          out.tables.push(item);
          tDone++;
          continue;
        }
        const dstColSet = new Set(dstInfo.columns.map((c) => c.name));
        const cols = srcInfo.columns.map((c) => c.name).filter((n) => dstColSet.has(n));
        if (!pk.every((p) => cols.includes(p))) { item.skipped = '主键列不在公共列中'; out.tables.push(item); tDone++; continue; }
        const pkIdx = pk.map((p) => cols.indexOf(p));
        const valCols = cols.map((c, i) => ({ name: c, i })).filter((x) => !pk.includes(x.name));
        const typeByName = {};
        for (const c of srcInfo.columns) typeByName[c.name] = c.type || '';
        const pkNumeric = pk.every((p) => NUMERIC_TYPE_RE.test(typeByName[p] || ''));
        const srcColumnInfos = cols.map((name) => srcInfo.columns.find((column) => column.name === name));
        const dstColumnInfos = cols.map((name) => dstInfo.columns.find((column) => column.name === name));

        const T = dstAd.qualify(dstDb, dSchema, table);
        const q = (n) => dstAd.quoteIdent(n);
        const whereOf = (row) => pk.map((p, j) => {
          const v = row[pkIdx[j]];
          return v === null ? `${q(p)} IS NULL` : `${q(p)} = ${valueLiteral(dstAd, v)}`;
        }).join(' AND ');

        let pending = [];
        const flush = async (force) => {
          if (!pending.length || (!force && pending.length < batchSize)) return;
          if (mode === 'apply') {
            await dstAd.execTxn(dstDb, pending);
            item.applied += pending.length;
          } else if (mode === 'script') {
            for (const s of pending) writeLn(s + ';');
          }
          pending = [];
        };
        const emit = async (sql) => {
          if (mode !== 'count') {
            pending.push(sql);
            await flush(false);
          }
        };
        const onInsert = async (row) => {
          item.inserts++;
          if (doInsert) {
            await emit(`INSERT INTO ${T} (${cols.map(q).join(', ')}) VALUES (${row.map((v) => valueLiteral(dstAd, v)).join(', ')})`);
          }
        };
        const onDelete = async (row) => {
          item.deletes++;
          if (doDelete) await emit(`DELETE FROM ${T} WHERE ${whereOf(row)}`);
        };
        const onPair = async (sRow, dRow) => {
          const sets = [];
          for (const vc of valCols) {
            if (normVal(sRow[vc.i]) !== normVal(dRow[vc.i])) {
              sets.push(`${q(vc.name)} = ${valueLiteral(dstAd, sRow[vc.i])}`);
            }
          }
          if (sets.length) {
            item.updates++;
            if (doUpdate) await emit(`UPDATE ${T} SET ${sets.join(', ')} WHERE ${whereOf(sRow)}`);
          }
        };

        if (pkNumeric) {
          // 流式归并（数字主键，内存恒定）
          const rs = makeReader(srcAd, srcDb, sSchema, table, cols, srcColumnInfos, pk, 1000);
          const rd = makeReader(dstAd, dstDb, dSchema, table, cols, dstColumnInfos, pk, 1000);
          let n = 0;
          for (;;) {
            const a = await rs.peek();
            const b = await rd.peek();
            if (!a && !b) break;
            let cmp;
            if (!a) cmp = 1;
            else if (!b) cmp = -1;
            else {
              cmp = 0;
              for (let j = 0; j < pkIdx.length && cmp === 0; j++) cmp = cmpNum(a[pkIdx[j]], b[pkIdx[j]]);
            }
            if (cmp < 0) { await onInsert(a); rs.next(); }
            else if (cmp > 0) { await onDelete(b); rd.next(); }
            else { await onPair(a, b); rs.next(); rd.next(); }
            if (++n % 5000 === 0) report('比对中');
          }
        } else {
          // 字符串主键：内存映射比对（有行数上限）
          const loadMap = async (ad, db2, sch2, columnInfos) => {
            const map = new Map();
            let page = 1;
            for (;;) {
              const rows = await fetchPage(ad, db2, sch2, table, cols, columnInfos, pk, page++, 5000);
              for (const r of rows) map.set(pkIdx.map((i) => normVal(r[i])).join('\u0001'), r);
              if (map.size > MAP_CAP) throw new Error(`超过 ${MAP_CAP.toLocaleString()} 行（字符串主键的大表暂不支持）`);
              if (rows.length < 5000) break;
            }
            return map;
          };
          report('加载源');
          const sMap = await loadMap(srcAd, srcDb, sSchema, srcColumnInfos);
          report('加载目标');
          const dMap = await loadMap(dstAd, dstDb, dSchema, dstColumnInfos);
          for (const [k, sRow] of sMap) {
            const dRow = dMap.get(k);
            if (!dRow) await onInsert(sRow);
            else await onPair(sRow, dRow);
          }
          for (const [k, dRow] of dMap) {
            if (!sMap.has(k)) await onDelete(dRow);
          }
        }
        await flush(true);
      } catch (err) {
        item.skipped = (err && err.message) || String(err);
      }
      out.tables.push(item);
      tDone++;
      report('完成');
    }
  } finally {
    if (ws) await new Promise((res) => ws.end(res));
  }
  return out;
}

module.exports = { diffStructure, execMany, syncData, matchModels, cmpNum, normVal };
