/**
 * 粒子流体 → 可采样场（M4 第二部分 · 第 4 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么需要中间这一层
 * ────────────────────────────────────────────────────────────
 * 耦合系统要问的问题是"这个位置有多少流体、流速多少"（每帧每个物体问 8 次、
 * 每次迭代再问 1 次）。如果直接按"找最近 N 个粒子"来回答，那就是每个物体
 * 每帧几十次邻域查询 —— 而粒子本身可能有两万个。
 *
 * 所以先把粒子**投影到一张粗格子**上（默认 0.5 米一格），耦合只查格子。
 * 这与"表面重建"用的是同一类做法，但目的不同：那边要形状，这边要**密度与动量**。
 *
 * ────────────────────────────────────────────────────────────
 * 三个如实说明
 * ────────────────────────────────────────────────────────────
 * 1. **0.5 米一格是精度与开销的折中**。格子比这个细，大场景的格子数会爆
 *    （48×48×16 米的水面在 0.5 米下是 96×96×32 = 29 万格，已经不小了）；
 *    比这个粗，物体就会"突然整体入水"而不是渐渐没入。
 * 2. **体积分数是"粒子数 / 静止密度下的粒子数"**，不是真实体积分数。
 *    好处是它天然 0~1 且与粒子间距自洽；坏处是"水花飞散的区域"会算成低密度
 *    （那其实是对的），而"水面下薄薄一层"会算成很高（略高估）。
 * 3. **构建是分帧的**：粒子数超过阈值时限流抽样（每 2 个取 1 个）。
 *    抽样会让局部速度估计变糙，但耦合要的是"整体推不推得动"，不是精确流场。
 */

import type { ParticlePool } from './ParticlePool';
import type { FluidConfig } from './FluidPresets';
import { targetSpacing } from './FluidPresets';
import type { FluidField } from '../physics/FluidRigidCoupling';

export interface ParticleFluidFieldOptions {
  /** 格子边长（米） */
  cellSize?: number;
  /** 粒子数超过这个值时抽样建场（每 2 个取 1 个） */
  sampleThreshold?: number;
}

export interface ParticleFluidFieldStats {
  /** 建场用了多少粒子 */
  particles: number;
  /** 网格尺寸 */
  cells: number;
  /** 非空格子数 */
  occupied: number;
  /** 建场耗时（毫秒） */
  ms: number;
  /** 是否做了抽样 */
  sampled: boolean;
}

export class ParticleFluidField implements FluidField {
  private readonly cellSize: number;
  private readonly sampleThreshold: number;
  /** 每格的粒子数 */
  private counts: Int32Array = new Int32Array(0);
  /** 每格的速度累加（除以粒子数得到平均速度） */
  private sumX: Float32Array = new Float32Array(0);
  private sumY: Float32Array = new Float32Array(0);
  private sumZ: Float32Array = new Float32Array(0);
  private dimX = 0;
  private dimY = 0;
  private dimZ = 0;
  private originX = 0;
  private originY = 0;
  private originZ = 0;
  /** 一个格子装满时应该有多少粒子（由静止间距算出）—— fullness 的分母 */
  private particlesPerFullCell = 1;
  /** 流体的物理密度（kg/m³） */
  private physicalDensity = 1000;
  private stats: ParticleFluidFieldStats = { particles: 0, cells: 0, occupied: 0, ms: 0, sampled: false };
  /** 实际使用的格子边长（可能因为格子总数超上限被放大） */
  private cellSizeActual = 0.5;
  /** 流体当前的静止间距（fullness 的分母要用它） */
  private lastSpacing = 0.16;

  constructor(options: ParticleFluidFieldOptions = {}) {
    this.cellSize = options.cellSize ?? 0.5;
    this.sampleThreshold = options.sampleThreshold ?? 8000;
  }

  get fieldStats(): ParticleFluidFieldStats {
    return this.stats;
  }

  /** 把流体预设的"相对密度"换成物理密度（kg/m³）。水 1.0 → 1000 */
  setFluidConfig(config: FluidConfig): void {
    this.physicalDensity = config.restDensity * 1000;
    const spacing = targetSpacing(config);
    // 一个格子装满时有多少粒子：格体积 / 单粒子体积
    this.particlesPerFullCell = Math.max(1, Math.round((this.cellSize ** 3) / (spacing ** 3)));
  }

  /**
   * 从粒子池重建场。
   *
   * 每帧调用一次（在耦合之前）。没有粒子时把 counts 清零并记 0 个格子 ——
   * 不清零的话耦合会读到上一帧的水（物体在空中被"幽灵水"托着）。
   */
  build(pool: ParticlePool): ParticleFluidFieldStats {
    const started = now();
    const count = pool.count;
    if (count === 0) {
      this.counts.fill(0);
      this.dimX = 0;
      this.dimY = 0;
      this.dimZ = 0;
      this.stats = { particles: 0, cells: 0, occupied: 0, ms: now() - started, sampled: false };
      return this.stats;
    }

    // ---- 1) 求包围盒
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
    // 外扩一格：物体可能刚好贴在水边，不扩会让"边缘的物体"完全采不到水
    const pad = this.cellSize;
    this.originX = minX - pad;
    this.originY = minY - pad;
    this.originZ = minZ - pad;
    // 上限：格子总数不超过 40 万（0.5 米下约 48×32×48 米的范围）
    const maxCells = 400000;
    let cell = this.cellSize;
    let dimX = Math.ceil((maxX - minX + pad * 2) / cell) + 1;
    let dimY = Math.ceil((maxY - minY + pad * 2) / cell) + 1;
    let dimZ = Math.ceil((maxZ - minZ + pad * 2) / cell) + 1;
    while (dimX * dimY * dimZ > maxCells) {
      cell *= 1.25;
      dimX = Math.ceil((maxX - minX + pad * 2) / cell) + 1;
      dimY = Math.ceil((maxY - minY + pad * 2) / cell) + 1;
      dimZ = Math.ceil((maxZ - minZ + pad * 2) / cell) + 1;
    }
    const total = dimX * dimY * dimZ;
    if (this.counts.length !== total) {
      this.counts = new Int32Array(total);
      this.sumX = new Float32Array(total);
      this.sumY = new Float32Array(total);
      this.sumZ = new Float32Array(total);
    } else {
      this.counts.fill(0);
      this.sumX.fill(0);
      this.sumY.fill(0);
      this.sumZ.fill(0);
    }
    this.dimX = dimX;
    this.dimY = dimY;
    this.dimZ = dimZ;
    this.cellSizeActual = cell;
    // 格子变大的时候"装满是多少粒子"也跟着变（否则 fullness 会系统性偏低）
    const spacing = this.lastSpacing;
    this.particlesPerFullCell = Math.max(1, Math.round((cell ** 3) / (spacing ** 3)));

    // ---- 2) 把粒子撒进格子（粒子多时限流抽样）
    const stride = count > this.sampleThreshold ? 2 : 1;
    let taken = 0;
    let occupied = 0;
    for (let i = 0; i < high; i += 1) {
      if (pool.alive[i] !== 1) continue;
      taken += 1;
      if (stride > 1 && taken % stride !== 0) continue;
      const ix = Math.floor((pool.posX[i]! - this.originX) / cell);
      const iy = Math.floor((pool.posY[i]! - this.originY) / cell);
      const iz = Math.floor((pool.posZ[i]! - this.originZ) / cell);
      if (ix < 0 || iy < 0 || iz < 0 || ix >= dimX || iy >= dimY || iz >= dimZ) continue;
      const index = ix + iy * dimX + iz * dimX * dimY;
      this.counts[index] += 1;
      this.sumX[index] += pool.velX[i]!;
      this.sumY[index] += pool.velY[i]!;
      this.sumZ[index] += pool.velZ[i]!;
    }
    for (let i = 0; i < total; i += 1) if (this.counts[i]! > 0) occupied += 1;

    this.stats = {
      particles: taken,
      cells: total,
      occupied,
      ms: now() - started,
      sampled: stride > 1,
    };
    return this.stats;
  }

  /** 记住流体的静止间距（fullness 的分母要用） */
  setSpacing(spacing: number): void {
    this.lastSpacing = spacing;
  }

  private indexAt(x: number, y: number, z: number): number {
    const ix = Math.floor((x - this.originX) / this.cellSizeActual);
    const iy = Math.floor((y - this.originY) / this.cellSizeActual);
    const iz = Math.floor((z - this.originZ) / this.cellSizeActual);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.dimX || iy >= this.dimY || iz >= this.dimZ) return -1;
    return ix + iy * this.dimX + iz * this.dimX * this.dimY;
  }

  fullnessAt(x: number, y: number, z: number): number {
    const index = this.indexAt(x, y, z);
    if (index < 0) return 0;
    const count = this.counts[index]!;
    if (count === 0) return 0;
    // 用 sqrt 压一下曲线：粒子少的时候也让"有一点水"能被感觉到，
    // 否则"只有 20% 粒子的一格"会被算成 0.2 的浸没，物体几乎不受力
    const ratio = count / this.particlesPerFullCell;
    return Math.min(1, Math.sqrt(Math.min(1, ratio)));
  }

  velocityAt(x: number, y: number, z: number): { x: number; y: number; z: number } {
    const index = this.indexAt(x, y, z);
    if (index < 0 || this.counts[index] === 0) return ZERO;
    const inv = 1 / this.counts[index]!;
    return { x: this.sumX[index]! * inv, y: this.sumY[index]! * inv, z: this.sumZ[index]! * inv };
  }

  /**
   * 遍历**有流体的格子**（第 5 批的沙水交互要用）。
   *
   * 为什么以"流体格"为驱动、而不是全世界扫沙：沙水交互关心的只是
   * "水在哪里、水边的沙怎么样"。全世界扫一遍沙在大档是 118 万格，
   * 而流体占据的格子数是被粒子上限约束住的（20000 个粒子最多铺满 20000 个格子）。
   *
   * @param fn 回调收到**格子中心的世界坐标**与平均速度
   */
  forEachOccupiedCell(
    fn: (x: number, y: number, z: number, fullness: number, velocity: { x: number; y: number; z: number }) => void,
  ): void {
    if (this.dimX === 0) return;
    const half = this.cellSizeActual / 2;
    for (let iz = 0; iz < this.dimZ; iz += 1) {
      for (let iy = 0; iy < this.dimY; iy += 1) {
        for (let ix = 0; ix < this.dimX; ix += 1) {
          const index = ix + iy * this.dimX + iz * this.dimX * this.dimY;
          const count = this.counts[index]!;
          if (count === 0) continue;
          const x = this.originX + ix * this.cellSizeActual + half;
          const y = this.originY + iy * this.cellSizeActual + half;
          const z = this.originZ + iz * this.cellSizeActual + half;
          const inv = 1 / count;
          const ratio = Math.min(1, count / this.particlesPerFullCell);
          fn(x, y, z, Math.min(1, Math.sqrt(ratio)), {
            x: this.sumX[index]! * inv,
            y: this.sumY[index]! * inv,
            z: this.sumZ[index]! * inv,
          });
        }
      }
    }
  }

  densityAt(x: number, y: number, z: number): number {
    const index = this.indexAt(x, y, z);
    if (index < 0 || this.counts[index] === 0) return 0;
    return this.physicalDensity;
  }
}

const ZERO = { x: 0, y: 0, z: 0 };

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
