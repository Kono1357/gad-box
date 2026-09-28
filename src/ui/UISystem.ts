import type { Time } from '../core/Time';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

/** 底部状态栏 + 时间控制按钮（M0 就有，M1.5 只换了字段） */
export interface StatusStats {
  fps: number;
  simTime: number;
  stepCount: number;
  voxels: number;
  buildings: number;
  drawCalls: number;
  triangles: number;
}

/**
 * 引擎状态栏与时间控制。
 *
 * 只管两件事：底部的数字、右上的播放控制。
 * 编辑相关的信息（笔刷坐标、影响格数）在 BrushUI 里，两者刻意分开 ——
 * 底部状态栏始终可见，而编辑信息只在编辑时才有意义。
 */
export class UISystem {
  private readonly controlRoot: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly scaleButtons: HTMLButtonElement[];
  private readonly cells: {
    fps: HTMLElement;
    simTime: HTMLElement;
    steps: HTMLElement;
    voxels: HTMLElement;
    buildings: HTMLElement;
    draws: HTMLElement;
    tris: HTMLElement;
  };
  private lastRefresh = 0;
  private disposed = false;

  constructor(private readonly time: Time) {
    this.controlRoot = must<HTMLElement>('#time-controls');
    this.pauseButton = must<HTMLButtonElement>('#btn-pause');
    this.scaleButtons = [...this.controlRoot.querySelectorAll<HTMLButtonElement>('[data-scale]')];

    this.cells = {
      fps: must<HTMLElement>('#stat-fps'),
      simTime: must<HTMLElement>('#stat-simtime'),
      steps: must<HTMLElement>('#stat-steps'),
      voxels: must<HTMLElement>('#stat-voxels'),
      buildings: must<HTMLElement>('#stat-buildings'),
      draws: must<HTMLElement>('#stat-draws'),
      tris: must<HTMLElement>('#stat-tris'),
    };

    this.controlRoot.addEventListener('click', this.handleClick);
    this.syncButtons();
  }

  private handleClick = (ev: MouseEvent): void => {
    const button = (ev.target as HTMLElement | null)?.closest('button');
    if (!button) return;

    const action = button.dataset.action;
    const scale = button.dataset.scale;

    if (action === 'pause') {
      this.time.togglePause();
    } else if (action === 'step') {
      if (!this.time.paused) this.time.setPaused(true);
      this.time.requestStep(1);
    } else if (scale !== undefined) {
      this.time.setScale(Number(scale));
      this.time.setPaused(false);
    }

    this.syncButtons();
    this.lastRefresh = 0;
  };

  private syncButtons(): void {
    const paused = this.time.paused;
    this.pauseButton.textContent = paused ? '▶' : '⏸';
    this.pauseButton.classList.toggle('active', paused);
    this.pauseButton.title = paused ? '播放' : '暂停';

    const scale = this.time.scale;
    for (const button of this.scaleButtons) {
      button.classList.toggle('active', !paused && Number(button.dataset.scale) === scale);
    }
  }

  update(stats: StatusStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < 150) return;
    this.lastRefresh = now;
    this.syncButtons();

    this.cells.fps.textContent = stats.fps.toFixed(0);
    this.cells.simTime.textContent = stats.simTime.toFixed(2);
    this.cells.steps.textContent = String(stats.stepCount);
    this.cells.voxels.textContent = stats.voxels.toLocaleString('en-US');
    this.cells.buildings.textContent = String(stats.buildings);
    this.cells.draws.textContent = String(stats.drawCalls);
    this.cells.tris.textContent = stats.triangles.toLocaleString('en-US');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controlRoot.removeEventListener('click', this.handleClick);
  }
}
