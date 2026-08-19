// TiDB 适配器（MySQL 协议，复用 mysql2 与 MySQL 适配器）
//
// TiDB 对 MySQL 协议与 SQL 方言高度兼容，information_schema / SHOW 系列都能用，
// 因此绝大部分实现直接继承 MySQLAdapter。真正需要区分的只有下面四点：
//   1. 不支持存储过程 / 触发器 / 事件调度器（TiDB 至今没有实现）
//   2. 支持 CREATE SEQUENCE（MySQL 没有的扩展）
//   3. KILL 默认只作用于当前 TiDB 节点，跨节点要用 KILL TIDB
//   4. EXPLAIN 的输出列与 MySQL 完全不同
const { MySQLAdapter } = require('./mysql');

class TiDBAdapter extends MySQLAdapter {
  get objectCaps() {
    return { ...super.objectCaps, routines: false, triggers: false, events: false, sequences: true };
  }

  async connect() {
    if (!this.cfg.port) this.cfg.port = 4000;
    await super.connect();
    // VERSION() 形如 8.0.11-TiDB-v7.5.0，取 TiDB 自己的版本号才有意义
    const m = /-TiDB-(v?[\w.-]+)/i.exec(this.serverVersion || '');
    this.serverVersion = m
      ? 'TiDB ' + m[1]
      : String(this.serverVersion || '').replace(/^MySQL/, 'TiDB (MySQL 兼容)');
  }

  /**
   * TiDB 是分布式的：一个连接只落在某个 TiDB 节点上，普通 KILL 只能杀本节点的连接。
   * KILL TIDB 会按全局 connection id 路由到正确的节点。
   */
  async killProcess(id) {
    await this.pool.query('KILL TIDB ' + Number(id));
  }

  async listSequences(db) {
    try {
      const rows = await this._q(
        `SELECT SEQUENCE_NAME AS name FROM information_schema.SEQUENCES
         WHERE SEQUENCE_SCHEMA = ${this.literal(db)} ORDER BY SEQUENCE_NAME`);
      return rows.map((r) => ({ name: r.name }));
    } catch (e) { return []; }
  }

  /** SHOW FULL TABLES 会把序列也列成表，剔除后避免它在「表」和「序列」下各出现一次 */
  async listObjects(db) {
    const objs = await super.listObjects(db);
    try {
      const seqs = new Set((await this.listSequences(db)).map((s) => s.name));
      if (seqs.size) objs.tables = objs.tables.filter((t) => !seqs.has(t.name));
    } catch (e) { /* 取不到序列时按原样返回，不影响表清单 */ }
    return objs;
  }

  /**
   * TiDB 的 EXPLAIN 列是 id / estRows / task / access object / operator info，
   * 没有 MySQL 的 type 列，沿用父类的高亮规则只会错标，这里不做优劣着色。
   */
  async explainPlan(db, sql) {
    const { sanitizeRows } = require('./sqlutil');
    const r = await this.exec(db, 'EXPLAIN ' + sql);
    return {
      format: 'table',
      columns: r.columns.map((c) => c.name),
      rows: sanitizeRows(r.rows),
    };
  }
}

module.exports = { TiDBAdapter };
