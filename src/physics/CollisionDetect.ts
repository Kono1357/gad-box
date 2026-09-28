import type { BuildingDef, BuildingInstance } from '../building/types';

/**
 * 轴对齐包围盒。堆叠、接触面积、支撑判定全部基于它。
 *
 * 为什么这一轮刻意**不用 Rapier 做堆叠判定**：
 * 1. **暂停时 Rapier 的查询管线不更新**（它只在 `world.step()` 里刷新），
 *    于是暂停中连点会把一堆物体放成同一个坐标 —— 这正是"多个物体重合成一个"的根因；
 * 2. AABB 计算是纯数学，不依赖物理是否就绪，**物理 wasm 还没加载完也能正确堆叠**；
 * 3. 便宜：200 个物体的两两比较是微秒级，而每次形状查询都要过一遍宽相位
 *    （上一轮实测：智能放置 31.8 ms，其中大头就是物理查询）。
 *
 * 代价是旋转后的物体用"旋转后的水平外接矩形"近似，不是真实的凸包相交。
 * 对积木式的沙盘够用了，而且**偏向保守**（外接矩形只会让它更容易判定为重叠）。
 */
export interface Aabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** 由实例算出 AABB（考虑 rotationY 与 scale） */
export function aabbOfInstance(instance: BuildingInstance): Aabb {
  const size = instance.size ?? [1, 1, 1];
  const scale = instance.scale ?? 1;
  const halfW = (size[0] * scale) / 2;
  const halfD = (size[2] * scale) / 2;
  const cos = Math.abs(Math.cos(instance.rotationY));
  const sin = Math.abs(Math.sin(instance.rotationY));
  const extentX = halfW * cos + halfD * sin;
  const extentZ = halfW * sin + halfD * cos;
  return {
    minX: instance.position[0] - extentX,
    maxX: instance.position[0] + extentX,
    minY: instance.position[1],
    maxY: instance.position[1] + size[1] * scale,
    minZ: instance.position[2] - extentZ,
    maxZ: instance.position[2] + extentZ,
  };
}

/** 由模型定义 + 拟放置位姿算出 AABB（还没落地的物体用这个） */
export function aabbOfDef(
  def: BuildingDef,
  position: [number, number, number],
  rotationY: number,
  scale = 1,
): Aabb {
  const halfW = (def.size[0] * scale) / 2;
  const halfD = (def.size[2] * scale) / 2;
  const cos = Math.abs(Math.cos(rotationY));
  const sin = Math.abs(Math.sin(rotationY));
  const extentX = halfW * cos + halfD * sin;
  const extentZ = halfW * sin + halfD * cos;
  return {
    minX: position[0] - extentX,
    maxX: position[0] + extentX,
    minY: position[1],
    maxY: position[1] + def.size[1] * scale,
    minZ: position[2] - extentZ,
    maxZ: position[2] + extentZ,
  };
}

/** 各轴上的重叠长度（负数表示分离） */
export function aabbAxisOverlap(a: Aabb, b: Aabb): { x: number; y: number; z: number } {
  return {
    x: Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX),
    y: Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY),
    z: Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ),
  };
}

/** XZ 平面上的重叠面积（平方米）。不重叠返回 0 */
export function horizontalOverlapArea(a: Aabb, b: Aabb): number {
  const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  if (ox <= 0 || oz <= 0) return 0;
  return ox * oz;
}

/** XZ 平面上的重叠矩形（供支撑面可视化画出来） */
export function horizontalOverlapRect(
  a: Aabb,
  b: Aabb,
): { minX: number; maxX: number; minZ: number; maxZ: number; area: number } | null {
  const minX = Math.max(a.minX, b.minX);
  const maxX = Math.min(a.maxX, b.maxX);
  const minZ = Math.max(a.minZ, b.minZ);
  const maxZ = Math.min(a.maxZ, b.maxZ);
  if (maxX <= minX || maxZ <= minZ) return null;
  return { minX, maxX, minZ, maxZ, area: (maxX - minX) * (maxZ - minZ) };
}

/** 底面面积（XZ） */
export function footprintArea(box: Aabb): number {
  return Math.max(0, (box.maxX - box.minX) * (box.maxZ - box.minZ));
}

/** 三维重叠体积（用于判断"真的穿模了"） */
export function overlapVolume(a: Aabb, b: Aabb): number {
  const o = aabbAxisOverlap(a, b);
  if (o.x <= 0 || o.y <= 0 || o.z <= 0) return 0;
  return o.x * o.y * o.z;
}

/**
 * 两个盒子是否"实体相交"。
 * 容差是刻意留的：物体刚好贴合（比如叠罗汉时底面贴着顶面）不应该算相交，
 * 否则每次堆叠都会被自己脚下的物体挡住。
 */
export const TOUCH_TOLERANCE = 0.012;

export function intersects(a: Aabb, b: Aabb, tolerance = TOUCH_TOLERANCE): boolean {
  const o = aabbAxisOverlap(a, b);
  return o.x > tolerance && o.y > tolerance && o.z > tolerance;
}

/**
 * 新物体的底面与某个支撑顶面的接触面积。
 *
 * 定义：新物体底面矩形 ∩ 支撑物顶面矩形 的面积。
 * @param bottomBox 新物体的 AABB（用它的 XZ 范围）
 * @param supportBox 支撑物的 AABB（用它的 XZ 范围）
 * @param supportTopY 支撑面的高度（用于判断垂直方向是否真的贴上）
 * @param bottomY 新物体底面高度
 */
export function contactAreaWithTop(
  bottomBox: Aabb,
  supportBox: Aabb,
  supportTopY: number,
  bottomY: number,
  verticalTolerance = 0.08,
): number {
  // 垂直方向必须真的贴上（否则不是"放在上面"，而是悬在半空）
  if (Math.abs(bottomY - supportTopY) > verticalTolerance) return 0;
  return horizontalOverlapArea(bottomBox, supportBox);
}

/**
 * 重心余量：物体重心到"被支撑区域"边缘的最小水平距离。
 * 负数表示重心已经悬在支撑范围之外 —— 现实里会翻。
 *
 * 这里用的是新物体中心到"接触区矩形"四边的距离，
 * 是一个**保守的近似**（真实倾倒还要看转动惯量与接触点分布）。
 */
export function centerMarginToSupport(
  centerX: number,
  centerZ: number,
  contact: { minX: number; maxX: number; minZ: number; maxZ: number },
): number {
  return Math.min(
    centerX - contact.minX,
    contact.maxX - centerX,
    centerZ - contact.minZ,
    contact.maxZ - centerZ,
  );
}

/** 把一个 AABB 扩大一点（用于"允许贴合"的预检） */
export function expandAabb(box: Aabb, amount: number): Aabb {
  return {
    minX: box.minX - amount,
    maxX: box.maxX + amount,
    minY: box.minY - amount,
    maxY: box.maxY + amount,
    minZ: box.minZ - amount,
    maxZ: box.maxZ + amount,
  };
}

/** AABB 的中心 */
export function aabbCenter(box: Aabb): [number, number, number] {
  return [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2];
}

/** 两个 AABB 在水平方向上的间隙（0 表示相接或重叠） */
export function horizontalGap(a: Aabb, b: Aabb): number {
  const gapX = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
  const gapZ = Math.max(0, Math.max(a.minZ - b.maxZ, b.minZ - a.maxZ));
  return Math.hypot(gapX, gapZ);
}
