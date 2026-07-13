// SQL 编辑器查找 / 替换浮动面板（Navicat / VS Code 风格）
// 依赖 codemirror addon/search/searchcursor.js（cm.getSearchCursor）
import { el } from './util.js';
import { toast } from './toast.js';

const PANELS = new WeakMap(); // cm -> panel controller
const MAX_MATCHES = 100000;

function escapeRe(s) { return s.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&'); }

/** 全文高亮所有匹配（token 类名 searching → .cm-searching） */
function searchOverlay(query) {
  const re = new RegExp(query.source, query.flags.includes('g') ? query.flags : query.flags + 'g');
  return {
    token(stream) {
      re.lastIndex = stream.pos;
      const m = re.exec(stream.string);
      if (m && m.index === stream.pos) {
        stream.pos += m[0].length || 1;
        return 'searching';
      }
      if (m) stream.pos = m.index;
      else stream.skipToEnd();
    },
  };
}

function createPanel(cm) {
  const host = cm.getWrapperElement().parentElement; // .query-editor（position: relative）
  let overlay = null;
  let marker = null;

  const findInput = el('input', { type: 'text', placeholder: '查找', spellcheck: 'false' });
  const replInput = el('input', { type: 'text', placeholder: '替换为', spellcheck: 'false' });
  const countEl = el('span', { class: 'es-count' }, '');
  const btnCase = el('button', { class: 'es-opt', title: '区分大小写' }, 'Aa');
  const btnRe = el('button', { class: 'es-opt', title: '正则表达式' }, '.*');

  const useRegex = () => btnRe.classList.contains('on');

  /** null=空查询；'invalid'=正则语法错误；否则返回非全局 RegExp */
  function buildQuery() {
    const text = findInput.value;
    if (!text) return null;
    const flags = btnCase.classList.contains('on') ? '' : 'i';
    try {
      return new RegExp(useRegex() ? text : escapeRe(text), flags);
    } catch (e) {
      return 'invalid';
    }
  }

  function clearMarks() {
    if (overlay) { cm.removeOverlay(overlay); overlay = null; }
    if (marker) { marker.clear(); marker = null; }
  }

  function countMatches(q) {
    let n = 0;
    const cur = cm.getSearchCursor(q, { line: 0, ch: 0 });
    while (n < MAX_MATCHES && cur.findNext()) n++;
    return n;
  }

  /** 重建高亮与计数（查询词 / 选项变化时调用） */
  function refresh() {
    clearMarks();
    findInput.classList.remove('invalid');
    const q = buildQuery();
    if (!q) { countEl.textContent = ''; return; }
    if (q === 'invalid') {
      findInput.classList.add('invalid');
      countEl.textContent = '表达式无效';
      return;
    }
    overlay = searchOverlay(q);
    cm.addOverlay(overlay);
    const n = countMatches(q);
    countEl.textContent = n ? `${n >= MAX_MATCHES ? MAX_MATCHES + '+' : n} 处` : '无匹配';
  }

  function select(from, to) {
    if (marker) { marker.clear(); marker = null; }
    marker = cm.markText(from, to, { className: 'cm-search-current' });
    cm.setSelection(from, to);
    cm.scrollIntoView({ from, to }, 40);
  }

  function docEnd() {
    const line = cm.lastLine();
    return { line, ch: cm.getLine(line).length };
  }

  function findNext(rev) {
    const q = buildQuery();
    if (!q || q === 'invalid') return false;
    let cur = cm.getSearchCursor(q, rev ? cm.getCursor('from') : cm.getCursor('to'));
    if (!(rev ? cur.findPrevious() : cur.findNext())) {
      // 到头后回绕继续查
      cur = cm.getSearchCursor(q, rev ? docEnd() : { line: 0, ch: 0 });
      if (!(rev ? cur.findPrevious() : cur.findNext())) { countEl.textContent = '无匹配'; return false; }
    }
    select(cur.from(), cur.to());
    return true;
  }

  function replaceOne() {
    const q = buildQuery();
    if (!q || q === 'invalid') return;
    const sel = cm.getSelection();
    const whole = new RegExp(`^(?:${q.source})$`, q.flags);
    if (sel && whole.test(sel)) {
      // 正则模式下支持 $1..$9 分组引用
      cm.replaceSelection(useRegex() ? sel.replace(q, replInput.value) : replInput.value, 'around');
    }
    findNext(false);
    refresh();
  }

  function replaceAll() {
    const q = buildQuery();
    if (!q || q === 'invalid') return;
    const repl = replInput.value;
    let n = 0;
    cm.operation(() => {
      const cur = cm.getSearchCursor(q, { line: 0, ch: 0 });
      while (n < MAX_MATCHES && cur.findNext()) {
        const matched = cm.getRange(cur.from(), cur.to());
        cur.replace(useRegex() ? matched.replace(q, repl) : repl);
        n++;
      }
    });
    refresh();
    if (n) toast.success(`已替换 ${n} 处`);
    else toast.info('没有可替换的匹配');
  }

  function hide() {
    panel.style.display = 'none';
    clearMarks();
    cm.focus();
  }

  function show(focusReplace) {
    panel.style.display = '';
    const sel = cm.getSelection();
    if (sel && !sel.includes('\n')) findInput.value = sel;
    refresh();
    const box = focusReplace ? replInput : findInput;
    box.focus();
    box.select();
  }

  const onToggle = (btn) => {
    btn.classList.toggle('on');
    refresh();
  };
  btnCase.addEventListener('click', () => onToggle(btnCase));
  btnRe.addEventListener('click', () => onToggle(btnRe));
  findInput.addEventListener('input', refresh);
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey); }
    else if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });
  replInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
    else if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });

  const panel = el('div', { class: 'editor-search', style: { display: 'none' } },
    el('div', { class: 'es-row' },
      findInput, btnCase, btnRe, countEl,
      el('button', { class: 'es-btn', title: '上一个 (Shift+Enter / Shift+F3)', onClick: () => findNext(true) }, '↑'),
      el('button', { class: 'es-btn', title: '下一个 (Enter / F3)', onClick: () => findNext(false) }, '↓'),
      el('button', { class: 'es-btn', title: '关闭 (Esc)', onClick: hide }, '✕')),
    el('div', { class: 'es-row' },
      replInput,
      el('button', { class: 'es-btn es-text', title: '替换当前匹配并定位下一个', onClick: replaceOne }, '替换'),
      el('button', { class: 'es-btn es-text', title: '替换全部匹配', onClick: replaceAll }, '全部替换')));
  host.append(panel);

  return {
    show, hide, findNext,
    isOpen: () => panel.style.display !== 'none',
    hasQuery: () => !!findInput.value,
  };
}

/** 打开查找 / 替换面板；opts.replace=true 时聚焦替换框 */
export function openEditorSearch(cm, opts = {}) {
  let p = PANELS.get(cm);
  if (!p) { p = createPanel(cm); PANELS.set(cm, p); }
  p.show(!!opts.replace);
  return p;
}

/** 关闭面板；返回是否原本处于打开状态（用于 Esc 透传判断） */
export function closeEditorSearch(cm) {
  const p = PANELS.get(cm);
  if (p && p.isOpen()) { p.hide(); return true; }
  return false;
}

/** F3 / Shift+F3：面板打开且有查询词时跳下一处，否则打开面板 */
export function editorSearchNext(cm, rev) {
  const p = PANELS.get(cm);
  if (p && p.isOpen() && p.hasQuery()) p.findNext(!!rev);
  else openEditorSearch(cm);
}
