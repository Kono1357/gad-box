import type { BuildingDef } from '../../building/types';
import type { PhysicsComponent } from '../physicsComponents';

/**
 * 自然装饰类物品目录（25 个）。
 *
 * 与 `buildings/props.ts` 的 10 个老装饰件（地毯 / 挂画 / 花瓶 / 雕塑 / 喷泉 /
 * 旗子 / 告示牌 / 盆栽 / 窗帘 / 落地钟）id **完全不重叠** —— 那批是 M1.5 时代的
 * 粗坯，这里的是 M4 自然装饰线：同一品类做出「哪都能见到的样子」，并把
 * `subcategory` / `stackable` / `textureType` / `physicsComponents` / `lodLevels`
 * 这些 M4 字段真正用起来。
 *
 * 三条贯穿全文件的约定：
 * 1. 原点在**底面中心**，所以每个模型最低的那个 part 的 `position.y === size.y / 2`，
 *    `parts` 的包围盒下沿正好落在 y = 0。
 * 2. `size` 就是 `parts` 的包围盒：`size[i] = max(i) - min(i)`，不做任何手写缩放。
 * 3. `mass = size[0] * size[1] * size[2] * 密度`，密度写在 mass 那一行的注释里，
 *    取值只用工程里约定的那几档：陶瓷 2300 / 木材 650 / 玻璃 2500 / 金属 7800 /
 *    织物 300 / 石材 2600。
 *
 * `stackable` 一律按真实物理行为给：能稳稳托住东西的（地毯、雕塑、旗杆、石块）给
 * `true`；一压就倒、一压就扁的（花瓶、香薰、纸灯笼、羽毛）给 `false`。
 */
export const DECORATION_ITEMS: BuildingDef[] = [
  // ============================================================
  // 地毯（3）—— 极薄、踩上去不滑、能压住东西
  // ============================================================
  // 圆形地毯 1.8×0.034×1.8
  {
    id: 'rug_round',
    name: '圆形地毯',
    category: '装饰',
    subcategory: '地毯',
    type: 'decoration',
    shape: 'cylinder',
    size: [1.8, 0.034, 1.8],
    mass: 1.8 * 0.034 * 1.8 * 300, // 密度 300（织物：短绒地毯）
    friction: 0.88,
    restitution: 0.02,
    color: 0x9c5b4a,
    icon: '🟤',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['软装', '布艺', '地面', '踩上去不滑'],
    description:
      '圆形短绒地毯，铺在玄关或椅子下面就够用。绒面厚 3 厘米出头，踩上去不滑，' +
      '摩擦系数给到 0.88，站在上面推重物也不用担心打滑。',
    parts: [
      { shape: 'cylinder', position: [0, 0.012, 0], size: [1.8, 0.024, 1.8], color: 0x9c5b4a },
      { shape: 'cylinder', position: [0, 0.02, 0], size: [1.2, 0.016, 1.2], color: 0xd8cbb5 },
      { shape: 'cylinder', position: [0, 0.026, 0], size: [0.4, 0.016, 0.4], color: 0xd4a437 },
    ],
    // 铺地的薄片：锁住旋转，免得被踩得转圈
    physicsComponents: [
      { type: 'rigidbody', params: { mode: 'static', lockRotation: true } },
      { type: 'collider', params: { shape: 'auto', friction: 0.88, restitution: 0.02 } },
    ] satisfies PhysicsComponent[],
    stackable: true,
    textureType: 'noise',
    lodLevels: 1,
  },
  // 长条地毯 0.8×0.028×2.4
  {
    id: 'rug_runner',
    name: '长条地毯',
    category: '装饰',
    subcategory: '地毯',
    type: 'decoration',
    shape: 'cuboid',
    size: [0.8, 0.028, 2.4],
    mass: 0.8 * 0.028 * 2.4 * 300, // 密度 300（织物：平织走道毯）
    friction: 0.86,
    restitution: 0.02,
    color: 0x8a4b3c,
    icon: '🧶',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['软装', '布艺', '地面', '走道', '踩上去不滑'],
    description:
      '细长的走道毯，铺在门厅到客厅那一段最合适。不到 3 厘米厚，门缝压得住，' +
      '底面摩擦 0.86，踩上去不滑也不卷边。',
    parts: [
      { shape: 'box', position: [0, 0.012, 0], size: [0.8, 0.024, 2.4], color: 0x8a4b3c },
      { shape: 'box', position: [0, 0.02, 0], size: [0.72, 0.016, 2.3], color: 0xd8cbb5 },
    ],
    physicsComponents: [
      { type: 'rigidbody', params: { mode: 'static', lockRotation: true } },
      { type: 'collider', params: { shape: 'auto', friction: 0.86, restitution: 0.02 } },
    ] satisfies PhysicsComponent[],
    stackable: true,
    textureType: 'speckle',
    lodLevels: 1,
  },
  // 长绒地毯 1.6×0.048×1.1
  {
    id: 'rug_shag',
    name: '长绒地毯',
    category: '装饰',
    subcategory: '地毯',
    type: 'decoration',
    shape: 'cuboid',
    size: [1.6, 0.048, 1.1],
    mass: 1.6 * 0.048 * 1.1 * 300, // 密度 300（织物：长毛绒）
    friction: 0.9,
    restitution: 0.01,
    color: 0xc9b8a0,
    icon: '🧸',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['软装', '布艺', '地面', '绒面', '踩上去不滑'],
    description:
      '米色长毛地毯，厚 4.8 厘米，是这套地毯里最软的一张。绒面抓地很牢，' +
      '踩上去不滑，光脚踩也舒服，适合铺在床边或沙发前。',
    parts: [
      { shape: 'box', position: [0, 0.024, 0], size: [1.6, 0.048, 1.1], color: 0xc9b8a0 },
      { shape: 'sphere', position: [0.45, 0.036, 0.22], size: [0.34, 0.024, 0.34], color: 0xf2e6d8 },
      { shape: 'sphere', position: [-0.45, 0.036, -0.22], size: [0.3, 0.024, 0.3], color: 0xf2e6d8 },
    ],
    physicsComponents: [
      { type: 'rigidbody', params: { mode: 'static', lockRotation: true } },
      { type: 'collider', params: { shape: 'auto', friction: 0.9, restitution: 0.01 } },
    ] satisfies PhysicsComponent[],
    stackable: true,
    textureType: 'noise',
    lodLevels: 1,
  },

  // ============================================================
  // 挂画（5）—— 薄板 + 挂墙语义（画、相框、挂钟、窗帘）
  // ============================================================
  // 风景挂画 1.2×1.0×0.056
  {
    id: 'painting_landscape',
    name: '风景挂画',
    category: '装饰',
    subcategory: '挂画',
    type: 'decoration',
    shape: 'cuboid',
    size: [1.2, 1.0, 0.056],
    mass: 1.2 * 1.0 * 0.056 * 650, // 密度 650（木材：画框为主体）
    friction: 0.45,
    restitution: 0.08,
    color: 0x4a6f8c,
    icon: '🖼️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['挂墙', '艺术', '木框', '墙面'],
    description:
      '横幅风景画，木框里是远山压着一片湖水。整块板只有 5.6 厘米厚，' +
      '挂在沙发背后的墙上最合适，也可以先斜靠在地面上当临时摆设。',
    parts: [
      { shape: 'box', position: [0, 0.5, 0], size: [1.2, 1.0, 0.04], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.5, 0.022], size: [1.06, 0.86, 0.012], color: 0xd8cbb5 },
      { shape: 'box', position: [0, 0.66, 0.03], size: [0.9, 0.3, 0.012], color: 0x4a6f8c },
      { shape: 'box', position: [0, 0.34, 0.03], size: [0.9, 0.2, 0.012], color: 0x5b8fb0 },
    ],
    // 竖直悬挂的薄板，压不住东西
    stackable: false,
    textureType: 'plank',
    lodLevels: 2,
  },
  // 抽象挂画 0.9×0.9×0.058
  {
    id: 'painting_abstract',
    name: '抽象挂画',
    category: '装饰',
    subcategory: '挂画',
    type: 'decoration',
    shape: 'cuboid',
    size: [0.9, 0.9, 0.058],
    mass: 0.9 * 0.9 * 0.058 * 650, // 密度 650（木材：画框为主体）
    friction: 0.45,
    restitution: 0.08,
    color: 0xf2f6f8,
    icon: '🎨',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['挂墙', '艺术', '现代', '墙面'],
    description:
      '正方形抽象画，本色底上压两块红蓝几何色块，比风景画更利落。' +
      '厚 5.8 厘米，适合挂在书桌上方或者走廊尽头补一块颜色。',
    parts: [
      { shape: 'box', position: [0, 0.45, 0], size: [0.9, 0.9, 0.036], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.45, 0.022], size: [0.78, 0.78, 0.012], color: 0xf2f6f8 },
      { shape: 'box', position: [0.15, 0.55, 0.034], size: [0.3, 0.3, 0.012], color: 0xc0392b },
      { shape: 'box', position: [-0.16, 0.33, 0.034], size: [0.26, 0.26, 0.012], color: 0x2c6fb0 },
    ],
    stackable: false,
    textureType: 'plank',
    lodLevels: 2,
  },
  // 相框 0.5×0.6×0.056
  {
    id: 'picture_frame',
    name: '相框',
    category: '装饰',
    subcategory: '挂画',
    type: 'decoration',
    shape: 'cuboid',
    size: [0.5, 0.6, 0.056],
    mass: 0.5 * 0.6 * 0.056 * 650, // 密度 650（木材：相框）
    friction: 0.45,
    restitution: 0.08,
    color: 0x8b5a2b,
    icon: '🖼',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['挂墙', '照片', '木框', '小件'],
    description:
      '单人相框，木框里是一张小照片。只有 5.6 厘米厚，挂床头、挂书桌上方都行，' +
      '和挂画排成一列会很像画廊的那面墙。',
    parts: [
      { shape: 'box', position: [0, 0.3, 0], size: [0.5, 0.6, 0.04], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.3, 0.022], size: [0.42, 0.52, 0.012], color: 0xf2f6f8 },
      { shape: 'box', position: [0, 0.3, 0.032], size: [0.2, 0.3, 0.008], color: 0x2c3e50 },
    ],
    stackable: false,
    textureType: 'plank',
    lodLevels: 1,
  },
  // 挂钟 0.36×0.36×0.054
  {
    id: 'clock_wall',
    name: '挂钟',
    category: '装饰',
    subcategory: '挂画',
    type: 'decoration',
    shape: 'cuboid',
    size: [0.36, 0.36, 0.054],
    mass: 0.36 * 0.36 * 0.054 * 650, // 密度 650（木材：钟壳）
    friction: 0.4,
    restitution: 0.08,
    color: 0x8b5a2b,
    icon: '🕐',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['挂墙', '钟表', '木壳', '墙面'],
    description:
      '方形挂钟，木壳里浅色钟面上两根指针停在十点十分。厚 5.4 厘米，' +
      '挂在厨房墙上或者工作间门口，比落地钟省地方。',
    parts: [
      { shape: 'box', position: [0, 0.18, 0], size: [0.36, 0.36, 0.048], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.18, 0.02], size: [0.3, 0.3, 0.008], color: 0xf2f6f8 },
      { shape: 'box', position: [0.02, 0.2, 0.027], size: [0.12, 0.018, 0.006], color: 0x2c3e50 },
      { shape: 'box', position: [-0.02, 0.15, 0.027], size: [0.018, 0.08, 0.006], color: 0x2c3e50 },
    ],
    stackable: false,
    textureType: 'plank',
    lodLevels: 1,
  },
  // 蕾丝窗帘 1.8×1.625×0.05
  {
    id: 'curtain_lace',
    name: '蕾丝窗帘',
    category: '装饰',
    subcategory: '挂画',
    type: 'decoration',
    shape: 'cuboid',
    size: [1.8, 1.625, 0.05],
    mass: 1.8 * 1.625 * 0.05 * 300, // 密度 300（织物：窗帘布）
    friction: 0.7,
    restitution: 0.02,
    color: 0xf2f6f8,
    icon: '🪟',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['挂墙', '布艺', '窗户', '遮光'],
    description:
      '两片对开的薄窗帘，木杆横在 1.6 米高处，帘布带一点点透光的花纹。' +
      '装在窗框两侧，遮一半光正好；它挂在杆上，顶上压不了东西。',
    parts: [
      { shape: 'box', position: [0, 1.6, 0], size: [1.8, 0.05, 0.05], color: 0x8b5a2b },
      { shape: 'box', position: [-0.45, 0.8, 0], size: [0.8, 1.6, 0.04], color: 0xf2f6f8 },
      { shape: 'box', position: [0.45, 0.8, 0], size: [0.8, 1.6, 0.04], color: 0xf2f6f8 },
      { shape: 'box', position: [0, 1.53, 0], size: [1.7, 0.1, 0.05], color: 0xe6dcc8 },
    ],
    stackable: false,
    textureType: 'wave',
    lodLevels: 2,
  },

  // ============================================================
  // 摆件（5）—— 桌面/地面上的立体陈设
  // ============================================================
  // 陶瓷花瓶 0.2×0.44×0.2
  {
    id: 'vase_porcelain',
    name: '陶瓷花瓶',
    category: '装饰',
    subcategory: '摆件',
    type: 'decoration',
    shape: 'cylinder',
    size: [0.2, 0.44, 0.2],
    mass: 0.2 * 0.44 * 0.2 * 2300, // 密度 2300（陶瓷）
    friction: 0.45,
    restitution: 0.12,
    color: 0x3f6fb0,
    icon: '🏺',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['摆件', '陶瓷', '桌面', '插花'],
    description:
      '细颈青花瓶，肚大颈小，插一两枝干花正合适。重心高，一压就倒，' +
      '放在边柜或窗台上，别摆在过道中间。',
    parts: [
      { shape: 'cylinder', position: [0, 0.16, 0], size: [0.2, 0.32, 0.2], color: 0x3f6fb0 },
      { shape: 'cylinder', position: [0, 0.36, 0], size: [0.1, 0.08, 0.1], color: 0x3f6fb0 },
      { shape: 'cylinder', position: [0, 0.42, 0], size: [0.14, 0.04, 0.14], color: 0xdff2f5 },
    ],
    stackable: false,
    textureType: 'marble',
    lodLevels: 1,
  },
  // 玻璃花瓶 0.18×0.29×0.18
  {
    id: 'vase_glass',
    name: '玻璃花瓶',
    category: '装饰',
    subcategory: '摆件',
    type: 'decoration',
    shape: 'cylinder',
    size: [0.18, 0.29, 0.18],
    mass: 0.18 * 0.29 * 0.18 * 2500, // 密度 2500（玻璃）
    friction: 0.35,
    restitution: 0.15,
    color: 0xbfe6ea,
    icon: '🥛',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['摆件', '玻璃', '桌面', '通透'],
    description:
      '矮胖的透明玻璃瓶，收口处有一圈厚唇。摆在餐桌中央当水培容器很好看，' +
      '玻璃又滑又轻，压一下就滚走，所以不参与堆叠。',
    parts: [
      { shape: 'cylinder', position: [0, 0.045, 0], size: [0.18, 0.09, 0.18], color: 0xbfe6ea },
      { shape: 'cylinder', position: [0, 0.16, 0], size: [0.14, 0.14, 0.14], color: 0xbfe6ea },
      { shape: 'cylinder', position: [0, 0.26, 0], size: [0.17, 0.06, 0.17], color: 0xdff2f5 },
    ],
    stackable: false,
    textureType: 'wave',
    lodLevels: 1,
  },
  // 半身像雕塑 0.5×0.88×0.5
  {
    id: 'sculpture_bust',
    name: '半身像雕塑',
    category: '装饰',
    subcategory: '摆件',
    type: 'decoration',
    shape: 'custom',
    size: [0.5, 0.88, 0.5],
    mass: 0.5 * 0.88 * 0.5 * 2600, // 密度 2600（石材：整尊大理石）
    friction: 0.65,
    restitution: 0.04,
    color: 0xe8e2d8,
    icon: '🗿',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['摆件', '石材', '雕塑', '广场'],
    description:
      '白色大理石半身像，方形基座上接胸像、脖颈和头。整尊按石头算重量，' +
      '结实到可以把小东西搁在肩上，放在门厅或广场中央都压得住场子。',
    parts: [
      { shape: 'box', position: [0, 0.1, 0], size: [0.5, 0.2, 0.5], color: 0xdcd6cc },
      { shape: 'box', position: [0, 0.35, 0], size: [0.44, 0.3, 0.32], color: 0xe8e2d8 },
      { shape: 'cylinder', position: [0, 0.55, 0], size: [0.16, 0.1, 0.16], color: 0xe8e2d8 },
      { shape: 'sphere', position: [0, 0.72, 0], size: [0.32, 0.32, 0.32], color: 0xe8e2d8 },
    ],
    physicsComponents: [
      { type: 'collider', params: { shape: 'auto', friction: 0.65, restitution: 0.04 } },
    ] satisfies PhysicsComponent[],
    stackable: true,
    textureType: 'marble',
    lodLevels: 2,
  },
  // 石喷泉 1.4×1.12×1.4
  {
    id: 'fountain_stone',
    name: '石喷泉',
    category: '装饰',
    subcategory: '摆件',
    type: 'decoration',
    shape: 'custom',
    size: [1.4, 1.12, 1.4],
    mass: 1.4 * 1.12 * 1.4 * 2600, // 密度 2600（石材：整座石砌，所以极重）
    friction: 0.7,
    restitution: 0.03,
    color: 0x9aa7b0,
    icon: '⛲',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['水景', '石材', '广场', '庭园'],
    description:
      '三层石喷泉：底下是盛水的方池，池心立一根石柱，柱顶顶着浅口接水盘。' +
      '整套按实心石材算，重得离谱，放进广场或庭园正中就不该再挪了。',
    parts: [
      { shape: 'cylinder', position: [0, 0.2, 0], size: [1.4, 0.4, 1.4], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0, 0.7, 0], size: [0.3, 0.6, 0.3], color: 0xcfd6da },
      { shape: 'cylinder', position: [0, 1.06, 0], size: [0.8, 0.12, 0.8], color: 0x9aa7b0 },
    ],
    physicsComponents: [
      { type: 'collider', params: { shape: 'auto', friction: 0.7, restitution: 0.03 } },
      // 池口是传感器：只判断有没有东西落进水里，不参与实心碰撞
      { type: 'trigger', params: { shape: 'cylinder', size: [1.3, 0.34, 1.3], offset: [0, 0.22, 0] } },
    ] satisfies PhysicsComponent[],
    stackable: true,
    textureType: 'marble',
    lodLevels: 3,
  },
  // 装饰陶盆 0.4×0.295×0.4
  {
    id: 'planter_ceramic',
    name: '装饰陶盆',
    category: '装饰',
    subcategory: '摆件',
    type: 'decoration',
    shape: 'cylinder',
    size: [0.4, 0.295, 0.4],
    mass: 0.4 * 0.295 * 0.4 * 2300, // 密度 2300（陶瓷：厚胎陶盆）
    friction: 0.6,
    restitution: 0.08,
    color: 0xb0563c,
    icon: '🏺',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['摆件', '容器', '陶瓷', '陶盆'],
    description:
      '敞口浅陶盆，盆沿外翻，里面填着土但**没有种东西** —— 它是容器，不是活植物。' +
      '摆在窗台或地面上当花器，想种什么再往里放；浅口盆重心不稳，压不动东西。',
    parts: [
      { shape: 'cylinder', position: [0, 0.13, 0], size: [0.36, 0.26, 0.36], color: 0xb0563c },
      { shape: 'cylinder', position: [0, 0.275, 0], size: [0.4, 0.03, 0.4], color: 0xc96a4a },
      { shape: 'cylinder', position: [0, 0.285, 0], size: [0.32, 0.02, 0.32], color: 0x6b4a2f },
    ],
    stackable: false,
    textureType: 'speckle',
    lodLevels: 1,
  },

  // ============================================================
  // 灯具装饰（4）—— 烛台、香薰、纸灯笼、灯串
  // ============================================================
  // 木托烛台 0.42×0.52×0.24
  {
    id: 'candle_holder',
    name: '木托烛台',
    category: '装饰',
    subcategory: '灯具装饰',
    type: 'decoration',
    shape: 'custom',
    size: [0.42, 0.52, 0.24],
    mass: 0.42 * 0.52 * 0.24 * 650, // 密度 650（木材：木托与烛臂；蜡烛忽略）
    friction: 0.55,
    restitution: 0.06,
    color: 0x8b5a2b,
    icon: '🕯️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['烛台', '木材', '桌面', '照明'],
    description:
      '双头木烛台：圆底盘、中柱、一根横臂，两端各插一支白烛，烛尖有两点火苗。' +
      '摆在餐桌或壁炉台上，细长造型一碰就晃，别在上面搁其他东西。',
    parts: [
      { shape: 'cylinder', position: [0, 0.02, 0], size: [0.24, 0.04, 0.24], color: 0x6b4a2f },
      { shape: 'cylinder', position: [0, 0.16, 0], size: [0.06, 0.24, 0.06], color: 0x8b5a2b },
      { shape: 'box', position: [0, 0.295, 0], size: [0.42, 0.03, 0.05], color: 0x8b5a2b },
      { shape: 'cylinder', position: [-0.18, 0.38, 0], size: [0.05, 0.14, 0.05], color: 0xf2f6f8 },
      { shape: 'cylinder', position: [0.18, 0.38, 0], size: [0.05, 0.14, 0.05], color: 0xf2f6f8 },
      { shape: 'cone', position: [-0.18, 0.485, 0], size: [0.06, 0.07, 0.06], color: 0xf2c14e },
      { shape: 'cone', position: [0.18, 0.485, 0], size: [0.06, 0.07, 0.06], color: 0xf2c14e },
    ],
    stackable: false,
    textureType: 'plank',
    lodLevels: 1,
  },
  // 香薰烛炉 0.2×0.26×0.2
  {
    id: 'incense_burner',
    name: '香薰烛炉',
    category: '装饰',
    subcategory: '灯具装饰',
    type: 'decoration',
    shape: 'custom',
    size: [0.2, 0.26, 0.2],
    mass: 0.2 * 0.26 * 0.2 * 2300, // 密度 2300（陶瓷：厚胎油碗）
    friction: 0.5,
    restitution: 0.06,
    color: 0xe6dcc8,
    icon: '🪔',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['香薰', '陶瓷', '桌面', '点燃'],
    description:
      '陶瓷香薰炉，托盘上放浅碗，碗底一支小蜡烛顶着橙色的火苗，' +
      '热水里滴精油就能慢慢散味。摆在床头柜或浴室台面上，一压就翻，别当镇纸用。',
    parts: [
      { shape: 'cylinder', position: [0, 0.03, 0], size: [0.2, 0.06, 0.2], color: 0xe6dcc8 },
      { shape: 'cylinder', position: [0, 0.11, 0], size: [0.18, 0.1, 0.18], color: 0xf2f6f8 },
      { shape: 'cone', position: [0, 0.21, 0], size: [0.1, 0.1, 0.1], color: 0xf2c14e },
    ],
    stackable: false,
    textureType: 'marble',
    lodLevels: 1,
  },
  // 纸灯笼 0.3×0.4×0.3
  {
    id: 'lantern_paper',
    name: '纸灯笼',
    category: '装饰',
    subcategory: '灯具装饰',
    type: 'decoration',
    shape: 'cylinder',
    size: [0.3, 0.4, 0.3],
    mass: 0.3 * 0.4 * 0.3 * 300, // 密度 300（织物：纸/绢面与竹箍）
    friction: 0.45,
    restitution: 0.05,
    color: 0xe8a33d,
    icon: '🏮',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['灯笼', '纸质', '悬挂', '暖光'],
    description:
      '橙黄色纸灯笼，上下各一道竹箍，中间鼓着肚子透着暖光。' +
      '可以搁在檐下，也可以放在矮柜上当地灯用；纸面一压就瘪，所以不参与堆叠。',
    parts: [
      { shape: 'cylinder', position: [0, 0.18, 0], size: [0.3, 0.36, 0.3], color: 0xe8a33d },
      { shape: 'cylinder', position: [0, 0.02, 0], size: [0.2, 0.04, 0.2], color: 0x8b5a2b },
      { shape: 'cylinder', position: [0, 0.38, 0], size: [0.2, 0.04, 0.2], color: 0x8b5a2b },
    ],
    stackable: false,
    textureType: 'grid',
    lodLevels: 2,
  },
  // 灯串 2.0×0.08×0.06
  {
    id: 'fairy_lights',
    name: '灯串',
    category: '装饰',
    subcategory: '灯具装饰',
    type: 'decoration',
    shape: 'cuboid',
    size: [2.0, 0.08, 0.06],
    mass: 2.0 * 0.08 * 0.06 * 300, // 密度 300（织物：细线材与塑料灯珠，按最轻一档估）
    friction: 0.5,
    restitution: 0.15,
    color: 0xf2e6c8,
    icon: '✨',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['灯串', '装饰光', '地面', '缠绕'],
    description:
      '两米长的暖白灯串，细线上等距串着三颗灯珠，整条几乎贴着地面摊平，' +
      '厚度不到一指。可以沿着地板边缘铺，也可以绕在栏杆上，压过去不会坏。',
    parts: [
      { shape: 'box', position: [0, 0.01, 0], size: [2.0, 0.02, 0.02], color: 0x2c3e50 },
      { shape: 'sphere', position: [-0.7, 0.05, 0], size: [0.06, 0.06, 0.06], color: 0xf2e6c8 },
      { shape: 'sphere', position: [0, 0.05, 0], size: [0.06, 0.06, 0.06], color: 0xf2e6c8 },
      { shape: 'sphere', position: [0.7, 0.05, 0], size: [0.06, 0.06, 0.06], color: 0xf2e6c8 },
    ],
    stackable: true,
    textureType: 'dots',
    lodLevels: 1,
  },

  // ============================================================
  // 旗帜（2）—— 细杆 + 面片
  // ============================================================
  // 竖幅旗 0.84×1.875×0.28
  {
    id: 'banner_vertical',
    name: '竖幅旗',
    category: '装饰',
    subcategory: '旗帜',
    type: 'decoration',
    shape: 'custom',
    size: [0.84, 1.875, 0.28],
    mass: 0.84 * 1.875 * 0.28 * 300, // 密度 300（织物：旗面为主，细杆很轻）
    friction: 0.5,
    restitution: 0.08,
    color: 0xc0392b,
    icon: '🚩',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['旗帜', '标记', '细杆', '阵营'],
    description:
      '一面竖着挂的旗：小圆底座压着一根一米八的细杆，红布从杆顶垂到 0.8 米处。' +
      '杆子是实心的，底座结实，立在营地口当阵营标记；杆顶还能挂小挂件。',
    parts: [
      { shape: 'cylinder', position: [-0.32, 0.035, 0], size: [0.28, 0.07, 0.28], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [-0.32, 0.9, 0], size: [0.06, 1.8, 0.06], color: 0x9aa7b0 },
      { shape: 'box', position: [0.05, 1.3, 0], size: [0.66, 1.02, 0.03], color: 0xc0392b },
      { shape: 'sphere', position: [-0.32, 1.83, 0], size: [0.09, 0.09, 0.09], color: 0xd4a437 },
    ],
    stackable: true,
    textureType: 'wave',
    lodLevels: 2,
  },
  // 三角旗串 1.7×1.6×0.05
  {
    id: 'pennant_banner',
    name: '三角旗串',
    category: '装饰',
    subcategory: '旗帜',
    type: 'decoration',
    shape: 'custom',
    size: [1.7, 1.6, 0.05],
    mass: 1.7 * 1.6 * 0.05 * 300, // 密度 300（织物：旗面为主，细杆很轻）
    friction: 0.5,
    restitution: 0.08,
    color: 0xe8a33d,
    icon: '🎏',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['旗帜', '标记', '细杆', '节庆'],
    description:
      '两根细杆之间拉一根绳，绳上挂着四面黄旗，离地一米六。' +
      '摆在摊位前面或者院子里当彩头很热闹；杆子够硬，旗串本身也不怕压。',
    parts: [
      { shape: 'cylinder', position: [-0.8, 0.8, 0], size: [0.05, 1.6, 0.05], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0.8, 0.8, 0], size: [0.05, 1.6, 0.05], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 1.5, 0], size: [1.7, 0.02, 0.02], color: 0x3a3f44 },
      { shape: 'box', position: [-0.55, 1.36, 0], size: [0.24, 0.26, 0.02], color: 0xe8a33d },
      { shape: 'box', position: [-0.2, 1.36, 0], size: [0.24, 0.26, 0.02], color: 0xc0392b },
      { shape: 'box', position: [0.15, 1.36, 0], size: [0.24, 0.26, 0.02], color: 0x2c6fb0 },
      { shape: 'box', position: [0.5, 1.36, 0], size: [0.24, 0.26, 0.02], color: 0x4f9d3f },
    ],
    stackable: true,
    textureType: 'wave',
    lodLevels: 2,
  },

  // ============================================================
  // 标识（2）—— 细杆 + 面片
  // ============================================================
  // 方向指示牌 1.12×1.5×0.34
  {
    id: 'sign_direction',
    name: '方向指示牌',
    category: '装饰',
    subcategory: '标识',
    type: 'decoration',
    shape: 'custom',
    size: [1.12, 1.5, 0.34],
    mass: 1.12 * 1.5 * 0.34 * 650, // 密度 650（木材：立杆与牌面）
    friction: 0.55,
    restitution: 0.06,
    color: 0x8b5a2b,
    icon: '🧭',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['标识', '木制', '路标', '细杆'],
    description:
      '一柱两牌的指路牌：圆底座上立细杆，杆上一左一右钉着两块木牌，' +
      '分别指向两条岔路。立在广场或营地岔口最合适，牌薄杆细，别往上面压货。',
    parts: [
      { shape: 'cylinder', position: [0, 0.045, 0], size: [0.34, 0.09, 0.34], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0, 0.75, 0], size: [0.08, 1.5, 0.08], color: 0x8b5a2b },
      { shape: 'box', position: [0.26, 1.3, 0], size: [0.6, 0.22, 0.05], color: 0x8b5a2b },
      { shape: 'box', position: [-0.26, 1.0, 0], size: [0.6, 0.22, 0.05], color: 0x8b5a2b },
    ],
    stackable: false,
    textureType: 'plank',
    lodLevels: 2,
  },
  // 告示牌 0.7×1.47×0.36
  {
    id: 'sign_notice',
    name: '告示牌',
    category: '装饰',
    subcategory: '标识',
    type: 'decoration',
    shape: 'custom',
    size: [0.7, 1.47, 0.36],
    mass: 0.7 * 1.47 * 0.36 * 650, // 密度 650（木材：立杆与面板）
    friction: 0.55,
    restitution: 0.06,
    color: 0xd8cbb5,
    icon: '🪧',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['标识', '木制', '提示', '细杆'],
    description:
      '立在路边的告示牌：石头底座压着细木杆，杆顶一块浅色面板，' +
      '板面留出写字的位置。放在农场入口或工地边上提示路人；' +
      '面板是单薄的木板，压不住重物。',
    parts: [
      { shape: 'box', position: [0, 0.03, 0], size: [0.36, 0.06, 0.36], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0, 0.5, 0], size: [0.09, 1.0, 0.09], color: 0x8b5a2b },
      { shape: 'box', position: [0, 1.25, 0], size: [0.7, 0.44, 0.06], color: 0x8b5a2b },
      { shape: 'box', position: [0, 1.25, 0.045], size: [0.56, 0.32, 0.03], color: 0xd8cbb5 },
    ],
    stackable: false,
    textureType: 'plank',
    lodLevels: 2,
  },

  // ============================================================
  // 收藏品（4）—— 贝壳、羽毛、化石，桌面小样
  // ============================================================
  // 海螺 0.19×0.2×0.14
  {
    id: 'shell_conch',
    name: '海螺',
    category: '装饰',
    subcategory: '收藏品',
    type: 'decoration',
    shape: 'custom',
    size: [0.19, 0.2, 0.14],
    mass: 0.19 * 0.2 * 0.14 * 2600, // 密度 2600（贝壳近似碳酸钙，按石材算）
    friction: 0.5,
    restitution: 0.15,
    color: 0xe8c9a8,
    icon: '🐚',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['收藏品', '贝壳', '桌面', '海产'],
    description:
      '圆锥形海螺，螺口朝左、螺尖斜向右上，是最常见的那种卷壳。' +
      '摆在书架或边柜上当旅行纪念品；壳是实心的，压点小东西也不会碎。',
    parts: [
      { shape: 'sphere', position: [0, 0.06, 0], size: [0.18, 0.12, 0.14], color: 0xe8c9a8 },
      { shape: 'cone', position: [0.045, 0.155, 0], size: [0.1, 0.09, 0.1], color: 0xd8b48a },
      { shape: 'cylinder', position: [-0.05, 0.045, 0], size: [0.09, 0.09, 0.09], color: 0xf2e6d8 },
    ],
    stackable: true,
    textureType: 'noise',
    lodLevels: 1,
  },
  // 扇贝壳 0.16×0.11×0.14
  {
    id: 'shell_scallop',
    name: '扇贝壳',
    category: '装饰',
    subcategory: '收藏品',
    type: 'decoration',
    shape: 'custom',
    size: [0.16, 0.11, 0.14],
    mass: 0.16 * 0.11 * 0.14 * 2600, // 密度 2600（贝壳近似碳酸钙，按石材算）
    friction: 0.5,
    restitution: 0.18,
    color: 0xf2d8c0,
    icon: '🦪',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['收藏品', '贝壳', '桌面', '海产'],
    description:
      '扁平的扇贝壳，壳顶的铰合轴和放射状壳纹都做出来了，平放在桌面上很稳。' +
      '可以当小托盘放戒指或耳钉，摆梳妆台和洗手台边都合适。',
    parts: [
      { shape: 'sphere', position: [0, 0.035, 0], size: [0.16, 0.07, 0.14], color: 0xf2d8c0 },
      { shape: 'box', position: [0, 0.08, -0.055], size: [0.1, 0.02, 0.03], color: 0xd8b48a },
      { shape: 'cone', position: [0, 0.09, 0.03], size: [0.06, 0.04, 0.06], color: 0xe8c9a8 },
    ],
    stackable: true,
    textureType: 'dots',
    lodLevels: 1,
  },
  // 羽毛摆件 0.14×0.34×0.14
  {
    id: 'feather_plume',
    name: '羽毛摆件',
    category: '装饰',
    subcategory: '收藏品',
    type: 'decoration',
    shape: 'custom',
    size: [0.14, 0.34, 0.14],
    mass: 0.14 * 0.34 * 0.14 * 300, // 密度 300（织物：羽毛极轻，按最轻一档估）
    friction: 0.45,
    restitution: 0.1,
    color: 0x8fb8d8,
    icon: '🪶',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['收藏品', '羽毛', '桌面', '轻质'],
    description:
      '一根立在小圆托上的蓝灰色羽毛，羽轴细、羽片薄得像纸。' +
      '摆在书桌角上或者标本柜里好看，但它轻得几乎没有重量，' +
      '碰一下就倒，千万不要把东西搁在它上面。',
    parts: [
      { shape: 'cylinder', position: [0, 0.02, 0], size: [0.14, 0.04, 0.14], color: 0x6b4a2f },
      { shape: 'cylinder', position: [0, 0.16, 0], size: [0.02, 0.24, 0.02], color: 0xf2f6f8 },
      { shape: 'sphere', position: [0, 0.26, 0], size: [0.1, 0.16, 0.03], color: 0x8fb8d8 },
      { shape: 'sphere', position: [0, 0.14, 0], size: [0.08, 0.12, 0.03], color: 0xa8cbe0 },
    ],
    stackable: false,
    textureType: 'vertical',
    lodLevels: 1,
  },
  // 菊石化石 0.34×0.29×0.3
  {
    id: 'fossil_ammonite',
    name: '菊石化石',
    category: '装饰',
    subcategory: '收藏品',
    type: 'decoration',
    shape: 'custom',
    size: [0.34, 0.29, 0.3],
    mass: 0.34 * 0.29 * 0.3 * 2600, // 密度 2600（石材：整体是岩块）
    friction: 0.65,
    restitution: 0.04,
    color: 0x8a8f94,
    icon: '🦕',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['收藏品', '化石', '岩石', '展品'],
    description:
      '一块砂岩里嵌着半露的菊石，螺旋纹一圈圈收向中心的螺心。' +
      '整块是实心石头，压得住纸也垫得住书，放展台或书架上当镇纸都行。',
    parts: [
      { shape: 'box', position: [0, 0.06, 0], size: [0.34, 0.12, 0.3], color: 0x8a8f94 },
      { shape: 'cylinder', position: [0, 0.19, 0], size: [0.26, 0.14, 0.26], color: 0xa8a49c },
      { shape: 'cylinder', position: [0, 0.27, 0], size: [0.14, 0.04, 0.14], color: 0xc9c4b8 },
    ],
    stackable: true,
    textureType: 'noise',
    lodLevels: 2,
  },
];
