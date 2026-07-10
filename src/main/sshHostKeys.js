// Persistent SSH host-key verification (TOFU with explicit native approval).
// ssh2 invokes hostVerifier after key exchange and before user authentication,
// so neither passwords nor private-key authentication are sent until this check passes.
const { app, dialog } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { domainToASCII } = require('url');

const verificationQueues = new Map();
let getWindow = () => null;

function configure(options = {}) {
  getWindow = typeof options.getWindow === 'function' ? options.getWindow : () => null;
}

function knownHostsPath() {
  return path.join(app.getPath('userData'), 'ssh-known-hosts.json');
}

function normalizeHost(value) {
  let host = String(value || '').trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.$/, '').toLowerCase();
  if (!host || /[\x00-\x20\x7f]/.test(host)) throw new Error('SSH 主机名无效');
  return domainToASCII(host) || host;
}

function normalizePort(value) {
  const port = Number(value) || 22;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口无效');
  return port;
}

function endpointId(host, port) {
  return `${normalizeHost(host)}\u0000${normalizePort(port)}`;
}

function endpointLabel(host, port) {
  const normalized = normalizeHost(host);
  const shown = normalized.includes(':') ? `[${normalized}]` : normalized;
  return `${shown}:${normalizePort(port)}`;
}

function keyAlgorithm(rawKey) {
  if (!Buffer.isBuffer(rawKey) || rawKey.length < 4) return 'unknown';
  const length = rawKey.readUInt32BE(0);
  if (length < 1 || length > 256 || length + 4 > rawKey.length) return 'unknown';
  const algorithm = rawKey.subarray(4, 4 + length).toString('utf8');
  return /^[\x21-\x7e]+$/.test(algorithm) ? algorithm : 'unknown';
}

function fingerprintKey(rawKey) {
  if (!Buffer.isBuffer(rawKey) || rawKey.length === 0) throw new Error('SSH 服务器返回了无效的主机密钥');
  return {
    algorithm: keyAlgorithm(rawKey),
    fingerprint: `SHA256:${crypto.createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')}`,
  };
}

function loadKnownHosts() {
  try {
    const parsed = JSON.parse(fs.readFileSync(knownHostsPath(), 'utf8'));
    if (!parsed || !Array.isArray(parsed.hosts)) return [];
    return parsed.hosts.filter((item) => {
      if (!item || typeof item.host !== 'string' || !Number.isSafeInteger(item.port)
          || item.port < 1 || item.port > 65535 || typeof item.fingerprint !== 'string') return false;
      try { endpointId(item.host, item.port); return true; } catch (e) { return false; }
    });
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    // A damaged file must never silently auto-accept a key. It is treated as an
    // empty trust store, which forces native first-use confirmation again.
    return [];
  }
}

function persistKnownHosts(hosts) {
  const target = knownHostsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ version: 1, hosts }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (e) {
    try { fs.unlinkSync(temp); } catch (ignore) { /* ignore */ }
    throw new Error(`无法保存 SSH 主机密钥: ${(e && e.message) || e}`);
  }
}

function getKnownHost(host, port) {
  const id = endpointId(host, port);
  return loadKnownHosts().find((item) => endpointId(item.host, item.port) === id) || null;
}

function assessHostKey(known, incoming) {
  if (!known) return 'new';
  return known.fingerprint === incoming.fingerprint ? 'trusted' : 'changed';
}

function rememberHost(host, port, incoming) {
  const normalizedHost = normalizeHost(host);
  const normalizedPort = normalizePort(port);
  const id = endpointId(normalizedHost, normalizedPort);
  const hosts = loadKnownHosts();
  const index = hosts.findIndex((item) => endpointId(item.host, item.port) === id);
  const now = new Date().toISOString();
  const previous = index >= 0 ? hosts[index] : null;
  const record = {
    host: normalizedHost,
    port: normalizedPort,
    algorithm: incoming.algorithm,
    fingerprint: incoming.fingerprint,
    firstSeenAt: previous && previous.firstSeenAt ? previous.firstSeenAt : now,
    updatedAt: now,
  };
  if (index >= 0) hosts[index] = record;
  else hosts.push(record);
  persistKnownHosts(hosts);
  return record;
}

async function nativeConfirmation(details) {
  const changed = details.status === 'changed';
  const endpoint = endpointLabel(details.host, details.port);
  const options = {
    type: 'warning',
    title: changed ? 'SSH 主机密钥已变更' : '确认 SSH 主机身份',
    message: changed
      ? `警告：${endpoint} 的 SSH 主机密钥已变更`
      : `首次连接 SSH 主机 ${endpoint}`,
    detail: changed
      ? `这可能表示服务器重装或遭遇中间人攻击。请先通过可信渠道核对新指纹。\n\n旧指纹：${details.known.fingerprint}\n新密钥：${details.incoming.algorithm}\n新指纹：${details.incoming.fingerprint}\n\n确认前不会发送 SSH 密码或私钥认证。`
      : `请通过可信渠道向服务器管理员核对以下指纹。\n\n密钥类型：${details.incoming.algorithm}\n指纹：${details.incoming.fingerprint}\n\n确认前不会发送 SSH 密码或私钥认证。`,
    buttons: changed ? ['拒绝连接', '已核验，更新并连接'] : ['取消（安全）', '信任并连接'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const parent = getWindow();
  const result = parent && !parent.isDestroyed()
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

async function verifyOne(host, port, rawKey, options) {
  const incoming = fingerprintKey(rawKey);
  const known = getKnownHost(host, port);
  const status = assessHostKey(known, incoming);
  if (status === 'trusted') return { accepted: true, status, incoming, known };

  const confirm = options && typeof options.confirm === 'function'
    ? options.confirm
    : nativeConfirmation;
  const accepted = !!(await confirm({ host: normalizeHost(host), port: normalizePort(port), status, incoming, known }));
  if (!accepted) return { accepted: false, status, incoming, known };
  const saved = rememberHost(host, port, incoming);
  return { accepted: true, status, incoming, known: saved };
}

function verifyHostKey(host, port, rawKey, options = {}) {
  const id = endpointId(host, port);
  const previous = verificationQueues.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => verifyOne(host, port, rawKey, options));
  verificationQueues.set(id, current);
  return current.finally(() => {
    if (verificationQueues.get(id) === current) verificationQueues.delete(id);
  });
}

module.exports = {
  configure,
  verifyHostKey,
  fingerprintKey,
  assessHostKey,
  getKnownHost,
  normalizeHost,
  endpointId,
};
