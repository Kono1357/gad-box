/**
 * 输入系统：把鼠标 / 触摸 / 键盘揉成统一的状态与事件流。
 *
 * M1 在 M0 基础上新增了三样东西，都是为了编辑操作：
 * - `onPointerDown` / `onPointerUp`：编辑时需要知道"左键是否一直按着"（连续绘制）；
 * - `onTap`：位移小于阈值的**单击**。这是解决"右键既平移又擦除"冲突的关键：
 *   右键按下后移动 → 平移视角；右键按下没怎么动就抬起 → 判定为擦除笔刷；
 * - `onShortcut`：Ctrl+Z / Ctrl+Y 这类快捷键，与相机用的 `onKeyDown` 分开，
 *   避免两套逻辑抢同一个回调。
 *
 * 触摸映射：1 指 = 笔刷或旋转（取决于模式），2 指 = 平移 + 捏合缩放。
 */

import { VOXEL_CONFIG } from '../config';

export interface PointerDragEvent {
  /** 本次移动的像素增量 */
  dx: number;
  dy: number;
  /** 触发拖拽的鼠标键（0 左 / 1 中 / 2 右）；双指拖拽恒为 2 */
  button: number;
  /** 当前按下的指针数量 */
  pointers: number;
}

/** 指针按下 / 抬起 / 单击时携带的上下文 */
export interface PointerEventInfo {
  button: number;
  /** 归一化设备坐标（-1~1） */
  ndc: { x: number; y: number };
  /** 当前按下的指针数量 */
  pointers: number;
  shift: boolean;
  ctrl: boolean;
  /** 是否触摸来源 */
  touch: boolean;
}

interface PointerState {
  x: number;
  y: number;
  button: number;
  startX: number;
  startY: number;
  startTime: number;
  moved: boolean;
}

/** 这些键在沙盘里有用途，阻止浏览器默认行为（滚动 / 焦点跳动） */
const PREVENT_DEFAULT = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

export class InputSystem {
  /** 当前按下的键（KeyboardEvent.code） */
  readonly keys = new Set<string>();
  /** 指针位置（归一化设备坐标，左下 -1，右上 1） */
  readonly ndc = { x: 0, y: 0 };

  onDrag?: (e: PointerDragEvent) => void;
  onZoom?: (delta: number) => void;
  onKeyDown?: (code: string, ev: KeyboardEvent) => void;
  onPointerMove?: (ndc: { x: number; y: number }) => void;

  /** M1：指针按下 / 抬起 / 单击 */
  onPointerDown?: (e: PointerEventInfo) => void;
  onPointerUp?: (e: PointerEventInfo) => void;
  onTap?: (e: PointerEventInfo) => void;
  /** M1：快捷键（Ctrl+Z 等），与相机的 onKeyDown 互不干扰 */
  onShortcut?: (code: string, ev: KeyboardEvent) => void;

  private readonly pointers = new Map<number, PointerState>();
  private readonly buttonsDown = new Set<number>();
  private lastPinchDistance = 0;
  private readonly lastPinchCenter = { x: 0, y: 0 };
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly target: HTMLElement = window.document.body,
  ) {
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerUp);
    canvas.addEventListener('pointerleave', this.handlePointerUp);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.handleContextMenu);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
  }

  // ---------------------------------------------------------------- 状态查询

  /** Shift 是否按下（相机加速 / 笔刷反向） */
  get shift(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  /** Ctrl 是否按下（快捷键判定 / Ctrl+滚轮调强度） */
  get ctrl(): boolean {
    return this.keys.has('ControlLeft') || this.keys.has('ControlRight');
  }

  /** Command / Meta 是否按下（macOS 上等价于 Ctrl） */
  get meta(): boolean {
    return this.keys.has('MetaLeft') || this.keys.has('MetaRight');
  }

  /** Alt 是否按下（Alt+滚轮调笔刷半径） */
  get alt(): boolean {
    return this.keys.has('AltLeft') || this.keys.has('AltRight');
  }

  /** 某个鼠标键当前是否按住（编辑模式连续绘制靠它） */
  isButtonDown(button: number): boolean {
    return this.buttonsDown.has(button);
  }

  /** 当前按下的指针数量（触摸时用；> 1 表示正在双指手势，应暂停绘制） */
  get pointerCount(): number {
    return this.pointers.size;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.handlePointerDown);
    c.removeEventListener('pointermove', this.handlePointerMove);
    c.removeEventListener('pointerup', this.handlePointerUp);
    c.removeEventListener('pointercancel', this.handlePointerUp);
    c.removeEventListener('pointerleave', this.handlePointerUp);
    c.removeEventListener('wheel', this.handleWheel);
    c.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    this.pointers.clear();
    this.buttonsDown.clear();
    this.keys.clear();
  }

  // ---------------------------------------------------------------- 指针

  private updateNdc(ev: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
  }

  private makeInfo(ev: PointerEvent): PointerEventInfo {
    return {
      button: ev.button,
      ndc: { x: this.ndc.x, y: this.ndc.y },
      pointers: this.pointers.size,
      shift: this.shift,
      ctrl: this.ctrl,
      touch: ev.pointerType === 'touch',
    };
  }

  /** 由当前指针集合重算"哪些键按着"，避免多指抬起的顺序问题 */
  private syncButtons(): void {
    this.buttonsDown.clear();
    for (const state of this.pointers.values()) this.buttonsDown.add(state.button);
  }

  private handlePointerDown = (ev: PointerEvent): void => {
    try {
      this.canvas.setPointerCapture(ev.pointerId);
    } catch {
      /* 某些浏览器对已捕获的指针会抛错，忽略即可 */
    }
    this.pointers.set(ev.pointerId, {
      x: ev.clientX,
      y: ev.clientY,
      button: ev.button,
      startX: ev.clientX,
      startY: ev.clientY,
      startTime: performance.now(),
      moved: false,
    });
    this.updateNdc(ev);
    this.syncButtons();
    this.syncPinch();
    this.onPointerDown?.(this.makeInfo(ev));
  };

  /**
   * 外部注入一个光标位置（NDC）—— 移动端的「单指拖动 = 光标跟随手指」用它。
   *
   * 为什么不模拟一个 PointerEvent：那需要伪造 clientX/clientY 并让浏览器信任它，
   * 脆弱且会真的干扰指针捕获。这里只做「写入 ndc + 触发移动回调」这一件事，
   * 与 `handlePointerMove` 之后的逻辑完全等价，但没有任何副作用。
   */
  injectPointerMove(ndc: { x: number; y: number }): void {
    this.ndc.x = Math.max(-1, Math.min(1, ndc.x));
    this.ndc.y = Math.max(-1, Math.min(1, ndc.y));
    this.onPointerMove?.(this.ndc);
  }

  /**
   * NDC → 视口内的 CSS 像素坐标（拖拽连线覆盖层要用它把光标画到屏幕上）。
   *
   * 为什么不让调用方自己算：`ndc` 是由这个类从 `clientX/clientY` 与
   * `getBoundingClientRect` 推出来的，反过来算必须用**同一套**矩形 ——
   * 用两套（一个用 canvas、一个用 window）在画布不满屏时就会错位。
   */
  ndcToScreen(ndc: { x: number; y: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + ((ndc.x + 1) / 2) * rect.width,
      y: rect.top + ((-ndc.y + 1) / 2) * rect.height,
    };
  }

  private handlePointerMove = (ev: PointerEvent): void => {
    this.updateNdc(ev);
    this.onPointerMove?.(this.ndc);

    const prev = this.pointers.get(ev.pointerId);
    if (!prev) return;

    const dx = ev.clientX - prev.x;
    const dy = ev.clientY - prev.y;
    prev.x = ev.clientX;
    prev.y = ev.clientY;
    if (!prev.moved) {
      const totalDx = ev.clientX - prev.startX;
      const totalDy = ev.clientY - prev.startY;
      if (Math.hypot(totalDx, totalDy) > VOXEL_CONFIG.tapThresholdPx) prev.moved = true;
    }
    if (dx === 0 && dy === 0) return;

    if (this.pointers.size >= 2) {
      // 双指：中心位移 → 平移；间距变化 → 缩放
      const pinch = this.measurePinch();
      const mdx = pinch.x - this.lastPinchCenter.x;
      const mdy = pinch.y - this.lastPinchCenter.y;
      this.lastPinchCenter.x = pinch.x;
      this.lastPinchCenter.y = pinch.y;

      const dDistance = pinch.distance - this.lastPinchDistance;
      this.lastPinchDistance = pinch.distance;

      if (mdx !== 0 || mdy !== 0) {
        this.onDrag?.({ dx: mdx, dy: mdy, button: 2, pointers: this.pointers.size });
      }
      if (Math.abs(dDistance) > 0.5) {
        // 手指分开（distance 变大）→ 拉近视角 → delta 取负
        this.onZoom?.(-dDistance * 1.8);
      }
      return;
    }

    this.onDrag?.({ dx, dy, button: prev.button, pointers: 1 });
  };

  private handlePointerUp = (ev: PointerEvent): void => {
    const state = this.pointers.get(ev.pointerId);
    if (!state) return;
    this.pointers.delete(ev.pointerId);
    try {
      this.canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* 忽略 */
    }

    const info: PointerEventInfo = {
      button: state.button,
      ndc: { x: this.ndc.x, y: this.ndc.y },
      pointers: this.pointers.size,
      shift: this.shift,
      ctrl: this.ctrl,
      touch: ev.pointerType === 'touch',
    };

    this.syncButtons();
    this.syncPinch();

    // 单击判定：位移够小、时间够短、且不是多指手势
    const duration = performance.now() - state.startTime;
    if (!state.moved && duration < 700) this.onTap?.(info);

    this.onPointerUp?.(info);
  };

  private measurePinch(): { x: number; y: number; distance: number } {
    const list = [...this.pointers.values()];
    const a = list[0];
    const b = list[1];
    if (!a || !b) return { x: 0, y: 0, distance: 0 };
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      distance: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  /** 指针数量变化后，重置双指基准，避免跳变 */
  private syncPinch(): void {
    if (this.pointers.size < 2) {
      this.lastPinchDistance = 0;
      return;
    }
    const pinch = this.measurePinch();
    this.lastPinchDistance = pinch.distance;
    this.lastPinchCenter.x = pinch.x;
    this.lastPinchCenter.y = pinch.y;
  }

  // ---------------------------------------------------------------- 滚轮 / 键盘

  private handleWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    // 统一成"像素"语义：行模式 × 16，页模式 × 100
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 100 : 1;
    this.onZoom?.(ev.deltaY * unit);
  };

  private handleContextMenu = (ev: MouseEvent): void => {
    ev.preventDefault();
  };

  private isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  private handleKeyDown = (ev: KeyboardEvent): void => {
    if (this.isTypingTarget(ev.target)) return;
    if (PREVENT_DEFAULT.has(ev.code)) ev.preventDefault();
    if (this.keys.has(ev.code)) return; // 忽略长按重复
    this.keys.add(ev.code);
    this.onKeyDown?.(ev.code, ev);
    this.onShortcut?.(ev.code, ev);
  };

  private handleKeyUp = (ev: KeyboardEvent): void => {
    this.keys.delete(ev.code);
  };

  /** 失焦时清空按键，避免"卡住一直往前走" */
  private handleBlur = (): void => {
    this.keys.clear();
    this.pointers.clear();
    this.buttonsDown.clear();
  };

  /** 目标元素（保留给上层查询） */
  get element(): HTMLElement {
    return this.target;
  }
}
