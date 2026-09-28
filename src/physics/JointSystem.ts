/**
 * 关节系统（问题 A.3）：把「两个刚体怎么连在一起」变成真实约束。
 *
 * 支持的六种关节（用户明确要求的六类组合玩法）：
 * | 本项目 type | Rapier 描述符 | 玩法 |
 * |---|---|---|
 * | `fixed`     | `JointData.fixed`              | 门框与门、焊死的两块板 |
 * | `revolute`  | `JointData.revolute`           | 门轴、轮子（可限位 + 可带电机） |
 * | `prismatic` | `JointData.prismatic`          | 抽屉、活塞（可限位 + 可带电机） |
 * | `ball`      | `JointData.spherical`          | 机械臂、灯笼吊点 |
 * | `rope`      | `JointData.rope`               | 吊桥、吊灯（只拉不推） |
 * | `spring`    | `JointData.spring`             | 弹簧、悬挂（刚度 + 阻尼） |
 *
 * ---------------------------------------------------------------------------
 * 实测的 Rapier 0.21.0 签名（不是凭记忆写的，读的是
 * `node_modules/@dimforge/rapier3d-compat/dist/dynamics/impulse_joint.d.ts`）：
 *
 *   static fixed(anchor1: Vector, frame1: Rotation, anchor2: Vector, frame2: Rotation): JointData;
 *   static spring(rest_length: number, stiffness: number, damping: number,
 *                 anchor1: Vector, anchor2: Vector): JointData;
 *   static rope(length: number, anchor1: Vector, anchor2: Vector): JointData;
 *   static spherical(anchor1: Vector, anchor2: Vector): JointData;
 *   static prismatic(anchor1: Vector, anchor2: Vector, axis: Vector): JointData;
 *   static revolute(anchor1: Vector, anchor2: Vector, axis: Vector): JointData;
 *   static revoluteWithAxes(anchor1: Vector, anchor2: Vector,
 *                           axis1: Vector, axis2: Vector): JointData;
 *
 *   World.createImpulseJoint(params: JointData, parent1: RigidBody,
 *                            parent2: RigidBody, wakeUp: boolean): ImpulseJoint;
 *   World.getImpulseJoint(handle: ImpulseJointHandle): ImpulseJoint;
 *   World.removeImpulseJoint(joint: ImpulseJoint, wakeUp: boolean): void;
 *
 *   UnitImpulseJoint（revolute / prismatic 的基类）:
 *     setLimits(min: number, max: number): void;
 *     setMotorMaxForce(maxForce: number): void;
 *     configureMotorModel(model: MotorModel): void;
 *     configureMotorVelocity(targetVel: number, factor: number): void;
 *     configureMotorPosition(targetPos: number, stiffness: number, damping: number): void;
 *
 * ⚠ 两点必须说明的偏差（任务书里的写法在 0.21.0 上不成立，以实测为准）：
 * 1. **0.21.0 没有 `ImpulseJoint.setMotorVelocity(speed, maxForce)`** —— 整个包里
 *    grep 不到这个符号，电机改成 `configureMotorVelocity(speed, factor)` +
 *    `setMotorMaxForce(maxForce)`（`factor` 是逼近目标速度的阻尼系数，见下面 MOTOR_FACTOR）。
 * 2. `JointData.rope` / `JointData.spring` 都**存在**，所以绳索/弹簧走原生约束求解器，
 *    update() 里不再额外施力（双重施力会把绳子拉成弹簧，抖到飞起）。
 *
 * ---------------------------------------------------------------------------
 * 两个坐标系约定（踩过坑的地方）：
 * - Rapier 的 `anchor1` / `anchor2` 是**各自刚体局部空间**的点，而 `JointConfig.anchor`
 *   按 data 层的契约是**世界坐标**，所以这里用 `rotateInverse(q, anchor - t)` 转一次；
 * - `fixed` 的 `frame1` / `frame2` 是"关节参考朝向"。想要"焊死但保持现在这个相对姿势"
 *   （而不是把两个物体的朝向强行对齐），取 frame1 = 单位四元数、frame2 = q2⁻¹ · q1。
 *
 * 所有 Rapier 调用都在 try/catch 里：wasm 侧抛异常会直接把整个页面打成白屏。
 */

import { DEFAULT_JOINT_AXIS, JOINT_TYPE_LABELS } from '../data/jointTypes';
import type { JointConfig, JointType, MotorConfig, MotorMode, JointLimits } from '../data/jointTypes';
import type { PhysicsWorld } from './PhysicsWorld';
import {
  applyLimits,
  applyMotor,
  resolveMotor,
  JOINT_MOTOR_SUPPORT,
  type ResolvedMotor,
  type UnitJointLike,
} from './JointFactory';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface JointRecord {
  id: number;
  config: JointConfig;
  /** Rapier 里的关节句柄（ImpulseJoint） */
  handle: number;
  /** 用来按类型分组统计 */
  type: JointType;
  broken: boolean;
}

export interface JointSystemStats {
  total: number;
  byType: Record<JointType, number>;
  broken: number;
  /** 上一次同步（把物理位姿写回建筑）耗时 */
  ms: number;
}

/** 内部条目：`JointRecord` 是给外部的契约，这些额外字段是实现细节，不外泄。 */
interface JointEntry extends JointRecord {
  /** 主动体刚体 handle */
  bodyA: number;
  /** 从动体刚体 handle；-1 表示连到世界（用一个静态锚点刚体顶替） */
  bodyB: number;
  /** bodyB === -1 时我们自己造的静态锚点刚体 handle（否则 -1） */
  anchorBody: number;
  /** 锚点在 bodyA / bodyB 局部空间的坐标（挂载重连时复用，跟物体一起动） */
  localA: Vec3;
  localB: Vec3;
  /** 轴在 bodyA / bodyB 局部空间的单位向量（转轴/导轨用） */
  axisA: Vec3;
  axisB: Vec3;
  /** rope / spring 的静止长度 */
  restLength: number;
  /** 当前被哪些"正在被玩家搬动"的刚体挂起 */
  suspendedBy: Set<number>;
}

/** 四元数（只在本文件内部用，避免和 Rapier 的 Rotation 混在一起） */
interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

type RapierWorld = import('@dimforge/rapier3d-compat').World;
type RapierBody = import('@dimforge/rapier3d-compat').RigidBody;
type RapierImpulseJoint = import('@dimforge/rapier3d-compat').ImpulseJoint;
type RapierUnitJoint = import('@dimforge/rapier3d-compat').UnitImpulseJoint;
type RapierJointData = import('@dimforge/rapier3d-compat').JointData;

/** 弹簧默认刚度（N/m）与阻尼 */
const DEFAULT_STIFFNESS = 120;
const DEFAULT_DAMPING = 6;
/** 电机"逼近目标速度"的阻尼系数（configureMotorVelocity 的第二个参数） */
const MOTOR_FACTOR = 12;
/** 电机默认最大出力 */
const DEFAULT_MOTOR_FORCE = 200;
/** 绳索/弹簧被拉长到这个倍数以上时，才补一记恢复冲量（正常拉伸交给原生求解器） */
const OVERSHOOT_RATIO = 2;
/** 失效关节的巡检间隔（毫秒）：不必每帧都去问 wasm"你还活着吗" */
const VALIDITY_INTERVAL_MS = 250;

// ------------------------------------------------------------------ 四元数小工具

function qConj(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** a · b（先转 a 再转 b） */
function qMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** 用 q 旋转向量 v */
function rotate(q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** 用 q 的逆旋转向量 v（世界 → 局部） */
function rotateInverse(q: Quat, v: Vec3): Vec3 {
  return rotate(qConj(q), v);
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-9) return { x: 0, y: 1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function emptyByType(): Record<JointType, number> {
  return { fixed: 0, revolute: 0, prismatic: 0, ball: 0, rope: 0, spring: 0 };
}

/** Node / 浏览器都能用的计时器 */
function nowStamp(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * `JointConfig.bodyA` / `bodyB` 在 data 层的类型契约是 `string`
 * （模板里是下标字符串，运行时是实例 id 字符串）。在物理层这里，
 * 传进来的约定是**刚体 handle 的十进制字符串**；空串 = 连到世界。
 *
 * ⚠ 这里**故意不用 `/^\d+$/` 校验**，原因是个实测出来的坑：
 * rapier3d-compat 0.21.0 的 wasm 把 u32 handle 的**位模式**当成 f64 交回 JS，
 * 于是第 2 个刚体的 handle 不是 `1` 而是 `5e-324`（= 位模式 0x1 的最小非规格化
 * double），第 3 个是 `1e-323`……`String(handle)` 出来是科学计数法。
 * `Number()` 能正确还原这种写法，正则不能。（handle 是同一套数值，Rapier 自己
 * 的 `getRigidBody()` 认它，所以只影响"字符串 ↔ 数值"这一步。）
 */
function parseBodyRef(ref: string): number {
  const text = ref.trim();
  if (text === '') return -1;
  const value = Number(text);
  return Number.isFinite(value) ? value : -1;
}

/** 判断 `ref` 是不是"合法但指向世界"的写法（空串） */
function isWorldRef(ref: string): boolean {
  return ref.trim() === '';
}

export class JointSystem {
  /** 活着的关节 */
  private readonly entries: JointEntry[] = [];
  /** 物理还没就绪时排队的配置（Rapier 是动态 import 的，必须能补建） */
  private pending: JointConfig[] = [];
  private nextId = 1;
  /** 关节 id → 已解析的马达配置（只有装过马达的关节才有） */
  private readonly motors = new Map<number, ResolvedMotor>();
  /** 累计失效关节数（`clear()` 才归零） */
  private brokenTotal = 0;
  private lastUpdateMs = 0;
  private lastReady = false;
  private lastValidityCheckMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly physics: PhysicsWorld) {}

  // ---------------------------------------------------------------- 状态

  /** 是否可用（Rapier 加载成功） */
  get isReady(): boolean {
    return this.physics.isReady;
  }

  get count(): number {
    return this.entries.length;
  }

  /** 排队等待物理就绪的关节数（UI 可以用来显示"等待物理"） */
  get pendingCount(): number {
    return this.pending.length;
  }

  get stats(): JointSystemStats {
    const byType = emptyByType();
    let broken = 0;
    for (const entry of this.entries) {
      byType[entry.type]++;
      if (entry.broken) broken++;
    }
    return {
      total: this.entries.length,
      byType,
      // 已被清理掉的失效关节也算进来，否则"坏了又立刻删"永远看不到
      broken: broken + this.brokenTotal,
      ms: this.lastUpdateMs,
    };
  }

  /** 某个关节的人类可读名字（调试面板 / 错误提示用） */
  describe(id: number): string {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return `关节 ${id} 不存在`;
    const label = entry.config.label ?? JOINT_TYPE_LABELS[entry.type];
    return `${JOINT_TYPE_LABELS[entry.type]}「${label}」(#${id})`;
  }

  // ---------------------------------------------------------------- 建 / 删

  /**
   * 建一个关节。bodyA/bodyB 是 PhysicsWorld 的刚体句柄（写在 JointConfig 的
   * `bodyA`/`bodyB` 字符串里，见 parseBodyRef）；bodyB 传空串表示连到「世界」（静态锚点）。
   *
   * @returns 关节 id；物理未就绪或配置非法时返回 -1（不抛异常）
   */
  add(rawConfig: JointConfig): number {
    // ── 归一化：把"世界"那一侧换到 B 位 ──────────────────────────────────
    // 数据里两种写法都有：`combos.ts` 有 8 处把世界写在 `bodyA`（空串），而下面这套实现
    // 只认 `bodyB` 为空串才是世界（那时才会去造静态锚点刚体）。原先 `bodyA` 为空串会在
    // 下面 `bodyA < 0` 处直接返回 -1，于是这些组合的门不会绕框转、齿轮不转、吊桥不落 ——
    // 而且 `ComboBuilder` 把 -1 当成"物理还没就绪"，提示"会自动补建"，永远等不到。
    //
    // 为什么互换是安全的：关节锚点是**世界坐标**（`config.anchor`），下面两侧各自用
    // `rotateInverse` 算相对自己刚体的局部偏移，所以 A/B 只是"谁是第一个刚体"，
    // 对锚点与轴向没有影响。这里不改数据文件，是因为归一化放在这一层能同时修好
    // 组合、示例、存档导入等**所有**调用方。
    const config: JointConfig = isWorldRef(rawConfig.bodyA) && !isWorldRef(rawConfig.bodyB)
      ? { ...rawConfig, bodyA: rawConfig.bodyB, bodyB: '' }
      : rawConfig;

    if (!this.isReady) {
      // Rapier 还在动态 import —— 排队，等 update() 里发现就绪后自动补建
      this.pending.push({ ...config });
      return -1;
    }
    const world = this.physics.raw;
    const api = this.physics.api;
    if (!world || !api) {
      this.pending.push({ ...config });
      return -1;
    }

    const bodyA = parseBodyRef(config.bodyA);
    if (bodyA < 0) return -1;
    const rbA = this.bodyOf(world, bodyA);
    if (!rbA) return -1;

    const worldAnchor: Vec3 = {
      x: config.anchor[0],
      y: config.anchor[1],
      z: config.anchor[2],
    };

    let bodyB = -1;
    let anchorBody = -1;
    let rbB: RapierBody | null = null;

    if (isWorldRef(config.bodyB)) {
      // 连到世界：Rapier 的关节必须挂在两个刚体之间，所以造一个静态锚点刚体
      rbB = this.createAnchorBody(world, worldAnchor);
      if (!rbB) return -1;
      bodyB = rbB.handle;
      anchorBody = rbB.handle;
    } else {
      bodyB = parseBodyRef(config.bodyB);
      if (bodyB < 0) return -1;
      rbB = this.bodyOf(world, bodyB);
      if (!rbB) return -1;
    }

    const poseA = this.poseOf(rbA);
    const poseB = this.poseOf(rbB);
    const axisWorld: Vec3 = normalize({
      x: config.axis?.[0] ?? DEFAULT_JOINT_AXIS[0],
      y: config.axis?.[1] ?? DEFAULT_JOINT_AXIS[1],
      z: config.axis?.[2] ?? DEFAULT_JOINT_AXIS[2],
    });

    const localA = rotateInverse(poseA.q, {
      x: worldAnchor.x - poseA.t.x,
      y: worldAnchor.y - poseA.t.y,
      z: worldAnchor.z - poseA.t.z,
    });
    const localB = rotateInverse(poseB.q, {
      x: worldAnchor.x - poseB.t.x,
      y: worldAnchor.y - poseB.t.y,
      z: worldAnchor.z - poseB.t.z,
    });
    // rope / spring 没给 length 时，静止长度 = 建关节这一刻两个锚点的距离
    const anchorAWorld = this.anchorWorld(rbA, localA);

    const entry: JointEntry = {
      id: this.nextId++,
      config: { ...config },
      handle: -1,
      type: config.type,
      broken: false,
      bodyA,
      bodyB,
      anchorBody,
      localA,
      localB,
      axisA: rotateInverse(poseA.q, axisWorld),
      axisB: rotateInverse(poseB.q, axisWorld),
      restLength: Math.max(0.05, config.length ?? distance(anchorAWorld, worldAnchor)),
      suspendedBy: new Set<number>(),
    };

    const joint = this.createRapierJoint(world, api, entry);
    if (!joint) {
      if (anchorBody >= 0) this.physics.removeBody(anchorBody);
      return -1;
    }
    entry.handle = joint.handle;
    this.entries.push(entry);
    return entry.id;
  }

  /** 移除（按 id） */
  remove(id: number): boolean {
    const index = this.entries.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.destroyEntry(this.entries[index]);
    this.entries.splice(index, 1);
    return true;
  }

  /** 移除所有连到某个刚体的关节（建筑被删除时调用） */
  removeByBody(handle: number): number {
    if (handle < 0) return 0;
    let removed = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.bodyA !== handle && entry.bodyB !== handle) continue;
      this.destroyEntry(entry);
      this.entries.splice(i, 1);
      removed++;
    }
    return removed;
  }

  clear(): void {
    this.motors.clear();
    for (const entry of [...this.entries]) this.destroyEntry(entry);
    this.entries.length = 0;
    this.pending = [];
    this.brokenTotal = 0;
    this.lastUpdateMs = 0;
  }

  dispose(): void {
    this.clear();
  }

  // ---------------------------------------------------------------- 每帧

  /**
   * 每帧调用。
   * @param dtSeconds 本帧物理时间步（秒），绳索/弹簧异常拉伸的补偿冲量要用它折算
   * @param nowMs 当前时间戳（毫秒），用来节流失效巡检
   */
  update(dtSeconds: number, nowMs: number): void {
    const started = nowStamp();

    // 1) Rapier 可能刚刚加载完 —— 把排队里的关节补建出来
    const ready = this.isReady;
    if (ready && !this.lastReady && this.pending.length > 0) {
      const queued = this.pending;
      this.pending = [];
      for (const config of queued) this.add(config);
    }
    this.lastReady = ready;
    if (!ready) {
      this.lastUpdateMs = nowStamp() - started;
      return;
    }

    // 2) 失效清理：建筑被删/世界被清空后，句柄就悬空了。
    //    没必要每帧都问 wasm，250ms 巡检一次足够。
    if (nowMs - this.lastValidityCheckMs >= VALIDITY_INTERVAL_MS) {
      this.lastValidityCheckMs = nowMs;
      this.sweepInvalid();
    }

    // 3) 绳索/弹簧的受力
    //    Rapier 0.21 有原生 rope / spring 约束，正常拉伸完全交给求解器（否则双重施力会震荡）。
    //    这里只兜一个极端情况：被拉长到静止长度的 OVERSHOOT_RATIO 倍以上（穿透/卡住导致），
    //    补一记沿绳方向的恢复冲量把它拽回来。
    if (dtSeconds > 0) this.applyOvershootCorrection(dtSeconds);

    this.lastUpdateMs = nowStamp() - started;
  }

  // ---------------------------------------------------------------- 查询

  /** 关节两端的当前世界坐标（调试画线用） */
  endpointOf(id: number): { a: Vec3; b: Vec3 } | null {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return null;
    const joint = this.jointOf(entry);
    if (!joint) return null;
    try {
      const bodyA = joint.body1();
      const bodyB = joint.body2();
      if (!bodyA || !bodyB) return null;
      return {
        a: this.anchorWorld(bodyA, this.vecOf(joint.anchor1())),
        b: this.anchorWorld(bodyB, this.vecOf(joint.anchor2())),
      };
    } catch {
      // 关节刚被 wasm 侧回收，这一帧不画线就好
      return null;
    }
  }

  /**
   * 玩家把物体拿起来移动时，暂时禁用相关关节（避免物理把物体从手里拽走），
   * 松手后恢复。
   *
   * 实现说明（诚实交代）：Rapier 0.21 的 ImpulseJoint **没有** enabled 开关，
   * 所以这里是真的把关节从世界里摘掉、恢复时按当初存在条目里的**局部锚点**重建 ——
   * 局部锚点跟着刚体走，所以重建后是"在新的相对姿势上重新连上"，
   * 这正是"搬着东西走、松手后关节还在那里"的期望行为。
   */
  setSuspended(handle: number, suspended: boolean): void {
    if (handle < 0) return;
    for (const entry of this.entries) {
      if (entry.bodyA !== handle && entry.bodyB !== handle) continue;
      if (suspended) {
        entry.suspendedBy.add(handle);
        this.destroyRapierJoint(entry);
      } else {
        entry.suspendedBy.delete(handle);
        if (entry.suspendedBy.size === 0 && entry.handle < 0) this.rebuild(entry);
      }
    }
  }

  /** 某个刚体当前是否处于挂起状态（UI 显示"关节已暂停"） */
  isSuspended(handle: number): boolean {
    return this.entries.some((entry) => entry.suspendedBy.has(handle));
  }

  /** 绳索/弹簧的长度可视化数据（调试渲染） */
  ropeSegments(): { id: number; a: Vec3; b: Vec3; restLength: number }[] {
    const out: { id: number; a: Vec3; b: Vec3; restLength: number }[] = [];
    for (const entry of this.entries) {
      if (entry.type !== 'rope' && entry.type !== 'spring') continue;
      const ends = this.endpointOf(entry.id);
      if (!ends) continue;
      out.push({ id: entry.id, a: ends.a, b: ends.b, restLength: entry.restLength });
    }
    return out;
  }

  // ---------------------------------------------------------------- 电机

  /**
   * 设置某个关节的电机（对应 data 层的 `MotorConfig`，也是 LogicLink
   * `set-motor` 动作的落点）。传 `speed = 0` 即"刹车"。
   */
  /**
   * 给关节装/改马达。
   *
   * 解析（类型是否支持、参数缺省、越界）全部交给 `JointFactory.resolveMotor()` ——
   * 那是本文件唯一允许决定"参数怎么理解"的地方。这里只负责找到关节并写进去。
   */
  setMotor(id: number, motor: MotorConfig): boolean {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return false;
    if (!JOINT_MOTOR_SUPPORT[entry.type]) {
      console.warn(
        `[关节] ${entry.type} 关节不支持马达：${resolveMotor(entry.type, motor).reason ?? ''}`,
      );
      return false;
    }

    const resolved = resolveMotor(entry.type, motor);
    if (!resolved.ok || !resolved.motor) return false;
    for (const warning of resolved.motor.warnings) console.warn(`[关节] ${warning}`);

    entry.config.motorSpeed = resolved.motor.targetVel;
    entry.config.motorPosition = resolved.motor.targetPos;
    entry.config.motorMode = resolved.motor.mode;
    entry.config.motorForce = resolved.motor.maxForce;
    this.motors.set(id, resolved.motor);

    const joint = this.jointOf(entry);
    if (!joint) return false;
    return applyMotor(joint as unknown as UnitJointLike, resolved.motor);
  }

  /**
   * 只改目标位置（位置驱动模式的常用操作：开门 → 关门的另一个角度）。
   *
   * 单独一个方法而不是让调用方重新拼一份 `MotorConfig`：因为"当前是速度还是位置驱动"
   * 这个状态只有这里知道，让调用方拼就会拼错（把位置驱动的门当成速度驱动去改 speed）。
   */
  setMotorTarget(id: number, targetPosition: number): boolean {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return false;
    const current = this.motors.get(id);
    if (!current || current.mode !== 'position') return false;
    if (!Number.isFinite(targetPosition)) return false;

    const next: ResolvedMotor = { ...current, targetPos: targetPosition };
    this.motors.set(id, next);
    entry.config.motorPosition = targetPosition;

    const joint = this.jointOf(entry);
    if (!joint) return false;
    return applyMotor(joint as unknown as UnitJointLike, next);
  }

  /** 反转速度驱动马达的转向（UI 上的"反转"按钮） */
  reverseMotor(id: number): boolean {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return false;
    const current = this.motors.get(id);
    if (!current || current.mode !== 'velocity') return false;
    return this.setMotor(id, {
      jointIndex: id,
      mode: 'velocity',
      speed: -current.targetVel,
      maxForce: current.maxForce,
    });
  }

  /** 关掉马达（把最大出力压到最小，而不是删掉关节） */
  stopMotor(id: number): boolean {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return false;
    const current = this.motors.get(id);
    if (!current) return false;
    const joint = this.jointOf(entry);
    if (!joint) return false;
    try {
      // 速度归零 + 出力压到 1 N：关节还在，只是不再主动驱动
      (joint as unknown as UnitJointLike).setMotorMaxForce?.(1);
      (joint as unknown as UnitJointLike).configureMotorVelocity?.(0, 12);
      return true;
    } catch {
      return false;
    }
  }

  /** 某个关节的马达信息（面板显示） */
  motorOf(id: number): ResolvedMotor | null {
    return this.motors.get(id) ?? null;
  }

  /**
   * 列出**全部**关节（含没有马达的）。
   *
   * 编辑器和调试面板都需要这份列表：只列带电机的关节会让人以为"我接的关节消失了"，
   * 而 `motorJoints()` 的语义就是"带电机的"，不该被滥用成"所有关节"。
   */
  list(): { id: number; type: JointType; config: JointConfig; broken: boolean; suspended: boolean }[] {
    return this.entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      config: { ...entry.config },
      broken: entry.broken,
      suspended: entry.suspendedBy.size > 0,
    }));
  }

  /**
   * 运行时改某个关节的限位。
   *
   * 单独一个方法（而不是让调用方自己 `setLimits`）：因为"哪种关节支持限位"
   * 与"上下限要归一化"这两条规则都在 `JointFactory` 里，绕过它就会漏掉。
   */
  applyLimitsTo(id: number, limits: JointLimits | undefined): boolean {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return false;
    const joint = this.jointOf(entry);
    if (!joint) return false;
    const result = applyLimits(joint as unknown as UnitJointLike, limits);
    if (!result.applied) {
      console.warn(`[关节] 改限位失败：${result.note}`);
      return false;
    }
    entry.config.limits = limits ? { ...limits } : undefined;
    return true;
  }

  /** 当前所有带电机的关节（UI 开关列表用） */
  motorJoints(): { id: number; type: JointType; speed: number; maxForce: number; mode: MotorMode; targetPosition: number }[] {
    const out: { id: number; type: JointType; speed: number; maxForce: number; mode: MotorMode; targetPosition: number }[] = [];
    for (const entry of this.entries) {
      if (entry.config.motorSpeed === undefined && entry.config.motorPosition === undefined) continue;
      const resolved = this.motors.get(entry.id);
      out.push({
        id: entry.id,
        type: entry.type,
        speed: entry.config.motorSpeed ?? 0,
        mode: resolved?.mode ?? (entry.config.motorMode ?? 'velocity'),
        targetPosition: entry.config.motorPosition ?? resolved?.targetPos ?? 0,
        maxForce: entry.config.motorForce ?? DEFAULT_MOTOR_FORCE,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- 内部实现

  private bodyOf(world: RapierWorld, handle: number): RapierBody | null {
    try {
      const body = world.getRigidBody(handle);
      return body ?? null;
    } catch {
      return null;
    }
  }

  private poseOf(body: RapierBody): { t: Vec3; q: Quat } {
    const t = body.translation();
    const r = body.rotation();
    return {
      t: { x: t.x, y: t.y, z: t.z },
      q: { x: r.x, y: r.y, z: r.z, w: r.w },
    };
  }

  private vecOf(v: { x: number; y: number; z: number }): Vec3 {
    return { x: v.x, y: v.y, z: v.z };
  }

  /** 局部锚点 → 世界坐标 */
  private anchorWorld(body: RapierBody, local: Vec3): Vec3 {
    const pose = this.poseOf(body);
    const rotated = rotate(pose.q, local);
    return { x: pose.t.x + rotated.x, y: pose.t.y + rotated.y, z: pose.t.z + rotated.z };
  }

  /** 连到世界时用的静态锚点刚体 */
  private createAnchorBody(world: RapierWorld, at: Vec3): RapierBody | null {
    const api = this.physics.api;
    if (!api) return null;
    try {
      const desc = api.RigidBodyDesc.fixed().setTranslation(at.x, at.y, at.z);
      return world.createRigidBody(desc);
    } catch {
      return null;
    }
  }

  /** 按类型挑 Rapier 描述符并创建（含限位与电机） */
  private createRapierJoint(
    world: RapierWorld,
    api: NonNullable<PhysicsWorld['api']>,
    entry: JointEntry,
  ): RapierImpulseJoint | null {
    const rbA = this.bodyOf(world, entry.bodyA);
    const rbB = this.bodyOf(world, entry.bodyB);
    if (!rbA || !rbB) return null;
    try {
      const data = this.buildJointData(api, entry, rbA, rbB);
      if (!data) return null;
      const joint = world.createImpulseJoint(data, rbA, rbB, true);
      this.applyLimitsAndMotor(joint, entry);
      return joint;
    } catch {
      return null;
    }
  }

  private buildJointData(
    api: NonNullable<PhysicsWorld['api']>,
    entry: JointEntry,
    rbA: RapierBody,
    rbB: RapierBody,
  ): RapierJointData | null {
    const localA: RapierJointData['anchor1'] = { ...entry.localA };
    const localB: RapierJointData['anchor2'] = { ...entry.localB };
    const axisA: RapierJointData['axis'] = normalize(entry.axisA);

    switch (entry.type) {
      case 'fixed': {
        // frame1 = 单位四元数、frame2 = q2⁻¹·q1 → 保持"现在这个相对姿势"焊死，
        // 而不是把两个物体的朝向强行掰成一致。
        const q1 = this.poseOf(rbA).q;
        const q2 = this.poseOf(rbB).q;
        const frame1 = { x: 0, y: 0, z: 0, w: 1 };
        const frame2 = qMul(qConj(q2), q1);
        return api.JointData.fixed(localA, frame1, localB, frame2);
      }
      case 'revolute': {
        // 两个刚体的朝向不同时，同一条世界轴在各自局部空间里是不同的向量，
        // 这时必须用 revoluteWithAxes，否则铰链会被扭住。
        const axisB = normalize(entry.axisB);
        const differs =
          Math.abs(axisA.x - axisB.x) + Math.abs(axisA.y - axisB.y) + Math.abs(axisA.z - axisB.z) >
          1e-3;
        return differs
          ? api.JointData.revoluteWithAxes(localA, localB, axisA, axisB)
          : api.JointData.revolute(localA, localB, axisA);
      }
      case 'prismatic':
        return api.JointData.prismatic(localA, localB, axisA);
      case 'ball':
        return api.JointData.spherical(localA, localB);
      case 'rope':
        return api.JointData.rope(Math.max(0.05, entry.restLength), localA, localB);
      case 'spring':
        return api.JointData.spring(
          Math.max(0.05, entry.restLength),
          entry.config.stiffness ?? DEFAULT_STIFFNESS,
          entry.config.damping ?? DEFAULT_DAMPING,
          localA,
          localB,
        );
      default:
        return null;
    }
  }

  private applyLimitsAndMotor(joint: RapierImpulseJoint, entry: JointEntry): void {
    const unit = joint as unknown as Partial<RapierUnitJoint>;
    // 限位与马达的**规则**都在 JointFactory 里（那里能单测）；这里只做调用与日志
    const limitResult = applyLimits(unit as unknown as UnitJointLike, entry.config.limits);
    if (!limitResult.applied && limitResult.note !== '没有限位') {
      console.warn(`[关节] ${limitResult.note}`);
    }
    const speed = entry.config.motorSpeed;
    if (speed !== undefined && Number.isFinite(speed)) {
      this.applyMotor(joint, speed, entry.config.motorForce ?? DEFAULT_MOTOR_FORCE);
    }
  }

  /**
   * 电机：0.21.0 没有 `setMotorVelocity`，等价写法是
   * `setMotorMaxForce(maxForce)` + `configureMotorVelocity(speed, factor)`。
   */
  private applyMotor(joint: RapierImpulseJoint, speed: number, maxForce: number): void {
    const unit = joint as unknown as Partial<RapierUnitJoint>;
    if (typeof unit.configureMotorVelocity !== 'function') return;
    if (typeof unit.setMotorMaxForce === 'function') {
      unit.setMotorMaxForce(Math.max(1, maxForce));
    }
    unit.configureMotorVelocity(speed, MOTOR_FACTOR);
  }

  private jointOf(entry: JointEntry): RapierImpulseJoint | null {
    const world = this.physics.raw;
    if (!world || entry.handle < 0) return null;
    try {
      const joint = world.getImpulseJoint(entry.handle);
      if (!joint) return null;
      return joint.isValid() ? joint : null;
    } catch {
      return null;
    }
  }

  /** 按条目里存的局部锚点重建关节（挂起恢复用） */
  private rebuild(entry: JointEntry): void {
    const world = this.physics.raw;
    const api = this.physics.api;
    if (!world || !api) return;
    const joint = this.createRapierJoint(world, api, entry);
    entry.handle = joint ? joint.handle : -1;
    entry.broken = !joint;
  }

  private destroyRapierJoint(entry: JointEntry): void {
    const world = this.physics.raw;
    if (!world || entry.handle < 0) {
      entry.handle = -1;
      return;
    }
    try {
      const joint = world.getImpulseJoint(entry.handle);
      if (joint) world.removeImpulseJoint(joint, true);
    } catch {
      // 已经被 wasm 侧回收了，忽略
    }
    entry.handle = -1;
  }

  /** 彻底销毁：关节 + 世界锚点刚体 */
  private destroyEntry(entry: JointEntry): void {
    this.destroyRapierJoint(entry);
    if (entry.anchorBody >= 0) {
      this.physics.removeBody(entry.anchorBody);
      entry.anchorBody = -1;
    }
  }

  /** 巡检：句柄悬空（建筑被删 / 世界被清空）的关节标记并清理 */
  private sweepInvalid(): void {
    const world = this.physics.raw;
    if (!world) return;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.suspendedBy.size > 0) continue; // 挂起中，句柄本来就是空的
      if (this.jointOf(entry) && this.bodyOf(world, entry.bodyA) && this.bodyOf(world, entry.bodyB)) {
        continue;
      }
      entry.broken = true;
      this.brokenTotal++;
      this.destroyEntry(entry);
      this.entries.splice(i, 1);
    }
  }

  /** 绳索/弹簧被异常拉长时的兜底恢复冲量 */
  private applyOvershootCorrection(dtSeconds: number): void {
    const world = this.physics.raw;
    if (!world) return;
    for (const entry of this.entries) {
      if (entry.type !== 'rope' && entry.type !== 'spring') continue;
      if (entry.suspendedBy.size > 0) continue;
      const ends = this.endpointOf(entry.id);
      if (!ends) continue;
      const stretch = distance(ends.a, ends.b);
      const limit = entry.restLength * OVERSHOOT_RATIO;
      if (stretch <= limit) continue;
      const rbA = this.bodyOf(world, entry.bodyA);
      const rbB = this.bodyOf(world, entry.bodyB);
      if (!rbA || !rbB) continue;
      // F = k·(x - rest)，冲量 = F·dt；两端各推一半，质量大的那头自然动得少
      const stiffness = entry.config.stiffness ?? DEFAULT_STIFFNESS;
      const overshoot = stretch - entry.restLength;
      const magnitude = Math.min(stiffness * overshoot * dtSeconds, 4000);
      const dx = (ends.b.x - ends.a.x) / stretch;
      const dy = (ends.b.y - ends.a.y) / stretch;
      const dz = (ends.b.z - ends.a.z) / stretch;
      try {
        rbB.applyImpulse(
          { x: -dx * magnitude * 0.5, y: -dy * magnitude * 0.5, z: -dz * magnitude * 0.5 },
          true,
        );
        rbA.applyImpulse(
          { x: dx * magnitude * 0.5, y: dy * magnitude * 0.5, z: dz * magnitude * 0.5 },
          true,
        );
      } catch {
        // 刚体这一帧没了，下次巡检会收拾
      }
    }
  }
}
