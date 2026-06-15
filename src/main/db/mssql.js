// SQL Server 适配器（mssql/tedious，纯 JS）
const mssql = require('mssql');
const { BaseAdapter } = require('./base');
const { sanitizeRows, excerpt, synthesizeDDL } = require('./sqlutil');

class MSSQLAdapter extends BaseAdapter {
  get dialect() { return 'mssql'; }

  async connect() {
    const c = this.cfg;
    const opts = c.options || {};
    this.pool = new mssql.ConnectionPool({
      server: c.host || 'localhost',
      port: Number(c.port) || 1433,
      user: c.user,
      password: c.password || '',
      database: c.database || 'master',
      pool: { max: 4, min: 0 },
      connectionTimeout: 8000,
      requestTimeout: 120000,
      options: {
        encrypt: !!opts.encrypt,
        trustServerCertificate: opts.trustCert !== false,
        enableArithAbort: true,
        useUTC: false,
      },
    });
    await this.pool.connect();
    const r = await this.pool.request().query('SELECT @@VERSION AS v');
    this.serverVersion = String(r.recordset[0].v).split('\n')[0].split(' - ')[0].trim();
  }

  async close() {
    if (this.pool) await this.pool.close().catch(() => {});
    this.pool = null;
  }

  quoteIdent(name) { return '[' + String(name).replace(/]/g, ']]') + ']'; }

  literal(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    return "N'" + String(v).replace(/'/g, "''") + "'";
  }

  qualify(_db, schema, table) {
    return (schema ? this.quoteIdent(schema) + '.' : '') + this.quoteIdent(table);
  }

  pageSql(select, orderClause, limit, offset) {
    const order = orderClause || ' ORDER BY (SELECT NULL)';
    return `${select}${order} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }

  _useBatch(db, sql) {
    return (db ? `USE ${this.quoteIdent(db)};\n` : '') + sql;
  }

  _track(req) {
    if (!this._activeReqs) this._activeReqs = new Set();
    this._activeReqs.add(req);
    return req;
  }

  _untrack(req) {
    if (this._activeReqs) this._activeReqs.delete(req);
  }

  /** 取消正在执行的请求 */
  async cancel() {
    if (!this._activeReqs) return;
    for (const req of [...this._activeReqs]) {
      try { req.cancel(); } catch (e) { /* ignore */ }
    }
  }

  /** 单语句执行（数组行模式） */
  async withSession(db, fn) {
    return fn(async (sql) => {
      const req = this._track(this.pool.request());
      req.arrayRowMode = true;
      try {
        const r = await req.batch(this._useBatch(db, sql));
        return this._normBatch(r);
      } finally {
        this._untrack(req);
      }
    });
  }

  // ---------- 对象覆盖：存储过程 / 函数 / 触发器 / 序列 / 登录 ----------
  get objectCaps() {
    return { routines: true, triggers: true, events: false, sequences: true, users: true, processes: true };
  }

  blobLiteral(buf) { return '0x' + buf.toString('hex'); }

  async listProcesses() {
    const rows = await this._q(null,
      `SELECT s.session_id AS id, s.login_name AS u, DB_NAME(s.database_id) AS db,
              s.status AS st, r.command AS cmd,
              ISNULL(r.total_elapsed_time, 0) / 1000 AS sec,
              ISNULL(t.text, '') AS info
       FROM sys.dm_exec_sessions s
       LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
       OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
       WHERE s.is_user_process = 1 ORDER BY s.session_id`);
    return rows.map((r) => ({
      id: String(r.id), user: r.u || '', db: r.db || '',
      state: [r.st, r.cmd].filter(Boolean).join(' · '),
      timeSec: Number(r.sec) || 0, info: r.info || '',
    }));
  }

  async killProcess(id) {
    const req = this.pool.request();
    await req.batch('KILL ' + Number(id));
  }

  async listRoutines(db) {
    const rows = await this._q(db,
      `SELECT s.name AS sch, o.name AS name, o.type AS t FROM sys.objects o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.type IN ('P', 'FN', 'IF', 'TF') ORDER BY o.name`);
    return rows.map((r) => ({
      name: r.name,
      schema: r.sch,
      type: String(r.t).trim() === 'P' ? 'PROCEDURE' : 'FUNCTION',
      comment: '',
    }));
  }

  async listTriggers(db) {
    const rows = await this._q(db,
      `SELECT tr.name AS name, OBJECT_NAME(tr.parent_id) AS tbl,
              OBJECT_SCHEMA_NAME(tr.object_id) AS sch
       FROM sys.triggers tr WHERE tr.is_ms_shipped = 0 AND tr.parent_class = 1 ORDER BY tr.name`);
    return rows.map((r) => ({ name: r.name, table: r.tbl, schema: r.sch }));
  }

  async listSequences(db) {
    try {
      const rows = await this._q(db,
        `SELECT s.name AS sch, sq.name AS name FROM sys.sequences sq
         JOIN sys.schemas s ON s.schema_id = sq.schema_id ORDER BY sq.name`);
      return rows.map((r) => ({ name: r.name, schema: r.sch }));
    } catch (e) { return []; }
  }

  async listUsers() {
    try {
      const rows = await this._q(null,
        `SELECT name, type_desc, is_disabled FROM sys.server_principals
         WHERE type IN ('S', 'U', 'G') AND name NOT LIKE '##%' ORDER BY name`);
      return rows.map((r) => ({ name: r.name, note: [r.type_desc, r.is_disabled ? '已禁用' : ''].filter(Boolean).join(' · ') }));
    } catch (e) { return []; }
  }

  async objectDdl(db, schema, kind, name) {
    const sch = schema || 'dbo';
    if (kind === 'PROCEDURE' || kind === 'FUNCTION' || kind === 'TRIGGER') {
      const rows = await this._q(db,
        `SELECT OBJECT_DEFINITION(OBJECT_ID(${this.literal(sch + '.' + name)})) AS def`);
      const def = rows[0] && rows[0].def;
      return def || '-- 无法获取定义（可能已加密或缺少权限）';
    }
    if (kind === 'SEQUENCE') {
      const rows = await this._q(db,
        `SELECT start_value, increment, minimum_value, maximum_value, current_value, is_cycling
         FROM sys.sequences WHERE name = ${this.literal(name)} AND schema_id = SCHEMA_ID(${this.literal(sch)})`);
      if (!rows.length) throw new Error('序列不存在');
      const s = rows[0];
      return `CREATE SEQUENCE ${this.quoteIdent(sch)}.${this.quoteIdent(name)}\n` +
        `  START WITH ${s.start_value}\n  INCREMENT BY ${s.increment}\n` +
        `  MINVALUE ${s.minimum_value}\n  MAXVALUE ${s.maximum_value}${s.is_cycling ? '\n  CYCLE' : ''};\n` +
        `-- 当前值: ${s.current_value}`;
    }
    if (kind === 'USER') {
      const rows = await this._q(null,
        `SELECT p.name, p.type_desc, p.is_disabled, p.create_date,
                STUFF((SELECT ', ' + r.name FROM sys.server_role_members rm
                       JOIN sys.server_principals r ON r.principal_id = rm.role_principal_id
                       WHERE rm.member_principal_id = p.principal_id FOR XML PATH('')), 1, 2, '') AS roles
         FROM sys.server_principals p WHERE p.name = ${this.literal(name)}`);
      if (!rows.length) throw new Error('登录不存在');
      const r = rows[0];
      return [
        `-- 登录 ${r.name}`,
        `类型: ${r.type_desc}`,
        `状态: ${r.is_disabled ? '已禁用' : '启用'}`,
        `服务器角色: ${r.roles || '(无)'}`,
        `创建时间: ${r.create_date}`,
      ].join('\n');
    }
    throw new Error('不支持的对象类型: ' + kind);
  }

  dropUserSql(name) {
    return `DROP LOGIN ${this.quoteIdent(name)}`;
  }

  async listAllColumns(db) {
    const rows = await this._q(db,
      `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS c
       FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_NAME, ORDINAL_POSITION`);
    const map = {};
    for (const r of rows) {
      const key = r.s && r.s !== 'dbo' ? `${r.s}.${r.t}` : r.t;
      (map[key] = map[key] || []).push(r.c);
    }
    return map;
  }

  async listForeignKeys(db, schema, table) {
    const L = (v) => this.literal(v);
    const sch = schema || 'dbo';
    const rows = await this._q(db,
      `SELECT fk.name AS name, pc.name AS col,
              rs.name AS refschema, rt.name AS reftab, rc.name AS refcol, fkc.constraint_column_id AS ord
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
       JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
       JOIN sys.columns pc ON pc.object_id = fk.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
       JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
       JOIN sys.columns rc ON rc.object_id = fk.referenced_object_id AND rc.column_id = fkc.referenced_column_id
       WHERE ps.name = ${L(sch)} AND pt.name = ${L(table)}
       ORDER BY fk.name, fkc.constraint_column_id`);
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.name)) map.set(r.name, { name: r.name, columns: [], refSchema: r.refschema === 'dbo' ? null : r.refschema, refTable: r.reftab, refColumns: [] });
      const fk = map.get(r.name);
      fk.columns.push(r.col);
      fk.refColumns.push(r.refcol);
    }
    return [...map.values()];
  }

  _normBatch(r) {
    const sets = r.recordsets || [];
    if (!sets.length) {
      const affected = (r.rowsAffected || []).reduce((a, b) => a + b, 0);
      return { affected };
    }
    const norm = sets.map((rs) => {
      const colsMeta = Array.isArray(rs.columns) ? rs.columns : Object.values(rs.columns || {});
      return {
        columns: colsMeta.map((c) => ({ name: c.name || '', type: (c.type && (c.type.declaration || c.type.name)) || '' })),
        rows: rs,
      };
    });
    return norm.length === 1 ? norm[0] : { multi: norm };
  }

  /** 整段脚本作为单个批执行（保证会话一致），支持按 GO 行分批 */
  async runScript(db, sql, opts) {
    const maxRows = (opts && opts.maxRows) || 2000;
    const batches = sql.split(/^\s*GO\s*(?:--.*)?$/gim).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const batch of batches) {
      const t0 = Date.now();
      const req = this._track(this.pool.request());
      try {
        req.arrayRowMode = true;
        const r = await req.batch(this._useBatch(db, batch));
        const ms = Date.now() - t0;
        const sets = r.recordsets || [];
        if (!sets.length) {
          const affected = (r.rowsAffected || []).reduce((a, b) => a + b, 0);
          out.push({ sql: excerpt(batch), ms, affected, message: '' });
        } else {
          for (const rs of sets) {
            const colsMeta = Array.isArray(rs.columns) ? rs.columns : Object.values(rs.columns || {});
            const total = rs.length;
            const rows = total > maxRows ? rs.slice(0, maxRows) : rs;
            out.push({
              sql: excerpt(batch), ms,
              columns: colsMeta.map((c) => ({ name: c.name || '', type: (c.type && (c.type.declaration || c.type.name)) || '' })),
              rows: sanitizeRows(rows),
              rowCount: total,
              truncated: total > maxRows,
            });
          }
        }
      } catch (err) {
        let m = (err && err.message) || String(err);
        if (err && err.lineNumber) m += ` (第 ${err.lineNumber} 行)`;
        out.push({ sql: excerpt(batch), ms: Date.now() - t0, error: m });
        break;
      } finally {
        this._untrack(req);
      }
    }
    return out;
  }

  /** 事务：单批 + XACT_ABORT，保证原子性 */
  async execTxn(db, sqls) {
    const body = sqls.join(';\n');
    const batch = `SET XACT_ABORT ON;\nBEGIN TRAN;\n${body};\nCOMMIT TRAN;`;
    const req = this.pool.request();
    await req.batch(this._useBatch(db, batch));
  }

  /** 内部元数据查询（对象行） */
  async _q(db, sql) {
    const req = this.pool.request();
    const r = await req.batch(this._useBatch(db, sql));
    return r.recordset || [];
  }

  async listDatabases() {
    const rows = await this._q(null, "SELECT name FROM sys.databases WHERE state = 0 ORDER BY name");
    return rows.map((r) => r.name);
  }

  async listObjects(db) {
    const tables = await this._q(db,
      `SELECT s.name AS sch, t.name AS name, ISNULL(SUM(p.rows), 0) AS rowcnt,
              MAX(CAST(ep.value AS nvarchar(400))) AS comment
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id < 2
       LEFT JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
       GROUP BY s.name, t.name ORDER BY s.name, t.name`);
    const views = await this._q(db,
      `SELECT s.name AS sch, v.name AS name FROM sys.views v
       JOIN sys.schemas s ON s.schema_id = v.schema_id ORDER BY s.name, v.name`);
    return {
      tables: tables.map((t) => ({ name: t.name, schema: t.sch, rows: Number(t.rowcnt), comment: t.comment || '', engine: '' })),
      views: views.map((v) => ({ name: v.name, schema: v.sch })),
    };
  }

  async tableInfo(db, schema, table) {
    const sch = schema || 'dbo';
    const L = (v) => this.literal(v);
    const objId = `OBJECT_ID(${L(sch + '.' + table)})`;
    const cols = await this._q(db,
      `SELECT c.name AS name, ty.name AS basetype, c.max_length, c.precision, c.scale,
              c.is_nullable, c.is_identity, dc.definition AS def, dc.name AS def_constraint,
              CAST(ep.value AS nvarchar(400)) AS comment
       FROM sys.columns c
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
       LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
       WHERE c.object_id = ${objId} ORDER BY c.column_id`);
    const pkRows = await this._q(db,
      `SELECT c.name FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.is_primary_key = 1 AND i.object_id = ${objId} ORDER BY ic.key_ordinal`);
    const pk = pkRows.map((r) => r.name);
    const idxRows = await this._q(db,
      `SELECT i.name AS iname, i.is_unique, i.is_primary_key, c.name AS col
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.object_id = ${objId} AND i.type > 0 ORDER BY i.name, ic.key_ordinal`);
    const imap = new Map();
    for (const r of idxRows) {
      if (!imap.has(r.iname)) imap.set(r.iname, { name: r.iname, columns: [], unique: !!r.is_unique, primary: !!r.is_primary_key });
      imap.get(r.iname).columns.push(r.col);
    }
    const typeStr = (c) => {
      const t = c.basetype;
      if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) return `${t}(${c.max_length === -1 ? 'max' : c.max_length})`;
      if (['nvarchar', 'nchar'].includes(t)) return `${t}(${c.max_length === -1 ? 'max' : c.max_length / 2})`;
      if (['decimal', 'numeric'].includes(t)) return `${t}(${c.precision},${c.scale})`;
      return t;
    };
    const columns = cols.map((c) => ({
      name: c.name, type: typeStr(c), nullable: !!c.is_nullable, def: c.def,
      key: pk.includes(c.name) ? 'PRI' : '', extra: c.is_identity ? 'identity' : '', comment: c.comment || '',
      defConstraint: c.def_constraint || null,
    }));
    const indexes = [...imap.values()];
    const ddl = synthesizeDDL(this.qualify(db, sch, table), columns, pk, indexes, (n) => this.quoteIdent(n));
    return { columns, indexes, pk, ddl };
  }

  renameSql(_db, schema, table, newName) {
    const old = (schema || 'dbo') + '.' + table;
    return `EXEC sp_rename ${this.literal(old)}, ${this.literal(newName)}`;
  }
}

module.exports = { MSSQLAdapter };
