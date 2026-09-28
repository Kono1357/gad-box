import { Box3, Frustum, Matrix4, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { CULLING_CONFIG } from '../config';
import { CHUNK_SIZE } from './Chunk';
import type { Chunk } from './Chunk';
import type { VoxelGrid } from './VoxelGrid';

/** 单个区块的可见性判定结果 */
export interface ChunkVisibility {
  chunk: Chunk;
  /** 是否应该渲染 */
  visible: boolean;
  /** 是否应该卸载网格（保留数据） */
  unload: boolean;
  /** 到相机的水平切比雪夫距离（区块为单位） */
  distance: number;
}

/**
 * 区块剔除。
 *
 * 三层策略（从便宜到贵）：
 * 1. **距离剔除**：超过 `renderDistance` 个区块直接不渲染；
 *    超过 `unloadDistance` 个区块**卸载网格释放显存**，但体素数据留着 ——
 *    玩家走回去时会自动重建，不会丢地形。
 * 2. **视锥剔除**：用相机视锥与区块包围盒求交。
 * 3. 距离升序排序：靠近相机的区块优先重建，玩家转头时不会看到"远处先长出来"。
 *
 * 另外不是每帧都算（默认 6 帧一次），因为相机在小范围移动时可见集合很少变化，
 * 每帧算 256 个区块的包围盒测试是白花的 CPU。
 */
export class ChunkCulling {
  /**
   * 当前渲染距离（水平切比雪夫距离，单位区块）。
   * 由世界尺寸档位初始化，之后会被自适应降级修改 —— 所以不是 readonly。
   */
  renderDistance: number = CULLING_CONFIG.renderDistance;
  /** 卸载距离，固定按渲染距离的 2 倍算（避免抖动） */
  get unloadDistance(): number {
    return this.renderDistance * 2;
  }

  private readonly frustum = new Frustum();
  private readonly matrix = new Matrix4();
  private readonly box = new Box3();
  private readonly min = new Vector3();
  private readonly max = new Vector3();
  private frameCounter = 0;
  private lastResult: ChunkVisibility[] = [];

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly grid: VoxelGrid,
  ) {}

  /** 当前缓存的判定结果（每帧都能读，不一定每帧都重算） */
  get visibility(): readonly ChunkVisibility[] {
    return this.lastResult;
  }

  /** 强制下次 update 立刻重算（世界切换 / 相机跳转后调用） */
  invalidate(): void {
    this.frameCounter = CULLING_CONFIG.updateIntervalFrames;
  }

  /**
   * 评估所有区块的可见性。
   * @param force true 表示无视帧计数强制重算
   */
  update(force = false): ChunkVisibility[] {
    if (!force) {
      this.frameCounter++;
      if (this.frameCounter < CULLING_CONFIG.updateIntervalFrames) return this.lastResult;
    }
    this.frameCounter = 0;

    const camera = this.camera;
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);

    const grid = this.grid;
    const height = grid.sizeY;
    // 相机所在的区块坐标（距离以它为中心算）
    const camChunkX = Math.floor((camera.position.x + grid.halfX) / CHUNK_SIZE);
    const camChunkZ = Math.floor((camera.position.z + grid.halfZ) / CHUNK_SIZE);

    const results: ChunkVisibility[] = [];
    const renderDistance = this.renderDistance;
    const unloadDistance = this.unloadDistance;

    for (const chunk of grid.chunkList) {
      const distance = Math.max(Math.abs(chunk.cx - camChunkX), Math.abs(chunk.cz - camChunkZ));

      if (distance > unloadDistance) {
        results.push({ chunk, visible: false, unload: true, distance });
        continue;
      }
      if (distance > renderDistance) {
        results.push({ chunk, visible: false, unload: false, distance });
        continue;
      }

      if (!CULLING_CONFIG.frustum) {
        results.push({ chunk, visible: true, unload: false, distance });
        continue;
      }

      this.min.set(chunk.originX - grid.halfX, 0, chunk.originZ - grid.halfZ);
      this.max.set(this.min.x + CHUNK_SIZE, height, this.min.z + CHUNK_SIZE);
      this.box.set(this.min, this.max);

      results.push({
        chunk,
        visible: this.frustum.intersectsBox(this.box),
        unload: false,
        distance,
      });
    }

    // 近的排前面：重建预算优先给玩家眼前的区块
    results.sort((a, b) => a.distance - b.distance);
    this.lastResult = results;
    return results;
  }

  /** 可见区块数量（性能面板显示） */
  get visibleCount(): number {
    let count = 0;
    for (const item of this.lastResult) if (item.visible) count++;
    return count;
  }
}
