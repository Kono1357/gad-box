/**
 * 内容使用统计面板（M4 第 7 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么热力图画在**俯视 2D canvas** 上
 * ────────────────────────────────────────────────────────────
 * 备选方案有三个，都被否掉了，理由写在这里免得以后被当成偷懒：
 * - **烘进地形贴图**：地形贴图是体素图集（`VoxelAtlas`）的一部分，改它就要重跑
 *   图集生成 + 所有区块重新上载，而玩家每删一个物体就得来一遍 —— 代价与收益完全不成比例；
 * - **3D 平面网格 / 平面贴图**：要新建 Three.js 几何体与材质、挂进场景、每帧参与
 *   排序与绘制；而这张图只是一张"偶尔刷新"的仪表盘，不该占用渲染主循环的任何预算；
 * - **纯 div 表格**：8×8 = 64 个 div 做不出渐变着色，格子一多 DOM 就直接变成瓶颈。
 *
 * 2D canvas 正好：**零贴图开销**（不碰 GPU 资源，也不进 Three.js 的资源表）、
 * **可以逐格重着色**（一张 `fillRect` 一格，改一格的成本恒定）、
 * **不需要重建几何**（尺寸变了只是重设 `canvas.width`，没有任何场景对象要更新）。
 *
 * ────────────────────────────────────────────────────────────
 * 两条如实标注（哪张图都不许骗人）
 * ────────────────────────────────────────────────────────────
 * 1. **图上格子等大，但"一格不等于等面积地块"**：世界可能是 192×192，也可能是
 *    64×96，格子一律按 cols×rows 等分画成矩形。所以这张图是"密度示意图"，
 *    不是等比俯视图 —— 这条写在 canvas 上的角标里，玩家不用猜。
 * 2. **`maxBinCount === 0` 时画的是一层说明文字，不是全黑**：全黑会被读成
 *    "这里有个热力图，只是没有热"，而实际情况是"世界里一个可统计的物体都没有"。
 *    分箱网格线照画（它代表"分箱是几 × 几"，不是数据），文字盖在中间说明原因。
 *
 * `canvas` / `legend` 允许为 null：HTML 片段还没接上时，面板的其余部分必须照常工作，
 * 而不是让整个 UI 起不来（`CatalogPanel` 用 `must()` 抛错是因为它的节点在 index.html 里
 * 已经存在；这两个节点是本批新加的，接之前不能变成硬依赖）。
 */

import type { ContentStats } from '../data/contentStats';

export interface ContentStatsUIHandlers {
  /** 绘制或状态异常时的中文提示（Engine 接成 toast）。同一条错误只报一次，避免每帧刷屏 */
  onError?(message: string): void;
}

/** 没有 CSS 尺寸时的兜底画布尺寸（CSS 还没加载 / 面板被隐藏时 clientWidth 是 0） */
const FALLBACK_W = 320;
const FALLBACK_H = 200;
/**
 * devicePixelRatio 上限。
 * 手机上 3 倍已经看不出差别，再往上只是白烧像素（一张 400×300 的画布在 4x 下是 192 万像素）。
 */
const MAX_DPR = 3;
/** 图例里最多列几个分类（再多就把面板顶出屏幕了；剩下的用一行文字交代） */
const LEGEND_CATEGORY_LIMIT = 8;
/** 图例里最多列几个"用得最多的物品" */
const LEGEND_TOP_LIMIT = 5;
/** 未知 id 在提示里最多列几个 */
const UNKNOWN_ID_LIMIT = 5;

const BG_COLOR = '#0e141a';
const GRID_COLOR = 'rgba(255, 255, 255, 0.08)';
const TEXT_COLOR = '#dfe7ee';
const DIM_TEXT = 'rgba(223, 231, 238, 0.6)';
const WARN_COLOR = '#ff8a6b';
const PANEL_BG = 'rgba(8, 12, 16, 0.78)';

/**
 * 冷 → 热的色带（蓝 → 青 → 黄 → 红）。
 *
 * 不用 HSL 直接插值：从 210° 转到 0° 会经过绿色，而"绿"在这张图里没有任何含义，
 * 玩家会以为绿色代表"中等可用"之类。四个固定停靠点更好读：越红 = 越挤。
 */
const RAMP: readonly { t: number; rgb: readonly [number, number, number] }[] = [
  { t: 0, rgb: [18, 49, 79] },
  { t: 0.4, rgb: [38, 138, 168] },
  { t: 0.7, rgb: [232, 196, 74] },
  { t: 1, rgb: [214, 64, 48] },
];

/** 比例（0~1）→ 颜色字符串。超出范围夹住：越界物体已经被夹进边界格，比例不该再溢出 */
function heatColor(ratio: number): string {
  const t = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  let lower = RAMP[0]!;
  let upper = RAMP[RAMP.length - 1]!;
  for (let i = 0; i < RAMP.length - 1; i += 1) {
    const a = RAMP[i]!;
    const b = RAMP[i + 1]!;
    if (t >= a.t && t <= b.t) {
      lower = a;
      upper = b;
      break;
    }
  }
  const span = upper.t - lower.t;
  const k = span > 0 ? (t - lower.t) / span : 0;
  const r = Math.round(lower.rgb[0] + (upper.rgb[0] - lower.rgb[0]) * k);
  const g = Math.round(lower.rgb[1] + (upper.rgb[1] - lower.rgb[1]) * k);
  const b = Math.round(lower.rgb[2] + (upper.rgb[2] - lower.rgb[2]) * k);
  return `rgb(${r}, ${g}, ${b})`;
}

/** 当前设备像素比（Node 里没有 window，取 1 让纯逻辑断言也能跑） */
function currentDpr(): number {
  if (typeof window === 'undefined') return 1;
  const dpr = window.devicePixelRatio;
  if (!Number.isFinite(dpr) || dpr < 1) return 1;
  return Math.min(MAX_DPR, dpr);
}

/** 百分比文案：统一 1 位小数，面板上不应出现两种精度 */
function percent(ratio: number): string {
  return `${(Math.max(0, ratio) * 100).toFixed(1)}%`;
}

export class ContentStatsUI {
  private readonly canvas: HTMLCanvasElement | null;
  private readonly legend: HTMLElement | null;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly handlers: ContentStatsUIHandlers;
  private readonly listeners: { target: EventTarget; type: string; handler: EventListener }[] = [];

  /** 最近一次的统计结果：`setVisible(true)` 时要用它重画（隐藏期间画布尺寸是 0，画不了） */
  private lastStats: ContentStats | null = null;
  private visible = true;
  private disposed = false;
  /** 已经报过的错误文案：同一条只报一次，不然每帧一条 toast 会把界面淹掉 */
  private reportedError = '';

  constructor(
    canvas: HTMLCanvasElement | null,
    legend: HTMLElement | null,
    handlers: ContentStatsUIHandlers = {},
  ) {
    this.canvas = canvas;
    this.legend = legend;
    this.handlers = handlers;
    // getContext 在"canvas 已被别的模块拿走上下文"或非浏览器环境下会返回 null，
    // 也有的环境直接抛 —— 两种都当"没有 2D 上下文"处理，面板退化成只有图例
    let ctx: CanvasRenderingContext2D | null = null;
    if (canvas) {
      try {
        ctx = canvas.getContext('2d');
      } catch {
        ctx = null;
      }
    }
    this.ctx = ctx;

    // 屏幕旋转 / 窗口缩放 / 系统缩放都会触发 resize，重画一次即可。
    // 不监听 devicePixelRatio 的 matchMedia 变化：它和 resize 高度重合，多一条监听只是多一处要摘的引用。
    if (typeof window !== 'undefined') this.on(window, 'resize', () => this.render());
    this.render();
  }

  /** 注册监听并记下来，`dispose()` 时逐个摘掉（与 MemoryPanel 同一套写法） */
  private on(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.listeners.push({ target, type, handler });
  }

  /**
   * 刷新面板。`null` = 还没统计出来（或世界尺寸不可用），此时显示「未统计」而不是抛异常 ——
   * Engine 的启动顺序里，UI 一定比第一次统计先建好，这条路径必然会走到。
   *
   * 这里**不做节流**：调用频率由 Engine 决定（它已经有"每 200ms 刷一次"的调度），
   * UI 再拦一道会让"玩家刚删完东西却看不到变化"。
   */
  update(stats: ContentStats | null): void {
    if (this.disposed) return;
    this.lastStats = stats;
    if (!this.visible) return; // 隐藏时只记数据，显示时统一重画（隐藏画布尺寸为 0，画出来是空的）
    this.render();
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.visible = visible;
    // 用 display 而不是从 DOM 里摘掉节点：摘掉再插回去会让 canvas 丢失上下文与尺寸，重画成本更高，
    // 而且 `.panel` 的布局会跟着跳一下
    const display = visible ? '' : 'none';
    if (this.canvas) this.canvas.style.display = display;
    if (this.legend) this.legend.style.display = display;
    if (visible) this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { target, type, handler } of this.listeners) target.removeEventListener(type, handler);
    this.listeners.length = 0;
    // 清掉自己画上去的内容：这两个节点是外部传进来的，dispose 之后它们可能被别的模块复用
    if (this.ctx && this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.legend) this.legend.textContent = '';
  }

  // ------------------------------------------------------------------ 绘制

  private render(): void {
    if (this.disposed) return;
    try {
      this.drawHeatmap(this.lastStats);
      this.renderLegend(this.lastStats);
    } catch (error: unknown) {
      // 一张统计图画不出来不该让整个界面停摆；如实把原因说出去，并且只说一次
      const detail = error instanceof Error ? error.message : String(error);
      const message = `内容使用统计图绘制失败：${detail}`;
      if (message !== this.reportedError) {
        this.reportedError = message;
        console.warn(message);
        this.handlers.onError?.(message);
      }
    }
  }

  private drawHeatmap(stats: ContentStats | null): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;

    const cssW = canvas.clientWidth || FALLBACK_W;
    const cssH = canvas.clientHeight || FALLBACK_H;
    if (cssW <= 0 || cssH <= 0) return; // 被 display:none 隐藏时不做无用的位图分配

    // 高分屏：位图按 dpr 放大、再用 setTransform 把坐标系拉回 CSS 像素，
    // 否则 canvas 里的文字（刻度、角标）在高分屏上会被拉伸成模糊的一团
    const dpr = currentDpr();
    const bitmapW = Math.max(1, Math.round(cssW * dpr));
    const bitmapH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bitmapW || canvas.height !== bitmapH) {
      canvas.width = bitmapW;
      canvas.height = bitmapH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, cssW, cssH);

    if (!stats) {
      drawWrappedText(ctx, '未统计', cssW, cssH, '还没有拿到统计结果（世界可能还没加载完）', TEXT_COLOR);
      return;
    }

    if (stats.bins.length === 0) {
      // 尺寸非法时**不画格子**：画一层假的分箱比什么都不画更容易被当成"真的分过箱"
      drawWrappedText(ctx, '分箱不可用', cssW, cssH, stats.binsUnavailableReason ?? '没有可用的分箱数据', WARN_COLOR);
      return;
    }

    const cols = stats.binCols;
    const rows = stats.binRows;
    if (cols <= 0 || rows <= 0) {
      drawWrappedText(ctx, '分箱不可用', cssW, cssH, '分箱尺寸是 0，无法画图', WARN_COLOR);
      return;
    }

    const cellW = cssW / cols;
    const cellH = cssH / rows;
    const empty = stats.maxBinCount === 0;

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const bin = stats.bins[row * cols + col];
        if (!bin) continue;
        const ratio = empty ? 0 : bin.count / stats.maxBinCount;
        ctx.fillStyle = heatColor(ratio);
        ctx.fillRect(col * cellW, row * cellH, cellW, cellH);
      }
    }

    // 网格线：格子太小（< 6px）时画线只会糊成一片灰，索性不画
    if (cellW >= 6 && cellH >= 6) {
      ctx.strokeStyle = GRID_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let col = 1; col < cols; col += 1) {
        const x = Math.round(col * cellW) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, cssH);
      }
      for (let row = 1; row < rows; row += 1) {
        const y = Math.round(row * cellH) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(cssW, y);
      }
      ctx.stroke();
    }

    if (empty) {
      // 全 0 的情况：网格照画（它表达"分箱是几 × 几"），但必须有一句话说明"为什么看不到热"
      drawWrappedText(
        ctx,
        '这张图里还没有可统计的物体',
        cssW,
        cssH,
        `分箱是 ${cols} × ${rows}，但每一格都是 0 个 —— 世界里还没有放置任何物体`,
        TEXT_COLOR,
      );
    }

    this.drawScale(ctx, cssW, cssH, stats.maxBinCount);
  }

  /**
   * 角落的刻度条：一条由冷到热的色带 + 0 / 中值 / 最大的数字 + 「最多 N 个/格」。
   *
   * 为什么必须有它 —— 一张纯色块的热力图如果不说"最热 = 多少个"，
   * 玩家无法判断"这一格是挤爆了还是才放了两个"，那这张图就只能当装饰。
   */
  private drawScale(ctx: CanvasRenderingContext2D, cssW: number, cssH: number, maxBinCount: number): void {
    const title = maxBinCount > 0 ? `最多 ${maxBinCount} 个/格` : '每格最多 0 个（还没有物体）';
    ctx.font = '600 11px system-ui, -apple-system, "PingFang SC", sans-serif';
    const titleWidth = ctx.measureText(title).width;
    const rampW = Math.min(120, Math.max(60, cssW * 0.38));
    const rampH = 8;
    const padX = 8;
    const boxW = Math.max(rampW, titleWidth) + padX * 2;
    const boxH = rampH + 34;
    const boxX = cssW - boxW - 8;
    const boxY = cssH - boxH - 8;

    // 半透明底板：不然色带会跟它下面那一格的温度颜色混在一起，刻度就读不出来了
    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(boxX, boxY, boxW, boxH);

    const rampX = boxX + padX;
    const rampY = boxY + 20;
    for (let i = 0; i < rampW; i += 1) {
      ctx.fillStyle = heatColor(rampW > 1 ? i / (rampW - 1) : 1);
      ctx.fillRect(rampX + i, rampY, 1, rampH);
    }

    // 三个刻度：0 / 一半 / 最大。中间刻度只在最大值 ≥ 2 时有意义（0 和 1 之间没有"一半"）
    ctx.strokeStyle = TEXT_COLOR;
    ctx.lineWidth = 1;
    const ticks = maxBinCount >= 2 ? [0, 0.5, 1] : [0, 1];
    ctx.beginPath();
    for (const t of ticks) {
      const x = Math.round(rampX + t * rampW) + 0.5;
      ctx.moveTo(x, rampY + rampH);
      ctx.lineTo(x, rampY + rampH + 4);
    }
    ctx.stroke();

    ctx.fillStyle = TEXT_COLOR;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(title, rampX, boxY + 14);

    ctx.fillStyle = DIM_TEXT;
    ctx.font = '10px system-ui, -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('0', rampX, rampY + rampH + 13);
    ctx.textAlign = 'right';
    ctx.fillText(`${maxBinCount}`, rampX + rampW, rampY + rampH + 13);
    if (maxBinCount >= 2) {
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(maxBinCount / 2)}`, rampX + rampW / 2, rampY + rampH + 13);
    }
  }

  // ------------------------------------------------------------------ 图例

  /**
   * 图例（DOM）。这里全部用 `textContent` 拼：未知 id 来自旧存档、模型名来自目录，
   * 都可能带 `<` `&` 这类字符，用 `innerHTML` 就等于把一个存档文件当成 HTML 执行。
   */
  private renderLegend(stats: ContentStats | null): void {
    const legend = this.legend;
    if (!legend) return;
    legend.textContent = '';

    if (!stats) {
      legend.appendChild(row('未统计', { dim: true }));
      return;
    }

    legend.appendChild(
      row(
        `共 ${stats.totalObjects} 个物体 ｜ 用到 ${stats.usedCatalogIds} / ${stats.totalCatalog} 种模型` +
          `（覆盖 ${percent(stats.coverage)}）`,
      ),
    );

    if (stats.bins.length === 0) {
      legend.appendChild(row(stats.binsUnavailableReason ?? '分箱不可用', { dim: true, warn: true }));
    } else {
      legend.appendChild(
        row(
          `分箱 ${stats.binCols} × ${stats.binRows} ｜ 最热的一格 ${stats.maxBinCount} 个` +
            '（图上格子等大，不按世界的实际米数等比）',
          { dim: true },
        ),
      );
    }

    legend.appendChild(row('分类用量（按数量降序，前 8 个）', { dim: true }));
    if (stats.categories.length === 0) {
      legend.appendChild(row('世界里还没有任何可归类的物体', { dim: true }));
    }
    for (const item of stats.categories.slice(0, LEGEND_CATEGORY_LIMIT)) {
      legend.appendChild(row(`${item.category}：${item.count} 个（占世界物体 ${percent(item.ratio)}）`));
    }
    const rest = stats.categories.length - LEGEND_CATEGORY_LIMIT;
    if (rest > 0) legend.appendChild(row(`另有 ${rest} 个分类未列出`, { dim: true }));

    if (stats.top.length > 0) {
      const names = stats.top
        .slice(0, LEGEND_TOP_LIMIT)
        .map((item) => `${item.name} ×${item.count}`)
        .join('、');
      legend.appendChild(row(`用得最多：${names}`, { dim: true }));
    }

    if (stats.unusedCategories.length > 0) {
      legend.appendChild(row(`一个都没放的分类：${stats.unusedCategories.join('、')}`, { dim: true }));
    }

    if (stats.unknownIds.length > 0) {
      // 醒目提示：这不是"统计不到"，而是存档里有目录查不到的模型 —— 玩家必须知道，
      // 否则他会以为统计漏数了（那些物体其实一个不少地计在总数里）
      const shown = stats.unknownIds.slice(0, UNKNOWN_ID_LIMIT).join('、');
      const more = stats.unknownIds.length > UNKNOWN_ID_LIMIT ? ' 等' : '';
      legend.appendChild(
        row(`⚠ 有 ${stats.unknownIds.length} 种模型在目录里查不到（可能来自旧版本存档）：${shown}${more}`, {
          warn: true,
        }),
      );
    }
  }
}

/** 图例里的一行 */
function row(text: string, opts: { dim?: boolean; warn?: boolean } = {}): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.whiteSpace = 'nowrap';
  el.style.overflow = 'hidden';
  el.style.textOverflow = 'ellipsis';
  if (opts.dim) el.style.opacity = '0.62';
  if (opts.warn) {
    el.style.color = WARN_COLOR;
    el.style.opacity = '1';
  }
  return el;
}

/**
 * 居中文字块：一行标题 + 一段说明，按画布宽度逐字换行。
 *
 * 逐字换行对中文是正确的做法（中文没有词间空格，`measureText` 逐字累加就是最准的折行），
 * 而且这段文字只在"没有数据 / 分箱不可用"时出现，不需要为它做更复杂的排版。
 */
function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  title: string,
  cssW: number,
  cssH: number,
  detail: string,
  titleColor: string,
): void {
  const maxWidth = Math.max(40, cssW - 24);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.font = '600 13px system-ui, -apple-system, "PingFang SC", sans-serif';
  const titleLines = wrapByChar(ctx, title, maxWidth);
  ctx.font = '11px system-ui, -apple-system, "PingFang SC", sans-serif';
  const detailLines = wrapByChar(ctx, detail, maxWidth);

  const lineH = 17;
  const totalH = (titleLines.length + detailLines.length + 1) * lineH;
  let y = Math.max(lineH, (cssH - totalH) / 2 + lineH);

  ctx.fillStyle = titleColor;
  ctx.font = '600 13px system-ui, -apple-system, "PingFang SC", sans-serif';
  for (const text of titleLines) {
    ctx.fillText(text, cssW / 2, y);
    y += lineH;
  }
  ctx.fillStyle = DIM_TEXT;
  ctx.font = '11px system-ui, -apple-system, "PingFang SC", sans-serif';
  for (const text of detailLines) {
    ctx.fillText(text, cssW / 2, y);
    y += lineH;
  }
}

/** 逐字累加折行（调用前必须先设好 `ctx.font`，否则量出来的宽度是别的字号的） */
function wrapByChar(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const ch of text) {
    const next = current + ch;
    if (current !== '' && ctx.measureText(next).width > maxWidth) {
      lines.push(current);
      current = ch;
    } else {
      current = next;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : [''];
}
