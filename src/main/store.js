// 连接配置持久化：%APPDATA%/DBPanda/connections.json
// 密码用 Electron safeStorage 加密。仍可读取旧版 b64 记录，但新凭据绝不再退化为可逆 Base64。
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Database passwords that the user explicitly chose not to persist. A value is
// held only until its connection opens; the adapter owns it until that connection
// closes. It is never written to disk.
const sessionPasswords = new Map();

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
  const out = { ...c, password: connectionPassword(c, strict) };
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

function connectionPassword(record, strict = false) {
  if (record && record.savePassword === false) {
    const entry = validSessionPassword(record);
    return entry ? entry.password : '';
  }
  return decryptPassword(record && record.password, strict);
}

function hasDbCredential(record) {
  return !!record && (hasSecret(record.password) || !!validSessionPassword(record));
}

function keepEncrypted(p) {
  // 旧版本的 Base64 记录在用户下一次保存配置时自动迁移到 safeStorage。
  if (p && p.enc === 'b64') return encryptPassword(decryptPassword(p));
  return p || encryptPassword('');
}

/** 给 Renderer 的连接列表：只暴露“是否已保存”，不回传任何已解密凭据。 */
function listPublic() {
  return loadRaw().map((c) => {
    const out = {
      ...c,
      hasPassword: c.savePassword !== false && hasSecret(c.password),
      savePassword: c.type !== 'sqlite' && c.savePassword !== false,
      hasSessionPassword: c.savePassword === false && !!validSessionPassword(c),
    };
    delete out.password;
    if (c.type === 'sqlite') {
      delete out.savePassword;
      delete out.hasSessionPassword;
    }
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

function needsSessionPassword(id) {
  const raw = loadRaw().find((item) => item.id === id);
  return !!(raw && raw.type !== 'sqlite' && raw.savePassword === false && !validSessionPassword(raw));
}

function setSessionPassword(id, password) {
  const raw = loadRaw().find((item) => item.id === id);
  if (!raw) throw new Error('连接配置不存在');
  if (raw.type === 'sqlite' || raw.savePassword !== false) throw new Error('该连接不需要会话密码');
  cacheSessionPassword(raw, password);
}

function clearSessionPassword(id) {
  sessionPasswords.delete(id);
}

function clearSessionPasswords() {
  sessionPasswords.clear();
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

function sessionScope(record) {
  return {
    type: record && record.type,
    host: record && record.host,
    port: record && record.port,
    user: record && record.user,
    options: { ...((record && record.options) || {}) },
    ssh: record && record.ssh ? {
      enabled: !!record.ssh.enabled,
      host: record.ssh.host,
      port: record.ssh.port,
      user: record.ssh.user,
      authType: record.ssh.authType,
      keyFile: record.ssh.keyFile,
    } : null,
  };
}

function validSessionPassword(record) {
  if (!record || !record.id) return null;
  const entry = sessionPasswords.get(record.id);
  if (!entry) return null;
  if (!sameDbCredentialScope(entry.scope, record)) {
    sessionPasswords.delete(record.id);
    return null;
  }
  return entry;
}

function cacheSessionPassword(record, password) {
  sessionPasswords.set(record.id, {
    password: String(password === undefined || password === null ? '' : password),
    scope: sessionScope(record),
  });
}

/**
 * 把 Renderer 提交的脱敏配置与已保存密钥合并，供测试连接使用。
 * 属性缺失表示“保留旧密钥”；显式空字符串表示“清除/使用空密钥”。
 */
function hydrateConfig(conn) {
  if (!conn || !conn.id) return conn;
  const raw = loadRaw().find((item) => item.id === conn.id);
  if (!raw) return conn;
  // Only decrypt secrets that the Renderer omitted and therefore intends to reuse.
  // An explicitly supplied replacement must be allowed to overwrite a damaged old
  // safeStorage payload without trying to decrypt that payload first.
  const incomingSsh = conn.ssh || {};
  const old = {
    ...raw,
    password: own(conn, 'password') ? '' : connectionPassword(raw, true),
  };
  if (raw.ssh) {
    old.ssh = {
      ...raw.ssh,
      password: own(incomingSsh, 'password') ? '' : decryptPassword(raw.ssh.password, true),
      passphrase: own(incomingSsh, 'passphrase') ? '' : decryptPassword(raw.ssh.passphrase, true),
    };
  }
  const out = { ...old, ...conn };
  if (conn.type === 'sqlite') {
    out.password = '';
    delete out.ssh;
    delete out.hasPassword;
    delete out.hasSessionPassword;
    delete out.savePassword;
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
  delete out.hasSessionPassword;
  if (out.ssh) { delete out.ssh.hasPassword; delete out.ssh.hasPassphrase; }
  return out;
}

function save(conn) {
  const arr = loadRaw();
  const i = conn.id ? arr.findIndex((x) => x.id === conn.id) : -1;
  const previous = i >= 0 ? arr[i] : null;
  if (previous && conn.type !== 'sqlite' && !own(conn, 'password')
      && hasDbCredential(previous) && !sameDbCredentialScope(previous, conn)) {
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
  const id = conn.id || crypto.randomUUID();
  const savePassword = conn.type !== 'sqlite' && conn.savePassword !== false;
  const previousSession = previous && validSessionPassword(previous);
  let encryptedDbPassword = encryptPassword('');
  let nextSessionPassword;
  let hasNextSessionPassword = false;
  if (conn.type !== 'sqlite' && savePassword) {
    if (own(conn, 'password')) encryptedDbPassword = encryptPassword(conn.password || '');
    else if (previous && previous.savePassword === false && previousSession) {
      encryptedDbPassword = encryptPassword(previousSession.password);
    } else if (previous && previous.savePassword === false) {
      throw new Error('请重新输入需要保存到本地的数据库密码');
    } else encryptedDbPassword = keepEncrypted(previous && previous.password);
  } else if (conn.type !== 'sqlite') {
    if (own(conn, 'password')) {
      nextSessionPassword = String(conn.password === undefined || conn.password === null ? '' : conn.password);
      hasNextSessionPassword = true;
    } else if (previous && previous.savePassword === false && previousSession) {
      nextSessionPassword = previousSession.password;
      hasNextSessionPassword = true;
    } else if (previous && previous.savePassword !== false) {
      nextSessionPassword = decryptPassword(previous.password, true);
      hasNextSessionPassword = true;
    }
  }
  const record = { ...conn, id, savePassword, password: encryptedDbPassword };
  if (!conn.id) record.createdAt = new Date().toISOString();
  if (conn.type === 'sqlite') delete record.savePassword;
  // Approval capabilities are single-use IPC data and must never reach disk.
  delete record.approvalToken;
  delete record._approvalToken;
  delete record.hasPassword;
  delete record.hasSessionPassword;
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
  if (!conn.id) {
    arr.push(record);
  } else {
    if (i >= 0) {
      arr[i] = { ...arr[i], ...record };
      if (conn.type === 'sqlite') delete arr[i].ssh;
    }
    else arr.push(record);
  }
  persist(arr);
  sessionPasswords.delete(record.id);
  if (!savePassword && hasNextSessionPassword) cacheSessionPassword(record, nextSessionPassword);
  return listPublic().find((x) => x.id === record.id);
}

const IMPORT_TYPES = new Set(['mysql', 'postgres', 'mssql', 'sqlite', 'clickhouse', 'oceanbase', 'oboracle']);

function importString(value, max = 512) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function importSecret(value, max = 4096) {
  return String(value === undefined || value === null ? '' : value).slice(0, max);
}

function normalizeImportedConnection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('NCX 连接配置无效');
  const type = importString(input.type, 32).toLowerCase();
  if (!IMPORT_TYPES.has(type)) throw new Error(`不支持导入数据库类型：${type || '未知'}`);
  const name = importString(input.name, 128);
  if (!name) throw new Error('NCX 连接名称不能为空');
  const common = {
    type,
    name,
    group: importString(input.group, 128),
    env: ['prod', 'test', 'dev'].includes(input.env) ? input.env : '',
    color: importString(input.color, 32),
    password: encryptPassword(type === 'sqlite' ? '' : importSecret(input.password)),
  };
  if (type === 'sqlite') {
    return { ...common, file: importString(input.file, 2048) };
  }
  const numberPort = Number(input.port);
  const record = {
    ...common,
    host: importString(input.host),
    port: Number.isSafeInteger(numberPort) && numberPort > 0 && numberPort <= 65535 ? numberPort : undefined,
    user: importString(input.user),
    database: importString(input.database),
    options: {},
  };
  if (type === 'mssql') {
    record.options = { encrypt: !!(input.options && input.options.encrypt), trustCert: !(input.options && input.options.trustCert === false) };
  } else if (type === 'clickhouse') {
    record.options = { https: !!(input.options && input.options.https) };
  }
  if (input.ssh && input.ssh.enabled) {
    const sshPort = Number(input.ssh.port);
    record.ssh = {
      enabled: true,
      host: importString(input.ssh.host),
      port: Number.isSafeInteger(sshPort) && sshPort > 0 && sshPort <= 65535 ? sshPort : 22,
      user: importString(input.ssh.user),
      authType: input.ssh.authType === 'key' ? 'key' : 'password',
      keyFile: importString(input.ssh.keyFile, 2048),
      password: encryptPassword(importSecret(input.ssh.password)),
      passphrase: encryptPassword(importSecret(input.ssh.passphrase)),
    };
  }
  return record;
}

function importedSignature(connection) {
  const normalizedPath = (value) => {
    const result = normExact(value);
    return process.platform === 'win32' ? result.toLowerCase() : result;
  };
  let options = {};
  if (normFold(connection.type) === 'mssql') {
    options = {
      encrypt: !!(connection.options && connection.options.encrypt),
      trustCert: !(connection.options && connection.options.trustCert === false),
    };
  } else if (normFold(connection.type) === 'clickhouse') {
    options = { https: !!(connection.options && connection.options.https) };
  }
  const ssh = connection.ssh && connection.ssh.enabled ? {
    host: normFold(connection.ssh.host),
    port: Number(connection.ssh.port) || 22,
    user: normExact(connection.ssh.user),
    authType: connection.ssh.authType || 'password',
    keyFile: normalizedPath(connection.ssh.keyFile),
  } : null;
  return JSON.stringify({
    name: normFold(connection.name),
    type: normFold(connection.type),
    host: normFold(connection.host),
    port: Number(connection.port) || null,
    user: normExact(connection.user),
    database: normExact(connection.database),
    file: normalizedPath(connection.file),
    options,
    ssh,
  });
}

function publicRecord(record) {
  const out = {
    ...record,
    hasPassword: record.savePassword !== false && hasSecret(record.password),
    savePassword: record.type !== 'sqlite' && record.savePassword !== false,
    hasSessionPassword: record.savePassword === false && !!validSessionPassword(record),
  };
  delete out.password;
  if (record.type === 'sqlite') {
    delete out.savePassword;
    delete out.hasSessionPassword;
  }
  if (record.ssh) {
    out.ssh = {
      ...record.ssh,
      hasPassword: hasSecret(record.ssh.password),
      hasPassphrase: hasSecret(record.ssh.passphrase),
    };
    delete out.ssh.password;
    delete out.ssh.passphrase;
  }
  return out;
}

function needsCredentialUpdate(existing, candidate) {
  if (existing.savePassword !== false && hasSecret(candidate.password) && !hasSecret(existing.password)) return true;
  if (!candidate.ssh || !existing.ssh) return false;
  return (hasSecret(candidate.ssh.password) && !hasSecret(existing.ssh.password))
    || (hasSecret(candidate.ssh.passphrase) && !hasSecret(existing.ssh.passphrase));
}

function fillMissingCredentials(existing, candidate) {
  let changed = false;
  if (existing.savePassword !== false && hasSecret(candidate.password) && !hasSecret(existing.password)) {
    existing.password = candidate.password;
    changed = true;
  }
  if (candidate.ssh && existing.ssh) {
    if (hasSecret(candidate.ssh.password) && !hasSecret(existing.ssh.password)) {
      existing.ssh.password = candidate.ssh.password;
      changed = true;
    }
    if (hasSecret(candidate.ssh.passphrase) && !hasSecret(existing.ssh.passphrase)) {
      existing.ssh.passphrase = candidate.ssh.passphrase;
      changed = true;
    }
  }
  return changed;
}

function importConnections(configs) {
  if (!Array.isArray(configs) || !configs.length) return {
    imported: 0, updated: 0, skipped: 0, renamed: 0, connections: [],
  };
  if (configs.length > 1000) throw new Error('单次最多导入 1000 个连接');
  const normalized = configs.map(normalizeImportedConnection);
  const records = loadRaw();
  const recordsBySignature = new Map(records.map((record) => [importedSignature(record), record]));
  const names = new Set(records.map((item) => normFold(item.name)));
  const created = [];
  const updated = [];
  let skipped = 0;
  let renamed = 0;
  for (const candidate of normalized) {
    const signature = importedSignature(candidate);
    const existing = recordsBySignature.get(signature);
    if (existing) {
      if (fillMissingCredentials(existing, candidate)) updated.push(existing);
      else skipped += 1;
      continue;
    }
    if (names.has(normFold(candidate.name))) {
      const original = candidate.name;
      let sequence = 1;
      let nextName = `${original} (Navicat)`;
      while (names.has(normFold(nextName))) {
        sequence += 1;
        nextName = `${original} (Navicat ${sequence})`;
      }
      candidate.name = nextName;
      renamed += 1;
    }
    candidate.id = crypto.randomUUID();
    candidate.createdAt = new Date().toISOString();
    records.push(candidate);
    created.push(candidate);
    recordsBySignature.set(signature, candidate);
    recordsBySignature.set(importedSignature(candidate), candidate);
    names.add(normFold(candidate.name));
  }
  if (created.length || updated.length) persist(records);
  return {
    imported: created.length,
    updated: updated.length,
    skipped,
    renamed,
    connections: [...created, ...updated].map(publicRecord),
  };
}

function previewImportConnections(configs) {
  if (!Array.isArray(configs)) throw new Error('NCX 连接列表无效');
  if (configs.length > 1000) throw new Error('单次最多预览 1000 个连接');
  const records = loadRaw();
  const recordsBySignature = new Map(records.map((record) => [importedSignature(record), record]));
  return configs.map((config) => {
    const candidate = normalizeImportedConnection(config);
    const existing = recordsBySignature.get(importedSignature(candidate));
    const credentialUpdate = !!(existing && needsCredentialUpdate(existing, candidate));
    return { duplicate: !!existing && !credentialUpdate, credentialUpdate };
  });
}

function remove(id) {
  persist(loadRaw().filter((x) => x.id !== id));
  sessionPasswords.delete(id);
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
  list, listPublic, getById, hydrateConfig, save, importConnections, previewImportConnections,
  needsSessionPassword, setSessionPassword, clearSessionPassword, clearSessionPasswords,
  remove, listGroups, addGroup, renameGroup, removeGroup,
  getAiConfig, getAiConfigPublic, hydrateAiConfig, saveAiConfig, normalizeAiBaseUrl,
};
