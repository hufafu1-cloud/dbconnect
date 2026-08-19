// 原生 Oracle 适配器（oracledb 的 Thin 模式，纯 JS）
//
// SQL 方言与数据字典与 OceanBase Oracle 模式完全一致，已收敛在 oracleBase.js，
// 本文件只负责 oracledb 这一层传输。相对 mysql2 传输，有五处必须单独处理：
//
// 1. **不加载原生模块**。oracledb 6 起有 Thin 模式，纯 JS 实现 Oracle 线协议，
//    不需要 Instant Client，也不需要按 Electron ABI 重建原生模块。
//    因此**绝不能调用 oracledb.initOracleClient()**——那会切到 Thick 模式并要求本地客户端库。
//
// 2. **数值精度**。oracledb 默认把 NUMBER 映射成 JS number，NUMBER(38) 这类会静默丢精度。
//    本工具承诺导出无损，所以统一按字符串取回，与 MySQL 适配器的
//    supportBigNumbers / bigNumberStrings 是同一思路。
//
// 3. **LOB**。默认返回 Lob 流对象，界面与导出都拿不到内容，因此 CLOB 取成字符串、
//    BLOB 取成 Buffer（BLOB 走 Buffer 才能被 sanitizeValue 转成十六进制预览）。
//
// 4. **日期精度有天花板**（真机实测得出）。Thin 模式一律把 DATE/TIMESTAMP 解码成
//    JS Date，而 JS Date 只到毫秒，TIMESTAMP(6) 的 .123456 在驱动层就变成 .123，
//    客户端无法挽回。曾试图用 fetchAsString / fetchTypeHandler 让它返回字符串，
//    但两者在 Thin 模式下都是**在 JS 侧**用 Date.toString() 转的，得到
//    "Tue Jan 02 2024 03:04:05 GMT+0800 (台北標準時間)" 这种依赖语言环境、
//    连毫秒都没有的串，比默认的 Date 更糟。
//    结论：查询结果里的时间到毫秒为止；需要完整精度的整表原始导出，
//    由 exporter 的服务端投影用 TO_CHAR 取文本绕开驱动（见 exporter.oracleProjection）。
//
// 5. **自动提交**。Oracle 没有 SET AUTOCOMMIT（那是 SQL*Plus 的客户端命令），
//    自动提交由驱动的 autoCommit 选项控制。见下方 TXN_BEGIN / TXN_END 的说明。
const oracledb = require('oracledb');
const { OracleBaseAdapter } = require('./oracleBase');

// 事务开关的内部标记：基类以 SQL 字符串的形式驱动事务开始/清理，
// 而 Oracle 这两步不对应任何服务端语句，只是切换驱动的 autoCommit。
// 这里用两个哨兵字符串把它们表达出来，_run 识别到就只翻转连接上的标记、不发往服务端。
const TXN_BEGIN = '--dbpanda:oracle-txn-begin';
const TXN_END = '--dbpanda:oracle-txn-end';

const invalidSessions = new WeakSet();

class OracleAdapter extends OracleBaseAdapter {
  /** Oracle 的自动提交由驱动控制，没有对应的服务端语句 */
  _transactionBeginSqls() { return [TXN_BEGIN]; }

  _transactionCleanupSqls() { return [TXN_END]; }

  /**
   * 连接串：
   *   服务名（默认）  host:port/service_name —— EZConnect 写法
   *   SID            必须展开成完整的 DESCRIPTION，EZConnect 不支持 SID
   * 用户在连接对话框里选择哪一种，存在 options.connectType。
   */
  _connectString() {
    const c = this.cfg;
    const host = c.host || 'localhost';
    const port = Number(c.port) || 1521;
    const name = String(c.database || '').trim();
    if (!name) throw new Error('请填写 Oracle 的服务名或 SID');
    if ((c.options || {}).connectType === 'sid') {
      return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))`
        + `(CONNECT_DATA=(SID=${name})))`;
    }
    return `${host}:${port}/${name}`;
  }

  async connect() {
    const c = this.cfg;
    // 全进程一次性设置取值方式：保证精度与 LOB 内容不在驱动层就丢失。
    // 只有本适配器使用 oracledb，不会影响其它连接类型。
    // fetchAsString 只接受 NUMBER / DATE(伞形) / TIMESTAMP / CLOB / NCLOB / RAW / JSON；
    // 写入 DB_TYPE_DATE、DB_TYPE_TIMESTAMP_TZ、DB_TYPE_TIMESTAMP_LTZ 会被拒绝
    // （NJS-021 invalid type for conversion），连接直接建不起来——
    // 看着更"精确"，实则是错的：oracledb.DATE 本就是覆盖这几类的伞形常量。
    //
    // 而**日期时间类这里刻意一个都不列**：即便用伞形常量，Thin 模式也是在 JS 侧
    // 用 Date.toString() 转，结果依赖语言环境且丢掉毫秒（见文件头第 4 条）。
    // 保持 JS Date 交给 sanitizeValue 的 formatDate，至少格式确定、保住毫秒。
    oracledb.fetchAsString = [
      oracledb.DB_TYPE_NUMBER,
      oracledb.DB_TYPE_CLOB,
      oracledb.DB_TYPE_NCLOB,
      oracledb.DB_TYPE_JSON,
    ];
    oracledb.fetchAsBuffer = [oracledb.DB_TYPE_BLOB];

    this.pool = await oracledb.createPool({
      user: c.user,
      password: c.password || '',
      connectString: this._connectString(),
      poolMin: 0,
      poolMax: 5,
      poolTimeout: 60,
      queueTimeout: 8000,
    });

    const rows = await this._q(
      "SELECT banner AS \"V\" FROM v$version WHERE ROWNUM = 1",
    ).catch(() => null);
    const banner = rows && rows[0] && (rows[0].V || rows[0].v);
    this.serverVersion = banner ? String(banner).trim() : 'Oracle Database';

    // FETCH FIRST 是 12.1 引入的；11g 及更早只能靠 ROWNUM 子查询分页（基类已实现）
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

  /**
   * 会话级 NLS：固定日期与小数点格式。
   *
   * 注意这只影响**服务端**做的转换（导出时的 TO_CHAR、用户自己写的 TO_CHAR），
   * 不影响驱动取回日期的方式——Thin 模式一律把 DATE/TIMESTAMP 解成 JS Date，
   * 因此查询结果里的时间**最高只有毫秒精度**，这是驱动限制，客户端无法挽回。
   * 需要完整精度的场景（整表原始导出）由 exporter 的服务端投影用 TO_CHAR 取文本。
   */
  async _applySessionFormats(conn) {
    const stmts = [
      "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'",
      "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF6'",
      "ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF6 TZH:TZM'",
      "ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'",
    ];
    for (const sql of stmts) {
      await conn.execute(sql, [], { autoCommit: true });
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
      // 强制丢弃：drop 掉池中的这条连接，不让带着未知状态的会话被复用
      conn.close({ drop: true }).catch(() => {});
    };
    try {
      this._assertRequestActive(requestId);
      await this._applySessionFormats(conn);
      if (db) {
        await conn.execute(
          `ALTER SESSION SET CURRENT_SCHEMA = ${this.quoteIdent(db)}`, [], { autoCommit: true },
        );
      }
      this._assertRequestActive(requestId);
      return await fn(run);
    } finally {
      this._untrackRequestHandle(conn, requestId);
      if (!invalidated && !invalidSessions.has(conn)) {
        released = true;
        // 归池前回滚未提交的改动，避免把脏事务留给下一个使用者
        try { await conn.rollback(); } catch (e) { /* 连接可能已断 */ }
        await conn.close().catch(() => {});
      }
    }
  }

  /**
   * 取消：先 break() 打断正在执行的语句，再丢弃这条连接。
   * 只 break 不丢弃的话，连接会停在一个语句已被中断的不确定状态上，
   * 归池后会污染下一个使用者。
   */
  async cancel(requestId) {
    this._markRequestCancelled(requestId);
    for (const conn of this._requestHandlesFor(requestId)) {
      invalidSessions.add(conn);
      try { await conn.break(); } catch (e) { /* 语句可能刚好结束 */ }
      conn.close({ drop: true }).catch(() => {});
    }
  }

  async _run(conn, sql, opts) {
    // 事务哨兵：不发往服务端，只翻转本连接的自动提交状态
    if (sql === TXN_BEGIN) { conn.__dbpandaInTxn = true; return { affected: 0, message: '' }; }
    if (sql === TXN_END) { conn.__dbpandaInTxn = false; return { affected: 0, message: '' }; }

    const limited = this._prepareScriptQuery(sql, opts);
    const result = await conn.execute(limited.sql, [], {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      // 事务期间必须关掉自动提交，否则每条语句都会立刻落库、回滚就没有意义
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

  /**
   * 内部元数据查询。返回行对象，列名保持 Oracle 的大写形态——
   * 方言层统一用 val(r, key) 兼容大小写读取，与 mysql2 传输一致。
   */
  async _q(sql) {
    const conn = await this.pool.getConnection();
    try {
      const result = await conn.execute(sql, [], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        autoCommit: true,
      });
      return result.rows || [];
    } finally {
      await conn.close().catch(() => {});
    }
  }
}

module.exports = { OracleAdapter, TXN_BEGIN, TXN_END };
