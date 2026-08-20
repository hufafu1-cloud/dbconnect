// 达梦 DM8 适配器（dmdb 官方驱动，纯 JS）
//
// 达梦是 Oracle 兼容方言：标识符双引号且默认大写、字符串无反斜杠转义、ROWNUM 分页、
// 「数据库」层级即 Schema、数据字典用 all_* 视图。这些已经收敛在 oracleBase.js，
// 本文件只负责 dmdb 这一层传输——与 oracle.js 是并列关系，不是继承关系。
//
// dmdb 的 API 基本对齐 node-oracledb（createPool / getConnection / execute /
// outFormat / fetchAsString / autoCommit），因此传输层可以照 oracle.js 写。
// 但有几处必须单独处理：
//
// 1. **不加载原生模块**。dmdb 是纯 JS 实现的达梦线协议，不需要达梦客户端库，
//    也不需要按 Electron ABI 重建，与 oracledb 的 Thin 模式同理。
//
// 2. **数值精度**。dmdb 从 v1.0.10728 起把 NUMBER/NUMERIC 默认返回成 JS number，
//    官方变更日志明确写了"超过 js number 安全范围则不能保证数据正确性"。
//    本工具承诺导出无损，因此统一用 fetchAsString 按字符串取回——
//    与 Oracle 适配器、MySQL 的 bigNumberStrings 是同一思路。
//
// 3. **LOB**。与 oracledb 一样默认返回流对象，界面与导出都拿不到内容，
//    因此 CLOB 取成字符串、BLOB 取成 Buffer（Buffer 才能被 sanitizeValue 转十六进制预览）。
//
// 4. **自动提交**由驱动选项控制，没有对应的服务端语句，沿用 oracle.js 的哨兵做法。
//
// ⚠ 未经真机验证：达梦没有公开可用的容器镜像（需授权），本适配器只经过
// 静态检查与自检覆盖。首次接入真实实例时请重点关注连接握手与数据字典兼容性。
const dmdb = require('dmdb');
const { OracleBaseAdapter } = require('./oracleBase');

// 与 oracle.js 同款哨兵：基类以 SQL 字符串驱动事务开始/清理，
// 而这两步在达梦只是翻转驱动的 autoCommit，不对应任何服务端语句。
const TXN_BEGIN = '--dbpanda:dm-txn-begin';
const TXN_END = '--dbpanda:dm-txn-end';

const invalidSessions = new WeakSet();

class DMAdapter extends OracleBaseAdapter {
  _transactionBeginSqls() { return [TXN_BEGIN]; }

  _transactionCleanupSqls() { return [TXN_END]; }

  /**
   * 连接串：dmdb 只接受 `dm://用户:密码@主机:端口` 这一种形式（PoolAttributes.connectString
   * 是必填项，没有分离的 user/password 字段）。
   *
   * 两个已核实的坑（读驱动源码 + 实测 Node url.parse 得出）：
   *
   * 1. dmdb 用 url.parse 取 auth 段，而 url.parse **会**解 percent 转义，
   *    因此密码必须 encodeURIComponent，否则含 @ 的密码会把 host 切错。
   *
   * 2. 但 dmdb 随后是按 `auth.split(':')` 取用户和密码的，**含冒号的密码必然被截断**
   *    （My:Pass 会变成 My）——而且转义也救不了：url.parse 先把 %3A 解回冒号，
   *    切分仍然错。这是驱动的硬限制，客户端无法绕过。
   *    与其让用户面对一句莫名的"认证失败"，不如在这里提前拦下并说清原因。
   */
  _connectString() {
    const c = this.cfg;
    const password = String(c.password || '');
    if (password.includes(':')) {
      throw new Error('达梦驱动（dmdb）的连接串按冒号切分用户名与密码，'
        + '密码中包含冒号时会被截断、导致认证失败，且无法通过转义规避。'
        + '请在达梦中把该用户的密码改成不含冒号的形式后重试。');
    }
    const user = encodeURIComponent(String(c.user || ''));
    const host = c.host || 'localhost';
    const port = Number(c.port) || 5236;
    return `dm://${user}:${encodeURIComponent(password)}@${host}:${port}`;
  }

  async connect() {
    const c = this.cfg;
    // 全进程一次性设置取值方式，保证精度与 LOB 内容不在驱动层丢失。
    // 只有本适配器使用 dmdb，不会影响其它连接类型。
    dmdb.fetchAsString = [dmdb.NUMBER, dmdb.CLOB];
    dmdb.fetchAsBuffer = [dmdb.BLOB];

    this.pool = await dmdb.createPool({
      connectString: this._connectString(),
      poolMin: 0,
      poolMax: 5,
      poolTimeout: 60,
      queueTimeout: 8000,
    });

    // 达梦的版本信息在 v$version / PRODUCT_COMPONENT_VERSION，逐级降级取
    let banner = null;
    for (const sql of [
      'SELECT BANNER AS "V" FROM v$version WHERE ROWNUM = 1',
      'SELECT PRODUCT AS "V" FROM PRODUCT_COMPONENT_VERSION WHERE ROWNUM = 1',
      "SELECT '达梦数据库' AS \"V\" FROM dual",
    ]) {
      try {
        const rows = await this._q(sql);
        const v = rows && rows[0] && (rows[0].V !== undefined ? rows[0].V : rows[0].v);
        if (v) { banner = String(v).trim(); break; }
      } catch (e) { /* 试下一种写法 */ }
    }
    this.serverVersion = banner || 'DM Database';

    // 达梦支持 Oracle 12c 风格的 FETCH FIRST；取不到就退回基类的 ROWNUM 子查询分页
    try {
      await this._q('SELECT 1 AS "V" FROM dual FETCH FIRST 1 ROWS ONLY');
      this.supportsFetchFirst = true;
    } catch (e) {
      this.supportsFetchFirst = false;
    }
  }

  async close() {
    if (this.pool) await this.pool.close(0).catch(() => {});
    this.pool = null;
  }

  /** 会话级格式：与 Oracle 适配器同样固定日期与小数点写法，保证服务端 TO_CHAR 结果确定 */
  async _applySessionFormats(conn) {
    const stmts = [
      "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'",
      "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF6'",
    ];
    for (const sql of stmts) {
      // 达梦对个别 NLS 参数的支持与 Oracle 不完全一致，设不上不应导致整条会话失败
      try { await conn.execute(sql, [], { autoCommit: true }); } catch (e) { /* 忽略 */ }
    }
  }

  async withSession(db, fn, opts) {
    const requestId = this._requestId(opts);
    this._assertRequestActive(requestId);
    const conn = await this._acquireForRequest(
      () => this.pool.getConnection(),
      (late) => late.close().catch(() => {}),
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
      conn.close().catch(() => {});
    };
    try {
      this._assertRequestActive(requestId);
      await this._applySessionFormats(conn);
      if (db) {
        await conn.execute(
          `SET SCHEMA ${this.quoteIdent(db)}`, [], { autoCommit: true },
        );
      }
      this._assertRequestActive(requestId);
      return await fn(run);
    } finally {
      this._untrackRequestHandle(conn, requestId);
      if (!invalidated && !invalidSessions.has(conn)) {
        released = true;
        try { await conn.rollback(); } catch (e) { /* 连接可能已断 */ }
        await conn.close().catch(() => {});
      }
    }
  }

  /**
   * 取消：dmdb 没有 oracledb 那样的 break()，只能丢弃连接。
   * 与 MySQL 适配器的处理一致——服务端语句可能仍在跑到自然结束，
   * 但至少调用方会立刻拿到"已取消"，且这条脏连接不会被复用。
   */
  async cancel(requestId) {
    this._markRequestCancelled(requestId);
    for (const conn of this._requestHandlesFor(requestId)) {
      invalidSessions.add(conn);
      conn.close().catch(() => {});
    }
  }

  async _run(conn, sql, opts) {
    if (sql === TXN_BEGIN) { conn.__dbpandaInTxn = true; return { affected: 0, message: '' }; }
    if (sql === TXN_END) { conn.__dbpandaInTxn = false; return { affected: 0, message: '' }; }

    const limited = this._prepareScriptQuery(sql, opts);
    const result = await conn.execute(limited.sql, [], {
      outFormat: dmdb.OUT_FORMAT_ARRAY,
      autoCommit: !conn.__dbpandaInTxn,
    });
    if (result.metaData) {
      return {
        columns: result.metaData.map((m) => ({ name: m.name, type: '' })),
        rows: result.rows || [],
        rowLimitApplied: limited.applied,
      };
    }
    return { affected: result.rowsAffected || 0, message: '' };
  }

  /** 内部元数据查询；列名保持大写形态，方言层用 val(r, key) 兼容读取 */
  async _q(sql) {
    const conn = await this.pool.getConnection();
    try {
      const result = await conn.execute(sql, [], {
        outFormat: dmdb.OUT_FORMAT_OBJECT,
        autoCommit: true,
      });
      return result.rows || [];
    } finally {
      await conn.close().catch(() => {});
    }
  }
}

module.exports = { DMAdapter, TXN_BEGIN, TXN_END };
