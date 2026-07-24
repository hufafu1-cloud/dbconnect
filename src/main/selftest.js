// 自检：不依赖外部数据库服务器，用 SQLite 适配器跑通核心链路 + 工具函数单测
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  splitSql, statementAt, sanitizeValue, limitQueryRows, statementKind, hasClickHouseFormatClause,
  hasSQLiteExternalFileClause, transactionControlKind, unsafeSessionMutationKind, simpleEditableSelect,
} = require('./db/sqlutil');
const { SQLiteAdapter } = require('./db/sqlite');
const { MySQLAdapter } = require('./db/mysql');
const { ClickHouseAdapter } = require('./db/clickhouse');
const { parseNcx, parseNcxBuffer } = require('./navicatNcx');
const { decryptNavicatSecret } = require('./navicatCrypto');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail !== undefined ? JSON.stringify(detail) : ''); }
}

async function runSelfTest() {
  const navicatV1 = decryptNavicatSecret('0EA71F51DD37BFB60CCBA219BE3A');
  check('navicat decrypts V1 Blowfish passwords', navicatV1.plaintext === 'This is a test'
    && navicatV1.version === 'v1', navicatV1);
  const navicatV2 = decryptNavicatSecret('B75D320B6211468D63EB3B67C9E85933');
  check('navicat decrypts V2 AES passwords', navicatV2.plaintext === 'This is a test'
    && navicatV2.version === 'v2', navicatV2);
  check('navicat rejects invalid encrypted passwords', (() => {
    try { decryptNavicatSecret('not-a-navicat-cipher'); return false; }
    catch (error) { return /Navicat|密码|密文/.test(error.message); }
  })());
  // ---- Navicat NCX import ----
  const ncxBasic = parseNcx(`<?xml version="1.0" encoding="UTF-8"?>
    <Connections>
      <Connection ConnectionName="Local MySQL" ConnType="MYSQL" Host="127.0.0.1"
        Port="3307" UserName="root" Database="app" Password="B75D320B6211468D63EB3B67C9E85933" />
      <Connection Name="Unsupported" Type="ORACLE" Host="db.example" />
    </Connections>`);
  check('ncx maps a MySQL connection', ncxBasic.connections.length === 1
    && ncxBasic.connections[0].type === 'mysql'
    && ncxBasic.connections[0].name === 'Local MySQL'
    && ncxBasic.connections[0].host === '127.0.0.1'
    && ncxBasic.connections[0].port === 3307
    && ncxBasic.connections[0].user === 'root'
    && ncxBasic.connections[0].database === 'app', ncxBasic);
  check('ncx automatically decrypts database passwords', ncxBasic.connections[0].password === 'This is a test'
    && ncxBasic.passwordImported === 1, ncxBasic);
  check('ncx reports unsupported connection types', ncxBasic.skipped.length === 1
    && /ORACLE/i.test(ncxBasic.skipped[0].type), ncxBasic.skipped);

  const ncxGrouped = parseNcx(`<NavicatConnections>
    <MySQL><Group Name="Production"><Connection Name="Primary" Host="db.internal" UserName="deploy">
      <SSH Enabled="true" Host="jump.internal" Port="2222" UserName="ops"
        Authentication="publickey" PrivateKeyFile="C:\\keys\\ops.pem"
        Password="B75D320B6211468D63EB3B67C9E85933" Passphrase="0EA71F51DD37BFB60CCBA219BE3A" />
    </Connection></Group></MySQL>
    <SQLite><Connection Name="Local Cache" DatabaseFile="C:\\data\\cache.db" /></SQLite>
  </NavicatConnections>`);
  const ncxSsh = ncxGrouped.connections.find((item) => item.name === 'Primary');
  const ncxSqlite = ncxGrouped.connections.find((item) => item.type === 'sqlite');
  check('ncx inherits type and group from ancestors', ncxSsh && ncxSsh.type === 'mysql'
    && ncxSsh.group === 'Production', ncxSsh);
  check('ncx decrypts SSH password and passphrase', ncxSsh && ncxSsh.ssh && ncxSsh.ssh.enabled
    && ncxSsh.ssh.host === 'jump.internal' && ncxSsh.ssh.port === 2222
    && ncxSsh.ssh.user === 'ops' && ncxSsh.ssh.authType === 'key'
    && ncxSsh.ssh.keyFile === 'C:\\keys\\ops.pem'
    && ncxSsh.ssh.password === 'This is a test' && ncxSsh.ssh.passphrase === 'This is a test', ncxSsh && ncxSsh.ssh);
  check('ncx maps SQLite file paths', ncxSqlite && ncxSqlite.file === 'C:\\data\\cache.db', ncxSqlite);
  const ncxChildFields = parseNcx(`<Connections><Connection ConnectionType="SQLite">
    <Name>Child Fields</Name><DatabaseFileName>C:\\data\\child.db</DatabaseFileName>
  </Connection></Connections>`);
  check('ncx maps child-element fields', ncxChildFields.connections.length === 1
    && ncxChildFields.connections[0].name === 'Child Fields'
    && ncxChildFields.connections[0].file === 'C:\\data\\child.db', ncxChildFields);
  const ncxBadPassword = parseNcx(`<Connections>
    <Connection Name="Bad Password" Type="MYSQL" Host="localhost" Password="not-valid" />
    <Connection Name="Good Password" Type="MYSQL" Host="localhost" Password="B75D320B6211468D63EB3B67C9E85933" />
  </Connections>`);
  check('ncx skips only connections whose password cannot decrypt', ncxBadPassword.connections.length === 1
    && ncxBadPassword.connections[0].name === 'Good Password'
    && ncxBadPassword.skipped.some((item) => item.name === 'Bad Password' && /密码|解密/.test(item.reason)), ncxBadPassword);

  const utf16Source = '<?xml version="1.0"?><Connections><Connection Name="PG" Type="PostgreSQL" Host="localhost" /></Connections>';
  const utf16Ncx = parseNcxBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf16Source, 'utf16le')]));
  check('ncx decodes UTF-16LE files', utf16Ncx.connections.length === 1
    && utf16Ncx.connections[0].type === 'postgres', utf16Ncx);
  const utf16Le = Buffer.from(utf16Source.replace('PostgreSQL', 'SQL Server'), 'utf16le');
  const utf16Be = Buffer.alloc(utf16Le.length);
  for (let i = 0; i < utf16Le.length; i += 2) { utf16Be[i] = utf16Le[i + 1]; utf16Be[i + 1] = utf16Le[i]; }
  const utf16BeNcx = parseNcxBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), utf16Be]));
  check('ncx decodes UTF-16BE files', utf16BeNcx.connections.length === 1
    && utf16BeNcx.connections[0].type === 'mssql', utf16BeNcx);
  check('ncx rejects DTD and entities', (() => {
    try { parseNcx('<!DOCTYPE x [<!ENTITY y "z">]><Connections/>'); return false; }
    catch (error) { return /DTD|ENTITY|实体/.test(error.message); }
  })());
  check('ncx rejects malformed XML', (() => {
    try { parseNcx('<Connections><Connection></Connections>'); return false; }
    catch (error) { return /XML|解析/.test(error.message); }
  })());
  console.log('[SELFTEST] 开始');

  // ---- splitSql ----
  check('split 基本', splitSql('SELECT 1; SELECT 2', 'sqlite').length === 2);
  check('split 字符串内分号', splitSql("SELECT ';'; SELECT 2", 'sqlite').length === 2);
  check('split 行注释', splitSql('-- a;b\nSELECT 1', 'sqlite').length === 1);
  check('split 块注释', splitSql('/* ; */ SELECT 1; SELECT 2', 'sqlite').length === 2);
  check('split mysql 反斜杠', splitSql("SELECT 'a\\';b'; SELECT 2", 'mysql').length === 2);
  check('split pg 美元引用', splitSql('CREATE FUNCTION f() RETURNS void AS $x$ a; b $x$ LANGUAGE sql; SELECT 1', 'postgres').length === 2);
  check('split pg E 字符串', splitSql("SELECT E'it\\'s; ok' AS x; SELECT 2", 'postgres').length === 2);
  check('split pg 嵌套块注释', splitSql('/* outer /* inner */ ; still outer */ SELECT 1; SELECT 2', 'postgres').length === 2);
  check('split oracle q 引用', splitSql("SELECT q'[It's; fine]' FROM dual; SELECT 2 FROM dual", 'oracle').length === 2);
  check('split 尾部无分号', splitSql('SELECT 1', 'sqlite').length === 1);
  const cursorSql = "SELECT ';' AS a;\n-- next\nSELECT 2;\nSELECT 3";
  const cursorSecond = statementAt(cursorSql, 'sqlite', cursorSql.indexOf('SELECT 2') + 3);
  const cursorThird = statementAt(cursorSql, 'sqlite', cursorSql.indexOf('SELECT 3') + 3);
  check('光标语句忽略字符串内分号', cursorSecond && /SELECT 2/.test(cursorSecond.sql)
    && !/SELECT 3/.test(cursorSecond.sql), cursorSecond);
  check('光标语句定位末尾语句', cursorThird && cursorThird.sql === 'SELECT 3', cursorThird);
  const routineCursor = "CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET x = ';'; UPDATE t SET x = '2'; END; SELECT 9";
  const cursorRoutine = statementAt(routineCursor, 'sqlite', routineCursor.indexOf("x = '2'"));
  check('光标语句保留触发器过程体', cursorRoutine && /^CREATE TRIGGER/.test(cursorRoutine.sql)
    && /UPDATE t SET x = '2'/.test(cursorRoutine.sql), cursorRoutine);
  const mssqlGoSql = 'SELECT 1 AS a\nGO\nSELECT 2 AS b\nGO -- next batch\nSELECT 3 AS c';
  const mssqlGoCurrent = statementAt(mssqlGoSql, 'mssql', mssqlGoSql.indexOf('SELECT 2') + 4);
  check('光标语句识别 SQL Server GO 批分隔', mssqlGoCurrent
    && /SELECT 2 AS b/.test(mssqlGoCurrent.sql)
    && !/SELECT 1|SELECT 3/.test(mssqlGoCurrent.sql), mssqlGoCurrent);
  const mssqlProcSql = 'CREATE PROCEDURE p AS\nBEGIN\n SELECT 1;\n SELECT 2;\nEND\nGO\nSELECT 9';
  const mssqlProcCurrent = statementAt(mssqlProcSql, 'mssql', mssqlProcSql.indexOf('SELECT 2') + 3);
  check('光标语句保留 SQL Server 过程批', mssqlProcCurrent
    && /^CREATE PROCEDURE/.test(mssqlProcCurrent.sql)
    && /SELECT 1;[\s\S]*SELECT 2;/.test(mssqlProcCurrent.sql), mssqlProcCurrent);
  const mysqlNestedRoutineSql = 'CREATE PROCEDURE nested_p()\nBEGIN\n BEGIN\n  SELECT 1;\n END;\n SELECT 2;\nEND;\nSELECT 3';
  const mysqlNestedParts = splitSql(mysqlNestedRoutineSql, 'mysql');
  const mysqlNestedCurrent = statementAt(mysqlNestedRoutineSql, 'mysql', mysqlNestedRoutineSql.indexOf('SELECT 2') + 3);
  const mysqlAfterRoutine = statementAt(mysqlNestedRoutineSql, 'mysql', mysqlNestedRoutineSql.indexOf('SELECT 3') + 3);
  check('MySQL 嵌套 BEGIN END 不提前截断过程体', mysqlNestedParts.length === 2
    && mysqlNestedCurrent && /^CREATE PROCEDURE/.test(mysqlNestedCurrent.sql)
    && /SELECT 1;[\s\S]*SELECT 2;/.test(mysqlNestedCurrent.sql), { mysqlNestedParts, mysqlNestedCurrent });
  check('MySQL 过程后的普通语句独立定位', mysqlAfterRoutine && mysqlAfterRoutine.sql === 'SELECT 3', mysqlAfterRoutine);

  const oracleProcAndSql = 'CREATE OR REPLACE PROCEDURE p AS\nBEGIN\n IF 1 = 1 THEN\n  NULL;\n END IF;\nEND;\nSELECT 9 FROM dual';
  const oracleProcCurrent = statementAt(oracleProcAndSql, 'oracle', oracleProcAndSql.indexOf('NULL') + 2);
  const oracleAfterProc = statementAt(oracleProcAndSql, 'oracle', oracleProcAndSql.indexOf('SELECT 9') + 3);
  check('Oracle PL/SQL 内层分号保留完整块', oracleProcCurrent
    && /^CREATE OR REPLACE PROCEDURE/.test(oracleProcCurrent.sql)
    && /NULL;[\s\S]*END IF;[\s\S]*END;$/.test(oracleProcCurrent.sql), oracleProcCurrent);
  check('Oracle PL/SQL 后续 SQL 独立定位', oracleAfterProc
    && /^SELECT 9 FROM dual$/.test(oracleAfterProc.sql)
    && !/PROCEDURE/.test(oracleAfterProc.sql), oracleAfterProc);
  const oracleSlashSql = 'BEGIN\n NULL;\nEND;\n/\nSELECT 10 FROM dual';
  const oracleSlashAfter = statementAt(oracleSlashSql, 'oracle12', oracleSlashSql.indexOf('SELECT 10') + 3);
  check('Oracle 斜杠块分隔符不并入后续 SQL', oracleSlashAfter
    && oracleSlashAfter.sql === 'SELECT 10 FROM dual', oracleSlashAfter);
  const oracleRunAll = splitSql(oracleSlashSql, 'oracle12');
  check('Oracle 运行全部拆分 PL/SQL 与后续 SQL', oracleRunAll.length === 2
    && /^BEGIN/.test(oracleRunAll[0]) && oracleRunAll[1] === 'SELECT 10 FROM dual', oracleRunAll);
  check('Oracle PL/SQL 运行时保留 END 分号', /END;$/.test(oracleRunAll[0]), oracleRunAll[0]);

  const mssqlFlowSql = 'IF 1 = 1\nBEGIN\n SELECT 1;\n SELECT 2;\nEND\nGO\nSELECT 9';
  const mssqlFlowCurrent = statementAt(mssqlFlowSql, 'mssql', mssqlFlowSql.indexOf('SELECT 2') + 3);
  const mssqlAfterFlow = statementAt(mssqlFlowSql, 'mssql', mssqlFlowSql.indexOf('SELECT 9') + 3);
  check('SQL Server 控制流保留完整 GO 批', mssqlFlowCurrent
    && /^IF 1 = 1/.test(mssqlFlowCurrent.sql)
    && /SELECT 1;[\s\S]*SELECT 2;[\s\S]*END$/.test(mssqlFlowCurrent.sql), mssqlFlowCurrent);
  check('SQL Server 控制流后的 GO 批独立定位', mssqlAfterFlow
    && mssqlAfterFlow.sql === 'SELECT 9', mssqlAfterFlow);
  const mssqlRunAll = splitSql(mssqlGoSql, 'mssql');
  check('SQL Server 运行全部按 GO 拆批', mssqlRunAll.length === 3
    && /SELECT 1/.test(mssqlRunAll[0]) && /SELECT 3/.test(mssqlRunAll[2]), mssqlRunAll);
  check('事务边界识别不误伤 T-SQL/PLSQL BEGIN 块', !transactionControlKind('BEGIN SELECT 1; END', 'mssql')
    && transactionControlKind('BEGIN TRANSACTION', 'mssql') === 'BEGIN TRANSACTION'
    && transactionControlKind('SELECT 1; BEGIN TRAN; UPDATE t SET x = 1', 'mssql') === 'BEGIN TRANSACTION'
    && !transactionControlKind('CREATE PROCEDURE p AS BEGIN TRAN; ROLLBACK; RETURN;', 'mssql')
    && !transactionControlKind('BEGIN NULL; END;', 'oracle')
    && transactionControlKind('BEGIN', 'mysql') === 'BEGIN');
  check('保存点回滚不会被误判为结束整个事务',
    transactionControlKind('ROLLBACK TO SAVEPOINT before_update', 'postgres') === 'ROLLBACK TO'
    && transactionControlKind('ROLLBACK TO before_update', 'sqlite') === 'ROLLBACK TO'
    && transactionControlKind('ROLLBACK TO SAVEPOINT before_update', 'mysql') === 'ROLLBACK TO');
  check('SQL Server 分号事务脚本可按边界逐句同步状态',
    splitSql('BEGIN TRAN; UPDATE t SET x = 1; COMMIT;', 'mssql').length === 3,
    splitSql('BEGIN TRAN; UPDATE t SET x = 1; COMMIT;', 'mssql'));
  check('MSSQL/SQLite 会话污染语句识别', unsafeSessionMutationKind('SET NOCOUNT ON', 'mssql') === 'SET NOCOUNT'
    && unsafeSessionMutationKind('SELECT 1; SET NOCOUNT ON', 'mssql') === 'SET NOCOUNT'
    && unsafeSessionMutationKind('DECLARE @x int; SET XACT_ABORT ON', 'mssql') === 'SET XACT_ABORT'
    && unsafeSessionMutationKind('SELECT 1; SET CONTEXT_INFO 0x01', 'mssql') === 'SET CONTEXT_INFO'
    && unsafeSessionMutationKind('SET FMTONLY ON', 'mssql') === 'SET FMTONLY'
    && unsafeSessionMutationKind('SET OFFSETS SELECT ON', 'mssql') === 'SET OFFSETS'
    && !unsafeSessionMutationKind('DECLARE @x int; SET @x = 1; SELECT @x', 'mssql')
    && !unsafeSessionMutationKind('UPDATE t SET x = 1 WHERE id = 2', 'mssql')
    && unsafeSessionMutationKind('CREATE TABLE #tmp(id int)', 'mssql') === '临时对象'
    && unsafeSessionMutationKind('PRAGMA foreign_keys = OFF', 'sqlite') === 'PRAGMA 设置');
  const mysqlRunAll = splitSql(mysqlNestedRoutineSql, 'mysql');
  check('MySQL 运行全部拆分过程与后续 SQL', mysqlRunAll.length === 2
    && /^CREATE PROCEDURE/.test(mysqlRunAll[0]) && mysqlRunAll[1] === 'SELECT 3', mysqlRunAll);

  // ---- 查询结果上限下推 ----
  const limSqlite = limitQueryRows('SELECT * FROM t ORDER BY id; -- tail', 'sqlite', 2);
  check('limit sqlite 下推探针', limSqlite.applied && /LIMIT 3\s*;\s*-- tail$/.test(limSqlite.sql), limSqlite);
  const limCte = limitQueryRows('WITH x AS (SELECT 1 AS id) SELECT * FROM x', 'postgres', 5);
  check('limit CTE 下推探针', limCte.applied && /LIMIT 6$/.test(limCte.sql), limCte);
  const limMssql = limitQueryRows('SELECT DISTINCT id FROM t ORDER BY id', 'mssql', 10);
  check('limit mssql TOP 位置', limMssql.applied && /^SELECT DISTINCT TOP \(11\)/.test(limMssql.sql), limMssql);
  const cappedExisting = limitQueryRows('SELECT * FROM t LIMIT 4000000', 'mysql', 2);
  check('limit 收紧巨大已有上限', cappedExisting.applied && /LIMIT 3$/.test(cappedExisting.sql), cappedExisting);
  const fetchIdentifier = limitQueryRows('SELECT fetch, 4000000 AS marker FROM t', 'sqlite', 2);
  check('limit 不把 SQLite fetch 列误判为子句', fetchIdentifier.applied
    && /fetch, 4000000 AS marker/.test(fetchIdentifier.sql) && /LIMIT 3$/.test(fetchIdentifier.sql), fetchIdentifier);
  const cappedFetch = limitQueryRows('SELECT * FROM t OFFSET 0 ROWS FETCH NEXT 4000000 ROWS ONLY', 'mssql', 2);
  check('limit 收紧合法 FETCH 子句', cappedFetch.applied && /FETCH NEXT 3 ROWS ONLY$/.test(cappedFetch.sql), cappedFetch);
  const pgOffset = limitQueryRows('SELECT * FROM t ORDER BY id OFFSET 10', 'postgres', 2);
  check('limit PostgreSQL OFFSET 前注入', pgOffset.applied && /LIMIT 3 OFFSET 10$/.test(pgOffset.sql), pgOffset);
  const msOffset = limitQueryRows('SELECT * FROM t ORDER BY id OFFSET 10 ROWS', 'mssql', 2);
  check('limit MSSQL OFFSET 后追加 FETCH', msOffset.applied && /OFFSET 10 ROWS FETCH NEXT 3 ROWS ONLY$/.test(msOffset.sql), msOffset);
  const msOffsetOption = limitQueryRows('SELECT * FROM t ORDER BY id OFFSET 10 ROWS OPTION (RECOMPILE)', 'mssql', 2);
  check('limit MSSQL FETCH 插在 OPTION 前且保留空格', msOffsetOption.applied
    && /OFFSET 10 ROWS\s+FETCH NEXT 3 ROWS ONLY OPTION \(RECOMPILE\)$/.test(msOffsetOption.sql), msOffsetOption);
  check('limit Oracle 未探测能力时保守不改写', !limitQueryRows('SELECT * FROM t ORDER BY id', 'oracle', 2).applied);
  const oracle12Limit = limitQueryRows('SELECT * FROM t ORDER BY id', 'oracle12', 2);
  check('limit Oracle 探测支持后使用 FETCH FIRST', oracle12Limit.applied
    && /FETCH FIRST 3 ROWS ONLY$/.test(oracle12Limit.sql), oracle12Limit);
  const sqliteBacktick = limitQueryRows('SELECT `foo LIMIT 4000000` FROM t', 'sqlite', 2);
  check('limit 不改写 SQLite 反引号标识符内容', sqliteBacktick.applied
    && /`foo LIMIT 4000000`/.test(sqliteBacktick.sql), sqliteBacktick);
  const sqliteBracket = limitQueryRows('SELECT [foo LIMIT 4000000] FROM t', 'sqlite', 2);
  check('limit 不改写 SQLite 方括号标识符内容', sqliteBracket.applied
    && /\[foo LIMIT 4000000\]/.test(sqliteBracket.sql), sqliteBracket);
  const clickhouseHeredoc = limitQueryRows('SELECT $$hello LIMIT 4000000$$ AS s', 'clickhouse', 2);
  check('limit 不改写 ClickHouse heredoc 内容', clickhouseHeredoc.applied
    && /\$\$hello LIMIT 4000000\$\$/.test(clickhouseHeredoc.sql), clickhouseHeredoc);
  const mysqlDoubleMinus = limitQueryRows('SELECT * FROM t WHERE x = 5--2', 'mysql', 2);
  check('limit 正确区分 MySQL 双减号与注释', mysqlDoubleMinus.applied
    && /x = 5--2 LIMIT 3$/.test(mysqlDoubleMinus.sql), mysqlDoubleMinus);
  const clickhouseSettings = limitQueryRows('SELECT number FROM numbers(10) SETTINGS max_threads = 1', 'clickhouse', 2);
  check('limit ClickHouse 插在 SETTINGS 前', clickhouseSettings.applied
    && /LIMIT 3 SETTINGS max_threads = 1$/.test(clickhouseSettings.sql), clickhouseSettings);
  const clickhouseFormat = limitQueryRows('SELECT number FROM numbers(10) FORMAT JSONEachRow', 'clickhouse', 2);
  check('limit ClickHouse 插在 FORMAT 前', clickhouseFormat.applied
    && /LIMIT 3 FORMAT JSONEachRow$/.test(clickhouseFormat.sql), clickhouseFormat);
  const clickhouseLimitBy = limitQueryRows('SELECT number % 2 AS k, number FROM numbers(10) LIMIT 5 BY k', 'clickhouse', 2);
  check('limit ClickHouse LIMIT BY 后补全局上限', clickhouseLimitBy.applied
    && /LIMIT 5 BY k LIMIT 3$/.test(clickhouseLimitBy.sql), clickhouseLimitBy);
  check('limit 不改写 MySQL 可执行注释', !limitQueryRows('SELECT * FROM t /*!50000 LIMIT 4000000 */', 'mysql', 2).applied);
  check('limit 不改写 MariaDB 可执行注释', !limitQueryRows('SELECT * FROM t /*M! LIMIT 4000000 */', 'mysql', 2).applied);
  check('limit 不误标 MSSQL 无分号多语句批次', !limitQueryRows('SELECT * FROM t\nSELECT * FROM u', 'mssql', 2).applied);
  check('limit 保留较小已有上限', !limitQueryRows('SELECT * FROM t LIMIT 2', 'mysql', 2).applied);
  const sqliteUnlimited = limitQueryRows('SELECT * FROM t LIMIT -1 OFFSET 5', 'sqlite', 2);
  check('limit 收紧 SQLite LIMIT -1', sqliteUnlimited.applied && /LIMIT 3 OFFSET 5$/.test(sqliteUnlimited.sql), sqliteUnlimited);
  const sqliteNegativeOffset = limitQueryRows('SELECT * FROM t LIMIT -1, 2', 'sqlite', 2);
  check('limit 不把 SQLite 逗号语法负 offset 当 count', !sqliteNegativeOffset.applied
    && /LIMIT -1, 2$/.test(sqliteNegativeOffset.sql), sqliteNegativeOffset);
  const sqliteCommaUnlimited = limitQueryRows('SELECT * FROM t LIMIT 2, -1', 'sqlite', 2);
  check('limit 收紧 SQLite 逗号语法无限 count', sqliteCommaUnlimited.applied
    && /LIMIT 2, 3$/.test(sqliteCommaUnlimited.sql), sqliteCommaUnlimited);
  const pgNullLimit = limitQueryRows('SELECT * FROM t LIMIT NULL', 'postgres', 2);
  check('limit 收紧 PostgreSQL LIMIT NULL', pgNullLimit.applied && /LIMIT 3$/.test(pgNullLimit.sql), pgNullLimit);
  check('limit 不改写写语句', !limitQueryRows('UPDATE t SET a = 1', 'postgres', 2).applied);
  check('statementKind 跳过注释', statementKind('/* head */\nSELECT 1', 'clickhouse') === 'SELECT');
  check('statementKind 识别 CTE 主查询', statementKind('WITH x AS (SELECT 1) SELECT * FROM x', 'clickhouse') === 'SELECT');
  check('statementKind 识别 WITH INSERT', statementKind('WITH 1 AS x INSERT INTO t SELECT x', 'clickhouse') === 'INSERT');
  check('可编辑查询识别简单单表 SELECT *',
    simpleEditableSelect('SELECT * FROM users WHERE id = 1 ORDER BY id', 'sqlite').parts[0] === 'users');
  check('可编辑查询识别限定表和别名',
    simpleEditableSelect('SELECT u.* FROM "tenant"."users" AS u WHERE u.id = 1', 'postgres').alias === 'u');
  check('可编辑查询识别直接字段列表',
    simpleEditableSelect('SELECT u.id, u.name FROM users u WHERE u.id = 1', 'postgres').columns.join(',') === 'id,name');
  check('可编辑查询拒绝 JOIN',
    simpleEditableSelect('SELECT * FROM users u JOIN roles r ON r.id = u.role_id', 'postgres') === null);
  check('可编辑查询拒绝表达式和别名列',
    simpleEditableSelect('SELECT COUNT(*) FROM users', 'postgres') === null
      && simpleEditableSelect('SELECT id AS user_id FROM users', 'postgres') === null);
  check('clickhouse 识别末尾 FORMAT 子句', hasClickHouseFormatClause('SELECT 1 FORMAT JSONEachRow'));
  check('clickhouse 不把 format 列误判为子句', !hasClickHouseFormatClause('SELECT format FROM t'));
  check('sqlite 识别外部文件 SQL', hasSQLiteExternalFileClause("ATTACH DATABASE 'other.db' AS other")
    && hasSQLiteExternalFileClause("VACUUM main INTO 'copy.db'")
    && !hasSQLiteExternalFileClause("SELECT 'ATTACH DATABASE x'"));
  const wasmMemory = new SQLiteAdapter({ file: ':memory:' });
  let wasmMemoryExported = false;
  wasmMemory.file = ':memory:';
  wasmMemory.mode = 'wasm';
  wasmMemory._dirty = true;
  wasmMemory.db = { export() { wasmMemoryExported = true; return new Uint8Array(); } };
  wasmMemory._flush();
  check('sqlite WASM :memory: 不尝试写入本地文件', !wasmMemoryExported);

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
  check('mysql 连接归池前启用 COM_RESET_CONNECTION', /resetOnRelease:\s*true/.test(
    fs.readFileSync(path.join(__dirname, 'db', 'mysql.js'), 'utf8')));
  check('mysql 查询事务使用 AUTOCOMMIT=0 并在归池前恢复',
    my._transactionBeginSqls()[0] === 'SET AUTOCOMMIT = 0'
    && my._transactionCleanupSqls('commit')[0] === 'SET AUTOCOMMIT = 1');
  let mysqlDdlAllowedInTransaction = true;
  try { my._assertTransactionSql(['ALTER TABLE t ADD COLUMN x INT']); }
  catch (e) { mysqlDdlAllowedInTransaction = false; }
  check('mysql 显式事务按原生规则允许 DDL', mysqlDdlAllowedInTransaction);
  let mysqlImplicitCommitDenied = false;
  try { my._assertTransactionSql(['LOCK TABLES t WRITE']); } catch (e) { mysqlImplicitCommitDenied = /隐式提交/.test(e.message); }
  check('mysql 手动事务拒绝隐式提交管理语句', mysqlImplicitCommitDenied);
  const mysqlUnsafeTransactionSql = [
    '/*!40101 SET autocommit=1 */',
    '/*! COMMIT */',
    '/*M!100100 ALTER TABLE t ADD COLUMN x INT */',
    'RESET MASTER',
    'STOP REPLICA',
    'CHANGE REPLICATION SOURCE TO SOURCE_HOST = \'127.0.0.1\'',
    'FLUSH TABLES',
    'CACHE INDEX t IN cache1',
    'LOAD INDEX INTO CACHE t',
    'CHECK TABLE t',
    "SET PASSWORD = 'secret'",
  ];
  check('mysql 手动事务拒绝可执行注释和隐式提交管理语句', mysqlUnsafeTransactionSql.every((sql) => {
    try { my._assertTransactionSql([sql]); return false; } catch (e) { return /可执行注释|隐式提交/.test(e.message); }
  }), mysqlUnsafeTransactionSql);
  let unboundTransactionBoundaryDenied = false;
  try { my._assertQueryPageSql(['BEGIN']); }
  catch (e) { unboundTransactionBoundaryDenied = /必须通过查询标签会话/.test(e.message); }
  check('未绑定查询标签的底层入口仍拒绝事务边界', unboundTransactionBoundaryDenied);
  const { MSSQLAdapter: MSSQLGuardAdapter } = require('./db/mssql');
  const mssqlGuard = new MSSQLGuardAdapter({});
  let mssqlBlockAllowed = true;
  try { mssqlGuard._assertTransactionSql(['BEGIN\n SELECT 1;\nEND']); } catch (e) { mssqlBlockAllowed = false; }
  let mssqlBeginTransactionAllowed = true;
  try { mssqlGuard._assertTransactionSql(['BEGIN TRANSACTION']); }
  catch (e) { mssqlBeginTransactionAllowed = false; }
  check('MSSQL 固定事务会话允许 BEGIN 控制块和事务控制语句',
    mssqlBlockAllowed && mssqlBeginTransactionAllowed);
  check('MSSQL 未分隔事务批次不会被误当成单独 BEGIN',
    mssqlGuard._queryTransactionAction('BEGIN TRAN\nUPDATE t SET x = 1') === 'ambiguous-batch');
  const mysqlAdvancedColumnMeta = new MySQLAdapter({});
  mysqlAdvancedColumnMeta._q = async (sql) => {
    if (/SHOW FULL COLUMNS/i.test(sql)) return [{
      Field: 'updated_at', Type: 'timestamp', Collation: null, Null: 'NO', Key: '', Default: 'CURRENT_TIMESTAMP',
      Extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP', Comment: '',
    }, {
      Field: 'name', Type: 'varchar(40)', Collation: 'utf8mb4_bin', Null: 'YES', Key: '', Default: null,
      Extra: '', Comment: '',
    }];
    if (/SHOW INDEX/i.test(sql)) return [];
    if (/SHOW CREATE TABLE/i.test(sql)) return [{ 'Create Table': 'CREATE TABLE `t` (...)' }];
    if (/information_schema\.TABLES/i.test(sql)) return [{ tc: '' }];
    return [];
  };
  const mysqlAdvancedColumns = await mysqlAdvancedColumnMeta.tableInfo('db1', null, 't');
  check('MySQL ON UPDATE 等高级栏位只读且保留字符集元数据', mysqlAdvancedColumns.columns[0].editSafe === false
    && mysqlAdvancedColumns.columns[1].charset === 'utf8mb4'
    && mysqlAdvancedColumns.columns[1].collation === 'utf8mb4_bin', mysqlAdvancedColumns.columns);

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
  let chQueryOptions = null;
  ch.defaultDb = 'default';
  ch.clients = new Map([['default', {
    query: async (options) => {
      chQueryOptions = options;
      return { json: async () => ({ meta: [], data: [] }) };
    },
  }]]);
  await ch._run(null, 'SELECT 1');
  check('ch JSON 精确数值/非有限浮点使用引号', chQueryOptions
    && chQueryOptions.clickhouse_settings.output_format_json_quote_64bit_integers === 1
    && chQueryOptions.clickhouse_settings.output_format_json_quote_decimals === 1
    && chQueryOptions.clickhouse_settings.output_format_json_quote_denormals === 1, chQueryOptions);

  // ---- OceanBase（MySQL 兼容模式，继承 MySQL 适配器） ----
  const { OceanBaseAdapter } = require('./db/oceanbase');
  const { createAdapter, shutdownAdapter } = require('./db');
  const ob = new OceanBaseAdapter({ host: 'x', user: 'root@sys' });
  check('ob 注册', createAdapter({ type: 'oceanbase', host: 'x' }) instanceof OceanBaseAdapter);
  check('ob 方言继承', ob.dialect === 'mysql');

  const shutdownOrder = [];
  const neverSettles = new Promise(() => {});
  const shutdownStarted = Date.now();
  await shutdownAdapter({
    cancel: async () => { shutdownOrder.push('cancel'); },
    closeTransactions: async () => { shutdownOrder.push('transactions'); return neverSettles; },
    close: async () => { shutdownOrder.push('close'); return neverSettles; },
  }, { cancelMs: 10, transactionsMs: 20, closeMs: 20 });
  check('连接关闭先取消活动查询且等待有界', shutdownOrder.join(',') === 'cancel,transactions,close'
    && Date.now() - shutdownStarted < 1000, { shutdownOrder, ms: Date.now() - shutdownStarted });
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
  const pgTypes = require('pg').types;
  const exactJson = '{"id":9007199254740993,"amount":1234567890.123456789}';
  check('PG JSON parser 保留高精度原文', pgTypes.getTypeParser(114, 'text')(exactJson) === exactJson
    && pgTypes.getTypeParser(3802, 'text')(exactJson) === exactJson);
  const exactNumericArray = pgTypes.getTypeParser(1231, 'text')('{12345678901234567890.123456789,-0.000000000000000001}');
  check('PG numeric[] parser 保留元素精度', exactNumericArray[0] === '12345678901234567890.123456789'
    && exactNumericArray[1] === '-0.000000000000000001', exactNumericArray);
  const exactTimestampArray = pgTypes.getTypeParser(1115, 'text')('{"2024-01-02 03:04:05.123456"}');
  check('PG timestamp[] parser 不转换 Date', exactTimestampArray[0] === '2024-01-02 03:04:05.123456', exactTimestampArray);
  const pgMetadata = new PostgresAdapter({});
  pgMetadata._q = async (_db, sql) => {
    if (sql.includes("con.contype = 'f'")) return [{
      name: 'fk_unvalidated', col: 'parent_id', refschema: 'public', reftab: 'parent', refcol: 'id', ord: 1,
      definition: 'FOREIGN KEY (parent_id) REFERENCES parent(id) NOT VALID',
      validated: false, deferrable: false, deferred: false, match_type: 's', is_local: true,
      inherited_count: 0, parent_constraint_id: 0, on_update: 'NO ACTION', on_delete: 'NO ACTION',
    }];
    return [{
      name: 'uq_deferred', kind: 'u', expression: '', definition: 'UNIQUE (id) DEFERRABLE',
      validated: true, deferrable: true, deferred: false, no_inherit: false, is_local: true,
      inherited_count: 0, parent_constraint_id: 0, col: 'id', ord: 1, index_name: 'uq_deferred',
    }];
  };
  const pgUnsafeFk = await pgMetadata.listForeignKeys('db1', 'public', 'child');
  const pgUnsafeConstraint = await pgMetadata.listConstraints('db1', 'public', 'child');
  check('PG 未验证/可延迟约束禁止无损重建', pgUnsafeFk[0].rebuildSafe === false
    && pgUnsafeConstraint[0].rebuildSafe === false, { pgUnsafeFk, pgUnsafeConstraint });
  const pgCatalogQueries = [];
  pgMetadata._q = async (_db, sql) => {
    pgCatalogQueries.push(sql);
    return [];
  };
  await pgMetadata.tableInfo('db1', 'public', 't1');
  const pgIndexCatalogSql = pgCatalogQueries.find((sql) => sql.includes('FROM pg_index ix')) || '';
  check('PG 旧版本目录不直接引用 PG11 indnkeyatts 栏位', pgIndexCatalogSql.includes("row_to_json(ix)->>'indnkeyatts'")
    && !/\bix\.indnkeyatts\b/.test(pgIndexCatalogSql), pgIndexCatalogSql);
  const pgEstimation = new PostgresAdapter({});
  pgEstimation._q = async (_db, sql) => {
    if (sql.includes("relkind IN ('r', 'p')")) {
      pgEstimation._lastListSql = sql;
      return [
        { name: 't_analyzed', rows: '42', comment: '' },
        { name: 't_never_analyzed', rows: null, comment: '' },
        { name: 't_bulk_loaded', rows: null, comment: '' },
      ];
    }
    return [];
  };
  const pgObjects = await pgEstimation.listObjects('db1', 'public');
  check('PG 未分析表行数显示未知而非 0', pgObjects.tables[0].rows === 42 && pgObjects.tables[1].rows === null,
    pgObjects.tables);
  check('PG 行数估算联查 pg_stat_user_tables', /pg_stat_user_tables/.test(pgEstimation._lastListSql || '')
    && /n_tup_ins/.test(pgEstimation._lastListSql || ''), pgEstimation._lastListSql);
  const pgRowId = new PostgresAdapter({});
  pgRowId._q = async (_db, _sql, params) => [{ relkind: params[1] === 'part_tbl' ? 'p' : 'r' }];
  check('PG 无主键普通表回退 ctid 而分区表不回退',
    (await pgRowId.rowIdFor('db1', 'public', 'plain_tbl')) === 'ctid'
    && (await pgRowId.rowIdFor('db1', 'public', 'part_tbl')) === null);
  const rowIdAdapter = new (class extends require('./db/base').BaseAdapter {
    quoteIdent(n) { return '"' + n + '"'; }
    qualify(_db, schema, table) { return `"${schema}"."${table}"`; }
    async tableInfo() { return { columns: [{ name: 'a', type: 'text' }, { name: 'b', type: 'int4' }], pk: [] }; }
    async rowIdFor() { return 'ctid'; }
    pageSql(sql) { return sql; }
    async exec(_db, sql) {
      if (sql.includes('COUNT(*)')) return { columns: [{ name: 'count' }], rows: [[2]] };
      return { columns: [{ name: 'a' }, { name: 'b' }, { name: 'ctid' }], rows: [['x', 1, '(0,1)'], ['y', 2, '(0,2)']] };
    }
  })({});
  const rowIdData = await rowIdAdapter.tableData('db1', { schema: 's', table: 't', page: 1, pageSize: 10 });
  check('无主键表回退行标识后仍可编辑且不显示标识列',
    rowIdData.pk.length === 1 && rowIdData.pk[0] === 'ctid' && rowIdData.rowIdColumn === 'ctid'
    && rowIdData.columns.length === 2 && rowIdData.rows.every((r) => r.length === 2)
    && rowIdData.rowIds.join(',') === '(0,1),(0,2)', rowIdData);
  const mysqlObjects = new MySQLAdapter({});
  mysqlObjects._q = async (sql) => {
    if (String(sql).startsWith('SHOW FULL TABLES')) {
      return [{ Tables_in_db: 't_stale', Table_type: 'BASE TABLE' }, { Tables_in_db: 't_ok', Table_type: 'BASE TABLE' }];
    }
    if (String(sql).includes('information_schema.TABLES')) {
      mysqlObjects._metaSql = sql;
      return [
        { tn: 't_stale', trows: 0, tcomment: '', tengine: 'InnoDB', dlen: 16384, ilen: 0 },
        { tn: 't_ok', trows: 5, tcomment: '', tengine: 'InnoDB', dlen: 16384, ilen: 0 },
      ];
    }
    return [];
  };
  const mysqlObjs = await mysqlObjects.listObjects('db1');
  const mysqlStale = mysqlObjs.tables.find((t) => t.name === 't_stale');
  const mysqlOk = mysqlObjs.tables.find((t) => t.name === 't_ok');
  check('MySQL InnoDB 估算 0 但有数据页时显示未知', mysqlStale && mysqlStale.rows === null && mysqlOk && mysqlOk.rows === 5,
    mysqlObjs.tables);
  check('MySQL 行数估算读取 DATA_LENGTH', /DATA_LENGTH/.test(mysqlObjects._metaSql || ''), mysqlObjects._metaSql);
  const mssqlObjects = new (require('./db/mssql').MSSQLAdapter)({});
  mssqlObjects._q = async (_db, sql) => {
    if (String(sql).includes('sys.tables')) {
      mssqlObjects._listSql = sql;
      return [
        { sch: 'dbo', name: 't_stale', rowcnt: null, comment: '' },
        { sch: 'dbo', name: 't_ok', rowcnt: 12, comment: '' },
      ];
    }
    return [];
  };
  const mssqlObjs = await mssqlObjects.listObjects('db1');
  check('SQL Server 行数未知不为 0', mssqlObjs.tables[0].rows === null && mssqlObjs.tables[1].rows === 12, mssqlObjs.tables);
  check('SQL Server 行数估算不再 ISNULL 归零', !/ISNULL\(SUM\(p\.rows\),\s*0\)/.test(mssqlObjects._listSql || '')
    && /data_pages/.test(mssqlObjects._listSql || ''), mssqlObjects._listSql);
  const sqliteRowId = new SQLiteAdapter({});
  sqliteRowId._execRaw = (sql) => ({
    rows: [/norowid/i.test(String(sql))
      ? ['CREATE TABLE norowid (a INT) WITHOUT ROWID']
      : ['CREATE TABLE plain (a INT)']],
  });
  check('SQLite 无主键普通表回退 rowid', (await sqliteRowId.rowIdFor(null, null, 'plain')) === 'rowid'
    && (await sqliteRowId.rowIdFor(null, null, 'norowid')) === null);
  check('SQLite rowid 伪列不加引号', sqliteRowId.quoteRowId('rowid') === 'rowid'
    && sqliteRowId.quoteRowId('name') === sqliteRowId.quoteIdent('name'));
  check('obo 无主键表回退 ROWID', (await obo.rowIdFor('SCOTT', null, 'EMP')) === 'ROWID');
  const oboObjects = new OBOracleAdapter({});
  oboObjects._q = async (sql) => (String(sql).includes('all_tables') ? [
    { TABLE_NAME: 'T_STALE', NUM_ROWS: 0, BLOCKS: 8, COMMENTS: '' },
    { TABLE_NAME: 'T_OK', NUM_ROWS: 3, BLOCKS: 1, COMMENTS: '' },
  ] : []);
  const oboObjs = await oboObjects.listObjects('SCOTT');
  check('Oracle 估算 0 但有 blocks 时显示未知', oboObjs.tables[0].rows === null && oboObjs.tables[1].rows === 3,
    oboObjs.tables);
  const { EventEmitter } = require('events');
  const pgSessionAdapter = new PostgresAdapter({});
  const pgSessionClient = new EventEmitter();
  const pgSessionQueries = [];
  let pgReleasedWith = null;
  pgSessionClient.query = async (sql) => { pgSessionQueries.push(typeof sql === 'string' ? sql : sql.text); return { rows: [] }; };
  pgSessionClient.release = (error) => { pgReleasedWith = error || false; };
  pgSessionAdapter._getPool = () => ({ connect: async () => pgSessionClient });
  await pgSessionAdapter.withSession('db1', async () => true);
  check('PG 普通会话归池前执行 DISCARD ALL', pgSessionQueries.includes('DISCARD ALL') && pgReleasedWith === false,
    { pgSessionQueries, pgReleasedWith });
  const pgSchemaAdapter = new PostgresAdapter({});
  const pgSchemaClient = new EventEmitter();
  const pgSchemaQueries = [];
  pgSchemaClient.query = async (sql, params) => {
    const text = typeof sql === 'string' ? sql : sql.text;
    pgSchemaQueries.push({ text, params });
    if (text.includes('FROM pg_namespace')) return { rows: [{ ok: 1 }] };
    return { rows: [], fields: [], rowCount: 0, command: 'OK' };
  };
  pgSchemaClient.release = () => {};
  pgSchemaAdapter._getPool = () => ({ connect: async () => pgSchemaClient });
  await pgSchemaAdapter.withSession('db1', async () => true, { schema: 'tenant "one' });
  check('PG 查询执行会话应用并转义选中的 search_path',
    pgSchemaQueries.some((item) => item.text === 'SET search_path TO "tenant ""one"')
    && pgSchemaQueries.some((item) => item.text.includes('FROM pg_namespace')
      && item.params && item.params[0] === 'tenant "one'), pgSchemaQueries);
  const pgExplainAdapter = new PostgresAdapter({});
  const pgExplainClient = new EventEmitter();
  const pgExplainQueries = [];
  pgExplainClient.query = async (sql, params) => {
    const text = typeof sql === 'string' ? sql : sql.text;
    pgExplainQueries.push({ text, params });
    if (text.includes('FROM pg_namespace')) return { rows: [{ ok: 1 }] };
    if (text.startsWith('EXPLAIN ')) {
      return {
        fields: [{ name: 'QUERY PLAN' }],
        rows: [[[{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 2, 'Total Cost': 3 } }]]],
        rowCount: 1,
        command: 'EXPLAIN',
      };
    }
    return { rows: [], fields: [], rowCount: 0, command: 'OK' };
  };
  pgExplainClient.release = () => {};
  pgExplainAdapter._getPool = () => ({ connect: async () => pgExplainClient });
  const pgExplain = await pgExplainAdapter.explainPlan('db1', 'SELECT * FROM orders', { schema: 'tenant' });
  check('PG 执行计划沿用查询页选中的模式', pgExplain.format === 'tree'
    && pgExplain.root && pgExplain.root.title === 'Seq Scan'
    && pgExplainQueries.some((item) => item.text === 'SET search_path TO "tenant"'), { pgExplain, pgExplainQueries });
  const pgCleanupAdapter = new PostgresAdapter({});
  const pgCleanupClient = new EventEmitter();
  let pgCleanupReleasedWith = null;
  let pgCleanupReported = null;
  pgCleanupClient.query = async (sql) => {
    const text = typeof sql === 'string' ? sql : sql.text;
    if (text === 'DISCARD ALL') throw new Error('discard failed');
    return { rows: [], fields: [], rowCount: 0, command: String(text).split(/\s+/)[0] || 'OK' };
  };
  pgCleanupClient.release = (error) => { pgCleanupReleasedWith = error || false; };
  pgCleanupAdapter._getPool = () => ({ connect: async () => pgCleanupClient });
  const oldWarn = console.warn;
  console.warn = () => {};
  let pgCleanupResult;
  try {
    await pgCleanupAdapter.beginTransaction('pg-cleanup', 'db1');
    pgCleanupResult = await pgCleanupAdapter.commitTransaction('pg-cleanup');
    await pgCleanupAdapter.withSession('db1', async () => 'query-succeeded', {
      onCleanupError: (error) => { pgCleanupReported = error; },
    });
  } finally {
    console.warn = oldWarn;
  }
  check('PG COMMIT 成功后 DISCARD 失败不伪报事务失败', pgCleanupResult
    && /事务已提交/.test(pgCleanupResult.warning || '')
    && pgCleanupReleasedWith && pgCleanupReported && /discard failed/.test(pgCleanupReported.message),
  { pgCleanupResult, pgCleanupReleasedWith: pgCleanupReleasedWith && pgCleanupReleasedWith.message });
  const pgLostAdapter = new PostgresAdapter({});
  const pgLostClient = new EventEmitter();
  let pgLostReleaseError = null;
  pgLostClient.query = async () => ({ rows: [] });
  pgLostClient.release = (error) => { pgLostReleaseError = error; };
  pgLostAdapter._getPool = () => ({ connect: async () => pgLostClient });
  const pgLostPromise = pgLostAdapter.withSession('db1', async () => new Promise(() => {}));
  setImmediate(() => pgLostClient.emit('error', new Error('socket lost')));
  let pgLostCaught = false;
  try { await pgLostPromise; } catch (e) { pgLostCaught = /socket lost/.test(e.message); }
  check('PG 固定会话断线不会触发未监听 error 且会销毁会话', pgLostCaught
    && pgLostReleaseError && pgLostClient.listenerCount('error') === 0, pgLostReleaseError && pgLostReleaseError.message);
  const { MSSQLAdapter } = require('./db/mssql');
  const mssqlMetadata = new MSSQLAdapter({});
  mssqlMetadata._q = async (_db, sql) => (sql.includes('sys.key_constraints') ? [{
    name: 'uq_t_id', index_name: 'uq_t_id', col: 'id', ord: 1,
    type_desc: 'NONCLUSTERED', has_filter: false, fill_factor: 0, is_disabled: false,
  }] : []);
  const mssqlUnique = await mssqlMetadata.listConstraints('db1', 'dbo', 't1');
  check('SQL Server 既有 UNIQUE 因物理属性未知而只读', mssqlUnique[0].rebuildSafe === false, mssqlUnique);

  const strictMysqlMeta = new MySQLAdapter({});
  strictMysqlMeta.serverVersion = 'MySQL 8.0.36';
  strictMysqlMeta._q = async (sql) => {
    if (sql.includes("CONSTRAINT_TYPE = 'UNIQUE'")) return [];
    throw new Error('catalog denied');
  };
  let mysqlConstraintMetadataBlocked = false;
  try { await strictMysqlMeta.listConstraints('db1', null, 't1'); }
  catch (e) { mysqlConstraintMetadataBlocked = /禁止.*设计器|读取 CHECK 约束失败/.test(e.message); }
  check('MySQL 约束元数据不完整时 fail closed', mysqlConstraintMetadataBlocked);
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
  check('ddl PG 删除索引使用目标 Schema 限定名', a2.sqls.some((s) => s === 'DROP INDEX "public"."idx_name"'), a2.sqls);

  const mysqlRenameOriginal = JSON.parse(JSON.stringify(orig));
  mysqlRenameOriginal.indexes.forEach((index) => { index.origName = index.name; });
  const mysqlRenameOnly = JSON.parse(JSON.stringify(mysqlRenameOriginal));
  mysqlRenameOnly.table = 't1_renamed';
  const mysqlRenameSql = ddl.buildAlterTable(my, 'db1', null, mysqlRenameOriginal, mysqlRenameOnly);
  check('ddl MySQL 纯表重命名可执行且完整限定目标', mysqlRenameSql.sqls.length === 1
    && mysqlRenameSql.sqls[0] === 'RENAME TABLE `db1`.`t1` TO `db1`.`t1_renamed`', mysqlRenameSql.sqls);
  const mysqlRenameMixed = JSON.parse(JSON.stringify(mysqlRenameOnly));
  mysqlRenameMixed.columns.find((column) => column.name === 'amount').length = '18';
  let mysqlRenameMixedBlocked = false;
  try { ddl.buildAlterTable(my, 'db1', null, mysqlRenameOriginal, mysqlRenameMixed); }
  catch (e) { mysqlRenameMixedBlocked = /表重命名请单独保存/.test(e.message); }
  check('ddl MySQL 表重命名与结构变更必须分两次保存', mysqlRenameMixedBlocked);

  const advancedColumnOrig = JSON.parse(JSON.stringify(orig));
  advancedColumnOrig.columns[1].editSafe = false;
  advancedColumnOrig.columns[1].editUnsafeReason = 'ON UPDATE / GENERATED';
  const advancedColumnChanged = JSON.parse(JSON.stringify(advancedColumnOrig));
  advancedColumnChanged.columns[1].comment = 'changed';
  let advancedColumnEditBlocked = false;
  try { ddl.buildAlterTable(my, 'db1', null, advancedColumnOrig, advancedColumnChanged); }
  catch (e) { advancedColumnEditBlocked = /无法无损保留|当前为只读/.test(e.message); }
  const advancedColumnDeleted = JSON.parse(JSON.stringify(advancedColumnOrig));
  advancedColumnDeleted.columns.splice(1, 1);
  let advancedColumnDeleteBlocked = false;
  try { ddl.buildAlterTable(my, 'db1', null, advancedColumnOrig, advancedColumnDeleted); }
  catch (e) { advancedColumnDeleteBlocked = /不能在设计器中删除/.test(e.message); }
  check('ddl 高级栏位属性在编辑和删除时均 fail closed', advancedColumnEditBlocked && advancedColumnDeleteBlocked);

  const collatedOrig = JSON.parse(JSON.stringify(orig));
  const collatedName = collatedOrig.columns.find((column) => column.name === 'name');
  collatedName.charset = 'utf8mb4';
  collatedName.collation = 'utf8mb4_bin';
  const collatedMod = JSON.parse(JSON.stringify(collatedOrig));
  collatedMod.columns.find((column) => column.name === 'name').comment = '保留排序规则';
  const collatedAlter = ddl.buildAlterTable(my, 'db1', null, collatedOrig, collatedMod);
  check('ddl MySQL CHANGE 栏位保留字符集与排序规则', collatedAlter.sqls.some((sql) => (
    sql.includes('CHARACTER SET utf8mb4 COLLATE utf8mb4_bin') && sql.includes("COMMENT '保留排序规则'")
  )), collatedAlter.sqls);

  const constrainedCreate = JSON.parse(JSON.stringify(model1));
  constrainedCreate.foreignKeys = [{
    name: 'fk_t1_owner', origName: null, columns: ['id'], refSchema: '', refTable: 'owners', refColumns: ['id'],
    onUpdate: 'CASCADE', onDelete: 'SET NULL',
  }];
  constrainedCreate.constraints = [
    { kind: 'unique', name: 'uq_t1_name', origName: null, columns: ['name'], expression: '' },
    { kind: 'check', name: 'ck_t1_amount', origName: null, columns: [], expression: 'amount >= 0' },
  ];
  const constrainedMysql = ddl.buildCreateTable(my, 'db1', null, constrainedCreate);
  check('ddl mysql 创建外键动作', constrainedMysql.sqls[0].includes('CONSTRAINT `fk_t1_owner` FOREIGN KEY (`id`)')
    && constrainedMysql.sqls[0].includes('ON DELETE SET NULL ON UPDATE CASCADE'), constrainedMysql.sqls[0]);
  check('ddl mysql 创建 UNIQUE/CHECK 约束', constrainedMysql.sqls[0].includes('CONSTRAINT `uq_t1_name` UNIQUE (`name`)')
    && constrainedMysql.sqls[0].includes('CONSTRAINT `ck_t1_amount` CHECK (amount >= 0)'), constrainedMysql.sqls[0]);

  const constrainedOrig = JSON.parse(JSON.stringify(constrainedCreate));
  constrainedOrig.columns.forEach((c) => { c.origName = c.name; });
  constrainedOrig.indexes.forEach((ix) => { ix.origName = ix.name; });
  constrainedOrig.foreignKeys.forEach((fk) => { fk.origName = fk.name; });
  constrainedOrig.constraints.forEach((item) => { item.origName = item.name; });
  const inboundOrig = JSON.parse(JSON.stringify(constrainedOrig));
  inboundOrig._referencedBy = [{
    name: 'fk_external_t1', schema: 'sales', table: 'orders', columns: ['t1_id'], refColumns: ['id'],
  }];
  const inboundTypeChange = JSON.parse(JSON.stringify(inboundOrig));
  inboundTypeChange.columns.find((column) => column.name === 'id').type = 'bigint';
  const inboundRename = JSON.parse(JSON.stringify(inboundOrig));
  inboundRename.columns.find((column) => column.name === 'id').name = 'new_id';
  const inboundDelete = JSON.parse(JSON.stringify(inboundOrig));
  inboundDelete.columns = inboundDelete.columns.filter((column) => column.name !== 'id');
  const inboundErrors = [inboundTypeChange, inboundRename, inboundDelete].map((next) => {
    try { ddl.buildAlterTable(my, 'db1', null, inboundOrig, next); return ''; }
    catch (e) { return e.message; }
  });
  check('ddl 入站外键阻止被引用栏位改类型/改名/删除', inboundErrors.every((message) => /外部表|入站外键/.test(message)), inboundErrors);
  const inboundPkChange = JSON.parse(JSON.stringify(inboundOrig));
  inboundPkChange.columns.find((column) => column.name === 'id').pk = false;
  let inboundPkBlocked = false;
  try { ddl.buildAlterTable(my, 'db1', null, inboundOrig, inboundPkChange); }
  catch (e) { inboundPkBlocked = /主键正被其他表外键引用/.test(e.message); }
  check('ddl 入站外键阻止删除被引用主键', inboundPkBlocked);
  const constrainedMod = JSON.parse(JSON.stringify(constrainedOrig));
  constrainedMod.foreignKeys[0].onDelete = 'CASCADE';
  constrainedMod.constraints = [
    { ...constrainedMod.constraints[1], expression: 'amount >= 1' },
    { kind: 'unique', name: 'uq_t1_amount', origName: null, columns: ['amount'], expression: '' },
  ];
  const constrainedAlter = ddl.buildAlterTable(my, 'db1', null, constrainedOrig, constrainedMod);
  check('ddl mysql 修改外键使用先删后建', constrainedAlter.sqls[0].includes('DROP FOREIGN KEY `fk_t1_owner`')
    && constrainedAlter.sqls.some((s) => s.includes('ADD CONSTRAINT `fk_t1_owner`') && s.includes('ON DELETE CASCADE')), constrainedAlter.sqls);
  check('ddl mysql 删除/修改 UNIQUE CHECK', constrainedAlter.sqls.some((s) => s.includes('DROP INDEX `uq_t1_name`'))
    && constrainedAlter.sqls.some((s) => s.includes('DROP CHECK `ck_t1_amount`'))
    && constrainedAlter.sqls.some((s) => s.includes('ADD CONSTRAINT `ck_t1_amount` CHECK (amount >= 1)'))
    && constrainedAlter.sqls.some((s) => s.includes('ADD CONSTRAINT `uq_t1_amount` UNIQUE (`amount`)')), constrainedAlter.sqls);
  my.serverVersion = 'MySQL 10.11.0-MariaDB';
  const constrainedMaria = ddl.buildAlterTable(my, 'db1', null, constrainedOrig, constrainedMod);
  check('ddl mariadb 删除 CHECK 使用 DROP CONSTRAINT', constrainedMaria.sqls.some((s) => s.includes('DROP CONSTRAINT `ck_t1_amount`')),
    constrainedMaria.sqls);
  my.serverVersion = '';

  // 未显式编辑约束时，受约束栏位改类型也必须先拆约束再修改栏位，最后只重建一次。
  const dependencyMod = JSON.parse(JSON.stringify(constrainedOrig));
  dependencyMod.columns.find((c) => c.name === 'id').type = 'bigint';
  dependencyMod.columns.find((c) => c.name === 'name').length = '160';
  dependencyMod.columns.find((c) => c.name === 'amount').length = '14';
  const mysqlDependency = ddl.buildAlterTable(my, 'db1', null, constrainedOrig, dependencyMod);
  const mysqlFkDrops = mysqlDependency.sqls.filter((s) => s.includes('DROP FOREIGN KEY `fk_t1_owner`'));
  const mysqlFkAdds = mysqlDependency.sqls.filter((s) => s.includes('ADD CONSTRAINT `fk_t1_owner`'));
  const mysqlUniqueDrops = mysqlDependency.sqls.filter((s) => s.includes('DROP INDEX `uq_t1_name`'));
  const mysqlUniqueAdds = mysqlDependency.sqls.filter((s) => s.includes('ADD CONSTRAINT `uq_t1_name`'));
  const mysqlCheckDrops = mysqlDependency.sqls.filter((s) => /DROP (?:CHECK|CONSTRAINT) `ck_t1_amount`/.test(s));
  const mysqlCheckAdds = mysqlDependency.sqls.filter((s) => s.includes('ADD CONSTRAINT `ck_t1_amount`'));
  const mysqlDependencySql = mysqlDependency.sqls.join('\n');
  check('ddl mysql 类型变更自动拆建依赖约束且不重复',
    mysqlFkDrops.length === 1 && mysqlFkAdds.length === 1
      && mysqlUniqueDrops.length === 1 && mysqlUniqueAdds.length === 1
      && mysqlCheckDrops.length === 1 && mysqlCheckAdds.length === 1,
    mysqlDependency.sqls);
  check('ddl mysql 依赖约束顺序包围类型变更且合并为单条 ALTER',
    mysqlDependency.sqls.length === 1
      && mysqlDependencySql.indexOf('DROP FOREIGN KEY `fk_t1_owner`') < mysqlDependencySql.indexOf('CHANGE COLUMN `id`')
      && mysqlDependencySql.indexOf('DROP INDEX `uq_t1_name`') < mysqlDependencySql.indexOf('CHANGE COLUMN `name`')
      && mysqlDependencySql.indexOf('DROP CHECK `ck_t1_amount`') < mysqlDependencySql.indexOf('CHANGE COLUMN `amount`')
      && mysqlDependencySql.indexOf('ADD CONSTRAINT `fk_t1_owner`') > mysqlDependencySql.lastIndexOf('CHANGE COLUMN')
      && mysqlDependencySql.indexOf('ADD CONSTRAINT `uq_t1_name`') > mysqlDependencySql.lastIndexOf('CHANGE COLUMN')
      && mysqlDependencySql.indexOf('ADD CONSTRAINT `ck_t1_amount`') > mysqlDependencySql.lastIndexOf('CHANGE COLUMN'),
    mysqlDependency.sqls);

  // CHECK 中函数名可能与栏位名同名。MySQL 重命名不会自动改写 CHECK，
  // 因此未手动更新表达式时必须阻止；更新后不能误改函数名。
  const lowerCheckOrig = JSON.parse(JSON.stringify(constrainedOrig));
  lowerCheckOrig.indexes = [];
  lowerCheckOrig.foreignKeys = [];
  lowerCheckOrig.columns.push({
    name: 'lower', origName: 'lower', type: 'varchar', length: '100', scale: '',
    notNull: false, pk: false, autoInc: false, def: '', comment: '',
  });
  lowerCheckOrig.constraints = [{
    kind: 'check', name: 'ck_t1_lower', origName: 'ck_t1_lower', columns: [],
    expression: "lower(`lower`) <> ''", rebuildSafe: true,
  }];
  const lowerCheckRenamed = JSON.parse(JSON.stringify(lowerCheckOrig));
  lowerCheckRenamed.columns.find((c) => c.origName === 'lower').name = 'normalized';
  let lowerRenameBlocked = false;
  try { ddl.buildAlterTable(my, 'db1', null, lowerCheckOrig, lowerCheckRenamed); }
  catch (e) { lowerRenameBlocked = /检查约束 ck_t1_lower.*手动更新 CHECK 表达式/.test(e.message); }
  check('ddl mysql CHECK 函数名与栏位名冲突时拒绝静默重命名', lowerRenameBlocked);
  lowerCheckRenamed.constraints[0].expression = "lower(`normalized`) <> ''";
  const lowerCheckAlter = ddl.buildAlterTable(my, 'db1', null, lowerCheckOrig, lowerCheckRenamed);
  check('ddl mysql 手改 CHECK 后保留 lower 函数名', lowerCheckAlter.sqls.some((s) => (
    s.includes("ADD CONSTRAINT `ck_t1_lower` CHECK (lower(`normalized`) <> '')")
  )) && !lowerCheckAlter.sqls.some((s) => /CHECK \(normalized\s*\(/i.test(s)), lowerCheckAlter.sqls);

  const unsafeConstraintOriginal = (kind) => {
    const source = JSON.parse(JSON.stringify(constrainedOrig));
    source.indexes = [];
    source.foreignKeys = kind === 'fk'
      ? [{ ...source.foreignKeys[0], rebuildSafe: false }]
      : [];
    source.constraints = kind === 'unique'
      ? [{ ...source.constraints.find((item) => item.kind === 'unique'), rebuildSafe: false }]
      : (kind === 'check'
        ? [{ ...source.constraints.find((item) => item.kind === 'check'), rebuildSafe: false }]
        : []);
    return source;
  };
  const unsafeEditedErrors = ['fk', 'unique', 'check'].map((kind) => {
    const source = unsafeConstraintOriginal(kind);
    const changed = JSON.parse(JSON.stringify(source));
    if (kind === 'fk') changed.foreignKeys[0].onDelete = 'CASCADE';
    else if (kind === 'unique') changed.constraints[0].columns = ['amount'];
    else changed.constraints[0].expression = 'amount >= 1';
    try { ddl.buildAlterTable(my, 'db1', null, source, changed); return ''; }
    catch (e) { return e.message; }
  });
  check('ddl rebuildSafe=false 阻止编辑 FK/UNIQUE/CHECK', unsafeEditedErrors.every((message) => /无法无损保留/.test(message)),
    unsafeEditedErrors);
  const unsafeDependencyErrors = ['fk', 'unique', 'check'].map((kind) => {
    const source = unsafeConstraintOriginal(kind);
    const changed = JSON.parse(JSON.stringify(source));
    if (kind === 'fk') changed.columns.find((c) => c.name === 'id').type = 'bigint';
    else if (kind === 'unique') changed.columns.find((c) => c.name === 'name').length = '160';
    else changed.columns.find((c) => c.name === 'amount').length = '14';
    try { ddl.buildAlterTable(my, 'db1', null, source, changed); return ''; }
    catch (e) { return e.message; }
  });
  check('ddl rebuildSafe=false 阻止因类型变化重建 FK/UNIQUE/CHECK', unsafeDependencyErrors.every((message) => /无法无损保留/.test(message)),
    unsafeDependencyErrors);

  const renameOnlyOrig = JSON.parse(JSON.stringify(constrainedOrig));
  renameOnlyOrig.indexes = [];
  renameOnlyOrig.constraints = renameOnlyOrig.constraints.filter((item) => item.kind === 'unique');
  const renameOnlyStale = JSON.parse(JSON.stringify(renameOnlyOrig));
  renameOnlyStale.columns.find((c) => c.origName === 'id').name = 'owner_id';
  renameOnlyStale.columns.find((c) => c.origName === 'name').name = 'full_name';
  const renameOnlySynced = JSON.parse(JSON.stringify(renameOnlyStale));
  renameOnlySynced.foreignKeys[0].columns = ['owner_id'];
  renameOnlySynced.constraints[0].columns = ['full_name'];
  const renameOnlyResults = [renameOnlyStale, renameOnlySynced]
    .map((next) => ddl.buildAlterTable(my, 'db1', null, renameOnlyOrig, next));
  const rebuildSql = /DROP FOREIGN KEY|DROP INDEX `uq_t1_name`|ADD CONSTRAINT `(?:fk_t1_owner|uq_t1_name)`/;
  check('ddl 仅重命名栏位不重建未编辑 FK/UNIQUE', renameOnlyResults.every((result) => (
    result.sqls.some((s) => s.includes('CHANGE COLUMN `id` `owner_id`'))
      && result.sqls.some((s) => s.includes('CHANGE COLUMN `name` `full_name`'))
      && !result.sqls.some((s) => rebuildSql.test(s))
  )), renameOnlyResults.map((result) => result.sqls));

  const pgDependency = ddl.buildAlterTable(pgA, 'db1', 'public', constrainedOrig, dependencyMod);
  const pgConstraintSql = (verb, name) => pgDependency.sqls.filter((s) => s.includes(`${verb} CONSTRAINT "${name}"`));
  const pgDrops = ['fk_t1_owner', 'uq_t1_name', 'ck_t1_amount'].flatMap((name) => pgConstraintSql('DROP', name));
  const pgAdds = ['fk_t1_owner', 'uq_t1_name', 'ck_t1_amount'].flatMap((name) => pgConstraintSql('ADD', name));
  const pgFirstType = pgDependency.sqls.findIndex((s) => s.includes(' ALTER COLUMN ') && s.includes(' TYPE '));
  const pgLastType = pgDependency.sqls.reduce((last, s, i) => s.includes(' ALTER COLUMN ') && s.includes(' TYPE ') ? i : last, -1);
  check('ddl postgres 类型变更自动拆建依赖约束且不重复', pgDrops.length === 3 && pgAdds.length === 3
    && new Set(pgDrops).size === 3 && new Set(pgAdds).size === 3, pgDependency.sqls);
  check('ddl postgres 依赖约束顺序包围类型变更', pgDrops.every((s) => pgDependency.sqls.indexOf(s) < pgFirstType)
    && pgAdds.every((s) => pgDependency.sqls.indexOf(s) > pgLastType), pgDependency.sqls);

  const constrainedPg = ddl.buildCreateTable(pgA, 'db1', 'public', {
    ...constrainedCreate,
    foreignKeys: [{ ...constrainedCreate.foreignKeys[0], onUpdate: 'SET DEFAULT', onDelete: 'RESTRICT' }],
  });
  check('ddl postgres 外键动作', constrainedPg.sqls[0].includes('ON DELETE RESTRICT ON UPDATE SET DEFAULT'), constrainedPg.sqls[0]);
  const constrainedOracle = ddl.buildCreateTable(obo, 'SCOTT', null, constrainedCreate);
  check('ddl oracle 明确降级 ON UPDATE', constrainedOracle.warnings.some((w) => /不支持 ON UPDATE CASCADE/.test(w))
    && !constrainedOracle.sqls[0].includes('ON UPDATE'), constrainedOracle);
  const sqliteConstraintAlter = ddl.buildAlterTable(new SQLiteAdapter({}), 'main', null, constrainedOrig, constrainedMod);
  check('ddl sqlite 既有外键约束明确降级', sqliteConstraintAlter.sqls.length === 0
    && sqliteConstraintAlter.warnings.some((w) => /需要重建表/.test(w)), sqliteConstraintAlter);
  const clickhouseConstraints = ddl.buildCreateTable(ch, 'default', null, constrainedCreate);
  check('ddl clickhouse 不伪装支持外键约束', !/FOREIGN KEY|CONSTRAINT/.test(clickhouseConstraints.sqls[0])
    && clickhouseConstraints.warnings.length >= 3, clickhouseConstraints);

  const constraintModel = ddl.infoToModel({
    columns: [{ name: 'id', type: 'int', nullable: false, key: '', extra: '', def: null }], pk: [],
    indexes: [{ name: 'uq_t_id_idx', columns: ['id'], unique: true, primary: false }],
    foreignKeys: [], constraints: [{ kind: 'unique', name: 'uq_t_id', indexName: 'uq_t_id_idx', columns: ['id'] }],
  }, 't', 'postgres');
  check('ddl 约束背后的唯一索引不重复展示', constraintModel.constraints.length === 1 && constraintModel.indexes.length === 0, constraintModel);
  const unsafeConstraintModel = ddl.infoToModel({
    columns: [{
      name: 'id', type: 'int', nullable: false, key: '', extra: '', def: null,
      editSafe: false, editUnsafeReason: 'generated', charset: 'utf8mb4', collation: 'utf8mb4_bin',
    }], pk: [], indexes: [],
    foreignKeys: [{
      name: 'fk_t_parent', columns: ['id'], refSchema: '', refTable: 'parent', refColumns: ['id'],
      onUpdate: 'NO ACTION', onDelete: 'NO ACTION', rebuildSafe: false,
    }],
    constraints: [
      { kind: 'unique', name: 'uq_t_id', columns: ['id'], rebuildSafe: false },
      { kind: 'check', name: 'ck_t_id', expression: 'id > 0', rebuildSafe: false },
    ],
  }, 't', 'mysql');
  check('ddl infoToModel 传播 rebuildSafe=false', unsafeConstraintModel.foreignKeys[0].rebuildSafe === false
    && unsafeConstraintModel.constraints.every((item) => item.rebuildSafe === false)
    && unsafeConstraintModel.columns[0].editSafe === false
    && unsafeConstraintModel.columns[0].charset === 'utf8mb4'
    && unsafeConstraintModel.columns[0].collation === 'utf8mb4_bin', unsafeConstraintModel);
  const safeIndexModel = ddl.infoToModel({
    columns: [{ name: 'id', type: 'int', nullable: false, key: '', extra: '', def: null }], pk: [],
    indexes: [
      { name: 'idx_plain', columns: ['id'], unique: false, primary: false, editable: true },
      { name: 'idx_expression', columns: ['id'], unique: false, primary: false, editable: false },
    ],
    foreignKeys: [], constraints: [],
  }, 't', 'postgres');
  check('ddl 不可无损编辑的高级索引不进入设计模型', safeIndexModel.indexes.length === 1
    && safeIndexModel.indexes[0].name === 'idx_plain', safeIndexModel);

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
  await ad2.exec('main', 'CREATE TABLE owner (id INTEGER PRIMARY KEY)');
  const sqliteConstraintModel = {
    table: 'child_constraints', comment: '', options: '', indexes: [],
    columns: [
      { name: 'id', origName: null, type: 'INTEGER', length: '', scale: '', notNull: true, pk: true, autoInc: false, def: '', comment: '' },
      { name: 'owner_id', origName: null, type: 'INTEGER', length: '', scale: '', notNull: false, pk: false, autoInc: false, def: '', comment: '' },
      { name: 'code', origName: null, type: 'TEXT', length: '', scale: '', notNull: false, pk: false, autoInc: false, def: '', comment: '' },
    ],
    foreignKeys: [{
      name: 'fk_child_owner', origName: null, columns: ['owner_id'], refSchema: '', refTable: 'owner', refColumns: ['id'],
      onUpdate: 'CASCADE', onDelete: 'SET NULL',
    }],
    constraints: [
      { kind: 'unique', name: 'uq_child_code', origName: null, columns: ['code'], expression: '' },
      { kind: 'check', name: 'ck_child_code', origName: null, columns: [], expression: "length(code) >= 2" },
    ],
  };
  const sqliteConstraintBuilt = ddl.buildCreateTable(ad2, 'main', null, sqliteConstraintModel);
  await ad2.execSequential('main', sqliteConstraintBuilt.sqls);
  const sqliteDesignedFks = await ad2.listForeignKeys('main', null, 'child_constraints');
  const sqliteDesignedConstraints = await ad2.listConstraints('main', null, 'child_constraints');
  check('设计器 SQLite 外键动作回读', sqliteDesignedFks.length === 1
    && sqliteDesignedFks[0].columns[0] === 'owner_id' && sqliteDesignedFks[0].refTable === 'owner'
    && sqliteDesignedFks[0].onUpdate === 'CASCADE' && sqliteDesignedFks[0].onDelete === 'SET NULL', sqliteDesignedFks);
  check('设计器 SQLite UNIQUE/CHECK 回读', sqliteDesignedConstraints.some((item) => item.kind === 'unique' && item.columns[0] === 'code')
    && sqliteDesignedConstraints.some((item) => item.kind === 'check' && item.name === 'ck_child_code'
      && item.expression === 'length(code) >= 2'), sqliteDesignedConstraints);
  await ad2.exec('main', "CREATE TABLE check_literal (note TEXT DEFAULT 'CHECK(fake)', amount INTEGER CONSTRAINT ck_amount CHECK(amount >= 0))");
  const literalChecks = await ad2.listConstraints('main', null, 'check_literal');
  check('SQLite CHECK 回读忽略字符串中的 CHECK 文本', literalChecks.filter((item) => item.kind === 'check').length === 1
    && literalChecks.some((item) => item.name === 'ck_amount'), literalChecks);
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

  // CSV 防公式注入只处理原始文本，不应改变负数或负 bigint 的类型语义。
  const formulaCsv = expBase + '-formula.csv';
  const formulaMeta = await exporter.exportRows(ad2, {
    file: formulaCsv, format: 'csv',
    columns: [
      { name: 'text_formula' }, { name: 'number' }, { name: 'bigint' },
      { name: 'decimal_string', type: 'decimal(38,10)' }, { name: 'text_number', type: 'text' },
      { name: 'minus_formula', type: 'text' },
    ],
    rows: [['=1+1', -12.5, -9007199254740993n, '-12345678901234567890.1234567890', '-12.5', '-1+2']],
  });
  const formulaText = fs.readFileSync(formulaCsv, 'utf8');
  check('CSV 公式文本加前缀且负数/精确数值字符串保持原值', formulaMeta.formulaEscaped === 2
    && formulaText.includes("'=1+1,-12.5,-9007199254740993,-12345678901234567890.1234567890,-12.5,'-1+2"),
  { formulaMeta, formulaText });
  try { fs.unlinkSync(formulaCsv); } catch (e) { /* ignore */ }
  const mysqlModeSql = expBase + '-mysql-mode.sql';
  await exporter.exportRows(my, {
    file: mysqlModeSql, format: 'sql', sqlTableName: '`t`',
    columns: [{ name: 'v', type: 'varchar(50)' }], rows: [["a'b\\c"]],
  });
  const mysqlModeText = fs.readFileSync(mysqlModeSql, 'utf8');
  check('MySQL SQL 导出字符串不依赖 NO_BACKSLASH_ESCAPES',
    mysqlModeText.includes("_utf8mb4 X'6127625c63'"), mysqlModeText);
  try { fs.unlinkSync(mysqlModeSql); } catch (e) { /* ignore */ }
  const nonFiniteJson = expBase + '-nonfinite.json';
  await exporter.exportRows(pgA, {
    file: nonFiniteJson, format: 'json', columns: [{ name: 'nan', type: 'double precision' }, { name: 'inf', type: 'double precision' }],
    rows: [[NaN, Infinity]],
  });
  const nonFiniteValues = JSON.parse(fs.readFileSync(nonFiniteJson, 'utf8'))[0];
  check('JSON 导出非有限浮点不静默变成 null', nonFiniteValues.nan === 'NaN' && nonFiniteValues.inf === 'Infinity', nonFiniteValues);
  try { fs.unlinkSync(nonFiniteJson); } catch (e) { /* ignore */ }
  let nonFiniteSqlDenied = false;
  const nonFiniteSql = expBase + '-nonfinite.sql';
  try {
    await exporter.exportRows(pgA, {
      file: nonFiniteSql, format: 'sql', columns: [{ name: 'v', type: 'double precision' }], rows: [[NaN]],
    });
  } catch (e) { nonFiniteSqlDenied = /非有限浮点值/.test(e.message); }
  check('SQL 导出明确拒绝非有限浮点', nonFiniteSqlDenied && !fs.existsSync(nonFiniteSql));

  // PostgreSQL 驱动把数组和 interval 返回为对象；静默 JSON.stringify 后
  // 生成的 INSERT 不可可靠回放，因此 SQL 格式应明确拒绝并推荐无损格式。
  for (const sample of [
    { type: 'integer[]', value: [1, 2] },
    { type: 'interval', value: { days: 1, hours: 2 } },
  ]) {
    const target = `${expBase}-pg-${sample.type.replace(/\W/g, '')}.sql`;
    let pgExportErr = null;
    try {
      await exporter.exportRows(pgA, {
        file: target, format: 'sql', columns: [{ name: 'v', type: sample.type }], rows: [[sample.value]],
      });
    } catch (e) { pgExportErr = e; }
    check(`PG ${sample.type} SQL 导出明确拒绝`, pgExportErr && /CSV.*JSON/.test(pgExportErr.message)
      && !fs.existsSync(target), pgExportErr && pgExportErr.message);
  }

  // MSSQL 全表导出须在 tedious 解析前转换精确数值和高精度时间；
  // 高精度时间主键仍必须用于 keyset 游标，而不是退回不可靠的分页。
  const msColumns = [
    { name: 'seq', type: 'int' },
    { name: 'id', type: 'datetime2' },
    { name: 'amount', type: 'decimal(38,10)' },
    { name: 'alias_amount', type: 'exact_amount', baseType: 'decimal(38,10)' },
    { name: 'ratio', type: 'numeric(38,20)' },
    { name: 'cash', type: 'money' },
    { name: 'offset_at', type: 'datetimeoffset' },
    { name: 'clock_at', type: 'time' },
    { name: 'label', type: 'nvarchar(50)' },
  ];
  const msSqls = [];
  let msPage = 0;
  const msRows = Array.from({ length: 5000 }, () => [
    5000, '2024-01-02T03:04:05.1234567', '12345678901234567890.1234567890',
    '98765432109876543210.1234567890', '0.12345678901234567890', '12.3400', '2024-01-02T03:04:05.1234567+08:00',
    '03:04:05.1234567', '精确值',
  ]);
  const msMock = {
    dialect: 'mssql',
    quoteIdent: (name) => '[' + String(name).replace(/]/g, ']]') + ']',
    literal: (value) => value === null ? 'NULL'
      : typeof value === 'number' ? String(value)
      : typeof value === 'boolean' ? (value ? '1' : '0')
      : "N'" + String(value).replace(/'/g, "''") + "'",
    blobLiteral: (value) => '0x' + value.toString('hex'),
    qualify: (_db, schema, table) => `${schema ? `[${schema}].` : ''}[${table}]`,
    tableInfo: async () => ({ columns: msColumns, pk: ['seq', 'id'], ddl: 'CREATE TABLE [dbo].[precise] ([seq] int)' }),
    pageSql: (select, order, limit, offset) => `${select}${order} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
    exec: async (_db, sql) => {
      msSqls.push(sql);
      msPage++;
      return { columns: msColumns, rows: msPage === 1 ? msRows : [] };
    },
  };
  const msFile = expBase + '-mssql.json';
  const msMeta = await exporter.exportTable(msMock, {
    db: 'db', schema: 'dbo', table: 'precise', file: msFile, format: 'json',
  });
  check('MSSQL 全表导出服务端精确投影',
    /CONVERT\(varchar\(100\), \[amount\]\) AS \[amount\]/.test(msSqls[0])
    && /CONVERT\(varchar\(100\), \[alias_amount\]\) AS \[alias_amount\]/.test(msSqls[0])
    && /CONVERT\(varchar\(100\), \[ratio\]\) AS \[ratio\]/.test(msSqls[0])
    && /CONVERT\(varchar\(100\), \[cash\], 2\) AS \[cash\]/.test(msSqls[0])
    && /CONVERT\(varchar\(50\), \[id\], 126\) AS \[id\]/.test(msSqls[0])
    && /CONVERT\(varchar\(50\), \[offset_at\], 127\) AS \[offset_at\]/.test(msSqls[0])
    && /CONVERT\(varchar\(30\), \[clock_at\]\) AS \[clock_at\]/.test(msSqls[0]), msSqls[0]);
  check('MSSQL 数值/高精度时间复合主键保持精确 keyset 分页', msMeta.pagination === 'keyset'
    && msMeta.orderedBy.join(',') === 'seq,id' && msSqls.length === 2
    && /\(\[seq\] > 5000\)/.test(msSqls[1])
    && /\[seq\] = 5000 AND \[id\] > N'2024-01-02T03:04:05\.1234567'/.test(msSqls[1]), msSqls[1]);
  try { fs.unlinkSync(msFile); } catch (e) { /* ignore */ }
  msPage = 0;
  msSqls.length = 0;
  const msDumpFile = expBase + '-mssql-dump.sql';
  const transferForPrecision = require('./transfer');
  await transferForPrecision.dumpSql(msMock, {
    db: 'db', schema: 'dbo', tables: [{ name: 'precise' }], file: msDumpFile,
    includeDrop: false, includeData: true, batchSize: 5000,
  }, () => {});
  const msDumpText = fs.readFileSync(msDumpFile, 'utf8');
  check('MSSQL 转储同样使用服务端精确投影',
    /CONVERT\(varchar\(100\), \[amount\]\) AS \[amount\]/.test(msSqls[0])
    && msDumpText.includes("N'12345678901234567890.1234567890'")
    && msDumpText.includes("N'2024-01-02T03:04:05.1234567+08:00'"));
  try { fs.unlinkSync(msDumpFile); } catch (e) { /* ignore */ }

  // 整表导出必须绕过展示层的 200KB 文本 / 256B BLOB 预览截断。
  const longText = '长文本'.repeat(70050);
  const longBlob = Buffer.alloc(1024, 0xab);
  await ad2.exec('main', 'ALTER TABLE imp_test ADD COLUMN big_text TEXT');
  await ad2.exec('main', 'ALTER TABLE imp_test ADD COLUMN payload BLOB');
  await ad2.exec('main', `UPDATE imp_test SET big_text = ${ad2.literal(longText)}, payload = X'${longBlob.toString('hex')}' WHERE id = 1`);
  await ad2.exec('main', "INSERT INTO imp_test (id, name) VALUES (9007199254740993, '大整数')");
  const exactInteger = await ad2.exec('main', "SELECT id FROM imp_test WHERE name = '大整数'");
  check('SQLite 64 位整数原始读取不失真', String(exactInteger.rows[0][0]) === '9007199254740993', exactInteger.rows[0][0]);
  const rawExp = await exporter.exportTable(ad2, { db: 'main', table: 'imp_test', file: expBase + '-raw.json', format: 'json' });
  const rawJson = JSON.parse(fs.readFileSync(expBase + '-raw.json', 'utf8'));
  check('整表导出长文本不截断', rawJson[0].big_text === longText, rawJson[0].big_text && rawJson[0].big_text.length);
  check('整表导出 BLOB 不截断', rawJson[0].payload === '0x' + longBlob.toString('hex'), rawJson[0].payload && rawJson[0].payload.length);
  check('整表导出 64 位整数不失真', rawJson.some((row) => row.id === '9007199254740993'));
  check('整表导出主键稳定排序', rawExp.truncated === false && rawExp.orderedBy.join(',') === 'id', rawExp);
  await exporter.exportTable(ad2, { db: 'main', table: 'imp_test', file: expBase + '-raw.sql', format: 'sql' });
  const rawSql = fs.readFileSync(expBase + '-raw.sql', 'utf8');
  check('SQL 导出使用完整 BLOB 字面量', rawSql.includes("X'" + longBlob.toString('hex') + "'"));
  check('SQL 导出 64 位整数保持数值字面量', rawSql.includes('VALUES (9007199254740993,'));
  for (const ext of ['.csv', '.json', '.sql', '.xlsx', '.md']) {
    try { fs.unlinkSync(expBase + ext); } catch (e) { /* ignore */ }
  }
  for (const ext of ['-raw.json', '-raw.sql']) {
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

  for (const externalSql of ["ATTACH DATABASE 'other.db' AS other", "VACUUM main INTO 'copy.db'"]) {
    let externalFileDenied = false;
    try { await ad2.exec('main', externalSql); }
    catch (e) { externalFileDenied = /不允许 ATTACH 或 VACUUM INTO/.test(e.message); }
    check(`SQLite 拒绝 SQL 访问外部文件: ${externalSql.split(' ')[0]}`, externalFileDenied);
  }

  await ad2.close();
  try { fs.unlinkSync(file2); } catch (e) { /* ignore */ }

  // ---- SQLite 全链路 ----
  const file = path.join(os.tmpdir(), `dbconnect-selftest-${Date.now()}.db`);
  const ad = new SQLiteAdapter({ id: 't', type: 'sqlite', file });
  await ad.connect();
  check('适配器初始活动查询/事务摘要为空', ad.connectionActivity().requests === 0
    && ad.connectionActivity().transactions === 0, ad.connectionActivity());
  console.log('  · SQLite 模式:', ad.mode, ad.serverVersion);

  await ad.runScript('main', `
    CREATE TABLE fk_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE fk_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES fk_parent(id));
    CREATE TABLE fk_child_implicit (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES fk_parent);
  `);
  const sqliteOrphan = await ad.runScript('main', 'INSERT INTO fk_child(id, parent_id) VALUES (1, 999)');
  check('SQLite 连接强制启用外键约束', sqliteOrphan.some((item) => /FOREIGN KEY constraint failed/i.test(item.error || '')), sqliteOrphan);
  const sqliteImplicitRefs = await ad.listReferencingForeignKeys('main', null, 'fk_parent');
  check('SQLite 省略父栏位的入站外键补齐目标主键', sqliteImplicitRefs.some((item) => (
    item.table === 'fk_child_implicit' && item.refColumns.length === 1 && item.refColumns[0] === 'id'
  )), sqliteImplicitRefs);
  await ad.runScript('main', 'DROP TABLE fk_child_implicit; DROP TABLE fk_child; DROP TABLE fk_parent;');
  await ad.runScript('main', `
    CREATE TABLE idx_advanced (name TEXT, amount INTEGER);
    CREATE INDEX idx_simple ON idx_advanced(name);
    CREATE INDEX idx_partial ON idx_advanced(amount) WHERE amount > 0;
    CREATE INDEX idx_expression ON idx_advanced(lower(name));
    CREATE INDEX idx_desc ON idx_advanced(amount DESC);
  `);
  const sqliteAdvancedInfo = await ad.tableInfo('main', null, 'idx_advanced');
  const sqliteIndexSafety = new Map(sqliteAdvancedInfo.indexes.map((item) => [item.name, item.editable]));
  check('SQLite 高级索引只读且基础索引可编辑', sqliteIndexSafety.get('idx_simple') === true
    && sqliteIndexSafety.get('idx_partial') === false
    && sqliteIndexSafety.get('idx_expression') === false
    && sqliteIndexSafety.get('idx_desc') === false, sqliteAdvancedInfo.indexes);
  await ad.runScript('main', 'DROP TABLE idx_advanced;');
  const sqliteReconnect = new SQLiteAdapter({ type: 'sqlite', file: ':memory:' });
  await sqliteReconnect.connect();
  check('SQLite 每次新连接都会重新启用外键约束', Number(sqliteReconnect._execRaw('PRAGMA foreign_keys').rows[0][0]) === 1);
  await sqliteReconnect.close();

  const r1 = await ad.runScript('main', `
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, age INT, note TEXT);
    INSERT INTO users (name, age, note) VALUES ('张三', 30, NULL);
    INSERT INTO users (name, age, note) VALUES ('李四', 25, 'it''s ok');
    SELECT * FROM users ORDER BY id;
  `);
  check('runScript 语句数', r1.length === 4, r1.map((x) => x.error || 'ok'));
  check('runScript 无错误', r1.every((x) => !x.error), r1.find((x) => x.error));
  const sel = r1[3];
  const capped = await ad.runScript('main', 'SELECT * FROM users ORDER BY id', { maxRows: 1 });
  check('runScript 数据库侧限额', capped[0].rows.length === 1 && capped[0].truncated === true
    && capped[0].rowCount === 1 && capped[0].rowCountExact === false, capped[0]);
  check('单表 SELECT * 结果携带可编辑目标',
    capped[0].editTarget && capped[0].editTarget.table === 'users'
      && capped[0].editTarget.pk[0] === 'id', capped[0].editTarget);
  const directColumnsResult = await ad.runScript('main', 'SELECT id, name FROM users ORDER BY id');
  check('包含主键的直接字段列表可编辑',
    directColumnsResult[0].editTarget && directColumnsResult[0].editTarget.pk[0] === 'id');
  const missingPkResult = await ad.runScript('main', 'SELECT name FROM users ORDER BY id');
  check('缺少主键的查询结果保守只读',
    !missingPkResult[0].editTarget && /完整主键/.test(missingPkResult[0].editReadonlyReason || ''));
  const explicitLimit = await ad.runScript('main', 'SELECT * FROM users ORDER BY id LIMIT 2', { maxRows: 1 });
  check('runScript 已有 LIMIT 结果精确', explicitLimit[0].rows.length === 1 && explicitLimit[0].truncated === true
    && explicitLimit[0].rowCount === 2 && explicitLimit[0].rowCountExact === true, explicitLimit[0]);
  check('查询返回行', sel && sel.rowCount === 2);
  check('查询返回中文', sel && sel.rows[0][1] === '张三');
  check('NULL 透传', sel && sel.rows[0][3] === null);

  const autoEdit = await ad.applyQueryEdits('query-tx:auto-edit', 'main', {
    schema: null,
    table: 'users',
    edits: [{ kind: 'update', where: { id: 1 }, set: { note: '查询结果编辑' } }],
  });
  const autoEditValue = await ad.runScript('main', 'SELECT note FROM users WHERE id = 1');
  check('查询结果 Ctrl+S 自动提交修改', autoEdit.count === 1 && autoEdit.pendingTransaction === false
    && autoEditValue[0].rows[0][0] === '查询结果编辑');
  const resultEditTxId = 'query-tx:result-edit';
  await ad.beginTransaction(resultEditTxId, 'main');
  const pendingEdit = await ad.applyQueryEdits(resultEditTxId, 'main', {
    schema: null,
    table: 'users',
    edits: [{ kind: 'update', where: { id: 1 }, set: { note: '事务内结果编辑' } }],
  });
  const pendingValue = await ad.runTransactionScript(resultEditTxId, 'main', 'SELECT note FROM users WHERE id = 1');
  await ad.rollbackTransaction(resultEditTxId);
  const rolledBackEditValue = await ad.runScript('main', 'SELECT note FROM users WHERE id = 1');
  check('查询结果修改沿用当前显式事务', pendingEdit.pendingTransaction === true
    && pendingValue[0].rows[0][0] === '事务内结果编辑'
    && rolledBackEditValue[0].rows[0][0] === '查询结果编辑');

  // 查询标签显式事务：同一固定会话中执行，提交/回滚后释放。
  const txId = 'selftest-explicit-tx';
  await ad.beginTransaction(txId, 'main');
  check('显式事务状态 active', ad.transactionStatus(txId).state === 'active', ad.transactionStatus(txId));
  const txUpdate = await ad.runTransactionScript(txId, 'main', 'UPDATE users SET age = 77 WHERE id = 1', { requestId: 'tx-update' });
  check('显式事务内语句成功', txUpdate.length === 1 && !txUpdate[0].error, txUpdate);
  let sqliteOutsideBlocked = false;
  try { await ad.runScript('main', 'SELECT age FROM users WHERE id = 1'); }
  catch (e) { sqliteOutsideBlocked = /显式事务/.test(e.message); }
  check('SQLite 显式事务期间阻止其他会话混入', sqliteOutsideBlocked);
  await ad.rollbackTransaction(txId);
  const rolledBackAge = await ad.runScript('main', 'SELECT age FROM users WHERE id = 1');
  check('显式事务回滚恢复数据', Number(rolledBackAge[0].rows[0][0]) === 30, rolledBackAge);

  await ad.beginTransaction(txId, 'main');
  await ad.runTransactionScript(txId, 'main', "INSERT INTO users (name, age) VALUES ('事务提交', 44)", { requestId: 'tx-insert' });
  await ad.commitTransaction(txId);
  const committedRow = await ad.runScript('main', "SELECT age FROM users WHERE name = '事务提交'");
  check('显式事务提交持久化数据', Number(committedRow[0].rows[0][0]) === 44, committedRow);

  const handwrittenTxId = 'query-handwritten';
  const handwrittenBegin = await ad.runQuerySessionScript(
    handwrittenTxId, 'main', 'BEGIN;', { requestId: 'handwritten-begin' },
  );
  check('查询页手写 BEGIN 开始固定会话事务', handwrittenBegin[0].message === '事务已开始'
    && ad.transactionStatus(handwrittenTxId).state === 'active', handwrittenBegin);
  await ad.runQuerySessionScript(
    handwrittenTxId, 'main',
    "INSERT INTO users (name, age) VALUES ('手写提交', 51);",
    { requestId: 'handwritten-insert' },
  );
  const handwrittenCommit = await ad.runQuerySessionScript(
    handwrittenTxId, 'main', 'COMMIT;', { requestId: 'handwritten-commit' },
  );
  const handwrittenCommittedRow = await ad.runScript(
    'main', "SELECT age FROM users WHERE name = '手写提交'",
  );
  check('查询页手写 COMMIT 与工具栏状态同步', handwrittenCommit[0].message === '事务已提交'
    && ad.transactionStatus(handwrittenTxId).state === 'idle'
    && Number(handwrittenCommittedRow[0].rows[0][0]) === 51,
  { handwrittenCommit, handwrittenCommittedRow });

  const mixedTxId = 'query-mixed-boundaries';
  const mixedRollback = await ad.runQuerySessionScript(
    mixedTxId, 'main',
    "BEGIN; INSERT INTO users (name, age) VALUES ('整段回滚', 52); ROLLBACK;",
    { requestId: 'mixed-rollback' },
  );
  const mixedRolledBackRow = await ad.runScript(
    'main', "SELECT age FROM users WHERE name = '整段回滚'",
  );
  check('运行全部支持 BEGIN/语句/ROLLBACK 并保持同一会话',
    mixedRollback.length === 3
    && mixedRollback[0].message === '事务已开始'
    && mixedRollback[2].message === '事务已回滚'
    && mixedRolledBackRow[0].rows.length === 0
    && ad.transactionStatus(mixedTxId).state === 'idle',
  { mixedRollback, mixedRolledBackRow });

  const buttonSqlMixedId = 'query-button-sql-mixed';
  await ad.beginTransaction(buttonSqlMixedId, 'main');
  await ad.runQuerySessionScript(
    buttonSqlMixedId, 'main',
    "INSERT INTO users (name, age) VALUES ('按钮开始SQL提交', 53); COMMIT;",
    { requestId: 'button-sql-mixed' },
  );
  const buttonSqlMixedRow = await ad.runScript(
    'main', "SELECT age FROM users WHERE name = '按钮开始SQL提交'",
  );
  check('工具栏开始与手写 COMMIT 共用同一事务状态',
    ad.transactionStatus(buttonSqlMixedId).state === 'idle'
    && Number(buttonSqlMixedRow[0].rows[0][0]) === 53, buttonSqlMixedRow);

  await ad.beginTransaction(txId, 'main');
  const txBad = await ad.runTransactionScript(txId, 'main', 'SELECT * FROM table_does_not_exist', { requestId: 'tx-bad' });
  check('事务语句失败进入 failed 状态', txBad.some((item) => item.error)
    && ad.transactionStatus(txId).state === 'failed', { txBad, status: ad.transactionStatus(txId) });
  let failedCommitDenied = false;
  try { await ad.commitTransaction(txId); } catch (e) { failedCommitDenied = /只能回滚/.test(e.message); }
  check('失败事务禁止提交', failedCommitDenied);
  await ad.rollbackTransaction(txId);
  const clickhouseTx = new ClickHouseAdapter({ type: 'clickhouse' });
  check('ClickHouse 显式事务安全降级', clickhouseTx.transactionStatus('tx-check').supported === false,
    clickhouseTx.transactionStatus('tx-check'));
  let clickhouseBoundaryDenied = false;
  try { await clickhouseTx.runQuerySessionScript('tx-check', 'default', 'BEGIN'); }
  catch (e) { clickhouseBoundaryDenied = /不支持跨语句显式事务|仅支持自动提交/.test(e.message); }
  check('ClickHouse 手写事务边界给出明确降级提示', clickhouseBoundaryDenied);

  const { BaseAdapter } = require('./db/base');
  class FakeTransactionAdapter extends BaseAdapter {
    constructor(options = {}) {
      super({});
      this.options = options;
      this.log = [];
      this.invalidated = 0;
    }
    get dialect() { return 'postgres'; }
    async withSession(_db, fn) {
      const run = async (sql) => {
        this.log.push(sql);
        if (this.options.failTerminal === sql) throw new Error(`terminal failed: ${sql}`);
        if (this.options.failSql === sql) throw new Error(`statement failed: ${sql}`);
        if (this.options.failCleanup && sql === 'SESSION CLEANUP') throw new Error('cleanup failed');
        return { affected: 0 };
      };
      run.invalidate = () => { this.invalidated++; };
      return fn(run);
    }
    _transactionCleanupSqls() { return this.options.cleanup ? ['SESSION CLEANUP'] : []; }
  }

  class FakeMySQLTransactionAdapter extends FakeTransactionAdapter {
    get dialect() { return 'mysql'; }
  }
  const mysqlStatementError = new FakeMySQLTransactionAdapter({ failSql: 'BAD SQL' });
  await mysqlStatementError.beginTransaction('mysql-statement-error', 'db');
  const mysqlStatementErrorResult = await mysqlStatementError.runQuerySessionScript(
    'mysql-statement-error', 'db', 'BAD SQL',
  );
  check('MySQL 单条语句失败不伪报整个事务已中止',
    mysqlStatementErrorResult.some((item) => item.error)
    && mysqlStatementError.transactionStatus('mysql-statement-error').state === 'active',
  mysqlStatementErrorResult);
  await mysqlStatementError.rollbackTransaction('mysql-statement-error');
  const mysqlDdlTransaction = new FakeMySQLTransactionAdapter();
  await mysqlDdlTransaction.beginTransaction('mysql-ddl-warning', 'db');
  const mysqlDdlResult = await mysqlDdlTransaction.runQuerySessionScript(
    'mysql-ddl-warning', 'db', 'ALTER TABLE t ADD COLUMN x INT',
  );
  check('MySQL 事务内 DDL 保留原生执行并提示隐式提交风险',
    /隐式提交/.test(mysqlDdlResult[0].warning || '')
    && mysqlDdlTransaction.transactionStatus('mysql-ddl-warning').state === 'active',
  mysqlDdlResult);
  await mysqlDdlTransaction.rollbackTransaction('mysql-ddl-warning');

  const commitFirst = new FakeTransactionAdapter();
  await commitFirst.beginTransaction('race-commit-first', 'db');
  const commitFirstResults = await Promise.allSettled([
    commitFirst.commitTransaction('race-commit-first'),
    commitFirst.rollbackTransaction('race-commit-first'),
  ]);
  check('并发提交/回滚只允许首个终态成功', commitFirstResults.filter((r) => r.status === 'fulfilled').length === 1
    && commitFirstResults.filter((r) => r.status === 'rejected').length === 1
    && commitFirst.log.filter((sql) => sql === 'COMMIT' || sql === 'ROLLBACK').join(',') === 'COMMIT',
  { results: commitFirstResults.map((r) => r.status), log: commitFirst.log });

  const rollbackFirst = new FakeTransactionAdapter();
  await rollbackFirst.beginTransaction('race-rollback-first', 'db');
  const rollbackFirstResults = await Promise.allSettled([
    rollbackFirst.rollbackTransaction('race-rollback-first'),
    rollbackFirst.commitTransaction('race-rollback-first'),
  ]);
  check('并发回滚/提交不会伪报第二次成功', rollbackFirstResults.filter((r) => r.status === 'fulfilled').length === 1
    && rollbackFirstResults.filter((r) => r.status === 'rejected').length === 1
    && rollbackFirst.log.filter((sql) => sql === 'COMMIT' || sql === 'ROLLBACK').join(',') === 'ROLLBACK',
  { results: rollbackFirstResults.map((r) => r.status), log: rollbackFirst.log });

  const taintedTx = new FakeTransactionAdapter({ failTerminal: 'COMMIT' });
  await taintedTx.beginTransaction('tainted', 'db');
  let taintedError = null;
  try { await taintedTx.commitTransaction('tainted'); } catch (e) { taintedError = e; }
  check('终态失败销毁而非复用事务会话', !!taintedError && taintedTx.invalidated > 0,
    { error: taintedError && taintedError.message, invalidated: taintedTx.invalidated, log: taintedTx.log });
  check('提交确认丢失明确提示结果未知', taintedError
    && taintedError.code === 'TRANSACTION_COMMIT_OUTCOME_UNKNOWN'
    && /可能已经提交|重新查询/.test(taintedError.message), taintedError && taintedError.message);

  const rollbackUnknown = new FakeTransactionAdapter({ failTerminal: 'ROLLBACK' });
  await rollbackUnknown.beginTransaction('rollback-unknown', 'db');
  let rollbackUnknownError = null;
  try { await rollbackUnknown.rollbackTransaction('rollback-unknown'); } catch (e) { rollbackUnknownError = e; }
  check('回滚确认丢失提示会话隔离并要求核对', rollbackUnknownError
    && rollbackUnknownError.code === 'TRANSACTION_ROLLBACK_UNCONFIRMED'
    && /回滚结果未确认|重新查询/.test(rollbackUnknownError.message)
    && rollbackUnknown.invalidated > 0, rollbackUnknownError && rollbackUnknownError.message);

  const ddlCommitUnknown = new FakeTransactionAdapter({ failTerminal: 'COMMIT' });
  let ddlCommitUnknownError = null;
  try { await ddlCommitUnknown.execTxn('db', ['ALTER TABLE t ADD x int']); }
  catch (e) { ddlCommitUnknownError = e; }
  check('设计器事务 COMMIT 断线明确提示 DDL 结果未知', ddlCommitUnknownError
    && ddlCommitUnknownError.code === 'TRANSACTION_COMMIT_OUTCOME_UNKNOWN'
    && ddlCommitUnknown.invalidated > 0, ddlCommitUnknownError && ddlCommitUnknownError.message);

  const mssqlDdlUnknown = new MSSQLGuardAdapter({});
  let mssqlPoolClosed = false;
  mssqlDdlUnknown.pool = {
    request: () => ({ batch: async () => { const error = new Error('socket lost'); error.code = 'ESOCKET'; throw error; } }),
    close: async () => { mssqlPoolClosed = true; },
  };
  let mssqlDdlUnknownError = null;
  try { await mssqlDdlUnknown.execTxn('db', ['ALTER TABLE t ADD x int']); }
  catch (e) { mssqlDdlUnknownError = e; }
  await new Promise((resolve) => setImmediate(resolve));
  check('SQL Server 设计器网络错误提示提交结果未知并退役连接池', mssqlDdlUnknownError
    && mssqlDdlUnknownError.code === 'TRANSACTION_COMMIT_OUTCOME_UNKNOWN'
    && mssqlDdlUnknown.pool === null && mssqlPoolClosed, mssqlDdlUnknownError && mssqlDdlUnknownError.message);

  const cleanupTx = new FakeTransactionAdapter({ cleanup: true, failCleanup: true });
  await cleanupTx.beginTransaction('cleanup-fails', 'db');
  const cleanupCommit = await cleanupTx.commitTransaction('cleanup-fails');
  check('提交成功但会话清理失败时保留已提交结果并隔离会话', cleanupCommit.action === 'committed'
    && /事务已提交/.test(cleanupCommit.warning || '') && cleanupTx.invalidated > 0, cleanupCommit);

  const ownerTx = new FakeTransactionAdapter();
  await ownerTx.beginTransaction('wc-7:owned-a', 'db');
  await ownerTx.beginTransaction('wc-8:other-a', 'db');
  await ownerTx.closeTransactionsByPrefix('wc-7:');
  check('渲染进程事务清理只回滚所属事务', ownerTx.transactionStatus('wc-7:owned-a').state === 'idle'
    && ownerTx.transactionStatus('wc-8:other-a').state === 'active', ownerTx.log);
  await ownerTx.rollbackTransaction('wc-8:other-a');

  class OwnerRequestAdapter extends FakeTransactionAdapter {
    async cancel(requestId) { this.log.push(`cancel:${requestId}`); this._markRequestCancelled(requestId); }
  }
  const ownerRequests = new OwnerRequestAdapter();
  ownerRequests._beginRequest({ requestId: 'wc-7:req-a' });
  ownerRequests._beginRequest({ requestId: 'wc-8:req-b' });
  await ownerRequests.cancelRequestsByPrefix('wc-7:');
  check('渲染进程清理同时取消所属普通查询且不影响其他 owner', ownerRequests._isRequestCancelled('wc-7:req-a')
    && !ownerRequests._isRequestCancelled('wc-8:req-b')
    && ownerRequests.log.includes('cancel:wc-7:req-a') && !ownerRequests.log.includes('cancel:wc-8:req-b'), ownerRequests.log);
  ownerRequests._endRequest('wc-7:req-a');
  ownerRequests._endRequest('wc-8:req-b');

  class CancelRaceAdapter extends BaseAdapter {
    get dialect() { return 'postgres'; }
    async withSession(_db, fn) {
      return fn(async () => {
        this._markRequestCancelled('cancel-race');
        return { affected: 1 };
      });
    }
  }
  const cancelRace = new CancelRaceAdapter({});
  const cancelRaceResult = await cancelRace.runScript('db', 'UPDATE t SET x = 1', { requestId: 'cancel-race' });
  check('取消与成功返回竞态明确显示结果未知', cancelRaceResult.length === 1
    && /QUERY_OUTCOME_UNKNOWN/.test(cancelRaceResult[0].error || '')
    && /结果未知|可能已经生效/.test(cancelRaceResult[0].error || ''), cancelRaceResult);

  await ad.runScript('main',
    "DELETE FROM users WHERE name IN ('事务提交', '手写提交', '整段回滚', '按钮开始SQL提交')");

  const objs = await ad.listObjects('main');
  check('listObjects', objs.tables.length === 1 && objs.tables[0].name === 'users' && Number(objs.tables[0].rows) === 2);

  const info = await ad.tableInfo('main', null, 'users');
  check('tableInfo 列', info.columns.length === 4);
  check('tableInfo 主键', info.pk.length === 1 && info.pk[0] === 'id');
  check('tableInfo DDL', /CREATE TABLE/i.test(info.ddl));

  const data = await ad.tableData('main', { table: 'users', page: 1, pageSize: 10 });
  check('tableData 总数', data.total === 2);
  check('tableData 主键', data.pk[0] === 'id');
  check('tableData 列元数据包含 COMMENT', data.columns.every((column) =>
    Object.prototype.hasOwnProperty.call(column, 'comment')));

  const dataW = await ad.tableData('main', { table: 'users', page: 1, pageSize: 10, where: 'age > 26', orderBy: 'id', orderDir: 'desc' });
  check('tableData where', dataW.total === 1 && dataW.rows[0][1] === '张三');
  let badPageSizeDenied = false;
  try {
    await ad.tableData('main', { table: 'users', page: 1, pageSize: '1; DROP TABLE users; --', skipCount: true });
  } catch (e) { badPageSizeDenied = /每页行数/.test(e.message); }
  check('tableData 拒绝分页参数 SQL 注入', badPageSizeDenied
    && (await ad.listObjects('main')).tables.some((table) => table.name === 'users'));

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
  check('update 生效', Number(rows[0][2]) === 31 && rows[0][3] === "中文'引号", rows);
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
  check('事务回滚', txnErr !== null && Number(afterTxn[0].rows[0][0]) === 31, txnErr && txnErr.message);

  // 错误语句报告
  const bad = await ad.runScript('main', 'SELECT * FROM not_exists');
  check('错误语句报告', bad.length === 1 && !!bad[0].error);

  // action
  await ad.action('main', { action: 'rename', table: 'users', newName: 'users2' });
  const objs2 = await ad.listObjects('main');
  check('重命名表', objs2.tables[0].name === 'users2');
  await ad.action('main', { action: 'truncate', table: 'users2' });
  const cnt = await ad.runScript('main', 'SELECT COUNT(*) FROM users2');
  check('清空表', Number(cnt[0].rows[0][0]) === 0);
  await ad.action('main', { action: 'dropTable', table: 'users2' });
  const objs3 = await ad.listObjects('main');
  check('删除表', objs3.tables.length === 0);

  await ad.close();
  try { fs.unlinkSync(file); } catch (e) { /* ignore */ }

  // ---- store 加解密 ----
  const store = require('./store');
  const importTag = `NCX-${Date.now()}`;
  const connectionFile = path.join(require('electron').app.getPath('userData'), 'connections.json');
  const originalWriteFileSync = fs.writeFileSync;
  let connectionWrites = 0;
  fs.writeFileSync = function countedWrite(fileName, ...args) {
    if (path.resolve(String(fileName)) === path.resolve(connectionFile)) connectionWrites += 1;
    return originalWriteFileSync.call(this, fileName, ...args);
  };
  let importedBatch;
  try {
    importedBatch = store.importConnections([
      {
        name: importTag, type: 'mysql', host: 'db-one.example', port: 3306,
        user: 'reader', database: 'app', password: ' db-imported-secret ', group: 'Imported',
        ssh: { enabled: true, host: 'jump.example', port: 22, user: 'ops', authType: 'key', keyFile: 'C:\\keys\\ops.pem', password: ' ssh-imported-secret ', passphrase: ' key-imported-secret ' },
      },
      { name: importTag, type: 'postgres', host: 'db-two.example', port: 5432, user: 'reader', database: 'app' },
    ]);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  check('store ncx import persists a batch once', connectionWrites === 1, connectionWrites);
  check('store ncx import renames name conflicts', importedBatch.imported === 2
    && importedBatch.renamed === 1
    && importedBatch.connections.some((item) => item.name === `${importTag} (Navicat)`), importedBatch);
  const importedSecret = store.list().find((item) => item.name === importTag);
  check('store ncx import safely preserves decrypted secrets', importedSecret
    && importedSecret.password === ' db-imported-secret '
    && importedSecret.ssh.password === ' ssh-imported-secret '
    && importedSecret.ssh.passphrase === ' key-imported-secret ', importedSecret);
  const importedPublic = store.listPublic().find((item) => item.name === importTag);
  check('store ncx public preview never exposes imported secrets', importedPublic && importedPublic.hasPassword
    && importedPublic.ssh.hasPassword && importedPublic.ssh.hasPassphrase
    && !Object.prototype.hasOwnProperty.call(importedPublic, 'password')
    && !Object.prototype.hasOwnProperty.call(importedPublic.ssh, 'password')
    && !Object.prototype.hasOwnProperty.call(importedPublic.ssh, 'passphrase'), importedPublic);
  const importedRaw = fs.readFileSync(connectionFile, 'utf8');
  check('store ncx imported secrets are never persisted as plaintext',
    !importedRaw.includes('db-imported-secret')
    && !importedRaw.includes('ssh-imported-secret')
    && !importedRaw.includes('key-imported-secret'));
  const duplicateBatch = store.importConnections([
    {
      name: importTag, type: 'mysql', host: 'db-one.example', port: 3306,
      user: 'reader', database: 'app', group: 'Imported',
      ssh: { enabled: true, host: 'jump.example', port: 22, user: 'ops', authType: 'key', keyFile: 'C:\\keys\\ops.pem' },
    },
  ]);
  check('store ncx import skips exact duplicates', duplicateBatch.imported === 0 && duplicateBatch.skipped === 1, duplicateBatch);
  const duplicatePreview = store.previewImportConnections([
    {
      name: importTag, type: 'mysql', host: 'db-one.example', port: 3306,
      user: 'reader', database: 'app',
      ssh: { enabled: true, host: 'jump.example', port: 22, user: 'ops', authType: 'key', keyFile: 'C:\\keys\\ops.pem' },
    },
    { name: `${importTag}-new`, type: 'sqlite', file: 'C:\\data\\new.db' },
  ]);
  check('store ncx preview marks duplicates without writing', duplicatePreview[0].duplicate === true
    && duplicatePreview[1].duplicate === false, duplicatePreview);
  const upgradeTag = `${importTag}-upgrade`;
  store.importConnections([
    { name: upgradeTag, type: 'mysql', host: 'upgrade.example', port: 3306, user: 'reader', database: 'app' },
  ]);
  const upgradePreview = store.previewImportConnections([
    { name: upgradeTag, type: 'mysql', host: 'upgrade.example', port: 3306, user: 'reader', database: 'app', password: 'auto-filled' },
  ]);
  check('store ncx preview allows filling a missing password', upgradePreview[0].duplicate === false
    && upgradePreview[0].credentialUpdate === true, upgradePreview);
  const upgradedBatch = store.importConnections([
    { name: upgradeTag, type: 'mysql', host: 'upgrade.example', port: 3306, user: 'reader', database: 'app', password: 'auto-filled' },
  ]);
  check('store ncx re-import fills missing credentials without duplicating', upgradedBatch.imported === 0
    && upgradedBatch.updated === 1
    && store.list().find((item) => item.name === upgradeTag).password === 'auto-filled', upgradedBatch);
  for (const item of store.listPublic().filter((entry) => entry.name === importTag
      || entry.name === `${importTag} (Navicat)` || entry.name === upgradeTag)) {
    store.remove(item.id);
  }
  const saved = store.save({ name: '自检', type: 'mysql', host: '127.0.0.1', user: 'CaseUser', password: 'p@ss中文' });
  const got = store.getById(saved.id);
  check('store 密码往返', got.password === 'p@ss中文');
  const publicConn = store.listPublic().find((c) => c.id === saved.id);
  check('store 公共列表不暴露密码', publicConn && publicConn.hasPassword === true && !Object.prototype.hasOwnProperty.call(publicConn, 'password'));
  check('store 旧连接默认将密码保存在本地', publicConn && publicConn.savePassword === true);

  const sessionOnly = store.save({
    name: '会话密码自检', type: 'mysql', host: 'session.example', port: 3306,
    user: 'reader', password: ' session-only-secret ', savePassword: false,
    ssh: { enabled: true, host: 'jump.session.example', port: 22, user: 'ops', authType: 'password', password: 'ssh-stays-saved' },
  });
  let sessionPublic = store.listPublic().find((c) => c.id === sessionOnly.id);
  let sessionRaw = JSON.parse(fs.readFileSync(connectionFile, 'utf8')).find((c) => c.id === sessionOnly.id);
  check('store 会话密码不落盘', sessionRaw && sessionRaw.savePassword === false
    && sessionRaw.password.enc === 'none'
    && !fs.readFileSync(connectionFile, 'utf8').includes('session-only-secret'));
  check('store 会话密码公共状态脱敏', sessionPublic && !sessionPublic.hasPassword
    && sessionPublic.hasSessionPassword && sessionPublic.savePassword === false
    && !Object.prototype.hasOwnProperty.call(sessionPublic, 'password'));
  check('store 会话密码首次连接前可用', store.getById(sessionOnly.id).password === ' session-only-secret '
    && !store.needsSessionPassword(sessionOnly.id));
  check('store 数据库密码开关不影响 SSH 凭据', sessionPublic.ssh.hasPassword
    && store.getById(sessionOnly.id).ssh.password === 'ssh-stays-saved');
  let sessionScopeDenied = false;
  try { store.save({ ...sessionPublic, host: 'other-session.example' }); }
  catch (e) { sessionScopeDenied = /重新输入数据库密码/.test(e.message); }
  check('store 会话密码同样绑定连接作用域', sessionScopeDenied);

  store.clearSessionPasswords();
  sessionPublic = store.listPublic().find((c) => c.id === sessionOnly.id);
  check('store 模拟重启后要求补输会话密码', store.needsSessionPassword(sessionOnly.id)
    && !sessionPublic.hasSessionPassword && store.getById(sessionOnly.id).password === '');
  let promoteWithoutPasswordDenied = false;
  try { store.save({ ...sessionPublic, savePassword: true }); }
  catch (e) { promoteWithoutPasswordDenied = /重新输入.*数据库密码/.test(e.message); }
  check('store 会话密码丢失后不能静默提升为空密码', promoteWithoutPasswordDenied);

  store.setSessionPassword(sessionOnly.id, ' reentered-secret ');
  check('store 补输密码保留首尾空格', store.getById(sessionOnly.id).password === ' reentered-secret ');
  sessionPublic = store.listPublic().find((c) => c.id === sessionOnly.id);
  store.save({ ...sessionPublic, savePassword: true });
  sessionPublic = store.listPublic().find((c) => c.id === sessionOnly.id);
  check('store 会话密码可提升为本地安全保存', sessionPublic.hasPassword && sessionPublic.savePassword
    && !sessionPublic.hasSessionPassword && store.getById(sessionOnly.id).password === ' reentered-secret ');
  store.save({ ...sessionPublic, savePassword: false });
  sessionRaw = JSON.parse(fs.readFileSync(connectionFile, 'utf8')).find((c) => c.id === sessionOnly.id);
  check('store 已保存密码可降级为仅当前会话', sessionRaw.password.enc === 'none'
    && store.getById(sessionOnly.id).password === ' reentered-secret ');
  const sessionImportPreview = store.previewImportConnections([{
    name: '会话密码自检', type: 'mysql', host: 'session.example', port: 3306,
    user: 'reader', password: 'must-not-return-to-disk',
    ssh: { enabled: true, host: 'jump.session.example', port: 22, user: 'ops', authType: 'password' },
  }]);
  const sessionImportResult = store.importConnections([{
    name: '会话密码自检', type: 'mysql', host: 'session.example', port: 3306,
    user: 'reader', password: 'must-not-return-to-disk',
    ssh: { enabled: true, host: 'jump.session.example', port: 22, user: 'ops', authType: 'password' },
  }]);
  sessionRaw = JSON.parse(fs.readFileSync(connectionFile, 'utf8')).find((c) => c.id === sessionOnly.id);
  check('store 重导入不会绕过禁止本地保存选项', sessionImportPreview[0].duplicate
    && sessionImportResult.skipped === 1 && sessionRaw.password.enc === 'none'
    && !fs.readFileSync(connectionFile, 'utf8').includes('must-not-return-to-disk'));
  store.remove(sessionOnly.id);
  check('store 删除连接同时清理会话密码', !store.needsSessionPassword(sessionOnly.id)
    && store.listPublic().every((c) => c.id !== sessionOnly.id));

  const blankSession = store.save({ name: '空密码会话自检', type: 'mysql', host: 'blank.example', user: 'root', password: '' });
  store.save({ ...store.listPublic().find((c) => c.id === blankSession.id), savePassword: false });
  check('store 空密码取消本地保存后首次连接仍可用', !store.needsSessionPassword(blankSession.id)
    && store.listPublic().find((c) => c.id === blankSession.id).hasSessionPassword);
  store.remove(blankSession.id);

  const brokenSaved = store.save({ name: '损坏凭据替换', type: 'mysql', host: '127.0.0.2', user: 'root', password: 'old-secret' });
  const brokenConnectionFile = path.join(require('electron').app.getPath('userData'), 'connections.json');
  const brokenRaw = JSON.parse(fs.readFileSync(brokenConnectionFile, 'utf8'));
  brokenRaw.find((item) => item.id === brokenSaved.id).password = { enc: 'safe', v: 'invalid-safe-storage-payload' };
  fs.writeFileSync(brokenConnectionFile, JSON.stringify(brokenRaw, null, 2), 'utf8');
  const brokenPublic = store.listPublic().find((c) => c.id === brokenSaved.id);
  let replacementHydrated = null;
  try { replacementHydrated = store.hydrateConfig({ ...brokenPublic, password: 'new-secret' }); } catch (e) { /* checked below */ }
  check('store 损坏旧凭据不阻止显式新密码测试', replacementHydrated && replacementHydrated.password === 'new-secret');
  store.save({ ...brokenPublic, password: 'new-secret' });
  check('store 显式新密码可覆盖损坏旧凭据', store.getById(brokenSaved.id).password === 'new-secret');
  store.remove(brokenSaved.id);
  store.save({ ...publicConn, name: '自检-保留密钥' });
  check('store 脱敏编辑保留密码', store.getById(saved.id).password === 'p@ss中文');
  check('store 测试配置恢复密码', store.hydrateConfig(publicConn).password === 'p@ss中文');
  let dbScopeHydrateDenied = false;
  try { store.hydrateConfig({ ...publicConn, host: '203.0.113.10' }); } catch (e) { dbScopeHydrateDenied = /重新输入数据库密码/.test(e.message); }
  check('store 禁止将旧密码代填到新端点', dbScopeHydrateDenied);
  let dbScopeSaveDenied = false;
  try { store.save({ ...publicConn, host: '203.0.113.10' }); } catch (e) { dbScopeSaveDenied = /重新输入数据库密码/.test(e.message); }
  check('store 禁止将旧密码保存到新端点', dbScopeSaveDenied);
  let dbUserCaseDenied = false;
  try { store.hydrateConfig({ ...publicConn, user: 'caseuser' }); }
  catch (e) { dbUserCaseDenied = /重新输入数据库密码/.test(e.message); }
  check('store 数据库用户名大小写变化必须重输密码', dbUserCaseDenied);
  let dbSshRouteDenied = false;
  try {
    store.hydrateConfig({
      ...publicConn,
      ssh: { enabled: true, host: 'attacker-jump.example', port: 22, user: 'relay', authType: 'password', password: '' },
    });
  } catch (e) { dbSshRouteDenied = /重新输入数据库密码/.test(e.message); }
  check('store 禁止经新 SSH 路由复用旧数据库密码', dbSshRouteDenied);
  store.save({ ...publicConn, approvalToken: 'must-not-persist' });
  const persistedConnections = fs.readFileSync(path.join(require('electron').app.getPath('userData'), 'connections.json'), 'utf8');
  check('store 不持久化审批令牌', !persistedConnections.includes('must-not-persist'));
  store.remove(saved.id);
  check('store 删除', store.list().every((c) => c.id !== saved.id));

  const savedMssql = store.save({
    name: '自检mssql', type: 'mssql', host: 'sql.example', port: 1433, user: 'sa',
    password: 'secret', options: { encrypt: true, trustCert: false },
  });
  const publicMssql = store.listPublic().find((c) => c.id === savedMssql.id);
  let mssqlTlsScopeDenied = false;
  try { store.hydrateConfig({ ...publicMssql, options: { encrypt: false, trustCert: true } }); }
  catch (e) { mssqlTlsScopeDenied = /重新输入数据库密码/.test(e.message); }
  check('store SQL Server TLS 策略变化必须重输密码', mssqlTlsScopeDenied);
  store.remove(savedMssql.id);

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
  const publicSsh = store.listPublic().find((c) => c.id === savedSsh.id);
  check('store 公共列表不暴露 SSH 密钥', publicSsh.ssh.hasPassword && publicSsh.ssh.hasPassphrase
    && !Object.prototype.hasOwnProperty.call(publicSsh.ssh, 'password')
    && !Object.prototype.hasOwnProperty.call(publicSsh.ssh, 'passphrase'));
  let sshScopeDenied = false;
  try {
    store.hydrateConfig({ ...publicSsh, ssh: { ...publicSsh.ssh, host: 'other-jump.example' } });
  } catch (e) { sshScopeDenied = /重新输入数据库密码|重新输入 SSH 密码|重新输入私钥口令/.test(e.message); }
  check('store 禁止将旧 SSH 凭据代填到新跳板机', sshScopeDenied);
  const rawTxt = fs.readFileSync(path.join(require('electron').app.getPath('userData'), 'connections.json'), 'utf8');
  check('store ssh 密码不以明文落盘', !rawTxt.includes('sshpw密'));
  store.remove(savedSsh.id);

  // Renderer 文件能力：未经过原生对话框授权的路径不得由 IPC 层读写。
  const fileAccess = require('./fileAccess');
  const capabilityFile = path.join(os.tmpdir(), `dbpanda-file-cap-${Date.now()}.txt`);
  fs.writeFileSync(capabilityFile, 'ok', 'utf8');
  fileAccess.clear();
  let denied = false;
  try { fileAccess.assertAllowed(capabilityFile, 'read'); } catch (e) { denied = /尚未.*授权/.test(e.message); }
  check('file capability 拒绝未授权路径', denied);
  fileAccess.grant(capabilityFile, 'rw');
  check('file capability 放行已授权路径', fileAccess.assertAllowed(capabilityFile, 'read') === capabilityFile
    && fileAccess.assertAllowed(capabilityFile, 'write') === capabilityFile);
  fileAccess.clear();
  fileAccess.grant(capabilityFile, 'r');
  let readOnlyWriteDenied = false;
  try { fileAccess.assertAllowed(capabilityFile, 'write'); } catch (e) { readOnlyWriteDenied = /写入/.test(e.message); }
  check('file capability 只读授权不能写入', readOnlyWriteDenied);
  fileAccess.clear();
  fileAccess.grant(capabilityFile, 'w');
  let writeOnlyReadDenied = false;
  try { fileAccess.assertAllowed(capabilityFile, 'read'); } catch (e) { writeOnlyReadDenied = /读取/.test(e.message); }
  check('file capability 只写授权不能读取', writeOnlyReadDenied);
  fileAccess.clear();
  fileAccess.grant(capabilityFile, 'rw');
  let purposeDenied = false;
  try { fileAccess.assertPurposeAllowed(capabilityFile, 'sqlite'); } catch (e) { purposeDenied = /SQLite 数据库/.test(e.message); }
  check('file capability 通用授权不能升级为 SQLite 路径授权', purposeDenied);
  fileAccess.grantPurpose(capabilityFile, 'sqlite');
  check('file capability SQLite 专用授权生效', fileAccess.assertPurposeAllowed(capabilityFile, 'sqlite') === capabilityFile);
  let crossPurposeDenied = false;
  try { fileAccess.assertPurposeAllowed(capabilityFile, 'ssh-key'); } catch (e) { crossPurposeDenied = /SSH 私钥/.test(e.message); }
  check('file capability 用途之间不能互相升级', crossPurposeDenied);
  let appConfigDenied = false;
  try {
    fileAccess.grant(path.join(require('electron').app.getPath('userData'), 'connections.json'), 'rw');
  } catch (e) { appConfigDenied = /内部配置文件/.test(e.message); }
  check('file capability 拒绝 Renderer 授权应用内部配置', appConfigDenied);
  let workspaceFileDenied = false;
  try {
    fileAccess.grant(path.join(require('electron').app.getPath('userData'), 'workspace-v1.json'), 'rw');
  } catch (e) { workspaceFileDenied = /内部配置文件/.test(e.message); }
  check('file capability 拒绝 Renderer 授权工作区恢复文件', workspaceFileDenied);
  const stableDigest = require('crypto').createHash('sha256').update('ok').digest('hex');
  const fileSnapshot = await fileAccess.snapshot(capabilityFile, stableDigest);
  fs.writeFileSync(capabilityFile, 'changed-after-snapshot', 'utf8');
  check('file capability 私有快照不受原文件后续改写影响', fs.readFileSync(fileSnapshot.path, 'utf8') === 'ok');
  await fileSnapshot.cleanup();
  let changedSnapshotDenied = false;
  try { await fileAccess.snapshot(capabilityFile, stableDigest); }
  catch (e) { changedSnapshotDenied = /审批后发生变化/.test(e.message); }
  check('file capability 快照内容必须匹配审批摘要', changedSnapshotDenied);
  fileAccess.clear();
  try { fs.unlinkSync(capabilityFile); } catch (e) { /* ignore */ }

  // ---- 主进程生产库审批令牌 ----
  const safety = require('./safety');
  const prodConn = store.save({ name: '生产自检', type: 'sqlite', file: 'prod.db', env: 'prod' });
  const devConn = store.save({ name: '开发自检', type: 'sqlite', file: 'dev.db', env: 'dev' });
  const prodPayload = { connId: prodConn.id, db: 'main', sql: 'DELETE FROM users', maxRows: 200 };
  const sender = { sender: { id: 101 } };
  check('safety 主进程识别生产危险 SQL', safety.describe('db.query', prodPayload).required === true);
  check('safety 非生产不要求审批', safety.describe('db.query', { ...prodPayload, connId: devConn.id }).required === false);
  check('safety 生产自由 SQL 即使只读也要求可信审批', safety.describe('db.query', {
    ...prodPayload, sql: 'SELECT * FROM users',
  }).required === true);
  check('safety 拒绝 MySQL 可执行注释绕过', safety.describe('db.query', { ...prodPayload, sql: '/*!50000 DROP TABLE users */' }).required === true);
  check('safety 拒绝 MariaDB 可执行注释绕过', safety.describe('db.query', { ...prodPayload, sql: '/*M! DROP TABLE users */' }).required === true);
  check('safety 拒绝 SQL Server 控制流绕过', safety.describe('db.query', { ...prodPayload, sql: 'IF 1=1 DROP TABLE users' }).required === true);
  check('safety 不把 MySQL 双减号误作注释', safety.describe('db.query', {
    ...prodPayload, sql: "SELECT 1--1 INTO OUTFILE '/tmp/dbpanda-test'",
  }).required === true);
  check('safety 生产查询中的副作用函数必须审批', safety.describe('db.query', {
    ...prodPayload, sql: "SELECT setval('important_seq', 1)",
  }).required === true);
  check('safety 未知自定义函数必须审批', safety.describe('db.query', {
    ...prodPayload, sql: 'SELECT dangerous_security_definer_fn()',
  }).required === true);
  check('safety 生产聚合查询同样要求可信审批', safety.describe('db.query', {
    ...prodPayload, sql: 'SELECT COUNT(*) FROM users',
  }).required === true);
  let whereInjectionDenied = false;
  try { safety.assertWhereFragment('1=1; DROP TABLE users; --'); } catch (e) { whereInjectionDenied = /筛选条件/.test(e.message); }
  check('safety 拒绝筛选条件附加 SQL', whereInjectionDenied);
  let safeWhereAccepted = true;
  try { safety.assertWhereFragment("name = 'a;b'"); } catch (e) { safeWhereAccepted = false; }
  check('safety 允许字符串中的分号', safeWhereAccepted);
  let whereFunctionDenied = false;
  try { safety.assertWhereFragment('pg_terminate_backend(123)'); } catch (e) { whereFunctionDenied = /筛选条件/.test(e.message); }
  check('safety 筛选条件拒绝副作用函数', whereFunctionDenied);
  let qualifiedFunctionDenied = false;
  try { safety.assertWhereFragment('public.count() > 0'); } catch (e) { qualifiedFunctionDenied = /筛选条件/.test(e.message); }
  check('safety 筛选条件拒绝可伪装内建函数的限定名', qualifiedFunctionDenied);
  let unicodeFunctionDenied = false;
  try { safety.assertWhereFragment('危险()'); } catch (e) { unicodeFunctionDenied = /筛选条件/.test(e.message); }
  check('safety 筛选条件拒绝非 ASCII 自定义函数', unicodeFunctionDenied);
  let customOperatorDenied = false;
  try { safety.assertWhereFragment('1 OPERATOR(public.danger) 2'); } catch (e) { customOperatorDenied = /筛选条件/.test(e.message); }
  check('safety 筛选条件拒绝显式自定义运算符', customOperatorDenied);
  let explainInjectionDenied = false;
  try { safety.assertReadOnlyQuery('SELECT 1; DROP TABLE users'); } catch (e) { explainInjectionDenied = /单条只读/.test(e.message); }
  check('safety 执行计划拒绝附加 SQL', explainInjectionDenied);
  check('safety 生产标记降级必须审批', safety.describe('conn.save', { ...prodConn, env: 'dev' }).required === true);
  check('safety 生产会话终止必须审批', safety.describe('db.killProcesses', { connId: prodConn.id, pids: [1, 2] }).required === true);
  check('safety 从生产源生成同步脚本必须审批', safety.describe('dba.dataSync', {
    srcConnId: prodConn.id, dstConnId: devConn.id, mode: 'script', file: 'sync.sql',
  }).required === true);
  let wrongConfirm = false;
  try { safety.issue(sender, 'db.query', prodPayload, '错误连接名'); } catch (e) { wrongConfirm = /不匹配/.test(e.message); }
  check('safety 拒绝错误连接名', wrongConfirm);
  const approval = safety.issue(sender, 'db.query', prodPayload, '生产自检');
  safety.consume(sender, 'db.query', { ...prodPayload, approvalToken: approval });
  let replayDenied = false;
  try { safety.consume(sender, 'db.query', { ...prodPayload, approvalToken: approval }); } catch (e) { replayDenied = /过期|已使用/.test(e.message); }
  check('safety 令牌单次消费', replayDenied);
  const tamperToken = safety.issue(sender, 'db.query', prodPayload, '生产自检');
  let tamperDenied = false;
  try {
    safety.consume(sender, 'db.query', { ...prodPayload, sql: 'DROP TABLE users', approvalToken: tamperToken });
  } catch (e) { tamperDenied = /内容.*不匹配/.test(e.message); }
  check('safety 拒绝审批后篡改参数', tamperDenied);
  const senderToken = safety.issue(sender, 'db.query', prodPayload, '生产自检');
  let senderDenied = false;
  try { safety.consume({ sender: { id: 202 } }, 'db.query', { ...prodPayload, approvalToken: senderToken }); } catch (e) { senderDenied = /来源不匹配/.test(e.message); }
  check('safety 令牌绑定 Renderer', senderDenied);
  const configBoundToken = safety.issue(sender, 'db.query', prodPayload, '生产自检');
  store.save({ ...prodConn, file: 'prod-moved.db' });
  let configSwapDenied = false;
  try { safety.consume(sender, 'db.query', { ...prodPayload, approvalToken: configBoundToken }); }
  catch (e) { configSwapDenied = /内容.*不匹配/.test(e.message); }
  check('safety 令牌绑定连接配置快照', configSwapDenied);
  const dialogFingerprint = safety.fingerprint('db.query', prodPayload);
  store.save({ ...prodConn, file: 'prod-moved-again.db' });
  let approvalWindowSwapDenied = false;
  try { safety.issue(sender, 'db.query', prodPayload, '生产自检', dialogFingerprint); }
  catch (e) { approvalWindowSwapDenied = /审批期间.*已改变/.test(e.message); }
  check('safety 原生确认窗口期间配置变化不会签发新目标令牌', approvalWindowSwapDenied);
  const approvedInput = path.join(os.tmpdir(), `dbpanda-approved-input-${Date.now()}.csv`);
  fs.writeFileSync(approvedInput, 'id,name\n1,AAAA\n', 'utf8');
  const approvedStat = fs.statSync(approvedInput);
  const importPayload = {
    connId: prodConn.id, file: approvedInput, table: 'users', schema: '', truncate: false,
  };
  const fileBoundToken = safety.issue(sender, 'import.run', importPayload, '生产自检');
  fs.writeFileSync(approvedInput, 'id,name\n1,BBBB\n', 'utf8'); // same byte length
  try { fs.utimesSync(approvedInput, approvedStat.atime, approvedStat.mtime); } catch (e) { /* hash remains authoritative */ }
  let fileContentSwapDenied = false;
  try { safety.consume(sender, 'import.run', { ...importPayload, approvalToken: fileBoundToken }); }
  catch (e) { fileContentSwapDenied = /内容与审批不匹配/.test(e.message); }
  check('safety 文件审批绑定 SHA-256 内容而非仅路径和时间戳', fileContentSwapDenied);
  try { fs.unlinkSync(approvedInput); } catch (e) { /* ignore */ }
  store.remove(prodConn.id);
  store.remove(devConn.id);

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

  // ---- SSH 主机密钥与隧道（错误路径，不需要真实 SSH 服务器） ----
  const sshHostKeys = require('./sshHostKeys');
  const fakeHostKey = (algorithm, marker) => {
    const name = Buffer.from(algorithm, 'utf8');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(name.length, 0);
    return Buffer.concat([prefix, name, Buffer.from(marker, 'utf8')]);
  };
  const hostKey1 = fakeHostKey('ssh-ed25519', 'selftest-key-one');
  const hostKey2 = fakeHostKey('ssh-ed25519', 'selftest-key-two');
  const selftestSshHost = `selftest-${process.pid}.invalid`;
  const hostFp = sshHostKeys.fingerprintKey(hostKey1);
  check('ssh 主机密钥生成 OpenSSH 风格 SHA256 指纹', hostFp.algorithm === 'ssh-ed25519'
    && /^SHA256:[A-Za-z0-9+/]+$/.test(hostFp.fingerprint), hostFp);
  check('ssh known-host 规范化主机名', sshHostKeys.endpointId('EXAMPLE.INVALID.', 22022)
    === sshHostKeys.endpointId('example.invalid', 22022));
  let firstPrompt = null;
  const firstTrust = await sshHostKeys.verifyHostKey(selftestSshHost, 22022, hostKey1, {
    confirm: async (details) => { firstPrompt = details; return true; },
  });
  check('ssh 首次连接须确认后才持久信任', firstTrust.accepted && firstTrust.status === 'new'
    && firstPrompt && firstPrompt.status === 'new'
    && sshHostKeys.getKnownHost(selftestSshHost, 22022).fingerprint === hostFp.fingerprint);
  let repeatedPrompt = false;
  const repeatedTrust = await sshHostKeys.verifyHostKey(selftestSshHost.toUpperCase() + '.', 22022, hostKey1, {
    confirm: async () => { repeatedPrompt = true; return false; },
  });
  check('ssh 已知相同指纹自动校验', repeatedTrust.accepted && repeatedTrust.status === 'trusted' && !repeatedPrompt);
  const changedRejected = await sshHostKeys.verifyHostKey(selftestSshHost, 22022, hostKey2, {
    confirm: async (details) => details.status !== 'changed',
  });
  check('ssh 已变更指纹默认拒绝且不覆盖旧记录', !changedRejected.accepted
    && changedRejected.status === 'changed'
    && sshHostKeys.getKnownHost(selftestSshHost, 22022).fingerprint === hostFp.fingerprint);
  const changedAccepted = await sshHostKeys.verifyHostKey(selftestSshHost, 22022, hostKey2, {
    confirm: async (details) => details.status === 'changed',
  });
  check('ssh 已核验的变更指纹可显式更新', changedAccepted.accepted && changedAccepted.status === 'changed'
    && sshHostKeys.getKnownHost(selftestSshHost, 22022).fingerprint
      === sshHostKeys.fingerprintKey(hostKey2).fingerprint);

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

  // 逐请求取消注册表：取消 A 不得污染同一连接上并行的 B。
  const requestRegistry = new SQLiteAdapter({});
  const requestA = requestRegistry._beginRequest({ requestId: 'request-a' });
  const requestB = requestRegistry._beginRequest({ requestId: 'request-b' });
  const handleA = { id: 'a' }, handleB = { id: 'b' };
  requestRegistry._trackRequestHandle(handleA, requestA);
  requestRegistry._trackRequestHandle(handleB, requestB);
  requestRegistry._markRequestCancelled(requestA);
  check('cancel 精确标记单个请求', requestRegistry._requestStates.get(requestA).cancelled === true
    && requestRegistry._requestStates.get(requestB).cancelled === false);
  check('cancel 精确索引活动句柄', requestRegistry._requestHandlesFor(requestA)[0] === handleA
    && requestRegistry._requestHandlesFor(requestB)[0] === handleB);
  let onlyACancelled = false;
  try { requestRegistry._assertRequestActive(requestA); } catch (e) { onlyACancelled = e.code === 'QUERY_CANCELED'; }
  let bStillActive = true;
  try { requestRegistry._assertRequestActive(requestB); } catch (e) { bStillActive = false; }
  check('cancel A 不影响 B', onlyACancelled && bStillActive);
  requestRegistry._untrackRequestHandle(handleA, requestA);
  requestRegistry._untrackRequestHandle(handleB, requestB);
  requestRegistry._endRequest(requestA);
  requestRegistry._endRequest(requestB);
  check('cancel 请求结束后清理注册表', requestRegistry._requestStates.size === 0
    && requestRegistry._requestHandles.size === 0 && requestRegistry._activeRequestHandles.size === 0);
  const queuedRegistry = new SQLiteAdapter({});
  const queuedId = queuedRegistry._beginRequest({ requestId: 'queued-request' });
  let resolveAcquire;
  let lateReleased = false;
  const queuedAcquire = queuedRegistry._acquireForRequest(
    () => new Promise((resolve) => { resolveAcquire = resolve; }),
    () => { lateReleased = true; },
    queuedId,
  );
  await Promise.resolve();
  queuedRegistry._markRequestCancelled(queuedId);
  let queuedCancelled = false;
  try { await queuedAcquire; } catch (e) { queuedCancelled = e.code === 'QUERY_CANCELED'; }
  check('cancel 可立即结束连接池排队请求', queuedCancelled);
  resolveAcquire({ id: 'late-connection' });
  await new Promise((resolve) => setImmediate(resolve));
  check('cancel 自动释放晚到连接', lateReleased);
  queuedRegistry._endRequest(queuedId);

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
  await fakeMy.runScript('d1', `${procSql};\nSELECT 9`);
  check('mysql 过程后续语句继续执行', capturedStmts && capturedStmts.length === 2
    && /CREATE PROCEDURE/.test(capturedStmts[0]) && capturedStmts[1] === 'SELECT 9', capturedStmts);
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
  check('blob clickhouse', ch.blobLiteral(buf) === "unhex('01abff')");
  check('valueLiteral 混合', transfer.valueLiteral(my, null) === 'NULL'
    && transfer.valueLiteral(my, 12.5) === '12.5'
    && transfer.valueLiteral(my, buf) === '0x01abff'
    && transfer.valueLiteral(my, "a'b\\c") === "_utf8mb4 X'6127625c63'");
  check('ClickHouse 复杂值字面量',
    transfer.valueLiteral(ch, [1, 'x', null], 'Array(String)') === "[1, 'x', NULL]"
    && transfer.valueLiteral(ch, { key: 'value' }, 'Map(String, String)') === "map('key', 'value')"
    && transfer.valueLiteral(ch, { key: 1 }, 'JSON') === "'{\"key\":1}'");

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
  check('cmpNum 高精度小数',
    sync.cmpNum('12345678901234567890.123456789012345679', '12345678901234567890.123456789012345678') > 0
    && sync.cmpNum('-0.000000000000000002', '-0.000000000000000001') < 0
    && sync.cmpNum('1e-30', '0.000000000000000000000000000002') < 0);
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
    store2.saveAiConfig({ provider: 'custom', baseUrl: 'https://example.invalid/v1', model: 'test-model', apiKey: 'ai-secret' });
    const aiPublic = store2.getAiConfigPublic();
    check('ai 公共配置不暴露 API Key', aiPublic.hasApiKey === true && !Object.prototype.hasOwnProperty.call(aiPublic, 'apiKey'));
    store2.saveAiConfig({ provider: 'custom', baseUrl: 'https://example.invalid/v1', model: 'test-model-2' });
    check('ai 脱敏编辑保留 API Key', store2.getAiConfig().apiKey === 'ai-secret'
      && store2.hydrateAiConfig(aiPublic).apiKey === 'ai-secret');
    let aiHydrateScopeDenied = false;
    try { store2.hydrateAiConfig({ ...aiPublic, baseUrl: 'https://other.invalid/v1' }); } catch (e) { aiHydrateScopeDenied = /重新输入 API Key/.test(e.message); }
    check('ai 禁止将旧 Key 代填到新接口', aiHydrateScopeDenied);
    let aiSaveScopeDenied = false;
    try {
      store2.saveAiConfig({ provider: 'custom', baseUrl: 'https://other.invalid/v1', model: 'test-model-2' });
    } catch (e) { aiSaveScopeDenied = /重新输入 API Key/.test(e.message); }
    check('ai 禁止将旧 Key 保存到新接口', aiSaveScopeDenied);
    let aiProtocolDenied = false;
    try { store2.normalizeAiBaseUrl('file:///tmp/key'); } catch (e) { aiProtocolDenied = /HTTP\/HTTPS/.test(e.message); }
    check('ai 拒绝非 HTTP 接口', aiProtocolDenied);
  } catch (eAi) { fail++; console.log('  ✗ AI 块异常:', eAi && eAi.stack || eAi); }

  console.log(`[SELFTEST] 通过 ${pass} 项, 失败 ${fail} 项`);
  return fail === 0 ? 0 : 1;
}

module.exports = { runSelfTest };
