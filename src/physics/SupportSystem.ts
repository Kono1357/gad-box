import { SUPPORT_CONFIG } from '../config';
import type { BuildingInstance, SupportIssue } from '../building/types';
import type { VoxelGrid } from '../voxel/VoxelGrid';

/**
 * 支撑面共享报告（M2.5 扩展）。
 *
 * 回答的是"一个顶面到底被几个物体共用"：
 * 共享数 > 1 就说明"一个接触面放多个物体"这件事真的成立了 ——
 * 这也是本轮问题 2 的验收依据。
 */
export interface SurfaceShareReport {
  /** 有顶面的物体数量 */
  surfaceCount: number;
  /** 被 2 个及以上物体共用的顶面数量 */
  sharedSurfaceCount: number;
  /** 单个顶面上最多的占用数 */
  maxShare: number;
  /** 平均剩余面积占比 */
  averageFreeRatio: number;
  ms: number;
}

/** 一次支撑分析的结果 */
export interface SupportReport {
  /** 有问题的实例 */
  issues: SupportIssue[];
  /** 与地面直接接触的实例数 */
  groundedCount: number;
  /** BFS 能连到地基的实例数 */
  connectedCount: number;
  /** 完全悬空的实例数 */
  floatingCount: number;
  ms: number;
}

interface Box {
  instance: BuildingInstance;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  /** 到最近"已支撑"实例的累计水平悬挑距离 */
  cantilever: number;
  supported: boolean;
}

/**
 * 支撑检查（M1.5 是**诊断**，不是物理）。
 *
 * M3 才接 Rapier 做真正的倒塌，本轮按需求"预留接口 + 能看结果"实现：
 *
 * 1. **贴地判定**：实例底面覆盖的地形里，只要有一格实心地形的高点够到实例底部，
 *    这一块就算"扎在地基上"，作为 BFS 的种子；
 * 2. **BFS 传播支撑**：从种子出发，把"与已支撑实例相接"的实例也标记为已支撑，
 *    同时累计水平方向走了多远（悬挑距离）；
 * 3. **判定**：完全连不上的 → `floating`（悬空）；连得上但悬挑超过阈值 → `cantilever`。
 *
 * M3 接物理时，只需要把这个报告里的 `floating` / `cantilever` 实例转成动态刚体即可，
 * 数据结构不用改。
 */
export class SupportSystem {
  enabled: boolean = SUPPORT_CONFIG.enabledByDefault;
  /** 允许的最大悬挑距离（米） */
  maxCantilever: number = SUPPORT_CONFIG.maxCantilever;
  /** 贴地容差（米） */
  groundTolerance: number = SUPPORT_CONFIG.groundTolerance;

  /** 两个实例相距多近算"相接"（米） */
  private readonly touchDistance = 0.75;

  analyze(instances: readonly BuildingInstance[], grid: VoxelGrid): SupportReport {
    const started = performance.now();
    const issues: SupportIssue[] = [];

    if (instances.length === 0) {
      return { issues, groundedCount: 0, connectedCount: 0, floatingCount: 0, ms: 0 };
    }

    // 1) 先算包围盒
    const boxes: Box[] = instances.map((instance) => {
      const size = this.sizeOf(instance);
      const halfW = size[0] / 2;
      const halfD = size[2] / 2;
      return {
        instance,
        minX: instance.position[0] - halfW,
        maxX: instance.position[0] + halfW,
        minY: instance.position[1],
        maxY: instance.position[1] + size[1],
        minZ: instance.position[2] - halfD,
        maxZ: instance.position[2] + halfD,
        cantilever: 0,
        supported: false,
      };
    });

    // 2) 找"种子"：底部够到地形的实例
    const queue: Box[] = [];
    let groundedCount = 0;
    for (const box of boxes) {
      if (this.touchesGround(box, grid)) {
        box.supported = true;
        box.cantilever = 0;
        groundedCount++;
        queue.push(box);
      }
    }

    // 3) BFS 传播支撑
    let connected = groundedCount;
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++]!;
      for (const other of boxes) {
        if (other.supported) continue;
        const gap = this.horizontalGap(current, other);
        if (gap === null) continue; // 根本没接触
        const distance = current.cantilever + gap;
        if (distance > this.maxCantilever + this.touchDistance) continue; // 悬挑太长，不传播
        other.supported = true;
        other.cantilever = distance;
        connected++;
        queue.push(other);
      }
    }

    // 4) 汇总问题
    let floatingCount = 0;
    for (const box of boxes) {
      if (!box.supported) {
        floatingCount++;
        issues.push({
          instanceId: box.instance.id,
          kind: 'floating',
          message: `#${box.instance.id} ${box.instance.defId} 完全悬空，没有任何部件连到地形`,
        });
        box.instance.supported = false;
        box.instance.cantilever = undefined;
        continue;      }
      box.instance.supported = true;
      box.instance.cantilever = box.cantilever;
      if (box.cantilever > this.maxCantilever) {
        issues.push({
          instanceId: box.instance.id,
          kind: 'cantilever',
          message: `#${box.instance.id} ${box.instance.defId} 悬挑 ${box.cantilever.toFixed(1)} 米，超过阈值 ${this.maxCantilever} 米`,
        });
      }
    }

    return {
      issues,
      groundedCount,
      connectedCount: connected,
      floatingCount,
      ms: performance.now() - started,
    };
  }

  /**
   * 统计支撑面的共享情况（M2.5 新增）。
   * 数据直接来自 SupportSurfaceIndex 的占用统计，所以是"真的这么放的"，不是估算。
   */
  analyzeSharing(surfaces: {
    all(): Array<{ area: number; usedArea: number; freeArea: number; occupiedBy: Array<{ objectId: number }> }>;
  }): SurfaceShareReport {
    const started = performance.now();
    const list = surfaces.all();
    let shared = 0;
    let maxShare = 0;
    let freeRatioSum = 0;

    for (const surface of list) {
      const occupants = surface.occupiedBy.length;
      if (occupants >= 2) shared++;
      if (occupants > maxShare) maxShare = occupants;
      freeRatioSum += surface.area > 0 ? surface.freeArea / surface.area : 1;
    }

    return {
      surfaceCount: list.length,
      sharedSurfaceCount: shared,
      maxShare,
      averageFreeRatio: list.length > 0 ? freeRatioSum / list.length : 1,
      ms: performance.now() - started,
    };
  }

  /** 实例的包围盒尺寸（建筑只绕 Y 旋转，所以直接用原始包围盒即可） */
  private sizeOf(instance: BuildingInstance): [number, number, number] {
    return instance.size ?? [1, 1, 1];
  }

  /** 实例底部是否够到地形（在其足迹范围内采样若干点） */
  private touchesGround(box: Box, grid: VoxelGrid): boolean {
    const bottom = box.minY;
    const vx0 = grid.worldToVoxelX(box.minX);
    const vx1 = grid.worldToVoxelX(box.maxX);
    const vz0 = grid.worldToVoxelZ(box.minZ);
    const vz1 = grid.worldToVoxelZ(box.maxZ);

    const stepX = Math.max(1, Math.ceil((vx1 - vx0) / 4));
    const stepZ = Math.max(1, Math.ceil((vz1 - vz0) / 4));

    for (let vz = vz0; vz <= vz1; vz += stepZ) {
      for (let vx = vx0; vx <= vx1; vx += stepX) {
        if (!grid.inHorizontalBounds(vx, vz)) continue;
        const top = grid.solidSurfaceHeight(vx, vz);
        if (top < 0) continue;
        const surfaceY = top + 1; // 地表最高体素的顶面
        if (Math.abs(surfaceY - bottom) <= this.groundTolerance) return true;
      }
    }
    return false;
  }

  /**
   * 两个包围盒在水平方向上的间隙；垂直方向必须相邻（有重叠或间距很小）才算接触。
   * @returns 水平间隙（米），或 null 表示不接触
   */
  private horizontalGap(a: Box, b: Box): number | null {
    // 垂直方向：必须有重叠，或者上下差得不多（堆叠）
    const verticalOverlap = a.minY <= b.maxY + this.touchDistance && b.minY <= a.maxY + this.touchDistance;
    if (!verticalOverlap) return null;

    const gapX = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
    const gapZ = Math.max(0, Math.max(a.minZ - b.maxZ, b.minZ - a.maxZ));
    const gap = Math.hypot(gapX, gapZ);
    return gap <= this.touchDistance ? gap : null;
  }
}
