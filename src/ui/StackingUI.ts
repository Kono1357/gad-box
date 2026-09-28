import type { AppState, StackAxisName } from '../appState';
import { LAYER_WARNING } from '../building/StackingSystem';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface StackingUIHandlers {
  /** 堆叠方向、网格密度、连续堆叠设置变化 */
  onSettingsChange(): void;
  /** 停止连续堆叠（等同按 Esc） */
  onStopQuickStack(): void;
}

/** 每帧给面板的堆叠数据 */
export interface StackingUIStats {
  /** 当前预览落点的层数；没有预览时为 0 */
  layer: number;
  /** 支撑物描述（"地面" / "#12 木桌"） */
  supportLabel: string;
  supportArea: number;
  usedArea: number;
  freeArea: number;
  contactRatio: number;
  /** 'stable' | 'critical' | 'unstable' | '' */
  stability: 'stable' | 'critical' | 'unstable' | '';
  /** 放上去之后的总高度（米） */
  totalHeight: number;
  /** 连续堆叠已经放了几个 */
  quickStackCount: number;
  /** 支撑面上还能放几个同样大的物体 */
  remainingPlacements: number;
}

/**
 * 堆叠面板（问题 1.4/1.5/1.7 + 补充 3）。
 *
 * 显示"第几层、踩在谁头上、接触多少、还能放几个"，并给出三个开关：
 * - **堆叠方向**：Y = 叠罗汉，X / Z = 排成一堵墙；
 * - **支撑面网格**：决定桌面上能放出多少个候选点位（越细越容易摆整齐）；
 * - **连续堆叠**：按住 Shift 放置后自动接着叠，可选手动停止。
 */
export class StackingUI {
  private readonly axisButtons: HTMLButtonElement[];
  private readonly gridSlider: HTMLInputElement;
  private readonly gridValue: HTMLElement;
  private readonly quickInput: HTMLInputElement;
  private readonly quickUndoSelect: HTMLSelectElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly cells: Record<string, HTMLElement>;
  private lastRefresh = 0;
  private disposed = false;

  constructor(
    private readonly state: AppState,
    private readonly handlers: StackingUIHandlers,
  ) {
    const panel = must<HTMLElement>('#stacking-panel');
    this.axisButtons = [...panel.querySelectorAll<HTMLButtonElement>('[data-axis]')];
    this.gridSlider = must<HTMLInputElement>('#stk-surface-grid');
    this.gridValue = must<HTMLElement>('#stk-surface-grid-value');
    this.quickInput = must<HTMLInputElement>('#stk-quick-stack');
    this.quickUndoSelect = must<HTMLSelectElement>('#stk-quick-undo');
    this.stopButton = must<HTMLButtonElement>('#stk-quick-stop');

    const keys = [
      'layer', 'support', 'support-area', 'used-area', 'free-area',
      'contact', 'stability', 'height', 'remaining', 'warning', 'quick-count',
    ];
    this.cells = {};
    for (const key of keys) this.cells[key] = must<HTMLElement>(`#stk-${key}`);

    this.gridSlider.min = '2';
    this.gridSlider.max = '8';
    this.gridSlider.step = '1';
    this.gridSlider.value = String(this.state.placement.surfaceGrid);

    this.bind();
    this.syncControls();
  }

  private bind(): void {
    for (const button of this.axisButtons) {
      button.addEventListener('click', () => {
        this.state.placement.axis = (button.dataset.axis ?? 'y') as StackAxisName;
        this.handlers.onSettingsChange();
        this.syncAll();
      });
    }

    this.gridSlider.addEventListener('input', () => {
      this.state.placement.surfaceGrid = Number(this.gridSlider.value);
      this.gridValue.textContent = `${this.state.placement.surfaceGrid} × ${this.state.placement.surfaceGrid}`;
      this.handlers.onSettingsChange();
    });

    this.quickInput.addEventListener('change', () => {
      this.state.placement.quickStack = this.quickInput.checked;
      this.handlers.onSettingsChange();
    });

    this.quickUndoSelect.addEventListener('change', () => {
      this.state.placement.quickStackUndo = this.quickUndoSelect.value === 'each' ? 'each' : 'merge';
      this.handlers.onSettingsChange();
    });

    this.stopButton.addEventListener('click', () => this.handlers.onStopQuickStack());
  }

  private syncControls(): void {
    const placement = this.state.placement;
    for (const button of this.axisButtons) {
      button.classList.toggle('active', button.dataset.axis === placement.axis);
    }
    this.gridSlider.value = String(placement.surfaceGrid);
    this.gridValue.textContent = `${placement.surfaceGrid} × ${placement.surfaceGrid}`;
    this.quickInput.checked = placement.quickStack;
    this.quickUndoSelect.value = placement.quickStackUndo;
  }

  update(stats: StackingUIStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < 150) return;
    this.lastRefresh = now;
    this.render(stats);
  }

  syncAll(nextStats?: StackingUIStats): void {
    this.syncControls();
    if (nextStats) {
      this.lastRefresh = 0;
      this.render(nextStats);
    }
  }

  private render(stats: StackingUIStats): void {
    this.cells.layer!.textContent = stats.layer > 0 ? `第 ${stats.layer} 层` : '—';
    this.cells.support!.textContent = stats.supportLabel || '—';
    this.cells['support-area']!.textContent = `${stats.supportArea.toFixed(2)} m²`;
    this.cells['used-area']!.textContent = `${stats.usedArea.toFixed(2)} m²`;
    this.cells['free-area']!.textContent = `${stats.freeArea.toFixed(2)} m²`;
    this.cells.contact!.textContent = `${Math.round(stats.contactRatio * 100)}%`;
    this.cells.height!.textContent = `${stats.totalHeight.toFixed(2)} m`;
    this.cells.remaining!.textContent = stats.remainingPlacements > 0 ? `${stats.remainingPlacements} 个` : '放不下了';

    const stabilityText =
      stats.stability === 'stable' ? '稳固' :
      stats.stability === 'critical' ? '勉强' :
      stats.stability === 'unstable' ? '不稳' : '—';
    this.cells.stability!.textContent = stabilityText;
    this.cells.stability!.className =
      stats.stability === 'stable' ? 'ok' : stats.stability === 'critical' ? 'warn' : stats.stability === 'unstable' ? 'bad' : '';

    if (stats.layer > LAYER_WARNING) {
      this.cells.warning!.textContent = `⚠ 已超过 ${LAYER_WARNING} 层，继续叠可能不稳定`;
    } else if (stats.stability === 'unstable' && stats.layer > 0) {
      this.cells.warning!.textContent = '⚠ 接触面积不足，恢复播放后会掉下来';
    } else if (stats.stability === 'critical') {
      this.cells.warning!.textContent = '接触面积 30%~60%，勉强站得住';
    } else {
      this.cells.warning!.textContent = '';
    }

    this.cells['quick-count']!.textContent = stats.quickStackCount > 0 ? `连续堆叠中：已放 ${stats.quickStackCount} 个` : '连续堆叠未启用';
    this.stopButton.disabled = stats.quickStackCount === 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }
}
