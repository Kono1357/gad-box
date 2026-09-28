import {
  BoxGeometry,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
} from 'three';

/**
 * 智能放置候选位置的「脉冲呼吸高亮框」。
 *
 * 画法（刻意用线框 + 半透明填充，而不是纯实体）：
 * - 主体是 `EdgesGeometry` + `LineSegments` 的棱边，形状一眼看得清；
 * - 再加一个 `MeshBasicMaterial` 半透明填充面，让"体积"有存在感但不糊住地形；
 * - 两个材质的透明度和颜色都随呼吸变化：绿 = 有效候选，红 = 无效候选。
 *
 * 为什么 `depthTest = false` + `renderOrder = 999`：
 * 候选点经常落在山体背面或被墙挡住，而玩家最需要看到的就是"它会放在哪"。
 * 关掉深度测试后高亮框永远画在最上层，代价是它不会与地形产生遮挡关系 ——
 * 对这个用途是划算的（用户明确要求"高亮框不会被地形挡住"）。
 *
 * 性能：几何体只在构造时建一次（单位立方体），`show()` 只改
 * `position` / `scale` / 材质颜色 —— 候选点每帧都在动，重建 geometry 会直接卡死。
 */

/** 高亮框的范围描述。注意字段是**几何中心**（不是建筑实例的底面 position[1]） */
export interface HighlightBox {
  centerX: number;
  centerY: number;
  centerZ: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

export interface HighlightRendererOptions {
  /** 有效候选的颜色，默认 0x4ade80（绿）。无效候选自动用红色 0xf87171。 */
  validColor?: number;
  invalidColor?: number;
  /** 呼吸频率（Hz），默认 0.8 */
  pulseHz?: number;
  /** 尺寸放大系数，默认 1.1（= 比真实体积大 10%） */
  sizeScale?: number;
}

const DEFAULT_VALID_COLOR = 0x4ade80;
const DEFAULT_INVALID_COLOR = 0xf87171;
const DEFAULT_PULSE_HZ = 0.8;
const DEFAULT_SIZE_SCALE = 1.1;

/** 填充面透明度区间（呼吸的两个端点） */
const FILL_OPACITY_MIN = 0.06;
const FILL_OPACITY_MAX = 0.16;
/** 棱边透明度区间 */
const LINE_OPACITY_MIN = 0.55;
const LINE_OPACITY_MAX = 1;

/** 上下浮动幅度占框高的比例，以及绝对上限（米）——"轻微"浮动，别让玩家看成抖动 */
const FLOAT_RATIO = 0.03;
const FLOAT_MAX = 0.06;

/** 高亮框最小边长（米），防止尺寸为 0 的物件缩成看不见的一条线 */
const MIN_EXTENT = 0.02;

export class HighlightRenderer {
  /** 挂到场景里的根节点 */
  readonly group = new Group();

  private readonly unitBox: BoxGeometry;
  private readonly edgeGeometry: EdgesGeometry;
  private readonly lines: LineSegments;
  private readonly fill: Mesh;
  private readonly lineMaterial: LineBasicMaterial;
  private readonly fillMaterial: MeshBasicMaterial;

  private readonly validColor: number;
  private readonly invalidColor: number;
  private readonly pulseHz: number;
  private readonly sizeScale: number;

  /** 当前是否是「有效候选」配色 */
  private validFlag = true;
  private colorsApplied = false;
  private disposed = false;

  /** 当前框的尺寸与中心（浮动动画要用到基准高度） */
  private baseY = 0;
  private sizeX = 1;
  private sizeY = 1;
  private sizeZ = 1;

  constructor(options: HighlightRendererOptions = {}) {
    this.validColor = options.validColor ?? DEFAULT_VALID_COLOR;
    this.invalidColor = options.invalidColor ?? DEFAULT_INVALID_COLOR;
    this.pulseHz = Math.max(0, options.pulseHz ?? DEFAULT_PULSE_HZ);
    this.sizeScale = Math.max(0.01, options.sizeScale ?? DEFAULT_SIZE_SCALE);

    this.group.name = 'placement-highlight';
    this.group.visible = false;
    this.group.renderOrder = 999;

    // 单位立方体：居中在原点，靠 scale 变成任意尺寸 —— 永远不会重建几何体
    this.unitBox = new BoxGeometry(1, 1, 1);
    this.edgeGeometry = new EdgesGeometry(this.unitBox);

    this.lineMaterial = new LineBasicMaterial({
      color: this.validColor,
      transparent: true,
      opacity: LINE_OPACITY_MAX,
      depthTest: false,
      depthWrite: false,
    });
    this.fillMaterial = new MeshBasicMaterial({
      color: this.validColor,
      transparent: true,
      opacity: FILL_OPACITY_MIN,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
    });

    this.lines = new LineSegments(this.edgeGeometry, this.lineMaterial);
    this.lines.name = 'placement-highlight-edges';
    this.lines.renderOrder = 999;
    this.fill = new Mesh(this.unitBox, this.fillMaterial);
    this.fill.name = 'placement-highlight-fill';
    this.fill.renderOrder = 999;

    this.group.add(this.fill, this.lines);
    this.applyColors(this.validFlag);
  }

  /** 当前是否可见 */
  get visible(): boolean {
    return this.group.visible;
  }

  /** 当前是否是「有效候选」配色 */
  get isValid(): boolean {
    return this.validFlag;
  }

  /**
   * 显示/更新高亮框。repeat 调用同一位置不会重几何体。
   * @param box 目标范围（几何中心 + 尺寸，尺寸会被 sizeScale 放大）
   * @param valid 是否有效候选（决定绿 / 红配色）
   */
  show(box: HighlightBox, valid: boolean): void {
    if (this.disposed) return;

    const sx = extentOf(box.sizeX) * this.sizeScale;
    const sy = extentOf(box.sizeY) * this.sizeScale;
    const sz = extentOf(box.sizeZ) * this.sizeScale;

    this.baseY = Number.isFinite(box.centerY) ? box.centerY : 0;
    this.group.position.set(
      Number.isFinite(box.centerX) ? box.centerX : 0,
      this.baseY,
      Number.isFinite(box.centerZ) ? box.centerZ : 0,
    );

    // 只在尺寸真的变了才写 scale，避免每帧产生无意义的矩阵更新
    if (sx !== this.sizeX || sy !== this.sizeY || sz !== this.sizeZ) {
      this.sizeX = sx;
      this.sizeY = sy;
      this.sizeZ = sz;
      this.group.scale.set(sx, sy, sz);
    }

    if (!this.colorsApplied || valid !== this.validFlag) {
      this.applyColors(valid);
    }

    this.group.visible = true;
  }

  /** 每帧调用做呼吸动画 + 轻微上下浮动 */
  update(nowMs: number): void {
    if (this.disposed || !this.group.visible) return;

    const time = Number.isFinite(nowMs) ? nowMs / 1000 : 0;
    const phase = time * this.pulseHz * Math.PI * 2;
    const wave = Math.sin(phase); // -1 .. 1
    const breathe = (wave + 1) * 0.5; // 0 .. 1

    this.fillMaterial.opacity = FILL_OPACITY_MIN + (FILL_OPACITY_MAX - FILL_OPACITY_MIN) * breathe;
    this.lineMaterial.opacity = LINE_OPACITY_MIN + (LINE_OPACITY_MAX - LINE_OPACITY_MIN) * breathe;

    // 轻微上下浮动：幅度随框高走，但封顶，免得高个子物件浮得太夸张
    const amplitude = Math.min(FLOAT_MAX, this.sizeY * FLOAT_RATIO);
    this.group.position.y = this.baseY + wave * amplitude;
  }

  hide(): void {
    this.group.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.visible = false;
    this.group.remove(this.fill, this.lines);
    this.edgeGeometry.dispose();
    this.unitBox.dispose();
    this.lineMaterial.dispose();
    this.fillMaterial.dispose();
  }

  // ---------------------------------------------------------------- 内部

  /** 两个材质都要换色，否则填充面和棱边会一红一绿 */
  private applyColors(valid: boolean): void {
    const hex = valid ? this.validColor : this.invalidColor;
    this.lineMaterial.color.setHex(hex);
    this.fillMaterial.color.setHex(hex);
    this.validFlag = valid;
    this.colorsApplied = true;
  }
}

/** 尺寸兜底：取绝对值并给一个最小边长 */
function extentOf(size: number): number {
  if (!Number.isFinite(size)) return MIN_EXTENT;
  return Math.max(MIN_EXTENT, Math.abs(size));
}
