// 回滚中心（路线图 v2.7.0 M3）
//
// 列出最近做过快照的写操作，可以预览反向 SQL 并选择性回滚。
//
// 界面上有两处是刻意设计成"劝阻"而不是"方便"的：
//
// 1. **冲突行默认不勾选，也不允许一键全选包含冲突的行。** 冲突意味着这行在你
//    之后又被别人改过，硬回滚等于悄悄覆盖掉那次改动——那是第二次事故。
//    要强行覆盖必须单独勾"连冲突行一起回滚"，并且再确认一次。
//
// 2. **回滚前必须先看到反向 SQL。** 不提供"选中即回滚"的快捷路径：
//    这是一次写操作，且是在事故现场做的写操作，慢一步比快一步安全。
import { el, iconEl, fmtCount } from './util.js';
import { state } from './state.js';
import { addTab } from './tabs.js';
import { toast, confirmDialog, cellViewer } from './toast.js';
import { authorizeOperation } from './danger.js';
import { t } from './i18n.js';

const TAB_ID = 'undo-center';

const KIND_LABEL = { update: 'UPDATE', delete: 'DELETE', insert: 'INSERT' };
const KIND_REVERSE = {
  update: t('把原值写回去'),
  delete: t('把删掉的行插回去'),
  insert: t('把插入的行删掉'),
};

function fmtTime(ms) {
  const d = new Date(Number(ms) || 0);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export async function openUndoTab() {
  const tab = addTab({
    id: TAB_ID, title: t('回滚中心'), icon: 'history',
    tooltip: t('执行前保存的原值快照，可预览反向 SQL 并选择性回滚'),
  });
  if (tab.pane.childElementCount) { if (tab._reload) tab._reload(); return tab; }
  tab.pane.classList.add('undo-pane');

  let entries = [];
  let current = null;      // 当前预览的快照详情

  const listHost = el('div', { class: 'undo-list' });
  const detailHost = el('div', { class: 'undo-detail' });
  const usageEl = el('span', { class: 'undo-usage' });

  const btnRollback = el('button', {
    class: 'pbtn danger', disabled: true, onClick: () => rollback(),
  }, iconEl('undo'), t('回滚选中的行'));
  const includeConflicts = el('input', { type: 'checkbox' });
  const conflictLabel = el('label', { class: 'undo-include-conflicts', style: { display: 'none' } },
    includeConflicts, el('span', {}, t('连冲突行一起回滚（会覆盖别人的改动）')));

  async function reload() {
    try {
      const result = await window.api.undo.list();
      if (!result.available) {
        listHost.innerHTML = '';
        listHost.append(el('div', { class: 'undo-empty' },
          t('系统安全存储不可用，后悔药已停用。'),
          el('div', { class: 'undo-empty-hint' },
            t('为避免把数据库里的原始数据明文写到磁盘，该功能在无法加密时不会工作。'))));
        usageEl.textContent = '';
        return;
      }
      entries = result.entries || [];
      const usage = result.usage || { entries: 0, bytes: 0 };
      usageEl.textContent = t('{n} 份快照 · 占用 {size}', {
        n: fmtCount(usage.entries), size: fmtBytes(usage.bytes),
      });
      renderList();
    } catch (error) {
      toast.error(t('读取回滚中心失败：') + (error && error.message ? error.message : error));
    }
  }
  tab._reload = reload;

  function connLabelOf(entry) {
    const conn = state.connections.find((c) => c.id === entry.connId);
    return (conn && conn.name) || entry.connName || entry.connId || '';
  }

  function renderList() {
    listHost.innerHTML = '';
    if (!entries.length) {
      listHost.append(el('div', { class: 'undo-empty' },
        t('还没有可回滚的操作。'),
        el('div', { class: 'undo-empty-hint' },
          t('在查询编辑器里执行单条 UPDATE / DELETE / INSERT 时，'
            + '会自动把将被改动的行的原值加密保存到本机，然后出现在这里。'))));
      return;
    }
    for (const entry of entries) {
      const row = el('div', {
        class: 'undo-item' + (current && current.id === entry.id ? ' active' : ''),
        onClick: () => preview(entry.id),
      },
      el('div', { class: 'undo-item-head' },
        el('span', { class: 'undo-kind undo-kind-' + entry.kind }, KIND_LABEL[entry.kind] || entry.kind),
        el('span', { class: 'undo-item-table' }, `${entry.schema ? entry.schema + '.' : ''}${entry.table}`),
        el('span', { class: 'undo-item-rows' }, t('{n} 行', { n: fmtCount(entry.affected) })),
        el('span', { class: 'spring' }),
        el('button', {
          class: 'undo-item-del', title: t('删除这份快照'),
          onClick: (e) => { e.stopPropagation(); removeOne(entry); },
        }, '✕')),
      el('div', { class: 'undo-item-meta' },
        el('span', {}, fmtTime(entry.createdAt)),
        el('span', {}, connLabelOf(entry)),
        el('span', {}, entry.db || ''),
        el('span', {}, fmtBytes(entry.bytes))),
      el('div', { class: 'undo-item-sql', title: entry.sql }, String(entry.sql || '').replace(/\s+/g, ' ')));
      listHost.append(row);
    }
  }

  function renderDetail() {
    detailHost.innerHTML = '';
    btnRollback.disabled = true;
    conflictLabel.style.display = 'none';
    includeConflicts.checked = false;
    if (!current) {
      detailHost.append(el('div', { class: 'undo-empty' }, t('选择左侧的一条操作查看反向 SQL')));
      return;
    }
    const conflicts = current.rows.filter((r) => r.conflict);
    const usable = current.rows.length - conflicts.length;
    detailHost.append(el('div', { class: 'undo-detail-head' },
      el('div', { class: 'undo-detail-title' },
        `${KIND_LABEL[current.kind]} · ${current.table}`,
        el('span', { class: 'undo-detail-sub' }, KIND_REVERSE[current.kind] || '')),
      el('div', { class: 'undo-detail-meta' },
        t('快照时间 {time} · 共 {n} 行', { time: fmtTime(current.createdAt), n: fmtCount(current.rows.length) }),
        conflicts.length
          ? el('span', { class: 'undo-conflict-badge' },
              t('{n} 行有冲突，默认跳过', { n: fmtCount(conflicts.length) }))
          : el('span', { class: 'undo-ok-badge' }, t('无冲突')))));

    if (conflicts.length) {
      detailHost.append(el('div', { class: 'undo-conflict-note' },
        iconEl('info'),
        el('div', {},
          el('b', {}, t('这些行在本次操作之后又被改动过。')),
          el('div', {}, t('把原值硬写回去会覆盖掉那次改动。默认跳过它们；'
            + '确实要覆盖时再勾选下面的选项，并自行确认后果。')),
          el('div', { class: 'undo-conflict-list' },
            ...conflicts.slice(0, 5).map((r) => el('div', {}, `• ${r.reason}`)),
            conflicts.length > 5
              ? el('div', {}, t('…另有 {n} 行同类冲突', { n: conflicts.length - 5 }))
              : null))));
    }

    // 反向 SQL 预览：只列前 200 条，够看清在做什么，又不会把界面塞爆
    const preview = current.rows.slice(0, 200);
    detailHost.append(el('div', { class: 'undo-sql-head' },
      t('反向 SQL（显示前 {n} 条）', { n: fmtCount(preview.length) }),
      el('span', { class: 'spring' }),
      el('button', {
        class: 'pbtn', onClick: () => cellViewer(t('反向 SQL'),
          current.rows.map((r) => r.sql).join(';\n') + ';', null),
      }, iconEl('copy'), t('查看全部'))));
    const list = el('div', { class: 'undo-sql-list' });
    for (const item of preview) {
      list.append(el('div', { class: 'undo-sql-item' + (item.conflict ? ' conflict' : '') },
        item.conflict ? el('span', { class: 'undo-sql-flag', title: item.reason }, '⚠') : null,
        el('code', {}, item.sql)));
    }
    detailHost.append(list);

    btnRollback.disabled = !usable && !conflicts.length;
    btnRollback.textContent = '';
    btnRollback.append(iconEl('undo'), t('回滚 {n} 行', { n: fmtCount(usable) }));
    if (conflicts.length) {
      conflictLabel.style.display = '';
      btnRollback.disabled = usable === 0 && !includeConflicts.checked;
    }
  }

  async function preview(id) {
    try {
      current = await window.api.undo.preview(id);
      renderList();
      renderDetail();
    } catch (error) {
      const message = (error && error.message) || String(error);
      current = null;
      renderList();
      detailHost.innerHTML = '';
      detailHost.append(el('div', { class: 'undo-empty' },
        t('无法预览这份快照'),
        el('div', { class: 'undo-empty-hint' }, message),
        /连接未打开/.test(message)
          ? el('div', { class: 'undo-empty-hint' },
              t('回滚要读回当前值来判断有没有被别人改过，因此必须先打开对应的连接。'))
          : null));
    }
  }

  async function rollback() {
    if (!current) return;
    const withConflicts = includeConflicts.checked;
    const conflicts = current.rows.filter((r) => r.conflict).length;
    const count = withConflicts ? current.rows.length : current.rows.length - conflicts;
    if (!count) { toast.info(t('没有可回滚的行')); return; }
    const ok = await confirmDialog(t('确认回滚'),
      t('将对 {table} 执行 {n} 条反向 SQL。', { table: current.table, n: fmtCount(count) })
      + (withConflicts && conflicts
        ? t('\n\n其中 {n} 行存在冲突：它们在本次操作之后又被改动过，回滚会覆盖那次改动。',
          { n: fmtCount(conflicts) })
        : '')
      + t('\n\n回滚本身也是一次写操作，会记入操作审计。'),
      { danger: true, okLabel: t('执行回滚') });
    if (!ok) return;
    try {
      // 与网格改数据同一个审批口径：都是"按主键逐行改写数据"，生产库要二次确认
      const approved = await authorizeOperation('db.applyEdits', {
        connId: current.connId, db: current.db, table: current.table,
        sql: current.rows.slice(0, 3).map((r) => r.sql).join('; '),
      }, { title: t('回滚生产库数据') });
      if (!approved) return;
      const result = await window.api.undo.rollback(current.id, {
        includeConflicts: withConflicts,
        ...approved,
      });
      if (!result.applied) {
        toast.info(result.message || t('没有回滚任何行'));
      } else {
        toast.success(t('已回滚 {n} 行', { n: fmtCount(result.applied) })
          + (result.skipped.length ? t('，跳过 {n} 行冲突', { n: result.skipped.length }) : ''));
      }
      await preview(current.id);
      await reload();
    } catch (error) {
      toast.error(t('回滚失败：') + (error && error.message ? error.message : error));
    }
  }

  async function removeOne(entry) {
    const ok = await confirmDialog(t('删除快照'),
      t('删除后这次 {kind} 就再也回滚不了了。确定吗？', { kind: KIND_LABEL[entry.kind] }),
      { danger: true, okLabel: t('删除') });
    if (!ok) return;
    await window.api.undo.remove(entry.id).catch(() => {});
    if (current && current.id === entry.id) { current = null; renderDetail(); }
    await reload();
  }

  async function clearAll() {
    const ok = await confirmDialog(t('清空回滚中心'),
      t('将删除全部 {n} 份快照，之后这些操作都无法再回滚。确定吗？', { n: entries.length }),
      { danger: true, okLabel: t('全部清空') });
    if (!ok) return;
    const n = await window.api.undo.clear().catch(() => 0);
    current = null;
    renderDetail();
    await reload();
    toast.success(t('已清空 {n} 份快照', { n }));
  }

  includeConflicts.addEventListener('change', renderDetail);

  tab.pane.append(
    el('div', { class: 'pane-toolbar' },
      el('button', { class: 'pbtn', onClick: reload }, iconEl('refresh'), t('刷新')),
      el('span', { class: 'sep' }),
      btnRollback,
      conflictLabel,
      el('span', { class: 'spring' }),
      usageEl,
      el('button', { class: 'pbtn danger', onClick: clearAll }, iconEl('trash'), t('全部清空'))),
    el('div', { class: 'undo-body' }, listHost, detailHost),
  );

  renderDetail();
  await reload();
  return tab;
}
