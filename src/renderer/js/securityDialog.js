// 连接安全体检：把「是否生产、是否只读、密码是否落盘、是否走跳板机、指纹有没有核验」
// 这几件散在四处的事实汇总到一屏。
//
// 这里不引入任何新能力——这些保护本来就已经在跑了，只是用户看不见，
// 因此也没法把它当成选型理由。事实收集在主进程完成（SSH 指纹只有主进程知道）。
import { el } from './util.js';
import { openModal, toast } from './toast.js';
import { t } from './i18n.js';

const ENV_LABEL = { prod: '生产', test: '测试', dev: '开发' };

/** 单条检查项：level 决定图标与配色 */
function checkItem(level, label, detail) {
  const icon = level === 'warn' ? '!' : (level === 'ok' ? '✓' : 'ℹ');
  return el('div', { class: `sec-check sec-${level}` },
    el('span', { class: 'sec-icon' }, icon),
    el('span', { class: 'sec-check-label' }, label),
    detail ? el('span', { class: 'sec-check-detail' }, detail) : null);
}

/** 把一条连接的事实翻译成检查项；同时返回该连接是否有需要注意的地方 */
function reviewConnection(conn) {
  const checks = [];
  let warnings = 0;
  const warn = (label, detail) => { warnings++; checks.push(checkItem('warn', label, detail)); };

  if (conn.env) checks.push(checkItem('ok', t('环境标记'), ENV_LABEL[conn.env] || conn.env));
  else checks.push(checkItem('info', t('环境标记'), t('未标记 — 生产库建议标记，可启用危险操作二次确认')));

  if (conn.readOnly) {
    checks.push(checkItem('ok', t('访问权限'), t('只读，主进程强制拒绝一切写入')));
  } else if (conn.env === 'prod') {
    warn(t('访问权限'), t('可写。生产库若只用于查数，建议开启「只读连接」'));
  } else {
    checks.push(checkItem('info', t('访问权限'), t('可写')));
  }

  if (!conn.needsPassword) {
    checks.push(checkItem('info', t('凭据'), t('本地文件，无需密码')));
  } else if (conn.passwordOnDisk) {
    checks.push(checkItem('info', t('凭据'), t('密码已由系统安全存储加密保存在本机')));
  } else {
    checks.push(checkItem('ok', t('凭据'), t('密码不落盘，每次连接重新输入')));
  }

  if (!conn.ssh) {
    checks.push(checkItem('info', t('网络路径'), t('直连数据库')));
  } else if (conn.ssh.verified) {
    checks.push(checkItem('ok', t('网络路径'),
      t('经跳板机 {host}:{port}，主机指纹已核验', { host: conn.ssh.host, port: conn.ssh.port })));
  } else {
    warn(t('网络路径'),
      t('经跳板机 {host}:{port}，主机指纹尚未核验 — 首次连接时会要求人工确认', { host: conn.ssh.host, port: conn.ssh.port }));
  }

  return { checks, warnings };
}

function connectionCard(conn) {
  const { checks, warnings } = reviewConnection(conn);
  const badges = el('span', { class: 'sec-badges' });
  if (conn.env) badges.append(el('span', { class: `tree-env env-${conn.env}` }, ENV_LABEL[conn.env] || conn.env));
  if (conn.readOnly) badges.append(el('span', { class: 'tree-env env-readonly' }, t('只读')));
  return {
    warnings,
    node: el('div', { class: 'sec-card' + (warnings ? ' has-warn' : '') },
      el('div', { class: 'sec-card-head' },
        el('span', { class: 'sec-name' }, conn.name),
        el('span', { class: 'sec-type' }, conn.type),
        badges),
      el('div', { class: 'sec-checks' }, ...checks)),
  };
}

export async function openSecurityDialog() {
  let list = [];
  try {
    list = await window.api.security.review();
  } catch (error) {
    toast.error(t('读取连接安全信息失败：') + (error && error.message ? error.message : error));
    return null;
  }
  if (!list.length) {
    return openModal({
      title: t('连接安全体检'),
      body: el('div', { class: 'sec-body' }, el('div', { class: 'sec-empty' }, t('还没有连接。'))),
      buttons: [{ label: t('关闭'), primary: true }],
    });
  }

  const cards = list.map(connectionCard);
  const totalWarnings = cards.reduce((sum, c) => sum + c.warnings, 0);
  const summary = totalWarnings
    ? t('{n} 个连接中有 {w} 处建议关注', { n: list.length, w: totalWarnings })
    : t('{n} 个连接均无需关注的风险项', { n: list.length });

  return openModal({
    title: t('连接安全体检'),
    width: 620,
    body: el('div', { class: 'sec-body' },
      el('div', { class: 'sec-summary' + (totalWarnings ? ' has-warn' : '') }, summary),
      ...cards.map((c) => c.node),
      el('div', { class: 'sec-note' },
        t('数据库密码、SSH 口令与 AI API Key 均由系统安全存储加密，仅在主进程内解密；本页只展示结论，不含任何凭据内容。'))),
    buttons: [{ label: t('关闭'), primary: true }],
  });
}
