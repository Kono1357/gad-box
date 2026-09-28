/**
 * 地形碰撞体（M3 第 1 批：**重写** —— 从"全世界一个 heightfield"改成"每区块一个，可局部更新"）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么要拆到区块级
 * ────────────────────────────────────────────────────────────
 * M2 的实现在全世界只用**一个** heightfield 碰撞体。它有两个问题：
 *
 * 1. **改一格体素要重建整张高度图**。标准档 96×96 = 9216 个采样点，
 *    拖动笔刷时每 280 ms 就重建一次，大档（192×192）是 3.7 万点 —— 这是编辑时的卡顿来源之一；
 * 2. **一个 heightfield 描述不了洞穴与悬挑**。高度图是"每列一个高度"，
 *    挖穿山体做成隧道时，隧道会在物理上被填实 —— 看得见洞、走不进去。
 *
 * 现在改成：**每个区块（16×16）一个碰撞体，并且区块内部先判断该用哪种表示**：
 *
 * | 区块形态 | 用哪种碰撞体 | 理由 |
 * |---|---|---|
 * | 列实心（每列从底到顶连续实心） | **一个 heightfield** | 高度图对这种地形是**精确**的，而且只有一个碰撞体，最省 |
 * | 有洞穴 / 悬挑 / 中空 | **greedy 合并的若干 cuboid** | 高度图会填实空洞，必须用盒子拼 |
 *
 * "列实心"的判定是**逐列数实心格数**：如果某列最高实心格在 y=top，
 * 而该列实心格数正好等于 top+1，那这一列就是连续的。全部列都连续 → 用高度图。
 * 这个判定是一次 O(区块体积) 的扫描（16×16×高度），只在区块重建时跑一次。
 *
 * ────────────────────────────────────────────────────────────
 * 所有区块的碰撞体挂在**同一个静态刚体**上
 * ────────────────────────────────────────────────────────────
 * 这是刻意的：`Engine` 与 `BuildingSystem` 都依赖 `terrainCollider.bodyHandle`
 * 来识别"射线打到的是地形"，也把它当作建筑脚下的静态锚点。
 * 每个区块一个刚体的话，这个 handle 就变成一个列表，要改动一堆既有代码。
 * 而 Rapier 允许在一个刚体上挂任意多个碰撞体，局部更新只需要
 * `removeCollider(那一个) + createCollider(新的)` —— 刚体本身不动。
 *
 * ────────────────────────────────────────────────────────────
 * 诚实记录两个近似
 * ────────────────────────────────────────────────────────────
 * 1. heightfield 的碰撞面是采样点之间的**线性插值**，所以方块地形在物理上是"缓坡"而不是台阶。
 *    好处是物体不会卡在方块棱角上；代价是站在一格边缘会缓慢下滑。
 * 2. 高度取每列最高**实心**体素的顶面，水不算实心 —— 所以水面上能站得住（其实是站在水底的沙上）。
 *    没有做"浮在水面"，那是 `BuoyancySystem` 的活。
 */

import type { VoxelGrid } from '../voxel/VoxelGrid';
import { CHUNK_SIZE } from '../voxel/Chunk';
import { interactionGroups } from './ColliderFactory';

/** 编辑后延迟多久重建（毫秒）。拖动笔刷时不要每帧重建 */
const REBUILD_DEBOUNCE_MS = 280;
/** 单帧最多重建几个区块，避免大面积编辑时一帧卡住 */
const MAX_CHUNKS_PER_UPDATE = 6;
/** 一次贪心合并最多产出多少个盒子（防止极端地形把碰撞体数量打爆） */
const MAX_BOXES_PER_CHUNK = 96;

/** 我们用到的最小 Rapier 面（避免 import 4MB 的 d.ts） */
interface RapierApiLike {
  RigidBodyDesc: { fixed(): { setTranslation(x: number, y: number, z: number): unknown } };
  ColliderDesc: {
    heightfield(
      nrows: number,
      ncols: number,
      heights: Float32Array,
      scale: { x: number; y: number; z: number },
    ): ColliderDescLike;
    cuboid(hx: number, hy: number, hz: number): ColliderDescLike;
  };
}

interface ColliderDescLike {
  setTranslation(x: number, y: number, z: number): ColliderDescLike;
  setFriction(friction: number): ColliderDescLike;
  setRestitution(restitution: number): ColliderDescLike;
  setCollisionGroups(groups: number): ColliderDescLike;
}

interface RapierWorldLike {
  createRigidBody(desc: unknown): { handle: number };
  getRigidBody(handle: number): unknown;
  removeRigidBody(body: unknown): void;
  createCollider(desc: ColliderDescLike, body: unknown): { handle: number };
  getCollider(handle: number): unknown;
  removeCollider(collider: unknown, wakeUp: boolean): void;
}

/** 一个区块的碰撞体记录 */
interface ChunkColliderRecord {
  key: string;
  cx: number;
  cz: number;
  /** 该区块用到的碰撞体句柄 */
  handles: number[];
  /** 表示方式 */
  mode: 'heightfield' | 'cuboids';
  /** cuboid 模式下的盒子数量 */
  boxCount: number;
}

/** 地形碰撞体统计（面板显示） */
export interface TerrainColliderStats {
  /** 已建碰撞体的区块数 */
  chunks: number;
  /** 其中用高度图的区块数 */
  heightfieldChunks: number;
  /** 其中用盒子合并的区块数（有洞穴/悬挑） */
  cuboidChunks: number;
  /** 总碰撞体数 */
  colliders: number;
  /** 总盒子数（cuboid 模式累计） */
  boxes: number;
  /** 上一次全量重建耗时 */
  buildMs: number;
  /** 上一次单区块重建耗时 */
  lastRebuildMs: number;
  /** 待重建的区块数 */
  pending: number;
  /** 地形刚体句柄 */
  bodyHandle: number;
}

export class TerrainCollider {
  private body = -1;
  private readonly chunkRecords = new Map<string, ChunkColliderRecord>();
  /** 待重建的区块（防抖后统一处理） */
  private readonly dirtyChunks = new Map<string, { cx: number; cz: number }>();
  private readonly dirtyKeys: string[] = [];
  private rebuildAt = 0;
  private lastBuildMs = 0;
  private lastRebuildMs = 0;

  constructor(private readonly physics: { raw: RapierWorldLike | null; api: RapierApiLike | null }) {}

  // ------------------------------------------------------------------ 只读

  /** 地形刚体句柄（射线识别 + 建筑静态锚点都用它） */
  get bodyHandle(): number {
    return this.body;
  }

  get exists(): boolean {
    return this.body >= 0;
  }

  get buildMs(): number {
    return this.lastBuildMs;
  }

  get lastChunkRebuildMs(): number {
    return this.lastRebuildMs;
  }

  /** 兼容 M2 的 `sampleStep`：区块级实现下高度图一律 1 格采样，所以恒为 1 */
  get sampleStep(): number {
    return 1;
  }

  get stats(): TerrainColliderStats {
    let heightfieldChunks = 0;
    let cuboidChunks = 0;
    let colliders = 0;
    let boxes = 0;
    for (const record of this.chunkRecords.values()) {
      if (record.mode === 'heightfield') heightfieldChunks += 1;
      else cuboidChunks += 1;
      colliders += record.handles.length;
      boxes += record.boxCount;
    }
    return {
      chunks: this.chunkRecords.size,
      heightfieldChunks,
      cuboidChunks,
      colliders,
      boxes,
      buildMs: this.lastBuildMs,
      lastRebuildMs: this.lastRebuildMs,
      pending: this.dirtyKeys.length,
      bodyHandle: this.body,
    };
  }

  // ------------------------------------------------------------------ 脏标记

  /** 全量重建（载入世界 / 换地图） */
  markDirty(): void {
    this.rebuildAt = now() + REBUILD_DEBOUNCE_MS;
    this.dirtyAll = true;
  }

  /**
   * 只标记一个区块（体素编辑走这条）。
   * 世界坐标 → 区块坐标的换算放在这里，调用方只需要给世界坐标。
   */
  markChunkDirtyAt(grid: VoxelGrid, worldX: number, worldZ: number): void {
    const cx = Math.floor((worldX + grid.halfX) / CHUNK_SIZE);
    const cz = Math.floor((worldZ + grid.halfZ) / CHUNK_SIZE);
    this.markChunkDirty(cx, cz, grid);
  }

  markChunkDirty(cx: number, cz: number, grid: VoxelGrid): void {
    if (cx < 0 || cz < 0 || cx >= grid.chunksX || cz >= grid.chunksZ) return;
    const key = `${cx},${cz}`;
    if (!this.dirtyChunks.has(key)) {
      this.dirtyChunks.set(key, { cx, cz });
      this.dirtyKeys.push(key);
    }
    this.rebuildAt = now() + REBUILD_DEBOUNCE_MS;
  }

  private dirtyAll = false;

  // ------------------------------------------------------------------ 构建

  /**
   * 立刻全量重建。
   * @returns 用时（毫秒）
   */
  build(grid: VoxelGrid): number {
    const started = now();
    const world = this.physics.raw;
    const api = this.physics.api;
    if (!world || !api) return 0;

    this.removeAll();
    this.ensureBody(api, world);

    for (let cz = 0; cz < grid.chunksZ; cz++) {
      for (let cx = 0; cx < grid.chunksX; cx++) {
        this.buildChunk(grid, cx, cz);
      }
    }

    this.dirtyAll = false;
    this.dirtyChunks.clear();
    this.dirtyKeys.length = 0;
    this.lastBuildMs = now() - started;
    return this.lastBuildMs;
  }

  /**
   * 每帧调用（防抖 + 限量）。
   * @param nowMs 可注入的当前时间 —— 测试里传一个"未来时间"就能跳过防抖，
   *              不必在单元测试里真的 sleep 280 毫秒（那会让整个测试慢下来且不稳定）。
   * @returns 本帧真的重建了几个区块；-1 表示做了全量重建
   */
  update(grid: VoxelGrid, nowMs = now()): number {
    if (!this.dirtyAll && this.dirtyKeys.length === 0) return 0;
    if (nowMs < this.rebuildAt) return 0;

    const world = this.physics.raw;
    const api = this.physics.api;
    if (!world || !api) return 0;

    if (this.dirtyAll) {
      this.build(grid);
      return -1;
    }

    this.ensureBody(api, world);
    let rebuilt = 0;
    const tick = nowMs;
    while (this.dirtyKeys.length > 0 && rebuilt < MAX_CHUNKS_PER_UPDATE) {
      const key = this.dirtyKeys.shift()!;
      const target = this.dirtyChunks.get(key);
      this.dirtyChunks.delete(key);
      if (!target) continue;
      this.removeChunk(key, world);
      this.buildChunk(grid, target.cx, target.cz);
      rebuilt += 1;
    }
    this.lastRebuildMs = now() - tick;
    return rebuilt;
  }

  /** 丢掉句柄（换世界时用，必须在 PhysicsWorld.clear() 之后调） */
  reset(): void {
    this.body = -1;
    this.chunkRecords.clear();
    this.dirtyChunks.clear();
    this.dirtyKeys.length = 0;
    this.dirtyAll = false;
    this.rebuildAt = 0;
  }

  dispose(): void {
    this.removeAll();
    this.reset();
  }

  // ------------------------------------------------------------------ 内部

  private ensureBody(api: RapierApiLike, world: RapierWorldLike): void {
    if (this.body >= 0) return;
    // 所有区块的碰撞体共用这一个静态刚体（理由见文件头）
    const desc = api.RigidBodyDesc.fixed().setTranslation(0, 0, 0);
    this.body = world.createRigidBody(desc).handle;
  }

  /** 建一个区块的碰撞体 */
  private buildChunk(grid: VoxelGrid, cx: number, cz: number): void {
    const world = this.physics.raw;
    const api = this.physics.api;
    if (!world || !api || this.body < 0) return;

    const key = `${cx},${cz}`;
    const sizeY = grid.sizeY;
    const mode = this.chunkMode(grid, cx, cz, sizeY);

    const handles: number[] = [];
    let boxCount = 0;

    if (mode === 'heightfield') {
      const handle = this.createHeightfield(api, world, grid, cx, cz);
      if (handle >= 0) handles.push(handle);
    } else {
      const boxes = greedyMerge(this.solidMask(grid, cx, cz, sizeY), CHUNK_SIZE, sizeY, CHUNK_SIZE);
      for (const box of boxes) {
        const desc = api.ColliderDesc.cuboid(box.hx, box.hy, box.hz);
        desc.setTranslation(
          box.cx + cx * CHUNK_SIZE - grid.halfX,
          box.cy,
          box.cz + cz * CHUNK_SIZE - grid.halfZ,
        );
        desc.setFriction(TERRAIN_FRICTION);
        desc.setRestitution(TERRAIN_RESTITUTION);
        desc.setCollisionGroups(interactionGroups('terrain'));
        handles.push(world.createCollider(desc, world.getRigidBody(this.body)).handle);
        boxCount += 1;
      }
    }

    this.chunkRecords.set(key, {
      key,
      cx,
      cz,
      handles,
      mode,
      boxCount,
    });
  }

  private createHeightfield(
    api: RapierApiLike,
    world: RapierWorldLike,
    grid: VoxelGrid,
    cx: number,
    cz: number,
  ): number {
    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;
    // Rapier 约定（M1.5 实测摸出来的）：heights[col * (nrows + 1) + row]，col ↔ X，row ↔ Z。
    // 注意 nrows/ncols 是**细分数**，高度数组长度是 (nrows+1)×(ncols+1)。
    const rows = CHUNK_SIZE;
    const cols = CHUNK_SIZE;
    const heights = new Float32Array((rows + 1) * (cols + 1));
    for (let col = 0; col <= cols; col++) {
      const x = Math.min(grid.sizeX - 1, originX + col);
      for (let row = 0; row <= rows; row++) {
        const z = Math.min(grid.sizeZ - 1, originZ + row);
        const top = grid.solidSurfaceHeight(x, z);
        // 高度 = 最高实心体素的**顶面**（不是格中心）；没有实心地形的列压到 0
        heights[col * (rows + 1) + row] = top < 0 ? 0 : top + 1;
      }
    }

    const desc = api.ColliderDesc.heightfield(rows, cols, heights, {
      x: CHUNK_SIZE,
      y: 1,
      z: CHUNK_SIZE,
    });
    // heightfield 以碰撞体原点为中心，所以要把它挪到区块中心
    desc.setTranslation(
      originX + CHUNK_SIZE / 2 - grid.halfX,
      0,
      originZ + CHUNK_SIZE / 2 - grid.halfZ,
    );
    desc.setFriction(TERRAIN_FRICTION);
    desc.setRestitution(TERRAIN_RESTITUTION);
    desc.setCollisionGroups(interactionGroups('terrain'));

    const body = world.getRigidBody(this.body);
    return world.createCollider(desc, body).handle;
  }

  /**
   * 判定一个区块该用高度图还是盒子。
   *
   * 判据：**每一列的实心格数是否正好等于"最高实心格的 y + 1"**。
   * 相等 = 这一列从底到顶连续；全部列都连续 → 高度图精确。
   * 只要有一列不连续（挖出了洞穴、或者有悬挑），就必须用盒子拼，
   * 否则高度图会把空洞填实 —— 表现是"看得见洞、走不进去"。
   */
  private chunkMode(grid: VoxelGrid, cx: number, cz: number, sizeY: number): 'heightfield' | 'cuboids' {
    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const vx = originX + x;
        const vz = originZ + z;
        if (vx >= grid.sizeX || vz >= grid.sizeZ) continue;

        let top = -1;
        let solidCount = 0;
        for (let y = 0; y < sizeY; y++) {
          if (grid.getVoxel(vx, y, vz) !== 0) {
            top = y;
            solidCount += 1;
          }
        }
        if (top < 0) continue; // 全空的列：高度图给 0，正确
        if (solidCount !== top + 1) return 'cuboids';
      }
    }
    return 'heightfield';
  }

  /** 区块的实心掩码（1 = 实心），用于贪心合并 */
  private solidMask(grid: VoxelGrid, cx: number, cz: number, sizeY: number): Uint8Array {
    const mask = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * sizeY);
    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;
    for (let y = 0; y < sizeY; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const vx = originX + x;
          const vz = originZ + z;
          if (vx >= grid.sizeX || vz >= grid.sizeZ) continue;
          if (grid.getVoxel(vx, y, vz) !== 0) {
            // 布局：index(x, y, z) = x + z * SIZE + y * SIZE * SIZE
            mask[x + z * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE] = 1;
          }
        }
      }
    }
    return mask;
  }

  private removeChunk(key: string, world: RapierWorldLike): void {
    const record = this.chunkRecords.get(key);
    if (!record) return;
    for (const handle of record.handles) {
      const collider = world.getCollider(handle);
      if (collider) {
        try {
          world.removeCollider(collider, false);
        } catch {
          /* 已经被 Rapier 自动回收（例如物理世界被 clear 过），忽略 */
        }
      }
    }
    this.chunkRecords.delete(key);
  }

  private removeAll(): void {
    const world = this.physics.raw;
    if (world) {
      for (const key of [...this.chunkRecords.keys()]) this.removeChunk(key, world);
      if (this.body >= 0) {
        const body = world.getRigidBody(this.body);
        if (body) {
          try {
            world.removeRigidBody(body);
          } catch {
            /* 已经被清掉了 */
          }
        }
      }
    } else {
      this.chunkRecords.clear();
    }
    this.body = -1;
  }
}

/** 地形摩擦/弹性：石头地面偏"不弹、能停住" */
const TERRAIN_FRICTION = 0.9;
const TERRAIN_RESTITUTION = 0.02;

/** 贪心合并产出的一个盒子（中心在区块局部坐标，半尺寸） */
export interface MergedBox {
  /** 中心（区块局部体素坐标，单位是格） */
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
}

/**
 * 三维贪心合并：把一片体素合并成尽量少的盒子。
 *
 * 算法（标准的 greedy meshing，只是从"面"改成"体"）：
 * 1. 从最小未访问的实心格出发，先沿 X 尽量延伸；
 * 2. 再把这条 X 线段沿 Z 复制，只要整片都是实心就继续；
 * 3. 再把这片 XZ 矩形沿 Y 复制，只要整层都是实心就继续；
 * 4. 把这个盒子里的所有格标记为已访问，产出中心 + 半尺寸。
 *
 * 为什么不用"逐格一个立方体"：一块 16×16×8 的实心地形是 2048 个碰撞体，
 * 而贪心合并之后通常只剩十几个。宽相位每帧要过的对象数量差两个数量级。
 *
 * 为什么不用 octree：octree 对**部分填充**的层会不断细分，遇到斜坡地形会产出比贪心更多的节点；
 * 贪心合并专门吃"轴向连续的实心块"，而体素地形正好就是这种形状。
 *
 * `MAX_BOXES_PER_CHUNK` 是安全阀：极端地形（大量薄壳交错）下盒子数会攀升，
 * 超过上限就直接放弃剩余部分 —— 宁可少一点碰撞体（玩家可能穿过一块薄壳），
 * 也不能让一个区块产出几百个碰撞体把宽相位压垮。
 */
export function greedyMerge(
  mask: Uint8Array,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
): MergedBox[] {
  const visited = new Uint8Array(mask.length);
  const boxes: MergedBox[] = [];
  const at = (x: number, y: number, z: number): number => x + z * sizeX + y * sizeX * sizeZ;
  const solid = (x: number, y: number, z: number): boolean =>
    x >= 0 && y >= 0 && z >= 0 && x < sizeX && y < sizeY && z < sizeZ && mask[at(x, y, z)] === 1;

  for (let y = 0; y < sizeY; y++) {
    for (let z = 0; z < sizeZ; z++) {
      for (let x = 0; x < sizeX; x++) {
        if (!solid(x, y, z) || visited[at(x, y, z)] === 1) continue;

        // 1) 沿 X 延伸
        let width = 1;
        while (solid(x + width, y, z) && visited[at(x + width, y, z)] === 0) width += 1;

        // 2) 沿 Z 复制
        let depth = 1;
        outerZ: while (z + depth < sizeZ) {
          for (let dx = 0; dx < width; dx++) {
            if (!solid(x + dx, y, z + depth) || visited[at(x + dx, y, z + depth)] === 1) break outerZ;
          }
          depth += 1;
        }

        // 3) 沿 Y 复制
        let height = 1;
        outerY: while (y + height < sizeY) {
          for (let dz = 0; dz < depth; dz++) {
            for (let dx = 0; dx < width; dx++) {
              if (!solid(x + dx, y + height, z + dz) || visited[at(x + dx, y + height, z + dz)] === 1) {
                break outerY;
              }
            }
          }
          height += 1;
        }

        // 4) 标记
        for (let dy = 0; dy < height; dy++) {
          for (let dz = 0; dz < depth; dz++) {
            for (let dx = 0; dx < width; dx++) {
              visited[at(x + dx, y + dy, z + dz)] = 1;
            }
          }
        }

        boxes.push({
          cx: x + width / 2,
          cy: y + height / 2,
          cz: z + depth / 2,
          hx: width / 2,
          hy: height / 2,
          hz: depth / 2,
        });

        if (boxes.length >= MAX_BOXES_PER_CHUNK) return boxes;
      }
    }
  }

  return boxes;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
