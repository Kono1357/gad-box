/**
 * 冲突检测 Worker 的消息协议（M4 第 6 批：把纯计算搬离主线程）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么单独一个文件放类型
 * ────────────────────────────────────────────────────────────
 * 主线程侧（`ConflictRunner`）与 worker 侧（`conflictWorker`）必须用**同一套**消息类型。
 * 各自定义一遍的风险不是"编译不过"，而是"两边都能编译、消息却对不上"——
 * 这类 bug 只会在真浏览器里以"结果永远是空的"或"一直等不到回包"的形式出现，
 * 而这一轮的环境里根本没有浏览器可以查，所以宁可在类型层面把它堵死。
 *
 * 这里只有 `import type`：类型导入编译后完全擦除，**运行时不产生任何依赖**，
 * 因此不存在"worker 与主线程互相 import 引起循环引用"的问题。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么地形要打快照，不能直接把 VoxelGrid 传过去
 * ────────────────────────────────────────────────────────────
 * 检测器要的是 `DetectInput.grid: VoxelGrid`，那是一个**类实例**。
 * 结构化克隆只搬"自有数据属性"，原型链上的方法
 * （`worldToVoxelX` / `worldToVoxelZ` / `inHorizontalBounds` / `solidSurfaceHeight` / `getVoxel`）
 * 会全部丢掉——克隆体到了 worker 里连一次地形查询都做不了。
 *
 * 所以协议里传的是**快照**：世界尺寸 + 非空气格的（扁平下标, 体素 id）两个 TypedArray。
 * worker 侧用真实的 `VoxelGrid` + `setVoxel` 把它重建出来（见 `conflictWorkerCore.ts`），
 * 这样 worker 里跑的还是**同一个 VoxelGrid**，而不是一份"重写的地形查询"——
 * 后者一旦与 VoxelGrid 的实现漂移，结果就不再与同步路径一致了。
 */

import type { ConflictRecord, DetectOptions, StagedObject } from '../world/ConflictDetector';
import type { ResolveOptions } from '../world/ConflictResolver';

/**
 * 地形快照（纯数据，结构化克隆可传、TypedArray 可零拷贝转移）。
 *
 * 只存**非空气格**：空气是 `new VoxelGrid()` 的默认值（全网格 AIR），
 * 所以"只写非空气格"重建出来的网格与源网格逐格一致，而传输量只与非空气体素量成正比。
 *
 * **如实说明两处简化**（它们都不影响冲突检测，因为检测器不读这两样东西）：
 * 1. 不存水量（`Chunk.water`）。`getWaterLevel` 拿不到原始值；
 * 2. 重建出来的液体的水量会是 `setVoxel` 给的满格值（255）。
 *    检测器只用 `getVoxel` 与 `solidSurfaceHeight`，两者都不读水量。
 *    如果将来检测器开始读水位，这个快照就不够了——那时必须同步扩展协议。
 */
export interface GridSnapshot {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  /**
   * 非空气格的扁平下标，约定：`x + z * sizeX + y * sizeX * sizeZ`。
   * 世界尺寸最大档是 192×32×192 ≈ 118 万格，Int32 装得下（上限约 21 亿）。
   */
  indices: Int32Array;
  /** 与 `indices` 一一对应的体素 id（体素表存的是 Uint8，所以用 Uint8Array） */
  ids: Uint8Array;
}

/** 任务类型：检测 / 修复。两者都是纯计算，不碰 DOM、不碰渲染。 */
export type ConflictTaskKind = 'detect' | 'resolve';

export interface ConflictDetectRequest {
  /** 请求 id：主线程自增，回包靠它配对（超时/取消后到达的迟到回包靠它被丢弃） */
  id: number;
  kind: 'detect';
  /** 参与检测的物体。**纯数据**：普通对象 + number 元组，没有回调、没有类实例 */
  objects: StagedObject[];
  grid: GridSnapshot;
  /** 传给 `ConflictDetector` 的局部选项；默认值由检测器自己合并（这里不复制一份默认值） */
  options: DetectOptions;
}

export interface ConflictResolveRequest {
  id: number;
  kind: 'resolve';
  objects: StagedObject[];
  grid: GridSnapshot;
  options: ResolveOptions;
  /** 随机数种子：修复的挪开方向要与主线程同步路径逐位一致，必须同一个种子 */
  seed: number;
}

/**
 * 取消请求。
 *
 * 语义要说清楚：worker 是单线程的，**一旦开始同步计算就无法被中断**。
 * 所以取消只在"任务还没开始算"时才有意义——worker 侧为此在开始计算前让出一个宏任务，
 * 给紧跟其后的 cancel 一个到达窗口。已经开始算的任务只能把结果照常回给主线程，
 * 由主线程丢弃（并如实标成"已取消"）。
 */
export interface ConflictCancelRequest {
  id: number;
  kind: 'cancel';
}

export type ConflictRequest = ConflictDetectRequest | ConflictResolveRequest | ConflictCancelRequest;

/**
 * 结果状态。
 * - `done`：算完了；
 * - `cancelled`：还没开始算就被取消了 —— **不能被当成"没有冲突"**，
 *   所以它单独一个状态，主线程必须能区分它和"跑挂了"（`ok: false`）。
 */
export type ConflictResultStatus = 'done' | 'cancelled';

export interface ConflictOkResponse {
  id: number;
  ok: true;
  status: ConflictResultStatus;
  /** `status === 'cancelled'` 时一定是空数组，并靠 `note` 说明原因 */
  conflicts: ConflictRecord[];
  /** worker 侧真正花在计算上的毫秒数（不含等待与克隆） */
  ms: number;
  note?: string;
}

export interface ConflictErrorResponse {
  id: number;
  ok: false;
  /** `error.message` 原样回传，不加工、不吞 */
  error: string;
}

export type ConflictResponse = ConflictOkResponse | ConflictErrorResponse;

/**
 * Worker 全局作用域里我们用到的那一小部分。
 *
 * 刻意不写 `self: Window`（lib.dom 里 `self` 是 `Window`）：在 module worker 里
 * `postMessage` 的签名与 Window 的不一样（Window 那个要 targetOrigin），
 * 直接沿用 DOM 类型会逼出一堆无意义的断言。这里只声明真正用到的两个成员。
 */
export interface WorkerScopeLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
