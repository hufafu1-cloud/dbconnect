import { el } from './util.js';
import { openModal, toast } from './toast.js';
import { openQueryTab } from './queryTab.js';

const SETTINGS_KEY = 'dbpanda.generatedSql.options';

function loadOptions() {
  try {
    return {
      fullyQualified: true,
      quoteIdentifiers: true,
      explicitColumns: true,
      ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'),
    };
  } catch (e) {
    return { fullyQualified: true, quoteIdentifiers: true, explicitColumns: true };
  }
}

function saveOptions(options) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(options)); } catch (e) { /* ignore */ }
}

function optionCheckbox(label, checked, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'generated-sql-option' }, input, el('span', {}, label));
}

export function openGeneratedSqlDialog(target, kind, isView = false) {
  const options = loadOptions();
  const textarea = el('textarea', {
    class: 'generated-sql-editor',
    spellcheck: false,
    readOnly: true,
    'aria-label': 'SQL 预览',
  });
  const status = el('div', { class: 'generated-sql-status' }, '正在读取表结构并生成 SQL…');
  const warnings = el('div', { class: 'generated-sql-warnings' });
  const settings = el('div', { class: 'generated-sql-settings' },
    optionCheckbox('使用完整限定名', options.fullyQualified, (value) => {
      options.fullyQualified = value; regenerate();
    }),
    optionCheckbox('引用表名和字段名', options.quoteIdentifiers, (value) => {
      options.quoteIdentifiers = value; regenerate();
    }),
    kind === 'select' ? optionCheckbox('SELECT 展开全部字段', options.explicitColumns, (value) => {
      options.explicitColumns = value; regenerate();
    }) : null);
  const body = el('div', { class: 'generated-sql-dialog' },
    el('div', { class: 'generated-sql-label' }, 'SQL 预览'),
    textarea,
    status,
    warnings,
    el('div', { class: 'generated-sql-label generated-sql-settings-label' }, '设置'),
    settings);

  let sql = '';
  let requestVersion = 0;
  let modal;

  async function regenerate() {
    const version = ++requestVersion;
    saveOptions(options);
    textarea.readOnly = true;
    textarea.value = '';
    status.textContent = '正在读取表结构并生成 SQL…';
    status.classList.remove('error');
    warnings.replaceChildren();
    try {
      const result = await window.api.db.generateTableSql(target.connId, {
        db: target.db,
        schema: target.schema,
        table: target.table,
        kind,
        isView,
        options,
      });
      if (version !== requestVersion) return;
      sql = result.sql || '';
      textarea.value = sql;
      textarea.readOnly = false;
      status.textContent = `${String(result.dialect || '').toUpperCase()} · ${result.tableName || target.table}`;
      for (const warning of result.warnings || []) {
        warnings.append(el('div', {}, `注意：${warning}`));
      }
    } catch (error) {
      if (version !== requestVersion) return;
      sql = '';
      status.textContent = error.message || '生成 SQL 失败';
      status.classList.add('error');
    }
  }

  modal = openModal({
    title: `生成 ${String(kind).toUpperCase()} SQL`,
    body,
    width: 880,
    buttons: [
      { label: '关闭' },
      {
        label: '复制 SQL',
        onClick: () => {
          if (!sql) { toast.info('当前没有可复制的 SQL'); return false; }
          navigator.clipboard.writeText(textarea.value).then(
            () => toast.success('SQL 已复制'),
            (error) => toast.error(`复制失败：${error.message}`));
          return false;
        },
      },
      {
        label: '在查询页打开',
        primary: true,
        onClick: () => {
          if (!sql) { toast.info('请先成功生成 SQL'); return false; }
          openQueryTab(target, textarea.value);
          return undefined;
        },
      },
    ],
  });
  regenerate();
  return modal;
}
