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

function clickhouseJson(value) {
  try {
    return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
  } catch (e) {
    return String(value);
  }
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
    throw new Error('数组/对象值无法可靠生成为跨方言 SQL 字面量；请改用原生格式或先转换为文本列');
  }
  return textLiteral(adapter, value);
}

module.exports = { textLiteral, valueLiteral };
