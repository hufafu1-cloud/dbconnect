// ClickHouse 适配器（@clickhouse/client，HTTP 接口，纯 JS）
// 说明：ClickHouse 的“主键”是排序键，不保证唯一，按键 UPDATE/DELETE 不安全，
// 因此数据网格设为只读；增删改请用 SQL（INSERT / ALTER TABLE … UPDATE/DELETE）。
const { createClient } = require('@clickhouse/client');
const { BaseAdapter } = require('./base');

const QUERY_RE = /^\s*(select|with|show|desc|describe|explain|exists)\b/i;

class ClickHouseAdapter extends BaseAdapter {
  get dialect() { return 'clickhouse'; }

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
      this.clients.set(key, createClient({
        url: `${proto}://${c.host || 'localhost'}:${Number(c.port) || 8123}`,
        username: c.user || 'default',
        password: c.password || '',
        database: key,
        request_timeout: 120000,
        application: 'DBConnect',
        // 长查询经代理/负载均衡时保持连接活跃，同时消除客户端配置告警
        clickhouse_settings: { send_progress_in_http_headers: 1, http_headers_progress_interval_ms: '50000' },
      }));
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

  async withSession(db, fn) {
    // HTTP 接口无会话状态，直接执行
    return fn((sql) => this._run(db, sql));
  }

  async _run(db, sql) {
    const client = this._getClient(db);
    if (!this._aborts) this._aborts = new Set();
    const ac = new AbortController();
    this._aborts.add(ac);
    try {
      if (QUERY_RE.test(sql)) {
        const rs = await client.query({
          query: sql,
          format: 'JSONCompact',
          abort_signal: ac.signal,
          clickhouse_settings: { max_result_rows: '100000', result_overflow_mode: 'break' },
        });
        const j = await rs.json();
        return {
          columns: (j.meta || []).map((m) => ({ name: m.name, type: m.type })),
          rows: j.data || [],
        };
      }
      await client.command({ query: sql, abort_signal: ac.signal });
      return { affected: 0, message: '执行成功（ClickHouse 不返回影响行数）' };
    } finally {
      this._aborts.delete(ac);
    }
  }

  /** 中止正在执行的 HTTP 请求 */
  async cancel() {
    if (!this._aborts) return;
    for (const ac of [...this._aborts]) {
      try { ac.abort(); } catch (e) { /* ignore */ }
    }
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
    const colRes = await this._run(null,
      `SELECT name, type, default_expression, comment, is_in_primary_key, is_in_sorting_key
       FROM system.columns WHERE database = ${L(db)} AND table = ${L(table)} ORDER BY position`);
    const columns = colRes.rows.map((r) => ({
      name: r[0],
      type: r[1],
      nullable: String(r[1]).startsWith('Nullable('),
      def: r[2] || null,
      key: r[4] ? 'PRI' : '',
      extra: r[5] && !r[4] ? 'sorting key' : '',
      comment: r[3] || '',
    }));

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
