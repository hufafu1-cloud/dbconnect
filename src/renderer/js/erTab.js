// ER 关系图：SVG 渲染表盒 + 外键连线，支持拖拽 / 平移 / 缩放 / 导出 PNG
import { el, iconEl } from './util.js';
import { connLabel, connColor } from './state.js';
import { addTab, uid } from './tabs.js';
import { toast } from './toast.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const BOX_W = 196;
const HEADER_H = 26;
const ROW_H = 18;
const MAX_ROWS = 12;

function sx(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) { if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c))); }
  return n;
}

function boxHeight(t) {
  const shown = Math.min(t.columns.length, MAX_ROWS);
  return HEADER_H + shown * ROW_H + (t.columns.length > MAX_ROWS ? ROW_H : 0) + 4;
}

// 线段与矩形边的交点（从矩形中心朝目标方向）
function edgePoint(box, tx, ty) {
  const cx = box.x + BOX_W / 2;
  const cy = box.y + box.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = BOX_W / 2, hh = box.h / 2;
  const scaleX = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(scaleX, scaleY);
  return { x: cx + dx * s, y: cy + dy * s };
}

export function openErTab(target) {
  const tabId = `er:${target.connId}|${target.db}|${target.schema || ''}`;
  const tab = addTab({ id: tabId, title: `ER - ${target.db || target.schema || ''}`, icon: 'er', color: connColor(target.connId), tooltip: `${connLabel(target.connId)} ER 关系图` });
  if (tab.pane.childElementCount) return tab;
  tab.pane.classList.add('er-pane');

  let model = null;
  const positions = new Map(); // name -> {x,y}
  const boxes = new Map();     // name -> {x,y,h,t}
  let scale = 1, panX = 20, panY = 20;

  const canvas = el('div', { class: 'er-canvas' });
  const svg = document.createElementNS(SVGNS, 'svg');
  const rootG = document.createElementNS(SVGNS, 'g');
  svg.append(defsMarkers(), rootG);
  canvas.append(svg);

  const info = el('span', { class: 'obj-path' }, '');
  const toolbar = el('div', { class: 'pane-toolbar' },
    el('button', { class: 'pbtn', onClick: load }, iconEl('refresh'), '刷新'),
    el('span', { class: 'sep' }),
    el('button', { class: 'pbtn', onClick: () => zoomBy(1.2) }, '放大 +'),
    el('button', { class: 'pbtn', onClick: () => zoomBy(1 / 1.2) }, '缩小 −'),
    el('button', { class: 'pbtn', onClick: fit }, '适应窗口'),
    el('button', { class: 'pbtn', onClick: relayout }, '重新布局'),
    el('span', { class: 'sep' }),
    el('button', { class: 'pbtn', onClick: exportPng }, iconEl('exportIcon'), '导出 PNG'),
    el('span', { class: 'spring' }),
    info);
  tab.pane.append(toolbar, canvas);

  function defsMarkers() {
    const defs = document.createElementNS(SVGNS, 'defs');
    const mk = sx('marker', { id: 'er-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      sx('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#4b57d6' }));
    defs.append(mk);
    return defs;
  }

  function gridLayout() {
    positions.clear();
    const n = model.tables.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n) * 1.4));
    let i = 0;
    const colH = new Array(cols).fill(20);
    for (const t of model.tables) {
      const c = i % cols;
      const x = 30 + c * (BOX_W + 56);
      const y = colH[c];
      positions.set(t.name, { x, y });
      colH[c] += boxHeight(t) + 36;
      i++;
    }
  }

  function computeBoxes() {
    boxes.clear();
    for (const t of model.tables) {
      const p = positions.get(t.name) || { x: 30, y: 30 };
      boxes.set(t.name, { x: p.x, y: p.y, h: boxHeight(t), t });
    }
  }

  function render() {
    const rect = canvas.getBoundingClientRect();
    svg.setAttribute('width', rect.width);
    svg.setAttribute('height', rect.height);
    rootG.setAttribute('transform', `translate(${panX},${panY}) scale(${scale})`);
    rootG.innerHTML = '';
    computeBoxes();

    // 连线（在盒子下层）
    for (const rel of model.relations) {
      const a = boxes.get(rel.from);
      const b = boxes.get(rel.to);
      if (!a || !b) continue;
      const ac = { x: a.x + BOX_W / 2, y: a.y + a.h / 2 };
      const bc = { x: b.x + BOX_W / 2, y: b.y + b.h / 2 };
      const p1 = edgePoint(a, bc.x, bc.y);
      const p2 = edgePoint(b, ac.x, ac.y);
      const midX = (p1.x + p2.x) / 2;
      const d = `M${p1.x},${p1.y} C${midX},${p1.y} ${midX},${p2.y} ${p2.x},${p2.y}`;
      rootG.append(sx('path', { d, fill: 'none', stroke: '#4b57d6', 'stroke-width': 1.5, opacity: 0.75, 'marker-end': 'url(#er-arrow)' }));
      rootG.append(sx('circle', { cx: p1.x, cy: p1.y, r: 3, fill: '#1a9e57' }));
    }

    // 表盒
    for (const t of model.tables) {
      rootG.append(renderBox(t, boxes.get(t.name)));
    }
    info.textContent = `${model.tables.length} 张表 · ${model.relations.filter((r) => boxes.get(r.to)).length} 条关系` + (model.truncated ? `（共 ${model.total} 张，仅显示前 ${model.tables.length}）` : '');
  }

  function renderBox(t, box) {
    const g = sx('g', { transform: `translate(${box.x},${box.y})` });
    g.append(sx('rect', { x: 0, y: 0, width: BOX_W, height: box.h, rx: 7, fill: 'var(--panel)', stroke: 'var(--border)', 'stroke-width': 1.2, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.12))' }));
    // 头部
    const header = sx('g', { class: 'er-box-header', style: 'cursor:move' });
    header.append(sx('path', { d: `M0,7 a7,7 0 0 1 7,-7 L${BOX_W - 7},0 a7,7 0 0 1 7,7 L${BOX_W},${HEADER_H} L0,${HEADER_H} Z`, fill: 'var(--accent)' }));
    header.append(sx('text', { x: 10, y: 17, fill: '#fff', 'font-size': 12.5, 'font-weight': 600 }, t.name));
    header.addEventListener('mousedown', (e) => startBoxDrag(e, t.name));
    g.append(header);
    // 列
    const shown = t.columns.slice(0, MAX_ROWS);
    shown.forEach((c, i) => {
      const y = HEADER_H + i * ROW_H;
      const ty = y + ROW_H - 5;
      if (c.pk) g.append(sx('text', { x: 8, y: ty, 'font-size': 11 }, '🔑'));
      else if (c.fk) g.append(sx('text', { x: 8, y: ty, 'font-size': 10, fill: '#1a9e57' }, '◆'));
      g.append(sx('text', { x: 24, y: ty, 'font-size': 11.5, fill: 'var(--text)', 'font-weight': c.pk ? 600 : 400 }, c.name));
      g.append(sx('text', { x: BOX_W - 8, y: ty, 'font-size': 10.5, fill: 'var(--text-muted)', 'text-anchor': 'end' }, shortType(c.type)));
      if (i > 0) g.append(sx('line', { x1: 0, y1: y, x2: BOX_W, y2: y, stroke: 'var(--border-light)', 'stroke-width': 0.5 }));
    });
    if (t.columns.length > MAX_ROWS) {
      g.append(sx('text', { x: 10, y: HEADER_H + MAX_ROWS * ROW_H + 13, 'font-size': 11, fill: 'var(--text-muted)' }, `+ ${t.columns.length - MAX_ROWS} 个栏位…`));
    }
    return g;
  }

  // ---------- 交互 ----------
  function startBoxDrag(e, name) {
    e.preventDefault();
    e.stopPropagation();
    const start = positions.get(name);
    const sx0 = e.clientX, sy0 = e.clientY;
    const move = (ev) => {
      positions.set(name, { x: start.x + (ev.clientX - sx0) / scale, y: start.y + (ev.clientY - sy0) / scale });
      render();
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  canvas.addEventListener('mousedown', (e) => {
    if (e.target.closest('.er-box-header')) return; // 盒子拖拽已处理
    e.preventDefault();
    canvas.classList.add('panning');
    const sx0 = e.clientX, sy0 = e.clientY, px = panX, py = panY;
    const move = (ev) => { panX = px + (ev.clientX - sx0); panY = py + (ev.clientY - sy0); rootG.setAttribute('transform', `translate(${panX},${panY}) scale(${scale})`); };
    const up = () => { canvas.classList.remove('panning'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const ns = Math.min(3, Math.max(0.2, scale * factor));
    // 以光标为锚点缩放
    panX = mx - (mx - panX) * (ns / scale);
    panY = my - (my - panY) * (ns / scale);
    scale = ns;
    rootG.setAttribute('transform', `translate(${panX},${panY}) scale(${scale})`);
  }, { passive: false });

  function zoomBy(f) { scale = Math.min(3, Math.max(0.2, scale * f)); rootG.setAttribute('transform', `translate(${panX},${panY}) scale(${scale})`); }

  function contentBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of boxes.values()) {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + BOX_W); maxY = Math.max(maxY, b.y + b.h);
    }
    if (!isFinite(minX)) return null;
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  function fit() {
    computeBoxes();
    const b = contentBounds();
    if (!b) return;
    const rect = canvas.getBoundingClientRect();
    scale = Math.min(2, Math.max(0.2, Math.min((rect.width - 40) / b.w, (rect.height - 40) / b.h)));
    panX = (rect.width - b.w * scale) / 2 - b.minX * scale;
    panY = 20 - b.minY * scale;
    render();
  }

  function relayout() { gridLayout(); fit(); }

  async function exportPng() {
    computeBoxes();
    const b = contentBounds();
    if (!b) { toast.info('没有可导出的内容'); return; }
    const pad = 30;
    const clone = svg.cloneNode(true);
    const g = clone.querySelector('g');
    g.setAttribute('transform', `translate(${pad - b.minX},${pad - b.minY}) scale(1)`);
    clone.setAttribute('width', b.w + pad * 2);
    clone.setAttribute('height', b.h + pad * 2);
    // 把 CSS 变量展开为具体颜色（导出脱离样式表）
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    inlineVars(clone, dark);
    const xml = new XMLSerializer().serializeToString(clone);
    const svgBlob = new Blob(['<?xml version="1.0"?>\n' + xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const imgEl = new Image();
    imgEl.onload = async () => {
      const cv = document.createElement('canvas');
      cv.width = (b.w + pad * 2) * 2; cv.height = (b.h + pad * 2) * 2; // 2x 清晰
      const ctx = cv.getContext('2d');
      ctx.scale(2, 2);
      ctx.fillStyle = dark ? '#1f242b' : '#ffffff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(imgEl, 0, 0);
      URL.revokeObjectURL(url);
      const dataUrl = cv.toDataURL('image/png');
      const file = await window.api.dlg.saveFile({ title: '导出 ER 图', defaultPath: `ER-${target.db || 'schema'}.png`, filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
      if (!file) return;
      try {
        await window.api.file.writeBase64(file, dataUrl.split(',')[1]);
        toast.success('已导出\n' + file);
      } catch (e) { toast.error('导出失败: ' + e.message); }
    };
    imgEl.onerror = () => { URL.revokeObjectURL(url); toast.error('导出失败：图像渲染错误'); };
    imgEl.src = url;
  }

  function inlineVars(node, dark) {
    const cs = getComputedStyle(document.documentElement);
    const map = {
      'var(--panel)': cs.getPropertyValue('--panel').trim() || (dark ? '#23272e' : '#fff'),
      'var(--border)': cs.getPropertyValue('--border').trim() || '#d9dde3',
      'var(--border-light)': cs.getPropertyValue('--border-light').trim() || '#e7eaee',
      'var(--accent)': cs.getPropertyValue('--accent').trim() || '#4b57d6',
      'var(--text)': cs.getPropertyValue('--text').trim() || '#1f2329',
      'var(--text-muted)': cs.getPropertyValue('--text-muted').trim() || '#6b7280',
    };
    const walk = (n) => {
      for (const attr of ['fill', 'stroke']) {
        const v = n.getAttribute && n.getAttribute(attr);
        if (v && map[v]) n.setAttribute(attr, map[v]);
      }
      // drop-shadow filter 在导出时去掉（canvas 不支持 CSS filter 字符串）
      if (n.getAttribute && n.getAttribute('filter')) n.removeAttribute('filter');
      for (const c of n.childNodes) walk(c);
    };
    walk(node);
  }

  async function load() {
    rootG.innerHTML = '';
    info.textContent = '加载中…';
    try {
      model = await window.api.db.erModel(target.connId, target.db, target.schema, { maxTables: 60 });
      if (!model.tables.length) {
        info.textContent = '该库没有表';
        return;
      }
      gridLayout();
      fit();
    } catch (e) {
      info.textContent = '加载失败: ' + e.message;
    }
  }

  tab.setOnShow(() => { if (model) render(); });
  setTimeout(load, 30);
  return tab;
}

function shortType(t) {
  if (!t) return '';
  const s = String(t);
  return s.length > 14 ? s.slice(0, 13) + '…' : s;
}
