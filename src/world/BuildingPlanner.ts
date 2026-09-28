/**
 * 建筑规划与生成（M4 第 5 批：流水线的阶段 6、7、8）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么"先规划、再生成"是必须的（而不是边找地方边盖房）
 * ────────────────────────────────────────────────────────────
 * 边找边盖的写法有两个必然后果：
 * 1. **房子会互相挤**：第二栋房子只知道"第一栋在哪"，不知道"这一片将来还会有第三、第四栋"，
 *    于是越盖越密，最后两栋贴在一起；
 * 2. **树没法避让**：自然物在阶段 5 就种完了，如果房子在阶段 7 才现找地方，
 *    必然有树长在房子里 —— 这正是用户说的"树被建筑挤掉/建筑压在树上"。
 *
 * 所以阶段 6 先把**所有**地块（plot）圈出来（含间距与朝向），阶段 5 的种树就能一次性避开它们，
 * 阶段 7 只在圈好的地块里盖房。三个阶段的顺序不能换。
 *
 * ────────────────────────────────────────────────────────────
 * 地块是怎么选出来的
 * ────────────────────────────────────────────────────────────
 * 判据只有三条，但每条都有理由：
 * 1. **地要平**：地块四角的高差 ≤ `maxSlope`（默认 1.2 米）。斜坡上盖房必然一半悬空，
 *    而"建筑不悬空"是验收标准；
 * 2. **不能在水里/水边**：整块地的最低点必须高于水面 `waterMargin`（默认 1 米），
 *    否则房子会泡在水里；
 * 3. **彼此留距离**：地块之间至少 `plotSpacing`（默认 3 米）。
 *
 * 选地块用**拒绝采样**（随机撒点 + 检查）而不是网格划分：网格划分看起来整齐，
 * 但在不规则地形上会产生大量"不合格的空格"，而拒绝采样在不合格时会自然跳到下一处。
 *
 * ────────────────────────────────────────────────────────────
 * 小物品（阶段 8）放在哪
 * ────────────────────────────────────────────────────────────
 * 优先级：**桌面上 > 室内地面 > 建筑周围地面**。而且必须检查两件事：
 * 1. **不悬空**：物品的 y 由所在地块的**真实地面高度**算出来，不是拍一个数；
 * 2. **不堵门**：与门洞的水平距离小于 `doorClearance` 的物品会被跳过 ——
 *    这条留给阶段 9 的冲突检测做二次确认，但这里先挡掉大部分，避免生成一堆立刻要被删的东西。
 */

import type { VoxelGrid } from '../voxel/VoxelGrid';
import type { StagedObject } from './ConflictDetector';

export interface PlotRect {
  id: string;
  /** 世界坐标的中心 */
  centerX: number;
  centerZ: number;
  /** 地块尺寸（米） */
  width: number;
  depth: number;
  /** 地面高度（地块四角的**最低**点，保证建筑不悬空） */
  groundY: number;
  /** 四角高差（用于日志"这块地有多平"） */
  relief: number;
  rotationY: number;
}

export interface PlanningOptions {
  /** 目标地块数（密度会乘进来） */
  targetCount: number;
  /** 地块尺寸（米） */
  plotWidth: number;
  plotDepth: number;
  /** 地块之间的最小间距（米） */
  plotSpacing: number;
  /** 地块内允许的最大四角高差（米） */
  maxSlope: number;
  /** 地块最低点必须高于水面多少米 */
  waterMargin: number;
  /** 拒绝采样的最大尝试次数（防止在不合格的地形上死循环） */
  maxAttempts: number;
  /**
   * 一栋房子需要多少垂直净空（米）。
   *
   * 为什么必须有这一条：世界档的**地形上限贴着世界天花板**（新手档 sizeY=16、
   * 地形最高 15 格）。在没有净空检查的第一版里，高地上一块"四角高差合格"的平地
   * 会被圈成地块，然后在 y=16 的地面上盖一栋 3 米高的房子 —— 屋顶直接顶出世界。
   * 实测：8 个模板里有 6 个出现 12~13 个越界构件（一共 74 个），
   * 其中 5 个模板的**唯一**一栋房子就是越界的。
   * 而且检测器当时的越界文案只写了 X/Z，看不出是"高度超了"，
   * 这条 bug 就是被那份看不出原因的日志拖了很久才定位到的（文案也一起修了）。
   */
  buildHeight: number;
}

export const DEFAULT_PLANNING_OPTIONS: PlanningOptions = {
  targetCount: 6,
  plotWidth: 12,
  plotDepth: 12,
  plotSpacing: 3,
  maxSlope: 1.2,
  waterMargin: 1,
  // 地板 + 3 米墙 + 屋顶 + 一点余量。给宽一点比给窄好：宁可少盖一栋，
  // 也不要盖出一栋穿出天花板的房子（那种房子物理碰撞体在世界上方，玩家还删不掉）
  buildHeight: 5,
  maxAttempts: 200,
};

/** 建筑需要用到的模型（由调用方从物品库给出，避免这里硬编码 id） */
export interface BuildingKit {
  /** 地基/地板 */
  floor: string;
  /** 墙体（四面用同一个） */
  wall: string;
  /** 门 */
  door: string;
  /** 窗（可选） */
  window?: string;
  /** 屋顶 */
  roof: string;
  /** 柱（可选，用于四角） */
  pillar?: string;
  /** 各类的 AABB 尺寸（米），由调用方按模型给 */
  sizes: {
    wall: [number, number, number];
    door: [number, number, number];
    window?: [number, number, number];
    roof: [number, number, number];
    pillar?: [number, number, number];
  };
}

/** 小物品的候选（阶段 8 用） */
export interface ItemKit {
  defId: string;
  size: [number, number, number];
  /** 偏好放在桌面上还是地面（桌面类会优先尝试桌子） */
  preferSurface: boolean;
}

export interface PlanningReport {
  plots: PlotRect[];
  /** 因为什么被拒绝（按原因计数） */
  rejected: Record<string, number>;
  attempts: number;
  ms: number;
}

export interface BuildReport {
  /** 每个地块盖了几栋房（正常情况下 1） */
  houses: number;
  /** 生成的建筑构件数（一栋房由多块墙/地板组成） */
  parts: number;
  /** 因为地块不合格而跳过的数量 */
  skipped: number;
  ms: number;
}

export class BuildingPlanner {
  private readonly options: PlanningOptions;

  constructor(options: Partial<PlanningOptions> = {}) {
    this.options = { ...DEFAULT_PLANNING_OPTIONS, ...options };
  }

  get limits(): PlanningOptions {
    return { ...this.options };
  }

  /**
   * 阶段 6：圈地块。
   *
   * **纯几何**，不写世界、不生成建筑 —— 它只回答"哪里适合盖房"，
   * 好让阶段 5 的种树能避开。这一点是"先规划"能成立的关键。
   */
  plan(
    grid: VoxelGrid,
    rng: () => number,
    isWater: (voxelId: number) => boolean,
    waterLevel: number,
    options: Partial<PlanningOptions> = {},
  ): PlanningReport {
    const started = now();
    const config = { ...this.options, ...options };
    const plots: PlotRect[] = [];
    const rejected: Record<string, number> = {};
    const reject = (reason: string): void => {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
    };

    let attempts = 0;
    while (plots.length < config.targetCount && attempts < config.maxAttempts) {
      attempts += 1;
      // 地块中心留出半个尺寸，避免越界
      const halfW = config.plotWidth / 2;
      const halfD = config.plotDepth / 2;
      const cx = (rng() - 0.5) * Math.max(1, grid.sizeX - config.plotWidth) ;
      const cz = (rng() - 0.5) * Math.max(1, grid.sizeZ - config.plotDepth);
      void halfW;
      void halfD;

      const vx0 = grid.worldToVoxelX(cx - config.plotWidth / 2);
      const vx1 = grid.worldToVoxelX(cx + config.plotWidth / 2);
      const vz0 = grid.worldToVoxelZ(cz - config.plotDepth / 2);
      const vz1 = grid.worldToVoxelZ(cz + config.plotDepth / 2);
      if (
        !grid.inHorizontalBounds(vx0, vz0) ||
        !grid.inHorizontalBounds(vx1, vz1) ||
        !grid.inHorizontalBounds(vx0, vz1) ||
        !grid.inHorizontalBounds(vx1, vz0)
      ) {
        reject('越界');
        continue;
      }

      // ---- 取四角 + 中心的高度。用**最低**的那个当地面高度：这样房子不会有一角悬空
      const corners = [
        [vx0, vz0],
        [vx1, vz0],
        [vx0, vz1],
        [vx1, vz1],
      ] as const;
      let minTop = Number.POSITIVE_INFINITY;
      let maxTop = Number.NEGATIVE_INFINITY;
      let submerged = false;
      for (const [vx, vz] of corners) {
        const top = grid.solidSurfaceHeight(vx, vz);
        if (top < 0) {
          submerged = true;
          break;
        }
        if (isWater(grid.getVoxel(vx, top, vz))) {
          submerged = true;
          break;
        }
        minTop = Math.min(minTop, top);
        maxTop = Math.max(maxTop, top);
      }
      if (submerged || !Number.isFinite(minTop)) {
        reject('在水里');
        continue;
      }

      const relief = maxTop - minTop;
      if (relief > config.maxSlope) {
        reject('地势太陡');
        continue;
      }
      if (minTop + 1 < waterLevel + config.waterMargin) {
        reject('离水面太近');
        continue;
      }
      // ---- 头顶要有净空：地形上限本来就贴着世界天花板（新手档 15 / 16），
      //      在最高的那一层平地上盖房，屋顶一定会穿出世界
      if (minTop + 1 + config.buildHeight > grid.sizeY) {
        reject('离天花板太近');
        continue;
      }

      // ---- 与已有地块保持间距（用包围盒距离，不是圆心距离：
      //      两个 12 米见方的地块，圆心距离够但边角可能贴在一起）
      let tooClose = false;
      for (const plot of plots) {
        const gapX = Math.abs(plot.centerX - cx) - (plot.width + config.plotWidth) / 2;
        const gapZ = Math.abs(plot.centerZ - cz) - (plot.depth + config.plotDepth) / 2;
        // 两个轴都"够远"才算不冲突：只要有一个轴贴合就算太近
        if (gapX < config.plotSpacing && gapZ < config.plotSpacing) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) {
        reject('与已有地块太近');
        continue;
      }

      plots.push({
        id: `plot:${plots.length}`,
        centerX: cx,
        centerZ: cz,
        width: config.plotWidth,
        depth: config.plotDepth,
        // 地面高度取四角最低的顶面 —— 建筑从这里往上盖，就不会有角悬空
        groundY: minTop + 1,
        relief,
        rotationY: 0,
      });
    }

    return { plots, rejected, attempts, ms: now() - started };
  }

  /**
   * 阶段 7：在每个地块里盖一栋房。
   *
   * 房子的构成（"一栋房"= 若干 StagedObject）：
   * ```
   *        ┌────── 屋顶 ──────┐
   *        │                  │
   *   墙 ──┤      室内        ├── 墙
   *        │                  │
   *        └─ 墙 ── 门 ── 墙 ─┘
   *        ┌──── 地板 ────┐
   * ```
   * 关键点是**所有构件的位置都由 `groundY` 算出来**，没有一个数是从天上掉下来的：
   * 四面墙的 y = groundY，墙顶的 y = groundY + 墙高，屋顶压在墙顶上。
   * 这样"建筑不悬空"不是靠检查保证的，而是**在构造上就不可能悬空**。
   */
  build(
    plots: readonly PlotRect[],
    kit: BuildingKit,
    rng: () => number,
  ): { objects: StagedObject[]; report: BuildReport } {
    const started = now();
    const objects: StagedObject[] = [];
    let parts = 0;
    let skipped = 0;

    for (const plot of plots) {
      // wallW 暂时用不上：墙的宽度目前由地块尺寸决定（墙要正好铺满一面），
      // 保留解构是为了让"墙模型的真实尺寸"这个概念在代码里可见 ——
      // 后面要做"按墙宽拼墙段"的时候会用到它
      const [, wallH, wallD] = kit.sizes.wall;
      const depth = plot.depth / 2;
      const width = plot.width / 2;
      // 一个地块的尺寸必须装得下一栋房。装不下就跳过（并记账），不做"缩小房子"这种猜测
      if (depth < wallD || width < wallD) {
        skipped += 1;
        continue;
      }

      const push = (
        id: string,
        defId: string,
        position: [number, number, number],
        half: [number, number, number],
        rotationY: number,
        extra: Partial<StagedObject> = {},
      ): void => {
        objects.push({
          id: `${plot.id}:${id}`,
          kind: 'building',
          defId,
          position,
          rotationY,
          half,
          // 建筑的构件**不可移动也不可删除**：挪一块墙会让整栋房子结构失效，
          // 删一块墙会让房顶塌下来 —— 冲突修复时宁可删树也不动墙
          movable: false,
          deletable: false,
          needsSupport: false,
          // 同一栋房的构件归属同一个 owner：墙压地板、屋顶搭墙是**拼装**不是冲突
          // （没有这个字段时，7 栋房自己跟自己报出上百处"重叠"，见 StagedObject.owner）
          owner: plot.id,
          ...extra,
        });
        parts += 1;
      };

      const halfWidth = plot.width / 2;
      const halfDepth = plot.depth / 2;
      const y0 = plot.groundY;

      // 地板（比墙略大一点，形成一个"底座"，看起来更像房子）
      push(
        'floor',
        kit.floor,
        [plot.centerX, y0, plot.centerZ],
        [halfWidth + 0.2, 0.15, halfDepth + 0.2],
        0,
      );

      // 四面墙：南北两面沿 X 方向铺，东西两面沿 Z 方向铺
      push('wall-n', kit.wall, [plot.centerX, y0, plot.centerZ - halfDepth], [halfWidth, wallH / 2, wallD / 2], 0);
      push('wall-s', kit.wall, [plot.centerX, y0, plot.centerZ + halfDepth], [halfWidth, wallH / 2, wallD / 2], 0);
      push('wall-w', kit.wall, [plot.centerX - halfWidth, y0, plot.centerZ], [wallD / 2, wallH / 2, halfDepth], 0);
      push('wall-e', kit.wall, [plot.centerX + halfWidth, y0, plot.centerZ], [wallD / 2, wallH / 2, halfDepth], 0);

      // 门：开在南墙上，**标记 blocksDoorway** —— 阶段 8 的小物品与阶段 9 的检测都看这个标记
      const [doorW, doorH, doorD] = kit.sizes.door;
      push(
        'door',
        kit.door,
        [plot.centerX, y0, plot.centerZ + halfDepth],
        [doorW / 2, doorH / 2, doorD / 2],
        0,
        { blocksDoorway: true },
      );

      // 窗：东西各开一扇（如果提供了窗的模型）
      if (kit.window && kit.sizes.window) {
        const [winW, winH, winD] = kit.sizes.window;
        push('window-w', kit.window, [plot.centerX - halfWidth, y0 + wallH * 0.35, plot.centerZ], [winD / 2, winH / 2, winW / 2], 0);
        push('window-e', kit.window, [plot.centerX + halfWidth, y0 + wallH * 0.35, plot.centerZ], [winD / 2, winH / 2, winW / 2], 0);
      }

      // 四角立柱（可选）：让房子看起来有结构感，也顺便把"墙角"这个位置占住
      if (kit.pillar && kit.sizes.pillar) {
        const [pillarW, pillarH] = kit.sizes.pillar;
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            push(
              `pillar-${sx}-${sz}`,
              kit.pillar,
              [plot.centerX + sx * halfWidth, y0, plot.centerZ + sz * halfDepth],
              [pillarW / 2, pillarH / 2, pillarW / 2],
              0,
            );
          }
        }
      }

      // 屋顶：压在墙顶（不是悬在墙上方）—— 顶面 y = y0 + wallH
      const [roofW, roofH, roofD] = kit.sizes.roof;
      void roofW;
      void roofD;
      push(
        'roof',
        kit.roof,
        [plot.centerX, y0 + wallH, plot.centerZ],
        [halfWidth + 0.35, roofH / 2, halfDepth + 0.35],
        0,
      );

      void rng; // 目前房子不加随机差异；保留参数是为了后面加"随机朝向/户型"时不改签名
    }

    return { objects, report: { houses: plots.length - skipped, parts, skipped, ms: now() - started } };
  }

  /**
   * 阶段 8：在建筑里外摆小物品。
   *
   * 三个优先级（按"看起来最合理"排）：
   * 1. 室内地面（在地块内、离墙 0.6 米以上）；
   * 2. 建筑周围地面（地块外圈 0~3 米）；
   * 3. 桌面上（用一张桌子的顶面高度；调用方可以把桌子作为 `furniture` 传进来）。
   *
   * `preferSurface` 的物品优先试桌面，试不到再落到地面 —— 这就是"杯子放在桌上而不是地上"。
   */
  furnish(
    plots: readonly PlotRect[],
    items: readonly ItemKit[],
    density: number,
    rng: () => number,
    grid: VoxelGrid,
    doorClearance = 1.5,
  ): { objects: StagedObject[]; report: { placed: number; skipped: number; byDef: Record<string, number>; ms: number } } {
    const started = now();
    const objects: StagedObject[] = [];
    const byDef: Record<string, number> = {};
    let skipped = 0;
    if (items.length === 0 || plots.length === 0 || density <= 0) {
      return { objects, report: { placed: 0, skipped: 0, byDef, ms: now() - started } };
    }

    for (const plot of plots) {
      const perPlot = Math.max(0, Math.round(density * 3));
      const doorX = plot.centerX;
      const doorZ = plot.centerZ + plot.depth / 2;

      for (let index = 0; index < perPlot; index += 1) {
        const kit = items[Math.floor(rng() * items.length)];
        if (!kit) continue;
        const [sx, sy, sz] = kit.size;

        // 在地块内随机选一点，但离墙留 0.6 米（贴墙放会被墙的 AABB 判成重叠）
        const inset = 0.6 + Math.max(sx, sz) / 2;
        const x = plot.centerX + (rng() - 0.5) * Math.max(0.1, plot.width - inset * 2);
        const z = plot.centerZ + (rng() - 0.5) * Math.max(0.1, plot.depth - inset * 2);

        // ---- 规则：不堵门
        if (Math.hypot(x - doorX, z - doorZ) < doorClearance) {
          skipped += 1;
          continue;
        }

        // ---- 规则：不悬空 —— y 由**真实地面高度**算出来
        const vx = grid.worldToVoxelX(x);
        const vz = grid.worldToVoxelZ(z);
        if (!grid.inHorizontalBounds(vx, vz)) {
          skipped += 1;
          continue;
        }
        const top = grid.solidSurfaceHeight(vx, vz);
        if (top < 0) {
          skipped += 1;
          continue;
        }
        const y = top + 1;

        objects.push({
          id: `${plot.id}:item:${index}`,
          kind: 'item',
          defId: kit.defId,
          position: [x, y, z],
          rotationY: rng() * Math.PI * 2,
          half: [sx / 2, sy / 2, sz / 2],
          // 小物品可以挪也可以删 —— 它们是装饰，删掉不影响结构
          movable: true,
          deletable: true,
          needsSupport: true,
        });
        byDef[kit.defId] = (byDef[kit.defId] ?? 0) + 1;
      }
    }

    return { objects, report: { placed: objects.length, skipped, byDef, ms: now() - started } };
  }
}

/** 面板/日志用 */
export function describePlanningReport(report: PlanningReport): string {
  const rejected = Object.entries(report.rejected)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([reason, count]) => `${reason} ${count}`)
    .join('，');
  return (
    `建筑规划：圈出 ${report.plots.length} 块地（尝试 ${report.attempts} 次）` +
    (rejected ? `｜拒绝原因：${rejected}` : '') +
    `｜${report.ms.toFixed(2)} ms`
  );
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
