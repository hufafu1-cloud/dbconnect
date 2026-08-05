// 任务中心：长任务的统一登记处。
//
// 在此之前，传输 / 转储 / 同步 / 导入 / SQL 文件执行各自在自己的对话框里显示进度，
// 对话框一关就什么都看不见了——而任务本身是在主进程跑的，关掉对话框它还在继续。
// 这里把它们收成一份中心列表：状态栏随时能看到「N 个任务运行中」，
// 任务中心标签页能看到历史与失败原因。
//
// 只做登记与展示，不接管执行：任务照旧由各自的 IPC 通道驱动，
// 调用方在开始/进度/结束时通知这里即可。

const tasks = [];              // 新的在前
const listeners = new Set();
const MAX_TASKS = 200;         // 只保留最近这么多条，避免长期运行后无限增长
let seq = 0;

function emit() {
  for (const cb of listeners) {
    try { cb(); } catch (error) { console.error('[task] 订阅回调出错:', error); }
  }
}

function trim() {
  // 超出上限时丢最老的**已结束**任务；运行中的任务永远保留，哪怕因此超出上限
  while (tasks.length > MAX_TASKS) {
    const index = tasks.findLastIndex((task) => task.status !== 'running');
    if (index < 0) break;
    tasks.splice(index, 1);
  }
}

/**
 * 登记一个长任务。返回的句柄用于上报进度与结果。
 * options.cancel 传入后，任务中心会显示「取消」按钮。
 */
export function startTask({ title, kind = 'task', connName = '', detail = '', cancel = null } = {}) {
  const task = {
    id: `task-${++seq}`,
    title: title || '任务',
    kind,
    connName,
    detail,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    progress: '',
    percent: null,
    error: null,
    summary: '',
    cancel,
  };
  tasks.unshift(task);
  trim();
  emit();

  const finish = (status, fields) => {
    if (task.status !== 'running') return;
    task.status = status;
    task.endedAt = Date.now();
    task.cancel = null;
    Object.assign(task, fields);
    emit();
  };

  return {
    id: task.id,
    /** text 是给人看的一句话；percent 有就显示进度条 */
    progress(text, percent) {
      if (task.status !== 'running') return;
      if (text !== undefined && text !== null) task.progress = String(text);
      if (Number.isFinite(percent)) task.percent = Math.max(0, Math.min(100, percent));
      emit();
    },
    done(summary) { finish('done', { summary: summary || '', progress: '', percent: 100 }); },
    fail(error) {
      finish('failed', { error: (error && error.message) || String(error || '未知错误'), percent: null });
    },
    cancelled(reason) { finish('cancelled', { summary: reason || '已取消', percent: null }); },
  };
}

export function allTasks() {
  return tasks.map((task) => ({ ...task }));
}

export function runningTasks() {
  return tasks.filter((task) => task.status === 'running');
}

export function runningCount() {
  return runningTasks().length;
}

/** 取消某个任务（仅当登记时提供了 cancel 回调） */
export async function cancelTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task || task.status !== 'running' || typeof task.cancel !== 'function') return false;
  try { await task.cancel(); return true; }
  catch (error) { console.error('[task] 取消失败:', error); return false; }
}

/** 清掉已结束的任务；运行中的不动 */
export function clearFinished() {
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i].status !== 'running') tasks.splice(i, 1);
  }
  emit();
}

export function onTasksChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * 把一次 DBA 操作包成任务：自动接管 dba:progress、自动结束与报错。
 * describe(payload) 把原始进度对象翻译成一句人话（各操作的字段不一样）。
 */
export async function runAsTask({ title, kind, connName, detail, cancel, describe }, work) {
  const task = startTask({ title, kind, connName, detail, cancel });
  const off = window.api.dba.onProgress((payload) => {
    if (!payload) return;
    const text = describe ? describe(payload) : '';
    const percent = Number.isFinite(payload.total) && payload.total > 0 && Number.isFinite(payload.done)
      ? (payload.done / payload.total) * 100
      : undefined;
    task.progress(text, percent);
  });
  try {
    const result = await work(task);
    task.done(typeof result === 'string' ? result : '');
    return result;
  } catch (error) {
    task.fail(error);
    throw error;
  } finally {
    off();
  }
}
