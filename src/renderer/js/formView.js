// 表单视图：单条记录纵向显示/编辑，与数据网格共享编辑状态（适合宽表）
import { el, iconEl, cellText } from './util.js';
import { cellViewer } from './toast.js';

export class FormView {
  /**
   * @param {HTMLElement} host
   * @param {DataGrid} grid  共享其 columns/rows/编辑状态
   * @param {object} opts {isReadonly:()=>bool, blobCtx:(rowIdx,colName)=>ctx|null}
   */
  constructor(host, grid, opts = {}) {
    this.grid = grid;
    this.opts = opts;
    this.idx = 0;
    this.root = el('div', { class: 'form-view' });
    host.append(this.root);
  }

  setIndex(i) {
    const n = this.grid.rows.length;
    this.idx = Math.min(Math.max(0, i), Math.max(0, n - 1));
    this.render();
  }

  render() {
    this.root.innerHTML = '';
    const g = this.grid;
    const n = g.rows.length;
    if (!g.columns.length || !n) {
      this.root.append(el('div', { class: 'obj-placeholder' }, '（本页无数据）'));
      return;
    }
    const r = this.idx;
    const readonly = this.opts.isReadonly ? this.opts.isReadonly() : true;

    // 导航条
    const nav = el('div', { class: 'form-nav' },
      el('button', { class: 'pbtn', title: '上一条', onClick: () => this.setIndex(this.idx - 1) }, '◀'),
      el('span', { style: { minWidth: '90px', textAlign: 'center' } }, `本页 ${r + 1} / ${n}`),
      el('button', { class: 'pbtn', title: '下一条', onClick: () => this.setIndex(this.idx + 1) }, '▶'));
    this.root.append(nav);

    const grid = el('div', { class: 'form-fields' });
    g.columns.forEach((col, i) => {
      const cur = g._currentVal(r, i, false);
      const edited = g.cellEdits.get(r) && g.cellEdits.get(r).has(i);
      const isBlob = cur && typeof cur === 'object' && cur.__blob;
      const label = el('div', { class: 'form-label' + (g.pk.includes(col.name) ? ' pk' : '') },
        g.pk.includes(col.name) ? iconEl('struct') : null,
        el('span', { class: 'form-label-name' }, col.name),
        el('span', { class: 'form-label-type' }, col.type || ''));

      let field;
      if (isBlob) {
        field = el('button', { class: 'pbtn', onClick: () => {
          const ctx = this.opts.blobCtx ? this.opts.blobCtx(r, col.name) : null;
          cellViewer(col.name, cur, ctx);
        } }, iconEl('info'), `BLOB ${cur.length} 字节 — 查看`);
      } else {
        const isNull = cur === null || cur === undefined;
        const ta = el('textarea', {
          class: 'form-input' + (edited ? ' edited' : ''),
          rows: 1, spellcheck: false,
          placeholder: isNull ? 'NULL' : '',
        });
        ta.value = isNull ? '' : String(cur); // textarea 内容须用属性 .value，不能走 el() 的 attribute
        ta.disabled = readonly;
        const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'; };
        setTimeout(autosize, 0);
        ta.addEventListener('input', () => { autosize(); g._setCell(r, i, ta.value, false); label.classList.toggle('changed', true); });
        if (!readonly) {
          const nullBtn = el('button', { class: 'form-null-btn', title: '设为 NULL', onClick: () => { g._setCell(r, i, null, false); this.render(); } }, '∅');
          field = el('div', { class: 'form-input-wrap' }, ta, nullBtn);
        } else {
          field = ta;
        }
      }
      grid.append(label, field);
    });
    this.root.append(grid);
  }
}
