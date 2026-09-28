import type { BrushSettings } from './voxel/BrushSystem';

/**
 * 应用的共享状态。
 *
 * 单独成文件的原因：Engine 与四个 UI 面板都要读写同一份状态，
 * 如果类型定义在 Engine 里，UI 就得 `import type { ... } from '../core/Engine'`，
 * 而 Engine 又要 import UI —— 虽然类型导入会被擦除、运行时不会真的有环，
 * 但这种双向依赖读起来很别扭，也容易被后续的改动搞成真环。
 */

/** 鼠标左键是"转视角"还是"画地形" */
export type EditMode = 'edit' | 'view';

/** 当前在用地形工具、建筑工具还是选择工具 */
/**
 * 当前工具。
 *
 * `fluid` 是 M4 第二部分加进来的第 4 个工具：它不改地形，而是在笔刷位置
 * 生成/移除流体粒子，或者把一块空间冻住（见 FluidEditor）。
 */
export type ActiveTool = 'terrain' | 'building' | 'select' | 'fluid' | 'sand';

/** 堆叠方向（问题 1.5：默认沿 Y 叠罗汉，也可以沿 X/Z 排成墙） */
export type StackAxisName = 'y' | 'x' | 'z';

/** 质量预设名 */
export type QualityPresetName = 'performance' | 'balanced' | 'quality';

/** 调试开关 */
export interface DebugSettings {
  /** 区块边界线框 */
  chunkBorders: boolean;
  /** 地形线框模式 */
  wireframe: boolean;
  /** 笔刷范围可视化 */
  brushCursor: boolean;
  /** 地面网格 */
  debugGrids: boolean;
  /** M0 的占位道具 */
  props: boolean;
  /** 自动保存 */
  autoSave: boolean;
  /** 视锥剔除 */
  frustumCulling: boolean;
  /** 颜色图例（每种体素的代表色） */
  colorLegend: boolean;
  /** 稳定性着色：不稳的物体染红、勉强的染黄（补充 2） */
  stabilityColors: boolean;
  /** 支撑面可视化：高亮选中物体脚下的支撑面与占用格子（问题 2.5） */
  supportOverlay: boolean;
  /** 对齐辅助线（补充 4） */
  alignGuides: boolean;
  /**
   * 换地图前先确认（问题 4.1）。
   * 默认开启：M2.5 起玩家会在地形和建筑上积累十几分钟的成果，静默覆盖不可接受。
   * 只在「当前世界确实有未保存改动」时才会真的弹窗，纯浏览时照样直接换。
   */
  confirmWorldSwitch: boolean;
}

/** 物理规则开关与参数 */
export interface PhysicsSettings {
  waterEnabled: boolean;
  /** 水速 0.05~1 */
  waterSpeed: number;
  /** 水扩散方向数 1~4 */
  waterDispersion: number;
  sandEnabled: boolean;
  /** 安息角（度） */
  sandAngle: number;
  supportEnabled: boolean;
  /** 允许悬挑（米） */
  supportCantilever: number;
}

/** 建筑放置设置 */
export interface BuildSettings {
  /** 网格吸附 */
  snapToGrid: boolean;
  /** 吸附步长（米） */
  snapStep: number;
  /** 旋转步长（度）：90 = 只转直角；5 = 接近自由旋转 */
  rotationStep: number;
  /** 放置后自动贴地 */
  snapToGround: boolean;
}

/** M2：智能放置设置 */
export interface PlacementState {
  /** 自动推荐落点（关掉就只用光标位置） */
  autoRecommend: boolean;
  /** 放在空中会下坠（开启时悬空物体建成动态刚体） */
  physicsFall: boolean;
  /** 吸附点对齐 */
  snapAnchors: boolean;
  /** 吸附到支撑面 */
  snapSurface: boolean;
  /** 贴墙对齐（门窗用） */
  snapWall: boolean;
  /** 当前选中的候选点序号 */
  candidateIndex: number;
  /** 候选点数量上限 */
  maxCandidates: number;
  /** 堆叠方向（问题 1.5） */
  axis: StackAxisName;
  /** 支撑面上的小网格密度：4 表示划成 4×4（问题 2.6） */
  surfaceGrid: number;
  /** 连续堆叠：按住 Shift 放置后继续往上叠（补充 3） */
  quickStack: boolean;
  /** 连续堆叠的撤销粒度（补充 3.7） */
  quickStackUndo: 'merge' | 'each';
  /**
   * 问题 5：候选点「跳远」时镜头平滑跟随（0.3 秒）。
   * 只在候选跳到远处时介入（切候选、换目标、换地图），正常瞄准时不动镜头 ——
   * 每帧跟着光标晃的镜头会晕到没法用。
   */
  trackCamera: boolean;
  /** 问题 5：候选点在视野外时，在屏幕边上显示一个方向箭头 + 距离 */
  showEdgeArrow: boolean;
  /** 问题 5：候选点的脉冲高亮框（depthTest 关掉，被地形挡住也能看见） */
  highlightCandidate: boolean;
}

/** 画质与性能 */
export interface QualityState {
  preset: QualityPresetName;
  /** 手动改过画质开关后置位，自适应降级就不再自动调整 */
  manualOverride: boolean;
  /** 渲染距离（区块数）—— 由世界档位与预设共同决定，自适应会改它 */
  renderDistance: number;
  /** 世界档位给的基准渲染距离，自适应在它之上做缩放 */
  baseRenderDistance: number;
  shadows: boolean;
  ao: boolean;
  antialias: boolean;
  /** 自适应降级总开关 */
  adaptive: boolean;
  /** 当前降级档位（面板显示用） */
  adaptiveLevel: 'full' | 'reduced' | 'minimal';
}

/** M2：选择与微调设置 */
export interface SelectionState {
  /** 正在框选 */
  boxSelecting: boolean;
  /** 微调位置步长（米） */
  nudgeStep: number;
  /** 微调旋转步长（度） */
  fineRotationStep: number;
}

/** 整个应用的可变状态 */
export interface AppState {
  mode: EditMode;
  tool: ActiveTool;
  brush: BrushSettings;
  debug: DebugSettings;
  physics: PhysicsSettings;
  build: BuildSettings;
  placement: PlacementState;
  selection: SelectionState;
  quality: QualityState;
  /** 当前选中的建筑模型 id */
  selectedBuildingId: string | null;
  /** 当前选中的建筑实例 id */
  selectedInstanceId: number | null;
}
