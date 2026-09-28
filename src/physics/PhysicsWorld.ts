import { PHYSICS_CONFIG } from '../config';
import { RapierWorldManager, type RapierLoadingProgress, type RapierWorldStats } from './RapierWorld';
import type { PhysicsWorldConfig } from '../data/gravityPresets';
import type { PhysicsMode } from '../building/types';

export type { PhysicsMode };

/**
 * Rapier 模块的类型（用 `typeof import(...)` 就能只取类型、不产生静态依赖）。
 */
type RapierModule = typeof import('@dimforge/rapier3d-compat');
/** 默认导出就是整个命名空间（含各种 Desc 构造器） */
type RapierApi = RapierModule['default'];
/**
 * 世界实例类型。
 * 注意：`RapierModule['World']` 取到的是**类构造器**类型而不是实例类型，
 * 所以这里直接用具名类型导入（type-only，运行时不会产生静态依赖，
 * 动态 import 的拆分效果不受影响）。
 */
type RapierWorld = import('@dimforge/rapier3d-compat').World;

export interface PhysicsPose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface PhysicsRayHit {
  distance: number;
  pointX: number;
  pointY: number;
  pointZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  /** 命中体所属的刚体 handle（-1 表示没归属，例如地形） */
  bodyHandle: number;
}

export interface PhysicsShapeHit {
  distance: number;
  bodyHandle: number;
}

/** 单个碰撞体（相对刚体原点） */
export interface ColliderSpec {
  kind: 'box' | 'cylinder' | 'sphere';
  /** 相对刚体原点的偏移 */
  position: [number, number, number];
  /** box 用；圆柱/球体用 radius + halfHeight 描述 */
  halfExtents: [number, number, number];
  radius: number;
  halfHeight: number;
}

/** 创建一个建筑刚体所需的全部信息 */
export interface BodySpec {
  mode: PhysicsMode;
  position: [number, number, number];
  rotationY: number;
  colliders: ColliderSpec[];
  density: number;
  friction: number;
  restitution: number;
}

/**
 * Rapier 物理世界的封装。
 *
 * 为什么自己做一层壳，而不是在 Engine 里直接用 Rapier：
 * 1. `RAPIER.init()` 是**异步**的（要加载 wasm），而 Engine 的构造是同步的。
 *    这里把初始化做成"后台 promise + isReady 门闩"，主循环无需变成 async；
 * 2. handle ↔ 建筑实例的映射、模式切换、位姿读写这些重复代码集中在一处；
 * 3. 换物理引擎（或者 M5 要换 rapier3d 非 compat 版）时只改这一个文件。
 *
 * 一个容易踩的坑：**加完碰撞体必须先 step() 一次，射线与形状查询才有效**
 * （查询管线在 step 里更新）。所以 `syncQueries()` 会在需要时补一次空步。
 */
export class PhysicsWorld {
  /**
   * M3：Rapier 的**世界生命周期**全部交给 `RapierWorldManager` 管
   * （加载进度、配置应用、清空、销毁、统计）。
   *
   * 这个类保留下来当薄兼容层，是因为它在 M2/M2.5 里被 98 个模块 import 着
   * （`createBody` / `castRay` / `readPose` / `setMode` … 全是刚体级操作）。
   * 一次性把这些调用点全部改到新 API 上，收益只是"名字更好看"，
   * 代价是把 98 个文件的回归风险一次性拉满。所以职责按"世界级 vs 刚体级"切，
   * 世界级归 manager，刚体级留在这里。
   */
  readonly manager: RapierWorldManager;

  private readonly modes = new Map<number, PhysicsMode>();
  /** 刚体 handle → 归属的建筑实例 id（地形是 -1） */
  private readonly owners = new Map<number, number>();

  private gravityValue: number = PHYSICS_CONFIG.gravity;
  /** 累计推进的物理步数（调试面板显示） */
  steps = 0;

  constructor(options: { config?: Partial<PhysicsWorldConfig>; onProgress?: (p: RapierLoadingProgress) => void; chunkUrl?: string } = {}) {
    this.manager = new RapierWorldManager(options);
    this.gravityValue = this.manager.gravityY;
  }

  get gravityY(): number {
    return this.gravityValue;
  }

  set gravityY(value: number) {
    this.gravityValue = value;
    // 重力的**权威值**在 manager 里；这个 setter 让 M2 的老调用点（直接赋值）也能生效
    if (this.manager.isReady) this.manager.gravityY = value;
  }

  // ---------------------------------------------------------------- 生命周期

  get isReady(): boolean {
    return this.manager.isReady;
  }

  get errorMessage(): string {
    return this.manager.errorMessage;
  }

  /**
   * 加载 wasm 并建世界。可以重复调用，只会真正初始化一次。
   * @returns 是否可用
   */
  async init(): Promise<boolean> {
    return this.manager.init();
  }

  /** 加载进度（含真字节进度 / 阶段进度两种模式，见 RapierWorld 的说明） */
  get loadingProgress(): RapierLoadingProgress {
    return this.manager.progress;
  }

  /** 世界级统计（刚体/碰撞体/关节/时间步/求解迭代/重力/加载耗时/进度模式） */
  get worldStats(): RapierWorldStats {
    return this.manager.stats;
  }

  /** 进度模式：'bytes' = 真字节进度，'phases' = 阶段进度 */
  get progressMode(): 'bytes' | 'phases' {
    return this.manager.progressMode;
  }

  /** 应用世界配置（重力/时间步/子步/求解迭代/休眠阈值） */
  applyConfig(patch: Partial<PhysicsWorldConfig>): { applied: boolean; problems: string[] } {
    const result = this.manager.applyConfig(patch);
    // 重力是常用滑块，改完要同步回这个类的镜像值（M2 的代码仍在读 gravityY）
    if (result.applied) this.gravityY = this.manager.gravityY;
    return result;
  }

  get raw(): RapierWorld | null {
    return this.manager.raw;
  }

  /** wasm 加载耗时（毫秒） */
  get loadMilliseconds(): number {
    return this.manager.loadMilliseconds;
  }

  /** 暴露 Rapier 命名空间（TerrainCollider 需要它来构造 heightfield 描述符） */
  get api(): RapierApi | null {
    return this.manager.api;
  }

  /**
   * 推进一个固定步长。暂停时由调用方决定不调它。
   *
   * 时间步**不再写死**成 `PHYSICS_CONFIG.fixedTimeStep`：M3 起它是可配置的
   * （时间流速、0.25/0.5 慢速档都会改它），权威值在 `RapierWorldManager` 里。
   */
  step(): void {
    if (!this.manager.isReady) return;
    this.manager.step();
    this.steps++;
  }

  /** 改重力（调试用） */
  setGravity(y: number): void {
    this.gravityY = y;
    this.manager.gravityY = y;
  }

  // ---------------------------------------------------------------- 刚体

  /**
   * 按规格创建一个刚体（含复合碰撞体）。
   * @param ownerId 归属的建筑实例 id
   * @returns 刚体 handle；物理未就绪时返回 -1
   */
  createBody(spec: BodySpec, ownerId: number): number {
    const world = this.manager.raw;
    if (!world) return -1;

    const api = this.manager.api;
    if (!api) return -1;
    const desc =
      spec.mode === 'dynamic'
        ? api.RigidBodyDesc.dynamic()
        : spec.mode === 'kinematic'
          ? api.RigidBodyDesc.kinematicPositionBased()
          : api.RigidBodyDesc.fixed();

    desc.setTranslation(spec.position[0], spec.position[1], spec.position[2]);
    const half = spec.rotationY / 2;
    desc.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
    if (spec.mode !== 'static') {
      // 阻尼让物体更快静止，减少堆叠时的抖动
      desc.setLinearDamping(0.08);
      desc.setAngularDamping(0.35);
    }

    const body = world.createRigidBody(desc);

    for (const collider of spec.colliders) {
      const shape =
        collider.kind === 'cylinder'
          ? api.ColliderDesc.cylinder(collider.halfHeight, collider.radius)
          : collider.kind === 'sphere'
            ? api.ColliderDesc.ball(collider.radius)
            : api.ColliderDesc.cuboid(
                collider.halfExtents[0],
                collider.halfExtents[1],
                collider.halfExtents[2],
              );
      shape.setTranslation(collider.position[0], collider.position[1], collider.position[2]);
      shape.setDensity(Math.max(1, spec.density));
      shape.setFriction(spec.friction);
      shape.setRestitution(spec.restitution);
      world.createCollider(shape, body);
    }

    this.modes.set(body.handle, spec.mode);
    this.owners.set(body.handle, ownerId);
    return body.handle;
  }

  removeBody(handle: number): void {
    const world = this.manager.raw;
    if (!world || handle < 0) return;
    const body = world.getRigidBody(handle);
    if (body) world.removeRigidBody(body);
    this.modes.delete(handle);
    this.owners.delete(handle);
  }

  setMode(handle: number, mode: PhysicsMode): void {
    const world = this.manager.raw;
    if (!world) return;
    const body = world.getRigidBody(handle);
    if (!body) return;
    const api = this.manager.api;
    if (!api) return;
    const type =
      mode === 'dynamic'
        ? api.RigidBodyType.Dynamic
        : mode === 'kinematic'
          ? api.RigidBodyType.KinematicPositionBased
          : api.RigidBodyType.Fixed;
    body.setBodyType(type, true);
    // 从静态转动态时清掉残留速度，避免"突然弹开"
    if (mode !== 'dynamic') body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.modes.set(handle, mode);
  }

  getMode(handle: number): PhysicsMode | null {
    return this.modes.get(handle) ?? null;
  }

  ownerOf(handle: number): number {
    return this.owners.get(handle) ?? -1;
  }

  readPose(handle: number): PhysicsPose | null {
    const body = this.manager.raw?.getRigidBody(handle);
    if (!body) return null;
    const t = body.translation();
    const r = body.rotation();
    return { x: t.x, y: t.y, z: t.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w };
  }

  /** 直接摆位置（拿起、微调、还原时用） */
  setPose(
    handle: number,
    position: [number, number, number],
    rotationY: number,
    kinematic = false,
  ): void {
    const body = this.manager.raw?.getRigidBody(handle);
    if (!body) return;
    const half = rotationY / 2;
    const rotation = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
    if (kinematic) {
      // kinematic 刚体要用 setNextKinematic*，否则不会推动别人
      body.setNextKinematicTranslation({ x: position[0], y: position[1], z: position[2] });
      body.setNextKinematicRotation(rotation);
    } else {
      body.setTranslation({ x: position[0], y: position[1], z: position[2] }, true);
      body.setRotation(rotation, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  /** 清掉速度（放下物体时防止它带着拖动速度飞出去） */
  zeroVelocity(handle: number): void {
    const body = this.manager.raw?.getRigidBody(handle);
    if (!body) return;
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /**
   * 启用/停用刚体（M3 第 7 批：距离剔除用）。
   *
   * ⚠ **停用的刚体不参与任何碰撞**。这不是副作用，而是这个功能的前提 ——
   * 不参与宽相位才省得下开销。调用方（DistanceCulling）负责把它限制到
   * "远处 + 已休眠 + 非重要"三个条件同时成立时才停用。
   */
  setEnabled(handle: number, enabled: boolean): boolean {
    const body = this.manager.raw?.getRigidBody(handle);
    if (!body) return false;
    try {
      body.setEnabled(enabled);
      // 重新启用时必须唤醒：停用期间一直睡着的刚体，启用后不会自己醒
      if (enabled) body.wakeUp();
      return true;
    } catch (error) {
      console.warn('[物理] 启用/停用刚体失败', error);
      return false;
    }
  }

  /** 刚体当前是否启用 */
  isEnabled(handle: number): boolean {
    const body = this.manager.raw?.getRigidBody(handle);
    if (!body) return false;
    try {
      return body.isEnabled();
    } catch {
      return false;
    }
  }

  isSleeping(handle: number): boolean {
    return this.manager.raw?.getRigidBody(handle)?.isSleeping() ?? true;
  }

  /**
   * 读线速度 / 角速度。
   *
   * 为什么要在这里加一层：`readPose` 只给位姿，而**爆炸保护**（判断是否被弹飞）、
   * **浮力**（判断是否在水里剧烈运动）与**撞击音效**（Δv 代理）都要速度。
   * 让每个调用方各自去 `raw.getRigidBody()` 跨 wasm 边界读，就会出现同一帧读三遍同样数据。
   */
  readVelocity(handle: number): { x: number; y: number; z: number } | null {
    const body = this.manager.raw?.getRigidBody(handle);
    if (!body) return null;
    const velocity = body.linvel();
    return { x: velocity.x, y: velocity.y, z: velocity.z };
  }

  readAngularVelocity(handle: number): { x: number; y: number; z: number } | null {
    const body = this.manager.raw?.getRigidBody(handle);
    if (!body) return null;
    const velocity = body.angvel();
    return { x: velocity.x, y: velocity.y, z: velocity.z };
  }

  /** 线速度的模长（音效与保护都用它，避免每个调用方各写一次 hypot） */
  speedOf(handle: number): number {
    const velocity = this.readVelocity(handle);
    if (!velocity) return 0;
    return Math.hypot(velocity.x, velocity.y, velocity.z);
  }

  // ---------------------------------------------------------------- 查询

  /** 世界坐标射线（方向不必归一化，内部会归一化并返回真实距离） */
  castRay(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    excludeBody = -1,
  ): PhysicsRayHit | null {
    const world = this.manager.raw;
    if (!world) return null;
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (length < 1e-9) return null;
    const dir = { x: direction[0] / length, y: direction[1] / length, z: direction[2] / length };
    const api = this.manager.api;
    if (!api) return null;
    const ray = new api.Ray({ x: origin[0], y: origin[1], z: origin[2] }, dir);
    const exclude = excludeBody >= 0 ? world.getRigidBody(excludeBody) : undefined;
    const hit = world.castRayAndGetNormal(ray, maxDistance, true, undefined, undefined, undefined, exclude);
    if (!hit) return null;
    const t = hit.timeOfImpact;
    return {
      distance: t,
      pointX: origin[0] + dir.x * t,
      pointY: origin[1] + dir.y * t,
      pointZ: origin[2] + dir.z * t,
      normalX: hit.normal.x,
      normalY: hit.normal.y,
      normalZ: hit.normal.z,
      bodyHandle: hit.collider.parent()?.handle ?? -1,
    };
  }

  /**
   * 形状投射：把一个立方体从某处沿某方向推出去，返回第一次碰到东西的距离。
   * 这是"智能放置"判断"会不会穿模"的主力。
   */
  castBox(
    halfExtents: [number, number, number],
    position: [number, number, number],
    rotationY: number,
    direction: [number, number, number],
    maxDistance: number,
    excludeBody = -1,
  ): PhysicsShapeHit | null {
    const world = this.manager.raw;
    const api = this.manager.api;
    if (!world || !api) return null;
    const half = rotationY / 2;
    const exclude = excludeBody >= 0 ? world.getRigidBody(excludeBody) : undefined;
    const hit = world.castShape(
      { x: position[0], y: position[1], z: position[2] },
      { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
      { x: direction[0], y: direction[1], z: direction[2] },
      new api.Cuboid(halfExtents[0], halfExtents[1], halfExtents[2]),
      0,
      maxDistance,
      true,
      undefined,
      undefined,
      undefined,
      exclude,
    );
    if (!hit) return null;
    return {
      distance: hit.time_of_impact,
      bodyHandle: hit.collider.parent()?.handle ?? -1,
    };
  }

  /**
   * 重叠检测：某个盒子摆在这个位姿时，和现有碰撞体重不重叠。
   * 返回重叠到的刚体 handle 列表（不含自己）。
   */
  overlapBox(
    halfExtents: [number, number, number],
    position: [number, number, number],
    rotationY: number,
    excludeBody = -1,
  ): number[] {
    const world = this.manager.raw;
    const api = this.manager.api;
    if (!world || !api) return [];
    const half = rotationY / 2;
    const exclude = excludeBody >= 0 ? world.getRigidBody(excludeBody) : undefined;
    const result: number[] = [];
    world.intersectionsWithShape(
      { x: position[0], y: position[1], z: position[2] },
      { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
      new api.Cuboid(halfExtents[0], halfExtents[1], halfExtents[2]),
      (collider) => {
        const handle = collider.parent()?.handle ?? -1;
        if (handle >= 0 && handle !== excludeBody) result.push(handle);
        return true;
      },
      undefined,
      undefined,
      undefined,
      exclude,
    );
    return result;
  }

  // ---------------------------------------------------------------- 统计

  get bodyCount(): number {
    return this.owners.size;
  }

  get dynamicCount(): number {
    let count = 0;
    for (const mode of this.modes.values()) if (mode === 'dynamic') count++;
    return count;
  }

  /** 当前处于唤醒状态的刚体数（性能面板显示，休眠的刚体几乎不耗 CPU） */
  get awakeCount(): number {
    const world = this.manager.raw;
    if (!world) return 0;
    let count = 0;
    for (const handle of this.owners.keys()) {
      const body = world.getRigidBody(handle);
      if (body && !body.isSleeping()) count++;
    }
    return count;
  }

  /** 是否有事件队列（没有时传感器事件不会产生） */
  get hasEventQueue(): boolean {
    return this.manager.hasEventQueue;
  }

  /** 排空这一帧的碰撞事件（必须紧跟在 step 之后，见 RapierWorld 的说明） */
  drainCollisions(callback: (colliderA: number, colliderB: number, started: boolean) => void): number {
    return this.manager.drainCollisions(callback);
  }

  /**
   * 读接触对（M3 第 6 批，调试可视化用）。
   *
   * 只遍历**传进来的这些碰撞体**，而不是全世界 —— Rapier 的 `contactPairsWith` 是
   * 按碰撞体逐个问的，扫全世界在 500 个物体时每帧要问 500 次，那是调试面板不该承担的成本。
   * 所以调用方（Engine）按"相机附近的动态物体"筛一遍再传进来。
   *
   * 返回的是**纯数据**（位置/法线/摩擦），不带任何 Rapier 对象 —— 这样下游可以在 Node 里断言。
   */
  collectContacts(
    colliderHandles: readonly number[],
    limit = 64,
  ): {
    points: { x: number; y: number; z: number }[];
    normal: { x: number; y: number; z: number };
    bodyA: number;
    bodyB: number;
    friction: number;
    restitution: number;
  }[] {
    const world = this.manager.raw;
    if (!world) return [];
    const results: {
      points: { x: number; y: number; z: number }[];
      normal: { x: number; y: number; z: number };
      bodyA: number;
      bodyB: number;
      friction: number;
      restitution: number;
    }[] = [];
    const seen = new Set<string>();

    for (const handle of colliderHandles) {
      if (results.length >= limit) break;
      const collider = world.getCollider(handle);
      if (!collider) continue;
      try {
        world.contactPairsWith(collider, (other) => {
          if (results.length >= limit) return;
          // 同一对会因为两个碰撞体各问一次而重复出现，用句柄对去重
          const key = handle < other.handle ? `${handle}:${other.handle}` : `${other.handle}:${handle}`;
          if (seen.has(key)) return;
          seen.add(key);
          world.contactPair(collider, other, (manifold) => {
            const count = Math.min(manifold.numContacts(), 8);
            const points: { x: number; y: number; z: number }[] = [];
            for (let index = 0; index < count; index += 1) {
              const point = manifold.solverContactPoint(index);
              if (point) points.push({ x: point.x, y: point.y, z: point.z });
            }
            if (points.length === 0) return;
            const normal = manifold.normal();
            results.push({
              points,
              normal: { x: normal.x, y: normal.y, z: normal.z },
              bodyA: this.bodyOfCollider(handle),
              bodyB: this.bodyOfCollider(other.handle),
              friction: safeNumber(() => manifold.friction(), 0.5),
              restitution: safeNumber(() => manifold.restitution(), 0.1),
            });
          });
        });
      } catch (error) {
        // 接触读取失败不能打断整帧的调试可视化（它本身就是排查工具）
        console.warn('[物理] 读接触对失败', error);
        break;
      }
    }
    return results;
  }

  /** 所有碰撞体的句柄（按刚体句柄集合筛，用于接触调试） */
  collidersOfBodies(bodyHandles: readonly number[], limitPerBody = 8): number[] {
    const world = this.manager.raw;
    if (!world) return [];
    const out: number[] = [];
    for (const bodyHandle of bodyHandles) {
      const body = world.getRigidBody(bodyHandle);
      if (!body) continue;
      try {
        const count = Math.min(body.numColliders(), limitPerBody);
        for (let index = 0; index < count; index += 1) {
          const collider = body.collider(index) as { handle: number };
          if (collider) out.push(collider.handle);
        }
      } catch {
        /* 刚体已被删除 */
      }
    }
    return out;
  }

  /**
   * 碰撞体 → 它所属的刚体 handle。
   *
   * 传感器事件的参数是**碰撞体**句柄而不是刚体句柄，所以必须有这一步翻译。
   * 返回 -1 表示这个碰撞体没有父刚体。
   */
  bodyOfCollider(colliderHandle: number): number {
    const collider = this.manager.raw?.getCollider(colliderHandle);
    if (!collider) return -1;
    const parent = collider.parent() as { handle: number } | null;
    return parent ? parent.handle : -1;
  }

  /**
   * 兜底刷新查询管线。
   * 刚加完碰撞体就立刻做射线/形状查询时会查不到东西，
   * 因为查询管线只在 step() 里更新 —— 这里补一次零速步。
   */
  syncQueries(): void {
    this.manager.syncQueries();
  }

  /** 清空世界（换地图 / 载入存档时用） */
  clear(): void {
    // 先让 manager 清（它负责清关节 + 全部刚体），再清本类的映射表
    this.manager.clear();
    this.modes.clear();
    this.owners.clear();
    this.steps = 0;
  }

  dispose(): void {
    this.manager.dispose();
    this.modes.clear();
    this.owners.clear();
  }
}

/** 读一个可能抛异常/返回 NaN 的 wasm 值（接触数据在极端情况下会读到脏值） */
function safeNumber(read: () => number, fallback: number): number {
  try {
    const value = read();
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
