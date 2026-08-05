// 任务中心标签页：正在跑什么、跑完了什么、为什么失败。
import { el, iconEl, fmtCount } from './util.js';
import { addTab } from './tabs.js';
import { toast, cellViewer } from './toast.js';
import { t } from './i18n.js';
import { allTasks, onTasksChange, cancelTask, clearFinished } from './taskCenter.js';

const TAB_ID = 'task-center';
const STATUS_TEXT = { running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消' };

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDuration(task) {
  const end = task.endedAt || Date.now();
  const seconds = Math.max(0, Math.round((end - task.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function taskRow(task) {
  const bar = task.status === 'running' && Number.isFinite(task.percent)
    ? el('div', { class: 'task-bar' }, el('div', { class: 'task-bar-fill', style: { width: `${task.percent}%` } }))
    : null;
  const message = task.status === 'failed' ? task.error
    : (task.status === 'running' ? (task.progress || t('准备中…')) : (task.summary || ''));

  const actions = el('div', { class: 'task-actions' });
  if (task.status === 'running' && task.cancel) {
    actions.append(el('button', {
      class: 'pbtn',
      onClick: async () => {
        const ok = await cancelTask(task.id);
        if (!ok) toast.info(t('该任务当前不支持取消'));
      },
    }, t('取消')));
  }
  if (task.status === 'failed' && task.error) {
    actions.append(el('button', {
      class: 'pbtn',
      onClick: () => cellViewer(t('失败详情'), `${task.title}\n\n${task.error}`, null),
    }, t('详情')));
  }

  return el('div', { class: `task-item task-${task.status}` },
    el('div', { class: 'task-line' },
      el('span', { class: `task-status task-status-${task.status}` }, t(STATUS_TEXT[task.status] || task.status)),
      el('span', { class: 'task-title' }, task.title),
      task.connName ? el('span', { class: 'task-conn' }, task.connName) : null,
      el('span', { class: 'spring' }),
      el('span', { class: 'task-time' }, `${fmtTime(task.startedAt)} · ${fmtDuration(task)}`),
      actions),
    message ? el('div', { class: 'task-msg' }, message) : null,
    bar);
}

export function openTaskTab() {
  // onClose 只能在 addTab 时登记，所以先留好占位，稍后再把真正的清理函数塞进去
  let unsubscribe = () => {};
  let timer = null;
  const tab = addTab({
    id: TAB_ID, title: t('任务中心'), icon: 'monitor', tooltip: t('长任务进度与历史'),
    onClose: () => { unsubscribe(); if (timer) clearInterval(timer); },
  });
  if (tab.pane.childElementCount) { if (tab._reload) tab._reload(); return tab; }

  const list = el('div', { class: 'task-list' });
  const countEl = el('span', { class: 'audit-count' });

  function render() {
    const tasks = allTasks();
    list.replaceChildren();
    if (!tasks.length) {
      list.append(el('div', { class: 'obj-placeholder' },
        t('还没有任务。数据传输、转储、同步、导入、SQL 文件执行、备份都会记录在这里，关掉对话框也不会中断。')));
    } else {
      for (const task of tasks) list.append(taskRow(task));
    }
    const running = tasks.filter((x) => x.status === 'running').length;
    countEl.textContent = running
      ? t('{r} 个运行中 · 共 {n} 条', { r: running, n: fmtCount(tasks.length) })
      : t('共 {n} 条', { n: fmtCount(tasks.length) });
  }
  tab._reload = render;

  unsubscribe = onTasksChange(render);
  // 运行中的任务要让耗时读数一直走字，否则看起来像卡住了
  timer = setInterval(() => { if (allTasks().some((x) => x.status === 'running')) render(); }, 1000);

  tab.pane.append(
    el('div', { class: 'pane-toolbar' },
      el('button', { class: 'pbtn', onClick: render }, iconEl('refresh'), t('刷新')),
      el('span', { class: 'sep' }),
      el('button', { class: 'pbtn', onClick: () => { clearFinished(); render(); } }, iconEl('trash'), t('清除已结束')),
      countEl),
    list,
  );
  render();
  return tab;
}
