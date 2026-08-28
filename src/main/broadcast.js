// 多库广播执行（路线图 v2.7.0 M2）
//
// 痛点：分库分表 / 多环境下，同一条 SQL 要在 N 个库里重复执行，现在只能开 N 个标签页
// 手工点 N 遍。这里做的事是：选一组「连接 + 库」，一次跑完，结果合起来看。
//
// ── 与跨库联邦查询的分工 ────────────────────────────────────────────
//
// 广播是「同一条 SQL 在 N 个库各跑一遍」，结果**纵向拼接**；
// 联邦是「从 N 个源取数，在本地做 join」，结果是**跨库计算**出来的。
// 广播刻意不做跨库聚合——那是联邦查询的事，混在一起两边都讲不清楚。
// 也刻意不解析分片规则（ShardingSphere 之类）：那是中间件的职责，
// 客户端猜分片路由猜错了就是漏库或重复执行。
//
// ── 三条来自 multiExec 的保证 ──────────────────────────────────────
//
// 并发上限、逐库超时隔离、统一取消，全部来自 M1 的共用地基，这里不重写调度。
// 「32 个库里有一个连不上」是常态，绝不能让它废掉整批——所以结果一律按库归集成
// 成败矩阵，失败的那个能单独重试。
//
// ── 生产库审批只确认一次 ──────────────────────────────────────────
//
// 审批走 safety 的 `db.broadcast`，令牌绑定的是**整批目标 + SQL**。
// 一次广播里有三个生产库，也只弹一次窗、列出这三个库，而不是逐库弹三次——
// 弹三次的结果一定是用户闭着眼连点三下，那还不如不弹。
const multiExec = require('./multiExec');

const MAX_TARGETS = 256;
const DEFAULT_CONCURRENCY = 4;

/**
 * 把 `order_db_*` 这类通配转成正则；不含通配符时按不区分大小写全等匹配。
 *
 * 先按 `*` 切开、各段分别转义、再用 `.*` 接起来。不用占位符——
 * 拿控制字符当占位在源码里完全看不见，出问题极难查（core:test 专门守这条）。
 */
function globToRegExp(pattern) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = String(pattern || '').split('*').map(escape);
  return new RegExp('^' + parts.join('.*') + '$', 'i');
}

const hasGlob = (text) => String(text || '').includes('*');

// 目标的唯一键。用 JSON 数组而不是拼分隔符——连接 id 与库名里可以含任何字符，
// 拿某个分隔符去拼就总能构造出两个不同目标撞成同一个键。
const targetKey = (connId, db) => JSON.stringify([String(connId), db || '']);

/**
 * 把选择器展开成具体的「连接 + 库」目标列表。
 *
 * selectors: [{ conn: '连接名或ID或通配', db: '库名或通配' }]
 * 通配只在**已经打开的连接**和它已知的库清单里匹配——不替用户开连接，
 * 也不去连一个没打开的库探测它有哪些库（那会在一个「展开选择」的动作里
 * 静默发起 N 个连接）。
 */
function expandTargets(selectors, deps) {
  const connections = deps.connections();
  const out = [];
  const seen = new Set();
  const misses = [];
  for (const selector of (selectors || [])) {
    const connPattern = String(selector.conn || '').trim();
    const dbPattern = String(selector.db || '').trim();
    if (!connPattern) continue;
    const connRe = globToRegExp(connPattern);
    const matchedConns = connections.filter((c) => (
      connRe.test(String(c.name || '')) || String(c.id) === connPattern
    ));
    if (!matchedConns.length) {
      misses.push(`没有匹配「${connPattern}」的连接`);
      continue;
    }
    for (const conn of matchedConns) {
      if (!deps.isOpen(conn.id)) {
        misses.push(`连接「${conn.name || conn.id}」尚未打开`);
        continue;
      }
      const known = deps.databases(conn.id) || [];
      let dbs;
      if (!dbPattern) dbs = known.length ? known : [conn.database || null];
      else if (hasGlob(dbPattern)) {
        const dbRe = globToRegExp(dbPattern);
        dbs = known.filter((name) => dbRe.test(String(name)));
        if (!dbs.length) misses.push(`连接「${conn.name}」里没有匹配「${dbPattern}」的库`);
      } else dbs = [dbPattern];
      for (const db of dbs) {
        const key = targetKey(conn.id, db);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          connId: conn.id,
          connName: conn.name || conn.id,
          connType: conn.type || '',
          env: conn.env || '',
          db: db || null,
        });
      }
    }
  }
  if (out.length > MAX_TARGETS) {
    throw new Error(`一次广播最多 ${MAX_TARGETS} 个目标，当前展开出 ${out.length} 个`);
  }
  return { targets: out, misses: [...new Set(misses)] };
}

/**
 * 把每个库的结果集纵向拼起来，并在最前面补上来源列。
 *
 * 各库的列不一定完全一致（分库分表演进中很常见）。做法是**按列名取并集**，
 * 缺的列填 null，并在返回值里如实报告「列不一致」——
 * 悄悄按位置对齐会把 A 库的手机号拼到 B 库的地址列下面，那是最坏的一种错。
 */
function mergeSelect(results) {
  const names = [];
  const seen = new Set();
  let mismatched = false;
  let first = null;
  for (const item of results) {
    if (!item.ok || !item.data || !item.data.columns) continue;
    const current = item.data.columns.map((c) => String(c.name));
    const signature = JSON.stringify(current);
    if (first === null) first = signature;
    else if (signature !== first) mismatched = true;
    for (const name of current) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  const columns = [
    { name: '来源连接', type: 'text' },
    { name: '来源库', type: 'text' },
    ...names.map((name) => ({ name, type: '' })),
  ];
  const rows = [];
  for (const item of results) {
    if (!item.ok || !item.data || !item.data.columns) continue;
    const index = new Map(item.data.columns.map((c, i) => [String(c.name), i]));
    for (const row of item.data.rows) {
      rows.push([
        item.target.connName,
        item.target.db || '',
        ...names.map((name) => (index.has(name) ? row[index.get(name)] : null)),
      ]);
    }
  }
  return { columns, rows, mismatched };
}

/**
 * 广播一段 SQL。
 *
 * args: { targets:[{connId, db}], sql, maxRows, concurrency, taskTimeoutMs, token }
 * 返回 { kind, columns, rows, matrix, mismatched, ms, cancelled }
 *
 * kind = 'select' 表示至少有一个库返回了结果集，界面按合并表展示；
 * 否则是 'exec'，界面按成败矩阵展示。
 */
async function run(args, deps, opts = {}) {
  const targets = Array.isArray(args.targets) ? args.targets : [];
  if (!targets.length) throw new Error('没有选择任何目标库');
  if (targets.length > MAX_TARGETS) throw new Error(`一次广播最多 ${MAX_TARGETS} 个目标`);
  const sql = String(args.sql || '').trim();
  if (!sql) throw new Error('请输入要广播的 SQL');
  const startedAt = Date.now();

  const tasks = targets.map((target) => ({
    key: targetKey(target.connId, target.db),
    label: `${target.connName || target.connId}${target.db ? ' / ' + target.db : ''}`,
    run: async ({ signal }) => {
      const adapter = deps.adapter(target.connId);
      const requestId = opts.requestIdFor ? opts.requestIdFor(target) : undefined;
      // 取消要真正穿透到服务端：只停止等待的话，语句会继续跑到自然结束
      if (signal && requestId && typeof adapter.cancelOperation === 'function') {
        signal.addEventListener('abort', () => {
          adapter.cancelOperation(requestId).catch(() => {});
        });
      }
      const results = await adapter.runScript(target.db, sql, {
        maxRows: args.maxRows, requestId,
      });
      const failed = results.find((r) => r.error);
      if (failed) throw new Error(failed.error);
      // 一段脚本可能有多条语句，取最后一个有结果集的；都没有就当作写操作
      const withRows = [...results].reverse().find((r) => r.columns);
      const affected = results.reduce((sum, r) => sum + (Number(r.affected) || 0), 0);
      return {
        columns: withRows ? withRows.columns : null,
        rows: withRows ? withRows.rows : [],
        rowCount: withRows ? withRows.rowCount : null,
        truncated: !!(withRows && withRows.truncated),
        affected,
        statements: results.length,
      };
    },
  }));

  const runner = multiExec.createRun({
    concurrency: Number(args.concurrency) || DEFAULT_CONCURRENCY,
    taskTimeoutMs: Number(args.taskTimeoutMs) || 0,
    token: args.token || null,
  });
  let outcome;
  try {
    outcome = await runner.run(tasks, { onProgress: opts.onProgress || null });
  } finally {
    multiExec.releaseRun(runner);
  }

  const results = outcome.results.map((item, index) => ({ ...item, target: targets[index] }));
  const matrix = results.map((item) => ({
    connId: item.target.connId,
    connName: item.target.connName || item.target.connId,
    db: item.target.db || '',
    env: item.target.env || '',
    ok: item.ok,
    error: item.error || '',
    cancelled: !!item.cancelled,
    timedOut: !!item.timedOut,
    rows: item.ok && item.data ? item.data.rows.length : 0,
    rowCount: item.ok && item.data ? item.data.rowCount : null,
    truncated: !!(item.ok && item.data && item.data.truncated),
    affected: item.ok && item.data ? item.data.affected : 0,
    ms: item.ms,
  }));

  const anyRows = results.some((item) => item.ok && item.data && item.data.columns);
  const merged = anyRows ? mergeSelect(results) : { columns: [], rows: [], mismatched: false };
  const comparison = args.compare ? diff(results) : null;
  return {
    kind: anyRows ? 'select' : 'exec',
    columns: merged.columns,
    rows: merged.rows,
    mismatched: merged.mismatched,
    matrix,
    ok: outcome.ok,
    failed: outcome.failed,
    cancelled: outcome.cancelled,
    diff: comparison,
    ms: Date.now() - startedAt,
    // 各库是各自独立执行的，彼此之间没有事务：一半成功一半失败是可能的，
    // 界面必须如实说出来，不能让人以为广播是原子的。
    atomic: false,
  };
}

/**
 * 多环境对比：把各库的结果按「第一个目标」为基准逐行比对。
 *
 * 用途是 dev / test / prod 之间找配置漂移。比对以整行的文本形式做键，
 * 不做模糊匹配——「看起来差不多」的两行到底算不算相同，只有用户知道。
 */
function diff(results) {
  const usable = results.filter((item) => item.ok && item.data && item.data.columns);
  if (usable.length < 2) return { comparable: false, reason: '至少要有两个成功返回结果集的目标' };
  const base = usable[0];
  const keyOf = (columns, row) => JSON.stringify(row.map((value, i) => [String(columns[i].name), value]));
  const baseKeys = new Set(base.data.rows.map((row) => keyOf(base.data.columns, row)));
  const out = [];
  for (const item of usable.slice(1)) {
    const keys = new Set(item.data.rows.map((row) => keyOf(item.data.columns, row)));
    const onlyBase = [...baseKeys].filter((key) => !keys.has(key)).length;
    const onlyThis = [...keys].filter((key) => !baseKeys.has(key)).length;
    out.push({
      connName: item.target.connName,
      db: item.target.db || '',
      same: onlyBase === 0 && onlyThis === 0,
      onlyBase,
      onlyThis,
    });
  }
  return {
    comparable: true,
    baseline: `${base.target.connName}${base.target.db ? ' / ' + base.target.db : ''}`,
    baseRows: base.data.rows.length,
    items: out,
  };
}

module.exports = { expandTargets, mergeSelect, run, diff, globToRegExp, MAX_TARGETS, DEFAULT_CONCURRENCY };
