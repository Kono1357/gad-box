/**
 * 物理组件定义（问题 A.2）。
 *
 * 设计原则：**组件是纯数据，挂在建筑实例上**。
 * 本轮不做 M3 那种"全动态破坏"，所以组件的职责是回答三个问题：
 * 1. 这个物体要不要参与物理？（rigidbody）
 * 2. 它和谁连在一起、怎么连？（joint / spring / motor）
 * 3. 玩家碰它的时候会发生什么？（trigger）
 *
 * `params` 用宽松的 Record 而不是每个组件一个 interface：
 * 组件种类会随 M3 扩展，用强类型会在每次加字段时到处改；
 * 但**取值的地方**（PhysicsFramework）会做校验和默认值，保证脏数据不会传进物理引擎。
 */

export type ComponentType = 'rigidbody' | 'collider' | 'joint' | 'trigger' | 'spring' | 'motor';

export interface PhysicsComponent {
  type: ComponentType;
  params: Record<string, unknown>;
}

export const COMPONENT_LABELS: Record<ComponentType, string> = {
  rigidbody: '刚体',
  collider: '碰撞体',
  joint: '关节',
  trigger: '触发器',
  spring: '弹簧',
  motor: '电机',
};

export const COMPONENT_ICONS: Record<ComponentType, string> = {
  rigidbody: '⬛',
  collider: '📦',
  joint: '🔗',
  trigger: '🎯',
  spring: '🌀',
  motor: '⚙️',
};

/** 刚体组件参数 */
export interface RigidbodyParams {
  /** 静态 / 动态 / 运动学 */
  mode: 'static' | 'dynamic' | 'kinematic';
  /** 密度（kg/m³），不填则按模型自带的 mass 反推 */
  density?: number;
  /** 线性阻尼 */
  linearDamping?: number;
  /** 角阻尼 */
  angularDamping?: number;
  /** 是否锁定旋转（箱子不会乱滚，但可以滑动） */
  lockRotation?: boolean;
}

/** 碰撞体组件参数 */
export interface ColliderParams {
  /** 形状；'auto' 表示按模型的 parts 推导复合碰撞体 */
  shape: 'auto' | 'box' | 'sphere' | 'cylinder';
  /** 非 auto 时的尺寸 */
  size?: [number, number, number];
  friction?: number;
  restitution?: number;
  /** 是否是"传感器"：只触发事件，不产生碰撞 */
  sensor?: boolean;
}

/** 触发器组件参数 */
export interface TriggerParams {
  shape: 'box' | 'sphere' | 'cylinder';
  size: [number, number, number];
  /** 相对物体的偏移 */
  offset?: [number, number, number];
  /** 进入时执行的逻辑事件 */
  onEnter?: string;
  /** 离开时执行的逻辑事件 */
  onExit?: string;
}

/** 电机组件参数 */
export interface MotorParams {
  /** 目标速度 */
  speed: number;
  /** 最大出力 */
  maxForce: number;
  /** 是否默认开启 */
  enabled: boolean;
}

/** 弹簧组件参数 */
export interface SpringParams {
  stiffness: number;
  damping: number;
  /** 静止长度 */
  restLength: number;
}

/** 逻辑事件类型（问题 A.5） */
export type LogicEventType =
  | 'toggle-light'
  | 'open-door'
  | 'close-door'
  | 'play-animation'
  | 'spawn-object'
  | 'destroy-object'
  | 'teleport'
  | 'toggle-motor'
  | 'set-color'
  | 'play-sound'
  | 'none';

export interface LogicEvent {
  type: LogicEventType;
  /** 目标物体 id；空表示"自己" */
  target?: string;
  /** 附加参数（颜色、传送点、生成模型 id…） */
  data?: Record<string, unknown>;
}

export const LOGIC_EVENT_LABELS: Record<LogicEventType, string> = {
  'toggle-light': '开灯/关灯',
  'open-door': '开门',
  'close-door': '关门',
  'play-animation': '播放动画',
  'spawn-object': '生成物体',
  'destroy-object': '销毁物体',
  teleport: '传送到目标',
  'toggle-motor': '开关电机',
  'set-color': '改变颜色',
  'play-sound': '播放音效',
  none: '什么都不做',
};

/** 逻辑连线：从 A 的事件连到 B 的动作（问题 A.6） */
export interface LogicLinkConfig {
  id: string;
  /** 发出事件的物体（实例 id 字符串） */
  sourceId: string;
  /** 触发的时机 */
  on: 'enter' | 'exit' | 'activate' | 'always';
  /** 要执行的动作 */
  events: LogicEvent[];
  /** 给玩家看的名字 */
  label?: string;
}
