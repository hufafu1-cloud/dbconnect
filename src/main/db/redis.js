// Redis 适配器（ioredis，纯 JS）
//
// Redis 不是关系库，这里做的是一层**如实的映射**，而不是把它伪装成 SQL 数据库：
//
//   连接      → Redis 实例
//   数据库    → 编号库 0..N（SELECT n）
//   「表」    → **键前缀**（第一个 ':' 之前的一段），如 user:1001 归入伪表 user。
//               这是 Redis 使用者本来就有的心智模型，没有前缀的键归入「(无前缀)」。
//   「行」    → 一个键，列为 键 / 类型 / TTL / 大小 / 值预览
//   查询编辑器 → Redis 命令控制台（每行一条），非 SQL
//
// 范围刻意收紧为**只读浏览 + 只读命令**：
//   - 网格只读、不提供表设计器、无事务、无对象节点
//   - 命令控制台拒绝写入与管理类命令（见 READ_ONLY_COMMANDS）
// 理由：写入路径若没有事务与回滚配套，就是本工具一贯拒绝的半成品；
// 需要改数据请用 redis-cli 或专门的运维工具。
//
// 性能约束：绝不使用 KEYS（会阻塞整个实例），一律 SCAN 且**有上限**。
// 超过上限时明确告知用户结果不完整，而不是静默截断。
const Redis = require('ioredis');
const { BaseAdapter } = require('./base');

/** 单次浏览最多扫描多少个键；超过就明确标注不完整 */
const SCAN_LIMIT = 20000;
/** SCAN 每批的 COUNT，太小往返多、太大单次阻塞久 */
const SCAN_BATCH = 500;
/** 值预览的最大长度与元素个数 */
const PREVIEW_CHARS = 200;
const PREVIEW_ITEMS = 5;
/** 无前缀键归入的伪表名 */
const NO_PREFIX = '(无前缀)';

/**
 * 允许在命令控制台执行的只读命令。
 * 白名单而非黑名单：Redis 命令太多，漏掉一个写命令就等于破了只读承诺。
 */
const READ_ONLY_COMMANDS = new Set([
  'get', 'mget', 'strlen', 'getrange', 'substr',
  'exists', 'type', 'ttl', 'pttl', 'randomkey', 'keys', 'scan', 'dbsize',
  'hget', 'hmget', 'hgetall', 'hkeys', 'hvals', 'hlen', 'hexists', 'hstrlen', 'hscan',
  'lrange', 'llen', 'lindex', 'lpos',
  'smembers', 'scard', 'sismember', 'smismember', 'srandmember', 'sscan', 'sinter', 'sunion', 'sdiff',
  'zrange', 'zrangebyscore', 'zrangebylex', 'zrevrange', 'zcard', 'zscore', 'zmscore',
  'zcount', 'zrank', 'zrevrank', 'zscan',
  'xrange', 'xrevrange', 'xlen', 'xinfo',
  'getbit', 'bitcount', 'bitpos',
  'pfcount', 'geopos', 'geodist', 'geohash',
  'object', 'memory', 'info', 'time', 'lastsave', 'dbsize', 'client', 'command', 'config',
  'ping', 'echo', 'select', 'json.get', 'json.type', 'json.objkeys', 'json.arrlen',
]);

/** 即使在白名单里，这些子命令仍然是写/管理操作，必须拦掉 */
const BLOCKED_SUBCOMMANDS = {
  config: new Set(['set', 'resetstat', 'rewrite']),
  client: new Set(['kill', 'pause', 'unpause', 'setname', 'no-evict', 'no-touch']),
  memory: new Set(['purge', 'doctor']),
  object: new Set([]),
};

class RedisAdapter extends BaseAdapter {
  get dialect() { return 'redis'; }

  get readonlyReason() {
    return 'Redis 在本工具中为只读浏览：网格不支持编辑。'
      + '改数据请使用 redis-cli 或专门的运维工具。';
  }

  get designerReason() {
    return 'Redis 没有表结构，不提供可视化表设计器。'
      + '这里的「表」是按键前缀（第一个冒号之前）归类出来的视图，并非真实对象。';
  }

  get transactionSupport() {
    return { supported: false, warning: 'Redis 连接在本工具中为只读，不提供事务控制' };
  }

  get objectCaps() {
    return { routines: false, triggers: false, events: false, sequences: false, users: false, processes: false };
  }

  // Redis 没有标识符概念；这些方法只为满足基类契约，不参与任何 SQL 拼接
  quoteIdent(name) { return String(name); }

  literal(v) { return v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`; }

  qualify(_db, _schema, table) { return String(table); }

  async connect() {
    const c = this.cfg;
    this.client = new Redis({
      host: c.host || 'localhost',
      port: Number(c.port) || 6379,
      password: c.password || undefined,
      username: c.user || undefined,
      db: 0,
      lazyConnect: true,
      connectTimeout: 8000,
      // 只读工具：连不上就如实报错，不要在后台无限重连制造"假装还活着"的连接
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });
    await this.client.connect();
    const info = await this.client.info('server');
    const m = /redis_version:([^\r\n]+)/.exec(info || '');
    this.serverVersion = m ? `Redis ${m[1].trim()}` : 'Redis';
    this.databaseCount = await this._databaseCount();
  }

  async close() {
    if (this.client) {
      try { this.client.disconnect(); } catch (e) { /* 已断开 */ }
    }
    this.client = null;
  }

  async _databaseCount() {
    try {
      const res = await this.client.config('GET', 'databases');
      const n = Number(Array.isArray(res) ? res[1] : undefined);
      if (Number.isInteger(n) && n > 0 && n <= 256) return n;
    } catch (e) {
      // 托管 Redis 常禁用或改名 CONFIG，退回默认值
    }
    return 16;
  }

  /** 「数据库」= 编号库。名字用 db0/db1…，与 redis-cli 的 -n 参数对应 */
  async listDatabases() {
    const count = this.databaseCount || 16;
    return Array.from({ length: count }, (_, i) => `db${i}`);
  }

  /** 库名 db3 → 3；给 SELECT 用 */
  _dbIndex(db) {
    const m = /^db(\d+)$/i.exec(String(db || 'db0'));
    return m ? Number(m[1]) : 0;
  }

  /**
   * 取一条**独占**连接并切到目标库。
   * 不能在共享连接上 SELECT——那会把别的标签页也一起切库。
   */
  async _withDb(db, fn) {
    const conn = this.client.duplicate({ lazyConnect: true, enableOfflineQueue: false });
    try {
      await conn.connect();
      await conn.select(this._dbIndex(db));
      return await fn(conn);
    } finally {
      try { conn.disconnect(); } catch (e) { /* 忽略 */ }
    }
  }

  /**
   * 有上限地扫描键。返回 { keys, truncated }。
   * 绝不使用 KEYS：它在大实例上会阻塞整个服务端。
   */
  async _scanKeys(conn, pattern, limit = SCAN_LIMIT) {
    const keys = [];
    let cursor = '0';
    do {
      const [next, batch] = await conn.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_BATCH);
      cursor = next;
      for (const k of batch) {
        keys.push(k);
        if (keys.length >= limit) return { keys, truncated: true };
      }
    } while (cursor !== '0');
    return { keys, truncated: false };
  }

  /** 键 → 伪表名（第一个冒号之前） */
  _prefixOf(key) {
    const i = String(key).indexOf(':');
    return i > 0 ? String(key).slice(0, i) : NO_PREFIX;
  }

  /** 伪表名 → SCAN 匹配式 */
  _patternOf(table) {
    return table === NO_PREFIX ? '*' : `${table}:*`;
  }

  async listObjects(db) {
    return this._withDb(db, async (conn) => {
      const { keys, truncated } = await this._scanKeys(conn, '*');
      const counts = new Map();
      for (const key of keys) {
        const p = this._prefixOf(key);
        counts.set(p, (counts.get(p) || 0) + 1);
      }
      const tables = [...counts.entries()]
        .map(([name, n]) => ({
          name,
          rows: n,
          comment: truncated
            ? `键前缀 ${name === NO_PREFIX ? '（无）' : name + ':*'}（扫描已达 ${SCAN_LIMIT.toLocaleString()} 键上限，计数不完整）`
            : `键前缀 ${name === NO_PREFIX ? '（无）' : name + ':*'}`,
          engine: 'redis',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { tables, views: [] };
    });
  }

  /** 「表结构」= 键列表的固定列；Redis 没有 schema，这里是展示用的伪结构 */
  async tableInfo(db, _schema, table) {
    const columns = [
      { name: 'key', type: 'string', comment: '键名', key: '' },
      { name: 'type', type: 'string', comment: 'Redis 数据类型', key: '' },
      { name: 'ttl', type: 'integer', comment: '剩余存活秒数，-1 表示永不过期', key: '' },
      { name: 'size', type: 'integer', comment: '字符串为字节数，容器类型为元素个数', key: '' },
      { name: 'value', type: 'string', comment: `值预览（最多 ${PREVIEW_ITEMS} 项 / ${PREVIEW_CHARS} 字符）`, key: '' },
    ];
    return {
      columns,
      indexes: [],
      pk: [],
      ddl: `# Redis 伪表：按键前缀归类\n# 匹配模式：${this._patternOf(table)}\n`
        + '# Redis 没有表结构，以上列由本工具生成用于浏览。',
      readonlyReason: this.readonlyReason,
    };
  }

  /** 读取一批键的类型、TTL、大小与值预览（用 pipeline 减少往返） */
  async _describeKeys(conn, keys) {
    if (!keys.length) return [];
    const typePipe = conn.pipeline();
    for (const k of keys) { typePipe.type(k); typePipe.ttl(k); }
    const meta = await typePipe.exec();

    const rows = [];
    const detailPipe = conn.pipeline();
    const plans = [];
    for (let i = 0; i < keys.length; i++) {
      const type = (meta[i * 2] && meta[i * 2][1]) || 'unknown';
      const ttl = (meta[i * 2 + 1] && meta[i * 2 + 1][1]);
      plans.push({ key: keys[i], type, ttl });
      switch (type) {
        case 'string': detailPipe.strlen(keys[i]); detailPipe.getrange(keys[i], 0, PREVIEW_CHARS - 1); break;
        case 'hash': detailPipe.hlen(keys[i]); detailPipe.hscan(keys[i], '0', 'COUNT', PREVIEW_ITEMS); break;
        case 'list': detailPipe.llen(keys[i]); detailPipe.lrange(keys[i], 0, PREVIEW_ITEMS - 1); break;
        case 'set': detailPipe.scard(keys[i]); detailPipe.srandmember(keys[i], PREVIEW_ITEMS); break;
        case 'zset': detailPipe.zcard(keys[i]); detailPipe.zrange(keys[i], 0, PREVIEW_ITEMS - 1, 'WITHSCORES'); break;
        case 'stream': detailPipe.xlen(keys[i]); detailPipe.xrange(keys[i], '-', '+', 'COUNT', PREVIEW_ITEMS); break;
        default: detailPipe.exists(keys[i]); detailPipe.type(keys[i]); break;
      }
    }
    const details = await detailPipe.exec();
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const sizeRes = details[i * 2];
      const dataRes = details[i * 2 + 1];
      const size = sizeRes && sizeRes[0] === null ? sizeRes[1] : null;
      const data = dataRes && dataRes[0] === null ? dataRes[1] : null;
      rows.push([p.key, p.type, p.ttl === undefined ? null : p.ttl, size, this._preview(p.type, data)]);
    }
    return rows;
  }

  _preview(type, data) {
    if (data === null || data === undefined) return null;
    const clip = (s) => {
      const text = String(s);
      return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + ' …' : text;
    };
    if (type === 'string') return clip(data);
    if (type === 'hash') {
      // HSCAN 返回 [cursor, [field, value, …]]
      const flat = Array.isArray(data) ? (data[1] || []) : [];
      const pairs = [];
      for (let i = 0; i + 1 < flat.length; i += 2) pairs.push(`${flat[i]}=${flat[i + 1]}`);
      return clip(pairs.join(', '));
    }
    if (type === 'zset') {
      const pairs = [];
      for (let i = 0; i + 1 < data.length; i += 2) pairs.push(`${data[i]}(${data[i + 1]})`);
      return clip(pairs.join(', '));
    }
    if (type === 'stream') {
      return clip(data.map((entry) => (Array.isArray(entry) ? entry[0] : String(entry))).join(', '));
    }
    if (Array.isArray(data)) return clip(data.join(', '));
    return clip(data);
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
    const info = await this.tableInfo(db, null, table);
    return this._withDb(db, async (conn) => {
      // SCAN 没有 offset，只能扫到本页末尾再切片。有上限，超出如实标注。
      const need = safePage * safePageSize;
      const { keys, truncated } = await this._scanKeys(conn, this._patternOf(table), Math.max(need, 1));
      const slice = keys.slice((safePage - 1) * safePageSize, need);
      const rows = await this._describeKeys(conn, slice);
      return {
        columns: info.columns.map((c) => ({ name: c.name, type: c.type, comment: c.comment })),
        rows,
        // SCAN 不保证总数，只有扫完（未截断）时才是精确值
        total: truncated ? null : keys.length,
        pk: [],
        rowIdColumn: null,
        rowIds: null,
        readonlyReason: this.readonlyReason,
        ms: Date.now() - t0,
        page: safePage,
        pageSize: safePageSize,
      };
    });
  }

  /**
   * 导出用的续传读取（见 exporter.exportTableByPages 的契约）。
   *
   * 用真实的 SCAN 游标续传，而不是每页从头重扫——后者是 O(n²)，
   * 2.5 万键的导出就已经明显变慢，大实例上会直接不可用。
   *
   * 注意这里**不套用浏览时的 SCAN_LIMIT**：浏览是"看一眼"，超限截断并标注即可；
   * 导出是用户明确要求把这批键全部取走，中途悄悄停下会产出不完整的文件。
   * 代价是大 keyspace 的导出会跑很久，但它是流式写出的，且用户可以取消。
   */
  async fetchTablePage({ db, table, limit, next }) {
    const info = await this.tableInfo(db, null, table);
    return this._withDb(db, async (conn) => {
      let cursor = (next && next.cursor) || '0';
      const keys = [];
      do {
        const [nextCursor, batch] = await conn.scan(
          cursor, 'MATCH', this._patternOf(table), 'COUNT', SCAN_BATCH,
        );
        cursor = nextCursor;
        keys.push(...batch);
      } while (cursor !== '0' && keys.length < limit);
      const rows = await this._describeKeys(conn, keys);
      return {
        columns: info.columns.map((c) => ({ name: c.name })),
        rows,
        next: cursor === '0' ? null : { cursor },
      };
    });
  }

  /** 命令控制台：校验单条命令是否在只读白名单内 */
  _assertReadOnly(parts) {
    const cmd = String(parts[0] || '').toLowerCase();
    if (!cmd) throw new Error('空命令');
    if (!READ_ONLY_COMMANDS.has(cmd)) {
      throw new Error(`本工具的 Redis 连接为只读，不允许执行 ${cmd.toUpperCase()}。`
        + '可用的是 GET/HGETALL/LRANGE/SCAN/INFO 等读取类命令；'
        + '需要写入请使用 redis-cli 或专门的运维工具。');
    }
    const sub = String(parts[1] || '').toLowerCase();
    const blocked = BLOCKED_SUBCOMMANDS[cmd];
    if (blocked && blocked.has(sub)) {
      throw new Error(`${cmd.toUpperCase()} ${sub.toUpperCase()} 属于写入/管理操作，本工具的只读连接不允许执行。`);
    }
    if (cmd === 'keys') {
      throw new Error('KEYS 会阻塞整个 Redis 实例，本工具不允许执行；请改用 SCAN。');
    }
  }

  /**
   * 把一行命令拆成参数，支持单双引号包裹带空格的参数。
   * 例：HGET "user:1001" name
   */
  _splitCommand(line) {
    const parts = [];
    let cur = '';
    let quote = null;
    let has = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) { quote = null; continue; }
        cur += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch; has = true;
      } else if (/\s/.test(ch)) {
        if (cur || has) { parts.push(cur); cur = ''; has = false; }
      } else {
        cur += ch;
      }
    }
    if (cur || has) parts.push(cur);
    if (quote) throw new Error('命令中的引号没有闭合');
    return parts;
  }

  /** 把 Redis 的回复整理成网格能显示的结果集 */
  _replyToResult(cmd, reply) {
    if (reply === null || reply === undefined) {
      return { columns: [{ name: cmd, type: '' }], rows: [[null]] };
    }
    if (Array.isArray(reply)) {
      const flat = reply.every((x) => x === null || typeof x !== 'object');
      if (flat) {
        return { columns: [{ name: '值', type: '' }], rows: reply.map((v) => [v]) };
      }
      return {
        columns: [{ name: '值', type: '' }],
        rows: reply.map((v) => [Array.isArray(v) ? v.join(' ') : String(v)]),
      };
    }
    if (typeof reply === 'object') {
      const entries = Object.entries(reply);
      return { columns: [{ name: '字段', type: '' }, { name: '值', type: '' }], rows: entries };
    }
    return { columns: [{ name: cmd, type: '' }], rows: [[reply]] };
  }

  /** 单条命令执行（供 exec / runScript 复用） */
  async _runCommand(db, line) {
    const parts = this._splitCommand(line);
    if (!parts.length) return null;
    this._assertReadOnly(parts);
    const cmd = parts[0].toLowerCase();
    return this._withDb(db, async (conn) => {
      const reply = await conn.call(cmd, ...parts.slice(1));
      return this._replyToResult(parts[0].toUpperCase(), reply);
    });
  }

  async exec(db, text) {
    const lines = String(text).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!lines.length) throw new Error('请输入至少一条 Redis 命令');
    // exec 只返回一个结果集：多条命令请走 runScript
    return this._runCommand(db, lines[0]);
  }

  /** 命令控制台：按行执行，逐条给出结果或错误 */
  async runScript(db, text, opts = {}) {
    const lines = String(text).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
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

  async action(_db, a) {
    throw new Error(`Redis 连接为只读，不支持「${a && a.action}」操作。`);
  }

  async explainPlan() {
    throw new Error('Redis 没有执行计划');
  }
}

module.exports = { RedisAdapter, READ_ONLY_COMMANDS, NO_PREFIX, SCAN_LIMIT };
