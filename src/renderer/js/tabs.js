// 标签页管理
import { $, el, iconEl } from './util.js';
import { confirmDialog } from './toast.js';

const tabs = new Map(); // id -> {id, tabEl, paneEl, onShow, onClose, isDirty, title}
let activeId = null;
let seq = 0;

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
}

export async function closeTab(id, force) {
  const t = tabs.get(id);
  if (!t || t.permanent) return;
  if (!force && t.isDirty && t.isDirty()) {
    const ok = await confirmDialog('关闭标签页', `“${t.title}” 有未保存的更改，确定关闭吗？`, { danger: true, okLabel: '关闭' });
    if (!ok) return;
  }
  if (t.onClose) t.onClose();
  t.tabEl.remove();
  t.paneEl.remove();
  tabs.delete(id);
  if (activeId === id) {
    const rest = [...tabs.keys()];
    activate(rest[rest.length - 1]);
  }
}

/**
 * 新增标签页
 * @param {object} opts {id?, title, icon, permanent?, onShow?, onClose?, isDirty?}
 * @returns {id, pane, setTitle, setDirty, close, activate}
 */
export function addTab(opts) {
  const id = opts.id || uid('tab');
  if (tabs.has(id)) { activate(id); return tabs.get(id).handle; }

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

  const paneEl = el('div', { class: 'tabpane' });
  $('#tabbar').append(tabEl);
  $('#tabpanes').append(paneEl);

  const rec = {
    id, tabEl, paneEl, title: opts.title,
    permanent: opts.permanent, onShow: opts.onShow, onClose: opts.onClose, isDirty: opts.isDirty,
  };
  const handle = {
    id,
    pane: paneEl,
    setTitle(t) { rec.title = t; titleEl.textContent = t; tabEl.title = t; },
    setDirty(d) { tabEl.classList.toggle('dirty', !!d); },
    setOnShow(fn) { rec.onShow = fn; },
    setIsDirty(fn) { rec.isDirty = fn; },
    setOnClose(fn) { rec.onClose = fn; },
    close: (force) => closeTab(id, force),
    activate: () => activate(id),
  };
  rec.handle = handle;
  tabs.set(id, rec);
  activate(id);
  return handle;
}

export function anyDirty() {
  for (const t of tabs.values()) {
    if (t.isDirty && t.isDirty()) return true;
  }
  return false;
}

export function closeActive() {
  if (activeId) closeTab(activeId);
}
