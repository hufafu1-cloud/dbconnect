// StarRocks 适配器（MySQL 协议，复用 mysql2 与 MySQL 适配器）
//
// StarRocks 用 MySQL 线协议对外提供服务，SELECT、SHOW FULL TABLES、SHOW FULL COLUMNS、
// information_schema 都能用，所以查询与浏览可以直接继承 MySQLAdapter。
// 但它是 OLAP 引擎，与 OLTP 的差异必须如实反映到界面上，否则会生成跑不通或不安全的 SQL：
//
//   1. 网格只读。只有主键模型（Primary Key）支持按主键 UPDATE/DELETE，明细模型与聚合模型
//      不支持按行定位；且没有通用的唯一键保证。与 ClickHouse 同策略：改数据请直接写 SQL。
//   2. 不支持交互式显式事务。查询标签只能自动提交。
//   3. 没有存储过程 / 触发器 / 事件 / 序列。
//   4. 建表必须声明分桶（DISTRIBUTED BY）与表属性，通用 DDL 生成器产出的语句必然失败，
//      因此直接禁用可视化表设计器，而不是生成一段跑不通的 DDL。
//   5. EXPLAIN 返回单列文本计划，不是 MySQL 的表格计划。
//
// Doris 与 StarRocks 同源（StarRocks 从 Apache Doris 分叉），差异极小，
// 由 doris.js 继承本类后只覆盖版本识别，见该文件说明。
const { MySQLAdapter } = require('./mysql');

class StarRocksAdapter extends MySQLAdapter {
  get productName() { return 'StarRocks'; }

  get defaultPort() { return 9030; }

  get readonlyReason() {
    return 'StarRocks 表在网格中为只读（明细/聚合模型无法按行定位）。'
      + '改数据请直接用 SQL：INSERT INTO … / UPDATE … WHERE …（仅主键模型）/ DELETE FROM … WHERE …';
  }

  get designerReason() {
    return 'StarRocks 建表需要声明分桶（DISTRIBUTED BY）与表属性，通用表设计器无法生成有效语句。'
      + '请在查询编辑器中直接编写 CREATE TABLE。';
  }

  get transactionSupport() {
    return { supported: false, warning: 'StarRocks 不支持交互式显式事务，仅支持自动提交' };
  }

  get objectCaps() {
    // 用户管理暂不开放：StarRocks 没有 mysql.user 表，权限视图各版本差异较大，
    // 与其展示一份可能不准的清单，不如先不提供（待接入真实集群验证后再补）。
    return {
      routines: false, triggers: false, events: false, sequences: false, users: false, processes: true,
    };
  }

  async connect() {
    if (!this.cfg.port) this.cfg.port = this.defaultPort;
    await super.connect();
    this.serverVersion = await this._detectVersion();
  }

  /** StarRocks 用 current_version() 暴露真实版本；VERSION() 返回的是 MySQL 兼容版本号，没有参考价值 */
  async _detectVersion() {
    try {
      const rows = await this._q('SELECT current_version() AS v');
      const v = rows && rows[0] && rows[0].v;
      if (v) return `${this.productName} ${v}`;
    } catch (e) { /* 老版本可能没有该函数，走下面的兜底 */ }
    return `${this.productName}（MySQL 兼容 ${String(this.serverVersion || '').replace(/^MySQL\s*/, '')}）`;
  }

  /** EXPLAIN 返回单列文本计划 */
  async explainPlan(db, sql) {
    const r = await this.exec(db, 'EXPLAIN ' + sql);
    const text = r.rows.map((row) => row.join(' ')).join('\n');
    return { format: 'text', text: text || '(空计划)' };
  }
}

module.exports = { StarRocksAdapter };
