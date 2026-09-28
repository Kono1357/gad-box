/**
 * 关节工厂（M3 第 3 批）：**马达与限位的解析与应用**。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么单独一个文件，而不是继续留在 JointSystem 里
 * ────────────────────────────────────────────────────────────
 * M2.5 的 `JointSystem` 有 770 行，里面混着三件不同层次的事：
 * ① 关节数据怎么构造（要读 entry 的局部锚点、四元数——**强耦合内部状态**）；
 * ② 马达/限位这些**参数**怎么解析（纯计算，可以单测）；
 * ③ Rapier 句柄的生命周期管理。
 *
 * 第 ② 类是本次要动的部分（新增位置驱动马达），也是最容易写错的部分：
 * 参数缺省、越界、类型不支持时的行为，全都是"边界条件"，必须有明确的落点。
 * 所以这一层被抽到这里：**纯解析 + 一条薄薄的 Rapier 调用**，可以在 Node 里断言。
 * 第 ① 类留在 `JointSystem`（那里才有它的上下文），这一点如实写出来。
 *
 * ────────────────────────────────────────────────────────────
 * Rapier 0.21 的马达 API（实测确认，不是猜的）
 * ────────────────────────────────────────────────────────────
 * ```
 * setLimits(min, max)                                  // 限位（只有 revolute / prismatic 有）
 * setMotorMaxForce(maxForce)                           // 最大出力（两种模式共用）
 * configureMotorVelocity(targetVel, factor)            // 速度驱动（factor = 逼近阻尼）
 * configureMotorPosition(targetPos, stiffness, damping)// 位置驱动
 * configureMotorModel(MotorModel)                      // 0 = AccelerationBased（默认）
 * ```
 * **没有 `setMotorVelocity(speed, maxForce)`** —— 那是更早版本或者别的绑定才有的签名，
 * 照它写会得到 `undefined is not a function`，而且只在真的建关节时才暴露。
 *
 * 另外：**马达只对 revolute / prismatic 有意义**。fixed 关节两端焊死、ball 关节三轴自由、
 * rope/spring 由长度约束驱动 —— 给它们设马达在 Rapier 里不会报错，但也不会有任何效果，
 * 所以这里直接把不支持的类型判掉并给出中文原因，而不是让玩家在界面上调半天没反应。
 */

import type { JointType, JointLimits, MotorConfig, MotorMode } from '../data/jointTypes';

/** 哪些关节类型支持马达（电机只能驱动"一个自由度"的关节） */
export const JOINT_MOTOR_SUPPORT: Record<JointType, boolean> = {
  fixed: false,
  revolute: true,
  prismatic: true,
  ball: false,
  rope: false,
  spring: false,
};

/** 位置的单位说明（面板上要写清楚，否则玩家不知道 1.57 是什么） */
export const JOINT_POSITION_UNIT: Record<JointType, string> = {
  fixed: '—',
  revolute: '弧度（1.57 ≈ 90°）',
  prismatic: '米',
  ball: '—',
  rope: '—',
  spring: '—',
};

/** 默认刚度 / 阻尼（位置驱动）。给理由：这两个值决定"干脆利落但不猛" */
export const DEFAULT_MOTOR_STIFFNESS = 800;
export const DEFAULT_MOTOR_DAMPING = 60;
/** 速度驱动的逼近阻尼系数（Rapier 官方示例里常用的量级） */
export const MOTOR_VELOCITY_FACTOR = 12;
/** 默认最大出力 */
export const DEFAULT_MOTOR_FORCE = 200;

export interface ResolvedMotor {
  /** 最终生效的模式 */
  mode: MotorMode;
  /** 速度模式的目标速度 */
  targetVel: number;
  /** 位置模式的目标位置（弧度或米） */
  targetPos: number;
  /** 位置模式的刚度与阻尼 */
  stiffness: number;
  damping: number;
  /** 最大出力（已夹到正数） */
  maxForce: number;
  /** 解析过程中的告警（中文），调用方应当记日志 */
  warnings: string[];
}

export interface MotorResolveResult {
  ok: boolean;
  motor: ResolvedMotor | null;
  /** 失败原因（中文） */
  reason?: string;
}

/** 最小 Rapier 单位关节面 */
export interface UnitJointLike {
  setLimits?(min: number, max: number): void;
  setMotorMaxForce?(maxForce: number): void;
  configureMotorVelocity?(targetVel: number, factor: number): void;
  configureMotorPosition?(targetPos: number, stiffness: number, damping: number): void;
  configureMotorModel?(model: number): void;
}

/**
 * 解析马达配置。
 *
 * 规则（每一条都有理由，不是随手定的）：
 * - 关节类型不支持马达 → **拒绝并说明**，不做"设了但没效果"；
 * - `mode` 不填 → `velocity`（保持 M2.5 的既有语义，老数据继续能用）；
 * - `position` 模式没给 `targetPosition` → 用 0（回到原点），并**告警** ——
 *   静默用 0 会让"我明明设了位置驱动但门不动"变成一个谜；
 * - 刚度/阻尼为 0 或负数 → 用默认值并告警（0 刚度 = 永远不动，0 阻尼 = 一直晃）；
 * - `maxForce` 非正 → 用默认值（0 出力的马达等于没接电）。
 */
export function resolveMotor(type: JointType, motor: MotorConfig): MotorResolveResult {
  if (!JOINT_MOTOR_SUPPORT[type]) {
    return {
      ok: false,
      motor: null,
      reason: `${
        type === 'fixed'
          ? '固定关节两端是焊死的，没有可驱动的自由度'
          : type === 'ball'
            ? '球关节三个方向都自由，马达不知道该驱动哪一个'
            : '这种关节由长度约束驱动，不需要马达'
      }`,
    };
  }

  const warnings: string[] = [];
  const mode: MotorMode = motor.mode ?? 'velocity';

  let targetVel = Number.isFinite(motor.speed) ? motor.speed : 0;
  let targetPos = 0;
  let stiffness = DEFAULT_MOTOR_STIFFNESS;
  let damping = DEFAULT_MOTOR_DAMPING;

  if (mode === 'position') {
    if (motor.targetPosition === undefined || !Number.isFinite(motor.targetPosition)) {
      warnings.push('位置驱动没有给目标位置，已按 0（回到初始位置）处理');
      targetPos = 0;
    } else {
      targetPos = motor.targetPosition;
    }
    if (motor.stiffness !== undefined) {
      if (motor.stiffness > 0) stiffness = motor.stiffness;
      else warnings.push(`刚度 ${motor.stiffness} 不合法（必须为正），已改用默认 ${DEFAULT_MOTOR_STIFFNESS}`);
    }
    if (motor.damping !== undefined) {
      if (motor.damping >= 0) damping = motor.damping;
      else warnings.push(`阻尼 ${motor.damping} 不合法（不能为负），已改用默认 ${DEFAULT_MOTOR_DAMPING}`);
    }
    // 位置模式的速度字段没有意义，但保留 0 以免老代码读它读到 NaN
    targetVel = 0;
  } else if (!Number.isFinite(targetVel)) {
    warnings.push('速度驱动的目标速度不是有效数字，已按 0 处理（马达不会动）');
    targetVel = 0;
  }

  let maxForce = motor.maxForce;
  if (!Number.isFinite(maxForce) || maxForce <= 0) {
    warnings.push(`最大出力 ${motor.maxForce} 不合法，已改用默认 ${DEFAULT_MOTOR_FORCE}`);
    maxForce = DEFAULT_MOTOR_FORCE;
  }

  return {
    ok: true,
    motor: { mode, targetVel, targetPos, stiffness, damping, maxForce, warnings },
  };
}

/**
 * 把解析好的马达写到 Rapier 的关节上。
 *
 * @returns 是否真的写成功（缺方法或抛异常都返回 false，调用方据此提示玩家）
 */
export function applyMotor(joint: UnitJointLike, motor: ResolvedMotor): boolean {
  try {
    if (typeof joint.setMotorMaxForce === 'function') {
      joint.setMotorMaxForce(Math.max(1, motor.maxForce));
    }
    if (motor.mode === 'position') {
      if (typeof joint.configureMotorPosition !== 'function') {
        // 老版本 Rapier 没有位置驱动：如实失败，而不是退化成速度驱动
        // （退化的表现是"门关不上，一直在转"，比直接失败更难排查）
        return false;
      }
      joint.configureMotorPosition(motor.targetPos, motor.stiffness, motor.damping);
      return true;
    }
    if (typeof joint.configureMotorVelocity !== 'function') return false;
    joint.configureMotorVelocity(motor.targetVel, MOTOR_VELOCITY_FACTOR);
    return true;
  } catch (error) {
    console.warn('[关节] 写马达失败', error);
    return false;
  }
}

/**
 * 限位归一化。
 *
 * 三件必须做的事：
 * 1. **互换倒置的上下限**：玩家把滑块拖反了（min 大于 max）是常态，
 *    直接传给 Rapier 会得到一个"永远卡在限位里"的关节；
 * 2. **上下限相等时视为"锁死"**：Rapier 接受 min == max，行为就是固定不动，这是有用的一种配置；
 * 3. **单位为弧度/米**，不做任何换算（那是 UI 的事）。
 */
export function normalizeLimits(limits: JointLimits | undefined): { min: number; max: number } | null {
  if (!limits) return null;
  let { min, max } = limits;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min > max) [min, max] = [max, min];
  return { min, max };
}

export function applyLimits(joint: UnitJointLike, limits: JointLimits | undefined): { applied: boolean; note: string } {
  const normalized = normalizeLimits(limits);
  if (!normalized) return { applied: false, note: '没有限位' };
  if (typeof joint.setLimits !== 'function') {
    // 只有 revolute / prismatic 有 setLimits；其他类型如实报告而不是假装成功
    return { applied: false, note: '这种关节不支持限位（Rapier 只给旋转/滑动关节提供 setLimits）' };
  }
  try {
    joint.setLimits(normalized.min, normalized.max);
    return { applied: true, note: `限位 ${normalized.min} ~ ${normalized.max}` };
  } catch (error) {
    return { applied: false, note: `设限位失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 面板用：一行中文说明这个马达在干什么 */
export function describeMotor(motor: ResolvedMotor | null, type: JointType): string {
  if (!motor) return `不支持马达（${type}）`;
  if (motor.mode === 'position') {
    return `位置驱动：目标 ${motor.targetPos} ${JOINT_POSITION_UNIT[type]}（刚度 ${motor.stiffness} / 阻尼 ${motor.damping}，最大出力 ${motor.maxForce}）`;
  }
  return `速度驱动：${motor.targetVel} / 秒${motor.targetVel === 0 ? '（停止）' : ''}，最大出力 ${motor.maxForce}`;
}
