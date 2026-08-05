// 「选项」对话框：应用设置的统一入口。
//
// 在此之前主题在工具栏、结果行数在查询页下拉、每页行数在表格底部、AI 配置在菜单里，
// 用户要记住四个地方。这里把它们收成一处，后续新增设置项只需要在这里加一组。
//
// 文案统一走 t()（见 i18n.js 的约定），这是新代码的样板。
import { el } from './util.js';
import { openModal, toast } from './toast.js';
import { t } from './i18n.js';
import { allSettings, updateSettings } from './settings.js';
import { KEYMAPS } from './keymaps.js';

/** 一组设置：标题 + 若干行 */
function group(title, ...rows) {
  return el('div', { class: 'settings-group' },
    el('div', { class: 'settings-group-title' }, title),
    ...rows);
}

/** 一行设置：左标签、右控件、下方可选说明 */
function row(label, control, hint) {
  return el('div', { class: 'settings-row' },
    el('label', { class: 'settings-label' }, label),
    el('div', { class: 'settings-control' },
      control,
      hint ? el('div', { class: 'settings-hint' }, hint) : null));
}

/** 下拉选择：改动即保存 */
function select(key, options, current, onSaved) {
  const sel = el('select', { class: 'settings-select' },
    ...options.map(([value, label]) =>
      el('option', { value: String(value) }, label)));
  sel.value = String(current);
  sel.addEventListener('change', async () => {
    const raw = sel.value;
    const value = options.some(([v]) => typeof v === 'number') ? Number(raw) : raw;
    try {
      const saved = await updateSettings({ [key]: value });
      sel.value = String(saved[key]); // 主进程校验后可能回落，以落盘值为准
      if (onSaved) onSaved(saved);
    } catch (error) {
      toast.error(t('设置保存失败：') + (error && error.message ? error.message : error));
      sel.value = String(allSettings()[key]);
    }
  });
  return sel;
}

/** 快捷键方案：选中哪套，下面的说明就跟着换 */
function keymapGroup(current) {
  const schemeHint = el('div', {});
  const hint = el('div', { class: 'settings-hint' },
    schemeHint,
    el('div', {}, t('切换后立即生效，已打开的查询标签页也会跟着变。')));
  const describe = (name) => {
    const scheme = KEYMAPS[name] || KEYMAPS.dbpanda;
    schemeHint.textContent = t(scheme.hint);
  };
  const control = select(
    'keymap',
    Object.entries(KEYMAPS).map(([name, scheme]) => [name, t(scheme.label)]),
    current.keymap,
    (saved) => describe(saved.keymap),
  );
  describe(current.keymap);
  return el('div', { class: 'settings-group' },
    el('div', { class: 'settings-group-title' }, t('快捷键')),
    el('div', { class: 'settings-row' },
      el('label', { class: 'settings-label' }, t('方案')),
      el('div', { class: 'settings-control' }, control, hint)));
}

export function openSettingsDialog() {
  const current = allSettings();

  const body = el('div', { class: 'settings-body' },
    group(t('外观'),
      row(t('主题'),
        select('theme', [['light', t('浅色')], ['dark', t('深色')], ['system', t('跟随系统')]], current.theme),
        t('切换后立即生效，下次启动自动沿用。')),
      row(t('界面缩放'),
        select('uiScale', [[100, '100%'], [125, '125%'], [150, '150%']], current.uiScale),
        t('整体等比放大，适合高分屏。'))),

    keymapGroup(current),

    group(t('查询'),
      row(t('结果行数上限'),
        select('queryMaxRows', [[200, '200'], [2000, '2000'], [10000, '10000']], current.queryMaxRows),
        t('新建查询标签页的默认值；已打开的标签页保持当前设置不变。')),
      row(t('影响范围预检'),
        select('impactPreview', [
          ['risky', t('仅高风险时提示')], ['always', t('每次写操作都提示')], ['off', t('关闭')],
        ], current.impactPreview),
        t('执行 UPDATE / DELETE 前先用同样的 WHERE 统计受影响行数。高风险指：没有 WHERE、影响超过 1000 行、或无法安全预估。'))),

    group(t('数据网格'),
      row(t('每页行数'),
        select('tablePageSize', [[100, '100'], [500, '500'], [1000, '1000']], current.tablePageSize),
        t('新打开的表使用该值；已打开的表保持当前设置不变。')),
      row(t('行高'),
        select('gridDensity', [
          ['compact', t('紧凑')], ['default', t('标准')], ['comfortable', t('舒适')],
        ], current.gridDensity),
        t('紧凑档一屏能多看约三分之一的数据。'))),

    group(t('AI 助手'),
      row(t('接口与模型'),
        el('button', {
          class: 'btn',
          onClick: async () => {
            const { openAiConfigDialog } = await import('./aiConfigDialog.js');
            openAiConfigDialog();
          },
        }, t('打开 AI 助手设置…')),
        t('API Key 由主进程加密保存，不会出现在这里。'))),
  );

  return openModal({
    title: t('选项'),
    body,
    width: 520,
    buttons: [{ label: t('关闭'), primary: true }],
  });
}
