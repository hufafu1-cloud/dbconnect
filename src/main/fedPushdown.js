// 跨库联邦查询：谓词下推与列裁剪
//
// 联邦查询原本是「整张源表拉到本地再筛」，于是 WHERE 写得再精确也省不掉传输量，
// 单源 10 万行的上限就成了硬墙。下推之后，筛选交给源库自己做，回来的行数
// 通常小两三个数量级——这才是把「受限版」摘掉的那一步。
//
// ── 唯一的设计底线：只推可证明等价的，其余一律不推 ──────────────────
//
// 这与 impact.js「能保证等价改写的才给数字」是同一条原则，而且这里更危险：
// 下推推错**不会报错，只会给出看起来正常的错结果**。所以宁可不推。
//
// 具体地，下推要跨方言，而联邦 SQL 是按本地引擎（SQLite）的语义写的，
// 推到 MySQL / PostgreSQL / Oracle 上执行时有三类陷阱：
//
// 1. **函数与语法不通用。** `datetime('now')` 是 SQLite 的写法；`||` 在 SQLite/PG
//    是拼接、在 MySQL 默认模式下是 OR。因此只允许「列 运算符 字面量」这种
//    各家写法完全一致的形状，任何函数调用、表达式、列与列比较都不推。
//
// 2. **排序规则不同。** MySQL 默认排序规则大小写不敏感，PostgreSQL 敏感，
//    SQLite 是二进制比较。字符串列上的 `<` `>` 推过去可能**少**捞行，
//    而少捞的行本地再也补不回来。所以字符串列只允许 `=` / `IN` / `IS NULL`——
//    这几个方向上源库只会比本地更宽松（多捞），本地那份条件会把多的滤掉。
//    反过来 `<>` / `NOT IN` 在更宽松的源库上会**多排除**，因此字符串列不许推。
//
// 3. **外连接的空侧不能提前过滤。** `A LEFT JOIN B … WHERE B.x IS NULL` 是反连接，
//    先把 B 过滤成 x IS NULL 会让本该匹配上的 A 行变成未匹配，结果多出行来。
//    判断哪一侧是空侧需要完整的连接树，成本高收益低，因此**只要出现外连接就整体不推**。
//
// 下推的条件**同时保留在本地 SQL 里**：这样即便源库把范围放得更宽，
// 本地那一遍仍会滤成正确结果。下推只能减少传输量，不能改变结果。
const { structuralTokens } = require('./db/sqlutil');
const { translateType } = require('./db/ddl');

// 结束 FROM 区段的顶层子句词
const CLAUSE = new Set([
  'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'WINDOW',
  'UNION', 'INTERSECT', 'EXCEPT', 'FETCH', 'RETURNING',
]);
// FROM 区段里不能当作别名的词
const JOIN_WORDS = new Set([
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL',
  'ON', 'USING', 'AS',
]);
const OUTER_WORDS = new Set(['LEFT', 'RIGHT', 'FULL', 'OUTER', 'NATURAL']);

// 只在这些运算符上做下推；每一个的跨方言语义都逐条核对过（见文件头第 2 点）
const COMPARISON = new Set(['=', '<>', '!=', '>', '>=', '<', '<=']);
// 字符串列只允许"源库更宽松"的方向
const STRING_SAFE_OPS = new Set(['=', 'IN', 'IS NULL', 'IS NOT NULL']);

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
  'AS', 'ON', 'USING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS',
  'NATURAL', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'GLOB', 'REGEXP',
  'MATCH', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'ALL',
  'UNION', 'INTERSECT', 'EXCEPT', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST',
  'CAST', 'COLLATE', 'ESCAPE', 'EXISTS', 'TRUE', 'FALSE', 'WITH', 'RECURSIVE',
  'OVER', 'PARTITION', 'WINDOW', 'FILTER', 'INTO', 'VALUES', 'DEFAULT',
]);

const textOf = (sql, token) => sql.slice(token.start, token.end);
const unquote = (text) => {
  const s = String(text);
  if (/^".*"$/s.test(s)) return s.slice(1, -1).replace(/""/g, '"');
  if (/^`.*`$/s.test(s)) return s.slice(1, -1).replace(/``/g, '`');
  return s;
};
const isWord = (token) => /^[A-Za-z_]/.test(token.value) && token.value !== '<quoted>';
const isQuotedIdent = (sql, token) => token.value === '<quoted>' && /^["`]/.test(textOf(sql, token));
const isStringLiteral = (sql, token) => token.value === '<quoted>' && textOf(sql, token).startsWith("'");

const fail = (reason) => ({ ok: false, reason, byName: new Map(), aliases: new Map(), skipped: [] });

/** 读一个标识符（裸词或带引号），返回 {name, next} */
function readIdent(sql, tokens, i) {
  const token = tokens[i];
  if (!token) return null;
  if (isQuotedIdent(sql, token)) return { name: unquote(textOf(sql, token)), next: i + 1 };
  if (isWord(token)) return { name: textOf(sql, token), next: i + 1 };
  return null;
}

/** 读一个 `别名.列` 引用 */
function readColumnRef(sql, tokens, i) {
  const left = readIdent(sql, tokens, i);
  if (!left) return null;
  if (!tokens[left.next] || tokens[left.next].value !== '.') return null;
  const right = readIdent(sql, tokens, left.next + 1);
  if (!right) return null;
  return { alias: left.name, column: right.name, next: right.next };
}

/**
 * 读一个字面量：数字（含负号与小数）或单引号字符串。
 *
 * 分词器把 `1.5` 拆成 `1` `.` `5`，把负号单独成词，所以这里要按序拼回来
 * 再用正则复核——只有确认是纯字面量才允许下推。
 */
function readLiteral(sql, tokens, i) {
  const token = tokens[i];
  if (!token) return null;
  if (isStringLiteral(sql, token)) {
    const raw = textOf(sql, token);
    return { kind: 'str', value: raw.slice(1, -1).replace(/''/g, "'"), next: i + 1 };
  }
  let at = i;
  let sign = '';
  if (tokens[at] && (tokens[at].value === '-' || tokens[at].value === '+')) {
    sign = tokens[at].value;
    at++;
  }
  if (!tokens[at] || !/^\d+$/.test(tokens[at].value)) return null;
  let text = sign + tokens[at].value;
  at++;
  if (tokens[at] && tokens[at].value === '.' && tokens[at + 1] && /^\d+$/.test(tokens[at + 1].value)) {
    text += '.' + tokens[at + 1].value;
    at += 2;
  }
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) return null;
  return { kind: 'num', value: Number(text), next: at };
}

/** 列的通用类型分类：决定哪些运算符能安全下推 */
function classifyColumn(columns, name) {
  const column = (columns || []).find((c) => String(c.name).toLowerCase() === String(name).toLowerCase());
  if (!column) return null;
  const generic = translateType(column.type, 'sqlite').generic;
  if (['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'float', 'double'].includes(generic)) return 'number';
  if (['date', 'datetime', 'time'].includes(generic)) return 'temporal';
  if (generic === 'bool') return 'number';
  if (generic === 'blob') return 'blob';
  return 'string';
}

/** 定位 FROM 区段并取出每个源表的别名；顺便判断有没有外连接 */
function parseFrom(sql, tokens, localNames) {
  // 顶层记号在完整数组里的下标。只用它定位子句边界；取片段一律从完整数组切，
  // 否则括号里的内容（IN 列表、函数参数）会整段消失。
  const top = [];
  tokens.forEach((token, index) => { if (token.depth === 0) top.push(index); });
  const at = (i) => tokens[top[i]];
  if (top.some((index) => ['UNION', 'INTERSECT', 'EXCEPT'].includes(tokens[index].value))) {
    return { error: '查询含 UNION / INTERSECT / EXCEPT，作用域不唯一' };
  }
  if (top.length && at(0).value === 'WITH') return { error: '查询以 CTE 开头' };
  const fromAt = top.findIndex((index) => tokens[index].value === 'FROM');
  if (fromAt < 0) return { error: '未找到 FROM 子句' };
  let end = top.length;
  for (let i = fromAt + 1; i < top.length; i++) {
    if (CLAUSE.has(at(i).value)) { end = i; break; }
  }
  const region = tokens.slice(top[fromAt] + 1, top[end - 1] !== undefined ? top[end - 1] + 1 : tokens.length)
    .filter((token) => token.depth === 0);
  if (region.some((token) => OUTER_WORDS.has(token.value))) {
    return { error: '查询含外连接，提前过滤空侧会改变结果' };
  }
  const aliases = new Map();
  const seen = new Set();
  for (let i = 0; i < region.length; i++) {
    const token = region[i];
    if (token.value !== '<quoted>') continue;
    const name = unquote(textOf(sql, token));
    if (!localNames.has(name)) continue;
    seen.add(name);
    let alias = name;
    let at = i + 1;
    if (region[at] && region[at].value === 'AS') at++;
    const ident = readIdent(sql, region, at);
    if (ident && !JOIN_WORDS.has(region[at].value) && !CLAUSE.has(region[at].value)) {
      alias = ident.name;
    }
    if (aliases.has(alias)) return { error: `别名 ${alias} 出现多次，无法区分是哪一张源表` };
    aliases.set(alias, name);
  }
  if (seen.size !== localNames.size) {
    return { error: '有源表出现在子查询里，无法确定它的作用域' };
  }
  return { aliases, fromAt, end, top };
}

/** 把 WHERE 区段按顶层 AND 切成若干条件 */
function whereConjuncts(tokens, top, fromEnd) {
  const at = (i) => tokens[top[i]];
  if (fromEnd >= top.length || at(fromEnd).value !== 'WHERE') return { terms: [] };
  let end = top.length;
  for (let i = fromEnd + 1; i < top.length; i++) {
    if (CLAUSE.has(at(i).value) && at(i).value !== 'WHERE') { end = i; break; }
  }
  // 顶层 AND / OR 的位置用下标表示，切片仍然从完整数组取（保住括号内容）
  const first = top[fromEnd] + 1;
  const last = end < top.length ? top[end] : tokens.length;
  const cuts = [];
  for (let i = fromEnd + 1; i < end; i++) {
    if (at(i).value === 'OR') return { terms: [], error: 'WHERE 顶层含 OR，条件不是合取式' };
    if (at(i).value === 'AND') cuts.push(top[i]);
  }
  const terms = [];
  let start = first;
  for (const cut of cuts) {
    terms.push(tokens.slice(start, cut));
    start = cut + 1;
  }
  terms.push(tokens.slice(start, last));
  return { terms: terms.filter((term) => term.length) };
}

/**
 * 把一个条件匹配成可下推的形状。只认四种：
 *   别名.列 <比较运算符> 字面量
 *   别名.列 IS [NOT] NULL
 *   别名.列 [NOT] IN (字面量, …)
 * 其余（函数调用、列与列比较、子查询、BETWEEN、LIKE…）一律不推。
 */
function matchTerm(sql, tokens) {
  const ref = readColumnRef(sql, tokens, 0);
  if (!ref) return { reason: '不是「别名.列 运算符 字面量」的形状' };
  let at = ref.next;
  const rest = tokens.slice(at);
  if (!rest.length) return { reason: '条件不完整' };

  if (rest[0].value === 'IS') {
    const not = rest[1] && rest[1].value === 'NOT';
    const nullAt = not ? 2 : 1;
    if (rest[nullAt] && rest[nullAt].value === 'NULL' && rest.length === nullAt + 1) {
      return { ref, op: not ? 'IS NOT NULL' : 'IS NULL', values: [] };
    }
    return { reason: 'IS 后面不是单纯的 NULL' };
  }

  const negated = rest[0].value === 'NOT';
  const head = negated ? 1 : 0;
  if (rest[head] && rest[head].value === 'IN') {
    if (!rest[head + 1] || rest[head + 1].value !== '(') return { reason: 'IN 后面不是字面量列表' };
    const values = [];
    let i = head + 2;
    for (;;) {
      const literal = readLiteral(sql, rest, i);
      if (!literal) return { reason: 'IN 列表里有非字面量' };
      values.push({ kind: literal.kind, value: literal.value });
      i = literal.next;
      if (rest[i] && rest[i].value === ',') { i++; continue; }
      break;
    }
    if (!rest[i] || rest[i].value !== ')' || i !== rest.length - 1) return { reason: 'IN 列表不完整' };
    if (!values.length) return { reason: 'IN 列表为空' };
    return { ref, op: negated ? 'NOT IN' : 'IN', values };
  }
  if (negated) return { reason: 'NOT 只支持 NOT IN 与 IS NOT NULL' };

  // 比较运算符可能由一到两个字符组成（>= <= <> !=）
  let op = rest[0].value;
  let opEnd = 1;
  if (rest[1] && ['=', '>'].includes(rest[1].value) && ['<', '>', '!'].includes(op)) {
    op += rest[1].value;
    opEnd = 2;
  }
  if (!COMPARISON.has(op)) return { reason: `不支持的运算符 ${op}` };
  const literal = readLiteral(sql, rest, opEnd);
  if (!literal || literal.next !== rest.length) return { reason: '运算符右边不是单个字面量' };
  return { ref, op, values: [{ kind: literal.kind, value: literal.value }] };
}

/** 该运算符能不能安全推给这种类型的列（见文件头第 2 点） */
function opAllowed(op, kind) {
  if (op === 'IS NULL' || op === 'IS NOT NULL') return true;
  if (kind === 'blob' || !kind) return false;
  if (kind === 'number' || kind === 'temporal') return true;
  // 字符串列只走「源库只会更宽松」的方向
  return STRING_SAFE_OPS.has(op);
}

/**
 * 列裁剪：只有**整条查询里的列引用全部写成 别名.列** 时才裁剪。
 *
 * 出现裸列名就放弃——分辨「输出别名 / 函数名 / 真的列名」需要完整语法分析，
 * 猜错的代价是给源库发一条列不存在的 SQL。保守到只认全限定写法，
 * 代价只是少一次优化，不会把查询搞坏。
 */
function collectProjection(sql, tokens, aliases, localNames) {
  const byAlias = new Map([...aliases.keys()].map((alias) => [alias, new Set()]));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.value === '*') {
      const dotted = i >= 1 && tokens[i - 1].value === '.';
      if (!dotted) return { ok: false, reason: '查询里有 SELECT *' };
      const owner = readIdent(sql, tokens, i - 2);
      if (owner && byAlias.has(owner.name)) return { ok: false, reason: `查询里有 ${owner.name}.*` };
      continue;
    }
    const ref = readColumnRef(sql, tokens, i);
    if (ref) {
      if (byAlias.has(ref.alias)) byAlias.get(ref.alias).add(ref.column);
      i = ref.next - 1;
      continue;
    }
    if (!isWord(token) && !isQuotedIdent(sql, token)) continue;
    if (isQuotedIdent(sql, token) && localNames.has(unquote(textOf(sql, token)))) continue;  // 源表名本身
    if (KEYWORDS.has(token.value)) continue;
    if (tokens[i + 1] && tokens[i + 1].value === '(') continue;          // 函数名
    if (i >= 1 && tokens[i - 1].value === 'AS') continue;                // 输出别名
    if (aliases.has(textOf(sql, token))) continue;                       // 表别名本身
    if (i >= 1 && tokens[i - 1].value === '.') continue;                 // 已经被上面配对处理
    return { ok: false, reason: `列 ${textOf(sql, token)} 没有写成「别名.列」` };
  }
  return { ok: true, byAlias };
}

/**
 * 分析一条已经改写成本地表名的联邦 SQL。
 *
 * sources: [{ localName, columns: [{name, type}] }]
 * 返回 { ok, reason, aliases, byName: Map<localName, {predicates, columns}>, skipped }
 */
function analyze(localSql, sources) {
  const sql = String(localSql || '');
  const localNames = new Set(sources.map((s) => s.localName));
  const columnsByName = new Map(sources.map((s) => [s.localName, s.columns || []]));
  if (!localNames.size) return fail('查询没有引用跨源表');

  const tokens = structuralTokens(sql, 'sqlite');
  if (!tokens.complete) return fail('SQL 无法完整分词（引号或括号不配对）');

  const from = parseFrom(sql, tokens, localNames);
  if (from.error) return fail(from.error);

  const byName = new Map([...localNames].map((name) => [name, { predicates: [], columns: null }]));
  const skipped = [];

  const { terms, error } = whereConjuncts(tokens, from.top, from.end);
  if (error) skipped.push({ text: '', reason: error });
  for (const term of terms) {
    const text = sql.slice(term[0].start, term[term.length - 1].end);
    const matched = matchTerm(sql, term);
    if (matched.reason) { skipped.push({ text, reason: matched.reason }); continue; }
    const localName = from.aliases.get(matched.ref.alias);
    if (!localName) { skipped.push({ text, reason: `${matched.ref.alias} 不是跨源表的别名` }); continue; }
    const kind = classifyColumn(columnsByName.get(localName), matched.ref.column);
    if (!kind) { skipped.push({ text, reason: `源表里没有列 ${matched.ref.column}` }); continue; }
    if (!opAllowed(matched.op, kind)) {
      skipped.push({
        text,
        reason: kind === 'string'
          ? `字符串列上的 ${matched.op} 各数据库排序规则不同，下推可能少捞行`
          : `${kind === 'blob' ? '二进制列' : '该列'}不支持 ${matched.op} 下推`,
      });
      continue;
    }
    byName.get(localName).predicates.push({
      column: matched.ref.column, op: matched.op, values: matched.values, text,
    });
  }

  const projection = collectProjection(sql, tokens, from.aliases, localNames);
  if (projection.ok) {
    for (const [alias, localName] of from.aliases) {
      const wanted = projection.byAlias.get(alias);
      if (wanted && wanted.size) byName.get(localName).columns = [...wanted];
    }
  } else {
    skipped.push({ text: '', reason: `未裁剪列：${projection.reason}` });
  }

  return { ok: true, reason: '', aliases: from.aliases, byName, skipped };
}

/**
 * 把可下推的条件渲染成**源库方言**的 WHERE 片段。
 *
 * 关键：字面量必须用源适配器重新生成，绝不能把本地 SQL 的原文搬过去——
 * 转义规则各家不同（MySQL 的反斜杠、Oracle 的日期写法）。
 */
function renderWhere(adapter, predicates) {
  const parts = [];
  for (const item of predicates) {
    const column = adapter.quoteIdent(item.column);
    const literal = (value) => (value.kind === 'num' ? String(value.value) : adapter.literal(value.value));
    if (item.op === 'IS NULL' || item.op === 'IS NOT NULL') {
      parts.push(`${column} ${item.op}`);
    } else if (item.op === 'IN' || item.op === 'NOT IN') {
      parts.push(`${column} ${item.op} (${item.values.map(literal).join(', ')})`);
    } else {
      parts.push(`${column} ${item.op} ${literal(item.values[0])}`);
    }
  }
  return parts.join(' AND ');
}

module.exports = { analyze, renderWhere, matchTerm, readLiteral, readColumnRef, classifyColumn };
