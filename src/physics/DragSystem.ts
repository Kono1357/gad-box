/**
 * 阻力与冲击（M4 第二部分 · 第 4 批）。
 *
 * 单独一个文件的理由：**"物体在流体里被拖住"和"被水流打"是两件事**，
 * 它们的作用点、时间尺度与调参方式都不同：
 * - **阻力**是持续的、与相对速度反向的力。它决定"物体在水里多难推动"；
 * - **冲击**是短促的、与相对速度**平方**成正比的冲量。它决定"浪打过来物体被推多远"。
 * 把两者混在一个公式里（很多实现就那么干）会导致：想让浪更猛就得同时把水变得极难推动，
 * 于是没法单独调"浪的威力"。
 *
 * ────────────────────────────────────────────────────────────
 * 公式与它们的诚实边界
 * ────────────────────────────────────────────────────────────
 * 阻力用**二次阻力**（真实流体的形式）：
 *   `F = -0.5 · ρ · Cd · A · |v_rel| · v_rel`
 * 但纯二次阻力在速度趋近 0 时力也趋近 0，数值上会让物体"永远停不下来地微动"。
 * 所以这里额外加一项**线性阻力**（`-λ·v_rel`），它负责把残余速度吃掉。
 * 这是游戏物理里的通行做法，**不是**真实流体的模型（真实流体的低速区是 Stokes 阻力，
 * 系数与物体形状强相关）。
 *
 * 冲击用动量定理的近似：
 *   `J = ρ · A · (v_rel · n)² · dt`（只算"迎面撞上"的那一部分，背面不算）
 * 它的单位是冲量，但**没有**考虑流体自身的压缩与溅射 —— 也就是说
 * "物体被水打飞"这件事在这里是"看起来合理"，不是"算得准"。
 */

export interface DragConfig {
  /** 阻力系数 Cd（无量纲）。1.0 = 平板迎流，0.5 = 球体 */
  dragCoefficient: number;
  /** 线性阻力系数（每秒），负责吃掉残余速度 */
  linearDrag: number;
  /** 角速度阻力系数（每秒）。让在水里转的东西慢下来 */
  angularDrag: number;
  /** 冲击系数：把"迎面水流的动压"放大成冲量的倍数 */
  impactScale: number;
  /** 单个物体每帧受到的力上限（牛顿），防止数值爆炸把物体射出去 */
  maxForce: number;
}

export const DEFAULT_DRAG_CONFIG: DragConfig = {
  dragCoefficient: 1.1,
  linearDrag: 1.4,
  angularDrag: 2.2,
  impactScale: 1,
  maxForce: 80000,
};

/** 参与阻力计算的物体（只读快照；`mass` 用于把力换算成加速度上限） */
export interface DragBody {
  handle: number;
  ownerId: number;
  /** 物体中心（世界坐标） */
  center: { x: number; y: number; z: number };
  /** AABB 半尺寸 */
  half: { x: number; y: number; z: number };
  mass: number;
  velocity: { x: number; y: number; z: number };
  angularVelocity?: { x: number; y: number; z: number };
  /** 浸没比例 0~1（由耦合系统算好后传进来；0 表示不在流体里） */
  submersion: number;
}

export interface DragResult {
  handle: number;
  /** 线性阻力 + 冲击的合力（牛顿·秒/tick 语义取决于调用方，见 Engine 的用法） */
  force: { x: number; y: number; z: number };
  /** 角速度阻力（力偶，N·m） */
  torque: { x: number; y: number; z: number };
  /** 迎面动压（Pa），面板与调试用 */
  dynamicPressure: number;
  /** 是否被上限夹住 */
  clamped: boolean;
}

/**
 * 迎流面积估计：用 AABB 的三个截面里**最大**的那个。
 *
 * 为什么不用"按速度方向投影"：那需要知道物体的朝向（要读四元数并做矩阵运算），
 * 而本项目的物体大多是轴对齐的方块/圆柱。用最大截面会**略微高估**阻力
 * （斜着走时阻力偏大），这是刻意的：高估阻力让物体更"难推"，
 * 视觉上比"水没有阻力"要合理得多。
 */
function frontalArea(half: { x: number; y: number; z: number }): number {
  const a = half.x * 2 * (half.y * 2);
  const b = half.x * 2 * (half.z * 2);
  const c = half.y * 2 * (half.z * 2);
  return Math.max(a, b, c);
}

export class DragSystem {
  constructor(private config: DragConfig = { ...DEFAULT_DRAG_CONFIG }) {}

  get settings(): DragConfig {
    return this.config;
  }

  setConfig(config: Partial<DragConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 计算一个物体受到的阻力与冲击。
   *
   * @param fluidDensity 流体的**物理密度**（kg/m³）。水 1000、蜂蜜 1400、岩浆 2600
   * @param fluidVelocity 物体所在位置的流体速度（米/秒）
   */
  compute(body: DragBody, fluidDensity: number, fluidVelocity: { x: number; y: number; z: number }): DragResult {
    const submerged = Math.max(0, Math.min(1, body.submersion));
    if (submerged <= 0) {
      return { handle: body.handle, force: { x: 0, y: 0, z: 0 }, torque: { x: 0, y: 0, z: 0 }, dynamicPressure: 0, clamped: false };
    }
    const area = frontalArea(body.half) * submerged;

    // 相对速度：流体速度 − 物体速度（流体推着物体走的方向为正）
    const relX = fluidVelocity.x - body.velocity.x;
    const relY = fluidVelocity.y - body.velocity.y;
    const relZ = fluidVelocity.z - body.velocity.z;
    const speed = Math.hypot(relX, relY, relZ);

    // ---- 二次阻力：方向沿相对速度（流体快就推、物体快就拖）
    const quadratic = 0.5 * fluidDensity * this.config.dragCoefficient * area * speed;
    // ---- 线性阻力：低速时仍然吃掉残余速度（见文件头）
    const linear = this.config.linearDrag * fluidDensity * area * submerged * 0.001;
    const coefficient = quadratic + linear;

    let fx = relX * coefficient;
    let fy = relY * coefficient;
    let fz = relZ * coefficient;

    // ---- 冲击：只算迎面撞上的那一部分（v_rel·n > 0），用动压 ρv² 的量级
    const dynamicPressure = 0.5 * fluidDensity * speed * speed;
    if (speed > IMPACT_SPEED_THRESHOLD) {
      // 迎面分量：相对速度在"物体表面法线"上的投影。
      // 这里用物体最大的那个轴当近似法线 —— 与 frontalArea 的近似保持一致
      const axis = dominantAxis(body.half);
      const normalComponent = axis === 0 ? relX : axis === 1 ? relY : relZ;
      if (normalComponent > 0) {
        const impact = dynamicPressure * area * this.config.impactScale * IMPACT_IMPULSE_SCALE;
        const inv = 1 / Math.max(1e-6, speed);
        fx += relX * inv * impact;
        fy += relY * inv * impact;
        fz += relZ * inv * impact;
      }
    }

    const magnitude = Math.hypot(fx, fy, fz);
    let clamped = false;
    if (magnitude > this.config.maxForce) {
      const scale = this.config.maxForce / magnitude;
      fx *= scale;
      fy *= scale;
      fz *= scale;
      clamped = true;
    }

    // ---- 角速度阻力：水里转得越快，力矩越大（与角速度反向）
    let torqueX = 0;
    let torqueY = 0;
    let torqueZ = 0;
    if (body.angularVelocity) {
      const k = this.config.angularDrag * fluidDensity * area * body.half.y * body.half.y * submerged * 1e-3;
      torqueX = -body.angularVelocity.x * k;
      torqueY = -body.angularVelocity.y * k;
      torqueZ = -body.angularVelocity.z * k;
    }

    return {
      handle: body.handle,
      force: { x: fx, y: fy, z: fz },
      torque: { x: torqueX, y: torqueY, z: torqueZ },
      dynamicPressure,
      clamped,
    };
  }
}

/** 超过这个相对速度才算"冲击"（米/秒）。0.5 m/s 是"看得出是水流"的下限 */
const IMPACT_SPEED_THRESHOLD = 0.5;
/** 动压 → 冲量的换算系数。它是**调出来的**：让一堵 3 m/s 的水墙能把一个 50 kg 的箱子明显推动 */
const IMPACT_IMPULSE_SCALE = 0.012;

/** 物体的"主迎流轴"（0=X, 1=Y, 2=Z）：取 AABB 尺寸最大的那个轴 */
function dominantAxis(half: { x: number; y: number; z: number }): 0 | 1 | 2 {
  if (half.x >= half.y && half.x >= half.z) return 0;
  if (half.y >= half.x && half.y >= half.z) return 1;
  return 2;
}
