// 查询标签页：CodeMirror SQL 编辑器 + 多结果集 + 信息面板
import { el, iconEl, fmtCount } from './util.js';
import { state, connLabel, connColor, objectsCacheKey, emit } from './state.js';
import { addTab, uid } from './tabs.js';
import { DataGrid } from './grid.js';
import { toast, promptDialog } from './toast.js';
import { statusbar } from './statusbar.js';

const CM_MODES = { mysql: 'text/x-mysql', postgres: 'text/x-pgsql', mssql: 'text/x-mssql', sqlite: 'text/x-sqlite', clickhouse: 'text/x-mysql', oceanbase: 'text/x-mysql', oboracle: 'text/x-plsql' };
let queryNo = 0;

const SQL_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'INSERT INTO', 'UPDATE', 'DELETE FROM', 'SET', 'VALUES', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN',
  'JOIN', 'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'IS NOT NULL', 'IN', 'LIKE', 'BETWEEN',
  'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC',
  'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE', 'UNION', 'UNION ALL', 'EXISTS'];
const ID_CHARS = "[\\w$\\u4e00-\\u9fa5]";

export function openQueryTab(target, initialSql, opts) {
  queryNo++;
  const tabId = uid('query');
  let savedQuery = (opts && opts.saved) || null; // {id, name} 绑定到连接的查询
  const tab = addTab({ id: tabId, title: savedQuery ? savedQuery.name : `查询 ${queryNo}`, icon: 'query', color: connColor(target && target.connId) });

  let connId = target && target.connId;
  let db = target && target.db;
  let savedPath = null;
  let savedText = initialSql || '';
  let running = false;

  const pane = tab.pane;
  pane.classList.add('query-pane');

  // ---- 连接 / 数据库选择 ----
  const connSel = el('select', { title: '连接' });
  const dbSel = el('select', { title: '数据库' });
  function fillConnSel() {
    connSel.innerHTML = '';
    const opens = [...state.open.keys()];
    if (!opens.length) connSel.append(el('option', { value: '' }, '(无打开的连接)'));
    for (const id of opens) {
      connSel.append(el('option', { value: id, selected: id === connId ? 'selected' : null }, connLabel(id)));
    }
    if (!opens.includes(connId)) connId = opens[0] || null;
    if (connId) connSel.value = connId;
  }
  function fillDbSel() {
    dbSel.innerHTML = '';
    const oc = connId && state.open.get(connId);
    const dbs = (oc && oc.databases) || [];
    for (const d of dbs) dbSel.append(el('option', { value: d, selected: d === db ? 'selected' : null }, d));
    if (!dbs.includes(db)) db = dbs[0] || null;
    if (db) dbSel.value = db;
  }
  connSel.addEventListener('change', () => { connId = connSel.value || null; fillDbSel(); loadHintColumns(); });
  dbSel.addEventListener('change', () => { db = dbSel.value || null; loadHintColumns(); });

  const maxRowsSel = el('select', { title: '结果行数上限' },
    el('option', { value: '200' }, '200 行'),
    el('option', { value: '2000', selected: 'selected' }, '2000 行'),
    el('option', { value: '10000' }, '10000 行'));

  const mkBtn = (icon, label, onClick, cls) =>
    el('button', { class: 'pbtn' + (cls ? ' ' + cls : ''), onClick }, iconEl(icon), label);

  const btnRun = mkBtn('run', '运行 (F5)', () => run(false), 'success');
  const btnRunSel = mkBtn('runSel', '运行选中', () => run(true));
  const btnStop = mkBtn('stop', '停止', async () => {
    try {
      await window.api.db.cancel(connId);
      toast.info('已发送取消请求');
    } catch (e) {
      toast.error(e.message);
    }
  });
  btnStop.disabled = true;

  const toolbar = el('div', { class: 'pane-toolbar' },
    btnRun, btnRunSel, btnStop,
    el('span', { class: 'sep' }),
    el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '连接:'), connSel,
    el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '数据库:'), dbSel,
    el('span', { class: 'sep' }),
    mkBtn('explain', '解释', explainSql),
    mkBtn('format', '美化', formatSql),
    mkBtn('openFile', '打开', openFile),
    mkBtn('save', '保存', () => saveQuery()),
    mkBtn('exportIcon', '另存文件', () => saveAsFile()),
    el('span', { class: 'sep' }),
    maxRowsSel,
    el('span', { class: 'spring' }),
  );

  async function explainSql() {
    if (!connId || !state.open.has(connId)) { toast.info('请先打开一个连接'); return; }
    let sql = cm.getSelection() || cm.getValue();
    sql = sql.trim().replace(/;\s*$/, '');
    if (!sql) { toast.info('没有可解释的 SQL'); return; }
    const { openExplainTab } = await import('./explainTab.js');
    openExplainTab({ connId, db }, sql);
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
  const editorHost = el('div', { class: 'query-editor' });
  // ---- 结果区 ----
  const splitter = el('div', { class: 'splitter-h' });
  const resultsHost = el('div', { class: 'query-results' });
  const rtabs = el('div', { class: 'result-tabs' });
  const rbody = el('div', { class: 'result-body' });
  resultsHost.append(rtabs, rbody);

  pane.append(toolbar, editorHost, splitter, resultsHost);

  const cm = CodeMirror(editorHost, {
    value: initialSql || '',
    mode: CM_MODES[connId && connTypeOf(connId)] || 'text/x-sql',
    lineNumbers: true,
    indentWithTabs: false,
    indentUnit: 2,
    tabSize: 2,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    extraKeys: {
      'F5': () => run(false),
      'Ctrl-Enter': () => run(false),
      'Ctrl-Space': () => triggerHint(),
      'Ctrl-S': () => saveQuery(),
      'Shift-Ctrl-F': () => formatSql(),
    },
    hintOptions: { completeSingle: false },
  });
  cm.on('change', () => tab.setDirty(cm.getValue() !== savedText));
  setTimeout(() => cm.refresh(), 30);

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
    const key = `${db}|${(target && target.schema) || ''}`;
    if (!oc.columnsCache.has(key)) {
      try {
        oc.columnsCache.set(key, await window.api.db.allColumns(connId, db, target && target.schema));
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
    return { tableCols, dbTables, tableList: [...tableSet].sort((a, b) => a.localeCompare(b)) };
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
  function clearResults() {
    rtabs.innerHTML = '';
    rbody.innerHTML = '';
    pages = [];
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
          el('b', {}, `${fmtCount(r.rowCount)} 行`),
          ` · ${r.ms} ms` + (r.truncated ? ' · 仅显示前面部分' : '')));
      } else {
        const note = r.message && r.message.includes('不返回影响行数');
        list.append(el('div', { class: 'msg-item' },
          el('span', { class: 'msg-sql' }, r.sql + '  →  '),
          el('b', {}, note ? '执行成功' : `影响 ${fmtCount(r.affected)} 行`),
          (r.insertId ? ` · 新ID ${r.insertId}` : '') + ` · ${r.ms} ms`));
      }
    }
    if (!results.length) list.append(el('div', { class: 'msg-item' }, '（没有要执行的语句）'));
    list.append(el('div', { style: { color: 'var(--text-muted)', marginTop: '6px' } }, `总耗时 ${totalMs} ms`));
    return list;
  }

  async function run(selectionOnly) {
    if (running) return;
    if (!connId || !state.open.has(connId)) { toast.info('请先打开一个连接'); return; }
    let sql = selectionOnly ? cm.getSelection() : cm.getValue();
    if (selectionOnly && !sql.trim()) sql = cm.getValue();
    if (!sql.trim()) { toast.info('没有可执行的 SQL'); return; }
    running = true;
    btnRun.disabled = true;
    btnRunSel.disabled = true;
    btnStop.disabled = false;
    statusbar.setLeft('正在执行查询…');
    clearResults();
    const waiting = addResultPage('信息', el('div', { class: 'msg-list' }, '执行中…'), false);
    activatePage(waiting);
    const t0 = Date.now();
    try {
      const results = await window.api.db.query(connId, {
        db, sql, maxRows: Number(maxRowsSel.value),
      });
      const totalMs = Date.now() - t0;
      clearResults();
      const hasError = results.some((r) => r.error);
      addResultPage(hasError ? '信息 ✗' : '信息', renderMessages(results, totalMs), hasError);
      let n = 0;
      for (const r of results) {
        if (!r.columns) continue;
        n++;
        const host = el('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
        const grid = new DataGrid(host, {
          editable: false,
          copyContext: { table: 'result_table', connType: connTypeOf(connId) },
        });
        grid.setData({ columns: r.columns, rows: r.rows, pk: [] });
        const bar = el('div', { class: 'pane-info' },
          el('span', {}, `${fmtCount(r.rowCount)} 行 · ${r.ms} ms` + (r.truncated ? `（仅显示前 ${r.rows.length} 行）` : '')),
          el('span', { class: 'spring' }),
          el('button', { class: 'pbtn', onClick: async (ev) => {
            const { showRowsExportMenu } = await import('./exportMenu.js');
            showRowsExportMenu(ev.clientX, ev.clientY, {
              connId, columns: r.columns, rows: r.rows, defaultName: 'result',
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
      running = false;
      btnRun.disabled = false;
      btnRunSel.disabled = false;
      btnStop.disabled = true;
    }
  }

  async function openFile() {
    const p = await window.api.dlg.openFile({ title: '打开 SQL 文件', filters: [{ name: 'SQL 文件', extensions: ['sql', 'txt'] }] });
    if (!p) return;
    const text = await window.api.file.read(p);
    cm.setValue(text);
    savedPath = p;
    savedQuery = null;
    savedText = text;
    tab.setDirty(false);
    tab.setTitle(p.split(/[\\/]/).pop());
  }

  /** 保存：文件绑定的写回文件；否则保存为连接下的查询对象（树上「查询」节点） */
  async function saveQuery() {
    if (savedPath) {
      await window.api.file.write(savedPath, cm.getValue());
      savedText = cm.getValue();
      tab.setDirty(false);
      toast.success('已保存 ' + savedPath);
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
      tab.setDirty(false);
      tab.setTitle(rec.name);
      emit('queries-changed', { connId });
      toast.success(`查询 “${rec.name}” 已保存到连接`);
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
    tab.setDirty(false);
    tab.setTitle(p.split(/[\\/]/).pop());
    toast.success('已保存 ' + p);
  }

  tab.setIsDirty(() => cm.getValue() !== savedText && cm.getValue().trim() !== '');
  tab.setOnShow(() => {
    fillConnSel();
    fillDbSel();
    setTimeout(() => cm.refresh(), 10);
    statusbar.setLeft(connId ? `${connLabel(connId)}${db ? ' › ' + db : ''}` : '');
  });

  // 上下分隔条拖拽
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorHost.getBoundingClientRect().height;
    const move = (ev) => {
      const h = Math.max(60, startH + ev.clientY - startY);
      editorHost.style.flex = `0 0 ${h}px`;
      cm.refresh();
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
  loadHintColumns();
  addResultPage('信息', el('div', { class: 'msg-list' }, '按 F5 或 Ctrl+Enter 运行；选中部分文本可只运行选中内容；Ctrl+Space 补全表/列名。'), false);
  activatePage(0);
  setTimeout(() => cm.focus(), 50);

  // 暴露给自动化测试
  tab._run = run;
  tab._cm = cm;
  tab._triggerHint = triggerHint;
  tab._loadHints = loadHintColumns;
  return tab;
}
