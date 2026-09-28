import { getBuildingDef } from '../data/buildingCatalog';
import { AIR, isLiquid, isSolid } from '../data/voxelTypes';
import type { BuildingDef, BuildingInstance, MirrorAxis, PhysicsMode } from './types';
import type { VoxelGrid } from '../voxel/VoxelGrid';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { buildBodyGeometry, buildProbeBox } from '../physics/BodyFactory';

/** 放置检查结果 */
export interface PlacementCheck {
  valid: boolean;
  /** 不合法时的原因（UI 直接显示） */
  reason?: string;
  /** 自动贴地算出来的底面高度 */
  groundY: number;
}

/** 世界坐标轴对齐包围盒 */
export interface InstanceBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/**
 * 建筑实例管理。
 *
 * M2 起它同时是**物理世界与渲染世界之间的桥**：
 * - 每次 `add()` 顺手建一个 Rapier 刚体（复合碰撞体由 BodyFactory 从 parts 推导）；
 * - 每帧 `syncFromPhysics()` 把动态刚体的位姿写回实例（含翻滚姿态四元数）；
 * - `remove()` 释放刚体，避免物理世界里残留"幽灵碰撞体"。
 *
 * 为什么要拆成"数据 + 物理 + 渲染"三层：
 * 撤销重做、存档、支撑检查、蓝图导出都只关心纯数据，
 * 完全不需要知道世界上有没有物理引擎在跑 —— 物理没就绪时整套系统仍能工作（退化成静态摆放）。
 */
export class BuildingSystem {
  private readonly instances: BuildingInstance[] = [];
  private nextId = 1;

  private physics: PhysicsWorld | null = null;
  private terrainBodyHandle = -1;
  /** 刚体 handle → 实例，物理查询结果靠它反查 */
  private readonly byPhysicsHandle = new Map<number, BuildingInstance>();

  // ---------------------------------------------------------------- 物理接线

  /** 接上物理世界（换世界 / 载入存档后重新调用） */
  attachPhysics(physics: PhysicsWorld | null, terrainBodyHandle = -1): void {
    this.physics = physics;
    this.terrainBodyHandle = terrainBodyHandle;
  }

  get hasPhysics(): boolean {
    return this.physics !== null && this.physics.isReady;
  }

  get terrainHandle(): number {
    return this.terrainBodyHandle;
  }

  findByPhysicsHandle(handle: number): BuildingInstance | undefined {
    return this.byPhysicsHandle.get(handle);
  }

  // ---------------------------------------------------------------- 查询

  get all(): readonly BuildingInstance[] {
    return this.instances;
  }

  get count(): number {
    return this.instances.length;
  }

  get ids(): number[] {
    return this.instances.map((instance) => instance.id);
  }

  findById(id: number): BuildingInstance | undefined {
    return this.instances.find((instance) => instance.id === id);
  }

  findMany(ids: readonly number[]): BuildingInstance[] {
    const set = new Set(ids);
    return this.instances.filter((instance) => set.has(instance.id));
  }

  get dynamicCount(): number {
    let count = 0;
    for (const instance of this.instances) if (instance.physicsMode === 'dynamic') count++;
    return count;
  }

  // ---------------------------------------------------------------- 增删

  /**
   * 放置一个建筑。
   * @param mode 初始刚体模式：静态摆放用 'static'；悬空的用 'dynamic'（恢复播放后会掉）
   */
  add(
    defId: string,
    position: [number, number, number],
    rotationY = 0,
    scale = 1,
    mode: PhysicsMode = 'static',
  ): BuildingInstance | null {
    const def = getBuildingDef(defId);
    if (!def) return null;

    const instance: BuildingInstance = {
      id: this.nextId++,
      defId,
      position: [...position] as [number, number, number],
      rotationY,
      scale,
      isStatic: def.isStatic,
      physicsMode: mode,
      size: [...def.size] as [number, number, number],
      color: def.color,
      name: def.name,
    };

    this.createBodyFor(instance, mode);
    this.instances.push(instance);
    return instance;
  }

  /** 批量放置（参考地图 / 预制件 / 蓝图 / 存档） */
  addMany(
    placements: ReadonlyArray<{
      defId: string;
      position: [number, number, number];
      rotationY: number;
      scale?: number;
      mode?: PhysicsMode;
    }>,
  ): BuildingInstance[] {
    const created: BuildingInstance[] = [];
    for (const placement of placements) {
      const instance = this.add(
        placement.defId,
        placement.position,
        placement.rotationY,
        placement.scale ?? 1,
        placement.mode ?? 'static',
      );
      if (instance) created.push(instance);
    }
    return created;
  }

  remove(id: number): BuildingInstance | null {
    const index = this.instances.findIndex((instance) => instance.id === id);
    if (index < 0) return null;
    const [removed] = this.instances.splice(index, 1);
    if (removed) this.destroyBodyFor(removed);
    return removed ?? null;
  }

  removeMany(ids: readonly number[]): BuildingInstance[] {
    const removed: BuildingInstance[] = [];
    const set = new Set(ids);
    for (let i = this.instances.length - 1; i >= 0; i--) {
      const instance = this.instances[i]!;
      if (!set.has(instance.id)) continue;
      removed.push(instance);
      this.destroyBodyFor(instance);
      this.instances.splice(i, 1);
    }
    return removed;
  }

  /** 直接插入已存在的实例（撤销"删除"、载入存档时用，保留原 id） */
  restore(instances: readonly BuildingInstance[]): void {
    for (const instance of instances) {
      if (this.instances.some((existing) => existing.id === instance.id)) continue;
      this.instances.push(instance);
      if (instance.id >= this.nextId) this.nextId = instance.id + 1;
      // 从存档/撤销恢复时要重建刚体（原刚体可能已被释放）
      if ((instance.physicsHandle ?? -1) < 0) {
        this.createBodyFor(instance, instance.physicsMode ?? 'static');
      }
    }
  }

  clear(): void {
    for (const instance of this.instances) this.destroyBodyFor(instance);
    this.instances.length = 0;
    this.byPhysicsHandle.clear();
    this.nextId = 1;
  }

  // ---------------------------------------------------------------- 刚体

  private createBodyFor(instance: BuildingInstance, mode: PhysicsMode): void {
    const physics = this.physics;
    const def = getBuildingDef(instance.defId);
    if (!physics || !physics.isReady || !def) {
      instance.physicsHandle = -1;
      return;
    }
    const geometry = buildBodyGeometry(def);
    const handle = physics.createBody(
      {
        mode,
        position: instance.position,
        rotationY: instance.rotationY,
        colliders: geometry.colliders,
        density: densityFromMass(def, geometry.colliders.length),
        friction: def.friction,
        restitution: def.restitution,
      },
      instance.id,
    );
    instance.physicsHandle = handle;
    instance.physicsMode = mode;
    if (handle >= 0) this.byPhysicsHandle.set(handle, instance);
  }

  private destroyBodyFor(instance: BuildingInstance): void {
    const handle = instance.physicsHandle ?? -1;
    if (handle < 0) return;
    this.byPhysicsHandle.delete(handle);
    this.physics?.removeBody(handle);
    instance.physicsHandle = -1;
  }

  /** 为所有还没有刚体的实例补建刚体（物理异步就绪后调用） */
  ensureBodies(): void {
    if (!this.hasPhysics) return;
    for (const instance of this.instances) {
      if ((instance.physicsHandle ?? -1) >= 0) continue;
      this.createBodyFor(instance, instance.physicsMode ?? 'static');
    }
  }

  setPhysicsMode(id: number, mode: PhysicsMode): boolean {
    const instance = this.findById(id);
    if (!instance) return false;
    instance.physicsMode = mode;
    const handle = instance.physicsHandle ?? -1;
    if (handle >= 0) this.physics?.setMode(handle, mode);
    return true;
  }

  setLocked(id: number, locked: boolean): boolean {
    const instance = this.findById(id);
    if (!instance) return false;
    instance.locked = locked;
    return true;
  }

  /** 把实例的位姿推给物理刚体（微调/放下时用，方向是"数据 → 物理"） */
  syncToPhysics(id: number): boolean {
    const instance = this.findById(id);
    if (!instance) return false;
    const handle = instance.physicsHandle ?? -1;
    if (handle < 0) return false;
    this.physics?.setPose(handle, instance.position, instance.rotationY);
    this.physics?.zeroVelocity(handle);
    return true;
  }

  /** 把动态刚体的位姿写回实例；返回本帧移动过的物体数 */
  syncFromPhysics(): number {
    const physics = this.physics;
    if (!physics || !physics.isReady) return 0;
    let moved = 0;
    for (const instance of this.instances) {
      if (instance.physicsMode !== 'dynamic') continue;
      const handle = instance.physicsHandle ?? -1;
      if (handle < 0) continue;
      const pose = physics.readPose(handle);
      if (!pose) continue;

      const dx = pose.x - instance.position[0];
      const dy = pose.y - instance.position[1];
      const dz = pose.z - instance.position[2];
      const previous = instance.quaternion;
      const dq =
        Math.abs(pose.qx - (previous?.[0] ?? 0)) +
        Math.abs(pose.qy - (previous?.[1] ?? 0)) +
        Math.abs(pose.qz - (previous?.[2] ?? 0)) +
        Math.abs(pose.qw - (previous?.[3] ?? 1));
      // 位置与姿态都没怎么变就不算"移动"，省掉渲染器的重算
      if (dx * dx + dy * dy + dz * dz < 1e-8 && dq < 1e-6) continue;

      instance.position = [pose.x, pose.y, pose.z];
      instance.quaternion = [pose.qx, pose.qy, pose.qz, pose.qw];
      instance.rotationY = yawFromQuaternion(pose.qx, pose.qy, pose.qz, pose.qw);
      moved++;
    }
    return moved;
  }

  // ---------------------------------------------------------------- 变换

  /** 直接设置位姿（微调、拿起跟随时用） */
  setTransform(
    id: number,
    position: [number, number, number],
    rotationY: number,
    kinematic = false,
  ): boolean {
    const instance = this.findById(id);
    if (!instance) return false;
    instance.position = [...position] as [number, number, number];
    instance.rotationY = rotationY;
    instance.quaternion = undefined;
    const handle = instance.physicsHandle ?? -1;
    if (handle >= 0) this.physics?.setPose(handle, instance.position, rotationY, kinematic);
    return true;
  }

  move(id: number, position: [number, number, number]): boolean {
    const instance = this.findById(id);
    if (!instance) return false;
    return this.setTransform(id, position, instance.rotationY);
  }

  rotate(id: number, deltaRadians: number): boolean {
    const instance = this.findById(id);
    if (!instance) return false;
    return this.setTransform(id, instance.position, normalizeAngle(instance.rotationY + deltaRadians));
  }

  /** 批量平移（拿起整结构时用） */
  moveMany(ids: readonly number[], delta: [number, number, number], kinematic = false): void {
    for (const id of ids) {
      const instance = this.findById(id);
      if (!instance) continue;
      const next: [number, number, number] = [
        instance.position[0] + delta[0],
        instance.position[1] + delta[1],
        instance.position[2] + delta[2],
      ];
      this.setTransform(id, next, instance.rotationY, kinematic);
    }
  }

  /** 批量旋转（绕整组中心） */
  rotateMany(ids: readonly number[], deltaRadians: number, pivot: [number, number, number]): void {
    const cos = Math.cos(deltaRadians);
    const sin = Math.sin(deltaRadians);
    for (const id of ids) {
      const instance = this.findById(id);
      if (!instance) continue;
      const dx = instance.position[0] - pivot[0];
      const dz = instance.position[2] - pivot[2];
      const next: [number, number, number] = [
        pivot[0] + dx * cos - dz * sin,
        instance.position[1],
        pivot[2] + dx * sin + dz * cos,
      ];
      this.setTransform(id, next, normalizeAngle(instance.rotationY + deltaRadians));
    }
  }

  // ---------------------------------------------------------------- 包围盒与拾取

  /**
   * 找出与给定实例"相连"的整块结构（传递闭包）。
   * 判定标准：包围盒在 touchDistance 米内相接就算相连。
   * 这是"拿起整结构"的基础 —— 玩家不需要预先分组，随手点一块墙就能把整间屋子搬走。
   */
  collectStructure(seedId: number, touchDistance = 0.6, maxSize = 500): number[] {
    const seed = this.findById(seedId);
    if (!seed) return [];

    const result: number[] = [seed.id];
    const visited = new Set<number>([seed.id]);
    const queue: BuildingInstance[] = [seed];

    while (queue.length > 0 && result.length < maxSize) {
      const current = queue.shift()!;
      const currentBox = instanceBounds(current);
      for (const other of this.instances) {
        if (visited.has(other.id)) continue;
        const box = instanceBounds(other);
        const gapX = Math.max(0, Math.max(currentBox.minX - box.maxX, box.minX - currentBox.maxX));
        const gapY = Math.max(0, Math.max(currentBox.minY - box.maxY, box.minY - currentBox.maxY));
        const gapZ = Math.max(0, Math.max(currentBox.minZ - box.maxZ, box.minZ - currentBox.maxZ));
        if (gapX > touchDistance || gapY > touchDistance || gapZ > touchDistance) continue;
        visited.add(other.id);
        result.push(other.id);
        queue.push(other);
      }
    }
    return result;
  }

  boundsOf(ids: readonly number[]): InstanceBounds | null {
    let result: InstanceBounds | null = null;
    for (const instance of this.findMany(ids)) {
      const box = instanceBounds(instance);
      if (!result) {
        result = { ...box };
        continue;
      }
      result.minX = Math.min(result.minX, box.minX);
      result.maxX = Math.max(result.maxX, box.maxX);
      result.minY = Math.min(result.minY, box.minY);
      result.maxY = Math.max(result.maxY, box.maxY);
      result.minZ = Math.min(result.minZ, box.minZ);
      result.maxZ = Math.max(result.maxZ, box.maxZ);
    }
    return result;
  }

  pickAt(worldX: number, worldY: number, worldZ: number): BuildingInstance | null {
    for (let i = this.instances.length - 1; i >= 0; i--) {
      const instance = this.instances[i]!;
      if (containsPoint(instance, worldX, worldY, worldZ)) return instance;
    }
    return null;
  }

  pickInBox(min: [number, number, number], max: [number, number, number]): BuildingInstance[] {
    const result: BuildingInstance[] = [];
    for (const instance of this.instances) {
      const box = instanceBounds(instance);
      if (box.maxX < min[0] || box.minX > max[0]) continue;
      if (box.maxY < min[1] || box.minY > max[1]) continue;
      if (box.maxZ < min[2] || box.minZ > max[2]) continue;
      result.push(instance);
    }
    return result;
  }

  pickInSphere(
    centerX: number,
    centerY: number,
    centerZ: number,
    radius: number,
  ): BuildingInstance[] {
    const result: BuildingInstance[] = [];
    const r2 = radius * radius;
    for (const instance of this.instances) {
      const box = instanceBounds(instance);
      const closestX = Math.max(box.minX, Math.min(centerX, box.maxX));
      const closestY = Math.max(box.minY, Math.min(centerY, box.maxY));
      const closestZ = Math.max(box.minZ, Math.min(centerZ, box.maxZ));
      const dx = closestX - centerX;
      const dy = closestY - centerY;
      const dz = closestZ - centerZ;
      if (dx * dx + dy * dy + dz * dz <= r2) result.push(instance);
    }
    return result;
  }

  // ---------------------------------------------------------------- 放置检查

  /**
   * 检查某个位置能不能放。
   *
   * 顺序很关键：先做便宜的包围盒判断，再做贵的地形体素采样，
   * 最后才交给物理引擎做重叠查询 —— 这样拖拽预览时不必每帧跑满三种检查。
   */
  checkPlacement(
    def: BuildingDef,
    position: [number, number, number],
    rotationY: number,
    grid: VoxelGrid,
    excludeInstanceId?: number,
  ): PlacementCheck {
    const groundY = this.groundYAt(def, position[0], position[2], rotationY, grid);
    const bounds = rotatedBounds(def, position, rotationY);

    if (
      bounds.minX < -grid.halfX ||
      bounds.maxX > grid.halfX ||
      bounds.minZ < -grid.halfZ ||
      bounds.maxZ > grid.halfZ
    ) {
      return { valid: false, reason: '超出世界边界', groundY };
    }
    if (bounds.minY < -0.5 || bounds.maxY > grid.sizeY) {
      return { valid: false, reason: '超出世界高度', groundY };
    }

    // 和地形穿插
    const vx0 = grid.worldToVoxelX(bounds.minX);
    const vx1 = grid.worldToVoxelX(bounds.maxX);
    const vz0 = grid.worldToVoxelZ(bounds.minZ);
    const vz1 = grid.worldToVoxelZ(bounds.maxZ);
    const y0 = Math.max(0, Math.floor(bounds.minY));
    const y1 = Math.min(grid.sizeY - 1, Math.ceil(bounds.maxY));
    for (let y = y0; y <= y1; y++) {
      for (let vz = vz0; vz <= vz1; vz++) {
        for (let vx = vx0; vx <= vx1; vx++) {
          if (!grid.inBounds(vx, y, vz)) continue;
          const id = grid.getVoxel(vx, y, vz);
          if (id !== AIR && isSolid(id) && !isLiquid(id)) {
            return { valid: false, reason: '和地形穿插', groundY };
          }
        }
      }
    }

    // 和已有建筑重叠：有物理就用物理查询（更精确），否则退化到 AABB
    const physics = this.physics;
    if (physics && physics.isReady) {
      const probe = buildProbeBox(def, rotationY);
      const excludeHandle =
        excludeInstanceId !== undefined
          ? (this.findById(excludeInstanceId)?.physicsHandle ?? -1)
          : -1;
      const overlaps = physics.overlapBox(
        probe.halfExtents,
        [position[0], position[1] + probe.center[1], position[2]],
        rotationY,
        excludeHandle,
      );
      const blocking = overlaps.filter((handle) => handle !== this.terrainBodyHandle);
      if (blocking.length > 0) {
        const other = this.byPhysicsHandle.get(blocking[0]!);
        return {
          valid: false,
          reason: other ? `和 ${other.name ?? other.defId} 重叠` : '和已有物体重叠',
          groundY,
        };
      }
    } else {
      for (const instance of this.instances) {
        if (excludeInstanceId !== undefined && instance.id === excludeInstanceId) continue;
        const box = instanceBounds(instance);
        const overlapX = Math.min(bounds.maxX, box.maxX) - Math.max(bounds.minX, box.minX);
        const overlapY = Math.min(bounds.maxY, box.maxY) - Math.max(bounds.minY, box.minY);
        const overlapZ = Math.min(bounds.maxZ, box.maxZ) - Math.max(bounds.minZ, box.minZ);
        if (overlapX > 0.05 && overlapY > 0.05 && overlapZ > 0.05) {
          return { valid: false, reason: '和已有建筑重叠', groundY };
        }
      }
    }

    return { valid: true, groundY };
  }

  /** 在足迹范围内找最高的实心地表，返回其顶面高度（建筑底面应该放这里） */
  groundYAt(
    def: BuildingDef,
    centerX: number,
    centerZ: number,
    rotationY: number,
    grid: VoxelGrid,
  ): number {
    const cos = Math.abs(Math.cos(rotationY));
    const sin = Math.abs(Math.sin(rotationY));
    const halfW = (def.size[0] * cos + def.size[2] * sin) / 2;
    const halfD = (def.size[0] * sin + def.size[2] * cos) / 2;

    const vx0 = grid.worldToVoxelX(centerX - halfW);
    const vx1 = grid.worldToVoxelX(centerX + halfW);
    const vz0 = grid.worldToVoxelZ(centerZ - halfD);
    const vz1 = grid.worldToVoxelZ(centerZ + halfD);

    let best = 0;
    let found = false;
    for (let vz = vz0; vz <= vz1; vz++) {
      for (let vx = vx0; vx <= vx1; vx++) {
        if (!grid.inHorizontalBounds(vx, vz)) continue;
        const top = grid.solidSurfaceHeight(vx, vz);
        if (top < 0) continue;
        if (!found || top + 1 > best) {
          best = top + 1;
          found = true;
        }
      }
    }
    return found ? best : 0;
  }

  // ---------------------------------------------------------------- 存档

  toSaveData(): Array<{
    id: number;
    defId: string;
    position: [number, number, number];
    rotationY: number;
    scale: number;
    isStatic: boolean;
    physicsMode: PhysicsMode;
    groupId?: string;
    mirror?: MirrorAxis;
  }> {
    return this.instances.map((instance) => ({
      id: instance.id,
      defId: instance.defId,
      position: [...instance.position] as [number, number, number],
      rotationY: instance.rotationY,
      scale: instance.scale,
      isStatic: instance.isStatic,
      physicsMode: instance.physicsMode ?? 'static',
      groupId: instance.groupId,
      mirror: instance.mirror,
    }));
  }
}

// ---------------------------------------------------------------- 工具函数

/** 由质量与碰撞体数量反推密度（kg/m³）。Rapier 按密度算质量，所以要折一下 */
function densityFromMass(def: BuildingDef, colliderCount: number): number {
  const volume = Math.max(0.05, def.size[0] * def.size[1] * def.size[2]);
  const density = def.mass / volume;
  // 复合碰撞体的总体积小于外包围盒，乘个系数避免质量偏小
  return Math.max(50, Math.min(20000, density * Math.max(1, colliderCount * 0.35)));
}

/** 从四元数取偏航角（UI 显示与静态摆放用；动态翻滚时姿态以四元数为准） */
export function yawFromQuaternion(qx: number, qy: number, qz: number, qw: number): number {
  const siny = 2 * (qw * qy + qx * qz);
  const cosy = 1 - 2 * (qy * qy + qx * qx);
  return Math.atan2(siny, cosy);
}

export function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let value = angle % twoPi;
  if (value < 0) value += twoPi;
  return value;
}

/** 考虑 rotationY 的轴对齐包围盒 */
export function instanceBounds(instance: BuildingInstance): InstanceBounds {
  const size = instance.size ?? [1, 1, 1];
  const scale = instance.scale ?? 1;
  const halfW = (size[0] * scale) / 2;
  const halfD = (size[2] * scale) / 2;
  const cos = Math.abs(Math.cos(instance.rotationY));
  const sin = Math.abs(Math.sin(instance.rotationY));
  const extentX = halfW * cos + halfD * sin;
  const extentZ = halfW * sin + halfD * cos;
  return {
    minX: instance.position[0] - extentX,
    maxX: instance.position[0] + extentX,
    minY: instance.position[1],
    maxY: instance.position[1] + size[1] * scale,
    minZ: instance.position[2] - extentZ,
    maxZ: instance.position[2] + extentZ,
  };
}

/** 用"旋转回局部空间"的方式做点与建筑的精确相交测试 */
export function containsPoint(
  instance: BuildingInstance,
  worldX: number,
  worldY: number,
  worldZ: number,
): boolean {
  const size = instance.size ?? [1, 1, 1];
  const scale = instance.scale ?? 1;
  const dx = worldX - instance.position[0];
  const dz = worldZ - instance.position[2];
  const cos = Math.cos(-instance.rotationY);
  const sin = Math.sin(-instance.rotationY);
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;
  const localY = worldY - instance.position[1];

  return (
    Math.abs(localX) <= (size[0] * scale) / 2 &&
    Math.abs(localZ) <= (size[2] * scale) / 2 &&
    localY >= 0 &&
    localY <= size[1] * scale
  );
}

/** 旋转后的包围盒（放置检查用） */
export function rotatedBounds(
  def: BuildingDef,
  position: [number, number, number],
  rotationY: number,
): InstanceBounds {
  const halfW = def.size[0] / 2;
  const halfD = def.size[2] / 2;
  const cos = Math.abs(Math.cos(rotationY));
  const sin = Math.abs(Math.sin(rotationY));
  const extentX = halfW * cos + halfD * sin;
  const extentZ = halfW * sin + halfD * cos;
  return {
    minX: position[0] - extentX,
    maxX: position[0] + extentX,
    minY: position[1],
    maxY: position[1] + def.size[1],
    minZ: position[2] - extentZ,
    maxZ: position[2] + extentZ,
  };
}
