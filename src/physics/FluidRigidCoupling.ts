/**
 * 流体-刚体双向耦合（M4 第二部分 · 第 4 批）。
 *
 * ────────────────────────────────────────────────────────────
 * "双向"这个词在这份实现里的确切含义
 * ────────────────────────────────────────────────────────────
 * - **流体 → 刚体**：浮力（排开体积）、阻力（相对速度）、推动（水流速度）、
 *   冲击（迎面动压）、力矩（浮心与重心不重合产生的扶正/倾覆力矩）。
 *   这些是这一批的主体。
 * - **刚体 → 流体**：流体求解器把刚体当成**静止边界**处理（`FluidBoundary.isSolid`
 *   会把建筑的包围盒算成固体），于是水会绕开箱子、会被箱子挡住。
 *   但**运动中的刚体不会带动水**（不会产生尾流）—— 那需要把刚体的速度作为
 *   流体边界的边界条件传进 PBF，属于"双向耦合"的更完整形态，本项目**没做**。
 *   这条如实写在 README 的取舍清单里，不要以为它已经做了。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么会合力上限
 * ────────────────────────────────────────────────────────────
 * 耦合是数值上最容易炸的地方：粒子速度可以有几十米/秒，密度采样又是离散的，
 * 一个瞬间的采样误差就能产生几十万牛顿的力，把物体射到天上。
 * 所以每个物体每帧的合力被 `maxForce` 夹住 —— 这是**安全阀**，
 * 夹住的次数会如实统计（`clamped`），面板上能看到。夹得多了说明参数不合理，
 * 而不是"物理就是这样"。
 *
 * ────────────────────────────────────────────────────────────
 * 每一帧多次迭代
 * ────────────────────────────────────────────────────────────
 * 需求要求"每帧迭代 2~3 次提高稳定性"。这里的做法是：把一次耦合的力**分几次施加**，
 * 每次用更新后的速度重算相对速度 —— 这样"物体已经动了，阻力应该变小"这件事
 * 在同一帧内就能反映出来，而不是等下一帧。迭代次数在预设里（真实 3 / 游戏 2 / 夸张 2）。
 */

import { DragSystem, type DragBody, type DragConfig } from './DragSystem';

/** 耦合预设名（需求里的"真实 / 游戏 / 夸张"） */
export type CouplingPresetName = 'realistic' | 'game' | 'exaggerated';

export interface CouplingConfig {
  /** 浮力系数：1 = 按阿基米德原理（ρ流体 × 排开体积 × g） */
  buoyancyScale: number;
  /** 阻力配置（转发给 DragSystem） */
  drag: DragConfig;
  /** 每帧迭代次数（2~3） */
  iterations: number;
  /** 冲击系数（放大迎面动压的效果） */
  impactScale: number;
  /** 重力加速度（用于浮力计算） */
  gravity: number;
  /** 每个物体每帧的合力上限（N） */
  maxForce: number;
  /** 力矩上限（N·m） */
  maxTorque: number;
}

/**
 * 三个预设为什么是这三个数。
 *
 * - **真实（realistic）**：浮力系数 1.0（按阿基米德），阻力系数按流体力学的常见值，
 *   迭代 3 次。这是"看起来最讲道理"的一档：木头浮、石头沉、在水里推东西费劲。
 * - **游戏（game）**：浮力 1.0 但**阻力调小**、迭代 2 次。玩家在水里应该还能开船、
 *   还能推动箱子 —— 真实的阻力会让小船几乎动不了，那不是游戏想要的。
 * - **夸张（exaggerated）**：浮力 1.35（东西会自己浮起来）、冲击 ×4（浪能掀翻东西）、
 *   阻力更小。用来做"洪水冲垮房子""海啸"这类镜头。
 *
 * ⚠ 这些数字是**视觉调参**的结果，不是物理常数。README 里写了这一条。
 */
export const COUPLING_PRESETS: Record<CouplingPresetName, CouplingConfig> = {
  realistic: {
    buoyancyScale: 1,
    iterations: 3,
    impactScale: 1,
    gravity: 9.81,
    maxForce: 200000,
    maxTorque: 60000,
    drag: { dragCoefficient: 1.1, linearDrag: 1.4, angularDrag: 2.2, impactScale: 1, maxForce: 200000 },
  },
  game: {
    buoyancyScale: 1,
    iterations: 2,
    impactScale: 1.6,
    gravity: 9.81,
    maxForce: 200000,
    maxTorque: 60000,
    drag: { dragCoefficient: 0.55, linearDrag: 0.8, angularDrag: 1.2, impactScale: 1.6, maxForce: 200000 },
  },
  exaggerated: {
    buoyancyScale: 1.35,
    iterations: 2,
    impactScale: 4,
    gravity: 9.81,
    maxForce: 400000,
    maxTorque: 120000,
    drag: { dragCoefficient: 0.35, linearDrag: 0.5, angularDrag: 0.8, impactScale: 4, maxForce: 400000 },
  },
};

export const COUPLING_PRESET_LABELS: Record<CouplingPresetName, string> = {
  realistic: '真实',
  game: '游戏',
  exaggerated: '夸张',
};

/**
 * 流体场采样接口。
 *
 * 这一层抽象是这一批能被断言的关键：**耦合逻辑不知道流体是粒子还是体素**，
 * 它只问"这个位置有多少流体、流速多少"。于是测试里可以注入
 * "恒定密度 + 恒定流速"的假场，精确验证浮力/阻力/冲击的公式，
 * 而不必先跑一个 PBF 求解器。
 */
export interface FluidField {
  /** 该位置的"流体占比" 0~1（0 = 空气）。用于算浸没体积 */
  fullnessAt(x: number, y: number, z: number): number;
  /** 该位置的流体速度（米/秒） */
  velocityAt(x: number, y: number, z: number): { x: number; y: number; z: number };
  /** 该位置的流体密度（kg/m³） */
  densityAt(x: number, y: number, z: number): number;
}

export interface CouplingBody {
  handle: number;
  ownerId: number;
  center: { x: number; y: number; z: number };
  half: { x: number; y: number; z: number };
  mass: number;
  velocity: { x: number; y: number; z: number };
  angularVelocity?: { x: number; y: number; z: number };
}

export interface CouplingForce {
  handle: number;
  ownerId: number;
  /** 合力（N）：浮力 + 阻力 + 推动 + 冲击 **不含重力** */
  force: { x: number; y: number; z: number };
  /** 合力矩（N·m）：浮心偏移产生的扶正力矩 + 角速度阻力 */
  torque: { x: number; y: number; z: number };
  /** 浸没比例 0~1 */
  ratio: number;
  /** 排开的流体体积（m³） */
  displacedVolume: number;
  /** 浸没部分的浮心（世界坐标）：与重心不重合时产生扶正力矩 */
  centerOfBuoyancy: { x: number; y: number; z: number };
  /** 是不是"注定要沉"（物体平均密度 > 流体密度） */
  sinking: boolean;
  /** 受到的动压（Pa，表面压力指示） */
  dynamicPressure: number;
  /** 力和力矩是否被上限夹住过 */
  clamped: boolean;
}

export interface CouplingStats {
  /** 参与耦合的物体数 */
  bodies: number;
  /** 实际浸没的物体数（ratio > 0） */
  submerged: number;
  /** 会沉的物体数 */
  sinking: number;
  /** 被力上限夹住的物体数（**这个数字应该很小**，大了说明参数或流体速度不合理） */
  clamped: number;
  /** 平均浸没比例 */
  averageRatio: number;
  /** 耦合总耗时（毫秒） */
  ms: number;
  /** 迭代次数 */
  iterations: number;
}

export class FluidRigidCoupling {
  private readonly drag: DragSystem;
  private config: CouplingConfig;
  private presetName: CouplingPresetName = 'game';
  private lastStats: CouplingStats = {
    bodies: 0, submerged: 0, sinking: 0, clamped: 0, averageRatio: 0, ms: 0, iterations: 0,
  };

  constructor(preset: CouplingPresetName = 'game') {
    // ⚠ 这一行漏过一次：`presetName` 的字段初值是 'game'，而构造函数只设了 config ——
    // 于是 `new FluidRigidCoupling('realistic')` 的 describe() 永远显示"游戏"。
    // 断言把它抓出来了（"预设：describe() 给出中文摘要"红在一个看起来完全不相关的字段上）。
    this.presetName = preset;
    this.config = { ...COUPLING_PRESETS[preset], drag: { ...COUPLING_PRESETS[preset].drag } };
    this.drag = new DragSystem({ ...this.config.drag });
  }

  get preset(): CouplingPresetName {
    return this.presetName;
  }

  get settings(): CouplingConfig {
    return this.config;
  }

  get stats(): CouplingStats {
    return this.lastStats;
  }

  setPreset(preset: CouplingPresetName): void {
    this.presetName = preset;
    this.config = { ...COUPLING_PRESETS[preset], drag: { ...COUPLING_PRESETS[preset].drag } };
    this.drag.setConfig(this.config.drag);
  }

  setConfig(partial: Partial<Omit<CouplingConfig, 'drag'>> & { drag?: Partial<DragConfig> }): void {
    this.config = { ...this.config, ...partial, drag: { ...this.config.drag, ...(partial.drag ?? {}) } };
    this.drag.setConfig(this.config.drag);
  }

  /**
   * 计算所有物体受到的耦合力。
   *
   * @param bodies 动态刚体快照
   * @param field 流体场
   * @param dt 步长（秒）—— 迭代时用来把速度推进一小步（见类注释）
   */
  compute(bodies: readonly CouplingBody[], field: FluidField, dt: number): CouplingForce[] {
    const started = now();
    const out: CouplingForce[] = [];
    let submerged = 0;
    let sinking = 0;
    let clampedCount = 0;
    let ratioSum = 0;

    for (const body of bodies) {
      // ---- 1) 浸没比例：在物体 AABB 里采几个点求平均（2×2×2 = 8 个采样点）
      // 为什么不用解析的"水面高度 + 物体尺寸"：粒子流体的表面不是平面，
      // 解析法要求"水面是一个水平面"，而那在浪里是不成立的。
      // 采样法天然支持"半个箱子在水里、另外半边被浪盖着"这种情形。
      let fullnessSum = 0;
      let samples = 0;
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      let weighted = 0;
      const densitySamples: number[] = [];
      for (let sy = 0; sy < 2; sy += 1) {
        for (let sz = 0; sz < 2; sz += 1) {
          for (let sx = 0; sx < 2; sx += 1) {
            const px = body.center.x + (sx === 0 ? -0.5 : 0.5) * body.half.x * 2;
            const py = body.center.y + (sy === 0 ? -0.5 : 0.5) * body.half.y * 2;
            const pz = body.center.z + (sz === 0 ? -0.5 : 0.5) * body.half.z * 2;
            const fullness = field.fullnessAt(px, py, pz);
            fullnessSum += fullness;
            samples += 1;
            if (fullness > 0) {
              sumX += px * fullness;
              sumY += py * fullness;
              sumZ += pz * fullness;
              weighted += fullness;
              densitySamples.push(field.densityAt(px, py, pz));
            }
          }
        }
      }
      const ratio = samples === 0 ? 0 : fullnessSum / samples;
      const bodyVolume = body.half.x * body.half.y * body.half.z * 8;
      const displacedVolume = bodyVolume * ratio;
      // 浮心：浸没部分的加权中心（没有浸没时取物体中心，力为 0 时它无意义）
      const centerOfBuoyancy = weighted > 0
        ? { x: sumX / weighted, y: sumY / weighted, z: sumZ / weighted }
        : { ...body.center };
      // 流体密度：取采样点的平均（粒子流体在物体附近可能不均匀）
      const fluidDensity = densitySamples.length > 0
        ? densitySamples.reduce((a, b) => a + b, 0) / densitySamples.length
        : 0;

      ratioSum += ratio;
      if (ratio > 0) submerged += 1;
      // "会沉"的判据用密度比，不是看力的正负（浮力永远是向上的）
      const bodyDensity = bodyVolume > 1e-9 ? body.mass / bodyVolume : 0;
      const sinkingFlag = fluidDensity > 0 && bodyDensity > fluidDensity;
      if (sinkingFlag) sinking += 1;

      if (ratio <= 0) {
        out.push({
          handle: body.handle, ownerId: body.ownerId,
          force: { x: 0, y: 0, z: 0 }, torque: { x: 0, y: 0, z: 0 },
          ratio: 0, displacedVolume: 0, centerOfBuoyancy, sinking: sinkingFlag,
          dynamicPressure: 0, clamped: false,
        });
        continue;
      }

      // ---- 2) 浮力 + 阻力 + 推动 + 冲击
      //
      // 浮力：F = ρ流体 × V排开 × g × buoyancyScale（阿基米德）
      const buoyancy = fluidDensity * displacedVolume * this.config.gravity * this.config.buoyancyScale;

      // 迭代：每次用"更新后的速度"重算阻力，把同一帧内物体已经动起来这件事反映进去。
      // 迭代的做法是把速度按当前合力推进 dt/iterations —— 这是**近似**（没有真的分步积分），
      // 但它让阻力在同一帧内就能收敛，抑制"物体在水里来回抖"。
      let velocityX = body.velocity.x;
      let velocityY = body.velocity.y;
      let velocityZ = body.velocity.z;
      let dragX = 0;
      let dragY = 0;
      let dragZ = 0;
      let torqueX = 0;
      let torqueY = 0;
      let torqueZ = 0;
      let dynamicPressure = 0;
      let clamped = false;
      const iterations = Math.max(1, Math.round(this.config.iterations));
      const subDt = dt / iterations;

      for (let iter = 0; iter < iterations; iter += 1) {
        const fluidVelocity = field.velocityAt(body.center.x, body.center.y, body.center.z);
        const dragBody: DragBody = {
          handle: body.handle,
          ownerId: body.ownerId,
          center: body.center,
          half: body.half,
          mass: body.mass,
          velocity: { x: velocityX, y: velocityY, z: velocityZ },
          angularVelocity: body.angularVelocity,
          submersion: ratio,
        };
        const result = this.drag.compute(dragBody, fluidDensity, {
          x: fluidVelocity.x * this.config.impactScale,
          y: fluidVelocity.y * this.config.impactScale,
          z: fluidVelocity.z * this.config.impactScale,
        });
        dragX += result.force.x;
        dragY += result.force.y;
        dragZ += result.force.z;
        torqueX += result.torque.x;
        torqueY += result.torque.y;
        torqueZ += result.torque.z;
        dynamicPressure = Math.max(dynamicPressure, result.dynamicPressure);
        if (result.clamped) clamped = true;
        // 把合力推进速度（近似积分），供下一次迭代用
        const invMass = 1 / Math.max(1e-6, body.mass);
        velocityX += (dragX * invMass) * subDt;
        velocityY += (dragY * invMass) * subDt;
        velocityZ += (dragZ * invMass) * subDt;
      }

      // 平均到每次迭代（力的量纲应该是"当前合力"，不是迭代累加）
      const invIter = 1 / iterations;
      let forceX = dragX * invIter;
      let forceY = dragY * invIter + buoyancy;
      let forceZ = dragZ * invIter;

      // ---- 3) 浮心力矩：浮心与重心不重合时产生力矩（这就是"船会自己摆正"的原因）
      //
      // 力矩 = r × F，其中 r 是"浮心 − 重心"，F 是浮力（只有 Y 分量）。
      // 于是只有 X/Z 分量会出现：横倾时浮心偏向浸没多的一侧，把物体扳回来。
      const rx = centerOfBuoyancy.x - body.center.x;
      const rz = centerOfBuoyancy.z - body.center.z;
      // r × (0, Fy, 0) = (rz·Fy, 0, −rx·Fy)
      const buoyancyTorqueX = rz * buoyancy;
      const buoyancyTorqueZ = -rx * buoyancy;
      let totalTorqueX = torqueX * invIter + buoyancyTorqueX;
      let totalTorqueY = torqueY * invIter;
      let totalTorqueZ = torqueZ * invIter + buoyancyTorqueZ;

      // ---- 4) 上限（安全阀）
      const forceMagnitude = Math.hypot(forceX, forceY, forceZ);
      if (forceMagnitude > this.config.maxForce) {
        const scale = this.config.maxForce / forceMagnitude;
        forceX *= scale; forceY *= scale; forceZ *= scale;
        clamped = true;
      }
      const torqueMagnitude = Math.hypot(totalTorqueX, totalTorqueY, totalTorqueZ);
      if (torqueMagnitude > this.config.maxTorque) {
        const scale = this.config.maxTorque / torqueMagnitude;
        totalTorqueX *= scale; totalTorqueY *= scale; totalTorqueZ *= scale;
        clamped = true;
      }
      if (clamped) clampedCount += 1;

      out.push({
        handle: body.handle,
        ownerId: body.ownerId,
        force: { x: forceX, y: forceY, z: forceZ },
        torque: { x: totalTorqueX, y: totalTorqueY, z: totalTorqueZ },
        ratio,
        displacedVolume,
        centerOfBuoyancy,
        sinking: sinkingFlag,
        dynamicPressure,
        clamped,
      });
    }

    this.lastStats = {
      bodies: bodies.length,
      submerged,
      sinking,
      clamped: clampedCount,
      averageRatio: bodies.length === 0 ? 0 : ratioSum / bodies.length,
      ms: now() - started,
      iterations: this.config.iterations,
    };
    return out;
  }

  describe(): string {
    const s = this.lastStats;
    return (
      `耦合（${COUPLING_PRESET_LABELS[this.presetName]}）：${s.bodies} 个物体，` +
      `浸没 ${s.submerged}，会沉 ${s.sinking}｜迭代 ${s.iterations}｜` +
      `${s.ms.toFixed(2)} ms` +
      (s.clamped > 0 ? `｜⚠ ${s.clamped} 个被力上限夹住` : '')
    );
  }
}

/**
 * 常量流体场（测试与"整片水"场景用）。
 *
 * 它有实际用途，不只是测试工具：当玩家用"灌满"的方式造出一整片水时，
 * 粒子流体的密度在采样点上几乎是均匀的 —— 用它比按粒子采样便宜得多。
 */
export class UniformFluidField implements FluidField {
  constructor(
    private readonly fullness: number,
    velocity: Partial<{ x: number; y: number; z: number }> = {},
    private readonly density = 1000,
    private readonly minY = Number.NEGATIVE_INFINITY,
    private readonly maxY = Number.POSITIVE_INFINITY,
  ) {
    // 缺字段补 0：不然 `new UniformFluidField(1, {})` 会让流速变成 undefined，
    // 再乘进力里就得到 NaN —— 而 NaN 会**静默传播**（Rapier 收到 NaN 力之后物体直接消失），
    // 那种 bug 极难查。宁可在这里补 0。
    this.velocity = { x: velocity.x ?? 0, y: velocity.y ?? 0, z: velocity.z ?? 0 };
  }

  private readonly velocity: { x: number; y: number; z: number };

  fullnessAt(_x: number, y: number, _z: number): number {
    if (y < this.minY || y > this.maxY) return 0;
    return this.fullness;
  }

  velocityAt(): { x: number; y: number; z: number } {
    return this.velocity;
  }

  densityAt(): number {
    return this.density;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
