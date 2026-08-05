// 数据字典导出对话框：选格式 → 选文件 → 导出。
//
// 交付项目里「给我一份数据字典」是高频要求，之前只能自己拼 SQL 查 information_schema。
import { el } from './util.js';
import { openModal, toast } from './toast.js';
import { t } from './i18n.js';
import { connLabel } from './state.js';
import { startTask } from './taskCenter.js';

const FORMATS = [
  ['markdown', 'Markdown (.md)', 'md', t('适合放进 Git 仓库或 Wiki')],
  ['html', 'HTML (.html)', 'html', t('可直接打开、可打印成 PDF')],
  ['xlsx', 'Excel (.xlsx)', 'xlsx', t('三个工作表：目录 / 字段明细 / 索引与外键')],
];

export function openDataDictDialog(target) {
  if (!target || !target.connId || !target.db) {
    toast.info(t('请先在左侧选择一个数据库'));
    return null;
  }

  const formatSel = el('select', { class: 'settings-select' },
    ...FORMATS.map(([value, label]) => el('option', { value }, label)));
  const formatHint = el('div', { class: 'settings-hint' });
  const syncHint = () => {
    const found = FORMATS.find((f) => f[0] === formatSel.value);
    formatHint.textContent = found ? found[3] : '';
  };
  formatSel.addEventListener('change', syncHint);
  syncHint();

  const includeViews = el('input', { type: 'checkbox' });
  const status = el('div', { class: 'settings-hint' });
  let running = false;

  async function run() {
    if (running) return false;
    const found = FORMATS.find((f) => f[0] === formatSel.value) || FORMATS[0];
    const [format, label, ext] = found;
    const base = `${target.db}${target.schema ? `-${target.schema}` : ''}-数据字典`;
    const file = await window.api.dlg.saveFile({
      title: t('导出数据字典'),
      defaultPath: `${base}.${ext}`,
      filters: [{ name: label, extensions: [ext] }],
    });
    if (!file) return false;
    running = true;
    status.textContent = t('正在读取表结构…');
    const task = startTask({
      title: t('导出数据字典'), kind: 'datadict', connName: connLabel(target.connId), detail: file,
    });
    const off = window.api.dba.onProgress((p) => {
      if (p && p.total) {
        status.textContent = t('正在读取表结构 {done}/{total}…', { done: p.done, total: p.total });
        task.progress(status.textContent, (p.done / p.total) * 100);
      }
    });
    try {
      const result = await window.api.dba.dataDict(target.connId, {
        db: target.db, schema: target.schema, format, file, includeViews: includeViews.checked,
      });
      const message = result.failed
        ? t('已导出 {n} 个对象（{f} 个读取失败）', { n: result.tables, f: result.failed })
        : t('已导出 {n} 个对象', { n: result.tables });
      toast.success(message);
      task.done(message);
      return true;
    } catch (error) {
      toast.error(t('导出失败：') + (error && error.message ? error.message : error));
      status.textContent = '';
      task.fail(error);
      return false;
    } finally {
      running = false;
      off();
    }
  }

  const body = el('div', { class: 'settings-body' },
    el('div', { class: 'settings-group' },
      el('div', { class: 'settings-group-title' }, t('范围')),
      el('div', { class: 'settings-row' },
        el('label', { class: 'settings-label' }, t('数据库')),
        el('div', { class: 'settings-control' },
          el('div', {}, `${connLabel(target.connId)} / ${target.db}${target.schema ? ` / ${target.schema}` : ''}`),
          el('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px' } },
            includeViews, el('span', {}, t('同时包含视图')))))),
    el('div', { class: 'settings-group' },
      el('div', { class: 'settings-group-title' }, t('格式')),
      el('div', { class: 'settings-row' },
        el('label', { class: 'settings-label' }, t('导出为')),
        el('div', { class: 'settings-control' }, formatSel, formatHint, status))),
  );

  return openModal({
    title: t('导出数据字典'),
    width: 520,
    body,
    buttons: [
      { label: t('取消') },
      {
        label: t('导出…'),
        primary: true,
        onClick: () => { run(); return false; }, // 保持对话框打开，进度显示在里面
      },
    ],
  });
}
