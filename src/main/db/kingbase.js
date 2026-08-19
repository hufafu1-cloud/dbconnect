// 人大金仓 KingbaseES 适配器（PostgreSQL 线协议，复用 pg 驱动与 PostgreSQL 适配器）
//
// KingbaseES V8 起对 PostgreSQL 线协议与 pg_catalog 高度兼容，查询、元数据、DDL 全部
// 沿用 PostgresAdapter。与原生 PostgreSQL 的差别集中在部署约定而非 SQL 行为：
//   - 默认端口 54321（不是 5432）
//   - 默认超级用户 system、默认库 test
//   - 内核基于较老的 PostgreSQL（V8R6 约相当于 PG 10），没有 pg_proc.prokind、
//     没有 pg_sequences 视图；这些 PostgresAdapter 已按版本逐级降级，无需在此重复处理
//
// 认证：KingbaseES 支持 md5 / scram-sha-256 / sm3。前两者标准 pg 驱动可用；
// 若实例配置为国密 sm3，标准驱动无法握手，需在服务端改用 scram-sha-256 或 md5。
const { PostgresAdapter } = require('./postgres');

/** 国密 sm3 认证时 pg 驱动会以这些形态失败 */
const SM3_FAILURE_PATTERNS = [
  /Unknown authenticationOk message type/i,
  /SASL:\s*Only mechanism/i,
];

const SM3_HELP = [
  'KingbaseES 若配置为国密 sm3 认证，标准 PostgreSQL 驱动无法完成握手。',
  '请在服务端改用标准认证方式后重试：',
  '  1) kingbase.conf 设置 password_encryption_type = 1（md5）或使用 scram-sha-256',
  '  2) sys_hba.conf 中该客户端网段的认证方式同步改为 md5 / scram-sha-256',
  '  3) 重启实例后重设一次用户密码，令口令按新方式重新摘要',
].join('\n');

class KingbaseAdapter extends PostgresAdapter {
  async connect() {
    if (!this.cfg.port) this.cfg.port = 54321;
    try {
      await super.connect();
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (SM3_FAILURE_PATTERNS.some((re) => re.test(msg))) {
        const wrapped = new Error(`连接 KingbaseES 失败：${msg}\n\n${SM3_HELP}`);
        wrapped.cause = err;
        throw wrapped;
      }
      throw err;
    }
    this.serverVersion = this._formatVersion(this.serverVersionRaw);
  }

  /** version() 形如 "KingbaseES V008R006C005B0023 on x86_64..."，取产品与版本号 */
  _formatVersion(raw) {
    const text = String(raw || '');
    const m = /(KingbaseES\s+[\w.]+)/i.exec(text);
    if (m) return m[1];
    return text ? `${text.slice(0, 40)}（未检出 KingbaseES 标识）` : 'KingbaseES';
  }
}

module.exports = { KingbaseAdapter };
