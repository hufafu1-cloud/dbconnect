// openGauss / GaussDB 适配器（PostgreSQL 线协议，复用 pg 驱动与 PostgreSQL 适配器）
//
// openGauss 的内核基于 PostgreSQL 9.2.4，线协议、information_schema、pg_catalog 都兼容，
// 因此查询与元数据直接继承 PostgresAdapter。需要单独处理的只有两件事：
//
// 1. **认证方式**。openGauss 默认 password_encryption_type = 2（自研 SHA256 认证），
//    它不是标准的 SCRAM-SHA-256，node-postgres 无法完成握手。这是接入 openGauss
//    最常见、也最难自查的失败点——原始报错是 "Unknown authenticationOk message type"
//    或 "SASL: Only mechanism(s) ... are supported"，用户完全看不出该改什么。
//    这里把它翻译成可操作的中文指引，见 _translateAuthError。
//    我们不引入 openGauss 官方的 node 连接器分支：多一个 pg 驱动会长期分叉维护成本，
//    而服务端改一个参数即可兼容标准驱动。
//
// 2. **9.2 时代的目录**。没有 pg_proc.prokind、没有 pg_sequences 视图、没有 attidentity。
//    这些 PostgresAdapter 已经做了逐级降级（见 v2.6.2 对 PostgreSQL 9.6 的修复），
//    此处无需重复处理。
//
// GaussDB（华为云商业版）与 openGauss 同源，用本类型连接即可。
const { PostgresAdapter } = require('./postgres');

/** node-postgres 在遇到 openGauss 自研认证时会抛出的几种签名 */
const AUTH_FAILURE_PATTERNS = [
  /Unknown authenticationOk message type/i,
  /SASL:\s*Only mechanism/i,
  /SASL:\s*SCRAM-SERVER-FIRST-MESSAGE/i,
  /unsupported authentication/i,
];

const AUTH_HELP = [
  'openGauss 默认使用自研的 SHA256 认证，标准 PostgreSQL 驱动无法完成握手。',
  '请在服务端改为标准驱动可用的认证方式后重试：',
  '  1) postgresql.conf 设置 password_encryption_type = 1',
  '  2) pg_hba.conf 中该客户端网段的认证方式改为 md5（或 sm3 以外的标准方式）',
  '  3) 重启实例后，用 ALTER USER <用户> IDENTIFIED BY \'<新密码>\' 重设一次密码',
  '     （改参数不会重算已有密码，必须重设才会生成新格式的口令摘要）',
].join('\n');

class OpenGaussAdapter extends PostgresAdapter {
  async connect() {
    try {
      await super.connect();
    } catch (err) {
      throw this._translateAuthError(err);
    }
    this.serverVersion = this._formatVersion(this.serverVersionRaw);
  }

  /**
   * 把 pg 驱动那句看不懂的握手失败，换成写明该改哪个参数的提示。
   * 非认证类错误原样抛出，不要吞掉真实原因。
   */
  _translateAuthError(err) {
    const msg = (err && err.message) || String(err);
    if (!AUTH_FAILURE_PATTERNS.some((re) => re.test(msg))) return err;
    const wrapped = new Error(`连接 openGauss 失败：${msg}\n\n${AUTH_HELP}`);
    wrapped.cause = err;
    return wrapped;
  }

  /** version() 形如 "(openGauss 5.0.0 build ...) compiled at ..."，取产品与版本号即可 */
  _formatVersion(raw) {
    const text = String(raw || '');
    // 版本号必须以数字开头：GaussDB 的 version() 是 "GaussDB Kernel 505.1.0 build …"，
    // 只匹配 \w+ 会把 "Kernel" 当成版本号
    const m = /openGauss\s+V?(\d[\w.]*)/i.exec(text);
    if (m) return `openGauss ${m[1]}`;
    const g = /GaussDB(?:\s+Kernel)?\s+V?(\d[\w.]*)/i.exec(text);
    if (g) return `GaussDB ${g[1]}`;
    return text ? `${text}（未检出 openGauss 标识）` : 'openGauss';
  }
}

module.exports = { OpenGaussAdapter, AUTH_FAILURE_PATTERNS, AUTH_HELP };
