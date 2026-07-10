// SQL 工具：语句拆分、值清洗、CSV 等（与具体数据库方言解耦的部分）

/**
 * 将一段 SQL 脚本拆分为独立语句。
 * 处理：单引号/双引号字符串、MySQL 反引号、MySQL 反斜杠转义、MSSQL [] 标识符、
 * PostgreSQL $tag$ 美元引用、行注释(-- 与 MySQL #)、块注释。
 */
// 过程体（BEGIN…END）感知：命中后只在语句以 END 结尾时才允许按分号拆分
const ROUTINE_BODY_RE = /\bCREATE\s+(OR\s+REPLACE\s+)?(DEFINER\s*=\s*\S+\s+)?(TEMP(ORARY)?\s+)?(PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i;
const BODY_END_RE = /\bEND\s*$/i;

function splitSql(sql, dialect) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  const isMysql = dialect === 'mysql';
  const isPg = dialect === 'postgres';
  const isMs = dialect === 'mssql';
  const hasDollarQuotes = isPg || dialect === 'clickhouse';
  // MySQL 与 SQLite 的过程/触发器体内含分号，需特殊处理（pg 用 $$ 引用天然安全）
  const bodyAware = isMysql || dialect === 'sqlite';
  // SQLite 也接受反引号/方括号标识符，但字符串中不使用 MySQL 式反斜杠转义。
  const backtickIdentifiers = isMysql || dialect === 'clickhouse' || dialect === 'sqlite';
  const backslashStrings = isMysql || dialect === 'clickhouse';

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 行注释
    const dashComment = ch === '-' && next === '-'
      && (!isMysql || i + 2 >= n || sql.charCodeAt(i + 2) <= 32);
    if (dashComment || (isMysql && ch === '#')) {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? n : j;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    // 块注释
    if (ch === '/' && next === '*') {
      let end;
      if (isPg) {
        let level = 1;
        let j = i + 2;
        while (j < n && level) {
          if (sql[j] === '/' && sql[j + 1] === '*') { level++; j += 2; }
          else if (sql[j] === '*' && sql[j + 1] === '/') { level--; j += 2; }
          else j++;
        }
        end = j;
      } else {
        const j = sql.indexOf('*/', i + 2);
        end = j === -1 ? n : j + 2;
      }
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    // Oracle alternative quoting: q'[It's; fine]', q'{...}', q'<...>', q'!...!'.
    if ((dialect === 'oracle' || dialect === 'oracle12')
        && (ch === 'q' || ch === 'Q') && next === "'" && i + 2 < n) {
      const open = sql[i + 2];
      const closeChar = ({ '[': ']', '{': '}', '(': ')', '<': '>' })[open] || open;
      const close = sql.indexOf(closeChar + "'", i + 3);
      const end = close === -1 ? n : close + 2;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    // PostgreSQL E'...' strings use backslash escapes even when standard strings do not.
    if (isPg && (ch === 'e' || ch === 'E') && next === "'"
        && (i === 0 || !/[A-Za-z0-9_$]/.test(sql[i - 1]))) {
      let j = i + 2;
      while (j < n) {
        if (sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      cur += sql.slice(i, j);
      i = j;
      continue;
    }
    // 字符串 / 引用标识符
    if (ch === "'" || ch === '"' || (backtickIdentifiers && ch === '`')) {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (backslashStrings && quote !== '`' && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue; } // '' 转义
          j++;
          break;
        }
        j++;
      }
      cur += sql.slice(i, j);
      i = j;
      continue;
    }
    // MSSQL [ident]
    if ((isMs || dialect === 'sqlite') && ch === '[') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ']') {
          if (sql[j + 1] === ']') { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      cur += sql.slice(i, j);
      i = j;
      continue;
    }
    // PostgreSQL $tag$ ... $tag$
    if (hasDollarQuotes && ch === '$') {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const j = sql.indexOf(tag, i + tag.length);
        const end = j === -1 ? n : j + tag.length;
        cur += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    if (ch === ';') {
      if (bodyAware && ROUTINE_BODY_RE.test(cur) && !BODY_END_RE.test(cur.trimEnd())) {
        cur += ch; // 仍在过程体内，分号属于语句体
        i++;
        continue;
      }
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

function pad(n, w) { return String(n).padStart(w || 2, '0'); }

function formatDate(d) {
  if (isNaN(d.getTime())) return String(d);
  let s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (d.getMilliseconds()) s += '.' + pad(d.getMilliseconds(), 3);
  return s;
}

const MAX_TEXT = 200000;
const MAX_BLOB_PREVIEW = 256;

/** 把驱动返回的单元格值转成可经 IPC 传输、可在界面显示的值 */
function sanitizeValue(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string') {
    return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + ' …(已截断)' : v;
  }
  if (t === 'number' || t === 'boolean') return v;
  if (t === 'bigint') return v.toString();
  if (v instanceof Date) return formatDate(v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const buf = Buffer.isBuffer(v) ? v : Buffer.from(v);
    return {
      __blob: true,
      length: buf.length,
      hex: buf.slice(0, MAX_BLOB_PREVIEW).toString('hex'),
    };
  }
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function sanitizeRows(rows) {
  return rows.map((r) => r.map(sanitizeValue));
}

function excerpt(sql, len) {
  const s = sql.replace(/\s+/g, ' ').trim();
  return s.length > (len || 90) ? s.slice(0, len || 90) + '…' : s;
}

/** CSV 单元格编码 */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.__blob) return '0x' + v.hex + (v.length > MAX_BLOB_PREVIEW ? '...' : '');
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 根据列定义合成近似 DDL（用于 pg / mssql 没有 SHOW CREATE 的场景） */
function synthesizeDDL(qualified, columns, pk, indexes, quote) {
  const lines = columns.map((c) => {
    let s = '  ' + quote(c.name) + ' ' + c.type;
    if (!c.nullable) s += ' NOT NULL';
    if (c.def !== null && c.def !== undefined && c.def !== '') s += ' DEFAULT ' + c.def;
    return s;
  });
  if (pk && pk.length) lines.push('  PRIMARY KEY (' + pk.map(quote).join(', ') + ')');
  let ddl = `CREATE TABLE ${qualified} (\n${lines.join(',\n')}\n);`;
  const extra = (indexes || []).filter((ix) => !ix.primary && ix.def).map((ix) => ix.def + ';');
  if (extra.length) ddl += '\n\n' + extra.join('\n');
  return ddl;
}

/**
 * 只扫描 SQL 的结构性 token（忽略注释、字符串和引用标识符）。
 * 这里不是完整 SQL parser；它只服务于结果集限额下推，因此遇到不确定的结构会保守地不改写。
 */
function structuralTokens(sql, dialect) {
  const out = [];
  const n = sql.length;
  let i = 0;
  let depth = 0;
  let complete = true;
  const backslashStrings = dialect === 'mysql' || dialect === 'clickhouse';

  const quoted = (start, quote, doubled, backslash) => {
    let j = start + 1;
    while (j < n) {
      if (backslash && sql[j] === '\\') { j += 2; continue; }
      if (sql[j] === quote) {
        if (doubled && sql[j + 1] === quote) { j += 2; continue; }
        return j + 1;
      }
      j++;
    }
    return -1;
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (/\s/.test(ch)) { i++; continue; }

    const dashComment = ch === '-' && next === '-'
      && (dialect !== 'mysql' || i + 2 >= n || sql.charCodeAt(i + 2) <= 32);
    if (dashComment || (dialect === 'mysql' && ch === '#')) {
      const eol = sql.indexOf('\n', i + 1);
      i = eol === -1 ? n : eol + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      // MySQL/MariaDB execute these comment bodies. Treating them as inert can
      // append a second LIMIT or miss an embedded statement, so never rewrite.
      if (dialect === 'mysql' && (sql[i + 2] === '!' || /^\/\*M!/i.test(sql.slice(i, i + 4)))) {
        complete = false;
      }
      // PostgreSQL 允许嵌套块注释；顺手兼容，避免注释中的关键字造成误判。
      let level = 1;
      let j = i + 2;
      while (j < n && level) {
        if (sql[j] === '/' && sql[j + 1] === '*') { level++; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { level--; j += 2; }
        else j++;
      }
      if (level) complete = false;
      i = j;
      continue;
    }

    if (ch === "'" || ch === '"' || ((dialect === 'mysql' || dialect === 'clickhouse' || dialect === 'sqlite') && ch === '`')) {
      const found = quoted(i, ch, true, backslashStrings && ch !== '`');
      if (found < 0) complete = false;
      const end = found < 0 ? n : found;
      out.push({ value: '<quoted>', start: i, end, depth });
      i = end;
      continue;
    }
    if ((dialect === 'mssql' || dialect === 'sqlite') && ch === '[') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === ']' && sql[j + 1] === ']') { j += 2; continue; }
        if (sql[j] === ']') { j++; closed = true; break; }
        j++;
      }
      if (!closed) complete = false;
      out.push({ value: '<quoted>', start: i, end: j, depth });
      i = j;
      continue;
    }
    if ((dialect === 'postgres' || dialect === 'clickhouse') && ch === '$') {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) complete = false;
        const end = close === -1 ? n : close + tag.length;
        out.push({ value: '<quoted>', start: i, end, depth });
        i = end;
        continue;
      }
    }
    if (dialect === 'postgres' && (ch === 'e' || ch === 'E') && next === "'") {
      const found = quoted(i + 1, "'", true, true);
      if (found < 0) complete = false;
      const end = found < 0 ? n : found;
      out.push({ value: '<quoted>', start: i, end, depth });
      i = end;
      continue;
    }
    // Oracle q'[text]' / q'{text}' 等替代引用。
    if ((dialect === 'oracle' || dialect === 'oracle12') && (ch === 'q' || ch === 'Q') && next === "'" && i + 2 < n) {
      const open = sql[i + 2];
      const closeChar = ({ '[': ']', '{': '}', '(': ')', '<': '>' })[open] || open;
      const close = sql.indexOf(closeChar + "'", i + 3);
      if (close === -1) complete = false;
      const end = close === -1 ? n : close + 2;
      out.push({ value: '<quoted>', start: i, end, depth });
      i = end;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$#]/.test(sql[j])) j++;
      out.push({ value: sql.slice(i, j).toUpperCase(), start: i, end: j, depth });
      i = j;
      continue;
    }
    if (/\d/.test(ch)) {
      let j = i + 1;
      while (j < n && /\d/.test(sql[j])) j++;
      out.push({ value: sql.slice(i, j), start: i, end: j, depth });
      i = j;
      continue;
    }
    if (ch === '(') {
      out.push({ value: ch, start: i, end: i + 1, depth });
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) complete = false;
      depth = Math.max(0, depth - 1);
      out.push({ value: ch, start: i, end: i + 1, depth });
      i++;
      continue;
    }
    out.push({ value: ch, start: i, end: i + 1, depth });
    i++;
  }
  out.complete = complete && depth === 0;
  return out;
}

/** Return the top-level statement kind after comments and CTE declarations. */
function statementKind(sql, dialect) {
  const tokens = structuralTokens(String(sql || ''), dialect);
  if (!tokens.complete) return null;
  const top = tokens.filter((t) => t.depth === 0 && t.value !== ';');
  if (!top.length) return null;
  if (top[0].value !== 'WITH') return top[0].value;
  const starters = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);
  const main = top.find((t, i) => i > 0 && starters.has(t.value));
  return main ? main.value : 'WITH';
}

function hasClickHouseFormatClause(sql) {
  const tokens = structuralTokens(String(sql || ''), 'clickhouse');
  if (!tokens.complete) return false;
  const top = tokens.filter((t) => t.depth === 0 && t.value !== ';');
  return top.some((token, i) => token.value === 'FORMAT' && i + 2 === top.length
    && /^[A-Z_][A-Z0-9_$#]*$/.test(top[i + 1] && top[i + 1].value));
}

/**
 * SQLite can reach files outside the selected database through ATTACH and
 * VACUUM ... INTO. Datavia deliberately keeps arbitrary SQL inside the one
 * database chosen through the native connection dialog.
 */
function hasSQLiteExternalFileClause(sql) {
  const tokens = structuralTokens(String(sql || ''), 'sqlite');
  // Incomplete SQL cannot execute; let SQLite report its normal syntax error.
  // The external-file forms are checked whenever tokenization is complete.
  if (!tokens.complete) return false;
  const top = tokens.filter((t) => t.depth === 0 && t.value !== ';');
  if (!top.length) return false;
  if (top[0].value === 'ATTACH') return true;
  return top[0].value === 'VACUUM' && top.some((t) => t.value === 'INTO');
}

/**
 * 给常见的单条 SELECT/CTE 查询增加 maxRows + 1 探针限制。
 * 返回的 applied 用于区分“驱动完整返回”与“数据库端仅返回探针行”，从而正确标记总行数是否精确。
 */
function limitQueryRows(sql, dialect, maxRows) {
  const n = Number(maxRows);
  if (!Number.isFinite(n) || n <= 0) return { sql, applied: false };
  const wanted = Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER - 1) + 1;
  const tokens = structuralTokens(sql, dialect);
  if (!tokens.complete) return { sql, applied: false };
  const top = tokens.filter((t) => t.depth === 0);
  if (!top.length) return { sql, applied: false };

  // 允许 SQL Server 常见的 ;WITH 开头以及语句末尾分号，但中间分号意味着批内多语句，绝不改写。
  let first = 0;
  while (first < top.length && top[first].value === ';') first++;
  let last = top.length - 1;
  while (last >= first && top[last].value === ';') last--;
  if (last < first) return { sql, applied: false };
  for (let i = first; i <= last; i++) {
    if (top[i].value === ';') return { sql, applied: false };
  }
  const stmt = top.slice(first, last + 1);

  let selectAt = -1;
  if (stmt[0].value === 'SELECT') {
    selectAt = 0;
  } else if (stmt[0].value === 'WITH') {
    // CTE 内的语句位于括号深度 1+；深度 0 的第一个主语句关键字才决定是否可限额。
    const starters = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);
    selectAt = stmt.findIndex((t, i) => i > 0 && starters.has(t.value));
    if (selectAt < 0 || stmt[selectAt].value !== 'SELECT') return { sql, applied: false };
  } else {
    return { sql, applied: false };
  }

  const tail = stmt.slice(selectAt + 1);
  const words = new Set(tail.map((t) => t.value));
  if (dialect === 'mssql') {
    // T-SQL batches may separate statements with whitespace alone. Injecting TOP
    // into only the first SELECT would leave later recordsets unbounded while
    // incorrectly marking all of them as server-limited.
    const batchStarters = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'EXEC', 'EXECUTE', 'DECLARE']);
    if (tail.some((t) => batchStarters.has(t.value))) return { sql, applied: false };
  }
  // SELECT INTO 会写数据；锁定子句与特殊输出子句的语法位置也因方言而异，保守跳过。
  if (words.has('INTO') || words.has('FOR')) return { sql, applied: false };
  const replaceNumericToken = (token) => ({
    sql: sql.slice(0, token.start) + String(wanted) + sql.slice(token.end),
    applied: true,
    probeRows: wanted,
  });
  const capClauseNumber = (keyword, picker, atOverride) => {
    const at = Number.isInteger(atOverride) ? atOverride : tail.findIndex((t) => t.value === keyword);
    if (at < 0) return null;
    const token = picker(tail, at);
    if (!token) return { sql, applied: false };
    if (token.value === 'ALL') return replaceNumericToken(token);
    if (!/^\d+$/.test(token.value)) return { sql, applied: false };
    return Number(token.value) > wanted ? replaceNumericToken(token) : { sql, applied: false };
  };

  // 已有巨大显式上限也要收紧，否则驱动仍会先物化数百万行；较小上限保持原义和精确行数。
  const limitDialects = new Set(['mysql', 'postgres', 'sqlite', 'clickhouse']);
  let clickhouseNeedsGlobalLimit = false;
  if (limitDialects.has(dialect) && words.has('LIMIT')) {
    const pickLimitCount = (list, at) => {
      const unlimitedAt = (index) => dialect === 'sqlite' && list[index] && list[index].value === '-'
        && list[index + 1] && list[index + 1].value === '1'
        ? { value: 'ALL', start: list[index].start, end: list[index + 1].end }
        : null;
      // MySQL/SQLite LIMIT offset,count: the expression after the comma is count.
      const commaAt = list.findIndex((t, i) => i > at && i <= at + 4 && t.value === ',');
      if (commaAt >= 0) return unlimitedAt(commaAt + 1) || list[commaAt + 1];
      const unlimited = unlimitedAt(at + 1);
      if (unlimited) return unlimited;
      if (dialect === 'postgres' && list[at + 1] && list[at + 1].value === 'NULL') {
        return { ...list[at + 1], value: 'ALL' };
      }
      return list[at + 1];
    };
    if (dialect === 'clickhouse') {
      const limitAts = tail.map((t, i) => t.value === 'LIMIT' ? i : -1).filter((i) => i >= 0);
      let globalAt = -1;
      for (let x = limitAts.length - 1; x >= 0; x--) {
        const at = limitAts[x];
        const end = x + 1 < limitAts.length ? limitAts[x + 1] : tail.length;
        // LIMIT ... BY is a per-group limit and does not cap the whole result.
        if (!tail.slice(at + 2, end).some((t) => t.value === 'BY')) { globalAt = at; break; }
      }
      if (globalAt >= 0) return capClauseNumber('LIMIT', pickLimitCount, globalAt);
      clickhouseNeedsGlobalLimit = true;
    } else {
      return capClauseNumber('LIMIT', pickLimitCount);
    }
  }
  const fetchDialects = new Set(['postgres', 'mssql', 'oracle', 'oracle12']);
  if (fetchDialects.has(dialect) && words.has('FETCH')) {
    return capClauseNumber('FETCH', (list, at) => {
      // Only recognize the actual SQL-standard clause. A bare identifier named
      // "fetch" must never cause an unrelated numeric expression to be rewritten.
      if (!list[at + 1] || !['FIRST', 'NEXT'].includes(list[at + 1].value)) return null;
      const count = list[at + 2];
      if (!count) return null;
      // FETCH FIRST ROW ONLY has an implicit limit of one and needs no tightening.
      if (['ROW', 'ROWS'].includes(count.value) && list[at + 3] && list[at + 3].value === 'ONLY') return null;
      if (!(count.value === 'ALL' || /^\d+$/.test(count.value))) return null;
      const rows = list[at + 3];
      const only = list[at + 4];
      if (!rows || !['ROW', 'ROWS'].includes(rows.value) || !only || only.value !== 'ONLY') return null;
      return count;
    });
  }
  if (dialect === 'mssql' && words.has('TOP')) {
    if (words.has('PERCENT') || words.has('TIES')) return { sql, applied: false };
    const topToken = tail.find((t) => t.value === 'TOP');
    const after = sql.slice(topToken.end);
    const match = /^(?:\s*\(\s*|\s+)(\d+)/.exec(after);
    if (!match || Number(match[1]) <= wanted) return { sql, applied: false };
    const start = topToken.end + match[0].lastIndexOf(match[1]);
    return {
      sql: sql.slice(0, start) + String(wanted) + sql.slice(start + match[1].length),
      applied: true,
      probeRows: wanted,
    };
  }
  if (words.has('OFFSET') && !(dialect === 'clickhouse' && clickhouseNeedsGlobalLimit)) {
    const offsetToken = tail.find((t) => t.value === 'OFFSET');
    if (dialect === 'postgres') {
      // PostgreSQL requires LIMIT before OFFSET.
      return {
        sql: sql.slice(0, offsetToken.start) + `LIMIT ${wanted} ` + sql.slice(offsetToken.start),
        applied: true,
        probeRows: wanted,
      };
    }
    if (dialect === 'mssql') {
      // FETCH (handled above when present) is the bounded companion to OFFSET.
      const optionToken = tail.find((t) => t.value === 'OPTION');
      const insertAt = optionToken
        ? optionToken.start
        : (last + 1 < top.length ? top[last + 1].start : top[last].end);
      return {
        sql: sql.slice(0, insertAt) + ` FETCH NEXT ${wanted} ROWS ONLY${optionToken ? ' ' : ''}` + sql.slice(insertAt),
        applied: true,
        probeRows: wanted,
      };
    }
    // Other dialects either do not support standalone OFFSET or require a
    // different surrounding grammar; do not guess.
    return { sql, applied: false };
  }
  // TOP 只能限制当前 query specification；直接注入 UNION 第一支会改变结果语义。
  if (dialect === 'mssql' && (words.has('UNION') || words.has('INTERSECT') || words.has('EXCEPT'))) {
    return { sql, applied: false };
  }
  if ((dialect === 'oracle' || dialect === 'oracle12') && words.has('ROWNUM')) return { sql, applied: false };
  if (dialect === 'mysql' && (words.has('LOCK') || words.has('PROCEDURE'))) return { sql, applied: false };

  let rewritten;
  if (dialect === 'mssql') {
    // T-SQL 中 TOP 位于 SELECT [ALL|DISTINCT] 之后。
    let anchor = stmt[selectAt];
    const modifier = stmt[selectAt + 1];
    if (modifier && (modifier.value === 'ALL' || modifier.value === 'DISTINCT')) anchor = modifier;
    const nextToken = stmt[stmt.indexOf(anchor) + 1];
    if (nextToken && nextToken.value === '@') return { sql, applied: false }; // SELECT @var = ...
    rewritten = sql.slice(0, anchor.end) + ` TOP (${wanted})` + sql.slice(anchor.end);
  } else if (dialect === 'oracle') {
    // The adapter uses this dialect until a capability probe confirms FETCH FIRST.
    // An 11g ROWNUM wrapper is not equivalent for every projection (duplicate
    // column names, NEXTVAL, and other Oracle restrictions), so do not guess.
    return { sql, applied: false };
  } else {
    const suffix = dialect === 'oracle12'
      ? ` FETCH FIRST ${wanted} ROWS ONLY`
      : ` LIMIT ${wanted}`;
    // 插在尾部分号和尾随注释之前，避免 LIMIT 被 -- 注释吞掉。
    let insertAt = last + 1 < top.length ? top[last + 1].start : top[last].end;
    let beforeClickHouseClause = false;
    if (dialect === 'clickhouse') {
      // ClickHouse requires LIMIT before SETTINGS / FORMAT. Only accept clause
      // shapes that cannot be confused with a projection named settings/format.
      const candidates = [];
      for (let i = 0; i < tail.length; i++) {
        if (tail[i].value === 'SETTINGS' && tail[i + 1] && /^[A-Z_][A-Z0-9_$#]*$/.test(tail[i + 1].value)
            && tail[i + 2] && tail[i + 2].value === '=') candidates.push(tail[i].start);
        if (tail[i].value === 'FORMAT' && i + 2 === tail.length
            && /^[A-Z_][A-Z0-9_$#]*$/.test(tail[i + 1] && tail[i + 1].value)) candidates.push(tail[i].start);
      }
      if (candidates.length) {
        insertAt = Math.min(...candidates);
        beforeClickHouseClause = true;
      }
    }
    rewritten = sql.slice(0, insertAt) + suffix + (beforeClickHouseClause ? ' ' : '') + sql.slice(insertAt);
  }
  return { sql: rewritten, applied: true, probeRows: wanted };
}

module.exports = {
  splitSql, sanitizeValue, sanitizeRows, formatDate, excerpt, csvCell, synthesizeDDL,
  limitQueryRows, statementKind, hasClickHouseFormatClause, hasSQLiteExternalFileClause,
};
