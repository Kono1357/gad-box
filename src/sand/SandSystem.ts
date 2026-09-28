/**
 * 沙土系统（M4 第二部分 · 第 3 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 与旧的 `src/physics/SandSystem.ts` 的关系
 * ────────────────────────────────────────────────────────────
 * 旧的落沙系统只有一条规则（下方空就掉、斜下方空就滑），安息角是**全局一个数**。
 * 这一版把"沙"变成**有状态的格子**：
 * - 每格记 **湿度**（0~1）、**稳定性**、以及由湿度算出的**安息角**；
 * - 于是"干沙堆得陡、湿沙能立住、饱和沙像泥流"是同一套规则在不同湿度下的自然结果，
 *   而不是三套特判；
 * - 沙会**吸水变湿**（与第 5 批的水交互）与**随时间干燥**；
 * - 沙崩有**连锁**：一格动 → 唤醒邻居 → 邻居可能连锁滑落（这就是"沙崩"）。
 *
 * 公开 API 刻意与旧版**保持同名**（`enabled` / `angleOfRepose` / `markActive` /
 * `markNeighborhood` / `markAllSand` / `step` / `clearActivity` / `lastStepChanges`），
 * 这样 `Engine` 里那些调用点一行都不用改 —— 换掉的是实现，不是接口。
 * （M0~M4.1 的断言用的是旧的那份文件，仍然原样通过。）
 *
 * ────────────────────────────────────────────────────────────
 * 内存：元数据按世界尺寸一次性分配
 * ────────────────────────────────────────────────────────────
 * 湿度与稳定性各一个 `Uint8Array(sizeX × sizeY × sizeZ)`：
 * 大档 192×32×192 = 118 万格 → 每个属性 1.18 MB，两个属性 2.4 MB。
 * 这个量级可以接受（比流体粒子池的 12 MB 小），换来的是"扫描时不用查表"。
 * 只在切换世界时重新分配。
 *
 * ────────────────────────────────────────────────────────────
 * 分帧与活跃区域
 * ────────────────────────────────────────────────────────────
 * 只有"活跃格子"会被处理（放置/编辑/水接触/滑动之后的邻居才会被标记）。
 * 一池静止的沙不花任何时间 —— 这条在断言里钉住（静止沙的一步应该 < 0.05 ms）。
 */

import { SAND_CONFIG, WORLD_CONFIG } from '../config';
import { AIR, getVoxelDef, getVoxelId } from '../data/voxelTypes';
import { mulberry32 } from '../core/random';
import type { VoxelGrid } from '../voxel/VoxelGrid';
import { packKey, unpackKey } from '../voxel/BrushSystem';
import {
  absorbMoisture,
  dryMoisture,
  reposeAngleFor,
  sandStateOf,
  slideDistanceForMoisture,
  stabilityOf,
  type SandState,
} from './SandPhysics';

const SAND = getVoxelId('sand');
const STONE = getVoxelId('stone');

export interface SandStats {
  /** 这一步处理了多少活跃格 */
  active: number;
  /** 这一步搬动了多少格 */
  moved: number;
  /** 这一步有多少格因为水而变湿 */
  wetted: number;
  /** 这一步有多少格因为干燥而变干 */
  dried: number;
  /** 这一步新登记了多少个"沙崩事件"（一次性搬动超过阈值的连锁） */
  collapses: number;
  /** 本步耗时（毫秒） */
  ms: number;
  /** 平均湿度（只统计沙格；没有沙时为 0） */
  averageMoisture: number;
  /** 各状态的格子数 */
  byState: Record<SandState, number>;
}

/** 一次沙崩事件：用于可视化"连锁范围" */
export interface SandCollapse {
  x: number;
  y: number;
  z: number;
  /** 连锁搬动的格数 */
  cells: number;
  /** 发生时刻（毫秒，调用方给的时钟） */
  atMs: number;
}

/**
 * 沙崩的最小规模：**一步之内**搬动超过这么多格才算"一次沙崩"。
 *
 * 取 12：实测一根 2×2×6 的沙柱（24 格）在第一步会搬动 20 格左右 ——
 * 那显然是"塌了"，应该被记下来。定得太高（我第一版写 24）会漏掉这种规模，
 * 而"可视化里什么都不显示"看起来像功能坏了。定得太低则每次零星滑落都记一条，
 * 面板会被刷屏。
 */
const COLLAPSE_MIN_CELLS = 12;
/** 沙崩事件的保留数量（可视化与面板只看最近几次） */
const COLLAPSE_HISTORY = 24;

export class SandSystem {
  enabled: boolean = SAND_CONFIG.enabledByDefault;
  /**
   * 全局安息角（度）。
   *
   * ⚠ 在**新版**里这个值只在"没有元数据"时作为兜底使用 ——
   * 真正生效的是每格由湿度算出来的安息角。保留它是为了与旧接口兼容
   * （`Engine` 的物理面板一直在调它），并且让"玩家手动指定角度"这件事仍然可用。
   */
  angleOfRepose: number = SAND_CONFIG.angleOfRepose;
  /** 玩家是否手动覆盖了安息角（覆盖之后不再按湿度算） */
  manualAngle = false;
  /** 干燥速率（每秒）。取 0.02 → 从饱和到全干约 50 秒 */
  dryRate = 0.02;
  /** 吸水速率（每秒） */
  absorbRate = 0.6;
  /** 是否启用湿度系统（关掉就退化成旧版的"单一安息角"行为） */
  moistureEnabled = true;

  private readonly active = new Set<number>();
  private batch: number[] = [];
  private readonly byHeight: number[][] = [];
  private readonly rnd: () => number = mulberry32(0x5a4d);
  private lastChanged = 0;
  private lastStats: SandStats = {
    active: 0, moved: 0, wetted: 0, dried: 0, collapses: 0, ms: 0,
    averageMoisture: 0, byState: { dry: 0, wet: 0, saturated: 0 },
  };
  /** 湿度元数据 0~255 → 0~1 */
  private moisture: Uint8Array;
  /** 稳定性元数据 0~255 → 0~1（可视化与压塌用） */
  private stability: Uint8Array;
  private readonly collapses: SandCollapse[] = [];
  /** 元数据是否被写过（没写过就说明这个世界还没有沙被动过，可以少算很多） */
  private metadataDirty = false;

  constructor(private readonly grid: VoxelGrid) {
    for (let y = 0; y < grid.sizeY; y++) this.byHeight.push([]);
    const cells = grid.sizeX * grid.sizeY * grid.sizeZ;
    this.moisture = new Uint8Array(cells);
    this.stability = new Uint8Array(cells);
  }

  // ------------------------------------------------------------------ 元数据

  private indexOf(x: number, y: number, z: number): number {
    // 与 Chunk.index 同一套布局（x 最快、y 最慢），这样按 y 遍历时内存是顺序的
    const area = this.grid.sizeX * this.grid.sizeZ;
    return x + z * this.grid.sizeX + y * area;
  }

  /** 某格的湿度（0~1）。越界或没写过返回 0 */
  moistureAt(x: number, y: number, z: number): number {
    if (!this.grid.inBounds(x, y, z)) return 0;
    return this.moisture[this.indexOf(x, y, z)]! / 255;
  }

  /** 某格的稳定性（0~1，启发式；见 SandPhysics.stabilityOf） */
  stabilityAt(x: number, y: number, z: number): number {
    if (!this.grid.inBounds(x, y, z)) return 1;
    return this.stability[this.indexOf(x, y, z)]! / 255;
  }

  /** 设置湿度（编辑工具"湿沙/干沙"用）。会唤醒这一格并标记元数据 */
  setMoisture(x: number, y: number, z: number, value: number): boolean {
    if (!this.grid.inBounds(x, y, z)) return false;
    const clamped = Math.max(0, Math.min(1, value));
    this.moisture[this.indexOf(x, y, z)] = Math.round(clamped * 255);
    this.metadataDirty = true;
    this.markActive(x, y, z);
    return true;
  }

  /** 这一格的安息角（度）：手动覆盖优先，否则按湿度算 */
  reposeAngleAt(x: number, y: number, z: number): number {
    if (!this.moistureEnabled || this.manualAngle) return this.angleOfRepose;
    return reposeAngleFor(this.moistureAt(x, y, z));
  }

  /** 这一格的滑动前瞻距离（格） */
  slideDistanceAt(x: number, y: number, z: number): number {
    if (!this.moistureEnabled || this.manualAngle) {
      const angle = Math.max(5, Math.min(89, this.angleOfRepose));
      return Math.max(1, Math.min(4, 1 / Math.tan((angle * Math.PI) / 180)));
    }
    return slideDistanceForMoisture(this.moistureAt(x, y, z));
  }

  /** 重算某格（以及它上下邻居）的稳定性 —— 编辑工具与可视化会调用 */
  refreshStabilityAt(x: number, y: number, z: number): void {
    if (!this.grid.inBounds(x, y, z)) return;
    this.refreshStability(x, y, z);
    if (y > 0) this.refreshStability(x, y - 1, z);
    if (y + 1 < this.grid.sizeY) this.refreshStability(x, y + 1, z);
  }

  /** 这一格的状态（干/湿/饱和） */
  stateAt(x: number, y: number, z: number): SandState {
    return sandStateOf(this.moistureAt(x, y, z));
  }

  /** 重算某格的稳定性（坡度用四邻的高度差近似） */
  private refreshStability(x: number, y: number, z: number): void {
    const grid = this.grid;
    // 上方载荷：往上数连续的沙格
    let load = 0;
    for (let dy = 1; dy <= 8; dy += 1) {
      const above = grid.getVoxel(x, y + dy, z);
      if (above === SAND) load += 1;
      else break;
    }
    // 坡度：四个水平邻居里"有沙且比我高"的数量 → 粗略的坡度角
    let higher = 0;
    if (grid.getVoxel(x + 1, y + 1, z) === SAND || grid.getVoxel(x + 1, y, z) === SAND) higher += 1;
    if (grid.getVoxel(x - 1, y + 1, z) === SAND || grid.getVoxel(x - 1, y, z) === SAND) higher += 1;
    if (grid.getVoxel(x, y + 1, z + 1) === SAND || grid.getVoxel(x, y, z + 1) === SAND) higher += 1;
    if (grid.getVoxel(x, y + 1, z - 1) === SAND || grid.getVoxel(x, y, z - 1) === SAND) higher += 1;
    const slope = higher * 22; // 每个方向约 22°（离散近似）
    const value = stabilityOf({ moisture: this.moistureAt(x, y, z), load, slope });
    this.stability[this.indexOf(x, y, z)] = Math.round(value * 255);
  }

  // ------------------------------------------------------------------ 活跃格

  /** 唤醒某格及其邻居的沙 */
  markNeighborhood(x: number, y: number, z: number): void {
    const grid = this.grid;
    for (let dy = 0; dy <= 2; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (!grid.inBounds(nx, ny, nz)) continue;
          if (grid.getVoxel(nx, ny, nz) === SAND) this.active.add(packKey(nx, ny, nz));
        }
      }
    }
  }

  markActive(x: number, y: number, z: number): void {
    if (!this.grid.inBounds(x, y, z)) return;
    this.markNeighborhood(x, y, z);
  }

  /** 标记全世界的沙（换地图 / 读档 / 手动"全部重算"） */
  markAllSand(): void {
    const grid = this.grid;
    for (let y = 0; y < grid.sizeY; y++) {
      for (let z = 0; z < grid.sizeZ; z++) {
        for (let x = 0; x < grid.sizeX; x++) {
          if (grid.getVoxel(x, y, z) === SAND) this.active.add(packKey(x, y, z));
        }
      }
    }
    this.metadataDirty = true;
  }

  clearActivity(): void {
    this.active.clear();
  }

  get activeCount(): number {
    return this.active.size;
  }

  /**
   * 活跃格子的坐标列表（可视化用）。
   *
   * 返回 `[x, y, z]` 三元组数组而不是把 packKey 的编码暴露出去 ——
   * 编码方式（x/y/z 各占多少位）是 BrushSystem 的内部约定，
   * 可视化不该依赖它。代价是每个活跃格分配一个小数组，所以调用方要节流
   * （SandVisualizer 只在开关打开时、每帧最多调用一次）。
   */
  activeCells(): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (const key of this.active) {
      const [x, y, z] = unpackKey(key);
      out.push([x, y, z]);
    }
    return out;
  }

  get lastStepChanges(): number {
    return this.lastChanged;
  }

  get stats(): SandStats {
    return this.lastStats;
  }

  /** 最近的沙崩事件（新的在前） */
  get recentCollapses(): readonly SandCollapse[] {
    return this.collapses;
  }

  /** 当前滑动距离（兼容旧接口：返回全世界的平均前瞻距离） */
  get slideDistance(): number {
    if (!this.moistureEnabled || this.manualAngle) {
      const angle = Math.max(5, Math.min(89, this.angleOfRepose));
      return Math.max(1, Math.min(4, 1 / Math.tan((angle * Math.PI) / 180)));
    }
    // 没有元数据时按干沙算（33° 时的 1.48），这也是最常被查的值
    return slideDistanceForMoisture(0);
  }

  get moistureBytes(): number {
    return this.moisture.byteLength + this.stability.byteLength;
  }

  // ------------------------------------------------------------------ 统计与水分动态

  /**
   * 统计沙的湿度分布（面板显示用）。
   * 只扫有沙的地方 —— 全世界扫一遍在大档是 118 万格，所以调用方要节流（面板里 500ms 一次）。
   */
  survey(): { byState: Record<SandState, number>; averageMoisture: number } {
    const byState: Record<SandState, number> = { dry: 0, wet: 0, saturated: 0 };
    let sum = 0;
    let count = 0;
    const grid = this.grid;
    for (let y = 0; y < grid.sizeY; y++) {
      for (let z = 0; z < grid.sizeZ; z++) {
        for (let x = 0; x < grid.sizeX; x++) {
          if (grid.getVoxel(x, y, z) !== SAND) continue;
          const m = this.moistureAt(x, y, z);
          byState[sandStateOf(m)] += 1;
          sum += m;
          count += 1;
        }
      }
    }
    return { byState, averageMoisture: count === 0 ? 0 : sum / count };
  }

  /**
   * 吸水与干燥：只对**活跃格**做，所以静止的沙不花时间。
   *
   * 水在哪：世界里的水有两种来源 —— 旧的体素水（`getWaterLevel` / 液体体素）
   * 与新的粒子流体（第 1~2 批）。体素水在这里直接读；粒子流体由 `Engine`
   * 通过 `moistenFromFluid()` 反过来告诉沙系统（第 5 批的接口先在这里留好）。
   */
  private tickMoisture(x: number, y: number, z: number, dt: number): { wetted: boolean; dried: boolean } {
    if (!this.moistureEnabled) return { wetted: false, dried: false };
    const grid = this.grid;
    // 数一下六个面里有几个"含水"
    let waterNeighbors = 0;
    for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!grid.inBounds(nx, ny, nz)) continue;
      if (grid.getWaterLevel(nx, ny, nz) > 0) waterNeighbors += 1;
    }
    const before = this.moistureAt(x, y, z);
    let after = before;
    if (waterNeighbors > 0) {
      after = absorbMoisture(before, waterNeighbors, this.absorbRate, dt);
    } else {
      after = dryMoisture(before, this.dryRate, dt);
    }
    if (Math.abs(after - before) < 1 / 255) return { wetted: false, dried: false };
    this.moisture[this.indexOf(x, y, z)] = Math.round(after * 255);
    this.metadataDirty = true;
    // 湿度变了 → 稳定性跟着变（它在可视化里是"沙崩前的征兆"）
    this.refreshStability(x, y, z);
    return { wetted: after > before, dried: after < before };
  }

  /**
   * 粒子流体让沙变湿（第 5 批的接口，这里先实现）。
   *
   * 调用方（Engine）把"粒子流体占据的位置"按格子传进来 ——
   * 传输方式与流体系统无关，所以这里只接受"格子坐标 + 多少水"。
   */
  moistenFromFluid(x: number, y: number, z: number, amount: number): boolean {
    if (!this.moistureEnabled) return false;
    if (!this.grid.inBounds(x, y, z)) return false;
    if (this.grid.getVoxel(x, y, z) !== SAND) return false;
    const before = this.moistureAt(x, y, z);
    const after = Math.min(1, before + Math.max(0, amount));
    if (after === before) return false;
    this.moisture[this.indexOf(x, y, z)] = Math.round(after * 255);
    this.metadataDirty = true;
    this.markActive(x, y, z);
    return true;
  }

  /** 把沙变成石头（凝固工具）。返回改动的格数 */
  solidify(x: number, y: number, z: number, radius: number): number {
    const grid = this.grid;
    let changed = 0;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (!grid.inBounds(nx, ny, nz)) continue;
          if (grid.getVoxel(nx, ny, nz) !== SAND) continue;
          grid.setVoxel(nx, ny, nz, STONE);
          this.moisture[this.indexOf(nx, ny, nz)] = 0;
          this.stability[this.indexOf(nx, ny, nz)] = 255;
          this.active.delete(packKey(nx, ny, nz));
          changed += 1;
        }
      }
    }
    return changed;
  }

  // ------------------------------------------------------------------ 每步推进

  /**
   * 推进一步。返回本步滑动/掉落的格数。
   *
   * 处理顺序：**从下往上**（按 y 分桶）。这样一整根沙柱不会在同一帧里"瞬移"到底，
   * 而是每帧落一格 —— 视觉上是"沙在流"，而不是"闪一下就到地上了"。
   */
  step(nowMs = 0, dt = 1 / 60): number {
    if (!this.enabled) {
      this.lastChanged = 0;
      return 0;
    }
    const started = nowOf();
    const grid = this.grid;
    if (this.active.size === 0) {
      this.lastChanged = 0;
      this.lastStats = { ...this.lastStats, active: 0, moved: 0, wetted: 0, dried: 0, collapses: 0, ms: nowOf() - started };
      return 0;
    }

    this.batch.length = 0;
    const limit = SAND_CONFIG.maxActivePerStep;
    for (const key of this.active) {
      this.batch.push(key);
      if (this.batch.length >= limit) break;
    }
    for (const key of this.batch) this.active.delete(key);

    for (const bucket of this.byHeight) bucket.length = 0;
    for (const key of this.batch) {
      const [, y] = unpackKey(key);
      if (y >= 0 && y < this.byHeight.length) this.byHeight[y]!.push(key);
    }

    let changed = 0;
    let wetted = 0;
    let dried = 0;
    let maxChain = 0;
    let chainOrigin: [number, number, number] | null = null;

    for (let y = 0; y < this.byHeight.length; y += 1) {
      const bucket = this.byHeight[y]!;
      let chainInThisLayer = 0;
      for (const key of bucket) {
        const [x, , z] = unpackKey(key);
        if (grid.getVoxel(x, y, z) !== SAND) continue;
        if (y <= WORLD_CONFIG.bedrockY) continue;

        // ---- 水分动态（先做，因为它会影响这一步的滑动距离）
        const moistureResult = this.tickMoisture(x, y, z, dt);
        if (moistureResult.wetted) wetted += 1;
        if (moistureResult.dried) dried += 1;

        // ---- 正下方是空气 → 直接掉
        if (grid.getVoxel(x, y - 1, z) === AIR) {
          this.move(x, y, z, x, y - 1, z);
          changed += 1;
          chainInThisLayer += 1;
          continue;
        }

        // ---- 斜下方滑动：**滑行距离**由这一格自己的安息角决定
        //
        // ⚠ 这里我踩了两次，写清楚这个规则的真正含义：
        //
        // 一次滑动是"水平走 d 格、竖直落 1 格"，所以它形成的坡度是 `atan(1/d)`：
        //   d=1 → 45°（经典落沙规则）｜d=2 → 26.6°｜d=3 → 18.4°｜d=4 → 14°
        // 而"安息角 θ"对应的水平行程正好是 `1/tan(θ)`：
        //   湿沙 45° → 1.0 格（d 恒为 1）｜干沙 34° → 1.48 格（d 在 1 与 2 之间按概率混合）
        //   饱和沙 15° → 3.73 格（d 在 3 与 4 之间混合）
        //
        // **第一版我把这个距离当成了"前瞻要求"**（要求前方 d 格都空才允许滑动，但实际只走 1 格）——
        // 那是反的：要求越多越难滑，坡度反而更陡。实测症状：干沙与饱和沙堆出来的坡度
        // 一模一样（都是 33.7°），也就是"湿度根本没起作用"。
        // 正确做法：**d 就是实际走多远**。走得多 → 铺得平 → 正好对应"饱和沙像泥流"。
        const slide = this.slideDistanceAt(x, y, z);
        const slideFloor = Math.floor(slide);
        const travel = this.rnd() < slide - slideFloor
          ? Math.min(4, slideFloor + 1)
          : Math.max(1, slideFloor);
        for (const [dx, dz] of this.shuffledDirections()) {
          const tx = x + dx * travel;
          const tz = z + dz * travel;
          if (!this.canSlideInto(tx, y - 1, tz)) continue;
          // 路径必须是通的：中间那些格在 y 与 y-1 两层都得是空气，
          // 否则等于"从沙堆中间穿过去"（那是瞬移，不是滑动）
          let pathClear = true;
          for (let stepIndex = 1; stepIndex < travel; stepIndex += 1) {
            const px = x + dx * stepIndex;
            const pz = z + dz * stepIndex;
            if (grid.getVoxel(px, y, pz) !== AIR || grid.getVoxel(px, y - 1, pz) !== AIR) {
              pathClear = false;
              break;
            }
          }
          if (!pathClear) continue;
          this.move(x, y, z, tx, y - 1, tz);
          changed += 1;
          chainInThisLayer += 1;
          break;
        }
      }
      if (chainInThisLayer > maxChain) {
        maxChain = chainInThisLayer;
        chainOrigin = chainOrigin ?? [0, y, 0];
      }
    }

    // ---- 沙崩事件：一次搬动的规模够大就记一条（可视化"连锁范围"用）
    let collapses = 0;
    if (changed >= COLLAPSE_MIN_CELLS) {
      collapses = 1;
      this.collapses.unshift({
        x: chainOrigin?.[0] ?? 0,
        y: chainOrigin?.[1] ?? 0,
        z: chainOrigin?.[2] ?? 0,
        cells: changed,
        atMs: nowMs,
      });
      while (this.collapses.length > COLLAPSE_HISTORY) this.collapses.pop();
    }

    this.lastChanged = changed;
    const survey = this.metadataDirty ? this.survey() : { byState: this.lastStats.byState, averageMoisture: this.lastStats.averageMoisture };
    this.lastStats = {
      active: this.batch.length,
      moved: changed,
      wetted,
      dried,
      collapses,
      ms: nowOf() - started,
      averageMoisture: survey.averageMoisture,
      byState: survey.byState,
    };
    return changed;
  }

  /**
   * 能不能滑进 (x, y, z)。
   *
   * ⚠ 我第一版在这里多要了一条"目标下方必须是实心"，理由是"沙要支撑得住"——
   * 那是**错的**，而且错得很隐蔽：斜坡上的斜下方格，它下面本来就是空的
   * （斜坡之所以是斜坡就是因为下面没有东西），于是这条要求让沙**永远不会沿斜面滑**，
   * 沙堆会以任意陡的角度立在那里。实测症状：干沙与饱和沙堆出来的坡度**一模一样**
   * （都是 42.7°），也就是"湿度完全没起作用"。
   *
   * 正确的判据只有两条（与 M1.5 的经典落沙一致）：
   * 1. 目标是空气；
   * 2. 目标**上方**不是实心块 —— 否则等于"从实心块里穿过去"。
   * 斜着滑过去之后如果下方是空的，下一次"正下方是空气"的规则会让它继续落下，
   * 两帧合成一个自然的沙流 —— 这才是落沙该有的样子。
   *
   * 额外加的一条：目标格自己有水时不滑进去（沙不会"逆流而上"），这是刻意的。
   */
  private canSlideInto(x: number, y: number, z: number): boolean {
    const grid = this.grid;
    if (!grid.inBounds(x, y, z)) return false;
    if (grid.getVoxel(x, y, z) !== AIR) return false;
    if (y <= WORLD_CONFIG.bedrockY) return false;
    const above = grid.getVoxel(x, y + 1, z);
    if (above !== AIR && getVoxelDef(above).solid) return false;
    if (grid.getWaterLevel(x, y, z) > 0) return false;
    return true;
  }

  private move(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): void {
    const grid = this.grid;
    const fromIndex = this.indexOf(fx, fy, fz);
    const toIndex = this.indexOf(tx, ty, tz);
    grid.setVoxel(fx, fy, fz, AIR);
    grid.setVoxel(tx, ty, tz, SAND);
    // 湿度跟着沙走（沙粒之间的水是"带着走"的）
    this.moisture[toIndex] = this.moisture[fromIndex]!;
    this.stability[toIndex] = this.stability[fromIndex]!;
    this.moisture[fromIndex] = 0;
    this.stability[fromIndex] = 0;
    // 落定之后重算稳定性（它依赖"上方压了多少沙"，搬动会改变这件事）
    this.refreshStability(tx, ty, tz);
    if (ty > 0) this.refreshStability(tx, ty - 1, tz);
    // 落下之后可能继续滑：唤醒新位置与它的邻居
    this.markNeighborhood(tx, ty, tz);
    // 原来的位置空出来了，上面的沙可能失去支撑
    this.markNeighborhood(fx, fy, fz);
    this.metadataDirty = true;
  }

  /**
   * 滑动方向（随机洗牌后的 8 个方向：4 斜 + 4 正）。
   *
   * 为什么用 8 个而不是经典规则的 4 个斜方向：
   * 4 个斜方向堆出来的沙堆是**菱形/金字塔形**（沿着轴看有明显的棱），
   * 而 8 方向堆出来接近圆形，更像自然沙堆。
   * 代价是每格要试的方向多了一倍 —— 但这一步只在"这一格确实要滑"的时候才走，
   * 而绝大多数格子在绝大多数帧里都不滑动（见活跃区域机制）。
   */
  private shuffledDirections(): readonly (readonly [number, number])[] {
    return this.rnd() < 0.5 ? DIRS_A : DIRS_B;
  }
}

/** 8 个滑动方向（两种顺序，随机选一种，避免形成方向偏置） */
const DIRS_A: readonly (readonly [number, number])[] = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];
const DIRS_B: readonly (readonly [number, number])[] = [
  [-1, -1], [1, -1], [-1, 1], [1, 1],
  [0, -1], [0, 1], [-1, 0], [1, 0],
];

/** 六邻域（算吸水时用） */
const NEIGHBOR_OFFSETS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

function nowOf(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 沙的体素 id（编辑工具与可视化要用；集中在这里免得各处再查一次表） */
export const SAND_VOXEL_ID = SAND;
/** 沙的密度（给"压塌"用的粗略质量估计，kg/格） */
export const SAND_DENSITY = 1600;
/** 体素表里 sand 的名字（断言的诊断信息用） */
export const SAND_VOXEL_NAME = getVoxelDef(SAND)?.name ?? 'sand';
