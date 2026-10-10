// Run with Electron's Node runtime, not the CI host's newer Node.
const assert = require('assert/strict');
const http = require('http');
const { chat, test } = require('../src/main/ai');
require('../src/main/navicatCrypto');
for (const name of ['mysql2', 'pg', 'mongodb', 'mssql', 'oracledb', '@clickhouse/client', 'ioredis', 'dmdb']) require(name);
const Database = require('better-sqlite3');
const db = new Database(':memory:');
assert.equal(db.prepare('select 1 as value').get().value, 1);
db.close();
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    assert.equal(req.headers.authorization, 'Bearer local-test');
    if (JSON.parse(body).stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"model":"test","choices":[{"message":{"content":"你好"}}]}');
    }
  });
});
server.listen(0, '127.0.0.1', async () => {
  try {
    const cfg = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-test', model: 'test' };
    assert.equal((await test(cfg)).reply, '你好');
    let streamed = '';
    assert.equal(await chat(cfg, [], { onDelta: d => { streamed += d; } }), '你好');
    assert.equal(streamed, '你好');
    console.log(`Runtime checks passed: Electron ${process.versions.electron}, Node ${process.versions.node}, drivers, SQLite, AI JSON/SSE.`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
