// 标签页管理
import { $, el, iconEl } from './util.js';
import { confirmDialog, toast } from './toast.js';
import { showMenu } from './contextmenu.js';
import { loadWorkspace, saveWorkspace } from './workspace.js';

const tabs = new Map(); // id -> {id, tabEl, paneEl, onShow, onClose, isDirty, recovery, title}
let activeId = null;
let seq = 0;
let workspaceReady = false;
let workspaceRestoring = false;
let workspaceTimer = null;
let workspaceInterval = null;
let workspaceContextProvider = null;
let loadedWorkspace = null;
let workspaceOrder = [];
let workspaceActiveId = null;
let workspaceWriteTail = Promise.resolve(true);
let workspaceSaveErrorShown = false;
let lastWorkspaceSignature = null;
let lastEnqueuedWorkspaceSignature = null;
const deferredWorkspaceEntries = new Map();

function workspaceSignature(snapshot) {
  try {
    return JSON.stringify({
      activeId: snapshot && snapshot.activeId || null,
      context: snapshot && snapshot.context || {},
      tabs: snapshot && snapshot.tabs || [],
    });
  } catch (e) { return null; }
}

function syncSeq(id) {
  const match = /-(\d+)$/.exec(String(id || ''));
  if (!match) return;
  const parsed = Number(match[1]);
  if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 1000000) {
    seq = Math.max(seq, parsed);
  }
}

function recoveryFor(typeOrOpts, getState) {
  if (typeof typeOrOpts === 'string') {
    return { type: typeOrOpts, getState: typeof getState === 'function' ? getState : () => getState };
  }
  if (!typeOrOpts || typeof typeOrOpts !== 'object' || typeof typeOrOpts.type !== 'string') return null;
  const getter = typeOrOpts.getState || typeOrOpts.snapshot;
  return { type: typeOrOpts.type, getState: typeof getter === 'function' ? getter : () => typeOrOpts.state };
}

function currentWorkspaceSnapshot() {
  const liveTabs = new Map();
  for (const t of tabs.values()) {
    if (!t.recovery || typeof t.recovery.getState !== 'function') continue;
    try {
      const state = t.recovery.getState();
      if (state && typeof state === 'object' && !Array.isArray(state)) {
        liveTabs.set(t.id, { id: t.id, type: t.recovery.type, state });
        // A deferred draft is superseded only after its replacement can produce
        // a complete, serializable snapshot. Async tabs commonly return null
        // while they are still hydrating.
        deferredWorkspaceEntries.delete(t.id);
      }
    } catch (e) { /* a broken tab must not block recovery for the others */ }
  }
  let context = {};
  try {
    const next = workspaceContextProvider && workspaceContextProvider();
    if (next && typeof next === 'object' && !Array.isArray(next)) context = next;
  } catch (e) { /* context is optional; tab drafts still remain recoverable */ }
  // A temporarily unavailable connection or failed async hydrate must not erase
  // the last good draft. A live, valid snapshot supersedes its deferred copy.
  const recoverable = new Map(deferredWorkspaceEntries);
  for (const [id, item] of liveTabs) recoverable.set(id, item);
  const savedTabs = [];
  const seen = new Set();
  for (const id of workspaceOrder) {
    const item = recoverable.get(id);
    if (!item || seen.has(id)) continue;
    savedTabs.push(item);
    seen.add(id);
  }
  for (const [id, item] of recoverable) {
    if (seen.has(id)) continue;
    savedTabs.push(item);
    seen.add(id);
  }
  return { activeId, context, tabs: savedTabs };
}

function reorderWorkspaceDom() {
  const tabbar = $('#tabbar');
  const tabpanes = $('#tabpanes');
  if (!tabbar || !tabpanes) return;
  for (const id of workspaceOrder) {
    const tab = tabs.get(id);
    if (!tab) continue;
    tabbar.append(tab.tabEl);
    tabpanes.append(tab.paneEl);
  }
}

function ensureWorkspaceHooks() {
  if (workspaceInterval || typeof window === 'undefined') return;
  // The interval is a crash-recovery safety net for controls whose change event
  // does not explicitly call touchRecovery().
  workspaceInterval = window.setInterval(() => persistWorkspaceNow(), 2000);
  window.addEventListener('beforeunload', () => persistWorkspaceNow());
}

function scheduleWorkspacePersist() {
  ensureWorkspaceHooks();
  if (!workspaceReady || workspaceRestoring || typeof window === 'undefined') return;
  if (workspaceTimer) window.clearTimeout(workspaceTimer);
  workspaceTimer = window.setTimeout(() => {
    workspaceTimer = null;
    persistWorkspaceNow();
  }, 120);
}

export function getWorkspaceSnapshot() {
  return currentWorkspaceSnapshot();
}

export async function getStoredWorkspace() {
  if (!loadedWorkspace) {
    loadedWorkspace = await loadWorkspace();
    lastWorkspaceSignature = workspaceSignature(loadedWorkspace);
    lastEnqueuedWorkspaceSignature = lastWorkspaceSignature;
  }
  return loadedWorkspace;
}

/** Keep connection/session context outside tabs.js so state.js remains decoupled. */
export function setWorkspaceContextProvider(provider) {
  workspaceContextProvider = typeof provider === 'function' ? provider : null;
  scheduleWorkspacePersist();
}

/** Notify persistence after connection/target context changes outside a tab. */
export function touchWorkspacePersistence() {
  scheduleWorkspacePersist();
}

export async function persistWorkspaceNow() {
  if (!workspaceReady || workspaceRestoring) return Promise.resolve(false);
  if (workspaceTimer && typeof window !== 'undefined') {
    window.clearTimeout(workspaceTimer);
    workspaceTimer = null;
  }
  const snapshot = currentWorkspaceSnapshot();
  const signature = workspaceSignature(snapshot);
  if (!signature || signature !== lastEnqueuedWorkspaceSignature) {
    const queuedSignature = signature;
    lastEnqueuedWorkspaceSignature = queuedSignature;
    const write = workspaceWriteTail.catch(() => {}).then(() => saveWorkspace(snapshot));
    workspaceWriteTail = write.then(() => {
      loadedWorkspace = { ...snapshot, version: 1, savedAt: Date.now() };
      lastWorkspaceSignature = queuedSignature;
      workspaceSaveErrorShown = false;
      return true;
    }, (error) => {
      if (lastEnqueuedWorkspaceSignature === queuedSignature) {
        lastEnqueuedWorkspaceSignature = lastWorkspaceSignature;
      }
      if (!workspaceSaveErrorShown) {
        workspaceSaveErrorShown = true;
        toast.error(`工作区草稿保存失败：${error && error.message ? error.message : error}\n已保留上一次可用快照，请先手动保存重要 SQL。`, 15000);
      }
      return false;
    });
  }
  const saved = await workspaceWriteTail;
  if (!saved) return false;
  // State may change while an earlier write is in flight. Close callers must
  // not report success until the latest observable snapshot is actually last.
  const latestSignature = workspaceSignature(currentWorkspaceSnapshot());
  if (latestSignature && latestSignature !== lastWorkspaceSignature) return persistWorkspaceNow();
  return true;
}

/**
 * Restore saved tabs in their original order without coupling tabs.js to the
 * individual tab modules. restoreOne(entry) returns the created tab handle (or
 * null for an entry that is no longer safe/valid to restore).
 */
export async function restoreWorkspaceTabs(restoreOne) {
  ensureWorkspaceHooks();
  const stored = await getStoredWorkspace();
  const restored = new Map();
  let skipped = 0;
  workspaceOrder = stored.tabs.map((entry) => entry.id);
  workspaceActiveId = stored.activeId || null;
  deferredWorkspaceEntries.clear();
  for (const entry of stored.tabs) {
    syncSeq(entry.id);
    deferredWorkspaceEntries.set(entry.id, entry);
  }
  workspaceRestoring = true;
  try {
    if (typeof restoreOne === 'function') {
      for (const entry of stored.tabs) {
        try {
          const handle = await restoreOne(entry);
          if (handle && handle.id) {
            restored.set(entry.id, handle);
            deferredWorkspaceEntries.delete(entry.id);
          } else if (handle === false) {
            deferredWorkspaceEntries.delete(entry.id);
            if (workspaceActiveId === entry.id) workspaceActiveId = null;
            skipped++;
          } else {
            deferredWorkspaceEntries.set(entry.id, entry);
            skipped++;
          }
        } catch (e) {
          deferredWorkspaceEntries.set(entry.id, entry);
          skipped++;
        }
      }
    } else {
      skipped = stored.tabs.length;
    }
  } finally {
    workspaceRestoring = false;
    workspaceReady = true;
  }
  reorderWorkspaceDom();
  if (workspaceActiveId && tabs.has(workspaceActiveId)) {
    activate(workspaceActiveId);
    workspaceActiveId = null;
  }
  scheduleWorkspacePersist();
  return { restored: restored.size, skipped, deferred: deferredWorkspaceEntries.size, snapshot: stored };
}

/** Retry temporarily deferred entries, for example after their connection opens later. */
export async function retryDeferredWorkspaceTabs(restoreOne, predicate) {
  if (!workspaceReady || workspaceRestoring || typeof restoreOne !== 'function') {
    return { restored: 0, deferred: deferredWorkspaceEntries.size };
  }
  let restored = 0;
  const previousActiveId = activeId;
  workspaceRestoring = true;
  try {
    for (const [id, entry] of [...deferredWorkspaceEntries]) {
      if (predicate && !predicate(entry)) continue;
      try {
        const handle = await restoreOne(entry);
        if (handle && handle.id) {
          deferredWorkspaceEntries.delete(id);
          restored++;
        } else if (handle === false) {
          deferredWorkspaceEntries.delete(id);
          if (workspaceActiveId === id) workspaceActiveId = null;
        }
        else deferredWorkspaceEntries.set(id, entry);
      } catch (e) { deferredWorkspaceEntries.set(id, entry); }
    }
  } finally {
    workspaceRestoring = false;
  }
  reorderWorkspaceDom();
  if (workspaceActiveId && tabs.has(workspaceActiveId)) {
    activate(workspaceActiveId);
    workspaceActiveId = null;
  } else if (previousActiveId && tabs.has(previousActiveId)) activate(previousActiveId);
  scheduleWorkspacePersist();
  return { restored, deferred: deferredWorkspaceEntries.size };
}

/** Start persistence when a caller intentionally chooses not to restore. */
export function startWorkspacePersistence() {
  ensureWorkspaceHooks();
  workspaceReady = true;
  scheduleWorkspacePersist();
}

export function uid(prefix) { return `${prefix}-${++seq}`; }

export function getActiveTab() { return activeId ? tabs.get(activeId) : null; }

export function activate(id) {
  const t = tabs.get(id);
  if (!t) return;
  for (const [tid, tt] of tabs) {
    tt.tabEl.classList.toggle('active', tid === id);
    tt.paneEl.classList.toggle('active', tid === id);
  }
  activeId = id;
  if (t.onShow) t.onShow();
  scheduleWorkspacePersist();
}

export async function closeTab(id, force) {
  const t = tabs.get(id);
  if (!t || t.permanent) return;
  if (!force && t.isDirty && t.isDirty()) {
    const ok = await confirmDialog('关闭标签页', `“${t.title}” 有未保存的更改，确定关闭吗？`, { danger: true, okLabel: '关闭' });
    if (!ok) return;
  }
  if (t.beforeClose) {
    const allowed = await t.beforeClose({ force: !!force });
    if (allowed === false) return;
  }
  if (t.onClose) t.onClose();
  t.tabEl.remove();
  t.paneEl.remove();
  tabs.delete(id);
  deferredWorkspaceEntries.delete(id);
  workspaceOrder = workspaceOrder.filter((tabId) => tabId !== id);
  if (activeId === id) {
    const rest = [...tabs.keys()];
    activate(rest[rest.length - 1]);
  }
  scheduleWorkspacePersist();
}

/**
 * 新增标签页
 * @param {object} opts {id?, title, icon, permanent?, onShow?, beforeClose?, onClose?, isDirty?}
 * @returns {id, pane, setTitle, setDirty, close, activate}
 */
export function addTab(opts) {
  const id = opts.id || uid('tab');
  if (tabs.has(id)) { activate(id); return tabs.get(id).handle; }
  const deferredWorkspaceEntry = deferredWorkspaceEntries.get(id) || null;
  if (!workspaceOrder.includes(id)) workspaceOrder.push(id);
  syncSeq(id);

  const titleEl = el('span', { class: 'tab-title' }, opts.title);
  const tabEl = el('div', { class: 'tab', title: opts.tooltip || opts.title, onClick: () => activate(id) },
    opts.color ? el('span', { class: 'tab-dot', style: { background: opts.color } }) : null,
    iconEl(opts.icon || 'table'),
    titleEl);
  if (!opts.permanent) {
    tabEl.append(el('span', {
      class: 'tab-close', title: '关闭 (Ctrl+W)',
      onClick: (e) => { e.stopPropagation(); closeTab(id); },
    }, '✕'));
  }
  tabEl.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(id); });
  tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      !opts.permanent && { label: '关闭', hint: 'Ctrl+W', onClick: () => closeTab(id) },
      { label: '关闭其他标签页', onClick: () => closeOtherTabs(id) },
      { label: '关闭右侧标签页', onClick: () => closeTabsToRight(id) },
      { sep: true },
      { label: '关闭全部标签页', onClick: () => closeAllTabs() },
    ].filter(Boolean));
  });

  const paneEl = el('div', { class: 'tabpane' });
  $('#tabbar').append(tabEl);
  $('#tabpanes').append(paneEl);

  const rec = {
    id, tabEl, paneEl, title: opts.title,
    target: opts.target && typeof opts.target === 'object' ? { ...opts.target } : null,
    permanent: opts.permanent, onShow: opts.onShow, beforeClose: opts.beforeClose, onClose: opts.onClose, isDirty: opts.isDirty,
    recovery: recoveryFor(opts.recovery || opts.workspace),
  };
  const handle = {
    id,
    pane: paneEl,
    target: rec.target ? { ...rec.target } : null,
    deferredWorkspaceEntry,
    setTitle(t) { rec.title = t; titleEl.textContent = t; tabEl.title = t; scheduleWorkspacePersist(); },
    setDirty(d) { tabEl.classList.toggle('dirty', !!d); scheduleWorkspacePersist(); },
    setOnShow(fn) { rec.onShow = fn; },
    setBeforeClose(fn) { rec.beforeClose = fn; },
    setIsDirty(fn) { rec.isDirty = fn; },
    setOnClose(fn) { rec.onClose = fn; },
    setRecovery(type, getState) { rec.recovery = recoveryFor(type, getState); scheduleWorkspacePersist(); return handle; },
    setWorkspace(type, getState) { rec.recovery = recoveryFor(type, getState); scheduleWorkspacePersist(); return handle; },
    clearRecovery() { rec.recovery = null; scheduleWorkspacePersist(); },
    touchRecovery: scheduleWorkspacePersist,
    touchWorkspace: scheduleWorkspacePersist,
    close: (force) => closeTab(id, force),
    activate: () => activate(id),
  };
  rec.handle = handle;
  tabs.set(id, rec);
  activate(id);
  scheduleWorkspacePersist();
  return handle;
}

export function anyDirty() {
  for (const t of tabs.values()) {
    if (t.isDirty && t.isDirty()) return true;
  }
  return false;
}

/** 在应用退出前运行标签级资源保护（例如活动事务的提交/回滚选择）。 */
export async function runBeforeCloseGuards(context = {}) {
  for (const t of tabs.values()) {
    if (!t.beforeClose) continue;
    const allowed = await t.beforeClose({ ...context, appClose: true });
    if (allowed === false) return false;
  }
  return true;
}

export function closeActive() {
  if (activeId) closeTab(activeId);
}

/** 标签的视觉顺序（tabbar DOM 顺序，工作区恢复后可能与插入顺序不同） */
function orderedTabIds() {
  const bar = $('#tabbar');
  if (!bar) return [...tabs.keys()];
  const byEl = new Map([...tabs.values()].map((t) => [t.tabEl, t.id]));
  return [...bar.children].map((elm) => byEl.get(elm)).filter(Boolean);
}

/** Ctrl+Tab / Ctrl+Shift+Tab 循环切换 */
export function activateRelative(delta) {
  const ids = orderedTabIds();
  if (ids.length < 2) return;
  const i = Math.max(0, ids.indexOf(activeId));
  activate(ids[(i + delta + ids.length) % ids.length]);
}

export async function closeOtherTabs(keepId) {
  for (const id of orderedTabIds()) {
    if (id !== keepId) await closeTab(id);
  }
}

export async function closeTabsToRight(id) {
  const ids = orderedTabIds();
  const i = ids.indexOf(id);
  if (i < 0) return;
  for (const tid of ids.slice(i + 1)) await closeTab(tid);
}

export async function closeAllTabs() {
  for (const id of orderedTabIds()) await closeTab(id);
}
