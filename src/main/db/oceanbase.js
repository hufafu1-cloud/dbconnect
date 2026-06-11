// OceanBase 适配器（MySQL 兼容模式，复用 mysql2 驱动）
// 说明：OceanBase 的 MySQL 模式与 MySQL 协议完全兼容（社区版默认），
// 元数据查询（information_schema / SHOW …）与 SQL 方言均沿用 MySQL 适配器。
// 用户名格式：直连 observer 为 用户@租户（如 root@sys）；经 OBProxy 为 用户@租户#集群。
// 默认端口：2881 直连 / 2883 OBProxy。Oracle 模式需 OB 专有客户端，暂不支持。
const { MySQLAdapter } = require('./mysql');

class OceanBaseAdapter extends MySQLAdapter {
  /** OB MySQL 模式不支持事件调度器 */
  get objectCaps() {
    return { ...super.objectCaps, events: false };
  }

  async connect() {
    if (!this.cfg.port) this.cfg.port = 2881;
    await super.connect();
    // 优先用 ob_version() 取真实内核版本；失败则保留 MySQL 兼容版本串并标注
    try {
      const rows = await this._q('SELECT ob_version() AS v');
      this.serverVersion = 'OceanBase ' + rows[0].v;
    } catch (e) {
      this.serverVersion = this.serverVersion.replace(/^MySQL/, 'OceanBase (MySQL 兼容)');
    }
  }
}

module.exports = { OceanBaseAdapter };
