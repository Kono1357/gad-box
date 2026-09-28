import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  SphereGeometry,
  WireframeGeometry,
} from 'three';
import type { BrushShape } from './BrushSystem';
import { BRUSH_SHAPE_COLORS } from './BrushSystem';

/**
 * 笔刷范围的 3D 可视化。
 *
 * 每种形状一套线框，切形状时只切换可见性（不重建几何体）。
 * 颜色按形状区分，并且会随"能否编辑"变成绿色/红色。
 *
 * 为什么用线框而不是半透明实体：
 * 半透明实体会挡住地形细节，而线框既能表达范围又不遮挡，
 * 在低多边形风格里也更统一。
 */
export class BrushVisualizer {
  readonly group = new Group();

  private readonly shapes = new Map<BrushShape, LineSegments | LineLoop>();
  private readonly materials = new Map<BrushShape, LineBasicMaterial>();
  private readonly disposables: Array<{ dispose(): void }> = [];

  /** 命中格的高亮小方块 */
  private readonly hitMarker: LineSegments;
  private readonly hitMaterial: LineBasicMaterial;

  private currentShape: BrushShape = 'sphere';

  constructor() {
    this.group.name = 'brush-visualizer';

    this.register('sphere', this.wire(new WireframeGeometry(new SphereGeometry(1, 14, 8))));
    this.register('cube', this.edges(new BoxGeometry(2, 2, 2)));
    this.register('cylinder', this.edges(new CylinderGeometry(1, 1, 2, 14, 1)));
    this.register('plane', this.circle(1));
    this.register('single', this.edges(new BoxGeometry(1, 1, 1)));

    this.hitMaterial = this.track(new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
    const markerGeometry = this.track(new EdgesGeometry(new BoxGeometry(1.02, 1.02, 1.02)));
    this.hitMarker = new LineSegments(markerGeometry, this.hitMaterial);
    this.hitMarker.name = 'brush-hit-marker';
    this.hitMarker.visible = false;
    this.group.add(this.hitMarker);

    this.setShape('sphere');
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  private wire(geometry: BufferGeometry): LineSegments {
    const material = this.track(new LineBasicMaterial({ color: 0xffffff }));
    const line = new LineSegments(this.track(geometry), material);
    this.materials.set('sphere', material);
    return line;
  }

  private edges(geometry: BufferGeometry): LineSegments {
    const material = this.track(new LineBasicMaterial({ color: 0xffffff }));
    const line = new LineSegments(this.track(new EdgesGeometry(geometry)), material);
    this.track(geometry);
    return line;
  }

  private circle(radius: number): LineLoop {
    const material = this.track(new LineBasicMaterial({ color: 0xffffff }));
    const geometry = this.track(new CircleGeometry(radius, 32));
    const loop = new LineLoop(geometry, material);
    this.materials.set('plane', material);
    return loop;
  }

  private register(shape: BrushShape, object: LineSegments | LineLoop): void {
    object.name = `brush-${shape}`;
    object.visible = false;
    // 材质统一登记（wire/edges/circle 里创建时已建，这里补 key）
    const material = object.material as LineBasicMaterial;
    this.materials.set(shape, material);
    material.color.setHex(BRUSH_SHAPE_COLORS[shape]);
    this.shapes.set(shape, object);
    this.group.add(object);
  }

  /** 切换形状 */
  setShape(shape: BrushShape): void {
    this.currentShape = shape;
    for (const [key, object] of this.shapes) object.visible = key === shape;
  }

  get shape(): BrushShape {
    return this.currentShape;
  }

  /**
   * 更新位置、尺寸与颜色。
   * @param center 体素中心相对世界原点的偏移（米）
   * @param radius 半径（米）
   * @param valid 是否可以编辑（红色表示越界/不可用）
   * @param visible 是否显示
   */
  update(
    center: { x: number; y: number; z: number } | null,
    radius: number,
    valid: boolean,
    visible: boolean,
  ): void {
    if (!center || !visible) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    const object = this.shapes.get(this.currentShape);
    if (object) {
      object.position.set(center.x, center.y, center.z);
      // 球形/立方形线框是"直径 2"的单位几何体，直接按半径缩放
      if (this.currentShape === 'single') object.scale.setScalar(1);
      else object.scale.setScalar(Math.max(0.25, radius));
    }

    const color = valid ? BRUSH_SHAPE_COLORS[this.currentShape] : 0xff5a5a;
    const material = this.materials.get(this.currentShape);
    if (material) material.color.setHex(color);

    this.hitMarker.visible = false;
  }

  /** 单独显示命中格（可选，用于精确对准） */
  setHitMarker(center: { x: number; y: number; z: number } | null, visible: boolean): void {
    if (!center || !visible) {
      this.hitMarker.visible = false;
      return;
    }
    this.hitMarker.visible = true;
    this.hitMarker.position.set(center.x, center.y, center.z);
  }

  dispose(): void {
    for (const resource of this.disposables) resource.dispose();
    this.disposables.length = 0;
    this.shapes.clear();
    this.materials.clear();
    this.group.clear();
  }
}

/** 供 TerrainUI / BrushUI 显示的笔刷提示文本 */
export function describeBrush(
  shape: BrushShape,
  radius: number,
  strength: number,
  affected: number,
): string {
  return `${shape} r=${radius.toFixed(1)} s=${strength.toFixed(2)} ≈${affected.toLocaleString('en-US')} 格`;
}

/** 圆锥辅助（给未来"方向指示"预留，当前未使用） */
export function createDirectionCone(): LineSegments {
  const geometry = new EdgesGeometry(new ConeGeometry(0.35, 1, 8));
  const material = new LineBasicMaterial({ color: 0xffcc4d });
  return new LineSegments(geometry, material);
}
