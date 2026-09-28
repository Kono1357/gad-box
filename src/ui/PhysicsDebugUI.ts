/**
 * 物理调试可视化面板（补充 2「物理沙盘模式」的前置件）。
 *
 * 物理是本项目最容易出玄学问题的地方 —— 关节会把东西弹到天上、触发器不响应、
 * 逻辑连线指着一个早就被删掉的刚体、支撑面索引和实际几何对不上。
 * 这类问题最难查的地方是"什么都看不见"，所以这个面板的取舍很明确：
 *
 * 1. **四层状态全部可观测**：刚体层（总数 / 动态 / 唤醒）、关节层、触发器层、
 *    逻辑层、支撑面层各占一行，每层都带自己的耗时（ms）——
 *    帧率掉了要能一眼看出是"哪套系统在吃 CPU"，而不是靠猜；
 * 2. **每一层都能单独关掉**：调试绘制是每帧开销，只想看关节时不该被一堆
 *    触发器盒子拖慢。7 个开关各自独立，`wireframeOnly` 还能一键省性能；
 * 3. **这个面板只负责「显示 + 开关」，不负责画线**：真正的线由 Engine 每帧读
 *    `drawSettings` 之后自己去画（Engine 手里才有场景与相机）。
 *    所以本文件**不 import three、不 import Engine、不 import Rapier**，
 *    可以被 Node 直接 import 做单测，也不会把渲染依赖传染出去。
 *
 * 数据从哪来（两条路，各管一件事）：
 * - `update(stats)` 喂**聚合数字**（`PhysicsDebugStats`），Engine 每帧或隔几帧调一次；
 * - `bindTriggers()` / `bindLinks()` 把系统本身挂进来，用来渲染 `#pd-trigger-list`
 *   与 `#pd-link-list` 的**逐条明细**（这两张表需要 tag / label / listen 数组这些
 *   只有记录里才有的字段，聚合数字里没有）。绑的时候传 `TriggerSystem` /
 *   `LogicLink` 实例即可 —— 它们**结构上**就满足下面那两个最小接口，不需要适配器。
 */

import { JOINT_TYPE_ICONS, JOINT_TYPE_LABELS } from '../data/jointTypes';
import { DEBUG_DISCLAIMER } from '../physics/PhysicsDebug';
import type { JointType } from '../data/jointTypes';
import { LOGIC_EVENT_LABELS } from '../data/physicsComponents';
import type { LogicEventType } from '../data/physicsComponents';
import type { LogicLinkRecord } from '../physics/LogicLink';
import type { TriggerRecord } from '../physics/TriggerSystem';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

/** 拼 innerHTML 时的转义：触发器 tag、连线 label 都可能是玩家自己起的名字 */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** 调试绘制的开关（Engine 每帧读这个） */
export interface PhysicsDebugDrawSettings {
  /** 画关节连线 */
  jointLinks: boolean;
  /** 画关节的两端锚点小球 */
  jointAnchors: boolean;
  /** 画绳索/弹簧的松弛长度参考线 */
  ropeRestLength: boolean;
  /** 画触发器盒子 */
  triggerBoxes: boolean;
  /** 画逻辑连线的「源→目标」箭头 */
  logicArrows: boolean;
  /** 只用线框（关掉实心，省性能） */
  wireframeOnly: boolean;
  /** 画刚体的碰撞盒（近似 AABB） */
  colliderBoxes: boolean;
  /** M3 第 6 批：画接触点（求解器真正在算的那些点） */
  contactPoints: boolean;
  /**
   * M3 第 6 批：画接触法线箭头。
   * ⚠ 长度是**相对量**（按穿透深度与相对速度缩放），不是牛顿数；
   * 只有方向是物理准确的。面板上要写清楚，不能让人以为这是受力大小。
   */
  forceArrows: boolean;
  /** M3 第 6 批：画速度向量 */
  velocityVectors: boolean;
  /** M3 第 6 批：按休眠状态着色（睡着的灰、唤醒的绿） */
  sleepState: boolean;
}

export interface PhysicsDebugHandlers {
  /** 任一绘制开关变化 */
  onDrawSettingsChange?(settings: PhysicsDebugDrawSettings): void;
  /** 玩家点了「清空所有关节」 */
  onClearJoints?(): void;
  /** 玩家点了「清空所有触发器」 */
  onClearTriggers?(): void;
  /** 玩家点了「清空所有逻辑连线」 */
  onClearLinks?(): void;
  /** 玩家点了「打印物理诊断」—— Engine 把四层详情打到控制台 */
  onLogDiagnostics?(): void;
}

/** 由 Engine 每帧（或节流）喂进来的统计 */
export interface PhysicsDebugStats {
  /** Rapier 是否就绪 */
  ready: boolean;
  /** 刚体层：总数 / 动态 / 唤醒中 */
  bodies: { total: number; dynamic: number; awake: number };
  /** 关节层 */
  joints: {
    total: number;
    byType: Record<JointType, number>;
    broken: number;
    pending: number;
    ms: number;
  };
  /** 触发器层 */
  triggers: {
    total: number;
    enabled: number;
    /** 当前有多少个触发器里有东西 */
    occupied: number;
    /** 累计触发次数 */
    firedTotal: number;
    ms: number;
  };
  /** 逻辑层 */
  links: { total: number; enabled: number; fired: number };
  /** 支撑面层（本项目自己的，不属于 Rapier） */
  surfaces: { count: number; usedRatio: number; ms: number };
  /** 最近一次逻辑动作的中文描述（在面板上显示最近发生了什么） */
  lastAction?: string;
  /** 玩家正在编辑的关节/触发器（没有则 null） */
  selection?: { kind: 'joint' | 'trigger' | 'link'; label: string; detail: string } | null;
}

/**
 * 触发器明细来源的最小接口 —— `TriggerSystem` 结构上直接满足，传实例即可。
 * （只用两个方法：`list()` 拿记录、`insideCount()` 问"里面现在有几个物体"。）
 */
export interface TriggerDebugSource {
  list(): TriggerRecord[];
  insideCount(id: number): number;
}

/** 逻辑连线明细来源的最小接口 —— `LogicLink` 结构上直接满足 */
export interface LogicLinkDebugSource {
  list(): LogicLinkRecord[];
  stats(): { total: number; enabled: number; fired: number };
}

/** 面板里关节分类的显示顺序（固定顺序，"旋转关节"永远在"滑动关节"上面，方便对照） */
export const JOINT_TYPE_ORDER: readonly JointType[] = [
  'fixed',
  'revolute',
  'prismatic',
  'ball',
  'rope',
  'spring',
];

/**
 * 绘制开关的键名（这个数组就是「开关契约」的唯一真源）：
 * index.html 里 `#pd-draw-switches` 下的 `data-physics-debug` 属性值必须逐字来自这里，
 * 少一个会在控制台报警告，多一个也会报 —— 免得改了接口忘了改 HTML。
 */
export const PHYSICS_DEBUG_SWITCH_KEYS: readonly (keyof PhysicsDebugDrawSettings)[] = [
  'jointLinks',
  'jointAnchors',
  'ropeRestLength',
  'triggerBoxes',
  'logicArrows',
  'wireframeOnly',
  'colliderBoxes',
  'contactPoints',
  'forceArrows',
  'velocityVectors',
  'sleepState',
];

/** 每个绘制开关的中文名（index.html 的 label 文案 + 告警信息都用它） */
export const PHYSICS_DEBUG_SWITCH_LABELS: Record<keyof PhysicsDebugDrawSettings, string> = {
  jointLinks: '关节连线',
  jointAnchors: '关节锚点',
  ropeRestLength: '绳索松弛长度',
  triggerBoxes: '触发器盒子',
  logicArrows: '逻辑连线箭头',
  wireframeOnly: '只用线框',
  colliderBoxes: '碰撞盒',
  contactPoints: '接触点',
  forceArrows: '接触法线箭头',
  velocityVectors: '速度向量',
  sleepState: '按休眠状态着色',
};

/**
 * 默认开关状态。
 * 挑选理由：进阶可视化（绳索参考线、碰撞盒）默认关 ——
 * 它们最费性能，而且是"排查特定问题时才需要"；关节/触发器/逻辑默认开，
 * 因为这三样是玩家自己摆下去的东西，看不见就等于没放。
 */
export const DEFAULT_PHYSICS_DEBUG_DRAW: PhysicsDebugDrawSettings = {
  jointLinks: true,
  jointAnchors: true,
  ropeRestLength: false,
  triggerBoxes: true,
  logicArrows: true,
  wireframeOnly: false,
  colliderBoxes: false,
  // 接触点与受力箭头默认**关**：它们信息量很大但很密，
  // 一开就是一屏的点与箭头，反而看不出结构 —— 需要诊断时再开
  contactPoints: false,
  forceArrows: false,
  velocityVectors: false,
  // 休眠着色默认关：它会盖掉稳定性着色（同一条 instanceColor 通道）
  sleepState: false,
};

/** 面板刷新节流（毫秒）。和 PlacementUI 保持一致：物理调试面板不该比被它观测的东西还贵 */
const REFRESH_INTERVAL_MS = 150;

/** 列表最多渲染多少行（触发器/连线可能有几千条，innerHTML 不能无上限地拼） */
const MAX_LIST_ROWS = 8;

/** `LogicEventType` → 中文。表就在 data/physicsComponents.ts 的 LOGIC_EVENT_LABELS。 */
function eventTypeLabel(type: LogicEventType): string {
  // 存档可能来自旧版本、带着已经不认识的类型名，所以这里兜一层底而不是直接渲染 undefined
  return LOGIC_EVENT_LABELS[type] ?? String(type);
}

function isDrawKey(value: string | undefined): value is keyof PhysicsDebugDrawSettings {
  return value !== undefined && (PHYSICS_DEBUG_SWITCH_KEYS as readonly string[]).includes(value);
}

/**
 * 物理调试面板。
 *
 * 用法（Engine 侧）：
 * ```ts
 * const ui = new PhysicsDebugUI({ onClearJoints: () => joints.clear(), ... });
 * ui.bindTriggers(triggerSystem);
 * ui.bindLinks(logicLink);
 * // 每帧：读开关去画线，隔几帧喂一次统计
 * const draw = ui.drawSettings;
 * ui.update(collectStats());
 * ```
 */
export class PhysicsDebugUI {
  private readonly panel: HTMLElement;
  private readonly statsCells: Record<string, HTMLElement>;
  private readonly jointTypeList: HTMLElement;
  private readonly triggerList: HTMLElement;
  private readonly linkList: HTMLElement;
  private readonly lastActionCell: HTMLElement;
  private readonly selectionCell: HTMLElement;
  private readonly switchContainer: HTMLElement;
  private readonly switchInputs: HTMLInputElement[];
  private readonly clearButtons: HTMLButtonElement[];
  /** 面板自己的开关真源（Engine 每帧读，见 drawSettings getter） */
  private readonly draw: PhysicsDebugDrawSettings;
  private triggerSource: TriggerDebugSource | null = null;
  private linkSource: LogicLinkDebugSource | null = null;
  private lastRefresh = 0;
  private disposed = false;

  constructor(private readonly handlers: PhysicsDebugHandlers = {}) {
    this.draw = { ...DEFAULT_PHYSICS_DEBUG_DRAW };

    this.panel = must<HTMLElement>('#physics-debug-panel');
    this.jointTypeList = must<HTMLElement>('#pd-joint-types');
    this.triggerList = must<HTMLElement>('#pd-trigger-list');
    this.linkList = must<HTMLElement>('#pd-link-list');
    this.lastActionCell = must<HTMLElement>('#pd-last-action');
    this.selectionCell = must<HTMLElement>('#pd-selection');
    // 调试可视化的"读数含义"必须跟着界面走：一个被误当成牛顿数的箭头
    // 会让人得出完全错误的结构结论，所以这句挂在 title 上，随面板一起出现
    this.selectionCell.title = DEBUG_DISCLAIMER;
    this.switchContainer = must<HTMLElement>('#pd-draw-switches');

    const keys = ['ready', 'bodies', 'joints', 'triggers', 'links', 'surfaces', 'ms'];
    this.statsCells = {};
    for (const key of keys) this.statsCells[key] = must<HTMLElement>(`#pd-${key}`);

    this.switchInputs = [
      ...this.switchContainer.querySelectorAll<HTMLInputElement>('input[data-physics-debug]'),
    ];
    this.auditSwitches();

    this.clearButtons = [
      must<HTMLButtonElement>('#pd-clear-joints'),
      must<HTMLButtonElement>('#pd-clear-triggers'),
      must<HTMLButtonElement>('#pd-clear-links'),
    ];

    this.bind();
    this.syncDrawInputs();
  }

  // ---------------------------------------------------------------- 绘制开关

  /** 当前的绘制开关（Engine 每帧读；返回副本，Engine 改不动面板的内部状态） */
  get drawSettings(): PhysicsDebugDrawSettings {
    return { ...this.draw };
  }

  /** 外部（例如「沙盘模式」打开时）强制设置某个开关 */
  setDrawSetting<K extends keyof PhysicsDebugDrawSettings>(
    key: K,
    value: PhysicsDebugDrawSettings[K],
  ): void {
    if (!isDrawKey(key)) return;
    if (this.draw[key] === value) return;
    this.draw[key] = value;
    this.syncDrawInputs();
    this.handlers.onDrawSettingsChange?.({ ...this.draw });
  }

  // ---------------------------------------------------------------- 明细来源

  /** 绑定触发器系统（`TriggerSystem` 结构上就满足 `TriggerDebugSource`）；传 null 解绑 */
  bindTriggers(source: TriggerDebugSource | null): void {
    this.triggerSource = source;
    this.lastRefresh = 0; // 下帧立刻重绘列表，不等节流
  }

  /** 绑定逻辑连线系统（`LogicLink` 结构上就满足 `LogicLinkDebugSource`）；传 null 解绑 */
  bindLinks(source: LogicLinkDebugSource | null): void {
    this.linkSource = source;
    this.lastRefresh = 0;
  }

  // ---------------------------------------------------------------- 每帧

  /** 每帧调用（内部节流 150 ms；`drawSettings` 的 getter 不受节流影响） */
  update(stats: PhysicsDebugStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_INTERVAL_MS) return;
    this.lastRefresh = now;
    this.render(stats);
  }

  private render(stats: PhysicsDebugStats): void {
    // 没就绪时统一走"加载中"分支：清空按钮置灰（此时点了也没东西可清，
    // 更糟的是可能把排队中的配置清掉），统计区明确写出"加载中"而不是显示 0 ——
    // 0 和"还没加载"是两件完全不同的事，不能混。
    this.setClearButtonsEnabled(stats.ready);
    this.panel.classList.toggle('physics-debug-loading', !stats.ready);
    if (!stats.ready) {
      this.renderLoading();
      return;
    }

    this.statsCells.ready!.textContent = '就绪';
    this.statsCells.bodies!.textContent =
      `${stats.bodies.total}（动态 ${stats.bodies.dynamic} / 唤醒 ${stats.bodies.awake}）`;

    const joints = stats.joints;
    this.statsCells.joints!.textContent =
      joints.total === 0
        ? '0'
        : `${joints.total}（失效 ${joints.broken} / 待建 ${joints.pending}）`;

    const triggers = stats.triggers;
    this.statsCells.triggers!.textContent =
      `${triggers.total}（启用 ${triggers.enabled} / 有东西 ${triggers.occupied} / 累计 ${
        triggers.firedTotal
      } 次）`;

    const links = stats.links;
    this.statsCells.links!.textContent =
      `${links.total}（启用 ${links.enabled} / 已触发 ${links.fired} 次）`;

    const surfaces = stats.surfaces;
    this.statsCells.surfaces!.textContent =
      `${surfaces.count} 个（占用 ${Math.round(surfaces.usedRatio * 100)}%）`;

    const totalMs = joints.ms + triggers.ms + surfaces.ms;
    this.statsCells.ms!.textContent =
      `关节 ${joints.ms.toFixed(2)} / 触发 ${triggers.ms.toFixed(2)} / 支撑 ${
        surfaces.ms.toFixed(2)
      } ms（合计 ${totalMs.toFixed(2)}）`;

    this.renderJointTypes(joints.byType);
    this.renderTriggers();
    this.renderLinks();

    // 文案与 index.html 里的初始占位保持一致（"最近动作：暂无"），
    // 免得第一次刷新把标签本身抹掉、只剩一个孤零零的"暂无"
    this.lastActionCell.textContent = `最近动作：${
      stats.lastAction?.trim() ? stats.lastAction : '暂无'
    }`;
    this.selectionCell.textContent = this.describeSelection(stats.selection);
  }

  /**
   * 未就绪：整个统计区只说明"在加载"，不给任何会被误读成真实状态的字。
   * （0 和"还没加载"是两件完全不同的事，显示 0 会让玩家以为世界是空的。）
   */
  private renderLoading(): void {
    const text = '物理引擎加载中…';
    for (const key of Object.keys(this.statsCells)) this.statsCells[key]!.textContent = text;
    const placeholder = `<span class="dim">${text}</span>`;
    this.jointTypeList.innerHTML = placeholder;
    this.triggerList.innerHTML = placeholder;
    this.linkList.innerHTML = placeholder;
    this.lastActionCell.textContent = `最近动作：${text}`;
    this.selectionCell.textContent = text;
  }

  /** 关节分类明细：只列数量 > 0 的类型；一行形如「🔘 旋转关节 3 个」 */
  private renderJointTypes(byType: Record<JointType, number>): void {
    const rows: string[] = [];
    for (const type of JOINT_TYPE_ORDER) {
      const count = byType[type] ?? 0;
      if (count <= 0) continue;
      // 行结构与项目其它 `.legend.rows` 面板一致：<b> 是标签、<span> 是明细
      // （style.css 里 `#physics-debug-panel .legend-row b` 给标签留了 96px 对齐）
      rows.push(
        legendRow(
          `${JOINT_TYPE_ICONS[type]} ${JOINT_TYPE_LABELS[type]}`,
          `<span>${count} 个</span>`,
        ),
      );
    }
    this.jointTypeList.innerHTML =
      rows.length > 0
        ? rows.join('')
        : '<span class="dim">还没有关节 —— 用组合模板放一个门或吊桥试试</span>';
  }

  /** 触发器明细（摘要）：tag + 触发次数 + 是否启用 + 里面几个物体 */
  private renderTriggers(): void {
    const source = this.triggerSource;
    if (!source) {
      this.triggerList.innerHTML =
        '<span class="dim">未接入触发器系统（Engine 调 bindTriggers）</span>';
      return;
    }
    const records = source.list();
    if (records.length === 0) {
      this.triggerList.innerHTML = '<span class="dim">还没有触发器</span>';
      return;
    }
    const rows = records.slice(0, MAX_LIST_ROWS).map((record) => {
      const tag = escapeHtml(record.tag || '（未命名触发器）');
      const state = record.enabled ? '已启用' : '<span class="warn">已关闭</span>';
      const inside = source.insideCount(record.id);
      return legendRow(
        tag,
        `<span>触发 ${record.firedCount} 次｜${state}｜里面 ${inside} 个物体</span>` +
          `<span class="dim">#${record.id}</span>`,
      );
    });
    this.triggerList.innerHTML = rows.join('') + moreRow(records.length);
  }

  /** 逻辑连线明细（摘要）：label + 监听事件的中文 + 动作数量 + 触发次数 */
  private renderLinks(): void {
    const source = this.linkSource;
    if (!source) {
      this.linkList.innerHTML =
        '<span class="dim">未接入逻辑连线系统（Engine 调 bindLinks）</span>';
      return;
    }
    const records = source.list();
    if (records.length === 0) {
      this.linkList.innerHTML = '<span class="dim">还没有逻辑连线</span>';
      return;
    }
    const rows = records.slice(0, MAX_LIST_ROWS).map((record) => {
      const label = escapeHtml(record.label || `连线 #${record.id}`);
      const listening =
        record.listen.length > 0 ? record.listen.map(eventTypeLabel).join('、') : '没有监听任何事件';
      const state = record.enabled ? '' : '｜<span class="warn">已停用</span>';
      return legendRow(
        label,
        `<span>监听：${escapeHtml(listening)}</span>` +
          `<span>动作 ${record.actions.length} 个｜已触发 ${record.firedCount} 次${state}</span>`,
      );
    });
    this.linkList.innerHTML = rows.join('') + moreRow(records.length);
  }

  private describeSelection(selection: PhysicsDebugStats['selection']): string {
    // 空文案与 index.html 的初始占位一致
    if (!selection) return '未选中关节 / 触发器 / 连线';
    const kind =
      selection.kind === 'joint' ? '关节' : selection.kind === 'trigger' ? '触发器' : '逻辑连线';
    const detail = selection.detail.trim();
    return detail ? `${kind}：${selection.label}｜${detail}` : `${kind}：${selection.label}`;
  }

  // ---------------------------------------------------------------- 绑定

  private bind(): void {
    // 绘制开关走事件委托：即使 index.html 以后加/减了开关，也不用改这个文件
    this.switchContainer.addEventListener('change', this.onSwitchChange);

    must<HTMLElement>('#pd-clear-joints').addEventListener('click', () => {
      this.handlers.onClearJoints?.();
      this.lastRefresh = 0;
    });
    must<HTMLElement>('#pd-clear-triggers').addEventListener('click', () => {
      this.handlers.onClearTriggers?.();
      this.lastRefresh = 0;
    });
    must<HTMLElement>('#pd-clear-links').addEventListener('click', () => {
      this.handlers.onClearLinks?.();
      this.lastRefresh = 0;
    });
    must<HTMLElement>('#pd-log-diagnostics').addEventListener('click', () => {
      this.handlers.onLogDiagnostics?.();
    });
  }

  private readonly onSwitchChange = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const key = input.dataset.physicsDebug;
    if (!isDrawKey(key)) {
      console.warn(`[物理调试] 未知的绘制开关 data-physics-debug="${key ?? ''}"，已忽略`);
      return;
    }
    if (this.draw[key] === input.checked) return;
    this.draw[key] = input.checked;
    this.handlers.onDrawSettingsChange?.({ ...this.draw });
  };

  /** 构造期体检：HTML 里的 data-physics-debug 与接口键名不一致的话，在这里喊出来 */
  private auditSwitches(): void {
    const seen = new Set<string>();
    for (const input of this.switchInputs) {
      const key = input.dataset.physicsDebug;
      if (!isDrawKey(key)) {
        console.warn(`[物理调试] #pd-draw-switches 里有未知的 data-physics-debug="${key ?? ''}"`);
        continue;
      }
      seen.add(key);
    }
    for (const key of PHYSICS_DEBUG_SWITCH_KEYS) {
      if (seen.has(key)) continue;
      console.warn(
        `[物理调试] #pd-draw-switches 缺少 data-physics-debug="${key}"（${PHYSICS_DEBUG_SWITCH_LABELS[key]}）`,
      );
    }
  }

  /** 把内部状态写回 checkbox（外部调 setDrawSetting 时也要跟上） */
  private syncDrawInputs(): void {
    for (const input of this.switchInputs) {
      const key = input.dataset.physicsDebug;
      if (isDrawKey(key)) input.checked = this.draw[key];
    }
  }

  private setClearButtonsEnabled(enabled: boolean): void {
    for (const button of this.clearButtons) button.disabled = !enabled;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.switchContainer.removeEventListener('change', this.onSwitchChange);
    this.triggerSource = null;
    this.linkSource = null;
  }
}

/** 一行 `.legend-row`（<b> 标签 + <span> 明细），与项目其它 `.legend.rows` 面板同构 */
function legendRow(label: string, detail: string): string {
  return `<div class="legend-row"><b>${label}</b>${detail}</div>`;
}

/** 「还有 N 条没显示」的尾巴行（列表有上限，不能默默截断） */
function moreRow(total: number): string {
  const hidden = total - MAX_LIST_ROWS;
  return hidden > 0 ? `<span class="dim">…还有 ${hidden} 条未显示</span>` : '';
}
