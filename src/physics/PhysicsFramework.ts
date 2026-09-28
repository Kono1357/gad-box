/**
 * 物理框架（问题 A）：把物理能力按**四层**组织起来，并给每一层留出可观测的出口。
 *
 * 为什么非要分层？
 *
 * M2 的物理是「哪里用到就哪里调」——建筑系统直接 `physics.createBody()`，
 * 堆叠判断绕开 Rapier 自己算 AABB，水与沙又是两套独立元胞自动机。
 * 结果是：出了玄学问题（物体莫名穿模、堆好的塔自己散架、门不转）没有一个统一的
 * 地方能看出「现在到底有多少刚体、多少约束、谁在驱动谁」。
 *
 * 四层的划分不是抄引擎教科书，而是**按「出问题时该看哪一层」来切的**：
 *
 * ```
 * 第 1 层 · 刚体   RigidbodyLayer   —— 有哪些东西参与模拟，是什么模式（静/动/运动学）
 * 第 2 层 · 碰撞   ColliderLayer    —— 它们的形状是什么（本项目的碰撞体是从模型零件拼的）
 * 第 3 层 · 约束   JointLayer       —— 它们之间被什么连接（6 种关节）
 * 第 4 层 · 逻辑   LogicLayer       —— 什么时候发生什么（触发器 + 逻辑连线）
 * ```
 *
 * 每一层都有 `stats()`，面板上逐层显示。调参时按层排查：
 * 东西不动 → 看第 1 层；穿模 → 看第 2 层；该连着却散开 → 看第 3 层；没反应 → 看第 4 层。
 *
 * **职责边界**：这个类不碰 Three.js、不碰 DOM。第 4 层的动作（震动、提示、生成建筑……）
 * 一律包装成 `LogicActionRequest` 交给 Engine 注册的执行器去干 ——
 * 因为「播放震动能被 Node 单测」和「执行器里写 document」不可兼得，
 * 而这里更需要可测。
 */

import type { PhysicsWorld } from './PhysicsWorld';
import { JointSystem, type JointSystemStats } from './JointSystem';
import { TriggerSystem } from './TriggerSystem';
import { LogicLink, type LogicActionRequest, type LogicLinkSpec } from './LogicLink';
import type { JointConfig, JointType, MotorConfig } from '../data/jointTypes';
import type { PhysicsComponent, ComponentType } from '../data/physicsComponents';

/** 一层的统计 */
export interface LayerStats {
  name: string;
  /** 这一层有多少个东西 */
  count: number;
  /** 中文摘要 */
  summary: string;
  /** 上一次这一层花的时间（毫秒） */
  ms: number;
}

/** 四层合起来的快照 */
export interface FrameworkStats {
  ready: boolean;
  bodies: { total: number; dynamic: number; awake: number };
  colliders: { shapes: number; compoundBodies: number };
  joints: JointSystemStats;
  triggers: { total: number; enabled: number; occupied: number; firedTotal: number; ms: number };
  links: { total: number; enabled: number; fired: number };
  layers: LayerStats[];
  pendingComponents: number;
}

/** 数字 → 中文的层名（面板与日志共用，避免两处不一致） */
export const LAYER_NAMES = {
  rigidbody: '第 1 层 · 刚体',
  collider: '第 2 层 · 碰撞',
  joint: '第 3 层 · 约束',
  logic: '第 4 层 · 逻辑',
} as const;

export class PhysicsFramework {
  readonly joints: JointSystem;
  readonly triggers: TriggerSystem;
  readonly links: LogicLink;

  private readonly components = new Map<number, PhysicsComponent[]>();
  /** 第 1 层的模式覆盖：handle → 想要的模式（组件里声明的） */
  private readonly modeOverrides = new Map<number, 'dynamic' | 'kinematic' | 'static'>();
  private readonly componentMs = { rigidbody: 0, collider: 0, joint: 0, logic: 0 };
  private lastActionText = '暂无';
  private lastTriggerText = '';
  private actionHandler: ((request: LogicActionRequest) => void) | null = null;
  private lastColliderShapes = 0;
  private lastCompoundBodies = 0;
  private disposed = false;

  constructor(private readonly physics: PhysicsWorld) {
    this.joints = new JointSystem(physics);
    this.triggers = new TriggerSystem(physics);
    this.links = new LogicLink();

    // 触发器事件统一进逻辑层。这条线只接一次 —— 之前的设计是"谁用谁接"，
    // 结果同一批事件被处理了两遍（门被触发了两次，看起来像抖动）。
    this.triggers.onEvent = (event) => {
      // 触发器事件 → 逻辑事件。翻译放在这里而不是让 LogicLink 认识 TriggerEvent，
      // 是为了让第 4 层只依赖 data 层的事件定义（这样 LogicLink 零依赖、可 Node 单测）
      // 触发区的"宿主"（按钮/压力板本身）也要带上：
      // 逻辑连线的 sourceId 比对的是 `event.target` 与 `data.*` 里的若干字段，
      // 只带"进入者"的话，给按钮建的连线永远匹配不上（按钮没动，是踩它的人在动）
      const record = this.triggers.find(event.triggerId);
      this.dispatchEvent({
        type: 'toggle-light',
        target: String(event.ownerId),
        data: {
          triggerId: event.triggerId,
          tag: event.tag,
          phase: event.phase,
          count: event.count,
          triggerOwnerId: record ? record.ownerHandle : -1,
        },
      });
      this.lastTriggerText = `触发器「${event.tag}」${event.phase === 'enter' ? '进入' : '离开'}（区域内 ${event.count} 个）`;
    };
  }

  get isReady(): boolean {
    return this.physics.isReady;
  }

  /** 最近一次逻辑动作的中文描述（面板显示） */
  get lastAction(): string {
    return this.lastActionText;
  }

  /** 最近一次触发器事件的中文描述（面板"当前编辑对象"那一行用） */
  get lastTrigger(): string {
    return this.lastTriggerText;
  }

  /** 注册逻辑动作执行器（Engine 负责真正去震手机、弹提示、删建筑……） */
  setActionHandler(handler: (request: LogicActionRequest) => void): void {
    this.actionHandler = handler;
  }

  // ------------------------------------------------------------------ 组件

  /**
   * 给一个刚体加组件。
   *
   * 组件是**纯数据**（`PhysicsComponent`），不是行为对象。这么定有两个直接好处：
   * 1. 能直接序列化进存档（补充 7 要求跨平台存档一致）；
   * 2. 能在 Node 里断言「加了触发器组件之后 triggers.count 变了」，不需要浏览器。
   */
  addComponent(handle: number, component: PhysicsComponent): boolean {
    if (this.disposed) return false;
    let list = this.components.get(handle);
    if (!list) {
      list = [];
      this.components.set(handle, list);
    }
    list.push(component);
    this.applyComponent(handle, component);
    return true;
  }

  /** 批量加（组合生成时用） */
  addComponents(handle: number, components: readonly PhysicsComponent[]): number {
    let added = 0;
    for (const component of components) if (this.addComponent(handle, component)) added += 1;
    return added;
  }

  componentsOf(handle: number): readonly PhysicsComponent[] {
    return this.components.get(handle) ?? [];
  }

  /** 某个刚体有没有某类组件 */
  hasComponent(handle: number, type: ComponentType): boolean {
    return this.componentsOf(handle).some((component) => component.type === type);
  }

  get componentCount(): number {
    let total = 0;
    for (const list of this.components.values()) total += list.length;
    return total;
  }

  /**
   * 组件 → 真正生效。
   *
   * 这里**只做组件自己负责的那部分**：刚体组件改模式、触发器组件建触发区、
   * 电机组件给关节设电机。碰撞体组件不在这里建（因为碰撞体是在建刚体时一次性拼好的，
   * 事后改形状要重建刚体，代价太大），它只作为**声明**记录在这一层，
   * 面板上如实显示「声明了几个形状」。这点没做到的和做到的都要写清楚。
   */
  private applyComponent(handle: number, component: PhysicsComponent): void {
    const started = now();
    try {
      switch (component.type) {
        case 'rigidbody': {
          const params = component.params as { mode?: 'dynamic' | 'kinematic' | 'static' } | undefined;
          const mode = params?.mode;
          if (mode) {
            this.modeOverrides.set(handle, mode);
              this.physics.setMode(handle, mode);
          }
          this.componentMs.rigidbody += now() - started;
          break;
        }
        case 'collider': {
          const params = component.params as { shapes?: unknown[] } | undefined;
          const shapes = Array.isArray(params?.shapes) ? params.shapes.length : 1;
          this.lastColliderShapes += shapes;
          this.lastCompoundBodies += 1;
          this.componentMs.collider += now() - started;
          break;
        }
        case 'trigger': {
          const params = component.params as
            | { center?: { x: number; y: number; z: number }; halfExtents?: { x: number; y: number; z: number }; tag?: string; once?: boolean }
            | undefined;
          if (params?.center && params.halfExtents) {
            const id = this.triggers.add({
              center: params.center,
              halfExtents: params.halfExtents,
              tag: params.tag ?? `handle-${handle}`,
              once: params.once ?? false,
            });
            this.triggers.bindOwner(id, handle);
          }
          this.componentMs.joint += 0;
          break;
        }
        case 'motor': {
          const params = component.params as { jointId?: number; speed?: number; maxForce?: number } | undefined;
          const jointId = Number(params?.jointId);
          if (Number.isFinite(jointId)) {
            this.joints.setMotor(jointId, {
              speed: params?.speed ?? 1,
              maxForce: params?.maxForce ?? 20,
            } as MotorConfig);
          }
          break;
        }
        case 'spring': {
          // 弹簧组件本身不改什么：它的物理效果由关节层用 Rapier 的 spring 求解器实现。
          // 这里只累加耗时，避免 switch 漏分支。留下这条注释是防止有人以为它没实现。
          this.componentMs.joint += now() - started;
          break;
        }
        default:
          break;
      }
    } catch (error) {
      // 组件应用失败不能拖垮整个物理框架：记下来，继续。
      // 一条坏组件最多让一个物体行为不对，而抛出去会让整帧的物理都停。
      console.warn('[物理框架] 组件应用失败', component.type, error);
    }
  }

  // ------------------------------------------------------------------ 关节

  /** 建关节的薄封装（顺便记账） */
  addJoint(config: JointConfig): number {
    const started = now();
    const id = this.joints.add(config);
    this.componentMs.joint += now() - started;
    return id;
  }

  jointStats(): JointSystemStats {
    return this.joints.stats;
  }

  /** 六种关节各自有几个（面板的「6 种」明细） */
  jointTypeBreakdown(): { type: JointType; count: number }[] {
    const byType = this.joints.stats.byType;
    return (Object.keys(byType) as JointType[]).map((type) => ({ type, count: byType[type] }));
  }

  // ------------------------------------------------------------------ 触发与逻辑

  addTrigger(spec: Parameters<TriggerSystem['add']>[0]): number {
    return this.triggers.add(spec);
  }

  addLink(spec: LogicLinkSpec): number {
    return this.links.add(spec);
  }

  addLinks(specs: LogicLinkSpec[]): number[] {
    return this.links.addAll(specs);
  }

  /** 手动发一个事件（用于「玩家点击某个开关」这类不经过触发区的情况） */
  dispatchEvent(event: Parameters<LogicLink['fire']>[0]): LogicActionRequest[] {
    const requests = this.links.fire(event, now());
    for (const request of requests) {
      this.lastActionText = describeAction(request);
      try {
        this.actionHandler?.(request);
      } catch (error) {
        console.warn('[物理框架] 动作执行失败', request.action.type, error);
      }
    }
    return requests;
  }

  // ------------------------------------------------------------------ 每帧

  /** 每帧推进四层。`dtSeconds` 是模拟时间步长（暂停时为 0） */
  update(dtSeconds: number, nowMs: number): void {
    if (this.disposed) return;

    // 第 3 层：关节（内部会清理失效关节、处理绳索超伸）
    const jointStart = now();
    this.joints.update(dtSeconds, nowMs);
    this.componentMs.joint += now() - jointStart;

    // 第 4 层：触发器检测（内部按 100ms 节流）
    const triggerStart = now();
    this.triggers.update(nowMs);
    this.componentMs.logic += now() - triggerStart;
  }

  // ------------------------------------------------------------------ 统计

  stats(): FrameworkStats {
    const bodies = {
      total: this.physicsReady() ? this.physics.bodyCount : 0,
      dynamic: this.physicsReady() ? this.physics.dynamicCount : 0,
      awake: this.physicsReady() ? this.physics.awakeCount : 0,
    };
    const jointStats = this.joints.stats;
    const linkStats = this.links.stats();

    let occupied = 0;
    for (const record of this.triggers.list()) if (record.inside.size > 0) occupied += 1;

    const layers: LayerStats[] = [
      {
        name: LAYER_NAMES.rigidbody,
        count: bodies.total,
        summary: `${bodies.total} 个刚体（动态 ${bodies.dynamic}，唤醒中 ${bodies.awake}）`,
        ms: this.componentMs.rigidbody,
      },
      {
        name: LAYER_NAMES.collider,
        count: this.lastCompoundBodies,
        summary: `${this.lastCompoundBodies} 个复合碰撞体 / ${this.lastColliderShapes} 个形状`,
        ms: this.componentMs.collider,
      },
      {
        name: LAYER_NAMES.joint,
        count: jointStats.total,
        summary: `${jointStats.total} 个关节（失效 ${jointStats.broken}，排队 ${this.joints.pendingCount}）`,
        ms: jointStats.ms,
      },
      {
        name: LAYER_NAMES.logic,
        count: this.triggers.count + linkStats.total,
        summary: `${this.triggers.count} 个触发器 / ${linkStats.total} 条连线（已触发 ${linkStats.fired}）`,
        ms: this.triggers.updateMs + this.componentMs.logic,
      },
    ];

    return {
      ready: this.physicsReady(),
      bodies,
      colliders: { shapes: this.lastColliderShapes, compoundBodies: this.lastCompoundBodies },
      joints: jointStats,
      triggers: {
        total: this.triggers.count,
        enabled: this.triggers.enabledCount,
        occupied,
        firedTotal: this.triggers.firedTotal,
        ms: this.triggers.updateMs,
      },
      links: linkStats,
      layers,
      pendingComponents: this.componentCount,
    };
  }

  /** 打印四层诊断（控制台），供「打印物理诊断」按钮用 */
  diagnostics(): string[] {
    const stats = this.stats();
    const lines: string[] = [];
    lines.push(`物理就绪：${stats.ready ? '是' : '否'}`);
    if (!stats.ready) {
      lines.push('（Rapier 还没加载完，三层约束与逻辑的真实数据要等它就绪）');
    }
    for (const layer of stats.layers) {
      lines.push(`${layer.name}：${layer.summary}（${layer.ms.toFixed(2)} ms）`);
    }
    const breakdown = this.jointTypeBreakdown().filter((item) => item.count > 0);
    lines.push(
      breakdown.length > 0
        ? `关节明细：${breakdown.map((item) => `${item.type} ${item.count}`).join('、')}`
        : '关节明细：暂无关节',
    );
    for (const record of this.triggers.list()) {
      lines.push(
        `触发器 #${record.id}「${record.tag}」：${record.enabled ? '启用' : '停用'}，` +
          `区域内 ${record.inside.size} 个，累计触发 ${record.firedCount} 次`,
      );
    }
    for (const record of this.links.list()) {
      lines.push(
        `连线 #${record.id}「${record.label}」：监听 ${record.listen.join('/')}，` +
          `${record.actions.length} 个动作，已触发 ${record.firedCount} 次，${record.enabled ? '启用' : '停用'}`,
      );
    }
    lines.push(`组件总数：${stats.pendingComponents}（每个组件是一段数据，可进存档）`);
    return lines;
  }

  // ------------------------------------------------------------------ 清理

  /** 清空某一层 */
  clearLayer(layer: 'joint' | 'trigger' | 'link' | 'component' | 'all'): number {
    let removed = 0;
    if (layer === 'joint' || layer === 'all') {
      removed += this.joints.count;
      this.joints.clear();
    }
    if (layer === 'trigger' || layer === 'all') {
      removed += this.triggers.count;
      this.triggers.clear();
    }
    if (layer === 'link' || layer === 'all') {
      removed += this.links.count;
      this.links.clear();
    }
    if (layer === 'component' || layer === 'all') {
      removed += this.componentCount;
      this.components.clear();
      this.modeOverrides.clear();
    }
    return removed;
  }

  /**
   * 某个刚体被删掉了：把它相关的关节、触发器、组件一起收掉。
   *
   * 不做这一步的后果很具体：删掉一扇门之后，连着它的铰链关节还在，
   * Rapier 侧不会崩（JointSystem 有失效巡检），但面板上会一直挂着一个幽灵关节，
   * 玩家看到「关节 1」却找不到它连在哪。所以删除必须**主动**通知这一层。
   */
  onBodyRemoved(handle: number): { joints: number; triggers: number; components: number } {
    const joints = this.joints.removeByBody(handle);
    const triggers = this.triggers.removeByBody(handle);
    const components = this.components.get(handle)?.length ?? 0;
    this.components.delete(handle);
    this.modeOverrides.delete(handle);
    return { joints, triggers, components };
  }

  clear(): void {
    this.clearLayer('all');
    this.lastActionText = '暂无';
    this.lastTriggerText = '';
    this.lastColliderShapes = 0;
    this.lastCompoundBodies = 0;
    this.componentMs.rigidbody = 0;
    this.componentMs.collider = 0;
    this.componentMs.joint = 0;
    this.componentMs.logic = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.joints.dispose();
    this.triggers.dispose();
    this.links.clear();
    this.components.clear();
    this.actionHandler = null;
  }

  private physicsReady(): boolean {
    try {
      return this.physics.isReady;
    } catch {
      // Rapier 是动态 import 的，极端情况下 wasm 崩了会让 isReady 也抛；
      // 统计函数不该因为"想知道有多少刚体"而把面板打挂
      return false;
    }
  }
}

/** 把动作翻译成中文，给面板的「最近动作」用 */
export function describeAction(request: LogicActionRequest): string {
  const { action, linkId } = request;
  switch (action.type) {
    case 'apply-impulse':
      return `连线 ${linkId}：给 #${action.targetId ?? '?'} 加了冲量`;
    case 'set-mode':
      return `连线 ${linkId}：#${action.targetId ?? '?'} 切换为 ${action.mode ?? 'dynamic'}`;
    case 'set-motor':
      return `连线 ${linkId}：电机速度设为 ${action.motorSpeed ?? 0}`;
    case 'remove':
      return `连线 ${linkId}：移除了 #${action.targetId ?? '?'}`;
    case 'spawn':
      return `连线 ${linkId}：生成了 ${action.defId ?? '物体'}`;
    case 'toggle-trigger':
      return `连线 ${linkId}：开关了触发器 #${action.targetId ?? '?'}`;
    case 'vibrate':
      return `连线 ${linkId}：震动反馈`;
    case 'toast':
      return `连线 ${linkId}：提示「${action.text ?? ''}」`;
    case 'sound-hint':
      return `连线 ${linkId}：播放提示音`;
    default:
      return `连线 ${linkId}：${action.type}`;
  }
}

/** 只生成能用、且不会立刻穿模的初始摆放（组合生成用的兜底） */
export function componentHandleText(handle: number): string {
  // 注意：Rapier 在本项目的 wasm 构建里，u32 handle 的位模式会被当成 f64 交回 JS，
  // 于是第 2 个刚体的 handle 可能是 5e-324。所以任何「handle → 字符串」都直接用 String()，
  // 对应的「字符串 → handle」一律用 Number()，绝不用 parseInt（它会把 5e-324 读成 5）。
  return String(handle);
}

/** 给组件用的默认参数（导出便于测试与存档兼容） */
export function defaultComponentsFor(mode: 'dynamic' | 'kinematic' | 'static'): PhysicsComponent[] {
  return [
    { type: 'rigidbody', params: { mode } },
    { type: 'collider', params: {} },
  ];
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
