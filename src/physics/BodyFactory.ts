import type { BuildingDef, BuildingPart } from '../building/types';
import type { ColliderSpec } from './PhysicsWorld';

/** 小于这个尺寸的 part 不生成碰撞体（省碰撞体数量） */
const MIN_EXTENT = 0.035;

export interface BodyGeometry {
  /** 复合碰撞体（相对刚体原点，也就是建筑的底面中心） */
  colliders: ColliderSpec[];
  /** 整体包围盒半长，用于快速的放置重叠预检 */
  halfExtents: [number, number, number];
  /** 包围盒中心相对原点的偏移 */
  center: [number, number, number];
}

/**
 * 把欧拉角转成 3×3 旋转矩阵（行主序，只用于算包围盒）
 */
function eulerMatrix(part: BuildingPart): number[] {
  const cx = Math.cos(part.rotationX ?? 0);
  const sx = Math.sin(part.rotationX ?? 0);
  const cy = Math.cos(part.rotationY ?? 0);
  const sy = Math.sin(part.rotationY ?? 0);
  const cz = Math.cos(part.rotationZ ?? 0);
  const sz = Math.sin(part.rotationZ ?? 0);

  // R = Rz * Ry * Rx（与 three 的 Euler 'XYZ' 顺序一致）
  return [
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,
    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,
    -sy,
    cy * sx,
    cy * cx,
  ];
}

/**
 * 算出一个 part 旋转之后的轴对齐包围盒半长。
 *
 * 为什么必须算旋转：汽车/自行车的轮子、传送带的滚筒在数据里用了
 * `rotationX = π/2` 把圆柱放倒 —— 如果忽略旋转，碰撞体会是一个立着的薄圆盘，
 * 车就会浮在半空。
 */
function rotatedHalfExtents(part: BuildingPart): [number, number, number] {
  const hx = part.size[0] / 2;
  const hy = part.size[1] / 2;
  const hz = part.size[2] / 2;
  const hasRotation = Boolean(part.rotationX || part.rotationY || part.rotationZ);
  if (!hasRotation) return [hx, hy, hz];

  const m = eulerMatrix(part);
  return [
    Math.abs(m[0]!) * hx + Math.abs(m[1]!) * hy + Math.abs(m[2]!) * hz,
    Math.abs(m[3]!) * hx + Math.abs(m[4]!) * hy + Math.abs(m[5]!) * hz,
    Math.abs(m[6]!) * hx + Math.abs(m[7]!) * hy + Math.abs(m[8]!) * hz,
  ];
}

/**
 * 由建筑模型生成碰撞体。
 *
 * 形状策略：
 * - `box` → 长方体（最稳，Rapier 对长方体接触求解最可靠）；
 * - 未倾斜的 `cylinder` / `sphere` → 用真的圆柱 / 球（滚起来才像样）；
 * - 倾斜过的任何形状、以及 `cone` → 退化成它的**轴对齐包围盒**。
 *
 * 为什么不一律用凸包：凸包接触生成更贵，而且在堆叠时更容易抖动；
 * 而低多边形积木风格里，长方体近似在视觉上也看不出破绽。
 */
export function buildBodyGeometry(def: BuildingDef): BodyGeometry {
  const colliders: ColliderSpec[] = [];

  for (const part of def.parts) {
    const [sx, sy, sz] = part.size;
    if (sx < MIN_EXTENT || sy < MIN_EXTENT || sz < MIN_EXTENT) continue;

    const tilted = Boolean(part.rotationX || part.rotationZ);

    if (part.shape === 'cylinder' && !tilted) {
      colliders.push({
        kind: 'cylinder',
        position: [...part.position] as [number, number, number],
        halfExtents: [sx / 2, sy / 2, sz / 2],
        radius: sx / 2,
        halfHeight: sy / 2,
      });
      continue;
    }

    if (part.shape === 'sphere' && !tilted) {
      colliders.push({
        kind: 'sphere',
        position: [...part.position] as [number, number, number],
        halfExtents: [sx / 2, sy / 2, sz / 2],
        radius: sx / 2,
        halfHeight: sy / 2,
      });
      continue;
    }

    const extents = rotatedHalfExtents(part);
    colliders.push({
      kind: 'box',
      position: [...part.position] as [number, number, number],
      halfExtents: extents,
      radius: 0,
      halfHeight: 0,
    });
  }

  // 兜底：所有 part 都太小，就用整体包围盒，保证"有碰撞体积"
  if (colliders.length === 0) {
    colliders.push({
      kind: 'box',
      position: [0, def.size[1] / 2, 0],
      halfExtents: [def.size[0] / 2, Math.max(0.05, def.size[1] / 2), def.size[2] / 2],
      radius: 0,
      halfHeight: 0,
    });
  }

  return { colliders, ...overallBounds(colliders) };
}

/** 由碰撞体列表算出整体包围盒（相对建筑原点） */
function overallBounds(colliders: readonly ColliderSpec[]): {
  halfExtents: [number, number, number];
  center: [number, number, number];
} {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const collider of colliders) {
    const [hx, hy, hz] =
      collider.kind === 'cylinder' || collider.kind === 'sphere'
        ? collider.kind === 'cylinder'
          ? [collider.radius, collider.halfHeight, collider.radius]
          : [collider.radius, collider.radius, collider.radius]
        : collider.halfExtents;
    const [px, py, pz] = collider.position;
    minX = Math.min(minX, px - hx);
    maxX = Math.max(maxX, px + hx);
    minY = Math.min(minY, py - hy);
    maxY = Math.max(maxY, py + hy);
    minZ = Math.min(minZ, pz - hz);
    maxZ = Math.max(maxZ, pz + hz);
  }

  if (!Number.isFinite(minX)) {
    return { halfExtents: [0.5, 0.5, 0.5], center: [0, 0.5, 0] };
  }

  return {
    halfExtents: [(maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };
}

/**
 * 放置预检用的探测盒。
 *
 * 和碰撞体不同，这个盒子**总是轴对齐且贴着底面**，
 * 因为放置检查关心的是"这块体积能不能塞进去"，
 * 而不是"支腿之间有没有缝"。
 * 缩进一点点（-2%）是为了让"刚好贴合"的堆叠不被误判成重叠。
 */
export function buildProbeBox(def: BuildingDef, rotationY: number): {
  halfExtents: [number, number, number];
  center: [number, number, number];
} {
  const cos = Math.abs(Math.cos(rotationY));
  const sin = Math.abs(Math.sin(rotationY));
  const halfX = (def.size[0] * cos + def.size[2] * sin) / 2;
  const halfZ = (def.size[0] * sin + def.size[2] * cos) / 2;
  const halfY = def.size[1] / 2;
  const shrink = 0.98;
  return {
    halfExtents: [halfX * shrink, halfY * shrink, halfZ * shrink],
    center: [0, halfY, 0],
  };
}
