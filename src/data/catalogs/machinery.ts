import type { BuildingDef } from '../../building/types';

/**
 * M4 机械类模型（20 个）。
 *
 * 约定与 `data/buildings/props.ts` 一致：**原点在底面中心**，parts 从 y = 0 往上堆，
 * `size` 是全部 part 的包围盒（含旋转后的实际占位）。
 *
 * mass 一律写成"包围盒体积 × 等效密度"的形式：
 * 机械件大多是壳体中空件，实心部分只占包围盒的一小块，
 * 所以等效密度取 15~7800 kg/m³ 不等（每条的注释里写了取哪个值、算出来多少公斤）。
 *
 * 物理组件只加**类型确实对得上**的：电机驱动件挂 `motor`（MotorParams: speed/maxForce/enabled），
 * 弹簧挂 `spring`（SpringParams: stiffness/damping/restLength），
 * 传送带挂 `rigidbody`（RigidbodyParams: mode/density/lockRotation），
 * 传感器挂 `trigger` + `collider`。其余一律不加。
 */
export const MACHINERY_ITEMS: BuildingDef[] = [
  // ============================================================
  // 传动（7）
  // ============================================================
  // 齿轮组 1.5×0.24×1.5
  {
    id: 'gear_pair',
    name: '齿轮组',
    category: '机械',
    subcategory: '传动',
    type: 'machinery',
    shape: 'cylinder',
    size: [1.5, 0.24, 1.5],
    // 体积 0.54 m³ × 钢密度 7800 kg/m³ ≈ 4212 kg（1.5 m 铸钢齿轮，真实同级 2~4 t）
    mass: 1.5 * 0.24 * 1.5 * 7800,
    friction: 0.5,
    restitution: 0.2,
    color: 0x9aa7b0,
    icon: '⚙️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['传动', '齿轮', '金属', '标准件'],
    /**
     * 为什么只有 5 个 part：`parts` 上限是 8 个，画不下 8 个独立齿。
     * 所以用「1 个轮盘 + 2 组十字齿条（每条齿条同时表示正对的 2 个齿）」表达，
     * 4 条齿条按 0°/45°/90°/135° 交叉，正好摆出 8 个齿位。
     */
    description: '1.5 米直径的齿轮组：轮盘加 4 条交叉齿条，摆出 8 个齿位。挂上电机组件后可以当传动源。',
    parts: [
      // 轮盘：0 → 0.24
      { shape: 'cylinder', position: [0, 0.12, 0], size: [1.2, 0.24, 1.2], color: 0x9aa7b0 },
      // 2 组十字齿条：每条同时表示正对的两个齿
      { shape: 'box', position: [0, 0.12, 0], size: [1.5, 0.22, 0.18], color: 0xcfd6da },
      { shape: 'box', position: [0, 0.12, 0], size: [1.5, 0.22, 0.18], rotationY: Math.PI / 4, color: 0xcfd6da },
      { shape: 'box', position: [0, 0.12, 0], size: [1.5, 0.22, 0.18], rotationY: Math.PI / 2, color: 0xcfd6da },
      { shape: 'box', position: [0, 0.12, 0], size: [1.5, 0.22, 0.18], rotationY: (Math.PI * 3) / 4, color: 0xcfd6da },
    ],
    physicsComponents: [{ type: 'motor', params: { speed: 2.0, maxForce: 500, enabled: false } }],
  },
  // 齿条 1.6×0.66×0.2 —— 齿条 + 小齿轮
  {
    id: 'gear_rack',
    name: '齿条',
    category: '机械',
    subcategory: '传动',
    type: 'machinery',
    shape: 'custom',
    size: [1.6, 0.52, 0.44],
    // 体积 0.366 m³ × 等效密度 230 kg/m³ ≈ 84 kg（钢料只占包围盒里的一条）
    mass: 1.6 * 0.52 * 0.44 * 230,
    friction: 0.5,
    restitution: 0.15,
    color: 0x9aa7b0,
    icon: '🔩',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['传动', '齿条', '直线运动', '金属'],
    description: '齿条配小齿轮，把旋转变成直线移动。齿条长 1.6 米，小齿轮直径 0.44 米架在齿上。',
    parts: [
      // 齿条本体：0 → 0.14
      { shape: 'box', position: [0, 0.07, 0], size: [1.6, 0.14, 0.2], color: 0x9aa7b0 },
      // 三个齿：叠在齿条上表面
      { shape: 'box', position: [-0.6, 0.17, 0], size: [0.1, 0.1, 0.2], color: 0xcfd6da },
      { shape: 'box', position: [0, 0.17, 0], size: [0.1, 0.1, 0.2], color: 0xcfd6da },
      { shape: 'box', position: [0.6, 0.17, 0], size: [0.1, 0.1, 0.2], color: 0xcfd6da },
      // 小齿轮：轴沿 Y，齿顶正好搭在齿上
      { shape: 'cylinder', position: [0.4, 0.44, 0], size: [0.44, 0.16, 0.44], color: 0xd4a437 },
    ],
  },
  // 杠杆 3.2×1.3×0.4
  {
    id: 'lever_arm',
    name: '杠杆',
    category: '机械',
    subcategory: '传动',
    type: 'machinery',
    shape: 'custom',
    size: [3.2, 1.3, 0.4],
    // 体积 1.664 m³ × 等效密度 150 kg/m³ ≈ 250 kg（木杆 + 石底座 + 铁配重）
    mass: 3.2 * 1.3 * 0.4 * 150,
    friction: 0.6,
    restitution: 0.1,
    color: 0x8b5a2b,
    icon: '🪝',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'wood',
    tags: ['简单机械', '杠杆', '配重', '省力'],
    description: '3.2 米长杆架在支柱上，短端压着 0.4 米的配重块。放一块重物在长端就能撬起来。',
    parts: [
      // 底座：0 → 0.10
      { shape: 'box', position: [0, 0.05, 0], size: [0.4, 0.1, 0.4], color: 0x9aa7b0 },
      // 支点柱：0.10 → 0.80
      { shape: 'box', position: [0, 0.45, 0], size: [0.16, 0.7, 0.16], color: 0x8b5a2b },
      // 长杆：0.80 → 0.90
      { shape: 'box', position: [0, 0.85, 0], size: [3.2, 0.1, 0.16], color: 0x8b5a2b },
      // 配重块：0.90 → 1.30
      { shape: 'box', position: [-1.3, 1.1, 0], size: [0.4, 0.4, 0.4], color: 0x3a3f44 },
    ],
  },
  // 活塞缸 0.6×1.78×0.6
  {
    id: 'piston_cylinder',
    name: '活塞缸',
    category: '机械',
    subcategory: '传动',
    type: 'machinery',
    shape: 'custom',
    size: [0.6, 1.78, 0.6],
    // 体积 0.6408 m³ × 等效密度 220 kg/m³ ≈ 141 kg（液压缸筒 + 活塞杆）
    mass: 0.6 * 1.78 * 0.6 * 220,
    friction: 0.35,
    restitution: 0.2,
    color: 0x9aa7b0,
    icon: '🔧',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['传动', '液压', '往复', '金属'],
    description: '液压缸：0.9 米高的缸体里伸出活塞杆，杆顶托着 0.44 米顶盘。推杆最高能到 1.78 米。',
    parts: [
      { shape: 'box', position: [0, 0.06, 0], size: [0.6, 0.12, 0.6], color: 0x3a3f44 },
      // 缸体：0.12 → 1.02
      { shape: 'cylinder', position: [0, 0.57, 0], size: [0.5, 0.9, 0.5], color: 0x9aa7b0 },
      // 活塞杆：0.90 → 1.70
      { shape: 'cylinder', position: [0, 1.3, 0], size: [0.16, 0.8, 0.16], color: 0xcfd6da },
      // 顶盘：1.70 → 1.78
      { shape: 'cylinder', position: [0, 1.74, 0], size: [0.44, 0.08, 0.44], color: 0xcfd6da },
    ],
  },
  // 螺旋弹簧 0.5×0.86×0.5
  {
    id: 'spring_coil',
    name: '螺旋弹簧',
    category: '机械',
    subcategory: '传动',
    type: 'machinery',
    shape: 'custom',
    size: [0.5, 0.86, 0.5],
    // 体积 0.215 m³ × 等效密度 200 kg/m³ ≈ 43 kg（弹簧钢但中空）
    mass: 0.5 * 0.86 * 0.5 * 200,
    friction: 0.5,
    restitution: 0.5,
    color: 0x9aa7b0,
    icon: '🌀',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['零件', '弹簧', '弹性', '减震'],
    description: '弹簧，上下两块盖板夹着 4 片交错钢板，静态长度 0.86 米。带弹簧组件，恢复长度 0.6 米。',
    parts: [
      // 底盖：0 → 0.06
      { shape: 'cylinder', position: [0, 0.03, 0], size: [0.5, 0.06, 0.5], color: 0x9aa7b0 },
      // 四片交错钢板
      { shape: 'box', position: [0, 0.16, 0.17], size: [0.5, 0.08, 0.16], color: 0xcfd6da },
      { shape: 'box', position: [0, 0.34, -0.17], size: [0.5, 0.08, 0.16], color: 0xcfd6da },
      { shape: 'box', position: [0, 0.52, 0.17], size: [0.5, 0.08, 0.16], color: 0xcfd6da },
      { shape: 'box', position: [0, 0.7, -0.17], size: [0.5, 0.08, 0.16], color: 0xcfd6da },
      // 顶盖：0.80 → 0.86
      { shape: 'cylinder', position: [0, 0.83, 0], size: [0.5, 0.06, 0.5], color: 0x9aa7b0 },
    ],
    physicsComponents: [{ type: 'spring', params: { stiffness: 900, damping: 0.6, restLength: 0.6 } }],
  },
  // 承重轮 0.6×1.0×1.0 —— 轮轴沿 X（rotationZ 放倒）
  {
    id: 'wheel_heavy',
    name: '承重轮',
    category: '机械',
    subcategory: '传动',
    type: 'machinery',
    shape: 'cylinder',
    size: [0.6, 1.0, 1.0],
    // 体积 0.6 m³ × 等效密度 200 kg/m³ ≈ 120 kg（1 米直径的实心胶轮 + 轮毂）
    mass: 0.6 * 1.0 * 1.0 * 200,
    friction: 0.9,
    restitution: 0.4,
    color: 0x2c3e50,
    icon: '🛞',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    tags: ['零件', '滚轮', '橡胶', '承重'],
    description: '1 米直径的承重胶轮，轴沿 X 横躺在地面上，轮底正好贴地。可以塞进车架当主动轮。',
    parts: [
      // 轮胎：直径 1.0，厚度 0.4
      { shape: 'cylinder', position: [0, 0.5, 0], size: [1.0, 0.4, 1.0], rotationZ: Math.PI / 2, color: 0x2c3e50 },
      // 轮辋
      { shape: 'cylinder', position: [0, 0.5, 0], size: [0.56, 0.42, 0.56], rotationZ: Math.PI / 2, color: 0x9aa7b0 },
      // 轮轴
      { shape: 'cylinder', position: [0, 0.5, 0], size: [0.14, 0.6, 0.14], rotationZ: Math.PI / 2, color: 0xcfd6da },
    ],
  },
  // 传送带 4.0×0.75×0.6 —— 长 4 米、带宽 0.6、带面厚 0.1
  {
    id: 'conveyor_belt',
    name: '传送带',
    category: '机械',
    subcategory: '传动',
    type: 'machinery',
    shape: 'custom',
    size: [0.6, 0.75, 4.0],
    // 体积 1.8 m³ × 等效密度 200 kg/m³ ≈ 360 kg（4 米皮带机架 + 两个滚筒 + 支腿）
    mass: 0.6 * 0.75 * 4.0 * 200,
    friction: 0.9,
    restitution: 0.05,
    color: 0x3a3f44,
    icon: '📦',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['物流', '传送带', '皮带', '滚筒'],
    description: '4 米长的传送带（长轴沿 Z，和车轮的朝向约定一致），带宽 0.6 米、带面厚 0.1 米，两端各一个滚筒（圆柱用 rotationZ 放倒，轴正好横跨带宽）。带面高 0.75 米。',
    parts: [
      // 带面：长 4 m 沿 Z，宽 0.6 m 沿 X，0.65 → 0.75
      { shape: 'box', position: [0, 0.7, 0], size: [0.6, 0.1, 4.0], color: 0x3a3f44 },
      // 两端滚筒：轴沿 X（0.6 米的长度正好等于带宽）
      { shape: 'cylinder', position: [0, 0.55, -1.8], size: [0.36, 0.6, 0.36], rotationZ: Math.PI / 2, color: 0x9aa7b0 },
      { shape: 'cylinder', position: [0, 0.55, 1.8], size: [0.36, 0.6, 0.36], rotationZ: Math.PI / 2, color: 0x9aa7b0 },
      // 四条支腿：0 → 0.65
      { shape: 'box', position: [0.25, 0.325, -1.6], size: [0.1, 0.65, 0.1], color: 0x9aa7b0 },
      { shape: 'box', position: [0.25, 0.325, 1.6], size: [0.1, 0.65, 0.1], color: 0x9aa7b0 },
      { shape: 'box', position: [-0.25, 0.325, -1.6], size: [0.1, 0.65, 0.1], color: 0x9aa7b0 },
      { shape: 'box', position: [-0.25, 0.325, 1.6], size: [0.1, 0.65, 0.1], color: 0x9aa7b0 },
    ],
    physicsComponents: [{ type: 'rigidbody', params: { mode: 'static', density: 200, lockRotation: true } }],
  },

  // ============================================================
  // 动力（3）
  // ============================================================
  // 风力发电机 14.11×29.0×3.8 —— 塔筒 20 m + 16 m 叶轮
  {
    id: 'wind_turbine',
    name: '风力发电机',
    category: '机械',
    subcategory: '动力',
    type: 'machinery',
    shape: 'custom',
    // 叶片扫掠区是空气，包围盒大得夸张：X 14.11 = 叶片在 X 上的最大外伸
    size: [14.11, 29.0, 3.8],
    // 体积 1555 m³ × 等效密度 15 kg/m³ ≈ 23300 kg（真实 20 m 塔筒级机组 20~40 t）
    mass: 14.11 * 29.0 * 3.8 * 15,
    friction: 0.6,
    restitution: 0.05,
    color: 0xf2f6f8,
    icon: '🌬️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['发电', '风机', '叶片', '塔筒'],
    description: '风力发电机：2.4 米混凝土基础 + 20 米塔筒 + 机舱，轮毂上挂 3 片 8 米长的叶片，用 rotationZ 摆成 120° 均匀分布。塔顶总高 29 米。',
    parts: [
      // 基础：0 → 0.5
      { shape: 'box', position: [0, 0.25, 0], size: [2.4, 0.5, 2.4], color: 0x9aa7b0 },
      // 塔筒：0.5 → 20.5
      { shape: 'cylinder', position: [0, 10.5, 0], size: [1.2, 20.0, 1.2], color: 0xf2f6f8 },
      // 机舱：20.3 → 21.7
      { shape: 'box', position: [0, 21.0, -0.4], size: [1.6, 1.4, 3.0], color: 0xf2f6f8 },
      // 轮毂：轴沿 X，凸在机舱前面
      { shape: 'cylinder', position: [0, 21.0, 1.5], size: [0.8, 0.6, 0.8], rotationZ: Math.PI / 2, color: 0xcfd6da },
      // 3 片叶片：长 8 米，中心在轮毂外 4 米处，rotationZ 相隔 120°
      { shape: 'box', position: [0, 25.0, 1.5], size: [0.5, 8.0, 0.25], color: 0xf2f6f8 },
      { shape: 'box', position: [-3.4641, 19.0, 1.5], size: [0.5, 8.0, 0.25], rotationZ: 2.0944, color: 0xf2f6f8 },
      { shape: 'box', position: [3.4641, 19.0, 1.5], size: [0.5, 8.0, 0.25], rotationZ: -2.0944, color: 0xf2f6f8 },
    ],
    physicsComponents: [{ type: 'motor', params: { speed: 0.6, maxForce: 4000, enabled: true } }],
  },
  // 太阳能板 2.4×1.43×1.47 —— 2.4×1.6 m 板面倾斜 0.45 rad
  {
    id: 'solar_panel',
    name: '太阳能板',
    category: '机械',
    subcategory: '动力',
    type: 'machinery',
    shape: 'custom',
    size: [2.4, 1.43, 1.47],
    // 体积 5.045 m³ × 等效密度 20 kg/m³ ≈ 101 kg（板下全是空气，真实板 + 支架 80~120 kg）
    mass: 2.4 * 1.43 * 1.47 * 20,
    friction: 0.5,
    restitution: 0.1,
    color: 0x2c3e50,
    icon: '🔆',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'glass',
    tags: ['发电', '光伏', '太阳能', '支架'],
    description: '太阳能板：两根前支腿矮、两根后支腿高，把 2.4×1.6 米的板面垫出 0.45 弧度倾角，面向天空。',
    parts: [
      // 底梁：0 → 0.12
      { shape: 'box', position: [0, 0.06, 0.3], size: [2.4, 0.12, 0.12], color: 0x9aa7b0 },
      // 前支腿（矮）：0 → 0.70
      { shape: 'box', position: [-1.0, 0.35, 0.55], size: [0.12, 0.7, 0.12], color: 0x9aa7b0 },
      { shape: 'box', position: [1.0, 0.35, 0.55], size: [0.12, 0.7, 0.12], color: 0x9aa7b0 },
      // 后支腿（高）：0 → 1.20
      { shape: 'box', position: [-1.0, 0.6, -0.45], size: [0.12, 1.2, 0.12], color: 0x9aa7b0 },
      { shape: 'box', position: [1.0, 0.6, -0.45], size: [0.12, 1.2, 0.12], color: 0x9aa7b0 },
      // 板面：倾斜 0.45 rad，0.675 → 1.425
      { shape: 'box', position: [0, 1.05, 0], size: [2.4, 0.06, 1.6], rotationX: -0.45, color: 0x2c3e50 },
    ],
  },
  // 水轮机 1.6×3.14×1.6
  {
    id: 'water_turbine',
    name: '水轮机',
    category: '机械',
    subcategory: '动力',
    type: 'machinery',
    shape: 'cylinder',
    size: [1.6, 3.14, 1.6],
    // 体积 8.038 m³ × 等效密度 60 kg/m³ ≈ 482 kg（铸铁蜗壳 + 主轴 + 皮带轮）
    mass: 1.6 * 3.14 * 1.6 * 60,
    friction: 0.5,
    restitution: 0.1,
    color: 0x9aa7b0,
    icon: '💧',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['发电', '水轮机', '水力', '主轴'],
    description: '立式水轮机：1.6 米底座上坐着 1.2 米蜗壳，壳里三片导叶绕轴排布，主轴顶端带一个皮带轮往外输出。',
    parts: [
      // 底座：0 → 0.40
      { shape: 'cylinder', position: [0, 0.2, 0], size: [1.6, 0.4, 1.6], color: 0x9aa7b0 },
      // 蜗壳：0.40 → 1.50
      { shape: 'cylinder', position: [0, 0.95, 0], size: [1.2, 1.1, 1.2], color: 0xcfd6da },
      // 三片导叶：绕轴 120° 均布，半径 0.6，全部落在底座范围内
      { shape: 'box', position: [0.6, 0.95, 0], size: [0.4, 1.0, 0.16], color: 0xd4a437 },
      { shape: 'box', position: [-0.3, 0.95, 0.5196], size: [0.4, 1.0, 0.16], rotationY: -2.0944, color: 0xd4a437 },
      { shape: 'box', position: [-0.3, 0.95, -0.5196], size: [0.4, 1.0, 0.16], rotationY: 2.0944, color: 0xd4a437 },
      // 主轴：1.50 → 2.90
      { shape: 'cylinder', position: [0, 2.2, 0], size: [0.24, 1.4, 0.24], color: 0x9aa7b0 },
      // 皮带轮：2.90 → 3.14
      { shape: 'cylinder', position: [0, 3.02, 0], size: [0.9, 0.24, 0.9], color: 0x3a3f44 },
    ],
    physicsComponents: [{ type: 'motor', params: { speed: 3.0, maxForce: 1200, enabled: false } }],
  },

  // ============================================================
  // 流体（4）
  // ============================================================
  // 水泵 1.6×1.1×1.1
  {
    id: 'water_pump',
    name: '水泵',
    category: '机械',
    subcategory: '流体',
    type: 'machinery',
    shape: 'custom',
    size: [1.6, 1.1, 1.1],
    // 体积 1.936 m³ × 等效密度 60 kg/m³ ≈ 116 kg（小型离心泵 + 电机）
    mass: 1.6 * 1.1 * 1.1 * 60,
    friction: 0.6,
    restitution: 0.05,
    color: 0x2c6fb0,
    icon: '🚰',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['流体', '水泵', '离心泵', '管路'],
    description: '卧式离心泵：1.6 米底架上左边泵体、右边电机，顶部出水口朝上、侧面吸水口朝 -Z。带电机组件可驱动。',
    parts: [
      // 底架：0 → 0.20
      { shape: 'box', position: [0, 0.1, 0], size: [1.6, 0.2, 1.1], color: 0x9aa7b0 },
      // 泵体：0.20 → 0.70
      { shape: 'cylinder', position: [0, 0.45, 0.1], size: [0.6, 0.5, 0.6], color: 0x2c6fb0 },
      // 电机：轴沿 X，和泵体同轴
      { shape: 'cylinder', position: [0.4, 0.45, -0.15], size: [0.44, 0.8, 0.44], rotationZ: Math.PI / 2, color: 0x3a3f44 },
      // 出水口：0.70 → 1.10
      { shape: 'cylinder', position: [0, 0.9, 0.1], size: [0.2, 0.4, 0.2], color: 0x9aa7b0 },
      // 吸水口：轴沿 Z，伸到底架外侧
      { shape: 'cylinder', position: [0, 0.45, -0.35], size: [0.2, 0.4, 0.2], rotationX: Math.PI / 2, color: 0x9aa7b0 },
    ],
    physicsComponents: [{ type: 'motor', params: { speed: 8.0, maxForce: 600, enabled: false } }],
  },
  // 阀门 0.7×1.48×0.7
  {
    id: 'valve_gate',
    name: '阀门',
    category: '机械',
    subcategory: '流体',
    type: 'machinery',
    shape: 'custom',
    size: [0.7, 1.48, 0.7],
    // 体积 0.7252 m³ × 等效密度 120 kg/m³ ≈ 87 kg（DN100 闸阀）
    mass: 0.7 * 1.48 * 0.7 * 120,
    friction: 0.5,
    restitution: 0.1,
    color: 0x9aa7b0,
    icon: '🚧',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['流体', '阀门', '闸阀', '手轮'],
    description: '闸阀，阀体横躺（轴沿 X），竖直阀杆顶着一个 0.6 米手轮，轮顶 1.48 米。手轮转一圈就是开合。',
    parts: [
      // 底脚：0 → 0.25
      { shape: 'box', position: [0, 0.125, 0], size: [0.7, 0.25, 0.7], color: 0x9aa7b0 },
      // 阀体：轴沿 X，0.30 → 0.80
      { shape: 'cylinder', position: [0, 0.55, 0], size: [0.5, 0.6, 0.5], rotationZ: Math.PI / 2, color: 0xcfd6da },
      // 阀杆：0.80 → 1.40
      { shape: 'cylinder', position: [0, 1.1, 0], size: [0.1, 0.6, 0.1], color: 0x9aa7b0 },
      // 手轮：1.40 → 1.48
      { shape: 'cylinder', position: [0, 1.44, 0], size: [0.6, 0.08, 0.6], color: 0xc0392b },
    ],
  },
  // 管道 2.06×0.57×0.5 —— 直径 0.3、长 2 米，圆柱横放（rotationZ）
  {
    id: 'pipe_straight',
    name: '管道',
    category: '机械',
    subcategory: '流体',
    type: 'machinery',
    shape: 'cylinder',
    size: [2.06, 0.57, 0.5],
    // 体积 0.587 m³ × 等效密度 200 kg/m³ ≈ 117 kg（真实 2 m 长 DN300 钢管含法兰约 90~120 kg）
    mass: 2.06 * 0.57 * 0.5 * 200,
    friction: 0.5,
    restitution: 0.1,
    color: 0x9aa7b0,
    icon: '🧪',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['流体', '管道', '法兰', 'DN300'],
    description: '一段 2 米长的 DN300 钢管：直径 0.3 米的圆柱用 rotationZ 横放，两端各带一个法兰，下面两个管托把管子架在 0.2 米高。',
    parts: [
      // 两个管托：0 → 0.20
      { shape: 'box', position: [-0.6, 0.1, 0], size: [0.24, 0.2, 0.5], color: 0x3a3f44 },
      { shape: 'box', position: [0.6, 0.1, 0], size: [0.24, 0.2, 0.5], color: 0x3a3f44 },
      // 管身：直径 0.3、长 2.0、轴沿 X
      { shape: 'cylinder', position: [0, 0.35, 0], size: [0.3, 2.0, 0.3], rotationZ: Math.PI / 2, color: 0x9aa7b0 },
      // 两端法兰
      { shape: 'cylinder', position: [-1.0, 0.35, 0], size: [0.44, 0.06, 0.44], rotationZ: Math.PI / 2, color: 0xcfd6da },
      { shape: 'cylinder', position: [1.0, 0.35, 0], size: [0.44, 0.06, 0.44], rotationZ: Math.PI / 2, color: 0xcfd6da },
    ],
  },
  // 压力罐 1.2×2.9×1.2
  {
    id: 'pressure_tank',
    name: '压力罐',
    category: '机械',
    subcategory: '流体',
    type: 'machinery',
    shape: 'cylinder',
    size: [1.2, 2.9, 1.2],
    // 体积 4.176 m³ × 等效密度 150 kg/m³ ≈ 626 kg（1 m³ 立式压力罐）
    mass: 1.2 * 2.9 * 1.2 * 150,
    friction: 0.6,
    restitution: 0.05,
    color: 0xcfd6da,
    icon: '🛢️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['流体', '罐体', '储能', '压力'],
    description: '立式压力罐：四条腿把 1.2 米直径的罐体抬到 0.4 米高，罐顶有安全阀，罐身侧面挂压力表。',
    parts: [
      // 四条支腿：0 → 0.40
      { shape: 'box', position: [-0.4, 0.2, 0.4], size: [0.14, 0.4, 0.14], color: 0x9aa7b0 },
      { shape: 'box', position: [0.4, 0.2, 0.4], size: [0.14, 0.4, 0.14], color: 0x9aa7b0 },
      { shape: 'box', position: [-0.4, 0.2, -0.4], size: [0.14, 0.4, 0.14], color: 0x9aa7b0 },
      { shape: 'box', position: [0.4, 0.2, -0.4], size: [0.14, 0.4, 0.14], color: 0x9aa7b0 },
      // 罐体：0.40 → 2.60
      { shape: 'cylinder', position: [0, 1.5, 0], size: [1.2, 2.2, 1.2], color: 0xcfd6da },
      // 安全阀：2.60 → 2.90
      { shape: 'cylinder', position: [0, 2.75, 0], size: [0.16, 0.3, 0.16], color: 0xc0392b },
      // 压力表：贴在罐身侧前方
      { shape: 'sphere', position: [0.4, 2.2, 0.4], size: [0.24, 0.24, 0.24], color: 0xd4a437 },
    ],
  },

  // ============================================================
  // 工程机械（4）
  // ============================================================
  // 塔式起重机 6.8×7.05×2.0
  {
    id: 'crane_tower',
    name: '塔式起重机',
    category: '机械',
    subcategory: '工程机械',
    type: 'machinery',
    shape: 'custom',
    size: [6.8, 7.05, 2.0],
    // 体积 95.88 m³ × 等效密度 200 kg/m³ ≈ 19000 kg（塔吊整机 20~30 t 量级）
    mass: 6.8 * 7.05 * 2.0 * 200,
    friction: 0.8,
    restitution: 0.05,
    color: 0xd4a437,
    icon: '🏗️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['工程', '起重机', '塔吊', '吊装'],
    description: '塔式起重机：2×2 米底座 + 6 米塔身 + 回转平台，长臂朝 +X 伸出 5 米，平衡臂朝 -X，末端垂吊绳和吊钩。',
    parts: [
      // 底座：0 → 0.30。整机不对称（长臂朝 +X 伸出 5 米），所以按项目惯例把 parts 整体左移 1.3 米，
      // 让**包围盒中心落在原点**上，塔身因此偏在 x = -1.3，放置时不会觉得模型歪出去
      { shape: 'box', position: [-1.3, 0.15, 0], size: [2.0, 0.3, 2.0], color: 0x9aa7b0 },
      // 塔身：0.30 → 6.30
      { shape: 'box', position: [-1.3, 3.3, 0], size: [0.6, 6.0, 0.6], color: 0xd4a437 },
      // 回转平台：6.30 → 6.70
      { shape: 'box', position: [-1.3, 6.5, 0], size: [1.0, 0.4, 1.0], color: 0x3a3f44 },
      // 起重臂（长臂）：6.80 → 7.05
      { shape: 'box', position: [0.9, 6.925, 0], size: [5.0, 0.25, 0.4], color: 0xd4a437 },
      // 平衡臂（短臂）
      { shape: 'box', position: [-2.5, 6.925, 0], size: [1.8, 0.25, 0.4], color: 0xd4a437 },
      // 吊绳
      { shape: 'cylinder', position: [2.7, 5.8, 0], size: [0.06, 2.0, 0.06], color: 0x3a3f44 },
      // 吊钩
      { shape: 'box', position: [2.7, 4.5, 0], size: [0.3, 0.3, 0.3], color: 0x9aa7b0 },
    ],
  },
  // 小型挖掘机 3.3×1.6×1.6
  {
    id: 'excavator_mini',
    name: '小型挖掘机',
    category: '机械',
    subcategory: '工程机械',
    type: 'machinery',
    shape: 'custom',
    size: [3.3, 1.6, 1.6],
    // 体积 8.448 m³ × 等效密度 200 kg/m³ ≈ 1690 kg（真实 1.7 t 级微挖）
    mass: 3.3 * 1.6 * 1.6 * 200,
    friction: 0.85,
    restitution: 0.05,
    color: 0xd4a437,
    icon: '🚜',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['工程', '挖掘机', '履带', '土方'],
    description: '1.7 吨级小挖：两条 2.6 米履带撑起车体，车体后部是驾驶室，前面大臂接小臂，末端挂着铲斗。',
    parts: [
      // 两条履带：0 → 0.40（parts 整体右移 0.05，让包围盒中心正好落在原点）
      { shape: 'box', position: [-0.35, 0.2, 0.55], size: [2.6, 0.4, 0.5], color: 0x3a3f44 },
      { shape: 'box', position: [-0.35, 0.2, -0.55], size: [2.6, 0.4, 0.5], color: 0x3a3f44 },
      // 车体：0.40 → 0.80
      { shape: 'box', position: [-0.35, 0.6, 0], size: [1.9, 0.4, 1.2], color: 0xd4a437 },
      // 驾驶室：0.80 → 1.60
      { shape: 'box', position: [-0.8, 1.2, 0], size: [0.9, 0.8, 1.0], color: 0x2c3e50 },
      // 大臂
      { shape: 'box', position: [0.65, 1.2, 0], size: [1.6, 0.24, 0.3], color: 0xd4a437 },
      // 小臂
      { shape: 'box', position: [1.35, 0.75, 0], size: [0.24, 1.0, 0.28], color: 0xd4a437 },
      // 铲斗：0 → 0.50
      { shape: 'box', position: [1.35, 0.25, 0], size: [0.6, 0.5, 0.7], color: 0x9aa7b0 },
    ],
  },
  // 机械臂 2.1×2.13×0.9
  {
    id: 'robotic_arm',
    name: '机械臂',
    category: '机械',
    subcategory: '工程机械',
    type: 'machinery',
    shape: 'custom',
    size: [2.1, 2.13, 0.9],
    // 体积 4.026 m³ × 等效密度 250 kg/m³ ≈ 1006 kg（工业六轴臂一台 0.5~1 t）
    mass: 2.1 * 2.13 * 0.9 * 250,
    friction: 0.7,
    restitution: 0.1,
    color: 0xd4a437,
    icon: '🦾',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['工程', '机械臂', '关节', '自动化'],
    description: '六轴机械臂：0.9 米回转底座上立 1.4 米大臂，顶端接 1.6 米小臂，末端腕部挂着两爪夹爪。',
    parts: [
      // 底座：0 → 0.25（parts 整体左移 0.6，小臂伸出去的那一截不会把包围盒中心带偏）
      { shape: 'cylinder', position: [-0.6, 0.125, 0], size: [0.9, 0.25, 0.9], color: 0x3a3f44 },
      // 回转台：0.25 → 0.60
      { shape: 'cylinder', position: [-0.6, 0.425, 0], size: [0.7, 0.35, 0.7], color: 0xd4a437 },
      // 大臂：0.60 → 2.00
      { shape: 'box', position: [-0.6, 1.3, 0], size: [0.3, 1.4, 0.3], color: 0xd4a437 },
      // 小臂：横着伸出 1.6 米
      { shape: 'box', position: [0.1, 2.0, 0], size: [1.6, 0.26, 0.26], color: 0xd4a437 },
      // 腕部
      { shape: 'box', position: [0.9, 1.85, 0], size: [0.3, 0.3, 0.3], color: 0x3a3f44 },
      // 夹爪：1.20 → 1.70
      { shape: 'box', position: [0.9, 1.45, 0], size: [0.16, 0.5, 0.3], color: 0x9aa7b0 },
    ],
    physicsComponents: [{ type: 'motor', params: { speed: 1.2, maxForce: 800, enabled: false } }],
  },
  // 混凝土搅拌机 2.0×1.5×1.0
  {
    id: 'concrete_mixer',
    name: '混凝土搅拌机',
    category: '机械',
    subcategory: '工程机械',
    type: 'machinery',
    shape: 'custom',
    size: [2.0, 1.5, 1.0],
    // 体积 3.0 m³ × 等效密度 200 kg/m³ ≈ 600 kg（小型滚筒搅拌机）
    mass: 2.0 * 1.5 * 1.0 * 200,
    friction: 0.75,
    restitution: 0.05,
    color: 0xd4a437,
    icon: '🧱',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['工程', '搅拌机', '滚筒', '建材'],
    description: '滚筒式搅拌机：2 米机架上横放一个 1 米直径的滚筒（轴沿 X），一侧是驱动电机，另一侧伸着出料槽。',
    parts: [
      // 机架：0 → 0.40
      { shape: 'box', position: [0, 0.2, 0], size: [2.0, 0.4, 1.0], color: 0xd4a437 },
      // 滚筒：轴沿 X，0.50 → 1.50
      { shape: 'cylinder', position: [0.1, 1.0, 0], size: [1.0, 1.2, 1.0], rotationZ: Math.PI / 2, color: 0x9aa7b0 },
      // 驱动电机：0.40 → 0.80
      { shape: 'box', position: [-0.6, 0.6, 0], size: [0.5, 0.4, 0.4], color: 0x3a3f44 },
      // 出料槽
      { shape: 'box', position: [0.7, 0.6, 0], size: [0.5, 0.12, 0.4], color: 0x9aa7b0 },
    ],
  },

  // ============================================================
  // 控制（2）
  // ============================================================
  // 控制面板 1.1×1.7×0.62
  {
    id: 'control_panel',
    name: '控制面板',
    category: '机械',
    subcategory: '控制',
    type: 'machinery',
    shape: 'custom',
    size: [1.1, 1.7, 0.62],
    // 体积 1.159 m³ × 等效密度 150 kg/m³ ≈ 174 kg（钢板控制柜 + 内部元器件）
    mass: 1.1 * 1.7 * 0.62 * 150,
    friction: 0.6,
    restitution: 0.05,
    color: 0x3a3f44,
    icon: '🎛️',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['控制', '电柜', '按钮', '操作台'],
    description: '落地控制柜：1.7 米高的柜体正面嵌一块斜面显示屏，屏下三个按钮。想让它控制别的机械，得自己接逻辑连线。',
    parts: [
      // 底座：0 → 0.10
      { shape: 'box', position: [0, 0.05, 0], size: [1.1, 0.1, 0.6], color: 0x9aa7b0 },
      // 柜体：0.10 → 1.70
      { shape: 'box', position: [0, 0.9, 0], size: [1.0, 1.6, 0.5], color: 0x3a3f44 },
      // 显示屏
      { shape: 'box', position: [0, 1.35, 0.28], size: [0.9, 0.5, 0.06], color: 0x22d3ee },
      // 三个按钮：圆柱轴向 Z（rotationX 放倒）
      { shape: 'cylinder', position: [-0.25, 0.9, 0.27], size: [0.1, 0.05, 0.1], rotationX: Math.PI / 2, color: 0xc0392b },
      { shape: 'cylinder', position: [0, 0.9, 0.27], size: [0.1, 0.05, 0.1], rotationX: Math.PI / 2, color: 0xd4a437 },
      { shape: 'cylinder', position: [0.25, 0.9, 0.27], size: [0.1, 0.05, 0.1], rotationX: Math.PI / 2, color: 0x4f9d3f },
    ],
  },
  // 接近传感器 0.3×0.74×0.3
  {
    id: 'proximity_sensor',
    name: '接近传感器',
    category: '机械',
    subcategory: '控制',
    type: 'machinery',
    shape: 'cylinder',
    size: [0.3, 0.74, 0.3],
    // 体积 0.0666 m³ × 等效密度 150 kg/m³ ≈ 10 kg（小型感应头 + 底座）
    mass: 0.3 * 0.74 * 0.3 * 150,
    friction: 0.5,
    restitution: 0.1,
    color: 0x9aa7b0,
    icon: '📡',
    isStatic: true,
    isDestructible: true,
    isPlaceable: true,
    textureType: 'steel',
    tags: ['控制', '传感器', '触发', '自动化'],
    description: '接近传感器：0.5 米壳体顶端是感应面，顶上指示灯亮起表示有东西进入。自带半径 2 米的球形触发区，触发后往外发事件。',
    parts: [
      // 底座：0 → 0.08
      { shape: 'box', position: [0, 0.04, 0], size: [0.3, 0.08, 0.3], color: 0x3a3f44 },
      // 壳体：0.08 → 0.58
      { shape: 'cylinder', position: [0, 0.33, 0], size: [0.24, 0.5, 0.24], color: 0x9aa7b0 },
      // 感应面：0.58 → 0.64
      { shape: 'cylinder', position: [0, 0.61, 0], size: [0.26, 0.06, 0.26], color: 0xcfd6da },
      // 指示灯：0.64 → 0.74
      { shape: 'sphere', position: [0, 0.69, 0], size: [0.1, 0.1, 0.1], color: 0x4f9d3f },
    ],
    // 传感器本体细长，但探测范围是 2 米半径的球：collider 只做事件不做碰撞，trigger 往外发事件
    physicsComponents: [
      { type: 'collider', params: { shape: 'cylinder', size: [0.24, 0.5, 0.24], sensor: true } },
      { type: 'trigger', params: { shape: 'sphere', size: [4, 4, 4], offset: [0, 0.37, 0], onEnter: 'none' } },
    ],
  },
];
