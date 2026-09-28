/**
 * 冲突检测 Worker 的断言（M4 第 6 批）。
 *
 * 跑法见 `worker.run.ts`（esbuild 打包成 ESM 后在 Node 里跑）。
 *
 * ────────────────────────────────────────────────────────────
 * 这一轮的环境能验什么、不能验什么（先说清楚，免得被结论带偏）
 * ────────────────────────────────────────────────────────────
 * Node 里**没有** `Worker` 全局对象（`worker_threads` 不是浏览器 Worker，本项目一行都不用），
 * 所以：
 * - 能验：回退路径**真的被走到**、`source` / `fallbackReason` 自洽、
 *   回退结果与直接同步调用逐字一致、worker 里那段处理代码（`ConflictWorkerBackend`）
 *   在"结构化克隆过一遍的请求"上的结果与同步路径逐字一致、取消与错误两条分支的行为；
 * - 不能验：真浏览器里 `new Worker(...)` 能不能起来、Vite 有没有把 worker 打进产物、
 *   子路径（base = /god-sandbox/）下 worker 的 URL 对不对 ——
 *   **worker 路径尚未在浏览器里实测**，这一点在报告里如实写明，不在这里假装测过。
 *
 * 导出的是 async 版（`Promise<void>`）：几乎每条断言都要 `await runner.run(...)`，
 * 写成同步版就只能把 Promise 链丢到函数外面，那样失败信息会与断言对不上。
 * `worker.run.ts` 里是 `await runWorkerChecks(check)`，两种签名都兼容。
 */

import { AIR, getVoxelId } from '../../src/data/voxelTypes';
import { VoxelGrid } from '../../src/voxel/VoxelGrid';
import {
  ConflictDetector,
  DEFAULT_DETECT_OPTIONS,
  type ConflictRecord,
  type DetectOptions,
  type StagedObject,
} from '../../src/world/ConflictDetector';
import { ConflictResolver } from '../../src/world/ConflictResolver';
import {
  ConflictRunner,
  isWorkerAvailable,
  normalizeConflictOrder,
  type ConflictRunResult,
} from '../../src/world/ConflictRunner';
import {
  attachWorkerScope,
  buildGridSnapshot,
  ConflictWorkerBackend,
  gridFromSnapshot,
  isConflictResponse,
  isGridSnapshot,
} from '../../src/workers/conflictWorkerCore';
import type {
  ConflictDetectRequest,
  ConflictResolveRequest,
  ConflictResponse,
  GridSnapshot,
  WorkerScopeLike,
} from '../../src/workers/workerTypes';
// 副作用导入：证明 worker 入口在 Node 里也能被 import（它没有依赖 DOM / self）。
// 这也是"入口除了接线什么都没有"的间接证据。
import '../../src/workers/conflictWorker';

/** 断言函数由调用方提供（与 scripts/verify.ts 的 check 约定一致） */
export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

// ------------------------------------------------------------------ 场景搭建

const SIZE_X = 48;
const SIZE_Y = 16;
const SIZE_Z = 48;
/** 地面顶面的体素 y；于是"站在地面上"的世界 y 就是 GROUND_TOP + 1 */
const GROUND_TOP = 4;
const STONE = getVoxelId('stone');
/** 修复分支用的种子（两条路径必须用同一个，否则挪开方向不同、结果不可比） */
const RESOLVE_SEED = 20240601 ^ 0xbeef;

function buildFlatGrid(): VoxelGrid {
  const grid = new VoxelGrid(SIZE_X, SIZE_Y, SIZE_Z);
  for (let x = 0; x < SIZE_X; x += 1) {
    for (let z = 0; z < SIZE_Z; z += 1) {
      for (let y = 0; y <= GROUND_TOP; y += 1) grid.setVoxel(x, y, z, STONE);
    }
  }
  return grid;
}

/** 平地 + 一座小土丘（体素坐标 40~46 见方、y 5~8）—— 用来造"树被土盖住" */
function buildHillGrid(): VoxelGrid {
  const grid = buildFlatGrid();
  for (let x = 40; x <= 46; x += 1) {
    for (let z = 40; z <= 46; z += 1) {
      for (let y = GROUND_TOP + 1; y <= 8; y += 1) grid.setVoxel(x, y, z, STONE);
    }
  }
  return grid;
}

function makeItem(
  id: string,
  defId: string,
  position: [number, number, number],
  half: [number, number, number],
): StagedObject {
  return {
    id,
    kind: 'item',
    defId,
    position,
    rotationY: 0,
    half,
    movable: true,
    deletable: true,
    needsSupport: true,
  };
}

function makeDoor(
  id: string,
  defId: string,
  position: [number, number, number],
  half: [number, number, number],
): StagedObject {
  return {
    id,
    kind: 'building',
    defId,
    position,
    rotationY: 0,
    half,
    movable: false,
    deletable: false,
    needsSupport: false,
    blocksDoorway: true,
  };
}

/** 混合场景：正常 / 悬空 / 重叠 / 越界 / 挡门 各来一份 */
function mixedObjects(): StagedObject[] {
  return [
    makeItem('item:ok', 'mug', [5, GROUND_TOP + 1, 5], [0.2, 0.2, 0.2]),
    makeItem('item:float', 'mug', [8, 10, 8], [0.2, 0.2, 0.2]),
    makeItem('item:box-a', 'crate', [12, GROUND_TOP + 1, 12], [0.6, 0.6, 0.6]),
    makeItem('item:box-b', 'crate', [12.2, GROUND_TOP + 1, 12.2], [0.6, 0.6, 0.6]),
    // 24 - 0.5（边界内缩）= 23.5；23.8 + 0.5 = 24.3 > 23.5 → 越界
    makeItem('item:oob', 'crate', [23.8, GROUND_TOP + 1, 5], [0.5, 0.5, 0.5]),
    makeDoor('building:door', 'door_wood', [16, GROUND_TOP + 1, 16], [0.5, 1.05, 0.05]),
    // 站在门口正前方 0.8 米处 → 挡门
    makeItem('item:blocking', 'flowerpot', [16, GROUND_TOP + 1, 16.8], [0.25, 0.25, 0.25]),
  ];
}

/** 一棵长在土丘里的树（世界坐标 19 → 体素 43，正落在土丘 40~46 之内） */
function buriedTreeObjects(): StagedObject[] {
  return [
    {
      id: 'nature:tree-0',
      kind: 'nature',
      defId: 'tree_oak',
      position: [19, GROUND_TOP + 1, 19],
      rotationY: 0,
      half: [1.5, 2.5, 1.5],
      movable: true,
      deletable: true,
      needsSupport: false,
      crownRadius: 3,
      crownHeight: 5,
    },
  ];
}

/**
 * 修复场景：两面**不可移动、也不可删除**的墙叠在一起。
 * 检测器一定报 overlap，而修复器两条路都走不通（挪不动、不能删），
 * 所以 `remaining` 一定是**非空**的 —— 这样"run() 的 remaining 与直接调用一致"
 * 才是一条真断言（拿"0 条 vs 0 条"来比是自欺欺人）。
 */
function unresolvableObjects(): StagedObject[] {
  const wall = (id: string, x: number): StagedObject => ({
    id,
    kind: 'building',
    defId: 'wall_stone',
    position: [x, GROUND_TOP + 1, -8],
    rotationY: 0,
    half: [1, 1.5, 0.5],
    movable: false,
    deletable: false,
    needsSupport: false,
  });
  return [wall('building:wall-a', 0), wall('building:wall-b', 0.5)];
}

/** 200 个物体：两两同位（每对制造一处 overlap），用来验"量大也不超时、数量与同步一致" */
function manyObjects(): StagedObject[] {
  const list: StagedObject[] = [];
  for (let i = 0; i < 200; i += 1) {
    const cell = Math.floor(i / 2);
    const x = -20 + (cell % 20) * 2;
    const z = -20 + Math.floor(cell / 20) * 2;
    list.push(makeItem(`item:many-${i}`, 'crate', [x, GROUND_TOP + 1, z], [0.4, 0.4, 0.4]));
  }
  return list;
}

// ------------------------------------------------------------------ 工具

function detectSync(
  objects: readonly StagedObject[],
  grid: VoxelGrid,
  options?: DetectOptions,
): ConflictRecord[] {
  return new ConflictDetector(options ?? {}).detect({ objects, grid }).conflicts;
}

/** 供 resolve 比较用的一份独立副本（修复会就地改，所以每次都要新的一份） */
function copies(objects: readonly StagedObject[]): StagedObject[] {
  return objects.map((object) => ({
    ...object,
    position: [object.position[0], object.position[1], object.position[2]],
    half: [object.half[0], object.half[1], object.half[2]],
  }));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
      if (!deepEqual(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
}

function typeSequence(conflicts: readonly ConflictRecord[]): string {
  return conflicts.map((conflict) => `${conflict.type}#${conflict.id}`).join(' > ');
}

const HAS_CHINESE = /[\u4e00-\u9fa5]/;

function hasType(conflicts: readonly ConflictRecord[], type: ConflictRecord['type']): boolean {
  return conflicts.some((conflict) => conflict.type === type);
}

/** `source` 与 `fallbackReason` 必须自洽：用 worker 就没有回退原因，走回退就必须有中文原因 */
function sourceIsCoherent(result: ConflictRunResult): boolean {
  if (result.source === 'worker') return result.fallbackReason === null;
  return (
    typeof result.fallbackReason === 'string' &&
    result.fallbackReason.length > 0 &&
    HAS_CHINESE.test(result.fallbackReason)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * 读一次 `runner.busy`。
 *
 * 为什么要多一层函数：TypeScript 会把 `const x = obj.prop` 当成"引用别名"来做控制流收窄，
 * 于是 `x === true && obj.prop === false` 会被判成"true 与 false 没有交集"的编译错误
 * （getter 明明可以变，这是误报）。包一层函数调用就切断了别名关系，断言本身不变。
 */
function busyNow(runner: ConflictRunner): boolean {
  return runner.busy;
}

function captureError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------ 断言主体

export async function runWorkerChecks(check: CheckFn): Promise<void> {
  const flat = buildFlatGrid();
  const hill = buildHillGrid();
  const mixed = mixedObjects();
  const allResults: ConflictRunResult[] = [];

  // ---------------------------------------------------------- 1. 环境与可用性

  check(
    'Node 环境里 isWorkerAvailable() 为 false（如实反映环境，不假装可用）',
    isWorkerAvailable() === false,
    `typeof Worker = ${typeof (globalThis as { Worker?: unknown }).Worker}`,
  );
  check(
    'Node 里没有 Worker 全局对象（这正是回退路径会被走到的根本原因）',
    (globalThis as { Worker?: unknown }).Worker === undefined,
    'Node 的 worker_threads 不是浏览器 Worker，本项目不用它',
  );

  const runner = new ConflictRunner();
  check('runner.available 在 Node 下为 false', runner.available === false);
  check('刚建好的 runner 不忙（busy === false）', runner.busy === false);

  // ---------------------------------------------------------- 2. 回退路径与逐字一致

  const first = await runner.run(mixed, flat);
  allResults.push(first);
  const syncMixed = detectSync(mixed, flat);

  check(
    'Node 下 run() 走回退：source === "main-thread"（不许把回退报成 worker）',
    first.source === 'main-thread',
    `source = ${first.source}`,
  );
  check(
    '回退原因是非空中文（UI 上能看出"这次没用 worker"）',
    typeof first.fallbackReason === 'string' &&
      first.fallbackReason.length > 0 &&
      HAS_CHINESE.test(first.fallbackReason),
    first.fallbackReason ?? '(null)',
  );
  check(
    '回退结果与直接同步调用 ConflictDetector 深度相等（逐字一致）',
    deepEqual(first.conflicts, syncMixed),
    `${first.conflicts.length} 条 vs 同步 ${syncMixed.length} 条`,
  );
  check(
    '回退结果与同步结果的顺序完全一致（逐条「类型#id」序列）',
    typeSequence(first.conflicts) === typeSequence(syncMixed),
    typeSequence(first.conflicts),
  );
  check(
    '回退的 ms 是有限数值（不是 NaN / undefined）',
    Number.isFinite(first.ms) && first.ms >= 0,
    `${first.ms.toFixed(3)} ms`,
  );

  // ---------------------------------------------------------- 3. 五类冲突都能检出

  check(
    '有重叠的物体 → 检出 overlap',
    hasType(syncMixed, 'overlap'),
    typeSequence(syncMixed.filter((conflict) => conflict.type === 'overlap')),
  );
  check('悬空物体 → 检出 floating', hasType(syncMixed, 'floating'));
  check('越界物体 → 检出 outOfBounds', hasType(syncMixed, 'outOfBounds'));
  check(
    '挡住门洞的物体 → 检出 blocks-doorway',
    hasType(syncMixed, 'blocks-doorway'),
    typeSequence(syncMixed.filter((conflict) => conflict.type === 'blocks-doorway')),
  );

  const buriedRun = await runner.run(buriedTreeObjects(), hill);
  allResults.push(buriedRun);
  check(
    '埋住的树 → 检出 buried（树冠范围内的地形体素被占用）',
    hasType(buriedRun.conflicts, 'buried'),
    buriedRun.conflicts[0]?.detail ?? '(没有检出)',
  );

  // ---------------------------------------------------------- 4. 空集合、可复现、自洽

  const clean = [makeItem('item:solo', 'mug', [5, GROUND_TOP + 1, 5], [0.2, 0.2, 0.2])];
  const cleanRun = await runner.run(clean, flat);
  allResults.push(cleanRun);
  check(
    '没有冲突时返回空数组，且 source 依然被填对（空数组不等于"没算"）',
    cleanRun.conflicts.length === 0 &&
      cleanRun.source === 'main-thread' &&
      cleanRun.fallbackReason !== null,
    `source=${cleanRun.source}`,
  );

  const repeat = await runner.run(mixed, flat);
  allResults.push(repeat);
  check('同一个物体集合跑两次结果完全一致（可复现）', deepEqual(first.conflicts, repeat.conflicts));

  const emptyRun = await runner.run([], flat);
  allResults.push(emptyRun);
  check(
    '输入空数组不抛异常且返回空冲突',
    emptyRun.conflicts.length === 0 && emptyRun.source === 'main-thread',
  );

  // ---------------------------------------------------------- 5. 超时参数

  const zeroTimeout = new ConflictRunner({ timeoutMs: 0 });
  const zeroResult = await zeroTimeout.run(mixed, flat);
  allResults.push(zeroResult);
  check(
    'timeoutMs = 0 时自洽：要么超时降级、要么正常完成，但绝不把 source 报错',
    sourceIsCoherent(zeroResult) && deepEqual(zeroResult.conflicts, syncMixed),
    `source=${zeroResult.source}｜${zeroResult.fallbackReason ?? '(null)'}`,
  );

  const tinyTimeout = new ConflictRunner({ timeoutMs: 0.001 });
  const tinyResult = await tinyTimeout.run(mixed, flat);
  allResults.push(tinyResult);
  check(
    'timeoutMs = 0.001 时同样自洽，且结果仍是真实结果',
    sourceIsCoherent(tinyResult) && deepEqual(tinyResult.conflicts, syncMixed),
    `source=${tinyResult.source}`,
  );

  // ---------------------------------------------------------- 6. busy / dispose / cancel

  const busyRunner = new ConflictRunner();
  const busyPromise = busyRunner.run(mixed, flat);
  const busyDuring = busyNow(busyRunner);
  const busyResult = await busyPromise;
  const busyAfter = busyNow(busyRunner);
  allResults.push(busyResult);
  check(
    'busy 在运行中为 true、结束后为 false',
    busyDuring === true && busyAfter === false,
    `运行中 ${busyDuring}｜结束后 ${busyAfter}`,
  );

  const concurrentRunner = new ConflictRunner();
  const concurrentFirst = concurrentRunner.run(mixed, flat);
  const concurrentSecond = concurrentRunner.run(buriedTreeObjects(), hill);
  const [concurrentResultA, concurrentResultB] = await Promise.all([
    concurrentFirst,
    concurrentSecond,
  ]);
  allResults.push(concurrentResultA, concurrentResultB);
  check(
    '并发调用不排队：第二个任务如实标注 busy，并且仍返回真实结果',
    sourceIsCoherent(concurrentResultB) &&
      (concurrentResultB.fallbackReason ?? '').includes('busy') &&
      deepEqual(concurrentResultB.conflicts, detectSync(buriedTreeObjects(), hill)),
    concurrentResultB.fallbackReason ?? '(null)',
  );

  const cancelRunner = new ConflictRunner();
  const cancelPromise = cancelRunner.run(mixed, flat);
  cancelRunner.cancel();
  const cancelledResult = await cancelPromise;
  allResults.push(cancelledResult);
  check(
    'cancel() 之后 source 与 fallbackReason 依然自洽（不会出现 worker + 空原因 + 空结果）',
    sourceIsCoherent(cancelledResult) &&
      !(
        cancelledResult.source === 'worker' &&
        cancelledResult.fallbackReason === null &&
        cancelledResult.conflicts.length === 0
      ),
    `source=${cancelledResult.source}｜冲突 ${cancelledResult.conflicts.length} 条｜${
      cancelledResult.fallbackReason ?? '(null)'
    }`,
  );

  let cancelThrew = false;
  try {
    cancelRunner.cancel();
    cancelRunner.cancel();
  } catch {
    cancelThrew = true;
  }
  check('没有任务在跑时 cancel() 是空操作，不抛异常', cancelThrew === false);

  const disposeRunner = new ConflictRunner();
  disposeRunner.dispose();
  let disposeThrew = false;
  let disposeResult: ConflictRunResult | null = null;
  try {
    disposeResult = await disposeRunner.run(mixed, flat);
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

  // ---------------------------------------------------------- 7. 大输入

  const many = manyObjects();
  const manyStarted = now();
  const manyResult = await runner.run(many, flat);
  const manyMs = now() - manyStarted;
  allResults.push(manyResult);
  const manySync = detectSync(many, flat);
  check(
    '200 个物体：默认 4000 ms 预算内跑完（附真实耗时）',
    manyMs < 4000 && manyResult.source === 'main-thread',
    `${manyMs.toFixed(2)} ms`,
  );
  check(
    '200 个物体的结果数量与同步路径一致，且内容逐字一致',
    manyResult.conflicts.length === manySync.length &&
      deepEqual(manyResult.conflicts, manySync) &&
      manyResult.conflicts.length > 0,
    `${manyResult.conflicts.length} 条 vs 同步 ${manySync.length} 条`,
  );

  // ---------------------------------------------------------- 8. 自定义选项

  const customDetect: DetectOptions = {
    ...DEFAULT_DETECT_OPTIONS,
    overlapTolerance: 0.01,
    floatTolerance: 5,
  };
  const customResult = await runner.run(mixed, flat, { kind: 'detect', detect: customDetect });
  allResults.push(customResult);
  check(
    '自定义检测选项能一路传到检测器（结果与用同样选项直接同步调用一致）',
    deepEqual(customResult.conflicts, detectSync(mixed, flat, customDetect)),
    `${customResult.conflicts.length} 条（默认选项下是 ${syncMixed.length} 条）`,
  );

  // ---------------------------------------------------------- 9. resolve 分支

  const resolveInput = unresolvableObjects();
  const resolveBefore = JSON.stringify(resolveInput);
  const resolveResult = await runner.run(resolveInput, flat, {
    kind: 'resolve',
    seed: RESOLVE_SEED,
  });
  allResults.push(resolveResult);
  const resolveDirect = new ConflictResolver({}).resolve(copies(resolveInput), flat, RESOLVE_SEED)
    .remaining;
  check(
    'kind = "resolve" 时 run() 返回的 remaining 与直接调用 ConflictResolver 一致（且 remaining 非空，不是空对空）',
    resolveDirect.length > 0 && deepEqual(resolveResult.conflicts, resolveDirect),
    `${resolveResult.conflicts.length} 条 vs 直接 ${resolveDirect.length} 条`,
  );
  check(
    'resolve 分支不改动调用方传进来的 objects（两条路径的副作用一致）',
    JSON.stringify(resolveInput) === resolveBefore,
  );

  // ---------------------------------------------------------- 10. worker 侧那段代码（同一份）在克隆边界上的行为

  const backend = new ConflictWorkerBackend();
  const snapshot = buildGridSnapshot(flat);
  const detectRequest: ConflictDetectRequest = {
    id: 1,
    kind: 'detect',
    objects: mixed,
    grid: snapshot,
    options: {},
  };
  const clonedRequest: ConflictDetectRequest = structuredClone(detectRequest);

  check(
    '整个请求都能过结构化克隆（浏览器 postMessage 的边界），TypedArray 仍是 TypedArray',
    isGridSnapshot(clonedRequest.grid) &&
      clonedRequest.grid.indices instanceof Int32Array &&
      clonedRequest.grid.ids instanceof Uint8Array &&
      deepEqual(clonedRequest.objects, mixed),
    `快照非空气格 ${snapshot.indices.length} 个`,
  );

  const rebuilt = gridFromSnapshot(clonedRequest.grid);
  let rebuildDiff = 0;
  for (let x = 0; x < SIZE_X; x += 1) {
    for (let z = 0; z < SIZE_Z; z += 1) {
      if (rebuilt.solidSurfaceHeight(x, z) !== flat.solidSurfaceHeight(x, z)) rebuildDiff += 1;
      for (let y = 0; y < SIZE_Y; y += 1) {
        if (rebuilt.getVoxel(x, y, z) !== flat.getVoxel(x, y, z)) rebuildDiff += 1;
      }
    }
  }
  check(
    '快照能重建出与源网格逐格一致的地形（getVoxel 与 solidSurfaceHeight 全量比对）',
    rebuildDiff === 0,
    `${SIZE_X}×${SIZE_Y}×${SIZE_Z} 格全部比对，差异 ${rebuildDiff} 处`,
  );

  const workerSideResponse = await backend.handle(structuredClone(detectRequest));
  check(
    'worker 里的那段处理代码（同一份 ConflictWorkerBackend）结果与同步路径逐字一致',
    workerSideResponse !== null &&
      workerSideResponse.ok === true &&
      workerSideResponse.status === 'done' &&
      deepEqual(workerSideResponse.conflicts, detectSync(mixed, flat)),
    `${
      workerSideResponse !== null && workerSideResponse.ok
        ? workerSideResponse.conflicts.length
        : '没有回包'
    } 条`,
  );

  const resolveRequest: ConflictResolveRequest = {
    id: 2,
    kind: 'resolve',
    objects: copies(resolveInput),
    grid: snapshot,
    options: {},
    seed: RESOLVE_SEED,
  };
  const workerResolve = await backend.handle(structuredClone(resolveRequest));
  check(
    'worker 侧 resolve 的 remaining 与直接调用 ConflictResolver 一致（同样要求 remaining 非空）',
    workerResolve !== null &&
      workerResolve.ok === true &&
      resolveDirect.length > 0 &&
      deepEqual(workerResolve.conflicts, resolveDirect),
    `${workerResolve !== null && workerResolve.ok ? workerResolve.conflicts.length : '没有回包'} 条`,
  );

  // ---------------------------------------------------------- 11. 取消 / 错误 / 畸形输入

  const cancelBackend = new ConflictWorkerBackend();
  const cancelledRequest: ConflictDetectRequest = { ...detectRequest, id: 99 };
  // 先发起任务（它会先让出一个宏任务才会开始算），紧接着取消：这就是 cancel 真正能生效的窗口
  const taskPromise = cancelBackend.handle(structuredClone(cancelledRequest));
  const cancelAck = await cancelBackend.handle({ id: 99, kind: 'cancel' });
  const cancelledResponse = await taskPromise;
  check(
    'worker 侧任务在开始计算前收到 cancel → 回 status = "cancelled"（能与"跑挂了"区分开）',
    cancelAck === null &&
      cancelledResponse !== null &&
      cancelledResponse.ok === true &&
      cancelledResponse.status === 'cancelled',
    cancelledResponse !== null && cancelledResponse.ok
      ? `${cancelledResponse.status}：${cancelledResponse.note ?? ''}`
      : '(没有回包)',
  );

  const malformed = await backend.handle({ id: 7, kind: 'detect' });
  check(
    '畸形请求（缺 objects / grid）回 ok:false 且原因是中文，而不是抛异常或静默',
    malformed !== null && malformed.ok === false && HAS_CHINESE.test(malformed.error),
    malformed !== null && malformed.ok === false ? malformed.error : '(没有回包)',
  );

  const unknownKind = await backend.handle({ id: 8, kind: '炸了' });
  check(
    '未知任务类型回 ok:false 并带上收到的值（不猜、不吞）',
    unknownKind !== null && unknownKind.ok === false && unknownKind.error.includes('炸了'),
    unknownKind !== null && unknownKind.ok === false ? unknownKind.error : '(没有回包)',
  );

  // 构造一个"看起来合法、但重建时真会抛错"的快照：sizeY 大到 Uint8Array 分配不出来
  const explodingSnapshot: GridSnapshot = {
    sizeX: 3,
    sizeY: 1e15,
    sizeZ: 3,
    indices: new Int32Array(0),
    ids: new Uint8Array(0),
  };
  let directMessage = '';
  try {
    gridFromSnapshot(explodingSnapshot);
  } catch (error) {
    directMessage = captureError(error);
  }
  const exploded = await backend.handle({
    id: 9,
    kind: 'detect',
    objects: [],
    grid: explodingSnapshot,
    options: {},
  });
  check(
    '计算真抛错时 error.message 原样回传（不加工、不吞）',
    directMessage !== '' &&
      exploded !== null &&
      exploded.ok === false &&
      exploded.error === directMessage,
    `原生 message = ${directMessage}`,
  );

  check(
    'isConflictResponse 能识破畸形回包（形状不对就不当结果用，改走回退）',
    isConflictResponse({ id: 1, ok: true, status: 'done', conflicts: '不是数组', ms: 1 }) === false &&
      isConflictResponse({ id: 1, ok: 'yes' }) === false &&
      isConflictResponse({ id: 1, ok: true, status: 'done', conflicts: [], ms: 1 }) === true,
  );

  // ---------------------------------------------------------- 12. 接线（onmessage → 计算 → postMessage）

  const posted: ConflictResponse[] = [];
  const scope: WorkerScopeLike = {
    onmessage: null,
    postMessage: (message: unknown): void => {
      posted.push(message as ConflictResponse);
    },
  };
  attachWorkerScope(scope);
  const wiredRequest: ConflictDetectRequest = { ...detectRequest, id: 42 };
  scope.onmessage?.({ data: structuredClone(wiredRequest) });
  await delay(30);
  const wiredResponse = posted[0];
  check(
    'conflictWorker 的接线（onmessage → 后端计算 → postMessage 回包）在 Node 里也能跑通',
    posted.length === 1 &&
      wiredResponse !== undefined &&
      wiredResponse.ok === true &&
      deepEqual(wiredResponse.conflicts, syncMixed),
    `${posted.length} 条回包`,
  );

  // ---------------------------------------------------------- 13. 规范化排序工具（run() 本身不重排）

  const normalized = normalizeConflictOrder(syncMixed);
  const normalizedTwice = normalizeConflictOrder(normalized);
  let sortedCorrectly = true;
  for (let i = 1; i < normalized.length; i += 1) {
    const previous = normalized[i - 1];
    const current = normalized[i];
    if (previous === undefined || current === undefined) continue;
    if (previous.type > current.type) sortedCorrectly = false;
    if (previous.type === current.type && previous.id > current.id) sortedCorrectly = false;
  }
  check(
    'normalizeConflictOrder 严格有序且幂等（run() 不调用它：重排会破坏与同步路径的逐字一致）',
    sortedCorrectly &&
      normalized.length === syncMixed.length &&
      deepEqual(normalizedTwice, normalized),
    typeSequence(normalized),
  );

  // ---------------------------------------------------------- 14. 参数错误的处理

  let gridError = '';
  try {
    await runner.run(mixed, { 不是: '网格' });
  } catch (error) {
    gridError = captureError(error);
  }
  check(
    'world 不是体素网格时抛中文错误，而不是静默返回空结果（空结果会被读成"没有冲突"）',
    HAS_CHINESE.test(gridError) && gridError.includes('world'),
    gridError,
  );

  let kindError = '';
  try {
    await runner.run(mixed, flat, { kind: '乱写' });
  } catch (error) {
    kindError = captureError(error);
  }
  check('非法 kind 抛中文错误', HAS_CHINESE.test(kindError) && kindError.includes('kind'), kindError);

  // ---------------------------------------------------------- 15. 全局自洽性收尾

  check(
    '所有跑过的结果里，source 与 fallbackReason 都自洽（worker ⟺ 没有回退原因）',
    allResults.length >= 12 && allResults.every((result) => sourceIsCoherent(result)),
    `共检查 ${allResults.length} 条结果`,
  );
  check(
    '所有跑过的结果都是有限毫秒数（没有 NaN）',
    allResults.every((result) => Number.isFinite(result.ms)),
  );
  check(
    '快照体积等于非空气格数（AIR 不进快照）',
    snapshot.indices.length === SIZE_X * (GROUND_TOP + 1) * SIZE_Z &&
      flat.getVoxel(0, SIZE_Y - 1, 0) === AIR,
    `indices=${snapshot.indices.length}，期望 ${SIZE_X * (GROUND_TOP + 1) * SIZE_Z}`,
  );
}
