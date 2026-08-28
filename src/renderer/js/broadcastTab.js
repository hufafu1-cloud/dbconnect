// 多库广播执行标签页（路线图 v2.7.0 M2）
//
// 分库分表 / 多环境下同一条 SQL 要在 N 个库跑一遍，原来只能开 N 个标签页点 N 次。
//
// 界面上有三处是刻意这么设计的：
//
// 1. **执行前先把展开出来的目标列出来。** 通配符写错一个字符，影响的是「跑到哪些库上」，
//    而这是广播唯一不能出错的地方。所以选择规则改一次就重新展开一次，
//    目标清单一直摆在眼前，生产库还会标红。
//
// 2. **成败矩阵永远显示**，哪怕全部成功。广播不是原子操作——一半成功一半失败是
//    正常结果，界面必须让人一眼看出「哪几个库没跑成」，而不是只给一个总数。
//
// 3. **失败项能单独重试**，不必整批重来。32 个库里挂了 1 个，重跑 32 个既慢又可能
//    把已经成功的写操作再做一遍。
import { el, iconEl, fmtCount } from './util.js';
import { state, connLabel } from './state.js';
import { addTab, uid } from './tabs.js';
import { DataGrid } from './grid.js';
import { toast, promptDialog, confirmDialog } from './toast.js';
import { statusbar } from './statusbar.js';
import { showMenu } from './contextmenu.js';
import { openEditorSearch, closeEditorSearch, editorSearchNext } from './editorSearch.js';
import { getSetting } from './settings.js';
import { editorRunsOnF5 } from './keymaps.js';
import { authorizeOperation } from './danger.js';
import { t } from './i18n.js';

let bcNo = 0;

const SAMPLE_SQL = `-- 多库广播：同一条 SQL 在选中的每个库各跑一遍，结果纵向合并并带上来源列。
-- 连接名与库名都支持通配，例如 连接 = 订单库-*、库 = shop_*
-- SELECT 会合并成一张表；写操作会给出逐库的成败矩阵，失败的可以单独重试。
SELECT COUNT(*) AS 行数 FROM t;
`;

export function openBroadcastTab(opts = {}) {
  const tabId = (opts && opts.restoreId) || uid('bc');
  const restore = (opts && opts.restoreState) || null;
  bcNo++;
  const tabTitle = (restore && restore.title) || `广播执行 ${bcNo}`;
  const tab = addTab({
    id: tabId, title: tabTitle, icon: 'transfer',
    tooltip: t('多库广播执行：一条 SQL 跑遍选中的所有库'),
  });
  if (tab.pane.childElementCount) return tab;
  const pane = tab.pane;
  pane.classList.add('query-pane');

  let selectors = (restore && Array.isArray(restore.selectors) && restore.selectors.length)
    ? restore.selectors.map((s) => ({ conn: s.conn || '', db: s.db || '' }))
    : [{ conn: '', db: '' }];
  let targets = [];
  let misses = [];
  let running = false;
  let runToken = null;
  let lastResult = null;
  let lastTargets = [];

  // ---- 工具栏 ----
  const mkBtn = (icon, label, onClick, extra) =>
    el('button', { class: 'pbtn' + (extra ? ' ' + extra : ''), onClick }, iconEl(icon), label);

  const btnRun = mkBtn('run', t('广播执行'), () => run(), 'success');
  btnRun.title = t('在下面列出的每个目标上各执行一遍 (Ctrl+Enter)');
  const btnStop = mkBtn('cross', t('停止'), () => stop(), 'danger');
  btnStop.disabled = true;
  const btnRetry = mkBtn('refresh', t('重试失败项'), () => retryFailed());
  btnRetry.disabled = true;
  const btnGroups = mkBtn('folder', t('广播组'), (e) => groupsMenu(e));
  const compareBox = el('input', { type: 'checkbox' });
  const concurrencySel = el('select', { class: 'settings-select', style: { minWidth: '64px' } },
    ...[1, 2, 4, 8, 16].map((n) => el('option', { value: String(n) }, String(n))));
  concurrencySel.value = String((restore && restore.concurrency) || 4);
  concurrencySel.title = t('同时最多向几个库发起执行');

  const toolbar = el('div', { class: 'pane-toolbar query-toolbar' },
    el('div', { class: 'query-toolbar-group' },
      el('span', { class: 'query-toolbar-label' }, t('执行')), btnRun, btnStop, btnRetry),
    el('span', { class: 'sep' }),
    el('div', { class: 'query-toolbar-group' },
      el('span', { class: 'query-toolbar-label' }, t('目标')), btnGroups,
      el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, t('并发')), concurrencySel),
    el('span', { class: 'sep' }),
    el('label', { class: 'bc-compare' }, compareBox,
      el('span', { title: t('把各库的结果与第一个目标逐行比对，用来找 dev / test / prod 之间的配置漂移') },
        t('多环境对比'))),
    el('span', { class: 'spring' }),
    // 常驻标注：广播不是事务，一半成功一半失败是可能的结果
    el('span', {
      class: 'fed-notice',
      title: t('各库是各自独立执行的，彼此之间没有事务。\n'
        + '写操作可能出现「一部分库成功、一部分库失败」，成败矩阵里会逐库列出来。'),
    }, iconEl('info'), t('逐库独立执行 · 非原子操作')),
  );

  // ---- 目标选择 ----
  const selectorHost = el('div', { class: 'bc-selectors' });
  const targetHost = el('div', { class: 'bc-targets' });

  function renderSelectors() {
    selectorHost.innerHTML = '';
    selectors.forEach((selector, index) => {
      const connInput = el('input', {
        type: 'text', class: 'bc-input', value: selector.conn, spellcheck: false,
        placeholder: t('连接名，支持 * 通配'),
      });
      const dbInput = el('input', {
        type: 'text', class: 'bc-input', value: selector.db, spellcheck: false,
        placeholder: t('库名，支持 * 通配；留空表示该连接的全部库'),
      });
      connInput.addEventListener('input', () => { selector.conn = connInput.value; scheduleExpand(); });
      dbInput.addEventListener('input', () => { selector.db = dbInput.value; scheduleExpand(); });
      selectorHost.append(el('div', { class: 'bc-selector' },
        el('span', { class: 'bc-selector-label' }, t('连接')), connInput,
        el('span', { class: 'bc-selector-label' }, t('库')), dbInput,
        el('button', {
          class: 'pbtn', title: t('从已打开的连接里挑'),
          onClick: (e) => pickMenu(e, selector),
        }, iconEl('link')),
        el('button', {
          class: 'pbtn danger', title: t('删除这条规则'),
          onClick: () => { selectors.splice(index, 1); if (!selectors.length) selectors.push({ conn: '', db: '' }); renderSelectors(); scheduleExpand(); },
        }, '✕')));
    });
    selectorHost.append(el('div', { class: 'bc-selector-actions' },
      el('button', {
        class: 'pbtn',
        onClick: () => { selectors.push({ conn: '', db: '' }); renderSelectors(); },
      }, iconEl('plus'), t('添加规则')),
      el('button', {
        class: 'pbtn',
        onClick: () => saveGroup(),
      }, iconEl('save'), t('存为广播组…'))));
  }

  function pickMenu(e, selector) {
    const open = state.connections.filter((c) => state.open.has(c.id));
    if (!open.length) { toast.info(t('请先在左侧连接树里打开至少一个连接')); return; }
    showMenu(e.clientX, e.clientY, open.map((conn) => {
      const oc = state.open.get(conn.id);
      const dbs = (oc && oc.databases) || [];
      return {
        label: connLabel(conn.id),
        icon: 'link',
        submenu: [
          { label: t('（该连接的全部库）'), onClick: () => { selector.conn = conn.name; selector.db = ''; renderSelectors(); scheduleExpand(); } },
          ...(dbs.length ? [{ sep: true }] : []),
          ...dbs.slice(0, 40).map((db) => ({
            label: String(db),
            onClick: () => { selector.conn = conn.name; selector.db = String(db); renderSelectors(); scheduleExpand(); },
          })),
        ],
      };
    }));
  }

  let expandTimer = null;
  const scheduleExpand = () => {
    clearTimeout(expandTimer);
    expandTimer = setTimeout(expand, 200);
    tab.touchRecovery();
  };

  async function expand() {
    // 渲染进程手上就有树里加载过的库清单，直接带给主进程，
    // 免得「预览选中了什么」这个动作去连一堆库
    const databases = {};
    for (const [connId, oc] of state.open) databases[connId] = (oc && oc.databases) || [];
    try {
      const r = await window.api.bc.expand(selectors.filter((s) => s.conn.trim()), databases);
      targets = r.targets || [];
      misses = r.misses || [];
    } catch (error) {
      targets = [];
      misses = [(error && error.message) || String(error)];
    }
    renderTargets();
  }

  function renderTargets() {
    targetHost.innerHTML = '';
    // 先同步按钮状态：下面「没有目标」那条分支会提前 return
    btnRun.disabled = running || !targets.length;
    const prod = targets.filter((item) => item.env === 'prod');
    targetHost.append(el('div', { class: 'bc-targets-head' },
      iconEl('database'),
      el('span', {}, t('将在 {n} 个目标上执行', { n: targets.length })),
      prod.length
        ? el('span', { class: 'bc-prod-warn' }, t('其中 {n} 个是生产连接', { n: prod.length }))
        : null,
      el('span', { class: 'spring' }),
      ...misses.map((text) => el('span', { class: 'bc-miss', title: text }, text))));
    if (!targets.length) {
      targetHost.append(el('div', { class: 'bc-target-empty' },
        t('还没有匹配到目标。填写上面的规则，或点 🔗 从已打开的连接里挑。')));
      return;
    }
    const list = el('div', { class: 'bc-target-list' });
    for (const item of targets.slice(0, 200)) {
      list.append(el('span', { class: 'bc-target' + (item.env === 'prod' ? ' prod' : '') },
        item.connName, item.db ? el('b', {}, ' / ' + item.db) : null));
    }
    if (targets.length > 200) list.append(el('span', { class: 'bc-target' }, t('…另有 {n} 个', { n: targets.length - 200 })));
    targetHost.append(list);
  }

  // ---- 编辑器 ----
  const statusStrip = el('div', { class: 'query-status-strip' },
    el('span', { class: 'query-status-dot' }),
    el('span', { class: 'query-status-main' }, t('准备执行')),
    el('span', { class: 'query-status-detail' }, t('同一条 SQL 会在上面列出的每个目标上各跑一遍')));
  const statusMain = statusStrip.querySelector('.query-status-main');
  const statusDetail = statusStrip.querySelector('.query-status-detail');
  const setStatus = (main, detail, tone) => {
    statusMain.textContent = main;
    statusDetail.textContent = detail || '';
    statusStrip.dataset.tone = tone || '';
  };

  const editorHost = el('div', { class: 'query-editor' });
  const splitter = el('div', { class: 'splitter-h' });
  const resultsHost = el('div', { class: 'query-results' });
  const rbody = el('div', { class: 'result-body' });
  resultsHost.append(rbody);

  pane.append(toolbar, selectorHost, targetHost, statusStrip, editorHost, splitter, resultsHost);

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
      'F5': () => {
        if (!editorRunsOnF5()) return CodeMirror.Pass;
        run();
        return undefined;
      },
      'Ctrl-Enter': () => run(),
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

  tab.setRecovery('broadcast', () => ({
    title: tabTitle,
    sql: cm.getValue(),
    selectors: selectors.map((s) => ({ ...s })),
    concurrency: Number(concurrencySel.value),
    splitterHeight: splitterHeight || null,
  }));

  // ---- 广播组 ----
  async function groupsMenu(e) {
    let groups = [];
    try { groups = await window.api.bc.groups(); } catch (error) { groups = []; }
    const items = groups.length
      ? groups.map((group) => ({
        label: `${group.name}（${group.selectors.length} 条规则）`,
        icon: 'folder',
        onClick: () => {
          selectors = group.selectors.map((s) => ({ conn: s.conn || '', db: s.db || '' }));
          renderSelectors();
          scheduleExpand();
        },
      }))
      : [{ label: t('（还没有保存过广播组）'), disabled: true }];
    showMenu(e.clientX, e.clientY, [
      ...items,
      { sep: true },
      { label: t('存为广播组…'), icon: 'save', onClick: () => saveGroup() },
      groups.length ? { label: t('删除广播组…'), icon: 'trash', danger: true, submenu: groups.map((group) => ({
        label: group.name,
        onClick: async () => {
          await window.api.bc.deleteGroup(group.name).catch(() => {});
          toast.success(t('已删除广播组 {name}', { name: group.name }));
        },
      })) } : null,
    ].filter(Boolean));
  }

  async function saveGroup() {
    const usable = selectors.filter((s) => s.conn.trim());
    if (!usable.length) { toast.info(t('先填至少一条选择规则')); return; }
    const name = await promptDialog(t('存为广播组'), t('名称:'), '');
    if (!name) return;
    try {
      await window.api.bc.saveGroup(name, usable);
      toast.success(t('已保存广播组 {name}', { name }));
    } catch (error) {
      toast.error(t('保存失败：') + ((error && error.message) || error));
    }
  }

  // ---- 结果 ----
  function renderMatrix(result) {
    const failed = result.matrix.filter((m) => !m.ok);
    const wrap = el('div', { class: 'bc-matrix' });
    wrap.append(el('div', { class: 'bc-matrix-head' },
      el('b', {}, t('逐库结果')),
      el('span', { class: 'bc-ok' }, t('成功 {n}', { n: result.matrix.length - failed.length })),
      failed.length ? el('span', { class: 'bc-fail' }, t('失败 {n}', { n: failed.length })) : null,
      result.cancelled ? el('span', { class: 'bc-fail' }, t('已取消')) : null,
      el('span', { class: 'spring' }),
      el('span', { class: 'bc-atomic' }, t('各库独立执行，非原子操作'))));
    const list = el('div', { class: 'bc-matrix-list' });
    for (const item of result.matrix) {
      list.append(el('div', { class: 'bc-cell' + (item.ok ? '' : ' fail') + (item.env === 'prod' ? ' prod' : ''), title: item.error || '' },
        el('span', { class: 'bc-cell-name' }, `${item.connName}${item.db ? ' / ' + item.db : ''}`),
        el('span', { class: 'bc-cell-stat' }, item.ok
          ? (result.kind === 'select' ? t('{n} 行', { n: fmtCount(item.rows) }) : t('影响 {n} 行', { n: fmtCount(item.affected) }))
          : (item.cancelled ? t('已取消') : (item.timedOut ? t('超时') : t('失败')))),
        el('span', { class: 'bc-cell-ms' }, `${item.ms} ms`),
        item.ok ? null : el('span', { class: 'bc-cell-err' }, item.error)));
    }
    wrap.append(list);
    return wrap;
  }

  function renderDiff(info) {
    if (!info) return null;
    if (!info.comparable) {
      return el('div', { class: 'bc-diff' }, el('b', {}, t('无法对比')), ' ', info.reason);
    }
    const wrap = el('div', { class: 'bc-diff' },
      el('div', {}, el('b', {}, t('多环境对比')), ' ',
        t('以 {base} 为基准（{n} 行）', { base: info.baseline, n: fmtCount(info.baseRows) })));
    for (const item of info.items) {
      wrap.append(el('div', { class: 'bc-diff-item' + (item.same ? ' same' : '') },
        el('span', {}, `${item.connName}${item.db ? ' / ' + item.db : ''}`),
        item.same
          ? el('span', { class: 'bc-ok' }, t('完全一致'))
          : el('span', { class: 'bc-fail' },
            t('基准独有 {a} 行 · 该库独有 {b} 行', { a: item.onlyBase, b: item.onlyThis }))));
    }
    return wrap;
  }

  function showResult(result) {
    rbody.innerHTML = '';
    const page = el('div', { class: 'result-page active' });
    page.append(renderMatrix(result));
    const diffPanel = renderDiff(result.diff);
    if (diffPanel) page.append(diffPanel);
    if (result.kind === 'select') {
      const host = el('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
      const grid = new DataGrid(host, { editable: false });
      const bar = el('div', { class: 'pane-info' },
        el('span', {}, t('合并 {n} 行 · {ms} ms', { n: fmtCount(result.rows.length), ms: result.ms })),
        result.mismatched
          ? el('span', {
            style: { color: 'var(--orange)' },
            title: t('各库返回的列不完全一致，已按列名取并集，缺的列填空。绝不按位置对齐——那会把 A 库的列拼到 B 库的列下面'),
          }, t('各库列不一致，已按列名合并'))
          : null,
        el('span', { class: 'spring' }),
        el('button', { class: 'pbtn', onClick: async (ev) => {
          const { showRowsExportMenu } = await import('./exportMenu.js');
          showRowsExportMenu(ev.clientX, ev.clientY, {
            connId: null, columns: result.columns, rows: result.rows, defaultName: 'broadcast',
          });
        } }, iconEl('exportIcon'), t('导出…')));
      page.append(el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } }, host, bar));
      rbody.append(page);
      grid.setData({ columns: result.columns, rows: result.rows, pk: [] });
      return;
    }
    rbody.append(page);
  }

  function showError(message) {
    rbody.innerHTML = '';
    rbody.append(el('div', { class: 'result-page active' },
      el('div', { class: 'msg-list' }, el('div', { class: 'msg-item error' }, message))));
  }

  // ---- 执行 ----
  async function run(only) {
    if (running) return;
    const list = only || targets;
    if (!list.length) { toast.info(t('还没有匹配到任何目标库')); return; }
    const sql = (cm.getSelection() || cm.getValue()).trim();
    if (!sql) { toast.info(t('请输入要广播的 SQL')); return; }
    // 生产库审批只确认一次，覆盖整批目标
    const payload = {
      targets: list.map((item) => ({ connId: item.connId, db: item.db })),
      sql,
    };
    const approved = await authorizeOperation('db.broadcast', payload,
      { title: t('向多个库广播 SQL') });
    if (!approved) { statusbar.setLeft(t('已取消（未确认广播）')); return; }

    running = true;
    btnRun.disabled = true;
    btnStop.disabled = false;
    btnRetry.disabled = true;
    runToken = uid('bcrun');
    const startedAt = Date.now();
    setStatus(t('广播执行中…'), t('共 {n} 个目标', { n: list.length }), 'running');
    statusbar.setLeft(t('广播执行中'));
    const off = window.api.bc.onProgress((p) => {
      setStatus(t('广播执行中…'), t('已完成 {done}/{total}：{label}', {
        done: p.done, total: p.total, label: p.label || '',
      }), 'running');
    }, runToken);
    try {
      const result = await window.api.bc.run({
        ...approved,
        targets: list,
        token: runToken,
        maxRows: getSetting('queryMaxRows'),
        concurrency: Number(concurrencySel.value),
        compare: compareBox.checked,
      });
      lastResult = result;
      lastTargets = list;
      showResult(result);
      const failed = result.matrix.filter((m) => !m.ok).length;
      btnRetry.disabled = !failed;
      setStatus(failed ? t('部分目标失败') : t('全部成功'),
        t('{ok} 成功 · {bad} 失败 · 共 {ms} ms', {
          ok: result.matrix.length - failed, bad: failed, ms: result.ms,
        }), failed ? 'error' : 'ok');
      statusbar.setLeft(failed ? t('广播部分失败') : t('广播完成'));
      statusbar.setRight(`${result.ms} ms`);
    } catch (error) {
      lastResult = null;
      showError((error && error.message) || String(error));
      setStatus(t('广播失败'), String((error && error.message) || error).split('\n')[0], 'error');
      statusbar.setLeft(t('广播失败'));
      statusbar.setRight(`${Date.now() - startedAt} ms`);
    } finally {
      off();
      running = false;
      runToken = null;
      btnRun.disabled = !targets.length;
      btnStop.disabled = true;
    }
  }

  async function retryFailed() {
    if (!lastResult) return;
    const failedKeys = new Set(lastResult.matrix.filter((m) => !m.ok)
      .map((m) => `${m.connId}|${m.db}`));
    const retry = lastTargets.filter((item) => failedKeys.has(`${item.connId}|${item.db || ''}`));
    if (!retry.length) { toast.info(t('没有失败的目标')); return; }
    const ok = await confirmDialog(t('重试失败项'),
      t('将只在这 {n} 个失败的目标上重新执行，已经成功的不会再跑一遍。', { n: retry.length }),
      { okLabel: t('重试') });
    if (!ok) return;
    await run(retry);
  }

  async function stop() {
    if (!running || !runToken) return;
    try {
      const hit = await window.api.bc.cancel(runToken);
      if (hit) setStatus(t('正在取消…'), t('已向各库发出取消'), 'running');
      else toast.info(t('已经执行完毕，无法取消'));
    } catch (error) {
      toast.error(t('取消失败：') + ((error && error.message) || error));
    }
  }

  renderSelectors();
  renderTargets();
  void expand();
  setTimeout(() => cm.focus(), 60);
  tab._run = run;
  tab._setSql = (text) => cm.setValue(text);
  tab._setSelectors = (list) => { selectors = list.map((s) => ({ ...s })); renderSelectors(); return expand(); };
  tab._targets = () => targets.slice();
  tab._result = () => lastResult;
  return tab;
}
