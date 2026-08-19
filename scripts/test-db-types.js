// 数据库类型注册表一致性校验
//
// 类型定义分居两处：主进程 src/main/db/index.js 的适配器注册表，渲染层
// src/renderer/js/dbTypes.js 的静态元数据表。渲染层用原生 ES Module、主进程用
// CommonJS，两边无法共用同一个模块，只能靠这个测试保证不漂移——
// 新增类型只改了一边，这里直接失败。
//
// 顺带校验每个类型的字段完整性：漏填 label / icon / cmMode 之类的，
// 界面上表现为"某个类型没有图标""编辑器不高亮"，很难在冒烟测试里发现。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

// ---- 主进程侧：从 db/index.js 的 ADAPTERS 取类型 id ----
// 按文本解析而不是 require：db/index.js 会连带加载 better-sqlite3 等原生模块，
// 那些模块是按 Electron 的 ABI 编译的，纯 node 下加载会失败。
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main/db/index.js'), 'utf8');
const adaptersMatch = /const ADAPTERS = \{([\s\S]*?)\n\};/.exec(mainSrc);
check(!!adaptersMatch, 'src/main/db/index.js 未找到 ADAPTERS 定义');
const mainTypes = adaptersMatch
  ? [...adaptersMatch[1].matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*):/gm)].map((m) => m[1]).sort()
  : [];

// ---- 渲染层侧：dbTypes.js 是 ES Module，用文本解析取出 id 与字段 ----
const src = fs.readFileSync(path.join(ROOT, 'src/renderer/js/dbTypes.js'), 'utf8');

const bodyMatch = /export const DB_TYPES = \{([\s\S]*?)\n\};/.exec(src);
check(!!bodyMatch, 'dbTypes.js 未找到 DB_TYPES 定义');
const body = bodyMatch ? bodyMatch[1] : '';

// 顶层键：行首两个空格 + 标识符 + 冒号 + 花括号
const rendererTypes = [...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*): \{/gm)].map((m) => m[1]).sort();

const orderMatch = /export const TYPE_ORDER = \[([^\]]*)\]/.exec(src);
check(!!orderMatch, 'dbTypes.js 未找到 TYPE_ORDER');
const orderTypes = orderMatch
  ? [...orderMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  : [];

// ---- 三方对齐 ----
const diff = (a, b) => a.filter((x) => !b.includes(x));
check(diff(mainTypes, rendererTypes).length === 0,
  `主进程有但 dbTypes.js 缺少的类型：${diff(mainTypes, rendererTypes).join(', ')}`);
check(diff(rendererTypes, mainTypes).length === 0,
  `dbTypes.js 有但主进程未注册的类型：${diff(rendererTypes, mainTypes).join(', ')}`);
check(diff(rendererTypes, orderTypes.slice().sort()).length === 0,
  `TYPE_ORDER 遗漏的类型：${diff(rendererTypes, orderTypes.slice().sort()).join(', ')}`);
check(diff(orderTypes.slice().sort(), rendererTypes).length === 0,
  `TYPE_ORDER 里有未定义的类型：${diff(orderTypes.slice().sort(), rendererTypes).join(', ')}`);

// ---- 字段完整性 ----
const REQUIRED = ['label', 'icon', 'dialect', 'cmMode', 'formatLang', 'defaults', 'quote', 'backslashEscape', 'caps'];
const REQUIRED_CAPS = ['processes', 'manageDatabase', 'transactions', 'schemas', 'merge'];
const VALID_QUOTES = ['backtick', 'bracket', 'double'];

for (const type of rendererTypes) {
  const entry = new RegExp(`^ {2}${type}: \\{([\\s\\S]*?)\\n {2}\\},`, 'm').exec(body);
  if (!entry) { failures.push(`无法解析类型定义：${type}`); continue; }
  const text = entry[1];
  for (const field of REQUIRED) {
    check(new RegExp(`\\n {4}${field}:`).test(text), `类型 ${type} 缺少字段 ${field}`);
  }
  const quote = /\n {4}quote: '([^']+)'/.exec(text);
  check(quote && VALID_QUOTES.includes(quote[1]),
    `类型 ${type} 的 quote 取值非法（应为 ${VALID_QUOTES.join(' / ')}）`);
  const caps = /\n {4}caps: \{([^}]*)\}/.exec(text);
  if (!caps) { failures.push(`类型 ${type} 的 caps 无法解析`); continue; }
  for (const cap of REQUIRED_CAPS) {
    check(new RegExp(`\\b${cap}: (true|false)`).test(caps[1]),
      `类型 ${type} 的 caps 缺少 ${cap}（必须显式写 true/false，不能靠默认值）`);
  }
}

// ---- 默认端口：主进程 DEFAULT_PORTS 与渲染层 defaults.port 是跨进程的同一份事实 ----
// 两边不一致时，SSH 隧道会连到与界面显示不同的端口上，属于很难查的问题。
const portsMatch = /const DEFAULT_PORTS = \{([^}]*)\}/.exec(mainSrc);
check(!!portsMatch, 'src/main/db/index.js 未找到 DEFAULT_PORTS');
if (portsMatch) {
  const mainPorts = {};
  for (const m of portsMatch[1].matchAll(/([A-Za-z][A-Za-z0-9_]*):\s*(\d+)/g)) mainPorts[m[1]] = Number(m[2]);
  for (const type of rendererTypes) {
    const entry = new RegExp(`^ {2}${type}: \\{([\\s\\S]*?)\\n {2}\\},`, 'm').exec(body);
    const port = entry && /\n {4}defaults: \{[^}]*port: (\d+)/.exec(entry[1]);
    const rendererPort = port ? Number(port[1]) : null;
    if (rendererPort === null) {
      // 文件型数据库（SQLite）没有端口，两边都不该有
      check(mainPorts[type] === undefined,
        `类型 ${type} 在渲染层没有默认端口，但主进程 DEFAULT_PORTS 里有 ${mainPorts[type]}`);
    } else {
      check(mainPorts[type] === rendererPort,
        `类型 ${type} 默认端口不一致：主进程 ${mainPorts[type]}，渲染层 ${rendererPort}`);
    }
  }
}

// ---- 反向守卫：能力已经收敛，就不该再出现散落的类型硬编码数组 ----
const RENDERER_DIR = path.join(ROOT, 'src/renderer/js');
const BANNED = /\[\s*'(?:mysql|postgres|sqlite|mssql|clickhouse|oceanbase|oboracle)'\s*,\s*'(?:mysql|postgres|sqlite|mssql|clickhouse|oceanbase|oboracle)'/;
for (const file of fs.readdirSync(RENDERER_DIR).filter((f) => f.endsWith('.js') && f !== 'dbTypes.js')) {
  const text = fs.readFileSync(path.join(RENDERER_DIR, file), 'utf8');
  check(!BANNED.test(text),
    `${file} 里出现了硬编码的类型数组，应改用 dbTypes.js 的 hasCap() 或其它 helper`);
}

if (failures.length) {
  console.error('数据库类型注册表校验失败：');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`数据库类型注册表校验通过：${rendererTypes.length} 种类型，主进程与渲染层一致`);
