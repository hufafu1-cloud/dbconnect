// 连接配置持久化：%APPDATA%/DBConnect/connections.json
// 密码用 Electron safeStorage 加密（不可用时退化为 base64 并标记）
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
  } catch (e) { /* fallthrough */ }
  return { enc: 'b64', v: Buffer.from(pw, 'utf8').toString('base64') };
}

function decryptPassword(p) {
  if (!p || typeof p === 'string') return p || '';
  if (p.enc === 'none') return '';
  try {
    if (p.enc === 'safe') return safeStorage.decryptString(Buffer.from(p.v, 'base64'));
    if (p.enc === 'b64') return Buffer.from(p.v, 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
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

/** 列出全部连接（密码已解密，供编辑/连接使用；仅在本机进程间传输） */
function list() {
  return loadRaw().map((c) => {
    const out = { ...c, password: decryptPassword(c.password) };
    if (c.ssh) {
      out.ssh = { ...c.ssh, password: decryptPassword(c.ssh.password), passphrase: decryptPassword(c.ssh.passphrase) };
    }
    return out;
  });
}

function getById(id) {
  const c = list().find((x) => x.id === id);
  if (!c) throw new Error('连接配置不存在');
  return c;
}

function save(conn) {
  const arr = loadRaw();
  const record = { ...conn, password: encryptPassword(conn.password || '') };
  if (conn.ssh) {
    record.ssh = {
      ...conn.ssh,
      password: encryptPassword(conn.ssh.password || ''),
      passphrase: encryptPassword(conn.ssh.passphrase || ''),
    };
  }
  if (!record.id) {
    record.id = crypto.randomUUID();
    record.createdAt = new Date().toISOString();
    arr.push(record);
  } else {
    const i = arr.findIndex((x) => x.id === record.id);
    if (i >= 0) arr[i] = { ...arr[i], ...record };
    else arr.push(record);
  }
  persist(arr);
  return { ...record, password: conn.password || '', ssh: conn.ssh || undefined };
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

module.exports = { list, getById, save, remove, listGroups, addGroup, renameGroup, removeGroup };
