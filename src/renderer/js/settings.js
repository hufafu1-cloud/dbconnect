// 渲染进程侧的设置访问层。
//
// 真值在主进程（src/main/settings.js），这里只做一层内存缓存 + 变更通知，
// 顺便把老版本残留在 localStorage 里的偏好一次性搬过去。
//
// 用法：boot 时 await loadSettings() 一次，之后同步用 getSetting(key)；
// 修改走 updateSettings({...})，会落盘并通知所有订阅者。

// 与 src/main/settings.js 的 SCHEMA 默认值保持一致。
// 这里只是 IPC 不可用时的兜底，正常路径永远以主进程返回值为准。
const DEFAULTS = {
  theme: 'light',
  uiScale: 100,
  gridDensity: 'default',
  keymap: 'dbpanda',
  impactPreview: 'risky',
  backupKeep: 7,
  sidebarWidth: 280, // 与 css/app.css 的 #sidebar width 一致
  queryMaxRows: 2000,
  tablePageSize: 500,
};

// 老版本把偏好写在 localStorage，这里做一次性搬迁后删除，之后不再读取。
const LEGACY_KEYS = {
  'dbc-theme': { key: 'theme', parse: (v) => (v === 'dark' || v === 'light' ? v : undefined) },
  'dbpanda-sidebar-width': {
    key: 'sidebarWidth',
    parse: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 170 && n <= 560 ? Math.round(n) : undefined;
    },
  },
};

let cache = { ...DEFAULTS };
const listeners = new Set();

function legacyStore() {
  try { return globalThis.localStorage; } catch (e) { return null; }
}

/**
 * 只搬迁「用户确实改过」的项：如果主进程里该键还是默认值，说明从未设置过，
 * 才采用 localStorage 里的旧值。这样即使旧键没删干净，也不会把新设置覆盖回去。
 */
async function migrateLegacy() {
  const ls = legacyStore();
  if (!ls) return;
  const patch = {};
  const consumed = [];
  for (const [legacyKey, spec] of Object.entries(LEGACY_KEYS)) {
    let raw = null;
    try { raw = ls.getItem(legacyKey); } catch (e) { continue; }
    if (raw === null) continue;
    consumed.push(legacyKey);
    const value = spec.parse(raw);
    if (value === undefined) continue;
    if (cache[spec.key] !== DEFAULTS[spec.key]) continue; // 主进程已有用户设置，旧值作废
    if (value === cache[spec.key]) continue;
    patch[spec.key] = value;
  }
  if (Object.keys(patch).length) {
    try { await applyPatch(patch); } catch (e) { return; } // 搬迁失败就保留旧键，下次再试
  }
  for (const key of consumed) {
    try { ls.removeItem(key); } catch (e) { /* ignore */ }
  }
}

async function applyPatch(patch) {
  const saved = await window.api.settings.patch(patch);
  cache = saved && typeof saved === 'object' ? saved : { ...cache, ...patch };
  return cache;
}

/** 启动时调用一次。IPC 失败不阻断启动，退回默认值继续运行。 */
export async function loadSettings() {
  try {
    const loaded = await window.api.settings.read();
    if (loaded && typeof loaded === 'object') cache = { ...DEFAULTS, ...loaded };
  } catch (error) {
    console.error('[settings] 读取失败，本次使用默认设置:', error && error.message);
  }
  await migrateLegacy().catch(() => {});
  return { ...cache };
}

export function getSetting(key) {
  return cache[key];
}

export function allSettings() {
  return { ...cache };
}

/** 写入并广播。返回落盘后的完整设置。 */
export async function updateSettings(patch) {
  if (!patch || typeof patch !== 'object') return { ...cache };
  const before = { ...cache };
  const after = await applyPatch(patch);
  const changed = Object.keys(after).filter((key) => after[key] !== before[key]);
  if (changed.length) {
    for (const cb of listeners) {
      try { cb({ ...after }, changed); } catch (e) { console.error('[settings] 订阅回调出错:', e); }
    }
  }
  return { ...after };
}

/** 订阅变更，返回取消订阅函数 */
export function onSettingsChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export { DEFAULTS as SETTING_DEFAULTS };
