// SQLite 适配器：优先 better-sqlite3（原生），失败时回退 sql.js（WASM，纯 JS）
const fs = require('fs');
const path = require('path');
const { BaseAdapter } = require('./base');
const { hasSQLiteExternalFileClause } = require('./sqlutil');

function nextSQLiteCheck(text, start) {
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) { if (ch === '\n' || ch === '\r') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      const close = quote === '[' ? ']' : quote;
      if (ch === close && next === close && quote !== '[') { i++; continue; }
      if (ch === close) quote = null;
      continue;
    }
    if (ch === '-' && next === '-') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') { quote = ch; continue; }
    if (!/[A-Za-z_]/.test(ch)) continue;
    let end = i + 1;
    while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end++;
    if (text.slice(i, end).toUpperCase() === 'CHECK') {
      let open = end;
      while (open < text.length && /\s/.test(text[open])) open++;
      if (text[open] === '(') return { index: i, open };
    }
    i = end - 1;
  }
  return null;
}

function sqliteCheckConstraints(sql, table) {
  const text = String(sql || '');
  const out = [];
  let i = 0;
  while (i < text.length) {
    const found = nextSQLiteCheck(text, i);
    if (!found) break;
    const open = found.open;
    let depth = 1;
    let quote = null;
    let j = open + 1;
    for (; j < text.length && depth; j++) {
      const ch = text[j];
      if (quote) {
        if (ch === quote && text[j + 1] === quote) { j++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth) break;
    const before = text.slice(Math.max(0, text.lastIndexOf(',', found.index) + 1), found.index);
    const named = /\bCONSTRAINT\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([^\s,()]+))\s*$/i.exec(before);
    const name = (named && (named[1] || named[2] || named[3] || named[4])) || `ck_${table}_${out.length + 1}`;
    out.push({ kind: 'check', name, columns: [], expression: text.slice(open + 1, j - 1).trim() });
    i = j;
  }
  return out;
}

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
      const inMemory = this.file === ':memory:';
      const buf = !inMemory && fs.existsSync(this.file) ? fs.readFileSync(this.file) : null;
      this.db = buf ? new SQL.Database(buf) : new SQL.Database();
      this._dirty = !buf && !inMemory;
      console.warn('[sqlite] better-sqlite3 不可用，已回退 sql.js (WASM):', err.message);
    }
    const r = this._execRaw('SELECT sqlite_version()');
    this.serverVersion = 'SQLite ' + r.rows[0][0] + (this.mode === 'wasm' ? ' (WASM)' : '');
    this._execRaw('PRAGMA foreign_keys = ON');
    const foreignKeys = this._execRaw('PRAGMA foreign_keys');
    if (!foreignKeys.rows.length || Number(foreignKeys.rows[0][0]) !== 1) {
      try { this.db.close(); } catch (e) { /* unusable connection */ }
      this.db = null;
      throw new Error('SQLite 无法启用外键约束，已拒绝打开该连接');
    }
    this._flush();
  }

  async close() {
    if (!this.db) return;
    try { this._flush(); } catch (e) { /* ignore */ }
    try { this.db.close(); } catch (e) { /* ignore */ }
    this.db = null;
  }

  _flush() {
    if (this.file === ':memory:') return;
    if (this.mode === 'wasm' && this._dirty && this.db) {
      fs.writeFileSync(this.file, Buffer.from(this.db.export()));
      this._dirty = false;
    }
  }

  _execRaw(sql, opts) {
    if (hasSQLiteExternalFileClause(sql)) {
      throw new Error('SQLite SQL 不允许 ATTACH 或 VACUUM INTO 访问其他本地文件；请通过连接对话框单独选择目标数据库');
    }
    const limited = this._prepareScriptQuery(sql, opts);
    sql = limited.sql;
    if (this.mode === 'native') {
      const stmt = this.db.prepare(sql);
      // Preserve all 64-bit INTEGER values; callers sanitize BigInt to strings
      // for IPC, while raw export/keyset pagination keeps the exact value.
      stmt.safeIntegers(true);
      if (stmt.reader) {
        stmt.raw(true);
        const rows = stmt.all();
        const columns = stmt.columns().map((c) => ({ name: c.name, type: c.type || '' }));
        return { columns, rows, rowLimitApplied: limited.applied };
      }
      const info = stmt.run();
      return {
        affected: Number(info.changes || 0),
        insertId: info.lastInsertRowid !== undefined ? String(info.lastInsertRowid) : undefined,
      };
    }
    // ---- sql.js ----
    const stmt = this.db.prepare(sql);
    let cols = [];
    try { cols = stmt.getColumnNames(); } catch (e) { cols = []; }
    if (cols.length) {
      const rows = [];
      while (stmt.step()) rows.push(stmt.get(null, { useBigInt: true }));
      stmt.free();
      return { columns: cols.map((n) => ({ name: n, type: '' })), rows, rowLimitApplied: limited.applied };
    }
    stmt.free();
    this.db.run(sql);
    this._dirty = true;
    return { affected: this.db.getRowsModified() || 0 };
  }

  async withSession(_db, fn, opts) {
    if (this._transactions.size && !(opts && opts.explicitTransaction)) {
      throw new Error('SQLite 当前存在显式事务，请先在对应查询标签中提交或回滚');
    }
    const run = async (sql, runOpts) => this._execRaw(sql, runOpts);
    if (opts && opts.explicitTransaction) {
      run.invalidate = async () => {
        try { this._execRaw('ROLLBACK'); } catch (e) { /* transaction may already be gone */ }
        try { await this.close(); } catch (e) { /* already unusable */ }
      };
    }
    try {
      return await fn(run);
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
    const rows = this._execRaw(`PRAGMA foreign_key_list(${this.quoteIdent(table)})`).rows;
    const parentKeys = new Map();
    const parentKeyAt = (parentTable, sequence) => {
      if (!parentKeys.has(parentTable)) {
        const keys = this._execRaw(`PRAGMA table_info(${this.quoteIdent(parentTable)})`).rows
          .filter((item) => Number(item[5]) > 0)
          .sort((a, b) => Number(a[5]) - Number(b[5]))
          .map((item) => item[1]);
        parentKeys.set(parentTable, keys);
      }
      const column = parentKeys.get(parentTable)[Number(sequence)];
      if (!column) throw new Error(`SQLite 外键省略了父栏位，但无法解析 ${parentTable} 的对应主键栏位`);
      return column;
    };
    // PRAGMA foreign_key_list: id, seq, table, from, to, on_update, on_delete, match
    const map = new Map();
    for (const r of rows) {
      const id = r[0];
      if (!map.has(id)) map.set(id, {
        name: `fk_${table}_${id}`, columns: [], refSchema: null, refTable: r[2], refColumns: [],
        onUpdate: r[5] || 'NO ACTION', onDelete: r[6] || 'NO ACTION',
      });
      const fk = map.get(id);
      fk.columns.push(r[3]);
      fk.refColumns.push(r[4] === null || r[4] === undefined || r[4] === '' ? parentKeyAt(r[2], r[1]) : r[4]);
    }
    return [...map.values()];
  }

  async listReferencingForeignKeys(_db, _schema, table) {
    const tableRows = this._execRaw(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).rows;
    const target = String(table).toLowerCase();
    const targetPk = this._execRaw(`PRAGMA table_info(${this.quoteIdent(table)})`).rows
      .filter((item) => Number(item[5]) > 0)
      .sort((a, b) => Number(a[5]) - Number(b[5]))
      .map((item) => item[1]);
    const map = new Map();
    for (const [childTable] of tableRows) {
      if (String(childTable).toLowerCase() === target) continue;
      const rows = this._execRaw(`PRAGMA foreign_key_list(${this.quoteIdent(childTable)})`).rows;
      for (const row of rows) {
        if (String(row[2]).toLowerCase() !== target) continue;
        const key = `${childTable}\0${row[0]}`;
        if (!map.has(key)) map.set(key, {
          name: `fk_${childTable}_${row[0]}`, schema: null, table: childTable,
          columns: [], refColumns: [],
        });
        const fk = map.get(key);
        fk.columns.push(row[3]);
        const refColumn = row[4] === null || row[4] === undefined || row[4] === ''
          ? targetPk[Number(row[1])] : row[4];
        if (!refColumn) {
          throw new Error(`SQLite 外键 ${childTable}.${fk.name} 省略了父栏位，但无法解析 ${table} 的对应主键栏位`);
        }
        fk.refColumns.push(refColumn);
      }
    }
    return [...map.values()];
  }

  async listConstraints(_db, _schema, table) {
    const out = [];
    const indexes = this._execRaw(`PRAGMA index_list(${this.quoteIdent(table)})`).rows;
    for (const row of indexes) {
      // origin='u' 表示由表级/栏位 UNIQUE 约束生成；'c' 是用户显式创建的索引。
      if (row[3] !== 'u') continue;
      const cols = this._execRaw(`PRAGMA index_info(${this.quoteIdent(row[1])})`).rows.map((item) => item[2]);
      out.push({ kind: 'unique', name: row[1], columns: cols, expression: '', indexName: row[1] });
    }
    const result = this._execRaw(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${this.literal(table)}`);
    if (!result.rows.length || !result.rows[0][0]) {
      throw new Error(`无法读取表 ${table} 的完整建表语句，已禁止在设计器中修改该表`);
    }
    out.push(...sqliteCheckConstraints(result.rows[0][0], table));
    return out;
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
    const ti = this._execRaw(`PRAGMA table_xinfo(${this.quoteIdent(table)})`);
    // PRAGMA table_xinfo: cid, name, type, notnull, dflt_value, pk, hidden
    const columns = ti.rows.map((r) => ({
      name: r[1], type: r[2] || '', nullable: !r[3], def: r[4],
      key: r[5] > 0 ? 'PRI' : '', extra: '', comment: '',
      editSafe: Number(r[6] || 0) === 0,
      editUnsafeReason: Number(r[6] || 0) === 0 ? '' : 'SQLite 生成栏位或虚拟表隐藏栏位不能由设计器无损修改',
    }));
    const pk = ti.rows.filter((r) => r[5] > 0).sort((a, b) => Number(a[5]) - Number(b[5])).map((r) => r[1]);
    const indexes = [];
    let metadataComplete = true;
    try {
      const il = this._execRaw(`PRAGMA index_list(${this.quoteIdent(table)})`);
      // seq, name, unique, origin, partial
      for (const r of il.rows) {
        const details = this._execRaw(`PRAGMA index_xinfo(${this.quoteIdent(r[1])})`);
        const keyRows = details.rows.filter((item) => Number(item[5]) === 1);
        const advanced = !!r[4] || keyRows.some((item) => Number(item[1]) < 0
          || !!item[3] || (item[4] && String(item[4]).toUpperCase() !== 'BINARY'));
        indexes.push({
          name: r[1], columns: keyRows.filter((item) => Number(item[1]) >= 0).map((item) => item[2]),
          unique: !!r[2], primary: r[3] === 'pk', editable: !advanced,
        });
      }
    } catch (e) { metadataComplete = false; }
    let ddl = '';
    try {
      const r = this._execRaw(`SELECT sql FROM sqlite_master WHERE name = ${this.literal(table)}`);
      ddl = (r.rows[0] && r.rows[0][0]) || '';
      const ix = this._execRaw(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ${this.literal(table)} AND sql IS NOT NULL`);
      if (ix.rows.length) ddl += ';\n\n' + ix.rows.map((x) => x[0] + ';').join('\n');
    } catch (e) { /* ignore */ }
    return { columns, indexes, pk, ddl, metadataComplete };
  }

  /** 无主键的普通表用隐式 rowid 定位行；WITHOUT ROWID 表不支持 */
  async rowIdFor(_db, _schema, table) {
    const r = this._execRaw(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${this.literal(table)}`);
    const ddl = r.rows[0] && r.rows[0][0];
    if (ddl && /WITHOUT\s+ROWID/i.test(String(ddl))) return null;
    return 'rowid';
  }
}

module.exports = { SQLiteAdapter };
