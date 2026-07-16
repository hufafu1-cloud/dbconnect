// DBA 工具：数据传输（跨连接/跨方言）、转储 SQL 文件、运行 SQL 文件
const fs = require('fs');
const ddl = require('./db/ddl');
const { splitSql, excerpt } = require('./db/sqlutil');
const { valueLiteral } = require('./db/valueLiteral');
const { tableProjection } = require('./exporter');

/** 原始分页读取（不做展示用清洗），自动剔除 Oracle 分页辅助列 RN__ */
async function fetchRawPage(ad, db, schema, table, columns, pkCols, page, pageSize) {
  const qtable = ad.qualify(db, schema, table);
  const order = pkCols && pkCols.length
    ? ' ORDER BY ' + pkCols.map((c) => ad.quoteIdent(c)).join(', ')
    : '';
  const projection = ad.dialect === 'mssql' ? tableProjection(ad, columns || []) : '*';
  const sql = ad.pageSql(`SELECT ${projection} FROM ${qtable}`, order, pageSize, (page - 1) * pageSize);
  const r = await ad.exec(db, sql);
  const rnIdx = r.columns.findIndex((c) => c.name === 'RN__');
  if (rnIdx >= 0) {
    r.columns.splice(rnIdx, 1);
    for (const row of r.rows) row.splice(rnIdx, 1);
  }
  return r;
}

/** 批量插入一页数据（Oracle 方言逐行 + 事务，其余多行 VALUES） */
async function insertRows(ad, db, schema, table, columns, rows) {
  if (!rows.length) return;
  const T = ad.qualify(db, schema, table);
  const colNames = columns.map((column) => typeof column === 'string' ? column : column.name);
  const colTypes = columns.map((column) => typeof column === 'string' ? '' : column.type || '');
  const colSql = colNames.map((c) => ad.quoteIdent(c)).join(', ');
  const rowVals = (r) => '(' + r.map((v, i) => valueLiteral(ad, v, colTypes[i])).join(', ') + ')';
  if (ad.dialect === 'oracle') {
    const sqls = rows.map((r) => `INSERT INTO ${T} (${colSql}) VALUES ${rowVals(r)}`);
    await ad.execTxn(db, sqls);
  } else {
    await ad.exec(db, `INSERT INTO ${T} (${colSql}) VALUES ${rows.map(rowVals).join(', ')}`);
  }
}

/**
 * 数据传输
 * args: {srcDb, srcSchema, dstDb, dstSchema, tables:[{name, schema?}|名],
 *        createTable, dropExisting, copyData, batchSize, stopOnError}
 * progress({table, phase, tablesDone, tablesTotal, rows})
 */
async function runTransfer(srcAd, dstAd, args, progress) {
  const {
    srcDb, srcSchema, dstDb, dstSchema, tables,
    createTable = true, dropExisting = false, copyData = true,
    batchSize = 500, stopOnError = true,
  } = args;
  const report = { tables: [], warnings: [], errors: [] };
  let done = 0;

  for (const t of tables) {
    const table = typeof t === 'string' ? t : t.name;
    const sSchema = (typeof t === 'object' && t.schema) || srcSchema;
    const dSchema = dstSchema !== undefined && dstSchema !== null && dstSchema !== ''
      ? dstSchema : ((typeof t === 'object' && t.schema) || null);
    const item = { table, rows: 0, status: 'ok' };
    try {
      progress({ table, phase: '读取结构', tablesDone: done, tablesTotal: tables.length, rows: 0 });
      const info = await srcAd.tableInfo(srcDb, sSchema, table);
      let model = ddl.infoToModel(info, table, srcAd.dialect);
      const tr = ddl.translateModel(model, srcAd.dialect, dstAd.dialect);
      model = tr.model;
      for (const w of tr.warnings) report.warnings.push(`[${table}] ${w}`);

      if (dropExisting) {
        try {
          await dstAd.exec(dstDb, `DROP TABLE ${dstAd.qualify(dstDb, dSchema, table)}`);
        } catch (e) { /* 目标不存在则忽略 */ }
      }
      if (createTable) {
        progress({ table, phase: '创建表', tablesDone: done, tablesTotal: tables.length, rows: 0 });
        const built = ddl.buildCreateTable(dstAd, dstDb, dSchema, model);
        for (const w of built.warnings) report.warnings.push(`[${table}] ${w}`);
        await dstAd.execSequential(dstDb, built.sqls);
      }
      if (copyData) {
        const pkCols = info.pk || [];
        let page = 1;
        for (;;) {
          const r = await fetchRawPage(srcAd, srcDb, sSchema, table, info.columns, pkCols, page, batchSize);
          if (!r.rows.length) break;
          await insertRows(dstAd, dstDb, dSchema, table, r.columns, r.rows);
          item.rows += r.rows.length;
          progress({ table, phase: '复制数据', tablesDone: done, tablesTotal: tables.length, rows: item.rows });
          if (r.rows.length < batchSize) break;
          page++;
        }
      }
    } catch (err) {
      item.status = 'error';
      item.error = (err && err.message) || String(err);
      report.errors.push(`[${table}] ${item.error}`);
      if (stopOnError) {
        report.tables.push(item);
        throw new Error(`表 ${table} 传输失败：${item.error}\n已完成 ${done}/${tables.length} 个表`);
      }
    }
    report.tables.push(item);
    done++;
    progress({ table, phase: '完成', tablesDone: done, tablesTotal: tables.length, rows: item.rows });
  }
  return report;
}

/**
 * 转储 SQL 文件（结构 + 数据）；同方言还原最稳
 * args: {db, schema, tables, file, includeDrop, includeData, batchSize}
 */
async function dumpSql(ad, args, progress) {
  const { db, schema, tables, file, includeDrop = true, includeData = true, batchSize = 1000 } = args;
  const ws = fs.createWriteStream(file, { encoding: 'utf8' });
  const w = (s) => ws.write(s + '\r\n');
  let totalRows = 0;
  try {
    w('-- DBPanda SQL 转储');
    w(`-- 数据库: ${db || ''}${schema ? ' / ' + schema : ''}`);
    w(`-- 时间: ${new Date().toLocaleString('zh-CN')}`);
    w('');
    let done = 0;
    for (const t of tables) {
      const table = typeof t === 'string' ? t : t.name;
      const sch = (typeof t === 'object' && t.schema) || schema;
      progress({ table, phase: '结构', tablesDone: done, tablesTotal: tables.length, rows: totalRows });
      const info = await ad.tableInfo(db, sch, table);
      const T = ad.qualify(db, sch, table);
      w('-- ----------------------------');
      w(`-- 表 ${table}`);
      w('-- ----------------------------');
      if (includeDrop) {
        if (ad.dialect === 'oracle') w(`-- DROP TABLE ${T}; -- Oracle 模式请按需手动放开`);
        else w(`DROP TABLE IF EXISTS ${T};`);
      }
      let createSql = info.ddl;
      if (!createSql) {
        const model = ddl.infoToModel(info, table, ad.dialect);
        createSql = ddl.buildCreateTable(ad, db, sch, model).sqls.join(';\r\n');
      }
      w(createSql.replace(/;?\s*$/, ';'));
      w('');
      if (includeData) {
        const pkCols = info.pk || [];
        let page = 1;
        for (;;) {
          const r = await fetchRawPage(ad, db, sch, table, info.columns, pkCols, page, batchSize);
          if (!r.rows.length) break;
          const colSql = r.columns.map((c) => ad.quoteIdent(c.name)).join(', ');
          const columnTypes = r.columns.map((column) => column.type || '');
          for (const row of r.rows) {
            w(`INSERT INTO ${T} (${colSql}) VALUES (${row.map((v, i) => valueLiteral(ad, v, columnTypes[i])).join(', ')});`);
          }
          totalRows += r.rows.length;
          progress({ table, phase: '数据', tablesDone: done, tablesTotal: tables.length, rows: totalRows });
          if (r.rows.length < batchSize) break;
          page++;
        }
        w('');
      }
      done++;
    }
  } finally {
    await new Promise((res) => ws.end(res));
  }
  return { tables: tables.length, rows: totalRows, file };
}

/**
 * 运行 SQL 文件（流式执行，不进编辑器）
 * args: {db, file, encoding, stopOnError}
 */
async function runSqlFile(ad, args, progress) {
  const buf = fs.readFileSync(args.file);
  if (buf.length > 500 * 1024 * 1024) throw new Error('文件超过 500MB，请拆分后执行');
  let text;
  try {
    text = new TextDecoder((args.encoding || 'utf-8').toLowerCase() === 'gbk' ? 'gbk' : 'utf-8').decode(buf);
  } catch (e) {
    text = buf.toString('utf8');
  }
  const stmts = ad.dialect === 'mssql'
    ? text.split(/^\s*GO\s*(?:--.*)?$/gim).map((s) => s.trim()).filter(Boolean)
    : splitSql(text, ad.dialect);
  const t0 = Date.now();
  let executed = 0;
  let failed = 0;
  const errors = [];
  await ad.withSession(args.db, async (run) => {
    for (const s of stmts) {
      try {
        await run(s);
        executed++;
      } catch (err) {
        failed++;
        if (errors.length < 5) errors.push(`${excerpt(s, 60)} → ${(err && err.message) || err}`);
        if (args.stopOnError) {
          throw new Error(`第 ${executed + failed} 条语句失败：${(err && err.message) || err}\nSQL: ${excerpt(s, 120)}\n已执行 ${executed} 条`);
        }
      }
      if ((executed + failed) % 50 === 0) {
        progress({ phase: '执行', done: executed + failed, total: stmts.length });
      }
    }
  });
  progress({ phase: '完成', done: executed + failed, total: stmts.length });
  return { total: stmts.length, executed, failed, errors, ms: Date.now() - t0 };
}

module.exports = { runTransfer, dumpSql, runSqlFile, valueLiteral };
