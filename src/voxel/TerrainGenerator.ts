import { WORLD_CONFIG } from '../config';
import { AIR, getVoxelId } from '../data/voxelTypes';
import { mulberry32 } from '../core/random';
import { CHUNK_SIZE, Chunk } from './Chunk';
import type { VoxelGrid } from './VoxelGrid';

const STONE = getVoxelId('stone');
const DIRT = getVoxelId('dirt');
const GRASS = getVoxelId('grass');
const SAND = getVoxelId('sand');
const WATER = getVoxelId('water');
const SNOW = getVoxelId('snow');

/** 地形生成参数（由世界尺寸档位或参考地图提供） */
export interface TerrainParams {
  seed: number;
  /** 水位（体素 y）；地表低于它就会灌水 */
  waterLevel: number;
  baseHeight: number;
  amplitude: number;
  minHeight: number;
  /** 地表最高允许高度（含） */
  maxHeight: number;
  /** 雪线：地表高于它铺雪 */
  snowLine: number;
  noiseScale: number;
  /** 倍频数量，默认 4 */
  octaves?: number;
  /** 是否灌水，默认 true */
  fillWater?: boolean;
  /** 地表起伏的"棱角感" 0~1，越大越尖锐 */
  sharpness?: number;
}

/**
 * 批量写体素的高效通道。
 *
 * 参考地图生成一次要写十几万个体素，如果走 `grid.setVoxel()`，
 * 每次都做"坐标 → 区块 → 下标"的除法和脏标记，会慢好几倍。
 * 这里缓存当前区块，直接写数组，最后统一 `recount() + markAllDirty()`。
 */
export class GridWriter {
  private lastCx = -1;
  private lastCz = -1;
  private lastChunk: Chunk | null = null;

  constructor(private readonly grid: VoxelGrid) {}

  private chunkAt(x: number, z: number): Chunk | null {
    const cx = (x / CHUNK_SIZE) | 0;
    const cz = (z / CHUNK_SIZE) | 0;
    if (cx === this.lastCx && cz === this.lastCz) return this.lastChunk;
    const chunk = this.grid.getChunk(cx, cz) ?? null;
    this.lastCx = cx;
    this.lastCz = cz;
    this.lastChunk = chunk;
    return chunk;
  }

  set(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= this.grid.sizeY) return;
    if (!this.grid.inHorizontalBounds(x, z)) return;
    const chunk = this.chunkAt(x, z);
    if (!chunk) return;
    const lx = x - chunk.originX;
    const lz = z - chunk.originZ;
    chunk.voxels[Chunk.index(lx, y, lz)] = id;
    chunk.water[Chunk.index(lx, y, lz)] = 0;
  }

  /** 写水：类型为 water，水量按 level（0~1） */
  setWater(x: number, y: number, z: number, level = 1): void {
    if (y < 0 || y >= this.grid.sizeY) return;
    if (!this.grid.inHorizontalBounds(x, z)) return;
    const chunk = this.chunkAt(x, z);
    if (!chunk) return;
    const lx = x - chunk.originX;
    const lz = z - chunk.originZ;
    const index = Chunk.index(lx, y, lz);
    chunk.voxels[index] = WATER;
    chunk.water[index] = Math.max(1, Math.min(255, Math.round(level * 255)));
  }

  get(x: number, y: number, z: number): number {
    return this.grid.getVoxel(x, y, z);
  }

  /** 写完后必须调用：重算计数并标记全部区块重建 */
  finish(): void {
    this.grid.recount();
    this.grid.markAllDirty();
  }
}

/** 2D value noise：同一个种子必然得到同一张表 */
export function makeValueNoise(seed: number): (x: number, y: number) => number {
  const rand = mulberry32(seed);
  const size = 256;
  const perm = new Uint8Array(size * 2);
  const values = new Float32Array(size);

  for (let i = 0; i < size; i++) {
    perm[i] = i;
    values[i] = rand() * 2 - 1;
  }
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = a;
  }
  for (let i = 0; i < size; i++) perm[size + i] = perm[i]!;

  const lattice = (xi: number, yi: number): number =>
    values[perm[(perm[xi & 255]! + (yi & 255)) & 255]!]!;

  return (x: number, y: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);

    const v00 = lattice(xi, yi);
    const v10 = lattice(xi + 1, yi);
    const v01 = lattice(xi, yi + 1);
    const v11 = lattice(xi + 1, yi + 1);

    const top = v00 + (v10 - v00) * u;
    const bottom = v01 + (v11 - v01) * u;
    return top + (bottom - top) * v;
  };
}

/** 分形叠加噪声 */
export function makeFbm(
  noise: (x: number, y: number) => number,
  scale: number,
  octaves = 4,
): (x: number, z: number) => number {
  return (x: number, z: number): number => {
    let sum = 0;
    let amp = 1;
    let freq = scale;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise(x * freq, z * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.13;
    }
    return sum / norm;
  };
}

/** 由参数算出一张高度图（长度 = sizeX * sizeZ） */
export function generateHeightmap(grid: VoxelGrid, params: TerrainParams): Int16Array {
  const noise = makeValueNoise(params.seed);
  const fbm = makeFbm(noise, params.noiseScale, params.octaves ?? 4);
  const sharpness = params.sharpness ?? 0.35;
  const heights = new Int16Array(grid.sizeX * grid.sizeZ);

  for (let z = 0; z < grid.sizeZ; z++) {
    for (let x = 0; x < grid.sizeX; x++) {
      const n = fbm(x, z);
      // 正值用平方做峰感，负值保持平缓
      const shaped = n >= 0 ? n * (1 - sharpness + sharpness * n) : n * (1 + sharpness * n);
      const h = Math.round(params.baseHeight + shaped * params.amplitude);
      heights[z * grid.sizeX + x] = Math.max(
        params.minHeight,
        Math.min(params.maxHeight, h),
      );
    }
  }
  return heights;
}

/** 把高度图变成分层地形（地表 / 泥土 / 石头 / 基岩 + 低洼灌水） */
export function fillFromHeightmap(
  grid: VoxelGrid,
  writer: GridWriter,
  heights: Int16Array,
  params: TerrainParams,
): void {
  const waterLevel = params.waterLevel;
  const fillWater = params.fillWater !== false;

  for (let z = 0; z < grid.sizeZ; z++) {
    for (let x = 0; x < grid.sizeX; x++) {
      const h = heights[z * grid.sizeX + x]!;
      const beach = h <= waterLevel + 1;
      const surface = h <= waterLevel ? SAND : h >= params.snowLine ? SNOW : GRASS;

      for (let y = 0; y <= h; y++) {
        let id: number;
        if (y === WORLD_CONFIG.bedrockY) id = STONE; // 基岩层
        else if (y === h) id = surface;
        else if (y > h - 4) id = beach ? SAND : DIRT;
        else id = STONE;
        writer.set(x, y, z, id);
      }

      if (fillWater && h < waterLevel) {
        for (let y = h + 1; y <= waterLevel; y++) writer.setWater(x, y, z, 1);
      }
    }
  }
}

/**
 * 默认地形生成：种子 → 高度图 → 分层 → 灌水。
 * 参考地图用的是同一套底层函数，只是换参数并额外做雕刻。
 */
export class TerrainGenerator {
  static generate(grid: VoxelGrid, params: TerrainParams): void {
    const writer = new GridWriter(grid);
    const heights = generateHeightmap(grid, params);
    fillFromHeightmap(grid, writer, heights, params);
    writer.finish();
  }

  static generateHeightmap = generateHeightmap;
  static makeValueNoise = makeValueNoise;
  static makeFbm = makeFbm;
}

/** —— 参考地图用的雕刻小工具 —— */

/** 把一列挖/填到指定高度（用指定材质） */
export function shapeColumn(
  writer: GridWriter,
  grid: VoxelGrid,
  x: number,
  z: number,
  targetHeight: number,
  material = GRASS,
  depth = 3,
): void {
  if (!grid.inHorizontalBounds(x, z)) return;
  const current = grid.surfaceHeight(x, z);
  if (current < 0) {
    for (let y = WORLD_CONFIG.bedrockY; y <= targetHeight; y++) {
      writer.set(x, y, z, y === WORLD_CONFIG.bedrockY ? STONE : y > targetHeight - depth ? material : STONE);
    }
    return;
  }
  if (targetHeight > current) {
    for (let y = current + 1; y <= targetHeight; y++) writer.set(x, y, z, material);
  } else if (targetHeight < current) {
    for (let y = Math.max(WORLD_CONFIG.bedrockY + 1, targetHeight + 1); y <= current; y++) writer.set(x, y, z, AIR);
  }
}

/** 在 (x,z) 种一棵树 */
export function plantTree(
  writer: GridWriter,
  grid: VoxelGrid,
  x: number,
  z: number,
  rand: () => number,
  options: { trunkHeight?: number; kind?: 'oak' | 'palm' | 'pine' } = {},
): void {
  if (!grid.inHorizontalBounds(x, z)) return;
  const ground = grid.solidSurfaceHeight(x, z);
  if (ground < 0) return;

  const kind = options.kind ?? 'oak';
  const trunk = options.trunkHeight ?? (kind === 'palm' ? 6 : 3 + Math.floor(rand() * 2));
  const wood = getVoxelId('wood');
  const leaves = getVoxelId('leaves');

  for (let i = 1; i <= trunk; i++) writer.set(x, ground + i, z, wood);

  if (kind === 'palm') {
    const top = ground + trunk;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      writer.set(x + dx, top, z + dz, leaves);
      writer.set(x + dx * 2, top - 1, z + dz * 2, leaves);
      writer.set(x + dx + dz, top - 1, z + dz + dx, leaves);
    }
    writer.set(x, top + 1, z, leaves);
    return;
  }

  if (kind === 'pine') {
    for (let layer = 0; layer < 4; layer++) {
      const y = ground + trunk - 3 + layer;
      const r = 3 - layer;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) + Math.abs(dz) > r + 1) continue;
          if (dx === 0 && dz === 0) continue;
          writer.set(x + dx, y, z + dz, leaves);
        }
      }
    }
    writer.set(x, ground + trunk + 1, z, leaves);
    return;
  }

  // 阔叶树
  const crownY = ground + trunk;
  for (let dy = -1; dy <= 1; dy++) {
    const r = dy === 1 ? 1 : 2;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r + 1) continue;
        if (dx === 0 && dz === 0 && dy < 1) continue;
        writer.set(x + dx, crownY + dy, z + dz, leaves);
      }
    }
  }
}

/** 在指定高度铺一层矩形/圆形地坪 */
export function placeSlab(
  writer: GridWriter,
  grid: VoxelGrid,
  centerX: number,
  centerZ: number,
  radius: number,
  y: number,
  material: number,
  round = true,
): void {
  const r2 = radius * radius;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (round && dx * dx + dz * dz > r2) continue;
      const x = centerX + dx;
      const z = centerZ + dz;
      if (!grid.inHorizontalBounds(x, z)) continue;
      writer.set(x, y, z, material);
    }
  }
}
