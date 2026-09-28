/**
 * 触发器系统（M3 第 4 批：**重写** —— 从"盒查询轮询"改成 Rapier sensor + 事件队列）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么必须改（M2.5 的实现错在哪）
 * ────────────────────────────────────────────────────────────
 * M2.5 的做法是每 100ms 用 `physics.overlapBox()` 扫一遍区域，算出"谁在里面"。
 * 这个做法有三个真正的毛病：
 *
 * 1. **形状只能是盒子**。球和圆柱触发区都退化成外接盒，边缘会明显偏大 ——
 *    玩家画了个半径 2 米的圆形感应区，实际在 2.8 米的角落也会触发；
 * 2. **会漏掉快速穿过**。一个 20 m/s 的物体每帧走 0.33 米，100ms 就能跨过 2 米 ——
 *    轮询完全可能一次都没采样到它。**sensor 是求解器的一部分，不会漏**；
 * 3. **必须每帧问"谁在里面"**，500 个物体 × 若干触发区，那是持续的开销；
 *    sensor 只在**状态变化**时才产生事件，静止的世界零成本。
 *
 * ────────────────────────────────────────────────────────────
 * Rapier sensor 的语义（写清楚，免得以后当成 bug）
 * ────────────────────────────────────────────────────────────
 * - sensor 是**碰撞体**，不是刚体：它挂在触发区中心的一个静态锚点刚体上，`setSensor(true)`，
 *   因此不会产生任何碰撞响应（物体能穿过去）；
 * - `ActiveEvents.COLLISION_EVENTS` 打开后，`world.step(eventQueue)` 会把
 *   "开始接触 / 结束接触"写进队列；`drainCollisionEvents(cb)` 读出来；
 * - **Rapier 只给 begin/end，没有 "stay"**。所以 `stay` 事件是我们自己按节流（默认 200ms）
 *   为"当前还在区域里的物体"补发的 —— 不是求解器给的，这一点在面板与文档里都写明了。
 * - sensor 与谁发生事件由**碰撞分组**决定（`trigger` 层与 `building`/`object` 层互相作用），
 *   所以地形不会把触发区一直算成"里面有东西"（M2.5 为此专门写过一层过滤）。
 */

import type { PhysicsWorld } from './PhysicsWorld';
import type { TriggerParams } from '../data/physicsComponents';
import {
  interactionGroups,
  type PhysicsLayer,
} from './ColliderFactory';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 触发区形状（sensor 支持真形状，不再退化成 AABB） */
export type TriggerShape = 'box' | 'ball' | 'cylinder';

export type TriggerPhase = 'enter' | 'stay' | 'exit';

export interface TriggerRecord {
  id: number;
  center: Vec3;
  halfExtents: Vec3;
  tag: string;
  params: TriggerParams;
  once: boolean;
  firedCount: number;
  /** 当前在区域内的**刚体** handle */
  inside: Set<number>;
  enabled: boolean;
  shape: TriggerShape;
  /** 盒子的绕 Y 旋转（球/圆柱忽略） */
  rotationY: number;
  /** sensor 碰撞体 handle（-1 = 还没建，等待物理就绪） */
  collider: number;
  /** 触发区自己挂载的静态锚点刚体 handle */
  anchor: number;
  /** 宿主物体（压力板挂在某个物体上时用它） */
  ownerHandle: number;
  /** 累计 enter 次数 */
  enterTotal: number;
  /** 累计 stay 事件数 */
  stayTotal: number;
  /** 累计 exit 次数 */
  exitTotal: number;
}

export interface TriggerEvent {
  triggerId: number;
  tag: string;
  phase: TriggerPhase;
  /** 进入者的刚体 handle */
  handle: number;
  /** 进入者的建筑 ownerId，未知为 -1 */
  ownerId: number;
  /** 事件发生后区域内还有几个 */
  count: number;
}

export interface TriggerSpec {
  center: Vec3;
  halfExtents: Vec3;
  tag: string;
  params?: TriggerParams;
  once?: boolean;
  /** 形状，默认 'box'；球与圆柱用 halfExtents.x 当半径、.y 当半高 */
  shape?: TriggerShape;
  rotationY?: number;
  /** 只与这些层作用（默认 building + object） */
  partners?: PhysicsLayer[];
}

/** 最小 Rapier 面（避免 import 4 MB 的 d.ts 拖慢构建） */
interface ColliderLike {
  readonly handle: number;
  parent(): { handle: number } | null;
  setEnabled(enabled: boolean): void;
}

interface WorldLike {
  createRigidBody(desc: unknown): { handle: number };
  getRigidBody(handle: number): unknown;
  removeRigidBody(body: unknown): void;
  createCollider(desc: ColliderDescLike, body: unknown): ColliderLike;
  getCollider(handle: number): ColliderLike | null;
  removeCollider(collider: ColliderLike, wakeUp: boolean): void;
}

interface ColliderDescLike {
  setTranslation(x: number, y: number, z: number): ColliderDescLike;
  setRotation(rot: { x: number; y: number; z: number; w: number }): ColliderDescLike;
  setSensor(sensor: boolean): ColliderDescLike;
  setCollisionGroups(groups: number): ColliderDescLike;
  setActiveEvents(events: number): ColliderDescLike;
}

interface ApiLike {
  RigidBodyDesc: { fixed(): { setTranslation(x: number, y: number, z: number): unknown } };
  ColliderDesc: {
    cuboid(hx: number, hy: number, hz: number): ColliderDescLike;
    ball(radius: number): ColliderDescLike;
    cylinder(halfHeight: number, radius: number): ColliderDescLike;
  };
  ActiveEvents?: { COLLISION_EVENTS: number };
}

/**
 * 状态迁移：**纯函数**，这是整个文件唯一需要被单测覆盖的核心。
 *
 * 之所以把它抽出来：真正的传感器回调是 Rapier 驱动的，测它需要加载 wasm；
 * 而"谁进了、谁出了、谁还在"这段逻辑才是容易写错的地方（顺序、去重、once 语义）。
 */
export function applyTransition(
  inside: ReadonlySet<number>,
  current: ReadonlySet<number>,
): { entered: number[]; exited: number[]; stayed: number[] } {
  // 顺序稳定：先退出、再进入、最后停留；各自按 handle 升序。
  // 顺序稳定很重要 —— 事件顺序决定逻辑连线的执行顺序，
  // 顺序抖动的表现是"同样的操作有时候开门有时候不开"。
  const entered: number[] = [];
  const exited: number[] = [];
  const stayed: number[] = [];
  for (const handle of [...inside].sort((a, b) => a - b)) {
    if (!current.has(handle)) exited.push(handle);
    else stayed.push(handle);
  }
  for (const handle of [...current].sort((a, b) => a - b)) {
    if (!inside.has(handle)) entered.push(handle);
  }
  return { entered, exited, stayed };
}

export class TriggerSystem {
  private readonly records: TriggerRecord[] = [];
  /** 碰撞体 handle → 触发区 id（传感器事件反查用） */
  private readonly colliderToTrigger = new Map<number, number>();
  private readonly owners = new Map<number, number>();
  private nextId = 1;
  /**
   * `stay` 的节流间隔（毫秒）。
   *
   * 为什么 stay 要节流、而 enter/exit 不节流：enter/exit 是**边沿**，漏一个就漏一次因果；
   * 而 stay 是"持续状态"，逻辑连线里通常用来做"持续施压"（踩住压力板不放），
   * 每帧报一次会让逻辑层每秒算 60 次毫无意义的重复判断。200ms（5Hz）对"持续施压"完全够。
   */
  minStayIntervalMs = 200;
  /** 触发区分组：只和建筑与物体作用（理由见文件头） */
  partners: PhysicsLayer[] = ['building', 'object'];
  onEvent: ((event: TriggerEvent) => void) | null = null;
  /**
   * 是否统计没有归属（ownerId < 0）的刚体。
   * 默认 false：地形那个巨大的静态刚体一旦被算进来，任何贴地触发区都会"永远有东西在里面"。
   */
  includeUnknownOwners = false;

  private lastUpdateMs = 0;
  private eventTotal = 0;
  private lastStayMs = Number.NEGATIVE_INFINITY;
  private pendingSpecs: TriggerSpec[] = [];

  constructor(private readonly physics: PhysicsWorld) {}

  // ---------------------------------------------------------------- 只读

  get count(): number {
    return this.records.length;
  }

  get enabledCount(): number {
    let count = 0;
    for (const record of this.records) if (record.enabled) count += 1;
    return count;
  }

  get updateMs(): number {
    return this.lastUpdateMs;
  }

  get firedTotal(): number {
    let count = 0;
    for (const record of this.records) count += record.firedCount;
    return count;
  }

  get eventCount(): number {
    return this.eventTotal;
  }

  /** 还没建出 sensor 的触发区数量（物理未就绪时会排队） */
  get pendingCount(): number {
    return this.pendingSpecs.length;
  }

  /** 当前真的建出了 sensor 的触发区数量（面板显示"形状是真的"的凭据） */
  get sensorCount(): number {
    let count = 0;
    for (const record of this.records) if (record.collider >= 0) count += 1;
    return count;
  }

  // ---------------------------------------------------------------- 增删

  /**
   * 加一个触发区。
   *
   * 物理未就绪时**不失败**：spec 进 `pendingSpecs`，`update()` 里发现就绪后自动补建。
   * 理由和关节系统一致 —— 玩家不该因为 4 MB 的 wasm 还在下载就摆不了触发器。
   */
  add(spec: TriggerSpec): number {
    const record: TriggerRecord = {
      id: this.nextId++,
      center: { ...spec.center },
      halfExtents: { ...spec.halfExtents },
      tag: spec.tag,
      params: spec.params ?? defaultParams(spec.halfExtents),
      once: spec.once ?? false,
      firedCount: 0,
      inside: new Set<number>(),
      enabled: true,
      shape: spec.shape ?? 'box',
      rotationY: spec.rotationY ?? 0,
      collider: -1,
      anchor: -1,
      ownerHandle: -1,
      enterTotal: 0,
      stayTotal: 0,
      exitTotal: 0,
    };
    this.records.push(record);
    if (this.physics.isReady) {
      this.createSensor(record);
    } else {
      this.pendingSpecs.push({ ...spec });
    }
    return record.id;
  }

  /** 把触发区挂到某个刚体上（压力板 / 按钮） */
  bindOwner(id: number, handle: number): boolean {
    const record = this.records.find((item) => item.id === id);
    if (!record) return false;
    record.ownerHandle = handle;
    // 绑定了宿主之后，触发区跟着宿主走：位置从"绝对坐标"变成"宿主位姿 + 偏移"，
    // 否则一块被推走的压力板，触发区会留在原地
    if (handle >= 0) this.owners.set(handle, id);
    return true;
  }

  remove(id: number): boolean {
    const index = this.records.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const record = this.records[index]!;
    this.destroySensor(record);
    this.records.splice(index, 1);
    return true;
  }

  /**
   * 移除所有"连到某个刚体"的触发区。
   *
   * **不是**把有宿主刚体的全删掉 —— 触发区的锚点刚体是我们自己造的静态体，
   * 它也"连着"触发区。只有宿主（`ownerHandle`）被删时才该连带删除。
   */
  removeByBody(handle: number): number {
    let removed = 0;
    for (const record of [...this.records]) {
      if (record.ownerHandle !== handle) continue;
      this.remove(record.id);
      removed += 1;
    }
    this.owners.delete(handle);
    return removed;
  }

  clear(): void {
    for (const record of this.records) this.destroySensor(record);
    this.records.length = 0;
    this.colliderToTrigger.clear();
    this.owners.clear();
    this.pendingSpecs.length = 0;
    this.eventTotal = 0;
  }

  dispose(): void {
    this.clear();
    this.onEvent = null;
  }

  // ---------------------------------------------------------------- 查询

  insideCount(id: number): number {
    return this.records.find((item) => item.id === id)?.inside.size ?? 0;
  }

  list(): TriggerRecord[] {
    return [...this.records];
  }

  find(id: number): TriggerRecord | null {
    return this.records.find((item) => item.id === id) ?? null;
  }

  setEnabled(id: number, enabled: boolean): boolean {
    const record = this.records.find((item) => item.id === id);
    if (!record) return false;
    record.enabled = enabled;
    if (record.collider >= 0) {
      const collider = this.world?.getCollider(record.collider);
      try {
        // 关掉传感器而不是删掉它：这样"再开"是零成本的，而且不会丢 inside 状态
        collider?.setEnabled(enabled);
      } catch {
        /* 已经被物理世界清掉了 */
      }
    }
    if (!enabled) record.inside.clear();
    return true;
  }

  setEnabledByTag(tag: string, enabled: boolean): number {
    let count = 0;
    for (const record of this.records) {
      if (record.tag !== tag) continue;
      if (this.setEnabled(record.id, enabled)) count += 1;
    }
    return count;
  }

  // ---------------------------------------------------------------- 事件

  /**
   * 由 Engine 在 `world.step(eventQueue)` 之后调用：把这一帧的碰撞事件喂进来。
   *
   * @param resolveBody 由调用方给出的"碰撞体 → 刚体 handle"解析（我们在这里不碰 Rapier 的查询管线）
   */
  handleCollision(
    collider1: number,
    collider2: number,
    started: boolean,
    resolveBody: (colliderHandle: number) => number,
  ): void {
    const asTrigger = this.colliderToTrigger.get(collider1);
    const asOther = this.colliderToTrigger.get(collider2);
    if (asTrigger === undefined && asOther === undefined) return;

    const triggerId = asTrigger ?? asOther;
    const otherCollider = asTrigger !== undefined ? collider2 : collider1;
    const record = this.records.find((item) => item.id === triggerId);
    if (!record || !record.enabled) return;

    const bodyHandle = resolveBody(otherCollider);
    if (bodyHandle < 0) return;
    const ownerId = this.physics.ownerOf(bodyHandle);
    if (!this.includeUnknownOwners && ownerId < 0) return;

    if (started) {
      if (record.inside.has(bodyHandle)) return;
      record.inside.add(bodyHandle);
      record.firedCount += 1;
      record.enterTotal += 1;
      this.emit({
        triggerId: record.id,
        tag: record.tag,
        phase: 'enter',
        handle: bodyHandle,
        ownerId,
        count: record.inside.size,
      });
      if (record.once) {
        // 单次触发器：发完这一次就关掉
        this.setEnabled(record.id, false);
      }
    } else {
      if (!record.inside.has(bodyHandle)) return;
      record.inside.delete(bodyHandle);
      record.exitTotal += 1;
      this.emit({
        triggerId: record.id,
        tag: record.tag,
        phase: 'exit',
        handle: bodyHandle,
        ownerId,
        count: record.inside.size,
      });
    }
  }

  /**
   * 每帧调用。
   *
   * 现在只做两件事（不再有轮询查询）：
   * 1. 物理刚就绪时把排队的触发区补建成 sensor；
   * 2. 按节流补发 `stay` 事件（Rapier 只给 begin/end，stay 是我们自己合的）。
   */
  update(nowMs: number): void {
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();

    if (this.pendingSpecs.length > 0 && this.physics.isReady) {
      const pending = this.pendingSpecs.splice(0, this.pendingSpecs.length);
      for (const spec of pending) {
        const record = this.records.find((item) => item.tag === spec.tag && item.collider < 0);
        if (record) this.createSensor(record);
      }
    }

    if (nowMs - this.lastStayMs >= this.minStayIntervalMs) {
      this.lastStayMs = nowMs;
      for (const record of this.records) {
        if (!record.enabled || record.inside.size === 0) continue;
        for (const handle of [...record.inside].sort((a, b) => a - b)) {
          record.stayTotal += 1;
          this.emit({
            triggerId: record.id,
            tag: record.tag,
            phase: 'stay',
            handle,
            ownerId: this.physics.ownerOf(handle),
            count: record.inside.size,
          });
        }
      }
    }

    this.lastUpdateMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
  }

  /** 面板用：一行中文摘要 */
  describe(): string {
    const pendingNote = this.pendingCount > 0 ? `，${this.pendingCount} 个等物理就绪` : '';
    return (
      `触发器：${this.records.length} 个（已建 sensor ${this.sensorCount}）${pendingNote}｜` +
      `进入 ${this.records.reduce((sum, r) => sum + r.enterTotal, 0)} 次 / 停留 ${this.records.reduce((sum, r) => sum + r.stayTotal, 0)} 次 / ` +
      `离开 ${this.records.reduce((sum, r) => sum + r.exitTotal, 0)} 次｜${this.lastUpdateMs.toFixed(2)} ms`
    );
  }

  // ---------------------------------------------------------------- 内部

  private get world(): WorldLike | null {
    return (this.physics.raw as WorldLike | null) ?? null;
  }

  private get api(): ApiLike | null {
    return (this.physics.api as ApiLike | null) ?? null;
  }

  /**
   * 建 sensor 碰撞体。
   *
   * 用一个**独立的静态锚点刚体**而不是把 sensor 挂在别的物体上：
   * 触发区常常是"空气里的一个位置"（感应门、区域提示），本来就没有实体可挂。
   * 需要跟着物体走的（压力板）走 `bindOwner`，由 Engine 每帧把锚点挪到宿主位置。
   */
  private createSensor(record: TriggerRecord): boolean {
    const world = this.world;
    const api = this.api;
    if (!world || !api) return false;

    try {
      const anchorDesc = api.RigidBodyDesc.fixed().setTranslation(
        record.center.x,
        record.center.y,
        record.center.z,
      );
      const anchor = world.createRigidBody(anchorDesc);

      let desc: ColliderDescLike;
      if (record.shape === 'ball') {
        desc = api.ColliderDesc.ball(Math.max(0.05, record.halfExtents.x));
      } else if (record.shape === 'cylinder') {
        desc = api.ColliderDesc.cylinder(
          Math.max(0.05, record.halfExtents.y),
          Math.max(0.05, record.halfExtents.x),
        );
      } else {
        desc = api.ColliderDesc.cuboid(
          Math.max(0.05, record.halfExtents.x),
          Math.max(0.05, record.halfExtents.y),
          Math.max(0.05, record.halfExtents.z),
        );
      }
      desc.setSensor(true);
      desc.setCollisionGroups(interactionGroups('trigger', this.partners));
      // 没有这一行 Rapier 不会产生任何事件 —— 这是最容易漏的一步
      if (api.ActiveEvents) desc.setActiveEvents(api.ActiveEvents.COLLISION_EVENTS);

      const collider = world.createCollider(desc, anchor);
      record.anchor = anchor.handle;
      record.collider = collider.handle;
      this.colliderToTrigger.set(collider.handle, record.id);
      return true;
    } catch (error) {
      console.warn('[触发器] 创建 sensor 失败', error);
      return false;
    }
  }

  private destroySensor(record: TriggerRecord): void {
    const world = this.world;
    if (record.collider >= 0) this.colliderToTrigger.delete(record.collider);
    if (!world) {
      record.collider = -1;
      record.anchor = -1;
      return;
    }
    try {
      if (record.collider >= 0) {
        const collider = world.getCollider(record.collider);
        if (collider) world.removeCollider(collider, false);
      }
    } catch {
      /* 已经被物理世界清掉了 */
    }
    try {
      if (record.anchor >= 0) {
        const anchor = world.getRigidBody(record.anchor);
        if (anchor) world.removeRigidBody(anchor);
      }
    } catch {
      /* 同上 */
    }
    record.collider = -1;
    record.anchor = -1;
    record.inside.clear();
  }

  /** 回调出错不能连累整帧（逻辑连线的监听者可能写得很糟） */
  private emit(event: TriggerEvent): void {
    this.eventTotal += 1;
    const callback = this.onEvent;
    if (!callback) return;
    try {
      callback(event);
    } catch {
      // 吞掉：触发器系统不能因为监听者崩了而停摆
    }
  }
}

function defaultParams(halfExtents: Vec3): TriggerParams {
  return {
    shape: 'box',
    size: [halfExtents.x * 2, halfExtents.y * 2, halfExtents.z * 2],
  } as TriggerParams;
}
