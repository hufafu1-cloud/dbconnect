// MongoDB 适配器（官方 mongodb 驱动，纯 JS）
//
// 与 Redis / Elasticsearch 一样，严格限定为**只读浏览 + 只读查询**：
// 网格不可编辑、不提供表设计器、不做集合管理。写入请用 mongosh 或 Compass。
//
// 映射：
//   连接      → 实例 / 副本集
//   数据库    → 真实的 database（MongoDB 本来就有这一层，不像 Redis / ES 要退化）
//   「表」    → 集合（collection）
//   「视图」  → MongoDB 视图（db.createView 建的，listCollections 里 type = 'view'）
//   「行」    → 文档
//   查询编辑器 → MongoDB 查询（见下方 _parseCommand）
//
// 列是**采样推断**出来的，这一点与 ES 不同，值得说明：
// ES 有 mapping，字段集合是权威且有限的，所以那边把嵌套字段完全展平成
// user.addr.city。MongoDB 没有 schema，文档之间字段可以完全不同，深度展平会让
// 列数爆炸且不稳定（翻一页就变一组列）。因此这里只取**顶层字段**的并集，
// 嵌套对象与数组按 JSON 文本显示。列头会标明这是基于采样的推断。
const { MongoClient } = require('mongodb');
const { BaseAdapter } = require('./base');

/** 推断列时采样多少文档 */
const SCHEMA_SAMPLE = 100;
/** 导出时每批取多少文档 */
const EXPORT_BATCH = 1000;

/** 查询编辑器支持的只读操作 */
const READ_OPERATIONS = new Set(['find', 'aggregate', 'countdocuments', 'estimateddocumentcount', 'distinct']);

class MongoDBAdapter extends BaseAdapter {
  get dialect() { return 'mongodb'; }

  get readonlyReason() {
    return 'MongoDB 在本工具中为只读浏览：网格不支持编辑。'
      + '写入请使用 mongosh 或 MongoDB Compass。';
  }

  get designerReason() {
    return 'MongoDB 集合没有固定结构（同一集合的文档字段可以完全不同），'
      + '通用表设计器无法表达，因此不提供。列是按样本文档推断出来的，仅供浏览参考。';
  }

  get transactionSupport() {
    return { supported: false, warning: 'MongoDB 连接在本工具中为只读，不提供事务控制' };
  }

  get objectCaps() {
    return { routines: false, triggers: false, events: false, sequences: false, users: false, processes: false };
  }

  // MongoDB 没有 SQL 标识符；这些只为满足基类契约
  quoteIdent(name) { return String(name); }

  literal(v) { return v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`; }

  qualify(_db, _schema, table) { return String(table); }

  async connect() {
    const c = this.cfg;
    const auth = c.user
      ? `${encodeURIComponent(c.user)}:${encodeURIComponent(c.password || '')}@`
      : '';
    const opts = c.options || {};
    const params = [];
    // 认证库：用户建在哪个库就要指定哪个，默认 admin
    if (c.user) params.push(`authSource=${encodeURIComponent(opts.authSource || 'admin')}`);
    if (opts.tls) params.push('tls=true');
    if (opts.tls && opts.trustCert) params.push('tlsAllowInvalidCertificates=true');
    if (opts.replicaSet) params.push(`replicaSet=${encodeURIComponent(opts.replicaSet)}`);
    const uri = `mongodb://${auth}${c.host || 'localhost'}:${Number(c.port) || 27017}/`
      + (params.length ? `?${params.join('&')}` : '');
    this.client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      // 只读工具：不要在后台无限重试制造"假装还连着"的假象
      retryReads: true,
      retryWrites: false,
    });
    await this.client.connect();
    const info = await this.client.db('admin').command({ buildInfo: 1 });
    this.serverVersion = `MongoDB ${(info && info.version) || ''}`.trim();
  }

  async close() {
    if (this.client) await this.client.close().catch(() => {});
    this.client = null;
  }

  async listDatabases() {
    const res = await this.client.db('admin').admin().listDatabases({ nameOnly: false });
    return (res.databases || [])
      .map((d) => d.name)
      // admin / local / config 是 MongoDB 的内部库，与 MySQL 隐藏 information_schema 同理
      .filter((name) => !['admin', 'local', 'config'].includes(name))
      .sort((a, b) => a.localeCompare(b));
  }

  async listObjects(db) {
    const database = this.client.db(db);
    const infos = await database.listCollections({}, { nameOnly: false }).toArray();
    const tables = [];
    const views = [];
    for (const info of infos) {
      if (String(info.name).startsWith('system.')) continue;
      if (info.type === 'view') { views.push({ name: info.name }); continue; }
      tables.push({ name: info.name, rows: null, comment: '', engine: 'collection' });
    }
    // 行数用 estimatedDocumentCount：它读集合元数据，不扫全表。
    // 与 MySQL 的 TABLE_ROWS 一样是估算值，界面上本来就按估算处理。
    await Promise.all(tables.map(async (t) => {
      try { t.rows = await database.collection(t.name).estimatedDocumentCount(); }
      catch (e) { t.rows = null; }
    }));
    tables.sort((a, b) => a.name.localeCompare(b.name));
    views.sort((a, b) => a.name.localeCompare(b.name));
    return { tables, views };
  }

  /** 把文档的值转成网格能显示的形式：嵌套对象/数组转 JSON，特殊 BSON 类型转可读文本 */
  _cellValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (v instanceof Date) return v;
    // ObjectId / Decimal128 / Long 等 BSON 类型都实现了有意义的 toString
    if (typeof v === 'object') {
      const ctor = v.constructor && v.constructor.name;
      if (ctor === 'ObjectId' || ctor === 'Decimal128' || ctor === 'Long' || ctor === 'Binary') {
        return v.toString();
      }
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  /**
   * 采样推断列。取 _id 之外所有出现过的顶层字段，按出现频次降序，
   * 让常见字段排在前面——文档异构时这比字母序有用得多。
   */
  async _inferColumns(db, table) {
    const docs = await this.client.db(db).collection(table)
      .find({}, { limit: SCHEMA_SAMPLE, projection: {} }).toArray();
    const freq = new Map();
    for (const doc of docs) {
      for (const key of Object.keys(doc || {})) {
        if (key === '_id') continue;
        freq.set(key, (freq.get(key) || 0) + 1);
      }
    }
    const sorted = [...freq.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .map(([name, n]) => ({
        name,
        type: 'mixed',
        comment: n === docs.length ? '' : `样本中 ${n}/${docs.length} 条含此字段`,
        key: '',
      }));
    return {
      columns: [{ name: '_id', type: 'objectId', comment: '文档 ID', key: '' }, ...sorted],
      sampled: docs.length,
    };
  }

  async tableInfo(db, _schema, table) {
    const { columns, sampled } = await this._inferColumns(db, table);
    return {
      columns,
      indexes: await this._listIndexes(db, table),
      pk: [],
      ddl: `// MongoDB 集合：${db}.${table}\n`
        + `// 无固定结构；以下列由 ${sampled} 条样本文档推断，仅供浏览参考。\n`
        + `// 嵌套对象与数组在网格中按 JSON 文本显示。\n`
        + columns.map((c) => `//   ${c.name}${c.comment ? '  — ' + c.comment : ''}`).join('\n'),
      readonlyReason: this.readonlyReason,
    };
  }

  async _listIndexes(db, table) {
    try {
      const list = await this.client.db(db).collection(table).indexes();
      return list.map((idx) => ({
        name: idx.name,
        columns: Object.keys(idx.key || {}),
        unique: !!idx.unique,
      }));
    } catch (e) { return []; }
  }

  _rowsFrom(docs, columns) {
    return docs.map((doc) => columns.map((col) => this._cellValue(doc ? doc[col.name] : null)));
  }

  async tableData(db, args) {
    const { table, page = 1, pageSize = 500 } = args;
    const safePage = Number(page);
    const safePageSize = Number(pageSize);
    if (!Number.isSafeInteger(safePage) || safePage < 1) throw new Error('页码必须是正整数');
    if (!Number.isSafeInteger(safePageSize) || safePageSize < 1 || safePageSize > 10000) {
      throw new Error('每页行数必须是 1 到 10000 之间的整数');
    }
    const t0 = Date.now();
    const { columns } = await this._inferColumns(db, table);
    const coll = this.client.db(db).collection(table);
    const docs = await coll.find({}, {
      sort: { _id: 1 },
      skip: (safePage - 1) * safePageSize,
      limit: safePageSize,
    }).toArray();
    let total = null;
    try { total = await coll.estimatedDocumentCount(); } catch (e) { total = null; }
    return {
      columns: columns.map((c) => ({ name: c.name, type: c.type, comment: c.comment })),
      rows: this._rowsFrom(docs, columns),
      total,
      pk: [],
      rowIdColumn: null,
      rowIds: null,
      readonlyReason: this.readonlyReason,
      ms: Date.now() - t0,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  /**
   * 导出用的续传读取（契约见 exporter.exportTableByPages）。
   *
   * 用 _id 递增作为续传游标而不是 skip：skip 在大集合上是 O(n)，
   * 每页都要从头数一遍。_id 天然有序且唯一，是 MongoDB 的标准翻页做法。
   */
  async fetchTablePage({ db, table, limit, next }) {
    const { columns } = await this._inferColumns(db, table);
    const filter = next && next.afterId ? { _id: { $gt: next.afterId } } : {};
    const docs = await this.client.db(db).collection(table)
      .find(filter, { sort: { _id: 1 }, limit: Math.min(limit || EXPORT_BATCH, EXPORT_BATCH) })
      .toArray();
    const last = docs.length ? docs[docs.length - 1]._id : null;
    return {
      columns: columns.map((c) => ({ name: c.name })),
      rows: this._rowsFrom(docs, columns),
      next: docs.length && last !== null && last !== undefined ? { afterId: last } : null,
    };
  }

  /**
   * 解析查询编辑器里的一条命令，形如：
   *   orders.find({"status":"paid"})
   *   orders.find({}, {"limit":10, "sort":{"amount":-1}})
   *   orders.aggregate([{"$group":{"_id":"$city","n":{"$sum":1}}}])
   *   orders.countDocuments({})
   *   orders.distinct("city")
   *
   * 参数必须是**严格 JSON**（键要加双引号）。这是刻意的：mongosh 的 JS 对象字面量
   * 要靠执行 JS 才能解析，而在主进程里 eval 用户输入是本工具一贯拒绝的做法。
   * 从 Compass 复制出来的查询本来就是合法 JSON，代价可以接受。
   */
  _parseCommand(text) {
    const m = /^\s*(?:db\.)?([A-Za-z0-9_.$-]+)\.([A-Za-z]+)\s*\(([\s\S]*)\)\s*;?\s*$/.exec(text);
    if (!m) {
      throw new Error('无法识别的 MongoDB 命令。支持的形式：'
        + '集合名.find({…})、.aggregate([…])、.countDocuments({…})、.distinct("字段")；'
        + '参数需为严格 JSON（键加双引号）。');
    }
    const [, collection, rawOp, rawArgs] = m;
    const op = rawOp.toLowerCase();
    if (!READ_OPERATIONS.has(op)) {
      throw new Error(`MongoDB 连接为只读，不支持 ${rawOp}()。`
        + '可用的是 find / aggregate / countDocuments / estimatedDocumentCount / distinct。');
    }
    let args = [];
    const trimmed = rawArgs.trim();
    if (trimmed) {
      try {
        args = JSON.parse(`[${trimmed}]`);
      } catch (e) {
        throw new Error(`参数不是合法 JSON：${e.message}。`
          + '注意键需要加双引号，例如 {"status":"paid"} 而不是 {status:"paid"}。');
      }
    }
    return { collection, op, args };
  }

  async _runCommand(db, text) {
    const { collection, op, args } = this._parseCommand(text);
    const coll = this.client.db(db).collection(collection);

    if (op === 'find') {
      const [filter = {}, options = {}] = args;
      const limit = Number(options.limit) > 0 ? Number(options.limit) : 200;
      const docs = await coll.find(filter, { ...options, limit }).toArray();
      const names = new Set(['_id']);
      for (const doc of docs) for (const k of Object.keys(doc || {})) names.add(k);
      const columns = [...names].map((name) => ({ name, type: '' }));
      return { columns, rows: this._rowsFrom(docs, columns) };
    }
    if (op === 'aggregate') {
      const [pipeline = []] = args;
      if (!Array.isArray(pipeline)) throw new Error('aggregate 的参数必须是数组形式的管道');
      const forbidden = pipeline.find((stage) => stage && (stage.$out || stage.$merge));
      if (forbidden) throw new Error('MongoDB 连接为只读，聚合管道中不允许 $out / $merge（它们会写入集合）。');
      const docs = await coll.aggregate(pipeline).toArray();
      const names = new Set();
      for (const doc of docs) for (const k of Object.keys(doc || {})) names.add(k);
      const columns = [...names].map((name) => ({ name, type: '' }));
      return { columns, rows: this._rowsFrom(docs, columns) };
    }
    if (op === 'countdocuments') {
      const [filter = {}] = args;
      return { columns: [{ name: 'count', type: '' }], rows: [[await coll.countDocuments(filter)]] };
    }
    if (op === 'estimateddocumentcount') {
      return { columns: [{ name: 'count', type: '' }], rows: [[await coll.estimatedDocumentCount()]] };
    }
    // distinct
    const [field, filter = {}] = args;
    if (typeof field !== 'string') throw new Error('distinct 的第一个参数必须是字段名字符串');
    const values = await coll.distinct(field, filter);
    return { columns: [{ name: field, type: '' }], rows: values.map((v) => [this._cellValue(v)]) };
  }

  async exec(db, text) {
    return this._runCommand(db, String(text).trim());
  }

  async runScript(db, text, opts = {}) {
    // 一行一条命令，与 Redis 控制台一致；空行与 // 注释跳过
    const lines = String(text).split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'));
    const out = [];
    for (const line of lines) {
      const t0 = Date.now();
      try {
        const r = await this._runCommand(db, line);
        const maxRows = opts.maxRows;
        const rows = maxRows && r.rows.length > maxRows ? r.rows.slice(0, maxRows) : r.rows;
        out.push({
          sql: line,
          ms: Date.now() - t0,
          columns: r.columns,
          rows,
          rowCount: rows.length,
          rowCountExact: true,
          truncated: !!(maxRows && r.rows.length > maxRows),
        });
      } catch (err) {
        out.push({ sql: line, ms: Date.now() - t0, error: (err && err.message) || String(err) });
      }
    }
    return out;
  }

  async objectDdl(db, _schema, _kind, name) {
    const info = await this.tableInfo(db, null, name);
    return info.ddl;
  }

  async action(_db, a) {
    throw new Error(`MongoDB 连接为只读，不支持「${a && a.action}」操作。`
      + '集合管理请使用 mongosh 或 MongoDB Compass。');
  }

  async explainPlan() {
    throw new Error('MongoDB 暂不支持执行计划可视化');
  }
}

module.exports = { MongoDBAdapter, READ_OPERATIONS };
