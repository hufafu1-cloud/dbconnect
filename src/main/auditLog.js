// 操作审计日志。
//
// 埋点只有一处：ipc.js 里的 h() 包装器——几乎所有数据库操作都从那一个函数穿过去，
// 所以这里不需要在几十个 handler 里逐个插代码，后面新增的功能（备份还原、定时任务）
// 也会自动被记录，不用回头补。
//
// 本步骤只负责「记下来」，查看界面留到后面做。日志只写在本机 userData 目录下。
//
// 安全约束：密码、私钥口令、AI API Key 一律不得进入日志。参数摘要走白名单式裁剪，
// 命中敏感键名直接替换为 '[已隐去]'，而不是依赖调用方记得不要传。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE_NAME = 'audit.log';
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 3;
const MAX_STRING = 512;
const MAX_SQL = 2000;
const MAX_DEPTH = 4;

// 敏感键名：命中即隐去（大小写不敏感，子串匹配）
const SECRET_KEY = /pass|secret|token|key|credential|confirmation|privatekey/i;
// API Key 之外的 'key' 误伤保护：这些键名含 key 但并不敏感
const SECRET_ALLOW = /^(keyFile|sortKey|orderKey|primaryKey|keys|keyword)$/i;

// 高频只读通道：成功时不记，避免日志被目录树的懒加载刷屏；失败仍然记录
const QUIET_CHANNELS = new Set([
  'conn:list', 'groups:list',
  'db:databases', 'db:schemas', 'db:objects', 'db:tableInfo', 'db:allColumns',
  'db:objectCaps', 'db:routines', 'db:triggers', 'db:events', 'db:sequences',
  'db:foreignKeys', 'db:transactionStatus', 'db:aiContext',
  'design:meta', 'design:model', 'design:ddl',
  'workspace:read', 'workspace:write', 'workspace:clear',
  'settings:read', 'ai:getConfig',
  'app:info', 'app:winCmd', 'app:update-check',
  'history:list', 'sql:format', 'sql:statementAt',
  'safety:inspect',
]);

let writeTail = Promise.resolve();
let disabled = false;

function filePath(index = 0) {
  const base = path.join(app.getPath('userData'), FILE_NAME);
  return index ? `${base}.${index}` : base;
}

function isSecretKey(key) {
  if (SECRET_ALLOW.test(key)) return false;
  return SECRET_KEY.test(key);
}

function clip(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}…(${s.length})` : s;
}

/** 参数摘要：隐去敏感字段、截断长文本、限制深度，避免把整个结果集写进日志 */
function summarize(value, depth = 0, key = '') {
  if (value === null || value === undefined) return value === null ? null : undefined;
  if (typeof value === 'string') return clip(value, /sql/i.test(key) ? MAX_SQL : MAX_STRING);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length}]`;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((item) => summarize(item, depth + 1, key));
    return value.length > 20 ? [...head, `…共 ${value.length} 项`] : head;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) { out[k] = '[已隐去]'; continue; }
      const s = summarize(v, depth + 1, k);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

async function rotateIfNeeded() {
  const target = filePath();
  let size = 0;
  try { size = (await fs.promises.stat(target)).size; }
  catch (error) { if (error && error.code === 'ENOENT') return; throw error; }
  if (size < MAX_BYTES) return;
  await fs.promises.unlink(filePath(KEEP_FILES)).catch(() => {});
  for (let i = KEEP_FILES - 1; i >= 1; i--) {
    await fs.promises.rename(filePath(i), filePath(i + 1)).catch(() => {});
  }
  await fs.promises.rename(target, filePath(1)).catch(() => {});
}

async function append(line) {
  const target = filePath();
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await rotateIfNeeded();
  await fs.promises.appendFile(target, `${line}\n`, 'utf8');
}

/**
 * 记录一次 IPC 调用。永远不抛错、不阻塞调用方——审计写失败不能拖垮正常功能，
 * 但会在控制台留一条，并停用后续写入，避免每次调用都刷同一个错误。
 */
function record(entry) {
  if (disabled) return;
  const channel = String(entry && entry.channel || '');
  const ok = entry && entry.ok !== false;
  if (ok && QUIET_CHANNELS.has(channel)) return;
  let line;
  try {
    const payload = entry && entry.payload;
    const summary = summarize(payload, 0, '');
    line = JSON.stringify({
      at: new Date().toISOString(),
      channel,
      connId: payload && typeof payload === 'object' ? payload.connId : undefined,
      db: payload && typeof payload === 'object' ? payload.db : undefined,
      approved: entry && entry.approvalOperation ? entry.approvalOperation : undefined,
      ms: Number.isFinite(entry && entry.ms) ? Math.round(entry.ms) : undefined,
      ok,
      error: ok ? undefined : clip((entry && entry.error) || '', MAX_STRING),
      args: summary && typeof summary === 'object' ? summary : undefined,
    });
  } catch (error) {
    return; // 序列化失败（循环引用等）宁可丢这一条，也不影响主流程
  }
  writeTail = writeTail.catch(() => {}).then(() => append(line)).catch((error) => {
    disabled = true;
    console.error('[audit] 审计日志写入失败，已停用本次会话的审计:', error && error.message);
  });
}

/** 等待已排队的写入落盘（退出前/测试用） */
function flush() {
  return writeTail.catch(() => {});
}

/**
 * 读取最近的审计记录，**新的在前**。
 *
 * 从当前文件往回读，不够再翻滚动出去的旧文件，读满 limit 条为止——
 * 不会因为日志攒到几十 MB 就把整个历史加载进内存。
 * 解析不了的行直接跳过：日志是追加写的，进程被杀可能留下半行。
 */
async function read({ limit = 5000 } = {}) {
  const max = Math.max(1, Math.min(50000, Number(limit) || 5000));
  const entries = [];
  let unparsable = 0;
  for (let index = 0; index <= KEEP_FILES && entries.length < max; index++) {
    let text;
    try { text = await fs.promises.readFile(filePath(index), 'utf8'); }
    catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && entries.length < max; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try { entries.push(JSON.parse(line)); }
      catch (error) { unparsable++; }
    }
  }
  return { entries, unparsable, file: filePath() };
}

module.exports = { record, flush, read, filePath, QUIET_CHANNELS };
