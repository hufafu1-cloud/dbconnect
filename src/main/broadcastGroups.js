// 广播组：把「这次要广播到哪些连接和库」存下来，下次直接选。
//
// 存的是**选择器**（连接名 / 库名，允许通配）而不是展开后的目标列表：
// 分库分表的库是会增减的，存死了目标列表就会漏掉新加的库——
// 而漏一个库正是广播最不该出的错。每次执行时按当下的连接和库重新展开。
//
// 与 settings.js 分开：设置是固定键的白名单，这里是会不断增长的条目列表，
// 与 history.js 是同一类东西。
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'broadcast-groups.json';
const MAX_GROUPS = 100;
const MAX_SELECTORS = 64;
const NAME_RE = /^[^\r\n\t]{1,60}$/;

let cache = null;

const filePath = () => path.join(app.getPath('userData'), FILE_NAME);

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    cache = Array.isArray(parsed) ? parsed.filter(valid).slice(0, MAX_GROUPS) : [];
  } catch (e) {
    cache = [];
  }
  return cache;
}

function valid(item) {
  return !!item && typeof item.name === 'string' && NAME_RE.test(item.name)
    && Array.isArray(item.selectors);
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache), 'utf8');
  } catch (e) { /* 存不下不该挡住执行 */ }
}

/** 渲染进程传来的选择器一律不可信：只取需要的两个字段并限长 */
function sanitizeSelectors(raw) {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, MAX_SELECTORS)
    .map((item) => ({
      conn: String((item && item.conn) || '').slice(0, 200).trim(),
      db: String((item && item.db) || '').slice(0, 200).trim(),
    }))
    .filter((item) => item.conn);
}

function list() {
  return load().map((item) => ({ ...item, selectors: item.selectors.map((s) => ({ ...s })) }));
}

function save(name, selectors) {
  const text = String(name || '').trim();
  if (!NAME_RE.test(text)) throw new Error('广播组名称不能为空，也不能超过 60 个字符');
  const cleaned = sanitizeSelectors(selectors);
  if (!cleaned.length) throw new Error('广播组至少要有一条选择规则');
  const groups = load();
  const at = groups.findIndex((item) => item.name === text);
  const entry = { name: text, selectors: cleaned, savedAt: Date.now() };
  if (at >= 0) groups[at] = entry;
  else {
    if (groups.length >= MAX_GROUPS) throw new Error(`广播组最多保存 ${MAX_GROUPS} 个`);
    groups.push(entry);
  }
  persist();
  return entry;
}

function remove(name) {
  const groups = load();
  const at = groups.findIndex((item) => item.name === String(name || ''));
  if (at < 0) return false;
  groups.splice(at, 1);
  persist();
  return true;
}

module.exports = { list, save, remove, sanitizeSelectors, MAX_GROUPS, MAX_SELECTORS };
