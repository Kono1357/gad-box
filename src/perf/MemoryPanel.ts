/**
 * 内存与性能详情面板（src/perf 模块 4/5）。
 *
 * ────────────────────────────────────────────────────────────
 * 它与已有面板的关系
 * ────────────────────────────────────────────────────────────
 * 已有的 `src/ui/PerformancePanel.ts` 是"总览 + 调试开关"：FPS、draw call、体素、区块……
 * 这个面板是**详情页**，三块新东西：
 *
 * 1. **帧时间分布**：直方图 + 最近 60 帧的柱状折线 + 最慢的几帧 —— 尖峰比平均值更能说明手感；
 * 2. **慢帧记录**：带阶段、场景、世界规模，能导出成报告贴进问题反馈；
 * 3. **瓶颈诊断**：直接给一句"现在最可能是什么在拖慢"。
 *
 * 写法刻意与 `PerformancePanel` 保持一致：同样的 `must<T>()`（缺节点就抛带中文说明的错）、
 * 同样的 200ms 节流、同样只读不写业务状态（改动一律通过 handlers 回调出去）。
 *
 * ────────────────────────────────────────────────────────────
 * 三条如实标注的规矩（与 ResourceMonitor 一致）
 * ────────────────────────────────────────────────────────────
 * - JS 堆：`null` 显示「不可用（非 Chromium）」，**不显示 0** —— 0 会被误读成"占用为 0"；
 * - GC 次数：浏览器不暴露，文案必须带「（近似）」；
 * - 材质数：`renderer.info.memory` 里没有这一项，未统计时显示「未统计」，不拿几何数冒充。
 *
 * 图表一律用「纯 div + 内联样式」画，不引图表库，也不写进 style.css：
 * 柱子的高度是唯一的变量，用内联样式反而比外部类名更清楚（容器骨架在构造函数里设一次）。
 */

import type { FrameStats } from './FrameProfiler';
import type { PerformanceMetrics } from './PerformanceMonitor';

/** 与 PerformancePanel 同一套取节点写法：缺节点就抛错，错误信息里带上选择器 */
function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface MemoryPanelHandlers {
  /** 玩家点了「回收内存」 */
  onCollectGarbage(): void;
  /** 玩家点了「导出性能报告」 */
  onExportReport(): void;
  /** 玩家点了「清空慢帧记录」 */
  onClearSlowFrames(): void;
  /** 玩家改了慢帧阈值 */
  onThresholdChange(ms: number): void;
}

export interface MemoryPanelStats {
  /** 来自 ResourceSnapshot 的资源类指标（null 表示还没采样） */
  heapUsedMB: number | null;
  heapLimitMB: number | null;
  geometries: number;
  textures: number;
  programs: number;
  estGpuMB: number;
  /** 性能指标 */
  metrics: PerformanceMetrics;
  /** 帧分析 */
  frameStats: FrameStats;
  /** 帧时间分布直方图 */
  histogram: { from: number; to: number; count: number }[];
  /** 最近 60 帧的耗时（画折线/柱状） */
  recentFrames: number[];
  /** 最慢的几帧 */
  slowest: { index: number; ms: number; worstPhase: string }[];
  /** 慢帧记录（新的在前，最多 8 条） */
  slowRecords: { ms: number; over: number; worstPhase: string; repeat: number; context: string }[];
  slowTotal: number;
  thresholdMs: number;
  /** 瓶颈诊断 */
  diagnosis: { bottleneck: string; advice: string };
  /** 上一次回收内存的说明（原样显示，不美化） */
  gcNote: string;
}

/** 刷新节流：面板自己也会吃性能，200ms 与 PerformancePanel 一致 */
const REFRESH_INTERVAL_MS = 200;
/** 慢帧记录列表最多显示多少条 */
const SLOW_LIST_LIMIT = 8;
/** 没取到最慢阶段的帧在列表里显示的占位文字 */
const NO_PHASE = '(无阶段)';
/** 直方图配色：正常 / 跨过预算线 / 整桶超预算 */
const COLOR_OK = '#4aa3ff';
const COLOR_STRADDLE = '#e5a33d';
const COLOR_OVER = '#e5533d';
/** 瓶颈名 → 中文 */
const BOTTLENECK_LABELS: Record<string, string> = {
  render: '渲染',
  physics: '物理',
  script: '主线程脚本',
  unknown: '暂不明显',
};

export class MemoryPanel {
  private readonly cells: Record<string, HTMLElement>;
  private readonly histogramBox: HTMLElement;
  private readonly sparklineBox: HTMLElement;
  private readonly slowestBox: HTMLElement;
  private readonly slowListBox: HTMLElement;
  private readonly diagnosisBox: HTMLElement;
  private readonly thresholdInput: HTMLInputElement;
  private readonly thresholdLabel: HTMLElement;
  /** 回收内存的说明节点：**约定的 id 清单里没有它**，所以是可选的（见构造函数注释） */
  private readonly gcNoteBox: HTMLElement | null;
  /** 回收内存按钮：兜底承载 gcNote 的 tooltip */
  private readonly gcButton: HTMLButtonElement;
  private readonly listeners: { el: EventTarget; type: string; handler: EventListener }[] = [];
  /**
   * 上次刷新时间。初值取 -Infinity 而不是 0：
   * 用 0 的话，如果面板在页面启动后不到 200ms 就被调用第一次，
   * `now - 0 < 200` 会把**首帧渲染整个吞掉**，面板看上去像坏了。
   * 取 -Infinity 表示"从没刷过"，第一次 update 必定画出来。
   */
  private lastRefresh = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(private readonly handlers: MemoryPanelHandlers) {
    const root = must<HTMLElement>('#memory-panel');

    // 标量指标：id 一字不差地对上 index.html，缺任何一个都会抛错指出是哪一个
    const keys = [
      'fps',
      'frame',
      'draws',
      'tris',
      'physics',
      'gc',
      'heap',
      'gpu',
      'geo',
      'tex',
      'mat',
      'median',
      'p95',
      'p99',
      'slow-ratio',
      'slow-total',
    ];
    this.cells = {};
    for (const key of keys) this.cells[key] = must<HTMLElement>(`#memp-${key}`, root);

    this.histogramBox = must<HTMLElement>('#memp-histogram', root);
    this.sparklineBox = must<HTMLElement>('#memp-sparkline', root);
    this.slowestBox = must<HTMLElement>('#memp-slowest', root);
    this.slowListBox = must<HTMLElement>('#memp-slow-list', root);
    this.diagnosisBox = must<HTMLElement>('#memp-diagnosis', root);
    this.thresholdInput = must<HTMLInputElement>('#memp-threshold', root);
    this.thresholdLabel = must<HTMLElement>('#memp-threshold-value', root);
    // gcNote 只有文案、没有约定 id。这里用 querySelector 而不是 must：
    // 就算 HTML 里没加 #memp-gc-note，面板也必须能正常工作（退化成 GC 按钮的 tooltip）。
    this.gcNoteBox = root.querySelector<HTMLElement>('#memp-gc-note');
    this.gcButton = must<HTMLButtonElement>('#memp-collect-gc', root);

    // 图表容器骨架在这里设一次，省得 style.css 再长出一条新规则。
    // align-items:flex-end 让柱子从底部长上来；gap 保持 1px 保证不糊成一片。
    this.histogramBox.style.display = 'flex';
    this.histogramBox.style.alignItems = 'flex-end';
    this.histogramBox.style.gap = '2px';
    this.histogramBox.style.height = '56px';
    this.sparklineBox.style.display = 'flex';
    this.sparklineBox.style.alignItems = 'flex-end';
    this.sparklineBox.style.gap = '0';
    this.sparklineBox.style.height = '40px';

    this.thresholdInput.min = '8';
    this.thresholdInput.max = '100';
    this.thresholdInput.step = '0.5';

    this.bind(root);
  }

  private bind(root: ParentNode): void {
    const collectGc = this.gcButton;
    const exportReport = must<HTMLButtonElement>('#memp-export', root);
    const clearSlow = must<HTMLButtonElement>('#memp-clear-slow', root);

    this.on(collectGc, 'click', () => this.handlers.onCollectGarbage());
    this.on(exportReport, 'click', () => this.handlers.onExportReport());
    this.on(clearSlow, 'click', () => this.handlers.onClearSlowFrames());
    this.on(this.thresholdInput, 'input', () => {
      const value = Number(this.thresholdInput.value);
      if (!Number.isFinite(value) || value <= 0) return;
      // 拖动时先自己更新标签：update() 里的 stats.thresholdMs 是上一帧的采样值，
      // 会慢半拍，拖动时手指和数字必须同步
      this.thresholdLabel.textContent = `${value.toFixed(1)} ms`;
      this.handlers.onThresholdChange(value);
    });
  }

  /** 注册监听并记下来，dispose() 时逐个摘掉（PerformancePanel 只置 flag，这里做得更干净一点） */
  private on(el: EventTarget, type: string, handler: EventListener): void {
    el.addEventListener(type, handler);
    this.listeners.push({ el, type, handler });
  }

  update(stats: MemoryPanelStats): void {
    if (this.disposed) return;
    const now = currentNow();
    if (now - this.lastRefresh < REFRESH_INTERVAL_MS) return;
    this.lastRefresh = now;

    const m = stats.metrics;
    const f = stats.frameStats;

    this.cells.fps!.textContent = m.fps.toFixed(0);
    this.cells.frame!.textContent = `${m.frameTime.toFixed(1)} ms`;
    this.cells.draws!.textContent = m.drawCalls.toLocaleString('en-US');
    this.cells.tris!.textContent = m.triangles.toLocaleString('en-US');
    this.cells.physics!.textContent = `${m.physicsTime.toFixed(1)} ms`;
    // 「（近似）」必须留在正文里：浏览器没有暴露真实 GC 次数
    this.cells.gc!.textContent = `${m.gcCount}（近似）`;
    this.cells.heap!.textContent = formatHeap(m.jsHeap, stats.heapLimitMB);
    this.cells.gpu!.textContent = `${m.gpuMemory.toFixed(0)} MB（粗估）`;
    this.cells.geo!.textContent = String(m.geometries || stats.geometries);
    this.cells.tex!.textContent = String(m.textures || stats.textures);
    // 材质计数 Three.js 没有暴露，未统计就如实说，不拿几何数顶上
    this.cells.mat!.textContent = m.materials > 0 ? String(m.materials) : '未统计';

    this.cells.median!.textContent = `${f.median.toFixed(1)} ms`;
    this.cells.p95!.textContent = `${f.p95.toFixed(1)} ms`;
    this.cells.p99!.textContent = `${f.p99.toFixed(1)} ms`;
    this.cells['slow-ratio']!.textContent = `${f.slowFrames}/${f.count}（${(f.slowRatio * 100).toFixed(1)}%）`;
    this.cells['slow-total']!.textContent = `${stats.slowTotal} 条（阈值 ${stats.thresholdMs.toFixed(1)} ms）`;

    this.renderHistogram(stats.histogram, f.budgetMs);
    this.renderSparkline(stats.recentFrames, f.budgetMs);
    this.renderSlowest(stats.slowest);
    this.renderSlowList(stats.slowRecords);

    const bottleneck = BOTTLENECK_LABELS[stats.diagnosis.bottleneck] ?? stats.diagnosis.bottleneck;
    this.diagnosisBox.textContent = `【${bottleneck}】${stats.diagnosis.advice}`;

    // 回收说明原样显示（不做任何美化/截断）；没有 #memp-gc-note 时退化成按钮上的 tooltip
    if (this.gcNoteBox) this.gcNoteBox.textContent = stats.gcNote || '—';
    else this.gcButton.title = stats.gcNote;

    // 阈值滑块：玩家正在拖的时候不要反向同步，否则手感是"滑块被抢"
    if (document.activeElement !== this.thresholdInput) {
      const value = String(stats.thresholdMs);
      if (this.thresholdInput.value !== value) this.thresholdInput.value = value;
      this.thresholdLabel.textContent = `${stats.thresholdMs.toFixed(1)} ms`;
    }
  }

  /**
   * 直方图：每桶一个 div，高度 = count / maxCount * 100%。
   * 每 200ms 重建这十来个节点，比做 diff 更不容易出错 —— 节点数太少，不值得为它写更新逻辑。
   */
  private renderHistogram(buckets: MemoryPanelStats['histogram'], budgetMs: number): void {
    this.histogramBox.textContent = '';
    let maxCount = 0;
    for (const bucket of buckets) if (bucket.count > maxCount) maxCount = bucket.count;

    for (const bucket of buckets) {
      const bar = document.createElement('div');
      const ratio = maxCount > 0 ? bucket.count / maxCount : 0;
      bar.style.flex = '1 1 0';
      bar.style.height = `${(ratio * 100).toFixed(1)}%`;
      // 有帧但比例极小时给 2px 兜底，否则那一桶看起来像"没有帧"
      bar.style.minHeight = bucket.count > 0 ? '2px' : '0';
      // 三态着色：整桶都在预算之上 → 红；跨过预算线（桶里有一部分超预算）→ 橙；
      // 全在预算内 → 蓝。只分两态的话，跨线的那一桶会显示成蓝色，
      // 里面明明装着慢帧却看起来一切正常 —— 这正是面板最不该骗人的地方。
      if (bucket.from >= budgetMs) bar.style.background = COLOR_OVER;
      else if (bucket.to > budgetMs) bar.style.background = COLOR_STRADDLE;
      else bar.style.background = COLOR_OK;
      bar.style.borderRadius = '1px 1px 0 0';
      bar.title =
        `${bucket.from.toFixed(1)} – ${bucket.to.toFixed(1)} ms：${bucket.count} 帧` +
        (bucket.from >= budgetMs ? '（全部超预算）' : bucket.to > budgetMs ? '（含超预算帧）' : '');
      this.histogramBox.appendChild(bar);
    }
  }

  /**
   * 最近帧柱状图：每帧一个 1px 宽的 div，高度 = ms / maxMs * 100%，超过预算的标红。
   * 用 flex:1 1 auto 让它们把容器宽度填满（基础宽度仍是 1px），手机上才不会挤成一条线。
   */
  private renderSparkline(frames: number[], budgetMs: number): void {
    this.sparklineBox.textContent = '';
    let maxMs = budgetMs > 0 ? budgetMs : 1;
    for (const ms of frames) if (ms > maxMs) maxMs = ms;

    for (let i = 0; i < frames.length; i += 1) {
      const ms = frames[i]!;
      const bar = document.createElement('div');
      bar.style.width = '1px';
      bar.style.minWidth = '1px';
      bar.style.flex = '1 1 auto';
      bar.style.height = `${Math.max(0, Math.min(100, (ms / maxMs) * 100)).toFixed(1)}%`;
      bar.style.minHeight = '1px';
      bar.style.background = ms > budgetMs ? '#e5533d' : '#4aa3ff';
      bar.title = `第 ${i + 1} 个采样：${ms.toFixed(1)} ms${ms > budgetMs ? '（超预算）' : ''}`;
      this.sparklineBox.appendChild(bar);
    }
  }

  /** 最慢的几帧：带上阶段名，直接回答"是谁慢" */
  private renderSlowest(slowest: MemoryPanelStats['slowest']): void {
    this.slowestBox.textContent = '';
    if (slowest.length === 0) {
      this.slowestBox.appendChild(line('暂无采样', true));
      return;
    }
    for (const frame of slowest) {
      this.slowestBox.appendChild(
        line(`#${frame.index}｜${frame.ms.toFixed(1)} ms｜${frame.worstPhase || NO_PHASE}`),
      );
    }
  }

  /** 慢帧记录：repeat > 1 时明写「（重复 N 次）」—— 一条记录不代表只卡了一次 */
  private renderSlowList(records: MemoryPanelStats['slowRecords']): void {
    this.slowListBox.textContent = '';
    if (records.length === 0) {
      this.slowListBox.appendChild(line('暂无慢帧记录', true));
      return;
    }
    for (const record of records.slice(0, SLOW_LIST_LIMIT)) {
      const repeat = Math.max(1, record.repeat ?? 1);
      const repeatText = repeat > 1 ? `（重复 ${repeat} 次）` : '';
      const context = record.context ? `｜${record.context}` : '';
      this.slowListBox.appendChild(
        line(
          `${record.ms.toFixed(1)} ms（超 ${record.over.toFixed(1)} ms）｜${record.worstPhase || NO_PHASE}${context}${repeatText}`,
        ),
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { el, type, handler } of this.listeners) el.removeEventListener(type, handler);
    this.listeners.length = 0;
  }
}

/** 列表里的一行 */
function line(text: string, dim = false): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  if (dim) el.style.opacity = '0.6';
  el.style.whiteSpace = 'nowrap';
  el.style.overflow = 'hidden';
  el.style.textOverflow = 'ellipsis';
  return el;
}

/**
 * 堆用量文案。
 * `null` 显示「不可用（非 Chromium）」，**不是 0** —— 这条规矩来自 ResourceMonitor：
 * 只有 Chromium 系提供 performance.memory，拿不到就说拿不到，0 会被读成"没有占用"。
 */
function formatHeap(usedMB: number | null, limitMB: number | null): string {
  if (usedMB === null) return '不可用（非 Chromium）';
  const limit = limitMB === null ? '' : ` / ${limitMB.toFixed(0)} MB`;
  return `${usedMB.toFixed(1)}${limit} MB`;
}

function currentNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
