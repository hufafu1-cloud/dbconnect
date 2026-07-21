// ClickHouse 适配器（@clickhouse/client，HTTP 接口，纯 JS）
// 说明：ClickHouse 的“主键”是排序键，不保证唯一，按键 UPDATE/DELETE 不安全，
// 因此数据网格设为只读；增删改请用 SQL（INSERT / ALTER TABLE … UPDATE/DELETE）。
const { createClient } = require('@clickhouse/client');
const crypto = require('crypto');
const { BaseAdapter } = require('./base');
const { statementKind, hasClickHouseFormatClause } = require('./sqlutil');

const QUERY_KINDS = new Set(['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN', 'EXISTS']);
const CANCEL_KILL_WAIT_MS = 1500;

class ClickHouseAdapter extends BaseAdapter {
  get dialect() { return 'clickhouse'; }

  get transactionSupport() {
    return { supported: false, warning: 'ClickHouse 当前连接模式不支持跨语句显式事务，仅支持自动提交' };
  }

  get readonlyReason() {
    return 'ClickHouse 表在网格中为只读（请用 SQL：INSERT / ALTER TABLE … UPDATE / DELETE）';
  }

  async connect() {
    this.clients = new Map();
    this.defaultDb = this.cfg.database || 'default';
    const r = await this._run(null, 'SELECT version()');
    this.serverVersion = 'ClickHouse ' + r.rows[0][0];
  }

  _getClient(db) {
    const key = db || this.defaultDb;
    if (!this.clients.has(key)) {
      const c = this.cfg;
      const opts = c.options || {};
      const proto = opts.https ? 'https' : 'http';
      const clientOptions = {
        url: `${proto}://${c.host || 'localhost'}:${Number(c.port) || 8123}`,
        username: c.user || 'default',
        password: c.password || '',
        database: key,
        request_timeout: 120000,
        application: 'DBPanda',
      };
      // 某些只读账号无权启用进度响应头；仅在连接配置明确要求时开启。
      if (opts.progressHeaders === true) {
        clientOptions.clickhouse_settings = {
          send_progress_in_http_headers: 1,
          http_headers_progress_interval_ms: '50000',
        };
      }
      this.clients.set(key, createClient(clientOptions));
    }
    return this.clients.get(key);
  }

  async close() {
    for (const c of this.clients.values()) await c.close().catch(() => {});
    this.clients.clear();
  }

  quoteIdent(name) { return '`' + String(name).replace(/`/g, '``') + '`'; }

  literal(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }

  qualify(db, _schema, table) {
    return (db ? this.quoteIdent(db) + '.' : '') + this.quoteIdent(table);
  }

  async withSession(db, fn, opts) {
    // HTTP 接口无会话状态，直接执行
    const requestId = this._requestId(opts);
    this._assertRequestActive(requestId);
    return fn((sql, runOpts) => {
      const effectiveOpts = requestId && !this._requestId(runOpts)
        ? { ...(runOpts || {}), requestId }
        : runOpts;
      return this._run(db, sql, effectiveOpts);
    });
  }

  async _run(db, sql, opts) {
    const requestId = this._requestId(opts);
    this._assertRequestActive(requestId);
    const kind = statementKind(sql, 'clickhouse');
    if (QUERY_KINDS.has(kind) && hasClickHouseFormatClause(sql)) {
      throw new Error('查询页会统一使用 JSONCompact 接收结果，请移除 SQL 末尾的 FORMAT 子句');
    }
    const limited = this._prepareScriptQuery(sql, opts);
    const client = this._getClient(db);
    const ac = new AbortController();
    const queryId = `dbpanda:${requestId || 'internal'}:${crypto.randomUUID()}`;
    const handle = { controller: ac, client, queryId };
    this._trackRequestHandle(handle, requestId);
    try {
      this._assertRequestActive(requestId);
      if (QUERY_KINDS.has(kind)) {
        const rs = await client.query({
          query: limited.sql,
          query_id: queryId,
          format: 'JSONCompact',
          abort_signal: ac.signal,
          clickhouse_settings: {
            // Ensure an aborted HTTP read also stops the server-side query on
            // self-managed ClickHouse installations (Cloud commonly defaults it on).
            cancel_http_readonly_queries_on_client_close: 1,
            // JSONCompact otherwise emits Int64/UInt64 and Decimal as JSON
            // numbers, which loses precision when JavaScript parses the payload.
            output_format_json_quote_64bit_integers: 1,
            output_format_json_quote_decimals: 1,
            output_format_json_quote_denormals: 1,
          },
        });
        const j = await rs.json();
        return {
          columns: (j.meta || []).map((m) => ({ name: m.name, type: m.type })),
          rows: j.data || [],
          // Never use max_result_rows + break here: ClickHouse can apply it to
          // subqueries and silently corrupt outer aggregates. Only outer SQL LIMIT
          // rewrites are marked as server-limited.
          rowLimitApplied: limited.applied,
        };
      }
      await client.command({
        query: limited.sql,
        query_id: queryId,
        abort_signal: ac.signal,
      });
      return { affected: 0, message: '执行成功（ClickHouse 不返回影响行数）' };
    } finally {
      this._untrackRequestHandle(handle, requestId);
    }
  }

  /** 中止正在执行的 HTTP 请求 */
  async cancel(requestId) {
    this._markRequestCancelled(requestId);
    const handles = this._requestHandlesFor(requestId);
    for (const handle of handles) {
      try { handle.controller.abort(); } catch (e) { /* ignore */ }
    }
    // Abort closes the client side immediately. Explicit KILL also covers
    // self-managed servers and non-read-only commands when the account permits it.
    const kills = Promise.allSettled(handles.map(async (handle) => {
      const killAbort = new AbortController();
      const killTimer = setTimeout(() => killAbort.abort(), CANCEL_KILL_WAIT_MS);
      try {
        await handle.client.command({
          query: `KILL QUERY WHERE query_id = ${this.literal(handle.queryId)} SYNC`,
          query_id: `dbpanda-cancel:${crypto.randomUUID()}`,
          abort_signal: killAbort.signal,
        });
      } catch (e) { /* query may already be gone or KILL permission may be absent */ }
      finally { clearTimeout(killTimer); }
    }));
    // The user-visible stop action is complete once the HTTP reads are aborted.
    // KILL is best effort and must not inherit the client's 120s request timeout.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, CANCEL_KILL_WAIT_MS);
      kills.finally(() => { clearTimeout(timer); resolve(); });
    });
  }

  get objectCaps() {
    return { routines: true, triggers: false, events: false, sequences: false, users: true, processes: true };
  }

  /** ClickHouse String/FixedString 可保存任意字节；unhex 可无损重建原始内容。 */
  blobLiteral(buf) {
    return `unhex('${buf.toString('hex')}')`;
  }

  async listProcesses() {
    const r = await this._run(null,
      `SELECT query_id, user, toInt32(elapsed) AS sec, query FROM system.processes ORDER BY elapsed DESC`);
    return r.rows.map(([id, user, sec, info]) => ({
      id: String(id), user: user || '', db: '', state: 'running',
      timeSec: Number(sec) || 0, info: info || '',
    }));
  }

  async killProcess(id) {
    await this._run(null, `KILL QUERY WHERE query_id = ${this.literal(String(id))}`);
  }

  /** 用户自定义函数（UDF） */
  async listRoutines() {
    try {
      const r = await this._run(null,
        "SELECT name, create_query FROM system.functions WHERE origin = 'SQLUserDefined' ORDER BY name");
      return r.rows.map(([name]) => ({ name, type: 'FUNCTION', comment: '' }));
    } catch (e) { return []; }
  }

  async listUsers() {
    try {
      const r = await this._run(null, 'SELECT name FROM system.users ORDER BY name');
      return r.rows.map(([name]) => ({ name }));
    } catch (e) { return []; }
  }

  async objectDdl(_db, _schema, kind, name) {
    if (kind === 'FUNCTION' || kind === 'PROCEDURE') {
      const r = await this._run(null,
        `SELECT create_query FROM system.functions WHERE name = ${this.literal(name)}`);
      if (!r.rows.length || !r.rows[0][0]) throw new Error('函数不存在或为内置函数');
      return r.rows[0][0];
    }
    if (kind === 'USER') {
      const r = await this._run(null, `SHOW CREATE USER ${this.quoteIdent(name)}`);
      return (r.rows[0] && r.rows[0][0]) || '';
    }
    throw new Error('不支持的对象类型: ' + kind);
  }

  async action(db, a) {
    if (a.action === 'dropRoutine') {
      return this.exec(null, `DROP FUNCTION ${this.quoteIdent(a.name)}`);
    }
    return super.action(db, a);
  }

  async explainPlan(db, sql) {
    const r = await this._run(db, 'EXPLAIN ' + sql);
    const text = r.rows.map((row) => row.join(' ')).join('\n');
    return { format: 'text', text: text || '(空计划)' };
  }

  async listAllColumns(db) {
    const r = await this._run(null,
      `SELECT table, name FROM system.columns WHERE database = ${this.literal(db)} ORDER BY table, position`);
    const map = {};
    for (const [t, c] of r.rows) (map[t] = map[t] || []).push(c);
    return map;
  }

  /** ClickHouse 无事务：顺序执行（网格只读，正常不会走到这里） */
  async execTxn(db, sqls) {
    for (const s of sqls) await this.exec(db, s);
  }

  async listDatabases() {
    const r = await this._run(null, 'SELECT name FROM system.databases ORDER BY name');
    return r.rows.map((x) => x[0]);
  }

  async listObjects(db) {
    const L = (v) => this.literal(v);
    let rows;
    try {
      const r = await this._run(null,
        `SELECT name, total_rows, comment, engine FROM system.tables
         WHERE database = ${L(db)} AND NOT is_temporary ORDER BY name`);
      rows = r.rows;
    } catch (e) {
      // 旧版本无 comment 列
      const r = await this._run(null,
        `SELECT name, NULL, '', engine FROM system.tables WHERE database = ${L(db)} ORDER BY name`);
      rows = r.rows;
    }
    const tables = [], views = [];
    for (const [name, totalRows, comment, engine] of rows) {
      if (engine === 'View' || engine === 'MaterializedView' || engine === 'LiveView') {
        views.push({ name });
      } else {
        tables.push({
          name,
          rows: totalRows === null || totalRows === undefined ? null : Number(totalRows),
          comment: comment || '',
          engine: engine || '',
        });
      }
    }
    return { tables, views };
  }

  async tableInfo(db, _schema, table) {
    const L = (v) => this.literal(v);
    let colRes;
    let advancedMetadataKnown = true;
    try {
      colRes = await this._run(null,
        `SELECT name, type, default_expression, comment, is_in_primary_key, is_in_sorting_key,
                default_kind, codec_expression, ttl_expression
         FROM system.columns WHERE database = ${L(db)} AND table = ${L(table)} ORDER BY position`);
    } catch (e) {
      advancedMetadataKnown = false;
      colRes = await this._run(null,
        `SELECT name, type, default_expression, comment, is_in_primary_key, is_in_sorting_key
         FROM system.columns WHERE database = ${L(db)} AND table = ${L(table)} ORDER BY position`);
    }
    const columns = colRes.rows.map((r) => {
      const defaultKind = String(r[6] || '').toUpperCase();
      const advanced = !advancedMetadataKnown || (!!defaultKind && defaultKind !== 'DEFAULT') || !!r[7] || !!r[8];
      return {
        name: r[0],
        type: r[1],
        nullable: /^\s*Nullable\(/i.test(String(r[1] || '')),
        def: r[2] || null,
        key: r[4] ? 'PRI' : '',
        extra: r[5] && !r[4] ? 'sorting key' : '',
        comment: r[3] || '',
        editSafe: !advanced,
        editUnsafeReason: advanced ? 'ClickHouse MATERIALIZED/ALIAS、CODEC 或 TTL 栏位不能由设计器无损修改' : '',
      };
    });

    const indexes = [];
    try {
      const meta = await this._run(null,
        `SELECT sorting_key, primary_key, partition_key FROM system.tables
         WHERE database = ${L(db)} AND name = ${L(table)}`);
      if (meta.rows.length) {
        const [sortKey, priKey, partKey] = meta.rows[0];
        if (priKey) indexes.push({ name: '(主键/排序前缀)', columns: [priKey], unique: false, primary: true });
        if (sortKey && sortKey !== priKey) indexes.push({ name: '(排序键 ORDER BY)', columns: [sortKey], unique: false, primary: false });
        if (partKey) indexes.push({ name: '(分区键 PARTITION BY)', columns: [partKey], unique: false, primary: false });
      }
      const skip = await this._run(null,
        `SELECT name, expr, type FROM system.data_skipping_indices
         WHERE database = ${L(db)} AND table = ${L(table)}`);
      for (const [name, expr, type] of skip.rows) {
        indexes.push({ name, columns: [`${expr} TYPE ${type}`], unique: false, primary: false });
      }
    } catch (e) { /* 元数据表不可用时忽略 */ }

    let ddl = '';
    try {
      const r = await this._run(null, `SHOW CREATE TABLE ${this.qualify(db, null, table)}`);
      ddl = (r.rows[0] && r.rows[0][0]) || '';
    } catch (e) { /* ignore */ }
    // Older ClickHouse versions may not expose default_kind/codec/ttl
    // columns in system.columns. If SHOW CREATE confirms that the table has
    // no advanced column clauses, ordinary columns are still safe to edit.
    // Keep the conservative read-only behavior when the DDL contains any
    // clause that the design model cannot preserve losslessly.
    if (!advancedMetadataKnown && ddl) {
      const hasAdvancedClause = /\b(?:MATERIALIZED|ALIAS|CODEC|TTL)\b/i.test(ddl);
      if (!hasAdvancedClause) {
        for (const column of columns) {
          column.editSafe = true;
          column.editUnsafeReason = '';
        }
      }
    }
    let tableComment = '';
    try {
      const r = await this._run(null,
        `SELECT comment FROM system.tables WHERE database = ${L(db)} AND name = ${L(table)}`);
      tableComment = (r.rows[0] && r.rows[0][0]) || '';
    } catch (e) { /* ignore */ }

    // 主键置空 → 网格只读（ClickHouse 主键不保证唯一，按键修改不安全）
    return { columns, indexes, pk: [], ddl, tableComment };
  }

  renameSql(db, _schema, table, newName) {
    return `RENAME TABLE ${this.qualify(db, null, table)} TO ${this.qualify(db, null, newName)}`;
  }

  /** ClickHouse 的视图是表引擎，DROP TABLE 对视图同样有效且兼容所有版本 */
  dropViewSql(T) { return `DROP TABLE ${T}`; }
}

module.exports = { ClickHouseAdapter };
