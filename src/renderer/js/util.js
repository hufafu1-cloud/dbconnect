// 通用工具与图标
export const $ = (sel, root) => (root || document).querySelector(sel);

/** 创建元素：el('div', {class:'x', onClick:fn, title:'t'}, child1, child2…) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k in node && k !== 'type' && k !== 'value') { try { node[k] = v; } catch (e) { node.setAttribute(k, v); } }
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtCount(n) {
  if (n === null || n === undefined) return '-';
  return Number(n).toLocaleString('zh-CN');
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

const svg = (body, viewBox = '0 0 16 16') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none">${body}</svg>`;

const cylinder = (color) => svg(
  `<ellipse cx="8" cy="3.6" rx="5.6" ry="2.3" fill="${color}"/>
   <path d="M2.4 3.6v8.8c0 1.27 2.5 2.3 5.6 2.3s5.6-1.03 5.6-2.3V3.6" stroke="${color}" stroke-width="1.6" fill="none"/>
   <path d="M2.4 8c0 1.27 2.5 2.3 5.6 2.3S13.6 9.27 13.6 8" stroke="${color}" stroke-width="1.3" fill="none"/>`
);

export const icons = {
  // 连接类型（每种数据库一种鲜明品牌色，便于区分）
  mysql: cylinder('#1f77b4'),       // 蓝 — MySQL/MariaDB
  postgres: cylinder('#34495e'),    // 深蓝灰 — PostgreSQL
  sqlite: cylinder('#17a2b8'),      // 青 — SQLite
  mssql: cylinder('#c0392b'),       // 红 — SQL Server
  clickhouse: cylinder('#e0a800'),  // 金黄 — ClickHouse
  oceanbase: cylinder('#16a34a'),   // 绿 — OceanBase (MySQL)
  oboracle: cylinder('#ea580c'),    // 橙 — OceanBase (Oracle)
  connection: cylinder('#5b6470'),
  database: svg(`<ellipse cx="8" cy="3.8" rx="5.4" ry="2.2" fill="#3fa34d"/>
    <path d="M2.6 3.8v8.4c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2V3.8" stroke="#3fa34d" stroke-width="1.6"/>
    <path d="M2.6 8c0 1.2 2.4 2.2 5.4 2.2S13.4 9.2 13.4 8" stroke="#3fa34d" stroke-width="1.2"/>`),
  schema: svg(`<rect x="5.4" y="1.6" width="5.2" height="3.8" rx="0.9" fill="#7c5cd6"/>
    <path d="M8 5.4v1.6M3.6 8.6V7h8.8v1.6" stroke="#7c5cd6" stroke-width="1.3" fill="none"/>
    <rect x="1" y="9" width="5.2" height="3.8" rx="0.9" fill="#9b7ee0"/>
    <rect x="9.8" y="9" width="5.2" height="3.8" rx="0.9" fill="#9b7ee0"/>`),
  folder: svg(`<path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3.2l1.5 1.6h5.3c.7 0 1.2.5 1.2 1.2v6.4c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.2z" fill="#f6c244"/>`),
  table: svg(`<rect x="1.8" y="2.5" width="12.4" height="11" rx="1.2" stroke="#2b7de9" stroke-width="1.4"/>
    <path d="M1.8 6h12.4M6 6v7.5M10.2 6v7.5" stroke="#2b7de9" stroke-width="1.2"/>
    <rect x="1.8" y="2.5" width="12.4" height="3.5" rx="1.2" fill="#2b7de9" opacity="0.25"/>`),
  view: svg(`<path d="M1.5 8s2.4-4.4 6.5-4.4S14.5 8 14.5 8s-2.4 4.4-6.5 4.4S1.5 8 1.5 8z" stroke="#7c5cd6" stroke-width="1.4"/>
    <circle cx="8" cy="8" r="2.1" fill="#7c5cd6"/>`),
  query: svg(`<rect x="2.2" y="1.8" width="11.6" height="12.4" rx="1.4" stroke="#1a9e57" stroke-width="1.4"/>
    <path d="M5 5.5l2.2 2.3L5 10M8.3 10.4h3" stroke="#1a9e57" stroke-width="1.4" stroke-linecap="round"/>`),
  objects: svg(`<rect x="2" y="2.4" width="5.2" height="5.2" rx="1" fill="#2b7de9" opacity=".75"/>
    <rect x="8.8" y="2.4" width="5.2" height="5.2" rx="1" fill="#2b7de9" opacity=".35"/>
    <rect x="2" y="8.4" width="5.2" height="5.2" rx="1" fill="#2b7de9" opacity=".35"/>
    <rect x="8.8" y="8.4" width="5.2" height="5.2" rx="1" fill="#2b7de9" opacity=".75"/>`),
  struct: svg(`<rect x="2" y="2" width="12" height="3.4" rx="1" fill="#d97706" opacity=".8"/>
    <rect x="2" y="6.4" width="12" height="3.4" rx="1" fill="#d97706" opacity=".5"/>
    <rect x="2" y="10.8" width="12" height="3.4" rx="1" fill="#d97706" opacity=".3"/>`),
  run: svg(`<path d="M4.5 2.8l8 5.2-8 5.2V2.8z" fill="#1a9e57"/>`),
  runSel: svg(`<path d="M3.5 2.8l7 4.7-7 4.7V2.8z" fill="#1a9e57"/><rect x="11.5" y="3" width="2" height="9" rx="0.6" fill="#1a9e57" opacity=".6"/>`),
  stop: svg(`<rect x="3.5" y="3.5" width="9" height="9" rx="1.4" fill="#d93026"/>`),
  refresh: svg(`<path d="M13.2 6.4A5.5 5.5 0 1 0 13.9 9" stroke="#2b7de9" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M13.6 2.6v3.8H9.8" stroke="#2b7de9" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`),
  plus: svg(`<path d="M8 3v10M3 8h10" stroke="#1a9e57" stroke-width="1.8" stroke-linecap="round"/>`),
  minus: svg(`<path d="M3 8h10" stroke="#d93026" stroke-width="1.8" stroke-linecap="round"/>`),
  check: svg(`<path d="M2.8 8.6l3.4 3.4 7-7.8" stroke="#1a9e57" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
  cross: svg(`<path d="M4 4l8 8M12 4l-8 8" stroke="#d93026" stroke-width="1.8" stroke-linecap="round"/>`),
  edit: svg(`<path d="M9.8 3.2l3 3L6 13H3v-3l6.8-6.8z" stroke="#2b7de9" stroke-width="1.4" stroke-linejoin="round"/>`),
  trash: svg(`<path d="M3 4.5h10M6.5 4V2.8h3V4M4.4 4.5l.7 9h5.8l.7-9" stroke="#d93026" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`),
  exportIcon: svg(`<path d="M8 2.5v7.5M5 7l3 3 3-3" stroke="#2b7de9" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M2.8 11v2.2h10.4V11" stroke="#2b7de9" stroke-width="1.6" stroke-linecap="round"/>`),
  importIcon: svg(`<path d="M8 10V2.5M5 5.5l3-3 3 3" stroke="#1a9e57" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M2.8 11v2.2h10.4V11" stroke="#1a9e57" stroke-width="1.6" stroke-linecap="round"/>`),
  openFile: svg(`<path d="M2 12.5V4c0-.6.4-1 1-1h3l1.4 1.5H13c.6 0 1 .4 1 1V7" stroke="#d97706" stroke-width="1.4"/>
    <path d="M2 12.5L4 7.5h11l-2.2 5H2z" fill="#f6c244"/>`),
  save: svg(`<path d="M2.5 3.5c0-.6.4-1 1-1h7.6l2.4 2.4v8.6c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1V3.5z" stroke="#2b7de9" stroke-width="1.4"/>
    <rect x="5" y="9" width="6" height="4" fill="#2b7de9" opacity=".4"/><rect x="5" y="2.8" width="5" height="3" fill="#2b7de9" opacity=".4"/>`),
  filter: svg(`<path d="M2.5 3h11L9.6 8.4v4.2l-3.2 1.6V8.4L2.5 3z" stroke="#5b6470" stroke-width="1.4" stroke-linejoin="round"/>`),
  link: svg(`<path d="M6.5 9.5l3-3" stroke="#2b7de9" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M7.6 4.4l1.2-1.2a2.7 2.7 0 0 1 3.9 3.9L11.5 8.3M8.4 11.6l-1.2 1.2a2.7 2.7 0 0 1-3.9-3.9l1.2-1.2" stroke="#2b7de9" stroke-width="1.5" stroke-linecap="round"/>`),
  unlink: svg(`<path d="M7.6 4.4l1.2-1.2a2.7 2.7 0 0 1 3.9 3.9L11.5 8.3M8.4 11.6l-1.2 1.2a2.7 2.7 0 0 1-3.9-3.9l1.2-1.2" stroke="#9aa3af" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M3 3l10 10" stroke="#d93026" stroke-width="1.5" stroke-linecap="round"/>`),
  info: svg(`<circle cx="8" cy="8" r="6.2" stroke="#2b7de9" stroke-width="1.4"/>
    <path d="M8 7.2v4M8 4.6v.2" stroke="#2b7de9" stroke-width="1.6" stroke-linecap="round"/>`),
  copy: svg(`<rect x="5.5" y="5.5" width="8" height="8" rx="1.2" stroke="#5b6470" stroke-width="1.4"/>
    <path d="M3.5 10.5h-1v-8h8v1" stroke="#5b6470" stroke-width="1.4"/>`),
  rename: svg(`<path d="M2 12h12" stroke="#5b6470" stroke-width="1.3"/><path d="M9 2.8l2.6 2.6L6 11H3.4V8.4L9 2.8z" stroke="#5b6470" stroke-width="1.3" stroke-linejoin="round"/>`),
  history: svg(`<path d="M8 1.8a6.2 6.2 0 1 1-5.9 4.3" stroke="#2b7de9" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M2 2.4v3.7h3.7" stroke="#2b7de9" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M8 4.8V8l2.6 1.6" stroke="#2b7de9" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`),
  func: svg(`<path d="M10.5 2.2c-1.6 0-2.2.9-2.4 2.3L7.2 11c-.2 1.5-.9 2.7-2.6 2.7" stroke="#7c5cd6" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M4.6 6h5M9.6 9.6l3.4 3.4M13 9.6l-3.4 3.4" stroke="#7c5cd6" stroke-width="1.4" stroke-linecap="round"/>`),
  trigger: svg(`<path d="M8.8 1.6L3.6 9h3.2l-1 5.4L11.4 7H8.2l.6-5.4z" fill="#d97706"/>`),
  eventIcon: svg(`<circle cx="8" cy="8.6" r="5.2" stroke="#1a9e57" stroke-width="1.4" fill="none"/>
    <path d="M8 5.8v2.8l2 1.3M5.2 1.8L2.6 3.8M10.8 1.8l2.6 2" stroke="#1a9e57" stroke-width="1.4" stroke-linecap="round" fill="none"/>`),
  sequence: svg(`<path d="M2.4 4.6l1.6-1v4.6M7 4.4c0-.7.6-1.2 1.3-1.2s1.3.5 1.3 1.2c0 1.4-2.6 2.3-2.6 3.8h2.8" stroke="#0f80cc" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M2.5 11h11M11 8.6l2.6 2.4L11 13.4" stroke="#0f80cc" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`),
  user: svg(`<circle cx="8" cy="5.2" r="2.8" stroke="#5b6470" stroke-width="1.4" fill="none"/>
    <path d="M2.8 13.6c.6-2.6 2.7-4 5.2-4s4.6 1.4 5.2 4" stroke="#5b6470" stroke-width="1.4" stroke-linecap="round" fill="none"/>`),
  transfer: svg(`<path d="M2.5 5.4h9M9 2.6l2.8 2.8L9 8.2" stroke="#2b7de9" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M13.5 10.6h-9M7 7.8l-2.8 2.8L7 13.4" stroke="#1a9e57" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`),
  monitor: svg(`<path d="M2.2 12.8a6 6 0 1 1 11.6 0" stroke="#2b7de9" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M8 12.8l3-4.4" stroke="#d93026" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="8" cy="12.6" r="1.1" fill="#d93026"/>`),
  theme: svg(`<circle cx="8" cy="8" r="5.6" stroke="#5b6470" stroke-width="1.4" fill="none"/>
    <path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="#5b6470"/>`),
  explain: svg(`<circle cx="6.4" cy="3.4" r="1.8" fill="#1a9e57"/><circle cx="3.4" cy="9.4" r="1.8" fill="#2b7de9"/><circle cx="10" cy="9.4" r="1.8" fill="#d97706"/><circle cx="12.4" cy="13.4" r="1.5" fill="#7c5cd6"/>
    <path d="M6 5l-2 2.8M6.8 5l2.6 2.8M10.6 11l1.4 1.4" stroke="#9aa3af" stroke-width="1.2"/>`),
  er: svg(`<rect x="1.6" y="2" width="5" height="4" rx="0.8" stroke="#2b7de9" stroke-width="1.2" fill="none"/>
    <rect x="9.4" y="3.4" width="5" height="4" rx="0.8" stroke="#1a9e57" stroke-width="1.2" fill="none"/>
    <rect x="5.4" y="10" width="5" height="4" rx="0.8" stroke="#d97706" stroke-width="1.2" fill="none"/>
    <path d="M6.6 4.6h2.8M9 6.2L7.6 10M6.6 5.6L6 10" stroke="#9aa3af" stroke-width="1"/>`),
  format: svg(`<path d="M2.5 3h11M2.5 6.2h7M5.5 9.4h8M5.5 12.6h5" stroke="#7c5cd6" stroke-width="1.6" stroke-linecap="round"/>`),
};

export function iconEl(name, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.style.display = 'inline-flex';
  span.innerHTML = icons[name] || icons.table;
  return span;
}

/** 显示单元格值（HTML 字符串）*/
export function renderCellValue(v) {
  if (v === null || v === undefined) return '<span class="v-null">NULL</span>';
  if (typeof v === 'object' && v.__blob) return `<span class="v-blob">(BLOB ${fmtBytes(v.length)})</span>`;
  let s = String(v);
  if (s.length > 300) s = s.slice(0, 300) + '…';
  return escapeHtml(s).replace(/\r?\n/g, '↵');
}

/** 把单元格值变成纯文本（复制 / 查看器用）*/
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.__blob) return '0x' + v.hex + (v.length > 256 ? '…' : '');
  return String(v);
}
