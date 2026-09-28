/**
 * 压力测试批次断言（场景表 + 报告）。
 *
 * 这一批的断言不碰引擎：`StressTestScenes` / `StressTestReport` 都是纯逻辑，
 * 所以这里只喂数据、只看结果 —— 不需要浏览器、不需要 WebGL、不需要 Rapier。
 *
 * ⚠ 有一条**故意**不在这里断言的东西：10 个场景各自的**真实帧率**。
 * 那取决于跑测试的机器（而且要在浏览器里跑），在 Node 里既拿不到也不该编。
 * 这里能保证的是"计划不超上限、降级照规矩、判定与阈值一致"，
 * 帧率本身由 `Engine` 跑完填进 `StressTestResult`。
 */

import {
  STRESS_SCENES,
  TARGET_FPS_DESKTOP,
  TARGET_FPS_MOBILE,
  LOW_END_EXTRA_SCALE,
  RIGID_LIMIT_DESKTOP,
  RIGID_LIMIT_MOBILE,
  describeScene,
  fluidCapacity,
  fluidVolumeM3,
  getStressScene,
  rigidCapacity,
  sandCellCapacity,
  scaledPlan,
  type StressScene,
  type StressScenePlan,
} from '../../src/perf/StressTestScenes';
import {
  COMPARE_SAME_PERCENT,
  FLUID_BUDGET_MS,
  PHYSICS_BUDGET_MS,
  STRESS_REPORT_FORMAT,
  STRESS_REPORT_VERSION,
  appendHistory,
  buildResult,
  compareRuns,
  describeResult,
  exportReport,
  type StressMetrics,
  type StressSceneRef,
  type StressTestResult,
} from '../../src/perf/StressTestReport';
import { FLUID_PRESETS, particleLimitFor } from '../../src/fluid/FluidPresets';
import { SAND_CONFIG } from '../../src/config';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

/**
 * `compareRuns` 对比表的行数（即 `StressTestReport.COMPARE_ROWS` 的长度）。
 *
 * 它只用来在断言里算"跳过几项"，所以**没有导出**。这么写是刻意的：对比表加一项时，
 * 用到它的那条断言会立刻失败（13 + 2 不等于新的总数），而不是悄悄算出一个错的跳过数。
 */
const COMPARE_TOTAL_ROWS = 15;

// ============================================================
// 断言用的小工具（都是中性的，不含被测逻辑本身）
// ============================================================

/** 需求点名的 10 个场景名，逐字对照 */
const REQUIRED_NAMES: readonly string[] = [
  '10000 粒子水池',
  '5000 粒子瀑布',
  '大型沙崩',
  '1000 箱子堆叠',
  '100 门同开',
  '50 吊桥同放',
  '船在水中',
  '洪水冲建筑',
  '大型城市',
  '综合测试',
];

/** 四个设备档位（桌面/移动 × 普通/低端） */
const COMBOS: readonly { isMobile: boolean; isLowEnd: boolean; tag: string }[] = [
  { isMobile: false, isLowEnd: false, tag: '桌面' },
  { isMobile: false, isLowEnd: true, tag: '桌面低端' },
  { isMobile: true, isLowEnd: false, tag: '移动端' },
  { isMobile: true, isLowEnd: true, tag: '移动端低端' },
];

function sceneById(id: string): StressScene {
  const scene = getStressScene(id);
  if (!scene) throw new Error(`断言写错了：场景 ${id} 不存在`);
  return scene;
}

/** 刚体总数（计划里的四个字段之和） */
function rigidTotal(plan: StressScenePlan): number {
  if (!plan.rigid) return 0;
  return plan.rigid.boxes + plan.rigid.doors + plan.rigid.bridges + plan.rigid.boats;
}

/** 盒子的静止密度容量（复刻 FluidSystem.emitBox 的算法：V / spacing³） */
function boxCapacity(scene: StressScene): number | null {
  const fluid = scene.plan.fluid;
  if (!fluid) return null;
  const spacing = FLUID_PRESETS[fluid.preset].particleRadius * 2;
  const [minX, minY, minZ, maxX, maxY, maxZ] = fluid.box;
  const volume = Math.abs((maxX - minX) * (maxY - minY) * (maxZ - minZ));
  return Math.floor(volume / spacing ** 3);
}

/** 把"不合格的档位"拼成一句 detail（最多列 3 条，多了看着累） */
function failures(list: { tag: string; detail: string }[]): string {
  if (list.length === 0) return '全部档位都合格';
  const head = list.slice(0, 3).map((item) => `${item.tag}：${item.detail}`).join('；');
  return list.length > 3 ? `${head}（共 ${list.length} 项不合格）` : head;
}

/** 造一份指标（默认是一份"桌面 30 FPS 刚好达标"的样本） */
function metricsOf(overrides: Partial<StressMetrics> = {}): StressMetrics {
  return {
    fps: 30,
    minFps: 28,
    frameMs: 33.3,
    p95FrameMs: 30,
    fluidParticles: 1000,
    fluidMs: 2,
    sandMs: 0.5,
    sandActiveCells: 0,
    physicsMs: 3,
    couplingMs: 1,
    renderMs: 8,
    contactPairs: 50,
    rigidBodies: 10,
    // 默认就没有内存数据：这逼着每条断言都必须面对"没有数据"的情况
    heapMB: null,
    gpuMB: null,
    ...overrides,
  };
}

interface ResultOptions {
  isMobile?: boolean;
  sampleFrames?: number;
  durationMs?: number;
  timestamp?: number;
  context?: Record<string, string | number | boolean>;
  scene?: Pick<StressScene, 'id' | 'name' | 'targetFps'>;
}

/** 造一条结果 */
function resultOf(overrides: Partial<StressMetrics> = {}, options: ResultOptions = {}): StressTestResult {
  const scene = options.scene ?? sceneById('fluid_pool_10000');
  return buildResult({
    scene,
    timestamp: options.timestamp ?? 1_700_000_000_000,
    device: {
      isMobile: options.isMobile ?? false,
      devicePixelRatio: options.isMobile ? 3 : 1,
      label: options.isMobile ? '断言用手机' : '断言用桌面',
    },
    durationMs: options.durationMs ?? 20_000,
    sampleFrames: options.sampleFrames ?? 600,
    metrics: metricsOf(overrides),
    context: options.context ?? { 窗口: '1600×900', 渲染距离: 12, 世界档: 'large' },
  });
}

/** 场景里的 plan 快照（用来验证 scaledPlan 不改原数据） */
function planSnapshot(): string {
  return JSON.stringify(STRESS_SCENES.map((scene) => scene.plan));
}

/** 一个不在场景表里的合成场景（验证"查不到就写不可用"） */
const SYNTHETIC_SCENE: StressSceneRef = {
  id: 'not_a_real_scene',
  name: '合成样本',
  targetFps: { desktop: TARGET_FPS_DESKTOP, mobile: TARGET_FPS_MOBILE },
};

// ============================================================
// 断言
// ============================================================

export function runStressChecks(check: CheckFn): void {
  // ── 一、场景表 ────────────────────────────────────────────
  check('压力场景共 10 个（需求点名的数量）', STRESS_SCENES.length === 10, `实际 ${STRESS_SCENES.length} 个`);

  const ids = STRESS_SCENES.map((scene) => scene.id);
  const uniqueIds = new Set(ids);
  check('10 个场景 id 互不重复', uniqueIds.size === STRESS_SCENES.length, `去重后 ${uniqueIds.size} 个`);

  const names = STRESS_SCENES.map((scene) => scene.name);
  const missingNames = REQUIRED_NAMES.filter((name) => !names.includes(name));
  check(
    '需求点名的 10 个场景名称一个不少',
    missingNames.length === 0,
    missingNames.length === 0 ? REQUIRED_NAMES.join('、') : `缺：${missingNames.join('、')}`,
  );

  const asciiNames = STRESS_SCENES.filter((scene) => /[A-Za-z]/.test(scene.name));
  check(
    '每个场景的名称都是中文（不含拉丁字母）',
    asciiNames.length === 0,
    asciiNames.length === 0 ? '' : `含字母：${asciiNames.map((scene) => scene.name).join('、')}`,
  );

  const thinFocus = STRESS_SCENES.filter((scene) => scene.focus.trim().length < 20);
  check(
    '每个场景的 focus 都写清了"压什么"（非空且 ≥20 字）',
    thinFocus.length === 0,
    thinFocus.length === 0 ? '最短的也说明了压哪条路径' : `太短：${thinFocus.map((scene) => scene.name).join('、')}`,
  );

  const fewBlindSpots = STRESS_SCENES.filter((scene) => scene.blindSpots.length < 2);
  check(
    '每个场景的 blindSpots 至少 2 条（如实写清"测不到什么"）',
    fewBlindSpots.length === 0,
    fewBlindSpots.length === 0
      ? `每场景 ${Math.min(...STRESS_SCENES.map((scene) => scene.blindSpots.length))}~${Math.max(...STRESS_SCENES.map((scene) => scene.blindSpots.length))} 条`
      : `不足：${fewBlindSpots.map((scene) => scene.name).join('、')}`,
  );

  const emptyBlindSpots = STRESS_SCENES.flatMap((scene) =>
    scene.blindSpots.filter((item) => item.trim().length < 6).map((item) => `${scene.name}：${item}`),
  );
  check(
    '每条 blindSpot 都是有内容的说明（不是占位符）',
    emptyBlindSpots.length === 0,
    emptyBlindSpots.length === 0 ? '' : emptyBlindSpots.join('；'),
  );

  const lookupMismatch = STRESS_SCENES.filter((scene) => getStressScene(scene.id) !== scene);
  check(
    '每个 id 都能被 getStressScene 查到同一个对象',
    lookupMismatch.length === 0,
    lookupMismatch.length === 0 ? `查了 ${STRESS_SCENES.length} 个` : lookupMismatch.map((scene) => scene.id).join('、'),
  );

  check(
    'getStressScene 对未知 id 返回 undefined（不抛异常）',
    getStressScene('does_not_exist') === undefined && getStressScene('') === undefined,
  );

  const badDesktopTarget = STRESS_SCENES.filter((scene) => scene.targetFps.desktop !== TARGET_FPS_DESKTOP);
  check(
    `桌面目标 FPS 全部是需求给的 ${TARGET_FPS_DESKTOP}`,
    badDesktopTarget.length === 0,
    badDesktopTarget.length === 0 ? '' : `不一致：${badDesktopTarget.map((scene) => scene.name).join('、')}`,
  );

  const badMobileTarget = STRESS_SCENES.filter((scene) => scene.targetFps.mobile !== TARGET_FPS_MOBILE);
  check(
    `移动端目标 FPS 全部是需求给的 ${TARGET_FPS_MOBILE}`,
    badMobileTarget.length === 0,
    badMobileTarget.length === 0 ? '' : `不一致：${badMobileTarget.map((scene) => scene.name).join('、')}`,
  );

  const badScale = STRESS_SCENES.filter((scene) => !(scene.mobileScale > 0 && scene.mobileScale <= 1));
  check(
    'mobileScale 都在 (0, 1] 区间内（桌面恒为 1，不降级）',
    badScale.length === 0,
    badScale.length === 0
      ? `范围 ${Math.min(...STRESS_SCENES.map((scene) => scene.mobileScale))}~${Math.max(...STRESS_SCENES.map((scene) => scene.mobileScale))}`
      : badScale.map((scene) => `${scene.name}=${scene.mobileScale}`).join('、'),
  );

  const emptyPlans = STRESS_SCENES.filter(
    (scene) => !scene.plan.fluid && !scene.plan.sand && !scene.plan.rigid && !scene.plan.needsCity,
  );
  check(
    '每个场景的 plan 至少描述了一样东西（流体/沙/刚体/城市）',
    emptyPlans.length === 0,
    emptyPlans.length === 0 ? '' : `空计划：${emptyPlans.map((scene) => scene.name).join('、')}`,
  );

  const badBoxes = STRESS_SCENES.filter((scene) => {
    const box = scene.plan.fluid?.box;
    if (!box) return false;
    return !(box.length === 6 && box.every((v) => Number.isFinite(v)) && box[0] < box[3] && box[1] < box[4] && box[2] < box[5]);
  });
  check(
    '流体场景的盒子是 6 个有限数且 min < max',
    badBoxes.length === 0,
    badBoxes.length === 0 ? '' : badBoxes.map((scene) => scene.name).join('、'),
  );

  const overCapacity = STRESS_SCENES.filter((scene) => {
    const capacity = boxCapacity(scene);
    const count = scene.plan.fluid?.count ?? 0;
    return capacity !== null && count > capacity;
  });
  check(
    '流体请求数不超过盒子的静止密度容量（否则 emitBox 会静默截断）',
    overCapacity.length === 0,
    overCapacity.length === 0
      ? STRESS_SCENES.filter((scene) => scene.plan.fluid)
          .map((scene) => `${scene.name} 容量 ${boxCapacity(scene)}`)
          .join('；')
      : overCapacity.map((scene) => `${scene.name} 请求 ${scene.plan.fluid?.count} > 容量 ${boxCapacity(scene)}`).join('；'),
  );

  const badSand = STRESS_SCENES.filter((scene) => {
    const sand = scene.plan.sand;
    if (!sand) return false;
    return !(
      Number.isInteger(sand.columns) &&
      sand.columns > 0 &&
      Number.isInteger(sand.height) &&
      sand.height > 0 &&
      sand.origin.length === 3 &&
      sand.origin.every((v) => Number.isFinite(v))
    );
  });
  check(
    '沙场景的列数/高度是正整数、origin 是三个有限数',
    badSand.length === 0,
    badSand.length === 0 ? '' : badSand.map((scene) => scene.name).join('、'),
  );

  // ── 二、上限与缩放 ────────────────────────────────────────
  const fluidOverMobile: { tag: string; detail: string }[] = [];
  const fluidOverDesktop: { tag: string; detail: string }[] = [];
  for (const combo of COMBOS) {
    for (const scene of STRESS_SCENES) {
      const plan = scaledPlan(scene, combo.isMobile, combo.isLowEnd);
      const count = plan.fluid?.count ?? 0;
      if (combo.isMobile && count > particleLimitFor('high', true)) {
        fluidOverMobile.push({ tag: combo.tag, detail: `${scene.name} ${count} 粒子` });
      }
      if (!combo.isMobile && count > particleLimitFor('high', false)) {
        fluidOverDesktop.push({ tag: combo.tag, detail: `${scene.name} ${count} 粒子` });
      }
    }
  }
  check(
    `移动端流体粒子数一律 ≤ ${particleLimitFor('high', true)}（需求上限）`,
    fluidOverMobile.length === 0,
    failures(fluidOverMobile),
  );
  check(
    `桌面流体粒子数一律 ≤ ${particleLimitFor('high', false)}（需求上限）`,
    fluidOverDesktop.length === 0,
    failures(fluidOverDesktop),
  );

  const pool = sceneById('fluid_pool_10000');
  const poolMobile = scaledPlan(pool, true, false).fluid?.count ?? 0;
  check(
    '10000 粒子水池在移动端被压到 ≤3000 且仍 >0',
    poolMobile > 0 && poolMobile <= 3000,
    `移动端实际 ${poolMobile} 粒子（桌面 ${pool.plan.fluid?.count}）`,
  );
  check(
    '10000 粒子水池在桌面档保持 10000（不超过 20000 上限，不缩水）',
    scaledPlan(pool, false, false).fluid?.count === 10000,
    `桌面实际 ${scaledPlan(pool, false, false).fluid?.count} 粒子`,
  );

  const rigidOverMobile: { tag: string; detail: string }[] = [];
  const rigidOverDesktop: { tag: string; detail: string }[] = [];
  for (const combo of COMBOS) {
    for (const scene of STRESS_SCENES) {
      const total = rigidTotal(scaledPlan(scene, combo.isMobile, combo.isLowEnd));
      if (combo.isMobile && total > RIGID_LIMIT_MOBILE) {
        rigidOverMobile.push({ tag: combo.tag, detail: `${scene.name} ${total} 个` });
      }
      if (!combo.isMobile && total > RIGID_LIMIT_DESKTOP) {
        rigidOverDesktop.push({ tag: combo.tag, detail: `${scene.name} ${total} 个` });
      }
    }
  }
  check(
    `移动端刚体总数一律 ≤ ${RIGID_LIMIT_MOBILE}（引擎动态刚体上限）`,
    rigidOverMobile.length === 0,
    failures(rigidOverMobile),
  );
  check(
    `桌面刚体总数一律 ≤ ${RIGID_LIMIT_DESKTOP}（引擎动态刚体上限）`,
    rigidOverDesktop.length === 0,
    failures(rigidOverDesktop),
  );

  const boxes = sceneById('box_stack_1000');
  const boxesDesktop = scaledPlan(boxes, false, false).rigid?.boxes ?? 0;
  const boxesMobile = scaledPlan(boxes, true, false).rigid?.boxes ?? 0;
  check(
    '1000 箱子堆叠在桌面被截断到 800 上限（场景数据里仍保留"请求 1000"）',
    boxesDesktop === RIGID_LIMIT_DESKTOP && boxes.plan.rigid?.boxes === 1000,
    `场景请求 ${boxes.plan.rigid?.boxes} → 桌面实际 ${boxesDesktop}（上限 ${RIGID_LIMIT_DESKTOP}）`,
  );
  check(
    '1000 箱子堆叠在移动端被压到 ≤300',
    boxesMobile > 0 && boxesMobile <= RIGID_LIMIT_MOBILE,
    `移动端实际 ${boxesMobile} 个（桌面请求 1000）`,
  );

  const sandOver: { tag: string; detail: string }[] = [];
  for (const combo of COMBOS) {
    for (const scene of STRESS_SCENES) {
      const sand = scaledPlan(scene, combo.isMobile, combo.isLowEnd).sand;
      if (!sand) continue;
      const cells = sand.columns * sand.height;
      if (cells > sandCellCapacity()) {
        sandOver.push({ tag: combo.tag, detail: `${scene.name} ${cells} 格` });
      }
    }
  }
  check(
    `沙格数一律 ≤ ${sandCellCapacity()}（SAND_CONFIG.maxActivePerStep 单步活跃预算）`,
    sandOver.length === 0,
    failures(sandOver),
  );

  const lowEndNotLower: { tag: string; detail: string }[] = [];
  for (const scene of STRESS_SCENES) {
    if (!scene.plan.fluid || scene.plan.fluid.count === 0) continue;
    const normalDesktop = scaledPlan(scene, false, false).fluid?.count ?? 0;
    const lowDesktop = scaledPlan(scene, false, true).fluid?.count ?? 0;
    const normalMobile = scaledPlan(scene, true, false).fluid?.count ?? 0;
    const lowMobile = scaledPlan(scene, true, true).fluid?.count ?? 0;
    if (!(lowDesktop < normalDesktop)) lowEndNotLower.push({ tag: '桌面', detail: `${scene.name} ${normalDesktop}→${lowDesktop}` });
    if (!(lowMobile < normalMobile)) lowEndNotLower.push({ tag: '移动端', detail: `${scene.name} ${normalMobile}→${lowMobile}` });
  }
  check(
    '低端机在已降级的数上再降一档（流体粒子数严格更少）',
    lowEndNotLower.length === 0,
    lowEndNotLower.length === 0 ? `低端系数 ${LOW_END_EXTRA_SCALE}` : failures(lowEndNotLower),
  );

  const lowEndOverLimit = STRESS_SCENES.filter((scene) => {
    const lowCap = fluidCapacity(scene.plan.fluid?.preset ?? 'water', false, true);
    return (scaledPlan(scene, false, true).fluid?.count ?? 0) > lowCap;
  });
  check(
    `桌面低端档不超过 particleLimitFor('low') 的上限`,
    lowEndOverLimit.length === 0,
    lowEndOverLimit.length === 0 ? `上限 ${particleLimitFor('low', false)}` : lowEndOverLimit.map((s) => s.name).join('、'),
  );

  const boxesLowEnd = scaledPlan(boxes, false, true).rigid?.boxes ?? 0;
  check(
    '低端机同样会压缩刚体数量（箱子 800 → 更低）',
    boxesLowEnd < boxesDesktop && boxesLowEnd > 0,
    `桌面 ${boxesDesktop} → 桌面低端 ${boxesLowEnd}`,
  );

  const sandScene = sceneById('sand_collapse_large');
  const sandMobile = scaledPlan(sandScene, true, false).sand;
  check(
    '降级只缩沙柱的列数、不改柱高（柱高是"沙崩多高"的定义）',
    sandMobile !== null && sandMobile.height === sandScene.plan.sand?.height && sandMobile.columns < (sandScene.plan.sand?.columns ?? 0),
    `列 ${sandScene.plan.sand?.columns} → ${sandMobile?.columns}，高 ${sandScene.plan.sand?.height} → ${sandMobile?.height}`,
  );

  const before = planSnapshot();
  for (const combo of COMBOS) {
    for (const scene of STRESS_SCENES) {
      scaledPlan(scene, combo.isMobile, combo.isLowEnd);
      describeScene(scene, combo.isMobile, combo.isLowEnd);
    }
  }
  const after = planSnapshot();
  check('scaledPlan / describeScene 是纯函数：不修改场景表里的 plan 数据', before === after);

  const repeatSame =
    JSON.stringify(scaledPlan(pool, true, true)) === JSON.stringify(scaledPlan(pool, true, true)) &&
    JSON.stringify(scaledPlan(sandScene, false, true)) === JSON.stringify(scaledPlan(sandScene, false, true));
  check('同一档位重复调用 scaledPlan 结果完全一致（可复现）', repeatSame);

  const waterfall = sceneById('fluid_waterfall_5000');
  check(
    '桌面非低端档不缩放（5000 粒子瀑布就是 5000）',
    scaledPlan(waterfall, false, false).fluid?.count === 5000,
    `实际 ${scaledPlan(waterfall, false, false).fluid?.count}`,
  );

  const zeroed = STRESS_SCENES.filter((scene) => {
    const plan = scaledPlan(scene, true, true);
    const hadFluid = (scene.plan.fluid?.count ?? 0) > 0;
    const hadRigid = rigidTotal(scene.plan) > 0;
    const hadSand = (scene.plan.sand?.columns ?? 0) > 0;
    if (hadFluid && (plan.fluid?.count ?? 0) < 1) return true;
    if (hadRigid && rigidTotal(plan) < 1) return true;
    if (hadSand && (plan.sand?.columns ?? 0) < 1) return true;
    return false;
  });
  check(
    '最狠的降级档下场景也不会被缩成"空场景"（每种东西至少留 1）',
    zeroed.length === 0,
    zeroed.length === 0 ? '箱/门/桥/船/粒子/沙列都 ≥1' : zeroed.map((scene) => scene.name).join('、'),
  );

  const presetKept = STRESS_SCENES.filter((scene) => {
    const preset = scene.plan.fluid?.preset;
    if (!preset) return false;
    return scaledPlan(scene, true, true).fluid?.preset !== preset;
  });
  check('降级不改流体预设（水还是水）', presetKept.length === 0, presetKept.map((scene) => scene.name).join('、') || '');

  check(
    'fluidCapacity 复刻了"预设上限与设备上限取小"（蜂蜜桌面 6000、水移动 3000）',
    fluidCapacity('honey', false, false) === 6000 &&
      fluidCapacity('water', true, false) === 3000 &&
      fluidCapacity('water', false, false) === 20000,
    `蜂蜜桌面 ${fluidCapacity('honey', false, false)}／水桌面 ${fluidCapacity('water', false, false)}／水移动 ${fluidCapacity('water', true, false)}`,
  );

  check(
    '上限常量与真实来源一致（刚体 800/300、沙 8000、目标 30/15）',
    RIGID_LIMIT_DESKTOP === 800 &&
      RIGID_LIMIT_MOBILE === 300 &&
      sandCellCapacity() === SAND_CONFIG.maxActivePerStep &&
      TARGET_FPS_DESKTOP === 30 &&
      TARGET_FPS_MOBILE === 15 &&
      rigidCapacity(true) === RIGID_LIMIT_MOBILE,
    `沙预算 ${sandCellCapacity()}（SAND_CONFIG 里是 ${SAND_CONFIG.maxActivePerStep}）`,
  );

  check(
    '摘要里的目标 FPS 跟着档位走：桌面 30、移动 15（两个数都来自需求）',
    STRESS_SCENES.every(
      (scene) =>
        describeScene(scene, false, false).includes('目标 30 FPS') &&
        describeScene(scene, true, false).includes('目标 15 FPS'),
    ),
    `${STRESS_SCENES.length} 个场景 × 2 个档位都查过`,
  );

  check(
    'fluidVolumeM3 与"粒子数 × 间距³"一致（10000 粒子 ≈ 41 米³）',
    Math.abs(fluidVolumeM3('water', 10000) - 40.96) < 1e-6,
    `10000 个水粒子 = ${fluidVolumeM3('water', 10000).toFixed(2)} 米³`,
  );

  // ── 三、describeScene ─────────────────────────────────────
  const noName = STRESS_SCENES.filter((scene) =>
    COMBOS.some((combo) => !describeScene(scene, combo.isMobile, combo.isLowEnd).includes(scene.name)),
  );
  check(
    '每个场景的中文摘要里都含场景名（任何档位）',
    noName.length === 0,
    noName.length === 0 ? `${STRESS_SCENES.length} × ${COMBOS.length} 组都查过` : noName.map((scene) => scene.name).join('、'),
  );

  const noCount = STRESS_SCENES.filter((scene) =>
    COMBOS.some((combo) => {
      const plan = scaledPlan(scene, combo.isMobile, combo.isLowEnd);
      const text = describeScene(scene, combo.isMobile, combo.isLowEnd);
      if (plan.fluid) return !text.includes(`${plan.fluid.count} 粒子`);
      if (plan.rigid) return !text.includes(`刚体 ${rigidTotal(plan)} 个`);
      if (plan.sand) return !text.includes(`${plan.sand.columns} 列 × ${plan.sand.height} 格`);
      return false;
    }),
  );
  check(
    '摘要里含当前档位下**实际**会生成的数量（粒子/刚体/沙列）',
    noCount.length === 0,
    noCount.length === 0 ? '' : noCount.map((scene) => scene.name).join('、'),
  );

  const mobileText = describeScene(pool, true, false);
  check(
    '移动端摘要写明目标 FPS 已从 30 降到 15',
    mobileText.includes('目标 15 FPS') && mobileText.includes('已从桌面 30 降到 15'),
    mobileText,
  );
  check(
    '桌面摘要写明目标是 30 FPS',
    describeScene(pool, false, false).includes('目标 30 FPS'),
    describeScene(pool, false, false),
  );

  const boxText = describeScene(boxes, false, false);
  check(
    '箱子场景的摘要把截断写出来了（请求 1000 → 实际 800）',
    boxText.includes('刚体 800 个') && boxText.includes('请求 箱 1000'),
    boxText,
  );

  const multiLine = STRESS_SCENES.filter((scene) =>
    COMBOS.some((combo) => describeScene(scene, combo.isMobile, combo.isLowEnd).includes('\n')),
  );
  check('摘要是单行（面板一行显示，不含换行）', multiLine.length === 0, multiLine.map((scene) => scene.name).join('、') || '');

  const throws = STRESS_SCENES.filter((scene) => {
    try {
      COMBOS.forEach((combo) => describeScene(scene, combo.isMobile, combo.isLowEnd));
      return false;
    } catch {
      return true;
    }
  });
  check('describeScene 在任何档位下都不抛异常', throws.length === 0, throws.map((scene) => scene.name).join('、') || '');

  // ── 四、buildResult 的通过判定 ────────────────────────────
  const exactly = resultOf({ fps: 30 });
  check('恰好等于目标（30 FPS）算通过', exactly.passed === true, exactly.verdict);

  const below = resultOf({ fps: 29.9 });
  check('低于目标（29.9 FPS）算不通过', below.passed === false, below.verdict);

  const twenty = resultOf({ fps: 20 });
  const twentyMobile = resultOf({ fps: 20 }, { isMobile: true });
  check(
    'passed 判定跟着场景的 targetFps 走：同为 20 FPS，桌面不通过、移动端通过',
    twenty.passed === false && twentyMobile.passed === true,
    `桌面（目标 30）${twenty.passed ? '通过' : '不通过'}／移动端（目标 15）${twentyMobile.passed ? '通过' : '不通过'}`,
  );

  const noFrames = resultOf({ fps: 60 }, { sampleFrames: 0 });
  check(
    '采样 0 帧一律判不通过（"没测"不等于"通过"），即使 FPS 数字很好看',
    noFrames.passed === false && noFrames.verdict.includes('没有采到任何帧'),
    noFrames.verdict,
  );

  check(
    'verdict 里点名"平均 FPS"这一项没达标',
    below.verdict.includes('未达标') && below.verdict.includes('平均 FPS'),
    below.verdict,
  );
  check(
    'verdict 里同时有实测值与目标值（21.0 / 30）',
    resultOf({ fps: 21 }).verdict.includes('21.0') && resultOf({ fps: 21 }).verdict.includes('目标 30'),
    resultOf({ fps: 21 }).verdict,
  );

  const spiky = resultOf({ fps: 40, p95FrameMs: 41 });
  check(
    '平均达标但 p95 超标时，verdict 指出 p95（且不影响 passed）',
    spiky.passed === true && spiky.verdict.includes('p95') && spiky.verdict.includes('其它告警'),
    spiky.verdict,
  );

  const heavyFluid = resultOf({ fps: 40, fluidMs: FLUID_BUDGET_MS + 2 });
  check(
    `流体耗时超预算（${FLUID_BUDGET_MS} ms，来源 FluidSystem）时 verdict 会提醒`,
    heavyFluid.verdict.includes('超过单帧流体预算') && heavyFluid.passed === true,
    heavyFluid.verdict,
  );

  const heavyPhysics = resultOf({ fps: 40, physicsMs: PHYSICS_BUDGET_MS + 3 });
  check(
    `物理耗时超预算（${PHYSICS_BUDGET_MS} ms，来源 TimeControl）时 verdict 会提醒`,
    heavyPhysics.verdict.includes('超过单帧物理预算') && heavyPhysics.passed === true,
    heavyPhysics.verdict,
  );

  const kept = resultOf({}, { context: { 窗口: '1600×900', 粒子上限: 20000, 画质: 'high' }, timestamp: 123456, durationMs: 15000, sampleFrames: 500 });
  check(
    'buildResult 原样保留 sceneId / device / context / 时长与帧数',
    kept.sceneId === pool.id &&
      kept.device.label === '断言用桌面' &&
      kept.context['粒子上限'] === 20000 &&
      kept.durationMs === 15000 &&
      kept.sampleFrames === 500 &&
      kept.timestamp === 123456,
    `context 共 ${Object.keys(kept.context).length} 项`,
  );

  const garbage = resultOf({ fps: Number.NaN, frameMs: -5, fluidParticles: -3 });
  check(
    'buildResult 把 NaN / 负数兜底成 0（NaN 会让整份 JSON 变 null）',
    garbage.metrics.fps === 0 && garbage.metrics.frameMs === 0 && garbage.metrics.fluidParticles === 0 && garbage.passed === false,
    `fps=${garbage.metrics.fps}／frameMs=${garbage.metrics.frameMs}／粒子=${garbage.metrics.fluidParticles}`,
  );

  check(
    'heapMB / gpuMB 拿不到时保持 null，不写成 0',
    exactly.metrics.heapMB === null && exactly.metrics.gpuMB === null,
    `heap=${String(exactly.metrics.heapMB)}／gpu=${String(exactly.metrics.gpuMB)}`,
  );

  const withHeap = resultOf({ heapMB: 128.4, gpuMB: 96 });
  check(
    '有内存数据时按原值保留（不被兜底逻辑吃掉）',
    withHeap.metrics.heapMB === 128.4 && withHeap.metrics.gpuMB === 96,
    `heap=${String(withHeap.metrics.heapMB)} MB`,
  );

  // ── 五、compareRuns ──────────────────────────────────────
  const slow = resultOf({ fps: 30, minFps: 24, frameMs: 33.3 });
  const fast = resultOf({ fps: 40, minFps: 36, frameMs: 25 });
  const faster = compareRuns(slow, fast);
  check('FPS 提升（30 → 40）结论是「变快」', faster.verdict.includes('变快'), faster.verdict);

  const slower = compareRuns(fast, slow);
  check('FPS 下降（40 → 30）结论是「变慢」', slower.verdict.includes('变慢'), slower.verdict);

  const tiny = compareRuns(resultOf({ fps: 30 }), resultOf({ fps: 30.5 }));
  check(
    `差异 ${((30.5 - 30) / 30 * 100).toFixed(1)}% < ${COMPARE_SAME_PERCENT}% 结论是「基本一样」`,
    tiny.verdict.includes('基本一样'),
    tiny.verdict,
  );

  const identical = compareRuns(slow, slow);
  check('两次完全一样时结论是「基本一样」', identical.verdict.includes('基本一样'), identical.verdict);

  check(
    `「基本一样」的阈值 ${COMPARE_SAME_PERCENT}% 是人为定的（需求没给）`,
    COMPARE_SAME_PERCENT === 3 && identical.verdict.includes('人为定'),
    `阈值 ${COMPARE_SAME_PERCENT}%；结论里写明了它是人为定的`,
  );

  const bothNull = compareRuns(resultOf({ heapMB: null }), resultOf({ heapMB: null }));
  check(
    '两边 heapMB 都是 null 时不进 deltas（不把它当成 0）',
    bothNull.deltas.every((row) => row.key !== 'heapMB') && bothNull.deltas.every((row) => row.key !== 'gpuMB'),
    `对比了 ${bothNull.deltas.length} 项，跳过 ${COMPARE_TOTAL_ROWS - bothNull.deltas.length} 项`,
  );
  check(
    'null 的项在结论里被点名跳过（"没有数据"而不是 0）',
    bothNull.verdict.includes('跳过的项') && bothNull.verdict.includes('JS 堆用量'),
    bothNull.verdict,
  );

  const oneNull = compareRuns(resultOf({ heapMB: 120 }), resultOf({ heapMB: null }));
  check(
    '只有一边有内存数据时同样跳过（缺数据 ≠ 0）',
    oneNull.deltas.every((row) => row.key !== 'heapMB'),
    `堆用量：一边 120 MB、一边不可用 → 不比较`,
  );

  const zeroBase = compareRuns(resultOf({ fps: 0 }), resultOf({ fps: 10 }));
  const zeroRow = zeroBase.deltas.find((row) => row.key === 'fps');
  check(
    '基准为 0 时百分比是 null（不除零、不写 Infinity）',
    zeroRow !== undefined && zeroRow.percent === null && zeroRow.delta === 10,
    `from=${zeroRow?.from} to=${zeroRow?.to} percent=${String(zeroRow?.percent)}`,
  );

  const fpsRow = faster.deltas.find((row) => row.key === 'fps');
  check(
    'deltas 的差值与百分比算对了（30 → 40 = +10 = +33.3%）',
    fpsRow !== undefined && fpsRow.delta === 10 && Math.abs((fpsRow.percent ?? 0) - 100 / 3) < 1e-9,
    `delta=${fpsRow?.delta} percent=${fpsRow?.percent?.toFixed(2)}`,
  );

  const crossScene = compareRuns(resultOf({ fps: 30 }), resultOf({ fps: 40 }, { scene: sceneById('city_large') }));
  check(
    '两次不是同一个场景时结论明确说"没有可比性"',
    crossScene.verdict.includes('不是同一个场景'),
    crossScene.verdict,
  );

  const scaleShrunk = compareRuns(resultOf({ fps: 30, rigidBodies: 100 }), resultOf({ fps: 40, rigidBodies: 50 }));
  check(
    '规模变小导致的"变快"会被标注出来（免得被当成优化成果）',
    scaleShrunk.verdict.includes('规模也变了'),
    scaleShrunk.verdict,
  );

  check(
    'compareRuns 的每一项都能在同一个场景下正常产出（帧时间/阶段/规模都在表里）',
    faster.deltas.length >= 12 &&
      ['fps', 'minFps', 'frameMs', 'p95FrameMs', 'fluidMs', 'physicsMs', 'couplingMs', 'renderMs', 'rigidBodies'].every(
        (key) => faster.deltas.some((row) => row.key === key),
      ),
    `对比了 ${faster.deltas.length} 项`,
  );

  // ── 六、历史与导出 ────────────────────────────────────────
  // 历史从**空数组**开始，用 appendHistory 自己把"新的在前"这条不变量建立起来 ——
  // 手写一个 [1,2,3] 的数组会假设调用方已经维护好顺序，那正好把要测的东西绕过去了。
  const newest = resultOf({}, { timestamp: 4 });
  let history: StressTestResult[] = [];
  for (const stamp of [1, 2, 3]) history = appendHistory(history, resultOf({}, { timestamp: stamp }), 10);

  check(
    'appendHistory 反复追加后历史是「新的在前」（不变量）',
    history.length === 3 && history[0]?.timestamp === 3 && history[2]?.timestamp === 1,
    history.map((item) => item.timestamp).join(' → '),
  );

  const beforeHistory = JSON.stringify(history.map((item) => item.timestamp));
  const appended = appendHistory(history, newest, 3);
  check('appendHistory 只保留最近 N 次（limit=3）', appended.length === 3, `原 3 条 + 1 条 → 保留 ${appended.length} 条`);
  check(
    'appendHistory 的顺序是"新的在前"',
    appended[0]?.timestamp === 4 && appended[1]?.timestamp === 3 && appended[2]?.timestamp === 2,
    appended.map((item) => item.timestamp).join(' → '),
  );
  check(
    'appendHistory 是纯函数（原数组不改动）',
    history.length === 3 && JSON.stringify(history.map((item) => item.timestamp)) === beforeHistory && !history.includes(newest),
    `原数组仍是 ${beforeHistory}（长度 ${history.length}）`,
  );
  check('appendHistory 的 limit=0 返回空数组（"保留 0 条"就是 0 条）', appendHistory(history, newest, 0).length === 0);
  check(
    'appendHistory 对空历史可用，且默认上限是 20',
    appendHistory([], newest).length === 1 &&
      appendHistory(
        Array.from({ length: 30 }, (_unused, index) => resultOf({}, { timestamp: index })),
        newest,
      ).length === 20,
    '空历史 + 1 条 = 1 条；30 条历史 + 1 条 = 20 条',
  );

  const report = exportReport([slow, fast]);
  const parsed: unknown = JSON.parse(report);
  const envelope = parsed as { format?: unknown; version?: unknown; count?: unknown; results?: StressTestResult[] };
  check(
    'exportReport 的 JSON 能 parse 回来，且信封字段完整',
    envelope.format === STRESS_REPORT_FORMAT && envelope.version === STRESS_REPORT_VERSION && envelope.count === 2,
    `format=${String(envelope.format)} version=${String(envelope.version)} count=${String(envelope.count)}`,
  );
  check(
    '导出并读回之后，每条结果的字段与指标都还在',
    Array.isArray(envelope.results) &&
      envelope.results.length === 2 &&
      envelope.results[0]?.sceneId === slow.sceneId &&
      typeof envelope.results[0]?.metrics.fps === 'number' &&
      envelope.results[0]?.context['世界档'] === 'large' &&
      envelope.results[1]?.metrics.heapMB === null,
    `results[0].fps=${String(envelope.results?.[0]?.metrics.fps)}／results[1].heapMB=${String(envelope.results?.[1]?.metrics.heapMB)}`,
  );
  check(
    'null 的内存数据在 JSON 里仍然是 null（不会被写成 0）',
    envelope.results?.[0]?.metrics.heapMB === null && envelope.results?.[0]?.metrics.gpuMB === null,
  );

  let emptyOk = true;
  let emptyDetail = '';
  try {
    const emptyReport = JSON.parse(exportReport([])) as { count?: unknown; results?: unknown[] };
    emptyOk = emptyReport.count === 0 && Array.isArray(emptyReport.results) && emptyReport.results.length === 0;
    emptyDetail = `空报告 count=${String(emptyReport.count)}`;
    const emptyHistory = appendHistory([], newest, 5);
    emptyOk = emptyOk && emptyHistory.length === 1;
  } catch (error) {
    emptyOk = false;
    emptyDetail = `抛异常：${error instanceof Error ? error.message : String(error)}`;
  }
  check('空报告与空历史都不抛异常', emptyOk, emptyDetail);

  const line = describeResult(slow);
  check(
    'describeResult 是一行中文摘要，含场景名与 FPS',
    !line.includes('\n') && line.includes(slow.sceneName) && line.includes('FPS'),
    line,
  );
  check(
    'describeResult 对没有内存数据的样本显示"不可用"而不是 0',
    line.includes('堆 不可用') && line.includes('显存 不可用'),
    line,
  );

  const unknownScene = buildResult({
    scene: SYNTHETIC_SCENE,
    timestamp: 1,
    device: { isMobile: false, devicePixelRatio: 1, label: '合成' },
    durationMs: 1000,
    sampleFrames: 60,
    metrics: metricsOf({ fps: 60 }),
  });
  check(
    'describeResult 对不在场景表里的 id 显示目标"不可用"（不猜一个目标值）',
    describeResult(unknownScene).includes('目标 不可用'),
    describeResult(unknownScene),
  );
}
