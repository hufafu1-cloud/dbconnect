import { el } from './util.js';
import { openModal } from './toast.js';
import { getPreferences, loadPreferences, markNotificationsRead } from './preferences.js';

function relativeTime(at) {
  const s = Math.max(0, Math.floor((Date.now() - Number(at || 0)) / 1000));
  if (s < 60) return '刚刚'; if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(at).toLocaleString();
}
export async function openTaskCenter() {
  await loadPreferences();
  const list = el('div', { class: 'task-center-list' });
  const render = () => {
    const items = getPreferences().notifications || [];
    list.innerHTML = '';
    if (!items.length) list.append(el('div', { class: 'empty-state' }, '暂无任务或通知'));
    for (const item of items) list.append(el('div', { class: `task-item ${item.type || 'info'}` },
      el('div', { class: 'task-item-main' }, item.message),
      item.detail ? el('div', { class: 'task-item-detail' }, item.detail) : null,
      el('div', { class: 'task-item-time' }, relativeTime(item.at))));
  };
  render();
  const modal = openModal({ title: '任务中心', body: list, width: 560, buttons: [
    { label: '全部标为已读', onClick: async () => { await markNotificationsRead(); render(); return false; } },
    { label: '关闭', primary: true },
  ] });
  await markNotificationsRead();
  return modal;
}
