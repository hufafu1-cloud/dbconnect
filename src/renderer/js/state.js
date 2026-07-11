// 全局状态与事件总线
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));

export const state = {
  connections: [],            // 已保存连接配置
  groups: [],                 // 全部分组名（含空组）
  open: new Map(),            // connId -> {version, databases:[], objectsCache:Map(db|schema -> objects)}
  // 当前树上选中的目标，用于“新建查询”等默认上下文
  activeTarget: null,         // {connId, db, schema}
};

function normalizeTarget(target) {
  if (!target || !target.connId) return null;
  const out = { connId: String(target.connId) };
  if (target.db !== undefined && target.db !== null && target.db !== '') out.db = String(target.db);
  if (target.schema !== undefined && target.schema !== null && target.schema !== '') out.schema = String(target.schema);
  if (target.table !== undefined && target.table !== null && target.table !== '') out.table = String(target.table);
  return out;
}

/**
 * 更新全局“当前连接 / 数据库 / 模式 / 对象”上下文。
 * 所有树、对象页和工作标签都应通过这里切换，避免不同功能各自猜测目标。
 */
export function setActiveTarget(target, source = 'unknown') {
  const next = normalizeTarget(target);
  const prev = state.activeTarget;
  if (JSON.stringify(prev) === JSON.stringify(next)) return next;
  state.activeTarget = next;
  emit('target-selected', next ? { ...next, source } : null);
  return next;
}

export function getActiveTarget({ requireOpen = false, requireDb = false } = {}) {
  const target = state.activeTarget;
  if (!target) return null;
  if (requireOpen && !state.open.has(target.connId)) return null;
  if (requireDb && !target.db) return null;
  return { ...target };
}

export function connById(id) {
  return state.connections.find((c) => c.id === id);
}

export function connLabel(id) {
  const c = connById(id);
  return c ? c.name : '(未知连接)';
}

/** 连接的颜色标记（未设置返回 null） */
export function connColor(id) {
  const c = connById(id);
  return (c && c.color) || null;
}

export async function reloadConnections() {
  state.connections = await window.api.conn.list();
  try { state.groups = await window.api.groups.list(); } catch (e) { state.groups = []; }
  emit('connections-changed');
}

export function objectsCacheKey(db, schema) {
  return `${db || ''}|${schema || ''}`;
}
