/**
 * 全局常量。约定：1 单位 = 1 米，1 体素 = 1 米。
 *
 * M1.5 变化：世界尺寸不再是写死的常量，而是由 `worldSize.ts` 的档位（或参考地图）决定。
 * 需要世界尺寸的代码统一从 `VoxelGrid` / `World` 实例上读，不要从这里读。
 */

export const WORLD_CONFIG = {
  /** 区块水平边长（体素）。区块高度 = 世界高度，不做 Y 轴切分 */
  chunkSize: 16,
  /** 单个体素边长（米） */
  voxelSize: 1,
  /** 默认世界种子 */
  defaultSeed: 20240601,
  /**
   * 基岩层高度：y < 该值的体素不可破坏，且渲染时视为"已经在世界外"。
   * 设 0 表示 y = 0 这一层是基岩。
   */
  bedrockY: 0,
} as const;

export const PHYSICS_CONFIG = {
  /** 重力加速度（m/s²）。M3 接 Rapier 后由它应用；M1.5 只用于水/沙的等效估算 */
  gravity: -9.81,
  /** 固定时间步（秒），60 Hz */
  fixedTimeStep: 1 / 60,
  /** 单帧最多追赶的物理子步数 */
  maxSubSteps: 5,
} as const;

export const RENDER_CONFIG = {
  background: 0x9fd8ef,
  fogNear: 90,
  fogFar: 280,
  /** 设备像素比上限（手机高分屏下限制填充率） */
  maxPixelRatio: 2,
  /** 程序化纹理图集的单块贴图边长（像素） */
  atlasTileSize: 32,
  /** 图集每行放多少块 */
  atlasColumns: 16,
  /** 各向异性过滤上限（0 = 关闭） */
  anisotropy: 4,
} as const;

export const CAMERA_CONFIG = {
  fov: 55,
  near: 0.1,
  far: 2000,
  /** 初始上帝视角 */
  initialRadius: 62,
  initialTheta: Math.PI * 0.25,
  initialPhi: 0.85,
  minRadius: 2,
  maxRadius: 600,
  /** 极角范围：0 = 正上方俯视，PI/2 = 贴地平视 */
  minPhi: 0.06,
  maxPhi: 1.5,
  rotateSpeed: 0.005,
  panSpeed: 0.0018,
  zoomSpeed: 0.0013,
  keyMoveSpeed: 26,
  fastMultiplier: 4,
  referenceRadius: 62,
} as const;

/** 体素世界相关（尺寸相关的都从 grid 读） */
export const VOXEL_CONFIG = {
  /**
   * 单帧最多重建的区块数（**上限**，不是目标）。
   *
   * 这个数字原来是唯一的预算口径："每帧重建 3 块"。实测它是本项目最大的卡顿源：
   * 单块耗时中位 3~5 ms、最慢 18 ms（标准档 96×24×96），
   * 于是"3 块/帧"= **24~44 ms/帧** —— 掉到 20~40 FPS，
   * 而且要连续 12 帧（标准档 36 块）到 48 帧（大档 144 块）才追平，
   * 表现就是"换完地图后有一两秒在卡"。
   *
   * 现在改成**按时间**给预算（见 `meshBudgetMs`），这个数字退化成上限：
   * 防止"某一帧区块特别便宜"时一次重建几十块、把帧时间又堆上去。
   */
  meshBudgetPerFrame: 8,
  /**
   * 每帧最多花多少毫秒重建区块网格。
   *
   * 4 ms 是按 60 FPS（16.7 ms 预算）留的：地形只占其中约 1/4，
   * 剩下的要留给物理、渲染提交、UI 面板。
   * 无论单块多贵，都**至少重建 1 块**（否则一块特别大的区块会让进度永远推不动）。
   */
  meshBudgetMs: 4,
  /** 射线拾取的最大距离（米） */
  maxPickDistance: 400,
  /** 拖动绘制的最小时间间隔（秒） */
  paintInterval: 0.05,
  /** 右击判定为"点击"而非"拖拽平移"的像素阈值 */
  tapThresholdPx: 6,
  /** 单个区块网格允许的最大面数（超过就分块，避免超长重建卡顿）——当前未启用 */
  maxFacesPerMesh: 65536,
} as const;

/** 笔刷参数范围与默认值 */
export const BRUSH_CONFIG = {
  /** 半径 0.5 ~ 16，支持小数 */
  minRadius: 0.5,
  maxRadius: 16,
  defaultRadius: 3,
  /** 强度 0.1 ~ 1.0，支持小数 */
  minStrength: 0.1,
  maxStrength: 1,
  defaultStrength: 0.5,
  /** 每级滚轮调整的半径步长 */
  radiusStep: 0.5,
  /** 每级滚轮调整的强度步长 */
  strengthStep: 0.05,
  /** 噪声刷 / 随机刷的默认密度 */
  defaultDensity: 0.6,
  /** 单次笔刷最多改动的体素数（安全阀，防止半径 16 的球刷爆内存） */
  maxChangesPerStroke: 240000,
} as const;

/** 水的简化元胞自动机 */
export const WATER_CONFIG = {
  /** 是否默认开启动态水 */
  enabledByDefault: true,
  /** 每一步最多流动的比例（0~1），越大流得越快 */
  speed: 0.5,
  /** 每步向几个水平邻居扩散（1~4） */
  dispersion: 4,
  /** 单步最多处理的活跃水格数（性能安全阀） */
  maxActivePerStep: 12000,
  /** 判定"水位相同"的阈值，避免抖动 */
  epsilon: 0.005,
  /** 单格最大水量（1.0 = 满格） */
  capacity: 1,
} as const;

/** 沙的安息角滑落 */
export const SAND_CONFIG = {
  enabledByDefault: true,
  /** 安息角（度）。干燥沙子约 34°，用离散近似实现 */
  angleOfRepose: 34,
  /** 单步最多处理的活跃沙格数 */
  maxActivePerStep: 8000,
} as const;

/** 支撑检查（M1.5 只做诊断高亮，M3 才真的倒塌） */
export const SUPPORT_CONFIG = {
  /** 是否默认开启支撑检查 */
  enabledByDefault: false,
  /** 允许的最大悬挑距离（米）。超过就报告为不稳 */
  maxCantilever: 4,
  /** 判定"贴地"的高度容差（米） */
  groundTolerance: 0.6,
} as const;

/**
 * 区块剔除。
 *
 * M2.5 起 `renderDistance` 由**世界尺寸档位**决定（新手 6 / 标准 8 / 大型 12），
 * 这里的值只作为上限与兜底；自适应降级会在此基础上继续往下调。
 * 卸载距离固定按渲染距离的 2 倍算，避免"卸载了又马上要重建"的抖动。
 */
export const CULLING_CONFIG = {
  /** 是否启用视锥剔除 */
  frustum: true,
  /** 兜底渲染距离（档位没给时才用） */
  renderDistance: 8,
  /** 兜底卸载距离 */
  unloadDistance: 16,
  /** 每隔多少帧重新计算一次可见性（不必每帧算） */
  updateIntervalFrames: 6,
  /** 自适应降级时渲染距离的下限（再低就只剩眼前一块了） */
  minRenderDistance: 3,
} as const;

/** 存档 */
export const SAVE_CONFIG = {
  storageKey: 'god-sandbox-save-v3',
  /** 旧版键名，只读兼容（v2 与 v1 都能读） */
  legacyStorageKey: 'god-sandbox-save-v2',
  /** 当前格式版本。v3 增加了物理模式、分组与镜像标记 */
  version: 3,
  autoSaveIntervalMs: 30000,
  autoSaveDebounceMs: 4000,
} as const;
