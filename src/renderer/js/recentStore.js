// 「最近打开」与「收藏」的存储。
//
// 两者都是连接维度的轻量列表，跟着工作区一起持久化——放设置中心不合适，
// 设置是白名单式的固定键，而这里是会不断增长的条目列表。
//
// 条目结构：{ connId, db, schema, table, kind }
// kind 目前只有 'table'（视图也按表处理，打开方式一样）。
const RECENT_LIMIT = 30;
const FAVORITE_LIMIT = 200;

let recent = [];
let favorites = [];
const listeners = new Set();
let persist = () => {};

function key(item) {
  return `${item.connId}|${item.db || ''}|${item.schema || ''}|${item.table}`;
}

function sanitize(item) {
  if (!item || !item.connId || !item.table) return null;
  return {
    connId: String(item.connId),
    db: item.db ? String(item.db) : null,
    schema: item.schema ? String(item.schema) : null,
    table: String(item.table),
    kind: item.kind === 'view' ? 'view' : 'table',
  };
}

function emit() {
  for (const cb of listeners) {
    try { cb(); } catch (error) { console.error('[recent] 订阅回调出错:', error); }
  }
  persist();
}

/** 由 app.js 在工作区加载后注入已保存的数据与持久化回调 */
export function initRecentStore(saved, persistFn) {
  const data = saved && typeof saved === 'object' ? saved : {};
  recent = (Array.isArray(data.recent) ? data.recent : []).map(sanitize).filter(Boolean).slice(0, RECENT_LIMIT);
  favorites = (Array.isArray(data.favorites) ? data.favorites : []).map(sanitize).filter(Boolean).slice(0, FAVORITE_LIMIT);
  persist = typeof persistFn === 'function' ? persistFn : () => {};
}

export function snapshotRecentStore() {
  return { recent: recent.map((item) => ({ ...item })), favorites: favorites.map((item) => ({ ...item })) };
}

/** 打开表时调用。同一张表重复打开只会挪到最前，不会堆出一串重复项。 */
export function noteOpened(item) {
  const entry = sanitize(item);
  if (!entry) return;
  const id = key(entry);
  recent = [entry, ...recent.filter((x) => key(x) !== id)].slice(0, RECENT_LIMIT);
  emit();
}

export function recentItems() { return recent.map((item) => ({ ...item })); }
export function favoriteItems() { return favorites.map((item) => ({ ...item })); }

export function isFavorite(item) {
  const entry = sanitize(item);
  return !!entry && favorites.some((x) => key(x) === key(entry));
}

export function toggleFavorite(item) {
  const entry = sanitize(item);
  if (!entry) return false;
  const id = key(entry);
  const existing = favorites.some((x) => key(x) === id);
  favorites = existing
    ? favorites.filter((x) => key(x) !== id)
    : [entry, ...favorites].slice(0, FAVORITE_LIMIT);
  emit();
  return !existing;
}

export function clearRecent() {
  recent = [];
  emit();
}

/** 连接被删除后，把它名下的条目一起清掉，免得点了打不开 */
export function dropConnection(connId) {
  const before = recent.length + favorites.length;
  recent = recent.filter((item) => item.connId !== connId);
  favorites = favorites.filter((item) => item.connId !== connId);
  if (recent.length + favorites.length !== before) emit();
}

export function onRecentChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}
