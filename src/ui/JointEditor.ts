/**
 * 关节编辑器（M3 第 3 批）。
 *
 * 这是 M2.5 留下的一个明确缺口：数据层（`jointTypes.ts`）与系统层（`JointSystem`）
 * 早就就绪，20 个组合也能用现成的关节，但**玩家自己没法"点两个物体接一个铰链"**。
 * 这个面板就是补这一块。
 *
 * ────────────────────────────────────────────────────────────
 * 面板只做三件事，其余交给 Engine
 * ────────────────────────────────────────────────────────────
 * 1. **收集参数**（类型 / 轴 / 限位 / 马达），并把它们拼成一个 `JointConfig`；
 * 2. **如实显示当前状态**：选了哪些物体、关节建成了没、这个类型支不支持马达；
 * 3. **拒绝明显无效的输入**（轴为零向量、限位上下限反了、给固定关节设马达）。
 *
 * 它**不碰 Rapier**、不 import `three`、不 import `Engine` —— 真正的建/删/改由 Engine 回调执行。
 * 这样面板可以在 jsdom 里冒烟测试，而"改物理世界"这件事只有一处发生。
 *
 * ────────────────────────────────────────────────────────────
 * 两个刻意的设计
 * ────────────────────────────────────────────────────────────
 * - **轴用三个数字输入而不是"X/Y/Z 按钮"**：多数关节的轴是某个坐标轴，但吊桥的轴
 *   经常是斜的，只给三个按钮就表达不了。三个数字输入 + 一个「水平轴」快捷键能覆盖两者。
 * - **单位必须写在界面上**：旋转关节的位置是**弧度**、滑动关节是**米**。
 *   不写清楚的话，玩家输入 90 会以为门开 90 度，实际会把关节限位推到 90 弧度（≈ 14 圈）。
 */

import {
  JOINT_TYPE_LABELS,
  JOINT_TYPE_ICONS,
  JOINT_TYPE_DESCRIPTIONS,
  MOTOR_MODE_LABELS,
  DEFAULT_JOINT_AXIS,
  type JointConfig,
  type JointType,
  type MotorMode,
} from '../data/jointTypes';
import { JOINT_MOTOR_SUPPORT, JOINT_POSITION_UNIT } from '../physics/JointFactory';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface JointEditorHandlers {
  /** 用当前参数建一个关节（Engine 需要两个选中的物体） */
  onCreate(config: Omit<JointConfig, 'bodyA' | 'bodyB' | 'anchor'>): void;
  /** 给选中的关节应用修改（限位 / 马达） */
  onApply(config: Omit<JointConfig, 'bodyA' | 'bodyB' | 'anchor'>): void;
  /** 删除选中的关节 */
  onRemove(): void;
  /** 位置驱动：让选中的关节走到目标位置 */
  onMotorGo(target: number): void;
  /** 反转速度驱动马达 */
  onMotorReverse(): void;
  /** 停掉马达 */
  onMotorStop(): void;
  /** 选中列表里的某个关节 */
  onSelectJoint(jointId: number): void;
  /** 打开发射"轴预览"（调试绘制里高亮这个轴） */
  onPreviewAxis(axis: [number, number, number] | null): void;
}

export interface JointEditorJoint {
  id: number;
  type: JointType;
  label: string;
  /** 中文摘要，例如「旋转关节·轴(0,1,0)·限位 -1.57~1.57」 */
  detail: string;
  /** 马达模式（没有马达则为 null） */
  motorMode: MotorMode | null;
  motorTarget: number;
}

export interface JointEditorStats {
  /** 当前选中的物体 id（需要两个才能建关节） */
  selection: number[];
  /** 选中的物体名字 */
  selectionNames: string[];
  /** 已存在的关节 */
  joints: JointEditorJoint[];
  /** 当前选中的关节 id（编辑用） */
  activeJointId: number | null;
  /** 引擎给的一句状态/错误说明 */
  message: string;
  /** 是否有位置驱动的关节正在动（面板显示"运行中"） */
  motorRunning: boolean;
}

export class JointEditor {
  private readonly typeSelect: HTMLSelectElement;
  private readonly axisInputs: Record<'x' | 'y' | 'z', HTMLInputElement>;
  private readonly limitsEnabled: HTMLInputElement;
  private readonly limitMin: HTMLInputElement;
  private readonly limitMax: HTMLInputElement;
  private readonly limitMinValue: HTMLElement;
  private readonly limitMaxValue: HTMLElement;
  private readonly motorEnabled: HTMLInputElement;
  private readonly motorMode: HTMLSelectElement;
  private readonly motorSpeed: HTMLInputElement;
  private readonly motorSpeedValue: HTMLElement;
  private readonly motorTarget: HTMLInputElement;
  private readonly motorTargetValue: HTMLElement;
  private readonly motorForce: HTMLInputElement;
  private readonly motorForceValue: HTMLElement;
  private readonly motorStiffness: HTMLInputElement;
  private readonly motorStiffnessValue: HTMLElement;
  private readonly motorDamping: HTMLInputElement;
  private readonly motorDampingValue: HTMLElement;
  private lastRenderMs = Number.NEGATIVE_INFINITY;
  private readonly selectionCell: HTMLElement;
  private readonly statusCell: HTMLElement;
  private readonly unitNote: HTMLElement;
  private readonly listCell: HTMLElement;
  private readonly createButton: HTMLButtonElement;
  private readonly applyButton: HTMLButtonElement;
  private readonly removeButton: HTMLButtonElement;
  private readonly motorGoButton: HTMLButtonElement;
  private readonly motorReverseButton: HTMLButtonElement;
  private readonly motorStopButton: HTMLButtonElement;
  private readonly motorControls: (HTMLInputElement | HTMLSelectElement)[];
  private disposed = false;

  constructor(private readonly handlers: JointEditorHandlers) {
    this.typeSelect = must<HTMLSelectElement>('#je-type');
    this.axisInputs = {
      x: must<HTMLInputElement>('#je-axis-x'),
      y: must<HTMLInputElement>('#je-axis-y'),
      z: must<HTMLInputElement>('#je-axis-z'),
    };
    this.limitsEnabled = must<HTMLInputElement>('#je-limits-enabled');
    this.limitMin = must<HTMLInputElement>('#je-limit-min');
    this.limitMax = must<HTMLInputElement>('#je-limit-max');
    this.limitMinValue = must<HTMLElement>('#je-limit-min-value');
    this.limitMaxValue = must<HTMLElement>('#je-limit-max-value');
    this.motorEnabled = must<HTMLInputElement>('#je-motor-enabled');
    this.motorMode = must<HTMLSelectElement>('#je-motor-mode');
    this.motorSpeed = must<HTMLInputElement>('#je-motor-speed');
    this.motorSpeedValue = must<HTMLElement>('#je-motor-speed-value');
    this.motorTarget = must<HTMLInputElement>('#je-motor-target');
    this.motorTargetValue = must<HTMLElement>('#je-motor-target-value');
    this.motorForce = must<HTMLInputElement>('#je-motor-force');
    this.motorForceValue = must<HTMLElement>('#je-motor-force-value');
    this.motorStiffness = must<HTMLInputElement>('#je-motor-stiffness');
    this.motorStiffnessValue = must<HTMLElement>('#je-motor-stiffness-value');
    this.motorDamping = must<HTMLInputElement>('#je-motor-damping');
    this.motorDampingValue = must<HTMLElement>('#je-motor-damping-value');
    this.selectionCell = must<HTMLElement>('#je-selection');
    this.statusCell = must<HTMLElement>('#je-status');
    this.unitNote = must<HTMLElement>('#je-unit-note');
    this.listCell = must<HTMLElement>('#je-list');
    this.createButton = must<HTMLButtonElement>('#je-create');
    this.applyButton = must<HTMLButtonElement>('#je-apply');
    this.removeButton = must<HTMLButtonElement>('#je-remove');
    this.motorGoButton = must<HTMLButtonElement>('#je-motor-go');
    this.motorReverseButton = must<HTMLButtonElement>('#je-motor-reverse');
    this.motorStopButton = must<HTMLButtonElement>('#je-motor-stop');
    this.motorControls = [
      this.motorEnabled,
      this.motorMode,
      this.motorSpeed,
      this.motorTarget,
      this.motorForce,
      this.motorStiffness,
      this.motorDamping,
    ];

    this.renderTypeOptions();
    this.renderModeOptions();
    this.bind();
    this.syncControls();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // ------------------------------------------------------------------ 构建

  private renderTypeOptions(): void {
    this.typeSelect.innerHTML = '';
    const types = Object.keys(JOINT_TYPE_LABELS) as JointType[];
    for (const type of types) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = `${JOINT_TYPE_ICONS[type]} ${JOINT_TYPE_LABELS[type]}`;
      option.title = JOINT_TYPE_DESCRIPTIONS[type];
      this.typeSelect.appendChild(option);
    }
    this.typeSelect.value = 'revolute';
  }

  private renderModeOptions(): void {
    this.motorMode.innerHTML = '';
    for (const mode of Object.keys(MOTOR_MODE_LABELS) as MotorMode[]) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = MOTOR_MODE_LABELS[mode];
      this.motorMode.appendChild(option);
    }
    this.motorMode.value = 'velocity';
  }

  private bind(): void {
    this.createButton.addEventListener('click', () => this.handlers.onCreate(this.collectConfig()));
    this.applyButton.addEventListener('click', () => this.handlers.onApply(this.collectConfig()));
    this.removeButton.addEventListener('click', () => this.handlers.onRemove());
    this.motorGoButton.addEventListener('click', () =>
      this.handlers.onMotorGo(this.numberOf(this.motorTarget, 0)),
    );
    this.motorReverseButton.addEventListener('click', () => this.handlers.onMotorReverse());
    this.motorStopButton.addEventListener('click', () => this.handlers.onMotorStop());

    // 轴的三个输入框任一变化都重新算一遍说明
    for (const input of Object.values(this.axisInputs)) {
      input.addEventListener('input', () => this.syncControls());
    }
    this.typeSelect.addEventListener('change', () => this.syncControls());
    this.motorMode.addEventListener('change', () => this.syncControls());
    this.limitsEnabled.addEventListener('change', () => this.syncControls());
    this.motorEnabled.addEventListener('change', () => this.syncControls());

    // 滑块实时更新读数
    for (const [input, cell, digits] of [
      [this.limitMin, this.limitMinValue, 2],
      [this.limitMax, this.limitMaxValue, 2],
      [this.motorSpeed, this.motorSpeedValue, 2],
      [this.motorTarget, this.motorTargetValue, 2],
      [this.motorForce, this.motorForceValue, 0],
      [this.motorStiffness, this.motorStiffnessValue, 0],
      [this.motorDamping, this.motorDampingValue, 0],
    ] as [HTMLInputElement, HTMLElement, number][]) {
      const update = (): void => {
        cell.textContent = Number(input.value).toFixed(digits);
      };
      input.addEventListener('input', update);
      update();
    }

    // 关节列表用事件委托（列表每次刷新都会重建）
    this.listCell.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-joint-id]');
      if (!row) return;
      const id = Number(row.dataset.jointId);
      if (!Number.isFinite(id)) return;
      this.handlers.onSelectJoint(id);
    });
  }

  // ------------------------------------------------------------------ 取值

  /** 收集当前面板上的参数（不含两端：那由 Engine 从选区决定） */
  collectConfig(): Omit<JointConfig, 'bodyA' | 'bodyB' | 'anchor'> {
    const type = this.typeSelect.value as JointType;
    const axis: [number, number, number] = [
      this.numberOf(this.axisInputs.x, 0),
      this.numberOf(this.axisInputs.y, 1),
      this.numberOf(this.axisInputs.z, 0),
    ];

    const config: Omit<JointConfig, 'bodyA' | 'bodyB' | 'anchor'> = {
      type,
      label: JOINT_TYPE_LABELS[type],
    };

    // 轴只对需要方向的关节有意义；其余类型带上轴也无害，但会让人以为它有用，所以不带
    if (type === 'revolute' || type === 'prismatic') {
      config.axis = normalizeAxis(axis);
    }

    if (this.limitsEnabled.checked && (type === 'revolute' || type === 'prismatic')) {
      const a = this.numberOf(this.limitMin, 0);
      const b = this.numberOf(this.limitMax, 0);
      // 上下限反了是常态（玩家拖滑块的顺序随机），这里直接换回来而不是报错
      config.limits = { min: Math.min(a, b), max: Math.max(a, b) };
    }

    if (this.motorEnabled.checked && JOINT_MOTOR_SUPPORT[type]) {
      const mode = this.motorMode.value as MotorMode;
      config.motorMode = mode;
      config.motorSpeed = this.numberOf(this.motorSpeed, 1);
      if (mode === 'position') {
        config.motorPosition = this.numberOf(this.motorTarget, 0);
      }
      config.motorForce = this.numberOf(this.motorForce, 200);
    }

    return config;
  }

  private numberOf(input: HTMLInputElement, fallback: number): number {
    const value = Number(input.value);
    return Number.isFinite(value) ? value : fallback;
  }

  // ------------------------------------------------------------------ 渲染

  /** 根据类型/模式切换控件的可用状态与说明文字 */
  private syncControls(): void {
    const type = this.typeSelect.value as JointType;
    const supportsMotor = JOINT_MOTOR_SUPPORT[type];
    const supportsLimits = type === 'revolute' || type === 'prismatic';

    // 轴的输入只在需要方向的关节上可用：不然玩家会以为球关节也能定轴
    for (const input of Object.values(this.axisInputs)) input.disabled = !supportsLimitsAndAxis(type);

    this.limitsEnabled.disabled = !supportsLimits;
    if (!supportsLimits) this.limitsEnabled.checked = false;
    this.limitMin.disabled = !supportsLimits || !this.limitsEnabled.checked;
    this.limitMax.disabled = this.limitMin.disabled;

    this.motorEnabled.disabled = !supportsMotor;
    if (!supportsMotor) this.motorEnabled.checked = false;
    const motorOn = supportsMotor && this.motorEnabled.checked;
    for (const control of this.motorControls) {
      if (control === this.motorEnabled) continue;
      control.disabled = !motorOn;
    }
    const positionMode = this.motorMode.value === 'position';
    this.motorSpeed.disabled = !motorOn || positionMode;
    this.motorSpeed.parentElement?.classList.toggle('dim', this.motorSpeed.disabled);
    this.motorTarget.disabled = !motorOn || !positionMode;
    this.motorStiffness.disabled = this.motorTarget.disabled;
    this.motorDamping.disabled = this.motorTarget.disabled;

    if (!supportsMotor) {
      const reason =
        type === 'fixed'
          ? '固定关节两端焊死，没有可驱动的自由度'
          : type === 'ball'
            ? '球关节三个方向都自由，马达不知道该驱动哪一个'
            : '这种关节由长度约束驱动，不需要马达';
      this.unitNote.textContent = `马达不可用：${reason}`;
    } else if (positionMode) {
      const unit = JOINT_POSITION_UNIT[type];
      this.unitNote.textContent =
        `位置驱动：目标位置单位是${unit}。走到目标后它会停在那里 —— 这就是"门开到 90° 就停"的做法。`;
    } else {
      this.unitNote.textContent =
        '速度驱动：它会一直以这个速度转/推，需要配合限位才不会一直转下去。门要"开到就停"请选位置驱动。';
    }
  }

  /**
   * 刷新面板。
   *
   * **内部按 150ms 节流**：Engine 每帧都会调它（关节列表要跟着物理状态变），
   * 但列表是**重建 DOM** 的，60 FPS 重建一次纯属浪费 —— 而且关节列表通常只有几个，
   * 人眼也看不出差别。节流放在这里而不是调用方，是为了让所有调用方都不用关心这件事。
   */
  update(stats: JointEditorStats): void {
    if (this.disposed) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastRenderMs < 150) return;
    this.lastRenderMs = now;

    // ---- 选区
    if (stats.selection.length === 0) {
      this.selectionCell.textContent = '还没选中物体：先点「选择」工具，点两个物体（Ctrl+点击可加选）';
    } else if (stats.selection.length === 1) {
      this.selectionCell.textContent = `已选 1 个：${stats.selectionNames[0] ?? ''}—— 再选一个才能接关节`;
    } else if (stats.selection.length === 2) {
      this.selectionCell.textContent = `已选 2 个：${stats.selectionNames.join(' ⟷ ')}—— 可以接关节了`;
    } else {
      this.selectionCell.textContent = `已选 ${stats.selection.length} 个：只会用前两个来接关节`;
    }

    // ---- 按钮可用性
    this.createButton.disabled = stats.selection.length < 2;
    this.applyButton.disabled = stats.activeJointId === null;
    this.removeButton.disabled = stats.activeJointId === null;
    const active = stats.joints.find((joint) => joint.id === stats.activeJointId) ?? null;
    const canDrive = active !== null && JOINT_MOTOR_SUPPORT[active.type];
    this.motorGoButton.disabled = !canDrive || active?.motorMode !== 'position';
    this.motorReverseButton.disabled = !canDrive || active?.motorMode !== 'velocity';
    this.motorStopButton.disabled = !canDrive;

    // ---- 状态
    this.statusCell.textContent = stats.message;
    this.statusCell.classList.toggle('warn', /失败|不可|错误/.test(stats.message));

    // ---- 关节列表
    this.listCell.innerHTML = '';
    if (stats.joints.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'dim';
      empty.textContent = '世界里还没有关节。选中两个物体后点「接上关节」。';
      this.listCell.appendChild(empty);
    } else {
      for (const joint of stats.joints) {
        const row = document.createElement('div');
        row.className = 'legend-row';
        row.dataset.jointId = String(joint.id);
        if (joint.id === stats.activeJointId) row.classList.add('active');
        const motorNote =
          joint.motorMode === null
            ? ''
            : joint.motorMode === 'position'
              ? `｜位置驱动 → ${joint.motorTarget}`
              : '｜速度驱动';
        row.innerHTML =
          `<b>${JOINT_TYPE_ICONS[joint.type]} #${joint.id} ${escapeHtml(joint.label)}</b>` +
          `<span>${escapeHtml(joint.detail)}${motorNote}</span>`;
        this.listCell.appendChild(row);
      }
      if (stats.motorRunning) {
        const note = document.createElement('p');
        note.className = 'inline-label dim';
        note.textContent = '有位置驱动的关节正在走向目标（物理在跑的时候才会动）';
        this.listCell.appendChild(note);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** 需要方向（轴）的关节类型 */
export function supportsLimitsAndAxis(type: JointType): boolean {
  return type === 'revolute' || type === 'prismatic';
}

/**
 * 轴归一化。零向量会让 Rapier 得到一个无意义的轴（关节行为随机），
 * 所以这里退回默认轴（Y 轴）并保持长度 1。
 */
export function normalizeAxis(axis: [number, number, number]): [number, number, number] {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (!Number.isFinite(length) || length < 1e-6) return [...DEFAULT_JOINT_AXIS];
  return [axis[0] / length, axis[1] / length, axis[2] / length];
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
