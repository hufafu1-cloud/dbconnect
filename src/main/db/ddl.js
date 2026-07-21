// 表设计器 DDL 构建：根据设计模型生成 CREATE TABLE，或对比新旧模型生成 ALTER 语句
//
// 模型结构（renderer 与 main 共享）：
// model = {
//   table, comment, options,                  // options: 建表附加子句（如 ClickHouse 引擎）
//   columns: [{ name, origName, type, length, scale, notNull, pk, autoInc, def, comment }],
//   indexes: [{ name, origName, columns:[..], unique }],
//   foreignKeys: [{ name, origName, columns:[..], refSchema, refTable,
//                   refColumns:[..], onUpdate, onDelete }],
//   constraints: [{ kind:'unique'|'check', name, origName, columns:[..], expression }],
// }
// def 约定：'' 表示无默认值；其余按“原样/字面量”启发式处理（见 composeDefault）。

/** 各方言常用类型（供设计器下拉提示，允许自由输入） */
const TYPE_OPTIONS = {
  mysql: ['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'float', 'double', 'varchar', 'char',
    'text', 'mediumtext', 'longtext', 'date', 'datetime', 'timestamp', 'time', 'year', 'json',
    'blob', 'longblob', 'enum', 'set', 'boolean'],
  postgres: ['integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision', 'varchar',
    'char', 'text', 'boolean', 'date', 'timestamp', 'timestamptz', 'time', 'interval', 'json',
    'jsonb', 'uuid', 'bytea', 'inet'],
  mssql: ['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money',
    'varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'bit', 'date', 'datetime',
    'datetime2', 'smalldatetime', 'time', 'uniqueidentifier', 'varbinary', 'image'],
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'],
  clickhouse: ['UInt8', 'UInt16', 'UInt32', 'UInt64', 'Int8', 'Int16', 'Int32', 'Int64',
    'Float32', 'Float64', 'Decimal', 'String', 'FixedString', 'Date', 'Date32', 'DateTime',
    'DateTime64', 'Bool', 'UUID', 'Enum8', 'LowCardinality(String)'],
  oracle: ['NUMBER', 'VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'DATE', 'TIMESTAMP', 'FLOAT',
    'CLOB', 'NCLOB', 'BLOB', 'RAW'],
};

/** 各方言能力（设计器据此显示/隐藏控件，构建时据此给告警） */
const FK_ACTIONS = {
  mysql: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL'],
  postgres: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'],
  mssql: ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'],
  sqlite: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'],
  clickhouse: [],
  oracle: ['NO ACTION'],
};

const FK_DELETE_ACTIONS = {
  ...FK_ACTIONS,
  oracle: ['NO ACTION', 'CASCADE', 'SET NULL'],
};

const CAPS = {
  mysql: {
    autoInc: true, comments: true, alterColumn: true, pkChange: true, indexes: true,
    foreignKeys: true, foreignKeyAlter: true, uniqueConstraints: true, checkConstraints: true, constraintAlter: true,
    fkUpdateActions: FK_ACTIONS.mysql, fkDeleteActions: FK_DELETE_ACTIONS.mysql,
  },
  postgres: {
    autoInc: true, comments: true, alterColumn: true, pkChange: true, indexes: true,
    foreignKeys: true, foreignKeyAlter: true, uniqueConstraints: true, checkConstraints: true, constraintAlter: true,
    fkUpdateActions: FK_ACTIONS.postgres, fkDeleteActions: FK_DELETE_ACTIONS.postgres,
  },
  mssql: {
    autoInc: true, comments: false, alterColumn: true, pkChange: true, indexes: true,
    foreignKeys: true, foreignKeyAlter: true, uniqueConstraints: true, checkConstraints: true, constraintAlter: true,
    fkUpdateActions: FK_ACTIONS.mssql, fkDeleteActions: FK_DELETE_ACTIONS.mssql,
  },
  sqlite: {
    autoInc: true, comments: false, alterColumn: false, pkChange: false, indexes: true,
    foreignKeys: true, foreignKeyAlter: false, uniqueConstraints: true, checkConstraints: true, constraintAlter: false,
    fkUpdateActions: FK_ACTIONS.sqlite, fkDeleteActions: FK_DELETE_ACTIONS.sqlite,
  },
  clickhouse: {
    autoInc: false, comments: true, alterColumn: true, pkChange: false, indexes: false,
    foreignKeys: false, foreignKeyAlter: false, uniqueConstraints: false, checkConstraints: false, constraintAlter: false,
    fkUpdateActions: [], fkDeleteActions: [],
  },
  oracle: {
    autoInc: false, comments: true, alterColumn: true, pkChange: true, indexes: true,
    foreignKeys: true, foreignKeyAlter: true, uniqueConstraints: true, checkConstraints: true, constraintAlter: true,
    fkUpdateActions: FK_ACTIONS.oracle, fkDeleteActions: FK_DELETE_ACTIONS.oracle,
  },
};

function caps(dialect) { return CAPS[dialect] || CAPS.mysql; }
function typeOptions(dialect) { return TYPE_OPTIONS[dialect] || TYPE_OPTIONS.mysql; }

/** 组合完整类型串：varchar + 100 -> varchar(100)；decimal + 10,2 -> decimal(10,2) */
function composeType(col, dialect) {
  let t = String(col.type || '').trim();
  if (!t) t = dialect === 'sqlite' ? 'TEXT' : 'varchar';
  const len = String(col.length === undefined || col.length === null ? '' : col.length).trim();
  const scale = String(col.scale === undefined || col.scale === null ? '' : col.scale).trim();
  if (len && !/[()]/.test(t)) {
    t += scale ? `(${len},${scale})` : `(${len})`;
  }
  // ClickHouse 用 Nullable() 包装表达“可空”
  if (dialect === 'clickhouse' && !col.notNull && !/^(Nullable|Array|Map|Tuple|LowCardinality)\(/i.test(t)) {
    t = `Nullable(${t})`;
  }
  return t;
}

/** 默认值：数字/已知函数/带括号或 :: 的表达式原样输出，否则按字符串字面量 */
function composeDefault(adapter, def) {
  const s = String(def).trim();
  if (s === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  if (/^(NULL|TRUE|FALSE)$/i.test(s)) return s.toUpperCase();
  if (/^(CURRENT_(TIMESTAMP|DATE|TIME)(\(\d*\))?|NOW\(\)|GETDATE\(\)|SYSDATETIME\(\)|SYSDATE|SYSTIMESTAMP|UUID\(\)|NEWID\(\)|GEN_RANDOM_UUID\(\))$/i.test(s)) return s;
  if (s.includes('(') || s.includes('::')) return s; // 表达式
  return adapter.literal(s);
}

/** 单列定义（CREATE / ADD / MODIFY 共用主体） */
function columnDef(adapter, dialect, col, opts = {}) {
  const q = (n) => adapter.quoteIdent(n);
  const parts = [q(col.name), composeType(col, dialect)];
  const d = composeDefault(adapter, col.def);
  const metadataName = (value, label) => {
    const text = String(value || '').trim();
    if (!text) return '';
    if (!/^[A-Za-z0-9_$#]+$/.test(text)) throw new Error(`${label}名称无效：${text}`);
    return text;
  };

  if (dialect === 'clickhouse') {
    if (d !== null) parts.push('DEFAULT ' + d);
    if (col.comment) parts.push('COMMENT ' + adapter.literal(col.comment));
    return parts.join(' ');
  }
  if (dialect === 'oracle') {
    if (d !== null) parts.push('DEFAULT ' + d);
    if (col.notNull) parts.push('NOT NULL');
    return parts.join(' ');
  }
  if (dialect === 'mysql') {
    const charset = metadataName(col.charset, '字符集');
    const collation = metadataName(col.collation, '排序规则');
    if (charset) parts.push('CHARACTER SET ' + charset);
    if (collation) parts.push('COLLATE ' + collation);
    parts.push(col.notNull ? 'NOT NULL' : 'NULL');
    if (col.autoInc) parts.push('AUTO_INCREMENT');
    if (d !== null && !col.autoInc) parts.push('DEFAULT ' + d);
    if (col.comment) parts.push('COMMENT ' + adapter.literal(col.comment));
    return parts.join(' ');
  }
  if (dialect === 'mssql') {
    const collation = metadataName(col.collation, '排序规则');
    if (collation) parts.push('COLLATE ' + collation);
  }
  // mysql / postgres / mssql / sqlite
  if (col.autoInc) {
    if (dialect === 'mssql') parts.push('IDENTITY(1,1)');
    if (dialect === 'postgres') parts.push('GENERATED BY DEFAULT AS IDENTITY');
    if (dialect === 'sqlite' && opts.inlineSinglePk) {
      return `${q(col.name)} INTEGER PRIMARY KEY AUTOINCREMENT`;
    }
  }
  parts.push(col.notNull ? 'NOT NULL' : 'NULL');
  if (d !== null && !col.autoInc) parts.push('DEFAULT ' + d);
  return parts.join(' ');
}

function indexName(ix, table) {
  return ix.name && ix.name.trim() ? ix.name.trim() : `idx_${table}_${ix.columns.join('_')}`.slice(0, 60);
}

function cleanName(value) { return String(value || '').trim(); }

function generatedName(prefix, table, detail) {
  const rawDetail = cleanName(detail).replace(/[^A-Za-z0-9_$#]+/g, '_').replace(/^_+|_+$/g, '') || 'item';
  const raw = `${prefix}_${cleanName(table) || 'table'}_${rawDetail}`;
  let hash = 2166136261;
  for (const ch of `${table}|${detail}`) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  const suffix = (hash >>> 0).toString(36).padStart(7, '0').slice(-7);
  if (raw.length + suffix.length + 1 <= 30) return `${raw}_${suffix}`;
  return `${raw.slice(0, 22)}_${suffix}`;
}

function constraintName(item, table) {
  const explicit = cleanName(item && item.name);
  if (explicit) return explicit;
  const cols = ((item && item.columns) || []).map(cleanName).filter(Boolean).join('_');
  const prefix = item && String(item.kind).toLowerCase() === 'check' ? 'ck' : 'uq';
  const detail = cols || String((item && item.expression) || 'expr');
  return generatedName(prefix, table, detail);
}

function foreignKeyName(fk, table) {
  const explicit = cleanName(fk && fk.name);
  if (explicit) return explicit;
  const cols = ((fk && fk.columns) || []).map(cleanName).filter(Boolean).join('_');
  return generatedName('fk', table, `${cols || 'column'}_${cleanName(fk && fk.refTable) || 'ref'}`);
}

function normalizeAction(value) {
  const action = String(value || 'NO ACTION').trim().replace(/\s+/g, ' ').toUpperCase();
  return ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'].includes(action) ? action : 'NO ACTION';
}

function referenceTable(adapter, dialect, db, schema, fk, renamedTable) {
  let refTable = cleanName(fk.refTable);
  const refSchema = cleanName(fk.refSchema);
  const localSchema = dialect === 'mysql' || dialect === 'oracle' ? cleanName(db) : cleanName(schema);
  if (renamedTable && refTable === renamedTable.from && (!refSchema || refSchema === localSchema)) {
    refTable = renamedTable.to;
  }
  if (dialect === 'mysql') return adapter.qualify(refSchema || db, null, refTable);
  if (dialect === 'sqlite') return adapter.quoteIdent(refTable);
  if (dialect === 'oracle') return adapter.qualify(refSchema || db, null, refTable);
  return adapter.qualify(db, refSchema || schema, refTable);
}

function actionClauses(cap, fk, warnings, label) {
  const clauses = [];
  const update = normalizeAction(fk.onUpdate);
  const del = normalizeAction(fk.onDelete);
  if (del !== 'NO ACTION') {
    if ((cap.fkDeleteActions || []).includes(del)) clauses.push(`ON DELETE ${del}`);
    else warnings.push(`${label} 不支持 ON DELETE ${del}，已按 NO ACTION 处理`);
  }
  if (update !== 'NO ACTION') {
    if ((cap.fkUpdateActions || []).includes(update)) clauses.push(`ON UPDATE ${update}`);
    else warnings.push(`${label} 不支持 ON UPDATE ${update}，已按 NO ACTION 处理`);
  }
  return clauses.length ? ' ' + clauses.join(' ') : '';
}

function foreignKeyDef(adapter, dialect, db, schema, table, fk, warnings, renamedTable) {
  const q = (n) => adapter.quoteIdent(n);
  const cols = (fk.columns || []).map(cleanName).filter(Boolean);
  const refCols = (fk.refColumns || []).map(cleanName).filter(Boolean);
  const refTable = cleanName(fk.refTable);
  if (!cols.length || !refTable || cols.length !== refCols.length) {
    throw new Error(`外键 ${foreignKeyName(fk, table)} 的本表栏位、引用表和引用栏位必须完整，且栏位数量一致`);
  }
  const name = foreignKeyName(fk, table);
  if (dialect === 'sqlite' && cleanName(fk.refSchema)) {
    warnings.push(`SQLite 外键 ${name} 不支持跨 Schema 引用，引用 Schema 已忽略`);
  }
  const ref = referenceTable(adapter, dialect, db, schema, fk, renamedTable);
  return `CONSTRAINT ${q(name)} FOREIGN KEY (${cols.map(q).join(', ')}) REFERENCES ${ref} (${refCols.map(q).join(', ')})`
    + actionClauses(caps(dialect), fk, warnings, `外键 ${name}`);
}

function constraintDef(adapter, table, item) {
  const q = (n) => adapter.quoteIdent(n);
  const kind = String(item.kind || '').toLowerCase();
  const name = constraintName(item, table);
  if (kind === 'unique') {
    const cols = (item.columns || []).map(cleanName).filter(Boolean);
    if (!cols.length) throw new Error(`唯一约束 ${name} 至少需要一个栏位`);
    return `CONSTRAINT ${q(name)} UNIQUE (${cols.map(q).join(', ')})`;
  }
  if (kind === 'check') {
    const expression = String(item.expression || '').trim();
    if (!expression) throw new Error(`检查约束 ${name} 的表达式不能为空`);
    return `CONSTRAINT ${q(name)} CHECK (${expression})`;
  }
  throw new Error(`不支持的约束类型：${item.kind || '未知'}`);
}

function constraintSupported(cap, item) {
  return String(item.kind || '').toLowerCase() === 'check' ? cap.checkConstraints : cap.uniqueConstraints;
}

function sameList(a, b) {
  return JSON.stringify((a || []).map(cleanName)) === JSON.stringify((b || []).map(cleanName));
}

function foreignKeyChanged(before, after) {
  return foreignKeyName(before, '') !== foreignKeyName(after, '')
    || !sameList(before.columns, after.columns)
    || cleanName(before.refSchema) !== cleanName(after.refSchema)
    || cleanName(before.refTable) !== cleanName(after.refTable)
    || !sameList(before.refColumns, after.refColumns)
    || normalizeAction(before.onUpdate) !== normalizeAction(after.onUpdate)
    || normalizeAction(before.onDelete) !== normalizeAction(after.onDelete);
}

function constraintChanged(before, after) {
  const beforeKind = String(before.kind || '').toLowerCase();
  const afterKind = String(after.kind || '').toLowerCase();
  return beforeKind !== afterKind
    || cleanName(before.name) !== cleanName(after.name)
    || !sameList(before.columns, after.columns)
    || String(before.expression || '').trim() !== String(after.expression || '').trim();
}

function expressionIdentifiers(expression) {
  const text = String(expression || '');
  const out = new Set();
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue; }
        if (text[i++] === "'") break;
      }
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let value = '';
      i++;
      while (i < text.length) {
        if (text[i] === close && text[i + 1] === close && ch !== '[') { value += close; i += 2; continue; }
        if (text[i] === close) { i++; break; }
        value += text[i++];
      }
      if (value) { out.add(value); out.add(value.toLowerCase()); }
      continue;
    }
    if (/[A-Za-z_$#]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_$#]/.test(text[j])) j++;
      const value = text.slice(i, j);
      out.add(value);
      out.add(value.toLowerCase());
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function dropForeignKeySql(adapter, dialect, T, name) {
  const q = (n) => adapter.quoteIdent(n);
  if (dialect === 'mysql') return `ALTER TABLE ${T} DROP FOREIGN KEY ${q(name)}`;
  return `ALTER TABLE ${T} DROP CONSTRAINT ${q(name)}`;
}

function dropConstraintSql(adapter, dialect, T, item) {
  const q = (n) => adapter.quoteIdent(n);
  const name = cleanName(item.name);
  if (dialect === 'mysql') {
    return String(item.kind || '').toLowerCase() === 'check'
      ? (/mariadb/i.test(String(adapter.serverVersion || ''))
        ? `ALTER TABLE ${T} DROP CONSTRAINT ${q(name)}`
        : `ALTER TABLE ${T} DROP CHECK ${q(name)}`)
      : `ALTER TABLE ${T} DROP INDEX ${q(item.indexName || name)}`;
  }
  return `ALTER TABLE ${T} DROP CONSTRAINT ${q(name)}`;
}

/** CREATE TABLE（+ 索引 + 注释），返回 {sqls, warnings} */
function buildCreateTable(adapter, db, schema, model) {
  const dialect = adapter.dialect;
  const q = (n) => adapter.quoteIdent(n);
  const T = adapter.qualify(db, schema, model.table);
  const warnings = [];
  const cols = model.columns.filter((c) => c.name && c.name.trim());
  if (!cols.length) throw new Error('至少需要一个栏位');
  const pkCols = cols.filter((c) => c.pk).map((c) => c.name);

  const lines = [];
  const sqliteInlinePk = dialect === 'sqlite' && pkCols.length === 1 &&
    cols.find((c) => c.pk && c.autoInc && /int/i.test(c.type));
  for (const c of cols) {
    const inline = sqliteInlinePk && c.pk;
    lines.push('  ' + columnDef(adapter, dialect, c, { inlineSinglePk: inline }));
  }
  if (pkCols.length && !sqliteInlinePk && dialect !== 'clickhouse') {
    lines.push(`  PRIMARY KEY (${pkCols.map(q).join(', ')})`);
  }
  const cap = caps(dialect);
  const foreignKeys = model.foreignKeys || [];
  if (foreignKeys.length) {
    if (!cap.foreignKeys) {
      warnings.push('该数据库不支持在设计器中创建外键，相关定义已忽略');
    } else {
      for (const fk of foreignKeys) {
        lines.push('  ' + foreignKeyDef(adapter, dialect, db, schema, model.table, fk, warnings));
      }
    }
  }
  const constraints = model.constraints || [];
  for (const item of constraints) {
    if (!constraintSupported(cap, item)) {
      warnings.push(`该数据库不支持 ${String(item.kind || '').toUpperCase()} 约束，约束 ${constraintName(item, model.table)} 已忽略`);
      continue;
    }
    lines.push('  ' + constraintDef(adapter, model.table, item));
  }
  let sql = `CREATE TABLE ${T} (\n${lines.join(',\n')}\n)`;
  if (dialect === 'mysql') {
    sql += ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
    if (model.comment) sql += ' COMMENT ' + adapter.literal(model.comment);
  }
  if (dialect === 'clickhouse') {
    const opt = (model.options || '').trim() || 'ENGINE = MergeTree ORDER BY tuple()';
    sql += ' ' + opt;
    if (model.comment) sql += ` COMMENT ${adapter.literal(model.comment)}`;
    if (pkCols.length) warnings.push('ClickHouse 的主键由 ORDER BY 决定，请在表选项中设置（已忽略主键勾选）');
  }
  const sqls = [sql];

  // 索引
  if ((model.indexes || []).length) {
    if (!cap.indexes) {
      warnings.push('该数据库的索引不支持在设计器中创建，已忽略');
    } else {
      for (const ix of model.indexes) {
        if (!ix.columns || !ix.columns.length) continue;
        sqls.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(indexName(ix, model.table))} ON ${T} (${ix.columns.map(q).join(', ')})`);
      }
    }
  }
  // 注释（建表语句外补充）
  if (dialect === 'postgres' || dialect === 'oracle') {
    if (model.comment) sqls.push(`COMMENT ON TABLE ${T} IS ${adapter.literal(model.comment)}`);
    for (const c of cols) {
      if (c.comment) sqls.push(`COMMENT ON COLUMN ${T}.${q(c.name)} IS ${adapter.literal(c.comment)}`);
    }
  }
  if (dialect === 'mssql' && (model.comment || cols.some((c) => c.comment))) {
    warnings.push('SQL Server 的注释（扩展属性）暂不在设计器中生成');
  }
  return { sqls, warnings };
}

/** 对比新旧模型生成 ALTER 语句，返回 {sqls, warnings} */
function buildAlterTable(adapter, db, schema, original, model) {
  const dialect = adapter.dialect;
  const cap = caps(dialect);
  const q = (n) => adapter.quoteIdent(n);
  const T = adapter.qualify(db, schema, original.table);
  const sqls = [];
  const preSqls = [];
  const postSqls = [];
  const warnings = [];
  const L = (v) => adapter.literal(v);
  const finalTable = model.table || original.table;
  const finalT = adapter.qualify(db, schema, finalTable);
  const renamedTable = finalTable !== original.table ? { from: original.table, to: finalTable } : null;
  const origByName = new Map(original.columns.map((c) => [c.name, c]));
  const newCols = model.columns.filter((c) => c.name && c.name.trim());
  const keptOrig = new Set(newCols.filter((c) => c.origName).map((c) => c.origName));
  const fullType = (c) => composeType(c, dialect);
  const columnTypeSignature = (c) => JSON.stringify([
    fullType(c), String(c.charset || '').toLowerCase(), String(c.collation || '').toLowerCase(),
  ]);
  const defStr = (c) => composeDefault(adapter, c.def);
  const typeChangedColumns = new Set();
  const deletedColumns = new Set();
  const renamedColumns = new Map();
  for (const c of newCols) {
    if (!c.origName) continue;
    const before = origByName.get(c.origName);
    if (!before) continue;
    if (columnTypeSignature(before) !== columnTypeSignature(c)) {
      typeChangedColumns.add(c.origName);
    }
    if (c.name !== c.origName) {
      renamedColumns.set(c.origName, c.name);
      renamedColumns.set(String(c.origName).toLowerCase(), c.name);
    }
  }
  for (const before of original.columns) {
    if (keptOrig.has(before.name)) continue;
    if (before.editSafe === false) {
      throw new Error(`栏位 ${before.name} 含设计器无法无损保留的高级属性，不能在设计器中删除；请改用审核后的迁移 SQL`);
    }
    deletedColumns.add(before.name);
  }
  const changesColumnType = (columns) => (columns || []).some((name) => typeChangedColumns.has(name));
  const renamedList = (columns) => (columns || []).map((name) => renamedColumns.get(name) || name);
  const isSelfReference = (fk) => cleanName(fk.refTable) === cleanName(original.table)
    && (!cleanName(fk.refSchema) || cleanName(fk.refSchema) === cleanName(schema || db));
  const origPk = original.columns.filter((c) => c.pk).map((c) => c.name);
  const newPkOrigNames = newCols.filter((c) => c.pk).map((c) => c.origName || c.name);
  const newPk = newCols.filter((c) => c.pk).map((c) => c.name);

  // 其他表指向当前表的外键不能由本设计页协调重建。涉及被引用栏位或
  // 其候选键时必须先阻止，避免 MySQL/Oracle 已删本地约束后才在 ALTER 处失败。
  const referencedBy = Array.isArray(original._referencedBy) ? original._referencedBy : [];
  const isReferencedKey = (columns) => referencedBy.some((ref) => sameList(ref.refColumns || [], columns || []));
  const touchedReferencedColumn = referencedBy.flatMap((ref) => ref.refColumns || []).find((name) => (
    typeChangedColumns.has(name) || renamedColumns.has(name) || deletedColumns.has(name)
  ));
  if (touchedReferencedColumn) {
    const ref = referencedBy.find((item) => (item.refColumns || []).includes(touchedReferencedColumn));
    throw new Error(`栏位 ${touchedReferencedColumn} 正被外部表 ${(ref && [ref.schema, ref.table].filter(Boolean).join('.')) || ''} 的外键引用；请先用迁移 SQL 协调处理入站外键`);
  }
  if (referencedBy.length && JSON.stringify(origPk) !== JSON.stringify(newPkOrigNames) && isReferencedKey(origPk)) {
    throw new Error('当前主键正被其他表外键引用；请先用迁移 SQL 协调处理入站外键，再修改主键');
  }
  for (const before of (original.constraints || []).filter((item) => String(item.kind || '').toLowerCase() === 'unique')) {
    if (!isReferencedKey(before.columns)) continue;
    const next = (model.constraints || []).find((item) => cleanName(item.origName) === cleanName(before.name));
    const effective = next && {
      ...next,
      columns: sameList(next.columns, before.columns) ? renamedList(next.columns) : next.columns,
    };
    const expected = { ...before, columns: renamedList(before.columns) };
    if (!effective || constraintChanged(expected, effective)) {
      throw new Error(`唯一约束 ${before.name} 正被其他表外键引用；请先用迁移 SQL 协调处理入站外键`);
    }
  }
  for (const before of (original.indexes || []).filter((item) => item.unique && !item.primary)) {
    if (!isReferencedKey(before.columns)) continue;
    const next = (model.indexes || []).find((item) => cleanName(item.origName) === cleanName(before.name));
    const effectiveColumns = next && (sameList(next.columns, before.columns) ? renamedList(next.columns) : next.columns);
    if (!next || indexName(next, original.table) !== before.name || !next.unique
        || !sameList(effectiveColumns, renamedList(before.columns))) {
      throw new Error(`唯一索引 ${before.name} 正被其他表外键引用；请先用迁移 SQL 协调处理入站外键`);
    }
  }

  // 外键和表约束必须在栏位变化前删除，并在栏位/表重命名完成后重建。
  // SQLite 无通用 ALTER CONSTRAINT，明确降级为只读而不是生成必然失败的 SQL。
  const originalFks = new Map((original.foreignKeys || []).map((fk) => [cleanName(fk.name), fk]));
  const nextFks = model.foreignKeys || [];
  const keptFks = new Set();
  let unsupportedFkChange = false;
  for (const fk of nextFks) {
    const oldName = cleanName(fk.origName);
    const before = oldName ? originalFks.get(oldName) : null;
    if (before) keptFks.add(oldName);
    const dependencyChanged = !!before && (changesColumnType(before.columns)
      || (isSelfReference(before) && changesColumnType(before.refColumns)));
    let effectiveFk = fk;
    if (before) {
      const deletedLocal = (before.columns || []).find((name) => deletedColumns.has(name));
      const deletedRef = isSelfReference(before)
        && (before.refColumns || []).find((name) => deletedColumns.has(name));
      if ((deletedLocal && sameList(fk.columns, before.columns))
          || (deletedRef && sameList(fk.refColumns, before.refColumns))) {
        throw new Error(`外键 ${oldName} 仍引用已删除栏位 ${deletedLocal || deletedRef}，请先删除或修改该外键`);
      }
      effectiveFk = {
        ...fk,
        columns: sameList(fk.columns, before.columns) ? renamedList(fk.columns) : fk.columns,
        refColumns: isSelfReference(before) && sameList(fk.refColumns, before.refColumns)
          ? renamedList(fk.refColumns) : fk.refColumns,
      };
      const expectedAfterRename = {
        ...before,
        columns: renamedList(before.columns),
        refColumns: isSelfReference(before) ? renamedList(before.refColumns) : before.refColumns,
      };
      const explicitlyChanged = foreignKeyChanged(expectedAfterRename, effectiveFk);
      if (!explicitlyChanged && !dependencyChanged) continue;
      if (before.rebuildSafe === false) {
        throw new Error(`外键 ${oldName} 含设计器无法无损保留的高级属性，请先用 SQL 手动处理该外键，再修改相关栏位`);
      }
    }
    if (!cap.foreignKeys || !cap.foreignKeyAlter) {
      unsupportedFkChange = true;
      continue;
    }
    if (before) preSqls.push(dropForeignKeySql(adapter, dialect, T, oldName));
    postSqls.push(`ALTER TABLE ${finalT} ADD ${foreignKeyDef(adapter, dialect, db, schema, finalTable, effectiveFk, warnings, renamedTable)}`);
  }
  for (const [name] of originalFks) {
    if (keptFks.has(name)) continue;
    if (!cap.foreignKeys || !cap.foreignKeyAlter) unsupportedFkChange = true;
    else preSqls.push(dropForeignKeySql(adapter, dialect, T, name));
  }
  if (unsupportedFkChange) warnings.push('该数据库不能直接修改既有表外键（需要重建表），外键改动已忽略');

  const originalConstraints = new Map((original.constraints || []).map((item) => [cleanName(item.name), item]));
  const nextConstraints = model.constraints || [];
  const keptConstraints = new Set();
  let unsupportedConstraintChange = false;
  for (const item of nextConstraints) {
    const oldName = cleanName(item.origName);
    const before = oldName ? originalConstraints.get(oldName) : null;
    if (before) keptConstraints.add(oldName);
    const kind = before && String(before.kind || '').toLowerCase();
    const checkIdentifiers = kind === 'check' ? expressionIdentifiers(before.expression) : null;
    const checkTouches = !!checkIdentifiers && [...typeChangedColumns].some((name) => (
      checkIdentifiers.has(name) || checkIdentifiers.has(String(name).toLowerCase())
    ));
    const checkRenameTouches = !!checkIdentifiers && [...renamedColumns.keys()].some((name) => (
      checkIdentifiers.has(name) || checkIdentifiers.has(String(name).toLowerCase())
    ));
    const dependencyChanged = !!before && (kind === 'unique' ? changesColumnType(before.columns) : checkTouches);
    let effectiveItem = item;
    if (before) {
      if (kind === 'unique') {
        const deleted = (before.columns || []).find((name) => deletedColumns.has(name));
        if (deleted && sameList(item.columns, before.columns)) {
          throw new Error(`唯一约束 ${oldName} 仍引用已删除栏位 ${deleted}，请先删除或修改该约束`);
        }
        effectiveItem = {
          ...item,
          columns: sameList(item.columns, before.columns) ? renamedList(item.columns) : item.columns,
        };
      } else if (kind === 'check') {
        const deleted = [...deletedColumns].find((name) => (
          checkIdentifiers.has(name) || checkIdentifiers.has(String(name).toLowerCase())
        ));
        if (deleted && String(item.expression || '').trim() === String(before.expression || '').trim()) {
          throw new Error(`检查约束 ${oldName} 仍引用已删除栏位 ${deleted}，请先删除或修改该约束`);
        }
        if (checkRenameTouches
            && String(item.expression || '').trim() === String(before.expression || '').trim()
            && (dialect === 'mysql' || dependencyChanged)) {
          throw new Error(`检查约束 ${oldName} 可能引用已改名栏位；请在“约束”页手动更新 CHECK 表达式后再保存`);
        }
      }
      const expectedAfterRename = kind === 'unique'
        ? { ...before, columns: renamedList(before.columns) }
        : before;
      const explicitlyChanged = constraintChanged(expectedAfterRename, effectiveItem);
      if (!explicitlyChanged && !dependencyChanged) continue;
      if (before.rebuildSafe === false) {
        throw new Error(`${kind === 'check' ? '检查' : '唯一'}约束 ${oldName} 含设计器无法无损保留的高级属性，请先用 SQL 手动处理该约束`);
      }
    }
    if (!constraintSupported(cap, item) || !cap.constraintAlter) {
      unsupportedConstraintChange = true;
      continue;
    }
    if (before) preSqls.push(dropConstraintSql(adapter, dialect, T, before));
    postSqls.push(`ALTER TABLE ${finalT} ADD ${constraintDef(adapter, finalTable, effectiveItem)}`);
  }
  for (const [name, item] of originalConstraints) {
    if (keptConstraints.has(name)) continue;
    if (!constraintSupported(cap, item) || !cap.constraintAlter) unsupportedConstraintChange = true;
    else preSqls.push(dropConstraintSql(adapter, dialect, T, item));
  }
  if (unsupportedConstraintChange) warnings.push('该数据库不能直接修改既有表 UNIQUE/CHECK 约束（需要重建表），约束改动已忽略');

  // 1) 重命名 + 修改
  for (const c of newCols) {
    if (!c.origName) continue;
    const o = origByName.get(c.origName);
    if (!o) continue;
    const renamed = c.name !== c.origName;
    const typeChanged = columnTypeSignature(c) !== columnTypeSignature(o);
    const nullChanged = !!c.notNull !== !!o.notNull;
    const defChanged = String(c.def || '') !== String(o.def || '');
    const cmtChanged = String(c.comment || '') !== String(o.comment || '');
    const autoChanged = !!c.autoInc !== !!o.autoInc;
    if (!renamed && !typeChanged && !nullChanged && !defChanged && !cmtChanged && !autoChanged) continue;
    if (o.editSafe === false) {
      throw new Error(`栏位 ${o.name} 含设计器无法无损保留的高级属性，当前为只读；请改用审核后的迁移 SQL`);
    }
    if (autoChanged && dialect !== 'mysql') {
      throw new Error(`当前数据库不能通过设计器修改既有栏位 ${o.name} 的自增/标识属性，请使用专用迁移 SQL`);
    }

    if (dialect === 'mysql') {
      // CHANGE 同时处理改名与定义
      sqls.push(`ALTER TABLE ${T} CHANGE COLUMN ${q(c.origName)} ${columnDef(adapter, dialect, c)}`);
      continue;
    }
    if (renamed) {
      if (dialect === 'mssql') {
        const full = `${schema || 'dbo'}.${original.table}.${c.origName}`;
        sqls.push(`EXEC sp_rename ${L(full)}, ${L(c.name)}, 'COLUMN'`);
      } else if (dialect === 'clickhouse') {
        sqls.push(`ALTER TABLE ${T} RENAME COLUMN ${q(c.origName)} TO ${q(c.name)}`);
      } else {
        sqls.push(`ALTER TABLE ${T} RENAME COLUMN ${q(c.origName)} TO ${q(c.name)}`);
      }
    }
    if (typeChanged || nullChanged || defChanged || cmtChanged || autoChanged) {
      if (dialect === 'sqlite') {
        warnings.push(`SQLite 不支持修改栏位 ${c.name} 的类型/约束（需重建表），相关改动已忽略`);
        continue;
      }
      if (dialect === 'postgres') {
        if (typeChanged) sqls.push(`ALTER TABLE ${T} ALTER COLUMN ${q(c.name)} TYPE ${fullType(c)}`);
        if (nullChanged) sqls.push(`ALTER TABLE ${T} ALTER COLUMN ${q(c.name)} ${c.notNull ? 'SET' : 'DROP'} NOT NULL`);
        if (defChanged) {
          const d = defStr(c);
          sqls.push(d === null
            ? `ALTER TABLE ${T} ALTER COLUMN ${q(c.name)} DROP DEFAULT`
            : `ALTER TABLE ${T} ALTER COLUMN ${q(c.name)} SET DEFAULT ${d}`);
        }
        if (cmtChanged) sqls.push(`COMMENT ON COLUMN ${T}.${q(c.name)} IS ${c.comment ? L(c.comment) : 'NULL'}`);
      } else if (dialect === 'mssql') {
        if (typeChanged || nullChanged) {
          sqls.push(`ALTER TABLE ${T} ALTER COLUMN ${q(c.name)} ${fullType(c)} ${c.notNull ? 'NOT NULL' : 'NULL'}`);
        }
        if (defChanged) {
          if (o.defConstraint) sqls.push(`ALTER TABLE ${T} DROP CONSTRAINT ${q(o.defConstraint)}`);
          const d = defStr(c);
          if (d !== null) sqls.push(`ALTER TABLE ${T} ADD CONSTRAINT ${q('DF_' + original.table + '_' + c.name)} DEFAULT ${d} FOR ${q(c.name)}`);
          else if (!o.defConstraint) warnings.push(`栏位 ${c.name} 的原默认值约束名未知，无法删除`);
        }
        if (cmtChanged) warnings.push(`SQL Server 注释修改暂不支持（栏位 ${c.name}）`);
      } else if (dialect === 'oracle') {
        const mods = [];
        if (typeChanged) mods.push(fullType(c));
        if (defChanged) { const d = defStr(c); mods.push('DEFAULT ' + (d === null ? 'NULL' : d)); }
        if (nullChanged) mods.push(c.notNull ? 'NOT NULL' : 'NULL');
        if (mods.length) sqls.push(`ALTER TABLE ${T} MODIFY (${q(c.name)} ${mods.join(' ')})`);
        if (cmtChanged) sqls.push(`COMMENT ON COLUMN ${T}.${q(c.name)} IS ${c.comment ? L(c.comment) : "''"}`);
      } else if (dialect === 'clickhouse') {
        if (typeChanged || defChanged) {
          let s = `ALTER TABLE ${T} MODIFY COLUMN ${q(c.name)} ${fullType(c)}`;
          const d = defStr(c);
          if (d !== null) s += ' DEFAULT ' + d;
          sqls.push(s);
        }
        if (cmtChanged) sqls.push(`ALTER TABLE ${T} COMMENT COLUMN ${q(c.name)} ${L(c.comment || '')}`);
      }
    }
  }

  // 2) 新增栏位
  for (const c of newCols) {
    if (c.origName) continue;
    if (dialect === 'oracle') {
      sqls.push(`ALTER TABLE ${T} ADD (${columnDef(adapter, dialect, c)})`);
      if (c.comment) sqls.push(`COMMENT ON COLUMN ${T}.${q(c.name)} IS ${L(c.comment)}`);
    } else if (dialect === 'postgres') {
      sqls.push(`ALTER TABLE ${T} ADD COLUMN ${columnDef(adapter, dialect, c)}`);
      if (c.comment) sqls.push(`COMMENT ON COLUMN ${T}.${q(c.name)} IS ${L(c.comment)}`);
    } else if (dialect === 'mssql') {
      sqls.push(`ALTER TABLE ${T} ADD ${columnDef(adapter, dialect, c)}`);
    } else {
      sqls.push(`ALTER TABLE ${T} ADD COLUMN ${columnDef(adapter, dialect, c)}`);
    }
    if (dialect === 'sqlite' && c.notNull && composeDefault(adapter, c.def) === null) {
      warnings.push(`SQLite 新增 NOT NULL 栏位 ${c.name} 需要提供默认值，否则会执行失败`);
    }
  }

  // 3) 删除栏位
  for (const o of original.columns) {
    if (keptOrig.has(o.name)) continue;
    if (newCols.some((c) => c.origName === o.name)) continue;
    sqls.push(`ALTER TABLE ${T} DROP COLUMN ${q(o.name)}`);
  }

  // 4) 主键变化
  if (JSON.stringify(origPk) !== JSON.stringify(newPkOrigNames)) {
    if (!cap.pkChange) {
      warnings.push('该数据库不支持在设计器中修改主键，相关改动已忽略');
    } else if (dialect === 'mysql') {
      if (origPk.length) sqls.push(`ALTER TABLE ${T} DROP PRIMARY KEY`);
      if (newPk.length) sqls.push(`ALTER TABLE ${T} ADD PRIMARY KEY (${newPk.map(q).join(', ')})`);
    } else {
      const pkIx = (original._pkIndexes || []).find((i) => i.name) || (original.indexes || []).find((i) => i.primary);
      const pkName = pkIx && pkIx.name;
      if (origPk.length) {
        if (pkName) sqls.push(`ALTER TABLE ${T} DROP CONSTRAINT ${q(pkName)}`);
        else warnings.push('未能确定原主键约束名，请手动删除原主键');
      }
      if (newPk.length) sqls.push(`ALTER TABLE ${T} ADD PRIMARY KEY (${newPk.map(q).join(', ')})`);
    }
  }

  // 5) 索引变化（按名称对比；忽略主键索引）
  if (cap.indexes) {
    // 表达式/筛选索引无法由当前网格无损表示；保留但不纳入差异，避免无关编辑误删。
    const origIx = new Map((original.indexes || []).filter((i) => !i.primary && i.columns && i.columns.length).map((i) => [i.name, i]));
    const newIxs = (model.indexes || []).filter((i) => i.columns && i.columns.length);
    const seen = new Set();
    for (const ix of newIxs) {
      const name = indexName(ix, original.table);
      const o = ix.origName ? origIx.get(ix.origName) : null;
      if (o) {
        seen.add(ix.origName);
        const changed = name !== ix.origName ||
          JSON.stringify(o.columns) !== JSON.stringify(ix.columns) || !!o.unique !== !!ix.unique;
        if (!changed) continue;
        preSqls.push(dropIndexSql(adapter, dialect, db, schema, T, ix.origName));
        postSqls.push(createIndexSql(adapter, dialect, finalT, { ...ix, name }));
      } else {
        postSqls.push(createIndexSql(adapter, dialect, finalT, { ...ix, name }));
      }
    }
    for (const [name] of origIx) {
      if (!seen.has(name) && !newIxs.some((i) => i.origName === name)) {
        preSqls.push(dropIndexSql(adapter, dialect, db, schema, T, name));
      }
    }
  }

  // 6) 表注释
  if (String(model.comment || '') !== String(original.comment || '')) {
    if (dialect === 'mysql') sqls.push(`ALTER TABLE ${T} COMMENT = ${L(model.comment || '')}`);
    else if (dialect === 'postgres' || dialect === 'oracle') sqls.push(`COMMENT ON TABLE ${T} IS ${model.comment ? L(model.comment) : (dialect === 'oracle' ? "''" : 'NULL')}`);
    else if (dialect === 'clickhouse') sqls.push(`ALTER TABLE ${T} MODIFY COMMENT ${L(model.comment || '')}`);
    else warnings.push('该数据库的表注释修改暂不支持');
  }

  // 7) 表重命名（最后执行，避免影响前面的语句）
  if (model.table && model.table !== original.table) {
    sqls.push(adapter.renameSql(db, schema, original.table, model.table));
  }

  const orderedSqls = [...preSqls, ...sqls, ...postSqls];
  if (dialect === 'mysql') {
    // MySQL/MariaDB DDL 会隐式提交。把同一张表的 DROP/栏位变化/ADD
    // 合成一个 ALTER TABLE，避免后续语句失败时只留下“已删约束”的半成品。
    if (renamedTable && orderedSqls.some((statement) => !/^RENAME\s+TABLE\b/i.test(statement))) {
      throw new Error('MySQL/MariaDB 的表重命名请单独保存；完成并重新打开设计页后，再修改栏位、索引或约束');
    }
    if (!renamedTable) {
      const prefix = `ALTER TABLE ${T} `;
      const clauses = [];
      const others = [];
      for (const statement of orderedSqls) {
        if (statement.startsWith(prefix)) clauses.push(statement.slice(prefix.length));
        else others.push(statement);
      }
      return {
        sqls: [...(clauses.length ? [`${prefix}${clauses.join(',\n  ')}`] : []), ...others],
        warnings,
      };
    }
  }
  return { sqls: orderedSqls, warnings };
}

/** Generate portable ADD COLUMN statements for an explicitly selected set of columns. */
function buildAddColumns(adapter, db, schema, table, columns) {
  const dialect = adapter.dialect;
  const T = adapter.qualify(db, schema, table);
  const sqls = [];
  const warnings = [];
  for (const c of (columns || [])) {
    if (!String(c && c.name || '').trim()) throw new Error('字段名称不能为空');
    if (!String(c && c.type || '').trim()) throw new Error(`字段 ${c.name} 的类型不能为空`);
    const def = columnDef(adapter, dialect, c);
    if (dialect === 'oracle') {
      sqls.push(`ALTER TABLE ${T} ADD (${def})`);
      if (c.comment) sqls.push(`COMMENT ON COLUMN ${T}.${adapter.quoteIdent(c.name)} IS ${adapter.literal(c.comment)}`);
    } else if (dialect === 'postgres') {
      sqls.push(`ALTER TABLE ${T} ADD COLUMN ${def}`);
      if (c.comment) sqls.push(`COMMENT ON COLUMN ${T}.${adapter.quoteIdent(c.name)} IS ${adapter.literal(c.comment)}`);
    } else if (dialect === 'mssql') {
      sqls.push(`ALTER TABLE ${T} ADD ${def}`);
    } else {
      sqls.push(`ALTER TABLE ${T} ADD COLUMN ${def}`);
    }
    if (dialect === 'sqlite' && c.notNull && composeDefault(adapter, c.def) === null) {
      warnings.push(`SQLite 新增 NOT NULL 栏位 ${c.name} 需要提供默认值，否则执行可能失败`);
    }
  }
  return { sqls, warnings };
}

function createIndexSql(adapter, dialect, T, ix) {
  const q = (n) => adapter.quoteIdent(n);
  if (dialect === 'mysql') {
    return `ALTER TABLE ${T} ADD ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ix.name)} (${ix.columns.map(q).join(', ')})`;
  }
  return `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ix.name)} ON ${T} (${ix.columns.map(q).join(', ')})`;
}

function dropIndexSql(adapter, dialect, db, schema, T, name) {
  const q = (n) => adapter.quoteIdent(n);
  if (dialect === 'mysql') return `ALTER TABLE ${T} DROP INDEX ${q(name)}`;
  if (dialect === 'mssql') return `DROP INDEX ${q(name)} ON ${T}`;
  if (dialect === 'postgres') return `DROP INDEX ${adapter.qualify(db, schema, name)}`;
  if (dialect === 'oracle') return `DROP INDEX ${adapter.qualify(db, null, name)}`;
  return `DROP INDEX ${q(name)}`; // sqlite
}

/** 把 tableInfo 结果转换为设计器模型 */
function infoToModel(info, table, dialect) {
  const parseType = (full) => {
    const m = /^([^()]+?)\s*\(\s*([\d]+|max)\s*(?:,\s*(\d+))?\s*\)\s*$/i.exec(String(full || '').trim());
    if (m) return { type: m[1].trim(), length: m[2], scale: m[3] || '' };
    return { type: String(full || '').trim(), length: '', scale: '' };
  };
  const columns = info.columns.map((c) => {
    let full = c.type || '';
    let notNull = !c.nullable;
    if (dialect === 'clickhouse') {
      const nm = /^Nullable\((.+)\)$/i.exec(full);
      if (nm) { full = nm[1]; notNull = false; } else notNull = true;
    }
    const t = parseType(full);
    let def = c.def === null || c.def === undefined ? '' : String(c.def);
    // ClickHouse reports the implicit nullable default as the literal text
    // "NULL"/"null". It is not an explicit default expression and should
    // not be shown as a user-entered default in the design grid.
    if (dialect === 'clickhouse' && /^null$/i.test(def.trim())) def = '';
    return {
      name: c.name,
      origName: c.name,
      type: t.type,
      length: t.length,
      scale: t.scale,
      notNull,
      pk: c.key === 'PRI',
      autoInc: /auto_increment|identity/i.test(c.extra || ''),
      def,
      comment: c.comment || '',
      defConstraint: c.defConstraint || null,
      charset: c.charset || '',
      collation: c.collation || '',
      editSafe: c.editSafe !== false,
      editUnsafeReason: c.editUnsafeReason || '',
    };
  });
  const constraints = (info.constraints || []).map((item) => ({
    kind: String(item.kind || '').toLowerCase(),
    name: item.name || '',
    origName: item.name || '',
    columns: (item.columns || []).slice(),
    expression: item.expression || '',
    indexName: item.indexName || null,
    rebuildSafe: item.rebuildSafe !== false,
  }));
  const constraintIndexes = new Set();
  for (const item of constraints) {
    if (item.kind !== 'unique') continue;
    if (item.indexName) constraintIndexes.add(item.indexName);
    if (item.name) constraintIndexes.add(item.name);
  }
  const indexes = (info.indexes || [])
    .filter((i) => i.editable !== false && !i.primary && i.name !== 'PRIMARY' && !constraintIndexes.has(i.name))
    .map((i) => ({
      name: i.name,
      origName: i.name,
      columns: (i.columns || []).slice(),
      unique: !!i.unique,
      primary: false,
    }));
  const pkIdx = (info.indexes || []).filter((i) => i.primary || i.name === 'PRIMARY');
  const foreignKeys = (info.foreignKeys || []).map((fk) => ({
    name: fk.name || '',
    origName: fk.name || '',
    columns: (fk.columns || []).slice(),
    refSchema: fk.refSchema || '',
    refTable: fk.refTable || '',
    refColumns: (fk.refColumns || []).slice(),
    onUpdate: normalizeAction(fk.onUpdate),
    onDelete: normalizeAction(fk.onDelete),
    rebuildSafe: fk.rebuildSafe !== false,
  }));
  return {
    table,
    comment: info.tableComment || '',
    options: '',
    columns,
    indexes,
    foreignKeys,
    constraints,
    // 保留主键索引信息供 ALTER 时取约束名
    _pkIndexes: pkIdx,
  };
}

// ---------------- 跨方言类型映射（数据传输用） ----------------
// 源类型 → 通用类型
const TO_GENERIC = {
  tinyint: 'tinyint', smallint: 'smallint', mediumint: 'int', int: 'int', integer: 'int', bigint: 'bigint',
  decimal: 'decimal', numeric: 'decimal', number: 'decimal', money: 'decimal', smallmoney: 'decimal',
  float: 'float', real: 'float', double: 'double', 'double precision': 'double',
  binary_float: 'float', binary_double: 'double',
  varchar: 'varchar', 'character varying': 'varchar', nvarchar: 'varchar', varchar2: 'varchar', nvarchar2: 'varchar',
  char: 'char', character: 'char', nchar: 'char', fixedstring: 'char',
  text: 'text', tinytext: 'text', mediumtext: 'text', longtext: 'text', ntext: 'text', clob: 'text', nclob: 'text', string: 'text',
  date: 'date', date32: 'date',
  datetime: 'datetime', datetime2: 'datetime', smalldatetime: 'datetime', datetime64: 'datetime',
  timestamp: 'datetime', timestamptz: 'datetime', 'timestamp without time zone': 'datetime', 'timestamp with time zone': 'datetime',
  time: 'time', timetz: 'time', 'time without time zone': 'time', year: 'int',
  bool: 'bool', boolean: 'bool', bit: 'bool',
  blob: 'blob', tinyblob: 'blob', mediumblob: 'blob', longblob: 'blob', binary: 'blob', varbinary: 'blob',
  bytea: 'blob', image: 'blob', raw: 'blob',
  json: 'json', jsonb: 'json',
  uuid: 'uuid', uniqueidentifier: 'uuid',
  enum: 'varchar', set: 'varchar', inet: 'varchar', interval: 'varchar',
  int8: 'tinyint', int16: 'smallint', int32: 'int', int64: 'bigint',
  uint8: 'smallint', uint16: 'int', uint32: 'bigint', uint64: 'bigint',
  float32: 'float', float64: 'double',
  serial: 'int', bigserial: 'bigint',
};
// 通用类型 → 目标方言 [类型, 长度?, 小数?]；'L'/'S' 表示沿用源长度/小数
const FROM_GENERIC = {
  mysql: {
    tinyint: ['tinyint'], smallint: ['smallint'], int: ['int'], bigint: ['bigint'],
    decimal: ['decimal', 'L', 'S'], float: ['float'], double: ['double'],
    varchar: ['varchar', 'L'], char: ['char', 'L'], text: ['longtext'],
    date: ['date'], datetime: ['datetime'], time: ['time'],
    bool: ['tinyint', '1'], blob: ['longblob'], json: ['json'], uuid: ['char', '36'],
  },
  postgres: {
    tinyint: ['smallint'], smallint: ['smallint'], int: ['integer'], bigint: ['bigint'],
    decimal: ['numeric', 'L', 'S'], float: ['real'], double: ['double precision'],
    varchar: ['varchar', 'L'], char: ['char', 'L'], text: ['text'],
    date: ['date'], datetime: ['timestamp'], time: ['time'],
    bool: ['boolean'], blob: ['bytea'], json: ['jsonb'], uuid: ['uuid'],
  },
  mssql: {
    tinyint: ['tinyint'], smallint: ['smallint'], int: ['int'], bigint: ['bigint'],
    decimal: ['decimal', 'L', 'S'], float: ['real'], double: ['float'],
    varchar: ['nvarchar', 'L'], char: ['nchar', 'L'], text: ['nvarchar', 'max'],
    date: ['date'], datetime: ['datetime2'], time: ['time'],
    bool: ['bit'], blob: ['varbinary', 'max'], json: ['nvarchar', 'max'], uuid: ['uniqueidentifier'],
  },
  sqlite: {
    tinyint: ['INTEGER'], smallint: ['INTEGER'], int: ['INTEGER'], bigint: ['INTEGER'],
    decimal: ['NUMERIC'], float: ['REAL'], double: ['REAL'],
    varchar: ['TEXT'], char: ['TEXT'], text: ['TEXT'],
    date: ['TEXT'], datetime: ['TEXT'], time: ['TEXT'],
    bool: ['INTEGER'], blob: ['BLOB'], json: ['TEXT'], uuid: ['TEXT'],
  },
  clickhouse: {
    tinyint: ['Int8'], smallint: ['Int16'], int: ['Int32'], bigint: ['Int64'],
    decimal: ['Decimal', 'L', 'S'], float: ['Float32'], double: ['Float64'],
    varchar: ['String'], char: ['String'], text: ['String'],
    date: ['Date'], datetime: ['DateTime'], time: ['String'],
    bool: ['Bool'], blob: ['String'], json: ['String'], uuid: ['UUID'],
  },
  oracle: {
    tinyint: ['NUMBER', '3'], smallint: ['NUMBER', '5'], int: ['NUMBER', '10'], bigint: ['NUMBER', '19'],
    decimal: ['NUMBER', 'L', 'S'], float: ['BINARY_FLOAT'], double: ['BINARY_DOUBLE'],
    varchar: ['VARCHAR2', 'L'], char: ['CHAR', 'L'], text: ['CLOB'],
    date: ['DATE'], datetime: ['TIMESTAMP'], time: ['VARCHAR2', '16'],
    bool: ['NUMBER', '1'], blob: ['BLOB'], json: ['CLOB'], uuid: ['VARCHAR2', '36'],
  },
};

/** 把设计器模型的列类型翻译到目标方言；返回 warnings 数组 */
function translateModel(model, fromDialect, toDialect) {
  if (fromDialect === toDialect) return { model, warnings: [] };
  const warnings = [];
  const out = JSON.parse(JSON.stringify(model));
  const toMap = FROM_GENERIC[toDialect] || FROM_GENERIC.mysql;
  for (const col of out.columns) {
    let base = String(col.type || '').toLowerCase().trim().replace(/\s+unsigned$/, '');
    let generic = TO_GENERIC[base];
    if (base === 'tinyint' && String(col.length) === '1') generic = 'bool';
    if (!generic) {
      generic = 'text';
      warnings.push(`栏位 ${col.name}: 未识别类型 ${col.type}，按文本处理`);
    }
    const spec = toMap[generic] || toMap.text;
    col.type = spec[0];
    col.length = spec[1] === 'L' ? col.length : (spec[1] || '');
    col.scale = spec[2] === 'S' ? col.scale : (spec[2] || '');
    if (generic === 'blob' && toDialect === 'clickhouse') {
      warnings.push(`栏位 ${col.name}: ClickHouse 无二进制类型，按 String 存储`);
    }
  }
  return { model: out, warnings };
}

module.exports = { typeOptions, caps, buildCreateTable, buildAlterTable, buildAddColumns, infoToModel, composeType, composeDefault, translateModel };
