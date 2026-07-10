// 新建 / 编辑连接对话框
import { el } from './util.js';
import { openModal, toast } from './toast.js';
import { state, emit, reloadConnections } from './state.js';
import { authorizeOperation } from './danger.js';

const TYPE_DEFAULTS = {
  mysql: { port: 3306, user: 'root', database: '' },
  postgres: { port: 5432, user: 'postgres', database: 'postgres' },
  mssql: { port: 1433, user: 'sa', database: 'master' },
  clickhouse: { port: 8123, user: 'default', database: 'default' },
  oceanbase: { port: 2881, user: 'root@sys', database: '' },
  oboracle: { port: 2881, user: 'SYS@', database: '' },
  sqlite: {},
};
const TYPE_NAMES = [
  ['mysql', 'MySQL / MariaDB'],
  ['postgres', 'PostgreSQL'],
  ['sqlite', 'SQLite'],
  ['mssql', 'SQL Server'],
  ['clickhouse', 'ClickHouse'],
  ['oceanbase', 'OceanBase (MySQL 模式)'],
  ['oboracle', 'OceanBase (Oracle 模式)'],
];

export function openConnDialog(existing, presetType, presetGroup) {
  const isEdit = !!existing;
  // 新建连接时 port/user/database 留空，由各类型的 TYPE_DEFAULTS 填充（切换类型时跟随变化）
  const cfg = existing ? { ...existing, options: { ...(existing.options || {}) } }
    : { type: presetType || 'mysql', name: '', host: 'localhost', port: undefined, user: undefined, password: '', database: undefined, file: '', options: {}, group: presetGroup || '' };

  const typeSel = el('select', {}, ...TYPE_NAMES.map(([v, n]) =>
    el('option', { value: v, selected: v === cfg.type ? 'selected' : null }, n)));
  typeSel.value = cfg.type;
  const nameInput = field('text', cfg.name, '如: 本地 MySQL');

  // 分组 + 颜色标记（生产库标红防误操作）
  const groupInput = el('input', { type: 'text', value: cfg.group || '', placeholder: '（可选）如: 生产 / 测试', spellcheck: false, list: 'conn-groups' });
  let groupDl = document.getElementById('conn-groups');
  if (!groupDl) { groupDl = el('datalist', { id: 'conn-groups' }); document.body.append(groupDl); }
  groupDl.innerHTML = '';
  import('./state.js').then(({ state }) => {
    const groups = [...new Set(state.connections.map((c) => c.group).filter(Boolean))];
    for (const g of groups) groupDl.append(el('option', { value: g }));
  });
  const COLORS = [
    ['', '无'], ['#e5484d', '红'], ['#f76b15', '橙'], ['#ffb224', '黄'],
    ['#30a46c', '绿'], ['#0091ff', '蓝'], ['#8e4ec6', '紫'], ['#d6409f', '粉'],
  ];
  // 环境 / 链接类型：标记为「生产」后，危险 SQL 执行前需二次确认
  const ENVS = [['', '未标记'], ['dev', '开发'], ['test', '测试'], ['prod', '生产']];
  const envSel = el('select', { title: '链接类型 / 环境' },
    ...ENVS.map(([v, n]) => el('option', { value: v, selected: v === (cfg.env || '') ? 'selected' : null }, n)));
  envSel.value = cfg.env || '';
  const envHint = el('div', { style: { fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.6' } });
  const refreshEnvHint = () => {
    envHint.textContent = envSel.value === 'prod'
      ? '已标记为生产库：执行 DROP / TRUNCATE / 无 WHERE 的 DELETE·UPDATE 等危险语句前，将要求输入连接名二次确认。'
      : '生产环境建议标记为「生产」，可在执行危险 SQL 前强制二次确认，防止误操作。';
  };
  envSel.addEventListener('change', () => { refreshEnvHint(); if (envSel.value === 'prod' && !pickedColor) setColor('#e5484d'); });
  refreshEnvHint();

  let pickedColor = cfg.color || '';
  const swatchEls = new Map();
  function setColor(c) {
    pickedColor = c;
    for (const [cc, x] of swatchEls) x.classList.toggle('active', cc === c);
  }
  const swatches = el('div', { class: 'color-swatches' },
    ...COLORS.map(([c, label]) => {
      const sw = el('span', {
        class: 'color-swatch' + (c ? '' : ' none') + (pickedColor === c ? ' active' : ''),
        title: label,
        style: c ? { background: c } : {},
        onClick: () => setColor(c),
      }, c ? '' : '∅');
      swatchEls.set(c, sw);
      return sw;
    }));
  const fieldsBox = el('div', { style: { display: 'contents' } });
  const testResult = el('span', { class: 'test-result' }, '');

  function field(type, value, placeholder) {
    return el('input', { type, value: value === undefined || value === null ? '' : String(value), placeholder: placeholder || '', spellcheck: false });
  }

  let f = {}; // 当前类型的动态字段

  function renderTypeFields() {
    fieldsBox.innerHTML = '';
    const t = typeSel.value;
    f = {};
    const add = (label, node) => {
      fieldsBox.append(el('label', {}, label), node);
    };
    if (t === 'sqlite') {
      f.file = field('text', cfg.file, '数据库文件路径（不存在则自动创建）');
      const browse = el('button', { class: 'btn', onClick: async () => {
        const p = await window.api.dlg.openSQLiteFile();
        if (p) f.file.value = p;
      } }, '浏览…');
      const newBtn = el('button', { class: 'btn', onClick: async () => {
        const p = await window.api.dlg.saveSQLiteFile();
        if (p) f.file.value = p;
      } }, '新建…');
      add('数据库文件', el('div', { class: 'row-flex' }, f.file, browse, newBtn));
    } else {
      const d = TYPE_DEFAULTS[t];
      f.host = field('text', cfg.host || 'localhost');
      f.port = field('number', cfg.port || d.port);
      f.user = field('text', cfg.user !== undefined && cfg.user !== '' ? cfg.user : d.user);
      f.password = field('password', '', cfg.hasPassword ? '已安全保存；留空保持不变' : '');
      f.passwordDirty = false;
      f.password.addEventListener('input', () => { f.passwordDirty = true; });
      const showPw = el('button', { class: 'btn', tabIndex: -1, onClick: () => {
        f.password.type = f.password.type === 'password' ? 'text' : 'password';
      } }, '👁');
      f.database = field('text', cfg.database !== undefined && cfg.database !== '' ? cfg.database : d.database,
        t === 'mysql' ? '（可选）初始数据库' : '初始数据库');
      add('主机', f.host);
      add('端口', f.port);
      add('用户名', f.user);
      add('密码', el('div', { class: 'row-flex' }, f.password, showPw));
      add('初始数据库', f.database);
      if (t === 'mssql') {
        f.encrypt = el('input', { type: 'checkbox' });
        f.encrypt.checked = !!(cfg.options && cfg.options.encrypt);
        f.trustCert = el('input', { type: 'checkbox' });
        f.trustCert.checked = !cfg.options || cfg.options.trustCert !== false;
        add('', el('div', { class: 'form-check' }, f.encrypt, '加密连接 (Azure 需勾选)'));
        add('', el('div', { class: 'form-check' }, f.trustCert, '信任服务器证书'));
      }
      if (t === 'oceanbase') {
        add('', el('div', { style: { fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.6' } },
          '用户名格式：直连 2881 端口为 用户@租户（如 root@sys）；', el('br'),
          '经 OBProxy(2883) 为 用户@租户#集群名'));
      }
      if (t === 'oboracle') {
        add('', el('div', { style: { fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.6' } },
          '用户名格式：用户@Oracle租户（如 SYS@oracle_t），经 OBProxy 加 #集群名；', el('br'),
          '初始数据库留空即可（按 Schema 浏览）。Oracle 模式为实验性支持。'));
      }
      if (t === 'clickhouse') {
        f.https = el('input', { type: 'checkbox' });
        f.https.checked = !!(cfg.options && cfg.options.https);
        // 勾选 HTTPS 时若端口还是默认值，自动在 8123/8443 间切换
        f.https.addEventListener('change', () => {
          if (f.https.checked && f.port.value === '8123') f.port.value = '8443';
          else if (!f.https.checked && f.port.value === '8443') f.port.value = '8123';
        });
        add('', el('div', { class: 'form-check' }, f.https, '使用 HTTPS（云服务通常为 8443 端口）'));
      }

      // ---- SSH 隧道（所有网络型数据库通用） ----
      const ssh = cfg.ssh || {};
      f.sshEnabled = el('input', { type: 'checkbox' });
      f.sshEnabled.checked = !!ssh.enabled;
      add('', el('div', { class: 'form-check', style: { borderTop: '1px solid var(--border-light)', paddingTop: '10px', marginTop: '2px' } },
        f.sshEnabled, el('b', {}, '使用 SSH 隧道'),
        el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '（上方主机/端口填跳板机视角的地址）')));

      f.sshHost = field('text', ssh.host, '跳板机公网地址');
      f.sshPort = field('number', ssh.port || 22);
      f.sshUser = field('text', ssh.user, '如 root / ops');
      f.sshAuth = el('select', {},
        el('option', { value: 'password' }, '密码'),
        el('option', { value: 'key' }, '私钥文件'));
      f.sshAuth.value = ssh.authType || 'password';
      f.sshPassword = field('password', '', ssh.hasPassword ? '已安全保存；留空保持不变' : 'SSH 登录密码');
      f.sshPasswordDirty = false;
      f.sshPassword.addEventListener('input', () => { f.sshPasswordDirty = true; });
      f.sshKeyFile = field('text', ssh.keyFile, '如 C:\\Users\\you\\.ssh\\id_rsa');
      const sshKeyBrowse = el('button', { class: 'btn', onClick: async () => {
        const p = await window.api.dlg.openSshKeyFile();
        if (p) f.sshKeyFile.value = p;
      } }, '浏览…');
      f.sshPassphrase = field('password', '', ssh.hasPassphrase ? '已安全保存；留空保持不变' : '私钥密码（没有则留空）');
      f.sshPassphraseDirty = false;
      f.sshPassphrase.addEventListener('input', () => { f.sshPassphraseDirty = true; });

      const sshRows = [];
      const addSsh = (label, node, group) => {
        const l = el('label', {}, label);
        fieldsBox.append(l, node);
        sshRows.push({ l, node, group });
      };
      addSsh('SSH 主机', f.sshHost, 'all');
      addSsh('SSH 端口', f.sshPort, 'all');
      addSsh('SSH 用户', f.sshUser, 'all');
      addSsh('SSH 认证', f.sshAuth, 'all');
      addSsh('SSH 密码', f.sshPassword, 'password');
      addSsh('私钥文件', el('div', { class: 'row-flex' }, f.sshKeyFile, sshKeyBrowse), 'key');
      addSsh('私钥密码', f.sshPassphrase, 'key');

      const refreshSsh = () => {
        const on = f.sshEnabled.checked;
        const mode = f.sshAuth.value;
        for (const r of sshRows) {
          const show = on && (r.group === 'all' || r.group === mode);
          r.l.style.display = show ? '' : 'none';
          r.node.style.display = show ? '' : 'none';
        }
      };
      f.sshEnabled.addEventListener('change', refreshSsh);
      f.sshAuth.addEventListener('change', refreshSsh);
      refreshSsh();
    }
  }

  typeSel.addEventListener('change', () => { renderTypeFields(); });
  renderTypeFields();

  function collect() {
    const t = typeSel.value;
    const out = {
      id: cfg.id,
      name: nameInput.value.trim(),
      type: t,
      group: groupInput.value.trim(),
      color: pickedColor,
      env: envSel.value,
    };
    if (t === 'sqlite') {
      out.file = f.file.value.trim();
    } else {
      out.host = f.host.value.trim() || 'localhost';
      out.port = Number(f.port.value) || TYPE_DEFAULTS[t].port;
      out.user = f.user.value.trim();
      if (!isEdit || f.passwordDirty || !cfg.hasPassword) out.password = f.password.value;
      out.database = f.database.value.trim();
      if (t === 'mssql') out.options = { encrypt: f.encrypt.checked, trustCert: f.trustCert.checked };
      if (t === 'clickhouse') out.options = { https: f.https.checked };
      out.ssh = {
        enabled: f.sshEnabled.checked,
        host: f.sshHost.value.trim(),
        port: Number(f.sshPort.value) || 22,
        user: f.sshUser.value.trim(),
        authType: f.sshAuth.value,
        keyFile: f.sshKeyFile.value.trim(),
      };
      if (!isEdit || f.sshPasswordDirty || !sshHas(cfg, 'hasPassword')) out.ssh.password = f.sshPassword.value;
      if (!isEdit || f.sshPassphraseDirty || !sshHas(cfg, 'hasPassphrase')) out.ssh.passphrase = f.sshPassphrase.value;
    }
    return out;
  }

  function sshHas(c, key) {
    return !!(c && c.ssh && c.ssh[key]);
  }

  function validate(c) {
    if (!c.name) { toast.error('请填写连接名'); return false; }
    if (c.type === 'sqlite' && !c.file) { toast.error('请选择数据库文件'); return false; }
    if (c.type !== 'sqlite' && !c.host) { toast.error('请填写主机'); return false; }
    if (c.ssh && c.ssh.enabled) {
      if (!c.ssh.host) { toast.error('请填写 SSH 主机'); return false; }
      if (!c.ssh.user) { toast.error('请填写 SSH 用户名'); return false; }
      if (c.ssh.authType === 'key' && !c.ssh.keyFile) { toast.error('请选择 SSH 私钥文件'); return false; }
    }
    return true;
  }

  const body = el('div', { class: 'form-grid' },
    el('label', {}, '连接类型'), typeSel,
    el('label', {}, '连接名'), nameInput,
    el('label', {}, '分组'), groupInput,
    el('label', {}, '链接类型'), el('div', {}, envSel, envHint),
    el('label', {}, '颜色标记'), swatches,
    fieldsBox);

  let saving = false;
  const m = openModal({
    title: isEdit ? `编辑连接 — ${cfg.name}` : '新建连接',
    body,
    width: 540,
    buttons: [
      {
        label: '测试连接',
        onClick: () => {
          const c = collect();
          if (!validate(c)) return false;
          testResult.className = 'test-result';
          testResult.textContent = '正在连接…';
          window.api.conn.test(c).then((r) => {
            testResult.className = 'test-result ok';
            testResult.textContent = `✔ 连接成功（${r.version}，${r.ms} ms）`;
          }).catch((e) => {
            testResult.className = 'test-result err';
            testResult.textContent = '✖ ' + e.message;
          });
          return false; // 不关闭
        },
      },
      { label: '取消' },
      {
        label: '保存', primary: true,
        onClick: () => {
          const c = collect();
          if (!validate(c)) return false;
          if (saving) return false;
          saving = true;
          (async () => {
            try {
              const approved = await authorizeOperation('conn.save', c);
              if (!approved) return;
              const saved = await window.api.conn.save(approved);
              if (saved.connectionClosed) {
                state.open.delete(saved.id);
                emit('conn-closed', { connId: saved.id });
              }
              await reloadConnections();
              toast.success(isEdit ? '连接已更新' : '连接已创建');
              m.close();
            } catch (e) {
              toast.error(e.message);
            } finally {
              saving = false;
            }
          })();
          return false;
        },
      },
    ],
  });
  // 把测试结果插到底部按钮区左侧
  const foot = m.overlay.querySelector('.modal-foot');
  foot.insertBefore(testResult, foot.firstChild);
  setTimeout(() => nameInput.focus(), 30);
  return m;
}
