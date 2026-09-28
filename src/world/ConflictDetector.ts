/**
 * 冲突检测（M4 第 4 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么需要它（用户在问题 2 里的原话）
 * ────────────────────────────────────────────────────────────
 * "树被土盖、建筑冲突、物品堆叠错乱" —— 这三件事有一个共同点：
 * **它们都不是生成逻辑写错了，而是各阶段之间没有互相检查**。
 * M2.5 的做法是"种树时避开规划区"，那只解决了一种冲突（树 vs 建筑），
 * 而"树冠被地形盖住"（树 vs 地形）、"小物品悬空"（物品 vs 支撑面）根本没人管。
 *
 * 所以这里把冲突**穷举成 5 类**，每类都有明确的判据与可执行的修复方向：
 *
 * | 类型 | 判据 | 谁该被修 |
 * |---|---|---|
 * | `overlap` | 两个物体的 AABB 在三个轴上都实质相交 | 可移动的挪开，否则删 |
 * | `floating` | 物体底部离"支撑面"超过容差 | 往下移贴住，或删 |
 * | `outOfBounds` | 物体 AABB 超出世界水平范围 | 删（挪回来可能又撞别的） |
 * | `buried` | 树冠体积内的地形体素**被地形占用**（树被土盖） | 树往上挪或删 |
 * | `blocks-doorway` | 小物品挡在门的通行范围内 | 挪开 |
 *
 * ────────────────────────────────────────────────────────────
 * 一个刻意的设计：检测器**不碰世界、只读世界**
 * ────────────────────────────────────────────────────────────
 * `detect()` 只产出冲突记录，不修改任何东西；修复是 `ConflictResolver` 的事。
 * 这样"检测到了什么"与"怎么修"可以分别断言 —— 而"修完之后还有没有冲突"是第三次断言。
 * 如果检测与修复写在一起，就只能断言最终状态，中间过程出了问题根本看不出来。
 */

import type { VoxelGrid } from '../voxel/VoxelGrid';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 参与冲突检测的东西（生成阶段用，不依赖 BuildingInstance） */
export interface StagedObject {
  /** 稳定 id，冲突记录里引用它 */
  id: string;
  kind: 'nature' | 'building' | 'item';
  defId: string;
  /** 底面中心（世界坐标） */
  position: [number, number, number];
  rotationY: number;
  /** AABB 半尺寸（轴对齐，旋转后的外接盒子） */
  half: [number, number, number];
  /** 能不能被挪走（树能挪，地基不能） */
  movable: boolean;
  /** 能不能被删（装饰能删，承重结构不该删） */
  deletable: boolean;
  /** 是否必须有支撑面（小物品为 true；树与地基不需要，它们自己扎在地上） */
  needsSupport: boolean;
  /** 挡住门的通行范围（门与本类物品的距离判定用） */
  blocksDoorway?: boolean;
  /** 树冠半径（`kind === 'nature'` 且是树时填；用于"树冠被地形盖住"的检测） */
  crownRadius?: number;
  /** 树冠高度（从底部算起） */
  crownHeight?: number;
  /**
   * 所属「构建单元」的 id，例如一栋房子的所有构件都是 `house:3`。
   *
   * ── 为什么必须有这个字段 ──
   * 一栋房子是**拼**出来的：墙压在地板上、屋顶搭在墙上、柱子嵌在墙角。
   * 这些相交是设计本身，不是冲突。第一版没有这个字段，
   * 于是 7 栋房（91 个构件）自己跟自己报出上百处"重叠"，
   * 修复器反复挪它们又挪不动，日志里留下"189 处未解决"——
   * **看起来像生成失败了，其实是检测口径错了**。
   * 一个错误的检测器比没有检测器更糟：它会让人去"修"本来正确的东西。
   *
   * 留空表示"独立物体"，与任何东西相交都算冲突。
   */
  owner?: string;
}

export type ConflictType = 'overlap' | 'floating' | 'outOfBounds' | 'buried' | 'blocks-doorway';

export const CONFLICT_TYPE_LABELS: Record<ConflictType, string> = {
  overlap: '互相重叠',
  floating: '悬空',
  outOfBounds: '越出世界范围',
  buried: '被地形盖住',
  'blocks-doorway': '挡在门口',
};

export interface ConflictRecord {
  id: string;
  type: ConflictType;
  /** 涉及的物体 id（overlap 是两个，其余是一个） */
  objects: string[];
  /** 冲突大致位置（记录/可视化用） */
  position: [number, number, number];
  /** 中文说明（日志直接用） */
  detail: string;
  /** 严重程度：越高越该优先处理（排序用，不是物理量） */
  severity: number;
  resolution: 'moved' | 'deleted' | 'adjusted' | 'unresolved';
}

export interface DetectOptions {
  /**
   * 重叠判定的容差（米）：三个轴都要插进去超过这个值才算真重叠。
   *
   * 默认 0.12 —— 这个数不是随手定的：地图里的建筑是**用零件拼**的，
   * 屋顶压在柱头上会下沉约 0.6 米，墙角两根柱会咬合 0.3 米。
   * 阈值定成 0 会把所有这些**刻意的榫接**都报成冲突，检查就会永远红着（M3 已经踩过这个坑）。
   */
  overlapTolerance?: number;
  /** 悬空判定的容差（米）：底面离支撑面超过它就判悬空 */
  floatTolerance?: number;
  /** 小物品不堵门：门前方多大范围内不许放东西（米） */
  doorwayClearance?: number;
  /** 世界边界内缩（米）：物体 AABB 超出这个内缩范围就判越界 */
  boundsMargin?: number;
}

export const DEFAULT_DETECT_OPTIONS: Required<DetectOptions> = {
  overlapTolerance: 0.12,
  floatTolerance: 0.25,
  doorwayClearance: 1.2,
  boundsMargin: 0.5,
};

export interface DetectReport {
  conflicts: ConflictRecord[];
  /** 各类冲突的数量 */
  byType: Record<ConflictType, number>;
  /** 检测了多少物体、做了多少次两两比较 */
  scanned: number;
  comparisons: number;
  /** 因为属于同一个构建单元（同一栋房）而被放过的相交对数 */
  sameOwnerSkipped: number;
  ms: number;
}

/** 检测器的输入 */
export interface DetectInput {
  objects: readonly StagedObject[];
  grid: VoxelGrid;
  /** 给树/物品查"脚下地形顶面高度"；树与地基不需要 */
  options?: DetectOptions;
}

export class ConflictDetector {
  private readonly options: Required<DetectOptions>;
  private lastReport: DetectReport | null = null;

  constructor(options: Partial<DetectOptions> = {}) {
    this.options = { ...DEFAULT_DETECT_OPTIONS, ...options };
  }

  get limits(): Required<DetectOptions> {
    return { ...this.options };
  }

  get lastResult(): DetectReport | null {
    return this.lastReport;
  }

  /**
   * 全量检测。
   *
   * **两两比较是 O(n²)**：500 个物体是 12.5 万次 AABB 比较 —— 纯数值计算，约 1~2 毫秒，
   * 可以接受。真正让它变慢的是"每个物体都去读体素网格"（`solidSurfaceHeight` 要扫一整列），
   * 所以地形相关的查询**按 (x,z) 缓存**：同一列只查一次。
   */
  detect(input: DetectInput): DetectReport {
    const started = now();
    const options = { ...this.options, ...(input.options ?? {}) };
    const grid = input.grid;
    const conflicts: ConflictRecord[] = [];
    const byType: Record<ConflictType, number> = {
      overlap: 0,
      floating: 0,
      outOfBounds: 0,
      buried: 0,
      'blocks-doorway': 0,
    };

    // 地形列的缓存：同类物体常常落在同一列附近，缓存能把体素查询次数降一个量级
    const surfaceCache = new Map<string, number>();
    const surfaceAt = (x: number, z: number): number => {
      const vx = grid.worldToVoxelX(x);
      const vz = grid.worldToVoxelZ(z);
      if (!grid.inHorizontalBounds(vx, vz)) return Number.NaN;
      const key = `${vx},${vz}`;
      const cached = surfaceCache.get(key);
      if (cached !== undefined) return cached;
      const top = grid.solidSurfaceHeight(vx, vz);
      const value = top < 0 ? Number.NaN : top + 1;
      surfaceCache.set(key, value);
      return value;
    };

    // ---- 单物体检查：越界 / 悬空 / 被地形盖住 / 挡门
    const doorways = input.objects.filter((object) => object.blocksDoorway === true);

    for (const object of input.objects) {
      const [x, y, z] = object.position;
      const [hx, hy, hz] = object.half;

      // 1) 越界
      const limitX = grid.halfX - options.boundsMargin;
      const limitZ = grid.halfZ - options.boundsMargin;
      if (
        x - hx < -limitX || x + hx > limitX ||
        z - hz < -limitZ || z + hz > limitZ ||
        y < -0.01 || y + hy * 2 > grid.sizeY + 0.01
      ) {
        byType.outOfBounds += 1;
        // 文案必须点出**是哪个轴**越界。第一版只写了 X/Z，于是"屋顶顶出天花板"
        // 这种竖直越界显示成一行 X/Z 完全正常的文字（"x -0.3~12.1（界内 ±23.5）"），
        // 看日志的人会以为检测器坏了 —— 一条读不出原因的日志比没有日志更费时间。
        const overflowX = x - hx < -limitX || x + hx > limitX;
        const overflowZ = z - hz < -limitZ || z + hz > limitZ;
        const overflowY = y < -0.01 || y + hy * 2 > grid.sizeY + 0.01;
        const parts: string[] = [];
        if (overflowX) parts.push(`x ${(x - hx).toFixed(1)}~${(x + hx).toFixed(1)}（界内 ±${limitX.toFixed(1)}）`);
        if (overflowY) parts.push(`y ${y.toFixed(1)}~${(y + hy * 2).toFixed(1)}（天花板 ${grid.sizeY}）`);
        if (overflowZ) parts.push(`z ${(z - hz).toFixed(1)}~${(z + hz).toFixed(1)}（界内 ±${limitZ.toFixed(1)}）`);
        conflicts.push({
          id: `oob:${object.id}`,
          type: 'outOfBounds',
          objects: [object.id],
          position: [x, y, z],
          detail: `${object.defId} 超出世界范围（${[overflowX ? 'X' : '', overflowY ? 'Y' : '', overflowZ ? 'Z' : ''].filter(Boolean).join('/')} 轴）：${parts.join('，')}`,
          severity: 100,
          resolution: 'unresolved',
        });
        continue; // 越界的东西不用再判悬空（位置本身已经没意义）
      }

      // 2) 悬空（需要支撑的东西才判）
      if (object.needsSupport) {
        const surface = surfaceAt(x, z);
        if (Number.isFinite(surface)) {
          const gap = y - surface;
          if (gap > options.floatTolerance) {
            byType.floating += 1;
            conflicts.push({
              id: `float:${object.id}`,
              type: 'floating',
              objects: [object.id],
              position: [x, y, z],
              detail: `${object.defId} 悬空 ${gap.toFixed(2)} 米（地面在 ${surface.toFixed(2)}）`,
              severity: 60,
              resolution: 'unresolved',
            });
          }
        } else if (y > 0.5) {
          // 脚下没有地形（悬在水面/深渊上方）也算悬空
          byType.floating += 1;
          conflicts.push({
            id: `float:${object.id}`,
            type: 'floating',
            objects: [object.id],
            position: [x, y, z],
            detail: `${object.defId} 底下没有地形（在 y=${y.toFixed(2)} 处悬空）`,
            severity: 70,
            resolution: 'unresolved',
          });
        }
      }

      // 3) 被地形盖住（树冠与地形体素重叠）—— 这就是用户说的"树被土盖"
      if (object.kind === 'nature' && object.crownRadius !== undefined && object.crownRadius > 0) {
        const crownHeight = object.crownHeight ?? hy * 2;
        const buried = this.crownBuried(grid, object, crownHeight);
        if (buried > 0) {
          byType.buried += 1;
          conflicts.push({
            id: `buried:${object.id}`,
            type: 'buried',
            objects: [object.id],
            position: [x, y, z],
            detail:
              `${object.defId} 的树冠有 ${buried} 格被地形占用（树被土盖住了）` +
              `：树冠半径 ${object.crownRadius.toFixed(1)} 米、高 ${crownHeight.toFixed(1)} 米`,
            severity: 80,
            resolution: 'unresolved',
          });
        }
      }

      // 4) 挡门（小物品落在门洞的通行范围内）
      if (object.kind === 'item' || object.kind === 'nature') {
        for (const door of doorways) {
          const dx = Math.abs(x - door.position[0]);
          const dz = Math.abs(z - door.position[2]);
          const dy = Math.abs(y - door.position[1]);
          // 只在门的**通行高度**内算挡门：门口上方的吊灯不算挡路
          const doorHeight = door.half[1] * 2;
          if (
            dx < door.half[0] + options.doorwayClearance &&
            dz < door.half[2] + options.doorwayClearance &&
            dy < doorHeight
          ) {
            byType['blocks-doorway'] += 1;
            conflicts.push({
              id: `door:${object.id}`,
              type: 'blocks-doorway',
              objects: [object.id, door.id],
              position: [x, y, z],
              detail:
                `${object.defId} 挡在 ${door.defId} 的通行范围内` +
                `（水平距离 ${Math.hypot(dx, dz).toFixed(2)} 米，要求 ${(options.doorwayClearance).toFixed(1)} 米以上）`,
              severity: 50,
              resolution: 'unresolved',
            });
            break; // 一个物品挡一扇门就够了，不必为每扇门都记一条
          }
        }
      }
    }

    // ---- 两两比较：重叠
    //
    // 先按 X 排序，再只在"X 区间可能相交"的候选里两两比 ——
    // 这是 sweep-and-prune 的简化版。500 个物体下把 12.5 万次比较降到几千次，
    // 而对结果**没有任何影响**（被跳过的配对本来就 x 轴不相交）。
    const sorted = [...input.objects].sort((a, b) => a.position[0] - a.half[0] - (b.position[0] - b.half[0]));
    let comparisons = 0;
    let sameOwnerSkipped = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      const a = sorted[i]!;
      const aMaxX = a.position[0] + a.half[0];
      for (let j = i + 1; j < sorted.length; j += 1) {
        const b = sorted[j]!;
        // 排序后一旦 b 的左边界超过 a 的右边界，后面的都更远，可以停
        if (b.position[0] - b.half[0] - options.overlapTolerance > aMaxX) break;
        comparisons += 1;
        // 同一个构建单元内部的相交是"拼装"，不是冲突（见 StagedObject.owner 的注释）
        if (a.owner !== undefined && a.owner === b.owner) {
          sameOwnerSkipped += 1;
          continue;
        }
        const depth = overlapExtent(a, b);
        if (depth.x > options.overlapTolerance && depth.y > options.overlapTolerance && depth.z > options.overlapTolerance) {
          byType.overlap += 1;
          conflicts.push({
            id: `overlap:${a.id}:${b.id}`,
            type: 'overlap',
            objects: [a.id, b.id],
            position: [
              (Math.max(a.position[0] - a.half[0], b.position[0] - b.half[0]) +
                Math.min(a.position[0] + a.half[0], b.position[0] + b.half[0])) / 2,
              (Math.max(a.position[1], b.position[1]) + Math.min(a.position[1] + a.half[1] * 2, b.position[1] + b.half[1] * 2)) / 2,
              (Math.max(a.position[2] - a.half[2], b.position[2] - b.half[2]) +
                Math.min(a.position[2] + a.half[2], b.position[2] + b.half[2])) / 2,
            ],
            detail:
              `${a.defId} 与 ${b.defId} 在三个轴上都相交 ` +
              `(${depth.x.toFixed(2)}, ${depth.y.toFixed(2)}, ${depth.z.toFixed(2)}) 米`,
            // 越"胖"的重叠越该先处理：两个大建筑重叠比两个小摆件重叠严重得多
            severity: 40 + Math.min(40, Math.round(depth.x * depth.y * depth.z * 4)),
            resolution: 'unresolved',
          });
        }
      }
    }

    const report: DetectReport = {
      conflicts,
      byType,
      scanned: input.objects.length,
      comparisons,
      /**
       * 同一个构建单元内部被**主动放过**的相交对数。
       *
       * 如实报出来而不是悄悄跳过：这个数字大说明"拼装很多"（正常），
       * 但如果它突然变小、同时 overlap 变大，就说明 owner 没被正确传下去 ——
       * 这正是我踩过的坑（构件没有 owner，于是房子自己跟自己冲突）。
       */
      sameOwnerSkipped,
      ms: now() - started,
    };
    this.lastReport = report;
    return report;
  }

  /**
   * 树冠被地形占用的格数。
   *
   * 算法：把树冠当成一个圆柱，在它的 XZ 投影范围内按 1 格采样，
   * 逐列检查"树冠高度范围内有没有实心地形体素"。有一格就算被盖住。
   *
   * 为什么是"有一格就算"而不是"超过多少比例才判"：树冠被土盖住哪怕一小块，
   * 玩家看到的就是"树从土里长出来一半"，很难看。而修复成本很低（往上挪 1~3 格），
   * 所以判得严格一点更划算。
   */
  private crownBuried(grid: VoxelGrid, object: StagedObject, crownHeight: number): number {
    const radius = object.crownRadius ?? 0;
    const [x, y, z] = object.position;
    const steps = Math.max(2, Math.ceil(radius * 2));
    let buried = 0;
    // 树冠一般在上半部分，所以从 40% 高度开始扫（树干那一段与地形重叠是正常的）
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
          if (grid.getVoxel(vx, vy, vz) !== 0) {
            buried += 1;
            break; // 这一列已经算被盖住了，不必再往上数
          }
        }
      }
    }
    return buried;
  }
}

/** 两个物体的 AABB 在三个轴上的相交深度（负值表示该轴不相交） */
export function overlapExtent(a: StagedObject, b: StagedObject): Vec3 {
  const ax0 = a.position[0] - a.half[0];
  const ax1 = a.position[0] + a.half[0];
  const ay0 = a.position[1];
  const ay1 = a.position[1] + a.half[1] * 2;
  const az0 = a.position[2] - a.half[2];
  const az1 = a.position[2] + a.half[2];

  const bx0 = b.position[0] - b.half[0];
  const bx1 = b.position[0] + b.half[0];
  const by0 = b.position[1];
  const by1 = b.position[1] + b.half[1] * 2;
  const bz0 = b.position[2] - b.half[2];
  const bz1 = b.position[2] + b.half[2];

  return {
    x: Math.min(ax1, bx1) - Math.max(ax0, bx0),
    y: Math.min(ay1, by1) - Math.max(ay0, by0),
    z: Math.min(az1, bz1) - Math.max(az0, bz0),
  };
}

/** 面板/日志用：一行中文摘要 */
export function describeDetectReport(report: DetectReport): string {
  const parts = Object.entries(report.byType)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${CONFLICT_TYPE_LABELS[type as ConflictType]} ${count}`);
  return (
    `冲突检测：扫了 ${report.scanned} 个物体 / ${report.comparisons} 次两两比较｜` +
    (parts.length === 0 ? '没有冲突' : parts.join('，')) +
    `｜${report.ms.toFixed(2)} ms`
  );
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
