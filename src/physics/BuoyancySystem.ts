/**
 * 浮力系统（M3 第 5 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么水**不**做成 Rapier 的碰撞体
 * ────────────────────────────────────────────────────────────
 * 本项目的水是一套独立的元胞自动机（按格存 0~1 的水量，逐帧向低处流）。
 * 如果给水也建碰撞体，物体掉进水里会像撞到凝胶一样停住 —— 那不是水，是果冻。
 * 所以水的做法是：**不参与碰撞求解，只对物体施力**。这也正是"简化但一致"的取舍写在这里的原因。
 *
 * ────────────────────────────────────────────────────────────
 * 浮力怎么算（以及它有多粗）
 * ────────────────────────────────────────────────────────────
 * 教科书式：`F = ρ·g·V_排水`。本项目用**物体 AABB 与水面的相交体积**当排水体积：
 *
 * ```
 *  水面高度 yw
 *      │
 *      ├───────────┐  ← 物体顶
 *      │  露出部分  │
 * ~~~~~├───────────┤~~~~ 水面
 *      │  浸没部分  │  ← 这段的体积就是 V_排水
 *      └───────────┘  ← 物体底
 * ```
 *
 * **它不是真实船体力学**，具体差在三处，都得说清楚：
 * 1. **AABB 近似**：一艘中间挖空的船，AABB 排水量远大于真实船体 —— 所以本项目的"船"
 *    能浮起来靠的是"我们按盒子算"，不是"我们模拟了船体"。空心和实心的差别只体现在
 *    **材质密度**上（木头 650 < 水 1000 → 浮；石头 2600 > 水 → 沉），这与直觉一致。
 * 2. **不做姿态力矩**：真实浮力作用在浮心上，会让倾斜的船自己扶正。这里只在**质心**施加向上合力，
 *    所以一条侧翻的木头不会自己翻回来（这也是 M3 不做"船会摇晃"的原因）。
 * 3. **阻力是线性的**：真实流体阻力近似 ∝ v²，这里用 `-k·v`（和 Rapier 的阻尼同一形式）。
 *    好处是数值稳定（不会因为一个大 dt 就炸），代价是"快速入水"没有真实的减速感。
 *
 * 水面高度只按 **2×2 个采样点**估（默认），因为逐格扫 AABB 是很贵的：
 * 一个 4×4×4 的物体在 1 格精度下要读 64 次水量。采样精度可以调（`sampleResolution`），
 * 但那会线性增加每帧开销 —— 面板上写的浮力耗时就是这一步的成本。
 */

/** 物体在水中需要的形状信息 */
export interface BuoyantBody {
  /** 刚体 handle */
  handle: number;
  /** 归属的物体 id（面板显示用） */
  ownerId: number;
  /** 世界坐标下的 AABB（中心 + 半尺寸） */
  center: { x: number; y: number; z: number };
  half: { x: number; y: number; z: number };
  /** 质量（kg）—— 决定它到底浮还是沉 */
  mass: number;
  /** 当前线速度（算阻力用） */
  velocity: { x: number; y: number; z: number };
}

export interface BuoyancyOptions {
  /** 水密度 kg/m³（默认 1000，淡水） */
  waterDensity?: number;
  /** 重力加速度（正数，m/s²），用来和密度一起算浮力 */
  gravity?: number;
  /** 线性阻力系数（每秒衰减比例），默认 2.2 —— 让东西在水里明显变"黏" */
  dragCoefficient?: number;
  /**
   * 水流推力系数。水在流动时会把物体往下游推。
   * 本项目没有真实流速场，用"相邻格水位差"当作流向与强度（见 `currentAt`）。
   */
  currentStrength?: number;
  /** 水面附近的额外阻尼（破水面时的阻力），默认 3.0 */
  surfaceDrag?: number;
  /** AABB 的 XZ 采样分辨率（1 = 只取中心，2 = 2×2），默认 2 */
  sampleResolution?: number;
  /**
   * 浮力上限倍率：当排水体积算出来离谱时（例如物体卡在瀑布里被反复计数）
   * 限制浮力不超过"重量 × 这个倍率"。默认 6 —— 够把东西顶出水面，又不至于变成弹射器。
   */
  maxForceScale?: number;
}

export interface BuoyancyReport {
  /** 施加了浮力的物体数（浸没比例 > 0） */
  submerged: number;
  /** 完全没入水下的数量 */
  fullySubmerged: number;
  /** 在水面附近（部分浸没）的数量 */
  atSurface: number;
  /** 密度大于水、最终会沉下去的数量 */
  sinking: number;
  /** 本帧浮力总和（N），面板显示用 */
  totalForce: number;
  /** 本帧的水流推力总和（N） */
  totalCurrent: number;
  /** 水里有几个物体 */
  inWater: number;
  ms: number;
}

/**
 * 一个物体受到的力（由 Engine 施加到刚体上）。
 *
 * ⚠ `force` **不包含重力** —— 重力由 Rapier 自己施加（刚体有 mass，世界有 gravity）。
 * 所以"石头会沉"不是靠这里的力为负，而是靠"浮力 < 重力"：
 * 判断这件事用 `sinking` 字段（它比的就是 `ρ物体 > ρ水`），
 * 直接看 `force.y` 的正负会得出错误的结论。
 */
export interface BuoyancyForce {
  handle: number;
  ownerId: number;
  /** 浮力（向上）+ 阻力（反向于速度）+ 水流推力（横向），单位 N；不含重力 */
  force: { x: number; y: number; z: number };
  /** 浸没体积（m³） */
  displacedVolume: number;
  /** 浸没比例 0~1 */
  ratio: number;
  /** 是不是"注定要沉"（密度大于水） */
  sinking: boolean;
}

/** 供面板/教学显示的水体查询结果 */
export interface SubmersionInfo {
  /** 浸没体积（m³） */
  displaced: number;
  /** 浸没比例 0~1 */
  ratio: number;
  /** 水面高度（世界坐标 Y）；不在水里为 null */
  surfaceY: number | null;
  /** 水深（物体底到水面的距离） */
  depth: number;
}

const DEFAULTS: Required<BuoyancyOptions> = {
  waterDensity: 1000,
  gravity: 9.81,
  dragCoefficient: 2.2,
  currentStrength: 0.35,
  surfaceDrag: 3,
  sampleResolution: 2,
  maxForceScale: 6,
};

/** 水系统需要向浮力系统暴露的最小接口（方便测试注入假水体） */
export interface WaterField {
  /**
   * 某个**世界坐标**处的水量（0~1）。
   * 返回 0 表示这里没有水。
   */
  waterAt(worldX: number, worldY: number, worldZ: number): number;
}

export class BuoyancySystem {
  private readonly options: Required<BuoyancyOptions>;
  private lastReport: BuoyancyReport = {
    submerged: 0,
    fullySubmerged: 0,
    atSurface: 0,
    sinking: 0,
    totalForce: 0,
    totalCurrent: 0,
    inWater: 0,
    ms: 0,
  };
  private enabledValue = true;

  constructor(
    private readonly field: WaterField,
    options: BuoyancyOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
  }

  get report(): BuoyancyReport {
    return this.lastReport;
  }

  get optionsReadonly(): Required<BuoyancyOptions> {
    return { ...this.options };
  }

  /**
   * 算一个物体的浸没情况。
   *
   * ────────────────────────────────────────────────────────────
   * 算法：**沿高度积分**，而不是"找水面再相减"
   * ────────────────────────────────────────────────────────────
   * 第一版实现是"从物体顶往下找第一个有水的高度，当作水面"，那样有两个坑：
   * 1. **量化误差**：采样步长决定误差上限，一个 1 米高的物体用 3 个采样点时，
   *    完全没入的木头会算出 0.83 m³ 而不是 1.00 m³，于是"浮力略微小于重力"，
   *    本该浮起来的木头会缓慢下沉 —— 这种"差一点点"的 bug 最难发现；
   * 2. **水面被物体自己挡住**：完全没入的物体顶上也有水，"水面"其实在它上方，
   *    用"物体内部找水面"的逻辑根本找不到。
   *
   * 现在改成：沿物体高度逐层采样，每层取 XZ 各采样点里**最大**的水量当淹没比例，
   * 再按层高累加成浸没高度。完全没入 → 每层都是 1 → 浸没高度 = 全高（精确）；
   * 半没 → 下半 1、上半 0 → 浸没高度 ≈ 半高。**没有量化误差**。
   */
  submersionOf(body: BuoyantBody): SubmersionInfo {
    const resolution = Math.max(1, Math.min(4, Math.round(this.options.sampleResolution)));
    const height = body.half.y * 2;
    const bottom = body.center.y - body.half.y;
    if (height <= 0) return { displaced: 0, ratio: 0, surfaceY: null, depth: 0 };

    // 每米 2 层，至少 2 层、最多 16 层：更细的采样对结果影响很小，但开销线性增长
    const layers = Math.max(2, Math.min(16, Math.ceil(height * 2)));
    const layerHeight = height / layers;

    let submergedHeight = 0;
    let anyWater = false;
    for (let layer = 0; layer < layers; layer += 1) {
      const y = bottom + (layer + 0.5) * layerHeight;
      let layerWater = 0;
      for (let ix = 0; ix < resolution; ix += 1) {
        for (let iz = 0; iz < resolution; iz += 1) {
          const tx = resolution === 1 ? 0.5 : (ix + 0.5) / resolution;
          const tz = resolution === 1 ? 0.5 : (iz + 0.5) / resolution;
          const x = body.center.x + (tx * 2 - 1) * body.half.x;
          const z = body.center.z + (tz * 2 - 1) * body.half.z;
          const amount = this.field.waterAt(x, y, z);
          if (amount <= 0.01) continue;
          anyWater = true;
          // 取最大而不是平均：物体压在水里时，只要有一部分进水，那一层就是浸没的
          if (amount > layerWater) layerWater = Math.min(1, amount);
        }
      }
      submergedHeight += layerHeight * layerWater;
    }

    if (!anyWater || submergedHeight <= 0) {
      return { displaced: 0, ratio: 0, surfaceY: null, depth: 0 };
    }

    const fullVolume = body.half.x * 2 * height * (body.half.z * 2);
    const displaced = body.half.x * 2 * submergedHeight * (body.half.z * 2);
    return {
      displaced: Math.max(0, displaced),
      ratio: fullVolume > 0 ? Math.min(1, displaced / fullVolume) : 0,
      // 水面高度是**由浸没高度反推的估计值**（我们并不知道真实水面在哪，
      // 只知道"淹了多深"）。取整段浸没的顶面当水面，对半没的物体是准的，
      // 对完全没入的物体会低估（真实水面在它上方）—— 这条写出来，免得被当成 bug。
      surfaceY: bottom + submergedHeight,
      depth: submergedHeight,
    };
  }

  /**
   * 本帧所有物体受到的力。
   *
   * 浮力只和**浸没体积**有关；上浮还是下沉由**物体质量**（也就是材质密度 × 体积）决定 ——
   * 这就是"木头浮、石头沉"的全部来源，没有别的魔法。
   */
  compute(bodies: readonly BuoyantBody[]): BuoyancyForce[] {
    if (!this.enabledValue) {
      this.lastReport = { ...this.lastReport, submerged: 0, inWater: 0, totalForce: 0, totalCurrent: 0 };
      return [];
    }

    const started = now();
    const forces: BuoyancyForce[] = [];
    let totalForce = 0;
    let totalCurrent = 0;
    let fullySubmerged = 0;
    let atSurface = 0;
    let sinking = 0;

    const { waterDensity, gravity, dragCoefficient, surfaceDrag, currentStrength, maxForceScale } = this.options;

    for (const body of bodies) {
      const info = this.submersionOf(body);
      if (info.displaced <= 0) continue;

      // 阿基米德：F = ρ·g·V
      let buoyancy = waterDensity * gravity * info.displaced;
      const weight = body.mass * gravity;
      // 上限：别让浅水里的物体被顶成弹射器
      const cap = Math.max(weight * maxForceScale, 50);
      if (buoyancy > cap) buoyancy = cap;

      // 阻力：-k·v·（浸没比例）。完全出水时浸没比例为 0，阻力也归零
      const drag = dragCoefficient * info.ratio;
      const surfaceFactor = info.ratio > 0.01 && info.ratio < 0.99 ? surfaceDrag : 0;
      let forceX = -body.velocity.x * drag;
      let forceY = buoyancy - body.velocity.y * (drag + surfaceFactor);
      let forceZ = -body.velocity.z * drag;

      // 水流推力：用相邻格水位差估流向
      const current = this.currentAt(body);
      if (current.strength > 0.001) {
        const scale = currentStrength * info.ratio * body.mass * 0.6;
        forceX += current.x * current.strength * scale;
        forceZ += current.z * current.strength * scale;
        totalCurrent += Math.hypot(current.x, current.z) * current.strength * scale;
      }

      if (info.ratio >= 0.99) fullySubmerged += 1;
      else atSurface += 1;
      // 密度大于水 → 最终会沉；这也是"重物会沉"的判据
      const willSink = body.mass > waterDensity * info.displaced + 1e-6 && info.ratio >= 0.99;
      if (willSink) sinking += 1;

      totalForce += buoyancy;
      forces.push({
        handle: body.handle,
        ownerId: body.ownerId,
        force: { x: forceX, y: forceY, z: forceZ },
        displacedVolume: info.displaced,
        ratio: info.ratio,
        sinking: willSink,
      });
    }

    this.lastReport = {
      submerged: forces.length,
      fullySubmerged,
      atSurface,
      sinking,
      totalForce,
      totalCurrent,
      inWater: forces.length,
      ms: now() - started,
    };
    return forces;
  }

  /**
   * 采样点的水流方向与强度。
   *
   * 本项目的"流"不是速度场，而是**水位差**：如果左边水位比右边高，水就朝右推。
   * 这是对元胞自动机最自然的解释，也是它唯一诚实的解释 ——
   * 我们不知道水的速度，只知道相邻格的高度差。
   */
  private currentAt(body: BuoyantBody): { x: number; z: number; strength: number } {
    const y = body.center.y;
    const probe = Math.max(0.5, Math.min(body.half.x, body.half.z) * 0.8);
    const left = this.columnHeight(body.center.x - probe, y, body.center.z);
    const right = this.columnHeight(body.center.x + probe, y, body.center.z);
    const back = this.columnHeight(body.center.x, y, body.center.z - probe);
    const front = this.columnHeight(body.center.x, y, body.center.z + probe);

    // 高的一侧把物体推向低的一侧
    const dx = left - right;
    const dz = back - front;
    const strength = Math.min(1, Math.hypot(dx, dz));
    if (strength < 1e-4) return { x: 0, z: 0, strength: 0 };
    return { x: dx / strength, z: dz / strength, strength };
  }

  /** 某个 XZ 位置在给定高度附近的水位（用若干高度采样取最大值） */
  private columnHeight(x: number, y: number, z: number): number {
    let best = 0;
    for (let offset = -1; offset <= 1; offset += 1) {
      const amount = this.field.waterAt(x, y + offset, z);
      if (amount > best) best = amount;
    }
    return best;
  }

  /** 面板用：一行中文摘要 */
  describe(): string {
    const report = this.lastReport;
    if (report.submerged === 0) return `浮力：水里没有动态物体（${report.ms.toFixed(2)} ms）`;
    return (
      `浮力：${report.submerged} 个物体在水里（完全没入 ${report.fullySubmerged}，` +
      `水面附近 ${report.atSurface}，将下沉 ${report.sinking}）｜` +
      `浮力合计 ${report.totalForce.toFixed(0)} N，水流推力 ${report.totalCurrent.toFixed(0)} N｜` +
      `${report.ms.toFixed(2)} ms`
    );
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * 把体素水体包装成浮力系统能用的 `WaterField`。
 *
 * 单独抽出来是为了让**浮力系统本身零依赖**（可以在 Node 里用假水体做单测），
 * 而"怎么从体素网格读水量"这件事只有这一处实现。
 */
export function createVoxelWaterField(grid: {
  worldToVoxelX(worldX: number): number;
  worldToVoxelZ(worldZ: number): number;
  getWaterLevel(x: number, y: number, z: number): number;
}): WaterField {
  return {
    waterAt(worldX: number, worldY: number, worldZ: number): number {
      const x = grid.worldToVoxelX(worldX);
      const z = grid.worldToVoxelZ(worldZ);
      const y = Math.floor(worldY);
      if (y < 0) return 0;
      return grid.getWaterLevel(x, y, z);
    },
  };
}
