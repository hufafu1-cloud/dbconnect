import { el } from './util.js';
import { openModal, toast } from './toast.js';
import { getPreferences, loadPreferences, patchPreferences } from './preferences.js';
import { applyTheme } from './app.js';

const select = (value, options) => el('select', {}, ...options.map(([v, text]) => el('option', { value: v, selected: String(value) === String(v) ? 'selected' : undefined }, text)));
export async function openSettingsDialog() {
  const p = await loadPreferences();
  const theme = select(p.ui.theme, [['light', '浅色'], ['dark', '深色']]);
  const density = select(p.ui.density, [['comfortable', '舒适'], ['compact', '紧凑']]);
  const toolbar = select(p.ui.toolbar, [['compact', '紧凑工具栏'], ['full', '完整工具栏']]);
  const maxRows = select(p.editor.maxRows, [[200, '200 行'], [2000, '2000 行'], [10000, '10000 行']]);
  const tabSize = select(p.editor.tabSize, [[2, '2 空格'], [4, '4 空格']]);
  const wrapping = el('input', { type: 'checkbox', checked: !!p.editor.lineWrapping });
  const row = (label, control, tip) => el('div', { class: 'settings-row', title: tip || '' }, el('label', {}, label), control);
  const section = (title, ...rows) => el('section', { class: 'settings-section' }, el('h4', {}, title), ...rows);
  const body = el('div', { class: 'settings-form' },
    section('外观', row('主题', theme), row('界面密度', density, '紧凑模式将减少树和表格的行高'), row('顶部工具栏', toolbar)),
    section('查询编辑器', row('默认结果行数', maxRows), row('缩进', tabSize), row('自动换行', wrapping)),
    section('快捷键', el('div', { style: { color: 'var(--text-muted)', lineHeight: '1.8' } }, 'Ctrl+P 全局搜索 · Ctrl+Shift+P 命令面板 · Ctrl+Tab 切换标签 · Ctrl+W 关闭标签 · Ctrl+, 打开设置')),
  );
  return openModal({ title: '设置', body, width: 600, buttons: [
    { label: '恢复默认', onClick: async () => { await window.api.preferences.reset(); location.reload(); return false; } },
    { label: '取消' },
    { label: '保存', primary: true, onClick: async () => {
      const next = await patchPreferences({ ui: { theme: theme.value, density: density.value, toolbar: toolbar.value }, editor: { maxRows: Number(maxRows.value), tabSize: Number(tabSize.value), lineWrapping: wrapping.checked } });
      applyTheme(next.ui.theme); document.documentElement.dataset.density = next.ui.density;
      document.querySelector('#toolbar')?.classList.toggle('toolbar-compact', next.ui.toolbar === 'compact');
      toast.success('设置已保存，已打开的编辑器将在下次打开时应用编辑器设置');
    } },
  ] });
}
