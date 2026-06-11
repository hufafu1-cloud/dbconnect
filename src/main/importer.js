// 数据导入：解析 CSV / JSON / Excel，批量 INSERT 到目标表
const fs = require('fs');
const path = require('path');

/** 健壮的 CSV 解析（支持引号、转义引号、字段内换行、CRLF） */
function parseCsv(text, delimiter) {
  const d = delimiter === '\\t' ? '\t' : (delimiter || ',');
  const rows = [];
  let row = [];
  let cur = '';
  let inQuote = false;
  let i = 0;
  const n = text.length;
  // 去 BOM
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 2; continue; }
        inQuote = false; i++; continue;
      }
      cur += ch; i++; continue;
    }
    if (ch === '"') { inQuote = true; i++; continue; }
    if (ch === d) { row.push(cur); cur = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  // 去掉末尾完全空白的行
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

function decodeBuffer(buf, encoding) {
  const enc = (encoding || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(enc === 'gbk' ? 'gbk' : enc).decode(buf);
  } catch (e) {
    return buf.toString('utf8');
  }
}

/**
 * 解析文件 → {columns:[名称], rows:[[..]], totalRows, sheets?}
 * opts: {format:'csv'|'json'|'xlsx', delimiter, encoding, headerRow:bool, sheet, preview:数量|0全部}
 */
async function parseFile(file, opts) {
  const format = opts.format || detectFormat(file);
  const previewN = opts.preview || 0;

  if (format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const sheets = wb.worksheets.map((s) => s.name);
    const ws = opts.sheet ? wb.getWorksheet(opts.sheet) : wb.worksheets[0];
    if (!ws) throw new Error('工作表不存在: ' + (opts.sheet || '(第一个)'));
    const raw = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      // row.values 下标从 1 开始
      for (let c = 1; c <= ws.columnCount; c++) {
        let v = row.getCell(c).value;
        if (v === null || v === undefined) v = null;
        else if (typeof v === 'object') {
          if (v instanceof Date) v = fmtDate(v);
          else if (v.richText) v = v.richText.map((t) => t.text).join('');
          else if (v.text !== undefined) v = String(v.text);
          else if (v.result !== undefined) v = v.result instanceof Date ? fmtDate(v.result) : String(v.result ?? '');
          else if (v.error) v = null;
          else v = String(v);
        } else if (typeof v !== 'string') v = String(v);
        vals.push(v);
      }
      raw.push(vals);
    });
    return finishParse(raw, opts.headerRow !== false, previewN, sheets);
  }

  const buf = fs.readFileSync(file);
  if (buf.length > 300 * 1024 * 1024) throw new Error('文件超过 300MB，请拆分后导入');

  if (format === 'json') {
    const text = decodeBuffer(buf, opts.encoding);
    let data = JSON.parse(text);
    if (!Array.isArray(data)) {
      if (Array.isArray(data.data)) data = data.data;
      else if (Array.isArray(data.rows)) data = data.rows;
      else throw new Error('JSON 须为对象数组（或含 data/rows 数组字段）');
    }
    const colSet = [];
    for (const o of data) {
      if (o && typeof o === 'object') {
        for (const k of Object.keys(o)) if (!colSet.includes(k)) colSet.push(k);
      }
    }
    const rows = data.map((o) => colSet.map((k) => {
      const v = o ? o[k] : null;
      if (v === null || v === undefined) return null;
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    }));
    return {
      columns: colSet,
      rows: previewN ? rows.slice(0, previewN) : rows,
      totalRows: rows.length,
    };
  }

  // CSV / TSV / TXT
  const text = decodeBuffer(buf, opts.encoding);
  const raw = parseCsv(text, opts.delimiter);
  return finishParse(raw, opts.headerRow !== false, previewN, null);
}

function finishParse(raw, headerRow, previewN, sheets) {
  if (!raw.length) return { columns: [], rows: [], totalRows: 0, sheets };
  let columns;
  let dataRows;
  if (headerRow) {
    columns = raw[0].map((c, i) => String(c || '').trim() || `列${i + 1}`);
    dataRows = raw.slice(1);
  } else {
    columns = raw[0].map((_, i) => `列${i + 1}`);
    dataRows = raw;
  }
  // 规整每行长度
  dataRows = dataRows.map((r) => {
    if (r.length === columns.length) return r;
    const x = r.slice(0, columns.length);
    while (x.length < columns.length) x.push(null);
    return x;
  });
  return {
    columns,
    rows: previewN ? dataRows.slice(0, previewN) : dataRows,
    totalRows: dataRows.length,
    sheets,
  };
}

function detectFormat(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.xlsx') return 'xlsx';
  return 'csv';
}

function fmtDate(d) {
  const p = (x, w) => String(x).padStart(w || 2, '0');
  if (d.getHours() || d.getMinutes() || d.getSeconds()) {
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 执行导入。
 * args: {db, schema, table, mapping:[{target, sourceIndex}], emptyAsNull, truncate, errorMode:'abort'|'skip', batchSize}
 * data: {rows} 已解析的全部数据行
 * progress(done, total) 回调
 */
async function runImport(adapter, args, rows, progress) {
  const { db, schema, table, mapping } = args;
  const batchSize = Math.min(Math.max(args.batchSize || 500, 1), 2000);
  const emptyAsNull = !!args.emptyAsNull;
  const T = adapter.qualify(db, schema, table);
  const q = (n) => adapter.quoteIdent(n);
  const cols = mapping.map((m) => m.target);
  const colSql = cols.map(q).join(', ');
  const isOracle = adapter.dialect === 'oracle';

  if (args.truncate) {
    await adapter.exec(db, adapter.truncateSql(T));
  }

  const toLiteral = (v) => {
    if (v === null || v === undefined) return 'NULL';
    const s = String(v);
    if (emptyAsNull && s === '') return 'NULL';
    return adapter.literal(s);
  };
  const rowValues = (r) => '(' + mapping.map((m) => toLiteral(r[m.sourceIndex])).join(', ') + ')';

  let done = 0;
  let ok = 0;
  let failed = 0;
  const errors = [];
  const total = rows.length;

  for (let i = 0; i < total; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    try {
      if (isOracle) {
        // Oracle 方言不支持多行 VALUES：逐行 INSERT，包在一个事务里
        const sqls = batch.map((r) => `INSERT INTO ${T} (${colSql}) VALUES ${rowValues(r)}`);
        await adapter.execTxn(db, sqls);
      } else {
        const sql = `INSERT INTO ${T} (${colSql}) VALUES ${batch.map(rowValues).join(', ')}`;
        await adapter.exec(db, sql);
      }
      ok += batch.length;
    } catch (err) {
      if (args.errorMode === 'abort') {
        throw new Error(`第 ${i + 1}~${i + batch.length} 行导入失败：${err.message}\n已成功导入 ${ok} 行（已提交部分不回滚）`);
      }
      // skip 模式：退化为逐行导入，挽救本批中的正常行
      for (const r of batch) {
        try {
          await adapter.exec(db, `INSERT INTO ${T} (${colSql}) VALUES ${rowValues(r)}`);
          ok++;
        } catch (e2) {
          failed++;
          if (errors.length < 5) errors.push(e2.message);
        }
      }
    }
    done = Math.min(i + batchSize, total);
    if (progress) progress(done, total);
  }
  return { ok, failed, errors };
}

module.exports = { parseFile, parseCsv, runImport, detectFormat };
