// IPC 处理器：渲染进程通过 window.api 调用这里的方法
// 所有处理器统一返回 {ok:true, data} / {ok:false, error}，避免 invoke 报错信息被包一层前缀
const { ipcMain, dialog, app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const dbm = require('./db');
const ddl = require('./db/ddl');
const importer = require('./importer');
const exporter = require('./exporter');
const history = require('./history');
const safety = require('./safety');
const fileAccess = require('./fileAccess');
const sshHostKeys = require('./sshHostKeys');
const { parseNcxBuffer, targetLabel, MAX_FILE_BYTES } = require('./navicatNcx');
const connectionLocks = new Map();
const navicatImportSessions = new Map();
const NAVICAT_SESSION_TTL = 10 * 60 * 1000;
const MAX_NAVICAT_SESSIONS = 20;
const own = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

function purgeNavicatImportSessions() {
  const now = Date.now();
  for (const [id, session] of navicatImportSessions) {
    if (session.expiresAt <= now) navicatImportSessions.delete(id);
  }
}

function createNavicatImportSession(ownerId, configs) {
  purgeNavicatImportSessions();
  while (navicatImportSessions.size >= MAX_NAVICAT_SESSIONS) {
    navicatImportSessions.delete(navicatImportSessions.keys().next().value);
  }
  const id = crypto.randomUUID();
  navicatImportSessions.set(id, {
    ownerId,
    configs,
    expiresAt: Date.now() + NAVICAT_SESSION_TTL,
  });
  return id;
}

function selectedNavicatConfigs(event, payload) {
  purgeNavicatImportSessions();
  const importId = payload && typeof payload.importId === 'string' ? payload.importId : '';
  const session = navicatImportSessions.get(importId);
  if (!session || session.ownerId !== event.sender.id) throw new Error('Navicat 导入预览已失效，请重新选择 NCX 文件');
  if (!Array.isArray(payload.selected)) throw new Error('请选择要导入的连接');
  const indices = [...new Set(payload.selected)];
  if (indices.length > session.configs.length
      || indices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= session.configs.length)) {
    throw new Error('Navicat 导入选择无效');
  }
  return { importId, session, configs: indices.map((index) => session.configs[index]) };
}

function withConnectionLock(id, task) {
  if (!id) return task();
  const previous = connectionLocks.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  connectionLocks.set(id, current);
  return current.finally(() => {
    if (connectionLocks.get(id) === current) connectionLocks.delete(id);
  });
}

function runtimeConnectionView(c) {
  const ssh = c && c.ssh ? {
    enabled: !!c.ssh.enabled,
    host: c.ssh.host || '', port: Number(c.ssh.port) || 22, user: c.ssh.user || '',
    authType: c.ssh.authType || 'password', keyFile: c.ssh.keyFile || '',
  } : null;
  return {
    type: c && c.type, host: c && c.host, port: c && Number(c.port), user: c && c.user,
    database: c && c.database, file: c && c.file, env: c && c.env,
    options: (c && c.options) || {}, ssh,
  };
}

function runtimeConnectionChanged(before, incoming) {
  if (!before) return false;
  if (own(incoming, 'password')) return true;
  if (incoming && incoming.ssh && (Object.prototype.hasOwnProperty.call(incoming.ssh, 'password')
      || Object.prototype.hasOwnProperty.call(incoming.ssh, 'passphrase'))) return true;
  const after = { ...before, ...incoming };
  if (!own(incoming, 'options')) after.options = before.options;
  if (!own(incoming, 'ssh')) after.ssh = before.ssh;
  else if (incoming.ssh && typeof incoming.ssh === 'object') {
    after.ssh = { ...(before.ssh || {}), ...incoming.ssh };
  } else after.ssh = incoming.ssh;
  return JSON.stringify(runtimeConnectionView(before)) !== JSON.stringify(runtimeConnectionView(after));
}

function storedConnection(id) {
  if (!id) return null;
  try { return store.getById(id); } catch (e) { return null; }
}

function sameSelectedPath(a, b) {
  if (!a || !b) return false;
  try { return fileAccess.normalize(a) === fileAccess.normalize(b); }
  catch (e) { return false; }
}

/**
 * Connection files are stronger capabilities than generic import/export files.
 * Existing persisted paths are migration-trusted; every new or changed path must
 * come from its fixed-purpose native dialog in this main-process lifetime.
 */
function assertConnectionFilesAuthorized(cfg) {
  const existing = storedConnection(cfg && cfg.id);
  if (cfg && cfg.type === 'sqlite') {
    const file = String(cfg.file || '').trim();
    if (!file) throw new Error('请选择 SQLite 数据库文件');
    if (file !== ':memory:'
        && !(existing && existing.type === 'sqlite' && sameSelectedPath(existing.file, file))) {
      fileAccess.assertPurposeAllowed(file, 'sqlite');
    }
  }
  const ssh = cfg && cfg.ssh;
  if (ssh && ssh.enabled && ssh.authType === 'key') {
    const keyFile = String(ssh.keyFile || '').trim();
    if (!keyFile) throw new Error('请选择 SSH 私钥文件');
    const oldSsh = existing && existing.ssh;
    if (!(oldSsh && oldSsh.enabled && oldSsh.authType === 'key'
        && sameSelectedPath(oldSsh.keyFile, keyFile))) {
      fileAccess.assertPurposeAllowed(keyFile, 'ssh-key');
    }
  }
}

function h(channel, fn, approvalOperation) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (approvalOperation) safety.consume(event, approvalOperation, args[0]);
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

function register(getWin) {
  // SSH host identity prompts are owned by the trusted main process. The
  // renderer can neither approve a fingerprint nor alter the known-host store.
  sshHostKeys.configure({ getWindow: getWin });
  // ---- 生产库操作审批（主进程签发、校验并单次消费） ----
  h('safety:inspect', (a) => safety.describe(a.operation, a.payload));
  ipcMain.handle('safety:approve', async (event, a) => {
    try {
      const info = safety.describe(a.operation, a.payload);
      if (!info.required) return { ok: true, data: null };
      const approvalFingerprint = safety.fingerprint(a.operation, a.payload);
      const ranks = { high: 3, medium: 2, low: 1 };
      const labels = { high: '高', medium: '中', low: '低' };
      const items = [...(info.items || [])]
        .sort((x, y) => (ranks[y.level] || 0) - (ranks[x.level] || 0));
      const highest = items.reduce((level, item) => (
        (ranks[item.level] || 0) > (ranks[level] || 0) ? item.level : level
      ), 'low');
      const shown = items.slice(0, 6);
      const detail = shown
        .map((item, i) => `${i + 1}. ${item.reason}${item.sql ? `\n${String(item.sql).replace(/\s+/g, ' ').slice(0, 240)}` : ''}`)
        .join('\n\n');
      const summary = `共 ${items.length} 项，最高风险：${labels[highest] || '未知'}；显示 ${shown.length} 项`
        + (items.length > shown.length ? `，另有 ${items.length - shown.length} 项未展开，请确认完整操作内容` : '');
      const confirmed = await dialog.showMessageBox(getWin(), {
        type: 'warning', title: 'DBPanda 生产库审批',
        message: info.title || '确认执行生产库操作？',
        detail: `${summary}\n\n${detail}\n\n该确认由主进程显示，操作令牌仅可使用一次。`,
        buttons: ['取消', '确认执行'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (confirmed.response !== 1) return { ok: true, data: null };
      return {
        ok: true,
        data: safety.issue(event, a.operation, a.payload, a.confirmation, approvalFingerprint),
      };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // ---- 连接配置 ----
  h('conn:list', () => store.listPublic());
  ipcMain.handle('conn:previewNavicat', async (event, file) => {
    try {
      fileAccess.assertPurposeAllowed(file, 'navicat-ncx');
      if (path.extname(file).toLowerCase() !== '.ncx') throw new Error('请选择 Navicat 导出的 .ncx 文件');
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) throw new Error('所选 NCX 路径不是文件');
      if (stat.size > MAX_FILE_BYTES) throw new Error('NCX 文件超过 20 MB，已拒绝导入');
      const parsed = parseNcxBuffer(await fs.promises.readFile(file));
      const duplicates = store.previewImportConnections(parsed.connections);
      const importId = createNavicatImportSession(event.sender.id, parsed.connections);
      return {
        ok: true,
        data: {
          importId,
          fileName: path.basename(file),
          connections: parsed.connections.map((connection, index) => ({
            index,
            type: connection.type,
            name: connection.name,
            target: targetLabel(connection),
            group: connection.group || '',
            hasSsh: !!(connection.ssh && connection.ssh.enabled),
            duplicate: !!duplicates[index].duplicate,
            credentialUpdate: !!duplicates[index].credentialUpdate,
          })),
          skipped: parsed.skipped,
          warnings: parsed.warnings,
          passwordImported: parsed.passwordImported,
          passwordFailed: parsed.passwordFailed,
        },
      };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
  ipcMain.handle('conn:importNavicat', async (event, payload) => {
    try {
      const selected = selectedNavicatConfigs(event, payload);
      if (!selected.configs.length) throw new Error('请至少选择一个可导入连接');
      const paths = [];
      for (const config of selected.configs) {
        if (config.type === 'sqlite' && config.file) paths.push(`SQLite：${config.file}`);
        if (config.ssh && config.ssh.enabled && config.ssh.keyFile) paths.push(`SSH 私钥：${config.ssh.keyFile}`);
      }
      if (paths.length) {
        const shown = paths.slice(0, 6);
        const extra = paths.length > shown.length ? `\n另有 ${paths.length - shown.length} 个路径未展开。` : '';
        const confirmed = await dialog.showMessageBox(getWin(), {
          type: 'warning',
          title: '确认导入本地文件路径',
          message: '部分 Navicat 连接引用本地文件，是否允许保存这些路径？',
          detail: `${shown.join('\n')}${extra}\n\n导入时不会复制或读取 SSH 私钥；以后使用该连接时才会读取。`,
          buttons: ['取消', '允许并导入'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (confirmed.response !== 1) return { ok: true, data: { cancelled: true } };
      }
      const result = store.importConnections(selected.configs);
      navicatImportSessions.delete(selected.importId);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
  ipcMain.handle('conn:save', async (event, conn) => {
    try {
      const data = await withConnectionLock(conn && conn.id, async () => {
        // Validate inside the per-connection lock so a queued save cannot consume
        // approval against one config version and apply it to another.
        safety.consume(event, 'conn.save', conn);
        // The approval token is an ephemeral capability, never connection data.
        const { approvalToken, _approvalToken, ...cleanConn } = conn || {};
        assertConnectionFilesAuthorized(cleanConn);
        const before = cleanConn.id ? store.listPublic().find((c) => c.id === cleanConn.id) : null;
        const shouldClose = !!(before && dbm.isOpen(cleanConn.id) && runtimeConnectionChanged(before, cleanConn));
        if (shouldClose) await dbm.close(cleanConn.id);
        const saved = store.save(cleanConn);
        // If the adapter stayed open, it already owns the current connection
        // password. Do not leave a second copy that could be reused after close.
        if (dbm.isOpen(saved.id) && saved.savePassword === false) store.clearSessionPassword(saved.id);
        return { ...saved, connectionClosed: shouldClose };
      });
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
  h('conn:delete', (id) => withConnectionLock(id, async () => { await dbm.close(id); store.remove(id); }));
  h('conn:test', (cfg) => {
    assertConnectionFilesAuthorized(cfg);
    return dbm.testConnection(store.hydrateConfig(cfg));
  });

  // ---- 连接分组 ----
  h('groups:list', () => store.listGroups());
  h('groups:add', (a) => store.addGroup(a.name));
  h('groups:rename', (a) => store.renameGroup(a.oldName, a.newName));
  h('groups:remove', (a) => store.removeGroup(a.name));

  // ---- 数据库操作 ----
  h('db:open', (payload) => {
    const request = typeof payload === 'string' ? { connId: payload } : (payload || {});
    const connId = request.connId;
    return withConnectionLock(connId, async () => {
      if (dbm.isOpen(connId)) {
        const result = await dbm.open(store.getById(connId));
        store.clearSessionPassword(connId);
        return result;
      }
      const supplied = own(request, 'password');
      if (supplied) store.setSessionPassword(connId, request.password);
      if (store.needsSessionPassword(connId)) return { needsPassword: true };
      try {
        const result = await dbm.open(store.getById(connId));
        // The connected adapter now owns the password for this connection
        // session. Closing it must require a fresh password next time.
        store.clearSessionPassword(connId);
        return result;
      } catch (error) {
        // A failed attempt must not keep retrying an unverified session password.
        store.clearSessionPassword(connId);
        throw error;
      }
    });
  });
  h('db:close', (connId) => withConnectionLock(connId, () => dbm.close(connId)));
  h('db:databases', (connId) => dbm.get(connId).listDatabases());
  h('db:schemas', (a) => dbm.get(a.connId).listSchemas(a.db));
  h('db:objects', (a) => dbm.get(a.connId).listObjects(a.db, a.schema));
  h('db:tableInfo', (a) => dbm.get(a.connId).tableInfo(a.db, a.schema, a.table));
  h('db:tableData', (a) => {
    safety.assertWhereFragment(a.where);
    return dbm.get(a.connId).tableData(a.db, a);
  });
  h('db:query', async (a) => {
    const t0 = Date.now();
    let connName = '';
    try { connName = store.getById(a.connId).name; } catch (e) { /* ignore */ }
    try {
      const results = await dbm.get(a.connId).runScript(a.db, a.sql, {
        maxRows: a.maxRows,
        requestId: a.requestId,
      });
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
  }, 'db.query');

  // ---- 取消查询 / 列补全 / 外键 / BLOB ----
  h('db:cancel', (a) => dbm.get(a.connId).cancel(a.requestId));
  h('db:allColumns', (a) => dbm.get(a.connId).listAllColumns(a.db, a.schema));
  h('db:foreignKeys', (a) => dbm.get(a.connId).listForeignKeys(a.db, a.schema, a.table));
  h('db:erModel', (a) => dbm.get(a.connId).erModel(a.db, a.schema, a.opts || {}));
  h('db:explain', (a) => {
    safety.assertReadOnlyQuery(a.sql);
    return dbm.get(a.connId).explainPlan(a.db, a.sql);
  });
  h('db:cellBlob', async (a) => {
    const buf = await dbm.get(a.connId).cellBlob(a.db, a);
    if (!buf) return null;
    const max = 8 * 1024 * 1024; // 上限 8MB
    return { base64: buf.subarray(0, max).toString('base64'), length: buf.length, truncated: buf.length > max };
  });

  // ---- AI 助手 ----
  const ai = require('./ai');
  const aiAborts = new Map();
  h('ai:getConfig', () => store.getAiConfigPublic());
  h('ai:saveConfig', (a) => store.saveAiConfig(a));
  h('ai:test', (a) => ai.test(store.hydrateAiConfig(a)));
  ipcMain.handle('ai:chat', async (event, a) => {
    const ctrl = new AbortController();
    aiAborts.set(a.reqId, ctrl);
    try {
      const cfg = store.getAiConfig();
      const content = await ai.chat(cfg, a.messages, {
        signal: ctrl.signal,
        onDelta: (d) => { try { event.sender.send('ai:delta', { reqId: a.reqId, delta: d }); } catch (e) { /* ignore */ } },
      });
      return { ok: true, data: { content } };
    } catch (err) {
      if (ctrl.signal.aborted) return { ok: false, error: '已取消' };
      return { ok: false, error: (err && err.message) || String(err) };
    } finally {
      aiAborts.delete(a.reqId);
    }
  });
  ipcMain.handle('ai:cancel', (e, a) => {
    const c = aiAborts.get(a.reqId);
    if (c) c.abort();
    return { ok: true, data: true };
  });

  // ---- 在库中查找 ----
  const search = require('./search');
  ipcMain.handle('db:search', async (event, a) => {
    try {
      const prog = (p) => { try { event.sender.send('search:progress', p); } catch (e) { /* ignore */ } };
      return { ok: true, data: await search.searchDatabase(dbm.get(a.connId), a, prog) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

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
  h('db:killProcess', (a) => dbm.get(a.connId).killProcess(a.pid), 'db.killProcess');
  h('db:killProcesses', async (a) => {
    let count = 0;
    for (const pid of a.pids || []) { await dbm.get(a.connId).killProcess(pid); count++; }
    return { count };
  }, 'db.killProcesses');

  // ---- DBA 工具：数据传输 / 转储 / 运行 SQL 文件（带进度推送） ----
  const transfer = require('./transfer');
  const dbaHandler = (fn, approvalOperation) => async (event, a) => {
    try {
      const approval = approvalOperation ? safety.consume(event, approvalOperation, a) : null;
      const prog = (p) => { try { event.sender.send('dba:progress', p); } catch (e) { /* ignore */ } };
      return { ok: true, data: await fn(a, prog, approval) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  };
  ipcMain.handle('dba:transfer', dbaHandler((a, prog) =>
    transfer.runTransfer(dbm.get(a.srcConnId), dbm.get(a.dstConnId), a, prog), 'dba.transfer'));
  ipcMain.handle('dba:dump', dbaHandler((a, prog) => {
    fileAccess.assertAllowed(a.file, 'write');
    return transfer.dumpSql(dbm.get(a.connId), a, prog);
  }, 'dba.dump'));
  ipcMain.handle('dba:runSqlFile', dbaHandler(async (a, prog, approval) => {
    const snapshot = await fileAccess.snapshot(a.file, approval && approval.file && approval.file.sha256);
    try {
      return await transfer.runSqlFile(dbm.get(a.connId), { ...a, file: snapshot.path }, prog);
    } finally {
      await snapshot.cleanup();
    }
  }, 'dba.runSqlFile'));

  // ---- 结构同步 / 数据同步 ----
  const sync = require('./sync');
  ipcMain.handle('dba:structDiff', dbaHandler((a, prog) =>
    sync.diffStructure(dbm.get(a.srcConnId), dbm.get(a.dstConnId), a, prog)));
  ipcMain.handle('dba:execSqls', dbaHandler((a, prog) =>
    sync.execMany(dbm.get(a.connId), a.db, a.sqls, prog), 'dba.execSqls'));
  ipcMain.handle('dba:dataSync', dbaHandler((a, prog) => {
    if (a.mode === 'script') fileAccess.assertAllowed(a.file, 'write');
    return sync.syncData(dbm.get(a.srcConnId), dbm.get(a.dstConnId), a, prog);
  }, 'dba.dataSync'));

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
  h('db:applyEdits', (a) => dbm.get(a.connId).applyEdits(a.db, a), 'db.applyEdits');
  h('db:action', (a) => dbm.get(a.connId).action(a.db, a), 'db.action');

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
  }, 'design.apply');

  // ---- 数据导入 ----
  h('import:parse', (a) => {
    fileAccess.assertAllowed(a.file, 'read');
    return importer.parseFile(a.file, a);
  });
  // import:run 需要 event.sender 推送进度，不走 h() 包装
  ipcMain.handle('import:run', async (event, a) => {
    try {
      const approval = safety.consume(event, 'import.run', a);
      const snapshot = await fileAccess.snapshot(a.file, approval && approval.file && approval.file.sha256);
      try {
        const ad = dbm.get(a.connId);
        // 重新完整解析（预览阶段只取了前 N 行）；始终读取审批后校验过的私有快照。
        const parsed = await importer.parseFile(snapshot.path, { ...a.parseOpts, preview: 0 });
        const data = await importer.runImport(ad, a, parsed.rows, (done, total) => {
          event.sender.send('import:progress', { done, total });
        });
        return { ok: true, data };
      } finally {
        await snapshot.cleanup();
      }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // ---- 数据导出（整表分页 / 结果集内存行；CSV/JSON/SQL/XLSX/Markdown） ----
  h('db:exportTable', (a) => {
    fileAccess.assertAllowed(a.file, 'write');
    safety.assertWhereFragment(a.where);
    return exporter.exportTable(dbm.get(a.connId), a);
  }, 'db.exportTable');
  h('db:exportRows', (a) => {
    fileAccess.assertAllowed(a.file, 'write');
    return exporter.exportRows(a.connId ? dbm.get(a.connId) : null, a);
  });

  // ---- 文件对话框 ----
  h('dlg:openFile', async (opts) => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: (opts && opts.title) || '打开文件',
      filters: (opts && opts.filters) || [],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    if (opts && opts.access === 'path') return r.filePaths[0];
    return fileAccess.grant(r.filePaths[0], 'r');
  });
  h('dlg:openNavicatConnections', async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: '选择 Navicat 连接导出文件',
      filters: [{ name: 'Navicat 连接文件', extensions: ['ncx'] }],
      properties: ['openFile'],
    });
    return r.canceled || !r.filePaths.length ? null : fileAccess.grantPurpose(r.filePaths[0], 'navicat-ncx');
  });
  h('dlg:openEditableSqlFile', async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: '打开并允许覆盖 SQL 文件',
      filters: [{ name: 'SQL 文件', extensions: ['sql', 'txt'] }],
      properties: ['openFile'],
    });
    return r.canceled || !r.filePaths.length ? null : fileAccess.grant(r.filePaths[0], 'rw');
  });
  h('dlg:openSQLiteFile', async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: '选择并授权 SQLite 数据库文件',
      filters: [{ name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }, { name: '所有文件', extensions: ['*'] }],
      properties: ['openFile'],
    });
    return r.canceled || !r.filePaths.length ? null : fileAccess.grantPurpose(r.filePaths[0], 'sqlite');
  });
  h('dlg:saveSQLiteFile', async () => {
    const r = await dialog.showSaveDialog(getWin(), {
      title: '新建并授权 SQLite 数据库文件',
      defaultPath: 'new.db',
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
    });
    return r.canceled ? null : fileAccess.grantPurpose(r.filePath, 'sqlite');
  });
  h('dlg:openSshKeyFile', async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: '选择并授权 SSH 私钥文件',
      filters: [{ name: '所有文件', extensions: ['*'] }],
      properties: ['openFile'],
    });
    return r.canceled || !r.filePaths.length ? null : fileAccess.grantPurpose(r.filePaths[0], 'ssh-key');
  });
  h('dlg:saveFile', async (opts) => {
    const r = await dialog.showSaveDialog(getWin(), {
      title: (opts && opts.title) || '保存文件',
      defaultPath: (opts && opts.defaultPath) || undefined,
      filters: (opts && opts.filters) || [],
    });
    if (r.canceled) return null;
    if (opts && opts.access === 'path') return r.filePath;
    return fileAccess.grant(r.filePath, 'w');
  });

  h('file:read', (p) => fs.promises.readFile(fileAccess.assertAllowed(p, 'read'), 'utf8'));
  h('file:write', (p, content) => fs.promises.writeFile(fileAccess.assertAllowed(p, 'write'), content, 'utf8'));
  h('file:writeBase64', (p, b64) => fs.promises.writeFile(fileAccess.assertAllowed(p, 'write'), Buffer.from(b64, 'base64')));

  h('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  }));

  h('app:openExternal', (url) => {
    if (/^https?:\/\//i.test(String(url))) require('electron').shell.openExternal(url);
  });

  h('app:winCmd', (cmd) => {
    const w = getWin();
    if (!w || w.isDestroyed()) return;
    switch (cmd) {
      case 'minimize': w.minimize(); break;
      case 'maximize': w.isMaximized() ? w.unmaximize() : w.maximize(); break;
      case 'close': w.close(); break;
      case 'devtools': w.webContents.toggleDevTools(); break;
      default: break;
    }
  });
}

module.exports = { register };
