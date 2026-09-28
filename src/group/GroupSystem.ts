import type { BuildingSystem } from '../building/BuildingSystem';
import type { BuildingInstance, Group } from '../building/types';

/**
 * 分组系统。
 *
 * 分组是**软分组**：只记录"哪些实例属于同一组"，不改变实例本身的任何行为。
 * 好处是随时可以散、可以嵌套、载入存档后也不会因为组数据出问题而丢物体。
 *
 * 与"拿起整结构"的区别：
 * - 整结构是**临时**的连通性推断（BFS 找挨着的物体），不需要玩家预先操作；
 * - 分组是**持久**的玩家意图，可以跨世界保存、可以命名、可以嵌套。
 * 两者互补：分组用于"这是我的一套房子"，整结构用于"顺手把这一坨搬走"。
 */
export class GroupSystem {
  private readonly groups = new Map<string, Group>();
  private nextId = 1;

  constructor(private readonly buildings: BuildingSystem) {}

  get all(): Group[] {
    return [...this.groups.values()];
  }

  get count(): number {
    return this.groups.size;
  }

  get(groupId: string): Group | undefined {
    return this.groups.get(groupId);
  }

  /**
   * 把一组物体打成组。
   * @returns 新建的组；成员少于 2 个时返回 null（一个物体的"组"没有意义）
   */
  create(name: string, objectIds: readonly number[], parentGroupId?: string): Group | null {
    const members = [...new Set(objectIds)].filter((id) => this.buildings.findById(id) !== undefined);
    if (members.length < 2) return null;

    const group: Group = {
      id: `g${this.nextId++}`,
      name: name.trim() || `分组 ${this.groups.size + 1}`,
      objectIds: members,
      parentGroupId,
    };
    this.groups.set(group.id, group);

    for (const id of members) {
      const instance = this.buildings.findById(id);
      if (instance) instance.groupId = group.id;
    }
    return group;
  }

  /** 解散组（只解散，不删除物体） */
  ungroup(groupId: string): number[] {
    const group = this.groups.get(groupId);
    if (!group) return [];
    for (const id of group.objectIds) {
      const instance = this.buildings.findById(id);
      if (instance && instance.groupId === groupId) instance.groupId = undefined;
    }
    this.groups.delete(groupId);
    return group.objectIds;
  }

  /** 解散包含某物体的组（玩家点"解散"时不知道组 id 的兜底入口） */
  ungroupByObject(objectId: number): number[] {
    const group = this.ofObject(objectId);
    return group ? this.ungroup(group.id) : [];
  }

  rename(groupId: string, name: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    group.name = name.trim() || group.name;
    return true;
  }

  ofObject(objectId: number): Group | undefined {
    const instance = this.buildings.findById(objectId);
    if (!instance?.groupId) return undefined;
    return this.groups.get(instance.groupId);
  }

  /** 组里的成员（过滤掉已经被删掉的） */
  members(groupId: string): BuildingInstance[] {
    const group = this.groups.get(groupId);
    if (!group) return [];
    return this.buildings.findMany(group.objectIds);
  }

  /** 从某个组里移除一个物体（删除物体时调用，避免组里留下幽灵 id） */
  detach(objectId: number): void {
    const group = this.ofObject(objectId);
    if (!group) return;
    group.objectIds = group.objectIds.filter((id) => id !== objectId);
    if (group.objectIds.length < 2) this.ungroup(group.id);
  }

  /** 清理：把已经不存在于世界里的 id 从所有组里剔掉 */
  prune(): void {
    for (const group of [...this.groups.values()]) {
      group.objectIds = group.objectIds.filter((id) => this.buildings.findById(id) !== undefined);
      if (group.objectIds.length < 2) this.ungroup(group.id);
    }
  }

  clear(): void {
    for (const group of this.groups.values()) {
      for (const id of group.objectIds) {
        const instance = this.buildings.findById(id);
        if (instance) instance.groupId = undefined;
      }
    }
    this.groups.clear();
    this.nextId = 1;
  }

  toSaveData(): Group[] {
    return this.all.map((group) => ({ ...group, objectIds: [...group.objectIds] }));
  }

  restore(groups: readonly Group[], idRemap?: Map<number, number>): void {
    this.groups.clear();
    this.nextId = 1;
    for (const group of groups) {
      if (!group || typeof group.id !== 'string') continue;
      const objectIds = (group.objectIds ?? [])
        .map((id) => idRemap?.get(id) ?? id)
        .filter((id) => this.buildings.findById(id) !== undefined);
      if (objectIds.length < 2) continue;
      const restored: Group = {
        id: group.id,
        name: group.name || `分组 ${this.groups.size + 1}`,
        objectIds,
        parentGroupId: group.parentGroupId,
      };
      this.groups.set(restored.id, restored);
      for (const id of objectIds) {
        const instance = this.buildings.findById(id);
        if (instance) instance.groupId = restored.id;
      }
      const numeric = Number(restored.id.replace(/^g/, ''));
      if (Number.isFinite(numeric) && numeric >= this.nextId) this.nextId = numeric + 1;
    }
  }
}
