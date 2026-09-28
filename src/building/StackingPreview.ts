import { BufferAttribute, BufferGeometry, Group, LineBasicMaterial, LineSegments } from 'three';
import type { BuildingInstance, Stability } from './types';
import { STABILITY_COLORS } from './StackingSystem';
import type { StackResolution } from './StackingSystem';
import type { SupportSurfaceInfo } from './SupportSurface';

interface Disposable {
  dispose(): void;
}

/**
 * 堆叠可视化（问题 2.5 支撑面可视化 + 补充 2 稳定性提示）。
 *
 * 画三样东西：
 * 1. **支撑面外框** —— 即将落在哪个物体的顶面上；
 * 2. **已占用格子** —— 那个顶面上已经放了什么（这就是"剩余面积"的直观来源）；
 * 3. **接触区** —— 新物体与支撑面真正贴合的那块矩形，颜色表示稳定性
 *    （绿 = 稳固 / 黄 = 勉强 / 红 = 不稳）。
 *
 * 全部合并进**一个** LineSegments：候选点每帧都在变，用几百个独立对象会拖慢帧率，
 * 而合并之后无论画多少格子都只占 1 次 draw call。
 */
export class StackingPreview {
  readonly group = new Group();

  private readonly lines: LineSegments;
  private readonly material: LineBasicMaterial;
  private readonly disposables: Disposable[] = [];
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];

  constructor() {
    this.group.name = 'stacking-preview';
    this.material = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 });
    this.disposables.push(this.material);
    const geometry = new BufferGeometry();
    this.disposables.push(geometry);
    this.lines = new LineSegments(geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
    this.group.add(this.lines);
    this.group.visible = false;
  }

  /**
   * 更新可视化。
   * @param resolution 当前预览落点的解析结果（null 表示隐藏）
   * @param surface 支撑面明细（可选，用来画出已占用格子）
   * @param totalHeight 堆叠后的总高度（用于画一条高度参考线）
   */
  update(
    resolution: StackResolution | null,
    surface: SupportSurfaceInfo | null,
    visible: boolean,
    totalHeight = 0,
  ): void {
    if (!resolution || !visible) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.positions.length = 0;
    this.colors.length = 0;

    const stabilityColor = STABILITY_COLORS[resolution.stability];

    // 1) 支撑面外框（白色细框）
    if (surface) {
      this.pushRect(
        surface.minX,
        surface.topY + 0.01,
        surface.minZ,
        surface.maxX,
        surface.maxZ,
        0x8899aa,
      );
      // 2) 已占用格子（淡橙色）
      for (const slot of surface.occupiedBy) {
        this.pushRect(slot.minX, surface.topY + 0.02, slot.minZ, slot.maxX, slot.maxZ, 0xff9a4d);
      }
    }

    // 3) 接触区（按稳定性着色）
    if (resolution.contactRect) {
      this.pushRect(
        resolution.contactRect.minX,
        resolution.supportTopY + 0.03,
        resolution.contactRect.minZ,
        resolution.contactRect.maxX,
        resolution.contactRect.maxZ,
        stabilityColor,
      );
    }

    // 4) 从接触区中心往上的高度参考线（浅灰）
    const cx = (resolution.position[0]);
    const cz = (resolution.position[2]);
    if (totalHeight > 0) {
      this.pushLine(cx, resolution.supportTopY, cz, cx, totalHeight, cz, 0x556677);
    }

    const geometry = this.lines.geometry;
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    geometry.computeBoundingSphere();
  }

  /** 高亮某个已有物体的顶面（"会落在哪个物体上"的提示） */
  hide(): void {
    this.group.visible = false;
  }

  private pushRect(
    minX: number,
    y: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    color: number,
  ): void {
    this.pushLine(minX, y, minZ, maxX, y, minZ, color);
    this.pushLine(maxX, y, minZ, maxX, y, maxZ, color);
    this.pushLine(maxX, y, maxZ, minX, y, maxZ, color);
    this.pushLine(minX, y, maxZ, minX, y, minZ, color);
  }

  private pushLine(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    color: number,
  ): void {
    this.positions.push(x0, y0, z0, x1, y1, z1);
    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;
    this.colors.push(r, g, b, r, g, b);
  }

  dispose(): void {
    for (const resource of this.disposables) resource.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }
}

/** 稳定性 → CSS 颜色（UI 文本用） */
export function stabilityCssColor(stability: Stability): string {
  const hex = STABILITY_COLORS[stability];
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/** 给调试面板用的一句话摘要 */
export function describeStacking(instance: BuildingInstance | null): string {
  if (!instance) return '未选中物体';
  const layer = instance.stackLayer ?? 1;
  const stability = instance.stability ?? 'stable';
  const contact = Math.round((instance.contactRatio ?? 0) * 100);
  return `第 ${layer} 层｜接触 ${contact}%｜${stability}`;
}
