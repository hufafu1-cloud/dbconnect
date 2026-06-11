// ClickHouse 适配器在线自检：默认连 ClickHouse 官方公共演示服务 play.clickhouse.com（只读）
// 也可用环境变量指向自己的服务： CH_HOST / CH_PORT / CH_USER / CH_PASSWORD / CH_HTTPS=1
// 运行: node scripts/test-clickhouse.js
const { ClickHouseAdapter } = require('../src/main/db/clickhouse');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail !== undefined ? JSON.stringify(detail) : ''); }
}

(async () => {
  const cfg = {
    id: 'ch-test',
    type: 'clickhouse',
    host: process.env.CH_HOST || 'play.clickhouse.com',
    port: Number(process.env.CH_PORT) || (process.env.CH_HOST ? 8123 : 443),
    user: process.env.CH_USER || 'explorer',
    password: process.env.CH_PASSWORD || '',
    database: 'default',
    options: { https: process.env.CH_HOST ? process.env.CH_HTTPS === '1' : true },
  };
  console.log(`[CH-TEST] 连接 ${cfg.options.https ? 'https' : 'http'}://${cfg.host}:${cfg.port} (user=${cfg.user})`);
  const ad = new ClickHouseAdapter(cfg);
  try {
    await ad.connect();
  } catch (e) {
    console.error('[CH-TEST] 无法连接（网络/服务不可用），跳过在线测试:', e.message);
    process.exit(2);
  }
  console.log('  · 版本:', ad.serverVersion);
  check('版本号', /^ClickHouse \d/.test(ad.serverVersion));

  const dbs = await ad.listDatabases();
  check('listDatabases 含 system', dbs.includes('system'), dbs.slice(0, 5));

  const objs = await ad.listObjects('system');
  const t = objs.tables.find((x) => x.name === 'one');
  check('listObjects system.one', !!t, objs.tables.slice(0, 3).map((x) => x.name));
  check('engine 字段', t && t.engine.length > 0, t);

  const info = await ad.tableInfo('system', null, 'one');
  check('tableInfo 列', info.columns.length === 1 && info.columns[0].name === 'dummy', info.columns);
  check('tableInfo 类型', info.columns[0].type === 'UInt8');
  check('tableInfo 只读(pk空)', info.pk.length === 0);
  check('tableInfo DDL', /CREATE TABLE/i.test(info.ddl) || info.ddl === '', info.ddl.slice(0, 50));

  const data = await ad.tableData('system', { table: 'one', page: 1, pageSize: 10 });
  check('tableData 行数', data.total === 1 && data.rows.length === 1, data);
  check('tableData 只读原因', typeof data.readonlyReason === 'string');

  const res = await ad.runScript('system', `
    SELECT number, toString(number) AS s FROM system.numbers LIMIT 5;
    SELECT '中文;字符串' AS msg, version() AS v;
  `);
  check('runScript 两个结果集', res.length === 2, res.map((r) => r.error || r.rowCount));
  check('结果1 五行', res[0] && res[0].rowCount === 5, res[0]);
  check('结果2 中文含分号', res[1] && res[1].rows[0][0] === '中文;字符串', res[1] && res[1].rows);

  const bad = await ad.runScript('system', 'SELECT * FROM not_exists_xyz');
  check('错误语句报告', bad.length === 1 && !!bad[0].error);

  await ad.close();
  console.log(`[CH-TEST] 通过 ${pass} 项, 失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('[CH-TEST] 异常:', e);
  process.exit(1);
});
