import { VOXEL_CONFIG, WORLD_CONFIG } from '../config';
import { AIR, getVoxelDef, getVoxelId, isLiquid } from '../data/voxelTypes';
import { CHUNK_SIZE, Chunk } from './Chunk';

/** y < 0 时返回的"虚拟基岩"：让世界底面不渲染，也防止挖穿后看到天空 */
const BEDROCK = getVoxelId('stone');
/** 水的体素 id */
const WATER = getVoxelId('water');

/**
 * 体素世界：管理全部区块，提供读写、脏标记与局部重建队列。
 *
 * 坐标约定（贯穿整个项目）：
 * - 世界坐标（米）：X/Z ∈ [-halfX, halfX)，Y ∈ [0, sizeY)
 * - 体素坐标（整数）：x/z ∈ [0, sizeX/sizeZ)，y ∈ [0, sizeY)
 * - 体素 (x,y,z) 占据的世界空间是 [x-halfX, x-halfX+1) × [y, y+1) × [z-halfZ, z-halfZ+1)
 *
 * M1.5 起尺寸可变（64/128/256 三档），所以**不要**再依赖写死的常量，
 * 需要尺寸就从实例上读。
 */
export class VoxelGrid {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly chunksX: number;
  readonly chunksZ: number;

  /** 世界水平半径（米） */
  readonly halfX: number;
  readonly halfZ: number;

  private readonly chunks: Chunk[];
  private readonly dirtyQueue: Chunk[] = [];
  private nonAirCount = 0;
  private waterCellCount = 0;

  /** 每次真正改动体素都会 +1；自动保存与"有没有新改动"判断用它 */
  private revision = 0;

  /**
   * 体素变化通知：水/沙的元胞自动机靠它把受影响的格子加入活跃集合，
   * 这样就不需要每帧扫描全世界。
   */
  onVoxelChanged?: (x: number, y: number, z: number, previous: number, next: number) => void;

  constructor(sizeX: number, sizeY: number, sizeZ: number) {
    this.sizeX = sizeX;
    this.sizeY = sizeY;
    this.sizeZ = sizeZ;
    this.chunksX = Math.ceil(sizeX / CHUNK_SIZE);
    this.chunksZ = Math.ceil(sizeZ / CHUNK_SIZE);
    this.halfX = sizeX / 2;
    this.halfZ = sizeZ / 2;

    this.chunks = new Array<Chunk>(this.chunksX * this.chunksZ);
    for (let cz = 0; cz < this.chunksZ; cz++) {
      for (let cx = 0; cx < this.chunksX; cx++) {
        this.chunks[cz * this.chunksX + cx] = new Chunk(cx, cz, sizeY, AIR);
      }
    }
    this.markAllDirty();
  }

  // ------------------------------------------------------------ 坐标换算

  worldToVoxelX(worldX: number): number {
    return Math.floor(worldX + this.halfX);
  }

  worldToVoxelZ(worldZ: number): number {
    return Math.floor(worldZ + this.halfZ);
  }

  voxelToWorldX(x: number): number {
    return x - this.halfX;
  }

  voxelToWorldZ(z: number): number {
    return z - this.halfZ;
  }

  /** 体素格中心的世界坐标 */
  voxelCenterX(x: number): number {
    return x - this.halfX + 0.5;
  }

  voxelCenterZ(z: number): number {
    return z - this.halfZ + 0.5;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < this.sizeX && y >= 0 && y < this.sizeY && z >= 0 && z < this.sizeZ;
  }

  inHorizontalBounds(x: number, z: number): boolean {
    return x >= 0 && x < this.sizeX && z >= 0 && z < this.sizeZ;
  }

  /** 该体素是否是受保护的地基（不可破坏） */
  isBedrock(y: number): boolean {
    return y <= WORLD_CONFIG.bedrockY;
  }

  // ------------------------------------------------------------ 区块访问

  getChunk(cx: number, cz: number): Chunk | undefined {
    if (cx < 0 || cx >= this.chunksX || cz < 0 || cz >= this.chunksZ) return undefined;
    return this.chunks[cz * this.chunksX + cx];
  }

  forEachChunk(fn: (chunk: Chunk) => void): void {
    for (const chunk of this.chunks) fn(chunk);
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  get chunkList(): readonly Chunk[] {
    return this.chunks;
  }

  // ------------------------------------------------------------ 读写体素

  /**
   * 读取体素 id。
   * - y < 0：返回虚拟基岩（不透明实心），世界底面不渲染；
   * - 其他越界：返回 air。
   */
  getVoxel(x: number, y: number, z: number): number {
    if (y < 0) return BEDROCK;
    if (y >= this.sizeY || x < 0 || x >= this.sizeX || z < 0 || z >= this.sizeZ) return AIR;
    const cx = (x / CHUNK_SIZE) | 0;
    const cz = (z / CHUNK_SIZE) | 0;
    const chunk = this.chunks[cz * this.chunksX + cx]!;
    return chunk.voxels[Chunk.index(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)]!;
  }

  /**
   * 写入体素 id。会同步维护水量（放水 = 满格，放别的 = 清空该格水）。
   * @returns 是否真的发生了变化
   */
  setVoxel(x: number, y: number, z: number, id: number): boolean {
    if (x < 0 || x >= this.sizeX || y < 0 || y >= this.sizeY || z < 0 || z >= this.sizeZ) {
      return false;
    }
    const cx = (x / CHUNK_SIZE) | 0;
    const cz = (z / CHUNK_SIZE) | 0;
    const chunk = this.chunks[cz * this.chunksX + cx]!;
    const index = Chunk.index(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE);
    const previous = chunk.voxels[index]!;

    const wasWater = isLiquid(previous);
    const isWater = isLiquid(id);
    const previousWater = chunk.water[index]!;

    // 目标水量：放水 → 满格；放别的 → 0
    const nextWater = isWater ? (wasWater && previousWater > 0 ? previousWater : 255) : 0;

    if (previous === id && previousWater === nextWater) return false;

    chunk.voxels[index] = id;
    chunk.water[index] = nextWater;

    if (previous === AIR && id !== AIR) this.nonAirCount++;
    else if (previous !== AIR && id === AIR) this.nonAirCount--;

    if (wasWater && previousWater > 0) this.waterCellCount--;
    if (isWater && nextWater > 0) this.waterCellCount++;

    this.revision++;
    this.markDirtyAt(x, y, z);
    this.onVoxelChanged?.(x, y, z, previous, id);
    return true;
  }

  // ------------------------------------------------------------ 水量

  /** 读取水量（0~1） */
  getWaterLevel(x: number, y: number, z: number): number {
    if (y < 0 || y >= this.sizeY || x < 0 || x >= this.sizeX || z < 0 || z >= this.sizeZ) return 0;
    const cx = (x / CHUNK_SIZE) | 0;
    const cz = (z / CHUNK_SIZE) | 0;
    const chunk = this.chunks[cz * this.chunksX + cx]!;
    return chunk.water[Chunk.index(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)]! / 255;
  }

  /**
   * 直接写水量（0~1）。会自动同步体素类型：
   * 水量 > 0 → 该格是 water；水量 = 0 且原本是 water → 变回 air。
   * 只有原本是 air 或 water 的格子能装水。
   * @returns 是否真的发生了变化
   */
  setWaterLevel(x: number, y: number, z: number, level: number): boolean {
    if (x < 0 || x >= this.sizeX || y < 0 || y >= this.sizeY || z < 0 || z >= this.sizeZ) {
      return false;
    }
    const cx = (x / CHUNK_SIZE) | 0;
    const cz = (z / CHUNK_SIZE) | 0;
    const chunk = this.chunks[cz * this.chunksX + cx]!;
    const index = Chunk.index(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE);
    const currentType = chunk.voxels[index]!;
    const currentWater = chunk.water[index]!;

    if (currentType !== AIR && !isLiquid(currentType)) return false; // 实心块不装水

    const clamped = Math.max(0, Math.min(1, level));
    const nextWater = Math.round(clamped * 255);
    if (currentWater === nextWater && (nextWater > 0) === isLiquid(currentType)) return false;

    chunk.water[index] = nextWater;

    if (nextWater > 0) {
      if (!isLiquid(currentType)) {
        chunk.voxels[index] = WATER;
        if (currentType === AIR) this.nonAirCount++;
        this.waterCellCount++;
      }
    } else if (isLiquid(currentType)) {
      chunk.voxels[index] = AIR;
      this.nonAirCount--;
      this.waterCellCount--;
    }

    this.revision++;
    this.markDirtyAt(x, y, z);
    this.onVoxelChanged?.(x, y, z, currentType, chunk.voxels[index]!);
    return true;
  }

  /** 该格能否容纳水（空气或已经是水） */
  canHoldWater(x: number, y: number, z: number): boolean {
    if (y < 0 || y >= this.sizeY || x < 0 || x >= this.sizeX || z < 0 || z >= this.sizeZ) return false;
    const id = this.getVoxel(x, y, z);
    return id === AIR || isLiquid(id);
  }

  /** 世界上有水的水格数 */
  get waterCells(): number {
    return this.waterCellCount;
  }

  // ------------------------------------------------------------ 世界坐标取样

  sampleWorld(worldX: number, worldY: number, worldZ: number): number {
    return this.getVoxel(
      this.worldToVoxelX(worldX),
      Math.floor(worldY),
      this.worldToVoxelZ(worldZ),
    );
  }

  // ------------------------------------------------------------ 脏标记

  /** 标记某体素所属区块为脏；若体素贴在区块边缘，邻居区块也要重建 */
  markDirtyAt(x: number, _y: number, z: number): void {
    const cx = (x / CHUNK_SIZE) | 0;
    const cz = (z / CHUNK_SIZE) | 0;
    this.markChunkDirty(cx, cz);

    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    if (lx === 0) this.markChunkDirty(cx - 1, cz);
    if (lx === CHUNK_SIZE - 1) this.markChunkDirty(cx + 1, cz);
    if (lz === 0) this.markChunkDirty(cx, cz - 1);
    if (lz === CHUNK_SIZE - 1) this.markChunkDirty(cx, cz + 1);
  }

  markChunkDirty(cx: number, cz: number): void {
    const chunk = this.getChunk(cx, cz);
    if (!chunk || chunk.dirty) return;
    chunk.dirty = true;
    this.dirtyQueue.push(chunk);
  }

  markAllDirty(): void {
    this.dirtyQueue.length = 0;
    for (const chunk of this.chunks) {
      chunk.dirty = true;
      this.dirtyQueue.push(chunk);
    }
  }

  /** 取出最多 limit 个待重建区块（FIFO），供主循环分帧摊销 */
  consumeDirty(limit: number): Chunk[] {
    if (this.dirtyQueue.length === 0) return [];
    const count = Math.min(limit, this.dirtyQueue.length);
    const result = this.dirtyQueue.splice(0, count);
    for (const chunk of result) chunk.dirty = false;
    return result;
  }

  get pendingDirtyCount(): number {
    return this.dirtyQueue.length;
  }

  get nonAir(): number {
    return this.nonAirCount;
  }

  get editRevision(): number {
    return this.revision;
  }

  /** 每帧重建预算（配置里改） */
  get meshBudget(): number {
    return VOXEL_CONFIG.meshBudgetPerFrame;
  }

  // ------------------------------------------------------------ 地形查询

  /** 某一列最高的非 air 体素 y；整列皆空返回 -1 */
  surfaceHeight(x: number, z: number): number {
    if (x < 0 || x >= this.sizeX || z < 0 || z >= this.sizeZ) return -1;
    const cx = (x / CHUNK_SIZE) | 0;
    const cz = (z / CHUNK_SIZE) | 0;
    const chunk = this.chunks[cz * this.chunksX + cx]!;
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    for (let y = this.sizeY - 1; y >= 0; y--) {
      if (chunk.voxels[Chunk.index(lx, y, lz)] !== AIR) return y;
    }
    return -1;
  }

  /** 某一列最高的"实心"体素 y（忽略水），用于建筑贴地 */
  solidSurfaceHeight(x: number, z: number): number {
    if (x < 0 || x >= this.sizeX || z < 0 || z >= this.sizeZ) return -1;
    const cx = (x / CHUNK_SIZE) | 0;
    const cz = (z / CHUNK_SIZE) | 0;
    const chunk = this.chunks[cz * this.chunksX + cx]!;
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    for (let y = this.sizeY - 1; y >= 0; y--) {
      const id = chunk.voxels[Chunk.index(lx, y, lz)]!;
      if (id !== AIR && getVoxelDef(id).solid) return y;
    }
    return -1;
  }

  // ------------------------------------------------------------ 批量

  clear(fill = AIR): void {
    for (const chunk of this.chunks) {
      chunk.voxels.fill(fill);
      chunk.water.fill(0);
      chunk.dirty = true;
    }
    this.dirtyQueue.length = 0;
    for (const chunk of this.chunks) this.dirtyQueue.push(chunk);
    this.nonAirCount = 0;
    this.waterCellCount = 0;
    this.revision++;
  }

  /** 重新统计非空气体素与水量格（生成 / 导入后调用） */
  recount(): void {
    let total = 0;
    let water = 0;
    for (const chunk of this.chunks) {
      const data = chunk.voxels;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== AIR) {
          total++;
          if (chunk.water[i]! > 0) water++;
        }
      }
    }
    this.nonAirCount = total;
    this.waterCellCount = water;
    this.revision++;
  }
}
