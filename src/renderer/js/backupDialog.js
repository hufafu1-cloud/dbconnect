// 备份 / 还原对话框：左边是备份列表，上面是「立即备份」。
//
// 备份文件由主进程放在自己的目录里（渲染进程指定不了路径），
// 所以这里只显示目录位置并提供「打开目录」，不做路径输入框。
import { el, iconEl, fmtBytes, fmtCount } from './util.js';
import { openModal, toast, confirmDialog } from './toast.js';
import { t } from './i18n.js';
import { connLabel } from './state.js';
import { getSetting } from './settings.js';
import { authorizeOperation } from './danger.js';
import { startTask } from './taskCenter.js';

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function openBackupDialog(target) {
  if (!target || !target.connId || !target.db) {
    toast.info(t('请先在左侧选择一个数据库'));
    return null;
  }

  const listEl = el('div', { class: 'backup-list' });
  const status = el('div', { class: 'settings-hint backup-status' });
  const rootEl = el('span', { class: 'audit-path' });
  const nameInput = el('input', {
    type: 'text', class: 'settings-select', spellcheck: false,
    placeholder: t('备注（可选），如：上线前'),
    style: { maxWidth: '240px' },
  });
  const includeData = el('input', { type: 'checkbox' });
  includeData.checked = true;
  let busy = false;

  try { rootEl.textContent = await window.api.backup.root(); } catch (e) { /* 忽略 */ }

  async function refresh() {
    let items = [];
    try {
      items = await window.api.backup.list({ connId: target.connId });
    } catch (error) {
      toast.error(t('读取备份列表失败：') + (error && error.message ? error.message : error));
      return;
    }
    const scoped = items.filter((item) => item.db === target.db);
    listEl.replaceChildren();
    if (!scoped.length) {
      // 同一连接下别的库有备份时说清楚，免得用户以为备份"丢了"
      const otherDbs = [...new Set(items.map((item) => item.db))].filter((db) => db && db !== target.db);
      listEl.append(el('div', { class: 'obj-placeholder' },
        t('这个库还没有备份。点上面的「立即备份」开始，默认保留最近 {n} 份。', { n: getSetting('backupKeep') }),
        otherDbs.length
          ? el('div', { style: { marginTop: '6px' } },
            t('该连接下另有 {n} 个库的备份：{list}', { n: otherDbs.length, list: otherDbs.join('、') }))
          : null));
      return;
    }
    for (const item of scoped) listEl.append(backupRow(item));
  }

  function backupRow(item) {
    const meta = [
      fmtTime(item.createdAt),
      t('{n} 个表', { n: item.tables }),
      item.rows === null || item.rows === undefined ? '' : t('{n} 行', { n: fmtCount(item.rows) }),
      fmtBytes(item.bytes),
      item.includeData ? '' : t('仅结构'),
    ].filter(Boolean).join(' · ');
    return el('div', { class: 'backup-item' + (item.missing ? ' missing' : '') },
      el('div', { class: 'backup-line' },
        el('span', { class: 'backup-label' }, item.label || item.db),
        item.missing ? el('span', { class: 'backup-missing' }, t('数据文件缺失')) : null,
        el('span', { class: 'spring' }),
        el('button', {
          class: 'pbtn', disabled: item.missing,
          onClick: () => doRestore(item),
        }, iconEl('importIcon'), t('还原')),
        el('button', { class: 'pbtn', onClick: () => doRemove(item) }, iconEl('trash'), t('删除'))),
      el('div', { class: 'backup-meta' }, meta));
  }

  async function doBackup() {
    if (busy) return;
    busy = true;
    status.textContent = t('正在备份…');
    const task = startTask({
      title: t('备份数据库'), kind: 'backup', connName: connLabel(target.connId), detail: target.db,
    });
    const off = window.api.dba.onProgress((p) => {
      if (!p) return;
      const text = p.total
        ? t('{phase} {done}/{total}', { phase: p.phase || '备份', done: p.done, total: p.total })
        : (p.phase || t('备份中…'));
      status.textContent = text;
      task.progress(text, p.total ? (p.done / p.total) * 100 : undefined);
    });
    try {
      const result = await window.api.backup.create(target.connId, {
        connName: connLabel(target.connId),
        db: target.db,
        schema: target.schema || null,
        name: nameInput.value.trim(),
        includeData: includeData.checked,
        keep: getSetting('backupKeep'),
      });
      const message = t('备份完成：{n} 个表，{size}', { n: result.tables, size: fmtBytes(result.bytes) })
        + (result.pruned ? t('（已清理 {n} 份旧备份）', { n: result.pruned }) : '');
      status.textContent = message;
      status.classList.remove('error');
      task.done(message);
      toast.success(message);
      nameInput.value = '';
      await refresh();
    } catch (error) {
      const message = (error && error.message) || String(error);
      // 常驻的红色错误块：toast 会自动消失，用户回头只会觉得「点了没反应」，
      // 然后去问「备份的数据跑哪了」——失败原因必须留在界面上。
      status.textContent = t('备份失败：') + message;
      status.classList.add('error');
      task.fail(error);
      toast.error(t('备份失败：') + message, 12000);
    } finally {
      off();
      busy = false;
    }
  }

  async function doRestore(item) {
    if (busy) return;
    const ok = await confirmDialog(
      t('从备份还原'),
      t('将用备份「{label}」（{time}）覆盖 {db}。\n\n现有的同名表会被删除并重建，此操作不可撤销。',
        { label: item.label || item.db, time: fmtTime(item.createdAt), db: target.db }),
      { danger: true, okLabel: t('还原') },
    );
    if (!ok) return;

    const payload = {
      id: item.id, db: target.db, schema: target.schema || null,
      backupLabel: item.label, stopOnError: true, transactionMode: 'auto',
    };
    let approved;
    try {
      // 生产库还原要过审批；只读连接会在主进程直接被拒
      approved = await authorizeOperation('backup.restore', { connId: target.connId, ...payload });
    } catch (error) {
      toast.error(t('安全检查失败：') + (error && error.message ? error.message : error));
      return;
    }
    if (!approved) return;

    busy = true;
    status.textContent = t('正在还原…');
    const task = startTask({
      title: t('从备份还原'), kind: 'restore', connName: connLabel(target.connId), detail: item.label || item.id,
    });
    const off = window.api.dba.onProgress((p) => {
      if (!p) return;
      const text = p.total
        ? t('{phase} {done}/{total}', { phase: p.phase || '还原', done: p.done, total: p.total })
        : (p.phase || t('还原中…'));
      status.textContent = text;
      task.progress(text, p.total ? (p.done / p.total) * 100 : undefined);
    });
    try {
      const result = await window.api.backup.restore(target.connId, approved);
      const message = result.failed
        ? t('还原完成：成功 {ok}/{total} 条，失败 {failed} 条', { ok: result.executed, total: result.total, failed: result.failed })
        : t('还原完成：已执行 {ok} 条语句', { ok: result.executed });
      status.textContent = message;
      task.done(message);
      (result.failed ? toast.error : toast.success)(message, result.failed ? 15000 : 8000);
    } catch (error) {
      const message = (error && error.message) || String(error);
      status.textContent = t('还原失败：') + message;
      task.fail(error);
      toast.error(t('还原失败：') + message, 15000);
    } finally {
      off();
      busy = false;
    }
  }

  async function doRemove(item) {
    const ok = await confirmDialog(t('删除备份'),
      t('确定删除备份「{label}」？备份文件会一并删除。', { label: item.label || item.id }),
      { danger: true, okLabel: t('删除') });
    if (!ok) return;
    try {
      await window.api.backup.remove(item.id);
      await refresh();
    } catch (error) {
      toast.error(t('删除失败：') + (error && error.message ? error.message : error));
    }
  }

  const body = el('div', { class: 'settings-body' },
    el('div', { class: 'settings-group' },
      el('div', { class: 'settings-group-title' }, t('立即备份')),
      el('div', { class: 'settings-row' },
        el('label', { class: 'settings-label' }, t('目标')),
        el('div', { class: 'settings-control' },
          el('div', { class: 'backup-target' },
            `${connLabel(target.connId)} / ${target.db}${target.schema ? ` / ${target.schema}` : ''}`),
          // 按钮推到行尾并用普通样式：主色实心会和底部的「关闭」抢视觉重心，
          // 让整个对话框最扎眼的东西变成一个次级操作。
          el('div', { class: 'backup-run-row' },
            nameInput,
            el('label', { class: 'backup-include' }, includeData, el('span', {}, t('包含数据'))),
            el('button', { class: 'btn backup-run', onClick: doBackup }, t('立即备份'))),
          status))),
    el('div', { class: 'settings-group' },
      el('div', { class: 'settings-group-title' }, t('备份历史')),
      listEl,
      el('div', { class: 'backup-foot' },
        rootEl,
        el('button', { class: 'pbtn', onClick: () => window.api.backup.reveal() }, t('打开目录')))),
  );

  await refresh();
  return openModal({
    title: t('备份 / 还原'),
    width: 620,
    body,
    buttons: [{ label: t('关闭'), primary: true }],
  });
}
