import { el, iconEl } from './util.js';
import { openModal } from './toast.js';
import { state } from './state.js';
import { openConnectionById, revealTarget } from './tree.js';
import { addRecent } from './preferences.js';
import * as actions from './actions.js';

function searchableItems() {
  const out = [];
  for (const conn of state.connections) out.push({ type: 'connection', icon: 'connection', title: conn.name || conn.host || '未命名连接', subtitle: conn.type, target: { connId: conn.id } });
  for (const [connId, opened] of state.open) {
    for (const db of opened.databases || []) out.push({ type: 'database', icon: 'database', title: db, subtitle: (state.connections.find((c) => c.id === connId) || {}).name || '', target: { connId, db } });
    for (const [key, grouped] of (opened.objectsCache || new Map())) {
      const [db, schema] = String(key).split('|');
      for (const [kind, values] of Object.entries(grouped || {})) {
        for (const value of values || []) {
          const name = typeof value === 'string' ? value : value.name;
          if (!name) continue;
          out.push({ type: kind, icon: kind === 'views' ? 'view' : kind === 'tables' ? 'table' : 'objects', title: name,
            subtitle: [db, schema, kind === 'tables' ? '表' : kind].filter(Boolean).join(' · '), target: { connId, db, schema: schema || null, table: name, kind } });
        }
      }
    }
  }
  return out;
}
async function openItem(item, close) {
  if (!state.open.has(item.target.connId)) await openConnectionById(item.target.connId);
  if (!state.open.has(item.target.connId)) return;
  if (item.target.db) await revealTarget(item.target).catch(() => false);
  if (item.target.table) actions.openTable(item.target);
  await addRecent(item.target, item.title);
  close();
}
export function openGlobalSearchDialog() {
  const input = el('input', { class: 'global-search-input', placeholder: '搜索已保存连接、当前已打开连接中的数据库、表和对象…', autofocus: true, spellcheck: false });
  const list = el('div', { class: 'global-search-list' });
  let items = searchableItems(); let shown = []; let selected = 0; let modal;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter((x) => !q || `${x.title} ${x.subtitle}`.toLowerCase().includes(q)).slice(0, 100);
    selected = Math.min(selected, Math.max(0, shown.length - 1)); list.innerHTML = '';
    if (!shown.length) { list.append(el('div', { class: 'global-search-empty' }, '没有匹配项。对象搜索会覆盖当前已打开连接；可先打开更多连接。')); return; }
    shown.forEach((item, index) => list.append(el('button', { class: `global-search-item${index === selected ? ' active' : ''}`, onClick: () => openItem(item, () => modal.close()) },
      iconEl(item.icon), el('span', {}, item.title, el('small', {}, item.subtitle || item.type)), el('span', { style: { color: 'var(--text-muted)' } }, item.type === 'connection' ? '连接' : '›'))));
  };
  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, shown.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(0, selected - 1); render(); }
    else if (e.key === 'Enter' && shown[selected]) { e.preventDefault(); openItem(shown[selected], () => modal.close()); }
  });
  modal = openModal({ title: '全局对象搜索', body: el('div', { style: { minWidth: '600px' } }, input, list), buttons: [{ label: '关闭', primary: true }] });
  render(); setTimeout(() => input.focus(), 30); return modal;
}
