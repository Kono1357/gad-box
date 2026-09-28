import type { BuildingDef, BuildingInstance } from '../building/types';

/** 吸附点类型 */
export type AnchorKind = 'top' | 'bottom' | 'side' | 'corner';

/** 一个吸附锚点（局部坐标 + 朝外的法线） */
export interface SnapAnchor {
  /** 相对建筑原点（底面中心）的局部位置 */
  local: [number, number, number];
  /** 朝外的法线 */
  normal: [number, number, number];
  kind: AnchorKind;
}

/** 一次锚点匹配结果 */
export interface AnchorMatch {
  /** 采纳这个匹配后，物体的底面中心应该在哪 */
  position: [number, number, number];
  /** 建议的绕 Y 旋转 */
  rotationY: number;
  /** 匹配得分，越高越好 */
  score: number;
  /** 给出这个匹配的目标物体 */
  target: BuildingInstance;
  /** 给玩家看的说明 */
  label: string;
}

/** 四个水平方向在世界里的向量（局部 → 世界，按 rotationY 旋转） */
const SIDE_NORMALS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** 把局部方向按 rotationY 转到世界 */
export function rotateY(x: number, z: number, rotationY: number): [number, number] {
  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);
  return [x * cos + z * sin, -x * sin + z * cos];
}

/**
 * 吸附点推导与匹配。
 *
 * **不手写每个模型的锚点，而是从包围盒推**：77 个模型逐个手写锚点既容易漏也难维护，
 * 而包围盒能推出 10 个够用的锚点（底面中心、顶面中心、四个底面角、四个侧面中心）。
 *
 * 匹配规则只有两条，却覆盖了绝大多数搭建场景：
 * 1. **顶面接底面** —— 被放置物体的底面落到目标顶面中心，这就是"堆叠"；
 * 2. **侧面接侧面** —— 两块墙贴在一起，这就是"拼接"。
 *
 * 刻意不做"角对角"之类的花哨匹配：候选点越多，玩家用 `[` `]` 切换时越痛苦。
 */
export function anchorsFor(def: BuildingDef): SnapAnchor[] {
  const [w, h, d] = def.size;
  const hx = w / 2;
  const hz = d / 2;
  return [
    { local: [0, 0, 0], normal: [0, -1, 0], kind: 'bottom' },
    { local: [0, h, 0], normal: [0, 1, 0], kind: 'top' },
    { local: [-hx, 0, -hz], normal: [0, -1, 0], kind: 'corner' },
    { local: [hx, 0, -hz], normal: [0, -1, 0], kind: 'corner' },
    { local: [hx, 0, hz], normal: [0, -1, 0], kind: 'corner' },
    { local: [-hx, 0, hz], normal: [0, -1, 0], kind: 'corner' },
    { local: [hx, h / 2, 0], normal: [1, 0, 0], kind: 'side' },
    { local: [-hx, h / 2, 0], normal: [-1, 0, 0], kind: 'side' },
    { local: [0, h / 2, hz], normal: [0, 0, 1], kind: 'side' },
    { local: [0, h / 2, -hz], normal: [0, 0, -1], kind: 'side' },
  ];
}

/** 把局部点转到世界坐标 */
export function localToWorld(
  local: [number, number, number],
  position: [number, number, number],
  rotationY: number,
): [number, number, number] {
  const [rx, rz] = rotateY(local[0], local[2], rotationY);
  return [position[0] + rx, position[1] + local[1], position[2] + rz];
}

/**
 * 找出被放置物体能吸附到附近哪些物体上。
 *
 * 只扫描 `searchRadius` 内的目标并限制返回条数 —— 智能放置建议要求 30 ms 内出结果，
 * 而"候选点数量"正是耗时的主要来源。
 */
export function findAnchorMatches(
  heldDef: BuildingDef,
  heldRotationY: number,
  cursor: [number, number, number],
  buildings: readonly BuildingInstance[],
  searchRadius = 6,
  maxResults = 8,
): AnchorMatch[] {
  const matches: AnchorMatch[] = [];
  const r2 = searchRadius * searchRadius;

  for (const target of buildings) {
    const size = target.size;
    if (!size) continue;

    const dx = target.position[0] - cursor[0];
    const dy = target.position[1] - cursor[1];
    const dz = target.position[2] - cursor[2];
    const dist2 = dx * dx + dy * dy + dz * dz;
    if (dist2 > r2) continue;
    const dist = Math.sqrt(dist2);

    // 规则 1：叠到目标顶面中心
    const topWorld = localToWorld([0, size[1], 0], target.position, target.rotationY);
    matches.push({
      position: topWorld,
      rotationY: chooseRotation(heldDef, target, heldRotationY),
      score: 100 - dist * 1.5,
      target,
      label: `叠在 ${target.name ?? target.defId} 顶上`,
    });

    // 规则 2：贴到目标最近的那个侧面
    if (matches.length < maxResults * 3) {
      let bestSide: { px: number; pz: number; nx: number; nz: number; d: number } | null = null;
      for (const [lx, lz] of SIDE_NORMALS) {
        const [nx, nz] = rotateY(lx, lz, target.rotationY);
        const halfAlong = Math.abs(nx) >= Math.abs(nz) ? size[0] / 2 : size[2] / 2;
        const surfaceX = target.position[0] + nx * halfAlong;
        const surfaceZ = target.position[2] + nz * halfAlong;
        const myHalf = Math.abs(nx) >= Math.abs(nz) ? heldDef.size[0] / 2 : heldDef.size[2] / 2;
        const px = surfaceX + nx * myHalf;
        const pz = surfaceZ + nz * myHalf;
        const d = Math.hypot(px - cursor[0], pz - cursor[2]);
        if (!bestSide || d < bestSide.d) bestSide = { px, pz, nx, nz, d };
      }
      if (bestSide && bestSide.d < searchRadius * 0.8) {
        matches.push({
          position: [bestSide.px, target.position[1], bestSide.pz],
          rotationY: chooseRotation(heldDef, target, heldRotationY),
          score: 80 - dist - bestSide.d,
          target,
          label: `贴在 ${target.name ?? target.defId} 侧面`,
        });
      }
    }

    if (matches.length >= maxResults * 3) break;
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, maxResults);
}

/**
 * 对齐到目标朝向。
 * 宽深比接近 1 的物体（柱子、方块、圆桌）跟随目标旋转更自然；
 * 明显是长条的（墙、梁）则保留玩家当前朝向，否则玩家刚转好的方向会被"纠正"掉。
 */
function chooseRotation(held: BuildingDef, target: BuildingInstance, fallback: number): number {
  const heldRatio = held.size[0] / Math.max(0.01, held.size[2]);
  const nearSquare = Math.abs(heldRatio - 1) < 0.15;
  const sameShape =
    Math.abs(heldRatio - (target.size?.[0] ?? 1) / Math.max(0.01, target.size?.[2] ?? 1)) < 0.2;
  return nearSquare || sameShape ? target.rotationY : fallback;
}
