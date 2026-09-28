import type { BuildingDef } from '../../building/types';

/**
 * 厨卫类建筑模型（20 个，M4 新增）。
 *
 * 字段口径与 `furniture.ts` / `appliances.ts` 一致：
 * - 原点在底面中心，所有 part 的最低点必须正好落在 y = 0；
 * - `size` = parts 的实际包围盒（`position[i] ± size[i] / 2`）；
 * - `mass` = 外包围盒体积 × 材料密度，密度取真实量级：
 *   木材 650 / 板材 700 / 钢 7800 / 铝 2700 / 塑料 950 / 玻璃 2500 / 陶瓷 2300 / 织物 300。
 *   陶瓷洁具按 2300，台面柜体按板材 700，金属杆件按铝 2700，塑料小件按 950；
 * - `stackable`：台面 / 柜体 / 带盖垃圾桶这类有水平承重面的给 `true`，
 *   镜子、拖把、扫帚、毛巾架、淋浴杆、小便斗这类细长或挂装的给 `false`。
 *
 * 尺寸对齐真实规格：浴缸 1.7×0.6×0.8、马桶 0.4（座）+ 0.4（水箱）= 总高 0.8、
 * 拖把与扫帚都是 0.1×1.2×0.1 的细长杆件；镜子的镜面用淡蓝高反光色 `0xdfeef7`。
 */
export const KITCHEN_BATH_ITEMS: BuildingDef[] = [
  // ============================================================
  // 水槽（2）
  // ============================================================
  // 双槽水槽 1.0×1.1×0.6（台面高 0.9）
  {
    id: 'sink_double_bowl',
    name: '双槽水槽',
    category: '厨卫',
    subcategory: '水槽',
    type: 'appliance',
    shape: 'custom',
    size: [1.0, 1.1, 0.6],
    // 质量：1.0×1.1×0.6 m³ × 板材 700 kg/m³（台下柜体按刨花板折算）
    mass: 1.0 * 1.1 * 0.6 * 700, // 密度 700
    friction: 0.5,
    restitution: 0.1,
    color: 0xcfd6da,
    icon: '🚰',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['厨房', '水槽', '双槽', '不锈钢'],
    description: '双槽厨房水槽，一米宽台下柜体，台面高零点九米，两个不锈钢盆并排，台面后沿立着水龙头。',
    parts: [
      { shape: 'box', position: [0, 0.02, 0], size: [0.9, 0.04, 0.5], color: 0x6b4a2a },
      { shape: 'box', position: [0, 0.44, 0], size: [1.0, 0.82, 0.56], color: 0xd8cbb5 },
      { shape: 'box', position: [0, 0.88, 0], size: [1.0, 0.04, 0.6], color: 0xcfd6da },
      { shape: 'box', position: [-0.25, 0.8, 0], size: [0.4, 0.16, 0.44], color: 0x9aa7b0 },
      { shape: 'box', position: [0.25, 0.8, 0], size: [0.4, 0.16, 0.44], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0, 0.98, -0.22], size: [0.05, 0.24, 0.05], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 1.075, -0.14], size: [0.05, 0.05, 0.18], color: 0x9aa7b0 },
    ],
  },

  // 单槽水槽 0.6×1.1×0.6
  {
    id: 'sink_single_bowl',
    name: '单槽水槽',
    category: '厨卫',
    subcategory: '水槽',
    type: 'appliance',
    shape: 'custom',
    size: [0.6, 1.1, 0.6],
    // 质量：0.6×1.1×0.6 m³ × 板材 700 kg/m³
    mass: 0.6 * 1.1 * 0.6 * 700, // 密度 700
    friction: 0.5,
    restitution: 0.1,
    color: 0xcfd6da,
    icon: '🚰',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['厨房', '水槽', '单槽', '阳台'],
    description: '单槽水槽，六十厘米宽，盆体够深能泡下一口炒锅，小厨房或阳台洗衣区都合适。',
    parts: [
      { shape: 'box', position: [0, 0.02, 0], size: [0.54, 0.04, 0.5], color: 0x6b4a2a },
      { shape: 'box', position: [0, 0.44, 0], size: [0.6, 0.82, 0.56], color: 0xd8cbb5 },
      { shape: 'box', position: [0, 0.88, 0], size: [0.6, 0.04, 0.6], color: 0xcfd6da },
      { shape: 'box', position: [0, 0.8, 0], size: [0.46, 0.16, 0.44], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0, 1.0, -0.22], size: [0.05, 0.2, 0.05], color: 0x9aa7b0 },
    ],
  },

  // ============================================================
  // 炉灶（3）
  // ============================================================
  // 双头燃气灶 0.75×0.96×0.6
  {
    id: 'stove_gas_two',
    name: '双头燃气灶',
    category: '厨卫',
    subcategory: '炉灶',
    type: 'appliance',
    shape: 'custom',
    size: [0.75, 0.96, 0.6],
    // 质量：0.75×0.96×0.6 m³ × 板材 700 kg/m³（灶柜按刨花板折算）
    mass: 0.75 * 0.96 * 0.6 * 700, // 密度 700
    friction: 0.5,
    restitution: 0.1,
    color: 0x3a3f44,
    icon: '🔥',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['厨房', '燃气灶', '明火', '烹饪'],
    description: '双头燃气灶，柜体顶部一块深色灶台面，两个圆形灶眼一左一右，台面高零点九六米。',
    parts: [
      { shape: 'box', position: [0, 0.02, 0], size: [0.68, 0.04, 0.5], color: 0x6b4a2a },
      { shape: 'box', position: [0, 0.45, 0], size: [0.75, 0.82, 0.56], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 0.89, 0], size: [0.75, 0.06, 0.6], color: 0x3a3f44 },
      { shape: 'cylinder', position: [-0.18, 0.94, 0], size: [0.24, 0.04, 0.24], color: 0x2c3e50 },
      { shape: 'cylinder', position: [0.18, 0.94, 0], size: [0.24, 0.04, 0.24], color: 0x2c3e50 },
    ],
  },

  // 台式电磁炉 0.32×0.11×0.4
  {
    id: 'cooktop_induction',
    name: '台式电磁炉',
    category: '厨卫',
    subcategory: '炉灶',
    type: 'appliance',
    shape: 'cuboid',
    size: [0.32, 0.11, 0.4],
    // 质量：0.32×0.11×0.4 m³ × 塑料 950 kg/m³
    mass: 0.32 * 0.11 * 0.4 * 950, // 密度 950
    friction: 0.5,
    restitution: 0.14,
    color: 0x2c3136,
    icon: '🍳',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['厨房', '电磁炉', '台式', '小家电'],
    description: '台式电磁炉，三十二厘米宽，黑色玻璃面板中央一圈加热环，前面一个旋钮，随手搬。',
    parts: [
      { shape: 'box', position: [0, 0.04, 0], size: [0.32, 0.08, 0.4], color: 0x2c3136 },
      { shape: 'box', position: [0, 0.09, 0], size: [0.3, 0.02, 0.38], color: 0x1a1d21 },
      { shape: 'cylinder', position: [0, 0.1, 0], size: [0.2, 0.02, 0.2], color: 0xd4a437 },
      { shape: 'cylinder', position: [0, 0.1, 0.15], size: [0.05, 0.02, 0.05], color: 0x9aa7b0 },
    ],
  },

  // 集成灶 0.9×0.93×0.6（灶台面 + 两个灶眼 + 下方烤箱门）
  {
    id: 'oven_range_combo',
    name: '集成灶',
    category: '厨卫',
    subcategory: '炉灶',
    type: 'appliance',
    shape: 'custom',
    size: [0.9, 0.93, 0.6],
    // 质量：0.9×0.93×0.6 m³ × 板材 700 kg/m³
    mass: 0.9 * 0.93 * 0.6 * 700, // 密度 700
    friction: 0.5,
    restitution: 0.08,
    color: 0x3a4048,
    icon: '♨️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    lodLevels: 2,
    tags: ['厨房', '集成灶', '烤箱', '一体机'],
    description: '集成灶，上半是九十厘米宽的双灶眼台面，下半嵌一台烤箱，油烟机直接装在它顶上。',
    parts: [
      { shape: 'box', position: [0, 0.425, 0], size: [0.9, 0.85, 0.55], color: 0x4a5560 },
      { shape: 'box', position: [0, 0.87, 0], size: [0.9, 0.04, 0.6], color: 0x2c3136 },
      { shape: 'cylinder', position: [-0.2, 0.91, 0], size: [0.22, 0.04, 0.22], color: 0x1a1d21 },
      { shape: 'cylinder', position: [0.2, 0.91, 0], size: [0.22, 0.04, 0.22], color: 0x1a1d21 },
      { shape: 'box', position: [0, 0.3, 0.285], size: [0.8, 0.3, 0.03], color: 0x2c3136 },
    ],
  },

  // ============================================================
  // 洁具（8）
  // ============================================================
  // 落地马桶 0.4×0.8×0.7（座高 0.4 + 水箱 0.4 = 总高 0.8）
  {
    id: 'toilet_floor',
    name: '落地马桶',
    category: '厨卫',
    subcategory: '洁具',
    type: 'appliance',
    shape: 'custom',
    size: [0.4, 0.8, 0.7],
    // 质量：0.4×0.8×0.7 m³ × 陶瓷 2300 kg/m³
    mass: 0.4 * 0.8 * 0.7 * 2300, // 密度 2300
    friction: 0.4,
    restitution: 0.1,
    color: 0xf2f6f8,
    icon: '🚽',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['卫浴', '马桶', '陶瓷', '坐便'],
    description: '落地马桶，底座高四十厘米、后面水箱高四十厘米，总高正好八十厘米，水箱顶能搁东西。',
    parts: [
      { shape: 'box', position: [0, 0.2, 0.08], size: [0.36, 0.4, 0.5], color: 0xf2f6f8 },
      { shape: 'box', position: [0, 0.44, 0.08], size: [0.38, 0.08, 0.54], color: 0xf8fbfc },
      { shape: 'box', position: [0, 0.6, -0.25], size: [0.4, 0.4, 0.2], color: 0xf2f6f8 },
      { shape: 'cylinder', position: [0, 0.79, -0.25], size: [0.06, 0.02, 0.06], color: 0x9aa7b0 },
    ],
  },

  // 蹲便器 0.4×0.37×0.6（嵌在地面里，只有排水口高出来一点）
  {
    id: 'toilet_squat',
    name: '蹲便器',
    category: '厨卫',
    subcategory: '洁具',
    type: 'appliance',
    shape: 'cuboid',
    size: [0.4, 0.37, 0.6],
    // 质量：0.4×0.37×0.6 m³ × 陶瓷 2300 kg/m³
    mass: 0.4 * 0.37 * 0.6 * 2300, // 密度 2300
    friction: 0.45,
    restitution: 0.08,
    color: 0xeef4f6,
    icon: '🚻',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['卫浴', '蹲便器', '陶瓷', '公共卫生间'],
    description: '蹲便器，盆体几乎与地面齐平，前沿一块六十厘米长的防滑踏板，后墙接冲水阀。',
    parts: [
      { shape: 'box', position: [0, 0.1, 0.02], size: [0.36, 0.2, 0.5], color: 0xeef4f6 },
      { shape: 'box', position: [0, 0.225, 0], size: [0.4, 0.05, 0.6], color: 0xd8e2e6 },
      { shape: 'box', position: [0, 0.31, -0.26], size: [0.1, 0.12, 0.08], color: 0x9aa7b0 },
    ],
  },

  // 小便斗 0.35×1.0×0.36（斗体挂在墙上，排水管落到地面）
  {
    id: 'urinal_wall',
    name: '小便斗',
    category: '厨卫',
    subcategory: '洁具',
    type: 'appliance',
    shape: 'custom',
    size: [0.35, 1.0, 0.36],
    // 质量：0.35×1.0×0.36 m³ × 陶瓷 2300 kg/m³
    mass: 0.35 * 1.0 * 0.36 * 2300, // 密度 2300
    friction: 0.4,
    restitution: 0.08,
    color: 0xf2f6f8,
    icon: '🚹',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['卫浴', '小便斗', '陶瓷', '公共卫生间'],
    description: '小便斗，斗体挂在五十八厘米高处、下接一根落地的排水管，顶部一颗冲水按钮。',
    parts: [
      { shape: 'box', position: [0, 0.79, 0], size: [0.35, 0.42, 0.36], color: 0xf2f6f8 },
      { shape: 'cylinder', position: [0, 0.3, -0.1], size: [0.08, 0.6, 0.08], color: 0xcfd6da },
      { shape: 'cylinder', position: [0, 0.985, 0], size: [0.05, 0.03, 0.05], color: 0x9aa7b0 },
    ],
  },

  // 独立浴缸 1.7×0.6×0.8
  {
    id: 'bathtub_freestanding',
    name: '独立浴缸',
    category: '厨卫',
    subcategory: '洁具',
    type: 'appliance',
    shape: 'cuboid',
    size: [1.7, 0.6, 0.8],
    // 质量：1.7×0.6×0.8 m³ × 陶瓷 2300 kg/m³
    mass: 1.7 * 0.6 * 0.8 * 2300, // 密度 2300
    friction: 0.32,
    restitution: 0.1,
    color: 0xf2f6f8,
    icon: '🛁',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    lodLevels: 2,
    tags: ['卫浴', '浴缸', '独立式', '泡澡'],
    description: '独立浴缸，一点七米长、六十厘米高，缸沿是平的，缸里蓄着一层淡蓝色的水。',
    parts: [
      { shape: 'box', position: [0, 0.3, 0], size: [1.7, 0.6, 0.8], color: 0xf2f6f8 },
      { shape: 'box', position: [0, 0.55, 0], size: [1.5, 0.02, 0.6], color: 0xbfe6ea },
    ],
  },

  // 淋浴房 0.9×2.0×0.9
  {
    id: 'shower_cabin',
    name: '淋浴房',
    category: '厨卫',
    subcategory: '洁具',
    type: 'appliance',
    shape: 'custom',
    size: [0.9, 2.0, 0.9],
    // 质量：0.9×2.0×0.9 m³ × 玻璃 2500 kg/m³（围挡玻璃按玻璃密度折算）
    mass: 0.9 * 2.0 * 0.9 * 2500, // 密度 2500
    friction: 0.45,
    restitution: 0.1,
    color: 0xbfe6ea,
    icon: '🚿',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    lodLevels: 2,
    tags: ['卫浴', '淋浴房', '玻璃', '淋浴'],
    description: '淋浴房，九十厘米见方、两米高，两面透明玻璃加一扇推拉门，角落立着花洒杆和顶喷。',
    parts: [
      { shape: 'box', position: [0, 0.05, 0], size: [0.9, 0.1, 0.9], color: 0xd8cbb5 },
      { shape: 'box', position: [-0.43, 1.05, 0], size: [0.04, 1.9, 0.9], color: 0xbfe6ea },
      { shape: 'box', position: [0, 1.05, -0.43], size: [0.9, 1.9, 0.04], color: 0xbfe6ea },
      { shape: 'box', position: [0.2, 1.0, 0.44], size: [0.4, 1.8, 0.02], color: 0xcfeef1 },
      { shape: 'cylinder', position: [0.4, 0.95, -0.4], size: [0.06, 1.8, 0.06], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0.25, 1.87, -0.25], size: [0.2, 0.04, 0.2], color: 0x9aa7b0 },
    ],
  },

  // 淋浴立杆 0.3×2.1×0.3（落地立杆 + 顶喷 + 混水阀 + 手持花洒）
  {
    id: 'shower_column',
    name: '淋浴立杆',
    category: '厨卫',
    subcategory: '洁具',
    type: 'appliance',
    shape: 'custom',
    size: [0.3, 2.1, 0.3],
    // 质量：0.3×2.1×0.3 m³ × 铝 2700 kg/m³（空心管件按铝折算）
    mass: 0.3 * 2.1 * 0.3 * 2700, // 密度 2700
    friction: 0.45,
    restitution: 0.15,
    color: 0x9aa7b0,
    icon: '🚿',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['卫浴', '花洒', '淋浴', '金属'],
    description: '淋浴立杆，落地圆底盘撑起两根一米长的立管，顶端一片顶喷，中间是混水阀和手持花洒。',
    parts: [
      { shape: 'cylinder', position: [0, 0.025, 0], size: [0.25, 0.05, 0.25], color: 0x5a636b },
      { shape: 'cylinder', position: [0, 1.075, 0], size: [0.05, 2.05, 0.05], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0, 2.06, 0], size: [0.3, 0.03, 0.3], color: 0xcfd6da },
      { shape: 'box', position: [0, 1.0, 0.06], size: [0.12, 0.08, 0.1], color: 0x5a636b },
      { shape: 'cylinder', position: [0.1, 1.2, 0.1], size: [0.1, 0.15, 0.1], color: 0xcfd6da },
    ],
  },

  // 立柱洗手台 0.6×1.09×0.55
  {
    id: 'washbasin_pedestal',
    name: '立柱洗手台',
    category: '厨卫',
    subcategory: '洁具',
    type: 'appliance',
    shape: 'custom',
    size: [0.6, 1.09, 0.55],
    // 质量：0.6×1.09×0.55 m³ × 陶瓷 2300 kg/m³
    mass: 0.6 * 1.09 * 0.55 * 2300, // 密度 2300
    friction: 0.4,
    restitution: 0.1,
    color: 0xf2f6f8,
    icon: '🧴',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['卫浴', '洗手台', '陶瓷', '立柱盆'],
    description: '立柱洗手台，一根陶瓷立柱顶起瓷盆，台面高零点九一米，后沿龙头弯向盆心。',
    parts: [
      { shape: 'box', position: [0, 0.34, 0], size: [0.22, 0.68, 0.22], color: 0xf2f6f8 },
      { shape: 'box', position: [0, 0.77, 0], size: [0.56, 0.18, 0.5], color: 0xf8fbfc },
      { shape: 'box', position: [0, 0.885, 0], size: [0.6, 0.05, 0.55], color: 0xcfd6da },
      { shape: 'cylinder', position: [0, 1.0, -0.18], size: [0.05, 0.18, 0.05], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 1.07, -0.11], size: [0.04, 0.04, 0.14], color: 0x9aa7b0 },
    ],
  },

  // 浴室镜子 0.7×1.0×0.06（镜面用淡蓝高反光色）
  {
    id: 'mirror_bath',
    name: '浴室镜子',
    category: '厨卫',
    subcategory: '洁具',
    type: 'decoration',
    shape: 'cuboid',
    size: [0.7, 1.0, 0.06],
    // 质量：0.7×1.0×0.06 m³ × 玻璃 2500 kg/m³
    mass: 0.7 * 1.0 * 0.06 * 2500, // 密度 2500
    friction: 0.3,
    restitution: 0.1,
    color: 0xdfeef7,
    icon: '🪞',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['卫浴', '镜子', '镜面', '木框'],
    description: '浴室镜子，一米高的木框里嵌着淡蓝色镜面，挂在洗手台上方，镜面把整间浴室照进去。',
    parts: [
      { shape: 'box', position: [0, 0.5, 0], size: [0.7, 1.0, 0.04], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.5, 0.03], size: [0.66, 0.94, 0.02], color: 0xdfeef7 },
      { shape: 'box', position: [0, 0.97, 0.01], size: [0.7, 0.06, 0.06], color: 0x7a4b23 },
      { shape: 'box', position: [0, 0.03, 0.01], size: [0.7, 0.06, 0.06], color: 0x7a4b23 },
    ],
  },

  // ============================================================
  // 收纳（3）
  // ============================================================
  // 毛巾架 0.6×1.1×0.15（落地式：两条立管 + 三根横杆 + 一条搭着的毛巾）
  {
    id: 'towel_rack',
    name: '毛巾架',
    category: '厨卫',
    subcategory: '收纳',
    type: 'appliance',
    shape: 'custom',
    size: [0.6, 1.1, 0.15],
    // 质量：0.6×1.1×0.15 m³ × 铝 2700 kg/m³（空心管件按铝折算）
    mass: 0.6 * 1.1 * 0.15 * 2700, // 密度 2700
    friction: 0.5,
    restitution: 0.14,
    color: 0xcfd6da,
    icon: '🧻',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['卫浴', '毛巾架', '收纳', '金属'],
    description: '落地毛巾架，一条窄底座立起两根一米一的立管，中间三根横杆，最上面搭着一条毛巾。',
    parts: [
      { shape: 'box', position: [0, 0.02, 0], size: [0.6, 0.04, 0.15], color: 0x5a636b },
      { shape: 'cylinder', position: [-0.28, 0.57, 0], size: [0.03, 1.06, 0.03], color: 0xcfd6da },
      { shape: 'cylinder', position: [0.28, 0.57, 0], size: [0.03, 1.06, 0.03], color: 0xcfd6da },
      { shape: 'box', position: [0, 1.08, 0], size: [0.6, 0.03, 0.03], color: 0xbfc8cf },
      { shape: 'box', position: [0, 0.75, 0], size: [0.6, 0.03, 0.03], color: 0xbfc8cf },
      { shape: 'box', position: [0, 0.42, 0], size: [0.6, 0.03, 0.03], color: 0xbfc8cf },
      { shape: 'box', position: [0, 0.9, 0.02], size: [0.4, 0.3, 0.06], color: 0xd8cbb5 },
    ],
  },

  // 肥皂盒 0.16×0.07×0.12
  {
    id: 'soap_dish',
    name: '肥皂盒',
    category: '厨卫',
    subcategory: '收纳',
    type: 'small',
    shape: 'cuboid',
    size: [0.16, 0.07, 0.12],
    // 质量：0.16×0.07×0.12 m³ × 塑料 950 kg/m³
    mass: 0.16 * 0.07 * 0.12 * 950, // 密度 950
    friction: 0.55,
    restitution: 0.12,
    color: 0xdfeef7,
    icon: '🧼',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['卫浴', '肥皂盒', '收纳', '塑料'],
    description: '肥皂盒，十六厘米长的塑料托盒，中间一层带缝的沥水架，上面搁着一块米白肥皂。',
    parts: [
      { shape: 'box', position: [0, 0.015, 0], size: [0.16, 0.03, 0.12], color: 0xdfeef7 },
      { shape: 'box', position: [0, 0.035, 0], size: [0.14, 0.01, 0.1], color: 0xcfeef1 },
      { shape: 'box', position: [0, 0.055, 0], size: [0.09, 0.03, 0.06], color: 0xf0ece1 },
    ],
  },

  // 浴室置物架 0.5×1.2×0.25
  {
    id: 'shelf_bath',
    name: '浴室置物架',
    category: '厨卫',
    subcategory: '收纳',
    type: 'appliance',
    shape: 'custom',
    size: [0.5, 1.2, 0.25],
    // 质量：0.5×1.2×0.25 m³ × 铝 2700 kg/m³（空心管架按铝折算）
    mass: 0.5 * 1.2 * 0.25 * 2700, // 密度 2700
    friction: 0.5,
    restitution: 0.14,
    color: 0xcfd6da,
    icon: '🧺',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['卫浴', '置物架', '收纳', '金属'],
    description: '浴室置物架，两块侧板中间夹三层隔板，一米二高，洗发水和牙刷杯都能分层摆。',
    parts: [
      { shape: 'box', position: [-0.235, 0.6, 0], size: [0.03, 1.2, 0.25], color: 0xcfd6da },
      { shape: 'box', position: [0.235, 0.6, 0], size: [0.03, 1.2, 0.25], color: 0xcfd6da },
      { shape: 'box', position: [0, 1.15, 0], size: [0.44, 0.03, 0.22], color: 0xbfc8cf },
      { shape: 'box', position: [0, 0.6, 0], size: [0.44, 0.03, 0.22], color: 0xbfc8cf },
      { shape: 'box', position: [0, 0.05, 0], size: [0.44, 0.03, 0.22], color: 0xbfc8cf },
    ],
  },

  // ============================================================
  // 清洁（4）
  // ============================================================
  // 马桶刷 0.15×0.57×0.15
  {
    id: 'toilet_brush',
    name: '马桶刷',
    category: '厨卫',
    subcategory: '清洁',
    type: 'small',
    shape: 'custom',
    size: [0.15, 0.57, 0.15],
    // 质量：0.15×0.57×0.15 m³ × 塑料 950 kg/m³
    mass: 0.15 * 0.57 * 0.15 * 950, // 密度 950
    friction: 0.5,
    restitution: 0.15,
    color: 0xcfd6da,
    icon: '🧽',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['卫浴', '马桶刷', '清洁', '塑料'],
    description: '马桶刷，一个十五厘米高的圆筒底座，里面插着刷头，刷柄伸到五十七厘米高。',
    parts: [
      { shape: 'cylinder', position: [0, 0.07, 0], size: [0.15, 0.14, 0.15], color: 0xcfd6da },
      { shape: 'cylinder', position: [0, 0.18, 0], size: [0.1, 0.12, 0.1], color: 0xe4e7ea },
      { shape: 'cylinder', position: [0, 0.4, 0], size: [0.025, 0.34, 0.025], color: 0x9aa7b0 },
    ],
  },

  // 垃圾桶 0.3×0.5×0.3（带盖，顶面平，可以放东西）
  {
    id: 'trash_can_lid',
    name: '带盖垃圾桶',
    category: '厨卫',
    subcategory: '清洁',
    type: 'small',
    shape: 'cylinder',
    size: [0.3, 0.5, 0.3],
    // 质量：0.3×0.5×0.3 m³ × 塑料 950 kg/m³
    mass: 0.3 * 0.5 * 0.3 * 950, // 密度 950
    friction: 0.55,
    restitution: 0.12,
    color: 0x4a5560,
    icon: '🗑️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['垃圾桶', '清洁', '塑料', '厨房'],
    description: '带盖垃圾桶，三十厘米直径、半米高，桶口一圈加厚的环，顶上一片圆盖扣得严实。',
    parts: [
      { shape: 'cylinder', position: [0, 0.01, 0], size: [0.28, 0.02, 0.28], color: 0x3a4048 },
      { shape: 'cylinder', position: [0, 0.22, 0], size: [0.3, 0.42, 0.3], color: 0x4a5560 },
      { shape: 'cylinder', position: [0, 0.445, 0], size: [0.3, 0.03, 0.3], color: 0x5a636b },
      { shape: 'cylinder', position: [0, 0.48, 0], size: [0.3, 0.04, 0.3], color: 0x3a4048 },
    ],
  },

  // 拖把 0.1×1.2×0.1（细长，一压就倒）
  {
    id: 'mop_stick',
    name: '拖把',
    category: '厨卫',
    subcategory: '清洁',
    type: 'small',
    shape: 'custom',
    size: [0.1, 1.2, 0.1],
    // 质量：0.1×1.2×0.1 m³ × 塑料 950 kg/m³
    mass: 0.1 * 1.2 * 0.1 * 950, // 密度 950
    friction: 0.6,
    restitution: 0.12,
    color: 0x8b98a1,
    icon: '🧹',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['拖把', '清洁', '细长', '地板'],
    description: '平头拖把，十厘米见方的拖布头用夹头夹住，一根一米长的细杆立起来刚好一米二。',
    parts: [
      { shape: 'box', position: [0, 0.075, 0], size: [0.1, 0.15, 0.1], color: 0xd8cbb5 },
      { shape: 'box', position: [0, 0.17, 0], size: [0.06, 0.04, 0.06], color: 0x5a636b },
      { shape: 'cylinder', position: [0, 0.695, 0], size: [0.03, 1.01, 0.03], color: 0x8b98a1 },
    ],
  },

  // 扫帚 0.1×1.2×0.1（细长，一压就倒）
  {
    id: 'broom_stick',
    name: '扫帚',
    category: '厨卫',
    subcategory: '清洁',
    type: 'small',
    shape: 'custom',
    size: [0.1, 1.2, 0.1],
    // 质量：0.1×1.2×0.1 m³ × 木材 650 kg/m³（木柄扫帚按木材折算）
    mass: 0.1 * 1.2 * 0.1 * 650, // 密度 650
    friction: 0.6,
    restitution: 0.1,
    color: 0xd4a437,
    icon: '🧹',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['扫帚', '清洁', '细长', '木柄'],
    description: '高粱扫帚，二十厘米高的帚头压在一块五厘米的连接件下面，木柄一路伸到一米二高。',
    parts: [
      { shape: 'box', position: [0, 0.1, 0], size: [0.1, 0.2, 0.1], color: 0xd4a437 },
      { shape: 'box', position: [0, 0.215, 0], size: [0.05, 0.05, 0.05], color: 0x8b5a2b },
      { shape: 'cylinder', position: [0, 0.72, 0], size: [0.03, 0.96, 0.03], color: 0x8b5a2b },
    ],
  },
];
