/**
 * 逻辑连线编辑器（M3 第 4 批的 UI 收尾）。
 *
 * ────────────────────────────────────────────────────────────
 * 拖拽连线是怎么工作的（三步，每一步都在界面上有反馈）
 * ────────────────────────────────────────────────────────────
 * 1. **按下**：在视口里按住一个物体 → Engine 拾取它，记成"源"，并通知这个面板 +
 *    `ConnectorOverlay` 开始画一条跟随光标的虚线；
 * 2. **拖动**：Engine 每帧把光标的屏幕坐标与"光标下有没有合法目标"喂进来，
 *    覆盖层的颜色随之变绿/变红，提示文案变成"松手连到「木门」"；
 * 3. **松手**：有合法目标就预填两端，玩家在面板上选**事件**与**动作**再点「建立连线」。
 *
 * **为什么松手后还要点一下而不是直接连上**：一条连线至少需要"监听什么事件"与"执行什么动作"
 * 两个信息，而这两个在拖拽动作里根本表达不了（拖拽只表达了"从谁到谁"）。
 * 硬要"拖完就自动连"就必须猜一个默认事件/动作，猜错的后果是玩家得到一个自己不想要的连线 ——
 * 那比多点一下烦人得多。所以这里明确分成"拖出两端" + "确认语义"两步。
 *
 * ────────────────────────────────────────────────────────────
 * 逻辑门与"需要第二个源"的门
 * ────────────────────────────────────────────────────────────
 * 非门需要一个**抑制源**，缓凝门需要的不是"两端"而是一个物体。这两类门的配置在拖拽里
 * 表达不了，所以本面板只在 `#le-gate-note` 里说明清楚，并给出当前可实现的门；
 * 需要抑制源时提示"用「与门」替代"或"先建两条连线"。不假装支持做不到的配置。
 */

import {
  LOGIC_GATE_LABELS,
  type LogicGateKind,
  type LogicActionType,
  type LogicLinkRecord,
} from '../physics/LogicLink';
import { LOGIC_EVENT_LABELS, type LogicEventType } from '../data/physicsComponents';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface LogicLinkEditorHandlers {
  /** 请求进入/退出拖拽连线模式 */
  onDragModeChange(enabled: boolean): void;
  /** 建立一条连线（两端由面板的预填状态给出） */
  onCreate(request: {
    sourceId: number;
    targetId: number;
    event: LogicEventType;
    action: LogicActionType;
    cooldownMs: number;
    probability: number;
    gate: LogicGateKind;
  }): void;
  /** 删除选中的连线 */
  onRemove(linkId: number): void;
  /** 开关某条连线 */
  onToggle(linkId: number, enabled: boolean): void;
  /** 选中某条连线（调试面板会跟着高亮） */
  onSelect(linkId: number): void;
  /** 把当前预填的两端清掉 */
  onClearEndpoints(): void;
}

export interface LogicLinkEditorStats {
  /** 当前预填的两端（拖拽或"用选中"填进来） */
  endpoints: { sourceId: number; sourceName: string; targetId: number; targetName: string } | null;
  /** 世界里的连线 */
  links: (Pick<LogicLinkRecord, 'id' | 'label' | 'enabled' | 'firedCount'> & {
    summary: string;
    gateLabel: string;
  })[];
  /** 选中的连线 id */
  activeLinkId: number | null;
  /** 状态/错误说明 */
  message: string;
}

/**
 * 面板上可选的连线（M3 只开放"两端"能表达的那些门）。
 *
 * **`not` 被刻意排除**：非门需要一个"抑制源"（第二个参照物），
 * 而拖拽连线只表达了"从谁到谁"这两个端点 —— 配不出抑制源。
 * 与其放一个选了也没用的选项，不如不放，并在说明里给出替代方案。
 */
export const AVAILABLE_GATES: LogicGateKind[] = ['none', 'or', 'and', 'delay', 'timer'];

/** 不出现在面板上的门，以及原因（供面板说明与断言使用） */
export const UNAVAILABLE_GATES: { kind: LogicGateKind; reason: string }[] = [
  { kind: 'not', reason: '非门需要指定抑制源，拖拽连线只能表达两个端点' },
];

export class LogicLinkEditor {
  private readonly dragMode: HTMLInputElement;
  private readonly endpointsCell: HTMLElement;
  private readonly eventSelect: HTMLSelectElement;
  private readonly actionSelect: HTMLSelectElement;
  private readonly gateSelect: HTMLSelectElement;
  private readonly gateNote: HTMLElement;
  private readonly cooldown: HTMLInputElement;
  private readonly cooldownValue: HTMLElement;
  private readonly probability: HTMLInputElement;
  private readonly probabilityValue: HTMLElement;
  private readonly statusCell: HTMLElement;
  private readonly listCell: HTMLElement;
  private readonly createButton: HTMLButtonElement;
  private readonly removeButton: HTMLButtonElement;
  private endpoints: LogicLinkEditorStats['endpoints'] = null;
  private lastStats: LogicLinkEditorStats | null = null;
  private lastRenderMs = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(private readonly handlers: LogicLinkEditorHandlers) {
    this.dragMode = must<HTMLInputElement>('#le-drag-mode');
    this.endpointsCell = must<HTMLElement>('#le-endpoints');
    this.eventSelect = must<HTMLSelectElement>('#le-event');
    this.actionSelect = must<HTMLSelectElement>('#le-action');
    this.gateSelect = must<HTMLSelectElement>('#le-gate');
    this.gateNote = must<HTMLElement>('#le-gate-note');
    this.cooldown = must<HTMLInputElement>('#le-cooldown');
    this.cooldownValue = must<HTMLElement>('#le-cooldown-value');
    this.probability = must<HTMLInputElement>('#le-probability');
    this.probabilityValue = must<HTMLElement>('#le-probability-value');
    this.statusCell = must<HTMLElement>('#le-status');
    this.listCell = must<HTMLElement>('#le-list');
    this.createButton = must<HTMLButtonElement>('#le-create');
    this.removeButton = must<HTMLButtonElement>('#le-remove');

    this.renderOptions();
    this.bind();
    this.syncGateNote();
  }

  // ------------------------------------------------------------------ 选项

  private renderOptions(): void {
    this.eventSelect.innerHTML = '';
    for (const type of Object.keys(LOGIC_EVENT_LABELS) as LogicEventType[]) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = LOGIC_EVENT_LABELS[type];
      this.eventSelect.appendChild(option);
    }
    this.eventSelect.value = 'toggle-light';

    this.actionSelect.innerHTML = '';
    // 下拉直接由**标签表**生成：这样"加了新动作但忘了加进下拉"这类漏项不可能发生
    // （反过来写——先写死列表再补标签——就会漏，我在第一版就漏了 spawn 与 sound-hint）
    for (const action of Object.keys(ACTION_LABELS)) {
      const option = document.createElement('option');
      option.value = action;
      option.textContent = ACTION_LABELS[action]!;
      this.actionSelect.appendChild(option);
    }
    this.actionSelect.value = 'set-motor';

    this.gateSelect.innerHTML = '';
    for (const gate of AVAILABLE_GATES) {
      const option = document.createElement('option');
      option.value = gate;
      option.textContent = LOGIC_GATE_LABELS[gate];
      this.gateSelect.appendChild(option);
    }
    this.gateSelect.value = 'none';
  }

  private bind(): void {
    this.dragMode.addEventListener('change', () => this.handlers.onDragModeChange(this.dragMode.checked));
    must<HTMLElement>('#le-clear-endpoints').addEventListener('click', () => {
      this.setEndpoints(null);
      this.handlers.onClearEndpoints();
    });
    this.createButton.addEventListener('click', () => {
      if (!this.endpoints) {
        this.setMessage('先把两端拖出来（或选中两个物体后点「用当前选中的两个物体」）');
        return;
      }
      this.handlers.onCreate({
        sourceId: this.endpoints.sourceId,
        targetId: this.endpoints.targetId,
        event: this.eventSelect.value as LogicEventType,
        action: this.actionSelect.value as LogicActionType,
        cooldownMs: Number(this.cooldown.value),
        probability: Number(this.probability.value),
        gate: this.gateSelect.value as LogicGateKind,
      });
    });
    this.removeButton.addEventListener('click', () => {
      const id = this.lastStats?.activeLinkId;
      if (id === null || id === undefined) {
        this.setMessage('先在下面的列表里点一条连线');
        return;
      }
      this.handlers.onRemove(id);
    });
    this.gateSelect.addEventListener('change', () => this.syncGateNote());

    for (const [input, cell, format] of [
      [this.cooldown, this.cooldownValue, () => `${Number(this.cooldown.value).toFixed(0)} ms`],
      [this.probability, this.probabilityValue, () => `${Math.round(Number(this.probability.value) * 100)}%`],
    ] as [HTMLInputElement, HTMLElement, () => string][]) {
      const update = (): void => {
        cell.textContent = format();
      };
      input.addEventListener('input', update);
      update();
    }

    // 连线列表：事件委托（列表每次刷新都重建）
    this.listCell.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const toggle = target?.closest<HTMLElement>('[data-link-toggle]');
      if (toggle) {
        const id = Number(toggle.dataset.linkToggle);
        if (Number.isFinite(id)) {
          const row = this.lastStats?.links.find((link) => link.id === id);
          this.handlers.onToggle(id, !(row?.enabled ?? true));
        }
        return;
      }
      const row = target?.closest<HTMLElement>('[data-link-id]');
      if (!row) return;
      const id = Number(row.dataset.linkId);
      if (Number.isFinite(id)) this.handlers.onSelect(id);
    });
  }

  /** 门选中后更新说明（每种门的参数在拖拽里表达不了，必须讲清楚） */
  private syncGateNote(): void {
    const gate = this.gateSelect.value as LogicGateKind;
    switch (gate) {
      case 'none':
        this.gateNote.textContent = '直接触发：事件一到就执行。门、灯、按钮这类最常用。';
        break;
      case 'or':
        this.gateNote.textContent = '或门：效果与直接触发相同；选它只是为了让面板上显示"这是或门"。';
        break;
      case 'and':
        this.gateNote.textContent = '与门：400 毫秒内收到 2 次同一事件才执行（例如"连按两下开关"）。';
        break;
      case 'delay':
        this.gateNote.textContent = '延时门：事件到达后等 500 毫秒再执行；连按两次会排队执行两次，不丢。';
        break;
      case 'timer':
        this.gateNote.textContent = '计时门：持续有事件时每 1 秒执行一次（踩住压力板 → 机关每秒转一圈）。';
        break;
      default:
        this.gateNote.textContent = '';
        break;
    }
    // 非门需要"抑制源"，这是第四方信息，拖拽与两端都表达不了 —— 如实说明，不假装支持
    if (gate === 'not') {
      this.gateNote.textContent = '非门需要指定"抑制源"，当前面板还配不了；可以先用「与门」或建两条连线达到类似效果。';
    }
  }

  // ------------------------------------------------------------------ 状态

  /** Engine 通过它把拖拽结果预填进来 */
  setEndpoints(endpoints: LogicLinkEditorStats['endpoints']): void {
    this.endpoints = endpoints;
    this.renderEndpoints();
  }

  get dragModeEnabled(): boolean {
    return this.dragMode.checked;
  }

  setDragMode(enabled: boolean): void {
    this.dragMode.checked = enabled;
  }

  private renderEndpoints(): void {
    if (!this.endpoints) {
      this.endpointsCell.textContent = '还没选中物体';
      this.createButton.disabled = true;
      return;
    }
    this.endpointsCell.textContent =
      `${this.endpoints.sourceName}（#${this.endpoints.sourceId}）⟶ ${this.endpoints.targetName}（#${this.endpoints.targetId}）`;
    this.createButton.disabled = false;
  }

  private setMessage(message: string): void {
    this.statusCell.textContent = message;
  }

  /**
   * 刷新面板。
   *
   * 内部按 150ms 节流：Engine 每帧都会调它（拖拽状态变化很频繁），
   * 而列表是重建 DOM 的 —— 60 FPS 重建一次纯属浪费。
   */
  /**
   * 刷新面板。
   *
   * 内部按 150ms 节流：Engine 每帧都会调它（拖拽状态变化很频繁），
   * 而列表是重建 DOM 的 —— 60 FPS 重建一次纯属浪费。
   */
  update(stats: LogicLinkEditorStats): void {
    if (this.disposed) return;
    this.lastStats = stats;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastRenderMs < 150) return;
    this.lastRenderMs = now;

    this.statusCell.textContent = stats.message;
    this.statusCell.classList.toggle('warn', /失败|不可|错误|先/.test(stats.message));
    this.removeButton.disabled = stats.activeLinkId === null;

    this.listCell.innerHTML = '';
    if (stats.links.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'dim';
      empty.textContent = '还没有连线。打开「拖拽连线模式」试试。';
      this.listCell.appendChild(empty);
      return;
    }
    for (const link of stats.links) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.dataset.linkId = String(link.id);
      if (link.id === stats.activeLinkId) row.classList.add('active');
      row.innerHTML =
        `<b>${link.enabled ? '✅' : '⏸'} #${link.id} ${escapeHtml(link.label)}</b>` +
        `<span>${escapeHtml(link.summary)}｜${escapeHtml(link.gateLabel)}｜已触发 ${link.firedCount} 次</span>`;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.dataset.linkToggle = String(link.id);
      toggle.textContent = link.enabled ? '停用' : '启用';
      toggle.style.marginTop = '4px';
      row.appendChild(toggle);
      this.listCell.appendChild(row);
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** 动作的中文名。**每个 LogicActionType 都必须在这里有一条** —— 漏一个，界面上就会显示英文 id */
export const ACTION_LABELS: Record<string, string> = {
  'set-motor': '驱动马达（开门/转动）',
  'set-mode': '改变刚体模式（掉落/固定）',
  'toggle-trigger': '开关另一个触发器',
  'apply-impulse': '推一把（加冲量）',
  spawn: '生成一个物体',
  remove: '删除物体',
  toast: '弹一句提示',
  vibrate: '震动手机',
  'sound-hint': '播放提示音（本项目为合成音）',
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
