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
      body: el('div', { class: danger ? 'risk-confirm-body' : 'confirm-body' },
        danger ? el('div', { class: 'risk-confirm-kicker' }, '请确认操作影响') : null,
        el('div', { class: 'risk-confirm-message' }, message)),
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

/** 密码补输框：保留首尾空格，resolve(string|null)，明文只通过本次 IPC 提交。 */
export function passwordDialog(title, message) {
  return new Promise((resolve) => {
    let done = false;
    const input = el('input', { type: 'password', spellcheck: false, autocomplete: 'off' });
    const show = el('button', {
      class: 'btn', tabIndex: -1,
      onClick: () => { input.type = input.type === 'password' ? 'text' : 'password'; return false; },
    }, '👁');
    const submit = () => { done = true; resolve(input.value); m.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const m = openModal({
      title,
      body: el('div', { class: 'password-prompt' },
        el('div', { class: 'password-prompt-message' }, message),
        el('div', { class: 'row-flex' }, input, show)),
      buttons: [
        { label: '取消', onClick: () => { done = true; resolve(null); } },
        { label: '连接', primary: true, onClick: () => { done = true; resolve(input.value); } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    setTimeout(() => input.focus(), 30);
  });
}

/** 单元格查看器 */
function imageMime(buf) {
  if (buf.length < 4) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return null;
}

function hexDump(buf, maxBytes) {
  const n = Math.min(buf.length, maxBytes);
  const lines = [];
  for (let off = 0; off < n; off += 16) {
    const slice = buf.subarray(off, Math.min(off + 16, n));
    const hex = [...slice].map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = [...slice].map((x) => (x >= 32 && x < 127) ? String.fromCharCode(x) : '.').join('');
    lines.push(off.toString(16).padStart(8, '0') + '  ' + hex + '  ' + ascii);
  }
  if (buf.length > n) lines.push(`… 共 ${buf.length} 字节，仅显示前 ${n} 字节`);
  return lines.join('\n');
}

/** value 普通值；blobCtx={connId,db,schema,table,column,pk} 时支持取完整 BLOB 做图片/十六进制查看 */
export function cellViewer(colName, value, blobCtx) {
  const isBlob = value && typeof value === 'object' && value.__blob;
  if (isBlob && blobCtx) {
    const bodyWrap = el('div', { style: { minWidth: '560px' } }, el('div', { style: { color: 'var(--text-muted)' } }, '正在加载完整内容…'));
    let curText = '';
    const m = openModal({
      title: `单元格查看器 — ${colName}（BLOB ${value.length} 字节）`,
      body: bodyWrap,
      buttons: [
        { label: '复制十六进制', onClick: () => { navigator.clipboard.writeText(curText); toast.success('已复制'); return false; } },
        { label: '关闭', primary: true },
      ],
    });
    window.api.db.cellBlob(blobCtx.connId, { db: blobCtx.db, schema: blobCtx.schema, table: blobCtx.table, column: blobCtx.column, pk: blobCtx.pk })
      .then((res) => {
        bodyWrap.innerHTML = '';
        if (!res) { bodyWrap.append(el('div', {}, '(NULL)')); return; }
        const buf = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
        const mime = imageMime(buf);
        curText = hexDump(buf, 64 * 1024);
        if (mime) {
          const blob = new Blob([buf], { type: mime });
          const url = URL.createObjectURL(blob);
          bodyWrap.append(
            el('div', { style: { marginBottom: '8px', fontSize: '12px', color: 'var(--text-muted)' } }, `图片 ${mime} · ${res.length} 字节${res.truncated ? '（已截断）' : ''}`),
            el('img', { src: url, style: { maxWidth: '70vw', maxHeight: '60vh', border: '1px solid var(--border-light)', borderRadius: '6px' } }));
        } else {
          bodyWrap.append(
            el('div', { style: { marginBottom: '6px', fontSize: '12px', color: 'var(--text-muted)' } }, `二进制内容 · ${res.length} 字节${res.truncated ? '（已截断）' : ''}`),
            el('div', { class: 'viewer-text', style: { fontSize: '11.5px', whiteSpace: 'pre' } }, curText));
        }
      })
      .catch((e) => { bodyWrap.innerHTML = ''; bodyWrap.append(el('div', { style: { color: 'var(--danger)' } }, '加载失败: ' + e.message)); });
    return m;
  }

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
