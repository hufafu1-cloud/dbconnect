// Apache Doris 适配器（MySQL 协议）
//
// StarRocks 是从 Apache Doris 分叉出去的，两者在客户端可见的层面几乎一致：
// 同样走 MySQL 线协议、同样的 SHOW / information_schema、同样是 OLAP 引擎
// （网格只读、无显式事务、无存储过程/触发器、建表需要分桶与表属性）。
// 因此这里直接继承 StarRocksAdapter，只覆盖版本识别——Doris 没有 current_version()，
// 产品标识在 version_comment 里。
//
// 若后续发现两者在元数据上出现实质分歧，再把共用部分抽成公共基类，不要在这里堆分支。
const { StarRocksAdapter } = require('./starrocks');

class DorisAdapter extends StarRocksAdapter {
  get productName() { return 'Doris'; }

  get defaultPort() { return 9030; }

  get readonlyReason() {
    return 'Doris 表在网格中为只读（明细/聚合模型无法按行定位）。'
      + '改数据请直接用 SQL：INSERT INTO … / UPDATE … WHERE …（仅主键模型）/ DELETE FROM … WHERE …';
  }

  get designerReason() {
    return 'Doris 建表需要声明分桶（DISTRIBUTED BY）与表属性，通用表设计器无法生成有效语句。'
      + '请在查询编辑器中直接编写 CREATE TABLE。';
  }

  get transactionSupport() {
    return { supported: false, warning: 'Doris 不支持交互式显式事务，仅支持自动提交' };
  }

  async _detectVersion() {
    try {
      const rows = await this._q("SHOW VARIABLES LIKE 'version_comment'");
      const comment = rows && rows[0] && (rows[0].Value || rows[0].value);
      if (comment) return String(comment).trim();
    } catch (e) { /* 取不到就用下面的兜底 */ }
    return `Doris（MySQL 兼容 ${String(this.serverVersion || '').replace(/^MySQL\s*/, '')}）`;
  }
}

module.exports = { DorisAdapter };
