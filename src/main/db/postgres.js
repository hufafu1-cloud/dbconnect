// PostgreSQL 适配器（pg，纯 JS）
const { Pool, types } = require('pg');
const { BaseAdapter } = require('./base');

// 日期时间类型按原始字符串返回，避免时区转换困扰
for (const oid of [1082 /*date*/, 1083 /*time*/, 1114 /*timestamp*/, 1184 /*timestamptz*/, 1266 /*timetz*/]) {
  types.setTypeParser(oid, (v) => v);
}

class PostgresAdapter extends BaseAdapter {
  get dialect() { return 'postgres'; }

  async connect() {
    this.pools = new Map();
    this.defaultDb = this.cfg.database || 'postgres';
    const pool = this._getPool(this.defaultDb);
    const r = await pool.query('SELECT version()');
    const m = /^PostgreSQL\s+\S+/.exec(r.rows[0].version);
    this.serverVersion = m ? m[0] : r.rows[0].version.slice(0, 40);
  }

  _getPool(db) {
    const key = db || this.defaultDb;
    if (!this.pools.has(key)) {
      const c = this.cfg;
      const pool = new Pool({
        host: c.host || 'localhost',
        port: Number(c.port) || 5432,
        user: c.user,
        password: c.password || '',
        database: key,
        max: 4,
        connectionTimeoutMillis: 8000,
        idleTimeoutMillis: 60000,
      });
      pool.on('error', () => {}); // 空闲连接断开时不要崩进程
      this.pools.set(key, pool);
    }
    return this.pools.get(key);
  }

  async close() {
    for (const p of this.pools.values()) await p.end().catch(() => {});
    this.pools.clear();
  }

  boolLiteral(v) { return v ? 'TRUE' : 'FALSE'; }

  async withSession(db, fn) {
    const client = await this._getPool(db).connect();
    if (!this._activePids) this._activePids = new Set();
    if (client.processID) this._activePids.add(client.processID);
    try {
      return await fn((sql) => this._run(client, sql));
    } finally {
      if (client.processID) this._activePids.delete(client.processID);
      client.release();
    }
  }

  /** pg_cancel_backend 取消正在执行的会话 */
  async cancel() {
    if (!this._activePids || !this._activePids.size) return;
    const pool = this._getPool(null);
    for (const pid of [...this._activePids]) {
      await pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => {});
    }
  }

  async listAllColumns(db, schema) {
    const rows = await this._q(db,
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema = COALESCE($1, table_schema)
         AND table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_name, ordinal_position`, [schema || null]);
    const map = {};
    for (const r of rows) (map[r.t] = map[r.t] || []).push(r.c);
    return map;
  }

  async _run(client, sql) {
    const res = await client.query({ text: sql, rowMode: 'array' });
    const list = Array.isArray(res) ? res : [res];
    const norm = list.map((r) => {
      if (r.fields && r.fields.length) {
        return { columns: r.fields.map((f) => ({ name: f.name, type: '' })), rows: r.rows };
      }
      return { affected: r.rowCount || 0, message: r.command || '' };
    });
    return norm.length === 1 ? norm[0] : { multi: norm };
  }

  /** 内部元数据查询（对象行，支持参数） */
  async _q(db, sql, params) {
    const res = await this._getPool(db).query(sql, params || []);
    return res.rows;
  }

  async listDatabases() {
    const rows = await this._q(null,
      'SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname');
    return rows.map((r) => r.datname);
  }

  async listSchemas(db) {
    const rows = await this._q(db,
      "SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY nspname");
    return rows.map((r) => r.nspname);
  }

  async listObjects(db, schema) {
    const sch = schema || 'public';
    const tables = await this._q(db,
      `SELECT c.relname AS name, GREATEST(c.reltuples, 0)::bigint AS rows,
              obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname`, [sch]);
    const views = await this._q(db,
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('v', 'm') ORDER BY c.relname`, [sch]);
    return {
      tables: tables.map((t) => ({ name: t.name, schema: sch, rows: Number(t.rows), comment: t.comment || '', engine: '' })),
      views: views.map((v) => ({ name: v.name, schema: sch })),
    };
  }

  async tableInfo(db, schema, table) {
    const sch = schema || 'public';
    const reg = `${this.quoteIdent(sch)}.${this.quoteIdent(table)}`;
    const cols = await this._q(db,
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS def,
              col_description(a.attrelid, a.attnum) AS comment
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`, [reg]);
    const pkRows = await this._q(db,
      `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary`, [reg]);
    const pk = pkRows.map((r) => r.attname);
    const idxRows = await this._q(db,
      'SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = $1 AND tablename = $2', [sch, table]);
    const indexes = idxRows.map((r) => ({
      name: r.name,
      columns: [],
      def: r.def,
      unique: /\bUNIQUE\b/i.test(r.def),
      primary: /_pkey$/.test(r.name),
    }));
    const columns = cols.map((c) => ({
      name: c.name, type: c.type, nullable: c.nullable, def: c.def,
      key: pk.includes(c.name) ? 'PRI' : '', extra: '', comment: c.comment || '',
    }));
    const { synthesizeDDL } = require('./sqlutil');
    const ddl = synthesizeDDL(reg, columns, pk, indexes, (n) => this.quoteIdent(n));
    let tableComment = '';
    try {
      const r = await this._q(db, 'SELECT obj_description($1::regclass) AS c', [reg]);
      tableComment = (r[0] && r[0].c) || '';
    } catch (e) { /* ignore */ }
    return { columns, indexes, pk, ddl, tableComment };
  }
}

module.exports = { PostgresAdapter };
