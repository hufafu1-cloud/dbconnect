// 集中管理可跨重启保留的界面偏好、收藏、最近访问和任务通知。
let prefs = null;
const listeners = new Set();

export async function loadPreferences() {
  if (!prefs) prefs = await window.api.preferences.read();
  return prefs;
}
export function getPreferences() { return prefs || { ui: {}, editor: {}, grid: {}, favorites: [], recents: [], snippets: [], notifications: [] }; }
export async function patchPreferences(delta) {
  prefs = await window.api.preferences.patch(delta);
  for (const listener of listeners) listener(prefs);
  return prefs;
}
export function onPreferences(listener) { listeners.add(listener); return () => listeners.delete(listener); }

export function targetKey(target) {
  if (!target) return '';
  return [target.connId, target.db || '', target.schema || '', target.table || '', target.kind || ''].join('|');
}
export async function addRecent(target, title) {
  if (!target || !target.connId) return;
  const p = await loadPreferences();
  const key = targetKey(target);
  const recents = [{ key, target: { ...target }, title: title || target.table || target.db || '连接', at: Date.now() }, ...(p.recents || []).filter((x) => x.key !== key)].slice(0, 30);
  return patchPreferences({ recents });
}
export async function toggleFavorite(target, title) {
  if (!target || !target.connId) return false;
  const p = await loadPreferences();
  const key = targetKey(target);
  const existing = (p.favorites || []).some((x) => x.key === key);
  const favorites = existing ? p.favorites.filter((x) => x.key !== key)
    : [{ key, target: { ...target }, title: title || target.table || target.db || '连接', at: Date.now() }, ...p.favorites].slice(0, 100);
  await patchPreferences({ favorites });
  return !existing;
}
export function isFavorite(target) { return (getPreferences().favorites || []).some((x) => x.key === targetKey(target)); }

export async function recordNotification(type, message, detail) {
  const p = await loadPreferences();
  const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type, message: String(message || ''), detail: detail ? String(detail) : '', at: Date.now(), read: false };
  await patchPreferences({ notifications: [item, ...(p.notifications || [])].slice(0, 200) });
  return item;
}
export async function markNotificationsRead() {
  const p = await loadPreferences();
  return patchPreferences({ notifications: (p.notifications || []).map((x) => ({ ...x, read: true })) });
}
