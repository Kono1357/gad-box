/**
 * 冲突可视化（M4 补充 7）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么需要它
 * ────────────────────────────────────────────────────────────
 * 冲突检测的结论是一个数字（"冲突 7 处"）和一串 id。对玩家来说这两个东西都
 * **没法用**：他不知道那 7 处在哪里、有多大、该往哪边挪。
 * 所以这里把每条冲突画成一个带颜色的小方框标记 + 一条落到地面的竖线，
 * 让"冲突 7 处"变成"那边树冠里有两个框"。
 *
 * ────────────────────────────────────────────────────────────
 * 它**不是**什么（如实说明，见 README 的取舍清单）
 * ────────────────────────────────────────────────────────────
 * 1. **画的是标记，不是重叠体积**。框的边长是固定值（0.6 米）×严重度系数，
 *    不是真实相交区域的尺寸。真正的相交体积只在 `ConflictRecord.detail` 文本里，
 *    而且只是轴对齐包围盒的相交尺寸（不是几何体的真实相交）。
 * 2. **位置是"冲突重心"**：重叠类冲突取两个 AABB 相交盒的中心，
 *    单物体冲突取物体原点。所以标记落在物体上而不是"悬在空中"。
 * 3. **不参与拾取**：标记不可点、不进物理、不影响存档。它是一层纯视觉辅助，
 *    关掉之后世界一个字节都没变。
 *
 * 渲染上刻意用**合并线段几何**（LineSegments）而不是每处一个 Mesh：
 * 一处冲突 12 条边 + 1 条竖线，几百处也只是一次 draw call。
 * 这类"辅助显示"最容易把帧率拖垮，而它恰恰是在性能出问题时才被打开的。
 */

import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments } from 'three';
import { CONFLICT_TYPE_LABELS, type ConflictRecord, type ConflictType } from './ConflictDetector';

/** 每类冲突的颜色。红=重叠（最该先处理）、黄=悬空、橙=越界、紫=被埋、蓝=挡门 */
export const CONFLICT_COLORS: Record<ConflictType, number> = {
  overlap: 0xff4d4d,
  floating: 0xffd24d,
  outOfBounds: 0xff8a3d,
  buried: 0xa86bff,
  'blocks-doorway': 0x4dc9ff,
};

/**
 * 每类冲突的建议修法（中文）。
 *
 * 这里**只说能做得到的事**：例如"重叠"给的是"把其中一个挪开或删掉"，
 * 而不是"自动避让"——自动避让要解算几何，这一版没做（见 README 取舍）。
 */
export const CONFLICT_SUGGESTED_FIX: Record<ConflictType, string> = {
  overlap: '把其中一个挪开，或删掉较不重要的那个（建筑构件不会被挪动，所以通常挪树或小物品）',
  floating: '把它降到底下的支撑面上，或给它加支撑（生成器会自动降到地表顶面）',
  outOfBounds: '往世界内侧挪；如果是贴着边界生成的，改小生成范围比反复挪更有效',
  buried: '把树抬到树冠露出地表（抬高上限 6 米），抬不动就删掉这一棵',
  'blocks-doorway': '把它从门口挪开：门的通行范围要求 1.2 米净空',
};

export interface ConflictOverlayOptions {
  /** 标记方框的基础边长（米）。默认 0.6 —— 太小在大世界里看不见，太大会盖住物体 */
  markerSize?: number;
  /** 是否画"落到地面的竖线"。默认 true：只画方框时看不出它在空中还是地上 */
  dropLine?: boolean;
  /** 最多画多少个标记。默认 400；超出部分**如实报告**而不是静默丢弃 */
  maxMarkers?: number;
}

export interface ConflictOverlayStats {
  /** 实际画出的标记数 */
  drawn: number;
  /** 因为超过上限没有画的标记数 */
  skipped: number;
  /** 各类冲突的标记数 */
  byType: Record<string, number>;
}

export class ConflictOverlay {
  /** 挂到场景上的根节点（`Engine` 负责 add/remove） */
  readonly group = new Group();
  private readonly lines: LineSegments;
  private readonly geometry = new BufferGeometry();
  private readonly material: LineBasicMaterial;
  private readonly options: Required<ConflictOverlayOptions>;
  private lastStats: ConflictOverlayStats = { drawn: 0, skipped: 0, byType: {} };

  constructor(options: ConflictOverlayOptions = {}) {
    this.options = {
      markerSize: options.markerSize ?? 0.6,
      dropLine: options.dropLine ?? true,
      maxMarkers: options.maxMarkers ?? 400,
    };
    this.group.name = 'conflict-overlay';
    this.material = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });
    this.lines = new LineSegments(this.geometry, this.material);
    this.lines.name = 'conflict-markers';
    // 辅助显示不该因为"包围盒算错了"而整片消失
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
    this.group.visible = false;
  }

  /** 上一次重画的统计（drawn/skipped/byType）。用 `skipped` 如实暴露"画不下的那些" */
  get stats(): ConflictOverlayStats {
    return this.lastStats;
  }

  get markerCount(): number {
    return this.lastStats.drawn;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /**
   * 重画标记。
   *
   * 每帧调用是安全的（缓冲区是复用的），但没必要 —— 冲突只在生成/编辑后变化，
   * 由 `Engine` 在那些时刻调用即可。
   */
  setConflicts(conflicts: readonly ConflictRecord[]): void {
    const { markerSize, dropLine, maxMarkers } = this.options;
    const positions: number[] = [];
    const colors: number[] = [];
    const byType: Record<string, number> = {};
    let drawn = 0;

    for (const conflict of conflicts) {
      if (drawn >= maxMarkers) break;
      const color = CONFLICT_COLORS[conflict.type];
      const r = ((color >> 16) & 0xff) / 255;
      const g = ((color >> 8) & 0xff) / 255;
      const b = (color & 0xff) / 255;
      // 严重度 40~140 折算成 1.0~1.6 倍大小：越严重的框越大，一眼能排出先后
      const scale = 1 + Math.min(0.6, Math.max(0, conflict.severity - 40) / 100);
      const size = markerSize * scale;
      const [cx, cy, cz] = conflict.position;
      const half = size / 2;

      // 12 条边：用两两组合直接写出来，比生成 EdgesGeometry 再拷顶点更省事也更快
      for (const axis of [0, 1, 2] as const) {
        for (const a of [-1, 1] as const) {
          for (const b of [-1, 1] as const) {
            const p0: [number, number, number] = [cx, cy, cz];
            const p1: [number, number, number] = [cx, cy, cz];
            p0[axis] -= half;
            p1[axis] += half;
            const other = [0, 1, 2].filter((index) => index !== axis) as [number, number];
            p0[other[0]!] += a * half;
            p0[other[1]!] += b * half;
            p1[other[0]!] += a * half;
            p1[other[1]!] += b * half;
            positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2]);
            colors.push(r, g, b, r, g, b);
          }
        }
      }

      if (dropLine) {
        // 竖线画到 y=0 而不是"地面"：地面高度要查地形，而地形在生成过程中还在变。
        // 落到 0 至少能让人看出"这个标记在世界的哪个水平位置"，而且它一定在地面以下，
        // 不会出现"线飘在空中"的错误视觉。
        positions.push(cx, 0, cz, cx, cy - half, cz);
        colors.push(r, g, b, r, g, b);
      }

      drawn += 1;
      byType[conflict.type] = (byType[conflict.type] ?? 0) + 1;
    }

    this.geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    this.geometry.computeBoundingSphere();
    this.lastStats = { drawn, skipped: Math.max(0, conflicts.length - drawn), byType };
  }

  /** 释放 GPU 资源。调用后 `setConflicts` 仍可用（缓冲区会被重建），但不该再画 */
  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.group.remove(this.lines);
    this.group.clear();
    this.lastStats = { drawn: 0, skipped: 0, byType: {} };
  }
}

/**
 * 面板用：把冲突列表写成中文说明行。
 *
 * 纯函数（不碰 DOM / Three.js），所以能在 Node 里断言 ——
 * 这是刻意的：可视化的**文案**比框子本身更容易出错（写错类型名、数字没格式化），
 * 而它在浏览器里"看起来正常"。
 */
export function describeConflicts(conflicts: readonly ConflictRecord[], limit = 8): string[] {
  if (conflicts.length === 0) return ['没有冲突：物体之间不重叠、不悬空、不越界、树冠没有被盖住'];
  const byType = new Map<ConflictType, number>();
  for (const conflict of conflicts) byType.set(conflict.type, (byType.get(conflict.type) ?? 0) + 1);
  const head = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${CONFLICT_TYPE_LABELS[type]} ${count} 处`)
    .join('｜');
  const lines = [`共 ${conflicts.length} 处冲突：${head}`];
  // 只列最严重的几条：全列出来会把面板撑爆，而且人一次也处理不了几十条
  const worst = [...conflicts].sort((a, b) => b.severity - a.severity).slice(0, limit);
  for (const conflict of worst) {
    lines.push(
      `· [${CONFLICT_TYPE_LABELS[conflict.type]}] ${conflict.detail}` +
        `（位置 ${conflict.position.map((value) => value.toFixed(1)).join(', ')}）` +
        `｜建议：${CONFLICT_SUGGESTED_FIX[conflict.type]}`,
    );
  }
  if (conflicts.length > worst.length) lines.push(`…另有 ${conflicts.length - worst.length} 处未列出`);
  return lines;
}
