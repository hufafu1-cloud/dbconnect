// 快捷键方案。
//
// 单独成一个模块是为了让 app.js（注册命令）和 queryTab.js（SQL 编辑器键位）
// 都能读到，而不用互相 import 形成环。
//
// overrides 的取值形式见 commands.js 的 applyKeymap()：
//   'Ctrl+R'                            只改键位
//   { accel: 'F5', scope: 'global' }    同时改作用域
//   null                                取消该命令的快捷键
// 没写进 overrides 的命令一律还原为出厂键位，来回切换不会残留。
import { getSetting } from './settings.js';

export const KEYMAPS = {
  dbpanda: {
    label: 'DBPanda（默认）',
    hint: '编辑器内 F5 执行当前语句，编辑器外 F5 刷新对象。',
    overrides: {},
    editorF5: 'run',
  },
  navicat: {
    label: 'Navicat 兼容',
    hint: 'F5 统一为刷新；执行用 Ctrl+R 或 Ctrl+Enter。',
    overrides: {
      // Navicat 里 F5 到哪儿都是刷新。SQL 编辑器的 F5 会放行给全局处理，
      // 所以这里必须把作用域从 notInEditor 放开到 global，否则按下去没反应。
      refresh: { accel: 'F5', scope: 'global' },
    },
    editorF5: 'refresh',
  },
};

export const DEFAULT_KEYMAP = 'dbpanda';

export function keymapNames() {
  return Object.keys(KEYMAPS);
}

export function activeKeymap() {
  return KEYMAPS[getSetting('keymap')] || KEYMAPS[DEFAULT_KEYMAP];
}

/** SQL 编辑器里的 F5 是否执行查询；false 表示放行给全局的「刷新对象」 */
export function editorRunsOnF5() {
  return activeKeymap().editorF5 === 'run';
}
