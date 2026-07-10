// 导出格式菜单（表 / 结果集共用）：CSV、JSON、SQL、Excel、Markdown
import { showMenu } from './contextmenu.js';
import { toast, promptDialog } from './toast.js';
import { authorizeOperation } from './danger.js';

const FORMATS = [
  { key: 'csv', label: 'CSV 文件 (*.csv)', ext: 'csv' },
  { key: 'xlsx', label: 'Excel 工作簿 (*.xlsx)', ext: 'xlsx' },
  { key: 'json', label: 'JSON 文件 (*.json)', ext: 'json' },
  { key: 'sql', label: 'SQL 插入语句 (*.sql)', ext: 'sql' },
  { key: 'md', label: 'Markdown 表格 (*.md)', ext: 'md' },
];

function resultNotes(result) {
  const notes = [];
  if (result.snapshotConsistent === false) {
    notes.push('已使用主键游标分页；导出期间若数据被修改，结果不代表单一时间点快照。');
  }
  if (result.formulaEscaped) {
    notes.push(`为防止表格公式注入，CSV 中 ${result.formulaEscaped.toLocaleString()} 个危险前缀单元格已添加英文单引号；需字节级原值请改用 JSON。`);
  }
  return notes.length ? '\n注意：' + notes.join('\n') : '';
}

async function pickPath(defaultName, fmt) {
  return window.api.dlg.saveFile({
    title: '导出为 ' + fmt.label,
    defaultPath: `${defaultName}.${fmt.ext}`,
    filters: [{ name: fmt.label, extensions: [fmt.ext] }],
  });
}

/** 整表导出：showTableExportMenu(x, y, target, where) */
export function showTableExportMenu(x, y, target, where) {
  showMenu(x, y, FORMATS.map((fmt) => ({
    label: fmt.label,
    icon: 'exportIcon',
    onClick: async () => {
      const file = await pickPath(target.table, fmt);
      if (!file) return;
      try {
        const approved = await authorizeOperation('db.exportTable', {
          connId: target.connId,
          db: target.db, schema: target.schema, table: target.table,
          where: where || '', file, format: fmt.key,
        });
        if (!approved) return;
        toast.info(`正在导出 ${target.table} (${fmt.key.toUpperCase()}) …`);
        const r = await window.api.db.exportTable(target.connId, approved);
        const notes = resultNotes(r);
        toast.success(`导出完成：${r.rows.toLocaleString()} 行\n${r.file}${notes}`, notes ? 10000 : 5000);
      } catch (e) {
        toast.error('导出失败: ' + e.message);
      }
    },
  })));
}

/** 结果集导出：showRowsExportMenu(x, y, {connId, columns, rows, defaultName}) */
export function showRowsExportMenu(x, y, data) {
  showMenu(x, y, FORMATS.map((fmt) => ({
    label: fmt.label,
    icon: 'exportIcon',
    onClick: async () => {
      let sqlTableName = null;
      if (fmt.key === 'sql') {
        sqlTableName = await promptDialog('导出 SQL', 'INSERT 目标表名:', data.defaultName || 'exported_table');
        if (!sqlTableName) return;
      }
      const file = await pickPath(data.defaultName || 'result', fmt);
      if (!file) return;
      try {
        const r = await window.api.db.exportRows(data.connId, {
          file, format: fmt.key, columns: data.columns, rows: data.rows, sqlTableName,
        });
        const notes = resultNotes(r);
        toast.success(`已导出 ${r.rows.toLocaleString()} 行\n${r.file}${notes}`, notes ? 10000 : 5000);
      } catch (e) {
        toast.error('导出失败: ' + e.message);
      }
    },
  })));
}
