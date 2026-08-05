// 定时任务：应用内调度器。
//
// **只在应用运行时生效**——这是刻意的取舍：真正的后台定时要注册到 Windows 任务
// 计划程序，涉及权限与独立进程，先不做。界面上必须把这个前提说清楚，
// 不能让用户以为关掉软件也会自动备份。
//
// 作业定义由主进程持有并校验，渲染进程只能通过白名单字段增删改。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const store = require('./store');
const dbm = require('./db');
const backup = require('./backup');
const dataDict = require('./dataDict');
const settings = require('./settings');
const auditLog = require('./auditLog');

const FILE_NAME = 'schedules-v1.json';
const TICK_MS = 30 * 1000;
const MAX_JOBS = 50;
const KINDS = new Set(['backup', 'dataDict']);
const SCHEDULE_TYPES = new Set(['interval', 'daily', 'weekly']);

let jobs = null;
let timer = null;
let writeTail = Promise.resolve();
let onChange = () => {};

function filePath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

/** 越界或非法时回落到 fallback（适合星期、时分这类「猜不出用户意图」的字段） */
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** 越界时夹到边界（适合间隔这类「用户就是想要尽可能频繁」的字段） */
function clampToRange(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 'HH:MM' → 分钟数；非法值回落到 02:00 */
function parseTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
  if (!match) return 2 * 60;
  const hours = clampInt(match[1], 0, 23, 2);
  const minutes = clampInt(match[2], 0, 59, 0);
  return hours * 60 + minutes;
}

function formatTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 白名单式清洗：渲染进程传来的任何字段都不直接落盘 */
function sanitizeJob(raw, previous) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const kind = KINDS.has(input.kind) ? input.kind : (previous ? previous.kind : 'backup');
  const scheduleType = SCHEDULE_TYPES.has(input.scheduleType)
    ? input.scheduleType
    : (previous ? previous.scheduleType : 'daily');
  return {
    id: (previous && previous.id) || crypto.randomUUID(),
    name: String(input.name || (previous && previous.name) || '未命名任务').slice(0, 120),
    enabled: input.enabled === undefined ? (previous ? previous.enabled : true) : input.enabled === true,
    kind,
    connId: String(input.connId || (previous && previous.connId) || ''),
    db: String(input.db || (previous && previous.db) || ''),
    schema: input.schema ? String(input.schema) : null,
    scheduleType,
    // interval 用分钟；daily/weekly 用当天的时刻
    // 下限 5 分钟是硬约束：再频繁就是在拿数据库当压测目标了
    intervalMinutes: clampToRange(input.intervalMinutes, 5, 60 * 24 * 7,
      (previous && previous.intervalMinutes) || 60),
    atMinutes: input.at !== undefined
      ? parseTime(input.at)
      : (previous && previous.atMinutes !== undefined ? previous.atMinutes : 2 * 60),
    weekday: clampInt(input.weekday, 0, 6, (previous && previous.weekday) || 1),
    // 数据字典专用
    format: ['markdown', 'html', 'xlsx'].includes(input.format)
      ? input.format : ((previous && previous.format) || 'markdown'),
    lastRunAt: (previous && previous.lastRunAt) || null,
    lastStatus: (previous && previous.lastStatus) || null,
    lastMessage: (previous && previous.lastMessage) || '',
    nextRunAt: null,
  };
}

function load() {
  if (jobs) return jobs;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    jobs = Array.isArray(parsed) ? parsed.slice(0, MAX_JOBS).map((item) => sanitizeJob(item, item)) : [];
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      console.error('[scheduler] 读取作业失败，按空列表处理:', error && error.message);
    }
    jobs = [];
  }
  for (const job of jobs) job.nextRunAt = computeNextRun(job, Date.now());
  return jobs;
}

function persist() {
  const text = JSON.stringify(load().map(({ nextRunAt, ...rest }) => rest), null, 2);
  const target = filePath();
  const task = writeTail.catch(() => {}).then(async () => {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, target);
  });
  writeTail = task;
  return task;
}

/** 下一次该跑的时间戳；停用的作业返回 null */
function computeNextRun(job, from) {
  if (!job.enabled) return null;
  const base = new Date(from);
  if (job.scheduleType === 'interval') {
    const last = job.lastRunAt ? new Date(job.lastRunAt).getTime() : from;
    return Math.max(from, last + job.intervalMinutes * 60 * 1000);
  }
  const next = new Date(base);
  next.setSeconds(0, 0);
  next.setHours(Math.floor(job.atMinutes / 60), job.atMinutes % 60, 0, 0);
  if (job.scheduleType === 'weekly') {
    const delta = (job.weekday - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + delta);
  }
  if (next.getTime() <= from) {
    next.setDate(next.getDate() + (job.scheduleType === 'weekly' ? 7 : 1));
  }
  return next.getTime();
}

function publicJob(job) {
  return {
    ...job,
    at: formatTime(job.atMinutes),
    connName: (() => {
      try { return store.getById(job.connId).name; } catch (error) { return ''; }
    })(),
  };
}

function list() {
  return load().map(publicJob);
}

function save(raw) {
  const all = load();
  const previous = raw && raw.id ? all.find((job) => job.id === raw.id) : null;
  if (!previous && all.length >= MAX_JOBS) throw new Error(`定时任务数量已达上限（${MAX_JOBS} 个）`);
  const job = sanitizeJob(raw, previous);
  if (!job.connId) throw new Error('定时任务必须指定连接');
  if (!job.db) throw new Error('定时任务必须指定数据库');
  job.nextRunAt = computeNextRun(job, Date.now());
  if (previous) all[all.indexOf(previous)] = job;
  else all.push(job);
  persist();
  onChange();
  return publicJob(job);
}

function remove(id) {
  const all = load();
  const index = all.findIndex((job) => job.id === id);
  if (index < 0) return false;
  all.splice(index, 1);
  persist();
  onChange();
  return true;
}

/**
 * 执行一个作业。定时执行时连接可能还没打开，这里按需打开——
 * 但如果该连接的密码没有保存在本地，就没法自动连，必须如实报错而不是静默失败。
 */
async function runJob(job, { manual = false } = {}) {
  const startedAt = Date.now();
  let record;
  try { record = store.getById(job.connId); }
  catch (error) { throw new Error('连接不存在或已被删除'); }

  if (!dbm.isOpen(job.connId)) {
    if (store.needsSessionPassword(job.connId)) {
      throw new Error(`连接「${record.name}」未保存密码，定时任务无法自动连接。请在连接设置中勾选保存密码。`);
    }
    await dbm.open(record);
  }
  const adapter = dbm.get(job.connId);

  let summary;
  if (job.kind === 'backup') {
    const result = await backup.create(adapter, {
      connId: job.connId,
      connName: record.name,
      db: job.db,
      schema: job.schema,
      name: job.name,
      includeData: true,
      keep: settings.get('backupKeep'),
    });
    summary = `备份完成：${result.tables} 个表，${Math.round(result.bytes / 1024)} KB`;
  } else if (job.kind === 'dataDict') {
    const ext = job.format === 'xlsx' ? 'xlsx' : (job.format === 'html' ? 'html' : 'md');
    const dir = path.join(app.getPath('userData'), 'exports');
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${job.db}-数据字典-${new Date().toISOString().slice(0, 10)}.${ext}`);
    const result = await dataDict.exportDict(adapter, { db: job.db, schema: job.schema, format: job.format, file });
    summary = `数据字典已导出：${result.tables} 个对象`;
  } else {
    throw new Error(`不支持的作业类型：${job.kind}`);
  }

  auditLog.record({
    channel: 'scheduler:run',
    payload: { connId: job.connId, db: job.db, job: job.name, kind: job.kind, manual },
    ms: Date.now() - startedAt,
    ok: true,
  });
  return summary;
}

async function execute(job, options) {
  const all = load();
  const stored = all.find((item) => item.id === job.id) || job;
  try {
    const summary = await runJob(stored, options);
    stored.lastRunAt = new Date().toISOString();
    stored.lastStatus = 'ok';
    stored.lastMessage = summary;
  } catch (error) {
    stored.lastRunAt = new Date().toISOString();
    stored.lastStatus = 'failed';
    stored.lastMessage = (error && error.message) || String(error);
    auditLog.record({
      channel: 'scheduler:run',
      payload: { connId: stored.connId, db: stored.db, job: stored.name, kind: stored.kind },
      ok: false,
      error: stored.lastMessage,
    });
  }
  stored.nextRunAt = computeNextRun(stored, Date.now());
  persist();
  onChange();
  return publicJob(stored);
}

async function runNow(id) {
  const job = load().find((item) => item.id === id);
  if (!job) throw new Error('作业不存在');
  return execute(job, { manual: true });
}

async function tick() {
  const now = Date.now();
  for (const job of load()) {
    if (!job.enabled) continue;
    if (!job.nextRunAt) { job.nextRunAt = computeNextRun(job, now); continue; }
    if (job.nextRunAt > now) continue;
    // 串行执行：同一时刻多个作业排队跑，避免一起抢连接
    // eslint-disable-next-line no-await-in-loop
    await execute(job, { manual: false });
  }
}

function start(notify) {
  if (typeof notify === 'function') onChange = notify;
  load();
  if (timer) return;
  timer = setInterval(() => { tick().catch((error) => console.error('[scheduler] 调度出错:', error)); }, TICK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { list, save, remove, runNow, start, stop, tick, computeNextRun, filePath };
