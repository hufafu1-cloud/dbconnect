// 跨库联邦查询（路线图 v2.7.0 M4）
//
// 微服务拆库之后，「订单库的订单 join 用户库的用户」在所有客户端里都做不了，
// 用户只能导出两份 CSV 用 Excel 拼。这里做的就是这件事：
// 把 SQL 里出现的 [连接.库.表] 各自并发拉到本地引擎，改写成本地表名后在本地做 join。
//
// ── 三条边界，界面上也照实说 ────────────────────────────────────────────
//
// 1. **只读、只支持单条 SELECT。** 判定直接复用 safety.isExplicitlyReadOnly，
//    不另写一套宽松的——那个函数保守到连「未知函数调用」都不放行，正是这里要的。
// 2. **每张源表有行数上限（默认 10 万），超限明确拒绝，绝不静默截断。**
//    截断产生的 join 结果看起来完全正常却是错的，比报错危险得多。
//    实现上按「上限 + 1 行」探一行：读到第 10001 行就立刻收手报错，
//    不必把整张表读完再拒绝。
// 3. **本地内存计算，非跨库一致性快照。** 各源表是分别读取的，彼此之间没有事务，
//    源库在读取期间发生的写入会体现为「A 表新、B 表旧」。这是受限版的已知边界。
//
// ── 为什么本地引擎是 SQLite 而不是 DuckDB ─────────────────────────────
//
// 路线图写的是「DuckDB 优先，退路是复用已有的 sql.js / better-sqlite3」。选了退路：
// DuckDB 是新的原生模块，要按 Electron ABI 重建、要进 asarUnpack、要给三个平台各验一遍，
// 而 better-sqlite3 这些事本项目早就做完了（sqlite 适配器一直在用，还带 sql.js 的 WASM 兜底）。
// 受限版的下限是「本地内存计算 + 单表 10 万行」，这个量级 SQLite 完全够用；
// 等真的要做谓词下推和更大数据量时再换引擎，那时的收益才对得起这笔成本。
//
// 直接复用 SQLiteAdapter（而不是自己拿 better-sqlite3）也是同一个道理：
// 结果集裁剪、行数上限改写、WASM 回退、值清洗全都现成，一行都不用重写。
const crypto = require('crypto');
const dbm = require('./db');
const store = require('./store');
const safety = require('./safety');
const multiExec = require('./multiExec');
const { readTablePages } = require('./exporter');
const pushdown = require('./fedPushdown');
const { translateType } = require('./db/ddl');
const { formatDate } = require('./db/sqlutil');

/**
 * 连接的来源。默认走真实的连接库与连接管理器；自检把它换成两个内存 SQLite，
 * 于是「跨连接 join」这条链路可以在没有任何外部数据库的情况下端到端验证。
 */
const defaultDeps = {
  connections: () => store.listPublic(),
  isOpen: (connId) => dbm.isOpen(connId),
  adapter: (connId) => dbm.get(connId),
};

const DEFAULT_MAX_ROWS_PER_SOURCE = 100000;
const MAX_ROWS_PER_SOURCE_CEILING = 1000000;
const MAX_SOURCES = 16;
const MAX_SESSIONS = 8;
const SOURCE_PAGE_SIZE = 5000;
const LOCAL_PREFIX = '_src_';

// ---- SQL 扫描：找出 [连接.库.表] 引用 ------------------------------------

/**
 * 扫描出所有方括号引用的位置。
 *
 * 必须真正跳过字符串与注释，不能对原文直接跑正则：`WHERE note = '[a.b.c]'`
 * 里的方括号是数据不是引用，把它当引用会去连一个不存在的库；
 * 反过来注释里的引用被当真，则会白白拉一张表。这与 impact.js 处理 WHERE 时
 * 拒绝对原文做正则是同一条教训。
 *
 * 方括号在本方言里**专属**于跨源引用（SQL Server 用它做标识符引用，
 * 但联邦查询的本地引擎是 SQLite，不存在冲突）。
 */
function scanRefs(sql) {
  const text = String(sql || '');
  const refs = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '-' && next === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text[i] === quote && text[i + 1] === quote) { i += 2; continue; }
        if (text[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '[') {
      const start = i;
      i++;
      let inner = '';
      let closed = false;
      while (i < text.length) {
        // 引用内部允许用双引号包住含点的名字："订单.主库".app.orders
        if (text[i] === '"') {
          inner += text[i];
          i++;
          while (i < text.length && text[i] !== '"') { inner += text[i]; i++; }
          if (i < text.length) { inner += text[i]; i++; }
          continue;
        }
        if (text[i] === ']') { closed = true; i++; break; }
        if (text[i] === '\n') break;
        inner += text[i];
        i++;
      }
      if (!closed) throw new Error(`跨源表引用缺少右方括号：${text.slice(start, start + 40)}`);
      refs.push({ start, end: i, inner: inner.trim() });
      continue;
    }
    i++;
  }
  return refs;
}

/** 按点切分，但双引号内的点不算分隔符 */
function splitRefParts(inner) {
  const parts = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"') {
      if (quoted && inner[i + 1] === '"') { cur += '"'; i++; continue; }
      quoted = !quoted;
      continue;
    }
    if (ch === '.' && !quoted) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

/**
 * 把 [连接.库.表] 解析成具体目标。
 *
 * 连接名允许含点（"华东.订单库" 这种命名很常见），所以不能简单按点切。
 * 做法是**从长到短**拿前缀去匹配已知连接名：先试 4 段全名、再 3 段、2 段、1 段，
 * 第一个匹配上的就是连接，剩下的段才是库/模式/表。
 */
function resolveRef(inner, connections) {
  const parts = splitRefParts(inner).filter((p, i, all) => p !== '' || i === all.length - 1);
  if (!parts.length || parts.some((p) => !p)) {
    throw new Error(`跨源表引用格式不正确：[${inner}]，应为 [连接名.库名.表名]`);
  }
  const byName = new Map();
  for (const conn of connections) {
    const key = String(conn.name || '').toLowerCase();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(conn);
  }
  const byId = new Map(connections.map((c) => [String(c.id), c]));

  for (let take = Math.min(parts.length - 1, 4); take >= 1; take--) {
    const candidate = parts.slice(0, take).join('.');
    const hitById = byId.get(candidate);
    const hitsByName = byName.get(candidate.toLowerCase()) || [];
    if (!hitById && !hitsByName.length) continue;
    if (!hitById && hitsByName.length > 1) {
      throw new Error(`连接名「${candidate}」对应 ${hitsByName.length} 个连接，无法确定用哪一个；请改用连接 ID：[${hitsByName[0].id}.库名.表名]`);
    }
    const conn = hitById || hitsByName[0];
    const rest = parts.slice(take);
    if (rest.length === 1) return { conn, db: conn.database || null, schema: null, table: rest[0] };
    if (rest.length === 2) return { conn, db: rest[0], schema: null, table: rest[1] };
    if (rest.length === 3) return { conn, db: rest[0], schema: rest[1], table: rest[2] };
    throw new Error(`跨源表引用层级过多：[${inner}]`);
  }
  const known = connections.map((c) => c.name).filter(Boolean).slice(0, 8).join('、');
  throw new Error(`找不到名为「${parts[0]}」的连接。已保存的连接：${known || '（无）'}`);
}

// 去重键：用 JSON 数组而不是拼接分隔符——名字里可以含任何字符，
// 拿某个分隔符去拼就总能构造出两张不同的表撞成同一个键。
const refKeyOf = (ref) => JSON.stringify([
  ref.conn.id, ref.db || '', ref.schema || '', ref.table,
]);

const localNameOf = (key) => LOCAL_PREFIX + crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);

// ---- 值绑定 --------------------------------------------------------------

/**
 * 驱动原值 → 本地引擎可绑定的值。
 *
 * **不能用 sanitizeValue**：那是「数据出境」用的（截断长文本、BLOB 只留 256 字节预览），
 * 而灌进本地引擎属于「数据搬运」，必须是明文原值——截断过的值 join 出来是错的。
 * 这条区分见产品路线图「两条通用数据流结论」的第 2 条。
 */
function bindValue(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'bigint') return v;
  if (t === 'number') return Number.isFinite(v) ? v : String(v);
  if (t === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return formatDate(v);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

/**
 * 读回时把 BigInt 收窄成 number（仅限安全范围内）。
 *
 * SQLite 适配器对整数开了 safeIntegers，INTEGER 一律回传 BigInt 以保住 64 位精度，
 * 之后 sanitizeValue 会把 BigInt 转成字符串——那是 SQLite 连接的既定行为。
 * 但在联邦查询里这条路会**改变源库的类型**：MySQL 的 INT 42 是 number 进来的，
 * 存进本地引擎再读出来就成了字符串 "42"，COUNT(*) 也会变成 "2"。
 * 用户看到的是本地引擎的怪癖，而不是自己数据的样子。
 *
 * 所以在安全范围内收窄回 number，超出范围的保持 BigInt——那种值本来就只能按
 * 字符串呈现，精度比类型重要。
 */
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);
function narrowInt(v) {
  return (typeof v === 'bigint' && v <= SAFE_MAX && v >= SAFE_MIN) ? Number(v) : v;
}

// ---- 会话 ----------------------------------------------------------------

const sessions = new Map();

class FederatedSession {
  constructor(id, ownerId) {
    this.id = id;
    this.ownerId = ownerId;
    this.engine = null;
    this.sources = new Map();  // localName -> 上次拉取的说明
    this.results = new Map();  // 用户另存的结果表名 -> {columns, rows}
    this.createdAt = Date.now();
  }

  async open() {
    // 内存库：受限版明确「仅本地内存计算」，进程退出或标签关闭即彻底消失，
    // 不需要落盘、也就不存在「临时表清理不干净」这类问题。
    this.engine = dbm.createAdapter({ type: 'sqlite', file: ':memory:' });
    await this.engine.connect();
    return this;
  }

  async close() {
    if (!this.engine) return;
    const engine = this.engine;
    this.engine = null;
    this.sources.clear();
    this.results.clear();
    await engine.close().catch(() => {});
  }

  assertOpen() {
    if (!this.engine) throw new Error('联邦查询会话已关闭，请重新打开标签页');
    return this.engine;
  }

  /** 本地已有哪些表：源表快照 + 用户另存的结果表 */
  describe() {
    const engine = this.engine;
    let localTables = [];
    if (engine) {
      try {
        const r = engine._execRaw(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
        localTables = r.rows.map((row) => String(row[0]));
      } catch (e) { localTables = []; }
    }
    return {
      sessionId: this.id,
      sources: [...this.sources.values()].map((item) => ({ ...item })),
      results: localTables
        .filter((name) => !name.startsWith(LOCAL_PREFIX) && !name.startsWith('sqlite_'))
        .map((name) => ({ name, rows: (this.results.get(name) || {}).rows ?? null })),
    };
  }
}

function purgeSessions() {
  if (sessions.size < MAX_SESSIONS) return;
  // 超额时淘汰最老的：会话只在标签页存活期间有意义，泄漏一个就是泄漏一份内存数据
  const oldest = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
  if (oldest) closeSession(oldest.id);
}

async function openSession(ownerId) {
  purgeSessions();
  const id = crypto.randomUUID();
  const session = await new FederatedSession(id, ownerId).open();
  sessions.set(id, session);
  return { sessionId: id };
}

function getSession(id, ownerId) {
  const session = sessions.get(String(id || ''));
  if (!session) throw new Error('联邦查询会话不存在或已关闭');
  if (ownerId !== undefined && session.ownerId !== ownerId) throw new Error('联邦查询会话不属于当前窗口');
  return session;
}

function closeSession(id, ownerId) {
  const session = sessions.get(String(id || ''));
  if (!session) return false;
  if (ownerId !== undefined && session.ownerId !== ownerId) return false;
  sessions.delete(session.id);
  session.close().catch(() => {});
  return true;
}

function closeSessionsByOwner(ownerId) {
  for (const session of [...sessions.values()]) {
    if (session.ownerId === ownerId) closeSession(session.id);
  }
}

// ---- 取数与建表 ----------------------------------------------------------

/**
 * 拉取一张源表并灌进本地引擎。
 *
 * 分页读取直接用导出那套 readTablePages：keyset 游标、无主键表的拒绝、
 * Oracle 的 RN__ 辅助列、非 SQL 源的续传令牌，一份实现两处用。
 */
async function materialize(engine, adapter, ref, opts) {
  const { localName, maxRows, signal } = opts;
  const startedAt = Date.now();
  let created = false;
  let columns = [];
  let inserted = 0;
  const warnings = [];

  const limitExceeded = () => new Error(
    `表 ${ref.table} 超过单源 ${maxRows.toLocaleString()} 行的拉取上限，已明确拒绝而不是截断——`
    + '截断得到的 join 结果看起来正常但是错的。\n'
    + (opts.pushed && opts.pushed.length
      ? `本次已把 ${opts.pushed.length} 个条件下推到源库，剩下的行仍然超限。`
      : '本次没有条件被下推到源库，整张表都拉了回来。')
    + '\n出路：把筛选条件写成「别名.列 运算符 字面量」的形状（例如 t.created >= 某个日期），'
    + '这类条件会被下推到源库执行，通常能把行数降下来；'
    + '或者调高「选项 → 查询 → 联邦查询单源行数上限」；'
    + '再或者用「数据传输」把这张表先同步到同一个库里再直接 join。');

  await readTablePages(adapter, {
    db: ref.db, schema: ref.schema, table: ref.table,
    // 下推：能安全推给源库的条件与用得上的列都在这里。推不动的部分留在本地 SQL 里，
    // 下推的部分**也**留在本地 SQL 里——它只能少传数据，不能改变结果。
    where: opts.where || '', columns: opts.columns || null, pageSize: SOURCE_PAGE_SIZE,
  }, (cols, rows) => {
    if (signal && signal.aborted) throw (signal.reason || new Error('已取消'));
    if (!created) {
      columns = normalizeColumns(cols, warnings);
      const defs = columns
        .map((c) => `${engine.quoteIdent(c.name)} ${c.localType}`)
        .join(', ');
      engine._execRaw(`DROP TABLE IF EXISTS ${engine.quoteIdent(localName)}`);
      engine._execRaw(`CREATE TABLE ${engine.quoteIdent(localName)} (${defs})`);
      created = true;
    }
    if (inserted + rows.length > maxRows) throw limitExceeded();
    const bound = rows.map((row) => {
      const out = new Array(columns.length);
      for (let i = 0; i < columns.length; i++) out[i] = bindValue(row[i]);
      return out;
    });
    engine.bulkInsert(localName, columns, bound);
    inserted += bound.length;
    return true;
  });

  if (!created) {
    // 空表也要建出来，否则 join 会报「表不存在」，而正确答案是 0 行
    const info = await adapter.tableInfo(ref.db, ref.schema, ref.table).catch(() => null);
    columns = normalizeColumns((info && info.columns) || [{ name: 'dummy', type: 'text' }], warnings);
    const defs = columns.map((c) => `${engine.quoteIdent(c.name)} ${c.localType}`).join(', ');
    engine._execRaw(`DROP TABLE IF EXISTS ${engine.quoteIdent(localName)}`);
    engine._execRaw(`CREATE TABLE ${engine.quoteIdent(localName)} (${defs})`);
  }

  return {
    localName,
    ref: refLabel(ref),
    connId: ref.conn.id,
    connName: ref.conn.name,
    connType: ref.conn.type,
    db: ref.db, schema: ref.schema, table: ref.table,
    rows: inserted,
    columns: columns.map((c) => c.name),
    warnings,
    // 下推了什么必须能看见：推错不会报错、只会给出看着正常的错结果，
    // 用户得有办法核对到底把哪些条件交给了源库。
    pushed: opts.pushed || [],
    prunedColumns: opts.columns ? opts.columns.length : null,
    ms: Date.now() - startedAt,
  };
}

/** 列名去重 + 类型映射到本地引擎 */
function normalizeColumns(cols, warnings) {
  const used = new Set();
  return (cols || []).map((col, index) => {
    let name = String((col && col.name) || `col_${index + 1}`);
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name}_${n}`)) n++;
      warnings.push(`列名 ${name} 重复，本地表里改称 ${name}_${n}`);
      name = `${name}_${n}`;
    }
    used.add(name);
    const mapped = translateType(col && col.type, 'sqlite');
    if (!mapped.known && col && col.type) {
      warnings.push(`列 ${name} 的类型 ${col.type} 未识别，按文本处理`);
    }
    return { name, type: (col && col.type) || '', localType: mapped.type };
  });
}

const refLabel = (ref) => `${ref.conn.name || ref.conn.id}.${ref.db || ''}`
  + (ref.schema ? `.${ref.schema}` : '') + `.${ref.table}`;

// ---- 查询 ----------------------------------------------------------------

function assertSingleSelect(sql) {
  const statements = safety.splitStatements(String(sql || ''));
  if (!statements.length) throw new Error('请输入要执行的查询');
  if (statements.length > 1) {
    throw new Error('联邦查询一次只能执行一条语句；多条语句请分开执行');
  }
  if (!safety.isExplicitlyReadOnly(statements[0])) {
    throw new Error('联邦查询只支持只读的 SELECT / WITH 查询。'
      + '它是把各源库的数据拉到本地计算的，不支持跨库写入，也不提供事务语义。');
  }
}

/**
 * 执行一次联邦查询。
 *
 * args: { sessionId, sql, maxRowsPerSource, resultMaxRows, concurrency, token }
 */
async function runQuery(args, ownerId, opts = {}) {
  const deps = opts.deps || defaultDeps;
  const onProgress = opts.onProgress || null;
  const session = getSession(args.sessionId, ownerId);
  const engine = session.assertOpen();
  const sql = String(args.sql || '');
  assertSingleSelect(sql);

  const maxRows = Math.min(
    MAX_ROWS_PER_SOURCE_CEILING,
    Math.max(1, Number(args.maxRowsPerSource) || DEFAULT_MAX_ROWS_PER_SOURCE),
  );
  const startedAt = Date.now();

  // 1) 找出所有跨源引用并解析
  const found = scanRefs(sql);
  const connections = deps.connections();
  const resolved = found.map((item) => ({ ...item, ref: resolveRef(item.inner, connections) }));

  // 2) 去重：同一张表在 SQL 里出现两次（自连接）只拉一次
  const unique = new Map();
  for (const item of resolved) {
    const key = refKeyOf(item.ref);
    if (!unique.has(key)) unique.set(key, { key, ref: item.ref, localName: localNameOf(key) });
    item.localName = unique.get(key).localName;
  }
  if (unique.size > MAX_SOURCES) {
    throw new Error(`一次联邦查询最多引用 ${MAX_SOURCES} 张跨源表，当前有 ${unique.size} 张`);
  }

  // 3) 连接必须已经打开。这里不替用户开连接：开连接可能要输密码、可能要建 SSH 隧道，
  //    在一个「执行查询」的动作里静默做这些事既慢又意外。
  for (const item of unique.values()) {
    if (!deps.isOpen(item.ref.conn.id)) {
      throw new Error(`连接「${item.ref.conn.name || item.ref.conn.id}」尚未打开。`
        + '请先在左侧连接树里打开它，再执行联邦查询。');
    }
  }

  // 4) 先把方括号引用改写成本地表名——下推分析要在这份「本地 SQL」上做，
  //    因为只有到这一步，每张源表才有一个稳定的、可用来配别名的名字。
  //    倒序替换，避免前面的替换挪动后面的下标。
  let localSql = sql;
  for (const item of [...resolved].sort((a, b) => b.start - a.start)) {
    localSql = localSql.slice(0, item.start)
      + engine.quoteIdent(item.localName)
      + localSql.slice(item.end);
  }

  // 5) 谓词下推与列裁剪。
  //    需要源表的列类型来判断哪些运算符能安全推（字符串列的排序规则各家不同），
  //    所以先并发取一遍元数据——那是很小的查询，换回来的是少拉几个数量级的行。
  const metaTasks = [...unique.values()].map((item) => ({
    key: item.key,
    label: refLabel(item.ref),
    run: async () => {
      const info = await deps.adapter(item.ref.conn.id)
        .tableInfo(item.ref.db, item.ref.schema, item.ref.table);
      return { localName: item.localName, columns: (info && info.columns) || [] };
    },
  }));
  let plan = { ok: false, reason: '', byName: new Map(), skipped: [] };
  if (metaTasks.length) {
    const metaRun = await multiExec.runAll(metaTasks, { concurrency: Number(args.concurrency) || 4 });
    if (metaRun.ok) {
      plan = pushdown.analyze(localSql, metaRun.results.map((r) => r.data));
    } else {
      // 元数据都读不到时不下推即可，真正的报错留给下面的取数阶段说清楚是哪张表
      plan = { ok: false, reason: '读取源表结构失败，本次不下推', byName: new Map(), skipped: [] };
    }
  }

  // 6) 并发拉取。调度走共用地基 multiExec：并发上限、逐源超时、统一取消都在那里。
  const tasks = [...unique.values()].map((item) => {
    const adapter = deps.adapter(item.ref.conn.id);
    const push = plan.byName.get(item.localName) || { predicates: [], columns: null };
    return {
      key: item.key,
      label: refLabel(item.ref),
      run: ({ signal }) => materialize(engine, adapter, item.ref, {
        localName: item.localName, maxRows, signal,
        where: push.predicates.length ? pushdown.renderWhere(adapter, push.predicates) : '',
        columns: push.columns,
        pushed: push.predicates.map((p) => p.text),
      }),
    };
  });

  let sources = [];
  if (tasks.length) {
    const run = multiExec.createRun({
      concurrency: Number(args.concurrency) || 4,
      token: args.token || null,
    });
    try {
      const outcome = await run.run(tasks, {
        onProgress: onProgress ? (p) => onProgress({ phase: 'fetch', ...p }) : null,
      });
      const failed = outcome.results.filter((item) => !item.ok);
      if (failed.length) {
        const detail = failed.slice(0, 3)
          .map((item) => `${item.label}：${item.error}`)
          .join('\n');
        throw new Error(`${failed.length} 个源表读取失败，查询未执行：\n${detail}`);
      }
      sources = outcome.results.map((item) => item.data);
    } finally {
      multiExec.releaseRun(run);
    }
  }

  // 7) 在本地引擎上执行
  if (onProgress) onProgress({ phase: 'compute', done: sources.length, total: sources.length });
  // 直接走 _execRaw 而不是 runScript：需要在基类做统一裁剪与清洗**之前**
  // 插进去把 BigInt 收窄回 number（见 narrowInt）。行数上限的下推、结果整形
  // 仍然是基类那两个方法，没有另起一套。
  const computeStartedAt = Date.now();
  const maxResultRows = Number(args.resultMaxRows) || 2000;
  const raw = engine._execRaw(localSql, { maxRows: maxResultRows });
  if (!raw || !raw.columns) throw new Error('联邦查询未返回结果集；请确认这是一条 SELECT 查询');
  raw.rows = raw.rows.map((row) => row.map(narrowInt));
  const result = engine._normalizeResult(localSql, raw, maxResultRows, Date.now() - computeStartedAt);
  // 结果来自本地内存引擎里的临时表。基类会顺手判断「这个结果集能不能就地编辑」，
  // 在这里必须抹掉：改本地快照既改不到源库，还会让用户以为自己改了数据。
  delete result.editable;
  delete result.editableReason;

  for (const item of sources) session.sources.set(item.localName, item);
  // 记下改写后的本地 SQL：把结果固化成表时直接重跑它即可，
  // 源表已经在本地引擎里，不必也不该再回源库拉一次。
  session.lastLocalSql = localSql;

  return {
    columns: result.columns || [],
    rows: result.rows || [],
    rowCount: result.rowCount ?? (result.rows || []).length,
    rowCountExact: result.rowCountExact !== false,
    sources,
    localSql,
    pushdown: {
      ok: plan.ok,
      reason: plan.reason,
      pushed: sources.reduce((sum, s) => sum + (s.pushed || []).length, 0),
      skipped: (plan.skipped || []).filter((item) => item.text).map((item) => item),
    },
    ms: Date.now() - startedAt,
    computeMs: result.ms ?? null,
    truncated: !!result.truncated,
    // 界面上常驻标注用：各源表是分别读取的，彼此之间没有事务
    snapshotConsistent: false,
  };
}

const RESULT_NAME_RE = /^[A-Za-z_一-龥][A-Za-z0-9_一-龥]{0,62}$/;

/**
 * 把上一次的查询结果固化成本地表，供后续查询直接引用。
 *
 * 这就是路线图里的「把上一个结果集当表继续查」。刻意**不接受调用方传 SQL**：
 * 用户想保存的永远是「刚刚看到的那个结果」，让调用方另给一段 SQL 只会带来
 * 「保存下来的和屏幕上显示的不是一回事」这种最难解释的错误。
 *
 * 重跑的是改写后的本地 SQL——源表快照还在本地引擎里，既不必回源库再拉一次，
 * 也保证了保存下来的确实是刚才那份数据，而不是又变化了的新数据。
 */
async function saveResult(args, ownerId) {
  const session = getSession(args.sessionId, ownerId);
  const engine = session.assertOpen();
  const name = String(args.name || '').trim();
  if (!RESULT_NAME_RE.test(name)) {
    throw new Error('结果表名只能是字母、数字、下划线或中文，且不能以数字开头，长度不超过 63');
  }
  if (name.startsWith(LOCAL_PREFIX)) throw new Error(`结果表名不能以 ${LOCAL_PREFIX} 开头（保留给源表快照）`);
  if (!session.lastLocalSql) throw new Error('还没有可保存的结果，请先执行一次查询');
  engine._execRaw(`DROP TABLE IF EXISTS ${engine.quoteIdent(name)}`);
  engine._execRaw(`CREATE TABLE ${engine.quoteIdent(name)} AS ${session.lastLocalSql}`);
  const count = engine._execRaw(`SELECT COUNT(*) FROM ${engine.quoteIdent(name)}`);
  const rows = Number(count.rows[0][0]);
  session.results.set(name, { rows });
  return { name, rows };
}

function describeSession(args, ownerId) {
  return getSession(args.sessionId, ownerId).describe();
}

function cancelQuery(args) {
  return multiExec.cancelRun(args && args.token, '用户取消了联邦查询');
}

module.exports = {
  openSession, closeSession, closeSessionsByOwner, describeSession, defaultDeps,
  runQuery, saveResult, cancelQuery,
  // 供自检使用
  scanRefs, splitRefParts, resolveRef, bindValue, narrowInt, assertSingleSelect, normalizeColumns,
  DEFAULT_MAX_ROWS_PER_SOURCE, MAX_SOURCES, LOCAL_PREFIX,
};
