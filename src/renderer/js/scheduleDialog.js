// 定时任务对话框。
//
// 必须把「仅在应用运行时生效」写在最显眼的位置——用户如果以为关掉软件也会
// 自动备份，那这个功能就是负价值。
import { el, iconEl } from './util.js';
import { openModal, toast, confirmDialog } from './toast.js';
import { t } from './i18n.js';
import { state } from './state.js';

const KINDS = [['backup', t('备份数据库')], ['dataDict', t('导出数据字典')]];
const SCHEDULES = [['daily', t('每天')], ['weekly', t('每周')], ['interval', t('按间隔')]];
const WEEKDAYS = [t('周日'), t('周一'), t('周二'), t('周三'), t('周四'), t('周五'), t('周六')];

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function scheduleText(job) {
  if (job.scheduleType === 'interval') return t('每 {n} 分钟', { n: job.intervalMinutes });
  if (job.scheduleType === 'weekly') return `${WEEKDAYS[job.weekday] || ''} ${job.at}`;
  return t('每天 {time}', { time: job.at });
}

/** 新建 / 编辑一个作业 */
function editJob(existing, onSaved) {
  const job = existing || {};
  const name = el('input', { type: 'text', class: 'settings-select', value: job.name || '', spellcheck: false });
  const kind = el('select', { class: 'settings-select' },
    ...KINDS.map(([v, label]) => el('option', { value: v }, label)));
  kind.value = job.kind || 'backup';

  const connSel = el('select', { class: 'settings-select' },
    ...state.connections.map((c) => el('option', { value: c.id }, c.name)));
  if (job.connId) connSel.value = job.connId;
  const dbInput = el('input', {
    type: 'text', class: 'settings-select', value: job.db || '', spellcheck: false,
    placeholder: t('数据库名'),
  });

  const scheduleType = el('select', { class: 'settings-select' },
    ...SCHEDULES.map(([v, label]) => el('option', { value: v }, label)));
  scheduleType.value = job.scheduleType || 'daily';
  const at = el('input', { type: 'time', class: 'settings-select', value: job.at || '02:00' });
  const weekday = el('select', { class: 'settings-select' },
    ...WEEKDAYS.map((label, i) => el('option', { value: String(i) }, label)));
  weekday.value = String(job.weekday === undefined ? 1 : job.weekday);
  const interval = el('input', {
    type: 'number', class: 'settings-select', min: '5', max: '10080',
    value: String(job.intervalMinutes || 60),
  });

  const timeRow = el('div', { class: 'row-flex', style: { gap: '8px' } }, weekday, at, interval);
  const syncSchedule = () => {
    weekday.style.display = scheduleType.value === 'weekly' ? '' : 'none';
    at.style.display = scheduleType.value === 'interval' ? 'none' : '';
    interval.style.display = scheduleType.value === 'interval' ? '' : 'none';
  };
  scheduleType.addEventListener('change', syncSchedule);
  syncSchedule();

  const body = el('div', { class: 'settings-body' },
    el('div', { class: 'settings-group' },
      el('div', { class: 'settings-row' },
        el('label', { class: 'settings-label' }, t('任务名')), el('div', { class: 'settings-control' }, name)),
      el('div', { class: 'settings-row' },
        el('label', { class: 'settings-label' }, t('类型')), el('div', { class: 'settings-control' }, kind)),
      el('div', { class: 'settings-row' },
        el('label', { class: 'settings-label' }, t('连接')),
        el('div', { class: 'settings-control' }, connSel,
          el('div', { class: 'settings-hint' }, t('定时执行需要该连接已保存密码，否则无法自动连接。')))),
      el('div', { class: 'settings-row' },
        el('label', { class: 'settings-label' }, t('数据库')), el('div', { class: 'settings-control' }, dbInput)),
      el('div', { class: 'settings-row' },
        el('label', { class: 'settings-label' }, t('频率')),
        el('div', { class: 'settings-control' }, scheduleType, timeRow))),
  );

  openModal({
    title: existing ? t('编辑定时任务') : t('新建定时任务'),
    width: 520,
    body,
    buttons: [
      { label: t('取消') },
      {
        label: t('保存'),
        primary: true,
        onClick: () => {
          const payload = {
            id: job.id,
            name: name.value.trim() || t('未命名任务'),
            enabled: job.enabled === undefined ? true : job.enabled,
            kind: kind.value,
            connId: connSel.value,
            db: dbInput.value.trim(),
            scheduleType: scheduleType.value,
            at: at.value,
            weekday: Number(weekday.value),
            intervalMinutes: Number(interval.value),
          };
          if (!payload.connId) { toast.error(t('请选择连接')); return false; }
          if (!payload.db) { toast.error(t('请填写数据库名')); return false; }
          window.api.schedule.save(payload)
            .then(() => { toast.success(t('已保存')); onSaved(); })
            .catch((error) => toast.error(t('保存失败：') + (error && error.message ? error.message : error)));
          return true;
        },
      },
    ],
  });
}

export async function openScheduleDialog() {
  const listEl = el('div', { class: 'backup-list' });

  async function refresh() {
    let jobs = [];
    try { jobs = await window.api.schedule.list(); }
    catch (error) {
      toast.error(t('读取定时任务失败：') + (error && error.message ? error.message : error));
      return;
    }
    listEl.replaceChildren();
    if (!jobs.length) {
      listEl.append(el('div', { class: 'obj-placeholder' }, t('还没有定时任务。')));
      return;
    }
    for (const job of jobs) listEl.append(jobRow(job));
  }

  function jobRow(job) {
    const toggle = el('input', { type: 'checkbox' });
    toggle.checked = job.enabled;
    toggle.addEventListener('change', async () => {
      try { await window.api.schedule.save({ ...job, enabled: toggle.checked }); await refresh(); }
      catch (error) { toast.error(t('保存失败：') + (error && error.message ? error.message : error)); }
    });
    const statusText = job.lastStatus === 'failed'
      ? t('上次失败：{msg}', { msg: job.lastMessage })
      : (job.lastStatus === 'ok' ? t('上次成功：{msg}', { msg: job.lastMessage }) : t('尚未运行'));
    return el('div', { class: 'backup-item' + (job.lastStatus === 'failed' ? ' missing' : '') },
      el('div', { class: 'backup-line' },
        el('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } }, toggle),
        el('span', { class: 'backup-label' }, job.name),
        el('span', { class: 'task-conn' }, `${job.connName || ''} / ${job.db}`),
        el('span', { class: 'spring' }),
        el('button', {
          class: 'pbtn',
          onClick: async () => {
            toast.info(t('已开始执行…'));
            try { await window.api.schedule.runNow(job.id); await refresh(); toast.success(t('执行结束')); }
            catch (error) { toast.error(t('执行失败：') + (error && error.message ? error.message : error)); }
          },
        }, t('立即运行')),
        el('button', { class: 'pbtn', onClick: () => editJob(job, refresh) }, iconEl('edit'), t('编辑')),
        el('button', {
          class: 'pbtn',
          onClick: async () => {
            const ok = await confirmDialog(t('删除定时任务'),
              t('确定删除「{name}」？', { name: job.name }), { danger: true, okLabel: t('删除') });
            if (!ok) return;
            await window.api.schedule.remove(job.id);
            await refresh();
          },
        }, iconEl('trash'), t('删除'))),
      el('div', { class: 'backup-meta' },
        `${KINDS.find((k) => k[0] === job.kind)?.[1] || job.kind} · ${scheduleText(job)}`
        + (job.nextRunAt ? ` · ${t('下次 {time}', { time: fmtTime(new Date(job.nextRunAt).toISOString()) })}` : '')),
      el('div', { class: 'backup-meta' }, statusText));
  }

  const off = window.api.schedule.onChanged(() => refresh());
  await refresh();
  return openModal({
    title: t('定时任务'),
    width: 680,
    body: el('div', { class: 'settings-body' },
      el('div', { class: 'schedule-warning' },
        t('⚠ 定时任务只在 DBPanda 运行期间生效。关闭应用后不会执行，重新打开后按新的时间重新排期。')),
      el('div', { class: 'settings-group' },
        el('div', { class: 'settings-group-title' }, t('任务列表')),
        listEl,
        el('div', { class: 'backup-foot' },
          el('span', { class: 'spring' }),
          el('button', { class: 'btn primary', onClick: () => editJob(null, refresh) }, t('新建任务…'))))),
    buttons: [{ label: t('关闭'), primary: true }],
    onClose: () => off(),
  });
}
