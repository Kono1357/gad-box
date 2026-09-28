import { DEFAULT_WORLD_SIZE, WORLD_SIZES, getWorldSize } from '../worldSize';
import type { WorldSizeId } from '../worldSize';
import { VoxelGrid } from '../voxel/VoxelGrid';

/** 世界统计 */
export interface WorldStats {
  voxels: number;
  waterCells: number;
  rigidBodies: number;
}

/**
 * 世界数据容器。
 *
 * M1.5 起尺寸不再是常量：`sizeId` 指向 `worldSize.ts` 的一档预设，
 * 也可能来自某张参考地图（`mapId` 非空）。
 * 换世界 = 新建一个 World 并把所有依赖它的系统重新绑定，见 Engine.createWorld()。
 */
export class World {
  readonly seed: number;
  readonly sizeId: WorldSizeId;
  /** 来源参考地图 id；空白世界为 null */
  readonly mapId: string | null;

  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly chunkSize: number;
  readonly chunksX: number;
  readonly chunksZ: number;

  /** 体素网格 */
  readonly grid: VoxelGrid;

  constructor(seed: number, sizeId: WorldSizeId = DEFAULT_WORLD_SIZE, mapId: string | null = null) {
    const preset = getWorldSize(sizeId);
    this.seed = seed | 0;
    this.sizeId = preset.id;
    this.mapId = mapId;
    this.sizeX = preset.sizeX;
    this.sizeY = preset.sizeY;
    this.sizeZ = preset.sizeZ;
    this.chunkSize = preset.chunkSize;
    this.chunksX = Math.ceil(this.sizeX / this.chunkSize);
    this.chunksZ = Math.ceil(this.sizeZ / this.chunkSize);
    this.grid = new VoxelGrid(this.sizeX, this.sizeY, this.sizeZ);
  }

  get preset() {
    return WORLD_SIZES[this.sizeId];
  }

  get halfSizeX(): number {
    return this.sizeX / 2;
  }

  get halfSizeZ(): number {
    return this.sizeZ / 2;
  }

  get originX(): number {
    return -this.halfSizeX;
  }

  get originZ(): number {
    return -this.halfSizeZ;
  }

  /** 某世界坐标落在哪个区块 */
  chunkIndexAt(x: number, z: number): [number, number] {
    const cx = Math.floor((x - this.originX) / this.chunkSize);
    const cz = Math.floor((z - this.originZ) / this.chunkSize);
    return [cx, cz];
  }

  contains(x: number, z: number): boolean {
    return x >= this.originX && x < this.originX + this.sizeX && z >= this.originZ && z < this.originZ + this.sizeZ;
  }

  get stats(): WorldStats {
    return { voxels: this.grid.nonAir, waterCells: this.grid.waterCells, rigidBodies: 0 };
  }

  get voxelCount(): number {
    return this.grid.nonAir;
  }

  /** 一句话描述（状态栏 / 存档用） */
  get label(): string {
    return `${this.preset.name}${this.mapId ? ` · ${this.mapId}` : ''} · 种子 ${this.seed}`;
  }
}
