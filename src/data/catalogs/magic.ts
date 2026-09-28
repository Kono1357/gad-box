import type { BuildingDef } from '../../building/types';

/**
 * M4 奇幻类模型（15 个）。
 *
 * 约定与其它 catalog 一致：**原点在底面中心**，parts 从 y = 0 往上堆，`size` 是包围盒。
 *
 * 奇幻类的两条额外要求：
 * 1. 造型仍然"用方块拼出来"：只用 box / cylinder / sphere / cone 摆形状，不捏造 parts 之外的东西。
 * 2. **描述要说清它在玩法上怎么用**：这些物品的能力一律靠**逻辑连线 + 触发器**实现，
 *    物品本身只提供外挂点（`physicsComponents` 里的 trigger / collider）。
 *    所以描述里写的是"接上触发器后会发生什么""要把事件连到哪里"，
 *    不会假装它自带传送、控重力、时间减速这些能力。
 *
 * 颜色刻意用高饱和 / 自发光的色值：0x8b5cf6 紫、0x22d3ee 青、0xf472b6 粉、0xfacc15 黄。
 */
export const MAGIC_ITEMS: BuildingDef[] = [
  // ============================================================
  // 传送（2）
  // ============================================================
  // 传送门框 2.2×3.25×0.9
  {
    id: 'portal_arch',
    name: '传送门框',
    category: '奇幻',
    subcategory: '传送',
    type: 'magic',
    shape: 'custom',
    size: [2.2, 3.25, 0.9],
    // 体积 6.435 m³ × 等效密度 150 kg/m³ ≈ 965 kg（石基座 + 两根能量柱 + 顶梁）
    mass: 2.2 * 3.25 * 0.9 * 150,
    friction: 0.5,
    restitution: 0.1,
    color: 0x8b5cf6,
    icon: '🌀',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '传送', '门框', '触发器'],
    description:
      '传送门框：两根紫柱加顶梁，中间一片青色门面。**它自己不会传送** —— 门面自带 1.5×2.6 米的盒形触发区，' +
      '要把 trigger 的 onEnter 连到「传送到目标」事件、并指定另一座门或信标当落点，走进去才会被挪过去。',
    parts: [
      // 石基座：0 → 0.15
      { shape: 'box', position: [0, 0.075, 0], size: [2.2, 0.15, 0.9], color: 0x9aa7b0 },
      // 两根能量柱：0.15 → 2.95
      { shape: 'box', position: [-0.9, 1.55, 0], size: [0.28, 2.8, 0.5], color: 0x8b5cf6 },
      { shape: 'box', position: [0.9, 1.55, 0], size: [0.28, 2.8, 0.5], color: 0x8b5cf6 },
      // 顶梁：2.95 → 3.25
      { shape: 'box', position: [0, 3.1, 0], size: [2.2, 0.3, 0.5], color: 0x8b5cf6 },
      // 门面：薄薄一片，触发区就贴在这上面
      { shape: 'box', position: [0, 1.55, 0], size: [1.5, 2.6, 0.06], color: 0x22d3ee },
    ],
    physicsComponents: [
      { type: 'trigger', params: { shape: 'box', size: [1.5, 2.6, 0.4], offset: [0, 1.55, 0], onEnter: 'teleport' } },
    ],
  },
  // 传送踏板 1.6×0.32×1.6
  {
    id: 'portal_pad',
    name: '传送踏板',
    category: '奇幻',
    subcategory: '传送',
    type: 'magic',
    shape: 'cylinder',
    size: [1.6, 0.32, 1.6],
    // 体积 0.819 m³ × 等效密度 400 kg/m³ ≈ 328 kg（石板 + 发光内圈 + 四块符石）
    mass: 1.6 * 0.32 * 1.6 * 400,
    friction: 0.6,
    restitution: 0.05,
    color: 0x22d3ee,
    icon: '🔵',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '传送', '踏板', '触发器'],
    description:
      '传送踏板：1.6 米圆盘内嵌一圈发光符文。踩上去本身什么都没发生 —— 盘面自带 1.6 米直径的柱形触发区，' +
      '要自己把它连到「传送到目标」事件上，它才会当落点或弹射器用。',
    parts: [
      // 圆台：0 → 0.20
      { shape: 'cylinder', position: [0, 0.1, 0], size: [1.6, 0.2, 1.6], color: 0x9aa7b0 },
      // 发光内圈：0.20 → 0.26
      { shape: 'cylinder', position: [0, 0.23, 0], size: [1.2, 0.06, 1.2], color: 0x22d3ee },
      // 四块符石：0.26 → 0.32
      { shape: 'cylinder', position: [0.45, 0.29, 0.45], size: [0.16, 0.06, 0.16], color: 0xf472b6 },
      { shape: 'cylinder', position: [-0.45, 0.29, 0.45], size: [0.16, 0.06, 0.16], color: 0xf472b6 },
      { shape: 'cylinder', position: [0.45, 0.29, -0.45], size: [0.16, 0.06, 0.16], color: 0xf472b6 },
      { shape: 'cylinder', position: [-0.45, 0.29, -0.45], size: [0.16, 0.06, 0.16], color: 0xf472b6 },
    ],
    physicsComponents: [
      { type: 'trigger', params: { shape: 'cylinder', size: [1.6, 0.5, 1.6], offset: [0, 0.25, 0], onEnter: 'teleport' } },
    ],
  },

  // ============================================================
  // 能量（3）
  // ============================================================
  // 魔力水晶簇 1.0×1.8×1.0
  {
    id: 'crystal_cluster',
    name: '魔力水晶簇',
    category: '奇幻',
    subcategory: '能量',
    type: 'magic',
    shape: 'custom',
    size: [1.0, 1.8, 1.0],
    // 体积 1.8 m³ × 等效密度 400 kg/m³ ≈ 720 kg（石座 + 四根晶柱）
    mass: 1.0 * 1.8 * 1.0 * 400,
    friction: 0.5,
    restitution: 0.15,
    color: 0x8b5cf6,
    icon: '💎',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '水晶', '能量源', '采集'],
    description:
      '魔力水晶簇：石座上一根 1.6 米高主晶，周围三根矮晶。当能量源用：给它接一根「输入事件 → 改变颜色」的连线，' +
      '充满能量时整簇会亮起来，玩家一眼就能看出哪台机器在供电。',
    parts: [
      // 石座：0 → 0.20
      { shape: 'cylinder', position: [0, 0.1, 0], size: [1.0, 0.2, 1.0], color: 0x9aa7b0 },
      // 主晶：0.20 → 1.80
      { shape: 'cone', position: [0, 1.0, 0], size: [0.5, 1.6, 0.5], color: 0x8b5cf6 },
      // 三根侧晶
      { shape: 'cone', position: [-0.28, 0.65, 0.12], size: [0.34, 0.9, 0.34], color: 0x8b5cf6 },
      { shape: 'cone', position: [0.3, 0.55, -0.1], size: [0.28, 0.7, 0.28], color: 0x22d3ee },
      { shape: 'cone', position: [0.1, 0.45, 0.3], size: [0.2, 0.5, 0.2], color: 0x22d3ee },
    ],
  },
  // 能量核心 1.2×1.25×1.2
  {
    id: 'energy_core',
    name: '能量核心',
    category: '奇幻',
    subcategory: '能量',
    type: 'magic',
    shape: 'custom',
    size: [1.2, 1.25, 1.2],
    // 体积 1.8 m³ × 等效密度 250 kg/m³ ≈ 450 kg（金属架 + 悬浮能量球）
    mass: 1.2 * 1.25 * 1.2 * 250,
    friction: 0.5,
    restitution: 0.15,
    color: 0xfacc15,
    icon: '🔆',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '能量', '核', '供能'],
    description:
      '能量核心：四根支柱顶着顶环，中间夹一颗发光球。把它当发电机的能量节点：从别的机器引事件过来，' +
      '再用它往外分发给传送门、黑洞这些耗能装置，形成一条供能链。',
    parts: [
      // 底座：0 → 0.25
      { shape: 'cylinder', position: [0, 0.125, 0], size: [1.2, 0.25, 1.2], color: 0x3a3f44 },
      // 四根支柱：0.25 → 1.15
      { shape: 'box', position: [0.4, 0.7, 0.4], size: [0.12, 0.9, 0.12], color: 0x9aa7b0 },
      { shape: 'box', position: [-0.4, 0.7, 0.4], size: [0.12, 0.9, 0.12], color: 0x9aa7b0 },
      { shape: 'box', position: [0.4, 0.7, -0.4], size: [0.12, 0.9, 0.12], color: 0x9aa7b0 },
      { shape: 'box', position: [-0.4, 0.7, -0.4], size: [0.12, 0.9, 0.12], color: 0x9aa7b0 },
      // 能量球：0.50 → 1.20
      { shape: 'sphere', position: [0, 0.85, 0], size: [0.7, 0.7, 0.7], color: 0xfacc15 },
      // 顶环：1.15 → 1.25
      { shape: 'cylinder', position: [0, 1.2, 0], size: [1.0, 0.1, 1.0], color: 0x9aa7b0 },
    ],
  },
  // 蓄能水晶 0.7×1.55×0.7
  {
    id: 'crystal_battery',
    name: '蓄能水晶',
    category: '奇幻',
    subcategory: '能量',
    type: 'magic',
    shape: 'custom',
    size: [0.7, 1.55, 0.7],
    // 体积 0.7595 m³ × 等效密度 500 kg/m³ ≈ 380 kg（金属壳 + 晶体柱 + 电极）
    mass: 0.7 * 1.55 * 0.7 * 500,
    friction: 0.6,
    restitution: 0.1,
    color: 0x22d3ee,
    icon: '🔋',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '储能', '电池', '逻辑'],
    description:
      '蓄能水晶：金属底座里竖一根 1.1 米晶体柱，顶上两个电极。当逻辑记忆位用 —— 接「进入 → 开灯」进来，' +
      '再接「离开 → 关灯」出去，就能记住某块区域有没有人，进而控制门和传送门。',
    parts: [
      // 金属底壳：0 → 0.15
      { shape: 'box', position: [0, 0.075, 0], size: [0.7, 0.15, 0.7], color: 0x3a3f44 },
      // 晶体柱：0.15 → 1.25
      { shape: 'cylinder', position: [0, 0.7, 0], size: [0.5, 1.1, 0.5], color: 0x22d3ee },
      // 顶盖：1.25 → 1.35
      { shape: 'box', position: [0, 1.3, 0], size: [0.6, 0.1, 0.6], color: 0x9aa7b0 },
      // 两个电极：1.35 → 1.55
      { shape: 'cylinder', position: [-0.2, 1.45, 0], size: [0.1, 0.2, 0.1], color: 0xfacc15 },
      { shape: 'cylinder', position: [0.2, 1.45, 0], size: [0.1, 0.2, 0.1], color: 0xfacc15 },
    ],
  },

  // ============================================================
  // 操控（4）—— 这四个都**不带**物理组件，能力必须由玩家接逻辑连线实现
  // ============================================================
  // 重力翻转器 1.4×3.77×1.4
  {
    id: 'gravity_flipper',
    name: '重力翻转器',
    category: '奇幻',
    subcategory: '操控',
    type: 'magic',
    shape: 'custom',
    size: [1.4, 3.77, 1.4],
    // 体积 7.389 m³ × 等效密度 120 kg/m³ ≈ 887 kg（石座 + 立柱 + 倒锥 + 2 块悬浮试样）
    mass: 1.4 * 3.77 * 1.4 * 120,
    friction: 0.6,
    restitution: 0.05,
    color: 0xf472b6,
    icon: '🔄',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '重力', '翻转', '逻辑'],
    description:
      '重力翻转器：立柱顶端一个倒扣的能量锥，锥口上方飘着两块试样方块。' +
      '**它自己不会改重力**：需要用逻辑连线把触发器接到它身上，再把它的输出连到「切换重力方向」这一动作，' +
      '激活后附近物体才会往上掉。倒扣的锥就是给玩家看"这里是反重力出口"。',
    parts: [
      // 石座：0 → 0.30
      { shape: 'box', position: [0, 0.15, 0], size: [1.4, 0.3, 1.4], color: 0x9aa7b0 },
      // 立柱：0.30 → 2.30
      { shape: 'box', position: [0, 1.3, 0], size: [0.4, 2.0, 0.4], color: 0xf472b6 },
      // 倒扣能量锥：2.30 → 3.10
      { shape: 'cone', position: [0, 2.7, 0], size: [1.2, 0.8, 1.2], rotationZ: Math.PI, color: 0x8b5cf6 },
      // 两块被"翻上去"的悬浮试样
      { shape: 'box', position: [-0.5, 3.4, 0], size: [0.3, 0.3, 0.3], color: 0x22d3ee },
      { shape: 'box', position: [0.55, 3.65, 0.1], size: [0.24, 0.24, 0.24], color: 0x22d3ee },
    ],
  },
  // 时间减速器 1.2×2.6×1.2
  {
    id: 'time_dilator',
    name: '时间减速器',
    category: '奇幻',
    subcategory: '操控',
    type: 'magic',
    shape: 'custom',
    size: [1.2, 2.6, 1.2],
    // 体积 3.744 m³ × 等效密度 150 kg/m³ ≈ 562 kg（底座 + 立杆 + 表盘 + 指针）
    mass: 1.2 * 2.6 * 1.2 * 150,
    friction: 0.6,
    restitution: 0.05,
    color: 0x8b5cf6,
    icon: '⏳',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '时间', '减速', '逻辑'],
    description:
      '时间减速器：立杆顶端竖着一块 1 米直径的表盘，两根指针指着不同方向。' +
      '**减速效果不是它自带的**：要在逻辑连线里把触发器和它连起来，再给被影响的物体接上"放慢"的动作，' +
      '圈内的机械臂、传送带才会变慢。表盘是指针可视化用的。',
    parts: [
      // 底座：0 → 0.25
      { shape: 'cylinder', position: [0, 0.125, 0], size: [1.2, 0.25, 1.2], color: 0x3a3f44 },
      // 立杆：0.25 → 1.85
      { shape: 'cylinder', position: [0, 1.05, 0], size: [0.2, 1.6, 0.2], color: 0x9aa7b0 },
      // 竖直表盘：轴沿 X（rotationZ 放倒），1.60 → 2.60
      { shape: 'cylinder', position: [0, 2.1, 0], size: [1.0, 0.12, 1.0], rotationZ: Math.PI / 2, color: 0x8b5cf6 },
      // 两根指针：贴在盘面上
      { shape: 'box', position: [0, 2.25, 0.08], size: [0.06, 0.5, 0.04], color: 0xfacc15 },
      { shape: 'box', position: [0.1, 2.1, 0.08], size: [0.4, 0.06, 0.04], color: 0xfacc15 },
    ],
  },
  // 力场发生器 2.6×2.85×2.6
  {
    id: 'force_field_emitter',
    name: '力场发生器',
    category: '奇幻',
    subcategory: '操控',
    type: 'magic',
    shape: 'custom',
    size: [2.6, 2.85, 2.6],
    // 体积 19.27 m³ × 等效密度 10 kg/m³ ≈ 193 kg（力场罩是能量体不算质量，只算发射器本体）
    mass: 2.6 * 2.85 * 2.6 * 10,
    friction: 0.5,
    restitution: 0.1,
    color: 0x22d3ee,
    icon: '🛡️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '力场', '护盾', '逻辑'],
    description:
      '力场发生器：1 米底座上立柱顶着发射头，外面罩着一层 2.6 米的青色力场球。' +
      '**罩子默认只是看着像**：要把触发器接到它，再连「生成物体 / 销毁物体 / 变色」这些动作，' +
      '才能真的挡住或弹开来袭的方块。',
    parts: [
      // 底座：0 → 0.25
      { shape: 'box', position: [0, 0.125, 0], size: [1.0, 0.25, 1.0], color: 0x3a3f44 },
      // 立柱：0.25 → 1.25
      { shape: 'box', position: [0, 0.75, 0], size: [0.3, 1.0, 0.3], color: 0x9aa7b0 },
      // 发射头：1.25 → 1.65
      { shape: 'cylinder', position: [0, 1.45, 0], size: [0.8, 0.4, 0.8], color: 0x8b5cf6 },
      // 力场罩：0.65 → 2.85（比发射头大一圈，整件最宽处）
      { shape: 'sphere', position: [0, 1.75, 0], size: [2.6, 2.2, 2.6], color: 0x22d3ee },
    ],
  },
  // 浮空石台 1.6×1.6×1.6
  {
    id: 'levitation_stone',
    name: '浮空石台',
    category: '奇幻',
    subcategory: '操控',
    type: 'magic',
    shape: 'custom',
    size: [1.6, 1.6, 1.6],
    // 体积 4.096 m³ × 等效密度 300 kg/m³ ≈ 1229 kg（石台 + 光环 + 三块碎石）
    mass: 1.6 * 1.6 * 1.6 * 300,
    friction: 0.7,
    restitution: 0.05,
    color: 0x9aa7b0,
    icon: '🪨',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '浮空', '平台', '逻辑'],
    description:
      '浮空石台：1.6 米石板悬在 1.2 米高处，下面一圈青色光环托着，地面散着三块碎石。' +
      '**它不会自己上下浮动**：想让它升降得接逻辑连线（触发器 → 播放动画 / 切换电机），' +
      '当电梯或空中小平台用。台面平整，上面能站东西。',
    parts: [
      // 悬空石板：1.20 → 1.60
      { shape: 'box', position: [0, 1.4, 0], size: [1.6, 0.4, 1.6], color: 0x9aa7b0 },
      // 托举光环：0.86 → 0.94
      { shape: 'cylinder', position: [0, 0.9, 0], size: [1.4, 0.08, 1.4], color: 0x22d3ee },
      // 三块地上碎石（最下面那块贴地，把原点压在 y = 0）
      { shape: 'sphere', position: [0.3, 0.12, 0.2], size: [0.3, 0.24, 0.3], color: 0x8a8f94 },
      { shape: 'sphere', position: [-0.35, 0.42, -0.15], size: [0.24, 0.2, 0.24], color: 0x8a8f94 },
      { shape: 'sphere', position: [0.15, 0.66, 0.4], size: [0.2, 0.16, 0.2], color: 0x8a8f94 },
    ],
  },

  // ============================================================
  // 特殊方块（6）
  // ============================================================
  // 黑洞 2.6×2.2×2.6
  {
    id: 'black_hole',
    name: '黑洞',
    category: '奇幻',
    subcategory: '特殊方块',
    type: 'magic',
    shape: 'sphere',
    size: [2.6, 2.2, 2.6],
    // 体积 14.87 m³ × 等效密度 60 kg/m³ ≈ 892 kg（底座 + 吸积盘 + 视界球，密度按能量体折算）
    mass: 2.6 * 2.2 * 2.6 * 60,
    friction: 0.5,
    restitution: 0.05,
    color: 0x8b5cf6,
    icon: '🕳️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '黑洞', '吸积盘', '触发器'],
    description:
      '黑洞：2 米底座上架着 2.6 米的紫色吸积盘，盘心一颗黑色视界球，旁边有块石头正被吸过去。' +
      '盘面自带球形触发区，把 onEnter 连到「销毁物体」就能当垃圾桶，连到「传送到目标」就变成吸入式传送口。',
    parts: [
      // 底座：0 → 0.30
      { shape: 'box', position: [0, 0.15, 0], size: [2.0, 0.3, 2.0], color: 0x3a3f44 },
      // 吸积盘：1.34 → 1.46
      { shape: 'cylinder', position: [0, 1.4, 0], size: [2.6, 0.12, 2.6], color: 0x8b5cf6 },
      // 事件视界球：0.60 → 2.20
      { shape: 'sphere', position: [0, 1.4, 0], size: [1.6, 1.6, 1.6], color: 0x1e1b4b },
      // 被吸起来的碎片
      { shape: 'sphere', position: [0.8, 0.5, 0.4], size: [0.3, 0.3, 0.3], color: 0x8a8f94 },
    ],
    physicsComponents: [
      { type: 'trigger', params: { shape: 'sphere', size: [2.6, 2.2, 2.6], offset: [0, 1.4, 0], onEnter: 'destroy-object' } },
    ],
  },
  // 生成器 1.2×1.35×1.2
  {
    id: 'spawner_block',
    name: '生成器',
    category: '奇幻',
    subcategory: '特殊方块',
    type: 'magic',
    shape: 'cube',
    size: [1.2, 1.35, 1.2],
    // 体积 1.944 m³ × 等效密度 350 kg/m³ ≈ 680 kg（石基座 + 核心方块 + 顶口）
    mass: 1.2 * 1.35 * 1.2 * 350,
    friction: 0.6,
    restitution: 0.05,
    color: 0x22d3ee,
    icon: '📦',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '生成', '刷物', '触发器'],
    description:
      '生成器：方形核心放在基座上，顶面开一个圆形喷口，物件从这里冒出来。' +
      '接管子用：把触发器（按钮、踏板、接近传感器）连到它，动作选「生成物体」并指定要生成的模型 id，' +
      '再配一个冷却时间，就成了一条自动产线。',
    parts: [
      // 基座：0 → 0.20
      { shape: 'box', position: [0, 0.1, 0], size: [1.2, 0.2, 1.2], color: 0x3a3f44 },
      // 核心方块：0.20 → 1.20
      { shape: 'box', position: [0, 0.7, 0], size: [1.0, 1.0, 1.0], color: 0x22d3ee },
      // 顶部喷口：1.20 → 1.35
      { shape: 'cylinder', position: [0, 1.275, 0], size: [0.6, 0.15, 0.6], color: 0x8b5cf6 },
    ],
    physicsComponents: [
      { type: 'trigger', params: { shape: 'box', size: [1.2, 1.35, 1.2], onEnter: 'spawn-object' } },
    ],
  },
  // 销毁器 1.2×1.17×1.2
  {
    id: 'void_block',
    name: '销毁器',
    category: '奇幻',
    subcategory: '特殊方块',
    type: 'magic',
    shape: 'cube',
    size: [1.2, 1.17, 1.2],
    // 体积 1.685 m³ × 等效密度 400 kg/m³ ≈ 674 kg（石框 + 核心 + 漩涡）
    mass: 1.2 * 1.17 * 1.2 * 400,
    friction: 0.6,
    restitution: 0.05,
    color: 0x1e1b4b,
    icon: '🗑️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '销毁', '回收', '触发器'],
    description:
      '销毁器：上下两块石板夹一个方框，框心是紫色漩涡。把送料传送带的物件推进来，或者把它接到「进入 → 销毁物体」' +
      '的连线上，就能把用不上的东西直接吃掉，给沙盘清垃圾。',
    parts: [
      // 基座：0 → 0.15
      { shape: 'box', position: [0, 0.075, 0], size: [1.2, 0.15, 1.2], color: 0x3a3f44 },
      // 方框主体：0.15 → 1.05
      { shape: 'box', position: [0, 0.6, 0], size: [1.0, 0.9, 1.0], color: 0x1e1b4b },
      // 中心漩涡：0.30 → 0.90
      { shape: 'sphere', position: [0, 0.6, 0], size: [0.6, 0.6, 0.6], color: 0x8b5cf6 },
      // 顶框：1.05 → 1.17
      { shape: 'box', position: [0, 1.11, 0], size: [1.2, 0.12, 1.2], color: 0x3a3f44 },
    ],
    physicsComponents: [
      { type: 'trigger', params: { shape: 'box', size: [1.0, 0.9, 1.0], offset: [0, 0.6, 0], onEnter: 'destroy-object' } },
    ],
  },
  // 克隆器 1.6×1.65×1.2
  {
    id: 'clone_block',
    name: '克隆器',
    category: '奇幻',
    subcategory: '特殊方块',
    type: 'magic',
    shape: 'custom',
    size: [1.6, 1.65, 1.2],
    // 体积 3.168 m³ × 等效密度 300 kg/m³ ≈ 950 kg（宽底座 + 核心方块 + 双晶体）
    mass: 1.6 * 1.65 * 1.2 * 300,
    friction: 0.6,
    restitution: 0.05,
    color: 0xf472b6,
    icon: '👥',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '克隆', '复制', '触发器'],
    description:
      '克隆器：1.6 米宽底座托着核心方块，顶上并排两颗粉色晶体（表示"一份变两份"）。' +
      '用法同生成器但生成的是**同一个模型**：接上触发器 → 「生成物体」，再把生成点放在旁边，就能批量复制方块搭结构。',
    parts: [
      // 底座：0 → 0.20
      { shape: 'box', position: [0, 0.1, 0], size: [1.6, 0.2, 1.2], color: 0x3a3f44 },
      // 核心方块：0.20 → 1.20
      { shape: 'box', position: [0, 0.7, 0], size: [1.2, 1.0, 1.0], color: 0xf472b6 },
      // 双晶体：1.25 → 1.65
      { shape: 'sphere', position: [-0.3, 1.45, 0], size: [0.4, 0.4, 0.4], color: 0x22d3ee },
      { shape: 'sphere', position: [0.3, 1.45, 0], size: [0.4, 0.4, 0.4], color: 0x22d3ee },
    ],
    physicsComponents: [
      { type: 'trigger', params: { shape: 'box', size: [1.2, 1.0, 1.0], offset: [0, 0.7, 0], onEnter: 'spawn-object' } },
    ],
  },
  // 光源球 1.1×1.65×1.1
  {
    id: 'light_orb',
    name: '光源球',
    category: '奇幻',
    subcategory: '特殊方块',
    type: 'magic',
    shape: 'custom',
    size: [1.1, 1.65, 1.1],
    // 体积 1.997 m³ × 等效密度 250 kg/m³ ≈ 499 kg（石座 + 立柱 + 玻璃光球 + 光环）
    mass: 1.1 * 1.65 * 1.1 * 250,
    friction: 0.5,
    restitution: 0.1,
    color: 0xfacc15,
    icon: '💡',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '光源', '照明', '触发器'],
    description:
      '光源球：立柱顶着一颗 0.9 米直径的黄色光球，球外一圈光环。默认是亮的；' +
      '想做成感应灯就把接近传感器接到它，动作选「开灯/关灯」—— 人走到附近亮、走开灭，比常亮省电。',
    parts: [
      // 石座：0 → 0.15
      { shape: 'box', position: [0, 0.075, 0], size: [1.0, 0.15, 1.0], color: 0x9aa7b0 },
      // 立柱：0.15 → 0.75
      { shape: 'cylinder', position: [0, 0.45, 0], size: [0.18, 0.6, 0.18], color: 0x9aa7b0 },
      // 光球：0.75 → 1.65
      { shape: 'sphere', position: [0, 1.2, 0], size: [0.9, 0.9, 0.9], color: 0xfacc15 },
      // 光环：整件最宽处 1.1 米
      { shape: 'cylinder', position: [0, 1.3, 0], size: [1.1, 0.06, 1.1], color: 0xf2f6f8 },
    ],
    physicsComponents: [
      { type: 'trigger', params: { shape: 'sphere', size: [1.1, 1.1, 1.1], offset: [0, 1.2, 0], onEnter: 'toggle-light' } },
    ],
  },
  // 粒子喷泉 1.4×2.24×1.4
  {
    id: 'particle_fountain',
    name: '粒子喷泉',
    category: '奇幻',
    subcategory: '特殊方块',
    type: 'magic',
    shape: 'custom',
    size: [1.4, 2.24, 1.4],
    // 体积 4.39 m³ × 等效密度 150 kg/m³ ≈ 659 kg（石座 + 喷口 + 核心球 + 三颗浮空粒子）
    mass: 1.4 * 2.24 * 1.4 * 150,
    friction: 0.6,
    restitution: 0.05,
    color: 0x22d3ee,
    icon: '✨',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['魔法', '粒子', '特效', '装饰'],
    description:
      '粒子喷泉：1.4 米圆座上喷口往上喷，核心球悬在 1 米高处，上面散着三颗越飘越高的粒子。' +
      '当纯装饰或者事件提示器用：接「播放动画 / 播放音效」的连线，机器一开工它就喷，比看面板直观。',
    parts: [
      // 圆座：0 → 0.30
      { shape: 'cylinder', position: [0, 0.15, 0], size: [1.4, 0.3, 1.4], color: 0x9aa7b0 },
      // 喷口：0.30 → 0.80
      { shape: 'cylinder', position: [0, 0.55, 0], size: [0.3, 0.5, 0.3], color: 0x3a3f44 },
      // 核心球：0.90 → 1.40
      { shape: 'sphere', position: [0, 1.15, 0], size: [0.5, 0.5, 0.5], color: 0x22d3ee },
      // 三颗飘起来的粒子
      { shape: 'sphere', position: [-0.5, 1.7, 0.2], size: [0.18, 0.18, 0.18], color: 0xf472b6 },
      { shape: 'sphere', position: [0.45, 1.9, -0.2], size: [0.18, 0.18, 0.18], color: 0xfacc15 },
      { shape: 'sphere', position: [0.1, 2.15, 0.3], size: [0.18, 0.18, 0.18], color: 0x8b5cf6 },
    ],
  },
];
