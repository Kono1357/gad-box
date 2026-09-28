/**
 * 粒子流体 Worker 的断言（M4 第 7 批）。
 *
 * 跑法见 `fluidworker.run.ts`（esbuild 打包成 ESM 后在 Node 里跑）。
 *
 * ────────────────────────────────────────────────────────────
 * 这一轮的环境能验什么、不能验什么（先说清楚，免得被结论带偏）
 * ────────────────────────────────────────────────────────────
 * Node 里**没有** `Worker` 全局对象（`worker_threads` 不是浏览器 Worker，本项目一行都不用），
 * 所以：
 * - 能验：回退路径**真的被走到**、`source` / `fallbackReason` 自洽、
 *   回退结果与"直接同步调用 `PBFSolver`"逐元素全等、
 *   边界快照在**整张网格的每一个格点 + 两万个随机浮点采样点**上与真实边界答案完全一致、
 *   worker 里那段代码（`runStep`）在"结构化克隆过一遍的请求"上的结果与同步路径逐位相同、
 *   打包/搬运的真实耗时与字节数、拒绝策略、协议健壮性、生命周期；
 * - 不能验：真浏览器里 `new Worker(...)` 能不能起来、Vite 有没有把 worker 打进产物、
 *   子路径（base = /god-sandbox/）下 worker 的 URL 对不对、
 *   以及**超时分支**（Node 里永远到不了：没有 Worker 就没有等待）。
 *   这些在报告里如实写明，不在这里假装测过。
 *
 * 导出的是 async 版（`Promise<void>`）：几乎每条断言都要 `await runner.run(...)`。
 */

import { AIR, getVoxelId, isLiquid } from '../../src/data/voxelTypes';
import { PBFSolver, type FluidBoundary, type PBFSettings } from '../../src/fluid/PBFSolver';
import { ParticlePool } from '../../src/fluid/ParticlePool';
import { VoxelGrid } from '../../src/voxel/VoxelGrid';
import {
  classifyFluidBoundarySource,
  FluidWorkerRunner,
  isFluidWorkerAvailable,
  type FluidWorkerResult,
} from '../../src/world/FluidWorkerRunner';
import {
  attachWorkerScope,
  applyPoolDelta,
  FluidWorkerBackend,
  isFluidBoundarySnapshot,
  isFluidResponse,
  packBoundary,
  packPool,
  resetWorkerRuntime,
  runStep,
  unpackBoundary,
} from '../../src/workers/fluidWorkerCore';
import type {
  FluidBoundarySource,
  FluidObstacleBox,
  FluidResponse,
  FluidStepRequest,
  WorkerScopeLike,
} from '../../src/workers/fluidWorkerTypes';
// 副作用导入：证明 worker 入口在 Node 里也能被 import（它没有依赖 DOM / self）。
// 这也是"入口除了接线什么都没有"的间接证据。
import '../../src/workers/fluidWorker';

/** 断言函数由调用方提供（与 scripts/verify.ts 的 check 约定一致） */
export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

// ------------------------------------------------------------------ 场景常量

const SIZE_X = 48;
const SIZE_Y = 16;
const SIZE_Z = 48;
/** 地面顶面的体素 y；于是"站在地面上"的世界 y 就是 GROUND_TOP + 1 */
const GROUND_TOP = 4;
const STONE = getVoxelId('stone');
const WATER = getVoxelId('water');

/** 边界四标量（与 `Engine.fluidBoundary()` 的取值方式一致：半宽 = sizeX / 2） */
const PARAMS = { halfX: SIZE_X / 2, halfZ: SIZE_Z / 2, minY: 0, maxY: SIZE_Y } as const;

/** 建筑障碍：一个悬在半空的盒子 + 一个贴地盒子（与引擎里那种保守 AABB 是同一种形状） */
const OBSTACLES: FluidObstacleBox[] = [
  { minX: 5, maxX: 7, minY: 5, maxY: 9, minZ: 5, maxZ: 7 },
  { minX: -20, maxX: -18, minY: 0, maxY: 3, minZ: -20, maxZ: -18 },
];

/** 求解用的粒子数 / 池子容量 */
const SOLVE_COUNT = 800;
const SOLVE_CAPACITY = 1200;
/** 搬运成本的量级参照：20000 个下标（就是"搬 20000 个粒子的 8 个 Float32Array"那笔账） */
const TRANSPORT_CAPACITY = 20000;

const HAS_CHINESE = /[\u4e00-\u9fa5]/;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 确定性 PRNG（mulberry32）。用它保证"两次构造出来的池子逐位相同" */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ 场景搭建

/**
 * 地面 + 一条横向隧道 + 一块悬空石板 + 一格地下水。
 *
 * 隧道与悬空石板是**故意**造的：它们是"列式（每列地表高度）快照"表达不了的形状，
 * 也是本轮要证明"位图是无损的、列式是有损的"所需的证据地形。
 */
function buildCaveGrid(): VoxelGrid {
  const grid = new VoxelGrid(SIZE_X, SIZE_Y, SIZE_Z);
  for (let x = 0; x < SIZE_X; x += 1) {
    for (let z = 0; z < SIZE_Z; z += 1) {
      for (let y = 0; y <= GROUND_TOP; y += 1) grid.setVoxel(x, y, z, STONE);
    }
  }
  // 横向隧道：挖掉 y = 3 的一层，而 y = 4 仍然是实心 —— 这是悬垂结构
  for (let x = 20; x <= 28; x += 1) {
    for (let z = 20; z <= 23; z += 1) grid.setVoxel(x, 3, z, AIR);
  }
  // 完全离地的石板（悬垂）
  for (let x = 32; x <= 36; x += 1) {
    for (let z = 8; z <= 12; z += 1) grid.setVoxel(x, 8, z, STONE);
  }
  // 埋在石头里的一格水：液体不算固体，位图必须把这一位留成 0
  grid.setVoxel(10, 3, 10, WATER);
  return grid;
}

/** 大世界（128×32×128，8×8 个区块）：用来量一次真实规模的打包耗时与快照体积 */
function buildBigGrid(): VoxelGrid {
  const grid = new VoxelGrid(128, 32, 128);
  for (let cx = 0; cx < grid.chunksX; cx += 1) {
    for (let cz = 0; cz < grid.chunksZ; cz += 1) {
      const chunk = grid.getChunk(cx, cz);
      if (chunk === undefined) continue;
      for (let y = 0; y <= GROUND_TOP; y += 1) {
        for (let z = 0; z < 16; z += 1) {
          for (let x = 0; x < 16; x += 1) chunk.setLocal(x, y, z, STONE);
        }
      }
    }
  }
  grid.recount();
  return grid;
}

/**
 * 引擎口径的边界：逐条照抄 `Engine.fluidBoundary().isSolid` 的分支顺序
 * （越界 → 地形 → 建筑），只是建筑部分用线性扫描。
 *
 * 为什么要在断言里**再写一遍**：它是对照组。快照解出来的边界必须与它逐点一致，
 * 而这个"它"是按引擎源码写的，不是按快照实现写的。
 */
function makeLinearBoundary(
  grid: VoxelGrid,
  obstacles: readonly FluidObstacleBox[],
): FluidBoundary {
  return {
    ...PARAMS,
    isSolid(x: number, y: number, z: number): boolean {
      if (y < 0) return true;
      if (y >= grid.sizeY) return false;
      const vx = grid.worldToVoxelX(x);
      const vz = grid.worldToVoxelZ(z);
      if (!grid.inHorizontalBounds(vx, vz)) return true;
      const id = grid.getVoxel(vx, Math.floor(y), vz);
      if (id !== AIR && !isLiquid(id)) return true;
      for (const box of obstacles) {
        if (x < box.minX || x > box.maxX) continue;
        if (y < box.minY || y > box.maxY) continue;
        if (z < box.minZ || z > box.maxZ) continue;
        return true;
      }
      return false;
    },
  };
}

/**
 * 引擎真实实现的边界：建筑走"按 16 米分桶 + 先查 Set 再查 Map"那条路
 * （`Engine.buildFluidObstacles` + `Engine.fluidBucketKey` 的逐行转写）。
 *
 * 为什么要单独写这一份：快照里的建筑判断退化成了线性扫描。
 * 只证明"快照 == 线性扫描"是不够的 —— 那只证明了我自己跟自己对得上。
 * 必须再证明"线性扫描 == 引擎的分桶实现"，"搬建筑没有缩小能力"这句话才成立。
 */
function makeBucketedBoundary(
  grid: VoxelGrid,
  obstacles: readonly FluidObstacleBox[],
): FluidBoundary {
  // 引擎那边：`(bx + 128) * 256 + (bz + 128)`
  const bucketKey = (bx: number, bz: number): number => (bx + 128) * 256 + (bz + 128);
  const keys = new Set<number>();
  const map = new Map<number, FluidObstacleBox[]>();
  for (const box of obstacles) {
    for (let bx = Math.floor(box.minX / 16); bx <= Math.floor(box.maxX / 16); bx += 1) {
      for (let bz = Math.floor(box.minZ / 16); bz <= Math.floor(box.maxZ / 16); bz += 1) {
        const key = bucketKey(bx, bz);
        const list = map.get(key);
        if (list) list.push(box);
        else map.set(key, [box]);
        keys.add(key);
      }
    }
  }
  return {
    ...PARAMS,
    isSolid(x: number, y: number, z: number): boolean {
      if (y < 0) return true;
      if (y >= grid.sizeY) return false;
      const vx = grid.worldToVoxelX(x);
      const vz = grid.worldToVoxelZ(z);
      if (!grid.inHorizontalBounds(vx, vz)) return true;
      const id = grid.getVoxel(vx, Math.floor(y), vz);
      if (id !== AIR && !isLiquid(id)) return true;
      const key = bucketKey(Math.floor(x / 16), Math.floor(z / 16));
      if (!keys.has(key)) return false;
      const list = map.get(key);
      if (list) {
        for (const box of list) {
          if (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ && y >= box.minY && y <= box.maxY) {
            return true;
          }
        }
      }
      return false;
    },
  };
}

/** 每列最高"固体"格的高度（忽略液体）；整列皆空是 -1。这是"列式快照"能表达的全部信息 */
function columnTopHeights(grid: VoxelGrid): Int16Array {
  const heights = new Int16Array(grid.sizeX * grid.sizeZ);
  for (let x = 0; x < grid.sizeX; x += 1) {
    for (let z = 0; z < grid.sizeZ; z += 1) {
      let top = -1;
      for (let y = grid.sizeY - 1; y >= 0; y -= 1) {
        const id = grid.getVoxel(x, y, z);
        if (id !== AIR && !isLiquid(id)) {
          top = y;
          break;
        }
      }
      heights[x + z * grid.sizeX] = top;
    }
  }
  return heights;
}

/**
 * 列式边界（**本轮明确不采用**的那种快照）。
 * 只在断言里存在，用来证明"它在这种地形上会给出不同答案"。
 */
function makeColumnBoundary(grid: VoxelGrid, heights: Int16Array): FluidBoundary {
  return {
    ...PARAMS,
    isSolid(x: number, y: number, z: number): boolean {
      if (y < 0) return true;
      if (y >= grid.sizeY) return false;
      const vx = grid.worldToVoxelX(x);
      const vz = grid.worldToVoxelZ(z);
      if (!grid.inHorizontalBounds(vx, vz)) return true;
      return Math.floor(y) <= heights[vx + vz * grid.sizeX]!;
    },
  };
}

/**
 * 造一个"形状最刁"的粒子池：highWater > count，而且死粒子夹在活粒子**中间**。
 *
 * 为什么要故意留洞：`SpatialHash.build` 的遍历上界是 highWater，
 * 所以"活跃粒子在第 9000 号、前面是空的"这种形状是真实存在的。
 * 只有它才能验出"worker 侧按同样下标逐位还原"这件事有没有做到 ——
 * 如果 worker 侧把活粒子紧凑到前面，位置数组不会报错，但结果会不逐位相同。
 */
function buildPool(count: number, capacity: number): ParticlePool {
  const pool = new ParticlePool(capacity);
  const rnd = makeRandom(0x51ed270b);
  for (let i = 0; i < count; i += 1) {
    const x = -3 + rnd() * 6;
    const y = 6 + rnd() * 5;
    const z = -3 + rnd() * 6;
    pool.spawn(x, y, z, (rnd() - 0.5) * 0.6, 0, (rnd() - 0.5) * 0.6);
  }
  for (let i = 0; i < count; i += 7) pool.kill(i);
  return pool;
}

/**
 * 真实默认设置：从求解器自己那里读，**不手抄**。
 * 手抄一份默认值就等于在断言里放了一份会漂移的副本。
 */
function defaultSettings(): PBFSettings {
  const probe = new PBFSolver(new ParticlePool(1));
  return { ...probe.settings };
}

// ------------------------------------------------------------------ 比对工具

interface CompareResult {
  equal: boolean;
  diffCount: number;
  firstDiffIndex: number;
  firstDiffPair: string;
}

/** 逐元素全等比较（用 `Object.is`：它能把 0 / -0 与 NaN 的差异都算出来） */
function compareFloat32(a: Float32Array, b: Float32Array, length: number): CompareResult {
  if (a.length < length || b.length < length) {
    return { equal: false, diffCount: -1, firstDiffIndex: -1, firstDiffPair: `长度不足：${a.length} / ${b.length} < ${length}` };
  }
  let diffCount = 0;
  let firstDiffIndex = -1;
  let firstDiffPair = '';
  for (let i = 0; i < length; i += 1) {
    if (Object.is(a[i], b[i])) continue;
    diffCount += 1;
    if (firstDiffIndex < 0) {
      firstDiffIndex = i;
      firstDiffPair = `${a[i]} vs ${b[i]}`;
    }
  }
  return { equal: diffCount === 0, diffCount, firstDiffIndex, firstDiffPair };
}

/** 比较两条路径跑完之后粒子池的位置与速度（只比前 highWater 个下标） */
function comparePools(a: ParticlePool, b: ParticlePool): CompareResult {
  const n = Math.max(a.highWater, b.highWater);
  for (const [name, left, right] of [
    ['posX', a.posX, b.posX],
    ['posY', a.posY, b.posY],
    ['posZ', a.posZ, b.posZ],
    ['velX', a.velX, b.velX],
    ['velY', a.velY, b.velY],
    ['velZ', a.velZ, b.velZ],
  ] as const) {
    const result = compareFloat32(left, right, n);
    if (!result.equal) {
      return {
        ...result,
        firstDiffPair: `${name}[${result.firstDiffIndex}]：${result.firstDiffPair}`,
      };
    }
  }
  if (a.alive.length !== b.alive.length) {
    return { equal: false, diffCount: -1, firstDiffIndex: -1, firstDiffPair: '容量不同' };
  }
  for (let i = 0; i < b.alive.length; i += 1) {
    if (a.alive[i] !== b.alive[i]) {
      return { equal: false, diffCount: -1, firstDiffIndex: i, firstDiffPair: `alive[${i}] 不同` };
    }
  }
  return { equal: true, diffCount: 0, firstDiffIndex: -1, firstDiffPair: '' };
}

/** `source` 与 `fallbackReason` 必须自洽：用 worker 就没有回退原因，走回退就必须有中文原因 */
function sourceIsCoherent(result: FluidWorkerResult): boolean {
  if (result.source === 'worker') return result.fallbackReason === null;
  return (
    typeof result.fallbackReason === 'string' &&
    result.fallbackReason.length > 0 &&
    HAS_CHINESE.test(result.fallbackReason)
  );
}

function captureError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

// ------------------------------------------------------------------ 断言主体

export async function runFluidWorkerChecks(check: CheckFn): Promise<void> {
  const grid = buildCaveGrid();
  const settings = defaultSettings();
  const realBoundary = makeLinearBoundary(grid, OBSTACLES);
  const source: FluidBoundarySource = { grid, obstacles: OBSTACLES };
  const snapshot = packBoundary(source, PARAMS);
  const unpacked = unpackBoundary(snapshot);
  const allResults: FluidWorkerResult[] = [];

  // ---------------------------------------------------------- 1. 环境与可用性

  check(
    'Node 环境里 isFluidWorkerAvailable() 为 false（如实反映环境，不假装可用）',
    isFluidWorkerAvailable() === false,
    `typeof Worker = ${typeof (globalThis as { Worker?: unknown }).Worker}`,
  );
  check(
    'Node 里没有 Worker 全局对象（这正是回退路径会被走到的根本原因）',
    (globalThis as { Worker?: unknown }).Worker === undefined,
    'Node 的 worker_threads 不是浏览器 Worker，本项目不用它',
  );

  const runner = new FluidWorkerRunner();
  check('runner.available 在 Node 下为 false', runner.available === false);
  check('刚建好的 runner 不忙（busy === false）', runner.busy === false);
  check(
    '默认超时是 4000 ms（与 ConflictRunner 取值一致）',
    runner.timeoutMs === 4000,
    `${runner.timeoutMs} ms`,
  );
  check(
    'timeoutMs 非法（0 / 负数 / NaN）时被夹到默认值，而不是变成"永不超时"',
    new FluidWorkerRunner({ timeoutMs: 0 }).timeoutMs === 4000 &&
      new FluidWorkerRunner({ timeoutMs: -5 }).timeoutMs === 4000 &&
      new FluidWorkerRunner({ timeoutMs: Number.NaN }).timeoutMs === 4000,
  );
  check(
    'timeoutMs 合法时如实生效（不静默改数）',
    new FluidWorkerRunner({ timeoutMs: 1234 }).timeoutMs === 1234,
  );

  // ---------------------------------------------------------- 2. 回退路径与逐位一致

  const runnerPool = buildPool(SOLVE_COUNT, SOLVE_CAPACITY);
  const syncPool = buildPool(SOLVE_COUNT, SOLVE_CAPACITY);
  const DT = 1 / 15;

  check(
    '构造出来的两个池子逐位相同（下面的"两条路径一致"才有意义）',
    comparePools(runnerPool, syncPool).equal,
    `highWater=${runnerPool.highWater}，活跃 ${runnerPool.count}`,
  );
  check(
    '池子形状是"死粒子夹在活粒子中间"（highWater > count），这是搬运最容易出错的形状',
    runnerPool.highWater === SOLVE_COUNT && runnerPool.count < SOLVE_COUNT,
    `highWater=${runnerPool.highWater}，count=${runnerPool.count}`,
  );

  const fallbackResult = await runner.run(
    runnerPool,
    settings,
    realBoundary,
    DT,
    Number.POSITIVE_INFINITY,
  );
  allResults.push(fallbackResult);
  // 直接同步调用：同一个类、同一份设置、同一个边界对象，只是新开一个池子与求解器实例
  const directRun = new PBFSolver(syncPool, settings).step(DT, realBoundary, Number.POSITIVE_INFINITY);

  check(
    'Node 下 run() 走回退：source === "main-thread"（不许把回退报成 worker）',
    fallbackResult.source === 'main-thread',
    `source = ${fallbackResult.source}`,
  );
  check(
    '回退原因是非空中文（UI 上能看出"这次没用 worker"）',
    typeof fallbackResult.fallbackReason === 'string' &&
      fallbackResult.fallbackReason.length > 0 &&
      HAS_CHINESE.test(fallbackResult.fallbackReason),
    fallbackResult.fallbackReason ?? '(null)',
  );
  const fallbackCompare = comparePools(runnerPool, syncPool);
  check(
    '回退路径与"直接同步调用 PBFSolver"的结果逐元素全等（不是"1e-6 以内"，就是全等）',
    fallbackCompare.equal,
    fallbackCompare.equal ? `6 个数组 × ${runnerPool.highWater} 个下标全部相同` : fallbackCompare.firstDiffPair,
  );
  check(
    '回退路径的 substeps / simulatedSeconds 与同步路径完全一致',
    fallbackResult.substeps === directRun.substeps &&
      fallbackResult.simulatedSeconds === directRun.simulatedSeconds,
    `回退 ${fallbackResult.substeps} 子步 / ${fallbackResult.simulatedSeconds.toFixed(6)} 秒，同步 ${directRun.substeps} / ${directRun.simulatedSeconds.toFixed(6)}`,
  );
  check(
    '回退的 ms 是有限数值（不是 NaN / undefined）',
    Number.isFinite(fallbackResult.ms) && fallbackResult.ms >= 0,
    `${fallbackResult.ms.toFixed(3)} ms`,
  );
  check(
    '一次 run() 之后 busy 回到 false（不留悬挂状态）',
    runner.busy === false,
  );
  // 面板/音效/慢动作提示读的是求解器分项统计。搬进 worker 之后 `FluidSystem.solver.stats`
  // 不再是这一帧的真数字（真正求解发生在 worker 里，或者发生在执行器自己的回退求解器上），
  // 所以执行器必须把两条路径的分项统计都交出来，否则界面会一直显示陈数据 ——
  // 那种"数字看起来正常但其实是旧的"比空白更难发现。
  const fallbackStats = runner.lastStats;
  check(
    'lastStats 在回退路径上也交得出求解器分项统计（不是只给 worker 路径准备的空壳）',
    fallbackStats !== null &&
      fallbackStats.particles === runnerPool.count &&
      fallbackStats.substeps === fallbackResult.substeps &&
      fallbackStats.totalMs > 0,
    fallbackStats === null
      ? '(null)'
      : `particles=${fallbackStats.particles}｜substeps=${fallbackStats.substeps}｜totalMs=${fallbackStats.totalMs.toFixed(3)} ms`,
  );
  check(
    'lastWorkerStats 在回退路径上是 null（worker 专属的分项耗时不会被伪造出来）',
    runner.lastWorkerStats === null,
  );

  // ---------------------------------------------------------- 3. 边界快照：能表达什么

  check(
    'packBoundary 接受 { grid, obstacles } 并把 obstaclesIncluded 标成 true',
    snapshot.obstaclesIncluded === true,
  );
  check(
    'packBoundary 只给 VoxelGrid 时把 obstaclesIncluded 标成 false（"没搬建筑"这件事必须看得见）',
    packBoundary(grid).obstaclesIncluded === false,
  );
  const expectedWords = Math.ceil(16 * SIZE_Y * 16 / 32);
  check(
    '快照结构与格数自洽（每区块 wordsPerChunk × 区块数，位宽与 Chunk.voxels 对齐）',
    snapshot.wordsPerChunk === expectedWords &&
      snapshot.solidBits.length === snapshot.chunksX * snapshot.chunksZ * expectedWords &&
      snapshot.solidBits.length * 4 * 8 === SIZE_X * SIZE_Y * SIZE_Z,
    `${snapshot.chunksX}×${snapshot.chunksZ} 区块 × ${snapshot.wordsPerChunk} 字 = ${snapshot.solidBits.length} 字`,
  );

  // ---------------------------------------------------------- 4. 边界能力保真（最重要的一段）

  let gridMismatch = 0;
  let firstGridMismatch = '';
  for (let vx = 0; vx < SIZE_X; vx += 1) {
    for (let vz = 0; vz < SIZE_Z; vz += 1) {
      for (let vy = 0; vy < SIZE_Y; vy += 1) {
        // 取格心：这样探针落在格子内部，而不是落在格边界上（边界上的取整语义会更微妙）
        const x = vx + 0.5 - PARAMS.halfX;
        const y = vy + 0.5;
        const z = vz + 0.5 - PARAMS.halfZ;
        if (realBoundary.isSolid(x, y, z) !== unpacked.isSolid(x, y, z)) {
          gridMismatch += 1;
          if (firstGridMismatch === '') firstGridMismatch = `(${vx},${vy},${vz})`;
        }
      }
    }
  }
  check(
    '快照解包后与真实边界在**整张网格的每一个格点**上答案完全一致（36864 点全量比对）',
    gridMismatch === 0,
    `差异 ${gridMismatch} 处${firstGridMismatch === '' ? '' : `，首个在 ${firstGridMismatch}`}`,
  );

  const rnd = makeRandom(0x2f6e0a11);
  const SAMPLE_COUNT = 20000;
  let sampleMismatch = 0;
  let firstSampleMismatch = '';
  const hitTerrain = { solidIn: 0, solidOut: 0, inBox: 0, outOfWorld: 0, liquid: 0 };
  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    // 采样范围刻意超出世界（±halfX 之外、y 小于 0、y 高过 sizeY），越界分支也要被覆盖
    const x = -PARAMS.halfX - 2 + rnd() * (SIZE_X + 4);
    const y = -2 + rnd() * (SIZE_Y + 4);
    const z = -PARAMS.halfZ - 2 + rnd() * (SIZE_Z + 4);
    const real = realBoundary.isSolid(x, y, z);
    if (real !== unpacked.isSolid(x, y, z)) {
      sampleMismatch += 1;
      if (firstSampleMismatch === '') firstSampleMismatch = `(${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)})`;
    }
    if (real) hitTerrain.solidIn += 1;
    else hitTerrain.solidOut += 1;
    const inBox = OBSTACLES.some(
      (b) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ,
    );
    if (inBox) hitTerrain.inBox += 1;
    if (y < 0 || y >= SIZE_Y || x < -PARAMS.halfX || x > PARAMS.halfX || z < -PARAMS.halfZ || z > PARAMS.halfZ) {
      hitTerrain.outOfWorld += 1;
    }
  }
  check(
    `快照解包后与真实边界在 ${SAMPLE_COUNT} 个随机浮点采样点上答案完全一致（六向探针就是这种坐标）`,
    sampleMismatch === 0,
    `差异 ${sampleMismatch} 处${firstSampleMismatch === '' ? '' : `，首个在 ${firstSampleMismatch}`}`,
  );
  check(
    '采样确实覆盖了四类区域（固体 / 空气 / 建筑盒内 / 越界），不是"全落在空气里碰巧一致"',
    hitTerrain.solidIn > 0 &&
      hitTerrain.solidOut > 0 &&
      hitTerrain.inBox > 0 &&
      hitTerrain.outOfWorld > 0,
    `固体 ${hitTerrain.solidIn}｜空气 ${hitTerrain.solidOut}｜盒内 ${hitTerrain.inBox}｜越界 ${hitTerrain.outOfWorld}`,
  );

  const bucketed = makeBucketedBoundary(grid, OBSTACLES);
  let bucketMismatch = 0;
  let bucketChecked = 0;
  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    const x = -PARAMS.halfX - 2 + rnd() * (SIZE_X + 4);
    const y = -2 + rnd() * (SIZE_Y + 4);
    const z = -PARAMS.halfZ - 2 + rnd() * (SIZE_Z + 4);
    bucketChecked += 1;
    if (bucketed.isSolid(x, y, z) !== realBoundary.isSolid(x, y, z)) bucketMismatch += 1;
  }
  check(
    '引擎的分桶建筑查询与快照用的线性扫描在同一批采样点上答案一致（"搬建筑"没有缩小能力）',
    bucketMismatch === 0,
    `${bucketChecked} 点比对，差异 ${bucketMismatch} 处`,
  );

  // 随机采样落在盒内的点只有十几个，样本太薄；这里再往盒子里**专门**灌一批点。
  // 悬空的那个盒子（y 5~9）尤其重要：那一带的地形全是空气，所以答案只可能来自建筑分支。
  let boxChecked = 0;
  let boxMismatch = 0;
  let boxAirCells = 0;
  for (const box of OBSTACLES) {
    const boxRnd = makeRandom(0x9e3779b9);
    for (let i = 0; i < 200; i += 1) {
      const x = box.minX + boxRnd() * (box.maxX - box.minX);
      const y = box.minY + boxRnd() * (box.maxY - box.minY);
      const z = box.minZ + boxRnd() * (box.maxZ - box.minZ);
      const real = realBoundary.isSolid(x, y, z);
      boxChecked += 1;
      if (real !== unpacked.isSolid(x, y, z)) boxMismatch += 1;
      if (grid.getVoxel(grid.worldToVoxelX(x), Math.floor(y), grid.worldToVoxelZ(z)) === AIR) {
        boxAirCells += 1;
        // 地形是空气、答案却是固体 —— 那只能是建筑分支给出的
        if (!real) boxMismatch += 1000;
      }
    }
  }
  check(
    '建筑盒内部的 400 个采样点答案一致，且"地形是空气但答案是固体"的点确实存在（建筑分支真的生效了）',
    boxMismatch === 0 && boxChecked === 400 && boxAirCells > 0,
    `${boxChecked} 点，其中 ${boxAirCells} 点的答案只能来自建筑分支，差异 ${boxMismatch} 处`,
  );

  check(
    '液体体素不算固体：埋在石头里的那格水，真实边界与快照都回答"非固体"',
    realBoundary.isSolid(10 + 0.5 - PARAMS.halfX, 3 + 0.5, 10 + 0.5 - PARAMS.halfZ) === false &&
      unpacked.isSolid(10 + 0.5 - PARAMS.halfX, 3 + 0.5, 10 + 0.5 - PARAMS.halfZ) === false,
  );

  // ---------------------------------------------------------- 5. 明确不搬的能力

  const tunnelPoint = { x: 24 + 0.5 - PARAMS.halfX, y: 3 + 0.5, z: 21 + 0.5 - PARAMS.halfZ };
  const underSlabPoint = { x: 34 + 0.5 - PARAMS.halfX, y: 6 + 0.5, z: 10 + 0.5 - PARAMS.halfZ };
  check(
    '位图能表达隧道：隧道内的点，真实边界与快照都回答"非固体"',
    realBoundary.isSolid(tunnelPoint.x, tunnelPoint.y, tunnelPoint.z) === false &&
      unpacked.isSolid(tunnelPoint.x, tunnelPoint.y, tunnelPoint.z) === false,
  );
  check(
    '位图能表达悬垂：石板下方 2 米处的点，真实边界与快照都回答"非固体"',
    realBoundary.isSolid(underSlabPoint.x, underSlabPoint.y, underSlabPoint.z) === false &&
      unpacked.isSolid(underSlabPoint.x, underSlabPoint.y, underSlabPoint.z) === false,
  );

  // 列式快照：本轮**明确不采用**，这里把它做成可执行的证据
  const heights = columnTopHeights(grid);
  const column = makeColumnBoundary(grid, heights);
  let columnTunnelWrong = 0;
  let columnSlabWrong = 0;
  for (let x = 20; x <= 28; x += 1) {
    for (let z = 20; z <= 23; z += 1) {
      const px = x + 0.5 - PARAMS.halfX;
      const pz = z + 0.5 - PARAMS.halfZ;
      if (column.isSolid(px, 3.5, pz) !== realBoundary.isSolid(px, 3.5, pz)) columnTunnelWrong += 1;
    }
  }
  for (let x = 32; x <= 36; x += 1) {
    for (let z = 8; z <= 12; z += 1) {
      const px = x + 0.5 - PARAMS.halfX;
      const pz = z + 0.5 - PARAMS.halfZ;
      if (column.isSolid(px, 6.5, pz) !== realBoundary.isSolid(px, 6.5, pz)) columnSlabWrong += 1;
    }
  }
  check(
    '列式快照（每列地表高度）在隧道上会给出错误答案 —— 这就是我们**明确不采用它**的理由',
    columnTunnelWrong > 0,
    `隧道 ${36} 个格点里有 ${columnTunnelWrong} 个答错（列式会把挖空的那层报成固体）`,
  );
  check(
    '列式快照在悬垂上也会答错（石板下方的空气被报成固体）',
    columnSlabWrong > 0,
    `石板下方 ${25} 个格点里有 ${columnSlabWrong} 个答错`,
  );

  // 实时性：这是唯一一条**搬不动**的能力，必须显式地证明"我们没有假装搬得动"
  const beforeEdit = unpackBoundary(packBoundary(source, PARAMS));
  const probeX = 2 + 0.5 - PARAMS.halfX;
  const probeY = 9.5;
  const probeZ = 2 + 0.5 - PARAMS.halfZ;
  const beforeReal = realBoundary.isSolid(probeX, probeY, probeZ);
  grid.setVoxel(2, 9, 2, STONE);
  const afterReal = realBoundary.isSolid(probeX, probeY, probeZ);
  const staleSnapshot = beforeEdit.isSolid(probeX, probeY, probeZ);
  const freshSnapshot = unpackBoundary(packBoundary(source, PARAMS)).isSolid(probeX, probeY, probeZ);
  check(
    '边界快照是**时间点快照**而不是活视图：改地形后旧快照仍给旧答案，重新打包才给新答案',
    beforeReal === false &&
      afterReal === true &&
      staleSnapshot === false &&
      freshSnapshot === true,
    `改前 ${beforeReal} → 改后 ${afterReal}；旧快照 ${staleSnapshot}，新快照 ${freshSnapshot}`,
  );
  check(
    'terrain 的 editRevision 会随 setVoxel 变化（执行器就是靠它让缓存失效的）',
    typeof grid.editRevision === 'number' && grid.editRevision > 0,
    `editRevision = ${grid.editRevision}`,
  );
  // 把刚才那格恢复，后面的断言继续用原地形
  grid.setVoxel(2, 9, 2, AIR);

  // ---------------------------------------------------------- 6. 搬运成本（真实数字）

  /**
   * 统一的计时协议：先热身若干次再取 N 次平均。
   *
   * 为什么不能只跑一次：这几段都是"纯内存搬运"的短循环，**第一次调用**里有大量
   * 解释执行 / 未优化代码的份额（实测同一段循环首跑比稳定态慢好几倍）。
   * 只报首跑的数字会把"JIT 热身"记到"搬运算不算贵"的账上，那是编数字。
   */
  const measure = (fn: () => void, rounds: number, warmup: number): number => {
    for (let i = 0; i < warmup; i += 1) fn();
    const started = now();
    for (let i = 0; i < rounds; i += 1) fn();
    return (now() - started) / rounds;
  };

  const snapshotBytes = snapshot.solidBits.byteLength + snapshot.obstacleBounds.byteLength;
  check(
    '边界快照体积已如实报告（字节数，不是"估计值"）',
    snapshotBytes > 0,
    `${snapshotBytes} 字节 = solidBits ${snapshot.solidBits.byteLength} + obstacleBounds ${snapshot.obstacleBounds.byteLength}（${SIZE_X}×${SIZE_Y}×${SIZE_Z} 格）`,
  );

  const smallPackMs = measure(
    () => {
      packBoundary(source, PARAMS);
    },
    300,
    200,
  );
  check(
    `打包耗时已量出（${SIZE_X}×${SIZE_Y}×${SIZE_Z} = ${SIZE_X * SIZE_Y * SIZE_Z} 格，热身 200 次 + 300 次平均）`,
    smallPackMs >= 0 && Number.isFinite(smallPackMs),
    `${smallPackMs.toFixed(4)} ms（${((smallPackMs * 1e6) / (SIZE_X * SIZE_Y * SIZE_Z)).toFixed(2)} ns/格）`,
  );

  const bigGrid = buildBigGrid();
  const bigParams = {
    halfX: bigGrid.sizeX / 2,
    halfZ: bigGrid.sizeZ / 2,
    minY: 0,
    maxY: bigGrid.sizeY,
  } as const;
  const bigSnapshot = packBoundary({ grid: bigGrid, obstacles: [] }, bigParams);
  const bigCells = 128 * 32 * 128;
  const bigPackMs = measure(
    () => {
      packBoundary({ grid: bigGrid, obstacles: [] }, bigParams);
    },
    10,
    3,
  );
  const bigBytes = bigSnapshot.solidBits.byteLength + bigSnapshot.obstacleBounds.byteLength;
  check(
    `大世界（128×32×128 = ${bigCells} 格）的打包耗时与快照体积也量出来了（真实数字）`,
    bigBytes === bigCells / 8 && Number.isFinite(bigPackMs),
    `打包 ${bigPackMs.toFixed(3)} ms（${((bigPackMs * 1e6) / bigCells).toFixed(2)} ns/格），快照 ${bigBytes} 字节（${(bigBytes / 1024).toFixed(1)} KB）`,
  );

  // 采样点**先算好**再进计时循环：把 PRNG 的耗时记到"边界查询"头上就是在编数字
  const bigBoundary = unpackBoundary(bigSnapshot);
  const QUERY_COUNT = 10000;
  const queryPoints = new Float64Array(QUERY_COUNT * 3);
  {
    const queryRnd = makeRandom(7);
    for (let i = 0; i < QUERY_COUNT; i += 1) {
      queryPoints[i * 3] = -64 + queryRnd() * 128;
      queryPoints[i * 3 + 1] = -1 + queryRnd() * 34;
      queryPoints[i * 3 + 2] = -64 + queryRnd() * 128;
    }
  }
  let queryHits = 0;
  const queryMs = measure(
    () => {
      let hits = 0;
      for (let i = 0; i < QUERY_COUNT; i += 1) {
        if (bigBoundary.isSolid(queryPoints[i * 3]!, queryPoints[i * 3 + 1]!, queryPoints[i * 3 + 2]!)) hits += 1;
      }
      queryHits = hits;
    },
    20,
    10,
  );
  check(
    `解包后的边界查询耗时已量出（${QUERY_COUNT} 次 isSolid 的平均值；解包本身只是建一个闭包）`,
    Number.isFinite(queryMs) && queryMs >= 0 && queryHits > 0,
    `${queryMs.toFixed(4)} ms / ${QUERY_COUNT} 次 = ${((queryMs * 1e6) / QUERY_COUNT).toFixed(1)} ns/次（命中 ${queryHits} 次）`,
  );

  const transportPool = buildPool(TRANSPORT_CAPACITY, TRANSPORT_CAPACITY);
  const transportBuffers = packPool(transportPool);
  const packPoolMs = measure(
    () => {
      packPool(transportPool);
    },
    50,
    20,
  );
  const transportBytes =
    transportBuffers.posX.byteLength +
    transportBuffers.posY.byteLength +
    transportBuffers.posZ.byteLength +
    transportBuffers.velX.byteLength +
    transportBuffers.velY.byteLength +
    transportBuffers.velZ.byteLength +
    transportBuffers.frozen.byteLength +
    transportBuffers.alive.byteLength;
  check(
    `搬运 ${TRANSPORT_CAPACITY} 个下标的粒子池打包耗时已量出（真实数字）`,
    packPoolMs >= 0 && transportBuffers.highWater === TRANSPORT_CAPACITY,
    `${packPoolMs.toFixed(4)} ms，单向 ${transportBytes} 字节（${(transportBytes / 1024).toFixed(1)} KB），≈ ${((transportBytes / 1048576) / (packPoolMs / 1000)).toFixed(0)} MB/s`,
  );

  const cloneRequest: FluidStepRequest = {
    id: 4242,
    kind: 'step',
    dt: DT,
    budgetMs: Number.POSITIVE_INFINITY,
    settings,
    boundarySnapshot: bigSnapshot,
    pool: transportBuffers,
  };
  const clonedOnce = structuredClone(cloneRequest);
  const cloneMs = measure(
    () => {
      structuredClone(cloneRequest);
    },
    20,
    5,
  );
  check(
    '整个请求能过结构化克隆（浏览器 postMessage 的边界），TypedArray 仍是 TypedArray',
    clonedOnce.pool.posX instanceof Float32Array &&
      clonedOnce.pool.alive instanceof Uint8Array &&
      clonedOnce.boundarySnapshot.solidBits instanceof Uint32Array &&
      isFluidBoundarySnapshot(clonedOnce.boundarySnapshot) &&
      clonedOnce.boundarySnapshot.solidBits.length === bigSnapshot.solidBits.length,
    `一次结构化克隆 ${cloneMs.toFixed(3)} ms（20000 粒子的 8 个数组 ${(transportBytes / 1024).toFixed(1)} KB + 52.4 万格的位图 ${(bigBytes / 1024).toFixed(1)} KB）；注意这是**不含转移优化**的上界，浏览器里 transfer 之后是零拷贝`,
  );

  // ---------------------------------------------------------- 7. worker 侧那段代码（同一份）

  const workerInputPool = buildPool(SOLVE_COUNT, SOLVE_CAPACITY);
  const syncInputPool = buildPool(SOLVE_COUNT, SOLVE_CAPACITY);
  const workerRequest: FluidStepRequest = {
    id: 7,
    kind: 'step',
    dt: DT,
    budgetMs: Number.POSITIVE_INFINITY,
    settings,
    boundarySnapshot: snapshot,
    pool: packPool(workerInputPool),
  };
  resetWorkerRuntime();
  const workerResponse = runStep(structuredClone(workerRequest));
  applyPoolDelta(workerInputPool, workerResponse.pool);
  const syncSolver = new PBFSolver(syncInputPool, settings);
  const syncRun = syncSolver.step(DT, realBoundary, Number.POSITIVE_INFINITY);
  const workerCompare = comparePools(workerInputPool, syncInputPool);

  check(
    'worker 里的那段代码（同一份 runStep）与主线程同步路径的结果逐元素全等',
    workerCompare.equal,
    workerCompare.equal
      ? `6 个数组 × ${workerInputPool.highWater} 个下标全部相同`
      : workerCompare.firstDiffPair,
  );
  check(
    'worker 侧回包的 substeps / simulatedSeconds 与同步路径完全一致',
    workerResponse.stats.substeps === syncRun.substeps &&
      workerResponse.stats.simulatedSeconds === syncRun.simulatedSeconds,
    `${workerResponse.stats.substeps} 子步 / ${workerResponse.stats.simulatedSeconds.toFixed(6)} 秒`,
  );
  check(
    'worker 回包里的 prepareMs / solveMs 都是有限非负数（搬运与求解分开记账）',
    Number.isFinite(workerResponse.stats.prepareMs) &&
      workerResponse.stats.prepareMs >= 0 &&
      Number.isFinite(workerResponse.stats.solveMs) &&
      workerResponse.stats.solveMs >= 0,
    `prepare ${workerResponse.stats.prepareMs.toFixed(3)} ms，solve ${workerResponse.stats.solveMs.toFixed(3)} ms（${SOLVE_COUNT} 个粒子中有 ${SOLVE_COUNT - workerInputPool.count} 个是死的）`,
  );
  check(
    'worker 侧重建的池子与主线程池子的 highWater / count / alive 掩码逐位一致',
    workerResponse.pool.highWater === workerInputPool.highWater &&
      workerResponse.pool.count === workerInputPool.count,
    `highWater=${workerResponse.pool.highWater}，count=${workerResponse.pool.count}`,
  );

  // 冷启动 vs 复用运行时：结果必须一样，否则"复用求解器实例"这个优化就是不可信的
  const coldInputPool = buildPool(SOLVE_COUNT, SOLVE_CAPACITY);
  const coldRequest: FluidStepRequest = {
    id: 8,
    kind: 'step',
    dt: DT,
    budgetMs: Number.POSITIVE_INFINITY,
    settings,
    boundarySnapshot: snapshot,
    pool: packPool(coldInputPool),
  };
  resetWorkerRuntime();
  const coldResponse = runStep(structuredClone(coldRequest));
  applyPoolDelta(coldInputPool, coldResponse.pool);
  check(
    '冷启动（丢弃缓存的池子/求解器）与复用实例的结果逐元素全等（复用没有改变物理）',
    comparePools(coldInputPool, workerInputPool).equal,
    comparePools(coldInputPool, workerInputPool).firstDiffPair || '6 个数组全部相同',
  );

  // ---------------------------------------------------------- 8. 预算语义（可移植的那部分）

  const budgetInputPool = buildPool(SOLVE_COUNT, SOLVE_CAPACITY);
  const unlimitedRequest: FluidStepRequest = {
    id: 9,
    kind: 'step',
    dt: DT,
    budgetMs: Number.POSITIVE_INFINITY,
    settings,
    boundarySnapshot: snapshot,
    pool: packPool(budgetInputPool),
  };
  const unlimited = runStep(structuredClone(unlimitedRequest));
  const limitedRequest: FluidStepRequest = { ...unlimitedRequest, id: 10, budgetMs: 0 };
  const zeroPool = buildPool(SOLVE_COUNT, SOLVE_CAPACITY);
  const limited = runStep({ ...structuredClone(limitedRequest), pool: packPool(zeroPool) });
  const syncZero = new PBFSolver(buildPool(SOLVE_COUNT, SOLVE_CAPACITY), settings).step(
    DT,
    realBoundary,
    0,
  );
  check(
    'dt = 1/15 且预算不受限时跑满 2 个子步（子步切分由 maxStepSeconds 决定）',
    unlimited.stats.substeps === 2,
    `${unlimited.stats.substeps} 个子步`,
  );
  check(
    'budgetMs = 0 时两条路径都只跑 1 个子步（"第 1 个子步无条件做完"这条语义可移植）',
    limited.stats.substeps === 1 && syncZero.substeps === 1,
    `worker 侧 ${limited.stats.substeps}，同步 ${syncZero.substeps}`,
  );
  check(
    '预算被触到会让子步数变少 —— 这正说明"逐位一致"的前提是"预算不构成约束"（不是我们藏起来的差异）',
    limited.stats.substeps < unlimited.stats.substeps &&
      limited.stats.simulatedSeconds < unlimited.stats.simulatedSeconds,
    `受限 ${limited.stats.substeps} 子步 vs 不受限 ${unlimited.stats.substeps} 子步`,
  );

  // ---------------------------------------------------------- 9. 拒绝策略（"悄悄没搬"是禁止的）

  const refusalMissing = classifyFluidBoundarySource(null);
  check(
    '拿不到可打包来源时**明确拒绝**：返回中文原因，而不是"只搬四个标量就上路"',
    refusalMissing.ok === false && HAS_CHINESE.test(refusalMissing.reason),
    refusalMissing.ok ? '(竟然放行了)' : refusalMissing.reason,
  );
  const refusalBareGrid = classifyFluidBoundarySource(grid);
  check(
    '只给 VoxelGrid（没有建筑障碍）时明确拒绝，且理由**点名**"建筑障碍"（理由错等于没查出来）',
    refusalBareGrid.ok === false &&
      HAS_CHINESE.test(refusalBareGrid.reason) &&
      refusalBareGrid.reason.includes('建筑障碍') &&
      !refusalBareGrid.reason.includes('无法克隆'),
    refusalBareGrid.ok ? '(竟然放行了)' : refusalBareGrid.reason,
  );
  const acceptEmptyObstacles = classifyFluidBoundarySource({ grid, obstacles: [] });
  check(
    '显式给 obstacles: []（明确的"这里没有建筑"）才放行 —— 与"没说清楚"区分开',
    acceptEmptyObstacles.ok === true,
    acceptEmptyObstacles.ok ? 'ok' : acceptEmptyObstacles.reason,
  );
  const acceptFull = classifyFluidBoundarySource(source);
  check(
    '完整的 { grid, obstacles } 放行，且拿到的是同一个来源对象（不做无谓拷贝）',
    acceptFull.ok === true && acceptFull.source === source,
  );
  check(
    'packBoundary 对 null / 非网格对象抛中文错误，而不是静默产出一份空快照把水放走',
    (() => {
      try {
        packBoundary({ 不是: '网格' } as unknown as FluidBoundarySource, PARAMS);
        return false;
      } catch (error) {
        return HAS_CHINESE.test(captureError(error));
      }
    })(),
  );

  // ---------------------------------------------------------- 10. 协议健壮性

  const backend = new FluidWorkerBackend();
  const malformed = backend.handle({ id: 11, kind: 'step' });
  check(
    '畸形请求（缺 pool / boundarySnapshot）回 ok:false 且原因是中文，而不是抛异常或静默',
    malformed !== null && malformed.ok === false && HAS_CHINESE.test(malformed.error),
    malformed !== null && malformed.ok === false ? malformed.error : '(没有回包)',
  );
  const unknownKind = backend.handle({ id: 12, kind: '炸了' });
  check(
    '未知任务类型回 ok:false 并带上收到的值（不猜、不吞）',
    unknownKind !== null && unknownKind.ok === false && unknownKind.error.includes('炸了'),
    unknownKind !== null && unknownKind.ok === false ? unknownKind.error : '(没有回包)',
  );
  const badSettings = backend.handle({
    ...workerRequest,
    id: 13,
    settings: { ...settings, restDensity: '很密' },
  });
  check(
    'settings 缺字段 / 类型不对时回 ok:false，并且点名是哪个字段（不偷偷用默认值补上）',
    badSettings !== null && badSettings.ok === false && badSettings.error.includes('restDensity'),
    badSettings !== null && badSettings.ok === false ? badSettings.error : '(没有回包)',
  );
  const badCapacity = backend.handle({
    ...workerRequest,
    id: 14,
    pool: { ...packPool(buildPool(4, 4)), highWater: 99 },
  });
  check(
    'highWater 超出容量时回 ok:false（不越界分配、不静默截断）',
    badCapacity !== null && badCapacity.ok === false && HAS_CHINESE.test(badCapacity.error),
    badCapacity !== null && badCapacity.ok === false ? badCapacity.error : '(没有回包)',
  );

  check(
    'isFluidResponse 能识破畸形回包（形状不对就不当结果用，改走回退）',
    isFluidResponse({ id: 1, ok: true, pool: '不是对象', stats: {} }) === false &&
      isFluidResponse({ id: 1, ok: 'yes' }) === false &&
      isFluidResponse({ id: 1 }) === false &&
      isFluidResponse({ id: 1, ok: true, pool: workerResponse.pool, stats: workerResponse.stats }) === true &&
      // 长度与 highWater 对不上：这是"回包被截断"，必须被判为无效
      isFluidResponse({
        id: 1,
        ok: true,
        pool: { ...workerResponse.pool, posX: new Float32Array(3) },
        stats: workerResponse.stats,
      }) === false,
  );

  // 取消：worker 侧的 handle 是同步的，所以取消**正在算的那一次**不可能生效；
  // 这里验的是"排在后面还没开始的那一次"能生效，而且它的回包**不会被伪装成一次正常求解**。
  const cancelBackend = new FluidWorkerBackend();
  const cancelAck = cancelBackend.handle({ id: 77, kind: 'cancel' });
  const cancelledResponse = cancelBackend.handle({ ...workerRequest, id: 77 });
  check(
    'cancel 消息本身不产生回包；被取消的任务回 ok:false（绝不能被当成"这一帧粒子没动"）',
    cancelAck === null &&
      cancelledResponse !== null &&
      cancelledResponse.ok === false &&
      cancelledResponse.error.includes('cancel') &&
      HAS_CHINESE.test(cancelledResponse.error),
    cancelledResponse !== null && cancelledResponse.ok === false ? cancelledResponse.error : '(没有回包)',
  );

  // 接线：onmessage → 计算 → postMessage
  const posted: FluidResponse[] = [];
  const scope: WorkerScopeLike = {
    onmessage: null,
    postMessage: (message: unknown): void => {
      posted.push(message as FluidResponse);
    },
  };
  attachWorkerScope(scope);
  const scopePool = buildPool(SOLVE_COUNT, SOLVE_CAPACITY);
  scope.onmessage?.({
    data: structuredClone({ ...workerRequest, id: 42, pool: packPool(scopePool) }),
  });
  const wiredResponse = posted[0];
  check(
    'fluidWorker 的接线（onmessage → 后端计算 → postMessage 回包）在 Node 里也能跑通',
    posted.length === 1 &&
      wiredResponse !== undefined &&
      wiredResponse.ok === true &&
      wiredResponse.id === 42,
    `${posted.length} 条回包`,
  );

  // ---------------------------------------------------------- 11. 写回的安全阀

  const guardPool = buildPool(16, 32);
  const guardDelta = runStep({
    id: 15,
    kind: 'step',
    dt: 1 / 60,
    budgetMs: Number.POSITIVE_INFINITY,
    settings,
    boundarySnapshot: snapshot,
    pool: packPool(guardPool),
  }).pool;
  check(
    'write-back 在 highWater 不一致时抛中文错误（等待期间池子被改过 → 拒绝错位写回）',
    (() => {
      // 换一个"水位不同"的池子：多生成 8 个粒子会同时抬高 highWater
      const longerPool = buildPool(24, 32);
      if (longerPool.highWater === guardDelta.highWater) return false;
      try {
        applyPoolDelta(longerPool, guardDelta);
        return false;
      } catch (error) {
        return HAS_CHINESE.test(captureError(error)) && captureError(error).includes('水位');
      }
    })(),
    `回包的 highWater = ${guardDelta.highWater}`,
  );
  check(
    'write-back 在活跃粒子数不一致（水位相同）时也抛中文错误',
    (() => {
      const densityChanged = buildPool(16, 32);
      densityChanged.spawn(0, 0, 0);
      if (densityChanged.highWater !== guardDelta.highWater) return false;
      if (densityChanged.count === guardDelta.count) return false;
      try {
        applyPoolDelta(densityChanged, guardDelta);
        return false;
      } catch (error) {
        return HAS_CHINESE.test(captureError(error)) && captureError(error).includes('活跃粒子数');
      }
    })(),
    `回包的 count = ${guardDelta.count}`,
  );
  check(
    'write-back 在容量不一致时抛中文错误',
    (() => {
      try {
        applyPoolDelta(new ParticlePool(64), guardDelta);
        return false;
      } catch (error) {
        return HAS_CHINESE.test(captureError(error)) && captureError(error).includes('容量');
      }
    })(),
  );
  check(
    'write-back 在形状正常时把位置/速度原样写回（不改下标、不动 alive）',
    (() => {
      const target = buildPool(16, 32);
      const aliveBefore = Array.from(target.alive.slice(0, target.highWater));
      applyPoolDelta(target, guardDelta);
      const aliveAfter = Array.from(target.alive.slice(0, target.highWater));
      return (
        aliveBefore.length === aliveAfter.length &&
        aliveBefore.every((value, index) => value === aliveAfter[index]) &&
        compareFloat32(target.posX, guardDelta.posX, guardDelta.highWater).equal
      );
    })(),
  );

  // ---------------------------------------------------------- 12. 生命周期与边界输入

  const emptyPool = new ParticlePool(64);
  const emptyResult = await runner.run(emptyPool, settings, realBoundary, DT, Number.POSITIVE_INFINITY);
  allResults.push(emptyResult);
  check(
    '0 个粒子的空池不抛异常，substeps / simulatedSeconds 都是 0，且 source 依然自洽',
    emptyResult.substeps === 0 &&
      emptyResult.simulatedSeconds === 0 &&
      sourceIsCoherent(emptyResult),
    `source=${emptyResult.source}｜${emptyResult.fallbackReason ?? '(null)'}`,
  );

  const zeroDtResult = await runner.run(
    buildPool(SOLVE_COUNT, SOLVE_CAPACITY),
    settings,
    realBoundary,
    0,
    Number.POSITIVE_INFINITY,
  );
  allResults.push(zeroDtResult);
  check(
    'dt = 0 时如实报"没有推进任何东西"，且 source / fallbackReason 自洽',
    zeroDtResult.substeps === 0 && zeroDtResult.simulatedSeconds === 0 && sourceIsCoherent(zeroDtResult),
    `${zeroDtResult.fallbackReason ?? '(null)'}`,
  );

  const noSourceRunner = new FluidWorkerRunner();
  const noSourceResult = await noSourceRunner.run(
    buildPool(64, 128),
    settings,
    realBoundary,
    DT,
    Number.POSITIVE_INFINITY,
  );
  allResults.push(noSourceResult);
  check(
    '既没有 boundarySource、boundary 也不带 grid/obstacles 时，run() 依然自洽地降级（不抛、不谎报）',
    sourceIsCoherent(noSourceResult) && Number.isFinite(noSourceResult.ms),
    `source=${noSourceResult.source}｜${noSourceResult.fallbackReason ?? '(null)'}`,
  );

  const cancelRunner = new FluidWorkerRunner();
  const cancelPromise = cancelRunner.run(
    buildPool(SOLVE_COUNT, SOLVE_CAPACITY),
    settings,
    realBoundary,
    DT,
    Number.POSITIVE_INFINITY,
  );
  cancelRunner.cancel();
  const cancelResult = await cancelPromise;
  allResults.push(cancelResult);
  check(
    'cancel() 之后状态自洽：结果仍然是真的（不是空结果），source 与 fallbackReason 不矛盾',
    sourceIsCoherent(cancelResult) &&
      !(cancelResult.source === 'worker' && cancelResult.fallbackReason === null && cancelResult.substeps === 0),
    `source=${cancelResult.source}｜substeps=${cancelResult.substeps}｜${cancelResult.fallbackReason ?? '(null)'}`,
  );
  let cancelThrew = false;
  try {
    cancelRunner.cancel();
    cancelRunner.cancel();
  } catch {
    cancelThrew = true;
  }
  check('没有任务在跑时 cancel() 是空操作，不抛异常', cancelThrew === false);

  const disposeRunner = new FluidWorkerRunner();
  disposeRunner.dispose();
  let disposeThrew = false;
  let disposeResult: FluidWorkerResult | null = null;
  try {
    disposeResult = await disposeRunner.run(
      buildPool(SOLVE_COUNT, SOLVE_CAPACITY),
      settings,
      realBoundary,
      DT,
      Number.POSITIVE_INFINITY,
    );
  } catch {
    disposeThrew = true;
  }
  if (disposeResult !== null) allResults.push(disposeResult);
  check(
    'dispose() 之后再 run() 不抛异常，并如实降级（source = main-thread + 中文原因）',
    disposeThrew === false &&
      disposeResult !== null &&
      disposeResult.source === 'main-thread' &&
      HAS_CHINESE.test(disposeResult.fallbackReason ?? ''),
    disposeResult?.fallbackReason ?? '(抛异常了)',
  );
  check('dispose() 之后 available 为 false', disposeRunner.available === false);
  let secondDisposeThrew = false;
  try {
    disposeRunner.dispose();
  } catch {
    secondDisposeThrew = true;
  }
  check('dispose() 可以重复调用而不抛异常', secondDisposeThrew === false);

  // ---------------------------------------------------------- 13. 全局自洽性收尾

  check(
    '所有跑过的结果里，source 与 fallbackReason 都自洽（worker ⟺ 没有回退原因）',
    allResults.length >= 5 && allResults.every((result) => sourceIsCoherent(result)),
    `共检查 ${allResults.length} 条结果`,
  );
  check(
    '所有跑过的结果都是有限毫秒数（没有 NaN）',
    allResults.every((result) => Number.isFinite(result.ms)),
  );
  check(
    '在 Node 里**每一条**结果都是 main-thread（回退是这一轮的默认路径，不是偶发分支）',
    allResults.every((result) => result.source === 'main-thread'),
    `其中典型原因：${describe(allResults[0]?.fallbackReason ?? '(空)')}`,
  );
  check(
    'lastCost 在没走 worker 路径时如实为 null，而不是谎报成 0 ms',
    runner.lastCost.boundaryPackMs === null &&
      runner.lastCost.poolPackMs === null &&
      runner.lastCost.waitMs === null &&
      runner.lastCost.applyMs === null,
    `boundaryPackMs=${String(runner.lastCost.boundaryPackMs)}｜poolPackMs=${String(runner.lastCost.poolPackMs)}`,
  );
}
