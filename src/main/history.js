// 查询历史：本地 JSON 持久化，最多保留 500 条
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ENTRIES = 500;
const MAX_SQL_LEN = 20000;
let cache = null;
let saveTimer = null;

function filePath() {
  return path.join(app.getPath('userData'), 'history.json');
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

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(filePath()), { recursive: true });
      fs.writeFileSync(filePath(), JSON.stringify(cache), 'utf8');
    } catch (e) { /* ignore */ }
  }, 300);
}

/** entry: {connId, connName, db, sql, ms, ok, error?, statements} */
function add(entry) {
  const list = load();
  list.unshift({
    id: crypto.randomUUID(),
    ts: Date.now(),
    ...entry,
    sql: String(entry.sql || '').slice(0, MAX_SQL_LEN),
    error: entry.error ? String(entry.error).slice(0, 2000) : undefined,
  });
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  schedulePersist();
}

function list({ search = '', limit = 300 } = {}) {
  let arr = load();
  const q = search.trim().toLowerCase();
  if (q) {
    arr = arr.filter((e) =>
      (e.sql || '').toLowerCase().includes(q) ||
      (e.connName || '').toLowerCase().includes(q) ||
      (e.db || '').toLowerCase().includes(q));
  }
  return arr.slice(0, limit);
}

function clear() {
  cache = [];
  schedulePersist();
}

/** 测试用：立即落盘 */
function flushSync() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache || []), 'utf8');
  } catch (e) { /* ignore */ }
}

module.exports = { add, list, clear, flushSync };
