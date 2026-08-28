// 列画像（路线图 v2.8.0）
//
// 网格里永远只看得见当前这一页，而你要判断的事全是整表尺度的：
// 这列有多少空值？只有几个取值（其实是个没写注释的枚举）？唯一吗（能当 join 键）？
// 金额有没有负数和离群值？
//
// 现在这些都得逐列手写 SQL——21 个列写 42 条。这里把它变成点一下。
//
// ── 一条铁律：绝不给一个可能是错的数字 ────────────────────────────────
//
// 与影响范围预检「宁可说无法预估，也不给可能错的行数」是同一条。落到这里就是：
// **统计范围必须如实标注，而且标注的是它真实的样子**。
//
// 大表要采样才可能在几秒内出结果，但「采样」两个字不够——本工具用的是
// **前 N 行**（各家的真随机采样语法与代价都不同，为它引入方言分支不值得），
// 而前 N 行对「后加的列」这种情况会给出完全错误的空值率。所以界面上写的是
// 「基于前 N 行（非随机）」，并给一个「改为全表统计」的按钮，而不是含糊地说「采样」。
//
// ── 查询规划：一次全表扫描 + 少量补充查询 ──────────────────────────────
//
// 朴素做法是每列 2~3 条 SQL，20 列就是 60 次往返。这里改成：
//   第 1 步  一条 SELECT 把所有列的标量聚合全算出来（非空数、去重数、最值），一次扫描
//   第 2 步  只对够格的列补 Top 5 分布 / 直方图，走 multiExec 并发，上限 4
//
// 够格的判定用第 1 步的结果：去重数太多的列取 Top 5 没有意义（那是个 ID 不是枚举），
// BLOB / JSON 列连去重都不算（COUNT(DISTINCT blob) 极贵且没有意义）。
const multiExec = require('./multiExec');
const { translateType } = require('./db/ddl');
const { sanitizeValue } = require('./db/sqlutil');

const DEFAULT_SAMPLE_THRESHOLD = 200000;   // 超过这么多行就默认改用前 N 行
const MAX_COLUMNS = 60;                    // 一次最多画多少列
const TOP_N = 5;
const TOP_DISTINCT_CAP = 200;              // 去重数超过它就不取 Top 5（那不是枚举）
const HISTOGRAM_BUCKETS = 10;
const CONCURRENCY = 4;

const NUMERIC = new Set(['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'float', 'double']);
const OPAQUE = new Set(['blob', 'json']);   // 不算去重、不取 Top 5

/** 这一列怎么画：full=全套，simple=只算空值与去重，opaque=只算空值 */
function planFor(column, dialect) {
  const generic = translateType(column.type, dialect === 'sqlite' ? 'sqlite' : 'mysql').generic;
  if (OPAQUE.has(generic)) return { generic, kind: 'opaque' };
  if (NUMERIC.has(generic)) return { generic, kind: 'numeric' };
  return { generic, kind: 'simple' };
}

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 统计范围。
 *
 * 返回可以直接当子查询用的表引用，以及一段如实描述它的说明。
 * 说明会原样显示在界面上——这里含糊一个字，用户就会把采样结果当成全表结果。
 */
function scopeOf(adapter, target, totalRows, opts) {
  const threshold = Math.max(0, Number(opts.sampleThreshold) || DEFAULT_SAMPLE_THRESHOLD);
  const qtable = adapter.qualify(target.db, target.schema, target.table);
  const full = { sql: qtable, sampled: false, rows: totalRows, label: '基于全表' };
  if (opts.scope === 'full' || totalRows === null || totalRows <= threshold) return full;
  const limited = adapter.pageSql(`SELECT * FROM ${qtable}`, '', threshold, 0);
  return {
    sql: `(${limited}) AS dbpanda_profile_src`,
    sampled: true,
    rows: threshold,
    label: `基于前 ${threshold.toLocaleString()} 行（非随机）`,
    note: '为了在几秒内出结果，超过阈值的表只统计前若干行。它不是随机样本：'
      + '对后来才加上的列，空值率会明显偏高。需要准确结果请改为全表统计。',
  };
}

/** 第 1 步：一条 SELECT 把所有列的标量聚合算出来 */
function buildScalarSql(adapter, scope, columns, plans) {
  const q = (name) => adapter.quoteIdent(name);
  const parts = ['COUNT(*) AS c_total'];
  columns.forEach((column, i) => {
    parts.push(`COUNT(${q(column.name)}) AS c_nn_${i}`);
    const plan = plans[i];
    if (plan.kind === 'opaque') return;
    parts.push(`COUNT(DISTINCT ${q(column.name)}) AS c_nd_${i}`);
    if (plan.kind === 'numeric') {
      parts.push(`MIN(${q(column.name)}) AS c_min_${i}`);
      parts.push(`MAX(${q(column.name)}) AS c_max_${i}`);
      parts.push(`AVG(${q(column.name)} * 1.0) AS c_avg_${i}`);
    }
  });
  return `SELECT ${parts.join(', ')} FROM ${scope.sql}`;
}

const indexByName = (result) => new Map(
  (result.columns || []).map((c, i) => [String(c.name).toLowerCase(), i]),
);

/** Top N 取值分布 */
function buildTopSql(adapter, scope, column) {
  const q = adapter.quoteIdent(column.name);
  const select = `SELECT ${q} AS v, COUNT(*) AS n FROM ${scope.sql} GROUP BY ${q}`;
  return adapter.pageSql(select, ' ORDER BY n DESC', TOP_N, 0);
}

/**
 * 直方图。
 *
 * 不用 PostgreSQL 的 width_bucket 之类的方言函数，直接算桶号：
 * floor((x - min) / step)，四则运算各家都一样。min === max 时不画（一根柱子没有信息量）。
 */
function buildHistogramSql(adapter, scope, column, min, max) {
  const q = adapter.quoteIdent(column.name);
  const step = (max - min) / HISTOGRAM_BUCKETS;
  if (!Number.isFinite(step) || step <= 0) return null;
  const bucket = `CAST((${q} - ${min}) / ${step} AS ${adapter.dialect === 'mssql' ? 'INT' : 'INTEGER'})`;
  return `SELECT ${bucket} AS b, COUNT(*) AS n FROM ${scope.sql}`
    + ` WHERE ${q} IS NOT NULL GROUP BY ${bucket} ORDER BY b`;
}

/**
 * 给一张表画像。
 *
 * args: { db, schema, table, scope: 'auto'|'full', sampleThreshold }
 * 返回 { table, totalRows, scope, columns: [...], ms, truncatedColumns }
 */
async function profileTable(adapter, args, opts = {}) {
  if (typeof adapter.fetchTablePage === 'function') {
    // Redis / Elasticsearch / MongoDB 这类没有 SQL 聚合，硬凑一套只会给出
    // 语义完全不同的数字。明确不支持，比给个似是而非的结果好。
    throw new Error('该数据源不支持列画像：它没有 SQL 聚合能力，统计口径无法与关系库对齐。');
  }
  const startedAt = Date.now();
  const target = { db: args.db, schema: args.schema || null, table: args.table };
  const info = await adapter.tableInfo(target.db, target.schema, target.table);
  const all = (info.columns || []).map((c) => ({ name: c.name, type: c.type || '', comment: c.comment || '' }));
  if (!all.length) throw new Error('这张表没有可统计的栏位');
  const columns = all.slice(0, MAX_COLUMNS);
  const plans = columns.map((c) => planFor(c, adapter.dialect));

  const countResult = await adapter.exec(target.db,
    `SELECT COUNT(*) AS n FROM ${adapter.qualify(target.db, target.schema, target.table)}`);
  const totalRows = num(countResult.rows[0] && countResult.rows[0][0]);
  const scope = scopeOf(adapter, target, totalRows, {
    scope: args.scope || 'auto',
    sampleThreshold: args.sampleThreshold,
  });

  const scalar = await adapter.exec(target.db, buildScalarSql(adapter, scope, columns, plans));
  const at = indexByName(scalar);
  const row = scalar.rows[0] || [];
  const pick = (key) => (at.has(key) ? row[at.get(key)] : null);
  const scanned = num(pick('c_total')) ?? 0;

  const stats = columns.map((column, i) => {
    const plan = plans[i];
    const nonNull = num(pick(`c_nn_${i}`)) ?? 0;
    const distinct = plan.kind === 'opaque' ? null : num(pick(`c_nd_${i}`));
    return {
      name: column.name,
      type: column.type,
      comment: column.comment,
      generic: plan.generic,
      kind: plan.kind,
      scanned,
      nonNull,
      nulls: Math.max(0, scanned - nonNull),
      nullRate: scanned ? (scanned - nonNull) / scanned : 0,
      distinct,
      // 去重数等于扫描行数：这一列在统计范围内唯一，很可能是业务主键或可用的 join 键
      unique: distinct !== null && scanned > 0 && distinct === scanned,
      min: plan.kind === 'numeric' ? num(pick(`c_min_${i}`)) : null,
      max: plan.kind === 'numeric' ? num(pick(`c_max_${i}`)) : null,
      avg: plan.kind === 'numeric' ? num(pick(`c_avg_${i}`)) : null,
      top: null,
      histogram: null,
      note: plan.kind === 'opaque' ? '二进制 / JSON 列只统计空值率' : '',
    };
  });

  // 第 2 步：只给够格的列补分布。去重数太多说明它是标识而不是枚举，取 Top 5 没有意义。
  const tasks = [];
  stats.forEach((stat, i) => {
    if (stat.kind === 'opaque' || !stat.nonNull) return;
    if (stat.kind === 'numeric' && stat.min !== null && stat.max !== null) {
      const sql = buildHistogramSql(adapter, scope, columns[i], stat.min, stat.max);
      if (sql) {
        tasks.push({
          key: `hist-${i}`,
          run: async () => {
            const r = await adapter.exec(target.db, sql);
            const buckets = new Array(HISTOGRAM_BUCKETS).fill(0);
            for (const [b, n] of r.rows) {
              // 最大值落在第 BUCKETS 个桶，归并到最后一桶
              const index = Math.min(HISTOGRAM_BUCKETS - 1, Math.max(0, Number(b) || 0));
              buckets[index] += Number(n) || 0;
            }
            stats[i].histogram = buckets;
          },
        });
      }
    }
    // 分布只对「枚举型」的列有意义。两道闸：
    //   事前——唯一列直接跳过，去重数过多的也跳过（那种列 GROUP BY 本身就贵）
    //   事后——最高频取值只出现 1 次，说明每行都不一样，列出来全是 0.8% 的噪音
    // 事前那道防的是代价，事后那道防的是「看着有结果、其实没信息」。
    if (stat.distinct === null || stat.distinct <= 0) return;
    if (stat.unique) {
      stats[i].note = '每行取值都不同，没有分布可言';
      return;
    }
    if (stat.distinct > TOP_DISTINCT_CAP) {
      stats[i].note = `取值超过 ${TOP_DISTINCT_CAP} 种，不再统计分布`;
      return;
    }
    tasks.push({
      key: `top-${i}`,
      run: async () => {
        const r = await adapter.exec(target.db, buildTopSql(adapter, scope, columns[i]));
        const top = r.rows.map(([value, n]) => ({
          value: sanitizeValue(value),
          count: Number(n) || 0,
          rate: scanned ? (Number(n) || 0) / scanned : 0,
        }));
        if (top.length && top[0].count <= 1) {
          stats[i].note = '各取值几乎都只出现一次，没有分布可言';
          return;
        }
        stats[i].top = top;
      },
    });
  });

  const failures = [];
  if (tasks.length) {
    const outcome = await multiExec.runAll(tasks, { concurrency: CONCURRENCY });
    for (const item of outcome.results) {
      // 单列统计失败不该废掉整张画像：那一列标出原因，其余照常显示
      if (!item.ok) failures.push({ key: item.key, error: item.error });
    }
  }

  return {
    table: target.table,
    db: target.db,
    schema: target.schema,
    totalRows,
    scanned,
    scope: {
      sampled: scope.sampled, label: scope.label, note: scope.note || '',
      threshold: Number(args.sampleThreshold) || DEFAULT_SAMPLE_THRESHOLD,
    },
    columns: stats,
    truncatedColumns: Math.max(0, all.length - columns.length),
    failures,
    ms: Date.now() - startedAt,
  };
}

module.exports = {
  profileTable, planFor, scopeOf, buildScalarSql, buildTopSql, buildHistogramSql,
  DEFAULT_SAMPLE_THRESHOLD, MAX_COLUMNS, TOP_N, TOP_DISTINCT_CAP, HISTOGRAM_BUCKETS,
};
