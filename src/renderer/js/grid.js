// 数据网格：展示 + 选择 + 单元格编辑（增/改/删跟踪）
import { el, renderCellValue, cellText } from './util.js';
import { showMenu } from './contextmenu.js';
import { cellViewer, toast } from './toast.js';

const NUM_RE = /int|decimal|numeric|float|double|real|money|number/i;

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
    this.wrap = el('div', { class: 'grid-wrap' });
    host.append(this.wrap);
    this.wrap.addEventListener('scroll', () => this._removeEditor(false));
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

  setData({ columns, rows, pk }) {
    this.columns = columns || [];
    this.rows = rows || [];
    this.pk = pk || [];
    this.clearPending();
    this.selection.clear();
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
      const th = el('th', { title: c.type ? `${c.name} : ${c.type}` : c.name }, inner);
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

    // 数据行
    const tbody = el('tbody');
    this.rows.forEach((row, r) => tbody.append(this._renderRow(row, r, false)));
    this.newRows.forEach((nr, j) => tbody.append(this._renderRow(nr.values, j, true)));
    table.append(tbody);
    this.wrap.append(table);
    this.tbody = tbody;
    if (!this.rows.length && !this.newRows.length) {
      this.wrap.append(el('div', { class: 'grid-empty' }, '(0 行)'));
    }
  }

  _renderRow(values, r, isNew) {
    const tr = el('tr', { 'data-r': r, 'data-new': isNew ? '1' : '' });
    if (isNew) tr.classList.add('row-new');
    if (!isNew && this.deletedRows.has(r)) tr.classList.add('row-deleted');
    if (!isNew && this.selection.has(r)) tr.classList.add('selected');
    const rn = el('td', { class: 'rownum' }, String(isNew ? this.rows.length + r + 1 : r + 1));
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
      else cellViewer(this.columns[i].name, v === undefined ? null : v);
    });
    td.addEventListener('click', (e) => this._selectRow(r, isNew, e));
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
    // 更新行高亮
    for (const tr of this.tbody.querySelectorAll('tr:not(.row-new)')) {
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

  _beginEdit(td, r, i, isNew) {
    const cur = this._currentVal(r, i, isNew);
    if (cur && typeof cur === 'object' && cur.__blob) { toast.info('BLOB 字段不支持在网格中编辑'); return; }
    if (!isNew && this.deletedRows.has(r)) return;
    this._removeEditor(false);
    const rect = td.getBoundingClientRect();
    const wrapRect = this.wrap.getBoundingClientRect();
    const ta = el('textarea', { class: 'cell-editor', spellcheck: false });
    ta.value = cur === null || cur === undefined ? '' : String(cur);
    ta.style.left = (rect.left - wrapRect.left + this.wrap.scrollLeft) + 'px';
    ta.style.top = (rect.top - wrapRect.top + this.wrap.scrollTop) + 'px';
    ta.style.width = Math.max(rect.width, 120) + 'px';
    ta.style.height = Math.max(rect.height + 2, 28) + 'px';
    this._editor = { ta, td, r, i, isNew, orig: cur };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) { e.preventDefault(); this._removeEditor(true); }
      else if (e.key === 'Escape') { e.preventDefault(); this._removeEditor(false); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const next = e.shiftKey ? i - 1 : i + 1;
        this._removeEditor(true);
        if (next >= 0 && next < this.columns.length) {
          const tr = td.parentNode;
          const ntd = tr.children[next + 1];
          if (ntd) this._beginEdit(ntd, r, next, isNew);
        }
      }
    });
    ta.addEventListener('blur', () => this._removeEditor(true));
    this.wrap.append(ta);
    ta.focus();
    ta.select();
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

  _cellMenu(e, r, i, isNew) {
    const v = this._currentVal(r, i, isNew);
    const canEdit = this.editable || isNew;
    showMenu(e.clientX, e.clientY, [
      { label: '查看单元格', icon: 'info', onClick: () => cellViewer(this.columns[i].name, v === undefined ? null : v) },
      { label: '复制', icon: 'copy', onClick: () => { navigator.clipboard.writeText(cellText(v)); } },
      { sep: true },
      canEdit && { label: '编辑', icon: 'edit', onClick: () => {
        const tr = this.tbody && this.tbody.querySelector(`tr[data-r="${r}"]${isNew ? '[data-new="1"]' : ':not([data-new="1"])'}`);
        const td = tr && tr.children[i + 1];
        if (td) this._beginEdit(td, r, i, isNew);
      } },
      canEdit && { label: '设为 NULL', onClick: () => {
        const tr = this.tbody && this.tbody.querySelectorAll('tr')[isNew ? this.rows.length + r : r];
        const td = tr && tr.children[i + 1];
        this._setCell(r, i, null, isNew, td);
      } },
    ].filter(Boolean));
  }

  // ---------- 新增 / 删除 ----------
  addNewRow() {
    this.newRows.push({ values: new Array(this.columns.length).fill(undefined) });
    this.render();
    // 聚焦新行第一个单元格
    const trs = this.tbody.querySelectorAll('tr');
    const tr = trs[trs.length - 1];
    if (tr) {
      tr.scrollIntoView({ block: 'nearest' });
      const td = tr.children[1];
      if (td) this._beginEdit(td, this.newRows.length - 1, 0, true);
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
