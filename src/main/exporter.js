// 数据导出：CSV / JSON / SQL INSERT / Excel(xlsx) / Markdown
// 两种来源：整表分页拉取（exportTable）、内存中的结果集（exportRows）
const fs = require('fs');
const crypto = require('crypto');
const { csvCell, formatDate } = require('./db/sqlutil');
const { textLiteral } = require('./db/valueLiteral');

const FORMATS = {
  csv: { ext: 'csv', name: 'CSV 文件' },
  json: { ext: 'json', name: 'JSON 文件' },
  sql: { ext: 'sql', name: 'SQL 脚本' },
  xlsx: { ext: 'xlsx', name: 'Excel 工作簿' },
  md: { ext: 'md', name: 'Markdown 表格' },
};

function pad(value, width = 2) { return String(value).padStart(width, '0'); }

function dateValue(v, type, dialect) {
  if (dialect !== 'mssql' || !/\b(date|time|datetime|datetime2|datetimeoffset|smalldatetime)\b/i.test(String(type || ''))) {
    return formatDate(v);
  }
  const kind = String(type || '').toLowerCase();
  const utc = kind.includes('datetimeoffset');
  const get = (local, universal) => v[utc ? universal : local]();
  const year = get('getFullYear', 'getUTCFullYear');
  const month = get('getMonth', 'getUTCMonth') + 1;
  const day = get('getDate', 'getUTCDate');
  const hour = get('getHours', 'getUTCHours');
  const minute = get('getMinutes', 'getUTCMinutes');
  const second = get('getSeconds', 'getUTCSeconds');
  const millis = get('getMilliseconds', 'getUTCMilliseconds');
  const extraTicks = Math.max(0, Math.min(9999, Math.round(Number(v.nanosecondsDelta || 0) * 1e7)));
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  if (/^date\b/.test(kind)) return date;
  const time = `${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(millis, 3)}${pad(extraTicks, 4)}`;
  if (/^time\b/.test(kind)) return time;
  return `${date} ${time}${utc ? ' +00:00' : ''}`;
}

function plain(v, type, dialect) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && v.__blob) return '0x' + v.hex;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const buf = Buffer.isBuffer(v) ? v : Buffer.from(v);
    return '0x' + buf.toString('hex');
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  if (v instanceof Date) return dateValue(v, type, dialect);
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  return v;
}

function sqlValue(ctx, v, type) {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const buf = Buffer.isBuffer(v) ? v : Buffer.from(v);
    return ctx.blobLiteral(buf);
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && !Number.isFinite(v)) {
    throw new Error('非有限浮点值（NaN/Infinity）无法可靠生成为 SQL INSERT；请改用 CSV 或 JSON 导出');
  }
  if (ctx.dialect === 'postgres' && v !== null && v !== undefined) {
    const pgType = String(type || '').trim().toLowerCase();
    const isObjectValue = typeof v === 'object' && !(v instanceof Date);
    if (Array.isArray(v) || /\[\]\s*$/.test(pgType) || (/\binterval\b/.test(pgType) && isObjectValue)) {
      throw new Error(`PostgreSQL ${type || 'array/interval'} 值无法可靠生成为 SQL INSERT；请改用 CSV 或 JSON 导出`);
    }
  }
  const x = plain(v, type, ctx.dialect);
  if (x === null) return 'NULL';
  if (typeof x === 'number' || typeof x === 'boolean') return ctx.literal(x);
  return textLiteral(ctx, x);
}

function cursorLiteral(adapter, value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return adapter.blobLiteral(Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('非有限浮点主键无法用于稳定游标分页；请改用查询页的明确排序导出');
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return adapter.literal(value);
  }
  const normalized = value instanceof Date ? formatDate(value) : value;
  return textLiteral(adapter, normalized);
}

function keysetWhere(adapter, keyColumns, lastValues) {
  const branches = [];
  for (let i = 0; i < keyColumns.length; i++) {
    const parts = [];
    for (let j = 0; j < i; j++) {
      parts.push(`${adapter.quoteIdent(keyColumns[j])} = ${cursorLiteral(adapter, lastValues[j])}`);
    }
    parts.push(`${adapter.quoteIdent(keyColumns[i])} > ${cursorLiteral(adapter, lastValues[i])}`);
    branches.push(`(${parts.join(' AND ')})`);
  }
  return `(${branches.join(' OR ')})`;
}

/**
 * tedious materializes exact numerics as JavaScript numbers and high-precision
 * temporal values as Date objects. Cast those columns before the driver sees
 * them so whole-table exports retain the server's exact textual value.
 */
function tableProjection(adapter, columns) {
  if (adapter.dialect !== 'mssql' || !columns.length) return '*';
  return columns.map((column) => {
    const ident = adapter.quoteIdent(column.name);
    // SQL Server alias types keep their display name in `type`; `baseType`
    // identifies the underlying exact numeric/temporal representation.
    const type = String(column.baseType || column.type || '').trim().toLowerCase();
    let expression = ident;
    if (/^(decimal|numeric)\b/.test(type)) {
      expression = `CONVERT(varchar(100), ${ident})`;
    } else if (/^(money|smallmoney)\b/.test(type)) {
      expression = `CONVERT(varchar(100), ${ident}, 2)`;
    } else if (/^datetimeoffset\b/.test(type)) {
      expression = `CONVERT(varchar(50), ${ident}, 127)`;
    } else if (/^datetime2\b/.test(type)) {
      expression = `CONVERT(varchar(50), ${ident}, 126)`;
    } else if (/^time\b/.test(type)) {
      expression = `CONVERT(varchar(30), ${ident})`;
    }
    return expression === ident ? ident : `${expression} AS ${ident}`;
  }).join(', ');
}

/** 流式写出器：按行追加，最后 finish() */
async function createWriter(format, file, ctx) {
  if (!FORMATS[format]) throw new Error('不支持的导出格式: ' + format);
  if (format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: false, useSharedStrings: false });
    const MAX_XLSX_ROWS = 1048576;
    const MAX_XLSX_COLUMNS = 16384;
    const MAX_XLSX_TEXT = 32767;
    let ws = null;
    let columns = [];
    let columnTypes = [];
    let sheetNo = 0;
    let dataRows = 0;
    const cell = (v, type) => {
      const x = plain(v, type, ctx.dialect);
      if (x === null || typeof x === 'number' || typeof x === 'boolean') return x;
      const text = String(x);
      if (text.length > MAX_XLSX_TEXT) {
        throw new Error(`Excel 单元格最多支持 ${MAX_XLSX_TEXT.toLocaleString()} 个字符；请改用 CSV、JSON 或 SQL 导出以保留完整值`);
      }
      return text;
    };
    const newSheet = () => {
      sheetNo++;
      ws = wb.addWorksheet(`Sheet${sheetNo}`);
      ws.addRow(columns).commit();
      dataRows = 0;
    };
    return {
      async header(cols) {
        columns = cols.map((c) => cell(c.name));
        columnTypes = cols.map((c) => c.type || '');
        if (columns.length > MAX_XLSX_COLUMNS) {
          throw new Error(`Excel 工作表最多支持 ${MAX_XLSX_COLUMNS.toLocaleString()} 列`);
        }
        newSheet();
      },
      async row(r) {
        // Header occupies the first row on every sheet.
        if (dataRows >= MAX_XLSX_ROWS - 1) {
          ws.commit();
          newSheet();
        }
        ws.addRow(r.map((value, i) => cell(value, columnTypes[i]))).commit();
        dataRows++;
      },
      async finish() {
        if (ws) ws.commit();
        await wb.commit();
        return { sheets: sheetNo };
      },
      async abort() {
        await destroyStream(wb.stream);
      },
    };
  }

  const ws = fs.createWriteStream(file, { encoding: 'utf8' });
  let streamError = null;
  ws.on('error', (err) => { streamError = streamError || err; });
  const write = async (s) => {
    if (streamError) throw streamError;
    if (!ws.write(s)) {
      await new Promise((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (err) => { cleanup(); reject(err); };
        const cleanup = () => {
          ws.removeListener('drain', onDrain);
          ws.removeListener('error', onError);
        };
        ws.once('drain', onDrain);
        ws.once('error', onError);
      });
    }
    if (streamError) throw streamError;
  };
  const writeLn = (s) => write(s + '\r\n');
  const finishStream = async () => {
    if (streamError) throw streamError;
    await new Promise((resolve, reject) => {
      const onFinish = () => { cleanup(); resolve(); };
      const onError = (err) => { cleanup(); reject(err); };
      const cleanup = () => {
        ws.removeListener('finish', onFinish);
        ws.removeListener('error', onError);
      };
      ws.once('finish', onFinish);
      ws.once('error', onError);
      ws.end();
    });
    if (streamError) throw streamError;
    return {};
  };
  const abort = async () => destroyStream(ws);
  let first = true;
  let colNames = [];
  let colTypes = [];
  let formulaEscaped = 0;
  const setColumns = (cols) => {
    colNames = cols.map((c) => c.name);
    colTypes = cols.map((c) => c.type || '');
  };
  const duplicates = (foldCase) => {
    const seen = new Set();
    const repeated = new Set();
    for (const name of colNames) {
      const key = foldCase ? String(name).toLowerCase() : String(name);
      if (seen.has(key)) repeated.add(String(name));
      seen.add(key);
    }
    return [...repeated];
  };
  const csvSafe = (value, sourceWasString = typeof value === 'string') => {
    // Only text cells can be formulas. Converting first would incorrectly turn
    // legitimate negative numbers / bigints into escaped spreadsheet strings.
    // Drivers also return exact DECIMAL/NUMERIC/BIGINT values as strings. A
    // syntactically complete signed number is data, not a spreadsheet formula.
    const numericText = typeof value === 'string'
      && /^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+\-]?\d+)?$/.test(value);
    if (sourceWasString && typeof value === 'string' && !numericText && /^[=+\-@\t\r]/.test(value)) {
      formulaEscaped++;
      return "'" + value;
    }
    return value;
  };

  const writers = {
    csv: {
      async header(cols) { setColumns(cols); await write('﻿'); await writeLn(colNames.map((name) => csvCell(csvSafe(name))).join(',')); },
      async row(r) {
        await writeLn(r.map((v, i) => csvCell(csvSafe(plain(v, colTypes[i], ctx.dialect), typeof v === 'string'))).join(','));
      },
      async finish() { await finishStream(); return { formulaEscaped }; },
      abort,
    },
    json: {
      async header(cols) {
        setColumns(cols);
        const repeated = duplicates(false);
        if (repeated.length) throw new Error(`JSON 对象无法保留重复列名：${repeated.join(', ')}；请改用 CSV 或 XLSX`);
        await write('[\n');
      },
      async row(r) {
        const obj = {};
        colNames.forEach((n, i) => { obj[n] = plain(r[i], colTypes[i], ctx.dialect); });
        await write((first ? '' : ',\n') + '  ' + JSON.stringify(obj));
        first = false;
      },
      async finish() { await write('\n]\n'); return finishStream(); },
      abort,
    },
    sql: {
      async header(cols) {
        setColumns(cols);
        const repeated = duplicates(true);
        if (repeated.length) throw new Error(`SQL INSERT 无法可靠回放重复列名：${repeated.join(', ')}；请改用 CSV 或 XLSX`);
        await writeLn(`-- 由 Datavia 导出于 ${new Date().toLocaleString('zh-CN')}`);
        await writeLn('');
      },
      async row(r) {
        const q = ctx.quoteIdent;
        const vals = r.map((v, i) => sqlValue(ctx, v, colTypes[i]));
        await writeLn(`INSERT INTO ${ctx.tableRef} (${colNames.map(q).join(', ')}) VALUES (${vals.join(', ')});`);
      },
      finish: finishStream,
      abort,
    },
    md: {
      async header(cols) {
        setColumns(cols);
        await writeLn('| ' + colNames.map(mdCell).join(' | ') + ' |');
        await writeLn('| ' + colNames.map(() => '---').join(' | ') + ' |');
      },
      async row(r) {
        await writeLn('| ' + r.map((v, i) => {
          const x = plain(v, colTypes[i], ctx.dialect);
          return mdCell(x === null ? '' : String(x));
        }).join(' | ') + ' |');
      },
      finish: finishStream,
      abort,
    },
  };
  return writers[format];
}

async function destroyStream(stream) {
  if (!stream || stream.closed || typeof stream.destroy !== 'function') return;
  await new Promise((resolve) => {
    const done = () => resolve();
    stream.once('close', done);
    try { if (!stream.destroyed) stream.destroy(); }
    catch (e) { resolve(); }
  });
}

function mdCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function tempPath(file) {
  return `${file}.datavia-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
}

async function promoteTemp(temp, file) {
  try {
    await fs.promises.rename(temp, file);
  } catch (err) {
    if (!['EEXIST', 'EPERM'].includes(err && err.code)) throw err;
    const backup = `${file}.datavia-backup-${crypto.randomBytes(6).toString('hex')}.tmp`;
    let backedUp = false;
    try {
      await fs.promises.rename(file, backup);
      backedUp = true;
    } catch (backupErr) {
      if (backupErr && backupErr.code !== 'ENOENT') throw backupErr;
    }
    try {
      await fs.promises.rename(temp, file);
    } catch (replaceErr) {
      if (backedUp) {
        try { await fs.promises.rename(backup, file); }
        catch (rollbackErr) {
          replaceErr.message += `；原文件保留在 ${backup}（自动回滚失败：${rollbackErr.message}）`;
        }
      }
      throw replaceErr;
    }
    if (backedUp) await fs.promises.rm(backup, { force: true });
  }
}

/** 整表导出（分页拉取） */
async function exportTable(adapter, a) {
  const ctx = {
    dialect: adapter.dialect,
    quoteIdent: (n) => adapter.quoteIdent(n),
    literal: (v) => adapter.literal(v),
    blobLiteral: (v) => adapter.blobLiteral(v),
    tableRef: a.sqlTableName ? a.sqlTableName : adapter.qualify(a.db, a.schema, a.table),
  };
  const pageSize = 5000;
  const info = await adapter.tableInfo(a.db, a.schema, a.table);
  const columns = Array.isArray(info.columns) ? info.columns : [];
  const columnNames = new Set(columns.map((c) => c.name));
  const declaredPk = (Array.isArray(info.pk) ? info.pk : []).filter((name) => columnNames.has(name));
  // ClickHouse exposes its sorting key as a "primary key", but it is not unique;
  // using it as a keyset cursor would skip equal-key rows at page boundaries.
  const pk = adapter.dialect === 'clickhouse' ? [] : declaredPk;
  const qtable = adapter.qualify(a.db, a.schema, a.table);
  const projection = tableProjection(adapter, columns);
  const where = String(a.where || '').trim();
  const orderClause = pk.length
    ? ` ORDER BY ${pk.map((name) => adapter.quoteIdent(name)).join(', ')}`
    : '';
  let written = 0;
  let headerDone = false;
  let lastKey = null;
  let pages = 0;
  const temp = tempPath(a.file);
  let w;
  try {
    w = await createWriter(a.format || 'csv', temp, ctx);
    for (;;) {
      const filters = [];
      if (where) filters.push(`(${where})`);
      if (lastKey) filters.push(keysetWhere(adapter, pk, lastKey));
      const select = `SELECT ${projection} FROM ${qtable}${filters.length ? ' WHERE ' + filters.join(' AND ') : ''}`;
      // A table without a real unique key is safe only when one statement returns
      // the whole result. Probe one extra row and refuse unreliable OFFSET paging.
      const fetchSize = pk.length ? pageSize : pageSize + 1;
      const sql = adapter.pageSql(select, orderClause, fetchSize, 0);
      const r = await adapter.exec(a.db, sql);
      if (!r || !Array.isArray(r.rows) || !Array.isArray(r.columns)) {
        throw new Error('导出查询未返回结果集');
      }
      if (!headerDone) {
        await w.header(columns.length ? columns : r.columns);
        headerDone = true;
      }
      if (!pk.length && r.rows.length > pageSize) {
        throw new Error(`表 ${a.table} 没有可用于无损游标分页的唯一主键，超过 ${pageSize.toLocaleString()} 行时无法保证无重复、无遗漏；请先建立合适的主键，或在查询页使用明确的唯一排序后导出结果集`);
      }
      // OceanBase Oracle 的 ROWNUM 分页会在结果尾部附加 RN__；只写表的真实列。
      const width = columns.length || r.columns.length;
      for (const row of r.rows) await w.row(row.length > width ? row.slice(0, width) : row);
      written += r.rows.length;
      pages++;
      if (r.rows.length < pageSize) break;
      if (!pk.length) break;
      const exactIndex = new Map(r.columns.map((col, i) => [String(col.name), i]));
      const foldedIndex = new Map();
      r.columns.forEach((col, i) => {
        const folded = String(col.name).toLowerCase();
        const list = foldedIndex.get(folded) || [];
        list.push(i);
        foldedIndex.set(folded, list);
      });
      const lastRow = r.rows[r.rows.length - 1];
      lastKey = pk.map((name) => {
        let at = exactIndex.get(String(name));
        if (at === undefined) {
          const folded = foldedIndex.get(String(name).toLowerCase()) || [];
          if (folded.length === 1) [at] = folded;
        }
        if (at === undefined) throw new Error(`导出结果缺少主键列 ${name}，无法继续稳定分页`);
        return lastRow[at];
      });
    }
    const writerMeta = await w.finish();
    await promoteTemp(temp, a.file);
    return {
      rows: written, file: a.file, truncated: false, orderedBy: pk,
      pagination: pages > 1 ? 'keyset' : 'single-query',
      snapshotConsistent: pages <= 1,
      ...(writerMeta || {}),
    };
  } catch (err) {
    if (w && w.abort) await w.abort().catch(() => {});
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/** 结果集导出（内存行） */
async function exportRows(adapter, a) {
  const ctx = {
    dialect: adapter ? adapter.dialect : 'sql',
    quoteIdent: adapter ? (n) => adapter.quoteIdent(n) : (n) => '"' + String(n).replace(/"/g, '""') + '"',
    literal: adapter ? (v) => adapter.literal(v) : (v) => "'" + String(v).replace(/'/g, "''") + "'",
    blobLiteral: adapter ? (v) => adapter.blobLiteral(v) : (v) => "X'" + v.toString('hex') + "'",
    tableRef: a.sqlTableName || 'exported_table',
  };
  const temp = tempPath(a.file);
  let w;
  try {
    w = await createWriter(a.format || 'csv', temp, ctx);
    await w.header(a.columns);
    for (const row of a.rows) await w.row(row);
    const writerMeta = await w.finish();
    await promoteTemp(temp, a.file);
    return { rows: a.rows.length, file: a.file, ...(writerMeta || {}) };
  } catch (err) {
    if (w && w.abort) await w.abort().catch(() => {});
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { exportTable, exportRows, tableProjection, FORMATS };
