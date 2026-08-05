// 应用设置：主进程统一持有，渲染进程只能通过 IPC 读写白名单内的键。
//
// 在此之前，偏好散在三个地方：主题和侧栏宽度在渲染进程的 localStorage，AI 配置在
// store.js，而「查询结果行数上限」「表格每页行数」压根没有持久化——每次重开都回到默认值。
// 这里把它们收成一处，后续新增设置项只需要往 SCHEMA 里加一行。
//
// 渲染进程传来的值一律视为不可信：SCHEMA 里没有的键直接丢弃，值不合法回落到默认值，
// 绝不把渲染进程给的对象原样落盘。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE_NAME = 'settings-v1.json';
const MAX_SETTINGS_BYTES = 256 * 1024;

/** 取值必须落在给定集合内（按数值比较，兼容渲染进程传来的字符串） */
const numberIn = (...values) => (raw) => {
  const n = Number(raw);
  return values.includes(n) ? n : undefined;
};
const stringIn = (...values) => (raw) => (values.includes(raw) ? raw : undefined);
const intRange = (min, max) => (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const v = Math.round(n);
  return v >= min && v <= max ? v : undefined;
};

// 白名单：键 → { def 默认值, parse 校验器 }
const SCHEMA = {
  // 'system' 跟随操作系统的深浅色（由主进程的 nativeTheme 判定）
  theme: { def: 'light', parse: stringIn('light', 'dark', 'system') },
  // 界面缩放百分比，走 Electron 的 setZoomFactor，整体等比放大
  uiScale: { def: 100, parse: numberIn(100, 125, 150) },
  // 数据网格行高档位，映射到 CSS 变量 --grid-row-height
  gridDensity: { def: 'default', parse: stringIn('compact', 'default', 'comfortable') },
  // 快捷键方案，见 app.js 的 KEYMAPS
  keymap: { def: 'dbpanda', parse: stringIn('dbpanda', 'navicat') },
  // 执行 UPDATE/DELETE 前是否提示受影响行数
  // off 关闭 / risky 仅无 WHERE 或影响过大时 / always 每次写操作都提示
  impactPreview: { def: 'risky', parse: stringIn('off', 'risky', 'always') },
  // 默认值必须与 css/app.css 里 #sidebar 的 width 一致，否则首次启动会静默改变布局
  sidebarWidth: { def: 280, parse: intRange(170, 560) },
  queryMaxRows: { def: 2000, parse: numberIn(200, 2000, 10000) },
  tablePageSize: { def: 500, parse: numberIn(100, 500, 1000) },
};

let cache = null;
let writeTail = Promise.resolve();
let tempSequence = 0;

function filePath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function defaults() {
  const out = {};
  for (const [key, spec] of Object.entries(SCHEMA)) out[key] = spec.def;
  return out;
}

/** 用 SCHEMA 过滤任意输入，非法键丢弃、非法值回落默认值 */
function sanitize(raw) {
  const out = defaults();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, spec] of Object.entries(SCHEMA)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = spec.parse(raw[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** 同步载入：文件不到 1 KB，启动时读一次，避免首帧主题闪烁 */
function load() {
  if (cache) return cache;
  try {
    const stat = fs.statSync(filePath());
    if (stat.isFile() && stat.size <= MAX_SETTINGS_BYTES) {
      cache = sanitize(JSON.parse(fs.readFileSync(filePath(), 'utf8')));
      return cache;
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      console.error('[settings] 读取失败，使用默认设置:', error && error.message);
    }
  }
  cache = defaults();
  return cache;
}

async function atomicWrite(text) {
  const target = filePath();
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${++tempSequence}`;
  try {
    await fs.promises.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
    await fs.promises.rename(tmp, target);
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

function all() {
  return { ...load() };
}

function get(key) {
  return load()[key];
}

/** 合并写入；返回落盘后的完整设置。写失败会抛出，调用方（IPC）会转成 {ok:false} */
function patch(partial) {
  const merged = sanitize({ ...load(), ...(partial && typeof partial === 'object' ? partial : {}) });
  cache = merged;
  const text = JSON.stringify(merged, null, 2);
  const task = writeTail.catch(() => {}).then(() => atomicWrite(text));
  writeTail = task;
  return task.then(() => ({ ...merged }));
}

module.exports = { all, get, patch, defaults, SCHEMA_KEYS: Object.keys(SCHEMA) };
