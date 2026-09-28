/**
 * 屏幕方向监听：移动端 UI 布局的唯一依据。
 *
 * ## 为什么需要它
 *
 * 手机上竖屏和横屏是两套完全不同的布局：
 * - **竖屏**：屏幕高、宽度窄，工具栏要放在底部（拇指够得着），
 *   左右两侧的面板必须收起来，否则中间的可视区只剩一条缝；
 * - **横屏**：宽度大、高度小，面板可以常驻左右两侧，顶部条要压扁。
 *
 * 引擎只需要在方向真变化时重建一次 UI，不需要每帧判断 ——
 * 所以这里是一个**带防抖的被动监听器**，不是每帧查询的工具函数。
 *
 * ## 为什么必须防抖
 *
 * iOS Safari 旋转屏幕时会**连续发好几次** `resize` 和 `orientationchange`，
 * 而且第一次触发时 `innerWidth/innerHeight` 往往还是旧值（动画没走完），
 * 中间还会经过一些"宽度高度都不对"的瞬时状态。
 * 如果每次都重建 UI，会看到面板疯狂闪烁、甚至点不中按钮。
 * 这里的做法是：任意事件都只是**重置 120ms 计时器**，等安静下来再读一次真实尺寸。
 * （用 `requestAnimationFrame` 也能合并到一帧，但旋转动画期间 rAF 一直在跑，
 * 反而会在一秒内触发十几次；120ms 的静默窗口对旋转动画刚刚好。）
 *
 * Node 下 import 本模块不会崩：所有 `window` / `screen` 访问都在函数体内，
 * 且先做 `typeof` 判断。
 */

/** 屏幕方向（只关心竖/横，`portrait-primary` 这些细分交给 `screen.orientation.type`） */
export type ScreenOrientation = 'portrait' | 'landscape';

export interface OrientationInfo {
  orientation: ScreenOrientation;
  width: number;
  height: number;
  /** 是否窄屏（宽度 < 600），决定移动端 UI 布局 */
  isNarrow: boolean;
}

/** 窄屏阈值（CSS 像素）：600 是"手机竖屏 / 小平板"的分界，UI 层改布局时用它 */
export const NARROW_MAX_WIDTH = 600;

/** 旋转防抖窗口（毫秒）：见文件头注释，120ms 刚好压住 iOS 的连发 */
export const ORIENTATION_DEBOUNCE_MS = 120;

export class OrientationWatcher {
  /** 监听是否已开启（start/stop 可重复调用，不会重复挂监听） */
  private started = false;
  private debounceTimer: number | null = null;

  constructor(private readonly onChange: (info: OrientationInfo) => void) {}

  /**
   * 读一次当前状态（构造时也会自动读一次并触发回调？—— 不触发，只返回）。
   * 首次布局由调用方用 `current()` 拿初始值。
   */
  current(): OrientationInfo {
    const { width, height } = this.readViewport();
    return {
      orientation: this.readOrientation(width, height),
      width,
      height,
      isNarrow: width < NARROW_MAX_WIDTH,
    };
  }

  /** 开始监听 resize / orientationchange / screen.orientation.change */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (typeof window === 'undefined') return; // Node / 非浏览器：静默降级，current() 仍可用

    window.addEventListener('resize', this.schedule);
    window.addEventListener('orientationchange', this.schedule);
    try {
      const orientation = typeof screen !== 'undefined' ? screen.orientation : undefined;
      // `screen.orientation` 是较新的 API（Safari 16.4+），老浏览器只有 orientationchange
      if (orientation && typeof orientation.addEventListener === 'function') {
        orientation.addEventListener('change', this.schedule);
      }
    } catch {
      /* 拿不到就算了，resize 已经够用 */
    }
  }

  stop(): void {
    this.started = false;
    if (typeof window === 'undefined') return;

    window.removeEventListener('resize', this.schedule);
    window.removeEventListener('orientationchange', this.schedule);
    try {
      const orientation = typeof screen !== 'undefined' ? screen.orientation : undefined;
      if (orientation && typeof orientation.removeEventListener === 'function') {
        orientation.removeEventListener('change', this.schedule);
      }
    } catch {
      /* 忽略 */
    }
    this.clearDebounce();
  }

  /**
   * 本类没有别的资源（没有 WebGL 上下文、没有 Worker），
   * dispose 与 stop 等价；分开成两个名字只是为了和项目里其它系统的命名习惯一致。
   */
  dispose(): void {
    this.stop();
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 事件只是"重置计时器"，真正的读取发生在静默 120ms 之后 ——
   * 这样 iOS 旋转期间的一串事件只会换来一次回调。箭头函数属性，方便 add/remove 对称。
   */
  private readonly schedule = (): void => {
    this.clearDebounce();
    if (typeof window === 'undefined') return;
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      if (!this.started) return;
      this.onChange(this.current());
    }, ORIENTATION_DEBOUNCE_MS);
  };

  private clearDebounce(): void {
    if (this.debounceTimer === null) return;
    if (typeof window !== 'undefined') window.clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  /** 视口尺寸：非浏览器环境返回 0×0 */
  private readViewport(): { width: number; height: number } {
    try {
      if (typeof window === 'undefined') return { width: 0, height: 0 };
      const width = window.innerWidth || 0;
      const height = window.innerHeight || 0;
      if (width > 0 && height > 0) return { width, height };
      // 极少数 WebView 里 innerWidth 是 0（还没完成布局），退回 screen
      const screenWidth = window.screen?.width ?? 0;
      const screenHeight = window.screen?.height ?? 0;
      return { width: screenWidth || width, height: screenHeight || height };
    } catch {
      return { width: 0, height: 0 };
    }
  }

  /** 优先用 `screen.orientation.type`，拿不到就比尺寸（两者结论一致） */
  private readOrientation(width: number, height: number): ScreenOrientation {
    try {
      if (typeof screen !== 'undefined') {
        const type = screen.orientation?.type;
        if (typeof type === 'string' && type.length > 0) {
          return type.startsWith('portrait') ? 'portrait' : 'landscape';
        }
      }
    } catch {
      /* 忽略，走尺寸比较 */
    }
    // 尺寸相等（含 0×0 的非浏览器环境）按竖屏算：手机默认握法就是竖屏
    return width > height ? 'landscape' : 'portrait';
  }
}
