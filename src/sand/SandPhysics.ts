/**
 * 沙土物理的纯逻辑层（M4 第二部分 · 第 3 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 这一层为什么单独拆出来
 * ────────────────────────────────────────────────────────────
 * "沙"这件事里真正需要被验证的只有几个数：**湿度 → 安息角 → 滑动距离**。
 * 把它们放在纯函数里，就能在 Node 里精确断言"干沙 34°、湿沙 45°、饱和沙 15°"
 * 这三个锚点，而不必跑一堆体素模拟去"看现象"。
 * 体素那一层（SandSystem）只负责"按这些数去搬格子"。
 *
 * ────────────────────────────────────────────────────────────
 * 安息角的三档与它们之间的插值
 * ────────────────────────────────────────────────────────────
 * 需求给的是三个锚点：
 *
 * | 状态 | 湿度 | 安息角 | 现实里的表现 |
 * |---|---|---|---|
 * | 干沙 | 0 | 34° | 沙堆陡、会滑但不黏 |
 * | 湿沙 | 0.5 | 45° | 能捏成型、堆得最陡（水的毛细作用把颗粒粘住） |
 * | 饱和沙 | 1 | 15° | 一碰就塌、像液体一样流（泥流） |
 *
 * 中间用**分段线性**插值。为什么不是一条曲线：这三个点是实测出来的经验值，
 * 中间过程没有任何可信数据 —— 编一条曲线只会让"看起来更科学"，而实际不可验证。
 * 分段线性至少保证"三个锚点精确命中"，这也是断言里钉住的东西。
 *
 * ⚠ **饱和沙 15° 比干沙 34° 还低**，这一点反直觉但确实如此：
 * 加水到饱和会**降低**内摩擦角（孔隙水压把颗粒推开），这也是泥石流的成因。
 * 湿沙 45° 是"加了水但还没饱和"的中间状态（毛细负压最强的时候）。
 * 所以曲线不是单调的：0 → 34°，0.5 → 45°，1 → 15° 是一个"先升后降"的峰。
 *
 * ────────────────────────────────────────────────────────────
 * 离散近似：角度 → 滑动距离
 * ────────────────────────────────────────────────────────────
 * 体素里"一格横一格竖"只能表达 45°。要更缓的角度，就得让沙在"边缘外还有两格空"
 * 时才滑。这个"前瞻格数"由 `1/tan(角度)` 决定：
 *
 * - 45° → 1.00 格（经典落沙）
 * - 34° → 1.48 格（在 1 格与 2 格之间按概率混合）
 * - 15° → 3.73 格（几乎全用 4 格前瞻 → 铺得很平）
 *
 * **这是离散近似**：长期统计出来的堆角会落在设定值附近，但每一格只有
 * "1 格 / 2 格 / …" 这几档可选。所以它做不到"精确 37.5°"。
 * 这条写进 README 的取舍清单，不要把它当成连续的角度控制。
 */

/** 沙的状态（面板与可视化用） */
export type SandState = 'dry' | 'wet' | 'saturated';

/** 安息角锚点（度）。这三个数是需求给的，也是断言的锚点 —— 不许随手改 */
export const REPOSE_ANCHORS = {
  /** 干沙 */
  dry: 34,
  /** 湿沙（毛细作用把颗粒粘住，堆得最陡） */
  wet: 45,
  /** 饱和沙（孔隙水压把颗粒推开，近似泥流） */
  saturated: 15,
} as const;

/** 湿度分界：0~WET 是干湿之间，WET~1 是湿到饱和 */
export const MOISTURE_WET = 0.5;
/** 判定为"饱和"的最小湿度（也是泥流的门槛） */
export const MOISTURE_SATURATED = 0.85;

/**
 * 湿度 → 安息角（度）。
 *
 * 分段线性，**三个锚点精确命中**（`reposeAngleFor(0) === 34` 等）。
 */
export function reposeAngleFor(moisture: number): number {
  const m = clamp01(moisture);
  if (m <= MOISTURE_WET) {
    // 干 → 湿：34° 升到 45°
    return lerp(REPOSE_ANCHORS.dry, REPOSE_ANCHORS.wet, m / MOISTURE_WET);
  }
  // 湿 → 饱和：45° 掉到 15°
  return lerp(REPOSE_ANCHORS.wet, REPOSE_ANCHORS.saturated, (m - MOISTURE_WET) / (1 - MOISTURE_WET));
}

/** 安息角 → 滑动"前瞻距离"（格）。= 1 / tan(角度)，夹在 [1, 4] */
export function slideDistanceFor(angleDeg: number): number {
  const angle = Math.max(5, Math.min(89, angleDeg));
  const tan = Math.tan((angle * Math.PI) / 180);
  if (!(tan > 1e-6)) return 4;
  return Math.max(1, Math.min(4, 1 / tan));
}

/** 湿度 → 滑动前瞻距离（把上面两步合起来，最常用的入口） */
export function slideDistanceForMoisture(moisture: number): number {
  return slideDistanceFor(reposeAngleFor(moisture));
}

/** 湿度落在哪一档（面板显示、可视化着色都用它） */
export function sandStateOf(moisture: number): SandState {
  const m = clamp01(moisture);
  if (m >= MOISTURE_SATURATED) return 'saturated';
  if (m >= MOISTURE_WET * 0.5) return 'wet';
  return 'dry';
}

export const SAND_STATE_LABELS: Record<SandState, string> = {
  dry: '干沙',
  wet: '湿沙',
  saturated: '饱和沙（泥流）',
};

/**
 * 稳定性（0~1）：这一格沙"还能不能撑住上面的沙"。
 *
 * 用途有两个：
 * 1. **可视化**：把不稳的格子标出来（沙崩前的征兆）；
 * 2. **压塌脆弱结构**（第 5 批）：一堆沙压在建筑上时，用它决定要不要压塌。
 *
 * ⚠ 这不是有限元，是**启发式**：`稳定性 = f(湿度, 上方载荷, 坡度)`。
 * 权重是调出来的，不是标定的。README 里如实写了"压塌阈值是启发式"。
 * 返回 1 表示"很稳"，0 表示"马上要塌"。
 */
export function stabilityOf(options: {
  /** 湿度 0~1 */
  moisture: number;
  /** 上方压着多少格沙（载荷） */
  load: number;
  /** 当前坡度（度，0 = 平） */
  slope: number;
}): number {
  const angle = reposeAngleFor(options.moisture);
  // 坡度超过安息角的多少：超过越多越不稳
  const overAngle = Math.max(0, options.slope - angle);
  const slopePenalty = Math.min(1, overAngle / 30);
  // 载荷：上方每多一格就多扣一点，8 格扣满
  const loadPenalty = Math.min(1, options.load / 8);
  // 湿沙更抗压（45° 那档最稳），饱和沙最不稳
  const moistureFactor = options.moisture >= MOISTURE_SATURATED ? 0.6 : 1 - Math.abs(options.moisture - MOISTURE_WET) * 0.4;
  const raw = 1 - Math.max(slopePenalty, loadPenalty * 0.8);
  return clamp01(raw * moistureFactor);
}

/**
 * 一格沙吸收水之后的湿度变化。
 *
 * @param moisture 当前湿度
 * @param neighborsWithWater 上下左右前后里"有水"的邻居数（0~6）
 * @param rate 吸水速率（每秒）
 * @param dt 时间步（秒）
 */
export function absorbMoisture(moisture: number, neighborsWithWater: number, rate: number, dt: number): number {
  if (neighborsWithWater <= 0) return clamp01(moisture);
  // 邻居越多吸得越快，但**不是线性 6 倍**：一个面接触到水就已经很快了，
  // 再多的面只加快一点（用 sqrt 压一下曲线）
  const factor = Math.sqrt(Math.min(6, neighborsWithWater) / 6);
  return clamp01(moisture + rate * factor * dt);
}

/**
 * 干燥：湿度随时间回落。
 *
 * 为什么湿沙要会干：玩家把沙弄湿之后，如果永远保持湿（45° 堆得笔直），
 * 那"湿沙"就变成了一个不可逆的"加固"操作，而不是一个状态。
 * 干燥速率取得很慢（默认 0.02/秒 → 从饱和到全干要 50 秒），
 * 这样玩家有足够时间利用它，但又不会永久改变地形。
 */
export function dryMoisture(moisture: number, rate: number, dt: number): number {
  return clamp01(moisture - rate * dt);
}

/** 沙的编辑工具 */
export type SandTool = 'pile' | 'dig' | 'wet' | 'dry' | 'solidify';

export const SAND_TOOL_LABELS: Record<SandTool, string> = {
  pile: '⛰ 堆沙',
  dig: '⛏ 挖沙',
  wet: '💧 湿沙',
  dry: '☀️ 干沙',
  solidify: '🪨 凝固',
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
