// 多连接并发执行器（v2.7.0 共用地基，路线图 M1）
//
// 广播执行（M2）是「并发在 N 个库跑同一条 SQL」，联邦查询（M4）是「并发从 N 个源取数」——
// 两者的调度需求完全一样：并发上限、逐任务超时隔离、统一取消、错误归集。
// 所以调度逻辑收在这里一处，上层只提供「一个任务怎么跑」。
//
// 四条设计约束，都是踩过的坑倒推出来的：
//
// 1. **一个任务失败不影响其它任务。** 结果按任务归集成 {ok,error}，绝不 Promise.all 一挂全挂。
//    某个库连不上是常态（网络抖动、实例重启），不能让它废掉整批。
//
// 2. **超时是逐任务的，不是整批的。** 整批超时会让「31 个库很快、1 个库很慢」变成全部失败。
//    超时后除了不再等待，还要 abort 该任务的 signal，让适配器有机会真正取消服务端语句——
//    只停止等待而不取消，语句会继续在服务端跑到自然结束（TiDB 的「停止查询」就踩过这个）。
//
// 3. **取消要能穿透到底，而且不能被任务拖着。** cancel() 之后：排队中的任务不再启动，
//    运行中的任务收到 abort，**批次立刻不再等它们**。
//    只 abort 不停止等待是不够的——驱动如果不理会取消信号，整批就会挂到天荒地老。
//    所以 abort 之后 race 掉，让批次先返回；那些任务在后台自行收尾。
//    任务自己负责把 signal 接到适配器的 cancelOperation 上，让服务端也真的停下来。
//
// 4. **进度是逐任务上报的。** 上层要能显示「32 个库已完成 7 个」，而不是跑完才出结果。
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 32;
const MAX_TASKS = 512;

class MultiExecCancelled extends Error {
  constructor(reason) {
    super(reason || '操作已取消');
    this.name = 'MultiExecCancelled';
    this.cancelled = true;
  }
}

class MultiExecTimeout extends Error {
  constructor(ms) {
    super(`任务超时（超过 ${ms} 毫秒未返回）`);
    this.name = 'MultiExecTimeout';
    this.timedOut = true;
  }
}

const clampConcurrency = (value) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, n);
};

/**
 * 一次并发批次。
 *
 * 刻意做成对象而不是纯函数：取消需要一个能从外部（IPC 的取消通道）抓住的句柄，
 * 而批次本身可能还在 await 中。
 */
class MultiRun {
  constructor(opts = {}) {
    this.concurrency = clampConcurrency(opts.concurrency);
    // 0 表示不设超时：数据传输这类任务本来就可能跑很久，硬塞一个超时反而是伤害
    this.taskTimeoutMs = Math.max(0, Number(opts.taskTimeoutMs) || 0);
    this.stopOnError = !!opts.stopOnError;
    this._cancelled = false;
    this._cancelReason = '';
    this._controllers = new Set();
  }

  get cancelled() { return this._cancelled; }

  /** 取消：排队中的不再启动，运行中的收到 abort */
  cancel(reason) {
    if (this._cancelled) return;
    this._cancelled = true;
    this._cancelReason = reason || '操作已取消';
    for (const controller of this._controllers) {
      try { controller.abort(new MultiExecCancelled(this._cancelReason)); } catch (e) { /* 已 abort */ }
    }
    this._controllers.clear();
  }

  /**
   * 跑一批任务。
   *
   * tasks: [{ key, label?, run: async ({ signal, key, label }) => data }]
   * 返回 { results, ok, failed, cancelled, ms }，results 与 tasks 顺序一致。
   *
   * **本方法不抛异常**（除非参数本身非法）：任何任务错误都归集进 results，
   * 由调用方决定是整体失败还是部分展示。
   */
  async run(tasks, opts = {}) {
    const list = Array.isArray(tasks) ? tasks : [];
    if (list.length > MAX_TASKS) throw new Error(`并发任务数超过上限 ${MAX_TASKS}`);
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const startedAt = Date.now();
    const results = new Array(list.length);
    let done = 0;
    let cursor = 0;

    const report = (index) => {
      if (!onProgress) return;
      try {
        onProgress({
          done, total: list.length,
          key: results[index] && results[index].key,
          label: results[index] && results[index].label,
          ok: results[index] && results[index].ok,
          error: results[index] && results[index].error,
        });
      } catch (e) { /* 进度回调不该影响执行 */ }
    };

    const runOne = async (index) => {
      const task = list[index];
      const key = task && task.key !== undefined ? task.key : index;
      const label = (task && task.label) || String(key);
      const taskStartedAt = Date.now();
      const base = { key, label, index };
      if (this._cancelled) {
        results[index] = { ...base, ok: false, cancelled: true, error: this._cancelReason, ms: 0 };
        done++; report(index);
        return;
      }
      const controller = new AbortController();
      this._controllers.add(controller);
      let timer = null;
      try {
        const work = Promise.resolve().then(() => task.run({
          signal: controller.signal, key, label,
        }));
        // race 掉之后 work 仍可能 reject，挂个空 catch 免得变成未处理的拒绝
        work.catch(() => {});
        // 被 abort（取消或超时）时立刻不再等待。任务本身在后台自行收尾——
        // 它已经收到 signal，接了 cancelOperation 的适配器会去停服务端的语句。
        const aborted = new Promise((_resolve, reject) => {
          const signal = controller.signal;
          const stop = () => reject(signal.reason || new MultiExecCancelled(this._cancelReason));
          if (signal.aborted) stop();
          else signal.addEventListener('abort', stop, { once: true });
        });
        aborted.catch(() => {});
        const racers = [work, aborted];
        if (this.taskTimeoutMs > 0) {
          racers.push(new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
              const err = new MultiExecTimeout(this.taskTimeoutMs);
              // 先 abort 再 reject：让适配器有机会真正取消服务端语句，
              // 否则我们只是不再等待，语句仍在服务端跑到自然结束。
              try { controller.abort(err); } catch (e) { /* 已 abort */ }
              reject(err);
            }, this.taskTimeoutMs);
          }));
        }
        const data = await Promise.race(racers);
        results[index] = { ...base, ok: true, data, ms: Date.now() - taskStartedAt };
      } catch (err) {
        results[index] = {
          ...base,
          ok: false,
          error: (err && err.message) || String(err),
          cancelled: !!(err && err.cancelled) || this._cancelled,
          timedOut: !!(err && err.timedOut),
          ms: Date.now() - taskStartedAt,
        };
        if (this.stopOnError && !results[index].cancelled) this.cancel('前序任务失败，已停止后续任务');
      } finally {
        if (timer) clearTimeout(timer);
        this._controllers.delete(controller);
      }
      done++;
      report(index);
    };

    const worker = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= list.length) return;
        await runOne(index);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, list.length) }, () => worker()),
    );

    // 已取消时，尚未被 worker 领走的任务不会有 results 记录，这里补齐，
    // 保证 results 与 tasks 一一对应——调用方按下标取结果是最自然的用法。
    for (let i = 0; i < list.length; i++) {
      if (results[i]) continue;
      const task = list[i];
      results[i] = {
        key: task && task.key !== undefined ? task.key : i,
        label: (task && task.label) || String(i),
        index: i,
        ok: false,
        cancelled: true,
        error: this._cancelReason || '操作已取消',
        ms: 0,
      };
    }

    const failed = results.filter((item) => !item.ok);
    return {
      results,
      ok: failed.length === 0,
      failed: failed.length,
      cancelled: this._cancelled,
      ms: Date.now() - startedAt,
    };
  }
}

// ---- 取消令牌注册表 ----
// IPC 的取消调用与发起调用是两次独立的 invoke，中间需要一个能对上号的句柄。
// 与 base.js 的 requestId 同款做法：令牌由渲染进程给出，主进程按 sender 加前缀后使用。
const runs = new Map();

function createRun(opts = {}) {
  const run = new MultiRun(opts);
  const token = opts.token ? String(opts.token) : null;
  if (token) {
    // 同一个令牌重复发起时，先取消旧的：否则旧批次会成为无人可取消的孤儿
    const previous = runs.get(token);
    if (previous) previous.cancel('同一令牌发起了新的批次');
    runs.set(token, run);
    run._token = token;
  }
  return run;
}

function releaseRun(run) {
  if (run && run._token && runs.get(run._token) === run) runs.delete(run._token);
}

/** 按令牌取消；令牌不存在返回 false（批次可能已经跑完） */
function cancelRun(token, reason) {
  const run = runs.get(String(token || ''));
  if (!run) return false;
  run.cancel(reason);
  return true;
}

/** 一次性用法：不需要外部取消时用它，省去 create/release 的样板 */
async function runAll(tasks, opts = {}) {
  const run = createRun(opts);
  try {
    return await run.run(tasks, opts);
  } finally {
    releaseRun(run);
  }
}

module.exports = {
  MultiRun, MultiExecCancelled, MultiExecTimeout,
  createRun, releaseRun, cancelRun, runAll,
  DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MAX_TASKS,
};
