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

  // ---------- 对象覆盖：函数 / 触发器 / 序列 / 角色 ----------
  get objectCaps() {
    return { routines: true, triggers: true, events: false, sequences: true, users: true, processes: true };
  }

  blobLiteral(buf) { return "'\\x" + buf.toString('hex') + "'"; }

  async listProcesses() {
    const rows = await this._q(null,
      `SELECT pid, usename, datname, state,
              COALESCE(EXTRACT(EPOCH FROM now() - query_start), 0)::int AS sec, query
       FROM pg_stat_activity WHERE pid <> pg_backend_pid() ORDER BY pid`);
    return rows.map((r) => ({
      id: String(r.pid), user: r.usename || '', db: r.datname || '',
      state: r.state || '', timeSec: Number(r.sec) || 0, info: r.query || '',
    }));
  }

  async killProcess(id) {
    await this._getPool(null).query('SELECT pg_terminate_backend($1)', [Number(id)]);
  }

  async listRoutines(db, schema) {
    const rows = await this._q(db,
      `SELECT p.proname AS name,
              CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS type,
              pg_get_function_identity_arguments(p.oid) AS args,
              obj_description(p.oid, 'pg_proc') AS comment
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
       ORDER BY p.proname`, [schema || 'public']);
    return rows.map((r) => ({ name: r.name, type: r.type, comment: r.comment || '', extra: r.args || '' }));
  }

  async listTriggers(db, schema) {
    const rows = await this._q(db,
      `SELECT t.tgname AS name, c.relname AS tbl FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY t.tgname`, [schema || 'public']);
    return rows.map((r) => ({ name: r.name, table: r.tbl }));
  }

  async listSequences(db, schema) {
    const rows = await this._q(db,
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'S' AND n.nspname = $1 ORDER BY c.relname`, [schema || 'public']);
    return rows.map((r) => ({ name: r.name }));
  }

  async listUsers() {
    const rows = await this._q(null,
      `SELECT rolname AS name, rolsuper, rolcanlogin FROM pg_roles
       WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname`);
    return rows.map((r) => ({
      name: r.name,
      note: [r.rolsuper ? '超级用户' : '', r.rolcanlogin ? '' : '不可登录'].filter(Boolean).join(' · '),
    }));
  }

  async objectDdl(db, schema, kind, name, extra) {
    const sch = schema || 'public';
    if (kind === 'PROCEDURE' || kind === 'FUNCTION') {
      const rows = await this._q(db,
        `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = $2
           AND pg_get_function_identity_arguments(p.oid) = $3`, [sch, name, extra || '']);
      if (!rows.length) throw new Error('函数不存在');
      return rows[0].def;
    }
    if (kind === 'TRIGGER') {
      const rows = await this._q(db,
        `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal`, [sch, name]);
      if (!rows.length) throw new Error('触发器不存在');
      return rows.map((r) => r.def + ';').join('\n');
    }
    if (kind === 'SEQUENCE') {
      const rows = await this._q(db,
        `SELECT * FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`, [sch, name]);
      if (!rows.length) throw new Error('序列不存在');
      const s = rows[0];
      return `CREATE SEQUENCE ${this.quoteIdent(sch)}.${this.quoteIdent(name)}\n` +
        `  INCREMENT BY ${s.increment_by}\n  MINVALUE ${s.min_value}\n  MAXVALUE ${s.max_value}\n` +
        `  START WITH ${s.start_value}\n  CACHE ${s.cache_size}${s.cycle ? '\n  CYCLE' : ''};\n` +
        `-- 当前值: ${s.last_value === null ? '(未使用)' : s.last_value}`;
    }
    if (kind === 'USER') {
      const rows = await this._q(null,
        `SELECT r.*, ARRAY(SELECT b.rolname FROM pg_auth_members m
                JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid) AS member_of
         FROM pg_roles r WHERE r.rolname = $1`, [name]);
      if (!rows.length) throw new Error('角色不存在');
      const r = rows[0];
      return [
        `-- 角色 ${r.rolname} 的属性`,
        `超级用户: ${r.rolsuper ? '是' : '否'}`,
        `可登录: ${r.rolcanlogin ? '是' : '否'}`,
        `可建库: ${r.rolcreatedb ? '是' : '否'}`,
        `可建角色: ${r.rolcreaterole ? '是' : '否'}`,
        `连接数限制: ${r.rolconnlimit === -1 ? '无限制' : r.rolconnlimit}`,
        `所属角色: ${(r.member_of || []).join(', ') || '(无)'}`,
      ].join('\n');
    }
    throw new Error('不支持的对象类型: ' + kind);
  }

  dropTriggerSql(db, schema, name, table) {
    return `DROP TRIGGER ${this.quoteIdent(name)} ON ${this.qualify(db, schema, table)}`;
  }

  dropUserSql(name) {
    return `DROP ROLE ${this.quoteIdent(name)}`;
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

  async listForeignKeys(db, schema, table) {
    const sch = schema || 'public';
    const rows = await this._q(db,
      `SELECT con.conname AS name, att.attname AS col,
              nsp2.nspname AS refschema, cl2.relname AS reftab, att2.attname AS refcol, k.ord
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = cl.relnamespace
       JOIN pg_class cl2 ON cl2.oid = con.confrelid
       JOIN pg_namespace nsp2 ON nsp2.oid = cl2.relnamespace
       JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(att, fatt, ord) ON true
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.att
       JOIN pg_attribute att2 ON att2.attrelid = con.confrelid AND att2.attnum = k.fatt
       WHERE con.contype = 'f' AND nsp.nspname = $1 AND cl.relname = $2
       ORDER BY con.conname, k.ord`, [sch, table]);
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.name)) map.set(r.name, { name: r.name, columns: [], refSchema: r.refschema === 'public' ? null : r.refschema, refTable: r.reftab, refColumns: [] });
      const fk = map.get(r.name);
      fk.columns.push(r.col);
      fk.refColumns.push(r.refcol);
    }
    return [...map.values()];
  }

  async explainPlan(db, sql) {
    const res = await this._getPool(db).query('EXPLAIN (FORMAT JSON, VERBOSE FALSE, COSTS TRUE) ' + sql);
    let plan = res.rows[0] && Object.values(res.rows[0])[0];
    if (typeof plan === 'string') plan = JSON.parse(plan);
    const arr = Array.isArray(plan) ? plan : [plan];
    const conv = (p) => {
      const d = [];
      if (p['Relation Name']) d.push('on ' + p['Relation Name'] + (p['Alias'] && p['Alias'] !== p['Relation Name'] ? ' ' + p['Alias'] : ''));
      if (p['Index Name']) d.push('using ' + p['Index Name']);
      if (p['Join Type']) d.push(p['Join Type'] + ' join');
      if (p['Hash Cond']) d.push(p['Hash Cond']);
      if (p['Index Cond']) d.push('Index Cond: ' + p['Index Cond']);
      if (p['Recheck Cond']) d.push('Recheck: ' + p['Recheck Cond']);
      if (p['Filter']) d.push('Filter: ' + p['Filter']);
      if (p['Sort Key']) d.push('Sort: ' + [].concat(p['Sort Key']).join(', '));
      return {
        title: p['Node Type'] + (p['Parallel Aware'] ? ' (parallel)' : ''),
        detail: d.join('  ·  '),
        rows: p['Plan Rows'] != null ? Number(p['Plan Rows']) : null,
        cost: p['Total Cost'] != null ? Number(p['Total Cost']) : null,
        warn: p['Node Type'] === 'Seq Scan',
        children: (p['Plans'] || []).map(conv),
      };
    };
    return { format: 'tree', root: conv(arr[0].Plan) };
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
