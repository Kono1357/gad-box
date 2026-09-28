import type { PerspectiveCamera } from 'three';
import { Vector3 } from 'three';
import type { BuildingSystem } from '../building/BuildingSystem';
import { instanceBounds } from '../building/BuildingSystem';

/** 屏幕矩形（NDC 坐标，左下 -1 右上 1） */
export interface ScreenRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 连接分组的 BFS 最大规模，防止"拿起整结构"时把半个世界带走 */
const MAX_STRUCTURE_SIZE = 500;

/**
 * 选择系统。
 *
 * 只管"哪些物体被选中"，不管渲染 —— 高亮由 BuildingRenderer 用**一个合并的
 * LineSegments** 画出来（500 个选择框 = 1 次 draw call），
 * 所以选择数量对帧率几乎没有影响。
 *
 * 支持四种选择方式：
 * - 点击（单选 / Ctrl 加选 / Ctrl 点已选则取消）
 * - 框选（屏幕矩形投影判交，O(n) 但只遍历一次实例中心）
 * - 全选 / 清空
 * - 同类选择（把世界里的同款模型一次选中，方便批量改）
 */
export class SelectionSystem {
  private readonly selected = new Set<number>();
  private hoveredId: number | null = null;
  /** 选择发生变化时置位，渲染层据此重建高亮几何体 */
  private revision = 0;

  get ids(): number[] {
    return [...this.selected];
  }

  get count(): number {
    return this.selected.size;
  }

  get version(): number {
    return this.revision;
  }

  get hovered(): number | null {
    return this.hoveredId;
  }

  isSelected(id: number): boolean {
    return this.selected.has(id);
  }

  setHovered(id: number | null): void {
    if (this.hoveredId === id) return;
    this.hoveredId = id;
    this.revision++;
  }

  set(ids: readonly number[]): void {
    this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.revision++;
  }

  add(id: number): void {
    if (this.selected.has(id)) return;
    this.selected.add(id);
    this.revision++;
  }

  remove(id: number): void {
    if (!this.selected.delete(id)) return;
    this.revision++;
  }

  toggle(id: number): void {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.revision++;
  }

  clear(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.revision++;
  }

  selectAll(buildings: BuildingSystem): void {
    this.set(buildings.ids);
  }

  /** 选中世界里所有同款模型 */
  selectSimilar(buildings: BuildingSystem, defId: string): void {
    this.set(buildings.all.filter((instance) => instance.defId === defId).map((instance) => instance.id));
  }

  selectInBox(min: [number, number, number], max: [number, number, number], buildings: BuildingSystem): void {
    this.set(buildings.pickInBox(min, max).map((instance) => instance.id));
  }

  /**
   * 框选：把每个实例的包围盒角点投到屏幕，只要有一个角点落在矩形内就命中。
   * 用"角点"而不是"中心"，否则大件物体（巴士、起重机）很难框住。
   */
  selectInScreenRect(
    rect: ScreenRect,
    camera: PerspectiveCamera,
    buildings: BuildingSystem,
    additive = false,
  ): void {
    const point = new Vector3();
    const hits: number[] = [];

    for (const instance of buildings.all) {
      const box = instanceBounds(instance);
      const corners: Array<[number, number, number]> = [
        [box.minX, box.minY, box.minZ],
        [box.maxX, box.minY, box.minZ],
        [box.minX, box.maxY, box.minZ],
        [box.maxX, box.maxY, box.minZ],
        [box.minX, box.minY, box.maxZ],
        [box.maxX, box.minY, box.maxZ],
        [box.minX, box.maxY, box.maxZ],
        [box.maxX, box.maxY, box.maxZ],
      ];

      let hit = false;
      for (const corner of corners) {
        point.set(corner[0], corner[1], corner[2]).project(camera);
        if (point.z < -1 || point.z > 1) continue;
        if (point.x >= rect.minX && point.x <= rect.maxX && point.y >= rect.minY && point.y <= rect.maxY) {
          hit = true;
          break;
        }
      }
      if (hit) hits.push(instance.id);
    }

    if (additive) {
      for (const id of hits) this.selected.add(id);
      this.revision++;
    } else {
      this.set(hits);
    }
  }

  /**
   * 找出与给定实例"相连"的整块结构。
   * 判定方式：包围盒在 0.6 米内相接就算相连，然后传递闭包。
   * 这是"拿起整结构"的基础 —— 不需要玩家自己先分组。
   */
  collectStructure(seedId: number, buildings: BuildingSystem, touchDistance = 0.6): number[] {
    // 实现放在 BuildingSystem 里（PickupSystem 也要用），这里只做转发
    return buildings.collectStructure(seedId, touchDistance, MAX_STRUCTURE_SIZE);
  }

  /** 选中物体的整体中心（旋转、镜像时当支点用） */
  pivot(buildings: BuildingSystem): [number, number, number] {
    const boxes = buildings.boundsOf(this.ids);
    if (!boxes) return [0, 0, 0];
    return [
      (boxes.minX + boxes.maxX) / 2,
      (boxes.minY + boxes.maxY) / 2,
      (boxes.minZ + boxes.maxZ) / 2,
    ];
  }

  /** 选中的物体里有没有动态刚体（UI 上给个提示） */
  hasDynamic(buildings: BuildingSystem): boolean {
    for (const id of this.selected) {
      if (buildings.findById(id)?.physicsMode === 'dynamic') return true;
    }
    return false;
  }
}
