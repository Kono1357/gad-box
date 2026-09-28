import type { BuildingDef } from '../building/types';
import type { BuildingSystem } from '../building/BuildingSystem';
import type { VoxelGrid } from '../voxel/VoxelGrid';
import type { SupportSurfaceIndex } from '../building/SupportSurface';
import type { Stability } from '../building/types';
import { StackingSystem } from '../building/StackingSystem';

export type { Stability };

/** 堆叠判定所需的世界上下文 */
export interface StackContext {
  buildings: BuildingSystem;
  grid: VoxelGrid;
  /** 支撑面索引（由 Engine 持有并维护） */
  surfaces: SupportSurfaceIndex;
}

/** 兼容旧调用点的结果结构（新代码请直接用 StackingSystem 的 StackResolution） */
export interface StackResult {
  supported: boolean;
  supportId?: string;
  layer: number;
  stability: Stability;
  contactRatio: number;
  centerMargin: number;
  reason: string;
  gap: number;
}

/**
 * 堆叠与支撑判定的**兼容层**。
 *
 * M2 时这个类直接用 Rapier 的形状投射做判定，有两个致命问题：
 * 1. **暂停时物理不 step → 查询管线不更新 → 判定永远返回"下方什么都没有"**，
 *    于是暂停中连点会把一堆物体放成同一个坐标（玩家看到的"多个物体重合成一个"）；
 * 2. 每次查询都要过一遍宽相位，200 个物体的场景里单次要 1.87 ms，
 *    8 个候选点直接让"智能放置建议"超出 30 ms 预算。
 *
 * M2.5 把真正的逻辑搬到了 `building/StackingSystem.ts`（纯 AABB 数学），
 * 这里只保留一个薄适配层，让 M2 的调用点不用重写。
 * `physics` / `terrain` 字段已经不再需要，保留为可选是为了兼容旧调用方传入。
 */
export class StackSystem {
  private readonly stacking = new StackingSystem();

  /** 底层的新系统（Engine / UI 想用完整能力时可以直接拿） */
  get core(): StackingSystem {
    return this.stacking;
  }

  evaluate(
    def: BuildingDef,
    position: [number, number, number],
    rotationY: number,
    context: StackContext,
    _excludeBody = -1,
  ): StackResult {
    // 注意用的是 checkSupport 而不是 resolve：
    // 这个方法的语义是"它现在这个位置有没有支撑"，
    // resolve 会把它吸附到下方的支撑面上，那样任何位置都会被判定为有支撑。
    const check = this.stacking.checkSupport(def, position, rotationY, context);
    const stabilityText =
      check.stability === 'stable' ? '稳固' : check.stability === 'critical' ? '勉强' : '不稳';
    const where = check.supportId < 0 ? '地面' : `#${check.supportId}`;
    return {
      supported: check.supported,
      supportId: check.supportId < 0 ? 'terrain' : String(check.supportId),
      layer: check.layer,
      stability: check.stability,
      contactRatio: check.contactRatio,
      centerMargin: -Infinity,
      reason: check.supported
        ? `落在${where}（第 ${check.layer} 层，接触 ${Math.round(check.contactRatio * 100)}%，${stabilityText}）`
        : `悬空 ${check.gap.toFixed(2)} 米，没有支撑`,
      gap: Math.max(0, check.gap),
    };
  }

  /** 检查所有物体里哪些没有支撑（失去支撑的会被转成动态刚体掉下来） */
  findUnsupported(context: StackContext, getDef: (id: string) => BuildingDef | undefined): number[] {
    const lost: number[] = [];
    for (const instance of context.buildings.all) {
      const def = getDef(instance.defId);
      if (!def) continue;
      const result = this.evaluate(def, instance.position, instance.rotationY, context);
      instance.supported = result.supported;
      instance.stackLayer = result.layer;
      instance.stability = result.stability;
      instance.contactRatio = result.contactRatio;
      if (!result.supported) lost.push(instance.id);
    }
    return lost;
  }
}

export { StackingSystem };
