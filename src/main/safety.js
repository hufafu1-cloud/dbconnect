// Production-operation approvals live in the main process. Approval tokens are
// short-lived, single-use, tied to the requesting WebContents and to a stable
// fingerprint of the exact operation payload.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const TOKEN_TTL_MS = 30 * 1000;
const approvals = new Map();

function splitStatements(sql) {
  const out = [];
  let cur = '';
  let quote = null;
  let i = 0;
  const text = String(sql || '');
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote !== '`' && next !== undefined) {
        cur += next;
        i += 2;
        continue;
      }
      if (ch === quote && next === quote) {
        cur += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    // Use MySQL's stricter -- comment rule. For other dialects this may produce
    // a conservative extra approval for "--comment" without whitespace, but it
    // cannot hide executable MySQL tokens behind a false comment boundary.
    if (ch === '-' && next === '-' && (i + 2 >= text.length || text.charCodeAt(i + 2) <= 32)) {
      while (i < text.length && text[i] !== '\n') cur += text[i++];
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') cur += text[i++];
      continue;
    }
    if (ch === '/' && next === '*') {
      cur += '/*';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) cur += text[i++];
      if (i < text.length) {
        cur += '*/';
        i += 2;
      }
      continue;
    }
    if (ch === '$') {
      const match = /^\$[A-Za-z_0-9]*\$/.exec(text.slice(i, i + 64));
      if (match) {
        const tag = match[0];
        const end = text.indexOf(tag, i + tag.length);
        const nextIndex = end === -1 ? text.length : end + tag.length;
        cur += text.slice(i, nextIndex);
        i = nextIndex;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function normalizeSql(stmt) {
  return String(stmt || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--(?=\s|$)[^\n]*/g, ' ')
    .replace(/(^|\s)#[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\s+/g, ' ')
    .trim();
}

function lacksRealWhere(sql) {
  const match = /\bwhere\b(.*)$/i.exec(sql);
  if (!match) return true;
  const where = match[1].trim().replace(/;$/, '');
  return /^(1\s*=\s*1|true|'1'\s*=\s*'1')$/i.test(where);
}

function classifyStatement(stmt) {
  const sql = normalizeSql(stmt);
  if (!sql) return null;
  if (/^drop\s+(database|schema)\b/i.test(sql)) return { level: 'high', reason: '删除数据库或模式（DROP DATABASE / SCHEMA）' };
  if (/^drop\s+/i.test(sql)) return { level: 'high', reason: '删除数据库对象（DROP）' };
  if (/^truncate\b/i.test(sql)) return { level: 'high', reason: '清空表数据（TRUNCATE）' };
  if (/^delete\b/i.test(sql)) {
    return lacksRealWhere(sql)
      ? { level: 'high', reason: '整表删除（DELETE 缺少有效 WHERE 条件）' }
      : { level: 'medium', reason: '删除生产数据（DELETE）' };
  }
  if (/^update\b/i.test(sql)) {
    return lacksRealWhere(sql)
      ? { level: 'high', reason: '全表更新（UPDATE 缺少有效 WHERE 条件）' }
      : { level: 'medium', reason: '更新生产数据（UPDATE）' };
  }
  if (/^alter\s+table\b/i.test(sql)) {
    return /\bdrop\b/i.test(sql)
      ? { level: 'high', reason: 'ALTER TABLE 删除列或约束' }
      : { level: 'medium', reason: '修改表结构（ALTER TABLE）' };
  }
  if (/^(insert\s+into|replace\s+into|merge\s+into|upsert\b)/i.test(sql)) return { level: 'medium', reason: '写入生产数据' };
  if (/^(create|rename|comment)\b/i.test(sql)) return { level: 'medium', reason: '变更数据库结构' };
  if (/^(grant|revoke)\b/i.test(sql)) return { level: 'medium', reason: '变更数据库权限' };
  if (/^(call|exec(?:ute)?|do)\b/i.test(sql)) return { level: 'medium', reason: '调用可能写入数据的存储程序' };
  if (/^(load\s+data|copy\b.*\bfrom\b)/i.test(sql)) return { level: 'medium', reason: '批量写入生产数据' };
  if (/^explain\b.*\banalyze\b.*\b(insert|update|delete|merge|replace)\b/i.test(sql)) return { level: 'medium', reason: 'EXPLAIN ANALYZE 将实际执行写操作' };
  if (/^select\b[\s\S]*\binto\b/i.test(sql)) return { level: 'medium', reason: 'SELECT INTO 将创建或写入对象' };
  if (/^(vacuum|reindex|cluster|refresh\s+materialized\s+view|lock\s+table)\b/i.test(sql)) return { level: 'medium', reason: '执行生产库维护或锁定操作' };
  if (/^with\b/i.test(sql) && /\b(insert|delete|update|merge|replace)\b/i.test(sql)) return { level: 'medium', reason: 'CTE 中包含写操作' };
  return null;
}

function analyzeDanger(sql) {
  const items = [];
  for (const statement of splitStatements(sql)) {
    const classified = classifyStatement(statement);
    if (classified) items.push({ ...classified, sql: statement });
  }
  return items;
}

const WRITE_ANYWHERE_RE = /\b(INSERT|UPDATE|DELETE|MERGE|REPLACE|UPSERT|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|CALL|EXEC|EXECUTE|DO|COPY|LOAD|SET|RESET|VACUUM|REINDEX|CLUSTER|ATTACH|DETACH)\b/i;
const SAFE_READ_FUNCTIONS = new Set([
  // SQL grammar constructs / aggregates / windows
  'as', 'in', 'exists', 'over', 'filter', 'within', 'values',
  'count', 'sum', 'avg', 'min', 'max', 'string_agg', 'array_agg', 'group_concat',
  'row_number', 'rank', 'dense_rank', 'lag', 'lead', 'first_value', 'last_value', 'ntile',
  // Pure scalar functions commonly used across supported dialects
  'abs', 'ceil', 'ceiling', 'floor', 'round', 'power', 'sqrt', 'mod', 'sign', 'exp', 'ln', 'log',
  'lower', 'upper', 'length', 'char_length', 'octet_length', 'trim', 'ltrim', 'rtrim',
  'substring', 'substr', 'replace', 'concat', 'concat_ws', 'left', 'right', 'position', 'locate',
  'coalesce', 'nullif', 'cast', 'convert', 'try_cast', 'try_convert', 'greatest', 'least', 'iif', 'ifnull',
  'dateadd', 'datediff', 'date_trunc', 'extract', 'to_char', 'to_date', 'strftime', 'unix_timestamp', 'now',
  'json_extract', 'json_value', 'json_query', 'json_object', 'json_array', 'json_build_object',
  'json_agg', 'jsonb_agg', 'md5', 'sha1', 'sha2', 'hex', 'typeof', 'quote', 'printf',
  'database', 'version', 'current_database', 'current_schema', 'current_user', 'generate_series',
]);

function unknownFunctionCalls(stmt) {
  const sql = normalizeSql(stmt);
  const unknown = new Set();
  const re = /([\p{L}_][\p{L}\p{N}_$]*(?:\s*\.\s*[\p{L}_][\p{L}\p{N}_$]*)*)\s*\(/gu;
  let match;
  while ((match = re.exec(sql))) {
    const qualified = match[1].replace(/\s+/g, '');
    const name = qualified.toLowerCase();
    // A schema-qualified name may shadow an equally named builtin (for example
    // public.count()). Non-ASCII and quoted names are user-defined/ambiguous.
    if (qualified.includes('.') || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(qualified)
        || !SAFE_READ_FUNCTIONS.has(name)) unknown.add(match[1]);
  }
  if (/(?:(?:""|`[^`]*`|\[[^\]]*\]))\s*\(/.test(sql)) unknown.add('quoted-function');
  if (/\bOPERATOR\s*\(/i.test(sql)) unknown.add('custom-operator');
  return [...unknown];
}

/** 只明确放行可读语句；未知语法在生产库一律进入审批，而不是依赖黑名单猜测。 */
function isExplicitlyReadOnly(stmt) {
  const raw = String(stmt || '');
  if (/\/\*(?:!|M!)/i.test(raw)) return false; // MySQL / MariaDB 可执行版本注释
  const normalized = normalizeSql(raw);
  if (!normalized) return true;
  if (/^(SHOW|DESC|DESCRIBE|EXISTS)\b/i.test(normalized)) return true;
  if (/^EXPLAIN\b/i.test(normalized)) {
    const explained = normalized.replace(/^EXPLAIN\b(?:\s+ANALYZE\b)?/i, '');
    if (WRITE_ANYWHERE_RE.test(explained)) return false;
    return !/\bANALYZE\b/i.test(normalized) || unknownFunctionCalls(explained).length === 0;
  }
  if (!/^(SELECT|WITH)\b/i.test(normalized)) return false;
  if (/\bINTO\b|\bFOR\s+(UPDATE|SHARE)\b/i.test(normalized)) return false;
  return !WRITE_ANYWHERE_RE.test(normalized) && unknownFunctionCalls(raw).length === 0;
}

function analyzeForExecution(sql) {
  const items = [];
  for (const statement of splitStatements(sql)) {
    const classified = classifyStatement(statement);
    if (classified) items.push({ ...classified, sql: statement });
    else if (!isExplicitlyReadOnly(statement)) {
      items.push({ level: 'medium', reason: '该语句未被明确识别为只读操作', sql: statement });
    }
  }
  return items;
}

function assertReadOnlyQuery(sql) {
  const statements = splitStatements(String(sql || ''));
  if (statements.length !== 1 || !isExplicitlyReadOnly(statements[0])) {
    throw new Error('执行计划仅允许单条只读 SELECT/CTE 查询');
  }
}

function assertWhereFragment(where) {
  const fragment = String(where || '').trim();
  if (!fragment) return;
  if (/\/\*(?:!|M!)/i.test(fragment)) throw new Error('筛选条件不允许 MySQL/MariaDB 可执行注释');
  const statements = splitStatements(`SELECT 1 WHERE ${fragment}`);
  if (statements.length !== 1 || !isExplicitlyReadOnly(statements[0])) {
    throw new Error('筛选条件只能包含单个只读表达式，不能附加其他 SQL');
  }
}

function cleanPayload(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : cleanPayload(item));
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'approvalToken' || key === '_approvalToken' || value[key] === undefined) continue;
    out[key] = cleanPayload(value[key]);
  }
  return out;
}

function fileStamp(operation, payload) {
  if (!['dba.runSqlFile', 'import.run'].includes(operation) || !payload || !payload.file) return null;
  try {
    const resolved = path.resolve(payload.file);
    const before = fs.statSync(resolved);
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(resolved, 'r');
    try {
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const read = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (!read) break;
        hash.update(chunk.subarray(0, read));
      }
    } finally {
      fs.closeSync(fd);
    }
    const after = fs.statSync(resolved);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || (before.ino && after.ino && before.ino !== after.ino)) {
      throw new Error('审批读取期间文件已发生变化，请重试');
    }
    return {
      path: resolved,
      size: after.size,
      mtimeMs: after.mtimeMs,
      sha256: hash.digest('hex'),
    };
  } catch (e) {
    if (e && /审批读取期间/.test(e.message)) throw e;
    return { path: path.resolve(payload.file), missing: true };
  }
}

function connectionStamps(operation, payload) {
  const p = payload || {};
  const ids = [];
  for (const key of ['connId', 'srcConnId', 'dstConnId']) {
    if (p[key]) ids.push(String(p[key]));
  }
  if (operation === 'conn.save' && p.id) ids.push(String(p.id));
  return [...new Set(ids)].sort().map((id) => {
    const cfg = store.getById(id);
    const digest = crypto.createHash('sha256')
      .update(JSON.stringify(cleanPayload(cfg)))
      .digest('hex');
    return { id, digest };
  });
}

function fingerprint(operation, payload, stampedFile) {
  const material = JSON.stringify({
    operation,
    payload: cleanPayload(payload),
    file: stampedFile === undefined ? fileStamp(operation, payload) : stampedFile,
    connections: connectionStamps(operation, payload),
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

function connection(id) {
  if (!id) throw new Error('审批操作缺少连接 ID');
  const cfg = store.getById(id);
  return { id: cfg.id, name: cfg.name || cfg.id, env: cfg.env || '' };
}

function genericItem(reason, detail) {
  return [{ level: 'high', reason, sql: detail || '' }];
}

function describe(operation, payload) {
  const p = payload || {};
  let target;
  let title = '生产库危险操作';
  let items = [];
  let intrinsicallyDangerous = true;

  switch (operation) {
    case 'db.query':
      target = connection(p.connId);
      items = analyzeForExecution(p.sql);
      if (!items.length && splitStatements(p.sql).length) {
        items = splitStatements(p.sql).map((sql) => ({
          level: 'low',
          reason: '在生产连接上执行自由 SQL（只读语法也可能调用自定义函数或运算符）',
          sql,
        }));
      }
      // Client-side SQL classification cannot prove that a SELECT is free of
      // side effects across all supported engines (custom functions/operators).
      // Therefore every non-empty free-SQL request to production is approved.
      intrinsicallyDangerous = splitStatements(p.sql).length > 0;
      title = `即将在生产连接「${target.name}」上执行 SQL`;
      break;
    case 'conn.save': {
      if (!p.id) {
        target = { id: '', name: p.name || '新连接', env: '' };
        intrinsicallyDangerous = false;
        break;
      }
      target = connection(p.id);
      intrinsicallyDangerous = target.env === 'prod' && p.env !== 'prod';
      title = `即将取消生产连接「${target.name}」的生产标记`;
      items = genericItem('移除生产环境保护标记', `${target.name}: prod → ${p.env || '未标记'}`);
      break;
    }
    case 'db.action':
      target = connection(p.connId);
      title = `即将在生产连接「${target.name}」上执行数据库操作`;
      items = genericItem(`数据库对象操作：${p.action || '未知动作'}`, JSON.stringify(cleanPayload(p), null, 2));
      break;
    case 'db.applyEdits': {
      target = connection(p.connId);
      const count = Array.isArray(p.edits) ? p.edits.length : 0;
      intrinsicallyDangerous = count > 0;
      title = `即将在生产连接「${target.name}」上应用表数据更改`;
      items = genericItem(`应用 ${count} 处表数据更改`, `${p.schema ? p.schema + '.' : ''}${p.table || ''}`);
      break;
    }
    case 'design.apply':
      target = connection(p.connId);
      title = `即将在生产连接「${target.name}」上应用表结构设计`;
      items = genericItem(p.original ? '修改生产表结构' : '在生产库创建新表', (p.model && p.model.table) || '');
      break;
    case 'import.run':
      target = connection(p.connId);
      title = `即将向生产连接「${target.name}」导入数据`;
      items = genericItem(p.truncate ? '导入前清空目标表并写入数据' : '向目标表批量写入数据', `${p.schema ? p.schema + '.' : ''}${p.table || ''}\n${p.file || ''}`);
      break;
    case 'dba.transfer': {
      const source = connection(p.srcConnId);
      const destination = connection(p.dstConnId);
      // Writing into production and exporting data out of production are both
      // explicit approval boundaries. Prefer the destination name if both are prod.
      target = destination.env === 'prod' ? destination : source;
      intrinsicallyDangerous = source.env === 'prod' || destination.env === 'prod';
      title = destination.env === 'prod'
        ? `即将向生产连接「${target.name}」传输数据`
        : `即将从生产连接「${target.name}」传出数据`;
      items = genericItem(p.dropExisting ? '覆盖目标表并传输数据' : '向目标库传输表结构或数据', `${p.dstSchema ? p.dstSchema + '.' : ''}${p.dstDb || ''}`);
      break;
    }
    case 'dba.execSqls':
      target = connection(p.connId);
      intrinsicallyDangerous = Array.isArray(p.sqls) && p.sqls.length > 0;
      title = `即将在生产连接「${target.name}」上执行结构同步`;
      items = (p.sqls || []).slice(0, 30).map((sql) => ({ level: 'high', reason: '结构同步 DDL', sql }));
      if ((p.sqls || []).length > 30) items.push({ level: 'high', reason: `另有 ${(p.sqls || []).length - 30} 条语句`, sql: '…' });
      break;
    case 'dba.dataSync': {
      const source = connection(p.srcConnId);
      const destination = connection(p.dstConnId);
      target = destination.env === 'prod' ? destination : source;
      intrinsicallyDangerous = p.mode !== 'count' && (source.env === 'prod' || destination.env === 'prod');
      title = destination.env === 'prod'
        ? `即将在生产连接「${target.name}」上应用数据同步`
        : `即将从生产连接「${target.name}」生成或应用数据同步`;
      items = genericItem(p.doDelete ? '同步生产数据（包含删除多余行）' : '同步生产数据', `${p.dstSchema ? p.dstSchema + '.' : ''}${p.dstDb || ''}`);
      break;
    }
    case 'dba.runSqlFile':
      target = connection(p.connId);
      title = `即将在生产连接「${target.name}」上执行 SQL 文件`;
      items = genericItem('执行整个 SQL 文件', p.file || '');
      break;
    case 'db.killProcess':
    case 'db.killProcesses':
      target = connection(p.connId);
      title = `即将在生产连接「${target.name}」上结束数据库会话`;
      items = genericItem('结束生产数据库会话', JSON.stringify(p.pids || [p.pid]));
      break;
    case 'dba.dump':
      target = connection(p.connId);
      {
        const tables = Array.isArray(p.tables) ? p.tables : [];
        const singleTable = tables.length === 1 && tables[0] && tables[0].name;
        const tableName = singleTable
          ? `${tables[0].schema ? tables[0].schema + '.' : ''}${tables[0].name}`
          : '';
        title = singleTable
          ? `即将从生产连接「${target.name}」导出表转储`
          : `即将从生产连接「${target.name}」导出数据库转储`;
        const label = singleTable
          ? (p.includeData === false ? '导出生产表结构' : '导出生产表结构和数据')
          : '导出生产数据库完整 SQL 转储';
        items = genericItem(label, `${tableName}${tableName ? '\n' : ''}${p.file || ''}`);
      }
      break;
    case 'db.exportTable':
      target = connection(p.connId);
      title = `即将从生产连接「${target.name}」导出整表数据`;
      items = genericItem('导出生产表数据', `${p.schema ? p.schema + '.' : ''}${p.table || ''}\n${p.file || ''}`);
      break;
    default:
      throw new Error(`不支持的审批操作：${operation}`);
  }

  const required = intrinsicallyDangerous && target.env === 'prod';
  return {
    required,
    connId: target.id,
    connName: target.name,
    title,
    items: required ? items : [],
  };
}

function purgeExpired() {
  const now = Date.now();
  for (const [token, approval] of approvals) {
    if (approval.expiresAt <= now) approvals.delete(token);
  }
}

function normalizeConfirmation(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function issue(event, operation, payload, confirmation, expectedFingerprint) {
  purgeExpired();
  const info = describe(operation, payload);
  if (!info.required) return null;
  const boundFile = fileStamp(operation, payload);
  const currentFingerprint = fingerprint(operation, payload, boundFile);
  if (expectedFingerprint && currentFingerprint !== expectedFingerprint) {
    throw new Error('审批期间连接配置或操作内容已改变，请重新核对并审批');
  }
  if (normalizeConfirmation(confirmation) !== normalizeConfirmation(info.connName)) {
    throw new Error('连接名确认不匹配，审批未签发');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  approvals.set(token, {
    operation,
    fingerprint: currentFingerprint,
    file: boundFile,
    senderId: event.sender.id,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

function consume(event, operation, payload) {
  const info = describe(operation, payload);
  if (!info.required) return;
  purgeExpired();
  const token = payload && payload.approvalToken;
  if (!token) throw new Error('生产库操作已拦截：缺少有效审批');
  const approval = approvals.get(token);
  // Consume before validating/executing so even a failed attempt cannot replay it.
  approvals.delete(token);
  if (!approval || approval.expiresAt <= Date.now()) throw new Error('生产库操作已拦截：审批已过期或已使用');
  if (approval.senderId !== event.sender.id) throw new Error('生产库操作已拦截：审批来源不匹配');
  const currentFile = fileStamp(operation, payload);
  if (approval.operation !== operation || approval.fingerprint !== fingerprint(operation, payload, currentFile)) {
    throw new Error('生产库操作已拦截：操作内容与审批不匹配');
  }
  return { file: approval.file };
}

module.exports = {
  TOKEN_TTL_MS,
  analyzeDanger,
  analyzeForExecution,
  classifyStatement,
  isExplicitlyReadOnly,
  assertReadOnlyQuery,
  assertWhereFragment,
  splitStatements,
  describe,
  fingerprint,
  issue,
  consume,
};
