// 连接配置持久化：%APPDATA%/Datavia/connections.json
// 密码用 Electron safeStorage 加密。仍可读取旧版 b64 记录，但新凭据绝不再退化为可逆 Base64。
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function filePath() {
  return path.join(app.getPath('userData'), 'connections.json');
}

function encryptPassword(pw) {
  if (!pw) return { enc: 'none', v: '' };
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { enc: 'safe', v: safeStorage.encryptString(pw).toString('base64') };
    }
  } catch (e) {
    throw new Error('系统安全存储不可用，无法安全保存凭据: ' + ((e && e.message) || e));
  }
  throw new Error('系统安全存储不可用，无法安全保存凭据');
}

function decryptPassword(p, strict = false) {
  if (!p || typeof p === 'string') return p || '';
  if (p.enc === 'none') return '';
  try {
    if (p.enc === 'safe') return safeStorage.decryptString(Buffer.from(p.v, 'base64'));
    if (p.enc === 'b64') return Buffer.from(p.v, 'base64').toString('utf8');
  } catch (e) {
    if (strict) throw new Error('已保存凭据无法解密，请重新输入后保存');
    return '';
  }
  if (strict) throw new Error('已保存凭据格式不受支持，请重新输入后保存');
  return '';
}

function loadRaw() {
  try {
    const txt = fs.readFileSync(filePath(), 'utf8');
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function persist(arr) {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(arr, null, 2), 'utf8');
}

/** 列出全部连接（含解密凭据；仅供主进程内部连接与测试使用） */
function list() {
  return loadRaw().map((c) => decryptConnection(c, false));
}

function decryptConnection(c, strict) {
  const out = { ...c, password: decryptPassword(c.password, strict) };
  if (c.ssh) {
    out.ssh = {
      ...c.ssh,
      password: decryptPassword(c.ssh.password, strict),
      passphrase: decryptPassword(c.ssh.passphrase, strict),
    };
  }
  return out;
}

function hasSecret(p) {
  if (!p) return false;
  if (typeof p === 'string') return !!p;
  return p.enc !== 'none' && !!p.v;
}

function keepEncrypted(p) {
  // 旧版本的 Base64 记录在用户下一次保存配置时自动迁移到 safeStorage。
  if (p && p.enc === 'b64') return encryptPassword(decryptPassword(p));
  return p || encryptPassword('');
}

/** 给 Renderer 的连接列表：只暴露“是否已保存”，不回传任何已解密凭据。 */
function listPublic() {
  return loadRaw().map((c) => {
    const out = { ...c, hasPassword: hasSecret(c.password) };
    delete out.password;
    if (c.ssh) {
      out.ssh = {
        ...c.ssh,
        hasPassword: hasSecret(c.ssh.password),
        hasPassphrase: hasSecret(c.ssh.passphrase),
      };
      delete out.ssh.password;
      delete out.ssh.passphrase;
    }
    return out;
  });
}

function getById(id) {
  const raw = loadRaw().find((x) => x.id === id);
  const c = raw ? decryptConnection(raw, true) : null;
  if (!c) throw new Error('连接配置不存在');
  return c;
}

const own = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);
const normFold = (v) => String(v === undefined || v === null ? '' : v).trim().toLowerCase();
const normExact = (v) => String(v === undefined || v === null ? '' : v).trim();
const effective = (old, incoming, key) => own(incoming, key) ? incoming[key] : old[key];

function sameDbCredentialScope(old, incoming) {
  if (normFold(old.type) !== normFold(effective(old, incoming, 'type'))
      || normFold(old.host) !== normFold(effective(old, incoming, 'host'))
      || normExact(old.port) !== normExact(effective(old, incoming, 'port'))
      // Database and SSH usernames can be case-sensitive. Never reuse a secret
      // merely because the new identity differs only by letter case.
      || normExact(old.user) !== normExact(effective(old, incoming, 'user'))) return false;
  const oldHttps = !!(old.options && old.options.https);
  const nextOptions = own(incoming, 'options') ? incoming.options : old.options;
  if (oldHttps !== !!(nextOptions && nextOptions.https)) return false;
  if (normFold(old.type) === 'mssql') {
    const before = old.options || {};
    const after = nextOptions || {};
    if (!!before.encrypt !== !!after.encrypt
        || (before.trustCert !== false) !== (after.trustCert !== false)) return false;
  }
  const oldSsh = old.ssh || null;
  const nextSsh = own(incoming, 'ssh') ? incoming.ssh : oldSsh;
  const oldEnabled = !!(oldSsh && oldSsh.enabled);
  const nextEnabled = !!(nextSsh && nextSsh.enabled);
  if (oldEnabled !== nextEnabled) return false;
  return !oldEnabled || sameSshCredentialScope(oldSsh, nextSsh);
}

function sameSshCredentialScope(oldSsh, incomingSsh) {
  const old = oldSsh || {};
  const incoming = incomingSsh || {};
  return normFold(old.host) === normFold(effective(old, incoming, 'host'))
    && normExact(old.port) === normExact(effective(old, incoming, 'port'))
    && normExact(old.user) === normExact(effective(old, incoming, 'user'))
    && normFold(old.authType) === normFold(effective(old, incoming, 'authType'))
    && normExact(old.keyFile) === normExact(effective(old, incoming, 'keyFile'));
}

/**
 * 把 Renderer 提交的脱敏配置与已保存密钥合并，供测试连接使用。
 * 属性缺失表示“保留旧密钥”；显式空字符串表示“清除/使用空密钥”。
 */
function hydrateConfig(conn) {
  if (!conn || !conn.id) return conn;
  const exists = loadRaw().some((item) => item.id === conn.id);
  if (!exists) return conn;
  // If an existing secret can no longer be decrypted, surface that error. Treating
  // it as a missing connection would hide the problem and silently test blank creds.
  const old = getById(conn.id);
  const out = { ...old, ...conn };
  if (conn.type === 'sqlite') {
    out.password = '';
    delete out.ssh;
    delete out.hasPassword;
    return out;
  }
  if (!own(conn, 'password')) {
    if (old.password && !sameDbCredentialScope(old, conn)) {
      throw new Error('连接目标或用户名已改变，请重新输入数据库密码');
    }
    out.password = old.password || '';
  }
  if (old.ssh || conn.ssh) {
    const incoming = conn.ssh || {};
    out.ssh = { ...(old.ssh || {}), ...incoming };
    const scopeChanged = !sameSshCredentialScope(old.ssh, incoming);
    if (!own(incoming, 'password')) {
      if (old.ssh && old.ssh.password && scopeChanged) throw new Error('SSH 目标或用户名已改变，请重新输入 SSH 密码');
      out.ssh.password = (old.ssh && old.ssh.password) || '';
    }
    if (!own(incoming, 'passphrase')) {
      if (old.ssh && old.ssh.passphrase && scopeChanged) throw new Error('SSH 私钥配置已改变，请重新输入私钥口令');
      out.ssh.passphrase = (old.ssh && old.ssh.passphrase) || '';
    }
  }
  delete out.hasPassword;
  if (out.ssh) { delete out.ssh.hasPassword; delete out.ssh.hasPassphrase; }
  return out;
}

function save(conn) {
  const arr = loadRaw();
  const i = conn.id ? arr.findIndex((x) => x.id === conn.id) : -1;
  const previous = i >= 0 ? arr[i] : null;
  if (previous && conn.type !== 'sqlite' && !own(conn, 'password')
      && hasSecret(previous.password) && !sameDbCredentialScope(previous, conn)) {
    throw new Error('连接目标或用户名已改变，请重新输入数据库密码');
  }
  if (previous && previous.ssh && conn.ssh) {
    const sshScopeChanged = !sameSshCredentialScope(previous.ssh, conn.ssh);
    if (!own(conn.ssh, 'password') && hasSecret(previous.ssh.password) && sshScopeChanged) {
      throw new Error('SSH 目标或用户名已改变，请重新输入 SSH 密码');
    }
    if (!own(conn.ssh, 'passphrase') && hasSecret(previous.ssh.passphrase) && sshScopeChanged) {
      throw new Error('SSH 私钥配置已改变，请重新输入私钥口令');
    }
  }
  const record = {
    ...conn,
    password: conn.type === 'sqlite'
      ? encryptPassword('')
      : Object.prototype.hasOwnProperty.call(conn, 'password')
      ? encryptPassword(conn.password || '')
      : keepEncrypted(previous && previous.password),
  };
  // Approval capabilities are single-use IPC data and must never reach disk.
  delete record.approvalToken;
  delete record._approvalToken;
  delete record.hasPassword;
  if (conn.ssh) {
    record.ssh = {
      ...conn.ssh,
      password: Object.prototype.hasOwnProperty.call(conn.ssh, 'password')
        ? encryptPassword(conn.ssh.password || '')
        : keepEncrypted(previous && previous.ssh && previous.ssh.password),
      passphrase: Object.prototype.hasOwnProperty.call(conn.ssh, 'passphrase')
        ? encryptPassword(conn.ssh.passphrase || '')
        : keepEncrypted(previous && previous.ssh && previous.ssh.passphrase),
    };
    delete record.ssh.hasPassword;
    delete record.ssh.hasPassphrase;
  }
  if (!record.id) {
    record.id = crypto.randomUUID();
    record.createdAt = new Date().toISOString();
    arr.push(record);
  } else {
    if (i >= 0) {
      arr[i] = { ...arr[i], ...record };
      if (conn.type === 'sqlite') delete arr[i].ssh;
    }
    else arr.push(record);
  }
  persist(arr);
  return listPublic().find((x) => x.id === record.id);
}

function remove(id) {
  persist(loadRaw().filter((x) => x.id !== id));
}

// ---------------- 连接分组（支持空组持久化） ----------------
function groupsPath() {
  return path.join(app.getPath('userData'), 'groups.json');
}

function loadGroups() {
  try {
    const arr = JSON.parse(fs.readFileSync(groupsPath(), 'utf8'));
    return Array.isArray(arr) ? arr.filter((g) => typeof g === 'string' && g.trim()) : [];
  } catch (e) {
    return [];
  }
}

function persistGroups(arr) {
  fs.mkdirSync(path.dirname(groupsPath()), { recursive: true });
  fs.writeFileSync(groupsPath(), JSON.stringify([...new Set(arr)], null, 2), 'utf8');
}

/** 全部分组 = 声明的空组 ∪ 连接上使用的组 */
function listGroups() {
  const used = loadRaw().map((c) => c.group).filter((g) => g && g.trim());
  return [...new Set([...loadGroups(), ...used])].sort((a, b) => a.localeCompare(b));
}

function addGroup(name) {
  name = String(name || '').trim();
  if (!name) throw new Error('分组名不能为空');
  persistGroups([...loadGroups(), name]);
  return name;
}

function renameGroup(oldName, newName) {
  newName = String(newName || '').trim();
  if (!newName) throw new Error('分组名不能为空');
  persistGroups(loadGroups().map((g) => (g === oldName ? newName : g)));
  const arr = loadRaw();
  let touched = false;
  for (const c of arr) {
    if (c.group === oldName) { c.group = newName; touched = true; }
  }
  if (touched) persist(arr);
}

/** 删除分组：组内连接移到未分组 */
function removeGroup(name) {
  persistGroups(loadGroups().filter((g) => g !== name));
  const arr = loadRaw();
  let touched = false;
  for (const c of arr) {
    if (c.group === name) { delete c.group; touched = true; }
  }
  if (touched) persist(arr);
}

// ---------------- AI 助手配置（API Key 加密存储） ----------------
function aiPath() {
  return path.join(app.getPath('userData'), 'ai-config.json');
}

const AI_DEFAULT = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '', temperature: 0.2 };

function loadAiRaw() {
  try { return JSON.parse(fs.readFileSync(aiPath(), 'utf8')); } catch (e) { return null; }
}

function normalizeAiBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch (e) { throw new Error('AI 接口地址不是合法 URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('AI 接口地址仅支持 HTTP/HTTPS');
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.toString().replace(/\/+$/, '');
}

function getAiConfig() {
  const c = loadAiRaw();
  if (!c) return { ...AI_DEFAULT };
  return { ...AI_DEFAULT, ...c, apiKey: decryptPassword(c.apiKey, true) };
}

function getAiConfigPublic() {
  const raw = loadAiRaw();
  const out = { ...AI_DEFAULT, ...(raw || {}), hasApiKey: hasSecret(raw && raw.apiKey) };
  delete out.apiKey;
  return out;
}

function hydrateAiConfig(cfg) {
  const current = getAiConfig();
  const out = { ...current, ...(cfg || {}) };
  if (!cfg || !own(cfg, 'apiKey')) {
    if (current.apiKey && normalizeAiBaseUrl(current.baseUrl) !== normalizeAiBaseUrl(out.baseUrl)) {
      throw new Error('AI 接口地址已改变，请重新输入 API Key');
    }
    out.apiKey = current.apiKey || '';
  }
  out.baseUrl = normalizeAiBaseUrl(out.baseUrl);
  delete out.hasApiKey;
  return out;
}

function saveAiConfig(cfg) {
  fs.mkdirSync(path.dirname(aiPath()), { recursive: true });
  const previous = loadAiRaw();
  const baseUrl = normalizeAiBaseUrl(cfg.baseUrl);
  if (previous && !own(cfg, 'apiKey') && hasSecret(previous.apiKey)
      && normalizeAiBaseUrl(previous.baseUrl) !== baseUrl) {
    throw new Error('AI 接口地址已改变，请重新输入 API Key');
  }
  const rec = {
    provider: cfg.provider || 'custom',
    baseUrl,
    model: (cfg.model || '').trim(),
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.2,
    apiKey: Object.prototype.hasOwnProperty.call(cfg, 'apiKey')
      ? encryptPassword(cfg.apiKey || '')
      : keepEncrypted(previous && previous.apiKey),
  };
  fs.writeFileSync(aiPath(), JSON.stringify(rec, null, 2), 'utf8');
  return getAiConfigPublic();
}

module.exports = {
  list, listPublic, getById, hydrateConfig, save, remove, listGroups, addGroup, renameGroup, removeGroup,
  getAiConfig, getAiConfigPublic, hydrateAiConfig, saveAiConfig, normalizeAiBaseUrl,
};
