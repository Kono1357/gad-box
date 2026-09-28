/**
 * 关节类型定义（问题 A.3）。
 *
 * 六种关节对应六类组合玩法：
 * - `fixed`：门框与门、把两块板焊在一起；
 * - `revolute`：门轴、轮子、齿轮 —— 绕一根轴自由转动（可限位）；
 * - `prismatic`：抽屉、活塞 —— 沿一根轴平移（可限位）；
 * - `ball`：机械臂、灯笼吊点 —— 三个方向自由转；
 * - `rope`：吊桥、吊灯 —— 只能"拉"，不能"推"；
 * - `spring`：弹簧、悬挂 —— 有刚度与阻尼的软连接。
 *
 * `bodyA` / `bodyB` 在**组合模板**里是 objects 数组的**下标字符串**（'0'、'1'），
 * 在**运行时**是建筑实例的 id 字符串 —— 解析规则见 PhysicsFramework.resolveJointBodies()。
 */

export type JointType = 'fixed' | 'revolute' | 'prismatic' | 'ball' | 'rope' | 'spring';

export interface JointLimits {
  /** 下限（旋转关节是弧度，滑动关节是米） */
  min: number;
  /** 上限 */
  max: number;
}

export interface JointConfig {
  type: JointType;
  /** 主动体：组合模板里是 objects 下标，运行时是实例 id */
  bodyA: string;
  /** 从动体：同上；空字符串表示连到"世界"（静态参考系） */
  bodyB: string;
  /** 关节锚点（世界坐标；模板里是相对组合原点的偏移） */
  anchor: [number, number, number];
  /** 旋转/滑动轴（单位向量） */
  axis?: [number, number, number];
  /** 限位 */
  limits?: JointLimits;
  /** spring 的刚度（N/m）与 spring / rope 的阻尼 */
  stiffness?: number;
  damping?: number;
  /** rope 的长度（米） */
  length?: number;
  /** motor：目标速度（rad/s 或 m/s），设了就表示这个关节由电机驱动 */
  motorSpeed?: number;
  /** motor：目标位置（旋转关节是弧度，滑动关节是米）—— 位置驱动模式用 */
  motorPosition?: number;
  /** motor：马达模式；不填按 `velocity`（保持 M2.5 的既有语义） */
  motorMode?: MotorMode;
  /** motor：最大出力 */
  motorForce?: number;
  /** 给玩家看的名字 */
  label?: string;
}

export const JOINT_TYPE_LABELS: Record<JointType, string> = {
  fixed: '固定关节',
  revolute: '旋转关节',
  prismatic: '滑动关节',
  ball: '球关节',
  rope: '绳索关节',
  spring: '弹簧关节',
};

export const JOINT_TYPE_ICONS: Record<JointType, string> = {
  fixed: '🔗',
  revolute: '🔘',
  prismatic: '↔',
  ball: '⚪',
  rope: '🪢',
  spring: '🌀',
};

export const JOINT_TYPE_DESCRIPTIONS: Record<JointType, string> = {
  fixed: '把两个物体焊死，相对位置永不改变。门框与墙体用它。',
  revolute: '绕一根轴自由转动，可以限位。门轴、轮子、齿轮用它。',
  prismatic: '沿一根轴平移，可以限位。抽屉、活塞、升降台用它。',
  ball: '三轴自由转动的球窝关节。机械臂用它。',
  rope: '只能拉不能推的柔性连接，可设长度。吊桥、吊灯用它。',
  spring: '带刚度与阻尼的弹性连接。弹簧、悬挂用它。',
};

/** 电机：给某个关节加上持续驱动的能力 */
/**
 * 马达模式（M3 第 3 批新增）。
 *
 * - `velocity`：**速度驱动**。给它一个目标速度，它会一直以这个速度转（门持续开、轮子持续转）。
 *   这是 M2.5 就有的模式。
 * - `position`：**位置驱动**。给它一个目标角度/位移，它会用弹簧-阻尼模型走过去并**停在那里**。
 *   门"开到 90° 就停"、活塞"伸到 0.5 米就停"、机械臂"摆到某个角度"都是这个模式。
 *
 * 两者的区别不是"实现细节"，而是**玩家感知到的行为完全不同**：
 * 速度驱动的门会一直转（需要一个行程限位去挡住它），位置驱动的门会自己停在目标角度。
 */
export type MotorMode = 'velocity' | 'position';

export const MOTOR_MODE_LABELS: Record<MotorMode, string> = {
  velocity: '速度驱动（一直转 / 一直推）',
  position: '位置驱动（走到目标就停）',
};

export interface MotorConfig {
  /** 作用在哪个关节（刚体句柄无关，是**关节 id**） */
  jointIndex: number;
  /** 马达模式，默认 velocity（保持 M2.5 的既有语义） */
  mode?: MotorMode;
  /** 目标速度（rad/s 或 m/s）—— velocity 模式必填 */
  speed: number;
  /**
   * 目标位置：旋转关节是**弧度**，滑动关节是**米**。
   * position 模式必填。
   */
  targetPosition?: number;
  /**
   * 位置模式的刚度与阻尼（Rapier 的 `configureMotorPosition`）。
   * 刚度决定"多用力走向目标"，阻尼决定"会不会过冲后晃荡"。
   * 默认 800 / 60 —— 在 1 米/1 弧度的行程上表现为"干脆利落但不猛"。
   */
  stiffness?: number;
  damping?: number;
  /** 最大出力 */
  maxForce: number;
  /** 是否由触发器/逻辑连线控制开关 */
  controlled?: boolean;
}

export const DEFAULT_JOINT_AXIS: [number, number, number] = [0, 1, 0];
