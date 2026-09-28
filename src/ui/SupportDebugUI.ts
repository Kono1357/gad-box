import type { AppState } from '../appState';
import type { SupportSlot } from '../building/SupportSurface';
import { stabilityCssColor } from '../building/StackingPreview';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface SupportDebugUIHandlers {
  onToggleOverlay(): void;
  onToggleStabilityColors(): void;
}

/** 选中物体的支撑面明细 */
export interface SupportDebugStats {
  /** 选中物体的描述 */
  objectLabel: string;
  layer: number;
  supportLabel: string;
  /** 支撑面总面积 / 已占用 / 剩余 */
  area: number;
  usedArea: number;
  freeArea: number;
  contactRatio: number;
  stability: 'stable' | 'critical' | 'unstable' | '';
  /** 压在同一个支撑面上的其它物体 */
  slots: SupportSlot[];
  /** 全世界的稳定性统计 */
  counts: { stable: number; critical: number; unstable: number };
  /** 支撑面索引重建耗时（性能要求：< 10 ms） */
  rebuildMs: number;
}

/**
 * 支撑调试面板（补充 1 + 问题 2.5）。
 *
 * 目的是让玩家**看懂堆叠逻辑**：为什么这个位置能放、为什么那个放不下。
 * 所以它显示的是原始数据而不是结论 ——
 * 支撑面有多大、已经被谁占了多少、还剩多少、与新物体的接触比例是多少。
 *
 * 顺带把"支撑面可视化"与"稳定性着色"两个开关放在这里，
 * 它们是理解这套逻辑最直接的手段。
 */
export class SupportDebugUI {
  private readonly cells: Record<string, HTMLElement>;
  private readonly slotList: HTMLElement;
  private readonly overlayInput: HTMLInputElement;
  private readonly stabilityInput: HTMLInputElement;
  private lastRefresh = 0;
  private disposed = false;

  constructor(
    private readonly state: AppState,
    private readonly handlers: SupportDebugUIHandlers,
  ) {
    const panel = must<HTMLElement>('#support-debug-panel');
    this.slotList = must<HTMLElement>('#sd-slot-list');
    this.overlayInput = must<HTMLInputElement>('#sd-overlay');
    this.stabilityInput = must<HTMLInputElement>('#sd-stability-colors');

    const keys = [
      'object', 'layer', 'support', 'area', 'used', 'free',
      'contact', 'stability', 'counts', 'timing',
    ];
    this.cells = {};
    for (const key of keys) this.cells[key] = must<HTMLElement>(`#sd-${key}`);

    void panel;

    this.overlayInput.addEventListener('change', () => {
      this.state.debug.supportOverlay = this.overlayInput.checked;
      this.handlers.onToggleOverlay();
    });
    this.stabilityInput.addEventListener('change', () => {
      this.state.debug.stabilityColors = this.stabilityInput.checked;
      this.handlers.onToggleStabilityColors();
    });

    this.syncControls();
  }

  private syncControls(): void {
    this.overlayInput.checked = this.state.debug.supportOverlay;
    this.stabilityInput.checked = this.state.debug.stabilityColors;
  }

  update(stats: SupportDebugStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < 200) return;
    this.lastRefresh = now;
    this.render(stats);
  }

  syncAll(stats?: SupportDebugStats): void {
    this.syncControls();
    if (stats) {
      this.lastRefresh = 0;
      this.render(stats);
    }
  }

  private render(stats: SupportDebugStats): void {
    this.cells.object!.textContent = stats.objectLabel;
    this.cells.layer!.textContent = stats.layer > 0 ? `第 ${stats.layer} 层` : '—';
    this.cells.support!.textContent = stats.supportLabel;
    this.cells.area!.textContent = `${stats.area.toFixed(2)} m²`;
    this.cells.used!.textContent = `${stats.usedArea.toFixed(2)} m²`;
    this.cells.free!.textContent = `${stats.freeArea.toFixed(2)} m²`;
    this.cells.contact!.textContent = `${Math.round(stats.contactRatio * 100)}%`;

    const stabilityText =
      stats.stability === 'stable' ? '稳固' :
      stats.stability === 'critical' ? '勉强' :
      stats.stability === 'unstable' ? '不稳' : '—';
    this.cells.stability!.textContent = stabilityText;
    this.cells.stability!.style.color = stats.stability ? stabilityCssColor(stats.stability as 'stable') : '';

    this.cells.counts!.textContent =
      `稳固 ${stats.counts.stable} / 勉强 ${stats.counts.critical} / 不稳 ${stats.counts.unstable}`;
    this.cells.timing!.textContent = `索引重建 ${stats.rebuildMs.toFixed(2)} ms`;

    // 占用明细
    if (stats.slots.length === 0) {
      this.slotList.innerHTML = '<li class="empty">这个支撑面上还没有别的东西</li>';
      return;
    }
    this.slotList.innerHTML = stats.slots
      .map(
        (slot) =>
          `<li><b>#${slot.objectId}</b><span>${slot.area.toFixed(2)} m²</span>` +
          `<small>(${slot.minX.toFixed(1)}, ${slot.minZ.toFixed(1)}) → (${slot.maxX.toFixed(1)}, ${slot.maxZ.toFixed(1)})</small></li>`,
      )
      .join('');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }
}
