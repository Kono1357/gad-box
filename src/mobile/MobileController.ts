/**
 * 移动端控制器（问题 B / 第 6~7 批）：把触屏的原始手势翻译成「相机怎么动、光标在哪」。
 *
 * 为什么单开一个模块而不是塞进 Engine：
 *
 * Engine 已经三千多行，而移动端要接的东西有六件（手势识别、设备探测、屏幕方向、
 * 双摇杆、震动、手势教学）。全塞进去之后，「手机上单指拖动为什么会同时转镜头」
 * 这种问题就没法单独看了。这个类把六件事收在一处，对外只暴露一个 `update()` 和几个开关。
 *
 * 手势映射（这是玩家实际感知到的规则，写清楚）：
 *
 * ```
 * 单指拖动     → 光标跟随手指（瞄准），**不动镜头**
 * 单指轻点     → 在光标处放置 / 选择
 * 单指长按     → 拿起物体
 * 单指双击     → 取消当前放置
 * 双指开合     → 缩放
 * 双指同向拖动 → 旋转镜头
 * 左摇杆       → 平移镜头（前后左右）
 * 右摇杆       → 旋转镜头（左右转 + 上下俯仰）
 * ```
 *
 * 为什么单指拖动不转镜头：手机上「瞄准」和「转视角」用同一个手势的话，
 * 玩家永远对不准想要的那一格 —— 他每挪一下手指，画面也跟着动，目标就跑了。
 * 所以瞄准和转视角被拆成「单指」与「双指/摇杆」两组，这是取舍不是技术限制。
 *
 * 另一个取舍：**摇杆默认关闭**。屏幕就那么大，两个 112px 的圆盘会压住近一半的操作区，
 * 而双指手势已经能覆盖转视角的需求。需要的人自己开（右上角按钮 / 设置）。
 */

import { TouchInput } from './TouchInput';
import type { GestureEvent } from './TouchInput';
import { VirtualJoystick } from './VirtualJoystick';
import { detectDevice, type DeviceProfile } from './DeviceCapability';
import { OrientationWatcher } from './Orientation';
import type { HapticFeedback } from './HapticFeedback';

export interface MobileHandlers {
  /** 光标位置变化（NDC）。active=false 表示手指抬起了 */
  onCursor?(ndc: { x: number; y: number }, active: boolean): void;
  /** 单指轻点（放置 / 选择） */
  onTap?(ndc: { x: number; y: number }): void;
  /** 单指双击（取消放置） */
  onDoubleTap?(ndc: { x: number; y: number }): void;
  /** 单指长按（拿起物体） */
  onLongPress?(ndc: { x: number; y: number }): void;
  /** 平移镜头：dx/dy 是像素增量 */
  onPan?(dx: number, dy: number): void;
  /** 旋转镜头：dx/dy 是像素增量 */
  onOrbit?(dx: number, dy: number): void;
  /** 缩放：正数拉近、负数推远（单位与滚轮一致） */
  onZoom?(delta: number): void;
  /** 任何手势事件（手势教学与震动反馈用） */
  onGesture?(kind: GestureEvent['kind']): void;
  /** 屏幕方向变化（移动端 UI 重新布局用） */
  onOrientation?(isPortrait: boolean, isNarrow: boolean): void;
}

export interface MobileControllerOptions {
  /** 手势监听的元素（画布） */
  target: HTMLElement;
  handlers: MobileHandlers;
  /** 震动（可选；没有就静默不震） */
  haptics?: HapticFeedback;
  /** 摇杆默认是否显示 */
  joysticksVisible?: boolean;
}

/** 摇杆满推时的镜头速度（米/秒 与 弧度/秒 的基准） */
const PAN_SPEED = 14;
const ORBIT_SPEED = 1.9;
/** 摇杆死区内视为没推 */
const STICK_DEADZONE = 0.15;

export class MobileController {
  private readonly gestures: TouchInput;
  private readonly orientation: OrientationWatcher;
  private readonly leftStick: VirtualJoystick;
  private readonly rightStick: VirtualJoystick;
  private readonly profile: DeviceProfile;
  private joysticksShown = false;
  private started = false;
  private disposed = false;
  /** 摇杆产生的累积位移，每帧由 update() 取走 */
  private pendingPan = { dx: 0, dy: 0 };
  private pendingOrbit = { dx: 0, dy: 0 };

  constructor(private readonly options: MobileControllerOptions) {
    this.profile = detectDevice();

    this.gestures = new TouchInput(options.target);
    this.gestures.onGesture = (event) => this.handleGesture(event);
    this.gestures.onCursor = (ndc, active) => {
      this.options.handlers.onCursor?.(ndc, active);
    };

    // 左摇杆平移、右摇杆旋转。摇杆自身只在收到 pointerdown 时激活，
    // 所以不会抢走画布上的单指瞄准手势。
    this.leftStick = new VirtualJoystick({ label: '平移镜头', radius: 56 });
    this.rightStick = new VirtualJoystick({ label: '旋转镜头', radius: 56 });
    this.leftStick.place('bottom-left', this.profile.safeArea);
    this.rightStick.place('bottom-right', this.profile.safeArea);
    this.leftStick.setVisible(false);
    this.rightStick.setVisible(false);

    this.orientation = new OrientationWatcher((info) => {
      this.options.handlers.onOrientation?.(info.orientation === 'portrait', info.isNarrow);
      // 安全区在旋转后会变（刘海跑到侧边），摇杆要重新贴边
      this.leftStick.place('bottom-left', this.profile.safeArea);
      this.rightStick.place('bottom-right', this.profile.safeArea);
    });
  }

  /** 设备画像（质量预设推荐、是否显示移动 UI 都读它） */
  get device(): DeviceProfile {
    return this.profile;
  }

  /** 是不是真的触屏设备 */
  get isTouchDevice(): boolean {
    return this.gestures.isTouchDevice;
  }

  get joysticksVisible(): boolean {
    return this.joysticksShown;
  }

  /** 当前活跃指针数（Engine 可用它判断「正在双指操作，先别放置」） */
  get activePointers(): number {
    return this.gestures.pointerCount;
  }

  /** 触屏是否被临时禁用（弹窗打开等） */
  setEnabled(enabled: boolean): void {
    this.gestures.setEnabled(enabled);
    if (!enabled) {
      this.leftStick.setVisible(false);
      this.rightStick.setVisible(false);
      this.joysticksShown = false;
    }
  }

  setJoysticksVisible(visible: boolean): void {
    if (this.disposed) return;
    this.joysticksShown = visible;
    this.leftStick.setVisible(visible);
    this.rightStick.setVisible(visible);
  }

  toggleJoysticks(): boolean {
    this.setJoysticksVisible(!this.joysticksShown);
    return this.joysticksShown;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.orientation.start();
  }

  /**
   * 每帧调用：把摇杆的持续推力转成镜头位移。
   *
   * 摇杆是「按住就一直动」的，所以不能像手势那样一次性发事件 ——
   * 必须按 dt 累积，否则摇杆的移动速度会跟着帧率变（60Hz 比 30Hz 快一倍）。
   */
  update(dtSeconds: number): void {
    if (this.disposed || !this.joysticksShown) return;
    const left = this.leftStick.vector;
    const right = this.rightStick.vector;

    if (left.magnitude > STICK_DEADZONE) {
      // y 向上为正 → 前推是"往前看"（镜头目标往远处走），所以 dy 取负
      this.pendingPan.dx += left.x * left.magnitude * PAN_SPEED * dtSeconds;
      this.pendingPan.dy += -left.y * left.magnitude * PAN_SPEED * dtSeconds;
    }
    if (right.magnitude > STICK_DEADZONE) {
      this.pendingOrbit.dx += right.x * right.magnitude * ORBIT_SPEED * dtSeconds * 60;
      this.pendingOrbit.dy += -right.y * right.magnitude * ORBIT_SPEED * dtSeconds * 60;
    }

    // 摇杆的位移直接以像素增量喂给相机控制（它本来就是按像素增量工作的）
    if (this.pendingPan.dx !== 0 || this.pendingPan.dy !== 0) {
      this.options.handlers.onPan?.(this.pendingPan.dx, this.pendingPan.dy);
      this.pendingPan.dx = 0;
      this.pendingPan.dy = 0;
    }
    if (this.pendingOrbit.dx !== 0 || this.pendingOrbit.dy !== 0) {
      this.options.handlers.onOrbit?.(this.pendingOrbit.dx, this.pendingOrbit.dy);
      this.pendingOrbit.dx = 0;
      this.pendingOrbit.dy = 0;
    }
  }

  private handleGesture(event: GestureEvent): void {
    const ndc = { x: event.ndcX, y: event.ndcY };
    switch (event.kind) {
      case 'tap':
        this.options.handlers.onTap?.(ndc);
        break;
      case 'doubletap':
        this.options.handlers.onDoubleTap?.(ndc);
        break;
      case 'longpress':
        this.options.handlers.onLongPress?.(ndc);
        break;
      case 'drag':
        // drag 的光标更新走 onCursor，这里只做"手势已发生"的通知
        break;
      case 'orbit':
        this.options.handlers.onOrbit?.(event.dx * 0.9, event.dy * 0.9);
        break;
      case 'pinch':
        // deltaScale > 0 表示两指在分开（放大）→ 拉近镜头
        this.options.handlers.onZoom?.(event.deltaScale * 120);
        break;
      case 'swipe':
        // 快速滑动：当成一次大幅度的视角旋转（手机上比"拖动"更符合直觉）
        this.options.handlers.onOrbit?.(event.dx * 1.4, event.dy * 1.4);
        break;
      default:
        break;
    }
    this.options.handlers.onGesture?.(event.kind);
  }

  dispose(): void {
    this.disposed = true;
    this.gestures.dispose();
    this.orientation.dispose();
    this.leftStick.dispose();
    this.rightStick.dispose();
  }
}
