// 演示模式：创建示例 SQLite 库 → 打开界面 → 自动操作（展开树/打开表/跑查询）→ 截图到 ./shots/
// 用于开发期自动化验证界面真实渲染效果。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const store = require('./store');
const { SQLiteAdapter } = require('./db/sqlite');

const SHOT_DIR = path.join(__dirname, '../../shots');

async function buildSampleDb() {
  const file = path.join(app.getPath('userData'), 'demo.db');
  const ad = new SQLiteAdapter({ id: 'demo', type: 'sqlite', file });
  await ad.connect();
  const names = ['王伟', '李娜', '张敏', '刘洋', '陈静', '杨帆', '赵磊', '黄丽', '周杰', '吴霞',
    '徐强', '孙俊', '马琳', '朱涛', '胡萍', '郭明', '何雪', '高翔', '林芳', '罗刚'];
  const cities = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '西安'];
  const status = ['已完成', '已发货', '待付款', '已取消'];
  let sql = `
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      city TEXT,
      created_at TEXT
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL,
      stock INTEGER
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      amount REAL,
      status TEXT,
      created_at TEXT,
      remark TEXT
    );
    CREATE INDEX idx_orders_customer ON orders(customer_id);
    CREATE VIEW v_order_summary AS
      SELECT c.name, COUNT(o.id) AS order_count, SUM(o.amount) AS total_amount
      FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id;
    CREATE TRIGGER trg_order_time AFTER INSERT ON orders
    BEGIN
      UPDATE orders SET created_at = COALESCE(created_at, datetime('now')) WHERE id = NEW.id;
    END;
  `;
  for (let i = 0; i < 20; i++) {
    sql += `INSERT INTO customers (name, email, city, created_at) VALUES ('${names[i]}', 'user${i + 1}@example.com', '${cities[i % cities.length]}', '2025-0${(i % 9) + 1}-1${i % 10} 10:2${i % 10}:00');\n`;
  }
  const prods = [['ThinkPad X1 笔记本', 12999, 35], ['机械键盘', 399, 200], ['27寸显示器', 1599, 80], ['无线鼠标', 129, 500], ['USB-C 扩展坞', 299, 150]];
  for (const [n, p, s] of prods) sql += `INSERT INTO products (name, price, stock) VALUES ('${n}', ${p}, ${s});\n`;
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 120; i++) {
    const cid = 1 + Math.floor(rnd() * 20);
    const amt = (50 + rnd() * 5000).toFixed(2);
    const st = status[Math.floor(rnd() * status.length)];
    sql += `INSERT INTO orders (customer_id, amount, status, created_at, remark) VALUES (${cid}, ${amt}, '${st}', '2025-${String(1 + Math.floor(rnd() * 9)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')} 1${i % 10}:30:00', ${rnd() > 0.7 ? "'加急'" : 'NULL'});\n`;
  }
  const res = await ad.runScript('main', sql);
  const errs = res.filter((r) => r.error);
  if (errs.length) throw new Error('示例库创建失败: ' + errs[0].error);
  await ad.close();
  return file;
}

async function runDemo(createWindow) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const dbFile = await buildSampleDb();
  const saved = store.save({ name: '演示连接 SQLite', type: 'sqlite', file: dbFile, color: '#e5484d', group: '演示分组' });
  // 各类型未打开连接（验证类型图标颜色区分 + 关闭状态 + 生产/测试链接类型标记）
  store.save({ name: '河南下行库', type: 'mysql', host: '172.18.15.33', port: 9130, user: 'root', env: 'prod', color: '#e5484d' });
  store.save({ name: '漯河财产精细化', type: 'postgres', host: '172.19.30.12', port: 5432, user: 'postgres', readOnly: true });
  store.save({ name: 'report', type: 'clickhouse', host: '172.16.78.19', port: 8123, user: 'default', env: 'test' });
  store.save({ name: 'BI 仓库', type: 'mssql', host: '172.20.4.5', port: 1433, user: 'sa' });
  store.save({ name: 'OB 集群', type: 'oboracle', host: '172.25.16.23', port: 2881, user: 'SYS@oracle' });

  const win = createWindow(true);
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (...a) => {
    const ev = a[0];
    const level = typeof a[1] === 'number' ? a[1] : (ev && ev.level);
    const message = typeof a[2] === 'string' ? a[2] : (ev && ev.message);
    if (level === 3 || level === 'error') console.log('[DEMO][渲染错误]', message);
  });
  const ej = (code) => win.webContents.executeJavaScript(code, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    win.webContents.invalidate(); // 强制重绘，避免截到过期合成帧
    await wait(200);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOT_DIR, name), img.toPNG());
    console.log('[DEMO] 截图', name);
  };

  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await wait(1200);

  await ej('window.__test.openConnMenu()');
  await wait(400);
  await shot('shot-0-connmenu.png');
  await ej('window.__test.closeMenus()');
  await wait(200);

  const id = JSON.stringify(saved.id);
  await ej(`window.__test.openConnection(${id})`);
  await wait(600);
  await ej(`window.__test.expandDatabase(${id}, 'main')`);
  await wait(800);
  // 展开“触发器”对象文件夹
  await ej(`(() => {
    const rows = [...document.querySelectorAll('#tree .tree-row')];
    const r = rows.find((x) => x.querySelector('.tree-label') && x.querySelector('.tree-label').textContent === '触发器');
    if (r) r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return !!r;
  })()`);
  await wait(600);
  await shot('shot-1-objects.png');

  // 自绘菜单栏下拉
  await ej(`(() => {
    const m = document.querySelector('#menubar .menu-item');
    if (m) m.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return !!m;
  })()`);
  await wait(400);
  await shot('shot-14-menu.png');
  await ej('window.__test.closeMenus()');
  await wait(200);

  // 对象页内对象类型切换：触发器
  await ej(`(() => {
    const b = document.querySelector('.obj-kind-btn[data-kind="trigger"]');
    if (b) b.click();
    return !!b;
  })()`);
  await wait(700);
  await shot('shot-13-objkind.png');
  await ej(`(() => {
    const b = document.querySelector('.obj-kind-btn[data-kind="table"]');
    if (b) b.click();
    return !!b;
  })()`);
  await wait(500);

  await ej(`window.__test.openTable(${id}, 'main', null, 'orders')`);
  await wait(1000);
  await shot('shot-2-table.png');

  // 每页行数改动要真正落到设置里（改一次，新开的表和下次启动都沿用）
  const pageSizePersist = await ej(`(async () => {
    const sel = [...document.querySelectorAll('.tabpane.active select')]
      .find((s) => [...s.options].map((o) => o.value).join(',') === '100,500,1000');
    if (!sel) return { found: false };
    const before = (await window.api.settings.read()).tablePageSize;
    sel.value = '1000';
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 500));
    const after = (await window.api.settings.read()).tablePageSize;
    sel.value = String(before);
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 500));
    return { found: true, before, after, restored: (await window.api.settings.read()).tablePageSize };
  })()`);
  console.log('[DEMO] 每页行数持久化:', JSON.stringify(pageSizePersist));
  console.log('[DEMO] 每页行数持久化:',
    pageSizePersist.found && pageSizePersist.before === 500 && pageSizePersist.after === 1000
      && pageSizePersist.restored === 500 ? 'PASS' : 'FAIL');
  await wait(500);

  // 表单视图：点击表单视图按钮
  await ej(`(() => {
    const b = [...document.querySelectorAll('.tabpane.active .pbtn')].find((x) => x.textContent.includes('表单视图'));
    if (b) b.click();
    return !!b;
  })()`);
  await wait(700);
  await shot('shot-15-form.png');
  // 切回网格
  await ej(`(() => {
    const b = [...document.querySelectorAll('.tabpane.active .pbtn')].find((x) => x.textContent.includes('表单视图'));
    if (b) b.click();
    return !!b;
  })()`);
  await wait(300);

  // 在库中查找：打开对话框，填关键字，选“数据内容”，点查找
  await ej(`window.__test.openSearch(${id}, 'main')`);
  await wait(500);
  await ej(`(() => {
    const kw = document.querySelector('.modal-body input[type=text]');
    if (kw) { kw.value = '北京'; }
    const radios = document.querySelectorAll('.modal-body input[type=radio]');
    if (radios[1]) { radios[1].checked = true; }
    const run = [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.includes('查找'));
    if (run) run.click();
    return !!kw;
  })()`);
  await wait(1200);
  await shot('shot-16-search.png');
  await ej('window.__test.closeMenus()');
  await wait(200);

  await ej(`window.__test.runQuery(${id}, 'main', "SELECT c.name AS 客户, c.city AS 城市, COUNT(o.id) AS 订单数, ROUND(SUM(o.amount),2) AS 总金额 FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY 总金额 DESC LIMIT 10;")`);
  await wait(1500);
  await shot('shot-3-query.png');

  // 大结果集：虚拟滚动下只渲染可见行，滚动条与行号仍要是真实的
  await ej(`window.__test.runQuery(${id}, 'main', "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 1500) SELECT n AS 序号, 'row-' || n AS 标签, n * 1.5 AS 金额 FROM seq;")`);
  await wait(2000);
  const bigGrid = await ej(`(() => {
    const wrap = document.querySelector('.tabpane.active .grid-wrap');
    if (!wrap) return { found: false };
    const before = wrap.querySelectorAll('tr[data-dr]').length;
    wrap.scrollTop = Math.round(wrap.scrollHeight * 0.5);
    wrap.dispatchEvent(new Event('scroll'));
    const rows = [...wrap.querySelectorAll('tr[data-dr]')];
    const firstNum = rows.length ? rows[0].querySelector('td.rownum').textContent : null;
    return {
      found: true, rendered: before, renderedAfterScroll: rows.length,
      firstRowNumAfterScroll: Number(firstNum),
      scrollHeight: wrap.scrollHeight,
    };
  })()`);
  console.log('[DEMO] 大结果集虚拟滚动:', JSON.stringify(bigGrid));
  console.log('[DEMO] 大结果集虚拟滚动:',
    bigGrid.found && bigGrid.rendered < 120 && bigGrid.renderedAfterScroll < 120
      && bigGrid.firstRowNumAfterScroll > 600 && bigGrid.firstRowNumAfterScroll < 800
      && bigGrid.scrollHeight > 35000 ? 'PASS' : 'FAIL');
  await shot('shot-24-bigresult.png');

  await ej(`window.__test.openDesigner(${id}, 'main', null, 'orders')`);
  await wait(1000);
  // 切到“外键”子标签
  await ej(`(() => {
    const rt = [...document.querySelectorAll('.tabpane.active .rtab')].find((x) => x.textContent.trim() === '外键');
    if (rt) rt.click();
    return !!rt;
  })()`);
  await wait(500);
  await shot('shot-5-designer.png');

  await ej('window.__test.openHistory()');
  await wait(800);
  await shot('shot-6-history.png');

  // EXPLAIN 执行计划（SQLite 树）
  await ej(`window.__test.openExplain(${id}, 'main', "SELECT c.name, COUNT(o.id) FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.amount > 1000 GROUP BY c.id")`);
  await wait(1000);
  await shot('shot-17-explain.png');

  // ER 关系图
  await ej(`window.__test.openEr(${id}, 'main')`);
  await wait(1200);
  await shot('shot-18-er.png');

  // AI 助手面板（无 Key 时展示欢迎页 + 快捷动作；含输入预填）
  await ej(`window.__test.openAi(${id}, 'main', 'SELECT * FROM orders WHERE amount > 1000')`);
  await wait(700);
  await shot('shot-20-ai.png');
  const aiOk = await ej(`(() => {
    const p = document.querySelector('.ai-pane');
    return { pane: !!p, chips: document.querySelectorAll('.ai-chip').length, input: !!document.querySelector('.ai-input') };
  })()`);
  console.log('[DEMO] AI 助手面板:', JSON.stringify(aiOk));
  // AI 设置对话框
  await ej('window.__test.openAiConfig()');
  await wait(500);
  await shot('shot-21-ai-config.png');
  await ej('window.__test.closeMenus()');
  await wait(200);

  // 选项（设置中心）：主题 / 结果行数 / 每页行数集中到一处
  await ej('window.__test.openSettings()');
  await wait(500);
  const settingsOk = await ej(`(() => {
    const body = document.querySelector('.settings-body');
    return {
      groups: body ? body.querySelectorAll('.settings-group').length : 0,
      rows: body ? body.querySelectorAll('.settings-row').length : 0,
      selects: body ? body.querySelectorAll('.settings-select').length : 0,
    };
  })()`);
  console.log('[DEMO] 选项对话框:', JSON.stringify(settingsOk));
  console.log('[DEMO] 选项对话框:',
    settingsOk.groups === 5 && settingsOk.selects === 7 ? 'PASS' : 'FAIL(应=5组/7个下拉)');
  await shot('shot-23-settings.png');
  await ej('window.__test.closeMenus()');
  await wait(200);

  // 危险 SQL 检测 + 生产库二次确认审批
  const dz = await ej(`window.__test.analyzeDanger("DELETE FROM orders;\\nUPDATE users SET a=1 WHERE id=2;\\nDROP TABLE customers;\\nTRUNCATE TABLE logs;\\nSELECT 1;")`);
  console.log('[DEMO] 危险检测命中:', JSON.stringify(dz.map((x) => x.reason)));
  console.log('[DEMO] 危险检测:', dz.length === 3 ? 'PASS' : 'FAIL(应=3)');
  await ej(`window.__test.openDangerConfirm('河南下行库', "DELETE FROM orders;\\nDROP TABLE customers;\\nTRUNCATE TABLE logs;")`);
  await wait(500);
  await shot('shot-22-danger.png');
  await ej('window.__test.closeMenus()');
  await wait(200);

  // SQL 自动补全：输入 customers. 后弹出字段
  const hintRes = await ej(`window.__test.testHint(${id}, 'main', 'SELECT * FROM customers c WHERE c.')`);
  console.log('[DEMO] 补全(别名 c.):', JSON.stringify(hintRes));
  await shot('shot-19-hint.png');
  const hintRes2 = await ej(`window.__test.testHint(${id}, 'main', 'SELECT * FROM orders.')`);
  console.log('[DEMO] 补全(orders.):', JSON.stringify(hintRes2));
  const hintRes3 = await ej(`window.__test.testHint(${id}, 'main', 'SELECT * FROM customers WHERE c')`);
  console.log('[DEMO] 补全(无别名 WHERE c):', JSON.stringify(hintRes3));

  // 保存查询到连接（树上出现“查询”节点）+ 打开筛选构建器
  await ej(`window.__test.saveDemoQuery(${id}, '热门客户TOP10', "SELECT c.name, SUM(o.amount) AS total FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY total DESC LIMIT 10;")`);
  await wait(600);
  await ej(`window.__test.openTable(${id}, 'main', null, 'orders')`);
  await wait(400);
  await ej(`(() => {
    const btn = [...document.querySelectorAll('.tabpane.active .pbtn')].find((b) => b.textContent.includes('条件'));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await wait(400);
  await shot('shot-8-filter.png');

  await ej('window.__test.openConnDialog()');
  await wait(500);
  await shot('shot-4-dialog.png');
  await ej('window.__test.closeMenus()');
  await wait(300);

  await ej(`window.__test.openTransfer(${id}, 'main')`);
  await wait(1000);
  await shot('shot-10-transfer.png');
  await ej('window.__test.closeMenus()');
  await wait(300);

  await ej(`window.__test.openSync(${id}, 'main')`);
  await wait(1000);
  await shot('shot-11-sync.png');
  await ej('window.__test.closeMenus()');
  await wait(300);

  // 命令面板：Ctrl+P 跳表 / Ctrl+Shift+P 跑命令
  await ej(`(async () => {
    const { openCommandPalette } = await import('./js/commandPalette.js');
    openCommandPalette('object');
    await new Promise((r) => setTimeout(r, 80));
    const input = document.querySelector('.palette-input');
    input.value = 'ord';
    input.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await wait(500);
  const paletteDemo = await ej(`(() => {
    const items = [...document.querySelectorAll('.palette-item .palette-label')].map((n) => n.textContent);
    return { count: items.length, items: items.slice(0, 5) };
  })()`);
  console.log('[DEMO] 命令面板搜表:', JSON.stringify(paletteDemo));
  console.log('[DEMO] 命令面板搜表:', paletteDemo.count > 0 && paletteDemo.items.includes('orders') ? 'PASS' : 'FAIL');
  await shot('shot-25-palette.png');
  await ej(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
  await wait(300);

  // 行高档位：紧凑档一屏能多看约三分之一的数据
  await ej(`window.__test.openTable(${id}, 'main', null, 'orders')`);
  await wait(800);
  const paneState = await ej(`(() => {
    const panes = [...document.querySelectorAll('#tabpanes > *')];
    return {
      total: panes.length,
      visible: panes.filter((p) => p.offsetParent !== null).map((p) => ({
        cls: p.className,
        inline: p.style.display,
        computed: getComputedStyle(p).display,
        text: (p.textContent || '').trim().slice(0, 40),
      })),
      activeTab: (document.querySelector('.tab.active .tab-title') || {}).textContent || null,
      hintsOpen: document.querySelectorAll('.CodeMirror-hints').length,
    };
  })()`);
  // 任何时刻只能有一个标签面板可见。曾经因为 explainTab 给 pane 设了内联
  // display:flex，覆盖掉 .tabpane 的隐藏规则，执行计划面板会永远盖在别的标签上。
  console.log('[DEMO] 面板状态:', JSON.stringify(paneState));
  console.log('[DEMO] 同时只显示一个面板:',
    paneState.visible.length === 1 && paneState.activeTab === 'orders' ? 'PASS' : 'FAIL');
  await ej(`(async () => {
    document.documentElement.setAttribute('data-density', 'compact');
    (await import('./js/grid.js')).refreshAllGrids();
    return true;
  })()`);
  await wait(400);
  await shot('shot-26-compact.png');
  await ej(`(async () => {
    document.documentElement.removeAttribute('data-density');
    (await import('./js/grid.js')).refreshAllGrids();
    return true;
  })()`);
  await wait(300);

  // 首次启动引导：没有任何连接时左侧显示的卡片
  const onboardOk = await ej(`(async () => {
    const { state } = await import('./js/state.js');
    const { renderTree } = await import('./js/tree.js');
    window.__demoConns = state.connections;
    state.connections = [];
    renderTree();
    return !!document.querySelector('.tree-onboarding');
  })()`);
  console.log('[DEMO] 首启引导:', onboardOk ? 'PASS' : 'FAIL');
  await wait(300);
  await shot('shot-27-onboarding.png');
  await ej(`(async () => {
    const { state } = await import('./js/state.js');
    const { renderTree } = await import('./js/tree.js');
    state.connections = window.__demoConns || [];
    delete window.__demoConns;
    renderTree();
    return true;
  })()`);
  await wait(300);

  // 补全测试会把 hints 浮层留在页面上（它不属于任何激活的编辑器），后面的截图要先清掉
  await ej(`document.querySelectorAll('.CodeMirror-hints').forEach((n) => n.remove()); true`);

  // 连接安全体检：把散在各处的安全事实汇总到一屏
  // 注意：这些函数返回的对象里带 DOM 节点，不能直接交给 executeJavaScript 序列化
  await ej(`(async () => { await (await import('./js/securityDialog.js')).openSecurityDialog(); return true; })()`);
  await wait(600);
  const secDemo = await ej(`(() => ({
    cards: document.querySelectorAll('.sec-card').length,
    warns: document.querySelectorAll('.sec-check.sec-warn').length,
    readOnlyBadge: document.querySelectorAll('.sec-badges .env-readonly').length,
  }))()`);
  console.log('[DEMO] 连接安全体检:', JSON.stringify(secDemo));
  console.log('[DEMO] 连接安全体检:',
    secDemo.cards === 6 && secDemo.readOnlyBadge === 1 && secDemo.warns >= 1 ? 'PASS' : 'FAIL');
  await shot('shot-28-security.png');
  await ej(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
  await wait(300);

  // 操作审计：第一步埋的日志，到这里已经攒了整场演示的操作记录
  await ej(`(async () => { await (await import('./js/auditTab.js')).openAuditTab(); return true; })()`);
  await wait(800);
  const auditDemo = await ej(`(() => ({
    rows: document.querySelectorAll('.audit-grid tr[data-dr]').length,
    count: (document.querySelector('.audit-count') || {}).textContent || '',
  }))()`);
  console.log('[DEMO] 操作审计:', JSON.stringify(auditDemo));
  console.log('[DEMO] 操作审计:', auditDemo.rows > 0 ? 'PASS' : 'FAIL');
  await shot('shot-29-audit.png');

  // 数据字典导出
  await ej(`(async () => { (await import('./js/dataDictDialog.js')).openDataDictDialog({ connId: ${id}, db: 'main', schema: null }); return true; })()`);
  await wait(500);
  await shot('shot-30-datadict.png');
  await ej(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
  await wait(300);

  // 备份 / 还原
  await ej(`(async () => { await (await import('./js/backupDialog.js')).openBackupDialog({ connId: ${id}, db: 'main', schema: null }); return true; })()`);
  await wait(600);
  // 真的点一次「立即备份」，确认它出现在备份历史里——不能只截个空列表就当作能用。
  // 点击后立刻取一次状态：进度条要显示、按钮要禁用（点击处理到第一个 await 前是同步的）
  const backupRunning = await ej(`(() => {
    const btn = document.querySelector('.backup-run');
    const idleHidden = document.querySelector('.backup-progress').hidden;
    btn.click();
    return {
      idleHidden,
      progressShown: !document.querySelector('.backup-progress').hidden,
      buttonDisabled: btn.disabled,
      inputDisabled: document.querySelector('.backup-name').disabled,
    };
  })()`);
  console.log('[DEMO] 备份进度反馈:', JSON.stringify(backupRunning));
  console.log('[DEMO] 备份进度反馈:',
    backupRunning.idleHidden && backupRunning.progressShown
      && backupRunning.buttonDisabled && backupRunning.inputDisabled ? 'PASS' : 'FAIL');
  await wait(4000);
  const backupClick = await ej(`(() => ({
    items: document.querySelectorAll('.backup-item').length,
    status: (document.querySelector('.backup-status') || {}).textContent || '',
    firstMeta: (document.querySelector('.backup-item .backup-meta') || {}).textContent || '',
  }))()`);
  console.log('[DEMO] 立即备份:', JSON.stringify(backupClick));
  console.log('[DEMO] 立即备份后出现在历史里:', backupClick.items === 1 ? 'PASS' : 'FAIL');
  await shot('shot-31-backup.png');
  await ej(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
  await wait(300);

  // 深色模式：持久化后整页重载（等同用户重启后的暗色状态），再开表截屏
  await ej("window.__test.setTheme('dark')");
  await wait(300);
  win.webContents.reload();
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await wait(1000);
  await ej(`window.__test.openConnection(${id})`);
  await wait(600);
  await ej(`window.__test.openTable(${id}, 'main', null, 'orders')`);
  await wait(1000);
  await shot('shot-12-dark.png');
  await ej("window.__test.setTheme('light')");

  // 勾选 SSH 隧道，验证展开后的表单
  await ej(`(() => {
    const cb = [...document.querySelectorAll('.form-check input')].find(c => c.parentElement.textContent.includes('SSH'));
    if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    return !!cb;
  })()`);
  await wait(300);
  await shot('shot-7-ssh.png');

  console.log('[DEMO] 完成');
  return 0;
}

module.exports = { runDemo };
