// 命令注册表：全应用唯一的「功能表」。
//
// 菜单栏、工具栏、键盘快捷键（以及后续的命令面板）都从这里读取，
// 新增一个功能只需要在 app.js 里登记一条，不必再分别去改菜单、工具栏和键盘监听——
// 也就不会再出现「菜单上标着 Ctrl+H，按下去没反应」这类对不上的情况。
//
// 一条命令的字段：
//   id        唯一标识，如 'new-query'
//   label     菜单/命令面板里显示的名字
//   menu      归属的顶层菜单名；不填则不进菜单（例如只给工具栏或快捷键用）
//   order     菜单内排序（升序）
//   sepBefore 该项之前插入一条分隔线
//   accel     快捷键文本，如 'Ctrl+Shift+F'、'F5'
//   bind      是否由本注册表做全局键盘绑定。CodeMirror 或浏览器自己处理的快捷键
//             （Ctrl+Z、编辑器内的 Ctrl+F）设为 false：菜单照样显示提示，但不重复绑定
//   scope     'global' 到处生效 | 'notInInput' 输入框内不触发 | 'notInEditor' SQL 编辑器内不触发
//   enabled   () => boolean，不填视为始终可用
//   run       (ctx) => void|Promise，ctx 由 setCommandContextProvider 提供

const registry = new Map();
const menuOrder = [];
let contextProvider = () => ({});

/** 'Ctrl+Shift+F' → { ctrl:true, shift:true, alt:false, key:'f' } */
export function parseAccel(accel) {
  const out = { ctrl: false, shift: false, alt: false, key: '' };
  if (!accel) return out;
  for (const raw of String(accel).split('+')) {
    const part = raw.trim();
    if (!part) continue;
    const low = part.toLowerCase();
    if (low === 'ctrl' || low === 'control') out.ctrl = true;
    else if (low === 'shift') out.shift = true;
    else if (low === 'alt') out.alt = true;
    else out.key = low;
  }
  return out;
}

export function registerCommands(list) {
  for (const cmd of list || []) {
    if (!cmd || !cmd.id) continue;
    if (registry.has(cmd.id)) throw new Error(`命令 ID 重复注册: ${cmd.id}`);
    const entry = { scope: 'global', bind: true, order: registry.size, ...cmd };
    // 记下出厂键位与作用域，切换键位方案时可以原样还原
    entry.defaultAccel = entry.accel || '';
    entry.defaultScope = entry.scope;
    registry.set(cmd.id, entry);
    if (cmd.menu && !menuOrder.includes(cmd.menu)) menuOrder.push(cmd.menu);
  }
}

/**
 * 套用一套键位方案。overrides 形如：
 *   { refresh: 'F5' }                              // 只改键位
 *   { refresh: { accel: 'F5', scope: 'global' } }  // 同时改作用域
 *   { 'goto-table': null }                         // 取消该命令的快捷键
 * 没有出现在 overrides 里的命令一律还原为出厂设置，所以切来切去不会残留。
 */
export function applyKeymap(overrides = {}) {
  for (const cmd of registry.values()) {
    const has = Object.prototype.hasOwnProperty.call(overrides, cmd.id);
    if (!has) {
      cmd.accel = cmd.defaultAccel;
      cmd.scope = cmd.defaultScope;
      continue;
    }
    const value = overrides[cmd.id];
    if (value === null || value === undefined) {
      cmd.accel = '';
      cmd.scope = cmd.defaultScope;
    } else if (typeof value === 'string') {
      cmd.accel = value;
      cmd.scope = cmd.defaultScope;
    } else {
      cmd.accel = value.accel || '';
      cmd.scope = value.scope || cmd.defaultScope;
    }
  }
}

// 每种作用域实际会生效的焦点场景。
// 'plain'  焦点在树/网格等普通区域   'input' 普通输入框内   'editor' SQL 编辑器内
const SCOPE_CONTEXTS = {
  global: ['plain', 'input', 'editor'],
  notInInput: ['plain'],
  notInEditor: ['plain', 'input'],
};

function scopeContexts(scope) {
  return SCOPE_CONTEXTS[scope] || SCOPE_CONTEXTS.global;
}

/**
 * 找出会互相抢键的命令：同一个快捷键，且**生效场景有交集**。
 *
 * 注意作用域并不能用来「错开」两个命令——现有三种作用域在焦点位于树/网格时
 * 都会生效，所以同键必冲突。真正错开编辑器内外的机制是 bind:false
 * （例如编辑器里的 Ctrl+F 交给 CodeMirror，不参与全局绑定）。
 *
 * 返回 [{ accel, ids }]，空数组表示没有冲突。
 */
export function accelConflicts() {
  const bound = [...registry.values()].filter((cmd) => cmd.accel && cmd.bind !== false);
  const byAccel = new Map();
  for (const cmd of bound) {
    const key = cmd.accel.toLowerCase();
    if (!byAccel.has(key)) byAccel.set(key, []);
    byAccel.get(key).push(cmd);
  }
  const conflicts = [];
  for (const [accel, cmds] of byAccel) {
    if (cmds.length < 2) continue;
    const clashing = new Set();
    for (let i = 0; i < cmds.length; i++) {
      for (let j = i + 1; j < cmds.length; j++) {
        const a = scopeContexts(cmds[i].scope);
        const b = scopeContexts(cmds[j].scope);
        if (a.some((ctx) => b.includes(ctx))) {
          clashing.add(cmds[i].id);
          clashing.add(cmds[j].id);
        }
      }
    }
    if (clashing.size) conflicts.push({ accel, ids: [...clashing] });
  }
  return conflicts;
}

/** 由 app.js 注入：每次执行命令时构造一份上下文（当前连接/库等） */
export function setCommandContextProvider(fn) {
  contextProvider = typeof fn === 'function' ? fn : () => ({});
}

export function getCommand(id) {
  return registry.get(id) || null;
}

export function allCommands() {
  return [...registry.values()];
}

/** 顶层菜单名，按首次登记顺序 */
export function menuNames() {
  return [...menuOrder];
}

/** 某个顶层菜单下的命令，按 order 升序 */
export function commandsForMenu(name) {
  return [...registry.values()]
    .filter((cmd) => cmd.menu === name)
    .sort((a, b) => a.order - b.order);
}

export function isEnabled(cmd) {
  const c = typeof cmd === 'string' ? registry.get(cmd) : cmd;
  if (!c) return false;
  if (typeof c.enabled !== 'function') return true;
  try { return !!c.enabled(); } catch (e) { return false; }
}

/** 快捷键提示文本；没有快捷键时返回空串（菜单里就不显示右侧提示） */
export function accelHint(cmd) {
  const c = typeof cmd === 'string' ? registry.get(cmd) : cmd;
  return (c && c.accel) || '';
}

export async function runCommand(id) {
  const cmd = registry.get(id);
  if (!cmd || typeof cmd.run !== 'function') return false;
  await cmd.run(contextProvider());
  return true;
}

/**
 * 找到与本次按键匹配的命令。
 * ctx: { inEditor, inInput } —— 由调用方根据事件目标判断。
 */
export function matchShortcut(event, ctx = {}) {
  const key = String(event.key || '').toLowerCase();
  if (!key) return null;
  for (const cmd of registry.values()) {
    if (!cmd.accel || cmd.bind === false) continue;
    const a = parseAccel(cmd.accel);
    if (!a.key || a.key !== key) continue;
    if (a.ctrl !== !!event.ctrlKey) continue;
    if (a.shift !== !!event.shiftKey) continue;
    if (a.alt !== !!event.altKey) continue;
    if (cmd.scope === 'notInEditor' && ctx.inEditor) continue;
    if (cmd.scope === 'notInInput' && ctx.inInput) continue;
    // 注意：这里刻意不看 enabled()。enabled 只决定菜单/工具栏的「灰不灰」，
    // 快捷键照样触发，由命令自己给出「请先打开一个连接」之类的提示——
    // 比按了没反应更容易理解，也和改造前的行为一致。
    return cmd;
  }
  return null;
}

/** 仅供测试/自检使用：清空注册表 */
export function __resetCommands() {
  registry.clear();
  menuOrder.length = 0;
  contextProvider = () => ({});
}
