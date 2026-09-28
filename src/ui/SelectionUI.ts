import type { AppState } from '../appState';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface SelectionUIHandlers {
  onSelectAll(): void;
  onSelectClear(): void;
  onSelectSimilar(): void;
  onPickupOne(): void;
  onPickupStructure(): void;
  onDrop(): void;
  onRestore(): void;
  /** 微调位置：axis 是 'x' | 'y' | 'z'，sign 是 +1 / -1 */
  onNudge(axis: 'x' | 'y' | 'z', sign: number): void;
  /** 微调旋转：axis 是 'x' | 'y' | 'z'（当前只实现绕 Y） */
  onFineRotate(axis: 'x' | 'y' | 'z', sign: number): void;
  onMirror(axis: 'x' | 'z'): void;
  onSettingsChange(): void;
}

export interface SelectionUIStats {
  count: number;
  /** 状态：空闲 / 框选中 / 拿起中 */
  modeLabel: string;
  /** 当前分组名（没有就是 —） */
  groupLabel: string;
  /** 选中物体的描述 */
  info: string;
}

/**
 * 选择与微调面板。
 *
 * 微调用六个方向的按钮 + 两个步长下拉，而不是"拖拽手柄"：
 * 手柄在手机上太难精确操作，而**按键式微调**每次都是确定的量，
 * 配合 0.25 / 0.5 / 1 / 2 米的步长，正好解决"大件物体摆不齐"的痛点。
 */
export class SelectionUI {
  private readonly infoLabel: HTMLElement;
  private readonly nudgeStep: HTMLSelectElement;
  private readonly fineRotationStep: HTMLSelectElement;
  private readonly nudgeButtons: HTMLButtonElement[];
  private readonly fineRotationButtons: HTMLButtonElement[];
  private readonly pickupButtons: HTMLButtonElement[];
  private readonly cells: {
    count: HTMLElement;
    mode: HTMLElement;
    group: HTMLElement;
    hint: HTMLElement;
  };
  private lastRefresh = 0;
  private disposed = false;

  constructor(
    private readonly state: AppState,
    private readonly handlers: SelectionUIHandlers,
  ) {
    this.infoLabel = must<HTMLElement>('#selection-info');
    this.nudgeStep = must<HTMLSelectElement>('#nudge-step');
    this.fineRotationStep = must<HTMLSelectElement>('#fine-rotstep');
    this.nudgeButtons = [
      ...must<HTMLElement>('#selection-panel').querySelectorAll<HTMLButtonElement>('[data-nudge]'),
    ];
    this.fineRotationButtons = [
      ...must<HTMLElement>('#selection-panel').querySelectorAll<HTMLButtonElement>('[data-fine-rot]'),
    ];
    this.pickupButtons = [
      must<HTMLButtonElement>('#btn-pickup-one'),
      must<HTMLButtonElement>('#btn-pickup-structure'),
      must<HTMLButtonElement>('#btn-drop'),
      must<HTMLButtonElement>('#btn-restore'),
    ];

    this.cells = {
      count: must<HTMLElement>('#ss-count'),
      mode: must<HTMLElement>('#ss-mode'),
      group: must<HTMLElement>('#ss-group'),
      hint: must<HTMLElement>('#ss-hint'),
    };

    this.bind();
    this.syncControls();
  }

  private bind(): void {
    must<HTMLElement>('#btn-select-all').addEventListener('click', () => this.handlers.onSelectAll());
    must<HTMLElement>('#btn-select-clear').addEventListener('click', () => this.handlers.onSelectClear());
    must<HTMLElement>('#btn-select-similar').addEventListener('click', () => this.handlers.onSelectSimilar());
    must<HTMLElement>('#btn-pickup-one').addEventListener('click', () => this.handlers.onPickupOne());
    must<HTMLElement>('#btn-pickup-structure').addEventListener('click', () => this.handlers.onPickupStructure());
    must<HTMLElement>('#btn-drop').addEventListener('click', () => this.handlers.onDrop());
    must<HTMLElement>('#btn-restore').addEventListener('click', () => this.handlers.onRestore());
    must<HTMLElement>('#btn-mirror-x').addEventListener('click', () => this.handlers.onMirror('x'));
    must<HTMLElement>('#btn-mirror-z').addEventListener('click', () => this.handlers.onMirror('z'));

    for (const button of this.nudgeButtons) {
      button.addEventListener('click', () => {
        const key = button.dataset.nudge ?? '';
        const axis = (key[0] ?? 'x') as 'x' | 'y' | 'z';
        const sign = key[1] === '-' ? -1 : 1;
        this.handlers.onNudge(axis, sign);
      });
    }

    for (const button of this.fineRotationButtons) {
      button.addEventListener('click', () => {
        const key = button.dataset.fineRot ?? '';
        const axis = (key[0] ?? 'y') as 'x' | 'y' | 'z';
        const sign = key[1] === '-' ? -1 : 1;
        this.handlers.onFineRotate(axis, sign);
      });
    }

    this.nudgeStep.addEventListener('change', () => {
      this.state.selection.nudgeStep = Number(this.nudgeStep.value);
      this.handlers.onSettingsChange();
    });
    this.fineRotationStep.addEventListener('change', () => {
      this.state.selection.fineRotationStep = Number(this.fineRotationStep.value);
      this.handlers.onSettingsChange();
    });
  }

  private syncControls(): void {
    this.nudgeStep.value = String(this.state.selection.nudgeStep);
    this.fineRotationStep.value = String(this.state.selection.fineRotationStep);
  }

  update(stats: SelectionUIStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < 150) return;
    this.lastRefresh = now;
    this.render(stats);
  }

  syncAll(stats: SelectionUIStats): void {
    this.lastRefresh = 0;
    this.syncControls();
    this.render(stats);
  }

  private render(stats: SelectionUIStats): void {
    this.infoLabel.textContent = stats.info;
    this.cells.count.textContent = String(stats.count);
    this.cells.mode.textContent = stats.modeLabel;
    this.cells.group.textContent = stats.groupLabel;
    this.cells.hint.textContent =
      stats.modeLabel === '拿起中'
        ? '拖着走 · 空格放下 · Esc 还原原位'
        : '左键选物体 · Ctrl+左键加选 · 拖拽框选 · 空格拿起';

    const has = stats.count > 0;
    const holding = stats.modeLabel === '拿起中';
    for (const button of this.nudgeButtons) button.disabled = !has;
    for (const button of this.fineRotationButtons) button.disabled = !has;
    must<HTMLButtonElement>('#btn-select-similar').disabled = !has;

    this.pickupButtons[0]!.disabled = !has || holding; // 拿起单个
    this.pickupButtons[1]!.disabled = !has || holding; // 拿起整结构
    this.pickupButtons[2]!.disabled = !holding; // 放下
    this.pickupButtons[3]!.disabled = !holding; // 还原
    must<HTMLButtonElement>('#btn-mirror-x').disabled = !has || holding;
    must<HTMLButtonElement>('#btn-mirror-z').disabled = !has || holding;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }
}
