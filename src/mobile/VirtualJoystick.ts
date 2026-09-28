/**
 * 虚拟摇杆（自建 DOM 实现，不依赖任何库）。
 *
 * ## 它驱动的是相机，不是人物 —— 这是本项目的诚实取舍
 *
 * 手柄布局按手游惯例给两个摇杆：
 * - **左摇杆**：平移相机（在水平面上前后左右移动镜头 = "走动"）；
 * - **右摇杆**：旋转相机（绕自身转视角 = "看向"）。
 *
 * 但目前世界里**还没有可操作的角色**，所以摇杆转动的其实是相机而不是人物。
 * 这么做的理由是：手机上"两只手怎么操控沙盘"这件事本身就得先解决，
 * 而相机控制与角色控制的输入协议是完全一样的（一个 -1..1 的二维向量）。
 * 等以后加了角色，只要把 Engine 里消费向量的那一段从相机换成角色控制器，
 * 摇杆本身一行都不用改。
 *
 * 因此本类**故意不知道**相机、角色、Three.js 的存在：
 * 它只做一件事 —— 把手势翻译成一个 `JoystickVector`。
 *
 * ## 几个实现上的取舍
 * - 用 Pointer Events + `setPointerCapture`：一根手指按住之后，即使滑出摇杆范围
 *   （甚至滑到别的面板上）也能继续收到 move/up，不会"摇杆卡住"。
 * - 只在**自己的根元素**上监听 pointerdown，且必须命中自己的 DOM 子树才激活，
 *   绝不监听 window/document/canvas —— 否则会和画布的拖拽视角互相抢事件。
 * - 摇杆头用 `transform: translate3d(...)` 移动（不改 left/top），避免每帧触发重排；
 *   只有"动态底座"才用 left/top，且一次手势只写两次（按下 / 松手）。
 * - 隐藏用 `display: none`：隐藏的摇杆彻底不参与布局与命中测试，**物理上**不可能
 *   收到事件（比 `pointer-events: none` + `visibility: hidden` 更绝对；
 *   代价是再次显示时多一次布局，相对一次手势的开销可以忽略）。
 * - 样式内联写在 TS 里（`Object.assign(el.style, {...})`），不改 src/style.css ——
 *   那个文件不归这个模块管，内联也能保证摇杆在任何页面结构下都长得一样。
 * - 触摸目标尺寸：底座直径 **112px**（默认半径 56 × 2），是 44×44 最小触控目标的
 *   约 2.6 倍面积；摇杆头直径约 **49px**，同样 ≥ 44×44。
 *
 * ## 向量约定（很重要，Engine 请照这个读）
 * - `x` / `y` 是**方向单位向量**（-1..1），`y` 向上为正（屏幕坐标的 y 已取反）；
 * - `magnitude` 是**强度**（0..1），死区内为 0；
 * - 死区内 `magnitude = 0` 但 `x`/`y` 仍保留最后一次方向（松手时才会全部归零）；
 * - 所以速度输入请写成 `(x * magnitude, y * magnitude)` —— 直接拿 x/y 当速度会在死区内全速跑。
 */

/** 摇杆输出的二维向量 */
export interface JoystickVector {
  /** 方向分量，-1..1（单位向量；y 向上为正是"前进"直觉） */
  x: number;
  /** 方向分量，-1..1（屏幕坐标向下已取反） */
  y: number;
  /** 强度 0..1：死区内为 0，越过死区后从 0 平滑升到 1 */
  magnitude: number;
}

export interface VirtualJoystickOptions {
  /** 视觉半径（CSS 像素），默认 56 —— 按钮/热区要求 ≥ 44×44 */
  radius?: number;
  /** 死区（0..1），默认 0.15 */
  deadZone?: number;
  /** 摇杆头最大偏移比例，默认 1 */
  maxOffset?: number;
  /** 是否在 pointerdown 时把底座挪到手指位置（手游常见做法），默认 true */
  dynamicBase?: boolean;
  /** 无障碍标签（中文） */
  label?: string;
}

/**
 * 底座最小直径（CSS 像素）。
 * 44×44 是无障碍指南给出的最小触控目标，摇杆要拇指按着玩，所以取 112px（≈ 2.6 倍面积）；
 * 传再小的 radius 也会被这个常量兜底。
 */
export const MIN_BASE_DIAMETER = 112;

const DEFAULT_RADIUS = 56;
const DEFAULT_DEAD_ZONE = 0.15;
const DEFAULT_MAX_OFFSET = 1;
const DEFAULT_DYNAMIC_BASE = true;
/** 摇杆头直径 / 底座直径：112 × 0.44 ≈ 49px，仍 ≥ 44×44 */
const KNOB_DIAMETER_RATIO = 0.44;
/** 距屏幕边缘 / 安全区的留白 */
const PLACEMENT_MARGIN = 18;

const IDLE_VECTOR: JoystickVector = { x: 0, y: 0, magnitude: 0 };

/** 内联样式统一走这里，保持文件里写法一致 */
function style(el: HTMLElement, patch: Record<string, string>): void {
  Object.assign(el.style, patch);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 拼 px 字符串时把浮点收敛到两位，减少每帧生成的样式字符串噪音 */
function px(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

export class VirtualJoystick {
  /** 挂到 body 上的根元素（Engine 决定放哪） */
  readonly element: HTMLElement;

  /** 向量变化回调（仅在越过死区或松手归零时触发，不是每帧） */
  onVector: ((vector: JoystickVector) => void) | null = null;

  private readonly base: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly radius: number;
  private readonly knobRadius: number;
  private readonly deadZone: number;
  private readonly maxOffset: number;
  private readonly dynamicBase: boolean;

  private readonly current: JoystickVector = { ...IDLE_VECTOR };
  /** 最后一次方向（单位向量，y 向上为正）；松手才清零 —— 死区内要保留方向 */
  private directionX = 0;
  private directionY = 0;
  private activePointerId: number | null = null;
  /** 向量原点（视口坐标）：dynamicBase 时是触点，否则是底座锚点中心 */
  private originX = 0;
  private originY = 0;
  /** 底座相对锚点的偏移（根元素局部坐标，dynamicBase 用） */
  private baseOffsetX = 0;
  private baseOffsetY = 0;
  /** 摇杆头相对底座中心的偏移（局部坐标） */
  private knobX = 0;
  private knobY = 0;
  private outsideDeadZone = false;
  private visibleFlag = false;
  private disposed = false;

  constructor(options: VirtualJoystickOptions = {}) {
    const requestedRadius = options.radius ?? DEFAULT_RADIUS;
    // 直径按最小触控目标兜底，再反推半径，保证视觉与热区一致
    const diameter = Math.max(MIN_BASE_DIAMETER, Math.round(requestedRadius * 2));
    const knobDiameter = Math.round(diameter * KNOB_DIAMETER_RATIO);
    this.radius = diameter / 2;
    this.knobRadius = knobDiameter / 2;
    this.deadZone = clamp(options.deadZone ?? DEFAULT_DEAD_ZONE, 0, 0.9);
    this.maxOffset = clamp(options.maxOffset ?? DEFAULT_MAX_OFFSET, 0.1, 1);
    this.dynamicBase = options.dynamicBase ?? DEFAULT_DYNAMIC_BASE;

    // 根元素：默认隐藏（display: none），只在自己的 DOM 上监听指针事件
    this.element = document.createElement('div');
    this.element.className = 'joystick-root';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-hidden', 'true');
    if (options.label) this.element.setAttribute('aria-label', options.label);
    style(this.element, {
      position: 'fixed',
      left: '0px',
      bottom: '0px',
      width: `${diameter}px`,
      height: `${diameter}px`,
      margin: '0px',
      padding: '0px',
      display: 'none',
      touchAction: 'none',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none',
      zIndex: '25',
      willChange: 'transform',
    });

    // 底座：本身就是热区（直径 112px），动态底座时会被挪到手指下
    this.base = document.createElement('div');
    this.base.className = 'joystick-base';
    style(this.base, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: `${diameter}px`,
      height: `${diameter}px`,
      boxSizing: 'border-box',
      transform: 'translate(-50%, -50%)',
      borderRadius: '50%',
      background: 'rgba(16, 20, 24, 0.5)',
      border: '1px solid rgba(255, 255, 255, 0.18)',
      backdropFilter: 'blur(2px)',
      WebkitBackdropFilter: 'blur(2px)',
    });

    // 摇杆头：只吃视觉，不吃事件（事件统一由根/底座判断），用 translate3d 移动避免重排
    this.knob = document.createElement('div');
    this.knob.className = 'joystick-knob';
    style(this.knob, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: `${knobDiameter}px`,
      height: `${knobDiameter}px`,
      // 用负 margin 居中，这样 transform 可以只留给 translate3d
      marginLeft: px(-this.knobRadius),
      marginTop: px(-this.knobRadius),
      boxSizing: 'border-box',
      transform: 'translate3d(0px, 0px, 0px)',
      willChange: 'transform',
      borderRadius: '50%',
      background: 'rgba(216, 226, 234, 0.5)',
      border: '1px solid rgba(255, 255, 255, 0.6)',
      pointerEvents: 'none',
    });

    this.base.appendChild(this.knob);
    this.element.appendChild(this.base);

    this.element.addEventListener('pointerdown', this.handlePointerDown);
    this.element.addEventListener('pointermove', this.handlePointerMove);
    this.element.addEventListener('pointerup', this.handlePointerUp);
    this.element.addEventListener('pointercancel', this.handlePointerUp);
    this.element.addEventListener('lostpointercapture', this.handlePointerUp);
  }

  /** 每帧读当前向量（未按下时 magnitude 为 0） */
  get vector(): JoystickVector {
    // 返回副本：引擎改到返回值也不会污染摇杆内部状态
    return { ...this.current };
  }

  /** 是否正在被按住 */
  get isActive(): boolean {
    return this.activePointerId !== null;
  }

  /** 是否显示（默认 false） */
  get visible(): boolean {
    return this.visibleFlag;
  }

  /** 显示/隐藏。隐藏时强制归零并释放。 */
  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visibleFlag) return;
    this.visibleFlag = visible;
    if (visible) {
      this.element.style.display = 'block';
      this.element.setAttribute('aria-hidden', 'false');
      return;
    }
    // 先归零 + 交还指针捕获，再隐藏，避免"隐藏了还在转视角"
    this.release();
    this.element.style.display = 'none';
    this.element.setAttribute('aria-hidden', 'true');
  }

  /** 重新定位（旋转屏幕 / 安全区变化时调用） */
  place(
    position: 'bottom-left' | 'bottom-right',
    safeArea: { bottom?: number; left?: number; right?: number } = {},
  ): void {
    if (this.disposed) return;
    const bottom = (safeArea.bottom ?? 0) + PLACEMENT_MARGIN;
    const side = (position === 'bottom-left' ? safeArea.left ?? 0 : safeArea.right ?? 0) + PLACEMENT_MARGIN;
    this.element.style.bottom = px(bottom);
    this.element.style.top = 'auto';
    this.element.style.left = position === 'bottom-left' ? px(side) : 'auto';
    this.element.style.right = position === 'bottom-right' ? px(side) : 'auto';
  }

  dispose(): void {
    if (this.disposed) return;
    // 先置位：拆解过程中不再对外回调
    this.disposed = true;
    this.element.removeEventListener('pointerdown', this.handlePointerDown);
    this.element.removeEventListener('pointermove', this.handlePointerMove);
    this.element.removeEventListener('pointerup', this.handlePointerUp);
    this.element.removeEventListener('pointercancel', this.handlePointerUp);
    this.element.removeEventListener('lostpointercapture', this.handlePointerUp);
    this.resetState();
    this.onVector = null;
    this.element.remove();
  }

  /**
   * 摇杆头的最大行程（局部像素）：
   * `(半径 − 摇杆头半径) × maxOffset`，这样满偏移时摇杆头正好贴住底座内缘、不会跑出去。
   * 向量在达到这个行程时饱和为 1。
   */
  private maxTravel(): number {
    return Math.max(1, (this.radius - this.knobRadius) * this.maxOffset);
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (this.disposed || !this.visibleFlag) return;
    // 只认自己 DOM 子树里发出的事件：画布上的手势一律不碰，避免抢占视角拖拽
    const target = event.target as Node | null;
    if (!target || !this.element.contains(target)) return;
    // 一次只跟一根手指：第二个摇杆要自己收自己的 pointerId
    if (this.activePointerId !== null) return;

    event.preventDefault();
    // 事件起于摇杆，就不该再冒泡给全局监听（否则会同时触发视角拖拽）
    event.stopPropagation();

    this.activePointerId = event.pointerId;
    this.element.setPointerCapture(event.pointerId);

    const rect = this.element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    if (this.dynamicBase) {
      // 底座挪到手指下：写的是"底座中心"的局部坐标，配合 translate(-50%, -50%) 生效
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      this.base.style.left = px(localX);
      this.base.style.top = px(localY);
      this.baseOffsetX = localX - rect.width / 2;
      this.baseOffsetY = localY - rect.height / 2;
      // 向量原点跟着底座走（手指按下处就是摇杆的中心）
      this.originX = event.clientX;
      this.originY = event.clientY;
    } else {
      this.baseOffsetX = 0;
      this.baseOffsetY = 0;
      this.originX = centerX;
      this.originY = centerY;
    }

    this.knobX = 0;
    this.knobY = 0;
    this.applyKnobTransform();
    // 这里**不**回调：按下时还在死区里，状态没有变化，
    // onVector 只负责报告"越过死区 / 松手归零"，连续值由引擎每帧读 vector。
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.activePointerId !== event.pointerId) return;
    this.updateFromPointer(event.clientX, event.clientY);
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (this.activePointerId !== event.pointerId) return;
    this.release();
  };

  private updateFromPointer(clientX: number, clientY: number): void {
    const dx = clientX - this.originX;
    const dy = clientY - this.originY;
    const distance = Math.hypot(dx, dy);
    const travel = this.maxTravel();
    const clampedDistance = Math.min(distance, travel);

    // 方向只在"确实有位移"时更新；位移为 0 时沿用上一次方向
    if (distance > 0.0001) {
      this.directionX = dx / distance;
      // 屏幕坐标 y 向下，取反后"向上 = 前进"，符合直觉
      this.directionY = -dy / distance;
    }

    const raw = clampedDistance / travel;
    const outside = raw > this.deadZone;
    // 越过死区后重新映射到 0..1，手感是"从死区边缘平滑起步"而不是突然跳一下
    const magnitude = outside ? Math.min(1, (raw - this.deadZone) / (1 - this.deadZone)) : 0;

    this.current.x = this.directionX;
    this.current.y = this.directionY;
    this.current.magnitude = magnitude;

    if (distance > 0.0001) {
      const unitX = dx / distance;
      const unitY = dy / distance;
      this.knobX = unitX * clampedDistance;
      this.knobY = unitY * clampedDistance;
    } else {
      this.knobX = 0;
      this.knobY = 0;
    }
    this.applyKnobTransform();

    // 只在"越过死区"的那一下回调，不做每帧回调（连续值由引擎每帧读 vector）
    if (outside !== this.outsideDeadZone) {
      this.outsideDeadZone = outside;
      this.reportVector();
    }
  }

  /** 松手 / 隐藏：归零并对外报告一次零向量 */
  private release(): void {
    if (this.activePointerId === null) return;
    this.resetState();
    this.reportVector();
  }

  /** 归零内部状态、把底座与摇杆头放回锚点（不触发回调） */
  private resetState(): void {
    const pointerId = this.activePointerId;
    this.activePointerId = null;
    if (pointerId !== null && this.element.hasPointerCapture(pointerId)) {
      this.element.releasePointerCapture(pointerId);
    }
    this.directionX = 0;
    this.directionY = 0;
    this.knobX = 0;
    this.knobY = 0;
    this.baseOffsetX = 0;
    this.baseOffsetY = 0;
    this.outsideDeadZone = false;
    this.current.x = IDLE_VECTOR.x;
    this.current.y = IDLE_VECTOR.y;
    this.current.magnitude = IDLE_VECTOR.magnitude;
    // 动态底座回到锚点（根元素中心）
    this.base.style.left = '50%';
    this.base.style.top = '50%';
    this.applyKnobTransform();
  }

  private applyKnobTransform(): void {
    // 摇杆头相对根元素中心的偏移 = 底座偏移 + 相对底座的偏移
    const x = this.baseOffsetX + this.knobX;
    const y = this.baseOffsetY + this.knobY;
    this.knob.style.transform = `translate3d(${px(x)}, ${px(y)}, 0)`;
  }

  private reportVector(): void {
    if (this.disposed) return;
    this.onVector?.({ ...this.current });
  }
}
