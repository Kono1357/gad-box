import type { BuildingDef } from '../../building/types';

/**
 * 家具类建筑模型（28 个，M4 新增）。
 *
 * 约定（与 `buildings/structure.ts` 一致，但更严格）：
 * - **原点在底面中心**，所以每个模型所有 part 的最低点必须正好落在 y = 0；
 * - `size` 必须等于 parts 的实际包围盒：`size[i] = max(i) - min(i)`，
 *   每个 part 的占用区间是 `position[i] ± size[i] / 2`（无旋转时）；
 * - `mass` = **外包围盒体积 × 材料密度**，密度取真实量级：
 *   木材 650 / 板材（刨花板）700 / 钢 7800 / 铝 2700 / 塑料 950 / 玻璃 2500 / 陶瓷 2300 / 织物 300。
 *   空心家具按外包围盒口径折算，注释里写明了用的是哪种材料密度；
 * - `stackable` 描述"能不能被别的物体压在上面"：桌 / 椅 / 柜 / 台面这些有水平承重面的给 `true`，
 *   本轮家具全部是稳定家具，因此都是 `true`。
 *
 * 拼装尺寸刻意对齐真实家具：桌面高 0.75、椅子坐面 0.45、椅子宽 0.46~0.55、
 * 柜类深度 0.4~0.6，单人床 1.0×2.0、双人床 1.5×2.0（床垫顶面 0.5）。
 */
export const FURNITURE_ITEMS: BuildingDef[] = [
  // ============================================================
  // 桌（7）—— 桌面统一 0.75 米
  // ============================================================
  // 长方形餐桌 1.4×0.75×0.8：桌面 + 4 条腿
  {
    id: 'dining_table_rect',
    name: '长方形餐桌',
    category: '家具',
    subcategory: '桌',
    type: 'furniture',
    shape: 'custom',
    size: [1.4, 0.75, 0.8],
    // 质量：1.4×0.75×0.8 m³ × 木材 650 kg/m³
    mass: 1.4 * 0.75 * 0.8 * 650, // 密度 650
    friction: 0.6,
    restitution: 0.12,
    color: 0x8b5a2b,
    icon: '🍽️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['桌子', '餐桌', '木制', '家具'],
    description: '长方形餐桌，桌面高零点七五米，长边坐三个人、短边各坐一个，共六人位。',
    parts: [
      { shape: 'box', position: [0, 0.725, 0], size: [1.4, 0.05, 0.8], color: 0x8b5a2b },
      { shape: 'box', position: [-0.62, 0.35, -0.32], size: [0.08, 0.7, 0.08], color: 0x7a4b23 },
      { shape: 'box', position: [0.62, 0.35, -0.32], size: [0.08, 0.7, 0.08], color: 0x7a4b23 },
      { shape: 'box', position: [-0.62, 0.35, 0.32], size: [0.08, 0.7, 0.08], color: 0x7a4b23 },
      { shape: 'box', position: [0.62, 0.35, 0.32], size: [0.08, 0.7, 0.08], color: 0x7a4b23 },
    ],
  },

  // 圆形餐桌 1.2×0.75×1.2：圆桌面 + 立柱 + 圆底盘
  {
    id: 'dining_table_round',
    name: '圆形餐桌',
    category: '家具',
    subcategory: '桌',
    type: 'furniture',
    shape: 'cylinder',
    size: [1.2, 0.75, 1.2],
    // 质量：1.2×0.75×1.2 m³ × 木材 650 kg/m³（圆桌按外接方盒折算）
    mass: 1.2 * 0.75 * 1.2 * 650, // 密度 650
    friction: 0.6,
    restitution: 0.12,
    color: 0x9b6a3a,
    icon: '🪑',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['桌子', '餐桌', '木制', '圆形'],
    description: '圆形餐桌，直径一点二米，中央立柱配圆底盘，四条腿换成一根柱子省地方。',
    parts: [
      { shape: 'cylinder', position: [0, 0.725, 0], size: [1.2, 0.05, 1.2], color: 0x9b6a3a },
      { shape: 'cylinder', position: [0, 0.39, 0], size: [0.16, 0.62, 0.16], color: 0x8b5a2b },
      { shape: 'cylinder', position: [0, 0.04, 0], size: [0.7, 0.08, 0.7], color: 0x7a4b23 },
    ],
  },

  // 办公桌 1.2×0.75×0.6：桌面 + 侧板 + 抽屉柜
  {
    id: 'desk_office',
    name: '办公桌',
    category: '家具',
    subcategory: '桌',
    type: 'furniture',
    shape: 'custom',
    size: [1.2, 0.75, 0.6],
    // 质量：1.2×0.75×0.6 m³ × 刨花板 700 kg/m³
    mass: 1.2 * 0.75 * 0.6 * 700, // 密度 700
    friction: 0.6,
    restitution: 0.1,
    color: 0xc9a882,
    icon: '🖥️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['桌子', '办公桌', '板材', '办公'],
    description: '办公桌，一米二宽，一侧是落地侧板，另一侧是带抽屉的柜体，桌面高零点七五米。',
    parts: [
      { shape: 'box', position: [0, 0.725, 0], size: [1.2, 0.05, 0.6], color: 0xc9a882 },
      { shape: 'box', position: [-0.575, 0.35, 0], size: [0.05, 0.7, 0.55], color: 0xb99a74 },
      { shape: 'box', position: [0.4, 0.35, 0], size: [0.34, 0.7, 0.55], color: 0xb99a74 },
      { shape: 'box', position: [0.4, 0.55, 0.28], size: [0.3, 0.18, 0.03], color: 0xc9a882 },
      { shape: 'box', position: [0.4, 0.55, 0.285], size: [0.12, 0.03, 0.03], color: 0x9aa7b0 },
    ],
  },

  // 会议桌 2.4×0.75×1.0：桌面 + 两条支腿 + 横梁
  {
    id: 'conference_table',
    name: '会议桌',
    category: '家具',
    subcategory: '桌',
    type: 'furniture',
    shape: 'custom',
    size: [2.4, 0.75, 1.0],
    // 质量：2.4×0.75×1.0 m³ × 刨花板 700 kg/m³
    mass: 2.4 * 0.75 * 1.0 * 700, // 密度 700
    friction: 0.62,
    restitution: 0.1,
    color: 0x9b6a3a,
    icon: '📋',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    lodLevels: 2,
    tags: ['桌子', '会议桌', '板材', '办公'],
    description: '两米四长的会议桌，两端木支腿加中间横梁，够坐八个人开会。',
    parts: [
      { shape: 'box', position: [0, 0.72, 0], size: [2.4, 0.06, 1.0], color: 0x9b6a3a },
      { shape: 'box', position: [-1.0, 0.345, 0], size: [0.12, 0.69, 0.85], color: 0x8b5a2b },
      { shape: 'box', position: [1.0, 0.345, 0], size: [0.12, 0.69, 0.85], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.6, 0], size: [1.6, 0.12, 0.12], color: 0x7a4b23 },
    ],
  },

  // 茶几 1.2×0.42×0.6：矮桌面 + 4 条细腿
  {
    id: 'coffee_table',
    name: '茶几',
    category: '家具',
    subcategory: '茶几',
    type: 'furniture',
    shape: 'custom',
    size: [1.2, 0.42, 0.6],
    // 质量：1.2×0.42×0.6 m³ × 木材 650 kg/m³
    mass: 1.2 * 0.42 * 0.6 * 650, // 密度 650
    friction: 0.6,
    restitution: 0.12,
    color: 0x8b5a2b,
    icon: '🫖',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['桌子', '茶几', '木制', '客厅'],
    description: '客厅茶几，一米二长、四面抬高的矮桌面（高零点四二米，比餐桌矮）配四根细腿，放在沙发前面正好。',
    parts: [
      { shape: 'box', position: [0, 0.395, 0], size: [1.2, 0.05, 0.6], color: 0x8b5a2b },
      { shape: 'box', position: [-0.55, 0.185, -0.25], size: [0.06, 0.37, 0.06], color: 0x7a4b23 },
      { shape: 'box', position: [0.55, 0.185, -0.25], size: [0.06, 0.37, 0.06], color: 0x7a4b23 },
      { shape: 'box', position: [-0.55, 0.185, 0.25], size: [0.06, 0.37, 0.06], color: 0x7a4b23 },
      { shape: 'box', position: [0.55, 0.185, 0.25], size: [0.06, 0.37, 0.06], color: 0x7a4b23 },
    ],
  },

  // 梳妆台 1.0×1.7×0.44：台面 + 侧柜 + 立式镜
  {
    id: 'dressing_table',
    name: '梳妆台',
    category: '家具',
    subcategory: '桌',
    type: 'furniture',
    shape: 'custom',
    size: [1.0, 1.7, 0.44],
    // 质量：1.0×1.7×0.44 m³ × 刨花板 700 kg/m³
    mass: 1.0 * 1.7 * 0.44 * 700, // 密度 700
    friction: 0.6,
    restitution: 0.1,
    color: 0xd8cbb5,
    icon: '💄',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['桌子', '梳妆台', '镜子', '卧室'],
    description: '梳妆台，侧面是抽屉柜，后沿立起一面木框镜子，台面高零点七五米。',
    parts: [
      { shape: 'box', position: [0, 0.725, 0], size: [1.0, 0.05, 0.4], color: 0xd8cbb5 },
      { shape: 'box', position: [-0.47, 0.35, 0], size: [0.06, 0.7, 0.38], color: 0xb99a74 },
      { shape: 'box', position: [0.32, 0.35, 0], size: [0.32, 0.7, 0.38], color: 0xb99a74 },
      { shape: 'box', position: [0, 1.32, -0.19], size: [0.72, 0.62, 0.04], color: 0xdfeef7 },
      { shape: 'box', position: [0, 1.34, -0.16], size: [0.8, 0.72, 0.03], color: 0x8b5a2b },
      { shape: 'box', position: [0.32, 0.55, 0.205], size: [0.28, 0.16, 0.03], color: 0xc9a882 },
      { shape: 'box', position: [0.32, 0.55, 0.22], size: [0.12, 0.03, 0.02], color: 0xc9a227 },
    ],
  },

  // 边几 0.5×0.75×0.5：小方桌面 + 4 腿 + 下层隔板
  {
    id: 'side_table',
    name: '边几',
    category: '家具',
    subcategory: '桌',
    type: 'furniture',
    shape: 'custom',
    size: [0.5, 0.75, 0.5],
    // 质量：0.5×0.75×0.5 m³ × 木材 650 kg/m³
    mass: 0.5 * 0.75 * 0.5 * 650, // 密度 650
    friction: 0.6,
    restitution: 0.12,
    color: 0x8b5a2b,
    icon: '🪴',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['桌子', '边几', '木制', '客厅'],
    description: '半米见方的小边几，桌面板下面还有一层隔板，塞在沙发或床角刚好。',
    parts: [
      { shape: 'box', position: [0, 0.73, 0], size: [0.5, 0.04, 0.5], color: 0x8b5a2b },
      { shape: 'box', position: [-0.22, 0.355, -0.22], size: [0.05, 0.71, 0.05], color: 0x7a4b23 },
      { shape: 'box', position: [0.22, 0.355, -0.22], size: [0.05, 0.71, 0.05], color: 0x7a4b23 },
      { shape: 'box', position: [-0.22, 0.355, 0.22], size: [0.05, 0.71, 0.05], color: 0x7a4b23 },
      { shape: 'box', position: [0.22, 0.355, 0.22], size: [0.05, 0.71, 0.05], color: 0x7a4b23 },
      { shape: 'box', position: [0, 0.3, 0], size: [0.42, 0.03, 0.42], color: 0x9b6a3a },
    ],
  },

  // ============================================================
  // 椅（6）—— 坐面统一 0.45 米，宽度 0.4~0.6 米
  // ============================================================
  // 餐椅 0.46×0.93×0.5：坐面 + 靠背 + 左右腿架 + 横撑
  {
    id: 'dining_chair',
    name: '餐椅',
    category: '家具',
    subcategory: '椅',
    type: 'furniture',
    shape: 'custom',
    size: [0.46, 0.93, 0.5],
    // 质量：0.46×0.93×0.5 m³ × 木材 650 kg/m³
    mass: 0.46 * 0.93 * 0.5 * 650, // 密度 650
    friction: 0.6,
    restitution: 0.12,
    color: 0x8b5a2b,
    icon: '🪑',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['椅子', '餐椅', '木制', '家具'],
    description: '餐椅，坐面高零点四五米、宽零点四六米，两张并排正好塞进一米二的桌子。',
    // 四条腿用左右两块腿架合并表达（每个 box 覆盖前后两条腿），省下 2 个 part 名额
    parts: [
      { shape: 'box', position: [0, 0.425, 0], size: [0.46, 0.05, 0.5], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.705, -0.22], size: [0.46, 0.45, 0.06], color: 0x8b5a2b },
      { shape: 'box', position: [-0.2, 0.2, 0], size: [0.06, 0.4, 0.44], color: 0x7a4b23 },
      { shape: 'box', position: [0.2, 0.2, 0], size: [0.06, 0.4, 0.44], color: 0x7a4b23 },
      { shape: 'box', position: [0, 0.15, 0.2], size: [0.46, 0.04, 0.04], color: 0x7a4b23 },
    ],
  },

  // 办公椅 0.6×1.15×0.6：五星脚 + 气压杆 + 坐垫 + 靠背 + 头枕 + 扶手
  {
    id: 'office_chair',
    name: '办公椅',
    category: '家具',
    subcategory: '椅',
    type: 'furniture',
    shape: 'custom',
    size: [0.6, 1.15, 0.6],
    // 质量：0.6×1.15×0.6 m³ × 塑料 950 kg/m³
    mass: 0.6 * 1.15 * 0.6 * 950, // 密度 950
    friction: 0.55,
    restitution: 0.15,
    color: 0x3a4048,
    icon: '💺',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['椅子', '办公椅', '转椅', '办公'],
    description: '转椅式办公椅，五星脚加气压杆，坐面高零点四五米，带头枕与两侧扶手。',
    parts: [
      { shape: 'cylinder', position: [0, 0.03, 0], size: [0.6, 0.06, 0.6], color: 0x2c3e50 },
      { shape: 'cylinder', position: [0, 0.215, 0], size: [0.08, 0.31, 0.08], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 0.41, 0], size: [0.5, 0.08, 0.5], color: 0x3a4048 },
      { shape: 'box', position: [0, 0.8, -0.24], size: [0.48, 0.6, 0.08], color: 0x3a4048 },
      { shape: 'box', position: [0, 1.09, -0.24], size: [0.34, 0.12, 0.08], color: 0x4a5560 },
      { shape: 'box', position: [-0.26, 0.55, 0], size: [0.08, 0.06, 0.4], color: 0x4a5560 },
      { shape: 'box', position: [0.26, 0.55, 0], size: [0.08, 0.06, 0.4], color: 0x4a5560 },
    ],
  },

  // 吧椅 0.4×1.05×0.4：圆底盘 + 立柱 + 高坐面 + 靠背 + 踏脚环
  {
    id: 'bar_stool',
    name: '吧椅',
    category: '家具',
    subcategory: '椅',
    type: 'furniture',
    shape: 'custom',
    size: [0.4, 1.05, 0.4],
    // 质量：0.4×1.05×0.4 m³ × 塑料 950 kg/m³
    mass: 0.4 * 1.05 * 0.4 * 950, // 密度 950
    friction: 0.55,
    restitution: 0.14,
    color: 0xc0392b,
    icon: '🍸',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['椅子', '吧椅', '高脚', '吧台'],
    description: '吧椅，坐面高零点七五米，圆底盘配立柱和踏脚环，配吧台正好。',
    parts: [
      { shape: 'cylinder', position: [0, 0.025, 0], size: [0.4, 0.05, 0.4], color: 0x5a636b },
      { shape: 'cylinder', position: [0, 0.365, 0], size: [0.06, 0.63, 0.06], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 0.715, 0], size: [0.38, 0.07, 0.38], color: 0xc0392b },
      { shape: 'cylinder', position: [0, 0.25, 0], size: [0.3, 0.04, 0.3], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 0.9, -0.16], size: [0.34, 0.3, 0.06], color: 0xc0392b },
    ],
  },

  // 扶手椅 0.7×0.95×0.75：底座 + 坐垫 + 靠背 + 两扶手
  {
    id: 'armchair',
    name: '扶手椅',
    category: '家具',
    subcategory: '椅',
    type: 'furniture',
    shape: 'custom',
    size: [0.7, 0.95, 0.75],
    // 质量：0.7×0.95×0.75 m³ × 织物 300 kg/m³
    mass: 0.7 * 0.95 * 0.75 * 300, // 密度 300
    friction: 0.72,
    restitution: 0.06,
    color: 0xb0563c,
    icon: '🛋️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['椅子', '扶手椅', '软装', '客厅'],
    description: '单人扶手椅，布艺座包配硬质底座，坐面高零点四五米，两侧扶手包到后背。',
    parts: [
      { shape: 'box', position: [0, 0.16, 0], size: [0.7, 0.32, 0.75], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.385, 0.03], size: [0.56, 0.13, 0.6], color: 0xb0563c },
      { shape: 'box', position: [0, 0.635, -0.295], size: [0.7, 0.63, 0.16], color: 0xb0563c },
      { shape: 'box', position: [-0.29, 0.55, 0], size: [0.12, 0.5, 0.75], color: 0xa04d35 },
      { shape: 'box', position: [0.29, 0.55, 0], size: [0.12, 0.5, 0.75], color: 0xa04d35 },
    ],
  },

  // 长椅 1.6×0.95×0.5：座面 + 两块支腿 + 靠背
  {
    id: 'bench_wood_long',
    name: '长椅',
    category: '家具',
    subcategory: '椅',
    type: 'furniture',
    shape: 'custom',
    size: [1.6, 0.95, 0.5],
    // 质量：1.6×0.95×0.5 m³ × 木材 650 kg/m³
    mass: 1.6 * 0.95 * 0.5 * 650, // 密度 650
    friction: 0.62,
    restitution: 0.12,
    color: 0x8b5a2b,
    icon: '🪑',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['长椅', '木制', '家具', '户外'],
    description: '一点六米长的木长椅，坐面高零点四五米，两端支腿加通长靠背，走廊和公园都能放。',
    parts: [
      { shape: 'box', position: [0, 0.41, 0], size: [1.6, 0.08, 0.5], color: 0x8b5a2b },
      { shape: 'box', position: [-0.66, 0.185, 0], size: [0.12, 0.37, 0.42], color: 0x7a4b23 },
      { shape: 'box', position: [0.66, 0.185, 0], size: [0.12, 0.37, 0.42], color: 0x7a4b23 },
      { shape: 'box', position: [0, 0.72, -0.22], size: [1.6, 0.46, 0.06], color: 0x8b5a2b },
    ],
  },

  // 木凳 0.4×0.45×0.4：凳面 + 前后腿板
  {
    id: 'stool_wood',
    name: '木凳',
    category: '家具',
    subcategory: '椅',
    type: 'furniture',
    shape: 'custom',
    size: [0.4, 0.45, 0.4],
    // 质量：0.4×0.45×0.4 m³ × 木材 650 kg/m³
    mass: 0.4 * 0.45 * 0.4 * 650, // 密度 650
    friction: 0.6,
    restitution: 0.12,
    color: 0x9b6a3a,
    icon: '🪑',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['凳子', '木制', '家具'],
    description: '木凳，坐面高零点四五米，前后两块腿板撑住凳面，可以塞到桌子下面。',
    parts: [
      { shape: 'box', position: [0, 0.425, 0], size: [0.4, 0.05, 0.4], color: 0x9b6a3a },
      { shape: 'box', position: [0, 0.2, -0.17], size: [0.34, 0.4, 0.06], color: 0x7a4b23 },
      { shape: 'box', position: [0, 0.2, 0.17], size: [0.34, 0.4, 0.06], color: 0x7a4b23 },
    ],
  },

  // ============================================================
  // 沙发（3）
  // ============================================================
  // 三人沙发 1.9×0.9×0.85
  {
    id: 'sofa_three_seat',
    name: '三人沙发',
    category: '家具',
    subcategory: '沙发',
    type: 'furniture',
    shape: 'custom',
    size: [1.9, 0.9, 0.85],
    // 质量：1.9×0.9×0.85 m³ × 织物 300 kg/m³
    mass: 1.9 * 0.9 * 0.85 * 300, // 密度 300
    friction: 0.75,
    restitution: 0.05,
    color: 0x5b6b7c,
    icon: '🛋️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    lodLevels: 2,
    tags: ['沙发', '三人位', '客厅', '软装'],
    description: '三人沙发，一点九米长，厚坐垫加通长靠背，两侧扶手各占十五厘米。',
    parts: [
      { shape: 'box', position: [0, 0.175, 0], size: [1.9, 0.35, 0.85], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.425, 0.045], size: [1.7, 0.15, 0.72], color: 0x5b6b7c },
      { shape: 'box', position: [0, 0.7, -0.325], size: [1.9, 0.4, 0.2], color: 0x5b6b7c },
      { shape: 'box', position: [-0.89, 0.6, 0], size: [0.12, 0.5, 0.85], color: 0x4d5b6a },
      { shape: 'box', position: [0.89, 0.6, 0], size: [0.12, 0.5, 0.85], color: 0x4d5b6a },
    ],
  },

  // 双人沙发 1.5×0.9×0.85
  {
    id: 'sofa_two_seat',
    name: '双人沙发',
    category: '家具',
    subcategory: '沙发',
    type: 'furniture',
    shape: 'custom',
    size: [1.5, 0.9, 0.85],
    // 质量：1.5×0.9×0.85 m³ × 织物 300 kg/m³
    mass: 1.5 * 0.9 * 0.85 * 300, // 密度 300
    friction: 0.75,
    restitution: 0.05,
    color: 0x7c6a5b,
    icon: '🛋️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['沙发', '双人位', '客厅', '软装'],
    description: '双人沙发，一点五米长，是三人沙发的短版，小客厅或书房里更合适。',
    parts: [
      { shape: 'box', position: [0, 0.175, 0], size: [1.5, 0.35, 0.85], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.425, 0.045], size: [1.3, 0.15, 0.72], color: 0x7c6a5b },
      { shape: 'box', position: [0, 0.7, -0.325], size: [1.5, 0.4, 0.2], color: 0x7c6a5b },
      { shape: 'box', position: [-0.69, 0.6, 0], size: [0.12, 0.5, 0.85], color: 0x6b5a4c },
      { shape: 'box', position: [0.69, 0.6, 0], size: [0.12, 0.5, 0.85], color: 0x6b5a4c },
    ],
  },

  // L 形转角沙发 2.4×0.85×1.6：主座 + 贵妃位 + 靠背 + 两扶手（7 part）
  {
    id: 'sofa_l_corner',
    name: 'L 形转角沙发',
    category: '家具',
    subcategory: '沙发',
    type: 'furniture',
    shape: 'custom',
    size: [2.4, 0.85, 1.6],
    // 质量：2.4×0.85×1.6 m³ × 织物 300 kg/m³
    mass: 2.4 * 0.85 * 1.6 * 300, // 密度 300
    friction: 0.75,
    restitution: 0.05,
    color: 0x4a6376,
    icon: '🛋️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    lodLevels: 2,
    tags: ['沙发', '转角', '客厅', '软装'],
    description: 'L 形转角沙发，两米四长边接一个一米六的贵妃位，围出客厅的会客角。',
    parts: [
      { shape: 'box', position: [-0.4, 0.175, -0.4], size: [1.6, 0.35, 0.8], color: 0x8b5a2b },
      { shape: 'box', position: [0.8, 0.175, 0], size: [0.8, 0.35, 1.6], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.6, -0.7], size: [2.4, 0.5, 0.2], color: 0x4a6376 },
      { shape: 'box', position: [-1.11, 0.575, -0.4], size: [0.18, 0.45, 0.8], color: 0x3c5261 },
      { shape: 'box', position: [1.11, 0.575, 0], size: [0.18, 0.45, 1.6], color: 0x3c5261 },
      { shape: 'box', position: [-0.4, 0.42, -0.4], size: [1.5, 0.14, 0.7], color: 0x4a6376 },
      { shape: 'box', position: [0.8, 0.42, 0.05], size: [0.7, 0.14, 1.5], color: 0x4a6376 },
    ],
  },

  // ============================================================
  // 床（3）—— 床垫顶面统一 0.5 米
  // ============================================================
  // 单人床 1.0×0.6×2.0
  {
    id: 'bed_single',
    name: '单人床',
    category: '家具',
    subcategory: '床',
    type: 'furniture',
    shape: 'custom',
    size: [1.0, 0.6, 2.0],
    // 质量：1.0×0.6×2.0 m³ × 木材 650 kg/m³
    mass: 1.0 * 0.6 * 2.0 * 650, // 密度 650
    friction: 0.72,
    restitution: 0.06,
    color: 0xd8cbb5,
    icon: '🛏️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['床', '单人床', '卧室', '软装'],
    description: '单人床，床面一米宽两米长，床垫顶面正好半米高，配一个枕头和一床被子。',
    parts: [
      { shape: 'box', position: [0, 0.16, 0], size: [1.0, 0.32, 2.0], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.41, 0], size: [0.96, 0.18, 1.9], color: 0xd8cbb5 },
      { shape: 'box', position: [0, 0.525, 0.4], size: [0.96, 0.05, 1.05], color: 0x4a7c8c },
      { shape: 'box', position: [0, 0.55, -0.75], size: [0.5, 0.1, 0.3], color: 0xf0ece1 },
    ],
  },

  // 双人床 1.5×0.6×2.0
  {
    id: 'bed_double',
    name: '双人床',
    category: '家具',
    subcategory: '床',
    type: 'furniture',
    shape: 'custom',
    size: [1.5, 0.6, 2.0],
    // 质量：1.5×0.6×2.0 m³ × 木材 650 kg/m³
    mass: 1.5 * 0.6 * 2.0 * 650, // 密度 650
    friction: 0.72,
    restitution: 0.06,
    color: 0xe4dccb,
    icon: '🛏️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    lodLevels: 2,
    tags: ['床', '双人床', '卧室', '软装'],
    description: '双人床，床面一米五宽两米长，床垫顶面半米高，并排两个枕头一床被子。',
    parts: [
      { shape: 'box', position: [0, 0.16, 0], size: [1.5, 0.32, 2.0], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.41, 0], size: [1.46, 0.18, 1.9], color: 0xe4dccb },
      { shape: 'box', position: [0, 0.525, 0.4], size: [1.46, 0.05, 1.05], color: 0x4a7c8c },
      { shape: 'box', position: [-0.36, 0.55, -0.75], size: [0.5, 0.1, 0.3], color: 0xf0ece1 },
      { shape: 'box', position: [0.36, 0.55, -0.75], size: [0.5, 0.1, 0.3], color: 0xf0ece1 },
    ],
  },

  // 上下铺 1.2×1.7×1.9：两层床架 + 左右立柱（立柱盒覆盖前后四根柱子）+ 护栏
  {
    id: 'bed_bunk',
    name: '上下铺',
    category: '家具',
    subcategory: '床',
    type: 'furniture',
    shape: 'custom',
    size: [1.2, 1.7, 1.9],
    // 质量：1.2×1.7×1.9 m³ × 木材 650 kg/m³
    mass: 1.2 * 1.7 * 1.9 * 650, // 密度 650
    friction: 0.7,
    restitution: 0.06,
    color: 0x8b5a2b,
    icon: '🛏️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['床', '上下铺', '双层', '宿舍'],
    description: '宿舍上下铺，下铺床垫顶面半米、上铺一点三八米，左右两块立柱盒当四条床腿。',
    parts: [
      { shape: 'box', position: [0, 0.15, 0], size: [1.2, 0.3, 1.9], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.39, 0], size: [1.14, 0.18, 1.84], color: 0xd8cbb5 },
      { shape: 'box', position: [0, 1.075, 0], size: [1.2, 0.25, 1.9], color: 0x8b5a2b },
      { shape: 'box', position: [0, 1.29, 0], size: [1.14, 0.18, 1.84], color: 0xd8cbb5 },
      { shape: 'box', position: [-0.56, 0.85, 0], size: [0.08, 1.7, 1.9], color: 0x7a4b23 },
      { shape: 'box', position: [0.56, 0.85, 0], size: [0.08, 1.7, 1.9], color: 0x7a4b23 },
      { shape: 'box', position: [0, 1.53, -0.92], size: [1.2, 0.3, 0.06], color: 0x9b6a3a },
    ],
  },

  // ============================================================
  // 柜（9）—— 深度 0.4~0.6 米
  // ============================================================
  // 平开门衣柜 1.2×2.0×0.6
  {
    id: 'wardrobe_swing',
    name: '平开门衣柜',
    category: '家具',
    subcategory: '柜',
    type: 'furniture',
    shape: 'cuboid',
    size: [1.2, 2.0, 0.6],
    // 质量：1.2×2.0×0.6 m³ × 刨花板 700 kg/m³
    mass: 1.2 * 2.0 * 0.6 * 700, // 密度 700
    friction: 0.68,
    restitution: 0.08,
    color: 0x8b5a2b,
    icon: '🚪',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    lodLevels: 2,
    tags: ['柜子', '衣柜', '收纳', '卧室'],
    description: '平开门衣柜，两米高、进深六十厘米，两扇门对开，门缝各贴一个长条把手。',
    parts: [
      { shape: 'box', position: [0, 1.0, 0], size: [1.2, 2.0, 0.56], color: 0x8b5a2b },
      { shape: 'box', position: [-0.29, 1.0, 0.29], size: [0.56, 1.9, 0.02], color: 0x9b6a3a },
      { shape: 'box', position: [0.29, 1.0, 0.29], size: [0.56, 1.9, 0.02], color: 0x9b6a3a },
      { shape: 'box', position: [-0.05, 1.0, 0.31], size: [0.04, 0.3, 0.02], color: 0xc9a227 },
      { shape: 'box', position: [0.05, 1.0, 0.31], size: [0.04, 0.3, 0.02], color: 0xc9a227 },
    ],
  },

  // 推拉门衣柜 1.8×2.1×0.56
  {
    id: 'wardrobe_sliding',
    name: '推拉门衣柜',
    category: '家具',
    subcategory: '柜',
    type: 'furniture',
    shape: 'cuboid',
    size: [1.8, 2.1, 0.56],
    // 质量：1.8×2.1×0.56 m³ × 刨花板 700 kg/m³
    mass: 1.8 * 2.1 * 0.56 * 700, // 密度 700
    friction: 0.68,
    restitution: 0.08,
    color: 0xc9a882,
    icon: '🚪',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    lodLevels: 2,
    tags: ['柜子', '衣柜', '推拉门', '卧室'],
    description: '推拉门衣柜，一米八宽，两扇门前后错开五厘米各占一半轨道，开门不占走道。',
    parts: [
      { shape: 'box', position: [0, 1.05, 0], size: [1.8, 2.1, 0.5], color: 0xc9a882 },
      { shape: 'box', position: [-0.45, 1.05, 0.265], size: [0.9, 2.0, 0.03], color: 0xd8cbb5 },
      { shape: 'box', position: [0.45, 1.05, 0.295], size: [0.9, 2.0, 0.03], color: 0xb99a74 },
    ],
  },

  // 现代电视柜 1.8×0.46×0.5
  {
    id: 'tv_console_low',
    name: '现代电视柜',
    category: '家具',
    subcategory: '柜',
    type: 'furniture',
    shape: 'cuboid',
    size: [1.8, 0.46, 0.5],
    // 质量：1.8×0.46×0.5 m³ × 刨花板 700 kg/m³
    mass: 1.8 * 0.46 * 0.5 * 700, // 密度 700
    friction: 0.66,
    restitution: 0.1,
    color: 0xc9a882,
    icon: '📺',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['柜子', '电视柜', '客厅', '收纳'],
    description: '矮款电视柜，一点八米长，柜体离地十四厘米，刚好放得下扫地机器人。',
    parts: [
      { shape: 'box', position: [-0.82, 0.07, 0], size: [0.06, 0.14, 0.4], color: 0x9aa7b0 },
      { shape: 'box', position: [0.82, 0.07, 0], size: [0.06, 0.14, 0.4], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 0.28, 0], size: [1.8, 0.28, 0.44], color: 0xc9a882 },
      { shape: 'box', position: [0, 0.44, 0], size: [1.8, 0.04, 0.5], color: 0xd8cbb5 },
      { shape: 'box', position: [0, 0.28, 0.23], size: [0.8, 0.22, 0.02], color: 0xb99a74 },
    ],
  },

  // 高鞋柜 0.9×1.2×0.42
  {
    id: 'shoe_cabinet_tall',
    name: '高鞋柜',
    category: '家具',
    subcategory: '柜',
    type: 'furniture',
    shape: 'cuboid',
    size: [0.9, 1.2, 0.42],
    // 质量：0.9×1.2×0.42 m³ × 刨花板 700 kg/m³
    mass: 0.9 * 1.2 * 0.42 * 700, // 密度 700
    friction: 0.66,
    restitution: 0.1,
    color: 0x8b5a2b,
    icon: '👟',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['柜子', '鞋柜', '玄关', '收纳'],
    description: '玄关高鞋柜，一米二高、进深四十二厘米，双门对开，顶上那块板正好放钥匙盘。',
    parts: [
      { shape: 'box', position: [0, 0.02, 0], size: [0.9, 0.04, 0.4], color: 0x6b4a2a },
      { shape: 'box', position: [0, 0.6, 0], size: [0.9, 1.12, 0.36], color: 0x8b5a2b },
      { shape: 'box', position: [0, 1.18, 0], size: [0.9, 0.04, 0.4], color: 0x9b6a3a },
      { shape: 'box', position: [-0.23, 0.6, 0.19], size: [0.42, 1.0, 0.02], color: 0x9b6a3a },
      { shape: 'box', position: [0.23, 0.6, 0.19], size: [0.42, 1.0, 0.02], color: 0x9b6a3a },
      { shape: 'box', position: [-0.04, 0.6, 0.21], size: [0.03, 0.2, 0.02], color: 0xc9a227 },
      { shape: 'box', position: [0.04, 0.6, 0.21], size: [0.03, 0.2, 0.02], color: 0xc9a227 },
    ],
  },

  // 钢制文件柜 0.9×1.35×0.44
  {
    id: 'file_cabinet_steel',
    name: '钢制文件柜',
    category: '家具',
    subcategory: '柜',
    type: 'furniture',
    shape: 'cuboid',
    size: [0.9, 1.35, 0.44],
    // 质量：0.9×1.35×0.44 m³ × 板材 700 kg/m³
    // （柜体是钣金空腔，按实心钢 7800 会得到四吨，所以折成板材密度）
    mass: 0.9 * 1.35 * 0.44 * 700, // 密度 700
    friction: 0.5,
    restitution: 0.14,
    color: 0x9aa7b0,
    icon: '🗄️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['柜子', '文件柜', '办公', '收纳'],
    description: '钢制文件柜，三层抽屉柜，柜面一号一米三五高，每层一条长把手。',
    parts: [
      { shape: 'box', position: [0, 0.675, 0], size: [0.9, 1.35, 0.4], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 1.1, 0.21], size: [0.8, 0.36, 0.02], color: 0x8b98a1 },
      { shape: 'box', position: [0, 0.675, 0.21], size: [0.8, 0.36, 0.02], color: 0x8b98a1 },
      { shape: 'box', position: [0, 0.25, 0.21], size: [0.8, 0.36, 0.02], color: 0x8b98a1 },
      { shape: 'box', position: [0, 1.1, 0.23], size: [0.24, 0.04, 0.02], color: 0x5a636b },
      { shape: 'box', position: [0, 0.675, 0.23], size: [0.24, 0.04, 0.02], color: 0x5a636b },
      { shape: 'box', position: [0, 0.25, 0.23], size: [0.24, 0.04, 0.02], color: 0x5a636b },
    ],
  },

  // 保险箱 0.5×0.6×0.49
  {
    id: 'safe_box',
    name: '保险箱',
    category: '家具',
    subcategory: '柜',
    type: 'furniture',
    shape: 'cuboid',
    size: [0.5, 0.6, 0.49],
    // 质量：0.5×0.6×0.49 m³ × 钢 7800 kg/m³（实心钢箱体，压手才对）
    mass: 0.5 * 0.6 * 0.49 * 7800, // 密度 7800
    friction: 0.75,
    restitution: 0.03,
    color: 0x4a5560,
    icon: '🔒',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['柜子', '保险箱', '钢制', '防撬'],
    description: '小型保险箱，钢制箱体加厚门板，门中央一个圆形机械转盘，重得两个人才能抬。',
    parts: [
      { shape: 'box', position: [0, 0.02, 0], size: [0.5, 0.04, 0.44], color: 0x3a4048 },
      { shape: 'box', position: [0, 0.31, 0], size: [0.5, 0.58, 0.4], color: 0x4a5560 },
      { shape: 'box', position: [0, 0.3, 0.22], size: [0.44, 0.44, 0.04], color: 0x5a636b },
      { shape: 'cylinder', position: [0, 0.3, 0.235], size: [0.07, 0.03, 0.07], color: 0x9aa7b0 },
    ],
  },

  // 书架 0.9×1.8×0.4：两侧板 + 四层板 + 一摞书
  {
    id: 'bookcase',
    name: '书架',
    category: '家具',
    subcategory: '柜',
    type: 'furniture',
    shape: 'custom',
    size: [0.9, 1.8, 0.4],
    // 质量：0.9×1.8×0.4 m³ × 刨花板 700 kg/m³
    mass: 0.9 * 1.8 * 0.4 * 700, // 密度 700
    friction: 0.66,
    restitution: 0.1,
    color: 0x8b5a2b,
    icon: '📚',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['柜子', '书架', '收纳', '书房'],
    description: '书架，一米八高、进深四十厘米，四层隔板，中层的书并成一摞。',
    parts: [
      { shape: 'box', position: [-0.425, 0.9, 0], size: [0.05, 1.8, 0.4], color: 0x7a4b23 },
      { shape: 'box', position: [0.425, 0.9, 0], size: [0.05, 1.8, 0.4], color: 0x7a4b23 },
      { shape: 'box', position: [0, 0.025, 0], size: [0.8, 0.05, 0.4], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.62, 0], size: [0.8, 0.05, 0.4], color: 0x8b5a2b },
      { shape: 'box', position: [0, 1.2, 0], size: [0.8, 0.05, 0.4], color: 0x8b5a2b },
      { shape: 'box', position: [0, 1.775, 0], size: [0.8, 0.05, 0.4], color: 0x8b5a2b },
      { shape: 'box', position: [-0.2, 0.79, 0], size: [0.36, 0.34, 0.24], color: 0xc0503c },
    ],
  },

  // 餐边柜 1.0×0.9×0.46：柜体 + 三层抽屉面板与把手（8 part 上限刚好用满）
  {
    id: 'cabinet_sideboard',
    name: '餐边柜',
    category: '家具',
    subcategory: '柜',
    type: 'furniture',
    shape: 'cuboid',
    size: [1.0, 0.9, 0.46],
    // 质量：1.0×0.9×0.46 m³ × 刨花板 700 kg/m³
    mass: 1.0 * 0.9 * 0.46 * 700, // 密度 700
    friction: 0.68,
    restitution: 0.1,
    color: 0x8b5a2b,
    icon: '🗄️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['柜子', '餐边柜', '斗柜', '收纳'],
    description: '餐边柜，一米长九十厘米高，三个抽屉叠着，台面上可以摆酒具和花瓶。',
    parts: [
      { shape: 'box', position: [0, 0.02, 0], size: [0.9, 0.04, 0.38], color: 0x6b4a2a },
      { shape: 'box', position: [0, 0.47, 0], size: [1.0, 0.86, 0.42], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.74, 0.22], size: [0.9, 0.22, 0.02], color: 0x9b6a3a },
      { shape: 'box', position: [0, 0.52, 0.22], size: [0.9, 0.22, 0.02], color: 0x9b6a3a },
      { shape: 'box', position: [0, 0.3, 0.22], size: [0.9, 0.22, 0.02], color: 0x9b6a3a },
      { shape: 'box', position: [0, 0.74, 0.24], size: [0.2, 0.03, 0.02], color: 0xc9a227 },
      { shape: 'box', position: [0, 0.52, 0.24], size: [0.2, 0.03, 0.02], color: 0xc9a227 },
      { shape: 'box', position: [0, 0.3, 0.24], size: [0.2, 0.03, 0.02], color: 0xc9a227 },
    ],
  },

  // 床头柜 0.45×0.57×0.46
  {
    id: 'cabinet_nightstand',
    name: '床头柜',
    category: '家具',
    subcategory: '柜',
    type: 'furniture',
    shape: 'cuboid',
    size: [0.45, 0.57, 0.46],
    // 质量：0.45×0.57×0.46 m³ × 刨花板 700 kg/m³
    mass: 0.45 * 0.57 * 0.46 * 700, // 密度 700
    friction: 0.68,
    restitution: 0.1,
    color: 0xc9a882,
    icon: '🛏️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['柜子', '床头柜', '卧室', '收纳'],
    description: '床头柜，四十五厘米见方，一个抽屉加一块加宽顶板，配单人床或双人床都行。',
    parts: [
      { shape: 'box', position: [0, 0.02, 0], size: [0.44, 0.04, 0.36], color: 0x6b4a2a },
      { shape: 'box', position: [0, 0.29, 0], size: [0.44, 0.5, 0.4], color: 0xc9a882 },
      { shape: 'box', position: [0, 0.555, 0], size: [0.45, 0.03, 0.44], color: 0xd8cbb5 },
      { shape: 'box', position: [0, 0.36, 0.21], size: [0.38, 0.3, 0.02], color: 0xb99a74 },
      { shape: 'box', position: [0, 0.36, 0.23], size: [0.16, 0.03, 0.02], color: 0xc9a227 },
    ],
  },
];
