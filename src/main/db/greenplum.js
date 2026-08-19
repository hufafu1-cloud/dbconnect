// Greenplum 适配器（PostgreSQL 线协议，复用 pg 驱动与 PostgreSQL 适配器）
//
// Greenplum 是基于 PostgreSQL 的 MPP 数据仓库：GP6 内核约为 PG 9.4，GP7 约为 PG 12。
// 线协议、pg_catalog、information_schema 全部兼容，因此直接继承 PostgresAdapter。
//
// 需要注意的两点，都已由父类覆盖，此处只做说明：
//   - GP6 没有 pg_proc.prokind、没有 pg_sequences 视图（PG 9.4 时代的目录）。
//     PostgresAdapter 已按服务端版本逐级降级（v2.6.2 为 PostgreSQL 9.6 所做的修复），
//     Greenplum 直接受益，不必重复处理。
//   - 建表可以不写 DISTRIBUTED BY，Greenplum 会自行选择分布键并给出 NOTICE。
//     因此可视化表设计器保持可用；但生成的表分布键未必最优，
//     对性能敏感的表建议在查询编辑器里显式写 DISTRIBUTED BY。
const { PostgresAdapter } = require('./postgres');

class GreenplumAdapter extends PostgresAdapter {
  async connect() {
    await super.connect();
    this.serverVersion = this._formatVersion(this.serverVersionRaw);
  }

  /**
   * version() 形如
   *   "PostgreSQL 9.4.24 (Greenplum Database 6.25.3 build commit:...) on x86_64..."
   * 父类只取到前面的 "PostgreSQL 9.4.24"，Greenplum 的真实版本在括号里，这里取出来。
   */
  _formatVersion(raw) {
    const text = String(raw || '');
    const m = /Greenplum Database\s+([\w.]+)/i.exec(text);
    if (m) {
      const pg = /^PostgreSQL\s+(\S+)/.exec(text);
      return pg ? `Greenplum ${m[1]}（PostgreSQL ${pg[1]} 内核）` : `Greenplum ${m[1]}`;
    }
    return text ? `${text.slice(0, 40)}（未检出 Greenplum 标识）` : 'Greenplum';
  }
}

module.exports = { GreenplumAdapter };
