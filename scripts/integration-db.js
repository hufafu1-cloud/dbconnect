'use strict';

// Real-database integration checks for Datavia adapters.
//
// Select targets explicitly:
//   DB_INTEGRATION_TARGETS=mysql,postgres,mssql,clickhouse node scripts/integration-db.js
// Or enable/detect individual targets with MYSQL_ENABLED=1 / MYSQL_HOST=...
// (the same convention applies to POSTGRES, MSSQL, CLICKHOUSE, OCEANBASE and OBORACLE).
// Credentials are read only from <PREFIX>_{HOST,PORT,USER,PASSWORD,DATABASE}.
// Set DB_INTEGRATION_CRUD=1 to create, exercise and remove a uniquely named test table.
// Set DB_INTEGRATION_CANCEL=1 to verify request-scoped cancellation where the
// selected adapter has a short, deterministic cancellation probe.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createAdapter } = require('../src/main/db');
const { exportTable } = require('../src/main/exporter');
const { valueLiteral } = require('../src/main/db/valueLiteral');

const MAIN_TARGETS = ['mysql', 'postgres', 'mssql', 'clickhouse'];
const TARGETS = {
  mysql: { prefix: 'MYSQL', port: 3306, user: 'root' },
  postgres: { prefix: 'POSTGRES', port: 5432, user: 'postgres', database: 'postgres' },
  mssql: { prefix: 'MSSQL', port: 1433, user: 'sa', database: 'tempdb' },
  clickhouse: { prefix: 'CLICKHOUSE', port: 8123, user: 'default', database: 'default' },
  oceanbase: { prefix: 'OCEANBASE', port: 2881, user: 'root@sys' },
  oboracle: { prefix: 'OBORACLE', port: 2881, user: 'SYS' },
};

const ALIASES = {
  pg: 'postgres',
  postgresql: 'postgres',
  sqlserver: 'mssql',
  'sql-server': 'mssql',
  ch: 'clickhouse',
  obmysql: 'oceanbase',
  'oceanbase-mysql': 'oceanbase',
  'oceanbase-oracle': 'oboracle',
};

function env(name, fallback) {
  return process.env[name] === undefined ? fallback : process.env[name];
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be one of 1/0, true/false, yes/no or on/off`);
}

function intEnv(name, fallback, min = 1) {
  const raw = env(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer greater than or equal to ${min}`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTarget(value) {
  const key = String(value).trim().toLowerCase();
  return ALIASES[key] || key;
}

function selectedTargets() {
  const raw = env('DB_INTEGRATION_TARGETS', '').trim();
  let selected;

  if (raw) {
    selected = raw.split(',').map(normalizeTarget).filter(Boolean);
    if (selected.includes('all')) {
      selected = selected.filter((target) => target !== 'all').concat(MAIN_TARGETS);
    }
  } else {
    selected = Object.entries(TARGETS)
      .filter(([, meta]) => boolEnv(`${meta.prefix}_ENABLED`, false) || process.env[`${meta.prefix}_HOST`] !== undefined)
      .map(([target]) => target);
  }

  selected = [...new Set(selected)];
  const unknown = selected.filter((target) => !TARGETS[target]);
  if (unknown.length) throw new Error(`Unknown database target(s): ${unknown.join(', ')}`);
  if (!selected.length) {
    throw new Error(
      'No database targets selected. Set DB_INTEGRATION_TARGETS or a <PREFIX>_ENABLED/<PREFIX>_HOST variable.',
    );
  }
  return selected;
}

function buildConfig(type) {
  const meta = TARGETS[type];
  const prefix = meta.prefix;
  const config = {
    id: `integration-${type}-${process.pid}`,
    type,
    host: env(`${prefix}_HOST`, '127.0.0.1'),
    port: intEnv(`${prefix}_PORT`, meta.port),
    user: env(`${prefix}_USER`, meta.user),
    password: env(`${prefix}_PASSWORD`, ''),
  };
  const database = env(`${prefix}_DATABASE`, meta.database || '');
  if (database) config.database = database;

  if (type === 'mssql') {
    config.options = {
      encrypt: boolEnv('MSSQL_ENCRYPT', false),
      trustCert: boolEnv('MSSQL_TRUST_CERT', true),
    };
  } else if (type === 'clickhouse') {
    config.options = { https: boolEnv('CLICKHOUSE_HTTPS', false) };
  }
  return config;
}

function safeError(error, password) {
  let message = error && error.message ? error.message : String(error);
  if (password) message = message.split(password).join('[redacted]');
  return message;
}

async function safeClose(adapter) {
  if (!adapter) return;
  try {
    await adapter.close();
  } catch (_) {
    // A failed connection can leave a partially initialized driver. The original
    // connection error is more useful than a secondary close error.
  }
}

async function connectWithRetry(type, config, attempts, retryMs) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const adapter = createAdapter({ ...config, options: { ...(config.options || {}) } });
    try {
      await adapter.connect();
      return adapter;
    } catch (error) {
      lastError = error;
      await safeClose(adapter);
      const detail = safeError(error, config.password);
      if (attempt === attempts) break;
      console.warn(`[${type}] connection attempt ${attempt}/${attempts} failed: ${detail}; retrying in ${retryMs} ms`);
      await sleep(retryMs);
    }
  }
  throw lastError;
}

function resultRows(result, label) {
  const candidate = result && result.multi
    ? result.multi.find((item) => item && Array.isArray(item.rows))
    : result;
  if (!candidate || !Array.isArray(candidate.rows)) {
    throw new Error(`${label} did not return a row set`);
  }
  return candidate.rows;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findField(row, name) {
  const key = Object.keys(row || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : row[key];
}

function probeDatabase(type, config, databases) {
  if (config.database) {
    return databases.find((name) => String(name).toLowerCase() === String(config.database).toLowerCase())
      || config.database;
  }
  if (type === 'oboracle') {
    const user = String(config.user || '').split('@')[0];
    const ownSchema = databases.find((name) => String(name).toLowerCase() === user.toLowerCase());
    if (ownSchema) return ownSchema;
  }
  const nonSystem = databases.find((name) => ![
    'information_schema', 'mysql', 'performance_schema', 'sys', 'system',
  ].includes(String(name).toLowerCase()));
  return nonSystem || databases[0];
}

function defaultSchema(type, schemas) {
  if (type === 'postgres') {
    return schemas.find((name) => String(name).toLowerCase() === 'public') || schemas[0] || 'public';
  }
  if (type === 'mssql') return 'dbo';
  return null;
}

async function metadataCheck(adapter, type, config) {
  const databases = await adapter.listDatabases();
  assert(Array.isArray(databases) && databases.length > 0, 'listDatabases returned no databases');
  const database = probeDatabase(type, config, databases);
  assert(database, 'could not choose a database for metadata checks');

  const listedSchemas = await adapter.listSchemas(database);
  assert(listedSchemas === null || Array.isArray(listedSchemas), 'listSchemas returned an invalid value');
  const schemas = listedSchemas || [];
  const schema = defaultSchema(type, schemas);
  const objects = await adapter.listObjects(database, schema);
  assert(objects && Array.isArray(objects.tables), 'listObjects did not return a tables array');
  assert(Array.isArray(objects.views), 'listObjects did not return a views array');
  return { database, schema, databases: databases.length, schemas: schemas.length, objects };
}

function rowLimitSql(type) {
  switch (type) {
    case 'postgres':
      return 'SELECT generate_series(1, 5) AS datavia_probe ORDER BY datavia_probe';
    case 'mssql':
      return 'SELECT datavia_probe FROM (VALUES (1), (2), (3), (4), (5)) AS datavia_rows(datavia_probe) ORDER BY datavia_probe';
    case 'clickhouse':
      return 'SELECT number + 1 AS datavia_probe FROM numbers(5) ORDER BY datavia_probe';
    case 'oboracle':
      return 'SELECT LEVEL AS "datavia_probe" FROM dual CONNECT BY LEVEL <= 5 ORDER BY LEVEL';
    default:
      return 'SELECT datavia_probe FROM (SELECT 1 AS datavia_probe UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) AS datavia_rows ORDER BY datavia_probe';
  }
}

function singleQueryResult(results, label) {
  assert(Array.isArray(results) && results.length === 1, `${label} returned ${results && results.length} results`);
  const result = results[0];
  assert(!result.error, `${label} failed: ${result.error || 'unknown error'}`);
  assert(Array.isArray(result.rows), `${label} did not return rows`);
  return result;
}

async function rowLimitCheck(adapter, type, database) {
  const sql = rowLimitSql(type);
  const prepared = adapter._prepareScriptQuery(sql, { maxRows: 2 });
  assert(prepared && prepared.applied, 'maxRows probe was not rewritten for server-side limiting');

  const capped = singleQueryResult(
    await adapter.runScript(database, sql, { maxRows: 2, requestId: `limit-${type}-${process.pid}` }),
    'capped SELECT',
  );
  assert(capped.rows.length === 2, `capped SELECT returned ${capped.rows.length} rows instead of 2`);
  assert(capped.rowCount === 2, `capped SELECT rowCount was ${capped.rowCount} instead of 2`);
  assert(capped.rowCountExact === false, 'capped SELECT did not mark rowCount as inexact');
  assert(capped.truncated === true, 'capped SELECT did not report truncation');
  assert(Number(capped.rows[0][0]) === 1 && Number(capped.rows[1][0]) === 2, 'capped SELECT returned unexpected rows');

  const complete = singleQueryResult(
    await adapter.runScript(database, sql, { maxRows: 10, requestId: `exact-${type}-${process.pid}` }),
    'complete SELECT',
  );
  assert(complete.rows.length === 5 && complete.rowCount === 5, 'complete SELECT returned an unexpected row count');
  assert(complete.rowCountExact === true, 'complete SELECT did not mark rowCount as exact');
  assert(complete.truncated === false, 'complete SELECT incorrectly reported truncation');
}

function cancellationSql(type) {
  switch (type) {
    case 'mysql':
    case 'oceanbase': return 'SELECT SLEEP(5) AS datavia_cancel_probe';
    case 'postgres': return 'SELECT pg_sleep(5) AS datavia_cancel_probe';
    case 'mssql': return "WAITFOR DELAY '00:00:05'; SELECT 1 AS datavia_cancel_probe";
    case 'clickhouse': return 'SELECT sleep(3) AS datavia_cancel_probe';
    default: return null;
  }
}

async function waitForRequestHandle(adapter, requestId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (adapter._requestHandlesFor(requestId).length > 0) return;
    await sleep(25);
  }
  throw new Error('cancellation probe did not register an active request handle');
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then((value) => ({ value }), (error) => ({ error })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`cancellation did not settle within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cancellationCheck(adapter, type, database) {
  const sql = cancellationSql(type);
  if (!sql) return false;
  const requestId = `cancel-${type}-${process.pid}-${Date.now()}`;
  const pending = adapter.runScript(database, sql, { maxRows: 10, requestId });
  await waitForRequestHandle(adapter, requestId);
  // Let the long-running statement reach the driver/server before issuing the
  // cancellation. This exercises the driver-specific cancel handle rather than
  // only the pre-execution cancelled-state check.
  await sleep(200);
  const cancelledAt = Date.now();
  const settled = await settleWithin((async () => {
    await adapter.cancel(requestId);
    return pending.then(
      (value) => ({ pendingValue: value }),
      (error) => ({ pendingError: error }),
    );
  })(), 6000);
  if (settled.error) throw new Error(`cancel request failed: ${settled.error.message || settled.error}`);
  const pendingOutcome = settled.value;
  const results = pendingOutcome && pendingOutcome.pendingValue;
  const cancellationError = (pendingOutcome && pendingOutcome.pendingError)
    || (Array.isArray(results) && results.find((result) => result && result.error));
  assert(cancellationError, 'cancellation probe completed successfully instead of being cancelled');
  assert(Date.now() - cancelledAt < 6000, 'cancellation probe exceeded its time bound');
  await baselineSelect(adapter, type, database);
  return true;
}

async function baselineSelect(adapter, type, database) {
  const sql = type === 'oboracle'
    ? 'SELECT 1 AS "datavia_probe" FROM dual'
    : 'SELECT 1 AS datavia_probe';
  const rows = resultRows(await adapter.exec(database, sql), 'baseline SELECT');
  assert(rows.length === 1 && Number(rows[0][0]) === 1, 'baseline SELECT returned an unexpected value');
}

async function tableMetadataCheck(adapter, type, database, tableName) {
  const schema = defaultSchema(type, []);
  const objects = await adapter.listObjects(database, schema);
  const listed = objects.tables.find((table) => String(table.name).toLowerCase() === tableName.toLowerCase());
  assert(listed, 'created table was not returned by listObjects');
  const effectiveSchema = (listed && listed.schema) || schema;
  const info = await adapter.tableInfo(database, effectiveSchema, tableName);
  assert(info && Array.isArray(info.columns), 'tableInfo did not return columns');
  assert(Array.isArray(info.indexes), 'tableInfo did not return indexes');
  assert(Array.isArray(info.pk), 'tableInfo did not return a primary-key array');
  assert(typeof info.ddl === 'string', 'tableInfo did not return DDL text');
  const names = info.columns.map((column) => String(column.name).toLowerCase());
  assert(names.includes('id') && names.includes('note'), 'tableInfo did not return the test table columns');
  assert(info.pk.some((name) => String(name).toLowerCase() === 'id'), 'tableInfo did not identify the test table primary key');
}

async function exportCheck(adapter, type, database, tableName) {
  const file = path.join(os.tmpdir(), `datavia-export-${type}-${process.pid}-${Date.now()}.json`);
  try {
    const result = await exportTable(adapter, {
      db: database,
      schema: defaultSchema(type, []),
      table: tableName,
      format: 'json',
      file,
    });
    assert(result.rows === 2 && result.truncated === false, 'raw table export returned unexpected metadata');
    const rows = JSON.parse(await fs.readFile(file, 'utf8'));
    assert(Array.isArray(rows) && rows.length === 2, 'raw table export returned an unexpected row count');
    const first = rows.find((row) => Number(findField(row, 'id')) === 1);
    const second = rows.find((row) => Number(findField(row, 'id')) === 2);
    assert(first && String(findField(first, 'note')) === 'alpha', 'raw table export first row mismatch');
    assert(second && String(findField(second, 'note')) === 'beta', 'raw table export second row mismatch');
    if (type === 'mysql' || type === 'oceanbase') {
      assert(String(findField(first, 'payload')).includes('9007199254740993'), 'MySQL JSON export lost a 64-bit value');
      assert(String(findField(first, 'exact_num')) === '12345678901234567890.123456789012345678', 'MySQL DECIMAL export lost precision');
    } else if (type === 'postgres') {
      assert(String(findField(first, 'payload')).includes('9007199254740993'), 'PostgreSQL JSONB export lost a 64-bit value');
      assert(String(findField(first, 'exact_num')) === '12345678901234567890.123456789012345678', 'PostgreSQL NUMERIC export lost precision');
      assert(String(findField(first, 'exact_nums')).includes('98765432109876543210.123456789012345678'), 'PostgreSQL NUMERIC[] export lost precision');
      assert(String(findField(first, 'exact_times')).includes('123456'), 'PostgreSQL TIMESTAMP[] export lost sub-millisecond precision');
    } else if (type === 'mssql') {
      assert(String(findField(first, 'exact_num')) === '12345678901234567890.123456789012345678', 'SQL Server DECIMAL export lost precision');
      assert(String(findField(first, 'exact_time')).includes('1234567'), 'SQL Server DATETIME2 export lost precision');
      assert(String(findField(first, 'offset_at')).includes('+08:00'), 'SQL Server DATETIMEOFFSET export lost its source offset');
    } else if (type === 'clickhouse') {
      assert(String(findField(first, 'exact_num')) === '12345678901234567890.123456789012345678', 'ClickHouse Decimal export lost precision');
      assert(String(findField(first, 'wide_id')) === '9007199254740993', 'ClickHouse UInt64 export lost precision');
    }
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

function crudPlan(type, adapter, database, name) {
  const table = adapter.qualify(database, type === 'mssql' ? 'dbo' : null, name);
  const id = adapter.quoteIdent('id');
  const note = adapter.quoteIdent('note');
  let create;
  let update = `UPDATE ${table} SET ${note} = 'gamma' WHERE ${id} = 2`;
  let remove = `DELETE FROM ${table} WHERE ${id} = 1`;
  let drop = `DROP TABLE IF EXISTS ${table}`;

  if (type === 'clickhouse') {
    create = `CREATE TABLE ${table} (${id} UInt32, ${note} String, exact_num Decimal(38,18), wide_id UInt64) ENGINE = MergeTree ORDER BY ${id}`;
    update = `ALTER TABLE ${table} UPDATE ${note} = 'gamma' WHERE ${id} = 2 SETTINGS mutations_sync = 2`;
    remove = `ALTER TABLE ${table} DELETE WHERE ${id} = 1 SETTINGS mutations_sync = 2`;
  } else if (type === 'mssql') {
    create = `CREATE TABLE ${table} (${id} INT NOT NULL PRIMARY KEY, ${note} NVARCHAR(100) NOT NULL, exact_num DECIMAL(38,18), exact_time DATETIME2(7), offset_at DATETIMEOFFSET(7))`;
    drop = `IF OBJECT_ID(N'dbo.${name}', N'U') IS NOT NULL DROP TABLE ${table}`;
  } else if (type === 'oboracle') {
    create = `CREATE TABLE ${table} (${id} NUMBER(10) NOT NULL PRIMARY KEY, ${note} VARCHAR2(100) NOT NULL)`;
    drop = `DROP TABLE ${table}`;
  } else if (type === 'postgres') {
    create = `CREATE TABLE ${table} (${id} INT NOT NULL PRIMARY KEY, ${note} VARCHAR(100) NOT NULL, payload JSONB, exact_num NUMERIC(38,18), exact_nums NUMERIC[], exact_times TIMESTAMP(6)[])`;
  } else if (type === 'mysql' || type === 'oceanbase') {
    create = `CREATE TABLE ${table} (${id} INT NOT NULL PRIMARY KEY, ${note} VARCHAR(100) NOT NULL, payload JSON, exact_num DECIMAL(38,18))`;
  } else {
    create = `CREATE TABLE ${table} (${id} INT NOT NULL PRIMARY KEY, ${note} VARCHAR(100) NOT NULL)`;
  }

  let insert;
  if (type === 'oboracle') {
    insert = `INSERT INTO ${table} (${id}, ${note}) SELECT 1, 'alpha' FROM dual UNION ALL SELECT 2, 'beta' FROM dual`;
  } else if (type === 'mysql' || type === 'oceanbase') {
    insert = `INSERT INTO ${table} (${id}, ${note}, payload, exact_num) VALUES `
      + `(1, 'alpha', '{"id":9007199254740993}', 12345678901234567890.123456789012345678), `
      + `(2, 'beta', '{"id":2}', -0.000000000000000001)`;
  } else if (type === 'postgres') {
    insert = `INSERT INTO ${table} (${id}, ${note}, payload, exact_num, exact_nums, exact_times) VALUES `
      + `(1, 'alpha', '{"id":9007199254740993}'::jsonb, 12345678901234567890.123456789012345678, `
      + `ARRAY[98765432109876543210.123456789012345678::numeric], ARRAY['2024-01-02 03:04:05.123456'::timestamp]), `
      + `(2, 'beta', '{"id":2}'::jsonb, -0.000000000000000001, ARRAY[1::numeric], ARRAY['2024-01-02'::timestamp])`;
  } else if (type === 'mssql') {
    insert = `INSERT INTO ${table} (${id}, ${note}, exact_num, exact_time, offset_at) VALUES `
      + `(1, N'alpha', 12345678901234567890.123456789012345678, '2024-01-02T03:04:05.1234567', '2024-01-02T03:04:05.1234567+08:00'), `
      + `(2, N'beta', -0.000000000000000001, '2024-01-02T03:04:05.0000001', '2024-01-02T03:04:05.0000001+00:00')`;
  } else if (type === 'clickhouse') {
    insert = `INSERT INTO ${table} (${id}, ${note}, exact_num, wide_id) VALUES `
      + `(1, 'alpha', 12345678901234567890.123456789012345678, 9007199254740993), `
      + `(2, 'beta', -0.000000000000000001, 2)`;
  } else {
    insert = `INSERT INTO ${table} (${id}, ${note}) VALUES (1, 'alpha'), (2, 'beta')`;
  }

  return {
    create,
    insert,
    readInserted: `SELECT ${id}, ${note} FROM ${table} ORDER BY ${id}`,
    update,
    readUpdated: `SELECT ${note} FROM ${table} WHERE ${id} = 2`,
    remove,
    readCount: `SELECT COUNT(*) FROM ${table}`,
    drop,
  };
}

async function crudCheck(adapter, type, config) {
  if ((type === 'mysql' || type === 'oceanbase') && !config.database) {
    throw new Error(`${TARGETS[type].prefix}_DATABASE is required when CRUD checks are enabled`);
  }

  const suffix = `${Date.now().toString(36)}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const tableName = `datavia_it_${suffix}`;
  const plan = crudPlan(type, adapter, config.database, tableName);

  await adapter.withSession(config.database, async (run) => {
    let created = false;
    let failure;
    try {
      await run(plan.create);
      created = true;
      await tableMetadataCheck(adapter, type, config.database, tableName);
      await run(plan.insert);

      if (type === 'mysql' || type === 'oceanbase') {
        await run("SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'NO_BACKSLASH_ESCAPES')");
        const modeValue = "mode\\path'quoted";
        const modeRows = resultRows(await run(`SELECT ${valueLiteral(adapter, modeValue)} AS exact_text`), 'NO_BACKSLASH_ESCAPES literal');
        assert(modeRows.length === 1 && modeRows[0][0] === modeValue, 'mode-independent MySQL data literal changed text');
      }

      const inserted = resultRows(await run(plan.readInserted), 'CRUD insert/read');
      assert(
        inserted.length === 2
          && Number(inserted[0][0]) === 1 && String(inserted[0][1]) === 'alpha'
          && Number(inserted[1][0]) === 2 && String(inserted[1][1]) === 'beta',
        'insert/read verification failed',
      );
      await exportCheck(adapter, type, config.database, tableName);

      await run(plan.update);
      const updated = resultRows(await run(plan.readUpdated), 'CRUD update/read');
      assert(updated.length === 1 && String(updated[0][0]) === 'gamma', 'update verification failed');

      await run(plan.remove);
      const remaining = resultRows(await run(plan.readCount), 'CRUD delete/read');
      assert(remaining.length === 1 && Number(remaining[0][0]) === 1, 'delete verification failed');
    } catch (error) {
      failure = error;
    }

    let cleanupFailure;
    if (created) {
      try {
        await run(plan.drop);
      } catch (error) {
        cleanupFailure = error;
      }
    }

    if (failure) {
      if (cleanupFailure) {
        failure.message += `; cleanup also failed: ${safeError(cleanupFailure, config.password)}`;
      }
      throw failure;
    }
    if (cleanupFailure) throw cleanupFailure;
  });
}

async function runTarget(type, globalCrud, globalCancel, attempts, retryMs) {
  const config = buildConfig(type);
  const prefix = TARGETS[type].prefix;
  const crud = boolEnv(`${prefix}_CRUD`, globalCrud);
  const cancel = boolEnv(`${prefix}_CANCEL`, globalCancel);
  const location = `${config.user}@${config.host}:${config.port}/${config.database || '(driver default)'}`;
  console.log(`[${type}] connecting to ${location}`);

  let adapter;
  const started = Date.now();
  try {
    adapter = await connectWithRetry(type, config, attempts, retryMs);
    console.log(`[${type}] connected: ${adapter.serverVersion || 'version unavailable'}`);
    await baselineSelect(adapter, type, config.database);
    console.log(`[${type}] baseline SELECT passed`);
    const metadata = await metadataCheck(adapter, type, config);
    console.log(`[${type}] metadata passed (${metadata.databases} databases, ${metadata.schemas} schemas, ${metadata.objects.tables.length} tables)`);
    await rowLimitCheck(adapter, type, metadata.database);
    console.log(`[${type}] server-side maxRows and rowCountExact passed`);
    if (crud) {
      const crudConfig = { ...config, database: metadata.database };
      await crudCheck(adapter, type, crudConfig);
      console.log(`[${type}] CRUD, metadata, raw export and cleanup passed`);
    } else {
      console.log(`[${type}] CRUD skipped (set ${prefix}_CRUD=1 or DB_INTEGRATION_CRUD=1 to enable)`);
    }
    if (cancel) {
      const checked = await cancellationCheck(adapter, type, metadata.database);
      if (checked) console.log(`[${type}] request-scoped cancellation passed`);
      else console.log(`[${type}] cancellation skipped (no deterministic probe for this adapter)`);
    } else {
      console.log(`[${type}] cancellation skipped (set ${prefix}_CANCEL=1 or DB_INTEGRATION_CANCEL=1 to enable)`);
    }
    return { type, ok: true, ms: Date.now() - started };
  } catch (error) {
    return { type, ok: false, ms: Date.now() - started, error: safeError(error, config.password) };
  } finally {
    await safeClose(adapter);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/integration-db.js

Environment:
  DB_INTEGRATION_TARGETS  Comma-separated mysql,postgres,mssql,clickhouse,
                          oceanbase,oboracle ("all" means the first four)
  DB_INTEGRATION_CRUD     Enable disposable-table CRUD checks (default: 0)
  DB_INTEGRATION_CANCEL   Enable bounded request-scoped cancellation checks (default: 0)
  DB_INTEGRATION_RETRIES  Connection attempts (default: 15)
  DB_INTEGRATION_RETRY_MS Delay between attempts in milliseconds (default: 2000)
  <PREFIX>_HOST           Also auto-selects a target when no target list is set
  <PREFIX>_ENABLED        Explicitly auto-selects a target
  <PREFIX>_PORT/USER/PASSWORD/DATABASE
  <PREFIX>_CRUD           Per-target CRUD override
  <PREFIX>_CANCEL         Per-target cancellation override

Extra options: MSSQL_ENCRYPT, MSSQL_TRUST_CERT and CLICKHOUSE_HTTPS.
OceanBase targets are opt-in and are never included by "all".`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const targets = selectedTargets();
  const globalCrud = boolEnv('DB_INTEGRATION_CRUD', false);
  const globalCancel = boolEnv('DB_INTEGRATION_CANCEL', false);
  const attempts = intEnv('DB_INTEGRATION_RETRIES', 15);
  const retryMs = intEnv('DB_INTEGRATION_RETRY_MS', 2000, 0);
  console.log(`[db-integration] targets=${targets.join(',')} crud=${globalCrud} cancel=${globalCancel} attempts=${attempts}`);

  const results = [];
  for (const target of targets) {
    results.push(await runTarget(target, globalCrud, globalCancel, attempts, retryMs));
  }

  console.log('\n[db-integration] summary');
  for (const result of results) {
    if (result.ok) console.log(`  PASS ${result.type} (${result.ms} ms)`);
    else console.error(`  FAIL ${result.type} (${result.ms} ms): ${result.error}`);
  }

  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[db-integration] fatal: ${safeError(error, '')}`);
    process.exitCode = 1;
  });
}

module.exports = {
  metadataCheck,
  rowLimitCheck,
  crudCheck,
  cancellationCheck,
};
