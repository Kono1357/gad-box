/**
 * 冲突修复（M4 第 4 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 修复策略：**先挪、再调、最后删**，而且顺序有理由
 * ────────────────────────────────────────────────────────────
 * 对一个冲突，可选的修复手段按"信息损失从小到大"排序：
 *
 * 1. **moved**（挪开）：信息零损失 —— 物体还在，只是换了个位置。首选。
 * 2. **adjusted**（调整）：改了尺寸/高度（例如树往上抬、物品贴地）。有一点损失但很小。
 * 3. **deleted**（删除）：信息全丢。**只在没有别的办法时用**。
 *
 * 每类冲突的实际做法：
 *
 * | 冲突 | 首选做法 | 退路 |
 * |---|---|---|
 * | `overlap` | 保留"更重要"的那个，把可移动的挪到不重叠的位置（螺旋搜索） | 挪不动（static/不可移动）就删掉可删的那个；两个都不能动则记 `unresolved` |
 * | `floating` | 直接往下移到支撑面上（`adjusted`） | 挪下去会撞别的东西时改成删 |
 * | `buried` | 把树**往上抬**到树冠露出地面（`adjusted`） | 抬不动（超过世界上限）就删树 |
 * | `outOfBounds` | 不修，直接删（挪回来很可能又撞别的） | — |
 * | `blocks-doorway` | 把物品沿门法线方向挪开 1.5 米（`moved`） | 挪不开就删 |
 *
 * ────────────────────────────────────────────────────────────
 * 为什么"往上抬"是修 `buried` 的正确做法
 * ────────────────────────────────────────────────────────────
 * 树被土盖住有两种成因：① 树先种、地形后变（挖出来的土堆到树冠上）；
 * ② 生成顺序里树叶被写进了地形。无论哪种，**树的位置是"选"出来的、地形是"算"出来的**，
 * 所以动树比动地形代价小得多（动地形要重算高度图与网格）。抬到露出地面为止即可 ——
 * 抬升量由"树冠最高的那格被地形占到哪里"算出来，不是拍一个数字。
 *
 * ────────────────────────────────────────────────────────────
 * 收尾必做：**重跑一次检测**
 * ────────────────────────────────────────────────────────────
 * 修复动作之间会互相影响（挪开 A 可能撞上 B），所以修完之后必须重新检测一遍，
 * 把"新产生的冲突"标成 `unresolved` 并计入日志 —— **不能假装一次就修干净了**。
 * 这也是 `resolve()` 返回 `remaining` 的原因。
 */

import type { VoxelGrid } from '../voxel/VoxelGrid';
import {
  ConflictDetector,
  CONFLICT_TYPE_LABELS,
  type ConflictRecord,
  type ConflictType,
  type DetectOptions,
  type StagedObject,
} from './ConflictDetector';

export interface ResolveOptions extends DetectOptions {
  /** 每个冲突最多尝试几个候选位置（螺旋搜索） */
  maxMoveAttempts?: number;
  /** 挪开的搜索半径（米） */
  moveSearchRadius?: number;
  /** 树被埋时最多往上抬几米（超过就删树） */
  maxTreeLift?: number;
  /** 最多修几轮（每轮修完重跑检测） */
  maxRounds?: number;
}

export const DEFAULT_RESOLVE_OPTIONS: Required<ResolveOptions> = {
  overlapTolerance: 0.12,
  floatTolerance: 0.25,
  doorwayClearance: 1.2,
  boundsMargin: 0.5,
  maxMoveAttempts: 12,
  moveSearchRadius: 4,
  maxTreeLift: 6,
  maxRounds: 3,
};

export interface ResolveReport {
  /** 修掉的冲突数（按类型） */
  resolvedByType: Record<ConflictType, number>;
  /** 没能修掉的冲突（修完重测仍然存在的） */
  remaining: ConflictRecord[];
  /** 第一轮检测到的冲突总数 */
  detected: number;
  /** 参与修复的物体数变化 */
  objectsBefore: number;
  objectsAfter: number;
  /** 一共跑了几轮 */
  rounds: number;
  /** 每轮的中文说明（写进生成日志） */
  roundNotes: string[];
  ms: number;
}

/**
 * 修复器。
 *
 * **它会就地修改 `objects` 数组**（挪位置、改高度、删除元素）——
 * 这一点与"检测器只读"刻意相反：修复的本质就是改世界。
 * 但每一处改动都记进报告，所以"改了什么"是可追溯的。
 */
export class ConflictResolver {
  private readonly options: Required<ResolveOptions>;
  private readonly detector: ConflictDetector;

  constructor(options: Partial<ResolveOptions> = {}) {
    this.options = { ...DEFAULT_RESOLVE_OPTIONS, ...options };
    this.detector = new ConflictDetector(this.options);
  }

  get limits(): Required<ResolveOptions> {
    return { ...this.options };
  }

  /**
   * 修复一轮。
   *
   * @param objects **会被就地修改**（挪位置 / 改高度 / 删除元素）
   * @param grid 地形（用于查支撑面与树冠占用）
   * @param seed 随机数种子（挪开方向要可复现：同种子必须挪到同一个位置）
   */
  resolve(objects: StagedObject[], grid: VoxelGrid, seed: number): ResolveReport {
    const started = now();
    const options = this.options;
    const resolvedByType: Record<ConflictType, number> = {
      overlap: 0,
      floating: 0,
      outOfBounds: 0,
      buried: 0,
      'blocks-doorway': 0,
    };
    const roundNotes: string[] = [];
    const objectsBefore = objects.length;
    const detector = this.detector;

    let round = 0;
    let detected = 0;
    let remaining: ConflictRecord[] = [];
    let rng = mulberry32Local(seed);

    while (round < options.maxRounds) {
      round += 1;
      const report = detector.detect({ objects, grid, options });
      if (round === 1) detected = report.conflicts.length;

      if (report.conflicts.length === 0) {
        remaining = [];
        roundNotes.push(`第 ${round} 轮：没有冲突`);
        break;
      }

      // 严重的先修：越界的先删、被埋的先抬，重叠的最后挪（挪完可能又产生新重叠）
      const ordered = [...report.conflicts].sort((a, b) => b.severity - a.severity);
      let fixedThisRound = 0;

      for (const conflict of ordered) {
        // 冲突涉及的物体可能已经被上一条修掉了（删了/挪走了），要重新查一次
        const targets = conflict.objects
          .map((id) => objects.find((object) => object.id === id))
          .filter((object): object is StagedObject => object !== undefined);
        if (targets.length === 0) continue;

        const outcome = this.resolveOne(conflict, targets, objects, grid, rng);
        if (outcome !== 'unresolved') {
          resolvedByType[conflict.type] += 1;
          conflict.resolution = outcome;
          fixedThisRound += 1;
        }
      }

      roundNotes.push(
        `第 ${round} 轮：发现 ${report.conflicts.length} 处冲突，修掉 ${fixedThisRound} 处`,
      );

      // 修完重测：修复动作之间会互相影响，不能假设一次就干净
      const recheck = detector.detect({ objects, grid, options });
      remaining = recheck.conflicts;
      if (remaining.length === 0) {
        roundNotes.push(`第 ${round} 轮复查：已经没有冲突`);
        break;
      }
      // 下一轮换一组随机数：如果第一轮的挪动策略走进了死胡同，换个方向再试
      rng = mulberry32Local(seed + round);
    }

    // 最后一轮没修干净的，标记为 unresolved（**如实报告，不藏**）
    for (const conflict of remaining) conflict.resolution = 'unresolved';
    if (remaining.length > 0) {
      const byType = new Map<ConflictType, number>();
      for (const conflict of remaining) byType.set(conflict.type, (byType.get(conflict.type) ?? 0) + 1);
      roundNotes.push(
        `剩余 ${remaining.length} 处未解决：` +
          [...byType.entries()].map(([type, count]) => `${CONFLICT_TYPE_LABELS[type]} ${count}`).join('，'),
      );
    }

    return {
      resolvedByType,
      remaining,
      detected,
      objectsBefore,
      objectsAfter: objects.length,
      rounds: round,
      roundNotes,
      ms: now() - started,
    };
  }

  // ------------------------------------------------------------------ 单条修复

  private resolveOne(
    conflict: ConflictRecord,
    targets: StagedObject[],
    objects: StagedObject[],
    grid: VoxelGrid,
    rng: () => number,
  ): ConflictRecord['resolution'] {
    switch (conflict.type) {
      case 'outOfBounds':
        // 越界的东西挪回来很可能又撞别的，而且它本来就不该被生成在那里 —— 直接删
        return this.deleteObjects(targets.filter((object) => object.deletable), objects);

      case 'buried':
        return this.liftBuried(targets[0]!, objects, grid);

      case 'floating':
        return this.dropToSupport(targets[0]!, objects, grid);

      case 'blocks-doorway':
        return this.moveAwayFromDoor(targets, objects, grid);

      case 'overlap':
        return this.separateOverlap(targets, objects, grid, rng);

      default:
        return 'unresolved';
    }
  }

  /**
   * 把被埋的树往上抬。
   *
   * 抬升量由**树冠最低的被占格**算出来，不是拍一个数：
   * 逐格往上找第一个"树冠完全没被地形占用"的位置，最多抬 `maxTreeLift` 米。
   */
  private liftBuried(tree: StagedObject, objects: StagedObject[], grid: VoxelGrid): ConflictRecord['resolution'] {
    const crownHeight = tree.crownHeight ?? tree.half[1] * 2;
    const radius = tree.crownRadius ?? 1.5;
    const originalY = tree.position[1];

    for (let lift = 0.5; lift <= this.options.maxTreeLift; lift += 0.5) {
      const candidateY = originalY + lift;
      if (candidateY + crownHeight > grid.sizeY) break; // 抬出世界了
      if (!this.crownBlocked(grid, tree.position[0], candidateY, tree.position[2], radius, crownHeight)) {
        tree.position = [tree.position[0], candidateY, tree.position[2]];
        return 'adjusted';
      }
    }
    // 抬不出去：删掉它。留在那里就是"树从土里长出来一半"，比没有更难看
    return this.deleteObjects(tree.deletable ? [tree] : [], objects);
  }

  /** 树冠在给定位置是否被地形占用 */
  private crownBlocked(grid: VoxelGrid, x: number, y: number, z: number, radius: number, crownHeight: number): boolean {
    const steps = Math.max(2, Math.ceil(radius * 2));
    const fromY = y + crownHeight * 0.4;
    const toY = y + crownHeight;
    for (let sx = 0; sx <= steps; sx += 1) {
      for (let sz = 0; sz <= steps; sz += 1) {
        const tx = x + (sx / steps - 0.5) * radius * 2;
        const tz = z + (sz / steps - 0.5) * radius * 2;
        if ((tx - x) ** 2 + (tz - z) ** 2 > radius * radius) continue;
        const vx = grid.worldToVoxelX(tx);
        const vz = grid.worldToVoxelZ(tz);
        if (!grid.inHorizontalBounds(vx, vz)) continue;
        const y0 = Math.max(0, Math.floor(fromY));
        const y1 = Math.min(grid.sizeY - 1, Math.ceil(toY));
        for (let vy = y0; vy <= y1; vy += 1) {
          if (grid.getVoxel(vx, vy, vz) !== 0) return true;
        }
      }
    }
    return false;
  }

  /** 悬空的东西往下移贴地（`adjusted`）；下方没有地形就删 */
  private dropToSupport(object: StagedObject, objects: StagedObject[], grid: VoxelGrid): ConflictRecord['resolution'] {
    const vx = grid.worldToVoxelX(object.position[0]);
    const vz = grid.worldToVoxelZ(object.position[2]);
    if (!grid.inHorizontalBounds(vx, vz)) {
      return this.deleteObjects(object.deletable ? [object] : [], objects);
    }
    const top = grid.solidSurfaceHeight(vx, vz);
    if (top < 0) {
      // 底下没有地形（悬在水面或深渊上）→ 没法贴地
      return this.deleteObjects(object.deletable ? [object] : [], objects);
    }
    const target = top + 1;
    // 守卫：只有"真的高于支撑面"才需要往下放。
    // 第一版我写成了 `if (target <= position)` —— 那是反的：位置高于目标时正好满足
    // 这个条件，于是**每一个悬空物体都会被判为"不用修"**，修复静默失效。
    // 这类"守卫写反"的 bug 不会报错，只会让功能看起来没生效，所以断言一定要验"修完之后的位置"。
    if (object.position[1] <= target + 1e-6) return 'unresolved';
    object.position = [object.position[0], target, object.position[2]];
    return 'adjusted';
  }

  /** 把挡门的物品沿"离开门"的方向挪开 */
  private moveAwayFromDoor(
    targets: StagedObject[],
    objects: StagedObject[],
    grid: VoxelGrid,
  ): ConflictRecord['resolution'] {
    const item = targets.find((object) => object.kind !== 'building') ?? targets[0]!;
    const door = targets.find((object) => object.blocksDoorway === true);
    if (!item.movable || !door) {
      return this.deleteObjects(item.deletable ? [item] : [], objects);
    }
    // 沿"物品 → 门"的反方向离开：这样是往空旷的一侧挪，而不是穿过门
    const dx = item.position[0] - door.position[0];
    const dz = item.position[2] - door.position[2];
    const length = Math.hypot(dx, dz);
    const nx = length > 1e-4 ? dx / length : 1;
    const nz = length > 1e-4 ? dz / length : 0;
    const distance = this.options.doorwayClearance + 0.8;

    const candidate: [number, number, number] = [
      item.position[0] + nx * distance,
      item.position[1],
      item.position[2] + nz * distance,
    ];
    if (!this.fits(candidate, item.half, objects, item.id)) {
      return this.deleteObjects(item.deletable ? [item] : [], objects);
    }
    // 挪开之后要重新贴地：门前的台面高度与新的位置未必一样
    const vx = grid.worldToVoxelX(candidate[0]);
    const vz = grid.worldToVoxelZ(candidate[2]);
    const top = grid.inHorizontalBounds(vx, vz) ? grid.solidSurfaceHeight(vx, vz) : -1;
    item.position = top >= 0 ? [candidate[0], Math.max(candidate[1], top + 1), candidate[2]] : candidate;
    return 'moved';
  }

  /**
   * 分开两个重叠的物体。
   *
   * 优先保留"更不可动"的那个（地基、承重结构优先于树与小物品），
   * 把另一个沿"最小分离轴"推开。推动方向加一点随机扰动，并且**用种子化的随机数** ——
   * 同一个种子必须挪到同一个位置，否则生成不可复现。
   */
  private separateOverlap(
    targets: StagedObject[],
    objects: StagedObject[],
    grid: VoxelGrid,
    rng: () => number,
  ): ConflictRecord['resolution'] {
    if (targets.length < 2) return 'unresolved';
    const [a, b] = targets as [StagedObject, StagedObject];

    // 重要度：建筑 > 自然 > 物品；同样重要度下"不可动的"优先保留
    const score = (object: StagedObject): number =>
      (object.kind === 'building' ? 100 : object.kind === 'nature' ? 50 : 10) + (object.movable ? 0 : 30);
    const keepFirst = score(a) >= score(b);
    const keeper = keepFirst ? a : b;
    const mover = keepFirst ? b : a;

    if (!mover.movable) {
      // 被推的那个动不了：看看保留的那个能不能动，都不能动就删可删的
      if (keeper.movable) return this.separateOverlap([mover, keeper], objects, grid, rng);
      return this.deleteObjects(targets.filter((object) => object.deletable), objects);
    }

    const attempts = this.options.maxMoveAttempts;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // 螺旋搜索：先在最小分离轴上推，再逐步加大角度
      const angle = (attempt / attempts) * Math.PI * 2 + rng() * 0.4;
      const radius = Math.min(
        this.options.moveSearchRadius,
        this.options.overlapTolerance + 0.3 + attempt * 0.35,
      );
      const candidate: [number, number, number] = [
        mover.position[0] + Math.cos(angle) * radius,
        mover.position[1],
        mover.position[2] + Math.sin(angle) * radius,
      ];
      if (!this.insideBounds(candidate, mover.half, grid)) continue;
      // 注意：这里**不能**忽略 keeper —— 它正是我们要躲开的那个。
      // 第一版我把 keeper.id 当"忽略项"传了进去，于是候选位置可以落在 keeper 上面，
      // 结果"挪开"之后两个物体还是重叠的，修复看起来"做了"却没解决问题。
      if (!this.fits(candidate, mover.half, objects, mover.id)) continue;

      // 挪到地面上（树与物品都要贴地）
      const vx = grid.worldToVoxelX(candidate[0]);
      const vz = grid.worldToVoxelZ(candidate[2]);
      const top = grid.inHorizontalBounds(vx, vz) ? grid.solidSurfaceHeight(vx, vz) : -1;
      if (mover.kind !== 'building' && top >= 0) candidate[1] = top + 1;

      mover.position = candidate;
      return 'moved';
    }

    // 挪不开：删掉可删的那个
    return this.deleteObjects(mover.deletable ? [mover] : keeper.deletable ? [keeper] : [], objects);
  }

  // ------------------------------------------------------------------ 工具

  /** 候选位置是否与世界范围内（AABB 完全在内） */
  private insideBounds(position: [number, number, number], half: [number, number, number], grid: VoxelGrid): boolean {
    const margin = this.options.boundsMargin;
    const limitX = grid.halfX - margin;
    const limitZ = grid.halfZ - margin;
    return (
      position[0] - half[0] >= -limitX &&
      position[0] + half[0] <= limitX &&
      position[2] - half[2] >= -limitZ &&
      position[2] + half[2] <= limitZ &&
      position[1] >= 0 &&
      position[1] + half[1] * 2 <= grid.sizeY
    );
  }

  /** 候选位置的 AABB 是否与别的物体冲突（忽略自己和另一个已知的物体） */
  private fits(
    position: [number, number, number],
    half: [number, number, number],
    objects: readonly StagedObject[],
    selfId: string,
    ignoreId?: string,
  ): boolean {
    const tolerance = this.options.overlapTolerance;
    for (const other of objects) {
      if (other.id === selfId) continue;
      if (ignoreId !== undefined && other.id === ignoreId) continue;
      const dx = Math.min(position[0] + half[0], other.position[0] + other.half[0]) - Math.max(position[0] - half[0], other.position[0] - other.half[0]);
      if (dx <= tolerance) continue;
      const dy = Math.min(position[1] + half[1] * 2, other.position[1] + other.half[1] * 2) - Math.max(position[1], other.position[1]);
      if (dy <= tolerance) continue;
      const dz = Math.min(position[2] + half[2], other.position[2] + other.half[2]) - Math.max(position[2] - half[2], other.position[2] - other.half[2]);
      if (dz <= tolerance) continue;
      return false;
    }
    return true;
  }

  private deleteObjects(list: readonly StagedObject[], objects: StagedObject[]): ConflictRecord['resolution'] {
    if (list.length === 0) return 'unresolved';
    for (const object of list) {
      const index = objects.findIndex((item) => item.id === object.id);
      if (index >= 0) objects.splice(index, 1);
    }
    return 'deleted';
  }
}

/** 面板/日志用：一行中文摘要 */
export function describeResolveReport(report: ResolveReport): string {
  const parts = Object.entries(report.resolvedByType)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${CONFLICT_TYPE_LABELS[type as ConflictType]} 修 ${count}`);
  return (
    `冲突修复：${report.rounds} 轮｜发现 ${report.detected} 处｜` +
    (parts.length === 0 ? '无需修复' : parts.join('，')) +
    `｜物体 ${report.objectsBefore} → ${report.objectsAfter}` +
    (report.remaining.length > 0 ? `｜⚠ 仍有 ${report.remaining.length} 处未解决` : '｜已清空') +
    `｜${report.ms.toFixed(2)} ms`
  );
}

/** 局部 PRNG（与 MapGenerators 用的同一套算法，保证同种子可复现） */
function mulberry32Local(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
