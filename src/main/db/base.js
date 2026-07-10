// 适配器基类：定义统一接口与通用实现（分页查询、脚本执行、应用编辑等）
const { splitSql, sanitizeRows, sanitizeValue, excerpt, limitQueryRows } = require('./sqlutil');

class BaseAdapter {
  constructor(cfg) {
    this.cfg = cfg;
    this.serverVersion = '';
    // 查询页请求的生命周期与活动驱动句柄。requestId 由 Renderer 每次运行生成，
    // 用于把“停止”精确路由到对应会话；无 requestId 时仍可兼容取消全部活动句柄。
    this._requestStates = new Map();
    this._activeRequestHandles = new Set();
    this._requestHandles = new Map();
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

  /** 外键清单 [{name, columns:[], refSchema, refTable, refColumns:[]}]；默认空 */
  async listForeignKeys(_db, _schema, _table) { return []; }

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

  /** 执行 SQL 脚本（多语句），返回每条语句的结果 */
  async runScript(db, sql, opts) {
    const maxRows = this._scriptMaxRows(opts);
    // 存储过程/触发器等过程体内含分号：整段作为单条语句执行（MySQL 系 / Oracle 方言）
    const ROUTINE_START = {
      mysql: /^\s*CREATE\s+(DEFINER\s*=\s*\S+\s+)?(PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i,
      oracle: /^\s*(CREATE\s+(OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|TRIGGER|PACKAGE)\b|DECLARE\b|BEGIN\b)/i,
    };
    const re = ROUTINE_START[this.dialect];
    const stmts = re && re.test(sql)
      ? [sql.trim().replace(/;\s*$/, '')]
      : splitSql(sql, this.dialect);
    if (!stmts.length) return [];
    const out = [];
    const requestId = this._beginRequest(opts);
    try {
      await this.withSession(db, async (run) => {
        for (const s of stmts) {
          const t0 = Date.now();
          try {
            this._assertRequestActive(requestId);
            // 执行层据此对安全的 SELECT/CTE 下推 maxRows + 1 探针，避免先完整物化再 slice。
            const r = await run(s, { maxRows, requestId });
            const results = r && r.multi ? r.multi : [r];
            for (const one of results) {
              out.push(this._normalizeResult(s, one, maxRows, Date.now() - t0));
            }
          } catch (err) {
            out.push({ sql: excerpt(s), ms: Date.now() - t0, error: this._errMsg(err) });
            return; // 出错即停止
          }
        }
      }, { requestId });
      return out;
    } finally {
      this._endRequest(requestId);
    }
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
      await run(this.beginSql());
      let idx = 0;
      try {
        for (const s of sqls) { idx++; await run(s); }
        await run('COMMIT');
      } catch (err) {
        try { await run('ROLLBACK'); } catch (e) { /* ignore */ }
        throw new Error(`第 ${idx} 条语句失败: ${this._errMsg(err)}\nSQL: ${sqls[idx - 1]}`);
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
