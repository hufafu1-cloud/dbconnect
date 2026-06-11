// 数据导出：CSV / JSON / SQL INSERT / Excel(xlsx) / Markdown
// 两种来源：整表分页拉取（exportTable）、内存中的结果集（exportRows）
const fs = require('fs');
const { csvCell } = require('./db/sqlutil');

const FORMATS = {
  csv: { ext: 'csv', name: 'CSV 文件' },
  json: { ext: 'json', name: 'JSON 文件' },
  sql: { ext: 'sql', name: 'SQL 脚本' },
  xlsx: { ext: 'xlsx', name: 'Excel 工作簿' },
  md: { ext: 'md', name: 'Markdown 表格' },
};

function plain(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && v.__blob) return '0x' + v.hex;
  return v;
}

/** 流式写出器：按行追加，最后 finish() */
async function createWriter(format, file, ctx) {
  if (format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: false, useSharedStrings: false });
    const ws = wb.addWorksheet('Sheet1');
    return {
      header(cols) {
        ws.addRow(cols.map((c) => c.name)).commit();
      },
      row(r) {
        ws.addRow(r.map((v) => {
          const x = plain(v);
          if (x === null) return null;
          if (typeof x === 'number' || typeof x === 'boolean') return x;
          return String(x);
        })).commit();
      },
      async finish() { ws.commit(); await wb.commit(); },
    };
  }

  const ws = fs.createWriteStream(file, { encoding: 'utf8' });
  const writeLn = (s) => ws.write(s + '\r\n');
  let first = true;
  let colNames = [];

  const writers = {
    csv: {
      header(cols) { colNames = cols.map((c) => c.name); ws.write('﻿'); writeLn(colNames.map(csvCell).join(',')); },
      row(r) { writeLn(r.map((v) => csvCell(plain(v))).join(',')); },
      async finish() { await endStream(ws); },
    },
    json: {
      header(cols) { colNames = cols.map((c) => c.name); ws.write('[\n'); },
      row(r) {
        const obj = {};
        colNames.forEach((n, i) => { obj[n] = plain(r[i]); });
        ws.write((first ? '' : ',\n') + '  ' + JSON.stringify(obj));
        first = false;
      },
      async finish() { ws.write('\n]\n'); await endStream(ws); },
    },
    sql: {
      header(cols) {
        colNames = cols.map((c) => c.name);
        writeLn(`-- 由 DBConnect 导出于 ${new Date().toLocaleString('zh-CN')}`);
        writeLn('');
      },
      row(r) {
        const q = ctx.quoteIdent;
        const L = ctx.literal;
        const vals = r.map((v) => {
          const x = plain(v);
          if (x === null) return 'NULL';
          if (typeof x === 'number' || typeof x === 'boolean') return L(x);
          return L(String(x));
        });
        writeLn(`INSERT INTO ${ctx.tableRef} (${colNames.map(q).join(', ')}) VALUES (${vals.join(', ')});`);
      },
      async finish() { await endStream(ws); },
    },
    md: {
      header(cols) {
        colNames = cols.map((c) => c.name);
        writeLn('| ' + colNames.map(mdCell).join(' | ') + ' |');
        writeLn('| ' + colNames.map(() => '---').join(' | ') + ' |');
      },
      row(r) {
        writeLn('| ' + r.map((v) => {
          const x = plain(v);
          return mdCell(x === null ? '' : String(x));
        }).join(' | ') + ' |');
      },
      async finish() { await endStream(ws); },
    },
  };
  const w = writers[format];
  if (!w) throw new Error('不支持的导出格式: ' + format);
  return w;
}

function mdCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function endStream(ws) {
  return new Promise((resolve) => ws.end(resolve));
}

/** 整表导出（分页拉取） */
async function exportTable(adapter, a) {
  const ctx = {
    quoteIdent: (n) => adapter.quoteIdent(n),
    literal: (v) => adapter.literal(v),
    tableRef: a.sqlTableName ? a.sqlTableName : adapter.qualify(a.db, a.schema, a.table),
  };
  const w = await createWriter(a.format || 'csv', a.file, ctx);
  let page = 1;
  const pageSize = 5000;
  let written = 0;
  let headerDone = false;
  for (;;) {
    const r = await adapter.tableData(a.db, {
      schema: a.schema, table: a.table, page, pageSize,
      where: a.where || '', skipCount: true,
    });
    if (!headerDone) { w.header(r.columns); headerDone = true; }
    for (const row of r.rows) w.row(row);
    written += r.rows.length;
    if (r.rows.length < pageSize || written > 5000000) break;
    page++;
  }
  await w.finish();
  return { rows: written, file: a.file };
}

/** 结果集导出（内存行） */
async function exportRows(adapter, a) {
  const ctx = {
    quoteIdent: adapter ? (n) => adapter.quoteIdent(n) : (n) => '"' + String(n).replace(/"/g, '""') + '"',
    literal: adapter ? (v) => adapter.literal(v) : (v) => "'" + String(v).replace(/'/g, "''") + "'",
    tableRef: a.sqlTableName || 'exported_table',
  };
  const w = await createWriter(a.format || 'csv', a.file, ctx);
  w.header(a.columns);
  for (const row of a.rows) w.row(row);
  await w.finish();
  return { rows: a.rows.length, file: a.file };
}

module.exports = { exportTable, exportRows, FORMATS };
