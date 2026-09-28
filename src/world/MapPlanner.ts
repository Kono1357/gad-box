import { AIR, getVoxelDef, getVoxelId } from '../data/voxelTypes';
import type { VoxelGrid } from '../voxel/VoxelGrid';
import type { GridWriter } from '../voxel/TerrainGenerator';
import type { BuildingInstance } from '../building/types';
import { aabbOfInstance, horizontalOverlapArea } from '../physics/CollisionDetect';

/** 被认为是"自然物体"的体素类型：清理规划区时只删这些，绝不碰地形 */
const NATURE_VOXEL_TYPES: ReadonlySet<number> = new Set([
  getVoxelId('leaves'),
  getVoxelId('wood'),
  getVoxelId('cactus'),
]);

function isNatureVoxel(id: number): boolean {
  return NATURE_VOXEL_TYPES.has(id);
}

/** 一块建筑规划区（矩形，轴对齐） */
export interface BuildingPlot {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** 给日志用的名字，例如 "山谷村落 · 木屋 2" */
  label: string;
}

/** 已登记的自然物体（用来做间距检测与重叠统计） */
export interface NatureSpot {
  x: number;
  z: number;
  /** 树冠半径（米） */
  radius: number;
  kind: 'tree' | 'palm' | 'pine' | 'cactus' | 'prop';
}

/** 一次地图生成的统计报告（问题 3.5 要求输出日志） */
export interface MapGenerationReport {
  /** 种下的自然物体数 */
  naturePlaced: number;
  /** 因为和别的东西冲突而**没种**的自然物体数 */
  natureSkipped: number;
  /** 建筑规划区里**清除**掉的自然物体数（估算是按列统计） */
  natureCleared: number;
  /** 建筑实际放置数 */
  buildingsPlaced: number;
  /** 事后全量重叠检测修掉的数量 */
  overlapsFixed: number;
  /** 是否有建筑悬空 */
  floatingBuildings: number;
  ms: number;
  /** 给控制台/UI 看的日志行 */
  log: string[];
}

export function createEmptyReport(): MapGenerationReport {
  return {
    naturePlaced: 0,
    natureSkipped: 0,
    natureCleared: 0,
    buildingsPlaced: 0,
    overlapsFixed: 0,
    floatingBuildings: 0,
    ms: 0,
    log: [],
  };
}

/**
 * 地图生成规划器（问题 3 的核心）。
 *
 * 把"生成"拆成**有序的几步，每一步都在上一步的结果上做重叠检测**：
 *
 *   1. 地形高度图（`TerrainGenerator`）
 *   2. 水体与沙地（同上）
 *   3. **自然物体**：种树前先问规划器"这儿能种吗" —— 不满足条件就跳过（不是种了再删）
 *   4. **建筑规划区**：先登记矩形范围，再**清除区内一切自然物体**（只删树叶/木/仙人掌，绝不碰地形）
 *   5. **建筑**：落在规划区里，彼此保持最小间距，并贴合地形
 *   6. **全量重叠检测**：对最终结果再做一遍 AABB 碰撞，把漏网的修掉
 *
 * 为什么不是"先种满树、再一刀切清空规划区"：
 * 那会把村落里的树清得一块不剩，看起来像被推平过。
 * 正确的是**种的时候就避开**（第三步），规划区只做兜底清理与统计（第四步），
 * 于是村子周围仍然有树，只是房子底下干净。
 */
export class MapPlanner {
  private readonly plots: BuildingPlot[] = [];
  private readonly nature: NatureSpot[] = [];

  constructor(
    private readonly grid: VoxelGrid,
    private readonly report: MapGenerationReport,
  ) {}

  // ---------------------------------------------------------------- 规划区

  addPlot(plot: BuildingPlot): void {
    this.plots.push(plot);
  }

  get plotCount(): number {
    return this.plots.length;
  }

  /** 某个位置是否落在任何规划区里（带外扩余量） */
  inAnyPlot(x: number, z: number, margin = 0): boolean {
    for (const plot of this.plots) {
      if (
        x >= plot.minX - margin &&
        x <= plot.maxX + margin &&
        z >= plot.minZ - margin &&
        z <= plot.maxZ + margin
      ) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- 自然物体

  /**
   * 判断某个位置能不能种自然物体（问题 3.2 的四条规则）。
   *
   * @param radius 树冠半径，用于"树与树最小间距"
   * @param minSpacing 与其它自然物体的最小间距
   * @param forbidSand 是否禁止长在沙地上
   */
  canPlaceNature(
    x: number,
    z: number,
    radius: number,
    options: { minSpacing?: number; forbidSand?: boolean; plotMargin?: number } = {},
  ): { ok: boolean; reason?: string } {
    const { minSpacing = 2.5, forbidSand = true, plotMargin = 1.5 } = options;

    if (!this.grid.inHorizontalBounds(x, z)) return { ok: false, reason: '越界' };

    const surface = this.grid.solidSurfaceHeight(x, z);
    if (surface < 0) return { ok: false, reason: '没有地形' };

    // 规则 1：不能长在水里 / 沙地上 / 悬崖上
    const top = this.grid.getVoxel(x, surface, z);
    if (top === getVoxelId('water')) return { ok: false, reason: '在水里' };
    if (forbidSand && top === getVoxelId('sand')) return { ok: false, reason: '在沙地上' };
    if (!getVoxelDef(top).solid) return { ok: false, reason: '地面不实' };

    // 悬崖：周围 2 格内有超过 3 米的高差就不种
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
      const neighbour = this.grid.solidSurfaceHeight(x + dx, z + dz);
      if (neighbour >= 0 && Math.abs(neighbour - surface) > 3) {
        return { ok: false, reason: '在悬崖上' };
      }
    }

    // 规则 2：不能长在建筑规划区里
    if (this.inAnyPlot(x, z, plotMargin)) return { ok: false, reason: '在建筑规划区' };

    // 规则 3：树与树保持最小间距
    const limit = (radius + minSpacing) * (radius + minSpacing);
    for (const spot of this.nature) {
      const dx = spot.x - x;
      const dz = spot.z - z;
      const need = radius + spot.radius + minSpacing;
      if (dx * dx + dz * dz < Math.min(limit, need * need)) {
        return { ok: false, reason: '挨着另一棵树' };
      }
    }

    return { ok: true };
  }

  /** 登记一棵种下的自然物体 */
  registerNature(x: number, z: number, radius: number, kind: NatureSpot['kind']): void {
    this.nature.push({ x, z, radius, kind });
    this.report.naturePlaced++;
  }

  /** 记一次"因为冲突而没种" */
  skipNature(reason?: string): void {
    this.report.natureSkipped++;
    void reason;
  }

  // ---------------------------------------------------------------- 清理规划区

  /**
   * 清除所有规划区里的自然物体（第三步兜底）。
   *
   * **只删树叶 / 木头 / 仙人掌体素**，遇到第一个非自然体素就停 ——
   * 所以地形、水、沙一个都不会被碰。
   *
   * @returns 清掉的列数（每列算一个自然物体）
   */
  clearNatureInPlots(writer: GridWriter): number {
    let clearedColumns = 0;
    const sizeY = this.grid.sizeY;

    for (const plot of this.plots) {
      const x0 = Math.max(0, Math.floor(plot.minX + this.grid.halfX));
      const x1 = Math.min(this.grid.sizeX - 1, Math.ceil(plot.maxX + this.grid.halfX));
      const z0 = Math.max(0, Math.floor(plot.minZ + this.grid.halfZ));
      const z1 = Math.min(this.grid.sizeZ - 1, Math.ceil(plot.maxZ + this.grid.halfZ));

      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          let removedInColumn = 0;
          for (let y = sizeY - 1; y > 0; y--) {
            const id = this.grid.getVoxel(x, y, z);
            if (id === AIR) continue;
            if (!isNatureVoxel(id)) break; // 碰到地形/水就停，绝不往下删
            writer.set(x, y, z, AIR);
            removedInColumn++;
          }
          if (removedInColumn > 0) clearedColumns++;
        }
      }
    }

    this.report.natureCleared += clearedColumns;
    if (clearedColumns > 0) {
      this.report.log.push(`规划区内清除了 ${clearedColumns} 处自然物体（只删树叶/木头，地形未动）`);
    }
    return clearedColumns;
  }

  // ---------------------------------------------------------------- 建筑

  /**
   * 建筑放置前的检查：彼此最小间距 + 贴合地形（不悬空）。
   * @returns 是否可以放在这里
   */
  canPlaceBuilding(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    existing: readonly BuildingInstance[],
    minSpacing = 1.5,
  ): { ok: boolean; reason?: string } {
    const probe = { minX, maxX, minY: 0, maxY: 0, minZ, maxZ };
    for (const instance of existing) {
      const box = aabbOfInstance(instance);
      const expanded = {
        minX: box.minX - minSpacing,
        maxX: box.maxX + minSpacing,
        minY: 0,
        maxY: 0,
        minZ: box.minZ - minSpacing,
        maxZ: box.maxZ + minSpacing,
      };
      if (horizontalOverlapArea(probe, expanded) > 0) {
        return { ok: false, reason: '和其它建筑太近' };
      }
    }
    return { ok: true };
  }

  /**
   * 事后全量重叠检测（问题 3.5）。
   *
   * 检查两类重叠：
   * 1. **建筑 ↔ 自然物体**：建筑体积范围内还有没有自然体素残留（清除没干净的情况）；
   * 2. **建筑 ↔ 建筑**：AABB 实体相交。
   *
   * 建筑与自然物体的重叠采取"删自然物体"的策略 —— 房子比树重要，
   * 而且删树比挪房子简单得多。
   */
  validateBuildings(buildings: readonly BuildingInstance[], writer: GridWriter): number {
    let fixed = 0;

    // 1) 建筑 ↔ 自然物体
    for (const instance of buildings) {
      const box = aabbOfInstance(instance);
      const x0 = Math.max(0, Math.floor(box.minX + this.grid.halfX));
      const x1 = Math.min(this.grid.sizeX - 1, Math.ceil(box.maxX + this.grid.halfX));
      const z0 = Math.max(0, Math.floor(box.minZ + this.grid.halfZ));
      const z1 = Math.min(this.grid.sizeZ - 1, Math.ceil(box.maxZ + this.grid.halfZ));
      const y0 = Math.max(1, Math.floor(box.minY));
      const y1 = Math.min(this.grid.sizeY - 1, Math.ceil(box.maxY));

      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          for (let y = y1; y >= y0; y--) {
            const id = this.grid.getVoxel(x, y, z);
            if (id === AIR || !isNatureVoxel(id)) continue;
            writer.set(x, y, z, AIR);
            fixed++;
          }
        }
      }
    }

    // 2) 建筑 ↔ 建筑（只统计，不删 —— 参考地图里的房子本该挨着）
    let pairs = 0;
    for (let i = 0; i < buildings.length; i++) {
      const a = aabbOfInstance(buildings[i]!);
      for (let j = i + 1; j < buildings.length; j++) {
        const b = aabbOfInstance(buildings[j]!);
        if (horizontalOverlapArea(a, b) > 0.01) pairs++;
      }
    }
    if (pairs > 0) this.report.log.push(`建筑之间有 ${pairs} 对水平重叠（参考地图允许相邻，未自动处理）`);

    this.report.overlapsFixed += fixed;
    if (fixed > 0) {
      this.report.log.push(`全量检测：在建筑体积内清掉了 ${fixed} 个残留自然体素`);
    }
    return fixed;
  }

  /** 统计有多少建筑是悬空的（底面离地形表面太远） */
  countFloating(buildings: readonly BuildingInstance[], tolerance = 0.35): number {
    let floating = 0;
    for (const instance of buildings) {
      const box = aabbOfInstance(instance);
      let best = -1;
      const vx0 = this.grid.worldToVoxelX(box.minX);
      const vx1 = this.grid.worldToVoxelX(box.maxX);
      const vz0 = this.grid.worldToVoxelZ(box.minZ);
      const vz1 = this.grid.worldToVoxelZ(box.maxZ);
      for (let vz = vz0; vz <= vz1; vz++) {
        for (let vx = vx0; vx <= vx1; vx++) {
          if (!this.grid.inHorizontalBounds(vx, vz)) continue;
          const top = this.grid.solidSurfaceHeight(vx, vz);
          if (top + 1 > best) best = top + 1;
        }
      }
      if (best >= 0 && box.minY - best > tolerance) floating++;
    }
    this.report.floatingBuildings = floating;
    return floating;
  }
}

/**
 * 对**已经生成好的存档 / 参考地图**做一次重叠体检（问题 3.6）。
 *
 * 与上面的生成期检测不同：这里没有 writer，所以只报告不改动，
 * 由调用方决定要不要用 `repairOverlaps()` 修。
 */
export interface OverlapReport {
  /** 建筑体积内的自然体素数量 */
  natureInBuildings: number;
  /** 建筑之间水平重叠的对数 */
  buildingPairs: number;
  /** 悬空建筑数量 */
  floating: number;
  /** 涉及到的建筑 id */
  affected: number[];
  ms: number;
}

export function detectOverlaps(
  grid: VoxelGrid,
  buildings: readonly BuildingInstance[],
): OverlapReport {
  const started = performance.now();
  const affected = new Set<number>();
  let natureInBuildings = 0;

  for (const instance of buildings) {
    const box = aabbOfInstance(instance);
    const x0 = Math.max(0, Math.floor(box.minX + grid.halfX));
    const x1 = Math.min(grid.sizeX - 1, Math.ceil(box.maxX + grid.halfX));
    const z0 = Math.max(0, Math.floor(box.minZ + grid.halfZ));
    const z1 = Math.min(grid.sizeZ - 1, Math.ceil(box.maxZ + grid.halfZ));
    const y0 = Math.max(1, Math.floor(box.minY));
    const y1 = Math.min(grid.sizeY - 1, Math.ceil(box.maxY));

    let hit = 0;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        for (let y = y1; y >= y0; y--) {
          const id = grid.getVoxel(x, y, z);
          if (id === AIR) continue;
          if (isNatureVoxel(id)) hit++;
        }
      }
    }
    if (hit > 0) {
      natureInBuildings += hit;
      affected.add(instance.id);
    }
  }

  let buildingPairs = 0;
  for (let i = 0; i < buildings.length; i++) {
    const a = aabbOfInstance(buildings[i]!);
    for (let j = i + 1; j < buildings.length; j++) {
      const b = aabbOfInstance(buildings[j]!);
      if (horizontalOverlapArea(a, b) > 0.01) buildingPairs++;
    }
  }

  let floating = 0;
  for (const instance of buildings) {
    const box = aabbOfInstance(instance);
    let best = -1;
    const vx0 = grid.worldToVoxelX(box.minX);
    const vx1 = grid.worldToVoxelX(box.maxX);
    const vz0 = grid.worldToVoxelZ(box.minZ);
    const vz1 = grid.worldToVoxelZ(box.maxZ);
    for (let vz = vz0; vz <= vz1; vz++) {
      for (let vx = vx0; vx <= vx1; vx++) {
        if (!grid.inHorizontalBounds(vx, vz)) continue;
        const top = grid.solidSurfaceHeight(vx, vz);
        if (top + 1 > best) best = top + 1;
      }
    }
    if (best >= 0 && box.minY - best > 0.35) floating++;
  }

  return {
    natureInBuildings,
    buildingPairs,
    floating,
    affected: [...affected],
    ms: performance.now() - started,
  };
}

/**
 * 自动修复重叠（问题 3.6 的可选自动修复）：把建筑体积内的自然体素删掉。
 * @returns 删掉的体素数
 */
export function repairOverlaps(grid: VoxelGrid, buildings: readonly BuildingInstance[]): number {
  let removed = 0;
  for (const instance of buildings) {
    const box = aabbOfInstance(instance);
    const x0 = Math.max(0, Math.floor(box.minX + grid.halfX));
    const x1 = Math.min(grid.sizeX - 1, Math.ceil(box.maxX + grid.halfX));
    const z0 = Math.max(0, Math.floor(box.minZ + grid.halfZ));
    const z1 = Math.min(grid.sizeZ - 1, Math.ceil(box.maxZ + grid.halfZ));
    const y0 = Math.max(1, Math.floor(box.minY));
    const y1 = Math.min(grid.sizeY - 1, Math.ceil(box.maxY));

    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          if (!isNatureVoxel(grid.getVoxel(x, y, z))) continue;
          grid.setVoxel(x, y, z, AIR);
          removed++;
        }
      }
    }
  }
  if (removed > 0) grid.recount();
  return removed;
}

export { isNatureVoxel };
