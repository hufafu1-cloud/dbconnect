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

const SHUTDOWN_TIMEOUTS = Object.freeze({ cancelMs: 750, transactionsMs: 2000, closeMs: 2000 });

async function settleWithin(task, timeoutMs) {
  let timer = null;
  const work = Promise.resolve().then(task).then(() => true, () => true);
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs) || 1));
  });
  const settled = await Promise.race([work, timeout]);
  if (timer) clearTimeout(timer);
  return settled;
}

async function settleSuccessfulWithin(task, timeoutMs) {
  let timer = null;
  const work = Promise.resolve().then(task).then(() => true, () => false);
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs) || 1));
  });
  const settled = await Promise.race([work, timeout]);
  if (timer) clearTimeout(timer);
  return settled;
}

/** Cancel first, then roll back, while keeping connection shutdown bounded. */
async function shutdownAdapter(ad, timeouts = SHUTDOWN_TIMEOUTS) {
  if (!ad) return;
  if (typeof ad.cancel === 'function') {
    await settleWithin(() => ad.cancel(null), timeouts.cancelMs);
  }
  if (typeof ad.closeTransactions === 'function') {
    await settleWithin(() => ad.closeTransactions(), timeouts.transactionsMs);
  }
  if (typeof ad.close === 'function') {
    await settleWithin(() => ad.close(), timeouts.closeMs);
  }
}

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

function activity(connId) {
  const ad = openMap.get(connId);
  if (!ad) return { open: false, requests: 0, transactions: 0 };
  const summary = typeof ad.connectionActivity === 'function' ? ad.connectionActivity() : {};
  return {
    open: true,
    requests: Math.max(0, Number(summary.requests) || 0),
    transactions: Math.max(0, Number(summary.transactions) || 0),
  };
}

async function close(connId) {
  const ad = openMap.get(connId);
  if (ad) {
    openMap.delete(connId);
    await shutdownAdapter(ad);
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
  await Promise.all(all.map(async (a) => {
    await shutdownAdapter(a);
  }));
  for (const t of tunnels.values()) t.close();
  tunnels.clear();
}

async function closeTransactionsByOwner(ownerId) {
  const numericOwner = Number(ownerId);
  if (!Number.isSafeInteger(numericOwner) || numericOwner < 0) return;
  const prefix = `wc-${numericOwner}:`;
  const entries = [...openMap.entries()];
  await Promise.all(entries.map(async ([connId, ad]) => {
    if (!ad) return;
    const requestsSettled = typeof ad.cancelRequestsByPrefix !== 'function'
      || await settleSuccessfulWithin(() => ad.cancelRequestsByPrefix(prefix), SHUTDOWN_TIMEOUTS.cancelMs);
    const transactionsSettled = typeof ad.closeTransactionsByPrefix !== 'function'
      || await settleSuccessfulWithin(() => ad.closeTransactionsByPrefix(prefix), SHUTDOWN_TIMEOUTS.transactionsMs);
    // Never leave an ownerless transaction pinned indefinitely. If targeted
    // request/transaction cleanup cannot finish, retire that connection entirely.
    if ((!requestsSettled || !transactionsSettled) && openMap.get(connId) === ad) await close(connId);
  }));
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

module.exports = {
  open, get, isOpen, activity, close, closeAll, closeTransactionsByOwner,
  testConnection, createAdapter, shutdownAdapter,
};
