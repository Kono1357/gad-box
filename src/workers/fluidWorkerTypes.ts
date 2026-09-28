/**
 * 粒子流体求解器 Worker 的消息协议（M4 第 7 批：把 PBF 求解搬离主线程）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么单独一个文件放类型（照 `workerTypes.ts` 的约定）
 * ────────────────────────────────────────────────────────────
 * 主线程侧（`FluidWorkerRunner`）与 worker 侧（`fluidWorker` / `fluidWorkerCore`）
 * 必须用**同一套**消息类型。各自定义一遍的风险不是"编译不过"，而是"两边都能编译、
 * 消息却对不上"—— 那类 bug 只在真浏览器里以"一直等不到回包"的形式出现，
 * 而本轮环境里**没有浏览器**，查不了。所以宁可在类型层面堵死。
 *
 * 这里只有 `import type`：类型导入编译后完全擦除，运行时不产生任何依赖。
 *
 * ────────────────────────────────────────────────────────────
 * 核心难点：`FluidBoundary` 是一个**带回调的接口**，搬不动
 * ────────────────────────────────────────────────────────────
 * `PBFSolver.step(dt, boundary)` 里的 `boundary.isSolid(x,y,z)` 是闭包，
 * 结构化克隆只搬"自有数据属性"，函数会直接让克隆**抛错**
 * （`DataCloneError`），不是"搬过去变 undefined"。
 *
 * 所以协议里传的是**快照**。要决定快照装什么，先看求解器到底问了边界什么
 * （`PBFSolver.resolveCollisions` + `escapeDirection`，逐行读过）：
 * 1. `boundary.halfX / halfZ / minY / maxY` —— 四个标量，世界六面墙；
 * 2. `isSolid(x, y-r, z)`、`isSolid(x, y+r, z)`、`isSolid(x±r, y, z)`、`isSolid(x, y, z±r)`
 *    —— **六向探针**，采样点在世界坐标上是任意浮点数（不是格点）；
 * 3. `isSolid(x, y, z)` —— 兜底：中心落在固体内时沿最短方向找空位（最多 8 步）；
 * 4. 除此之外**没有别的查询**：求解器不读地形 id、不读水量、不读区块、不做射线。
 *
 * 也就是说：**能搬的是"任意世界点 → 是否固体"这个布尔函数**，而且只需要它在
 * 快照那一刻的取值。`Engine.fluidBoundary()` 的实现里这个函数由两部分合成
 * （先地形体素、再建筑分桶盒），因此快照也必须同时装下这两部分，
 * 少装任何一部分都是**偷偷缩小能力**（水会穿过建筑 / 穿过地形）。
 *
 * 形式选择见 `FluidBoundarySnapshot` 上方的注释：用的是**位图 + 障碍盒列表**，
 * 不是"每列地表高度"的列式快照 —— 后者在洞穴/悬垂/挖出来的隧道上会给出**不同**答案。
 */

import type { PBFSettings, PBFStats } from '../fluid/PBFSolver';
import type { VoxelGrid } from '../voxel/VoxelGrid';

/**
 * 建筑障碍的保守包围盒（世界坐标，米）。
 *
 * 形状刻意与 `Engine.buildFluidObstacles` 里用的那一种**完全一致**：
 * 引擎那边就是"用 def.size 的最大水平半宽当半宽"的轴对齐盒（旋转按最坏情况放大），
 * 所以这里不需要任何新的几何表达能力 —— 搬过去的盒与主线程用的是同一批数字。
 */
export interface FluidObstacleBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/**
 * 可打包的边界来源。
 *
 * ⚠ `obstacles` **必须显式给出**（没有建筑就给空数组），不能省略：
 * "没给建筑"与"这里真的没有建筑"是两件事，而它们在快照里长得一样。
 * 允许省略就等于允许调用方在不知情的情况下把水放进建筑里，
 * 所以类型上要求它存在；只给 `VoxelGrid` 的重载会把 `obstaclesIncluded` 标成 false，
 * 由 `FluidWorkerRunner` 拒绝走 worker（见那里的 `resolveBoundarySource`）。
 */
export interface FluidBoundarySource {
  grid: VoxelGrid;
  /** 建筑障碍盒。空数组是**明确的**"这里没有建筑"，不是"我不知道" */
  obstacles: readonly FluidObstacleBox[];
}

/**
 * `packBoundary` 接收的两种来源：
 * - `VoxelGrid`：只搬地形，`obstaclesIncluded` 会是 false（runner 会因此回退）；
 * - `FluidBoundarySource`：地形 + 建筑，能力完整。
 */
export type FluidBoundaryInput = VoxelGrid | FluidBoundarySource;

/** 边界的四个标量参数（与 `PBFSolver.FluidBoundary` 上的同名字段一一对应） */
export interface FluidBoundaryParams {
  /** 世界水平半宽（±halfX 是墙）。注意它**不**参与体素坐标换算，见 originX */
  halfX: number;
  halfZ: number;
  /** 地面高度（y 下限，通常是 0） */
  minY: number;
  /** 天花板高度（y 上限） */
  maxY: number;
}

/**
 * 边界快照（纯数据；TypedArray 可零拷贝转移）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么是"位图"而不是"每列地表高度"（列式快照）
 * ────────────────────────────────────────────────────────────
 * 列式（sizeX×sizeZ 个地表高度）看起来最省地方，但它只能表达**高度场**：
 * 同一个 (x,z) 列上"从地表往下全是固体"。而这个游戏里的地形**不是**高度场：
 * - 笔刷可以挖横向隧道、掏洞（`VoxelGrid.setVoxel` 不限制"必须连着地表"）；
 * - 玩家搭的实心建筑一旦被写进体素（`GridWriter`）就同样可能悬空；
 * - 水下的气泡腔、双层地板都是合法状态。
 * 用列式快照之后，`isSolid` 在隧道里会回答"是固体"（水被凭空挡住），
 * 在悬垂下方会回答"是固体"（水被凭空托住）—— 两条都是**结论错误**，不是"差一点"。
 *
 * 位图则是无损的：每个格一位，表达任意形状。代价是体积与格数成正比而不是与列数成正比，
 * 所以这里按**区块**分块存（区块内沿用 `Chunk.index` 的线性序），
 * 好处是打包时能对 `chunk.voxels` 做一趟纯线性扫描（不做任何坐标换算），
 * 查询时也能直接用 `Chunk.index` 的公式定位到 word。实测数字见交付报告。
 *
 * 位为 1 的含义，与 `Engine.fluidBoundary().isSolid` 的地形分支**逐字对应**：
 * `id !== AIR && !isLiquid(id)`。液体体素（旧的水）不算固体 —— 粒子流体与它共存。
 */
export interface FluidBoundarySnapshot extends FluidBoundaryParams {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  chunksX: number;
  chunksZ: number;
  /**
   * 每个区块的位图字数。`Chunk.voxels` 有 `16 × sizeY × 16` 个单元格，
   * 总是 32 的整数倍（因为 16×16=256 是 32 的倍数），所以这里不会浪费位数。
   */
  wordsPerChunk: number;
  /** 每区块 `wordsPerChunk` 个 32 位字；区块顺序 = `cz * chunksX + cx` */
  solidBits: Uint32Array;
  /**
   * 障碍盒，每 6 个 float 一个盒：`minX, maxX, minY, maxY, minZ, maxZ`。
   * 用 Float32Array 而不是对象数组：一个 TypedArray 比几百个小对象便宜得多，
   * 而且能零拷贝转移。
   */
  obstacleBounds: Float32Array;
  /**
   * 快照里是否**明确**包含了建筑障碍（`false` = 调用方只给了 `VoxelGrid`）。
   * 这个字段存在的唯一目的是让"没搬建筑"这件事**看得见**，
   * 而不是变成一份看起来正常、却偷偷少了能力的快照。
   */
  obstaclesIncluded: boolean;
  /**
   * 体素坐标换算的偏移量，等于 `VoxelGrid.halfX / halfZ`（也就是 `sizeX / 2`、`sizeZ / 2`）。
   *
   * 为什么不直接用 `halfX`：`Engine.fluidBoundary()` 里**墙**用的是 `boundary.halfX`，
   * 而**体素换算**走的是 `grid.worldToVoxelX()`（内部用 `grid.halfX`）。
   * 在引擎里这两个数恰好相等，但把它们合并成一个字段就等于**假设**它们永远相等 ——
   * 下一个人只要让墙比网格窄一点，水的碰撞就会整体错位，而且很难查。
   */
  originX: number;
  originZ: number;
}

/**
 * 粒子池的搬运包（去程）。
 *
 * 只装求解器**真的需要**的数组，这是实测过搬运成本之后的选择：
 * - `posX/Y/Z`：预测位置、碰撞、建哈希、拉邻居都要；
 * - `velX/Y/Z`：施加重力/阻尼、速度夹持、XSPH 与表面张力都要；
 * - `frozen`：冻结粒子跳过重力、跳过碰撞、速度清零，必须原样带上；
 * - `alive`：活跃掩码，决定参与求解的下标集合。
 *
 * **刻意不搬的**（写清楚，否则会被当成漏了）：
 * - `prevX/Y/Z`：`predict()` 在**每个子步开始时**对每个活跃粒子无条件重写它们
 *   （`prevX[i] = posX[i]`），任何一次 `step()` 都不可能读到上一帧的旧值；
 * - `density` / `lambda` / `deltaVX/Y/Z`：每一步都被 `solveDensity` / `solvePressure` /
 *   `applyViscosityAndTension` 重算或清零，是纯中间量；
 * - `freeList` 与空闲链表状态：worker 只是**按同一批下标**重建一个池子，
 *   它不会 spawn/kill 任何粒子，所以空闲链表形状对结果没有任何影响。
 * 省下的 3 个 Float32Array 在 20000 粒子上是 240 KB / 次，不是零头。
 */
export interface FluidPoolBuffers {
  /** 池子容量（worker 侧要按它分配同样大的数组） */
  capacity: number;
  /**
   * 下标水位：求解器的一切遍历上界都是它（`for (i = 0; i < highWater; i++)`）。
   * **必须逐位一致**：如果 worker 侧的 highWater 比主线程大，多出来的下标会读到
   * 全 0 位置（等于凭空多出一堆粒子堆在原点）；小了则会漏算粒子。
   */
  highWater: number;
  /** 活跃粒子数（一致性校验用：worker 回包必须与它相等） */
  count: number;
  posX: Float32Array;
  posY: Float32Array;
  posZ: Float32Array;
  velX: Float32Array;
  velY: Float32Array;
  velZ: Float32Array;
  frozen: Uint8Array;
  alive: Uint8Array;
}

/**
 * 回包里的粒子数据（回程）。
 *
 * 只回 6 个 Float32Array：`frozen` / `alive` 在一次 `step()` 里不会被改动
 * （`applyFrozenFlags` 属于 `FluidSystem`，不属于求解器），
 * `prev` 由主线程下一次 `predict` 自己重写。
 */
export interface FluidPoolDelta {
  capacity: number;
  highWater: number;
  count: number;
  posX: Float32Array;
  posY: Float32Array;
  posZ: Float32Array;
  velX: Float32Array;
  velY: Float32Array;
  velZ: Float32Array;
}

/**
 * 推进一帧流体。
 *
 * `settings` 传的是**完整的** `PBFSettings`（13 个数值），不是增量：
 * worker 侧会逐字段覆盖到求解器自己的 settings 上，任何缺字段都会被判为无效请求。
 * 这样做的理由是 `PBFSolver` 会在构造时按 `smoothingRadius` 预算核函数常数与哈希格边长，
 * 少传一个字段就会让 worker 用的核函数与主线程不同 —— 那是最难发现的一类不一致。
 */
export interface FluidStepRequest {
  /** 请求 id：主线程自增；迟到/超时之后到达的回包靠它被丢弃 */
  id: number;
  kind: 'step';
  /** 本帧推进的秒数（与主线程同步路径是同一个值） */
  dt: number;
  /** 求解器的时间预算（毫秒）。语义与 `PBFSolver.step` 的第三个参数完全一致 */
  budgetMs: number;
  settings: PBFSettings;
  boundarySnapshot: FluidBoundarySnapshot;
  pool: FluidPoolBuffers;
}

/**
 * 取消请求。
 *
 * ⚠ 语义与冲突检测那边**不一样**，必须说清楚：
 * 流体 worker 的 `handle()` 是**同步**的（见 `fluidWorkerCore.ts` 的注释：
 * 每次求解只有几毫秒，为了留取消窗口而让出一个宏任务会白白加上一次定时器延迟）。
 * 于是"取消正在算的那一次"在 worker 侧**不可能生效** —— 求解期间消息队列不会被处理，
 * 迟到的那条 cancel 只能赶在下一次任务之前被读到。
 * 主线程侧的 `FluidWorkerRunner.cancel()` 因此被实现为"不再等 worker，改走同步路径"，
 * 结果永远是真的（见那里的注释）。
 */
export interface FluidCancelRequest {
  id: number;
  kind: 'cancel';
}

export type FluidRequest = FluidStepRequest | FluidCancelRequest;

/**
 * worker 侧的耗时与统计。
 *
 * `solveMs` 是**真的花在 `PBFSolver.step` 上的毫秒数**（不含解包、不含回包搬运），
 * `prepareMs` 是"把快照变成可查询边界 + 把粒子灌进池子"的毫秒数。
 * 分开量是因为它们花的是同一条 worker 线程：只有知道各自多少，
 * 才知道"worker 到底把多少时间从主线程挪走了"。
 */
export interface FluidWorkerStats {
  substeps: number;
  simulatedSeconds: number;
  solveMs: number;
  prepareMs: number;
  /** 求解器自己的分项统计（与主线程同步路径是同一个类型、同一批字段） */
  solver: PBFStats;
}

export interface FluidOkResponse {
  id: number;
  ok: true;
  pool: FluidPoolDelta;
  stats: FluidWorkerStats;
}

export interface FluidErrorResponse {
  id: number;
  ok: false;
  /** `error.message` 原样回传，不加工、不吞 */
  error: string;
}

export type FluidResponse = FluidOkResponse | FluidErrorResponse;

/**
 * Worker 全局作用域里我们用到的那一小部分。
 *
 * 直接从 `workerTypes.ts` 复用：它是通用的（`onmessage` + `postMessage`），
 * 描述的不是"冲突检测"，而"浏览器 worker 全局作用域"。复制一份只会多一处需要同步修改的地方。
 */
export type { WorkerScopeLike } from './workerTypes';
