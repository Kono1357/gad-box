/**
 * 应力（结构受力）可视化面板。
 *
 * ⚠ **诚实取舍（这一条请勿删）**：
 * 本面板里的"应力"**不是有限元分析结果**，而是由**接触力与支撑比推算出来的近似值**
 * （见 SupportSystem / 接触点数量），取值范围归一化到 0~1。
 * 它能回答"哪个东西最危险、哪一片结构在硬撑"，但**不能**回答"这根梁的应力是多少 MPa"。
 * 所以面板上的所有数字都只给相对比例（百分比）与相对排序，绝不冒充工程数据。
 *
 * 界面上的三个取舍：
 * 1. **配色图例必须真的画出渐变**：只写"红=危险"没有意义，玩家需要看到 0~1 的整条色带
 *    才知道"橙色算严重吗"。所以图例用内联 `linear-gradient` 画出色带，并标上 0 / 0.5 / 1
 *    （色带两端按 0 → 1 的顺序排列，红落在 1 那一端，与"红 = 危险"一致）。
 * 2. **危险物体给条形图而不给纯数字**：0.42 和 0.87 谁更危险，一眼看条长比读数字快。
 * 3. **关闭着色时不隐藏图例**：图例是这个功能的"说明书"，关掉着色时它更要留着 ——
 *    玩家得先知道它能干什么，才会去打开它。
 *
 * 本文件**不 import three / Rapier / Engine**：它只操作 DOM、只往外派发玩家意图，
 * 真正给物体上色的是渲染层。
 */

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

/** 拼 innerHTML 时的转义：模型名可能带玩家自定义的名字 */
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

export interface StressPanelHandlers {
  /** 开关应力着色 */
  onToggleStress(enabled: boolean): void;
  /** 切换配色方案 */
  onColorSchemeChange(scheme: 'heat' | 'mono'): void;
  /** 调整显示阈值（只显示应力高于阈值的物体） */
  onThresholdChange(threshold: number): void;
  /** 点了「只看最危险的一个」 */
  onFocusWorst(): void;
}

export interface StressPanelStats {
  enabled: boolean;
  scheme: 'heat' | 'mono';
  threshold: number;
  /** 应力统计（0~1） */
  stats: { count: number; max: number; average: number; overThreshold: number };
  /** 应力最高的几个物体 */
  worst: { objectId: number; defName: string; stress: number; contacts: number; supportRatio: number }[];
  /** 有多少物体被判为不稳 / 临界 */
  unstable: number;
  critical: number;
}

/** 允许的配色方案（这个数组就是"配色契约"的唯一真源，HTML 的 <option> 必须在这里面） */
export const STRESS_SCHEMES: readonly ('heat' | 'mono')[] = ['heat', 'mono'];

/** 配色方案的中文名（面板与告警信息共用） */
export const STRESS_SCHEME_LABELS: Record<'heat' | 'mono', string> = {
  heat: '热力（蓝 → 黄 → 红）',
  mono: '单色（灰度，区分材料本色用）',
};

/**
 * 阈值滑块的取值范围。
 * 这里**故意不读 PHYSICS_LIMITS**：那个表管的是物理世界参数（重力/时间步/摩擦…），
 * 而阈值是"0~1 的归一化应力比例"，是纯粹的显示参数，改了它物理一点都不变。
 * 混进物理限制表反而会让人以为它会影响模拟。
 */
const THRESHOLD_RANGE = { min: 0, max: 1, step: 0.05 } as const;

/** 面板刷新节流（毫秒）：和 PhysicsDebugUI 一致，观测面板不该比被观测的东西还贵 */
const REFRESH_INTERVAL_MS = 150;

/** 危险物体列表最多渲染几行（剩下的用一行尾巴说明有多少没显示，不静默截断） */
const MAX_WORST_ROWS = 8;

/**
 * 应力面板。
 *
 * 用法（上层侧）：
 * ```ts
 * const ui = new StressPanel({ onToggleStress: (on) => renderer.setStressView(on), ... });
 * ui.update(collectStressStats()); // 每帧或隔几帧
 * ```
 */
export class StressPanel {
  private readonly panel: HTMLElement;
  private readonly toggle: HTMLInputElement;
  private readonly schemeSelect: HTMLSelectElement;
  private readonly thresholdSlider: HTMLInputElement;
  private readonly thresholdValue: HTMLElement;
  private readonly statsBox: HTMLElement;
  private readonly worstList: HTMLElement;
  private readonly focusButton: HTMLButtonElement;
  private readonly legend: HTMLElement;
  private readonly unstableNote: HTMLElement;
  private lastRefresh = 0;
  private disposed = false;

  constructor(private readonly handlers: StressPanelHandlers) {
    this.panel = must<HTMLElement>('#stress-panel');
    this.toggle = must<HTMLInputElement>('#sp-toggle');
    this.schemeSelect = must<HTMLSelectElement>('#sp-scheme');
    this.thresholdSlider = must<HTMLInputElement>('#sp-threshold');
    this.thresholdValue = must<HTMLElement>('#sp-threshold-value');
    this.statsBox = must<HTMLElement>('#sp-stats');
    this.worstList = must<HTMLElement>('#sp-worst');
    this.focusButton = must<HTMLButtonElement>('#sp-focus-worst');
    this.legend = must<HTMLElement>('#sp-legend');
    this.unstableNote = must<HTMLElement>('#sp-unstable-note');

    this.thresholdSlider.min = String(THRESHOLD_RANGE.min);
    this.thresholdSlider.max = String(THRESHOLD_RANGE.max);
    this.thresholdSlider.step = String(THRESHOLD_RANGE.step);

    this.auditSchemes();
    this.renderLegend();
    this.bind();
  }

  /** 构造期体检：HTML 里 `<select>` 的 <option> 与 STRESS_SCHEMES 不一致的话，在这里喊出来 */
  private auditSchemes(): void {
    const values = [...this.schemeSelect.options].map((option) => option.value);
    for (const value of values) {
      if ((STRESS_SCHEMES as readonly string[]).includes(value)) continue;
      console.warn(`[应力面板] #sp-scheme 里有未知的 <option value="${value}">`);
    }
    for (const scheme of STRESS_SCHEMES) {
      if (values.includes(scheme)) continue;
      console.warn(
        `[应力面板] #sp-scheme 缺少 <option value="${scheme}">（${STRESS_SCHEME_LABELS[scheme]}）`,
      );
    }
  }

  // ---------------------------------------------------------------- 绑定

  private bind(): void {
    this.toggle.addEventListener('change', () => {
      this.handlers.onToggleStress(this.toggle.checked);
      this.lastRefresh = 0; // 立即重绘（禁用态要马上体现出来）
    });

    this.schemeSelect.addEventListener('change', () => {
      const scheme = this.schemeSelect.value;
      if (scheme !== 'heat' && scheme !== 'mono') {
        console.warn(`[应力面板] 未知的配色方案 value="${scheme}"，已忽略`);
        return;
      }
      this.handlers.onColorSchemeChange(scheme);
    });

    this.thresholdSlider.addEventListener('input', () => {
      const threshold = Number(this.thresholdSlider.value);
      this.thresholdValue.textContent = formatPercent(threshold);
      this.handlers.onThresholdChange(threshold);
    });

    this.focusButton.addEventListener('click', () => {
      this.handlers.onFocusWorst();
      this.lastRefresh = 0;
    });
  }

  /**
   * 图例：**真的画出 0 → 1 的色带**，而不是只写一句"红=危险"。
   *
   * 色带用内联 gradient（不依赖 style.css，因为它是这个面板专属的语义）：
   * 停靠色是蓝 → 黄 → 红，即 **0 = 蓝 = 安全，1 = 红 = 危险**，
   * 下面的 0 / 0.5 / 1 刻度就是照着这条带子标的。
   */
  private renderLegend(): void {
    this.legend.innerHTML =
      '<div style="display:flex;flex-direction:column;gap:2px">' +
      '<div style="height:10px;border-radius:999px;border:1px solid var(--panel-border);' +
      'background:linear-gradient(90deg,#4a9eff 0%,var(--accent-2) 50%,var(--danger) 100%)"></div>' +
      '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-dim)">' +
      '<span>0（安全）</span><span>0.5</span><span>1（危险）</span>' +
      '</div>' +
      '<span style="font-size:10px;color:var(--text-dim)">' +
      '红 = 应力高（危险），蓝 = 应力低（安全）；低于阈值的不着色。' +
      '</span>' +
      '<span style="font-size:10px;color:var(--text-dim)">' +
      '数值由接触力与支撑比推算，是近似值，不是有限元分析。' +
      '</span>' +
      '</div>';
  }

  // ---------------------------------------------------------------- 每帧

  /** 每帧调用（内部节流 150 ms；点按钮后的重绘不受节流影响） */
  update(stats: StressPanelStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_INTERVAL_MS) return;
    this.lastRefresh = now;
    this.render(stats);
  }

  private render(stats: StressPanelStats): void {
    // 面板根的状态 class：给统一改样式时留的钩子（和 PhysicsDebugUI 的 `physics-debug-loading`
    // 同一个套路）。注意禁用态本身不靠它 —— 下面直接设 disabled，删掉样式也不会失去功能。
    this.panel.classList.toggle('stress-off', !stats.enabled);

    // 控件状态跟随外部真源（读档 / 快捷键也可能改这些值）
    if (this.toggle.checked !== stats.enabled) this.toggle.checked = stats.enabled;
    if (this.schemeSelect.value !== stats.scheme) this.schemeSelect.value = stats.scheme;
    this.thresholdSlider.value = String(stats.threshold);
    this.thresholdValue.textContent = formatPercent(stats.threshold);

    // 关掉着色时，阈值与配色无从作用，禁用它们（留着可点会让人以为改了有效果）；
    // 图例**不禁用也不隐藏** —— 它是这个功能的说明书。
    this.thresholdSlider.disabled = !stats.enabled;
    this.schemeSelect.disabled = !stats.enabled;
    // 没有危险物体时"只看最危险的一个"没有目标，禁用并说明
    this.focusButton.disabled = !stats.enabled || stats.worst.length === 0;

    this.renderStats(stats);
    this.renderWorst(stats);
    this.renderStability(stats);
  }

  /** 统计摘要：一行一个指标，行结构与项目其它 `.legend.rows` 面板一致 */
  private renderStats(stats: StressPanelStats): void {
    const s = stats.stats;
    const rows = [
      legendRow('着色物体', `<span>${s.count} 个</span>`),
      legendRow('最大应力', `<span>${formatPercent(s.max)}</span>`),
      legendRow('平均应力', `<span>${formatPercent(s.average)}</span>`),
      legendRow(
        '超过阈值',
        `<span>${s.overThreshold} 个（阈值 ${formatPercent(stats.threshold)}）</span>`,
      ),
    ];
    this.statsBox.innerHTML = rows.join('');
  }

  /**
   * 危险物体列表：每行 = 模型名 + 应力条 + 「接触 N 点 / 支撑比 X%」。
   * 条形图的宽度就是应力 × 100%，条子本身不另外上色 ——
   * 颜色由渲染层按配色方案统一决定，面板再染一遍反而会和场景里的颜色对不上。
   */
  private renderWorst(stats: StressPanelStats): void {
    if (stats.worst.length === 0) {
      this.worstList.innerHTML =
        '<span class="dim">没有超过阈值的物体 —— 把阈值调低，或者去叠一个高塔试试</span>';
      return;
    }
    const rows = stats.worst.slice(0, MAX_WORST_ROWS).map((item) => {
      const name = item.defName.trim() ? escapeHtml(item.defName) : `#${item.objectId}`;
      const width = Math.round(clamp01(item.stress) * 100);
      return (
        '<div class="legend-row">' +
        `<b>${name} <span class="dim">#${item.objectId}</span></b>` +
        `<div class="bar"><div class="bar-fill" style="width:${width}%"></div></div>` +
        `<span>${formatPercent(item.stress)}｜接触 ${item.contacts} 点 / 支撑比 ${formatPercent(
          item.supportRatio,
        )}</span>` +
        '</div>'
      );
    });
    const hidden = stats.worst.length - MAX_WORST_ROWS;
    this.worstList.innerHTML =
      rows.join('') + (hidden > 0 ? `<span class="dim">…还有 ${hidden} 个未显示</span>` : '');
  }

  /** 稳定性一句话：不稳/临界都要说清"会怎样"，全为 0 时明确告诉玩家结构是稳的 */
  private renderStability(stats: StressPanelStats): void {
    const { unstable, critical } = stats;
    this.unstableNote.classList.toggle('warn', unstable > 0);
    if (unstable === 0 && critical === 0) {
      this.unstableNote.textContent = '结构稳定：没有物体被判为不稳或临界';
      return;
    }
    const parts: string[] = [];
    if (unstable > 0) parts.push(`不稳 ${unstable} 个（会掉）`);
    if (critical > 0) parts.push(`临界 ${critical} 个（勉强撑着）`);
    this.unstableNote.textContent = parts.join('｜');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }
}

/** 一行 `.legend-row`（<b> 标签 + span 明细），与项目其它 `.legend.rows` 面板同构 */
function legendRow(label: string, detail: string): string {
  return `<div class="legend-row"><b>${label}</b>${detail}</div>`;
}

/** 0~1 的应力一律显示成百分比：0.42 这种小数读起来没有"42%"快 */
function formatPercent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`;
}

/** 支撑比 / 应力可能因为数值误差略微越界（0.9999999 → 100%），这里夹一下再显示 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
