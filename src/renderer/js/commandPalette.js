// 命令面板：Ctrl+P 跳表、Ctrl+Shift+P 跑命令。
//
// 命令那一半几乎是白送的——命令注册表里已经有名字、快捷键和可用状态，
// 这里只是把它过滤出来显示。对象那一半搜的是**已经加载过**的表/视图
// （目录树展开过的库），不会为了搜索去连库拉元数据。
import { el, iconEl } from './util.js';
import { t } from './i18n.js';
import { state, objectsCacheKey, connLabel } from './state.js';
import { allCommands, isEnabled, accelHint, runCommand } from './commands.js';

const MAX_RESULTS = 50;

/**
 * 子序列模糊匹配，返回分数（越大越好），不匹配返回 -1。
 * 连续命中和词首命中加权，让 "ordit" 能排在 "orders" 前面这类直觉结果上。
 */
function fuzzyScore(text, query) {
  if (!query) return 0;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const direct = lowerText.indexOf(lowerQuery);
  if (direct >= 0) return 1000 - direct * 2 + (direct === 0 ? 200 : 0);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of lowerQuery) {
    const hit = lowerText.indexOf(ch, ti);
    if (hit < 0) return -1;
    streak = hit === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - Math.min(hit - ti, 10);
    ti = hit + 1;
  }
  return score;
}

/** 已加载过的表/视图（不触发任何网络请求） */
function collectObjects() {
  const items = [];
  for (const [connId, opened] of state.open) {
    const cache = opened && opened.objectsCache;
    if (!cache) continue;
    for (const [key, objs] of cache) {
      if (!objs) continue;
      const [db, schema] = key.split('|');
      const push = (name, kind) => items.push({
        kind,
        name,
        connId,
        db: db || null,
        schema: schema || null,
        label: name,
        detail: [connLabel(connId), db, schema].filter(Boolean).join(' / '),
      });
      for (const item of objs.tables || []) push(item.name, 'table');
      for (const item of objs.views || []) push(item.name, 'view');
    }
  }
  return items;
}

function commandItems() {
  return allCommands()
    .filter((cmd) => cmd.label && typeof cmd.run === 'function')
    .map((cmd) => ({
      kind: 'command',
      id: cmd.id,
      label: cmd.label,
      detail: cmd.menu || '',
      hint: accelHint(cmd),
      disabled: !isEnabled(cmd),
    }));
}

let openPalette = null;

export function closeCommandPalette() {
  if (openPalette) openPalette.close();
}

/** mode: 'object' | 'command' */
export function openCommandPalette(mode = 'object') {
  closeCommandPalette();

  let items = [];
  let active = 0;
  let currentMode = mode;

  const input = el('input', {
    class: 'palette-input',
    type: 'text',
    spellcheck: false,
    placeholder: mode === 'command'
      ? t('输入命令名称…')
      : t('输入表名跳转；输入 > 切换到命令'),
  });
  const list = el('div', { class: 'palette-list' });
  const empty = el('div', { class: 'palette-empty' });
  const panel = el('div', { class: 'palette' }, input, list, empty);
  const overlay = el('div', {
    class: 'palette-overlay',
    onMousedown: (e) => { if (e.target === overlay) close(); },
  }, panel);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    openPalette = null;
  }

  async function accept(item) {
    if (!item) return;
    close();
    if (item.kind === 'command') {
      await runCommand(item.id);
      return;
    }
    const { openTableTab } = await import('./tableTab.js');
    openTableTab({ connId: item.connId, db: item.db, schema: item.schema, table: item.name });
  }

  function renderList() {
    list.replaceChildren();
    items.forEach((item, index) => {
      const row = el('div', {
        class: 'palette-item' + (index === active ? ' active' : '') + (item.disabled ? ' disabled' : ''),
        onMouseenter: () => { active = index; markActive(); },
        onClick: () => accept(item),
      },
        iconEl(item.kind === 'command' ? 'run' : (item.kind === 'view' ? 'view' : 'table')),
        el('span', { class: 'palette-label' }, item.label),
        el('span', { class: 'palette-detail' }, item.detail || ''),
        item.hint ? el('span', { class: 'palette-hint' }, item.hint) : null);
      list.append(row);
    });
    const noResult = !items.length;
    empty.style.display = noResult ? '' : 'none';
    empty.textContent = currentMode === 'command'
      ? t('没有匹配的命令')
      : t('没有匹配的表。只搜索已经展开过的数据库。');
    markActive();
  }

  function markActive() {
    [...list.children].forEach((node, index) => node.classList.toggle('active', index === active));
    const node = list.children[active];
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  function refresh() {
    const raw = input.value;
    currentMode = raw.startsWith('>') ? 'command' : mode;
    const query = raw.startsWith('>') ? raw.slice(1).trim() : raw.trim();
    const pool = currentMode === 'command' ? commandItems() : collectObjects();
    items = pool
      .map((item) => ({ item, score: fuzzyScore(`${item.label} ${item.detail}`, query) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
      .slice(0, MAX_RESULTS)
      .map((entry) => entry.item);
    active = 0;
    renderList();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); markActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); markActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); accept(items[active]); }
  }

  input.addEventListener('input', refresh);
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  if (mode === 'command') input.value = '>';
  refresh();
  input.focus();
  openPalette = { close };
  return { close };
}
