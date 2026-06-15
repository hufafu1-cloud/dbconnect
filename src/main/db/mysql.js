// MySQL / MariaDB 适配器（mysql2，纯 JS）
const mysql = require('mysql2/promise');
const { BaseAdapter } = require('./base');

class MySQLAdapter extends BaseAdapter {
  get dialect() { return 'mysql'; }

  async connect() {
    const c = this.cfg;
    this.pool = mysql.createPool({
      host: c.host || 'localhost',
      port: Number(c.port) || 3306,
      user: c.user,
      password: c.password || '',
      database: c.database || undefined,
      waitForConnections: true,
      connectionLimit: 5,
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      charset: 'utf8mb4',
      connectTimeout: 8000,
    });
    const [rows] = await this.pool.query('SELECT VERSION() AS v');
    this.serverVersion = 'MySQL ' + rows[0].v;
  }

  async close() {
    if (this.pool) await this.pool.end().catch(() => {});
    this.pool = null;
  }

  quoteIdent(name) { return '`' + String(name).replace(/`/g, '``') + '`'; }

  literal(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
  }

  qualify(db, _schema, table) {
    return (db ? this.quoteIdent(db) + '.' : '') + this.quoteIdent(table);
  }

  async withSession(db, fn) {
    const conn = await this.pool.getConnection();
    const threadId = (conn.connection && conn.connection.threadId) || conn.threadId;
    if (!this._activeThreads) this._activeThreads = new Set();
    if (threadId) this._activeThreads.add(threadId);
    try {
      if (db) await conn.query('USE ' + this.quoteIdent(db));
      return await fn((sql) => this._run(conn, sql));
    } finally {
      if (threadId) this._activeThreads.delete(threadId);
      conn.release();
    }
  }

  /** 用另一条连接 KILL QUERY 正在执行的会话 */
  async cancel() {
    if (!this._activeThreads || !this._activeThreads.size) return;
    const killer = await this.pool.getConnection();
    try {
      for (const id of [...this._activeThreads]) {
        await killer.query('KILL QUERY ' + Number(id)).catch(() => {});
      }
    } finally {
      killer.release();
    }
  }

  async listAllColumns(db) {
    const rows = await this._q(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ${this.literal(db)} ORDER BY TABLE_NAME, ORDINAL_POSITION`);
    const map = {};
    for (const r of rows) (map[r.t] = map[r.t] || []).push(r.c);
    return map;
  }

  async explainPlan(db, sql) {
    const { sanitizeRows } = require('./sqlutil');
    const r = await this.exec(db, 'EXPLAIN ' + sql);
    return {
      format: 'table',
      columns: r.columns.map((c) => c.name),
      rows: sanitizeRows(r.rows),
      highlightCol: 'type',
      // type 列：ALL/index 偏差，ref/eq_ref/const 较好
      goodValues: ['const', 'eq_ref', 'ref', 'range', 'system'],
      badValues: ['ALL'],
    };
  }

  async listForeignKeys(db, _schema, table) {
    const L = (v) => this.literal(v);
    const rows = await this._q(
      `SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS col,
              REFERENCED_TABLE_NAME AS reftab, REFERENCED_COLUMN_NAME AS refcol,
              ORDINAL_POSITION AS pos
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ${L(db)} AND TABLE_NAME = ${L(table)}
         AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`);
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.name)) map.set(r.name, { name: r.name, columns: [], refSchema: null, refTable: r.reftab, refColumns: [] });
      const fk = map.get(r.name);
      fk.columns.push(r.col);
      fk.refColumns.push(r.refcol);
    }
    return [...map.values()];
  }

  // ---------- 对象覆盖：函数 / 触发器 / 事件 / 用户 ----------
  get objectCaps() {
    return { routines: true, triggers: true, events: true, sequences: false, users: true, processes: true };
  }

  blobLiteral(buf) { return '0x' + buf.toString('hex'); }

  async listProcesses() {
    const rows = await this._q('SHOW FULL PROCESSLIST');
    return rows.map((r) => ({
      id: String(r.Id), user: r.User || '', db: r.db || '',
      state: [r.Command, r.State].filter(Boolean).join(' · '),
      timeSec: Number(r.Time) || 0,
      info: r.Info || '',
    }));
  }

  async killProcess(id) {
    await this.pool.query('KILL ' + Number(id));
  }

  async listRoutines(db) {
    try {
      const rows = await this._q(
        `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, ROUTINE_COMMENT AS comment
         FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ${this.literal(db)}
         ORDER BY ROUTINE_NAME`);
      return rows.map((r) => ({ name: r.name, type: r.type, comment: r.comment || '' }));
    } catch (e) { return []; }
  }

  async listTriggers(db) {
    try {
      const rows = await this._q(`SHOW TRIGGERS FROM ${this.quoteIdent(db)}`);
      return rows.map((r) => ({ name: r.Trigger, table: r.Table, timing: r.Timing, event: r.Event }));
    } catch (e) { return []; }
  }

  async listEvents(db) {
    try {
      const rows = await this._q(`SHOW EVENTS FROM ${this.quoteIdent(db)}`);
      return rows.map((r) => ({ name: r.Name, status: r.Status || '', schedule: r['Interval value'] ? `每 ${r['Interval value']} ${r['Interval field']}` : (r['Execute at'] || '') }));
    } catch (e) { return []; }
  }

  async listUsers() {
    try {
      const rows = await this._q('SELECT User AS name, Host AS host FROM mysql.user ORDER BY User, Host');
      return rows.map((r) => ({ name: r.name, host: r.host }));
    } catch (e) { return []; }
  }

  async objectDdl(db, _schema, kind, name, extra) {
    const T = this.qualify(db, null, name);
    const pick = async (stmt, col) => {
      const rows = await this._q(stmt);
      const v = rows[0] && (rows[0][col] !== undefined ? rows[0][col] : Object.values(rows[0])[2]);
      return v || `-- 无法获取定义（可能缺少权限）`;
    };
    switch (kind) {
      case 'PROCEDURE': return pick(`SHOW CREATE PROCEDURE ${T}`, 'Create Procedure');
      case 'FUNCTION': return pick(`SHOW CREATE FUNCTION ${T}`, 'Create Function');
      case 'TRIGGER': return pick(`SHOW CREATE TRIGGER ${T}`, 'SQL Original Statement');
      case 'EVENT': return pick(`SHOW CREATE EVENT ${T}`, 'Create Event');
      case 'USER': {
        const rows = await this._q(`SHOW GRANTS FOR ${this.literal(name)}@${this.literal(extra || '%')}`);
        return rows.map((r) => Object.values(r)[0] + ';').join('\n');
      }
      default: throw new Error('不支持的对象类型: ' + kind);
    }
  }

  dropUserSql(name, host) {
    return `DROP USER ${this.literal(name)}@${this.literal(host || '%')}`;
  }

  async _run(conn, sql) {
    const [rows, fields] = await conn.query({ sql, rowsAsArray: true });
    // CALL 存储过程等可能返回多结果集：fields 为二维数组
    if (fields && Array.isArray(fields[0])) {
      const multi = [];
      for (let i = 0; i < rows.length; i++) {
        const f = fields[i];
        if (f) {
          multi.push({ columns: f.map((x) => ({ name: x.name, type: '' })), rows: rows[i] });
        } else if (rows[i] && typeof rows[i] === 'object' && 'affectedRows' in rows[i]) {
          multi.push({ affected: rows[i].affectedRows || 0 });
        }
      }
      return { multi };
    }
    if (fields) {
      return { columns: fields.map((f) => ({ name: f.name, type: '' })), rows };
    }
    return {
      affected: (rows && rows.affectedRows) || 0,
      insertId: rows && rows.insertId ? String(rows.insertId) : undefined,
      message: (rows && rows.info) || '',
    };
  }

  /** 内部元数据查询：对象行 */
  async _q(sql) {
    const [rows] = await this.pool.query(sql);
    return rows;
  }

  async listDatabases() {
    const rows = await this._q('SHOW DATABASES');
    return rows.map((r) => Object.values(r)[0]).sort((a, b) => a.localeCompare(b));
  }

  async listObjects(db) {
    const L = (v) => this.literal(v);
    // 主查询用 SHOW FULL TABLES：在所有 MySQL 兼容实现（MySQL/MariaDB/OceanBase 等）上最可靠；
    // information_schema 仅用于补充行数/注释/引擎，失败或缺失不影响表清单。
    const base = await this._q(`SHOW FULL TABLES FROM ${this.quoteIdent(db)}`);
    const tables = [];
    const views = [];
    for (const r of base) {
      const vals = Object.values(r); // 第一列列名是动态的 Tables_in_<db>，第二列 Table_type
      const name = vals[0];
      const type = String(vals[1] || '').toUpperCase();
      if (type.includes('VIEW')) views.push({ name });
      else tables.push({ name, rows: null, comment: '', engine: '' });
    }
    tables.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    views.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    try {
      const meta = await this._q(
        `SELECT TABLE_NAME AS tn, TABLE_ROWS AS trows, TABLE_COMMENT AS tcomment, ENGINE AS tengine
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${L(db)}`);
      const m = new Map(meta.map((x) => [x.tn, x]));
      for (const t of tables) {
        const x = m.get(t.name);
        if (x) {
          t.rows = x.trows === null || x.trows === undefined ? null : Number(x.trows);
          t.comment = x.tcomment || '';
          t.engine = x.tengine || '';
        }
      }
    } catch (e) { /* 元数据补充失败时仅展示名称 */ }
    return { tables, views };
  }

  async tableInfo(db, _schema, table) {
    const T = this.qualify(db, null, table);
    const cols = await this._q(`SHOW FULL COLUMNS FROM ${T}`);
    const columns = cols.map((c) => ({
      name: c.Field,
      type: c.Type,
      nullable: c.Null === 'YES',
      def: c.Default,
      key: c.Key || '',
      extra: c.Extra || '',
      comment: c.Comment || '',
    }));
    const pk = cols.filter((c) => c.Key === 'PRI').map((c) => c.Field);
    let indexes = [];
    try {
      const idx = await this._q(`SHOW INDEX FROM ${T}`);
      const map = new Map();
      for (const r of idx) {
        if (!map.has(r.Key_name)) {
          map.set(r.Key_name, { name: r.Key_name, columns: [], unique: !r.Non_unique, primary: r.Key_name === 'PRIMARY' });
        }
        map.get(r.Key_name).columns.push(r.Column_name);
      }
      indexes = [...map.values()];
    } catch (e) { /* 权限不足时忽略 */ }
    let ddl = '';
    try {
      const rows = await this._q(`SHOW CREATE TABLE ${T}`);
      ddl = rows[0]['Create Table'] || rows[0]['Create View'] || '';
    } catch (e) { /* ignore */ }
    let tableComment = '';
    try {
      const r = await this._q(
        `SELECT TABLE_COMMENT AS tc FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ${this.literal(db)} AND TABLE_NAME = ${this.literal(table)}`);
      tableComment = (r[0] && r[0].tc) || '';
    } catch (e) { /* ignore */ }
    return { columns, indexes, pk, ddl, tableComment };
  }
}

module.exports = { MySQLAdapter };
