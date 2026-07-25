// 用户界面偏好与轻量工作习惯数据。与连接密码分离保存，采用原子替换避免异常退出损坏。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = 'preferences-v1.json';
const defaults = Object.freeze({
  version: 1,
  ui: { theme: 'light', density: 'comfortable', toolbar: 'compact', sidebarWidth: 278 },
  editor: { tabSize: 2, lineWrapping: false, showInvisibles: false, maxRows: 2000 },
  grid: { density: 'comfortable', lastColumnFill: true },
  favorites: [],
  recents: [],
  snippets: [
    { id: 'select-top', name: '查询前 N 行', sql: 'SELECT *\nFROM ${table}\nLIMIT ${limit:100};' },
    { id: 'count', name: '统计行数', sql: 'SELECT COUNT(*) AS total\nFROM ${table};' },
  ],
  notifications: [],
});
let cache = null;
let tail = Promise.resolve();

function filePath() { return path.join(app.getPath('userData'), FILE); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function normalize(raw) {
  const base = clone(defaults);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  for (const key of ['ui', 'editor', 'grid']) {
    if (raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])) Object.assign(base[key], raw[key]);
  }
  for (const key of ['favorites', 'recents', 'snippets', 'notifications']) {
    if (Array.isArray(raw[key])) base[key] = raw[key].slice(0, key === 'notifications' ? 200 : 100);
  }
  return base;
}
async function load() {
  if (cache) return clone(cache);
  try { cache = normalize(JSON.parse(await fs.promises.readFile(filePath(), 'utf8'))); }
  catch (e) { cache = clone(defaults); }
  return clone(cache);
}
async function atomicWrite(data) {
  const target = filePath();
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(temp, target);
}
function save(next) {
  const job = tail.catch(() => {}).then(async () => {
    cache = normalize(next);
    await atomicWrite(cache);
    return clone(cache);
  });
  tail = job;
  return job;
}
async function patch(delta) {
  const current = await load();
  const next = normalize({ ...current, ...delta,
    ui: { ...current.ui, ...(delta && delta.ui) },
    editor: { ...current.editor, ...(delta && delta.editor) },
    grid: { ...current.grid, ...(delta && delta.grid) },
  });
  return save(next);
}
function reset() { return save(clone(defaults)); }
module.exports = { load, patch, reset, defaults };
