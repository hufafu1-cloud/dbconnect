// 第一步「地基」的自检：命令注册表 / 设置中心 / 审计日志。
//
// 这三样都是后面每一步都要依赖的基础设施，坏了不会立刻在界面上看出来，
// 所以在这里用断言把它们的关键约束钉住。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}: ${error && error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}: ${error && error.message}`);
  }
}

/**
 * 以 ES Module 方式载入渲染进程的源码（渲染层没有打包器，这里照 test-workspace.js 的做法）。
 * data: URL 会按源码文本缓存模块实例，所以每次都掺一个不同的注释，
 * 保证各用例拿到互不干扰的新实例（模块级缓存不会串到下一个用例）。
 */
let importSalt = 0;
async function importRenderer(file) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', file), 'utf8');
  const salted = `${source}\n// test-instance-${++importSalt}\n`;
  return import(`data:text/javascript;base64,${Buffer.from(salted).toString('base64')}`);
}

/** 把 electron 的 app.getPath 顶掉，好让主进程模块写到临时目录里 */
function stubElectron(userDataDir) {
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { app: { getPath: () => userDataDir } },
  };
}

const keyEvent = (key, { ctrl = false, shift = false, alt = false } = {}) =>
  ({ key, ctrlKey: ctrl, shiftKey: shift, altKey: alt });

// ---------------------------------------------------------------- 命令注册表
async function testCommands() {
  console.log('\n[命令注册表]');
  const cmd = await importRenderer('commands.js');
  const calls = [];

  cmd.registerCommands([
    { id: 'new-conn', label: '新建连接…', menu: '文件', accel: 'Ctrl+N', run: () => calls.push('new-conn') },
    { id: 'new-query', label: '新建查询', menu: '文件', accel: 'Ctrl+Q', run: () => calls.push('new-query') },
    { id: 'exit', label: '退出', menu: '文件', sepBefore: true, run: () => calls.push('exit') },
    { id: 'edit-undo', label: '撤销', menu: '编辑', accel: 'Ctrl+Z', bind: false, run: () => calls.push('undo') },
    { id: 'editor-find', label: '在编辑器中查找…', menu: '编辑', accel: 'Ctrl+F', bind: false, run: () => {} },
    { id: 'refresh', label: '刷新', menu: '查看', accel: 'F5', scope: 'notInEditor', enabled: () => false, run: () => calls.push('refresh') },
    { id: 'design-table', label: '设计表', menu: '查看', accel: 'Ctrl+D', scope: 'notInInput', run: () => {} },
    { id: 'search', label: '在库中查找…', menu: '工具', accel: 'Ctrl+F', scope: 'notInEditor', run: () => calls.push('search') },
    { id: 'next-tab', label: '下一个标签页', menu: '窗口', accel: 'Ctrl+Tab', run: () => calls.push('next') },
    { id: 'prev-tab', label: '上一个标签页', menu: '窗口', accel: 'Ctrl+Shift+Tab', run: () => calls.push('prev') },
    { id: 'processes', label: '进程列表', run: () => calls.push('processes') }, // 不进菜单
  ]);

  check('重复注册同一个 ID 会立刻报错', () => {
    assert.throws(() => cmd.registerCommands([{ id: 'new-conn', label: '重复', run: () => {} }]), /重复注册/);
  });

  check('菜单按首次登记顺序排列', () => {
    assert.deepStrictEqual(cmd.menuNames(), ['文件', '编辑', '查看', '工具', '窗口']);
  });

  check('不带 menu 的命令不出现在菜单里', () => {
    const all = cmd.menuNames().flatMap((name) => cmd.commandsForMenu(name)).map((c) => c.id);
    assert.ok(!all.includes('processes'));
    assert.ok(cmd.getCommand('processes'), '但仍然可以按 id 取到并执行');
  });

  check('sepBefore 标记被保留给菜单渲染', () => {
    const file = cmd.commandsForMenu('文件');
    assert.deepStrictEqual(file.map((c) => c.id), ['new-conn', 'new-query', 'exit']);
    assert.strictEqual(file[2].sepBefore, true);
  });

  check('快捷键文本解析', () => {
    assert.deepStrictEqual(cmd.parseAccel('Ctrl+Shift+F'), { ctrl: true, shift: true, alt: false, key: 'f' });
    assert.deepStrictEqual(cmd.parseAccel('F5'), { ctrl: false, shift: false, alt: false, key: 'f5' });
  });

  // 这条是整个重构要守住的东西：菜单上标了什么键，按下去就必须是同一条命令。
  check('每个可绑定命令的 accel 都能反查回它自己', () => {
    for (const c of cmd.allCommands()) {
      if (!c.accel || c.bind === false) continue;
      const a = cmd.parseAccel(c.accel);
      const matched = cmd.matchShortcut(keyEvent(a.key, { ctrl: a.ctrl, shift: a.shift, alt: a.alt }), {});
      assert.ok(matched, `${c.id} 的 ${c.accel} 没有匹配到任何命令`);
      assert.strictEqual(matched.id, c.id, `${c.accel} 匹配到了 ${matched.id} 而不是 ${c.id}`);
    }
  });

  check('Ctrl+Tab 与 Ctrl+Shift+Tab 不会互相串台', () => {
    assert.strictEqual(cmd.matchShortcut(keyEvent('Tab', { ctrl: true }), {}).id, 'next-tab');
    assert.strictEqual(cmd.matchShortcut(keyEvent('Tab', { ctrl: true, shift: true }), {}).id, 'prev-tab');
  });

  check('bind:false 的快捷键不做全局绑定（Ctrl+Z 交给浏览器）', () => {
    assert.strictEqual(cmd.matchShortcut(keyEvent('z', { ctrl: true }), {}), null);
  });

  check('编辑器内的 Ctrl+F 归 CodeMirror，不触发「在库中查找」', () => {
    assert.strictEqual(cmd.matchShortcut(keyEvent('f', { ctrl: true }), { inEditor: true, inInput: true }), null);
    assert.strictEqual(cmd.matchShortcut(keyEvent('f', { ctrl: true }), {}).id, 'search');
  });

  check('notInInput 的命令在普通输入框里不触发', () => {
    assert.strictEqual(cmd.matchShortcut(keyEvent('d', { ctrl: true }), { inInput: true }), null);
    assert.strictEqual(cmd.matchShortcut(keyEvent('d', { ctrl: true }), {}).id, 'design-table');
  });

  check('enabled() 只影响菜单灰不灰，快捷键照样触发', () => {
    assert.strictEqual(cmd.isEnabled('refresh'), false);
    assert.strictEqual(cmd.matchShortcut(keyEvent('F5'), {}).id, 'refresh');
  });

  await checkAsync('runCommand 会把上下文传给 run()', async () => {
    let seen = null;
    cmd.registerCommands([{ id: 'ctx-probe', label: '探针', run: (ctx) => { seen = ctx; } }]);
    cmd.setCommandContextProvider(() => ({ target: { connId: 'c1', db: 'demo' } }));
    await cmd.runCommand('ctx-probe');
    assert.deepStrictEqual(seen, { target: { connId: 'c1', db: 'demo' } });
  });

  await checkAsync('未注册的命令不会抛错', async () => {
    assert.strictEqual(await cmd.runCommand('does-not-exist'), false);
  });

  check('出厂键位没有冲突', () => {
    assert.deepStrictEqual(cmd.accelConflicts(), []);
  });

  check('键位方案能改键位，也能改作用域', () => {
    cmd.applyKeymap({ refresh: { accel: 'F5', scope: 'global' }, 'design-table': 'Ctrl+Shift+D' });
    assert.strictEqual(cmd.getCommand('refresh').scope, 'global');
    assert.strictEqual(cmd.getCommand('design-table').accel, 'Ctrl+Shift+D');
    // 作用域放开后，编辑器里按 F5 也应当命中
    assert.strictEqual(cmd.matchShortcut(keyEvent('F5'), { inEditor: true, inInput: true }).id, 'refresh');
  });

  check('切回默认方案会完整还原出厂键位与作用域', () => {
    cmd.applyKeymap({});
    assert.strictEqual(cmd.getCommand('refresh').scope, 'notInEditor');
    assert.strictEqual(cmd.getCommand('design-table').accel, 'Ctrl+D');
    assert.strictEqual(cmd.matchShortcut(keyEvent('F5'), { inEditor: true, inInput: true }), null);
  });

  check('方案里可以取消某个命令的快捷键', () => {
    cmd.applyKeymap({ 'design-table': null });
    assert.strictEqual(cmd.getCommand('design-table').accel, '');
    assert.strictEqual(cmd.matchShortcut(keyEvent('d', { ctrl: true }), {}), null);
    cmd.applyKeymap({});
  });

  check('能检出抢同一个键的命令', () => {
    cmd.applyKeymap({ 'design-table': 'Ctrl+Q' }); // 与 new-query 相撞
    const conflicts = cmd.accelConflicts();
    assert.strictEqual(conflicts.length, 1);
    assert.deepStrictEqual(conflicts[0].ids.sort(), ['design-table', 'new-query']);
    cmd.applyKeymap({});
  });

  // 作用域不能用来「错开」两个命令：三种作用域在焦点位于树/网格时都会生效。
  // 真正错开编辑器内外的机制是 bind:false。
  check('作用域不同但都在普通区域生效，仍算冲突', () => {
    // design-table 是 notInInput，search 是 notInEditor，焦点在树/网格时两者都会响应
    cmd.applyKeymap({ 'design-table': 'Ctrl+F' });
    const conflicts = cmd.accelConflicts();
    assert.strictEqual(conflicts.length, 1);
    assert.deepStrictEqual(conflicts[0].ids.sort(), ['design-table', 'search']);
    cmd.applyKeymap({});
  });

  check('bind:false 的命令不参与冲突判定（编辑器内的 Ctrl+F）', () => {
    // editor-find 与 search 都标着 Ctrl+F，但前者 bind:false，交给 CodeMirror
    assert.deepStrictEqual(cmd.accelConflicts(), []);
    assert.strictEqual(cmd.getCommand('editor-find').accel, 'Ctrl+F');
    assert.strictEqual(cmd.getCommand('search').accel, 'Ctrl+F');
  });
}

/** 真实的键位方案表：每一套都必须自洽，不能出现按了没反应或抢键 */
async function testKeymapSchemes() {
  console.log('\n[键位方案]');
  const cmd = await importRenderer('commands.js');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'js', 'keymaps.js'), 'utf8');
  // keymaps.js 依赖 settings.js 取当前方案；这里只要那张静态表，用假的 getSetting 顶掉
  const stubbed = source.replace(
    /import \{ getSetting \} from '\.\/settings\.js';/,
    'const getSetting = () => "dbpanda";');
  const keymaps = await import(
    `data:text/javascript;base64,${Buffer.from(`${stubbed}\n// probe-${++importSalt}\n`).toString('base64')}`);

  // 用与 app.js 同构的一小组命令验证每套方案
  cmd.registerCommands([
    { id: 'refresh', label: '刷新', accel: 'F5', scope: 'notInEditor', run: () => {} },
    { id: 'new-query', label: '新建查询', accel: 'Ctrl+Q', run: () => {} },
    { id: 'open-table', label: '打开表', accel: 'Ctrl+Shift+O', scope: 'notInInput', run: () => {} },
    { id: 'design-table', label: '设计表', accel: 'Ctrl+D', scope: 'notInInput', run: () => {} },
    { id: 'search', label: '在库中查找', accel: 'Ctrl+F', scope: 'notInEditor', run: () => {} },
    { id: 'goto-table', label: '跳转到表', accel: 'Ctrl+P', scope: 'notInInput', run: () => {} },
    { id: 'command-palette', label: '命令面板', accel: 'Ctrl+Shift+P', run: () => {} },
  ]);

  for (const [name, scheme] of Object.entries(keymaps.KEYMAPS)) {
    check(`方案「${scheme.label}」自洽：无冲突且键位可反查`, () => {
      cmd.applyKeymap(scheme.overrides);
      assert.deepStrictEqual(cmd.accelConflicts(), [], '存在抢同一个键的命令');
      for (const c of cmd.allCommands()) {
        if (!c.accel || c.bind === false) continue;
        const a = cmd.parseAccel(c.accel);
        const hit = cmd.matchShortcut(
          keyEvent(a.key, { ctrl: a.ctrl, shift: a.shift, alt: a.alt }), {});
        assert.ok(hit, `${c.id} 的 ${c.accel} 按下去没有任何命令响应`);
        assert.strictEqual(hit.id, c.id, `${c.accel} 命中了 ${hit.id}`);
      }
    });
    check(`方案「${scheme.label}」的 overrides 只引用真实存在的命令`, () => {
      for (const id of Object.keys(scheme.overrides || {})) {
        assert.ok(cmd.getCommand(id), `overrides 里的 ${id} 不是已注册的命令`);
      }
    });
  }

  check('Navicat 方案下 F5 在 SQL 编辑器里也触发刷新', () => {
    cmd.applyKeymap(keymaps.KEYMAPS.navicat.overrides);
    const hit = cmd.matchShortcut(keyEvent('F5'), { inEditor: true, inInput: true });
    assert.ok(hit && hit.id === 'refresh');
    assert.strictEqual(keymaps.KEYMAPS.navicat.editorF5, 'refresh',
      '编辑器必须放行 F5，否则全局刷新永远收不到');
  });

  check('默认方案下 F5 留给编辑器执行查询', () => {
    cmd.applyKeymap(keymaps.KEYMAPS.dbpanda.overrides);
    assert.strictEqual(cmd.matchShortcut(keyEvent('F5'), { inEditor: true, inInput: true }), null);
    assert.strictEqual(keymaps.KEYMAPS.dbpanda.editorF5, 'run');
  });
}

// ------------------------------------------------------------ 设置（主进程）
function testMainSettings(userDataDir) {
  console.log('\n[设置 · 主进程]');
  stubElectron(userDataDir);
  delete require.cache[require.resolve('../src/main/settings.js')];
  const settings = require('../src/main/settings.js');

  // 不用 deepStrictEqual 钉死整个对象：每加一个设置项都要来改测试，反而没人愿意加断言。
  // 真正要守住的是「每个键都有默认值」和「关键默认值不许变」。
  check('每个设置键都有默认值', () => {
    const all = settings.all();
    assert.deepStrictEqual(Object.keys(all).sort(), [...settings.SCHEMA_KEYS].sort());
    for (const [key, value] of Object.entries(all)) {
      assert.ok(value !== undefined && value !== null, `${key} 没有默认值`);
    }
  });

  check('关键默认值与改造前的表现一致', () => {
    const all = settings.all();
    assert.strictEqual(all.theme, 'light');
    assert.strictEqual(all.queryMaxRows, 2000);
    assert.strictEqual(all.tablePageSize, 500);
    assert.strictEqual(all.keymap, 'dbpanda');
    assert.strictEqual(all.uiScale, 100);
    assert.strictEqual(all.gridDensity, 'default');
  });

  check('侧栏默认宽度与 CSS 的 #sidebar 一致（否则首启会静默改布局）', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'css', 'app.css'), 'utf8');
    const match = css.match(/#sidebar\s*\{[^}]*?width:\s*(\d+)px/);
    assert.ok(match, '没有在 app.css 里找到 #sidebar 的 width');
    assert.strictEqual(settings.all().sidebarWidth, Number(match[1]));
  });

  return (async () => {
    await checkAsync('写入后能读回，且落到磁盘上', async () => {
      await settings.patch({ theme: 'dark', tablePageSize: 1000 });
      assert.strictEqual(settings.get('theme'), 'dark');
      const onDisk = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings-v1.json'), 'utf8'));
      assert.strictEqual(onDisk.tablePageSize, 1000);
    });

    await checkAsync('重新载入模块后设置仍在（这就是「重启还记得」）', async () => {
      delete require.cache[require.resolve('../src/main/settings.js')];
      const reloaded = require('../src/main/settings.js');
      assert.strictEqual(reloaded.get('theme'), 'dark');
      assert.strictEqual(reloaded.get('tablePageSize'), 1000);
    });

    await checkAsync('渲染进程传来的未知键被丢弃', async () => {
      const saved = await settings.patch({ evil: 'x', __proto__: { polluted: true } });
      assert.ok(!('evil' in saved));
      assert.strictEqual({}.polluted, undefined);
    });

    await checkAsync('非法值回落到默认值，不会原样落盘', async () => {
      assert.strictEqual((await settings.patch({ theme: 'rainbow' })).theme, 'light');
      assert.strictEqual((await settings.patch({ sidebarWidth: 99999 })).sidebarWidth, 280);
      assert.strictEqual((await settings.patch({ tablePageSize: 7 })).tablePageSize, 500);
    });

    await checkAsync('数字型设置接受字符串输入（下拉框传的是字符串）', async () => {
      assert.strictEqual((await settings.patch({ queryMaxRows: '10000' })).queryMaxRows, 10000);
    });

    await checkAsync('外观三项的取值都被约束住', async () => {
      assert.strictEqual((await settings.patch({ theme: 'system' })).theme, 'system');
      assert.strictEqual((await settings.patch({ uiScale: '125' })).uiScale, 125);
      assert.strictEqual((await settings.patch({ uiScale: 999 })).uiScale, 100, '越界缩放要回落默认值');
      assert.strictEqual((await settings.patch({ gridDensity: 'compact' })).gridDensity, 'compact');
      assert.strictEqual((await settings.patch({ gridDensity: 'huge' })).gridDensity, 'default');
    });

    await checkAsync('行高档位在 CSS 里都有对应的变量定义', async () => {
      const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'css', 'app.css'), 'utf8');
      assert.ok(/--grid-row-height:/.test(css), '缺少 --grid-row-height 变量');
      assert.ok(/\.grid th, \.grid td \{[^}]*height: var\(--grid-row-height\)/.test(css),
        '网格行高没有改用变量，行高档位不会生效');
      for (const density of ['compact', 'comfortable']) {
        assert.ok(new RegExp(`data-density="${density}"`).test(css), `缺少 ${density} 档位的样式`);
      }
    });
  })();
}

// ---------------------------------------------------------- 设置（渲染进程）
async function testRendererSettings() {
  console.log('\n[设置 · 渲染进程]');

  class MemoryStorage {
    constructor(seed = {}) { this.values = new Map(Object.entries(seed)); }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { this.values.set(key, String(value)); }
    removeItem(key) { this.values.delete(key); }
  }

  const makeApi = (stored) => {
    const state = { ...stored };
    return {
      calls: [],
      api: {
        settings: {
          read: async () => ({ ...state }),
          patch: async (partial) => { Object.assign(state, partial); return { ...state }; },
        },
      },
      state,
    };
  };

  const BASE = {
    theme: 'light', uiScale: 100, gridDensity: 'default', keymap: 'dbpanda',
    impactPreview: 'risky', backupKeep: 7,
    sidebarWidth: 280, queryMaxRows: 2000, tablePageSize: 500,
  };

  await checkAsync('旧 localStorage 偏好会被搬到主进程，并删掉旧键', async () => {
    const mod = await importRenderer('settings.js');
    const { api, state } = makeApi(BASE);
    const ls = new MemoryStorage({ 'dbc-theme': 'dark', 'dbpanda-sidebar-width': '320' });
    globalThis.window = { api };
    globalThis.localStorage = ls;
    await mod.loadSettings();
    assert.strictEqual(state.theme, 'dark');
    assert.strictEqual(state.sidebarWidth, 320);
    assert.strictEqual(ls.getItem('dbc-theme'), null, '旧键应当被清理');
    assert.strictEqual(ls.getItem('dbpanda-sidebar-width'), null);
    assert.strictEqual(mod.getSetting('theme'), 'dark');
  });

  await checkAsync('主进程已有用户设置时，残留的旧值不会把它覆盖回去', async () => {
    const mod = await importRenderer('settings.js');
    const { api, state } = makeApi({ ...BASE, theme: 'dark' });
    globalThis.window = { api };
    globalThis.localStorage = new MemoryStorage({ 'dbc-theme': 'light' });
    await mod.loadSettings();
    assert.strictEqual(state.theme, 'dark');
  });

  await checkAsync('IPC 失败时退回默认值，不阻断启动', async () => {
    const mod = await importRenderer('settings.js');
    globalThis.window = { api: { settings: { read: async () => { throw new Error('boom'); } } } };
    globalThis.localStorage = new MemoryStorage();
    const loaded = await mod.loadSettings();
    assert.strictEqual(loaded.theme, 'light');
    assert.strictEqual(loaded.sidebarWidth, 280);
  });

  await checkAsync('updateSettings 只在值真的变了时通知订阅者', async () => {
    const mod = await importRenderer('settings.js');
    const { api } = makeApi(BASE);
    globalThis.window = { api };
    globalThis.localStorage = new MemoryStorage();
    await mod.loadSettings();
    const seen = [];
    mod.onSettingsChange((next, changed) => seen.push(changed));
    await mod.updateSettings({ theme: 'dark' });
    await mod.updateSettings({ theme: 'dark' }); // 同值，不应再通知
    assert.deepStrictEqual(seen, [['theme']]);
  });

  delete globalThis.window;
  delete globalThis.localStorage;
}

// ------------------------------------------------------------------ 审计日志
async function testAuditLog(userDataDir) {
  console.log('\n[审计日志]');
  stubElectron(userDataDir);
  delete require.cache[require.resolve('../src/main/auditLog.js')];
  const audit = require('../src/main/auditLog.js');
  const readLog = () => {
    try { return fs.readFileSync(audit.filePath(), 'utf8'); } catch (e) { return ''; }
  };

  await checkAsync('密码 / 私钥口令 / API Key 绝不写进日志', async () => {
    audit.record({
      channel: 'conn:save',
      payload: {
        connId: 'c1', name: '生产库', host: '10.0.0.1',
        password: 'hunter2',
        ssh: { passphrase: 'secret-phrase', keyFile: 'C:/id_rsa' },
        apiKey: 'sk-should-never-appear',
      },
      ok: true,
      ms: 12,
    });
    await audit.flush();
    const text = readLog();
    assert.ok(!text.includes('hunter2'), '数据库密码泄漏到日志里了');
    assert.ok(!text.includes('secret-phrase'), '私钥口令泄漏到日志里了');
    assert.ok(!text.includes('sk-should-never-appear'), 'API Key 泄漏到日志里了');
    assert.ok(text.includes('[已隐去]'));
    assert.ok(text.includes('10.0.0.1'), '非敏感字段应当保留，否则日志没有排查价值');
    assert.ok(text.includes('C:/id_rsa'), 'keyFile 是路径不是口令，应当保留');
  });

  await checkAsync('高频只读通道成功时不记，失败时记', async () => {
    const before = readLog().length;
    audit.record({ channel: 'db:objects', payload: { connId: 'c1' }, ok: true });
    await audit.flush();
    assert.strictEqual(readLog().length, before, '成功的目录树加载不应刷屏');
    audit.record({ channel: 'db:objects', payload: { connId: 'c1' }, ok: false, error: '连接已断开' });
    await audit.flush();
    assert.ok(readLog().includes('连接已断开'), '失败必须记录');
  });

  await checkAsync('记录了排查需要的字段：时间 / 通道 / 连接 / 库 / 耗时 / 审批', async () => {
    audit.record({
      channel: 'db:query', payload: { connId: 'c9', db: 'orders', sql: 'DELETE FROM t' },
      approvalOperation: 'db.query', ok: true, ms: 34,
    });
    await audit.flush();
    const last = readLog().trim().split('\n').pop();
    const entry = JSON.parse(last);
    assert.ok(Date.parse(entry.at) > 0);
    assert.strictEqual(entry.channel, 'db:query');
    assert.strictEqual(entry.connId, 'c9');
    assert.strictEqual(entry.db, 'orders');
    assert.strictEqual(entry.approved, 'db.query');
    assert.strictEqual(entry.ms, 34);
    assert.strictEqual(entry.args.sql, 'DELETE FROM t');
  });

  await checkAsync('超长 SQL 被截断，不会把整段脚本写进日志', async () => {
    audit.record({ channel: 'db:query', payload: { connId: 'c1', sql: 'x'.repeat(50000) }, ok: true });
    await audit.flush();
    const entry = JSON.parse(readLog().trim().split('\n').pop());
    assert.ok(entry.args.sql.length < 2100, `SQL 未截断，长度 ${entry.args.sql.length}`);
  });

  check('循环引用不会让审计拖垮主流程', () => {
    const loop = { connId: 'c1' };
    loop.self = loop;
    audit.record({ channel: 'db:query', payload: loop, ok: true }); // 不抛错即通过
  });
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbpanda-step1-'));
  try {
    await testCommands();
    await testKeymapSchemes();
    await testMainSettings(userDataDir);
    await testRendererSettings();
    await testAuditLog(userDataDir);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  console.log(`\n[STEP1] 通过 ${passed} 项, 失败 ${failures.length} 项`);
  if (failures.length) {
    failures.forEach((name) => console.log(`  失败: ${name}`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
