// Schema 版本时光机（路线图 v2.8.0）
//
// 结构改动不像数据事故那样有明确的时刻，它是慢慢漂移的。等到某天线上报
// 「data too long」，你想知道这一列什么时候变窄的、原来多长——现有的四件工具
// 一个都答不上来：
//
//   备份 / 还原   答「数据没了怎么办」，整库粒度，不是为结构准备的
//   结构同步     答「测试库和生产库差在哪」，比的是两个库（空间维度）
//   SQL 后悔药   明确不承诺 DDL 回滚，只管 DML 的行级原值
//   操作审计     记的是语句流水，回放不出任意中间版本
//
// 缺的正是**同一个库的时间维度**，这里补上。
//
// ── 「观察即记录」而不是「写入时记录」 ────────────────────────────────
//
// 改结构的入口有一大把：设计器、树上的对象操作、结构同步、自由 SQL 的 DDL、
// 运行 SQL 文件、从备份还原。逐个挂钩子既啰嗦又必然漏。
//
// 这里改成在**读表结构**的那一处挂：每次拿到 tableInfo 就与上一版比对，
// 不一样就存一版。一个钩子覆盖所有写入路径，而且**连别的客户端改的结构也能记下来**——
// 那是逐个挂写入钩子做不到的。
//
// 代价要如实说：它记录的是「本工具观察到的历史」。改完又在下一次查看之前改回去，
// 中间那一版就没有记录。时间线上标的是「观察时间」，不是「变更时间」。
//
// ── 迁移脚本从哪来 ────────────────────────────────────────────────
//
// 复用 ddl.buildAlterTable(adapter, db, schema, 旧模型, 新模型)——设计器算 ALTER
// 用的就是它。把两版快照当成「原始模型」和「修改后模型」传进去就得到迁移脚本，
// 把两个参数对调就得到回滚脚本。这也是路线图把它评为「成本低」的原因。
//
// 唯一需要转接的是 origName 语义：设计器里 origName 表示「这一列改动前叫什么」，
// 空则表示新增列。而快照里每一列的 origName 都等于自己的名字，
// 直接丢进去会让新增列既不算新增、也不算删除，静默消失。见 alignModels()。
const crypto = require('crypto');
const localStore = require('./localStore');
const ddl = require('./db/ddl');
const impact = require('./impact');

const BUCKET = 'schema';
// 结构历史要长期留存，与后悔药快照的配额完全不同：那是「最近几次误操作」，
// 这是「这张表这一年怎么演变的」。
const QUOTA = Object.freeze({ keep: 4000, days: 3650, bytes: 128 * 1024 * 1024 });
const MAX_VERSIONS_PER_TABLE = 200;

const keyOf = (c) => JSON.stringify([
  String(c.connId || ''), String(c.db || ''), String(c.schema || ''), String(c.table || ''),
]);
const idOf = (c) => 'sch-' + crypto.createHash('sha1').update(keyOf(c)).digest('hex').slice(0, 12);

/**
 * 模型指纹。只对「结构上有意义」的部分取哈希：
 * 列的名字/类型/可空/默认/主键/注释、索引、约束、外键、表注释。
 * 驱动回传里那些每次都可能变的东西（统计行数、下一个自增值）不参与，
 * 否则每看一眼表都会记一版噪音。
 */
function fingerprint(model) {
  const columns = (model.columns || []).map((c) => [
    c.name, c.type, c.length || '', c.scale || '', !!c.notNull, !!c.pk, !!c.autoInc,
    c.def === undefined || c.def === null ? '' : String(c.def),
    c.comment || '', c.charset || '', c.collation || '',
  ]);
  const indexes = (model.indexes || []).map((i) => [i.name, !!i.unique, !!i.primary, (i.columns || []).join(',')]);
  const constraints = (model.constraints || []).map((i) => [i.kind, i.name, (i.columns || []).join(','), i.expression || '']);
  const fks = (model.foreignKeys || []).map((f) => [
    f.name, (f.columns || []).join(','), f.refSchema || '', f.refTable || '',
    (f.refColumns || []).join(','), f.onDelete || '', f.onUpdate || '',
  ]);
  const payload = JSON.stringify([model.table || '', columns, indexes, constraints, fks, model.comment || '']);
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function loadEntry(context) {
  const id = idOf(context);
  if (!localStore.has(BUCKET, id)) return null;
  try { return localStore.read(BUCKET, id); } catch (e) { return null; }
}

const summarize = (model) => ({
  columns: (model.columns || []).length,
  indexes: (model.indexes || []).length,
  foreignKeys: (model.foreignKeys || []).length,
});

/**
 * 观察到一次表结构，与上一版不同就记一版。
 * 返回 {tracked:false} 表示存储不可用；{changed:false} 表示与上一版一致。
 */
function observe(context, model) {
  if (!localStore.available()) return { tracked: false, reason: '系统安全存储不可用，结构历史未启用' };
  if (!model || !Array.isArray(model.columns) || !model.columns.length) {
    return { tracked: false, reason: '没有可记录的表结构' };
  }
  const hash = fingerprint(model);
  const entry = loadEntry(context);
  const versions = (entry && entry.rows) || [];
  const last = versions[versions.length - 1];
  if (last && last.hash === hash && !last.dropped) {
    return { tracked: true, changed: false, versions: versions.length };
  }
  versions.push({ at: Date.now(), hash, model, summary: summarize(model) });
  while (versions.length > MAX_VERSIONS_PER_TABLE) versions.shift();
  localStore.putAt(BUCKET, idOf(context), {
    connId: context.connId, connName: context.connName || '',
    db: context.db, schema: context.schema || null, table: context.table,
    dialect: context.dialect || '',
    versions: versions.length,
    firstAt: versions[0].at,
    lastAt: versions[versions.length - 1].at,
    dropped: false,
  }, versions, QUOTA);
  return { tracked: true, changed: true, versions: versions.length, first: versions.length === 1 };
}

/** 表被删掉：记一版墓碑，时间线上才看得出「它到这里没了」 */
function markDropped(context) {
  if (!localStore.available()) return { tracked: false };
  const entry = loadEntry(context);
  if (!entry || !entry.rows.length) return { tracked: false };
  const versions = entry.rows;
  if (versions[versions.length - 1].dropped) return { tracked: true, changed: false };
  versions.push({ at: Date.now(), hash: 'dropped', dropped: true, model: null, summary: null });
  localStore.putAt(BUCKET, idOf(context), {
    ...entry, versions: versions.length, lastAt: versions[versions.length - 1].at, dropped: true,
  }, versions, QUOTA);
  return { tracked: true, changed: true };
}

/** 有历史记录的表清单（只解头信息，不解版本正文） */
function listTracked(filter = {}) {
  return localStore.list(BUCKET)
    .filter((item) => (!filter.connId || item.connId === filter.connId)
      && (!filter.db || item.db === filter.db)
      && (!filter.schema || (item.schema || '') === (filter.schema || '')))
    .map((item) => ({
      id: item.id,
      connId: item.connId, connName: item.connName,
      db: item.db, schema: item.schema, table: item.table,
      dialect: item.dialect,
      versions: item.versions, firstAt: item.firstAt, lastAt: item.lastAt,
      dropped: !!item.dropped, bytes: item.bytes,
    }));
}

/** 某张表的时间线（不含模型正文，正文按需再取） */
function timeline(id) {
  const entry = localStore.read(BUCKET, id);
  return {
    id, connId: entry.connId, connName: entry.connName,
    db: entry.db, schema: entry.schema, table: entry.table, dialect: entry.dialect,
    versions: (entry.rows || []).map((item, index) => ({
      index, at: item.at, hash: item.hash, dropped: !!item.dropped, summary: item.summary,
    })),
  };
}

const versionsOf = (id) => localStore.read(BUCKET, id).rows || [];

// ---- 两版对比 ------------------------------------------------------------

const byName = (list) => new Map((list || []).map((item) => [String(item.name), item]));

/**
 * 把「新版快照」改写成设计器语义的模型。
 *
 * 设计器约定：`origName` 是这一列改动前的名字，**空表示新增列**。
 * 而快照里每一列的 origName 都等于自己的名字（infoToModel 就是这么填的），
 * 直接拿去 diff 会让新增列既进不了「新增」分支、也进不了「删除」分支——静默消失。
 * 所以这里只在旧版确实有同名对象时才保留 origName，其余一律清空。
 */
function alignModels(oldModel, newModel) {
  const out = JSON.parse(JSON.stringify(newModel));
  const align = (nextList, prevList) => {
    const prev = byName(prevList);
    for (const item of (nextList || [])) {
      item.origName = prev.has(String(item.name)) ? item.name : '';
    }
  };
  align(out.columns, oldModel.columns);
  align(out.indexes, oldModel.indexes);
  align(out.constraints, oldModel.constraints);
  align(out.foreignKeys, oldModel.foreignKeys);
  return out;
}

/**
 * 人话版的变更清单。
 *
 * 直接比两个模型，不去解析生成出来的 SQL——SQL 是给数据库看的，
 * 「score 从 REAL 改成 TEXT」这种话才是给人看的。
 *
 * 一个诚实的局限：快照之间看不出**重命名**。列改了名字在这里表现为
 * 「删了一列、加了一列」，因为两版快照之间没有任何东西能证明它们是同一列。
 */
function describeChanges(oldModel, newModel) {
  const changes = [];
  if (!oldModel) return [{ kind: 'create', text: `建表 ${newModel.table}` }];
  if (!newModel) return [{ kind: 'drop', text: `删表 ${oldModel.table}` }];
  if (oldModel.table !== newModel.table) {
    changes.push({ kind: 'rename', text: `表改名 ${oldModel.table} → ${newModel.table}` });
  }
  const before = byName(oldModel.columns);
  const after = byName(newModel.columns);
  for (const [name, column] of after) {
    if (before.has(name)) continue;
    changes.push({ kind: 'add', text: `新增栏位 ${name} ${ddl.composeType(column, newModel.dialect || '')}` });
  }
  for (const [name] of before) {
    if (!after.has(name)) changes.push({ kind: 'remove', text: `删除栏位 ${name}` });
  }
  for (const [name, next] of after) {
    const prev = before.get(name);
    if (!prev) continue;
    const type = (c) => `${c.type || ''}${c.length ? `(${c.length}${c.scale ? ',' + c.scale : ''})` : ''}`;
    if (type(prev) !== type(next)) {
      changes.push({ kind: 'type', text: `栏位 ${name} 类型 ${type(prev)} → ${type(next)}` });
    }
    if (!!prev.notNull !== !!next.notNull) {
      changes.push({ kind: 'null', text: `栏位 ${name} ${next.notNull ? '改为 NOT NULL' : '改为可空'}` });
    }
    const def = (c) => (c.def === undefined || c.def === null ? '' : String(c.def));
    if (def(prev) !== def(next)) {
      changes.push({ kind: 'default', text: `栏位 ${name} 默认值 ${def(prev) || '（无）'} → ${def(next) || '（无）'}` });
    }
    if (!!prev.pk !== !!next.pk) {
      changes.push({ kind: 'pk', text: `栏位 ${name} ${next.pk ? '加入主键' : '移出主键'}` });
    }
    if ((prev.comment || '') !== (next.comment || '')) {
      changes.push({ kind: 'comment', text: `栏位 ${name} 注释变更` });
    }
  }
  const oldIdx = byName(oldModel.indexes);
  const newIdx = byName(newModel.indexes);
  for (const [name] of newIdx) if (!oldIdx.has(name)) changes.push({ kind: 'index', text: `新增索引 ${name}` });
  for (const [name] of oldIdx) if (!newIdx.has(name)) changes.push({ kind: 'index', text: `删除索引 ${name}` });
  const oldFk = byName(oldModel.foreignKeys);
  const newFk = byName(newModel.foreignKeys);
  for (const [name] of newFk) if (!oldFk.has(name)) changes.push({ kind: 'fk', text: `新增外键 ${name}` });
  for (const [name] of oldFk) if (!newFk.has(name)) changes.push({ kind: 'fk', text: `删除外键 ${name}` });
  return changes;
}

/** 生成一个方向的 DDL；生成不出来时如实返回原因，不抛给整个对比流程 */
function buildOneWay(adapter, db, schema, from, to) {
  try {
    if (!from && !to) return { sqls: [], warnings: [] };
    if (!from) {
      const built = ddl.buildCreateTable(adapter, db, schema, to);
      return { sqls: built.sqls || [], warnings: built.warnings || [] };
    }
    if (!to) {
      return { sqls: [`DROP TABLE ${adapter.qualify(db, schema, from.table)}`], warnings: [] };
    }
    const built = ddl.buildAlterTable(adapter, db, schema, from, alignModels(from, to));
    return { sqls: built.sqls || [], warnings: built.warnings || [] };
  } catch (error) {
    return { sqls: [], warnings: [], error: (error && error.message) || String(error) };
  }
}

/**
 * 任意两版对比：同时给出迁移脚本与回滚脚本。
 *
 * 回滚不是「把迁移倒着写」，而是**把两个模型对调再生成一遍**——
 * 倒着写 SQL 在删列、改类型这些不可逆动作上根本不成立，
 * 而对调模型生成出来的就是真正能把结构变回去的语句。
 */
function compare(adapter, id, fromIndex, toIndex) {
  const versions = versionsOf(id);
  const pick = (index) => {
    const item = versions[index];
    if (!item) throw new Error(`版本 ${index} 不存在`);
    return item.dropped ? null : item.model;
  };
  const meta = localStore.read(BUCKET, id);
  const from = pick(fromIndex);
  const to = pick(toIndex);
  const db = meta.db;
  const schema = meta.schema;
  const forward = buildOneWay(adapter, db, schema, from, to);
  const backward = buildOneWay(adapter, db, schema, to, from);
  return {
    table: meta.table,
    db, schema,
    from: { index: fromIndex, at: versions[fromIndex].at, dropped: !!versions[fromIndex].dropped },
    to: { index: toIndex, at: versions[toIndex].at, dropped: !!versions[toIndex].dropped },
    changes: describeChanges(from, to),
    migration: forward.sqls,
    migrationError: forward.error || '',
    rollback: backward.sqls,
    rollbackError: backward.error || '',
    warnings: [...new Set([...(forward.warnings || []), ...(backward.warnings || [])])],
  };
}

/** 某一刻整个库/模式的结构：每张表取「不晚于该时刻」的最后一版，已删的表不出现 */
function schemaAt(filter, at) {
  const stamp = Number(at) || Date.now();
  const out = [];
  for (const item of listTracked(filter)) {
    const versions = versionsOf(item.id);
    let chosen = null;
    for (const version of versions) {
      if (version.at > stamp) break;
      chosen = version;
    }
    if (!chosen || chosen.dropped) continue;
    out.push({ id: item.id, table: item.table, at: chosen.at, model: chosen.model });
  }
  return out.sort((a, b) => String(a.table).localeCompare(String(b.table)));
}

// ---- 导出 ----------------------------------------------------------------

const stamp = (ms) => {
  const d = new Date(Number(ms) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const safeName = (text) => String(text || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'table';

/**
 * 导出成迁移文件文本。
 *
 * Flyway 靠**文件名**表达版本与顺序（V<版本>__<描述>.sql），所以这里连同
 * 建议文件名一起返回——名字起错了 Flyway 就不会按预期的顺序执行。
 * Liquibase 用 changelog，版本与顺序写在 XML 里，回滚放进 <rollback>。
 */
function exportScript(result, format, direction = 'migration') {
  const sqls = direction === 'rollback' ? result.rollback : result.migration;
  const description = `${safeName(result.table)}_${direction === 'rollback' ? 'rollback' : 'migrate'}`;
  const version = stamp(result.to.at);
  const header = result.changes.map((c) => `--   ${c.text}`).join('\n');
  if (format === 'liquibase') {
    const escape = (text) => String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = sqls.map((sql) => `      <sql>${escape(sql)}</sql>`).join('\n');
    const rollbackBody = (direction === 'rollback' ? result.migration : result.rollback)
      .map((sql) => `        <sql>${escape(sql)}</sql>`).join('\n');
    return {
      fileName: `${version}-${description}.xml`,
      text: `<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog
    xmlns="http://www.liquibase.org/xml/ns/dbchangelog"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.liquibase.org/xml/ns/dbchangelog
        http://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-4.20.xsd">
  <!--
${header || '--   （无结构变化）'}
  -->
  <changeSet id="${version}" author="dbpanda">
${body || '      <!-- 无语句 -->'}
    <rollback>
${rollbackBody || '        <!-- 无语句 -->'}
    </rollback>
  </changeSet>
</databaseChangeLog>
`,
    };
  }
  return {
    fileName: `V${version}__${description}.sql`,
    text: `-- ${result.db}${result.schema ? '.' + result.schema : ''}.${result.table}\n`
      + `-- ${direction === 'rollback' ? '回滚' : '迁移'}：`
      + `${new Date(result.from.at).toLocaleString()} → ${new Date(result.to.at).toLocaleString()}\n`
      + `${header || '--   （无结构变化）'}\n\n`
      + (sqls.length ? sqls.map((sql) => sql.trim().replace(/;\s*$/, '') + ';').join('\n') + '\n' : '-- 无语句\n'),
  };
}

/**
 * 从一段 SQL 里认出「被动过结构的表」。
 *
 * 光靠「观察即记录」有个现实缺口：在查询编辑器里直接跑 DDL 是最常见的改结构方式，
 * 而跑完之后界面并不会去读表结构——要等下次打开设计表才补记一版，
 * 时间戳还会是「去看的时刻」而不是「改的时刻」。所以这里额外认一遍 DDL。
 *
 * 判断刻意保守：只认这几种毫无歧义的形状，认不出来就不记，
 * 反正下次打开设计表还会补上。**绝不猜**——猜错的后果是给某张无关的表
 * 记上一版莫名其妙的历史。
 *
 * 用等长掩码定位关键字（注释变空格、字符串内容变 x），再按下标从原文切片，
 * 与 impact.js 处理 WHERE 是同一套办法：直接对原文跑正则会匹配到字符串字面量里的
 * 「create table」这样的文本。
 */
function ddlTargets(sql) {
  const original = String(sql || '');
  const mask = impact.maskLiterals(original);
  const out = [];
  const push = (text) => {
    const ref = String(text || '').trim().replace(/[;,].*$/s, '').trim();
    if (ref && !out.some((item) => item.ref === ref)) out.push({ ref });
  };
  const scan = (re, group) => {
    let m;
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    while ((m = rx.exec(mask))) {
      const at = m.index + m[0].length - m[group].length;
      push(original.slice(at, at + m[group].length));
    }
  };
  // CREATE TABLE [IF NOT EXISTS] x / DROP TABLE [IF EXISTS] x / ALTER TABLE x
  scan(/\bcreate\s+(?:temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?([^\s(;]+)/i, 1);
  scan(/\bdrop\s+table\s+(?:if\s+exists\s+)?([^\s(;]+)/i, 1);
  scan(/\balter\s+table\s+([^\s(;]+)/i, 1);
  // CREATE / DROP INDEX … ON x —— 索引变化也是结构变化
  scan(/\bindex\b[\s\S]*?\bon\s+([^\s(;]+)/i, 1);
  // 改名之后旧名字读不到、新名字才读得到，两个都要看一眼
  scan(/\brename\s+to\s+([^\s(;]+)/i, 1);
  scan(/\brename\s+table\s+([^\s(;]+)\s+to\s+([^\s(;]+)/i, 1);
  scan(/\brename\s+table\s+[^\s(;]+\s+to\s+([^\s(;]+)/i, 1);
  return out.map((item) => item.ref);
}

function remove(id) { return localStore.remove(BUCKET, id); }
function clear() { return localStore.clear(BUCKET); }
function usage() { return localStore.usage(BUCKET); }

module.exports = {
  BUCKET, MAX_VERSIONS_PER_TABLE,
  observe, markDropped, listTracked, timeline, compare, schemaAt, exportScript, ddlTargets,
  remove, clear, usage,
  fingerprint, describeChanges, alignModels, idOf,
};
