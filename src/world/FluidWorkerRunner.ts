/**
 * 粒子流体求解的 Worker 执行器（M4 第 7 批：把 PBF 求解搬离主线程）。
 *
 * ────────────────────────────────────────────────────────────
 * 它要解决什么
 * ────────────────────────────────────────────────────────────
 * 流体求解是**每帧**都要跑的一段纯 CPU 计算：读粒子池、建空间哈希、算密度与压力、
 * 做边界碰撞、更新速度。它不写世界、不碰渲染、不需要 DOM —— 正是最适合搬进 Worker 的那一类。
 * 搬走之后主线程省下的是"这一段的耗时"，代价是每帧的搬运与一次异步等待。
 *
 * **粒子池的写入仍然留在主线程**（`applyFluidCoupling` 读的就是它），
 * 这里只把"求解"这一段搬走，然后把位置/速度写回同一个池子。
 *
 * ────────────────────────────────────────────────────────────
 * 结果与同步路径逐位一致 —— 但有一个前提，必须说清楚
 * ────────────────────────────────────────────────────────────
 * 做得到的部分：
 * 1. **同一份实现**：worker 里 `new PBFSolver(...)` 与主线程回退路径是同一个类，
 *    没有任何"worker 专用版本"；连 settings 的覆盖都用同一个 `copySettingsInto`；
 * 2. **同一份边界语义**：快照解出来的 `isSolid` 与真实边界逐点一致（有全量比对断言兜底）；
 * 3. **同一批粒子下标**：搬运包只装 `[0, highWater)`，worker 侧按同样的下标逐位还原
 *    （空闲链表是私有的，只能靠"clear + 顺序 spawn + kill 死粒子"做到）；
 * 4. **同一个 dt 与同样的子步切分**：都由 `PBFSolver.step` 自己算。
 * 这四条一起保证了：**只要所有子步都跑完，两条路径产出的 Float32Array 逐位相同**
 * （有断言直接比对位模式）。
 *
 * 做不到的部分（这是 `PBFSolver.step` 自身的性质，不是这次搬运引入的）：
 * `step(dt, boundary, budgetMs)` 会在**子步之间**看墙上时钟 `now()`，超预算就少跑几个子步。
 * 两条路径跑在不同的线程上、时钟不同、当时负载也不同，所以**预算一旦被触到，
 * 子步数就可能不同**，结果自然不同。因此：
 * - 原子性基准（逐位一致）对应的输入是"预算不构成约束"；
 * - 需要严格可复现时，调用方应把 `budgetMs` 传 `Number.POSITIVE_INFINITY`
 *   （求解在 worker 上跑，阻塞的也不是主线程 —— 这恰恰是搬运的主要收益之一）。
 * 这两句话在断言里各有一条对应的检查，而不是只写在注释里。
 *
 * ────────────────────────────────────────────────────────────
 * 降级不是错误，但绝不允许"偷偷用主线程却报成 worker"
 * ────────────────────────────────────────────────────────────
 * 任何一步出问题（环境没有 `Worker`、构造抛错、`onerror`、超时、回包 `ok: false`、
 * 回包形状不合法、等待期间粒子池被改动）都**静默降级**到主线程同步路径，
 * 并把中文原因写进 `fallbackReason`。`source` 永远如实反映"结果是谁算出来的"：
 * 用 worker 时 `fallbackReason` 必须是 `null`，走回退时必须是**非空**中文。
 * 这两个字段的自洽性是 UI 能看出差别的唯一依据。
 */

import type { FluidBoundary, PBFSettings, PBFStats } from '../fluid/PBFSolver';
import { PBFSolver } from '../fluid/PBFSolver';
import type { ParticlePool } from '../fluid/ParticlePool';
import {
  applyPoolDelta,
  copySettingsInto,
  isFluidResponse,
  packBoundary,
  packPool,
} from '../workers/fluidWorkerCore';
import type {
  FluidBoundarySnapshot,
  FluidBoundarySource,
  FluidCancelRequest,
  FluidObstacleBox,
  FluidPoolBuffers,
  FluidResponse,
  FluidStepRequest,
  FluidWorkerStats,
} from '../workers/fluidWorkerTypes';

export interface FluidWorkerResult {
  /** 结果来自 worker 还是同步回退 —— 必须如实暴露，UI 上要能看出差别 */
  source: 'worker' | 'main-thread';
  /** 走回退时的中文原因；用 worker 时为 null */
  fallbackReason: string | null;
  simulatedSeconds: number;
  ms: number;
  substeps: number;
}

/**
 * 搬运成本台账。
 *
 * 为什么单独暴露而不是塞进 `FluidWorkerResult`：任务书把 `FluidWorkerResult` 的字段定死了，
 * 而"这次搬运花了多少钱"是诊断信息，不该混进结果契约里。
 *
 * **没走 worker 路径时这些字段一律是 `null`，不是 0** —— "没有打包"与"打包花了 0 ms"
 * 是两件事，把后者写进面板会让人以为搬运不要钱。
 */
export interface FluidWorkerCost {
  /** 打包边界快照（全世界体素扫一趟）花了多少毫秒；复用了缓存时为 null */
  boundaryPackMs: number | null;
  /** 这一次是否直接复用了上次的边界快照（地形与障碍都没变） */
  boundaryPackReused: boolean;
  /** 边界快照的字节数（solidBits + obstacleBounds） */
  boundaryBytes: number | null;
  /** 打包粒子池（复制 8 个数组）花了多少毫秒 */
  poolPackMs: number | null;
  /** 单次搬运的粒子数据字节数（去程 8 个数组） */
  poolBytes: number | null;
  /** 从 postMessage 到收到回包（或超时/取消）的毫秒数 */
  waitMs: number | null;
  /** 把回包数组写回主线程粒子池花了多少毫秒 */
  applyMs: number | null;
}

/** 默认超时：4000 ms。求解是毫秒级的活，超过 4 秒基本可以判定 worker 卡住或已经死了 */
export const DEFAULT_FLUID_TIMEOUT_MS = 4000;

export interface FluidWorkerRunnerOptions {
  timeoutMs?: number;
  /**
   * 可打包的边界来源（地形网格 + 建筑障碍）。
   *
   * 为什么需要这个回调：`FluidBoundary` 是一个**闭包对象**，
   * `Engine.fluidBoundary()` 返回的 `isSolid` 把网格和建筑索引全关在里面，
   * 外面拿不到、也克隆不了。所以由调用方额外提供一个"能打包的那一份描述"。
   * 不提供（且 `boundary` 自身也不带 `grid` + `obstacles`）时，
   * 执行器**拒绝**走 worker 并如实回退 —— 见 `resolveBoundarySource` 的注释。
   */
  boundarySource?: () => FluidBoundarySource | null | undefined;
}

/** worker 任务的结局（全部用值表达，不用 reject —— 避免"没人接的 rejection"） */
type WorkerOutcome =
  | { kind: 'response'; response: FluidResponse }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'transport-error'; message: string };

interface PendingRun {
  id: number;
  finish(outcome: WorkerOutcome): void;
}

/**
 * "这一次能不能走 worker"的判定结果。
 *
 * 单独做成一个可导出的纯函数，是为了让**拒绝策略本身**可测：
 * Node 里没有 `Worker`，`run()` 会在更早的一步（环境检查）就回退，
 * 于是"边界不可打包时我们是明确拒绝的"这条策略在 Node 里根本观察不到 ——
 * 而它恰恰是本轮最该被钉死的一条（"偷偷缩小能力"就藏在这里）。
 */
export type FluidBoundaryResolve =
  | { ok: true; source: FluidBoundarySource }
  | { ok: false; reason: string };

/**
 * 判定一个"边界来源候选"能不能打包。
 *
 * ────────────────────────────────────────────────────────────
 * 这里就是**明确拒绝**走 worker 的地方，理由必须站得住
 * ────────────────────────────────────────────────────────────
 * `FluidBoundary` 只有 `isSolid` 这个闭包 + 四个标量。闭包不可克隆，
 * 而"闭包里到底关了什么"在 JS 里**读不出来**。所以只搬四个标量、
 * 拿一份没有建筑的地形去求解，等于让水穿过所有建筑 —— 结果与同步路径不同，
 * 却会被报成 `source: 'worker'`。这比"慢一点"严重得多，所以这里选择拒绝：
 * 拿不到完整的可打包来源就回退，并把原因写清楚。
 */
export function classifyFluidBoundarySource(candidate: unknown): FluidBoundaryResolve {
  if (isPackableSource(candidate)) return { ok: true, source: candidate };
  // "像不像一个网格"要按**网格自己的成员**判断（`getChunk` / `chunkList`），
  // 不能用 `'grid' in candidate`：VoxelGrid 上并没有一个叫 grid 的字段，
  // 那样写会把"裸网格"错判成"乱七八糟的对象"，于是拒绝理由是错的 ——
  // 拒绝是对的，理由错了等于没查出来问题。两种形态都收进来，只为了给出准确的中文原因。
  const looksLikeGrid =
    candidate !== null &&
    typeof candidate === 'object' &&
    (typeof (candidate as Record<string, unknown>)['getChunk'] === 'function' ||
      'grid' in candidate);
  if (looksLikeGrid) {
    return {
      ok: false,
      reason:
        '边界来源只给了地形网格、没有给出建筑障碍（obstacles）：只搬地形等于让水穿过建筑，' +
        '这是偷偷缩小能力，拒绝走 worker，改走主线程同步路径',
    };
  }
  return {
    ok: false,
    reason:
      '拿不到可打包的边界来源：FluidBoundary 是一个闭包，无法克隆。请用 options.boundarySource 提供 ' +
      '{ grid, obstacles }，或让 boundary 自带这两个字段，改走主线程同步路径',
  };
}

/**
 * 当前环境能不能用 Web Worker。
 *
 * Node 里是 `false`：Node 的 `worker_threads` **不是**浏览器 Worker（模块格式、
 * 消息协议、全局作用域都不同），本项目一行都不用，所以这里如实回答"不可用"，
 * 让 `FluidWorkerRunner` 走同步回退 —— 这也是断言要重点验的那条路径。
 */
export function isFluidWorkerAvailable(): boolean {
  return typeof Worker === 'function';
}

export class FluidWorkerRunner {
  private readonly defaultTimeoutMs: number;
  private readonly boundarySource: (() => FluidBoundarySource | null | undefined) | undefined;

  private worker: Worker | null = null;
  private pending: PendingRun | null = null;
  private inFlight = 0;
  private nextRequestId = 1;
  private disposed = false;

  // ---- 边界快照缓存（键 = 地形 revision + 尺寸 + 边界四标量 + 障碍盒内容）
  private cachedSnapshot: FluidBoundarySnapshot | null = null;
  private cachedSnapshotKey = '';
  private cachedObstacleDoubles: Float64Array | null = null;

  // ---- 主线程同步路径复用的求解器（每帧新建会让主线程自己产生 ~10 MB 垃圾）
  private fallbackPool: ParticlePool | null = null;
  private fallbackRadius = Number.NaN;
  private fallbackSolver: PBFSolver | null = null;

  private cost: FluidWorkerCost = emptyCost();
  private workerStats: FluidWorkerStats | null = null;
  private solverStats: PBFStats | null = null;

  constructor(options: FluidWorkerRunnerOptions = {}) {
    const requested = options.timeoutMs;
    // 与 `ConflictRunner` 同一套夹取规则：非有限数或 ≤ 0 一律回落到默认值。
    // 于是 `timeoutMs: 0` 的含义是"用默认超时"，而不是"永不超时"（后者会让卡死的 worker 永远挂着）。
    this.defaultTimeoutMs =
      typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? requested
        : DEFAULT_FLUID_TIMEOUT_MS;
    this.boundarySource = options.boundarySource;
  }

  /** worker 是否真的可用（Node / 老浏览器里为 false）；dispose() 之后也如实报 false */
  get available(): boolean {
    return !this.disposed && isFluidWorkerAvailable();
  }

  /** 当前是否已有一帧求解在跑 */
  get busy(): boolean {
    return this.inFlight > 0;
  }

  /** 实际生效的超时（构造函数会把非正数夹成默认值，这里把它如实暴露出来，便于断言与面板显示） */
  get timeoutMs(): number {
    return this.defaultTimeoutMs;
  }

  /** 最近一次 `run()` 的搬运成本台账（没走过 worker 路径时其中的耗时段是 null） */
  get lastCost(): FluidWorkerCost {
    return this.cost;
  }

  /** 最近一次 worker 回包里的统计（走回退时为 null —— 同步路径的分项统计在主线程求解器上） */
  get lastWorkerStats(): FluidWorkerStats | null {
    return this.workerStats;
  }

  /**
   * 最近一次求解的**求解器分项统计**（两条路径都有）。
   *
   * 为什么必须单独暴露：搬进 Worker 之后 `FluidSystem.solver.stats` 不再是这一帧的真数字
   * （真正求解发生在 worker 里，或者发生在执行器自己的回退求解器上）。
   * 面板、音效、慢动作提示读的都是它 —— 不把它接过去，界面会一直显示上一帧的旧值，
   * 而那种"数字看起来正常但其实是陈的"比空白更难发现。
   */
  get lastStats(): PBFStats | null {
    return this.solverStats;
  }

  /**
   * 推进一帧流体。
   *
   * @param pool 粒子池。两条路径都会**就地**更新它的 pos/vel（worker 路径是回包写回）
   * @param settings 求解器设置。必须完整传（worker 侧会校验 13 个字段），
   *                 否则请求被判无效并回退 —— 少一个字段就会让 worker 用错核函数常数
   * @param boundary 边界。**闭包对象**，只在同步路径上被直接使用；
   *                 worker 路径靠 `boundarySource` / 边界自带的可打包字段来搬
   * @param dt 本帧推进的秒数
   * @param budgetMs 求解器时间预算。语义与 `PBFSolver.step` 的第三个参数一致；
   *                 传 `Number.POSITIVE_INFINITY` 可以拿到"不受时钟影响"的确定性结果
   *
   * 无论走哪条路径，`run()` 都**不会**抛异常：任何问题都变成"回退 + 中文原因"。
   */
  async run(
    pool: ParticlePool,
    settings: PBFSettings,
    boundary: FluidBoundary,
    dt: number,
    budgetMs: number = Number.POSITIVE_INFINITY,
  ): Promise<FluidWorkerResult> {
    const startedAt = now();
    // 非有限预算一律当成"不限"：`PBFSolver` 里 `now() - started >= Infinity` 恒为假，语义正好一致
    const budget = typeof budgetMs === 'number' && Number.isFinite(budgetMs) ? budgetMs : Number.POSITIVE_INFINITY;
    this.cost = emptyCost();

    if (this.inFlight > 0) {
      // 不排队：worker 只有一个，排队只会让调用方等更久，而且队列会让超时语义变复杂。
      // 直接在主线程把这一帧算完更可预期（`busy` 就是给调用方判断这个用的）。
      return this.runSyncPath(
        pool,
        settings,
        boundary,
        dt,
        budget,
        startedAt,
        '已有一帧求解在跑（worker 只有一个，本帧不排队），改走主线程同步路径',
      );
    }

    this.inFlight += 1;
    try {
      // 至少要跨过一个微任务：调用方 `const p = runner.run(...)` 之后立刻读 `busy`
      // 必须是 true。同步回退会在同一个同步块里跑完，那样 busy 会瞬间变回 false。
      await Promise.resolve();

      if (this.disposed) {
        return this.runSyncPath(
          pool,
          settings,
          boundary,
          dt,
          budget,
          startedAt,
          'runner 已 dispose()，不再使用 worker，改走主线程同步路径',
        );
      }
      if (!isFluidWorkerAvailable()) {
        return this.runSyncPath(
          pool,
          settings,
          boundary,
          dt,
          budget,
          startedAt,
          '当前环境没有 Worker 全局对象（Node 里就是如此；Node 的 worker_threads 不是浏览器 Worker），改走主线程同步路径',
        );
      }
      if (this.defaultTimeoutMs <= 0) {
        return this.runSyncPath(
          pool,
          settings,
          boundary,
          dt,
          budget,
          startedAt,
          `timeoutMs 为 ${this.defaultTimeoutMs}（≤ 0），等于不等 worker，直接走主线程同步路径`,
        );
      }
      if (pool.count === 0) {
        return this.runSyncPath(
          pool,
          settings,
          boundary,
          dt,
          budget,
          startedAt,
          '粒子池里没有活跃粒子，求解本身是空操作，不值得付一次搬运成本，改走主线程同步路径',
        );
      }
      if (!(dt > 0)) {
        return this.runSyncPath(
          pool,
          settings,
          boundary,
          dt,
          budget,
          startedAt,
          `dt 为 ${dt}（≤ 0），这一步不会推进任何东西，不值得付一次搬运成本，改走主线程同步路径`,
        );
      }

      const resolved = this.resolveBoundarySource(boundary);
      if (!resolved.ok) {
        return this.runSyncPath(pool, settings, boundary, dt, budget, startedAt, resolved.reason);
      }

      return await this.runOnWorker(pool, settings, boundary, resolved.source, dt, budget, startedAt);
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * 取消当前任务。
   *
   * ────────────────────────────────────────────────────────────
   * 语义（与冲突检测那边一致，但理由要说清楚）
   * ────────────────────────────────────────────────────────────
   * `cancel()` 取消的是**worker 侧那次等待**，不是"放弃结果"：
   * 被取消的 `run()` 会立刻改走主线程同步路径把这一帧算出来，照常 resolve。
   *
   * 为什么不干脆返回一个空结果：空结果无法与"粒子真的没动"区分。
   * `FluidWorkerResult` 里没有 `cancelled` 字段，若原样返回上一帧的统计，
   * 面板会显示一个看起来正常的帧 —— 那是**在说谎**。宁可多花一次同步计算。
   *
   * 顺带发给 worker 的那条 cancel 消息能不能生效，取决于任务有没有开始算：
   * worker 是单线程的，`handle()` 是同步的，所以"正在算的那一次"取消不了
   * （消息要等这一帧算完才会被读到），但"排在后面还没开始的那一次"可以。
   * 这条差异写在 `FluidCancelRequest` 的注释里，不在这里假装它能中断计算。
   */
  cancel(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    pending.finish({ kind: 'cancelled' });
    const cancelMessage: FluidCancelRequest = { id: pending.id, kind: 'cancel' };
    try {
      this.worker?.postMessage(cancelMessage);
    } catch {
      // 已终止的 worker 上 postMessage 可能抛错。取消是"尽力而为"，失败无所谓：
      // 主线程已经不再等它了，而那个引用会被下一次 run 覆盖。
    }
  }

  /**
   * 释放 worker 与缓存。
   *
   * `dispose()` 之后 `run()` **不会抛异常**：在飞的任务以"已取消"收尾并降级到同步路径，
   * 后续任务直接走同步路径并把原因写进 `fallbackReason`。
   */
  dispose(): void {
    this.disposed = true;
    this.cancel();
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    this.cachedSnapshot = null;
    this.cachedSnapshotKey = '';
    this.cachedObstacleDoubles = null;
    this.fallbackSolver = null;
    this.fallbackPool = null;
    this.workerStats = null;
    this.solverStats = null;
  }

  // ------------------------------------------------------------------ worker 路径

  private async runOnWorker(
    pool: ParticlePool,
    settings: PBFSettings,
    boundary: FluidBoundary,
    source: FluidBoundarySource,
    dt: number,
    budget: number,
    startedAt: number,
  ): Promise<FluidWorkerResult> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return this.runSyncPath(
        pool,
        settings,
        boundary,
        dt,
        budget,
        startedAt,
        `Worker 构造失败（${describeError(error)}），改走主线程同步路径`,
      );
    }

    let snapshot: FluidBoundarySnapshot;
    try {
      snapshot = this.boundarySnapshotFor(source, boundary);
    } catch (error) {
      return this.runSyncPath(
        pool,
        settings,
        boundary,
        dt,
        budget,
        startedAt,
        `无法把地形与建筑打包成可传输的快照（${describeError(error)}），改走主线程同步路径`,
      );
    }

    let poolBuffers: FluidPoolBuffers;
    const poolPackStartedAt = now();
    try {
      poolBuffers = packPool(pool);
    } catch (error) {
      return this.runSyncPath(
        pool,
        settings,
        boundary,
        dt,
        budget,
        startedAt,
        `无法把粒子池打包成可传输的数组（${describeError(error)}），改走主线程同步路径`,
      );
    }
    this.cost.poolPackMs = now() - poolPackStartedAt;
    this.cost.poolBytes = poolBufferBytes(poolBuffers);

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const request: FluidStepRequest = {
      id,
      kind: 'step',
      dt,
      budgetMs: budget,
      // 浅拷贝一份：跨线程传的是快照，之后主线程改求解器设置不会影响这一帧
      settings: { ...settings },
      boundarySnapshot: snapshot,
      pool: poolBuffers,
    };
    const waitStartedAt = now();

    const outcome = await new Promise<WorkerOutcome>((settle) => {
      let settled = false;
      const finish = (value: WorkerOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.pending = null;
        settle(value);
      };
      const timer: ReturnType<typeof setTimeout> | undefined =
        this.defaultTimeoutMs > 0
          ? setTimeout(() => finish({ kind: 'timeout' }), this.defaultTimeoutMs)
          : undefined;
      this.pending = { id, finish };

      worker.onmessage = (event: MessageEvent<unknown>): void => {
        const data = event.data;
        // id 不匹配 = 迟到的回包（超时或取消之后到的），直接丢弃
        if (readResponseId(data) !== id) return;
        // 形状不合法就**当场**判为无效并降级，而不是丢在一边等超时：
        // 一次 4 秒的等待会让"回包不对"表现成"游戏卡住 4 秒"，那是更难查的症状。
        if (!isFluidResponse(data)) {
          finish({
            kind: 'transport-error',
            message: `worker 回包形状不合法（id=${id} 的回包被丢弃）`,
          });
          return;
        }
        finish({ kind: 'response', response: data });
      };
      worker.onerror = (event: ErrorEvent): void => {
        finish({ kind: 'transport-error', message: event.message || 'worker 抛了未知错误' });
      };

      try {
        // 粒子池的 8 个缓冲区直接**转移**给 worker（零拷贝）。
        // 它们是这一步刚复制出来的临时对象，转移走不会有别的地方再用到
        // （主线程粒子池自己的数组因此得以保全 —— 这也是 `packPool` 必须复制的原因）。
        //
        // ⚠ **边界快照刻意不进 transfer 列表**：它是被缓存的，转移会把它 detach 掉，
        // 下一次命中缓存时就会送出一份空快照。结构化克隆会复制它（147 KB 量级），
        // 换来的是"缓存永远有效"这个更重要的性质。
        worker.postMessage(request, poolTransferables(poolBuffers));
      } catch (error) {
        finish({ kind: 'transport-error', message: describeError(error) });
      }
    });

    this.cost.waitMs = now() - waitStartedAt;

    if (outcome.kind === 'response') {
      const response = outcome.response;
      if (!response.ok) {
        return this.runSyncPath(
          pool,
          settings,
          boundary,
          dt,
          budget,
          startedAt,
          `worker 返回失败（${response.error}），改走主线程同步路径`,
        );
      }
      const applyStartedAt = now();
      try {
        applyPoolDelta(pool, response.pool);
      } catch (error) {
        this.cost.applyMs = now() - applyStartedAt;
        return this.runSyncPath(
          pool,
          settings,
          boundary,
          dt,
          budget,
          startedAt,
          `worker 回包无法写回粒子池（${describeError(error)}），改走主线程同步路径`,
        );
      }
      this.cost.applyMs = now() - applyStartedAt;
      this.workerStats = response.stats;
      this.solverStats = response.stats.solver;
      return {
        source: 'worker',
        fallbackReason: null,
        simulatedSeconds: response.stats.simulatedSeconds,
        substeps: response.stats.substeps,
        ms: now() - startedAt,
      };
    }

    if (outcome.kind === 'timeout') {
      // 超时说明 worker 卡住或已经死了：terminate 掉，下次 run 会重新建一个
      this.discardWorker();
      return this.runSyncPath(
        pool,
        settings,
        boundary,
        dt,
        budget,
        startedAt,
        `worker 超时（超过 ${this.defaultTimeoutMs} ms），已 terminate() 并改走主线程同步路径`,
      );
    }

    if (outcome.kind === 'cancelled') {
      return this.runSyncPath(
        pool,
        settings,
        boundary,
        dt,
        budget,
        startedAt,
        '任务被 cancel() 取消了 worker 侧的等待，已改走主线程同步路径以保证 run() 拿到的是这一帧的真实结果',
      );
    }

    this.discardWorker();
    return this.runSyncPath(
      pool,
      settings,
      boundary,
      dt,
      budget,
      startedAt,
      `worker 传输出错（${outcome.message}），已终止它并改走主线程同步路径`,
    );
  }

  private ensureWorker(): Worker {
    if (this.worker !== null) return this.worker;
    // 必须是这种**静态可分析**的写法：Vite 靠 `new Worker(new URL('...', import.meta.url))`
    // 认出 worker 入口并单独打一个产物（还会按 base 重写 URL，子路径部署才不会 404）。
    // 改成变量拼接/字符串拼装，打包就会漏掉这个文件，而本机 dev 下可能一切正常。
    const worker = new Worker(new URL('../workers/fluidWorker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker = worker;
    return worker;
  }

  private discardWorker(): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
  }

  // ------------------------------------------------------------------ 边界来源与快照缓存

  /**
   * 找出"这一次能不能打包"。
   *
   * 两个来源途径（按优先级）：
   * 1. `options.boundarySource()`：调用方显式给的 `{ grid, obstacles }`；
   * 2. `boundary` 对象**自身**同时带 `grid` 与 `obstacles` 两个字段
   *    （方便已经把两边放在一起的场景）。
   * 两者都没有时由 `classifyFluidBoundarySource` 给出中文拒绝原因。
   */
  private resolveBoundarySource(boundary: FluidBoundary): FluidBoundaryResolve {
    const provided = this.boundarySource?.();
    if (provided !== undefined && provided !== null) return classifyFluidBoundarySource(provided);
    return classifyFluidBoundarySource(boundary as unknown);
  }

  /**
   * 取这一次要发的边界快照（命中缓存则复用）。
   *
   * 缓存键里的 `editRevision` 是关键：`VoxelGrid` 的每一次 `setVoxel` / `setWaterLevel` /
   * `clear` / `recount` 都会让它 +1，而所有改地形的路径（笔刷、沙水元胞机、地形生成、
   * 冲突修复后的写回）都走这些入口。所以"revision 没变"就等于"地形没变"。
   *
   * ⚠ 如实说明两个前提，它们是这条缓存成立的条件，不是"应该没问题"：
   * 1. 如果哪一天有人绕过 `VoxelGrid` 的公开 API 直接写 `chunk.voxels`（地形生成器就是
   *    这样写的，但它写完会 `recount()`，所以仍然安全），revision 不会变，缓存就会读到旧地形；
   * 2. 沙/水每帧都在改体素时，revision 每帧都变、缓存每帧失效 —— 那时打包成本是每帧都付的。
   * 障碍盒用**逐元素比较**（存一份 Float64 副本）而不是哈希：盒通常是几十个量级，
   * 逐元素比一次是微秒级，而哈希碰撞会静默地让建筑错位。
   */
  private boundarySnapshotFor(
    source: FluidBoundarySource,
    boundary: FluidBoundary,
  ): FluidBoundarySnapshot {
    const grid = source.grid;
    const revision = grid.editRevision;
    const cacheable = typeof revision === 'number' && Number.isFinite(revision);
    const key = cacheable
      ? `${revision}|${grid.sizeX}x${grid.sizeY}x${grid.sizeZ}|${boundary.halfX}|${boundary.halfZ}|${boundary.minY}|${boundary.maxY}`
      : '';

    if (
      cacheable &&
      this.cachedSnapshot !== null &&
      this.cachedSnapshotKey === key &&
      obstaclesMatch(this.cachedObstacleDoubles, source.obstacles)
    ) {
      const hit = this.cachedSnapshot;
      this.cost.boundaryPackReused = true;
      this.cost.boundaryBytes = hit.solidBits.byteLength + hit.obstacleBounds.byteLength;
      return hit;
    }

    const packStartedAt = now();
    const snapshot = packBoundary(source, {
      halfX: boundary.halfX,
      halfZ: boundary.halfZ,
      minY: boundary.minY,
      maxY: boundary.maxY,
    });
    this.cost.boundaryPackMs = now() - packStartedAt;
    if (cacheable) {
      this.cachedSnapshot = snapshot;
      this.cachedSnapshotKey = key;
      this.cachedObstacleDoubles = flattenObstacles(source.obstacles);
    }
    this.cost.boundaryBytes = snapshot.solidBits.byteLength + snapshot.obstacleBounds.byteLength;
    return snapshot;
  }

  // ------------------------------------------------------------------ 同步路径

  /**
   * 主线程同步路径（也是唯一的回退路径）。
   *
   * 它同时承担两个角色：环境不支持时的正常路径、以及 worker 出问题时的回退。
   * 两者跑的是同一个 `PBFSolver`、同一份设置、同一份边界对象，
   * 所以"回退"不会让结果发生任何变化 —— 变的只有 `source` 与 `fallbackReason`。
   */
  private runSyncPath(
    pool: ParticlePool,
    settings: PBFSettings,
    boundary: FluidBoundary,
    dt: number,
    budget: number,
    startedAt: number,
    reason: string,
  ): FluidWorkerResult {
    const run = this.stepSync(pool, settings, boundary, dt, budget);
    // 回退路径的分项统计同样要记下来（与 worker 路径同一个字段）——
    // 面板不该因为"这一帧降级了"就显示上一帧的数字
    this.workerStats = null;
    this.solverStats = this.fallbackSolver?.stats ?? null;
    return {
      source: 'main-thread',
      fallbackReason: reason,
      simulatedSeconds: run.simulatedSeconds,
      substeps: run.substeps,
      ms: now() - startedAt,
    };
  }

  /**
   * 同步求解（复用求解器实例）。
   *
   * ── 为什么复用而不是每帧 new 一个 ──
   * `new PBFSolver(...)` 会按容量分配邻居缓存（20000 粒子约 10 MB）。回退路径是**每帧**跑的，
   * 每帧新建等于每帧在主线程上制造 10 MB 垃圾 —— 那是把"省下来的求解时间"又用 GC 还回去。
   *
   * ── 复用会不会改变结果 ──
   * 不会：`PBFSolver.step()` 的所有跨步状态都在 step 内被清零或整段覆盖
   * （详见 `fluidWorkerCore.ts` 里 `FluidWorkerRuntime` 的注释）。
   * 换池子或换平滑半径时整个重建 —— 后者必须重建，因为核函数常数与哈希格边长是构造时烘死的。
   */
  private stepSync(
    pool: ParticlePool,
    settings: PBFSettings,
    boundary: FluidBoundary,
    dt: number,
    budget: number,
  ): { substeps: number; simulatedSeconds: number } {
    const radius = settings.smoothingRadius;
    if (this.fallbackSolver === null || this.fallbackPool !== pool || this.fallbackRadius !== radius) {
      this.fallbackPool = pool;
      this.fallbackRadius = radius;
      this.fallbackSolver = new PBFSolver(pool, settings);
    } else {
      copySettingsInto(this.fallbackSolver.settings, settings);
    }
    return this.fallbackSolver.step(dt, boundary, budget);
  }
}

// ------------------------------------------------------------------ 工具

function emptyCost(): FluidWorkerCost {
  return {
    boundaryPackMs: null,
    boundaryPackReused: false,
    boundaryBytes: null,
    poolPackMs: null,
    poolBytes: null,
    waitMs: null,
    applyMs: null,
  };
}

/**
 * 结构化判断"这是一个完整的可打包来源吗"。
 *
 * 要求 `obstacles` 是数组而不是"存在即可"：`obstacles: null` 应当被当成"没说清楚"，
 * 而不是"没有建筑"。空数组 `[]` 才是明确的"这里确实没有建筑"。
 */
function isPackableSource(value: unknown): value is FluidBoundarySource {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record['grid'] !== null && typeof record['grid'] === 'object' && Array.isArray(record['obstacles'])
  );
}

/** 障碍盒摊平成 Float64（用双精度存，才能与源数据逐位比较 —— Float32Array 会丢精度） */
function flattenObstacles(obstacles: readonly FluidObstacleBox[]): Float64Array {
  const flat = new Float64Array(obstacles.length * 6);
  for (let i = 0; i < obstacles.length; i += 1) {
    const box = obstacles[i]!;
    const at = i * 6;
    flat[at] = box.minX;
    flat[at + 1] = box.maxX;
    flat[at + 2] = box.minY;
    flat[at + 3] = box.maxY;
    flat[at + 4] = box.minZ;
    flat[at + 5] = box.maxZ;
  }
  return flat;
}

function obstaclesMatch(cached: Float64Array | null, obstacles: readonly FluidObstacleBox[]): boolean {
  if (cached === null || cached.length !== obstacles.length * 6) return false;
  for (let i = 0; i < obstacles.length; i += 1) {
    const box = obstacles[i]!;
    const at = i * 6;
    if (cached[at] !== box.minX || cached[at + 1] !== box.maxX) return false;
    if (cached[at + 2] !== box.minY || cached[at + 3] !== box.maxY) return false;
    if (cached[at + 4] !== box.minZ || cached[at + 5] !== box.maxZ) return false;
  }
  return true;
}

/**
 * 能转移给 worker 的粒子池缓冲区。
 *
 * 用 `instanceof` 而不是直接断言：`TypedArray.buffer` 的类型是 `ArrayBufferLike`
 * （可能是 `SharedArrayBuffer`，而它**不能**转移）。真出现时就不转移，
 * 退化成结构化克隆 —— 结果一样，只是慢一点。
 */
function poolTransferables(buffers: FluidPoolBuffers): Transferable[] {
  const transfer: Transferable[] = [];
  const views: ArrayBufferView[] = [
    buffers.posX,
    buffers.posY,
    buffers.posZ,
    buffers.velX,
    buffers.velY,
    buffers.velZ,
    buffers.frozen,
    buffers.alive,
  ];
  for (const view of views) {
    if (view.buffer instanceof ArrayBuffer) transfer.push(view.buffer);
  }
  return transfer;
}

function poolBufferBytes(buffers: FluidPoolBuffers): number {
  return (
    buffers.posX.byteLength +
    buffers.posY.byteLength +
    buffers.posZ.byteLength +
    buffers.velX.byteLength +
    buffers.velY.byteLength +
    buffers.velZ.byteLength +
    buffers.frozen.byteLength +
    buffers.alive.byteLength
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 从一条可能不合法回包里读出 id；读不到给 -1（那条回包永远不会与主线程配对，会被丢弃） */
function readResponseId(value: unknown): number {
  if (value === null || typeof value !== 'object') return -1;
  const id = (value as Record<string, unknown>)['id'];
  return typeof id === 'number' && Number.isInteger(id) ? id : -1;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
