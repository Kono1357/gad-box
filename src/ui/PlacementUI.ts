import type { AppState } from '../appState';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface PlacementUIHandlers {
  /** 确认放置当前候选点 */
  onConfirm(): void;
  /** 取消放置 */
  onCancel(): void;
  onPrevCandidate(): void;
  onNextCandidate(): void;
  /** 重新计算候选点 */
  onRefresh(): void;
  /** 放置设置变化 */
  onSettingsChange(): void;
}

export interface PlacementCandidateView {
  label: string;
  score: number;
  valid: boolean;
  source: string;
}

export interface PlacementUIStats {
  /** 顶部状态文字 */
  status: string;
  candidates: PlacementCandidateView[];
  /** 当前高亮的候选序号 */
  activeIndex: number;
  /** 支撑说明 */
  stackSupport: string;
  /** 稳定性：稳固 / 勉强 / 不稳 */
  stackStability: string;
  /** 堆叠层数 */
  stackLayer: number;
  /** 接触面积比（0~1） */
  stackContact: number;
}

/**
 * 智能放置面板。
 *
 * 面板只负责"显示候选点 + 触发放置动作"，候选点怎么算在 placement/SmartPlacement.ts 里。
 * 候选列表是**可点的**：既支持 `[` `]` 键循环，也支持直接点某一行——
 * 手机上按不了方括号，必须给一排可点的行。
 */
export class PlacementUI {
  private readonly candidatesContainer: HTMLElement;
  private readonly statusLabel: HTMLElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly prevButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly autoInput: HTMLInputElement;
  private readonly physicsInput: HTMLInputElement;
  private readonly anchorInput: HTMLInputElement;
  private readonly surfaceInput: HTMLInputElement;
  private readonly wallInput: HTMLInputElement;
  /** 问题 5：镜头跟随 / 边缘箭头 / 脉冲高亮 三个视觉开关 */
  private readonly trackCameraInput: HTMLInputElement;
  private readonly edgeArrowInput: HTMLInputElement;
  private readonly highlightInput: HTMLInputElement;
  private readonly cells: {
    support: HTMLElement;
    stability: HTMLElement;
    layer: HTMLElement;
    contact: HTMLElement;
  };
  private lastRefresh = 0;
  private disposed = false;
  private lastStats: PlacementUIStats | null = null;

  constructor(
    private readonly state: AppState,
    private readonly handlers: PlacementUIHandlers,
  ) {
    this.candidatesContainer = must<HTMLElement>('#placement-candidates');
    this.statusLabel = must<HTMLElement>('#placement-status');
    this.confirmButton = must<HTMLButtonElement>('#btn-placement-confirm');
    this.cancelButton = must<HTMLButtonElement>('#btn-placement-cancel');
    this.prevButton = must<HTMLButtonElement>('#btn-placement-prev');
    this.nextButton = must<HTMLButtonElement>('#btn-placement-next');
    this.autoInput = must<HTMLInputElement>('#placement-auto');
    this.physicsInput = must<HTMLInputElement>('#placement-physics');
    this.anchorInput = must<HTMLInputElement>('#snap-anchors');
    this.surfaceInput = must<HTMLInputElement>('#snap-surface');
    this.wallInput = must<HTMLInputElement>('#snap-wall');
    this.trackCameraInput = must<HTMLInputElement>('#placement-track-camera');
    this.edgeArrowInput = must<HTMLInputElement>('#placement-edge-arrow');
    this.highlightInput = must<HTMLInputElement>('#placement-highlight');

    this.cells = {
      support: must<HTMLElement>('#stack-support'),
      stability: must<HTMLElement>('#stack-stability'),
      layer: must<HTMLElement>('#stack-layer'),
      contact: must<HTMLElement>('#stack-contact'),
    };

    this.bind();
    this.syncControls();
  }

  private bind(): void {
    this.confirmButton.addEventListener('click', () => this.handlers.onConfirm());
    this.cancelButton.addEventListener('click', () => this.handlers.onCancel());
    this.prevButton.addEventListener('click', () => this.handlers.onPrevCandidate());
    this.nextButton.addEventListener('click', () => this.handlers.onNextCandidate());
    must<HTMLElement>('#btn-placement-refresh').addEventListener('click', () => this.handlers.onRefresh());

    this.autoInput.addEventListener('change', () => {
      this.state.placement.autoRecommend = this.autoInput.checked;
      this.handlers.onSettingsChange();
    });
    this.physicsInput.addEventListener('change', () => {
      this.state.placement.physicsFall = this.physicsInput.checked;
      this.handlers.onSettingsChange();
    });
    this.anchorInput.addEventListener('change', () => {
      this.state.placement.snapAnchors = this.anchorInput.checked;
      this.handlers.onSettingsChange();
    });
    this.surfaceInput.addEventListener('change', () => {
      this.state.placement.snapSurface = this.surfaceInput.checked;
      this.handlers.onSettingsChange();
    });
    this.wallInput.addEventListener('change', () => {
      this.state.placement.snapWall = this.wallInput.checked;
      this.handlers.onSettingsChange();
    });
    this.trackCameraInput.addEventListener('change', () => {
      this.state.placement.trackCamera = this.trackCameraInput.checked;
      this.handlers.onSettingsChange();
    });
    this.edgeArrowInput.addEventListener('change', () => {
      this.state.placement.showEdgeArrow = this.edgeArrowInput.checked;
      this.handlers.onSettingsChange();
    });
    this.highlightInput.addEventListener('change', () => {
      this.state.placement.highlightCandidate = this.highlightInput.checked;
      this.handlers.onSettingsChange();
    });

    // 候选行用事件委托：点哪一行就切到哪个候选
    this.candidatesContainer.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement | null)?.closest('[data-candidate]');
      if (!row) return;
      const index = Number((row as HTMLElement).dataset.candidate);
      if (!Number.isFinite(index)) return;
      this.state.placement.candidateIndex = index;
      this.handlers.onRefresh();
    });
  }

  private syncControls(): void {
    this.autoInput.checked = this.state.placement.autoRecommend;
    this.physicsInput.checked = this.state.placement.physicsFall;
    this.anchorInput.checked = this.state.placement.snapAnchors;
    this.surfaceInput.checked = this.state.placement.snapSurface;
    this.wallInput.checked = this.state.placement.snapWall;
    this.trackCameraInput.checked = this.state.placement.trackCamera;
    this.edgeArrowInput.checked = this.state.placement.showEdgeArrow;
    this.highlightInput.checked = this.state.placement.highlightCandidate;
  }

  /** 每帧调用（节流 150 ms） */
  update(stats: PlacementUIStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < 150) return;
    this.lastRefresh = now;
    this.render(stats);
  }

  /** 立即刷新 */
  syncAll(stats: PlacementUIStats): void {
    this.lastRefresh = 0;
    this.syncControls();
    this.render(stats);
  }

  private render(stats: PlacementUIStats): void {
    this.lastStats = stats;
    this.statusLabel.textContent = stats.status;
    this.cells.support.textContent = stats.stackSupport;
    this.cells.stability.textContent = stats.stackStability;
    this.cells.layer.textContent = String(stats.stackLayer);
    this.cells.contact.textContent = `${Math.round(stats.stackContact * 100)}%`;

    const hasCandidates = stats.candidates.length > 0;
    this.confirmButton.disabled = !hasCandidates;
    this.cancelButton.disabled = !hasCandidates;
    this.prevButton.disabled = stats.candidates.length < 2;
    this.nextButton.disabled = stats.candidates.length < 2;

    // 稳定性上色
    const stabilityKey = stats.stackStability.includes('稳固')
      ? 'ok'
      : stats.stackStability.includes('勉强')
        ? 'warn'
        : stats.stackStability.includes('不稳')
          ? 'bad'
          : '';
    this.cells.stability.className = stabilityKey;

    // 候选列表
    if (!hasCandidates) {
      this.candidatesContainer.innerHTML = '<p class="empty">还没有候选点：选中一个模型并把光标移到地面上</p>';
      return;
    }

    this.candidatesContainer.innerHTML = stats.candidates
      .map((candidate, index) => {
        const active = index === stats.activeIndex ? ' active' : '';
        const bad = candidate.valid ? '' : ' invalid';
        return (
          `<button type="button" class="candidate${active}${bad}" data-candidate="${index}">` +
          `<span class="score">${candidate.score}</span>` +
          `<span class="label">${candidate.label}</span>` +
          `<span class="flag">${candidate.valid ? '可放' : '不可放'}</span>` +
          `</button>`
        );
      })
      .join('');
  }

  /** 当前显示的统计（外部需要时读） */
  get stats(): PlacementUIStats | null {
    return this.lastStats;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }
}
