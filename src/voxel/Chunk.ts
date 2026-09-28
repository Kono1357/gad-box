import type { Mesh } from 'three';

/** 区块水平边长（体素），固定 16 */
export const CHUNK_SIZE = 16;
/** 区块水平面积 */
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;

/**
 * 一个区块：16 × 16 水平、高度等于世界高度（M1.5 不做 Y 轴区块切分）。
 *
 * 两块数据：
 * - `voxels`：体素类型 id（Uint8Array，长度 = 16 × sizeY × 16）
 * - `water`：每格水量 0~255（映射到 0~1）。**只有 liquid 体素才有非零水量**，
 *   两者由 VoxelGrid 保证同步（类型是 water ⟺ 水量 > 0）。
 *
 * 为什么水量要单独存：水的"填满容器再溢出"需要知道每格装了多少，
 * 只用体素类型只能表达"有/没有"，做不出水位。
 */
export class Chunk {
  readonly cx: number;
  readonly cz: number;
  readonly key: string;
  /** 世界高度（该区块的 Y 跨度） */
  readonly sizeY: number;

  /** 体素类型 id */
  readonly voxels: Uint8Array;
  /** 水量，0~255 对应 0~1 */
  readonly water: Uint8Array;

  /** 是否需要重建网格 */
  dirty = true;

  /** 不透明部分的渲染网格 */
  mesh: Mesh | null = null;
  /** 半透明部分（水、玻璃）的渲染网格 */
  transparentMesh: Mesh | null = null;

  faceCount = 0;
  transparentFaceCount = 0;

  constructor(cx: number, cz: number, sizeY: number, fill = 0) {
    this.cx = cx;
    this.cz = cz;
    this.sizeY = sizeY;
    this.key = `${cx},${cz}`;
    this.voxels = new Uint8Array(CHUNK_AREA * sizeY);
    this.water = new Uint8Array(CHUNK_AREA * sizeY);
    if (fill !== 0) this.voxels.fill(fill);
  }

  /** 区块内局部坐标 → 数组下标。x/z ∈ [0,16)，y ∈ [0,sizeY) */
  static index(x: number, y: number, z: number): number {
    return x + z * CHUNK_SIZE + y * CHUNK_AREA;
  }

  get originX(): number {
    return this.cx * CHUNK_SIZE;
  }

  get originZ(): number {
    return this.cz * CHUNK_SIZE;
  }

  /** 该区块体素总数 */
  get volume(): number {
    return this.voxels.length;
  }

  getLocal(x: number, y: number, z: number): number {
    return this.voxels[Chunk.index(x, y, z)]!;
  }

  setLocal(x: number, y: number, z: number, id: number): void {
    this.voxels[Chunk.index(x, y, z)] = id;
  }

  getWaterLocal(x: number, y: number, z: number): number {
    return this.water[Chunk.index(x, y, z)]!;
  }

  setWaterLocal(x: number, y: number, z: number, level: number): void {
    this.water[Chunk.index(x, y, z)] = level;
  }

  /** 该区块是否含任意水量（网格构建与存档用它决定要不要处理水层） */
  hasWater(): boolean {
    const data = this.water;
    for (let i = 0; i < data.length; i++) if (data[i] !== 0) return true;
    return false;
  }

  /** 清空渲染资源引用（重新生成世界前调用） */
  detachMesh(): void {
    this.mesh = null;
    this.transparentMesh = null;
    this.faceCount = 0;
    this.transparentFaceCount = 0;
  }
}
