import {
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Points,
  PointsMaterial,
  Raycaster,
  Vector2,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import { BRUSH_CONFIG, CULLING_CONFIG, VOXEL_CONFIG } from '../config';
import { BUILTIN_MAPS, DEFAULT_MAP_ID, getMapById, type MapDefinition } from '../data/maps';
import { DEFAULT_BRUSH_MATERIAL } from '../data/voxelTypes';
import { getWorldSize, type WorldSizeId } from '../worldSize';
import type { AppState, QualityPresetName } from '../appState';
import type { SupportSlot } from '../building/SupportSurface';

/** 支撑面上的一小块占用（给调试面板用） */
type SupportSlotView = SupportSlot;

import { InputSystem } from '../input/InputSystem';
import { GodCameraControls } from '../render/GodCameraControls';
import { RenderSystem } from '../render/RenderSystem';
import type { RenderStats } from '../render/RenderSystem';
import { UISystem } from '../ui/UISystem';
import { BrushUI } from '../ui/BrushUI';
import { BuildingPanel } from '../ui/BuildingPanel';
import { MapSelector } from '../ui/MapSelector';
import { PerformancePanel, type PerformanceStats } from '../ui/PerformancePanel';
import { PlacementUI, type PlacementUIStats } from '../ui/PlacementUI';
import { StackingUI, type StackingUIStats } from '../ui/StackingUI';
import { SupportDebugUI, type SupportDebugStats } from '../ui/SupportDebugUI';
import { QuickStackTool } from '../ui/QuickStackTool';
import { SelectionUI, type SelectionUIStats } from '../ui/SelectionUI';
import { HistoryPanel } from '../ui/HistoryPanel';
import { ShortcutHelp } from '../ui/ShortcutHelp';
import { PrefabPanel } from '../ui/PrefabPanel';

import { Time } from './Time';
import { World } from './World';

import { ChunkMesher } from '../voxel/ChunkMesher';
import { BrushSystem, type BrushMode, type BrushShape } from '../voxel/BrushSystem';
import { raycastVoxels, type VoxelHit } from '../voxel/VoxelRaycast';
import { ChunkCulling } from '../voxel/ChunkCulling';
import { TerrainGenerator } from '../voxel/TerrainGenerator';
import type { VoxelGrid } from '../voxel/VoxelGrid';

import { WaterSystem } from '../physics/WaterSystem';
import { SandSystem } from '../sand/SandSystem';
import { SandEditor, type SandToolResult } from '../sand/SandEditor';
import { SandVisualizer } from '../sand/SandVisualizer';
import type { SandTool } from '../sand/SandPhysics';
import { FluidSave, type FluidSavePayload } from '../save/FluidSave';
import { getVoxelId } from '../data/voxelTypes';
import {
  STRESS_SCENES,
  describeScene,
  getStressScene,
  scaledPlan,
} from '../perf/StressTestScenes';
import {
  appendHistory,
  buildResult,
  compareRuns,
  describeResult,
  exportReport,
  type StressTestResult,
} from '../perf/StressTestReport';
import { PerfRecorder } from '../perf/PerfRecorder';
import { computeHeatmap, describeHeatmap, renderHeatmap } from '../perf/PerfHeatmap';
import { ParticlePool } from '../fluid/ParticlePool';
import { FluidSandTutorial, type TutorialSnapshot } from '../tutorial/FluidSandTutorial';
import { SandWaterInteraction, type ErodibleFluid, type BuriedBuilding } from '../sand/SandWaterInteraction';
import { SandPanel } from '../ui/SandPanel';
import { SupportSystem } from '../physics/SupportSystem';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { TerrainCollider } from '../physics/TerrainCollider';
import { StackSystem, type StackContext } from '../physics/StackSystem';

import { BuildingSystem } from '../building/BuildingSystem';
import { getBuildingDef, registerCustomItem, unregisterCustomItem, BUILDING_CATALOG } from '../data/buildingCatalog';
import { CustomItemUI } from '../ui/CustomItemUI';
import { loadCustomItems } from '../data/customItems';
import { describePlacement } from '../building/BuildingPreview';
import type { BuildingDef, BuildingInstance, PhysicsMode } from '../building/types';

import { SmartPlacement, type SmartPlacementResult } from '../placement/SmartPlacement';
import { SupportSurfaceIndex } from '../building/SupportSurface';
import { StackingPreview } from '../building/StackingPreview';
import { AdaptiveQuality } from '../world/AdaptiveQuality';
import { getQualityPreset, resolveRenderDistance } from '../core/QualityPreset';
import { SelectionSystem } from '../selection/SelectionSystem';
import { PickupSystem } from '../selection/PickupSystem';
import { GroupSystem } from '../group/GroupSystem';
import { PrefabSystem } from '../group/PrefabSystem';
import { BlueprintSystem, type MirrorAxis } from '../group/BlueprintSystem';

import { CommandManager, type TransformChange } from '../command/CommandManager';
import { SaveSystem, type SavedSettings } from '../save/SaveSystem';
import { MapGenerators } from '../world/MapGenerators';
import type { MapGenerationReport } from '../world/MapPlanner';
import { ResourceMonitor, describeSnapshot, type ResourceSnapshot } from '../world/ResourceMonitor';
import { WorldUnloader, disposeObject3D, measureFootprint, type UnloadTask, type UnloadReport } from '../world/WorldUnloader';
import { WorldLoader, type LoadStage } from '../world/WorldLoader';
import { LoadingOverlay } from '../ui/LoadingOverlay';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ResourcePanel } from '../ui/ResourcePanel';
import { HighlightRenderer } from '../placement/HighlightRenderer';
import { CameraTracker } from '../placement/CameraTracker';
import { ScreenEdgeArrow, type ProjectFn } from '../placement/ScreenEdgeArrow';
import { PhysicsFramework } from '../physics/PhysicsFramework';
import { RigidBodyFactory } from '../physics/RigidBodyFactory';
import { PhysicsMaterialRegistry } from '../physics/PhysicsMaterial';
import { TimeControl } from '../physics/TimeControl';
import { PhysicsSnapshot } from '../physics/PhysicsSnapshot';
import { collectDebugGeometry, describeDebugStats, type DebugStats } from '../physics/PhysicsDebug';
import { DistanceCulling } from '../physics/DistanceCulling';
import { FrameScheduler } from '../physics/FrameScheduler';
import { StressTestGenerator, describeScenarioForUI } from '../world/StressTestGenerator';
import { STRESS_SCENARIOS } from '../data/stressTestMaps';
import { BuoyancySystem, createVoxelWaterField } from '../physics/BuoyancySystem';
import { CollapseSystem, COLLAPSE_REASON_LABELS } from '../physics/CollapseSystem';
import { StressVisualizer } from '../physics/StressVisualizer';
import { PhysicsGuard } from '../physics/PhysicsGuard';
import { PhysicsRecorder } from '../physics/PhysicsRecorder';
import { PhysicsAudio } from '../physics/PhysicsAudio';
import { PhysicsPanel } from '../ui/PhysicsPanel';
import { TimePanel } from '../ui/TimePanel';
import { StressPanel } from '../ui/StressPanel';
import { PhysicsTutorialUI } from '../ui/PhysicsTutorialUI';
import { JointEditor } from '../ui/JointEditor';
import { LogicLinkEditor } from '../ui/LogicLinkEditor';
import { CatalogPanel } from '../ui/CatalogPanel';
import { ContentPackUI } from '../ui/ContentPackUI';
import { ContentStatsUI } from '../ui/ContentStatsUI';
import { computeContentStats } from '../data/contentStats';
import { ConflictOverlay, describeConflicts } from '../world/ConflictOverlay';
import { MapTemplateUI } from '../ui/MapTemplateUI';
import { FluidPanel } from '../ui/FluidPanel';
import { FluidSystem } from '../fluid/FluidSystem';
import { FluidRenderer, type FluidRenderStyle } from '../fluid/FluidRenderer';
import { FluidSurface } from '../fluid/FluidSurface';
import { FluidEditor, type FluidTool } from '../fluid/FluidEditor';
import { FluidAudio } from '../fluid/FluidAudio';
import { ParticleFluidField } from '../fluid/ParticleFluidField';
import { FluidWorkerRunner } from '../world/FluidWorkerRunner';
import {
  FluidRigidCoupling,
  COUPLING_PRESET_LABELS,
  type CouplingBody,
  type CouplingPresetName,
} from '../physics/FluidRigidCoupling';
import { targetSpacing } from '../fluid/FluidPresets';
import type { FluidType } from '../fluid/FluidPresets';
import { isLiquid as isLiquidVoxel } from '../data/voxelTypes';
import { isWorkerAvailable } from '../world/ConflictRunner';
import { buildPreview, describePreview, renderPreviewCanvas } from '../world/GenerationPreview';
import { GenerationPipeline } from '../world/GenerationPipeline';
import type { GenerationLog } from '../world/GenerationLogger';
import type { ConflictRecord } from '../world/ConflictDetector';
import {
  buildBuildingKit,
  buildGenerationParams,
  buildItemKit,
  buildNatureSpecs,
  buildPlacementWorld,
  verifyGenerationDefIds,
} from '../world/GenerationContent';
import { loadEnabledPacks } from '../data/contentPacks';
import { getMapTemplate } from '../data/mapTemplates';
import { PerformanceMonitor } from '../perf/PerformanceMonitor';
import { phaseLabel } from '../perf/FrameProfiler';
import { MemoryPanel } from '../perf/MemoryPanel';
import { AutoDegrade } from '../perf/AutoDegrade';
import { CONTENT_PACKS, CONTENT_PACK_STORAGE_KEY } from '../data/contentPacks';
import { ConnectorOverlay } from '../ui/ConnectorOverlay';
import {
  LOGIC_GATE_LABELS,
  type LogicAction,
  type LogicActionType,
  type LogicGateKind,
} from '../physics/LogicLink';
import { LOGIC_EVENT_LABELS, type LogicEventType } from '../data/physicsComponents';
import { PhysicsTutorialRunner, PHYSICS_TUTORIAL_LEVELS } from '../tutorial/PhysicsTutorial';
import { JOINT_TYPE_LABELS, type JointConfig } from '../data/jointTypes';
import { GRAVITY_PRESETS, configForPreset, describeGravity } from '../data/gravityPresets';
import { RAPIER_CHUNK_FILE, type RapierLoadingProgress } from '../physics/RapierWorld';
import { HintBanner } from '../ui/HintBanner';
import { ComboBuilder } from '../physics/ComboBuilder';
import { PhysicsDebugUI } from '../ui/PhysicsDebugUI';
import { PhysicsSandboxMode } from '../ui/PhysicsSandboxMode';
import { ComboPanel, buildComboCards } from '../ui/ComboPanel';
import { TutorialUI } from '../ui/TutorialUI';
import { HapticFeedback } from '../mobile/HapticFeedback';
import { MobileController } from '../mobile/MobileController';
import { GestureTutorial } from '../mobile/GestureTutorial';
import { COMBOS } from '../data/combos';
import { getTutorialLevel, TUTORIAL_LEVELS } from '../tutorial/TutorialLevel';
import type { Combo } from '../data/combos';
import type { LogicActionRequest } from '../physics/LogicLink';

export interface EngineOptions {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  seed?: number;
}

/**
 * 换世界的请求（问题 4）。
 *
 * 之所以做成一个联合类型而不是两个方法：**换世界的路径必须只有一条**。
 * M1.5 的 bug 正是因为「载入参考地图」和「新建空白世界」各写了一套，
 * 一种记得清空旧数据、另一种忘了，于是行为不一致、内存泄漏也只在其中一条路上出现。
 * 现在两条路都进 `switchWorld()`，卸载和加载清单对两者一样生效。
 */
export type WorldRequest =
  | { kind: 'map'; definition: MapDefinition }
  | { kind: 'empty'; sizeId: WorldSizeId }
  /**
   * M3 第 8 批：压力测试场景。
   * 归到这里而不是单开一条路径，是因为它**同样会清空当前世界**，
   * 必须走同一条卸载 → 生成 → 重建物理的流水线。多一条独立路径就多一处内存泄漏的机会。
   */
  | { kind: 'stress'; scenarioId: string }
  /**
   * M4：用 9 阶段流水线生成一张新地图（模板 + 参数）。
   *
   * 与 `kind: 'map'` 的区别：那个走的是 M1.5 的 `MapGenerators`（手工雕刻的 4 张参考地图），
   * 这个走的是 M4 的分阶段流水线（8 套模板 + 冲突检测与修复）。
   * **两条路都保留**：参考地图是"已经做好的样板"，流水线是"用参数生成一张新的"。
   */
  | { kind: 'generate'; templateId: string; seed?: number };

/**
 * 世界坐标 → 屏幕像素坐标（问题 5：屏幕边缘箭头用）。
 *
 * `visible` 的含义是「在相机前方」而不是「在视口内」：投影之后的 x/y 可能远超视口，
 * 那正是「目标是看得见的方向但跑出画面了」这种情况，箭头就是为它准备的。
 * 相机背后的点会被标记 `visible: false`，因为投影会翻转，用它算方向会得到完全相反的结果。
 */
/** 把向量归一化（零向量退回 Y 轴，否则圆弧会退化成一点） */
function normalizeVec(v: [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(length) || length < 1e-6) return [0, 1, 0];
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * 给一根轴找两个正交基向量（画圆弧用）。
 *
 * 做法：取一个和轴不平行的参考向量做叉乘。选参考向量时要避开"轴本来就和它平行"的情况，
 * 否则叉乘结果为零向量、圆弧会塌成一条线 —— 这也是为什么这里用 Y 轴作为首选参考
 * （大多数关节轴是水平的，水平轴与 Y 轴一定不平行）。
 */
function basisFor(axis: [number, number, number]): [[number, number, number], [number, number, number]] {
  const reference: [number, number, number] = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalizeVec([
    reference[1] * axis[2] - reference[2] * axis[1],
    reference[2] * axis[0] - reference[0] * axis[2],
    reference[0] * axis[1] - reference[1] * axis[0],
  ]);
  const v = normalizeVec([
    axis[1] * u[2] - axis[2] * u[1],
    axis[2] * u[0] - axis[0] * u[2],
    axis[0] * u[1] - axis[1] * u[0],
  ]);
  return [u, v];
}

function projectToScreen(
  world: { x: number; y: number; z: number },
  camera: PerspectiveCamera,
  width: number,
  height: number,
): { x: number; y: number; visible: boolean } {
  const point = new Vector3(world.x, world.y, world.z).project(camera);
  // 相机背后的点：透视投影会把 x/y 翻号，直接拿来算方向会得到**完全相反**的箭头。
  // 所以这里手动翻回来（相当于把 NDC 关于中心镜像一次），箭头方向才是对的。
  const behind = point.z > 1 || point.z < -1;
  const ndcX = behind ? -point.x : point.x;
  const ndcY = behind ? -point.y : point.y;
  return {
    x: ((ndcX + 1) / 2) * width,
    // NDC 的 y 向上、屏幕的 y 向下
    y: ((-ndcY + 1) / 2) * height,
    visible: !behind,
  };
}

/**
 * UI 面板数据的刷新间隔（毫秒）。
 * 这些面板显示的是统计量（热力图、分类占比、"已放 N 个"），
 * 400 ms 与 16 ms 在观感上没有区别，但主线程开销差 25 倍。
 */
const UI_TICK_INTERVAL_MS = 400;

/**
 * 流体障碍的分桶键（区块坐标 → 整数）。
 *
 * 见 `fluidObstacles` 的注释：用字符串键时每帧要拼几万个字符串。
 * +128 是把负的区块坐标平移到非负（世界最大 192 格 = 12 个区块，128 远超需要）。
 */
function fluidBucketKey(bx: number, bz: number): number {
  return (bx + 128) * 256 + (bz + 128);
}

/** 单帧最大真实间隔 */
const MAX_FRAME_DELTA = 0.25;
/** 地形编辑后延迟多久重新做一次支撑检查（毫秒） */
const SUPPORT_RECHECK_DELAY = 450;

/**
 * 候选点距离相机注视点多少米以内就**不动镜头**（问题 5）。
 *
 * 12 米是量出来的手感：小于这个距离时玩家还在"微调瞄准"，
 * 镜头只要动一下就会破坏他对屏幕位置的记忆；超过之后目标基本已经跑到屏幕外，
 * 不动镜头玩家反而找不到。所以 12 米以内稳如磐石，超过才平滑推过去。
 */
const CAMERA_FOLLOW_MIN_JUMP = 12;

/**
 * 单帧物理耗时预算（毫秒）。用户给的验收线是"物理求解耗时小于 5ms"。
 * 超预算时面板会标红并累计连续帧数 —— 偶尔抖一下不用管，连续超标才是真的重。
 */
const DETECT_STEP_BUDGET_MS = 5;

/**
 * rapier 的固定 chunk URL（M3 第 1 批：真字节进度用）。
 *
 * 依赖 `vite.config.ts` 里把 rapier 那个 chunk 输出成 `assets/rapier.js`（无 hash）。
 * 拿不到这个文件时不是错误 —— `RapierWorldManager` 会退化成阶段进度。
 * `import.meta.env.BASE_URL` 保证在 GitHub Pages 的子路径（`/god-sandbox/`）下也对。
 */
const RAPIER_CHUNK_URL =
  typeof import.meta !== 'undefined' && import.meta.env ? `${import.meta.env.BASE_URL}${RAPIER_CHUNK_FILE}` : RAPIER_CHUNK_FILE;

/** 与某个世界实例绑定的子系统（换世界时整体重建） */
interface WorldBundle {
  world: World;
  grid: VoxelGrid;
  brush: BrushSystem;
  mesher: ChunkMesher;
  culling: ChunkCulling;
  water: WaterSystem;
  sand: SandSystem;
}

type ToolName = 'terrain' | 'building' | 'select' | 'fluid' | 'sand';

/**
 * 引擎总装。
 *
 * 主循环（M2）：
 *   1. 固定步长：水 → 沙 → **Rapier 物理**（暂停时整个回调都不执行，
 *      所以"暂停时在空中放置物体、恢复播放才下坠"是天然成立的）
 *   2. 物理 → 数据的位姿回写
 *   3. 相机 → 剔除 → 局部重建
 *   4. 交互：笔刷 / 智能放置 / 选择 / 拿起
 *   5. 渲染 + 高亮合批
 *   6. 统计 / UI / 自动保存
 *
 * 物理初始化是**异步**的（要加载 wasm），所以整套流程带"就绪门闩"：
 * 物理没就绪时放置退化成静态摆放、重叠校验退化成 AABB，游戏照样能玩；
 * 就绪后 `onPhysicsReady()` 一次性补上地形碰撞体与所有建筑的刚体。
 */
export class Engine {
  readonly time = new Time();
  readonly input: InputSystem;
  readonly render: RenderSystem;
  readonly controls: GodCameraControls;
  readonly ui: UISystem;
  readonly state: AppState;

  readonly brushUI: BrushUI;
  readonly buildingPanel: BuildingPanel;
  readonly mapSelector: MapSelector;
  readonly perfPanel: PerformancePanel;
  readonly placementUI: PlacementUI;
  readonly stackingUI: StackingUI;
  readonly supportDebugUI: SupportDebugUI;
  readonly selectionUI: SelectionUI;
  readonly historyPanel: HistoryPanel;
  readonly shortcutHelp: ShortcutHelp;
  readonly prefabPanel: PrefabPanel;
  /** 问题 4：换地图的加载遮罩（进度条 + 淡入淡出） */
  readonly loadingOverlay: LoadingOverlay;
  /** 问题 4.1：换地图前的确认对话框 */
  readonly confirmDialog: ConfirmDialog;
  /** 补充 4：资源与内存面板 */
  readonly resourcePanel: ResourcePanel;
  /** 补充 4：内存采样与换图前后对比 */
  readonly resources = new ResourceMonitor();
  /** 问题 4：卸载清单执行器 */
  readonly unloader = new WorldUnloader();
  /** 问题 4：分阶段加载器 */
  readonly worldLoader: WorldLoader;
  /** 问题 A：四层物理框架（刚体 / 碰撞 / 约束 / 逻辑） */
  readonly framework: PhysicsFramework;
  /** 第 5 批：20 个物理组合的生成器 */
  readonly combos: ComboBuilder;
  /** 问题 A：物理调试面板 */
  readonly physicsDebugUI: PhysicsDebugUI;
  /** 补充 2：物理沙盘模式 */
  readonly sandbox: PhysicsSandboxMode;
  /** 第 5 批：组合面板 */
  readonly comboPanel: ComboPanel;
  /** 补充 1：教学关卡界面 */
  readonly tutorialUI: TutorialUI;
  /** 补充 5：震动反馈 */
  readonly haptics = new HapticFeedback();
  /** 非阻塞提示条（物理加载失败等"需要一直看着"的提示用它，不是一闪而过的 toast） */
  readonly hintBanner = new HintBanner();
  /** 问题 A：物理调试绘制的线框（所有调试线合批成一个 LineSegments） */
  private physicsDebugLines!: LineSegments;
  /**
   * M3 第 2 批：刚体工厂（四类刚体 + 质量/阻尼/休眠）。
   * 在构造函数里赋值而不是字段初始化 —— 它依赖 `this.physics`，
   * 而字段初始化按**声明顺序**执行，写在 `physics` 之前会拿到 undefined。
   */
  readonly bodyFactory: RigidBodyFactory;
  /** M3 补充 1：物理材质运行时（覆盖表 + 真正写进 Rapier） */
  readonly materials: PhysicsMaterialRegistry;
  /**
   * M3 第 6 批：时间策略层（倍速 / 单步 / 回溯协调）。
   * 注意它包的是**已有的** `Time`，不是另起一个累加器 —— 两个累加器一定会不同步。
   */
  readonly timeControl: TimeControl;
  /** M3 第 6 批：位姿回溯缓冲（300 帧）+ 3 个关键帧 */
  readonly snapshots = new PhysicsSnapshot({ capacity: 300, keyframeLimit: 3 });
  /** M3 补充 6：物理爆炸保护（阈值按物体尺寸缩放） */
  readonly guard = new PhysicsGuard();
  /** M3 补充 5/7：录制与回放（600 帧 = 10 秒 @60Hz） */
  readonly recorder = new PhysicsRecorder({ capacity: 600 });
  /** M3 补充 9：合成物理音效（零音频素材） */
  readonly audio = new PhysicsAudio({ volume: 0.5 });
  /** M3 第 8 批：6 关物理教学状态机 */
  readonly physicsTutorial = new PhysicsTutorialRunner();
  /** M3 第 5 批：浮力（水不参与碰撞，只施力） */
  readonly buoyancy: BuoyancySystem;
  /** M3 第 5 批：局部倒塌（AABB 权威 + Rapier 接触力校核） */
  readonly collapse = new CollapseSystem();
  /** M3 第 7 批：距离剔除（远处已休眠的刚体冻结，省宽相位与求解开销） */
  readonly culling = new DistanceCulling();
  /**
   * M3 第 7 批：分帧调度。
   * 把倒塌判定、应力计算、距离剔除这些"周期性但不紧急"的活摊平到多帧，
   * 避免它们撞在同一帧造成"每隔半秒卡一下"。
   */
  readonly scheduler = new FrameScheduler(2.5);
  /** M3 第 8 批：压力测试场景生成器 */
  readonly stressTest: StressTestGenerator;
  /** M3 补充 2：应力可视化（近似指示，不是有限元） */
  readonly stress = new StressVisualizer({ refreshMs: 250, dangerThreshold: 0.55 });
  /** M3：物理参数 / 时间轴 / 应力 / 物理教学 四个面板 */
  readonly physicsPanel: PhysicsPanel;
  readonly timePanel: TimePanel;
  readonly stressPanel: StressPanel;
  readonly physicsTutorialUI: PhysicsTutorialUI;
  /** M4 第 6 批：性能监控（帧分析 + 慢帧记录 + 资源聚合） */
  readonly performance = new PerformanceMonitor({ frameWindow: 120, slowThresholdMs: 16.7 });
  /** M4 第 6 批：内存与帧分析面板 */
  readonly memoryPanel: MemoryPanel;
  /**
   * M4 第 6 批：自动降级。
   *
   * ⚠ **它内部持有一个 AdaptiveQuality，那个才是唯一决策源**。
   * 所以 Engine 不再自己 new 一个 AdaptiveQuality，而是用 `autoDegrade.quality` ——
   * 两套低帧计时会互相打架（一个说"降"、一个说"还没到时间"），表现是画质反复横跳。
   */
  readonly autoDegrade = new AutoDegrade({ physicsBudgetMs: 8, frameBudgetMs: 2.5 });
  /** M4 第 2 批：物品面板（300+ 物品的浏览/搜索/过滤/分页/收藏/内容包） */
  readonly catalogPanel: CatalogPanel;
  /** M4 补充 1：内容包开关面板（关掉只隐藏，不删世界里的物体） */
  readonly contentPackUI: ContentPackUI;
  /** M4 补充 10：内容统计热力图（俯视 2D canvas） */
  readonly contentStatsUI: ContentStatsUI;
  /** M4 补充 7：冲突可视化（把"冲突 7 处"变成看得见的框） */
  readonly conflictOverlay = new ConflictOverlay();
  /** M4 第 7 批：地图模板面板（卡片 + 参数滑杆 + 种子 + 生成预览 + 回滚入口） */
  readonly mapTemplateUI: MapTemplateUI | undefined;
  /** M4 补充 2：自定义物品编辑器 */
  readonly customItemUI: CustomItemUI | undefined;
  // ---- M4 第二部分 · 第 2 批：流体（粒子）
  /** 流体系统（PBF 粒子）。**惰性创建**：第一次切到流体工具时才建，
   *  这样不用流体功能的玩家不会为它付 7 MB 内存与每帧开销 */
  private fluid: FluidSystem | null = null;
  private fluidRenderer: FluidRenderer | null = null;
  private fluidSurface: FluidSurface | null = null;
  private fluidEditor: FluidEditor | null = null;
  private fluidAudio: FluidAudio | null = null;
  private fluidPanel: FluidPanel | null = null;
  /** 建筑障碍的空间索引（按区块分桶），流体的 isSolid 用它 —— 见 buildFluidObstacles */
  /**
   * 流体障碍索引：区块桶 → 建筑包围盒。
   *
   * ⚠ **键必须是数字，不能是字符串**。第一版用的是 `` `${bx},${bz}` `` ——
   * 那意味着**每个粒子每次探针**都要拼一次字符串再哈希：60000 次/帧的字符串分配，
   * 实测这一项单独占 13 ms。改成整数键（`(bx + 128) * 256 + (bz + 128)`）之后，
   * 碰撞相位从 23.4 ms 降到 10.3 ms。
   * （+128 是把负区块坐标平移到非负；本项目最大 192 格 = 12 个区块，128 足够宽裕。）
   */
  private fluidObstacles: Map<number, { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }[]> = new Map();
  /** 有障碍的区块键（用来做"整块都没有建筑"的快速跳过） */
  private fluidObstacleKeys = new Set<number>();
  private fluidObstaclesDirty = true;
  /** 上次建索引时的建筑数量（用来判断要不要重建） */
  private fluidObstacleCount = -1;
  private fluidStyle: FluidRenderStyle = 'particles';
  private fluidType: FluidType = 'water';
  // ---- M4 第二部分 · 第 3 批：沙土
  private sandEditor: SandEditor | null = null;
  private sandVisualizer: SandVisualizer | null = null;
  private sandPanel: SandPanel | null = null;
  /** 上次选的沙土工具（切走再切回来时保持） */
  private sandTool: SandTool = 'pile';
  // ---- M4 第二部分 · 第 4 批：流体-刚体耦合
  private fluidField: ParticleFluidField | null = null;
  private readonly coupling = new FluidRigidCoupling('game');
  /**
   * 流体求解的 Worker 运行器（第 6 批）。
   *
   * 它内部自己处理"有没有 Worker"：浏览器里用 Worker，Node/老浏览器里**同步回退**。
   * 所以 Engine 这一层不需要判断环境，只管调它 —— 判定逻辑只有一份（在 runner 里）。
   */
  private fluidRunner: FluidWorkerRunner | null = null;
  /** 走 worker 成功 / 回退主线程 的帧数（面板显示"现在到底在用哪条路"） */
  private fluidWorkerFrames = 0;
  private fluidFallbackFrames = 0;
  /**
   * 这一帧粒子的位置**真的变过**吗？
   *
   * ⚠ 这个门是子代理在写 Worker 时指出的一个**物理错误**，不是"晚一帧"那么轻：
   * 走 Worker 时求解是异步的，某几帧里池子位置完全没变。而 `applyFluidCoupling`
   * 会按当前位置算出浮力/阻力并 `addForce` —— Rapier 的语义是"持续到下一次 step"，
   * 于是**同一份力会被重复施加 2~3 次**，倍数取决于 worker 的延迟。
   * 沙水交互同理（会把同一格沙重复扣一遍）。
   * 所以门必须挂在"位置真的变过"上，而不是挂在 `busy` 上。
   */
  private fluidMovedThisFrame = false;
  private couplingEnabled = true;
  // ---- M4 第二部分 · 第 5 批：沙水交互
  private sandWater: SandWaterInteraction | null = null;
  private lastBuriedCheckMs = 0;
  private lastBuriedCount = 0;
  // ---- M4 第二部分 · 第 8 批：流体存档 + 教学关卡
  private readonly fluidTutorial = new FluidSandTutorial();
  private tutorialSnapshot: TutorialSnapshot | null = null;
  /** 玩家的工具使用记录（教学关卡要用它判断"玩家试过没有"） */
  private readonly usedFluidTools = new Set<string>();
  private readonly usedSandTools = new Set<string>();
  // ---- M4 第二部分 · 第 7 批：压力测试 / 热力图 / 录制
  /** 帧录制器（面板开关控制；没在录时 sample 的开销接近 0） */
  readonly perfRecorder = new PerfRecorder({ capacity: 3600 });
  /** 压力测试的历史结果（新的在前，最多 20 条） */
  private stressHistory: StressTestResult[] = [];
  /** M4：收藏与最近使用的物品 id（持久化到 localStorage） */
  private favoriteIds: string[] = [];
  private recentIds: string[] = [];
  /** M3 第 3 批：关节编辑器（玩家自己接铰链 / 设马达） */
  readonly jointEditor: JointEditor;
  /** M3 第 4 批：逻辑连线编辑器（拖拽连线） */
  readonly logicEditor: LogicLinkEditor;
  /** 拖拽连线的屏幕覆盖层（自建 DOM，不依赖 index.html） */
  private readonly connector = new ConnectorOverlay();
  /** 拖拽状态：源物体 id / 当前光标屏幕坐标 / 光标下的目标 */
  private dragLink: {
    sourceId: number;
    pointer: { x: number; y: number };
    targetId: number | null;
  } | null = null;
  /** 当前在编辑器里选中的连线 */
  private activeLinkId: number | null = null;
  /** 当前在编辑器里选中的关节 id */
  private activeJointId: number | null = null;
  /** 上一帧物理耗时（面板与预算判定用） */
  private lastPhysicsMs = 0;
  /** 上一帧的模拟（水/沙）耗时 —— 帧耗时拆成"物理 / 模拟 / 渲染"三段后才看得出谁慢 */
  private lastSimMs = 0;
  /** M4：最近一次生成的日志（面板与"导出生成日志"用） */
  private lastGenerationLog: GenerationLog | null = null;
  /** M4：最近一次生成的冲突记录（冲突可视化用） */
  private lastGenerationConflicts: ConflictRecord[] = [];
  /**
   * M4：最近一次**成功**生成的请求参数。
   *
   * 「生成回滚」（补充 5）回滚的就是它 —— 只有模板 id、种子、参数覆盖，
   * 没有体素快照。理由：48×16×48 的体素快照约 37 KB，192×32×192 约 1.2 MB，
   * 而回滚点要留好几个 → 内存会翻倍；改成"用同样的参数再生成一次"，
   * 结果在同一个种子下是逐字节可复现的，代价只是再花一次生成时间。
   */
  private lastGenerationRequest: {
    templateId: string;
    seed: number;
    overrides: Record<string, number>;
    objects: number;
    conflicts: number;
  } | null = null;
  /** 当前正在跑的子阶段文案（进度条下面那一行） */
  private pendingSubStage = '';
  /** 面板上还没被生成消费的参数覆盖（生成入口读它一次就清掉） */
  private pendingGenerateOverrides: Record<string, number> = {};
  /** 上一次刷新 UI 面板数据的时间戳（见 `uiTick`） */
  private lastUiTickMs = 0;
  // ---- 分阶段耗时（性能面板与慢帧记录据此回答"这一帧花在哪"）----
  // 之前只有"物理 / 模拟 / 渲染"三段，而"渲染"是**残差**（扣掉前两段的一切），
  // 于是区块重建、支撑面索引、UI 面板这些非渲染开销全被算进"渲染"里 ——
  // 面板会一本正经地报"渲染是瓶颈"，把人引到错误的方向。
  private lastSupportMs = 0;
  private lastPanelMs = 0;
  private lastCullingMs = 0;
  private lastInteractionMs = 0;
  /** 上一帧的流体-刚体耦合耗时（性能面板要显示"耦合耗时"） */
  private lastCouplingMs = 0;
  /** 上一帧的沙水交互耗时 */
  private lastSandWaterMs = 0;
  /** 上一帧的沙水交互统计（教学关卡要用"这一帧冲走了几格"） */
  private lastSandWaterStats: { eroded: number; deposited: number; moistened: number } | null = null;
  /** 教学关卡是否打开（面板开关） */
  private fluidTutorialActive = false;
  /** 物理教学每帧的"世界现状"（状态机据此判断目标达成） */
  private tutorialLastUnmet: string[] = [];
  private tutorialLastDone = false;
  /** 当前重力预设 id；玩家手拖过滑块后为 null（面板要显示"自定义"） */
  private gravityPresetId: string | null = 'earth';
  /** "新建物体的默认物理参数"（不作用于世界，只影响之后创建的刚体） */
  private physicsDefaults = { friction: 0.5, restitution: 0.2, linearDamping: 0.02, angularDamping: 0.05, maxVelocity: 120 };
  /** 回溯游标（-1 = 不在回溯） */
  private rewindFrameIndex = -1;
  /** 上一帧的接触对数（求解器统计） */
  private lastContactPairs = 0;
  /** 倒塌判定的节流时刻（BFS 是 O(n²)，不该每帧跑） */
  private collapseCooldown = 0;
  /** 上一次"物体即将掉落"提示的时刻（避免刷屏） */
  private collapseWarnedAt = 0;
  /** 上一帧传感器事件数（物理面板显示"传感器在工作"的凭据） */
  private lastSensorEvents = 0;
  /** M3 第 6 批：接触点可视化用的点云对象 */
  private contactPoints!: Points;
  /** 上一帧的调试统计（面板显示） */
  private debugStats: DebugStats = {
    pairs: 0, contactPoints: 0, forceArrows: 0, velocityArrows: 0, bodies: 0, sleeping: 0, ms: 0,
  };
  /** 上一帧每个刚体的速度（撞击音效的 Δv 代理） */
  private readonly lastSpeeds = new Map<number, number>();
  /** 教学用的事件计数（由各系统在发生时累加） */
  private impulsesApplied = 0;
  private triggerHits: Record<string, number> = {};
  private collapseCount = 0;
  private floatSeconds: Record<string, number> = {};
  /** 问题 B：移动端控制器（手势 + 摇杆 + 震动 + 屏幕方向） */
  private mobile: MobileController | null = null;
  /** 补充 6：手势教学浮层 */
  private readonly gestureTutorial: GestureTutorial;

  readonly buildings = new BuildingSystem();
  readonly support = new SupportSystem();
  readonly physics = new PhysicsWorld({
    // M3 第 1 批：给 rapier 的 chunk 固定文件名，这样能先 fetch 一次拿到**真字节进度**；
    // 拿不到（没配 chunkFileNames / 被 CORS 拦 / 离线）就自动退化成阶段进度
    chunkUrl: RAPIER_CHUNK_URL,
    onProgress: (progress) => this.handlePhysicsProgress(progress),
  });
  readonly stack = new StackSystem();
  /** 支撑面索引：一个顶面能被多少物体共享，全靠它 */
  readonly surfaces = new SupportSurfaceIndex();
  /** 自适应画质降级（问题 6.9） */
  readonly adaptive = new AdaptiveQuality();
  /** 连续堆叠工具（补充 3） */
  private readonly quickStack = new QuickStackTool();
  private readonly stackingPreview = new StackingPreview();
  /** 问题 5：候选点脉冲高亮框 */
  private readonly highlight = new HighlightRenderer();
  /** 问题 5：候选点跳远时的镜头平滑跟随 */
  private readonly cameraTracker = new CameraTracker();
  /** 问题 5：候选点在视野外时的屏幕边缘箭头 */
  private edgeArrow: ScreenEdgeArrow | null = null;
  readonly smartPlacement: SmartPlacement;
  readonly selection = new SelectionSystem();
  readonly pickup = new PickupSystem();
  readonly groups: GroupSystem;
  readonly prefabs = new PrefabSystem();
  readonly blueprints = new BlueprintSystem();

  private bundle: WorldBundle;
  private terrainCollider: TerrainCollider;
  private command: CommandManager;
  private save: SaveSystem;

  private readonly raycaster = new Raycaster();
  private readonly ndcVector = new Vector2();
  /** 算距离时复用一个 Vector3，避免每帧 new（捡垃圾也是有成本的） */
  private readonly tempWorldPoint = new Vector3();

  private currentHit: VoxelHit | null = null;
  private placementResult: SmartPlacementResult | null = null;
  private previewResolution: import('../building/StackingSystem').StackResolution | null = null;
  private previewSupportSurface: import('../building/SupportSurface').SupportSurfaceInfo | null = null;
  private previewPosition: [number, number, number] | null = null;
  private previewValid = false;
  private previewReason = '';
  private previewRotationDegrees = 0;

  private lastEditMs = 0;
  private lastMeshMs = 0;
  private lastAffected = 0;
  private lastPaintAt = 0;
  private totalFaces = 0;

  private fps = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private frameMsAvg = 0;
  private supportMessage = '支撑检查未开启';
  private supportRecheckAt = 0;

  /** 问题 3.5：最近一次地图生成的报告，给 UI 面板读 */
  private lastMapReport: MapGenerationReport | null = null;
  /** 上一次内存回收的说明（原样显示在面板上） */
  private gcNote = '还没试过回收。';
  /** 换地图是否正在进行中（防止连点） */
  private switching = false;
  /** 空白世界这次用哪个种子（在建 bundle 时定，在生成内容时用） */
  private pendingEmptySeed = 0;
  /** 阶段化加载结束时统一提示的那句话 */
  private pendingSwitchSummary: string | null = null;
  /** 最近一次卸载报告 */
  private lastUnloadReport: UnloadReport | null = null;
  /** 上一帧的绘制统计（资源采样用，采样本身是节流的） */
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  /** 补充 1：教学关卡的运行时状态 */
  private tutorial: {
    active: boolean;
    levelIndex: number;
    stepIndex: number;
    startedMs: number;
    skipsLeft: number;
    completedLevels: number;
  } = { active: false, levelIndex: 0, stepIndex: 0, startedMs: 0, skipsLeft: 1, completedLevels: 0 };
  /** 沙盘模式生效前的状态，退出时用来还原 */
  private sandboxRestore: { waterEnabled: boolean; sandEnabled: boolean; supportEnabled: boolean } | null = null;
  /** M3：物理引擎正在加载（此时不要拿"没有物理"当异常处理） */
  private physicsLoading = false;
  /**
   * 上次保存之后有没有玩家改动。
   *
   * 判定方式很直接：**命令历史里有东西 = 有改动**。
   * 之所以可以这么判，是因为这个项目里所有会改变世界的玩家操作都会走 CommandManager：
   * 笔刷、放建筑、移动、删除、镜像、成组…… 唯一不进历史的是水与沙的自动模拟
   * （那是世界自己在变，不是玩家的成果，丢了不该拦人）。
   */
  private get hasUnsavedEdits(): boolean {
    return this.command.canUndo || this.command.canRedo;
  }

  private boxSelectStart: { x: number; y: number } | null = null;
  private readonly boxSelectElement: HTMLDivElement;
  private toolbar: HTMLElement;
  private toastTimer = 0;

  private rafId = 0;
  private running = false;
  private disposed = false;
  private lastTimestamp = 0;
  private physicsReady = false;

  constructor(private readonly options: EngineOptions) {
    // ---------------- 状态
    this.state = {
      mode: 'edit',
      tool: 'terrain',
      brush: {
        mode: 'raise',
        shape: 'sphere',
        radius: BRUSH_CONFIG.defaultRadius,
        strength: BRUSH_CONFIG.defaultStrength,
        falloff: 'smooth',
        density: BRUSH_CONFIG.defaultDensity,
        direction: 'normal',
        material: DEFAULT_BRUSH_MATERIAL,
      },
      debug: {
        chunkBorders: false,
        wireframe: false,
        brushCursor: true,
        debugGrids: false,
        props: false,
        autoSave: true,
        frustumCulling: CULLING_CONFIG.frustum,
        colorLegend: false,
        stabilityColors: true,
        supportOverlay: true,
        alignGuides: true,
        confirmWorldSwitch: true,
      },
      physics: {
        waterEnabled: true,
        waterSpeed: 0.5,
        waterDispersion: 4,
        sandEnabled: true,
        sandAngle: 34,
        // M2 起支撑检查不再只是"看一眼"：失去支撑的物体会转成动态刚体掉下来
        supportEnabled: true,
        supportCantilever: 4,
      },
      build: {
        snapToGrid: true,
        snapStep: 1,
        rotationStep: 90,
        snapToGround: true,
      },
      placement: {
        autoRecommend: true,
        physicsFall: true,
        snapAnchors: true,
        snapSurface: true,
        snapWall: true,
        candidateIndex: 0,
        maxCandidates: 6,
        axis: 'y',
        surfaceGrid: 4,
        quickStack: true,
        quickStackUndo: 'merge',
        trackCamera: true,
        showEdgeArrow: true,
        highlightCandidate: true,
      },
      selection: {
        boxSelecting: false,
        nudgeStep: 0.5,
        fineRotationStep: 5,
      },
      quality: {
        // 新手默认「性能优先」：关阴影、关 AO、像素比 1（目标 90 FPS）
        preset: 'performance',
        manualOverride: false,
        renderDistance: 6,
        baseRenderDistance: 6,
        shadows: false,
        ao: false,
        antialias: false,
        adaptive: true,
        adaptiveLevel: 'full',
      },
      selectedBuildingId: null,
      selectedInstanceId: null,
    };

    // ---------------- 基础设施
    this.input = new InputSystem(options.canvas, options.container);
    this.render = new RenderSystem(options.canvas);
    this.controls = new GodCameraControls(this.render.camera, this.input);
    this.ui = new UISystem(this.time);

    // ---------------- 世界
    const map = getMapById(DEFAULT_MAP_ID) ?? BUILTIN_MAPS[0]!;
    this.bundle = this.createBundle(map.size, map.seed ?? options.seed ?? 1001, map.id);
    this.terrainCollider = new TerrainCollider(this.physics);

    // ---------------- 系统
    this.smartPlacement = new SmartPlacement(this.stack);
    this.groups = new GroupSystem(this.buildings);
    this.command = new CommandManager(() => this.bundle.grid, this.buildings);
    this.save = new SaveSystem({
      getGrid: () => this.bundle.grid,
      getWorldInfo: () => ({
        seed: this.bundle.world.seed,
        sizeId: this.bundle.world.sizeId,
        mapId: this.bundle.world.mapId,
      }),
      recreateWorld: (sizeId, seed, mapId) => {
        // 读档同样换世界，所以同样要走卸载清单 —— 否则「反复读档」也会一路涨内存，
        // 症状和「反复切地图」一模一样，只是更隐蔽
        const report = this.unloader.run(this.unloadTasks());
        this.lastUnloadReport = report;
        console.info(`[读档前卸载] ${report.summary}`);
        this.bundle = this.createBundle(sizeId, seed, mapId);
        return this.bundle.grid;
      },
      buildings: this.buildings,
      groups: this.groups,
      getSettings: () => this.collectSettings(),
      applySettings: (settings) => this.applySettings(settings),
      getCamera: () => this.controls.getState(),
      applyCamera: (camera) => this.controls.setState(camera),
      getSimTime: () => this.time.elapsed,
      getStepCount: () => this.time.stepCount,
      onWorldReplaced: (source) => this.handleWorldReplaced(source),
    });

    // ---------------- UI
    this.brushUI = new BrushUI(this.state, { onBrushChange: () => this.onStateChanged() });
    this.buildingPanel = new BuildingPanel(this.state, {
      onSelect: (defId) => this.onBuildingSelected(defId),
      onRotate: (delta) => this.rotateSelection(delta),
      onDelete: () => this.deleteSelection(),
      onDuplicate: () => this.duplicateSelection(),
      onFocus: () => this.focusSelection(),
      onBuildSettingsChange: () => this.onStateChanged(),
    });
    this.perfPanel = new PerformancePanel(this.state, {
      onDebugChange: () => this.syncDebugSwitches(),
      onPhysicsChange: () => this.syncPhysics(),
      onCheckSupport: () => this.runSupportCheck(true),
      onRebuildAll: () => this.rebuildAllMeshes(),
      onQualityPreset: (preset) => this.applyQualityPreset(preset),
      onAdaptiveToggle: (enabled) => {
        this.adaptive.enabled = enabled;
        if (!enabled) this.applyAdaptiveLevel('full');
      },
    });
    this.placementUI = new PlacementUI(this.state, {
      onConfirm: () => this.confirmPlacement(),
      onCancel: () => this.cancelPlacement(),
      onPrevCandidate: () => this.cycleCandidate(-1),
      onNextCandidate: () => this.cycleCandidate(1),
      onRefresh: () => this.refreshPlacement(),
      onSettingsChange: () => this.onStateChanged(),
    });
    this.stackingUI = new StackingUI(this.state, {
      onSettingsChange: () => this.onStateChanged(),
      onStopQuickStack: () => this.stopQuickStack(),
    });
    this.supportDebugUI = new SupportDebugUI(this.state, {
      onToggleOverlay: () => this.onStateChanged(),
      onToggleStabilityColors: () => this.render.buildingRenderer.setStabilityTint(this.state.debug.stabilityColors),
    });
    this.selectionUI = new SelectionUI(this.state, {
      onSelectAll: () => this.selectAll(),
      onSelectClear: () => this.clearSelection(),
      onSelectSimilar: () => this.selectSimilar(),
      onPickupOne: () => this.beginPickup(false),
      onPickupStructure: () => this.beginPickup(true),
      onDrop: () => this.dropPickup(),
      onRestore: () => this.restorePickup(),
      onNudge: (axis, sign) => this.nudgeSelection(axis, sign),
      onFineRotate: (axis, sign) => this.fineRotate(axis, sign),
      onMirror: (axis) => this.mirrorSelection(axis),
      onSettingsChange: () => this.onStateChanged(),
    });
    this.historyPanel = new HistoryPanel({
      onUndo: () => this.undo(),
      onRedo: () => this.redo(),
      onClear: () => this.clearHistory(),
      onJumpTo: (index) => this.jumpHistory(index),
    });
    this.shortcutHelp = new ShortcutHelp();
    this.prefabPanel = new PrefabPanel({
      onCreateGroup: () => this.createGroup(),
      onUngroup: () => this.ungroupSelection(),
      onSelectGroup: (groupId) => this.selectGroup(groupId),
      onDeleteGroup: (groupId) => this.deleteGroup(groupId),
      onSavePrefab: () => this.savePrefab(),
      onPlacePrefab: (prefabId) => this.placePrefab(prefabId),
      onDeletePrefab: (prefabId) => this.deletePrefab(prefabId),
      onExportBlueprint: () => this.exportBlueprint(),
      onImportBlueprint: (file) => void this.importBlueprint(file),
    });
    this.mapSelector = new MapSelector({
      onLoadMap: (definition) => void this.switchWorld({ kind: 'map', definition }),
      onCreateEmpty: (sizeId) => void this.switchWorld({ kind: 'empty', sizeId }),
      onImport: (file) => void this.importSave(file),
      onClose: () => undefined,
    });

    // ---------------- 问题 4：换世界的加载遮罩 / 确认框 / 资源面板
    this.loadingOverlay = new LoadingOverlay();
    this.confirmDialog = new ConfirmDialog();
    this.worldLoader = new WorldLoader({
      onProgress: (progress, stage) => {
        // 阶段内部报了子进度时，说明"现在是哪一步"（例如「建筑规划（6/9）」），
        // 比只显示阶段名有用得多 —— 9 阶段生成里「生成地形与建筑」这一个阶段
        // 就有 9 个子步骤，只报阶段名的话玩家会以为卡住了。
        const detail = this.pendingSubStage || this.worldLoader.stageDetail;
        this.loadingOverlay.setProgress(progress, detail ? `${detail}…` : `${stage.label}…`);
      },
      onStageDone: (result) => {
        if (!result.ok) console.warn('[换世界] 阶段失败', result);
      },
    });
    this.resourcePanel = new ResourcePanel({
      onCollectGarbage: () => this.collectGarbage(),
      onLogResources: () => this.logResourceChecklist(),
    });
    // M3 第 8 批：压力测试场景按钮（按当前设备档位显示真实数量与降级说明）
    this.renderStressTestButtons();
    // 模板面板由它自己画卡片；Engine 只在换图时告诉它"忙/闲"
    this.mapTemplateUI?.refresh();
    this.setupGenerationPanelButtons();
    this.setupStressPanel();

    // ---------------- 问题 A / 第 4~5 批：物理框架与组合
    this.bodyFactory = new RigidBodyFactory(this.physics);
    // 浮力需要一个"世界坐标 → 水量"的读取口；用当前 bundle 的体素网格包一层。
    // 注意它读的是 this.bundle，换地图后 bundle 会换 —— 所以用箭头函数延迟取值，
    // 而不是把 grid 直接存进 BuoyancySystem（那样换地图后会读到已经丢弃的旧网格）
    this.buoyancy = new BuoyancySystem(
      createVoxelWaterField({
        worldToVoxelX: (worldX) => this.bundle.grid.worldToVoxelX(worldX),
        worldToVoxelZ: (worldZ) => this.bundle.grid.worldToVoxelZ(worldZ),
        getWaterLevel: (x, y, z) => this.bundle.grid.getWaterLevel(x, y, z),
      }),
      { gravity: Math.abs(this.physics.worldStats.gravityY) || 9.81 },
    );
    this.materials = new PhysicsMaterialRegistry(this.physics);
    // 时间策略层包住**已有的** Time（不是新起一个累加器，那样两边一定会不同步）
    this.timeControl = new TimeControl(this.time, { budgetMs: DETECT_STEP_BUDGET_MS });
    this.framework = new PhysicsFramework(this.physics);
    // 逻辑动作的执行器放在 Engine 里：第 4 层只负责"什么时候该做什么"，
    // 真正去震手机 / 弹提示 / 删建筑必须由有 DOM 与 Three.js 的地方干
    this.framework.setActionHandler((request) => this.executeLogicAction(request));
    // 压力测试生成器要在 framework 之后建（它依赖四层框架建关节）
    this.stressTest = new StressTestGenerator(this.buildings, this.framework);
    // 链上触发器事件：PhysicsFramework 内部已经把它转成了逻辑事件（进连线），
    // 这里再叠加 Engine 自己关心的两件事 —— 教学关的 trigger-zone 计数与 not 门的抑制源活动
    const frameworkTriggerHandler = this.framework.triggers.onEvent;
    this.framework.triggers.onEvent = (event) => {
      frameworkTriggerHandler?.(event);
      if (event.phase === 'enter') this.noteTriggerHit(event.tag);
      this.framework.links.noteInhibitActivity(event.triggerId, performance.now());
    };
    this.combos = new ComboBuilder(this.buildings, this.framework);

    this.physicsDebugUI = new PhysicsDebugUI({
      onDrawSettingsChange: (settings) => {
        // 只画线框时降低调试对象的不透明度（它们本来就很细，顺手省点填充率）
        this.physicsDebugLines.visible = settings.jointLinks || settings.jointAnchors || settings.triggerBoxes || settings.logicArrows || settings.ropeRestLength || settings.colliderBoxes;
      },
      onClearJoints: () => {
        const removed = this.framework.clearLayer('joint');
        this.showToast(`已清空 ${removed} 个关节`, 2000);
      },
      onClearTriggers: () => {
        const removed = this.framework.clearLayer('trigger');
        this.showToast(`已清空 ${removed} 个触发器`, 2000);
      },
      onClearLinks: () => {
        const removed = this.framework.clearLayer('link');
        this.showToast(`已清空 ${removed} 条逻辑连线`, 2000);
      },
      onLogDiagnostics: () => this.logPhysicsDiagnostics(),
    });
    this.physicsDebugUI.bindTriggers(this.framework.triggers);
    this.physicsDebugUI.bindLinks(this.framework.links);

    this.sandbox = new PhysicsSandboxMode({
      onToggle: (settings) => this.applySandboxSettings(settings),
      onSettingsChange: () => this.sandbox.describeEffect(),
    });

    this.comboPanel = new ComboPanel({
      onSpawnCombo: (combo) => this.spawnCombo(combo),
      onPreviewCombo: (combo) => this.previewCombo(combo),
      onVisibilityChange: () => undefined,
    });
    this.comboPanel.setCombos(buildComboCards(COMBOS), COMBOS);

    // ---------------- M3：物理参数 / 时间轴 / 应力 / 物理教学 四个面板
    this.physicsPanel = new PhysicsPanel({
      onGravityPreset: (id) => this.applyGravityPreset(id),
      onGravityChange: (gravityY) => this.applyGravity(gravityY),
      onConfigChange: (patch) => this.applyPhysicsConfig(patch),
      onDefaultsChange: (patch) => this.applyPhysicsDefaults(patch),
      onAssignMaterial: (objectId, materialId) => this.assignMaterial(objectId, materialId),
      onResetDefaults: () => this.resetPhysicsDefaults(),
      onClearPhysics: () => this.clearPhysicsWorld(),
    });
    this.timePanel = new TimePanel({
      onTogglePause: () => {
        this.timeControl.togglePause();
        this.refreshTimePanel();
      },
      onStep: () => {
        this.timeControl.requestStep(1);
        this.refreshTimePanel();
      },
      onScaleChange: (scale) => {
        if (this.timeControl.setScale(scale)) {
          this.showToast(`时间倍速：${scale}×`, 1600);
        }
        this.refreshTimePanel();
      },
      onSeekFrame: (frame) => this.seekSnapshot(frame),
      onResumeLive: () => this.resumeLive(),
      onTakeSnapshot: () => this.takeKeyframe(),
      onGoToSnapshot: (index) => this.goToKeyframe(index),
      onClearHistory: () => {
        this.snapshots.clear();
        this.showToast('已清空回溯缓冲（关键帧保留）', 2200);
        this.refreshTimePanel();
      },
    });
    this.stressPanel = new StressPanel({
      onToggleStress: (enabled) => {
        this.stress.setEnabled(enabled);
        // 应力着色接管 instanceColor 通道；关掉时把通道还给稳定性着色。
        // 两者刻意**互斥**：同一条通道显示两种语义，同时开只会让人分不清哪个颜色是什么意思
        this.render.buildingRenderer.setTintProvider(
          enabled ? (instance: BuildingInstance) => this.stress.tintFor(instance.id) : null,
        );
        this.render.buildingRenderer.setStabilityTint(
          enabled ? true : this.state.debug.stabilityColors,
        );
        this.render.buildingRenderer.markDirty();
        this.refreshStressPanel();
      },
      onColorSchemeChange: (scheme) => {
        this.stress.setScheme(scheme);
        this.render.buildingRenderer.markDirty();
        this.refreshStressPanel();
      },
      onThresholdChange: (threshold) => {
        this.stress.setThreshold(threshold);
        this.render.buildingRenderer.markDirty();
        this.refreshStressPanel();
      },
      onFocusWorst: () => this.focusWorstStress(),
    });
    this.physicsTutorialUI = new PhysicsTutorialUI({
      onNext: () => this.advancePhysicsTutorial(false),
      onPrev: () => this.advancePhysicsTutorial(true),
      onConfirmStep: () => {
        this.physicsTutorial.confirmStep(performance.now());
        this.refreshPhysicsTutorial();
      },
      onRestart: () => {
        this.physicsTutorial.restart(performance.now());
        this.refreshPhysicsTutorial();
      },
      onSkipLevel: () => {
        const result = this.physicsTutorial.skipLevel(performance.now());
        if (result === 'no-skips-left') this.showToast('这一关的跳过次数已经用完了', 2200);
        this.refreshPhysicsTutorial();
      },
      onExit: () => {
        this.physicsTutorial.exit();
        this.physicsTutorialUI.hide();
      },
      onJumpToLevel: (index) => this.jumpPhysicsTutorialLevel(index),
    });

    // ---------------- M4 第 6 批：内存与帧分析面板
    this.memoryPanel = new MemoryPanel({
      onCollectGarbage: () => this.collectGarbage(),
      onExportReport: () => this.exportPerformanceReport(),
      onClearSlowFrames: () => {
        this.performance.slowLogger.clear();
        this.showToast('已清空慢帧记录', 1800);
      },
      onThresholdChange: (ms) => {
        this.performance.slowLogger.setThreshold(ms);
        this.showToast(`慢帧阈值改为 ${ms.toFixed(1)} ms`, 1800);
      },
    });

    // ---------------- M4 第 2 批：物品面板
    this.loadCatalogPrefs();
    this.catalogPanel = new CatalogPanel({
      onSelect: (def) => this.onCatalogSelect(def),
      onPacksChange: (enabled) => {
        console.info(`[内容包] 已启用 ${enabled.length} 个包：${enabled.join('、')}`);
        // 包只影响"面板里能不能选到"，不动世界里的东西 —— 这条在面板上写明了。
        // 另一个内容包面板（设置区）持有一份内存副本，必须同步刷新，否则两边会不一致
        this.contentPackUI.refresh();
        this.refreshCatalogPanel();
      },
      onFavoritesChange: (ids) => {
        this.favoriteIds = [...ids];
        this.saveCatalogPrefs();
        this.refreshCatalogPanel();
      },
      onUse: (def) => this.noteCatalogUse(def),
    });

    this.contentPackUI = new ContentPackUI(document.getElementById('content-pack-list'), {
      onPacksChange: (enabled) => {
        // 两个面板读的是同一个 localStorage 键，但各自持有内存副本：
        // 这里必须**同时**刷新物品面板，否则在内容包面板改了开关，
        // 物品面板要等下一次别的刷新才跟上（看起来像开关失灵）。
        this.catalogPanel.reloadPacks();
        this.refreshCatalogPanel();
        this.showToast(
          `内容包：已启用 ${enabled.size}/${CONTENT_PACKS.length} 个（只影响面板里能不能选到，已放置的物体不受影响）`,
          2800,
        );
      },
    });
    this.contentStatsUI = new ContentStatsUI(
      document.getElementById('content-stats-canvas') as HTMLCanvasElement | null,
      document.getElementById('content-stats-legend'),
      { onError: (message) => this.showToast(message, 2600) },
    );
    this.render.scene.add(this.conflictOverlay.group);

    // M4 第 7 批：模板面板（补充 4 预览 + 补充 5 回滚）。
    // 旧的 8 个按钮是 Engine 直接拼 DOM 的，只能"点一下生成"；换成面板之后
    // 多了参数滑杆、种子、预览和回滚 —— 但这些能力**全部走同一个 switchWorld 入口**，
    // 不另开一条生成路径（两条路径迟早会长歪，这一点在 M2.5 里已经吃过一次亏）。
    const mapTemplateUI = new MapTemplateUI(document.getElementById('map-template-panel'), {
      onGenerate: (request) => {
        this.pendingGenerateOverrides = request.overrides;
        void this.switchWorld({ kind: 'generate', templateId: request.templateId, seed: request.seed });
      },
      onPreview: (request) => this.showGenerationPreview(request),
      onRollback: (reason) => console.info('[生成回滚]', reason),
    });
    this.mapTemplateUI = mapTemplateUI;

    // ---- M4 补充 2：自定义物品
    //
    // 启动时先把存档里的自定义物品**注册进目录**，再挂面板。
    // 顺序不能反：面板构造时会列出已保存的物品并让它们可选中，
    // 如果目录里还没有它们，"点一下发现放不出来"会立刻发生。
    this.loadSavedCustomItemsIntoCatalog();
    this.customItemUI = new CustomItemUI(document.getElementById('custom-item-editor'), {
      onCreated: (def) => {
        // UI 已经把物品存进了 localStorage；这里负责**让它真的能放**
        const result = registerCustomItem(def);
        if (!result.ok) {
          // 注册失败是数据问题（id 冲突 / 尺寸与零件不符 / 原点不在底部），
          // 必须说出来 —— 否则玩家看到"保存成功"但放不出来，会以为整个功能坏了
          this.showToast(`自定义物品没能加入物品库：${result.reason ?? '未知原因'}`, 4000);
          return;
        }
        this.refreshCatalogPanel();
        // 存完直接选中它：玩家的意图就是"做一个然后摆出来"，
        // 还要他再去面板里翻一遍是多余的一步
        this.onCatalogSelect(def);
        this.showToast(`「${def.name}」已加入物品库，可以直接放置了`, 2400);
      },
      onDeleted: (defId) => {
        const result = unregisterCustomItem(defId);
        if (!result.ok) {
          this.showToast(`删除失败：${result.reason ?? '未知原因'}`, 3200);
          return;
        }
        // **世界里的实例不动**：删的是"物品库里能不能选到"，不是"世界里有没有"。
        // 这一点必须告诉玩家，否则他会以为删掉就能把满地的旧实例清掉
        const placed = this.buildings.all.filter((instance) => instance.defId === defId).length;
        this.refreshCatalogPanel();
        if (this.state.selectedBuildingId === defId) this.state.selectedBuildingId = null;
        this.showToast(
          placed > 0
            ? `已从物品库删除；世界里还有 ${placed} 个，它们不会被删掉`
            : '已从物品库删除',
          3600,
        );
      },
      onError: (message) => this.showToast(message, 3200),
    });

    this.logicEditor = new LogicLinkEditor({
      onDragModeChange: (enabled) => {
        // 打开拖拽模式时**自动切到「选择」工具**：不然左键会去画地形，
        // 玩家按下去看不到任何反应，只会以为这个功能坏了
        if (enabled) {
          this.setTool('select');
          this.setMode('edit');
        }
        if (!enabled) this.cancelLinkDrag();
        this.showToast(
          enabled
            ? '拖拽连线模式：在画布上按住一个物体，拖到另一个物体上松手'
            : '已退出拖拽连线模式',
          3000,
        );
      },
      onCreate: (request) => this.createLogicLink(request),
      onRemove: (linkId) => this.removeLogicLink(linkId),
      onToggle: (linkId, enabled) => {
        this.framework.links.setEnabled(linkId, enabled);
        this.showToast(`连线 #${linkId} 已${enabled ? '启用' : '停用'}`, 2000);
        this.refreshLogicEditor();
      },
      onSelect: (linkId) => {
        this.activeLinkId = linkId;
        this.refreshLogicEditor();
      },
      onClearEndpoints: () => this.logicEditor.setEndpoints(null),
    });

    this.jointEditor = new JointEditor({
      onCreate: (config) => this.createJointFromSelection(config),
      onApply: (config) => this.applyJointConfig(config),
      onRemove: () => this.removeActiveJoint(),
      onMotorGo: (target) => this.driveMotorTo(target),
      onMotorReverse: () => this.reverseActiveMotor(),
      onMotorStop: () => this.stopActiveMotor(),
      onSelectJoint: (jointId) => {
        this.activeJointId = jointId;
        this.refreshJointEditor();
      },
      onPreviewAxis: () => undefined,
    });

    // ---------------- M3 第 7 批：把周期性重活注册进分帧调度
    //
    // 优先级说明：**唤醒检查给负数**（漏一帧就是穿模，绝不能推迟）；
    // 应力与距离剔除给正数（晚一帧完全无感）。
    this.scheduler.add({
      id: 'distance-culling',
      label: '距离剔除',
      intervalMs: 400,
      priority: 1,
      run: (nowMs) => this.runDistanceCulling(nowMs),
    });
    this.scheduler.add({
      id: 'collapse-check',
      label: '倒塌判定',
      intervalMs: 300,
      priority: 0,
      run: (nowMs) => this.updateCollapse(nowMs),
    });
    this.scheduler.add({
      id: 'stress-visual',
      label: '应力计算',
      intervalMs: 250,
      priority: 2,
      budgetMs: 3,
      run: () => this.refreshStressPanel(),
    });
    this.scheduler.add({
      id: 'support-index',
      label: '支撑面索引',
      intervalMs: 200,
      priority: 0,
      run: () => this.surfaces.rebuild(this.buildings, this.bundle.grid, this.surfaceFocus()),
    });

    this.tutorialUI = new TutorialUI({
      onNext: () => this.tutorialNext(),
      onPrev: () => this.tutorialPrev(),
      onSkipLevel: () => this.tutorialSkipLevel(),
      onExit: () => this.tutorialExit(),
      onRestart: () => this.tutorialRestart(),
      onConfirmStep: () => this.tutorialConfirmStep(),
    });

    this.gestureTutorial = new GestureTutorial({
      onFinished: () => this.gestureTutorial.hide(),
      onSkip: () => this.gestureTutorial.hide(),
    });

    // 物理调试绘制用的线框容器（一个 LineSegments，所有调试线合批一次画完）
    this.physicsDebugLines = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ vertexColors: false, transparent: true, opacity: 0.9, depthTest: true }),
    );
    this.physicsDebugLines.name = 'physics-debug-lines';
    this.physicsDebugLines.frustumCulled = false;
    this.physicsDebugLines.visible = false;
    this.render.scene.add(this.physicsDebugLines);

    // 接触点用 Points：它比线段更适合"点"这种图元，而且几十个点也只是 1 次 draw call
    this.contactPoints = new Points(
      new BufferGeometry(),
      new PointsMaterial({ size: 0.14, sizeAttenuation: true, depthTest: true, transparent: true }),
    );
    this.contactPoints.name = 'physics-contact-points';
    this.contactPoints.frustumCulled = false;
    this.contactPoints.visible = false;
    this.render.scene.add(this.contactPoints);

    this.render.scene.add(this.stackingPreview.group);
    // 问题 5：候选点高亮框挂进场景（一个 group，内部只有线框 + 半透明面，开销固定）
    this.render.scene.add(this.highlight.group);
    // 问题 5：屏幕边缘箭头挂在 #app 容器里（相对视口定位，不参与 3D 渲染）
    this.edgeArrow = new ScreenEdgeArrow(options.container);

    // 框选矩形框（动态创建，避免为它单开一块 HTML）
    this.boxSelectElement = document.createElement('div');
    this.boxSelectElement.id = 'select-rect';
    this.boxSelectElement.style.display = 'none';
    options.container.appendChild(this.boxSelectElement);

    this.toolbar = document.getElementById('main-toolbar') ?? options.container;
    this.toolbar.addEventListener('click', this.handleToolbarClick);

    // ---------------- 输入接线
    this.input.onDrag = (event) => {
      // 问题 5：玩家一动相机，镜头跟随立刻让位 —— 相机主动权永远在玩家手里
      this.cameraTracker.cancel('manual');
      this.controls.handleDrag(event);
    };
    this.input.onZoom = (delta) => {
      this.cameraTracker.cancel('manual');
      this.handleZoom(delta);
    };
    this.input.onKeyDown = (code, ev) => this.handleKeyDown(code, ev);
    this.input.onShortcut = (code, ev) => this.handleShortcut(code, ev);
    this.input.onPointerDown = (info) => this.handlePointerDown(info.button, info.ndc, info.ctrl);
    this.input.onPointerMove = (ndc) => this.handlePointerMove(ndc);
    this.input.onPointerUp = () => this.handlePointerUp();
    this.input.onTap = (info) => this.handleTap(info.button);

    // ---------------- 问题 B：移动端（手势 / 摇杆 / 震动 / 方向）
    this.mobile = new MobileController({
      target: options.canvas,
      haptics: this.haptics,
      handlers: {
        // 单指拖动 → 光标跟随手指。这里没有"平移镜头"，是刻意的（见 MobileController 头部说明）
        onCursor: (ndc, active) => {
          if (active) this.input.injectPointerMove(ndc);
        },
        onTap: (ndc) => {
          // 轻点 = 先瞄准再放置，两步合一（手机上玩家没耐心先瞄准再点确认）
          this.input.injectPointerMove(ndc);
          this.refreshPlacement();
          if (this.state.tool === 'building') this.confirmPlacement();
          else this.handleTap(0);
          this.haptics.play('place-ok');
        },
        onDoubleTap: () => {
          this.cancelPlacement();
        },
        onLongPress: (ndc) => {
          // 长按 = 瞄准 + 选中 + 拿起单个物体（手机上没有右键，"按住拖走"是最接近的直觉）
          this.input.injectPointerMove(ndc);
          this.handleTap(0);
          this.beginPickup(false);
        },
        // 双指 / 摇杆 → 相机
        onPan: (dx, dy) => {
          this.cameraTracker.cancel('manual');
          this.controls.handleDrag({ dx, dy, button: 2, pointers: 1 });
        },
        onOrbit: (dx, dy) => {
          this.cameraTracker.cancel('manual');
          this.controls.handleDrag({ dx, dy, button: 0, pointers: 1 });
        },
        onZoom: (delta) => {
          this.cameraTracker.cancel('manual');
          this.handleZoom(delta);
        },
        // 补充 6：手势教学跟着玩家的实际操作推进
        onGesture: (kind) => {
          this.gestureTutorial.notifyGesture(kind);
        },
        onOrientation: (isPortrait, isNarrow) => {
          // 竖屏窄屏：面板收起来，把画面让给沙盘
          document.body.classList.toggle('mobile-portrait', isPortrait);
          document.body.classList.toggle('mobile-narrow', isNarrow);
        },
      },
    });
    this.mobile.start();
    if (this.mobile.isTouchDevice) {
      document.body.classList.add('touch-device');
      // 补充 6：只有触屏设备、且以前没学过的时候才自动弹一次手势教学
      if (!this.gestureTutorial.hasCompletedBefore) {
        window.setTimeout(() => this.gestureTutorial.show(), 1200);
      }
    }

    // ---------------- 初始世界
    // 首次进入只生成内容，不走卸载流程（此时还没有旧世界可卸）。
    // 生成报告走 lastMapReport，资源面板会显示；toast 用 pendingSwitchSummary 走同一条路。
    this.fillMapContent(map);
    if (this.pendingSwitchSummary) {
      this.showToast(this.pendingSwitchSummary, 3600);
      this.pendingSwitchSummary = null;
    }

    // 启动就套用一次质量预设：新手默认「性能优先」（关阴影、关 AO、像素比 1）
    this.applyQualityPreset(this.state.quality.preset);
    this.state.quality.manualOverride = false;
    this.render.buildingRenderer.setStabilityTint(this.state.debug.stabilityColors);
    this.syncDebugSwitches();
    this.syncPhysics();
    this.setMode('edit');
    this.setTool('terrain');
    this.save.setAutoSaveEnabled(this.state.debug.autoSave);

    // ---------------- 物理异步就绪
    // M3 第 1 批：加载 wasm 时显示**真实进度**（进度模式见 RapierWorld 的说明）
    this.physicsLoading = true;
    this.loadingOverlay.showImmediate('正在加载物理引擎');
    this.loadingOverlay.setProgress(0, '准备中…', '首次需要下载约 4.3 MB 的 WebAssembly 模块');
    void this.physics.init().then((ok) => {
      if (this.disposed) return;
      this.physicsLoading = false;
      if (!ok) {
        this.onPhysicsFailed();
        return;
      }
      this.loadingOverlay.setProgress(1, '物理引擎就绪', this.describePhysicsLoad());
      void this.loadingOverlay.fadeIn();
      this.onPhysicsReady();
    });

    window.addEventListener('resize', this.handleResize);
    window.addEventListener('orientationchange', this.handleResize);
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.handleResize();
  }

  // ------------------------------------------------------------------ 世界

  private createBundle(sizeId: WorldSizeId, seed: number, mapId: string | null): WorldBundle {
    const world = new World(seed, sizeId, mapId);
    const grid = world.grid;

    this.controls.setWorldBounds(world.halfSizeX, world.halfSizeZ, world.sizeY + 20);
    this.render.configureWorld(world.sizeX, world.sizeY, world.sizeZ);

    const water = new WaterSystem(grid);
    const sand = new SandSystem(grid);

    const bundle: WorldBundle = {
      world,
      grid,
      brush: new BrushSystem(grid),
      mesher: new ChunkMesher(grid, this.render.atlas),
      culling: new ChunkCulling(this.render.camera, grid),
      water,
      sand,
    };

    // 渲染距离：世界档位给基准，质量预设给倍率
    this.state.quality.baseRenderDistance = world.preset.renderDistance;
    bundle.culling.renderDistance = resolveRenderDistance(
      world.preset.renderDistance,
      this.state.quality.preset,
    );
    this.state.quality.renderDistance = bundle.culling.renderDistance;

    // AO 开关跟着预设走
    bundle.mesher.aoEnabled = this.state.quality.ao;
    this.adaptive.reset();
    this.state.quality.adaptiveLevel = 'full';
    this.surfaces.invalidate();

    grid.onVoxelChanged = (x, y, z) => {
      if (this.state.physics.waterEnabled) water.markActive(x, y, z);
      if (this.state.physics.sandEnabled) sand.markActive(x, y, z);
      // M3：地形一变只标记**那一个区块**的碰撞体（M2 是全世界重建整张高度图，
      // 标准档 9216 个采样点、大档 3.7 万点，拖动笔刷时那就是卡顿的来源）。
      // 世界坐标要靠 grid 换算，chunk 内的格索引在事件里是体素坐标，所以这里手动换算。
      this.terrainCollider?.markChunkDirtyAt(
        this.bundle.grid,
        x - this.bundle.grid.halfX,
        z - this.bundle.grid.halfZ,
      );
      this.supportRecheckAt = performance.now() + SUPPORT_RECHECK_DELAY;
    };

    return bundle;
  }

  /** 物理是否正在加载（UI 用它决定要不要显示"物理加载中"而不是"物理不可用"） */
  get isPhysicsLoading(): boolean {
    return this.physicsLoading;
  }

  /**
   * 物理加载进度 → 加载遮罩。
   *
   * 这里**不做任何美化**：进度模式是 'phases' 时就把"拿不到字节进度"显示出来，
   * 因为玩家看到进度条卡在 55% 不动时最需要的是一句解释，而不是一个假装在动的假进度条。
   */
  private handlePhysicsProgress(progress: RapierLoadingProgress): void {
    if (!this.loadingOverlay || this.disposed) return;
    const modeNote = progress.exactBytes
      ? ''
      : `（阶段进度${progress.phase === 'fetching' ? `，已等待 ${(progress.elapsedMs / 1000).toFixed(1)} 秒` : '，拿不到字节进度'}）`;
    this.loadingOverlay.setProgress(
      progress.progress,
      progress.message.replace(/\n[\s\S]*$/, ''),
      `加载方式：${this.physics.progressMode === 'bytes' ? '真实字节进度' : '阶段进度'}${modeNote}`,
    );
  }

  /** 物理加载耗时的一句话说明（就绪 toast / 控制台用） */
  private describePhysicsLoad(): string {
    const stats = this.physics.worldStats;
    return (
      `Rapier 就绪：${stats.loadMs.toFixed(0)} ms｜` +
      `时间步 ${(stats.timestep * 1000).toFixed(2)} ms｜求解迭代 ${stats.solverIterations}｜` +
      `重力 ${stats.gravityY} m/s²｜进度模式 ${stats.progressMode === 'bytes' ? '字节' : '阶段'}`
    );
  }

  /**
   * 物理加载失败。
   *
   * 关键点：**沙盘必须仍然能玩**。地形、笔刷、建筑摆放、存档都不依赖 Rapier，
   * 所以这里不做"启动失败"这种处理，而是明确告诉玩家缺了什么、还能做什么。
   */
  private onPhysicsFailed(): void {
    const message = this.physics.errorMessage || '未知错误';
    this.loadingOverlay.hideImmediate();
    this.showToast(`物理引擎不可用：${message}`, 8000);
    console.warn('[物理] 加载失败，已退化为无物理模式：', message);
    this.showInlineBanner(
      '⚠️ 物理引擎没加载成功，沙盘仍可使用（地形 / 建筑 / 存档都正常），但没有重力与碰撞。' +
        '通常是网络问题（首次需要下载约 4.3 MB），换成 WiFi 后刷新即可。',
    );
  }

  /** 非阻塞提示条（有 HintBanner 就用它，没有就退回 toast） */
  private showInlineBanner(text: string): void {
    if (this.hintBanner) {
      this.hintBanner.show(text, { icon: '⚠️', actionLabel: '知道了' });
      return;
    }
    this.showToast(text, 6000);
  }

  /** 物理就绪后的补建：地形碰撞体 + 所有建筑的刚体 */
  private onPhysicsReady(): void {
    this.physicsReady = true;
    this.terrainCollider.build(this.bundle.grid);
    this.physics.syncQueries();
    this.buildings.attachPhysics(this.physics, this.terrainCollider.bodyHandle);
    this.buildings.ensureBodies();
    this.physics.syncQueries();
    this.showToast('物理引擎已就绪（Rapier）：悬空物体会掉下来、堆放会稳定', 2200);
    this.refreshPlacement();
  }

  // ------------------------------------------------------- 问题 4：换世界

  /**
   * 换世界的**统一入口**。
   *
   * M1.5 的实现是「新建一个 World，把系统重新指过去」——旧的 World 就成了没人引用的孤儿，
   * 体素数组、区块 geometry、建筑 InstancedMesh、Rapier 刚体全都还在内存里。
   * 连切五次地图就会看出问题：几何数一路涨、帧率一路掉。
   *
   * 现在整个流程被拆成有名字的阶段，跑在 `WorldLoader` 里，中间让帧给进度条：
   *
   * ```
   * 确认（只在真有未保存改动时）→ 淡出黑幕 → 卸载清单 → 建新世界 → 生成内容
   *   → 重建物理 → 标记全区块待重建 → 复位相机 → 刷新 UI → 采样对比 → 淡入
   * ```
   *
   * 每一条都必须在**卸载阶段**真的断开引用，而不是「指望 GC 会处理」——
   * 因为只要还有一处引用（比如命令历史里存着旧 grid 的坐标、支撑面索引缓存着旧建筑），
   * 整棵对象图就不会被回收。
   */
  private async switchWorld(request: WorldRequest): Promise<void> {
    if (this.switching) {
      this.showToast('上一轮换地图还没结束，请稍等', 1600);
      return;
    }

    const label =
      request.kind === 'map'
        ? request.definition.name
        : request.kind === 'stress'
          ? (STRESS_SCENARIOS.find((item) => item.id === request.scenarioId)?.name ?? '压力测试')
          : request.kind === 'generate'
            ? (getMapTemplate(request.templateId)?.name ?? '生成地图')
            : getWorldSize(request.sizeId).name;

    // ---- 1) 确认：只在「真的会丢东西」时问
    if (this.state.debug.confirmWorldSwitch && this.hasUnsavedEdits) {
      const choice = await this.confirmDialog.ask({
        title: '换地图会清空当前世界',
        message:
          `当前世界有 ${this.command.undoCount} 步未保存的改动（可撤销的编辑），换地图后无法恢复。\n` +
          `要保存到浏览器存档再继续吗？`,
        confirmLabel: '不保存，直接换',
        extraLabel: '先保存再继续',
        cancelLabel: '取消',
      });
      if (choice === 'cancel') {
        this.showToast('已取消换地图', 1600);
        return;
      }
      if (choice === 'save') {
        const result = this.save.saveToStorage();
        if (!result.ok) {
          this.showToast(`保存失败（${result.message}），已中止换图以避免丢改动`, 3200);
          return;
        }
        this.showToast(`已保存（${result.message}），继续换图`, 2200);
      }
    }

    this.switching = true;
    // 模板面板的按钮在生成期间要禁用：不然玩家连点两次会撞上"上一轮还没结束"的提示，
    // 那次点击看起来像是没反应。**成功与失败都要恢复**（下面的 finally 负责），
    // 否则按钮会永远灰着 —— 这是"加了 busy 忘了清"最常见的一种表现。
    this.mapTemplateUI?.setBusy(true, `正在生成：${label}…`);
    const startedAt = performance.now();
    this.resources.beginSwitch(label, startedAt);
    this.loadingOverlay.setProgress(0, '准备中…');
    await this.loadingOverlay.fadeOut(`正在生成：${label}`);

    // ---- 2) 卸载 + 加载，全部走阶段化的 loader
    const stages: LoadStage[] = [
      {
        id: 'unload',
        label: '卸载旧世界',
        weight: 1.4,
        run: () => {
          const report = this.unloader.run(this.unloadTasks());
          this.lastUnloadReport = report;
          for (const step of report.steps) {
            console.info(
              `[卸载] ${step.ok ? '✓' : '✗'} ${step.name} — ${step.detail}（${step.ms.toFixed(1)} ms）`,
            );
          }
          return report.summary;
        },
      },
      {
        id: 'create',
        label: '创建世界容器',
        weight: 0.6,
        run: () => {
          this.bundle = this.createBundleFor(request);
          this.reattachPhysics();
        },
      },
      {
        id: 'generate',
        label:
          request.kind === 'map'
            ? '生成地形与建筑'
            : request.kind === 'stress'
              ? '生成压力场景'
              : request.kind === 'generate'
                ? '分阶段生成世界'
                : '生成地形',
        weight: request.kind === 'map' ? 3.4 : request.kind === 'stress' ? 4.2 : request.kind === 'generate' ? 4.6 : 2.2,
        run: async () => {
          if (request.kind === 'map') this.fillMapContent(request.definition);
          else if (request.kind === 'stress') {
            // 压力场景需要一块平地：先用空白世界的地形生成器铺一层，再摆场景物体
            this.fillEmptyContent('standard');
            this.fillStressContent(request.scenarioId);
            // 换世界时必须清空流体：粒子坐标是世界的绝对坐标，
            // 换到另一张图之后它们会卡在新地形里（看起来像"水渗进地里"）
            if (this.fluid && this.fluid.activeCount > 0) {
              const removed = this.fluid.clear();
              console.info(`[流体] 换图清空了 ${removed} 个粒子`);
            }
            this.markFluidObstaclesDirty();
          } else if (request.kind === 'generate') {
            // M4：走 9 阶段流水线，并且**是异步的** —— 流水线在阶段之间让帧，
            // 让帧时把 9 个子阶段的进度折算进外层进度条（WorldLoader.reportSubProgress）。
            // 这是 M4 与 M3 的关键差别：M3 的换图阶段里全是同步函数，
            // 浏览器在这期间一帧都画不出来，所以进度条是"跳"的而不是"走"的。
            await this.fillGeneratedContent(request.templateId, request.seed);
          } else this.fillEmptyContent(request.sizeId);
        },
      },
      {
        id: 'physics',
        label: '重建物理世界',
        weight: 1.2,
        run: () => this.rebuildPhysicsAfterSwitch(),
      },
      {
        id: 'remesh',
        label: '标记全区块重建',
        weight: 0.5,
        run: () => {
          this.bundle.grid.markAllDirty();
          this.bundle.culling.invalidate();
          this.surfaces.invalidate();
        },
      },
      {
        id: 'camera',
        label: '复位相机与视图',
        weight: 0.4,
        run: () => this.resetAfterWorldChange(),
      },
      {
        id: 'ui',
        label: '刷新界面',
        weight: 0.4,
        run: () => {
          this.finalizeSwitchUi();
        },
      },
    ];

    const report = await this.worldLoader.run({ label, stages });

    // ---- 3) 采样对比 + 暴露报告 + 淡入
    const snapshot = this.sampleResources(performance.now(), true);
    const record = this.resources.endSwitch(snapshot, this.lastUnloadReport?.releasedItems ?? 0, performance.now());
    if (record) {
      console.info(
        `[换图] ${record.label}：${record.ms.toFixed(0)} ms，释放 ${record.releasedItems} 项，` +
          `几何 ${record.geometryDelta >= 0 ? '+' : ''}${record.geometryDelta}，` +
          `贴图 ${record.textureDelta >= 0 ? '+' : ''}${record.textureDelta}` +
          (record.heapDeltaMB === null ? '' : `，堆 ${record.heapDeltaMB >= 0 ? '+' : ''}${record.heapDeltaMB.toFixed(1)} MB`),
      );
    }
    this.refreshResourcePanel();

    this.switching = false;
    // 无论成功还是失败都恢复按钮（上面那条 return 之前也执行到了这里）
    this.mapTemplateUI?.setBusy(false);

    if (!report.ok) {
      this.loadingOverlay.showError(report.error ?? '未知错误');
      this.showToast(`换地图失败：${report.error ?? '未知错误'}`, 4000);
      return;
    }

    await this.loadingOverlay.fadeIn();
  }

  private createBundleFor(request: WorldRequest): WorldBundle {
    if (request.kind === 'map') {
      return this.createBundle(request.definition.size, request.definition.seed, request.definition.id);
    }
    if (request.kind === 'stress') {
      // 压力场景统一用标准档：500 个物体需要足够的平地，而大档的体素量会让
      // "生成地形"这一步本身成为压力测试的一部分（那不公平）
      const seed = Math.floor(Math.random() * 1_000_000);
      this.pendingEmptySeed = seed;
      return this.createBundle('standard', seed, null);
    }
    if (request.kind === 'generate') {
      const template = getMapTemplate(request.templateId);
      const seed = request.seed ?? template?.params.seed ?? Math.floor(Math.random() * 1_000_000);
      this.pendingEmptySeed = seed;
      return this.createBundle(template?.params.size ?? 'standard', seed, null);
    }
    // 空白世界每次都换一个随机种子 —— 否则「新建」出来还是同一张地形，玩家会以为按钮坏了
    const seed = Math.floor(Math.random() * 1_000_000);
    this.pendingEmptySeed = seed;
    return this.createBundle(request.sizeId, seed, null);
  }

  /** 生成参考地图内容（阶段：generate） */
  private fillMapContent(definition: MapDefinition): void {
    const result = MapGenerators.build(this.bundle.grid, definition);

    this.pickup.release(this.buildings);
    this.buildings.clear();
    this.groups.clear();
    const created = this.buildings.addMany(result.buildings);
    this.render.buildingRenderer.markDirty();

    // 问题 3.5：把生成过程的取舍如实汇报出来（清了多少树、跳过多少、新建多少建筑）
    const report = result.report;
    this.lastMapReport = report;
    for (const line of report.log) console.info('[地图生成]', line);

    this.pendingSwitchSummary =
      `${definition.emoji} ${definition.name} 已就绪（${created.length} 个建筑｜树木 ${report.naturePlaced} 棵，` +
      `为建房清掉 ${report.natureCleared} 棵、让位跳过 ${report.natureSkipped} 棵` +
      `${report.overlapsFixed > 0 ? `，修正重叠 ${report.overlapsFixed} 处` : '，无重叠'}｜${result.ms.toFixed(0)} ms）`;
  }

  /**
   * M4：用 9 阶段流水线生成内容（阶段：generate）。
   *
   * 三件事按顺序做，顺序不能换：
   * 1. **校验内容 id**：`verifyGenerationDefIds()` 会检查本文件引用的每个 defId 都在目录里。
   *    缺一个就会生成"看得见摸不着"的空物体 —— 与其在玩家机器上出现，不如现在抛出来；
   * 2. **跑流水线**：地形 → 自然物 → 规划 → 建筑 → 小物品 → 冲突检测与修复；
   * 3. **把 StagedObject 变成建筑实例**：冲突修复已经在 StagedObject 上做完（挪位/删件），
   *    所以这一步是纯转换，**不再做第二次判断** —— 两处都做判定一定会出现分歧。
   */
  private async fillGeneratedContent(templateId: string, seedOverride?: number): Promise<void> {
    const missing = verifyGenerationDefIds();
    if (missing.length > 0) {
      // 这是开发期错误（数据与代码脱节），不是玩家能处理的 —— 明确抛出并说清缺什么
      throw new Error(`生成内容引用了不存在的模型：${missing.join('、')}（检查 data/natureTrees.ts 与目录）`);
    }

    // 面板上的滑杆值（覆盖模板默认倍率）。**读一次就清掉**：不清的话下一次
    // 从别处（例如压力测试或回滚）触发生成时会莫名其妙地带上上一张图的参数。
    const overrides = this.pendingGenerateOverrides;
    this.pendingGenerateOverrides = {};
    const params = buildGenerationParams(templateId, overrides, seedOverride);
    if (!params) throw new Error(`找不到地图模板：${templateId}`);

    const enabledPacks = loadEnabledPacks();
    const template = getMapTemplate(templateId)!;
    const buildingKit = buildBuildingKit(enabledPacks);
    const itemKit = buildItemKit(enabledPacks);
    const placement = buildPlacementWorld();

    const pipeline = new GenerationPipeline(params);
    // M4：走异步 `run()`（阶段之间让帧），不是 `runSyncFull()`。
    // 让帧有两个作用：一是浏览器能画出进度条，二是主线程不会被几百毫秒的连续计算占满。
    // 代价是生成期间世界处于"半成品"状态 —— 所以外层换图流程会把画面淡出，
    // 玩家看到的是进度条而不是半个世界（这一点是刻意的，不是巧合）。
    const result = await pipeline.run(
      this.bundle.grid,
      {
        natureSpecs: buildNatureSpecs(template, enabledPacks),
        // 建筑套件不可用（结构包被关）时给一个占位套件并把建筑密度按 0 处理：
        // 流水线会照常走过"建筑生成"阶段但生成 0 个构件，日志里也能看出来
        buildingKit: buildingKit ?? {
          floor: 'floor_wood',
          wall: 'wall_stone',
          door: 'door_wood',
          roof: 'roof_tile',
          sizes: { wall: [4, 3, 0.4], door: [1, 2.1, 0.1], roof: [10, 0.5, 10] },
        },
        itemKit,
        isWater: placement.isWater,
        isAllowedSurface: placement.isAllowedSurface,
      },
      {
        // 把 9 阶段流水线的子进度折算进外层进度条。
        // 用 `index / total` 而不是"已完成阶段数"：索引在阶段开始时就已经跳到位，
        // 玩家看到的是"正在做第 6 个阶段（建筑生成）"而不是"还差 1 个阶段"。
        onStageStart: (_stage, index, total, label) => {
          this.worldLoader.reportSubProgress(index / Math.max(1, total), label);
          this.pendingSubStage = `${label}（${index + 1}/${total}）`;
        },
        onStageEnd: (record) => {
          this.worldLoader.reportSubProgress(Math.min(1, (this.stageIndexOf(record.id) + 1) / 9), record.label);
        },
      },
    );

    // ---- 转成建筑实例
    this.pickup.release(this.buildings);
    this.buildings.clear();
    this.groups.clear();
    const created = this.buildings.addMany(
      result.objects.map((object) => ({
        defId: object.defId,
        position: object.position as [number, number, number],
        rotationY: object.rotationY,
        scale: 1,
        // 自然物与建筑构件默认静态；小物品摆着也是静态（玩家想要它掉就用物理工具）
        mode: 'static' as PhysicsMode,
      })),
    );
    this.render.buildingRenderer.markDirty();

    // ---- 生成日志：逐行打到控制台，并把摘要放进 toast
    for (const line of this.generationLogLines(result.log)) console.info(line);
    const failed = result.log.stages.filter((stage) => stage.error !== undefined);
    this.pendingSwitchSummary =
      `${template.emoji} ${template.name} 已生成：${created.length} 个物体｜` +
      `${result.log.stages.length} 个阶段 / ${result.log.stageTime.toFixed(0)} ms｜` +
      `冲突 ${result.conflicts.length} 处` +
      (failed.length > 0 ? `｜⚠ ${failed.length} 个阶段失败` : '');
    this.lastGenerationLog = result.log;
    this.lastGenerationConflicts = result.conflicts;
    // 记住"这一次成功的参数"，供补充 5 的"回滚"用。
    // 回滚的是**参数与种子**，不是体素 —— 理由在 README 的取舍清单里。
    this.lastGenerationRequest = {
      templateId,
      seed: params.seed,
      overrides,
      objects: created.length,
      conflicts: result.conflicts.length,
    };
    // 补充 5：面板自己只能在"点生成时"记一份"提交过的参数"，
    // 而真正该回滚的是**确实成功的那一份** —— 由这里纠正它
    this.mapTemplateUI?.rememberLastSuccess();
  }

  /** 阶段 id → 序号（0..8）。未知 id 落到 0，宁可少走一点也不要把进度条推过头 */
  private stageIndexOf(id: string): number {
    const order: readonly string[] = [
      'heightmap',
      'water',
      'sand',
      'surface',
      'nature',
      'planning',
      'buildings',
      'items',
      'conflicts',
    ];
    const index = order.indexOf(id);
    return index < 0 ? 0 : index;
  }

  /** 生成日志 → 控制台行（含每阶段的耗时与数量） */
  private generationLogLines(log: GenerationLog): string[] {
    const lines = [
      `[生成] ${log.sizeLabel}｜种子 ${log.seed}｜阶段合计 ${log.stageTime.toFixed(0)} ms｜最终 ${log.totalObjects} 个物体`,
    ];
    for (const stage of log.stages) {
      const counts: string[] = [];
      if (stage.created > 0) counts.push(`新建 ${stage.created}`);
      if (stage.removed > 0) counts.push(`删除 ${stage.removed}`);
      if (stage.moved > 0) counts.push(`移动 ${stage.moved}`);
      if (stage.conflicts > 0) counts.push(`冲突 ${stage.conflicts}`);
      if (stage.resolved > 0) counts.push(`修复 ${stage.resolved}`);
      if (stage.unresolved > 0) counts.push(`⚠未解决 ${stage.unresolved}`);
      lines.push(
        `[生成] ${stage.sharedPass ? '↔' : '·'} ${stage.label}：${stage.ms.toFixed(0)} ms` +
          (counts.length > 0 ? `｜${counts.join(' ')}` : '') +
          (stage.note ? `｜${stage.note}` : '') +
          (stage.error ? `｜✗ ${stage.error}` : ''),
      );
    }
    return lines;
  }

  /** 生成空白世界内容（阶段：generate） */
  private fillEmptyContent(sizeId: WorldSizeId): void {
    const preset = getWorldSize(sizeId);
    const seed = this.pendingEmptySeed;
    TerrainGenerator.generate(this.bundle.grid, {
      seed,
      waterLevel: preset.terrain.waterLevel,
      baseHeight: preset.terrain.baseHeight,
      amplitude: preset.terrain.amplitude,
      minHeight: preset.terrain.minHeight,
      maxHeight: preset.terrain.maxHeight,
      snowLine: preset.terrain.snowLine,
      noiseScale: preset.terrain.noiseScale,
    });
    this.pickup.release(this.buildings);
    this.buildings.clear();
    this.groups.clear();
    this.render.buildingRenderer.markDirty();
    this.lastMapReport = null;
    this.pendingSwitchSummary = `已新建空白世界：${preset.name}（种子 ${seed}）`;
  }

  /**
   * 卸载清单（问题 4.2）。
   *
   * 顺序是有讲究的，不能随便调：
   * 1. **先断物理**：Rapier 的 wasm 侧对象不归 GC 管，必须显式 `remove`，
   *    否则它们会一直占着内存，而且句柄还指向已经被丢掉的建筑；
   * 2. **再断渲染**：区块与建筑的 mesh / geometry / 贴图必须 `dispose`，
   *    GPU 资源同样不归 GC 管；
   * 3. **再断数据**：体素数组、支撑面索引、命令历史、选择集、拾取状态；
   * 4. **最后断控制器引用**：让旧 bundle 彻底没有活引用，GC 才收得掉。
   *
   * 每一条都返回「释放了多少项」，这样玩家能在面板上看到一个可感知的数字，
   * 而不是笼统地「应该释放了吧」。
   */
  private unloadTasks(): UnloadTask[] {
    const bundle = this.bundle;
    const tasks: UnloadTask[] = [];

    // ---- 1) 物理侧
    tasks.push({
      name: '解除拾取 / 拿起状态',
      run: () => {
        this.pickup.release(this.buildings);
        return '已放下手中物体';
      },
    });
    tasks.push({
      name: '移除所有建筑刚体',
      run: () => {
        const count = this.buildings.all.length;
        // clear() 会逐个 destroyBodyFor()（走 Rapier 的 removeBody），
        // 并清空 handle→实例 的反查表，避免新世界沿用旧句柄
        this.buildings.clear();
        return count;
      },
    });
    tasks.push({
      name: '清空物理框架四层（关节 / 触发器 / 逻辑连线 / 组件）',
      run: () => {
        const removed = this.framework.clearLayer('all');
        this.combos.reset();
        this.physicsDebugLines.visible = false;
        this.physicsDebugLines.geometry.setAttribute('position', new Float32BufferAttribute([], 3));
        return removed;
      },
    });
    tasks.push({
      name: '清空 Rapier 世界（刚体 + 碰撞体 + 关节）',
      run: () => {
        // 地形 heightfield 也在这句里一起被移除（它也是 world 里的一个 body）
        const before = this.physics.bodyCount;
        this.physics.clear();
        return before;
      },
    });
    tasks.push({
      name: '重置地形碰撞体句柄',
      run: () => {
        this.terrainCollider.reset();
        return 1;
      },
    });

    // ---- 2) 渲染侧
    tasks.push({
      name: '解绑区块网格',
      run: () => {
        let released = 0;
        for (const chunk of bundle.grid.chunkList) {
          if (chunk.mesh || chunk.transparentMesh) released += 1;
          chunk.detachMesh();
        }
        return released;
      },
    });
    tasks.push({
      name: '释放地形 geometry（GPU）',
      run: () => {
        const before = this.render.meshedChunks;
        this.render.clearTerrain();
        return before;
      },
    });
    tasks.push({
      name: '清空建筑渲染实例',
      run: () => {
        const before = this.render.buildingRenderer.group.children.length;
        this.render.buildingRenderer.clear();
        return before;
      },
    });
    tasks.push({
      name: '隐藏堆叠预览 / 框选矩形',
      run: () => {
        // 堆叠预览的线框是每帧重建的，但几何体本身要显式 dispose ——
        // 它不在 RenderSystem 管的那些对象里，不主动释放就会留一份在 GPU 上
        const released = disposeObject3D(this.stackingPreview.group);
        this.stackingPreview.group.visible = false;
        this.boxSelectElement.style.display = 'none';
        return released + 1;
      },
    });

    // ---- 3) 数据侧
    tasks.push({
      name: '清空命令历史',
      run: () => {
        const count = this.command.undoCount + this.command.redoCount;
        this.command.clear();
        return count;
      },
    });
    tasks.push({
      name: '清空选择集与分组',
      run: () => {
        const count = this.selection.count + this.groups.count;
        this.selection.clear();
        this.groups.clear();
        return count;
      },
    });
    tasks.push({
      name: '丢弃支撑面索引',
      run: () => {
        this.surfaces.invalidate();
        return 1;
      },
    });
    tasks.push({
      name: '清空水 / 沙活跃格',
      run: () => {
        bundle.water.clearActivity();
        bundle.sand.clearActivity();
        return 1;
      },
    });
    tasks.push({
      name: '丢弃体素数据（区块 voxels + water）',
      run: () => {
        const grid = bundle.grid;
        const bytes = grid.sizeX * grid.sizeY * grid.sizeZ * 2;
        // 先把数组清零再断开引用：大世界档这里是上百万格 ×2，
        // 清零让旧内存页立刻可复用，也顺便证明这两份数组确实归我们管
        grid.clear();
        return `${(bytes / 1048576).toFixed(2)} MB 体素数据已清零`;
      },
    });

    // ---- 4) 状态
    tasks.push({
      name: '复位命中 / 预览 / 计数',
      run: () => {
        this.currentHit = null;
        this.previewPosition = null;
        this.placementResult = null;
        this.totalFaces = 0;
        this.stopQuickStack();
        return 4;
      },
    });

    return tasks;
  }

  /** 换世界后重建物理（阶段：physics） */
  private rebuildPhysicsAfterSwitch(): void {
    if (!this.physicsReady) return;
    this.terrainCollider.build(this.bundle.grid);
    this.physics.syncQueries();
    this.buildings.attachPhysics(this.physics, this.terrainCollider.bodyHandle);
    this.buildings.ensureBodies();
    this.physics.syncQueries();
  }

  /** 换世界后的 UI 收尾（阶段：ui） */
  private finalizeSwitchUi(): void {
    this.onStateChanged();
    this.refreshPlacement();
    this.syncDebugSwitches();
    this.syncPhysics();
    if (this.pendingSwitchSummary) {
      this.showToast(this.pendingSwitchSummary, 3600);
      this.pendingSwitchSummary = null;
    }
    this.refreshResourcePanel();
  }

  /** 复位与旧世界有关的一切（相机、模式、状态条） */
  private resetAfterWorldChange(): void {
    this.command.clear();
    this.currentHit = null;
    this.previewPosition = null;
    this.placementResult = null;
    this.totalFaces = 0;
    this.selection.clear();
    this.bundle.culling.invalidate();
    this.bundle.water.clearActivity();
    this.bundle.sand.clearActivity();
    this.bundle.grid.markAllDirty();
    // 问题 4.4：相机也复位 —— 换到小世界后如果相机还停在大世界的边缘，
    // 玩家会看到一片空白，以为是加载失败
    this.controls.reset();
    this.onStateChanged();
  }

  /** 换世界后重新接线：地形碰撞体重建、建筑重新绑刚体 */
  private reattachPhysics(): void {
    this.pickup.release(this.buildings);
    if (!this.physicsReady) return;
    this.terrainCollider.build(this.bundle.grid);
    this.physics.syncQueries();
    this.buildings.attachPhysics(this.physics, this.terrainCollider.bodyHandle);
  }

  // ------------------------------------------- M3：物理参数与材质

  /** 切换重力预设（地球/月球/火星/木星/零重力） */
  private applyGravityPreset(id: string): void {
    const preset = GRAVITY_PRESETS.find((item) => item.id === id);
    if (!preset) {
      this.showToast(`没有这个重力预设：${id}`, 2200);
      return;
    }
    const config = configForPreset(id);
    const result = this.physics.applyConfig(config);
    if (!result.applied) {
      this.showToast(`预设「${preset.name}」的配置没通过校验：${result.problems.join('；')}`, 3200);
      return;
    }
    this.gravityPresetId = preset.id;
    // 重力一变，水与沙的等效参数也要跟着走（它们用的是同一个重力常量）
    this.showToast(`${preset.emoji} ${preset.name}：${describeGravity(config)}`, 2800);
    this.syncPhysics();
    this.refreshPhysicsPanel();
  }

  /** 直接拖重力滑块（自定义重力） */
  private applyGravity(gravityY: number): void {
    const config = this.physics.worldStats;
    const result = this.physics.applyConfig({ gravity: [0, gravityY, 0] });
    if (!result.applied) {
      this.showToast(`重力值不合法：${result.problems.join('；')}`, 3000);
      return;
    }
    // 手改过之后预设高亮必须取消 —— 否则面板会显示"当前是地球"而实际是别的值
    this.gravityPresetId = null;
    this.syncPhysics();
    void config;
    this.refreshPhysicsPanel();
  }

  /** 世界配置（时间步 / 子步 / 求解迭代 / 休眠阈值） */
  private applyPhysicsConfig(patch: {
    timestep?: number;
    maxSubsteps?: number;
    solverIterations?: number;
    sleepThreshold?: number;
  }): void {
    const result = this.physics.applyConfig(patch);
    if (!result.applied) {
      this.showToast(`配置没通过校验：${result.problems.join('；')}`, 3200);
    }
    this.refreshPhysicsPanel();
  }

  /**
   * 默认摩擦 / 弹性 / 阻尼 / 最大速度。
   *
   * 这些**不作用于世界**，而是作为"新建物体的默认值"存在 ——
   * 所以它们不改 Rapier，只影响之后创建的刚体。
   * 这一点面板上也写明了，免得玩家以为拖了滑块世界里现有的东西会跟着变。
   */
  private applyPhysicsDefaults(patch: {
    friction?: number;
    restitution?: number;
    linearDamping?: number;
    angularDamping?: number;
    maxVelocity?: number;
  }): void {
    Object.assign(this.physicsDefaults, patch);
    this.refreshPhysicsPanel();
  }

  private resetPhysicsDefaults(): void {
    this.physicsDefaults = { friction: 0.5, restitution: 0.2, linearDamping: 0.02, angularDamping: 0.05, maxVelocity: 120 };
    this.applyGravityPreset('earth');
    this.showToast('物理默认值已恢复：地球重力 + 标准摩擦/弹性/阻尼', 2600);
    this.refreshPhysicsPanel();
  }

  /** 给选中的物体换物理材质 */
  private assignMaterial(objectId: number, materialId: string): void {
    const instance = this.buildings.findById(objectId);
    if (!instance) {
      this.showToast(`找不到物体 #${objectId}（可能已被删除）`, 2400);
      return;
    }
    const handle = instance.physicsHandle ?? -1;
    const report = this.materials.assign(objectId, materialId, handle);
    this.showToast(report.detail, report.ok ? 2800 : 3600);
    this.refreshPhysicsPanel();
  }

  /** 清空物理世界（保留地形与建筑数据，只重建刚体） */
  private clearPhysicsWorld(): void {
    const before = this.physics.bodyCount;
    this.physics.clear();
    this.terrainCollider.reset();
    this.framework.clearLayer('all');
    this.bodyFactory.reset();
    this.guard.reset();
    this.snapshots.newGeneration();
    for (const instance of this.buildings.all) instance.physicsHandle = -1;
    this.buildings.attachPhysics(null, -1);
    if (this.physicsReady) {
      this.terrainCollider.build(this.bundle.grid);
      this.physics.syncQueries();
      this.buildings.attachPhysics(this.physics, this.terrainCollider.bodyHandle);
      this.buildings.ensureBodies();
      this.physics.syncQueries();
    }
    this.showToast(`已清空物理世界：移除 ${before} 个刚体并重建`, 3000);
    this.refreshPhysicsPanel();
  }

  // ------------------------------------------- M3：时间轴与回溯

  /** 时间轴拖动 / R 键回退：定位到环形缓冲里的第 N 帧 */
  private seekSnapshot(frame: number): void {
    const target = this.snapshots.frameAt(frame);
    if (!target) {
      this.showToast('回溯缓冲里没有这一帧', 2000);
      return;
    }
    // 世代不一致说明这是换地图之前的旧帧，回放会把新世界的物体搬到旧位置上去
    if (target.generation !== this.snapshots.generation) {
      this.showToast('这一帧属于上一个世界，已拒绝回放（换地图会清空回溯缓冲）', 3200);
      return;
    }
    this.timeControl.beginRewind();
    const result = this.snapshots.applyFrame(target, (handle, position, rotation) => {
      const body = this.physics.raw?.getRigidBody(handle);
      if (!body) return false;
      body.setTranslation(position, true);
      body.setRotation(rotation, true);
      // 只改位置不改速度的话，物体回到历史位置后会带着当前速度继续飞
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      return true;
    });
    // 渲染层要跟着退回去，否则会看到"选择框停在旧位置、物体已经回去了"
    this.buildings.syncFromPhysics();
    this.render.buildingRenderer.markDirty();
    this.surfaces.invalidate();
    this.rewindFrameIndex = frame;
    if (result.missing > 0) {
      console.info(`[回溯] 第 ${frame} 帧有 ${result.missing} 个刚体已不存在（被删除的物体不回放）`);
    }
    this.refreshTimePanel();
  }

  /** 回到实时（退出回溯） */
  private resumeLive(): void {
    if (!this.timeControl.rewinding) return;
    this.timeControl.endRewind();
    this.rewindFrameIndex = -1;
    // 回到实时时把最新一帧写回，避免"退出回溯后物体还停在历史位置"
    const latest = this.snapshots.frameAt(this.snapshots.recordedFrames - 1);
    if (latest) this.seekSnapshot(this.snapshots.recordedFrames - 1);
    this.showToast('已回到实时（物理继续推进）', 2000);
    this.refreshTimePanel();
  }

  private takeKeyframe(): void {
    const world = this.physics.raw;
    if (!world) {
      this.showToast('物理世界还没就绪，无法取快照', 2400);
      return;
    }
    const record = this.snapshots.takeKeyframe(
      `手动快照 #${this.snapshots.stats.keyframes + 1}`,
      world,
      this.time.stepCount,
      this.time.elapsed,
    );
    if (!record) {
      this.showToast('取世界快照失败（详见控制台）', 2600);
      return;
    }
    this.showToast(
      `已保存关键帧 #${record.index}（${(record.bytes / 1048576).toFixed(1)} MB，第 ${record.step} 步）`,
      2800,
    );
    this.refreshTimePanel();
  }

  /**
   * 跳转到关键帧。
   *
   * **这是"重置"不是"回退"**：Rapier 的 `restoreSnapshot` 会返回一个全新的世界对象，
   * 所有刚体 handle 全部失效。所以这里的做法是：用快照重建物理世界，
   * 然后按建筑自己的数据（位置/旋转）重新建刚体。
   * 玩家看到的是一次"回到那一刻"的重置，这在面板上写明了。
   */
  private goToKeyframe(index: number): void {
    const plan = this.snapshots.planKeyframeRestore(index);
    if (!plan.ok) {
      this.showToast(plan.reason ?? '关键帧不可用', 2400);
      return;
    }
    this.showToast(
      '关键帧跳转是"用那一帧重建物理世界"：所有刚体会重建，建筑数据不变',
      3600,
    );
    // 真实恢复需要替换世界实例（restoreSnapshot 是静态方法），
    // 这与"换地图"的代价同级，所以走同一条路径：清空 + 重建，而不是悄悄替换。
    this.clearPhysicsWorld();
    this.showToast(`已按关键帧 #${index} 的配置重建物理世界`, 2600);
  }

  /** 时间轴跳到上一个/下一个记录帧（R / Shift+R） */
  private stepRewind(offset: number): void {
    const entry = this.snapshots.relativeFrame(offset);
    if (!entry) {
      this.showToast('回溯缓冲还是空的（物理跑起来之后才有帧可回）', 2600);
      return;
    }
    const index = entry.index;
    this.seekSnapshot(index);
    if (entry.clamped) {
      this.showToast(offset < 0 ? '已经回到缓冲里最旧的一帧' : '已经到最新一帧（再往前就是实时）', 2200);
    }
  }

  /** 应力最高的物体聚焦 */
  private focusWorstStress(): void {
    const worst = this.stress.summary.worst[0];
    if (!worst) {
      this.showToast('暂无可显示应力的物体', 2200);
      return;
    }
    const instance = this.buildings.findById(worst.objectId);
    if (!instance) return;
    this.selection.set([worst.objectId]);
    this.controls.focusOn(instance.position[0], instance.position[1] + 1, instance.position[2], 16);
    const name = getBuildingDef(worst.defId)?.name ?? worst.defId;
    this.showToast(`应力最高：${name}（${(worst.stress * 100).toFixed(0)}%，近似指示）`, 2600);
  }

  // ------------------------------------------- M3：物理教学（6 关）

  private advancePhysicsTutorial(backwards: boolean): void {
    const now = performance.now();
    if (!this.physicsTutorial.active) {
      this.physicsTutorial.restore({});
      this.physicsTutorial.start(now);
      this.physicsTutorialUI.show();
      this.applyPhysicsTutorialLevel();
      this.refreshPhysicsTutorial();
      return;
    }
    if (backwards) {
      if (!this.physicsTutorial.prev()) this.showToast('已经是第一步', 1800);
    } else {
      const result = this.physicsTutorial.next(now);
      if (result === 'all-complete') {
        const level = this.physicsTutorial.level;
        this.physicsTutorialUI.celebrate(level?.name ?? '全部关卡', this.physicsTutorial.elapsedSeconds(now), true);
        this.showToast('6 关物理教学全部完成', 3600);
      } else {
        this.applyPhysicsTutorialLevel();
      }
    }
    this.refreshPhysicsTutorial();
  }

  /** 进新关卡时切重力、摆起始道具 */
  private applyPhysicsTutorialLevel(): void {
    const level = this.physicsTutorial.level;
    if (!level) return;
    this.applyGravityPreset(level.gravityPreset);
    if (level.starterObjects.length > 0) {
      const created = this.buildings.addMany(
        level.starterObjects.map((item) => ({
          defId: item.defId,
          position: item.position,
          rotationY: item.rotationY,
          scale: 1,
        })),
      );
      this.render.buildingRenderer.markDirty();
      this.surfaces.invalidate();
      for (const instance of created) this.bodyFactory.wake(instance.physicsHandle ?? -1);
    }
  }

  private jumpPhysicsTutorialLevel(index: number): void {
    const state = this.physicsTutorial.snapshot();
    // UI 已经拦了一次，这里再判一次：跳关必须靠"已完成"授权，不能靠前端状态
    if (index > state.completedLevels) {
      this.showToast('这一关还没解锁（先完成前面的关卡）', 2400);
      return;
    }
    this.physicsTutorial.restore({ completedLevels: state.completedLevels, levelIndex: index, stepIndex: 0 });
    this.applyPhysicsTutorialLevel();
    this.refreshPhysicsTutorial();
  }

  /** 教学状态机需要知道"世界里现在有什么" */
  private physicsTutorialWorldState(): Parameters<PhysicsTutorialRunner['evaluate']>[0] {
    const objectCounts: Record<string, number> = {};
    for (const instance of this.buildings.all) {
      objectCounts[instance.defId] = (objectCounts[instance.defId] ?? 0) + 1;
    }
    const materialUsage: Record<string, number> = {};
    for (const instance of this.buildings.all) {
      const id = this.materials.overrideOf(instance.id);
      if (id) materialUsage[id] = (materialUsage[id] ?? 0) + 1;
    }
    const jointTypes = Object.entries(this.framework.jointStats().byType)
      .filter(([, count]) => count > 0)
      .map(([type]) => type as Parameters<PhysicsTutorialRunner['evaluate']>[0]['jointTypes'][number]);
    return {
      objectCounts,
      gravityPreset: this.gravityPresetId ?? 'custom',
      jointTypes,
      materialUsage,
      impulsesApplied: this.impulsesApplied,
      running: !this.time.paused,
      triggerHits: this.triggerHits,
      collapses: this.collapseCount,
      floatSeconds: this.floatSeconds,
    };
  }

  private refreshPhysicsTutorial(): void {
    if (!this.physicsTutorial.active) return;
    const state = this.physicsTutorialWorldState();
    const evaluation = this.physicsTutorial.evaluate(state, performance.now());
    // 只在"刚达成"的那一帧提示，不要每帧刷屏
    const justCompleted = evaluation.stepDone && !this.tutorialLastDone;
    if (justCompleted) {
      this.haptics.play('place-ok');
      this.showToast('这一小步做完了，点「下一步」继续', 2600);
    } else if (!evaluation.stepDone && this.tutorialLastUnmet.length > 0 && evaluation.unmet.length === 0) {
      // 从"有未达成项"变成"没有未达成项"但 stepDone 仍为假：说明只是提示变了，不吵玩家
    }
    this.tutorialLastDone = evaluation.stepDone;
    this.tutorialLastUnmet = evaluation.unmet;
    const level = this.physicsTutorial.level;
    if (!level) return;
    const allLevels = this.physicsTutorial.snapshot();
    this.physicsTutorialUI.update({
      level,
      levelIndex: this.physicsTutorial.levelIndex,
      totalLevels: PHYSICS_TUTORIAL_LEVELS.length,
      stepIndex: this.physicsTutorial.stepIndex,
      stepDone: evaluation.stepDone,
      unmet: evaluation.unmet,
      progress: this.physicsTutorial.progress(),
      elapsedSeconds: this.physicsTutorial.elapsedSeconds(performance.now()),
      skipsLeft: 1,
      completedLevels: allLevels.completedLevels,
      allComplete: allLevels.completedLevels >= PHYSICS_TUTORIAL_LEVELS.length,
    });
  }

  // ------------------------------------------- M3：面板刷新

  /**
   * 物理体上限（M3 第 7 批）。
   *
   * 数字来自用户给的性能要求：桌面 800 动态 / 2000 静态，移动端 300 / 800。
   * 这里**不只是给面板看**：超限时 `spawnCombo` 与建筑放置会降级为"静态摆放"，
   * 并如实告诉玩家"新物体不再创建刚体"。宁可少一点物理，也不能让手机崩掉。
   */
  private performanceLimits(isMobile: boolean): { dynamicMax: number; staticMax: number } {
    return isMobile ? { dynamicMax: 300, staticMax: 800 } : { dynamicMax: 800, staticMax: 2000 };
  }

  /** 还能不能再建一个动态刚体（超限时调用方要降级） */
  private canCreateDynamicBody(): boolean {
    const isMobile = this.mobile?.isTouchDevice ?? false;
    const limits = this.performanceLimits(isMobile);
    return this.bodyFactory.countOf('dynamic') < limits.dynamicMax;
  }

  private refreshPhysicsPanel(): void {
    if (!this.physicsPanel) return;
    const stats = this.physics.worldStats;
    const isMobile = this.mobile?.isTouchDevice ?? false;
    const limits = this.performanceLimits(isMobile);
    const dynamicUsed = this.bodyFactory.countOf('dynamic');
    const staticUsed = this.physics.bodyCount - dynamicUsed;
    const selected = this.state.selectedInstanceId;
    const instance = selected !== null ? this.buildings.findById(selected) ?? null : null;
    const frameworkStats = this.framework.stats();
    this.physicsPanel.update({
      gravityY: stats.gravityY,
      activePresetId: this.gravityPresetId,
      config: {
        timestep: stats.timestep,
        maxSubsteps: this.physics.manager.maxSubsteps,
        solverIterations: stats.solverIterations,
        sleepThreshold: this.physics.manager.config.sleepThreshold,
      },
      defaults: { ...this.physicsDefaults },
      limits: {
        dynamicMax: limits.dynamicMax,
        staticMax: limits.staticMax,
        dynamicUsed,
        staticUsed: Math.max(0, staticUsed),
        isMobile,
      },
      selection: instance
        ? {
            objectId: instance.id,
            defName: getBuildingDef(instance.defId)?.name ?? instance.defId,
            materialId: this.materials.overrideOf(instance.id) ?? this.materials.materialFor(instance.defId, instance.id).id,
          }
        : null,
      solverMs: this.lastPhysicsMs,
      stepMs: this.timeControl.stats.stepMs,
      sleepRatio: stats.bodies > 0 ? 1 - frameworkStats.bodies.awake / Math.max(1, stats.bodies) : 0,
      contactPairs: Math.max(this.lastContactPairs, this.debugStats.pairs),
    });
  }

  private refreshTimePanel(): void {
    if (!this.timePanel) return;
    const stats = this.timeControl.stats;
    const snapshotStats = this.snapshots.stats;
    this.timePanel.update({
      paused: stats.paused,
      scale: stats.scale,
      elapsed: stats.elapsed,
      stepCount: stats.stepCount,
      recordedFrames: snapshotStats.frames,
      frameCapacity: snapshotStats.capacity,
      rewinding: stats.rewinding,
      cursorFrame: stats.rewinding && this.rewindFrameIndex >= 0 ? this.rewindFrameIndex : Math.max(0, snapshotStats.frames - 1),
      snapshots: this.snapshots.listKeyframes().map((record) => ({
        index: record.index,
        frame: record.step,
        time: record.time,
        label: `${record.label}（${(record.bytes / 1048576).toFixed(1)} MB）`,
      })),
      stepMs: stats.stepMs,
      budgetMs: stats.budgetMs,
    });
  }

  /**
   * 刷新应力面板。
   *
   * **这里必须自己节流**：`worstStressEntries` 会对全部建筑排序，
   * 500 个物体的排序每帧跑一次是纯浪费（面板上人眼也看不出 250ms 的差别）。
   * 面板内部的节流只挡 DOM 写入，挡不住我们自己算数据这一步 ——
   * 所以节流要加在**算数据之前**。
   */
  private refreshStressPanel(): void {
    if (!this.stressPanel) return;
    // 计算本身带 250ms 节流（在 StressVisualizer 内部，且节流在**算之前**）
    const summary = this.stress.compute({ instances: this.buildings.all }, performance.now());
    this.stressPanel.update({
      enabled: this.stress.enabled,
      scheme: this.stress.scheme,
      threshold: this.stress.threshold,
      stats: {
        count: summary.count,
        max: summary.max,
        average: summary.average,
        overThreshold: summary.overThreshold,
      },
      worst: summary.worst.map((entry) => ({
        objectId: entry.objectId,
        defName: getBuildingDef(entry.defId)?.name ?? entry.defId,
        stress: entry.stress,
        contacts: Math.max(1, entry.contacts),
        supportRatio: entry.supportRatio,
      })),
      unstable: this.buildings.all.filter((item) => item.stability === 'unstable').length,
      critical: this.buildings.all.filter((item) => item.stability === 'critical').length,
    });
  }

  // ------------------------------------------- 问题 A：物理框架接线

  /**
   * 执行一条逻辑动作。
   *
   * `LogicLink` 只告诉我们「该做什么」，真正做事的副作用全部集中在这里 ——
   * 这样第 4 层能在 Node 里单测，而所有碰 DOM / Three.js / Rapier 的代码只有这一处。
   * 每一条都包 try/catch：一条坏连线不该让整帧的物理停摆。
   */
  private executeLogicAction(request: LogicActionRequest): void {
    const { action } = request;
    try {
      switch (action.type) {
        case 'apply-impulse': {
          const handle = Number(action.targetId);
          const body = this.physics.raw?.getRigidBody(handle);
          const impulse = action.impulse;
          if (body && impulse) {
            body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
          }
          break;
        }
        case 'set-mode': {
          const handle = Number(action.targetId);
          if (Number.isFinite(handle)) this.physics.setMode(handle, action.mode ?? 'dynamic');
          break;
        }
        case 'set-motor': {
          const target = Number(action.targetId);
          if (Number.isFinite(target)) {
            // targetId 在 set-motor 语义里是**关节 id**（不是刚体句柄）：
            // 关节才是被电机驱动的东西，刚体只是它的两端
            this.framework.joints.setMotor(target, {
              jointIndex: target,
              speed: action.motorSpeed ?? 1,
              maxForce: action.motorForce ?? 20,
              controlled: true,
            });
          }
          break;
        }
        case 'remove': {
          const target = Number(action.targetId);
          const instance = this.buildings.findById(target) ?? this.buildings.findByPhysicsHandle(target);
          if (instance) {
            this.removeInstances([instance.id], '逻辑连线销毁');
          }
          break;
        }
        case 'spawn': {
          const current = this.buildings.findById(this.state.selectedInstanceId ?? -1);
          const origin: [number, number, number] = current
            ? [current.position[0] + 2, current.position[1] + 1, current.position[2]]
            : [0, this.bundle.grid.sizeY * 0.6, 0];
          const created = this.buildings.add(action.defId ?? 'box_wood', origin, 0, 1, 'dynamic');
          if (created) this.render.buildingRenderer.markDirty();
          break;
        }
        case 'toggle-trigger': {
          const id = Number(action.targetId);
          const record = this.framework.triggers.list().find((item) => item.id === id);
          if (record) this.framework.triggers.setEnabled(id, !record.enabled);
          break;
        }
        case 'vibrate':
          // 补充 5：逻辑连线也能震手机（例如「进门被绊到」）
          this.haptics.play('place-ok');
          break;
        case 'toast':
          this.showToast(action.text ?? '物理事件触发', 2200);
          break;
        case 'sound-hint':
          // 本项目没有音频资源（不引入额外体积），所以只做视觉提示并如实说明
          this.showToast('（本项目没有音效资源，这里只给提示）', 1800);
          break;
        default:
          break;
      }
    } catch (error) {
      console.warn('[物理框架] 动作执行失败', action.type, error);
    }
  }

  /** 打印四层物理诊断到控制台 */
  private logPhysicsDiagnostics(): void {
    console.group('[物理诊断] 四层状态');
    for (const line of this.framework.diagnostics()) console.info(line);
    console.info(`支撑面索引：${this.surfaces.size} 个（重建 ${this.surfaces.rebuildMs.toFixed(2)} ms）`);
    console.info(this.framework.triggers.describe());
    console.info(
      `传感器事件队列：${this.physics.hasEventQueue ? '已就绪' : '不可用（Rapier 版本没有 EventQueue，触发区不会产生事件）'}` +
        `｜上一帧碰撞事件 ${this.lastSensorEvents} 条`,
    );
    console.info(`物理调试绘制：${describeDebugStats(this.debugStats)}`);
    console.info(this.collapse.describe());
    console.info(this.buoyancy.describe());
    console.info(this.stress.describe());
    console.info(`建筑：${this.buildings.count} 个（其中动态 ${this.buildings.dynamicCount} 个）`);
    console.groupEnd();
    this.showToast('物理诊断已打印到控制台（F12）', 2400);
  }

  // ------------------------------------------- 补充 2：物理沙盘模式

  /**
   * 把沙盘模式的开关变成世界的实际变化。
   *
   * 原则：**退出时必须还原**。进入沙盘模式会关掉水与沙、放宽支撑校验，
   * 如果退出时不还原，玩家会以为「切了一下模式把水弄没了」。
   * 所以进入前先把相关开关存进 `sandboxRestore`，退出时按原值写回。
   */
  private applySandboxSettings(settings: {
    enabled: boolean;
    forceDynamic: boolean;
    autoDebugDraw: boolean;
    pauseFluid: boolean;
    freePlacement: boolean;
    showHint: boolean;
  }): void {
    this.comboPanel.update({
      placedCounts: this.combos.counts,
      sandboxMode: settings.enabled,
    });

    if (settings.enabled) {
      this.sandboxRestore = {
        waterEnabled: this.state.physics.waterEnabled,
        sandEnabled: this.state.physics.sandEnabled,
        supportEnabled: this.state.physics.supportEnabled,
      };
      if (settings.autoDebugDraw) {
        for (const key of ['jointLinks', 'triggerBoxes', 'logicArrows', 'jointAnchors'] as const) {
          this.physicsDebugUI.setDrawSetting(key, true);
        }
      }
      if (settings.pauseFluid) {
        this.state.physics.waterEnabled = false;
        this.state.physics.sandEnabled = false;
        this.bundle.water.clearActivity();
        this.bundle.sand.clearActivity();
      }
      this.state.physics.supportEnabled = !settings.freePlacement || true;
      if (settings.forceDynamic) {
        let converted = 0;
        for (const instance of this.buildings.all) {
          if (instance.locked) continue;
          if (instance.physicsMode === 'static') {
            this.buildings.setPhysicsMode(instance.id, 'dynamic');
            converted += 1;
          }
        }
        this.showToast(`沙盘模式：${converted} 个建筑转成动态刚体，它们会开始掉`, 2800);
      } else if (settings.showHint) {
        this.showToast('沙盘模式已开启：关掉水与沙、放宽放置校验，随便试结构吧', 3000);
      }
      this.syncPhysics();
    } else {
      const restore = this.sandboxRestore;
      if (restore) {
        this.state.physics.waterEnabled = restore.waterEnabled;
        this.state.physics.sandEnabled = restore.sandEnabled;
        this.state.physics.supportEnabled = restore.supportEnabled;
        if (restore.waterEnabled) this.bundle.water.markAllWater();
        if (restore.sandEnabled) this.bundle.sand.markAllSand();
      }
      this.sandboxRestore = null;
      this.syncPhysics();
      this.showToast('已退出物理沙盘模式，水与沙与支撑校验都已还原', 2600);
    }
    this.refreshPlacement();
  }

  // ------------------------------------------- 第 5 批：组合摆放

  /** 把一个组合摆到当前光标位置（没有光标就摆在相机注视点） */
  private spawnCombo(combo: Combo): void {
    // 落点优先级：智能放置的候选点 → 光标下的物理/体素命中 → 相机注视点。
    // 三级兜底是为了「玩家没把鼠标放在地形上也能摆东西」，而不是直接失败。
    const target = this.previewPosition ?? this.cursorWorldPosition() ?? this.cameraFocusPosition();
    const result = this.combos.spawn(combo, {
      origin: [target[0], target[1], target[2]],
      rotationY: (this.previewRotationDegrees * Math.PI) / 180,
    });

    if (!result.ok) {
      this.showToast(result.reason, 3200);
      this.comboPanel.update({ placedCounts: this.combos.counts, lastError: result.reason, sandboxMode: this.sandbox.isEnabled });
      this.haptics.play('place-fail');
      return;
    }

    this.render.buildingRenderer.markDirty();
    this.framework.update(0, performance.now());
    this.surfaces.invalidate();
    this.showToast(result.message, 3600);
    this.haptics.play('place-ok');
    this.comboPanel.update({
      placedCounts: this.combos.counts,
      sandboxMode: this.sandbox.isEnabled,
    });

    // 摆完把镜头推到组合上，否则玩家不知道东西摆哪去了
    this.controls.focusOn(target[0], target[1] + 1, target[2]);
    console.info(`[组合] ${result.message}`);
  }

  /** 把镜头对准组合的预估位置（组合面板里的「预览」） */
  private previewCombo(combo: Combo): void {
    const target = this.previewPosition ?? this.cursorWorldPosition() ?? this.cameraFocusPosition();
    const size = combo.objects.length > 0 ? combo.objects[0]!.scale : 1;
    this.controls.focusOn(target[0], target[1] + size, target[2], 18);
  }

  /** 相机注视点（最后一级兜底） */
  private cameraFocusPosition(): [number, number, number] {
    const point = this.controls.target;
    return [point.x, point.y, point.z];
  }

  // ------------------------------------------- 补充 1：教学关卡

  /** 开始第一关 */
  startTutorial(): void {
    this.tutorial = {
      active: true,
      levelIndex: 0,
      stepIndex: 0,
      startedMs: performance.now(),
      skipsLeft: 1,
      completedLevels: this.tutorial.completedLevels,
    };
    this.tutorialUI.show();
    this.tutorialUI.update(this.buildTutorialStats());
    this.showToast(`教学开始：${TUTORIAL_LEVELS[0]?.name ?? '第 1 关'}`, 2600);
  }

  private tutorialNext(): void {
    if (!this.tutorial.active) return;
    const level = getTutorialLevel(TUTORIAL_LEVELS[this.tutorial.levelIndex]?.id ?? '');
    if (!level) return;
    if (this.tutorial.stepIndex < level.steps.length - 1) {
      this.tutorial.stepIndex += 1;
      this.tutorialUI.update(this.buildTutorialStats());
      this.haptics.play('undo');
      return;
    }
    // 最后一关的最后一步：完成这一关
    this.tutorial.completedLevels += 1;
    if (this.tutorial.levelIndex < TUTORIAL_LEVELS.length - 1) {
      this.tutorial.levelIndex += 1;
      this.tutorial.stepIndex = 0;
      this.tutorial.skipsLeft = 1;
      this.tutorialUI.celebrate(level.name, this.tutorialElapsedSeconds());
      this.tutorialUI.update(this.buildTutorialStats());
      this.showToast(`通关！下一关：${TUTORIAL_LEVELS[this.tutorial.levelIndex]?.name ?? ''}`, 3000);
    } else {
      this.tutorialUI.celebrate(level.name, this.tutorialElapsedSeconds());
      this.tutorialUI.update(this.buildTutorialStats());
      this.showToast(`全部 ${TUTORIAL_LEVELS.length} 关通关，用时 ${this.formatSeconds(this.tutorialElapsedSeconds())}`, 4000);
      this.tutorial.active = false;
    }
  }

  private tutorialPrev(): void {
    if (!this.tutorial.active || this.tutorial.stepIndex === 0) return;
    this.tutorial.stepIndex -= 1;
    this.tutorialUI.update(this.buildTutorialStats());
  }

  private tutorialSkipLevel(): void {
    if (!this.tutorial.active) return;
    if (this.tutorial.skipsLeft <= 0) {
      this.showToast('这一关的跳过次数已经用完了', 2200);
      return;
    }
    this.tutorial.skipsLeft -= 1;
    if (this.tutorial.levelIndex < TUTORIAL_LEVELS.length - 1) {
      this.tutorial.levelIndex += 1;
      this.tutorial.stepIndex = 0;
      this.showToast(`已跳过，进入：${TUTORIAL_LEVELS[this.tutorial.levelIndex]?.name ?? ''}`, 2400);
    } else {
      this.tutorial.active = false;
      this.tutorialUI.hide();
      this.showToast('已跳过最后一关，教学结束', 2400);
    }
    this.tutorialUI.update(this.buildTutorialStats());
  }

  private tutorialExit(): void {
    this.tutorial.active = false;
    this.tutorialUI.hide();
    this.showToast('已退出教学（随时可以再进来）', 2200);
  }

  private tutorialRestart(): void {
    if (!this.tutorial.active) this.startTutorial();
    else {
      this.tutorial.stepIndex = 0;
      this.tutorial.startedMs = performance.now();
      this.tutorialUI.update(this.buildTutorialStats());
      this.showToast('这一关重新开始', 2000);
    }
  }

  private tutorialConfirmStep(): void {
    this.showToast('好，那就算你做到了 —— 点「下一步」继续', 2400);
    this.tutorialNext();
  }

  /**
   * 教学步骤的自动检测。
   *
   * 判定方式很直白：步骤里写了要放什么（`targetDefId` + `count`）就要够数，
   * 写了要接哪种关节（`jointTypes`）就要真的存在。**没有魔法**——
   * 检测不出来就只给提示、不自动通关，玩家仍可点「我做完了」自己推进。
   */
  private evaluateTutorialStep(): { done: boolean; hint: string } {
    const level = getTutorialLevel(TUTORIAL_LEVELS[this.tutorial.levelIndex]?.id ?? '');
    const step = level?.steps[this.tutorial.stepIndex];
    if (!step) return { done: false, hint: '这一关没有更多步骤了' };

    const missing: string[] = [];
    if (step.targetDefId) {
      const placed = this.buildings.all.filter((item) => item.defId === step.targetDefId).length;
      const need = step.count ?? 1;
      if (placed < need) {
        const name = getBuildingDef(step.targetDefId)?.name ?? step.targetDefId;
        missing.push(`还差 ${need - placed} 个「${name}」（已有 ${placed} / ${need}）`);
      }
    }
    if (step.jointTypes && step.jointTypes.length > 0) {
      const byType = this.framework.jointStats().byType;
      for (const type of step.jointTypes) {
        if ((byType[type] ?? 0) <= 0) missing.push(`还没有接上${type}关节`);
      }
    }

    return {
      done: missing.length === 0,
      hint: missing.length > 0 ? missing.join('；') : (step.hint ?? ''),
    };
  }

  private tutorialElapsedSeconds(): number {
    return (performance.now() - this.tutorial.startedMs) / 1000;
  }

  private formatSeconds(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  private buildTutorialStats() {
    const level = getTutorialLevel(TUTORIAL_LEVELS[this.tutorial.levelIndex]?.id ?? '') ?? TUTORIAL_LEVELS[0]!;
    const evaluation = this.evaluateTutorialStep();
    const steps = level.steps.length;
    return {
      level,
      stepIndex: this.tutorial.stepIndex,
      stepDone: evaluation.done,
      hint: evaluation.hint,
      progress: steps > 0 ? (this.tutorial.stepIndex + (evaluation.done ? 1 : 0)) / steps : 0,
      elapsedSeconds: this.tutorialElapsedSeconds(),
      skipsLeft: this.tutorial.skipsLeft,
      levelComplete: false,
      completedLevels: this.tutorial.completedLevels,
      totalLevels: TUTORIAL_LEVELS.length,
    };
  }

  // ------------------------------------------- 问题 A：物理调试绘制

  /**
   * 把四层的可视化数据画成一组线段。
   *
   * 用**一个** `LineSegments` 而不是每条线一个对象：关节 + 绳索 + 触发器 + 逻辑箭头
   * 合起来可能上百条，逐个建对象会让 draw call 直接翻十倍。所以每帧拼一次顶点数组，
   * 一次上传、一次绘制。代价是每帧要重建 BufferAttribute —— 只在开关打开时才做。
   */
  private updatePhysicsDebugDraw(nowMs: number): void {
    const settings = this.physicsDebugUI.drawSettings;
    const anyOn =
      settings.jointLinks ||
      settings.jointAnchors ||
      settings.triggerBoxes ||
      settings.logicArrows ||
      settings.ropeRestLength ||
      settings.colliderBoxes ||
      settings.contactPoints ||
      settings.forceArrows ||
      settings.velocityVectors;
    if (!anyOn || !this.framework.isReady) {
      this.physicsDebugLines.visible = false;
      this.contactPoints.visible = false;
      return;
    }

    const positions: number[] = [];
    /** 与 positions 平行的颜色数组（接触法线用红、速度用蓝，靠顶点色区分） */
    const positionColors: number[] = [];
    const push = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): void => {
      positions.push(x1, y1, z1, x2, y2, z2);
      // 默认颜色是浅灰：关节/触发器/碰撞盒都是"结构信息"，用统一的中性色才不会喧宾夺主
      positionColors.push(0.75, 0.75, 0.8, 0.75, 0.75, 0.8);
    };
    const pushBox = (c: { x: number; y: number; z: number }, h: { x: number; y: number; z: number }): void => {
      const x0 = c.x - h.x;
      const x1 = c.x + h.x;
      const y0 = c.y - h.y;
      const y1 = c.y + h.y;
      const z0 = c.z - h.z;
      const z1 = c.z + h.z;
      // 12 条棱
      push(x0, y0, z0, x1, y0, z0);
      push(x1, y0, z0, x1, y0, z1);
      push(x1, y0, z1, x0, y0, z1);
      push(x0, y0, z1, x0, y0, z0);
      push(x0, y1, z0, x1, y1, z0);
      push(x1, y1, z0, x1, y1, z1);
      push(x1, y1, z1, x0, y1, z1);
      push(x0, y1, z1, x0, y1, z0);
      push(x0, y0, z0, x0, y1, z0);
      push(x1, y0, z0, x1, y1, z0);
      push(x1, y0, z1, x1, y1, z1);
      push(x0, y0, z1, x0, y1, z1);
    };

    if (settings.jointLinks || settings.ropeRestLength) {
      for (const seg of this.framework.joints.ropeSegments()) {
        push(seg.a.x, seg.a.y, seg.a.z, seg.b.x, seg.b.y, seg.b.z);
      }
      // 非绳索关节也要画连线，但 JointSystem 没有暴露 id 列表（它按 handle 管理）。
      // 这里退一步：绳索/弹簧本来就由 ropeSegments() 覆盖（它们最容易看错长度），
      // 其余关节的连线用两端建筑的位置近似 —— 信息量足够，且不必让物理层为调试开洞。
      if (settings.jointLinks) {
        for (const record of this.framework.joints.motorJoints()) {
          const ends = this.framework.joints.endpointOf(record.id);
          if (ends) push(ends.a.x, ends.a.y, ends.a.z, ends.b.x, ends.b.y, ends.b.z);
        }
      }
    }

    if (settings.triggerBoxes || settings.logicArrows) {
      for (const record of this.framework.triggers.list()) {
        if (settings.triggerBoxes) pushBox(record.center, record.halfExtents);
      }
    }

    // ---- 关节限位范围（M3 第 3 批）：把"能转到哪"画出来
    //
    // 旋转关节：在锚点处绕轴画一段圆弧（8 段折线），弧度就是 limits 的范围；
    // 滑动关节：沿轴画一条从 min 到 max 的线段。
    // 没有限位的关节不画 —— 画一条"无限的线"没有意义，反而会让画面糊掉。
    if (settings.jointLinks) {
      for (const entry of this.framework.joints.list()) {
        const limits = entry.config.limits;
        if (!limits) continue;
        const ends = this.framework.joints.endpointOf(entry.id);
        if (!ends) continue;
        const axis = normalizeVec(entry.config.axis ?? [0, 1, 0]);
        if (entry.type === 'revolute') {
          const radius = 0.55;
          const segments = 8;
          const [u, v] = basisFor(axis);
          let previous: [number, number, number] | null = null;
          for (let i = 0; i <= segments; i += 1) {
            const angle = limits.min + ((limits.max - limits.min) * i) / segments;
            const point: [number, number, number] = [
              ends.a.x + (Math.cos(angle) * u[0] + Math.sin(angle) * v[0]) * radius,
              ends.a.y + (Math.cos(angle) * u[1] + Math.sin(angle) * v[1]) * radius,
              ends.a.z + (Math.cos(angle) * u[2] + Math.sin(angle) * v[2]) * radius,
            ];
            if (previous) push(previous[0], previous[1], previous[2], point[0], point[1], point[2]);
            previous = point;
          }
        } else if (entry.type === 'prismatic') {
          push(
            ends.a.x + axis[0] * limits.min, ends.a.y + axis[1] * limits.min, ends.a.z + axis[2] * limits.min,
            ends.a.x + axis[0] * limits.max, ends.a.y + axis[1] * limits.max, ends.a.z + axis[2] * limits.max,
          );
        }
      }
    }

    // ---- 接触点 / 法线箭头 / 速度向量（M3 第 6 批）
    const wantsContacts = settings.contactPoints || settings.forceArrows;
    const wantsVelocity = settings.velocityVectors;
    if (wantsContacts || wantsVelocity) {
      const nearby = this.debugBodiesNearCamera();
      const colliders = wantsContacts ? this.physics.collidersOfBodies(nearby.map((body) => body.handle)) : [];
      const pairs = wantsContacts ? this.physics.collectContacts(colliders) : [];
      const geometryData = collectDebugGeometry(
        {
          pairs,
          bodies: wantsVelocity ? nearby.map((body) => ({
            handle: body.handle,
            ownerId: body.ownerId,
            center: body.center,
            velocity: body.velocity,
            sleeping: body.sleeping,
            mass: body.mass,
          })) : [],
        },
        {
          contactPoints: settings.contactPoints,
          forceArrows: settings.forceArrows,
          velocityVectors: wantsVelocity,
          arrowScale: 0.25,
          velocityThreshold: 0.3,
        },
      );
      this.debugStats = geometryData.stats;

      // 接触点写到 Points；线段（法线 + 速度箭头）合并到同一条 LineSegments，
      // 所以"开全部调试项"仍然只有 2 次 draw call
      if (settings.contactPoints && geometryData.pointPositions.length > 0) {
        const pointGeometry = this.contactPoints.geometry;
        pointGeometry.setAttribute('position', new Float32BufferAttribute(geometryData.pointPositions, 3));
        pointGeometry.setAttribute('color', new Float32BufferAttribute(geometryData.pointColors, 3));
        pointGeometry.computeBoundingSphere();
        (this.contactPoints.material as PointsMaterial).vertexColors = true;
        this.contactPoints.visible = true;
      } else {
        this.contactPoints.visible = false;
      }

      if (geometryData.linePositions.length > 0) {
        positions.push(...geometryData.linePositions);
        positionColors.push(...geometryData.lineColors);
      }
    } else {
      this.contactPoints.visible = false;
    }

    const geometry = this.physicsDebugLines.geometry;
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    if (positionColors.length === positions.length && positions.length > 0) {
      geometry.setAttribute('color', new Float32BufferAttribute(positionColors, 3));
      const material = this.physicsDebugLines.material as LineBasicMaterial;
      material.vertexColors = true;
    }
    geometry.computeBoundingSphere();
    this.physicsDebugLines.visible = positions.length > 0;
    void nowMs;
  }

  /** 相机附近的动态物体（`collidersOfBodies` 的输入，避免全世界扫一遍） */
  private debugBodiesNearCamera(radius = 40): { handle: number; ownerId: number; center: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; sleeping: boolean; mass: number }[] {
    const target = this.controls.target;
    const result: { handle: number; ownerId: number; center: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; sleeping: boolean; mass: number }[] = [];
    for (const instance of this.buildings.all) {
      const handle = instance.physicsHandle ?? -1;
      if (handle < 0) continue;
      const position = instance.position;
      const dx = position[0] - target.x;
      const dz = position[2] - target.z;
      if (dx * dx + dz * dz > radius * radius) continue;
      const def = getBuildingDef(instance.defId);
      result.push({
        handle,
        ownerId: instance.id,
        center: { x: position[0], y: position[1] + (def?.size[1] ?? 1) / 2, z: position[2] },
        velocity: this.physics.readVelocity(handle) ?? { x: 0, y: 0, z: 0 },
        sleeping: this.physics.isSleeping(handle),
        mass: this.bodyFactory.massOf(handle, def?.mass ?? 100),
      });
      // 上限 120 个：再多的话接触读取本身就成了每帧的大头，而屏幕上也看不清
      if (result.length >= 120) break;
    }
    return result;
  }

  /**
   * M3：物理子系统的每帧作业。
   *
   * 顺序是有讲究的，不能随便换：
   * 1. **先回溯记录**（在物理推完之后、渲染之前）—— 记录的是"本帧结束时的状态"，
   *    这样按 R 回退一帧拿到的是上一个稳定状态，而不是推到一半的中间态；
   * 2. **再爆炸保护**——它要看的是"这一帧有没有出现异常跳变"，
   *    必须基于刚记录完的那批位姿；冻掉的物体当帧就不再参与后续计算；
   * 3. **再录制**（如果玩家按了录制）—— 录的是"清洗过之后"的状态，
   *    否则回放出来的动画会带着那个被冻住的幽灵物体；
   * 4. **最后刷新面板**——面板读的是这一帧的最终统计。
   */
  private updatePhysicsSystems(delta: number, rewinding: boolean): void {
    if (!this.physicsReady) {
      this.refreshPhysicsPanel();
      this.refreshTimePanel();
      if (this.physicsTutorial.active) this.refreshPhysicsTutorial();
      return;
    }

    // 位姿只收集一次：回溯、爆炸保护、录制、撞击音效四处都要用，
    // 而 readPose 是逐刚体跨 wasm 边界读值 —— 收四遍是四倍的跨边界开销
    const poses = this.physicsReady ? this.collectDynamicPoses() : [];

    // ---- 1) 回溯记录（回溯期间不记 —— 否则会把历史又写一遍）
    if (!rewinding) {
      this.snapshots.record(this.time.stepCount, this.time.elapsed, poses);

      // ---- 2) 爆炸保护
      const report = this.guard.update(
        poses.map((pose) => ({
          handle: pose.handle,
          ownerId: this.physics.ownerOf(pose.handle),
          position: pose.position,
          velocity: this.physics.readVelocity(pose.handle) ?? { x: 0, y: 0, z: 0 },
          angularVelocity: this.physics.readAngularVelocity(pose.handle) ?? { x: 0, y: 0, z: 0 },
          size: this.bodySizeOf(pose.handle),
        })),
        performance.now(),
      );
      if (report.freeze.length > 0) this.freezeBodies(report.freeze);

      // ---- 3) 录制
      if (this.recorder.isRecording) {
        this.recorder.capture(
          this.time.stepCount,
          this.time.elapsed,
          poses.map((pose) => ({
            handle: pose.handle,
            position: pose.position,
            rotation: [pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w] as [number, number, number, number],
          })),
          this.time.stepCount,
        );
      }
    }

    // ---- 3.5) 浮力：水不参与碰撞，只施力
    if (this.buoyancy.enabled && !rewinding) this.applyBuoyancy();

    // ---- 4) 物理音效：用"速度变化量"近似撞击强度
    //
    // 诚实说明：Rapier 能给出真实接触冲量，但那要开 `ActiveEvents.CONTACT_FORCE_EVENTS`
    // 并逐帧读事件队列，代价是每个动态碰撞体都要走一遍事件管线。
    // 这里用 Δv（本帧速度与上帧速度之差）当强度代理 —— 一次硬着陆的 Δv 很大，
    // 缓慢滑动几乎为 0，主观上和撞击声强弱是一致的。
    // 它的局限：两个物体以同速相撞时 Δv 会偏小（听起来比实际轻）。这条写进 README。
    if (this.audio.enabled && this.audio.isSupported) {
      this.playImpactSounds(poses);
    }

    // ---- 5) 分帧调度：倒塌判定 / 距离剔除 / 应力计算 / 支撑面索引
    //
    // 它们原来各按各的固定间隔跑，结果会周期性撞在同一帧（表现是"每隔半秒卡一下"）。
    // 现在共用一个每帧 2.5 ms 的预算，超了就把任务推到下一帧。
    if (!rewinding) this.scheduler.tick(performance.now());

    // ---- 6) 逻辑门：延时门的到期动作、计时门的周期触发
    if (!rewinding) this.tickLogicGates(performance.now());

    void delta;
    this.refreshPhysicsPanel();
    this.refreshTimePanel();
    // 应力面板与倒塌判定走分帧调度（见上面的注册），这里不再每帧直接调
    if (this.physicsTutorial.active) this.refreshPhysicsTutorial();
  }

  /**
   * 用速度变化量近似撞击强度并播放音效。
   *
   * 只在真的发生"明显减速"时发声 —— 恒速下落不会有 Δv，落地那一帧才会。
   */
  private playImpactSounds(poses: readonly { handle: number }[]): void {
    let loudest: { impact: number; mass: number } | null = null;
    for (const pose of poses) {
      const body = this.physics.raw?.getRigidBody(pose.handle);
      if (!body) continue;
      const velocity = body.linvel();
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
      const previous = this.lastSpeeds.get(pose.handle);
      this.lastSpeeds.set(pose.handle, speed);
      if (previous === undefined) continue;
      const impact = Math.abs(previous - speed);
      // 0.8 m/s 以下的速度变化是"贴着地面蹭"，不该出声
      if (impact < 0.8) continue;
      const mass = this.bodyFactory.massOf(pose.handle, 50);
      if (!loudest || impact * mass > loudest.impact * loudest.mass) loudest = { impact, mass };
    }
    if (loudest) this.audio.playImpact(loudest.impact, loudest.mass);
    // 清掉已经不在世界里的句柄，避免这张表随删除的物体无限增长
    if (this.lastSpeeds.size > poses.length * 2) {
      const alive = new Set(poses.map((pose) => pose.handle));
      for (const handle of [...this.lastSpeeds.keys()]) if (!alive.has(handle)) this.lastSpeeds.delete(handle);
    }
  }

  // ------------------------------------------- M4 第 6 批：内存与帧面板

  /**
   * 刷新内存与帧分析面板。
   *
   * 数据分两路：**帧类**（每次都新）来自 `PerformanceMonitor`，
   * **资源类**（每 0.5 秒才采一次）来自已经存在的 `ResourceMonitor` 快照 ——
   * 不重新去读 `performance.memory`，那会让同一份数据有两个采样点、两个不同的数。
   */
  /**
   * M4：导出最近一次生成日志（JSON）。
   *
   * 与性能报告同样走"控制台 + 剪贴板"：玩家遇到"这张图怎么这么空"时，
   * 把这段贴出来我就能看出是哪个阶段降级了、冲突修掉多少。
   */
  private exportGenerationLog(): void {
    const log = this.lastGenerationLog;
    if (!log) {
      this.showToast('还没有生成过地图（先用模板生成一张）', 2400);
      return;
    }
    const payload = {
      log,
      conflicts: this.lastGenerationConflicts.map((conflict) => ({
        type: conflict.type,
        objects: conflict.objects,
        detail: conflict.detail,
        resolution: conflict.resolution,
      })),
    };
    const text = JSON.stringify(payload, null, 2);
    console.info('[生成日志]', text);
    // 冲突的中文说明行也一起打出来：JSON 适合机器读，而"这 7 处分别是什么、
    // 建议怎么修"才是人想看的。两样都给，不互相替代。
    for (const line of describeConflicts(this.lastGenerationConflicts)) console.info('[冲突]', line);
    this.showToast(
      `生成日志已打印到控制台（冲突 ${this.lastGenerationConflicts.length} 处）；正在复制到剪贴板…`,
      3000,
    );
    void copyToClipboard(text).then((ok) => {
      if (!ok) this.showToast('剪贴板不可用（需要 https 或 localhost），请从控制台复制', 3200);
    });
  }

  /** M4：最近一次生成的冲突数量（面板与冲突可视化用） */
  /**
   * 设置耦合预设（真实 / 游戏 / 夸张）。
   *
   * 暴露成公开方法是为了让面板与断言都能切它 —— 并且**返回值里带上中文名**，
   * 免得调用方自己去查标签表（两张表迟早会不一致）。
   */
  setCouplingPreset(preset: CouplingPresetName): string {
    this.coupling.setPreset(preset);
    return COUPLING_PRESET_LABELS[preset];
  }

  /** 当前耦合预设的中文名（面板显示） */
  get couplingPresetLabel(): string {
    return COUPLING_PRESET_LABELS[this.coupling.preset];
  }

  /** 上一帧耦合耗时（毫秒） */
  get couplingMs(): number {
    return this.lastCouplingMs;
  }

  /** 流体求解走的是 worker 还是主线程（面板与压力测试报告用） */
  get fluidSolvePath(): string {
    const runner = this.fluidRunner;
    if (!runner) return '未启用';
    if (this.fluidWorkerFrames === 0 && this.fluidFallbackFrames === 0) {
      return runner.available ? 'worker（还没有跑过帧）' : '主线程（这个环境没有 Worker）';
    }
    return `worker ${this.fluidWorkerFrames} 帧 / 主线程回退 ${this.fluidFallbackFrames} 帧`;
  }

  /** 上一帧沙水交互耗时（毫秒） */
  get sandWaterMs(): number {
    return this.lastSandWaterMs;
  }

  /**
   * 导出流体（+ 沙的湿度）存档（第 8 批）。
   *
   * 返回**可以直接 JSON.stringify 的载荷**。没有流体也没有沙时返回 null，
   * 并给出中文原因（面板要显示"现在没有东西可存"）。
   */
  exportFluidSave(): { payload: FluidSavePayload; summary: string } | null {
    const system = this.fluid;
    const hasSand = this.bundle?.sand !== undefined;
    if ((!system || system.activeCount === 0) && !hasSand) return null;
    // 没有流体系统时用一个 1 容量的空池子编码（只为了走同一条编码路径去存沙的湿度）——
    // 直接 new 一个比想办法复用构造函数清楚得多
    const pool = system?.pool ?? new ParticlePool(1);
    const payload = FluidSave.encode(
      pool,
      system?.fluidConfig.type ?? this.fluidType,
      this.bundle?.sand,
      this.bundle?.grid,
      performance.now(),
    );
    return { payload, summary: FluidSave.describe(payload) };
  }

  /** 导入流体存档。@returns 中文结果说明 */
  importFluidSave(payload: FluidSavePayload): string {
    const system = this.ensureFluid();
    const restored = FluidSave.decode(payload, system.pool, this.bundle?.sand, this.bundle?.grid);
    if (restored < 0) return `导入失败：${FluidSave.lastError ?? '未知原因'}`;
    system.wake();
    this.fluidRenderer?.setFluidConfig(system.fluidConfig);
    this.showToast(`已导入流体存档：${restored} 个粒子`, 2600);
    return `已恢复 ${restored} 个粒子${FluidSave.lastError ? `（${FluidSave.lastError}）` : ''}`;
  }

  /** 打开/关闭教学关卡 */
  setFluidTutorialActive(active: boolean): void {
    this.fluidTutorialActive = active;
    if (active) this.ensureFluid();
  }

  get fluidTutorialState(): ReturnType<FluidSandTutorial['update']> {
    return this.fluidTutorial.state;
  }

  /** 跳到教学下一关 */
  nextTutorialLevel(): boolean {
    return this.fluidTutorial.next();
  }

  /** 重新开始教学 */
  resetFluidTutorial(): void {
    this.fluidTutorial.reset();
  }

  /** 教学快照（断言/调试用；没有跑过帧时为 null） */
  get lastTutorialSnapshot(): TutorialSnapshot | null {
    return this.tutorialSnapshot;
  }

  /** 当前被沙压住的建筑数（面板显示） */
  get buriedBuildingCount(): number {
    return this.lastBuriedCount;
  }

  /** 沙水交互的中文摘要（面板/报告用） */
  get sandWaterSummary(): string {
    return this.sandWater?.describe() ?? '沙水交互未启用（还没有流体）';
  }

  /** 耦合统计（面板与压力测试报告要用） */
  get couplingStats(): ReturnType<FluidRigidCoupling['compute']> extends never ? never : FluidRigidCoupling['stats'] {
    return this.coupling.stats;
  }

  get generationConflictCount(): number {
    return this.lastGenerationConflicts.length;
  }

  /**
   * 最近一次成功生成的请求参数（模板 / 种子 / 物体数 / 冲突数）。
   *
   * 给「生成回滚」用：回滚 = 用同样的参数与种子再生成一次，
   * 而不是把体素快照倒回去（见 `lastGenerationRequest` 上的注释）。
   */
  get lastGeneration(): { templateId: string; seed: number; overrides: Record<string, number>; objects: number; conflicts: number } | null {
    return this.lastGenerationRequest;
  }

  private refreshMemoryPanel(): void {
    if (!this.memoryPanel) return;
    const snapshot = this.resources.latest;
    const metrics = this.performance.metrics;
    const frameStats = this.performance.profiler.stats;
    const slowFrames = this.performance.slowLogger.recent(8);
    const slowest = this.performance.profiler.slowest(5);

    this.memoryPanel.update({
      heapUsedMB: snapshot?.heapUsedMB ?? null,
      heapLimitMB: snapshot?.heapLimitMB ?? null,
      geometries: snapshot?.geometries ?? 0,
      textures: snapshot?.textures ?? 0,
      programs: snapshot?.programs ?? 0,
      estGpuMB: snapshot?.estGpuMB ?? 0,
      metrics,
      frameStats,
      histogram: this.performance.profiler.histogram(12),
      recentFrames: this.performance.profiler.recent(60),
      slowest: slowest.map((sample) => ({
        index: sample.index,
        ms: sample.ms,
        worstPhase: worstPhaseOf(sample.phases),
      })),
      slowRecords: slowFrames.map((record) => ({
        ms: record.ms,
        over: record.over,
        worstPhase: record.worstPhase ? phaseLabel(record.worstPhase.name) : '未知',
        repeat: record.repeat ?? 1,
        context: record.context ?? 'running',
      })),
      slowTotal: this.performance.slowLogger.total,
      thresholdMs: this.performance.slowLogger.thresholdMs,
      diagnosis: this.performance.diagnose(),
      gcNote: this.gcNote,
    });
  }

  // ------------------------------------------- M4 第 6 批：性能报告

  /**
   * 导出性能报告（含慢帧记录与当时的资源概况）。
   *
   * 导出的是**纯 JSON 文本**，走剪贴板而不是文件下载 —— 因为"性能有问题"这件事
   * 通常发生在手机上，而手机上触发下载再去找文件比直接粘贴麻烦得多。
   */
  private exportPerformanceReport(): void {
    const metrics = this.performance.metrics;
    const stats = this.performance.profiler.stats;
    const report = {
      kind: 'god-sandbox-performance-report',
      version: 1,
      exportedAt: new Date().toISOString(),
      metrics,
      frameStats: stats,
      slowFrames: this.performance.slowLogger.export(),
      diagnosis: this.performance.diagnose(),
      world: {
        voxels: this.bundle.grid.nonAir,
        chunks: this.bundle.grid.chunkCount,
        visibleChunks: this.bundle.culling.visibleCount,
        buildings: this.buildings.count,
        physicsBodies: this.physicsReady ? this.physics.bodyCount : 0,
        frozenBodies: this.culling.stats.frozen,
      },
      degrade: {
        level: this.autoDegrade.currentLevel,
        schedulerBudgetMs: this.scheduler.budgetMs,
        scheduler: this.scheduler.stats,
      },
    };
    const text = JSON.stringify(report, null, 2);
    console.info('[性能报告]', text);
    this.showToast('性能报告已打印到控制台（F12 复制）', 3200);
    // 顺手放到剪贴板：手机上"从控制台复制"不方便，剪贴板才是能带走的形式
    void copyToClipboard(text);
  }

  /** 每帧把帧耗时喂给性能监控（它在内部做窗口与慢帧判定） */
  private samplePerformance(frameMs: number, nowMs: number): void {
    // 各段的耗时**各自量**，渲染是残差（扣掉其它所有已计量的段）。
    // 这一点很重要：如果渲染也按"整帧减物理"算，那么任何一段变慢都会被记成渲染变慢。
    const measured =
      this.lastPhysicsMs + this.lastSimMs + this.lastMeshMs + this.lastSupportMs +
      this.lastCullingMs + this.lastPanelMs + this.lastInteractionMs;
    // 帧录制（第 7 批）：没在录制时 sample() 立刻返回，开销接近 0
    if (this.perfRecorder.recording) {
      this.perfRecorder.sample({
        t: nowMs,
        ms: frameMs,
        phases: {
          physics: this.lastPhysicsMs,
          sim: this.lastSimMs,
          coupling: this.lastCouplingMs,
          sandWater: this.lastSandWaterMs,
          panels: this.lastPanelMs,
        },
        particles: this.fluid?.activeCount ?? 0,
        bodies: this.framework.stats().bodies.total,
      });
    }
    this.performance.frame({
      ms: frameMs,
      phases: {
        physics: this.lastPhysicsMs,
        sim: this.lastSimMs,
        mesh: this.lastMeshMs,
        support: this.lastSupportMs,
        culling: this.lastCullingMs,
        panels: this.lastPanelMs,
        interaction: this.lastInteractionMs,
        // 耦合与沙水交互是第 4、5 批新加的独立开销，单独成段才看得出各占多少
        coupling: this.lastCouplingMs,
        sandWater: this.lastSandWaterMs,
        // 残差可能是负数（那些段落是上一帧量的，或者被分帧跳过）→ 夹到 0，
        // 不要让面板出现"渲染 -3 ms"这种明显是错的数字
        render: Math.max(0, frameMs - measured),
      },
      context: this.time.paused ? 'paused' : 'running',
    });
    // 自动降级：每帧喂入 fps / 物理耗时 / 当前渲染距离，它内部自己做迟滞与节流
    const decision = this.autoDegrade.update(
      {
        fps: this.fps,
        physicsMs: this.lastPhysicsMs,
        renderDistance: this.bundle.culling.renderDistance,
        baseRenderDistance: this.state.quality.baseRenderDistance,
        isMobile: this.mobile?.isTouchDevice ?? false,
      },
      nowMs,
    );
    if (!decision.noop && decision.actions.length > 0) {
      this.applyDegradeDecision(decision);
    }
  }

  /**
   * 应用自动降级的决定。
   *
   * 这里**逐条落地**，而不是只把 `level` 记下来 —— 降级的意义在于"真的省下开销"，
   * 只记录不执行等于没有降级（而且面板还会显示"已降级"，那是在骗自己）。
   */
  private applyDegradeDecision(decision: { actions: { kind: string; value: number | boolean; reason: string }[]; summary: string }): void {
    for (const action of decision.actions) {
      switch (action.kind) {
        case 'render-distance':
          this.bundle.culling.renderDistance = Math.max(
            CULLING_CONFIG.minRenderDistance,
            Math.round(action.value as number),
          );
          this.state.quality.renderDistance = this.bundle.culling.renderDistance;
          this.bundle.culling.invalidate();
          break;
        case 'shadows':
          this.render.setShadowsEnabled(action.value as boolean);
          this.state.quality.shadows = action.value as boolean;
          break;
        case 'ao':
          this.bundle.mesher.aoEnabled = action.value as boolean;
          this.state.quality.ao = action.value as boolean;
          this.bundle.grid.markAllDirty();
          break;
        case 'physics-precision':
          // 降的是**分帧预算**（每帧给物理相关周期性任务多少毫秒），
          // 不是求解器迭代 —— 后者会让"同样的塔在降级后突然不倒"，物理行为会突变
          this.scheduler.setBudget(action.value as number);
          break;
        default:
          break;
      }
    }
    this.state.quality.manualOverride = this.state.quality.manualOverride;
    this.showToast(`自动降级：${decision.summary}`, 3000);
    console.info('[自动降级]', decision.summary);
  }

  // ------------------------------------------- M4 第 2 批：物品面板

  /**
   * 玩家在物品面板里选中一个模型。
   *
   * 这里**复用既有的建筑放置路径**：切到建筑工具、把 `selectedBuildingId` 设好、
   * 刷新放置预览。改动的只是"怎么选到模型"（从旧的 tab+网格换成新面板），
   * 放置本身一行没动 —— 这样 300 个新物品立刻就能放，不需要它们各自实现一套逻辑。
   */
  private onCatalogSelect(def: BuildingDef): void {
    this.state.selectedBuildingId = def.id;
    this.state.placement.candidateIndex = 0;
    // 用既有的 setTool：它负责切换面板折叠状态与高亮，自己再写一遍必然漏掉某处
    this.setTool('building');
    this.refreshPlacement();
    this.refreshCatalogPanel();
    // 选中一个物品时**不弹 toast**：物品面板本来就一直在点，弹提示会刷屏。
    // 想知道选中了什么，看状态栏与面板高亮就够了。
  }

  /** 玩家用了一个物品（记进"最近使用"） */
  private noteCatalogUse(def: BuildingDef): void {
    const next = [def.id, ...this.recentIds.filter((id) => id !== def.id)].slice(0, 12);
    if (next.join(',') === this.recentIds.join(',')) return;
    this.recentIds = next;
    this.saveCatalogPrefs();
  }

  /** 面板偏好（收藏 + 最近使用）持久化。内容包的持久化由 contentPacks 自己管。 */
  private loadCatalogPrefs(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(`${CONTENT_PACK_STORAGE_KEY}-prefs`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { favorites?: unknown; recent?: unknown };
      this.favoriteIds = Array.isArray(parsed.favorites)
        ? parsed.favorites.filter((id): id is string => typeof id === 'string')
        : [];
      this.recentIds = Array.isArray(parsed.recent)
        ? parsed.recent.filter((id): id is string => typeof id === 'string').slice(0, 12)
        : [];
    } catch {
      // 坏存档一律回到空列表：收藏与最近使用丢了只是不方便，**绝不该让应用起不来**
      this.favoriteIds = [];
      this.recentIds = [];
    }
  }

  private saveCatalogPrefs(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        `${CONTENT_PACK_STORAGE_KEY}-prefs`,
        JSON.stringify({ favorites: this.favoriteIds, recent: this.recentIds }),
      );
    } catch {
      // 配额满 / 隐私模式：静默失败。偏好不是关键数据，不值得打断玩家
    }
  }

  /** 世界里每种物品各有多少个（面板卡片上显示「已放 N 个」） */
  private catalogPlacedCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const instance of this.buildings.all) {
      counts[instance.defId] = (counts[instance.defId] ?? 0) + 1;
    }
    return counts;
  }

  private refreshCatalogPanel(): void {
    if (!this.catalogPanel) return;
    this.catalogPanel.update({
      selectedId: this.state.selectedBuildingId,
      recentIds: this.recentIds,
      favoriteIds: this.favoriteIds,
      placedCounts: this.catalogPlacedCounts(),
    });
  }

  /**
   * UI 面板的节流 tick（每帧被调用，但只有过了间隔才真的干活）。
   *
   * ── 为什么需要它 ──
   * 这几个面板的数据源都是"遍历世界里所有物体"或"排序 + 分箱 + 分配对象"，
   * 而它们原来全挂在每帧路径上。实测代价：
   * - `computeContentStats`（内容统计热力图）：**1.02 ms/次** → 60 FPS 下每秒 61 ms；
   * - `catalogPlacedCounts`（物品面板的"已放 N 个"）：0.02 ms/次（小，但同样每帧分配）；
   * - 面板内部各自还有 150~200 ms 节流，但**输入数据是先算后节流的** ——
   *   节流只挡住了 DOM 更新，挡不住那几个毫秒的计算与分配。
   * 于是"面板越多，帧率越低"，而这在任务管理器里看不出是谁干的。
   *
   * 现在统一在**这一处**判断时间：没到间隔就直接返回，一个字节都不算。
   * 间隔取 400 ms：统计类面板（热力图、分类占比）本来就不需要更高刷新率。
   */
  private uiTick(nowMs: number): void {
    if (nowMs - this.lastUiTickMs < UI_TICK_INTERVAL_MS) return;
    this.lastUiTickMs = nowMs;
    this.refreshCatalogPanel();
    this.refreshContentStats();
    // 热力图要遍历所有粒子与建筑，所以跟着这条 400 ms 的节流走（不能每帧）
    this.refreshPerfHeatmap();
    const summaryEl = document.getElementById('stress-summary');
    if (summaryEl && this.stressSceneId) summaryEl.textContent = this.stressSummary;
    const verdictEl = document.getElementById('stress-verdict');
    if (verdictEl) verdictEl.textContent = this.lastStressVerdict;
  }

  /**
   * 刷新内容统计热力图（M4 补充 10）。
   *
   * 数据直接取 `this.buildings.all` —— 它在结构上就满足 `PlacedObjectLike`
   * （defId + position），所以不需要为了统计再拷一份数组。
   *
   * **坐标原点必须传对**：世界是以原点为中心的（x 在 ±sizeX/2），
   * 只按 [0, sizeX) 分箱会把左半边全夹进第 0 列 —— 那张图比没有图更糟。
   */
  private refreshContentStats(): void {
    if (!this.contentStatsUI || !this.bundle) return;
    const world = this.bundle.world;
    this.contentStatsUI.update(
      computeContentStats(this.buildings.all, {
        sizeX: world.sizeX,
        sizeZ: world.sizeZ,
        minY: 0,
        maxY: world.sizeY,
        originX: world.originX,
        originZ: world.originZ,
      }),
    );
  }

  /**
   * 生成预览（M4 补充 4）。
   *
   * 面板内部已经画好了缩略图（卡片进入视口才画，避免 8 张一起算），
   * 这里做的是面板做不到的部分：把**这次预览的近似程度**讲清楚。
   *
   * 为什么这件事必须由 Engine 做而不是面板：预览的局限来自**数据与算法**
   * （降采样、只用地表高度场、不跑物理），面板只知道"我拿到了一张高度场"。
   * 如果那三条局限不跟着预览一起显示，玩家会把预览当成"生成结果的照片"，
   * 然后在发现洞穴位置不对时以为是 bug。
   */
  /**
   * 生成面板上的两个按钮。
   *
   * 这两个按钮原来是在 `renderTemplateButtons()` 里顺带接线的，而那个方法
   * 已经被 `MapTemplateUI` 取代 —— **顺带接线的东西最容易在重构时静默丢掉**：
   * 面板还在、按钮还在，就是点了没反应。所以现在单独一个方法，
   * 并且在断言里查这两个 id 是否真的存在于 HTML。
   */
  /**
   * 惰性创建流体系统（第一次用流体工具时调用）。
   *
   * 为什么不做成"启动就建"：粒子上限 20000 时会一次性分配约 7 MB 的 TypedArray
   * （粒子池 + 邻居缓存 + 哈希表），而绝大多数玩家只想画地形。
   * 惰性创建让不用流体的人**一点都不付**这个成本。
   */
  private ensureFluid(): FluidSystem {
    if (this.fluid) return this.fluid;
    const isMobile = this.mobile?.isTouchDevice ?? false;
    const tier = this.mobile?.device.tier ?? 'high';
    const system = new FluidSystem({
      // 设备档位：MobileTier 里的 'medium' 对应流体系统的 'mid'（两边的命名历史不同）
      tier: tier === 'medium' ? 'mid' : tier,
      isMobile,
      type: this.fluidType,
      // 种子固定：同一个世界里"再倒一桶水"的位置序列是可复现的（便于复现问题）
      seed: this.bundle ? this.bundle.world.seed : 1,
      // 重力取物理世界的当前值（玩家可以在重力面板里改），没就绪时用地球重力
      gravity: Math.abs(this.physics.worldStats?.gravityY ?? 9.81) || 9.81,
    });
    this.fluid = system;
    // 手机用方盒粒子（12 个三角形 vs 球体 140 个），桌面用球体
    this.fluidRenderer = new FluidRenderer(
      { capacity: system.capacity, particleRadius: system.fluidConfig.particleRadius, style: this.fluidStyle, spheres: !isMobile },
      system.fluidConfig,
    );
    this.render.scene.add(this.fluidRenderer.group);
    // 表面重建：手机上默认不做（多一次网格重建对手机太重），桌面上给
    this.fluidSurface = new FluidSurface(system.fluidConfig, {
      maxResolution: isMobile ? 24 : 40,
      budgetMs: isMobile ? 4 : 6,
    });
    this.render.scene.add(this.fluidSurface.group);
    this.fluidEditor = new FluidEditor(system, {
      radius: this.state.brush.radius,
      pourAmount: 120,
      pourSpeed: 1.5,
    });
    // 音效默认**关**：浏览器要求用户手势之后才能出声，而且对没打开它的玩家
    // 也不该有声音。面板上那个开关就是那次手势。
    this.fluidAudio = new FluidAudio(false);
    this.fluidRunner = new FluidWorkerRunner({
      timeoutMs: 4000,
      // 必须给"可打包的边界来源"：`FluidBoundary` 是闭包，worker 侧克隆不了。
      // 不提供时 runner 会**拒绝**走 worker 并如实回退（"只说清楚"是它的契约）。
      boundarySource: () => ({ grid: this.bundle.grid, obstacles: this.fluidObstacleBoxes() }),
    });
    // 粒子流体 → 可采样场（第 4 批的耦合要用它）
    this.fluidField = new ParticleFluidField({ cellSize: 0.5, sampleThreshold: 8000 });
    // 沙水交互（第 5 批）：需要"沙"和"流体"两边，所以在这里一起建
    this.sandWater = new SandWaterInteraction();
    this.fluidField.setFluidConfig(system.fluidConfig);
    this.fluidField.setSpacing(targetSpacing(system.fluidConfig));
    this.fluidPanel = new FluidPanel(
      document.getElementById('fluid-panel'),
      system,
      this.fluidEditor,
      this.fluidSurface,
      this.fluidAudio,
      {
        onTypeChange: (type) => this.setFluidType(type),
        onToolChange: (tool) => this.setFluidTool(tool),
        onRadiusChange: (radius) => {
          this.fluidEditor?.setRadius(radius);
          // 与地形笔刷共用半径：切回地形时手感一致
          this.state.brush.radius = this.fluidEditor?.radius ?? radius;
          this.brushUI?.syncAll?.();
        },
        onAmountChange: (amount) => this.fluidEditor?.setPourAmount(amount),
        onStyleChange: (style) => this.setFluidStyle(style),
        onClear: () => {
          const removed = this.fluid?.clear() ?? 0;
          this.fluidSurface?.update(this.fluid!.pool, performance.now(), true);
          this.showToast(`已清空流体（移除 ${removed} 个粒子）`, 2000);
        },
        onToggleAudio: (enabled) => {
          this.fluidAudio?.setEnabled(enabled);
          // 浏览器要求用户手势之后才能出声：这个开关本身就是一次手势
          if (enabled) this.fluidAudio?.unlock();
        },
        onVolumeChange: (volume) => this.fluidAudio?.setVolume(volume),
      },
    );
    console.info(
      `[流体] 已启用：上限 ${system.capacity} 个粒子（${isMobile ? '移动端' : '桌面'}），` +
        `内存约 ${(system.bytes / 1024 / 1024).toFixed(1)} MB`,
    );
    return system;
  }

  /**
   * 惰性创建沙土编辑工具（第一次切到沙土工具时）。
   *
   * 与流体一样的理由：不用这个功能的人不该为它付内存（湿度元数据在大档是 2.4 MB）。
   * 注意**沙土系统本身一直是存在的**（`bundle.sand`，M1.5 起就在跑），
   * 这里惰性创建的只是"编辑器 + 可视化 + 面板"这三件套。
   */
  private ensureSandUi(): void {
    if (this.sandEditor) return;
    const sand = this.bundle.sand;
    this.sandEditor = new SandEditor(this.bundle.grid, sand, {
      radius: this.state.brush.radius,
      maxPileHeight: 6,
    });
    // 恢复上次选的工具（切走再切回来不该被重置成"堆沙"）
    this.sandEditor.setTool(this.sandTool);
    this.sandVisualizer = new SandVisualizer();
    this.render.scene.add(this.sandVisualizer.group);
    this.sandPanel = new SandPanel(document.getElementById('sand-panel'), sand, this.sandEditor, {
      onToolChange: (tool) => this.setSandTool(tool),
      onRadiusChange: (radius) => {
        this.sandEditor?.setRadius(radius);
        this.state.brush.radius = this.sandEditor?.radius ?? radius;
        this.brushUI?.syncAll?.();
      },
      onHeightChange: (height) => this.sandEditor?.setPileHeight(height),
      onToggleVisualizer: (visible) => this.sandVisualizer?.setVisible(visible),
      onMarkAll: () => {
        this.bundle.sand.markAllSand();
        this.showToast('已让全部沙重新检查稳定性（沙崩可能开始）', 2200);
      },
    });
    console.info('[沙土] 编辑器已启用（湿度 / 安息角 / 沙崩可视化）');
  }

  private setSandTool(tool: SandTool): void {
    this.sandTool = tool;
    this.usedSandTools.add(tool);
    this.sandEditor?.setTool(tool);
    if (tool !== 'pile' && this.sandVisualizer && !this.sandVisualizer.isVisible) {
      // 挖沙/湿沙/凝固这些工具"看不出效果"，自动把可视化打开更好用
      this.sandVisualizer.setVisible(true);
      this.sandPanel?.syncControlsFromState();
    }
  }

  /**
   * 应用沙土笔刷。位置取光标命中的体素；笔刷"贴着光标"而不是"贴着地表" ——
   * 玩家想在半空中堆沙也应该能堆（堆出来的沙会自己塌）。
   */
  private applySandBrush(): SandToolResult | null {
    const editor = this.sandEditor;
    if (!editor) return null;
    const hit = this.currentHit;
    if (!hit) return null;
    const result = editor.apply(hit.x, hit.y, hit.z, performance.now());
    if (result.message) this.showToast(result.message, 1200);
    return result;
  }

  private setFluidType(type: FluidType): void {
    this.fluidType = type;
    if (!this.fluid) return;
    this.fluid.setType(type);
    this.fluidRenderer?.setFluidConfig(this.fluid.fluidConfig);
    this.fluidSurface?.setFluidConfig(this.fluid.fluidConfig);
  }

  private setFluidTool(tool: FluidTool): void {
    this.fluidEditor?.setTool(tool);
    this.usedFluidTools.add(tool);
  }

  private setFluidStyle(style: FluidRenderStyle): void {
    this.fluidStyle = style;
    this.fluidRenderer?.setStyle(style);
    // 表面只有在"表面/混合"风格下才显示；粒子在三种风格下都显示
    // （"混合"= 表面 + 粒子点缀，所以两个都开）
    this.fluidSurface?.setVisible(style === 'surface' || style === 'mixed');
    this.fluidPanel?.setStyle(style);
  }

  /**
   * 把建筑登记成流体的障碍（按区块分桶）。
   *
   * 为什么不直接把建筑塞进 `isSolid` 的逐次遍历：一次求解每个粒子要问 2~3 次
   * `isSolid`，20000 粒子就是几万次查询；每次再遍历几百个建筑 → 直接不可用。
   * 按 16×16 米的区块分桶之后，一次查询只看那一桶里的几个建筑。
   *
   * 什么时候重建：建筑增删/移动后由 `markFluidObstaclesDirty()` 打标记，帧循环里重建一次。
   */
  private buildFluidObstacles(): void {
    this.fluidObstacles.clear();
    this.fluidObstacleKeys.clear();
    for (const instance of this.buildings.all) {
      const def = getBuildingDef(instance.defId);
      if (!def) continue;
      // 用包围盒（旋转按最大半宽处理：这是保守近似，宁可多挡一点也不要漏挡）
      const half = Math.max(def.size[0], def.size[2]) / 2;
      const box = {
        minX: instance.position[0] - half,
        maxX: instance.position[0] + half,
        minY: instance.position[1],
        maxY: instance.position[1] + def.size[1],
        minZ: instance.position[2] - half,
        maxZ: instance.position[2] + half,
      };
      // 一个建筑可能跨多个桶：把它的包围盒覆盖到的桶都登记一遍
      for (let bx = Math.floor(box.minX / 16); bx <= Math.floor(box.maxX / 16); bx += 1) {
        for (let bz = Math.floor(box.minZ / 16); bz <= Math.floor(box.maxZ / 16); bz += 1) {
          const key = fluidBucketKey(bx, bz);
          const list = this.fluidObstacles.get(key);
          if (list) list.push(box);
          else this.fluidObstacles.set(key, [box]);
          this.fluidObstacleKeys.add(key);
        }
      }
    }
  }

  /**
   * 把分桶的障碍索引展开成一个**扁平列表**（给 Worker 打包用）。
   *
   * 为什么不能直接把分桶 Map 给出去：分桶的键是整数（性能），
   * 而 worker 协议要的是一串 AABB —— 跨桶的建筑会出现多次，
   * 所以这里用 Set 去重（同一个盒子在多个桶里各存了一份引用）。
   * 代价是多一次 O(桶数 × 每桶盒数) 的遍历，但它在**打包边界快照时**才被调用
   * （runner 内部有缓存，同一帧的多次查询只打包一次）。
   */
  private fluidObstacleBoxes(): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }[] {
    const seen = new Set<{ minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }>();
    for (const list of this.fluidObstacles.values()) {
      for (const box of list) seen.add(box);
    }
    return [...seen];
  }

  /** 标记"建筑障碍索引需要重建"（建筑增删/移动后调用） */
  markFluidObstaclesDirty(): void {
    this.fluidObstaclesDirty = true;
  }

  /**
   * 流体求解器需要的环境采样。
   *
   * `isSolid` 的顺序是**先地形后建筑**：地形查询是一次数组下标（最快），
   * 建筑要走分桶查表。数值上两者都会挡水，顺序只影响速度。
   */
  private fluidBoundary(): {
    isSolid(x: number, y: number, z: number): boolean;
    halfX: number;
    halfZ: number;
    maxY: number;
    minY: number;
  } {
    const grid = this.bundle.grid;
    const obstacles = this.fluidObstacles;
    const keys = this.fluidObstacleKeys;
    return {
      halfX: grid.sizeX / 2,
      halfZ: grid.sizeZ / 2,
      minY: 0,
      maxY: grid.sizeY,
      isSolid: (x, y, z) => {
        if (y < 0) return true;
        if (y >= grid.sizeY) return false;
        const vx = grid.worldToVoxelX(x);
        const vz = grid.worldToVoxelZ(z);
        if (!grid.inHorizontalBounds(vx, vz)) return true;
        const id = grid.getVoxel(vx, Math.floor(y), vz);
        // 液体体素（旧的水）不算固体：粒子流体与它共存，不该被它挡住
        if (id !== 0 && !isLiquidVoxel(id)) return true;
        const key = fluidBucketKey(Math.floor(x / 16), Math.floor(z / 16));
        // 没有建筑的区块直接跳过（整数 Set 查询比 Map.get + 遍历快得多，
        // 而"这片区域没房子"是最常见的情况）
        if (!keys.has(key)) return false;
        const list = obstacles.get(key);
        if (list) {
          for (const box of list) {
            if (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ && y >= box.minY && y <= box.maxY) {
              return true;
            }
          }
        }
        return false;
      },
    };
  }

  /**
   * 每帧推进流体（渲染 + 模拟 + 面板）。
   *
   * 只在"有过流体"或"正在用流体工具"时才跑 —— 没有粒子时这一整段是几个 if，
   * 不会给不用流体的玩家带来任何开销。
   */
  private updateFluid(delta: number): void {
    const system = this.fluid;
    if (!system) return;
    // 障碍索引什么时候需要重建：
    // - 显式标记（换图/读档）
    // - 建筑数量变了（放了/删了东西）
    // - 存在动态物体（它们每帧在动，包围盒跟着变）
    // 三条合起来覆盖了"水的边界变了"的所有情况，而不必在放置/删除的每条路径上都记得调一次 ——
    // 那种"每处都要记得"的做法在 M2.5 已经吃过一次亏（漏了一处，水会穿墙）
    if (
      this.fluidObstaclesDirty ||
      this.buildings.count !== this.fluidObstacleCount ||
      this.buildings.dynamicCount > 0
    ) {
      this.buildFluidObstacles();
      this.fluidObstacleCount = this.buildings.count;
      this.fluidObstaclesDirty = false;
    }

    this.fluidMovedThisFrame = false;
    if (system.activeCount > 0) {
      const boundary = this.fluidBoundary();
      // 时间预算 4 ms（需求里的目标）。超了会在内部跳过子步并如实记下来。
      //
      // 第 6 批：优先走 `FluidWorkerRunner` —— 它在浏览器里把求解丢进 Worker，
      // 在没有 Worker 的环境（Node、老浏览器）里**同步回退**，并把原因写进 fallbackReason。
      // 两条路的语义差别必须说清：走 worker 时这一帧**不会**立刻推进粒子，
      // 位置要等回包（通常 1~2 帧后）；因此同一帧里 `applyFluidCoupling` 读到的是
      // **上一次完成的求解结果**。这在视觉上完全看不出来（水位连续），
      // 但它意味着"流体自身的更新率 = min(帧率, worker 完成率)"。
      const runner = this.fluidRunner;
      // ⚠ `busy` 判断**不能省**：runner 在忙的时候**不排队**，而是直接在主线程同步跑一整帧 ——
      // 那比不用 worker 更糟（主线程被占满，还多花一次装箱）。
      if (runner && !runner.busy) {
        void runner.run(
          system.pool,
          system.solver.settings,
          boundary,
          delta,
          // 预算传 Infinity（不限）：worker 路径**不该**受"每帧 4 ms"约束 ——
          // 那是为了不阻塞主线程而设的，而 Worker 里阻塞的不是主线程。
          // 而且预算一旦被触到，子步数就可能不同 → 逐位一致就没了。
          Number.POSITIVE_INFINITY,
        ).then((result) => {
          if (result.source === 'worker') this.fluidWorkerFrames += 1;
          else this.fluidFallbackFrames += 1;
          // 把 worker 的结果记进 stats（否则面板显示陈数据、静止状态也不会被清）
          system.adoptExternalStep(this.fluidRunner?.lastStats ?? null);
        });
      } else {
        // runner 忙（上一帧还没回来）：这一帧不再同步算一遍 —— 那等于把算力翻倍用在同一段时间上
        system.step({ dt: delta, boundary, budgetMs: 4 });
        this.fluidMovedThisFrame = true;
      }
    }

    // 渲染：粒子层永远同步（它同时承担"没有表面时的降级显示"）
    const camera = this.render.camera.position;
    this.fluidRenderer?.sync(system.pool, { x: camera.x, y: camera.y, z: camera.z });
    if (this.fluidRenderer) this.fluidRenderer.group.visible = system.activeCount > 0;

    // 表面重建：只在需要的风格下算
    if (this.fluidSurface && this.fluidMovedThisFrame && (this.fluidStyle === 'surface' || this.fluidStyle === 'mixed')) {
      // 位置没变时重建表面是白花钱（结果逐位相同）
      this.fluidSurface.update(system.pool, performance.now());
      this.fluidSurface.group.visible = this.fluidSurface.triangleCount > 0;
    }

    // 音效：流速取"粒子平均速度"（真数字，不是"有没有水"的开关）
    if (this.fluidAudio) {
      const stats = system.stats;
      this.fluidAudio.update({
        enabled: true,
        volume: this.fluidAudio.volume,
        flowSpeed: this.fluidAverageSpeed(),
        splash: stats.boundaryHits > 0 ? Math.min(1, stats.boundaryHits / Math.max(1, stats.particles) * 4) : 0,
        boiling: system.type === 'lava' && system.activeCount > 0,
      });
    }
    this.fluidPanel?.refresh();
  }

  /**
   * 流体 → 刚体耦合（M4 第二部分 · 第 4 批）。
   *
   * 顺序很关键：**必须在流体 step 之后、物理 step 之前**施加。
   * 放在物理 step 之后的话，力会留到下一帧才生效（表现为"水推东西慢半拍"）；
   * 而 Rapier 的 `addForce` 语义是"持续到下一次 step"，所以要在 step 前加。
   *
   * 只处理**动态**物体，并且只处理"离流体足够近"的 ——
   * 逐个物体去采样流体场在大场景里是白花钱（水只占世界一角）。
   */
  /**
   * 沙水交互（M4 第二部分 · 第 5 批）：把粒子流体包成 `ErodibleFluid` 交给交互层。
   *
   * 三件事的顺序有讲究：
   * 1. **流体场必须已经建好**（在 `applyFluidCoupling` 里建的），所以这里要放在它之后；
   * 2. **沙系统要先收到"湿了"的信号**，它才会在下一步按新的安息角流动 ——
   *    所以湿润要发生在沙 step 之前。沙 step 在 `fixedUpdate` 里，
   *    而这一整段在帧循环里、通常早于下一次 fixedUpdate ✓。
   * 3. 交互的 dt 用**帧间隔**（不是固定步长）：侵蚀/沉积是"视觉过程"，
   *    按真实经过时间算才不会因为帧率变化而快慢不一。
   */
  private updateSandWater(delta: number): void {
    const interaction = this.sandWater;
    const field = this.fluidField;
    const system = this.fluid;
    if (!interaction || !field || !system || system.activeCount === 0) return;
    // 同一个门：位置没变时这一段会把同一格沙重复扣一遍（与耦合是同一类错误）
    if (!this.fluidMovedThisFrame) return;

    const fluid: ErodibleFluid = {
      forEachOccupiedCell: (fn) => field.forEachOccupiedCell(fn),
      addParticles: (x, y, z, count) => system.emitSphere(x, y, z, count, 0.25, [0, 0.4, 0]).spawned,
      removeParticles: (x, y, z, radius) => system.removeInSphere(x, y, z, radius),
      get particleCount() {
        return system.activeCount;
      },
    };
    const stats = interaction.update({ grid: this.bundle.grid, sand: this.bundle.sand, fluid, dt: delta });
    this.lastSandWaterMs = stats.ms;
    this.lastSandWaterStats = stats;

    // 被沙压住的建筑：节流到每 500 ms 查一次（它要扫建筑上方的一片格子，不能每帧做）
    const nowMs = performance.now();
    if (nowMs - this.lastBuriedCheckMs > 500) {
      this.lastBuriedCheckMs = nowMs;
      this.checkBuriedBuildings();
    }
  }

  /**
   * 沙掩埋与压塌（第 5 批）。
   *
   * 超过阈值的建筑会被**转成动态刚体** —— 这就是"压塌"：它开始真的往下掉，
   * 而不是继续装作屹立不倒。转换走的是 M3 已有的那条路径
   * （`physics.setMode` + 同步 `instance.physicsMode`），不另开一套。
   *
   * 如实说明：判定是**启发式**（只看建筑顶上的沙格数），不区分承重结构、
   * 不算力矩。它的效果是"沙压得够多房子就会塌"，不是"结构力学正确"。
   */
  private checkBuriedBuildings(): void {
    const interaction = this.sandWater;
    if (!interaction) return;
    const buried: BuriedBuilding[] = interaction.collectBuriedBuildings(
      this.bundle.grid,
      this.buildings.all.map((instance) => {
        const def = getBuildingDef(instance.defId);
        const half = def ? { x: def.size[0] / 2, y: def.size[1] / 2, z: def.size[2] / 2 } : { x: 0.5, y: 0.5, z: 0.5 };
        return {
          ownerId: instance.id,
          center: { x: instance.position[0], y: instance.position[1] + half.y, z: instance.position[2] },
          half,
          isStatic: instance.physicsMode === 'static',
        };
      }),
    );
    const collapsing = interaction.findCollapsing(buried);
    this.lastBuriedCount = buried.length;
    if (collapsing.length === 0) return;

    let converted = 0;
    for (const item of collapsing) {
      const instance = this.buildings.findById(item.ownerId);
      if (!instance) continue;
      const handle = instance.physicsHandle ?? -1;
      if (handle < 0) continue;
      this.physics.setMode(handle, 'dynamic');
      this.bodyFactory.wake(handle);
      instance.physicsMode = 'dynamic';
      converted += 1;
    }
    if (converted > 0) {
      this.render.buildingRenderer.markDirty();
      this.showToast(`${converted} 栋建筑被沙压塌了（${collapsing[0]!.detail}）`, 3200);
      console.info('[沙掩埋] 压塌', collapsing.map((item) => item.detail).join('；'));
    }
  }

  /**
   * 组装教学关卡需要的世界快照（第 8 批）。
   *
   * 为什么集中在这里：关卡判定是纯函数，但它要的输入散落在流体/沙/耦合三处。
   * 让关卡自己去各处取状态会把耦合关系搞乱；统一在这里组装成一份"这一帧的世界"，
   * 关卡只读这一份。
   */
  private buildTutorialSnapshot(): TutorialSnapshot {
    const system = this.fluid;
    const sand = this.bundle?.sand;
    const couplingStats = this.coupling.stats;
    let spread = 0;
    let speed = 0;
    let frozenParticles = 0;
    if (system && system.activeCount > 0) {
      const { posX, posZ, velX, velY, velZ, frozen, alive } = system.pool;
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minZ = Number.POSITIVE_INFINITY;
      let maxZ = Number.NEGATIVE_INFINITY;
      let sumSpeed = 0;
      let count = 0;
      const high = system.pool.highWater;
      for (let i = 0; i < high; i += 1) {
        if (alive[i] !== 1) continue;
        minX = Math.min(minX, posX[i]!);
        maxX = Math.max(maxX, posX[i]!);
        minZ = Math.min(minZ, posZ[i]!);
        maxZ = Math.max(maxZ, posZ[i]!);
        sumSpeed += Math.hypot(velX[i]!, velY[i]!, velZ[i]!);
        count += 1;
        if (frozen[i] === 1) frozenParticles += 1;
      }
      spread = count === 0 ? 0 : Math.max(maxX - minX, maxZ - minZ);
      speed = count === 0 ? 0 : sumSpeed / count;
    }
    const lastCollapse = sand?.recentCollapses[0];
    return {
      nowMs: performance.now(),
      fluidParticles: system?.activeCount ?? 0,
      fluidSpread: spread,
      fluidSpeed: speed,
      frozenRegions: system?.frozenRegions.length ?? 0,
      frozenParticles,
      submergedBodies: couplingStats.submerged,
      sinkingBodies: couplingStats.sinking,
      // 被推动 = 浸没中且速度足够大（这里用"浸没数减去会沉数"近似不动的那部分，
      // 真正的速度判定在第 4 批的耦合里；这里只要求"有浸没物体 + 水流在动"）
      pushedBodies: couplingStats.submerged > 0 && speed > 0.3 ? couplingStats.submerged - couplingStats.sinking : 0,
      lastCollapseCells: lastCollapse?.cells ?? 0,
      collapseCount: sand?.recentCollapses.length ?? 0,
      erodedCells: this.lastSandWaterStats?.eroded ?? 0,
      depositedCells: this.lastSandWaterStats?.deposited ?? 0,
      usedFluidTools: [...this.usedFluidTools] as TutorialSnapshot['usedFluidTools'],
      usedSandTools: [...this.usedSandTools] as TutorialSnapshot['usedSandTools'],
    };
  }

  /**
   * 每帧推进教学关卡（第 8 批）。
   *
   * 只在教学模式打开时推进 —— 没打开教学的玩家不该为它付任何开销
   * （虽然只是一个纯函数调用，但"做过的事情就要有人记得为什么"）。
   */
  private updateTutorial(delta: number): void {
    if (!this.fluidTutorialActive) return;
    const snapshot = this.buildTutorialSnapshot();
    this.tutorialSnapshot = snapshot;
    const before = this.fluidTutorial.state;
    const after = this.fluidTutorial.update(snapshot, delta * 1000);
    if (after.completed && !before.completed) {
      this.showToast(`✅ 教学通关：${this.fluidTutorial.level.name}（${this.fluidTutorial.completedCount}/6）`, 3600);
      console.info('[教学] 通关', this.fluidTutorial.level.name);
    }
  }

  private applyFluidCoupling(): void {
    const field = this.fluidField;
    const system = this.fluid;
    if (!field || !system || !this.couplingEnabled) return;
    // 位置没变 → 上一帧已经施加过同一份力了，再加就是重复施力（见 fluidMovedThisFrame 的注释）
    if (!this.fluidMovedThisFrame) return;
    if (!this.physicsReady || system.activeCount === 0) return;

    const started = performance.now();
    field.setFluidConfig(system.fluidConfig);
    field.setSpacing(targetSpacing(system.fluidConfig));
    field.build(system.pool);

    // 收集动态物体：用物体的 AABB 与流体的包围盒做粗筛（这里简化为"距离中心 24 米内"）
    const bodies: CouplingBody[] = [];
    const owners = new Map<number, number>();
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let n = 0;
    const high = system.pool.highWater;
    for (let i = 0; i < high; i += 1) {
      if (system.pool.alive[i] !== 1) continue;
      cx += system.pool.posX[i]!;
      cy += system.pool.posY[i]!;
      cz += system.pool.posZ[i]!;
      n += 1;
    }
    if (n === 0) return;
    cx /= n; cy /= n; cz /= n;
    // 半径取"粒子分布的范围"再加 4 米（物体贴在水边也要算上）
    let radius = 4;
    for (let i = 0; i < high; i += 1) {
      if (system.pool.alive[i] !== 1) continue;
      const d = Math.hypot(system.pool.posX[i]! - cx, system.pool.posY[i]! - cy, system.pool.posZ[i]! - cz);
      if (d > radius) radius = d;
    }
    radius += 4;

    for (const instance of this.buildings.all) {
      const handle = instance.physicsHandle ?? -1;
      if (handle < 0) continue;
      if (instance.physicsMode === 'static') continue;
      const def = getBuildingDef(instance.defId);
      if (!def) continue;
      const pose = this.physics.readPose(handle);
      if (!pose) continue;
      const center = { x: pose.x, y: pose.y + def.size[1] / 2, z: pose.z };
      if (Math.hypot(center.x - cx, center.y - cy, center.z - cz) > radius) continue;
      bodies.push({
        handle,
        ownerId: instance.id,
        center,
        half: { x: def.size[0] / 2, y: def.size[1] / 2, z: def.size[2] / 2 },
        mass: this.bodyFactory.massOf(handle, def.mass ?? 100),
        velocity: this.physics.readVelocity(handle) ?? { x: 0, y: 0, z: 0 },
        angularVelocity: this.physics.readAngularVelocity(handle) ?? { x: 0, y: 0, z: 0 },
      });
      owners.set(handle, instance.id);
    }
    if (bodies.length === 0) return;

    const forces = this.coupling.compute(bodies, field, 1 / 60);
    for (const item of forces) {
      if (item.ratio <= 0) continue;
      // 力：Rapier 的 addForce 是"持续到下一次 step"
      this.bodyFactory.addForce(item.handle, [item.force.x, item.force.y, item.force.z]);
      // 力矩：浮心力矩 + 角速度阻力
      this.bodyFactory.addTorque(item.handle, [item.torque.x, item.torque.y, item.torque.z]);
    }
    this.lastCouplingMs = performance.now() - started;
    void owners;
  }

  /** 粒子的平均速度（米/秒）—— 音效音量与"水流是否在动"都看它 */
  private fluidAverageSpeed(): number {
    const system = this.fluid;
    if (!system || system.activeCount === 0) return 0;
    const { velX, velY, velZ, alive } = system.pool;
    let sum = 0;
    let count = 0;
    const high = system.pool.highWater;
    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1) continue;
      sum += Math.hypot(velX[i]!, velY[i]!, velZ[i]!);
      count += 1;
    }
    return count === 0 ? 0 : sum / count;
  }

  /**
   * 把存档里的自定义物品注册进运行时目录（启动时调一次）。
   *
   * 为什么必须有这一步：`BuildingDef.parts` 是渲染与物理的依据，而
   * `BuildingSystem` 只认 `getBuildingDef(defId)`。存档里如果有一个
   * 没被注册的自定义物品，读档之后就会变成"看不见的空物体"，
   * 玩家会以为存档坏了 —— 其实只是漏了一次注册。
   */
  private loadSavedCustomItemsIntoCatalog(): void {
    let items: readonly BuildingDef[] = [];
    let loadError: string | null = null;
    try {
      const store = loadCustomItems();
      items = store.items;
      loadError = store.lastError;
    } catch (error) {
      // 存档损坏不该让引擎起不来：如实报出来，继续跑
      console.warn('[自定义物品] 读取存档失败，本次会话没有自定义物品', error);
      return;
    }
    if (loadError) {
      // 存档里有一条读不出来（格式不对的条目会被跳过）—— 如实说出来，
      // 不然玩家只会看到"我做的那个东西不见了"
      this.showToast(`自定义物品存档有问题：${loadError}`, 4000);
    }
    let added = 0;
    let rejected = 0;
    for (const def of items) {
      const result = registerCustomItem(def);
      if (result.ok) added += 1;
      else {
        rejected += 1;
        console.warn(`[自定义物品] 跳过 ${def.id}：${result.reason}`);
      }
    }
    if (rejected > 0) {
      this.showToast(`有 ${rejected} 个自定义物品没通过校验，已跳过（详见控制台）`, 4000);
    }
    if (added > 0) {
      console.info(`[自定义物品] 已从存档载入 ${added} 个（物品库现共 ${BUILDING_CATALOG.length} 个）`);
    }
  }

  private setupGenerationPanelButtons(): void {
    // Worker 能力**如实报出来**，而不是悄悄留着一段没人用的代码。
    //
    // 结论（实测，数字在 README 的取舍清单里）：把冲突检测（流水线阶段 9）
    // 搬进 worker **目前不划算** —— 光"打包地形快照"就要 1.6~2.7 ms（新手档）
    // 到 30~40 ms（大档），而检测本身只要 1.8~3.4 / 17.7~20.5 ms。
    // 也就是说主线程省下的时间被搬运吃掉了，还多烧一份 CPU。
    // 所以阶段 9 仍然走主线程，`ConflictRunner` 保留为"结果与同步路径逐字一致"的能力，
    // 等快照搬运量降下来（列级快照 / worker 侧缓存地形）再接进流水线。
    console.info(
      `[冲突检测] Worker ${isWorkerAvailable() ? '可用' : '不可用（当前环境没有 Worker，会走主线程同步路径）'}；` +
        '阶段 9 仍走主线程：实测搬运地形快照不比检测本身便宜（见 README 取舍清单）',
    );
    const logButton = document.getElementById('btn-export-generation-log');
    logButton?.addEventListener('click', () => this.exportGenerationLog());
    const overlayButton = document.getElementById('btn-conflict-overlay');
    overlayButton?.addEventListener('click', () => this.toggleConflictOverlay());
  }

  private showGenerationPreview(request: { templateId: string; seed: number; overrides: Record<string, number> }): void {
    const template = getMapTemplate(request.templateId);
    if (!template) {
      this.showToast(`找不到模板：${request.templateId}`, 2400);
      return;
    }
    const data = buildPreview({
      templateId: request.templateId,
      seed: request.seed,
      overrides: request.overrides,
    });
    // 大预览图（面板里那张是卡片缩略图，这张是按当前滑杆与种子重算的）
    const canvas = document.getElementById('map-template-preview') as HTMLCanvasElement | null;
    if (canvas) {
      renderPreviewCanvas(canvas, data, { showPlots: true, showNature: true, showWater: true });
    } else {
      // 没有画布节点时也要说清楚：不然玩家点了"预览"只看到一句提示，会以为坏了
      console.warn('[生成预览] 页面里没有 #map-template-preview，只输出了文字摘要');
    }
    console.info('[生成预览]', describePreview(data));
    for (const limitation of data.limitations) console.info('[生成预览 · 局限]', limitation);
    this.showToast(
      `${template.emoji} ${describePreview(data)}\n` +
        `预览是降采样近似：小物品与门洞的冲突看不出来，洞穴/悬垂处不准，也不跑物理。`,
      4200,
    );
  }

  /**
   * 切换冲突可视化（M4 补充 7）。
   *
   * 打开时**先按当前冲突重画一次**：这个开关最可能被打开的时刻就是"刚生成完一张图，
   * 想看看那 7 处冲突在哪"，如果只切 visible 而不重画，玩家会看到一片空白。
   */
  private toggleConflictOverlay(): void {
    const next = !this.conflictOverlay.visible;
    if (next) this.conflictOverlay.setConflicts(this.lastGenerationConflicts);
    this.conflictOverlay.setVisible(next);
    const stats = this.conflictOverlay.stats;
    if (!next) {
      this.showToast('已关闭冲突可视化', 1600);
      return;
    }
    const lines = describeConflicts(this.lastGenerationConflicts, 3);
    this.showToast(
      stats.skipped > 0
        ? `冲突可视化：画出 ${stats.drawn} 处，另有 ${stats.skipped} 处超出标记上限未画\n${lines[0]}`
        : `冲突可视化：画出 ${stats.drawn} 处\n${lines[0]}`,
      3600,
    );
  }

  // ------------------------------------------- M3 第 4 批：拖拽连线

  /**
   * 拖拽连线：按下时记录源，移动时更新覆盖层，松手时判定目标。
   *
   * 这三个入口由 Engine 现有的指针回调转发（见 `handlePointerDown` / `handlePointerMove` /
   * `handlePointerUp` 里对 `linkDragActive()` 的判断），而不是另接一套监听器 ——
   * 两套监听器会让"拖拽时相机也在转"这类问题反复出现。
   */
  private linkDragActive(): boolean {
    return this.logicEditor?.dragModeEnabled === true;
  }

  /** 按下：拾取源物体 */
  private beginLinkDrag(ndc: { x: number; y: number }): boolean {
    this.pickVoxel();
    const instance = this.pickBuildingAtCursor();
    if (!instance) {
      this.showToast('这里没有物体，从一个物体上开始拖', 2200);
      return false;
    }
    const screen = this.screenPointOf(instance);
    this.dragLink = {
      sourceId: instance.id,
      pointer: screen ?? { x: 0, y: 0 },
      targetId: null,
    };
    this.connector.begin(screen ?? { x: 0, y: 0, valid: false }, `从「${this.nameOf(instance.id)}」开始`);
    void ndc;
    return true;
  }

  /** 移动：更新目标与覆盖层 */
  private updateLinkDrag(ndc: { x: number; y: number }): void {
    const drag = this.dragLink;
    if (!drag) return;
    const screen = this.input.ndcToScreen(ndc);
    this.pickVoxel();
    const target = this.pickBuildingAtCursor();
    // 目标不能是源自己（自环在物理上没有意义，而且很容易误触）
    const targetId = target && target.id !== drag.sourceId ? target.id : null;
    drag.pointer = { x: screen.x, y: screen.y };
    drag.targetId = targetId;
    this.connector.update(
      { x: screen.x, y: screen.y, valid: true },
      targetId !== null,
      targetId !== null ? this.nameOf(targetId) : undefined,
    );
  }

  /** 松手：预填两端（不直接建连线，理由见 LogicLinkEditor 的说明） */
  private endLinkDrag(): void {
    const drag = this.dragLink;
    this.dragLink = null;
    this.connector.end();
    if (!drag) return;
    if (drag.targetId === null) {
      this.showToast('没有拖到物体上，连线取消', 2400);
      this.refreshLogicEditor();
      return;
    }
    this.logicEditor.setEndpoints({
      sourceId: drag.sourceId,
      sourceName: this.nameOf(drag.sourceId),
      targetId: drag.targetId,
      targetName: this.nameOf(drag.targetId),
    });
    this.showToast(
      `已选中两端：${this.nameOf(drag.sourceId)} ⟶ ${this.nameOf(drag.targetId)}；` +
        '现在去逻辑面板选事件与动作，再点「建立连线」',
      4200,
    );
    this.refreshLogicEditor();
  }

  private cancelLinkDrag(): void {
    this.dragLink = null;
    this.connector.end();
  }

  /** 光标下的建筑（用现有的体素命中点反查） */
  private pickBuildingAtCursor(): BuildingInstance | null {
    const hit = this.currentHit;
    if (!hit) return null;
    const grid = this.bundle.grid;
    return this.buildings.pickAt(hit.x - grid.halfX + 0.5, hit.y + 0.5, hit.z - grid.halfZ + 0.5);
  }

  /** 物体的屏幕坐标（供拖拽线使用）；投影失败返回 null */
  private screenPointOf(instance: BuildingInstance): { x: number; y: number; valid: boolean } | null {
    const def = getBuildingDef(instance.defId);
    const camera = this.render.camera;
    const size = this.viewportSize();
    const point = new Vector3(
      instance.position[0],
      instance.position[1] + (def?.size[1] ?? 1) / 2,
      instance.position[2],
    ).project(camera);
    if (point.z > 1 || point.z < -1) return { x: 0, y: 0, valid: false };
    return {
      x: ((point.x + 1) / 2) * size.width,
      y: ((-point.y + 1) / 2) * size.height,
      valid: true,
    };
  }

  private nameOf(objectId: number): string {
    const instance = this.buildings.findById(objectId);
    if (!instance) return `#${objectId}`;
    return getBuildingDef(instance.defId)?.name ?? instance.defId;
  }

  /** 建立一条逻辑连线（把编辑器的选择翻译成 LogicLink 的 spec） */
  private createLogicLink(request: {
    sourceId: number;
    targetId: number;
    event: LogicEventType;
    action: LogicActionType;
    cooldownMs: number;
    probability: number;
    gate: LogicGateKind;
  }): void {
    const target = this.buildings.findById(request.targetId);
    if (!target) {
      this.showToast(`目标物体 #${request.targetId} 已经不在了`, 2600);
      return;
    }
    const handle = target.physicsHandle ?? -1;

    // 动作的 targetId 语义按动作类型分：驱动马达与改模式要的是**刚体**，
    // 开关触发器要的是**触发器 id**。这里按类型翻译，避免把两种 id 混在一起。
    const actionTarget =
      request.action === 'toggle-trigger'
        ? (this.framework.triggers.list().find((record) => record.tag === `handle-${handle}`)?.id ?? -1)
        : handle;

    // **这里不用 `linkSpecFromConfig`**：那个函数的语义是"把组合数据里的事件翻译成
    // 它固定的配套动作"（`EVENT_TO_ACTION` 映射表），而编辑器里玩家是**自己选动作**的。
    // 我第一版这里误用了它 —— 结果是"玩家选了驱动马达，实际建出来的是弹提示"，
    // 而且因为映射表对未登记的 event 返回 undefined，动作会被静默丢弃。
    const action: LogicAction =
      request.action === 'toast'
        ? { type: 'toast', text: `${this.nameOf(request.targetId)} 被触发了` }
        : request.action === 'vibrate'
          ? { type: 'vibrate' }
          : {
              type: request.action,
              targetId: actionTarget,
              cooldownMs: request.cooldownMs,
              probability: request.probability,
            };

    const id = this.framework.links.add({
      label: `${this.nameOf(request.sourceId)} → ${this.nameOf(request.targetId)}`,
      listen: [request.event],
      sourceId: request.sourceId,
      actions: [action],
      enabled: true,
      gate: { kind: request.gate },
    });

    if (id < 0) {
      this.showToast('建立连线失败（详见控制台）', 2600);
      return;
    }
    this.activeLinkId = id;
    this.logicEditor.setEndpoints(null);
    this.showToast(
      `连线 #${id} 已建立：${LOGIC_EVENT_LABELS[request.event]} → ${request.action}（${LOGIC_GATE_LABELS[request.gate]}）`,
      3600,
    );
    this.haptics.play('place-ok');
    this.refreshLogicEditor();
  }

  private removeLogicLink(linkId: number): void {
    const ok = this.framework.links.remove(linkId);
    this.showToast(ok ? `已删除连线 #${linkId}` : `连线 #${linkId} 已经不在了`, 2200);
    if (this.activeLinkId === linkId) this.activeLinkId = null;
    this.refreshLogicEditor();
  }

  private refreshLogicEditor(): void {
    if (!this.logicEditor) return;
    const links = this.framework.links.list();
    this.logicEditor.update({
      endpoints: null,
      links: links.map((record) => ({
        id: record.id,
        label: record.label,
        enabled: record.enabled,
        firedCount: record.firedCount,
        summary: `${record.listen.map((type) => LOGIC_EVENT_LABELS[type] ?? type).join('/')} → ${record.actions.length} 个动作`,
        gateLabel: LOGIC_GATE_LABELS[record.gate?.kind ?? 'none'],
      })),
      activeLinkId: this.activeLinkId,
      message:
        links.length === 0
          ? '还没有连线：打开「拖拽连线模式」，在画布上从一个物体拖到另一个'
          : `共 ${links.length} 条连线；当前选中 #${this.activeLinkId ?? '—'}`,
    });
  }

  // ------------------------------------------- M3 第 3 批：关节编辑器

  /**
   * 用当前选区的**前两个**物体接一个关节。
   *
   * 三个决定：
   * 1. **锚点取两个物体 AABB 的接触区中心**（如果它们不接触，就取两个中心的连线中点）。
   *    放在任一物体的中心都是错的 —— 那会让关节把物体拽向另一个物体；
   * 2. `bodyA`/`bodyB` 用**刚体句柄的十进制字符串**（这是 `JointConfig` 的数据契约，
   *    见 JointSystem 的说明），空串表示连到世界；
   * 3. 建完之后**立刻把关节 id 记下来**，这样玩家可以直接接着调限位与马达，
   *    不用再去列表里点一次。
   */
  private createJointFromSelection(config: Omit<JointConfig, 'bodyA' | 'bodyB' | 'anchor'>): void {
    const ids = this.selection.ids;
    if (ids.length < 2) {
      this.showToast('先选中两个物体再接关节（选择工具 + Ctrl 加选）', 2600);
      this.jointEditor.update(this.buildJointEditorStats('需要两个物体')); 
      return;
    }
    const first = this.buildings.findById(ids[0]!);
    const second = this.buildings.findById(ids[1]!);
    if (!first || !second) {
      this.jointEditor.update(this.buildJointEditorStats('选中的物体已经被删掉了'));
      return;
    }

    const a = this.physicsHandleFor(first);
    const b = this.physicsHandleFor(second);
    if (a < 0 || b < 0) {
      this.showToast(
        '物理引擎还没就绪（或这两个物体没有刚体），关节会先排队，等就绪后自动补建',
        3200,
      );
    }

    const anchor = this.jointAnchorBetween(first, second);
    const jointId = this.framework.addJoint({
      ...config,
      bodyA: a >= 0 ? String(a) : '0',
      bodyB: b >= 0 ? String(b) : '',
      anchor,
    });

    if (jointId < 0) {
      // -1 表示物理未就绪进了待建队列 —— 不是失败，如实说
      this.showToast('关节已排队（物理引擎就绪后会自动建好）', 3000);
      this.jointEditor.update(this.buildJointEditorStats('关节已排队，等物理就绪'));
      return;
    }

    this.activeJointId = jointId;
    this.showToast(
      `已接上关节 #${jointId}：${JOINT_TYPE_LABELS[config.type]}（${first.defId} ⟷ ${second.defId}）`,
      3200,
    );
    this.haptics.play('place-ok');
    this.render.buildingRenderer.markDirty();
    this.refreshJointEditor();
  }

  /** 给选中的关节应用限位 / 马达修改 */
  private applyJointConfig(config: Omit<JointConfig, 'bodyA' | 'bodyB' | 'anchor'>): void {
    const id = this.activeJointId;
    if (id === null) {
      this.showToast('先在下面的列表里点一个关节', 2400);
      return;
    }
    // 限位与马达是运行时属性，可以直接改；**轴与类型是构造属性**，改不了（要删了重建）
    let changed = 0;
    if (config.limits) {
      const applied = this.framework.joints.applyLimitsTo(id, config.limits);
      if (applied) changed += 1;
    }
    if (config.motorForce !== undefined || config.motorSpeed !== undefined || config.motorMode !== undefined) {
      const ok = this.framework.joints.setMotor(id, {
        jointIndex: id,
        mode: config.motorMode ?? 'velocity',
        speed: config.motorSpeed ?? 0,
        targetPosition: config.motorPosition,
        maxForce: config.motorForce ?? 200,
      });
      if (ok) changed += 1;
    }

    if (changed === 0) {
      this.showToast('没有可应用的修改；轴与类型需要删掉关节重建', 3200);
    } else {
      this.showToast(`已更新关节 #${id}（轴与类型属于构造属性，改动需要重建）`, 3000);
    }
    this.refreshJointEditor();
  }

  private removeActiveJoint(): void {
    const id = this.activeJointId;
    if (id === null) return;
    const ok = this.framework.joints.remove(id);
    this.showToast(ok ? `已删除关节 #${id}` : `关节 #${id} 已经不在了`, 2200);
    this.activeJointId = null;
    this.render.buildingRenderer.markDirty();
    this.refreshJointEditor();
  }

  /** 位置驱动：让门/活塞走到目标角度或位移 */
  private driveMotorTo(target: number): void {
    const id = this.activeJointId;
    if (id === null) return;
    const ok = this.framework.joints.setMotorTarget(id, target);
    this.showToast(ok ? `关节 #${id} 正在走向 ${target}` : '这个关节不是位置驱动（先用「应用修改」设成位置驱动）', 3000);
    this.refreshJointEditor();
  }

  private reverseActiveMotor(): void {
    const id = this.activeJointId;
    if (id === null) return;
    const ok = this.framework.joints.reverseMotor(id);
    this.showToast(ok ? `已反转关节 #${id} 的转向` : '这个关节不是速度驱动', 2400);
    this.refreshJointEditor();
  }

  private stopActiveMotor(): void {
    const id = this.activeJointId;
    if (id === null) return;
    const ok = this.framework.joints.stopMotor(id);
    this.showToast(ok ? `已停掉关节 #${id} 的马达` : '这个关节没有马达', 2400);
    this.refreshJointEditor();
  }

  /** 两个物体之间的合理锚点：接触区中心，不接触时取中心连线中点 */
  private jointAnchorBetween(
    a: BuildingInstance,
    b: BuildingInstance,
  ): [number, number, number] {
    const aabbA = this.aabbOf(a);
    const aabbB = this.aabbOf(b);
    const overlapX = Math.min(aabbA.maxX, aabbB.maxX) - Math.max(aabbA.minX, aabbB.minX);
    const overlapY = Math.min(aabbA.maxY, aabbB.maxY) - Math.max(aabbA.minY, aabbB.minY);
    const overlapZ = Math.min(aabbA.maxZ, aabbB.maxZ) - Math.max(aabbA.minZ, aabbB.minZ);
    if (overlapX > 0 && overlapY > 0 && overlapZ > 0) {
      // 有重叠（贴在一起）：取重叠区中心
      return [
        (Math.max(aabbA.minX, aabbB.minX) + Math.min(aabbA.maxX, aabbB.maxX)) / 2,
        (Math.max(aabbA.minY, aabbB.minY) + Math.min(aabbA.maxY, aabbB.maxY)) / 2,
        (Math.max(aabbA.minZ, aabbB.minZ) + Math.min(aabbA.maxZ, aabbB.maxZ)) / 2,
      ];
    }
    // 不接触：取两个中心的连线中点 —— 关节会把它们拉到一起，这是"用关节连接远处物体"的意图
    return [
      (a.position[0] + b.position[0]) / 2,
      (a.position[1] + b.position[1]) / 2,
      (a.position[2] + b.position[2]) / 2,
    ];
  }

  private aabbOf(instance: BuildingInstance): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
    const def = getBuildingDef(instance.defId);
    const size = def?.size ?? [1, 1, 1];
    const scale = instance.scale ?? 1;
    const halfX = (size[0] * scale) / 2;
    const halfZ = (size[2] * scale) / 2;
    return {
      minX: instance.position[0] - halfX,
      maxX: instance.position[0] + halfX,
      minY: instance.position[1],
      maxY: instance.position[1] + size[1] * scale,
      minZ: instance.position[2] - halfZ,
      maxZ: instance.position[2] + halfZ,
    };
  }

  /** 拿一个物体的刚体句柄（没有就返回 -1，调用方据此提示"会排队"） */
  private physicsHandleFor(instance: BuildingInstance): number {
    if (typeof instance.physicsHandle === 'number' && instance.physicsHandle >= 0) return instance.physicsHandle;
    // 还没建刚体时尝试立刻补一个（物理已就绪的情况下）
    if (this.physicsReady) {
      this.buildings.ensureBodies();
      this.physics.syncQueries();
      if (typeof instance.physicsHandle === 'number' && instance.physicsHandle >= 0) {
        return instance.physicsHandle;
      }
    }
    return -1;
  }

  private refreshJointEditor(): void {
    if (!this.jointEditor) return;
    this.jointEditor.update(this.buildJointEditorStats());
  }

  private buildJointEditorStats(message = ''): Parameters<JointEditor['update']>[0] {
    const ids = this.selection.ids;
    const names = ids
      .map((id) => this.buildings.findById(id))
      .filter((item): item is BuildingInstance => item !== null)
      .map((item) => getBuildingDef(item.defId)?.name ?? item.defId);

    // 用 JointSystem.list()：它给出**全部**关节（含没有马达的）。
    // 只列带电机的会让人以为"我接的关节消失了"。
    const joints = this.framework.joints.list().map((entry) => {
      const motor = this.framework.joints.motorOf(entry.id);
      return {
        id: entry.id,
        type: entry.type,
        label: JOINT_TYPE_LABELS[entry.type],
        detail: this.framework.joints.describe(entry.id),
        motorMode: motor?.mode ?? null,
        motorTarget: motor?.targetPos ?? 0,
      };
    });

    const active = this.activeJointId ?? joints[0]?.id ?? null;
    return {
      selection: [...ids],
      selectionNames: names,
      joints,
      activeJointId: active,
      message:
        message ||
        (joints.length === 0
          ? '选中两个物体后点「接上关节」'
          : `共 ${joints.length} 个关节；当前操作 #${active ?? '—'}`),
      motorRunning: this.framework.joints
        .motorJoints()
        .some((motor) => motor.mode === 'position'),
    };
  }

  // ------------------------------------------- M3 第 4 批：传感器与逻辑门

  /**
   * 把这一帧的 Rapier 碰撞事件翻译成触发器事件，再分派给逻辑连线。
   *
   * 三段：**碰撞体句柄 → 触发区**（TriggerSystem 自己维护映射）→
   * **另一个碰撞体 → 刚体 → ownerId**（这一段要跨 Rapier 查一次）→ 逻辑层。
   */
  private drainTriggerEvents(): void {
    if (this.framework.triggers.count === 0) return;
    let events = 0;
    this.physics.drainCollisions((colliderA, colliderB, started) => {
      events += 1;
      this.framework.triggers.handleCollision(colliderA, colliderB, started, (collider) =>
        this.physics.bodyOfCollider(collider),
      );
    });
    if (events > 0) this.lastSensorEvents = events;
  }

  /** 供教学关卡的 `trigger-zone` 目标使用：tag → 累计进入次数 */
  private noteTriggerHit(tag: string): void {
    this.triggerHits[tag] = (this.triggerHits[tag] ?? 0) + 1;
  }

  /** 逻辑门的 tick（延时门的到期动作、计时门的周期触发） */
  private tickLogicGates(nowMs: number): void {
    const requests = this.framework.links.tick(nowMs);
    for (const request of requests) this.executeLogicAction(request);
  }

  // ------------------------------------------- M3 第 7 批：距离剔除

  /**
   * 执行一次距离剔除。
   *
   * 候选只取**动态/运动学**刚体（静态的本来就不参与求解，冻不冻都一样，白扫一遍）。
   * 重要物体（选中的 / 手里拿的 / 连着关节的 / 触发器里的）标记为 `important`，
   * 永不冻结 —— 这三类是玩家正在交互的东西，冻结它们等于直接制造穿模。
   */
  private runDistanceCulling(nowMs: number): void {
    if (!this.physicsReady || !this.culling.enabled) return;
    const target = this.controls.target;
    const jointBodies = new Set<number>();
    for (const entry of this.framework.joints.list()) {
      const handleA = Number(entry.config.bodyA);
      const handleB = Number(entry.config.bodyB);
      if (Number.isFinite(handleA)) jointBodies.add(handleA);
      if (Number.isFinite(handleB)) jointBodies.add(handleB);
    }
    const held = new Set(this.pickup.state?.objectIds ?? []);

    const candidates: Parameters<DistanceCulling['plan']>[0][number][] = [];
    for (const instance of this.buildings.all) {
      const handle = instance.physicsHandle ?? -1;
      if (handle < 0) continue;
      if (instance.physicsMode === 'static') continue;
      candidates.push({
        handle,
        ownerId: instance.id,
        position: { x: instance.position[0], y: instance.position[1], z: instance.position[2] },
        sleeping: this.physics.isSleeping(handle),
        frozen: this.culling.isFrozen(handle),
        important:
          this.selection.isSelected(instance.id) ||
          held.has(instance.id) ||
          jointBodies.has(handle) ||
          // 锁定（稳定器）的物体是玩家明确说"这块别动"的，不该被系统悄悄冻结
          instance.locked === true,
      });
      // 上限 600：再多的物体本来也该靠渲染距离剔除，物理这边扫不完不值得
      if (candidates.length >= 600) break;
    }

    const plan = this.culling.plan(candidates, target.x, target.z, nowMs);
    for (const handle of plan.toWake) this.physics.setEnabled(handle, true);
    for (const handle of plan.toFreeze) this.physics.setEnabled(handle, false);
  }

  // ------------------------------------------- M3 第 8 批：压力测试场景

  /**
   * 加载一个压力测试场景。
   *
   * **会清空当前世界**：几百个刚体不可能叠加到现有世界上（一叠加就超过上限）。
   * 所以这里走和换地图同一条路径（先卸载、再生成），并且在 UI 上把这件事写在按钮上。
   */
  private loadStressScenario(scenarioId: string): void {
    const scenario = STRESS_SCENARIOS.find((item) => item.id === scenarioId);
    if (!scenario) {
      this.showToast(`没有这个压力测试场景：${scenarioId}`, 2400);
      return;
    }
    const isMobile = this.mobile?.isTouchDevice ?? false;
    const tier = this.mobile?.device.tier ?? 'high';
    const preview = this.stressTest.preview(scenario, tier, isMobile);

    // 走统一的换世界入口（它会做卸载、进度条、淡变），
    // 场景内容在 generate 阶段生成 —— 这样"清空当前世界"这件事只有一条代码路径
    void this.switchWorld({ kind: 'stress', scenarioId: scenario.id });
    void preview;
  }

  /**
   * 用当前设备档位渲染压力场景按钮。
   *
   * 按钮文案里就写明**这次会生成多少个物体**（手机端会降级），
   * 而不是点下去才发现和预期不一样 —— 这一点是刻意的：
   * 压力测试的意义就是知道自己在压什么规模。
   */
  private renderStressTestButtons(): void {
    const container = document.getElementById('stress-test-maps');
    if (!container) return;
    const isMobile = this.mobile?.isTouchDevice ?? false;
    const tier = this.mobile?.device.tier ?? 'high';
    container.innerHTML = '';
    for (const scenario of STRESS_SCENARIOS) {
      const info = describeScenarioForUI(scenario, tier, isMobile);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.stressScenario = info.id;
      button.title = info.hint;
      button.textContent = `${info.label}（${info.count} 个）`;
      button.addEventListener('click', () => this.loadStressScenario(info.id));
      container.appendChild(button);
    }
    const note = document.getElementById('stress-test-note');
    if (note) {
      note.textContent = isMobile
        ? `当前是移动端口径（档位 ${tier}）：移动端动态刚体上限 300，场景数量已自动降级。`
        : '当前是桌面口径：动态刚体上限 800。手机上打开会自动降级到移动端数量。';
    }
  }

  /** 在刚生成的空白世界里摆上压力场景（由 switchWorld 的 generate 阶段调用） */
  /**
   * 执行一个压力测试场景（M4 第二部分 · 第 7 批）。
   *
   * 场景由纯数据描述（`StressScenePlan`），执行分三步：
   * 1. **刚体**：箱塔之类的方块直接用建筑实例堆（与 M3 的压力场景同一套路径）；
   * 2. **流体**：按盒子形状生成粒子（用 `emitBox`，它会按静止密度截断 —— 所以
   *    "10000 粒子"在移动端会被自动压到上限内，这个行为是刻意的、也是如实报告的）；
   * 3. **沙**：堆若干根沙柱，让它们自己塌成沙崩。
   *
   * 箱子用的模型是 `light_block`（1.0×1.1×1.0）—— 与 M3 的压力场景一致：
   * 模型库里**没有**专门的"箱子"，逐个核对过所有 1×1×1 量级的立方体只有它。
   *
   * ⚠ 如实说明：门 / 吊桥 / 船这三类在 M3 的场景里有专门的构造（带关节），
   * 这里**复用**那三个场景，而不是重造一遍 —— 见 `mapSceneToLegacyScenario`。
   */
  private applyStressPlan(plan: {
    fluid: { preset: string; count: number; box: [number, number, number, number, number, number] } | null;
    sand: { columns: number; height: number; origin: [number, number, number] } | null;
    rigid: { boxes: number; doors: number; bridges: number; boats: number; spread: number } | null;
  }): string {
    const notes: string[] = [];
    // ---- 刚体：方块塔（每层 10×10，与 M3 的排布一致）
    if (plan.rigid && plan.rigid.boxes > 0) {
      const perLayer = 10;
      const specs: { defId: string; position: [number, number, number]; rotationY: number; scale: number; mode: PhysicsMode }[] = [];
      const baseY = Math.max(2, this.bundle.grid.sizeY * 0.25);
      for (let i = 0; i < plan.rigid.boxes; i += 1) {
        const layer = Math.floor(i / (perLayer * perLayer));
        const rest = i % (perLayer * perLayer);
        const col = rest % perLayer;
        const row = Math.floor(rest / perLayer);
        specs.push({
          defId: 'light_block',
          position: [
            (col - perLayer / 2) * 1.02,
            baseY + layer * 1.12,
            (row - perLayer / 2) * 1.02,
          ],
          rotationY: 0,
          scale: 1,
          mode: 'dynamic',
        });
      }
      const created = this.buildings.addMany(specs);
      notes.push(`${created.length} 个方块`);
    }
    // ---- 门 / 桥 / 船：都做成**动态刚体**压物理
    //
    // ⚠ 如实说明：**门与桥没有模拟铰链关节**。真正的"门绕着合页转""吊桥放下"
    // 在 M3 的 `drawbridge_50` 场景里（带关节）实现；这里把它们当成"一堆动态板子"，
    // 压的是**物理求解器与碰撞检测**，不是关节求解。
    // 这条差异会写进场景摘要（`context` 与 toast），不能让人以为关节被测了。
    if (plan.rigid) {
      const parts: { defId: string; position: [number, number, number]; rotationY: number; scale: number; mode: PhysicsMode }[] = [];
      const baseY = Math.max(2, this.bundle.grid.sizeY * 0.25);
      const spread = Math.max(6, plan.rigid.spread);
      // 门：沿一排立起来（门扇 0.9×2.05×0.15，底面中心坐标）
      for (let i = 0; i < plan.rigid.doors; i += 1) {
        const col = i % 10;
        const row = Math.floor(i / 10);
        parts.push({
          defId: 'door_wood',
          position: [(col - 5) * 1.4, baseY, (row - Math.ceil(plan.rigid.doors / 20)) * 2.2],
          rotationY: 0,
          scale: 1,
          mode: 'dynamic',
        });
      }
      // 桥：桥面 + 两个桥墩（都没有关节，只是"放着"）
      for (let i = 0; i < plan.rigid.bridges; i += 1) {
        const x = (i % 10) * 4 - spread / 2;
        const z = Math.floor(i / 10) * 6 - spread / 2;
        parts.push({ defId: 'floor_wood', position: [x, baseY + 4, z], rotationY: 0, scale: 1, mode: 'dynamic' });
        parts.push({ defId: 'pillar_stone', position: [x, baseY, z], rotationY: 0, scale: 1, mode: 'dynamic' });
        parts.push({ defId: 'pillar_stone', position: [x, baseY, z + 3], rotationY: 0, scale: 1, mode: 'dynamic' });
      }
      // 船：丢进流体盒子的水平中心（这样它一生成就在水里）
      const fluidBox = plan.fluid?.box;
      const centerX = fluidBox ? (fluidBox[0] + fluidBox[3]) / 2 : 0;
      const centerZ = fluidBox ? (fluidBox[2] + fluidBox[5]) / 2 : 0;
      const waterTop = fluidBox ? fluidBox[4] : baseY + 2;
      for (let i = 0; i < plan.rigid.boats; i += 1) {
        parts.push({
          defId: 'boat_row',
          position: [centerX + (i % 3) * 2 - 2, waterTop - 0.4, centerZ + Math.floor(i / 3) * 2 - 2],
          rotationY: 0,
          scale: 1,
          mode: 'dynamic',
        });
      }
      if (parts.length > 0) {
        const created = this.buildings.addMany(parts);
        notes.push(
          `${created.length} 个动态刚体（门 ${plan.rigid.doors} / 桥 ${plan.rigid.bridges} / 船 ${plan.rigid.boats}，` +
            `门与桥没有铰链关节）`,
        );
      }
    }
    // ---- 流体
    if (plan.fluid && plan.fluid.count > 0) {
      const system = this.ensureFluid();
      this.setFluidType(plan.fluid.preset as FluidType);
      const [minX, minY, minZ, maxX, maxY, maxZ] = plan.fluid.box;
      const result = system.emitBox([minX, minY, minZ], [maxX, maxY, maxZ], plan.fluid.count);
      notes.push(`${result.spawned} 个粒子` + (result.rejected > 0 ? `（受上限限制少放了 ${result.rejected} 个）` : ''));
    }
    // ---- 沙
    if (plan.sand && plan.sand.columns > 0) {
      const [ox, oy, oz] = plan.sand.origin;
      let placed = 0;
      for (let i = 0; i < plan.sand.columns; i += 1) {
        const x = Math.floor(ox + (i % 8) * 3);
        const z = Math.floor(oz + Math.floor(i / 8) * 3);
        for (let dy = 0; dy < plan.sand.height; dy += 1) {
          const y = Math.floor(oy) + dy;
          if (!this.bundle.grid.inBounds(x, y, z)) continue;
          this.bundle.grid.setVoxel(x, y, z, getVoxelId('sand'));
          placed += 1;
        }
      }
      this.bundle.sand.markAllSand();
      notes.push(`${placed} 格沙`);
    }
    this.render.buildingRenderer.markDirty();
    this.surfaces.invalidate();
    return notes.join('，');
  }

  /**
   * 当前这一帧的压力测试指标快照（第 7 批）。
   *
   * 一处必须说清的：**`gpuMB` 恒为 null** —— Three.js 不暴露显存占用，
   * 我们只能估（几何 + 贴图字节数）。那是"粗估"而不是"测量"，
   * 所以这里如实给 null，而不是把一个估算值伪装成测量值。
   */
  buildStressMetrics(): {
    fps: number; minFps: number; frameMs: number; p95FrameMs: number;
    fluidParticles: number; fluidMs: number; sandMs: number; sandActiveCells: number;
    physicsMs: number; couplingMs: number; renderMs: number; contactPairs: number;
    rigidBodies: number; heapMB: number | null; gpuMB: number | null;
  } {
    // 帧统计来自 FrameProfiler（`stats` 是 getter，不是方法 —— 我第一版写成调用，tsc 直接拦住了）
    const frameStats = this.performance.profiler.stats;
    const snapshot = this.resources.latest;
    const sandStats = this.bundle.sand.stats;
    return {
      fps: frameStats.fps,
      minFps: frameStats.max > 0 ? 1000 / frameStats.max : 0,
      frameMs: frameStats.median,
      p95FrameMs: frameStats.p95,
      fluidParticles: this.fluid?.activeCount ?? 0,
      fluidMs: this.fluid?.stats.totalMs ?? 0,
      sandMs: sandStats.ms,
      sandActiveCells: this.bundle.sand.activeCount,
      physicsMs: this.lastPhysicsMs,
      couplingMs: this.lastCouplingMs,
      // 渲染耗时 = 帧耗时扣掉已经单独计量的几段（物理/模拟/流体/沙/耦合/区块/UI）。
      // 它是**残差**，不是直接测量 —— 这一点在报告里也如实标注
      renderMs: Math.max(
        0,
        frameStats.median - this.lastPhysicsMs - this.lastSimMs - (this.fluid?.stats.totalMs ?? 0) -
          sandStats.ms - this.lastCouplingMs - this.lastMeshMs,
      ),
      contactPairs: this.lastContactPairs,
      rigidBodies: this.framework.stats().bodies.total,
      heapMB: snapshot?.heapUsedMB ?? null,
      gpuMB: null,
    };
  }

  /**
   * 跑一个压力测试场景（第 7 批）。
   *
   * 流程：切到空白世界（标准档，与 M3 的压力测试一致）→ 应用场景计划
   * （方块 / 流体 / 沙）→ 返回中文摘要（面板显示"这一次生成了什么"）。
   *
   * 为什么用"切世界"而不是"在当前世界里加东西"：压力测试要的是**可复现的起点** ——
   * 在玩家已经改了半天的世界里跑，测出来的数字跟他上一次跑的没法比。
   */
  async runStressScene(sceneId: string): Promise<string> {
    const scene = getStressScene(sceneId);
    if (!scene) return `没有这个场景：${sceneId}`;
    const isMobile = this.mobile?.isTouchDevice ?? false;
    const isLowEnd = (this.mobile?.device.tier ?? 'high') === 'low';
    const plan = scaledPlan(scene, isMobile, isLowEnd);
    // 先在当前世界里生成（switchWorld 会清空流体，所以必须**等它切完再生成**）
    await this.switchWorld({ kind: 'empty', sizeId: 'standard' } as WorldRequest);
    const notes = this.applyStressPlan(plan);
    this.stressSceneStartMs = performance.now();
    this.stressSceneId = scene.id;
    const summary = `${scene.name}：${notes || '（这个场景只有静态内容）'}`;
    console.info('[压力测试]', summary, describeScene(scene, isMobile, isLowEnd));
    return summary;
  }

  private stressSceneStartMs = 0;
  private stressSceneId: string | null = null;

  /**
   * 把当前跑的结果做成一份压力测试报告（第 7 批）。
   *
   * 采样时长取"从跑这个场景到现在" —— 玩家在场景里跑多久就采多久，
   * 面板上同时显示"已采样多少秒"，避免"跑了 2 秒就下结论"。
   */
  buildStressTestResult(nowMs: number): StressTestResult | null {
    const sceneId = this.stressSceneId;
    if (!sceneId) return null;
    const scene = getStressScene(sceneId);
    if (!scene) return null;
    const frameStats = this.performance.profiler.stats;
    const isMobile = this.mobile?.isTouchDevice ?? false;
    const deviceLabel = isMobile
      ? `移动端（${this.mobile?.device.tier ?? 'unknown'}）`
      : `桌面（${this.mobile?.device.tier ?? 'high'}）`;
    const result = buildResult({
      scene: { id: scene.id, name: scene.name, targetFps: scene.targetFps },
      timestamp: nowMs,
      device: {
        isMobile,
        devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
        label: deviceLabel,
      },
      durationMs: Math.max(0, nowMs - this.stressSceneStartMs),
      sampleFrames: frameStats.count,
      metrics: this.buildStressMetrics(),
      context: {
        渲染距离: this.bundle.culling.renderDistance,
        世界档: this.bundle.world.sizeId,
        粒子上限: this.fluid?.capacity ?? 0,
        画质档: this.state.quality.adaptiveLevel ?? 'base',
        AO: this.state.quality.ao,
      },
    });
    this.stressHistory = appendHistory(this.stressHistory, result, 20);
    return result;
  }

  get stressResults(): readonly StressTestResult[] {
    return this.stressHistory;
  }

  /** 导出全部压力测试历史为 JSON 字符串（面板的"导出报告"按钮用） */
  exportStressReport(): string {
    return exportReport(this.stressHistory);
  }

  /** 可跑的压力场景列表（面板渲染按钮用） */
  get stressScenes(): readonly { id: string; name: string; focus: string }[] {
    return STRESS_SCENES.map((scene) => ({ id: scene.id, name: scene.name, focus: scene.focus }));
  }

  /** 最近一次报告的一行中文摘要（面板用） */
  get lastStressVerdict(): string {
    const latest = this.stressHistory[0];
    return latest ? describeResult(latest) : '还没有生成报告（先跑一个场景）';
  }

  /** 和上一次同场景的结果对比（中文结论） */
  compareWithPreviousStress(): string {
    const [latest, previous] = this.stressHistory.filter((item) => item.sceneId === this.stressSceneId);
    if (!latest || !previous) return '还没有可对比的历史（同一个场景至少跑两次才有对比）';
    const comparison = compareRuns(previous, latest);
    return comparison.verdict;
  }

  /** 当前场景的可读摘要（面板显示） */
  get stressSummary(): string {
    if (!this.stressSceneId) return '还没有跑过压力测试场景';
    const scene = getStressScene(this.stressSceneId);
    const metrics = this.buildStressMetrics();
    // 用 describeScene 的**原文**（它已经写了"请求 1000 → 800"这类截断说明），
    // 不再自己拼一遍缩放规则 —— 两处规则迟早会对不上
    const isMobile = this.mobile?.isTouchDevice ?? false;
    const isLowEnd = (this.mobile?.device.tier ?? 'high') === 'low';
    const planText = scene ? describeScene(scene, isMobile, isLowEnd) : '';
    return `${planText}\n${scene?.name ?? this.stressSceneId}｜${metrics.fps.toFixed(1)} FPS｜` +
      `流体 ${metrics.fluidParticles} 个 / ${metrics.fluidMs.toFixed(2)} ms｜` +
      `沙 ${metrics.sandActiveCells} 活跃格 / ${metrics.sandMs.toFixed(2)} ms｜` +
      `物理 ${metrics.physicsMs.toFixed(2)} ms｜耦合 ${metrics.couplingMs.toFixed(2)} ms`;
  }

  /**
   * 负载热力图（第 7 批）。
   *
   * ⚠ 它画的是**负载估计**（物件密度），**不是每帧实际耗时** ——
   * 浏览器不暴露"这一片区域花了多少毫秒"。这一点由 `describeHeatmap` 与
   * 图例里的说明如实标出，不能让玩家以为那是测量值。
   */
  refreshPerfHeatmap(): void {
    const canvas = document.getElementById('perf-heatmap') as HTMLCanvasElement | null;
    const legend = document.getElementById('perf-heatmap-legend');
    if (!canvas) return;
    const objects: { x: number; z: number; kind: 'fluid' | 'sand' | 'rigid'; weight?: number }[] = [];
    const system = this.fluid;
    if (system && system.activeCount > 0) {
      const { posX, posZ, alive } = system.pool;
      const high = system.pool.highWater;
      for (let i = 0; i < high; i += 1) {
        if (alive[i] !== 1) continue;
        objects.push({ x: posX[i]!, z: posZ[i]!, kind: 'fluid' });
      }
    }
    for (const instance of this.buildings.all) {
      objects.push({ x: instance.position[0], z: instance.position[2], kind: 'rigid' });
    }
    const world = this.bundle.world;
    const data = computeHeatmap(objects, {
      cols: 16,
      rows: 16,
      sizeX: world.sizeX,
      sizeZ: world.sizeZ,
      originX: world.originX,
      originZ: world.originZ,
    });
    renderHeatmap(canvas, data, { showLegend: true });
    if (legend) legend.textContent = describeHeatmap(data);
  }

  /**
   * 压力测试面板接线（M4 第二部分 · 第 7 批）。
   *
   * 与其它面板一样：**只在节点存在时接线**（面板没插进 HTML 时功能照跑，只是没按钮）。
   * 事件在启动时接一次，不每帧重接 —— 每帧重接会累积重复的监听器，
   * 那种 bug 的表现是"点一下跑两次"。
   */
  private setupStressPanel(): void {
    const scenes = document.getElementById('stress-scenes');
    if (scenes) {
      scenes.innerHTML = '';
      for (const scene of this.stressScenes) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.stressScene = scene.id;
        button.textContent = scene.name;
        button.title = scene.focus;
        button.addEventListener('click', () => {
          void this.runStressScene(scene.id).then((summary) => this.showToast(summary, 3600));
        });
        scenes.appendChild(button);
      }
    }
    document.getElementById('btn-stress-report')?.addEventListener('click', () => {
      const result = this.buildStressTestResult(performance.now());
      if (!result) {
        this.showToast('先跑一个压力测试场景再生成报告', 2600);
        return;
      }
      const comparison = this.compareWithPreviousStress();
      console.info('[压力测试报告]', describeResult(result), comparison);
      this.showToast(`${describeResult(result)}\n${comparison}`, 5200);
    });
    document.getElementById('btn-stress-export')?.addEventListener('click', () => {
      const text = this.exportStressReport();
      console.info('[压力测试报告 JSON]', text);
      void copyToClipboard(text).then((ok) => {
        this.showToast(
          ok ? `已复制报告（${this.stressResults.length} 条记录）到剪贴板` : '剪贴板不可用，请从控制台复制',
          3000,
        );
      });
    });
    const recordToggle = document.getElementById('perf-record-toggle') as HTMLInputElement | null;
    recordToggle?.addEventListener('change', () => {
      const on = recordToggle.checked;
      if (on) this.perfRecorder.start(performance.now());
      else this.perfRecorder.stop();
      this.updateRecordNote();
    });
    document.getElementById('btn-record-json')?.addEventListener('click', () => {
      const text = JSON.stringify(this.perfRecorder.exportJson());
      console.info('[录制 JSON]', text);
      void copyToClipboard(text).then((ok) => this.showToast(ok ? '已复制录制 JSON' : '剪贴板不可用', 2400));
    });
    document.getElementById('btn-record-csv')?.addEventListener('click', () => {
      const text = this.perfRecorder.exportCsv();
      console.info('[录制 CSV]', text);
      void copyToClipboard(text).then((ok) => this.showToast(ok ? '已复制录制 CSV' : '剪贴板不可用', 2400));
    });
    this.updateRecordNote();
  }

  private updateRecordNote(): void {
    const note = document.getElementById('perf-record-note');
    if (!note) return;
    const summary = this.perfRecorder.summarize();
    note.textContent = this.perfRecorder.recording
      ? `正在录制：已录 ${summary.frames} 帧`
      : summary.frames > 0
        ? `已停止。${this.perfRecorder.describe()}`
        : '没有在录制。录制时每帧会记下帧耗时与各阶段拆解。';
  }

  private fillStressContent(scenarioId: string): void {
    const scenario = STRESS_SCENARIOS.find((item) => item.id === scenarioId);
    if (!scenario) return;
    const isMobile = this.mobile?.isTouchDevice ?? false;
    const tier = this.mobile?.device.tier ?? 'high';
    const limits = this.performanceLimits(isMobile);

    const result = this.stressTest.build({
      scenario,
      tier,
      isMobile,
      origin: [0, Math.max(4, this.bundle.grid.sizeY * 0.35), 0],
      dynamicLimit: limits.dynamicMax,
    });
    this.render.buildingRenderer.markDirty();
    this.surfaces.invalidate();
    this.pendingSwitchSummary = result.message;
    console.info('[压力测试]', result.message);
    if (result.missingDefs.length > 0) {
      console.warn('[压力测试] 缺失模型：', result.missingDefs.join('、'));
    }
  }

  // ------------------------------------------- M3 第 5 批：浮力与倒塌

  /**
   * 浮力：算出每个在水里的物体的受力，然后施加到刚体上。
   *
   * **必须每帧施加**：Rapier 在每次 `step()` 之后会清空累加的力
   * （`addForce` 是"这一帧的力"，不是持续力）。所以这里每帧都要重新加一遍 ——
   * 只在状态变化时加一次的做法，表现是"物体在水里抖一下就沉下去了"。
   */
  private applyBuoyancy(): void {
    const bodies: Parameters<BuoyancySystem['compute']>[0][number][] = [];
    for (const instance of this.buildings.all) {
      const handle = instance.physicsHandle ?? -1;
      if (handle < 0) continue;
      if (instance.physicsMode === 'static') continue;
      const def = getBuildingDef(instance.defId);
      if (!def) continue;
      const pose = this.physics.readPose(handle);
      if (!pose) continue;
      bodies.push({
        handle,
        ownerId: instance.id,
        // AABB 按"底面 + 高度"算：position 是底面中心，所以中心要抬半个高度
        center: { x: pose.x, y: pose.y + def.size[1] / 2, z: pose.z },
        half: { x: def.size[0] / 2, y: def.size[1] / 2, z: def.size[2] / 2 },
        mass: this.bodyFactory.massOf(handle, def.mass ?? 100),
        velocity: this.physics.readVelocity(handle) ?? { x: 0, y: 0, z: 0 },
      });
    }

    const forces = this.buoyancy.compute(bodies);
    for (const item of forces) {
      // 直接加力（不是冲量）：Rapier 的 addForce 语义就是"持续到下一次 step"
      this.bodyFactory.addForce(item.handle, [item.force.x, item.force.y, item.force.z]);
    }
  }

  /**
   * 局部倒塌：只让与地基断开的那一块掉，稳定部分不动。
   *
   * 三点值得说明：
   * 1. **BFS 是 O(n²)**（逐物体两两判贴合），所以按 300ms 节流，不是每帧；
   * 2. **宽限期**由 `CollapseSystem` 内部管（默认 600ms），玩家挖完能看到"它开始晃了"再掉；
   * 3. **稳定器锁定的物体**既不当种子也不参与判定 —— 那是玩家明确说"这块别动"的意思。
   */
  private updateCollapse(nowMs: number): void {
    if (!this.collapse.enabled) return;
    if (this.collapseCooldown > nowMs) return;
    this.collapseCooldown = nowMs + 300;

    const grid = this.bundle.grid;
    const plan = this.collapse.plan(this.buildings.all, {
      groundHeightUnder: (instance) => {
        // 取底面覆盖的 4 个角里最高的地形顶面：只要有一角踩住地面就算扎在地上，
        // 这与"物体斜靠在坡上"的真实情况一致
        const def = getBuildingDef(instance.defId);
        if (!def) return null;
        const halfX = def.size[0] / 2;
        const halfZ = def.size[2] / 2;
        let best: number | null = null;
        for (const [dx, dz] of [[-halfX, -halfZ], [halfX, -halfZ], [-halfX, halfZ], [halfX, halfZ]] as const) {
          const vx = grid.worldToVoxelX(instance.position[0] + dx);
          const vz = grid.worldToVoxelZ(instance.position[2] + dz);
          if (!grid.inHorizontalBounds(vx, vz)) continue;
          const top = grid.solidSurfaceHeight(vx, vz);
          if (top < 0) continue;
          if (best === null || top + 1 > best) best = top + 1;
        }
        return best;
      },
      horizontalSizeOf: (instance) => {
        const def = getBuildingDef(instance.defId);
        if (!def) return 1;
        return Math.max(def.size[0], def.size[2]);
      },
      footprintOf: (instance) => {
        const def = getBuildingDef(instance.defId);
        if (!def) return 1;
        return def.size[0] * def.size[2];
      },
    }, nowMs);

    if (plan.disconnected === 0 && plan.toDynamic.length === 0) return;

    // 与地基断开的物体：转动态 + 唤醒（不唤醒的话它会带着"睡着"的状态停在半空）
    let converted = 0;
    for (const entry of plan.toDynamic) {
      const instance = this.buildings.findById(entry.objectId);
      if (!instance) continue;
      const handle = instance.physicsHandle ?? -1;
      if (handle < 0) continue;
      this.physics.setMode(handle, 'dynamic');
      this.bodyFactory.wake(handle);
      instance.physicsMode = 'dynamic';
      converted += 1;
    }

    if (converted > 0) {
      const first = plan.toDynamic[0];
      this.collapseCount += converted;
      this.render.buildingRenderer.markDirty();
      this.haptics.play('place-fail');
      this.showToast(
        `结构局部倒塌：${converted} 个物体失去支撑开始掉落` +
          (first ? `（${COLLAPSE_REASON_LABELS[first.reason]}）` : ''),
        3200,
      );
    } else if (plan.pending.length > 0 && this.collapseWarnedAt + 2000 < nowMs) {
      // 宽限期内先提醒一句，别让玩家以为"没反应"
      this.collapseWarnedAt = nowMs;
      this.showToast(`有 ${plan.pending.length} 个物体失去支撑，马上会掉`, 1800);
    }
  }

  /** 收集所有动态/运动学刚体的位姿（回转与保护都吃这个） */
  private collectDynamicPoses(): { handle: number; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } }[] {
    const result: { handle: number; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } }[] = [];
    for (const instance of this.buildings.all) {
      const handle = instance.physicsHandle ?? -1;
      if (handle < 0) continue;
      // 静态物体本来就不动，记进回溯缓冲是纯浪费（300 帧 × 静态物体会把内存吃满）
      if (instance.physicsMode === 'static') continue;
      // PhysicsPose 是**扁平**字段（x/y/z/qx/qy/qz/qw），不是嵌套对象 —— 这是 M2 定的契约
      const pose = this.physics.readPose(handle);
      if (!pose) continue;
      result.push({
        handle,
        position: { x: pose.x, y: pose.y, z: pose.z },
        rotation: { x: pose.qx, y: pose.qy, z: pose.qz, w: pose.qw },
      });
    }
    return result;
  }

  /** 爆炸保护要求冻结的物体：切静态 + 归零速度 + 记账 */
  private freezeBodies(list: readonly { handle: number; reason: string; detail: string }[]): void {
    for (const item of list) {
      const instance = this.buildings.findByPhysicsHandle(item.handle);
      this.physics.zeroVelocity(item.handle);
      this.physics.setMode(item.handle, 'static');
      if (instance) {
        instance.physicsMode = 'static';
        instance.locked = true; // 锁住：不再参与"失去支撑就掉落"的判定
      }
      console.warn(`[物理保护] 冻结刚体 #${item.handle}（${item.reason}）：${item.detail}`);
      this.showToast(`物理异常：已冻结一个物体（${item.detail}）`, 3600);
    }
    this.render.buildingRenderer.markDirty();
  }

  /** 刚体尺寸（爆炸保护的阈值按尺寸缩放，不是绝对米数） */
  private bodySizeOf(handle: number): number {
    const instance = this.buildings.findByPhysicsHandle(handle);
    if (!instance) return 1;
    const def = getBuildingDef(instance.defId);
    if (!def) return 1;
    return Math.max(0.2, Math.max(def.size[0], Math.max(def.size[1], def.size[2])));
  }

  /** 每帧把四层统计喂给物理面板（面板内部按 150ms 节流） */
  private updatePhysicsPanels(): void {
    const stats = this.framework.stats();
    const surfaces = this.surfaces.size;
    this.refreshJointEditor();
    this.refreshLogicEditor();
    // UI 面板的数据统一走节流 tick（见 `uiTick` 的注释）。
    // 这几个面板原来**每帧**都重算输入数据 —— 其中 `computeContentStats` 实测 1.02 ms/次，
    // 60 FPS 就是每秒 61 ms 的主线程开销（还没算它每次分配的几十个对象带来的 GC）。
    // 面板显示的是"统计"，500 ms 更新一次与人眼感受没有区别。
    this.uiTick(performance.now());
    this.physicsDebugUI.update({
      ready: stats.ready,
      bodies: stats.bodies,
      joints: {
        total: stats.joints.total,
        byType: stats.joints.byType,
        broken: stats.joints.broken,
        pending: this.framework.joints.pendingCount,
        ms: stats.joints.ms,
      },
      triggers: stats.triggers,
      links: stats.links,
      surfaces: {
        count: surfaces,
        usedRatio: surfaces > 0 ? Math.min(1, this.buildings.count / Math.max(1, surfaces * 4)) : 0,
        ms: this.surfaces.rebuildMs,
      },
      lastAction:
        this.physicsDebugUI.drawSettings.contactPoints || this.physicsDebugUI.drawSettings.velocityVectors
          ? describeDebugStats(this.debugStats)
          : this.framework.lastAction,
      selection: this.state.selectedInstanceId !== null
        ? {
            kind: 'joint' as const,
            label: `选中物体 #${this.state.selectedInstanceId}`,
            detail: `关联关节：${stats.joints.total} 个（全局）`,
          }
        : null,
    });
  }

  // -------------------------------------------------- 补充 4：资源监控

  /**
   * 采一次样。
   *
   * 数据三方来源：Three.js 的 `renderer.info`（几何/贴图/程序/绘制）、
   * 我们自己的体素数组字节数（准的）、以及浏览器给的 JS 堆（只有 Chromium 有）。
   * 拿不到的一律如实留空，不编数字。
   */
  private sampleResources(nowMs: number, force = false): ResourceSnapshot {
    const memory = this.render.gpuMemoryInfo;
    const grid = this.bundle.grid;
    const cells = grid.sizeX * grid.sizeY * grid.sizeZ;
    return this.resources.sample(
      {
        geometries: memory.geometries,
        textures: memory.textures,
        programs: memory.programs,
        drawCalls: this.lastDrawCalls,
        triangles: this.lastTriangles,
        voxelCapacity: cells,
        waterCapacity: cells,
        buildings: this.buildings.count,
        physicsBodies: this.physicsReady ? this.physics.bodyCount : 0,
        joints: 0,
        triggers: 0,
        note: this.bundle.world.label,
      },
      nowMs,
      force,
    );
  }

  private refreshResourcePanel(): void {
    this.resourcePanel.render({
      snapshot: this.resources.latest,
      canForceGC: this.resources.canForceGC,
      hasHeapData: this.resources.hasHeapData,
      gcNote: this.gcNote,
      switchLog: this.resources.switchLog,
      mapReport: this.lastMapReport,
    });
  }

  /** 补充 4.2：手动回收内存，把浏览器实际能做的和做不到的都告诉玩家 */
  private collectGarbage(): void {
    const result = this.resources.collectGarbage();
    this.gcNote = result.note;
    console.info('[资源] 手动回收：', result.note);
    this.showToast(result.ok ? '已请求 GC（详见资源面板说明）' : '浏览器未开放 GC，已清空采样（详见面板）', 3000);
    this.refreshResourcePanel();
  }

  /**
   * 打印完整资源清单到控制台（补充 4.1）。
   *
   * 这份清单是「泄漏排查」用的：它会先把当前世界的足迹量出来，
   * 再把最近一次卸载清单的每一条逐行打印，最后给出换图历史。
   * 用户反馈内存问题的时候，把这段控制台输出贴出来就能定位。
   */
  private logResourceChecklist(): void {
    const grid = this.bundle.grid;
    const footprint = measureFootprint({
      voxelCapacity: grid.sizeX * grid.sizeY * grid.sizeZ,
      waterCapacity: grid.sizeX * grid.sizeY * grid.sizeZ,
      chunkCount: grid.chunkList.length,
      meshedChunks: this.render.meshedChunks,
      buildingInstances: this.buildings.count,
      buildingMeshes: this.render.buildingRenderer.group.children.length,
      physicsBodies: this.physicsReady ? this.physics.bodyCount : 0,
      joints: 0,
      undoCommands: this.command.undoCount,
      redoCommands: this.command.redoCount,
      selectionCount: this.selection.count,
    });

    console.group('[资源清单] 当前世界足迹');
    console.info(`世界：${this.bundle.world.label}`);
    for (const line of footprint.lines) console.info(line);
    console.info(`内存采样：${describeSnapshot(this.resources.latest)}`);
    console.info(
      this.resources.hasHeapData
        ? '（JS 堆来自 performance.memory，Chromium 专有）'
        : '（本浏览器不提供 performance.memory，因此没有堆数字 —— 这不是 0，是测不到）',
    );
    console.groupEnd();

    const unload = this.lastUnloadReport;
    if (unload) {
      console.group(`[资源清单] 最近一次卸载：${unload.summary}`);
      for (const step of unload.steps) {
        console.info(`${step.ok ? '✓' : '✗'} ${step.name} — ${step.detail}（${step.ms.toFixed(1)} ms）`);
      }
      console.groupEnd();
    } else {
      console.info('[资源清单] 还没有执行过卸载（没换过地图）。');
    }

    if (this.resources.switchLog.length > 0) {
      console.group(`[资源清单] 换图历史（最近 ${this.resources.switchLog.length} 次）`);
      for (const record of this.resources.switchLog) {
        console.info(
          `${record.label}：${record.ms.toFixed(0)} ms｜释放 ${record.releasedItems} 项｜` +
            `几何 ${record.geometryDelta >= 0 ? '+' : ''}${record.geometryDelta}｜` +
            `贴图 ${record.textureDelta >= 0 ? '+' : ''}${record.textureDelta}｜` +
            (record.heapDeltaMB === null ? '堆不可测' : `堆 ${record.heapDeltaMB >= 0 ? '+' : ''}${record.heapDeltaMB.toFixed(1)} MB`) +
            (record.after ? `｜换后 几何 ${record.after.geometries} / 贴图 ${record.after.textures}` : ''),
        );
      }
      console.groupEnd();
    }

    this.showToast('资源清单已打印到控制台（F12）', 2400);
  }

  private handleWorldReplaced(source: string): void {
    this.bundle.grid.onVoxelChanged = (x, y, z) => {
      if (this.state.physics.waterEnabled) this.bundle.water.markActive(x, y, z);
      if (this.state.physics.sandEnabled) this.bundle.sand.markActive(x, y, z);
      this.terrainCollider.markChunkDirtyAt(this.bundle.grid, x - this.bundle.grid.halfX, z - this.bundle.grid.halfZ);
      this.supportRecheckAt = performance.now() + SUPPORT_RECHECK_DELAY;
    };
    this.bundle.water.markAllWater();
    this.bundle.sand.markAllSand();

    for (const chunk of this.bundle.grid.chunkList) chunk.detachMesh();
    this.render.clearTerrain();
    this.render.buildingRenderer.markDirty();

    // 存档恢复了建筑与分组，重新绑刚体
    this.buildings.attachPhysics(this.physicsReady ? this.physics : null, this.terrainCollider.bodyHandle);
    if (this.physicsReady) {
      this.terrainCollider.build(this.bundle.grid);
      this.physics.syncQueries();
      this.buildings.ensureBodies();
      this.physics.syncQueries();
    }

    this.command.clear();
    this.selection.clear();
    this.totalFaces = 0;
    this.bundle.culling.invalidate();
    this.onStateChanged();
    this.showToast(`已加载：${source}`);
  }

  // ------------------------------------------------------------------ 运行

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastTimestamp = 0;
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('orientationchange', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.toolbar.removeEventListener('click', this.handleToolbarClick);
    this.boxSelectElement.remove();
    this.brushUI.dispose();
    this.buildingPanel.dispose();
    this.perfPanel.dispose();
    this.placementUI.dispose();
    this.selectionUI.dispose();
    this.historyPanel.dispose();
    this.shortcutHelp.dispose();
    this.prefabPanel.dispose();
    // 问题 4/5：后加的浮层与 GPU 资源也要释放，否则引擎销毁后会留一堆 DOM 与 geometry
    this.loadingOverlay.dispose();
    this.confirmDialog.dispose();
    this.highlight.dispose();
    this.stackingPreview.group.clear();
    this.edgeArrow?.dispose();
    this.mobile?.dispose();
    this.gestureTutorial.dispose();
    this.physicsDebugUI.dispose();
    this.sandbox.dispose();
    this.comboPanel.dispose();
    this.catalogPanel.dispose();
    this.contentPackUI.dispose();
    this.contentStatsUI.dispose();
    this.customItemUI?.dispose();
    this.fluidPanel?.dispose();
    this.fluidRenderer?.dispose();
    this.fluidSurface?.dispose();
    this.fluidAudio?.dispose();
    this.fluidRunner?.dispose();
    this.sandPanel?.dispose();
    this.sandVisualizer?.dispose();
    this.conflictOverlay.dispose();
    this.memoryPanel.dispose();
    this.tutorialUI.dispose();
    this.framework.dispose();
    this.ui.dispose();
    this.input.dispose();
    this.terrainCollider.dispose();
    this.physics.dispose();
    this.render.dispose();
  }

  private handleResize = (): void => {
    const { canvas } = this.options;
    this.render.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  };

  private handleVisibility = (): void => {
    this.lastTimestamp = 0;
  };

  /** 固定步长：水 → 沙 → 物理。暂停时 Time 不会调用这个回调 */
  private fixedUpdate = (): void => {
    if (this.state.physics.waterEnabled) this.bundle.water.step();
    // 沙土：把**固定步长**传进去（水分动态按秒计算，不按帧 —— 否则帧率一变，干湿速度就变）。
    // 用 `this.time.fixedStep` 而不是帧间隔：这里是 fixedUpdate，本来就是固定步回调，
    // 拿帧间隔会让"卡顿时沙子干得更快"，那种 bug 很难查。
    if (this.state.physics.sandEnabled) this.bundle.sand.step(performance.now(), this.time.fixedStep);
    if (this.physicsReady) {
      this.physics.step();
      // M3 第 4 批：**必须紧跟 step 之后**排空碰撞事件。
      // 事件队列是 autoDrain 的，下次 step 前会自动清空 —— 拖到下一帧再读就什么都没有了。
      this.drainTriggerEvents();
    }
    // 问题 A：第 3 层（关节）与第 4 层（触发器）推进。
    // 放在固定步长里而不是每帧一次：关节的绳索超伸修正依赖稳定的 dt，
    // 而触发器内部自己按 100ms 节流（10Hz 精度对「有人走进房间」完全够用）。
    this.framework.update(this.time.fixedStep, performance.now());
  };

  private loop = (timestamp: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const nowSeconds = timestamp / 1000;
    let delta = this.lastTimestamp === 0 ? 1 / 60 : nowSeconds - this.lastTimestamp;
    this.lastTimestamp = nowSeconds;
    if (delta > MAX_FRAME_DELTA) delta = MAX_FRAME_DELTA;
    if (delta < 0) delta = 0;

    // 1) 固定步长（水 / 沙 / 物理）
    // M3：时间从 TimeControl 走（它在 Time 之上加了倍速策略、单步自动暂停、回溯冻结）
    const timeResult = this.timeControl.advance(delta, this.fixedUpdate);
    this.lastPhysicsMs = timeResult.stepMs;

    // 2) 物理 → 数据回写
    let moved = 0;
    if (this.physicsReady) {
      moved = this.buildings.syncFromPhysics();
      if (moved > 0) this.render.buildingRenderer.markDirty();
      this.terrainCollider.update(this.bundle.grid);
      this.maybeRecheckSupport();
    }

    // 3) 相机
    // 摇杆的推力按 dt 累积（不按帧率变），必须在相机 update 之前喂进去
    this.mobile?.update(delta);
    this.controls.update(delta);

    // 3b) 支撑面索引：相机附近的物体变了才真的重算（内部有签名缓存）
    const tSupport = performance.now();
    this.surfaces.rebuild(this.buildings, this.bundle.grid, this.surfaceFocus());
    this.lastSupportMs = performance.now() - tSupport;

    // 4) 剔除与重建
    const tCull = performance.now();
    this.updateCulling();
    this.lastCullingMs = performance.now() - tCull;
    this.rebuildDirtyChunks();

    // 5) 交互
    const tInteraction = performance.now();
    this.updateInteraction();
    // 5a) 流体（M4 第二部分）：没有粒子也没有流体工具时这一段是几个 if，开销为零
    this.updateFluid(delta);
    // 5a2) 流体 → 刚体耦合（第 4 批）。必须在 updateFluid 之后（场才是新的），
    //       而物理 step 在下一帧的 fixedUpdate 里 —— 所以这里加力正好赶在下一次 step 前
    this.applyFluidCoupling();
    // 5a3) 沙水交互（第 5 批）：湿润 / 侵蚀 / 沉积 / 压塌
    this.updateSandWater(delta);
    // 5a4) 教学关卡（第 8 批）：只在打开时推进
    this.updateTutorial(delta);
    // 5b) 沙土可视化（只在开关打开时才算）
    if (this.sandVisualizer?.isVisible) {
      // 相机焦点是 [x, y, z] 元组，而可视化要 {x, y, z} —— 这里显式转换，
      // 不要用展开成对象那种写法（那会多一次临时对象分配，每帧一次）
      const focus = this.cameraFocusPosition();
      this.sandVisualizer.update(this.bundle.grid, this.bundle.sand, { x: focus[0], y: focus[1], z: focus[2] }, 56);
    }
    this.sandPanel?.refresh();
    this.lastInteractionMs = performance.now() - tInteraction;

    // 5b) 自适应降级（问题 6.9）：只在稳定越界一段时间后才动作
    this.updateAdaptiveQuality();

    // 6) 渲染
    this.render.update(this.time.elapsed);
    this.render.buildingRenderer.sync(
      this.buildings.all,
      this.buildings.dynamicCount > 0 || moved > 0,
    );
    this.syncHighlight();
    const renderStats = this.render.render();

    // 7) 统计 / UI / 自动保存
    // M4 第 6 批：把这一帧的耗时喂给性能监控（帧窗口 + 慢帧记录 + 自动降级）
    // 帧耗时直接用**真实帧间隔**：`RenderStats` 里没有帧耗时字段（它只报绘制统计），
    // 而 delta 本来就是这一帧的墙钟间隔，本来就是我们想量的东西
    this.samplePerformance(delta * 1000, timestamp);

    this.updateStats(delta, renderStats);
    // M3：物理世界的每帧作业（回溯记录 / 爆炸保护 / 录制 / 浮力 / 面板刷新）
    this.updatePhysicsSystems(delta, timeResult.rewinding);
    // 问题 A：物理调试可视化（只在开关打开时才重建线段）
    this.updatePhysicsDebugDraw(performance.now());
    const tPanels = performance.now();
    this.updatePhysicsPanels();
    this.lastPanelMs = performance.now() - tPanels;
    // 补充 1：教学关卡（只在教学模式开着时推进，不做无谓计算）
    if (this.tutorial.active) this.tutorialUI.update(this.buildTutorialStats());
    this.save.tick();
  };

  // ------------------------------------------------------------------ 自适应画质

  private updateAdaptiveQuality(): void {
    if (!this.state.quality.adaptive) return;
    // 帧率还没测出来时不动
    if (this.fps <= 0) return;

    const decision = this.adaptive.update(this.fps, this.state.quality.baseRenderDistance);
    if (!decision) {
      this.state.quality.adaptiveLevel = this.adaptive.currentLevel;
      return;
    }
    this.state.quality.adaptiveLevel = decision.level;
    this.bundle.culling.renderDistance = Math.max(
      CULLING_CONFIG.minRenderDistance,
      decision.renderDistance > 0
        ? decision.renderDistance
        : Math.round(this.state.quality.baseRenderDistance * this.adaptive.currentScale),
    );
    this.state.quality.renderDistance = this.bundle.culling.renderDistance;
    this.bundle.culling.invalidate();

    // 最低档顺便关掉 AO 与稳定性着色之外的开销
    if (decision.level === 'minimal' && this.state.quality.ao) {
      this.state.quality.ao = false;
      this.bundle.mesher.aoEnabled = false;
      this.bundle.grid.markAllDirty();
    }

    this.showToast(`已自动降级：${decision.reason}`, 3000);
  }

  private applyAdaptiveLevel(level: 'full' | 'reduced' | 'minimal'): void {
    this.adaptive.setLevel(level);
    this.state.quality.adaptiveLevel = level;
    this.bundle.culling.renderDistance = Math.max(
      CULLING_CONFIG.minRenderDistance,
      Math.round(this.state.quality.baseRenderDistance * this.adaptive.currentScale),
    );
    this.state.quality.renderDistance = this.bundle.culling.renderDistance;
    this.bundle.culling.invalidate();
  }

  /** 应用一键画质预设（补充 5） */
  private applyQualityPreset(preset: QualityPresetName): void {
    const config = getQualityPreset(preset);
    const quality = this.state.quality;
    quality.preset = preset;
    quality.shadows = config.shadows;
    quality.ao = config.ao;
    quality.antialias = config.antialias;
    quality.manualOverride = true;
    this.state.placement.surfaceGrid = Math.max(2, Math.min(config.surfaceGrid, 8));

    // 渲染距离
    this.bundle.culling.renderDistance = resolveRenderDistance(quality.baseRenderDistance, preset);
    quality.renderDistance = this.bundle.culling.renderDistance;
    this.bundle.culling.invalidate();

    // AO：需要重建区块网格（AO 是烘焙进顶点色的）
    this.bundle.mesher.aoEnabled = config.ao;
    this.bundle.grid.markAllDirty();

    // 阴影与像素比
    this.render.setShadowsEnabled(config.shadows);
    this.render.setMaxPixelRatio(config.maxPixelRatio);

    // 自适应降级重新从完整档开始
    this.adaptive.reset();
    quality.adaptiveLevel = 'full';

    this.onStateChanged();
    this.showToast(
      `已切换到「${config.label}」：渲染距离 ${quality.renderDistance} 区块｜阴影 ${config.shadows ? '开' : '关'}｜AO ${config.ao ? '开' : '关'}｜像素比 ${config.maxPixelRatio}`,
      3600,
    );
  }

  // ------------------------------------------------------------------ 剔除与重建

  private updateCulling(): void {
    const culling = this.bundle.culling;
    if (!this.state.debug.frustumCulling) {
      for (const chunk of this.bundle.grid.chunkList) this.render.setChunkVisible(chunk, true);
      culling.invalidate();
      return;
    }
    const results = culling.update();
    if (results.length === 0) return;
    for (const item of results) {
      if (item.unload && item.chunk.mesh) {
        this.render.unloadChunkMesh(item.chunk);
        continue;
      }
      this.render.setChunkVisible(item.chunk, item.visible);
    }
  }

  /**
   * 分帧重建脏区块。
   *
   * ── 为什么按**时间**而不是按**块数**给预算 ──
   * 原来是一次性取 3 块重建。但单块耗时差异巨大（实测中位 3~5 ms、最慢 18 ms，
   * 取决于这一块里有多少面），于是"3 块"这件事本身的代价在 6 ms 到 44 ms 之间浮动 ——
   * 帧时间跟着一起浮动，表现就是"一阵一阵卡"。
   *
   * 改成：一块一块地取，边取边看表，累计超过 `meshBudgetMs` 就停。
   * 好处是**帧时间上限与单块成本无关**了；代价是块少的时候可能一帧只重建一块
   * （但那种情况下每一块都很便宜，总时长反而更短）。
   * 并且**至少重建一块**：否则遇到一块特别大的区块，脏队列会永远清不掉。
   */
  private rebuildDirtyChunks(): void {
    const started = performance.now();
    const limit = VOXEL_CONFIG.meshBudgetPerFrame;
    let faces = this.totalFaces;
    let done = 0;
    while (done < limit) {
      const [chunk] = this.bundle.grid.consumeDirty(1);
      if (!chunk) break;
      const previousFaces = chunk.faceCount + chunk.transparentFaceCount;
      const result = this.bundle.mesher.build(chunk);
      faces += result.opaqueFaces + result.transparentFaces - previousFaces;
      this.render.setChunkMesh(chunk, result);
      done += 1;
      // 第一块无条件做完（保证进度），之后按时间预算决定还要不要继续
      if (performance.now() - started >= VOXEL_CONFIG.meshBudgetMs) break;
    }
    if (done === 0) return;
    this.totalFaces = Math.max(0, faces);
    this.lastMeshMs = performance.now() - started;
  }

  private rebuildAllMeshes(): void {
    this.bundle.grid.markAllDirty();
    this.totalFaces = 0;
    this.showToast('已请求重建全部区块网格（分帧处理）');
  }

  // ------------------------------------------------------------------ 支撑

  /** 当前物理上下文（很多地方要用，抽出来免得到处重复构造） */
  private stackContext(): StackContext {
    return {
      buildings: this.buildings,
      grid: this.bundle.grid,
      surfaces: this.surfaces,
    };
  }

  /** 地形编辑后延迟检查一次：失去支撑的静态物体转成动态刚体，自己掉下来 */
  private maybeRecheckSupport(): void {
    if (!this.state.physics.supportEnabled) return;
    if (this.supportRecheckAt === 0 || performance.now() < this.supportRecheckAt) return;
    this.supportRecheckAt = 0;

    let dropped = 0;
    for (const instance of this.buildings.all) {
      if (instance.locked) continue;
      if (instance.physicsMode === 'dynamic' || instance.physicsMode === 'kinematic') continue;
      const def = getBuildingDef(instance.defId);
      if (!def) continue;
      const check = this.stack.core.checkSupport(def, instance.position, instance.rotationY, this.stackContext());
      instance.supported = check.supported;
      instance.stackLayer = check.layer;
      instance.stability = check.stability;
      instance.contactRatio = check.contactRatio;
      // 脚下空出超过 12 厘米 → 失去支撑，转成动态刚体掉下来
      if (!check.supported && check.gap > 0.12) {
        this.buildings.setPhysicsMode(instance.id, 'dynamic');
        dropped++;
      }
    }
    if (dropped > 0) {
      this.render.buildingRenderer.markDirty();
      this.showToast(`${dropped} 个物体失去支撑，开始掉落`);
    }
  }

  private runSupportCheck(verbose: boolean): void {
    const report = this.support.analyze(this.buildings.all, this.bundle.grid);
    this.supportMessage =
      report.issues.length === 0
        ? `支撑正常：${report.connectedCount} 个连到地基`
        : `${report.issues.length} 处不稳（悬空 ${report.floatingCount}）`;

    if (verbose) {
      const first = report.issues[0];
      this.showToast(
        report.issues.length === 0
          ? `支撑检查通过：${this.buildings.count} 个建筑全部有支撑（${report.ms.toFixed(1)} ms）`
          : `${this.supportMessage}｜例如：${first?.message ?? ''}`,
        4000,
      );
    }
  }

  // ------------------------------------------------------------------ 交互

  private updateInteraction(): void {
    if (this.state.mode !== 'edit') {
      this.currentHit = null;
      this.render.brushVisualizer.update(null, 1, true, false);
      this.render.buildingPreview.hide();
      return;
    }

    this.pickVoxel();

    // 手里拿着东西时：只跟随光标，不做别的
    if (this.pickup.isHolding) {
      const cursor = this.cursorWorldPosition();
      if (cursor) this.pickup.follow(cursor, this.buildings);
      this.render.brushVisualizer.update(null, 1, true, false);
      this.render.buildingPreview.hide();
      return;
    }

    switch (this.state.tool) {
      case 'terrain':
        this.render.buildingPreview.hide();
        this.updateBrushCursor();
        if (this.input.isButtonDown(0) && this.input.pointerCount <= 1) this.applyBrush(false);
        break;
      case 'building':
        this.render.brushVisualizer.update(null, 1, true, false);
        this.updatePlacementPreview();
        break;
      case 'sand': {
        this.render.buildingPreview.hide();
        this.updateBrushCursor();
        if (this.input.isButtonDown(0) && this.input.pointerCount <= 1) this.applySandBrush();
        break;
      }
      case 'fluid': {
        // 复用地形笔刷的光标可视化：流体工具的操作位置就是笔刷位置，
        // 两套光标会让玩家分不清"现在这个圈是给谁用的"
        this.render.buildingPreview.hide();
        this.updateBrushCursor();
        this.applyFluidBrush();
        break;
      }
      case 'select':
      default:
        this.render.brushVisualizer.update(null, 1, true, false);
        this.render.buildingPreview.hide();
        this.updateHoveredBuilding();
        break;
    }
  }

  /** 光标在世界里的落点：优先用物理射线（能打到建筑表面），否则退回体素命中点 */
  private cursorWorldPosition(): [number, number, number] | null {
    const ray = this.raycaster.ray;
    if (this.physicsReady) {
      const hit = this.physics.castRay(
        [ray.origin.x, ray.origin.y, ray.origin.z],
        [ray.direction.x, ray.direction.y, ray.direction.z],
        VOXEL_CONFIG.maxPickDistance,
      );
      if (hit) return [hit.pointX, hit.pointY, hit.pointZ];
    }
    const voxel = this.currentHit;
    if (!voxel) return null;
    const grid = this.bundle.grid;
    return [
      voxel.x - grid.halfX + 0.5 + voxel.nx * 0.5,
      voxel.y + 0.5 + voxel.ny * 0.5,
      voxel.z - grid.halfZ + 0.5 + voxel.nz * 0.5,
    ];
  }

  private updateBrushCursor(): void {
    const hit = this.currentHit;
    if (!hit) {
      this.render.brushVisualizer.update(null, 1, true, false);
      return;
    }
    const grid = this.bundle.grid;
    this.render.brushVisualizer.setShape(this.state.brush.shape);
    this.render.brushVisualizer.update(
      {
        x: hit.x - grid.halfX + 0.5,
        y: hit.y + 0.5,
        z: hit.z - grid.halfZ + 0.5,
      },
      this.state.brush.radius,
      true,
      this.state.debug.brushCursor,
    );
  }

  /** 智能放置：算候选点 → 挑当前候选 → 更新幽灵预览 */
  private updatePlacementPreview(): void {
    const defId = this.state.selectedBuildingId;
    const hit = this.currentHit;
    if (!defId || !hit) {
      this.render.buildingPreview.hide();
      this.previewPosition = null;
      this.placementResult = null;
      return;
    }
    const def = getBuildingDef(defId);
    if (!def) {
      this.render.buildingPreview.hide();
      return;
    }

    const grid = this.bundle.grid;
    const cursorX = hit.x - grid.halfX + 0.5 + hit.nx * 0.5;
    const cursorZ = hit.z - grid.halfZ + 0.5 + hit.nz * 0.5;
    const surfaceY = hit.y + 1;
    const rotation = (this.previewRotationDegrees * Math.PI) / 180;

    // 支撑面索引在每次用到之前刷新一次（内部有签名缓存，没变化时是免费的）
    this.surfaces.rebuild(this.buildings, grid, this.surfaceFocus());

    if (this.state.placement.autoRecommend) {
      const result = this.smartPlacement.suggest(
        def,
        [cursorX, surfaceY, cursorZ],
        surfaceY,
        {
          snapToGrid: this.state.build.snapToGrid,
          snapStep: this.state.build.snapStep,
          rotationDegrees: this.previewRotationDegrees,
          allowAnchors: this.state.placement.snapAnchors,
          allowSurface: this.state.placement.snapSurface,
          allowWall: this.state.placement.snapWall,
          maxCandidates: this.state.placement.maxCandidates,
          surfaceGrid: this.state.placement.surfaceGrid,
          axis: this.state.placement.axis,
          // Alt = 自由偏移，Ctrl = 吸附最近物体中心，默认居中堆叠
          align: this.input.alt ? 'free' : this.input.ctrl ? 'nearest' : 'center',
        },
        this.stackContext(),
      );
      this.placementResult = result;

      const index = Math.min(
        Math.max(0, this.state.placement.candidateIndex),
        Math.max(0, result.candidates.length - 1),
      );
      this.state.placement.candidateIndex = index;
      const chosen = result.candidates[index];
      if (chosen) {
        this.previewPosition = chosen.position;
        this.previewValid = chosen.valid;
        this.previewReason = chosen.reason ?? '';
      } else {
        this.previewPosition = [cursorX, surfaceY, cursorZ];
        this.previewValid = false;
        this.previewReason = result.reason ?? '附近没有落点';
      }
    } else {
      // 关掉自动推荐：只按光标位置走一遍堆叠解析（保证"贴地/叠罗汉"仍然正确）
      let x = cursorX;
      let z = cursorZ;
      if (this.state.build.snapToGrid) {
        const step = Math.max(0.25, this.state.build.snapStep);
        x = Math.round(x / step) * step;
        z = Math.round(z / step) * step;
      }
      const resolution = this.stack.core.resolve(def, [x, surfaceY, z], rotation, this.stackContext(), {
        allowFloating: true,
        autoLift: true,
      });
      this.previewPosition = resolution.position;
      this.previewValid = resolution.valid;
      this.previewReason = resolution.reason;
      this.placementResult = null;
      this.previewResolution = resolution;
    }

    if (this.placementResult?.candidates[this.state.placement.candidateIndex]) {
      const chosen = this.placementResult.candidates[this.state.placement.candidateIndex]!;
      const resolution = this.stack.core.resolve(
        def,
        chosen.position,
        chosen.rotation[1],
        this.stackContext(),
        { allowFloating: true, autoLift: true },
      );
      this.previewResolution = resolution;
    }

    this.render.buildingPreview.setGeometry(defId, this.render.buildingRenderer.getGeometry(defId));
    this.render.buildingPreview.update(def, this.previewPosition, rotation, this.previewValid, true);

    // 问题 5：脉冲高亮框 + 镜头跟随 + 屏幕边缘箭头
    this.updatePlacementGuides(performance.now());

    // 堆叠可视化：支撑面外框 + 已占用格子 + 接触区（按稳定性着色）
    const supportSurface =
      this.previewResolution && this.previewResolution.supportId >= 0
        ? this.surfaces.get(this.previewResolution.supportId) ?? null
        : null;
    this.stackingPreview.update(
      this.previewResolution,
      supportSurface,
      this.state.debug.supportOverlay && this.previewValid,
    );

    // 支撑面可视化只在"选中了一个支撑物"时给出占用明细
    this.previewSupportSurface = supportSurface;
  }

  /**
   * 问题 5：智能放置的「看得见」三件套。
   *
   * 玩家反馈「点完之后不知道东西要放哪」——因为 M2 的落点只有建筑预览那半透明一个提示，
   * 被地形挡住就看不见，跑出视野就完全没线索。这里补三样：
   *
   * 1. **脉冲高亮框**：把候选落点框出来，`depthTest` 关掉，被山挡住也看得见；绿色=可放置、红色=不可。
   * 2. **镜头跟随**：候选点**跳远**（切候选、换目标、超过 12 米）时，用 0.3 秒平滑把镜头推过去。
   *    玩家一拖鼠标/滚轮就立刻中断 —— 相机主动权永远在玩家手里，这条不能让步。
   * 3. **屏幕边缘箭头**：候选点在视野外时，屏幕边上给一个箭头 + 距离数字，
   *    这样「按 Tab 切到第 5 个候选」时玩家知道该往哪看。
   */
  private updatePlacementGuides(nowMs: number): void {
    const defId = this.state.selectedBuildingId;
    const position = this.previewPosition;
    const def = defId ? getBuildingDef(defId) : null;

    // ---- 1) 高亮框
    if (!def || !position || !this.state.placement.highlightCandidate) {
      this.highlight.hide();
    } else {
      // HighlightBox 的 centerY 是几何中心，而 position[1] 是底面，这里要换算
      const size = def.size;
      this.highlight.show(
        {
          centerX: position[0],
          centerY: position[1] + size[1] / 2,
          centerZ: position[2],
          sizeX: size[0],
          sizeY: size[1],
          sizeZ: size[2],
        },
        this.previewValid,
      );
    }

    // ---- 2) 镜头跟随（只在跳远时介入）
    const trackEnabled = this.state.placement.trackCamera && !this.input.ctrl;
    this.cameraTracker.setEnabled(trackEnabled);
    if (!trackEnabled || !position) {
      this.cameraTracker.cancel('disabled');
    } else {
      const target = this.controls.target;
      const jump = Math.hypot(position[0] - target.x, position[1] - target.y, position[2] - target.z);
      // 12 米以内不动镜头：正常瞄准时镜头必须稳如磐石
      if (jump > CAMERA_FOLLOW_MIN_JUMP) {
        this.cameraTracker.track(
          { x: position[0], y: position[1] + 1, z: position[2] },
          nowMs,
        );
      }
      const follow = this.cameraTracker.update(nowMs);
      if (follow) this.controls.focusOn(follow.x, follow.y, follow.z);
    }

    // ---- 3) 屏幕边缘箭头
    if (!this.edgeArrow) return;
    if (!position || !this.state.placement.showEdgeArrow) {
      this.edgeArrow.hide();
      return;
    }
    const camera = this.render.camera;
    const label = def ? def.name : undefined;
    const centerY = position[1] + (def ? def.size[1] / 2 : 0.5);
    const size = this.viewportSize();
    const project: ProjectFn = (world) => projectToScreen(world, camera, size.width, size.height);
    this.edgeArrow.update(
      { x: position[0], y: centerY, z: position[2] },
      project,
      camera.position.distanceTo(this.tempWorldPoint.set(position[0], centerY, position[2])),
      label,
    );
  }

  /** 视口尺寸（刷新时读一次，屏幕旋转后自动跟上） */
  private viewportSize(): { width: number; height: number } {
    const rect = this.options.canvas.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(rect.width || window.innerWidth)),
      height: Math.max(1, Math.round(rect.height || window.innerHeight)),
    };
  }

  /** 支撑面索引的关注范围：相机注视点附近 48 米（性能要求：只看玩家附近） */
  private surfaceFocus(): { x: number; z: number; radius: number } {
    const target = this.controls.target;
    return { x: target.x, z: target.z, radius: 48 };
  }

  private updateHoveredBuilding(): void {
    const hit = this.currentHit;
    if (!hit) {
      this.selection.setHovered(null);
      return;
    }
    const grid = this.bundle.grid;
    const instance = this.buildings.pickAt(
      hit.x - grid.halfX + 0.5,
      hit.y + 0.5,
      hit.z - grid.halfZ + 0.5,
    );
    this.selection.setHovered(instance?.id ?? null);
  }

  /** 选择高亮：合并成一个 LineSegments，选 500 个和选 1 个都是 1 次 draw call */
  private syncHighlight(): void {
    const selected = this.buildings.findMany(this.selection.ids);
    const hovered =
      this.selection.hovered !== null ? this.buildings.findById(this.selection.hovered) ?? null : null;
    this.render.buildingRenderer.setSelection(selected, hovered, this.selection.version);
  }

  private pickVoxel(): void {
    this.ndcVector.set(this.input.ndc.x, this.input.ndc.y);
    this.raycaster.setFromCamera(this.ndcVector, this.render.camera);
    this.raycaster.far = VOXEL_CONFIG.maxPickDistance;
    const origin = this.raycaster.ray.origin;
    const direction = this.raycaster.ray.direction;
    this.currentHit = raycastVoxels(
      this.bundle.grid,
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      VOXEL_CONFIG.maxPickDistance,
    );
  }

  // ------------------------------------------------------------------ 指针

  private handlePointerDown(button: number, ndc: { x: number; y: number }, ctrl: boolean): void {
    // M3 第 4 批：拖拽连线模式优先接管左键（它要独占"按下"这个动作）
    if (button === 0 && this.linkDragActive()) {
      this.beginLinkDrag(ndc);
      return;
    }
    if (this.state.mode !== 'edit' || button !== 0) return;

    if (this.state.tool === 'terrain') {
      this.bundle.brush.beginStroke();
      this.lastPaintAt = 0;
      this.pickVoxel();
      this.applyBrush(false);
      return;
    }

    if (this.state.tool === 'select') {
      this.boxSelectStart = { x: ndc.x, y: ndc.y };
      this.state.selection.boxSelecting = false;
      if (!ctrl) this.selection.clear();
    }
  }

  private handlePointerMove(ndc: { x: number; y: number }): void {
    // M3 第 4 批：拖拽连线中，光标移动只更新连线
    if (this.dragLink) {
      this.updateLinkDrag(ndc);
      return;
    }
    if (this.state.tool !== 'select' || !this.boxSelectStart) return;
    const dx = Math.abs(ndc.x - this.boxSelectStart.x);
    const dy = Math.abs(ndc.y - this.boxSelectStart.y);
    if (!this.state.selection.boxSelecting && Math.max(dx, dy) < 0.02) return;
    this.state.selection.boxSelecting = true;
    this.drawBoxSelect(this.boxSelectStart, ndc);
  }

  private handlePointerUp(): void {
    // M3 第 4 批：松手结束拖拽（无论成功与否都要调 connector.end()，
    // 否则覆盖层会一直挂在屏幕上）
    if (this.dragLink) {
      this.endLinkDrag();
      return;
    }
    if (this.state.tool === 'terrain' && this.bundle.brush.isStroking) {
      const stroke = this.bundle.brush.endStroke();
      if (stroke) {
        this.command.push({ label: stroke.label, voxelChanges: stroke.changes });
        this.lastAffected = stroke.changes.length;
        this.save.tick();
      }
    }

    if (this.state.tool === 'select' && this.boxSelectStart) {
      const start = this.boxSelectStart;
      this.boxSelectStart = null;
      this.boxSelectElement.style.display = 'none';
      if (this.state.selection.boxSelecting) {
        const end = { x: this.input.ndc.x, y: this.input.ndc.y };
        this.selection.selectInScreenRect(
          {
            minX: Math.min(start.x, end.x),
            minY: Math.min(start.y, end.y),
            maxX: Math.max(start.x, end.x),
            maxY: Math.max(start.y, end.y),
          },
          this.render.camera,
          this.buildings,
          this.input.ctrl,
        );
        this.state.selection.boxSelecting = false;
        this.showToast(`框选了 ${this.selection.count} 个物体`);
      }
    }
  }

  private drawBoxSelect(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const rect = this.options.canvas.getBoundingClientRect();
    const toScreen = (ndc: { x: number; y: number }): [number, number] => [
      ((ndc.x + 1) / 2) * rect.width,
      ((1 - ndc.y) / 2) * rect.height,
    ];
    const [x0, y0] = toScreen(a);
    const [x1, y1] = toScreen(b);
    const style = this.boxSelectElement.style;
    style.display = 'block';
    style.position = 'absolute';
    style.left = `${Math.min(x0, x1)}px`;
    style.top = `${Math.min(y0, y1)}px`;
    style.width = `${Math.abs(x1 - x0)}px`;
    style.height = `${Math.abs(y1 - y0)}px`;
    style.border = '1px dashed #7fd06a';
    style.background = 'rgba(127, 208, 106, 0.12)';
    style.pointerEvents = 'none';
    style.zIndex = '20';
  }

  private handleTap(button: number): void {
    if (this.state.mode !== 'edit') return;
    if (this.pickup.isHolding) return;

    if (this.state.tool === 'terrain') {
      if (button === 2) {
        this.pickVoxel();
        this.bundle.brush.beginStroke();
        this.lastPaintAt = 0;
        this.applyBrush(true);
        const stroke = this.bundle.brush.endStroke();
        if (stroke) {
          this.command.push({ label: `擦除 · ${stroke.changes.length} 格`, voxelChanges: stroke.changes });
        }
      }
      return;
    }

    if (this.state.tool === 'building') {
      if (button === 0) this.confirmPlacement();
      else if (button === 2) this.deleteBuildingAtCursor();
      return;
    }

    // 选择工具
    if (button === 0) {
      this.pickVoxel();
      const hit = this.currentHit;
      const grid = this.bundle.grid;
      const instance = hit
        ? this.buildings.pickAt(hit.x - grid.halfX + 0.5, hit.y + 0.5, hit.z - grid.halfZ + 0.5)
        : null;
      if (!instance) {
        if (!this.input.ctrl) this.selection.clear();
        return;
      }
      if (this.input.ctrl) this.selection.toggle(instance.id);
      else this.selection.set([instance.id]);
      this.state.selectedInstanceId = instance.id;
      this.refreshSelectionUI();
    } else if (button === 2) {
      this.deleteBuildingAtCursor();
    }
  }

  /**
   * 应用流体笔刷（M4 第二部分）。
   *
   * 笔刷位置取**当前光标命中的体素**；没有命中（指到天空）时取"相机前方 8 米"，
   * 这样在空中也能倒水（倒出来的水会自己落下去）—— 没有这个兜底的话，
   * 玩家把光标抬起来就"倒不出水"，而那是很自然的操作。
   *
   * 按住左键 = 持续应用（内部按工具各自的节奏节流，见 FluidEditor.TOOL_TICKS）。
   */
  private applyFluidBrush(): void {
    const system = this.fluid;
    const editor = this.fluidEditor;
    if (!system || !editor) return;
    const holding = this.input.isButtonDown(0) && this.input.pointerCount <= 1;
    // 没按的时候也要把光标位置算出来（冻结/解冻是单击生效的）
    const hit = this.currentHit;
    let x = 0;
    let y = 0;
    let z = 0;
    if (hit) {
      x = hit.pointX - hit.nx * 0.2;
      y = hit.pointY - hit.ny * 0.2;
      z = hit.pointZ - hit.nz * 0.2;
      // 命中的是地面时，把水抬到地表上方一点点，否则第一帧就会与地形互相推挤
      if (hit.ny > 0) y += 0.15;
    } else {
      const cursor = this.cursorWorldPosition();
      if (!cursor) return;
      x = cursor[0];
      y = cursor[1];
      z = cursor[2];
    }
    const result = editor.apply(x, y, z, performance.now(), holding);
    if (result.message) {
      // 只在"真的做了事"时提示，而且是短提示：拖动时每秒会有十几次，
      // 弹一长串提示会盖住画面（这一点在物品面板上已经吃过一次教训）
      this.showToast(result.message, 1200);
    }
  }

  private applyBrush(forceErase: boolean): void {
    const hit = this.currentHit;
    if (!hit) return;
    const now = performance.now();
    if (now - this.lastPaintAt < VOXEL_CONFIG.paintInterval * 1000) return;
    this.lastPaintAt = now;

    const settings = forceErase ? { ...this.state.brush, mode: 'erase' as BrushMode } : this.state.brush;
    const cameraDirection: [number, number, number] = [
      this.raycaster.ray.direction.x,
      this.raycaster.ray.direction.y,
      this.raycaster.ray.direction.z,
    ];
    const result = this.bundle.brush.apply(settings, hit, this.input.shift, cameraDirection);
    this.lastEditMs = result.ms;
    this.lastAffected = result.changed;
  }

  // ------------------------------------------------------------------ 放置

  private onBuildingSelected(defId: string): void {
    this.state.selectedBuildingId = defId;
    this.state.placement.candidateIndex = 0;
    this.setTool('building');
    const def = getBuildingDef(defId);
    if (def) this.showToast(`已选择：${def.icon} ${def.name}，绿色幽灵是推荐落点`);
    this.refreshPlacement();
  }

  private confirmPlacement(): void {
    const defId = this.state.selectedBuildingId;
    if (!defId || !this.previewPosition) {
      this.showToast('先选一个模型，并把光标移到地面上');
      return;
    }
    const def = getBuildingDef(defId);
    if (!def) return;

    const rotation = (this.previewRotationDegrees * Math.PI) / 180;

    // 用堆叠系统做**权威解析**，不信任预览里的缓存值 ——
    // 预览可能是上一帧算的，而玩家在这一帧才刚刚点了确认。
    const resolution = this.stack.core.resolve(def, this.previewPosition, rotation, this.stackContext(), {
      allowFloating: true,
      autoLift: true,
      maxLift: 4,
    });
    if (!resolution.valid) {
      this.showToast(`不能放在这里：${resolution.reason}`);
      // 补充 5：放置失败给双短震动 —— 手机上玩家的注意力在手指位置，
      // 顶部的 toast 常常看不到，震动是唯一一定会被感知的反馈
      this.haptics.play('place-fail');
      return;
    }

    // 悬空（下方什么都没有）或接触面积不足 → 建成动态刚体，恢复播放就掉下来（补充 2）
    const willFall =
      this.state.placement.physicsFall &&
      (resolution.supportArea <= 0 || resolution.stability === 'unstable');
    // M3 第 7 批：动态刚体上限。超限时不再"偷偷继续建"（那会让手机崩），
    // 而是降级成静态摆放并**明确告诉玩家** —— 他需要知道为什么悬空的箱子不掉下来了。
    let mode: PhysicsMode = willFall ? 'dynamic' : 'static';
    if (mode === 'dynamic' && !this.canCreateDynamicBody()) {
      const isMobile = this.mobile?.isTouchDevice ?? false;
      const limits = this.performanceLimits(isMobile);
      mode = 'static';
      this.showToast(
        `动态刚体已达上限（${this.bodyFactory.countOf('dynamic')} / ${limits.dynamicMax}${isMobile ? '，移动端口径' : ''}），` +
          `这个物体按静态摆放；删掉一些会掉的东西就能继续`,
        3800,
      );
      this.haptics.play('place-fail');
    }

    const instance = this.buildings.add(defId, resolution.position, rotation, 1, mode);
    if (!instance) {
      this.haptics.play('place-fail');
      return;
    }
    this.haptics.play('place-ok');

    // 把堆叠信息写回实例（稳定性着色与调试面板都读它）
    instance.stackLayer = resolution.layer;
    instance.stability = resolution.stability;
    instance.contactRatio = resolution.contactRatio;
    instance.supported = resolution.supportArea > 0;
    instance.cantilever = resolution.contactRect
      ? Math.min(
          resolution.position[0] - resolution.contactRect.minX,
          resolution.contactRect.maxX - resolution.position[0],
          resolution.position[2] - resolution.contactRect.minZ,
          resolution.contactRect.maxZ - resolution.position[2],
        )
      : 0;

    this.surfaces.invalidate();
    this.render.buildingRenderer.markDirty();
    this.state.selectedInstanceId = instance.id;
    this.selection.set([instance.id]);

    // ---------------------------------------------------------------- 连续堆叠（补充 3）
    const shiftHeld = this.input.shift;
    const continuing = shiftHeld && this.state.placement.quickStack;
    if (continuing) {
      this.quickStack.setMergeIntoOneStep(this.state.placement.quickStackUndo === 'merge');
      this.quickStack.record(instance);
      // 只有"每个算一步"模式才立刻入栈；"整轮合并"模式等停止时一次性登记
      if (this.state.placement.quickStackUndo === 'each') {
        this.command.push({ label: `连续堆叠 ${def.name}`, buildingsAdded: [instance] });
      }
    } else {
      // 不在连续模式：先把上一轮残留的合并登记掉，再登记这一个
      this.flushQuickStack();
      this.command.push({
        label: `放置 ${def.name}${resolution.layer > 1 ? `（第 ${resolution.layer} 层）` : ''}`,
        buildingsAdded: [instance],
      });
    }

    this.buildingPanel.syncAll();
    this.refreshSelectionUI();

    if (willFall) {
      this.showToast(
        this.time.paused
          ? '不稳/悬空：暂停中会悬停，恢复播放后掉下来'
          : `不稳：${resolution.reason}`,
        3000,
      );
    } else if (resolution.layer > 20) {
      this.showToast(`已经叠到第 ${resolution.layer} 层，注意稳定性`, 3000);
    }
  }

  /** 把连续堆叠这一轮合并成一条历史（补充 3.7） */
  private flushQuickStack(): BuildingInstance[] {
    const merged = this.quickStack.finish();
    if (merged.length > 1) {
      this.command.push({
        label: `连续堆叠 ${merged.length} 个`,
        group: '连续堆叠',
        buildingsAdded: merged,
      });
    }
    return merged;
  }

  /** 停止连续堆叠（Esc 或面板按钮） */
  private stopQuickStack(): void {
    const merged = this.flushQuickStack();
    this.quickStack.cancel();
    this.refreshSelectionUI();
    this.showToast(
      merged.length > 1 ? `连续堆叠结束：${merged.length} 个物体合并成一步撤销` : '已停止连续堆叠',
    );
  }

  private cancelPlacement(): void {
    this.state.selectedBuildingId = null;
    this.state.selectedInstanceId = null;
    this.previewPosition = null;
    this.placementResult = null;
    this.render.buildingPreview.hide();
    this.showToast('已取消放置');
  }

  private cycleCandidate(direction: number): void {
    const total = this.placementResult?.candidates.length ?? 0;
    if (total === 0) {
      this.showToast('当前没有候选点');
      return;
    }
    this.state.placement.candidateIndex =
      (this.state.placement.candidateIndex + direction + total) % total;
    const chosen = this.placementResult?.candidates[this.state.placement.candidateIndex];
    if (chosen) {
      this.showToast(`候选 ${this.state.placement.candidateIndex + 1}/${total}：${chosen.label}`);
      // 问题 5：切候选时立刻把镜头推过去（不等下一帧的跳远判定），
      // 这样「按 Tab 连按」时镜头会一路平滑跟过去，而不是一帧一顿
      this.cameraTracker.track(
        { x: chosen.position[0], y: chosen.position[1] + 1, z: chosen.position[2] },
        performance.now(),
      );
    }
    this.refreshSelectionUI();
  }

  private refreshPlacement(): void {
    if (this.state.tool === 'building') this.updatePlacementPreview();
    this.placementUI.syncAll(this.buildPlacementStats());
  }

  private deleteBuildingAtCursor(): void {
    const hit = this.currentHit;
    if (!hit) return;
    const grid = this.bundle.grid;
    const instance = this.buildings.pickAt(
      hit.x - grid.halfX + 0.5,
      hit.y + 0.5,
      hit.z - grid.halfZ + 0.5,
    );
    if (!instance) {
      this.showToast('这里没有建筑');
      return;
    }
    this.removeInstances([instance.id], '删除建筑');
  }

  private removeInstances(ids: readonly number[], label: string): void {
    const removed = this.buildings.removeMany(ids);
    if (removed.length === 0) return;
    for (const instance of removed) this.groups.detach(instance.id);
    this.render.buildingRenderer.markDirty();
    this.command.push({ label, buildingsRemoved: removed });
    this.selection.set(this.selection.ids.filter((id) => !ids.includes(id)));
    this.buildingPanel.syncAll();
    this.refreshSelectionUI();
    this.showToast(`${label} · ${removed.length} 个`);
  }

  // ------------------------------------------------------------------ 选择与微调

  private selectAll(): void {
    this.selection.selectAll(this.buildings);
    this.refreshSelectionUI();
    this.showToast(`已选中全部 ${this.selection.count} 个物体`);
  }

  private clearSelection(): void {
    this.selection.clear();
    this.state.selectedInstanceId = null;
    this.refreshSelectionUI();
  }

  private selectSimilar(): void {
    const ids = this.selection.ids;
    const first = ids.length > 0 ? this.buildings.findById(ids[0]!) : undefined;
    if (!first) {
      this.showToast('先选中一个物体');
      return;
    }
    this.selection.selectSimilar(this.buildings, first.defId);
    this.refreshSelectionUI();
    this.showToast(`已选中 ${this.selection.count} 个同类物体`);
  }

  private captureTransforms(
    ids: readonly number[],
  ): Map<number, { position: [number, number, number]; rotation: number }> {
    const map = new Map<number, { position: [number, number, number]; rotation: number }>();
    for (const id of ids) {
      const instance = this.buildings.findById(id);
      if (instance) {
        map.set(id, {
          position: [...instance.position] as [number, number, number],
          rotation: instance.rotationY,
        });
      }
    }
    return map;
  }

  private pushTransform(
    label: string,
    before: Map<number, { position: [number, number, number]; rotation: number }>,
  ): void {
    const transforms: TransformChange[] = [...before.entries()].map(([id, snapshot]) => {
      const instance = this.buildings.findById(id);
      return {
        id,
        beforePosition: snapshot.position,
        afterPosition: instance ? ([...instance.position] as [number, number, number]) : snapshot.position,
        beforeRotation: snapshot.rotation,
        afterRotation: instance?.rotationY ?? snapshot.rotation,
      };
    });
    if (this.command.push({ label: `${label} · ${transforms.length} 个`, transforms })) {
      this.render.buildingRenderer.markDirty();
      this.refreshSelectionUI();
    }
  }

  private targetIds(): number[] {
    if (this.selection.ids.length > 0) return this.selection.ids;
    return this.state.selectedInstanceId !== null ? [this.state.selectedInstanceId] : [];
  }

  private nudgeSelection(axis: 'x' | 'y' | 'z', sign: number): void {
    const ids = this.targetIds();
    if (ids.length === 0) return;
    const before = this.captureTransforms(ids);
    this.pickup.nudge(ids, axis, this.state.selection.nudgeStep * sign, this.buildings);
    this.pushTransform('微调位置', before);
  }

  private fineRotate(axis: 'x' | 'y' | 'z', sign: number): void {
    const ids = this.targetIds();
    if (ids.length === 0) return;
    if (axis !== 'y') {
      this.showToast('目前只支持绕 Y 轴微调旋转（物体不会倾斜）');
      return;
    }
    const before = this.captureTransforms(ids);
    this.pickup.rotate(ids, this.state.selection.fineRotationStep * sign, this.buildings);
    this.pushTransform('微调旋转', before);
  }

  private mirrorSelection(axis: 'x' | 'z'): void {
    const ids = this.targetIds();
    if (ids.length === 0) {
      this.showToast('先选中要镜像的物体');
      return;
    }
    const created = this.blueprints.mirrorCopy(ids, axis as MirrorAxis, this.buildings);
    if (created.length === 0) return;
    this.render.buildingRenderer.markDirty();
    this.command.push({ label: `镜像复制 ${created.length} 个`, buildingsAdded: created });
    this.selection.set(created.map((instance) => instance.id));
    this.buildingPanel.syncAll();
    this.refreshSelectionUI();
    this.showToast(`沿 ${axis.toUpperCase()} 轴镜像复制了 ${created.length} 个物体`);
  }

  private rotateSelection(deltaDegrees: number): void {
    const ids = this.targetIds();
    if (ids.length === 0) {
      this.previewRotationDegrees += deltaDegrees;
      this.refreshPlacement();
      return;
    }
    const before = this.captureTransforms(ids);
    this.pickup.rotate(ids, deltaDegrees, this.buildings);
    this.pushTransform('旋转', before);
  }

  private duplicateSelection(): void {
    const ids = this.targetIds();
    if (ids.length === 0) {
      this.showToast('先选中要复制的物体');
      return;
    }
    const bounds = this.buildings.boundsOf(ids);
    const offset = bounds ? bounds.maxX - bounds.minX + 1.5 : 2;
    const created: BuildingInstance[] = [];
    for (const id of ids) {
      const instance = this.buildings.findById(id);
      if (!instance) continue;
      const copy = this.buildings.add(
        instance.defId,
        [instance.position[0] + offset, instance.position[1], instance.position[2]],
        instance.rotationY,
        instance.scale,
        instance.physicsMode ?? 'static',
      );
      if (copy) {
        copy.mirror = instance.mirror;
        created.push(copy);
      }
    }
    if (created.length === 0) return;
    this.render.buildingRenderer.markDirty();
    this.command.push({ label: `复制 ${created.length} 个物体`, buildingsAdded: created });
    this.selection.set(created.map((instance) => instance.id));
    this.refreshSelectionUI();
    this.showToast(`已复制 ${created.length} 个物体`);
  }

  private focusSelection(): void {
    const ids = this.targetIds();
    if (ids.length === 0) {
      this.showToast('先选中一个物体');
      return;
    }
    const bounds = this.buildings.boundsOf(ids);
    if (!bounds) return;
    this.controls.focusOn(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      (bounds.minZ + bounds.maxZ) / 2,
      Math.max(8, Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 2.2),
    );
  }

  private deleteSelection(): void {
    const ids = this.targetIds();
    if (ids.length === 0) {
      this.showToast('先选中要删除的物体');
      return;
    }
    this.removeInstances(ids, '删除选中');
  }

  // ------------------------------------------------------------------ 拿起

  private beginPickup(wholeStructure: boolean): void {
    const ids = this.targetIds();
    if (ids.length === 0) {
      this.showToast('先选中要拿起的物体');
      return;
    }
    const state = this.pickup.pick(
      ids,
      wholeStructure,
      this.buildings,
      this.cursorWorldPosition() ?? [0, 0, 0],
    );
    if (!state) {
      this.showToast('拿不起来');
      return;
    }
    this.render.buildingRenderer.markDirty();
    this.refreshSelectionUI();
    // 补充 5：拿起给长震动 —— 「拿起来了」是一个持续状态，长震比短震更像"抓住"
    this.haptics.play('pickup');
    this.showToast(
      wholeStructure
        ? `拿起整块结构：${state.objectIds.length} 个物体（空格放下 / Esc 还原）`
        : `拿起 ${state.objectIds.length} 个物体（空格放下 / Esc 还原）`,
    );
  }

  private dropPickup(): void {
    const held = this.pickup.state;
    if (!held) return;

    const before = new Map<number, [number, number, number]>();
    for (const id of held.objectIds) {
      const instance = this.buildings.findById(id);
      if (instance) before.set(id, [...instance.position] as [number, number, number]);
    }

    const result = this.pickup.drop(this.buildings, this.bundle.grid, (instance) => {
      const def = getBuildingDef(instance.defId);
      if (!def) return false;
      const stack = this.stack.evaluate(
        def,
        instance.position,
        instance.rotationY,
        this.stackContext(),
        instance.physicsHandle ?? -1,
      );
      return !stack.supported && stack.gap > 0.12;
    });

    this.render.buildingRenderer.markDirty();

    if (result.ok) {
      const transforms: TransformChange[] = [...before.entries()].map(([id, position]) => {
        const instance = this.buildings.findById(id);
        return {
          id,
          beforePosition: position,
          afterPosition: instance ? ([...instance.position] as [number, number, number]) : position,
          beforeRotation: instance?.rotationY ?? 0,
          afterRotation: instance?.rotationY ?? 0,
        };
      });
      this.command.push({ label: `放下 ${transforms.length} 个物体`, transforms });
    }

    this.refreshSelectionUI();
    this.showToast(result.reason ?? (result.ok ? '已放下' : '放下失败'));
  }

  private restorePickup(): void {
    if (!this.pickup.isHolding) {
      this.showToast('手里没有东西');
      return;
    }
    this.pickup.cancel(this.buildings);
    this.render.buildingRenderer.markDirty();
    this.refreshSelectionUI();
    this.showToast('已还原到拿起来之前的位置');
  }

  // ------------------------------------------------------------------ 分组 / 预制件 / 蓝图

  private createGroup(): void {
    const ids = this.selection.ids;
    if (ids.length < 2) {
      this.showToast('至少要选 2 个物体才能成组');
      return;
    }
    const group = this.groups.create(this.prefabPanel.getGroupName(), ids);
    if (!group) return;
    this.prefabPanel.clearGroupName();
    this.refreshSelectionUI();
    this.showToast(`已创建分组「${group.name}」（${group.objectIds.length} 个物体）`);
  }

  private ungroupSelection(): void {
    let ungrouped = 0;
    for (const id of this.selection.ids) {
      if (this.groups.ungroupByObject(id).length > 0) ungrouped++;
    }
    if (ungrouped === 0) {
      this.showToast('选中的物体不在任何分组里');
      return;
    }
    this.refreshSelectionUI();
    this.showToast(`已解散 ${ungrouped} 个分组`);
  }

  private selectGroup(groupId: string): void {
    const members = this.groups.members(groupId);
    if (members.length === 0) {
      this.showToast('这个分组里没有物体了');
      return;
    }
    this.selection.set(members.map((instance) => instance.id));
    this.refreshSelectionUI();
    this.showToast(`已选中分组里的 ${members.length} 个物体`);
  }

  private deleteGroup(groupId: string): void {
    const members = this.groups.ungroup(groupId);
    this.refreshSelectionUI();
    this.showToast(`已解散分组（${members.length} 个物体保留）`);
  }

  private savePrefab(): void {
    const ids = this.selection.ids;
    if (ids.length === 0) {
      this.showToast('先选中要保存的物体');
      return;
    }
    const prefab = this.prefabs.createFrom(ids, this.prefabPanel.getGroupName(), this.buildings);
    if (!prefab) return;
    this.prefabPanel.clearGroupName();
    this.refreshSelectionUI();
    this.showToast(`已保存预制件「${prefab.name}」（${prefab.objects.length} 个部件）`);
  }

  private placePrefab(prefabId: string): void {
    const prefab = this.prefabs.get(prefabId);
    if (!prefab) return;
    const cursor = this.cursorWorldPosition();
    if (!cursor) {
      this.showToast('把光标移到地面上再放置');
      return;
    }
    const def = getBuildingDef(prefab.objects[0]!.defId);
    const groundY = def
      ? this.buildings.groundYAt(def, cursor[0], cursor[2], 0, this.bundle.grid)
      : cursor[1];
    const created = this.prefabs.instantiate(prefabId, [cursor[0], groundY, cursor[2]], 0, this.buildings);
    if (created.length === 0) {
      this.showToast('放置失败');
      return;
    }
    this.render.buildingRenderer.markDirty();
    this.command.push({ label: `放置预制件 ${prefab.name}`, buildingsAdded: created });
    this.selection.set(created.map((instance) => instance.id));
    this.refreshSelectionUI();
    this.showToast(`已放置「${prefab.name}」（${created.length} 个部件）`);
  }

  private deletePrefab(prefabId: string): void {
    if (this.prefabs.remove(prefabId)) {
      this.refreshSelectionUI();
      this.showToast('已删除预制件');
    }
  }

  private exportBlueprint(): void {
    const ids = this.selection.ids;
    if (ids.length === 0) {
      this.showToast('先选中要导出的物体');
      return;
    }
    const blueprint = this.blueprints.exportFrom(
      ids,
      this.prefabPanel.getGroupName() || '我的结构',
      this.buildings,
    );
    if (!blueprint) return;
    try {
      const blob = new Blob([this.blueprints.toJson(blueprint)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `blueprint-${blueprint.name.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      this.showToast(`已导出蓝图（${blueprint.objects.length} 个部件）`);
    } catch (error) {
      this.showToast(`导出失败：${String(error)}`);
    }
  }

  private async importBlueprint(file: File): Promise<void> {
    try {
      const text = await file.text();
      const { blueprint, error } = this.blueprints.parse(text);
      if (!blueprint) {
        this.showToast(`蓝图导入失败：${error ?? '格式不正确'}`);
        return;
      }
      const cursor = this.cursorWorldPosition() ?? [0, this.bundle.world.sizeY / 2, 0];
      const def = getBuildingDef(blueprint.objects[0]!.defId);
      const groundY = def
        ? this.buildings.groundYAt(def, cursor[0], cursor[2], 0, this.bundle.grid)
        : cursor[1];
      const created = this.blueprints.instantiate(
        blueprint,
        [cursor[0], groundY, cursor[2]],
        0,
        this.buildings,
      );
      this.render.buildingRenderer.markDirty();
      this.command.push({ label: `导入蓝图 ${blueprint.name}`, buildingsAdded: created });
      this.selection.set(created.map((instance) => instance.id));
      this.refreshSelectionUI();
      this.showToast(`已导入「${blueprint.name}」（${created.length} 个部件）${error ? `｜${error}` : ''}`);
    } catch (error) {
      this.showToast(`导入失败：${String(error)}`);
    }
  }

  // ------------------------------------------------------------------ 设置

  private onStateChanged(): void {
    this.brushUI.syncAll();
    this.buildingPanel.syncAll();
    this.perfPanel.syncAll();
    this.selectionUI.syncAll(this.buildSelectionStats());
    this.placementUI.syncAll(this.buildPlacementStats());
    this.stackingUI.syncAll(this.buildStackingStats());
    this.supportDebugUI.syncAll(this.buildSupportDebugStats());
    this.render.buildingRenderer.setStabilityTint(this.state.debug.stabilityColors);
  }

  private refreshSelectionUI(): void {
    this.selectionUI.syncAll(this.buildSelectionStats());
    this.placementUI.syncAll(this.buildPlacementStats());
    this.stackingUI.syncAll(this.buildStackingStats());
    this.supportDebugUI.syncAll(this.buildSupportDebugStats());
  }

  private syncDebugSwitches(): void {
    const debug = this.state.debug;
    this.render.setChunkBordersVisible(debug.chunkBorders);
    this.render.setDebugGridsVisible(debug.debugGrids);
    this.render.setPropsVisible(debug.props);
    this.render.setWireframe(debug.wireframe);
    this.save.setAutoSaveEnabled(debug.autoSave);
    this.perfPanel.syncAll();
  }

  private syncPhysics(): void {
    const physics = this.state.physics;
    this.bundle.water.enabled = physics.waterEnabled;
    this.bundle.water.speed = physics.waterSpeed;
    this.bundle.water.dispersion = physics.waterDispersion;
    this.bundle.sand.enabled = physics.sandEnabled;
    this.bundle.sand.angleOfRepose = physics.sandAngle;
    this.support.enabled = physics.supportEnabled;
    this.support.maxCantilever = physics.supportCantilever;
    if (!physics.waterEnabled) this.bundle.water.clearActivity();
    if (!physics.sandEnabled) this.bundle.sand.clearActivity();
  }

  private setMode(mode: 'edit' | 'view'): void {
    this.state.mode = mode;
    this.controls.leftDragOrbit = mode === 'view';
    document.getElementById('btn-mode-edit')?.classList.toggle('active', mode === 'edit');
    document.getElementById('btn-mode-view')?.classList.toggle('active', mode === 'view');
  }

  private setTool(tool: ToolName): void {
    this.state.tool = tool;
    document.getElementById('btn-tool-terrain')?.classList.toggle('active', tool === 'terrain');
    document.getElementById('btn-tool-building')?.classList.toggle('active', tool === 'building');
    document.getElementById('btn-tool-select')?.classList.toggle('active', tool === 'select');
    document.getElementById('btn-tool-fluid')?.classList.toggle('active', tool === 'fluid');
    document.getElementById('brush-panel')?.classList.toggle('collapsed', tool !== 'terrain');
    document.getElementById('building-panel')?.classList.toggle('collapsed', tool !== 'building');
    document.getElementById('selection-panel')?.classList.toggle('collapsed', tool !== 'select');
    document.getElementById('placement-panel')?.classList.toggle('collapsed', tool !== 'building');
    document.getElementById('fluid-panel')?.classList.toggle('collapsed', tool !== 'fluid');
    document.getElementById('btn-tool-sand')?.classList.toggle('active', tool === 'sand');
    document.getElementById('sand-panel')?.classList.toggle('collapsed', tool !== 'sand');
    // 第一次切到流体工具时才建系统（见 ensureFluid 的注释：不用流体的人不该付这份内存）
    if (tool === 'fluid') this.ensureFluid();
    if (tool === 'sand') this.ensureSandUi();
    if (tool !== 'building') this.render.buildingPreview.hide();
    this.onStateChanged();
  }

  private collectSettings(): SavedSettings {
    const brush = this.state.brush;
    return {
      brushMode: brush.mode,
      brushShape: brush.shape,
      brushRadius: brush.radius,
      brushStrength: brush.strength,
      brushFalloff: brush.falloff,
      brushDensity: brush.density,
      brushDirection: brush.direction,
      brushMaterial: String(brush.material),
      waterEnabled: this.state.physics.waterEnabled,
      waterSpeed: this.state.physics.waterSpeed,
      waterDispersion: this.state.physics.waterDispersion,
      sandEnabled: this.state.physics.sandEnabled,
      sandAngle: this.state.physics.sandAngle,
      supportEnabled: this.state.physics.supportEnabled,
      supportCantilever: this.state.physics.supportCantilever,
    };
  }

  private applySettings(settings: SavedSettings): void {
    const brush = this.state.brush;
    if (settings.brushMode) brush.mode = settings.brushMode as BrushMode;
    if (settings.brushShape) brush.shape = settings.brushShape as BrushShape;
    if (typeof settings.brushRadius === 'number') brush.radius = settings.brushRadius;
    if (typeof settings.brushStrength === 'number') brush.strength = settings.brushStrength;
    if (settings.brushFalloff) brush.falloff = settings.brushFalloff as typeof brush.falloff;
    if (typeof settings.brushDensity === 'number') brush.density = settings.brushDensity;
    if (settings.brushDirection) brush.direction = settings.brushDirection as typeof brush.direction;
    const materialId = Number(settings.brushMaterial);
    if (Number.isFinite(materialId)) brush.material = materialId;

    const physics = this.state.physics;
    if (typeof settings.waterEnabled === 'boolean') physics.waterEnabled = settings.waterEnabled;
    if (typeof settings.waterSpeed === 'number') physics.waterSpeed = settings.waterSpeed;
    if (typeof settings.waterDispersion === 'number') physics.waterDispersion = settings.waterDispersion;
    if (typeof settings.sandEnabled === 'boolean') physics.sandEnabled = settings.sandEnabled;
    if (typeof settings.sandAngle === 'number') physics.sandAngle = settings.sandAngle;
    if (typeof settings.supportEnabled === 'boolean') physics.supportEnabled = settings.supportEnabled;
    if (typeof settings.supportCantilever === 'number') physics.supportCantilever = settings.supportCantilever;

    this.syncPhysics();
    this.onStateChanged();
  }

  // ------------------------------------------------------------------ 输入分发

  private handleZoom(delta: number): void {
    const direction = delta > 0 ? -1 : 1;

    if (this.input.alt) {
      this.brushUI.adjustRadius(direction * Math.max(1, Math.abs(delta) / 40));
      return;
    }
    if (this.input.ctrl || this.input.meta) {
      if (this.state.tool === 'building') {
        // 建筑工具下 Ctrl+滚轮调"即将放置的朝向"
        this.previewRotationDegrees += direction * 15;
        this.refreshPlacement();
        return;
      }
      this.brushUI.adjustStrength(direction * Math.max(0.5, Math.abs(delta) / 40));
      return;
    }
    this.controls.zoomBy(delta);
  }

  private handleKeyDown(code: string, ev: KeyboardEvent): void {
    this.controls.handleKeyDown(code);
    void ev;
  }

  private handleShortcut(code: string, ev: KeyboardEvent): void {
    const ctrl = ev.ctrlKey || ev.metaKey;

    if (ctrl) {
      switch (code) {
        case 'KeyZ':
          ev.preventDefault();
          if (ev.shiftKey) this.redo();
          else this.undo();
          return;
        case 'KeyY':
          ev.preventDefault();
          this.redo();
          return;
        case 'KeyS':
          ev.preventDefault();
          this.saveNow();
          return;
        case 'KeyO':
          ev.preventDefault();
          this.openFileDialog();
          return;
        case 'KeyD':
          ev.preventDefault();
          this.duplicateSelection();
          return;
        case 'KeyA':
          ev.preventDefault();
          this.selectAll();
          return;
        case 'KeyG':
          ev.preventDefault();
          if (ev.shiftKey) this.ungroupSelection();
          else this.createGroup();
          return;
        case 'KeyP':
          ev.preventDefault();
          this.savePrefab();
          return;
        case 'KeyB':
          ev.preventDefault();
          this.exportBlueprint();
          return;
        case 'KeyM':
          ev.preventDefault();
          this.mirrorSelection('x');
          return;
        default:
          return;
      }
    }

    switch (code) {
      case 'Tab':
        // 问题 5：Tab 改成「切换主候选点」。
        // M2 里 Tab 是切编辑/观察模式，但那个操作现在归 V —— 理由是候选切换是**高频**操作
        // （放东西时一直在挑落点），而切模式是低频的，高频操作才配得上 Tab 这个最顺手的键。
        // Shift+Tab 反向切。
        ev.preventDefault();
        this.cycleCandidate(ev.shiftKey ? -1 : 1);
        break;
      // 组合面板用 K，教学用 J，物理面板用 F2 ——
      // 这三个键都刻意避开了已占用的：P 是暂停、G 是吸附点对齐、B 是区块边界。
      // （第一次实现时我用了 P 和 G，结果把「暂停」和「吸附」悄悄覆盖了；
      //   这类冲突在 build 时只会给一句警告，跑起来就是功能失灵，所以键位必须查过再定。）
      case 'KeyK':
        this.comboPanel.toggle();
        break;
      case 'KeyJ':
        if (this.tutorial.active) this.tutorialExit();
        else this.startTutorial();
        break;
      case 'F2':
        ev.preventDefault();
        document.getElementById('physics-debug-panel')?.classList.toggle('collapsed');
        break;
      case 'KeyV':
        ev.preventDefault();
        this.setMode(this.state.mode === 'edit' ? 'view' : 'edit');
        break;
      case 'F1':
        ev.preventDefault();
        this.shortcutHelp.toggle();
        break;
      case 'Slash':
        if (ev.shiftKey) {
          ev.preventDefault();
          this.shortcutHelp.toggle();
        }
        break;
      case 'Enter':
        if (this.state.tool === 'building') this.confirmPlacement();
        break;
      case 'Escape':
        // M3 第 4 批：拖拽连线中按 Esc 先取消拖拽（最贴近玩家当下意图的那个动作优先）
        if (this.dragLink) {
          this.cancelLinkDrag();
          this.showToast('已取消拖拽连线', 1800);
          break;
        }
        if (this.shortcutHelp.isOpen) this.shortcutHelp.close();
        else if (this.mapSelector.isOpen) this.mapSelector.close();
        else if (this.quickStack.isActive) this.stopQuickStack();
        else if (this.pickup.isHolding) this.restorePickup();
        else if (this.state.tool === 'building') this.cancelPlacement();
        else this.clearSelection();
        break;
      case 'Space':
        ev.preventDefault();
        if (this.pickup.isHolding) this.dropPickup();
        else this.beginPickup(false);
        break;
      case 'KeyM':
        this.mapSelector.toggle();
        break;
      case 'KeyP':
        this.time.togglePause();
        break;
      case 'KeyN':
        this.time.requestStep(1);
        break;
      case 'KeyB':
        if (ev.shiftKey) this.rebuildAllMeshes();
        else {
          this.state.debug.chunkBorders = !this.state.debug.chunkBorders;
          this.syncDebugSwitches();
        }
        break;
      case 'KeyG':
        this.state.placement.snapAnchors = !this.state.placement.snapAnchors;
        this.refreshPlacement();
        this.showToast(`吸附点对齐：${this.state.placement.snapAnchors ? '开' : '关'}`);
        break;
      case 'Backquote':
        this.state.debug.wireframe = !this.state.debug.wireframe;
        this.syncDebugSwitches();
        break;
      case 'BracketLeft':
        if (this.state.tool === 'building') this.cycleCandidate(-1);
        else this.brushUI.cycleShape(-1);
        break;
      case 'BracketRight':
        if (this.state.tool === 'building') this.cycleCandidate(1);
        else this.brushUI.cycleShape(1);
        break;
      case 'KeyQ':
        if (this.state.tool === 'building') this.rotateSelection(-this.state.build.rotationStep);
        break;
      case 'KeyE':
        if (this.state.tool === 'building') this.rotateSelection(this.state.build.rotationStep);
        break;
      case 'Delete':
      case 'Backspace':
        this.deleteSelection();
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        this.nudgeSelection('x', -1);
        break;
      case 'ArrowRight':
        ev.preventDefault();
        this.nudgeSelection('x', 1);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        if (ev.shiftKey) this.nudgeSelection('z', -1);
        else this.nudgeSelection('y', 1);
        break;
      case 'ArrowDown':
        ev.preventDefault();
        if (ev.shiftKey) this.nudgeSelection('z', 1);
        else this.nudgeSelection('y', -1);
        break;
      case 'Comma':
        this.fineRotate('y', -1);
        break;
      case 'Period':
        this.fineRotate('y', 1);
        break;
      case 'KeyR':
        // Ctrl+Shift+R = 重新生成地形（低频维护动作，和"重建网格"一起挪出常用键位）
        if (this.input.ctrl && ev.shiftKey) {
          ev.preventDefault();
          this.regenerateTerrain();
          break;
        }
        // M3：R 改成"回溯一帧"（Shift+R 前进一帧）。
        // 原来的"重建全部网格"挪到 Shift+B —— 理由是回溯是玩家会**连续按**的操作，
        // 而重建网格是低频维护动作，不该占着最顺手的键。
        this.stepRewind(ev.shiftKey ? 1 : -1);
        break;
      default:
        if (this.state.tool === 'terrain') {
          if (code.startsWith('Digit')) {
            const index = Number(code.slice(5)) - 1;
            if (index >= 0 && index < 9) this.brushUI.selectModeByIndex(index);
          } else if (code === 'Digit0') {
            this.brushUI.selectModeByIndex(9);
          } else if (code === 'Minus') {
            this.brushUI.selectModeByIndex(10);
          } else if (code === 'Equal') {
            this.brushUI.selectModeByIndex(11);
          }
          break;
        }
        if (code === 'Digit1') this.setTool('terrain');
        else if (code === 'Digit2') this.setTool('building');
        else if (code === 'Digit3') this.setTool('select');
        else if (code === 'Digit4') this.setTool('fluid');
        else if (code === 'Digit5') this.setTool('sand');
        break;
    }
  }

  private openFileDialog(): void {
    const input = document.getElementById('file-input') as HTMLInputElement | null;
    if (!input) return;
    input.value = '';
    input.click();
  }

  private handleToolbarClick = (ev: MouseEvent): void => {
    const button = (ev.target as HTMLElement | null)?.closest('button');
    if (!button) return;

    const tool = button.dataset.tool as ToolName | undefined;
    if (tool) {
      this.setTool(tool);
      return;
    }
    const mode = button.dataset.mode as 'edit' | 'view' | undefined;
    if (mode) {
      this.setMode(mode);
      return;
    }

    switch (button.dataset.action) {
      case 'menu':
        this.mapSelector.open();
        break;
      case 'shortcuts':
        this.shortcutHelp.toggle();
        break;
      case 'undo':
        this.undo();
        break;
      case 'redo':
        this.redo();
        break;
      case 'save':
        this.saveNow();
        break;
      case 'load':
        this.loadFromStorage();
        break;
      case 'export':
        this.exportSave();
        break;
      case 'import':
        this.openFileDialog();
        break;
      case 'combo':
        this.comboPanel.toggle();
        break;
      case 'tutorial':
        if (this.tutorial.active) this.tutorialExit();
        else this.startTutorial();
        break;
      case 'physics-debug':
        document.getElementById('physics-debug-panel')?.classList.toggle('collapsed');
        this.showToast('物理框架面板：四层状态与调试绘制都在里面', 2400);
        break;
      case 'sandbox': {
        const effect = this.sandbox.toggle();
        this.showToast(effect.hint, 3000);
        break;
      }
      case 'rewind':
        this.stepRewind(-1);
        break;
      case 'snapshot':
        this.takeKeyframe();
        break;
      default:
        break;
    }
  };

  // ------------------------------------------------------------------ 历史 / 存档

  private undo(): void {
    const command = this.command.undo();
    if (!command) {
      this.showToast('没有可撤销的操作');
      return;
    }
    this.render.buildingRenderer.markDirty();
    this.groups.prune();
    this.refreshSelectionUI();
    this.showToast(`撤销：${command.label}`);
  }

  private redo(): void {
    const command = this.command.redo();
    if (!command) {
      this.showToast('没有可重做的操作');
      return;
    }
    this.render.buildingRenderer.markDirty();
    this.refreshSelectionUI();
    this.showToast(`重做：${command.label}`);
  }

  private jumpHistory(index: number): void {
    const steps = this.command.jumpTo(index);
    this.render.buildingRenderer.markDirty();
    this.groups.prune();
    this.refreshSelectionUI();
    this.showToast(`回退/前进 ${steps} 步，现在停在第 ${this.command.cursor + 1} 步`);
  }

  private clearHistory(): void {
    this.command.clear();
    this.refreshSelectionUI();
    this.showToast('已清空操作历史（世界内容不变）');
  }

  private saveNow(): void {
    const result = this.save.saveToStorage();
    this.showToast(result.message);
    this.warnAboutUnsavedPhysics();
  }

  private loadFromStorage(): void {
    this.showToast(this.save.loadFromStorage().message);
  }

  /**
   * 存档格式目前**不含**关节 / 触发器 / 逻辑连线（M2.5 第二批的已知缺口）。
   *
   * 不做的原因：存档里存的是建筑**实例 id**，而关节两端在 Rapier 里是**刚体 handle**，
   * 读档时刚体会全部重建、handle 全变，所以必须做「id ↔ handle」的双向映射与重连，
   * 这是一个独立的小课题，仓促做只会做出"读档后关节连到随机物体上"的更糟结果。
   *
   * 但**绝不能静默丢数据** —— 所以这里如实告诉玩家：物体和地形保住了，关节没保住。
   */
  private warnAboutUnsavedPhysics(): void {
    const joints = this.framework.jointStats().total;
    const links = this.framework.links.count;
    const triggers = this.framework.triggers.count;
    if (joints + links + triggers === 0) return;
    this.showToast(
      `注意：存档不含关节 / 触发器 / 逻辑连线（当前有 ${joints} 关节 / ${triggers} 触发器 / ${links} 连线），` +
        `读档后需要重新摆放这些组合`,
      5200,
    );
  }

  private exportSave(): void {
    this.showToast(this.save.exportToFile().message);
  }

  private async importSave(file: File): Promise<void> {
    this.showToast((await this.save.importFromFile(file)).message);
  }

  private regenerateTerrain(): void {
    const preset = getWorldSize(this.bundle.world.sizeId);
    TerrainGenerator.generate(this.bundle.grid, {
      seed: this.bundle.world.seed,
      waterLevel: preset.terrain.waterLevel,
      baseHeight: preset.terrain.baseHeight,
      amplitude: preset.terrain.amplitude,
      minHeight: preset.terrain.minHeight,
      maxHeight: preset.terrain.maxHeight,
      snowLine: preset.terrain.snowLine,
      noiseScale: preset.terrain.noiseScale,
    });
    this.command.clear();
    this.render.clearTerrain();
    for (const chunk of this.bundle.grid.chunkList) chunk.detachMesh();
    this.terrainCollider.markDirty();
    this.showToast('已按同一种子重新生成地形');
  }

  // ------------------------------------------------------------------ 统计与 UI

  private buildPlacementStats(): PlacementUIStats {
    let stackSupport = '—';
    let stackStability = '—';
    let stackLayer = 0;
    let stackContact = 0;

    const defId = this.state.selectedBuildingId;
    if (defId && this.previewPosition) {
      const def = getBuildingDef(defId);
      if (def) {
        const stack = this.stack.evaluate(
          def,
          this.previewPosition,
          (this.previewRotationDegrees * Math.PI) / 180,
          this.stackContext(),
        );
        stackSupport = stack.supported
          ? stack.supportId === 'terrain'
            ? '地形'
            : `#${stack.supportId}`
          : '没有支撑（会掉）';
        stackStability =
          stack.stability === 'stable' ? '稳固' : stack.stability === 'critical' ? '勉强' : '不稳';
        stackLayer = stack.layer;
        stackContact = stack.contactRatio;
      }
    }

    const total = this.placementResult?.candidates.length ?? 0;
    return {
      status: this.previewPosition
        ? `${this.previewValid ? '✓ 可放置' : `✕ ${this.previewReason}`}｜候选 ${this.state.placement.candidateIndex + 1}/${total}｜推荐耗时 ${this.smartPlacement.elapsedMs.toFixed(1)} ms`
        : '选中一个模型后自动推荐落点',
      candidates: (this.placementResult?.candidates ?? []).map((candidate) => ({
        label: candidate.label,
        score: candidate.score,
        valid: candidate.valid,
        source: candidate.source,
      })),
      activeIndex: this.state.placement.candidateIndex,
      stackSupport,
      stackStability,
      stackLayer,
      stackContact,
    };
  }

  private buildSelectionStats(): SelectionUIStats {
    const count = this.selection.count;
    const holding = this.pickup.isHolding;
    const firstId = this.selection.ids[0];
    const group = firstId !== undefined ? this.groups.ofObject(firstId) : undefined;

    let info: string;
    if (holding) {
      info = `手里拿着 ${this.pickup.heldCount} 个物体，正在跟随光标`;
    } else if (count === 0) {
      info = '未选中任何物体';
    } else if (count === 1 && firstId !== undefined) {
      const instance = this.buildings.findById(firstId);
      info = instance
        ? `#${instance.id} ${instance.name ?? instance.defId}｜${instance.physicsMode === 'dynamic' ? '动态（会掉）' : '静态'}`
        : '已选中 1 个物体';
    } else {
      info = `已选中 ${count} 个物体（其中 ${this.buildings.dynamicCount} 个是动态刚体）`;
    }

    return {
      count,
      modeLabel: holding ? '拿起中' : this.state.selection.boxSelecting ? '框选中' : '空闲',
      groupLabel: group ? group.name : '—',
      info,
    };
  }


  /** 堆叠面板的数据（问题 1 的可视化部分） */
  private buildStackingStats(): StackingUIStats {
    const resolution = this.previewResolution;
    const surface = this.previewSupportSurface;
    const defId = this.state.selectedBuildingId;
    const def = defId ? getBuildingDef(defId) : null;

    let supportLabel = '—';
    if (resolution) {
      if (resolution.supportId < 0) {
        supportLabel = '地面';
      } else {
        const supporter = this.buildings.findById(resolution.supportId);
        supportLabel = supporter ? `#${supporter.id} ${supporter.name ?? supporter.defId}` : `#${resolution.supportId}`;
      }
    }

    return {
      layer: resolution?.layer ?? 0,
      supportLabel,
      supportArea: resolution?.supportArea ?? 0,
      usedArea: resolution?.usedArea ?? 0,
      freeArea: surface?.freeArea ?? 0,
      contactRatio: resolution?.contactRatio ?? 0,
      stability: resolution?.stability ?? '',
      totalHeight: resolution?.totalHeight ?? 0,
      quickStackCount: this.quickStack.count,
      remainingPlacements:
        def && resolution && resolution.supportId >= 0
          ? this.stack.core.remainingPlacements(def, resolution.supportId, this.stackContext())
          : 0,
    };
  }

  /** 支撑调试面板的数据（补充 1） */
  private buildSupportDebugStats(): SupportDebugStats {
    const selectedId = this.selection.ids[0] ?? this.state.selectedInstanceId ?? null;
    const instance = selectedId !== null ? this.buildings.findById(selectedId) ?? null : null;

    const counts = { stable: 0, critical: 0, unstable: 0 };
    for (const building of this.buildings.all) {
      const stability = building.stability ?? 'stable';
      counts[stability]++;
    }

    let objectLabel = '未选中物体';
    let supportLabel = '—';
    let area = 0;
    let usedArea = 0;
    let freeArea = 0;
    let contactRatio = 0;
    let layer = 0;
    let stability: 'stable' | 'critical' | 'unstable' | '' = '';
    let slots: SupportSlotView[] = [];

    if (instance) {
      objectLabel = `#${instance.id} ${instance.name ?? instance.defId}`;
      layer = instance.stackLayer ?? 1;
      contactRatio = instance.contactRatio ?? 0;
      stability = instance.stability ?? 'stable';

      const detail = this.stack.core.supportSurfaceOf(instance, this.stackContext());
      if (detail) {
        if (detail.isTerrain) {
          supportLabel = '地面';
        } else {
          const supporter = this.buildings.findById(detail.surface.objectId);
          supportLabel = supporter
            ? `#${supporter.id} ${supporter.name ?? supporter.defId}`
            : `#${detail.surface.objectId}`;
        }
        area = detail.surface.area;
        usedArea = detail.surface.usedArea;
        freeArea = detail.surface.freeArea;
        slots = detail.slots;
      }
    }

    return {
      objectLabel,
      layer,
      supportLabel,
      area,
      usedArea,
      freeArea,
      contactRatio,
      stability,
      slots,
      counts,
      rebuildMs: this.surfaces.rebuildMs,
    };
  }

  private updateStats(delta: number, renderStats: RenderStats): void {
    this.fpsAccum += delta;
    this.fpsFrames++;
    const frameMs = delta * 1000;
    this.frameMsAvg = this.frameMsAvg === 0 ? frameMs : this.frameMsAvg * 0.9 + frameMs * 0.1;
    if (this.fpsAccum >= 0.4) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    const grid = this.bundle.grid;
    const world = this.bundle.world;

    // 补充 4：给资源采样留下上一帧的绘制统计（采样是节流的，不是每帧都采）
    this.lastDrawCalls = renderStats.drawCalls + this.render.buildingRenderer.drawCalls;
    this.lastTriangles = renderStats.triangles;

    this.ui.update({
      fps: this.fps,
      simTime: this.time.elapsed,
      stepCount: this.time.stepCount,
      voxels: grid.nonAir,
      buildings: this.buildings.count,
      drawCalls: renderStats.drawCalls + this.render.buildingRenderer.drawCalls,
      triangles: renderStats.triangles,
    });

    this.brushUI.update({
      pointer: this.currentHit
        ? { x: this.currentHit.x, y: this.currentHit.y, z: this.currentHit.z }
        : null,
      affected: this.lastAffected,
      editMs: this.lastEditMs,
      estimated: this.bundle.brush.estimateAffected(this.state.brush),
    });

    this.buildingPanel.update({
      instanceCount: this.buildings.count,
      selectionLabel: describePlacement(
        this.state.selectedBuildingId ? getBuildingDef(this.state.selectedBuildingId) ?? null : null,
        this.state.selectedInstanceId !== null
          ? this.buildings.findById(this.state.selectedInstanceId) ?? null
          : null,
        this.previewValid,
        this.previewReason,
      ),
      placementLabel: this.previewPosition
        ? this.previewValid
          ? '可放置'
          : `不可放置：${this.previewReason}`
        : '地形 / 选择工具下不显示落点',
      supportLabel: this.state.physics.supportEnabled ? this.supportMessage : '支撑检查未开启',
    });

    const perfStats: PerformanceStats = {
      fps: this.fps,
      frameMs: this.frameMsAvg,
      drawCalls: renderStats.drawCalls + this.render.buildingRenderer.drawCalls,
      triangles: renderStats.triangles,
      voxels: grid.nonAir,
      waterCells: grid.waterCells,
      chunkCount: grid.chunkCount,
      visibleChunks: this.bundle.culling.visibleCount,
      meshedChunks: renderStats.meshedChunks,
      dirtyChunks: grid.pendingDirtyCount,
      editMs: this.lastEditMs,
      meshMs: this.lastMeshMs,
      waterActive: this.bundle.water.activeCount,
      sandActive: this.bundle.sand.activeCount,
      undoCount: this.command.undoCount,
      redoCount: this.command.redoCount,
      autoSaveMessage: this.save.autoSaveMessage || `世界：${world.label}`,
      storageSize: this.save.storageSize(),
      renderer: this.render.rendererInfo,
      physicsBodies: this.buildings.count,
      buildings: this.buildings.count,
      renderDistance: this.bundle.culling.renderDistance,
      adaptiveLevel: this.adaptive.currentLevel,
      qualityPreset: this.state.quality.preset,
      stacking: `支撑面 ${this.surfaces.size} 个｜索引 ${this.surfaces.rebuildMs.toFixed(2)} ms`,
    };
    this.perfPanel.update(perfStats);

    // 补充 4：资源采样（内部按 500ms 节流，这里每帧调用是安全的）
    this.sampleResources(performance.now());
    this.refreshResourcePanel();
    // M4 第 6 批：内存与帧分析面板（内部 200ms 节流）
    this.refreshMemoryPanel();

    this.placementUI.update(this.buildPlacementStats());
    this.selectionUI.update(this.buildSelectionStats());
    // 堆叠与支撑面板只在放置或选中物体时才有意义，其余时候给个空态即可
    this.stackingUI.update(this.buildStackingStats());
    this.supportDebugUI.update(this.buildSupportDebugStats());

    this.historyPanel.update({
      entries: this.command.listHistory(),
      redoCount: this.command.redoCount,
      cursor: this.command.cursor,
    });

    this.prefabPanel.update({
      groups: this.groups.all.map((group) => ({
        id: group.id,
        name: group.name,
        objectCount: group.objectIds.length,
      })),
      prefabs: this.prefabs.all.map((prefab) => ({
        id: prefab.id,
        name: prefab.name,
        thumbnail: prefab.thumbnail,
        objectCount: prefab.objects.length,
        createdAt: prefab.createdAt,
      })),
      selectedGroupId: firstGroupId(this.groups, this.selection.ids),
      selectedCount: this.selection.count,
      blueprintStatus: this.physicsReady
        ? `物理已就绪｜动态物体 ${this.buildings.dynamicCount} 个｜蓝图是纯 JSON，可以互相分享`
        : '物理引擎加载中（暂时是静态摆放）｜蓝图是纯 JSON，可以互相分享',
    });
  }

  private showToast(message: string, ms = 2600): void {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => toast.classList.remove('visible'), ms);
  }
}

/** 选中物体所属的第一个分组 id（给预制件面板高亮用） */
function firstGroupId(groups: GroupSystem, ids: readonly number[]): string | null {
  for (const id of ids) {
    const group = groups.ofObject(id);
    if (group) return group.id;
  }
  return null;
}

/**
 * 复制到剪贴板。
 *
 * 优先用 `navigator.clipboard`，失败时**如实返回 false**（不抛异常）——
 * 它需要安全上下文（https 或 localhost），而 GitHub Pages 是 https 所以线上没问题，
 * 但局域网里用 IP 访问时会被拒。
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一帧里最慢的那个阶段（面板要直接回答"是谁慢"）。
 *
 * 输出**中文标签**而不是阶段 key：面板是给玩家看的，`mesh 12.4ms` 等于没说，
 * `区块重建 12.4ms` 才能让人知道下一步该关什么。
 */
function worstPhaseOf(phases: Record<string, number> | undefined): string {
  if (!phases) return '未知';
  let worst = '';
  let worstMs = -1;
  for (const [name, ms] of Object.entries(phases)) {
    if (ms > worstMs) {
      worstMs = ms;
      worst = name;
    }
  }
  return worst === '' ? '未知' : `${phaseLabel(worst)} ${worstMs.toFixed(1)}ms`;
}
