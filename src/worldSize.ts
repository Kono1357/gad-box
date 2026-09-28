/**
 * 世界尺寸档位。
 *
 * 玩家第二次反馈"初始地图仍然太大，性能差"，所以 M2.5 又缩了一档：
 * 新手从 64×24×64（16 区块）降到 **48×16×48（9 区块）**，
 * 体素量从约 5 万降到约 2 万；标准从 128×32×128 降到 96×24×96。
 *
 * 区块水平尺寸固定 16；**不做 Y 轴区块切分**，区块高度等于世界高度。
 * 所以：
 * - 新手 48×16×48 → 3 × 3 = 9 个区块（每块 16×16×16，正好是需求里写的 16³）
 * - 标准 96×24×96 → 6 × 6 = 36 个区块（每块 16×24×16）
 * - 大型 192×32×192 → 12 × 12 = 144 个区块（每块 16×32×16）
 * 区块数正好是需求里写的 9 / 36 / 144。
 */

export type WorldSizeId = 'novice' | 'standard' | 'large';

export interface WorldSizePreset {
  id: WorldSizeId;
  name: string;
  /** 世界尺寸（体素 / 米） */
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  /** 水平区块边长（固定 16） */
  chunkSize: number;
  description: string;
  /**
   * 距离剔除：水平切比雪夫距离超过这么多区块就不渲染。
   * 按档位给不同值 —— 小世界给太小会频繁闪烁，大世界给太大就白做剔除。
   */
  renderDistance: number;
  /** 高空剔除：在这个距离内即使相机拉得很高也保留渲染 */
  keepRadiusWhileHigh: number;
  /** 地形生成的默认参数 */
  terrain: {
    waterLevel: number;
    baseHeight: number;
    amplitude: number;
    minHeight: number;
    maxHeight: number;
    snowLine: number;
    /** 噪声频率：值越小地形越舒展 */
    noiseScale: number;
  };
}

export const WORLD_SIZES: Record<WorldSizeId, WorldSizePreset> = {
  novice: {
    id: 'novice',
    name: '新手 48×16×48',
    sizeX: 48,
    sizeY: 16,
    sizeZ: 48,
    chunkSize: 16,
    description: '3 × 3 = 9 个区块。体素量只有标准档的 1/8，目标 90 FPS 以上，适合练手。',
    renderDistance: 6,
    keepRadiusWhileHigh: 4,
    terrain: {
      waterLevel: 5,
      baseHeight: 7,
      amplitude: 6,
      minHeight: 2,
      maxHeight: 15,
      snowLine: 13,
      noiseScale: 1 / 32,
    },
  },
  standard: {
    id: 'standard',
    name: '标准 96×24×96',
    sizeX: 96,
    sizeY: 24,
    sizeZ: 96,
    chunkSize: 16,
    description: '6 × 6 = 36 个区块。中端设备目标 60 FPS 以上。',
    renderDistance: 8,
    keepRadiusWhileHigh: 5,
    terrain: {
      waterLevel: 8,
      baseHeight: 10,
      amplitude: 10,
      minHeight: 2,
      maxHeight: 23,
      snowLine: 18,
      noiseScale: 1 / 62,
    },
  },
  large: {
    id: 'large',
    name: '大型 192×32×192',
    sizeX: 192,
    sizeY: 32,
    sizeZ: 192,
    chunkSize: 16,
    description: '12 × 12 = 144 个区块。给大工程用，靠剔除与自适应降级维持 30 FPS 以上。',
    renderDistance: 12,
    keepRadiusWhileHigh: 7,
    terrain: {
      waterLevel: 11,
      baseHeight: 13,
      amplitude: 13,
      minHeight: 2,
      maxHeight: 31,
      snowLine: 26,
      noiseScale: 1 / 110,
    },
  },
};

/** 默认档位：新手 */
export const DEFAULT_WORLD_SIZE: WorldSizeId = 'novice';

/** 下拉框用的有序列表 */
export const WORLD_SIZE_LIST: WorldSizePreset[] = [
  WORLD_SIZES.novice,
  WORLD_SIZES.standard,
  WORLD_SIZES.large,
];

export function getWorldSize(id: string): WorldSizePreset {
  return (WORLD_SIZES as Record<string, WorldSizePreset>)[id] ?? WORLD_SIZES[DEFAULT_WORLD_SIZE];
}
