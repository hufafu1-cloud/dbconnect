// PostgreSQL 适配器（pg，纯 JS）
const { Pool, types } = require('pg');
const { BaseAdapter } = require('./base');

// 日期时间类型按原始字符串返回，避免时区转换困扰
for (const oid of [1082 /*date*/, 1083 /*time*/, 1114 /*timestamp*/, 1184 /*timestamptz*/, 1266 /*timetz*/]) {
  types.setTypeParser(oid, (v) => v);
}
// JSON.parse and the default numeric/date array parsers can turn exact database
// text into lossy JavaScript Numbers/Dates. Keep scalar JSON raw and parse arrays
// with the text[] parser so every element remains an exact string.
for (const oid of [114 /*json*/, 3802 /*jsonb*/]) types.setTypeParser(oid, (v) => v);
const parseTextArray = types.getTypeParser(1009 /*text[]*/, 'text');
for (const oid of [
  1231, // numeric[]
  1115, 1182, 1183, 1185, 1187, 1270, // timestamp/date/time/timestamptz/interval/timetz arrays
  199, 3807, // json[] / jsonb[]
]) types.setTypeParser(oid, parseTextArray);

const pgFlag = (value) => value === true || value === 't' || value === 1 || value === '1';

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

  async withSession(db, fn, opts) {
    const requestId = this._requestId(opts);
    this._assertRequestActive(requestId);
    const client = await this._acquireForRequest(
      () => this._getPool(db).connect(),
      (late) => late.release(),
      requestId,
    );
    const handle = { client, released: false };
    this._trackRequestHandle(handle, requestId);
    let sessionError = null;
    let rejectSessionLost;
    const sessionLost = new Promise((resolve, reject) => { rejectSessionLost = reject; });
    const onSessionError = (error) => {
      sessionError = error instanceof Error ? error : new Error(String(error || 'PostgreSQL 会话已断开'));
      rejectSessionLost(sessionError);
    };
    client.on('error', onSessionError);
    const run = (sql, runOpts) => {
      if (sessionError) return Promise.reject(sessionError);
      return this._run(client, sql, runOpts);
    };
    run.requestHandle = handle;
    run.invalidate = (error) => {
      if (handle.released) return;
      handle.released = true;
      client.release(error instanceof Error ? error : new Error('事务会话已失效'));
    };
    let result;
    let failure = null;
    try {
      this._assertRequestActive(requestId);
      const selectedSchema = opts && opts.schema !== undefined && opts.schema !== null
        ? String(opts.schema) : '';
      if (selectedSchema) {
        const found = await Promise.race([
          client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [selectedSchema]), sessionLost,
        ]);
        if (!found.rows || !found.rows.length) throw new Error(`PostgreSQL 模式不存在或不可访问：${selectedSchema}`);
        await Promise.race([
          // Keep pg_catalog first so an untrusted application schema cannot
          // shadow built-in functions or operators; ordinary tables still
          // resolve from the selected schema next.
          client.query(`SET search_path TO pg_catalog, ${this.quoteIdent(selectedSchema)}`), sessionLost,
        ]);
      }
      result = await Promise.race([Promise.resolve().then(() => fn(run)), sessionLost]);
    } catch (error) {
      failure = error;
    } finally {
      this._untrackRequestHandle(handle, requestId);
      if (!handle.released) {
        handle.released = true;
        let releaseError = sessionError;
        if (!releaseError) {
          try { await client.query('DISCARD ALL'); }
          catch (error) { releaseError = error; }
        }
        client.release(releaseError || undefined);
        if (releaseError && !failure) {
          // The user operation may already have committed. Destroy the tainted
          // client, but never turn a successful result into a retryable failure.
          if (opts && typeof opts.onCleanupError === 'function') {
            try { opts.onCleanupError(releaseError); } catch (e) { /* reporting must not replace success */ }
          }
          console.warn(`PostgreSQL 会话重置失败，已销毁该会话：${releaseError.message || releaseError}`);
        }
      }
      client.removeListener('error', onSessionError);
    }
    if (failure) throw failure;
    return result;
  }

  /** 销毁目标 PoolClient，避免 backend PID 被池内复用后误取消后续查询。 */
  async cancel(requestId) {
    this._markRequestCancelled(requestId);
    for (const handle of this._requestHandlesFor(requestId)) {
      if (!handle || handle.released) continue;
      handle.released = true;
      try { handle.client.release(new Error('查询已取消')); } catch (e) { /* 会话可能刚好结束 */ }
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
              nsp2.nspname AS refschema, cl2.relname AS reftab, att2.attname AS refcol, k.ord,
              pg_get_constraintdef(con.oid, true) AS definition,
              con.convalidated AS validated, con.condeferrable AS deferrable,
              con.condeferred AS deferred, con.confmatchtype AS match_type,
              con.conislocal AS is_local, con.coninhcount AS inherited_count,
              COALESCE((row_to_json(con)->>'conparentid')::oid, 0::oid) AS parent_constraint_id,
              CASE con.confupdtype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS on_update,
              CASE con.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS on_delete
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
      const advanced = !pgFlag(r.validated) || pgFlag(r.deferrable) || pgFlag(r.deferred)
        || !pgFlag(r.is_local) || Number(r.inherited_count || 0) > 0
        || Number(r.parent_constraint_id || 0) > 0 || String(r.match_type || 's') !== 's'
        || /\b(NOT\s+ENFORCED|PERIOD)\b|\bSET\s+(?:NULL|DEFAULT)\s*\(/i.test(r.definition || '');
      if (!map.has(r.name)) map.set(r.name, {
        name: r.name, columns: [], refSchema: r.refschema === sch ? null : r.refschema,
        refTable: r.reftab, refColumns: [], onUpdate: r.on_update, onDelete: r.on_delete,
        rebuildSafe: !advanced,
      });
      const fk = map.get(r.name);
      fk.columns.push(r.col);
      fk.refColumns.push(r.refcol);
    }
    return [...map.values()];
  }

  async listReferencingForeignKeys(db, schema, table) {
    const sch = schema || 'public';
    const rows = await this._q(db,
      `SELECT con.conname AS name, child_nsp.nspname AS child_schema,
              child.relname AS child_table, child_att.attname AS col,
              target_att.attname AS refcol, k.ord
       FROM pg_constraint con
       JOIN pg_class child ON child.oid = con.conrelid
       JOIN pg_namespace child_nsp ON child_nsp.oid = child.relnamespace
       JOIN pg_class target ON target.oid = con.confrelid
       JOIN pg_namespace target_nsp ON target_nsp.oid = target.relnamespace
       JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(att, fatt, ord) ON true
       JOIN pg_attribute child_att ON child_att.attrelid = con.conrelid AND child_att.attnum = k.att
       JOIN pg_attribute target_att ON target_att.attrelid = con.confrelid AND target_att.attnum = k.fatt
       WHERE con.contype = 'f' AND target_nsp.nspname = $1 AND target.relname = $2
         AND NOT (child_nsp.nspname = $1 AND child.relname = $2)
       ORDER BY child_nsp.nspname, child.relname, con.conname, k.ord`, [sch, table]);
    const map = new Map();
    for (const row of rows) {
      const key = `${row.child_schema}\0${row.child_table}\0${row.name}`;
      if (!map.has(key)) map.set(key, {
        name: row.name, schema: row.child_schema, table: row.child_table,
        columns: [], refColumns: [],
      });
      const fk = map.get(key);
      fk.columns.push(row.col);
      fk.refColumns.push(row.refcol);
    }
    return [...map.values()];
  }

  async listConstraints(db, schema, table) {
    const sch = schema || 'public';
    const rows = await this._q(db,
      `SELECT con.conname AS name, con.contype AS kind,
              pg_get_expr(con.conbin, con.conrelid) AS expression,
              pg_get_constraintdef(con.oid, true) AS definition,
              con.convalidated AS validated, con.condeferrable AS deferrable,
              con.condeferred AS deferred, con.connoinherit AS no_inherit,
              con.conislocal AS is_local, con.coninhcount AS inherited_count,
              COALESCE((row_to_json(con)->>'conparentid')::oid, 0::oid) AS parent_constraint_id,
              att.attname AS col, k.ord, idx.relname AS index_name
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = cl.relnamespace
       LEFT JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       LEFT JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
       LEFT JOIN pg_class idx ON idx.oid = con.conindid
       WHERE con.contype IN ('u', 'c') AND nsp.nspname = $1 AND cl.relname = $2
       ORDER BY con.conname, k.ord`, [sch, table]);
    const map = new Map();
    for (const row of rows) {
      const advanced = !pgFlag(row.validated) || pgFlag(row.deferrable) || pgFlag(row.deferred)
        || pgFlag(row.no_inherit) || !pgFlag(row.is_local) || Number(row.inherited_count || 0) > 0
        || Number(row.parent_constraint_id || 0) > 0
        || /\b(NOT\s+ENFORCED|NULLS\s+NOT\s+DISTINCT|WITHOUT\s+OVERLAPS|INCLUDE)\b|\bWITH\s*\(|\bUSING\s+INDEX\s+TABLESPACE\b/i.test(row.definition || '');
      if (!map.has(row.name)) map.set(row.name, {
        kind: row.kind === 'u' ? 'unique' : 'check', name: row.name,
        columns: [], expression: row.expression || '', indexName: row.index_name || null,
        rebuildSafe: !advanced,
      });
      if (row.kind === 'u' && row.col) map.get(row.name).columns.push(row.col);
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

  async _run(client, sql, opts) {
    const limited = this._prepareScriptQuery(sql, opts);
    const res = await client.query({ text: limited.sql, rowMode: 'array' });
    const list = Array.isArray(res) ? res : [res];
    const norm = list.map((r) => {
      if (r.fields && r.fields.length) {
        return {
          columns: r.fields.map((f) => ({ name: f.name, type: '' })),
          rows: r.rows,
          rowLimitApplied: limited.applied,
        };
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
    // 行数为统计估算，不是 COUNT(*)。reltuples / relpages 在批量导入后可能长期为 0；
    // pg_stat_user_tables.n_live_tup / n_tup_ins 能识别“已有写入但统计未跟上”的情况。
    const tables = await this._q(db,
      `SELECT c.relname AS name,
              CASE
                WHEN COALESCE(st.n_live_tup, 0) > 0 THEN st.n_live_tup
                WHEN c.reltuples > 0 THEN c.reltuples::bigint
                WHEN c.reltuples < 0 THEN NULL
                WHEN COALESCE(st.n_tup_ins, 0) > COALESCE(st.n_tup_del, 0) THEN NULL
                WHEN c.reltuples = 0 AND c.relpages > 0 THEN NULL
                ELSE 0
              END AS rows,
              obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
       ORDER BY c.relname`, [sch]);
    const views = await this._q(db,
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('v', 'm') ORDER BY c.relname`, [sch]);
    return {
      tables: tables.map((t) => ({
        name: t.name, schema: sch,
        rows: t.rows === null || t.rows === undefined ? null : Number(t.rows),
        comment: t.comment || '', engine: '',
      })),
      views: views.map((v) => ({ name: v.name, schema: sch })),
    };
  }

  /** 无主键的普通表用系统列 ctid 定位行（Navicat 同款做法）。
   *  分区表的 ctid 跨分区不唯一，禁用以避免误改其它分区的行。 */
  async rowIdFor(db, schema, table) {
    const rows = await this._q(db,
      `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`, [schema || 'public', table]);
    return rows.length && rows[0].relkind === 'r' ? 'ctid' : null;
  }

  async tableInfo(db, schema, table) {
    const sch = schema || 'public';
    const reg = `${this.quoteIdent(sch)}.${this.quoteIdent(table)}`;
    const cols = await this._q(db,
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS def,
              col_description(a.attrelid, a.attnum) AS comment,
              a.attstorage, t.typstorage,
              COALESCE(row_to_json(a)->>'attidentity', '') AS identity_kind,
              COALESCE(row_to_json(a)->>'attgenerated', '') AS generated_kind,
              COALESCE(row_to_json(a)->>'attcompression', '') AS compression_kind
       FROM pg_attribute a
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`, [reg]);
    const pkRows = await this._q(db,
      `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary`, [reg]);
    const pk = pkRows.map((r) => r.attname);
    const idxRows = await this._q(db,
      `SELECT idx.relname AS name, ix.indisunique, ix.indisprimary,
              COALESCE((row_to_json(ix)->>'indnkeyatts')::int, ix.indnatts) AS indnkeyatts,
              ix.indexprs IS NOT NULL AS has_expression,
              ix.indpred IS NOT NULL AS has_predicate,
              ix.indnatts > COALESCE((row_to_json(ix)->>'indnkeyatts')::int, ix.indnatts) AS has_include,
              pg_get_indexdef(ix.indexrelid) AS def, att.attname AS col, k.ord
       FROM pg_index ix
       JOIN pg_class tbl ON tbl.oid = ix.indrelid
       JOIN pg_namespace nsp ON nsp.oid = tbl.relnamespace
       JOIN pg_class idx ON idx.oid = ix.indexrelid
       LEFT JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
       LEFT JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = k.attnum
       WHERE nsp.nspname = $1 AND tbl.relname = $2
       ORDER BY idx.relname, k.ord`, [sch, table]);
    const indexMap = new Map();
    for (const row of idxRows) {
      if (!indexMap.has(row.name)) indexMap.set(row.name, {
        name: row.name, columns: [], def: row.def,
        unique: !!row.indisunique, primary: !!row.indisprimary,
        editable: !row.has_expression && !row.has_predicate && !row.has_include,
      });
      if (row.col && Number(row.ord) <= Number(row.indnkeyatts)) indexMap.get(row.name).columns.push(row.col);
    }
    const indexes = [...indexMap.values()];
    const columns = cols.map((c) => {
      const advanced = !!c.identity_kind || !!c.generated_kind
        || !!c.compression_kind || c.attstorage !== c.typstorage;
      const detail = [
        c.identity_kind && 'IDENTITY', c.generated_kind && 'GENERATED',
        c.compression_kind && 'COMPRESSION', c.attstorage !== c.typstorage && 'STORAGE',
      ].filter(Boolean).join(' / ');
      return {
        name: c.name, type: c.type, nullable: c.nullable, def: c.def,
        key: pk.includes(c.name) ? 'PRI' : '', extra: c.identity_kind ? 'identity' : '', comment: c.comment || '',
        editSafe: !advanced,
        editUnsafeReason: advanced ? `栏位含无法无损表示的 PostgreSQL ${detail} 属性` : '',
      };
    });
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
