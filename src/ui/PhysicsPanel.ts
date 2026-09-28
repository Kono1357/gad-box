/**
 * 物理参数面板（重力预设 / 世界配置 / 物理材质 / 性能上限）。
 *
 * ────────────────────────────────────────────────────────────
 * 这个面板的第一原则：**如实**
 * ────────────────────────────────────────────────────────────
 * 物理参数是最容易把沙盘调崩的地方 —— 时间步调大一点东西就开始穿模，求解迭代调小一点
 * 一摞方块就会自己抖散，子步设成 100 会在切后台回来时一帧补几百步直接把页面卡死。
 * 所以这个面板有三条硬规矩：
 *
 * 1. **每一项都给出合法范围**：所有滑块的 `min/max/step` 一律从 `PHYSICS_LIMITS` 读，
 *    绝不在面板里写死。写死就会出现"滑块能给到的值，`validateWorldConfig` 却拒掉"这种
 *    自相矛盾的情况 —— 那时候玩家只会觉得"这游戏坏了"。
 * 2. **越界会被拦下**：面板只负责给出合法范围内的值，真正的校验在上层
 *    （`validateWorldConfig` / `applyConfig`），它会把不合法的项退回并给出中文原因。
 * 3. **上限口径如实显示**：桌面与移动端的刚体上限**不是同一个数**（移动端低得多）。
 *    面板永远按当前运行环境写出"现在用的是哪个口径、已用多少、超了会发生什么"，
 *    不把两套数字混在一起糊弄过去 —— 玩家看到"800"却因为跑在手机上被卡在 300，
 *    是最没必要的困惑。
 *
 * ────────────────────────────────────────────────────────────
 * 依赖说明
 * ────────────────────────────────────────────────────────────
 * 本文件**只 import 纯数据模块**（`data/gravityPresets`、`data/physicsMaterials`），
 * **不 import three / Rapier / Engine**：面板只操作 DOM、只派发玩家意图，
 * 真正的"改重力 / 改时间步 / 换材质"由上层实现。
 * 这样它也可以在 Node 里直接 import 做单测，不会把渲染依赖传染出去。
 */

import { GRAVITY_PRESETS, PHYSICS_LIMITS } from '../data/gravityPresets';
import type { GravityPreset } from '../data/gravityPresets';
import { PHYSICS_MATERIALS } from '../data/physicsMaterials';
import type { PhysicsMaterial } from '../data/physicsMaterials';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

/** 滑块的限位描述（形状与 PHYSICS_LIMITS 的每一项一致） */
interface SliderLimit {
  min: number;
  max: number;
  step: number;
}

/**
 * 取某个参数的合法范围。
 *
 * 取不到就直接抛错，而不是兜一个默认值：滑块的合法范围必须和校验逻辑同源，
 * 兜底等于悄悄造出第二套规则 —— 那正是这个面板最想避免的事。
 * 报错信息里带上现有键名，方便一行定位到底是谁改了字段名。
 *
 * （`PHYSICS_LIMITS` 的类型是字面量联合构成的 Record，这里按 string 索引，
 *  才能对"键名写错"这件事给出中文报错，而不是编译期之外的静默 undefined。）
 */
function limitOf(key: string): SliderLimit {
  const limit = (PHYSICS_LIMITS as unknown as Record<string, SliderLimit | undefined>)[key];
  if (!limit) {
    throw new Error(
      `PHYSICS_LIMITS 缺少 "${key}"（现有：${Object.keys(PHYSICS_LIMITS).join('、')}）—— ` +
        '滑块范围必须来自 PHYSICS_LIMITS，不能在面板里写死',
    );
  }
  return limit;
}

export interface PhysicsPanelHandlers {
  /** 玩家选了某个重力预设 */
  onGravityPreset(id: string): void;
  /** 玩家直接拖了重力滑块（自定义重力） */
  onGravityChange(gravityY: number): void;
  /** 玩家改了世界配置（时间步 / 子步 / 求解迭代 / 休眠阈值） */
  onConfigChange(patch: { timestep?: number; maxSubsteps?: number; solverIterations?: number; sleepThreshold?: number }): void;
  /** 玩家改了默认摩擦 / 弹性 / 线性阻尼 / 角阻尼 / 最大速度 */
  onDefaultsChange(patch: {
    friction?: number; restitution?: number; linearDamping?: number; angularDamping?: number; maxVelocity?: number;
  }): void;
  /** 玩家给某个物体换了物理材质 */
  onAssignMaterial(objectId: number, materialId: string): void;
  /** 玩家点了「恢复默认」 */
  onResetDefaults(): void;
  /** 玩家点了「清空物理世界」 */
  onClearPhysics(): void;
}

export interface PhysicsPanelStats {
  /** 当前重力 Y */
  gravityY: number;
  /** 当前选中的预设 id；玩家手动改过重力则为 null（显示「自定义」） */
  activePresetId: string | null;
  /** 世界配置当前值 */
  config: { timestep: number; maxSubsteps: number; solverIterations: number; sleepThreshold: number };
  defaults: { friction: number; restitution: number; linearDamping: number; angularDamping: number; maxVelocity: number };
  /** 物理体上限与当前用量（用于超限提示） */
  limits: { dynamicMax: number; staticMax: number; dynamicUsed: number; staticUsed: number; isMobile: boolean };
  /** 当前选中的物体（没有则 null） */
  selection: { objectId: number; defName: string; materialId: string } | null;
  /** 求解耗时与帧耗时（面板显示） */
  solverMs: number;
  stepMs: number;
  /** 休眠率 0~1 与接触对数 */
  sleepRatio: number;
  contactPairs: number;
}

/**
 * 一个数值滑块的完整绑定：DOM + 限位来源 + 取数 + 文案 + 派发。
 *
 * 之所以把 `read` / `label` / `emit` 都挂在绑定上，而不是在 render 里写 11 个 if：
 * 加一个参数只需要在这个表里加一行，不会漏改 render 或 bind 的某个分支。
 */
interface SliderBinding {
  input: HTMLInputElement;
  valueCell: HTMLElement;
  /** `PHYSICS_LIMITS` 里的键名（限位从这里读） */
  limitKey: string;
  /** 从统计快照里读该参数当前值（外部同步用） */
  read(stats: PhysicsPanelStats): number;
  /** 该滑块的显示文案。`stats` 为 null 表示"正在拖动、上层还没回执"，只按值显示 */
  label(value: number, stats: PhysicsPanelStats | null): string;
  /** 玩家动了滑块时派发给上层 */
  emit(value: number): void;
}

/** 面板刷新节流（毫秒）。和 PlacementUI / PhysicsDebugUI 一致：观测面板不该比被观测的东西还贵 */
const REFRESH_INTERVAL_MS = 150;

/** 重力显示统一两位小数（-9.81 这种值多一位少一位都读不出差别） */
function formatGravity(value: number): string {
  return `${value.toFixed(2)} m/s²`;
}

/**
 * 时间步用毫秒显示。
 * 存的是秒（Rapier 的 `world.timestep` 就是秒），但 0.016667 这个数玩家读不出含义，
 * 写成 "16.7 ms/步" 才能一眼对上"一帧 16.7ms"的直觉。
 */
function formatTimestep(value: number): string {
  return `${(value * 1000).toFixed(2)} ms/步`;
}

/**
 * 物理参数面板。
 *
 * 用法（上层侧）：
 * ```ts
 * const ui = new PhysicsPanel({ onGravityPreset: (id) => world.applyPreset(id), ... });
 * ui.update(collectPhysicsStats());      // 每帧或隔几帧
 * ui.syncFromState(collectPhysicsStats()); // 读档 / 换地图后强制同步一次
 * ```
 */
export class PhysicsPanel {
  private readonly panel: HTMLElement;
  private readonly presetContainer: HTMLElement;
  private readonly materialSelect: HTMLSelectElement;
  private readonly selectionCell: HTMLElement;
  private readonly limitNote: HTMLElement;
  private readonly applyMaterialButton: HTMLButtonElement;
  private readonly cells: Record<string, HTMLElement>;
  /** 预设列表（显式标注成 GravityPreset[]，接口一改这里就会报错） */
  private readonly presets: readonly GravityPreset[];
  /** 材质列表与索引（后者用于把 selection.materialId 翻译成中文名） */
  private readonly materials: readonly PhysicsMaterial[];
  private readonly materialById: Map<string, PhysicsMaterial>;
  private readonly bindings: SliderBinding[];
  private presetButtons: HTMLButtonElement[] = [];
  /** 正在被拖动的滑块：回写它的 value 会把玩家手里的滑块拽回去，所以要跳过 */
  private dragging: HTMLInputElement | null = null;
  /** 上一次渲染时选中的物体 id，用来判断"选择变了"从而把材质下拉同步过去 */
  private lastSelectionId: number | null = null;
  private lastRefresh = 0;
  private disposed = false;

  constructor(private readonly handlers: PhysicsPanelHandlers) {
    this.panel = must<HTMLElement>('#physics-panel');
    this.presetContainer = must<HTMLElement>('#pp-gravity-presets');
    this.materialSelect = must<HTMLSelectElement>('#pp-material-select');
    this.selectionCell = must<HTMLElement>('#pp-selection');
    this.limitNote = must<HTMLElement>('#pp-limit-note');
    this.applyMaterialButton = must<HTMLButtonElement>('#pp-apply-material');

    const keys = ['bodies', 'contacts', 'solver', 'step', 'sleep-ratio'];
    this.cells = {};
    for (const key of keys) this.cells[key] = must<HTMLElement>(`#pp-${key}`);

    this.presets = GRAVITY_PRESETS;
    this.materials = [...PHYSICS_MATERIALS];
    this.materialById = new Map(this.materials.map((material) => [material.id, material]));

    // 滑块表：每一项都写清楚"限位键 / 从哪读 / 怎么显示 / 派给谁"。
    // 注意所有数值都不带 min/max/step —— 那些在 applyLimits() 里从 PHYSICS_LIMITS 统一灌进去。
    const gravity = must<HTMLInputElement>('#pp-gravity');
    this.bindings = [
      {
        input: gravity,
        valueCell: must<HTMLElement>('#pp-gravity-value'),
        // 限位键名与 PHYSICS_LIMITS 一致（数据模块里叫 gravityY，不是 gravity）
        limitKey: 'gravityY',
        read: (stats) => stats.gravityY,
        // 重力这一项还要带上预设名 / "自定义"，所以文案不能只给数字
        label: (value, stats) => this.describeGravityLabel(value, stats),
        emit: (value) => this.handlers.onGravityChange(value),
      },
      {
        input: must<HTMLInputElement>('#pp-timestep'),
        valueCell: must<HTMLElement>('#pp-timestep-value'),
        limitKey: 'timestep',
        read: (stats) => stats.config.timestep,
        label: (value) => formatTimestep(value),
        emit: (value) => this.handlers.onConfigChange({ timestep: value }),
      },
      {
        input: must<HTMLInputElement>('#pp-substeps'),
        valueCell: must<HTMLElement>('#pp-substeps-value'),
        limitKey: 'maxSubsteps',
        read: (stats) => stats.config.maxSubsteps,
        label: (value) => `${Math.round(value)} 步`,
        emit: (value) => this.handlers.onConfigChange({ maxSubsteps: Math.round(value) }),
      },
      {
        input: must<HTMLInputElement>('#pp-iterations'),
        valueCell: must<HTMLElement>('#pp-iterations-value'),
        limitKey: 'solverIterations',
        read: (stats) => stats.config.solverIterations,
        label: (value) => `${Math.round(value)} 次`,
        emit: (value) => this.handlers.onConfigChange({ solverIterations: Math.round(value) }),
      },
      {
        input: must<HTMLInputElement>('#pp-sleep'),
        valueCell: must<HTMLElement>('#pp-sleep-value'),
        limitKey: 'sleepThreshold',
        read: (stats) => stats.config.sleepThreshold,
        label: (value) => `${value.toFixed(1)}（越小越早睡）`,
        emit: (value) => this.handlers.onConfigChange({ sleepThreshold: value }),
      },
      {
        input: must<HTMLInputElement>('#pp-friction'),
        valueCell: must<HTMLElement>('#pp-friction-value'),
        limitKey: 'friction',
        read: (stats) => stats.defaults.friction,
        label: (value) => value.toFixed(2),
        emit: (value) => this.handlers.onDefaultsChange({ friction: value }),
      },
      {
        input: must<HTMLInputElement>('#pp-restitution'),
        valueCell: must<HTMLElement>('#pp-restitution-value'),
        limitKey: 'restitution',
        read: (stats) => stats.defaults.restitution,
        label: (value) => value.toFixed(2),
        emit: (value) => this.handlers.onDefaultsChange({ restitution: value }),
      },
      {
        input: must<HTMLInputElement>('#pp-linear-damping'),
        valueCell: must<HTMLElement>('#pp-linear-damping-value'),
        limitKey: 'linearDamping',
        read: (stats) => stats.defaults.linearDamping,
        label: (value) => value.toFixed(2),
        emit: (value) => this.handlers.onDefaultsChange({ linearDamping: value }),
      },
      {
        input: must<HTMLInputElement>('#pp-angular-damping'),
        valueCell: must<HTMLElement>('#pp-angular-damping-value'),
        limitKey: 'angularDamping',
        read: (stats) => stats.defaults.angularDamping,
        label: (value) => value.toFixed(2),
        emit: (value) => this.handlers.onDefaultsChange({ angularDamping: value }),
      },
      {
        input: must<HTMLInputElement>('#pp-max-velocity'),
        valueCell: must<HTMLElement>('#pp-max-velocity-value'),
        limitKey: 'maxVelocity',
        read: (stats) => stats.defaults.maxVelocity,
        label: (value) => `${value.toFixed(1)} m/s`,
        emit: (value) => this.handlers.onDefaultsChange({ maxVelocity: value }),
      },
    ];

    this.applyLimits();

    this.renderPresets();
    this.renderMaterials();
    this.bind();
  }

  // ---------------------------------------------------------------- 初始化

  /** 限位统一灌进 DOM：min/max/step 的唯一来源就是 PHYSICS_LIMITS */
  private applyLimits(): void {
    for (const binding of this.bindings) {
      // 键名对不上就直接抛错（见 limitOf），不许兜底 —— 兜底会让"键名写错"变成"悄悄换了范围"
      const limit = limitOf(binding.limitKey);
      binding.input.min = String(limit.min);
      binding.input.max = String(limit.max);
      binding.input.step = String(limit.step);
      // HTML 里没给 value 时，range 的默认位置就是正中间 —— 读数必须跟滑块实际位置一致，
      // 所以这里也取中点，而不是显示 0（第一次 update() 之前只有这一瞬间看得到）
      const declared = binding.input.value === '' ? (limit.min + limit.max) / 2 : Number(binding.input.value);
      binding.valueCell.textContent = binding.label(Number.isFinite(declared) ? declared : limit.min, null);
    }
  }

  /** 重力预设按钮：静态渲染一次，之后只切 active（按钮数量不随状态变化） */
  private renderPresets(): void {
    this.presetContainer.innerHTML = '';
    for (const preset of this.presets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.preset = preset.id;
      button.textContent = `${preset.emoji} ${preset.name}`;
      button.title =
        `${preset.name}｜重力 ${formatGravity(preset.gravityY)}｜${preset.description}` +
        (preset.highlight ? `（${preset.highlight}）` : '');
      this.presetContainer.appendChild(button);
    }
    this.presetButtons = [...this.presetContainer.querySelectorAll<HTMLButtonElement>('[data-preset]')];
    this.auditPresets();
  }

  /** 构造期体检：HTML 里已有的 data-preset 全部来自 GRAVITY_PRESETS 吗（本方法是重建容器，主要防手改 HTML） */
  private auditPresets(): void {
    // 故意声明成 Set<string>：预设 id 是字面量联合，而 data-preset 拿到的是任意字符串，
    // 体检要能处理"HTML 里写了个不存在的地名"这件事，而不是被类型挡住。
    const known = new Set<string>(this.presets.map((preset) => String(preset.id)));
    for (const button of this.presetButtons) {
      const id = button.dataset.preset;
      if (id && !known.has(id)) console.warn(`[物理面板] 未知的重力预设 data-preset="${id}"`);
    }
  }

  /** 材质下拉：选项由 PHYSICS_MATERIALS 生成（不在 HTML 里手写，免得数据加了材质而 UI 没有） */
  private renderMaterials(): void {
    this.materialSelect.innerHTML = '';
    for (const material of this.materials) {
      const option = document.createElement('option');
      option.value = material.id;
      option.textContent = `${material.emoji} ${material.name}`;
      option.title = material.description;
      this.materialSelect.appendChild(option);
    }
    if (this.materials.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '（没有可用材质）';
      this.materialSelect.appendChild(option);
    }
  }

  // ---------------------------------------------------------------- 绑定

  private bind(): void {
    // 预设按钮走事件委托：即使以后数据里加了行星，也不用改这个文件
    this.presetContainer.addEventListener('click', this.onPresetClick);

    for (const binding of this.bindings) {
      // 滑块用 input 事件（拖动过程中连续反馈）；记下正在拖的那个，render 时跳过它的 value 回写
      binding.input.addEventListener('input', () => {
        this.dragging = binding.input;
        const value = Number(binding.input.value);
        binding.valueCell.textContent = binding.label(value, null);
        binding.emit(value);
      });
      // range 松开（或键盘改值）时派发 change：拖完了才算"不再拖动"
      binding.input.addEventListener('change', () => {
        if (this.dragging === binding.input) this.dragging = null;
      });
    }

    // 换材质要再点一次「应用材质」才生效：下拉框就贴在按钮旁边，
    // 误触一下就把选中物体的摩擦/弹性全改了，代价太大。
    this.applyMaterialButton.addEventListener('click', () => {
      const selection = this.lastSelectionId;
      if (selection === null) return; // 没选中时按钮本来就是 disabled，这里只是兜底
      const materialId = this.materialSelect.value;
      if (!materialId || !this.materialById.has(materialId)) return;
      this.handlers.onAssignMaterial(selection, materialId);
      this.lastRefresh = 0;
    });

    // 「清空物理世界」是不可撤销的破坏性操作：确认弹窗由上层弹（它才知道有没有未保存的改动）
    must<HTMLElement>('#pp-reset-defaults').addEventListener('click', () => {
      this.handlers.onResetDefaults();
      this.lastRefresh = 0;
    });
    must<HTMLElement>('#pp-clear-physics').addEventListener('click', () => {
      this.handlers.onClearPhysics();
      this.lastRefresh = 0;
    });
  }

  private readonly onPresetClick = (event: Event): void => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-preset]');
    if (!button || !this.presetContainer.contains(button)) return;
    const id = button.dataset.preset;
    if (!id || !this.presets.some((preset) => preset.id === id)) {
      console.warn(`[物理面板] 未知的重力预设 data-preset="${id ?? ''}"，已忽略`);
      return;
    }
    this.handlers.onGravityPreset(id);
    this.lastRefresh = 0; // 立刻重绘，等高亮的反馈不该等节流
  };

  // ---------------------------------------------------------------- 每帧

  /** 每帧调用（内部节流 150 ms；玩家操作后的重绘不受节流影响） */
  update(stats: PhysicsPanelStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_INTERVAL_MS) return;
    this.lastRefresh = now;
    this.render(stats);
  }

  /** 外部同步（读档 / 换地图后）：忽略节流、强制回写全部滑块 */
  syncFromState(stats: PhysicsPanelStats): void {
    if (this.disposed) return;
    this.dragging = null;
    this.lastRefresh = performance.now();
    this.render(stats);
  }

  private render(stats: PhysicsPanelStats): void {
    // ---- 重力预设高亮：没有激活预设（= 玩家拖过滑块）时全部取消，"自定义"由下面的文案说明 ----
    for (const button of this.presetButtons) {
      button.classList.toggle(
        'active',
        stats.activePresetId !== null && button.dataset.preset === stats.activePresetId,
      );
    }

    // ---- 滑块回显 ----
    for (const binding of this.bindings) {
      const value = binding.read(stats);
      const dragging = this.dragging === binding.input;
      // 拖动中不回写 value：上层回执慢一帧就会把玩家手里的滑块拽回去，手感直接坏掉
      if (!dragging) binding.input.value = String(value);
      binding.valueCell.textContent = dragging
        ? binding.label(Number(binding.input.value), null)
        : binding.label(value, stats);
    }

    // ---- 选中物体与材质 ----
    const selectionId = stats.selection ? stats.selection.objectId : null;
    if (stats.selection) {
      const materialName = this.materialById.get(stats.selection.materialId)?.name ?? stats.selection.materialId;
      this.selectionCell.textContent =
        `#${stats.selection.objectId} ${stats.selection.defName || '（未命名）'}｜材质：${materialName}`;
      // 换了选中物体才把下拉同步过去；同一个物体时保留玩家自己挑的那一项
      if (this.lastSelectionId !== selectionId) {
        this.materialSelect.value = stats.selection.materialId;
      }
    } else {
      this.selectionCell.textContent = '未选中物体';
    }
    this.lastSelectionId = selectionId;
    this.applyMaterialButton.disabled = !stats.selection || this.materials.length === 0;

    // ---- 性能读数 ----
    const limits = stats.limits;
    this.cells.bodies!.textContent =
      `${limits.dynamicUsed + limits.staticUsed}（动态 ${limits.dynamicUsed} / 静态 ${limits.staticUsed}）`;
    this.cells.contacts!.textContent = `${stats.contactPairs} 对`;
    this.cells.solver!.textContent = `${stats.solverMs.toFixed(2)} ms`;
    this.cells.step!.textContent = `${stats.stepMs.toFixed(2)} ms`;
    this.cells['sleep-ratio']!.textContent = `${Math.round(stats.sleepRatio * 100)}%`;

    this.renderLimitNote(stats);
  }

  /**
   * 上限提示：**超限必须说出来，而且要说明后果**。
   *
   * 刚体数量超限时上层会停止为新物体创建刚体（退化成静态摆放）——
   * 如果面板只是默默显示一个比上限大的数字，玩家会以为是"显示 bug"，
   * 然后继续往世界里摆东西，发现摆下去的东西再也不会掉，最后认为是物理坏了。
   * 所以这里：超限 → 红色 + 明确后果；未超限 → 正常文案 + **当前口径是桌面还是移动端**。
   */
  private renderLimitNote(stats: PhysicsPanelStats): void {
    const { dynamicMax, staticMax, dynamicUsed, staticUsed, isMobile } = stats.limits;
    const mode = isMobile ? '移动端' : '桌面';
    const problems: string[] = [];
    if (dynamicUsed > dynamicMax) {
      problems.push(
        `动态刚体 ${dynamicUsed} / 上限 ${dynamicMax}（${mode}口径）：新物体将不再创建刚体，会退化为静态摆放`,
      );
    }
    if (staticUsed > staticMax) {
      problems.push(
        `静态刚体 ${staticUsed} / 上限 ${staticMax}（${mode}口径）：新的静态碰撞体不会再创建`,
      );
    }

    const over = problems.length > 0;
    this.limitNote.classList.toggle('warn', over);
    // 面板根也挂一个状态 class：给统一改样式时留的钩子（当前样式表还没有针对它的规则，
    // 所以红色不依赖它 —— 下面那行内联颜色才是真正生效的那一处）。
    this.panel.classList.toggle('over-limit', over);
    // 超限用危险色（style.css 不给这个面板单独定义样式，所以就地写内联色，不改公共样式表）
    this.limitNote.style.color = over ? 'var(--danger)' : '';
    this.limitNote.textContent = over
      ? `⚠ ${problems.join('；')}`
      : `动态刚体 ${dynamicUsed} / ${dynamicMax}｜静态刚体 ${staticUsed} / ${staticMax}（当前口径：${mode}）`;
  }

  /** 重力文案：有激活预设就报预设名，玩家自己拖过就明确写「自定义」 */
  private describeGravityLabel(value: number, stats: PhysicsPanelStats | null): string {
    const text = formatGravity(value);
    if (!stats) return text;
    if (stats.activePresetId === null) return `${text}（自定义）`;
    const preset = this.presets.find((item) => item.id === stats.activePresetId);
    return `${text}（${preset ? `${preset.emoji} ${preset.name}` : stats.activePresetId}）`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.presetContainer.removeEventListener('click', this.onPresetClick);
    this.dragging = null;
  }
}
