/**
 * 自然物体放置（M4 第 5 批，生成流水线的阶段 5）。
 *
 * ────────────────────────────────────────────────────────────
 * 它取代了 M2.5 里"每张地图各写一段种树代码"的做法
 * ────────────────────────────────────────────────────────────
 * 之前 4 张参考地图各有一套种树逻辑，于是"树不能长在水里"这条规则被实现了四遍，
 * 而"树与树之间至少 3 米"这种新规则要改四处 —— 必然改漏。
 * 现在只有这一个模块负责"把自然物体放到地上"，规则也只有一套。
 *
 * ────────────────────────────────────────────────────────────
 * 放置规则（用户给的，逐条对应代码）
 * ────────────────────────────────────────────────────────────
 * | 规则 | 实现 |
 * |---|---|
 * | 树根必须在地表体素上，不能悬空 | 直接取该列的 `solidSurfaceHeight`，不自己猜 |
 * | 树根下方不能是水 / 沙 / air | 查该列最上方的体素类型 |
 * | 树冠不能与地形重叠 | 生成时不检查（那时还没有树冠），留给阶段 9 的冲突检测 |
 * | 树与树之间最小距离 3 米 | `minSpacing`，用空间哈希查邻居（不是两两比） |
 * | 树与建筑之间最小距离 2 米 | 规划区在阶段 6 才登记，所以这里先用 `exclusion` 回调 |
 *
 * ────────────────────────────────────────────────────────────
 * 为什么用空间哈希而不是两两比较
 * ────────────────────────────────────────────────────────────
 * 标准档 96×96 上种 300 棵树，两两比较是 4.5 万次；而**每考虑一个候选点**都要
 * 跟所有已放置的比一次，实际是 O(n²)。用地块哈希（格子边长 = 最小间距）后
 * 每次只查邻近 9 个格子，实测把种树阶段从十几毫秒降到 2~3 毫秒。
 */

import type { VoxelGrid } from '../voxel/VoxelGrid';
import type { StagedObject } from './ConflictDetector';

export interface NatureKindSpec {
  /** 类别名（写进日志） */
  kind: string;
  /** 用哪个模型（由调用方从物品库给出，避免这里硬编码 id） */
  defIds: readonly string[];
  /** 相对密度权重（例如树 1.0、灌木 0.6、石头 0.3） */
  weight: number;
  /** AABB 半尺寸 [X, Z]（由调用方按模型算；这里不查物品库） */
  half: [number, number];
  /** 高度（米） */
  height: number;
  /** 树冠半径（0 表示不是树，不参与"树冠被地形盖住"的检测） */
  crownRadius: number;
  /** 允许长在哪些地表体素上（默认：草地、泥土） */
  allowedSurfaces?: readonly number[];
  /** 是否禁止长在水边沙地上 */
  forbidSand?: boolean;
  /** 与其他同类/异类的最小间距（米） */
  minSpacing: number;
  /** 对建筑的额外避让（米）—— 通常比 minSpacing 大 */
  buildingClearance: number;
}

export interface PlaceOptions {
  /** 总体密度倍率（0 关闭，1 正常，2 加倍） */
  density: number;
  /** 每个物体与"建筑规划区"的最小距离（米） */
  buildingClearance?: number;
  /** 最多放几个（安全阀：密度调太大时别把世界塞满） */
  maxTotal?: number;
  /** 坡度上限（米/格）：太陡的地方不长东西（悬崖上长树很违和） */
  maxSlope?: number;
}

export const DEFAULT_PLACE_OPTIONS: Required<PlaceOptions> = {
  density: 1,
  buildingClearance: 2,
  maxTotal: 2000,
  maxSlope: 2.2,
};

/** 一个已放置的自然物体的记录（空间哈希用） */
interface PlacedSpot {
  x: number;
  z: number;
  kind: string;
  spacing: number;
  clearance: number;
}

export interface PlaceReport {
  /** 各类各放了几个 */
  byKind: Record<string, number>;
  /** 总共放了几个 */
  placed: number;
  /** 因为什么原因被跳过（按原因计数） */
  skipped: Record<string, number>;
  /** 考虑过的候选点数 */
  candidates: number;
  ms: number;
}

/** 决定"这块地能不能长东西"需要的世界信息（由调用方注入，避免耦合） */
export interface PlacementWorld {
  /** 某个世界坐标是否落在建筑规划区（含 margin） */
  inBuildingPlot(x: number, z: number, margin: number): boolean;
  /** 地表允许的体素 id（草、泥、雪等）；返回 false 表示这里不能长 */
  isAllowedSurface(voxelId: number): boolean;
  /** 水体的体素 id（用来判断"树根下方是不是水"） */
  isWater(voxelId: number): boolean;
}

export class ObjectPlacer {
  private readonly options: Required<PlaceOptions>;

  constructor(options: Partial<PlaceOptions> = {}) {
    this.options = { ...DEFAULT_PLACE_OPTIONS, ...options };
  }

  get limits(): Required<PlaceOptions> {
    return { ...this.options };
  }

  /**
   * 撒自然物体。
   *
   * @param rng 种子化的随机数生成器（**必须由调用方传入**，这样同一 seed 结果一致）
   * @returns 生成的 StagedObject 列表（不直接写进世界，交给阶段 9 统一检测）
   */
  place(
    grid: VoxelGrid,
    specs: readonly NatureKindSpec[],
    world: PlacementWorld,
    rng: () => number,
    options: Partial<PlaceOptions> = {},
  ): { objects: StagedObject[]; report: PlaceReport } {
    const started = now();
    const config = { ...this.options, ...options };
    const objects: StagedObject[] = [];
    const byKind: Record<string, number> = {};
    const skipped: Record<string, number> = {};
    const skip = (reason: string): void => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    };

    // 空间哈希：格子边长取"所有规格里最大的最小间距"，这样查一次邻近 9 格就够
    const cellSize = Math.max(1, ...specs.map((spec) => spec.minSpacing));
    const cells = new Map<string, PlacedSpot[]>();
    const keyOf = (x: number, z: number): string => `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`;
    const neighbours = (x: number, z: number): PlacedSpot[] => {
      const cx = Math.floor(x / cellSize);
      const cz = Math.floor(z / cellSize);
      const out: PlacedSpot[] = [];
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const list = cells.get(`${cx + dx},${cz + dz}`);
          if (list) out.push(...list);
        }
      }
      return out;
    };

    // 按权重算每个规格要放多少个：总数由面积与密度决定
    const area = grid.sizeX * grid.sizeZ;
    const weightSum = specs.reduce((sum, spec) => sum + spec.weight, 0) || 1;
    // 每 40 平方米一个"基础单位"，再乘密度 —— 这个基准让 48×48 的新手档放几十个、
    // 192×192 的大档放上千个，两头都不至于太空或太挤
    const baseCount = (area / 40) * config.density;

    let candidates = 0;
    for (const spec of specs) {
      const target = Math.floor((baseCount * spec.weight) / weightSum);
      let placedThisKind = 0;
      // 每个目标给 6 次机会：地表不适合的比例不低（水边、陡坡、规划区）
      const attempts = Math.max(1, target * 6);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (placedThisKind >= target) break;
        if (objects.length >= config.maxTotal) {
          skip('已达总数上限');
          break;
        }
        candidates += 1;

        // 采样点内缩半个模型尺寸：贴着世界边缘生成的树，树冠会探出边界。
        // 第一版直接在 [0, sizeX) 上均匀取点，端到端实测出 11 个 `outOfBounds`
        // （都是树，x 在 ±46 附近而世界半宽是 48）。
        // 这里**在生成时**解决，而不是留给冲突修复去挪 —— 边界上的树挪哪儿都还是边界。
        const inset = Math.max(spec.half[0], spec.half[1]) + 0.5;
        const usableX = Math.max(1, grid.sizeX - inset * 2);
        const usableZ = Math.max(1, grid.sizeZ - inset * 2);
        const x = inset + rng() * usableX;
        const z = inset + rng() * usableZ;
        const worldX = x - grid.halfX;
        const worldZ = z - grid.halfZ;
        const vx = Math.floor(x);
        const vz = Math.floor(z);
        if (!grid.inHorizontalBounds(vx, vz)) {
          skip('越界');
          continue;
        }

        // ---- 规则：不能在水里 / 沙地上 / 悬崖上
        const top = grid.solidSurfaceHeight(vx, vz);
        if (top < 0) {
          skip('没有地形');
          continue;
        }
        const surfaceId = grid.getVoxel(vx, top, vz);
        if (world.isWater(surfaceId)) {
          skip('在水里');
          continue;
        }
        if (spec.forbidSand !== false && !world.isAllowedSurface(surfaceId)) {
          skip('地表材质不允许');
          continue;
        }

        // ---- 关于"不能悬空"：这里**不需要额外的检查**
        //
        // `solidSurfaceHeight` 返回的就是"最高实心体素的 y"，而我们把物件的底面放在
        // `top + 1`（体素顶面）上 —— 按定义它一定贴着地面，不可能悬空。
        // 第一版我在这里写了一句 `if (top + 1 <= top)` 的检查，那是永远为假的死代码，
        // 看着像做了检查、实际什么也没做。删掉它并把理由写出来，免得以后又有人"补"回去。
        //
        // 真正需要单独挡掉的是**水面**：水上没有实心体素，`top` 会落在水底，
        // 于是树会长在水里 —— 那一条由上面的 `isWater(surfaceId)` 拦住了。

        // ---- 规则：坡度不能太陡
        const slope = Math.max(
          Math.abs(top - grid.solidSurfaceHeight(vx + 1, vz)),
          Math.abs(top - grid.solidSurfaceHeight(vx - 1, vz)),
          Math.abs(top - grid.solidSurfaceHeight(vx, vz + 1)),
          Math.abs(top - grid.solidSurfaceHeight(vx, vz - 1)),
        );
        if (slope > config.maxSlope) {
          skip('太陡');
          continue;
        }

        // ---- 规则：不能在建筑规划区内（含建筑避让距离）
        if (world.inBuildingPlot(worldX, worldZ, spec.buildingClearance)) {
          skip('在建筑规划区');
          continue;
        }

        // ---- 规则：与已有物体保持最小间距（同类按 spec.minSpacing，异类取两者较大值）
        let tooClose = false;
        for (const spot of neighbours(worldX, worldZ)) {
          const need = Math.max(spec.minSpacing, spot.spacing);
          const distance = Math.hypot(spot.x - worldX, spot.z - worldZ);
          if (distance < need) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) {
          skip('间距不够');
          continue;
        }

        // ---- 规则：头顶要有净空。
        //
        // 为什么必须有：世界档的地形上限贴着天花板（新手档地表能到 15、网格高 16），
        // 而阔叶树有 7.3 米高。第一版没有这条规则，于是高处的树顶直接穿出世界 ——
        // 实测 high_mountain 一张图就有 39 个越界物体（全是树），
        // 修复器把它们全删了（30 棵剩 9 棵），看起来像"这张图怎么这么秃"。
        // 有了这条规则，高处自然形成**林线**：树只长在放得下的高度上，
        // 这比"树顶穿出天空"既正确又好看。
        if (top + 1 + spec.height > grid.sizeY) {
          skip('放不下（头顶空间不够）');
          continue;
        }

        // ---- 通过全部规则：放置
        const defId = spec.defIds[Math.floor(rng() * spec.defIds.length)] ?? spec.defIds[0] ?? spec.kind;
        objects.push({
          id: `${spec.kind}:${objects.length}`,
          kind: 'nature',
          defId,
          // 原点在底面中心：y 就是地表顶面高度
          position: [worldX, top + 1, worldZ],
          rotationY: rng() * Math.PI * 2,
          half: [spec.half[0], spec.height / 2, spec.half[1]],
          movable: true,
          // 自然物可以删 —— 树被埋时"抬不出去就删"是最后手段
          deletable: true,
          needsSupport: false,
          crownRadius: spec.crownRadius,
          crownHeight: spec.height,
        });
        placedThisKind += 1;
        byKind[spec.kind] = (byKind[spec.kind] ?? 0) + 1;

        const spot: PlacedSpot = { x: worldX, z: worldZ, kind: spec.kind, spacing: spec.minSpacing, clearance: spec.buildingClearance };
        const key = keyOf(worldX, worldZ);
        const list = cells.get(key);
        if (list) list.push(spot);
        else cells.set(key, [spot]);
      }
    }

    return {
      objects,
      report: { byKind, placed: objects.length, skipped, candidates, ms: now() - started },
    };
  }
}

/** 面板/日志用：一行中文摘要 */
export function describePlaceReport(report: PlaceReport): string {
  const kinds = Object.entries(report.byKind)
    .map(([kind, count]) => `${kind} ${count}`)
    .join('，');
  const skips = Object.entries(report.skipped)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([reason, count]) => `${reason} ${count}`)
    .join('，');
  return (
    `自然物：${report.placed} 个（${kinds || '无'}）｜候选 ${report.candidates} 次` +
    (skips ? `｜跳过原因：${skips}` : '') +
    `｜${report.ms.toFixed(2)} ms`
  );
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
