// PolarDB for MySQL 适配器（MySQL 协议，复用 mysql2 与 MySQL 适配器）
//
// PolarDB 的 MySQL 版是阿里云对 MySQL 的存算分离改造，对客户端而言与原生 MySQL
// 完全一致：同一套协议、同一套 information_schema、同样的 SHOW 命令与 SQL 方言。
// 因此这里**只做品牌与版本识别**，不覆盖任何元数据或 SQL 行为——
// 独立成一种类型是为了让用户在新建连接时能直接找到它、并在界面上看到真实的服务端版本，
// 而不是显示成"MySQL"。若将来发现真实差异，再在此处按需覆盖。
const { MySQLAdapter } = require('./mysql');

class PolarDBAdapter extends MySQLAdapter {
  async connect() {
    await super.connect();
    // PolarDB 的 VERSION() 返回兼容版本号（如 8.0.13），产品标识在 version_comment 里
    try {
      const rows = await this._q("SHOW VARIABLES LIKE 'version_comment'");
      const comment = rows && rows[0] && (rows[0].Value || rows[0].value);
      if (comment && /polardb/i.test(comment)) {
        this.serverVersion = 'PolarDB ' + String(this.serverVersion || '').replace(/^MySQL\s*/, '');
      } else {
        // 连的可能其实是原生 MySQL：如实显示，不替用户改写成 PolarDB
        this.serverVersion = String(this.serverVersion || '') + '（未检出 PolarDB 标识）';
      }
    } catch (e) {
      this.serverVersion = 'PolarDB ' + String(this.serverVersion || '').replace(/^MySQL\s*/, '');
    }
  }
}

module.exports = { PolarDBAdapter };
