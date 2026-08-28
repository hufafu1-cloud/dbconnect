// 列画像面板（路线图 v2.8.0）
//
// 挂在表数据页右侧。**按需触发**——打开表时什么都不做，点了才算，
// 因为它要做一次全表扫描，而「打开表看看数据」是最高频的动作。
//
// 界面上最重要的一行不是数字，是**统计范围的标注**。采样结果和全表结果长得一模一样，
// 不标清楚，用户就会拿采样数字当全表结论用。所以范围条always 显示、非全表时用警示色，
// 并且直接给一个「改为全表统计」的按钮——不让用户去翻设置。
import { el, iconEl, fmtCount } from './util.js';
import { toast } from './toast.js';
import { t } from './i18n.js';

const pct = (rate) => {
  const n = (Number(rate) || 0) * 100;
  if (n === 0) return '0%';
  if (n < 0.1) return '<0.1%';
  return `${n >= 10 ? n.toFixed(0) : n.toFixed(1)}%`;
};

const compactNum = (v) => {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Number.isInteger(n)) return n.toLocaleString();
  return String(Math.round(n * 1000) / 1000);
};

/** 单元格里的取值：null 与空串必须看得出区别 */
function valueText(value) {
  if (value === null || value === undefined) return '(NULL)';
  if (value === '') return '(空串)';
  if (typeof value === 'object' && value.__blob) return `(二进制 ${fmtCount(value.length)} 字节)`;
  const text = String(value);
  return text.length > 40 ? text.slice(0, 40) + '…' : text;
}

export function createProfilePanel(host, target) {
  let data = null;
  let running = false;
  let scope = 'auto';

  const body = el('div', { class: 'profile-body' });
  const title = el('div', { class: 'profile-title' }, t('列画像'));
  const btnRun = el('button', { class: 'pbtn success', onClick: () => run() }, iconEl('run'), t('开始统计'));
  const head = el('div', { class: 'profile-head' }, title, el('span', { class: 'spring' }), btnRun);
  host.append(head, body);

  function renderIdle() {
    body.innerHTML = '';
    body.append(el('div', { class: 'profile-idle' },
      t('统计整张表每一列的空值率、去重数、取值分布与数值分布。'),
      el('div', { class: 'profile-idle-hint' },
        t('要扫一遍表，所以不会自动开始——点上方「开始统计」。'
          + '大表会只统计前若干行，并在结果里标注清楚。'))));
  }

  function renderRunning() {
    body.innerHTML = '';
    body.append(el('div', { class: 'profile-idle' }, t('正在统计…')));
  }

  function renderError(message) {
    body.innerHTML = '';
    body.append(el('div', { class: 'profile-idle' },
      t('统计失败'), el('div', { class: 'profile-idle-hint' }, message)));
  }

  function renderScopeBar() {
    // 采样与全表的结果长得一模一样，范围标注是这个面板最不能省的一行
    const bar = el('div', { class: 'profile-scope' + (data.scope.sampled ? ' sampled' : '') },
      iconEl(data.scope.sampled ? 'info' : 'check'),
      el('span', { class: 'profile-scope-label' }, data.scope.label),
      el('span', { class: 'profile-scope-rows' },
        t('共 {total} 行 · 统计 {scanned} 行 · {ms} ms', {
          total: data.totalRows === null ? '?' : fmtCount(data.totalRows),
          scanned: fmtCount(data.scanned), ms: data.ms,
        })),
      el('span', { class: 'spring' }),
      data.scope.sampled
        ? el('button', {
            class: 'pbtn', onClick: () => run('full'),
            title: t('忽略行数阈值，扫描整张表。表很大时会明显更慢。'),
          }, t('改为全表统计'))
        : null);
    if (data.scope.note) {
      return el('div', {}, bar, el('div', { class: 'profile-scope-note' }, data.scope.note));
    }
    return bar;
  }

  function renderColumn(column) {
    const rows = [];
    rows.push(el('div', { class: 'profile-col-head' },
      el('span', { class: 'profile-col-name', title: column.comment || column.name }, column.name),
      el('span', { class: 'profile-col-type' }, column.type),
      column.unique ? el('span', { class: 'profile-tag unique', title: t('在统计范围内每行取值都不同，可以作为主键或 join 键') }, t('唯一')) : null));

    const metrics = el('div', { class: 'profile-metrics' },
      el('span', {
        class: 'profile-metric' + (column.nullRate >= 0.9 ? ' warn' : ''),
        title: t('{n} 行为空', { n: fmtCount(column.nulls) }),
      }, t('空值 {p}', { p: pct(column.nullRate) })),
      column.distinct === null
        ? null
        : el('span', { class: 'profile-metric' }, t('去重 {n}', { n: fmtCount(column.distinct) })));
    if (column.kind === 'numeric') {
      metrics.append(el('span', { class: 'profile-metric' },
        t('最小 {min} · 平均 {avg} · 最大 {max}', {
          min: compactNum(column.min), avg: compactNum(column.avg), max: compactNum(column.max),
        })));
    }
    rows.push(metrics);

    if (column.top && column.top.length) {
      const list = el('div', { class: 'profile-top' });
      for (const item of column.top) {
        list.append(el('div', { class: 'profile-top-row' },
          el('span', { class: 'profile-top-value', title: valueText(item.value) }, valueText(item.value)),
          el('span', { class: 'profile-bar' },
            el('span', { class: 'profile-bar-fill', style: { width: `${Math.max(1, item.rate * 100)}%` } })),
          el('span', { class: 'profile-top-pct' }, pct(item.rate)),
          el('span', { class: 'profile-top-count' }, fmtCount(item.count))));
      }
      rows.push(list);
    }

    if (column.histogram) {
      const max = Math.max(...column.histogram, 1);
      rows.push(el('div', { class: 'profile-hist', title: t('从最小值到最大值均分 {n} 段', { n: column.histogram.length }) },
        ...column.histogram.map((n) => el('span', {
          class: 'profile-hist-bar',
          style: { height: `${Math.max(2, Math.round((n / max) * 34))}px` },
          title: t('{n} 行', { n: fmtCount(n) }),
        }))));
    }

    if (column.note) rows.push(el('div', { class: 'profile-col-note' }, column.note));
    return el('div', { class: 'profile-col' }, ...rows.filter(Boolean));
  }

  function render() {
    body.innerHTML = '';
    body.append(renderScopeBar());
    if (data.truncatedColumns) {
      body.append(el('div', { class: 'profile-col-note' },
        t('列太多，只统计了前 {n} 列，另有 {r} 列未统计', {
          n: data.columns.length, r: data.truncatedColumns,
        })));
    }
    for (const column of data.columns) body.append(renderColumn(column));
    if (data.failures && data.failures.length) {
      body.append(el('div', { class: 'profile-col-note' },
        t('{n} 项分布统计失败，其余结果不受影响', { n: data.failures.length })));
    }
  }

  async function run(nextScope) {
    if (running) return;
    running = true;
    scope = nextScope || scope;
    btnRun.disabled = true;
    renderRunning();
    try {
      data = await window.api.db.profile(target.connId, {
        db: target.db, schema: target.schema, table: target.table, scope,
      });
      render();
    } catch (error) {
      const message = (error && error.message) || String(error);
      renderError(message);
      toast.error(t('列画像失败：') + message);
    } finally {
      running = false;
      btnRun.disabled = false;
      btnRun.textContent = '';
      btnRun.append(iconEl('refresh'), t('重新统计'));
    }
  }

  renderIdle();
  return { run, get data() { return data; } };
}
