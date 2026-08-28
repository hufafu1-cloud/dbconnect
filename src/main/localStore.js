// 本地加密快照存储（v2.7.0 共用地基 M1）
//
// 路线图的硬约束：**本地落盘的行数据一律走这里的加密存储，不得明文落在 userData 下；
// 存进去的必须是明文原值**（不能截断、不能格式化——见「两条通用数据流结论」第 2 条，
// 搬运物被改写的后果是回滚把错的值写回数据库，不是显示不好看）。
//
// ── 为什么是信封加密而不是直接用 safeStorage ──────────────────────────
//
// store.js 用 safeStorage 逐条加密密码，那是对的：密码短、条数少。
// 但这里存的是「一次 UPDATE 影响的几万行原值」，动辄几十 MB。safeStorage 是
// 面向小串的 OS 钥匙串接口，拿它加密大块数据既慢又不合用途。
//
// 所以用标准信封：随机生成一把 32 字节数据密钥，**用 safeStorage 把这把钥匙包起来**
// 存进 key.json，真正的大块数据用 AES-256-GCM 加密。钥匙的安全性仍然完全由
// 操作系统的安全存储保证，与密码同级。
//
// safeStorage 不可用时**直接拒绝写入**，绝不退化成明文或可逆编码——
// 与 store.js 拒绝保存凭据是同一条底线。
//
// ── 每条快照两个文件 ──────────────────────────────────────────────
//
//   <bucket>/<id>.meta   头信息（表名、SQL 摘要、行数、主键…），小
//   <bucket>/<id>.rows   行数据，大
//
// 分开是为了「回滚中心」列个表不必把几万行全解出来——列表只读 .meta。
// 两个文件都加密：表名和 SQL 摘要同样可能带敏感信息。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

const DIR_NAME = 'local-store';
const KEY_FILE = 'key.json';
const FORMAT = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// 配额：三条同时生效，任何一条超了都清最老的
const DEFAULT_QUOTA = Object.freeze({
  keep: 50,                       // 每个 bucket 保留份数
  days: 14,                       // 保留天数
  bytes: 512 * 1024 * 1024,       // 每个 bucket 总字节上限
});

let cachedKey = null;

function rootDir() {
  return path.join(app.getPath('userData'), DIR_NAME);
}

function bucketDir(bucket) {
  const name = String(bucket || '');
  if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(name)) throw new Error('无效的存储分区名: ' + name);
  return path.join(rootDir(), name);
}

/** safeStorage 是否可用——不可用时整个功能必须明确关闭，而不是偷偷降级 */
function available() {
  try { return safeStorage.isEncryptionAvailable(); } catch (e) { return false; }
}

function assertAvailable() {
  if (!available()) {
    throw new Error('系统安全存储不可用，无法加密保存本地快照。'
      + '为避免把数据库中的原始数据明文写到磁盘，该功能已停用。');
  }
}

/** 取数据密钥；没有就生成一把并用 safeStorage 包好存起来 */
function dataKey() {
  if (cachedKey) return cachedKey;
  assertAvailable();
  const keyPath = path.join(rootDir(), KEY_FILE);
  let hadKeyFile = false;
  try {
    const text = fs.readFileSync(keyPath, 'utf8');
    hadKeyFile = true;
    const saved = JSON.parse(text);
    if (saved && saved.enc === 'safe' && typeof saved.v === 'string') {
      const raw = safeStorage.decryptString(Buffer.from(saved.v, 'base64'));
      const key = Buffer.from(raw, 'base64');
      if (key.length === 32) { cachedKey = key; return key; }
    }
  } catch (e) { /* 没有、损坏或换了机器：下面重新生成 */ }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(rootDir(), { recursive: true });
  fs.writeFileSync(keyPath, JSON.stringify({
    enc: 'safe',
    v: safeStorage.encryptString(key.toString('base64')).toString('base64'),
  }), { mode: 0o600 });
  // 只有「原本有钥匙、但这把钥匙已经用不了」才清空旧密文——它们再也解不开，
  // 留着只会占地方也解释不清。首次生成时什么都没有，绝不能顺手清：
  // put() 是先建分区目录再惰性取钥匙的，误清会把刚建好的目录一起删掉。
  if (hadKeyFile) {
    for (const entry of listBuckets()) {
      try { fs.rmSync(bucketDir(entry), { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }
  cachedKey = key;
  return key;
}

function listBuckets() {
  try {
    return fs.readdirSync(rootDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (e) { return []; }
}

function seal(value) {
  const key = dataKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT]), iv, cipher.getAuthTag(), body]);
}

function unseal(buffer) {
  if (!buffer || buffer.length < 1 + IV_BYTES + TAG_BYTES) throw new Error('快照文件已损坏');
  if (buffer[0] !== FORMAT) throw new Error('快照文件版本不受支持: ' + buffer[0]);
  const key = dataKey();
  const iv = buffer.subarray(1, 1 + IV_BYTES);
  const tag = buffer.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = buffer.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
}

const newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
const metaPath = (bucket, id) => path.join(bucketDir(bucket), `${id}.meta`);
const rowsPath = (bucket, id) => path.join(bucketDir(bucket), `${id}.rows`);

const ID_RE = /^[a-z0-9]+-[0-9a-f]{12}$/;
function assertId(id) {
  if (!ID_RE.test(String(id || ''))) throw new Error('无效的快照 ID');
  return String(id);
}

/**
 * 写入一条快照。meta 与 rows 分开加密：列表页只解 meta，不必把几万行都解出来。
 * 返回 {id, bytes}。
 */
function put(bucket, meta, rows, quota) {
  assertAvailable();
  dataKey();                       // 先把钥匙准备好：它可能会清理目录
  const dir = bucketDir(bucket);
  fs.mkdirSync(dir, { recursive: true });
  const id = newId();
  const rowsBuf = seal({ rows: rows || [] });
  const metaBuf = seal({
    ...(meta || {}),
    id,
    createdAt: Date.now(),
    rowCount: Array.isArray(rows) ? rows.length : 0,
  });
  // 先写行数据再写头：中途断电时留下的是一个没有头的孤儿行文件，
  // 会被 list 忽略并由 prune 清掉；反过来则会出现「列表里有、点开却没有」。
  fs.writeFileSync(rowsPath(bucket, id), rowsBuf, { mode: 0o600 });
  fs.writeFileSync(metaPath(bucket, id), metaBuf, { mode: 0o600 });
  const bytes = rowsBuf.length + metaBuf.length;
  prune(bucket, quota);
  return { id, bytes };
}

/**
 * 按调用方指定的 id 写入（可覆盖）。
 *
 * put() 每次生成新 id，适合「一次操作存一份」的快照（后悔药）。
 * 结构历史不一样：它是「每张表一条、不断往里追加版本」的，需要就地更新，
 * 否则同一张表会散成几百个文件，光是列个时间线就要解上几百次密。
 */
function putAt(bucket, id, meta, rows, quota) {
  assertAvailable();
  assertId(id);
  dataKey();
  const dir = bucketDir(bucket);
  fs.mkdirSync(dir, { recursive: true });
  const rowsBuf = seal({ rows: rows || [] });
  const metaBuf = seal({
    ...(meta || {}),
    id,
    createdAt: Date.now(),
    rowCount: Array.isArray(rows) ? rows.length : 0,
  });
  fs.writeFileSync(rowsPath(bucket, id), rowsBuf, { mode: 0o600 });
  fs.writeFileSync(metaPath(bucket, id), metaBuf, { mode: 0o600 });
  if (quota) prune(bucket, quota);
  return { id, bytes: rowsBuf.length + metaBuf.length };
}

/** 某个 id 是否已存在 */
function has(bucket, id) {
  try { assertId(id); return fs.existsSync(metaPath(bucket, id)); } catch (e) { return false; }
}

/** 列出快照头（按时间倒序）。解不开的条目直接跳过并顺手删掉，不让它卡住整个列表。 */
function list(bucket) {
  const dir = bucketDir(bucket);
  let files;
  try { files = fs.readdirSync(dir).filter((name) => name.endsWith('.meta')); }
  catch (e) { return []; }
  const out = [];
  for (const file of files) {
    const id = file.slice(0, -'.meta'.length);
    try {
      const meta = unseal(fs.readFileSync(path.join(dir, file)));
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(dir, file)).size + fs.statSync(rowsPath(bucket, id)).size;
      } catch (e) { continue; }   // 行文件不在了，这条快照已经没用
      out.push({ ...meta, id, bytes });
    } catch (e) {
      try { remove(bucket, id); } catch (e2) { /* ignore */ }
    }
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** 读一条完整快照（含行数据） */
function read(bucket, id) {
  assertId(id);
  const meta = unseal(fs.readFileSync(metaPath(bucket, id)));
  const body = unseal(fs.readFileSync(rowsPath(bucket, id)));
  return { ...meta, id, rows: (body && body.rows) || [] };
}

function remove(bucket, id) {
  assertId(id);
  let removed = false;
  for (const file of [metaPath(bucket, id), rowsPath(bucket, id)]) {
    try { fs.rmSync(file, { force: true }); removed = true; } catch (e) { /* ignore */ }
  }
  return removed;
}

function clear(bucket) {
  const items = list(bucket);
  for (const item of items) remove(bucket, item.id);
  return items.length;
}

/** 占用情况：界面上要能看见，也要能一键清空 */
function usage(bucket) {
  const items = list(bucket);
  return {
    entries: items.length,
    bytes: items.reduce((sum, item) => sum + (item.bytes || 0), 0),
    oldestAt: items.length ? items[items.length - 1].createdAt : null,
    newestAt: items.length ? items[0].createdAt : null,
  };
}

/** 按份数 / 天数 / 总字节自动清理，三条任意一条超了都从最老的开始删 */
function prune(bucket, quota) {
  const limits = { ...DEFAULT_QUOTA, ...(quota || {}) };
  const items = list(bucket);                       // 已按时间倒序
  const doomed = new Set();
  const deadline = Date.now() - limits.days * 24 * 3600 * 1000;
  items.forEach((item, index) => {
    if (index >= limits.keep) doomed.add(item.id);
    if ((item.createdAt || 0) < deadline) doomed.add(item.id);
  });
  let total = items.reduce((sum, item) => sum + (item.bytes || 0), 0);
  for (let i = items.length - 1; i >= 0 && total > limits.bytes; i--) {
    if (doomed.has(items[i].id)) continue;
    doomed.add(items[i].id);
    total -= items[i].bytes || 0;
  }
  for (const id of doomed) remove(bucket, id);
  return doomed.size;
}

/** 仅供自检：换一个根目录并丢掉缓存的密钥 */
function _resetForTests() {
  cachedKey = null;
}

module.exports = {
  available, put, putAt, has, list, read, remove, clear, usage, prune,
  rootDir, DEFAULT_QUOTA, _resetForTests,
};
