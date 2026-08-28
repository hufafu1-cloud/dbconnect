// IPC 处理器：渲染进程通过 window.api 调用这里的方法
// 所有处理器统一返回 {ok:true, data} / {ok:false, error}，避免 invoke 报错信息被包一层前缀
const { ipcMain, dialog, app, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const dbm = require('./db');
const ddl = require('./db/ddl');
const importer = require('./importer');
const exporter = require('./exporter');
const { generateTableSql } = require('./sqlGenerator');
const history = require('./history');
const safety = require('./safety');
const fileAccess = require('./fileAccess');
const sshHostKeys = require('./sshHostKeys');
const workspaceStore = require('./workspaceStore');
const settings = require('./settings');
const auditLog = require('./auditLog');
const impact = require('./impact');
const federated = require('./federated');
const broadcast = require('./broadcast');
const multiExec = require('./multiExec');
const broadcastGroups = require('./broadcastGroups');
const undo = require('./undo');
const localStore = require('./localStore');
const { parseNcxBuffer, targetLabel, MAX_FILE_BYTES } = require('./navicatNcx');
const connectionLocks = new Map();
const navicatImportSessions = new Map();
const NAVICAT_SESSION_TTL = 10 * 60 * 1000;
const MAX_NAVICAT_SESSIONS = 20;
const own = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

function rendererTransactionId(event, transactionId) {
  const id = String(transactionId || '');
  if (!id) throw new Error('事务 ID 不能为空');
  return `wc-${event.sender.id}:${id}`;
}

function rendererRequestId(event, requestId) {
  const id = String(requestId || '');
  if (!id || id.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('查询请求 ID 无效');
  return `wc-${event.sender.id}:${id}`;
}

const rendererOwners = new WeakMap();

/**
 * Transactions belong to the renderer document that opened them. Navigation,
 * reload, crash, or destruction must retire that owner's sessions; otherwise
 * a pooled connection can remain indefinitely inside an uncommitted transaction.
 *
 * 联邦查询会话同理，而且更硬：它持有的是一份拉到本地内存的数据副本，
 * 窗口没了还留着就是纯粹的内存泄漏。两者共用这一处生命周期绑定。
 */
function bindRendererOwner(event) {
  const sender = event && event.sender;
  if (!sender) throw new Error('事务调用缺少渲染进程上下文');
  let state = rendererOwners.get(sender);
  if (state) return state;
  const ownerId = sender.id;
  state = { cleanup: Promise.resolve() };
  const cleanup = () => {
    state.cleanup = state.cleanup.catch(() => {})
      .then(() => dbm.closeTransactionsByOwner(ownerId))
      .then(() => federated.closeSessionsByOwner(ownerId))
      .catch(() => {});
    return state.cleanup;
  };
  const onNavigation = (_navEvent, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) cleanup();
  };
  const onProcessGone = () => cleanup();
  const onDestroyed = () => {
    try { sender.removeListener('did-start-navigation', onNavigation); } catch (e) { /* destroyed */ }
    try { sender.removeListener('render-process-gone', onProcessGone); } catch (e) { /* destroyed */ }
    cleanup();
  };
  sender.on('did-start-navigation', onNavigation);
  sender.on('render-process-gone', onProcessGone);
  sender.once('destroyed', onDestroyed);
  rendererOwners.set(sender, state);
  return state;
}

async function rendererOwnerReady(event) {
  const state = bindRendererOwner(event);
  await state.cleanup;
  if (event.sender.isDestroyed && event.sender.isDestroyed()) throw new Error('渲染进程已关闭');
}

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

// 绝大多数处理器都从这里穿过去，因此审计日志只需要在这一处埋点：
// 后续新增的功能会自动被记录，不必回头逐个补。
function h(channel, fn, approvalOperation, passEvent = false) {
  ipcMain.handle(channel, async (event, ...args) => {
    const startedAt = Date.now();
    try {
      if (approvalOperation) safety.consume(event, approvalOperation, args[0]);
      const data = await (passEvent ? fn(event, ...args) : fn(...args));
      auditLog.record({ channel, payload: args[0], approvalOperation, ms: Date.now() - startedAt, ok: true });
      return { ok: true, data };
    } catch (err) {
      const error = (err && err.message) || String(err);
      auditLog.record({ channel, payload: args[0], approvalOperation, ms: Date.now() - startedAt, ok: false, error });
      return { ok: false, error };
    }
  });
}

async function readDesignModel(ad, target) {
  const [info, foreignKeys, constraints, referencedBy] = await Promise.all([
    ad.tableInfo(target.db, target.schema, target.table),
    ad.listForeignKeys(target.db, target.schema, target.table),
    ad.listConstraints(target.db, target.schema, target.table),
    ad.listReferencingForeignKeys(target.db, target.schema, target.table),
  ]);
  if (info && info.metadataComplete === false) {
    throw new Error('表的索引或栏位元数据读取不完整。为避免丢失数据库属性，已禁止在设计器中修改该表');
  }
  const indexesByName = new Map((info.indexes || []).map((item) => [String(item.name || '').toLowerCase(), item]));
  for (const item of constraints) {
    if (String(item.kind || '').toLowerCase() !== 'unique' || !item.indexName) continue;
    const index = indexesByName.get(String(item.indexName).toLowerCase());
    if (index && index.editable === false) item.rebuildSafe = false;
  }
  info.foreignKeys = foreignKeys;
  info.constraints = constraints;
  const model = ddl.infoToModel(info, target.table, ad.dialect);
  model._referencedBy = Array.isArray(referencedBy) ? referencedBy : [];
  return model;
}

function sameDesignModel(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch (e) { return false; }
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
    const startedAt = Date.now();
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
      auditLog.record({ channel: 'conn:save', payload: conn, approvalOperation: 'conn.save', ms: Date.now() - startedAt, ok: true });
      return { ok: true, data };
    } catch (err) {
      const error = (err && err.message) || String(err);
      auditLog.record({ channel: 'conn:save', payload: conn, approvalOperation: 'conn.save', ms: Date.now() - startedAt, ok: false, error });
      return { ok: false, error };
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
  h('db:close', (connId) => withConnectionLock(connId, async () => {
    const activity = dbm.activity(connId);
    if (activity.transactions || activity.requests) {
      const details = [
        activity.transactions ? `${activity.transactions} 个未提交事务将回滚` : '',
        activity.requests ? `${activity.requests} 个执行中查询将取消` : '',
      ].filter(Boolean).join('，');
      const confirmed = await dialog.showMessageBox(getWin(), {
        type: 'warning',
        title: '关闭数据库连接',
        message: `此连接仍有活动操作：${details}。`,
        detail: '只有明确继续才会关闭连接；事务回滚或查询取消失败时，该物理连接也会被直接退役，不会回到连接池。',
        buttons: ['取消', '关闭并回滚'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmed.response !== 1) return { closed: false, cancelled: true };
    }
    await dbm.close(connId);
    return { closed: true };
  }));
  h('db:databases', (connId) => dbm.get(connId).listDatabases());
  h('db:schemas', (a) => dbm.get(a.connId).listSchemas(a.db));
  h('db:objects', (a) => dbm.get(a.connId).listObjects(a.db, a.schema));
  h('db:tableInfo', (a) => dbm.get(a.connId).tableInfo(a.db, a.schema, a.table));
  h('db:generateTableSql', (a) => generateTableSql(dbm.get(a.connId), a));
  h('db:tableData', (a) => {
    safety.assertWhereFragment(a.where);
    return dbm.get(a.connId).tableData(a.db, a);
  });
  // ---- SQL 后悔药 / 回滚中心 ----
  //
  // 快照的入口就挂在 db:query 上（见下），这里是回滚中心自己的读写通道。
  // 全部走 h()，因此天然进审计——「谁在什么时候回滚了什么」和「谁改了数据」
  // 一样重要，路线图也明确要求回滚本身要进审计。
  const undoQuota = () => ({ keep: settings.get('undoKeep') });
  const undoSelect = (adapter, db) => (sql) => {
    // 快照读取本身也过一遍只读闸门：WHERE 里可能藏着有副作用的函数
    safety.assertNotReadOnly('db.query', { connId: null, sql });
    return adapter.exec(db, sql);
  };

  h('undo:list', () => {
    if (!localStore.available()) return { available: false, entries: [], usage: null };
    return {
      available: true,
      entries: localStore.list(undo.BUCKET).map((item) => ({
        id: item.id, kind: item.kind, createdAt: item.createdAt,
        connId: item.connId, connName: item.connName,
        db: item.db, schema: item.schema, table: item.table,
        affected: item.affected, bytes: item.bytes, sql: item.sql,
      })),
      usage: localStore.usage(undo.BUCKET),
    };
  });

  // 预览：反向 SQL + 逐行冲突标记。连接必须已打开——冲突检测要回源库读当前值。
  h('undo:preview', async (a) => {
    const snapshot = localStore.read(undo.BUCKET, a.id);
    const adapter = dbm.get(snapshot.connId);
    const conflicts = await undo.detectConflicts(
      adapter, snapshot, snapshot.rows, undoSelect(adapter, snapshot.db),
    );
    const sqls = undo.reverseSql(adapter, snapshot, snapshot.rows);
    return {
      id: snapshot.id, kind: snapshot.kind, table: snapshot.table,
      db: snapshot.db, schema: snapshot.schema, connId: snapshot.connId,
      connName: snapshot.connName, createdAt: snapshot.createdAt,
      sql: snapshot.sql, pk: snapshot.pk,
      columns: snapshot.columns.map((c) => c.name),
      rows: snapshot.rows.map((item, index) => ({
        key: item.key,
        conflict: conflicts[index].conflict,
        reason: conflicts[index].reason,
        sql: sqls[index] || '',
      })),
      conflicts: conflicts.filter((c) => c.conflict).length,
    };
  });

  // 回滚：默认只回没有冲突的行；keys 为空表示"全部（不含冲突行）"。
  // 走 db.applyEdits 的审批口径——它同样是"按主键逐行改写数据"。
  h('undo:rollback', async (a) => {
    const snapshot = localStore.read(undo.BUCKET, a.id);
    // 审批令牌是按 payload 指纹签发的，而 payload 里的 connId 由渲染进程给出。
    // 必须核对它与快照记录的连接一致，否则「在测试库上通过的审批」可以被
    // 拿去回滚生产库——审批就形同虚设了。
    if (String(a.connId || '') !== String(snapshot.connId || '')) {
      throw new Error('回滚请求的连接与快照记录的连接不一致，已拒绝');
    }
    const adapter = dbm.get(snapshot.connId);
    const conflicts = await undo.detectConflicts(
      adapter, snapshot, snapshot.rows, undoSelect(adapter, snapshot.db),
    );
    const wanted = Array.isArray(a.keys) && a.keys.length ? new Set(a.keys) : null;
    const includeConflicts = a.includeConflicts === true;
    const picked = [];
    const skipped = [];
    snapshot.rows.forEach((item, index) => {
      if (wanted && !wanted.has(item.key)) return;
      if (conflicts[index].conflict && !includeConflicts) {
        skipped.push({ key: item.key, reason: conflicts[index].reason });
        return;
      }
      picked.push(item);
    });
    if (!picked.length) {
      return { applied: 0, skipped, message: '没有可回滚的行（全部被跳过）' };
    }
    const sqls = undo.reverseSql(adapter, snapshot, picked);
    // 一个事务里做完：回滚做到一半留下的半新半旧数据比不回滚更难收拾
    await adapter.execTxn(snapshot.db, sqls);
    return { applied: sqls.length, skipped, message: '' };
  }, 'db.applyEdits');

  h('undo:remove', (a) => localStore.remove(undo.BUCKET, a.id));
  h('undo:clear', () => localStore.clear(undo.BUCKET));

  h('db:query', async (event, a) => {
    const t0 = Date.now();
    let connName = '';
    try { connName = store.getById(a.connId).name; } catch (e) { /* ignore */ }
    try {
      await rendererOwnerReady(event);
      const adapter = dbm.get(a.connId);
      const runOptions = {
        maxRows: a.maxRows,
        requestId: rendererRequestId(event, a.requestId),
        schema: a.schema,
      };
      // ---- 后悔药：执行前把将被改动的行的原值快照下来 ----
      // **显式事务里不做**：那种场景用户手上已经有 ROLLBACK，才是真正原子的撤销，
      // 而且未提交的改动做快照，事务一旦回滚快照就成了无中生有的垃圾。
      //
      // 注意判断的是「事务有没有真的开着」，不是「有没有传 transactionId」——
      // 查询标签页给每个标签固定分配一个 transactionId 当会话标识，
      // 自动提交模式下也照传。拿它当开关会把所有查询页的执行全挡在门外。
      let undoPlan = null;
      let undoBefore = null;
      let undoNote = null;
      const inExplicitTxn = !!a.transactionId
        && ['active', 'failed'].includes((adapter.transactionStatus(
          rendererTransactionId(event, a.transactionId)) || {}).state);
      if (!inExplicitTxn && settings.get('undoSnapshot') === 'on' && localStore.available()) {
        try {
          undoPlan = await undo.planFor(adapter, {
            db: a.db, schema: a.schema, sql: a.sql, maxRows: settings.get('undoMaxRows'),
          });
          if (undoPlan.supported) {
            undoBefore = await undo.captureBefore(adapter, undoPlan, undoSelect(adapter, a.db));
          } else {
            undoNote = { saved: false, reason: undoPlan.reason };
            undoPlan = null;
          }
        } catch (error) {
          // 快照失败绝不能挡住用户执行 SQL：如实记下原因，照常往下走
          undoNote = { saved: false, reason: (error && error.message) || String(error) };
          undoPlan = null;
          undoBefore = null;
        }
      }

      let results;
      if (a.transactionId) {
        results = await adapter.runQuerySessionScript(
          rendererTransactionId(event, a.transactionId), a.db, a.sql, runOptions,
        );
      } else {
        results = await adapter.runScript(a.db, a.sql, runOptions);
      }
      const firstErr = results.find((r) => r.error);

      // 执行成功才落快照：语句报错时什么都没改，存下来只会让回滚中心多一条噪音
      if (undoPlan && undoBefore && !firstErr) {
        try {
          const keys = undo.keyLiteralsOf(adapter, undoPlan, undoBefore);
          const after = await undo.captureAfter(adapter, undoPlan, keys, undoSelect(adapter, a.db));
          const saved = undo.record({
            connId: a.connId, connName, dialect: adapter.dialect, quota: undoQuota(),
          }, undoPlan, undoBefore, after);
          undoNote = {
            saved: true, id: saved.id, rows: undoPlan.kind === 'insert' ? after.length : undoBefore.length,
            kind: undoPlan.kind, table: undoPlan.target.table,
          };
        } catch (error) {
          undoNote = { saved: false, reason: `快照保存失败：${(error && error.message) || error}` };
        }
      }
      // 挂在第一个结果上带回渲染层，查询页据此显示「已存后悔药 / 未做快照（原因）」
      if (undoNote && results.length) results[0].undo = undoNote;
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
  }, 'db.query', true);

  // ---- 影响范围预检：执行 UPDATE/DELETE 前先算受影响行数 ----
  // 只跑由原语句安全改写出来的 SELECT COUNT(*)；无法保证等价的语句直接返回「无法预估」。
  h('db:impactPreview', async (event, a) => {
    const adapter = dbm.get(a.connId);
    const runCount = async (countSql) => {
      // 预检本身也要过只读闸门：WHERE 里可能藏着有副作用的函数
      safety.assertNotReadOnly('db.query', { connId: a.connId, sql: countSql });
      const options = { maxRows: 1, schema: a.schema };
      if (a.transactionId) {
        await rendererOwnerReady(event);
        return adapter.runQuerySessionScript(
          rendererTransactionId(event, a.transactionId), a.db, countSql, options,
        );
      }
      return adapter.runScript(a.db, countSql, options);
    };
    return impact.preview(a.sql, { splitStatements: safety.splitStatements, runCount });
  }, null, true);

  // ---- 取消查询 / 列补全 / 外键 / BLOB ----
  h('db:cancel', (event, a) => dbm.get(a.connId).cancel(rendererRequestId(event, a.requestId)), null, true);
  h('db:transactionStatus', async (event, a) => {
    await rendererOwnerReady(event);
    return dbm.get(a.connId).transactionStatus(rendererTransactionId(event, a.transactionId));
  }, null, true);
  h('db:transactionBegin', async (event, a) => {
    await rendererOwnerReady(event);
    return dbm.get(a.connId).beginTransaction(
      rendererTransactionId(event, a.transactionId), a.db, { schema: a.schema },
    );
  }, null, true);
  h('db:transactionCommit', async (event, a) => {
    await rendererOwnerReady(event);
    return dbm.get(a.connId).commitTransaction(rendererTransactionId(event, a.transactionId));
  }, null, true);
  h('db:transactionRollback', async (event, a) => {
    await rendererOwnerReady(event);
    return dbm.get(a.connId).rollbackTransaction(rendererTransactionId(event, a.transactionId));
  }, null, true);
  h('db:allColumns', (a) => dbm.get(a.connId).listAllColumns(a.db, a.schema));
  // AI 使用的数据库上下文：只返回元数据，不读取业务数据，也不会返回密码等连接凭据。
  h('db:aiContext', async (a) => {
    const conn = store.getById(a.connId);
    const adapter = dbm.get(a.connId);
    const db = a.db || '';
    const schema = a.schema || null;
    const objects = await adapter.listObjects(db, schema);
    const tables = Array.isArray(objects && objects.tables) ? objects.tables : [];
    const views = Array.isArray(objects && objects.views) ? objects.views : [];
    const q = String(a.query || '').trim().toLocaleLowerCase();
    const searchTerms = [...new Set([
      q,
      q.replace(/当前(?:连接|数据库|库)?|有哪些|列出|查询|查下|查看|请|帮我|一下|表结构|表列表/g, '').trim(),
      q.replace(/表(?:结构|列表)?$/g, '').trim(),
    ].filter(Boolean))];
    let columnMap = {};
    if (q) {
      try { columnMap = await adapter.listAllColumns(db, schema) || {}; } catch (e) { columnMap = {}; }
    }
    const score = (item) => {
      if (!q) return 0;
      const text = `${item.name || ''} ${item.comment || ''} ${(columnMap[item.name] || []).join(' ')}`.toLocaleLowerCase();
      if (searchTerms.some((term) => text === term)) return 100;
      if (searchTerms.some((term) => term.length > 1 && text.includes(term))) return 60;
      const parts = searchTerms.flatMap((term) => term.split(/\s+/)).filter((part) => part.length > 1);
      return parts.reduce((n, part) => n + (text.includes(part) ? 10 : 0), 0);
    };
    const ranked = tables
      .map((t) => ({ ...t, _score: score(t) }))
      .sort((x, y) => y._score - x._score || String(x.name).localeCompare(String(y.name)))
      .map(({ _score, ...t }) => t);
    const requested = Array.isArray(a.tables) ? a.tables.map((t) => String(t)).filter(Boolean) : [];
    const matched = q ? ranked.filter((t) => score(t) > 0).slice(0, 5).map((t) => t.name) : [];
    const names = [...new Set([...requested, ...matched])];
    const details = [];
    for (const name of names.slice(0, 5)) {
      try {
        const info = await adapter.tableInfo(db, schema, name);
        details.push({
          name,
          comment: (ranked.find((t) => t.name === name) || {}).comment || '',
          columns: (info && info.columns || []).slice(0, 120).map((c) => ({
            name: c.name, type: c.type, nullable: c.nullable,
            default: c.def, comment: c.comment, key: c.key,
          })),
          primaryKey: info && info.pk || [],
        });
      } catch (e) {
        details.push({ name, error: e && e.message ? e.message : String(e) });
      }
    }
    return {
      connection: { id: conn.id, name: conn.name, type: conn.type },
      database: db, schema,
      tables: ranked.slice(0, Math.max(1, Math.min(Number(a.maxTables) || 300, 500))),
      views: views.slice(0, 100), details,
      truncated: tables.length > (Number(a.maxTables) || 300),
    };
  });
  h('db:foreignKeys', (a) => dbm.get(a.connId).listForeignKeys(a.db, a.schema, a.table));
  h('db:erModel', (a) => dbm.get(a.connId).erModel(a.db, a.schema, a.opts || {}));
  h('db:explain', (a) => {
    safety.assertReadOnlyQuery(a.sql);
    return dbm.get(a.connId).explainPlan(a.db, a.sql, { schema: a.schema });
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
  h('ai:listModels', (a) => ai.listModels(store.hydrateAiConfig(a || {})));
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
  // DBA 工具的第二个统一入口：与 h() 一样在这里埋审计，传输/转储/同步都会被记录
  const dbaHandler = (fn, approvalOperation, channel) => async (event, a) => {
    const startedAt = Date.now();
    try {
      const approval = approvalOperation ? safety.consume(event, approvalOperation, a) : null;
      const prog = (p) => {
        try { event.sender.send('dba:progress', { ...p, taskId: a && a.taskId || null }); } catch (e) { /* ignore */ }
      };
      const data = await fn(a, prog, approval, event);
      auditLog.record({ channel, payload: a, approvalOperation, ms: Date.now() - startedAt, ok: true });
      return { ok: true, data };
    } catch (err) {
      const error = (err && err.message) || String(err);
      auditLog.record({ channel, payload: a, approvalOperation, ms: Date.now() - startedAt, ok: false, error });
      return { ok: false, error };
    }
  };
  ipcMain.handle('dba:transfer', dbaHandler((a, prog) =>
    transfer.runTransfer(dbm.get(a.srcConnId), dbm.get(a.dstConnId), a, prog), 'dba.transfer', 'dba:transfer'));
  ipcMain.handle('dba:dump', dbaHandler((a, prog) => {
    fileAccess.assertAllowed(a.file, 'write');
    return transfer.dumpSql(dbm.get(a.connId), a, prog);
  }, 'dba.dump', 'dba:dump'));
  ipcMain.handle('dba:runSqlFile', dbaHandler(async (a, prog, approval, event) => {
    const snapshot = await fileAccess.snapshot(a.file, approval && approval.file && approval.file.sha256);
    try {
      return await transfer.runSqlFile(dbm.get(a.connId), {
        ...a,
        taskId: rendererRequestId(event, a.taskId),
        file: snapshot.path,
      }, prog);
    } finally {
      await snapshot.cleanup();
    }
  }, 'dba.runSqlFile', 'dba:runSqlFile'));
  h('dba:cancelSqlFile', (event, a) =>
    dbm.get(a.connId).cancelOperation(rendererRequestId(event, a.taskId)), null, true);

  // ---- 多库广播执行 ----
  //
  // 目标展开只在**已经打开的连接**和它已知的库清单里做：不替用户开连接，
  // 也不去探测没打开的库有哪些库——那会让「预览一下选中了什么」变成
  // 静默发起 N 个连接。
  const broadcastDeps = {
    connections: () => store.listPublic(),
    isOpen: (connId) => dbm.isOpen(connId),
    adapter: (connId) => dbm.get(connId),
  };
  // 库清单由渲染进程给出：树上展开过的连接它手上就有，不必再查一次，
  // 也避免了「预览选中了什么」这个动作去连一堆库。
  h('bc:expand', (a) => broadcast.expandTargets(a && a.selectors, {
    ...broadcastDeps,
    databases: (connId) => ((a && a.databases) || {})[connId] || [],
  }));
  h('bc:groups', () => broadcastGroups.list());
  h('bc:saveGroup', (a) => broadcastGroups.save(a && a.name, a && a.selectors));
  h('bc:deleteGroup', (a) => broadcastGroups.remove(a && a.name));
  h('bc:cancel', (event, a) => multiExec.cancelRun(
    rendererRequestId(event, a && a.token), '用户取消了广播',
  ), null, true);
  // 审批走 db.broadcast：整批目标 + SQL 绑定一个令牌，一次确认覆盖全部生产成员
  h('bc:run', async (event, a) => {
    await rendererOwnerReady(event);
    const token = a && a.token ? rendererRequestId(event, a.token) : null;
    return broadcast.run({ ...a, token }, broadcastDeps, {
      // 每个目标一个独立的请求 ID：取消要能穿透到各自的服务端会话
      requestIdFor: (target) => rendererRequestId(
        event, `${a.token}-${target.connId}-${target.db || ''}`.replace(/[^A-Za-z0-9._:-]/g, '_'),
      ),
      onProgress: (p) => {
        try { event.sender.send('bc:progress', { ...p, token: a && a.token }); }
        catch (e) { /* 窗口可能已经关掉 */ }
      },
    });
  }, 'db.broadcast', true);

  // ---- 跨库联邦查询 ----
  // 会话持有一份拉到本地内存的数据副本，因此生命周期必须绑到发起它的渲染窗口上：
  // rendererOwnerReady 一并负责窗口导航/崩溃/关闭时把会话释放掉。
  h('fed:open', async (event) => {
    await rendererOwnerReady(event);
    return federated.openSession(event.sender.id);
  }, null, true);
  h('fed:close', (event, a) => federated.closeSession(a && a.sessionId, event.sender.id), null, true);
  h('fed:describe', (event, a) => federated.describeSession(a || {}, event.sender.id), null, true);
  h('fed:cancel', (event, a) => federated.cancelQuery({
    token: rendererRequestId(event, a && a.token),
  }), null, true);
  // 读源库的动作全部经过这里，因此审计天然覆盖：h() 就是审计埋点所在。
  h('fed:run', async (event, a) => {
    await rendererOwnerReady(event);
    const token = a && a.token ? rendererRequestId(event, a.token) : null;
    return federated.runQuery({ ...a, token }, event.sender.id, {
      onProgress: (p) => {
        try { event.sender.send('fed:progress', { ...p, token: a && a.token }); }
        catch (e) { /* 窗口可能已经关掉 */ }
      },
    });
  }, null, true);
  h('fed:saveResult', (event, a) => federated.saveResult(a || {}, event.sender.id), null, true);

  // ---- 备份 / 还原 ----
  // 备份目录由主进程决定（userData/backups），渲染进程不能指定路径，
  // 否则等于开了一个「让主进程往任意位置写文件」的口子。
  const backup = require('./backup');
  h('backup:list', (a) => backup.list(a || {}));
  h('backup:describe', (a) => backup.describe(a.id));
  h('backup:remove', (a) => backup.remove(a.id));
  h('backup:root', () => backup.backupRoot());
  h('backup:reveal', async () => {
    const { shell } = require('electron');
    await fs.promises.mkdir(backup.backupRoot(), { recursive: true });
    return shell.openPath(backup.backupRoot());
  });
  ipcMain.handle('backup:create', dbaHandler((a, prog) =>
    backup.create(dbm.get(a.connId), a, prog), null, 'backup:create'));
  // 还原是破坏性最强的写操作，走完整审批 + 只读闸门
  ipcMain.handle('backup:restore', dbaHandler(async (a, prog, approval, event) =>
    backup.restore(dbm.get(a.connId), {
      ...a, taskId: rendererRequestId(event, a.taskId || `restore-${a.id}`),
    }, prog), 'backup.restore', 'backup:restore'));

  // ---- 定时任务（仅在应用运行时生效） ----
  const scheduler = require('./scheduler');
  h('schedule:list', () => scheduler.list());
  h('schedule:save', (a) => scheduler.save(a));
  h('schedule:remove', (a) => scheduler.remove(a.id));
  h('schedule:runNow', (a) => scheduler.runNow(a.id));
  scheduler.start(() => {
    const w = getWin();
    if (w && !w.isDestroyed()) {
      try { w.webContents.send('schedule:changed'); } catch (e) { /* 窗口正在销毁 */ }
    }
  });

  // ---- 数据字典导出（走 dbaHandler：自带进度推送与审计） ----
  const dataDict = require('./dataDict');
  ipcMain.handle('dba:dataDict', dbaHandler((a, prog) => {
    fileAccess.assertAllowed(a.file, 'write');
    return dataDict.exportDict(dbm.get(a.connId), {
      db: a.db,
      schema: a.schema,
      format: a.format,
      file: a.file,
      includeViews: !!a.includeViews,
      onProgress: (p) => prog({ phase: '读取表结构', ...p }),
    });
  }, null, 'dba:dataDict'));

  // ---- 结构同步 / 数据同步 ----
  const sync = require('./sync');
  ipcMain.handle('dba:structDiff', dbaHandler((a, prog) =>
    sync.diffStructure(dbm.get(a.srcConnId), dbm.get(a.dstConnId), a, prog), null, 'dba:structDiff'));
  ipcMain.handle('dba:execSqls', dbaHandler((a, prog) =>
    sync.execMany(dbm.get(a.connId), a.db, a.sqls, prog), 'dba.execSqls', 'dba:execSqls'));
  ipcMain.handle('dba:dataSync', dbaHandler((a, prog) => {
    if (a.mode === 'script') fileAccess.assertAllowed(a.file, 'write');
    return sync.syncData(dbm.get(a.srcConnId), dbm.get(a.dstConnId), a, prog);
  }, 'dba.dataSync', 'dba:dataSync'));

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
  h('sql:statementAt', (a) => {
    const { statementAt } = require('./db/sqlutil');
    return statementAt(a && a.sql, a && a.dialect, a && a.cursor);
  });
  h('db:applyEdits', async (event, a) => {
    const adapter = dbm.get(a.connId);
    if (!a.transactionId) return adapter.applyEdits(a.db, a);
    await rendererOwnerReady(event);
    return adapter.applyQueryEdits(rendererTransactionId(event, a.transactionId), a.db, a);
  }, 'db.applyEdits', true);
  h('db:action', (a) => dbm.get(a.connId).action(a.db, a), 'db.action');

  // ---- 表设计器 ----
  h('design:meta', (a) => {
    const ad = dbm.get(a.connId);
    return {
      dialect: ad.dialect,
      types: ddl.typeOptions(ad.dialect),
      caps: ddl.caps(ad.dialect),
      designerReason: ad.designerReason || null,
    };
  });
  h('design:model', async (a) => {
    const ad = dbm.get(a.connId);
    return readDesignModel(ad, a);
  });
  h('design:ddl', (a) => {
    const ad = dbm.get(a.connId);
    return a.original
      ? ddl.buildAlterTable(ad, a.db, a.schema, a.original, a.model)
      : ddl.buildCreateTable(ad, a.db, a.schema, a.model);
  });
  h('design:addColumns', (a) => {
    const ad = dbm.get(a.connId);
    return ddl.buildAddColumns(ad, a.db, a.schema, a.table, a.columns || []);
  });
  h('design:apply', async (a) => {
    const ad = dbm.get(a.connId);
    if (a.original) {
      const live = await readDesignModel(ad, {
        db: a.db, schema: a.schema, table: a.original.table,
      });
      if (!sameDesignModel(live, a.original)) {
        throw new Error('表结构已在设计器之外发生变化。为避免覆盖他人修改，本次保存已取消；请关闭并重新打开设计页后再操作');
      }
    }
    const built = a.original
      ? ddl.buildAlterTable(ad, a.db, a.schema, a.original, a.model)
      : ddl.buildCreateTable(ad, a.db, a.schema, a.model);
    if (!built.sqls.length) return { executed: 0, warnings: built.warnings };
    if (['postgres', 'mssql', 'sqlite'].includes(ad.dialect)) {
      await ad.execTxn(a.db, built.sqls);
      return { executed: built.sqls.length, warnings: built.warnings };
    }
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
    const startedAt = Date.now();
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
        auditLog.record({ channel: 'import:run', payload: a, approvalOperation: 'import.run', ms: Date.now() - startedAt, ok: true });
        return { ok: true, data };
      } finally {
        await snapshot.cleanup();
      }
    } catch (err) {
      const error = (err && err.message) || String(err);
      auditLog.record({ channel: 'import:run', payload: a, approvalOperation: 'import.run', ms: Date.now() - startedAt, ok: false, error });
      return { ok: false, error };
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
  h('file:grantDroppedSql', async (a) => {
    const droppedPath = String(a && a.path || '');
    const displayName = String(a && a.name || path.basename(droppedPath));
    if (!droppedPath || !/\.(?:sql|txt)$/i.test(displayName)) throw new Error('只能拖入 SQL 或 TXT 文件');
    const stat = await fs.promises.stat(droppedPath);
    if (!stat.isFile()) throw new Error('拖入的项目不是文件');
    return fileAccess.grant(droppedPath, 'r');
  });

  // ---- 工作区崩溃恢复（固定 userData 路径、原子写入，不接受任意文件路径） ----
  // ---- 连接安全体检：把散在各处的事实汇总成一屏 ----
  // SSH 指纹只有主进程知道（known-hosts 文件禁止 Renderer 访问），因此在这里汇总，
  // 返回的全是结论性布尔值，不含任何凭据。
  h('security:review', () => store.listPublic().map((conn) => {
    const ssh = conn.ssh && conn.ssh.enabled ? conn.ssh : null;
    let sshHost = null;
    if (ssh) {
      const known = sshHostKeys.getKnownHost(ssh.host, ssh.port);
      sshHost = {
        host: ssh.host || '',
        port: ssh.port || 22,
        authType: ssh.authType || 'password',
        verified: !!known,
      };
    }
    return {
      id: conn.id,
      name: conn.name || conn.id,
      type: conn.type,
      env: conn.env || '',
      readOnly: conn.readOnly === true,
      // SQLite 是本地文件，没有密码概念
      needsPassword: conn.type !== 'sqlite',
      passwordOnDisk: conn.hasPassword === true,
      ssh: sshHost,
    };
  }));

  // ---- 审计日志（只读。审计日志不提供清空接口，要清理请直接删除本机文件） ----
  h('audit:read', (a) => auditLog.read(a || {}));

  // ---- 应用设置（主进程唯一来源；渲染进程只能改白名单内的键） ----
  h('settings:read', () => settings.all());
  h('settings:patch', (partial) => settings.patch(partial));

  h('workspace:read', () => workspaceStore.read());
  h('workspace:write', (snapshot) => workspaceStore.write(snapshot));
  h('workspace:clear', () => workspaceStore.clear());

  h('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  }));

  h('app:openExternal', (url) => {
    if (/^https?:\/\//i.test(String(url))) require('electron').shell.openExternal(url);
  });

  // ---- 外观：跟随系统主题 / 界面缩放 ----
  // 系统深浅色只有主进程知道，渲染进程的 prefers-color-scheme 在 Electron 里
  // 未必跟随系统设置变化，所以统一由这里判定并推送。
  h('app:systemDark', () => nativeTheme.shouldUseDarkColors);
  nativeTheme.on('updated', () => {
    const w = getWin();
    if (w && !w.isDestroyed()) {
      try { w.webContents.send('app:system-theme', nativeTheme.shouldUseDarkColors); }
      catch (e) { /* 窗口正在销毁 */ }
    }
  });
  h('app:setZoom', (percent) => {
    const value = Number(percent);
    if (!Number.isFinite(value) || value < 50 || value > 300) throw new Error('缩放比例超出允许范围');
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.setZoomFactor(value / 100);
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
