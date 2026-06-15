// 应用内自绘菜单栏（替代原生菜单：可控间距、跟随主题、截图可见）
import { $, el } from './util.js';
import { showMenu, closeMenu } from './contextmenu.js';

let openItem = null; // 当前展开的菜单项元素

function exec(cmd) {
  try { document.execCommand(cmd); } catch (e) { /* ignore */ }
}

/** runAction: app.js 提供的动作分发函数 */
export function buildMenuBar(runAction) {
  const MENUS = [
    ['文件', () => [
      { label: '新建连接…', hint: 'Ctrl+N', onClick: () => runAction('new-conn') },
      { label: '新建查询', hint: 'Ctrl+Q', onClick: () => runAction('new-query') },
      { sep: true },
      { label: '运行 SQL 文件…', onClick: () => runAction('run-sql-file') },
      { sep: true },
      { label: '退出', onClick: () => window.api.app.winCmd('close') },
    ]],
    ['编辑', () => [
      { label: '撤销', hint: 'Ctrl+Z', onClick: () => exec('undo') },
      { label: '重做', hint: 'Ctrl+Y', onClick: () => exec('redo') },
      { sep: true },
      { label: '剪切', hint: 'Ctrl+X', onClick: () => exec('cut') },
      { label: '复制', hint: 'Ctrl+C', onClick: () => exec('copy') },
      { label: '粘贴', hint: 'Ctrl+V', onClick: () => exec('paste') },
      { label: '全选', hint: 'Ctrl+A', onClick: () => exec('selectAll') },
    ]],
    ['查看', () => [
      { label: '刷新当前库对象', onClick: () => runAction('refresh') },
      { label: '切换浅色 / 深色主题', hint: 'Ctrl+D', onClick: () => runAction('toggle-theme') },
      { sep: true },
      { label: '开发者工具', hint: 'F12', onClick: () => window.api.app.winCmd('devtools') },
    ]],
    ['工具', () => [
      { label: '在库中查找…', hint: 'Ctrl+F', onClick: () => runAction('search') },
      { sep: true },
      { label: '数据传输…', onClick: () => runAction('transfer') },
      { label: '结构同步 / 数据同步…', onClick: () => runAction('sync') },
      { sep: true },
      { label: '导入向导…', onClick: () => runAction('import') },
      { label: '转储 SQL 文件…', onClick: () => runAction('dump') },
      { sep: true },
      { label: '查询历史', onClick: () => runAction('history') },
      { label: '进程列表', onClick: () => runAction('processes') },
    ]],
    ['窗口', () => [
      { label: '最小化', onClick: () => window.api.app.winCmd('minimize') },
      { label: '最大化 / 还原', onClick: () => window.api.app.winCmd('maximize') },
      { sep: true },
      { label: '关闭窗口', onClick: () => window.api.app.winCmd('close') },
    ]],
    ['帮助', () => [
      { label: 'GitHub 仓库', onClick: () => window.api.app.openExternal('https://github.com/hufafu1-cloud/dbconnect') },
      { sep: true },
      { label: '关于 Datavia', onClick: () => runAction('about') },
    ]],
  ];

  const bar = $('#menubar');
  bar.innerHTML = '';
  // 品牌标识
  bar.append(el('div', { class: 'menu-brand', title: 'Datavia · 数据之道' }, 'Datavia'));

  const openFor = (item, build) => {
    if (openItem) openItem.classList.remove('open');
    openItem = item;
    item.classList.add('open');
    const r = item.getBoundingClientRect();
    showMenu(r.left, r.bottom + 2, build().map((m) => ({
      ...m,
      onClick: m.onClick && (() => { clearOpen(); m.onClick(); }),
    })));
  };
  const clearOpen = () => {
    if (openItem) { openItem.classList.remove('open'); openItem = null; }
  };

  for (const [label, build] of MENUS) {
    const item = el('div', { class: 'menu-item' }, label);
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (openItem === item) { clearOpen(); closeMenu(); return; }
      openFor(item, build);
    });
    // 已展开时滑过其它菜单自动切换（Windows 菜单习惯）
    item.addEventListener('mouseenter', () => {
      if (openItem && openItem !== item) openFor(item, build);
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
