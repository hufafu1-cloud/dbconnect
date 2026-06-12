// IPC 处理器：渲染进程通过 window.api 调用这里的方法
// 所有处理器统一返回 {ok:true, data} / {ok:false, error}，避免 invoke 报错信息被包一层前缀
const { ipcMain, dialog, app } = require('electron');
const fs = require('fs');
const store = require('./store');
const dbm = require('./db');
const ddl = require('./db/ddl');
const importer = require('./importer');
const exporter = require('./exporter');
const history = require('./history');

function h(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

function register(getWin) {
  // ---- 连接配置 ----
  h('conn:list', () => store.list());
  h('conn:save', (conn) => store.save(conn));
  h('conn:delete', async (id) => { await dbm.close(id); store.remove(id); });
  h('conn:test', (cfg) => dbm.testConnection(cfg));

  // ---- 数据库操作 ----
  h('db:open', (connId) => dbm.open(store.getById(connId)));
  h('db:close', (connId) => dbm.close(connId));
  h('db:databases', (connId) => dbm.get(connId).listDatabases());
  h('db:schemas', (a) => dbm.get(a.connId).listSchemas(a.db));
  h('db:objects', (a) => dbm.get(a.connId).listObjects(a.db, a.schema));
  h('db:tableInfo', (a) => dbm.get(a.connId).tableInfo(a.db, a.schema, a.table));
  h('db:tableData', (a) => dbm.get(a.connId).tableData(a.db, a));
  h('db:query', async (a) => {
    const t0 = Date.now();
    let connName = '';
    try { connName = store.getById(a.connId).name; } catch (e) { /* ignore */ }
    try {
      const results = await dbm.get(a.connId).runScript(a.db, a.sql, { maxRows: a.maxRows });
      const firstErr = results.find((r) => r.error);
      history.add({
        connId: a.connId, connName, db: a.db || '', sql: a.sql,
        ms: Date.now() - t0, ok: !firstErr, error: firstErr && firstErr.error,
        statements: results.length,
      });
      return results;
    } catch (err) {
      history.add({
        connId: a.connId, connName, db: a.db || '', sql: a.sql,
        ms: Date.now() - t0, ok: false, error: (err && err.message) || String(err), statements: 0,
      });
      throw err;
    }
  });

  // ---- 取消查询 / 列补全 ----
  h('db:cancel', (a) => dbm.get(a.connId).cancel());
  h('db:allColumns', (a) => dbm.get(a.connId).listAllColumns(a.db, a.schema));

  // ---- 扩展对象（函数/触发器/事件/序列/用户） ----
  h('db:objectCaps', (a) => dbm.get(a.connId).objectCaps);
  h('db:routines', (a) => dbm.get(a.connId).listRoutines(a.db, a.schema));
  h('db:triggers', (a) => dbm.get(a.connId).listTriggers(a.db, a.schema));
  h('db:events', (a) => dbm.get(a.connId).listEvents(a.db));
  h('db:sequences', (a) => dbm.get(a.connId).listSequences(a.db, a.schema));
  h('db:users', (a) => dbm.get(a.connId).listUsers());
  h('db:objectDdl', (a) => dbm.get(a.connId).objectDdl(a.db, a.schema, a.kind, a.name, a.extra));

  // ---- 进程监控 ----
  h('db:processes', (a) => dbm.get(a.connId).listProcesses());
  h('db:killProcess', (a) => dbm.get(a.connId).killProcess(a.pid));

  // ---- DBA 工具：数据传输 / 转储 / 运行 SQL 文件（带进度推送） ----
  const transfer = require('./transfer');
  const dbaHandler = (fn) => async (event, a) => {
    try {
      const prog = (p) => { try { event.sender.send('dba:progress', p); } catch (e) { /* ignore */ } };
      return { ok: true, data: await fn(a, prog) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  };
  ipcMain.handle('dba:transfer', dbaHandler((a, prog) =>
    transfer.runTransfer(dbm.get(a.srcConnId), dbm.get(a.dstConnId), a, prog)));
  ipcMain.handle('dba:dump', dbaHandler((a, prog) =>
    transfer.dumpSql(dbm.get(a.connId), a, prog)));
  ipcMain.handle('dba:runSqlFile', dbaHandler((a, prog) =>
    transfer.runSqlFile(dbm.get(a.connId), a, prog)));

  // ---- 结构同步 / 数据同步 ----
  const sync = require('./sync');
  ipcMain.handle('dba:structDiff', dbaHandler((a, prog) =>
    sync.diffStructure(dbm.get(a.srcConnId), dbm.get(a.dstConnId), a, prog)));
  ipcMain.handle('dba:execSqls', dbaHandler((a, prog) =>
    sync.execMany(dbm.get(a.connId), a.db, a.sqls, prog)));
  ipcMain.handle('dba:dataSync', dbaHandler((a, prog) =>
    sync.syncData(dbm.get(a.srcConnId), dbm.get(a.dstConnId), a, prog)));

  // ---- 保存的查询 ----
  const queries = require('./queries');
  h('queries:list', (a) => queries.list(a.connId));
  h('queries:save', (a) => queries.save(a));
  h('queries:rename', (a) => queries.rename(a.id, a.name));
  h('queries:delete', (a) => queries.remove(a.id));

  // ---- 查询历史 / SQL 格式化 ----
  h('history:list', (a) => history.list(a || {}));
  h('history:clear', () => history.clear());
  h('sql:format', (a) => {
    const { format } = require('sql-formatter');
    return format(a.sql, {
      language: a.language || 'sql',
      keywordCase: 'upper',
      tabWidth: 2,
      linesBetweenQueries: 1,
    });
  });
  h('db:applyEdits', (a) => dbm.get(a.connId).applyEdits(a.db, a));
  h('db:action', (a) => dbm.get(a.connId).action(a.db, a));

  // ---- 表设计器 ----
  h('design:meta', (a) => {
    const ad = dbm.get(a.connId);
    return { dialect: ad.dialect, types: ddl.typeOptions(ad.dialect), caps: ddl.caps(ad.dialect) };
  });
  h('design:model', async (a) => {
    const ad = dbm.get(a.connId);
    const info = await ad.tableInfo(a.db, a.schema, a.table);
    return ddl.infoToModel(info, a.table, ad.dialect);
  });
  h('design:ddl', (a) => {
    const ad = dbm.get(a.connId);
    return a.original
      ? ddl.buildAlterTable(ad, a.db, a.schema, a.original, a.model)
      : ddl.buildCreateTable(ad, a.db, a.schema, a.model);
  });
  h('design:apply', async (a) => {
    const ad = dbm.get(a.connId);
    const built = a.original
      ? ddl.buildAlterTable(ad, a.db, a.schema, a.original, a.model)
      : ddl.buildCreateTable(ad, a.db, a.schema, a.model);
    if (!built.sqls.length) return { executed: 0, warnings: built.warnings };
    const r = await ad.execSequential(a.db, built.sqls);
    return { ...r, warnings: built.warnings };
  });

  // ---- 数据导入 ----
  h('import:parse', (a) => importer.parseFile(a.file, a));
  // import:run 需要 event.sender 推送进度，不走 h() 包装
  ipcMain.handle('import:run', async (event, a) => {
    try {
      const ad = dbm.get(a.connId);
      // 重新完整解析（预览阶段只取了前 N 行）
      const parsed = await importer.parseFile(a.file, { ...a.parseOpts, preview: 0 });
      const data = await importer.runImport(ad, a, parsed.rows, (done, total) => {
        event.sender.send('import:progress', { done, total });
      });
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // ---- 数据导出（整表分页 / 结果集内存行；CSV/JSON/SQL/XLSX/Markdown） ----
  h('db:exportTable', (a) => exporter.exportTable(dbm.get(a.connId), a));
  h('db:exportRows', (a) => exporter.exportRows(a.connId ? dbm.get(a.connId) : null, a));

  // ---- 文件对话框 ----
  h('dlg:openFile', async (opts) => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: (opts && opts.title) || '打开文件',
      filters: (opts && opts.filters) || [],
      properties: ['openFile'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  h('dlg:saveFile', async (opts) => {
    const r = await dialog.showSaveDialog(getWin(), {
      title: (opts && opts.title) || '保存文件',
      defaultPath: (opts && opts.defaultPath) || undefined,
      filters: (opts && opts.filters) || [],
    });
    return r.canceled ? null : r.filePath;
  });

  h('file:read', (p) => fs.promises.readFile(p, 'utf8'));
  h('file:write', (p, content) => fs.promises.writeFile(p, content, 'utf8'));

  h('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  }));
}

module.exports = { register };
