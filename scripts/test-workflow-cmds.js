// CI 工作流里「裸 shell 片段」的语法校验
//
// database-integration.yml 的 adapters-docker job 用 `${{ matrix.ready_cmd }}`
// 把矩阵里的字符串**原样嵌进 bash 脚本**。这类值不是参数、也不带引号，
// 一旦含有 shell 元字符就会在真实 runner 上直接语法错误。
//
// v2.6.3 就踩过：mongodb 的探活命令写成
//   docker exec db mongosh --quiet --eval db.runCommand({ping:1})
// 圆括号被 bash 当成子 shell 语法，CI 报 `syntax error near unexpected token '('`。
// 本地当时只验证了这条命令在 docker 里能跑，没验证它经 YAML 展开后在 bash 里是否成立
// ——这正是本检查要补上的那一环。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, '.github/workflows/database-integration.yml');
const failures = [];

const text = fs.readFileSync(FILE, 'utf8');

// 不引入 YAML 依赖：按缩进取矩阵条目里的 target 与 ready_cmd 即可
const entries = [];
let current = null;
for (const line of text.split(/\r?\n/)) {
  const target = /^\s*-\s*target:\s*(\S+)\s*$/.exec(line);
  if (target) {
    current = { target: target[1], ready: null };
    entries.push(current);
    continue;
  }
  const ready = /^\s*ready_cmd:\s*(.+?)\s*$/.exec(line);
  if (ready && current && !current.ready) current.ready = ready[1];
}

const withReady = entries.filter((e) => e.ready);
if (!withReady.length) {
  failures.push('未在工作流中找到任何 ready_cmd，检查脚本可能已与工作流脱节');
}

/**
 * 找一个真正能用的 bash。
 *
 * Windows 上不能直接用 PATH 里的 `bash`：npm 脚本经 cmd 启动时，它往往解析到
 * 系统自带的 WSL 转发器（C:\Windows\System32\bash.exe）。若 WSL 里没装发行版，
 * 它会报 `CreateProcessCommon: execvpe(/bin/bash) failed`——那是**环境问题**，
 * 却会被当成"语法错误"报出来。这种假阳性比漏报更糟：它会让人以为工作流坏了。
 * 因此显式挑一个能跑通探针的 bash，Git Bash 优先。
 */
function findBash() {
  const candidates = [
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
    '/bin/bash',
    'bash',
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['-n', '-c', 'true'], { stdio: 'pipe' });
      return bin;
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}

const BASH = findBash();

/** bash 能否解析这段脚本（只做语法检查，不执行） */
function bashSyntaxOk(script) {
  try {
    execFileSync(BASH, ['-n', '-c', script], { stdio: 'pipe' });
    return null;
  } catch (err) {
    const stderr = (err.stderr && err.stderr.toString()) || err.message || '';
    return stderr.trim().split('\n')[0];
  }
}

if (!BASH) {
  // CI 跑在 ubuntu 上，bash 必然存在；本地缺 bash 只是环境限制，不该判工作流有错
  console.log('CI 工作流命令校验跳过：本机没有可用的 bash（CI 的 ubuntu runner 上会正常执行）');
  process.exit(0);
}

for (const entry of withReady) {
  // 完全复刻工作流里的用法：裸片段嵌进 if 条件
  const script = `if ${entry.ready} >/dev/null 2>&1; then echo ok; fi`;
  const error = bashSyntaxOk(script);
  if (error) failures.push(`${entry.target} 的 ready_cmd 不是合法的 shell 片段：${error}`);
}

// 反向自检：确认本检查确实能抓到当初那个 bug，而不是永远绿灯
const knownBad = 'if docker exec db mongosh --eval db.runCommand({ping:1}) >/dev/null 2>&1; then echo ok; fi';
if (!bashSyntaxOk(knownBad)) {
  failures.push('本检查失效：已知会报错的括号写法竟然通过了 bash 语法检查');
}

if (failures.length) {
  console.error('CI 工作流命令校验失败：');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`CI 工作流命令校验通过：${withReady.length} 条 ready_cmd 均为合法 shell 片段`);
