// 全局状态与事件总线
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));

export const state = {
  connections: [],            // 已保存连接配置
  open: new Map(),            // connId -> {version, databases:[], objectsCache:Map(db|schema -> objects)}
  // 当前树上选中的目标，用于“新建查询”等默认上下文
  activeTarget: null,         // {connId, db, schema}
};

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
  emit('connections-changed');
}

export function objectsCacheKey(db, schema) {
  return `${db || ''}|${schema || ''}`;
}
