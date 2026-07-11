// Crash-recovery workspace store. Drafts are kept outside localStorage so large
// SQL buffers are not silently dropped by Chromium's small per-origin quota.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE_NAME = 'workspace-v1.json';
const MAX_WORKSPACE_BYTES = 128 * 1024 * 1024;
let writeTail = Promise.resolve();
let tempSequence = 0;

function filePath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function encode(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('工作区快照格式无效');
  }
  const text = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_WORKSPACE_BYTES) {
    throw new Error(`工作区草稿过大（${Math.ceil(bytes / 1024 / 1024)} MB），已保留上一次可用快照；请先保存或拆分大型 SQL 文件`);
  }
  return { text, bytes };
}

async function atomicWrite(text) {
  const target = filePath();
  const dir = path.dirname(target);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${++tempSequence}`;
  try {
    await fs.promises.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
    await fs.promises.rename(tmp, target);
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

async function read() {
  await writeTail.catch(() => {});
  const target = filePath();
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_WORKSPACE_BYTES) {
      throw new Error('工作区恢复文件超过安全上限，未自动载入');
    }
    const text = await fs.promises.readFile(target, 'utf8');
    try {
      return JSON.parse(text);
    } catch (error) {
      const backup = `${target}.corrupt-${Date.now()}`;
      await fs.promises.rename(target, backup).catch(() => {});
      console.error(`[workspace] 恢复文件损坏，已备份到 ${backup}:`, error && error.message);
      return null;
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function write(snapshot) {
  const encoded = encode(snapshot);
  const task = writeTail.catch(() => {}).then(() => atomicWrite(encoded.text));
  writeTail = task;
  return task.then(() => ({ bytes: encoded.bytes }));
}

function clear() {
  const task = writeTail.catch(() => {}).then(() => fs.promises.unlink(filePath()).catch((error) => {
    if (!error || error.code !== 'ENOENT') throw error;
  }));
  writeTail = task;
  return task;
}

module.exports = { read, write, clear, MAX_WORKSPACE_BYTES };
