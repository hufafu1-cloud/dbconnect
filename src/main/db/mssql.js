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
