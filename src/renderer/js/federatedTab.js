// 跨库联邦查询标签页（路线图 v2.7.0 M4）
//
// 与查询标签页刻意做成两个东西，而不是给 queryTab 加一个「联邦模式」开关：
// 联邦查询没有连接/数据库/模式下拉（连接写在 SQL 里）、没有事务、没有多结果集、
// 结果永远只读。塞进 queryTab 会让那 1400 行里到处是 if (federated)，
// 两边都变难改。共用的是真正共用的东西：DataGrid（连图表、复制、选区统计一起）、
// 结果导出菜单、编辑器查找。
//
// 界面上有两处**常驻**说明，不是可关闭的提示：
//   1. 顶部标注「本地内存计算 · 非跨库一致性快照」——各源表是分别读取的，
//      源库在读取期间的写入会体现为「A 表新、B 表旧」。用户必须一直看得见这件事。
//   2. 源表面板列出每张表拉了多少行、花了多久。联邦查询的成本全在取数上，
//      藏起来只会让人觉得「这工具怎么这么慢」。
import { el, iconEl, fmtCount } from './util.js';
import { state, connLabel } from './state.js';
import { addTab, uid } from './tabs.js';
import { DataGrid } from './grid.js';
import { toast, promptDialog } from './toast.js';
import { statusbar } from './statusbar.js';
import { showMenu } from './contextmenu.js';
import { openEditorSearch, closeEditorSearch, editorSearchNext } from './editorSearch.js';
import { getSetting } from './settings.js';
import { editorRunsOnF5 } from './keymaps.js';
import { t } from './i18n.js';

let fedNo = 0;

const SAMPLE_SQL = `-- 跨库联邦查询：用 [连接名.库名.表名] 引用任意已打开连接里的表
-- 例（把订单库的订单和用户库的用户拼起来）：
--   SELECT u.name, COUNT(*) AS 单数, SUM(o.amount) AS 金额
--   FROM [订单库.shop.orders] o
--   JOIN [用户库.users.public.profile] u ON o.uid = u.uid
--   WHERE o.created >= '2026-01-01'      -- 这类条件会被下推到源库，只拉需要的行
--   GROUP BY u.name
-- 只支持 SELECT。写成「别名.列 运算符 字面量」的条件才推得动；
-- 推不动的条件仍然正确，只是要把整张表拉回来算。
`;

export function openFederatedTab(opts = {}) {
  const tabId = (opts && opts.restoreId) || uid('fed');
  const restore = (opts && opts.restoreState) || null;
  fedNo++;
  const tabTitle = (restore && restore.title) || `联邦查询 ${fedNo}`;
  const tab = addTab({
    id: tabId, title: tabTitle, icon: 'query',
    tooltip: t('跨库联邦查询：跨连接 join，本地内存计算'),
  });
  if (tab.pane.childElementCount) return tab;
  const pane = tab.pane;
  // 只加类名，绝不设内联 display：.tabpane 靠 display:none/flex 控制显隐，
  // 内联样式会盖掉它，让这个面板永远浮在别的标签上面。
  pane.classList.add('query-pane');

  let sessionId = null;
  let running = false;
  let runToken = null;
  let lastResult = null;
  let hasSavableResult = false;

  // ---- 工具栏 ----
  const mkBtn = (icon, label, onClick, extra) =>
    el('button', { class: 'pbtn' + (extra ? ' ' + extra : ''), onClick }, iconEl(icon), label);

  const btnRun = mkBtn('run', t('执行'), () => run(), 'success');
  btnRun.title = t('执行 (Ctrl+Enter)');
  const btnStop = mkBtn('cross', t('停止'), () => stop(), 'danger');
  btnStop.disabled = true;
  const btnInsertRef = mkBtn('table', t('插入表引用…'), (e) => insertRefMenu(e));
  btnInsertRef.title = t('从已打开的连接里挑一张表，插入 [连接.库.表] 引用');
  const btnSaveResult = mkBtn('save', t('结果存为本地表…'), () => saveResult());
  btnSaveResult.title = t('把当前结果固化成本地表，后续查询可直接按表名引用');
  btnSaveResult.disabled = true;
  const btnExport = mkBtn('exportIcon', t('导出…'), (e) => exportResult(e));
  btnExport.disabled = true;

  const toolbar = el('div', { class: 'pane-toolbar query-toolbar' },
    el('div', { class: 'query-toolbar-group' },
      el('span', { class: 'query-toolbar-label' }, t('执行')), btnRun, btnStop),
    el('span', { class: 'sep' }),
    el('div', { class: 'query-toolbar-group' },
      el('span', { class: 'query-toolbar-label' }, t('编辑')), btnInsertRef),
    el('span', { class: 'sep' }),
    el('div', { class: 'query-toolbar-group' },
      el('span', { class: 'query-toolbar-label' }, t('结果')), btnSaveResult, btnExport),
    el('span', { class: 'spring' }),
    // 常驻标注：不可关闭。这是受限版最重要的一条边界，藏起来等于骗人。
    el('span', {
      class: 'fed-notice',
      title: t('各源表是分别读取的，彼此之间没有事务；源库在读取期间的写入会造成不同表来自不同时刻。\n'
        + '这是跨库查询的固有性质，不是可以关掉的开关。\n'
        + '能安全下推的筛选条件会交给源库执行，其余在本地内存里计算；不支持跨库写入。'),
    }, iconEl('info'), t('本地内存计算 · 非跨库一致性快照')),
  );

  const statusStrip = el('div', { class: 'query-status-strip' },
    el('span', { class: 'query-status-dot' }),
    el('span', { class: 'query-status-main' }, t('准备执行')),
    el('span', { class: 'query-status-detail' }, t('用 [连接名.库名.表名] 引用任意已打开连接里的表')));
  const statusMain = statusStrip.querySelector('.query-status-main');
  const statusDetail = statusStrip.querySelector('.query-status-detail');
  const setStatus = (main, detail, tone) => {
    statusMain.textContent = main;
    statusDetail.textContent = detail || '';
    statusStrip.dataset.tone = tone || '';
  };

  const editorHost = el('div', { class: 'query-editor' });
  const splitter = el('div', { class: 'splitter-h' });

  // 源表面板：这次查询从哪些库拉了多少行、各花了多久
  const sourcesHost = el('div', { class: 'fed-sources' });
  const resultsHost = el('div', { class: 'query-results' });
  const rbody = el('div', { class: 'result-body' });
  resultsHost.append(rbody);

  pane.append(toolbar, statusStrip, editorHost, splitter, sourcesHost, resultsHost);

  let splitterHeight = Number(restore && restore.splitterHeight);
  if (!Number.isFinite(splitterHeight) || splitterHeight < 60 || splitterHeight > 2000) splitterHeight = null;
  if (splitterHeight) editorHost.style.flex = `0 0 ${splitterHeight}px`;

  const cm = CodeMirror(editorHost, {
    value: (restore && typeof restore.sql === 'string') ? restore.sql : SAMPLE_SQL,
    mode: 'text/x-sql',
    lineNumbers: true,
    indentWithTabs: false,
    indentUnit: 2,
    tabSize: 2,
    matchBrackets: true,
    styleActiveLine: true,
    extraKeys: {
      // 与 queryTab 同样的做法：F5 是否属于编辑器由键位方案决定，
      // 不属于就用 CodeMirror.Pass 放行给全局命令，已打开的标签页也会跟着变。
      'F5': () => {
        if (!editorRunsOnF5()) return CodeMirror.Pass;
        run();
        return undefined;
      },
      'Ctrl-Enter': () => run(),
      'Ctrl-R': () => run(),
      'Ctrl-/': (cmi) => cmi.toggleComment(),
      'Ctrl-F': (cmi) => openEditorSearch(cmi),
      'Ctrl-H': (cmi) => openEditorSearch(cmi, { replace: true }),
      'F3': (cmi) => editorSearchNext(cmi),
      'Shift-F3': (cmi) => editorSearchNext(cmi, true),
      'Esc': (cmi) => { if (!closeEditorSearch(cmi)) return CodeMirror.Pass; },
    },
  });
  cm.on('change', () => tab.touchRecovery());
  setTimeout(() => {
    if (!splitterHeight) {
      const measured = Math.round(editorHost.getBoundingClientRect().height);
      if (measured >= 60) splitterHeight = measured;
    }
    cm.refresh();
  }, 30);

  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorHost.getBoundingClientRect().height;
    const move = (ev) => {
      const h = Math.max(60, startH + ev.clientY - startY);
      splitterHeight = h;
      editorHost.style.flex = `0 0 ${h}px`;
      cm.refresh();
      tab.touchRecovery();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // ---- 会话 ----
  async function ensureSession() {
    if (sessionId) return sessionId;
    const r = await window.api.fed.open();
    sessionId = r.sessionId;
    return sessionId;
  }

  // 会话在主进程里持有一份拉到本地的数据副本，标签关掉必须一起释放。
  // 窗口整体关闭/刷新由主进程按渲染进程归属兜底，这里管的是"只关这一个标签"。
  tab.setOnClose(() => {
    if (!sessionId) return;
    const id = sessionId;
    sessionId = null;
    window.api.fed.close(id).catch(() => {});
  });
  tab.setRecovery('federated', () => ({
    title: tabTitle,
    sql: cm.getValue(),
    splitterHeight: splitterHeight || null,
  }));

  // ---- 源表面板 ----
  function renderSources(sources, pushdownInfo) {
    sourcesHost.innerHTML = '';
    if (!sources || !sources.length) {
      sourcesHost.style.display = 'none';
      return;
    }
    sourcesHost.style.display = '';
    const total = sources.reduce((sum, s) => sum + (s.rows || 0), 0);
    const pushedTotal = sources.reduce((sum, s) => sum + (s.pushed || []).length, 0);
    sourcesHost.append(el('div', { class: 'fed-sources-head' },
      iconEl('table'),
      el('span', {}, t('本次拉取 {n} 张源表，共 {r} 行', { n: sources.length, r: fmtCount(total) })),
      pushedTotal
        ? el('span', { class: 'fed-push-badge', title: t('这些条件交给源库执行了，因此只拉回了需要的行') },
          t('已下推 {n} 个条件', { n: pushedTotal }))
        : null,
      // 整条查询都推不动时要说清楚为什么，否则用户只会觉得「怎么还是这么慢」
      pushdownInfo && !pushdownInfo.ok && pushdownInfo.reason
        ? el('span', { class: 'fed-push-none', title: t('整条查询都没有下推') }, pushdownInfo.reason)
        : null));
    for (const s of sources) {
      const warn = (s.warnings || []).length
        ? el('span', { class: 'fed-source-warn', title: s.warnings.join('\n') }, `⚠ ${s.warnings.length}`)
        : null;
      sourcesHost.append(el('div', { class: 'fed-source' },
        el('span', { class: 'fed-source-ref' }, s.ref),
        el('span', { class: 'fed-source-type' }, s.connType || ''),
        (s.pushed || []).length
          ? el('span', {
            class: 'fed-source-push',
            title: t('下推到源库的条件：') + '\n' + s.pushed.join('\n'),
          }, `↓ ${s.pushed.length}`)
          : null,
        s.prunedColumns
          ? el('span', { class: 'fed-source-cols', title: t('只取了用得上的列') }, t('{n} 列', { n: s.prunedColumns }))
          : null,
        el('span', { class: 'fed-source-rows' }, `${fmtCount(s.rows)} 行`),
        el('span', { class: 'fed-source-ms' }, `${s.ms} ms`),
        warn));
    }
    // 没推动的条件逐条列出来，让用户知道改写成什么样才推得动
    const skipped = (pushdownInfo && pushdownInfo.skipped) || [];
    if (skipped.length) {
      sourcesHost.append(el('div', { class: 'fed-skipped' },
        el('span', {}, t('未下推：')),
        ...skipped.slice(0, 4).map((item) =>
          el('span', { class: 'fed-skipped-item', title: item.reason }, item.text)),
        skipped.length > 4 ? el('span', {}, t('…另有 {n} 条', { n: skipped.length - 4 })) : null));
    }
  }

  // ---- 结果 ----
  let grid = null;
  function showResult(r) {
    rbody.innerHTML = '';
    const host = el('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
    // 只读：结果是本地内存里的临时表，改它既改不到源库，也会让人以为改到了
    grid = new DataGrid(host, { editable: false });
    const bar = el('div', { class: 'pane-info' },
      el('span', {}, `${r.rowCountExact === false ? t('超过 ') : ''}${fmtCount(r.rowCount)} 行 · ${r.ms} ms`
        + (r.computeMs !== null && r.computeMs !== undefined ? t('（本地计算 {n} ms）', { n: r.computeMs }) : '')),
      el('span', {
        title: t('结果来自本地内存引擎里的临时表，无法就地编辑；要改数据请到对应的源库里改'),
        style: { color: 'var(--text-muted)' },
      }, t('只读')),
      r.truncated
        ? el('span', { style: { color: 'var(--orange, var(--text-muted))' } },
            t('仅显示前 {n} 行，可在「选项 → 查询 → 结果行数上限」调整', { n: r.rows.length }))
        : null,
      el('span', { class: 'spring' }));
    rbody.append(el('div', { class: 'result-page active' }, host, bar));
    grid.setData({ columns: r.columns, rows: r.rows, pk: [] });
  }

  // 复用查询页的消息样式，不另起一套错误展示
  function showError(message) {
    rbody.innerHTML = '';
    rbody.append(el('div', { class: 'result-page active' },
      el('div', { class: 'msg-list' },
        el('div', { class: 'msg-item error' }, message))));
  }

  // ---- 执行 ----
  async function run() {
    if (running) return;
    const sql = (cm.getSelection() || cm.getValue()).trim();
    if (!sql) { toast.info(t('请输入要执行的查询')); return; }
    running = true;
    btnRun.disabled = true;
    btnStop.disabled = false;
    btnSaveResult.disabled = true;
    btnExport.disabled = true;
    runToken = uid('fedrun');
    const startedAt = Date.now();
    setStatus(t('正在拉取源表…'), t('各源表并发读取，读完才在本地开始计算'), 'running');
    statusbar.setLeft(t('联邦查询执行中'));
    const offProgress = window.api.fed.onProgress((p) => {
      if (p.phase === 'fetch') {
        setStatus(t('正在拉取源表…'), t('已完成 {done}/{total}：{label}', {
          done: p.done, total: p.total, label: p.label || '',
        }), 'running');
      } else if (p.phase === 'compute') {
        setStatus(t('正在本地计算…'), t('源表已就位，开始在本地引擎执行查询'), 'running');
      }
    }, runToken);
    try {
      const id = await ensureSession();
      const r = await window.api.fed.run({
        sessionId: id,
        sql,
        token: runToken,
        maxRowsPerSource: getSetting('federatedMaxRows'),
        resultMaxRows: getSetting('queryMaxRows'),
      });
      lastResult = r;
      hasSavableResult = true;
      renderSources(r.sources, r.pushdown);
      showResult(r);
      setStatus(t('执行完成'), t('{n} 张源表 · 共 {ms} ms', { n: r.sources.length, ms: r.ms }), 'ok');
      statusbar.setLeft(t('联邦查询完成'));
      statusbar.setRight(`${r.ms} ms`);
      btnSaveResult.disabled = false;
      btnExport.disabled = false;
    } catch (e) {
      lastResult = null;
      hasSavableResult = false;
      renderSources(null);
      showError(e.message);
      setStatus(t('执行失败'), e.message.split('\n')[0], 'error');
      statusbar.setLeft(t('联邦查询失败'));
      statusbar.setRight(`${Date.now() - startedAt} ms`);
    } finally {
      offProgress();
      running = false;
      runToken = null;
      btnRun.disabled = false;
      btnStop.disabled = true;
    }
  }

  async function stop() {
    if (!running || !runToken) return;
    try {
      const hit = await window.api.fed.cancel(runToken);
      if (hit) setStatus(t('正在取消…'), t('已向各源表发出取消'), 'running');
      else toast.info(t('已经拉取完成，正在本地计算，无法中途取消'));
    } catch (e) {
      toast.error(t('取消失败：') + e.message);
    }
  }

  async function saveResult() {
    if (!hasSavableResult) { toast.info(t('请先执行一次查询')); return; }
    const name = await promptDialog(t('结果存为本地表'),
      t('表名（后续查询可直接按这个名字引用）:'), 'r1');
    if (!name) return;
    try {
      const r = await window.api.fed.saveResult(sessionId, name);
      toast.success(t('已保存为本地表 {name}（{n} 行）', { name: r.name, n: fmtCount(r.rows) }));
      await refreshLocalTables();
    } catch (e) {
      toast.error(t('保存失败：') + e.message);
    }
  }

  async function exportResult(e) {
    if (!lastResult) return;
    const { showRowsExportMenu } = await import('./exportMenu.js');
    // connId 传 null：结果不属于任何一个源库，用通用 SQL 方言导出
    showRowsExportMenu(e.clientX, e.clientY, {
      connId: null, columns: lastResult.columns, rows: lastResult.rows, defaultName: 'federated',
    });
  }

  async function refreshLocalTables() {
    if (!sessionId) return;
    try {
      const info = await window.api.fed.describe(sessionId);
      const names = (info.results || []).map((r) => r.name);
      statusDetail.textContent = names.length
        ? t('本地结果表：{names}', { names: names.join('、') })
        : statusDetail.textContent;
    } catch (e) { /* 会话可能已经关了 */ }
  }

  /** 从已打开的连接里挑一张表，插入 [连接.库.表] 引用 */
  function insertRefMenu(e) {
    const openConns = state.connections.filter((c) => state.open.has(c.id));
    if (!openConns.length) {
      toast.info(t('请先在左侧连接树里打开至少一个连接'));
      return;
    }
    const items = openConns.map((conn) => {
      const oc = state.open.get(conn.id);
      const dbs = (oc && oc.databases) || [];
      const submenu = dbs.length
        ? dbs.slice(0, 40).map((db) => ({
            label: String(db),
            onClick: () => insertRef(conn, String(db)),
          }))
        : [{ label: t('（展开该连接以加载数据库列表）'), disabled: true }];
      return { label: connLabel(conn.id), icon: 'link', submenu };
    });
    showMenu(e.clientX, e.clientY, items);
  }

  function insertRef(conn, db) {
    // 连接名含点时用双引号包住，否则解析端无法区分"连接名的一部分"和"库名"
    const name = String(conn.name || conn.id);
    const quoted = name.includes('.') ? `"${name.replace(/"/g, '""')}"` : name;
    cm.replaceSelection(`[${quoted}.${db}.表名]`);
    cm.focus();
  }

  renderSources(null);
  setTimeout(() => cm.focus(), 60);
  // 冒烟测试用的钩子，与 queryTab 的 tab._run 同款
  tab._run = run;
  tab._setSql = (text) => cm.setValue(text);
  tab._sessionId = () => sessionId;
  tab._saveResult = (name) => window.api.fed.saveResult(sessionId, name);
  return tab;
}
