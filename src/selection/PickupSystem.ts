import type { BuildingInstance, PhysicsMode } from '../building/types';
import type { BuildingSystem } from '../building/BuildingSystem';
import { getBuildingDef } from '../data/buildingCatalog';
import type { VoxelGrid } from '../voxel/VoxelGrid';

/**
 * 拿起状态。
 *
 * 需求里的定义用的是 `string[]` 与 `Map<string, ...>`；
 * 本项目的实例 id 是**数字**（自增整数），所以这里用 number ——
 * 语义完全一致，只是省掉了无意义的字符串转换。这一点在 README 里也记了。
 */
export interface PickupState {
  /** 被拿起的物体 id */
  objectIds: number[];
  /** 是整块结构还是单个物体 */
  isWholeStructure: boolean;
  /** 拿起前的位置，用于"还原原位" */
  originalPositions: Map<number, [number, number, number]>;
  /** 拿起前的旋转，用于"还原原位" */
  originalRotations: Map<number, number>;
  /** 拿起前的物理模式，放回时恢复 */
  originalModes: Map<number, PhysicsMode>;
  /**
   * 拿起那一刻的光标位置。
   * 跟随的时候用的是"光标位移量"而不是"把物体中心对齐到光标"——
   * 后者会让物体在抓住的一瞬间跳一下（墙的中心跑到光标下面），非常难受。
   */
  cursorAnchor: [number, number, number];
}

export interface DropResult {
  ok: boolean;
  reason?: string;
  /** 放下后是否是悬空的（会变成动态刚体） */
  becameDynamic: boolean;
}

/** 微调轴 */
export type NudgeAxis = 'x' | 'y' | 'z';

/**
 * 拿起 / 放下 / 微调。
 *
 * 生命周期：
 *   拿起 → 记录原始位姿 → 刚体切成 kinematic（不受重力、但能推开别人）
 *        → 每帧跟随光标（或按键微调）
 *        → 放下：整体做一次放置校验，通过就转静态/动态；不通过就**自动还原**
 *
 * 为什么放下失败要自动还原而不是弹窗拒绝：
 * 玩家拖着一个沙发穿过墙的时候，松手的位置大概率是穿模的。
 * 直接退回原位比"卡在原地不让放"体验好得多，而且一定不会把世界搞坏。
 */
export class PickupSystem {
  private current: PickupState | null = null;

  get state(): PickupState | null {
    return this.current;
  }

  get isHolding(): boolean {
    return this.current !== null;
  }

  get heldCount(): number {
    return this.current?.objectIds.length ?? 0;
  }

  /**
   * 拿起。
   * @param wholeStructure 是否连同相连的整块结构一起拿起
   */
  pick(
    ids: readonly number[],
    wholeStructure: boolean,
    buildings: BuildingSystem,
    cursor: [number, number, number] = [0, 0, 0],
  ): PickupState | null {
    if (ids.length === 0) return null;
    if (this.current) this.release(buildings);

    const objectIds = wholeStructure
      ? [...new Set(ids.flatMap((id) => buildings.collectStructure(id)))]
      : [...ids];

    const originalPositions = new Map<number, [number, number, number]>();
    const originalRotations = new Map<number, number>();
    const originalModes = new Map<number, PhysicsMode>();

    for (const id of objectIds) {
      const instance = buildings.findById(id);
      if (!instance) continue;
      originalPositions.set(id, [...instance.position] as [number, number, number]);
      originalRotations.set(id, instance.rotationY);
      originalModes.set(id, instance.physicsMode ?? 'static');
      // 切成 kinematic：不会被重力拽走，但移动时会推开挡路的东西
      buildings.setPhysicsMode(id, 'kinematic');
    }

    const bounds = buildings.boundsOf(objectIds);
    void bounds;

    this.current = {
      objectIds,
      isWholeStructure: wholeStructure,
      originalPositions,
      originalRotations,
      originalModes,
      cursorAnchor: [...cursor] as [number, number, number],
    };

    return this.current;
  }

  /**
   * 每帧跟随光标。
   * 整体按"结构中心跟随光标"移动，单个物体保持拿起时的抓取偏移。
   */
  follow(cursor: [number, number, number], buildings: BuildingSystem): void {
    const state = this.current;
    if (!state) return;

    // 用"光标相对拿起点的位移"驱动，抓起来的一瞬间不会跳
    const delta: [number, number, number] = [
      cursor[0] - state.cursorAnchor[0],
      cursor[1] - state.cursorAnchor[1],
      cursor[2] - state.cursorAnchor[2],
    ];
    if (Math.abs(delta[0]) < 1e-4 && Math.abs(delta[1]) < 1e-4 && Math.abs(delta[2]) < 1e-4) return;

    buildings.moveMany(state.objectIds, delta, true);
    state.cursorAnchor = [...cursor] as [number, number, number];
  }

  /** 按键微调位置（拿起状态与静态选择都可用） */
  nudge(
    ids: readonly number[],
    axis: NudgeAxis,
    amount: number,
    buildings: BuildingSystem,
  ): void {
    const delta: [number, number, number] = [0, 0, 0];
    if (axis === 'x') delta[0] = amount;
    else if (axis === 'y') delta[1] = amount;
    else delta[2] = amount;
    buildings.moveMany(ids, delta, this.current !== null);
  }

  /** 微调旋转（绕 Y 轴） */
  rotate(
    ids: readonly number[],
    deltaDegrees: number,
    buildings: BuildingSystem,
    pivot?: [number, number, number],
  ): void {
    const radians = (deltaDegrees * Math.PI) / 180;
    const usePivot = pivot ?? buildings.boundsOf(ids);
    if (!usePivot) return;
    const center: [number, number, number] = Array.isArray(usePivot)
      ? usePivot
      : [
          (usePivot.minX + usePivot.maxX) / 2,
          (usePivot.minY + usePivot.maxY) / 2,
          (usePivot.minZ + usePivot.maxZ) / 2,
        ];
    buildings.rotateMany(ids, radians, center);
  }

  /**
   * 放下。
   * 对每个被拿起的物体做一次放置校验；只要有一个不合法就整体还原。
   */
  drop(buildings: BuildingSystem, grid: VoxelGrid, stackUnsupportedCheck: (instance: BuildingInstance) => boolean): DropResult {
    const state = this.current;
    if (!state) return { ok: false, reason: '手里没有东西', becameDynamic: false };

    // 1) 全部校验
    for (const id of state.objectIds) {
      const instance = buildings.findById(id);
      if (!instance) continue;
      const def = getBuildingDef(instance.defId);
      if (!def) continue;
      const check = buildings.checkPlacement(def, instance.position, instance.rotationY, grid, id);
      if (!check.valid) {
        this.restore(buildings);
        return {
          ok: false,
          reason: `放不下：${check.reason ?? '和已有物体冲突'}，已还原`,
          becameDynamic: false,
        };
      }
    }

    // 2) 校验通过 → 按是否有支撑决定静态还是动态
    let becameDynamic = false;
    for (const id of state.objectIds) {
      const instance = buildings.findById(id);
      if (!instance) continue;
      const unsupported = stackUnsupportedCheck(instance);
      const mode: PhysicsMode = unsupported && !instance.locked ? 'dynamic' : 'static';
      if (mode === 'dynamic') becameDynamic = true;
      buildings.setPhysicsMode(id, mode);
      buildings.syncToPhysics(id);
    }

    const held = state.objectIds.length;
    this.current = null;
    return { ok: true, becameDynamic, reason: `放下了 ${held} 个物体${becameDynamic ? '（悬空的会掉下来）' : ''}` };
  }

  /** 取消拿起，全部还原到原位 */
  cancel(buildings: BuildingSystem): void {
    this.restore(buildings);
  }

  private restore(buildings: BuildingSystem): void {
    const state = this.current;
    if (!state) return;
    for (const id of state.objectIds) {
      const position = state.originalPositions.get(id);
      const rotation = state.originalRotations.get(id);
      const mode = state.originalModes.get(id) ?? 'static';
      if (position && rotation !== undefined) buildings.setTransform(id, position, rotation);
      buildings.setPhysicsMode(id, mode);
    }
    this.current = null;
  }

  /** 释放引用（换世界 / 载入存档时），不做还原 */
  release(buildings: BuildingSystem): void {
    const state = this.current;
    if (!state) return;
    for (const id of state.objectIds) {
      const mode = state.originalModes.get(id) ?? 'static';
      buildings.setPhysicsMode(id, mode);
    }
    this.current = null;
  }
}
