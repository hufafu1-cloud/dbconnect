// AI 助手面板：对话式 SQL 优化 / 分析 / 自然语言生成 SQL（流式输出）
import { el, iconEl, escapeHtml } from './util.js';
import { state, connLabel, connById } from './state.js';
import { addTab } from './tabs.js';
import { toast } from './toast.js';
import { openAiConfigDialog } from './aiConfigDialog.js';

const DIALECT_NAME = {
  mysql: 'MySQL', postgres: 'PostgreSQL', mssql: 'SQL Server', sqlite: 'SQLite',
  clickhouse: 'ClickHouse', oceanbase: 'OceanBase（MySQL 兼容）', oboracle: 'OceanBase（Oracle 兼容）',
};

let reqSeq = 0;
let panel = null; // 单例

export function openAiPanel(ctx = {}) {
  if (!panel) panel = createPanel();
  panel.handle.activate();
  if (ctx.insertTarget) panel.setInsertTarget(ctx.insertTarget);
  if (ctx.connId) panel.setContext(ctx.connId, ctx.db);
  if (ctx.sql != null) panel.setInput(ctx.sql);
  if (ctx.action) panel.runAction(ctx.action);
  setTimeout(() => panel.focusInput(), 60);
  return panel;
}

function createPanel() {
  const tab = addTab({ id: 'ai-panel', title: 'AI 助手', icon: 'ai' });
  const pane = tab.pane;
  pane.classList.add('ai-pane');

  let connId = null;
  let db = null;
  let insertTarget = null; // (sql) => void
  let busy = false;
  let curReqId = null;
  let unsubDelta = null;
  const history = []; // [{role, content}] 不含 system

  // ---- 顶部栏：连接/库选择 + 模型徽标 + 设置/清空 ----
  const connSel = el('select', { title: '连接（用于读取表结构做上下文）' });
  const dbSel = el('select', { title: '数据库' });
  const modelBadge = el('span', { class: 'ai-model-badge', title: '当前模型' }, '未配置');

  function fillConnSel() {
    connSel.innerHTML = '';
    const opens = [...state.open.keys()];
    if (!opens.length) connSel.append(el('option', { value: '' }, '(无打开的连接)'));
    for (const id of opens) connSel.append(el('option', { value: id, selected: id === connId ? 'selected' : null }, connLabel(id)));
    if (!opens.includes(connId)) connId = opens[0] || null;
    if (connId) connSel.value = connId;
  }
  function fillDbSel() {
    dbSel.innerHTML = '';
    const oc = connId && state.open.get(connId);
    const dbs = (oc && oc.databases) || [];
    if (!dbs.length) dbSel.append(el('option', { value: '' }, '(无)'));
    for (const d of dbs) dbSel.append(el('option', { value: d, selected: d === db ? 'selected' : null }, d));
    if (!dbs.includes(db)) db = dbs[0] || null;
    if (db) dbSel.value = db;
  }
  connSel.addEventListener('change', () => { connId = connSel.value || null; fillDbSel(); });
  dbSel.addEventListener('change', () => { db = dbSel.value || null; });

  async function refreshModelBadge() {
    try {
      const cfg = await window.api.ai.getConfig();
      modelBadge.textContent = cfg.hasApiKey ? (cfg.model || '已配置') : '未配置 ▸ 点此设置';
      modelBadge.classList.toggle('unset', !cfg.hasApiKey);
    } catch (e) { modelBadge.textContent = '未配置'; }
  }
  modelBadge.addEventListener('click', () => openAiConfigDialog(() => refreshModelBadge()));

  const topbar = el('div', { class: 'pane-toolbar ai-topbar' },
    iconEl('ai'),
    el('span', { class: 'ai-title' }, 'AI 助手'),
    el('span', { class: 'sep' }),
    el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '连接:'), connSel,
    el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '库:'), dbSel,
    el('span', { class: 'spring' }),
    modelBadge,
    el('button', { class: 'pbtn', title: 'AI 助手设置', onClick: () => openAiConfigDialog(() => refreshModelBadge()) }, iconEl('theme'), '设置'),
    el('button', { class: 'pbtn', title: '清空对话', onClick: clearChat }, iconEl('trash'), '清空'),
  );

  // ---- 对话区 ----
  const transcript = el('div', { class: 'ai-transcript' });

  // ---- 快捷动作 ----
  const chip = (label, action, title) => el('button', { class: 'ai-chip', title: title || label, onClick: () => runAction(action) }, label);
  const chips = el('div', { class: 'ai-chips' },
    chip('🛠 优化 SQL', 'optimize', '优化输入框中的 SQL 并说明理由'),
    chip('🔍 解释 SQL', 'explain', '解释输入框中 SQL 的作用与逻辑'),
    chip('🐞 排查问题', 'diagnose', '分析 SQL 的报错或性能问题并修正'),
    chip('✨ 生成 SQL', 'generate', '根据自然语言需求生成 SQL（带表结构上下文）'),
  );

  // ---- 输入区 ----
  const input = el('textarea', { class: 'ai-input', rows: 3, placeholder: '输入 SQL 或自然语言需求…  Enter 发送，Shift+Enter 换行；或点上方按钮' });
  const btnSend = el('button', { class: 'pbtn success', onClick: () => onSend() }, iconEl('run'), '发送');
  const btnStop = el('button', { class: 'pbtn', onClick: stopGen }, iconEl('stop'), '停止');
  btnStop.style.display = 'none';
  const inputRow = el('div', { class: 'ai-input-row' }, input, el('div', { class: 'ai-input-btns' }, btnSend, btnStop));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  });

  pane.append(topbar, transcript, chips, inputRow);

  // ---- 欢迎语 ----
  function showWelcome() {
    transcript.innerHTML = '';
    transcript.append(el('div', { class: 'ai-welcome' },
      el('div', { class: 'ai-welcome-icon' }, iconEl('ai')),
      el('div', { class: 'ai-welcome-title' }, 'AI 助手'),
      el('div', { class: 'ai-welcome-sub' }, '对接 DeepSeek 等大模型，帮你优化 / 解释 / 排查 / 生成 SQL'),
      el('ul', { class: 'ai-welcome-list' },
        el('li', {}, '把 SQL 粘到下方输入框，点「优化 / 解释 / 排查」'),
        el('li', {}, '用大白话描述需求，点「生成 SQL」（自动带上当前库的表结构）'),
        el('li', {}, '生成的 SQL 可一键「插入到查询」执行'),
      ),
    ));
  }

  // ---- 消息渲染 ----
  function addBubble(role, displayText) {
    const isUser = role === 'user';
    const body = el('div', { class: 'ai-bubble-body' });
    if (displayText != null) renderMarkdown(body, displayText);
    const bubble = el('div', { class: 'ai-bubble ' + (isUser ? 'user' : 'assistant') },
      el('div', { class: 'ai-avatar' }, isUser ? '我' : 'AI'),
      el('div', { class: 'ai-bubble-main' }, body));
    transcript.append(bubble);
    transcript.scrollTop = transcript.scrollHeight;
    return body;
  }

  function clearChat() {
    if (busy) stopGen();
    history.length = 0;
    showWelcome();
  }

  // ---- 表结构上下文 ----
  async function schemaContext(limitChars) {
    if (!connId || !db || !state.open.has(connId)) return '';
    try {
      const cols = await window.api.db.allColumns(connId, db);
      const lines = [];
      let used = 0;
      const cap = limitChars || 6000;
      for (const [t, list] of Object.entries(cols)) {
        const names = (list || []).map((c) => (typeof c === 'string' ? c : (c && (c.name || c.COLUMN_NAME)) || String(c)));
        const line = `${t}(${names.join(', ')})`;
        if (used + line.length > cap) { lines.push(`… 其余表略（共 ${Object.keys(cols).length} 张表）`); break; }
        lines.push(line); used += line.length + 1;
      }
      return lines.length ? `数据库 ${db} 的表结构：\n${lines.join('\n')}` : '';
    } catch (e) { return ''; }
  }

  function dialect() {
    const c = connById(connId);
    return (c && DIALECT_NAME[c.type]) || 'SQL';
  }

  function systemPrompt() {
    return `你是 Datavia 数据库客户端内置的 AI 助手，精通 SQL 与数据库性能优化。当前数据库类型：${dialect()}。\n`
      + '回答要求：\n'
      + '1. 用简体中文，简洁、专业、可执行。\n'
      + `2. 输出 SQL 时务必放进 \`\`\`sql 代码块，并贴合 ${dialect()} 方言。\n`
      + '3. 优化类问题要点明优化理由（索引、避免全表扫描、SARGable 条件、JOIN 顺序、分页方式等）。\n'
      + '4. 不要编造不存在的表或字段；信息不足时先说明假设。';
  }

  // ---- 发送 ----
  function setBusy(b) {
    busy = b;
    btnSend.style.display = b ? 'none' : '';
    btnStop.style.display = b ? '' : 'none';
    input.disabled = b;
    chips.querySelectorAll('.ai-chip').forEach((c) => { c.disabled = b; });
  }

  async function send(sendContent, displayText) {
    if (busy) return;
    const cfg = await window.api.ai.getConfig().catch(() => null);
    if (!cfg || !cfg.hasApiKey) {
      toast.info('请先配置 AI（API Key）');
      openAiConfigDialog(() => refreshModelBadge());
      return;
    }
    if (history.length === 0 && transcript.querySelector('.ai-welcome')) transcript.innerHTML = '';
    addBubble('user', displayText != null ? displayText : sendContent);
    history.push({ role: 'user', content: sendContent });

    const answerBody = addBubble('assistant', null);
    answerBody.append(el('span', { class: 'ai-typing' }, '思考中…'));

    const messages = [{ role: 'system', content: systemPrompt() }, ...history];
    const reqId = `ai-${++reqSeq}`;
    curReqId = reqId;
    setBusy(true);

    let acc = '';
    let raf = 0;
    const flush = () => { raf = 0; renderMarkdown(answerBody, acc, { onInsert: doInsert }); transcript.scrollTop = transcript.scrollHeight; };
    if (unsubDelta) unsubDelta();
    unsubDelta = window.api.ai.onDelta((p) => {
      if (p.reqId !== reqId) return;
      acc += p.delta;
      if (!raf) raf = requestAnimationFrame(flush);
    });

    try {
      const res = await window.api.ai.chat(reqId, messages);
      acc = (res && res.content) || acc;
      if (raf) cancelAnimationFrame(raf);
      renderMarkdown(answerBody, acc || '（无内容）', { onInsert: doInsert });
      history.push({ role: 'assistant', content: acc });
    } catch (e) {
      if (raf) cancelAnimationFrame(raf);
      if (acc) { renderMarkdown(answerBody, acc, { onInsert: doInsert }); history.push({ role: 'assistant', content: acc }); }
      else { answerBody.innerHTML = ''; answerBody.append(el('div', { class: 'ai-error' }, '✖ ' + e.message)); history.pop(); }
    } finally {
      if (unsubDelta) { unsubDelta(); unsubDelta = null; }
      curReqId = null;
      setBusy(false);
      transcript.scrollTop = transcript.scrollHeight;
    }
  }

  function stopGen() {
    if (curReqId) window.api.ai.cancel(curReqId).catch(() => {});
  }

  function onSend() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    send(text);
  }

  // ---- 快捷动作 ----
  async function runAction(action) {
    const text = input.value.trim();
    if (action === 'generate') {
      if (!text) { toast.info('请先在输入框描述你的需求'); input.focus(); return; }
      const schema = await schemaContext();
      const content = `请根据下面的需求生成 SQL：\n${text}\n\n${schema || '（无可用表结构，请按通用规范生成）'}`;
      input.value = '';
      send(content, `✨ 生成 SQL：${text}`);
      return;
    }
    // optimize / explain / diagnose 针对 SQL
    const sql = text;
    if (!sql) { toast.info('请先在输入框粘贴 SQL'); input.focus(); return; }
    let content; let display;
    if (action === 'optimize') {
      const schema = await schemaContext(3000);
      content = `请优化下面这条 ${dialect()} SQL，给出优化后的语句并逐条说明优化理由：\n\`\`\`sql\n${sql}\n\`\`\`` + (schema ? `\n\n相关${schema}` : '');
      display = `🛠 优化 SQL：\n\`\`\`sql\n${sql}\n\`\`\``;
    } else if (action === 'explain') {
      content = `请解释下面这条 ${dialect()} SQL 的作用、执行逻辑与潜在影响：\n\`\`\`sql\n${sql}\n\`\`\``;
      display = `🔍 解释 SQL：\n\`\`\`sql\n${sql}\n\`\`\``;
    } else { // diagnose
      const schema = await schemaContext(3000);
      content = `下面这条 ${dialect()} SQL 可能存在报错或性能问题，请分析原因并给出修正后的 SQL：\n\`\`\`sql\n${sql}\n\`\`\`` + (schema ? `\n\n相关${schema}` : '');
      display = `🐞 排查问题：\n\`\`\`sql\n${sql}\n\`\`\``;
    }
    input.value = '';
    send(content, display);
  }

  // ---- 插入 SQL 到查询编辑器 ----
  async function doInsert(sql) {
    if (insertTarget) { insertTarget(sql); toast.success('已插入到编辑器'); return; }
    const { openQueryTab } = await import('./queryTab.js');
    openQueryTab({ connId, db }, sql);
  }

  tab.setOnShow(() => { fillConnSel(); fillDbSel(); refreshModelBadge(); });
  tab.setOnClose(() => { if (unsubDelta) unsubDelta(); panel = null; });

  fillConnSel();
  fillDbSel();
  refreshModelBadge();
  showWelcome();

  return {
    handle: tab,
    setContext(cid, d) { connId = cid; if (d) db = d; fillConnSel(); fillDbSel(); },
    setInsertTarget(fn) { insertTarget = fn; },
    setInput(t) { input.value = t; },
    runAction,
    focusInput: () => input.focus(),
    _send: send,
  };
}

/** 轻量 Markdown 渲染：代码块（含复制/插入）+ 粗体 + 行内代码 + 换行 */
function renderMarkdown(container, text, opts = {}) {
  container.innerHTML = '';
  for (const seg of parseSegments(text)) {
    if (seg.type === 'code') {
      const isSql = !seg.lang || /^(sql|mysql|postgres|postgresql|plsql|tsql)$/i.test(seg.lang);
      const head = el('div', { class: 'ai-code-head' },
        el('span', { class: 'ai-code-lang' }, seg.lang || (isSql ? 'sql' : 'code')),
        el('span', { class: 'spring' }),
        el('button', { class: 'ai-code-btn', onClick: () => { navigator.clipboard.writeText(seg.text); toast.success('已复制'); } }, '复制'),
        isSql && opts.onInsert ? el('button', { class: 'ai-code-btn primary', onClick: () => opts.onInsert(seg.text) }, '插入到查询') : null,
      );
      const pre = el('pre', { class: 'ai-code' }, el('code', {}, seg.text));
      container.append(el('div', { class: 'ai-code-block' }, head, pre));
    } else {
      const txt = seg.text.replace(/\n{3,}/g, '\n\n').trim();
      if (txt) container.append(el('div', { class: 'ai-text', html: inlineMd(txt) }));
    }
  }
}

function inlineMd(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code class="ai-inline">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/^\s*[-*]\s+(.*)$/gm, '• $1');
  s = s.replace(/\n/g, '<br>');
  return s;
}

function parseSegments(text) {
  const lines = String(text).split('\n');
  const segs = [];
  let mode = 'text';
  let buf = [];
  let lang = '';
  const flush = () => { if (buf.length || mode === 'code') segs.push({ type: mode === 'code' ? 'code' : 'text', lang, text: buf.join('\n') }); buf = []; };
  for (const ln of lines) {
    const m = /^```([\w-]*)\s*$/.exec(ln.trim());
    if (m) {
      if (mode === 'text') { flush(); mode = 'code'; lang = (m[1] || '').toLowerCase(); }
      else { flush(); mode = 'text'; lang = ''; }
      continue;
    }
    buf.push(ln);
  }
  flush();
  return segs.filter((s) => s.type === 'code' || s.text.trim());
}
