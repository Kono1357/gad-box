/**
 * 重力预设与世界物理配置（问题 A.4）。
 *
 * ## 为什么把"世界配置"和"重力预设"放一起
 *
 * 换重力不是只改一个数字：木星上东西落得飞快，固定步长还是 1/60 就会出现
 * "一帧穿过地板"（tunneling）；月球上物体半天才停稳，休眠阈值给 2 秒会让它
 * 刚落稳就被判睡着、又被下一次接触惊醒，看上去在抖。
 * 所以**每个重力预设都带自己的一套时间步 / 子步 / 迭代 / 休眠参数**，
 * 面板只要换预设，就不用担心玩家调出"能动能穿模"的组合。
 *
 * ## 纯数据
 *
 * 不 import Rapier / Three.js / DOM，模块顶层不访问 `window`；
 * `src/physics/RapierWorld.ts` 直接消费本文件的 DEFAULT_WORLD_CONFIG 与 validateWorldConfig。
 */

/** 用户给的世界配置模型，字段名与 Rapier 的 World 参数一一对应 */
export interface PhysicsWorldConfig {
  /** 重力向量 m/s² */
  gravity: [number, number, number];
  /** 固定时间步（秒） */
  timestep: number;
  /** 单帧最多追赶的子步数 */
  maxSubsteps: number;
  /** 求解器迭代次数（Rapier 的 numSolverIterations） */
  solverIterations: number;
  /** 休眠阈值（秒）：静止超过这么久就休眠 */
  sleepThreshold: number;
}

export interface GravityPreset {
  id: 'earth' | 'moon' | 'mars' | 'jupiter' | 'zero';
  name: string;
  emoji: string;
  /** Y 分量（m/s²），负数向下 */
  gravityY: number;
  /** 真实参考值说明（中文，例如「月球 1.62 m/s²，约为地球的 1/6」） */
  description: string;
  /** 在这个重力下最值得玩的一件事（教学/引导文案） */
  highlight: string;
}

/** 预设 id 的字符串联合（面板与存档用） */
export type GravityPresetId = GravityPreset['id'];

/**
 * 5 个重力预设。
 *
 * 数值都是**真实天体表面的平均重力加速度**（非精确值，取两位小数）：
 * 地球 9.81 / 月球 1.62 / 火星 3.71 / 木星 24.79（云顶，木星没有固体表面）。
 * X / Z 一律 0：本轮只开放"竖直方向"的重力，侧向重力会让堆叠判定的语义变得难以解释。
 */
export const GRAVITY_PRESETS: readonly GravityPreset[] = [
  {
    id: 'earth',
    name: '地球',
    emoji: '🌍',
    gravityY: -9.81,
    description: '地球标准重力 9.81 m/s²，一切日常物理的基准（也是默认值）。',
    highlight: '先在这里搭一座塔并把它推倒 —— 后面所有重力的手感都是跟它对比出来的。',
  },
  {
    id: 'moon',
    name: '月球',
    emoji: '🌙',
    gravityY: -1.62,
    description: '月球 1.62 m/s²，约为地球的 1/6。',
    highlight: '同样一推，箱子能飘出去约 6 倍远；让物体慢慢落下最能看出区别。',
  },
  {
    id: 'mars',
    name: '火星',
    emoji: '🔴',
    gravityY: -3.71,
    description: '火星 3.71 m/s²，约为地球的 38%。',
    highlight: '介于地球与月球之间：跳起来约是地球的 2.6 倍高，落地却还算干脆。',
  },
  {
    id: 'jupiter',
    name: '木星',
    emoji: '🪐',
    gravityY: -24.79,
    description: '木星 24.79 m/s²，约为地球的 2.5 倍（云顶参考值，木星没有固体表面）。',
    highlight: '落体几乎瞬间到底，500 箱塔的承重要求陡增 —— 最适合测堆叠强度。',
  },
  {
    id: 'zero',
    name: '零重力',
    emoji: '🛰️',
    gravityY: 0,
    description: '零重力 0 m/s²：没有向下的加速度，物体悬停不下落（空间站里的感觉）。',
    highlight: '推一下就一直飘，把刚体堆成一条飘浮的链子最能体现"没有重力"这件事。',
  },
];

/** 默认重力预设：地球 */
export const DEFAULT_GRAVITY_PRESET: GravityPresetId = 'earth';

/** 按 id 取预设；找不到时退回默认（地球），不抛错 */
export function getGravityPreset(id: string): GravityPreset {
  return GRAVITY_PRESETS.find((preset) => preset.id === id) ?? GRAVITY_PRESETS[0]!;
}

/** 每个预设除重力之外的调参（理由见文件头注释） */
interface WorldTuning {
  timestep: number;
  maxSubsteps: number;
  solverIterations: number;
  sleepThreshold: number;
}

const TUNING: Record<GravityPresetId, WorldTuning> = {
  // 地球：需求里给的基准组合 —— 1/60 步长 + 5 子步 + 4 迭代 + 2 秒休眠
  earth: { timestep: 1 / 60, maxSubsteps: 5, solverIterations: 4, sleepThreshold: 2 },
  // 月球：重力只有 1/6，物体落 1 米要 1.1 秒；休眠阈值放宽到 3 秒，
  // 否则缓慢滑动的物体会在"看起来还在动"的时候被判睡着，接触一次又醒，表现为抖动
  moon: { timestep: 1 / 60, maxSubsteps: 5, solverIterations: 4, sleepThreshold: 3 },
  // 火星：落体速度与地球同量级（0.38 g），配置直接沿用地球那套
  mars: { timestep: 1 / 60, maxSubsteps: 5, solverIterations: 4, sleepThreshold: 2 },
  // 木星：2.5 g，同样的墙钟时间里位移与速度都大得多。步长减半 + 子步与迭代加倍，
  // 换来的是"高速物体不会一帧穿过地板"；代价是 CPU，所以只有这一档这么奢侈
  jupiter: { timestep: 1 / 120, maxSubsteps: 8, solverIterations: 6, sleepThreshold: 2 },
  // 零重力：没有自由落体，追赶子步的需求最低（3 足够），反而希望飘着的物体一旦停住就尽快休眠省 CPU
  zero: { timestep: 1 / 60, maxSubsteps: 3, solverIterations: 4, sleepThreshold: 1.5 },
};

/**
 * 预设 → 完整世界配置。
 *
 * **每次都返回新对象（含新的 gravity 数组）**：面板会就地改 `gravity[1]`，
 * 如果返回共享引用，改一次"月球"就把全局预设表污染了。
 */
export function configForPreset(id: string): PhysicsWorldConfig {
  const preset = getGravityPreset(id);
  const tuning = TUNING[preset.id];
  return {
    gravity: [0, preset.gravityY, 0],
    timestep: tuning.timestep,
    maxSubsteps: tuning.maxSubsteps,
    solverIterations: tuning.solverIterations,
    sleepThreshold: tuning.sleepThreshold,
  };
}

/**
 * 默认世界配置（地球 + 1/60 步长 + 5 子步 + 4 迭代 + 2 秒休眠）。
 * 用 configForPreset 推导而不是手写一遍字面量，避免两处数值漂移。
 */
export const DEFAULT_WORLD_CONFIG: PhysicsWorldConfig = configForPreset(DEFAULT_GRAVITY_PRESET);

/** 允许的范围（面板滑块用，也是校验依据） */
export const PHYSICS_LIMITS: {
  gravityY: { min: number; max: number; step: number };
  timestep: { min: number; max: number; step: number };
  maxSubsteps: { min: number; max: number; step: number };
  solverIterations: { min: number; max: number; step: number };
  sleepThreshold: { min: number; max: number; step: number };
  friction: { min: number; max: number; step: number };
  restitution: { min: number; max: number; step: number };
  linearDamping: { min: number; max: number; step: number };
  angularDamping: { min: number; max: number; step: number };
  maxVelocity: { min: number; max: number; step: number };
} = {
  // ±50 足够覆盖 0 ~ 5 倍地球重力（木星 24.79 也在内），再大就不是"重力"而是"弹射器"了
  gravityY: { min: -50, max: 50, step: 0.01 },
  // 1/120 ~ 1/30：更小（1/240）对 60 Hz 屏幕是纯浪费，更大（1/15）会明显穿透
  timestep: { min: 1 / 120, max: 1 / 30, step: 1 / 600 },
  maxSubsteps: { min: 1, max: 10, step: 1 },
  solverIterations: { min: 1, max: 12, step: 1 },
  sleepThreshold: { min: 0, max: 10, step: 0.1 },
  friction: { min: 0, max: 1, step: 0.01 },
  restitution: { min: 0, max: 1, step: 0.01 },
  // 阻尼是"每秒衰减比例"，Rapier 允许大于 1（越大越快停下），2 已经等于 1 秒内衰减到 1/9
  linearDamping: { min: 0, max: 2, step: 0.01 },
  angularDamping: { min: 0, max: 2, step: 0.01 },
  // 速度上限（m/s）：木星重力自由落体 10 秒约 248 m/s，500 足够覆盖，同时挡住数值爆炸
  maxVelocity: { min: 0, max: 500, step: 1 },
};

function checkRange(
  value: number,
  label: string,
  min: number,
  max: number,
  problems: string[],
): void {
  if (!Number.isFinite(value)) {
    problems.push(`${label}必须是数字（当前是 ${String(value)}）`);
    return;
  }
  if (value < min || value > max) {
    problems.push(`${label}必须在 ${min} ~ ${max} 之间（当前 ${value}）`);
  }
}

function checkInteger(value: number, label: string, min: number, max: number, problems: string[]): void {
  if (!Number.isFinite(value)) {
    problems.push(`${label}必须是整数（当前是 ${String(value)}）`);
    return;
  }
  if (!Number.isInteger(value)) {
    problems.push(`${label}必须是整数（当前 ${value}）`);
    return;
  }
  if (value < min || value > max) {
    problems.push(`${label}必须在 ${min} ~ ${max} 之间（当前 ${value}）`);
  }
}

/**
 * 校验玩家改过的配置，返回中文问题列表（空数组 = 合法）。
 *
 * 这里**只报错不修正**：面板要把问题显示给玩家看，
 * 真正落地时的兜底修正在 `RapierWorld.normalizeConfig()` 里做（它保证脏值进不了引擎）。
 */
export function validateWorldConfig(config: PhysicsWorldConfig): string[] {
  const problems: string[] = [];
  const gravity = config.gravity;
  if (!Array.isArray(gravity) || gravity.length !== 3) {
    problems.push('重力必须是长度为 3 的数组 [x, y, z]');
  } else {
    // 三个分量都要有限；Y 是主方向，X / Z 目前只允许小范围（侧向重力会让堆叠判定失去意义）
    for (const [index, axis] of ['X', 'Y', 'Z'].entries()) {
      const value = gravity[index];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push(`重力 ${axis} 分量必须是数字（当前是 ${String(value)}）`);
        continue;
      }
      checkRange(value, `重力 ${axis} 分量`, PHYSICS_LIMITS.gravityY.min, PHYSICS_LIMITS.gravityY.max, problems);
    }
  }
  checkRange(config.timestep, '固定时间步', PHYSICS_LIMITS.timestep.min, PHYSICS_LIMITS.timestep.max, problems);
  checkInteger(config.maxSubsteps, '最大子步数', PHYSICS_LIMITS.maxSubsteps.min, PHYSICS_LIMITS.maxSubsteps.max, problems);
  checkInteger(
    config.solverIterations,
    '求解器迭代次数',
    PHYSICS_LIMITS.solverIterations.min,
    PHYSICS_LIMITS.solverIterations.max,
    problems,
  );
  checkRange(
    config.sleepThreshold,
    '休眠阈值',
    PHYSICS_LIMITS.sleepThreshold.min,
    PHYSICS_LIMITS.sleepThreshold.max,
    problems,
  );
  return problems;
}

/** 找与给定 Y 值匹配的预设（容差 0.05 m/s²，够覆盖面板滑块的步长） */
function matchPreset(gravityY: number): GravityPreset | undefined {
  return GRAVITY_PRESETS.find((preset) => Math.abs(preset.gravityY - gravityY) < 0.05);
}

/**
 * 面板用：把重力向量说成人话。
 * 例：「向下 9.81 m/s²（地球）」；数值对不上任何预设时标"自定义重力"。
 */
export function describeGravity(config: PhysicsWorldConfig): string {
  const y = config.gravity[1];
  if (!Number.isFinite(y)) return '重力未知（数值非法）';
  const preset = matchPreset(y);
  const label = preset ? preset.name : '自定义重力';
  if (Math.abs(y) < 0.05) {
    // 零重力下"向下/向上"没有意义，单独说清楚它意味着什么
    return `${label}：零重力（失重）0.00 m/s²，物体不会下落`;
  }
  const direction = y < 0 ? '向下' : '向上';
  return `${direction} ${Math.abs(y).toFixed(2)} m/s²（${label}）`;
}
