// 通知 Toast + 通用模态框 + 确认/输入对话框
import { el, cellText } from './util.js';

let toastRoot = null;
function root() {
  if (!toastRoot) {
    toastRoot = el('div', { id: 'toasts' });
    document.body.append(toastRoot);
  }
  return toastRoot;
}

function show(type, msg, ms) {
  const icon = type === 'success' ? '✔' : type === 'error' ? '✖' : 'ℹ';
  const t = el('div', { class: `toast ${type}`, onClick: () => t.remove() },
    el('span', { class: 't-icon' }, icon),
    el('span', {}, String(msg)));
  root().append(t);
  setTimeout(() => t.remove(), ms || (type === 'error' ? 9000 : 3500));
}

export const toast = {
  info: (m, ms) => show('info', m, ms),
  success: (m, ms) => show('success', m, ms),
  error: (m, ms) => show('error', m, ms),
};

/** 通用模态框。返回 {close, body, overlay} */
export function openModal({ title, body, buttons = [], width, onClose }) {
  const closeAll = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); if (onClose) onClose(); };
  const head = el('div', { class: 'modal-head' },
    el('span', {}, title),
    el('button', { class: 'modal-close', title: '关闭', onClick: closeAll }, '✕'));
  const bodyEl = el('div', { class: 'modal-body' }, body);
  const foot = buttons.length
    ? el('div', { class: 'modal-foot' },
        el('span', { class: 'spring' }),
        ...buttons.map((b) =>
          el('button', {
            class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''),
            onClick: () => { const r = b.onClick ? b.onClick() : undefined; if (r !== false) closeAll(); },
          }, b.label)))
    : null;
  const modal = el('div', { class: 'modal', style: width ? { width: width + 'px' } : {} }, head, bodyEl, foot);
  const overlay = el('div', { class: 'modal-overlay', onMousedown: (e) => { if (e.target === overlay) closeAll(); } }, modal);
  const escHandler = (e) => { if (e.key === 'Escape') closeAll(); };
  document.addEventListener('keydown', escHandler);
  document.body.append(overlay);
  return { close: closeAll, body: bodyEl, overlay };
}

/** 确认框，resolve(true/false) */
export function confirmDialog(title, message, { danger = false, okLabel = '确定' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title,
      body: el('div', { style: { maxWidth: '420px', lineHeight: '1.6', whiteSpace: 'pre-wrap' } }, message),
      buttons: [
        { label: '取消', onClick: () => { done = true; resolve(false); } },
        { label: okLabel, primary: !danger, danger, onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
    return m;
  });
}

/** 输入框，resolve(string|null) */
export function promptDialog(title, label, initial = '') {
  return new Promise((resolve) => {
    let done = false;
    const input = el('input', { type: 'text', value: initial, spellcheck: false,
      style: { width: '320px', padding: '7px 10px', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '13px', outline: 'none' } });
    const ok = () => { done = true; resolve(input.value.trim() || null); m.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    const m = openModal({
      title,
      body: el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, el('label', {}, label), input),
      buttons: [
        { label: '取消', onClick: () => { done = true; resolve(null); } },
        { label: '确定', primary: true, onClick: () => { done = true; resolve(input.value.trim() || null); } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

/** 单元格查看器 */
export function cellViewer(colName, value) {
  const text = cellText(value);
  openModal({
    title: `单元格查看器 — ${colName}`,
    body: el('div', {},
      el('div', { class: 'viewer-text' }, value === null ? '(NULL)' : text),
      el('div', { style: { marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' } },
        value === null ? 'NULL' : `${text.length} 个字符`)),
    buttons: [
      { label: '复制', onClick: () => { navigator.clipboard.writeText(text); toast.success('已复制'); return false; } },
      { label: '关闭', primary: true },
    ],
  });
}
