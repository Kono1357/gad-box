/**
 * 分帧调度（M3 第 7 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 它解决的是什么问题
 * ────────────────────────────────────────────────────────────
 * 物理这一层有好几件**周期性但不紧急**的活：
 *
 * - 倒塌判定（连通性 BFS 是 O(n²)，500 个物体时一次几毫秒）
 * - 应力计算（遍历 + 排序全部建筑）
 * - 距离剔除 pass
 * - 支撑面索引重建
 * - 爆炸保护巡检
 *
 * 它们原来各自按固定的 300ms / 250ms 间隔跑。问题是**这些间隔会撞在一起** ——
 * 每隔若干帧就会出现一帧同时跑完所有重活，帧时间从 6ms 尖到 20ms，
 * 表现是"每隔半秒卡一下"，比平均帧率低更难忍。
 *
 * 分帧调度把它们的**执行预算**限制住：每帧最多花 N 毫秒在这些杂活上，
 * 到期的任务按"上次执行时间（越久没跑的越优先）"排序，超预算的推到下一帧。
 * 这样总工作量不变，但摊平了 —— 代价是某个任务的执行间隔偶尔会晚一帧（可接受）。
 *
 * ────────────────────────────────────────────────────────────
 * 两个刻意的设计
 * ────────────────────────────────────────────────────────────
 * 1. **所有任务共用同一个时间源**（调用方传入的 `nowMs`），任务自己不读时钟。
 *    否则每个任务各读各的，测试里根本没法复现调度顺序。
 * 2. **任务抛异常只影响它自己**：一个坏任务不该让整个调度器停摆 ——
 *    那会让物理的周期性维护全部静默失效，比报错更难查。
 */

export interface ScheduledTask {
  /** 稳定 id */
  id: string;
  /** 中文名（面板显示"哪个任务被推迟了"） */
  label: string;
  /** 期望的执行间隔（毫秒） */
  intervalMs: number;
  /** 任务本体；返回值无意义，抛异常会被捕获并计入失败统计 */
  run(nowMs: number): void;
  /**
   * 优先级：数值越小越优先。
   * 默认 0；把"漏一次就会出错"的任务设成负数（例如唤醒检查），
   * 把"晚一点没关系"的设成正数（例如应力可视化）。
   */
  priority?: number;
  /** 本任务单次执行的预算（毫秒），超过就记一次超预算 */
  budgetMs?: number;
}

export interface SchedulerRun {
  /** 本帧执行了哪些任务 */
  ran: { id: string; ms: number; overBudget: boolean }[];
  /** 本帧因为预算不够而推迟的任务 id */
  deferred: string[];
  /** 本帧总耗时 */
  spentMs: number;
  /** 是否用完了预算 */
  exhausted: boolean;
}

export interface SchedulerStats {
  taskCount: number;
  enabled: boolean;
  /** 每帧预算（毫秒） */
  budgetMs: number;
  /** 上一个 pass 的耗时 */
  lastSpentMs: number;
  /** 各任务的统计 */
  tasks: { id: string; label: string; runs: number; failures: number; averageMs: number; maxMs: number; lastRunMs: number }[];
  /** 累计推迟次数（这个数一直涨说明预算太紧） */
  deferredTotal: number;
}

interface TaskState {
  task: ScheduledTask;
  runs: number;
  failures: number;
  totalMs: number;
  maxMs: number;
  lastRunMs: number;
  lastError?: string;
}

export class FrameScheduler {
  private readonly states = new Map<string, TaskState>();
  private budgetValue: number;
  private enabledValue = true;
  private lastSpentMs = 0;
  private deferredTotal = 0;

  constructor(budgetMs = 2.5) {
    this.budgetValue = Math.max(0.5, budgetMs);
  }

  get budgetMs(): number {
    return this.budgetValue;
  }

  setBudget(budgetMs: number): void {
    this.budgetValue = Math.max(0.5, budgetMs);
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
  }

  add(task: ScheduledTask): void {
    this.states.set(task.id, {
      task,
      runs: 0,
      failures: 0,
      totalMs: 0,
      maxMs: 0,
      lastRunMs: Number.NEGATIVE_INFINITY,
    });
  }

  remove(id: string): boolean {
    return this.states.delete(id);
  }

  has(id: string): boolean {
    return this.states.has(id);
  }

  /**
   * 每帧调用。
   *
   * 排序规则：**先按优先级，再按"距上次执行的时间"**（越久没跑的越先跑）。
   * 这样即使预算一直很紧，也不会有任务被永远饿死。
   */
  tick(nowMs: number): SchedulerRun {
    const started = now();
    const ran: SchedulerRun['ran'] = [];
    const deferred: string[] = [];
    if (!this.enabledValue) {
      this.lastSpentMs = now() - started;
      return { ran, deferred, spentMs: this.lastSpentMs, exhausted: false };
    }

    const due: TaskState[] = [];
    for (const state of this.states.values()) {
      const interval = Math.max(0, state.task.intervalMs);
      if (nowMs - state.lastRunMs >= interval) due.push(state);
    }
    // 排序：先优先级，再"越久没跑越优先"。
    // 直接比较 `lastRunMs` 而不是算"欠了多久"，避免 `nowMs - (-Infinity)` 得到 Infinity
    // 之后相减产生 NaN（第一次 tick 时所有任务的 lastRunMs 都是 -Infinity）。
    due.sort((a, b) => {
      const priorityDiff = (a.task.priority ?? 0) - (b.task.priority ?? 0);
      if (priorityDiff !== 0) return priorityDiff;
      return a.lastRunMs - b.lastRunMs;
    });

    for (const state of due) {
      const spentSoFar = now() - started;
      // 预算用完了：本帧不再开新任务。**已经到期的任务不会丢**，下一帧会优先跑
      if (spentSoFar >= this.budgetValue) {
        deferred.push(state.task.id);
        this.deferredTotal += 1;
        continue;
      }

      const taskStarted = now();
      let failed = false;
      try {
        state.task.run(nowMs);
      } catch (error) {
        failed = true;
        state.lastError = error instanceof Error ? error.message : String(error);
        // 一个坏任务不该让整个调度器停摆 —— 那会让所有周期性维护静默失效
        console.warn(`[分帧调度] 任务「${state.task.label}」执行失败：${state.lastError}`);
      }
      const ms = now() - taskStarted;

      state.runs += 1;
      if (failed) state.failures += 1;
      state.totalMs += ms;
      if (ms > state.maxMs) state.maxMs = ms;
      state.lastRunMs = nowMs;

      const budget = state.task.budgetMs ?? this.budgetValue;
      ran.push({ id: state.task.id, ms, overBudget: ms > budget });
      if (ms > budget) {
        console.warn(
          `[分帧调度] 任务「${state.task.label}」单次耗时 ${ms.toFixed(2)} ms，超过它的预算 ${budget} ms`,
        );
      }
    }

    this.lastSpentMs = now() - started;
    return {
      ran,
      deferred,
      spentMs: this.lastSpentMs,
      exhausted: this.lastSpentMs >= this.budgetValue,
    };
  }

  get stats(): SchedulerStats {
    const tasks: SchedulerStats['tasks'] = [];
    for (const state of this.states.values()) {
      tasks.push({
        id: state.task.id,
        label: state.task.label,
        runs: state.runs,
        failures: state.failures,
        averageMs: state.runs > 0 ? state.totalMs / state.runs : 0,
        maxMs: state.maxMs,
        lastRunMs: Number.isFinite(state.lastRunMs) ? state.lastRunMs : -1,
      });
    }
    return {
      taskCount: this.states.size,
      enabled: this.enabledValue,
      budgetMs: this.budgetValue,
      lastSpentMs: this.lastSpentMs,
      tasks,
      deferredTotal: this.deferredTotal,
    };
  }

  /** 面板用：一行中文摘要 */
  describe(): string {
    if (!this.enabledValue) return '分帧调度：已关闭（每个任务各按自己的间隔跑）';
    const stats = this.stats;
    const worst = stats.tasks.reduce((max, task) => Math.max(max, task.maxMs), 0);
    return (
      `分帧调度：${stats.taskCount} 个任务共用每帧 ${stats.budgetMs} ms 预算｜` +
      `上一帧用了 ${stats.lastSpentMs.toFixed(2)} ms｜单次最长 ${worst.toFixed(2)} ms｜` +
      `累计推迟 ${stats.deferredTotal} 次${stats.deferredTotal > 200 ? '（预算可能太紧）' : ''}`
    );
  }

  reset(): void {
    for (const state of this.states.values()) {
      state.runs = 0;
      state.failures = 0;
      state.totalMs = 0;
      state.maxMs = 0;
      state.lastRunMs = Number.NEGATIVE_INFINITY;
    }
    this.lastSpentMs = 0;
    this.deferredTotal = 0;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
