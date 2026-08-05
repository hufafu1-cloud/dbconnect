// SQL literals for row data (as opposed to metadata/DDL grammar positions).
// MySQL row strings use charset-introduced hex so behavior is independent of
// NO_BACKSLASH_ESCAPES while still inheriting the target column's collation.
const { formatDate } = require('./sqlutil');

function textLiteral(adapter, value) {
  const text = String(value);
  if (adapter && adapter.dialect === 'mysql') {
    return `_utf8mb4 X'${Buffer.from(text, 'utf8').toString('hex')}'`;
  }
  return adapter.literal(text);
}

function clickhouseTypeInner(type, wrapper) {
  const text = String(type || '').trim();
  const match = text.match(new RegExp(`^${wrapper}\\s*\\((.*)\\)$`, 'i'));
  return match ? match[1].trim() : '';
}

function clickhouseTypeCore(type) {
  let text = String(type || '').trim();
  for (;;) {
    const match = text.match(/^(?:Nullable|LowCardinality)\s*\((.*)\)$/i);
    if (!match) return text;
    text = match[1].trim();
  }
}

function jsonText(value) {
  try {
    return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
  } catch (e) {
    return String(value);
  }
}
const clickhouseJson = jsonText;

// ---------------- PostgreSQL 数组字面量 ----------------
// pg 驱动会把数组列解析成 JS 数组、json/jsonb 解析成 JS 对象。这些值在
// PostgreSQL 里有确定的文本表示，可以照着生成；无法确定的元素类型
// （如数组里的二进制）返回 null，让调用方退回报错，绝不猜。
const UNSUPPORTED = Symbol('unsupported');

function pgArrayQuote(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function pgArrayElement(value) {
  if (value === null || value === undefined) return 'NULL';
  if (Array.isArray(value)) return pgArrayText(value);
  // bytea[] 的元素在数组文本里还要再套一层转义，出错风险高于价值，直接不支持
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return UNSUPPORTED;
  if (value instanceof Date) return pgArrayQuote(formatDate(value));
  if (typeof value === 'object') return pgArrayQuote(jsonText(value));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint' || typeof value === 'number') return String(value);
  const text = String(value);
  // 空串、含分隔符/引号/反斜杠/空白的、以及字面量 NULL 都必须加引号，
  // 否则会被 PostgreSQL 解析成分隔符或真正的 NULL
  if (text === '' || /[{},"\\\s]/.test(text) || /^null$/i.test(text)) return pgArrayQuote(text);
  return text;
}

function pgArrayText(value) {
  const parts = [];
  for (const item of value) {
    const part = pgArrayElement(item);
    if (part === UNSUPPORTED) return UNSUPPORTED;
    parts.push(part);
  }
  return `{${parts.join(',')}}`;
}

/**
 * 方言原生的数组 / JSON 字面量。命中返回 SQL 字面量，无法确定时返回 null。
 * 生成的是带引号的文本，由目标列的类型完成隐式转换——pg_dump 的 --inserts
 * 模式也是这么做的。
 */
function nativeObjectLiteral(adapter, value, type) {
  const dialect = adapter && adapter.dialect;
  const text = String(type || '').trim().toLowerCase();
  if (dialect === 'postgres') {
    if (text.endsWith('[]')) {
      const arrayText = Array.isArray(value) ? pgArrayText(value) : UNSUPPORTED;
      return arrayText === UNSUPPORTED ? null : textLiteral(adapter, arrayText);
    }
    if (text === 'json' || text === 'jsonb') return textLiteral(adapter, jsonText(value));
  }
  // MySQL / MariaDB / OceanBase 的 JSON 列同样会被驱动解析成对象
  if (dialect === 'mysql' && text.startsWith('json')) return textLiteral(adapter, jsonText(value));
  return null;
}

/** ClickHouse 原生支持 Array / Tuple / Map；这些值不能按普通跨方言标量处理。 */
function clickhouseValueLiteral(adapter, value, type) {
  const typeText = clickhouseTypeCore(type);
  if (Array.isArray(value)) {
    const innerType = clickhouseTypeInner(typeText, 'Array');
    const items = value.map((item) => valueLiteral(adapter, item, innerType));
    return /^Tuple\s*\(/i.test(typeText) ? `(${items.join(', ')})` : `[${items.join(', ')}]`;
  }
  if (value && typeof value === 'object') {
    if (/^Map\s*\(/i.test(typeText)) {
      const entries = Object.entries(value).flatMap(([key, item]) => [
        textLiteral(adapter, key), valueLiteral(adapter, item),
      ]);
      return `map(${entries.join(', ')})`;
    }
    // JSON 列及无法从驱动结果中区分的复杂对象，交给 ClickHouse 按 JSON 文本解析。
    return textLiteral(adapter, clickhouseJson(value));
  }
  return valueLiteral(adapter, value, type, true);
}

function valueLiteral(adapter, value, type, fromClickHouse = false) {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return adapter.blobLiteral(Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
  if (value instanceof Date) return textLiteral(adapter, formatDate(value));
  if (!fromClickHouse && adapter && adapter.dialect === 'clickhouse' && typeof value === 'object') {
    return clickhouseValueLiteral(adapter, value, type);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('非有限浮点值（NaN/Infinity）无法可靠生成为 SQL 字面量');
    return String(value);
  }
  if (typeof value === 'boolean') return adapter.boolLiteral(value);
  if (typeof value === 'object') {
    // 先试目标方言的原生表示（PG 数组/JSON、MySQL JSON）；只有确实无法确定时才报错
    const native = nativeObjectLiteral(adapter, value, type);
    if (native !== null) return native;
    throw new Error('数组/对象值无法可靠生成为跨方言 SQL 字面量；请改用原生格式或先转换为文本列');
  }
  return textLiteral(adapter, value);
}

module.exports = { textLiteral, valueLiteral };
