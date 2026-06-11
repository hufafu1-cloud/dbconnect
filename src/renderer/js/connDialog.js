// 新建 / 编辑连接对话框
import { el } from './util.js';
import { openModal, toast } from './toast.js';
import { reloadConnections } from './state.js';

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

export function openConnDialog(existing, presetType) {
  const isEdit = !!existing;
  // 新建连接时 port/user/database 留空，由各类型的 TYPE_DEFAULTS 填充（切换类型时跟随变化）
  const cfg = existing ? { ...existing, options: { ...(existing.options || {}) } }
    : { type: presetType || 'mysql', name: '', host: 'localhost', port: undefined, user: undefined, password: '', database: undefined, file: '', options: {} };

  const typeSel = el('select', {}, ...TYPE_NAMES.map(([v, n]) =>
    el('option', { value: v, selected: v === cfg.type ? 'selected' : null }, n)));
  typeSel.value = cfg.type;
  const nameInput = field('text', cfg.name, '如: 本地 MySQL');
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
        const p = await window.api.dlg.openFile({
          title: '选择 SQLite 数据库文件',
          filters: [{ name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }, { name: '所有文件', extensions: ['*'] }],
        });
        if (p) f.file.value = p;
      } }, '浏览…');
      const newBtn = el('button', { class: 'btn', onClick: async () => {
        const p = await window.api.dlg.saveFile({
          title: '新建 SQLite 数据库文件', defaultPath: 'new.db',
          filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
        });
        if (p) f.file.value = p;
      } }, '新建…');
      add('数据库文件', el('div', { class: 'row-flex' }, f.file, browse, newBtn));
    } else {
      const d = TYPE_DEFAULTS[t];
      f.host = field('text', cfg.host || 'localhost');
      f.port = field('number', cfg.port || d.port);
      f.user = field('text', cfg.user !== undefined && cfg.user !== '' ? cfg.user : d.user);
      f.password = field('password', cfg.password);
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
      f.sshPassword = field('password', ssh.password, 'SSH 登录密码');
      f.sshKeyFile = field('text', ssh.keyFile, '如 C:\\Users\\you\\.ssh\\id_rsa');
      const sshKeyBrowse = el('button', { class: 'btn', onClick: async () => {
        const p = await window.api.dlg.openFile({ title: '选择 SSH 私钥文件', filters: [{ name: '所有文件', extensions: ['*'] }] });
        if (p) f.sshKeyFile.value = p;
      } }, '浏览…');
      f.sshPassphrase = field('password', ssh.passphrase, '私钥密码（没有则留空）');

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
    };
    if (t === 'sqlite') {
      out.file = f.file.value.trim();
    } else {
      out.host = f.host.value.trim() || 'localhost';
      out.port = Number(f.port.value) || TYPE_DEFAULTS[t].port;
      out.user = f.user.value.trim();
      out.password = f.password.value;
      out.database = f.database.value.trim();
      if (t === 'mssql') out.options = { encrypt: f.encrypt.checked, trustCert: f.trustCert.checked };
      if (t === 'clickhouse') out.options = { https: f.https.checked };
      out.ssh = {
        enabled: f.sshEnabled.checked,
        host: f.sshHost.value.trim(),
        port: Number(f.sshPort.value) || 22,
        user: f.sshUser.value.trim(),
        authType: f.sshAuth.value,
        password: f.sshPassword.value,
        keyFile: f.sshKeyFile.value.trim(),
        passphrase: f.sshPassphrase.value,
      };
    }
    return out;
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
    fieldsBox);

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
          window.api.conn.save(c).then(async () => {
            await reloadConnections();
            toast.success(isEdit ? '连接已更新' : '连接已创建');
          }).catch((e) => toast.error(e.message));
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
