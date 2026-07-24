// 查询标签页：CodeMirror SQL 编辑器 + 多结果集 + 信息面板
import { el, iconEl, fmtCount } from './util.js';
import { state, connLabel, connColor, objectsCacheKey, emit, setActiveTarget } from './state.js';
import { addTab, uid } from './tabs.js';
import { DataGrid } from './grid.js';
import { toast, promptDialog, openModal } from './toast.js';
import { statusbar } from './statusbar.js';
import { showMenu } from './contextmenu.js';
import { openEditorSearch, closeEditorSearch, editorSearchNext } from './editorSearch.js';

const CM_MODES = { mysql: 'text/x-mysql', postgres: 'text/x-pgsql', mssql: 'text/x-mssql', sqlite: 'text/x-sqlite', clickhouse: 'text/x-mysql', oceanbase: 'text/x-mysql', oboracle: 'text/x-plsql' };
let queryNo = 0;

function formatQueryRowCount(result) {
  return result.rowCountExact === false
    ? `超过 ${fmtCount(result.rowCount)} 行`
    : `${fmtCount(result.rowCount)} 行`;
}

const SQL_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'INSERT INTO', 'UPDATE', 'DELETE FROM', 'SET', 'VALUES', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN',
  'JOIN', 'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'IS NOT NULL', 'IN', 'LIKE', 'BETWEEN',
  'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC',
  'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE', 'UNION', 'UNION ALL', 'EXISTS'];
const ID_CHARS = "[\\w$\\u4e00-\\u9fa5]";

export function openQueryTab(target, initialSql, opts) {
  const restoreState = (opts && opts.restoreState) || null;
  const restoredTarget = restoreState && restoreState.target;
  const initialText = restoreState && typeof restoreState.sql === 'string'
    ? restoreState.sql : (initialSql || '');
  queryNo++;
  const tabId = (opts && opts.restoreId) || uid('query');
  let savedQuery = (restoreState && restoreState.savedQuery) || (opts && opts.saved) || null; // {id, name} 绑定到连接的查询
  const initialTitle = (restoreState && restoreState.title)
    || (savedQuery && savedQuery.name)
    || (restoreState && restoreState.savedPath && restoreState.savedPath.split(/[\\/]/).pop())
    || `查询 ${queryNo}`;
  const restoredConnId = restoredTarget && restoredTarget.connId;
  const tab = addTab({ id: tabId, title: initialTitle, icon: 'query', color: connColor(restoredConnId || (target && target.connId)) });

  let connId = restoredConnId || (target && target.connId);
  let db = (restoredTarget && restoredTarget.db) || (target && target.db);
  let schema = (restoredTarget && restoredTarget.schema) || (target && target.schema) || null;
  let dbUnavailable = false;
  // fileAccess 授权只在当前主进程有效；重启恢复的文件查询必须降级为独立草稿。
  let savedPath = null;
  // 模板/右键生成的 initialSql 是未保存草稿；只有已保存查询才以 initialText 为干净基线。
  let savedText = restoreState
    ? (restoreState.savedPath ? '' : (typeof restoreState.savedText === 'string' ? restoreState.savedText : ''))
    : ((opts && opts.saved) ? initialText : '');
  let running = false;
  let activeRequest = null;
  const transactionId = `query-tx:${tabId}`;
  let transactionState = 'idle';
  let transactionSupported = true;
  let transactionWarning = '';

  const pane = tab.pane;
  pane.classList.add('query-pane');
  function touchRecovery() {
    if (tab.touchRecovery) tab.touchRecovery();
  }

  // ---- 连接 / 数据库选择 ----
  const connSel = el('select', { title: '连接' });
  const dbSel = el('select', { title: '数据库' });
  const prodBadge = el('span', { class: 'tb-env-badge', style: { display: 'none' } }, '生产');
  const schemaBadge = el('span', {
    class: 'tb-context-badge',
    style: { display: 'none', color: 'var(--text-muted)', fontSize: '12px', whiteSpace: 'nowrap' },
  });
  const schemaLabel = el('span', {
    class: 'query-schema-label',
    style: { display: 'none', color: 'var(--text-muted)', fontSize: '12px', whiteSpace: 'nowrap' },
  }, '模式:');
  const schemaSel = el('select', {
    class: 'query-schema-select',
    title: '当前模式（Schema）；未限定对象名将在此模式中解析',
    style: { display: 'none' },
  });
  let schemaLoadSeq = 0;
  function updateEnvBadge() {
    const c = state.connections.find((x) => x.id === connId);
    const env = c && c.env;
    prodBadge.style.display = (env === 'prod' || env === 'test') ? '' : 'none';
    prodBadge.textContent = env === 'prod' ? '生产' : '测试';
    prodBadge.className = 'tb-env-badge env-' + (env || '');
    prodBadge.title = env === 'prod' ? '生产库：危险 SQL 执行前需二次确认' : '测试库';
  }
  function syncActiveContext() {
    if (connId) setActiveTarget({ connId, db, schema }, 'query-tab');
  }
  function updateSchemaBadge() {
    const switchable = connTypeOf(connId) === 'postgres';
    schemaLabel.style.display = switchable ? '' : 'none';
    schemaSel.style.display = switchable ? '' : 'none';
    schemaBadge.style.display = !switchable && schema ? '' : 'none';
    schemaBadge.textContent = schema ? `模式: ${schema}` : '';
    schemaBadge.title = connTypeOf(connId) === 'mssql'
      ? 'SQL Server 不支持会话级搜索路径；对象补全会使用模式限定名'
      : '未限定对象名将优先在此模式中解析';
  }
  async function fillSchemaSel() {
    const seq = ++schemaLoadSeq;
    const expectedConnId = connId;
    const expectedDb = db;
    schemaSel.innerHTML = '';
    updateSchemaBadge();
    if (connTypeOf(connId) !== 'postgres' || !connId || !db || !state.open.has(connId)) {
      schemaSel.dataset.loading = 'false';
      return;
    }
    schemaSel.dataset.loading = 'true';
    schemaSel.disabled = true;
    schemaSel.append(el('option', { value: '' }, '正在加载…'));
    try {
      const schemas = await window.api.db.schemas(connId, db);
      if (seq !== schemaLoadSeq || connId !== expectedConnId || db !== expectedDb) return;
      const available = Array.isArray(schemas) ? schemas.filter(Boolean) : [];
      if (!schema || !available.includes(schema)) {
        schema = available.includes('public') ? 'public' : (available[0] || null);
      }
      schemaSel.innerHTML = '';
      if (!available.length) {
        schemaSel.append(el('option', { value: '' }, '（无可用模式）'));
      } else {
        for (const item of available) {
          schemaSel.append(el('option', {
            value: item,
            selected: item === schema ? 'selected' : null,
          }, item));
        }
        schemaSel.value = schema || '';
      }
      schemaSel.title = '当前模式（Schema）；未限定对象名将在此模式中解析';
    } catch (e) {
      if (seq !== schemaLoadSeq || connId !== expectedConnId || db !== expectedDb) return;
      schema = null;
      schemaSel.innerHTML = '';
      schemaSel.append(el('option', { value: '' }, '模式加载失败'));
      schemaSel.title = `模式加载失败：${e && e.message ? e.message : e}`;
    } finally {
      if (seq === schemaLoadSeq) {
        schemaSel.dataset.loading = 'false';
        updateSchemaBadge();
        syncTransactionUi();
      }
    }
  }
  function fillConnSel() {
    connSel.innerHTML = '';
    const connections = Array.isArray(state.connections) ? state.connections : [];
    const opens = new Set(state.open.keys());
    if (!connId) connSel.append(el('option', { value: '', selected: 'selected' }, '(请选择连接)'));
    for (const saved of connections) {
      const opened = opens.has(saved.id);
      const label = connLabel(saved.id);
      connSel.append(el('option', {
        value: saved.id,
        selected: saved.id === connId ? 'selected' : null,
        title: opened ? '连接已打开' : '选择后自动打开连接',
      }, opened ? label : `${label}（未打开）`));
    }
    if (connId && !connections.some((item) => item.id === connId)) {
      const saved = state.connections.find((item) => item.id === connId);
      connSel.append(el('option', { value: connId, selected: 'selected', disabled: true },
        `${saved ? saved.name : connId}（未打开）`));
    }
    if (connId) connSel.value = connId;
    updateEnvBadge();
  }
  function fillDbSel() {
    dbSel.innerHTML = '';
    const oc = connId && state.open.get(connId);
    const dbs = (oc && oc.databases) || [];
    for (const d of dbs) dbSel.append(el('option', { value: d, selected: d === db ? 'selected' : null }, d));
    if (db && !dbs.includes(db)) {
      dbSel.append(el('option', { value: db, selected: 'selected', disabled: true }, `${db}（不可用）`));
      dbUnavailable = true;
    } else if (!db) {
      db = dbs[0] || null;
      dbUnavailable = false;
    } else {
      dbUnavailable = false;
    }
    if (db) dbSel.value = db;
    dbSel.title = dbUnavailable ? '恢复时保存的数据库已不存在或当前不可用；请明确选择新的数据库后再执行' : '数据库';
    updateSchemaBadge();
  }
  connSel.addEventListener('change', async () => {
    const nextConnId = connSel.value || null;
    const previousConnId = connId;
    if (!(await finishResultEditsBefore('切换连接'))) {
      connSel.value = previousConnId || '';
      return;
    }
    if (!(await finishTransactionBefore('切换连接'))) {
      connSel.value = previousConnId || '';
      return;
    }
    if (nextConnId && !state.open.has(nextConnId)) {
      connSel.disabled = true;
      try {
        const { openConnectionById } = await import('./tree.js');
        await openConnectionById(nextConnId);
      } catch (e) {
        toast.error(`打开连接失败：${e && e.message ? e.message : e}`);
      }
      if (!state.open.has(nextConnId)) {
        connSel.value = previousConnId || '';
        fillConnSel();
        syncTransactionUi();
        return;
      }
    }
    connId = nextConnId;
    db = null;
    schema = null;
    fillDbSel();
    await fillSchemaSel();
    loadHintColumns();
    updateEnvBadge();
    if (cm) cm.setOption('mode', CM_MODES[connTypeOf(connId)] || 'text/x-sql');
    syncActiveContext();
    refreshTransactionSupport();
    syncTransactionUi();
    clearResults();
    touchRecovery();
  });
  dbSel.addEventListener('change', async () => {
    const previousDb = db;
    if (!(await finishResultEditsBefore('切换数据库'))) {
      dbSel.value = previousDb || '';
      return;
    }
    if (!(await finishTransactionBefore('切换数据库'))) {
      dbSel.value = previousDb || '';
      return;
    }
    db = dbSel.value || null;
    dbUnavailable = false;
    schema = null;
    await fillSchemaSel();
    loadHintColumns();
    syncActiveContext();
    updateSchemaBadge();
    syncTransactionUi();
    clearResults();
    touchRecovery();
  });
  schemaSel.addEventListener('change', async () => {
    const previousSchema = schema;
    if (!(await finishResultEditsBefore('切换模式'))) {
      schemaSel.value = previousSchema || '';
      return;
    }
    if (!(await finishTransactionBefore('切换模式'))) {
      schemaSel.value = previousSchema || '';
      return;
    }
    schema = schemaSel.value || null;
    loadHintColumns();
    syncActiveContext();
    updateSchemaBadge();
    syncTransactionUi();
    clearResults();
    touchRecovery();
  });

  const maxRowsSel = el('select', { title: '结果行数上限' },
    el('option', { value: '200' }, '200 行'),
    el('option', { value: '2000', selected: 'selected' }, '2000 行'),
    el('option', { value: '10000' }, '10000 行'));
  if (restoreState && ['200', '2000', '10000'].includes(String(restoreState.maxRows))) {
    maxRowsSel.value = String(restoreState.maxRows);
  }
  maxRowsSel.addEventListener('change', () => touchRecovery());

  const mkBtn = (icon, label, onClick, cls) =>
    el('button', { class: 'pbtn' + (cls ? ' ' + cls : ''), onClick }, iconEl(icon), label);

  const btnRun = mkBtn('run', '运行 (Ctrl+R)', () => run('current'), 'success');
  const btnRunSel = mkBtn('runSel', '运行选中', () => run('selection'));
  const btnRunAll = mkBtn('runSel', '运行全部', () => run('all'));
  const btnStop = mkBtn('stop', '停止', async () => {
    const request = activeRequest;
    if (!request) return;
    btnStop.disabled = true;
    try {
      await window.api.db.cancel(request.connId, request.requestId);
      toast.info('已发送取消请求');
    } catch (e) {
      toast.error(e.message);
      if (running && activeRequest === request) btnStop.disabled = false;
    }
  });
  btnStop.disabled = true;

  const txStatus = el('span', {
    title: '',
    style: { color: 'var(--text-muted)', fontSize: '12px', whiteSpace: 'nowrap' },
  }, '自动提交');
  const btnTxBegin = mkBtn('run', '开始事务', beginTransaction);
  const btnTxCommit = mkBtn('save', '提交', commitTransaction);
  const btnTxRollback = mkBtn('cross', '回滚', rollbackTransaction);
  const transactionControls = el('div', {
    class: 'transaction-controls',
    title: '默认自动提交；点击“开始事务”或在 SQL 中执行 BEGIN 可进入显式事务',
  }, el('span', { class: 'transaction-label' }, '事务'), btnTxBegin, btnTxCommit, btnTxRollback, txStatus);

  const btnAi = mkBtn('ai', 'AI ▾', () => showAiMenu(btnAi));

  function showAiMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, [
      { label: '优化 SQL', icon: 'format', onClick: () => aiAssist('optimize') },
      { label: '解释 SQL', icon: 'info', onClick: () => aiAssist('explain') },
      { label: '排查问题', icon: 'monitor', onClick: () => aiAssist('diagnose') },
      { sep: true },
      { label: '生成 SQL（自然语言）', icon: 'ai', onClick: () => aiAssist('generate') },
      { label: '打开 AI 助手', icon: 'ai', onClick: () => aiAssist(null) },
    ]);
  }

  async function aiAssist(action) {
    const { openAiPanel } = await import('./aiPanel.js');
    let sql = (cm.getSelection() || cm.getValue()).trim().replace(/;\s*$/, '');
    openAiPanel({
      connId, db, schema,
      sql: action === 'generate' ? '' : sql,
      action: action || undefined,
      insertTarget: (text) => { cm.replaceSelection(text); cm.focus(); },
    });
  }

  const toolbar = el('div', { class: 'pane-toolbar query-toolbar' },
    el('div', { class: 'query-toolbar-group' }, el('span', { class: 'query-toolbar-label' }, '执行'), btnRun, btnRunSel, btnRunAll, btnStop),
    el('span', { class: 'sep' }),
    el('div', { class: 'query-toolbar-group' }, el('span', { class: 'query-toolbar-label' }, '连接'), connSel, prodBadge,
      el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '数据库:'), dbSel,
      schemaLabel, schemaSel, schemaBadge),
    el('span', { class: 'sep' }),
    el('div', { class: 'query-toolbar-group' }, el('span', { class: 'query-toolbar-label' }, '工具'), mkBtn('explain', '解释', explainSql), mkBtn('format', '美化', formatSql), btnAi),
    el('div', { class: 'query-toolbar-group' }, el('span', { class: 'query-toolbar-label' }, '文件'), mkBtn('openFile', '打开', openFile), mkBtn('save', '保存', () => saveQuery()), mkBtn('exportIcon', '另存文件', () => saveAsFile())),
    el('span', { class: 'sep' }),
    maxRowsSel,
    el('span', { class: 'sep' }),
    transactionControls,
    el('span', { class: 'spring' }),
  );

  async function explainSql() {
    if (!connId || !state.open.has(connId)) { toast.info('请先打开一个连接'); return; }
    let sql = cm.getSelection() || cm.getValue();
    sql = sql.trim().replace(/;\s*$/, '');
    if (!sql) { toast.info('没有可解释的 SQL'); return; }
    const { openExplainTab } = await import('./explainTab.js');
    openExplainTab({ connId, db, schema }, sql);
  }

  const FORMAT_LANGS = { mysql: 'mysql', oceanbase: 'mysql', clickhouse: 'mysql', postgres: 'postgresql', mssql: 'transactsql', sqlite: 'sqlite', oboracle: 'plsql' };
  async function formatSql() {
    const sel = cm.getSelection();
    const src = sel || cm.getValue();
    if (!src.trim()) return;
    try {
      const out = await window.api.sql.format({
        sql: src,
        language: FORMAT_LANGS[connTypeOf(connId)] || 'sql',
      });
      if (sel) cm.replaceSelection(out);
      else cm.setValue(out);
    } catch (e) {
      toast.error('格式化失败: ' + e.message);
    }
  }

  // ---- 编辑器 ----
  const queryStatus = el('div', { class: 'query-status-strip' },
    el('span', { class: 'query-status-dot' }),
    el('span', { class: 'query-status-main' }, '准备执行'),
    el('span', { class: 'query-status-detail' }, 'SQL 将在当前连接与数据库中运行'));
  const editorHost = el('div', { class: 'query-editor' });
  let splitterHeight = Number(restoreState && restoreState.splitterHeight);
  if (!Number.isFinite(splitterHeight) || splitterHeight < 60 || splitterHeight > 2000) splitterHeight = null;
  if (splitterHeight) editorHost.style.flex = `0 0 ${splitterHeight}px`;
  // ---- 结果区 ----
  const splitter = el('div', { class: 'splitter-h' });
  const resultsHost = el('div', { class: 'query-results' });
  const rtabs = el('div', { class: 'result-tabs' });
  const rbody = el('div', { class: 'result-body' });
  resultsHost.append(rtabs, rbody);

  pane.append(toolbar, queryStatus, editorHost, splitter, resultsHost);

  let cm = CodeMirror(editorHost, {
    value: initialText,
    mode: CM_MODES[connId && connTypeOf(connId)] || 'text/x-sql',
    lineNumbers: true,
    indentWithTabs: false,
    indentUnit: 2,
    tabSize: 2,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    extraKeys: {
      'F5': () => run('current'),
      'Ctrl-Enter': () => run('current'),
      'Ctrl-R': () => run('current'),
      'Shift-Ctrl-R': () => run('selection'),
      'Ctrl-Space': () => triggerHint(),
      'Ctrl-S': () => saveQuery(),
      'Shift-Ctrl-F': () => formatSql(),
      'Ctrl-F': (cmi) => openEditorSearch(cmi),
      'Ctrl-H': (cmi) => openEditorSearch(cmi, { replace: true }),
      'F3': (cmi) => editorSearchNext(cmi),
      'Shift-F3': (cmi) => editorSearchNext(cmi, true),
      'Esc': (cmi) => { if (!closeEditorSearch(cmi)) return CodeMirror.Pass; },
    },
    hintOptions: { completeSingle: false },
  });
  cm.on('change', () => {
    syncTabDirty();
    touchRecovery();
  });
  setTimeout(() => {
    if (!splitterHeight) {
      const measured = Math.round(editorHost.getBoundingClientRect().height);
      if (measured >= 60) splitterHeight = measured;
    }
    cm.refresh();
  }, 30);

  function connTypeOf(id) {
    const c = state.connections.find((x) => x.id === id);
    return c ? c.type : null;
  }

  // 自动补全：列名（整库列清单，按库缓存懒加载）+ 对象缓存里的表名
  let hintCols = null;
  async function loadHintColumns() {
    hintCols = null;
    if (!connId || !db || !state.open.has(connId)) return;
    const oc = state.open.get(connId);
    if (!oc.columnsCache) oc.columnsCache = new Map();
    const key = `${db}|${schema || ''}`;
    if (!oc.columnsCache.has(key)) {
      try {
        oc.columnsCache.set(key, await window.api.db.allColumns(connId, db, schema));
      } catch (e) {
        oc.columnsCache.set(key, {});
      }
    }
    hintCols = oc.columnsCache.get(key);
  }
  function refreshHintTables() { /* 数据实时读取，无需预构建 */ }

  // 汇总补全数据：表→列、库→表清单、表名清单
  function buildHintData() {
    const oc = connId && state.open.get(connId);
    const tableCols = new Map(); // lower(table) -> {name, cols:[]}
    const tableSet = new Set();
    const dbTables = new Map();   // lower(db) -> [tableNames]
    if (hintCols) {
      for (const [t, cols] of Object.entries(hintCols)) {
        tableCols.set(t.toLowerCase(), { name: t, cols: cols.slice() });
        tableSet.add(t);
      }
      if (db) dbTables.set(db.toLowerCase(), Object.keys(hintCols));
    }
    if (oc) {
      for (const [key, objs] of oc.objectsCache) {
        const dbName = (key.split('|')[0] || '').toLowerCase();
        const names = [...objs.tables.map((t) => t.name), ...objs.views.map((v) => v.name)];
        if (dbName) { if (!dbTables.has(dbName)) dbTables.set(dbName, []); dbTables.get(dbName).push(...names); }
        for (const n of names) { tableSet.add(n); if (!tableCols.has(n.toLowerCase())) tableCols.set(n.toLowerCase(), { name: n, cols: [] }); }
      }
    }
    let tableList = [...tableSet].sort((a, b) => a.localeCompare(b));
    if (connTypeOf(connId) === 'mssql' && schema) {
      const bracket = (name) => `[${String(name).replace(/]/g, ']]')}]`;
      tableList = tableList.map((name) => `${bracket(schema)}.${bracket(name)}`);
    }
    return { tableCols, dbTables, tableList };
  }

  // 当前光标所在的单条语句文本（按 ; 切分），用于把补全范围限定在本语句
  function currentStmt() {
    const full = cm.getValue();
    const pos = cm.indexFromPos(cm.getCursor());
    const start = full.lastIndexOf(';', pos - 1) + 1;
    let end = full.indexOf(';', pos);
    if (end < 0) end = full.length;
    return full.slice(start, end);
  }

  // 解析 FROM/JOIN 中的别名：alias(lower) -> 表名
  function resolveAliases(text) {
    const map = new Map();
    const re = new RegExp(`\\b(?:from|join|update)\\s+[\`"\\[]?(${ID_CHARS}+(?:\\.${ID_CHARS}+)?)[\`"\\]]?(?:\\s+as)?\\s+[\`"\\[]?([a-z_]\\w*)[\`"\\]]?`, 'gi');
    let m;
    while ((m = re.exec(text))) {
      const alias = m[2];
      if (/^(on|where|inner|left|right|join|group|order|using|cross|natural|set|values|having|limit)$/i.test(alias)) continue;
      let tbl = m[1];
      if (tbl.includes('.')) tbl = tbl.split('.').pop();
      map.set(alias.toLowerCase(), tbl);
    }
    return map;
  }

  // 当前语句 FROM/JOIN/UPDATE/INTO 引用的所有表（无论有无别名，含逗号分隔）→ [表名小写]
  function tablesInScope(text) {
    const names = new Set();
    const re = new RegExp(`\\b(?:from|join|update|into)\\s+([\`"\\[]?${ID_CHARS}+(?:\\.${ID_CHARS}+)?[\`"\\]]?(?:\\s*,\\s*[\`"\\[]?${ID_CHARS}+(?:\\.${ID_CHARS}+)?[\`"\\]]?)*)`, 'gi');
    let m;
    while ((m = re.exec(text))) {
      for (let seg of m[1].split(',')) {
        seg = seg.trim().replace(/^[`"\[]|[`"\]]$/g, '');
        if (seg.includes('.')) seg = seg.split('.').pop();
        if (seg) names.add(seg.toLowerCase());
      }
    }
    return names;
  }

  // 自定义补全函数
  function sqlHint(cmInstance) {
    const cur = cmInstance.getCursor();
    const lineText = cmInstance.getLine(cur.line).slice(0, cur.ch);
    const data = buildHintData();
    const startsWith = (arr, p) => {
      if (!p) return arr.slice();
      const lp = p.toLowerCase();
      const pre = arr.filter((x) => x.toLowerCase().startsWith(lp));
      return pre.length ? pre : arr.filter((x) => x.toLowerCase().includes(lp));
    };
    const stmt = currentStmt();
    // 限定符.部分  （表.字段 / 库.表 / 别名.字段）
    const dotRe = new RegExp(`[\`"\\[]?(${ID_CHARS}+)[\`"\\]]?\\.(${ID_CHARS}*)$`);
    let m = dotRe.exec(lineText);
    if (m) {
      const qual = m[1].toLowerCase();
      const partial = m[2];
      const from = CodeMirror.Pos(cur.line, cur.ch - partial.length);
      const aliases = resolveAliases(stmt);
      let cands = null;
      if (data.tableCols.has(qual) && data.tableCols.get(qual).cols.length) cands = data.tableCols.get(qual).cols;
      else if (aliases.has(qual) && data.tableCols.has(aliases.get(qual).toLowerCase())) cands = data.tableCols.get(aliases.get(qual).toLowerCase()).cols;
      else if (data.dbTables.has(qual)) cands = data.dbTables.get(qual);
      else if (data.tableCols.has(qual)) cands = data.tableCols.get(qual).cols; // 表已知但列未加载
      if (cands) {
        const list = startsWith([...new Set(cands)], partial);
        return list.length ? { list, from, to: cur } : null;
      }
      return null;
    }
    // 裸词：根据位置决定优先「表名」还是「字段」
    const wm = new RegExp(`(${ID_CHARS}*)$`).exec(lineText);
    const partial = wm ? wm[1] : '';
    const from = CodeMirror.Pos(cur.line, cur.ch - partial.length);
    const before = lineText.slice(0, lineText.length - partial.length);
    const lastKw = (before.match(/([\w$]+)\s*$/) || [])[1] || '';
    const inTablePos = /^(from|join|into|update|table)$/i.test(lastKw);
    const tables = startsWith(data.tableList, partial);
    const kws = partial ? SQL_KEYWORDS.filter((k) => k.toLowerCase().startsWith(partial.toLowerCase())) : [];

    if (inTablePos) {
      const list = [...tables, ...kws];
      return list.length ? { list, from, to: cur } : null;
    }
    // 列位置：把当前语句 FROM 中各表(无别名也算)的字段补进来，字段优先
    const scopeCols = [];
    for (const t of tablesInScope(stmt)) {
      const tc = data.tableCols.get(t);
      if (tc && tc.cols.length) scopeCols.push(...tc.cols);
    }
    const cols = startsWith([...new Set(scopeCols)], partial);
    const seen = new Set(cols.map((c) => c.toLowerCase()));
    const list = [...cols, ...tables.filter((t) => !seen.has(t.toLowerCase())), ...kws];
    return list.length ? { list, from, to: cur } : null;
  }

  function triggerHint() {
    if (cm.state.completionActive) return;
    cm.showHint({ hint: sqlHint, completeSingle: false });
  }

  // 输入时自动弹出补全：'.' 总是触发；标识符字符在已输入 ≥1 个字符时触发
  cm.on('inputRead', (cmi, change) => {
    if (cmi.state.completionActive) return;
    const ch = change.text && change.text[0];
    if (!ch) return;
    const tok = cmi.getTokenAt(cmi.getCursor());
    if (tok.type === 'string' || tok.type === 'comment') return; // 字符串/注释里不打扰
    if (ch === '.') { triggerHint(); return; }
    if (new RegExp(`^${ID_CHARS}$`).test(ch)) {
      const before = cmi.getLine(cmi.getCursor().line).slice(0, cmi.getCursor().ch);
      const wm = new RegExp(`(${ID_CHARS}+)$`).exec(before);
      if (wm && wm[1].length >= 1) triggerHint();
    }
  });

  // ---- 结果渲染 ----
  let pages = [];
  let resultEditors = [];
  function hasDirtyResultEdits() {
    return resultEditors.some((editor) => editor.grid.isDirty());
  }
  function syncTabDirty() {
    if (!cm) return;
    tab.setDirty(cm.getValue() !== savedText || transactionState !== 'idle' || hasDirtyResultEdits());
  }
  function clearResults() {
    rtabs.innerHTML = '';
    rbody.innerHTML = '';
    pages = [];
    resultEditors = [];
    syncTabDirty();
  }
  function addResultPage(title, contentEl, isError) {
    const idx = pages.length;
    const rt = el('div', { class: 'rtab' + (isError ? ' error' : ''), onClick: () => activatePage(idx) }, title);
    const pg = el('div', { class: 'result-page' }, contentEl);
    rtabs.append(rt);
    rbody.append(pg);
    pages.push({ rt, pg });
    return idx;
  }
  function activatePage(idx) {
    pages.forEach((p, i) => {
      p.rt.classList.toggle('active', i === idx);
      p.pg.classList.toggle('active', i === idx);
    });
  }

  function renderMessages(results, totalMs) {
    const list = el('div', { class: 'msg-list' });
    for (const r of results) {
      if (r.error) {
        list.append(el('div', { class: 'msg-item error' }, `✗ ${r.sql}\n${r.error}`));
      } else if (r.columns) {
        list.append(el('div', { class: 'msg-item' },
          el('span', { class: 'msg-sql' }, r.sql + '  →  '),
          el('b', {}, formatQueryRowCount(r)),
          ` · ${r.ms} ms` + (r.truncated ? ' · 仅显示前面部分' : '')));
      } else {
        const note = r.message && r.message.includes('不返回影响行数');
        const summary = r.message || (note ? '执行成功' : `影响 ${fmtCount(r.affected)} 行`);
        list.append(el('div', { class: 'msg-item' },
          el('span', { class: 'msg-sql' }, r.sql + '  →  '),
          el('b', {}, summary),
          r.warning ? ` · ${r.warning}` : '',
          (r.insertId ? ` · 新ID ${r.insertId}` : '') + ` · ${r.ms} ms`));
      }
    }
    if (!results.length) list.append(el('div', { class: 'msg-item' }, '（没有要执行的语句）'));
    list.append(el('div', { style: { color: 'var(--text-muted)', marginTop: '6px' } }, `总耗时 ${totalMs} ms`));
    return list;
  }

  function syncTransactionUi() {
    const stateChanging = ['starting', 'committing', 'rolling-back'].includes(transactionState);
    connSel.disabled = running || stateChanging;
    dbSel.disabled = running || stateChanging;
    schemaSel.disabled = running || stateChanging || schemaSel.dataset.loading === 'true'
      || connTypeOf(connId) !== 'postgres' || !schema || !schemaSel.options.length;
    btnRun.disabled = running || dbUnavailable;
    btnRunSel.disabled = running || dbUnavailable;
    btnRunAll.disabled = running || dbUnavailable;
    btnTxBegin.disabled = running || !transactionSupported || transactionState !== 'idle';
    btnTxCommit.disabled = running || transactionState !== 'active';
    btnTxRollback.disabled = running || !['active', 'failed'].includes(transactionState);
    if (!transactionSupported) {
      txStatus.textContent = '仅自动提交';
    } else if (transactionState === 'failed') {
      txStatus.textContent = '事务异常 · 请回滚';
    } else if (transactionState === 'active') {
      txStatus.textContent = '事务中';
    } else if (transactionState === 'starting') {
      txStatus.textContent = '正在开始事务…';
    } else if (transactionState === 'committing') {
      txStatus.textContent = '正在提交…';
    } else if (transactionState === 'rolling-back') {
      txStatus.textContent = '正在回滚…';
    } else {
      txStatus.textContent = '自动提交';
    }
    txStatus.title = transactionWarning || '';
    txStatus.style.display = '';
    if (queryStatus) {
      const main = queryStatus.querySelector('.query-status-main');
      const detail = queryStatus.querySelector('.query-status-detail');
      const dot = queryStatus.querySelector('.query-status-dot');
      if (main) main.textContent = running ? '正在执行' : (transactionState === 'active' ? '事务进行中' : '准备执行');
      if (detail) detail.textContent = `${connId ? connLabel(connId) : '未选择连接'}${db ? ` › ${db}` : ''}${schema ? ` › ${schema}` : ''}${transactionState === 'active' ? ' · 手动提交模式' : ' · 自动提交'}`;
      if (dot) dot.style.background = transactionState === 'failed' ? 'var(--danger)' : (running ? 'var(--orange)' : 'var(--green)');
    }
    if (cm) {
      syncTabDirty();
    }
  }

  async function refreshTransactionSupport(force = false) {
    if (!connId || !state.open.has(connId)) {
      transactionSupported = true;
      transactionWarning = '';
      if (transactionState !== 'idle') transactionState = 'idle';
      syncTransactionUi();
      return;
    }
    if (!force && transactionState !== 'idle') return;
    const expectedConnId = connId;
    try {
      const status = await window.api.db.transactionStatus(connId, transactionId);
      if (connId !== expectedConnId) return;
      transactionSupported = status.supported !== false;
      transactionWarning = status.warning || '';
      transactionState = status.state === 'unsupported' ? 'idle' : (status.state || 'idle');
    } catch (e) {
      if (connId !== expectedConnId) return;
      transactionSupported = false;
      transactionWarning = e.message;
    }
    syncTransactionUi();
  }

  async function startTransaction(showToast) {
    if (running) return false;
    if (!connId || !state.open.has(connId)) { toast.info('请先打开一个连接'); return false; }
    if (dbUnavailable) { toast.info('保存的数据库当前不可用，请先明确选择新的数据库'); return false; }
    if (!transactionSupported) { toast.info(transactionWarning || '当前数据库仅支持自动提交'); return false; }
    if (transactionState === 'active') return true;
    if (transactionState === 'failed') { toast.info('当前事务已发生错误，请先回滚'); return false; }
    transactionState = 'starting';
    syncTransactionUi();
    try {
      const status = await window.api.db.beginTransaction(connId, transactionId, db, schema);
      transactionState = status.state || 'active';
      transactionWarning = status.warning || transactionWarning;
      if (showToast) toast.success('事务已开始');
      return true;
    } catch (e) {
      transactionState = 'idle';
      toast.error('开始事务失败: ' + e.message);
      return false;
    } finally {
      syncTransactionUi();
    }
  }

  function beginTransaction() { return startTransaction(true); }

  async function commitTransaction() {
    if (running || transactionState !== 'active') return;
    transactionState = 'committing';
    syncTransactionUi();
    try {
      const result = await window.api.db.commitTransaction(connId, transactionId);
      transactionState = 'idle';
      if (result && result.warning) toast.info(result.warning, 12000);
      else toast.success('事务已提交');
    } catch (e) {
      // 主进程无论提交成功与否都会释放该事务会话，避免未知事务继续悬挂。
      transactionState = 'idle';
      toast.error('提交事务失败: ' + e.message);
    } finally {
      syncTransactionUi();
    }
  }

  async function rollbackTransaction() {
    if (running || !['active', 'failed'].includes(transactionState)) return;
    transactionState = 'rolling-back';
    syncTransactionUi();
    try {
      const result = await window.api.db.rollbackTransaction(connId, transactionId);
      transactionState = 'idle';
      if (result && result.warning) toast.info(result.warning, 12000);
      else toast.success('事务已回滚');
    } catch (e) {
      transactionState = 'idle';
      toast.error('回滚事务失败: ' + e.message);
    } finally {
      syncTransactionUi();
    }
  }

  async function sqlForRunMode(mode) {
    if (mode === 'all') return cm.getValue();
    const selection = cm.getSelection();
    if (mode === 'selection') {
      if (!selection.trim()) { toast.info('请先选择要运行的 SQL'); return ''; }
      return selection;
    }
    // F5 / Ctrl+Enter：有选区优先执行选区，否则只执行光标所在语句。
    if (selection.trim()) return selection;
    const dialects = { oceanbase: 'mysql', oboracle: 'oracle' };
    const type = connTypeOf(connId) || 'sql';
    const found = await window.api.sql.statementAt(
      cm.getValue(), dialects[type] || type, cm.indexFromPos(cm.getCursor()),
    );
    return found && found.sql || '';
  }

  async function run(mode = 'current') {
    if (running) return;
    if (!(await finishResultEditsBefore('重新执行查询'))) return;
    if (!connId || !state.open.has(connId)) { toast.info('请先打开一个连接'); return; }
    if (dbUnavailable) { toast.info('保存的数据库当前不可用，请先明确选择新的数据库'); return; }
    const sql = await sqlForRunMode(mode);
    if (!sql.trim()) { toast.info('没有可执行的 SQL'); return; }
    const queryConnId = connId;
    const requestId = uid('query-request');
    const queryPayload = {
      connId: queryConnId, db, schema, sql, maxRows: Number(maxRowsSel.value), requestId,
      transactionId,
    };
    let approvedQuery;
    try {
      const { authorizeOperation } = await import('./danger.js');
      approvedQuery = await authorizeOperation('db.query', queryPayload);
    } catch (e) {
      toast.error('生产库安全检查失败：' + e.message);
      return;
    }
    if (!approvedQuery) { statusbar.setLeft('已取消（生产库危险操作未确认）'); return; }
    running = true;
    activeRequest = { connId: queryConnId, requestId };
    btnRun.disabled = true;
    btnRunSel.disabled = true;
    btnRunAll.disabled = true;
    btnStop.disabled = false;
    syncTransactionUi();
    statusbar.setLeft('正在执行查询…');
    clearResults();
    const waiting = addResultPage('信息', el('div', { class: 'msg-list' }, '执行中…'), false);
    activatePage(waiting);
    const t0 = Date.now();
    try {
      const results = await window.api.db.query(queryConnId, approvedQuery);
      const totalMs = Date.now() - t0;
      clearResults();
      const hasError = results.some((r) => r.error);
      addResultPage(hasError ? '信息 ✗' : '信息', renderMessages(results, totalMs), hasError);
      let n = 0;
      for (const r of results) {
        if (!r.columns) continue;
        n++;
        const host = el('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
        const editTarget = r.editTarget || null;
        let editor = null;
        const grid = new DataGrid(host, {
          editable: !!editTarget,
          onChange: () => {
            if (editor && editor.saveButton) editor.saveButton.disabled = !grid.isDirty() || editor.saving;
            syncTabDirty();
          },
          onSave: editTarget ? () => { if (editor) void saveResultEditor(editor); } : null,
          copyContext: {
            table: editTarget ? editTarget.table : 'result_table',
            connId: queryConnId,
            db: editTarget ? editTarget.db : db,
            schema: editTarget ? editTarget.schema : schema,
            connType: connTypeOf(queryConnId),
          },
        });
        grid.setData({ columns: r.columns, rows: r.rows, pk: editTarget ? editTarget.pk : [] });
        const saveButton = editTarget
          ? el('button', {
              class: 'pbtn success',
              disabled: true,
              title: '应用查询结果中的数据修改（Ctrl+S）',
              onClick: () => { if (editor) void saveResultEditor(editor); },
            }, iconEl('save'), '保存修改 (Ctrl+S)')
          : null;
        if (editTarget) {
          editor = {
            grid,
            connId: queryConnId,
            target: editTarget,
            saveButton,
            saving: false,
          };
          resultEditors.push(editor);
        }
        const bar = el('div', { class: 'pane-info' },
          el('span', {}, `${formatQueryRowCount(r)} · ${r.ms} ms` + (r.truncated ? `（仅显示前 ${r.rows.length} 行）` : '')),
          editTarget
            ? el('span', {
                title: `可编辑：${editTarget.schema ? editTarget.schema + '.' : ''}${editTarget.table}；Ctrl+S 应用修改`,
                style: { color: 'var(--green)' },
              }, '可编辑')
            : el('span', {
                title: r.editReadonlyReason || '该查询结果为只读',
                style: { color: 'var(--text-muted)' },
              }, '只读'),
          el('span', { class: 'spring' }),
          saveButton,
          el('button', { class: 'pbtn', onClick: async (ev) => {
            const { showRowsExportMenu } = await import('./exportMenu.js');
            showRowsExportMenu(ev.clientX, ev.clientY, {
              connId: queryConnId, columns: r.columns, rows: r.rows, defaultName: 'result',
            });
          } }, iconEl('exportIcon'), '导出…'));
        const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } }, host, bar);
        addResultPage(`结果 ${n}`, wrap, false);
      }
      // 默认激活第一个结果集（若有）
      activatePage(n ? 1 : 0);
      const okCount = results.filter((r) => !r.error).length;
      statusbar.setLeft(hasError ? '执行出错' : `执行完成（${okCount} 条语句）`);
      statusbar.setRight(`${totalMs} ms`);
      refreshHintTables();
      emit('history-changed');
    } catch (e) {
      clearResults();
      addResultPage('信息 ✗', el('div', { class: 'msg-list' }, el('div', { class: 'msg-item error' }, e.message)), true);
      activatePage(0);
      statusbar.setLeft('执行失败');
      emit('history-changed');
    } finally {
      if (activeRequest && activeRequest.requestId === requestId) activeRequest = null;
      running = false;
      btnRun.disabled = dbUnavailable;
      btnRunSel.disabled = dbUnavailable;
      btnRunAll.disabled = dbUnavailable;
      btnStop.disabled = true;
      await refreshTransactionSupport(true);
      syncTransactionUi();
    }
  }

  async function openFile() {
    const p = await window.api.dlg.openEditableSqlFile();
    if (!p) return;
    const text = await window.api.file.read(p);
    cm.setValue(text);
    savedPath = p;
    savedQuery = null;
    savedText = text;
    syncTabDirty();
    tab.setTitle(p.split(/[\\/]/).pop());
    touchRecovery();
  }

  /** 保存：文件绑定的写回文件；否则保存为连接下的查询对象（树上「查询」节点） */
  async function saveQuery() {
    if (savedPath) {
      await window.api.file.write(savedPath, cm.getValue());
      savedText = cm.getValue();
      syncTabDirty();
      toast.success('已保存 ' + savedPath);
      touchRecovery();
      return;
    }
    if (!connId) { toast.info('请先选择连接'); return; }
    let name = savedQuery && savedQuery.name;
    if (!savedQuery) {
      name = await promptDialog('保存查询', '查询名:', '');
      if (!name) return;
    }
    try {
      const rec = await window.api.queries.save({
        id: savedQuery ? savedQuery.id : undefined,
        connId, name, sql: cm.getValue(),
      });
      savedQuery = { id: rec.id, name: rec.name };
      savedText = cm.getValue();
      syncTabDirty();
      tab.setTitle(rec.name);
      emit('queries-changed', { connId });
      toast.success(`查询 “${rec.name}” 已保存到连接`);
      touchRecovery();
    } catch (e) {
      toast.error('保存失败: ' + e.message);
    }
  }

  async function saveAsFile() {
    const p = await window.api.dlg.saveFile({ title: '另存为 SQL 文件', defaultPath: (savedQuery ? savedQuery.name : 'query') + '.sql', filters: [{ name: 'SQL 文件', extensions: ['sql'] }] });
    if (!p) return;
    await window.api.file.write(p, cm.getValue());
    savedPath = p;
    savedQuery = null;
    savedText = cm.getValue();
    syncTabDirty();
    tab.setTitle(p.split(/[\\/]/).pop());
    toast.success('已保存 ' + p);
    touchRecovery();
  }

  // 未保存 SQL 仍走通用关闭确认；活动事务使用下方的提交/回滚三选一，
  // 避免连续弹出两个含义不同的“确定关闭”对话框。
  // SQL 草稿继续使用通用关闭确认；结果集修改由 beforeClose 提供
  // “应用 / 放弃 / 取消”三选一，避免连续出现两个含义重叠的弹窗。
  tab.setIsDirty(() => cm.getValue() !== savedText);
  tab.setOnShow(() => {
    fillConnSel();
    fillDbSel();
    void fillSchemaSel().then(() => {
      syncActiveContext();
      loadHintColumns();
      syncTransactionUi();
    });
    syncActiveContext();
    updateSchemaBadge();
    refreshTransactionSupport();
    setTimeout(() => {
      if (!splitterHeight) {
        const measured = Math.round(editorHost.getBoundingClientRect().height);
        if (measured >= 60) splitterHeight = measured;
      }
      cm.refresh();
    }, 10);
    statusbar.setLeft(connId
      ? `${connLabel(connId)}${db ? ' › ' + db : ''}${schema ? ' › ' + schema : ''}${dbUnavailable ? '（数据库不可用）' : ''}`
      : '');
  });
  function chooseTransactionEndAction(purpose) {
    const closing = purpose === '关闭查询';
    const suffix = closing ? '并关闭' : '后继续';
    return new Promise((resolve) => {
      let done = false;
      const finish = (choice) => {
        done = true;
        resolve(choice);
      };
      openModal({
        title: '当前查询存在未结束事务',
        body: el('div', { class: 'confirm-body' },
          el('div', {}, transactionState === 'failed'
            ? `事务已经发生错误，必须回滚后才能${purpose}。`
            : `${purpose}前，请选择提交或回滚当前事务。`)),
        buttons: [
          { label: '取消', onClick: () => finish(null) },
          { label: `回滚${suffix}`, danger: true, onClick: () => finish('rollback') },
          transactionState === 'active'
            ? { label: `提交${suffix}`, primary: true, onClick: () => finish('commit') }
            : null,
        ].filter(Boolean),
        onClose: () => { if (!done) resolve(null); },
      });
    });
  }

  async function saveResultEditor(editor) {
    if (!editor || editor.saving) return false;
    editor.grid.commitEditor();
    const edits = editor.grid.getPendingEdits();
    if (!edits.length) {
      if (editor.saveButton) editor.saveButton.disabled = true;
      syncTabDirty();
      return true;
    }
    editor.saving = true;
    if (editor.saveButton) editor.saveButton.disabled = true;
    try {
      const payload = {
        connId: editor.connId,
        db: editor.target.db,
        schema: editor.target.schema,
        table: editor.target.table,
        edits,
        transactionId,
      };
      const { authorizeOperation } = await import('./danger.js');
      const approved = await authorizeOperation('db.applyEdits', payload);
      if (!approved) return false;
      const result = await window.api.db.applyEdits(editor.connId, approved);
      editor.grid.acceptChanges();
      if (result && result.pendingTransaction) {
        toast.success(`已应用 ${result.count} 处修改，等待提交当前事务`);
      } else {
        toast.success(`已保存 ${result.count} 处数据修改`);
      }
      return true;
    } catch (e) {
      toast.error('保存查询结果修改失败：' + e.message, 12000);
      return false;
    } finally {
      editor.saving = false;
      if (editor.saveButton) editor.saveButton.disabled = !editor.grid.isDirty();
      await refreshTransactionSupport(true);
      syncTabDirty();
    }
  }

  function chooseResultEditAction(purpose, count) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (choice) => { done = true; resolve(choice); };
      openModal({
        title: '查询结果存在未保存修改',
        body: el('div', { class: 'confirm-body' },
          el('div', {}, `${purpose}前，${count} 个结果集存在待应用的数据修改。`)),
        buttons: [
          { label: '取消', onClick: () => finish(null) },
          { label: '放弃修改', danger: true, onClick: () => finish('discard') },
          { label: '应用后继续', primary: true, onClick: () => finish('apply') },
        ],
        onClose: () => { if (!done) resolve(null); },
      });
    });
  }

  async function finishResultEditsBefore(purpose) {
    const dirty = resultEditors.filter((editor) => editor.grid.isDirty());
    if (!dirty.length) return true;
    const action = await chooseResultEditAction(purpose, dirty.length);
    if (!action) return false;
    if (action === 'discard') return true;
    for (const editor of dirty) {
      if (!(await saveResultEditor(editor))) return false;
    }
    return true;
  }

  async function finishTransactionBefore(purpose) {
    if (['starting', 'committing', 'rolling-back'].includes(transactionState)) {
      toast.info('事务状态正在切换，请稍候再操作');
      return false;
    }
    if (!['active', 'failed'].includes(transactionState) || !connId) return true;
    if (!state.open.has(connId)) {
      transactionState = 'idle';
      syncTransactionUi();
      return true;
    }
    const action = await chooseTransactionEndAction(purpose);
    if (!action) return false;
    const request = activeRequest;
    if (request) await window.api.db.cancel(request.connId, request.requestId).catch(() => {});
    transactionState = action === 'commit' ? 'committing' : 'rolling-back';
    syncTransactionUi();
    try {
      if (action === 'commit') await window.api.db.commitTransaction(connId, transactionId);
      else await window.api.db.rollbackTransaction(connId, transactionId);
      transactionState = 'idle';
      syncTransactionUi();
      return true;
    } catch (e) {
      await refreshTransactionSupport(true);
      toast.error(`${purpose}前${action === 'commit' ? '提交' : '回滚'}事务失败: ${e.message}`);
      return false;
    }
  }

  if (tab.setBeforeClose) {
    tab.setBeforeClose(async () => {
      if (!(await finishResultEditsBefore('关闭查询'))) return false;
      return finishTransactionBefore('关闭查询');
    });
  }
  tab.setOnClose(() => {
    const request = activeRequest;
    if (request) window.api.db.cancel(request.connId, request.requestId).catch(() => {});
    if (transactionState !== 'idle' && connId) {
      window.api.db.rollbackTransaction(connId, transactionId).catch(() => {});
      transactionState = 'idle';
    }
  });
  if (tab.setRecovery) {
    tab.setRecovery('query', () => ({
      target: connId ? { connId, ...(db ? { db } : {}), ...(schema ? { schema } : {}) } : null,
      sql: cm.getValue(),
      savedQuery: savedQuery ? { ...savedQuery } : null,
      savedPath,
      savedText,
      maxRows: Number(maxRowsSel.value),
      splitterHeight: Math.round(splitterHeight || 240),
      title: savedQuery ? savedQuery.name : (savedPath ? savedPath.split(/[\\/]/).pop() : initialTitle),
    }));
  }

  // 上下分隔条拖拽
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorHost.getBoundingClientRect().height;
    const move = (ev) => {
      const h = Math.max(60, startH + ev.clientY - startY);
      splitterHeight = h;
      editorHost.style.flex = `0 0 ${h}px`;
      cm.refresh();
      touchRecovery();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  fillConnSel();
  fillDbSel();
  void fillSchemaSel().then(() => {
    syncActiveContext();
    loadHintColumns();
    syncTransactionUi();
  });
  syncActiveContext();
  loadHintColumns();
  refreshTransactionSupport();
  syncTransactionUi();
  addResultPage('信息', el('div', { class: 'msg-list' }, 'Ctrl+R / F5 / Ctrl+Enter：有选区运行选区，否则运行光标所在语句；Ctrl+Shift+R 运行选中；简单单表查询包含完整主键时可直接编辑结果，Ctrl+S 应用修改。默认自动提交，可点击“开始事务”或直接执行 BEGIN / COMMIT / ROLLBACK。'), false);
  activatePage(0);
  setTimeout(() => cm.focus(), 50);

  // 暴露给自动化测试
  tab._run = run;
  tab._cm = cm;
  tab._triggerHint = triggerHint;
  tab._loadHints = loadHintColumns;
  return tab;
}
