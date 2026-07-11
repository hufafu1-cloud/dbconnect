// 右键菜单
import { el, icons } from './util.js';

let current = null;

export function closeMenu() {
  if (current) { current.remove(); current = null; }
  document.removeEventListener('mousedown', onDocDown, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', closeMenu);
}

function onDocDown(e) {
  if (current && !current.contains(e.target)) closeMenu();
}
function onKey(e) {
  if (e.key === 'Escape') closeMenu();
}

/**
 * items: [{label, icon, danger, disabled, onClick} | {sep:true}]
 */
export function showMenu(x, y, items) {
  closeMenu();
  const hasIcons = items.some((it) => it && !it.sep && it.icon && icons[it.icon]);
  const menu = el('div', { class: 'ctx-menu' + (hasIcons ? ' has-icons' : '') });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { menu.append(el('div', { class: 'ctx-sep' })); continue; }
    const item = el('div', {
      class: 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''),
      onClick: () => {
        if (it.disabled) return;
        closeMenu();
        if (it.onClick) it.onClick();
      },
    });
    if (hasIcons) {
      const ic = el('span', { class: 'ctx-icon' });
      if (it.icon && icons[it.icon]) ic.innerHTML = icons[it.icon];
      item.append(ic);
    }
    item.append(el('span', { class: 'ctx-label' }, it.label));
    if (it.hint) item.append(el('span', { class: 'ctx-hint' }, it.hint));
    menu.append(item);
  }
  document.body.append(menu);
  // 防溢出
  const rect = menu.getBoundingClientRect();
  let px = x, py = y;
  if (px + rect.width > window.innerWidth - 6) px = window.innerWidth - rect.width - 6;
  if (py + rect.height > window.innerHeight - 6) py = window.innerHeight - rect.height - 6;
  menu.style.left = px + 'px';
  menu.style.top = py + 'px';
  current = menu;
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
  }, 0);
}
