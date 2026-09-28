/**
 * 屏幕边缘箭头指示器（智能放置补充）。
 *
 * ## 为什么需要它
 *
 * 智能放置会给出一串候选点，高亮框只画在"世界里"。可候选点一旦跑到视野之外，
 * 玩家在画面上**什么都看不见**：既不知道目标在哪个方向，也不知道离自己多远，
 * 只能盲目转镜头去找。所以这里在屏幕边缘补一个方向箭头 + 距离数字，
 * 指着那个看不见的候选点，顺着箭头转镜头就能找到它。
 *
 * ## 几条设计取舍
 *
 * 1. **零 Three.js 依赖**：本模块不知道 camera 是什么，只接受一个
 *    「世界坐标 → 屏幕像素坐标」的 `project` 回调（Engine 里用 `camera` 的投影实现）。
 *    好处有两个：可以在 Node 里直接 import 做单测；也不会把渲染层拖进 placement/
 *    的依赖图（同目录的 CameraTracker 也是这么做的）。
 * 2. **夹取逻辑拆成纯函数 `clampToEdge()`**：全是算术，不碰 DOM，所以"正中心 /
 *    四个角落 / 恰好压边 / 极远点 / 视口退化"这些边界情况都能在 Node 里断言。
 * 3. **位置只写 `transform: translate3d()`**：不写 left/top，避免每帧触发布局重排
 *    （与 VirtualJoystick 的摇杆头同一套做法）。每帧写入前还会比较新旧值，
 *    没变就不写，省掉一次无意义的样式失效。
 * 4. **根元素 `pointer-events: none`**：箭头只是提示，**绝不能**挡住画布上的拖拽 /
 *    点击 —— 手机上玩家根本不知道有个透明层在吃事件，那种 bug 极难排查。
 * 5. 距离文字用 DOM `<span>` 而不是 SVG `<text>`：SVG 文字要自己写 fill /
 *    font-family / dominant-baseline，中文字形与基线在不同浏览器还会飘；
 *    `<span>` 能直接继承页面的等宽字体栈、用 `text-shadow` 保证在亮背景上也读得清，
 *    并且更新只是 `textContent` 赋值。
 * 6. **投影函数抛异常也不崩**：相机还没就绪 / 矩阵是坏的时，这一帧当作"看不见"，
 *    绝不让异常打断整个渲染循环。
 *
 * ## 角度约定（很重要）
 *
 * `clampToEdge().angle` 是**屏幕坐标系**（y 轴向下）里从 +x 轴起算的弧度，
 * 顺时针为正，与 `Math.atan2(dy, dx)`、CSS/SVG 的 `rotate()` 完全一致，
 * 所以拿到角度可以原样丢给 SVG：`rotate(angle 0 0)`，不需要任何换算。
 */

/** 投影结果（屏幕像素坐标 + 是否在视锥内） */
export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

/** 由调用方提供的「世界坐标 → 屏幕像素坐标」投影函数（Engine 里用 camera 实现） */
export type ProjectFn = (world: { x: number; y: number; z: number }) => ScreenPoint;

export interface ScreenEdgeArrowOptions {
  /** 距离屏幕边缘多少像素开始显示箭头，默认 64 */
  edgeMargin?: number;
  /** 箭头尺寸（像素），默认 34 */
  arrowSize?: number;
  /** 颜色，默认 '#4ade80'（和候选高亮同色） */
  color?: string;
}

/** 夹取结果：屏幕坐标 + 指向角度 + 是否真的被夹过（= 原来在框外） */
export interface EdgeClampResult {
  x: number;
  y: number;
  angle: number;
  clamped: boolean;
}

const DEFAULT_EDGE_MARGIN = 64;
const DEFAULT_ARROW_SIZE = 34;
const DEFAULT_COLOR = '#4ade80';

/** 距离文字与箭头中心的间距（像素）：别让它压在三角形上 */
const LABEL_GAP = 14;

/** 视口尺寸读不到时的下限：宁可把箭头夹在 1×1 的框里，也别让除零产生 NaN */
const MIN_VIEWPORT = 1;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 项目深色主题：与 src/style.css 的 :root 变量保持一致 */
const FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

// ---------------------------------------------------------------- 纯数学部分

/**
 * 纯函数：把屏幕坐标夹到边缘，并算出箭头旋转角（弧度，指向目标方向）。
 *
 * 算法：以**屏幕中心为原点**，沿「中心 → 目标」这条射线把点缩放到内框边界上
 * （两条边各求一个缩放系数取小值 = 矩形裁剪）。这么做而不是"x、y 各自独立夹"，
 * 是因为前者能保证箭头**始终落在中心到目标的连线上**，方向看起来才准；
 * 独立夹取会让角落方向的箭头"贴边平移"，指向感变差。
 *
 * 角度取 `atan2(dy, dx)`：`dx`、`dy` 都是**相对屏幕中心**的偏移，
 * 所以角落里的点也有稳定角度（对角线就是 ±45° 那一档），
 * 正中心（两个偏移都是 0）没有方向可言，约定取 0。
 *
 * 其它边界：
 * - 坐标是 NaN / Infinity（投影已经不可信）→ 退回屏幕中心，绝不把 NaN 传下去；
 * - `edgeMargin` 大于半个短边（小视口 + 大边距）→ 夹到半个短边，内框不会翻转成负尺寸；
 * - **恰好压在边缘算"看得见"**（`clamped: false`），只有真正出框才出箭头。
 */
export function clampToEdge(
  point: ScreenPoint,
  width: number,
  height: number,
  edgeMargin: number,
): EdgeClampResult {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const h = Number.isFinite(height) && height > 0 ? height : 0;
  const centerX = w / 2;
  const centerY = h / 2;

  const requestedMargin = Number.isFinite(edgeMargin) && edgeMargin > 0 ? edgeMargin : 0;
  const margin = Math.min(requestedMargin, Math.min(w, h) / 2);
  const halfW = Math.max(0, w / 2 - margin);
  const halfH = Math.max(0, h / 2 - margin);

  const finite = Number.isFinite(point.x) && Number.isFinite(point.y);
  const rawX = finite ? point.x : centerX;
  const rawY = finite ? point.y : centerY;

  const dx = rawX - centerX;
  const dy = rawY - centerY;

  // 含边界：压在边缘上仍算"看得见"，此时不该显示箭头
  const inside = Math.abs(dx) <= halfW && Math.abs(dy) <= halfH;

  if (dx === 0 && dy === 0) {
    // 正中心 / 坐标不可信：没有方向可言，角度约定取 0
    return { x: centerX, y: centerY, angle: 0, clamped: !inside };
  }

  const angle = Math.atan2(dy, dx);
  if (inside) return { x: rawX, y: rawY, angle, clamped: false };

  // 沿射线缩到内框边界。某个方向分量为 0 时该条边不参与竞争（取 Infinity）。
  const scaleX = dx === 0 ? Infinity : halfW / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : halfH / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);

  return {
    x: centerX + dx * scale,
    y: centerY + dy * scale,
    angle,
    clamped: true,
  };
}

/** 距离文字：米保留 1 位小数，超过 1 km 换单位（沙盘里很少见，但换大地图后会有） */
function formatDistance(distance: number): string {
  if (!Number.isFinite(distance) || distance < 0) return '—';
  if (distance < 1000) return `${distance.toFixed(1)} m`;
  return `${(distance / 1000).toFixed(2)} km`;
}

// ---------------------------------------------------------------- DOM 部分

/**
 * 屏幕边缘箭头。
 *
 * 用法（Engine 每帧调一次）：
 * ```ts
 * arrow.update(candidatePoint, worldToScreen, distance, '木箱');
 * ```
 * 目标在屏幕内时 `update()` 会自己 `hide()`，调用方不用判断。
 */
export class ScreenEdgeArrow {
  private readonly root: HTMLDivElement;
  /** 箭头本体（三角形 + 短线）都在这个 <g> 里，靠 transform="rotate(...)" 转向 */
  private readonly arrowGroup: SVGGElement;
  private readonly label: HTMLSpanElement;
  private readonly edgeMargin: number;
  private readonly arrowSize: number;
  private visibleFlag = false;
  private screenPosition: ScreenPoint | null = null;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    options: ScreenEdgeArrowOptions = {},
  ) {
    this.edgeMargin = Math.max(
      0,
      Number.isFinite(options.edgeMargin) ? (options.edgeMargin as number) : DEFAULT_EDGE_MARGIN,
    );
    this.arrowSize = Math.max(
      8,
      Number.isFinite(options.arrowSize) ? (options.arrowSize as number) : DEFAULT_ARROW_SIZE,
    );
    const color = options.color ?? DEFAULT_COLOR;

    // 根元素是个 0×0 的定位点：子元素以它为中心摆放，靠 translate3d 移动
    this.root = document.createElement('div');
    this.root.setAttribute('aria-hidden', 'true'); // 纯装饰：距离信息 UI 那边另有显示
    Object.assign(this.root.style, {
      position: 'absolute',
      left: '0px',
      top: '0px',
      width: '0px',
      height: '0px',
      // 不能挡住画布上的拖拽 / 点击
      pointerEvents: 'none',
      zIndex: '30',
      display: 'none',
      transform: 'translate3d(0px, 0px, 0)',
      willChange: 'transform',
    });

    const size = this.arrowSize;
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    // viewBox 以 (0,0) 为原点，宽高都是 size —— 于是 SVG 用户单位 = CSS 像素，
    // rotate(angle 0 0) 正好绕箭头中心转，换算少一层，出错机会也少
    svg.setAttribute('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    Object.assign(svg.style, {
      position: 'absolute',
      left: `${-size / 2}px`,
      top: `${-size / 2}px`,
      overflow: 'visible',
      // 亮背景（雪地 / 白沙）上也能看清：给箭头一层深色投影
      filter: 'drop-shadow(0 1px 3px rgba(0, 0, 0, 0.7))',
    });

    this.arrowGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement;
    this.arrowGroup.setAttribute('transform', 'rotate(0 0 0)');

    // 三角形箭头：尖端朝 +x（角度 0 表示"指向屏幕右边"）
    const head = document.createElementNS(SVG_NS, 'polygon') as SVGPolygonElement;
    head.setAttribute(
      'points',
      `${(size * 0.46).toFixed(2)},0 ` +
        `${(-size * 0.04).toFixed(2)},${(-size * 0.28).toFixed(2)} ` +
        `${(-size * 0.04).toFixed(2)},${(size * 0.28).toFixed(2)}`,
    );
    head.setAttribute('fill', color);

    // 短边线：从箭头尾部往**屏幕内侧**拖一小段，让"箭头挂在边上"这件事看得出来。
    // 注意线段朝内侧画而不是朝目标方向画：目标在屏幕外，往外画的线会被屏幕裁掉。
    const tail = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
    tail.setAttribute('x1', (-size * 0.46).toFixed(2));
    tail.setAttribute('y1', '0');
    tail.setAttribute('x2', (-size * 0.08).toFixed(2));
    tail.setAttribute('y2', '0');
    tail.setAttribute('stroke', color);
    tail.setAttribute('stroke-opacity', '0.75');
    tail.setAttribute('stroke-width', Math.max(1.5, size * 0.08).toFixed(2));
    tail.setAttribute('stroke-linecap', 'round');

    this.arrowGroup.appendChild(tail);
    this.arrowGroup.appendChild(head);
    svg.appendChild(this.arrowGroup);

    // 距离文字：用 <span> 而不是 SVG <text>（理由见文件头的取舍 5），
    // 位置用"反向偏移"放在箭头的内侧，保证不会被屏幕边缘裁掉
    this.label = document.createElement('span');
    Object.assign(this.label.style, {
      position: 'absolute',
      left: '0px',
      top: '0px',
      transform: 'translate(-50%, -50%)',
      whiteSpace: 'nowrap',
      fontFamily: FONT_STACK,
      fontSize: '12px',
      fontWeight: '600',
      lineHeight: '1',
      color,
      textShadow: '0 1px 3px rgba(0, 0, 0, 0.85)',
      pointerEvents: 'none',
    });

    this.root.appendChild(svg);
    this.root.appendChild(this.label);
    this.container.appendChild(this.root);
  }

  /** 是否可见 */
  get visible(): boolean {
    return this.visibleFlag;
  }

  /**
   * 上一次算出来的屏幕位置（测试用）。
   *
   * 即使当时因为"在屏幕内"而 `hide()`，这里也保留着算出来的坐标 ——
   * 它反映的是"投影 + 夹取"的结果，不反映"有没有画出来"。
   */
  get lastScreenPosition(): ScreenPoint | null {
    const p = this.screenPosition;
    return p ? { x: p.x, y: p.y, visible: p.visible } : null;
  }

  /**
   * 每帧更新。
   * @param target 世界坐标（候选点）
   * @param project 投影函数
   * @param distance 相机到目标的距离（米），用来显示「12.3 m」
   * @param label 可选：目标名字，显示在距离旁边
   */
  update(
    target: { x: number; y: number; z: number },
    project: ProjectFn,
    distance: number,
    label?: string,
  ): void {
    if (this.disposed) return;

    let projected: ScreenPoint;
    try {
      projected = project(target);
    } catch {
      // 相机还没就绪 / 投影矩阵是坏的：这一帧当"看不见"，不让异常打断渲染循环
      this.hide();
      return;
    }

    const { width, height } = this.readViewport();
    const clamped = clampToEdge(projected, width, height, this.edgeMargin);
    this.screenPosition = { x: clamped.x, y: clamped.y, visible: projected.visible };

    // 在屏幕内（而且投影说它真的可见）就不需要箭头 —— 高亮框已经够了
    if (projected.visible && !clamped.clamped) {
      this.hide();
      return;
    }

    const distanceText = formatDistance(distance);
    const text = label && label.length > 0 ? `${label} ${distanceText}` : distanceText;
    if (this.label.textContent !== text) this.label.textContent = text;

    const cos = Math.cos(clamped.angle);
    const sin = Math.sin(clamped.angle);
    const offset = this.arrowSize / 2 + LABEL_GAP;
    const labelX = -cos * offset;
    const labelY = -sin * offset;
    this.label.style.transform =
      `translate(-50%, -50%) translate(${labelX.toFixed(1)}px, ${labelY.toFixed(1)}px)`;

    // 角度单位是弧度、屏幕坐标系，正好是 SVG rotate() 想要的东西（见文件头角度约定）
    const degrees = (clamped.angle * 180) / Math.PI;
    this.arrowGroup.setAttribute('transform', `rotate(${degrees.toFixed(2)} 0 0)`);

    // 只写 transform：不触发重排；坐标取到 0.1px 就够，省掉无意义的字符串抖动
    const x = Math.round(clamped.x * 10) / 10;
    const y = Math.round(clamped.y * 10) / 10;
    const transform = `translate3d(${x}px, ${y}px, 0)`;
    if (this.root.style.transform !== transform) this.root.style.transform = transform;

    if (!this.visibleFlag) {
      this.visibleFlag = true;
      // 隐藏用 display: none：彻底不参与命中测试与合成，比 visibility 更绝对
      this.root.style.display = 'block';
    }
  }

  /** 收起箭头。屏幕内、没有候选点、切菜单时都调它 */
  hide(): void {
    if (this.disposed || !this.visibleFlag) return;
    this.visibleFlag = false;
    this.root.style.display = 'none';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visibleFlag = false;
    this.screenPosition = null;
    this.root.remove();
  }

  /**
   * 视口尺寸：优先用容器的（渲染容器可能不等于窗口 —— 以后加了侧栏就会不一样），
   * 容器拿不到（尺寸为 0、已脱离文档）再退回窗口。
   *
   * 这里每帧读一次 `clientWidth`。它确实是布局读取，但读的是"没有待处理样式变更"
   * 的静态容器，浏览器直接给缓存值，不会强制回流；比起每帧缓存再靠 resize 事件
   * 同步（漏事件就会错位），这个读法更不容易出错。
   */
  private readViewport(): { width: number; height: number } {
    let width = 0;
    let height = 0;
    try {
      width = this.container.clientWidth;
      height = this.container.clientHeight;
    } catch {
      /* 极端情况下容器已经不可访问：走窗口兜底 */
    }
    if (!Number.isFinite(width) || width <= 0) {
      width = typeof window !== 'undefined' ? window.innerWidth : 0;
    }
    if (!Number.isFinite(height) || height <= 0) {
      height = typeof window !== 'undefined' ? window.innerHeight : 0;
    }
    return {
      width: Math.max(MIN_VIEWPORT, width || 0),
      height: Math.max(MIN_VIEWPORT, height || 0),
    };
  }
}
