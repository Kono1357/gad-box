/**
 * 压力测试场景表（M4 压力测试批次 · 纯数据 + 纯函数）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么这里只有"描述"，没有"执行"
 * ────────────────────────────────────────────────────────────
 * 与 `data/stressTestMaps.ts`（M3 的 3 个场景）同一套思路：**存配方，不存快照**。
 * 但这一批更进一步 —— 连"怎么摆"都不写，只写**用量**：
 * "要多少粒子、放在多大的盒子里、堆多少格沙、几个刚体、铺多开"。
 *
 * 理由是耦合方向。真正的生成要碰 FluidSystem / Physics / BuildingSystem / SandSystem
 * 四个子系统（还要先清空世界、摆城市、算 spawn 点），那是 Engine 的事；
 * 一旦把生成代码搬进这里，这个文件就再也无法在 Node 里断言了。
 * 所以这里的每个函数都是**纯的**：给同样的入参永远算出同样的结果，
 * 不读时间、不读设备、不碰 DOM、不 import three / Rapier / Engine。
 *
 * ────────────────────────────────────────────────────────────
 * 所有上限数字的出处（不许凭记忆写数）
 * ────────────────────────────────────────────────────────────
 * - **流体**：`particleLimitFor(tier, isMobile)`（`fluid/FluidPresets.ts`）
 *   → 桌面 高配 20000 / 中配 12000 / 低配 6000；**手机一律 3000**。
 *   另外每个流体预设自己还有 `maxParticles`（水 20000 / 油 12000 / 蜂蜜 6000 /
 *   岩浆 8000 / 牛奶 12000），`FluidSystem` 取的是**两者取小**：
 *   `this.limit = Math.min(config.maxParticles, particleLimitFor(tier, isMobile))`。
 *   下面的 `fluidCapacity()` 复刻了这条规则（不然"换成蜂蜜"就会算多）。
 * - **刚体**：`Engine.performanceLimits()` 返回 **桌面动态 800 / 静态 2000，
 *   移动动态 300 / 静态 800**。⚠ 它是 Engine 的**私有方法里的字面量**，没有导出常量，
 *   所以这里只能抄一份；那边改了这里必须跟着改（两处都写了注释，便于搜到）。
 *   `data/stressTestMaps.ts` 里的 `MOBILE_DYNAMIC_BODY_BUDGET = 300` 是同一个数的另一份抄写。
 * - **沙**：`SAND_CONFIG.maxActivePerStep = 8000`（`config.ts`）。
 *   ⚠ 它管的是**单步处理多少活跃沙格**，不是"世界里能存多少沙格" ——
 *   拿它当总量上限是**偏保守**的截断，这一点在 `sandCellCapacity()` 的注释里写清了。
 * - **体素尺寸**：`WORLD_CONFIG.voxelSize = 1`（1 格 = 1 米），沙柱的列/格数直接按米理解。
 *
 * ────────────────────────────────────────────────────────────
 * targetFps 的两个数字来自需求，不是调出来的
 * ────────────────────────────────────────────────────────────
 * 需求原文给的通过标准是「**桌面 30 FPS+ / 移动端 15 FPS+**」。
 * 所以 10 个场景的 `targetFps.desktop` 一律 30、`targetFps.mobile` 一律 15，
 * 这里**没有**按场景"感觉"分别定目标 —— 那会变成给难的场景偷偷放水。
 *
 * ────────────────────────────────────────────────────────────
 * mobileScale 与低端机再降一档
 * ────────────────────────────────────────────────────────────
 * `mobileScale` 是"手机上把场景用量乘多少"。桌面恒为 1（桌面不降级）。
 * 低端机（`isLowEnd`）在**降级之后的数**上再乘一次 `LOW_END_EXTRA_SCALE = 0.6`。
 * ⚠ 0.6 这个数是**人为定的**：需求只说了"移动端要降级"，没说"低端机降多少"。
 * 写在这里是为了让它可见、可改，而不是散在生成代码里成为一个说不清来历的魔数。
 *
 * 降级之后"用量"和"目标"是两件事，别搞混：手机上粒子数被压到 3 成，
 * **目标 FPS 也跟着从 30 降到 15** —— 两边都变了，所以"手机上更容易通过"这句话
 * 只有在明确说了目标也变了的前提下才成立。
 */

import { SAND_CONFIG } from '../config';
import { FLUID_PRESETS, particleLimitFor, type FluidType } from '../fluid/FluidPresets';

/** 10 个场景的 id（需求点名的 10 个压力场景，一一对应） */
export type StressSceneId =
  | 'fluid_pool_10000'
  | 'fluid_waterfall_5000'
  | 'sand_collapse_large'
  | 'box_stack_1000'
  | 'doors_100'
  | 'drawbridge_50'
  | 'boat_in_water'
  | 'flood_city'
  | 'city_large'
  | 'combined_all';

/** 场景内容：只描述**用量**，具体怎么生成由 Engine 决定（见文件头） */
export interface StressScenePlan {
  /** 流体：要在什么盒子里生成多少粒子 */
  fluid: { preset: FluidType; count: number; box: [number, number, number, number, number, number] } | null;
  /** 沙：堆多高的沙柱（格），位置 */
  sand: { columns: number; height: number; origin: [number, number, number] } | null;
  /** 刚体：多少个盒子/门/桥/船，在哪个范围 */
  rigid: { boxes: number; doors: number; bridges: number; boats: number; spread: number } | null;
  /** 是否需要已有建筑（城市/洪水场景） */
  needsCity: boolean;
}

export interface StressScene {
  id: StressSceneId;
  name: string;
  /** 这个场景压的是什么（中文，面板显示） */
  focus: string;
  /** 移动端要不要降级、降到多少（0~1，桌面 1） */
  mobileScale: number;
  /** 需求给的桌面目标（FPS），写下来供对照 */
  targetFps: { desktop: number; mobile: number };
  /** 场景内容（**描述**，不是直接执行 —— 执行交给 Engine） */
  plan: StressScenePlan;
  /** 这个场景测不到什么（如实写，例如"没有测显存"） */
  blindSpots: string[];
}

// ============================================================
// 上限（出处见文件头；能 import 的一律 import，import 不到的老实写清在哪抄的）
// ============================================================

/** 需求给的桌面目标 FPS（通过标准：桌面 30 FPS+） */
export const TARGET_FPS_DESKTOP = 30;
/** 需求给的移动端目标 FPS（通过标准：移动端 15 FPS+） */
export const TARGET_FPS_MOBILE = 15;

/**
 * 低端机在降级后的数上再乘的系数。
 * ⚠ **人为定的**，需求没给这个数（需求只说"低端机要再降一档"）。取 0.6 的理由：
 * 大约是"降到六成"，既不至于把场景压到测不出东西（0.5 以下有些场景只剩几十个粒子），
 * 也不是象征性的 0.9。改它就是改口径，改完要重跑一遍压力测试才有可比性。
 */
export const LOW_END_EXTRA_SCALE = 0.6;

/**
 * 桌面动态刚体上限。来源：`Engine.performanceLimits()`（桌面 `dynamicMax: 800`）。
 * 该方法是私有的、没有导出常量，所以只能抄；改动时请全局搜 `RIGID_LIMIT_DESKTOP`。
 */
export const RIGID_LIMIT_DESKTOP = 800;
/** 移动端动态刚体上限。来源同上（移动 `dynamicMax: 300`），与 stressTestMaps 的 300 一致 */
export const RIGID_LIMIT_MOBILE = 300;

/** 刚体上限（按设备） */
export function rigidCapacity(isMobile: boolean): number {
  return isMobile ? RIGID_LIMIT_MOBILE : RIGID_LIMIT_DESKTOP;
}

/**
 * 沙格总量上限。
 *
 * ⚠ 取的是 `SAND_CONFIG.maxActivePerStep`（单步活跃沙格预算），**不是**世界的容量：
 * 世界里能存的沙格数由世界档位的 `sizeX × sizeY × sizeZ` 决定（新手档 48×16×48 = 36864 格），
 * 远大于 8000。用单步预算当前者是一个**偏保守**的决定：宁可少堆一点，
 * 也不要一次把 8000 格以上的沙全部标成"活跃"（那会让 SandSystem.step 超预算，
 * 表现是"沙崩一卡一卡地往下塌"，而不是"沙子多"）。
 */
export function sandCellCapacity(): number {
  return SAND_CONFIG.maxActivePerStep;
}

/**
 * 流体的实际上限：**预设上限与设备档位上取小**（复刻 `FluidSystem` 构造里的那行 min）。
 *
 * 为什么要复刻而不是读 `FluidSystem.capacity`：这个模块不 import 运行时系统
 * （否则就没法在 Node 里断言），而且"计划"本来就要在系统被创建**之前**算出来。
 * 风险是这条规则在两处各写了一遍 —— 如果 FluidSystem 的取小规则变了，
 * 这里会算出偏大的数，`describeScene` 就会报一个生成不出来的粒子数。
 * 断言文件里有一条专门核对"计划不超过预设容量"的检查，就是为了让这个漂移能被抓到。
 */
export function fluidCapacity(preset: FluidType, isMobile: boolean, isLowEnd: boolean): number {
  const tier: 'low' | 'high' = isLowEnd ? 'low' : 'high';
  return Math.min(FLUID_PRESETS[preset].maxParticles, particleLimitFor(tier, isMobile));
}

/** 这个场景在某档位下的目标 FPS（桌面 30 / 移动 15，均来自需求） */
export function targetFpsFor(scene: StressScene, isMobile: boolean): number {
  return isMobile ? scene.targetFps.mobile : scene.targetFps.desktop;
}

// ============================================================
// 10 个场景
// ============================================================

/**
 * 一批粒子在静止密度下占多少体积（米³）—— `count × (2 × 粒子半径)³`。
 *
 * 为什么这个换算是必须写出来的：它决定了"粒子数"和"水有多深"其实是同一件事。
 * 水的粒子半径 0.08 米 → 静止间距 0.16 米 → **单粒子占 0.16³ = 0.004096 米³**。
 * 于是 10000 个粒子就是 40.96 米³ 的水，摊在 36 米² 的池底上正好 1.14 米深；
 * 而要把 20×20 米的街区淹到 0.5 米，需要 200 ÷ 0.004096 ≈ 48828 个粒子 ——
 * 这是桌面上限 20000 的 2.45 倍（"洪水冲建筑"场景的盲区就是这么算出来的）。
 * 下面每个场景的注释都把这个账写出来了，免得以后有人以为"多写点粒子数"不要钱。
 */
export function fluidVolumeM3(preset: FluidType, count: number): number {
  const spacing = FLUID_PRESETS[preset].particleRadius * 2;
  return count * spacing ** 3;
}

export const STRESS_SCENES: readonly StressScene[] = [
  // ---------------------------------------------------------- 1
  {
    id: 'fluid_pool_10000',
    name: '10000 粒子水池',
    focus:
      '同屏一万个粒子的稳定与耗时：水池是流体**最密**的状态，密度约束、邻居收集、' +
      '碰撞全部满负荷，而且这是唯一一个"停下来之后还能继续跑"的场景（要验静止判定有没有生效）。',
    mobileScale: 0.3,
    // 需求：桌面 30 / 移动 15
    targetFps: { desktop: 30, mobile: 15 },
    plan: {
      // 盒 6×1.4×6 米 = 50.4 米³，按静止间距能装 12304 个 → 装得下 10000（81% 满），
      // 水摊平后约 1.14 米深：是个"池子"而不是"地上一层水皮"。
      fluid: { preset: 'water', count: 10000, box: [-3, 0, -3, 3, 1.4, 3] },
      sand: null,
      rigid: null,
      needsCity: false,
    },
    blindSpots: [
      '没有测显存：浏览器不暴露真实 VRAM 占用，所以报告里的 gpuMB 只能是 null 或粗估 —— 它不能用来判断"是不是显存满了"',
      '没有测"反复灌水/排干"的峰值：场景只生成一次，allocator、哈希表扩容、GC 的抖动都测不到',
      '桌面 20000 的上限只用到一半：它测不出"上限附近"的行为（要看 20000 就得手动改计划）',
      '帧率只反映**测试的这台机器**。同一份结果换台机器完全不同，不能外推',
    ],
  },

  // ---------------------------------------------------------- 2
  {
    id: 'fluid_waterfall_5000',
    name: '5000 粒子瀑布',
    focus:
      '粒子**一直在动**时的开销：瀑布和静水池的差别不是数量而是状态 —— ' +
      '水池静止后能整池跳过求解，瀑布永远在落、永远在撞底，那条优化一次都用不上。',
    mobileScale: 0.6,
    targetFps: { desktop: 30, mobile: 15 },
    plan: {
      // 出水口 3×3 米见方、3 米高（y 10~13，架在地形以上，具体高度由 Engine 按地形落位）。
      // 27 米³ 能装 6591 个 → 5000 个占 76%。5000 个粒子是 20.5 米³ 的水，
      // 所以它不是"一条细水柱"，是"一坨约 3 米见方的水团整体往下砸"。
      fluid: { preset: 'water', count: 5000, box: [-1.5, 10, -1.5, 1.5, 13, 1.5] },
      sand: null,
      rigid: null,
      needsCity: false,
    },
    blindSpots: [
      '真正的瀑布要**持续补水**（调用方每帧再 emit 一批）。本文件只描述首批粒子，持续补充会让实际粒子数逼近上限 —— 报告里的 fluidParticles 才能反映真实值',
      '没有测"水撞到刚体/建筑"的耦合开销：这个场景底下是地形，耦合那条路径基本空转（要看耦合去"船在水中"和"洪水冲建筑"）',
      '粒子多但寿命短（落到底就堆住了），所以它测不出"长期一万粒子在场"的稳态（那是水池场景的活）',
    ],
  },

  // ---------------------------------------------------------- 3
  {
    id: 'sand_collapse_large',
    name: '大型沙崩',
    focus:
      '体素沙的连锁滑落：安息角 + 湿度 + 稳定性是**每格每步**都要算的，' +
      '所以沙的开销大致是"活跃格数 × 步数"，沙崩的价值在于它会把活跃格一路扩散出去。',
    mobileScale: 0.35,
    targetFps: { desktop: 30, mobile: 15 },
    plan: {
      // 200 根沙柱 × 12 格 = 2400 格（上限 8000，用了 30%）。
      // 高度 12 格 = 12 米：干沙安息角 34° 时,12 米高的柱底半径约 17.8 米才会稳，
      // 所以这个高度是**必然塌**的（要的就是塌）。
      // origin 是沙柱阵列的底面中心（世界坐标，米）。排布方式（方阵/行/间距）由 Engine 决定，
      // 本文件只说"多少列、多高、从哪开始" —— 计划里没有排布字段是刻意的，避免两处各写一套布局。
      sand: { columns: 200, height: 12, origin: [0, 8, 0] },
      fluid: null,
      rigid: null,
      needsCity: false,
    },
    blindSpots: [
      '同一份 columns×height 的两次运行耗时可能差一倍：沙柱**形状**（细高 vs 矮胖）决定一次塌多少格，而"塌多少格"是随机的连锁结果',
      '沙格上限用的是单步活跃预算 8000（偏保守），不是世界的容量 —— 所以"2400 格"不代表"世界只能放这么多沙"',
      '没有测湿沙：这个场景按干沙堆，湿度那条分支（湿沙能立陡壁、饱和沙变泥流）不参与（要看湿度得调用方先 setMoisture）',
      '沙崩的**视觉**（哪些格在动）由 SandVisualizer 负责，本文件与报告都不含它 —— 掉帧可能来自可视化而不是模拟',
    ],
  },

  // ---------------------------------------------------------- 4
  {
    id: 'box_stack_1000',
    name: '1000 箱子堆叠',
    focus:
      '大量接触对的求解：一千个箱子互相压着，接触点数随层数平方级增长，' +
      '物理求解、休眠判定、堆叠稳定性三件事同时被压。',
    // 0.3 → 手机上 1000 × 0.3 = 300，正好等于移动动态刚体上限
    mobileScale: 0.3,
    targetFps: { desktop: 30, mobile: 15 },
    plan: {
      // spread 是塔的占地边长（米）。10×10 底、每层约 1.1 米高：
      // 1000 个 = 10 层，塔高约 11 米，占地约 11 米。
      // 用哪个模型由 Engine 定；M3 的压力场景已经核对过 `light_block`（1×1.1×1）是模型库里
      // 唯一的 1×1×1 立方体（`data/stressTestMaps.ts` 里的核对记录），继续用它最稳。
      rigid: { boxes: 1000, doors: 0, bridges: 0, boats: 0, spread: 20 },
      fluid: null,
      sand: null,
      needsCity: false,
    },
    blindSpots: [
      '**这是压力场景，不是玩法**：真实玩法不会在同一个塔上堆一千个箱子。它存在的意义是找"接触求解从哪里开始崩"，不是"给玩家一个可玩的东西"',
      '⚠ 需求点名的 1000 个在**桌面也放不下**：桌面动态刚体上限 800，scaledPlan 会截断到 800。所以实际测的是"800 个（上限处）"，不是 1000 个 —— 面板必须把这件事显示出来，否则数字对不上',
      '塔越高越容易晃，晃动本身是**浮点+迭代次数**的结果：两次运行的倒塌层数不完全可复现，报告里的帧率也就有波动',
      '没有测"倒塌之后重建"的开销：物体掉出世界/被卸载后的回收路径不在这里',
    ],
  },

  // ---------------------------------------------------------- 5
  {
    id: 'doors_100',
    name: '100 门同开',
    focus:
      '关节数量 + **同一帧内所有关节同时改目标角**的压力。门是旋转关节 + 限位 + 小质量的组合，' +
      '100 扇同时开=一帧内 100 个约束的目标一起动，这是"机关玩法"最坏的情况。',
    mobileScale: 0.3,
    targetFps: { desktop: 30, mobile: 15 },
    plan: {
      // spread 40 米：100 扇门排成约 10×10 的一片（每扇门含门框约 1.4 米宽）。
      // 用哪个模型由 Engine 定；核过的真实候选（`data/buildings/structure.ts`）：
      // door_wood 木门 0.9×2.05×0.15（门扇）、door_frame 门框 1.35×2.25×0.3（铰链装门框一侧）。
      rigid: { boxes: 0, doors: 100, bridges: 0, boats: 0, spread: 40 },
      fluid: null,
      sand: null,
      needsCity: false,
    },
    blindSpots: [
      '本文件只说"多少扇门"，不说门扇模型与铰链位置 —— 那由 Engine 的生成代码决定。如果那边没有"门"这种带铰链的构件，这个场景就退化成"100 个旋转关节"，测的东西变了一半',
      '没测门的**碰撞**：门开着的时候会不会撞到墙/人取决于摆位，摆得太密就是测接触而不是测关节',
      '没测"玩家一扇一扇开"的逐帧开销：这里测的是最坏情况的"同帧全开"',
    ],
  },

  // ---------------------------------------------------------- 6
  {
    id: 'drawbridge_50',
    name: '50 吊桥同放',
    focus:
      '大量**同类型**关节同时从竖直转到水平的那一瞬间：角速度最大、限位最容易被打穿、' +
      '接触也最密集（桥面拍在柱子上）。它是"50 个同款机关一起动"的基准。',
    // 0.24 → 手机上 12 座
    mobileScale: 0.24,
    targetFps: { desktop: 30, mobile: 15 },
    plan: {
      // ⚠ 注意"50"的口径：M3 的旧场景 `drawbridge_50`（`data/stressTestMaps.ts`）里的 50 是
      // **物体数**（50 ÷ 3 = 16 座桥），本场景的 50 是**桥的数量**。两个"50"不是一回事，
      // 面板上必须写清，否则会被当成同一个场景的两种数字。
      // spread 30 米：50 座桥排成约 7×7 的一片（每座约 5 米跨 + 1.5 米间隙）。
      // 桥面/支柱直接用 M3 核对过的两个模型（`data/stressTestMaps.ts` 的核对记录）：
      // floor_wood 4×0.25×4（桥面）、pillar_stone 1×4×1（支柱），关节轴取水平 +Z。
      rigid: { boxes: 0, doors: 0, bridges: 50, boats: 0, spread: 30 },
      fluid: null,
      sand: null,
      needsCity: false,
    },
    blindSpots: [
      '桥面的转动是关节驱动，本文件不含"放下的速度/是否加重力补偿"——那些参数在 Engine 的节点/电机设置里，会明显影响测出来的数字',
      '没有测"桥放下之后压到东西"：下面空着和下面有箱子是两种负载',
      'M3 的旧吊桥场景还在：两个场景的数字**不能互相比**（口径不同，桥的数量差 3 倍）',
    ],
  },

  // ---------------------------------------------------------- 7
  {
    id: 'boat_in_water',
    name: '船在水中',
    focus:
      '流体-刚体耦合：船的浮力/阻力/冲击/力矩每帧都要按"船体浸没的体积"算一遍，' +
      '是与粒子数**同时**涨的那部分开销（粒子越多，耦合的采样越密）。',
    mobileScale: 0.5,
    targetFps: { desktop: 30, mobile: 15 },
    plan: {
      // 池 5×1×5 米 = 25 米³（容量 6103 个），放 4000 个 = 16.4 米³ 的水，
      // 摊在 25 米² 上约 0.66 米深 —— 够一条小船浮起来，**不够大船**（吃水超过 0.66 米会直接坐底）。
      // 核过的真实候选（`data/buildings/props.ts` 的「交通」类）：
      // boat_row 小艇 3.0×0.65×1.2（和这个池子最匹配）、sailboat 帆船 3.2×3.7×1.2（高 3.7 米，
      // 桅杆会把"船"变成一个长条刚体，翻船概率大增）。
      // 一条船按 1 个动态刚体算（船身若有多个部件，那 engine 侧要按实际刚体数上报）。
      fluid: { preset: 'water', count: 4000, box: [-2.5, 0, -2.5, 2.5, 1.0, 2.5] },
      rigid: { boxes: 0, doors: 0, bridges: 0, boats: 1, spread: 8 },
      sand: null,
      needsCity: false,
    },
    blindSpots: [
      '没测"沉船"：沉下去之后的接触与休眠是另一条路径，船坐在池底时耦合会退化成纯接触',
      '水只有 0.66 米深（受 4000 粒子的体积限制），所以它测的是"小船/浮板"，不是"大船压水"',
      '浮力是**近似**的：耦合按包围盒采样粒子算浸没比例，船底是曲面时浸没体积会被高估/低估，报告里的物理耗时不含这个误差',
      '没有测波浪：静水里的船会很快静下来，真实海面要外部持续扰动（本文件不含扰动源）',
    ],
  },

  // ---------------------------------------------------------- 8
  {
    id: 'flood_city',
    name: '洪水冲建筑',
    focus:
      '耦合的建筑侧：水冲建筑时，**每一栋**泡在水里的建筑都要算浸没体积并施加力，' +
      '所以开销是"粒子数 × 建筑数"两边的乘积，这条路径在只有地形的场景里完全不跑。',
    mobileScale: 0.375,
    targetFps: { desktop: 30, mobile: 15 },
    plan: {
      // ⚠ 如实说明这个场景的**规模天花板**（算过的，不是感觉）：
      // 桌面流体的硬上限是 20000 个粒子 = 20000 × 0.004096 = **81.9 米³ 的水**。
      // 要把 20×20 米的街区淹到 0.5 米深需要 200 米³ ≈ 48828 个粒子 —— 是上限的 2.45 倍。
      // 所以"洪水冲建筑"在本项目的粒子上限下**做不到把街区淹掉**，
      // 只能做"街道浅水冲击"：盒 10×1.5×10 米（容量 36621），放 8000 个 = 32.8 米³，
      // 摊在 100 米² 上约 0.33 米深（没过脚踝）。它压的是耦合开销，不是"把房子冲倒"。
      fluid: { preset: 'water', count: 8000, box: [-5, 0, -5, 5, 1.5, 5] },
      sand: null,
      rigid: { boxes: 0, doors: 0, bridges: 0, boats: 0, spread: 20 },
      needsCity: true,
    },
    blindSpots: [
      '⚠ **"冲倒建筑"这件事测不到**：0.33 米深的浅水在这个项目的质量/力参数下推不动建筑。要真洪水必须放宽粒子上限（见 plan 里的算式），那是需求口径的改动，不是这里能补的',
      '⚠ 用现成城市生成时"能冲到的建筑"只有十来栋：建筑数 = `round(6 × buildingDensity)`（`world/GenerationPipeline.ts`）而模板密度上限是 2.0 → 最多 12 栋。建筑侧的开销会明显低于"洪水冲建筑"这个名字给人的预期',
      '建筑**本体**（多少栋、用什么模型、静态还是动态）由 Engine 生成，本文件只给 needsCity 标志，所以"城市"这一侧的规模在报告里没有数字 —— context 里必须由调用方写进去',
      '没测"水流冲走沙/侵蚀地形"：那是沙水交互（SandWaterInteraction）的路径，要看它得同时摆沙（本场景没有沙）',
      '耦合的浸没判定按包围盒近似，一栋房子的包围盒比它实际体积大，浅水会算出偏大的浮力 —— 这里是**偏乐观**的方向',
    ],
  },

  // ---------------------------------------------------------- 9
  {
    id: 'city_large',
    name: '大型城市',
    focus:
      '渲染侧的规模：城市本体是**静态**的，所以它压的不是物理求解，而是 draw call / 区块重建 / 视锥剔除 ' +
      '——也就是"东西多但都不动"时帧率还剩多少。',
    mobileScale: 0.4,
    targetFps: { desktop: 30, mobile: 15 },
    plan: {
      // 这里的 rigid 只是城市里额外摆的**可交互物件**（箱子/门），不是城市本体。
      // 城市本体的规模由 Engine 的建筑系统决定（本文件不敢替它报数）。
      rigid: { boxes: 600, doors: 60, bridges: 0, boats: 0, spread: 140 },
      fluid: null,
      sand: null,
      needsCity: true,
    },
    blindSpots: [
      '⚠ **"大型城市"用现成的城市生成做不出来**：建筑数是 `round(6 × buildingDensity)`（`world/GenerationPipeline.ts` 的建筑规划阶段），而 `mapTemplates.ts` 的「城市街区」给的密度是 1.8 → 只有 **11 栋**，密度打满 2.0 也才 12 栋。小物品是 `round(itemDensity × 3)`/块地 → 约 55 个。合起来**六十多个物体**，够不上"大型城市"',
      '⚠ 城市本体（几栋楼、几个方块）**不在本文件的计数里**：报告里的 rigidBodies 只数是可交互物件，看到"264 个刚体"绝不代表城市只有这么多东西',
      '需要**大型**世界档（192×192 米）才铺得开：退回标准档（96×96）会挤在一起，两个档位测出的数字不能互比 —— context 里要记下用了哪个档',
      '没测"城市初次加载/区块重建"的卡顿：本场景只测稳态帧率，加载那几秒的尖峰要看 FrameProfiler 的慢帧记录',
      '静态刚体不参与休眠/唤醒，所以休眠率在这个场景里接近满值，它**不表示**性能好',
    ],
  },

  // ---------------------------------------------------------- 10
  {
    id: 'combined_all',
    name: '综合测试',
    focus:
      '所有子系统**同时**满负荷：流体 + 沙 + 刚体 + 耦合 + 城市一起跑，用来找"总预算在哪里崩"、' +
      '以及是谁把整帧吃掉的（只能靠阶段拆解回答）。',
    mobileScale: 0.3,
    targetFps: { desktop: 30, mobile: 15 },
    plan: {
      // 盒 8×1×8 = 64 米³（容量 15625），放 6000 个 = 24.6 米³ ≈ 0.38 米深
      fluid: { preset: 'water', count: 6000, box: [-4, 0, -4, 4, 1.0, 4] },
      // 80 列 × 10 格 = 800 格（上限 8000 的 10%）：刻意**不**把沙堆满，
      // 否则综合场景会变成"沙崩场景 + 一点别的"，失去"多项同时中等负荷"的意义
      sand: { columns: 80, height: 10, origin: [0, 6, 0] },
      rigid: { boxes: 200, doors: 20, bridges: 10, boats: 1, spread: 60 },
      needsCity: true,
    },
    blindSpots: [
      '每一项都只是**中等规模**，所以它测不出单项极值 —— 单项极值看前面 9 个场景',
      '一个场景里同时压 5 个子系统时，"是谁拖慢了整帧"**只能**靠阶段拆解（fluidMs / sandMs / physicsMs / couplingMs / renderMs）。调用方没上报这些阶段的话，这个场景只能给出一个总帧率，说不出原因',
      '各子系统之间的相互影响（水流过沙面、船撞箱子）会额外产生开销，所以它的帧时间**不该**被当成"各项单独测出来之和"',
      '城市本体与地形形态都没有统一口径（顺带一说：现成城市生成只有约 11 栋建筑，算式见「大型城市」的盲区），两台机器上跑这个场景，负载可能不完全可比 —— context 必须记下世界档位与渲染距离',
    ],
  },
];

/** 按 id 取场景；找不到返回 undefined（调用方自己决定要不要兜底） */
export function getStressScene(id: string): StressScene | undefined {
  return STRESS_SCENES.find((scene) => scene.id === id);
}

// ============================================================
// 按设备档位缩放
// ============================================================

/**
 * 把一个"请求数"按系数缩放，但**有东西的场景不许缩成 0**。
 *
 * 为什么下限是 1 而不是 0：`1 × 0.3 = 0.3` 四舍五入是 0，
 * 于是"船在水中"在手机上会变成"没有船的池子"——那测的是别的东西。
 * 宁可留 1 个，也不要让场景悄悄变味。
 */
function scaleCount(requested: number, factor: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.max(1, Math.round(requested * factor));
}

/** 复制一个六元组（避免把场景表里的数组引用交给调用方去改坏） */
function copyBox(box: readonly [number, number, number, number, number, number]): [number, number, number, number, number, number] {
  return [box[0], box[1], box[2], box[3], box[4], box[5]];
}

/** 复制一个三元组（同上） */
function copyVec(v: readonly [number, number, number]): [number, number, number] {
  return [v[0], v[1], v[2]];
}

/**
 * 按设备档位算出**实际会用多少东西**。
 *
 * 规则（顺序是刻意的，先缩放再截断）：
 * 1. `factor = (移动端 ? scene.mobileScale : 1) × (低端机 ? 0.6 : 1)`；
 * 2. 每个数量乘 factor 后**夹到上限**：流体 ≤ `fluidCapacity()`、
 *    刚体总量 ≤ `rigidCapacity()`、沙格总量 ≤ `sandCellCapacity()`；
 * 3. 刚体的截断顺序固定 **箱子 → 门 → 桥 → 船**：预算不够时先砍船。
 *    固定顺序是为了"同一份计划在任何机器上截断结果都一样"（可复现），
 *    而不是按场景重要性排——那样每加一个场景就要重新想一遍顺序。
 *
 * ⚠ 两件必须说清的事：
 * - **降级也会改目标**。用量缩到 3 成的同时，目标 FPS 从 30 降到 15（见 `targetFpsFor`）。
 *   所以"手机上更容易过"这句话只有在说明目标也变了的前提下才成立；
 * - **降级只减数量，不缩小铺开范围**（`spread` 原样返回）。把 spread 一起缩会让物体互相挤在一起，
 *   那测出来的就不是"同屏 N 个"而是"接触爆炸"，两种数字混在一起没法比。
 */
export function scaledPlan(scene: StressScene, isMobile: boolean, isLowEnd: boolean): StressScenePlan {
  const factor = (isMobile ? scene.mobileScale : 1) * (isLowEnd ? LOW_END_EXTRA_SCALE : 1);

  // ── 流体 ──────────────────────────────────────────────
  let fluid: StressScenePlan['fluid'] = null;
  if (scene.plan.fluid) {
    const { preset, count, box } = scene.plan.fluid;
    const cap = fluidCapacity(preset, isMobile, isLowEnd);
    fluid = { preset, count: Math.min(scaleCount(count, factor), cap), box: copyBox(box) };
  }

  // ── 沙 ────────────────────────────────────────────────
  let sand: StressScenePlan['sand'] = null;
  if (scene.plan.sand) {
    const { columns, height, origin } = scene.plan.sand;
    const budget = sandCellCapacity();
    // 高度只夹到预算以内（不按 factor 缩）：柱高是"沙崩多高"的定义，缩了就不是同一个场景了
    const clampedHeight = Math.min(Math.max(0, Math.floor(height)), budget);
    // 列数按 factor 缩，再按"每列要占 height 格"反推最多能放几列
    const maxColumns = clampedHeight > 0 ? Math.max(1, Math.floor(budget / clampedHeight)) : 0;
    const wantedColumns = scaleCount(columns, factor);
    sand = {
      columns: Math.min(wantedColumns, maxColumns),
      height: clampedHeight,
      origin: copyVec(origin),
    };
  }

  // ── 刚体 ──────────────────────────────────────────────
  let rigid: StressScenePlan['rigid'] = null;
  if (scene.plan.rigid) {
    const source = scene.plan.rigid;
    let budget = rigidCapacity(isMobile);
    const take = (requested: number): number => {
      const got = Math.min(scaleCount(requested, factor), Math.max(0, budget));
      budget -= got;
      return got;
    };
    rigid = {
      boxes: take(source.boxes),
      doors: take(source.doors),
      bridges: take(source.bridges),
      boats: take(source.boats),
      spread: source.spread,
    };
  }

  return { fluid, sand, rigid, needsCity: scene.plan.needsCity };
}

// ============================================================
// 面板用的一行摘要
// ============================================================

/** 档位的中文说明（面板与报告都用同一句，避免两处各写一套） */
function tierLabel(isMobile: boolean, isLowEnd: boolean): string {
  if (isMobile) return isLowEnd ? '移动端低端档' : '移动端';
  return isLowEnd ? '桌面低端档' : '桌面档';
}

/**
 * 一行中文摘要：这个场景**在当前设备上**会生成多少东西。
 *
 * 为什么要写成一句话而不是让面板自己拼：面板要显示的是"实际会生成多少"，
 * 而这个数经过缩放与截断（例如 1000 个箱子在桌面上只剩 800）——
 * 面板自己拼就等于把缩放规则抄第二遍，迟早和 `scaledPlan` 对不上。
 * 被截断的项会显式写成 `请求 1000 → 800`，不藏着。
 */
export function describeScene(scene: StressScene, isMobile: boolean, isLowEnd: boolean): string {
  const plan = scaledPlan(scene, isMobile, isLowEnd);
  const target = targetFpsFor(scene, isMobile);
  const parts: string[] = [];

  if (plan.fluid) {
    const presetName = FLUID_PRESETS[plan.fluid.preset].name;
    const box = plan.fluid.box;
    const cap = fluidCapacity(plan.fluid.preset, isMobile, isLowEnd);
    const requested = scene.plan.fluid?.count ?? 0;
    const trunc = plan.fluid.count < requested ? `，请求 ${requested} → ${plan.fluid.count}` : '';
    parts.push(
      `流体 ${presetName} ${plan.fluid.count} 粒子` +
        `（盒 ${fmt(box[3] - box[0])}×${fmt(box[4] - box[1])}×${fmt(box[5] - box[2])} 米，` +
        `静水约 ${fluidVolumeM3(plan.fluid.preset, plan.fluid.count).toFixed(1)} 米³${trunc}，上限 ${cap}）`,
    );
  } else {
    parts.push('无流体');
  }

  if (plan.sand) {
    const wantColumns = scene.plan.sand?.columns ?? 0;
    const trunc = plan.sand.columns < wantColumns ? `，列数 ${wantColumns} → ${plan.sand.columns}` : '';
    parts.push(`沙 ${plan.sand.columns} 列 × ${plan.sand.height} 格 = ${plan.sand.columns * plan.sand.height} 格（上限 ${sandCellCapacity()}${trunc}）`);
  } else {
    parts.push('无沙');
  }

  if (plan.rigid) {
    const total = plan.rigid.boxes + plan.rigid.doors + plan.rigid.bridges + plan.rigid.boats;
    const want = scene.plan.rigid;
    const details = `箱 ${plan.rigid.boxes} / 门 ${plan.rigid.doors} / 桥 ${plan.rigid.bridges} / 船 ${plan.rigid.boats}`;
    const truncated = want
      ? plan.rigid.boxes < want.boxes ||
        plan.rigid.doors < want.doors ||
        plan.rigid.bridges < want.bridges ||
        plan.rigid.boats < want.boats
      : false;
    parts.push(
      `刚体 ${total} 个（${details}${truncated ? `，请求 箱 ${want?.boxes} / 门 ${want?.doors} / 桥 ${want?.bridges} / 船 ${want?.boats}` : ''}，上限 ${rigidCapacity(isMobile)}）`,
    );
  } else {
    parts.push('无刚体');
  }

  parts.push(plan.needsCity ? '含城市' : '不含城市');

  // 目标 FPS 必须跟着档位说：手机上的目标不是 30 而是 15
  const targetText = isMobile
    ? `目标 ${target} FPS（移动端口径，已从桌面 ${scene.targetFps.desktop} 降到 ${target}）`
    : `目标 ${target} FPS（桌面口径）`;

  return `${scene.name}：${tierLabel(isMobile, isLowEnd)}｜${parts.join('｜')}｜${targetText}`;
}

/** 数字显示：整数不带小数点，小数最多两位（0.66 米这种不要写成 0.6600000001） */
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
