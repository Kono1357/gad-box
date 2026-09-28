import { SAND_CONFIG, WORLD_CONFIG } from '../config';
import { AIR, getVoxelDef, getVoxelId } from '../data/voxelTypes';
import { mulberry32 } from '../core/random';
import type { VoxelGrid } from '../voxel/VoxelGrid';
import { packKey, unpackKey } from '../voxel/BrushSystem';

const SAND = getVoxelId('sand');

/**
 * 沙的安息角滑落。
 *
 * 规则（经典落沙元胞自动机的扩展）：
 * 1. 下方是空气 → 直接掉下去；
 * 2. 否则看四个斜下方：如果能斜着滑下去，就滑一格。
 *
 * 关于"安息角"：真正的落沙规则只能产生 **45°** 的堆角（一格横一格竖）。
 * 想要更缓的角度，就得让沙在"边缘外还有两格空"时才滑动 ——
 * 于是本实现用 `slideDistance = 1 / tan(角度)` 来决定滑动的"前瞻距离"：
 *
 * - 34° → 1.48 → 前瞻 1 格（45°）或 2 格（约 26°）按概率随机；
 * - 长期统计下来，沙堆的平均坡度会落在设定角度附近。
 *
 * **这是离散近似，不是精确的连续角度控制**：调参时表现在"45° 和 26° 两档之间按比例混合"，
 * 而不是任意角度都能精确得到。这一点在 README 里也写明了。
 */
export class SandSystem {
  enabled: boolean = SAND_CONFIG.enabledByDefault;
  /** 安息角（度） */
  angleOfRepose: number = SAND_CONFIG.angleOfRepose;

  private readonly active = new Set<number>();
  private batch: number[] = [];
  private readonly byHeight: number[][] = [];
  private readonly rnd: () => number = mulberry32(0x5eed);
  private lastChanged = 0;

  constructor(private readonly grid: VoxelGrid) {
    for (let y = 0; y < grid.sizeY; y++) this.byHeight.push([]);
  }

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

  /** 唤醒全世界的沙（载入存档后调用） */
  markAllSand(): void {
    const grid = this.grid;
    grid.forEachChunk((chunk) => {
      for (let y = 0; y < grid.sizeY; y++) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            if (chunk.getLocal(x, y, z) === SAND) {
              this.active.add(packKey(chunk.originX + x, y, chunk.originZ + z));
            }
          }
        }
      }
    });
  }

  clearActivity(): void {
    this.active.clear();
  }

  get activeCount(): number {
    return this.active.size;
  }

  get lastStepChanges(): number {
    return this.lastChanged;
  }

  /** 由安息角算出"前瞻距离"：1 格 = 45°，2 格 ≈ 26° */
  get slideDistance(): number {
    const radians = (Math.max(10, Math.min(80, this.angleOfRepose)) * Math.PI) / 180;
    return Math.max(1, Math.min(3, 1 / Math.tan(radians)));
  }

  /**
   * 推进一步。返回本步滑动/掉落的格数。
   * 从下往上处理，避免一整根沙柱在同一帧里"瞬移"。
   */
  step(): number {
    if (!this.enabled) return 0;
    const grid = this.grid;
    if (this.active.size === 0) {
      this.lastChanged = 0;
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

    const slide = this.slideDistance;
    const slideFloor = Math.floor(slide);
    const probabilisticExtra = slide - slideFloor;
    let changed = 0;

    for (let y = 0; y < this.byHeight.length; y++) {
      const bucket = this.byHeight[y]!;
      for (const key of bucket) {
        const [x, , z] = unpackKey(key);
        if (grid.getVoxel(x, y, z) !== SAND) continue;
        if (y <= WORLD_CONFIG.bedrockY) continue;

        // 1) 正下方是空气 → 直接掉
        if (grid.getVoxel(x, y - 1, z) === AIR) {
          this.move(x, y, z, x, y - 1, z);
          changed++;
          continue;
        }

        // 2) 斜下方滑动；前瞻距离由安息角决定
        const target = this.rnd() < probabilisticExtra ? slideFloor + 1 : slideFloor;
        let slid = false;
        for (const [dx, dz] of this.shuffledDirections()) {
          if (slid) break;
          // 目标落点：斜下方
          if (!this.canSlideInto(x + dx, y - 1, z + dz)) continue;

          // 前瞻检查：如果设定角度要求"更远的地方也空了才滑"，就多查一段
          if (target >= 2) {
            let pathClear = true;
            for (let step = 2; step <= target; step++) {
              const px = x + dx * step;
              const pz = z + dz * step;
              if (grid.getVoxel(px, y, pz) !== AIR || grid.getVoxel(px, y - 1, pz) !== AIR) {
                pathClear = false;
                break;
              }
            }
            if (!pathClear) continue;
          }

          this.move(x, y, z, x + dx, y - 1, z + dz);
          changed++;
          slid = true;
        }
      }
    }

    this.lastChanged = changed;
    return changed;
  }

  /** 目标格能否落沙：必须是空气，且不是基岩 */
  private canSlideInto(x: number, y: number, z: number): boolean {
    if (y <= WORLD_CONFIG.bedrockY) return false;
    if (!this.grid.inBounds(x, y, z)) return false;
    const id = this.grid.getVoxel(x, y, z);
    if (id !== AIR) return false;
    // 上方不能是实心块，否则等于"从实心块里穿过去"
    const above = this.grid.getVoxel(x, y + 1, z);
    return above === AIR || !getVoxelDef(above).solid;
  }

  private shuffledDirections(): ReadonlyArray<readonly [number, number]> {
    // 四个方向按随机顺序试，避免总是先往 +X 滑造成的方向偏置
    const dirs: Array<readonly [number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    if (this.rnd() < 0.5) {
      const t = dirs[0]!;
      dirs[0] = dirs[1]!;
      dirs[1] = t;
    }
    if (this.rnd() < 0.5) {
      const t = dirs[2]!;
      dirs[2] = dirs[3]!;
      dirs[3] = t;
    }
    return dirs;
  }

  private move(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const grid = this.grid;
    grid.setVoxel(x1, y1, z1, SAND);
    grid.setVoxel(x0, y0, z0, AIR);
    // 源与目标周围都要重新评估
    this.markNeighborhood(x0, y0, z0);
    this.markNeighborhood(x1, y1, z1);
    this.active.add(packKey(x1, y1, z1));
  }
}
