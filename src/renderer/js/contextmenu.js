// 右键菜单
import { el, icons } from './util.js';

let current = null;
let openSubmenu = null;
let openSubmenuOwner = null;

export function closeMenu() {
  if (current) current.remove();
  current = null;
  openSubmenu = null;
  openSubmenuOwner = null;
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

function closeSubmenu() {
  if (openSubmenu) openSubmenu.remove();
  openSubmenu = null;
  openSubmenuOwner = null;
}

function positionMenu(menu, x, y) {
  const rect = menu.getBoundingClientRect();
  let px = x;
  let py = y;
  if (px + rect.width > window.innerWidth - 6) px = window.innerWidth - rect.width - 6;
  if (py + rect.height > window.innerHeight - 6) py = window.innerHeight - rect.height - 6;
  menu.style.left = Math.max(6, px) + 'px';
  menu.style.top = Math.max(6, py) + 'px';
}

function openSubmenuFor(owner, items) {
  if (!current || !Array.isArray(items) || !items.length) return;
  if (openSubmenuOwner === owner) return;
  const ownerRect = owner.getBoundingClientRect();
  closeSubmenu();
  const submenu = createMenu(items);
  current.append(submenu);
  const menuRect = submenu.getBoundingClientRect();
  const gap = 3;
  let x = ownerRect.right + gap;
  if (x + menuRect.width > window.innerWidth - 6) x = ownerRect.left - menuRect.width - gap;
  let y = ownerRect.top;
  if (y + menuRect.height > window.innerHeight - 6) y = window.innerHeight - menuRect.height - 6;
  submenu.style.left = Math.max(6, x) + 'px';
  submenu.style.top = Math.max(6, y) + 'px';
  openSubmenu = submenu;
  openSubmenuOwner = owner;
}

function createMenu(items) {
  const hasIcons = items.some((it) => it && !it.sep && it.icon && icons[it.icon]);
  const menu = el('div', { class: 'ctx-menu' + (hasIcons ? ' has-icons' : '') });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { menu.append(el('div', { class: 'ctx-sep' })); continue; }
    const hasSubmenu = Array.isArray(it.submenu) && it.submenu.length > 0;
    const item = el('div', {
      class: 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '') + (hasSubmenu ? ' has-submenu' : ''),
      onClick: (e) => {
        e.stopPropagation();
        if (it.disabled) return;
        if (hasSubmenu) { openSubmenuFor(item, it.submenu); return; }
        closeMenu();
        if (it.onClick) it.onClick();
      },
      onMouseEnter: () => {
        if (hasSubmenu) openSubmenuFor(item, it.submenu);
        else if (openSubmenuOwner && openSubmenuOwner !== item && !(openSubmenu && openSubmenu.contains(item))) closeSubmenu();
      },
    });
    if (hasIcons) {
      const ic = el('span', { class: 'ctx-icon' });
      if (it.icon && icons[it.icon]) ic.innerHTML = icons[it.icon];
      item.append(ic);
    }
    item.append(el('span', { class: 'ctx-label' }, it.label));
    if (hasSubmenu) item.append(el('span', { class: 'ctx-hint ctx-submenu-arrow' }, '›'));
    else if (it.hint) item.append(el('span', { class: 'ctx-hint' }, it.hint));
    menu.append(item);
  }
  return menu;
}

/**
 * items: [{label, icon, danger, disabled, hint, submenu, onClick} | {sep:true}]
 * submenu 会在鼠标悬停或点击时从当前菜单右侧展开，不会关闭主菜单。
 */
export function showMenu(x, y, items) {
  closeMenu();
  const menu = createMenu(items);
  document.body.append(menu);
  positionMenu(menu, x, y);
  current = menu;
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
  }, 0);
}
