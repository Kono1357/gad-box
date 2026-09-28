import type { BuildingDef } from '../../building/types';

/**
 * 电器类建筑模型（22 个，M4 新增）。
 *
 * 字段口径与 `furniture.ts` 完全一致：
 * - 原点在底面中心，所有 part 的最低点必须正好落在 y = 0；
 * - `size` = parts 的实际包围盒（`position[i] ± size[i] / 2`）；
 * - `mass` = 外包围盒体积 × 材料密度，密度取真实量级：
 *   木材 650 / 板材 700 / 钢 7800 / 铝 2700 / 塑料 950 / 玻璃 2500 / 陶瓷 2300 / 织物 300。
 *   家电外壳多为塑料件，统一按塑料 950 折算，灯罩按织物 300，屏幕按玻璃 2500；
 * - `stackable`：冰箱 / 洗衣机 / 烤箱 / 音箱这些有水平顶面的给 `true`（上面能放东西），
 *   灯具、台扇、壁挂电视、投影仪这类一压就倒或是挂装的给 `false`。
 *
 * 灯的 `color` 统一用暖黄 `0xffdca8`，并挂一个 `trigger` 物理组件：
 * 参数形状直接复用 `data/physicsComponents.ts` 的 `TriggerParams`
 * （`shape` / `size` / `offset` / `onEnter`），事件名用 `LogicEventType` 里的 `'toggle-light'`。
 */
export const APPLIANCE_ITEMS: BuildingDef[] = [
  // ============================================================
  // 照明（3）—— 暖黄光 + trigger 组件
  // ============================================================
  // 圆顶吊灯 0.5×2.5×0.5（吊杆吊在 2.5 米高处，原点仍在地面）
  {
    id: 'lamp_pendant_dome',
    name: '圆顶吊灯',
    category: '电器',
    subcategory: '照明',
    type: 'appliance',
    shape: 'cylinder',
    size: [0.5, 1.48, 0.5],
    // 质量：0.5×1.48×0.5 m³ × 织物灯罩 300 kg/m³
    mass: 0.5 * 1.48 * 0.5 * 300, // 密度 300
    friction: 0.5,
    restitution: 0.1,
    color: 0xffdca8,
    icon: '💡',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    physicsComponents: [
      {
        type: 'trigger',
        params: { shape: 'sphere', size: [0.9, 0.9, 0.9], offset: [0, 0.3, 0], onEnter: 'toggle-light' },
      },
    ],
    tags: ['灯', '吊灯', '照明', '暖光'],
    description: '圆顶吊灯，一米吊杆顶端一个吸顶座，另一端吊着圆台灯罩，罩下是一颗暖黄光灯泡。',
    parts: [
      { shape: 'cylinder', position: [0, 0.98, 0], size: [0.04, 1.0, 0.04], color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0, 1.45, 0], size: [0.12, 0.06, 0.12], color: 0x5a636b },
      { shape: 'cylinder', position: [0, 0.305, 0], size: [0.5, 0.35, 0.5], color: 0xe8ded0 },
      { shape: 'sphere', position: [0, 0.08, 0], size: [0.16, 0.16, 0.16], color: 0xffdca8 },
    ],
  },

  // 折叠台灯 0.45×0.465×0.26（一压就倒，stackable = false）
  {
    id: 'lamp_desk_fold',
    name: '折叠台灯',
    category: '电器',
    subcategory: '照明',
    type: 'appliance',
    shape: 'custom',
    size: [0.45, 0.465, 0.26],
    // 质量：0.45×0.465×0.26 m³ × 塑料 950 kg/m³
    mass: 0.45 * 0.465 * 0.26 * 950, // 密度 950
    friction: 0.5,
    restitution: 0.12,
    color: 0xffdca8,
    icon: '💡',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    physicsComponents: [
      {
        type: 'trigger',
        params: { shape: 'sphere', size: [0.6, 0.6, 0.6], offset: [0.2, 0.35, 0], onEnter: 'toggle-light' },
      },
    ],
    tags: ['灯', '台灯', '照明', '桌面'],
    description: '折叠台灯，圆底座加立杆，灯臂伸向一侧，锥形灯罩朝下扣在桌面书本上。',
    parts: [
      { shape: 'cylinder', position: [0, 0.015, 0], size: [0.2, 0.03, 0.2], color: 0x5a636b },
      { shape: 'cylinder', position: [0, 0.24, 0], size: [0.03, 0.42, 0.03], color: 0x9aa7b0 },
      { shape: 'box', position: [0.12, 0.45, 0], size: [0.24, 0.03, 0.03], color: 0x9aa7b0 },
      { shape: 'cone', position: [0.22, 0.35, 0], size: [0.26, 0.18, 0.26], color: 0xe8ded0 },
      { shape: 'sphere', position: [0.22, 0.27, 0], size: [0.1, 0.1, 0.1], color: 0xffdca8 },
    ],
  },

  // 双头壁灯 0.68×1.83×0.21（挂在 1.6 米高的墙面上，原点仍在地面）
  {
    id: 'lamp_wall_twin',
    name: '双头壁灯',
    category: '电器',
    subcategory: '照明',
    type: 'appliance',
    shape: 'custom',
    size: [0.68, 0.38, 0.21],
    // 质量：0.68×0.38×0.21 m³ × 塑料 950 kg/m³
    mass: 0.68 * 0.38 * 0.21 * 950, // 密度 950
    friction: 0.5,
    restitution: 0.1,
    color: 0xffdca8,
    icon: '🏮',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    physicsComponents: [
      {
        type: 'trigger',
        params: { shape: 'box', size: [0.8, 0.8, 0.8], offset: [0, 0.17, 0.08], onEnter: 'toggle-light' },
      },
    ],
    tags: ['灯', '壁灯', '照明', '走廊'],
    description: '双头壁灯，一块墙座上伸出一根横臂，两端各挂一个锥形灯罩，装到走廊墙上正好。',
    parts: [
      { shape: 'box', position: [0, 0.25, 0], size: [0.16, 0.26, 0.06], color: 0x5a636b },
      { shape: 'box', position: [0, 0.25, 0.055], size: [0.5, 0.05, 0.05], color: 0x9aa7b0 },
      { shape: 'cone', position: [-0.24, 0.17, 0.08], size: [0.2, 0.16, 0.2], color: 0xe8ded0 },
      { shape: 'cone', position: [0.24, 0.17, 0.08], size: [0.2, 0.16, 0.2], color: 0xe8ded0 },
      { shape: 'sphere', position: [-0.24, 0.05, 0.08], size: [0.1, 0.1, 0.1], color: 0xffdca8 },
    ],
  },

  // ============================================================
  // 大家电（7）—— 冰箱高 1.8、洗衣机 0.6×0.85×0.6、空调挂机 0.9×0.3×0.2
  // ============================================================
  // 双门冰箱 0.9×1.8×0.7
  {
    id: 'fridge_double_door',
    name: '双门冰箱',
    category: '电器',
    subcategory: '大家电',
    type: 'appliance',
    shape: 'cuboid',
    size: [0.9, 1.8, 0.7],
    // 质量：0.9×1.8×0.7 m³ × 塑料 950 kg/m³（外壳与内胆按塑料折算）
    mass: 0.9 * 1.8 * 0.7 * 950, // 密度 950
    friction: 0.55,
    restitution: 0.08,
    color: 0xd8dce0,
    icon: '🧊',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    lodLevels: 2,
    tags: ['冰箱', '大家电', '厨房', '冷藏'],
    description: '一米八高双门冰箱，上冷冻下冷藏，两扇门各贴一个竖条把手，顶上还能放东西。',
    parts: [
      { shape: 'box', position: [0, 0.9, 0], size: [0.9, 1.8, 0.64], color: 0xd8dce0 },
      { shape: 'box', position: [0, 1.45, 0.335], size: [0.86, 0.6, 0.03], color: 0xc2c8ce },
      { shape: 'box', position: [0, 0.62, 0.335], size: [0.86, 1.08, 0.03], color: 0xc2c8ce },
      { shape: 'box', position: [0.4, 1.45, 0.365], size: [0.05, 0.5, 0.03], color: 0x9aa7b0 },
      { shape: 'box', position: [0.4, 0.62, 0.365], size: [0.05, 0.5, 0.03], color: 0x9aa7b0 },
    ],
  },

  // 迷你冰箱 0.45×0.5×0.45（可以摞在桌上或柜子里）
  {
    id: 'fridge_mini_bar',
    name: '迷你冰箱',
    category: '电器',
    subcategory: '大家电',
    type: 'appliance',
    shape: 'cuboid',
    size: [0.45, 0.5, 0.44],
    // 质量：0.45×0.5×0.44 m³ × 塑料 950 kg/m³
    mass: 0.45 * 0.5 * 0.44 * 950, // 密度 950
    friction: 0.55,
    restitution: 0.1,
    color: 0xe4e7ea,
    icon: '🥤',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['冰箱', '迷你', '大家电', '饮料'],
    description: '迷你小冰箱，半米高，刚好塞得下几排饮料，放在办公桌旁边正合适。',
    parts: [
      { shape: 'box', position: [0, 0.25, 0], size: [0.45, 0.5, 0.4], color: 0xe4e7ea },
      { shape: 'box', position: [0, 0.25, 0.21], size: [0.41, 0.44, 0.02], color: 0xd0d5da },
      { shape: 'box', position: [0.16, 0.25, 0.23], size: [0.04, 0.2, 0.02], color: 0x9aa7b0 },
    ],
  },

  // 滚筒洗衣机 0.6×0.85×0.6
  {
    id: 'washer_drum',
    name: '滚筒洗衣机',
    category: '电器',
    subcategory: '大家电',
    type: 'appliance',
    shape: 'custom',
    size: [0.6, 0.85, 0.6],
    // 质量：0.6×0.85×0.6 m³ × 塑料 950 kg/m³
    mass: 0.6 * 0.85 * 0.6 * 950, // 密度 950
    friction: 0.55,
    restitution: 0.08,
    color: 0xe4e7ea,
    icon: '🧺',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['洗衣机', '大家电', '清洁', '滚筒'],
    description: '滚筒洗衣机，正面一块方形舱门玻璃，顶部是控制面板与洗涤剂抽屉，烘干机可以摞上去。',
    // 舱门拆成外框 + 玻璃两层薄 box，不用绕轴旋转，包围盒直接可算
    parts: [
      { shape: 'box', position: [0, 0.425, 0], size: [0.6, 0.85, 0.57], color: 0xe4e7ea },
      { shape: 'box', position: [0, 0.45, 0.3], size: [0.4, 0.4, 0.03], color: 0x4a5560 },
      { shape: 'box', position: [0, 0.45, 0.295], size: [0.3, 0.3, 0.02], color: 0xbfd8e0 },
      { shape: 'box', position: [0, 0.76, 0.295], size: [0.5, 0.1, 0.02], color: 0x3a4048 },
      { shape: 'box', position: [-0.18, 0.76, 0.295], size: [0.2, 0.08, 0.02], color: 0x9aa7b0 },
    ],
  },

  // 滚筒烘干机 0.6×0.85×0.6（和洗衣机同尺寸，可以叠放）
  {
    id: 'dryer_tumble',
    name: '滚筒烘干机',
    category: '电器',
    subcategory: '大家电',
    type: 'appliance',
    shape: 'custom',
    size: [0.6, 0.85, 0.6],
    // 质量：0.6×0.85×0.6 m³ × 塑料 950 kg/m³
    mass: 0.6 * 0.85 * 0.6 * 950, // 密度 950
    friction: 0.55,
    restitution: 0.08,
    color: 0xeceef0,
    icon: '🌀',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['烘干机', '大家电', '清洁', '滚筒'],
    description: '滚筒烘干机，尺寸和滚筒洗衣机一模一样，正面舱门做成方框样式，专为叠放设计。',
    parts: [
      { shape: 'box', position: [0, 0.425, 0], size: [0.6, 0.85, 0.57], color: 0xeceef0 },
      { shape: 'box', position: [0, 0.45, 0.3], size: [0.42, 0.42, 0.03], color: 0x4a5560 },
      { shape: 'box', position: [0, 0.76, 0.295], size: [0.5, 0.1, 0.02], color: 0x3a4048 },
    ],
  },

  // 嵌入式洗碗机 0.6×0.85×0.6
  {
    id: 'dishwasher_builtin',
    name: '嵌入式洗碗机',
    category: '电器',
    subcategory: '大家电',
    type: 'appliance',
    shape: 'custom',
    size: [0.6, 0.85, 0.6],
    // 质量：0.6×0.85×0.6 m³ × 塑料 950 kg/m³（内胆是钢但柜体是空腔，按外壳材料折算）
    mass: 0.6 * 0.85 * 0.6 * 950, // 密度 950
    friction: 0.55,
    restitution: 0.08,
    color: 0xcfd6da,
    icon: '🍽️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['洗碗机', '大家电', '厨房', '嵌入式'],
    description: '嵌入式洗碗机，六十厘米标准宽，面板上方一条长把手，装在橱柜里与台面齐平。',
    parts: [
      { shape: 'box', position: [0, 0.425, 0], size: [0.6, 0.85, 0.57], color: 0xcfd6da },
      { shape: 'box', position: [0, 0.42, 0.3], size: [0.54, 0.6, 0.03], color: 0xb8c1c7 },
      { shape: 'box', position: [0, 0.74, 0.295], size: [0.5, 0.04, 0.02], color: 0x9aa7b0 },
    ],
  },

  // 壁挂空调 0.9×0.3×0.2（室内挂机的本体尺寸）
  {
    id: 'ac_wall_split',
    name: '壁挂空调',
    category: '电器',
    subcategory: '大家电',
    type: 'appliance',
    shape: 'cuboid',
    size: [0.9, 0.3, 0.2],
    // 质量：0.9×0.3×0.2 m³ × 塑料 950 kg/m³
    mass: 0.9 * 0.3 * 0.2 * 950, // 密度 950
    friction: 0.5,
    restitution: 0.08,
    color: 0xf2f6f8,
    icon: '❄️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['空调', '挂机', '大家电', '制冷'],
    description: '空调挂机，九十厘米宽、三十厘米高、二十厘米厚，底部一圈出风口导风板。',
    parts: [
      { shape: 'box', position: [0, 0.15, 0], size: [0.9, 0.3, 0.18], color: 0xf2f6f8 },
      { shape: 'box', position: [0, 0.045, 0.1], size: [0.8, 0.06, 0.02], color: 0xd0d5da },
      { shape: 'box', position: [0.34, 0.24, 0.1], size: [0.12, 0.03, 0.02], color: 0x9aa7b0 },
    ],
  },

  // 立式空调 0.4×1.8×0.4
  {
    id: 'ac_floor_tower',
    name: '立式空调',
    category: '电器',
    subcategory: '大家电',
    type: 'appliance',
    shape: 'cuboid',
    size: [0.4, 1.8, 0.4],
    // 质量：0.4×1.8×0.4 m³ × 塑料 950 kg/m³
    mass: 0.4 * 1.8 * 0.4 * 950, // 密度 950
    friction: 0.52,
    restitution: 0.08,
    color: 0xf2f6f8,
    icon: '❄️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    lodLevels: 2,
    tags: ['空调', '柜机', '大家电', '制冷'],
    description: '立式空调柜机，一米八高，正面竖直格栅送风，摆客厅角落比挂机有气势。',
    parts: [
      { shape: 'box', position: [0, 0.03, 0], size: [0.38, 0.06, 0.38], color: 0xd0d5da },
      { shape: 'box', position: [0, 0.9, 0], size: [0.4, 1.8, 0.38], color: 0xf2f6f8 },
      { shape: 'box', position: [0, 1.35, 0.2], size: [0.3, 0.5, 0.02], color: 0xd0d5da },
      { shape: 'box', position: [0, 0.9, 0.2], size: [0.16, 0.2, 0.02], color: 0x3a4048 },
    ],
  },

  // ============================================================
  // 小家电（5）
  // ============================================================
  // 嵌入式烤箱 0.6×0.6×0.55
  {
    id: 'oven_builtin',
    name: '嵌入式烤箱',
    category: '电器',
    subcategory: '小家电',
    type: 'appliance',
    shape: 'custom',
    size: [0.6, 0.6, 0.55],
    // 质量：0.6×0.6×0.55 m³ × 塑料 950 kg/m³（外壳按塑料折算）
    mass: 0.6 * 0.6 * 0.55 * 950, // 密度 950
    friction: 0.5,
    restitution: 0.08,
    color: 0x3a4048,
    icon: '🔥',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['烤箱', '小家电', '厨房', '烘焙'],
    description: '嵌入式烤箱，正面下方是带玻璃窗的炉门、上方是控制面板，右侧一个圆形旋钮。',
    parts: [
      { shape: 'box', position: [0, 0.3, 0], size: [0.6, 0.6, 0.5], color: 0x3a4048 },
      { shape: 'box', position: [0, 0.24, 0.26], size: [0.54, 0.34, 0.02], color: 0x2c3136 },
      { shape: 'box', position: [0, 0.24, 0.28], size: [0.4, 0.2, 0.02], color: 0xbfd8e0 },
      { shape: 'box', position: [0, 0.48, 0.29], size: [0.5, 0.03, 0.02], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 0.52, 0.26], size: [0.54, 0.1, 0.02], color: 0x4a5560 },
      { shape: 'box', position: [0.18, 0.52, 0.29], size: [0.06, 0.06, 0.02], color: 0x9aa7b0 },
    ],
  },

  // 微波炉 0.5×0.3×0.4
  {
    id: 'microwave_oven',
    name: '微波炉',
    category: '电器',
    subcategory: '小家电',
    type: 'appliance',
    shape: 'custom',
    size: [0.5, 0.3, 0.4],
    // 质量：0.5×0.3×0.4 m³ × 塑料 950 kg/m³
    mass: 0.5 * 0.3 * 0.4 * 950, // 密度 950
    friction: 0.5,
    restitution: 0.1,
    color: 0xd8dce0,
    icon: '🍲',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['微波炉', '小家电', '厨房', '加热'],
    description: '微波炉，三十厘米高，左侧炉门带观察窗，右侧一条控制面板加一个旋钮，顶上能放碗。',
    parts: [
      { shape: 'box', position: [0, 0.15, 0], size: [0.5, 0.3, 0.36], color: 0xd8dce0 },
      { shape: 'box', position: [-0.08, 0.15, 0.19], size: [0.32, 0.24, 0.02], color: 0xb8c1c7 },
      { shape: 'box', position: [-0.08, 0.15, 0.21], size: [0.22, 0.16, 0.02], color: 0x3a4048 },
      { shape: 'box', position: [0.165, 0.15, 0.19], size: [0.14, 0.26, 0.02], color: 0x9aa7b0 },
      { shape: 'box', position: [0.165, 0.15, 0.21], size: [0.07, 0.07, 0.02], color: 0x4a5560 },
    ],
  },

  // 意式咖啡机 0.3×0.4×0.35
  {
    id: 'coffee_espresso',
    name: '意式咖啡机',
    category: '电器',
    subcategory: '小家电',
    type: 'appliance',
    shape: 'custom',
    size: [0.3, 0.4, 0.35],
    // 质量：0.3×0.4×0.35 m³ × 塑料 950 kg/m³（不锈钢外壳按塑料量级折算）
    mass: 0.3 * 0.4 * 0.35 * 950, // 密度 950
    friction: 0.5,
    restitution: 0.1,
    color: 0x9aa7b0,
    icon: '☕',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['咖啡机', '小家电', '厨房', '饮品'],
    description: '意式咖啡机，机身顶部是水箱盖，中间伸出冲煮头，前面的底座上摆着一只小杯。',
    parts: [
      { shape: 'box', position: [0, 0.015, 0.025], size: [0.3, 0.03, 0.35], color: 0x3a4048 },
      { shape: 'box', position: [0, 0.18, 0], size: [0.3, 0.36, 0.3], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 0.38, 0], size: [0.28, 0.04, 0.28], color: 0xcfd6da },
      { shape: 'cylinder', position: [0, 0.3, 0.15], size: [0.1, 0.08, 0.1], color: 0x4a5560 },
      { shape: 'box', position: [0, 0.05, 0.16], size: [0.08, 0.1, 0.08], color: 0xf2f6f8 },
    ],
  },

  // 电热水壶 0.22×0.23×0.22
  {
    id: 'kettle_electric',
    name: '电热水壶',
    category: '电器',
    subcategory: '小家电',
    type: 'appliance',
    shape: 'custom',
    size: [0.22, 0.23, 0.22],
    // 质量：0.22×0.23×0.22 m³ × 塑料 950 kg/m³
    mass: 0.22 * 0.23 * 0.22 * 950, // 密度 950
    friction: 0.48,
    restitution: 0.12,
    color: 0xeceef0,
    icon: '🫖',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['热水壶', '小家电', '厨房', '烧水'],
    description: '电热水壶，圆柱壶身坐在圆形电源底座上，侧面有手柄，壶嘴朝另一侧伸出。',
    parts: [
      { shape: 'cylinder', position: [0, 0.01, 0], size: [0.22, 0.02, 0.22], color: 0x3a4048 },
      { shape: 'cylinder', position: [0, 0.11, 0], size: [0.2, 0.2, 0.2], color: 0xeceef0 },
      { shape: 'cylinder', position: [0, 0.215, 0], size: [0.18, 0.03, 0.18], color: 0x9aa7b0 },
      { shape: 'box', position: [0.09, 0.13, 0], size: [0.04, 0.16, 0.04], color: 0x3a4048 },
      { shape: 'cone', position: [-0.08, 0.17, 0.06], size: [0.06, 0.08, 0.06], color: 0xeceef0 },
    ],
  },

  // 落地风扇 0.5×1.45×0.57（一压就倒，stackable = false）
  {
    id: 'fan_pedestal',
    name: '落地风扇',
    category: '电器',
    subcategory: '小家电',
    type: 'appliance',
    shape: 'custom',
    size: [0.5, 1.45, 0.57],
    // 质量：0.5×1.45×0.57 m³ × 塑料 950 kg/m³
    mass: 0.5 * 1.45 * 0.57 * 950, // 密度 950
    friction: 0.5,
    restitution: 0.12,
    color: 0xbfc8cf,
    icon: '🌀',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    physicsComponents: [
      { type: 'motor', params: { speed: 12, maxForce: 30, enabled: false } },
    ],
    tags: ['风扇', '小家电', '通风', '降温'],
    description: '落地风扇，圆底座加立柱，顶部一片方形网罩，罩后一颗方形电机，开起来会摇头。',
    // 网罩与电机都是 box，整个模型不带任何绕轴旋转，包围盒按 axis-aligned 直接累加
    parts: [
      { shape: 'cylinder', position: [0, 0.03, 0], size: [0.5, 0.06, 0.5], color: 0x5a636b },
      { shape: 'cylinder', position: [0, 0.585, 0], size: [0.05, 1.05, 0.05], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 1.2, 0], size: [0.5, 0.5, 0.16], color: 0xbfc8cf },
      { shape: 'box', position: [0, 1.2, -0.22], size: [0.16, 0.16, 0.2], color: 0x4a5560 },
    ],
  },

  // ============================================================
  // 影音（4）
  // ============================================================
  // 壁挂薄款电视 1.2×0.7×0.05
  {
    id: 'tv_wall_mount',
    name: '壁挂薄款电视',
    category: '电器',
    subcategory: '影音',
    type: 'appliance',
    shape: 'cuboid',
    size: [1.2, 0.7, 0.05],
    // 质量：1.2×0.7×0.05 m³ × 玻璃 2500 kg/m³（屏幕按玻璃折算）
    mass: 1.2 * 0.7 * 0.05 * 2500, // 密度 2500
    friction: 0.4,
    restitution: 0.1,
    color: 0x1f4a5c,
    icon: '📺',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['电视', '壁挂', '薄款', '影音'],
    description: '壁挂薄款电视，整机只有五厘米厚，背板贴墙、前面一块发光屏幕，挂在客厅正墙。',
    parts: [
      { shape: 'box', position: [0, 0.35, -0.015], size: [1.2, 0.7, 0.02], color: 0x2b3036 },
      { shape: 'box', position: [0, 0.35, 0.005], size: [1.12, 0.62, 0.02], color: 0x1f4a5c },
      { shape: 'box', position: [0, 0.35, 0.02], size: [1.16, 0.66, 0.01], color: 0x2f6a80 },
    ],
  },

  // 电视柜款电视 1.3×0.85×0.3（带底座，可直接放在电视柜上）
  {
    id: 'tv_console_model',
    name: '电视柜款电视',
    category: '电器',
    subcategory: '影音',
    type: 'appliance',
    shape: 'custom',
    size: [1.3, 0.85, 0.3],
    // 质量：1.3×0.85×0.3 m³ × 塑料 950 kg/m³
    mass: 1.3 * 0.85 * 0.3 * 950, // 密度 950
    friction: 0.55,
    restitution: 0.08,
    color: 0x1f4a5c,
    icon: '📺',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['电视', '底座款', '影音', '客厅'],
    description: '电视柜款电视，自带一块三十厘米深的底座和支杆，可以直接摆在电视柜台面上。',
    parts: [
      { shape: 'box', position: [0, 0.025, 0], size: [0.6, 0.05, 0.3], color: 0x3a4048 },
      { shape: 'box', position: [0, 0.15, 0], size: [0.12, 0.2, 0.12], color: 0x3a4048 },
      { shape: 'box', position: [0, 0.55, 0], size: [1.3, 0.6, 0.06], color: 0x2b3036 },
      { shape: 'box', position: [0, 0.55, 0.04], size: [1.22, 0.52, 0.02], color: 0x2f6a80 },
    ],
  },

  // 吊装投影仪 0.32×1.8×0.3（镜头是朝前的 cylinder）
  {
    id: 'projector_ceiling',
    name: '吊装投影仪',
    category: '电器',
    subcategory: '影音',
    type: 'appliance',
    shape: 'custom',
    size: [0.32, 0.42, 0.33],
    // 质量：0.32×0.42×0.33 m³ × 塑料 950 kg/m³
    mass: 0.32 * 0.42 * 0.33 * 950, // 密度 950
    friction: 0.45,
    restitution: 0.1,
    color: 0xd8dce0,
    icon: '📽️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: false,
    tags: ['投影仪', '影音', '吊装', '镜头'],
    description: '吊装投影仪，一根短吊杆吊住机身，机身前面伸出一个圆柱镜头，侧面是散热格栅。',
    // 镜头是一个竖直短圆柱（M4 要求投影仪必须有一只 cylinder 镜头）
    parts: [
      { shape: 'cylinder', position: [0, 0.27, 0], size: [0.05, 0.3, 0.05], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 0.06, 0], size: [0.32, 0.12, 0.26], color: 0xd8dce0 },
      { shape: 'cylinder', position: [0, 0.06, 0.14], size: [0.12, 0.08, 0.12], color: 0x3a4048 },
      { shape: 'box', position: [-0.11, 0.06, 0.13], size: [0.1, 0.06, 0.02], color: 0x5a636b },
    ],
  },

  // 落地音响 0.3×1.0×0.3
  {
    id: 'speaker_floor',
    name: '落地音响',
    category: '电器',
    subcategory: '影音',
    type: 'appliance',
    shape: 'custom',
    size: [0.3, 1.0, 0.3],
    // 质量：0.3×1.0×0.3 m³ × 板材 700 kg/m³（箱体是密度板）
    mass: 0.3 * 1.0 * 0.3 * 700, // 密度 700
    friction: 0.6,
    restitution: 0.12,
    color: 0x3a4048,
    icon: '🔊',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['音响', '影音', '音箱', '客厅'],
    description: '落地音响，一米高的音箱箱体，正面上下嵌两个发声单元，底下一块略宽的稳定底板。',
    // 两个喇叭单元用薄 box 表达，避免任何旋转
    parts: [
      { shape: 'box', position: [0, 0.015, 0], size: [0.3, 0.03, 0.3], color: 0x2c3136 },
      { shape: 'box', position: [0, 0.5, 0], size: [0.3, 0.94, 0.28], color: 0x3a4048 },
      { shape: 'box', position: [0, 0.65, 0.135], size: [0.2, 0.2, 0.03], color: 0x5a636b },
      { shape: 'box', position: [0, 0.28, 0.135], size: [0.1, 0.1, 0.03], color: 0x5a636b },
      { shape: 'box', position: [0, 0.97, 0], size: [0.3, 0.06, 0.28], color: 0x4a5560 },
    ],
  },

  // ============================================================
  // 电脑（3）
  // ============================================================
  // 台式电脑主机 0.2×0.45×0.45
  {
    id: 'pc_desktop',
    name: '台式电脑主机',
    category: '电器',
    subcategory: '电脑',
    type: 'appliance',
    shape: 'cuboid',
    size: [0.2, 0.45, 0.45],
    // 质量：0.2×0.45×0.45 m³ × 塑料 950 kg/m³（外壳按塑料折算）
    mass: 0.2 * 0.45 * 0.45 * 950, // 密度 950
    friction: 0.55,
    restitution: 0.1,
    color: 0x2c3136,
    icon: '🖥️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['电脑', '主机', '办公', '机箱'],
    description: '台式电脑主机，立式机箱只有二十厘米宽，前面板下半是散热格栅，右上角一个电源键。',
    // 电源键是一颗小圆柱，竖直贴在机箱前面板上
    parts: [
      { shape: 'box', position: [0, 0.225, 0], size: [0.2, 0.45, 0.42], color: 0x2c3136 },
      { shape: 'box', position: [0, 0.225, 0.22], size: [0.2, 0.43, 0.02], color: 0x3a4048 },
      { shape: 'box', position: [0, 0.16, 0.23], size: [0.16, 0.2, 0.01], color: 0x5a636b },
      { shape: 'cylinder', position: [0.06, 0.4, 0.225], size: [0.03, 0.03, 0.03], color: 0x9aa7b0 },
    ],
  },

  // 笔记本电脑 0.35×0.24×0.24（打开状态）
  {
    id: 'laptop_open',
    name: '笔记本电脑',
    category: '电器',
    subcategory: '电脑',
    type: 'appliance',
    shape: 'custom',
    size: [0.35, 0.24, 0.24],
    // 质量：0.35×0.24×0.24 m³ × 塑料 950 kg/m³
    mass: 0.35 * 0.24 * 0.24 * 950, // 密度 950
    friction: 0.55,
    restitution: 0.12,
    color: 0x9aa7b0,
    icon: '💻',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['电脑', '笔记本', '办公', '便携'],
    description: '笔记本电脑，底座平放、屏幕立起九十度，触控板在键盘前面，合上就能叠东西。',
    parts: [
      { shape: 'box', position: [0, 0.01, 0.02], size: [0.35, 0.02, 0.24], color: 0x9aa7b0 },
      { shape: 'box', position: [0, 0.023, 0.09], size: [0.08, 0.005, 0.05], color: 0xb8c1c7 },
      { shape: 'box', position: [0, 0.125, -0.0925], size: [0.35, 0.23, 0.015], color: 0x2c3136 },
    ],
  },

  // 激光打印机 0.4×0.3×0.41
  {
    id: 'printer_laser',
    name: '激光打印机',
    category: '电器',
    subcategory: '电脑',
    type: 'appliance',
    shape: 'cuboid',
    size: [0.4, 0.3, 0.41],
    // 质量：0.4×0.3×0.41 m³ × 塑料 950 kg/m³
    mass: 0.4 * 0.3 * 0.41 * 950, // 密度 950
    friction: 0.55,
    restitution: 0.08,
    color: 0xd8dce0,
    icon: '🖨️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    stackable: true,
    tags: ['打印机', '办公', '电脑', '纸张'],
    description: '桌面激光打印机，方正的机身上面一块顶盖，正面一个出纸口，右上角一排按键。',
    parts: [
      { shape: 'box', position: [0, 0.14, 0], size: [0.4, 0.28, 0.4], color: 0xd8dce0 },
      { shape: 'box', position: [0, 0.29, 0], size: [0.36, 0.02, 0.36], color: 0xc2c8ce },
      { shape: 'box', position: [0, 0.2, 0.2], size: [0.3, 0.05, 0.02], color: 0x5a636b },
      { shape: 'box', position: [-0.13, 0.285, 0.19], size: [0.06, 0.02, 0.02], color: 0x3a4048 },
    ],
  },
];
