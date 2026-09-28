/**
 * 地图生成模板（M4 补充 3）。
 *
 * ────────────────────────────────────────────────────────────
 * 模板与"参考地图"的区别（这两个概念很容易混）
 * ────────────────────────────────────────────────────────────
 * | | 参考地图（`data/maps.ts`，M1.5） | 生成模板（本文件，M4） |
 * |---|---|---|
 * | 内容 | 手写雕刻的地形 + 手工摆好的建筑 | **只有参数**，地形与内容全由流水线生成 |
 * | 数量 | 4 张 | 8 套 |
 * | 可复现 | 是（固定种子） | 是（固定种子 + 种子化 PRNG） |
 * | 用途 | "看一张已经做好的地图" | "用这套参数生成一张新地图" |
 *
 * 所以模板不是"地图数据"，而是**生成参数的一组预设**。玩家可以选模板、
 * 再在上面微调（树密度、水体比例……），这也是"生成参数可调"最自然的入口。
 *
 * ────────────────────────────────────────────────────────────
 * 参数怎么定的（不是随手拍的）
 * ────────────────────────────────────────────────────────────
 * 每个模板给的是**相对基准的倍率**而不是绝对值：
 * - `heightScale`：地形振幅倍率。平原 0.35、山地 1.8 —— 平原要平到能盖房，山地要起伏到有层次；
 * - `waterRatio`：水体比例 0~1。群岛 0.75（大量水面）、沙漠 0.05（几乎没有）；
 * - `treeDensity`：树密度倍率 0~2。森林 1.8、沙漠 0.15；
 * - `buildingDensity`：建筑密度 0~2。城市 1.8、雪原 0.2；
 * - `itemDensity`：小物品密度 0~2。城市 1.5、沙漠 0.05。
 *
 * 这五个数全部是"倍率"，好处是**换了世界尺寸之后不用重新调参数** ——
 * 大世界的基准数量本来就更多，再乘同一个倍率，手感是一致的。
 */

import type { WorldSizeId } from '../worldSize';

export type MapTerrainType =
  | 'plain'
  | 'mountain'
  | 'desert'
  | 'island'
  | 'snow'
  | 'volcano'
  | 'forest'
  | 'city';

export const TERRAIN_TYPE_LABELS: Record<MapTerrainType, string> = {
  plain: '平原',
  mountain: '山地',
  desert: '沙漠',
  island: '群岛',
  snow: '雪原',
  volcano: '火山',
  forest: '森林',
  city: '城市',
};

export interface MapTemplateParams {
  /** 地形振幅倍率（0.2 ~ 2） */
  heightScale: number;
  /** 水体比例（0 ~ 1，越大水面越高） */
  waterRatio: number;
  /** 树密度倍率（0 ~ 2） */
  treeDensity: number;
  /** 建筑密度倍率（0 ~ 2） */
  buildingDensity: number;
  /** 小物品密度倍率（0 ~ 2） */
  itemDensity: number;
  /** 种子（相同种子生成相同地图） */
  seed: number;
  /** 推荐世界尺寸 */
  size: WorldSizeId;
}

export interface MapTemplate {
  id: string;
  name: string;
  emoji: string;
  terrainType: MapTerrainType;
  description: string;
  /** 一句"这套模板适合干什么" */
  recommended: string;
  params: MapTemplateParams;
  /** 缩略图：用一个 CSS 渐变表达地形色调（不引入图片资源） */
  palette: readonly number[];
}

/** 8 套模板 */
export const MAP_TEMPLATES: readonly MapTemplate[] = [
  {
    id: 'plain_village',
    name: '平原村庄',
    emoji: '🌾',
    terrainType: 'plain',
    description: '起伏很小的开阔平地，水量适中，适合盖房与布置村落',
    recommended: '新手首选：地面平整，放东西不容易悬空',
    params: { heightScale: 0.35, waterRatio: 0.3, treeDensity: 0.7, buildingDensity: 1.2, itemDensity: 1, seed: 1001, size: 'novice' },
    palette: [0x7ba05b, 0x9dbf6a, 0xd8cfa0, 0x6fa8dc],
  },
  {
    id: 'high_mountain',
    name: '高山峡谷',
    emoji: '⛰️',
    terrainType: 'mountain',
    description: '强烈的高低起伏，陡坡与山脊为主，建筑要挑平地放',
    recommended: '试承重与支撑：坡多、悬挑容易出问题',
    params: { heightScale: 1.8, waterRatio: 0.15, treeDensity: 0.6, buildingDensity: 0.5, itemDensity: 0.4, seed: 2002, size: 'standard' },
    palette: [0x6b7a8f, 0x8d99a6, 0xd8dde3, 0x4f6b52],
  },
  {
    id: 'desert_dunes',
    name: '沙漠戈壁',
    emoji: '🏜️',
    terrainType: 'desert',
    description: '几乎没有水，沙丘与裸岩为主，植被稀疏',
    recommended: '看沙子物理：安息角、流动与堆积',
    params: { heightScale: 0.9, waterRatio: 0.05, treeDensity: 0.15, buildingDensity: 0.3, itemDensity: 0.05, seed: 3003, size: 'standard' },
    palette: [0xd9b777, 0xe8d3a0, 0xb08d55, 0x8ba8c9],
  },
  {
    id: 'archipelago',
    name: '群岛海域',
    emoji: '🏝️',
    terrainType: 'island',
    description: '大片水面与零散小岛，适合试浮力与船',
    recommended: '看浮力：空心结构能浮、实心会沉',
    params: { heightScale: 0.7, waterRatio: 0.75, treeDensity: 0.9, buildingDensity: 0.6, itemDensity: 0.5, seed: 4004, size: 'standard' },
    palette: [0x3d7ea6, 0x6fb3d0, 0xe3d6a8, 0x5a8f4e],
  },
  {
    id: 'snow_field',
    name: '雪原冻土',
    emoji: '❄️',
    terrainType: 'snow',
    description: '高海拔、雪线低，地表大片积雪，植被稀少',
    recommended: '看低摩擦场景：雪地上东西更好推',
    params: { heightScale: 0.8, waterRatio: 0.2, treeDensity: 0.25, buildingDensity: 0.2, itemDensity: 0.2, seed: 5005, size: 'standard' },
    palette: [0xe8eef5, 0xc6d4e0, 0x9fb3c8, 0x5c6b7a],
  },
  {
    id: 'volcanic',
    name: '火山岩地',
    emoji: '🌋',
    terrainType: 'volcano',
    description: '高耸的火山锥与火山口，地表是黑灰色岩体',
    recommended: '试倒塌：陡坡上的结构很容易失稳',
    params: { heightScale: 1.6, waterRatio: 0.1, treeDensity: 0.1, buildingDensity: 0.25, itemDensity: 0.2, seed: 6006, size: 'standard' },
    palette: [0x4a3f3a, 0x6b5a52, 0x2f2a28, 0xd97b4a],
  },
  {
    id: 'deep_forest',
    name: '密林丘陵',
    emoji: '🌳',
    terrainType: 'forest',
    description: '缓丘地形 + 很密的树木，空地不多',
    recommended: '看避让逻辑：房子会主动清出林地',
    params: { heightScale: 0.9, waterRatio: 0.3, treeDensity: 1.8, buildingDensity: 0.4, itemDensity: 0.4, seed: 7007, size: 'standard' },
    palette: [0x2f6b34, 0x4a8c3f, 0x6fb04a, 0x8a6a43],
  },
  {
    id: 'city_block',
    name: '城市街区',
    emoji: '🏙️',
    terrainType: 'city',
    description: '接近平坦的地形 + 高密度建筑与室内小物品',
    recommended: '看内容量：几百个物体的性能表现',
    params: { heightScale: 0.25, waterRatio: 0.2, treeDensity: 0.3, buildingDensity: 1.8, itemDensity: 1.5, seed: 8008, size: 'standard' },
    palette: [0x9aa3ad, 0xc3c9d0, 0x6f7a86, 0x7ba05b],
  },
] as const;

export const DEFAULT_TEMPLATE_ID = 'plain_village';

export function getMapTemplate(id: string): MapTemplate | undefined {
  return MAP_TEMPLATES.find((template) => template.id === id);
}

/** 按地形类型筛模板 */
export function templatesByTerrain(type: MapTerrainType): MapTemplate[] {
  return MAP_TEMPLATES.filter((template) => template.terrainType === type);
}

/** 参数范围（面板滑块用它，也是校验依据） */
export const TEMPLATE_PARAM_LIMITS = {
  heightScale: { min: 0.2, max: 2, step: 0.05 },
  waterRatio: { min: 0, max: 1, step: 0.05 },
  treeDensity: { min: 0, max: 2, step: 0.05 },
  buildingDensity: { min: 0, max: 2, step: 0.05 },
  itemDensity: { min: 0, max: 2, step: 0.05 },
} as const;

export function validateTemplateParams(params: MapTemplateParams): string[] {
  const problems: string[] = [];
  for (const [key, limit] of Object.entries(TEMPLATE_PARAM_LIMITS)) {
    const value = params[key as keyof MapTemplateParams] as number;
    if (!Number.isFinite(value)) {
      problems.push(`${key} 不是有效数字`);
      continue;
    }
    if (value < limit.min || value > limit.max) {
      problems.push(`${key} 必须在 ${limit.min} ~ ${limit.max} 之间（现在是 ${value}）`);
    }
  }
  if (!Number.isFinite(params.seed)) problems.push('种子必须是数字');
  return problems;
}

/** 面板用：一行中文摘要 */
export function describeTemplate(template: MapTemplate): string {
  const params = template.params;
  return (
    `${template.emoji} ${template.name}（${TERRAIN_TYPE_LABELS[template.terrainType]}）｜` +
    `高度 ×${params.heightScale.toFixed(2)}｜水 ${(params.waterRatio * 100).toFixed(0)}%｜` +
    `树 ×${params.treeDensity.toFixed(2)}｜建筑 ×${params.buildingDensity.toFixed(2)}｜` +
    `物品 ×${params.itemDensity.toFixed(2)}｜种子 ${params.seed}`
  );
}

/** 缩略图用的 CSS 渐变（不引入图片资源：纯前端 + Pages 下最省事） */
export function templateGradient(template: MapTemplate): string {
  const stops = template.palette.map((color, index) => {
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    return `${hex} ${((index / (template.palette.length - 1)) * 100).toFixed(0)}%`;
  });
  return `linear-gradient(180deg, ${stops.join(', ')})`;
}
