// Renderer workspace persistence. Only serializable tab metadata and editor drafts
// belong here; query results and other server-derived data must never be stored.
// The packaged app stores the snapshot atomically through the main process. The
// localStorage helpers remain as a migration/test fallback for older builds.

export const WORKSPACE_VERSION = 1;
export const WORKSPACE_STORAGE_KEY = 'dbpanda-workspace-v1';

const MAX_TABS = 500;
// Object-tab IDs contain the full connection/database/schema/object identity.
// Never truncate them: two long SQL Server identifiers could otherwise collapse
// into one draft. Reject only clearly abusive/corrupt values.
const MAX_ID_LENGTH = 8192;
const MAX_TYPE_LENGTH = 48;

function storageOrDefault(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage; } catch (e) { return null; }
}

function emptyWorkspace() {
  return { version: WORKSPACE_VERSION, savedAt: 0, activeId: null, context: {}, tabs: [] };
}

function clonePlainState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const text = JSON.stringify(value);
    if (!text) return null;
    const cloned = JSON.parse(text, (key, nested) => (
      key === '__proto__' || key === 'prototype' || key === 'constructor' ? undefined : nested
    ));
    return cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : null;
  } catch (e) {
    return null;
  }
}

/** Validate untrusted/corrupt localStorage data and return a detached snapshot. */
export function normalizeWorkspace(value) {
  if (!value || typeof value !== 'object' || value.version !== WORKSPACE_VERSION) return emptyWorkspace();
  const seen = new Set();
  const tabs = [];
  const inputTabs = Array.isArray(value.tabs) ? value.tabs : [];
  for (const item of inputTabs) {
    if (tabs.length >= MAX_TABS) break;
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' && item.id.length <= MAX_ID_LENGTH ? item.id : '';
    const type = typeof item.type === 'string' ? item.type.slice(0, MAX_TYPE_LENGTH) : '';
    const unsafeId = /[\u0000-\u001f\u007f]/.test(id)
      || id === '__proto__' || id === 'prototype' || id === 'constructor';
    if (!id || unsafeId || !type || !/^[a-z][a-z0-9-]*$/.test(type) || seen.has(id)) continue;
    const state = clonePlainState(item.state);
    if (!state) continue;
    seen.add(id);
    tabs.push({ id, type, state });
  }
  const activeId = typeof value.activeId === 'string' && value.activeId.length <= MAX_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value.activeId)
    ? value.activeId
    : null;
  const savedAt = Number.isFinite(Number(value.savedAt)) ? Number(value.savedAt) : 0;
  const context = clonePlainState(value.context) || {};
  return { version: WORKSPACE_VERSION, savedAt, activeId, context, tabs };
}

export function readWorkspace(storage) {
  const target = storageOrDefault(storage);
  if (!target) return emptyWorkspace();
  try {
    const raw = target.getItem(WORKSPACE_STORAGE_KEY);
    return raw ? normalizeWorkspace(JSON.parse(raw)) : emptyWorkspace();
  } catch (e) {
    return emptyWorkspace();
  }
}

export function writeWorkspace(snapshot, storage) {
  const target = storageOrDefault(storage);
  if (!target) return false;
  const normalized = normalizeWorkspace({
    ...(snapshot || {}),
    version: WORKSPACE_VERSION,
    savedAt: Date.now(),
  });
  normalized.savedAt = Date.now();
  let text;
  try { text = JSON.stringify(normalized); } catch (e) { return false; }
  try {
    target.setItem(WORKSPACE_STORAGE_KEY, text);
    return true;
  } catch (e) {
    return false;
  }
}

/** Load from the atomic main-process store, migrating the legacy localStorage snapshot once. */
export async function loadWorkspace() {
  const api = globalThis.window && globalThis.window.api && globalThis.window.api.workspace;
  if (!api || typeof api.read !== 'function') return readWorkspace();
  let stored = null;
  try { stored = await api.read(); } catch (error) {
    const failure = new Error(`无法读取工作区恢复文件；为避免覆盖旧草稿，本次已停用自动恢复和自动保存。请检查磁盘或文件权限后重启。\n${error && error.message ? error.message : error}`);
    failure.code = 'WORKSPACE_READ_FAILED';
    throw failure;
  }
  if (stored) return normalizeWorkspace(stored);
  const legacy = readWorkspace();
  if (legacy.tabs.length || Object.keys(legacy.context || {}).length) {
    const migrated = { ...legacy, savedAt: Date.now() };
    await api.write(migrated);
    clearWorkspace();
    return migrated;
  }
  return emptyWorkspace();
}

/** Persist a validated snapshot. Failures reject so the UI can warn instead of losing drafts silently. */
export async function saveWorkspace(snapshot) {
  const normalized = normalizeWorkspace({
    ...(snapshot || {}),
    version: WORKSPACE_VERSION,
    savedAt: Date.now(),
  });
  if (Array.isArray(snapshot && snapshot.tabs) && normalized.tabs.length !== snapshot.tabs.length) {
    throw new Error('工作区包含无法序列化的标签，已保留上一次可用快照');
  }
  normalized.savedAt = Date.now();
  const api = globalThis.window && globalThis.window.api && globalThis.window.api.workspace;
  if (api && typeof api.write === 'function') {
    await api.write(normalized);
    return true;
  }
  if (!writeWorkspace(normalized)) throw new Error('浏览器本地存储空间不足');
  return true;
}

export function clearWorkspace(storage) {
  const target = storageOrDefault(storage);
  if (!target) return false;
  try {
    target.removeItem(WORKSPACE_STORAGE_KEY);
    return true;
  } catch (e) {
    return false;
  }
}
