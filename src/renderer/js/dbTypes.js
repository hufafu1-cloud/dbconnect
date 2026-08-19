// 数据库类型注册表 —— 渲染层新增一种数据库类型，只改这一处。
//
// 主进程侧另需在 src/main/db/index.js 注册适配器；两边的类型 id 必须完全一致，
// 由 scripts/test-db-types.js 断言，不一致直接测试失败。
//
// 为什么要有这张表：在此之前「支持哪些类型」散落在十来处硬编码里——显示名、图标、
// 默认端口、编辑器模式、格式化语言、标识符引号风格、反斜杠转义、进程列表能力、
// 建删库能力……其中「进程列表」的类型数组在 tree.js 与 app.js 各写了一份、必须手工同步，
// 而 base.js 的 objectCaps.processes 这个能力位早就存在却没被用上。
// 加一种类型要改十来处，必然漏改。
//
// 边界：这张表只放**不连数据库就能确定**的静态信息。需要连上才知道的能力
// （有没有存储过程/触发器/序列、网格是否只读、支持哪些数据类型）仍然由适配器的
// objectCaps / readonlyReason 经 IPC 下发，不要往这里搬。

const QUOTE = {
  backtick: (n) => '`' + String(n).replace(/`/g, '``') + '`',
  bracket: (n) => '[' + String(n).replace(/\]/g, ']]') + ']',
  double: (n) => '"' + String(n).replace(/"/g, '""') + '"',
};

/**
 * caps 各位的含义（都是「不连库也能判断」的静态能力）：
 *   processes      支持进程/会话列表
 *   manageDatabase 支持新建 / 删除数据库
 *   transactions   支持显式事务（关闭者只能自动提交）
 *   schemas        界面按模式（schema）层级组织：树上多一层，查询标签与各对话框提供模式选择
 *   merge          支持生成 MERGE 语句
 *   designer       支持可视化表设计器（建表语法与通用 SQL 差异过大的方言关掉）
 *
 * 另有两个可选字段：
 *   experimental   true 表示尚未在真实实例上端到端验证（或官方不承诺兼容），
 *                  连接对话框会明确标注，避免用户把未验证当成已验证
 *   note           该类型的连接提示，显示在对话框里；写"用户需要提前知道的事"，
 *                  例如 openGauss 必须先改服务端认证参数才能连
 */
export const DB_TYPES = {
  mysql: {
    label: 'MySQL / MariaDB',
    shortLabel: 'MySQL',
    icon: 'mysql',
    dialect: 'mysql',
    cmMode: 'text/x-mysql',
    formatLang: 'mysql',
    defaults: { port: 3306, user: 'root', database: '' },
    quote: 'backtick',
    backslashEscape: true,
    caps: { processes: true, manageDatabase: true, transactions: true, schemas: false, designer: true, merge: false },
  },
  postgres: {
    label: 'PostgreSQL',
    icon: 'postgres',
    dialect: 'postgres',
    cmMode: 'text/x-pgsql',
    formatLang: 'postgresql',
    defaults: { port: 5432, user: 'postgres', database: 'postgres' },
    quote: 'double',
    backslashEscape: false,
    caps: { processes: true, manageDatabase: true, transactions: true, schemas: true, designer: true, merge: true },
  },
  sqlite: {
    label: 'SQLite',
    icon: 'sqlite',
    dialect: 'sqlite',
    cmMode: 'text/x-sqlite',
    formatLang: 'sqlite',
    defaults: {},
    quote: 'double',
    backslashEscape: false,
    // 单文件数据库，没有「数据库」层级，固定用 main
    fixedDatabase: 'main',
    fileBased: true,
    caps: { processes: false, manageDatabase: false, transactions: true, schemas: false, designer: true, merge: false },
  },
  mssql: {
    label: 'SQL Server',
    icon: 'mssql',
    dialect: 'mssql',
    cmMode: 'text/x-mssql',
    formatLang: 'transactsql',
    defaults: { port: 1433, user: 'sa', database: 'master' },
    quote: 'bracket',
    backslashEscape: false,
    caps: { processes: true, manageDatabase: true, transactions: true, schemas: false, designer: true, merge: true },
  },
  clickhouse: {
    label: 'ClickHouse',
    icon: 'clickhouse',
    dialect: 'clickhouse',
    cmMode: 'text/x-mysql',
    formatLang: 'mysql',
    defaults: { port: 8123, user: 'default', database: 'default' },
    quote: 'backtick',
    backslashEscape: true,
    caps: { processes: true, manageDatabase: true, transactions: false, schemas: false, designer: true, merge: false },
  },
  oceanbase: {
    label: 'OceanBase (MySQL 模式)',
    shortLabel: 'OceanBase',
    icon: 'oceanbase',
    dialect: 'mysql',
    cmMode: 'text/x-mysql',
    formatLang: 'mysql',
    defaults: { port: 2881, user: 'root@sys', database: '' },
    quote: 'backtick',
    backslashEscape: true,
    caps: { processes: true, manageDatabase: true, transactions: true, schemas: false, designer: true, merge: false },
  },
  oboracle: {
    label: 'OceanBase (Oracle 模式)',
    shortLabel: 'OB·Oracle',
    icon: 'oboracle',
    dialect: 'oracle',
    cmMode: 'text/x-plsql',
    formatLang: 'plsql',
    defaults: { port: 2881, user: 'SYS@', database: '' },
    quote: 'double',
    backslashEscape: false,
    // 「数据库」层级实为 Oracle 的 Schema（用户），建删走 CREATE/DROP USER，不提供菜单
    experimental: true,
    caps: { processes: false, manageDatabase: false, transactions: true, schemas: false, designer: true, merge: true },
  },
  tidb: {
    label: 'TiDB',
    icon: 'tidb',
    dialect: 'mysql',
    cmMode: 'text/x-mysql',
    formatLang: 'mysql',
    defaults: { port: 4000, user: 'root', database: '' },
    quote: 'backtick',
    backslashEscape: true,
    // TiDB 没有存储过程 / 触发器 / 事件，但有序列；这些是运行时能力，由 objectCaps 下发
    experimental: true,
    note: 'TiDB 不支持存储过程、触发器与事件调度器；序列为 TiDB 扩展，会单列在「序列」节点下。',
    caps: { processes: true, manageDatabase: true, transactions: true, schemas: false, designer: true, merge: false },
  },
  polardb: {
    label: 'PolarDB for MySQL',
    shortLabel: 'PolarDB',
    icon: 'polardb',
    dialect: 'mysql',
    cmMode: 'text/x-mysql',
    formatLang: 'mysql',
    defaults: { port: 3306, user: 'root', database: '' },
    quote: 'backtick',
    backslashEscape: true,
    experimental: true,
    note: 'PolarDB 的 MySQL 版对客户端与原生 MySQL 一致；若连接的其实是原生 MySQL，版本处会如实标注。',
    caps: { processes: true, manageDatabase: true, transactions: true, schemas: false, designer: true, merge: false },
  },
  starrocks: {
    label: 'StarRocks',
    icon: 'starrocks',
    dialect: 'mysql',
    cmMode: 'text/x-mysql',
    formatLang: 'mysql',
    defaults: { port: 9030, user: 'root', database: '' },
    quote: 'backtick',
    backslashEscape: true,
    // OLAP：网格只读、无显式事务、建表需分桶与表属性，故关掉设计器
    experimental: true,
    note: 'OLAP 引擎：表数据网格为只读，且不提供可视化表设计器（建表需声明分桶与表属性）。'
      + '改数据与建表请在查询编辑器中直接写 SQL。',
    caps: { processes: true, manageDatabase: true, transactions: false, schemas: false, designer: false, merge: false },
  },
  doris: {
    label: 'Apache Doris',
    shortLabel: 'Doris',
    icon: 'doris',
    dialect: 'mysql',
    cmMode: 'text/x-mysql',
    formatLang: 'mysql',
    defaults: { port: 9030, user: 'root', database: '' },
    quote: 'backtick',
    backslashEscape: true,
    experimental: true,
    note: 'OLAP 引擎：表数据网格为只读，且不提供可视化表设计器（建表需声明分桶与表属性）。'
      + '改数据与建表请在查询编辑器中直接写 SQL。',
    caps: { processes: true, manageDatabase: true, transactions: false, schemas: false, designer: false, merge: false },
  },
  kingbase: {
    label: '人大金仓 KingbaseES',
    shortLabel: 'KingbaseES',
    icon: 'kingbase',
    dialect: 'postgres',
    cmMode: 'text/x-pgsql',
    formatLang: 'postgresql',
    // KingbaseES 默认端口 54321、超级用户 system、默认库 test，与原生 PostgreSQL 不同
    defaults: { port: 54321, user: 'system', database: 'test' },
    quote: 'double',
    backslashEscape: false,
    experimental: true,
    note: '默认端口 54321、超级用户 system、默认库 test，与原生 PostgreSQL 不同。'
      + '若实例配置为国密 sm3 认证，标准驱动无法握手，需在服务端改用 md5 或 scram-sha-256。',
    caps: { processes: true, manageDatabase: true, transactions: true, schemas: true, designer: true, merge: true },
  },
  opengauss: {
    label: 'openGauss / GaussDB',
    shortLabel: 'openGauss',
    icon: 'opengauss',
    dialect: 'postgres',
    cmMode: 'text/x-pgsql',
    formatLang: 'postgresql',
    defaults: { port: 5432, user: 'gaussdb', database: 'postgres' },
    quote: 'double',
    backslashEscape: false,
    experimental: true,
    note: '⚠ openGauss 默认的自研 SHA256 认证，标准 PostgreSQL 驱动无法握手。'
      + '需先在服务端把 password_encryption_type 改为 1、pg_hba.conf 改用 md5，'
      + '并重设一次用户密码（只改参数不会重算已有口令）。',
    caps: { processes: true, manageDatabase: true, transactions: true, schemas: true, designer: true, merge: true },
  },
  greenplum: {
    label: 'Greenplum',
    icon: 'greenplum',
    dialect: 'postgres',
    cmMode: 'text/x-pgsql',
    formatLang: 'postgresql',
    defaults: { port: 5432, user: 'gpadmin', database: 'postgres' },
    quote: 'double',
    backslashEscape: false,
    experimental: true,
    note: '建表可以不写 DISTRIBUTED BY，Greenplum 会自行选择分布键；'
      + '对性能敏感的表建议在查询编辑器中显式指定。',
    caps: { processes: true, manageDatabase: true, transactions: true, schemas: true, designer: true, merge: true },
  },
};

/** 新建连接菜单与连接对话框的类型顺序 */
export const TYPE_ORDER = [
  'mysql', 'postgres', 'sqlite', 'mssql', 'clickhouse',
  'tidb', 'polardb', 'starrocks', 'doris',
  'kingbase', 'opengauss', 'greenplum',
  'oceanbase', 'oboracle',
];

const FALLBACK = DB_TYPES.mysql;

/** 取类型定义；未知类型回落到 MySQL，保证界面不会因为脏配置整块崩掉 */
export function typeInfo(type) {
  return DB_TYPES[type] || FALLBACK;
}

export function typeLabel(type) {
  const t = DB_TYPES[type];
  return t ? t.label : (type || '');
}

/** 树上等窄处使用的短名（没有单独定义时就用全名） */
export function typeShortLabel(type) {
  const t = DB_TYPES[type];
  return t ? (t.shortLabel || t.label) : (type || '');
}

export function typeIcon(type) {
  const t = DB_TYPES[type];
  return t ? t.icon : 'connection';
}

/** 归一后的方言：oceanbase→mysql、oboracle→oracle，模板与语句拆分都按这个走 */
export function dialectOf(type) {
  return typeInfo(type).dialect;
}

export function cmModeOf(type) {
  return typeInfo(type).cmMode;
}

export function formatLangOf(type) {
  return typeInfo(type).formatLang;
}

export function defaultsOf(type) {
  return typeInfo(type).defaults || {};
}

/** 该类型是否为实验性（未经真机端到端验证，或官方不承诺兼容） */
export function isExperimental(type) {
  return !!typeInfo(type).experimental;
}

/** 该类型的连接提示，没有则返回空串 */
export function typeNote(type) {
  return typeInfo(type).note || '';
}

/** 静态能力位，未知能力名一律按不支持处理 */
export function hasCap(type, cap) {
  return !!(typeInfo(type).caps || {})[cap];
}

/** 该类型是否为单文件数据库（连接对话框据此改为选文件） */
export function isFileBased(type) {
  return !!typeInfo(type).fileBased;
}

/** 没有「数据库」层级的类型返回其固定库名（SQLite 为 main），否则返回 null */
export function fixedDatabaseOf(type) {
  return typeInfo(type).fixedDatabase || null;
}

/** 按类型的标识符引用函数 */
export function quoteIdentOf(type) {
  return QUOTE[typeInfo(type).quote] || QUOTE.double;
}

/** 按类型的字符串字面量转义（反斜杠转义仅 MySQL 系需要） */
export function quoteLiteralOf(type) {
  const backslash = typeInfo(type).backslashEscape;
  return (v) => {
    let s = String(v).replace(/'/g, "''");
    if (backslash) s = s.replace(/\\/g, '\\\\');
    return "'" + s + "'";
  };
}
