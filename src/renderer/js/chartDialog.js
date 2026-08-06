// 结果集图表：柱状 / 折线 / 饼图。
//
// 手写 SVG，不引图表库——ER 图已经是这么做的（含导出 PNG 的先例），
// 而引 ECharts 会给安装包加好几 MB，为这个功能不值。
//
// 颜色全部走 CSS 变量，深浅色主题自动跟随。
import { el, fmtCount } from './util.js';
import { openModal, toast } from './toast.js';
import { t } from './i18n.js';

const MAX_CATEGORIES = 60;   // 超过这么多类别，柱子会窄到看不清，截断并提示
const PALETTE = ['#4b57d6', '#1a9e57', '#d97706', '#8250df', '#0ea5e9', '#e5484d', '#65a30d', '#db2777'];

const NUM_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object') return null;
  const text = String(value).trim();
  return NUM_RE.test(text) ? Number(text) : null;
}

function labelOf(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return '(BLOB)';
  return String(value);
}

/** 数值列：抽样前若干行，多数是数字才算 */
function numericColumns(columns, rows) {
  const sample = rows.slice(0, 50);
  return columns.map((c, i) => i).filter((i) => {
    let numeric = 0;
    let seen = 0;
    for (const row of sample) {
      if (row[i] === null || row[i] === undefined || row[i] === '') continue;
      seen++;
      if (toNumber(row[i]) !== null) numeric++;
    }
    return seen > 0 && numeric / seen >= 0.8;
  });
}

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  return Math.ceil(value / base) * base;
}

function drawBarOrLine(kind, points, width, height) {
  const padL = 64;
  const padR = 16;
  const padT = 16;
  const padB = 64;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const values = points.map((p) => p.value);
  const rawMax = Math.max(0, ...values);
  const rawMin = Math.min(0, ...values);
  const max = niceMax(rawMax) || 1;
  const min = rawMin < 0 ? -niceMax(-rawMin) : 0;
  const span = (max - min) || 1;
  const y = (v) => padT + plotH - ((v - min) / span) * plotH;

  const g = svgEl('g');
  // 横向网格线 + Y 轴刻度
  for (let i = 0; i <= 4; i++) {
    const value = min + (span * i) / 4;
    const yy = y(value);
    g.append(svgEl('line', {
      x1: padL, x2: width - padR, y1: yy, y2: yy,
      stroke: 'var(--border-light)', 'stroke-width': 1,
    }));
    g.append(svgEl('text', {
      x: padL - 8, y: yy + 4, 'text-anchor': 'end',
      fill: 'var(--text-muted)', 'font-size': 11,
    }, Number.isInteger(value) ? String(value) : value.toFixed(2)));
  }
  // 零轴
  g.append(svgEl('line', {
    x1: padL, x2: width - padR, y1: y(0), y2: y(0),
    stroke: 'var(--border)', 'stroke-width': 1,
  }));

  const step = plotW / points.length;
  points.forEach((p, i) => {
    const cx = padL + step * i + step / 2;
    if (kind === 'bar') {
      const barW = Math.max(2, Math.min(38, step * 0.62));
      const top = Math.min(y(p.value), y(0));
      const h = Math.max(1, Math.abs(y(p.value) - y(0)));
      const rect = svgEl('rect', {
        x: cx - barW / 2, y: top, width: barW, height: h,
        fill: PALETTE[0], rx: 2,
      });
      rect.append(svgEl('title', {}, `${p.label}: ${p.value}`));
      g.append(rect);
    }
    // X 轴标签：类别多时隔几个显示一个，否则会糊成一片
    const every = Math.ceil(points.length / 14);
    if (i % every === 0) {
      const text = svgEl('text', {
        x: cx, y: height - padB + 16, 'text-anchor': 'end',
        fill: 'var(--text-muted)', 'font-size': 11,
        transform: `rotate(-35 ${cx} ${height - padB + 16})`,
      }, p.label.length > 14 ? `${p.label.slice(0, 13)}…` : p.label);
      text.append(svgEl('title', {}, p.label));
      g.append(text);
    }
  });

  if (kind === 'line') {
    const d = points.map((p, i) => {
      const cx = padL + step * i + step / 2;
      return `${i === 0 ? 'M' : 'L'}${cx.toFixed(1)},${y(p.value).toFixed(1)}`;
    }).join(' ');
    g.append(svgEl('path', { d, fill: 'none', stroke: PALETTE[0], 'stroke-width': 2 }));
    points.forEach((p, i) => {
      const cx = padL + step * i + step / 2;
      const dot = svgEl('circle', { cx, cy: y(p.value), r: 3, fill: PALETTE[0] });
      dot.append(svgEl('title', {}, `${p.label}: ${p.value}`));
      g.append(dot);
    });
  }
  return g;
}

function drawPie(points, width, height) {
  const total = points.reduce((sum, p) => sum + Math.max(0, p.value), 0);
  const g = svgEl('g');
  if (total <= 0) {
    g.append(svgEl('text', {
      x: width / 2, y: height / 2, 'text-anchor': 'middle', fill: 'var(--text-muted)', 'font-size': 13,
    }, t('所选数据没有正数值，无法画饼图')));
    return g;
  }
  const cx = width * 0.34;
  const cy = height / 2;
  const r = Math.min(width * 0.3, height * 0.4);
  let angle = -Math.PI / 2;
  points.forEach((p, i) => {
    const value = Math.max(0, p.value);
    if (!value) return;
    const sweep = (value / total) * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    angle += sweep;
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    const path = svgEl('path', {
      d: `M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z`,
      fill: PALETTE[i % PALETTE.length], stroke: 'var(--panel)', 'stroke-width': 1,
    });
    path.append(svgEl('title', {}, `${p.label}: ${value}（${((value / total) * 100).toFixed(1)}%）`));
    g.append(path);
  });
  // 图例
  points.slice(0, 14).forEach((p, i) => {
    const ly = 30 + i * 20;
    g.append(svgEl('rect', { x: width * 0.68, y: ly - 9, width: 11, height: 11, rx: 2, fill: PALETTE[i % PALETTE.length] }));
    g.append(svgEl('text', {
      x: width * 0.68 + 17, y: ly, fill: 'var(--text)', 'font-size': 11.5,
    }, `${p.label.length > 16 ? `${p.label.slice(0, 15)}…` : p.label}  ${((Math.max(0, p.value) / total) * 100).toFixed(1)}%`));
  });
  return g;
}

/**
 * 打开图表对话框。
 * @param {{columns: {name:string}[], rows: any[][], title?: string}} data
 */
export function openChartDialog(data) {
  const columns = (data && data.columns) || [];
  const rows = (data && data.rows) || [];
  if (!columns.length || !rows.length) {
    toast.info(t('没有可用于绘图的数据'));
    return null;
  }
  const numeric = numericColumns(columns, rows);
  if (!numeric.length) {
    toast.info(t('所选数据里没有数值列，无法绘图'));
    return null;
  }

  const kindSel = el('select', { class: 'settings-select' },
    el('option', { value: 'bar' }, t('柱状图')),
    el('option', { value: 'line' }, t('折线图')),
    el('option', { value: 'pie' }, t('饼图')));
  const labelSel = el('select', { class: 'settings-select' },
    ...columns.map((c, i) => el('option', { value: String(i) }, c.name)));
  const valueSel = el('select', { class: 'settings-select' },
    ...numeric.map((i) => el('option', { value: String(i) }, columns[i].name)));
  // 类别列默认选第一个非数值列，否则柱状图会变成「数字对数字」
  const firstText = columns.map((c, i) => i).find((i) => !numeric.includes(i));
  labelSel.value = String(firstText === undefined ? 0 : firstText);
  valueSel.value = String(numeric[0]);

  const note = el('div', { class: 'settings-hint' });
  const canvasHost = el('div', { class: 'chart-canvas' });

  function build() {
    const kind = kindSel.value;
    const li = Number(labelSel.value);
    const vi = Number(valueSel.value);
    let points = rows.map((row) => ({ label: labelOf(row[li]), value: toNumber(row[vi]) }))
      .filter((p) => p.value !== null);
    const truncated = points.length > MAX_CATEGORIES;
    if (truncated) points = points.slice(0, MAX_CATEGORIES);

    note.textContent = points.length
      ? (truncated
        ? t('数据点较多，只画了前 {n} 条（共 {total} 条）', { n: MAX_CATEGORIES, total: fmtCount(rows.length) })
        : t('共 {n} 个数据点', { n: points.length }))
      : t('该列没有可用的数值');

    const width = 720;
    const height = 380;
    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`, width: '100%', height: '100%',
      xmlns: 'http://www.w3.org/2000/svg', class: 'chart-svg',
    });
    if (points.length) {
      svg.append(kind === 'pie' ? drawPie(points, width, height) : drawBarOrLine(kind, points, width, height));
    }
    canvasHost.replaceChildren(svg);
    return svg;
  }

  for (const sel of [kindSel, labelSel, valueSel]) sel.addEventListener('change', build);

  /** 导出 PNG：把 SVG 里的 CSS 变量换成实际颜色再转位图，否则导出的图是黑的 */
  async function exportPng() {
    const svg = canvasHost.querySelector('svg');
    if (!svg) return;
    const clone = svg.cloneNode(true);
    const styles = getComputedStyle(document.body);
    const resolve = (value) => value.replace(/var\((--[\w-]+)\)/g, (_m, name) =>
      styles.getPropertyValue(name).trim() || '#888');
    for (const node of clone.querySelectorAll('*')) {
      for (const attr of ['fill', 'stroke']) {
        const value = node.getAttribute(attr);
        if (value && value.includes('var(')) node.setAttribute(attr, resolve(value));
      }
    }
    clone.setAttribute('width', '1440');
    clone.setAttribute('height', '760');
    const bg = svgEl('rect', { x: 0, y: 0, width: 720, height: 380, fill: styles.getPropertyValue('--panel').trim() || '#fff' });
    clone.insertBefore(bg, clone.firstChild);
    const xml = new XMLSerializer().serializeToString(clone);
    const file = await window.api.dlg.saveFile({
      title: t('导出图表'), defaultPath: 'chart.png',
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (!file) return;
    await new Promise((resolveDone, reject) => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = 1440;
        cv.height = 760;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        window.api.file.writeBase64(file, cv.toDataURL('image/png').split(',')[1])
          .then(() => { toast.success(t('图表已导出')); resolveDone(); })
          .catch(reject);
      };
      img.onerror = () => reject(new Error('SVG 转位图失败'));
      img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(xml)))}`;
    }).catch((error) => toast.error(t('导出失败：') + (error && error.message ? error.message : error)));
  }

  build();
  return openModal({
    title: (data && data.title) || t('结果集图表'),
    width: 780,
    body: el('div', { class: 'chart-body' },
      el('div', { class: 'chart-controls' },
        el('label', {}, t('类型')), kindSel,
        el('label', {}, t('类别')), labelSel,
        el('label', {}, t('数值')), valueSel,
        el('span', { class: 'spring' }),
        el('button', { class: 'pbtn', onClick: exportPng }, t('导出 PNG'))),
      canvasHost,
      note),
    buttons: [{ label: t('关闭'), primary: true }],
  });
}
