// OceanBase Oracle 模式适配器（实验性）
// 原理：OceanBase 所有租户走同一套 MySQL 兼容线协议（官方 OBClient/JDBC 亦基于此），
// 因此用 mysql2 连接 Oracle 模式租户。SQL 方言与数据字典与原生 Oracle 一致，
// 已收敛到 oracleBase.js，本文件只负责 mysql2 这一层传输。
// 注意：官方不承诺原生 MySQL 客户端对 Oracle 租户的完全兼容，个别类型/语句可能异常（实验性）。
// 用户名格式：直连为 用户@租户（如 SYS@oracle_tenant），经 OBProxy 为 用户@租户#集群。
const mysql = require('mysql2/promise');
const { OracleBaseAdapter } = require('./oracleBase');

const invalidSessions = new WeakSet();

class OBOracleAdapter extends OracleBaseAdapter {
  /** OceanBase 走 MySQL 线协议，可以直接用 SET AUTOCOMMIT 控制事务 */
  _transactionBeginSqls() { return ['SET AUTOCOMMIT = 0']; }

  _transactionCleanupSqls() { return ['SET AUTOCOMMIT = 1']; }

  async connect() {
    const c = this.cfg;
    this.pool = mysql.createPool({
      host: c.host || 'localhost',
      port: Number(c.port) || 2881,
      user: c.user,
      password: c.password || '',
      waitForConnections: true,
      connectionLimit: 5,
      resetOnRelease: true,
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      connectTimeout: 8000,
    });
    try {
      const [rows] = await this.pool.query('SELECT ob_version() AS "V" FROM dual');
      this.serverVersion = 'OceanBase(Oracle) ' + rows[0].V;
    } catch (e) {
      const [rows] = await this.pool.query('SELECT 1 AS "V" FROM dual'); // 至少验证 Oracle 方言可用
      this.serverVersion = 'OceanBase (Oracle 模式)';
    }
    try {
      await this.pool.query('SELECT 1 AS "V" FROM dual FETCH FIRST 1 ROWS ONLY');
      this.supportsFetchFirst = true;
    } catch (e) {
      this.supportsFetchFirst = false;
    }
  }


  async close() {
    if (this.pool) await this.pool.end().catch(() => {});
    this.pool = null;
  }


  async withSession(db, fn, opts) {
    const requestId = this._requestId(opts);
    this._assertRequestActive(requestId);
    const conn = await this._acquireForRequest(
      () => this.pool.getConnection(),
      (late) => late.release(),
      requestId,
    );
    this._trackRequestHandle(conn, requestId);
    const run = (sql, runOpts) => this._run(conn, sql, runOpts);
    run.requestHandle = conn;
    let invalidated = false;
    let released = false;
    run.invalidate = () => {
      if (invalidated || released) return;
      invalidated = true;
      invalidSessions.add(conn);
      try { conn.destroy(); } catch (e) { /* already disconnected */ }
    };
    try {
      this._assertRequestActive(requestId);
      if (db) await conn.query(`ALTER SESSION SET CURRENT_SCHEMA = ${this.quoteIdent(db)}`);
      this._assertRequestActive(requestId);
      return await fn(run);
    } finally {
      this._untrackRequestHandle(conn, requestId);
      if (!invalidated && !invalidSessions.has(conn)) {
        released = true;
        conn.release();
      }
    }
  }


  /** 销毁目标会话本身，避免兼容层线程 ID 被连接池复用后误杀后续查询。 */
  async cancel(requestId) {
    this._markRequestCancelled(requestId);
    for (const conn of this._requestHandlesFor(requestId)) {
      try { invalidSessions.add(conn); conn.destroy(); } catch (e) { /* 会话可能刚好结束 */ }
    }
  }


  async _run(conn, sql, opts) {
    const limited = this._prepareScriptQuery(sql, opts);
    const [rows, fields] = await conn.query({ sql: limited.sql, rowsAsArray: true });
    if (fields && Array.isArray(fields[0])) {
      const multi = [];
      for (let i = 0; i < rows.length; i++) {
        const f = fields[i];
        if (f) multi.push({ columns: f.map((x) => ({ name: x.name, type: '' })), rows: rows[i], rowLimitApplied: limited.applied });
        else if (rows[i] && typeof rows[i] === 'object' && 'affectedRows' in rows[i]) multi.push({ affected: rows[i].affectedRows || 0 });
      }
      return { multi };
    }
    if (fields) {
      return { columns: fields.map((f) => ({ name: f.name, type: '' })), rows, rowLimitApplied: limited.applied };
    }
    return { affected: (rows && rows.affectedRows) || 0, message: (rows && rows.info) || '' };
  }


  /** 内部元数据查询（对象行） */
  async _q(sql) {
    const [rows] = await this.pool.query(sql);
    return rows;
  }
}

module.exports = { OBOracleAdapter };
