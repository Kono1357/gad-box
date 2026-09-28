/**
 * 生成预览（M4 补充 4）：在真正开跑流水线之前，先让玩家看一眼「这张图大概长什么样」。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么是「预览」而不是「小规模生成」
 * ────────────────────────────────────────────────────────────
 * 玩家调的是倍率（树密度、水体比例……），每动一下滑杆就真生成一遍世界会：
 * 1. 把当前世界覆盖掉（生成是就地写入 `VoxelGrid` 的）；
 * 2. 卡住几百毫秒（用户反馈的「生成时卡顿」正是要修的问题之一）。
 * 所以预览走的是**只读采样**：新开一张一次性网格，只跑地形与规划，画完就丢。
 *
 * ────────────────────────────────────────────────────────────
 * 哪里准、哪里不准（这段是给以后维护的人看的，也是给玩家看的）
 * ────────────────────────────────────────────────────────────
 * **准的部分**（都是从真实代码里读出来的，不是另写一份近似）：
 * - 高度场：调用与流水线阶段 1 **同一个导出函数** `generateHeightmap()`，
 *   地形参数也用与 `GenerationPipeline.terrainParamsWithRatios()` 逐字一致的倍率公式；
 * - 水位：与流水线同一套公式（世界档位的 minHeight/maxHeight 区间 × 水体比例）；
 * - 地表颜色：从**真的写出来的网格**里读（`fillFromHeightmap()` 跑过之后再取每列顶面体素），
 *   不是自己再实现一遍「草/沙/雪怎么分」；
 * - 建筑地块：直接调 `BuildingPlanner.plan()`（流水线的阶段 6），种子偏移与流水线一致；
 * - 树/灌木：直接调 `ObjectPlacer.place()`（阶段 5），再按阶段 6.5 的规则剔掉地块内的自然物。
 *
 * **不准的部分**（如实陈列在 `PreviewData.limitations` 里，不藏）：
 * - 采样是**重采样**：世界 96×96 采成 96×96 只是刚好 1:1，新手档 48×48 采成 96×96 是放大，
 *   大地图采成 96×96 是降采样 —— 步长大于 1 时，窄于一步的地形细节会被整列跳过；
 * - 预览用**高度场**代表地表：洞穴、悬垂、玩家挖出来的结构在预览上不存在；
 * - 预览**不跑物理**，也不跑阶段 7/8/9（建筑、小物品、冲突检测与修复），
 *   所以「房子最终在哪、小物品会不会堵门、东西会不会倒」都看不出来。
 *
 * ────────────────────────────────────────────────────────────
 * 地形基准从哪来（以及为什么这里要防一手）
 * ────────────────────────────────────────────────────────────
 * 地形基准直接取 `buildGenerationParams()` 给出的 `terrain`（也就是流水线真正会用的那份），
 * 倍率公式与 `GenerationPipeline.terrainParamsWithRatios()` 逐字一致 ——
 * 预览不自己另选一套基准，否则「预览很漂亮、生成出来是另一张图」就是必然的。
 *
 * 但这个基准曾经是占位值（`minHeight === maxHeight === 1`，`generateHeightmap()` 会对每列做
 * `clamp(h, minHeight, maxHeight)`，于是全世界被压成 1 格高的平地、地表全淹在水里）。
 * 所以这里加了一道 `detectDegenerateTerrainBand()`：基准自身不成立时改用世界档位的参数画画，
 * 并**在 limitations 里明说这次预览与实际生成可能不一致** —— 宁可说清，也不要画一张假的图
 * 或者在玩家面前静默地画一块平地。
 */

import { mulberry32 } from '../core/random';
import { loadEnabledPacks } from '../data/contentPacks';
import {
  getMapTemplate,
  TEMPLATE_PARAM_LIMITS,
  type MapTemplate,
} from '../data/mapTemplates';
import { AIR, colorToHexString, getVoxelId } from '../data/voxelTypes';
import { getWorldSize } from '../worldSize';
import { VoxelGrid } from '../voxel/VoxelGrid';
import {
  fillFromHeightmap,
  generateHeightmap,
  GridWriter,
  type TerrainParams,
} from '../voxel/TerrainGenerator';
import { BuildingPlanner, type PlotRect } from './BuildingPlanner';
import type { StagedObject } from './ConflictDetector';
import { buildGenerationParams, buildNatureSpecs, buildPlacementWorld } from './GenerationContent';
import { ObjectPlacer } from './ObjectPlacer';

/** 默认采样分辨率：96×96 = 9216 个采样点，画在缩略图上已经看不出块，再高就是白算 */
export const PREVIEW_DEFAULT_RESOLUTION = 96;
/** 分辨率下限：16×16 已经只剩轮廓，再低就画不出「这是哪张图」 */
export const PREVIEW_MIN_RESOLUTION = 16;
/** 分辨率上限：192×192 与最大世界档的横向尺寸相同，再高只会让缩略图变慢 */
export const PREVIEW_MAX_RESOLUTION = 192;

/** 与 `GenerationPipeline` 阶段 5 一致的种子偏移（换种子必须整张图一起换） */
const NATURE_SEED_XOR = 0x5eed;
/** 与 `GenerationPipeline` 阶段 6 一致的种子偏移 */
const PLANNING_SEED_XOR = 0x77aa;
/**
 * 与 `GenerationPipeline.removeNatureInsidePlots()` 的 margin 默认值一致（2 米）。
 * 那个方法是 private，拿不到它的值，所以这里只好抄一份 —— 那边改了余量，这里要跟着改，
 * 否则预览上会有几棵「其实会被清掉」的树。
 */
const PLOT_NATURE_MARGIN = 2;

const WATER_VOXEL = getVoxelId('water');
const WATER_OVERLAY = 'rgba(58, 126, 188, 0.55)';
const PLOT_STROKE = 'rgba(255, 226, 120, 0.95)';
/** 采样到的体素是 air（理论上不该发生）时的兜底色，按高度分层的兜底表 */
const FALLBACK_BANDS = [0x6f7f5a, 0x8aa06a, 0xb9b09a, 0xd6d9dd] as const;

export interface PreviewRequest {
  templateId: string;
  seed: number;
  /** 面板上的滑杆覆盖值（键 = `TEMPLATE_PARAM_LIMITS` 里的参数名），越界会被夹回范围 */
  overrides?: Record<string, number>;
  /** 采样分辨率，默认 96，超出 16~192 会被夹回 */
  resolution?: number;
}

export interface PreviewData {
  templateId: string;
  seed: number;
  resolution: number;
  /** 归一化高度场，长度 resolution*resolution，行主序（先 x 后 z）。这是**近似**：采样步长可能大于 1 体素 */
  heights: Float32Array;
  /**
   * 归一化时用的原始高度区间（体素 y，1 体素 = 1 米）：
   * `heights` 里的 0 对应 `minHeight`，1 对应 `maxHeight`。
   * 之所以把区间一起带出来，是因为「归一化后的 0.42」对玩家毫无意义，
   * 而「地表在 y≈9」是有意义的 —— 画图和文案都要用回原始值。
   */
  minHeight: number;
  maxHeight: number;
  /** 水位（归一化后），没有水时为 null */
  waterLevel: number | null;
  /** 采样代表的地表体素 id，用来上色。取的是该列**最上面**的体素，所以水下格子拿到的是水 */
  surfaceIds: Uint8Array;
  /**
   * 建议的建筑地块（俯视图上的矩形）。
   * 单位是**预览网格下标**（0 ~ resolution 的连续值），不是世界坐标 ——
   * 预览本身是重采样的，把世界坐标画在采样图上只会错位。
   */
  plots: { x0: number; z0: number; x1: number; z1: number }[];
  /** 树/灌木的预期位置（同样是预览网格下标），用来在预览上打点 */
  natureMarks: { x: number; z: number; kind: string }[];
  /** 预览做不到的事，必须如实陈列在 UI 上 */
  limitations: string[];
}

/** 把分辨率夹回 16~192；非有限数（NaN/Infinity/undefined）退回默认值 */
function clampResolution(resolution: number | undefined): number {
  if (resolution === undefined || !Number.isFinite(resolution)) return PREVIEW_DEFAULT_RESOLUTION;
  const rounded = Math.round(resolution);
  return Math.max(PREVIEW_MIN_RESOLUTION, Math.min(PREVIEW_MAX_RESOLUTION, rounded));
}

/** 只保留 `TEMPLATE_PARAM_LIMITS` 里认识、且是有限数的键：别的键（拼错了、旧版存档的残留）一律丢掉 */
function sanitizeOverrides(overrides: Record<string, number> | undefined): Record<string, number> {
  const clean: Record<string, number> = {};
  if (!overrides) return clean;
  for (const key of Object.keys(TEMPLATE_PARAM_LIMITS)) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
  }
  return clean;
}

/** 世界坐标 → 预览网格下标（连续值，可能带小数） */
function worldToPreview(value: number, stride: number, resolution: number): number {
  return Math.max(0, Math.min(resolution, value / stride));
}

/**
 * 预览用的地形参数：生成参数里的地形基准 × 模板倍率。
 *
 * 倍率公式（`0.4 + 1.2 × 高度倍率`、水位那条）与
 * `GenerationPipeline.terrainParamsWithRatios()` 逐字一致；基准直接取
 * `buildGenerationParams()` 给的 `gen.terrain`，也就是**别处不再抄一份世界档位参数**，
 * 谁改了基准预览就跟着改。
 *
 * 唯一的例外是「基准自身不成立」的情况（`minHeight === maxHeight`，历史上有过这种占位值）：
 * 那时按它画出来只会是一块平地，预览改用世界档位的参数并**在 limitations 里明说这次不一致**。
 */
function terrainForPreview(params: {
  seed: number;
  size: string;
  mountainRatio: number;
  waterRatio: number;
  terrain: TerrainParams;
}): { terrain: TerrainParams; bandWarning: string | null } {
  const bandWarning = detectDegenerateTerrainBand(params.terrain);
  const preset = getWorldSize(params.size);
  const base = bandWarning ? preset.terrain : params.terrain;
  const amplitude = Math.max(1, base.amplitude * (0.4 + params.mountainRatio * 1.2));
  const waterLevel = Math.max(
    base.minHeight,
    Math.min(
      base.maxHeight - 2,
      Math.round(
        base.minHeight + (base.maxHeight - base.minHeight) * (0.15 + params.waterRatio * 0.5),
      ),
    ),
  );
  return {
    terrain: {
      seed: params.seed,
      waterLevel,
      baseHeight: base.baseHeight,
      amplitude,
      minHeight: base.minHeight,
      maxHeight: base.maxHeight,
      snowLine: base.snowLine,
      noiseScale: base.noiseScale,
    },
    bandWarning,
  };
}

/**
 * 检测「生成参数里的高度上下限是同一个数」这种不成立的基准。
 *
 * 上游确实犯过这个错：`buildGenerationParams()` 曾经给 `minHeight = maxHeight = 1`，
 * 而 `generateHeightmap()` 对每列做 `clamp(h, minHeight, maxHeight)`，于是全世界被压成 y=1 的平地、
 * 地表全淹在水里（已修）。这道检查保留着，因为它的失效方式**是静默的**：
 * 预览画出来只是一块平地，没有任何报错。命中时改用世界档位的参数来画，
 * 并把不一致写进 limitations —— 宁可说清「这次预览可能不准」，也不要安静地画一张错的图。
 */
function detectDegenerateTerrainBand(band: { minHeight: number; maxHeight: number }): string | null {
  if (band.minHeight < band.maxHeight) return null;
  return (
    '注意：当前传给流水线的地形上下限是同一个数，按它生成的世界会是一片平地；' +
    '预览是按「世界档位基准 × 模板倍率」画的，因此此刻预览与实际生成可能不一致，以实际生成为准'
  );
}

export function buildPreview(request: PreviewRequest): PreviewData {
  const template = getMapTemplate(request.templateId);
  if (!template) {
    // 找不到模板时**抛错**而不是返回一张空图：空图会被当成「这张地图就是空的」，
    // 那种「看起来能用其实是假数据」的结果比一个明确的异常糟糕得多。
    throw new Error(`找不到地图模板：${request.templateId}（预览不编造数据，直接报错）`);
  }

  const resolution = clampResolution(request.resolution);
  const seedInput = Number.isFinite(request.seed) ? Math.floor(request.seed) : template.params.seed;
  const overrides = sanitizeOverrides(request.overrides);

  // 复用「模板 + 覆盖 + 种子 → 生成参数」的唯一换算：它同时负责把越界值夹回范围，
  // 所以预览用到的密度倍率与真实生成**必然**是同一套数。
  const gen = buildGenerationParams(template.id, overrides, seedInput);
  if (!gen) throw new Error(`找不到地图模板：${request.templateId}（预览不编造数据，直接报错）`);

  const preset = getWorldSize(gen.size);
  const strideX = preset.sizeX / resolution;
  const strideZ = preset.sizeZ / resolution;

  // ---- 1~4：地形（高度图 + 分层 + 灌水 + 地表材质），与流水线共用同一趟实现
  const grid = new VoxelGrid(preset.sizeX, preset.sizeY, preset.sizeZ);
  const terrainPreview = terrainForPreview(gen);
  const terrain = terrainPreview.terrain;
  const fullHeights = generateHeightmap(grid, terrain);
  const writer = new GridWriter(grid);
  fillFromHeightmap(grid, writer, fullHeights, terrain);
  writer.finish();

  // ---- 采样：每格取一个代表体素（最近邻，不插值）
  const samples = resolution * resolution;
  const rawHeights = new Int16Array(samples);
  const surfaceIds = new Uint8Array(samples);
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;

  for (let zi = 0; zi < resolution; zi += 1) {
    const vzSample = Math.min(preset.sizeZ - 1, Math.floor((zi + 0.5) * strideZ));
    for (let xi = 0; xi < resolution; xi += 1) {
      const vxSample = Math.min(preset.sizeX - 1, Math.floor((xi + 0.5) * strideX));
      const index = zi * resolution + xi;
      const h = fullHeights[vzSample * preset.sizeX + vxSample]!;
      rawHeights[index] = h;
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
      // 地表体素从**真实网格**里读：草/沙/雪/水的分配规则在 fillFromHeightmap 里，
      // 这里再写一遍就成了第二份真相，两边一定会漂移
      const top = grid.surfaceHeight(vxSample, vzSample);
      surfaceIds[index] = top >= 0 ? grid.getVoxel(vxSample, top, vzSample) : AIR;
    }
  }
  if (!Number.isFinite(minHeight) || !Number.isFinite(maxHeight)) {
    minHeight = 0;
    maxHeight = 0;
  }

  // ---- 归一化。全平（min === max）时全部记 0 而不是除以 0 得到 NaN：
  //      NaN 会一路传染到画布上，变成一块什么都不显示的空白
  const span = maxHeight - minHeight;
  const heights = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    heights[i] = span > 0 ? (rawHeights[i]! - minHeight) / span : 0;
  }
  const waterLevel =
    terrain.waterLevel <= minHeight
      ? null
      : span > 0
        ? // ⚠ 必须用 Math.fround 把水位也压成 float32：`heights` 是 Float32Array，
          // 水位如果留成 double，水线那一圈（地表高度正好等于水位的格子）会因为最后一位的
          // 误差被判成「在水里」，画出来就是水线附近一圈假的蓝边。
          // 这是断言「水位以下的采样格读到的确实是水」实测出来的（当时的数字：26563 个水下格里
          // 有 870 个对不上）—— 没有那条断言，这个 bug 只会表现为画布上一圈很难注意到的毛边。
          Math.fround(Math.max(0, Math.min(1, (terrain.waterLevel - minHeight) / span)))
        : 1;

  // ---- 阶段 6：只跑规划（不跑阶段 7~9 的建筑/物品/冲突修复）
  const planned = planPlots(grid, terrain.waterLevel, gen.buildingDensity, gen.seed, strideX, strideZ, resolution);
  // ---- 阶段 5 + 6.5：自然物位置（用来打点）
  const natureMarks = collectNatureMarks(template, grid, planned.plotRects, gen.treeDensity, gen.seed, strideX, strideZ, resolution);

  return {
    templateId: template.id,
    seed: gen.seed,
    resolution,
    heights,
    minHeight,
    maxHeight,
    waterLevel,
    surfaceIds,
    plots: planned.previewRects,
    natureMarks,
    limitations: buildLimitations(
      template,
      preset.sizeX,
      preset.sizeZ,
      resolution,
      strideX,
      gen,
      planned.previewRects.length,
      terrainPreview.bandWarning,
    ),
  };
}

/**
 * 建筑地块：直接调流水线的阶段 6（`BuildingPlanner.plan()`）。
 *
 * 为什么只跑规划而不跑整条流水线：规划是**纯几何**的（读网格高度、不写世界），
 * 而阶段 7~9 会真的造房子、摆物品、跑冲突检测 —— 那些对「预览上圈出几块地」毫无帮助，
 * 只是白花时间。种子偏移与 `GenerationPipeline` 的阶段 6 一致，所以圈出来的地就是
 * 实际生成时会圈的那些（同种子）。
 */
function planPlots(
  grid: VoxelGrid,
  waterLevel: number,
  buildingDensity: number,
  seed: number,
  strideX: number,
  strideZ: number,
  resolution: number,
): { plotRects: PlotRect[]; previewRects: PreviewData['plots'] } {
  const placement = buildPlacementWorld();
  const rng = mulberry32(seed ^ PLANNING_SEED_XOR);
  const report = new BuildingPlanner().plan(grid, rng, placement.isWater, waterLevel, {
    // 与流水线同一条：地块数 = round(6 × 建筑密度倍率)
    targetCount: Math.max(0, Math.round(6 * buildingDensity)),
  });
  const previewRects = report.plots.map((plot) => {
    const x0 = worldToPreview(grid.worldToVoxelX(plot.centerX - plot.width / 2), strideX, resolution);
    const x1 = worldToPreview(grid.worldToVoxelX(plot.centerX + plot.width / 2), strideX, resolution);
    const z0 = worldToPreview(grid.worldToVoxelZ(plot.centerZ - plot.depth / 2), strideZ, resolution);
    const z1 = worldToPreview(grid.worldToVoxelZ(plot.centerZ + plot.depth / 2), strideZ, resolution);
    return { x0, z0, x1, z1 };
  });
  return { plotRects: report.plots, previewRects };
}

/**
 * 自然物打点位置。
 *
 * 走的是与流水线一样的顺序：阶段 5 先撒（那时还没有地块，所以 `inBuildingPlot` 恒为 false），
 * 再按阶段 6.5 的规则把落在已圈地块里的清掉 —— 顺序反过来的话，间距判定会与真实生成不同，
 * 打出来的点就是另一个世界的点了。
 */
function collectNatureMarks(
  template: MapTemplate,
  grid: VoxelGrid,
  plotRects: readonly PlotRect[],
  treeDensity: number,
  seed: number,
  strideX: number,
  strideZ: number,
  resolution: number,
): PreviewData['natureMarks'] {
  const placement = buildPlacementWorld();
  const specs = buildNatureSpecs(template, loadEnabledPacks());
  if (specs.length === 0) return [];
  const result = new ObjectPlacer().place(
    grid,
    specs,
    {
      // 阶段 5 跑的时候地块还没圈出来（阶段 6 才圈），流水线就是这么传的
      inBuildingPlot: () => false,
      isAllowedSurface: placement.isAllowedSurface,
      isWater: placement.isWater,
    },
    mulberry32(seed ^ NATURE_SEED_XOR),
    { density: treeDensity },
  );

  const marks: PreviewData['natureMarks'] = [];
  for (const object of result.objects as readonly StagedObject[]) {
    if (isInsideAnyPlot(object.position, plotRects)) continue;
    marks.push({
      x: worldToPreview(grid.worldToVoxelX(object.position[0]), strideX, resolution),
      z: worldToPreview(grid.worldToVoxelZ(object.position[2]), strideZ, resolution),
      kind: natureKindOf(object),
    });
  }
  return marks;
}

/**
 * 与 `GenerationPipeline.removeNatureInsidePlots()` 同样的判据：地块矩形（含 margin 外扩）
 * 覆盖到就算落在建筑区，会被阶段 6.5 清掉。
 */
function isInsideAnyPlot(
  position: readonly [number, number, number],
  plotRects: readonly PlotRect[],
): boolean {
  for (const plot of plotRects) {
    const dx = Math.abs(position[0] - plot.centerX);
    const dz = Math.abs(position[2] - plot.centerZ);
    if (dx < plot.width / 2 + PLOT_NATURE_MARGIN && dz < plot.depth / 2 + PLOT_NATURE_MARGIN) {
      return true;
    }
  }
  return false;
}

/**
 * 自然物的中文类别名。
 *
 * `StagedObject` 上只有 `kind: 'nature'`，类别名（阔叶树/灌木/巨石……）只出现在
 * `ObjectPlacer` 拼的 id 前缀里（`<类别>:<序号>`），所以这里从 id 里取。
 * 这是当前唯一能拿到类别的地方；若以后 StagedObject 加了类别字段，这里应当改成读字段。
 */
function natureKindOf(object: StagedObject): string {
  const prefix = object.id.split(':')[0];
  return prefix && prefix.length > 0 ? prefix : '自然物';
}

/** 预览做不到的事 —— 每条都必须是真的，写给玩家看 */
function buildLimitations(
  template: MapTemplate,
  sizeX: number,
  sizeZ: number,
  resolution: number,
  strideX: number,
  gen: { size: string; treeDensity: number; buildingDensity: number },
  plotCount: number,
  bandWarning: string | null,
): string[] {
  const strideText = Math.abs(strideX - 1) < 0.01 ? '1（不缩放）' : strideX.toFixed(2);
  const limitations: string[] = [
    `这是近似预览：把 ${sizeX}×${sizeZ} 的世界重采样成 ${resolution}×${resolution}，` +
      `采样步长 ${strideText} 体素（大于 1 是抽点、小于 1 是放大），` +
      `所以「小物品与门洞的冲突」在预览上看不出来`,
    '预览用高度场代表地表：洞穴、悬垂、玩家挖出来的结构在预览上不存在，这类地形的预览是错的',
    '预览不跑物理：物体摆放是否稳定、会不会倒、能不能浮起来，都要等生成之后才知道',
    `预览只跑了地形与建筑规划（阶段 1~4、6），没有跑建筑（阶段 7）、小物品（阶段 8）与冲突修复（阶段 9）：` +
      `所以地块上最终有没有房子、房子位置会不会被修复挪动，预览里看不出来`,
    `预览上的树/灌木/巨石点是阶段 5 撒出来的位置，冲突修复（阶段 9）可能再删掉一些；` +
      `树密度 ×${gen.treeDensity.toFixed(2)}、建筑密度 ×${gen.buildingDensity.toFixed(2)}、世界档 ${gen.size}`,
  ];
  if (plotCount === 0) {
    limitations.push(
      `「${template.name}」这次预览没有圈出任何建筑地块：可能是地形太陡/离水太近，也可能是建筑密度倍率为 0 —— ` +
        '预览不会为了好看而编造地块',
    );
  }
  if (bandWarning) limitations.push(bandWarning);
  return limitations;
}

// ------------------------------------------------------------------ 绘制

export interface PreviewRenderOptions {
  showPlots?: boolean;
  showNature?: boolean;
  showWater?: boolean;
}

/** 取分层设色的色带：优先用模板自己的调色板（缩略图与卡片风格一致），模板缺失时用兜底色 */
function bandColorsOf(templateId: string): string[] {
  const palette = getMapTemplate(templateId)?.palette;
  const source = palette && palette.length >= 2 ? palette : FALLBACK_BANDS;
  return source.map((color) => colorToHexString(color));
}

/**
 * 把预览画到画布上（俯视，正投影）。
 *
 * 画四层：分层设色的高度场 → 水 → 地块边框 → 自然物打点，最后在**右下角**写上「近似预览」。
 * 那行字不是装饰：这张图看起来很像真的地图，不写清楚就会被当成生成结果 ——
 * 而它既不含洞穴也不含建筑，是会骗人的。
 *
 * Node 下没有 canvas：`getContext()` 返回 null（或者画布对象本身没有 `getContext`）时**静默返回**，
 * 不抛异常 —— 逻辑测试不该因为「没有浏览器」而失败。
 */
export function renderPreviewCanvas(
  canvas: HTMLCanvasElement,
  data: PreviewData,
  opts: PreviewRenderOptions = {},
): void {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { showPlots = true, showNature = true, showWater = true } = opts;
  const res = Math.max(1, data.resolution);

  // devicePixelRatio 缩放：不缩放的话高分屏上画布是模糊的，而这张图正是要看细节的
  const dpr =
    typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio)
      ? Math.max(1, Math.min(2, devicePixelRatio))
      : 1;
  // 兜底尺寸**不能**用 canvas.width：下面会把 width 乘上 dpr，用 width 兜底的话
  // 每次重画都会再放大一倍（隐藏的 canvas 会越画越大）
  const cssSize = canvas.clientWidth > 0 ? canvas.clientWidth : 160;
  canvas.width = Math.round(cssSize * dpr);
  canvas.height = Math.round(cssSize * dpr);
  if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);

  const cell = cssSize / res;
  const bands = bandColorsOf(data.templateId);
  const bandCount = bands.length;

  // ---- 1. 分层设色的高度场
  for (let zi = 0; zi < res; zi += 1) {
    for (let xi = 0; xi < res; xi += 1) {
      const index = zi * res + xi;
      const normalized = data.heights[index]!;
      const bandIndex = Math.max(0, Math.min(bandCount - 1, Math.floor(normalized * bandCount)));
      ctx.fillStyle = bands[bandIndex]!;
      // 用 floor 而不是 round 算像素边界：相邻格子必须无缝，round 会在接缝上留出 1px 的裂缝
      const px = Math.floor(xi * cell);
      const pz = Math.floor(zi * cell);
      ctx.fillRect(px, pz, Math.ceil(cell) + 1, Math.ceil(cell) + 1);
    }
  }

  // ---- 2. 水：水位以下的格子压一层半透明蓝（与「地表体素是水」互相印证）
  if (showWater && data.waterLevel !== null) {
    for (let zi = 0; zi < res; zi += 1) {
      for (let xi = 0; xi < res; xi += 1) {
        const index = zi * res + xi;
        const underwater =
          data.heights[index]! < data.waterLevel || data.surfaceIds[index] === WATER_VOXEL;
        if (!underwater) continue;
        ctx.fillStyle = WATER_OVERLAY;
        ctx.fillRect(
          Math.floor(xi * cell),
          Math.floor(zi * cell),
          Math.ceil(cell) + 1,
          Math.ceil(cell) + 1,
        );
      }
    }
  }

  // ---- 3. 地块边框（虚线；每块地画一个矩形）
  if (showPlots && data.plots.length > 0) {
    ctx.strokeStyle = PLOT_STROKE;
    ctx.lineWidth = 1;
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([4, 3]);
    for (const plot of data.plots) {
      ctx.strokeRect(plot.x0 * cell, plot.z0 * cell, (plot.x1 - plot.x0) * cell, (plot.z1 - plot.z0) * cell);
    }
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
  }

  // ---- 4. 自然物打点（树深绿、灌木浅绿、巨石灰）
  if (showNature && data.natureMarks.length > 0) {
    const dot = Math.max(1.5, cell * 0.9);
    for (const mark of data.natureMarks) {
      ctx.fillStyle = natureMarkColor(mark.kind);
      ctx.fillRect(mark.x * cell - dot / 2, mark.z * cell - dot / 2, dot, dot);
    }
  }

  // ---- 5. 右下角的「近似预览」标注（必需，防止这张图被当成生成结果）
  drawApproxLabel(ctx, cssSize);
}

/** 类别 → 打点颜色。类别名是中文（来自 GenerationContent 的 NATURE_KINDS），所以按名字分类 */
function natureMarkColor(kind: string): string {
  if (kind.includes('灌木')) return '#a6e06a';
  if (kind.includes('巨石') || kind.includes('石')) return '#cfc7b8';
  if (kind.includes('枯')) return '#9a7b52';
  return '#1f4d24';
}

function drawApproxLabel(ctx: CanvasRenderingContext2D, cssSize: number): void {
  const title = '近似预览';
  const sub = '降采样 · 非真实体素';
  const boxWidth = Math.min(cssSize, 118);
  const boxHeight = 30;
  const x = cssSize - boxWidth - 4;
  const y = cssSize - boxHeight - 4;
  ctx.fillStyle = 'rgba(12, 16, 20, 0.72)';
  ctx.fillRect(x, y, boxWidth, boxHeight);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText(title, x + 6, y + 4);
  ctx.font = '9px sans-serif';
  ctx.fillStyle = '#d8dee6';
  ctx.fillText(sub, x + 6, y + 17);
}

/** 面板/日志用：一行中文摘要（数字全部来自这一份数据，没有一个是编的） */
export function describePreview(data: PreviewData): string {
  const waterText =
    data.waterLevel === null
      ? '无水（水位不高于最低地表）'
      : `水位 ${(data.waterLevel * 100).toFixed(0)}%（约 y=${(
          data.minHeight + data.waterLevel * (data.maxHeight - data.minHeight)
        ).toFixed(1)}）`;
  const template = getMapTemplate(data.templateId);
  const name = template ? `${template.emoji} ${template.name}` : data.templateId;
  const kinds = new Map<string, number>();
  for (const mark of data.natureMarks) kinds.set(mark.kind, (kinds.get(mark.kind) ?? 0) + 1);
  const kindText =
    kinds.size === 0
      ? '无自然物点'
      : [...kinds.entries()].map(([kind, count]) => `${kind} ${count}`).join('，');
  return (
    `预览（近似）：${name}｜种子 ${data.seed}｜采样 ${data.resolution}×${data.resolution}｜` +
    `地表 y ${data.minHeight} ~ ${data.maxHeight}（极差 ${data.maxHeight - data.minHeight} 米）｜` +
    `${waterText}｜建筑地块 ${data.plots.length} 块｜自然物点：${kindText}｜` +
    `做不到的事 ${data.limitations.length} 条（见面板）`
  );
}
