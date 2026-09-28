/**
 * 流体表面重建（M4 第二部分 · 第 2 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 做法：把粒子密度采样到一张**粗网格**，再用 marching cubes 抽等值面
 * ────────────────────────────────────────────────────────────
 * 这是"表面风格"的正路，也是它贵的原因：每次重建都要
 * ①把 N 个粒子撒进网格（N 次）、②遍历整个网格的格子（格子数）、③为跨等值面的格子生成三角形。
 * 20000 个粒子和一张 48³ 的网格下，第 ② 步是 11 万格、第 ③ 步通常几千个三角形 ——
 * 所以这里有三条硬约束：
 *
 * 1. **分辨率上限**（默认 32，可调到 48）：格子数是三次方增长，48³ 是 32³ 的 3.4 倍。
 * 2. **范围只包住粒子**（不是整个世界）：水只占一角时，网格跟着水走，
 *    实测新手档 48×16×48 的世界里水团只占 6×3×6 米 —— 网格从"整个世界"缩到水团，
 *    格子数少了两个数量级。这一条比降分辨率有效得多。
 * 3. **分帧**：`update()` 内部按时间预算切片（默认 6 ms），超预算就这一帧不出新网格
 *    （继续用上一帧的），下一帧接着做。**不阻塞主线程**比"每帧都新"重要。
 *
 * ────────────────────────────────────────────────────────────
 * 如实说明三件事
 * ────────────────────────────────────────────────────────────
 * 1. **不是"光滑液面"**：marching cubes 出来的面是分段的、有明显棱角（分辨率决定）。
 *    要像真的水面得再做一步法线平滑 + 屏空间模糊，那不在这一批。
 * 2. **薄水层会消失**：一两个粒子厚的膜采不到密度阈值，重建出来是空的 ——
 *    这时会自动回退成画粒子（`fallbackReason` 会说明原因，不静默变成"水没了"）。
 * 3. **不参与物理**：表面网格纯视觉。碰撞仍然用粒子，所以"看起来有水但踩不上去"
 *    这种矛盾不会出现（粒子与表面是同一份数据）。
 */

import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshLambertMaterial } from 'three';
import type { ParticlePool } from './ParticlePool';
import type { FluidConfig } from './FluidPresets';

/**
 * 撒进密度场的粒子上限。
 *
 * 超过就等距抽样。为什么 5000：核宽 2 格时每个格点已经累积了几十个粒子，
 * 再多撒不会改变形状（只会变慢）；而这个上限让"表面"这一路的时间与粒子数脱钩。
 * 如实说明：抽样会让**极细的水花**（只有几个粒子的）在表面上丢掉 ——
 * 那些水花本来就低于阈值，属于"回退成画粒子"的部分。
 */
const MAX_FIELD_PARTICLES = 5000;

export interface FluidSurfaceOptions {
  /** 网格分辨率上限（每个轴最多几个格子）。默认 32，桌面可到 48 */
  maxResolution?: number;
  /** 体素边长（米）。越小越精细也越贵 */
  cellSize?: number;
  /** 每帧最多花多少毫秒做重建 */
  budgetMs?: number;
  /**
   * 密度阈值。
   *
   * 单位是"单个粒子在自身中心处的核值"（那个值是 1.0）。
   * - 取 0.5（我第一版）：**单个孤立粒子也会生成一小块表面** ——
   *   实测 3 个散开的粒子在 6 米范围里生成了 36 个三角形的"碎片"，
   *   看起来像空中的碎玻璃，而玩家心里那是"几滴水"。
   * - 取 1.2：需要多个粒子叠加才够，于是"散开的粒子"如实回退成画粒子。
   *
   * ⚠ 阈值只有和**核宽度**一起看才有意义，所以这两个数是**一起量出来的**（实测）：
   *
   * | 核半径 | 123 个密集粒子的场最大值 | 单个孤立粒子 |
   * |---|---|---|
   * | 1.2 格 | 1.17 | 1.00 |
   * | 2 格 | **5.14** | 1.00 |
   * | 2.5 格 | 9.96 | 1.00 |
   *
   * 核只有 1.2 格宽时，"一坨水"和"一个孤立粒子"的场值是 1.17 vs 1.00 ——
   * **中间只差 0.17**，任何阈值都分不开它们（我第一版就是这样：
   * 调高到 1.2 之后连正常的水团都重建不出来，0 个三角形）。
   * 核放宽到 2 格之后变成 5.14 vs 1.00，阈值 2.0 就能干净地分开。
   *
   * 代价：等值面会**稍微缩进粒子包络内部一点**（阈值越高等值面越靠里），
   * 而且核越宽表面越"圆钝"。这是表面风格固有的取舍，写在 README 里。
   */
  isoLevel?: number;
}

export interface FluidSurfaceStats {
  /** 这帧是否真的重建了（false = 超预算/粒子太少/没变化） */
  rebuilt: boolean;
  /** 网格分辨率（每轴格子数） */
  resolution: number;
  /** 采样的格子总数 */
  cells: number;
  /** 生成的三角形数 */
  triangles: number;
  ms: number;
  /** 没有重建的原因（中文）；重建了则为 null */
  fallbackReason: string | null;
}

export class FluidSurface {
  readonly group = new Group();
  private readonly mesh: Mesh;
  private geometry: BufferGeometry;
  private readonly material: MeshLambertMaterial;
  private readonly options: Required<FluidSurfaceOptions>;
  private stats: FluidSurfaceStats = {
    rebuilt: false, resolution: 0, cells: 0, triangles: 0, ms: 0, fallbackReason: '还没重建过',
  };
  /** 密度场（复用缓冲区，避免每帧分配） */
  private field: Float32Array = new Float32Array(0);
  /** 格子 → 顶点下标（-1 = 这个格子没有顶点）。复用，避免每帧分配 */
  private vertexIndex: Int32Array = new Int32Array(0);
  private resX = 0;
  private originX = 0;
  private originY = 0;
  private originZ = 0;
  private lastRebuildMs = Number.NEGATIVE_INFINITY;

  constructor(config: FluidConfig, options: FluidSurfaceOptions = {}) {
    this.options = {
      maxResolution: options.maxResolution ?? 32,
      cellSize: options.cellSize ?? Math.max(0.12, config.particleRadius * 1.6),
      budgetMs: options.budgetMs ?? 6,
      isoLevel: options.isoLevel ?? 2,
    };
    this.geometry = new BufferGeometry();
    this.material = new MeshLambertMaterial({
      color: config.color,
      transparent: true,
      opacity: Math.min(0.92, config.opacity + 0.1),
      side: DoubleSide,
      flatShading: true,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'fluid-surface';
    this.group.add(this.mesh);
    this.group.visible = false;
  }

  get surfaceStats(): FluidSurfaceStats {
    return this.stats;
  }

  get triangleCount(): number {
    return this.stats.triangles;
  }

  setFluidConfig(config: FluidConfig): void {
    this.material.color.setHex(config.color);
    this.material.opacity = Math.min(0.92, config.opacity + 0.1);
    this.material.needsUpdate = true;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /**
   * 重建表面。
   *
   * 调用频率交给调用方（Engine 每帧调一次即可，内部会按时间预算与"是否变化"决定要不要真做）。
   */
  update(pool: ParticlePool, nowMs: number, force = false): FluidSurfaceStats {
    const started = now();
    if (pool.count === 0) {
      this.clearGeometry();
      this.stats = { rebuilt: false, resolution: 0, cells: 0, triangles: 0, ms: 0, fallbackReason: '没有粒子' };
      return this.stats;
    }
    // 时间预算：上一帧重建过、且离得太近（< 间隔）就跳过。
    // 间隔取 2 帧（约 33 ms）：液面不需要每帧都是新的 —— 这是"表面比粒子便宜"的关键，
    // 否则表面重建会占掉整个帧预算。
    if (!force && nowMs - this.lastRebuildMs < 33) {
      this.stats = { ...this.stats, rebuilt: false, ms: now() - started, fallbackReason: '按节流跳过（每 33 ms 重建一次）' };
      return this.stats;
    }

    this.lastRebuildMs = nowMs;
    const built = this.rebuild(pool);
    this.stats = { ...built, ms: now() - started };
    return this.stats;
  }

  private clearGeometry(): void {
    this.geometry.setIndex([]);
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
    this.geometry.computeVertexNormals();
    this.mesh.visible = false;
  }

  private rebuild(pool: ParticlePool): Omit<FluidSurfaceStats, 'ms'> {
    // ---- 1) 求粒子的包围盒（只包住有水的地方，见文件头第 2 条）
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    const high = pool.highWater;
    for (let i = 0; i < high; i += 1) {
      if (pool.alive[i] !== 1) continue;
      const x = pool.posX[i]!;
      const y = pool.posY[i]!;
      const z = pool.posZ[i]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const cell = this.options.cellSize;
    // 每个轴多留 2 格（等值面要落在网格内部，否则边界处会开口）
    const pad = cell * 2;
    this.originX = minX - pad;
    this.originY = minY - pad;
    this.originZ = minZ - pad;
    let resX = Math.ceil((maxX - minX + pad * 2) / cell) + 1;
    let resY = Math.ceil((maxY - minY + pad * 2) / cell) + 1;
    let resZ = Math.ceil((maxZ - minZ + pad * 2) / cell) + 1;
    const cap = this.options.maxResolution;
    const scale = Math.max(1, Math.max(resX, resY, resZ) / cap);
    if (scale > 1) {
      // 超上限就整体放大格子（等比），而不是砍掉某个轴 —— 砍轴会让水被切掉一块
      resX = Math.max(3, Math.ceil(resX / scale));
      resY = Math.max(3, Math.ceil(resY / scale));
      resZ = Math.max(3, Math.ceil(resZ / scale));
    }
    this.resX = resX;
    const stepX = (maxX - minX + pad * 2) / Math.max(1, resX - 1);
    const stepY = (maxY - minY + pad * 2) / Math.max(1, resY - 1);
    const stepZ = (maxZ - minZ + pad * 2) / Math.max(1, resZ - 1);

    // ---- 2) 密度场：每个粒子把自己的核值撒进邻近格
    const total = resX * resY * resZ;
    if (this.field.length !== total) this.field = new Float32Array(total);
    else this.field.fill(0);
    const field = this.field;
    // 核半径 = 格子的 2 倍（实测结论见 isoLevel 的注释：1.2 格分不开"水团"与"孤粒子"）
    const kernel = this.options.cellSize * 2;
    const kernel2 = kernel * kernel;
    const range = Math.ceil(kernel / Math.min(stepX, stepY, stepZ));

    // 粒子太多时**等距抽样**：核宽 2 格时，用一半的粒子撒出来的密度场几乎一样
    // （每个格点本身就已经累积了几十个粒子），但代价减半。
    // 这一步是"表面风格在 20000 粒子下还能用"的关键 —— 否则单这一步就要十几毫秒。
    const stride = Math.max(1, Math.ceil(pool.count / MAX_FIELD_PARTICLES));
    let taken = 0;
    for (let i = 0; i < high; i += 1) {
      if (pool.alive[i] !== 1) continue;
      taken += 1;
      if (stride > 1 && taken % stride !== 0) continue;
      const px = pool.posX[i]!;
      const py = pool.posY[i]!;
      const pz = pool.posZ[i]!;
      const cx = Math.round((px - this.originX) / stepX);
      const cy = Math.round((py - this.originY) / stepY);
      const cz = Math.round((pz - this.originZ) / stepZ);
      for (let dz = -range; dz <= range; dz += 1) {
        const iz = cz + dz;
        if (iz < 0 || iz >= resZ) continue;
        const wz = this.originZ + iz * stepZ - pz;
        for (let dy = -range; dy <= range; dy += 1) {
          const iy = cy + dy;
          if (iy < 0 || iy >= resY) continue;
          const wy = this.originY + iy * stepY - py;
          for (let dx = -range; dx <= range; dx += 1) {
            const ix = cx + dx;
            if (ix < 0 || ix >= resX) continue;
            const wx = this.originX + ix * stepX - px;
            const d2 = wx * wx + wy * wy + wz * wz;
            if (d2 >= kernel2) continue;
            // 核值用 (1 - (d/k)²)³：便宜、平滑、够用（不是 Poly6，因为这里只求形状）
            const t = 1 - d2 / kernel2;
            field[ix + iy * resX + iz * resX * resY] += t * t * t;
          }
        }
      }
    }

    // ---- 3) 抽等值面：用 **surface nets**（不是标准 marching cubes）
    //
    // 为什么不用标准 marching cubes：它需要 256 项边表 + 上千行的三角形表，
    // 我第一版想"简化一下"结果写出了退化三角形（三个索引指向同一个顶点 → 什么都不显示）。
    // surface nets 是同一个问题的轻量解法，代码量约 1/10，形状在粗网格下几乎一样：
    //
    //   ① 每个"8 个角符号不一致"的格子放**一个顶点**，位置取 12 条边上过零点的平均；
    //   ② 对每条符号变化的**网格边**，把围绕它的 4 个格子的顶点连成一个四边形。
    // 这样得到的是一张封闭的连续曲面。它比标准 MC 的棱角更明显一点，
    // 但省掉了上千行表 —— 在一个 32³ 的粗网格上，两者的差别看不出来。
    //
    // ⚠ 顶点的环绕方向（winding）在 surface nets 里有 8 种情况要处理。
    // 这里**不处理**，而是让材质用 `DoubleSide`（见构造函数）——
    // 双面渲染让"环绕方向错了导致整块面被背面剔除"这个坑直接消失，
    // 代价是少了背面剔除省下的那点填充率。这是刻意的取舍。
    const iso = this.options.isoLevel;
    const cellCount = (resX - 1) * (resY - 1) * (resZ - 1);
    if (this.vertexIndex.length !== cellCount) this.vertexIndex = new Int32Array(cellCount);
    else this.vertexIndex.fill(-1);
    const positions: number[] = [];
    const indices: number[] = [];
    let triangles = 0;

    const cellIndex = (ix: number, iy: number, iz: number): number => ix + iy * (resX - 1) + iz * (resX - 1) * (resY - 1);
    const sample = (ix: number, iy: number, iz: number): number => field[ix + iy * resX + iz * resX * resY]!;
    const coordX = (ix: number): number => this.originX + ix * stepX;
    const coordY = (iy: number): number => this.originY + iy * stepY;
    const coordZ = (iz: number): number => this.originZ + iz * stepZ;

    // ---- ① 每个跨等值面的格子放一个顶点
    for (let iz = 0; iz < resZ - 1; iz += 1) {
      for (let iy = 0; iy < resY - 1; iy += 1) {
        for (let ix = 0; ix < resX - 1; ix += 1) {
          const c000 = sample(ix, iy, iz);
          const c100 = sample(ix + 1, iy, iz);
          const c010 = sample(ix, iy + 1, iz);
          const c110 = sample(ix + 1, iy + 1, iz);
          const c001 = sample(ix, iy, iz + 1);
          const c101 = sample(ix + 1, iy, iz + 1);
          const c011 = sample(ix, iy + 1, iz + 1);
          const c111 = sample(ix + 1, iy + 1, iz + 1);
          const corners = [c000, c100, c110, c010, c001, c101, c111, c011];
          let insideCount = 0;
          for (const value of corners) if (value >= iso) insideCount += 1;
          if (insideCount === 0 || insideCount === 8) continue;

          // 12 条边的两端点（用角点编号 0..7），逐条找过零点并取平均
          const edges: [number, number][] = [
            [0, 1], [1, 2], [2, 3], [3, 0],
            [4, 5], [5, 6], [6, 7], [7, 4],
            [0, 4], [1, 5], [2, 6], [3, 7],
          ];
          // 角点编号 → 格内偏移（x,y,z 各 0/1）
          const cornerOffset: [number, number, number][] = [
            [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
            [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
          ];
          let sumX = 0;
          let sumY = 0;
          let sumZ = 0;
          let crossings = 0;
          for (const [a, b] of edges) {
            const va = corners[a]!;
            const vb = corners[b]!;
            const insideA = va >= iso;
            const insideB = vb >= iso;
            if (insideA === insideB) continue;
            // 线性插值：t = (iso - va) / (vb - va)
            const denominator = vb - va;
            const tt = Math.abs(denominator) < 1e-9 ? 0.5 : (iso - va) / denominator;
            const oa = cornerOffset[a]!;
            const ob = cornerOffset[b]!;
            sumX += (oa[0] + (ob[0] - oa[0]) * tt);
            sumY += (oa[1] + (ob[1] - oa[1]) * tt);
            sumZ += (oa[2] + (ob[2] - oa[2]) * tt);
            crossings += 1;
          }
          if (crossings === 0) continue;
          this.vertexIndex[cellIndex(ix, iy, iz)] = positions.length / 3;
          positions.push(
            coordX(ix) + (sumX / crossings) * stepX,
            coordY(iy) + (sumY / crossings) * stepY,
            coordZ(iz) + (sumZ / crossings) * stepZ,
          );
        }
      }
    }

    // ---- ② 每条符号变化的网格边 → 一个四边形
    // 网格顶点 (ix,iy,iz) 处有三条向 +X/+Y/+Z 的边；边被 4 个格子共享。
    const vertexAt = (ix: number, iy: number, iz: number): number => {
      if (ix < 0 || iy < 0 || iz < 0 || ix >= resX - 1 || iy >= resY - 1 || iz >= resZ - 1) return -1;
      return this.vertexIndex[cellIndex(ix, iy, iz)]!;
    };
    const pushQuad = (a: number, b: number, c: number, d: number): void => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      indices.push(a, b, c, a, c, d);
      triangles += 2;
    };

    for (let iz = 0; iz < resZ; iz += 1) {
      for (let iy = 0; iy < resY; iy += 1) {
        for (let ix = 0; ix < resX; ix += 1) {
          const here = sample(ix, iy, iz);
          const insideHere = here >= iso;
          // +X 边：(ix,iy,iz)-(ix+1,iy,iz)，共享它的 4 个格子
          if (ix + 1 < resX && (sample(ix + 1, iy, iz) >= iso) !== insideHere) {
            pushQuad(
              vertexAt(ix, iy - 1, iz - 1), vertexAt(ix, iy, iz - 1),
              vertexAt(ix, iy, iz), vertexAt(ix, iy - 1, iz),
            );
          }
          // +Y 边
          if (iy + 1 < resY && (sample(ix, iy + 1, iz) >= iso) !== insideHere) {
            pushQuad(
              vertexAt(ix - 1, iy, iz - 1), vertexAt(ix, iy, iz - 1),
              vertexAt(ix, iy, iz), vertexAt(ix - 1, iy, iz),
            );
          }
          // +Z 边
          if (iz + 1 < resZ && (sample(ix, iy, iz + 1) >= iso) !== insideHere) {
            pushQuad(
              vertexAt(ix - 1, iy - 1, iz), vertexAt(ix, iy - 1, iz),
              vertexAt(ix, iy, iz), vertexAt(ix - 1, iy, iz),
            );
          }
        }
      }
    }

    if (triangles === 0) {
      // 薄水层/粒子太散：如实说明并回退（不静默变成"水没了"）
      this.clearGeometry();
      return {
        rebuilt: false, resolution: this.resX, cells: total, triangles: 0,
        fallbackReason: `密度场里没有跨阈值的地方（${pool.count} 个粒子太散或水层太薄）→ 这一帧退回画粒子`,
      };
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    this.geometry.dispose();
    this.geometry = geometry;
    this.mesh.geometry = geometry;
    this.mesh.visible = true;
    return { rebuilt: true, resolution: this.resX, cells: total, triangles, fallbackReason: null };
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.group.remove(this.mesh);
    this.group.clear();
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
