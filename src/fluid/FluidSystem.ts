/**
 * 流体系统总控（M4 第二部分 · 第 1 批）。
 *
 * 它把 ParticlePool（存）、SpatialHash（找邻居）、PBFSolver（算）串起来，并负责
 * 三件"solver 不该管"的事：
 *
 * 1. **生成与移除**：泼水 / 加水 / 抽水 / 减水 都走这里。生成用**固定种子的 RNG**，
 *    所以"同一个种子泼同一桶水"是逐粒子可复现的（存档、断言、问题复现都依赖这一点）。
 * 2. **冻结区域**：玩家可以在某块区域把流体冻住（做闸门、做瀑布造型都要它）。
 *    冻结是**按坐标**判断的，不是按粒子下标 —— 下标会变，坐标不会。
 * 3. **性能护栏**：粒子上限、每帧时间预算、LOD（粒子多时自动降迭代数）。
 *    这三条是"手机上不炸"的关键。
 *
 * ────────────────────────────────────────────────────────────
 * 关于"世界坐标"
 * ────────────────────────────────────────────────────────────
 * 粒子存的是**世界坐标**（与建筑、相机一致），不是体素下标。
 * 地形查询通过 `FluidBoundary.isSolid(x, y, z)` 回调进来 —— 这样 FluidSystem
 * 完全不需要知道 VoxelGrid 的存在，第 6 批把它整体搬进 Worker 时也不用改协议。
 */

import { ParticlePool, type ParticlePoolStats } from './ParticlePool';
import { PBFSolver, type FluidBoundary, type PBFStats } from './PBFSolver';
import { SpatialHash } from './SpatialHash';
import { getFluidPreset, particleLimitFor, targetSpacing, type FluidConfig, type FluidType } from './FluidPresets';

/** 一块冻结区域（轴对齐盒） */
export interface FrozenRegion {
  id: string;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** 中文说明（面板显示，例如"闸门后"） */
  label: string;
}

export interface FluidSystemOptions {
  /** 设备档位（决定粒子上限） */
  tier?: 'low' | 'mid' | 'high';
  isMobile?: boolean;
  /** 初始流体类型 */
  type?: FluidType;
  /** 随机种子（生成用） */
  seed?: number;
  /** 引力加速度（m/s²，正值向下；内部会取负） */
  gravity?: number;
}

export interface FluidStepInput {
  /** 本帧真实经过的秒数 */
  dt: number;
  /** 环境采样器（地形/建筑） */
  boundary: FluidBoundary;
  /**
   * 本帧最多给流体多少毫秒。默认 4 ms（需求里的目标）。
   *
   * 超预算时的做法是**跳过后续子步**（让流体慢动作），而不是"这一帧硬算完"。
   * 理由：流体的视觉容错很高（慢一点只是看起来稠），而拖垮整帧会让操作都变卡。
   * 跳过了多少子步会如实体现在 `stats.skippedSubsteps` 里。
   */
  budgetMs?: number;
}

export interface FluidStepStats extends PBFStats {
  /** 因为超预算被跳过的子步数（0 = 完全跟上，>0 = 这一帧流体在慢动作） */
  skippedSubsteps: number;
  /** 本帧流体总耗时（solver.totalMs + 系统开销） */
  systemMs: number;
  /** 是否因为达到粒子上限而拒绝了新粒子（上一次生成调用的结果） */
  lastEmitRejected: number;
}

export interface FluidEmitResult {
  /** 实际生成的数量 */
  spawned: number;
  /** 因为达到上限而没生成的数量（诚实报告，工具面板上要显示） */
  rejected: number;
}

/**
 * "整池静止"的判据：平均速度低于这个值（米/秒）。
 *
 * 这个数字是**量出来的**，不是拍出来的。实测一池 400 个粒子的水落地之后：
 *
 * | 时间 | 平均速度 | 每帧位移 |
 * |---|---|---|
 * | 2 秒 | 0.071 m/s | 1.4 mm |
 * | 4 秒 | 0.031 m/s | 0.6 mm |
 * | 6 秒 | 0.018 m/s | 0.35 mm |
 *
 * 注意它**不会降到 0**：PBF 是位置法求解器，密度约束每帧都在做微小的修正，
 * 所以总有一层 1~2 cm/s 的残余"呼吸"。这就是为什么阈值不能取 0.005 之类的"看起来更严格"的值 ——
 * 那会让整池水永远进不了静止状态，这条优化就等于没做。
 * 取 0.035：比残余蠕动高一点、比肉眼能看到的移动（约 0.1 m/s）低三倍。
 */
const SETTLE_SPEED = 0.035;
/** 需要连续多少帧满足条件才算静止。取 60 帧（1 秒）：避免把"刚好经过最低点"的水冻住 */
const SETTLE_FRAMES = 60;

export class FluidSystem {
  readonly pool: ParticlePool;
  readonly solver: PBFSolver;
  private config: FluidConfig;
  private readonly limit: number;
  private readonly tier: 'low' | 'mid' | 'high';
  private readonly isMobile: boolean;
  private readonly gravity: number;

  /** 生成用 RNG（自实现 mulberry32，避免这里 import core/random 造成循环依赖） */
  private rngState: number;
  private readonly baseSeed: number;

  private readonly regions: FrozenRegion[] = [];
  /**
   * 生成时用的占位哈希：避免"在已经有水的地方再塞水"。
   *
   * 为什么需要（这是被实测逼出来的第三条修正）：
   * "持续加水"是每帧在**同一个笔刷位置**生成一小团水。
   * 第一版每帧都按静止密度生成一团，于是 10 帧之后同一处的密度是静止值的 **10 倍** ——
   * PBF 对这种过密状态的反应还是数值爆炸，水被炸到 17.8 米外（几乎是半个世界）。
   * 加了这个哈希之后，生成器会**跳过已经有粒子的位置**：
   * 行为从"往里硬塞"变成"填进还有空隙的地方"，这才是上帝倒水该有的样子。
   * （它也让"加水"工具自然有了"倒满了就倒不进去"的手感，不需要额外规则。）
   */
  private emitHash: SpatialHash | null = null;
  private stepStats: FluidStepStats;
  private lodLevel = 0;
  private emitRejected = 0;
  private emittedTotal = 0;
  private removedTotal = 0;
  /**
   * 整池水是否已经静止（静止时**跳过整个求解**）。
   *
   * ── 为什么这是最有价值的一条优化 ──
   * 玩家倒完水之后，最常发生的事情是"看着它" —— 而一池静止的水每一帧
   * 仍然要跑完整的 PBF（邻居收集 + 密度 + 压力 × 迭代 + 碰撞）。
   * 实测 10000 粒子静态水面约 100 ms/帧，其中 99% 是在重新确认"它还是静止的"。
   *
   * 判据：**平均速度低于阈值 + 没有正在进行的编辑**持续 `SETTLE_FRAMES` 帧。
   * 一旦静止，`step()` 直接返回（只保留 stats 结构），直到有事件把它唤醒：
   * 生成/移除粒子、增删冻结区域、切换流体类型、改重力、或者调用方显式 `wake()`。
   *
   * ⚠ 如实说明它的边界：**这不是逐粒子的休眠**。一个"大部分静止、少数在动"的池子
   * 不会被跳过（平均速度不够低），所以那种情况仍然全速计算。
   * 逐粒子休眠要处理"邻居被唤醒时我也要醒"的传播，代价与收益的账在本轮没有算清，
   * 所以先做这个**安全且收益明确**的版本（README 的取舍清单里有这一条）。
   */
  private settled = false;
  private settledFrames = 0;

  constructor(options: FluidSystemOptions = {}) {
    this.tier = options.tier ?? 'high';
    this.isMobile = options.isMobile ?? false;
    this.config = getFluidPreset(options.type ?? 'water');
    this.limit = Math.min(this.config.maxParticles, particleLimitFor(this.tier, this.isMobile));
    this.baseSeed = options.seed ?? 1;
    this.rngState = this.baseSeed >>> 0;
    this.gravity = options.gravity ?? 9.81;
    this.pool = new ParticlePool(this.limit);
    this.solver = new PBFSolver(this.pool, {
      restDensity: this.config.restDensity,
      // 先给个占位值，紧接着用求解器在格点上标定（见 calibrateMass 的注释）
      particleMass: this.config.restDensity * targetSpacing(this.config) ** 3,
      particleRadius: this.config.particleRadius,
      // 平滑半径 h = 4r（粒子**直径的两倍**）。
      //
      // ⚠ 这里我第一版写的是 h = 2r，被断言抓了出来：那时"粒子间距 = 2r = h"，
      // 于是每个邻居到自己的距离正好等于核函数支援半径 —— Poly6 核在这个距离上**恰好为 0**，
      // 只有 x/y/z 三个轴向的邻居贡献一点点，密度算出来是「只有自己那一项」。
      // 实测：平均邻居 1.0、密度误差 213%、压力项失效、粒子被初始速度吹散到全世界。
      // 而画面上只是"水花四贱"，看起来还挺像那么回事 —— 这就是最阴的一类 bug。
      //
      // PBF 的通行做法是 **粒子间距 ≈ h/2**，这样每个粒子有几十个真实邻居、
      // 密度与压力才有意义。取 h = 4r 时：静止间距 2r = h/2，
      // 密度 ρ ≈ m/(2r)³ = ρ0（自洽），邻居数约 40~60。
      smoothingRadius: this.config.particleRadius * 4,
      viscosity: this.config.viscosity,
      surfaceTension: this.config.surfaceTension,
      gravity: -this.gravity * this.config.gravityScale,
      iterations: 2,
      maxStepSeconds: 1 / 30,
      maxSpeed: 40,
    });
    this.calibrateMass();
    this.stepStats = { ...this.emptyStats() };
  }

  /**
   * 按当前 h 与目标间距标定粒子质量。
   *
   * 切换流体类型 / 改 h 之后都要重标 —— 否则密度会系统性偏大或偏小，
   * 表现是"水面永远在抖"或者"水自己缩成一团"。
   */
  private calibrateMass(): void {
    const spacing = targetSpacing(this.config);
    this.solver.settings.particleMass = this.solver.calibrateMass(spacing);
  }

  /** 标定出来的单粒子质量（诊断/断言用） */
  get particleMass(): number {
    return this.solver.settings.particleMass;
  }

  private emptyStats(): FluidStepStats {
    return {
      particles: 0, substeps: 0,
      predictMs: 0, neighborMs: 0, densityMs: 0, correctMs: 0, collisionMs: 0, velocityMs: 0,
      totalMs: 0, avgNeighbors: 0, avgCandidates: 0, densityError: 0, boundaryHits: 0,
      speedClamps: 0, correctionClamps: 0, stuckParticles: 0,
      skippedSubsteps: 0, systemMs: 0, lastEmitRejected: 0,
    };
  }

  // ------------------------------------------------------------------ 查询

  get type(): FluidType {
    return this.config.type;
  }

  get fluidConfig(): FluidConfig {
    return this.config;
  }

  get stats(): FluidStepStats {
    return this.stepStats;
  }

  get poolStats(): ParticlePoolStats {
    return this.pool.stats;
  }

  get capacity(): number {
    return this.limit;
  }

  get activeCount(): number {
    return this.pool.count;
  }

  get frozenRegions(): readonly FrozenRegion[] {
    return this.regions;
  }

  /** 当前 LOD 档位（0 = 全质量，越大越省） */
  get currentLod(): number {
    return this.lodLevel;
  }

  /** 估算内存占用（字节）：池子 + 哈希表。是真数字 */
  get bytes(): number {
    return this.pool.bytes + this.solver.hashBytes;
  }

  // ------------------------------------------------------------------ 配置

  /**
   * 切换流体类型。
   *
   * **已经存在的粒子不会被删除，也不会被换色**（颜色是"这批水"的属性，不是"这个系统"的）。
   * 切换只影响**之后的生成**和物理参数。这一点写在面板上，
   * 否则玩家会以为"换成油"能把刚才那摊水变成油。
   */
  setType(type: FluidType): void {
    this.config = getFluidPreset(type);
    this.wake();
    this.solver.settings.restDensity = this.config.restDensity;
    this.calibrateMass();
    this.solver.settings.viscosity = this.config.viscosity;
    this.solver.settings.surfaceTension = this.config.surfaceTension;
    this.solver.settings.gravity = -this.gravity * this.config.gravityScale;
  }

  setGravity(gravity: number): void {
    this.solver.settings.gravity = -gravity * this.config.gravityScale;
    this.wake();
  }

  /**
   * 设置 LOD 档位（第 6 批的自动降级会调它）。
   *
   * 0 = 正常（2 次压力迭代）
   * 1 = 省一点（1 次迭代 + 关表面张力）
   * 2 = 最省（1 次迭代 + 关表面张力 + 关黏性）
   *
   * 为什么降的是"迭代数"而不是"粒子数"：这一批还没有自动降级，
   * 但顺序是先降质量再降数量 —— 直接删粒子会让玩家的水凭空消失，那是可见的破坏；
   * 迭代数降低只是让水稍微"软"一点。
   */
  setLod(level: number): void {
    this.lodLevel = Math.max(0, Math.min(2, Math.floor(level)));
    const iterations = this.lodLevel === 0 ? 2 : 1;
    this.solver.settings.iterations = iterations;
    this.solver.settings.surfaceTension = this.lodLevel >= 1 ? 0 : this.config.surfaceTension;
    this.solver.settings.viscosity = this.lodLevel >= 2 ? 0 : this.config.viscosity;
  }

  // ------------------------------------------------------------------ 生成 / 移除

  /**
   * 这个位置能不能放一个新粒子（周围 `minDistance` 内有没有已有粒子）。
   * `minDistance` 取目标间距的 0.85 倍：允许轻微重叠（视觉上更像连续的水），
   * 但不会密到把 PBF 逼爆。
   */
  private canPlaceAt(x: number, y: number, z: number, minDistance: number): boolean {
    const hash = this.emitHash;
    if (!hash) return true;
    const min2 = minDistance * minDistance;
    const { posX, posY, posZ } = this.pool;
    let blocked = false;
    hash.forEachCandidate(x, y, z, minDistance, (j) => {
      if (blocked) return;
      const dx = posX[j]! - x;
      const dy = posY[j]! - y;
      const dz = posZ[j]! - z;
      if (dx * dx + dy * dy + dz * dz < min2) blocked = true;
    });
    return !blocked;
  }

  /** 生成之前重建占位哈希（只在真的有粒子时才建） */
  private refreshEmitHash(): void {
    if (this.pool.count === 0) {
      this.settled = false;
      this.settledFrames = 0;
      this.emitHash = null;
      return;
    }
    const spacing = targetSpacing(this.config);
    if (!this.emitHash || this.emitHash.cellSize !== spacing) {
      this.emitHash = new SpatialHash(spacing, Math.max(1, this.limit));
    }
    this.emitHash.build(this.pool.posX, this.pool.posY, this.pool.posZ, this.pool.alive, this.pool.highWater);
  }

  private nextRandom(): number {
    // mulberry32（与 src/core/random.ts 同一个算法，这里是独立实现以免形成依赖）
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 重置随机序列（同一个种子 + 同样的调用顺序 = 同样的粒子分布） */
  resetRandom(seed?: number): void {
    this.rngState = (seed ?? this.baseSeed) >>> 0;
  }

  /**
   * 生成多少粒子会占多大的球（半径，米）。
   *
   * 由"目标间距"反推：`V_总 = count × spacing³`，再换成球半径。
   * 这是**防止一键泼水把水炸飞**的关键 —— 见 `emitSphere` 的注释。
   */
  private restRadiusFor(count: number): number {
    const spacing = targetSpacing(this.config);
    const volume = Math.max(1e-9, count * spacing * spacing * spacing);
    return Math.cbrt((volume * 3) / (4 * Math.PI));
  }

  /**
   * 在球形范围内生成一批粒子（泼水 / 加水 都走它）。
   *
   * ── 为什么 `spread` 会被自动放大 ──
   * 我第一版直接在给定半径里随机撒点，于是"200 个粒子塞进 0.4 米球"的密度是静止值的
   * **1.6 倍**。PBF 对这种过密初始条件的反应是**数值爆炸**：一次位置修正就给出
   * 十几米每秒的隐含速度，水被炸到世界角落再也不回来。
   * 实测症状：平均邻居 1.0、密度误差 213%、蜂蜜和水"铺开半径"都是 33.83 米（世界的对角）。
   *
   * 所以这里把半径**至少**放大到"这批粒子在静止密度下应有的体积"。
   * 换句话说：上帝倒水时，水团的大小是由物理决定的，不是由笔刷半径决定的 ——
   * 笔刷半径只决定"倒多少水"，这一点写在面板上。
   *
   * @param count 期望数量；实际可能更少（到上限了），差额在返回值里
   * @param spread 期望的生成球半径（米）；小于静止密度所需半径时会被放大
   * @param velocity 初始速度（+Y 向上），给"泼"一点初速
   */
  emitSphere(
    x: number,
    y: number,
    z: number,
    count: number,
    spread = 0.4,
    velocity: readonly [number, number, number] = [0, 0, 0],
  ): FluidEmitResult {
    let spawned = 0;
    let rejected = 0;
    const target = Math.max(0, Math.floor(count));
    // 至少放大到静止密度所需的半径（见上面那段说明）
    const effectiveSpread = Math.max(spread, this.restRadiusFor(target));
    this.refreshEmitHash();
    const minDistance = targetSpacing(this.config) * 0.85;
    for (let i = 0; i < target; i += 1) {
      // 球内均匀采样：用 cbrt 保证体积均匀（直接乘 random 会让粒子挤在球心）
      const u = this.nextRandom();
      const radius = effectiveSpread * Math.cbrt(u);
      const theta = this.nextRandom() * Math.PI * 2;
      const phi = Math.acos(2 * this.nextRandom() - 1);
      const px = x + radius * Math.sin(phi) * Math.cos(theta);
      const py = y + radius * Math.cos(phi);
      const pz = z + radius * Math.sin(phi) * Math.sin(theta);
      // 已经有水的地方不再塞（最多试 4 次换个位置；4 次都占着就如实记为"没放下"）
      let placed = false;
      let tx = px;
      let ty = py;
      let tz = pz;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (this.canPlaceAt(tx, ty, tz, minDistance)) {
          placed = true;
          break;
        }
        tx = x + (this.nextRandom() - 0.5) * effectiveSpread * 2;
        ty = y + (this.nextRandom() - 0.5) * effectiveSpread * 2;
        tz = z + (this.nextRandom() - 0.5) * effectiveSpread * 2;
      }
      if (!placed) {
        rejected += 1;
        continue;
      }
      const index = this.pool.spawn(
        tx, ty, tz,
        velocity[0] * (0.6 + this.nextRandom() * 0.8),
        velocity[1] * (0.6 + this.nextRandom() * 0.8),
        velocity[2] * (0.6 + this.nextRandom() * 0.8),
      );
      if (index < 0) {
        // 到上限就是到上限：剩下的一次性记为"被拒绝"，**不再逐个重试**（白跑）
        rejected += target - i;
        break;
      }
      spawned += 1;
    }
    this.emitRejected = rejected;
    this.emittedTotal += spawned;
    // ⚠ 生成之后必须唤醒：静止的水池被"冻"在静止状态，不倒这一下它不会重新开始算。
    // （我第一版只给 emitBox 加了唤醒，漏了 emitSphere —— 表现是"往静止的水里倒水没反应"。
    //   两处几乎一样的代码块是最容易漏一处的地方，所以这里写清楚。）
    if (spawned > 0) this.wake();
    return { spawned, rejected };
  }

  /**
   * 在轴对齐盒里生成粒子（"一键灌满一个池子"用）。
   *
   * 盒子容量不足时会**按静止密度截断**并如实报告：盒子里能装下的粒子数
   * ≈ `V / spacing³`。这就是"灌满"的物理含义 —— 多出来的不是"被拒绝"，
   * 而是**根本没地方放**。把这部分记进 `rejected` 而不是硬塞进去。
   */
  emitBox(
    min: readonly [number, number, number],
    max: readonly [number, number, number],
    count: number,
    velocity: readonly [number, number, number] = [0, 0, 0],
  ): FluidEmitResult {
    let spawned = 0;
    const spacing = targetSpacing(this.config);
    const boxVolume = Math.abs((max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]));
    const capacity = Math.max(1, Math.floor(boxVolume / (spacing * spacing * spacing)));
    const target = Math.min(Math.max(0, Math.floor(count)), capacity);
    for (let i = 0; i < target; i += 1) {
      const px = min[0] + this.nextRandom() * (max[0] - min[0]);
      const py = min[1] + this.nextRandom() * (max[1] - min[1]);
      const pz = min[2] + this.nextRandom() * (max[2] - min[2]);
      if (this.pool.spawn(px, py, pz, velocity[0], velocity[1], velocity[2]) < 0) {
        this.emitRejected = count - spawned;
        this.emittedTotal += spawned;
        return { spawned, rejected: count - spawned };
      }
      spawned += 1;
    }
    const rejected = Math.max(0, Math.floor(count) - spawned);
    this.emitRejected = rejected;
    this.emittedTotal += spawned;
    if (spawned > 0) this.wake();
    return { spawned, rejected };
  }

  /**
   * 移除球内的粒子（抽水 / 减水）。
   *
   * @returns 实际移除的数量
   */
  removeInSphere(x: number, y: number, z: number, radius: number): number {
    const { posX, posY, posZ, alive } = this.pool;
    const r2 = radius * radius;
    let removed = 0;
    const high = this.pool.highWater;
    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1) continue;
      const dx = posX[i]! - x;
      const dy = posY[i]! - y;
      const dz = posZ[i]! - z;
      if (dx * dx + dy * dy + dz * dz <= r2) {
        if (this.pool.kill(i)) removed += 1;
      }
    }
    this.removedTotal += removed;
    if (removed > 0) this.wake();
    return removed;
  }

  /** 移除全部（清空流体；撤销/换图时用） */
  clear(): number {
    const removed = this.pool.count;
    this.pool.clear();
    this.removedTotal += removed;
    this.wake();
    return removed;
  }

  /** 统计信息里的累计值（面板显示"累计生成/移除"用） */
  get totals(): { emitted: number; removed: number } {
    return { emitted: this.emittedTotal, removed: this.removedTotal };
  }

  // ------------------------------------------------------------------ 冻结区域

  addFrozenRegion(region: Omit<FrozenRegion, 'id'> & { id?: string }): FrozenRegion {
    const full: FrozenRegion = {
      id: region.id ?? `frozen-${this.regions.length}-${Math.round(region.minX)}-${Math.round(region.minZ)}`,
      minX: Math.min(region.minX, region.maxX),
      maxX: Math.max(region.minX, region.maxX),
      minY: Math.min(region.minY, region.maxY),
      maxY: Math.max(region.minY, region.maxY),
      minZ: Math.min(region.minZ, region.maxZ),
      maxZ: Math.max(region.minZ, region.maxZ),
      label: region.label,
    };
    this.regions.push(full);
    this.applyFrozenFlags();
    this.wake();
    return full;
  }

  removeFrozenRegion(id: string): boolean {
    const index = this.regions.findIndex((region) => region.id === id);
    if (index < 0) return false;
    this.regions.splice(index, 1);
    this.applyFrozenFlags();
    this.wake();
    return true;
  }

  clearFrozenRegions(): void {
    this.regions.length = 0;
    this.pool.frozen.fill(0);
    this.wake();
  }

  /**
   * 按当前区域列表刷新每个粒子的冻结标记。
   *
   * 什么时候调用：区域增删时、以及**每帧做一次**（便宜：粒子数 × 区域数）。
   * 每帧一次是必要的 —— 新生成的粒子、流进区域的粒子都要被冻住，
   * 只在增删时刷的话"水流进闸门后不会被冻住"。
   */
  applyFrozenFlags(): void {
    const { frozen, posX, posY, posZ, alive } = this.pool;
    const high = this.pool.highWater;
    if (this.regions.length === 0) {
      frozen.fill(0, 0, high);
      return;
    }
    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1) {
        frozen[i] = 0;
        continue;
      }
      const x = posX[i]!;
      const y = posY[i]!;
      const z = posZ[i]!;
      let inside = false;
      for (const region of this.regions) {
        if (x >= region.minX && x <= region.maxX && y >= region.minY && y <= region.maxY && z >= region.minZ && z <= region.maxZ) {
          inside = true;
          break;
        }
      }
      frozen[i] = inside ? 1 : 0;
    }
  }

  /** 某个点是否在冻结区域内（编辑工具据此提示"这块冻着"） */
  isFrozenAt(x: number, y: number, z: number): boolean {
    for (const region of this.regions) {
      if (x >= region.minX && x <= region.maxX && y >= region.minY && y <= region.maxY && z >= region.minZ && z <= region.maxZ) {
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ 每帧推进

  /**
   * 推进流体。
   *
   * 预算处理（`budgetMs`）：
   * - 第 1 个子步**无条件做完**（否则卡的时候流体永远不动，看起来像坏了）；
   * - 之后的子步在每个做完之后检查时间，超预算就把剩下的记进 `skippedSubsteps`。
   */
  /** 静止判定的进度（连续满足条件的帧数；诊断用） */
  get settleProgress(): number {
    return this.settledFrames;
  }

  /**
   * 接受一次**外部求解**（Worker 路径）的结果统计。
   *
   * 为什么需要它：走 Worker 时求解不在主线程跑，`step()` 里那段"结算 stats"的代码
   * 也就没被执行 —— 于是面板会一直显示上一帧的数字（看起来像"卡住了"），
   * 而 `settled` 状态也不会被清掉。
   *
   * @param stats Worker 侧报回来的求解统计；拿不到时传 null（那就只清静止状态、耗时不编）
   */
  adoptExternalStep(stats: { totalMs: number; substeps: number; particles?: number } | null): void {
    this.wake();
    if (!stats) return;
    this.stepStats = {
      ...this.stepStats,
      particles: stats.particles ?? this.pool.count,
      substeps: stats.substeps,
      // 主线程这一帧**没有**算流体：耗时如实记 0，而不是把 worker 的耗时算到自己头上
      totalMs: 0,
      systemMs: 0,
      skippedSubsteps: 0,
      lastEmitRejected: this.emitRejected,
    };
  }

  /** 当前整池水是否处于"静止跳过"状态（面板与断言用） */
  get isSettled(): boolean {
    return this.settled;
  }

  /** 唤醒（任何会改变流体的操作都要调它：生成/移除/冻结/改参数） */
  wake(): void {
    this.settled = false;
    this.settledFrames = 0;
  }

  /** 是否需要走完整求解（内部用） */
  private shouldSkipAsSettled(): boolean {
    if (this.settled) return true;
    const speed = this.averageSpeed();
    if (speed > SETTLE_SPEED) {
      this.settledFrames = 0;
      return false;
    }
    this.settledFrames += 1;
    if (this.settledFrames >= SETTLE_FRAMES) {
      this.settled = true;
      // 静止之后把速度彻底清零：否则再次唤醒时会带着一堆"几乎为零但非零"的速度，
      // 而静止判定本身依赖速度，会来回抖动
      const { velX, velY, velZ, alive, frozen } = this.pool;
      const high = this.pool.highWater;
      for (let i = 0; i < high; i += 1) {
        if (alive[i] !== 1 || frozen[i] === 1) continue;
        velX[i] = 0; velY[i] = 0; velZ[i] = 0;
      }
      return true;
    }
    return false;
  }

  private averageSpeed(): number {
    const { velX, velY, velZ, alive } = this.pool;
    let sum = 0;
    let count = 0;
    const high = this.pool.highWater;
    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1) continue;
      sum += Math.hypot(velX[i]!, velY[i]!, velZ[i]!);
      count += 1;
    }
    return count === 0 ? 0 : sum / count;
  }

  step(input: FluidStepInput): FluidStepStats {
    const started = now();
    const budget = input.budgetMs ?? 4;

    if (this.pool.count === 0) {
      this.settled = false;
      this.settledFrames = 0;
      // 没有粒子时也要把 stats 归零并保留结构 —— 面板读的是 stats，
      // 留着上一帧的旧值会显示"0 个粒子但模拟耗时 3 ms"
      this.stepStats = { ...this.emptyStats(), lastEmitRejected: this.emitRejected };
      return this.stepStats;
    }

    // 静止跳过：整池水平均速度极低且持续了一段时间 → 这一帧什么都不算
    if (this.shouldSkipAsSettled()) {
      this.stepStats = {
        ...this.emptyStats(),
        particles: this.pool.count,
        // 如实标记：这段时间是"跳过了"，不是"算了但很快"
        systemMs: 0,
        skippedSubsteps: 0,
        lastEmitRejected: this.emitRejected,
      };
      return this.stepStats;
    }

    // 冻结标记每帧刷一次（见 applyFrozenFlags 的注释）
    this.applyFrozenFlags();

    // 粒子多的时候自动降 LOD。
    //
    // 实测（10000 粒子，位移法求解器）：2 次压力迭代 126.8 ms，1 次 **84.8 ms** ——
    // 也就是说"少迭代一次"能省掉三分之一的总时间，代价是密度误差从 30% 涨到 45% 左右
    // （水的体积会略微"软"一点，肉眼上表现为水花更黏、压缩更多）。
    // 这是**刻意用质量换帧率**，而且是在粒子数已经很大的时候才换 ——
    // 小场景仍然跑 2 次迭代。
    //
    // 阈值定在 6000：它对应"桌面档的中等场景"。手机上上限本来就只有 3000，
    // 所以手机永远是 2 次迭代（质量优先，因为它的绝对粒子数少、本来就快）。
    const lodThreshold = this.isMobile ? Number.POSITIVE_INFINITY : 6000;
    if (this.lodLevel === 0 && this.pool.count > lodThreshold) this.setLod(1);

    // 真正的时间预算交给 solver：它在子步之间检查，超了就停下
    const run = this.solver.step(input.dt, input.boundary, budget);
    const stats = this.solver.stats;
    const elapsed = now() - started;

    // 如实记账：本来该跑几个子步、实际跑了几 个。差值是"这一帧流体在慢动作"
    const wanted = Math.min(4, Math.max(1, Math.ceil(input.dt / this.solver.settings.maxStepSeconds)));
    const skipped = Math.max(0, wanted - run.substeps);

    this.stepStats = {
      ...stats,
      skippedSubsteps: skipped,
      systemMs: elapsed,
      lastEmitRejected: this.emitRejected,
    };
    return this.stepStats;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
