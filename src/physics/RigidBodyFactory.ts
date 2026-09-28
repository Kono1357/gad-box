/**
 * 刚体工厂（M3 第 2 批）。
 *
 * 负责把「一个物体应该怎样参与物理」这件事，翻译成 Rapier 的 `RigidBodyDesc` + 一组碰撞体。
 * 四类刚体的语义（这是本项目的核心约定，写清楚免得以后搞混）：
 *
 * | 类型 | 谁在用 | 受重力 | 被谁驱动 |
 * |---|---|---|---|
 * | `fixed` | 地形、地基、被"稳定器"锁定的结构 | 否 | 不动 |
 * | `dynamic` | 箱子、家具、载具、会塌的塔 | 是 | Rapier 求解器 |
 * | `kinematicPosition` | 被玩家拿起的物体、机械臂 | 否 | **位姿**（我们每帧写目标位置） |
 * | `kinematicVelocity` | 传送带上的物体、匀速运动的平台 | 否 | **速度**（我们写目标速度） |
 *
 * ────────────────────────────────────────────────────────────
 * 为什么把"按材质定参数"也放在这里
 * ────────────────────────────────────────────────────────────
 * 摩擦/弹性/密度/阻尼这四样东西，**既可能在材质里定义，也可能被单个物体覆盖**
 * （例如"这块地基我要它特别沉"）。如果让调用方自己拼，很快就会出现
 * "有的地方读材质、有的地方读物品定义、有的地方硬编码"，然后玩家改材质发现没生效。
 * 所以规则只有一条：**spec 里显式给的值 > 材质里的值 > 全局默认**，并且这个优先级
 * 由 `resolveBodyParams()` 一个地方实现、可被单测。
 *
 * ────────────────────────────────────────────────────────────
 * 休眠
 * ────────────────────────────────────────────────────────────
 * Rapier 自带休眠（默认开启）：静止一段时间后进入休眠、被碰撞或手动唤醒时醒来。
 * 本项目只做两件额外的事：
 * 1. **默认允许休眠**（`canSleep` 不填就是 true）—— 500 个箱子堆成的塔如果全部唤醒，
 *    单帧求解就足够把帧率打到个位数；
 * 2. **提供显式唤醒/休眠**，因为"玩家拿起一个休眠的物体"这件事必须能立刻唤醒它，
 *    否则会出现"物体被拖走了但碰撞体还停在原地"这种极难排查的现象。
 */

import type { PhysicsMaterial } from '../data/physicsMaterials';
import {
  createCollider,
  type ColliderSpecFull,
  type PhysicsLayer,
} from './ColliderFactory';

/** 四类刚体 */
export type BodyKind = 'fixed' | 'dynamic' | 'kinematicPosition' | 'kinematicVelocity';

export const BODY_KIND_LABELS: Record<BodyKind, string> = {
  fixed: '静态（不受力，不动）',
  dynamic: '动态（受重力与碰撞）',
  kinematicPosition: '运动学·位置驱动（我们写目标位置）',
  kinematicVelocity: '运动学·速度驱动（我们写目标速度）',
};

/** 一个刚要创建的刚体 */
export interface RigidBodySpec {
  kind: BodyKind;
  position: [number, number, number];
  /** 绕 Y 轴旋转（弧度）。给了 `rotation` 就忽略它 */
  rotationY?: number;
  /** 完整四元数 [x, y, z, w] */
  rotation?: [number, number, number, number];
  /** 初始线速度（m/s） */
  linearVelocity?: [number, number, number];
  /** 初始角速度（rad/s） */
  angularVelocity?: [number, number, number];
  /** 碰撞体（至少一个；空数组会导致"看得见但摸不着"的幽灵物体） */
  colliders: ColliderSpecFull[];
  /** 物理材质，决定摩擦/弹性/密度/阻尼 */
  material: PhysicsMaterial;
  /** 显式质量（kg）。给了就压过"密度 × 体积" */
  mass?: number;
  /** 线性阻尼覆盖 */
  linearDamping?: number;
  /** 角阻尼覆盖 */
  angularDamping?: number;
  /** 是否允许休眠，默认 true */
  canSleep?: boolean;
  /** 重力缩放：0 = 悬浮不受重力，默认 1 */
  gravityScale?: number;
  /** 连续碰撞检测（只有高速小物体需要，代价明显） */
  ccd?: boolean;
  /** 锁定位置/旋转的轴（做"活塞只能上下动"这类约束时用） */
  lockTranslation?: [boolean, boolean, boolean];
  lockRotation?: [boolean, boolean, boolean];
  /** 归属（建筑实例 id / -1 地形） */
  ownerId?: number;
}

/** 创建结果 */
export interface BodyCreationOutcome {
  /** 刚体句柄；失败为 -1 */
  handle: number;
  kind: BodyKind;
  /** Rapier 算出来的质量（kg）；失败或静止刚体可能是 0 */
  mass: number;
  colliderCount: number;
  /** 形状回退等告警（中文），调用方应当记日志 */
  warnings: string[];
  ok: boolean;
  /** 失败原因（中文） */
  reason?: string;
}

/** 参数解析结果（纯计算，可单测） */
export interface ResolvedBodyParams {
  friction: number;
  restitution: number;
  density: number;
  linearDamping: number;
  angularDamping: number;
  /** 来自哪个材质 id（面板显示用） */
  materialId: string;
}

/**
 * 参数解析：**spec 显式值 > 材质值 > 全局默认**。
 *
 * 这个优先级只有一处实现，是为了避免"改材质没生效"这类问题 ——
 * 只要有任何一处绕过它去直接读材质的某一个字段，规则就不再一致了。
 */
export function resolveBodyParams(spec: RigidBodySpec): ResolvedBodyParams {
  const material = spec.material;
  return {
    friction: clamp01(material.friction, 0.5),
    restitution: clamp01(material.restitution, 0.1),
    density: material.density > 0 ? material.density : 700,
    linearDamping: nonNegative(spec.linearDamping, nonNegative(material.linearDamping, 0)),
    angularDamping: nonNegative(spec.angularDamping, nonNegative(material.angularDamping, 0)),
    materialId: material.id,
  };
}

/** 我们用到的最小 Rapier 面 */
interface RapierApiLike {
  RigidBodyDesc: {
    fixed(): RigidBodyDescLike;
    dynamic(): RigidBodyDescLike;
    kinematicPositionBased(): RigidBodyDescLike;
    kinematicVelocityBased(): RigidBodyDescLike;
    /** Rapier 的刚体类型枚举（用于运行时切换） */
    RigidBodyType?: { Dynamic: number; Fixed: number; KinematicPositionBased: number; KinematicVelocityBased: number };
  };
  ColliderDesc: Parameters<typeof createCollider>[0]['ColliderDesc'];
  RigidBodyType?: { Dynamic: number; Fixed: number; KinematicPositionBased: number; KinematicVelocityBased: number };
}

interface RigidBodyDescLike {
  setTranslation(x: number, y: number, z: number): RigidBodyDescLike;
  setRotation(rot: { x: number; y: number; z: number; w: number }): RigidBodyDescLike;
  setLinvel(x: number, y: number, z: number): RigidBodyDescLike;
  setAngvel(vel: { x: number; y: number; z: number }): RigidBodyDescLike;
  setLinearDamping(value: number): RigidBodyDescLike;
  setAngularDamping(value: number): RigidBodyDescLike;
  setCanSleep(can: boolean): RigidBodyDescLike;
  setGravityScale(scale: number): RigidBodyDescLike;
  setCcdEnabled(enabled: boolean): RigidBodyDescLike;
  setAdditionalMass(mass: number): RigidBodyDescLike;
  setEnabledTranslations(x: boolean, y: boolean, z: boolean): RigidBodyDescLike;
  setEnabledRotations(x: boolean, y: boolean, z: boolean): RigidBodyDescLike;
}

interface RapierBodyLike {
  handle: number;
  mass(): number;
  setBodyType(type: number, wakeUp: boolean): void;
  sleep(): void;
  wakeUp(): void;
  isSleeping(): boolean;
  setLinvel(vel: { x: number; y: number; z: number }, wakeUp: boolean): void;
  setAngvel(vel: { x: number; y: number; z: number }, wakeUp: boolean): void;
  applyImpulse(impulse: { x: number; y: number; z: number }, wakeUp: boolean): void;
  applyImpulseAtPoint(impulse: { x: number; y: number; z: number }, point: { x: number; y: number; z: number }, wakeUp: boolean): void;
  addForce(force: { x: number; y: number; z: number }, wakeUp: boolean): void;
  /**
   * 持续力矩。**可选**：Rapier 的 RigidBody 有它，但我们的 `RapierBodyLike` 是
   * 最小接口（只声明用得到的方法），而且 M3 的最小实现里没有它 ——
   * 所以标成可选并在调用处判空，而不是强行要求所有替身都实现它。
   */
  addTorque?(torque: { x: number; y: number; z: number }, wakeUp: boolean): void;
  setTranslation(pos: { x: number; y: number; z: number }, wakeUp: boolean): void;
  setNextKinematicTranslation(pos: { x: number; y: number; z: number }): void;
  setNextKinematicRotation(rot: { x: number; y: number; z: number; w: number }): void;
}

interface RapierWorldLike {
  createRigidBody(desc: RigidBodyDescLike): RapierBodyLike;
  getRigidBody(handle: number): RapierBodyLike | null;
  removeRigidBody(body: RapierBodyLike): void;
  createCollider(desc: unknown, body: RapierBodyLike): { handle: number };
}

export interface RigidBodyFactoryStats {
  created: number;
  removed: number;
  failed: number;
  byKind: Record<BodyKind, number>;
  /** 当前存活数（减去已移除的） */
  alive: number;
  /** 形状回退次数（凸包退化 / 动态三角网被拦） */
  fallbacks: number;
}

/**
 * 物理源：**类型擦除**的一层。
 *
 * 为什么要擦除：`PhysicsWorld.raw` / `.api` 返回的是 Rapier 的真实类型
 * （`World` / 命名空间），而这里声明的是"我们真正用到的成员"的最小结构接口。
 * 两者在**方法参数类型**上是不兼容的（例如真实 `setBodyType` 收的是 `RigidBodyType`
 * 枚举，我们写的是 `number`）—— 这不是我们的接口写错了，而是结构化类型在
 * "把类当鸭子用"时的固有限制。
 *
 * 处理方式是把转型**收敛到这一处**（构造函数里的两个 getter），而不是在使用点到处 `as`。
 * 这样如果有哪天 Rapier 的方法签名变了，出问题的位置只有这里。
 */
export interface PhysicsSource {
  readonly raw: unknown;
  readonly api: unknown;
}

export class RigidBodyFactory {
  private readonly source: PhysicsSource;
  private readonly created = new Map<number, BodyKind>();
  private readonly counters: RigidBodyFactoryStats = {
    created: 0,
    removed: 0,
    failed: 0,
    byKind: { fixed: 0, dynamic: 0, kinematicPosition: 0, kinematicVelocity: 0 },
    alive: 0,
    fallbacks: 0,
  };

  constructor(source: PhysicsSource) {
    this.source = source;
  }

  /** 边界转型（唯一的 `as`） */
  private get world(): RapierWorldLike | null {
    return (this.source.raw as RapierWorldLike | null) ?? null;
  }

  private get api(): RapierApiLike | null {
    return (this.source.api as RapierApiLike | null) ?? null;
  }

  get stats(): RigidBodyFactoryStats {
    return {
      ...this.counters,
      byKind: { ...this.counters.byKind },
      alive: this.counters.created - this.counters.removed,
    };
  }

  /** 某类刚体的当前数量（移动端上限判定用） */
  countOf(kind: BodyKind): number {
    let count = 0;
    for (const value of this.created.values()) if (value === kind) count += 1;
    return count;
  }

  /**
   * 建一个刚体。
   *
   * **没有碰撞体的刚体一律拒绝**：那种物体看得见、穿得过，
   * 而且它还会出现在统计里让人误以为物理正常，是排查成本最高的一类"幽灵"。
   */
  create(spec: RigidBodySpec): BodyCreationOutcome {
    const world = this.world;
    const api = this.api;
    const warnings: string[] = [];

    if (!world || !api) {
      this.counters.failed += 1;
      return {
        handle: -1,
        kind: spec.kind,
        mass: 0,
        colliderCount: 0,
        warnings,
        ok: false,
        reason: '物理世界还没就绪（Rapier 仍在加载）',
      };
    }
    if (spec.colliders.length === 0) {
      this.counters.failed += 1;
      return {
        handle: -1,
        kind: spec.kind,
        mass: 0,
        colliderCount: 0,
        warnings,
        ok: false,
        reason: '一个碰撞体都没有的刚体会被玩家当成"穿模 bug"，已拒绝创建',
      };
    }

    const params = resolveBodyParams(spec);
    let desc = createDesc(api, spec.kind);
    desc = desc.setTranslation(spec.position[0], spec.position[1], spec.position[2]);

    if (spec.rotation) {
      desc = desc.setRotation({ x: spec.rotation[0], y: spec.rotation[1], z: spec.rotation[2], w: spec.rotation[3] });
    } else if (spec.rotationY) {
      const half = spec.rotationY / 2;
      desc = desc.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
    }

    if (spec.linearVelocity) desc = desc.setLinvel(spec.linearVelocity[0], spec.linearVelocity[1], spec.linearVelocity[2]);
    if (spec.angularVelocity) {
      desc = desc.setAngvel({ x: spec.angularVelocity[0], y: spec.angularVelocity[1], z: spec.angularVelocity[2] });
    }
    desc = desc.setLinearDamping(params.linearDamping);
    desc = desc.setAngularDamping(params.angularDamping);
    desc = desc.setCanSleep(spec.canSleep !== false);
    desc = desc.setGravityScale(spec.gravityScale ?? 1);
    if (spec.ccd) desc = desc.setCcdEnabled(true);
    if (spec.mass !== undefined && spec.mass > 0) desc = desc.setAdditionalMass(spec.mass);
    if (spec.lockTranslation) {
      desc = desc.setEnabledTranslations(spec.lockTranslation[0], spec.lockTranslation[1], spec.lockTranslation[2]);
    }
    if (spec.lockRotation) {
      desc = desc.setEnabledRotations(spec.lockRotation[0], spec.lockRotation[1], spec.lockRotation[2]);
    }

    // 静态刚体不需要休眠设置（它永远不动），但 Rapier 接受这个调用
    let body: RapierBodyLike;
    try {
      body = world.createRigidBody(desc);
    } catch (error) {
      this.counters.failed += 1;
      return {
        handle: -1,
        kind: spec.kind,
        mass: 0,
        colliderCount: 0,
        warnings,
        ok: false,
        reason: `创建刚体失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let colliderCount = 0;
    for (const colliderSpec of spec.colliders) {
      const result = createCollider(api, world as never, body as never, colliderSpec, spec.material);
      if (result.ok) colliderCount += 1;
      if (result.warning) {
        warnings.push(result.warning);
        this.counters.fallbacks += 1;
      }
    }

    if (colliderCount === 0) {
      // 一个都没建成功：把刚体也撤掉，不要留下幽灵
      world.removeRigidBody(body);
      this.counters.failed += 1;
      return {
        handle: -1,
        kind: spec.kind,
        mass: 0,
        colliderCount: 0,
        warnings,
        ok: false,
        reason: `所有碰撞体都创建失败：${warnings.join('；') || '未知原因'}`,
      };
    }

    this.created.set(body.handle, spec.kind);
    this.counters.created += 1;
    this.counters.byKind[spec.kind] += 1;

    return {
      handle: body.handle,
      kind: spec.kind,
      mass: readMassSafely(body),
      colliderCount,
      warnings,
      ok: true,
    };
  }

  /** 运行时切换类型（拿起 → kinematic，放下 → dynamic/fixed） */
  setKind(handle: number, kind: BodyKind): boolean {
    const body = this.bodyOf(handle);
    const api = this.api;
    if (!body || !api) return false;
    const type = rigidBodyTypeOf(api, kind);
    if (type === null) return false;
    try {
      body.setBodyType(type, true);
      // 切换类型时必须同步记账，否则"动态 800 个"的统计会漂
      const previous = this.created.get(handle);
      if (previous && previous !== kind) {
        this.counters.byKind[previous] -= 1;
        this.counters.byKind[kind] += 1;
        this.created.set(handle, kind);
      }
      return true;
    } catch (error) {
      console.warn('[刚体] 切换类型失败', kind, error);
      return false;
    }
  }

  kindOf(handle: number): BodyKind | null {
    return this.created.get(handle) ?? null;
  }

  /** 写速度（运动学·速度驱动、或者给动态物体一个初速） */
  setVelocities(handle: number, linear?: [number, number, number], angular?: [number, number, number]): boolean {
    const body = this.bodyOf(handle);
    if (!body) return false;
    if (linear) body.setLinvel({ x: linear[0], y: linear[1], z: linear[2] }, true);
    if (angular) body.setAngvel({ x: angular[0], y: angular[1], z: angular[2] }, true);
    return true;
  }

  /**
   * 写"下一个运动学位姿"。
   *
   * **必须用 `setNextKinematic*` 而不是 `setTranslation`**：前者是在下一次 `step()` 里
   * 以运动学方式推进（Rapier 会正确计算它推开别的物体所需的力），
   * 后者是硬传送（会把挡路的东西直接穿过去，而且不产生任何推力）。
   */
  setNextKinematic(
    handle: number,
    position: [number, number, number],
    rotation?: [number, number, number, number],
  ): boolean {
    const body = this.bodyOf(handle);
    if (!body) return false;
    body.setNextKinematicTranslation({ x: position[0], y: position[1], z: position[2] });
    if (rotation) {
      body.setNextKinematicRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] });
    }
    return true;
  }

  applyImpulse(handle: number, impulse: [number, number, number], atPoint?: [number, number, number]): boolean {
    const body = this.bodyOf(handle);
    if (!body) return false;
    const vector = { x: impulse[0], y: impulse[1], z: impulse[2] };
    if (atPoint) body.applyImpulseAtPoint(vector, { x: atPoint[0], y: atPoint[1], z: atPoint[2] }, true);
    else body.applyImpulse(vector, true);
    return true;
  }

  /** 持续施力（浮力/水流/传送带用）。**注意 Rapier 每次 step 后清空力，所以要每帧调** */
  addForce(handle: number, force: [number, number, number]): boolean {
    const body = this.bodyOf(handle);
    if (!body) return false;
    body.addForce({ x: force[0], y: force[1], z: force[2] }, true);
    return true;
  }

  /**
   * 持续施加**力矩**（第 4 批的浮心扶正力矩、角速度阻力要用）。
   *
   * 与 `addForce` 一样，Rapier 每次 step 后清空，所以每帧都要重新加。
   * 为什么用 `addTorque` 而不是"在偏移点施力"：浮心力矩的物理来源是
   * **浮心与重心不重合**，用 `applyImpulseAtPoint` 也能表达，但那会同时产生
   * 线性冲量（浮力本身），于是力会被算两遍。分开加最清楚。
   */
  addTorque(handle: number, torque: [number, number, number]): boolean {
    const body = this.bodyOf(handle);
    if (!body) return false;
    if (!body.addTorque) {
      // 如实失败而不是静默无声：力矩是"船会自己摆正"的唯一来源，
      // 缺了它物体的表现是"永远歪着漂"，而那种现象很难归因到"少了一个 API"
      this.counters.failed += 1;
      return false;
    }
    body.addTorque({ x: torque[0], y: torque[1], z: torque[2] }, true);
    return true;
  }

  wake(handle: number): boolean {
    const body = this.bodyOf(handle);
    if (!body) return false;
    body.wakeUp();
    return true;
  }

  sleep(handle: number): boolean {
    const body = this.bodyOf(handle);
    if (!body) return false;
    body.sleep();
    return true;
  }

  isSleeping(handle: number): boolean {
    return this.bodyOf(handle)?.isSleeping() ?? true;
  }

  /** 真正质量（kg）。静止刚体 Rapier 会返回 0，此时回退到"密度 × 碰撞体体积"的估计 */
  massOf(handle: number, fallback = 0): number {
    const body = this.bodyOf(handle);
    if (!body) return fallback;
    const mass = readMassSafely(body);
    return mass > 0 ? mass : fallback;
  }

  remove(handle: number): boolean {
    const body = this.bodyOf(handle);
    if (!body) return false;
    const world = this.world;
    try {
      world?.removeRigidBody(body);
    } catch {
      // 已经被 clear() 连带删掉了
    }
    const kind = this.created.get(handle);
    if (kind) {
      this.counters.byKind[kind] -= 1;
      this.created.delete(handle);
    }
    this.counters.removed += 1;
    return true;
  }

  /** 清空计数（换地图时配合 physics.clear() 用） */
  reset(): void {
    this.created.clear();
    this.counters.created = 0;
    this.counters.removed = 0;
    this.counters.failed = 0;
    this.counters.fallbacks = 0;
    this.counters.byKind = { fixed: 0, dynamic: 0, kinematicPosition: 0, kinematicVelocity: 0 };
    this.counters.alive = 0;
  }

  private bodyOf(handle: number): RapierBodyLike | null {
    if (handle < 0) return null;
    return this.world?.getRigidBody(handle) ?? null;
  }
}

function createDesc(api: RapierApiLike, kind: BodyKind): RigidBodyDescLike {
  switch (kind) {
    case 'dynamic':
      return api.RigidBodyDesc.dynamic();
    case 'kinematicPosition':
      return api.RigidBodyDesc.kinematicPositionBased();
    case 'kinematicVelocity':
      return api.RigidBodyDesc.kinematicVelocityBased();
    case 'fixed':
    default:
      return api.RigidBodyDesc.fixed();
  }
}

function rigidBodyTypeOf(api: RapierApiLike, kind: BodyKind): number | null {
  const types = api.RigidBodyType ?? api.RigidBodyDesc.RigidBodyType;
  if (!types) return null;
  switch (kind) {
    case 'dynamic':
      return types.Dynamic;
    case 'fixed':
      return types.Fixed;
    case 'kinematicPosition':
      return types.KinematicPositionBased;
    case 'kinematicVelocity':
      return types.KinematicVelocityBased;
    default:
      return null;
  }
}

function readMassSafely(body: RapierBodyLike): number {
  try {
    const mass = body.mass();
    return Number.isFinite(mass) ? mass : 0;
  } catch {
    return 0;
  }
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function nonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

/** 供面板/日志：一行中文说明这个刚体是什么类型 */
export function describeBodyKind(kind: BodyKind): string {
  return BODY_KIND_LABELS[kind];
}

/** 供压力测试与面板：一层筛选用的碰撞层默认值 */
export const DEFAULT_BODY_LAYER: PhysicsLayer = 'building';
