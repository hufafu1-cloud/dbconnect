// 连接管理器：按连接 ID 维护已打开的适配器实例
const { MySQLAdapter } = require('./mysql');
const { PostgresAdapter } = require('./postgres');
const { SQLiteAdapter } = require('./sqlite');
const { MSSQLAdapter } = require('./mssql');
const { ClickHouseAdapter } = require('./clickhouse');
const { OceanBaseAdapter } = require('./oceanbase');
const { OBOracleAdapter } = require('./oboracle');

const ADAPTERS = {
  mysql: MySQLAdapter,
  postgres: PostgresAdapter,
  sqlite: SQLiteAdapter,
  mssql: MSSQLAdapter,
  clickhouse: ClickHouseAdapter,
  oceanbase: OceanBaseAdapter,
  oboracle: OBOracleAdapter,
};

const openMap = new Map(); // connId -> adapter
const tunnels = new Map(); // connId -> ssh tunnel

const DEFAULT_PORTS = { mysql: 3306, postgres: 5432, mssql: 1433, clickhouse: 8123, oceanbase: 2881, oboracle: 2881 };

function createAdapter(cfg) {
  const Cls = ADAPTERS[cfg.type];
  if (!Cls) throw new Error('不支持的数据库类型: ' + cfg.type);
  return new Cls(cfg);
}

/** 需要 SSH 隧道时先建隧道，返回 {effective(改写了 host/port 的配置), tunnel|null} */
async function prepare(cfg) {
  if (cfg.ssh && cfg.ssh.enabled && cfg.type !== 'sqlite') {
    const { openTunnel } = require('../tunnel');
    const dstPort = Number(cfg.port) || DEFAULT_PORTS[cfg.type] || 3306;
    const tun = await openTunnel(cfg.ssh, cfg.host || 'localhost', dstPort);
    return { effective: { ...cfg, host: '127.0.0.1', port: tun.localPort }, tunnel: tun };
  }
  return { effective: cfg, tunnel: null };
}

async function open(cfg) {
  if (openMap.has(cfg.id)) {
    return { version: openMap.get(cfg.id).serverVersion };
  }
  const { effective, tunnel } = await prepare(cfg);
  const ad = createAdapter(effective);
  try {
    await ad.connect();
  } catch (e) {
    if (tunnel) tunnel.close();
    throw e;
  }
  openMap.set(cfg.id, ad);
  if (tunnel) tunnels.set(cfg.id, tunnel);
  return { version: ad.serverVersion };
}

function get(connId) {
  const ad = openMap.get(connId);
  if (!ad) throw new Error('连接未打开或已断开');
  return ad;
}

function isOpen(connId) { return openMap.has(connId); }

async function close(connId) {
  const ad = openMap.get(connId);
  if (ad) {
    openMap.delete(connId);
    await ad.close().catch(() => {});
  }
  const tun = tunnels.get(connId);
  if (tun) {
    tunnels.delete(connId);
    tun.close();
  }
}

async function closeAll() {
  const all = [...openMap.values()];
  openMap.clear();
  await Promise.all(all.map((a) => a.close().catch(() => {})));
  for (const t of tunnels.values()) t.close();
  tunnels.clear();
}

async function testConnection(cfg) {
  const t0 = Date.now();
  const { effective, tunnel } = await prepare(cfg);
  const ad = createAdapter(effective);
  try {
    await ad.connect();
    const version = ad.serverVersion;
    return { version, ms: Date.now() - t0, viaTunnel: !!tunnel };
  } finally {
    await ad.close().catch(() => {});
    if (tunnel) tunnel.close();
  }
}

module.exports = { open, get, isOpen, close, closeAll, testConnection, createAdapter };
