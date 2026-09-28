import type { BuildingDef } from '../../building/types';

/**
 * 植物小件目录（30 个）。
 *
 * 一级分类统一用 `'植物'`（本轮新增的一级分类，见 buildingCategories.ts ——
 * 如果那里还没有 `'植物'` 条目，需要在分类表里补上，否则面板过滤会找不到它）。
 *
 * 与装饰目录 `decoration.ts` 的分工：
 * - 装饰里的「装饰陶盆」是**容器**（空盆，摆件性质）；
 * - 这里的都是**活植物** —— 有盆有土，土里长出茎叶花。
 *
 * 尺寸全部按室内盆栽的常识来：小件 0.3 米上下，落地大盆 ≤ 1.2 米，
 * 竹子允许长到 2 米。因为都是「盆 + 土 + 枝叶」的组合，重量一律按极轻档 120 计
 * —— 盆栽的重量主要是土与盆，枝叶本身几乎不压秤。
 *
 * 物理上它们全是 `stackable: false`：盆栽顶上是一丛枝叶，搁不住东西，
 * 压上去不是倒就是折。要往上堆东西，请用装饰线里的陶盆或石块。
 *
 * 原点约定与 `types.ts` 一致：**底面中心**，即每个模型最低的 part
 * `position.y === size.y / 2`，包围盒下沿正好在 y = 0；`size` 就是 parts 的包围盒。
 */
export const PLANT_ITEMS: BuildingDef[] = [
  // ============================================================
  // 盆栽（6）—— 常见的桌面 / 窗台 / 落地绿植
  // ============================================================
  // 桌面小盆栽 0.26×0.37×0.16
  {
    id: 'pot_plant_small',
    name: '桌面小盆栽',
    category: '植物',
    subcategory: '盆栽',
    type: 'plant',
    shape: 'custom',
    size: [0.26, 0.37, 0.16],
    mass: 0.26 * 0.37 * 0.16 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.55,
    restitution: 0.05,
    color: 0x4a8c3f,
    icon: '🪴',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['盆栽', '绿植', '桌面', '活体'],
    description:
      '最小的陶盆绿植，一根细茎顶着左右两片圆叶，整盆不到 40 厘米。' +
      '放书桌角、电脑显示器旁边最合适，需要一点散射光就够活。',
    parts: [
      { shape: 'cylinder', position: [0, 0.075, 0], size: [0.16, 0.15, 0.16], color: 0xb0563c },
      { shape: 'cylinder', position: [0, 0.16, 0], size: [0.13, 0.02, 0.13], color: 0x6b4a2f },
      { shape: 'cylinder', position: [0, 0.235, 0], size: [0.02, 0.13, 0.02], color: 0x4a8c3f },
      { shape: 'sphere', position: [0.065, 0.33, 0], size: [0.13, 0.08, 0.12], color: 0x4a8c3f },
      { shape: 'sphere', position: [-0.065, 0.33, 0], size: [0.13, 0.08, 0.12], color: 0x6fb04a },
    ],
    stackable: false, // 枝叶在顶上，搁不住东西，压上去就折
    textureType: 'leaves',
    lodLevels: 1,
  },
  // 圆叶盆栽 0.28×0.62×0.28
  {
    id: 'pot_plant_round',
    name: '圆叶盆栽',
    category: '植物',
    subcategory: '盆栽',
    type: 'plant',
    shape: 'custom',
    size: [0.28, 0.62, 0.28],
    mass: 0.28 * 0.62 * 0.28 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.55,
    restitution: 0.05,
    color: 0x6fb04a,
    icon: '🌿',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['盆栽', '绿植', '窗台', '活体'],
    description:
      '矮盆里长出一根直茎，顶上一团圆圆的叶球，高 62 厘米。' +
      '窗台上、边柜上都放得下，比桌面小盆栽高一截，适合补窗户那块的绿色。',
    parts: [
      { shape: 'cylinder', position: [0, 0.09, 0], size: [0.2, 0.18, 0.2], color: 0xa8674a },
      { shape: 'cylinder', position: [0, 0.19, 0], size: [0.17, 0.02, 0.17], color: 0x6b4a2f },
      { shape: 'cylinder', position: [0, 0.3, 0], size: [0.03, 0.2, 0.03], color: 0x4a8c3f },
      { shape: 'sphere', position: [0, 0.5, 0], size: [0.28, 0.24, 0.28], color: 0x6fb04a },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 2,
  },
  // 高杆盆栽 0.5×1.2×0.5
  {
    id: 'pot_plant_tall',
    name: '高杆盆栽',
    category: '植物',
    subcategory: '盆栽',
    type: 'plant',
    shape: 'custom',
    size: [0.5, 1.2, 0.5],
    mass: 0.5 * 1.2 * 0.5 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.6,
    restitution: 0.04,
    color: 0x2f6b34,
    icon: '🌴',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['盆栽', '绿植', '地面', '活体'],
    description:
      '落地大盆的观叶植物：粗陶盆里立一根长茎，一米二高处分出一蓬叶子。' +
      '只能放地上，摆在沙发拐角或玄关一侧，正好挡住空墙面。',
    parts: [
      { shape: 'cylinder', position: [0, 0.14, 0], size: [0.34, 0.28, 0.34], color: 0xa8674a },
      { shape: 'cylinder', position: [0, 0.29, 0], size: [0.3, 0.02, 0.3], color: 0x6b4a2f },
      { shape: 'cylinder', position: [0, 0.65, 0], size: [0.05, 0.7, 0.05], color: 0x4a8c3f },
      { shape: 'sphere', position: [0, 1.06, 0], size: [0.5, 0.28, 0.5], color: 0x2f6b34 },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 2,
  },
  // 蕨类盆栽 0.5×0.66×0.5
  {
    id: 'pot_plant_fern',
    name: '蕨类盆栽',
    category: '植物',
    subcategory: '盆栽',
    type: 'plant',
    shape: 'custom',
    size: [0.5, 0.66, 0.5],
    mass: 0.5 * 0.66 * 0.5 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.6,
    restitution: 0.04,
    color: 0x4a8c3f,
    icon: '🌱',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['盆栽', '蕨类', '阴凉', '活体'],
    description:
      '宽口陶盆里散开一蓬羽状叶，叶型向外张成漏斗状，高 66 厘米。' +
      '蕨类怕晒，放北窗台、卫生间干区或者树荫下的地面上都行，' +
      '盆口大所以摆地上比摆窄窗台稳。',
    parts: [
      { shape: 'cylinder', position: [0, 0.1, 0], size: [0.24, 0.2, 0.24], color: 0xb0563c },
      { shape: 'cylinder', position: [0, 0.21, 0], size: [0.2, 0.02, 0.2], color: 0x6b4a2f },
      { shape: 'cone', position: [0, 0.44, 0], size: [0.5, 0.44, 0.5], color: 0x4a8c3f },
      { shape: 'sphere', position: [0, 0.3, 0], size: [0.22, 0.16, 0.22], color: 0x2f6b34 },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 2,
  },
  // 香草盆栽 0.34×0.44×0.26
  {
    id: 'pot_plant_herb',
    name: '香草盆栽',
    category: '植物',
    subcategory: '盆栽',
    type: 'plant',
    shape: 'custom',
    size: [0.34, 0.44, 0.26],
    mass: 0.34 * 0.44 * 0.26 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.55,
    restitution: 0.05,
    color: 0x6fb04a,
    icon: '🌿',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['盆栽', '香草', '厨房', '活体'],
    description:
      '厨房窗台上的香草盆：中间一丛高叶，两侧各压着一小团矮叶，' +
      '摘叶子就能下锅。放在灶台边或阳台栏杆内侧都合适，需要每天晒到太阳。',
    parts: [
      { shape: 'cylinder', position: [0, 0.07, 0], size: [0.18, 0.14, 0.18], color: 0xa8674a },
      { shape: 'cylinder', position: [0, 0.15, 0], size: [0.15, 0.02, 0.15], color: 0x6b4a2f },
      { shape: 'cone', position: [0, 0.3, 0], size: [0.26, 0.28, 0.26], color: 0x6fb04a },
      { shape: 'sphere', position: [-0.1, 0.3, 0], size: [0.14, 0.16, 0.12], color: 0x4a8c3f },
      { shape: 'sphere', position: [0.1, 0.3, 0], size: [0.14, 0.16, 0.12], color: 0x4a8c3f },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 1,
  },
  // 幼苗小盆 0.16×0.3×0.16
  {
    id: 'pot_plant_seedling',
    name: '幼苗小盆',
    category: '植物',
    subcategory: '盆栽',
    type: 'plant',
    shape: 'custom',
    size: [0.16, 0.3, 0.16],
    mass: 0.16 * 0.3 * 0.16 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.55,
    restitution: 0.05,
    color: 0x8fbf5a,
    icon: '🌱',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['盆栽', '幼苗', '育苗', '活体'],
    description:
      '育苗用小陶盆，土面上只冒出两团嫩绿的小芽，整盆 30 厘米高。' +
      '放育苗架、桌面或者窗台边一条都行，长大以后记得换大盆。',
    parts: [
      { shape: 'cylinder', position: [0, 0.07, 0], size: [0.16, 0.14, 0.16], color: 0xb0563c },
      { shape: 'cylinder', position: [0, 0.15, 0], size: [0.14, 0.02, 0.14], color: 0x6b4a2f },
      { shape: 'sphere', position: [0, 0.22, 0], size: [0.14, 0.12, 0.14], color: 0x8fbf5a },
      { shape: 'sphere', position: [0.03, 0.27, 0], size: [0.09, 0.06, 0.09], color: 0x6fb04a },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 1,
  },

  // ============================================================
  // 多肉（5）—— 三种以上不同形态与颜色的多肉 + 两种仙人掌小件
  // ============================================================
  // 莲座多肉 0.24×0.32×0.24
  {
    id: 'succulent_rosette',
    name: '莲座多肉',
    category: '植物',
    subcategory: '多肉',
    type: 'plant',
    shape: 'custom',
    size: [0.24, 0.32, 0.24],
    mass: 0.24 * 0.32 * 0.24 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.6,
    restitution: 0.06,
    color: 0x8fbf5a,
    icon: '🪷',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['多肉', '莲座', '窗台', '活体'],
    description:
      '典型的莲座多肉：叶子一圈圈铺开贴着土面，中间再顶一个小一号的芯，' +
      '浅绿色带一点红边，连盆高 32 厘米。放窗台、办公桌都行，越晒越紧实。',
    parts: [
      { shape: 'cylinder', position: [0, 0.08, 0], size: [0.2, 0.16, 0.2], color: 0xa8674a },
      { shape: 'cylinder', position: [0, 0.17, 0], size: [0.18, 0.02, 0.18], color: 0x6b4a2f },
      { shape: 'sphere', position: [0, 0.23, 0], size: [0.24, 0.1, 0.24], color: 0x8fbf5a },
      { shape: 'sphere', position: [0, 0.29, 0], size: [0.1, 0.06, 0.1], color: 0xe86a7a },
    ],
    stackable: false, // 一压就散
    textureType: 'cactus',
    lodLevels: 1,
  },
  // 指叶多肉 0.18×0.31×0.18
  {
    id: 'succulent_finger',
    name: '指叶多肉',
    category: '植物',
    subcategory: '多肉',
    type: 'plant',
    shape: 'custom',
    size: [0.18, 0.31, 0.18],
    mass: 0.18 * 0.31 * 0.18 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.6,
    restitution: 0.06,
    color: 0x2f6b34,
    icon: '🌵',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['多肉', '指叶', '桌面', '活体'],
    description:
      '深绿色的指状多肉，三根胖叶子从土里斜斜立起，像一小簇手指，' +
      '高 31 厘米。适合放桌面或书架靠窗那格，浇水宁少勿多。',
    parts: [
      { shape: 'cylinder', position: [0, 0.05, 0], size: [0.18, 0.1, 0.18], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0, 0.105, 0], size: [0.16, 0.015, 0.16], color: 0x6b4a2f },
      { shape: 'cone', position: [-0.05, 0.2, 0], size: [0.08, 0.18, 0.08], color: 0x2f6b34 },
      { shape: 'cone', position: [0.05, 0.2, 0.02], size: [0.08, 0.18, 0.08], color: 0x4a8c3f },
      { shape: 'cone', position: [0, 0.21, -0.05], size: [0.08, 0.2, 0.08], color: 0x2f6b34 },
    ],
    stackable: false,
    textureType: 'cactus',
    lodLevels: 1,
  },
  // 生石花 0.2×0.32×0.2
  {
    id: 'succulent_stone',
    name: '生石花',
    category: '植物',
    subcategory: '多肉',
    type: 'plant',
    shape: 'custom',
    size: [0.2, 0.32, 0.2],
    mass: 0.2 * 0.32 * 0.2 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.62,
    restitution: 0.05,
    color: 0xa8b89a,
    icon: '🪨',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['多肉', '生石花', '窗台', '活体'],
    description:
      '生石花，两瓣灰绿色「石头」伏在土面上，中间缝隙里开一朵小黄花，' +
      '连盆 32 厘米。放在窗台最前排或者多肉拼盘边角，' +
      '不仔细看真会当成石子。',
    parts: [
      { shape: 'cylinder', position: [0, 0.07, 0], size: [0.2, 0.14, 0.2], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0, 0.15, 0], size: [0.18, 0.02, 0.18], color: 0x6b4a2f },
      { shape: 'sphere', position: [-0.03, 0.21, 0], size: [0.12, 0.1, 0.12], color: 0xa8b89a },
      { shape: 'sphere', position: [0.03, 0.21, 0.01], size: [0.12, 0.1, 0.12], color: 0xb8c4a4 },
      { shape: 'cone', position: [0, 0.28, 0], size: [0.07, 0.08, 0.07], color: 0xf2c14e },
    ],
    stackable: false,
    textureType: 'cactus',
    lodLevels: 1,
  },
  // 仙人球小盆 0.2×0.39×0.2
  {
    id: 'cactus_small_barrel',
    name: '仙人球小盆',
    category: '植物',
    subcategory: '多肉',
    type: 'plant',
    shape: 'custom',
    size: [0.2, 0.39, 0.2],
    mass: 0.2 * 0.39 * 0.2 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.62,
    restitution: 0.08,
    color: 0x2f6b34,
    icon: '🌵',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['仙人掌', '多肉', '桌面', '活体'],
    description:
      '深绿色的圆球仙人掌，球顶偏一侧开一朵粉花，连盆高 39 厘米。' +
      '摆在桌面或窗台都行，不用天天浇水；球是圆的，别把东西搁上去。',
    parts: [
      { shape: 'cylinder', position: [0, 0.06, 0], size: [0.18, 0.12, 0.18], color: 0xb0563c },
      { shape: 'cylinder', position: [0, 0.125, 0], size: [0.16, 0.015, 0.16], color: 0x6b4a2f },
      { shape: 'sphere', position: [0, 0.23, 0], size: [0.2, 0.2, 0.2], color: 0x2f6b34 },
      { shape: 'cone', position: [0.05, 0.355, 0], size: [0.05, 0.07, 0.05], color: 0xe86a7a },
    ],
    stackable: false,
    textureType: 'cactus',
    lodLevels: 2,
  },
  // 柱状仙人掌小件 0.2×0.65×0.2
  {
    id: 'cactus_small_column',
    name: '柱状仙人掌小件',
    category: '植物',
    subcategory: '多肉',
    type: 'plant',
    shape: 'custom',
    size: [0.2, 0.65, 0.2],
    mass: 0.2 * 0.65 * 0.2 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.6,
    restitution: 0.06,
    color: 0x4a8c3f,
    icon: '🌵',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['仙人掌', '多肉', '桌面', '活体'],
    description:
      '细柱形仙人掌：主干直上 65 厘米，旁边还贴着一根更短的侧柱。' +
      '放在桌子边缘或窗台角上，细长所以不占地方；同属小件，压不得。',
    parts: [
      { shape: 'cylinder', position: [0, 0.07, 0], size: [0.2, 0.14, 0.2], color: 0xa8674a },
      { shape: 'cylinder', position: [0, 0.145, 0], size: [0.18, 0.015, 0.18], color: 0x6b4a2f },
      { shape: 'cylinder', position: [0, 0.4, 0], size: [0.1, 0.5, 0.1], color: 0x4a8c3f },
      { shape: 'cylinder', position: [-0.06, 0.32, 0], size: [0.08, 0.35, 0.08], color: 0x6fb04a },
    ],
    stackable: false,
    textureType: 'cactus',
    lodLevels: 2,
  },

  // ============================================================
  // 花卉（6）—— 盆栽花、花束、干花
  // ============================================================
  // 郁金香盆栽 0.18×0.52×0.18
  {
    id: 'flower_tulip',
    name: '郁金香盆栽',
    category: '植物',
    subcategory: '花卉',
    type: 'plant',
    shape: 'custom',
    size: [0.18, 0.52, 0.18],
    mass: 0.18 * 0.52 * 0.18 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.55,
    restitution: 0.05,
    color: 0xe86a7a,
    icon: '🌷',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['花卉', '郁金香', '窗台', '活体'],
    description:
      '一盆两支郁金香，一高一矮各顶一朵粉红色的花苞，连盆高 52 厘米。' +
      '放窗台正对光的位置最好，开花朝向会跟着太阳转。',
    parts: [
      { shape: 'cylinder', position: [0, 0.07, 0], size: [0.18, 0.14, 0.18], color: 0xb0563c },
      { shape: 'cylinder', position: [0, 0.15, 0], size: [0.16, 0.02, 0.16], color: 0x6b4a2f },
      { shape: 'cylinder', position: [-0.04, 0.27, 0], size: [0.02, 0.22, 0.02], color: 0x4a8c3f },
      { shape: 'sphere', position: [-0.04, 0.42, 0], size: [0.09, 0.12, 0.09], color: 0xe86a7a },
      { shape: 'cylinder', position: [0.04, 0.29, 0], size: [0.02, 0.26, 0.02], color: 0x4a8c3f },
      { shape: 'sphere', position: [0.04, 0.46, 0], size: [0.09, 0.12, 0.09], color: 0xd94f8a },
    ],
    stackable: false,
    textureType: 'dots',
    lodLevels: 2,
  },
  // 雏菊盆栽 0.22×0.33×0.22
  {
    id: 'flower_daisy',
    name: '雏菊盆栽',
    category: '植物',
    subcategory: '花卉',
    type: 'plant',
    shape: 'custom',
    size: [0.22, 0.33, 0.22],
    mass: 0.22 * 0.33 * 0.22 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.55,
    restitution: 0.05,
    color: 0xf2c14e,
    icon: '🌼',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['花卉', '雏菊', '桌面', '活体'],
    description:
      '矮盆里铺一层密叶，叶面上支起两朵黄色小花，整盆 33 厘米。' +
      '餐桌中间、茶几或者窗台边都放得下，越掐越开花的那种。',
    parts: [
      { shape: 'cylinder', position: [0, 0.06, 0], size: [0.16, 0.12, 0.16], color: 0xa8674a },
      { shape: 'cylinder', position: [0, 0.13, 0], size: [0.14, 0.02, 0.14], color: 0x6b4a2f },
      { shape: 'sphere', position: [0, 0.18, 0], size: [0.22, 0.1, 0.22], color: 0x4a8c3f },
      { shape: 'sphere', position: [0, 0.28, 0], size: [0.1, 0.1, 0.1], color: 0xf2c14e },
      { shape: 'sphere', position: [-0.07, 0.25, 0], size: [0.08, 0.08, 0.08], color: 0xf2c14e },
    ],
    stackable: false,
    textureType: 'dots',
    lodLevels: 1,
  },
  // 玫瑰花束 0.22×0.52×0.22
  {
    id: 'flower_rose_bouquet',
    name: '玫瑰花束',
    category: '植物',
    subcategory: '花卉',
    type: 'plant',
    shape: 'custom',
    size: [0.22, 0.52, 0.22],
    mass: 0.22 * 0.52 * 0.22 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.5,
    restitution: 0.06,
    color: 0xd94f8a,
    icon: '💐',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['花卉', '花束', '玫瑰', '礼物'],
    description:
      '锥形纸包里的三朵玫瑰，深粉色挤在一起，扎带在 34 厘米高处，' +
      '整束 52 厘米。放桌面当礼物、或者搁在边柜上装点房间都行；' +
      '花束没有盆，水养记得下面坐个小瓶。',
    parts: [
      { shape: 'cone', position: [0, 0.16, 0], size: [0.22, 0.32, 0.22], color: 0xd8cbb5 },
      { shape: 'cylinder', position: [0, 0.34, 0], size: [0.12, 0.04, 0.12], color: 0xe6a0b8 },
      { shape: 'sphere', position: [0, 0.46, 0], size: [0.12, 0.12, 0.12], color: 0xd94f8a },
      { shape: 'sphere', position: [0.06, 0.4, 0.03], size: [0.1, 0.11, 0.1], color: 0xe86a7a },
      { shape: 'sphere', position: [-0.06, 0.41, -0.02], size: [0.1, 0.11, 0.1], color: 0xc0392b },
    ],
    stackable: false,
    textureType: 'dots',
    lodLevels: 2,
  },
  // 混合花束 0.24×0.48×0.24
  {
    id: 'flower_bouquet_mixed',
    name: '混合花束',
    category: '植物',
    subcategory: '花卉',
    type: 'plant',
    shape: 'custom',
    size: [0.24, 0.48, 0.24],
    mass: 0.24 * 0.48 * 0.24 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.5,
    restitution: 0.06,
    color: 0xf2c14e,
    icon: '💐',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['花卉', '花束', '混合', '礼物'],
    description:
      '混色花束：粉、黄、玫红三种花配一把浅色纸包装，48 厘米高。' +
      '摆餐桌中央或者递给 NPC 都很像样，放在高处别让猫够到。',
    parts: [
      { shape: 'cone', position: [0, 0.14, 0], size: [0.24, 0.28, 0.24], color: 0xd8cbb5 },
      { shape: 'cylinder', position: [0, 0.3, 0], size: [0.14, 0.04, 0.14], color: 0x8fb8d8 },
      { shape: 'sphere', position: [0, 0.42, 0], size: [0.12, 0.12, 0.12], color: 0xe86a7a },
      { shape: 'sphere', position: [0.07, 0.37, 0.02], size: [0.1, 0.1, 0.1], color: 0xf2c14e },
      { shape: 'cone', position: [-0.07, 0.4, 0], size: [0.1, 0.14, 0.1], color: 0xd94f8a },
    ],
    stackable: false,
    textureType: 'dots',
    lodLevels: 2,
  },
  // 干花花束 0.16×0.64×0.16
  {
    id: 'flower_dried',
    name: '干花花束',
    category: '植物',
    subcategory: '花卉',
    type: 'plant',
    shape: 'custom',
    size: [0.16, 0.64, 0.16],
    mass: 0.16 * 0.64 * 0.16 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.55,
    restitution: 0.05,
    color: 0xc9a86a,
    icon: '🌾',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['花卉', '干花', '桌面', '免打理'],
    description:
      '细颈小陶瓶里插两支干花，穗子枯黄色，高 64 厘米，一直不用浇水。' +
      '摆在书架、玄关柜或卫生间台面上都合适，是唯一“放着不管也不会死”的那盆。',
    parts: [
      { shape: 'cylinder', position: [0, 0.13, 0], size: [0.16, 0.26, 0.16], color: 0xb0563c },
      { shape: 'cylinder', position: [-0.03, 0.38, 0], size: [0.02, 0.24, 0.02], color: 0x8b8a5a },
      { shape: 'sphere', position: [-0.03, 0.53, 0], size: [0.07, 0.14, 0.07], color: 0xc9a86a },
      { shape: 'cylinder', position: [0.03, 0.4, 0.02], size: [0.02, 0.28, 0.02], color: 0x8b8a5a },
      { shape: 'sphere', position: [0.03, 0.57, 0.02], size: [0.07, 0.14, 0.07], color: 0xd8b87a },
    ],
    stackable: false,
    textureType: 'vertical',
    lodLevels: 1,
  },
  // 蝴蝶兰盆栽 0.24×0.67×0.2
  {
    id: 'flower_orchid',
    name: '蝴蝶兰盆栽',
    category: '植物',
    subcategory: '花卉',
    type: 'plant',
    shape: 'custom',
    size: [0.24, 0.67, 0.2],
    mass: 0.24 * 0.67 * 0.2 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.55,
    restitution: 0.05,
    color: 0xd94f8a,
    icon: '🌸',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['花卉', '兰花', '桌面', '活体'],
    description:
      '蝴蝶兰：盆面铺着苔藓，一根细花梗斜着抽到 67 厘米高，' +
      '梗上错开两朵蝶形花。摆边柜、餐桌做中心花，室内明亮处就行，别暴晒。',
    parts: [
      { shape: 'cylinder', position: [0, 0.08, 0], size: [0.2, 0.16, 0.2], color: 0xa8674a },
      { shape: 'cylinder', position: [0, 0.17, 0], size: [0.18, 0.02, 0.18], color: 0x4a8c3f },
      // 两片宽叶贴着盆沿向两侧摊开
      { shape: 'sphere', position: [0, 0.2, 0], size: [0.24, 0.05, 0.16], color: 0x2f6b34 },
      { shape: 'cylinder', position: [0, 0.42, 0], size: [0.022, 0.5, 0.022], color: 0x4a8c3f },
      { shape: 'sphere', position: [0.05, 0.6, 0], size: [0.12, 0.1, 0.1], color: 0xd94f8a },
      { shape: 'sphere', position: [-0.04, 0.52, 0], size: [0.11, 0.1, 0.1], color: 0xe86a7a },
    ],
    stackable: false,
    textureType: 'dots',
    lodLevels: 2,
  },

  // ============================================================
  // 观叶（5）—— 看叶子的室内绿植、苔藓球、彩叶小盆
  // ============================================================
  // 龟背竹 0.54×0.91×0.32
  {
    id: 'leaf_monstera',
    name: '龟背竹',
    category: '植物',
    subcategory: '观叶',
    type: 'plant',
    shape: 'custom',
    size: [0.54, 0.91, 0.32],
    mass: 0.54 * 0.91 * 0.32 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.6,
    restitution: 0.04,
    color: 0x2f6b34,
    icon: '🪴',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['观叶', '龟背竹', '地面', '活体'],
    description:
      '龟背竹的大盆：粗茎上分两层向外摊开三片大叶子，最大的一片几乎有盆口那么宽，' +
      '整株 91 厘米。只能放地面，摆在客厅角落或沙发旁，是室内最抢眼的绿。',
    parts: [
      { shape: 'cylinder', position: [0, 0.13, 0], size: [0.32, 0.26, 0.32], color: 0xa8674a },
      { shape: 'cylinder', position: [0, 0.27, 0], size: [0.28, 0.02, 0.28], color: 0x6b4a2f },
      { shape: 'cylinder', position: [0, 0.5, 0], size: [0.04, 0.44, 0.04], color: 0x4a8c3f },
      { shape: 'sphere', position: [0.1, 0.78, 0], size: [0.34, 0.26, 0.28], color: 0x2f6b34 },
      { shape: 'sphere', position: [-0.1, 0.68, 0], size: [0.34, 0.24, 0.26], color: 0x4a8c3f },
      { shape: 'sphere', position: [0, 0.55, 0.06], size: [0.24, 0.2, 0.2], color: 0x6fb04a },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 3,
  },
  // 虎皮兰 0.24×0.78×0.24
  {
    id: 'leaf_snake',
    name: '虎皮兰',
    category: '植物',
    subcategory: '观叶',
    type: 'plant',
    shape: 'custom',
    size: [0.24, 0.78, 0.24],
    mass: 0.24 * 0.78 * 0.24 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.6,
    restitution: 0.04,
    color: 0x2f6b34,
    icon: '🌿',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['观叶', '虎皮兰', '地面', '活体'],
    description:
      '虎皮兰，三片直立的长剑叶从盆里戳出来，深浅绿相间，最高 78 厘米。' +
      '窄盆不占地方，放墙角、走廊尽头或者电视柜旁边都行，很耐旱。',
    parts: [
      { shape: 'cylinder', position: [0, 0.1, 0], size: [0.24, 0.2, 0.24], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0, 0.21, 0], size: [0.2, 0.02, 0.2], color: 0x6b4a2f },
      { shape: 'cone', position: [0, 0.5, 0], size: [0.1, 0.56, 0.06], color: 0x2f6b34 },
      { shape: 'cone', position: [-0.07, 0.45, 0.03], size: [0.09, 0.5, 0.05], color: 0x4a8c3f },
      { shape: 'cone', position: [0.07, 0.47, -0.03], size: [0.09, 0.52, 0.05], color: 0x6fb04a },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 2,
  },
  // 金钱树盆栽 0.34×0.88×0.3
  {
    id: 'leaf_zz_plant',
    name: '金钱树盆栽',
    category: '植物',
    subcategory: '观叶',
    type: 'plant',
    shape: 'custom',
    size: [0.34, 0.88, 0.3],
    mass: 0.34 * 0.88 * 0.3 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.6,
    restitution: 0.04,
    color: 0x4a8c3f,
    icon: '💰',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['观叶', '金钱树', '地面', '寓意'],
    description:
      '金钱树：粗壮的短茎上顶着一蓬油亮的椭圆叶，中间还挂着一簇矮一点的，' +
      '总高 88 厘米。放地面或矮凳上都稳，摆在门口或收银台边图个好彩头。',
    parts: [
      { shape: 'cylinder', position: [0, 0.11, 0], size: [0.26, 0.22, 0.26], color: 0xa8674a },
      { shape: 'cylinder', position: [0, 0.23, 0], size: [0.22, 0.02, 0.22], color: 0x6b4a2f },
      { shape: 'cylinder', position: [0, 0.47, 0], size: [0.05, 0.46, 0.05], color: 0x4a8c3f },
      { shape: 'sphere', position: [0, 0.78, 0], size: [0.34, 0.2, 0.3], color: 0x4a8c3f },
      { shape: 'sphere', position: [-0.05, 0.62, 0], size: [0.2, 0.16, 0.18], color: 0x6fb04a },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 2,
  },
  // 苔藓球 0.26×0.49×0.26
  {
    id: 'leaf_moss_ball',
    name: '苔藓球',
    category: '植物',
    subcategory: '观叶',
    type: 'plant',
    shape: 'custom',
    size: [0.26, 0.49, 0.26],
    mass: 0.26 * 0.49 * 0.26 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.6,
    restitution: 0.05,
    color: 0x4a8c3f,
    icon: '🟢',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['观叶', '苔藓', '桌面', '摆件'],
    description:
      '苔藓球：浅水盘里坐着一个长满绿苔的圆球，球顶再冒出一小枝新叶，' +
      '整套 49 厘米高。放书桌或洗手台边，隔几天喷点水；' +
      '圆球压不得，搁东西会直接滚下桌。',
    parts: [
      { shape: 'cylinder', position: [0, 0.02, 0], size: [0.24, 0.04, 0.24], color: 0xe6dcc8 },
      { shape: 'sphere', position: [0, 0.17, 0], size: [0.26, 0.26, 0.26], color: 0x4a8c3f },
      { shape: 'cylinder', position: [0, 0.36, 0], size: [0.02, 0.12, 0.02], color: 0x8fbf5a },
      { shape: 'sphere', position: [0, 0.45, 0], size: [0.1, 0.08, 0.1], color: 0x6fb04a },
    ],
    stackable: false,
    textureType: 'grass_top',
    lodLevels: 1,
  },
  // 网纹草小盆 0.2×0.32×0.18
  {
    id: 'leaf_fittonia',
    name: '网纹草小盆',
    category: '植物',
    subcategory: '观叶',
    type: 'plant',
    shape: 'custom',
    size: [0.2, 0.32, 0.18],
    mass: 0.2 * 0.32 * 0.18 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.55,
    restitution: 0.05,
    color: 0xe86a7a,
    icon: '🍃',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['观叶', '彩叶', '桌面', '活体'],
    description:
      '网纹草小盆：浅绿叶子铺成一丛，顶上再压一层带红脉的小叶，' +
      '32 厘米高。喜阴喜湿，放桌面角落、玻璃缸造景里都合适，别晒直射光。',
    parts: [
      { shape: 'cylinder', position: [0, 0.05, 0], size: [0.18, 0.1, 0.18], color: 0xe6dcc8 },
      { shape: 'cylinder', position: [0, 0.11, 0], size: [0.16, 0.02, 0.16], color: 0x6b4a2f },
      { shape: 'sphere', position: [0, 0.18, 0], size: [0.2, 0.13, 0.16], color: 0x8fbf5a },
      { shape: 'sphere', position: [0, 0.26, 0], size: [0.14, 0.12, 0.12], color: 0xe86a7a },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 1,
  },

  // ============================================================
  // 藤蔓（4）—— 垂吊、爬架
  // ============================================================
  // 常春藤垂盆 0.32×0.31×0.24
  {
    id: 'vine_ivy',
    name: '常春藤垂盆',
    category: '植物',
    subcategory: '藤蔓',
    type: 'plant',
    shape: 'custom',
    size: [0.32, 0.31, 0.24],
    mass: 0.32 * 0.31 * 0.24 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.55,
    restitution: 0.05,
    color: 0x4a8c3f,
    icon: '🌿',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['藤蔓', '常春藤', '垂吊', '活体'],
    description:
      '常春藤，盆口铺一层叶，两侧各垂一条短藤搭到桌面，总高 31 厘米。' +
      '放书架顶层、吊柜下沿或者窗台上，让藤慢慢往下爬；' +
      '垂下来的藤条很软，上面完全搁不住东西。',
    parts: [
      { shape: 'cylinder', position: [0, 0.075, 0], size: [0.2, 0.15, 0.2], color: 0xa8674a },
      { shape: 'cylinder', position: [0, 0.16, 0], size: [0.18, 0.02, 0.18], color: 0x6b4a2f },
      { shape: 'sphere', position: [0, 0.24, 0], size: [0.24, 0.14, 0.24], color: 0x4a8c3f },
      { shape: 'box', position: [-0.13, 0.09, 0], size: [0.06, 0.18, 0.04], color: 0x2f6b34 },
      { shape: 'box', position: [0.13, 0.09, 0], size: [0.06, 0.18, 0.04], color: 0x2f6b34 },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 2,
  },
  // 绿萝垂盆 0.34×0.36×0.28
  {
    id: 'vine_pothos',
    name: '绿萝垂盆',
    category: '植物',
    subcategory: '藤蔓',
    type: 'plant',
    shape: 'custom',
    size: [0.34, 0.36, 0.28],
    mass: 0.34 * 0.36 * 0.28 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.55,
    restitution: 0.05,
    color: 0x6fb04a,
    icon: '🪴',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['藤蔓', '绿萝', '垂吊', '活体'],
    description:
      '最能活的绿萝：盆口鼓着一团亮叶子，盆两侧各垂一条藤一直到桌面，' +
      '整件 36 厘米。放柜顶、书架高处或办公室隔板上都行，散光就够，' +
      '藤蔓软，压上去直接断。',
    parts: [
      { shape: 'cylinder', position: [0, 0.08, 0], size: [0.22, 0.16, 0.22], color: 0xb0563c },
      { shape: 'cylinder', position: [0, 0.17, 0], size: [0.2, 0.02, 0.2], color: 0x6b4a2f },
      { shape: 'sphere', position: [0, 0.27, 0], size: [0.28, 0.18, 0.28], color: 0x6fb04a },
      { shape: 'cylinder', position: [-0.15, 0.11, 0], size: [0.04, 0.22, 0.04], color: 0x4a8c3f },
      { shape: 'cylinder', position: [0.15, 0.11, 0], size: [0.04, 0.22, 0.04], color: 0x4a8c3f },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 2,
  },
  // 吊兰 0.56×0.52×0.34
  {
    id: 'vine_spider_plant',
    name: '吊兰',
    category: '植物',
    subcategory: '藤蔓',
    type: 'plant',
    shape: 'custom',
    size: [0.56, 0.52, 0.34],
    mass: 0.56 * 0.52 * 0.34 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.55,
    restitution: 0.05,
    color: 0x8fbf5a,
    icon: '🌾',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['藤蔓', '吊兰', '垂吊', '活体'],
    description:
      '吊兰：细长叶从盆里向外甩开成漏斗状，两侧各抽出一根匍匐茎，' +
      '茎端挂着一个小小的子株，展开 56 厘米。放高柜顶、窗台或吊钩下最合适，' +
      '子株悬在半空，整盆只有中间的花盆是被压得住的。',
    parts: [
      { shape: 'cylinder', position: [0, 0.075, 0], size: [0.2, 0.15, 0.2], color: 0xe6dcc8 },
      { shape: 'cylinder', position: [0, 0.16, 0], size: [0.18, 0.02, 0.18], color: 0x6b4a2f },
      { shape: 'cone', position: [0, 0.34, 0], size: [0.34, 0.36, 0.34], color: 0x8fbf5a },
      { shape: 'box', position: [-0.19, 0.36, 0], size: [0.18, 0.02, 0.02], color: 0x6fb04a },
      { shape: 'box', position: [0.19, 0.36, 0], size: [0.18, 0.02, 0.02], color: 0x6fb04a },
      { shape: 'sphere', position: [-0.22, 0.3, 0], size: [0.12, 0.1, 0.12], color: 0x4a8c3f },
      { shape: 'sphere', position: [0.22, 0.3, 0], size: [0.12, 0.1, 0.12], color: 0x4a8c3f },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 2,
  },
  // 藤架爬藤 0.4×0.77×0.18
  {
    id: 'vine_trellis',
    name: '藤架爬藤',
    category: '植物',
    subcategory: '藤蔓',
    type: 'plant',
    shape: 'custom',
    size: [0.4, 0.77, 0.18],
    mass: 0.4 * 0.77 * 0.18 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.6,
    restitution: 0.05,
    color: 0x4a8c3f,
    icon: '🌱',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['藤蔓', '爬架', '地面', '活体'],
    description:
      '独立小藤架：两根立杆撑着上下两道横档，藤顺着横档爬出三团叶子，' +
      '77 厘米高、40 厘米宽。放地面靠墙或摆在阳台一角，' +
      '架体是细杆，顶上那团叶子撑不住重物，但架子本身可以靠在墙上。',
    parts: [
      { shape: 'box', position: [-0.18, 0.3, 0], size: [0.04, 0.6, 0.04], color: 0x8b5a2b },
      { shape: 'box', position: [0.18, 0.3, 0], size: [0.04, 0.6, 0.04], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.3, 0], size: [0.4, 0.03, 0.03], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.5, 0], size: [0.4, 0.03, 0.03], color: 0x8b5a2b },
      { shape: 'sphere', position: [-0.08, 0.6, 0], size: [0.18, 0.16, 0.16], color: 0x4a8c3f },
      { shape: 'sphere', position: [0.09, 0.44, 0], size: [0.16, 0.14, 0.14], color: 0x6fb04a },
      { shape: 'sphere', position: [0, 0.68, 0], size: [0.2, 0.18, 0.18], color: 0x2f6b34 },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 2,
  },

  // ============================================================
  // 小型树（4）—— 盆景 + 竹子小件
  // ============================================================
  // 榕树盆景 0.46×0.54×0.3
  {
    id: 'tree_bonsai',
    name: '榕树盆景',
    category: '植物',
    subcategory: '小型树',
    type: 'plant',
    shape: 'custom',
    size: [0.46, 0.54, 0.3],
    mass: 0.46 * 0.54 * 0.3 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.62,
    restitution: 0.04,
    color: 0x4a8c3f,
    icon: '🌳',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['小型树', '盆景', '桌面', '活体'],
    description:
      '榕树盆景：浅方盆里一根矮壮主干，顶上一大两小三团树冠，54 厘米高。' +
      '放边几、窗台或博古架上都合适，方盆扁而宽，摆着很稳。',
    parts: [
      { shape: 'box', position: [0, 0.04, 0], size: [0.36, 0.08, 0.26], color: 0x8b5a2b },
      { shape: 'cylinder', position: [0, 0.19, 0], size: [0.06, 0.22, 0.06], color: 0x6b4a2f },
      { shape: 'sphere', position: [0, 0.42, 0], size: [0.34, 0.24, 0.3], color: 0x4a8c3f },
      { shape: 'sphere', position: [-0.12, 0.34, 0], size: [0.22, 0.16, 0.2], color: 0x2f6b34 },
      { shape: 'sphere', position: [0.12, 0.34, 0], size: [0.22, 0.16, 0.2], color: 0x2f6b34 },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 2,
  },
  // 松树盆景 0.48×0.58×0.26
  {
    id: 'tree_pine_bonsai',
    name: '松树盆景',
    category: '植物',
    subcategory: '小型树',
    type: 'plant',
    shape: 'custom',
    size: [0.48, 0.58, 0.26],
    mass: 0.48 * 0.58 * 0.26 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.62,
    restitution: 0.04,
    color: 0x2f6b34,
    icon: '🌲',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['小型树', '盆景', '松树', '活体'],
    description:
      '松树盆景：浅盆里主干活得偏右，往两边各伸一根横枝，枝头压着两团松针，' +
      '58 厘米高。放庭院台基、窗台或地面矮架上，' +
      '枝叶都轻，但盆是扁的，别在上面压重物。',
    parts: [
      { shape: 'box', position: [0, 0.045, 0], size: [0.36, 0.09, 0.26], color: 0x8b5a2b },
      { shape: 'cylinder', position: [0.03, 0.28, 0], size: [0.05, 0.38, 0.05], color: 0x6b4a2f },
      { shape: 'box', position: [-0.07, 0.44, 0], size: [0.22, 0.03, 0.03], color: 0x6b4a2f },
      { shape: 'box', position: [0.07, 0.36, 0], size: [0.22, 0.03, 0.03], color: 0x6b4a2f },
      { shape: 'sphere', position: [-0.12, 0.5, 0], size: [0.24, 0.16, 0.2], color: 0x2f6b34 },
      { shape: 'sphere', position: [0.12, 0.44, 0], size: [0.24, 0.16, 0.2], color: 0x4a8c3f },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 2,
  },
  // 小盆竹 0.52×1.39×0.36
  {
    id: 'bamboo_potted',
    name: '小盆竹',
    category: '植物',
    subcategory: '小型树',
    type: 'plant',
    shape: 'custom',
    size: [0.52, 1.39, 0.36],
    mass: 0.52 * 1.39 * 0.36 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.62,
    restitution: 0.04,
    color: 0x6fb04a,
    icon: '🎍',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['小型树', '竹子', '地面', '活体'],
    description:
      '陶盆里立着两根细竹，一根一米三六、一根略矮，竹梢挂着三团竹叶，' +
      '整盆 1.39 米。只能放地面，摆在阳台、庭院门边或客厅窗前当隔断，' +
      '长得快，过一阵就该分盆了。',
    parts: [
      { shape: 'cylinder', position: [0, 0.16, 0], size: [0.36, 0.32, 0.36], color: 0xa8674a },
      { shape: 'cylinder', position: [0, 0.33, 0], size: [0.32, 0.02, 0.32], color: 0x6b4a2f },
      { shape: 'cylinder', position: [0.08, 0.85, 0], size: [0.05, 1.02, 0.05], color: 0x8fbf5a },
      { shape: 'cylinder', position: [-0.08, 0.84, 0.04], size: [0.045, 1.0, 0.045], color: 0x6fb04a },
      { shape: 'sphere', position: [0.14, 1.3, 0], size: [0.24, 0.14, 0.18], color: 0x4a8c3f },
      { shape: 'sphere', position: [-0.14, 1.24, 0], size: [0.24, 0.14, 0.18], color: 0x6fb04a },
      { shape: 'sphere', position: [0, 1.32, 0], size: [0.2, 0.14, 0.16], color: 0x2f6b34 },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 2,
  },
  // 高竹盆栽 0.68×1.98×0.4
  {
    id: 'bamboo_tall',
    name: '高竹盆栽',
    category: '植物',
    subcategory: '小型树',
    type: 'plant',
    shape: 'custom',
    size: [0.68, 1.98, 0.4],
    mass: 0.68 * 1.98 * 0.4 * 120, // 密度 120（活体植物按极轻处理，盆栽的重量主要是土与盆）
    friction: 0.62,
    restitution: 0.04,
    color: 0x2f6b34,
    icon: '🎋',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['小型树', '竹子', '地面', '活体'],
    description:
      '大盆高竹：三根竹子高矮错开，最高的一根顶到 1.98 米，' +
      '两侧各挂一团竹叶。摆在庭院角落或室内大空间的地面上，' +
      '是这一批植物里最高的一件；大陶盆很沉，但也别往竹梢上挂东西。',
    parts: [
      { shape: 'cylinder', position: [0, 0.18, 0], size: [0.4, 0.36, 0.4], color: 0xb0563c },
      { shape: 'cylinder', position: [0, 0.37, 0], size: [0.36, 0.02, 0.36], color: 0x6b4a2f },
      { shape: 'cylinder', position: [0.1, 1.18, 0], size: [0.06, 1.6, 0.06], color: 0x6fb04a },
      { shape: 'cylinder', position: [-0.1, 1.13, 0.05], size: [0.05, 1.5, 0.05], color: 0x8fbf5a },
      { shape: 'cylinder', position: [0, 1.03, -0.06], size: [0.045, 1.3, 0.045], color: 0x4a8c3f },
      { shape: 'sphere', position: [0.2, 1.88, 0], size: [0.28, 0.16, 0.2], color: 0x2f6b34 },
      { shape: 'sphere', position: [-0.2, 1.72, 0], size: [0.28, 0.16, 0.2], color: 0x6fb04a },
    ],
    stackable: false,
    textureType: 'leaves',
    lodLevels: 2,
  },
];
