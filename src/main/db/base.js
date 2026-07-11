// 适配器基类：定义统一接口与通用实现（分页查询、脚本执行、应用编辑等）
const {
  splitSql, sanitizeRows, sanitizeValue, excerpt, limitQueryRows, statementKind,
  transactionControlKind, unsafeSessionMutationKind,
} = require('./sqlutil');

class BaseAdapter {
  constructor(cfg) {
    this.cfg = cfg;
    this.serverVersion = '';
    // 查询页请求的生命周期与活动驱动句柄。requestId 由 Renderer 每次运行生成，
    // 用于把“停止”精确路由到对应会话；无 requestId 时仍可兼容取消全部活动句柄。
    this._requestStates = new Map();
    this._activeRequestHandles = new Set();
    this._requestHandles = new Map();
    // 显式事务按查询标签生成的 transactionId 隔离；每项独占一个驱动会话。
    this._transactions = new Map();
  }

  get dialect() { return 'sql'; }

  /** 非空时强制网格只读，并在界面显示该原因 */
  get readonlyReason() { return null; }

  // ---- 子类必须实现 ----
  // async connect()
  // async close()
  // async listDatabases() -> [name]
  // async listObjects(db, schema) -> {tables:[{name,schema,rows,comment,engine}], views:[{name,schema}]}
  // async tableInfo(db, schema, table) -> {columns, indexes, pk, ddl}
  // async withSession(db, fn(exec), opts)   exec(sql) -> NormResult
  // ---- 可选 ----
  async listSchemas(_db) { return null; }

  /** 整库列清单 {表名: [列名...]}，供编辑器补全；默认空 */
  async listAllColumns(_db, _schema) { return {}; }

  /** 外键清单 [{name, columns:[], refSchema, refTable, refColumns:[], onUpdate, onDelete}]；默认空 */
  async listForeignKeys(_db, _schema, _table) { return []; }

  /** 其他表指向目标表的外键 [{name, schema, table, columns:[], refColumns:[]}]；默认空 */
  async listReferencingForeignKeys(_db, _schema, _table) { return []; }

  /** 表约束 [{kind:'unique'|'check', name, columns:[], expression?, indexName?}]；默认空 */
  async listConstraints(_db, _schema, _table) { return []; }

  /** 读取单个单元格的完整 BLOB（按主键定位），返回 Buffer 或 null */
  async cellBlob(db, args) {
    const { schema, table, column, pk } = args;
    const where = Object.entries(pk)
      .map(([c, v]) => (v === null ? `${this.quoteIdent(c)} IS NULL` : `${this.quoteIdent(c)} = ${this.literal(v)}`))
      .join(' AND ');
    const sql = `SELECT ${this.quoteIdent(column)} FROM ${this.qualify(db, schema, table)} WHERE ${where}`;
    const r = await this.exec(db, sql); // exec 返回原始行（未 sanitize），BLOB 为 Buffer
    const v = r && r.rows && r.rows[0] ? r.rows[0][0] : null;
    if (v === null || v === undefined) return null;
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v);
    if (typeof v === 'string') return Buffer.from(v, 'utf8');
    return Buffer.from(String(v), 'utf8');
  }

  /**
   * ER 模型：库内各表的列(含 pk/fk 标记) + 表间外键关系。
   * 返回 {tables:[{name, schema, columns:[{name,type,pk,fk}]}], relations:[{from,fromCols,to,toCols}], truncated}
   */
  async erModel(db, schema, opts = {}) {
    const objs = await this.listObjects(db, schema);
    const max = opts.maxTables || 60;
    const all = (opts.tables && opts.tables.length)
      ? opts.tables.map((t) => (typeof t === 'string' ? { name: t, schema } : { name: t.name, schema: t.schema || schema }))
      : objs.tables.map((t) => ({ name: t.name, schema: t.schema || schema || null }));
    const picked = all.slice(0, max);
    const known = new Set(picked.map((t) => t.name));
    const tables = [];
    const relations = [];
    for (const t of picked) {
      let info;
      try { info = await this.tableInfo(db, t.schema, t.name); } catch (e) { continue; }
      const pkset = new Set(info.pk || []);
      const fkcols = new Set();
      let fks = [];
      try { fks = await this.listForeignKeys(db, t.schema, t.name); } catch (e) { fks = []; }
      for (const fk of fks) {
        fk.columns.forEach((c) => fkcols.add(c));
        relations.push({ from: t.name, fromCols: fk.columns.slice(), to: fk.refTable, toCols: fk.refColumns.slice(), known: known.has(fk.refTable) });
      }
      tables.push({
        name: t.name, schema: t.schema || null,
        columns: info.columns.map((c) => ({ name: c.name, type: c.type, pk: pkset.has(c.name), fk: fkcols.has(c.name) })),
      });
    }
    return { tables, relations, truncated: all.length > picked.length, total: all.length };
  }

  /** 执行计划。返回 {format:'tree'|'table'|'text', root?, columns?, rows?, text?} */
  async explainPlan(_db, _sql) {
    throw new Error('该数据库类型暂不支持执行计划');
  }

  /** 各类对象的支持情况（树上据此决定显示哪些节点） */
  get objectCaps() {
    return { routines: false, triggers: false, events: false, sequences: false, users: false, processes: false };
  }

  /** 二进制字面量（数据传输/转储用），默认 X'hex' */
  blobLiteral(buf) {
    return "X'" + buf.toString('hex') + "'";
  }

  /** 进程/会话列表 [{id, user, db, state, timeSec, info}] */
  async listProcesses() { throw new Error('该数据库不支持进程列表'); }

  async killProcess(_id) { throw new Error('该数据库不支持结束进程'); }

  async listRoutines(_db, _schema) { return []; }   // [{name, type:'PROCEDURE'|'FUNCTION', comment?, extra?}]
  async listTriggers(_db, _schema) { return []; }   // [{name, table, timing?, event?}]
  async listEvents(_db) { return []; }              // [{name, status?, schedule?}]
  async listSequences(_db, _schema) { return []; }  // [{name}]
  async listUsers() { return []; }                  // [{name, host?, note?}]

  /** 查看对象定义（kind: PROCEDURE/FUNCTION/TRIGGER/EVENT/SEQUENCE/USER） */
  async objectDdl(_db, _schema, _kind, _name, _extra) {
    throw new Error('该数据库不支持查看此对象的定义');
  }

  /** 取消正在执行的查询；默认不支持 */
  async cancel(_requestId) { throw new Error('该数据库类型不支持取消查询'); }

  /** Read-only summary used before an interactive connection close. */
  connectionActivity() {
    return {
      requests: [...this._requestStates.values()].filter((state) => state && state.refs > 0).length,
      transactions: this._transactions.size,
    };
  }

  quoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

  literal(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return this.boolLiteral(v);
    return "'" + String(v).replace(/'/g, "''") + "'";
  }

  boolLiteral(v) { return v ? '1' : '0'; }

  /** 完整限定表名（不同方言覆盖） */
  qualify(db, schema, table) {
    return (schema ? this.quoteIdent(schema) + '.' : '') + this.quoteIdent(table);
  }

  pageSql(select, orderClause, limit, offset) {
    return `${select}${orderClause} LIMIT ${limit} OFFSET ${offset}`;
  }

  /** 单条语句执行（独立会话） */
  async exec(db, sql) {
    return this.withSession(db, (run) => run(sql));
  }

  _requestId(value) {
    const raw = value && typeof value === 'object' ? value.requestId : value;
    return raw === undefined || raw === null || raw === '' ? null : String(raw);
  }

  /** 在连接池取会话前登记请求，使排队中的请求也能收到取消信号。 */
  _beginRequest(opts) {
    const requestId = this._requestId(opts);
    if (!requestId) return null;
    let state = this._requestStates.get(requestId);
    if (!state) {
      state = { cancelled: false, refs: 0, resolveCancel: null };
      state.cancelPromise = new Promise((resolve) => { state.resolveCancel = resolve; });
    }
    state.refs++;
    this._requestStates.set(requestId, state);
    return requestId;
  }

  _endRequest(requestId) {
    if (!requestId) return;
    const state = this._requestStates.get(requestId);
    if (!state || state.refs <= 1) this._requestStates.delete(requestId);
    else state.refs--;
  }

  /** 标记单个请求已取消；未传 requestId 时标记所有运行中的查询请求。 */
  _markRequestCancelled(requestId) {
    const id = this._requestId(requestId);
    if (id) {
      const state = this._requestStates.get(id);
      if (state && !state.cancelled) {
        state.cancelled = true;
        state.resolveCancel();
      }
      return id;
    }
    for (const state of this._requestStates.values()) {
      if (!state.cancelled) {
        state.cancelled = true;
        state.resolveCancel();
      }
    }
    return null;
  }

  _assertRequestActive(requestId) {
    const id = this._requestId(requestId);
    const state = id && this._requestStates.get(id);
    if (!state || !state.cancelled) return;
    const err = new Error('查询已取消');
    err.code = 'QUERY_CANCELED';
    throw err;
  }

  _isRequestCancelled(requestId) {
    const id = this._requestId(requestId);
    const state = id && this._requestStates.get(id);
    return !!(state && state.cancelled);
  }

  /**
   * A successful driver response racing with Cancel is not proof that the
   * database stopped the statement. Report the ambiguity instead of claiming
   * either success or cancellation; writes may already have committed.
   */
  _assertRequestOutcomeKnown(requestId) {
    if (!this._isRequestCancelled(requestId)) return;
    const err = new Error('取消请求与数据库返回同时发生，执行结果未知；语句可能已经生效，请重新查询确认');
    err.code = 'QUERY_OUTCOME_UNKNOWN';
    throw err;
  }

  /**
   * 可取消的连接池获取。取消先赢时立即让当前请求返回；晚到的连接会自动释放，
   * 不会泄漏或继续执行 SQL。
   */
  async _acquireForRequest(acquire, releaseLate, requestId) {
    const id = this._requestId(requestId);
    const state = id && this._requestStates.get(id);
    if (!state) return acquire();
    this._assertRequestActive(id);
    const pending = Promise.resolve().then(acquire);
    const winner = await Promise.race([
      pending.then((value) => ({ value })),
      state.cancelPromise.then(() => ({ cancelled: true })),
    ]);
    if (!winner.cancelled) return winner.value;
    pending.then((value) => releaseLate(value)).catch(() => {});
    this._assertRequestActive(id);
    throw new Error('查询已取消');
  }

  /** 同时维护全部活动句柄和 requestId 的精确索引。 */
  _trackRequestHandle(handle, requestId) {
    if (handle === undefined || handle === null) return handle;
    this._activeRequestHandles.add(handle);
    const id = this._requestId(requestId);
    if (id) {
      if (!this._requestHandles.has(id)) this._requestHandles.set(id, new Set());
      this._requestHandles.get(id).add(handle);
    }
    return handle;
  }

  _untrackRequestHandle(handle, requestId) {
    if (handle === undefined || handle === null) return;
    this._activeRequestHandles.delete(handle);
    const id = this._requestId(requestId);
    if (!id) return;
    const handles = this._requestHandles.get(id);
    if (!handles) return;
    handles.delete(handle);
    if (!handles.size) this._requestHandles.delete(id);
  }

  _requestHandlesFor(requestId) {
    const id = this._requestId(requestId);
    return id
      ? [...(this._requestHandles.get(id) || [])]
      : [...this._activeRequestHandles];
  }

  async cancelRequestsByPrefix(prefix) {
    const safePrefix = String(prefix || '');
    if (!safePrefix) return 0;
    const ids = [...this._requestStates.keys()].filter((id) => id.startsWith(safePrefix));
    const outcomes = await Promise.allSettled(ids.map(async (id) => {
      this._markRequestCancelled(id);
      await this.cancel(id);
    }));
    const failed = outcomes.find((item) => item.status === 'rejected');
    if (failed) throw failed.reason;
    return ids.length;
  }

  /** 规范查询页的行数上限；给 maxRows + 1 探针预留一个安全整数。 */
  _scriptMaxRows(opts) {
    const n = Number(opts && opts.maxRows);
    if (!Number.isFinite(n) || n <= 0) return 2000;
    return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER - 1);
  }

  /** 仅 runScript 传入 maxRows 时才改写，内部元数据查询和导出不受影响。 */
  _prepareScriptQuery(sql, opts) {
    if (!opts || opts.maxRows === undefined) return { sql, applied: false };
    return limitQueryRows(sql, this.dialect, opts.maxRows);
  }

  _scriptStatements(sql) {
    // splitSql 与编辑器“当前语句”共用方言边界：MySQL 过程体、
    // Oracle PL/SQL + 独立 / 分隔符、SQL Server GO 批次都能继续拆后续语句。
    return splitSql(sql, this.dialect);
  }

  async _runScriptStatements(run, stmts, maxRows, requestId) {
    const out = [];
    for (const s of stmts) {
      const t0 = Date.now();
      try {
        this._assertRequestActive(requestId);
        // 执行层据此对安全的 SELECT/CTE 下推 maxRows + 1 探针，避免先完整物化再 slice。
        const r = await run(s, { maxRows, requestId });
        this._assertRequestOutcomeKnown(requestId);
        const results = r && r.multi ? r.multi : [r];
        for (const one of results) {
          out.push(this._normalizeResult(s, one, maxRows, Date.now() - t0));
        }
      } catch (err) {
        out.push({ sql: excerpt(s), ms: Date.now() - t0, error: this._errMsg(err) });
        break; // 出错即停止
      }
    }
    return out;
  }

  /** 执行 SQL 脚本（多语句），返回每条语句的结果 */
  async runScript(db, sql, opts) {
    const maxRows = this._scriptMaxRows(opts);
    const stmts = this._scriptStatements(sql);
    if (!stmts.length) return [];
    this._assertQueryPageSql(stmts);
    const requestId = this._beginRequest(opts);
    try {
      return await this.withSession(db,
        (run) => this._runScriptStatements(run, stmts, maxRows, requestId),
        { requestId, schema: opts && opts.schema });
    } finally {
      this._endRequest(requestId);
    }
  }

  // ---- 查询页显式事务 ---------------------------------------------------

  get transactionSupport() {
    const implicitCommit = this.dialect === 'mysql' || this.dialect === 'oracle';
    return {
      supported: true,
      warning: implicitCommit ? '该数据库的 DDL 可能隐式提交；手动提交模式下已禁止执行 DDL' : '',
    };
  }

  _normalizeTransactionId(value) {
    const id = String(value || '');
    if (!id || id.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('事务 ID 无效');
    return id;
  }

  transactionStatus(transactionId) {
    const support = this.transactionSupport || { supported: false };
    if (!support.supported) return { supported: false, state: 'unsupported', warning: support.warning || '' };
    const id = this._normalizeTransactionId(transactionId);
    const state = this._transactions.get(id);
    return {
      supported: true,
      state: state ? state.status : 'idle',
      db: state ? state.db : null,
      schema: state ? state.schema : null,
      warning: support.warning || '',
    };
  }

  _transactionBeginSqls() { return [this.beginSql()]; }

  _transactionEndSqls(action) { return [action === 'commit' ? 'COMMIT' : 'ROLLBACK']; }

  /** Session cleanup that runs only after COMMIT/ROLLBACK has succeeded. */
  _transactionCleanupSqls() { return []; }

  _transactionTerminalError(action, error) {
    const reason = (error && error.message) || String(error || '未知错误');
    const committing = action === 'commit';
    const wrapped = new Error(committing
      ? `提交结果未知：数据库可能已经提交，但客户端未收到确认。请重新查询数据后再决定是否重试。原始错误：${reason}`
      : `回滚结果未确认：事务会话已隔离且不会复用。请重新查询数据确认最终状态。原始错误：${reason}`);
    wrapped.code = committing ? 'TRANSACTION_COMMIT_OUTCOME_UNKNOWN' : 'TRANSACTION_ROLLBACK_UNCONFIRMED';
    wrapped.cause = error;
    return wrapped;
  }

  async _quarantineTransactionSession(runner, error) {
    if (runner && typeof runner.invalidate === 'function') {
      try { await runner.invalidate(error); } catch (e) { /* already unusable */ }
    }
  }

  /**
   * 默认实现借助 withSession 长期占用一个物理会话。MSSQL 等不能由
   * withSession 保证会话固定的驱动会覆盖此方法。
   */
  async _openExplicitTransaction(db, sessionOpts = {}) {
    let releaseHold;
    const hold = new Promise((resolve) => { releaseHold = resolve; });
    let resolveReady;
    let rejectReady;
    let readySettled = false;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let runner = null;
    let sessionCleanupError = null;
    const upstreamCleanupReporter = sessionOpts && sessionOpts.onCleanupError;
    const task = Promise.resolve().then(() => this.withSession(db, async (run) => {
      runner = run;
      try {
        for (const sql of this._transactionBeginSqls()) await run(sql);
        readySettled = true;
        resolveReady();
        await hold;
      } catch (err) {
        await this._quarantineTransactionSession(run, err);
        if (!readySettled) {
          readySettled = true;
          rejectReady(err);
        }
        throw err;
      }
    }, {
      explicitTransaction: true,
      ...sessionOpts,
      onCleanupError: (error) => {
        sessionCleanupError = error;
        if (typeof upstreamCleanupReporter === 'function') upstreamCleanupReporter(error);
      },
    })).then(
      () => ({ ok: true }),
      (error) => {
        if (!readySettled) {
          readySettled = true;
          rejectReady(error);
        }
        return { ok: false, error };
      },
    );
    try {
      await ready;
    } catch (err) {
      releaseHold();
      await task;
      throw err;
    }
    let finished = false;
    return {
      run: runner,
      requestHandle: runner && runner.requestHandle,
      finish: async (action) => {
        if (finished) throw new Error('事务已经结束');
        finished = true;
        let primaryError = null;
        let cleanupError = null;
        let decisiveFinished = false;
        try {
          for (const sql of this._transactionEndSqls(action)) await runner(sql);
          decisiveFinished = true;
        } catch (err) {
          primaryError = err;
          if (action === 'commit') {
            try {
              for (const sql of this._transactionEndSqls('rollback')) await runner(sql);
            } catch (e) { /* 连接可能已断开，释放会话仍由 finally 完成 */ }
          }
          await this._quarantineTransactionSession(runner, primaryError);
        }
        if (!primaryError) {
          try {
            for (const sql of this._transactionCleanupSqls(action)) await runner(sql);
          } catch (err) {
            cleanupError = err;
            await this._quarantineTransactionSession(runner, err);
          }
        }
        try {
          releaseHold();
        } catch (e) { /* hold is released at most once */ }
        const settled = await task;
        if (primaryError) throw primaryError;
        if (!settled.ok) {
          await this._quarantineTransactionSession(runner, settled.error);
          if (!decisiveFinished) throw settled.error;
          cleanupError = cleanupError || settled.error;
        }
        cleanupError = cleanupError || sessionCleanupError;
        return cleanupError ? {
          warning: `${action === 'commit' ? '事务已提交' : '事务已回滚'}，但会话清理失败，已销毁该会话：${(cleanupError && cleanupError.message) || cleanupError}`,
        } : null;
      },
    };
  }

  _enqueueTransaction(state, task) {
    const pending = state.queue.then(task);
    state.queue = pending.catch(() => {});
    return pending;
  }

  _assertQueryPageSql(stmts) {
    for (const sql of stmts) {
      const control = transactionControlKind(sql, this.dialect);
      if (control) {
        throw new Error(`查询页不支持在 SQL 中手写事务边界（${control}）；请使用“自动提交”和“开始 / 提交 / 回滚”按钮`);
      }
      const mutation = unsafeSessionMutationKind(sql, this.dialect);
      if (mutation) {
        throw new Error(`当前驱动不能安全保留或重置该会话状态（${mutation}）；请改为单个完整批次，或使用专用管理功能`);
      }
    }
  }

  _assertTransactionSql(stmts) {
    this._assertQueryPageSql(stmts);
    for (const sql of stmts) {
      if (this.dialect === 'mysql' && /\/\*(?:!|M!)/i.test(sql)) {
        throw new Error('手动提交模式下禁止执行 MySQL/MariaDB 可执行注释，请展开为普通 SQL 后单独执行');
      }
      const kind = statementKind(sql, this.dialect);
      const implicitCommitKinds = this.dialect === 'mysql'
        ? ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE', 'ANALYZE', 'CHECK', 'OPTIMIZE', 'REPAIR', 'CACHE', 'FLUSH', 'LOAD', 'RESET', 'STOP', 'CHANGE', 'LOCK', 'UNLOCK', 'INSTALL', 'UNINSTALL']
        : ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE', 'COMMENT', 'AUDIT', 'NOAUDIT'];
      if ((this.dialect === 'mysql' || this.dialect === 'oracle') && implicitCommitKinds.includes(kind)) {
        throw new Error('该数据库的 DDL 或管理语句会隐式提交，请开启自动提交后单独执行此语句');
      }
      if (this.dialect === 'mysql' && kind === 'SET' && /\bPASSWORD\b/i.test(sql)) {
        throw new Error('该数据库的账户管理语句会隐式提交，请开启自动提交后单独执行此语句');
      }
    }
  }

  async beginTransaction(transactionId, db, sessionOpts = {}) {
    const support = this.transactionSupport || { supported: false };
    if (!support.supported) throw new Error(support.warning || '当前数据库不支持显式事务');
    const id = this._normalizeTransactionId(transactionId);
    if (this._transactions.has(id)) throw new Error('该查询标签已有活动事务');
    if (this._transactions.size >= 32) throw new Error('活动事务过多，请先提交或回滚已有事务');
    const state = {
      id,
      db: db === undefined || db === null ? '' : String(db),
      schema: sessionOpts.schema === undefined || sessionOpts.schema === null ? '' : String(sessionOpts.schema),
      status: 'starting',
      queue: Promise.resolve(),
      session: null,
      opening: null,
      activeRequestIds: new Set(),
    };
    this._transactions.set(id, state);
    state.opening = this._openExplicitTransaction(db, { schema: state.schema || null });
    try {
      state.session = await state.opening;
      state.status = 'active';
      return this.transactionStatus(id);
    } catch (err) {
      this._transactions.delete(id);
      throw err;
    }
  }

  async runTransactionScript(transactionId, db, sql, opts) {
    const id = this._normalizeTransactionId(transactionId);
    const state = this._transactions.get(id);
    if (!state) throw new Error('事务不存在或已结束，请重新开始事务');
    if (state.status === 'starting') state.session = await state.opening;
    if (state.status === 'failed') throw new Error('事务已发生错误，请先回滚');
    if (state.status !== 'active') throw new Error('事务当前不可执行查询');
    const selectedDb = db === undefined || db === null ? '' : String(db);
    if (selectedDb !== state.db) throw new Error('活动事务期间不能切换数据库');
    const selectedSchema = opts && opts.schema !== undefined && opts.schema !== null ? String(opts.schema) : '';
    if (selectedSchema !== state.schema) throw new Error('活动事务期间不能切换模式（Schema）');
    const stmts = this._scriptStatements(sql);
    if (!stmts.length) return [];
    this._assertTransactionSql(stmts);
    return this._enqueueTransaction(state, async () => {
      if (state.status !== 'active') throw new Error(state.status === 'failed'
        ? '事务已发生错误，请先回滚' : '事务状态已改变，无法继续执行查询');
      const maxRows = this._scriptMaxRows(opts);
      const requestId = this._beginRequest(opts);
      if (requestId) state.activeRequestIds.add(requestId);
      const handle = state.session.requestHandle;
      if (handle) this._trackRequestHandle(handle, requestId);
      try {
        const results = await this._runScriptStatements(state.session.run, stmts, maxRows, requestId);
        if (results.some((item) => item.error)) state.status = 'failed';
        return results;
      } finally {
        if (handle) this._untrackRequestHandle(handle, requestId);
        if (requestId) state.activeRequestIds.delete(requestId);
        this._endRequest(requestId);
      }
    });
  }

  async commitTransaction(transactionId) {
    const id = this._normalizeTransactionId(transactionId);
    const state = this._transactions.get(id);
    if (!state) throw new Error('事务不存在或已结束');
    if (state.status === 'starting') state.session = await state.opening;
    if (state.status === 'failed') throw new Error('事务已发生错误，只能回滚');
    if (state.status !== 'active') throw new Error(`事务正在${state.status === 'committing' ? '提交' : '回滚'}，不能重复结束`);
    state.status = 'committing';
    let finishResult = null;
    try {
      await this._enqueueTransaction(state, async () => {
        if (state.status === 'failed') {
          await state.session.finish('rollback');
          throw new Error('事务执行期间发生错误，已自动回滚，不能提交');
        }
        try {
          finishResult = await state.session.finish('commit');
        } catch (error) {
          throw this._transactionTerminalError('commit', error);
        }
      });
    } finally {
      this._transactions.delete(id);
    }
    return { supported: true, state: 'idle', action: 'committed', ...(finishResult || {}) };
  }

  async rollbackTransaction(transactionId) {
    const id = this._normalizeTransactionId(transactionId);
    const state = this._transactions.get(id);
    if (!state) return { supported: true, state: 'idle', action: 'none' };
    if (state.status === 'starting') state.session = await state.opening;
    if (state.status !== 'active' && state.status !== 'failed') {
      throw new Error(`事务正在${state.status === 'committing' ? '提交' : '回滚'}，不能重复结束`);
    }
    state.status = 'rolling-back';
    let finishResult = null;
    try {
      await this._enqueueTransaction(state, async () => {
        try {
          finishResult = await state.session.finish('rollback');
        } catch (error) {
          throw this._transactionTerminalError('rollback', error);
        }
      });
    } finally {
      this._transactions.delete(id);
    }
    return { supported: true, state: 'idle', action: 'rolled-back', ...(finishResult || {}) };
  }

  async closeTransactionsByPrefix(prefix) {
    const safePrefix = String(prefix || '');
    if (!safePrefix) return;
    const entries = [...this._transactions.entries()].filter(([id]) => id.startsWith(safePrefix));
    const requestIds = new Set();
    for (const [, state] of entries) {
      for (const requestId of state.activeRequestIds || []) requestIds.add(requestId);
    }
    const cancellations = await Promise.allSettled([...requestIds].map((requestId) => this.cancel(requestId)));
    const rollbacks = await Promise.allSettled(entries.map(([id]) => this.rollbackTransaction(id)));
    const failed = [...cancellations, ...rollbacks].find((item) => item.status === 'rejected');
    if (failed) throw failed.reason;
  }

  async closeTransactions() {
    const ids = [...this._transactions.keys()];
    await Promise.all(ids.map((id) => this.rollbackTransaction(id).catch(() => {})));
  }

  _normalizeResult(s, r, maxRows, ms) {
    if (r && r.columns) {
      const total = r.rows.length;
      const truncated = total > maxRows;
      const rows = truncated ? r.rows.slice(0, maxRows) : r.rows;
      // 下推后第 maxRows+1 行只是“仍有更多”的探针，真实总数未知；未下推时驱动已完整返回，total 精确。
      const rowCountExact = !(r.rowLimitApplied && truncated);
      return {
        sql: excerpt(s), ms,
        columns: r.columns,
        rows: sanitizeRows(rows),
        rowCount: rowCountExact ? total : rows.length,
        rowCountExact,
        truncated,
      };
    }
    return {
      sql: excerpt(s), ms,
      affected: (r && r.affected) || 0,
      insertId: r && r.insertId,
      message: (r && r.message) || '',
    };
  }

  _errMsg(err) {
    let m = (err && err.message) || String(err);
    if (err && err.code && !m.includes(err.code)) m = `[${err.code}] ${m}`;
    return m;
  }

  /** 分页读取表数据 */
  async tableData(db, args) {
    const { schema, table, page = 1, pageSize = 500, where = '', orderBy = '', orderDir = 'asc', skipCount = false } = args;
    const safePage = Number(page);
    const safePageSize = Number(pageSize);
    if (!Number.isSafeInteger(safePage) || safePage < 1) throw new Error('页码必须是正整数');
    if (!Number.isSafeInteger(safePageSize) || safePageSize < 1 || safePageSize > 10000) {
      throw new Error('每页行数必须是 1 到 10000 之间的整数');
    }
    const offset = (safePage - 1) * safePageSize;
    if (!Number.isSafeInteger(offset)) throw new Error('分页偏移量过大');
    const info = await this.tableInfo(db, schema, table);
    const qtable = this.qualify(db, schema, table);
    const whereClause = where && where.trim() ? ' WHERE ' + where.trim() : '';
    const orderClause = orderBy
      ? ` ORDER BY ${this.quoteIdent(orderBy)} ${orderDir === 'desc' ? 'DESC' : 'ASC'}`
      : '';
    let total = null;
    if (!skipCount) {
      const cr = await this.exec(db, `SELECT COUNT(*) FROM ${qtable}${whereClause}`);
      total = Number(cr.rows[0][0]);
    }
    const t0 = Date.now();
    const sql = this.pageSql(`SELECT * FROM ${qtable}${whereClause}`, orderClause, safePageSize, offset);
    const r = await this.exec(db, sql);
    const typeByName = {};
    for (const c of info.columns) typeByName[c.name] = c.type;
    return {
      columns: r.columns.map((c) => ({ name: c.name, type: typeByName[c.name] || c.type || '' })),
      rows: sanitizeRows(r.rows),
      total,
      pk: info.pk,
      readonlyReason: this.readonlyReason,
      ms: Date.now() - t0,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  /** 把界面上的编辑（增/改/删）生成 SQL */
  buildEditSql(db, schema, table, edits) {
    const T = this.qualify(db, schema, table);
    const q = (n) => this.quoteIdent(n);
    const L = (v) => this.literal(v);
    const whereOf = (obj) =>
      Object.entries(obj)
        .map(([c, v]) => (v === null ? `${q(c)} IS NULL` : `${q(c)} = ${L(v)}`))
        .join(' AND ');
    const sqls = [];
    for (const e of edits) {
      if (e.kind === 'update') {
        const sets = Object.entries(e.set).map(([c, v]) => `${q(c)} = ${L(v)}`).join(', ');
        sqls.push(`UPDATE ${T} SET ${sets} WHERE ${whereOf(e.where)}`);
      } else if (e.kind === 'insert') {
        const cols = Object.keys(e.values);
        if (!cols.length) {
          sqls.push(this.dialect === 'mysql' ? `INSERT INTO ${T} () VALUES ()` : `INSERT INTO ${T} DEFAULT VALUES`);
        } else {
          sqls.push(`INSERT INTO ${T} (${cols.map(q).join(', ')}) VALUES (${cols.map((c) => L(e.values[c])).join(', ')})`);
        }
      } else if (e.kind === 'delete') {
        sqls.push(`DELETE FROM ${T} WHERE ${whereOf(e.where)}`);
      }
    }
    return sqls;
  }

  /** 在事务中应用编辑 */
  async applyEdits(db, { schema, table, edits }) {
    const sqls = this.buildEditSql(db, schema, table, edits);
    if (!sqls.length) return { count: 0, sqls: [] };
    await this.execTxn(db, sqls);
    return { count: sqls.length, sqls };
  }

  /** 顺序执行一组 DDL（无事务包装，出错即停并报告进度） */
  async execSequential(db, sqls) {
    let done = 0;
    await this.withSession(db, async (run) => {
      for (const s of sqls) {
        try {
          await run(s);
          done++;
        } catch (err) {
          throw new Error(`第 ${done + 1}/${sqls.length} 条语句失败: ${this._errMsg(err)}\nSQL: ${s}` +
            (done ? `\n（前 ${done} 条已执行，DDL 不可回滚）` : ''));
        }
      }
    });
    return { executed: done };
  }

  /** 默认事务实现：单会话 BEGIN/COMMIT */
  async execTxn(db, sqls) {
    await this.withSession(db, async (run) => {
      try {
        await run(this.beginSql());
      } catch (error) {
        await this._quarantineTransactionSession(run, error);
        throw new Error(`无法开始数据库事务，已销毁该会话：${this._errMsg(error)}`);
      }
      let idx = 0;
      try {
        for (const s of sqls) { idx++; await run(s); }
      } catch (err) {
        let rollbackError = null;
        try { await run('ROLLBACK'); } catch (error) { rollbackError = error; }
        if (rollbackError) await this._quarantineTransactionSession(run, rollbackError);
        throw new Error(`第 ${idx} 条语句失败: ${this._errMsg(err)}\nSQL: ${sqls[idx - 1]}`
          + (rollbackError ? `\n回滚结果未确认，事务会话已销毁：${this._errMsg(rollbackError)}` : ''));
      }
      try {
        await run('COMMIT');
      } catch (error) {
        try { await run('ROLLBACK'); } catch (e) { /* COMMIT 可能已生效 */ }
        await this._quarantineTransactionSession(run, error);
        throw this._transactionTerminalError('commit', error);
      }
    });
  }

  beginSql() { return 'BEGIN'; }

  // ---- 对象操作 ----
  async action(db, a) {
    const T = a.table ? this.qualify(db, a.schema, a.table) : null;
    switch (a.action) {
      case 'dropTable': return this.exec(db, `DROP TABLE ${T}`);
      case 'dropView': return this.exec(db, this.dropViewSql(T));
      case 'truncate': return this.exec(db, this.truncateSql(T));
      case 'rename': return this.exec(db, this.renameSql(db, a.schema, a.table, a.newName));
      case 'dropDatabase': return this.exec(null, `DROP DATABASE ${this.quoteIdent(a.db)}`);
      case 'createDatabase': return this.exec(null, `CREATE DATABASE ${this.quoteIdent(a.newName)}`);
      case 'dropRoutine':
        return this.exec(db, `DROP ${a.routineType === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION'} ${this.qualify(db, a.schema, a.name)}`);
      case 'dropTrigger': return this.exec(db, this.dropTriggerSql(db, a.schema, a.name, a.table));
      case 'dropEvent': return this.exec(db, `DROP EVENT ${this.qualify(db, a.schema, a.name)}`);
      case 'dropSequence': return this.exec(db, `DROP SEQUENCE ${this.qualify(db, a.schema, a.name)}`);
      case 'dropUser': return this.exec(null, this.dropUserSql(a.name, a.host));
      default: throw new Error('未知操作: ' + a.action);
    }
  }

  truncateSql(T) { return `TRUNCATE TABLE ${T}`; }

  dropViewSql(T) { return `DROP VIEW ${T}`; }

  dropTriggerSql(db, schema, name, _table) {
    return `DROP TRIGGER ${this.qualify(db, schema, name)}`;
  }

  dropUserSql(name, _host) {
    return `DROP USER ${this.quoteIdent(name)}`;
  }

  renameSql(db, schema, table, newName) {
    return `ALTER TABLE ${this.qualify(db, schema, table)} RENAME TO ${this.quoteIdent(newName)}`;
  }
}

module.exports = { BaseAdapter, sanitizeValue };
