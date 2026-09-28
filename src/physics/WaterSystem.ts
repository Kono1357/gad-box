import { WATER_CONFIG } from '../config';
import { isLiquid } from '../data/voxelTypes';
import type { VoxelGrid } from '../voxel/VoxelGrid';
import { packKey, unpackKey } from '../voxel/BrushSystem';

/**
 * 水的元胞自动机（简化版）。
 *
 * 玩家反馈"水不能堆到天上，必须依赖容器"，所以这一轮补的是**重力约束**，
 * 不做真实流体。核心是三件事：
 *
 * 1. **每格有水量 0~1**（体素类型之外单独存一层 `Uint8Array`），
 *    而不是"要么有水要么没水" —— 只有这样才有"水位""填满""溢出"。
 * 2. **向下优先**：先尽量往下传，下方装不下了才向四周扩散。
 *    这一条直接保证了"水不会悬空"：任何下方是空气的水都会往下走。
 * 3. **只向更低的邻居扩散**：水平方向只在邻居水位更低时流动，
 *    于是水会自己在容器里摊平，装满后从最低的缺口溢出。
 *
 * 与真实的差别（不假装拟真）：
 * - 没有压力、没有惯性、没有表面张力，水流速度是人为设的上限；
 * - 一格最多装 1.0，超过的部分靠"分给邻居"消化，不是靠压缩；
 * - 水不会推动物体（M3 接物理后再说）。
 *
 * 性能设计：**只处理"活跃格"**。水只有被玩家动过、或邻居变过之后才会被唤醒，
 * 静止的水池不会消耗任何 CPU。活跃格每步还有数量上限，防止一桶水泼下去卡死。
 */
export class WaterSystem {
  enabled: boolean = WATER_CONFIG.enabledByDefault;
  /** 流动速度 0.05~1，越大越快 */
  speed: number = WATER_CONFIG.speed;
  /** 每步向几个水平邻居扩散 */
  dispersion: number = WATER_CONFIG.dispersion;

  private readonly active = new Set<number>();
  private batch: number[] = [];
  /** 按高度分桶，保证"从下往上"处理，水才会先沉底再摊平 */
  private readonly byHeight: number[][] = [];
  private lastChanged = 0;

  constructor(private readonly grid: VoxelGrid) {
    for (let y = 0; y < grid.sizeY; y++) this.byHeight.push([]);

    // 体素一变（玩家编辑、撤销、沙滑落…）就唤醒周围的水
    grid.onVoxelChanged = (x, y, z) => this.markNeighborhood(x, y, z);
  }

  /** 唤醒一个格及其上下左右邻居 */
  markActive(x: number, y: number, z: number): void {
    if (!this.grid.inBounds(x, y, z)) return;
    this.active.add(packKey(x, y, z));
    this.markNeighborhood(x, y, z);
  }

  markNeighborhood(x: number, y: number, z: number): void {
    const grid = this.grid;
    const offsets: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const [dx, dy, dz] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!grid.inBounds(nx, ny, nz)) continue;
      const id = grid.getVoxel(nx, ny, nz);
      if (isLiquid(id)) this.active.add(packKey(nx, ny, nz));
      // 上方是空气也可能是"水即将流进去"的位置，一并唤醒
      else if (grid.getVoxel(nx, ny + 1, nz) !== undefined) {
        const above = grid.getVoxel(nx, ny + 1, nz);
        if (isLiquid(above)) this.active.add(packKey(nx, ny + 1, nz));
      }
    }
  }

  /** 唤醒全部水格（载入存档 / 切换世界后调用） */
  markAllWater(): void {
    const grid = this.grid;
    grid.forEachChunk((chunk) => {
      if (!chunk.hasWater()) return;
      for (let y = 0; y < grid.sizeY; y++) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            if (chunk.getWaterLocal(x, y, z) > 0) {
              this.active.add(packKey(chunk.originX + x, y, chunk.originZ + z));
            }
          }
        }
      }
    });
  }

  get activeCount(): number {
    return this.active.size;
  }

  get lastStepChanges(): number {
    return this.lastChanged;
  }

  clearActivity(): void {
    this.active.clear();
  }

  /** 有多少格装水（世界统计） */
  get waterCells(): number {
    return this.grid.waterCells;
  }

  /**
   * 推进一步。返回本步真正被改动的格数。
   * 由 Engine 的固定步长循环调用（60 Hz）。
   */
  step(): number {
    if (!this.enabled) return 0;
    const grid = this.grid;
    if (this.active.size === 0) {
      this.lastChanged = 0;
      return 0;
    }

    // 1) 取出这一批（有上限），清空活跃集，新唤醒的格子留到下一步
    this.batch.length = 0;
    const limit = WATER_CONFIG.maxActivePerStep;
    for (const key of this.active) {
      this.batch.push(key);
      if (this.batch.length >= limit) break;
    }
    for (const key of this.batch) this.active.delete(key);

    // 2) 按高度从低到高分桶
    for (const bucket of this.byHeight) bucket.length = 0;
    for (const key of this.batch) {
      const [, y] = unpackKey(key);
      if (y >= 0 && y < this.byHeight.length) this.byHeight[y]!.push(key);
    }

    const maxFlow = Math.max(0.05, this.speed * 0.5);
    const epsilon = WATER_CONFIG.epsilon;
    const capacity = WATER_CONFIG.capacity;
    let changed = 0;

    // 3) 从下往上处理
    for (let y = 0; y < this.byHeight.length; y++) {
      const bucket = this.byHeight[y]!;
      for (const key of bucket) {
        const [x, , z] = unpackKey(key);
        let level = grid.getWaterLevel(x, y, z);
        if (level <= 0) continue;

        let moved = 0;

        // 3a) 先往下：只要下方能装，水就一定会往下走 —— 这是"不能悬空"的保证
        if (y > 0 && grid.canHoldWater(x, y - 1, z)) {
          const below = grid.getWaterLevel(x, y - 1, z);
          const space = capacity - below;
          if (space > epsilon) {
            const amount = Math.min(level, space, maxFlow);
            if (amount > epsilon) {
              grid.setWaterLevel(x, y, z, level - amount);
              grid.setWaterLevel(x, y - 1, z, below + amount);
              level -= amount;
              moved += amount;
              this.wake(x, y - 1, z);
              changed++;
            }
          }
        }

        // 3b) 下方装不下（或已经满了）→ 向更低的水平邻居扩散摊平
        if (level > epsilon && moved === 0) {
          const neighbors: Array<readonly [number, number]> = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ];
          let spread = 0;
          for (const [dx, dz] of neighbors) {
            if (spread >= this.dispersion) break;
            const nx = x + dx;
            const nz = z + dz;
            if (!grid.canHoldWater(nx, y, nz)) continue;
            const nLevel = grid.getWaterLevel(nx, y, nz);
            if (level - nLevel <= epsilon) continue;

            // 只转移"高出来的一半"，这样多格之间会自然趋于一致而不是晃来晃去
            const amount = Math.min((level - nLevel) * 0.5, maxFlow);
            if (amount <= epsilon) continue;
            grid.setWaterLevel(x, y, z, level - amount);
            grid.setWaterLevel(nx, y, nz, nLevel + amount);
            level -= amount;
            spread++;
            moved += amount;
            this.wake(nx, y, nz);
            changed++;
          }
        }

        // 4) 还在动就留到下一步继续；彻底安静了就不再进入活跃集（省 CPU）
        if (moved > epsilon) this.active.add(key);
      }
    }

    this.lastChanged = changed;
    return changed;
  }

  private wake(x: number, y: number, z: number): void {
    if (!this.grid.inBounds(x, y, z)) return;
    this.active.add(packKey(x, y, z));
    // 上方也要唤醒：下方水位变了，上方可能可以继续往下漏
    if (y + 1 < this.grid.sizeY && isLiquid(this.grid.getVoxel(x, y + 1, z))) {
      this.active.add(packKey(x, y + 1, z));
    }
  }
}
