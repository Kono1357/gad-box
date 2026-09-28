/**
 * 冲突检测的 Worker 执行器（M4 第 6 批：把纯计算搬离主线程）。
 *
 * ────────────────────────────────────────────────────────────
 * 它要解决什么
 * ────────────────────────────────────────────────────────────
 * M4 的抱怨是"生成时卡顿"。阶段 9（冲突检测与修复）是**纯计算**：
 * 读地形、读物体、算 AABB 相交、算支撑面高度，全程不写世界、不碰渲染、
 * 不需要 DOM —— 正是最适合搬进 Worker 的那一类。
 *
 * **地形体素的写入仍然留在主线程分帧做**（那是 `Engine` 的分帧摊销队列的事），
 * 这里只搬"检测/修复"，不搬"写世界"。
 *
 * ────────────────────────────────────────────────────────────
 * 结果与同步路径逐字一致，是怎么保证的
 * ────────────────────────────────────────────────────────────
 * 1. **同一个实现**：worker 里 `new ConflictDetector(...)`、`new ConflictResolver(...)`
 *    与主线程回退路径是同一份代码，没有任何"worker 专用版本"；
 * 2. **同一个地形**：`grid` 是类实例，结构化克隆会把方法丢光，所以传的是快照，
 *    worker 用真实 `VoxelGrid` + `setVoxel` 重建（见 `conflictWorkerCore.ts`）——
 *    重建后的 `getVoxel` / `solidSurfaceHeight` 与源网格逐格一致；
 * 3. **同一个顺序**：检测器产出的顺序由"输入数组的顺序 + 稳定的 x 轴排序"决定，
 *    克隆与重建都不改变这两者，所以**不需要也不应该**对结果重排（见 `normalizeConflictOrder`）；
 * 4. **同一个随机种子**：修复分支的挪开方向由种子化 PRNG 决定，两条路径用同一个 seed。
 *
 * 已知的、必须如实说的语义差异只有一条：worker 拿的是**快照那一刻**的地形。
 * 如果主线程在等回包期间改了地形，worker 结果就对应旧地形，而同步路径对应新地形。
 * 阶段 9 不写世界、且主线程此时在等结果，所以实践中一致 —— 但这个差异是真的，记在下面。
 *
 * ────────────────────────────────────────────────────────────
 * 降级不是错误，但绝不允许"偷偷用主线程却报成 worker"
 * ────────────────────────────────────────────────────────────
 * 任何一步出问题（环境没有 `Worker`、构造抛错、`onerror`、超时、回包 `ok: false`、
 * 回包形状不合法）都**静默降级**到主线程同步路径，并把中文原因写进 `fallbackReason`。
 * `source` 永远如实反映"结果是谁算出来的"：用 worker 时 `fallbackReason` 必须是 `null`，
 * 走回退时必须是**非空**中文 —— 这两个字段的自洽性是 UI 能看出差别的唯一依据。
 */

import type { VoxelGrid } from '../voxel/VoxelGrid';
import {
  ConflictDetector,
  type ConflictRecord,
  type DetectOptions,
  type StagedObject,
} from './ConflictDetector';
import { ConflictResolver, type ResolveOptions } from './ConflictResolver';
import {
  buildGridSnapshot,
  isConflictResponse,
} from '../workers/conflictWorkerCore';
import type {
  ConflictCancelRequest,
  ConflictDetectRequest,
  ConflictRequest,
  ConflictResolveRequest,
  ConflictResponse,
  GridSnapshot,
} from '../workers/workerTypes';

export interface ConflictRunnerOptions {
  timeoutMs?: number;
}

export interface ConflictRunResult {
  conflicts: ConflictRecord[];
  /** 结果来自 worker 还是同步回退 —— 必须如实暴露，UI 上要能看出差别 */
  source: 'worker' | 'main-thread';
  /** 走回退时的中文原因；用 worker 时为 null */
  fallbackReason: string | null;
  ms: number;
}

/** 默认超时：4000 ms。检测是毫秒级的活，超过 4 秒基本可以判定 worker 卡住或已经死了。 */
export const DEFAULT_CONFLICT_TIMEOUT_MS = 4000;

/** 每次 `run()` 可以覆盖的任务参数（写在这里是因为 `run()` 的 options 是 unknown，需要收窄） */
interface ParsedRunOptions {
  kind: 'detect' | 'resolve';
  detect: DetectOptions;
  resolve: ResolveOptions;
  seed: number;
  timeoutMs: number;
}

const DETECT_OPTION_KEYS = [
  'overlapTolerance',
  'floatTolerance',
  'doorwayClearance',
  'boundsMargin',
] as const;

const RESOLVE_OPTION_KEYS = [
  'overlapTolerance',
  'floatTolerance',
  'doorwayClearance',
  'boundsMargin',
  'maxMoveAttempts',
  'moveSearchRadius',
  'maxTreeLift',
  'maxRounds',
] as const;

/**
 * 当前环境能不能用 Web Worker。
 *
 * Node 里是 `false`：Node 的 `worker_threads` **不是**浏览器 Worker（模块格式、
 * 消息协议、全局作用域都不同），本项目一行都不用，所以这里如实回答"不可用"，
 * 让 `ConflictRunner` 走同步回退 —— 这也是断言要重点验的那条路径。
 */
export function isWorkerAvailable(): boolean {
  return typeof Worker === 'function';
}

/**
 * 把冲突记录排成一个稳定序（`type` → `id` → `x` → `z`，全部是字符串/数值比较）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么 `run()` **不**默认调用它
 * ────────────────────────────────────────────────────────────
 * 任务书建议"给结果排一个稳定序"，但这里必须说清楚结论：**不需要，而且排了会更糟**。
 * 检测器产出的顺序本来就是确定的：单物体检查按 `objects` 的输入顺序，
 * 两两比较按"以左边界排序后的配对顺序"（`Array.prototype.sort` 自 ES2019 起保证稳定）。
 * 输入数组的顺序经过结构化克隆与快照重建后完全不变，所以 worker 结果与同步结果
 * **连顺序都逐字相同**。反过来，如果在这里重排（比如按 `type` 分组），
 * `run()` 的结果就与"直接同步调用 `ConflictDetector`"的结果顺序不同 —— 那恰好破坏了
 * 本轮最重要的那条保证。
 *
 * 所以这个函数只作为**可选的展示/比对工具**导出：面板要按类型分组、或者要拿两次
 * 结果做集合比较时用它；`run()` 自己不用。它的稳定性有断言兜底（幂等 + 严格有序）。
 */
export function normalizeConflictOrder(conflicts: readonly ConflictRecord[]): ConflictRecord[] {
  return [...conflicts].sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    if (a.position[0] !== b.position[0]) return a.position[0] - b.position[0];
    if (a.position[2] !== b.position[2]) return a.position[2] - b.position[2];
    return a.objects.join('|') < b.objects.join('|') ? -1 : a.objects.join('|') > b.objects.join('|') ? 1 : 0;
  });
}

/** worker 任务的结局（全部用值表达，不用 reject —— 避免"没人接的 rejection"） */
type WorkerOutcome =
  | { kind: 'response'; response: ConflictResponse }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'transport-error'; message: string };

interface PendingRun {
  id: number;
  finish(outcome: WorkerOutcome): void;
}

export class ConflictRunner {
  private readonly defaultTimeoutMs: number;
  private worker: Worker | null = null;
  private pending: PendingRun | null = null;
  private inFlight = 0;
  private nextRequestId = 1;
  private disposed = false;

  constructor(options: ConflictRunnerOptions = {}) {
    const requested = options.timeoutMs;
    this.defaultTimeoutMs =
      typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? requested
        : DEFAULT_CONFLICT_TIMEOUT_MS;
  }

  /** worker 是否真的可用（Node / 老浏览器里为 false）；dispose() 之后也如实报 false */
  get available(): boolean {
    return !this.disposed && isWorkerAvailable();
  }

  /** 当前是否已有一个任务在跑 */
  get busy(): boolean {
    return this.inFlight > 0;
  }

  /**
   * 跑一次冲突检测（或修复）。
   *
   * @param objects 参与检测的物体（**纯数据**：全是普通对象与 number 元组，没有回调、没有类实例）
   * @param world 地形。必须是 `VoxelGrid`（或至少有那几个查询方法的等价物）——
   *              它是唯一搬不动的东西（类实例的方法在结构化克隆后会消失），
   *              所以这里会把它打包成快照传给 worker
   * @param options 可选：`{ kind?: 'detect' | 'resolve'; detect?: DetectOptions; resolve?: ResolveOptions;
   *                seed?: number; timeoutMs?: number }`
   *
   * 无论走哪条路径，`run()` 都**不会修改调用方传进来的 `objects`**
   * （`resolve` 分支在副本上跑）：worker 路径本来就改不到主线程的对象，
   * 两条路径的副作用必须一致，否则"换路径"会悄悄改变结果。
   */
  async run(
    objects: readonly StagedObject[],
    world: unknown,
    options?: unknown,
  ): Promise<ConflictRunResult> {
    const startedAt = now();
    const grid = requireGrid(world);
    const parsed = parseRunOptions(options, this.defaultTimeoutMs);

    if (this.inFlight > 0) {
      // 不排队：worker 只有一个，排队只会让调用方等更久，而且队列会让超时语义变复杂。
      // 直接在主线程把这一份算完更可预期（`busy` 就是给调用方判断这个用的）。
      return this.runSyncPath(
        objects,
        grid,
        parsed,
        startedAt,
        '已有一个任务在跑（busy 为 true），本任务不排队，改走主线程同步路径',
      );
    }

    this.inFlight += 1;
    try {
      // 至少要跨过一个微任务：调用方 `const p = runner.run(...)` 之后立刻读 `busy`
      // 必须是 true。同步回退路径会在同一个同步块里跑完，那样 busy 会瞬间变回 false。
      await Promise.resolve();

      if (this.disposed) {
        return this.runSyncPath(
          objects,
          grid,
          parsed,
          startedAt,
          'runner 已 dispose()，不再使用 worker，改走主线程同步路径',
        );
      }
      if (!isWorkerAvailable()) {
        return this.runSyncPath(
          objects,
          grid,
          parsed,
          startedAt,
          '当前环境没有 Worker 全局对象（Node 里就是如此；Node 的 worker_threads 不是浏览器 Worker），改走主线程同步路径',
        );
      }
      if (parsed.timeoutMs <= 0) {
        return this.runSyncPath(
          objects,
          grid,
          parsed,
          startedAt,
          `timeoutMs 为 ${parsed.timeoutMs}（≤ 0），等于不等 worker，直接走主线程同步路径`,
        );
      }
      return await this.runOnWorker(objects, grid, parsed, startedAt);
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * 取消当前任务。
   *
   * ────────────────────────────────────────────────────────────
   * 语义（说清楚，否则很容易被误用）
   * ────────────────────────────────────────────────────────────
   * `cancel()` 取消的是**worker 侧那次等待**，不是"放弃结果"：
   * 被取消的 `run()` 会立刻改走主线程同步路径把结果算出来，照常 resolve。
   *
   * 为什么不干脆返回一个空结果：**空结果无法与"真的没有冲突"区分**。
   * `ConflictRunResult` 里没有 `cancelled` 字段，若返回空数组，
   * UI 只会显示"0 处冲突"——那是在说谎。所以宁可多花一次同步计算，
   * 也要保证 `run()` 返回的 `conflicts` 永远是真实结果。
   * 调用方如果确实不想要结果，忽略这个 Promise 即可。
   *
   * 没有在跑的任务时 `cancel()` 是空操作（不报错）。
   */
  cancel(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    pending.finish({ kind: 'cancelled' });
    // 顺带通知 worker：如果它还没开始算，就别算了（立刻回一条 status: 'cancelled'）。
    // 已经开始算的任务无法中断（worker 是单线程的），那条回包会因 id 不再匹配而被丢弃。
    const cancelMessage: ConflictCancelRequest = { id: pending.id, kind: 'cancel' };
    try {
      this.worker?.postMessage(cancelMessage);
    } catch {
      // 终止后的 worker 上 postMessage 可能抛错。取消是"尽力而为"，失败无所谓：
      // 主线程已经不再等它了，而对象的引用会被下一次 run 覆盖。
    }
  }

  /**
   * 释放 worker。
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
  }

  // ------------------------------------------------------------------ worker 路径

  private async runOnWorker(
    objects: readonly StagedObject[],
    grid: VoxelGrid,
    parsed: ParsedRunOptions,
    startedAt: number,
  ): Promise<ConflictRunResult> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return this.runSyncPath(
        objects,
        grid,
        parsed,
        startedAt,
        `Worker 构造失败（${describeError(error)}），改走主线程同步路径`,
      );
    }

    let snapshot: GridSnapshot;
    try {
      snapshot = buildGridSnapshot(grid);
    } catch (error) {
      return this.runSyncPath(
        objects,
        grid,
        parsed,
        startedAt,
        `无法把地形打包成可传输的快照（${describeError(error)}），改走主线程同步路径`,
      );
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const request = buildRequest(id, objects, snapshot, parsed);
    const timeoutMs = parsed.timeoutMs;

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
        timeoutMs > 0
          ? setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
          : undefined;
      this.pending = { id, finish };

      worker.onmessage = (event: MessageEvent<unknown>): void => {
        const data = event.data;
        // id 不匹配 = 迟到的回包（超时或取消之后到的），直接丢弃
        if (isConflictResponse(data) && data.id === id) {
          finish({ kind: 'response', response: data });
        }
      };
      worker.onerror = (event: ErrorEvent): void => {
        finish({ kind: 'transport-error', message: event.message || 'worker 抛了未知错误' });
      };

      try {
        // 快照的两个 TypedArray 直接**转移**给 worker（零拷贝）。
        // 它们是这次调用刚建出来的临时对象，转移走不会有别的地方再用到。
        worker.postMessage(request, transferableBuffers(snapshot));
      } catch (error) {
        finish({ kind: 'transport-error', message: describeError(error) });
      }
    });

    if (outcome.kind === 'response') {
      const response = outcome.response;
      if (!response.ok) {
        return this.runSyncPath(
          objects,
          grid,
          parsed,
          startedAt,
          `worker 返回失败（${response.error}），改走主线程同步路径`,
        );
      }
      if (response.status === 'cancelled') {
        return this.runSyncPath(
          objects,
          grid,
          parsed,
          startedAt,
          'worker 侧任务在开始计算前被 cancel() 取消（cancelled），改走主线程同步路径以保证 run() 拿到的是真实结果',
        );
      }
      return {
        conflicts: response.conflicts,
        source: 'worker',
        fallbackReason: null,
        ms: now() - startedAt,
      };
    }

    if (outcome.kind === 'timeout') {
      // 超时说明 worker 卡住或已经死了：terminate 掉，下次 run 会重新建一个
      this.discardWorker();
      return this.runSyncPath(
        objects,
        grid,
        parsed,
        startedAt,
        `worker 超时（超过 ${timeoutMs} ms），已 terminate() 并改走主线程同步路径`,
      );
    }

    if (outcome.kind === 'cancelled') {
      return this.runSyncPath(
        objects,
        grid,
        parsed,
        startedAt,
        '任务被 cancel() 取消了 worker 侧的等待（cancelled），已改走主线程同步路径',
      );
    }

    this.discardWorker();
    return this.runSyncPath(
      objects,
      grid,
      parsed,
      startedAt,
      `worker 传输出错（${outcome.message}），已终止它并改走主线程同步路径`,
    );
  }

  private ensureWorker(): Worker {
    if (this.worker !== null) return this.worker;
    // 必须是这种**静态可分析**的写法：Vite 靠 `new Worker(new URL('...', import.meta.url))`
    // 认出 worker 入口并单独打一个产物（还会按 base 重写 URL，子路径部署才不会 404）。
    // 改成变量拼接/字符串拼装，打包就会漏掉这个文件，而本机 dev 下可能一切正常。
    const worker = new Worker(new URL('../workers/conflictWorker.ts', import.meta.url), {
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

  // ------------------------------------------------------------------ 同步路径

  /**
   * 主线程同步路径（也是唯一的回退路径）。
   *
   * 它同时承担两个角色：环境不支持时的正常路径、以及 worker 出问题时的回退。
   * 两者跑的是同一个函数、同一个检测器实例类型、同一份选项，
   * 所以"回退"不会让结果发生任何变化 —— 变的只是 `source` 与 `fallbackReason`。
   */
  private runSyncPath(
    objects: readonly StagedObject[],
    grid: VoxelGrid,
    parsed: ParsedRunOptions,
    startedAt: number,
    reason: string,
  ): ConflictRunResult {
    return {
      conflicts: computeConflictsSync(objects, grid, parsed),
      source: 'main-thread',
      fallbackReason: reason,
      ms: now() - startedAt,
    };
  }
}

// ------------------------------------------------------------------ 工具

function computeConflictsSync(
  objects: readonly StagedObject[],
  grid: VoxelGrid,
  parsed: ParsedRunOptions,
): ConflictRecord[] {
  if (parsed.kind === 'detect') {
    // 与"直接同步调用检测器"完全一致：同一个类、同一份选项、同一个输入顺序
    return new ConflictDetector(parsed.detect).detect({ objects, grid }).conflicts;
  }
  // 修复会**就地修改**数组与物体位置，所以先复制一份：
  // run() 对调用方必须无副作用（worker 路径本身就改不到主线程的对象），
  // 两条路径的副作用不一致，等于"换个路径结果就变了"。
  const copies: StagedObject[] = objects.map(copyStagedObject);
  return new ConflictResolver(parsed.resolve).resolve(copies, grid, parsed.seed).remaining;
}

function copyStagedObject(object: StagedObject): StagedObject {
  return {
    ...object,
    position: [object.position[0], object.position[1], object.position[2]],
    half: [object.half[0], object.half[1], object.half[2]],
  };
}

function buildRequest(
  id: number,
  objects: readonly StagedObject[],
  grid: GridSnapshot,
  parsed: ParsedRunOptions,
): ConflictRequest {
  if (parsed.kind === 'detect') {
    const request: ConflictDetectRequest = {
      id,
      kind: 'detect',
      // 只传检测真正需要的字段（就是 StagedObject 本身的形状），避免把引用型的东西带进去
      objects: objects.map(copyStagedObject),
      grid,
      options: parsed.detect,
    };
    return request;
  }
  const request: ConflictResolveRequest = {
    id,
    kind: 'resolve',
    objects: objects.map(copyStagedObject),
    grid,
    options: parsed.resolve,
    seed: parsed.seed,
  };
  return request;
}

/**
 * 能转移给 worker 的缓冲区。
 *
 * 用 `instanceof` 而不是直接断言：`TypedArray.buffer` 的类型是 `ArrayBufferLike`
 * （可能是 SharedArrayBuffer，而 SharedArrayBuffer **不能**转移）。
 * 真出现 SharedArrayBuffer 时就不转移，退化成结构化克隆（会复制一份）—— 结果一样，只是慢一点。
 */
function transferableBuffers(snapshot: GridSnapshot): Transferable[] {
  const buffers: Transferable[] = [];
  if (snapshot.indices.buffer instanceof ArrayBuffer) buffers.push(snapshot.indices.buffer);
  if (snapshot.ids.buffer instanceof ArrayBuffer) buffers.push(snapshot.ids.buffer);
  return buffers;
}

/**
 * 收窄 `world` 参数。
 *
 * 为什么对"不是网格"直接抛错、而不是静默返回空结果：
 * 那是调用方的编程错误，返回 `conflicts: []` 会被 UI 读成"没有冲突"——
 * 一个明确的报错远好过一份看起来很正常的假数据。
 */
function requireGrid(world: unknown): VoxelGrid {
  if (isGridLike(world)) return world;
  throw new Error(
    'ConflictRunner: world 必须是 VoxelGrid（至少要提供 worldToVoxelX / worldToVoxelZ / ' +
      `inHorizontalBounds / solidSurfaceHeight / getVoxel 与 halfX、halfZ、sizeY），收到的是 ${describeValue(world)}`,
  );
}

/**
 * 结构化判断"像不像一个地形网格"。
 *
 * 用方法存在性判断而不是 `instanceof VoxelGrid`：断言与测试里常常用一个轻量的替身网格，
 * 而 `instanceof` 会把它们全部拒掉。这里只要求"检测器真正会用到的那几个成员"存在。
 */
function isGridLike(value: unknown): value is VoxelGrid {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const methods = ['worldToVoxelX', 'worldToVoxelZ', 'inHorizontalBounds', 'solidSurfaceHeight', 'getVoxel'];
  for (const name of methods) {
    if (typeof record[name] !== 'function') return false;
  }
  return (
    typeof record['halfX'] === 'number' &&
    typeof record['halfZ'] === 'number' &&
    typeof record['sizeY'] === 'number'
  );
}

function parseRunOptions(options: unknown, defaultTimeoutMs: number): ParsedRunOptions {
  const record = options !== null && typeof options === 'object' ? (options as Record<string, unknown>) : null;

  let kind: 'detect' | 'resolve' = 'detect';
  const rawKind = record?.['kind'];
  if (rawKind !== undefined) {
    if (rawKind !== 'detect' && rawKind !== 'resolve') {
      throw new Error(`ConflictRunner: options.kind 只能是 'detect' 或 'resolve'，收到的是 ${describeValue(rawKind)}`);
    }
    kind = rawKind;
  }

  const rawTimeout = record?.['timeoutMs'];
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) ? rawTimeout : defaultTimeoutMs;

  const rawSeed = record?.['seed'];
  const seed = typeof rawSeed === 'number' && Number.isFinite(rawSeed) ? rawSeed : 0;

  return {
    kind,
    detect: pickNumericOptions<DetectOptions>(record?.['detect'], DETECT_OPTION_KEYS),
    resolve: pickNumericOptions<ResolveOptions>(record?.['resolve'], RESOLVE_OPTION_KEYS),
    seed,
    timeoutMs,
  };
}

/**
 * 只挑出**确实存在的数值字段**。
 *
 * 刻意不把整个对象原样转交给检测器：未知字段、`NaN`、字符串都会被静默塞进选项里，
 * 而检测器对它们没有任何防御（比如 `overlapTolerance: '0.12'` 会让所有比较变成字符串比较，
 * 结果悄悄全错）。默认值交给检测器自己合并 —— 这里一个默认值都不抄。
 */
function pickNumericOptions<T extends object>(value: unknown, keys: readonly string[]): T {
  const result: Record<string, number> = {};
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const field = record[key];
      if (typeof field === 'number' && Number.isFinite(field)) result[key] = field;
    }
  }
  return result as T;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') {
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    return `一个 ${name ?? '未知类型'} 对象`;
  }
  return `${typeof value}（${String(value)}）`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
