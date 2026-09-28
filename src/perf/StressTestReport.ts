/**
 * 压力测试报告（M4 压力测试批次 · 纯逻辑 + 纯函数）。
 *
 * ────────────────────────────────────────────────────────────
 * 它回答的三个问题
 * ────────────────────────────────────────────────────────────
 * 1. **这次跑过了没有？** —— `buildResult()` + `StressTestResult.passed` / `.verdict`。
 *    通过标准是需求给的硬数字：「桌面 30 FPS+ / 移动端 15 FPS+」，目标值来自场景表
 *    （`StressTestScenes.ts` 的 `targetFps`），本模块**不自己定目标**。
 * 2. **两次运行差在哪？** —— `compareRuns()`：逐项差值 + 百分比 + 中文结论（变快/变慢/基本一样）。
 * 3. **历史上跑过几次？** —— `appendHistory()`：纯函数地往数组前面插一条、只留最近 N 次。
 *
 * ────────────────────────────────────────────────────────────
 * 两条"宁可标不可用，也不编造"的规矩
 * ────────────────────────────────────────────────────────────
 * 1. **拿不到的内存数据一律 `null`，绝不写 0**。
 *    JS 堆只在 Chromium 内核里有（`performance.memory`），Firefox / Safari 拿不到；
 *    真实显存占用浏览器**根本不暴露**（Three.js 也没有），`gpuMB` 只能是 null 或调用方给的粗估。
 *    0 会被读成"占用为 0"，那是错的 —— 与 `MemoryPanel` / `ResourceMonitor` 同一个口径：
 *    显示「不可用（非 Chromium 内核）」。
 * 2. **缺数据的项在对比里被"跳过"，而不是当成 0**。
 *    两次运行里只要有一边是 null，这一项就不进 `deltas`，并在结论里点名"这些项没有可比数据"。
 *    把 null 当 0 会算出"堆内存下降了 120 MB"这种完全虚构的结论。
 *
 * ────────────────────────────────────────────────────────────
 * 判定用的阈值：哪些是需求给的，哪些是我人为定的
 * ────────────────────────────────────────────────────────────
 * - **需求给的**：目标 FPS（桌面 30 / 移动 15）；物理单帧预算 5 ms
 *   （`physics/TimeControl.ts` 的 `DEFAULT_STEP_BUDGET_MS`，注释写着"用户给的验收线是物理求解耗时小于 5ms"）；
 *   流体单帧预算 4 ms（`fluid/FluidSystem.ts` 的 `budgetMs` 默认值，注释写着"需求里的目标"）。
 * - **人为定的**：`COMPARE_SAME_PERCENT = 3`（两次运行的 FPS 差小于 3% 算"基本一样"）。
 *   需求没给这个数，理由写在那个常量上。
 * - **没有阈值的**：`sandMs` 在本项目里**没有**写死的耗时验收线（只有单步活跃格预算 8000），
 *   所以沙子耗时只记录、不判定 —— 不替它编一个"应该小于 X ms"。
 *
 * 纯逻辑、零副作用：不 import three / Rapier / Engine，不读时钟（时间戳由调用方给）、
 * 不碰 localStorage（历史是数组，存哪由调用方决定），可以直接在 Node 里断言。
 */

import { phaseLabel } from './FrameProfiler';
import { getStressScene } from './StressTestScenes';
import { DEFAULT_STEP_BUDGET_MS } from '../physics/TimeControl';

export interface StressMetrics {
  /** 平均值 */
  fps: number;
  minFps: number;
  /** 帧时间中位数 */
  frameMs: number;
  p95FrameMs: number;
  fluidParticles: number;
  fluidMs: number;
  sandMs: number;
  sandActiveCells: number;
  physicsMs: number;
  couplingMs: number;
  renderMs: number;
  contactPairs: number;
  rigidBodies: number;
  /** 拿不到就是 null（如实） */
  heapMB: number | null;
  gpuMB: number | null;
}

export interface StressTestResult {
  sceneId: string;
  sceneName: string;
  /** 运行时刻（毫秒时间戳，由调用方给） */
  timestamp: number;
  /** 设备信息（调用方给：桌面/移动、像素比） */
  device: { isMobile: boolean; devicePixelRatio: number; label: string };
  /** 采样了多久（毫秒）与采样帧数 */
  durationMs: number;
  sampleFrames: number;
  metrics: StressMetrics;
  /** 环境说明（如实记录：窗口尺寸、渲染距离、粒子上限、画质档） */
  context: Record<string, string | number | boolean>;
  /** 结论：是否达到这个场景的目标 FPS */
  passed: boolean;
  /** 中文结论（含"哪些指标没达标"） */
  verdict: string;
}

/**
 * 建一条结果时对"场景"的最小要求。
 *
 * 刻意**比 `StressScene` 更宽**（`id` 是 `string` 而不是那 10 个 id 的联合）：
 * 报告要能容纳"场景表里已经删掉的旧场景"和"调用方临时合成的样本"，
 * 否则读一份旧报告都会变成类型错误。`StressScene` 天然满足这个接口，直接传即可；
 * 查不到的场景在 `describeResult` 里会如实显示目标"不可用"，而不是猜一个目标值。
 */
export interface StressSceneRef {
  id: string;
  name: string;
  targetFps: { desktop: number; mobile: number };
}

/** 建一条结果需要的入参。`scene` 只要 id / 名字 / 目标 FPS —— 直接用场景表里的对象即可 */
export interface StressResultInput {
  scene: StressSceneRef;
  timestamp: number;
  device: StressTestResult['device'];
  durationMs: number;
  sampleFrames: number;
  metrics: StressMetrics;
  /** 环境说明（窗口尺寸、渲染距离、上限、画质档…）。不传就是空对象，面板会显示"未记录" */
  context?: Record<string, string | number | boolean>;
}

/**
 * 对比两次运行时，"基本一样"的判定带宽（百分比）。
 *
 * ⚠ **这个 3% 是我人为定的，需求里没有**。定的理由：帧率测量本身就有噪声 ——
 * 同一个场景在同一台机器上连着跑两次，差 1~2% 是常态（GC、其它标签页、温度降频）。
 * 阈值取太小（比如 0.5%）会把噪声报告成"变快了"，那种结论比没有结论更糟。
 * 取 3% 是"明显超出噪声"的最小量级；改它就是改报告口径，改完的结论不能和历史比。
 */
export const COMPARE_SAME_PERCENT = 3;

/**
 * 单帧流体耗时预算（毫秒）。
 *
 * 来源：`fluid/FluidSystem.ts` 的 `budgetMs` 默认值（注释：「本帧最多给流体多少毫秒。
 * 默认 4 ms（需求里的目标）」）。超了不会掉帧率 —— FluidSystem 的做法是**跳过子步**，
 * 表现是"水在慢动作"，所以这条必须单独判：帧率好看不代表流体没被削。
 */
export const FLUID_BUDGET_MS = 4;

/** 单帧物理耗时预算（毫秒）。来源：`physics/TimeControl.ts` 的 `DEFAULT_STEP_BUDGET_MS` */
export const PHYSICS_BUDGET_MS = DEFAULT_STEP_BUDGET_MS;

/** 历史默认保留条数 */
export const DEFAULT_HISTORY_LIMIT = 20;

/** 报告文件的格式标记（导出的 JSON 第一层带它，便于以后区分版本） */
export const STRESS_REPORT_FORMAT = 'god-sandbox/stress-report';
/** 报告格式版本 */
export const STRESS_REPORT_VERSION = 1;

// ============================================================
// 造一条结果
// ============================================================

/**
 * 把一次运行的原始数据整理成一条结果（含通过判定与中文结论）。
 *
 * 三个刻意的决定：
 * 1. **`passed` 只回答"平均 FPS 有没有到目标"**，不掺别的条件。
 *    需求给的通过标准就是"桌面 30 FPS+ / 移动端 15 FPS+"；
 *    如果把"p95 超标""流体超预算"也塞进 passed，那么"通过了但其实在慢动作"这种
 *    真实存在的状态就会消失。所以别的指标一律进 `verdict` 的**告警**里，不参与判定。
 * 2. **采样 0 帧一律算不通过**。没有数据不能算通过 —— 那是"没测"，不是"测过了"。
 * 3. **非法数字兜底成 0**（NaN / Infinity / 负数）。理由与 `FrameProfiler.push` 一致：
 *    一个 NaN 会把整份 JSON 变成 null（`JSON.stringify(NaN)` 就是 null），
 *    报告坏掉比数字难看更严重。内存两项例外：非有限值就是 **null**，不是 0。
 */
export function buildResult(input: StressResultInput): StressTestResult {
  const metrics = sanitizeMetrics(input.metrics);
  const sampleFrames = nonNegativeInt(input.sampleFrames);
  const durationMs = nonNegative(input.durationMs);
  const isMobile = input.device.isMobile;
  const targetFps = isMobile ? input.scene.targetFps.mobile : input.scene.targetFps.desktop;

  const { failed, warnings } = evaluate(metrics, targetFps, sampleFrames);
  const passed = failed.length === 0;

  return {
    sceneId: input.scene.id,
    sceneName: input.scene.name,
    // 时间戳非法时记 0（报告里能一眼看出"没记时刻"），**不**偷偷用 Date.now() 顶上 ——
    // 那会让同一个结果每次导出的内容都不一样，diff 与断言都没法比对。
    timestamp: nonNegative(input.timestamp),
    device: {
      isMobile,
      devicePixelRatio: positive(input.device.devicePixelRatio, 1),
      label: input.device.label,
    },
    durationMs,
    sampleFrames,
    metrics,
    context: input.context ? { ...input.context } : {},
    passed,
    verdict: buildVerdict({
      sceneName: input.scene.name,
      isMobile,
      deviceLabel: input.device.label,
      metrics,
      targetFps,
      passed,
      failed,
      warnings,
      sampleFrames,
      durationMs,
    }),
  };
}

/** 一项判定结果：`failed` 决定通过与否，`warnings` 只写进结论 */
interface Evaluation {
  failed: string[];
  warnings: string[];
}

/**
 * 逐项判定。**只有 FPS 与"有没有采到帧"两条能判"不通过"**（见 buildResult 的注释），
 * 其余都是告警；沙的耗时连告警都没有 —— 本项目没给它定验收线（见文件头）。
 */
function evaluate(metrics: StressMetrics, targetFps: number, sampleFrames: number): Evaluation {
  const failed: string[] = [];
  const warnings: string[] = [];
  const budgetMs = targetFps > 0 ? 1000 / targetFps : 0;

  if (sampleFrames <= 0) {
    failed.push('没有采到任何帧（sampleFrames = 0），这次运行不能算通过');
  }
  if (metrics.fps < targetFps) {
    failed.push(`平均 FPS 未达标（实测 ${fixed(metrics.fps, 1)}，目标 ${targetFps}）`);
  }

  // ── 以下是告警（不影响 passed）──────────────────────────
  if (budgetMs > 0 && metrics.p95FrameMs > budgetMs) {
    warnings.push(
      `p95 帧时间 ${fixed(metrics.p95FrameMs, 1)} ms 超过目标帧时长 ${fixed(budgetMs, 1)} ms —— ` +
        `平均值掩盖了尖峰，手感比 FPS 数字更差`,
    );
  }
  if (metrics.fps >= targetFps && metrics.minFps < targetFps) {
    warnings.push(`最低 FPS ${fixed(metrics.minFps, 1)} 低于目标 ${targetFps}：平均达标但过程中有掉帧`);
  }

  // 阶段合计：用 phaseLabel 取中文名，避免这里再抄一遍阶段名对照表。
  // 流体与沙在本项目里都上报在 'sim' 阶段（见 PHASE_LABELS），所以合成一项。
  const phases: { name: string; ms: number }[] = [
    { name: phaseLabel('sim'), ms: metrics.fluidMs + metrics.sandMs },
    { name: phaseLabel('physics'), ms: metrics.physicsMs },
    { name: phaseLabel('coupling'), ms: metrics.couplingMs },
    { name: phaseLabel('render'), ms: metrics.renderMs },
  ];
  const phaseSum = phases.reduce((sum, item) => sum + item.ms, 0);
  if (budgetMs > 0 && phaseSum > budgetMs) {
    const worst = phases.reduce((a, b) => (b.ms > a.ms ? b : a));
    warnings.push(
      `已上报的阶段合计 ${fixed(phaseSum, 1)} ms 超过目标帧时长 ${fixed(budgetMs, 1)} ms` +
        `（最重的是${worst.name} ${fixed(worst.ms, 1)} ms）`,
    );
  }
  if (metrics.fluidMs > FLUID_BUDGET_MS) {
    warnings.push(
      `${phaseLabel('sim')}里的流体 ${fixed(metrics.fluidMs, 1)} ms 超过单帧流体预算 ${FLUID_BUDGET_MS} ms —— ` +
        `超了 FluidSystem 会跳过子步，画面是"水在慢动作"，光看帧率发现不了`,
    );
  }
  if (metrics.physicsMs > PHYSICS_BUDGET_MS) {
    warnings.push(
      `${phaseLabel('physics')} ${fixed(metrics.physicsMs, 1)} ms 超过单帧物理预算 ${PHYSICS_BUDGET_MS} ms（TimeControl 的验收线）`,
    );
  }

  return { failed, warnings };
}

/** 中文结论：先说通过与否，再点名没达标的项，最后才是告警 —— 顺序就是重要程度 */
function buildVerdict(args: {
  sceneName: string;
  isMobile: boolean;
  deviceLabel: string;
  metrics: StressMetrics;
  targetFps: number;
  passed: boolean;
  failed: string[];
  warnings: string[];
  sampleFrames: number;
  durationMs: number;
}): string {
  const device = `${args.isMobile ? '移动端' : '桌面'}（${args.deviceLabel}）`;
  const head =
    `${args.sceneName}：${device} 平均 ${fixed(args.metrics.fps, 1)} FPS（目标 ${args.targetFps}）→ ` +
    `${args.passed ? '通过' : '未通过'}。`;
  // "未达标"后面必须点名具体项；只有 FPS 与采样两条会出现在这里
  const body =
    args.failed.length > 0
      ? `未达标：${args.failed.join('；')}。`
      : `平均 FPS 已达标${args.metrics.heapMB === null ? '（内存数据本次不可用，未参与判定）' : ''}。`;
  const warn = args.warnings.length > 0 ? `其它告警（不影响"通过"判定）：${args.warnings.join('；')}。` : '';
  const sample = `采样 ${args.sampleFrames} 帧 / ${fixed(args.durationMs / 1000, 1)} 秒。`;
  return head + body + warn + sample;
}

// ============================================================
// 导出
// ============================================================

/**
 * 导出成 JSON 字符串（面板的"复制报告"按钮用）。
 *
 * 为什么要信封（format / version / count / results）而不是直接吐一个数组：
 * 报告是要被贴进问题反馈、甚至被别的脚本读的，第一层就得能看出"这是什么、哪个版本"。
 *
 * ⚠ 报告里**没有"导出时刻"**：那会让同一批结果每导一次都不一样（diff、断言全部失效）。
 * 真需要时刻，由调用方写进每条结果的 `timestamp` 或 `context` 里。
 */
export function exportReport(results: readonly StressTestResult[]): string {
  return JSON.stringify(
    {
      format: STRESS_REPORT_FORMAT,
      version: STRESS_REPORT_VERSION,
      count: results.length,
      results,
    },
    null,
    2,
  );
}

// ============================================================
// 对比
// ============================================================

/** 对比表的一行 */
export interface DeltaRow {
  key: string;
  label: string;
  from: number;
  to: number;
  delta: number;
  /** 百分比；基准是 0 时算不出来 → null（不是 0，也不是 Infinity） */
  percent: number | null;
}

/**
 * 要对比的指标表。顺序 = 面板上的显示顺序（帧率在前，规模在后）。
 * 方向（越高越好 / 越低越好）直接写进 label，不额外加字段 —— 免得出现
 * "有字段但没人读"的摆设。
 */
const COMPARE_ROWS: readonly { key: keyof StressMetrics; label: string }[] = [
  { key: 'fps', label: '平均 FPS（越高越好）' },
  { key: 'minFps', label: '最低 FPS（越高越好）' },
  { key: 'frameMs', label: '帧时间中位数（毫秒，越低越好）' },
  { key: 'p95FrameMs', label: 'p95 帧时间（毫秒，越低越好）' },
  { key: 'fluidMs', label: '流体耗时（毫秒，越低越好）' },
  { key: 'sandMs', label: '沙耗时（毫秒，越低越好）' },
  { key: 'physicsMs', label: '物理求解耗时（毫秒，越低越好）' },
  { key: 'couplingMs', label: '流体耦合耗时（毫秒，越低越好）' },
  { key: 'renderMs', label: '渲染提交耗时（毫秒，越低越好）' },
  { key: 'fluidParticles', label: '流体粒子数（规模，两边不同就不可比）' },
  { key: 'sandActiveCells', label: '沙活跃格数（规模，两边不同就不可比）' },
  { key: 'contactPairs', label: '接触对数（规模）' },
  { key: 'rigidBodies', label: '刚体数（规模）' },
  { key: 'heapMB', label: 'JS 堆用量（MB，越低越好）' },
  { key: 'gpuMB', label: '显存用量（MB，越低越好）' },
];

/**
 * 对比两次运行（`a` = 基准/上次，`b` = 这次）。
 *
 * 判定只看**平均 FPS**：它的百分比差
 * - `> +${COMPARE_SAME_PERCENT}%` → 「变快」
 * - `< -${COMPARE_SAME_PERCENT}%` → 「变慢」
 * - 其余 → 「基本一样」（阈值是人为定的，理由见 `COMPARE_SAME_PERCENT`）
 *
 * ⚠ 两边不是同一个场景时，差值**没有意义**（粒子数都不一样），结论里会明确写出来。
 * 同理，规模类指标（粒子数/格数/刚体数）不一样的话，"变快"可能只是因为东西变少了 ——
 * 这一点也写进结论，免得被当成优化成果。
 */
export function compareRuns(
  a: StressTestResult,
  b: StressTestResult,
): { deltas: DeltaRow[]; verdict: string } {
  const deltas: DeltaRow[] = [];
  const skipped: string[] = [];

  for (const row of COMPARE_ROWS) {
    const from = a.metrics[row.key];
    const to = b.metrics[row.key];
    // 缺数据（null）或不是有限数：跳过，**不当成 0**。
    // 把 null 当 0 会得出"堆内存下降了 120 MB"这种凭空捏造的结论。
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to)) {
      skipped.push(row.label);
      continue;
    }
    const delta = to - from;
    deltas.push({
      key: row.key,
      label: row.label,
      from,
      to,
      delta,
      // 基准是 0 时百分比没有定义（除零），如实给 null 而不是 0 或 Infinity
      percent: from !== 0 ? (delta / from) * 100 : null,
    });
  }

  const fpsRow = deltas.find((row) => row.key === 'fps');
  const words: string[] = [];

  if (!fpsRow || fpsRow.percent === null) {
    words.push(
      fpsRow
        ? `平均 FPS 基准是 ${fixed(fpsRow.from, 1)}（0 或缺失），算不出百分比：无法判断快慢`
        : '两次结果里没有可比的平均 FPS 数据：无法判断快慢',
    );
  } else {
    const sign = fpsRow.percent >= 0 ? '+' : '';
    const verdictWord =
      fpsRow.percent > COMPARE_SAME_PERCENT ? '变快' : fpsRow.percent < -COMPARE_SAME_PERCENT ? '变慢' : '基本一样';
    words.push(
      `平均 FPS ${fixed(fpsRow.from, 1)} → ${fixed(fpsRow.to, 1)}` +
        `（${sign}${fixed(fpsRow.percent, 1)}%）：${verdictWord}`,
    );
  }

  words.push(
    `判定阈值 ±${COMPARE_SAME_PERCENT}% 是**人为定**的：帧率本身有噪声（同机两次运行差 1~2% 很常见），` +
      `阈值太小会把噪声说成"变快/变慢"`,
  );

  if (a.sceneId !== b.sceneId) {
    words.push(`⚠ 两次运行不是同一个场景（${a.sceneId} vs ${b.sceneId}），上面的差值没有可比性`);
  }
  const scaleChanged = deltas.filter(
    (row) =>
      (row.key === 'fluidParticles' || row.key === 'sandActiveCells' || row.key === 'rigidBodies') && row.delta !== 0,
  );
  if (scaleChanged.length > 0) {
    words.push(
      `⚠ 规模也变了（${scaleChanged.map((row) => `${row.label.split('（')[0]} ${fixed(row.from, 0)} → ${fixed(row.to, 0)}`).join('、')}）：` +
        `"变快"可能只是因为东西变少了，不是优化`,
    );
  }
  if (skipped.length > 0) {
    // 如实标注跳过的项：它们不是 0，是"没有数据"
    words.push(`跳过的项（没有可比数据，**不当作 0**）：${skipped.join('、')}`);
  }

  return { deltas, verdict: words.join('。') };
}

// ============================================================
// 展示与历史
// ============================================================

/**
 * 一行中文摘要（历史列表用）。
 *
 * 目标 FPS 是按 `sceneId` 回查场景表现算的：结果对象里**不存**目标值，
 * 存了就会出现"场景表改了目标、历史里的旧结果还写着旧目标"这种对不上的情况。
 * 回查不到（例如历史来自旧版本、或调用方给的是合成样本）就写「不可用」，不猜一个数。
 */
export function describeResult(result: StressTestResult): string {
  const scene = getStressScene(result.sceneId);
  const target = scene ? (result.device.isMobile ? scene.targetFps.mobile : scene.targetFps.desktop) : null;
  const m = result.metrics;
  const device = `${result.device.isMobile ? '移动端' : '桌面'} 像素比 ${fixed(result.device.devicePixelRatio, 2)}`;
  return (
    `${result.sceneName}｜${device}｜平均 ${fixed(m.fps, 1)} / 最低 ${fixed(m.minFps, 1)} FPS` +
    `（目标 ${target === null ? '不可用' : String(target)}）→ ${result.passed ? '通过' : '未通过'}` +
    `｜中位 ${fixed(m.frameMs, 1)} ms / p95 ${fixed(m.p95FrameMs, 1)} ms` +
    `｜流体 ${m.fluidParticles} 粒子 ${fixed(m.fluidMs, 1)} ms` +
    `｜沙 ${m.sandActiveCells} 格 ${fixed(m.sandMs, 1)} ms` +
    `｜${phaseLabel('physics')} ${fixed(m.physicsMs, 1)} ms` +
    `｜${phaseLabel('coupling')} ${fixed(m.couplingMs, 1)} ms` +
    `｜${phaseLabel('render')} ${fixed(m.renderMs, 1)} ms` +
    `｜刚体 ${m.rigidBodies} / 接触对 ${m.contactPairs}` +
    `｜堆 ${memoryText(m.heapMB)}｜显存 ${memoryText(m.gpuMB)}`
  );
}

/**
 * 往历史里追加一条，只保留最近 `limit` 条，**新的在前**。
 *
 * - **纯函数**：返回新数组，调用方给的数组一个字节都不改（`[result, ...history]` 是拷贝）。
 *   （元素本身是共享引用 —— 结果对象按约定当只读用，要改请自己先拷。）
 * - 新的在前与 `SlowFrameLogger.recentCollapses` 的口径一致：面板都是"最近的先看"。
 * - 存到哪由调用方决定（本模块**不碰** localStorage，那样就没法在 Node 里断言了）。
 * - `limit` 为 0 就返回空数组（"保留最近 0 条"就是 0 条）；非法值退回默认 20。
 */
export function appendHistory(
  history: readonly StressTestResult[],
  result: StressTestResult,
  limit: number = DEFAULT_HISTORY_LIMIT,
): StressTestResult[] {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_HISTORY_LIMIT;
  if (cap === 0) return [];
  return [result, ...history].slice(0, cap);
}

// ============================================================
// 小工具
// ============================================================

/** 有限正数 → 原值；其它（NaN / Infinity / 0 / 负数）→ 兜底值 */
function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 有限非负数 → 原值；其它 → 0 */
function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 非负整数（帧数这类） */
function nonNegativeInt(value: number): number {
  return Math.floor(nonNegative(value));
}

/** 把整套指标里的非法数字兜成 0（内存两项兜成 null）——见 buildResult 的第 3 条注释 */
function sanitizeMetrics(m: StressMetrics): StressMetrics {
  return {
    fps: nonNegative(m.fps),
    minFps: nonNegative(m.minFps),
    frameMs: nonNegative(m.frameMs),
    p95FrameMs: nonNegative(m.p95FrameMs),
    fluidParticles: nonNegativeInt(m.fluidParticles),
    fluidMs: nonNegative(m.fluidMs),
    sandMs: nonNegative(m.sandMs),
    sandActiveCells: nonNegativeInt(m.sandActiveCells),
    physicsMs: nonNegative(m.physicsMs),
    couplingMs: nonNegative(m.couplingMs),
    renderMs: nonNegative(m.renderMs),
    contactPairs: nonNegativeInt(m.contactPairs),
    rigidBodies: nonNegativeInt(m.rigidBodies),
    heapMB: positiveMB(m.heapMB),
    gpuMB: positiveMB(m.gpuMB),
  };
}

/** 内存类指标：拿不到就是 null，**不是 0**（0 会被读成"占用为 0"） */
function positiveMB(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** 内存显示：null 显示"不可用"，不显示 0（与 MemoryPanel 同一个口径） */
function memoryText(value: number | null): string {
  return value === null ? '不可用' : `${fixed(value, 1)} MB`;
}

/** 定小数位（避免 0.30000000000000004 这种浮点尾巴出现在报告里） */
function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '不可用';
}
