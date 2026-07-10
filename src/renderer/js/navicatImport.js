import { el } from './util.js';
import { openModal, toast } from './toast.js';
import { reloadConnections } from './state.js';

const TYPE_LABELS = {
  mysql: 'MySQL / MariaDB',
  postgres: 'PostgreSQL',
  mssql: 'SQL Server',
  sqlite: 'SQLite',
  clickhouse: 'ClickHouse',
  oceanbase: 'OceanBase (MySQL)',
  oboracle: 'OceanBase (Oracle)',
};

function warningBox(preview) {
  const lines = [...(preview.warnings || [])];
  if (!lines.length) lines.push('未检测到需要解密的已保存凭据。');
  return el('div', { class: 'ncx-notice' },
    ...lines.map((line) => el('div', {}, line)),
    el('div', {}, '密码明文不会显示在预览中；解密和系统安全存储均只在主进程完成。'),
    el('div', {}, '所有连接默认保持“未标记”环境，导入后可按需标记生产、测试或开发环境。'));
}

function showPreview(preview) {
  const selectable = preview.connections.filter((item) => !item.duplicate);
  const checks = new Map();
  const selectAll = el('input', { type: 'checkbox', checked: selectable.length > 0 });
  const countLabel = el('span', { class: 'ncx-count' });
  const body = el('div', { class: 'ncx-import' },
    el('div', { class: 'ncx-summary' },
      el('strong', {}, preview.fileName),
      el('span', {}, `识别 ${preview.connections.length} 个，跳过 ${preview.skipped.length} 个不支持项`)),
    warningBox(preview));

  const table = el('table', { class: 'ncx-table' },
    el('thead', {}, el('tr', {},
      el('th', { class: 'ncx-check' }, selectAll),
      el('th', {}, '名称'),
      el('th', {}, '类型'),
      el('th', {}, '目标'),
      el('th', {}, '分组'),
      el('th', {}, '状态'))),
    el('tbody'));
  const tbody = table.querySelector('tbody');

  const updateCount = () => {
    const count = [...checks.values()].filter((input) => input.checked && !input.disabled).length;
    countLabel.textContent = `已选择 ${count} 个连接`;
    const importButton = modal && modal.overlay.querySelector('.modal-foot .primary');
    if (importButton) {
      importButton.disabled = count === 0;
      importButton.textContent = count ? `导入 ${count} 个` : '导入';
    }
    selectAll.checked = selectable.length > 0 && count === selectable.length;
    selectAll.indeterminate = count > 0 && count < selectable.length;
  };

  for (const item of preview.connections) {
    const checkbox = el('input', { type: 'checkbox', checked: !item.duplicate, disabled: item.duplicate });
    checks.set(item.index, checkbox);
    checkbox.addEventListener('change', updateCount);
    tbody.append(el('tr', { class: item.duplicate ? 'duplicate' : '' },
      el('td', { class: 'ncx-check' }, checkbox),
      el('td', { title: item.name }, item.name),
      el('td', {}, TYPE_LABELS[item.type] || item.type),
      el('td', { title: item.target }, item.target, item.hasSsh ? '（SSH）' : ''),
      el('td', {}, item.group || '—'),
      el('td', {}, item.duplicate ? el('span', { class: 'ncx-status skipped' }, '已存在')
        : el('span', { class: 'ncx-status ready' }, item.credentialUpdate ? '补全密码' : '可导入'))));
  }
  body.append(table, el('div', { class: 'ncx-selection' }, countLabel));

  if (preview.skipped.length) {
    body.append(el('details', { class: 'ncx-skipped' },
      el('summary', {}, `${preview.skipped.length} 个不支持的连接`),
      el('ul', {}, ...preview.skipped.map((item) =>
        el('li', {}, `${item.name} — ${item.type}（${item.reason}）`)))));
  }

  selectAll.addEventListener('change', () => {
    for (const input of checks.values()) if (!input.disabled) input.checked = selectAll.checked;
    updateCount();
  });

  let busy = false;
  const submit = async () => {
    if (busy) return;
    const selected = [...checks.entries()].filter(([, input]) => input.checked && !input.disabled).map(([index]) => index);
    if (!selected.length) return;
    busy = true;
    const importButton = modal.overlay.querySelector('.modal-foot .primary');
    if (importButton) { importButton.disabled = true; importButton.textContent = '正在导入…'; }
    try {
      const result = await window.api.conn.importNavicat(preview.importId, selected);
      if (result.cancelled) {
        busy = false;
        updateCount();
        return;
      }
      await reloadConnections();
      modal.close();
      const renamed = result.renamed ? `，重命名 ${result.renamed} 个` : '';
      const updated = result.updated ? `，补全 ${result.updated} 个连接的密码` : '';
      const skipped = result.skipped ? `，跳过 ${result.skipped} 个重复项` : '';
      toast.success(`已导入 ${result.imported} 个 Navicat 连接${updated}${renamed}${skipped}`);
    } catch (error) {
      busy = false;
      updateCount();
      toast.error(`导入失败：${error.message}`);
    }
  };

  const modal = openModal({
    title: '导入 Navicat 连接',
    body,
    width: 880,
    buttons: [
      { label: '取消' },
      { label: '导入', primary: true, onClick: () => { submit(); return false; } },
    ],
  });
  updateCount();
}

export async function openNavicatImport() {
  try {
    const file = await window.api.dlg.openNavicatConnections();
    if (!file) return;
    const preview = await window.api.conn.previewNavicat(file);
    if (!preview.connections.length && !preview.skipped.length) {
      toast.info('该 NCX 文件中没有找到连接配置');
      return;
    }
    showPreview(preview);
  } catch (error) {
    toast.error(`无法读取 Navicat 连接：${error.message}`);
  }
}
