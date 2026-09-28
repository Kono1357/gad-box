/**
 * 沙崩可视化（M4 第二部分 · 第 3 批）。
 *
 * 显示三件事（需求里的"沙崩可视化：显示角度、滑落方向、连锁范围"）：
 * 1. **角度**：在活跃沙格上方画一个小"坡度指示"（短线 + 颜色随安息角变化）；
 *    **颜色语义**：绿 = 远低于安息角（很稳）、黄 = 接近、红 = 已经超过（马上要滑）。
 * 2. **滑落方向**：从沙格指向"它会往哪边滑"（用与求解器同一套方向规则算出来的最陡方向）。
 * 3. **连锁范围**：最近一次沙崩画一个方框（边长按搬动的格数开立方）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么用"线段 + 颜色"而不是箭头模型
 * ────────────────────────────────────────────────────────────
 * 一次沙崩可能涉及几千格。每格一个箭头模型（带箭头的三角形）会直接把帧率拖垮，
 * 而它们要传达的信息只有"方向"和"严重程度"。所以这里把**所有**指示合并成
 * 一条 `LineSegments`（1 次 draw call），颜色写在顶点属性里。
 * 与 `ConflictOverlay` 同一套做法。
 *
 * ⚠ 如实说明：这里的"坡度"是用**邻居高度差**算的离散近似（每格 22°，见 SandSystem），
 * 不是真实的地形梯度。它的用途是"让我一眼看出哪片沙要塌了"，不是"测量角度"。
 * 面板上给出的角度值来自 `SandPhysics` 的公式（那个是精确的）；可视化里的颜色只是分段近似。
 */

import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments } from 'three';
import type { VoxelGrid } from '../voxel/VoxelGrid';
import { getVoxelId } from '../data/voxelTypes';
import type { SandSystem } from './SandSystem';

const SAND = getVoxelId('sand');

/** 最多画多少个指示（超出部分如实统计并在面板上说明） */
const MAX_MARKERS = 600;

export interface SandVisualizerStats {
  /** 实际画出的指示数 */
  drawn: number;
  /** 因为超过上限没画的 */
  skipped: number;
  /** 超过安息角（红色）的格子数 */
  unstable: number;
}

export class SandVisualizer {
  readonly group = new Group();
  private readonly geometry = new BufferGeometry();
  private readonly material: LineBasicMaterial;
  private readonly lines: LineSegments;
  private lastStats: SandVisualizerStats = { drawn: 0, skipped: 0, unstable: 0 };
  private visible = false;

  constructor() {
    this.material = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });
    this.lines = new LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.name = 'sand-debug-lines';
    this.group.add(this.lines);
    this.group.visible = false;
    this.group.name = 'sand-visualizer';
  }

  get stats(): SandVisualizerStats {
    return this.lastStats;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
  }

  /**
   * 重建指示线段。
   *
   * 只看**活跃格子**（沙系统维护的那个集合）：一池静止的沙不需要可视化，
   * 而"要塌的地方"恰恰就是活跃格。这也是为什么这个可视化在几千格的沙崩下仍然便宜。
   */
  update(grid: VoxelGrid, sand: SandSystem, center?: { x: number; y: number; z: number }, radius = 48): SandVisualizerStats {
    if (!this.visible) return this.lastStats;
    const positions: number[] = [];
    const colors: number[] = [];
    let drawn = 0;
    let skipped = 0;
    let unstable = 0;

    const active = sand.activeCells();
    for (const [x, y, z] of active) {
      if (drawn >= MAX_MARKERS) {
        skipped += 1;
        continue;
      }
      if (grid.getVoxel(x, y, z) !== SAND) continue;
      if (center) {
        const distance = Math.hypot(x - center.x, y - center.y, z - center.z);
        if (distance > radius) continue;
      }
      // 颜色：绿→黄→红 表示"离滑落还有多远"。
      // 基准取"稳定性"（它同时考虑了湿度、载荷与坡度），而不是只看湿度 ——
      // 只看湿度的话，一堆压得很沉的干沙会被画成"很稳"，而它其实快塌了。
      const stability = sand.stabilityAt(x, y, z);
      const redness = Math.max(0, Math.min(1, 1 - stability));
      const r = redness;
      const g = 1 - redness * 0.85;
      const b = 0.15;

      // 1) 立场：从格子中心竖直向上 0.6 格，用来标出"这里有活跃沙"
      positions.push(x + 0.5, y + 0.5, z + 0.5, x + 0.5, y + 1.1, z + 0.5);
      colors.push(r, g, b, r, g, b);

      // 2) 最陡方向：四个斜下方里"落差最大"的那个
      let bestDx = 0;
      let bestDz = 0;
      let bestDrop = 0;
      for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
        const nx = x + dx;
        const nz = z + dz;
        if (!grid.inHorizontalBounds(nx, nz)) continue;
        const neighborTop = grid.solidSurfaceHeight(nx, nz);
        const drop = y - neighborTop;
        if (drop > bestDrop) {
          bestDrop = drop;
          bestDx = dx;
          bestDz = dz;
        }
      }
      if (bestDrop > 0) {
        positions.push(
          x + 0.5, y + 0.5, z + 0.5,
          x + 0.5 + bestDx * 0.9, y + 0.5 - Math.min(1.5, bestDrop * 0.5), z + 0.5 + bestDz * 0.9,
        );
        // 方向线用更亮的颜色，和"立场"区分开
        colors.push(1, 1, 1, 1, 0.8, 0.2);
      }

      // "不稳"的判据用稳定性元数据（SandSystem 里的启发式），而不是这里另算一套坡度 ——
      // 两套判据迟早会不一致，而"可视化说很稳、沙却塌了"比不显示更糟
      if (sand.stabilityAt(x, y, z) < 0.35) unstable += 1;
      drawn += 1;
    }

    // 3) 最近一次沙崩的范围框（只在它够新的时候画）
    const last = sand.recentCollapses[0];
    if (last) {
      // 用搬动格数估算"连锁范围"的边长：cells^(1/3) 格
      const side = Math.max(2, Math.cbrt(last.cells) * 1.5);
      pushBox(positions, colors, last.x - side, last.y - side * 0.3, last.z - side, last.x + side, last.y + side * 0.6, last.z + side, 1, 0.3, 0.3);
    }

    this.geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    this.geometry.computeBoundingSphere();
    this.lastStats = { drawn, skipped, unstable };
    return this.lastStats;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.group.remove(this.lines);
    this.group.clear();
  }
}

/** 往线段数组里塞一个方框的 12 条边 */
function pushBox(
  positions: number[],
  colors: number[],
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
  r: number, g: number, b: number,
): void {
  const corners: [number, number, number][] = [
    [minX, minY, minZ], [maxX, minY, minZ], [maxX, minY, maxZ], [minX, minY, maxZ],
    [minX, maxY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ], [minX, maxY, maxZ],
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (const [a, c] of edges) {
    const pa = corners[a]!;
    const pc = corners[c]!;
    positions.push(pa[0], pa[1], pa[2], pc[0], pc[1], pc[2]);
    colors.push(r, g, b, r, g, b);
  }
}
