// 底部状态栏
import { $ } from './util.js';
import { runningCount, onTasksChange } from './taskCenter.js';

export const statusbar = {
  setLeft(text) { $('#status-left').textContent = text || '就绪'; },
  setRight(text) { $('#status-right').textContent = text || ''; },
};

/**
 * 状态栏上的任务指示器：有任务在跑时才出现，点一下打开任务中心。
 * 这是「长任务可以后台跑」的关键——否则用户关掉对话框就再也找不到它了。
 */
export function setupTaskIndicator() {
  const button = $('#status-tasks');
  if (!button) return;
  button.addEventListener('click', async () => {
    const { openTaskTab } = await import('./taskTab.js');
    openTaskTab();
  });
  const sync = () => {
    const count = runningCount();
    button.hidden = count === 0;
    button.textContent = count ? `⏳ ${count} 个任务运行中` : '';
    button.title = '点击打开任务中心';
  };
  onTasksChange(sync);
  sync();
}
