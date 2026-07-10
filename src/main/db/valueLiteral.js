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

function valueLiteral(adapter, value) {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return adapter.blobLiteral(Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('非有限浮点值（NaN/Infinity）无法可靠生成为 SQL 字面量');
    return String(value);
  }
  if (typeof value === 'boolean') return adapter.boolLiteral(value);
  if (value instanceof Date) return textLiteral(adapter, formatDate(value));
  if (typeof value === 'object') {
    throw new Error('数组/对象值无法可靠生成为跨方言 SQL 字面量；请改用原生格式或先转换为文本列');
  }
  return textLiteral(adapter, value);
}

module.exports = { textLiteral, valueLiteral };
