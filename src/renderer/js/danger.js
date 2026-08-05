// 危险 SQL 检测 + 生产库执行前二次确认（参考 SQLark 的链接类型/审批理念）
import { el, fmtCount } from './util.js';
import { openModal, toast } from './toast.js';
import { connById } from './state.js';
import { getSetting } from './settings.js';

// 把脚本拆成单条语句（识别字符串/反引号/行注释/块注释里的分号，不误切）
export function splitStatements(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  let q = null; // 当前所在引号: ' " `
  while (i < n) {
    const ch = sql[i];
    const nx = sql[i + 1];
    if (q) {
      cur += ch;
      if (ch === '\\' && q !== '`') { if (nx !== undefined) cur += nx; i += 2; continue; }
      if (ch === q) q = null;
      i++; continue;
    }
    if (ch === '-' && nx === '-') { while (i < n && sql[i] !== '\n') { cur += sql[i]; i++; } continue; }
    if (ch === '#') { while (i < n && sql[i] !== '\n') { cur += sql[i]; i++; } continue; }
    if (ch === '/' && nx === '*') { cur += '/*'; i += 2; while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { cur += sql[i]; i++; } cur += '*/'; i += 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; i++; continue; }
    if (ch === ';') { out.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// 去注释 + 清空字符串内容，便于按关键字判断
function normalize(stmt) {
  return stmt
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/(^|\s)#[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\s+/g, ' ')
    .trim();
}

// WHERE 子句是否“形同虚设”（缺失或恒真）
function lacksRealWhere(s) {
  const m = /\bwhere\b(.*)$/i.exec(s);
  if (!m) return true;
  const w = m[1].trim().replace(/;$/, '');
  return /^(1\s*=\s*1|true|'1'\s*=\s*'1')$/i.test(w);
}

/** 判定单条语句的危险级别，返回 {level, reason} 或 null */
export function classifyStatement(stmt) {
  const s = normalize(stmt);
  if (!s) return null;
  if (/^drop\s+(database|schema)\b/i.test(s)) return { level: 'high', reason: '删除数据库 / 模式（DROP DATABASE）' };
  if (/^drop\s+(table|view|index|trigger|function|procedure|sequence|event|user|role)\b/i.test(s)) return { level: 'high', reason: '删除对象（DROP）' };
  if (/^truncate\b/i.test(s)) return { level: 'high', reason: '清空表数据（TRUNCATE）' };
  if (/^delete\s+(from\b|[`"]|\w)/i.test(s)) {
    return lacksRealWhere(s) ? { level: 'high', reason: '整表删除：DELETE 缺少有效 WHERE 条件' } : null;
  }
  if (/^update\b/i.test(s)) {
    return lacksRealWhere(s) ? { level: 'high', reason: '全表更新：UPDATE 缺少有效 WHERE 条件' } : null;
  }
  if (/^alter\s+table\b/i.test(s)) {
    return /\bdrop\b/i.test(s) ? { level: 'high', reason: 'ALTER TABLE 删除列 / 约束' } : { level: 'medium', reason: '修改表结构（ALTER TABLE）' };
  }
  if (/^drop\s+/i.test(s)) return { level: 'high', reason: '删除对象（DROP）' };
  if (/^(grant|revoke)\b/i.test(s)) return { level: 'medium', reason: '权限变更（GRANT / REVOKE）' };
  if (/^rename\s+table\b/i.test(s) || /^alter\s+table\b.*\brename\b/i.test(s)) return { level: 'medium', reason: '重命名表（RENAME）' };
  if (/^replace\s+into\b/i.test(s)) return { level: 'medium', reason: '覆盖写入（REPLACE INTO 可能删除已有行）' };
  // 安全网：CTE 前缀的写操作（如 PostgreSQL 的 WITH ... DELETE/UPDATE）
  if (/^with\b/i.test(s) && /\b(delete|update|truncate|drop)\b/i.test(s)) return { level: 'medium', reason: 'CTE 中包含写操作，请确认影响范围' };
  return null;
}

/** 分析整段 SQL，返回危险语句清单 [{sql, reason, level}] */
export function analyzeDanger(sql) {
  const items = [];
  for (const stmt of splitStatements(String(sql || ''))) {
    const c = classifyStatement(stmt);
    if (c) items.push({ sql: stmt, reason: c.reason, level: c.level });
  }
  return items;
}

function snippet(sql) {
  const one = sql.replace(/\s+/g, ' ').trim();
  return one.length > 220 ? one.slice(0, 220) + ' …' : one;
}

/** 生产库危险操作 · 二次确认审批弹窗，需输入连接名确认。resolve(true/false) */
export function confirmDangerExecution(connName, items, ctx = {}) {
  return new Promise((resolve) => {
    let done = false;
    const list = el('div', { class: 'danger-list' },
      ...items.map((it) => el('div', { class: 'danger-item ' + (it.level === 'high' ? 'lv-high' : 'lv-medium') },
        el('div', { class: 'danger-reason' },
          el('span', { class: 'danger-tag ' + (it.level === 'high' ? 'high' : 'medium') }, it.level === 'high' ? '高危' : '注意'),
          it.reason),
        el('pre', { class: 'danger-sql' }, snippet(it.sql)))));

    const input = el('input', {
      type: 'text', class: 'danger-confirm-input', spellcheck: false,
      placeholder: `在此输入连接名：${connName}`,
    });

    const body = el('div', { class: 'danger-body' },
      el('div', { class: 'danger-head' },
        el('span', { class: 'danger-badge' }, '生产库'),
        el('span', {}, ctx.title || `即将在生产连接「${connName}」上执行 ${items.length} 条危险语句`)),
      list,
      el('div', { class: 'danger-confirm-row' },
        el('label', {}, '为防止误操作，请输入连接名 ', el('b', {}, connName), ' 以确认：'),
        input));

    const m = openModal({
      title: '⚠ 生产库危险操作 · 二次确认',
      width: 620,
      body,
      buttons: [
        { label: '取消', onClick: () => { done = true; resolve(false); } },
        { label: '确认执行', danger: true, onClick: () => {
          if (input.value.trim().toLowerCase() !== String(connName).toLowerCase()) { toast.error('连接名不匹配，无法执行'); return false; }
          done = true; resolve(ctx.returnConfirmation ? input.value.trim() : true);
        } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });

    const okBtn = [...m.overlay.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent === '确认执行');
    if (okBtn) okBtn.disabled = true;
    const sync = () => { if (okBtn) okBtn.disabled = input.value.trim().toLowerCase() !== String(connName).toLowerCase(); };
    input.addEventListener('input', sync);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && okBtn && !okBtn.disabled) {
        done = true;
        const confirmation = input.value.trim();
        m.close();
        resolve(ctx.returnConfirmation ? confirmation : true);
      }
    });
    setTimeout(() => input.focus(), 30);
  });
}

// ---------------- 影响范围预检 ----------------
// 主进程把能安全改写的 UPDATE/DELETE 换成 COUNT(*) 跑一遍，回来的是每条语句的行数
// 或「无法预估」的原因。这里只负责决定要不要拦一下、怎么说。
const IMPACT_WARN_ROWS = 1000;

/** 拉取预检结果；失败一律当作「没有预检信息」，绝不因此挡住用户执行 */
async function fetchImpact(payload) {
  if (getSetting('impactPreview') === 'off') return null;
  if (!payload || !payload.sql) return null;
  try {
    const items = await window.api.db.impactPreview(payload.connId, {
      db: payload.db, schema: payload.schema, sql: payload.sql, transactionId: payload.transactionId,
    });
    return Array.isArray(items) && items.length ? items : null;
  } catch (e) {
    return null;
  }
}

function impactNeedsConfirm(items) {
  if (!items) return false;
  if (getSetting('impactPreview') === 'always') return true;
  // risky 档：整表写入（没有 WHERE）、影响面过大、以及「算不出来」都要提示
  return items.some((it) => !it.supported || it.hasWhere === false || (it.rows || 0) >= IMPACT_WARN_ROWS);
}

function impactLine(item) {
  if (!item.supported) return `无法预估（${item.reason}）`;
  const scope = item.hasWhere ? '' : '（整表，没有 WHERE 条件）';
  return `将影响 ${fmtCount(item.rows)} 行${scope}`;
}

/** 非生产连接的轻确认：只报数，不要求输连接名 */
function confirmImpact(items) {
  return new Promise((resolve) => {
    let done = false;
    const severe = items.some((it) => !it.supported || it.hasWhere === false || (it.rows || 0) >= IMPACT_WARN_ROWS);
    const body = el('div', { class: 'danger-body' },
      el('div', { class: 'danger-head' },
        el('span', { class: 'danger-badge impact' }, '影响范围'),
        el('span', {}, `即将执行 ${items.length} 条写操作语句`)),
      el('div', { class: 'danger-list' },
        ...items.map((it) => el('div', { class: 'danger-item ' + (it.supported && it.hasWhere && (it.rows || 0) < IMPACT_WARN_ROWS ? 'lv-medium' : 'lv-high') },
          el('div', { class: 'danger-reason' },
            el('span', { class: 'danger-tag ' + (it.supported && it.hasWhere ? 'medium' : 'high') },
              it.kind === 'delete' ? 'DELETE' : 'UPDATE'),
            impactLine(it)),
          el('pre', { class: 'danger-sql' }, snippet(it.sql))))),
      el('div', { class: 'impact-note' },
        '行数由同样的 WHERE 条件实时统计得出；无法保证等价改写的语句会明确标为「无法预估」，不会给出可能有误的数字。'));
    openModal({
      title: severe ? '⚠ 影响范围确认' : '影响范围确认',
      width: 620,
      body,
      buttons: [
        { label: '取消', onClick: () => { done = true; resolve(false); } },
        { label: '确认执行', danger: severe, primary: !severe, onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

/** 是否为生产连接 */
export function isProd(connId) {
  const c = connById(connId);
  return !!(c && c.env === 'prod');
}

/**
 * 统一生产库审批入口。主进程负责判断连接环境和操作危险性；需要审批时，
 * Renderer 只负责展示强确认 UI，随后向主进程领取绑定 payload 的单次令牌。
 * 返回带 approvalToken 的 payload；用户取消时返回 null。
 * ctx.confirmSafe 仅用于保留非生产环境原有的普通确认框。
 */
export async function authorizeOperation(operation, payload, ctx = {}) {
  const info = await window.api.safety.inspect(operation, payload);
  // 影响范围预检只对自由 SQL 有意义：表数据编辑等操作的影响行数本来就是已知的
  const impact = operation === 'db.query' ? await fetchImpact(payload) : null;
  if (!info.required) {
    if (impactNeedsConfirm(impact) && !(await confirmImpact(impact))) return null;
    if (ctx.confirmSafe && !(await ctx.confirmSafe())) return null;
    return { ...payload };
  }
  // 生产库路径：把行数并进审批清单，用户在同一个弹窗里就能看到影响面
  const items = impact
    ? info.items.map((item) => {
      const hit = impact.find((x) => x.sql && item.sql && x.sql.trim() === item.sql.trim());
      return hit ? { ...item, reason: `${item.reason} · ${impactLine(hit)}` } : item;
    })
    : info.items;
  const confirmation = await confirmDangerExecution(info.connName, items, {
    title: ctx.title || info.title,
    returnConfirmation: true,
  });
  if (!confirmation) return null;
  const approvalToken = await window.api.safety.approve(operation, payload, confirmation);
  if (!approvalToken) return null;
  return { ...payload, approvalToken };
}

/**
 * 生产库执行守卫：若连接标记为生产且 SQL 含危险语句，弹出二次确认。
 * 返回 true 表示放行执行。
 */
export async function guardSql(connId, sql, ctx) {
  return authorizeOperation('db.query', { connId, sql, ...((ctx && ctx.payload) || {}) }, ctx);
}
