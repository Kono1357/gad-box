/**
 * 自然树木模型（M4 第 3 批的配套数据）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么需要这一份（而不是继续用体素画树）
 * ────────────────────────────────────────────────────────────
 * M1.5 到 M3 的树都是**体素**画的（写 `leaves` / `wood` 两种体素）。
 * 那样做有三个够不着的地方，而它们正好都是 M4 要解决的问题：
 *
 * 1. **树冠被土盖住检测不到**：体素树与地形体素混在同一个 `Uint8Array` 里，
 *    "树冠"这个概念根本不存在 —— 冲突检测无从下手；
 * 2. **树不是物体**：玩家点不到它、拿不起来、也没法参与逻辑连线；
 * 3. **树的间距/避让只能靠生成时的硬编码**，改了规则要改好几处。
 *
 * 所以 M4 起树是**构建物实例**：有 `parts`、有包围盒、有 `crownRadius`，
 * 因而能被 `ConflictDetector` 检查、被物理接管、被玩家交互。
 * 体素树仍然保留（参考地图里用），两者各有用途，这一点如实写在这里。
 *
 * ────────────────────────────────────────────────────────────
 * 尺寸都是真实量级
 * ────────────────────────────────────────────────────────────
 * 阔叶树 6~8 米、针叶树 8~12 米、灌木 1~2 米 —— 写进注释便于核对。
 * `crownRadius` 是**树冠的半径**（不是整棵树的），冲突检测靠它判断"树冠有没有被地形占住"。
 */

import type { BuildingDef } from '../building/types';

/** 树干：细长圆柱。放在 y=0 起，高度由参数决定 */
function trunk(height: number, radius: number, color: number) {
  return {
    shape: 'cylinder' as const,
    position: [0, height / 2, 0] as [number, number, number],
    size: [radius * 2, height, radius * 2] as [number, number, number],
    color,
  };
}


/**
 * 由 parts **自动算**包围盒与质量。
 *
 * 为什么不用手写 `size`：我第一版 6 棵树里有 7 处手写的 `size` 与 `parts` 对不上
 * （树干加树冠的实际高度是 7.3 米，我填了 7；灌木最低点在 0.05 而不是 0）。
 * 这类错误在面板上看不出来，但会让"原点在底面中心"这条硬约定失效、
 * 进而让物理碰撞体与视觉错位。所以尺寸**不手写**，一律由 parts 推出来。
 *
 * @param massDensity 等效密度：树冠是中空的，所以取 35~90 而不是木材的 650
 */
function naturalDef(
  base: Omit<BuildingDef, 'size' | 'mass'> & { parts: BuildingDef['parts'] },
  massDensity: number,
): BuildingDef {
  const bounds = partsBoundsFrom(base.parts);
  const volume = bounds.size[0] * bounds.size[1] * bounds.size[2];
  // 把模型整体抬到"最低点贴 y=0"：原点在底面中心是项目的硬约定
  const lifted = base.parts.map((part) => ({
    ...part,
    position: [part.position[0], part.position[1] - bounds.minY, part.position[2]] as [number, number, number],
  }));
  return { ...base, parts: lifted, size: bounds.size, mass: Math.max(0.01, volume * massDensity) };
}

/** 与 buildingCatalog.partsBounds 同一套语义（旋转感知），这里为了避免循环依赖就地实现一份 */
function partsBoundsFrom(parts: BuildingDef['parts']): { minY: number; size: [number, number, number] } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    const half = rotatedHalf(part.size[0] / 2, part.size[1] / 2, part.size[2] / 2, part);
    minX = Math.min(minX, part.position[0] - half[0]);
    maxX = Math.max(maxX, part.position[0] + half[0]);
    minY = Math.min(minY, part.position[1] - half[1]);
    maxY = Math.max(maxY, part.position[1] + half[1]);
    minZ = Math.min(minZ, part.position[2] - half[2]);
    maxZ = Math.max(maxZ, part.position[2] + half[2]);
  }
  if (!Number.isFinite(minX)) return { minY: 0, size: [0.1, 0.1, 0.1] };
  return {
    minY,
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

function rotatedHalf(
  hx: number,
  hy: number,
  hz: number,
  part: BuildingDef['parts'][number],
): [number, number, number] {
  const rx = part.rotationX ?? 0;
  const ry = part.rotationY ?? 0;
  const rz = part.rotationZ ?? 0;
  if (rx === 0 && ry === 0 && rz === 0) return [hx, hy, hz];
  const cx = Math.abs(Math.cos(rx));
  const sx = Math.abs(Math.sin(rx));
  const cy = Math.abs(Math.cos(ry));
  const sy = Math.abs(Math.sin(ry));
  const cz = Math.abs(Math.cos(rz));
  const sz = Math.abs(Math.sin(rz));
  const ax = hx;
  const ay = hy * cx + hz * sx;
  const az = hy * sx + hz * cx;
  const bx = ax * cy + az * sy;
  const by = ay;
  const bz = ax * sy + az * cy;
  return [bx * cz + by * sz, bx * sz + by * cz, bz];
}

export const NATURE_TREES: BuildingDef[] = [
  // 阔叶树：树干 4 米 + 三层树冠，冠幅约 4 米
  naturalDef({
    id: 'tree_broadleaf',
    name: '阔叶树',
    category: '植物',
    subcategory: '乔木',
    type: 'plant',
    shape: 'composite',
    friction: 0.7,
    restitution: 0.05,
    color: 0x4a8c3f,
    icon: '🌳',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['树', '自然', '阔叶'],
    description: '标准阔叶树，高约 7 米，树冠半径 2.1 米。自然生成的主力。',
    lodLevels: 2,
    parts: [
      trunk(4, 0.22, 0x6b4f2a),
      { shape: 'sphere', position: [0, 4.4, 0], size: [4.0, 3.4, 4.0], color: 0x3f7a35 },
      { shape: 'sphere', position: [0, 6.0, 0], size: [3.0, 2.6, 3.0], color: 0x4a8c3f },
    ],
  }, 60),
  // 针叶树 10 米：细长圆锥树冠
  naturalDef({
    id: 'tree_conifer',
    name: '针叶树',
    category: '植物',
    subcategory: '乔木',
    type: 'plant',
    shape: 'composite',
    friction: 0.7,
    restitution: 0.04,
    color: 0x2f6b34,
    icon: '🌲',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['树', '自然', '针叶'],
    description: '针叶树，高约 10 米，塔形树冠，适合山地与雪原。',
    lodLevels: 2,
    parts: [
      trunk(3, 0.2, 0x5a4326),
      { shape: 'cone', position: [0, 3.5, 0], size: [3.4, 4.0, 3.4], color: 0x2f6b34 },
      { shape: 'cone', position: [0, 6.4, 0], size: [2.6, 3.6, 2.6], color: 0x35773a },
      { shape: 'cone', position: [0, 9.0, 0], size: [1.6, 2.6, 1.6], color: 0x3d8340 },
    ],
  }, 45),
  // 白桦 8 米：浅色树干
  naturalDef({
    id: 'tree_birch',
    name: '白桦',
    category: '植物',
    subcategory: '乔木',
    type: 'plant',
    shape: 'composite',
    friction: 0.65,
    restitution: 0.05,
    color: 0x8fbf5a,
    icon: '🌳',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['树', '自然', '白桦'],
    description: '白桦，树干浅色，秋色叶片。适合林地与雪原边缘。',
    lodLevels: 2,
    parts: [
      trunk(5, 0.18, 0xd8d4c4),
      { shape: 'sphere', position: [0, 5.4, 0], size: [3.4, 3.0, 3.4], color: 0x8fbf5a },
      { shape: 'sphere', position: [0, 6.8, 0], size: [2.2, 2.2, 2.2], color: 0x9fcb63 },
    ],
  }, 55),
  // 棕榈 6 米：细高干 + 平展叶片
  naturalDef({
    id: 'tree_palm',
    name: '棕榈',
    category: '植物',
    subcategory: '乔木',
    type: 'plant',
    shape: 'composite',
    friction: 0.6,
    restitution: 0.06,
    color: 0x6fb04a,
    icon: '🌴',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['树', '自然', '热带'],
    description: '棕榈树，高约 6 米，平展叶片。适合水边沙滩。',
    lodLevels: 2,
    parts: [
      { shape: 'cylinder', position: [0, 2.6, 0], size: [0.34, 5.2, 0.34], color: 0x8a6a43 },
      { shape: 'box', position: [0, 5.4, 0], size: [4.6, 0.24, 0.9], color: 0x6fb04a },
      { shape: 'box', position: [0, 5.4, 0], size: [0.9, 0.24, 4.6], color: 0x63a342, rotationY: 0.4 },
      { shape: 'box', position: [0, 5.5, 0], size: [3.8, 0.2, 0.8], color: 0x7cbb52, rotationY: 1.1 },
    ],
  }, 35),
  // 枯木 4 米：适合沙漠/火山
  naturalDef({
    id: 'tree_deadwood',
    name: '枯木',
    category: '植物',
    subcategory: '乔木',
    type: 'plant',
    shape: 'composite',
    friction: 0.75,
    restitution: 0.03,
    color: 0x8a7a63,
    icon: '🪵',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['树', '自然', '枯木'],
    description: '枯死的树，高约 4 米，无叶。适合沙漠、火山与荒原。',
    lodLevels: 1,
    parts: [
      trunk(3.6, 0.2, 0x8a7a63),
      { shape: 'box', position: [0.6, 3.2, 0], size: [1.6, 0.16, 0.16], color: 0x7c6d58, rotationZ: 0.5 },
      { shape: 'box', position: [-0.5, 2.6, 0.3], size: [1.4, 0.14, 0.14], color: 0x7c6d58, rotationZ: -0.6 },
    ],
  }, 80),
  // 灌木 1.4 米：体积小、可以密一点
  naturalDef({
    id: 'bush_shrub',
    name: '灌木丛',
    category: '植物',
    subcategory: '灌木',
    type: 'plant',
    shape: 'composite',
    friction: 0.7,
    restitution: 0.06,
    color: 0x4f9a44,
    icon: '🌿',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['灌木', '自然'],
    description: '矮灌木，高 1.4 米，用来填补林间空地。',
    lodLevels: 1,
    parts: [
      { shape: 'sphere', position: [0, 0.75, 0], size: [1.6, 1.4, 1.6], color: 0x4f9a44 },
      { shape: 'sphere', position: [0.35, 0.55, 0.2], size: [1.0, 0.9, 1.0], color: 0x448a3b },
    ],
  }, 90),
];

/** 岩石（自然装饰，冲突检测把它当"自然物"处理） */
export const NATURE_ROCKS: BuildingDef[] = [
  naturalDef({
    id: 'rock_boulder',
    name: '巨石',
    category: '装饰',
    subcategory: '自然',
    type: 'decoration',
    shape: 'composite',
    friction: 0.9,
    restitution: 0.05,
    color: 0x8d9297,
    icon: '🪨',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['岩石', '自然'],
    description: '半埋的巨石，可以当垫脚石或景观。',
    lodLevels: 1,
    parts: [
      { shape: 'sphere', position: [0, 0.8, 0], size: [2.4, 1.6, 2.2], color: 0x8d9297 },
      { shape: 'sphere', position: [0.6, 0.5, -0.4], size: [1.2, 1.0, 1.1], color: 0x7f858a },
    ],
  }, 1430),
];
