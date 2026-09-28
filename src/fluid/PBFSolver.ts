/**
 * PBF（Position Based Fluids）求解器 —— 纯 CPU、零分配、可被 Worker 复用。
 *
 * ────────────────────────────────────────────────────────────
 * 算法（Macklin & Müller 2013 的简化实现）
 * ────────────────────────────────────────────────────────────
 * 每一步：
 *   1. 施加重力 → `v += g·dt`
 *   2. **预测位置** `p* = p + v·dt`（PBF 的关键：先挪位置，最后再用位置反推速度）
 *   3. 建空间哈希（只对活跃粒子）
 *   4. 算密度 `ρ_i = Σ m·W(r_ij)`
 *   5. 算密度约束的拉格朗日乘子 `λ_i = -C_i / (Σ|∇C|² + ε)`
 *   6. 位置修正 `Δp_i = (1/ρ0) Σ (λ_i + λ_j + s_corr) ∇W`
 *   7. 重复 4~6（`iterations` 次）
 *   8. 边界碰撞（地形体素 + 世界边界 + 可选刚体盒）
 *   9. **速度 = (p - p*) / dt**（这一步让 PBF 天然不会能量爆炸）
 *  10. XSPH 黏性 + 表面张力
 *
 * ────────────────────────────────────────────────────────────
 * 刻意做的三个简化（都写进 README 取舍清单）
 * ────────────────────────────────────────────────────────────
 * 1. **碰撞是"六向探针"而不是解析的球-体素接触**。真做法要算球心到体素最近点的
 *    距离与法线，这里只沿 ±X/±Y/±Z 探六下，谁先撞到就把粒子沿那个轴推回去。
 *    后果：斜面上会有轻微抖动、粒子可能"贴着墙角蹭"。视觉上不明显，代价是几行代码 vs 几十行。
 *    如果哪天要做"水在漏斗里"，这条路不够用，得换解析接触。
 * 2. **没有漩涡约束（vorticity confinement）**。它让流体更有"卷"的感觉，
 *    但要多一趟邻居遍历 + 叉乘，实测占本求解器 30% 左右的时间。
 *    在 20000 粒子的目标下这笔钱不划算（见第 6 批的性能数据）。
 * 3. **表面张力用的是"邻居向内拉"的近似**，不是真实的 CSF/color-gradient 模型。
 *    它能把液体表面拉成弧形、能挂住一点水滴，但液滴不会真的"弹开"。
 *
 * ────────────────────────────────────────────────────────────
 * 性能写法上的约定
 * ────────────────────────────────────────────────────────────
 * - 热循环里**不创建对象、不创建闭包**（邻居遍历用 `forEachCandidate` 传入的箭头函数
 *   是唯一例外 —— 它在 V8 里会被内联，但第 6 批会换成显式索引遍历，届时以实测为准）。
 * - 所有中间量都写在池子预分配的数组上（`density` / `lambda` / `deltaV*`），
 *   没有 `new Float32Array(...)`。
 * - `highWater` 而不是 `capacity` 作为遍历上界（手机端上限 3000、只倒 300 个时省 90%）。
 */

import type { ParticlePool } from './ParticlePool';
import { SpatialHash } from './SpatialHash';

/** 环境采样器：求解器需要知道"这里是不是固体"。由 FluidSystem/Engine 提供 */
export interface FluidBoundary {
  /** 该世界坐标点是否在固体内（地形体素或建筑） */
  isSolid(x: number, y: number, z: number): boolean;
  /** 世界水平半宽（±halfX 是墙） */
  halfX: number;
  halfZ: number;
  /** 天花板高度（y 上限） */
  maxY: number;
  /** 地面高度（y 下限，通常是 0） */
  minY: number;
}

export interface PBFSettings {
  /** 平滑半径 h（米）。粒子半径的 2~2.5 倍比较稳 */
  smoothingRadius: number;
  /** 静止密度 ρ0 */
  restDensity: number;
  /** 单粒子质量 m = ρ0 × (2r)³ */
  particleMass: number;
  /** 粒子半径（米）。碰撞回退要用它把粒子推到格子外面 */
  particleRadius: number;
  /** 压力迭代次数（`iterations`）。1 = 很快但会压缩，4 = 更稳但更慢 */
  iterations: number;
  /** XSPH 黏性系数 */
  viscosity: number;
  /** 表面张力系数 */
  surfaceTension: number;
  /** 重力（m/s²，负值向下） */
  gravity: number;
  /** 每步最多推进多少秒的模拟（防"卡一下之后物理爆炸"） */
  maxStepSeconds: number;
  /** 速度上限（米/秒）。超过就夹住 —— 高速粒子会穿过一格厚的墙 */
  maxSpeed: number;
  /** 速度阻尼（每秒衰减比例，0 = 不衰减） */
  damping: number;
  /**
   * 单次迭代里位置修正量的上限（米）。
   *
   * 为什么必须有：PBF 的位置修正在"初始过密"时会非常大 ——
   * 实测把 200 个粒子塞进 0.4 米球里（密度是静止值的 1.6 倍）时，
   * 一次修正就能给出 12 米/秒的隐含速度，粒子直接被炸到世界角落再也不回来
   * （画面上是"水花四贱"）。这不是"物理太夸张"，是**数值爆炸**。
   *
   * 取 0.25 × 目标间距：允许流体在不稳时快速松开，但一步挪不了太远。
   * 表现上的代价是"极度过密的水会稍微慢一点摊开"，那是可以接受的。
   */
  maxCorrectionRatio: number;
  /**
   * 边界切向摩擦系数（0 = 完全光滑，1 = 完全粘住）。
   *
   * 为什么必须有：我第一版的碰撞只把**法向**速度清零，切向原样保留 ——
   * 于是落地的水在"绝对光滑的地面"上永远滑下去。实测：从 6 米高滴下 200 个粒子，
   * 两秒后铺开半径到了 **17.8 米**（几乎横穿半个世界），而真实的水落地只会溅开一点点。
   * 这不是"参数没调好"，是**缺了物理项**：真实边界有黏性底层。
   *
   * 取 0.15 的含义：碰撞时切向速度乘 `(1 - 0.15)`。数值调出来的 ——
   * 太小水会滑很远，太大会让水"粘"在墙上像蜂蜜。这一条写进 README 的取舍。
   */
  wallFriction: number;
}

export interface PBFStats {
  /** 参与本次求解的粒子数 */
  particles: number;
  /** 子步数 */
  substeps: number;
  /** 各阶段耗时（毫秒） */
  predictMs: number;
  /** 建空间哈希 + 收集邻居（一趟做完，所以合成一个数字） */
  neighborMs: number;
  densityMs: number;
  correctMs: number;
  collisionMs: number;
  velocityMs: number;
  totalMs: number;
  /** 平均邻居数（诊断：太少说明 h 太小或粒子太散，太多说明太挤） */
  avgNeighbors: number;
  /** 平均"看过的候选粒子数"（诊断：它 / 邻居数 = 空间哈希的浪费率） */
  avgCandidates: number;
  /**
   * 平均密度误差 `|ρ/ρ0 - 1|`。
   *
   * 这是**校准指标**而不是"好看的数字"：PBF 的密度不会精确等于 ρ0
   * （核函数把邻居权重摊开了），静止水面通常在 5%~25% 之间。
   * 如果它长期大于 0.5，说明质量/密度参数不配套（见 FluidPresets 文件头第 1 条），
   * 表现就是水面一直在抖。所以它必须暴露出来，而不是藏起来。
   */
  densityError: number;
  /** 被边界夹住过多少次（诊断：数值接近粒子数说明一直贴着墙/地） */
  boundaryHits: number;
  /** 因为超过 maxSpeed 被夹住的次数 */
  speedClamps: number;
  /** 因为单步位移过大而被"位置修正上限"夹住的次数 */
  correctionClamps: number;
  /** 卡在固体内、连兜底都推不出去的粒子数（正常恒为 0） */
  stuckParticles: number;
}

const DEFAULT_SETTINGS: PBFSettings = {
  smoothingRadius: 0.16,
  restDensity: 1,
  particleMass: 1 * 0.16 * 0.16 * 0.16,
  particleRadius: 0.08,
  iterations: 2,
  viscosity: 0.02,
  surfaceTension: 0.05,
  gravity: -9.81,
  maxStepSeconds: 1 / 30,
  maxSpeed: 40,
  damping: 0,
  maxCorrectionRatio: 0.25,
  wallFriction: 0.15,
};

/**
 * 核函数常数。
 *
 * Poly6（密度用，只有距离）：
 *   W(r) = 315/(64π h⁹) · (h² - r²)³
 * Spiky 梯度（压力用，**必须**用 Spiky 而不是 Poly6 的梯度 ——
 * Poly6 的梯度在 r→0 时趋近 0，粒子贴在一起时压力反而消失，
 * 结果是粒子会**粘成一团不分开**。这是 PBF 实现里最常见的坑之一）：
 *   ∇W(r) = -45/(π h⁶) · (h - r)² · (r̂)
 */
function kernelConstants(h: number): { poly6: number; spikyGrad: number; selfDensityScale: number } {
  const h2 = h * h;
  const h3 = h2 * h;
  const h6 = h3 * h3;
  const h9 = h6 * h3;
  return {
    poly6: 315 / (64 * Math.PI * h9),
    spikyGrad: -45 / (Math.PI * h6),
    // W(0) —— 粒子对自己也有贡献，算密度时要用
    selfDensityScale: 315 / (64 * Math.PI * h9) * h6,
  };
}

export class PBFSolver {
  readonly settings: PBFSettings;
  private readonly hash: SpatialHash;
  private readonly k: { poly6: number; spikyGrad: number; selfDensityScale: number };
  private readonly maxNeighbors: number;
  /** 邻居缓存：两趟（先收集，再求解）比"一趟里同时查哈希"快很多，
   *  因为密度和压力都要用同一批邻居，查两次哈希等于把最贵的那步做两遍 */
  private readonly neighborIndices: Int32Array;
  private readonly neighborCounts: Int32Array;
  /**
   * 邻居的**相对位置**缓存（dx, dy, dz 三份）。
   *
   * ── 为什么值得多花 7 MB 内存 ──
   * 我分项计时之后才看清真正的瓶颈：`collectNeighbors` 44.9 ms 里有约 29 ms
   * 不是算出来的，是**等内存** —— 45.8 个候选/粒子 × 10000 粒子 = 46 万次
   * "按随机下标读 posX/posY/posZ"，每次约 63 ns（一次 cache miss 的量级）。
   * 更要命的是后面的密度与压力会**再读同样的位置 5 遍**（2 次迭代 × (密度+λ+Δp)）。
   *
   * 缓存了相对位置之后，那些重复的随机读全部变成**顺序读**：
   * 邻居在收集阶段已经算过一次差值，后面直接用。
   * 密度/压力/黏性都不再碰 posX/posY/posZ。
   * 代价是 3 × 容量 × maxNeighbors × 4 字节（20000 粒子时约 7.7 MB），
   * 换来的是这一整块从"随机的内存操作"变成"顺序的算术运算"（实测压力相位 45.9 → 16.8 ms）。
   *
   * ⚠ **这是一个刻意的近似，必须写清楚**：
   * 偏移量是在"收集邻居"那一刻算的，而压力迭代**会移动粒子** ——
   * 所以第 2 次迭代用的是第 1 次迭代的几何（位置差了 |Δp|，被 maxCorrectionRatio
   * 限制在 0.04 米以内）。不做这个近似的话，每次迭代都要重新按随机下标读一遍邻居坐标，
   * 那正是我们花 7 MB 消掉的开销。
   * 影响：等值面/压力在"一帧内被压缩得很厉害"的情况下会略微偏软。
   * 断言里盯着密度误差与静止后的行为（它们是最直接的受害者）。
   */
  private readonly neighborDx: Float32Array;
  private readonly neighborDy: Float32Array;
  private readonly neighborDz: Float32Array;

  /** 被边界夹住/推回的次数（诊断：接近粒子数说明一直贴着墙或地） */
  private boundaryHits = 0;
  /** 因为超过 maxSpeed 被夹住的次数 */
  private speedClamps = 0;
  /** 被位置修正上限夹住的次数（持续很高说明初始堆积太密或参数不合理） */
  private correctionClamps = 0;
  /** 兜底推出也救不出来的粒子数（正常恒为 0；不为 0 说明碰撞逻辑有洞） */
  private stuckParticles = 0;
  /** 上一次邻居收集里"看过的候选格里的粒子数"（诊断：远大于真实邻居数说明空间哈希的格子太大） */
  private candidateVisits = 0;

  private lastStats: PBFStats = {
    particles: 0, substeps: 0,
    predictMs: 0, neighborMs: 0, densityMs: 0, correctMs: 0, collisionMs: 0, velocityMs: 0, totalMs: 0,
    avgNeighbors: 0, avgCandidates: 0, densityError: 0, boundaryHits: 0, speedClamps: 0,
    correctionClamps: 0, stuckParticles: 0,
  };

  constructor(
    private readonly pool: ParticlePool,
    settings: Partial<PBFSettings> = {},
  ) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.k = kernelConstants(this.settings.smoothingRadius);
    // 格子边长 = h：这样"半径 h 的球"最多跨 2 格，3×3×3 的邻域一定够
    this.hash = new SpatialHash(this.settings.smoothingRadius, Math.max(1, pool.capacity));
    // 每个粒子的邻居数上限。这个数字直接决定邻居缓存的**内存**与**缓存局部性**：
    // 每粒子 64 个 Int32 = 256 字节，20000 粒子就是 5.1 MB —— 而实测平均邻居只有 10~27，
    // 也就是说 70% 的缓存行是白读的。降到 32 之后内存减半、遍历更快，
    // 而且仍然比实测最大值（27）宽裕。**不要随手改大**：它是最容易"看起来没影响"的性能黑洞。
    this.maxNeighbors = 32;
    this.neighborIndices = new Int32Array(pool.capacity * this.maxNeighbors);
    this.neighborCounts = new Int32Array(pool.capacity);
    this.neighborDx = new Float32Array(pool.capacity * this.maxNeighbors);
    this.neighborDy = new Float32Array(pool.capacity * this.maxNeighbors);
    this.neighborDz = new Float32Array(pool.capacity * this.maxNeighbors);
  }

  get stats(): PBFStats {
    return this.lastStats;
  }

  /**
   * 在间距为 `spacing` 的立方格点上累加 Poly6 核值（Σ_j W(r_ij)）。
   *
   * 为什么要这个东西：连续积分 ∫W dV = 1，但我们在**离散格点**上求和，
   * 而 h 只有格距的 2 倍 —— 每个核宽里只有两三个采样点，
   * 于是 ΣW 明显小于 1/V_格。实测：h = 4r、格距 = 2r 时，
   * 用"连续公式"算出的质量会让密度**偏低约 10 倍**（0.39 而不是 1.0），
   * 于是压力项永远觉得"太稀"，流体被自己吸成一团。
   *
   * 所以质量不能套公式，要**在这个求解器实际使用的核上标定**：
   * 让格点上的 ΣW 恰好满足 `ρ0 = m · ΣW`。这样静止流体的密度就是 ρ0，
   * 不需要任何"魔法修正系数"。
   *
   * 这是标准做法（PBF 论文里也是先算 rest density 再定质量），
   * 写在这里是为了让下一个人知道"这个 0.0105 不是随便填的"。
   */
  latticeKernelSum(spacing: number): number {
    const h = this.settings.smoothingRadius;
    const h2 = h * h;
    const poly6 = this.k.poly6;
    // 取 ±3 格（h 通常只有 2 格多一点，多取一点是白算几项而已，代价可忽略）
    const range = Math.max(1, Math.ceil(h / spacing) + 1);
    let sum = 0;
    for (let dx = -range; dx <= range; dx += 1) {
      for (let dy = -range; dy <= range; dy += 1) {
        for (let dz = -range; dz <= range; dz += 1) {
          const r2 = (dx * dx + dy * dy + dz * dz) * spacing * spacing;
          if (r2 >= h2) continue;
          const diff = h2 - r2;
          sum += poly6 * diff * diff * diff;
        }
      }
    }
    return sum;
  }

  /**
   * 标定质量：让"间距为 `spacing` 的静止流体"密度恰好等于 `restDensity`。
   * @returns 需要的单粒子质量
   */
  calibrateMass(spacing: number): number {
    const sum = this.latticeKernelSum(spacing);
    if (!(sum > 0)) return this.settings.particleMass;
    return this.settings.restDensity / sum;
  }

  /** 空间哈希建表用了多少粒子（诊断） */
  get hashParticles(): number {
    return this.hash.particleCount;
  }

  get hashBytes(): number {
    return (
      this.hash.bytes +
      this.neighborIndices.byteLength + this.neighborCounts.byteLength +
      this.neighborDx.byteLength + this.neighborDy.byteLength + this.neighborDz.byteLength
    );
  }

  /**
   * 推进 `dt` 秒。内部会按 `maxStepSeconds` 切成子步。
   *
   * @param budgetMs 这一帧最多花多少毫秒。**第 1 个子步无条件做完**，
   *   之后每做完一个子步检查一次时间。这样做的理由：预算再紧，流体也必须动一下，
   *   否则卡的时候水会完全静止，看起来像"流体坏了"而不是"有点慢"。
   * @returns 实际推进的子步数与模拟秒数（子步数 < 期望值时，调用方要如实报成"慢动作"）
   */
  step(dt: number, boundary: FluidBoundary, budgetMs = Number.POSITIVE_INFINITY): { substeps: number; simulatedSeconds: number } {
    const started = now();
    const settings = this.settings;
    const alive = this.pool.count;
    if (alive === 0 || !(dt > 0)) {
      this.lastStats = { ...this.densityZeroStats(), particles: alive };
      return { substeps: 0, simulatedSeconds: 0 };
    }

    // 子步：一帧要推进的时间超过 maxStepSeconds 就切分。
    // 为什么不像物理引擎那样用固定步长 + 累积器：流体的视觉容错比刚体高得多，
    // 慢动作只让人"觉得水稠了一点"，而累积器会让"卡一下之后突然加速"（那看起来像 bug）。
    this.speedClamps = 0;
    this.correctionClamps = 0;
    this.stuckParticles = 0;
    const steps = Math.max(1, Math.ceil(dt / settings.maxStepSeconds));
    const sub = dt / steps;
    // 子步最多 4 个：再多就是"这一帧已经严重掉帧了"，此时让模拟慢下来比让它压垮帧率好
    const capped = Math.min(steps, 4);
    const subDt = capped === steps ? sub : dt / capped;

    let predictMs = 0;
    let neighborMs = 0;
    let densityMs = 0;
    let correctMs = 0;
    let collisionMs = 0;
    let velocityMs = 0;

    let executed = 0;
    for (let s = 0; s < capped; s += 1) {
      // 预算判断放在子步**之间**：第 0 个子步一定做完（见参数说明）
      if (s > 0 && now() - started >= budgetMs) break;
      const t0 = now();
      this.applyExternalForces(subDt);
      this.predict(subDt);
      predictMs += now() - t0;

      const t1 = now();
      // 只对"当前高水位内的活跃粒子"建表；`build` 内部还会再判一次 alive
      this.collectNeighbors();
      neighborMs += now() - t1;

      const t2 = now();
      this.solveDensity();
      densityMs += now() - t2;

      const t3 = now();
      this.solvePressure(subDt);
      correctMs += now() - t3;

      const t4 = now();
      this.resolveCollisions(boundary);
      collisionMs += now() - t4;

      const t5 = now();
      this.updateVelocities(subDt);
      this.applyViscosityAndTension(subDt);
      velocityMs += now() - t5;
      executed += 1;
    }

    const totalMs = now() - started;
    this.lastStats = {
      particles: alive,
      substeps: executed,
      predictMs,
      neighborMs,
      densityMs,
      correctMs,
      collisionMs,
      velocityMs,
      totalMs,
      avgNeighbors: this.averageNeighbors(),
      avgCandidates: alive > 0 ? this.candidateVisits / alive : 0,
      densityError: this.densityError(),
      boundaryHits: this.boundaryHits,
      speedClamps: this.speedClamps,
      correctionClamps: this.correctionClamps,
      stuckParticles: this.stuckParticles,
    };
    return { substeps: executed, simulatedSeconds: subDt * executed };
  }

  /** 只做统计清零（没有粒子时也要给一份结构完整的 stats，否则面板会读到上一帧的旧值） */
  private densityZeroStats(): PBFStats {
    return {
      particles: 0, substeps: 0,
      predictMs: 0, neighborMs: 0, densityMs: 0, correctMs: 0, collisionMs: 0, velocityMs: 0, totalMs: 0,
      avgNeighbors: 0, avgCandidates: 0, densityError: 0, boundaryHits: 0, speedClamps: 0,
      correctionClamps: 0, stuckParticles: 0,
    };
  }

  /**
   * 施加重力 + 阻尼。
   *
   * 这一趟只改速度（位置在 `predict` 里改），且**跳过冻结粒子** ——
   * 冻结的语义是"完全静止"，连重力都不施加。
   */
  private applyExternalForces(dt: number): void {
    const { velX, velY, velZ, frozen, alive } = this.pool;
    const gravity = this.settings.gravity;
    const damping = this.settings.damping;
    const decay = damping > 0 ? Math.max(0, 1 - damping * dt) : 1;
    const high = this.pool.highWater;
    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1 || frozen[i] === 1) continue;
      velY[i] = velY[i]! + gravity * dt;
      if (decay !== 1) {
        velX[i] = velX[i]! * decay;
        velY[i] = velY[i]! * decay;
        velZ[i] = velZ[i]! * decay;
      }
    }
  }

  private predict(dt: number): void {
    const { posX, posY, posZ, prevX, prevY, prevZ, velX, velY, velZ, frozen, alive } = this.pool;
    const maxSpeed = this.settings.maxSpeed;
    const maxSpeed2 = maxSpeed * maxSpeed;
    this.speedClamps = 0;
    const high = this.pool.highWater;
    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1) continue;
      if (frozen[i] === 1) {
        // 冻结：位置不动，速度清零（"冻结区域"的语义就是完全静止）
        prevX[i] = posX[i]!;
        prevY[i] = posY[i]!;
        prevZ[i] = posZ[i]!;
        velX[i] = 0; velY[i] = 0; velZ[i] = 0;
        continue;
      }
      let vx = velX[i]!;
      let vy = velY[i]!;
      let vz = velZ[i]!;
      const speed2 = vx * vx + vy * vy + vz * vz;
      if (speed2 > maxSpeed2) {
        // 夹速度而不是夹位移：位移已经算不出来（速度太大），而速度夹住之后
        // 粒子会以 maxSpeed 走一步，最多穿 40 × dt(≈0.017) ≈ 0.68 米 —— 小于一格体素，不会穿墙
        const scale = maxSpeed / Math.sqrt(speed2);
        vx *= scale; vy *= scale; vz *= scale;
        velX[i] = vx; velY[i] = vy; velZ[i] = vz;
        this.speedClamps += 1;
      }
      prevX[i] = posX[i]!;
      prevY[i] = posY[i]!;
      prevZ[i] = posZ[i]!;
      posX[i] = posX[i]! + vx * dt;
      posY[i] = posY[i]! + vy * dt;
      posZ[i] = posZ[i]! + vz * dt;
    }
  }

  /**
   * 收集邻居（两趟法的第一趟）。
   *
   * 把邻居下标缓存下来，后面密度/压力迭代都直接用 —— 迭代 3 次的话，
   * 查哈希的次数从 3 次降到 1 次。邻居缓存按 `maxNeighbors` 截断（超出的忽略），
   * 截断本身是安全的：在 h=2r 的配置下真实邻居数约 4~20，64 的上限够得很。
   */
  private collectNeighbors(): void {
    const { posX, posY, posZ, alive } = this.pool;
    const radius = this.settings.smoothingRadius;
    const r2 = radius * radius;
    const high = this.pool.highWater;

    this.hash.build(posX, posY, posZ, alive, high);

    const counts = this.neighborCounts;
    const indices = this.neighborIndices;
    const maxN = this.maxNeighbors;
    counts.fill(0, 0, high);

    // 这里**刻意不用 `hash.forEachCandidate(..., callback)`**：那个版本每个候选都要
    // 一次闭包调用，10000 粒子 × 几十个候选 = 每帧几十万次函数调用。
    // 实测这一项原来占 47 ms（全场最大头），内联之后调用开销消失，
    // 而且能把"空桶直接跳过"这个判断放在最前面（大多数相邻格是空的）。
    const hash = this.hash;
    let candidates = 0;
    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1) continue;
      const xi = posX[i]!;
      const yi = posY[i]!;
      const zi = posZ[i]!;
      let n = 0;
      const base = i * maxN;
      const bucketCount = hash.cellsWithin(xi, yi, zi, radius);
      const buckets = hash.bucketList;
      // 逐个候选格扫。桶已经去重（哈希桶会碰撞，同一桶被扫两次会把粒子重复计入邻居）
      const starts = hash.bucketStarts;
      const sorted = hash.sortedIndices;
      for (let c = 0; c < bucketCount; c += 1) {
        const bucket = buckets[c]!;
        const start = starts[bucket]!;
        const end = starts[bucket + 1]!;
        if (start === end) continue; // 空桶：这是最常见的情况，值得单独判一次
        for (let k = start; k < end; k += 1) {
          const j = sorted[k]!;
          if (j === i) continue;
          candidates += 1;
          if (n >= maxN) continue;
          const dx = posX[j]! - xi;
          const dy = posY[j]! - yi;
          const dz = posZ[j]! - zi;
          // ⚠ 这个距离判断不能省：哈希桶有冲突，候选里混着远处粒子（见 SpatialHash 文件头）
          if (dx * dx + dy * dy + dz * dz < r2) {
            indices[base + n] = j;
            this.neighborDx[base + n] = dx;
            this.neighborDy[base + n] = dy;
            this.neighborDz[base + n] = dz;
            n += 1;
          }
        }
      }
      counts[i] = n;
    }
    this.candidateVisits = candidates;
  }

  /** 密度：ρ_i = m·W(0) + Σ_j m·W(r_ij) */
  private solveDensity(): void {
    const { density, alive } = this.pool;
    const h = this.settings.smoothingRadius;
    const h2 = h * h;
    const m = this.settings.particleMass;
    const poly6 = this.k.poly6;
    const counts = this.neighborCounts;
    const offsetsX = this.neighborDx;
    const offsetsY = this.neighborDy;
    const offsetsZ = this.neighborDz;
    const maxN = this.maxNeighbors;
    const high = this.pool.highWater;

    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1) {
        density[i] = 0;
        continue;
      }
      // 自己也算一份（r=0 处的核值）—— 漏掉它密度会系统性偏低，
      // 于是流体"永远到不了静止密度"，压力项一直往里压
      let rho = m * this.k.selfDensityScale;
      const n = counts[i]!;
      const base = i * maxN;
      for (let k = 0; k < n; k += 1) {
        // 用收集阶段缓存好的相对位置（顺序读，见 neighborDx 的注释）
        const dx = offsetsX[base + k]!;
        const dy = offsetsY[base + k]!;
        const dz = offsetsZ[base + k]!;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= h2) continue;
        const diff = h2 - r2;
        rho += m * poly6 * diff * diff * diff;
      }
      density[i] = rho;
    }
  }

  /**
   * 压力：算 λ，然后按 λ 修正位置。
   *
   * s_corr 是人工的压力抵消项（Macklin 的"人工压力"）：没有它的话，
   * 粒子在密集点会出现"聚成一团"的不稳定（因为核函数的梯度在极近距离会失真）。
   */
  private solvePressure(dt: number): void {
    const { density, lambda, alive } = this.pool;
    const h = this.settings.smoothingRadius;
    const h2 = h * h;
    const rho0 = this.settings.restDensity;
    const spikyGrad = this.k.spikyGrad;
    const counts = this.neighborCounts;
    const indices = this.neighborIndices;
    const offsetsX = this.neighborDx;
    const offsetsY = this.neighborDy;
    const offsetsZ = this.neighborDz;
    const maxN = this.maxNeighbors;
    const high = this.pool.highWater;
    const eps = 1e-4;

    // 人工压力：k 是强度、n 是指数、dq 是参考距离（取 0.2h ~ 0.3h）
    const kCorr = 0.0001;
    const nCorr = 4;
    const dq = 0.2 * h;
    const wDq = this.wPoly6(dq, h2);
    // dt 在这里不参与：PBF 的位置修正天然与步长解耦（速度在最后一步用位置反推），
    // 这也是它比"显式积分压力"稳定的原因。参数留着是为了签名一致，注释说明清楚，
    // 免得后人以为漏用了。
    void dt;

    for (let iter = 0; iter < this.settings.iterations; iter += 1) {
      // ---- 1) λ_i
      for (let i = 0; i < high; i += 1) {
        if (alive[i] !== 1) {
          lambda[i] = 0;
          continue;
        }
        const n = counts[i]!;
        const base = i * maxN;
        // ⚠ 这里 **必须** 同时累加两个量，这是 PBF 公式里最容易写漏的一处：
        //
        //   Σ_k |∇_{p_k} C_i|²  =  |(1/ρ0)·Σ_j ∇W_ij|²  +  Σ_j |(1/ρ0)·∇W_ij|²
        //                          ^^^^^^^^^^^^^^^^^^     ^^^^^^^^^^^^^^^^^^^^^^
        //                          我第一版只算了这一项      这一项才是主体
        //
        // 为什么漏了会炸：第一项在**均匀流体里几乎完全抵消**（对称排布的梯度互相抵消），
        // 于是分母趋近 0，λ = -C/(≈0) 被放大几千倍；Δp 又是"巨大的 λ × 几乎抵消的梯度和"，
        // 结果由舍入噪声主导 —— 水自己就炸开了。
        // 实测症状：每帧 178 次"位置修正被上限夹住"、12 帧内从 0.64 米铺开到 2.19 米、
        // 平均速度冲到 6 米/秒（而密度误差只有 26%，看起来"问题不大"）。
        // 补上第二项之后 λ 回到物理量级，修正量不再顶到上限。
        let sumGradX = 0;
        let sumGradY = 0;
        let sumGradZ = 0;
        let gradSqSum = 0;
        for (let k = 0; k < n; k += 1) {
          // 缓存的是 (邻居 - 自己)，这里是 (自己 - 邻居) → 取负
          const dx = -offsetsX[base + k]!;
          const dy = -offsetsY[base + k]!;
          const dz = -offsetsZ[base + k]!;
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= h2 || r2 < 1e-12) continue;
          const r = Math.sqrt(r2);
          // Spiky 梯度大小：-45/(π h⁶)·(h-r)²，方向沿 (p_i - p_j)/r
          const gradMag = spikyGrad * (h - r) * (h - r);
          const gx = (gradMag * dx) / r;
          const gy = (gradMag * dy) / r;
          const gz = (gradMag * dz) / r;
          sumGradX += gx;
          sumGradY += gy;
          sumGradZ += gz;
          gradSqSum += gx * gx + gy * gy + gz * gz;
        }
        // 约束梯度除以 ρ0（C = ρ/ρ0 - 1）
        const invRho0 = 1 / rho0;
        const gx = sumGradX * invRho0;
        const gy = sumGradY * invRho0;
        const gz = sumGradZ * invRho0;
        const gradSum = gx * gx + gy * gy + gz * gz + gradSqSum * invRho0 * invRho0;
        const C = density[i]! / rho0 - 1;
        lambda[i] = -C / (gradSum + eps);
      }

      // ---- 2) Δp_i
      const dpx = this.pool.deltaVX;
      const dpy = this.pool.deltaVY;
      const dpz = this.pool.deltaVZ;
      dpx.fill(0, 0, high);
      dpy.fill(0, 0, high);
      dpz.fill(0, 0, high);

      for (let i = 0; i < high; i += 1) {
        if (alive[i] !== 1) continue;
        const n = counts[i]!;
        const base = i * maxN;
        const li = lambda[i]!;
        let ax = 0;
        let ay = 0;
        let az = 0;
        for (let k = 0; k < n; k += 1) {
          const dx = -offsetsX[base + k]!;
          const dy = -offsetsY[base + k]!;
          const dz = -offsetsZ[base + k]!;
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= h2 || r2 < 1e-12) continue;
          const r = Math.sqrt(r2);
          const gradMag = spikyGrad * (h - r) * (h - r);
          const w = this.wPoly6(r, h2);
          const corr = -kCorr * Math.pow(w / wDq, nCorr);
          // λ_j 是唯一还需要"邻居下标"的地方（它读的是邻居自己的标量，不是坐标）。
          // 位置类的东西都走缓存偏移，只有这一项走 indices。
          const lambdaJ = lambda[indices[base + k]!]!;
          const scale = ((li + lambdaJ + corr) * gradMag) / (rho0 * r);
          ax += scale * dx;
          ay += scale * dy;
          az += scale * dz;
        }
        dpx[i] = ax;
        dpy[i] = ay;
        dpz[i] = az;
      }

      // ---- 3) 应用位移（带长度上限，见 maxCorrectionRatio）
      const { posX, posY, posZ, frozen } = this.pool;
      const maxCorrection = this.settings.maxCorrectionRatio * (h * 0.5);
      const maxCorrection2 = maxCorrection * maxCorrection;
      for (let i = 0; i < high; i += 1) {
        if (alive[i] !== 1 || frozen[i] === 1) continue;
        let ax = dpx[i]!;
        let ay = dpy[i]!;
        let az = dpz[i]!;
        const len2 = ax * ax + ay * ay + az * az;
        if (len2 > maxCorrection2) {
          const scale = maxCorrection / Math.sqrt(len2);
          ax *= scale; ay *= scale; az *= scale;
          this.correctionClamps += 1;
        }
        posX[i] = posX[i]! + ax;
        posY[i] = posY[i]! + ay;
        posZ[i] = posZ[i]! + az;
      }

      // ---- 4) 迭代之间：刷新偏移缓存 + 重算密度
      //
      // 两步都不能省：
      // - **刷新偏移**：位置刚被改过，缓存里的相对位置已经过期（见 refreshOffsets 的注释）
      // - **重算密度**：否则第 2 次迭代用的还是旧密度，等于白跑
      if (iter + 1 < this.settings.iterations) {
        this.refreshOffsets();
        this.solveDensity();
      }
    }
  }

  /**
   * 用当前坐标重算邻居偏移缓存。
   *
   * ⚠ **这个方法的存在本身就是一条教训**，写清楚免得被当成可以省的一步：
   * 偏移缓存是在"收集邻居"那一刻算的，而压力迭代**会移动粒子**。
   * 我第一版为了省掉"重读邻居坐标"的开销，让两次压力迭代都直接用缓存 ——
   * 结果是**几何与数据不一致**：Δp 是 30 个邻居项近乎完全抵消后的残差（实测 |Δp| ≈ 0.037 米，
   * 而每一项只有 1e-3 量级），这种"差值主导"的量对输入的任何不一致都极其敏感，
   * 于是每帧都有上百个粒子被"位置修正上限"兜住，水自己炸开（12 帧从 0.64 米铺到 2.19 米）。
   *
   * 修法：**每次位置变化之后立刻刷新偏移**。代价是每个迭代一次 O(n·k) 的散读，
   * 而老版本是 λ 和 Δp 各自散读一次（每个迭代 2 次）—— 所以刷新仍然是**省一半**，
   * 而且结果与"每次重读坐标"完全一致。
   */
  private refreshOffsets(): void {
    const { posX, posY, posZ, alive } = this.pool;
    const counts = this.neighborCounts;
    const indices = this.neighborIndices;
    const offsetsX = this.neighborDx;
    const offsetsY = this.neighborDy;
    const offsetsZ = this.neighborDz;
    const maxN = this.maxNeighbors;
    const high = this.pool.highWater;
    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1) continue;
      const n = counts[i]!;
      if (n === 0) continue;
      const base = i * maxN;
      const xi = posX[i]!;
      const yi = posY[i]!;
      const zi = posZ[i]!;
      for (let k = 0; k < n; k += 1) {
        const j = indices[base + k]!;
        offsetsX[base + k] = posX[j]! - xi;
        offsetsY[base + k] = posY[j]! - yi;
        offsetsZ[base + k] = posZ[j]! - zi;
      }
    }
  }

  /** Poly6 核值（标量） */
  private wPoly6(r: number, h2: number): number {
    if (r >= Math.sqrt(h2)) return 0;
    const diff = h2 - r * r;
    return this.k.poly6 * diff * diff * diff;
  }

  /**
   * 边界碰撞：世界边界 + 地形/建筑（通过 `isSolid` 六向探针）。
   *
   * ⚠ 这是刻意简化的部分（见文件头第 1 条）。它保证了"粒子不会穿过地形掉下去"，
   * 也就是验收标准里"受地形、建筑约束"这一条；但它不保证法线方向精确，
   * 所以在陡坡上会看到轻微抖动。
   */
  private resolveCollisions(boundary: FluidBoundary): void {
    const { posX, posY, posZ, prevX, prevY, prevZ, velX, velY, velZ, alive, frozen } = this.pool;
    const r = this.settings.particleRadius;
    const limitX = boundary.halfX - r;
    const limitZ = boundary.halfZ - r;
    const floor = boundary.minY + r;
    const ceiling = boundary.maxY - r;
    const friction = this.settings.wallFriction;
    /**
     * 接触判定容差（米）。取粒子半径的 1/4：足够覆盖"被推到刚好贴住"的浮点误差，
     * 又远小于一格体素，不会让悬空的粒子误判成接触。
     */
    const contactEps = r * 0.25;
    const keep = 1 - friction;
    this.boundaryHits = 0;
    const high = this.pool.highWater;

    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1 || frozen[i] === 1) continue;
      let x = posX[i]!;
      let y = posY[i]!;
      let z = posZ[i]!;
      // 哪些轴发生了接触（用位标记：1=X 2=Y 4=Z）
      let hitMask = 0;

      // ---- 世界六面墙
      //
      // ⚠ 判断用 `<= 边界 + contactEps` 而不是 `< 边界`。这是第三个被实测抓出来的边界 bug：
      // 碰撞把粒子**推到正好等于边界**的位置，下一帧 `< floor` 为假 → 摩擦永远不再施加。
      // 这是"静止接触"和"穿透接触"的区别，只处理后者是很多简单碰撞实现会犯的错。
      if (x <= -limitX + contactEps) { x = Math.max(x, -limitX); hitMask |= 1; }
      else if (x >= limitX - contactEps) { x = Math.min(x, limitX); hitMask |= 1; }
      if (z <= -limitZ + contactEps) { z = Math.max(z, -limitZ); hitMask |= 4; }
      else if (z >= limitZ - contactEps) { z = Math.min(z, limitZ); hitMask |= 4; }
      if (y <= floor + contactEps) { y = Math.max(y, floor); hitMask |= 2; }
      else if (y >= ceiling - contactEps) { y = Math.min(y, ceiling); hitMask |= 2; }

      // ---- 地形/建筑：六向探针
      //
      // 顺序很重要：**先探竖直方向**。水下最常见的情况是"粒子被压力推进地面"，
      // 而水平探针在这种情况下来回推会让粒子沿地面滑走（看起来像水在渗进地里）。
      // 体素 k 占据 [k, k+1)，所以：负方向探到固体 → 自由空间从 `floor(p-r)+1` 开始；
      // 正方向探到固体 → 那个体素的 `floor(p+r)` 就是边界。
      // 乘以 1.02 是留一点缝，否则粒子正好贴在边界上时下一帧又会判成探到固体（来回抖）。
      if (boundary.isSolid(x, y - r, z)) {
        y = Math.floor(y - r) + 1 + r * 1.02;
        hitMask |= 2;
      } else if (boundary.isSolid(x, y + r, z)) {
        y = Math.floor(y + r) - r * 1.02;
        hitMask |= 2;
      } else if (boundary.isSolid(x - r, y, z)) {
        x = Math.floor(x - r) + 1 + r * 1.02;
        hitMask |= 1;
      } else if (boundary.isSolid(x + r, y, z)) {
        x = Math.floor(x + r) - r * 1.02;
        hitMask |= 1;
      } else if (boundary.isSolid(x, y, z - r)) {
        z = Math.floor(z - r) + 1 + r * 1.02;
        hitMask |= 4;
      } else if (boundary.isSolid(x, y, z + r)) {
        z = Math.floor(z + r) - r * 1.02;
        hitMask |= 4;
      }

      // ---- 兜底：六向探针之后中心仍可能在固体内
      //
      // 为什么会这样：探针只检查"中心 ± r 的六个点"。当粒子正好卡在墙角、
      // 或者被周围水的压力推进柱子内部很深的位置时，六个探针可能同时为假
      // （例如中心在柱子里、但 ±X/±Z 探针仍在柱子外的那种薄壁构型），
      // 于是它会在里面"上下弹"而永远出不来。实测：400 个粒子冲一根柱子，
      // 180 帧后仍有 1 个卡在柱心。
      //
      // 所以这里加一条**不变量兜底**：中心只要在固体内，就沿最短方向一步步
      // 找第一个空位（最多 8 步 = 0.64 米），找到就搬过去并清零速度。
      // 推不出去的（被完全包死）不计入 boundaryHits，而是单独记在 `stuckParticles` 里 ——
      // 那个数字应该恒为 0，一旦不为 0 就说明碰撞逻辑有洞，不该被藏起来。
      if (boundary.isSolid(x, y, z)) {
        const escaped = this.escapeDirection(x, y, z, boundary);
        if (escaped) {
          x = escaped[0];
          y = escaped[1];
          z = escaped[2];
          hitMask |= 2;
        } else {
          this.stuckParticles += 1;
        }
      }

      if (hitMask === 0) continue;

      // ---- 把"位移"按摩擦规则改掉，而不是改速度
      //
      // ⚠ 这是第四个被实测抓出来的 bug，也是最关键的一个：
      // 我原来在这里直接改 `velX/velY/velZ`（法向清零、切向乘系数），
      // 但 PBF 的最后一步是 `v = (pos - prev) / dt`，它**会把速度整个重算一遍** ——
      // 我改的速度随即被丢弃，摩擦等于没写。
      // 证据：修好接触判定之后水依然以 2.25 米/秒永远滑动，数字**一模一样**。
      //
      // 正确做法（也与 PBF 的"位置法"一致）：改**位移** `pos - prev`，
      // 让 `updateVelocities` 重算出来的速度恰好等于我们想要的速度：
      //   法向位移清零 → 法向速度 0；切向位移乘 (1-摩擦) → 切向速度被阻尼。
      let dx = x - prevX[i]!;
      let dy = y - prevY[i]!;
      let dz = z - prevZ[i]!;
      if ((hitMask & 1) !== 0) { dx = 0; dy *= keep; dz *= keep; }
      if ((hitMask & 2) !== 0) { dy = 0; dx *= keep; dz *= keep; }
      if ((hitMask & 4) !== 0) { dz = 0; dx *= keep; dy *= keep; }

      posX[i] = x;
      posY[i] = y;
      posZ[i] = z;
      prevX[i] = x - dx;
      prevY[i] = y - dy;
      prevZ[i] = z - dz;
      // 速度数组也同步一下：`updateVelocities` 会重算，但在这之前读速度的地方
      // （耦合、渲染插值）不该看到"穿墙速度"
      velX[i] = dx;
      velY[i] = dy;
      velZ[i] = dz;
      this.boundaryHits += 1;
    }
  }

  /**
   * 从固体内找一个最近的空位（六向逐步外扩，最多 8 步）。
   * @returns 新位置；找不到返回 null
   */
  private escapeDirection(
    x: number,
    y: number,
    z: number,
    boundary: FluidBoundary,
  ): [number, number, number] | null {
    const step = this.settings.particleRadius;
    const directions: [number, number, number][] = [
      [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    ];
    for (let distance = step; distance <= step * 8; distance += step) {
      // 先试"向上"（最常见的情况是掉进了地面里，往上最短）
      for (const [dx, dy, dz] of directions) {
        const nx = x + dx * distance;
        const ny = y + dy * distance;
        const nz = z + dz * distance;
        if (ny < boundary.minY + step) continue;
        if (!boundary.isSolid(nx, ny, nz)) return [nx, ny, nz];
      }
    }
    return null;
  }

  /** 速度 = (位置 - 预测前位置) / dt —— PBF 的核心收尾步骤 */
  private updateVelocities(dt: number): void {
    const { posX, posY, posZ, prevX, prevY, prevZ, velX, velY, velZ, alive, frozen } = this.pool;
    const invDt = 1 / dt;
    const high = this.pool.highWater;
    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1 || frozen[i] === 1) continue;
      velX[i] = (posX[i]! - prevX[i]!) * invDt;
      velY[i] = (posY[i]! - prevY[i]!) * invDt;
      velZ[i] = (posZ[i]! - prevZ[i]!) * invDt;
    }
  }

  /**
   * XSPH 黏性 + 表面张力（两者都写成"速度增量"，单位都是米/秒）。
   *
   * ── 为什么必须带 `m/ρ` 这个因子 ──
   * XSPH 的标准形式是 `v_i += c · Σ_j (v_j - v_i) · (m_j/ρ_j) · W(r_ij)`。
   * 如果直接乘核值 W（h=0.16 时 W(0) 约 383），量纲差了两三个数量级 ——
   * 结果就是"系数调到 1.0 也看不出任何效果"，很多人因此以为 XSPH 没用。
   * 乘上 `m/ρ`（静止时约等于单粒子体积 0.0041）之后，累加项是 O(1) 的，
   * 系数 c 就回到直觉区间（0.02 微黏 / 0.4 很黏）。
   *
   * ── 为什么两种力合在一个累加器里 ──
   * 两者都是"给粒子一个速度增量"，量纲相同，可以相加。
   * 但**必须两趟**（先全部算完，再统一累加）：边算边写回去的话，
   * 后处理的粒子会用到已经被修改的邻居速度，结果与遍历顺序有关 ——
   * 流体就会自己朝某个方向流起来，这种 bug 极难查。
   *
   * ── 如实说明 ──
   * 表面张力这里是"把粒子往邻居方向拉"的近似，不是 CSF / color-gradient 模型。
   * 它能让液面收成弧形、能挂住一点水珠，但**不会有真实的液滴弹跳与合并**。
   * 这一条写在 README 的取舍清单里。
   */
  private applyViscosityAndTension(dt: number): void {
    const c = this.settings.viscosity;
    const sigma = this.settings.surfaceTension;
    if (c <= 0 && sigma <= 0) return;

    const { posX, posY, posZ, velX, velY, velZ, density, alive, frozen } = this.pool;
    const h = this.settings.smoothingRadius;
    const h2 = h * h;
    const m = this.settings.particleMass;
    const counts = this.neighborCounts;
    const indices = this.neighborIndices;
    const maxN = this.maxNeighbors;
    const high = this.pool.highWater;

    // 累加器复用压力求解用完的 deltaV 数组（零分配）
    const ax = this.pool.deltaVX;
    const ay = this.pool.deltaVY;
    const az = this.pool.deltaVZ;
    ax.fill(0, 0, high);
    ay.fill(0, 0, high);
    az.fill(0, 0, high);

    // 表面张力的"向内加速度"（米/秒²）。为什么不是直接乘 sigma：
    // sigma 是 0~0.16 的调参量，而加速度要对 dt 积分才有速度量纲。
    const tensionAccel = sigma * 30;

    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1 || frozen[i] === 1) continue;
      const xi = posX[i]!;
      const yi = posY[i]!;
      const zi = posZ[i]!;
      const vxi = velX[i]!;
      const vyi = velY[i]!;
      const vzi = velZ[i]!;
      const n = counts[i]!;
      const base = i * maxN;
      let accumX = 0;
      let accumY = 0;
      let accumZ = 0;
      for (let k = 0; k < n; k += 1) {
        const j = indices[base + k]!;
        const dx = posX[j]! - xi;
        const dy = posY[j]! - yi;
        const dz = posZ[j]! - zi;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= h2 || r2 < 1e-12) continue;
        const r = Math.sqrt(r2);
        const w = this.wPoly6(r, h2);
        // m/ρ 因子：密度还没被下面的循环改（density 是这一步的输入），所以可以直接用
        const rhoJ = density[j]! > 1e-6 ? density[j]! : this.settings.restDensity;
        const weight = (m / rhoJ) * w;
        if (c > 0) {
          // 黏性系数在这里乘掉，最后一步就不再统一缩放 ——
          // 否则"只开表面张力、关掉黏性"时张力会被一起乘成 0（这是我踩过的坑）
          accumX += (velX[j]! - vxi) * weight * c;
          accumY += (velY[j]! - vyi) * weight * c;
          accumZ += (velZ[j]! - vzi) * weight * c;
        }
        if (tensionAccel > 0) {
          // 朝邻居方向的单位向量 × 加速度 × dt，直接写进同一个累加器
          const pull = (tensionAccel * dt) / r;
          accumX += dx * pull * weight;
          accumY += dy * pull * weight;
          accumZ += dz * pull * weight;
        }
      }
      ax[i] = accumX;
      ay[i] = accumY;
      az[i] = accumZ;
    }

    // 两个系数都在上面的循环里乘过了，这里只做累加
    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1 || frozen[i] === 1) continue;
      velX[i] = velX[i]! + ax[i]!;
      velY[i] = velY[i]! + ay[i]!;
      velZ[i] = velZ[i]! + az[i]!;
    }
  }

  private averageNeighbors(): number {
    const alive = this.pool.count;
    if (alive === 0) return 0;
    let sum = 0;
    const high = this.pool.highWater;
    for (let i = 0; i < high; i += 1) if (this.pool.alive[i] === 1) sum += this.neighborCounts[i]!;
    return sum / alive;
  }

  private densityError(): number {
    const rho0 = this.settings.restDensity;
    if (rho0 <= 0) return 0;
    let sum = 0;
    let count = 0;
    const high = this.pool.highWater;
    for (let i = 0; i < high; i += 1) {
      if (this.pool.alive[i] !== 1) continue;
      sum += Math.abs(this.pool.density[i]! / rho0 - 1);
      count += 1;
    }
    return count === 0 ? 0 : sum / count;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
