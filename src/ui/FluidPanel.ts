/**
 * 流体面板（M4 第二部分 · 第 2 批）。
 *
 * 面板上刻意**显示所有数字**（粒子数/上限/模拟耗时/密度误差/邻居数/是否慢动作），
 * 而不是只给几个滑块。理由：流体是"看起来永远在动"的东西，
 * 出了问题时玩家唯一能提供给我的线索就是这些数字 ——
 * 藏起来只会让"水有点怪"变成一句无法复现的描述。
 *
 * 结构照既有面板的约定：`container === null` 时不建 DOM 但逻辑照跑（断言里就是这么用的），
 * 所有文案中文，`dispose()` 之后任何方法都不抛异常。
 */

import type { FluidSystem } from '../fluid/FluidSystem';
import type { FluidEditor, FluidTool } from '../fluid/FluidEditor';
import type { FluidRenderStyle } from '../fluid/FluidRenderer';
import type { FluidSurface } from '../fluid/FluidSurface';
import type { FluidAudio } from '../fluid/FluidAudio';
import { FLUID_TYPES, getFluidPreset, type FluidType } from '../fluid/FluidPresets';

export interface FluidPanelHandlers {
  /** 切换流体类型（水/油/蜂蜜/岩浆/牛奶） */
  onTypeChange(type: FluidType): void;
  /** 切换工具（泼水/抽水/加水/减水/冻结/解冻） */
  onToolChange(tool: FluidTool): void;
  onRadiusChange(radius: number): void;
  onAmountChange(amount: number): void;
  onStyleChange(style: FluidRenderStyle): void;
  onClear(): void;
  onToggleAudio(enabled: boolean): void;
  onVolumeChange(volume: number): void;
}

export const FLUID_TOOL_LABELS: Record<FluidTool, string> = {
  pour: '💧 泼水',
  drain: '🚰 抽水',
  add: '🌊 加水',
  remove: '🕳 减水',
  freeze: '🧊 冻结',
  unfreeze: '🔥 解冻',
};

const STYLE_LABELS: Record<FluidRenderStyle, string> = {
  particles: '粒子',
  surface: '表面',
  mixed: '混合',
};

export class FluidPanel {
  private readonly els: {
    count: HTMLElement | null;
    capacity: HTMLElement | null;
    simMs: HTMLElement | null;
    density: HTMLElement | null;
    neighbors: HTMLElement | null;
    quality: HTMLElement | null;
    surface: HTMLElement | null;
    audio: HTMLElement | null;
    note: HTMLElement | null;
    tools: HTMLElement | null;
    types: HTMLElement | null;
    styles: HTMLElement | null;
    radius: HTMLInputElement | null;
    radiusLabel: HTMLElement | null;
    amount: HTMLInputElement | null;
    amountLabel: HTMLElement | null;
    audioToggle: HTMLInputElement | null;
    volume: HTMLInputElement | null;
    clear: HTMLElement | null;
  };
  private disposed = false;
  private lastTextMs = 0;

  constructor(
    root: HTMLElement | null,
    private readonly system: FluidSystem,
    private readonly editor: FluidEditor,
    private readonly surface: FluidSurface | null,
    private readonly audio: FluidAudio | null,
    private readonly handlers: FluidPanelHandlers,
  ) {
    const domEnabled = root !== null && typeof document !== 'undefined';
    this.els = {
      count: null, capacity: null, simMs: null, density: null, neighbors: null, quality: null,
      surface: null, audio: null, note: null, tools: null, types: null, styles: null,
      radius: null, radiusLabel: null, amount: null, amountLabel: null,
      audioToggle: null, volume: null, clear: null,
    };
    if (!domEnabled || !root) return;
    this.build(root);
    this.refresh(true);
  }

  /**
   * 建 DOM。
   *
   * `root` 只是"面板挂在哪个容器里"（用来判断 DOM 是否可用），
   * 具体节点一律按 id 找 —— 与项目里其它面板一致。
   * 这样面板的 HTML 可以放在任何位置，不需要和别的面板抢结构。
   */
  private build(root: HTMLElement): void {
    void root;
    const pick = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
    this.els.count = pick('fluid-count');
    this.els.capacity = pick('fluid-capacity');
    this.els.simMs = pick('fluid-sim-ms');
    this.els.density = pick('fluid-density');
    this.els.neighbors = pick('fluid-neighbors');
    this.els.quality = pick('fluid-quality');
    this.els.surface = pick('fluid-surface-note');
    this.els.audio = pick('fluid-audio-note');
    this.els.note = pick('fluid-note');
    this.els.tools = pick('fluid-tools');
    this.els.types = pick('fluid-types');
    this.els.styles = pick('fluid-styles');
    this.els.radius = pick('fluid-radius');
    this.els.radiusLabel = pick('fluid-radius-label');
    this.els.amount = pick('fluid-amount');
    this.els.amountLabel = pick('fluid-amount-label');
    this.els.audioToggle = pick('fluid-audio-toggle');
    this.els.volume = pick('fluid-volume');
    this.els.clear = pick('fluid-clear');

    // ---- 工具按钮
    if (this.els.tools) {
      this.els.tools.innerHTML = '';
      for (const tool of Object.keys(FLUID_TOOL_LABELS) as FluidTool[]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.fluidTool = tool;
        button.textContent = FLUID_TOOL_LABELS[tool];
        button.addEventListener('click', () => {
          this.handlers.onToolChange(tool);
          this.syncToolButtons();
        });
        this.els.tools.appendChild(button);
      }
      this.syncToolButtons();
    }

    // ---- 流体类型
    if (this.els.types) {
      this.els.types.innerHTML = '';
      for (const type of FLUID_TYPES) {
        const config = getFluidPreset(type);
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.fluidType = type;
        button.textContent = `${config.name}`;
        button.title = config.note;
        button.addEventListener('click', () => {
          this.handlers.onTypeChange(type);
          this.syncTypeButtons();
          this.refresh(true);
        });
        this.els.types.appendChild(button);
      }
      this.syncTypeButtons();
    }

    // ---- 渲染风格
    if (this.els.styles) {
      this.els.styles.innerHTML = '';
      for (const style of Object.keys(STYLE_LABELS) as FluidRenderStyle[]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.fluidStyle = style;
        button.textContent = STYLE_LABELS[style];
        button.addEventListener('click', () => {
          this.handlers.onStyleChange(style);
          this.syncStyleButtons();
        });
        this.els.styles.appendChild(button);
      }
      this.syncStyleButtons();
    }

    // ---- 笔刷半径
    if (this.els.radius) {
      this.els.radius.min = '0.5';
      this.els.radius.max = '12';
      this.els.radius.step = '0.5';
      this.els.radius.value = String(this.editor.radius);
      this.els.radius.addEventListener('input', () => {
        const value = Number(this.els.radius?.value ?? '2');
        this.handlers.onRadiusChange(value);
        this.updateSliderLabels();
      });
    }
    // ---- 单次水量
    if (this.els.amount) {
      this.els.amount.min = '20';
      this.els.amount.max = '2000';
      this.els.amount.step = '20';
      this.els.amount.value = String(this.editor.amounts.pourAmount);
      this.els.amount.addEventListener('input', () => {
        const value = Number(this.els.amount?.value ?? '120');
        this.handlers.onAmountChange(value);
        this.updateSliderLabels();
      });
    }
    // ---- 音效
    if (this.els.audioToggle) {
      this.els.audioToggle.checked = this.audio?.state !== 'muted' && (this.audio?.volume ?? 0) > 0;
      this.els.audioToggle.addEventListener('change', () => {
        this.handlers.onToggleAudio(this.els.audioToggle?.checked === true);
      });
    }
    if (this.els.volume) {
      this.els.volume.value = String(this.audio?.volume ?? 0.6);
      this.els.volume.addEventListener('input', () => {
        this.handlers.onVolumeChange(Number(this.els.volume?.value ?? '0.6'));
      });
    }
    if (this.els.clear) {
      this.els.clear.addEventListener('click', () => this.handlers.onClear());
    }
    this.updateSliderLabels();
    if (this.els.note) {
      this.els.note.textContent =
        '流体是粒子（PBF）不是格子：笔刷半径决定"倒多大一片"，一次倒多少水由下面的滑块决定。' +
        '冻结是"把这块空间冻住"，之后流进来的水也会停 —— 可以用来做闸门。';
    }
  }

  private syncToolButtons(): void {
    if (!this.els.tools) return;
    for (const button of Array.from(this.els.tools.querySelectorAll<HTMLButtonElement>('button'))) {
      const tool = button.dataset.fluidTool;
      button.classList.toggle('active', tool === this.editor.tool);
    }
  }

  private syncTypeButtons(): void {
    if (!this.els.types) return;
    for (const button of Array.from(this.els.types.querySelectorAll<HTMLButtonElement>('button'))) {
      button.classList.toggle('active', button.dataset.fluidType === this.system.type);
    }
  }

  private currentStyle: FluidRenderStyle = 'particles';

  setStyle(style: FluidRenderStyle): void {
    this.currentStyle = style;
    this.syncStyleButtons();
  }

  private syncStyleButtons(): void {
    if (!this.els.styles) return;
    for (const button of Array.from(this.els.styles.querySelectorAll<HTMLButtonElement>('button'))) {
      button.classList.toggle('active', button.dataset.fluidStyle === this.currentStyle);
    }
  }

  private updateSliderLabels(): void {
    if (this.els.radiusLabel) this.els.radiusLabel.textContent = `${this.editor.radius.toFixed(1)} 米`;
    if (this.els.amountLabel) this.els.amountLabel.textContent = `${this.editor.amounts.pourAmount} 个/次`;
  }

  /** 刷新数字（内部按 250 ms 节流，避免每帧写 DOM） */
  refresh(force = false): void {
    if (this.disposed) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && now - this.lastTextMs < 250) return;
    this.lastTextMs = now;
    const stats = this.system.stats;
    const pool = this.system.poolStats;
    if (this.els.count) this.els.count.textContent = `${pool.alive}`;
    if (this.els.capacity) this.els.capacity.textContent = `${this.system.capacity}`;
    if (this.els.simMs) {
      this.els.simMs.textContent = this.system.activeCount === 0
        ? '0 ms'
        : `${stats.totalMs.toFixed(2)} ms（${stats.substeps} 子步）`;
    }
    if (this.els.density) {
      // 密度误差与邻居数是"它到底算得对不对"的两个关键诊断量，
      // 面板上直接给数字，不用"正常/异常"这种会骗人的词
      this.els.density.textContent = this.system.activeCount === 0
        ? '—'
        : `${(stats.densityError * 100).toFixed(0)}%`;
    }
    if (this.els.neighbors) {
      this.els.neighbors.textContent = this.system.activeCount === 0 ? '—' : stats.avgNeighbors.toFixed(1);
    }
    if (this.els.quality) {
      const lod = this.system.currentLod;
      this.els.quality.textContent = stats.skippedSubsteps > 0
        ? `LOD ${lod}，这一帧跳过了 ${stats.skippedSubsteps} 个子步（在慢动作）`
        : `LOD ${lod}（正常）`;
    }
    if (this.els.surface && this.surface) {
      const surfaceStats = this.surface.surfaceStats;
      this.els.surface.textContent = surfaceStats.rebuilt
        ? `表面：${surfaceStats.triangles} 个三角形（网格 ${surfaceStats.resolution}³，${surfaceStats.ms.toFixed(1)} ms）`
        : `表面：这一帧没重建 —— ${surfaceStats.fallbackReason ?? '未知原因'}`;
    }
    if (this.els.audio && this.audio) {
      const state = this.audio.state;
      this.els.audio.textContent = state === 'running'
        ? '音效：播放中'
        : state === 'suspended'
          ? '音效：等待一次点击（浏览器要求用户手势之后才能出声）'
          : state === 'muted'
            ? '音效：已关闭'
            : '音效：这个浏览器不支持 WebAudio';
    }
  }

  syncControlsFromState(): void {
    if (this.els.radius) this.els.radius.value = String(this.editor.radius);
    if (this.els.amount) this.els.amount.value = String(this.editor.amounts.pourAmount);
    this.updateSliderLabels();
    this.syncToolButtons();
    this.syncTypeButtons();
    this.syncStyleButtons();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const key of Object.keys(this.els) as (keyof typeof this.els)[]) {
      const element = this.els[key];
      if (element) element.textContent = '';
    }
  }
}
