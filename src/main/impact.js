// SQL 影响范围预检：执行 UPDATE / DELETE 之前，用同样的 WHERE 跑一次 COUNT(*)，
// 告诉用户「这条会影响多少行」。
//
// 设计底线与导出保真度一致：**能安全改写的才改写，不能保证等价的一律明说「无法预估」，
// 绝不给一个可能是错的数字让人放心。** 一个错的行数比没有行数危险得多。
//
// 关键实现：先做一份与原文等长的掩码（注释变空格、字符串内容变 x），
// 用掩码定位关键字，再按下标从**原文**切片。这样既不会匹配到字面量里的
// where/join，也不会破坏要重新拼接的 SQL 原文。

/** 与原文等长的掩码：注释与字符串内容被抹掉，但长度和下标完全对齐 */
function maskLiterals(sql) {
  const src = String(sql || '');
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) out[k] = ' '; };
  while (i < n) {
    const ch = src[i];
    const two = src.slice(i, i + 2);
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === '--' || (ch === '#' && (i === 0 || /\s/.test(src[i - 1])))) {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    // PostgreSQL 美元引用 $tag$ … $tag$
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(src.slice(i));
      if (tag) {
        const close = src.indexOf(tag[0], i + tag[0].length);
        const stop = close < 0 ? n : close + tag[0].length;
        blank(i + tag[0].length, close < 0 ? n : close);
        i = stop;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\' && ch !== '`') { j += 2; continue; }
        if (src[j] === ch) {
          if (src[j + 1] === ch) { j += 2; continue; } // 连续两个引号是转义
          break;
        }
        j++;
      }
      for (let k = i + 1; k < Math.min(j, n); k++) out[k] = 'x';
      i = Math.min(j + 1, n);
      continue;
    }
    i++;
  }
  return out.join('');
}

/** 每个字符所处的括号深度，用来只认顶层关键字 */
function depthMap(mask) {
  const depths = new Array(mask.length);
  let depth = 0;
  for (let i = 0; i < mask.length; i++) {
    const ch = mask[i];
    if (ch === '(') { depths[i] = depth; depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); depths[i] = depth; continue; }
    depths[i] = depth;
  }
  return depths;
}

/** 找顶层（括号深度 0）的关键字位置；找不到返回 -1 */
function findTopLevel(mask, depths, keyword, from = 0) {
  const re = new RegExp(`\\b${keyword}\\b`, 'ig');
  re.lastIndex = from;
  let m;
  while ((m = re.exec(mask))) {
    if (depths[m.index] === 0) return m.index;
  }
  return -1;
}

const unsupported = (kind, reason, sql) => ({ kind, supported: false, reason, sql });

/**
 * 按掩码的非空白跨度切片。
 * 注释在掩码里是空白，因此跨度会自动把首尾的注释排除掉——这既让校验看到真正的
 * 表引用，也避免把 `-- 注释` 拼进生成的 SQL 里，否则它会把后面的 WHERE 整个注释掉。
 */
function maskedSpan(original, mask, from, to) {
  let start = Math.max(0, from);
  let end = Math.min(mask.length, to);
  while (start < end && /\s/.test(mask[start])) start++;
  while (end > start && /\s/.test(mask[end - 1])) end--;
  return { text: original.slice(start, end), masked: mask.slice(start, end) };
}

/** 表引用必须是单表：出现 JOIN / USING / 逗号分隔的多表都不改写 */
function singleTableRef(span) {
  const masked = span.masked.replace(/;+$/, '').trim();
  const text = span.text.replace(/;+$/, '').trim();
  if (!masked || !text) return null;
  if (/[,]/.test(masked)) return null;
  if (/\b(join|using|cross|inner|outer|left|right|full|natural)\b/i.test(masked)) return null;
  return text;
}

/**
 * 分析单条语句。返回：
 *   null                            不是 UPDATE / DELETE，无需预检
 *   {supported:false, reason}       是写操作但无法安全改写
 *   {supported:true, countSql, ...} 可以用 countSql 精确预估
 */
function analyzeStatement(sql) {
  const original = String(sql || '');
  const mask = maskLiterals(original);
  if (!mask.trim()) return null;
  const depths = depthMap(mask);
  const head = mask.trimStart();
  const isDelete = /^delete\b/i.test(head);
  const isUpdate = /^update\b/i.test(head);
  const startsWithCte = /^with\b/i.test(head);

  if (startsWithCte && /\b(update|delete)\b/i.test(mask)) {
    return unsupported('cte', '语句以 CTE 开头，改写后不保证与原语句等价', original);
  }
  if (!isDelete && !isUpdate) return null;
  const kind = isDelete ? 'delete' : 'update';

  // 这些形态一律不猜：多表、带条数限制、带返回子句
  if (/\breturning\b/i.test(mask)) return unsupported(kind, '包含 RETURNING 子句', original);
  if (/\boutput\b/i.test(mask)) return unsupported(kind, '包含 OUTPUT 子句', original);
  if (findTopLevel(mask, depths, 'limit') >= 0) return unsupported(kind, '包含 LIMIT，实际影响行数受条数限制', original);
  if (/^(delete|update)\s+top\b/i.test(head)) return unsupported(kind, '包含 TOP，实际影响行数受条数限制', original);

  let tableSegment;
  let whereStart;
  if (isDelete) {
    const fromPos = findTopLevel(mask, depths, 'from');
    if (fromPos < 0) return unsupported(kind, '未找到 FROM 子句', original);
    // DELETE 与 FROM 之间有别名 = MySQL/SQL Server 的多表删除
    const between = mask.slice(mask.search(/\bdelete\b/i) + 6, fromPos).trim();
    if (between) return unsupported(kind, '多表删除，无法对应到单张表', original);
    const usingPos = findTopLevel(mask, depths, 'using', fromPos);
    if (usingPos >= 0) return unsupported(kind, '包含 USING 的多表删除', original);
    whereStart = findTopLevel(mask, depths, 'where', fromPos);
    const tableEnd = whereStart >= 0 ? whereStart : mask.length;
    tableSegment = maskedSpan(original, mask, fromPos + 4, tableEnd);
  } else {
    const setPos = findTopLevel(mask, depths, 'set');
    if (setPos < 0) return unsupported(kind, '未找到 SET 子句', original);
    // SET 之后再出现顶层 FROM = SQL Server / PostgreSQL 的关联更新
    const fromPos = findTopLevel(mask, depths, 'from', setPos);
    if (fromPos >= 0) return unsupported(kind, '关联更新（SET 之后带 FROM）', original);
    const updatePos = mask.search(/\bupdate\b/i);
    tableSegment = maskedSpan(original, mask, updatePos + 6, setPos);
    // WHERE 必须从 SET 之后找，且只认顶层——否则会误取 SET 子查询里的 WHERE
    whereStart = findTopLevel(mask, depths, 'where', setPos);
  }

  const table = singleTableRef(tableSegment);
  if (!table) return unsupported(kind, '涉及多张表或无法识别的表引用', original);

  const whereClause = whereStart >= 0
    ? original.slice(whereStart).trim().replace(/;+$/, '').trim()
    : '';
  return {
    kind,
    supported: true,
    table,
    hasWhere: !!whereClause,
    countSql: `SELECT COUNT(*) AS dbpanda_impact FROM ${table}${whereClause ? ` ${whereClause}` : ''}`,
    sql: original,
  };
}

/** 分析整段脚本；splitStatements 由调用方注入，避免本模块依赖方言拆分实现 */
function analyze(sql, splitStatements) {
  const statements = splitStatements(String(sql || ''));
  const out = [];
  statements.forEach((statement, index) => {
    const result = analyzeStatement(statement);
    if (result) out.push({ ...result, index });
  });
  return out;
}

/** 从 COUNT 查询的结果里取出行数；取不到就当作未知 */
function readCount(results) {
  const first = Array.isArray(results) ? results.find((r) => r && Array.isArray(r.rows)) : null;
  const row = first && first.rows[0];
  if (!row) return null;
  const value = Array.isArray(row) ? row[0] : row[Object.keys(row)[0]];
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 跑预检。runCount(countSql) 由调用方提供（好让事务里的预检走同一个会话，
 * 看到未提交的改动）。任何一条 COUNT 失败都只把那条标成未知，不影响其它条目。
 */
async function preview(sql, { splitStatements, runCount }) {
  const items = analyze(sql, splitStatements);
  const out = [];
  for (const item of items) {
    if (!item.supported) { out.push(item); continue; }
    try {
      const rows = readCount(await runCount(item.countSql));
      out.push(rows === null
        ? { ...item, supported: false, reason: '预估查询未返回行数' }
        : { ...item, rows });
    } catch (error) {
      out.push({ ...item, supported: false, reason: `预估失败：${(error && error.message) || error}` });
    }
  }
  return out;
}

module.exports = { analyze, analyzeStatement, preview, maskLiterals };
