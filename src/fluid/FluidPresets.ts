/**
 * 流体预设（M4 第二部分 · 第 1 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 每个数字为什么是这个值
 * ────────────────────────────────────────────────────────────
 * PBF（Position Based Fluids）的参数不像刚体那样可以"随便填"：
 * 它们之间有一组硬关系，填错的话表现不是"有点怪"，而是**直接炸**（粒子飞散或坍成一点）。
 *
 * 1. **`restDensity` 与 `particleVolume` 必须配套**。
 *    单个粒子的质量按 `m = restDensity × particleVolume` 算，
 *    而 `particleVolume` 取 `(2 × particleRadius)³` —— 也就是"粒子刚好挨着时的体积"。
 *    这样在静止水面下，密度会收敛到 `restDensity` 附近（不是精确相等，
 *    因为核函数把邻居的权重摊开了，实测偏差在 10~20%，见 `PBFSolver` 的 densityError 统计）。
 *    如果只改 `restDensity` 而不改质量，或者反过来，压力项会整体偏大/偏小，
 *    水面会**永远在震荡**（压力不停地把粒子推开、重力又拉回来）。
 *
 * 2. **`viscosity` 是 XSPH 系数，不是"黏度"的物理量**。
 *    它作用在速度上（把邻居的速度往自己的方向拉），不是应力张量。
 *    所以蜂蜜要"看起来黏"，除了调大它，还要**同时**调大 `damping` ——
 *    只有 XSPH 的话粒子会互相拖拽但整体仍会一直加速下坠。
 *
 * 3. **`gravityScale` 而不是直接写重力**：世界重力由物理层给（可被玩家调），
 *    流体只是按比例跟随。岩浆比水"重"的感觉靠 `density` 体现，不靠重力。
 *
 * 4. **`maxParticles` 是显存/内存护栏，不是审美选择**：桌面 20000、移动 3000 是
 *    本项目给出的上限（写进 README 的性能目标），预设只在这个上限内给建议值。
 *
 * ────────────────────────────────────────────────────────────
 * 如实说明：这些参数是**视觉调参**的结果，不是物理常数
 * ────────────────────────────────────────────────────────────
 * 水的真实黏度是 1 mPa·s，蜂蜜是 2000~10000 mPa·s —— 那是**动力黏度**，
 * 与这里的 XSPH 系数不是一个量纲，不能直接换算。
 * 所以这里的比值（蜂蜜是水的 ~40 倍）是"观感上像那么回事"的量级，
 * **不要**当成物理数据引用。README 的取舍清单里也写了这一条。
 */

/** 支持的流体类型 */
export type FluidType = 'water' | 'oil' | 'honey' | 'lava' | 'milk';

/** 流体配置（对应需求里的 FluidConfig） */
export interface FluidConfig {
  type: FluidType;
  /** 中文名（面板与日志直接用） */
  name: string;
  /** 粒子半径（米）。它决定"看起来多粗"，也决定 `particleVolume` */
  particleRadius: number;
  /** 静止密度（无量纲的"相对密度"，水为 1）。只影响耦合时的浮力与质量 */
  restDensity: number;
  /** XSPH 黏性系数（0.01 = 几乎不拖拽，0.5 = 很黏） */
  viscosity: number;
  /** 表面张力系数：让粒子互相"粘住"形成水滴/液滴边缘 */
  surfaceTension: number;
  /** 重力缩放（跟随世界重力） */
  gravityScale: number;
  color: number;
  /** 渲染用透明度（表面网格与粒子都用它） */
  opacity: number;
  /** 该流体的粒子上限（护栏，实际还受设备档位限制） */
  maxParticles: number;
  /** 一句话说明（面板上显示，含"这不是物理常数"的提醒） */
  note: string;
}

/**
 * 粒子半径统一取 0.08 米（直径 16 厘米）。
 *
 * 为什么不是更小：粒子数 = 体积 / (2r)³，半径减半会让粒子数变成 8 倍。
 * 在 48×16×48 的新手档里倒一桶水（约 2×2×1 米³），
 * r=0.08 时约 390 个粒子 —— 手机上（上限 3000）能倒好几桶；
 * r=0.04 就要 3100 个，一桶就把移动端上限吃满了。
 */
const DEFAULT_RADIUS = 0.08;

export const FLUID_PRESETS: Record<FluidType, FluidConfig> = {
  water: {
    type: 'water',
    name: '水',
    particleRadius: DEFAULT_RADIUS,
    restDensity: 1,
    viscosity: 0.02,
    surfaceTension: 0.05,
    gravityScale: 1,
    color: 0x3d7ae0,
    opacity: 0.72,
    maxParticles: 20000,
    note: '基准流体：会流平、会溅、会被地形挡住。',
  },
  oil: {
    type: 'oil',
    name: '油',
    particleRadius: DEFAULT_RADIUS,
    // 油比水轻：耦合时同一体积的浮力更小、阻力更大，所以会浮在水面上
    restDensity: 0.9,
    viscosity: 0.09,
    surfaceTension: 0.08,
    gravityScale: 1,
    color: 0x6b5a2a,
    opacity: 0.8,
    maxParticles: 12000,
    note: '比水轻、比水黏：落在水上会铺开，不会立刻沉下去。',
  },
  honey: {
    type: 'honey',
    name: '蜂蜜',
    particleRadius: DEFAULT_RADIUS,
    restDensity: 1.4,
    // 黏性是水的 ~40 倍（观感量级，不是物理换算）+ 强阻尼：倒出来是一条持续的柱而不是一摊
    viscosity: 0.42,
    surfaceTension: 0.16,
    gravityScale: 1,
    color: 0xd9a52a,
    opacity: 0.88,
    maxParticles: 6000,
    note: '黏而重：倒下时成柱、堆得住，不会像水一样立刻摊平。',
  },
  lava: {
    type: 'lava',
    name: '岩浆',
    particleRadius: DEFAULT_RADIUS,
    restDensity: 2.6,
    viscosity: 0.3,
    surfaceTension: 0.1,
    // 岩浆给一点点"上浮"是刻意的：它视觉上应该像在翻涌。1.0 是正常重力，
    // 大于 1 会让它下落得比水还猛（看着像石头），小于 1 又太飘 —— 0.85 是调出来的
    gravityScale: 0.85,
    color: 0xff5a1e,
    opacity: 1,
    maxParticles: 8000,
    note: '重而亮：会发光（渲染层加自发光），冷却不做（见 README 取舍）。',
  },
  milk: {
    type: 'milk',
    name: '牛奶',
    particleRadius: DEFAULT_RADIUS,
    restDensity: 1.03,
    viscosity: 0.05,
    surfaceTension: 0.07,
    gravityScale: 1,
    color: 0xf2efe6,
    opacity: 0.85,
    maxParticles: 12000,
    note: '比水略黏、略重：用来验证"换了预设真的会影响行为"而不是只换颜色。',
  },
};

export const FLUID_TYPES: readonly FluidType[] = ['water', 'oil', 'honey', 'lava', 'milk'];

/** 取预设；未知类型退回水（不抛异常 —— 存档里可能有旧类型名） */
export function getFluidPreset(type: string): FluidConfig {
  return FLUID_PRESETS[type as FluidType] ?? FLUID_PRESETS.water;
}

/**
 * 按设备档位给粒子上限。
 *
 * 移动端 3000 是需求里写死的目标，桌面 20000 也是。这里返回的就是**最终上限**，
 * 预设里的 `maxParticles` 只会让它更小（例如蜂蜜 6000），不会更大。
 */
export function particleLimitFor(tier: 'low' | 'mid' | 'high', isMobile: boolean): number {
  if (isMobile) {
    // 手机上一律 3000：低端机给更少也没有意义，因为"能不能跑"取决于单粒子成本，
    // 而那由 solver 的迭代数决定（见 FluidSystem 的 LOD）
    return 3000;
  }
  if (tier === 'low') return 6000;
  if (tier === 'mid') return 12000;
  return 20000;
}

/**
 * 静止时相邻粒子的**目标间距**（米）。
 *
 * 取粒子直径：这是 PBF 里的通行取法（"间距 ≈ h/2"），
 * 这样每个粒子核内有几十个邻居，密度与压力才有意义。
 * 质量不在这里算 —— 它依赖求解器实际使用的核函数，
 * 由 `PBFSolver.calibrateMass(spacing)` 在**离散格点上标定**
 * （连续公式会差一个数量级，原因见那个方法的注释）。
 */
export function targetSpacing(config: FluidConfig): number {
  return config.particleRadius * 2;
}
