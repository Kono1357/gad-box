import { BufferAttribute, BufferGeometry } from 'three';
import { AIR, getVoxelDef, isLiquid, isOpaque } from '../data/voxelTypes';
import type { Chunk } from './Chunk';
import { CHUNK_SIZE } from './Chunk';
import type { VoxelGrid } from './VoxelGrid';
import { FACE_BOTTOM, FACE_SIDE, FACE_TOP, VoxelAtlas } from './VoxelMaterials';

/**
 * 六个面方向的模板。
 *
 * 角点顺序保证从面外侧看是逆时针（CCW），法线由叉积验证过。
 * `uAxis` / `vAxis` 指定这块面用哪两个世界轴做贴图坐标，
 * 每块贴图的 UV 按 角0→(u0,v0)、角1→(u1,v0)、角2→(u1,v1)、角3→(u0,v1) 分配，
 * 于是"贴图的上方"永远对齐世界的 +Y —— 草沿、砖缝、木纹才不会倒过来。
 */
interface FaceTemplate {
  normal: readonly [number, number, number];
  corners: readonly (readonly [number, number, number])[];
  /** 亮度系数（低多边形风格靠面朝向的明暗差出体积感） */
  shade: number;
  /** 写入图集时的面种类 */
  faceKind: number;
  /** 用于 UV 的两个轴：0=X, 1=Y, 2=Z */
  uAxis: 0 | 1 | 2;
  vAxis: 0 | 1 | 2;
}

const FACES: readonly FaceTemplate[] = [
  {
    normal: [1, 0, 0],
    corners: [
      [1, 0, 1],
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
    ],
    shade: 0.86,
    faceKind: FACE_SIDE,
    uAxis: 2,
    vAxis: 1,
  },
  {
    normal: [-1, 0, 0],
    corners: [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
    shade: 0.86,
    faceKind: FACE_SIDE,
    uAxis: 2,
    vAxis: 1,
  },
  {
    normal: [0, 1, 0],
    corners: [
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
    shade: 1.0,
    faceKind: FACE_TOP,
    uAxis: 0,
    vAxis: 2,
  },
  {
    normal: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    shade: 0.6,
    faceKind: FACE_BOTTOM,
    uAxis: 0,
    vAxis: 2,
  },
  {
    normal: [0, 0, 1],
    corners: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    shade: 0.94,
    faceKind: FACE_SIDE,
    uAxis: 0,
    vAxis: 1,
  },
  {
    normal: [0, 0, -1],
    corners: [
      [1, 0, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
    shade: 0.72,
    faceKind: FACE_SIDE,
    uAxis: 0,
    vAxis: 1,
  },
];

/** 每个面的 6 个索引（两个三角形），复用 4 个顶点 */
const FACE_INDICES = [0, 1, 2, 0, 2, 3] as const;

/** 8 档环境光遮蔽亮度：0 = 被完全遮挡，3 = 完全开阔 */
const AO_LEVELS = [0.58, 0.72, 0.86, 1.0] as const;

/** 填充数组的水平边长：16 + 两侧各 1 格 */
const PAD_W = CHUNK_SIZE + 2;
const PAD_AREA = PAD_W * PAD_W;

/** 单个面的临时数据 */
interface MeshBuilder {
  positions: number[];
  normals: number[];
  colors: number[];
  uvs: number[];
  indices: number[];
  faces: number;
}

function createBuilder(): MeshBuilder {
  return { positions: [], normals: [], colors: [], uvs: [], indices: [], faces: 0 };
}

export interface ChunkMeshResult {
  opaque: BufferGeometry | null;
  transparent: BufferGeometry | null;
  opaqueFaces: number;
  transparentFaces: number;
  /** 构建耗时（毫秒），调试面板用 */
  ms: number;
}

/**
 * 区块网格构建器。
 *
 * M1.5 的三个关键改动：
 *
 * 1. **填充式邻居缓存**：先把区块连同一圈邻居拷进一个 18 × sizeY × 18 的数组，
 *    之后所有邻居查询都是纯数组下标访问，不再反复做"体素坐标 → 区块 → 下标"的除法。
 *    这是把半径 16 的笔刷延迟压到 50 ms 以内的主要手段之一。
 * 2. **UV 图集**：所有贴图在一张图集里，所以一个区块仍然只有一次 draw call。
 * 3. **不透明 / 半透明分离**：水和玻璃走第二个几何体 + 半透明材质，
 *    这样水面才有透明感（也意味着含水区块是 2 次 draw call）。
 */
export class ChunkMesher {
  private readonly opaque = createBuilder();
  private readonly transparent = createBuilder();

  /** 填充缓存：体素类型 */
  private pad = new Uint8Array(0);
  /** 填充缓存：水量 0~1 */
  private padWater = new Float32Array(0);

  lastMs = 0;
  /** 是否烘焙环境光遮蔽（关掉可以省一点重建时间，但地形会变平） */
  aoEnabled = true;

  constructor(
    private readonly grid: VoxelGrid,
    private readonly atlas: VoxelAtlas,
  ) {}

  /**
   * 为区块生成几何体。
   * @returns 不透明与半透明两个几何体（没有可见面时为 null）
   */
  build(chunk: Chunk): ChunkMeshResult {
    const started = performance.now();

    this.fillPad(chunk);

    const o = this.opaque;
    const t = this.transparent;
    o.positions.length = 0;
    o.normals.length = 0;
    o.colors.length = 0;
    o.uvs.length = 0;
    o.indices.length = 0;
    o.faces = 0;
    t.positions.length = 0;
    t.normals.length = 0;
    t.colors.length = 0;
    t.uvs.length = 0;
    t.indices.length = 0;
    t.faces = 0;

    const grid = this.grid;
    const sizeY = grid.sizeY;
    const ox = chunk.originX;
    const oz = chunk.originZ;
    const hasWater = this.padHasWater;

    for (let y = 0; y < sizeY; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const id = this.pad[this.padIndex(x, y, z)]!;
          if (id === AIR) continue;

          const def = getVoxelDef(id);
          const liquid = def.liquid === true;
          const level = liquid ? this.padWater[this.padIndex(x, y, z)]! : 1;
          if (liquid && level <= 0.001) continue;

          const builder = def.opaque ? o : t;
          const rect = this.atlas.uvRect(id, FACE_SIDE);
          void rect;

          const worldX = ox + x;
          const worldZ = oz + z;

          for (let f = 0; f < 6; f++) {
            const face = FACES[f]!;
            const n = face.normal;
            const nx = x + n[0]!;
            const ny = y + n[1]!;
            const nz = z + n[2]!;

            const neighbor = ny < 0 ? this.pad[this.padIndex(x, 0, z)]! : ny >= sizeY ? AIR : this.pad[this.padIndex(nx, ny, nz)]!;
            const neighborLiquid = isLiquid(neighbor);

            let lowY = 0;
            if (isOpaque(neighbor)) continue;

            if (neighborLiquid) {
              const neighborLevel = ny < 0 || ny >= sizeY ? 0 : this.padWater[this.padIndex(nx, ny, nz)]!;
              if (f === 2) {
                // 顶面：上面还有水就藏起来
                if (neighborLevel >= level - 0.01) continue;
              } else if (f === 3) {
                continue; // 水面之间不需要底面
              } else if (Math.abs(neighborLevel - level) < 0.02) {
                continue; // 水位相同 → 内部面
              } else {
                // 只画露出水面的那一条
                lowY = Math.min(level, neighborLevel);
              }
            } else if (liquid && f === 2) {
              // 水顶面：上面是空气 → 按水位画
            } else if (!liquid && neighbor === id) {
              continue; // 同种实心块接缝不画
            }

            if (f === 3) {
              // 底面永远在格子底部
            } else if (f === 2) {
              // 顶面整体抬到水位高度（实心块 level = 1）
            }

            const highY = level;
            if (f !== 2 && f !== 3 && highY - lowY < 0.02) continue;

            const uv = this.atlas.uvRect(id, face.faceKind);
            const base = builder.positions.length / 3;

            // 角点 → UV 的固定映射：0→(u0,v0) 1→(u1,v0) 2→(u1,v1) 3→(u0,v1)
            const uvCorners: readonly (readonly [number, number])[] = [
              [uv.u0, uv.v0],
              [uv.u1, uv.v0],
              [uv.u1, uv.v1],
              [uv.u0, uv.v1],
            ];

            for (let c = 0; c < 4; c++) {
              const corner = face.corners[c]!;

              let cornerY: number;
              if (f === 2) cornerY = y + highY;
              else if (f === 3) cornerY = y;
              else cornerY = y + (corner[1] === 1 ? highY : lowY);

              builder.positions.push(
                worldX - grid.halfX + corner[0]!,
                cornerY,
                worldZ - grid.halfZ + corner[2]!,
              );

              // 顶点色 = 明暗 × AO（贴图负责图案，顶点色负责层次）
              const ao = this.computeAo(x, y, z, face, corner);
              const light = face.shade * ao;
              builder.colors.push(light, light, light);
              builder.uvs.push(uvCorners[c]![0], uvCorners[c]![1]);
            }

            for (let i = 0; i < 3; i++) builder.normals.push(n[0]!, n[1]!, n[2]!);
            for (let i = 0; i < 3; i++) builder.normals.push(n[0]!, n[1]!, n[2]!);

            for (const offset of FACE_INDICES) builder.indices.push(base + offset);
            builder.faces++;
          }
        }
      }
    }

    void hasWater;

    chunk.faceCount = o.faces;
    chunk.transparentFaceCount = t.faces;

    this.lastMs = performance.now() - started;
    return {
      opaque: this.toGeometry(o),
      transparent: this.toGeometry(t),
      opaqueFaces: o.faces,
      transparentFaces: t.faces,
      ms: this.lastMs,
    };
  }

  // ------------------------------------------------------------------ 内部

  private padIndex(x: number, y: number, z: number): number {
    return (y * PAD_W + (z + 1)) * PAD_W + (x + 1);
  }

  private padHasWater = false;

  /**
   * 把区块及其四周一圈邻居拷进填充数组。
   * 这样后面 6 个方向的邻居查询都是 O(1) 数组访问。
   */
  private fillPad(chunk: Chunk): void {
    const grid = this.grid;
    const sizeY = grid.sizeY;
    const needed = sizeY * PAD_AREA;
    if (this.pad.length < needed) {
      this.pad = new Uint8Array(needed);
      this.padWater = new Float32Array(needed);
    }

    const hasWater = chunk.hasWater();
    this.padHasWater = hasWater;

    for (let z = -1; z <= CHUNK_SIZE; z++) {
      const wz = chunk.originZ + z;
      for (let x = -1; x <= CHUNK_SIZE; x++) {
        const wx = chunk.originX + x;
        const baseIndex = (z + 1) * PAD_W + (x + 1);
        if (hasWater) {
          for (let y = 0; y < sizeY; y++) {
            const idx = y * PAD_AREA + baseIndex;
            const id = grid.getVoxel(wx, y, wz);
            this.pad[idx] = id;
            this.padWater[idx] = isLiquid(id) ? grid.getWaterLevel(wx, y, wz) : 0;
          }
        } else {
          for (let y = 0; y < sizeY; y++) {
            const idx = y * PAD_AREA + baseIndex;
            const id = grid.getVoxel(wx, y, wz);
            this.pad[idx] = id;
            this.padWater[idx] = 0;
          }
        }
      }
    }
  }

  /**
   * 顶点级环境光遮蔽。
   *
   * 对每个面角点，检查紧贴该角点的 3 个邻居（两个侧邻 + 一个对角邻），
   * 按经典 voxel AO 公式得到 0~3 的遮挡等级。
   * 这比真正的 SSAO 便宜得多，而且对"方块堆叠"这种几何体效果正好。
   */
  private computeAo(
    x: number,
    y: number,
    z: number,
    face: FaceTemplate,
    corner: readonly [number, number, number],
  ): number {
    if (!this.aoEnabled) return 1;
    const n = face.normal;
    const fx = x + n[0]!;
    const fy = y + n[1]!;
    const fz = z + n[2]!;

    const axes: readonly (0 | 1 | 2)[] = [0, 1, 2];
    const u = axes[face.uAxis]!;
    const v = axes[face.vAxis]!;

    // 角点在 U / V 轴上的方向（0 → -1，1 → +1）
    let su = corner[u] === 1 ? 1 : -1;
    let sv = corner[v] === 1 ? 1 : -1;
    // 面的法线轴上的角点坐标恒为 0 或 1，与遮挡无关，这里统一归零
    su = Number.isFinite(su) ? su : 1;
    sv = Number.isFinite(sv) ? sv : 1;

    const side1 = this.occluded(fx, fy, fz, u, su);
    const side2 = this.occluded(fx, fy, fz, v, sv);
    const cornerOccluded = this.occluded2(fx, fy, fz, u, su, v, sv);

    const level = side1 && side2 ? 0 : 3 - (side1 + side2 + cornerOccluded);
    return AO_LEVELS[level]!;
  }

  /** 检查"从基准格沿某个轴偏移"的邻居是否遮挡光线 */
  private occluded(
    x: number,
    y: number,
    z: number,
    axis: 0 | 1 | 2,
    sign: number,
  ): number {
    const nx = x + (axis === 0 ? sign : 0);
    const ny = y + (axis === 1 ? sign : 0);
    const nz = z + (axis === 2 ? sign : 0);
    return this.sampleOpaque(nx, ny, nz);
  }

  /** 对角邻居 */
  private occluded2(
    x: number,
    y: number,
    z: number,
    uAxis: 0 | 1 | 2,
    su: number,
    vAxis: 0 | 1 | 2,
    sv: number,
  ): number {
    const nx = x + (uAxis === 0 ? su : 0) + (vAxis === 0 ? sv : 0);
    const ny = y + (uAxis === 1 ? su : 0) + (vAxis === 1 ? sv : 0);
    const nz = z + (uAxis === 2 ? su : 0) + (vAxis === 2 ? sv : 0);
    return this.sampleOpaque(nx, ny, nz);
  }

  /** 从填充数组读"是否遮挡"；越界按空气处理（世界外面不遮挡） */
  private sampleOpaque(x: number, y: number, z: number): number {
    if (y < 0) return 1; // 世界底下视为实心，底面的 AO 才合理
    if (y >= this.grid.sizeY) return 0;
    if (x < -1 || x > CHUNK_SIZE || z < -1 || z > CHUNK_SIZE) return 0;
    return isOpaque(this.pad[this.padIndex(x, y, z)]!) ? 1 : 0;
  }

  private toGeometry(builder: MeshBuilder): BufferGeometry | null {
    if (builder.faces === 0) return null;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(builder.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(builder.normals), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(builder.colors), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(builder.uvs), 2));
    geometry.setIndex(new BufferAttribute(new Uint32Array(builder.indices), 1));
    geometry.computeBoundingSphere();
    return geometry;
  }
}
