/**
 * 体素类型表。
 *
 * ⚠️ 扩展规则（M2 会大量用到）：
 * 1. `id` 由数组下标自动分配，**只能在数组末尾追加**，绝不能插入或交换顺序，
 *    否则所有旧存档的体素都会变成别的方块；
 * 2. `Uint8Array` 存储上限 256 种；
 * 3. `opaque` 决定面剔除：两个不透明体素相邻时，接缝面不生成；
 * 4. `texture` 决定程序化贴图（见 voxel/VoxelMaterials.ts），
 *    顶面 / 侧面 / 底面可以完全不同（例如草方块）。
 */

/** 体素类型标识（字符串）。M2 起由物品库动态提供。 */
export type VoxelType = string;

/** 程序化贴图图案。实现见 voxel/VoxelMaterials.ts 的 PATTERNS 表。 */
export type TexturePattern =
  | 'solid'
  | 'noise'
  | 'speckle'
  | 'dots'
  | 'brick'
  | 'plank'
  | 'vertical'
  | 'grass_top'
  | 'grass_side'
  | 'grid'
  | 'wave'
  | 'crystal'
  | 'metal'
  | 'leaves'
  | 'cactus'
  | 'lava'
  | 'marble';

export interface VoxelTextureSpec {
  /** 侧面主图案 */
  pattern: TexturePattern;
  /** 顶面图案（默认与侧面相同） */
  topPattern?: TexturePattern;
  /** 底面图案（默认与侧面相同） */
  bottomPattern?: TexturePattern;
  /** 顶面底色（默认用 def.color） */
  topColor?: number;
  /** 侧面底色 */
  sideColor?: number;
  /** 底面底色 */
  bottomColor?: number;
  /** 图案的次要色（砖缝、斑点、木纹等） */
  accent?: number;
  /** 图案密度 0~1 */
  density?: number;
}

export interface VoxelTypeDef {
  /** 数值 id：Uint8Array 里存的就是它 */
  id: number;
  /** 字符串标识（UI / 调试用，存档不存它） */
  key: VoxelType;
  /** 中文显示名 */
  name: string;
  /** 主色（UI 色块、缩略图、顶点色兜底） */
  color: number;
  /** 是否实心（M3 的支撑检查与碰撞体只认实心体素） */
  solid: boolean;
  /** 是否不透明：驱动面剔除 */
  opaque: boolean;
  /** 单个体素的质量（kg） */
  mass: number;
  /** UI 分组 */
  group: string;
  /** 一句话说明 */
  description: string;
  /** 程序化贴图配置 */
  texture: VoxelTextureSpec;
  /** 是否为液体（水）：渲染时按水量决定方块高度 */
  liquid?: boolean;
}

/** 体素定义表。id = 数组下标，只能末尾追加。 */
export const VOXEL_TYPES: readonly VoxelTypeDef[] = [
  {
    id: 0,
    key: 'air',
    name: '空气',
    color: 0x000000,
    solid: false,
    opaque: false,
    mass: 0,
    group: '基础',
    description: '空。不渲染、不参与拾取，相当于删除。',
    texture: { pattern: 'solid' },
  },
  {
    id: 1,
    key: 'grass',
    name: '草方块',
    color: 0x6fae4a,
    solid: true,
    opaque: true,
    mass: 1400,
    group: '基础',
    description: '顶部青草、侧面带草沿、底部是土 —— 三面各不相同。',
    texture: {
      pattern: 'grass_side',
      topPattern: 'grass_top',
      bottomPattern: 'noise',
      topColor: 0x74b84e,
      sideColor: 0x7a5c3c,
      bottomColor: 0x8a6a44,
      accent: 0x5f9a3e,
      density: 0.5,
    },
  },
  {
    id: 2,
    key: 'dirt',
    name: '泥土',
    color: 0x8a6a44,
    solid: true,
    opaque: true,
    mass: 1400,
    group: '基础',
    description: '草层下方的填充材质，颗粒感明显。',
    texture: { pattern: 'noise', accent: 0x6d5232, density: 0.65 },
  },
  {
    id: 3,
    key: 'stone',
    name: '石头',
    color: 0x8d9297,
    solid: true,
    opaque: true,
    mass: 2600,
    group: '基础',
    description: '深层岩体，表面散布深色矿点。',
    texture: { pattern: 'speckle', accent: 0x6b7176, density: 0.45 },
  },
  {
    id: 4,
    key: 'sand',
    name: '沙子',
    color: 0xe0d29a,
    solid: true,
    opaque: true,
    mass: 1600,
    group: '基础',
    description: '暖黄色细沙，带细密颗粒。M1.5 起会按安息角滑落。',
    texture: { pattern: 'dots', accent: 0xc9b87e, density: 0.7 },
  },
  {
    id: 5,
    key: 'water',
    name: '水',
    color: 0x3f7fd0,
    solid: false,
    opaque: false,
    mass: 1000,
    group: '液体',
    description: '有重力的水，会向低处流、被容器托住，水位决定方块高度。',
    texture: { pattern: 'wave', topPattern: 'wave', accent: 0x6aa8ec, density: 0.4 },
    liquid: true,
  },
  {
    id: 6,
    key: 'wood',
    name: '木头',
    color: 0x8b5a2b,
    solid: true,
    opaque: true,
    mass: 600,
    group: '建筑',
    description: '竖向木纹，顶面是年轮。',
    texture: {
      pattern: 'vertical',
      topPattern: 'plank',
      accent: 0x6d4520,
      topColor: 0xa9753c,
      density: 0.45,
    },
  },
  {
    id: 7,
    key: 'brick',
    name: '砖块',
    color: 0xa8563f,
    solid: true,
    opaque: true,
    mass: 1900,
    group: '建筑',
    description: '错缝砌法，砖缝清晰可辨。',
    texture: { pattern: 'brick', accent: 0xd9cbb8, density: 0.5 },
  },
  {
    id: 8,
    key: 'steel',
    name: '钢材',
    color: 0x9aa7b0,
    solid: true,
    opaque: true,
    mass: 7800,
    group: '建筑',
    description: '冷灰金属，带拉丝高光，密度最大。',
    texture: { pattern: 'metal', accent: 0xd6e2ea, density: 0.35 },
  },
  {
    id: 9,
    key: 'glass',
    name: '玻璃',
    color: 0xbfe6ea,
    solid: true,
    opaque: false,
    mass: 2500,
    group: '建筑',
    description: '透光材质，与同类相邻时内部面不渲染。',
    texture: { pattern: 'grid', accent: 0xe8fbff, density: 0.3 },
  },
  {
    id: 10,
    key: 'snow',
    name: '雪',
    color: 0xf2f6f8,
    solid: true,
    opaque: true,
    mass: 300,
    group: '基础',
    description: '亮白带淡蓝阴影，高海拔地表。',
    texture: { pattern: 'noise', accent: 0xd8e6f2, density: 0.35 },
  },
  {
    id: 11,
    key: 'ice',
    name: '冰',
    color: 0x9fd8ef,
    solid: true,
    opaque: true,
    mass: 900,
    group: '基础',
    description: '淡蓝冰体，带斜向反光裂纹。',
    texture: { pattern: 'crystal', accent: 0xe4f7ff, density: 0.45 },
  },
  // ---------------- 以下为 M1.5 追加（id 12 起，不影响旧存档） ----------------
  {
    id: 12,
    key: 'leaves',
    name: '树叶',
    color: 0x4f9d3f,
    solid: true,
    opaque: true,
    mass: 250,
    group: '自然',
    description: '叶簇纹理，用来搭树冠。',
    texture: { pattern: 'leaves', accent: 0x35722a, density: 0.75 },
  },
  {
    id: 13,
    key: 'cactus',
    name: '仙人掌',
    color: 0x3f8a4a,
    solid: true,
    opaque: true,
    mass: 500,
    group: '自然',
    description: '竖向棱线带刺，沙漠地图用。',
    texture: { pattern: 'cactus', accent: 0xd8e8b0, density: 0.4 },
  },
  {
    id: 14,
    key: 'mud',
    name: '泥巴',
    color: 0x5c4a33,
    solid: true,
    opaque: true,
    mass: 1700,
    group: '自然',
    description: '深色湿土，适合做河床与沼泽。',
    texture: { pattern: 'noise', accent: 0x453726, density: 0.8 },
  },
  {
    id: 15,
    key: 'cobble',
    name: '圆石',
    color: 0x7c8288,
    solid: true,
    opaque: true,
    mass: 2500,
    group: '建筑',
    description: '大小不一的石块砌面，适合城墙与城堡。',
    texture: { pattern: 'speckle', accent: 0x5a6066, density: 0.85 },
  },
  {
    id: 16,
    key: 'marble',
    name: '大理石',
    color: 0xe6e2d8,
    solid: true,
    opaque: true,
    mass: 2700,
    group: '建筑',
    description: '浅色石纹，适合宫殿与雕像底座。',
    texture: { pattern: 'marble', accent: 0xbdb6a4, density: 0.4 },
  },
  {
    id: 17,
    key: 'basalt',
    name: '玄武岩',
    color: 0x4a4e55,
    solid: true,
    opaque: true,
    mass: 2900,
    group: '自然',
    description: '深色火山岩，对比强烈。',
    texture: { pattern: 'speckle', accent: 0x32363c, density: 0.6 },
  },
  {
    id: 18,
    key: 'lava',
    name: '岩浆',
    color: 0xe2622a,
    solid: true,
    opaque: true,
    mass: 2600,
    group: '自然',
    description: '发光的熔岩裂纹。M1.5 只是静态材质，不会流动。',
    texture: { pattern: 'lava', accent: 0xffc35a, density: 0.5 },
  },
] as const;

/** id → 定义（下标即 id） */
export const VOXEL_BY_ID: readonly VoxelTypeDef[] = VOXEL_TYPES;

const BY_KEY = new Map<string, VoxelTypeDef>(VOXEL_TYPES.map((def) => [def.key, def]));

/** 空体素的 id */
export const AIR = 0;

/** 按数值 id 取定义；越界返回 air 定义，避免抛错打断渲染循环 */
export function getVoxelDef(id: number): VoxelTypeDef {
  return VOXEL_BY_ID[id] ?? VOXEL_BY_ID[AIR]!;
}

export function getVoxelDefByKey(key: string): VoxelTypeDef | undefined {
  return BY_KEY.get(key);
}

/** 按字符串 key 取数值 id */
export function getVoxelId(key: string): number {
  return BY_KEY.get(key)?.id ?? AIR;
}

export function isOpaque(id: number): boolean {
  return getVoxelDef(id).opaque;
}

export function isSolid(id: number): boolean {
  return getVoxelDef(id).solid;
}

/** 是否为液体（水） */
export function isLiquid(id: number): boolean {
  return getVoxelDef(id).liquid === true;
}

/** 是否可被笔刷拾取：只有 air 不行 */
export function isPickable(id: number): boolean {
  return id !== AIR;
}

/** 十六进制颜色 → 0~1 的 RGB */
export function colorToRgb(color: number): [number, number, number] {
  return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255];
}

/** 六位十六进制颜色字符串（UI 用） */
export function colorToHexString(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** 默认笔刷材质 */
export const DEFAULT_BRUSH_MATERIAL = getVoxelId('grass');
