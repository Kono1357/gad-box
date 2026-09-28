import type { BuildingDef } from '../../building/types';

/**
 * M4 交通类模型（20 个）。
 *
 * 与 `data/buildings/props.ts` 的约定一致：**原点在底面中心**，parts 从 y = 0 往上堆，
 * `size` 就是所有 part 的包围盒。
 *
 * 本文件额外约定两条：
 *
 * 1. **车轮一律 `cylinder` + `rotationZ: Math.PI / 2`**。
 *    圆柱默认轴沿 Y，绕 Z 轴转 90° 后轴变成沿 X —— 于是车身的**长轴沿 Z**、
 *    轮轴沿 X（横向）：左右轮分列 `x = ±半宽`，前后轮分列 `z = ±轴距/2`。
 *    轮子的世界包围盒因此是 [厚度, 直径, 直径]（Y/Z 被直径撑开），轮底正好落在 y = 0。
 * 2. **mass 按真实整备质量校正**：先按"包围盒体积 × 等效密度"估算，再拉到实车数字，
 *    注释里写明校正依据（车型 + 真实整备质量量级）。车高同理：轿车 1.4 m、
 *    卡车 3.5 m、巴士 3.2 m 都是真实车高的量级，写在各条注释里。
 */
export const VEHICLE_ITEMS: BuildingDef[] = [
  // ============================================================
  // 汽车（4）
  // ============================================================
  // 两厢轿车 1.92×1.4×4.2 —— 车高 1.4 m（真实两厢车 1.4~1.5 m）
  {
    id: 'car_hatchback',
    name: '两厢轿车',
    category: '交通',
    subcategory: '汽车',
    type: 'vehicle',
    shape: 'custom',
    size: [1.92, 1.4, 4.2],
    // 包围盒体积 11.29 m³ × 等效密度 106 kg/m³ ≈ 1200 kg；按真实整备质量 1200 kg 校正
    mass: 1200,
    friction: 0.6,
    restitution: 0.25,
    color: 0xc0392b,
    icon: '🚗',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    textureType: 'steel',
    tags: ['车辆', '轿车', '两厢', '四轮'],
    description: '两厢轿车，车高 1.4 米，四个轮子用圆柱放倒表达。车顶是平的，可以往上堆箱子。',
    parts: [
      // 车身：离地 0.35，顶面 1.05
      { shape: 'box', position: [0, 0.7, 0], size: [1.8, 0.7, 4.2], color: 0xc0392b },
      // 座舱：1.05 → 1.40（车高 1.4 m）
      { shape: 'box', position: [0, 1.225, -0.1], size: [1.7, 0.35, 2.4], color: 0xc0392b },
      // 四个轮子：轴沿 X（rotationZ 放倒），直径 0.7 m
      { shape: 'cylinder', position: [-0.85, 0.35, 1.35], size: [0.7, 0.22, 0.7], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [0.85, 0.35, 1.35], size: [0.7, 0.22, 0.7], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [-0.85, 0.35, -1.35], size: [0.7, 0.22, 0.7], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [0.85, 0.35, -1.35], size: [0.7, 0.22, 0.7], rotationZ: Math.PI / 2, color: 0x2c3e50 },
    ],
  },
  // 越野车 2.1×1.75×4.6 —— 高底盘 + 大直径越野胎
  {
    id: 'car_suv',
    name: '越野车',
    category: '交通',
    subcategory: '汽车',
    type: 'vehicle',
    shape: 'custom',
    size: [2.1, 1.75, 4.6],
    // 包围盒体积 16.94 m³ × 等效密度 124 kg/m³ ≈ 2100 kg；按真实整备质量 2100 kg 校正
    mass: 2100,
    friction: 0.7,
    restitution: 0.2,
    color: 0x2f6f4f,
    icon: '🚙',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    textureType: 'steel',
    tags: ['车辆', '越野', '四驱', '四轮'],
    description: '越野车，离地间隙比轿车高一截，轮胎直径 0.9 米，车顶有行李架空间可以堆东西。',
    parts: [
      // 车身：0.55 → 1.25
      { shape: 'box', position: [0, 0.9, 0], size: [1.9, 0.7, 4.6], color: 0x2f6f4f },
      // 车顶：1.25 → 1.75
      { shape: 'box', position: [0, 1.5, -0.2], size: [1.8, 0.5, 3.0], color: 0x2f6f4f },
      // 越野胎：直径 0.9 m，胎底贴地
      { shape: 'cylinder', position: [-0.9, 0.45, 1.5], size: [0.9, 0.3, 0.9], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [0.9, 0.45, 1.5], size: [0.9, 0.3, 0.9], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [-0.9, 0.45, -1.5], size: [0.9, 0.3, 0.9], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [0.9, 0.45, -1.5], size: [0.9, 0.3, 0.9], rotationZ: Math.PI / 2, color: 0x2c3e50 },
    ],
  },
  // 皮卡 2.08×1.8×5.4 —— 驾驶室 + 敞开的货台（货台顶面 y = 1.45）
  {
    id: 'car_pickup',
    name: '皮卡',
    category: '交通',
    subcategory: '汽车',
    type: 'vehicle',
    shape: 'custom',
    size: [2.08, 1.8, 5.4],
    // 包围盒体积 20.22 m³ × 等效密度 109 kg/m³ ≈ 2200 kg；按真实整备质量 2200 kg 校正
    mass: 2200,
    friction: 0.65,
    restitution: 0.2,
    color: 0x2c6fb0,
    icon: '🛻',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    // 货台是平的，明确允许往上堆货
    stackable: true,
    textureType: 'steel',
    tags: ['车辆', '皮卡', '货台', '四轮'],
    description: '皮卡，前部双排驾驶室、后部敞开货台。货台围板很矮，可以直接往上堆箱子。',
    parts: [
      // 底盘大梁：0.55 → 1.05（货台面）
      { shape: 'box', position: [0, 0.8, 0], size: [1.9, 0.5, 5.4], color: 0x3a3f44 },
      // 驾驶室：1.05 → 1.80
      { shape: 'box', position: [0, 1.425, 0.9], size: [1.85, 0.75, 1.8], color: 0x2c6fb0 },
      // 货台围板：1.05 → 1.45
      { shape: 'box', position: [0, 1.25, -1.3], size: [1.85, 0.4, 2.4], color: 0x2c6fb0 },
      { shape: 'cylinder', position: [-0.9, 0.4, 1.8], size: [0.8, 0.28, 0.8], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [0.9, 0.4, 1.8], size: [0.8, 0.28, 0.8], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [-0.9, 0.4, -1.8], size: [0.8, 0.28, 0.8], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [0.9, 0.4, -1.8], size: [0.8, 0.28, 0.8], rotationZ: Math.PI / 2, color: 0x2c3e50 },
    ],
  },
  // 救护车 2.2×2.5×5.6 —— 厢式轻客改的急救车，车高 2.5 m
  {
    id: 'ambulance',
    name: '救护车',
    category: '交通',
    subcategory: '汽车',
    type: 'vehicle',
    shape: 'custom',
    size: [2.2, 2.5, 5.6],
    // 包围盒体积 30.8 m³ × 等效密度 79.5 kg/m³ ≈ 2450 kg；按真实整备质量 2450 kg 校正（轻型厢式救护车）
    mass: 2450,
    friction: 0.65,
    restitution: 0.15,
    color: 0xf2f6f8,
    icon: '🚑',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    textureType: 'steel',
    tags: ['车辆', '救护', '厢式', '四轮'],
    description: '救护车，白色厢式车身配一圈车窗带，车高 2.5 米。箱顶是平的，能再放担架箱。',
    parts: [
      // 底盘：0.55 → 1.05
      { shape: 'box', position: [0, 0.8, 0], size: [2.0, 0.5, 5.6], color: 0xf2f6f8 },
      // 医疗舱：1.05 → 2.50
      { shape: 'box', position: [0, 1.775, -0.5], size: [2.0, 1.45, 4.2], color: 0xf2f6f8 },
      // 驾驶室：1.05 → 2.10
      { shape: 'box', position: [0, 1.575, 2.1], size: [2.0, 1.05, 1.4], color: 0xf2f6f8 },
      // 车窗带
      { shape: 'box', position: [0, 2.0, -0.5], size: [2.04, 0.5, 3.6], color: 0x2c3e50 },
      { shape: 'cylinder', position: [-0.95, 0.45, 1.9], size: [0.9, 0.3, 0.9], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [0.95, 0.45, 1.9], size: [0.9, 0.3, 0.9], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [-0.95, 0.45, -1.9], size: [0.9, 0.3, 0.9], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [0.95, 0.45, -1.9], size: [0.9, 0.3, 0.9], rotationZ: Math.PI / 2, color: 0x2c3e50 },
    ],
  },

  // ============================================================
  // 卡车（3）—— 车高统一按 3.5 m 的真实重卡量级
  // ============================================================
  // 厢式货车 2.55×3.5×7.2 —— 车高 3.5 m
  {
    id: 'box_truck',
    name: '厢式货车',
    category: '交通',
    subcategory: '卡车',
    type: 'vehicle',
    shape: 'custom',
    size: [2.55, 3.5, 7.2],
    // 包围盒体积 64.26 m³ × 等效密度 124 kg/m³ ≈ 8000 kg；按真实整备质量 8000 kg 校正
    mass: 8000,
    friction: 0.7,
    restitution: 0.1,
    color: 0xd8cbb5,
    icon: '🚚',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    // 货厢顶面平整，可在上面继续堆叠
    stackable: true,
    textureType: 'steel',
    tags: ['车辆', '货运', '厢式', '重载'],
    description: '厢式货车，驾驶室加密封货厢，车高 3.5 米。厢顶能站人，堆箱子不会掉。',
    parts: [
      // 车架：0.65 → 1.25
      { shape: 'box', position: [0, 0.95, 0], size: [2.4, 0.6, 7.2], color: 0x3a3f44 },
      // 驾驶室：1.25 → 3.15
      { shape: 'box', position: [0, 2.2, 2.6], size: [2.35, 1.9, 1.9], color: 0x2c6fb0 },
      // 货厢：1.25 → 3.50
      { shape: 'box', position: [0, 2.375, -1.1], size: [2.45, 2.25, 4.8], color: 0xd8cbb5 },
      { shape: 'cylinder', position: [-1.1, 0.5, 2.4], size: [1.0, 0.35, 1.0], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [1.1, 0.5, 2.4], size: [1.0, 0.35, 1.0], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [-1.1, 0.5, -2.4], size: [1.0, 0.35, 1.0], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [1.1, 0.5, -2.4], size: [1.0, 0.35, 1.0], rotationZ: Math.PI / 2, color: 0x2c3e50 },
    ],
  },
  // 自卸卡车 2.7×3.6×8.0 —— 车高 3.6 m，货斗比驾驶室矮一截
  {
    id: 'dump_truck',
    name: '自卸卡车',
    category: '交通',
    subcategory: '卡车',
    type: 'vehicle',
    shape: 'custom',
    size: [2.7, 3.6, 8.0],
    // 包围盒体积 77.76 m³ × 等效密度 154 kg/m³ ≈ 12000 kg；按真实整备质量 12000 kg 校正
    mass: 12000,
    friction: 0.75,
    restitution: 0.05,
    color: 0xd4a437,
    icon: '🚛',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    textureType: 'steel',
    tags: ['车辆', '工程', '自卸', '重载'],
    description: '自卸卡车，驾驶室后面挂一个大货斗，斗口敞开可以往里倒沙子或石块。',
    parts: [
      // 车架：0.65 → 1.35
      { shape: 'box', position: [0, 1.0, 0], size: [2.5, 0.7, 8.0], color: 0x3a3f44 },
      // 驾驶室：1.35 → 3.60
      { shape: 'box', position: [0, 2.475, 2.9], size: [2.45, 2.25, 2.0], color: 0xd4a437 },
      // 货斗：1.35 → 2.95
      { shape: 'box', position: [0, 2.15, -1.3], size: [2.5, 1.6, 4.6], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [-1.15, 0.55, 2.8], size: [1.1, 0.4, 1.1], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [1.15, 0.55, 2.8], size: [1.1, 0.4, 1.1], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [-1.15, 0.55, -2.8], size: [1.1, 0.4, 1.1], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [1.15, 0.55, -2.8], size: [1.1, 0.4, 1.1], rotationZ: Math.PI / 2, color: 0x2c3e50 },
    ],
  },
  // 消防车 2.64×3.5×8.4 —— 车高 3.5 m，顶上架云梯
  {
    id: 'fire_truck',
    name: '消防车',
    category: '交通',
    subcategory: '卡车',
    type: 'vehicle',
    shape: 'custom',
    size: [2.64, 3.5, 8.4],
    // 包围盒体积 77.6 m³ × 等效密度 180 kg/m³ ≈ 14000 kg；按真实整备质量 14000 kg 校正
    mass: 14000,
    friction: 0.75,
    restitution: 0.05,
    color: 0xc0392b,
    icon: '🚒',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    textureType: 'steel',
    tags: ['车辆', '消防', '云梯', '重载'],
    description: '消防车，红色车身配器材厢，车顶架着一部云梯。云梯是平的，可以踩上去搭高台。',
    parts: [
      // 车架：0.65 → 1.35
      { shape: 'box', position: [0, 1.0, 0], size: [2.5, 0.7, 8.4], color: 0x3a3f44 },
      // 驾驶室：1.35 → 3.50
      { shape: 'box', position: [0, 2.425, 3.1], size: [2.45, 2.15, 2.0], color: 0xc0392b },
      // 器材厢：1.35 → 3.35
      { shape: 'box', position: [0, 2.35, -1.5], size: [2.5, 2.0, 5.0], color: 0xc0392b },
      // 云梯：架在器材厢顶上，顶面 3.48
      { shape: 'box', position: [0, 3.4, -2.0], size: [0.5, 0.16, 4.0], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [-1.14, 0.525, 2.9], size: [1.05, 0.36, 1.05], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [1.14, 0.525, 2.9], size: [1.05, 0.36, 1.05], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [-1.14, 0.525, -2.9], size: [1.05, 0.36, 1.05], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [1.14, 0.525, -2.9], size: [1.05, 0.36, 1.05], rotationZ: Math.PI / 2, color: 0x2c3e50 },
    ],
  },

  // ============================================================
  // 公交（1）
  // ============================================================
  // 城市公交 2.7×3.2×11.0 —— 车高 3.2 m（真实城市客车 3.0~3.3 m）
  {
    id: 'city_bus',
    name: '城市公交',
    category: '交通',
    subcategory: '公交',
    type: 'vehicle',
    shape: 'custom',
    size: [2.7, 3.2, 11.0],
    // 包围盒体积 95.04 m³ × 等效密度 126 kg/m³ ≈ 12000 kg；按真实整备质量 12000 kg 校正
    mass: 12000,
    friction: 0.7,
    restitution: 0.15,
    color: 0xe8a33d,
    icon: '🚌',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    textureType: 'steel',
    tags: ['车辆', '客车', '公共交通', '六轮'],
    description: '城市公交，车长 11 米、车高 3.2 米，一条连续车窗带从前贯到后。车顶是平的。',
    parts: [
      // 车身：0.50 → 2.80
      { shape: 'box', position: [0, 1.65, 0], size: [2.5, 2.3, 11.0], color: 0xe8a33d },
      // 车窗带
      { shape: 'box', position: [0, 2.35, 0], size: [2.54, 0.8, 10.4], color: 0x2c3e50 },
      // 车顶：2.80 → 3.20
      { shape: 'box', position: [0, 3.0, 0], size: [2.4, 0.4, 10.6], color: 0xe8a33d },
      { shape: 'cylinder', position: [-1.15, 0.525, 3.4], size: [1.05, 0.4, 1.05], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [1.15, 0.525, 3.4], size: [1.05, 0.4, 1.05], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [-1.15, 0.525, -3.4], size: [1.05, 0.4, 1.05], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [1.15, 0.525, -3.4], size: [1.05, 0.4, 1.05], rotationZ: Math.PI / 2, color: 0x2c3e50 },
    ],
  },

  // ============================================================
  // 两轮（2）—— 重心窄，被压就倒，stackable 一律 false
  // ============================================================
  // 运动摩托 0.7×1.25×2.02
  {
    id: 'motorcycle_sport',
    name: '运动摩托',
    category: '交通',
    subcategory: '两轮',
    type: 'vehicle',
    shape: 'custom',
    size: [0.7, 1.25, 2.02],
    // 包围盒体积 1.77 m³；按真实整备质量 200 kg 校正（含油液）
    mass: 200,
    friction: 0.7,
    restitution: 0.35,
    color: 0x2c3e50,
    icon: '🏍️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    // 两个轮子撑不住东西，禁止在上面落位
    stackable: false,
    tags: ['车辆', '两轮', '机动', '单座'],
    description: '运动摩托，前后轮直径 0.62 米、车把横在车头。只有两个轮子，一压就倒，不能堆叠。',
    parts: [
      // 前轮 / 后轮：轴沿 X，轮底 y = 0
      { shape: 'cylinder', position: [0, 0.31, 0.7], size: [0.62, 0.14, 0.62], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [0, 0.31, -0.7], size: [0.62, 0.14, 0.62], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      // 车架
      { shape: 'box', position: [0, 0.75, 0], size: [0.4, 0.4, 1.4], color: 0x3a3f44 },
      // 油箱
      { shape: 'box', position: [0, 1.1, 0.1], size: [0.36, 0.3, 0.5], color: 0xc0392b },
      // 车把：整台车最宽的地方
      { shape: 'box', position: [0, 1.2, 0.62], size: [0.7, 0.06, 0.06], color: 0x9aa7b0 },
      // 座垫
      { shape: 'box', position: [0, 1.01, -0.35], size: [0.34, 0.12, 0.45], color: 0x2c3e50 },
      // 前叉
      { shape: 'box', position: [0, 0.6, 0.72], size: [0.08, 0.5, 0.08], color: 0x9aa7b0 },
    ],
  },
  // 山地自行车 0.5×1.15×1.78
  {
    id: 'bicycle_mtb',
    name: '山地自行车',
    category: '交通',
    subcategory: '两轮',
    type: 'vehicle',
    shape: 'custom',
    size: [0.5, 1.15, 1.78],
    // 包围盒体积 1.02 m³；按真实整备质量 15 kg 校正（铝架山地车）
    mass: 15,
    friction: 0.75,
    restitution: 0.3,
    color: 0xc0392b,
    icon: '🚲',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    // 立不住，禁止堆叠
    stackable: false,
    tags: ['车辆', '两轮', '人力', '自行车'],
    description: '山地自行车，轮径 0.68 米、车把宽 0.5 米。整台只有 15 公斤，随便一碰就倒。',
    parts: [
      { shape: 'cylinder', position: [0, 0.34, 0.55], size: [0.68, 0.06, 0.68], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [0, 0.34, -0.55], size: [0.68, 0.06, 0.68], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      // 车架
      { shape: 'box', position: [0, 0.85, 0], size: [0.06, 0.45, 0.9], color: 0xc0392b },
      // 车座
      { shape: 'box', position: [0, 1.11, -0.3], size: [0.22, 0.07, 0.12], color: 0x2c3e50 },
      // 车把
      { shape: 'box', position: [0, 1.1, 0.55], size: [0.5, 0.05, 0.05], color: 0x9aa7b0 },
      // 前叉
      { shape: 'box', position: [0, 0.85, 0.55], size: [0.05, 0.45, 0.05], color: 0x9aa7b0 },
    ],
  },

  // ============================================================
  // 船（2）—— 船底就是原点平面，可以直接放在水面上
  // ============================================================
  // 机动艇 1.9×1.55×4.6
  {
    id: 'motorboat',
    name: '机动艇',
    category: '交通',
    subcategory: '船',
    type: 'vehicle',
    shape: 'custom',
    size: [1.9, 1.55, 4.6],
    // 包围盒体积 13.55 m³；按真实整备质量 600 kg 校正（4.6 m 玻璃钢艇 + 舷外机）
    mass: 600,
    friction: 0.4,
    restitution: 0.15,
    color: 0xf2f6f8,
    icon: '🚤',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['船艇', '机动', '玻璃钢', '水面'],
    description: '机动艇，玻璃钢船体配甲板和驾驶台，船尾挂一台舷外机。平甲板可以站人。',
    parts: [
      // 船体：0 → 0.55
      { shape: 'box', position: [0, 0.275, 0], size: [1.9, 0.55, 4.6], color: 0xf2f6f8 },
      // 甲板
      { shape: 'box', position: [0, 0.6, 0], size: [1.7, 0.1, 4.2], color: 0xd8cbb5 },
      // 驾驶台：0.65 → 1.55
      { shape: 'box', position: [0, 1.1, 0.6], size: [1.3, 0.9, 1.2], color: 0x3f7fd0 },
      // 舷外机
      { shape: 'box', position: [0, 0.8, -2.15], size: [0.3, 0.5, 0.25], color: 0x3a3f44 },
    ],
  },
  // 龙骨帆船 2.4×9.0×7.0 —— 桅杆高 8 m（7 m 船长的真实桅高量级）
  {
    id: 'sailboat_keel',
    name: '龙骨帆船',
    category: '交通',
    subcategory: '船',
    type: 'vehicle',
    shape: 'custom',
    size: [2.4, 9.0, 7.0],
    // 包围盒体积 151.2 m³（大半是空气）；按真实整备质量 1500 kg 校正（7 m 龙骨帆船）
    mass: 1500,
    friction: 0.4,
    restitution: 0.1,
    color: 0xf2f6f8,
    icon: '⛵',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['船艇', '风帆', '龙骨', '水面'],
    description: '龙骨帆船，7 米船体配 8 米桅杆、主帆和前帆。甲板舱顶平整，可以站上去看风景。',
    parts: [
      // 船体：0 → 0.8
      { shape: 'box', position: [0, 0.4, 0], size: [2.4, 0.8, 7.0], color: 0xf2f6f8 },
      // 甲板舱：0.8 → 1.4
      { shape: 'box', position: [0, 1.1, 0.3], size: [1.8, 0.6, 2.4], color: 0x2c6fb0 },
      // 桅杆：1.0 → 9.0
      { shape: 'cylinder', position: [0, 5.0, 0], size: [0.16, 8.0, 0.16], color: 0x8b5a2b },
      // 主帆
      { shape: 'box', position: [0, 4.4, -1.0], size: [0.06, 5.6, 1.8], color: 0xf2f6f8 },
      // 前帆
      { shape: 'box', position: [0, 3.5, 1.5], size: [0.06, 3.4, 1.2], color: 0xf2f6f8 },
    ],
  },

  // ============================================================
  // 轨道（3）—— 标准轨距 1.435 m（钢轨中心距）
  // ============================================================
  // 直线轨道 4.0×0.18×1.505
  {
    id: 'track_straight',
    name: '直线轨道',
    category: '交通',
    subcategory: '轨道',
    type: 'structure',
    shape: 'custom',
    // 宽度 = 1.435 轨距 + 两侧轨头各 0.035 = 1.505，落在标准轨距的实测宽度区间内
    size: [4.0, 0.18, 1.505],
    // 体积 1.0836 m³ × 等效密度 554 kg/m³ ≈ 600 kg（两根 60 kg/m 钢轨各 4 m 共 480 kg + 三根混凝土枕木）
    mass: 4.0 * 0.18 * 1.505 * 554,
    friction: 0.5,
    restitution: 0.05,
    color: 0x9aa7b0,
    icon: '🛤️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['轨道', '钢轨', '标准轨距', '地面'],
    description: '一段 4 米长的直线轨道，**标准轨距 1.435 米**（钢轨中心距）。两根钢轨加三根枕木，可以首尾接起来铺长线。',
    parts: [
      // 两根钢轨：沿 X 走 4 m，中心距 1.435 m
      { shape: 'box', position: [0, 0.14, -0.7175], size: [4.0, 0.08, 0.07], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 0.14, 0.7175], size: [4.0, 0.08, 0.07], color: 0x9aa7b0 },
      // 三根枕木：垂直于钢轨，把轨距撑住
      { shape: 'box', position: [-1.6, 0.05, 0], size: [0.24, 0.1, 1.5], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.05, 0], size: [0.24, 0.1, 1.5], color: 0x8b5a2b },
      { shape: 'box', position: [1.6, 0.05, 0], size: [0.24, 0.1, 1.5], color: 0x8b5a2b },
    ],
  },
  // 弯道轨道 7.10×0.18×7.10 —— 90° 圆弧，中心线半径 6 m
  {
    id: 'track_curve',
    name: '弯道轨道',
    category: '交通',
    subcategory: '轨道',
    type: 'structure',
    shape: 'custom',
    size: [7.1, 0.18, 7.1],
    // 体积 9.07 m³ × 等效密度 88 kg/m³ ≈ 800 kg（6 段短轨 + 2 根枕木，包围盒里大半是空地）
    mass: 7.1 * 0.18 * 7.1 * 88,
    friction: 0.5,
    restitution: 0.05,
    color: 0x9aa7b0,
    icon: '🚉',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['轨道', '弯道', '标准轨距', '弧线'],
    description: '90° 弯道轨道，中心线半径 6 米、**轨距同样是 1.435 米**。用 3 段短直轨近似圆弧，两端可以和直线轨道对接。',
    parts: [
      // 内轨 3 段（半径 5.2825）
      { shape: 'box', position: [1.7222, 0.14, -2.0131], size: [3.17, 0.08, 0.07], rotationY: -1.8326, color: 0x9aa7b0 },
      { shape: 'box', position: [0.355, 0.14, 0.355], size: [3.17, 0.08, 0.07], rotationY: -2.3562, color: 0x9aa7b0 },
      { shape: 'box', position: [-2.0131, 0.14, 1.7222], size: [3.17, 0.08, 0.07], rotationY: -2.8798, color: 0x9aa7b0 },
      // 外轨 3 段（半径 6.7175）
      { shape: 'box', position: [3.1083, 0.14, -1.6416], size: [3.17, 0.08, 0.07], rotationY: -1.8326, color: 0x9aa7b0 },
      { shape: 'box', position: [1.3697, 0.14, 1.3697], size: [3.17, 0.08, 0.07], rotationY: -2.3562, color: 0x9aa7b0 },
      { shape: 'box', position: [-1.6416, 0.14, 3.1083], size: [3.17, 0.08, 0.07], rotationY: -2.8798, color: 0x9aa7b0 },
      // 两根枕木：横跨轨距
      { shape: 'box', position: [1.8159, 0.05, -0.3803], size: [0.24, 0.1, 1.5], rotationY: 1.0472, color: 0x8b5a2b },
      { shape: 'box', position: [-0.3803, 0.05, 1.8159], size: [0.24, 0.1, 1.5], rotationY: 0.5236, color: 0x8b5a2b },
    ],
  },
  // 火车客车厢 3.14×3.6×24.0 —— 车高 3.6 m（真实客车 3.4~4.0 m 量级）
  {
    id: 'train_coach',
    name: '火车客车厢',
    category: '交通',
    subcategory: '轨道',
    type: 'vehicle',
    shape: 'custom',
    size: [3.14, 3.6, 24.0],
    // 包围盒体积 271.3 m³；按真实整备质量 42000 kg 校正（25 型客车自重 40~45 t）
    mass: 42000,
    friction: 0.3,
    restitution: 0.1,
    color: 0x2c6fb0,
    icon: '🚃',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    textureType: 'steel',
    tags: ['列车', '轨道', '客运', '长车体'],
    description: '火车客车厢，长 24 米、宽 3.14 米、车高 3.6 米，一条车窗带从前贯到后。车顶平整可以走。',
    parts: [
      // 底架：0.80 → 1.30
      { shape: 'box', position: [0, 1.05, 0], size: [3.0, 0.5, 24.0], color: 0x3a3f44 },
      // 车体：1.30 → 3.40
      { shape: 'box', position: [0, 2.35, 0], size: [3.1, 2.1, 24.0], color: 0x2c6fb0 },
      // 车窗带（也是整车最宽处）
      { shape: 'box', position: [0, 2.7, 0], size: [3.14, 0.7, 22.0], color: 0x2c3e50 },
      // 车顶：3.40 → 3.60
      { shape: 'box', position: [0, 3.5, 0], size: [2.9, 0.2, 23.0], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [-1.05, 0.45, 8.0], size: [0.9, 0.3, 0.9], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [1.05, 0.45, 8.0], size: [0.9, 0.3, 0.9], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [-1.05, 0.45, -8.0], size: [0.9, 0.3, 0.9], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      { shape: 'cylinder', position: [1.05, 0.45, -8.0], size: [0.9, 0.3, 0.9], rotationZ: Math.PI / 2, color: 0x2c3e50 },
    ],
  },

  // ============================================================
  // 道路设施（5）
  // ============================================================
  // 红绿灯 0.5×3.72×0.37
  {
    id: 'traffic_light',
    name: '红绿灯',
    category: '交通',
    subcategory: '道路设施',
    type: 'structure',
    shape: 'custom',
    size: [0.5, 3.72, 0.5],
    // 体积 0.93 m³ × 等效密度 150 kg/m³ ≈ 140 kg（钢杆 + 铝灯箱 + 灯头）
    mass: 0.5 * 3.72 * 0.5 * 150,
    friction: 0.5,
    restitution: 0.1,
    color: 0x3a3f44,
    icon: '🚦',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['交通设施', '信号灯', '路口', '红黄绿'],
    description: '红绿灯，3.6 米立杆顶着灯箱，箱面三个压扁的圆球代表红黄绿。灯箱背面可以贴到路口转角。',
    parts: [
      // 底盘
      { shape: 'cylinder', position: [0, 0.06, 0], size: [0.5, 0.12, 0.5], color: 0x9aa7b0 },
      // 立杆：0.12 → 3.72
      { shape: 'cylinder', position: [0, 1.92, 0], size: [0.16, 3.6, 0.16], color: 0x9aa7b0 },
      // 灯箱：2.69 → 3.71
      { shape: 'box', position: [0, 3.2, -0.03], size: [0.36, 1.02, 0.3], color: 0x3a3f44 },
      // 三个灯头：sphere 压扁成片状，嵌在灯箱正面
      { shape: 'sphere', position: [0, 3.6, 0.15], size: [0.22, 0.22, 0.08], color: 0xc0392b },
      { shape: 'sphere', position: [0, 3.2, 0.15], size: [0.22, 0.22, 0.08], color: 0xd4a437 },
      { shape: 'sphere', position: [0, 2.8, 0.15], size: [0.22, 0.22, 0.08], color: 0x4f9d3f },
    ],
  },
  // 路牌 1.6×2.35×0.105
  {
    id: 'road_sign',
    name: '路牌',
    category: '交通',
    subcategory: '道路设施',
    type: 'structure',
    shape: 'custom',
    size: [1.6, 2.35, 0.5],
    // 体积 1.88 m³ × 等效密度 40 kg/m³ ≈ 75 kg（牌面是薄铝板，包围盒里几乎都是空气）
    mass: 1.6 * 2.35 * 0.5 * 40,
    friction: 0.5,
    restitution: 0.1,
    color: 0x2c6fb0,
    icon: '🪧',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['交通设施', '指示牌', '路标', '蓝色'],
    description: '蓝底白字路牌，2.2 米立杆托着牌面，牌顶 2.35 米。可以排在路口给玩家指方向。',
    parts: [
      { shape: 'box', position: [0, 0.05, 0], size: [0.5, 0.1, 0.5], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0, 1.2, 0], size: [0.12, 2.2, 0.12], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 2.1, 0], size: [1.6, 0.5, 0.08], color: 0x2c6fb0 },
      { shape: 'box', position: [0, 2.1, 0.05], size: [1.44, 0.34, 0.03], color: 0xf2f6f8 },
    ],
  },
  // 护栏 4.0×0.9×0.12
  {
    id: 'guardrail',
    name: '护栏',
    category: '交通',
    subcategory: '道路设施',
    type: 'structure',
    shape: 'custom',
    size: [4.0, 0.9, 0.12],
    // 体积 0.432 m³ × 等效密度 231 kg/m³；按真实 4 m 波形梁护栏段 ≈100 kg 校正
    mass: 100,
    friction: 0.6,
    restitution: 0.15,
    color: 0x9aa7b0,
    icon: '🚧',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['交通设施', '护栏', '防撞', '路侧'],
    description: '路侧防撞护栏，4 米两根横梁配三根立柱，梁顶 0.9 米。沿路排开就能围出车道。',
    parts: [
      // 三根立柱
      { shape: 'box', position: [-1.4, 0.45, 0], size: [0.12, 0.9, 0.12], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 0.45, 0], size: [0.12, 0.9, 0.12], color: 0x9aa7b0 },
      { shape: 'box', position: [1.4, 0.45, 0], size: [0.12, 0.9, 0.12], color: 0x9aa7b0 },
      // 上横梁
      { shape: 'box', position: [0, 0.72, 0], size: [4.0, 0.35, 0.06], color: 0xcfd6da },
      // 下横梁
      { shape: 'box', position: [0, 0.4, 0], size: [4.0, 0.28, 0.06], color: 0xcfd6da },
    ],
  },
  // 加油站 6.0×4.6×4.0
  {
    id: 'gas_station',
    name: '加油站',
    category: '交通',
    subcategory: '道路设施',
    type: 'structure',
    shape: 'custom',
    size: [6.0, 4.6, 4.0],
    // 体积 110.4 m³ × 等效密度 27 kg/m³ ≈ 3000 kg（钢架顶棚只占包围盒很小一部分）
    mass: 6.0 * 4.6 * 4.0 * 27,
    friction: 0.7,
    restitution: 0.05,
    color: 0xe8a33d,
    icon: '⛽',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'stone',
    tags: ['交通设施', '加油', '雨棚', '服务区'],
    description: '加油站，四根立柱撑起 6×4 米雨棚，棚下站着一台加油机。雨棚顶面是平的，可以站上去。',
    parts: [
      // 顶棚：4.20 → 4.60
      { shape: 'box', position: [0, 4.4, 0], size: [6.0, 0.4, 4.0], color: 0xe8a33d },
      // 四根立柱：0 → 4.20
      { shape: 'box', position: [-2.6, 2.1, 1.6], size: [0.3, 4.2, 0.3], color: 0x9aa7b0 },
      { shape: 'box', position: [2.6, 2.1, 1.6], size: [0.3, 4.2, 0.3], color: 0x9aa7b0 },
      { shape: 'box', position: [-2.6, 2.1, -1.6], size: [0.3, 4.2, 0.3], color: 0x9aa7b0 },
      { shape: 'box', position: [2.6, 2.1, -1.6], size: [0.3, 4.2, 0.3], color: 0x9aa7b0 },
      // 加油机
      { shape: 'box', position: [0, 0.8, 0.6], size: [0.9, 1.6, 0.6], color: 0xf2f6f8 },
    ],
  },
  // 停车场 6.0×0.12×10.0
  {
    id: 'parking_lot',
    name: '停车场',
    category: '交通',
    subcategory: '道路设施',
    type: 'structure',
    shape: 'cuboid',
    size: [6.0, 0.12, 10.0],
    // 沥青铺装：体积 7.2 m³ × 等效密度 208 kg/m³ ≈ 1500 kg（60 m² × 0.1 m）
    mass: 6.0 * 0.12 * 10.0 * 208,
    friction: 0.85,
    restitution: 0.02,
    color: 0x3a3f44,
    icon: '🅿️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'stone',
    tags: ['交通设施', '铺装', '车位', '地面'],
    description: '停车场铺装，6×10 米的沥青地坪加三条车位线，可以停三台车。整块只有 0.12 米厚。',
    parts: [
      // 地坪：0 → 0.10
      { shape: 'box', position: [0, 0.05, 0], size: [6.0, 0.1, 10.0], color: 0x3a3f44 },
      // 三条白色车位分隔线
      { shape: 'box', position: [-1.5, 0.11, 0], size: [0.12, 0.02, 5.0], color: 0xf2f6f8 },
      { shape: 'box', position: [0, 0.11, 0], size: [0.12, 0.02, 5.0], color: 0xf2f6f8 },
      { shape: 'box', position: [1.5, 0.11, 0], size: [0.12, 0.02, 5.0], color: 0xf2f6f8 },
    ],
  },
];
