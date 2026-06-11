// SQL 工具：语句拆分、值清洗、CSV 等（与具体数据库方言解耦的部分）

/**
 * 将一段 SQL 脚本拆分为独立语句。
 * 处理：单引号/双引号字符串、MySQL 反引号、MySQL 反斜杠转义、MSSQL [] 标识符、
 * PostgreSQL $tag$ 美元引用、行注释(-- 与 MySQL #)、块注释。
 */
function splitSql(sql, dialect) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  const isMysql = dialect === 'mysql';
  const isPg = dialect === 'postgres';
  const isMs = dialect === 'mssql';
  // MySQL 与 ClickHouse：反引号标识符 + 字符串内反斜杠转义
  const backtickStyle = isMysql || dialect === 'clickhouse';

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 行注释
    if ((ch === '-' && next === '-') || (isMysql && ch === '#')) {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? n : j;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    // 块注释
    if (ch === '/' && next === '*') {
      const j = sql.indexOf('*/', i + 2);
      const end = j === -1 ? n : j + 2;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    // 字符串 / 引用标识符
    if (ch === "'" || ch === '"' || (backtickStyle && ch === '`')) {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (backtickStyle && quote !== '`' && sql[j] === '\\') { j += 2; continue; }
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
    if (isMs && ch === '[') {
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
    if (isPg && ch === '$') {
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

module.exports = { splitSql, sanitizeValue, sanitizeRows, formatDate, excerpt, csvCell, synthesizeDDL };
