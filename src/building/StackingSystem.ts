import type { BuildingDef, BuildingInstance, Stability } from './types';
import type { BuildingSystem } from './BuildingSystem';
import type { VoxelGrid } from '../voxel/VoxelGrid';
import type { SupportSurfaceIndex, SupportSlot } from './SupportSurface';
import {
  aabbOfDef,
  aabbOfInstance,
  footprintArea,
  horizontalOverlapArea,
  horizontalOverlapRect,
  intersects,
  type Aabb,
} from '../physics/CollisionDetect';

/** 堆叠方向：默认沿 Y 向上叠罗汉，也可以沿 X / Z 排成一堵墙 */
export type StackAxis = 'y' | 'x' | 'z';

/** 水平对齐方式 */
export type AlignMode = 'center' | 'free' | 'nearest';

/** 一个物体在当前世界里的堆叠信息（对应需求里的 StackingInfo） */
export interface StackingInfo {
  objectId: number;
  /** 堆叠层数：直接放在地形上的物体是第 1 层 */
  layer: number;
  /** 支撑它的物体 id；-1 表示地形 */
  supportId: number;
  /** 支撑面总面积 */
  supportArea: number;
  /** 支撑面已被占用的面积 */
  usedArea: number;
  /** 支撑面剩余面积 */
  remainingArea: number;
  /** 自己的接触面积比 0~1 */
  contactRatio: number;
  stability: Stability;
}

/** 一次落点解析的完整结果 */
export interface StackResolution {
  valid: boolean;
  reason: string;
  /** 修正后的落点（底面中心） */
  position: [number, number, number];
  /** 支撑物 id；-1 表示地形 */
  supportId: number;
  supportTopY: number;
  /** 支撑面所属的层（地形 = 0），新物体的层数是它 +1 */
  layer: number;
  /** 接触面积（平方米） */
  contactArea: number;
  contactRatio: number;
  supportArea: number;
  usedArea: number;
  remainingArea: number;
  stability: Stability;
  /** 放上去之后，从地面到它顶面的总高度（米） */
  totalHeight: number;
  /** 因为和已有物体重叠而自动上移的层数 */
  liftedLayers: number;
  /** 接触区矩形（可视化用） */
  contactRect: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
}

export interface StackingContext {
  buildings: BuildingSystem;
  grid: VoxelGrid;
  surfaces: SupportSurfaceIndex;
}

export interface ResolveOptions {
  /** 允许悬空放置（空中），默认 true —— 悬空的会变成动态刚体掉下来 */
  allowFloating?: boolean;
  /** 和新物体重叠时自动上移一层再试，默认 true */
  autoLift?: boolean;
  /** 最多自动上移几层 */
  maxLift?: number;
  /** 接触面积比阈值：低于它就判不稳 */
  unstableThreshold?: number;
  /** 接触面积比阈值：高于它才判稳固 */
  stableThreshold?: number;
}

/** 接触面积比阈值（需求给定：30% 以下不稳，60% 以上稳固） */
export const UNSTABLE_CONTACT_RATIO = 0.3;
export const STABLE_CONTACT_RATIO = 0.6;

/** 落到支撑面上时留的一点点缝，避免共面导致的 Z-fighting */
export const STACK_GAP = 0.004;

/** 层数超过它会提示"可能不稳定" */
export const LAYER_WARNING = 20;

/** 地形的支撑面是"按需合成"的，用这个 id 表示 */
export const TERRAIN_SUPPORT_ID = -1;

/**
 * 叠罗汉式堆叠系统。
 *
 * 三条铁律（对应本轮的问题 1）：
 * 1. **每个物体是独立实体** —— 不合并、不融合、不共享网格或碰撞盒；
 * 2. **A 放在 B 顶面时，A 的底部 Y = B 的顶部 Y** —— 一层一层往上加，视觉上就是叠罗汉；
 * 3. **下方有多个物体时取最高的那个支撑面**。
 *
 * 与"共享支撑面"（本轮问题 2）的关系：
 * 顶面不是"一个物体占满"，而是一块**有面积的资源**。
 * 只要新物体与顶面的接触面积够、且不与已经放上去的东西重叠，
 * 同一张桌子就能放很多个杯子 —— 见 SupportSurfaceIndex 的占用统计。
 *
 * 实现上刻意**不依赖 Rapier**：
 * 之前用形状投射做判定时，暂停状态下物理不 step、查询管线不更新，
 * 于是暂停中连点会把一堆物体放成同一个坐标（"多个物体重合成一个"的真正原因）。
 * 改用纯 AABB 数学之后，暂停、物理未就绪、离线校验全都一致。
 */
export class StackingSystem {
  private lastResolveMs = 0;
  private lastAnalyzeMs = 0;

  get resolveMs(): number {
    return this.lastResolveMs;
  }

  get analyzeMs(): number {
    return this.lastAnalyzeMs;
  }

  /**
   * 把一个"想放的位置"解析成真实的落点。
   *
   * 流程：算候选包围盒 → 找下方所有支撑面（地形 + 建筑）→ 取最高的那个 →
   * 底面贴到它的顶面 → 算接触面积/稳定性 → 若与已有物体重叠则自动上移一层重试。
   */
  resolve(
    def: BuildingDef,
    proposed: [number, number, number],
    rotationY: number,
    context: StackingContext,
    options: ResolveOptions = {},
  ): StackResolution {
    const started = performance.now();
    const allowFloating = options.allowFloating !== false;
    const autoLift = options.autoLift !== false;
    const maxLift = Math.max(0, options.maxLift ?? 6);
    const unstableThreshold = options.unstableThreshold ?? UNSTABLE_CONTACT_RATIO;
    const stableThreshold = options.stableThreshold ?? STABLE_CONTACT_RATIO;

    const { grid, buildings, surfaces } = context;
    let lifted = 0;
    let currentY = proposed[1];

    for (let attempt = 0; attempt <= maxLift; attempt++) {
      const box = aabbOfDef(def, [proposed[0], currentY, proposed[2]], rotationY);

      // 1) 找支撑面：先看地形，再看建筑顶面，取最高的那个
      const terrainSupport = this.evaluateTerrainSupport(box, grid);
      const buildingSurfaces = surfaces.surfacesUnder(box, currentY + 0.12, 8);
      const bestBuilding = buildingSurfaces[0];

      let supportTopY: number;
      let supportId: number;
      let supportArea: number;
      let usedArea: number;
      let contactArea: number;
      let contactRect: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
      let supportLayer: number;

      const useBuilding =
        bestBuilding !== undefined && bestBuilding.topY >= terrainSupport.topY - 0.02;

      if (useBuilding && bestBuilding) {
        supportTopY = bestBuilding.topY;
        supportId = bestBuilding.objectId;
        supportArea = bestBuilding.area;
        usedArea = bestBuilding.usedArea;
        supportLayer = bestBuilding.layer;

        const rect = horizontalOverlapRect(box, {
          minX: bestBuilding.minX,
          maxX: bestBuilding.maxX,
          minZ: bestBuilding.minZ,
          maxZ: bestBuilding.maxZ,
          minY: 0,
          maxY: 0,
        });
        contactRect = rect ? { minX: rect.minX, maxX: rect.maxX, minZ: rect.minZ, maxZ: rect.maxZ } : null;
        contactArea = rect ? rect.area : 0;
      } else if (terrainSupport.found) {
        supportTopY = terrainSupport.topY;
        supportId = TERRAIN_SUPPORT_ID;
        supportArea = terrainSupport.area;
        usedArea = 0;
        supportLayer = 0;
        contactArea = terrainSupport.contactArea;
        contactRect = terrainSupport.rect;
      } else if (allowFloating) {
        // 下方什么都没有：允许悬空（会变成动态刚体掉下去）
        supportTopY = currentY;
        supportId = TERRAIN_SUPPORT_ID;
        supportArea = 0;
        usedArea = 0;
        supportLayer = 0;
        contactArea = 0;
        contactRect = null;
      } else {
        this.lastResolveMs = performance.now() - started;
        return this.invalid(def, proposed, '下方没有任何支撑面');
      }

      const bottomY = supportTopY + STACK_GAP;
      const placed: [number, number, number] = [proposed[0], bottomY, proposed[2]];
      const placedBox = aabbOfDef(def, placed, rotationY);
      const ownArea = Math.max(1e-6, footprintArea(placedBox));
      const contactRatio = Math.min(1, contactArea / ownArea);

      // 2) 和已有物体是否穿插（排除支撑它的那一个）
      const blocking = this.findBlocking(buildings.all, placedBox, supportId);

      if (blocking && autoLift && attempt < maxLift) {
        // 重叠了 → 自动上移到那个物体之上，再试一次
        currentY = blocking.maxY + 0.02;
        lifted++;
        continue;
      }
      if (blocking) {
        this.lastResolveMs = performance.now() - started;
        return this.invalid(
          def,
          placed,
          `和 ${blockingName(buildings, blocking.id)} 重叠`,
          supportId,
          supportTopY,
          supportLayer,
        );
      }

      // 3) 稳定性
      const stability = this.judgeStability(contactRatio, placedBox, contactRect, unstableThreshold, stableThreshold);

      // 4) 世界边界
      if (
        placedBox.minX < -grid.halfX - 0.01 ||
        placedBox.maxX > grid.halfX + 0.01 ||
        placedBox.minZ < -grid.halfZ - 0.01 ||
        placedBox.maxZ > grid.halfZ + 0.01
      ) {
        this.lastResolveMs = performance.now() - started;
        return this.invalid(def, placed, '超出世界边界', supportId, supportTopY, supportLayer);
      }
      if (placedBox.maxY > grid.sizeY + 0.01) {
        this.lastResolveMs = performance.now() - started;
        return this.invalid(def, placed, '超出世界高度', supportId, supportTopY, supportLayer);
      }

      this.lastResolveMs = performance.now() - started;
      const layer = supportLayer + 1;
      return {
        valid: true,
        reason: this.describe(supportId, layer, contactRatio, stability, grid),
        position: placed,
        supportId,
        supportTopY,
        layer,
        contactArea,
        contactRatio,
        supportArea,
        usedArea,
        remainingArea: Math.max(0, supportArea - usedArea - contactArea),
        stability,
        totalHeight: placed[1] + def.size[1],
        liftedLayers: lifted,
        contactRect,
      };
    }

    this.lastResolveMs = performance.now() - started;
    return this.invalid(def, proposed, `连续上移 ${maxLift} 层仍然重叠`);
  }

  /**
   * **当前位置是否真的有支撑**（只判断，不改位置）。
   *
   * 与 `resolve()` 的区别很重要：
   * - `resolve()` 回答"如果我想放这里，它应该落到哪"—— 会把它吸附到下方的支撑面上；
   * - `checkSupport()` 回答"它现在这个位置稳不稳"—— 不会改位置，
   *   如果脚下离支撑面有 3 米，那就是**悬空**。
   *
   * 支撑失效检测（挖掉地基后房子掉下来）必须用后者：
   * 用 resolve 的话，任何位置都能"找到"地面当支撑，房子永远不会掉。
   */
  checkSupport(
    def: BuildingDef,
    position: [number, number, number],
    rotationY: number,
    context: StackingContext,
    tolerance = 0.12,
  ): {
    supported: boolean;
    supportId: number;
    supportTopY: number;
    gap: number;
    contactRatio: number;
    stability: Stability;
    layer: number;
  } {
    const box = aabbOfDef(def, position, rotationY);
    const under = context.surfaces.surfacesUnder(box, position[1] + tolerance, 4);
    const candidate = under[0];
    const terrainTop = this.terrainTopUnder(box, context.grid);

    let supportId = TERRAIN_SUPPORT_ID;
    let supportTopY = terrainTop;
    let supportLayer = 0;
    let area = footprintArea(box);
    let contact = 0;

    if (candidate && candidate.topY >= terrainTop - 0.02) {
      supportId = candidate.objectId;
      supportTopY = candidate.topY;
      supportLayer = candidate.layer;
      area = candidate.area;
      const rect = horizontalOverlapRect(box, {
        minX: candidate.minX,
        maxX: candidate.maxX,
        minZ: candidate.minZ,
        maxZ: candidate.maxZ,
        minY: 0,
        maxY: 0,
      });
      contact = rect ? rect.area : 0;
    } else {
      const terrain = this.evaluateTerrainSupport(box, context.grid);
      contact = terrain.contactArea;
    }

    const gap = position[1] - supportTopY;
    const ownArea = Math.max(1e-6, footprintArea(box));
    const contactRatio = Math.min(1, contact / ownArea);
    const supported = gap <= tolerance && gap >= -0.5 && ownArea > 0;
    void area;

    return {
      supported,
      supportId,
      supportTopY,
      gap,
      contactRatio: supported ? contactRatio : 0,
      stability: supported ? this.stabilityFromRatio(contactRatio) : 'unstable',
      layer: supportLayer + 1,
    };
  }

  // ------------------------------------------------------------------ 对齐

  /**
   * 水平对齐。
   * - `center`：新物体中心对齐支撑物中心（默认的"居中堆叠"）
   * - `nearest`：对齐到光标最近的那个已有物体的中心（Ctrl 按住时的吸附）
   * - `free`：保持光标位置（Alt 按住时的自由偏移）
   */
  align(
    proposed: [number, number, number],
    resolution: StackResolution,
    mode: AlignMode,
    context: StackingContext,
  ): [number, number, number] {
    if (mode === 'free' || resolution.supportId === TERRAIN_SUPPORT_ID) {
      return proposed;
    }
    const supporter = context.buildings.findById(resolution.supportId);
    if (!supporter) return proposed;

    if (mode === 'center') {
      // 居中堆叠：新物体中心对齐支撑物中心。
      // 但**不能无条件居中** —— 那张桌子的顶面已经放了东西时，
      // 居中会和已有物体重叠，此时应该退回到光标位置（由 resolve 的重叠检测兜底）。
      const surface = context.surfaces.get(resolution.supportId);
      if (!surface) return proposed;
      const dx = proposed[0] - supporter.position[0];
      const dz = proposed[2] - supporter.position[2];
      // 只在"光标已经很接近中心"时才居中，避免玩家想放边缘却被强行拉回中心
      if (Math.hypot(dx, dz) < Math.max(surface.maxX - surface.minX, surface.maxZ - surface.minZ)) {
        return [supporter.position[0], proposed[1], supporter.position[2]];
      }
      return proposed;
    }

    // nearest：吸附到最近的支撑物中心
    return [supporter.position[0], proposed[1], supporter.position[2]];
  }

  /** 找离某个点最近的可作为对齐目标的物体（Ctrl 对齐辅助用） */
  nearestObject(
    point: [number, number, number],
    context: StackingContext,
    radius = 6,
    excludeId = -1,
  ): BuildingInstance | null {
    let best: BuildingInstance | null = null;
    let bestDistance = radius;
    for (const instance of context.buildings.all) {
      if (instance.id === excludeId) continue;
      const distance = Math.hypot(
        instance.position[0] - point[0],
        instance.position[2] - point[2],
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = instance;
      }
    }
    return best;
  }

  /**
   * 沿某个轴找下一个摆放位置（成墙用）。
   * @returns 相邻位置（底面中心），没有参考物体时返回 null
   */
  nextAlongAxis(
    def: BuildingDef,
    reference: BuildingInstance,
    axis: StackAxis,
    context: StackingContext,
  ): [number, number, number] | null {
    if (axis === 'y') return null;
    const refSize = reference.size;
    if (!refSize) return null;

    const refBox = aabbOfInstance(reference);
    const halfSelf = axis === 'x' ? def.size[0] / 2 : def.size[2] / 2;
    const along = axis === 'x' ? refBox.maxX + halfSelf : refBox.maxZ + halfSelf;

    const proposed: [number, number, number] =
      axis === 'x'
        ? [along, reference.position[1], reference.position[2]]
        : [reference.position[0], reference.position[1], along];

    const resolution = this.resolve(def, proposed, reference.rotationY, context, { autoLift: false });
    return resolution.valid ? resolution.position : null;
  }

  // ------------------------------------------------------------------ 分析

  /** 某个物体当前的堆叠信息 */
  infoOf(instance: BuildingInstance, context: StackingContext): StackingInfo {
    const surface = context.surfaces.get(instance.id);
    const box = aabbOfInstance(instance);

    // 找支撑它的那个物体（最高且顶面不超过我底面）
    let supportId = TERRAIN_SUPPORT_ID;
    let supportArea = footprintArea(box);
    let usedArea = 0;
    let bestTop = -Infinity;

    const under = context.surfaces.surfacesUnder(box, box.minY + 0.12, 4);
    const candidate = under[0];
    if (candidate && candidate.topY >= this.terrainTopUnder(box, context.grid) - 0.02) {
      supportId = candidate.objectId;
      supportArea = candidate.area;
      usedArea = candidate.usedArea;
      bestTop = candidate.topY;
    }

    void bestTop;

    const ownArea = Math.max(1e-6, footprintArea(box));
    const contact = this.contactAreaFor(box, supportId, context);
    const contactRatio = Math.min(1, contact / ownArea);

    return {
      objectId: instance.id,
      layer: surface?.layer ?? 1,
      supportId,
      supportArea,
      usedArea,
      remainingArea: Math.max(0, supportArea - usedArea),
      contactRatio,
      stability: this.stabilityFromRatio(contactRatio),
    };
  }

  /** 全量分析：给每个物体算一份堆叠信息（稳定性着色、调试面板用） */
  analyze(context: StackingContext): Map<number, StackingInfo> {
    const started = performance.now();
    const result = new Map<number, StackingInfo>();
    for (const instance of context.buildings.all) {
      result.set(instance.id, this.infoOf(instance, context));
    }
    this.lastAnalyzeMs = performance.now() - started;
    return result;
  }

  /**
   * 选中物体的支撑面明细（调试面板 + 可视化用）。
   * @returns 支撑面信息 + 已占用明细；没有支撑（悬空）时返回 null
   */
  supportSurfaceOf(
    instance: BuildingInstance,
    context: StackingContext,
  ): { surface: { objectId: number; topY: number; area: number; usedArea: number; freeArea: number }; slots: SupportSlot[]; isTerrain: boolean } | null {
    const box = aabbOfInstance(instance);
    const under = context.surfaces.surfacesUnder(box, box.minY + 0.12, 4);
    const candidate = under[0];
    const terrainTop = this.terrainTopUnder(box, context.grid);

    if (!candidate || candidate.topY < terrainTop - 0.02) {
      return {
        surface: {
          objectId: TERRAIN_SUPPORT_ID,
          topY: terrainTop,
          area: footprintArea(box),
          usedArea: 0,
          freeArea: footprintArea(box),
        },
        slots: [],
        isTerrain: true,
      };
    }

    return {
      surface: {
        objectId: candidate.objectId,
        topY: candidate.topY,
        area: candidate.area,
        usedArea: candidate.usedArea,
        freeArea: candidate.freeArea,
      },
      slots: candidate.occupiedBy,
      isTerrain: false,
    };
  }

  /** 支撑面上还有多少剩余面积可供某个模型使用 */
  remainingPlacements(def: BuildingDef, surfaceObjectId: number, context: StackingContext, rotationY = 0): number {
    const surface = context.surfaces.get(surfaceObjectId);
    if (!surface) return 0;
    const probe = aabbOfDef(def, [surface.minX, surface.topY, surface.minZ], rotationY);
    const own = Math.max(1e-6, footprintArea(probe));
    return Math.max(0, Math.floor(surface.freeArea / own));
  }

  // ------------------------------------------------------------------ 内部

  /** 地形在某个底面下的支撑情况（含接触面积） */
  private evaluateTerrainSupport(
    box: Aabb,
    grid: VoxelGrid,
  ): {
    found: boolean;
    topY: number;
    area: number;
    contactArea: number;
    rect: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  } {
    const vx0 = grid.worldToVoxelX(box.minX);
    const vx1 = grid.worldToVoxelX(box.maxX);
    const vz0 = grid.worldToVoxelZ(box.minZ);
    const vz1 = grid.worldToVoxelZ(box.maxZ);

    let topY = -Infinity;
    let found = false;
    // 先取足迹范围内的最高地表
    for (let vz = vz0; vz <= vz1; vz++) {
      for (let vx = vx0; vx <= vx1; vx++) {
        if (!grid.inHorizontalBounds(vx, vz)) continue;
        const top = grid.solidSurfaceHeight(vx, vz);
        if (top < 0) continue;
        found = true;
        if (top + 1 > topY) topY = top + 1;
      }
    }
    if (!found) return { found: false, topY: 0, area: 0, contactArea: 0, rect: null };

    // 接触面积 = 足迹范围内"地表高度够到 topY"的那些格子所占的面积
    // （地形起伏时，只有一部分底面真的贴上了 —— 于是坡度上摆放会自然被判为不稳）
    let touching = 0;
    let total = 0;
    for (let vz = vz0; vz <= vz1; vz++) {
      for (let vx = vx0; vx <= vx1; vx++) {
        total++;
        if (!grid.inHorizontalBounds(vx, vz)) continue;
        const top = grid.solidSurfaceHeight(vx, vz);
        // 容差 1 格：体素地形本身是 1 米台阶，高差 <= 1 格的格子算真正贴上了
        if (top >= 0 && Math.abs(top + 1 - topY) < 1.05) touching++;
      }
    }
    const ratio = total > 0 ? touching / total : 0;
    const area = footprintArea(box);
    return {
      found: true,
      topY,
      area,
      contactArea: area * ratio,
      rect: { minX: box.minX, maxX: box.maxX, minZ: box.minZ, maxZ: box.maxZ },
    };
  }

  private terrainTopUnder(box: Aabb, grid: VoxelGrid): number {
    const vx0 = grid.worldToVoxelX(box.minX);
    const vx1 = grid.worldToVoxelX(box.maxX);
    const vz0 = grid.worldToVoxelZ(box.minZ);
    const vz1 = grid.worldToVoxelZ(box.maxZ);
    let topY = 0;
    for (let vz = vz0; vz <= vz1; vz++) {
      for (let vx = vx0; vx <= vx1; vx++) {
        if (!grid.inHorizontalBounds(vx, vz)) continue;
        const top = grid.solidSurfaceHeight(vx, vz);
        if (top >= 0 && top + 1 > topY) topY = top + 1;
      }
    }
    return topY;
  }

  private contactAreaFor(box: Aabb, supportId: number, context: StackingContext): number {
    if (supportId === TERRAIN_SUPPORT_ID) {
      return this.evaluateTerrainSupport(box, context.grid).contactArea;
    }
    const surface = context.surfaces.get(supportId);
    if (!surface) return 0;
    return horizontalOverlapArea(box, {
      minX: surface.minX,
      maxX: surface.maxX,
      minZ: surface.minZ,
      maxZ: surface.maxZ,
      minY: 0,
      maxY: 0,
    });
  }

  /** 找出与新物体实体相交的已有物体（排除支撑它的那个） */
  private findBlocking(
    all: readonly BuildingInstance[],
    box: Aabb,
    supportId: number,
  ): Aabb & { id: number } | null {
    let worst: (Aabb & { id: number }) | null = null;
    let worstVolume = 0;
    for (const other of all) {
      if (other.id === supportId) continue;
      const otherBox = aabbOfInstance(other);
      if (!intersects(box, otherBox)) continue;
      const volume =
        Math.min(box.maxX, otherBox.maxX) - Math.max(box.minX, otherBox.minX) > 0
          ? (Math.min(box.maxX, otherBox.maxX) - Math.max(box.minX, otherBox.minX)) *
            (Math.min(box.maxY, otherBox.maxY) - Math.max(box.minY, otherBox.minY)) *
            (Math.min(box.maxZ, otherBox.maxZ) - Math.max(box.minZ, otherBox.minZ))
          : 0;
      if (volume > worstVolume) {
        worstVolume = volume;
        worst = { ...otherBox, id: other.id };
      }
    }
    return worst;
  }

  private judgeStability(
    contactRatio: number,
    box: Aabb,
    contactRect: { minX: number; maxX: number; minZ: number; maxZ: number } | null,
    unstableThreshold: number,
    stableThreshold: number,
  ): Stability {
    if (contactRatio < unstableThreshold) return 'unstable';

    const centerX = (box.minX + box.maxX) / 2;
    const centerZ = (box.minZ + box.maxZ) / 2;
    if (contactRect) {
      const margin = Math.min(
        centerX - contactRect.minX,
        contactRect.maxX - centerX,
        centerZ - contactRect.minZ,
        contactRect.maxZ - centerZ,
      );
      // 重心压在支撑边缘之外 → 一定倒
      if (margin < -0.05) return 'unstable';
      if (margin < 0.05 && contactRatio < stableThreshold) return 'critical';
    }

    return contactRatio >= stableThreshold ? 'stable' : 'critical';
  }

  private stabilityFromRatio(contactRatio: number): Stability {
    if (contactRatio < UNSTABLE_CONTACT_RATIO) return 'unstable';
    return contactRatio >= STABLE_CONTACT_RATIO ? 'stable' : 'critical';
  }

  private describe(
    supportId: number,
    layer: number,
    contactRatio: number,
    stability: Stability,
    grid: VoxelGrid,
  ): string {
    const percent = `${Math.round(contactRatio * 100)}%`;
    const where = supportId === TERRAIN_SUPPORT_ID ? '地面' : `#${supportId} 顶面`;
    const stabilityText = stability === 'stable' ? '稳固' : stability === 'critical' ? '勉强' : '不稳';
    const layerWarning = layer > LAYER_WARNING ? `｜超过 ${LAYER_WARNING} 层，可能不稳定` : '';
    void grid;
    return `落在${where}（第 ${layer} 层，接触 ${percent}，${stabilityText}）${layerWarning}`;
  }

  private invalid(
    def: BuildingDef,
    position: [number, number, number],
    reason: string,
    supportId = TERRAIN_SUPPORT_ID,
    supportTopY = position[1],
    layer = 1,
  ): StackResolution {
    return {
      valid: false,
      reason,
      position,
      supportId,
      supportTopY,
      layer,
      contactArea: 0,
      contactRatio: 0,
      supportArea: 0,
      usedArea: 0,
      remainingArea: 0,
      stability: 'unstable',
      totalHeight: position[1] + def.size[1],
      liftedLayers: 0,
      contactRect: null,
    };
  }
}

function blockingName(buildings: BuildingSystem, id: number): string {
  const instance = buildings.findById(id);
  return instance?.name ?? instance?.defId ?? `#${id}`;
}

/** 稳定性对应的 UI 颜色（补充 2：不稳定堆叠视觉提示） */
export const STABILITY_COLORS: Record<Stability, number> = {
  stable: 0x7fd06a,
  critical: 0xffcc4d,
  unstable: 0xff5a5a,
};

export const STABILITY_LABELS: Record<Stability, string> = {
  stable: '稳固',
  critical: '勉强',
  unstable: '不稳',
};
