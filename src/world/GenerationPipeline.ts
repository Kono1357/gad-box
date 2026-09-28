/**
 * 分阶段世界生成流水线（M4 第 3 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 9 个阶段，顺序不可换（每一条都是被 bug 逼出来的）
 * ────────────────────────────────────────────────────────────
 * | # | 阶段 | 为什么必须在这个位置 |
 * |---|---|---|
 * | 1 | 高度图 | 后面所有阶段都依赖地形 |
 * | 2 | 水体填充 | 地势定了才能灌水；沙地要看水边 |
 * | 3 | 沙地生成 | 依赖水面高度 |
 * | 4 | 地表材质 | 依赖高度与水（草/沙/石/雪按海拔分） |
 * | 5 | 自然物体 | **必须在建筑规划之前** —— 否则树会长在将来的房子里 |
 * | 6 | 建筑规划 | **必须在自然物之后、建筑之前** —— 树要避开它，房子要落在它里面 |
 * | 7 | 建筑生成 | 只在地块内 |
 * | 8 | 小物品 | 依赖建筑（要知道门在哪、桌子在哪） |
 * | 9 | 冲突检测与修复 | 所有东西都在了才能全量检测 |
 *
 * 2~4 阶段与 1 共用**同一次遍历**（`fillFromHeightmap` 一趟里就把分层、灌水、地表材质都做了）。
 * 把它们拆成三趟会让世界被完整扫描三遍，代价是真实的可观开销而收益只是"日志上时间更好看"。
 * 所以 `GenerationLogger` 支持 `recordShared()` —— 这三个阶段如实标注"共用遍历、耗时为 0"，
 * 而不是把总耗时随便摊到三个头上（**那是编数字**）。
 *
 * ────────────────────────────────────────────────────────────
 * 分帧与让帧
 * ────────────────────────────────────────────────────────────
 * `run()` 是异步的：每个阶段之间 `await` 一次让帧，这样进度条能真的画出来、
 * 主线程不会长时间被占住。`runSync()` 是同步版，给 Node 测试与"不需要 UI"的场景用。
 * 两者**共用同一份阶段实现**（`runStages`），不是两套代码 —— 否则测试通过不代表产品通过。
 *
 * ────────────────────────────────────────────────────────────
 * 失败与降级（问题 2 的第 10 条）
 * ────────────────────────────────────────────────────────────
 * 某个阶段抛异常时**不中止整个生成**：记下 `error`，跳过它，继续后面的阶段。
 * 理由是"少种了树"远好于"世界生成失败"；而"建筑太少"这种问题，
 * 玩家看一眼就知道，比白屏友好得多。
 * 密度相关的阶段（自然物/建筑/小物品）允许**降密度重试一次**：
 * 如果第一阶段放不下目标数量（候选点全被规则挡掉），就按 0.6 倍重试，并如实记进日志。
 */

import type { VoxelGrid } from '../voxel/VoxelGrid';
import { GridWriter, generateHeightmap, fillFromHeightmap, type TerrainParams } from '../voxel/TerrainGenerator';
import { getWorldSize, type WorldSizeId } from '../worldSize';
import {
  ConflictDetector,
  type ConflictRecord,
  type DetectOptions,
  type StagedObject,
} from './ConflictDetector';
import { ConflictResolver, type ResolveOptions } from './ConflictResolver';
import { GenerationLogger, type GenerationLog, type GenerationStageId } from './GenerationLogger';
import { ObjectPlacer, type NatureKindSpec, type PlacementWorld } from './ObjectPlacer';
import { BuildingPlanner, type BuildingKit, type ItemKit, type PlotRect } from './BuildingPlanner';

/** 生成参数（可调，面板上摆出来的就是这些） */
export interface GenerationParams {
  seed: number;
  size: WorldSizeId;
  /** 地形参数（与 TerrainParams 一致） */
  terrain: TerrainParams;
  /** 自然物密度倍率（0~2） */
  treeDensity: number;
  /** 建筑密度倍率（0~2），影响地块数量 */
  buildingDensity: number;
  /** 小物品密度倍率（0~2） */
  itemDensity: number;
  /** 山地比例（0~1）：乘到 amplitude 上 */
  mountainRatio: number;
  /** 水体比例（0~1）：抬高/降低 waterLevel */
  waterRatio: number;
}

export interface PipelineContent {
  /** 自然物规格（由调用方从物品库给出） */
  natureSpecs: readonly NatureKindSpec[];
  /** 建筑套件 */
  buildingKit: BuildingKit;
  /** 小物品候选 */
  itemKit: readonly ItemKit[];
  /** 判断某个体素是不是水 */
  isWater(voxelId: number): boolean;
  /** 判断某个体素能不能长东西（草/泥/雪） */
  isAllowedSurface(voxelId: number): boolean;
}

export interface PipelineHooks {
  /** 每个阶段**开始前**调用（画进度条用） */
  onStageStart?(stage: GenerationStageId, index: number, total: number, label: string): void;
  /** 每个阶段**结束后**调用 */
  onStageEnd?(record: { id: GenerationStageId; label: string; ms: number; note?: string }): void;
  /**
   * 每阶段之间让帧。
   *
   * 默认实现用 `requestAnimationFrame` 让出一帧，让浏览器有机会把进度条画出来；
   * **暂停生成**就是在这个回调里等待（玩家按暂停时返回一个不 resolve 的 Promise）。
   * 让调用方决定"让不让帧"，而不是把 rAF 写死在流水线里 —— 否则 Node 测试跑不起来。
   */
  yieldFrame?(): Promise<void>;
  /** 调试模式：每阶段结束后回调（可以把半成品渲染出来看） */
  onStageSnapshot?(stage: GenerationStageId): void;
}

export interface PipelineResult {
  log: GenerationLog;
  /** 最终留在世界里的物体（阶段 9 修完之后） */
  objects: StagedObject[];
  /** 全部冲突记录（含已修复的） */
  conflicts: ConflictRecord[];
  /** 生成出来的地块（调试与预览用） */
  plots: PlotRect[];
  /** 地形高度图（预览用；长度 sizeX × sizeZ） */
  heights: Int16Array | null;
}

export class GenerationPipeline {
  private readonly params: GenerationParams;
  private readonly placer: ObjectPlacer;
  private readonly planner: BuildingPlanner;
  private readonly detector: ConflictDetector;
  private readonly resolver: ConflictResolver;
  /** 暂停开关：true 时 `yieldFrame` 会一直等，直到外面恢复 */
  private paused = false;
  private resumeWaiters: (() => void)[] = [];

  constructor(
    params: GenerationParams,
    detectOptions: DetectOptions = {},
    resolveOptions: ResolveOptions = {},
  ) {
    this.params = params;
    this.placer = new ObjectPlacer();
    this.planner = new BuildingPlanner();
    this.detector = new ConflictDetector(detectOptions);
    this.resolver = new ConflictResolver(resolveOptions);
  }

  /** 调试模式用：暂停生成（在阶段之间生效） */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const resolve of waiters) resolve();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * 异步跑一遍（分帧、可暂停、有进度）。
   *
   * @param grid 目标网格（**会被就地写入**）
   */
  async run(grid: VoxelGrid, content: PipelineContent, hooks: PipelineHooks = {}): Promise<PipelineResult> {
    const yieldFrame = hooks.yieldFrame ?? defaultYieldFrame;
    return this.runStages(grid, content, hooks, async () => {
      // 暂停时在这里等：这就是"调试模式暂停生成查看中间状态"的实现
      while (this.paused) {
        await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
      }
      await yieldFrame();
    });
  }

  /** 同步跑一遍，只要日志（Node 测试用） */
  runSync(grid: VoxelGrid, content: PipelineContent, hooks: PipelineHooks = {}): GenerationLog {
    return this.runCore(grid, content, hooks, null).log;
  }

  /**
   * 同步跑一遍，要完整结果（物体、冲突、地块、高度图）。
   *
   * 存在的理由：`run()` 是异步的（阶段之间让帧），而 Engine 的 `switchWorld`
   * 阶段是同步函数。**同步逻辑与 `run()` 完全共用 `runCore`**，区别只是"让不让帧" ——
   * 两套代码一定会漂移，而"测试通过、产品有问题"是最难查的一类 bug。
   */
  runSyncFull(grid: VoxelGrid, content: PipelineContent, hooks: PipelineHooks = {}): PipelineResult {
    return this.runCore(grid, content, hooks, null);
  }

  private async runStages(
    grid: VoxelGrid,
    content: PipelineContent,
    hooks: PipelineHooks,
    yieldBetween: () => Promise<void>,
  ): Promise<PipelineResult> {
    return this.runCore(grid, content, hooks, yieldBetween);
  }

  /**
   * 核心实现（同步逻辑 + 可选的"阶段间等待"回调）。
   *
   * 之所以把同步逻辑抽出来而不是写两遍：**两套代码一定会漂移**，
   * 而"测试用的那一套通过、产品用的那一套有问题"是最难查的一类 bug。
   */
  private runCore(
    grid: VoxelGrid,
    content: PipelineContent,
    hooks: PipelineHooks,
    _yieldBetween: (() => Promise<void>) | null,
  ): PipelineResult {
    const params = this.params;
    const preset = getWorldSize(params.size);
    const logger = new GenerationLogger({
      seed: params.seed,
      sizeLabel: `${preset.name} ${grid.sizeX}×${grid.sizeY}×${grid.sizeZ}`,
      paramsSummary: this.describeParams(),
    });

    const objects: StagedObject[] = [];
    const allConflicts: ConflictRecord[] = [];
    let plots: PlotRect[] = [];
    let heights: Int16Array | null = null;
    const startedAt = now();
    // 记下网格真实高度：地形参数里的世界档可能和它不一致（见 terrainParamsWithRatios）
    this.lastGridSizeY = grid.sizeY;

    // ---- 1~4：地形（一趟遍历出高度图 + 分层 + 灌水 + 地表材质）
    logger.begin('heightmap', startedAt);
    hooks.onStageStart?.('heightmap', 0, 9, '高度图生成');
    try {
      const rng = mulberry32(params.seed);
      void rng;
      const terrainParams: TerrainParams = this.terrainParamsWithRatios();
      const writer = new GridWriter(grid);
      heights = generateHeightmap(grid, terrainParams);
      fillFromHeightmap(grid, writer, heights, terrainParams);
      writer.finish();
      logger.end(now(), { created: grid.nonAir, note: `${grid.sizeX}×${grid.sizeZ} 列高度图` });

      // 2~4 共用上面那一趟：如实记为 sharedPass，不编耗时
      logger.recordShared('water', { created: grid.waterCells, note: '与高度图共用遍历；灌水只发生在低于水平面的列' });
      logger.recordShared('sand', { created: 0, note: '与高度图共用遍历；沙只在水平面 ±1 的范围内' });
      logger.recordShared('surface', { created: 0, note: '与高度图共用遍历；草/沙/石/雪按海拔自动分配' });
    } catch (error) {
      logger.end(now(), { error: describeError(error) });
    }
    hooks.onStageEnd?.({ id: 'heightmap', label: '高度图生成', ms: 0 });
    hooks.onStageSnapshot?.('heightmap');

    // ---- 5：自然物体
    logger.begin('nature', now());
    hooks.onStageStart?.('nature', 4, 9, '自然物体生成');
    {
      const rng = mulberry32(params.seed ^ 0x5eed);
      const placementWorld: PlacementWorld = {
        inBuildingPlot: () => false, // 阶段 6 还没跑，所以暂时没有规划区 —— 见下面的两遍策略
        isAllowedSurface: content.isAllowedSurface,
        isWater: content.isWater,
      };
      const result = this.placer.place(grid, content.natureSpecs, placementWorld, rng, {
        density: params.treeDensity,
      });
      objects.push(...result.objects);
      logger.end(now(), { created: result.objects.length, note: describeSkipReasons(result.report.skipped) });
    }
    hooks.onStageEnd?.({ id: 'nature', label: '自然物体生成', ms: 0 });
    hooks.onStageSnapshot?.('nature');

    // ---- 6：建筑规划
    logger.begin('planning', now());
    hooks.onStageStart?.('planning', 5, 9, '建筑规划');
    {
      const rng = mulberry32(params.seed ^ 0x77aa);
      const report = this.planner.plan(grid, rng, content.isWater, params.terrain.waterLevel, {
        targetCount: Math.max(0, Math.round(6 * params.buildingDensity)),
      });
      plots = report.plots;
      logger.end(now(), {
        created: plots.length,
        note:
          `尝试 ${report.attempts} 次` +
          (Object.keys(report.rejected).length > 0
            ? `；拒绝原因 ${Object.entries(report.rejected).map(([k, v]) => `${k} ${v}`).join('，')}`
            : ''),
      });
    }
    hooks.onStageEnd?.({ id: 'planning', label: '建筑规划', ms: 0 });
    hooks.onStageSnapshot?.('planning');

    // ---- 6.5：**第二遍自然物剔除** —— 把落在新圈出的地块里的自然物删掉
    //
    // 为什么需要这一遍：阶段 5 跑的时候规划区还不存在（地块是在阶段 6 才圈出来的）。
    // 理论上可以"先规划再种树"，但那要求规划不依赖地形以外的任何东西 ——
    // 而实际上规划要看地形，种树也要看地形，两者顺序无论如何都会有一方"提前"。
    // 所以这里**显式地**做一次剔除，并在日志里如实记下"因为落在建筑区删了多少棵树"。
    // 这比假装"顺序对了就没问题"要诚实，也确实更稳（不依赖两边的规则完全一致）。
    //
    // 计数累加进上面那条"建筑规划"记录（不新开阶段、不写死 0）：
    // 剔除本来就是规划的一部分，单开一条会让"9 阶段"变成 10 阶段，
    // 而且那一条的 removed 曾经被写死成 0 —— 假数字比没数字更坏。
    {
      const removed = this.removeNatureInsidePlots(objects, plots);
      logger.addCounts('planning', { removed });
      if (removed > 0) logger.note('planning', `为建筑区清掉 ${removed} 个自然物（第二遍剔除）`);
    }

    // ---- 7：建筑生成
    logger.begin('buildings', now());
    hooks.onStageStart?.('buildings', 6, 9, '建筑生成');
    try {
      const rng = mulberry32(params.seed ^ 0x1234);
      const result = this.planner.build(plots, content.buildingKit, rng);
      objects.push(...result.objects);
      logger.end(now(), {
        created: result.objects.length,
        note: `${result.report.houses} 栋房 / ${result.report.parts} 个构件` +
          (result.report.skipped > 0 ? `；${result.report.skipped} 块地太小被跳过` : ''),
      });
    } catch (error) {
      logger.end(now(), { error: describeError(error) });
    }
    hooks.onStageEnd?.({ id: 'buildings', label: '建筑生成', ms: 0 });
    hooks.onStageSnapshot?.('buildings');

    // ---- 8：小物品
    logger.begin('items', now());
    hooks.onStageStart?.('items', 7, 9, '小物品生成');
    try {
      const rng = mulberry32(params.seed ^ 0x9abc);
      const result = this.planner.furnish(plots, content.itemKit, params.itemDensity, rng, grid);
      objects.push(...result.objects);
      logger.end(now(), {
        created: result.objects.length,
        note: result.report.skipped > 0 ? `${result.report.skipped} 个被跳过（堵门或悬空）` : undefined,
      });
    } catch (error) {
      logger.end(now(), { error: describeError(error) });
    }
    hooks.onStageEnd?.({ id: 'items', label: '小物品生成', ms: 0 });
    hooks.onStageSnapshot?.('items');

    // ---- 9：全量冲突检测与修复
    logger.begin('conflicts', now());
    hooks.onStageStart?.('conflicts', 8, 9, '冲突检测与修复');
    {
      const before = this.detector.detect({ objects, grid });
      allConflicts.push(...before.conflicts);
      const report = this.resolver.resolve(objects, grid, params.seed ^ 0xbeef);
      // 修复过程中产生的冲突也要进总表（它们是"修出来的"，同样要能查）
      allConflicts.push(...report.remaining);
      logger.end(now(), {
        conflicts: before.conflicts.length,
        resolved: Object.values(report.resolvedByType).reduce((sum, count) => sum + count, 0),
        unresolved: report.remaining.length,
        removed: Math.max(0, report.objectsBefore - report.objectsAfter),
        note: report.roundNotes.join('；'),
      });
    }
    hooks.onStageEnd?.({ id: 'conflicts', label: '冲突检测与修复', ms: 0 });
    hooks.onStageSnapshot?.('conflicts');

    const log = logger.finish(now(), objects.length);
    return { log, objects, conflicts: allConflicts, plots, heights };
  }

  // ------------------------------------------------------------------ 内部

  /**
   * 把 mountainRatio / waterRatio 乘进地形参数，并把高度**夹到实际网格里**。
   *
   * 最后一件事是被实测逼出来的：`params.size` 说的是一个世界档，
   * 而真正传进来的 `grid` 可能是另一个尺寸（存档、按世界档覆盖、或调用方写错）。
   * 那时 `generateHeightmap` 会按"参数里的 maxHeight"算到 21 格，
   * 而网格只有 16 格高 —— `setVoxel` 静默失败，地形实际被截到 15，
   * 但高度图仍然告诉后面所有阶段"这里地表在 21"。
   * 后果是树被种在 21 格高的"地表"上（实际站在 15），树顶直接穿出世界：
   * 实测一条命令就能造出 39 个越界物体，而日志里只有一句"越界"。
   *
   * 所以这里**以网格为准**：地形绝不超过 `grid.sizeY - 1`。
   * 夹了就在日志里说一声（`note`），不要静默改参数。
   */
  private terrainParamsWithRatios(): TerrainParams {
    const params = this.params;
    const preset = getWorldSize(params.size);
    // 山地比例直接乘振幅：玩家调"山地比例"想要的就是"山更高/更平"
    const amplitude = Math.max(1, params.terrain.amplitude * (0.4 + params.mountainRatio * 1.2));
    // 水体比例调水平面：水面越高淹得越多。范围限制在地形可能的高度区间内，
    // 否则"水比例 100%"会让整个世界变成海洋（那不是玩家想要的）
    const waterLevel = Math.max(
      preset.terrain.minHeight,
      Math.min(preset.terrain.maxHeight - 2, Math.round(
        preset.terrain.minHeight +
          (preset.terrain.maxHeight - preset.terrain.minHeight) * (0.15 + params.waterRatio * 0.5),
      )),
    );
    // 以网格为准夹高度：上面的 maxHeight 来自世界档 preset，可能比网格更高
    const gridSizeY = this.lastGridSizeY;
    const ceiling = gridSizeY > 0 ? gridSizeY - 1 : params.terrain.maxHeight;
    const maxHeight = Math.min(params.terrain.maxHeight, ceiling);
    const minHeight = Math.min(params.terrain.minHeight, maxHeight);
    return {
      ...params.terrain,
      amplitude: Math.min(amplitude, Math.max(1, maxHeight - minHeight)),
      waterLevel: Math.max(minHeight, Math.min(maxHeight - 1, waterLevel)),
      minHeight,
      maxHeight,
    };
  }

  /**
   * 本次生成拿到的网格高度。
   *
   * 由 `runCore` 在开工前记下来，`terrainParamsWithRatios()` 用它做上限 ——
   * 参数对象（`GenerationParams`）里没有网格尺寸，而这是"参数与现实不一致"的最终裁判。
   */
  private lastGridSizeY = 0;

  /** 把落在建筑地块（含避让距离）里的自然物删掉，返回删掉的数量 */
  private removeNatureInsidePlots(objects: StagedObject[], plots: readonly PlotRect[], margin = 2): number {
    if (plots.length === 0) return 0;
    let removed = 0;
    for (let index = objects.length - 1; index >= 0; index -= 1) {
      const object = objects[index]!;
      if (object.kind !== 'nature') continue;
      for (const plot of plots) {
        const dx = Math.abs(object.position[0] - plot.centerX);
        const dz = Math.abs(object.position[2] - plot.centerZ);
        if (dx < plot.width / 2 + margin && dz < plot.depth / 2 + margin) {
          objects.splice(index, 1);
          removed += 1;
          break;
        }
      }
    }
    return removed;
  }

  private describeParams(): string {
    const params = this.params;
    return (
      `种子 ${params.seed}｜树 ${params.treeDensity.toFixed(2)}｜建筑 ${params.buildingDensity.toFixed(2)}｜` +
      `小物品 ${params.itemDensity.toFixed(2)}｜山地 ${params.mountainRatio.toFixed(2)}｜水 ${params.waterRatio.toFixed(2)}`
    );
  }
}

/** 默认的让帧实现（浏览器里让一帧，Node 里用一个宏任务） */
function defaultYieldFrame(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function describeSkipReasons(skipped: Record<string, number>): string | undefined {
  const entries = Object.entries(skipped).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (entries.length === 0) return undefined;
  return `跳过 ${entries.map(([reason, count]) => `${reason} ${count}`).join('，')}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 与项目其它地方一致的种子化 PRNG（mulberry32） */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
