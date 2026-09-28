/**
 * 时间控制面板 + 时间轴（含回溯拖动）。
 *
 * 这个面板负责三件互相有关联的事，它们各自的取舍都写在下面：
 *
 * 1. **时间流速**：0.25× / 0.5× / 1× / 2× / 4×。
 *    慢速档（0.25×、0.5×）是**刻意保留的**，不是凑数 —— 物理沙盘里"东西是怎么塌下来的"
 *    往往只有放慢才看得清，而要抓帧看细节时又需要 4× 快进。所以档位跨越了两个数量级。
 *
 * 2. **单步与暂停**：调试支撑/崩塌问题时，"推一帧看一眼"比连续播放有用得多。
 *
 * 3. **回溯缓冲**：`recordedFrames` 是已经录下来的历史帧数，容量是 `frameCapacity`。
 *    拖动时间轴 = 把画面定位到历史帧上，此时**画面不是实时状态**，所以需要一个
 *    显眼的状态条（`#tp-state`）把这件事说明白，并给面板加 `rewinding` class
 *    作为样式钩子（`#time-panel.rewinding` 由统一改样式时补上；
 *    `#tp-state` 里那句「不是实时」本身就是纯文本，不依赖任何样式也已生效）。
 *
 * 本文件**不 import three / Rapier / Engine**：它只操作 DOM、只往外派发玩家意图，
 * 真正的"播放/暂停/回溯"由上层（Engine + HistorySystem）实现。
 * 这样可以单独在 Node 里 import 做单测，也不会把渲染依赖传染出去。
 */

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

/** 拼 innerHTML 时的转义：快照 label 是玩家自己起的名字，必须转义 */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

export interface TimePanelHandlers {
  /** 播放 / 暂停 */
  onTogglePause(): void;
  /** 单步推进一步 */
  onStep(): void;
  /** 倍速：0.25 / 0.5 / 1 / 2 / 4 */
  onScaleChange(scale: number): void;
  /** 时间轴拖动到第 N 帧（回溯或前进） */
  onSeekFrame(frame: number): void;
  /** 回到实时（退出回溯） */
  onResumeLive(): void;
  /** 保存一个关键帧快照 */
  onTakeSnapshot(): void;
  /** 跳转到某个快照 */
  onGoToSnapshot(index: number): void;
  /** 清空回溯缓冲 */
  onClearHistory(): void;
}

export interface TimePanelStats {
  paused: boolean;
  /** 当前倍速 */
  scale: number;
  /** 模拟已流逝时间（秒）与步数 */
  elapsed: number;
  stepCount: number;
  /** 回溯缓冲：已记录帧数 / 容量 */
  recordedFrames: number;
  frameCapacity: number;
  /** 当前是否处在回溯状态（true = 画面是历史帧，不是实时） */
  rewinding: boolean;
  /** 时间轴游标位置（0..capacity-1）；不在回溯时为 recordedFrames-1 */
  cursorFrame: number;
  /** 关键帧快照列表 */
  snapshots: { index: number; frame: number; time: number; label: string }[];
  /** 单帧物理耗时（毫秒）与是否超过 5ms 预算 */
  stepMs: number;
  budgetMs: number;
}

/**
 * 允许的倍速档位（这个数组就是"档位契约"的唯一真源）：
 * index.html 里 `#tp-scales` 下的 `data-scale` 必须逐字来自这里，
 * 少一个会在控制台报警告，多一个也会报 —— 免得改了接口忘了改 HTML。
 */
export const TIME_SCALES: readonly number[] = [0.25, 0.5, 1, 2, 4];

/** 面板刷新节流（毫秒）。时间读数（秒 / 步数 / 帧号）肉眼跟不上 60Hz，100ms 足够 */
const REFRESH_INTERVAL_MS = 100;

/** 快照列表最多渲染多少行（快照可能有几十个，不能无上限地拼 innerHTML） */
const MAX_SNAPSHOT_ROWS = 10;

/**
 * 时间面板。
 *
 * 用法（上层侧）：
 * ```ts
 * const ui = new TimePanel({ onTogglePause: () => engine.togglePause(), ... });
 * // 每帧（或隔几帧）喂一次状态
 * ui.update({ paused, scale, elapsed, ... });
 * ```
 */
export class TimePanel {
  private readonly panel: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly stepButton: HTMLButtonElement;
  private readonly liveButton: HTMLButtonElement;
  private readonly snapshotButton: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly scaleContainer: HTMLElement;
  private readonly scaleButtons: HTMLButtonElement[];
  private readonly timeline: HTMLInputElement;
  private readonly cursorCell: HTMLElement;
  private readonly stateCell: HTMLElement;
  private readonly snapshotList: HTMLElement;
  private readonly cells: Record<string, HTMLElement>;
  /** 时间轴是否正在被拖动（见 onTimelineInput 的说明） */
  private scrubbing = false;
  /** 拖动过程中待提交的帧号（input 只改显示，change 才派发） */
  private scrubFrame = 0;
  private lastRefresh = 0;
  private disposed = false;

  constructor(private readonly handlers: TimePanelHandlers) {
    this.panel = must<HTMLElement>('#time-panel');
    this.pauseButton = must<HTMLButtonElement>('#tp-pause');
    this.stepButton = must<HTMLButtonElement>('#tp-step');
    this.liveButton = must<HTMLButtonElement>('#tp-live');
    this.snapshotButton = must<HTMLButtonElement>('#tp-snapshot');
    this.clearButton = must<HTMLButtonElement>('#tp-clear-history');
    this.scaleContainer = must<HTMLElement>('#tp-scales');
    this.timeline = must<HTMLInputElement>('#tp-timeline');
    this.cursorCell = must<HTMLElement>('#tp-cursor');
    this.stateCell = must<HTMLElement>('#tp-state');
    this.snapshotList = must<HTMLElement>('#tp-snapshots');

    const keys = ['elapsed', 'steps', 'frames', 'step-ms'];
    this.cells = {};
    for (const key of keys) this.cells[key] = must<HTMLElement>(`#tp-${key}`);

    this.scaleButtons = [
      ...this.scaleContainer.querySelectorAll<HTMLButtonElement>('[data-scale]'),
    ];
    this.auditScales();

    this.bind();
  }

  // ---------------------------------------------------------------- 绑定

  private bind(): void {
    this.pauseButton.addEventListener('click', () => this.handlers.onTogglePause());
    this.stepButton.addEventListener('click', () => this.handlers.onStep());
    this.liveButton.addEventListener('click', () => this.handlers.onResumeLive());
    this.snapshotButton.addEventListener('click', () => {
      this.handlers.onTakeSnapshot();
      this.lastRefresh = 0; // 快照列表要立刻重绘，不等节流
    });
    this.clearButton.addEventListener('click', () => {
      this.handlers.onClearHistory();
      this.lastRefresh = 0;
    });

    // 倍速与快照列表都走事件委托：即使 index.html 以后加/减了档位或快照，
    // 也不用改这个文件（和 PhysicsDebugUI 的开关容器同一个套路）
    this.scaleContainer.addEventListener('click', this.onScaleClick);
    this.snapshotList.addEventListener('click', this.onSnapshotClick);

    // 时间轴：input 会高频触发（拖一次能来上百个事件），change 只在松手时来一次。
    // 所以 input 只改"游标读数"这个纯展示，真正昂贵的 onSeekFrame（要把世界倒回第 N 帧）
    // 只在 change 时调一次 —— 否则拖一次时间轴会把回溯缓冲重建上百遍，直接卡死。
    this.timeline.addEventListener('input', this.onTimelineInput);
    this.timeline.addEventListener('change', this.onTimelineChange);
  }

  private readonly onScaleClick = (event: Event): void => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-scale]');
    if (!button || !this.scaleContainer.contains(button)) return;
    const scale = Number(button.dataset.scale);
    if (!Number.isFinite(scale) || !TIME_SCALES.includes(scale)) {
      console.warn(`[时间面板] 未知的倍速 data-scale="${button.dataset.scale ?? ''}"，已忽略`);
      return;
    }
    this.handlers.onScaleChange(scale);
    // 不等下一次 update 就把高亮切过去：玩家点了按钮要立刻有反馈
    for (const other of this.scaleButtons) {
      other.classList.toggle('active', Number(other.dataset.scale) === scale);
    }
  };

  private readonly onTimelineInput = (): void => {
    this.scrubbing = true;
    this.scrubFrame = Math.max(0, Math.round(Number(this.timeline.value) || 0));
    // 拖动中只更新读数，不派发 seek（见 bind() 里的说明）
    this.renderCursor(this.scrubFrame);
  };

  private readonly onTimelineChange = (): void => {
    this.scrubbing = false;
    const frame = Math.max(0, Math.round(Number(this.timeline.value) || 0));
    this.renderCursor(frame);
    this.handlers.onSeekFrame(frame);
    this.lastRefresh = 0; // 回溯状态要立刻反映出来
  };

  private readonly onSnapshotClick = (event: Event): void => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-snapshot-index]');
    if (!button || !this.snapshotList.contains(button)) return;
    const index = Number(button.dataset.snapshotIndex);
    if (!Number.isInteger(index) || index < 0) {
      console.warn(`[时间面板] 未知的快照序号 data-snapshot-index="${button.dataset.snapshotIndex ?? ''}"`);
      return;
    }
    this.handlers.onGoToSnapshot(index);
    this.lastRefresh = 0;
  };

  /** 构造期体检：HTML 里的 data-scale 与 TIME_SCALES 不一致的话，在这里喊出来 */
  private auditScales(): void {
    const seen = new Set<number>();
    for (const button of this.scaleButtons) {
      const scale = Number(button.dataset.scale);
      if (!Number.isFinite(scale) || !TIME_SCALES.includes(scale)) {
        console.warn(`[时间面板] #tp-scales 里有未知的 data-scale="${button.dataset.scale ?? ''}"`);
        continue;
      }
      seen.add(scale);
    }
    for (const scale of TIME_SCALES) {
      if (seen.has(scale)) continue;
      console.warn(`[时间面板] #tp-scales 缺少 data-scale="${scale}"（${scale}× 档位）`);
    }
  }

  // ---------------------------------------------------------------- 每帧

  /** 每帧调用（内部节流 100 ms；点按钮后的重绘不受节流影响） */
  update(stats: TimePanelStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_INTERVAL_MS) return;
    this.lastRefresh = now;
    this.render(stats);
  }

  private render(stats: TimePanelStats): void {
    // ---- 回溯状态：这是整个面板最重要的一行字 ----
    // 回溯中画面是历史帧，"暂停/单步"这两个针对实时模拟的操作必须先禁用，
    // 否则玩家会在看历史的时候按单步，然后以为模拟没反应。
    const rewinding = stats.rewinding;
    this.panel.classList.toggle('rewinding', rewinding);
    this.pauseButton.disabled = rewinding;
    this.stepButton.disabled = rewinding;
    this.liveButton.disabled = !rewinding;

    const lastRecorded = Math.max(0, stats.recordedFrames - 1);
    if (rewinding) {
      this.stateCell.textContent =
        `⏪ 回溯中：第 ${stats.cursorFrame} / ${lastRecorded} 帧（不是实时）—— 拖时间轴往回看，点「回到实时」继续模拟`;
    } else {
      this.stateCell.textContent =
        `● 实时：${stats.paused ? '已暂停' : '播放中'} · ${stats.scale}× · 缓冲 ${stats.recordedFrames} / ${stats.frameCapacity} 帧`;
    }

    // ---- 按钮与档位高亮 ----
    this.pauseButton.textContent = stats.paused ? '▶ 继续' : '⏸ 暂停';
    for (const button of this.scaleButtons) {
      button.classList.toggle('active', Number(button.dataset.scale) === stats.scale);
    }

    // ---- 时间轴 ----
    // max 用容量而不是已记录帧数：容量是"能拖多远"，已记录帧数是"现在录到哪"，
    // 两者混用会让拖动条在不同时刻代表不同的东西。
    const max = Math.max(1, stats.frameCapacity - 1);
    this.timeline.max = String(max);
    // 拖动中绝不回写 value：上层状态回溯到的是上一帧的 cursorFrame，
    // 一回写就会把玩家手里的滑块拽回去（手感变成"拖不动"）。
    if (!this.scrubbing) this.timeline.value = String(Math.min(max, Math.max(0, stats.cursorFrame)));
    this.renderCursor(this.scrubbing ? this.scrubFrame : stats.cursorFrame);

    // ---- 读数 ----
    this.cells.elapsed!.textContent = `${stats.elapsed.toFixed(1)} 秒`;
    this.cells.steps!.textContent = stats.stepCount.toLocaleString('en-US');
    this.cells.frames!.textContent = `${stats.recordedFrames} / ${stats.frameCapacity}`;

    // 单帧耗时超过预算：如实标出来。物理预算（默认 5ms）一破，帧率必然掉，
    // 这是"掉帧但看不出为什么"时最先该看的一个数。
    const overBudget = stats.stepMs > stats.budgetMs;
    this.cells['step-ms']!.textContent = overBudget
      ? `${stats.stepMs.toFixed(2)} ms（超过 ${stats.budgetMs} ms 预算）`
      : `${stats.stepMs.toFixed(2)} ms（预算 ${stats.budgetMs} ms）`;
    this.cells['step-ms']!.classList.toggle('warn', overBudget);

    this.renderSnapshots(stats.snapshots);
  }

  private renderCursor(frame: number): void {
    this.cursorCell.textContent = `第 ${Math.max(0, Math.round(frame))} 帧`;
  }

  /** 关键帧快照列表：一行 = 「#序号 第 N 帧 / T 秒 / 描述」+ 一个「跳转」按钮 */
  private renderSnapshots(snapshots: TimePanelStats['snapshots']): void {
    if (snapshots.length === 0) {
      this.snapshotList.innerHTML =
        '<span class="dim">还没有快照 —— 摆好一个关键状态后点「存快照」钉下来</span>';
      return;
    }
    const rows = snapshots.slice(0, MAX_SNAPSHOT_ROWS).map((snapshot) => {
      const label = snapshot.label.trim() ? escapeHtml(snapshot.label) : '（未命名快照）';
      return (
        '<div class="legend-row">' +
        `<b>#${snapshot.index} 第 ${snapshot.frame} 帧</b>` +
        `<span>${snapshot.time.toFixed(1)} 秒｜${label}</span>` +
        `<button type="button" data-snapshot-index="${snapshot.index}">跳转</button>` +
        '</div>'
      );
    });
    const hidden = snapshots.length - MAX_SNAPSHOT_ROWS;
    this.snapshotList.innerHTML =
      rows.join('') + (hidden > 0 ? `<span class="dim">…还有 ${hidden} 个快照未显示</span>` : '');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scaleContainer.removeEventListener('click', this.onScaleClick);
    this.snapshotList.removeEventListener('click', this.onSnapshotClick);
    this.timeline.removeEventListener('input', this.onTimelineInput);
    this.timeline.removeEventListener('change', this.onTimelineChange);
  }
}
