// Opt-in integration test against isolated local test databases, never production.
const assert = require('assert/strict');
const { MySQLAdapter } = require('../src/main/db/mysql');
const port = Number(process.env.MYSQL_TEST_PORT || 3308);
const watchdog = setTimeout(() => { console.error('Integration test exceeded 45s'); process.exit(1); }, 45000);
(async () => {
  const ad = new MySQLAdapter({ host: '127.0.0.1', port, user: 'dbpanda', password: 'DbPanda_Test_2026', database: 'dbpanda_test' });
  try {
    await ad.connect();
    console.log(ad.serverVersion);
    assert((await ad.listDatabases()).includes('dbpanda_test'));
    const conn = await ad.pool.getConnection();
    let id;
    try {
      const [rows] = await conn.query('SELECT CONNECTION_ID() AS id');
      id = rows[0].id;
      await conn.query('SET @dbpanda_test_marker = 42');
      await conn.query('SET AUTOCOMMIT = 0');
      await conn.query('CREATE TEMPORARY TABLE dbpanda_reset_probe (id INT)');
    } finally { conn.release(); }
    // Wait until the asynchronous pool reset has finished.
    await new Promise(resolve => setTimeout(resolve, 150));
    const next = await ad.pool.getConnection();
    try {
      const [rows] = await next.query('SELECT CONNECTION_ID() AS id, @dbpanda_test_marker AS marker, @@autocommit AS ac');
      assert.equal(rows[0].id, id, 'connection should be reusable, not silently discarded');
      assert.equal(rows[0].marker, null);
      assert.equal(Number(rows[0].ac), 1);
      await assert.rejects(next.query('SELECT * FROM dbpanda_reset_probe'), e => e.code === 'ER_NO_SUCH_TABLE');
      const [text] = await next.query('SELECT ? AS text', ['中文测试']);
      assert.equal(text[0].text, '中文测试');
      if (/^MySQL 8\./.test(ad.serverVersion)) {
        const [unicode] = await next.query('SELECT ? AS text', ['中文🐼']);
        assert.equal(unicode[0].text, '中文🐼');
      }
    } finally { next.release(); }
    await ad.listObjects('dbpanda_test');
    for (let n = 0; n < 3; n++) await Promise.all(Array.from({ length: 5 }, () => ad.listDatabases()));
    console.log('PASS: metadata, Chinese text, session reset, repeated concurrent queries');
  } finally { await ad.close(); clearTimeout(watchdog); }
})().catch(e => { console.error(e); process.exitCode = 1; });
