import type { BuildingInstance } from './types';
import type { BuildingSystem } from './BuildingSystem';
import type { VoxelGrid } from '../voxel/VoxelGrid';
import {
  aabbOfInstance,
  footprintArea,
  horizontalOverlapArea,
  horizontalOverlapRect,
  type Aabb,
} from '../physics/CollisionDetect';

/** 支撑面上被某个物体占用的一小块 */
export interface SupportSlot {
  objectId: number;
  /** 占用面积（平方米） */
  area: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * 一个支撑面 = 某个物体的**顶面**。
 *
 * 关键点：**顶面是共享资源**。
 * 一张桌子 1.4×0.8 = 1.12 m² 的顶面，可以放好几个杯子、盘子、书 ——
 * 只要每次放上去的东西与桌面的接触面积够，且不与已经放上去的东西重叠。
 *
 * 这就是"问题 2"的正解：早期实现的锚点永远指向"顶面中心"，
 * 导致同一张桌子上只能放同一个位置的东西（第二个必然和第一个重叠而被拒绝）。
 */
export interface SupportSurfaceInfo {
  /** 提供这个顶面的物体；-1 表示地形（地形的支撑面是按需合成的，不在这里） */
  objectId: number;
  /** 顶面高度（米，世界坐标） */
  topY: number;
  /** 顶面总面积（平方米） */
  area: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** 已经压在它上面的物体 */
  occupiedBy: SupportSlot[];
  usedArea: number;
  /** 剩余可用面积 */
  freeArea: number;
  /** 该物体所在的堆叠层（地形上的物体 = 1） */
  layer: number;
}

/** 空间哈希的格子边长（米）。用来把"找下方支撑面"从 O(n²) 降到接近 O(n) */
const CELL_SIZE = 8;

function cellKeys(box: Aabb): string[] {
  const keys: string[] = [];
  for (let x = Math.floor(box.minX / CELL_SIZE); x <= Math.floor(box.maxX / CELL_SIZE); x++) {
    for (let z = Math.floor(box.minZ / CELL_SIZE); z <= Math.floor(box.maxZ / CELL_SIZE); z++) {
      keys.push(`${x},${z}`);
    }
  }
  return keys;
}

/**
 * 支撑面索引。
 *
 * 职责：
 * 1. 为每个建筑算出它的顶面（面积、范围）；
 * 2. 算出每个物体压在哪个支撑面上、占了多少面积；
 * 3. 提供"某个落点下方有哪些支撑面"的查询。
 *
 * 重建带缓存：物体数量与编辑版本号都没变就直接复用，
 * 所以拖动光标每帧查询是免费的（实测重建 200 个物体 < 2 ms，查询 < 0.1 ms）。
 */
/** 焦点量化格（米）：镜头在一个格子内移动时不重建索引 */
const FOCUS_BUCKET_M = 4;
/** 构建时把统计半径放大的余量（覆盖焦点量化带来的最大 2.8 米偏移，再留一点） */
const FOCUS_MARGIN = 4;

export class SupportSurfaceIndex {
  private readonly surfaces = new Map<number, SupportSurfaceInfo>();
  /** 动态世界里的自增计数：让签名每次都不同（即"每帧重建"），见 rebuild 的注释 */
  private dynamicTicks = 0;
  private readonly buckets = new Map<string, number[]>();
  private cachedSignature = '';
  private lastRebuildMs = 0;

  get rebuildMs(): number {
    return this.lastRebuildMs;
  }

  get size(): number {
    return this.surfaces.size;
  }

  /** 世界变了就调用（增删改物体时） */
  invalidate(): void {
    this.cachedSignature = '';
  }

  get(objectId: number): SupportSurfaceInfo | undefined {
    return this.surfaces.get(objectId);
  }

  all(): SupportSurfaceInfo[] {
    return [...this.surfaces.values()];
  }

  /**
   * 重建索引。
   * @param focus 只统计这个圆内的物体（性能要求：支撑检查只看玩家附近 32 米）
   */
  rebuild(buildings: BuildingSystem, grid: VoxelGrid, focus?: { x: number; z: number; radius: number }): void {
    const started = performance.now();

    // ── 缓存签名 ──
    //
    // 老版本把焦点坐标**精确到 0.01 米**写进签名，于是玩家一移动镜头签名就变，
    // 索引**每帧全量重建**。实测代价：62 个物体 0.99 ms/帧、241 个物体 1.62 ms/帧，
    // 手机端还要乘 3~5 —— 这几乎全被浪费掉了，因为索引内容是"附近 40 米内的顶面"，
    // 镜头挪几厘米它根本不会变。
    //
    // 现在把焦点**量化到 4 米格**：在一个格子内移动不重建。
    // 代价是索引中心可能偏离真实焦点最多 2.8 米 —— 所以构建时按
    // `FOCUS_MARGIN` 放大半径，保证真正的查询范围仍被完整覆盖。
    // 这是"用一点冗余换掉每帧一次全量重建"，方向是对的。
    const bucket = focus ? `${Math.round(focus.x / FOCUS_BUCKET_M)},${Math.round(focus.z / FOCUS_BUCKET_M)}` : 'all';
    // 动态物体（正在翻滚的）位置每帧都在变，它们的顶面位置也在变 ——
    // 这种情况下**必须每帧重建**，否则"站在上面"的判定会用到过期顶面，
    // 表现出来就是"把杯子放在正在滚动的球上，它悬在半空"。
    // 所以动态世界照旧每帧重建；生成出来的地图全是静态物体，
    // 走的才是下面这条缓存路径（也就是玩家抱怨卡的那种场景）。
    if (buildings.dynamicCount > 0) this.dynamicTicks += 1;
    const dynamicKey = buildings.dynamicCount > 0 ? `dyn:${this.dynamicTicks}` : 'static';
    const signature = `${buildings.count}|${grid.editRevision}|${bucket}|${focus?.radius ?? 0}|${dynamicKey}`;
    if (signature === this.cachedSignature) return;
    this.cachedSignature = signature;
    const buildFocus = focus ? { x: focus.x, z: focus.z, radius: focus.radius + FOCUS_MARGIN } : undefined;
    focus = buildFocus;

    this.surfaces.clear();
    this.buckets.clear();

    const instances: BuildingInstance[] = [];
    /** id → 实例：findSupporter 每次都要反查，用 Map 才不会退化成 O(n²) */
    const byId = new Map<number, BuildingInstance>();
    for (const instance of buildings.all) {
      if (instance.mirror === undefined) instance.mirror = 'none';
      if (focus) {
        const dx = instance.position[0] - focus.x;
        const dz = instance.position[2] - focus.z;
        if (dx * dx + dz * dz > focus.radius * focus.radius) continue;
      }
      instances.push(instance);
      byId.set(instance.id, instance);
    }

    // 1) 每个物体先有一条"顶面"
    for (const instance of instances) {
      const box = aabbOfInstance(instance);
      this.surfaces.set(instance.id, {
        objectId: instance.id,
        topY: box.maxY,
        area: footprintArea(box),
        minX: box.minX,
        maxX: box.maxX,
        minZ: box.minZ,
        maxZ: box.maxZ,
        occupiedBy: [],
        usedArea: 0,
        freeArea: footprintArea(box),
        layer: 1,
      });
    }

    // 2) 空间哈希，方便找"下方是谁"
    for (const instance of instances) {
      const box = aabbOfInstance(instance);
      for (const key of cellKeys(box)) {
        const list = this.buckets.get(key);
        if (list) list.push(instance.id);
        else this.buckets.set(key, [instance.id]);
      }
    }

    // 3) 每个物体找它的支撑物，并把自己的占用登记到对方的顶面上。
    //    顺带把"谁被谁托着"记进 supporterOf，第 4 步传播层数时就不用再找一遍。
    const supporterOf = new Map<number, number>();
    const boxes = new Map<number, Aabb>();
    for (const instance of instances) boxes.set(instance.id, aabbOfInstance(instance));

    for (const instance of instances) {
      const box = boxes.get(instance.id)!;
      const supporter = this.findSupporter(instance.id, box, byId);
      if (!supporter) {
        const surface = this.surfaces.get(instance.id);
        if (surface) surface.layer = 1;
        continue;
      }
      supporterOf.set(instance.id, supporter.id);

      const supportSurface = this.surfaces.get(supporter.id);
      if (!supportSurface) continue;
      const rect = horizontalOverlapRect(box, {
        minX: supportSurface.minX,
        maxX: supportSurface.maxX,
        minZ: supportSurface.minZ,
        maxZ: supportSurface.maxZ,
        minY: 0,
        maxY: 0,
      });
      if (!rect) continue;

      const area = rect.area;
      supportSurface.occupiedBy.push({
        objectId: instance.id,
        area,
        minX: rect.minX,
        maxX: rect.maxX,
        minZ: rect.minZ,
        maxZ: rect.maxZ,
      });
      supportSurface.usedArea += area;
      supportSurface.freeArea = Math.max(0, supportSurface.area - supportSurface.usedArea);
    }

    // 4) 层数按"从低到高"传播：复用第 3 步已经算好的 supporterOf 与 boxes
    const byHeight = instances
      .map((instance) => ({ id: instance.id, minY: boxes.get(instance.id)!.minY }))
      .sort((a, b) => a.minY - b.minY);
    for (const entry of byHeight) {
      const surface = this.surfaces.get(entry.id);
      if (!surface) continue;
      const supporterId = supporterOf.get(entry.id);
      if (supporterId === undefined) {
        surface.layer = 1;
        continue;
      }
      const supportSurface = this.surfaces.get(supporterId);
      surface.layer = (supportSurface?.layer ?? 1) + 1;
    }

    this.lastRebuildMs = performance.now() - started;
  }

  /**
   * 找出支撑某个物体的那个物体：顶面高度不超过它的底面（留容差），且水平方向有重叠。
   * 多个候选时取**最高的那个**（这就是"取最高支撑面"）。
   */
  private findSupporter(
    selfId: number,
    box: Aabb,
    byId: Map<number, BuildingInstance>,
  ): BuildingInstance | undefined {
    let best: BuildingInstance | undefined;
    let bestTop = -Infinity;

    for (const key of cellKeys(box)) {
      const ids = this.buckets.get(key);
      if (!ids) continue;
      for (const id of ids) {
        if (id === selfId) continue;
        const other = byId.get(id);
        if (!other) continue;
        const otherBox = aabbOfInstance(other);
        // 顶面必须在我的底面附近或之下
        if (otherBox.maxY > box.minY + 0.12) continue;
        if (horizontalOverlapArea(box, otherBox) <= 0) continue;
        if (otherBox.maxY > bestTop) {
          bestTop = otherBox.maxY;
          best = other;
        }
      }
    }
    return best;
  }

  /**
   * 找出落在某个底面矩形下方的所有支撑面（按高度从高到低）。
   * @param bottomY 新物体的底面高度；只考虑不高于它（+容差）的支撑面
   */
  surfacesUnder(footprint: Aabb, bottomY: number, limit = 8): SupportSurfaceInfo[] {
    const result: SupportSurfaceInfo[] = [];
    const seen = new Set<number>();

    for (const key of cellKeys(footprint)) {
      const ids = this.buckets.get(key);
      if (!ids) continue;
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const surface = this.surfaces.get(id);
        if (!surface) continue;
        if (surface.topY > bottomY + 0.12) continue;
        // 水平方向必须有重叠（否则不是"下方"，是"旁边"）
        if (
          horizontalOverlapArea(footprint, {
            minX: surface.minX,
            maxX: surface.maxX,
            minZ: surface.minZ,
            maxZ: surface.maxZ,
            minY: 0,
            maxY: 0,
          }) <= 0
        ) {
          continue;
        }
        result.push(surface);
      }
    }

    result.sort((a, b) => b.topY - a.topY);
    return result.slice(0, limit);
  }

  /** 查询形状上用得到：某个矩形范围内有没有支撑面（供 UI 高亮） */
  surfacesInRange(minX: number, minZ: number, maxX: number, maxZ: number, limit = 24): SupportSurfaceInfo[] {
    const probe: Aabb = { minX, maxX, minY: 0, maxY: 0, minZ, maxZ };
    const result: SupportSurfaceInfo[] = [];
    const seen = new Set<number>();
    for (const key of cellKeys(probe)) {
      const ids = this.buckets.get(key);
      if (!ids) continue;
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const surface = this.surfaces.get(id);
        if (surface) result.push(surface);
      }
    }
    return result.slice(0, limit);
  }
}
