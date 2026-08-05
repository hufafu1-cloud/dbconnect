// 数据网格：展示 + 选择 + 单元格编辑（增/改/删跟踪）
import { el, renderCellValue, cellText } from './util.js';
import { showMenu } from './contextmenu.js';
import { cellViewer, toast } from './toast.js';

const NUM_RE = /int|decimal|numeric|float|double|real|money|number/i;

// ---------- 虚拟滚动参数 ----------
// 行高由 CSS 固定（.grid td { height: 26px; white-space: nowrap }），不随内容变化，
// 因此可以用「上下两个占位行 + 中间只渲染可见区」的方式虚拟化，
// 表格布局、粘性表头、列宽 colgroup 全部保持原样。
const OVERSCAN = 12;              // 视口上下各多渲染的行数，避免快速滚动露白
const VIRTUAL_MIN_ROWS = 150;     // 行数不到这个值就整表渲染，小表行为与改造前完全一致
const FALLBACK_ROW_HEIGHT = 27;   // 首次实测前的估算值（26px 内容 + 1px 下边框）

// 行高档位（选项 → 数据网格）改变后，已打开的网格必须重排一次才能量到新行高。
// 用 WeakRef 持有，标签页关掉的网格会自然被回收，不会因为这张表而泄漏。
const liveGrids = new Set();

/** 重排所有还活着的网格（行高档位切换时调用） */
export function refreshAllGrids() {
  for (const ref of [...liveGrids]) {
    const grid = ref.deref();
    if (!grid) { liveGrids.delete(ref); continue; }
    try { grid.render(); } catch (e) { console.error('[grid] 重排失败:', e); }
  }
}

/** 多格式复制文本构建：tsv / tsvHeader / csv / markdown / insert */
function buildCopyText(format, names, rows, ctx) {
  const plain = (v) => (v === null || v === undefined) ? ''
    : (typeof v === 'object' && v.__blob) ? '0x' + v.hex : String(v);
  if (format === 'tsv' || format === 'tsvHeader') {
    const lines = rows.map((r) => r.map((v) => plain(v).replace(/[\t\r\n]/g, ' ')).join('\t'));
    if (format === 'tsvHeader') lines.unshift(names.join('\t'));
    return lines.join('\r\n');
  }
  if (format === 'csv') {
    const cell = (v) => {
      const s = plain(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [names.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n');
  }
  if (format === 'markdown') {
    const cell = (v) => plain(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    return [
      '| ' + names.map(cell).join(' | ') + ' |',
      '| ' + names.map(() => '---').join(' | ') + ' |',
      ...rows.map((r) => '| ' + r.map(cell).join(' | ') + ' |'),
    ].join('\r\n');
  }
  // insert
  const mysqlFamily = ['mysql', 'oceanbase', 'clickhouse'].includes(ctx.connType);
  const qi = (n) => ctx.connType === 'mssql' ? '[' + String(n).replace(/]/g, ']]') + ']'
    : mysqlFamily ? '`' + String(n).replace(/`/g, '``') + '`'
      : '"' + String(n).replace(/"/g, '""') + '"';
  const lit = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'object' && v.__blob) return 'NULL /* BLOB 预览不完整，未复制 */';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    let s = String(v);
    if (mysqlFamily) s = s.replace(/\\/g, '\\\\');
    return "'" + s.replace(/'/g, "''") + "'";
  };
  const T = qi(ctx.table || 'table_name');
  return rows.map((r) =>
    `INSERT INTO ${T} (${names.map(qi).join(', ')}) VALUES (${r.map(lit).join(', ')});`).join('\r\n');
}

export class DataGrid {
  /**
   * @param {HTMLElement} host
   * @param {object} opts {editable, onSort(col,dir), onChange()}
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.columns = [];
    this.rows = [];
    this.pk = [];
    this.sort = { col: null, dir: null };
    this.colWidths = {};
    this.clearPending();
    this.selection = new Set();
    this.lastSel = null;
    this.focus = null; // {dr: 显示行序号(含新行), c: 列序号}
    this._rowHeight = 0;             // 实测行高，0 表示尚未测量
    this._window = { start: 0, end: 0 }; // 当前已渲染的显示行区间 [start, end)
    this._topSpacer = null;
    this._bottomSpacer = null;
    this.wrap = el('div', { class: 'grid-wrap', tabindex: '0' });
    host.append(this.wrap);
    this.wrap.addEventListener('scroll', () => {
      // 编辑器滚动或文本选择过程中不能误关闭浮动 textarea。
      if (!(this._editor && document.activeElement === this._editor.ta)) {
        this._removeEditor(false);
      }
      this._renderWindow();
    });
    this.wrap.addEventListener('keydown', (e) => this._onKeyDown(e));
    // 视口尺寸变化要重算窗口：窗口缩放会改变可见行数；更重要的是标签页从隐藏
    // 变为可见时 clientHeight 才有值，否则整张表会一直只渲染出最初的十几行。
    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(() => this._renderWindow());
      this._resizeObserver.observe(this.wrap);
    }
    if (typeof WeakRef === 'function') liveGrids.add(new WeakRef(this));
  }

  get editable() { return !!this.opts.editable && this.pk.length > 0; }

  clearPending() {
    this.cellEdits = new Map();   // rowIdx -> Map(colIdx -> newVal)
    this.newRows = [];            // [{values: []}]
    this.deletedRows = new Set(); // rowIdx
  }

  isDirty() {
    return this.cellEdits.size > 0 || this.newRows.length > 0 || this.deletedRows.size > 0;
  }

  setData({ columns, rows, pk, rowIds, rowIdColumn }) {
    this.columns = columns || [];
    this.rows = rows || [];
    this.pk = pk || [];
    // 无主键表的行标识（如 PostgreSQL ctid）：不作为可见列，仅用于定位行
    this.rowIds = rowIds || null;
    this.rowIdColumn = rowIdColumn || null;
    this.clearPending();
    this.selection.clear();
    this.focus = null;
    this.render();
  }

  setSort(col, dir) { this.sort = { col, dir }; }

  // ---------- 渲染 ----------
  render() {
    this._removeEditor(false);
    this.wrap.innerHTML = '';
    if (!this.columns.length) {
      this.wrap.append(el('div', { class: 'grid-empty' }, '(无数据)'));
      return;
    }
    const table = el('table', { class: 'grid' });
    const colgroup = el('colgroup');
    colgroup.append(el('col', { style: { width: '46px' } }));
    this.columns.forEach((c, i) => {
      const w = this.colWidths[i] || Math.min(Math.max(c.name.length * 10 + 36, 90), 280);
      colgroup.append(el('col', { style: { width: w + 'px' } }));
    });
    table.append(colgroup);

    // 表头
    const thr = el('tr', {}, el('th', { class: 'rownum' }, '#'));
    this.columns.forEach((c, i) => {
      const inner = el('div', { class: 'th-inner' }, el('span', {}, c.name));
      if (this.sort.col === c.name) {
        inner.append(el('span', { class: 'sort-mark' }, this.sort.dir === 'desc' ? '▼' : '▲'));
      }
      // 打开表时后端会附带栏位 COMMENT；有注释时优先按 Navicat 的方式
      // 直接显示注释，没有注释时保留原有的“栏位名 : 类型”提示。
      const headerTip = c.comment
        ? String(c.comment)
        : (c.type ? `${c.name} : ${c.type}` : c.name);
      const th = el('th', { title: headerTip }, inner);
      if (this.opts.onSort) {
        th.addEventListener('click', (e) => {
          if (e.target.classList.contains('col-resizer')) return;
          let dir = 'asc';
          if (this.sort.col === c.name) dir = this.sort.dir === 'asc' ? 'desc' : (this.sort.dir === 'desc' ? null : 'asc');
          this.sort = dir ? { col: c.name, dir } : { col: null, dir: null };
          this.opts.onSort(this.sort.col, this.sort.dir);
        });
      }
      // 列宽拖拽
      const rz = el('div', { class: 'col-resizer' });
      rz.addEventListener('mousedown', (e) => this._startResize(e, i, colgroup));
      th.append(rz);
      thr.append(th);
    });
    table.append(el('thead', {}, thr));

    // 数据行：上下各一个占位行撑出总高度，中间只放可见区间的真实行
    const tbody = el('tbody');
    this._topSpacer = this._makeSpacer();
    this._bottomSpacer = this._makeSpacer();
    tbody.append(this._topSpacer, this._bottomSpacer);
    table.append(tbody);
    this.wrap.append(table);
    this.tbody = tbody;
    // 行高按 CSS 走，但字号/缩放变化后可能不同，每次整表渲染重新实测一次
    this._rowHeight = 0;
    this._window = { start: 0, end: 0 };
    this._renderWindow({ force: true });
    if (!this.rows.length && !this.newRows.length) {
      this.wrap.append(el('div', { class: 'grid-empty' }, '(0 行)'));
    }
    if (this.focus) this._setFocus(this.focus.dr, this.focus.c, { scroll: false, select: false });
  }

  // ---------- 虚拟滚动 ----------
  _makeSpacer() {
    return el('tr', { class: 'grid-spacer' },
      el('td', { colspan: this.columns.length + 1, style: { height: '0px' } }));
  }

  _setSpacer(tr, px) {
    const height = `${Math.max(0, Math.round(px))}px`;
    tr.style.height = height;
    if (tr.firstChild) tr.firstChild.style.height = height;
  }

  /** 粘性表头占据的高度：行 dr 在滚动内容里的起点是 表头高 + dr * 行高 */
  _theadHeight() {
    const thead = this.tbody && this.tbody.previousElementSibling;
    return thead ? thead.getBoundingClientRect().height : 0;
  }

  /** 当前应该渲染的显示行区间。行数少时退化为全量渲染。 */
  _visibleRange() {
    const total = this.rows.length + this.newRows.length;
    if (total <= VIRTUAL_MIN_ROWS) return { start: 0, end: total };
    const rowHeight = this._rowHeight || FALLBACK_ROW_HEIGHT;
    const offset = this.wrap.scrollTop - this._theadHeight();
    const viewHeight = this.wrap.clientHeight || 0;
    const start = Math.max(0, Math.floor(offset / rowHeight) - OVERSCAN);
    const end = Math.min(total, Math.ceil((offset + viewHeight) / rowHeight) + OVERSCAN);
    return { start, end: Math.max(start, end) };
  }

  /** 重建可见区间内的行。区间没变化时直接返回，滚动时的开销可以忽略。 */
  _renderWindow({ force = false } = {}) {
    if (!this.tbody || !this._topSpacer || !this._bottomSpacer) return;
    const { start, end } = this._visibleRange();
    if (!force && start === this._window.start && end === this._window.end) return;

    let node = this._topSpacer.nextSibling;
    while (node && node !== this._bottomSpacer) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
    const frag = document.createDocumentFragment();
    for (let dr = start; dr < end; dr++) {
      const { r, isNew } = this._fromDisplay(dr);
      const values = isNew ? this.newRows[r].values : this.rows[r];
      if (!values) continue;
      frag.append(this._renderRow(values, r, isNew, dr));
    }
    this._bottomSpacer.before(frag);
    this._window = { start, end };

    const rowHeight = this._rowHeight || FALLBACK_ROW_HEIGHT;
    const total = this.rows.length + this.newRows.length;
    this._setSpacer(this._topSpacer, start * rowHeight);
    this._setSpacer(this._bottomSpacer, (total - end) * rowHeight);

    this._measureRowHeight();
    // 焦点单元格所在的行可能刚被重建，高亮要跟着回来
    if (this.focus) {
      const td = this._tdAt(this.focus.dr, this.focus.c);
      if (td) td.classList.add('cell-focus');
    }
    // 正在编辑的单元格若被回收/重建，重新挂到新的 td 上；滚出窗口则置空，
    // _setCell 对空 td 已有保护，模型照样更新。
    if (this._editor) {
      this._editor.td = this._tdAt(this._editor.dr, this._editor.i);
    }
  }

  /** 首次渲染后实测真实行高；与估算值不同则按真实值重排一次 */
  _measureRowHeight() {
    if (this._rowHeight) return;
    const first = this._topSpacer && this._topSpacer.nextSibling;
    if (!first || first === this._bottomSpacer) return;
    const height = first.getBoundingClientRect().height;
    if (!height) return;
    this._rowHeight = height;
    if (Math.abs(height - FALLBACK_ROW_HEIGHT) > 0.5) this._renderWindow({ force: true });
  }

  /** 把某个显示行滚进视口（必要时先滚动再重建窗口，否则它根本没有 DOM） */
  _scrollRowIntoView(dr) {
    if (this._tdAt(dr, 0)) return;
    const rowHeight = this._rowHeight || FALLBACK_ROW_HEIGHT;
    const headHeight = this._theadHeight();
    const top = headHeight + dr * rowHeight;
    const viewHeight = this.wrap.clientHeight || 0;
    this.wrap.scrollTop = top < this.wrap.scrollTop + headHeight
      ? Math.max(0, top - headHeight)
      : Math.max(0, top + rowHeight - viewHeight);
    this._renderWindow();
  }

  // ---------- 单元格焦点 / 键盘导航 ----------
  /** 显示行序号 → {r, isNew}（新行排在已有行之后） */
  _fromDisplay(dr) {
    return dr < this.rows.length ? { r: dr, isNew: false } : { r: dr - this.rows.length, isNew: true };
  }

  /** 显示行序号 → 单元格。行可能不在渲染窗口内，此时返回 null（调用方都有保护）。 */
  _tdAt(dr, c) {
    const tr = this.tbody && this.tbody.querySelector(`tr[data-dr="${dr}"]`);
    return (tr && tr.children[c + 1]) || null;
  }

  _setFocus(dr, c, { scroll = true, select = true } = {}) {
    const count = this.rows.length + this.newRows.length;
    if (!count || !this.columns.length || !this.tbody) return;
    dr = Math.min(Math.max(0, dr), count - 1);
    c = Math.min(Math.max(0, c), this.columns.length - 1);
    const old = this.tbody.querySelector('td.cell-focus');
    if (old) old.classList.remove('cell-focus');
    this.focus = { dr, c };
    // 目标行可能在渲染窗口之外（键盘导航翻到远处），先把它滚进来再取 DOM
    if (scroll) this._scrollRowIntoView(dr);
    else this._renderWindow();
    const td = this._tdAt(dr, c);
    if (td) {
      td.classList.add('cell-focus');
      if (scroll) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    // 键盘导航时选中行跟随焦点（Navicat 行为）；鼠标多选场景由调用方跳过
    if (select && dr < this.rows.length) this._selectRow(dr, false, null);
  }

  _editFocused() {
    const f = this.focus;
    if (!f) return;
    const { r, isNew } = this._fromDisplay(f.dr);
    const td = this._tdAt(f.dr, f.c);
    if (!td) return;
    if (this.editable || isNew) this._beginEdit(td, r, f.c, isNew);
    else {
      const v = this._currentVal(r, f.c, isNew);
      cellViewer(this.columns[f.c].name, v === undefined ? null : v, null);
    }
  }

  _onKeyDown(e) {
    // textarea 内的删除、退格、全选等编辑按键必须交给浏览器原生处理，
    // 不能继续冒泡到网格快捷键层。
    if (this._editor || (e.target && e.target.closest && e.target.closest('.cell-editor'))) return;
    const count = this.rows.length + this.newRows.length;
    if (!count || !this.columns.length) return;
    const f = this.focus;
    const key = e.key;
    const NAV = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Home', 'End'];
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key.toLowerCase() === 's') {
      if (this.opts.onSave) {
        e.preventDefault();
        this.opts.onSave();
      }
      return;
    }
    if (!f) {
      if (NAV.includes(key)) { e.preventDefault(); this._setFocus(0, 0); }
      return;
    }
    const move = (dr, c) => { e.preventDefault(); this._setFocus(dr, c); };
    if (key === 'ArrowUp') move(f.dr - 1, f.c);
    else if (key === 'ArrowDown') move(f.dr + 1, f.c);
    else if (key === 'ArrowLeft') move(f.dr, f.c - 1);
    else if (key === 'ArrowRight') move(f.dr, f.c + 1);
    else if (key === 'Home' && !e.ctrlKey) move(f.dr, 0);
    else if (key === 'End' && !e.ctrlKey) move(f.dr, this.columns.length - 1);
    else if (key === 'Home' && e.ctrlKey) move(0, 0);
    else if (key === 'End' && e.ctrlKey) move(count - 1, this.columns.length - 1);
    else if (key === 'Tab') {
      e.preventDefault();
      let c = f.c + (e.shiftKey ? -1 : 1);
      let dr = f.dr;
      if (c < 0) { c = this.columns.length - 1; dr = Math.max(0, dr - 1); }
      else if (c >= this.columns.length) { c = 0; dr = Math.min(count - 1, dr + 1); }
      this._setFocus(dr, c);
    } else if (key === 'Enter' || key === 'F2') {
      e.preventDefault();
      this._editFocused();
    } else if (key === 'Delete') {
      const { r, isNew } = this._fromDisplay(f.dr);
      if (this.editable || isNew) {
        e.preventDefault();
        this._setCell(r, f.c, null, isNew, this._tdAt(f.dr, f.c));
      }
    } else if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'c' && !e.shiftKey && !e.altKey) {
      if (window.getSelection && String(window.getSelection())) return; // 用户手动选择了文本，保留默认复制
      e.preventDefault();
      if (this.selection.size > 1) { this._copyRows('tsv'); return; }
      const { r, isNew } = this._fromDisplay(f.dr);
      const v = this._currentVal(r, f.c, isNew);
      navigator.clipboard.writeText(cellText(v === undefined ? null : v));
      toast.success('已复制单元格');
    } else if (!e.ctrlKey && !e.altKey && !e.metaKey && key.length === 1) {
      // 直接输入进入编辑（输入字符作为起始内容），Navicat/Excel 习惯
      const { r, isNew } = this._fromDisplay(f.dr);
      if (this.editable || isNew) {
        e.preventDefault();
        const td = this._tdAt(f.dr, f.c);
        if (td) this._beginEdit(td, r, f.c, isNew, key);
      }
    }
  }

  _renderRow(values, r, isNew, dr) {
    // data-dr 是全局唯一的显示行序号；虚拟化后 DOM 里的位置不再等于行号，
    // 所有按行号找单元格的地方都要靠它来定位。
    const tr = el('tr', { 'data-r': r, 'data-dr': dr, 'data-new': isNew ? '1' : '' });
    if (isNew) tr.classList.add('row-new');
    if (!isNew && this.deletedRows.has(r)) tr.classList.add('row-deleted');
    if (!isNew && this.selection.has(r)) tr.classList.add('selected');
    const rn = el('td', { class: 'rownum' }, String(dr + 1));
    rn.addEventListener('click', (e) => this._selectRow(r, isNew, e));
    tr.append(rn);
    this.columns.forEach((c, i) => {
      tr.append(this._renderCell(values, r, i, isNew));
    });
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const td = e.target.closest('td');
      if (!td || td.classList.contains('rownum')) return;
      const ci = [...td.parentNode.children].indexOf(td) - 1;
      this._cellMenu(e, r, ci, isNew);
    });
    return tr;
  }

  _renderCell(values, r, i, isNew) {
    const edited = !isNew && this.cellEdits.get(r) && this.cellEdits.get(r).has(i);
    const v = edited ? this.cellEdits.get(r).get(i)
      : (isNew ? values[i] : values[i]);
    const td = el('td', { 'data-c': i });
    if (this.columns[i].type && NUM_RE.test(this.columns[i].type)) td.classList.add('cell-num');
    if (edited || (isNew && v !== undefined)) td.classList.add('cell-modified');
    td.innerHTML = isNew && v === undefined ? '<span class="v-null"></span>' : renderCellValue(v === undefined ? null : v);
    td.addEventListener('dblclick', () => {
      if (this.editable || isNew) this._beginEdit(td, r, i, isNew);
      else {
        const pk = this._pkOf(r, isNew);
        const blobCtx = (v && typeof v === 'object' && v.__blob && pk && this.opts.copyContext)
          ? { connId: this.opts.copyContext.connId, db: this.opts.copyContext.db, schema: this.opts.copyContext.schema, table: this.opts.copyContext.table, column: this.columns[i].name, pk }
          : null;
        cellViewer(this.columns[i].name, v === undefined ? null : v, blobCtx);
      }
    });
    td.addEventListener('click', (e) => {
      this._selectRow(r, isNew, e);
      // Navicat 式操作：普通单击选中后立即进入编辑，用户可以直接输入；
      // Ctrl/Shift 多选时只调整选择，不弹出编辑器。
      this._setFocus(isNew ? this.rows.length + r : r, i, { scroll: false, select: false });
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && (this.editable || isNew)) {
        this._beginEdit(td, r, i, isNew);
      } else {
        this.wrap.focus();
      }
    });
    return td;
  }

  _selectRow(r, isNew, e) {
    if (isNew) return;
    if (e && e.ctrlKey) {
      if (this.selection.has(r)) this.selection.delete(r); else this.selection.add(r);
    } else if (e && e.shiftKey && this.lastSel !== null) {
      const [a, b] = [Math.min(this.lastSel, r), Math.max(this.lastSel, r)];
      for (let i = a; i <= b; i++) this.selection.add(i);
    } else {
      this.selection.clear();
      this.selection.add(r);
    }
    this.lastSel = r;
    // 更新行高亮（只需处理窗口内的行；滚进来的新行在 _renderRow 里按 selection 上色）
    for (const tr of this.tbody.querySelectorAll('tr[data-dr]:not(.row-new)')) {
      tr.classList.toggle('selected', this.selection.has(Number(tr.dataset.r)));
    }
    if (this.opts.onSelect) this.opts.onSelect([...this.selection]);
  }

  // ---------- 编辑 ----------
  _currentVal(r, i, isNew) {
    if (isNew) return this.newRows[r].values[i];
    const e = this.cellEdits.get(r);
    if (e && e.has(i)) return e.get(i);
    return this.rows[r][i];
  }

  _beginEdit(td, r, i, isNew, initialText) {
    // 从一个单元格单击切换到另一个单元格时，先提交前一个编辑值。
    this._removeEditor(true);
    const cur = this._currentVal(r, i, isNew);
    if (cur && typeof cur === 'object' && cur.__blob) { toast.info('BLOB 字段不支持在网格中编辑'); return; }
    if (!isNew && this.deletedRows.has(r)) return;
    this._setFocus(isNew ? this.rows.length + r : r, i, { scroll: false, select: false });
    const rect = td.getBoundingClientRect();
    const wrapRect = this.wrap.getBoundingClientRect();
    const ta = el('textarea', { class: 'cell-editor', spellcheck: false });
    ta.value = cur === null || cur === undefined ? '' : String(cur);
    ta.style.left = (rect.left - wrapRect.left + this.wrap.scrollLeft) + 'px';
    ta.style.top = (rect.top - wrapRect.top + this.wrap.scrollTop) + 'px';
    ta.style.width = Math.max(rect.width, 120) + 'px';
    ta.style.height = Math.max(rect.height + 2, 28) + 'px';
    // 记下显示行序号：窗口重建后要靠它把编辑器重新挂回正确的 td
    this._editor = { ta, td, r, i, isNew, orig: cur, dr: isNew ? this.rows.length + r : r };
    ta.addEventListener('keydown', (e) => {
      // 阻止网格和页面级快捷键抢占编辑器按键；Delete/Backspace 不拦截，
      // 让 textarea 原生删除当前选中的长文本。
      e.stopPropagation();
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's' && this.opts.onSave) {
        e.preventDefault();
        this._removeEditor(true);
        this.wrap.focus();
        this.opts.onSave();
      } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) { e.preventDefault(); this._removeEditor(true); this.wrap.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); this._removeEditor(false); this.wrap.focus(); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const next = e.shiftKey ? i - 1 : i + 1;
        this._removeEditor(true);
        if (next >= 0 && next < this.columns.length) {
          const tr = td.parentNode;
          const ntd = tr.children[next + 1];
          if (ntd) this._beginEdit(ntd, r, next, isNew);
        } else {
          this.wrap.focus();
        }
      }
    });
    ta.addEventListener('blur', () => this._removeEditor(true));
    this.wrap.append(ta);
    ta.focus();
    if (initialText !== undefined) {
      // 直接输入进入编辑：以敲下的字符覆盖原值开始
      ta.value = initialText;
      ta.setSelectionRange(ta.value.length, ta.value.length);
    } else {
      ta.select();
    }
  }

  _removeEditor(commit) {
    const ed = this._editor;
    if (!ed) return;
    this._editor = null;
    const { ta, td, r, i, isNew, orig } = ed;
    const val = ta.value;
    ta.remove();
    if (!commit) return;
    const origStr = orig === null || orig === undefined ? null : String(orig);
    const newVal = val; // 空字符串就是空字符串；设 NULL 走右键菜单
    if (newVal === origStr || (origStr === null && newVal === '' && !isNew)) return; // 无变化
    this._setCell(r, i, newVal, isNew, td);
  }

  commitEditor() {
    this._removeEditor(true);
  }

  acceptChanges() {
    this.commitEditor();
    for (const [r, changes] of this.cellEdits) {
      if (!this.rows[r]) continue;
      for (const [i, value] of changes) this.rows[r][i] = value;
    }
    const deleted = [...this.deletedRows].sort((a, b) => b - a);
    for (const r of deleted) {
      this.rows.splice(r, 1);
      if (this.rowIds) this.rowIds.splice(r, 1);
    }
    for (const row of this.newRows) this.rows.push(row.values.map((value) => value === undefined ? null : value));
    this.clearPending();
    this.selection.clear();
    this.lastSel = null;
    this.render();
    if (this.opts.onChange) this.opts.onChange();
  }

  _setCell(r, i, val, isNew, td) {
    if (isNew) {
      this.newRows[r].values[i] = val;
    } else {
      const origVal = this.rows[r][i];
      const origStr = origVal === null || origVal === undefined ? null : String(origVal);
      let m = this.cellEdits.get(r);
      if (val === origStr || (val === null && origStr === null)) {
        if (m) { m.delete(i); if (!m.size) this.cellEdits.delete(r); }
      } else {
        if (!m) { m = new Map(); this.cellEdits.set(r, m); }
        m.set(i, val);
      }
    }
    if (td) {
      const cur = this._currentVal(r, i, isNew);
      td.innerHTML = renderCellValue(cur === undefined ? null : cur);
      const edited = isNew ? cur !== undefined : (this.cellEdits.get(r) && this.cellEdits.get(r).has(i));
      td.classList.toggle('cell-modified', !!edited);
    }
    if (this.opts.onChange) this.opts.onChange();
  }

  /** 当前显示行的主键对象（无主键返回 null） */
  _pkOf(r, isNew) {
    if (isNew || !this.pk || !this.pk.length) return null;
    if (this.rowIdColumn && this.rowIds) {
      const id = this.rowIds[r];
      return id === null || id === undefined ? null : { [this.rowIdColumn]: id };
    }
    const o = {};
    for (const name of this.pk) {
      const idx = this.columns.findIndex((c) => c.name === name);
      if (idx < 0) return null;
      o[name] = this.rows[r][idx];
    }
    return o;
  }

  _cellMenu(e, r, i, isNew) {
    const v = this._currentVal(r, i, isNew);
    const canEdit = this.editable || isNew;
    const colName = this.columns[i].name;
    const pk = this._pkOf(r, isNew);
    const blobCtx = (v && typeof v === 'object' && v.__blob && pk && this.opts.copyContext)
      ? { connId: this.opts.copyContext.connId, db: this.opts.copyContext.db, schema: this.opts.copyContext.schema, table: this.opts.copyContext.table, column: colName, pk }
      : null;
    const fk = this.opts.fkMap && this.opts.fkMap[colName];
    showMenu(e.clientX, e.clientY, [
      { label: '查看单元格', icon: 'info', onClick: () => cellViewer(colName, v === undefined ? null : v, blobCtx) },
      fk && this.opts.onJumpFk && v !== null && v !== undefined && !(typeof v === 'object') && {
        label: `跳转到 ${fk.refTable}（${fk.refColumn} = ${cellText(v).slice(0, 20)}）`,
        icon: 'link',
        onClick: () => this.opts.onJumpFk(fk, v),
      },
      { label: '复制单元格', icon: 'copy', onClick: () => { navigator.clipboard.writeText(cellText(v)); } },
      { sep: true },
      { label: '复制行（Tab 分隔）', icon: 'copy', onClick: () => this._copyRows('tsv', r) },
      { label: '复制行（带表头，贴 Excel）', icon: 'copy', onClick: () => this._copyRows('tsvHeader', r) },
      { label: '复制为 INSERT 语句', icon: 'copy', onClick: () => this._copyRows('insert', r) },
      { label: '复制为 CSV', icon: 'copy', onClick: () => this._copyRows('csv', r) },
      { label: '复制为 Markdown', icon: 'copy', onClick: () => this._copyRows('markdown', r) },
      { sep: true },
      canEdit && { label: '编辑', icon: 'edit', onClick: () => {
        const td = this._tdAt(isNew ? this.rows.length + r : r, i);
        if (td) this._beginEdit(td, r, i, isNew);
      } },
      canEdit && { label: '设为 NULL', onClick: () => {
        this._setCell(r, i, null, isNew, this._tdAt(isNew ? this.rows.length + r : r, i));
      } },
    ].filter(Boolean));
  }

  // ---------- 多格式复制 ----------
  _copyRows(format, fallbackRow) {
    const idxs = this.selection.size
      ? [...this.selection].sort((a, b) => a - b)
      : (fallbackRow !== undefined ? [fallbackRow] : []);
    if (!idxs.length) { toast.info('请先选中要复制的行'); return; }
    const names = this.columns.map((c) => c.name);
    const rows = idxs.map((r) => this.columns.map((_, i) => {
      const v = this._currentVal(r, i, false);
      return v === undefined ? null : v;
    }));
    const text = buildCopyText(format, names, rows, this.opts.copyContext || {});
    navigator.clipboard.writeText(text);
    toast.success(`已复制 ${rows.length} 行`);
  }

  // ---------- 新增 / 删除 ----------
  addNewRow() {
    this.newRows.push({ values: new Array(this.columns.length).fill(undefined) });
    this.render();
    // 聚焦新行第一个单元格。新行排在最后，大表里通常不在初始窗口内，先滚进来。
    const dr = this.rows.length + this.newRows.length - 1;
    this._scrollRowIntoView(dr);
    const td = this._tdAt(dr, 0);
    if (td) {
      td.scrollIntoView({ block: 'nearest' });
      this._beginEdit(td, this.newRows.length - 1, 0, true);
    }
    if (this.opts.onChange) this.opts.onChange();
  }

  /** 删除选中行（已有行标记删除，新行直接移除） */
  deleteSelected() {
    let n = 0;
    for (const r of this.selection) { this.deletedRows.add(r); n++; }
    if (!n && this.newRows.length) { this.newRows.pop(); n++; } // 没选中时撤掉最后一个新行
    this.render();
    if (this.opts.onChange) this.opts.onChange();
    return n;
  }

  /** 生成编辑操作列表（供 applyEdits） */
  getPendingEdits() {
    const ops = [];
    const pkIdx = this.pk.map((name) => this.columns.findIndex((c) => c.name === name));
    const pkOf = (r) => {
      if (this.rowIdColumn && this.rowIds) return { [this.rowIdColumn]: this.rowIds[r] };
      const o = {};
      this.pk.forEach((name, j) => { o[name] = this.rows[r][pkIdx[j]]; });
      return o;
    };
    for (const r of this.deletedRows) {
      ops.push({ kind: 'delete', where: pkOf(r) });
    }
    for (const [r, m] of this.cellEdits) {
      if (this.deletedRows.has(r)) continue;
      const set = {};
      for (const [i, v] of m) set[this.columns[i].name] = v;
      ops.push({ kind: 'update', where: pkOf(r), set });
    }
    for (const nr of this.newRows) {
      const values = {};
      nr.values.forEach((v, i) => { if (v !== undefined) values[this.columns[i].name] = v; });
      ops.push({ kind: 'insert', values });
    }
    return ops;
  }

  // ---------- 列宽拖拽 ----------
  _startResize(e, colIdx, colgroup) {
    e.preventDefault();
    e.stopPropagation();
    const col = colgroup.children[colIdx + 1];
    const startX = e.clientX;
    const startW = parseInt(col.style.width, 10) || 100;
    const move = (ev) => {
      const w = Math.max(50, startW + ev.clientX - startX);
      col.style.width = w + 'px';
      this.colWidths[colIdx] = w;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
}
