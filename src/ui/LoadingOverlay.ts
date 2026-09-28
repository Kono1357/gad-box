/**
 * 加载遮罩（补充 3：地图切换的淡入淡出 + 进度条）。
 *
 * 换地图时画面要经历「卸载旧的 → 生成新的 → 重建网格」三段空白，
 * 如果什么都不盖，玩家会看到地形一块块突然消失又突然出现，很像崩了。
 * 所以这里做两件事：
 *
 * 1. **黑幕淡变**：`fadeOut()` 把不透明黑幕淡入（遮住卸载过程），
 *    `fadeIn()` 淡出（露出新世界）。淡淡的一层，不做花哨动画——低配手机上动画本身就是负担。
 * 2. **阶段进度**：显示当前阶段的中文名 + 百分比 + 一条细进度条，
 *    让「几百毫秒的等待」有明确预期，而不是一个转圈的菊花。
 *
 * DOM 在构造函数里现建并挂到 `body`，不依赖 index.html ——
 * 因为这是一个「出问题时才最重要」的组件：如果它依赖的 id 在 HTML 里被改坏了，
 * 恰恰是在换地图这种关键路径上白屏，那才是最糟的失败模式。
 */

/** 淡变时长（毫秒）。太长会让玩家觉得卡，太短会闪。 */
const FADE_MS = 220;

export interface LoadingOverlayOptions {
  /** 主标题，默认「正在生成世界」 */
  title?: string;
  /** 是否显示百分比数字 */
  showPercent?: boolean;
}

export class LoadingOverlay {
  private readonly root: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly stageEl: HTMLDivElement;
  private readonly barEl: HTMLDivElement;
  private readonly detailEl: HTMLDivElement;
  private readonly percentEl: HTMLDivElement;

  private readonly options: Required<LoadingOverlayOptions>;
  private hideTimer = 0;
  /** 淡出（遮住画面）是否已经完成 */
  private opaque = false;

  constructor(options: LoadingOverlayOptions = {}) {
    this.options = { title: options.title ?? '正在生成世界', showPercent: options.showPercent ?? true };

    this.root = document.createElement('div');
    this.root.id = 'loading-overlay';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    Object.assign(this.root.style, {
      position: 'fixed',
      inset: '0',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      gap: '14px',
      background: 'rgba(8, 11, 15, 0.94)',
      color: '#e8eef5',
      font: '14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
      opacity: '0',
      transition: `opacity ${FADE_MS}ms ease`,
      zIndex: '960',
      pointerEvents: 'auto',
      padding: '24px',
      textAlign: 'center',
    } satisfies Partial<CSSStyleDeclaration>);

    this.titleEl = document.createElement('div');
    Object.assign(this.titleEl.style, { fontSize: '18px', fontWeight: '600', letterSpacing: '0.02em' });
    this.titleEl.textContent = this.options.title;

    this.barEl = document.createElement('div');
    Object.assign(this.barEl.style, {
      width: 'min(320px, 70vw)',
      height: '4px',
      borderRadius: '999px',
      background: 'rgba(255,255,255,0.14)',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);
    const fill = document.createElement('div');
    Object.assign(fill.style, {
      width: '0%',
      height: '100%',
      borderRadius: '999px',
      background: 'linear-gradient(90deg, #4ade80, #38bdf8)',
      transition: 'width 160ms ease',
    } satisfies Partial<CSSStyleDeclaration>);
    this.barEl.appendChild(fill);

    this.stageEl = document.createElement('div');
    Object.assign(this.stageEl.style, { fontSize: '13px', color: '#b9c6d4', minHeight: '1.2em' });

    this.detailEl = document.createElement('div');
    Object.assign(this.detailEl.style, { fontSize: '12px', color: '#7c8b9c', maxWidth: 'min(420px, 80vw)' });

    this.percentEl = document.createElement('div');
    Object.assign(this.percentEl.style, { fontSize: '12px', color: '#7c8b9c' });
    this.percentEl.style.display = this.options.showPercent ? 'block' : 'none';

    this.root.append(this.titleEl, this.barEl, this.stageEl, this.percentEl, this.detailEl);
    document.body.appendChild(this.root);
  }

  get isVisible(): boolean {
    return this.root.style.display !== 'none';
  }

  /** 是否已经完全遮住画面（此时可以安全地拆旧世界） */
  get isOpaque(): boolean {
    return this.opaque;
  }

  /**
   * 显示遮罩并淡到不透明。返回的 Promise 在淡变完成后 resolve ——
   * 调用方 `await overlay.fadeOut()` 之后再拆世界，玩家就不会看到拆的过程。
   */
  async fadeOut(title?: string): Promise<void> {
    if (title) this.titleEl.textContent = title;
    window.clearTimeout(this.hideTimer);
    this.root.style.display = 'flex';
    // 强制一次重排，否则 display:none → flex 与 opacity 0 → 1 会被合并成一帧，动画不播
    void this.root.offsetHeight;
    this.root.style.opacity = '1';
    await wait(FADE_MS);
    this.opaque = true;
  }

  /** 立即显示（不等待淡变），用于同步路径 */
  showImmediate(title?: string): void {
    if (title) this.titleEl.textContent = title;
    window.clearTimeout(this.hideTimer);
    this.root.style.display = 'flex';
    this.root.style.opacity = '1';
    this.opaque = true;
  }

  /** 更新进度：`progress` 为 0..1 */
  setProgress(progress: number, stageLabel?: string, detail?: string): void {
    const clamped = Math.max(0, Math.min(1, progress));
    const fill = this.barEl.firstElementChild as HTMLDivElement | null;
    if (fill) fill.style.width = `${(clamped * 100).toFixed(0)}%`;
    this.percentEl.textContent = `${(clamped * 100).toFixed(0)}%`;
    if (stageLabel !== undefined) this.stageEl.textContent = stageLabel;
    if (detail !== undefined) this.detailEl.textContent = detail;
  }

  /** 淡出遮罩（露出新世界） */
  async fadeIn(): Promise<void> {
    this.root.style.opacity = '0';
    this.opaque = false;
    await wait(FADE_MS);
    this.root.style.display = 'none';
  }

  /** 不等待的版本：立刻藏起来（出错兜底路径用） */
  hideImmediate(): void {
    window.clearTimeout(this.hideTimer);
    this.root.style.display = 'none';
    this.root.style.opacity = '0';
    this.opaque = false;
  }

  /** 在遮罩上显示一行错误（加载失败时用，保持可见让玩家能读到原因） */
  showError(message: string): void {
    this.titleEl.textContent = '加载失败';
    this.stageEl.textContent = message;
    this.detailEl.textContent = '旧世界已经被卸载，请重新选择地图；如果反复失败请刷新页面。';
    this.root.style.display = 'flex';
    void this.root.offsetHeight;
    this.root.style.opacity = '1';
    this.opaque = true;
    // 出错不自动消失——让玩家看清楚；由调用方在下次加载时覆盖
    this.hideTimer = window.setTimeout(() => {
      void this.fadeIn();
    }, 4200);
  }

  dispose(): void {
    window.clearTimeout(this.hideTimer);
    this.root.remove();
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
