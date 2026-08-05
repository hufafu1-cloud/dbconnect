// 应用内自绘菜单栏（替代原生菜单：可控间距、跟随主题、截图可见）
//
// 菜单内容完全由命令注册表（commands.js）生成：新增一个功能只要登记命令，
// 菜单项、快捷键提示和可用状态就自动出现，不需要再来这里手写一遍。
import { $, el } from './util.js';
import { showMenu, closeMenu } from './contextmenu.js';
import { menuNames, commandsForMenu, isEnabled, accelHint, runCommand } from './commands.js';

let openItem = null; // 当前展开的菜单项元素

function buildItems(menuName) {
  const items = [];
  for (const cmd of commandsForMenu(menuName)) {
    if (cmd.sepBefore && items.length) items.push({ sep: true });
    items.push({
      label: cmd.label,
      hint: accelHint(cmd),
      disabled: !isEnabled(cmd),
      onClick: () => runCommand(cmd.id),
    });
  }
  return items;
}

export function buildMenuBar() {
  const bar = $('#menubar');
  bar.innerHTML = '';

  const openFor = (item, menuName) => {
    if (openItem) openItem.classList.remove('open');
    openItem = item;
    item.classList.add('open');
    const r = item.getBoundingClientRect();
    // 每次展开都重新计算可用状态，菜单不会停留在打开前的旧状态
    showMenu(r.left, r.bottom + 2, buildItems(menuName).map((m) => ({
      ...m,
      onClick: m.onClick && (() => { clearOpen(); m.onClick(); }),
    })));
  };
  const clearOpen = () => {
    if (openItem) { openItem.classList.remove('open'); openItem = null; }
  };

  for (const name of menuNames()) {
    const item = el('div', { class: 'menu-item' }, name);
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (openItem === item) { clearOpen(); closeMenu(); return; }
      openFor(item, name);
    });
    // 已展开时滑过其它菜单自动切换（Windows 菜单习惯）
    item.addEventListener('mouseenter', () => {
      if (openItem && openItem !== item) openFor(item, name);
    });
    bar.append(item);
  }

  // 菜单关闭时（点击空白/Esc）清理高亮
  document.addEventListener('mousedown', (e) => {
    if (openItem && !bar.contains(e.target) && !e.target.closest('.ctx-menu')) clearOpen();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearOpen();
  }, true);
}
