/**
 * 粒子流体 Worker 的核心逻辑（M4 第 7 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么把逻辑放在 core、入口只做接线
 * ────────────────────────────────────────────────────────────
 * 与冲突检测那一批完全同一个理由：本轮环境里**没有浏览器、也没有 Node 的 `Worker` 全局对象**
 * （Node 的 `worker_threads` 不是浏览器 Worker：模块格式、消息协议、全局作用域都不同，
 * 拿它冒充只会得到一个"看起来测过了"的假结论）。
 *
 * 所以「worker 里到底算了什么」只能这样证明：把请求处理逻辑写成这里的
 * `runStep()` + `FluidWorkerBackend`，入口 `fluidWorker.ts` 只负责把它挂到 `self.onmessage`。
 * 断言脚本在 Node 里直接 import 这个文件，用**结构化克隆过一遍**的请求跑它，
 * 再与主线程同步路径逐位比较 —— 验的就是"worker 里那段代码"，而不是它的仿制品。
 *
 * ────────────────────────────────────────────────────────────
 * 边界到底怎么了：能搬的、搬不动的
 * ────────────────────────────────────────────────────────────
 * `PBFSolver.resolveCollisions` 对边界的全部依赖只有三件事（逐行读过）：
 * 四个标量（halfX / halfZ / minY / maxY）、`isSolid` 在"中心 ± 半径"六个探针点上的取值、
 * 以及中心已在固体内时 `escapeDirection` 的逐步外扩查询。**它不读地形 id、不读水量、
 * 不做射线、不关心格子归属**。所以只要快照能在**任意世界浮点坐标**上回答同一个布尔函数，
 * 求解行为就完全一致 —— 这正是 `unpackBoundary` 要保证的事。
 *
 * 做不到的那一件事：**实时性**。`isSolid` 闭包读的是"此刻"的网格与建筑索引，
 * 快照只能冻结"打包那一刻"。主线程在等回包期间改了地形，worker 用的就是旧地形。
 * 这一点无法靠协议弥补（除非把地形改动也同步过去），所以如实写在
 * `FluidWorkerRunner` 的注释与交付报告里。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么用位图而不是"重建一个真实 VoxelGrid"
 * ────────────────────────────────────────────────────────────
 * 冲突检测那一批的做法是"快照 → `new VoxelGrid()` + 逐格 `setVoxel` 重建"，
 * 好处是 worker 里跑的是**同一个** `VoxelGrid` 类，查询逻辑一行都不用重写。
 * 这里**故意没照抄**，理由是量级不同：那边的快照只装非空气格（新手档 2.2 万格），
 * 而流体边界必须能回答空气区域的查询（水从空中落下时探针落在空气里），
 * 所以只能整网格重建 —— 大世界 192×32×192 是 118 万格，
 * 按那边注释里记下的 `setVoxel` 速率（62 万格 124~133 ms）推算就是每帧 200 ms 以上，
 * 而这 118 万格里 99% 是空气。位图把这个成本降到"一趟线性扫描 + 每格一次查表"。
 *
 * 代价必须如实说：`unpackBoundary` 里的查询是**重写**的一段（不是 `VoxelGrid` 的实现），
 * 也就是存在"与 `VoxelGrid` 漂移"的风险。这个风险靠断言兜住：
 * `fluidworker.check.ts` 会把**整张网格的每一个格点**与一批随机采样点都拿去问两个边界，
 * 逐点比对答案。漂移一旦发生，那条断言会红。
 */

import { AIR, isLiquid } from '../data/voxelTypes';
import type { FluidBoundary, PBFSettings } from '../fluid/PBFSolver';
import { PBFSolver } from '../fluid/PBFSolver';
import { ParticlePool } from '../fluid/ParticlePool';
import { CHUNK_AREA, CHUNK_SIZE } from '../voxel/Chunk';
import type { VoxelGrid } from '../voxel/VoxelGrid';
import type {
  FluidBoundaryInput,
  FluidBoundaryParams,
  FluidBoundarySnapshot,
  FluidBoundarySource,
  FluidErrorResponse,
  FluidOkResponse,
  FluidPoolBuffers,
  FluidPoolDelta,
  FluidResponse,
  FluidStepRequest,
  FluidWorkerStats,
  WorkerScopeLike,
} from './fluidWorkerTypes';

/**
 * 体素 id → "是不是固体"的查表。
 *
 * `Engine.fluidBoundary()` 的地形分支是 `id !== AIR && !isLiquid(id)`；
 * 这两次判断在打包热路径上要跑 118 万次，而 `isLiquid` 内部是
 * "数组下标取定义 + 读属性"，比一次 `Uint8Array` 下标贵得多。预表之后内层循环只剩一次查表。
 *
 * 表长 256 而不是更长：体素 id 存在 `Uint8Array` 里，取值天然是 0~255。
 * 未知 id 的 `getVoxelDef` 会回落到 air 定义（`isLiquid` 为 false），
 * 于是它也落在"固体"这一侧 —— 与引擎的行为一致（引擎那边同样会判 true）。
 */
const SOLID_LUT: Uint8Array = buildSolidLut();

function buildSolidLut(): Uint8Array {
  const lut = new Uint8Array(256);
  for (let id = 0; id < 256; id += 1) {
    lut[id] = id !== AIR && !isLiquid(id) ? 1 : 0;
  }
  return lut;
}

/** 结构上判断"给的是来源描述还是裸网格"：`FluidBoundarySource` 一定有 `grid` 字段 */
function isBoundarySource(input: FluidBoundaryInput): input is FluidBoundarySource {
  const grid = (input as { grid?: unknown }).grid;
  return typeof grid === 'object' && grid !== null;
}

// ------------------------------------------------------------------ 边界：打包

/**
 * 把地形 + 建筑打包成可克隆的快照（**主线程调用**）。
 *
 * ── 打包成本与缓存 ──
 * 这是一趟对**全世界体素**的线性扫描（大世界 118 万格）。它比冲突检测那边的打包贵得多
 * （那边只扫非空气格），所以调用方**不应该每帧调用它**：
 * `FluidWorkerRunner` 用 `grid.editRevision` 当键做缓存，地形没变就复用上一次的快照。
 * 什么时候会变：任何 `setVoxel` / `setWaterLevel` / `clear` / `recount` 都会 +1 revision；
 * 沙/水的元胞自动机、笔刷、地形生成都走这些入口（`GridWriter` 最后也会 `recount()`），
 * 所以缓存不会读到旧地形。
 *
 * ⚠ **必须如实记下的一点**：如果主线程每帧都在改体素（沙在流动、水在渗），
 * revision 每帧都变、缓存每帧失效 —— 那时这个打包成本是**每帧**都付的，
 * worker 路径很可能整体不划算。真实数字见交付报告，不要在没量过的情况下假设它便宜。
 *
 * @param input 地形网格，或"网格 + 建筑障碍"的来源描述
 * @param params 边界四标量。**不传时从网格推**（halfX = sizeX/2、minY = 0、maxY = sizeY），
 *               这正是 `Engine.fluidBoundary()` 的取值；调用方应当把真实边界传进来，
 *               免得快照与真实边界在"墙在哪、天花板多高"上悄悄分叉。
 */
export function packBoundary(
  input: FluidBoundaryInput,
  params?: Partial<FluidBoundaryParams>,
): FluidBoundarySnapshot {
  const obstaclesIncluded = isBoundarySource(input);
  const source: FluidBoundarySource = obstaclesIncluded ? input : { grid: input, obstacles: [] };
  const grid = requireGrid(source.grid);

  const sizeX = grid.sizeX;
  const sizeY = grid.sizeY;
  const sizeZ = grid.sizeZ;
  const chunksX = grid.chunksX;
  const chunksZ = grid.chunksZ;
  const cellsPerChunk = CHUNK_AREA * sizeY;
  const wordsPerChunk = Math.ceil(cellsPerChunk / 32);

  const solidBits = new Uint32Array(chunksX * chunksZ * wordsPerChunk);

  for (let cz = 0; cz < chunksZ; cz += 1) {
    for (let cx = 0; cx < chunksX; cx += 1) {
      const chunk = grid.getChunk(cx, cz);
      if (chunk === undefined) continue;
      const data = chunk.voxels;
      const chunkBase = (cz * chunksX + cx) * wordsPerChunk;
      // 逐 word 扫：内层固定 32 次，省掉"每格判一次 bit 回绕"的分支。
      // `chunk.voxels` 的长度就是 cellsPerChunk（16×sizeY×16），所以不会越界读。
      for (let w = 0; w < wordsPerChunk; w += 1) {
        const cellBase = w * 32;
        let word = 0;
        for (let b = 0; b < 32; b += 1) {
          // AIR 的 LUT 值就是 0，所以这里不需要再单独判一次 id !== AIR
          if (SOLID_LUT[data[cellBase + b]!] === 1) word |= 1 << b;
        }
        if (word !== 0) solidBits[chunkBase + w] = word;
      }
    }
  }

  const boxes = source.obstacles;
  const obstacleBounds = new Float32Array(boxes.length * 6);
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i]!;
    const at = i * 6;
    obstacleBounds[at] = box.minX;
    obstacleBounds[at + 1] = box.maxX;
    obstacleBounds[at + 2] = box.minY;
    obstacleBounds[at + 3] = box.maxY;
    obstacleBounds[at + 4] = box.minZ;
    obstacleBounds[at + 5] = box.maxZ;
  }

  return {
    halfX: pickNumber(params?.halfX, sizeX / 2),
    halfZ: pickNumber(params?.halfZ, sizeZ / 2),
    minY: pickNumber(params?.minY, 0),
    maxY: pickNumber(params?.maxY, sizeY),
    sizeX,
    sizeY,
    sizeZ,
    chunksX,
    chunksZ,
    wordsPerChunk,
    solidBits,
    obstacleBounds,
    obstaclesIncluded,
    originX: sizeX / 2,
    originZ: sizeZ / 2,
  };
}

function pickNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 收窄"像不像一个体素网格"。
 *
 * 用方法存在性判断而不是 `instanceof VoxelGrid`：断言与测试里常常用轻量替身，
 * `instanceof` 会把它们全部拒掉。这里只要求打包真正会用到的成员存在。
 * 不像网格就**抛中文错误** —— 静默返回一份空快照会让水直接穿过整个地形，
 * 那比一个明确的报错难查得多。
 */
function requireGrid(value: unknown): VoxelGrid {
  if (value === null || typeof value !== 'object') {
    throw new Error(
      `packBoundary: 需要 VoxelGrid 或 { grid, obstacles }，收到的是 ${describeValue(value)}`,
    );
  }
  const record = value as Record<string, unknown>;
  if (typeof record['getChunk'] !== 'function' || typeof record['chunkList'] !== 'object') {
    throw new Error('packBoundary: 对象缺少 getChunk / chunkList，不像一个 VoxelGrid');
  }
  if (
    !Number.isInteger(record['sizeX']) ||
    !Number.isInteger(record['sizeY']) ||
    !Number.isInteger(record['sizeZ'])
  ) {
    throw new Error('packBoundary: 网格尺寸不是整数，无法打包');
  }
  return value as VoxelGrid;
}

// ------------------------------------------------------------------ 边界：解包

/**
 * 用快照重建一个可查询的边界（**worker 侧调用**，也是断言里跑的那一段）。
 *
 * 查询的分支顺序与 `Engine.fluidBoundary().isSolid` 逐条对应
 * （越界 → 地形 → 建筑），因为顺序会影响**结果**而不只是速度：
 * 引擎先判"y < 0 是固体"，所以掉到世界底面以下的粒子会被当成撞到东西推回来，
 * 而不是先被当成"越界"放过。
 */
export function unpackBoundary(snapshot: FluidBoundarySnapshot): FluidBoundary {
  const {
    sizeX,
    sizeY,
    sizeZ,
    chunksX,
    wordsPerChunk,
    solidBits,
    obstacleBounds,
    originX,
    originZ,
    halfX,
    halfZ,
    minY,
    maxY,
  } = snapshot;
  const boxCount = Math.floor(obstacleBounds.length / 6);

  return {
    halfX,
    halfZ,
    minY,
    maxY,
    isSolid(x: number, y: number, z: number): boolean {
      // 1) 世界底面以下：引擎那边 `y < 0` 直接判固体（`getVoxel` 也返回虚拟基岩）
      if (y < 0) return true;
      // 2) 高过世界：引擎那边 `y >= sizeY` 判非固体（粒子飞出天花板不算撞墙）
      if (y >= sizeY) return false;
      // 3) 水平越界：引擎那边 `!inHorizontalBounds` 判固体（世界四周是墙）
      const vx = Math.floor(x + originX);
      const vz = Math.floor(z + originZ);
      if (vx < 0 || vx >= sizeX || vz < 0 || vz >= sizeZ) return true;
      // 4) 地形：非空气且非液体才算固体（旧的水体素不挡粒子流体）。
      //    坐标换算与 `Chunk.index(lx, y, lz)` 用的是同一组常数，不写死 16 / 256。
      const vy = Math.floor(y);
      const cx = (vx / CHUNK_SIZE) | 0;
      const cz = (vz / CHUNK_SIZE) | 0;
      const local =
        vx - cx * CHUNK_SIZE + (vz - cz * CHUNK_SIZE) * CHUNK_SIZE + vy * CHUNK_AREA;
      const word = solidBits[(cz * chunksX + cx) * wordsPerChunk + (local >>> 5)]!;
      if ((word & (1 << (local & 31))) !== 0) return true;
      // 5) 建筑：线性扫全部盒。
      //
      // 引擎那边是"按 16 米桶查表、只看那一桶里的盒"，这里退化成一趟线性扫描。
      // 两者回答**完全相同**：点在某个盒内 ⇒ 该盒一定被登记进了这个点所在的桶
      // （登记时按盒的 minX..maxX 覆盖到的所有桶各注册一次，而 floor 单调，
      // 所以点所在的桶必定在覆盖范围内），于是"桶里出现过"这个前置条件恒成立，
      // 剩下的判断就只是在不在盒里 —— 与线性扫描是同一个谓词。
      // 差别只有速度：盒通常是几十个量级（引擎那边一次查询只看一个桶里的几个），
      // 本轮**没有**测过障碍盒数量很多时的查询开销，不在这里编数字。
      for (let i = 0; i < boxCount; i += 1) {
        const at = i * 6;
        if (x < obstacleBounds[at]! || x > obstacleBounds[at + 1]!) continue;
        if (y < obstacleBounds[at + 2]! || y > obstacleBounds[at + 3]!) continue;
        if (z < obstacleBounds[at + 4]! || z > obstacleBounds[at + 5]!) continue;
        return true;
      }
      return false;
    },
  };
}

// ------------------------------------------------------------------ 粒子池搬运

/**
 * 把主线程的粒子池打包成可转移的数组（**主线程调用**）。
 *
 * 只取 `[0, highWater)` 这一段：求解器的每一次遍历上界都是 highWater，
 * 后面的下标永远是死的（`alive === 0`），搬过去只是白花钱。
 *
 * ⚠ 用 `slice` **复制**，不能用 `subarray`：`subarray` 与原数组共享同一个
 * `ArrayBuffer`，把它放进 transfer 列表就等于把主线程粒子池的缓冲区一起"搬走"，
 * 主线程那一侧的数组会当场变成 detached（长度 0、内容全没）。
 * 复制是这次搬运里唯一无法省掉的一次 O(n) 内存拷贝。
 */
export function packPool(pool: ParticlePool): FluidPoolBuffers {
  const n = pool.highWater;
  return {
    capacity: pool.capacity,
    highWater: n,
    count: pool.count,
    posX: pool.posX.slice(0, n),
    posY: pool.posY.slice(0, n),
    posZ: pool.posZ.slice(0, n),
    velX: pool.velX.slice(0, n),
    velY: pool.velY.slice(0, n),
    velZ: pool.velZ.slice(0, n),
    frozen: pool.frozen.slice(0, n),
    alive: pool.alive.slice(0, n),
  };
}

/**
 * 把 worker 回传的数组写回主线程的粒子池（**主线程调用**）。
 *
 * 校验刻意做得**很严**（容量、highWater、活跃粒子数必须逐项相等），
 * 因为这些数字只要有一个对不上，写回去的数组就会**整体错位**：
 * 那不会抛异常、不会 NaN，只会让水莫名其妙地瞬移。宁可在这里抛一个中文错误，
 * 让调用方降级重算一次。
 *
 * 写回的内容只有 pos/vel：`prev` 在下一次 `predict()` 里会被无条件重写，
 * `frozen` / `alive` 在求解器里根本不会被改动。
 */
export function applyPoolDelta(pool: ParticlePool, delta: FluidPoolDelta): void {
  if (delta.capacity !== pool.capacity) {
    throw new Error(
      `回包里的粒子池容量（${delta.capacity}）与主线程的池子（${pool.capacity}）不一致，拒绝写回`,
    );
  }
  if (delta.highWater !== pool.highWater) {
    throw new Error(
      `回包里的下标水位（${delta.highWater}）与主线程的池子（${pool.highWater}）不一致：` +
        '等待期间池子被改动过，写回会让粒子错位，拒绝写回',
    );
  }
  if (delta.count !== pool.count) {
    throw new Error(
      `回包里的活跃粒子数（${delta.count}）与主线程的池子（${pool.count}）不一致，拒绝写回`,
    );
  }
  const n = delta.highWater;
  pool.posX.set(delta.posX.subarray(0, n), 0);
  pool.posY.set(delta.posY.subarray(0, n), 0);
  pool.posZ.set(delta.posZ.subarray(0, n), 0);
  pool.velX.set(delta.velX.subarray(0, n), 0);
  pool.velY.set(delta.velY.subarray(0, n), 0);
  pool.velZ.set(delta.velZ.subarray(0, n), 0);
}

/**
 * 把一个搬运包灌进（worker 侧的）粒子池，并且**逐位还原下标**。
 *
 * ── 为什么必须逐位还原，而不是简单地"按存活粒子重新生成" ──
 * 求解器的空间哈希、邻居缓存、密度数组全都是**按下标**索引的，
 * 而且 `SpatialHash.build` 的遍历上界是 `highWater` 而不是活跃粒子数 ——
 * 也就是说"活跃粒子在第 9000 号、前 8999 号是空的"这种形态是被正常处理的，
 * 它决定了邻居遍历实际扫过哪些下标。下标一旦错位，结果就不再逐位一致。
 *
 * 还原办法（`ParticlePool` 的空闲链表是私有的，只能走公开 API）：
 * 1. `clear()`：alive/frozen 清零、highWater 归零、空闲链表重建成"从 0 开始顺序分配"；
 * 2. `spawn()` 恰好 `highWater` 次：下标 0..highWater-1 被**顺序**分配，
 *    `highWater` 也正好等于目标值（`spawn` 内部按 `index + 1 > high` 维护）；
 * 3. 把源掩码里 `alive === 0` 的下标 `kill()` 掉：`count` 与存活集合还原。
 *    ⚠ 顺序不能颠倒：`kill()` 对"已经标成不活跃"的下标直接返回 false，
 *    先写 `alive` 数组的话计数就不会被扣，`count` 会偏大。
 * 4. 最后写数组内容（位置/速度/掩码）。
 *
 * 代价：`spawn` 是每个下标一次函数调用，花在 worker 线程上（不阻塞主线程），
 * 与冲突检测那边"每个非空气格一次 setVoxel"是同一类账。真实数字见交付报告。
 */
function fillPool(pool: ParticlePool, buffers: FluidPoolBuffers): void {
  const { capacity, highWater, count } = buffers;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(`搬运包里 capacity 非法（${String(capacity)}）`);
  }
  if (!Number.isInteger(highWater) || highWater < 0 || highWater > capacity) {
    throw new Error(`搬运包里 highWater 非法（${String(highWater)}，容量 ${capacity}）`);
  }
  if (!Number.isInteger(count) || count < 0 || count > highWater) {
    throw new Error(`搬运包里 count 非法（${String(count)}，水位 ${highWater}）`);
  }
  const pairs: ReadonlyArray<readonly [string, Float32Array | Uint8Array]> = [
    ['posX', buffers.posX],
    ['posY', buffers.posY],
    ['posZ', buffers.posZ],
    ['velX', buffers.velX],
    ['velY', buffers.velY],
    ['velZ', buffers.velZ],
    ['frozen', buffers.frozen],
    ['alive', buffers.alive],
  ];
  for (const [name, array] of pairs) {
    if (array.length !== highWater) {
      throw new Error(`搬运包里 ${name} 的长度（${array.length}）与 highWater（${highWater}）不一致`);
    }
  }

  pool.clear();
  for (let i = 0; i < highWater; i += 1) {
    const assigned = pool.spawn(0, 0, 0);
    if (assigned !== i) {
      throw new Error(`重建粒子池时下标错位（期望 ${i}，实际 ${assigned}）—— 池子状态异常`);
    }
  }
  for (let i = 0; i < highWater; i += 1) {
    if (buffers.alive[i] !== 1) pool.kill(i);
  }
  pool.alive.set(buffers.alive, 0);
  pool.frozen.set(buffers.frozen, 0);
  pool.posX.set(buffers.posX, 0);
  pool.posY.set(buffers.posY, 0);
  pool.posZ.set(buffers.posZ, 0);
  pool.velX.set(buffers.velX, 0);
  pool.velY.set(buffers.velY, 0);
  pool.velZ.set(buffers.velZ, 0);

  if (pool.highWater !== highWater || pool.count !== count) {
    throw new Error(
      `重建后的池子状态不对（水位 ${pool.highWater} 期望 ${highWater}，活跃 ${pool.count} 期望 ${count}）`,
    );
  }
}

/** 从 worker 侧池子里取出要回传的 6 个数组（复制一份，因为原数组还要留给下一次求解） */
function packDelta(pool: ParticlePool): FluidPoolDelta {
  const n = pool.highWater;
  return {
    capacity: pool.capacity,
    highWater: n,
    count: pool.count,
    posX: pool.posX.slice(0, n),
    posY: pool.posY.slice(0, n),
    posZ: pool.posZ.slice(0, n),
    velX: pool.velX.slice(0, n),
    velY: pool.velY.slice(0, n),
    velZ: pool.velZ.slice(0, n),
  };
}

// ------------------------------------------------------------------ 设置搬运

/**
 * `PBFSettings` 的字段清单。
 *
 * 显式列出来而不是 `Object.assign`：请求是跨线程的输入，
 * 原样合并会把未知字段、`NaN`、字符串一起塞进求解器的 settings（求解器对它们没有防御），
 * 结果悄悄全错。默认值交给 `PBFSolver` 的构造函数合并 —— 这里一个默认值都不抄。
 */
const SETTINGS_KEYS = [
  'smoothingRadius',
  'restDensity',
  'particleMass',
  'particleRadius',
  'iterations',
  'viscosity',
  'surfaceTension',
  'gravity',
  'maxStepSeconds',
  'maxSpeed',
  'damping',
  'maxCorrectionRatio',
  'wallFriction',
] as const;

/** 校验并收窄一份 settings；任何缺字段/非有限数都抛中文错误（宁可拒绝，也不要半份设置） */
export function readSettings(value: unknown): PBFSettings {
  if (value === null || typeof value !== 'object') {
    throw new Error(`请求里的 settings 不是对象（${describeValue(value)}）`);
  }
  const record = value as Record<string, unknown>;
  const missing: string[] = [];
  for (const key of SETTINGS_KEYS) {
    const field = record[key];
    if (typeof field !== 'number' || !Number.isFinite(field)) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `请求里的 settings 缺少这些字段或它们的值不是有限数：${missing.join('、')}。` +
        '必须传完整的 PBFSettings（求解器按 smoothingRadius 预算核函数常数，少一个字段就会与主线程不一致）',
    );
  }
  return value as PBFSettings;
}

/**
 * 把一份 settings 覆盖到求解器自己的 settings 对象上（求解器实例会被复用，所以是就地覆盖）。
 *
 * **导出**给主线程的同步回退路径用，这不是为了方便，而是为了"两条路径用同一段代码覆盖设置"：
 * 分别写两遍（例如一侧 `Object.assign`、一侧逐字段）在字段语义上就可能分叉，
 * 而分叉的后果是两条路径的物理参数不同 —— 那恰好破坏了本轮最重要的保证。
 */
export function copySettingsInto(target: PBFSettings, source: PBFSettings): void {
  for (const key of SETTINGS_KEYS) {
    target[key] = source[key];
  }
}

// ------------------------------------------------------------------ 形状校验（两边共用）

export function isFluidBoundarySnapshot(value: unknown): value is FluidBoundarySnapshot {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record['sizeX']) &&
    Number.isInteger(record['sizeY']) &&
    Number.isInteger(record['sizeZ']) &&
    Number.isInteger(record['chunksX']) &&
    Number.isInteger(record['chunksZ']) &&
    Number.isInteger(record['wordsPerChunk']) &&
    typeof record['halfX'] === 'number' &&
    typeof record['halfZ'] === 'number' &&
    typeof record['minY'] === 'number' &&
    typeof record['maxY'] === 'number' &&
    typeof record['originX'] === 'number' &&
    typeof record['originZ'] === 'number' &&
    typeof record['obstaclesIncluded'] === 'boolean' &&
    record['solidBits'] instanceof Uint32Array &&
    record['obstacleBounds'] instanceof Float32Array
  );
}

export function isFluidPoolBuffers(value: unknown): value is FluidPoolBuffers {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record['capacity']) &&
    Number.isInteger(record['highWater']) &&
    Number.isInteger(record['count']) &&
    record['posX'] instanceof Float32Array &&
    record['posY'] instanceof Float32Array &&
    record['posZ'] instanceof Float32Array &&
    record['velX'] instanceof Float32Array &&
    record['velY'] instanceof Float32Array &&
    record['velZ'] instanceof Float32Array &&
    record['frozen'] instanceof Uint8Array &&
    record['alive'] instanceof Uint8Array
  );
}

function isFluidPoolDelta(value: unknown): value is FluidPoolDelta {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const highWater = record['highWater'];
  if (
    !Number.isInteger(record['capacity']) ||
    !Number.isInteger(highWater) ||
    !Number.isInteger(record['count'])
  ) {
    return false;
  }
  const names = ['posX', 'posY', 'posZ', 'velX', 'velY', 'velZ'] as const;
  for (const name of names) {
    const array = record[name];
    if (!(array instanceof Float32Array)) return false;
    // 长度必须与 highWater 精确相等：差一格就说明回包被截断过，写回会让粒子错位
    if (array.length !== highWater) return false;
  }
  return true;
}

/**
 * 回包形状校验（主线程用）。
 *
 * worker 回包是**跨线程的不可信输入**。形状不对却照样当结果用，
 * 表现是"水突然少了一半"或"粒子瞬移到原点"这类更难查的问题；
 * 形状不对就当场判为无效、走同步回退，代价只是一次多余的计算。
 */
export function isFluidResponse(value: unknown): value is FluidResponse {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record['id'])) return false;
  if (record['ok'] === false) return typeof record['error'] === 'string';
  if (record['ok'] !== true) return false;
  if (!isFluidPoolDelta(record['pool'])) return false;
  const stats = record['stats'];
  if (stats === null || typeof stats !== 'object') return false;
  const statsRecord = stats as Record<string, unknown>;
  return (
    typeof statsRecord['substeps'] === 'number' &&
    typeof statsRecord['simulatedSeconds'] === 'number' &&
    typeof statsRecord['solveMs'] === 'number' &&
    typeof statsRecord['prepareMs'] === 'number' &&
    statsRecord['solver'] !== null &&
    typeof statsRecord['solver'] === 'object'
  );
}

export function isFluidStepRequest(value: unknown): value is FluidStepRequest {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['dt'] === 'number' &&
    Number.isFinite(record['dt']) &&
    typeof record['budgetMs'] === 'number' &&
    !Number.isNaN(record['budgetMs']) &&
    isFluidBoundarySnapshot(record['boundarySnapshot']) &&
    isFluidPoolBuffers(record['pool'])
  );
}

function readRequestId(value: unknown): number {
  if (value === null || typeof value !== 'object') return -1;
  const id = (value as Record<string, unknown>)['id'];
  return typeof id === 'number' ? id : -1;
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

// ------------------------------------------------------------------ worker 侧运行时缓存

/**
 * worker 线程上复用的"粒子池 + 求解器"对。
 *
 * ── 为什么必须复用 ──
 * `new PBFSolver(...)` 会为 20000 粒子分配邻居缓存 4 组 × 20000 × 32 × 4 字节 ≈ 10 MB，
 * 每帧重建等于每帧让 worker 自己也产生 10 MB 垃圾；`new ParticlePool` 再补十来个数组。
 * 复用之后每个请求只是把数据灌回同一批数组。
 *
 * ── 为什么缓存键是"容量 + 平滑半径" ──
 * `PBFSolver` 在**构造时**就把 `smoothingRadius` 烘进了核函数常数（Poly6 / Spiky 的系数）
 * 与空间哈希的格边长（`new SpatialHash(h, capacity)`），这两样之后再改 settings 也不会更新。
 * 只按容量做键，一旦调用方改了 h（LOD / 预设切换）就会继续用错的核函数算 ——
 * 那是一种"看起来还在动、物理其实已经换了"的错，最难查。
 *
 * ── 复用的安全性 ──
 * `PBFSolver.step()` 对同一份输入是**纯函数**：所有跨步状态
 * （boundaryHits / speedClamps / correctionClamps / stuckParticles / candidateVisits）
 * 要么在 `step` 开头清零、要么被整段覆盖；`hash.build` 每次重建；
 * `neighborCounts` 每次 `fill(0)`；`deltaV*` 每次 `fill(0)`；`prev*` 在 `predict` 里重写。
 * 也就是说"复用实例"与"每次新建实例"结果逐位相同 —— 这条有断言兜底。
 *
 * ⚠ **容量必须与主线程一致，这是"逐位一致"的前提之一**：空间哈希的桶数由 `capacity`
 * 派生（`ceilPow2`），桶数一变，哈希冲突的分布就变，"一个桶里混进远处粒子"的顺序也变；
 * 而邻居缓存按 `maxNeighbors = 32` 截断，候选顺序变了就可能截断出不同的邻居集合。
 * 所以 `acquireRuntime` 的键里有 capacity，搬运包里的 capacity 也是主线程池子的真实容量。
 */
interface FluidWorkerRuntime {
  capacity: number;
  smoothingRadius: number;
  pool: ParticlePool;
  solver: PBFSolver;
}

let runtime: FluidWorkerRuntime | null = null;

function acquireRuntime(capacity: number, smoothingRadius: number): FluidWorkerRuntime {
  if (runtime !== null && runtime.capacity === capacity && runtime.smoothingRadius === smoothingRadius) {
    return runtime;
  }
  const pool = new ParticlePool(capacity);
  // 只传 smoothingRadius 构造，其余字段每个请求都会整份覆盖上去（见 copySettingsInto）
  const solver = new PBFSolver(pool, { smoothingRadius });
  runtime = { capacity, smoothingRadius, pool, solver };
  return runtime;
}

/** 丢掉 worker 侧缓存的运行时（断言里用来模拟"冷启动 / 不复用实例"这一路） */
export function resetWorkerRuntime(): void {
  runtime = null;
}

// ------------------------------------------------------------------ 求解

/**
 * 跑一次求解，并把粒子池相关数组回传（**worker 侧调用**，也是断言里跑的那一段）。
 *
 * 步骤与耗时分开记：
 * - `prepareMs`：快照 → 可查询边界 + 粒子灌进池子 + settings 覆盖；
 * - `solveMs`：`PBFSolver.step` 本身。
 * 只有分开量才知道"worker 从主线程挪走了多少"与"worker 自己花在搬运上的有多少"。
 *
 * 抛错（而不是返回 ok:false）：错误到 `FluidWorkerBackend` 那一层统一转成回包，
 * 这样 `runStep` 保持"要么给出完整结果、要么抛"的简单契约。
 */
export function runStep(request: FluidStepRequest): FluidOkResponse {
  const prepareStartedAt = now();
  const boundary = unpackBoundary(request.boundarySnapshot);
  const active = acquireRuntime(request.pool.capacity, request.settings.smoothingRadius);
  fillPool(active.pool, request.pool);
  copySettingsInto(active.solver.settings, request.settings);
  const prepareMs = now() - prepareStartedAt;

  const solveStartedAt = now();
  const run = active.solver.step(request.dt, boundary, request.budgetMs);
  const solveMs = now() - solveStartedAt;

  const stats: FluidWorkerStats = {
    substeps: run.substeps,
    simulatedSeconds: run.simulatedSeconds,
    solveMs,
    prepareMs,
    solver: active.solver.stats,
  };

  return { id: request.id, ok: true, pool: packDelta(active.pool), stats };
}

// ------------------------------------------------------------------ 后端

/**
 * Worker 侧的请求处理器。
 *
 * `handle()` 是**同步**的，这一点与冲突检测那边（`async` + 让出一个宏任务）刻意不同：
 * 流体求解是每帧调用的活，为了留一个"取消还没开始的任务"的窗口而让出一次宏任务，
 * 等于给每一帧都加上一次定时器延迟（浏览器定时器分辨率通常是 1~4 ms，
 * 而这一帧的求解预算本身只有 4 ms）。取消的代价见 `FluidCancelRequest` 的注释。
 */
export class FluidWorkerBackend {
  /** 还没开始算就被取消的请求 id（用 Set：多条取消消息可能先于它们对应的任务到达） */
  private readonly cancelled = new Set<number>();

  /**
   * 处理一条消息。
   *
   * @returns 回包；`cancel` 消息本身不产生回包（返回 `null`）——
   *          它影响的是**后面**那条还没开始算的 `step`。
   */
  handle(raw: unknown): FluidResponse | null {
    if (raw === null || typeof raw !== 'object') {
      return { id: -1, ok: false, error: `worker 收到的消息不是对象（${describeValue(raw)}）` };
    }
    const record = raw as Record<string, unknown>;
    const id = readRequestId(record);
    const kind = record['kind'];

    if (kind === 'cancel') {
      this.cancelled.add(id);
      return null;
    }
    if (kind !== 'step') {
      return { id, ok: false, error: `未知的任务类型：${describeValue(kind)}（只支持 step / cancel）` };
    }
    if (!isFluidStepRequest(raw)) {
      return {
        id,
        ok: false,
        error:
          '请求形状不合法：需要有限的 dt 与 budgetMs，以及合法的 boundarySnapshot（Uint32Array solidBits、' +
          'Float32Array obstacleBounds）与 pool（6 个 Float32Array + frozen/alive 两个 Uint8Array）',
      };
    }

    try {
      // 取消判断放在最前面：取消的价值就是"别做这一帧的活"，
      // 先做设置校验再判取消会让一次无效请求的逻辑顺序变得难以解释。
      if (this.cancelled.delete(id)) {
        return {
          id,
          ok: false,
          error:
            '任务在开始计算前就被 cancel() 取消了（没有产出结果；这不等于「粒子没动」，' +
            '主线程会改走同步路径把这一帧算出来）',
        };
      }
      const settings = readSettings(record['settings']);
      return runStep({ ...raw, settings });
    } catch (error) {
      // error.message 原样回传：吞掉会让主线程把"跑挂了"误读成"这一帧粒子没动"
      return { id, ok: false, error: describeError(error) };
    }
  }
}

/**
 * 能转移给 worker 的缓冲区。
 *
 * 用 `instanceof` 而不是直接断言：`TypedArray.buffer` 的类型是 `ArrayBufferLike`
 * （可能是 `SharedArrayBuffer`，而它**不能**转移）。真出现时就不转移，
 * 退化成结构化克隆（会复制一份）—— 结果一样，只是慢一点。
 */
function transferableOf(response: FluidResponse | null): Transferable[] {
  if (response === null || !response.ok) return [];
  const buffers: Transferable[] = [];
  const { pool } = response;
  const views: ArrayBufferView[] = [pool.posX, pool.posY, pool.posZ, pool.velX, pool.velY, pool.velZ];
  for (const view of views) {
    if (view.buffer instanceof ArrayBuffer) buffers.push(view.buffer);
  }
  return buffers;
}

/**
 * 把后端挂到 worker 全局作用域上（入口的唯一一行）。
 *
 * 抽成函数是为了可测：断言脚本传一个假的 scope 进来，
 * 「消息进来 → 计算 → 回包」这条接线在 Node 里就能被真跑一遍。
 */
export function attachWorkerScope(scope: WorkerScopeLike): void {
  const backend = new FluidWorkerBackend();
  scope.onmessage = (event: { data: unknown }): void => {
    const id = readRequestId(event.data);
    let response: FluidResponse | null;
    try {
      response = backend.handle(event.data);
    } catch (error) {
      response = { id, ok: false, error: describeError(error) };
    }
    if (response === null) return;
    try {
      scope.postMessage(response, transferableOf(response));
    } catch (error) {
      // 传输失败（例如 transfer 列表里有已经被 detach 的缓冲区）不能让主线程干等到超时：
      // 这里补一条纯错误的回包（它不带任何 TypedArray），主线程会因此当场降级。
      const fallback: FluidErrorResponse = {
        id,
        ok: false,
        error: `回包传输失败（${describeError(error)}）`,
      };
      scope.postMessage(fallback);
    }
  };
}
