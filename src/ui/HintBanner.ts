/**
 * 顶部提示条（手势教学 / 操作反馈）。
 *
 * ## 和已有 `#toast` 的分工
 * - `#toast`（UISystem 里的 showToast）：屏幕**底部**、一句话、自动消失，
 *   用来报"刚刚发生了什么"（放置失败、已保存…）；
 * - `HintBanner`：屏幕**顶部**、可以带图标和动作按钮、**默认不自动消失**，
 *   用来做手势教学与操作引导 —— 比如"两指拖动可以旋转视角"，
 *   玩家没做这个动作之前它就不该自己走掉；`autoHideMs > 0` 时才计时。
 *
 * ## 使用约定
 * - **单例式**：`show()` 反复调用只替换同一个根元素的文字与按钮，不会越堆越多。
 *   元素在构造时创建并挂到 `document.body` 上，不依赖 index.html
 *   （那个文件由别人改，所以这里一个 id 都不查、也不写死任何 id）。
 * - 动作按钮点了**不自动关闭**（只回调 `onAction`），什么时候收工由调用方决定；
 *   另外给了一个 ✕ 关闭按钮 —— 因为默认不自动消失的提示条必须留一个手动退出口，
 *   否则在手机上会一直占着顶部。
 * - 层级 45：高过 toast(40) 与摇杆(25)，低于主菜单(50)，所以弹菜单时提示条在菜单下面。
 * - 无障碍：根元素 `role="status"` + `aria-live="polite"`，读屏会当成状态播报，
 *   而且不会打断用户正在听的内容；两个按钮都有中文 `aria-label`。
 *
 * ## 触碰目标
 * 动作按钮与关闭按钮都是 **44×44 CSS 像素**（无障碍指南的最小触控目标），
 * 提示条整体高约 56px。
 */

/** 提示条选项 */
export interface HintBannerOptions {
  /** 自动消失时间（毫秒）；0 = 不自动消失，默认 0 */
  autoHideMs?: number;
  /** 图标 emoji，默认 '💡' */
  icon?: string;
  /** 按钮文字；不传表示没有按钮 */
  actionLabel?: string;
}

const DEFAULT_ICON = '💡';
/** 距屏幕上边缘（安全区之外）的留白 */
const TOP_MARGIN = 10;
/** 淡入淡出的时长，要和下面 transition 里写的一致 */
const FADE_MS = 220;
/** 隐藏时的姿态：略微上移 + 透明，显示时回到 translateY(0) */
const HIDDEN_TRANSFORM = 'translate(-50%, -8px)';
const VISIBLE_TRANSFORM = 'translate(-50%, 0)';
/** 项目深色主题：与 src/style.css 的 :root 变量保持一致 */
const COLOR_PANEL_BG = 'rgba(16, 20, 24, 0.92)';
const COLOR_PANEL_BORDER = '#2b3640';
const COLOR_TEXT = '#d8e2ea';
const COLOR_TEXT_DIM = '#8b9aa8';
const COLOR_ACCENT = '#7fd06a';
const FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/** 内联样式统一走这里 */
function style(el: HTMLElement, patch: Record<string, string>): void {
  Object.assign(el.style, patch);
}

export class HintBanner {
  /** 点击动作按钮时触发 */
  onAction: (() => void) | null = null;
  /** 关闭时触发（无论是自动还是手动） */
  onClose: (() => void) | null = null;

  private readonly root: HTMLElement;
  private readonly iconEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly actionButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 等待"下一帧再淡入"的句柄；重复 show() 时要取消，避免排队 */
  private revealHandle: number | null = null;
  private visibleFlag = false;
  private disposed = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'hint-banner';
    // 无障碍：状态播报 + 不打断当前朗读
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    style(this.root, {
      position: 'fixed',
      left: '50%',
      top: `${TOP_MARGIN}px`,
      transform: HIDDEN_TRANSFORM,
      maxWidth: 'min(88vw, 420px)',
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 8px 6px 12px',
      background: COLOR_PANEL_BG,
      border: `1px solid ${COLOR_PANEL_BORDER}`,
      borderLeft: `3px solid ${COLOR_ACCENT}`,
      borderRadius: '10px',
      boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
      backdropFilter: 'blur(2px)',
      WebkitBackdropFilter: 'blur(2px)',
      color: COLOR_TEXT,
      fontFamily: FONT_STACK,
      fontSize: '12.5px',
      lineHeight: '1.45',
      textAlign: 'left',
      opacity: '0',
      // 初始不接收点击：没显示的时候不该挡住下面的手势
      pointerEvents: 'none',
      transition: `opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease`,
      willChange: 'transform, opacity',
      zIndex: '45',
    });

    this.iconEl = document.createElement('span');
    style(this.iconEl, {
      flex: '0 0 auto',
      fontSize: '16px',
      lineHeight: '1',
    });

    this.textEl = document.createElement('span');
    style(this.textEl, {
      flex: '1 1 auto',
      minWidth: '0px',
    });

    // 动作按钮：有 actionLabel 才显示
    this.actionButton = document.createElement('button');
    this.actionButton.type = 'button';
    this.actionButton.addEventListener('click', () => {
      // 点了动作按钮**不自动关闭**，由调用方决定什么时候 hide()
      this.onAction?.();
    });
    style(this.actionButton, {
      flex: '0 0 auto',
      display: 'none',
      // 44×44：无障碍最小触控目标
      minWidth: '44px',
      minHeight: '44px',
      padding: '0 12px',
      appearance: 'none',
      background: 'rgba(127, 208, 106, 0.16)',
      color: COLOR_ACCENT,
      border: `1px solid ${COLOR_ACCENT}`,
      borderRadius: '8px',
      fontFamily: FONT_STACK,
      fontSize: '12px',
      lineHeight: '1.2',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    });

    // 关闭按钮：不自动消失的提示条需要手动退出口
    this.closeButton = document.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.textContent = '✕';
    this.closeButton.setAttribute('aria-label', '关闭提示');
    this.closeButton.addEventListener('click', () => this.hide());
    style(this.closeButton, {
      flex: '0 0 auto',
      // 44×44：无障碍最小触控目标
      width: '44px',
      height: '44px',
      padding: '0px',
      appearance: 'none',
      background: 'transparent',
      color: COLOR_TEXT_DIM,
      border: `1px solid ${COLOR_PANEL_BORDER}`,
      borderRadius: '8px',
      fontFamily: FONT_STACK,
      fontSize: '14px',
      lineHeight: '1',
      cursor: 'pointer',
    });

    this.root.appendChild(this.iconEl);
    this.root.appendChild(this.textEl);
    this.root.appendChild(this.actionButton);
    this.root.appendChild(this.closeButton);
    // 自建元素直接挂 body：不改 index.html，Engine 也不用管挂载点
    document.body.appendChild(this.root);
  }

  /** 显示提示。重复调用会替换当前内容（不叠加）。 */
  show(text: string, options: HintBannerOptions = {}): void {
    if (this.disposed) return;

    this.iconEl.textContent = options.icon ?? DEFAULT_ICON;
    this.textEl.textContent = text;

    const actionLabel = options.actionLabel;
    if (actionLabel) {
      this.actionButton.textContent = actionLabel;
      this.actionButton.style.display = 'inline-block';
    } else {
      this.actionButton.style.display = 'none';
    }

    // 换内容就重置计时：新手势提示应该拿到完整的一轮时间
    this.clearTimer();
    const autoHideMs = options.autoHideMs ?? 0;
    if (autoHideMs > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.hide();
      }, autoHideMs);
    }

    if (this.visibleFlag) return; // 已经在显示：只换内容，不再播一次淡入
    this.visibleFlag = true;
    this.root.style.pointerEvents = 'auto';
    // 先落到"隐藏姿态"，下一帧再切到"显示姿态"，否则浏览器会合并两帧、transition 不触发
    this.root.style.opacity = '0';
    this.root.style.transform = HIDDEN_TRANSFORM;
    this.scheduleReveal();
  }

  /** 关闭 */
  hide(): void {
    if (this.disposed) return;
    this.clearTimer();
    if (this.revealHandle !== null) {
      cancelAnimationFrame(this.revealHandle);
      this.revealHandle = null;
    }
    if (!this.visibleFlag) return;
    this.visibleFlag = false;
    this.root.style.opacity = '0';
    this.root.style.transform = HIDDEN_TRANSFORM;
    // 淡出过程中也不再拦截触摸
    this.root.style.pointerEvents = 'none';
    this.onClose?.();
  }

  get isVisible(): boolean {
    return this.visibleFlag;
  }

  /** 屏幕方向/安全区变化时由 Engine 调用，调整顶部留白 */
  setSafeArea(top: number): void {
    if (this.disposed) return;
    this.root.style.top = `${Math.max(0, top) + TOP_MARGIN}px`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    if (this.revealHandle !== null) {
      cancelAnimationFrame(this.revealHandle);
      this.revealHandle = null;
    }
    this.visibleFlag = false;
    this.onAction = null;
    this.onClose = null;
    this.root.remove();
  }

  /** 下一帧才淡入，让上面的"隐藏姿态"先落地 */
  private scheduleReveal(): void {
    if (this.revealHandle !== null) cancelAnimationFrame(this.revealHandle);
    this.revealHandle = requestAnimationFrame(() => {
      this.revealHandle = null;
      if (this.disposed || !this.visibleFlag) return;
      this.root.style.opacity = '1';
      this.root.style.transform = VISIBLE_TRANSFORM;
    });
  }

  /** 计时器一定要清干净：否则 hide() 之后旧计时器还会再"关"一次 */
  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
