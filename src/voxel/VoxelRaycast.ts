import { AIR } from '../data/voxelTypes';
import type { VoxelGrid } from './VoxelGrid';

/** 射线拾取结果 */
export interface VoxelHit {
  /** 命中的体素坐标 */
  x: number;
  y: number;
  z: number;
  /** 命中面的法线（指向体素外侧，即朝向射线来向）；用于计算放置位置 */
  nx: number;
  ny: number;
  nz: number;
  /** 射线走过的距离（米） */
  distance: number;
  /** 命中点的世界坐标（米） */
  pointX: number;
  pointY: number;
  pointZ: number;
}

/** 单次遍历的最大步数（世界对角线约 190 米，留足余量） */
const MAX_STEPS = 1024;

/**
 * DDA 体素射线遍历（Amanatides & Woo 算法）。
 *
 * 为什么不用 THREE.Raycaster 打合并网格：
 * 1. 合并网格的三角形没有"体素坐标"，命中后还要反算，且水面/玻璃等内部面已剔除；
 * 2. Raycaster 对 10 万级三角形的区块网格开销与分配都很大；
 * 3. DDA 逐格步进是 O(步数)，与体素总数无关，而且天然返回"是哪个格子、从哪个面进入"，
 *    这正是笔刷落点与放置位置需要的信息。
 *
 * 用法：只用 THREE.Raycaster 求射线方向（处理透视投影），求交仍走这里。
 */
export function raycastVoxels(
  grid: VoxelGrid,
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  maxDistance: number,
): VoxelHit | null {
  const length = Math.hypot(dirX, dirY, dirZ);
  if (length < 1e-9) return null;
  const dx = dirX / length;
  const dy = dirY / length;
  const dz = dirZ / length;

  // 转到"体素空间"的连续坐标（x/z 平移到 0..size，y 不变）
  const px = originX + grid.halfX;
  const py = originY;
  const pz = originZ + grid.halfZ;

  let vx = Math.floor(px);
  let vy = Math.floor(py);
  let vz = Math.floor(pz);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const absDz = Math.abs(dz);

  const tDeltaX = absDx < 1e-9 ? Infinity : 1 / absDx;
  const tDeltaY = absDy < 1e-9 ? Infinity : 1 / absDy;
  const tDeltaZ = absDz < 1e-9 ? Infinity : 1 / absDz;

  let tMaxX = absDx < 1e-9 ? Infinity : (stepX > 0 ? vx + 1 - px : px - vx) / absDx;
  let tMaxY = absDy < 1e-9 ? Infinity : (stepY > 0 ? vy + 1 - py : py - vy) / absDy;
  let tMaxZ = absDz < 1e-9 ? Infinity : (stepZ > 0 ? vz + 1 - pz : pz - vz) / absDz;

  let normalX = 0;
  let normalY = 0;
  let normalZ = 0;
  let t = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (t > maxDistance) break;

    if (vx >= 0 && vx < grid.sizeX && vy >= 0 && vy < grid.sizeY && vz >= 0 && vz < grid.sizeZ) {
      if (grid.getVoxel(vx, vy, vz) !== AIR) {
        return {
          x: vx,
          y: vy,
          z: vz,
          nx: normalX,
          ny: normalY,
          nz: normalZ,
          distance: t,
          pointX: originX + dx * t,
          pointY: originY + dy * t,
          pointZ: originZ + dz * t,
        };
      }
    }
    // 注意：这里**不能**因为"当前格在世界外"就 break。
    // 相机常常在世界上方 / 世界外侧（例如 y = 40 而世界高度只有 32），
    // 射线需要先跨过这段"界外空间"才能进入世界。
    // 退出条件只由 maxDistance 与 MAX_STEPS 负责。

    // 沿三个轴里最先到达边界的那个方向步进
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      vx += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      normalX = -stepX;
      normalY = 0;
      normalZ = 0;
    } else if (tMaxY <= tMaxZ) {
      vy += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      normalX = 0;
      normalY = -stepY;
      normalZ = 0;
    } else {
      vz += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      normalX = 0;
      normalY = 0;
      normalZ = -stepZ;
    }
  }

  return null;
}

/**
 * 由命中点 + 面法线算出"放置位置"（命中体素外侧相邻格）。
 * 供 M2 的建筑放置与"右键擦除后填补"使用。
 */
export function placementPosition(hit: VoxelHit): [number, number, number] {
  return [hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz];
}
