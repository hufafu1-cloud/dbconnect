// SQL 后悔药 / 回滚中心（路线图 v2.7.0 M3）
//
// 痛点很具体：`UPDATE` 漏写 WHERE 是最高频的生产事故，事后只能求 DBA 恢复备份。
// 这里做的事是：**执行前把将要被改动的那些行的原值加密快照下来**，
// 事后可以预览反向 SQL 并选择性回滚。
//
// ── 三条不肯让步的设计底线 ──────────────────────────────────────────
//
// 1. **不静默降级。** 无主键表、影响行数超阈值、多语句脚本、无法安全改写的语句，
//    一律**明确告诉用户「这条没有做快照」以及为什么**，绝不假装保护了。
//    一个以为有后悔药、真出事时却发现没有的用户，比一开始就知道没有的用户惨得多。
//
// 2. **快照范围与影响范围预检共用同一份解析。** impact.js 已经把「哪些语句能安全
//    改写成等价查询」想清楚了（掩码定位、拒绝多表 / CTE / LIMIT / RETURNING…），
//    快照直接复用它的表名与 WHERE 切片。两者若各自解析，就可能出现
//    「预检说影响 3 行、快照却存了别的行」——那种错误极难发现。
//
// 3. **存明文原值。** 快照经 localStore 加密落盘，但**内容不能被改写**：
//    截断过的长文本、只留 256 字节的 BLOB 预览，回滚时会把错的值写回数据库。
//    见路线图「两条通用数据流结论」第 2 条。
//
// ── 不做什么 ──────────────────────────────────────────────────────
//
// - **不承诺 DDL 回滚。** DROP / ALTER 不做快照，那是备份的职责。
// - **不承诺并发写入下的一致性。** 回滚前逐行比对「我们改完时的样子」与「现在的样子」，
//   对不上就是别人动过，这类行**默认跳过**并在界面上标出来。
// - **显式事务里不做快照。** 那种场景用户手上已经有 ROLLBACK，才是真正原子的撤销。
const impact = require('./impact');
const safety = require('./safety');
const localStore = require('./localStore');
const { valueLiteral } = require('./db/valueLiteral');
const { parseSimpleTableReference } = require('./db/sqlutil');

const BUCKET = 'undo';
const DEFAULT_MAX_ROWS = 50000;
const KEY_CHUNK = 400;

const unsupported = (reason) => ({ supported: false, reason });

// ---- 值编解码 ------------------------------------------------------------
//
// 快照要经 JSON 落盘，但驱动回传的值里有 JSON 表达不了的类型：Buffer、Date、
// BigInt、非有限浮点。直接 JSON.stringify 会把 Buffer 变成 {type:'Buffer',data:[…]}、
// 把 Date 变成字符串、遇到 BigInt 直接抛错——而这些值稍后要拿去生成反向 SQL 的字面量，
// 类型错了就是把错的值写回数据库。所以打标签存，读出来还原成原类型。

function encodeValue(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') return Number.isFinite(v) ? v : { __t: 'num', v: String(v) };
  if (t === 'bigint') return { __t: 'big', v: v.toString() };
  if (v instanceof Date) return { __t: 'date', v: v.toISOString() };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    return { __t: 'buf', v: Buffer.from(v).toString('base64') };
  }
  // 数组与普通对象（PG 数组、json/jsonb 列）一律加标签，
  // 免得用户数据里恰好有个 __t 字段被当成标签解回去
  return { __t: 'json', v };
}

function decodeValue(x) {
  if (x === null || x === undefined) return null;
  if (typeof x !== 'object') return x;
  switch (x.__t) {
    case 'num': return Number(x.v);
    case 'big': return BigInt(x.v);
    case 'date': return new Date(x.v);
    case 'buf': return Buffer.from(x.v, 'base64');
    case 'json': return x.v;
    default: return x;
  }
}

const encodeRow = (row) => row.map(encodeValue);
const decodeRow = (row) => row.map(decodeValue);
/** 比对用的稳定形式：编码后的 JSON 文本，Date/Buffer 不会因为对象身份不同而误判 */
const fingerprint = (encodedRow) => JSON.stringify(encodedRow);

// ---- INSERT 解析 ---------------------------------------------------------
//
// impact.js 只管 UPDATE / DELETE（影响行数预检不需要 INSERT）。反向 INSERT→DELETE
// 需要知道「刚插进去的是哪几行」，因此这里单独解析，且**只认能确定行身份的形态**：
// 显式 VALUES 列表、主键列都给了字面量。INSERT…SELECT、主键靠自增、
// 值是函数调用的，一律拒绝——猜错会删掉别人的数据。

function depthMap(mask) {
  const depths = new Array(mask.length);
  let depth = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === '(') { depths[i] = depth; depth++; continue; }
    if (mask[i] === ')') { depth = Math.max(0, depth - 1); depths[i] = depth; continue; }
    depths[i] = depth;
  }
  return depths;
}

/** 按给定括号深度切分逗号分隔项，返回原文片段 */
function splitAt(original, mask, depths, from, to, depth) {
  const out = [];
  let start = from;
  for (let i = from; i < to; i++) {
    if (mask[i] === ',' && depths[i] === depth) {
      out.push(original.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(original.slice(start, to).trim());
  return out;
}

const stripIdentQuotes = (text) => String(text).trim()
  .replace(/^`(.*)`$/s, '$1')
  .replace(/^"(.*)"$/s, '$1')
  .replace(/^\[(.*)\]$/s, '$1');

function analyzeInsert(sql) {
  const original = String(sql || '');
  const mask = impact.maskLiterals(original);
  if (!/^\s*insert\s+into\b/i.test(mask)) return null;
  const depths = depthMap(mask);
  if (/\bselect\b/i.test(mask)) return unsupported('INSERT … SELECT 无法确定插入了哪些行');
  if (/\breturning\b|\boutput\b/i.test(mask)) return unsupported('包含 RETURNING / OUTPUT 子句');
  if (/\bon\s+(duplicate|conflict)\b/i.test(mask)) {
    return unsupported('带 ON DUPLICATE / ON CONFLICT，实际写入的行无法确定');
  }

  const intoAt = mask.search(/\binto\b/i) + 4;
  let valuesAt = -1;
  const re = /\bvalues?\b/ig;
  let m;
  while ((m = re.exec(mask))) { if (depths[m.index] === 0) { valuesAt = m.index; break; } }
  if (valuesAt < 0) return unsupported('未找到 VALUES 列表');

  // INTO 与 VALUES 之间：表名 + 可选的列清单
  const head = original.slice(intoAt, valuesAt);
  const headMask = mask.slice(intoAt, valuesAt);
  const open = headMask.indexOf('(');
  const table = (open >= 0 ? head.slice(0, open) : head).trim().replace(/;+$/, '').trim();
  let columns = null;
  if (open >= 0) {
    const close = headMask.lastIndexOf(')');
    if (close < open) return unsupported('列清单括号不完整');
    columns = splitAt(original, mask, depths, intoAt + open + 1, intoAt + close, depths[intoAt + open] + 1)
      .map(stripIdentQuotes);
    if (!columns.length || columns.some((name) => !name)) return unsupported('无法识别列清单');
  }

  // VALUES 之后的每个 (...) 是一行
  const tuples = [];
  let i = valuesAt + 6;
  while (i < mask.length) {
    while (i < mask.length && mask[i] !== '(') {
      if (!/[\s,;]/.test(mask[i])) return unsupported('VALUES 之后出现无法识别的内容');
      i++;
    }
    if (i >= mask.length) break;
    const start = i;
    let depth = 0;
    let end = -1;
    for (let j = i; j < mask.length; j++) {
      if (mask[j] === '(') depth++;
      else if (mask[j] === ')') { depth--; if (!depth) { end = j; break; } }
    }
    if (end < 0) return unsupported('VALUES 括号不完整');
    tuples.push(splitAt(original, mask, depths, start + 1, end, depths[start] + 1));
    i = end + 1;
  }
  if (!tuples.length) return unsupported('VALUES 里没有可识别的行');
  return { kind: 'insert', supported: true, table, columns, tuples, sql: original };
}

// 只有能确定「就是这一行」的字面量才允许用来定位：数字与带引号的字符串。
// 函数调用、DEFAULT、绑定参数一概不认——用它去 DELETE 可能删到别人的行。
const LITERAL_RE = /^(?:-?\d+(?:\.\d+)?|N?'(?:[^']|'')*')$/i;

// ---- 计划 ----------------------------------------------------------------

/**
 * 判断一段 SQL 能不能做快照，能的话给出取原值需要的信息。
 *
 * 返回 {supported:false, reason} 或
 *      {supported:true, kind, target, pk, columns, selectSql?, insertKeys?}
 * 其中 columns 是**规范列序**（来自 tableInfo），后面所有行数据都按这个顺序对齐，
 * 免得 `SELECT *` 与按名取列两条路给出不同的列序。
 */
async function planFor(adapter, { db, schema, sql, maxRows = DEFAULT_MAX_ROWS }) {
  const statements = safety.splitStatements(String(sql || ''));
  if (statements.length !== 1) {
    // 多语句脚本里，第 2 条看到的是第 1 条改过之后的数据，
    // 执行前一次性取原值必然取错。宁可不保护，也不能给错的快照。
    return unsupported(statements.length > 1
      ? '一次执行了多条语句，无法逐条确定各自的原值范围'
      : '没有可分析的语句');
  }
  const statement = statements[0];
  let analysis = impact.analyzeStatement(statement);
  if (!analysis) analysis = analyzeInsert(statement);
  if (!analysis) return unsupported('不是 UPDATE / DELETE / INSERT，无需快照');
  if (!analysis.supported) return unsupported(analysis.reason);

  const reference = parseSimpleTableReference(analysis.table);
  if (!reference) return unsupported('无法可靠识别语句对应的表');
  if (reference.alias) return unsupported('表使用了别名，反向 SQL 无法可靠定位到真实表');
  const target = adapter._resolveEditableTable(db, schema, reference.parts);
  if (!target || !target.table) return unsupported('无法把表名解析到具体的库与表');

  let info;
  try {
    info = await adapter.tableInfo(target.db, target.schema, target.table);
  } catch (error) {
    return unsupported(`读取表结构失败：${(error && error.message) || error}`);
  }
  const pk = (Array.isArray(info && info.pk) ? info.pk : []).filter(Boolean);
  if (!pk.length) {
    return unsupported(`表 ${target.table} 没有主键，无法逐行定位要还原的记录。`
      + '请改用「备份 / 还原」，或先给这张表建立主键。');
  }
  const columns = (info.columns || []).map((c) => ({ name: c.name, type: c.type || '' }));
  if (!columns.length) return unsupported('读不到表的栏位定义');
  if (pk.some((name) => !columns.some((c) => c.name === name))) {
    return unsupported('主键列不在栏位清单里，无法建立行索引');
  }
  const base = {
    supported: true,
    kind: analysis.kind,
    target: { db: target.db, schema: target.schema || null, table: target.table },
    pk,
    columns,
    maxRows,
    sql: statement,
  };
  if (analysis.kind !== 'insert') return { ...base, selectSql: analysis.selectSql };

  const names = analysis.columns || columns.map((c) => c.name);
  if (analysis.columns && analysis.columns.some((name) => !columns.some((c) => c.name === name))) {
    return unsupported('列清单里有表结构中不存在的列');
  }
  if (analysis.tuples.some((tuple) => tuple.length !== names.length)) {
    return unsupported('VALUES 的列数与列清单不一致');
  }
  const pkAt = pk.map((name) => names.indexOf(name));
  if (pkAt.some((at) => at < 0)) {
    return unsupported('INSERT 没有显式给出全部主键列（例如主键自增），无法确定插入了哪些行');
  }
  const insertKeys = analysis.tuples.map((tuple) => pkAt.map((at) => tuple[at].trim()));
  if (insertKeys.some((key) => key.some((literal) => !LITERAL_RE.test(literal)))) {
    return unsupported('主键值不是可确定的字面量（含函数调用或 DEFAULT），无法确定插入了哪些行');
  }
  return { ...base, insertKeys };
}

// ---- 取值 ----------------------------------------------------------------

const qualify = (adapter, target) => adapter.qualify(target.db, target.schema, target.table);

const literalOf = (adapter, columns, name, value) => {
  const column = columns.find((c) => c.name === name);
  return valueLiteral(adapter, value, column ? column.type : '');
};

/**
 * 把结果集按规范列序对齐。
 *
 * `SELECT *` 的列序、Oracle 分页附加的 RN__、大小写折叠——都在这里抹平，
 * 让后面所有环节只面对一个确定的列序。
 */
function alignRows(result, columns) {
  const names = (result.columns || []).map((c) => String(c.name));
  const folded = new Map();
  names.forEach((name, index) => {
    if (!folded.has(name.toLowerCase())) folded.set(name.toLowerCase(), index);
  });
  const at = columns.map((column) => {
    const exact = names.indexOf(column.name);
    return exact >= 0 ? exact : (folded.has(column.name.toLowerCase()) ? folded.get(column.name.toLowerCase()) : -1);
  });
  const missing = columns.filter((_c, i) => at[i] < 0).map((c) => c.name);
  if (missing.length) throw new Error(`快照结果缺少栏位：${missing.join(', ')}`);
  return (result.rows || []).map((row) => at.map((index) => row[index]));
}

const keyOf = (encodedRow, pkAt) => JSON.stringify(pkAt.map((index) => encodedRow[index]));
const pkPositions = (plan) => plan.pk.map((name) => plan.columns.findIndex((c) => c.name === name));

/**
 * 执行前取原值。
 *
 * 多探一行：读到 maxRows+1 就说明超阈值，直接放弃快照并说明原因——
 * 而不是存一份不完整的快照，那种快照回滚之后只恢复了一部分，比没有更糟。
 */
async function captureBefore(adapter, plan, runSelect) {
  if (plan.kind === 'insert') return [];
  const limited = adapter.pageSql(plan.selectSql, '', plan.maxRows + 1, 0);
  const result = await runSelect(limited);
  const rows = alignRows(result, plan.columns);
  if (rows.length > plan.maxRows) {
    throw Object.assign(new Error(
      `影响 ${plan.maxRows.toLocaleString()} 行以上，超过快照上限，本次未做快照。`
      + '大范围改动请改用「备份 / 还原」——把几十万行原值抄到本地既慢又占地方，'
      + '而且真出事时你要的是整库还原，不是逐行回滚。'), { overLimit: true });
  }
  return rows;
}

/** 按主键取回若干行（分批 OR 拼条件，避免一条 SQL 过长） */
async function readByKeys(adapter, target, columns, pk, keyLiterals, runSelect) {
  if (!keyLiterals.length) return [];
  const table = qualify(adapter, target);
  const projection = columns.map((c) => adapter.quoteIdent(c.name)).join(', ');
  const out = [];
  for (let i = 0; i < keyLiterals.length; i += KEY_CHUNK) {
    const chunk = keyLiterals.slice(i, i + KEY_CHUNK);
    const where = chunk
      .map((key) => '(' + pk.map((name, at) => `${adapter.quoteIdent(name)} = ${key[at]}`).join(' AND ') + ')')
      .join(' OR ');
    const result = await runSelect(`SELECT ${projection} FROM ${table} WHERE ${where}`);
    out.push(...alignRows(result, columns));
  }
  return out;
}

/** 由 before 行（或 INSERT 的字面量主键）算出用于按主键回读的字面量 */
function keyLiteralsOf(adapter, plan, beforeRows) {
  if (plan.kind === 'insert') return plan.insertKeys;
  const at = pkPositions(plan);
  return beforeRows.map((row) => plan.pk.map((name, i) => literalOf(adapter, plan.columns, name, row[at[i]])));
}

/** 执行后取「我们改完时的样子」，回滚时用它判断有没有被别人动过 */
async function captureAfter(adapter, plan, keyLiterals, runSelect) {
  return readByKeys(adapter, plan.target, plan.columns, plan.pk, keyLiterals, runSelect);
}

/**
 * 记录一次已经执行成功的 DML。
 *
 * before 是执行前的原值，after 是执行后的样子；两者都按主键索引后配对。
 * UPDATE / DELETE 以 before 为准（after 可能没有——DELETE 之后行就不在了）；
 * INSERT 以 after 为准（before 本来就没有）。
 */
function record(context, plan, beforeRows, afterRows) {
  const at = pkPositions(plan);
  const afterByKey = new Map();
  for (const row of afterRows) {
    const encoded = encodeRow(row);
    afterByKey.set(keyOf(encoded, at), encoded);
  }
  let rows;
  if (plan.kind === 'insert') {
    rows = [...afterByKey.entries()].map(([key, encoded]) => ({ key, before: null, after: encoded }));
  } else {
    rows = beforeRows.map((row) => {
      const encoded = encodeRow(row);
      const key = keyOf(encoded, at);
      return { key, before: encoded, after: afterByKey.get(key) || null };
    });
  }
  return localStore.put(BUCKET, {
    kind: plan.kind,
    connId: context.connId,
    connName: context.connName || '',
    dialect: adapterDialect(context),
    db: plan.target.db,
    schema: plan.target.schema,
    table: plan.target.table,
    pk: plan.pk,
    columns: plan.columns,
    sql: String(plan.sql || '').slice(0, 4000),
    affected: rows.length,
  }, rows, context.quota);
}

const adapterDialect = (context) => (context && context.dialect) || '';

// ---- 反向 SQL ------------------------------------------------------------

/**
 * 生成反向 SQL。
 *   UPDATE  → 用原值反写回去（只写非主键列）
 *   DELETE  → INSERT 回去
 *   INSERT  → 按主键 DELETE 掉
 */
function reverseSql(adapter, snapshot, rows) {
  const target = { db: snapshot.db, schema: snapshot.schema, table: snapshot.table };
  const table = qualify(adapter, target);
  const columns = snapshot.columns;
  const names = columns.map((c) => c.name);
  const at = snapshot.pk.map((name) => names.indexOf(name));
  const out = [];
  for (const item of rows) {
    const source = decodeRow((snapshot.kind === 'insert' ? item.after : item.before) || []);
    if (!source.length) continue;
    const where = snapshot.pk
      .map((name, i) => `${adapter.quoteIdent(name)} = ${literalOf(adapter, columns, name, source[at[i]])}`)
      .join(' AND ');
    if (snapshot.kind === 'update') {
      const sets = names
        .filter((name) => !snapshot.pk.includes(name))
        .map((name) => `${adapter.quoteIdent(name)} = ${literalOf(adapter, columns, name, source[names.indexOf(name)])}`);
      if (!sets.length) continue;   // 整表只有主键列，没什么可还原的
      out.push(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${where}`);
    } else if (snapshot.kind === 'delete') {
      const cols = names.map((name) => adapter.quoteIdent(name)).join(', ');
      const vals = names.map((name) => literalOf(adapter, columns, name, source[names.indexOf(name)])).join(', ');
      out.push(`INSERT INTO ${table} (${cols}) VALUES (${vals})`);
    } else {
      out.push(`DELETE FROM ${table} WHERE ${where}`);
    }
  }
  return out;
}

// ---- 冲突检测 ------------------------------------------------------------

/**
 * 逐行比对「我们改完时的样子」与「现在的样子」。
 *
 * 对不上就是这行在我们之后又被别人（或另一条语句）改过。这类行**默认跳过**：
 * 硬把原值写回去等于悄悄覆盖掉别人的改动，那是第二次事故。
 */
async function detectConflicts(adapter, snapshot, rows, runSelect) {
  const target = { db: snapshot.db, schema: snapshot.schema, table: snapshot.table };
  const columns = snapshot.columns;
  const names = columns.map((c) => c.name);
  const at = snapshot.pk.map((name) => names.indexOf(name));
  const keyLiterals = rows.map((item) => {
    const source = decodeRow((snapshot.kind === 'insert' ? item.after : item.before) || []);
    return snapshot.pk.map((name, i) => literalOf(adapter, columns, name, source[at[i]]));
  });
  const current = await readByKeys(adapter, target, columns, snapshot.pk, keyLiterals, runSelect);
  const currentByKey = new Map();
  for (const row of current) {
    const encoded = encodeRow(row);
    currentByKey.set(keyOf(encoded, at), encoded);
  }
  return rows.map((item) => {
    const now = currentByKey.get(item.key) || null;
    if (snapshot.kind === 'delete') {
      // 删掉的行现在又有了：要么别人补了一条，要么已经回滚过
      return now
        ? { key: item.key, conflict: true, reason: '该行现在已存在，回滚会造成主键冲突' }
        : { key: item.key, conflict: false, reason: '' };
    }
    if (!now) return { key: item.key, conflict: true, reason: '该行已被删除，无法还原' };
    if (item.after && fingerprint(now) !== fingerprint(item.after)) {
      return { key: item.key, conflict: true, reason: '该行在本次操作之后又被改动过，回滚会覆盖那次改动' };
    }
    return { key: item.key, conflict: false, reason: '' };
  });
}

module.exports = {
  BUCKET, DEFAULT_MAX_ROWS,
  planFor, captureBefore, captureAfter, keyLiteralsOf, record,
  reverseSql, detectConflicts, alignRows,
  analyzeInsert, encodeValue, decodeValue, encodeRow, decodeRow, pkPositions, keyOf,
};
