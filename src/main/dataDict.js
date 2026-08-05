// 数据字典导出：把整库的表结构说明导成可交付的文档。
//
// 国内交付项目几乎必备，而 Navicat 只能间接凑出来——这是投入很小、感知很强的一项。
// 元数据全部复用现有适配层（listObjects / tableInfo / listForeignKeys），不新增方言代码。
const fs = require('fs');

function esc(text) {
  return String(text === null || text === undefined ? '' : text);
}

/** Markdown 表格单元格：竖线要转义，换行要压平，否则表格会散架 */
function mdCell(value) {
  return esc(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function htmlEsc(value) {
  return esc(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 收集一个库（或模式）下所有表的结构 */
async function collect(adapter, { db, schema, includeViews = false, onProgress } = {}) {
  const objects = await adapter.listObjects(db, schema);
  const entries = [
    ...(objects.tables || []).map((item) => ({ ...item, kind: 'table' })),
    ...(includeViews ? (objects.views || []).map((item) => ({ ...item, kind: 'view' })) : []),
  ];
  const tables = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (onProgress) onProgress({ done: i, total: entries.length, name: entry.name });
    let info = { columns: [], indexes: [], pk: [] };
    let foreignKeys = [];
    try {
      info = await adapter.tableInfo(db, schema, entry.name);
      foreignKeys = await adapter.listForeignKeys(db, schema, entry.name);
    } catch (error) {
      // 单张表读不出来不能让整份字典失败：记下原因，继续下一张
      tables.push({
        name: entry.name, kind: entry.kind, comment: entry.comment || '',
        error: (error && error.message) || String(error),
        columns: [], indexes: [], foreignKeys: [], pk: [],
      });
      continue;
    }
    tables.push({
      name: entry.name,
      kind: entry.kind,
      comment: entry.comment || '',
      rows: entry.rows === undefined ? null : entry.rows,
      engine: entry.engine || '',
      pk: info.pk || [],
      columns: info.columns || [],
      indexes: info.indexes || [],
      foreignKeys: foreignKeys || [],
    });
  }
  if (onProgress) onProgress({ done: entries.length, total: entries.length });
  return {
    db: db || '',
    schema: schema || '',
    generatedAt: new Date().toISOString(),
    tables,
  };
}

const COLUMN_HEADERS = ['字段', '类型', '可空', '主键', '默认值', '注释'];

function columnRow(column, pk) {
  const isPk = (pk || []).includes(column.name);
  return [
    column.name,
    column.type || '',
    column.nullable === false ? '否' : '是',
    isPk ? '是' : '',
    column.default === null || column.default === undefined ? '' : String(column.default),
    column.comment || '',
  ];
}

function toMarkdown(dict) {
  const out = [];
  const title = dict.schema ? `${dict.db} / ${dict.schema}` : dict.db;
  out.push(`# 数据字典 — ${title}`, '');
  out.push(`生成时间：${new Date(dict.generatedAt).toLocaleString('zh-CN')}　·　共 ${dict.tables.length} 个对象`, '');
  out.push('## 目录', '');
  for (const table of dict.tables) {
    out.push(`- ${table.name}${table.comment ? ` — ${table.comment}` : ''}`);
  }
  out.push('');
  for (const table of dict.tables) {
    out.push(`## ${table.name}${table.kind === 'view' ? '（视图）' : ''}`, '');
    if (table.comment) out.push(`> ${table.comment}`, '');
    if (table.error) { out.push(`⚠ 读取失败：${table.error}`, ''); continue; }
    out.push(`| ${COLUMN_HEADERS.join(' | ')} |`);
    out.push(`| ${COLUMN_HEADERS.map(() => '---').join(' | ')} |`);
    for (const column of table.columns) {
      out.push(`| ${columnRow(column, table.pk).map(mdCell).join(' | ')} |`);
    }
    out.push('');
    if (table.indexes.length) {
      out.push('**索引**', '');
      for (const index of table.indexes) {
        const kind = index.primary ? '主键' : (index.unique ? '唯一' : '普通');
        out.push(`- \`${index.name}\`（${kind}）：${(index.columns || []).join(', ')}`);
      }
      out.push('');
    }
    if (table.foreignKeys.length) {
      out.push('**外键**', '');
      for (const fk of table.foreignKeys) {
        out.push(`- \`${fk.name}\`：${(fk.columns || []).join(', ')} → ${fk.refTable}.${(fk.refColumns || []).join(', ')}`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

function toHtml(dict) {
  const title = dict.schema ? `${dict.db} / ${dict.schema}` : dict.db;
  const sections = dict.tables.map((table) => {
    if (table.error) {
      return `<section><h2>${htmlEsc(table.name)}</h2><p class="err">读取失败：${htmlEsc(table.error)}</p></section>`;
    }
    const rows = table.columns.map((column) =>
      `<tr>${columnRow(column, table.pk).map((cell) => `<td>${htmlEsc(cell)}</td>`).join('')}</tr>`).join('');
    const indexes = table.indexes.length
      ? `<p class="sub">索引</p><ul>${table.indexes.map((index) =>
        `<li><code>${htmlEsc(index.name)}</code>（${index.primary ? '主键' : (index.unique ? '唯一' : '普通')}）：${htmlEsc((index.columns || []).join(', '))}</li>`).join('')}</ul>`
      : '';
    const fks = table.foreignKeys.length
      ? `<p class="sub">外键</p><ul>${table.foreignKeys.map((fk) =>
        `<li><code>${htmlEsc(fk.name)}</code>：${htmlEsc((fk.columns || []).join(', '))} → ${htmlEsc(fk.refTable)}.${htmlEsc((fk.refColumns || []).join(', '))}</li>`).join('')}</ul>`
      : '';
    return `<section><h2>${htmlEsc(table.name)}${table.kind === 'view' ? '<span class="tag">视图</span>' : ''}</h2>`
      + (table.comment ? `<p class="cmt">${htmlEsc(table.comment)}</p>` : '')
      + `<table><thead><tr>${COLUMN_HEADERS.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`
      + indexes + fks + '</section>';
  }).join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>数据字典 — ${htmlEsc(title)}</title>
<style>
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:32px;color:#1f2329;background:#fff;line-height:1.6}
h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:28px 0 8px;padding-bottom:6px;border-bottom:1px solid #e7eaee}
.meta{color:#6b7280;font-size:13px;margin-bottom:24px}
.cmt{color:#6b7280;font-size:13px;margin:0 0 8px}
.sub{font-size:13px;font-weight:600;margin:12px 0 4px}
.tag{margin-left:8px;padding:1px 6px;border-radius:3px;background:#eef0f7;color:#4b57d6;font-size:12px;font-weight:400}
.err{color:#d93026;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #e7eaee;padding:6px 9px;text-align:left;vertical-align:top}
th{background:#f3f5f8;font-weight:600}
ul{margin:4px 0 0 18px;padding:0;font-size:13px}code{font-family:Consolas,monospace;background:#f3f5f8;padding:1px 4px;border-radius:3px}
</style></head><body>
<h1>数据字典 — ${htmlEsc(title)}</h1>
<p class="meta">生成时间：${htmlEsc(new Date(dict.generatedAt).toLocaleString('zh-CN'))}　·　共 ${dict.tables.length} 个对象</p>
${sections}
</body></html>`;
}

async function writeXlsx(dict, file) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: false, useSharedStrings: false });
  const overview = wb.addWorksheet('目录');
  overview.addRow(['表名', '类型', '注释', '字段数', '行数(约)']).commit();
  for (const table of dict.tables) {
    overview.addRow([
      table.name, table.kind === 'view' ? '视图' : '表', table.comment || '',
      table.columns.length, table.rows === null ? '' : table.rows,
    ]).commit();
  }
  overview.commit();

  const detail = wb.addWorksheet('字段明细');
  detail.addRow(['表名', '表注释', ...COLUMN_HEADERS]).commit();
  for (const table of dict.tables) {
    if (table.error) {
      detail.addRow([table.name, `读取失败：${table.error}`]).commit();
      continue;
    }
    for (const column of table.columns) {
      detail.addRow([table.name, table.comment || '', ...columnRow(column, table.pk)]).commit();
    }
  }
  detail.commit();

  const indexSheet = wb.addWorksheet('索引与外键');
  indexSheet.addRow(['表名', '类别', '名称', '字段', '引用']).commit();
  for (const table of dict.tables) {
    for (const index of table.indexes) {
      indexSheet.addRow([
        table.name, index.primary ? '主键' : (index.unique ? '唯一索引' : '索引'),
        index.name, (index.columns || []).join(', '), '',
      ]).commit();
    }
    for (const fk of table.foreignKeys) {
      indexSheet.addRow([
        table.name, '外键', fk.name, (fk.columns || []).join(', '),
        `${fk.refTable}.${(fk.refColumns || []).join(', ')}`,
      ]).commit();
    }
  }
  indexSheet.commit();
  await wb.commit();
}

/** format: 'markdown' | 'html' | 'xlsx' */
async function exportDict(adapter, { db, schema, format, file, includeViews, onProgress } = {}) {
  const dict = await collect(adapter, { db, schema, includeViews, onProgress });
  if (format === 'xlsx') {
    await writeXlsx(dict, file);
  } else {
    const text = format === 'html' ? toHtml(dict) : toMarkdown(dict);
    await fs.promises.writeFile(file, text, 'utf8');
  }
  return { tables: dict.tables.length, failed: dict.tables.filter((t) => t.error).length, file };
}

module.exports = { collect, toMarkdown, toHtml, exportDict };
