// 底部状态栏
import { $ } from './util.js';

export const statusbar = {
  setLeft(text) { $('#status-left').textContent = text || '就绪'; },
  setRight(text) { $('#status-right').textContent = text || ''; },
};
