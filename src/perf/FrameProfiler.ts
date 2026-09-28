/**
 * 帧时间分析（src/perf 模块 1/5）。
 *
 * ────────────────────────────────────────────────────────────
 * 它解决的是什么问题
 * ────────────────────────────────────────────────────────────
 * 原来的性能面板只显示"上一帧多少毫秒"和瞬时 FPS。但玩家说"卡"的时候，
 * 真正难受的往往是**尖峰**而不是平均值：平均 16 ms、每 10 帧却来一次 40 ms，
 * 手感就是一顿一顿的，可平均值看上去完全正常。
 *
 * 这个模块把最近 N 帧的耗时环形留存下来，给出分布 / 分位数 / 尖峰定位 / 阶段拆解，
 * 让"到底哪里慢、慢在什么时候"变成可以直接看的数字。
 *
 * ────────────────────────────────────────────────────────────
 * 三个刻意的设计
 * ────────────────────────────────────────────────────────────
 * 1. **环形缓冲用「定长数组 + 写指针」**，不用 `Array.shift()`。
 *    shift 会把后面所有元素往前搬，是 O(n) 的；每帧调一次等于白送一次数组拷贝，
 *    而这个模块存在的意义恰恰是"别给它自己增加开销"。
 *
 * 2. **stats / histogram / phaseBreakdown 每次调用都重算**，不维护增量状态。
 *    窗口只有 120 帧，重算一遍是微秒级；而增量状态在 clear()、窗口回绕、
 *    阶段名动态出现（"地形重建"只在某些帧有、物理只在有刚体时有）时极易算错。
 *    面板上显示一个错的数字，比慢一点更糟。
 *
 * 3. **分位数用「排序后取下标」的朴素做法**，不做线性插值。
 *    插值在样本只有几十上百个时给的是"看起来更精确"的假象——120 帧的分布
 *    本来就不支撑小数位。窗口小，排序的代价可以忽略，代码却少一半。
 *
 * 纯逻辑、零依赖：不 import three / Rapier / Engine，可以直接在 Node 里断言。
 */

export interface FrameSample {
  /** 帧序号 */
  index: number;
  /** 帧耗时（毫秒） */
  ms: number;
  /** 这一帧各阶段的耗时（可选，阶段名 → 毫秒） */
  phases?: Record<string, number>;
  /** 这一帧发生在什么场景（例如 'idle' | 'editing' | 'generating'），用于归类 */
  context?: string;
}

export interface FrameStats {
  /** 采样窗口内的帧数 */
  count: number;
  /** 平均帧耗时 */
  average: number;
  /** 中位数（比平均更能反映"平时的手感"） */
  median: number;
  /** p95 / p99 —— 尖峰比平均更值得优化 */
  p95: number;
  p99: number;
  /** 最大帧耗时 */
  max: number;
  /** 折算的 FPS（1000 / average） */
  fps: number;
  /** 超过预算的帧数与占比 */
  slowFrames: number;
  slowRatio: number;
  /** 预算（毫秒），默认 16.7 */
  budgetMs: number;
}

export interface FrameProfilerOptions {
  /** 环形窗口大小，默认 120（约 2 秒 @60FPS） */
  windowSize?: number;
  /** 慢帧阈值，默认 16.7 */
  budgetMs?: number;
}

/** 默认窗口：120 帧 ≈ 2 秒 @60FPS，够看出周期性的尖峰，又不至于把近期变化糊掉 */
const DEFAULT_WINDOW_SIZE = 120;
/** 默认预算：60 FPS 的一帧时长 */
const DEFAULT_BUDGET_MS = 16.7;
/** 直方图默认分几桶 */
const DEFAULT_HISTOGRAM_BUCKETS = 10;
/** 没有 context 的帧在按场景聚合时归到这一档（宁可显示"未标注"，也不假装它是 idle） */
const NO_CONTEXT = '(未标注)';

export class FrameProfiler {
  private readonly windowSizeValue: number;
  private readonly budgetMsValue: number;

  // ── 环形缓冲：四组定长数组 + 一个写指针 ─────────────────────────
  /** 帧耗时 */
  private readonly msRing: number[];
  /** 帧序号 */
  private readonly indexRing: number[];
  /** 阶段耗时（保存调用方给的引用；仅在 slowest() 里拷一份返回，避免被外部改坏） */
  private readonly phaseRing: (Record<string, number> | undefined)[];
  /** 场景标记 */
  private readonly contextRing: (string | undefined)[];
  /**
   * 帧的到达时间戳（调用方传入的 nowMs）。
   * 它的用途只有一个：算出**统计窗口覆盖的真实时长**（describe 里会写出来）。
   * 帧耗时会因为浏览器节流/后台标签而失真，真实时长能让人一眼看出"这段统计其实横跨了 8 秒"。
   */
  private readonly atRing: number[];
  /** 下一次写入的位置 */
  private head = 0;
  /** 当前窗口内的帧数（≤ windowSize） */
  private count = 0;
  /** 累计推入过的帧数（不因回绕而清零，可作为"第几帧"的稳定序号来源之外的计数） */
  private pushed = 0;

  constructor(options: FrameProfilerOptions = {}) {
    this.windowSizeValue = Math.max(1, Math.floor(options.windowSize ?? DEFAULT_WINDOW_SIZE));
    this.budgetMsValue = options.budgetMs && options.budgetMs > 0 ? options.budgetMs : DEFAULT_BUDGET_MS;
    const size = this.windowSizeValue;
    this.msRing = new Array<number>(size).fill(0);
    this.indexRing = new Array<number>(size).fill(0);
    this.phaseRing = new Array<Record<string, number> | undefined>(size).fill(undefined);
    this.contextRing = new Array<string | undefined>(size).fill(undefined);
    this.atRing = new Array<number>(size).fill(0);
  }

  /** 窗口大小（最多保留多少帧） */
  get windowSize(): number {
    return this.windowSizeValue;
  }

  /** 预算（毫秒） */
  get budgetMs(): number {
    return this.budgetMsValue;
  }

  /** 当前窗口里已经有几帧 */
  get size(): number {
    return this.count;
  }

  /**
   * 记一帧。
   *
   * 容错：非有限值或负数的 ms 一律按 0 记，而不是让它污染 median / p95（NaN 会让排序结果整个乱掉）。
   * 面板宁可显示"这一帧是 0 ms"，也不该显示一片 NaN。
   */
  push(ms: number, phases?: Record<string, number>, context?: string, nowMs?: number): void {
    const slot = this.head;
    this.msRing[slot] = Number.isFinite(ms) && ms > 0 ? ms : 0;
    this.indexRing[slot] = this.pushed;
    this.phaseRing[slot] = phases;
    this.contextRing[slot] = context;
    this.atRing[slot] = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : fallbackNow();

    this.head = (this.head + 1) % this.windowSizeValue;
    if (this.count < this.windowSizeValue) this.count += 1;
    this.pushed += 1;
  }

  /**
   * 第 k 个样本（0 = 窗口内最旧）对应的缓冲槽位。
   * 回绕规则：窗口没填满时最旧的就是下标 0；填满后最旧的是写指针指向的那一格。
   */
  private slotAt(k: number): number {
    const start = this.count < this.windowSizeValue ? 0 : this.head;
    return (start + k) % this.windowSizeValue;
  }

  /** 当前窗口的统计（每次调用重算；窗口小，开销可忽略） */
  get stats(): FrameStats {
    const count = this.count;
    if (count === 0) {
      return {
        count: 0,
        average: 0,
        median: 0,
        p95: 0,
        p99: 0,
        max: 0,
        fps: 0,
        slowFrames: 0,
        slowRatio: 0,
        budgetMs: this.budgetMsValue,
      };
    }

    const sorted = new Array<number>(count);
    let sum = 0;
    let max = 0;
    let slowFrames = 0;
    for (let k = 0; k < count; k += 1) {
      const ms = this.msRing[this.slotAt(k)]!;
      sorted[k] = ms;
      sum += ms;
      if (ms > max) max = ms;
      if (ms > this.budgetMsValue) slowFrames += 1;
    }
    sorted.sort((a, b) => a - b);

    const average = sum / count;
    return {
      count,
      average,
      median: pick(sorted, 0.5),
      p95: pick(sorted, 0.95),
      p99: pick(sorted, 0.99),
      max,
      fps: average > 0 ? 1000 / average : 0,
      slowFrames,
      slowRatio: slowFrames / count,
      budgetMs: this.budgetMsValue,
    };
  }

  /** 最近 N 帧的耗时（画分布图用），按时间顺序 */
  recent(count = this.count): number[] {
    const wanted = Math.max(0, Math.min(Math.floor(count), this.count));
    const start = this.count - wanted;
    const out: number[] = new Array<number>(wanted);
    for (let i = 0; i < wanted; i += 1) out[i] = this.msRing[this.slotAt(start + i)]!;
    return out;
  }

  /**
   * 分布直方图：把耗时分成若干桶，返回每桶的帧数与范围。
   *
   * 桶的上界取 `max(窗口内最大耗时, 预算)`：
   * - 用预算兜底，保证「所有帧都是 0 ms」时桶宽也不会是 0（除零会把所有帧挤进第 0 桶还显示错范围）；
   * - 上界取最大耗时，保证**每一帧都落在某个桶里**，桶计数之和必然等于 count。
   */
  histogram(buckets = DEFAULT_HISTOGRAM_BUCKETS): { from: number; to: number; count: number }[] {
    const n = Math.max(1, Math.floor(buckets));
    const out: { from: number; to: number; count: number }[] = new Array(n);
    let upper = this.budgetMsValue;
    for (let k = 0; k < this.count; k += 1) {
      const ms = this.msRing[this.slotAt(k)]!;
      if (ms > upper) upper = ms;
    }
    const width = upper / n;
    for (let i = 0; i < n; i += 1) out[i] = { from: i * width, to: (i + 1) * width, count: 0 };
    for (let k = 0; k < this.count; k += 1) {
      const ms = this.msRing[this.slotAt(k)]!;
      const index = Math.min(n - 1, Math.max(0, Math.floor(ms / width)));
      out[index]!.count += 1;
    }
    return out;
  }

  /** 找出窗口内最慢的几帧（含它们的 phases，用来定位是谁慢） */
  slowest(count = 5): FrameSample[] {
    const wanted = Math.max(0, Math.floor(count));
    if (wanted === 0 || this.count === 0) return [];
    const slots: number[] = [];
    for (let k = 0; k < this.count; k += 1) slots.push(this.slotAt(k));
    slots.sort((a, b) => this.msRing[b]! - this.msRing[a]!);
    const take = Math.min(wanted, slots.length);
    const out: FrameSample[] = new Array(take);
    for (let i = 0; i < take; i += 1) {
      const slot = slots[i]!;
      out[i] = this.sampleAt(slot);
    }
    return out;
  }

  /**
   * 按阶段聚合：每个阶段在窗口内的平均耗时与占比。
   * 这是"到底哪里慢"的直接答案。
   *
   * 占比的分母是**窗口内所有已上报阶段的总和**，所以没有上报 phases 的帧不计入分母；
   * 换句话说 share 回答的是"在已知的阶段里谁占大头"，而不是"占整帧的比例"。
   */
  phaseBreakdown(): { phase: string; averageMs: number; share: number }[] {
    const totals = new Map<string, number>();
    const counts = new Map<string, number>();
    let grand = 0;
    for (let k = 0; k < this.count; k += 1) {
      const phases = this.phaseRing[this.slotAt(k)];
      if (!phases) continue;
      for (const name of Object.keys(phases)) {
        const ms = phases[name]!;
        if (!Number.isFinite(ms)) continue;
        totals.set(name, (totals.get(name) ?? 0) + ms);
        counts.set(name, (counts.get(name) ?? 0) + 1);
        grand += ms;
      }
    }
    const out: { phase: string; averageMs: number; share: number }[] = [];
    for (const [phase, total] of totals) {
      const frames = counts.get(phase) ?? 1;
      out.push({ phase, averageMs: total / frames, share: grand > 0 ? total / grand : 0 });
    }
    out.sort((a, b) => b.averageMs - a.averageMs);
    return out;
  }

  /** 按 context 聚合 */
  contextBreakdown(): { context: string; averageMs: number; frames: number }[] {
    const sums = new Map<string, number>();
    const frames = new Map<string, number>();
    for (let k = 0; k < this.count; k += 1) {
      const slot = this.slotAt(k);
      const name = this.contextRing[slot] ?? NO_CONTEXT;
      sums.set(name, (sums.get(name) ?? 0) + this.msRing[slot]!);
      frames.set(name, (frames.get(name) ?? 0) + 1);
    }
    const out: { context: string; averageMs: number; frames: number }[] = [];
    for (const [context, sum] of sums) {
      const n = frames.get(context) ?? 1;
      out.push({ context, averageMs: sum / n, frames: n });
    }
    out.sort((a, b) => b.averageMs - a.averageMs);
    return out;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.pushed = 0;
    this.phaseRing.fill(undefined);
    this.contextRing.fill(undefined);
    this.atRing.fill(0);
    this.msRing.fill(0);
    this.indexRing.fill(0);
  }

  /** 面板用：一行中文摘要 */
  describe(): string {
    const s = this.stats;
    if (s.count === 0) return '帧分析：暂无采样';
    const span = this.windowSpanMs();
    const window = span > 0 ? `｜窗口 ${(span / 1000).toFixed(1)} 秒` : '';
    const worst = s.max - s.median;
    return (
      `帧分析：${s.fps.toFixed(1)} FPS｜均值 ${s.average.toFixed(1)} ms｜中位 ${s.median.toFixed(1)} ms｜` +
      `p95 ${s.p95.toFixed(1)} / p99 ${s.p99.toFixed(1)} ms｜最大 ${s.max.toFixed(1)} ms｜` +
      `慢帧 ${s.slowFrames}/${s.count}（${(s.slowRatio * 100).toFixed(1)}%，预算 ${s.budgetMs} ms）${window}` +
      `${worst > s.budgetMs ? '｜尖峰明显高于中位，是它在影响手感' : ''}`
    );
  }

  // ── 内部工具 ────────────────────────────────────────────────

  /** 从槽位还原一个样本（phases 拷一份，避免调用方改到环形缓冲里的对象） */
  private sampleAt(slot: number): FrameSample {
    const phases = this.phaseRing[slot];
    const context = this.contextRing[slot];
    const sample: FrameSample = {
      index: this.indexRing[slot]!,
      ms: this.msRing[slot]!,
    };
    if (phases) sample.phases = { ...phases };
    if (context !== undefined) sample.context = context;
    return sample;
  }

  /** 窗口覆盖的真实时长（依赖调用方传入的 nowMs；没传过就返回 0，摘要里不提） */
  private windowSpanMs(): number {
    if (this.count < 2) return 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < this.count; k += 1) {
      const at = this.atRing[this.slotAt(k)]!;
      if (at <= 0) continue;
      if (at < min) min = at;
      if (at > max) max = at;
    }
    return max > min ? max - min : 0;
  }
}

/**
 * 分位数取法：**排序后取下标（nearest-rank）**，不做插值。
 * 下标用 `ceil(p * n) - 1` 并夹到 [0, n-1]：n=120 时 p95 → 下标 113，
 * 意思是"至少 95% 的帧不慢于这个值"，这正是面板上要看的那件事。
 */
function pick(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function fallbackNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * 阶段名 → 中文标签。
 *
 * 为什么需要这张表：阶段名是给代码用的 key（`physics` / `mesh` / …），
 * 但它会**原样显示在性能面板与慢帧记录里** —— 玩家看到的是"最慢阶段：mesh"，
 * 那等于没说。中文标签集中放这里，避免各面板各自拼一遍（拼错就会不一致）。
 *
 * 这张表也是"这一帧到底花在哪"的清单：加阶段时**必须**同时加标签，
 * 否则面板上就会出现一个英文 key。
 */
export const PHASE_LABELS: Record<string, string> = {
  physics: '物理求解',
  sim: '水沙模拟',
  render: '渲染提交',
  mesh: '区块重建',
  support: '支撑面索引',
  panels: 'UI 面板',
  culling: '视锥剔除',
  interaction: '交互拾取',
  coupling: '流体耦合',
  sandWater: '沙水交互',
};

/** 阶段名的中文标签；没登记过的 key 原样返回（便于一眼看出漏登记） */
export function phaseLabel(name: string): string {
  return PHASE_LABELS[name] ?? name;
}
