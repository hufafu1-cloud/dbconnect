// Renderer 文件能力白名单：只有用户通过原生打开/保存对话框选择过的路径，
// 才能继续通过 IPC 读取或写入。避免一个 Renderer 缺陷直接获得任意文件系统访问权。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const grants = new Map(); // normalized path -> {read, write, ts}
const purposeGrants = new Map(); // purpose -> Map(normalized path -> timestamp)
const MAX_GRANTS = 256;
let snapshotsPruned = false;

function normalize(p) {
  if (!p || typeof p !== 'string') throw new Error('文件路径无效');
  let resolved = path.resolve(p);
  try {
    // 已存在文件解析符号链接；新文件则解析父目录，缩小路径替换攻击面。
    resolved = fs.realpathSync.native(resolved);
  } catch (e) {
    try {
      const parent = fs.realpathSync.native(path.dirname(resolved));
      resolved = path.join(parent, path.basename(resolved));
    } catch (e2) { /* 保存目录可能尚不存在，保留绝对路径 */ }
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertNotAppOwned(p) {
  let userData;
  try { userData = require('electron').app.getPath('userData'); }
  catch (e) { return; }
  const protectedNames = [
    'connections.json', 'ai-config.json', 'ssh-known-hosts.json',
    'groups.json', 'history.json', 'queries.json', 'workspace-v1.json',
  ];
  const key = normalize(p);
  const protectedPaths = new Set(protectedNames.map((name) => normalize(path.join(userData, name))));
  if (protectedPaths.has(key)) {
    throw new Error('应用内部配置文件不能通过 Renderer 文件接口访问');
  }
}

function trim() {
  if (grants.size <= MAX_GRANTS) return;
  const old = [...grants.entries()].sort((a, b) => a[1].ts - b[1].ts);
  for (let i = 0; i < old.length - MAX_GRANTS; i++) grants.delete(old[i][0]);
}

function trimPurpose(records) {
  if (records.size <= MAX_GRANTS) return;
  const old = [...records.entries()].sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < old.length - MAX_GRANTS; i++) records.delete(old[i][0]);
}

function grant(p, mode = 'rw') {
  assertNotAppOwned(p);
  const key = normalize(p);
  const old = grants.get(key) || { read: false, write: false, ts: 0 };
  if (mode.includes('r')) old.read = true;
  if (mode.includes('w')) old.write = true;
  old.ts = Date.now();
  grants.set(key, old);
  trim();
  return p;
}

function assertAllowed(p, mode) {
  assertNotAppOwned(p);
  const rec = grants.get(normalize(p));
  const ok = rec && (mode === 'read' ? rec.read : rec.write);
  if (!ok) throw new Error(`该文件路径尚未通过系统文件对话框授权${mode === 'read' ? '读取' : '写入'}`);
  rec.ts = Date.now();
  return p;
}

/**
 * Purpose grants are deliberately separate from generic read/write grants.
 * Selecting an import file must not also authorize using it as a SQLite database
 * or an SSH identity file.
 */
function grantPurpose(p, purpose) {
  if (!purpose || typeof purpose !== 'string') throw new Error('文件授权用途无效');
  assertNotAppOwned(p);
  const key = normalize(p);
  const records = purposeGrants.get(purpose) || new Map();
  records.set(key, Date.now());
  purposeGrants.set(purpose, records);
  trimPurpose(records);
  return p;
}

function assertPurposeAllowed(p, purpose) {
  assertNotAppOwned(p);
  const records = purposeGrants.get(purpose);
  const key = normalize(p);
  if (!records || !records.has(key)) {
    const label = purpose === 'sqlite' ? 'SQLite 数据库' : purpose === 'ssh-key' ? 'SSH 私钥' : purpose;
    throw new Error(`该路径尚未通过系统文件对话框授权用作${label}`);
  }
  records.set(key, Date.now());
  return p;
}

function clear() {
  grants.clear();
  purposeGrants.clear();
}

async function sha256File(p) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(p);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * Copy an approved input to a private immutable-by-Renderer path. Comparing the
 * copy with the digest bound into the approval closes the consume→parse race.
 */
async function snapshot(p, expectedSha256) {
  assertAllowed(p, 'read');
  const electronApp = require('electron').app;
  const dir = path.join(electronApp.getPath('temp'), 'DBPanda-operation-snapshots');
  await fs.promises.mkdir(dir, { recursive: true });
  if (!snapshotsPruned) {
    snapshotsPruned = true;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const names = await fs.promises.readdir(dir).catch(() => []);
    await Promise.all(names.filter((name) => /^\d+-[a-f0-9]{32}\.snapshot$/.test(name)).map(async (name) => {
      const stale = path.join(dir, name);
      const stat = await fs.promises.stat(stale).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await fs.promises.rm(stale, { force: true }).catch(() => {});
    }));
  }
  const target = path.join(dir, `${process.pid}-${crypto.randomBytes(16).toString('hex')}.snapshot`);
  try {
    await fs.promises.copyFile(p, target, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(target, 0o600).catch(() => {});
    const sha256 = await sha256File(target);
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new Error('文件在审批后发生变化，操作已取消；请重新选择并审批');
    }
    let cleaned = false;
    return {
      path: target,
      sha256,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await fs.promises.rm(target, { force: true }).catch(() => {});
      },
    };
  } catch (e) {
    await fs.promises.rm(target, { force: true }).catch(() => {});
    throw e;
  }
}

module.exports = {
  grant, assertAllowed, grantPurpose, assertPurposeAllowed,
  snapshot, clear, normalize,
};
