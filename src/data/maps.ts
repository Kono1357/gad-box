import type { WorldSizeId } from '../worldSize';

/**
 * 内置参考地图。
 *
 * 存储方式的选择：**不存体素数据，存"生成配方"**。
 * - 一张 128×32×128 的地图如果直接存 JSON 就是 512 KB 原始数据（base64 后约 700 KB），
 *   四张地图要塞进 `public/maps/` 就得 2.8 MB，而且要联网下载；
 * - 而地图完全由 `seed + 参数 + 生成函数` 决定，同一份配方每次生成的结果**逐字节相同**，
 *   一张地图的元数据只有几百字节，还能直接打进 bundle、离线可用、不会被 CORS 卡住。
 *
 * 所以每张地图 = 元数据（本文件） + 生成函数（world/MapGenerators.ts）。
 */
export interface MapDefinition {
  id: string;
  name: string;
  /** 作者（内置地图统一署名） */
  author: string;
  /** 难度标签 */
  difficulty: '入门' | '进阶' | '挑战';
  /** 世界尺寸档位 */
  size: WorldSizeId;
  /** 生成种子（固定 → 地图可复现） */
  seed: number;
  /** 缩略图 emoji */
  emoji: string;
  /** 缩略图色块（3~4 个十六进制颜色，UI 直接画渐变） */
  palette: number[];
  /** 一句话介绍 */
  description: string;
  /** 想展示的技巧 */
  showcase: string[];
  /** 推荐游玩方式 */
  recommended: string;
}

export const BUILTIN_MAPS: readonly MapDefinition[] = [
  {
    id: 'novice_island',
    name: '新手岛',
    author: '内置示例',
    difficulty: '入门',
    size: 'novice',
    seed: 1001,
    emoji: '🏝️',
    palette: [0x6fae4a, 0xe0d29a, 0x3f7fd0, 0x8d9297],
    description:
      '64×24×64 的小岛：中间一座缓坡山，四周环水，有沙滩和树林。区块只有 16 个，帧率最高，最适合熟悉笔刷。',
    showcase: ['最小世界尺寸', '沙滩与浅水', '低多边形树林', '适合练手的缓坡'],
    recommended: '建议先用「抬升」把山推高、再用「平滑」抹圆，最后用「材质刷」把山顶换成雪。',
  },
  {
    id: 'valley_village',
    name: '山谷村落',
    author: '内置示例',
    difficulty: '进阶',
    size: 'standard',
    seed: 2002,
    emoji: '🏘️',
    palette: [0x6fae4a, 0x8a6a44, 0x8d9297, 0xa8563f],
    description:
      '128×32×128 的山谷：两侧山脊夹一条河，谷底散落着几栋用建筑模型搭的房子，用来参考"建筑怎么和地形配合"。',
    showcase: ['山谷与河道', '建筑贴地放置', '房屋由墙/地板/屋顶拼装', '地形与建筑的遮挡关系'],
    recommended: '沿着河岸用「抹平」压出地基，再进建筑面板放墙与屋顶，试试把桥架到河上。',
  },
  {
    id: 'desert_oasis',
    name: '沙漠绿洲',
    author: '内置示例',
    difficulty: '进阶',
    size: 'standard',
    seed: 3003,
    emoji: '🏜️',
    palette: [0xe0d29a, 0xc9b87e, 0x3f7fd0, 0x4f9d3f],
    description:
      '128×32×128 的沙漠：连绵沙丘中间一片绿洲，水被沙坑托住，四周是棕榈和仙人掌，专门用来对比材质区分度。',
    showcase: ['沙丘材质与颗粒', '水被容器托住（水位可见）', '棕榈树', '砂/水/植被的配色对比'],
    recommended: '观察绿洲边缘的水位是怎么被沙坑限制的；再开「沙滑落」用「挖洞」挖开沙丘看它塌下来。',
  },
  {
    id: 'castle_hill',
    name: '城堡山',
    author: '内置示例',
    difficulty: '挑战',
    size: 'standard',
    seed: 4004,
    emoji: '🏰',
    palette: [0x7c8288, 0xe6e2d8, 0x6fae4a, 0x4a4e55],
    description:
      '128×32×128 的山地：高台上用圆石与大理石砌了城墙、角楼和一条登山阶梯，用来参考复杂地形上的结构搭建。',
    showcase: ['高台与陡坡地形', '城墙 / 角楼 / 阶梯的拼装', '支撑检查（打开后看悬空结构）', '石材配色对比'],
    recommended: '打开右侧「支撑检查」，能看到哪些城墙段离地基太远；再用「顶点捕捉」把山坡做成台阶。',
  },
] as const;

export function getMapById(id: string): MapDefinition | undefined {
  return BUILTIN_MAPS.find((map) => map.id === id);
}

/** 默认地图（新玩家进来看到的第一张） */
export const DEFAULT_MAP_ID = 'novice_island';
