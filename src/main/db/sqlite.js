// SQLite 适配器：优先 better-sqlite3（原生），失败时回退 sql.js（WASM，纯 JS）
const fs = require('fs');
const path = require('path');
const { BaseAdapter } = require('./base');

class SQLiteAdapter extends BaseAdapter {
  get dialect() { return 'sqlite'; }

  async connect() {
    this.file = this.cfg.file;
    if (!this.file) throw new Error('未指定 SQLite 数据库文件');
    this.mode = 'native';
    try {
      const BetterSqlite3 = require('better-sqlite3');
      this.db = new BetterSqlite3(this.file);
    } catch (err) {
      // 原生模块不可用（ABI 不匹配等），回退到 WASM
      this.mode = 'wasm';
      const initSqlJs = require('sql.js');
      const distDir = path.join(path.dirname(require.resolve('sql.js')), '..', 'dist');
      const SQL = await initSqlJs({ locateFile: (f) => path.join(distDir, f) });
      const buf = fs.existsSync(this.file) ? fs.readFileSync(this.file) : null;
      this.db = buf ? new SQL.Database(buf) : new SQL.Database();
      this._dirty = !buf;
      console.warn('[sqlite] better-sqlite3 不可用，已回退 sql.js (WASM):', err.message);
    }
    const r = this._execRaw('SELECT sqlite_version()');
    this.serverVersion = 'SQLite ' + r.rows[0][0] + (this.mode === 'wasm' ? ' (WASM)' : '');
    this._flush();
  }

  async close() {
    if (!this.db) return;
    try { this._flush(); } catch (e) { /* ignore */ }
    try { this.db.close(); } catch (e) { /* ignore */ }
    this.db = null;
  }

  _flush() {
    if (this.mode === 'wasm' && this._dirty && this.db) {
      fs.writeFileSync(this.file, Buffer.from(this.db.export()));
      this._dirty = false;
    }
  }

  _execRaw(sql) {
    if (this.mode === 'native') {
      const stmt = this.db.prepare(sql);
      if (stmt.reader) {
        stmt.raw(true);
        const rows = stmt.all();
        const columns = stmt.columns().map((c) => ({ name: c.name, type: c.type || '' }));
        return { columns, rows };
      }
      const info = stmt.run();
      return {
        affected: info.changes || 0,
        insertId: info.lastInsertRowid !== undefined ? String(info.lastInsertRowid) : undefined,
      };
    }
    // ---- sql.js ----
    const stmt = this.db.prepare(sql);
    let cols = [];
    try { cols = stmt.getColumnNames(); } catch (e) { cols = []; }
    if (cols.length) {
      const rows = [];
      while (stmt.step()) rows.push(stmt.get());
      stmt.free();
      return { columns: cols.map((n) => ({ name: n, type: '' })), rows };
    }
    stmt.free();
    this.db.run(sql);
    this._dirty = true;
    return { affected: this.db.getRowsModified() || 0 };
  }

  async withSession(_db, fn) {
    try {
      return await fn(async (sql) => this._execRaw(sql));
    } finally {
      this._flush();
    }
  }

  qualify(_db, _schema, table) { return this.quoteIdent(table); }

  truncateSql(T) { return `DELETE FROM ${T}`; }

  async listDatabases() { return ['main']; }

  async listObjects() {
    const t = this._execRaw("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const v = this._execRaw("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name");
    const tables = t.rows.map((r) => ({ name: r[0], rows: null, comment: '', engine: '' }));
    if (tables.length <= 300) {
      for (const tb of tables) {
        try {
          const c = this._execRaw(`SELECT COUNT(*) FROM ${this.quoteIdent(tb.name)}`);
          tb.rows = Number(c.rows[0][0]);
        } catch (e) { /* ignore */ }
      }
    }
    return { tables, views: v.rows.map((r) => ({ name: r[0] })) };
  }

  get objectCaps() {
    return { routines: false, triggers: true, events: false, sequences: false, users: false };
  }

  async listTriggers() {
    const r = this._execRaw("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
    return r.rows.map(([name, tbl]) => ({ name, table: tbl }));
  }

  async objectDdl(_db, _schema, kind, name) {
    if (kind === 'TRIGGER') {
      const r = this._execRaw(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ${this.literal(name)}`);
      if (!r.rows.length) throw new Error('触发器不存在');
      return (r.rows[0][0] || '') + ';';
    }
    throw new Error('不支持的对象类型: ' + kind);
  }

  async listAllColumns() {
    const t = this._execRaw("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const map = {};
    for (const [name] of t.rows.slice(0, 300)) {
      try {
        const ti = this._execRaw(`PRAGMA table_info(${this.quoteIdent(name)})`);
        map[name] = ti.rows.map((r) => r[1]);
      } catch (e) { /* ignore */ }
    }
    return map;
  }

  async listForeignKeys(_db, _schema, table) {
    let rows = [];
    try {
      rows = this._execRaw(`PRAGMA foreign_key_list(${this.quoteIdent(table)})`).rows;
    } catch (e) { return []; }
    // PRAGMA foreign_key_list: id, seq, table, from, to, on_update, on_delete, match
    const map = new Map();
    for (const r of rows) {
      const id = r[0];
      if (!map.has(id)) map.set(id, { name: `fk_${table}_${id}`, columns: [], refSchema: null, refTable: r[2], refColumns: [] });
      const fk = map.get(id);
      fk.columns.push(r[3]);
      fk.refColumns.push(r[4]);
    }
    return [...map.values()];
  }

  async explainPlan(_db, sql) {
    // EXPLAIN QUERY PLAN: id, parent, notused, detail
    const rows = this._execRaw('EXPLAIN QUERY PLAN ' + sql).rows;
    const byId = new Map();
    const roots = [];
    for (const r of rows) {
      byId.set(r[0], { title: String(r[3] || ''), detail: '', rows: null, cost: null, warn: /\bSCAN\b/.test(String(r[3] || '')), children: [], _p: r[1] });
    }
    for (const node of byId.values()) {
      if (node._p && byId.has(node._p)) byId.get(node._p).children.push(node);
      else roots.push(node);
    }
    const root = roots.length === 1 ? roots[0] : { title: 'QUERY PLAN', detail: '', children: roots };
    return { format: 'tree', root };
  }

  async tableInfo(_db, _schema, table) {
    const ti = this._execRaw(`PRAGMA table_info(${this.quoteIdent(table)})`);
    // PRAGMA table_info: cid, name, type, notnull, dflt_value, pk
    const columns = ti.rows.map((r) => ({
      name: r[1], type: r[2] || '', nullable: !r[3], def: r[4],
      key: r[5] > 0 ? 'PRI' : '', extra: '', comment: '',
    }));
    const pk = ti.rows.filter((r) => r[5] > 0).sort((a, b) => a[5] - b[5]).map((r) => r[1]);
    const indexes = [];
    try {
      const il = this._execRaw(`PRAGMA index_list(${this.quoteIdent(table)})`);
      // seq, name, unique, origin, partial
      for (const r of il.rows) {
        const cols = this._execRaw(`PRAGMA index_info(${this.quoteIdent(r[1])})`);
        indexes.push({ name: r[1], columns: cols.rows.map((c) => c[2]), unique: !!r[2], primary: r[3] === 'pk' });
      }
    } catch (e) { /* ignore */ }
    let ddl = '';
    try {
      const r = this._execRaw(`SELECT sql FROM sqlite_master WHERE name = ${this.literal(table)}`);
      ddl = (r.rows[0] && r.rows[0][0]) || '';
      const ix = this._execRaw(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ${this.literal(table)} AND sql IS NOT NULL`);
      if (ix.rows.length) ddl += ';\n\n' + ix.rows.map((x) => x[0] + ';').join('\n');
    } catch (e) { /* ignore */ }
    return { columns, indexes, pk, ddl };
  }
}

module.exports = { SQLiteAdapter };
