// 保存的查询：按连接归属，本地 JSON 持久化（树上的“查询”节点）
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let cache = null;

function filePath() {
  return path.join(app.getPath('userData'), 'queries.json');
}

function load() {
  if (cache) return cache;
  try {
    const arr = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    cache = Array.isArray(arr) ? arr : [];
  } catch (e) {
    cache = [];
  }
  return cache;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}

function list(connId) {
  return load()
    .filter((q) => q.connId === connId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((q) => ({ ...q }));
}

function save({ id, connId, name, sql }) {
  const arr = load();
  if (!name || !name.trim()) throw new Error('查询名不能为空');
  name = name.trim();
  if (id) {
    const rec = arr.find((q) => q.id === id);
    if (!rec) throw new Error('查询不存在');
    rec.name = name;
    rec.sql = String(sql || '');
    rec.updatedAt = Date.now();
    persist();
    return { ...rec };
  }
  // 同连接下重名时自动加序号
  let final = name;
  let n = 2;
  while (arr.some((q) => q.connId === connId && q.name === final)) final = `${name} (${n++})`;
  const rec = { id: crypto.randomUUID(), connId, name: final, sql: String(sql || ''), updatedAt: Date.now() };
  arr.push(rec);
  persist();
  return { ...rec };
}

function rename(id, name) {
  const rec = load().find((q) => q.id === id);
  if (!rec) throw new Error('查询不存在');
  if (!name || !name.trim()) throw new Error('查询名不能为空');
  rec.name = name.trim();
  rec.updatedAt = Date.now();
  persist();
  return { ...rec };
}

function remove(id) {
  cache = load().filter((q) => q.id !== id);
  persist();
}

module.exports = { list, save, rename, remove };
