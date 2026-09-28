/**
 * 拖拽连线的视觉层（M3 第 4 批的收尾）。
 *
 * 玩家打开「拖拽连线」模式后：在视口里从一个物体按下、拖到另一个物体上松开，
 * 就建立一条逻辑连线。这个文件负责**画那条线** —— 一条跟随光标的虚线，
 * 加上起点与终点的圆点，以及一句"松手连上"的提示。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么用 SVG 覆盖层而不是在 3D 场景里画线
 * ────────────────────────────────────────────────────────────
 * 3D 里画线会遇到两个麻烦：① 线要跟着已投影的屏幕点走，每帧都要把屏幕坐标反投回世界坐标
 * （多一次矩阵求逆，而且近平面附近会数值爆炸）；② 线的粗细会随距离变化（远处细到看不见）。
 * 而屏幕空间的连线**本来就该是屏幕空间的** —— 它表达的是"这两个东西之间的连接"，
 * 不是"空间中的一根绳子"。所以 SVG 覆盖层既更简单也更准确。
 *
 * 与 `HintBanner` / `GestureTutorial` 一样，DOM 全部自建、不依赖 `index.html` 的 id ——
 * 关键交互路径上的组件不该因为 HTML 被改坏而白屏。
 */

export interface ScreenPoint {
  x: number;
  y: number;
  /** 这个点当前是否有效（投影失败时为 false，线会画成灰色虚线） */
  valid: boolean;
}

export interface ConnectorOverlayOptions {
  /** 线的颜色，默认主题绿 */
  color?: string;
  /** 无效目标时的颜色 */
  invalidColor?: string;
}

export class ConnectorOverlay {
  private readonly root: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly line: SVGLineElement;
  private readonly startDot: SVGCircleElement;
  private readonly endDot: SVGCircleElement;
  private readonly label: HTMLDivElement;
  private readonly options: Required<ConnectorOverlayOptions>;
  private active = false;

  constructor(options: ConnectorOverlayOptions = {}) {
    this.options = {
      color: options.color ?? '#4ade80',
      invalidColor: options.invalidColor ?? '#f87171',
    };

    this.root = document.createElement('div');
    this.root.id = 'connector-overlay';
    Object.assign(this.root.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '35',
      display: 'none',
    } satisfies Partial<CSSStyleDeclaration>);

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('width', '100%');
    this.svg.setAttribute('height', '100%');
    Object.assign(this.svg.style, { position: 'absolute', inset: '0', overflow: 'visible' });

    this.line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    this.line.setAttribute('stroke', this.options.color);
    this.line.setAttribute('stroke-width', '2');
    this.line.setAttribute('stroke-dasharray', '7 5');
    this.line.setAttribute('stroke-linecap', 'round');

    this.startDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    this.startDot.setAttribute('r', '6');
    this.startDot.setAttribute('fill', this.options.color);
    this.startDot.setAttribute('stroke', 'rgba(0,0,0,0.5)');

    this.endDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    this.endDot.setAttribute('r', '7');
    this.endDot.setAttribute('fill', 'none');
    this.endDot.setAttribute('stroke', this.options.color);
    this.endDot.setAttribute('stroke-width', '2.5');

    this.svg.append(this.line, this.startDot, this.endDot);

    this.label = document.createElement('div');
    Object.assign(this.label.style, {
      position: 'absolute',
      transform: 'translate(-50%, -50%)',
      padding: '3px 8px',
      borderRadius: '999px',
      background: 'rgba(10, 14, 18, 0.86)',
      border: '1px solid rgba(255,255,255,0.16)',
      color: '#e8eef5',
      font: '12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
    });

    this.root.append(this.svg, this.label);
    document.body.appendChild(this.root);
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * 开始拖拽。
   *
   * @param from 起点的屏幕坐标
   * @param label 起点标签（显示"从「木门」开始"）
   */
  begin(from: ScreenPoint, label: string): void {
    this.active = true;
    this.root.style.display = 'block';
    this.startDot.setAttribute('cx', String(from.x));
    this.startDot.setAttribute('cy', String(from.y));
    this.line.setAttribute('x1', String(from.x));
    this.line.setAttribute('y1', String(from.y));
    this.label.textContent = label;
    this.label.style.left = `${from.x}px`;
    this.label.style.top = `${Math.max(12, from.y - 28)}px`;
    // 起点圆点也要跟着标签走（否则"从谁开始"这一眼看不出来）
    this.update(from, false);
  }

  /**
   * 拖动中更新。
   *
   * @param to 当前光标的屏幕坐标
   * @param overTarget 光标下有没有**合法的目标**（决定颜色与提示文案）
   * @param targetLabel 目标标签
   */
  update(to: ScreenPoint, overTarget: boolean, targetLabel?: string): void {
    if (!this.active) return;
    const color = overTarget && to.valid ? this.options.color : this.options.invalidColor;
    this.line.setAttribute('stroke', color);
    this.line.setAttribute('x2', String(to.x));
    this.line.setAttribute('y2', String(to.y));
    this.endDot.setAttribute('cx', String(to.x));
    this.endDot.setAttribute('cy', String(to.y));
    this.endDot.setAttribute('stroke', color);
    this.label.textContent = overTarget
      ? `松手连到「${targetLabel ?? '目标'}」`
      : '拖到一个物体上松手';
  }

  /** 结束拖拽（无论成功与否都要调，否则覆盖层会一直挂着） */
  end(): void {
    this.active = false;
    this.root.style.display = 'none';
    this.label.textContent = '';
  }

  dispose(): void {
    this.active = false;
    this.root.remove();
  }
}
