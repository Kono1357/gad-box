/**
 * 建筑（实例类物体）的类型契约。
 *
 * M2 起建筑会绑定 Rapier 刚体：`physicsHandle` + `physicsMode` 决定它
 * 是稳稳摆着（static）、会掉下来（dynamic）、还是被玩家拿着（kinematic）。
 *
 * 原点约定：**建筑原点在底面中心**。
 * 这样"贴地放置"就是简单的 `position.y = 地面高度`，不需要每个模型单独记录偏移；
 * 对物理也一样 —— 刚体的位置就是底面中心，碰撞体相对它向上堆。
 */

/**
 * 整体外形（只用于面板分类与缩略图挑形状，**不影响几何** —— 几何永远由 `parts` 决定）。
 * `'composite'` 是 M4 加的：自定义物品与"多零件拼装"的物品用它。
 */
export type BuildingShape = 'cube' | 'cuboid' | 'cylinder' | 'sphere' | 'custom' | 'composite';

/** 组成建筑的单个几何体 */
export type BuildingPartShape = 'box' | 'cylinder' | 'sphere' | 'cone';

/**
 * 刚体模式。定义在这里而不是 physics/ 里，是因为它描述的是"建筑实例的状态"；
 * physics/PhysicsWorld.ts 直接复用这个类型，避免两边各定义一份导致不一致。
 */
export type PhysicsMode = 'static' | 'dynamic' | 'kinematic';

/** 稳定性三档 */
export type Stability = 'stable' | 'critical' | 'unstable';

/**
 * 镜像轴。
 * 'none' 不镜像；'x' 表示几何体在**局部 X** 上被镜像（用于"关于世界 X 平面镜像"的副本）。
 */
export type MirrorAxis = 'none' | 'x' | 'z';

export interface BuildingPart {
  shape: BuildingPartShape;
  /** 相对建筑原点（底面中心）的偏移，单位米 */
  position: [number, number, number];
  /**
   * 尺寸，单位米：
   * - box：[宽X, 高Y, 深Z]
   * - cylinder / cone：[直径, 高度, 直径]
   * - sphere：[直径X, 直径Y, 直径Z]
   */
  size: [number, number, number];
  /** 绕 Y 轴旋转（弧度） */
  rotationY?: number;
  /** 绕 X / Z 轴旋转（弧度），用于斜坡、放倒的圆柱等 */
  rotationX?: number;
  rotationZ?: number;
  /** 十六进制颜色 */
  color: number;
}

export interface BuildingDef {
  /** 唯一 id：小写英文 + 下划线，可作为存档键 */
  id: string;
  /** 中文显示名 */
  name: string;
  /** 一级分类（见 buildingCategories.ts）。M4 起保留原有 9 类不变，新增内容按子类归入 */
  category: string;
  /**
   * 二级分类（M4 新增）：比 category 细一层，用于面板过滤。
   * 例如 category='结构' + subcategory='楼梯'；category='小物品' + subcategory='餐具'。
   */
  subcategory?: string;
  /**
   * 物品类型（M4 扩了 5 个值）。
   * 旧值 `'building' | 'prop' | 'vehicle' | 'magic'` 保留 —— 77 个 M1.5 时代的物品在用它们，
   * 改掉会让存档与既有断言全部失效。新内容用下面这些更具体的值。
   */
  type:
    | 'building'
    | 'prop'
    | 'vehicle'
    | 'magic'
    | 'structure'
    | 'furniture'
    | 'appliance'
    | 'decoration'
    | 'machinery'
    | 'small'
    | 'plant';
  shape: BuildingShape;
  /** 整体包围盒 [宽, 高, 深]，米 */
  size: [number, number, number];
  /** 质量 kg */
  mass: number;
  /** 摩擦系数 0~1 */
  friction: number;
  /** 弹性系数 0~1 */
  restitution: number;
  /** 主色（UI 缩略图用） */
  color: number;
  /** emoji 图标 */
  icon: string;
  /** 默认是否静态 */
  isStatic: boolean;
  /** 是否可被破坏 */
  isDestructible: boolean;
  /** 是否可放置 */
  isPlaceable: boolean;
  tags: string[];
  description: string;
  /** 1~8 个基本几何体 */
  parts: BuildingPart[];

  // ---------------------------------------------------------------- M4 扩展字段
  //
  // 全部可选：M1.5 时代的 77 个物品不带这些字段，加了默认行为要能兜住。

  /**
   * 能否被别的物体压在上面。
   * `false` 用于"台灯 / 花瓶 / 小盆栽"这类被压就倒的东西 —— 堆叠系统会拒绝在它上面落位。
   * 不填按 `true` 处理。
   */
  stackable?: boolean;

  /**
   * 物理组件（M4）：直接复用 `data/physicsComponents.ts` 的类型，
   * 而不是新定义一套 —— 那套已经有断言覆盖、也能进存档。
   */
  physicsComponents?: import('../data/physicsComponents').PhysicsComponent[];

  /**
   * 程序化纹理类型（M4）：对应 `voxelTypes.ts` 里的纹理键。
   * `'none'` 或不填 = 纯色（用 `color`）。
   * 注意这是**视觉**字段，不影响物理。
   */
  textureType?: string;

  /** LOD 层级数（M4）：1 或省略 = 不做 LOD。当前渲染器统一用单一模型，这个字段先只做数据 */
  lodLevels?: number;

  /** 缩略图（可选）。不填时面板会用 `color` + `icon` 现场生成色块缩略图 */
  thumbnail?: string;
}

/** 世界里的一个建筑实例 */
export interface BuildingInstance {
  /** 实例唯一编号 */
  id: number;
  /** 引用的模型 id */
  defId: string;
  /** 底面中心的世界坐标（米） */
  position: [number, number, number];
  /** 绕 Y 轴旋转（弧度）。静态摆放时用它就够了 */
  rotationY: number;
  /**
   * 完整朝向四元数 [x, y, z, w]。
   * 动态刚体可能翻滚到任意姿态，只靠 rotationY 会丢失信息，
   * 所以物理同步时写这个字段，渲染优先使用它。
   */
  quaternion?: [number, number, number, number];
  /** 统一缩放（默认 1） */
  scale: number;
  /** 模型自带的"默认静态"标记 */
  isStatic: boolean;

  /**
   * 局部几何镜像。镜像复制出来的副本会带这个标记，
   * 渲染时用一份镜像过的几何体，这样不对称的模型（车、门把手）才是真的镜像。
   */
  mirror?: MirrorAxis;

  // ---------------- M2：物理 ----------------
  /** Rapier 刚体 handle；-1 表示还没建物理体 */
  physicsHandle?: number;
  /** 当前刚体模式 */
  physicsMode?: PhysicsMode;
  /** 玩家锁定：锁定后不受重力影响，也不会因失去支撑而掉落 */
  locked?: boolean;

  // ---------------- M2：分组 ----------------
  /** 所属分组 id */
  groupId?: string;

  // ---------------- 缓存 ----------------
  /** 模型包围盒尺寸的缓存（创建实例时写入，支撑检查与拾取用） */
  size?: [number, number, number];
  /** 主色缓存 */
  color?: number;
  /** 模型中文名缓存 */
  name?: string;

  // ---------------- 支撑与堆叠状态（由 StackSystem 写入） ----------------
  /** 是否被托住 */
  supported?: boolean;
  /** 悬挑距离（米，M1.5 的旧支撑检查用） */
  cantilever?: number;
  /** 堆叠层数（0 = 直接坐在地形上） */
  stackLayer?: number;
  /** 稳定性判定 */
  stability?: Stability;
  /** 接触面积比 0~1 */
  contactRatio?: number;
}

/**
 * 可序列化的建筑"碎片"。
 *
 * Prefab（预制件）与 Blueprint（蓝图）都用它保存结构 ——
 * 和 BuildingInstance 的区别是：没有 id、没有运行时状态，
 * 纯粹描述"放哪个模型、放在相对哪里、转多少度"。
 */
export interface BuildingPiece {
  defId: string;
  /** 相对结构原点的偏移（米） */
  position: [number, number, number];
  rotationY: number;
  scale: number;
  /** 可选的物理模式，放置时可以沿用 */
  mode?: PhysicsMode;
  /** 镜像标记（蓝图/预制件里保留，放置后仍是镜像体） */
  mirror?: MirrorAxis;
}

/** 分组。支持嵌套（parentGroupId） */
export interface Group {
  id: string;
  name: string;
  objectIds: number[];
  parentGroupId?: string;
}

/** 预制件：玩家自己保存的常用结构 */
export interface Prefab {
  id: string;
  name: string;
  /** 相对预制件原点的碎片列表 */
  objects: BuildingPiece[];
  /** SVG data URL 缩略图 */
  thumbnail: string;
  createdAt: number;
}

/** 蓝图：可以导出成文件的完整结构描述 */
export interface Blueprint {
  version: string;
  name: string;
  objects: BuildingPiece[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** 支撑检查的单条诊断结果 */
export interface SupportIssue {
  instanceId: number;
  /** 'floating' 完全悬空 | 'cantilever' 悬挑过长 */
  kind: 'floating' | 'cantilever';
  /** 说明文字 */
  message: string;
}
