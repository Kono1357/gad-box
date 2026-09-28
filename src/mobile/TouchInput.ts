/**
 * 触屏手势层：把 Pointer Events 揉成"沙盘能用"的语义手势。
 *
 * ## 为什么是独立一层，而不是继续用 `InputSystem`
 *
 * `InputSystem` 的触摸映射是"1 指 = 画地形，2 指 = 平移 + 捏合"，那是**鼠标优先**的思路
 * （右键平移 / 左键绘制），搬到手机上会出现两个硬伤：
 * 1. 手指点不到的精度问题 —— 手机上需要"拖动时把光标挂在手指上"这种跟随语义，
 *    而不是鼠标那种"移动就画"；
 * 2. 手机上"轻点一下"和"按住不放"必须是两个不同动作（放置 / 拾取），
 *    鼠标没有这种区分。
 *
 * 所以这里给触屏单独做一套：**单指瞄准、双指转镜头、轻点放置**。
 *
 * ## 手势映射（Engine 拿到 `GestureEvent.kind` 后的默认打算）
 *
 * | 手势          | 触发方式                              | 沙盘里的语义                     |
 * | ------------- | ------------------------------------- | -------------------------------- |
 * | `drag`        | 单指按下后位移超过 `tapMaxMove`       | 光标跟随手指（瞄准 / 连续绘制）  |
 * | `tap`         | 单指轻点：位移小、时长 < `tapMaxMs`   | 在光标处放置                     |
 * | `doubletap`   | 两次 tap 间隔 < `doubleTapMs`         | 取消 / 确认（由 Engine 决定）    |
 * | `longpress`   | 单指按住 ≥ `longPressMs` 且几乎没动   | 拿起物体                         |
 * | `swipe`       | 单指快速滑动（速度 > `swipeSpeed`）   | 视角快速平移 / 切候选点          |
 * | `orbit`       | 双指中点位移                          | 旋转镜头                         |
 * | `pinch`       | 双指间距变化                          | 缩放（拉远拉近）                 |
 *
 * ## 为什么不用 Hammer.js（或任何手势库）
 *
 * - **零依赖**：项目只依赖 three + rapier，手势库是最不值得进 `package.json` 的那类依赖；
 *   打包体积（Hammer 压缩后仍有 ~20KB）+ 额外的类型定义，对一个沙盘来说不划算。
 * - **Pointer Events 已经够了**：`pointerdown/move/up/cancel` + `setPointerCapture`
 *   天然统一了触摸 / 鼠标 / 触控笔，鼠标在桌面上还能直接调这套逻辑，方便调试。
 * - **语义对不上**：Hammer 的 recognizer（pan/swipe/pinch/rotate）是通用抽象，
 *   我们要的是"轻点放置、按住拾取"这种带**互斥关系**的判定（tap 与 swipe 互斥、
 *   双指一出现就作废单指待定判定），自己写反而更短更准。
 *
 * 注意：本文件只做**手势识别**，不碰相机、不碰世界状态 —— 那些由 Engine 决定。
 * 也**不 import `InputSystem`**：两者是并列的可选输入层（触屏设备用这套替代/补充它），
 * 互相之间不应该有依赖。
 */

/** 手势种类 */
export type GestureKind =
  | 'tap' // 单指轻点 → 放置
  | 'doubletap' // 单指双击 → 取消/确认（Engine 决定）
  | 'longpress' // 单指长按 → 拿起物体
  | 'drag' // 单指拖动 → 光标跟随手指（瞄准）
  | 'orbit' // 双指同向拖动 → 旋转镜头
  | 'pinch' // 双指开合 → 缩放
  | 'swipe'; // 单指快速滑动 → 视角快速平移/切候选

export interface GestureEvent {
  kind: GestureKind;
  /** 视口坐标（CSS 像素） */
  x: number;
  y: number;
  /** 相对本次手势起点的位移 */
  dx: number;
  dy: number;
  /** pinch 用：两指距离 / 起始距离（无缩放时为 1） */
  scale: number;
  /** 缩放/平移增量（Engine 直接可用） */
  deltaScale: number;
  /** 事件发生时的指针数 */
  pointerCount: number;
  /** 从手势开始到现在的毫秒数 */
  durationMs: number;
  /** 归一化设备坐标 -1..1（y 已翻转为 Three.js 约定） */
  ndcX: number;
  ndcY: number;
}

export interface TouchInputOptions {
  /** 判定为 tap 的最大位移（CSS 像素），默认 12 */
  tapMaxMove?: number;
  /** 判定为 tap 的最大时长（毫秒），默认 320 */
  tapMaxMs?: number;
  /** 长按阈值（毫秒），默认 550 */
  longPressMs?: number;
  /** 长按期间最大位移，默认 10 */
  longPressMaxMove?: number;
  /** 双击间隔上限（毫秒），默认 300 */
  doubleTapMs?: number;
  /** 触发 swipe 的最小速度（像素/毫秒），默认 0.7 */
  swipeSpeed?: number;
}

/**
 * 默认阈值。
 *
 * 这些数字是按"手指很粗、屏幕很小"调的，不是拍脑袋：
 * - `tapMaxMove` 12px：手指按下去天然会抖 3~8px，给到 12 才能"点得动"；
 *   同时 12px 只占 6.1 寸手机短边的 3%，不会把"想拖动"误判成"想点"。
 * - `tapMaxMs` 320ms：普通人轻点 100~200ms，长按 600ms 以上，320 正好卡在中间。
 * - `longPressMs` 550ms：比 iOS 的 500ms 略长，避免"想放置却拿起"。
 * - `doubleTapMs` 300ms：与系统双击间隔（iOS 300 / Android 300）保持一致。
 * - `swipeSpeed` 0.7px/ms：约 420px/s，慢于这个速度的拖动一律当"瞄准拖动"处理。
 */
export const DEFAULT_TOUCH_OPTIONS: Readonly<Required<TouchInputOptions>> = {
  tapMaxMove: 12,
  tapMaxMs: 320,
  longPressMs: 550,
  longPressMaxMove: 10,
  doubleTapMs: 300,
  swipeSpeed: 0.7,
};

/**
 * 双指判定的两个死区（CSS 像素）。
 *
 * 判据：把"间距变化"和"中点位移"各自除以自己的死区，得到两个强度值，
 * 谁大听谁的 —— 同一次 pointermove **只会发一条** orbit 或 pinch，
 * 免得引擎既要转镜头又要缩放，手感发飘。
 * 两个都没超过死区就什么也不发（手指按住时的细微抖动）。
 */
const PINCH_DEAD_ZONE_PX = 6;
const ORBIT_DEAD_ZONE_PX = 4;

/** 单个指针的状态：当前位置 + 起点（起点用于算"相对手势起点的位移"） */
interface PointState {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTime: number;
}

/**
 * 定时器兜底。
 *
 * 浏览器里用 `window.setTimeout`；Node 里没有 `window`，退回 `globalThis.setTimeout` ——
 * 这样长按计时器在（没有 DOM 的）Node 冒烟测试里也能真的跑起来，行为可验证。
 * 两个都不存在时才返回 0（等价于"取消"）。
 */
function setTimer(handler: () => void, ms: number): number {
  if (typeof window !== 'undefined') return window.setTimeout(handler, ms);
  const host = globalThis as { setTimeout?: (h: () => void, delay: number) => unknown };
  if (typeof host.setTimeout === 'function') return Number(host.setTimeout(handler, ms));
  return 0;
}

function clearTimer(id: number | null): void {
  if (id === null || id === 0) return;
  if (typeof window !== 'undefined') {
    window.clearTimeout(id);
    return;
  }
  const host = globalThis as { clearTimeout?: (handle: number) => void };
  if (typeof host.clearTimeout === 'function') host.clearTimeout(id);
}

export class TouchInput {
  /** 手势回调（Engine 的总入口） */
  onGesture: ((event: GestureEvent) => void) | null = null;

  /**
   * 光标位置变化（单指按下并移动，或按住不动时也每帧报点）——
   * 用于「光标跟随手指」。
   * `active = false` 表示本次手势序列结束（手指全抬起 / 被 setEnabled(false) 打断），
   * 引擎可以据此隐藏光标或停止预览。
   */
  onCursor: ((ndc: { x: number; y: number }, active: boolean) => void) | null = null;

  /** 是否真的在触屏设备上（`'ontouchstart' in window || navigator.maxTouchPoints > 0`） */
  readonly isTouchDevice: boolean;

  private readonly options: Required<TouchInputOptions>;
  /** 当前按下的指针（Map 的插入顺序就是按下顺序，"前两根"即双指手势参与者） */
  private readonly pointers = new Map<number, PointState>();

  private enabled = true;
  private disposed = false;

  // ---- 单指序列状态 ----
  private singleStartTime = 0;
  private movedBeyondTap = false;
  private longPressFired = false;
  private longPressTimer: number | null = null;

  // ---- 双指序列状态 ----
  private multiStartTime = 0;
  private readonly multiStartCenter = { x: 0, y: 0 };
  private pinchStartDistance = 0;
  private lastPinchDistance = 0;
  private readonly lastPinchCenter = { x: 0, y: 0 };
  /** 上一次真正发出的 pinch 的 scale，用于算 deltaScale */
  private lastScale = 1;
  /** 一旦出现过双指，本次序列就不再产生单指手势（抬起第一根后依然作废） */
  private sequenceCanceled = false;

  // ---- 双击判定 ----
  private lastTapTime = 0;

  // ---- 光标帧循环 ----
  private cursorFrame = 0;
  private cursorLoopRunning = false;
  /** 本帧内是否已经有 move 报过点（没报过就在 rAF 里补一次，实现"按住不动也报点"） */
  private movedSinceTick = false;
  private readonly lastNdc = { x: 0, y: 0 };

  constructor(
    private readonly element: HTMLElement,
    options: TouchInputOptions = {},
  ) {
    this.options = { ...DEFAULT_TOUCH_OPTIONS, ...options };

    const hasTouch =
      typeof window !== 'undefined' &&
      ('ontouchstart' in window ||
        (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));
    this.isTouchDevice = hasTouch;

    // touch-action: none 关掉浏览器的滚动 / 双击缩放，否则拖动会被浏览器"抢走"一半手势。
    // 记下原值没意义 —— 调用方几乎都是 canvas，dispose 还原成 '' 就够了。
    this.element.style.touchAction = 'none';

    this.element.addEventListener('pointerdown', this.handlePointerDown);
    this.element.addEventListener('pointermove', this.handlePointerMove);
    this.element.addEventListener('pointerup', this.handlePointerUp);
    this.element.addEventListener('pointercancel', this.handlePointerCancel);
    this.element.addEventListener('contextmenu', this.handleContextMenu);
  }

  // ---------------------------------------------------------------- 状态查询

  /** 当前活跃指针数 */
  get pointerCount(): number {
    return this.pointers.size;
  }

  /** 暂停手势（例如 UI 弹窗打开时）：清掉所有待定计时器、重置指针表 */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) return;

    for (const id of [...this.pointers.keys()]) {
      try {
        this.element.releasePointerCapture(id);
      } catch {
        /* 没捕获成功过就会抛，忽略 */
      }
    }
    this.resetSequence();
    this.lastTapTime = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resetSequence();
    this.element.removeEventListener('pointerdown', this.handlePointerDown);
    this.element.removeEventListener('pointermove', this.handlePointerMove);
    this.element.removeEventListener('pointerup', this.handlePointerUp);
    this.element.removeEventListener('pointercancel', this.handlePointerCancel);
    this.element.removeEventListener('contextmenu', this.handleContextMenu);
    this.element.style.touchAction = '';
  }

  // ---------------------------------------------------------------- 工具

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** 视口坐标 → NDC（y 翻转成 Three.js 约定：底 -1、顶 1） */
  private toNdc(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((clientY - rect.top) / rect.height) * 2 - 1),
    };
  }

  /** 取按下的前两根手指（Map 插入顺序 = 按下顺序） */
  private firstTwoPointers(): [PointState | undefined, PointState | undefined] {
    const list = [...this.pointers.values()];
    return [list[0], list[1]];
  }

  private firstPointer(): PointState | undefined {
    return this.pointers.values().next().value;
  }

  private clearLongPressTimer(): void {
    clearTimer(this.longPressTimer);
    this.longPressTimer = null;
  }

  private emit(
    kind: GestureKind,
    x: number,
    y: number,
    dx: number,
    dy: number,
    scale: number,
    deltaScale: number,
    durationMs: number,
    pointerCount: number,
  ): void {
    const handler = this.onGesture;
    if (!handler) return;
    const ndc = this.toNdc(x, y);
    handler({
      kind,
      x,
      y,
      dx,
      dy,
      scale,
      deltaScale,
      pointerCount,
      durationMs: Math.max(0, durationMs),
      ndcX: ndc.x,
      ndcY: ndc.y,
    });
  }

  /** 报一次光标；`active = false` 用于序列结束 */
  private reportCursorAt(clientX: number, clientY: number, active: boolean): void {
    const ndc = this.toNdc(clientX, clientY);
    this.lastNdc.x = ndc.x;
    this.lastNdc.y = ndc.y;
    this.onCursor?.(ndc, active);
  }

  // ---------------------------------------------------------------- 光标帧循环

  /**
   * 单指按住不动时浏览器不发 pointermove，但引擎需要每帧都有光标位置
   * （射线拾取要跟着相机 / 世界变化重算，否则预览框会"冻住"）。
   * 所以这里起一个 rAF 循环：本帧没有 move 事件补报一次，有就不重复报。
   */
  private startCursorLoop(): void {
    if (this.cursorLoopRunning) return;
    if (typeof requestAnimationFrame !== 'function') return;
    this.cursorLoopRunning = true;
    const tick = (): void => {
      if (!this.cursorLoopRunning) return;
      this.cursorFrame = requestAnimationFrame(tick);
      if (!this.movedSinceTick && !this.sequenceCanceled && this.pointers.size === 1) {
        const p = this.firstPointer();
        if (p) this.reportCursorAt(p.x, p.y, true);
      }
      this.movedSinceTick = false;
    };
    this.cursorFrame = requestAnimationFrame(tick);
  }

  private stopCursorLoop(): void {
    this.cursorLoopRunning = false;
    if (this.cursorFrame !== 0 && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.cursorFrame);
    }
    this.cursorFrame = 0;
  }

  // ---------------------------------------------------------------- 序列生命周期

  /** 单指序列开始：起长按计时器、准备光标循环 */
  private beginSingle(): void {
    const now = this.now();
    this.singleStartTime = now;
    this.movedBeyondTap = false;
    this.longPressFired = false;
    this.sequenceCanceled = false;
    this.movedSinceTick = false;
    this.clearLongPressTimer();
    // 长按在**计时到点的那一刻**就发，不等抬手 —— 拿起物体要有即时反馈
    this.longPressTimer = setTimer(() => {
      this.longPressTimer = null;
      if (!this.enabled || this.disposed) return;
      if (this.pointers.size !== 1 || this.movedBeyondTap || this.sequenceCanceled) return;
      const p = this.firstPointer();
      if (!p) return;
      this.longPressFired = true;
      this.lastTapTime = 0;
      this.emit('longpress', p.x, p.y, p.x - p.startX, p.y - p.startY, 1, 0, this.now() - this.singleStartTime, 1);
    }, this.options.longPressMs);
    this.startCursorLoop();
  }

  /** 双指序列开始：立刻作废所有单指待定判定（计时器 / tap / 长按） */
  private beginMulti(): void {
    const now = this.now();
    this.clearLongPressTimer();
    this.sequenceCanceled = true;
    this.movedBeyondTap = true; // 兜底：即便 sequenceCanceled 被清掉也不可能再判 tap
    this.multiStartTime = now;

    const [a, b] = this.firstTwoPointers();
    if (!a || !b) return;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    this.pinchStartDistance = distance;
    this.lastPinchDistance = distance;
    this.lastScale = 1;
    this.lastPinchCenter.x = (a.x + b.x) / 2;
    this.lastPinchCenter.y = (a.y + b.y) / 2;
    this.multiStartCenter.x = this.lastPinchCenter.x;
    this.multiStartCenter.y = this.lastPinchCenter.y;

    // 双指期间不提供"光标跟随"，明确告诉引擎光标失效
    this.onCursor?.(this.lastNdc, false);
  }

  /** 指针数归零：重置所有状态 */
  private resetSequence(): void {
    this.clearLongPressTimer();
    this.pointers.clear();
    this.movedBeyondTap = false;
    this.longPressFired = false;
    this.sequenceCanceled = false;
    this.movedSinceTick = false;
    this.pinchStartDistance = 0;
    this.lastPinchDistance = 0;
    this.lastScale = 1;
    this.stopCursorLoop();
    this.onCursor?.(this.lastNdc, false);
  }

  // ---------------------------------------------------------------- 事件处理

  private handleContextMenu = (ev: Event): void => {
    ev.preventDefault();
  };

  private handlePointerDown = (ev: PointerEvent): void => {
    if (!this.enabled || this.disposed) return;
    try {
      this.element.setPointerCapture(ev.pointerId);
    } catch {
      /* 某些浏览器对已捕获的指针会抛错，忽略即可 */
    }

    this.pointers.set(ev.pointerId, {
      x: ev.clientX,
      y: ev.clientY,
      startX: ev.clientX,
      startY: ev.clientY,
      startTime: this.now(),
    });

    if (this.pointers.size === 1) {
      this.beginSingle();
      this.movedSinceTick = true;
      this.reportCursorAt(ev.clientX, ev.clientY, true);
    } else {
      // 第二根手指（或第三根）落下 → 单指判定全部作废，转入双指手势
      this.beginMulti();
    }
  };

  private handlePointerMove = (ev: PointerEvent): void => {
    if (!this.enabled || this.disposed) return;
    const state = this.pointers.get(ev.pointerId);
    if (!state) return; // 没按下的指针（鼠标悬停）不参与手势
    state.x = ev.clientX;
    state.y = ev.clientY;

    if (this.pointers.size >= 2) {
      this.updateMulti();
      return;
    }
    if (this.sequenceCanceled) return; // 双指里剩下的那根手指：本序列不再产生单指手势

    // 单指：拖动过程中每次都报光标（瞄准）
    this.movedSinceTick = true;
    this.reportCursorAt(ev.clientX, ev.clientY, true);

    const dx = ev.clientX - state.startX;
    const dy = ev.clientY - state.startY;
    const distance = Math.hypot(dx, dy);

    // 长按期间动太多 → 作废长按（但可能还是 tap，取决于是否超过 tapMaxMove）
    if (distance > this.options.longPressMaxMove) this.clearLongPressTimer();

    if (!this.movedBeyondTap && distance > this.options.tapMaxMove) {
      this.movedBeyondTap = true;
      this.lastTapTime = 0; // 中间夹了一次拖动，不该再和上一次轻点凑成双击
    }

    if (this.movedBeyondTap) {
      this.emit('drag', ev.clientX, ev.clientY, dx, dy, 1, 0, this.now() - this.singleStartTime, 1);
    }
  };

  private handlePointerUp = (ev: PointerEvent): void => {
    this.endPointer(ev, false);
  };

  private handlePointerCancel = (ev: PointerEvent): void => {
    // 被系统/浏览器打断（来电、通知、手势冲突）：不结算 tap，直接作废
    this.endPointer(ev, true);
  };

  private endPointer(ev: PointerEvent, canceled: boolean): void {
    const state = this.pointers.get(ev.pointerId);
    if (!state) return;
    const wasMulti = this.pointers.size >= 2;

    this.pointers.delete(ev.pointerId);
    try {
      this.element.releasePointerCapture(ev.pointerId);
    } catch {
      /* 忽略 */
    }

    if (this.pointers.size > 0) {
      // 双指里抬起一根：本次序列已是多指语义，剩下那根不再补发单指手势
      if (wasMulti) this.sequenceCanceled = true;
      return;
    }

    if (!canceled && !wasMulti && !this.sequenceCanceled) {
      this.finishSingle(state, ev.clientX, ev.clientY);
    }
    this.resetSequence();
  }

  /** 最后一根手指抬起时的单指结算：轻点 / 双击 / 快速滑动 */
  private finishSingle(state: PointState, x: number, y: number): void {
    const now = this.now();
    const duration = now - this.singleStartTime;
    const dx = x - state.startX;
    const dy = y - state.startY;
    const distance = Math.hypot(dx, dy);

    // 1) 轻点 / 双击：位移小、时间短、且长按没先抢走
    if (!this.movedBeyondTap && !this.longPressFired && duration < this.options.tapMaxMs) {
      const isDouble = this.lastTapTime > 0 && now - this.lastTapTime < this.options.doubleTapMs;
      // 双击只发一条 doubletap，不再补发第二次 tap（否则引擎会"放一个又撤一个"）
      this.lastTapTime = isDouble ? 0 : now;
      this.emit(isDouble ? 'doubletap' : 'tap', x, y, dx, dy, 1, 0, duration, 1);
      return;
    }

    // 2) 快速滑动（位移够大 + 速度够快）；与 tap 互斥：能判 swipe 就不发 tap
    if (distance >= this.options.tapMaxMove && duration > 0) {
      const speed = distance / duration; // 像素/毫秒
      if (speed > this.options.swipeSpeed) {
        this.lastTapTime = 0;
        this.emit('swipe', x, y, dx, dy, 1, 0, duration, 1);
        return;
      }
    }

    // 既不轻点也不滑动（慢速拖动后松手）→ 不补发任何手势，drag 已经发过了
    this.clearLongPressTimer();
  }

  // ---------------------------------------------------------------- 双指手势

  /**
   * 双指：按两指距离变化发 `pinch`，按中点位移发 `orbit`。
   * 同一次移动**只发一种** —— 比较两者相对各自死区的强度，谁显著听谁的。
   */
  private updateMulti(): void {
    const [a, b] = this.firstTwoPointers();
    if (!a || !b) return;

    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const centerX = (a.x + b.x) / 2;
    const centerY = (a.y + b.y) / 2;

    const deltaDistance = distance - this.lastPinchDistance;
    const moveX = centerX - this.lastPinchCenter.x;
    const moveY = centerY - this.lastPinchCenter.y;
    this.lastPinchDistance = distance;
    this.lastPinchCenter.x = centerX;
    this.lastPinchCenter.y = centerY;

    const pinchStrength = Math.abs(deltaDistance) / PINCH_DEAD_ZONE_PX;
    const orbitStrength = Math.hypot(moveX, moveY) / ORBIT_DEAD_ZONE_PX;
    if (pinchStrength < 1 && orbitStrength < 1) return; // 手指抖动，忽略

    const duration = this.now() - this.multiStartTime;
    const totalX = centerX - this.multiStartCenter.x;
    const totalY = centerY - this.multiStartCenter.y;

    if (orbitStrength > pinchStrength) {
      // 同向拖动 → 转镜头（scale 恒为 1，表示"这次没有缩放"）
      this.emit('orbit', centerX, centerY, totalX, totalY, 1, 0, duration, this.pointers.size);
      return;
    }

    const scale = this.pinchStartDistance > 0 ? distance / this.pinchStartDistance : 1;
    // deltaScale 相对"上一次真正发出的 pinch"算，被死区吞掉的微小变化会累积到下一次，
    // 不会凭空丢掉缩放量
    const deltaScale = scale - this.lastScale;
    this.lastScale = scale;
    this.emit('pinch', centerX, centerY, totalX, totalY, scale, deltaScale, duration, this.pointers.size);
  }
}
