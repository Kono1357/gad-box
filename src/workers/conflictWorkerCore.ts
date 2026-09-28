/**
 * 冲突 Worker 的核心逻辑（M4 第 6 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么把逻辑放在 core、入口只做接线
 * ────────────────────────────────────────────────────────────
 * 这一轮的环境里**没有浏览器、也没有 Node 的 `Worker` 全局对象**
 * （Node 的 `worker_threads` 不是浏览器 Worker：协议、模块格式、全局作用域都不同，
 * 拿它冒充只会得到一个"看起来测过了"的假结论）。
 *
 * 所以「worker 里到底算了什么」这件事只能这样证明：
 * 把请求处理逻辑写成后端类 `ConflictWorkerBackend`，入口 `conflictWorker.ts`
 * 只负责把它挂到 `self.onmessage` 上。断言脚本在 Node 里直接 import 这个后端，
 * 用**结构化克隆过一遍**的请求跑它，再与主线程同步路径逐字比较 ——
 * 验的就是"worker 里那段代码"，而不是它的仿制品。
 *
 * 而 `attachWorkerScope()` 覆盖剩下的接线部分：
 * 消息进来 → 后端处理 → `postMessage` 回包，包括取消与错误两个分支。
 */

import { AIR } from '../data/voxelTypes';
import { CHUNK_SIZE, Chunk } from '../voxel/Chunk';
import { VoxelGrid } from '../voxel/VoxelGrid';
import {
  ConflictDetector,
  type ConflictRecord,
  type DetectOptions,
  type StagedObject,
} from '../world/ConflictDetector';
import { ConflictResolver, type ResolveOptions } from '../world/ConflictResolver';
import type { ConflictResponse, GridSnapshot, WorkerScopeLike } from './workerTypes';

/** 合法的冲突类型名（校验 worker 回包用；刻意用 string[]，只做形状校验，不做类型断言） */
const CONFLICT_TYPE_NAMES: readonly string[] = [
  'overlap',
  'floating',
  'outOfBounds',
  'buried',
  'blocks-doorway',
];

/** 合法的修复结果名 */
const RESOLUTION_NAMES: readonly string[] = ['moved', 'deleted', 'adjusted', 'unresolved'];

// ------------------------------------------------------------------ 快照

/**
 * 把真实地形打包成快照（**主线程调用**）。
 *
 * **一趟遍历**：先按"世界总格数"申请上界长度的 TypedArray，最后 `slice` 到实际长度。
 * 第一版写的是"先数一遍非空气格、再填一遍"，两趟全量扫描 —— 实测在大世界
 * （192×32×192、62 万非空气格）上光打包就要 52.6 ms，而它替换掉的检测本身只要 17.7~20.5 ms。
 * 改成一趟之后同一台机器上降到 30.4~40.3 ms，代价只是末尾一次 `slice` 拷贝（内存连续）。
 *
 * ⚠ **必须如实记下的一点**：即使优化过，"把地形打包给 worker"的代价仍然**不比检测本身小**。
 * 新手档（48×16×48、92 个物体）打包 1.6~2.7 ms / 检测 1.8~3.4 ms，基本打平；
 * 大档（718 个物体）打包 30~40 ms / 检测 17.7~20.5 ms，主线程反而是净亏的。
 * 也就是说：**这一轮把阶段 9 搬进 worker 并不能减小主线程的开销**，
 * 真正能省下来的是"检测那 20 ms 不在主线程跑"，而搬运成本吃掉了它。
 * 想让 worker 路径真正划算，得减少搬运量（列级快照 / worker 侧缓存地形），
 * 那需要改 `VoxelGrid` 的导出接口或协议 —— 本轮**没有做**，见交付报告。
 *
 * 刻意**不用** `grid.nonAir` 当申请长度：它由 `setVoxel` / `clear` / `recount` 维护，
 * 一旦有代码绕过这些入口写区块（例如直接 `chunk.setLocal`），计数就会漂移，
 * 快照要么截断要么越界。用"总格数"这个上界则永远安全。
 */
export function buildGridSnapshot(grid: VoxelGrid): GridSnapshot {
  const chunks = grid.chunkList;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error('地形的 chunkList 不可用，无法打包给 worker');
  }
  const sizeX = grid.sizeX;
  const sizeZ = grid.sizeZ;
  const layer = sizeX * sizeZ;

  const maxCells = layer * grid.sizeY;
  const allIndices = new Int32Array(maxCells);
  const allIds = new Uint8Array(maxCells);
  let cursor = 0;

  for (const chunk of chunks) {
    const originX = chunk.cx * CHUNK_SIZE;
    const originZ = chunk.cz * CHUNK_SIZE;
    const data = chunk.voxels;
    for (let y = 0; y < chunk.sizeY; y += 1) {
      for (let z = 0; z < CHUNK_SIZE; z += 1) {
        const worldZ = originZ + z;
        // 世界尺寸不是 16 的整数倍时，最后一个区块会有一部分落在世界外，
        // 那部分单元格不能进快照（否则扁平下标会算到别的列上去）
        if (worldZ >= sizeZ) continue;
        const rowBase = worldZ * sizeX + y * layer;
        // 行内用 base + x 直取数组：每格少一次 Chunk.index 的乘加，62 万格下这是几毫秒的差别
        const base = Chunk.index(0, y, z);
        for (let x = 0; x < CHUNK_SIZE; x += 1) {
          const worldX = originX + x;
          if (worldX >= sizeX) continue;
          const id = data[base + x];
          if (id === AIR) continue;
          allIndices[cursor] = worldX + rowBase;
          allIds[cursor] = id;
          cursor += 1;
        }
      }
    }
  }

  return {
    sizeX,
    sizeY: grid.sizeY,
    sizeZ,
    indices: cursor === maxCells ? allIndices : allIndices.slice(0, cursor),
    ids: cursor === maxCells ? allIds : allIds.slice(0, cursor),
  };
}

/**
 * 用快照重建地形（**worker 侧调用**）。
 *
 * 刻意只用公开 API（构造函数 + `setVoxel`），不写 `chunk.voxels` 这种后门：
 * 只要走的是真实 `VoxelGrid` 的写入路径，重建结果就不可能与真实网格的行为漂移
 * （`setVoxel` 还会顺手维护统计量、脏标记与水位，虽然检测器不读它们）。
 *
 * 代价必须说清楚：**每个非空气格一次 `setVoxel` 调用，实测 62 万格要 124~133 ms、
 * 2.2 万格要 4.5~6.5 ms** —— 比检测本身还贵。这笔时间花在 worker 线程上（不阻塞主线程），
 * 所以它是"worker 侧多烧 CPU"，不是"主线程变慢"。要把它降下来只能直接写 `chunk.voxels`
 * 或改成惰性查询适配器，两者都会引入"与 VoxelGrid 实现漂移"的风险，本轮选择不冒这个险，
 * 代价如实写在这里与报告里。
 */
export function gridFromSnapshot(snapshot: GridSnapshot): VoxelGrid {
  const grid = new VoxelGrid(snapshot.sizeX, snapshot.sizeY, snapshot.sizeZ);
  const { indices, ids, sizeX, sizeZ } = snapshot;
  const layer = sizeX * sizeZ;
  for (let i = 0; i < indices.length; i += 1) {
    const flat = indices[i];
    const y = Math.floor(flat / layer);
    const rest = flat - y * layer;
    const z = Math.floor(rest / sizeX);
    const x = rest - z * sizeX;
    grid.setVoxel(x, y, z, ids[i]);
  }
  return grid;
}

// ------------------------------------------------------------------ 形状校验（两边共用）

export function isGridSnapshot(value: unknown): value is GridSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record['sizeX']) &&
    Number.isInteger(record['sizeY']) &&
    Number.isInteger(record['sizeZ']) &&
    record['indices'] instanceof Int32Array &&
    record['ids'] instanceof Uint8Array
  );
}

function isConflictRecord(value: unknown): value is ConflictRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const position = record['position'];
  return (
    typeof record['id'] === 'string' &&
    typeof record['type'] === 'string' &&
    CONFLICT_TYPE_NAMES.includes(record['type']) &&
    Array.isArray(record['objects']) &&
    record['objects'].every((item) => typeof item === 'string') &&
    Array.isArray(position) &&
    position.length === 3 &&
    position.every((item) => typeof item === 'number') &&
    typeof record['detail'] === 'string' &&
    typeof record['severity'] === 'number' &&
    typeof record['resolution'] === 'string' &&
    RESOLUTION_NAMES.includes(record['resolution'])
  );
}

/**
 * 回包形状校验（主线程用）。
 *
 * 为什么值得写这么细：worker 回包是**跨线程的不可信输入**。形状不对却照样当结果用，
 * UI 上会出现 `undefined` 位置、NaN 数量这类更难查的问题；
 * 形状不对就当场判为无效、走同步回退，代价只是一次多余的计算。
 */
export function isConflictResponse(value: unknown): value is ConflictResponse {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record['id'] !== 'number') return false;
  if (record['ok'] === false) return typeof record['error'] === 'string';
  if (record['ok'] !== true) return false;
  const status = record['status'];
  if (status !== 'done' && status !== 'cancelled') return false;
  if (typeof record['ms'] !== 'number') return false;
  if (!Array.isArray(record['conflicts'])) return false;
  return record['conflicts'].every((item) => isConflictRecord(item));
}

/** 消息里的请求 id（读不到就给 -1：这条回包的 id 永远不会与主线程配对，会被丢弃） */
function readRequestId(value: unknown): number {
  if (value === null || typeof value !== 'object') return -1;
  const id = (value as Record<string, unknown>)['id'];
  return typeof id === 'number' ? id : -1;
}

function describeUnknown(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return `${typeof value}：${String(value)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------ 后端

/**
 * Worker 侧的请求处理器。
 *
 * 有意做成"一条消息进、一条回包出"的纯处理器：入口只管喂消息与发回包，
 * 断言脚本可以完全绕过 `postMessage` 直接喂消息，两边跑的是同一段代码。
 */
export class ConflictWorkerBackend {
  /**
   * 还没开始算就被取消的请求 id。
   * 用 Set 而不是单个变量：多条取消消息可能先于它们对应的任务到达。
   */
  private readonly cancelled = new Set<number>();

  /**
   * 处理一条消息。
   *
   * @returns 回包；`cancel` 消息本身不产生回包（返回 `null`）——
   *          被取消的**任务**会自己回一条 `status: 'cancelled'`，那才是主线程需要的东西。
   */
  async handle(raw: unknown): Promise<ConflictResponse | null> {
    if (raw === null || typeof raw !== 'object') {
      return { id: -1, ok: false, error: `worker 收到的消息不是对象（${describeUnknown(raw)}）` };
    }
    const record = raw as Record<string, unknown>;
    const id = readRequestId(record);
    const kind = record['kind'];

    if (kind === 'cancel') {
      this.cancelled.add(id);
      return null;
    }
    if (kind !== 'detect' && kind !== 'resolve') {
      return {
        id,
        ok: false,
        error: `未知的任务类型：${describeUnknown(kind)}（只支持 detect / resolve / cancel）`,
      };
    }
    const rawObjects = record['objects'];
    if (!Array.isArray(rawObjects)) {
      return { id, ok: false, error: '请求里缺少 objects，或者它不是数组' };
    }
    const rawGrid = record['grid'];
    if (!isGridSnapshot(rawGrid)) {
      return {
        id,
        ok: false,
        error:
          '请求里的 grid 不是合法快照（需要整数 sizeX/sizeY/sizeZ 与 Int32Array indices、Uint8Array ids）',
      };
    }

    // 让出一个宏任务再开始算。理由：worker 是单线程的，同步计算一旦开始就无法中断，
    // 于是「取消」只有在计算开始前到达才有意义 —— 这一让给了紧跟其后的 cancel 一个到达窗口。
    // 代价是一次宏任务调度（本机 Node 上实测 setTimeout(0) 平均 1.55 ms，浏览器定时器分辨率不同）。
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    if (this.cancelled.delete(id)) {
      return {
        id,
        ok: true,
        status: 'cancelled',
        conflicts: [],
        ms: 0,
        note: '任务在开始计算前就被取消了，没有产出结果（这不等于「没有冲突」）',
      };
    }

    const startedAt = now();
    try {
      const objects = rawObjects as StagedObject[];
      const grid = gridFromSnapshot(rawGrid);
      if (kind === 'detect') {
        const options = readOptions<DetectOptions>(record['options']);
        const report = new ConflictDetector(options).detect({ objects, grid });
        return { id, ok: true, status: 'done', conflicts: report.conflicts, ms: now() - startedAt };
      }
      const options = readOptions<ResolveOptions>(record['options']);
      const seed = typeof record['seed'] === 'number' ? record['seed'] : 0;
      // objects 是结构化克隆出来的副本，就地修改（挪位置/删元素）不会影响主线程的任何东西
      const report = new ConflictResolver(options).resolve(objects, grid, seed);
      return { id, ok: true, status: 'done', conflicts: report.remaining, ms: now() - startedAt };
    } catch (error) {
      // 把 error.message 原样回传：吞掉错误会让主线程把"跑挂了"误读成"没有冲突"
      return { id, ok: false, error: describeError(error) };
    }
  }
}

/** 把消息里的 options 收成"看起来像对象就交给检测器"（检测器自己会合并默认值） */
function readOptions<T extends object>(value: unknown): T {
  return (value !== null && typeof value === 'object' ? value : {}) as T;
}

/**
 * 把后端挂到 worker 全局作用域上（入口的唯一一行）。
 *
 * 抽成函数是为了可测：断言脚本传一个假的 scope 进来，
 * 「消息进来 → 计算 → 回包」这条接线在 Node 里就能被真跑一遍。
 */
export function attachWorkerScope(scope: WorkerScopeLike): void {
  const backend = new ConflictWorkerBackend();
  scope.onmessage = (event: { data: unknown }): void => {
    const id = readRequestId(event.data);
    void backend
      .handle(event.data)
      .then((response) => {
        if (response !== null) scope.postMessage(response);
      })
      .catch((error: unknown) => {
        // 理论上到不了这里（handle 内部全都 try/catch 了）。真到了这里就如实回一条错误，
        // 并且带上请求 id —— 主线程会因此当场降级，而不是一直干等到超时。
        scope.postMessage({ id, ok: false, error: describeError(error) });
      });
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
