// 自检：不依赖外部数据库服务器，用 SQLite 适配器跑通核心链路 + 工具函数单测
const fs = require('fs');
const path = require('path');
const os = require('os');
const { splitSql, sanitizeValue } = require('./db/sqlutil');
const { SQLiteAdapter } = require('./db/sqlite');
const { MySQLAdapter } = require('./db/mysql');
const { ClickHouseAdapter } = require('./db/clickhouse');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail !== undefined ? JSON.stringify(detail) : ''); }
}

async function runSelfTest() {
  console.log('[SELFTEST] 开始');

  // ---- splitSql ----
  check('split 基本', splitSql('SELECT 1; SELECT 2', 'sqlite').length === 2);
  check('split 字符串内分号', splitSql("SELECT ';'; SELECT 2", 'sqlite').length === 2);
  check('split 行注释', splitSql('-- a;b\nSELECT 1', 'sqlite').length === 1);
  check('split 块注释', splitSql('/* ; */ SELECT 1; SELECT 2', 'sqlite').length === 2);
  check('split mysql 反斜杠', splitSql("SELECT 'a\\';b'; SELECT 2", 'mysql').length === 2);
  check('split pg 美元引用', splitSql('CREATE FUNCTION f() RETURNS void AS $x$ a; b $x$ LANGUAGE sql; SELECT 1', 'postgres').length === 2);
  check('split 尾部无分号', splitSql('SELECT 1', 'sqlite').length === 1);

  // ---- sanitizeValue ----
  check('sanitize null', sanitizeValue(null) === null);
  check('sanitize bigint', sanitizeValue(123n) === '123');
  check('sanitize date', /^2024-01-02 03:04:05/.test(sanitizeValue(new Date(2024, 0, 2, 3, 4, 5))));
  const blob = sanitizeValue(Buffer.from([1, 2, 255]));
  check('sanitize blob', blob && blob.__blob && blob.hex === '0102ff' && blob.length === 3);

  // ---- 方言转义 ----
  const my = new MySQLAdapter({});
  check('mysql quoteIdent', my.quoteIdent('a`b') === '`a``b`');
  check('mysql literal', my.literal("a'b\\c") === "'a''b\\\\c'");

  // ---- ClickHouse ----
  const ch = new ClickHouseAdapter({});
  check('ch quoteIdent', ch.quoteIdent('a`b') === '`a``b`');
  check('ch literal', ch.literal("a'b\\c") === "'a\\'b\\\\c'");
  check('ch qualify', ch.qualify('db', null, 't') === '`db`.`t`');
  check('split clickhouse 反斜杠', splitSql("SELECT 'a\\';b'; SELECT 2", 'clickhouse').length === 2);
  check('split clickhouse 反引号', splitSql('SELECT `a;b`; SELECT 2', 'clickhouse').length === 2);
  check('ch 语句分类', (() => {
    const q = /^\s*(select|with|show|desc|describe|explain|exists)\b/i;
    return q.test('  WITH x AS (SELECT 1) SELECT * FROM x') && q.test('SHOW DATABASES') &&
      !q.test('INSERT INTO t VALUES (1)') && !q.test('ALTER TABLE t DELETE WHERE 1');
  })());
  check('ch 只读原因', typeof ch.readonlyReason === 'string' && ch.readonlyReason.length > 0);

  // ---- OceanBase（MySQL 兼容模式，继承 MySQL 适配器） ----
  const { OceanBaseAdapter } = require('./db/oceanbase');
  const { createAdapter } = require('./db');
  const ob = new OceanBaseAdapter({ host: 'x', user: 'root@sys' });
  check('ob 注册', createAdapter({ type: 'oceanbase', host: 'x' }) instanceof OceanBaseAdapter);
  check('ob 方言继承', ob.dialect === 'mysql');
  check('ob 转义继承', ob.quoteIdent('a`b') === '`a``b`' && ob.literal("a'b") === "'a''b'");
  check('ob 限定名', ob.qualify('db1', null, 't1') === '`db1`.`t1`');
  check('ob 网格可编辑', ob.readonlyReason === null);

  // ---- OceanBase Oracle 模式 ----
  const { OBOracleAdapter } = require('./db/oboracle');
  const obo = new OBOracleAdapter({ host: 'x', user: 'SYS@t' });
  check('obo 注册', createAdapter({ type: 'oboracle', host: 'x' }) instanceof OBOracleAdapter);
  check('obo 方言', obo.dialect === 'oracle');
  check('obo quoteIdent', obo.quoteIdent('a"b') === '"a""b"');
  check('obo literal 无反斜杠转义', obo.literal("a\\b'c") === "'a\\b''c'");
  check('obo 限定名', obo.qualify('SCOTT', null, 'EMP') === '"SCOTT"."EMP"');
  const psql = obo.pageSql('SELECT * FROM "T"', ' ORDER BY "ID" ASC', 100, 200);
  check('obo ROWNUM 分页', psql.includes('ROWNUM <= 300') && psql.includes('"RN__" > 200') && psql.includes('ORDER BY "ID" ASC'), psql);
  check('split oracle 注释与引号', splitSql("SELECT ';' FROM dual; -- x;\nSELECT q FROM t", 'oracle').length === 2);
  check('split oracle 反斜杠非转义', splitSql("SELECT 'a\\'; SELECT 2 FROM dual", 'oracle').length === 2);
  let oboErr = null;
  try { await obo.action(null, { action: 'createDatabase', newName: 'x' }); } catch (e) { oboErr = e; }
  check('obo 屏蔽建库', oboErr !== null && /CREATE USER/.test(oboErr.message));

  // ---- DDL 构建器 ----
  const ddl = require('./db/ddl');
  const { PostgresAdapter } = require('./db/postgres');
  const pgA = new PostgresAdapter({});
  const model1 = {
    table: 't1', comment: '测试表', options: '',
    columns: [
      { name: 'id', origName: null, type: 'int', length: '', scale: '', notNull: true, pk: true, autoInc: true, def: '', comment: '主键' },
      { name: 'name', origName: null, type: 'varchar', length: '100', scale: '', notNull: false, pk: false, autoInc: false, def: '匿名', comment: '' },
      { name: 'amount', origName: null, type: 'decimal', length: '10', scale: '2', notNull: false, pk: false, autoInc: false, def: '0', comment: '' },
    ],
    indexes: [{ name: 'idx_name', origName: null, columns: ['name'], unique: false }],
  };
  const c1 = ddl.buildCreateTable(my, 'db1', null, model1);
  check('ddl mysql 建表', c1.sqls[0].includes('`id` int NOT NULL AUTO_INCREMENT')
    && c1.sqls[0].includes("`name` varchar(100) NULL DEFAULT '匿名'")
    && c1.sqls[0].includes('PRIMARY KEY (`id`)')
    && c1.sqls[0].includes('COMMENT'), c1.sqls);
  check('ddl mysql 索引', c1.sqls.some((s) => s.includes('CREATE INDEX `idx_name`')), c1.sqls);
  const c2 = ddl.buildCreateTable(pgA, 'db1', 'public', model1);
  check('ddl pg 建表', c2.sqls[0].includes('GENERATED BY DEFAULT AS IDENTITY')
    && c2.sqls.some((s) => s.startsWith('COMMENT ON TABLE'))
    && c2.sqls.some((s) => s.includes("COMMENT ON COLUMN") && s.includes('主键')), c2.sqls);

  // ALTER 差异
  const orig = JSON.parse(JSON.stringify(model1));
  orig.columns.forEach((c) => { c.origName = c.name; });
  const mod = JSON.parse(JSON.stringify(orig));
  mod.columns[1].name = 'full_name';                 // 改名
  mod.columns[2].length = '12';                      // 改类型
  mod.columns.push({ name: 'created_at', origName: null, type: 'datetime', length: '', scale: '', notNull: false, pk: false, autoInc: false, def: 'CURRENT_TIMESTAMP', comment: '' });
  mod.indexes = [];                                  // 删索引
  const a1 = ddl.buildAlterTable(my, 'db1', null, orig, mod);
  check('ddl mysql change', a1.sqls.some((s) => s.includes('CHANGE COLUMN `name` `full_name`')), a1.sqls);
  check('ddl mysql modify', a1.sqls.some((s) => s.includes('CHANGE COLUMN `amount`') && s.includes('decimal(12,2)')), a1.sqls);
  check('ddl mysql add', a1.sqls.some((s) => s.includes('ADD COLUMN `created_at` datetime NULL DEFAULT CURRENT_TIMESTAMP')), a1.sqls);
  check('ddl mysql drop index', a1.sqls.some((s) => s.includes('DROP INDEX `idx_name`')), a1.sqls);
  const a2 = ddl.buildAlterTable(pgA, 'db1', 'public', orig, mod);
  check('ddl pg rename+type', a2.sqls.some((s) => s.includes('RENAME COLUMN "name" TO "full_name"'))
    && a2.sqls.some((s) => s.includes('ALTER COLUMN "amount" TYPE decimal(12,2)')), a2.sqls);

  // ---- CSV 解析 ----
  const { parseCsv } = require('./importer');
  const csv1 = parseCsv('a,b,c\r\n1,"x,y",3\n4,"含""引号""与\n换行",6\n', ',');
  check('csv 基本', csv1.length === 3 && csv1[1][1] === 'x,y', csv1);
  check('csv 引号换行', csv1[2][1] === '含"引号"与\n换行', csv1[2]);
  check('csv tab', parseCsv('a\tb\n1\t2', '\\t')[1][1] === '2');

  // ---- 设计器建表 → 导入 → 导出 端到端（SQLite） ----
  const file2 = path.join(os.tmpdir(), `dbconnect-design-${Date.now()}.db`);
  const ad2 = new SQLiteAdapter({ id: 'd', type: 'sqlite', file: file2 });
  await ad2.connect();
  const sModel = {
    table: 'imp_test', comment: '', options: '',
    columns: [
      { name: 'id', origName: null, type: 'INTEGER', length: '', scale: '', notNull: true, pk: true, autoInc: true, def: '', comment: '' },
      { name: 'name', origName: null, type: 'TEXT', length: '', scale: '', notNull: false, pk: false, autoInc: false, def: '', comment: '' },
      { name: 'score', origName: null, type: 'REAL', length: '', scale: '', notNull: false, pk: false, autoInc: false, def: '', comment: '' },
    ],
    indexes: [{ name: 'ix_imp_name', origName: null, columns: ['name'], unique: false }],
  };
  const built = ddl.buildCreateTable(ad2, 'main', null, sModel);
  await ad2.execSequential('main', built.sqls);
  const objsD = await ad2.listObjects('main');
  check('设计器建表生效', objsD.tables.some((t) => t.name === 'imp_test'));

  const { runImport } = require('./importer');
  const impRows = [['1', '张三', '88.5'], ['2', "李'四", ''], ['3', '王五', '72']];
  const impRes = await runImport(ad2, {
    db: 'main', table: 'imp_test',
    mapping: [{ target: 'id', sourceIndex: 0 }, { target: 'name', sourceIndex: 1 }, { target: 'score', sourceIndex: 2 }],
    emptyAsNull: true, errorMode: 'abort', batchSize: 2,
  }, impRows, null);
  check('导入行数', impRes.ok === 3 && impRes.failed === 0, impRes);
  const impQ = await ad2.runScript('main', 'SELECT name, score FROM imp_test ORDER BY id');
  check('导入数据正确', impQ[0].rows[1][0] === "李'四" && impQ[0].rows[1][1] === null, impQ[0].rows);

  // ---- 多格式导出 ----
  const exporter = require('./exporter');
  const expBase = path.join(os.tmpdir(), `dbconnect-exp-${Date.now()}`);
  const eCsv = await exporter.exportTable(ad2, { db: 'main', table: 'imp_test', file: expBase + '.csv', format: 'csv' });
  check('导出 csv 行数', eCsv.rows === 3);
  const csvTxt = fs.readFileSync(expBase + '.csv', 'utf8');
  check('导出 csv 内容', csvTxt.includes('id,name,score') && csvTxt.includes("李'四"), csvTxt.slice(0, 80));
  await exporter.exportTable(ad2, { db: 'main', table: 'imp_test', file: expBase + '.json', format: 'json' });
  const jsonArr = JSON.parse(fs.readFileSync(expBase + '.json', 'utf8'));
  check('导出 json', jsonArr.length === 3 && jsonArr[0].name === '张三' && jsonArr[1].score === null, jsonArr[0]);
  await exporter.exportTable(ad2, { db: 'main', table: 'imp_test', file: expBase + '.sql', format: 'sql' });
  const sqlTxt = fs.readFileSync(expBase + '.sql', 'utf8');
  check('导出 sql', sqlTxt.includes('INSERT INTO "imp_test" ("id", "name", "score") VALUES') && sqlTxt.includes("'李''四'"), sqlTxt.slice(0, 200));
  await exporter.exportTable(ad2, { db: 'main', table: 'imp_test', file: expBase + '.xlsx', format: 'xlsx' });
  const ExcelJS = require('exceljs');
  const wbCheck = new ExcelJS.Workbook();
  await wbCheck.xlsx.readFile(expBase + '.xlsx');
  const wsCheck = wbCheck.worksheets[0];
  check('导出 xlsx', wsCheck.rowCount === 4 && wsCheck.getCell('B2').value === '张三',
    { rows: wsCheck.rowCount, b2: wsCheck.getCell('B2').value });
  await exporter.exportRows(ad2, {
    file: expBase + '.md', format: 'md',
    columns: [{ name: 'a' }, { name: 'b' }],
    rows: [['x|y', null]],
  });
  const mdTxt = fs.readFileSync(expBase + '.md', 'utf8');
  check('导出 md', mdTxt.includes('| a | b |') && mdTxt.includes('x\\|y'), mdTxt);
  for (const ext of ['.csv', '.json', '.sql', '.xlsx', '.md']) {
    try { fs.unlinkSync(expBase + ext); } catch (e) { /* ignore */ }
  }

  // ---- Excel 导入解析 ----
  const { parseFile } = require('./importer');
  const xlsxIn = expBase + '-in.xlsx';
  {
    const wb2 = new ExcelJS.Workbook();
    const ws2 = wb2.addWorksheet('数据');
    ws2.addRow(['编号', '名称']);
    ws2.addRow([1, '测试甲']);
    ws2.addRow([2, '测试乙']);
    await wb2.xlsx.writeFile(xlsxIn);
    const px = await parseFile(xlsxIn, { format: 'xlsx', headerRow: true, preview: 0 });
    check('xlsx 解析', px.columns[1] === '名称' && px.totalRows === 2 && px.rows[1][1] === '测试乙', px);
    try { fs.unlinkSync(xlsxIn); } catch (e) { /* ignore */ }
  }

  await ad2.close();
  try { fs.unlinkSync(file2); } catch (e) { /* ignore */ }

  // ---- SQLite 全链路 ----
  const file = path.join(os.tmpdir(), `dbconnect-selftest-${Date.now()}.db`);
  const ad = new SQLiteAdapter({ id: 't', type: 'sqlite', file });
  await ad.connect();
  console.log('  · SQLite 模式:', ad.mode, ad.serverVersion);

  const r1 = await ad.runScript('main', `
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, age INT, note TEXT);
    INSERT INTO users (name, age, note) VALUES ('张三', 30, NULL);
    INSERT INTO users (name, age, note) VALUES ('李四', 25, 'it''s ok');
    SELECT * FROM users ORDER BY id;
  `);
  check('runScript 语句数', r1.length === 4, r1.map((x) => x.error || 'ok'));
  check('runScript 无错误', r1.every((x) => !x.error), r1.find((x) => x.error));
  const sel = r1[3];
  check('查询返回行', sel && sel.rowCount === 2);
  check('查询返回中文', sel && sel.rows[0][1] === '张三');
  check('NULL 透传', sel && sel.rows[0][3] === null);

  const objs = await ad.listObjects('main');
  check('listObjects', objs.tables.length === 1 && objs.tables[0].name === 'users' && objs.tables[0].rows === 2);

  const info = await ad.tableInfo('main', null, 'users');
  check('tableInfo 列', info.columns.length === 4);
  check('tableInfo 主键', info.pk.length === 1 && info.pk[0] === 'id');
  check('tableInfo DDL', /CREATE TABLE/i.test(info.ddl));

  const data = await ad.tableData('main', { table: 'users', page: 1, pageSize: 10 });
  check('tableData 总数', data.total === 2);
  check('tableData 主键', data.pk[0] === 'id');

  const dataW = await ad.tableData('main', { table: 'users', page: 1, pageSize: 10, where: 'age > 26', orderBy: 'id', orderDir: 'desc' });
  check('tableData where', dataW.total === 1 && dataW.rows[0][1] === '张三');

  // applyEdits：改 + 增 + 删
  const ae = await ad.applyEdits('main', {
    schema: null, table: 'users',
    edits: [
      { kind: 'update', where: { id: 1 }, set: { age: '31', note: "中文'引号" } },
      { kind: 'insert', values: { name: '王五', age: '40' } },
      { kind: 'delete', where: { id: 2 } },
    ],
  });
  check('applyEdits 条数', ae.count === 3, ae.sqls);
  const after = await ad.runScript('main', 'SELECT id, name, age, note FROM users ORDER BY id');
  const rows = after[0].rows;
  check('update 生效', rows[0][2] === 31 && rows[0][3] === "中文'引号", rows);
  check('insert/delete 生效', rows.length === 2 && rows[1][1] === '王五', rows);

  // 事务回滚：第二条失败应回滚第一条
  let txnErr = null;
  try {
    await ad.applyEdits('main', {
      schema: null, table: 'users',
      edits: [
        { kind: 'update', where: { id: 1 }, set: { age: '99' } },
        { kind: 'insert', values: { name: null } }, // NOT NULL 违反
      ],
    });
  } catch (e) { txnErr = e; }
  const afterTxn = await ad.runScript('main', 'SELECT age FROM users WHERE id = 1');
  check('事务回滚', txnErr !== null && afterTxn[0].rows[0][0] === 31, txnErr && txnErr.message);

  // 错误语句报告
  const bad = await ad.runScript('main', 'SELECT * FROM not_exists');
  check('错误语句报告', bad.length === 1 && !!bad[0].error);

  // action
  await ad.action('main', { action: 'rename', table: 'users', newName: 'users2' });
  const objs2 = await ad.listObjects('main');
  check('重命名表', objs2.tables[0].name === 'users2');
  await ad.action('main', { action: 'truncate', table: 'users2' });
  const cnt = await ad.runScript('main', 'SELECT COUNT(*) FROM users2');
  check('清空表', cnt[0].rows[0][0] === 0);
  await ad.action('main', { action: 'dropTable', table: 'users2' });
  const objs3 = await ad.listObjects('main');
  check('删除表', objs3.tables.length === 0);

  await ad.close();
  try { fs.unlinkSync(file); } catch (e) { /* ignore */ }

  // ---- store 加解密 ----
  const store = require('./store');
  const saved = store.save({ name: '自检', type: 'sqlite', file: 'x.db', password: 'p@ss中文' });
  const got = store.getById(saved.id);
  check('store 密码往返', got.password === 'p@ss中文');
  store.remove(saved.id);
  check('store 删除', store.list().every((c) => c.id !== saved.id));

  // ---- 连接分组 ----
  store.addGroup('  测试组A  ');
  check('group 新建去空格', store.listGroups().includes('测试组A'));
  const gConn = store.save({ name: '组内连接', type: 'sqlite', file: 'g.db', group: '测试组A' });
  store.renameGroup('测试组A', '测试组B');
  check('group 重命名联动连接', store.getById(gConn.id).group === '测试组B'
    && store.listGroups().includes('测试组B') && !store.listGroups().includes('测试组A'));
  store.removeGroup('测试组B');
  check('group 删除后连接保留', !store.getById(gConn.id).group
    && !store.listGroups().includes('测试组B'));
  store.remove(gConn.id);
  let gErr = null;
  try { store.addGroup('   '); } catch (e) { gErr = e; }
  check('group 空名拒绝', gErr !== null);

  // SSH 配置加密往返
  const savedSsh = store.save({
    name: '自检ssh', type: 'mysql', host: 'h', password: 'dbpw',
    ssh: { enabled: true, host: 'jump', port: 22, user: 'ops', authType: 'password', password: 'sshpw密', keyFile: '', passphrase: 'pp' },
  });
  const gotSsh = store.getById(savedSsh.id);
  check('store ssh 密码往返', gotSsh.ssh.password === 'sshpw密' && gotSsh.ssh.passphrase === 'pp' && gotSsh.ssh.host === 'jump');
  const rawTxt = fs.readFileSync(path.join(require('electron').app.getPath('userData'), 'connections.json'), 'utf8');
  check('store ssh 密码不以明文落盘', !rawTxt.includes('sshpw密'));
  store.remove(savedSsh.id);

  // ---- 查询历史 ----
  const history = require('./history');
  history.clear();
  history.add({ connId: 'c1', connName: '连接A', db: 'db1', sql: 'SELECT 1', ms: 5, ok: true, statements: 1 });
  history.add({ connId: 'c1', connName: '连接A', db: 'db1', sql: 'SELECT bad', ms: 3, ok: false, error: 'no such table', statements: 1 });
  const hl = history.list({});
  check('history 记录', hl.length === 2 && hl[0].sql === 'SELECT bad' && hl[0].ok === false);
  check('history 搜索', history.list({ search: 'bad' }).length === 1);
  history.flushSync();
  check('history 落盘', fs.existsSync(path.join(require('electron').app.getPath('userData'), 'history.json')));
  history.clear();
  check('history 清空', history.list({}).length === 0);

  // ---- SQL 格式化 ----
  const { format } = require('sql-formatter');
  const fmtOut = format('select id,name from users where id=1 and name like \'%a%\'', { language: 'mysql', keywordCase: 'upper' });
  check('sql-formatter 基本', fmtOut.includes('SELECT') && fmtOut.includes('\n') && fmtOut.includes('WHERE'), fmtOut.slice(0, 60));
  const fmtPl = format('select * from dual', { language: 'plsql', keywordCase: 'upper' });
  check('sql-formatter plsql', fmtPl.includes('SELECT'), fmtPl);

  // ---- SSH 隧道（错误路径，不需要真实 SSH 服务器） ----
  const { openTunnel } = require('./tunnel');
  let tunErr = null;
  try {
    await openTunnel({ host: '127.0.0.1', port: 1, user: 'x', authType: 'password', password: 'y' }, 'db', 3306);
  } catch (e) { tunErr = e; }
  check('tunnel 连接失败报错', tunErr !== null && /SSH 连接失败/.test(tunErr.message), tunErr && tunErr.message);
  let tunErr2 = null;
  try {
    await openTunnel({ host: 'h', port: 22, user: 'x', authType: 'key', keyFile: 'Z:\\not\\exist\\id_rsa' }, 'db', 3306);
  } catch (e) { tunErr2 = e; }
  check('tunnel 私钥缺失报错', tunErr2 !== null && /读取私钥文件失败/.test(tunErr2.message));
  let tunErr3 = null;
  try {
    await openTunnel({ host: '', user: 'x' }, 'db', 3306);
  } catch (e) { tunErr3 = e; }
  check('tunnel 缺主机报错', tunErr3 !== null && /SSH 主机未填写/.test(tunErr3.message));

  // ---- 保存的查询 ----
  const queries = require('./queries');
  const q1 = queries.save({ connId: 'cA', name: '查询一', sql: 'SELECT 1' });
  const q2 = queries.save({ connId: 'cA', name: '查询一', sql: 'SELECT 2' }); // 重名自动加序号
  queries.save({ connId: 'cB', name: '其他连接', sql: 'SELECT 3' });
  check('queries 保存与重名', q1.name === '查询一' && q2.name === '查询一 (2)');
  check('queries 按连接隔离', queries.list('cA').length === 2 && queries.list('cB').length === 1);
  const q1b = queries.save({ id: q1.id, connId: 'cA', name: '查询一改', sql: 'SELECT 11' });
  check('queries 更新', q1b.name === '查询一改' && queries.list('cA').find((x) => x.id === q1.id).sql === 'SELECT 11');
  queries.rename(q2.id, '改名');
  check('queries 重命名', queries.list('cA').some((x) => x.name === '改名'));
  queries.remove(q1.id);
  queries.remove(q2.id);
  check('queries 删除', queries.list('cA').length === 0);
  for (const q of queries.list('cB')) queries.remove(q.id);

  // ---- 列级补全（SQLite 全库列清单） ----
  const file3 = path.join(os.tmpdir(), `dbconnect-cols-${Date.now()}.db`);
  const ad3 = new SQLiteAdapter({ id: 'c', type: 'sqlite', file: file3 });
  await ad3.connect();
  await ad3.runScript('main', 'CREATE TABLE aa (x INT, y TEXT); CREATE TABLE bb (z REAL)');
  const allCols = await ad3.listAllColumns('main');
  check('listAllColumns', allCols.aa && allCols.aa.join(',') === 'x,y' && allCols.bb[0] === 'z', allCols);
  let cancelErr = null;
  try { await ad3.cancel(); } catch (e) { cancelErr = e; }
  check('sqlite cancel 提示不支持', cancelErr !== null && /不支持取消/.test(cancelErr.message));
  await ad3.close();
  try { fs.unlinkSync(file3); } catch (e) { /* ignore */ }

  // mysql cancel 无活动会话时静默返回
  let myCancelOk = true;
  try { await my.cancel(); } catch (e) { myCancelOk = false; }
  check('mysql cancel 空闲安全', myCancelOk);

  // ---- 对象覆盖面 ----
  check('base objectCaps 默认关闭', Object.values(new SQLiteAdapter({}).objectCaps).filter(Boolean).length === 1); // 仅 triggers
  check('mysql objectCaps', my.objectCaps.routines && my.objectCaps.triggers && my.objectCaps.events && my.objectCaps.users && !my.objectCaps.sequences);
  check('mysql dropUserSql', my.dropUserSql('u1', 'localhost') === "DROP USER 'u1'@'localhost'");
  check('pg dropTriggerSql', pgA.dropTriggerSql('d', 'public', 'trg', 't1') === 'DROP TRIGGER "trg" ON "public"."t1"');
  check('ob 无事件', new (require('./db/oceanbase').OceanBaseAdapter)({}).objectCaps.events === false);

  // SQLite 触发器全链路
  const file4 = path.join(os.tmpdir(), `dbconnect-trg-${Date.now()}.db`);
  const ad4 = new SQLiteAdapter({ id: 't4', type: 'sqlite', file: file4 });
  await ad4.connect();
  await ad4.runScript('main', `
    CREATE TABLE logs (id INTEGER PRIMARY KEY, msg TEXT, at TEXT);
    CREATE TRIGGER trg_at AFTER INSERT ON logs BEGIN UPDATE logs SET at = datetime('now') WHERE id = NEW.id; END;
  `);
  const trgs = await ad4.listTriggers('main');
  check('sqlite listTriggers', trgs.length === 1 && trgs[0].name === 'trg_at' && trgs[0].table === 'logs', trgs);
  const trgDdl = await ad4.objectDdl('main', null, 'TRIGGER', 'trg_at');
  check('sqlite trigger ddl', /CREATE TRIGGER trg_at/i.test(trgDdl), trgDdl);
  await ad4.runScript('main', "INSERT INTO logs (msg) VALUES ('x')");
  const trgFired = await ad4.runScript('main', 'SELECT at FROM logs WHERE id = 1');
  check('sqlite trigger 生效', trgFired[0].rows[0][0] !== null);
  await ad4.action('main', { action: 'dropTrigger', name: 'trg_at', table: 'logs' });
  check('sqlite dropTrigger', (await ad4.listTriggers('main')).length === 0);
  await ad4.close();
  try { fs.unlinkSync(file4); } catch (e) { /* ignore */ }

  // 存储过程整段执行启发式（MySQL 方言：过程体内分号不拆分）
  const procSql = 'CREATE PROCEDURE p1(IN x INT)\nBEGIN\n  SELECT x;\n  SELECT x + 1;\nEND';
  let capturedStmts = null;
  const fakeMy = new MySQLAdapter({});
  fakeMy.withSession = async (_db, fn) => fn(async (s) => { (capturedStmts = capturedStmts || []).push(s); return { affected: 0 }; });
  await fakeMy.runScript('d1', procSql);
  check('mysql 过程整段执行', capturedStmts && capturedStmts.length === 1 && capturedStmts[0].includes('SELECT x + 1'), capturedStmts && capturedStmts.length);
  capturedStmts = null;
  await fakeMy.runScript('d1', 'SELECT 1; SELECT 2');
  check('mysql 普通语句仍拆分', capturedStmts && capturedStmts.length === 2);

  // 混合脚本中的过程体感知拆分
  const mixed = splitSql(
    "CREATE TABLE a (x INT); CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = 1; UPDATE a SET x = 2; END; SELECT 1",
    'sqlite');
  check('split 触发器体感知', mixed.length === 3 && /END$/i.test(mixed[1]) && mixed[2] === 'SELECT 1', mixed.map((s) => s.slice(0, 30)));

  // ---- DBA 工具：类型映射 / BLOB 字面量 / 传输 / 转储回环 ----
  const transfer = require('./transfer');
  const srcModel = {
    table: 'tt', comment: '', options: '',
    columns: [
      { name: 'id', origName: 'id', type: 'int', length: '', scale: '', notNull: true, pk: true, autoInc: false, def: '', comment: '' },
      { name: 'flag', origName: 'flag', type: 'tinyint', length: '1', scale: '', notNull: false, pk: false, autoInc: false, def: '', comment: '' },
      { name: 'body', origName: 'body', type: 'longtext', length: '', scale: '', notNull: false, pk: false, autoInc: false, def: '', comment: '' },
      { name: 'created', origName: 'created', type: 'datetime', length: '', scale: '', notNull: false, pk: false, autoInc: false, def: '', comment: '' },
      { name: 'amount', origName: 'amount', type: 'decimal', length: '10', scale: '2', notNull: false, pk: false, autoInc: false, def: '', comment: '' },
    ],
    indexes: [],
  };
  const trPg = ddl.translateModel(srcModel, 'mysql', 'postgres').model;
  check('类型映射 mysql→pg',
    trPg.columns[1].type === 'boolean' && trPg.columns[2].type === 'text' &&
    trPg.columns[3].type === 'timestamp' && trPg.columns[4].type === 'numeric' && trPg.columns[4].length === '10', trPg.columns.map((c) => c.type));
  const trMs = ddl.translateModel(srcModel, 'mysql', 'mssql').model;
  check('类型映射 mysql→mssql', trMs.columns[2].type === 'nvarchar' && trMs.columns[2].length === 'max' && trMs.columns[3].type === 'datetime2', trMs.columns.map((c) => `${c.type}(${c.length})`));
  const trLite = ddl.translateModel(srcModel, 'mysql', 'sqlite').model;
  check('类型映射 mysql→sqlite', trLite.columns[0].type === 'INTEGER' && trLite.columns[2].type === 'TEXT');
  check('同方言不变', ddl.translateModel(srcModel, 'mysql', 'mysql').model.columns[2].type === 'longtext');

  const buf = Buffer.from([0x01, 0xab, 0xff]);
  check('blob mysql', my.blobLiteral(buf) === '0x01abff');
  check('blob pg', pgA.blobLiteral(buf) === "'\\x01abff'");
  check('blob sqlite', new SQLiteAdapter({}).blobLiteral(buf) === "X'01abff'");
  check('blob oracle', obo.blobLiteral(buf) === "HEXTORAW('01abff')");
  check('valueLiteral 混合', transfer.valueLiteral(my, null) === 'NULL'
    && transfer.valueLiteral(my, 12.5) === '12.5'
    && transfer.valueLiteral(my, buf) === '0x01abff'
    && transfer.valueLiteral(my, "a'b") === "'a''b'");

  // 传输端到端：sqlite → sqlite（结构 + 数据 + BLOB 保真）
  const fSrc = path.join(os.tmpdir(), `dbc-tr-src-${Date.now()}.db`);
  const fDst = path.join(os.tmpdir(), `dbc-tr-dst-${Date.now()}.db`);
  const adSrc = new SQLiteAdapter({ id: 's', type: 'sqlite', file: fSrc });
  const adDst = new SQLiteAdapter({ id: 'd', type: 'sqlite', file: fDst });
  await adSrc.connect();
  await adDst.connect();
  await adSrc.runScript('main', `
    CREATE TABLE goods (id INTEGER PRIMARY KEY, name TEXT, data BLOB, price REAL);
    INSERT INTO goods VALUES (1, '苹果''s', X'00ff10', 3.5);
    INSERT INTO goods VALUES (2, NULL, NULL, NULL);
    CREATE TABLE empty_t (a INT);
  `);
  const trReport = await transfer.runTransfer(adSrc, adDst, {
    srcDb: 'main', dstDb: 'main',
    tables: [{ name: 'goods' }, { name: 'empty_t' }],
    createTable: true, copyData: true, batchSize: 1,
  }, () => {});
  check('传输报告', trReport.tables.length === 2 && trReport.tables[0].rows === 2 && !trReport.errors.length, trReport);
  const dstRows = await adDst.exec('main', 'SELECT id, name, hex(data), price FROM goods ORDER BY id');
  check('传输数据保真', dstRows.rows[0][1] === "苹果's" && dstRows.rows[0][2] === '00FF10' && dstRows.rows[1][1] === null, dstRows.rows);

  // 转储 → 运行 SQL 文件回环
  const dumpFile = path.join(os.tmpdir(), `dbc-dump-${Date.now()}.sql`);
  const dumpRes = await transfer.dumpSql(adSrc, {
    db: 'main', tables: [{ name: 'goods' }], file: dumpFile, includeDrop: true, includeData: true,
  }, () => {});
  check('转储统计', dumpRes.tables === 1 && dumpRes.rows === 2, dumpRes);
  const dumpTxt = fs.readFileSync(dumpFile, 'utf8');
  check('转储内容', dumpTxt.includes('DROP TABLE IF EXISTS') && dumpTxt.includes('CREATE TABLE') && dumpTxt.includes("X'00ff10'"), dumpTxt.slice(0, 120));
  const fRt = path.join(os.tmpdir(), `dbc-rt-${Date.now()}.db`);
  const adRt = new SQLiteAdapter({ id: 'r', type: 'sqlite', file: fRt });
  await adRt.connect();
  const runRes = await transfer.runSqlFile(adRt, { db: 'main', file: dumpFile, stopOnError: false }, () => {});
  check('SQL 文件执行', runRes.failed === 0 && runRes.executed >= 4, runRes);
  const rtCount = await adRt.exec('main', 'SELECT COUNT(*) FROM goods');
  check('回环行数', Number(rtCount.rows[0][0]) === 2);
  await adSrc.close(); await adDst.close(); await adRt.close();
  for (const f of [fSrc, fDst, fRt, dumpFile]) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }

  // 进程监控能力
  check('processes caps', my.objectCaps.processes === true && pgA.objectCaps.processes === true
    && !new SQLiteAdapter({}).objectCaps.processes);

  // ---- 结构同步 / 数据同步 ----
  const sync = require('./sync');
  check('cmpNum 基本', sync.cmpNum(2, 10) < 0 && sync.cmpNum('10', '9') > 0 && sync.cmpNum(5, 5) === 0);
  check('cmpNum 大整数', sync.cmpNum('9007199254740993', '9007199254740992') > 0
    && sync.cmpNum('-100', '99') < 0);
  check('normVal 数字归一', sync.normVal('3.50') === sync.normVal(3.5)
    && sync.normVal('007') === sync.normVal(7)
    && sync.normVal(null) !== sync.normVal(''));
  check('normVal 日期归一', sync.normVal('2025-01-02T10:00:00') === sync.normVal('2025-01-02 10:00:00'));

  // 结构同步端到端（SQLite 双库）
  const fS1 = path.join(os.tmpdir(), `dbc-ss-src-${Date.now()}.db`);
  const fS2 = path.join(os.tmpdir(), `dbc-ss-dst-${Date.now()}.db`);
  const adS1 = new SQLiteAdapter({ id: 'x', type: 'sqlite', file: fS1 });
  const adS2 = new SQLiteAdapter({ id: 'y', type: 'sqlite', file: fS2 });
  await adS1.connect();
  await adS2.connect();
  await adS1.runScript('main', `
    CREATE TABLE t1 (id INTEGER PRIMARY KEY, name TEXT, extra_col TEXT);
    CREATE INDEX ix_t1_name ON t1(name);
    CREATE TABLE t2 (id INTEGER PRIMARY KEY, v REAL);
  `);
  await adS2.runScript('main', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY, name TEXT)');
  const sd = await sync.diffStructure(adS1, adS2, {
    srcDb: 'main', dstDb: 'main',
    tables: [{ name: 't1' }, { name: 't2' }],
  }, () => {});
  const t1d = sd.tables.find((x) => x.table === 't1');
  const t2d = sd.tables.find((x) => x.table === 't2');
  check('结构比对 修改+新建', t1d.status === 'alter' && t2d.status === 'create',
    sd.tables.map((x) => `${x.table}:${x.status}`));
  check('结构比对 加列加索引', t1d.sqls.some((s) => s.includes('ADD COLUMN "extra_col"'))
    && t1d.sqls.some((s) => s.includes('CREATE INDEX "ix_t1_name"')), t1d.sqls);
  const allSyncSqls = [...t1d.sqls, ...t2d.sqls];
  await sync.execMany(adS2, 'main', allSyncSqls, () => {});
  const sd2 = await sync.diffStructure(adS1, adS2, {
    srcDb: 'main', dstDb: 'main', tables: [{ name: 't1' }, { name: 't2' }],
  }, () => {});
  check('结构同步收敛', sd2.tables.every((x) => x.status === 'same'),
    sd2.tables.map((x) => `${x.table}:${x.status}(${x.sqls.join('|')})`));

  // 数据同步端到端（数字主键归并 + 应用）
  await adS1.runScript('main', `
    INSERT INTO t1 (id, name, extra_col) VALUES (1, '甲', 'a');
    INSERT INTO t1 (id, name, extra_col) VALUES (2, '乙', 'b');
    INSERT INTO t1 (id, name, extra_col) VALUES (3, '丙', NULL);
  `);
  await adS2.runScript('main', `
    INSERT INTO t1 (id, name, extra_col) VALUES (2, '乙旧', 'b');
    INSERT INTO t1 (id, name, extra_col) VALUES (9, '多余', NULL);
  `);
  const ds = await sync.syncData(adS1, adS2, {
    srcDb: 'main', dstDb: 'main', tables: [{ name: 't1' }],
    mode: 'apply', doInsert: true, doUpdate: true, doDelete: true, batchSize: 2,
  }, () => {});
  const dst1 = ds.tables[0];
  check('数据同步计数', dst1.inserts === 2 && dst1.updates === 1 && dst1.deletes === 1 && !dst1.skipped, dst1);
  const after1 = await adS2.exec('main', 'SELECT id, name FROM t1 ORDER BY id');
  check('数据同步应用结果', after1.rows.length === 3 && after1.rows[1][1] === '乙'
    && Number(after1.rows[2][0]) === 3, after1.rows);
  // 再次同步应无差异
  const ds2 = await sync.syncData(adS1, adS2, {
    srcDb: 'main', dstDb: 'main', tables: [{ name: 't1' }], mode: 'count',
  }, () => {});
  check('数据同步收敛', ds2.tables[0].inserts === 0 && ds2.tables[0].updates === 0 && ds2.tables[0].deletes === 0, ds2.tables[0]);
  await adS1.close(); await adS2.close();
  for (const f of [fS1, fS2]) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }

  // ---- 外键 / 在库中查找 / BLOB（第二档） ----
  try {
  const fkFile = path.join(os.tmpdir(), `dbc-fk-${Date.now()}.db`);
  const adFk = new SQLiteAdapter({ id: 'fk', type: 'sqlite', file: fkFile });
  await adFk.connect();
  await adFk.runScript('main', `
    CREATE TABLE dept (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE emp (id INTEGER PRIMARY KEY, name TEXT, dept_id INTEGER REFERENCES dept(id), avatar BLOB);
    INSERT INTO dept VALUES (1, '研发部'), (2, '市场部');
    INSERT INTO emp (id, name, dept_id, avatar) VALUES (1, '张三', 1, X'89504E470D0A1A0A'), (2, '李四', 2, NULL);
    INSERT INTO emp (id, name, dept_id) VALUES (3, '王五的备注里有研发关键字', 1);
  `);
  const fks = await adFk.listForeignKeys('main', null, 'emp');
  check('sqlite 外键读取', fks.length === 1 && fks[0].columns[0] === 'dept_id' && fks[0].refTable === 'dept' && fks[0].refColumns[0] === 'id', fks);
  check('sqlite 无外键表', (await adFk.listForeignKeys('main', null, 'dept')).length === 0);

  // cellBlob：取完整 BLOB（PNG magic）
  const blob = await adFk.cellBlob('main', { schema: null, table: 'emp', column: 'avatar', pk: { id: 1 } });
  check('cellBlob 完整内容', Buffer.isBuffer(blob) && blob.length === 8 && blob[0] === 0x89 && blob[1] === 0x50, blob && blob.length);
  check('cellBlob NULL', (await adFk.cellBlob('main', { schema: null, table: 'emp', column: 'avatar', pk: { id: 2 } })) === null);

  // 在库中查找
  const search = require('./search');
  const byName = await search.searchDatabase(adFk, { db: 'main', keyword: 'dept', mode: 'name' }, () => {});
  check('查找 对象名(表)', byName.results.some((r) => r.kind === 'table' && r.table === 'dept'), byName.results);
  check('查找 对象名(列)', byName.results.some((r) => r.kind === 'column' && r.column === 'dept_id'), byName.results.filter((r) => r.kind === 'column'));
  const byData = await search.searchDatabase(adFk, { db: 'main', keyword: '研发', mode: 'data' }, () => {});
  const hitEmp = byData.results.find((r) => r.table === 'emp' && r.column === 'name');
  check('查找 数据内容', !!hitEmp && hitEmp.pk && Number(hitEmp.pk.id) === 3, byData.results);
  check('查找 数据片段', hitEmp && hitEmp.snippet.includes('研发'), hitEmp && hitEmp.snippet);
  // ER 模型
  const er = await adFk.erModel('main', null, {});
  check('ER 表数', er.tables.length === 2, er.tables.map((t) => t.name));
  const erEmp = er.tables.find((t) => t.name === 'emp');
  check('ER 列标记 pk/fk', erEmp && erEmp.columns.find((c) => c.name === 'id').pk
    && erEmp.columns.find((c) => c.name === 'dept_id').fk, erEmp && erEmp.columns);
  check('ER 关系', er.relations.length === 1 && er.relations[0].from === 'emp'
    && er.relations[0].to === 'dept' && er.relations[0].known === true, er.relations);

  // EXPLAIN（SQLite 树）
  const plan = await adFk.explainPlan('main', 'SELECT e.name, d.name FROM emp e JOIN dept d ON e.dept_id = d.id WHERE e.id > 1');
  check('explain 格式 tree', plan.format === 'tree' && plan.root && Array.isArray(plan.root.children), plan.format);
  const flat = [];
  (function walk(n) { flat.push(n.title); (n.children || []).forEach(walk); })(plan.root);
  check('explain 含扫描节点', flat.some((t) => /SCAN|SEARCH/i.test(t)), flat);

  await adFk.close();
  try { fs.unlinkSync(fkFile); } catch (e) { /* ignore */ }
  } catch (e2) { fail++; console.log('  ✗ 第二档块异常:', e2 && e2.stack || e2); }

  // ---- AI 助手（纯函数：URL 推导 + SSE 解析） ----
  try {
    const ai = require('./ai');
    check('ai buildUrl 追加路径', ai.buildUrl('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1/chat/completions');
    check('ai buildUrl 去尾斜杠', ai.buildUrl('https://api.deepseek.com/v1/') === 'https://api.deepseek.com/v1/chat/completions');
    check('ai buildUrl 已完整', ai.buildUrl('http://x/y/chat/completions') === 'http://x/y/chat/completions');
    check('ai buildUrl 空报错', (() => { try { ai.buildUrl(''); return false; } catch (e) { return true; } })());
    check('ai SSE 增量', ai.parseSSELine('data: {"choices":[{"delta":{"content":"你好"}}]}') === '你好');
    check('ai SSE message 兜底', ai.parseSSELine('data: {"choices":[{"message":{"content":"hi"}}]}') === 'hi');
    check('ai SSE DONE', ai.parseSSELine('data: [DONE]') === null);
    check('ai SSE 非data行', ai.parseSSELine(': keep-alive') === '');
    check('ai SSE 空delta', ai.parseSSELine('data: {"choices":[{"delta":{}}]}') === '');
    const store2 = require('./store');
    check('ai 默认配置', (() => { const c = store2.getAiConfig(); return c && c.baseUrl && c.model && c.provider; })());
  } catch (eAi) { fail++; console.log('  ✗ AI 块异常:', eAi && eAi.stack || eAi); }

  console.log(`[SELFTEST] 通过 ${pass} 项, 失败 ${fail} 项`);
  return fail === 0 ? 0 : 1;
}

module.exports = { runSelfTest };
