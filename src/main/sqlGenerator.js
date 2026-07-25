// Generate editable SQL templates from live table metadata.
// Placeholders intentionally use <column> so a template cannot be executed
// accidentally before the user supplies values.

const KINDS = new Set(['select', 'insert', 'update', 'delete', 'merge', 'ddl']);

function normalizeDialect(adapter) {
  return String(adapter && adapter.dialect || 'sql').toLowerCase();
}

function bareQualifiedName(dialect, db, schema, table) {
  const parts = [];
  if (dialect === 'mysql' || dialect === 'clickhouse' || dialect === 'oracle' || dialect === 'oracle12') {
    if (db) parts.push(db);
  } else if (dialect !== 'sqlite' && schema) {
    parts.push(schema);
  }
  parts.push(table);
  return parts.join('.');
}

function tableName(adapter, args, options) {
  if (!options.fullyQualified) {
    return options.quoteIdentifiers ? adapter.quoteIdent(args.table) : String(args.table);
  }
  if (options.quoteIdentifiers) return adapter.qualify(args.db, args.schema, args.table);
  return bareQualifiedName(normalizeDialect(adapter), args.db, args.schema, args.table);
}

function columnName(adapter, name, options) {
  return options.quoteIdentifiers ? adapter.quoteIdent(name) : String(name);
}

function isGeneratedColumn(column) {
  const extra = String(column && column.extra || '');
  return /\b(auto_increment|identity|generated|computed|virtual|stored|materialized|alias|hidden)\b/i.test(extra);
}

function writableColumns(columns) {
  return columns.filter((column) => column && column.name && !isGeneratedColumn(column));
}

function formatColumnList(adapter, columns, options, indent = '  ') {
  return columns.map((column) => `${indent}${columnName(adapter, column.name, options)}`).join(',\n');
}

function placeholder(column) {
  return `<${column.name}>`;
}

function safeWhere(adapter, pk, options, alias) {
  if (!pk.length) {
    return {
      sql: '1 = 0',
      warning: '该表没有主键，已使用 WHERE 1 = 0 防止误更新或误删除；执行前请补充准确条件。',
    };
  }
  return {
    sql: pk.map((name) => {
      const left = `${alias ? `${alias}.` : ''}${columnName(adapter, name, options)}`;
      return `${left} = <${name}>`;
    }).join('\n  AND '),
  };
}

function selectSql(adapter, args, info, options, T) {
  const columns = info.columns || [];
  const projection = options.explicitColumns && columns.length
    ? `\n${formatColumnList(adapter, columns, options)}\n`
    : '*\n';
  return `SELECT ${projection}FROM ${T};`;
}

function insertSql(adapter, info, options, T, warnings) {
  const columns = writableColumns(info.columns || []);
  if (!columns.length) {
    warnings.push('没有可写字段，已生成数据库默认值插入语句。');
    return normalizeDialect(adapter) === 'mysql'
      ? `INSERT INTO ${T} () VALUES ();`
      : `INSERT INTO ${T} DEFAULT VALUES;`;
  }
  const names = formatColumnList(adapter, columns, options);
  const values = columns.map((column) => `  ${placeholder(column)}`).join(',\n');
  return `INSERT INTO ${T} (\n${names}\n)\nVALUES (\n${values}\n);`;
}

function updateSql(adapter, info, options, T, warnings) {
  const pk = Array.isArray(info.pk) ? info.pk.filter(Boolean) : [];
  let columns = writableColumns(info.columns || []).filter((column) => !pk.includes(column.name));
  if (!columns.length) columns = writableColumns(info.columns || []);
  if (!columns.length) throw new Error('该表没有可用于生成 UPDATE 的字段');
  const setSql = columns.map((column) =>
    `  ${columnName(adapter, column.name, options)} = ${placeholder(column)}`).join(',\n');
  const where = safeWhere(adapter, pk, options);
  if (where.warning) warnings.push(where.warning);
  const prefix = normalizeDialect(adapter) === 'clickhouse'
    ? `ALTER TABLE ${T} UPDATE`
    : `UPDATE ${T}\nSET`;
  return `${prefix}\n${setSql}\nWHERE ${where.sql};`;
}

function deleteSql(adapter, info, options, T, warnings) {
  const pk = Array.isArray(info.pk) ? info.pk.filter(Boolean) : [];
  const where = safeWhere(adapter, pk, options);
  if (where.warning) warnings.push(where.warning);
  const prefix = normalizeDialect(adapter) === 'clickhouse'
    ? `ALTER TABLE ${T} DELETE`
    : `DELETE FROM ${T}`;
  return `${prefix}\nWHERE ${where.sql};`;
}

function mergeSql(adapter, info, options, T, warnings) {
  const dialect = normalizeDialect(adapter);
  if (!['mssql', 'postgres', 'oracle', 'oracle12'].includes(dialect)) {
    throw new Error('当前数据库不支持生成 MERGE 模板');
  }
  const pk = Array.isArray(info.pk) ? info.pk.filter(Boolean) : [];
  if (!pk.length) throw new Error('生成 MERGE 需要表具有主键');
  const allColumns = info.columns || [];
  const writable = writableColumns(allColumns);
  const sourceColumns = allColumns.filter((column) => pk.includes(column.name) || writable.includes(column));
  if (!writable.length) throw new Error('该表没有可用于生成 MERGE 的字段');
  const nonPk = writable.filter((column) => !pk.includes(column.name));
  const q = (name) => columnName(adapter, name, options);
  const on = pk.map((name) => `target_row.${q(name)} = source_row.${q(name)}`).join('\n  AND ');
  const update = nonPk.length
    ? `WHEN MATCHED THEN\n  UPDATE SET\n${nonPk.map((column) =>
      `    target_row.${q(column.name)} = source_row.${q(column.name)}`).join(',\n')}\n`
    : '';
  const sourceNames = sourceColumns.map((column) => q(column.name)).join(', ');
  const insertNames = writable.map((column) => q(column.name)).join(', ');
  const insertValues = writable.map((column) => `source_row.${q(column.name)}`).join(', ');
  let source;
  if (dialect === 'oracle' || dialect === 'oracle12') {
    source = `(SELECT\n${sourceColumns.map((column) =>
      `  ${placeholder(column)} AS ${q(column.name)}`).join(',\n')}\n FROM dual)`;
  } else {
    source = `(VALUES (\n${sourceColumns.map((column) => `  ${placeholder(column)}`).join(',\n')}\n))`;
  }
  if (dialect === 'postgres') warnings.push('MERGE 需要 PostgreSQL 15 或更高版本。');
  const targetAlias = dialect === 'oracle' || dialect === 'oracle12' ? ' target_row' : ' AS target_row';
  const sourceAlias = dialect === 'oracle' || dialect === 'oracle12'
    ? ' source_row'
    : ` AS source_row (${sourceNames})`;
  return `MERGE INTO ${T}${targetAlias}\nUSING ${source}${sourceAlias}\nON (${on})\n`
    + update
    + `WHEN NOT MATCHED THEN\n  INSERT (${insertNames})\n  VALUES (${insertValues});`;
}

function ddlSql(info, warnings, dialect, isView) {
  const sql = String(info && info.ddl || '').trim();
  if (!sql) throw new Error('未能读取该对象的 DDL');
  if (!isView && ['postgres', 'mssql', 'oracle', 'oracle12'].includes(dialect)) {
    warnings.push('该 DDL 由元数据合成，请在执行前检查数据库特有属性。');
  }
  return /;\s*$/.test(sql) ? sql : `${sql};`;
}

function generateFromInfo(adapter, args, info) {
  if (!adapter || typeof adapter.quoteIdent !== 'function' || typeof adapter.qualify !== 'function') {
    throw new Error('数据库适配器无效');
  }
  const kind = String(args && args.kind || '').toLowerCase();
  if (!KINDS.has(kind)) throw new Error(`不支持的 SQL 类型：${kind || '空'}`);
  if (!args || !args.table) throw new Error('表名不能为空');
  if (args.isView && !['select', 'ddl'].includes(kind)) throw new Error('视图只支持生成 SELECT 或 DDL');
  const options = {
    fullyQualified: !args.options || args.options.fullyQualified !== false,
    quoteIdentifiers: !args.options || args.options.quoteIdentifiers !== false,
    explicitColumns: !args.options || args.options.explicitColumns !== false,
  };
  const warnings = [];
  const dialect = normalizeDialect(adapter);
  const T = tableName(adapter, args, options);
  let sql;
  if (kind === 'select') sql = selectSql(adapter, args, info, options, T);
  else if (kind === 'insert') sql = insertSql(adapter, info, options, T, warnings);
  else if (kind === 'update') sql = updateSql(adapter, info, options, T, warnings);
  else if (kind === 'delete') sql = deleteSql(adapter, info, options, T, warnings);
  else if (kind === 'merge') sql = mergeSql(adapter, info, options, T, warnings);
  else sql = ddlSql(info, warnings, dialect, !!args.isView);
  return { sql, kind, dialect, tableName: T, warnings, options };
}

async function generateTableSql(adapter, args) {
  const info = await adapter.tableInfo(args.db, args.schema, args.table) || {};
  if (args.isView && String(args.kind).toLowerCase() === 'ddl'
      && typeof adapter.viewDdl === 'function') {
    info.ddl = await adapter.viewDdl(args.db, args.schema, args.table, info);
  }
  return generateFromInfo(adapter, args, info);
}

module.exports = { generateTableSql, generateFromInfo };
