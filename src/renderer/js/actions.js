// 共享动作：树右键菜单与对象列表工具栏共用
import { state, emit, connLabel, connById } from './state.js';
import { toast, confirmDialog, promptDialog } from './toast.js';
import { openTableTab } from './tableTab.js';
import { openStructTab } from './structTab.js';
import { openQueryTab } from './queryTab.js';
import { openDesignTab } from './designTab.js';
import { openImportWizard } from './importWizard.js';

export function openTable(target) { openTableTab(target); }
/** 表 → 可编辑设计器；视图 → 只读定义查看 */
export function designTable(target, isView) {
  if (isView) openStructTab(target);
  else openDesignTab(target);
}
export function newTable(target) {
  if (!target || !state.open.has(target.connId)) { toast.info('请先打开一个连接'); return; }
  openDesignTab({ connId: target.connId, db: target.db, schema: target.schema });
}
export function importTable(target) { openImportWizard(target); }

/** 打开保存在连接下的查询（绑定保存目标） */
export function openSavedQuery(target, sql, saved) {
  if (!target || !target.connId || !state.open.has(target.connId)) {
    toast.info('请先打开一个连接');
    return;
  }
  openQueryTab(target, sql, { saved });
}
export function newQuery(target, initialSql) {
  if (!target || !target.connId || !state.open.has(target.connId)) {
    toast.info('请先打开一个连接');
    return;
  }
  openQueryTab(target, initialSql);
}

function fullName(t) {
  return (t.schema ? t.schema + '.' : '') + t.table;
}

/** 破坏性操作确认：生产连接走「输入连接名」强确认，否则普通危险确认 */
async function confirmDestructive(connId, { title, message, okLabel, reason, sql }) {
  const c = connById(connId);
  if (c && c.env === 'prod') {
    const { confirmDangerExecution } = await import('./danger.js');
    return confirmDangerExecution(c.name, [{ level: 'high', reason, sql }], { title });
  }
  return confirmDialog(title, message, { danger: true, okLabel });
}

export async function dropTable(target, isView) {
  const kind = isView ? '视图' : '表';
  const ok = await confirmDestructive(target.connId, {
    title: `删除${kind}`,
    message: `确定要删除${kind} “${fullName(target)}” 吗？\n该操作不可撤销！`,
    okLabel: '删除',
    reason: `删除${kind}（DROP ${isView ? 'VIEW' : 'TABLE'}）`,
    sql: `DROP ${isView ? 'VIEW' : 'TABLE'} ${fullName(target)}`,
  });
  if (!ok) return;
  try {
    await window.api.db.action(target.connId, {
      action: isView ? 'dropView' : 'dropTable',
      db: target.db, schema: target.schema, table: target.table,
    });
    toast.success(`${kind} ${fullName(target)} 已删除`);
    emit('objects-changed', target);
  } catch (e) { toast.error(e.message); }
}

export async function truncateTable(target) {
  const ok = await confirmDestructive(target.connId, {
    title: '清空表',
    message: `确定要清空表 “${fullName(target)}” 的全部数据吗？\n该操作不可撤销！`,
    okLabel: '清空',
    reason: '清空表数据（TRUNCATE）',
    sql: `TRUNCATE TABLE ${fullName(target)}`,
  });
  if (!ok) return;
  try {
    await window.api.db.action(target.connId, { action: 'truncate', db: target.db, schema: target.schema, table: target.table });
    toast.success(`表 ${fullName(target)} 已清空`);
    emit('objects-changed', target);
  } catch (e) { toast.error(e.message); }
}

export async function renameTable(target) {
  const name = await promptDialog('重命名表', '新表名:', target.table);
  if (!name || name === target.table) return;
  try {
    await window.api.db.action(target.connId, { action: 'rename', db: target.db, schema: target.schema, table: target.table, newName: name });
    toast.success(`已重命名为 ${name}`);
    emit('objects-changed', target);
  } catch (e) { toast.error(e.message); }
}


export async function dropDatabase(target) {
  const ok = await confirmDestructive(target.connId, {
    title: '删除数据库',
    message: `确定要删除数据库 “${target.db}” 吗？\n库中所有对象都会被删除，该操作不可撤销！`,
    okLabel: '删除',
    reason: '删除数据库（DROP DATABASE）',
    sql: `DROP DATABASE ${target.db}`,
  });
  if (!ok) return;
  try {
    await window.api.db.action(target.connId, { action: 'dropDatabase', db: target.db });
    toast.success(`数据库 ${target.db} 已删除`);
    emit('databases-changed', { connId: target.connId });
  } catch (e) { toast.error(e.message); }
}

export async function createDatabase(connId) {
  const name = await promptDialog('新建数据库', '数据库名:');
  if (!name) return;
  try {
    await window.api.db.action(connId, { action: 'createDatabase', newName: name });
    toast.success(`数据库 ${name} 已创建`);
    emit('databases-changed', { connId });
  } catch (e) { toast.error(e.message); }
}

