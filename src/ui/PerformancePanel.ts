import { VOXEL_TYPES, colorToHexString } from '../data/voxelTypes';
import { RENDER_CONFIG, WATER_CONFIG, SAND_CONFIG, SUPPORT_CONFIG, CULLING_CONFIG } from '../config';
import type { AppState, DebugSettings, PhysicsSettings, QualityPresetName } from '../appState';
import { QUALITY_PRESETS } from '../core/QualityPreset';
import { ADAPTIVE_LABELS } from '../world/AdaptiveQuality';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface PerformancePanelHandlers {
  onDebugChange(patch: Partial<DebugSettings>): void;
  onPhysicsChange(patch: Partial<PhysicsSettings>): void;
  /** 手动跑一次支撑检查 */
  onCheckSupport(): void;
  /** 重算全部区块网格 */
  onRebuildAll(): void;
  /** 一键画质预设（补充 5） */
  onQualityPreset(preset: QualityPresetName): void;
  /** 自适应降级总开关 */
  onAdaptiveToggle(enabled: boolean): void;
}

export interface PerformanceStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  voxels: number;
  waterCells: number;
  chunkCount: number;
  visibleChunks: number;
  meshedChunks: number;
  dirtyChunks: number;
  editMs: number;
  meshMs: number;
  waterActive: number;
  sandActive: number;
  undoCount: number;
  redoCount: number;
  autoSaveMessage: string;
  storageSize: number;
  renderer: string;
  /** M2.5：物理体数量 */
  physicsBodies: number;
  /** M2.5：建筑数量 */
  buildings: number;
  /** M2.5：当前渲染距离（区块） */
  renderDistance: number;
  /** M2.5：自适应降级档位 */
  adaptiveLevel: 'full' | 'reduced' | 'minimal';
  /** M2.5：当前质量预设名 */
  qualityPreset: QualityPresetName;
  /** M2.5：支撑面索引状态描述 */
  stacking: string;
}

/**
 * 性能与调试面板。
 *
 * 玩家反馈"帧数较低"，所以这个面板是**默认打开**的：
 * 得先看得见瓶颈在哪，才谈得上优化。面板里同时给出三层信息：
 *
 * 1. **帧率层**：FPS、帧耗时、draw call、三角形 —— 判断是 CPU 还是 GPU 卡；
 * 2. **世界层**：体素、水格、区块总数 / 可见 / 已建网格 / 待重建 —— 判断剔除是否生效；
 * 3. **模拟层**：编辑耗时、网格重建耗时、水与沙的活跃格数 —— 判断是哪套模拟在吃 CPU。
 *
 * 另外把三条物理规则的开关与参数也放在这里，方便"开一个关一个"地对比性能。
 */
export class PerformancePanel {
  private readonly debugInputs: HTMLInputElement[];
  private readonly physicsInputs: HTMLInputElement[];
  private readonly waterSpeed: HTMLInputElement;
  private readonly waterSpeedValue: HTMLElement;
  private readonly waterDispersion: HTMLInputElement;
  private readonly waterDispersionValue: HTMLElement;
  private readonly sandAngle: HTMLInputElement;
  private readonly sandAngleValue: HTMLElement;
  private readonly cantilever: HTMLInputElement;
  private readonly cantileverValue: HTMLElement;
  private readonly cells: Record<string, HTMLElement>;
  private readonly legend: HTMLElement;
  private adaptiveInput!: HTMLInputElement;
  private qualityNote!: HTMLElement;
  private qualityButtons: HTMLButtonElement[] = [];
  private lastRefresh = 0;
  private disposed = false;

  constructor(
    private readonly state: AppState,
    private readonly handlers: PerformancePanelHandlers,
  ) {
    this.debugInputs = [
      ...must<HTMLElement>('#debug-switches').querySelectorAll<HTMLInputElement>('[data-debug]'),
    ];
    this.physicsInputs = [
      ...must<HTMLElement>('#physics-switches').querySelectorAll<HTMLInputElement>('[data-physics]'),
    ];

    this.waterSpeed = must<HTMLInputElement>('#water-speed');
    this.waterSpeedValue = must<HTMLElement>('#water-speed-value');
    this.waterDispersion = must<HTMLInputElement>('#water-dispersion');
    this.waterDispersionValue = must<HTMLElement>('#water-dispersion-value');
    this.sandAngle = must<HTMLInputElement>('#sand-angle');
    this.sandAngleValue = must<HTMLElement>('#sand-angle-value');
    this.cantilever = must<HTMLInputElement>('#support-cantilever');
    this.cantileverValue = must<HTMLElement>('#support-cantilever-value');
    this.legend = must<HTMLElement>('#color-legend');

    const keys = [
      'fps',
      'frame',
      'draws',
      'tris',
      'voxels',
      'water',
      'chunks',
      'visible',
      'meshed',
      'dirty',
      'edit',
      'mesh',
      'sim',
      'history',
      'save',
      'renderer',
      'physics',
      'buildings',
      'render-distance',
      'adaptive',
      'quality',
      'stacking',
    ];
    this.cells = {};
    for (const key of keys) this.cells[key] = must<HTMLElement>(`#pf-${key}`);

    this.waterSpeed.min = '0.05';
    this.waterSpeed.max = '1';
    this.waterSpeed.step = '0.05';
    this.waterSpeed.value = String(this.state.physics.waterSpeed);
    this.waterDispersion.min = '1';
    this.waterDispersion.max = '4';
    this.waterDispersion.step = '1';
    this.waterDispersion.value = String(this.state.physics.waterDispersion);
    this.sandAngle.min = '10';
    this.sandAngle.max = '60';
    this.sandAngle.step = '1';
    this.sandAngle.value = String(this.state.physics.sandAngle);
    this.cantilever.min = '1';
    this.cantilever.max = '12';
    this.cantilever.step = '0.5';
    this.cantilever.value = String(this.state.physics.supportCantilever);

    this.bind();
    this.syncControls();
    this.renderLegend();
  }

  private bind(): void {
    for (const input of this.debugInputs) {
      input.addEventListener('change', () => {
        const key = input.dataset.debug as keyof DebugSettings | undefined;
        if (!key) return;
        this.state.debug[key] = input.checked;
        this.handlers.onDebugChange({ [key]: input.checked } as Partial<DebugSettings>);
      });
    }

    for (const input of this.physicsInputs) {
      input.addEventListener('change', () => {
        const key = input.dataset.physics as keyof PhysicsSettings | undefined;
        if (!key || typeof this.state.physics[key] !== 'boolean') return;
        (this.state.physics as unknown as Record<string, boolean>)[key] = input.checked;
        this.handlers.onPhysicsChange({ [key]: input.checked } as Partial<PhysicsSettings>);
      });
    }

    this.waterSpeed.addEventListener('input', () => {
      const value = Number(this.waterSpeed.value);
      this.state.physics.waterSpeed = value;
      this.waterSpeedValue.textContent = value.toFixed(2);
      this.handlers.onPhysicsChange({ waterSpeed: value });
    });
    this.waterDispersion.addEventListener('input', () => {
      const value = Number(this.waterDispersion.value);
      this.state.physics.waterDispersion = value;
      this.waterDispersionValue.textContent = String(value);
      this.handlers.onPhysicsChange({ waterDispersion: value });
    });
    this.sandAngle.addEventListener('input', () => {
      const value = Number(this.sandAngle.value);
      this.state.physics.sandAngle = value;
      this.sandAngleValue.textContent = `${value}°`;
      this.handlers.onPhysicsChange({ sandAngle: value });
    });
    this.cantilever.addEventListener('input', () => {
      const value = Number(this.cantilever.value);
      this.state.physics.supportCantilever = value;
      this.cantileverValue.textContent = `${value} 米`;
      this.handlers.onPhysicsChange({ supportCantilever: value });
    });

    must<HTMLElement>('#btn-check-support').addEventListener('click', () => this.handlers.onCheckSupport());
    must<HTMLElement>('#btn-rebuild-all').addEventListener('click', () => this.handlers.onRebuildAll());

    // 一键画质（补充 5）
    for (const button of must<HTMLElement>('#quality-presets').querySelectorAll<HTMLButtonElement>('[data-quality]')) {
      button.addEventListener('click', () => {
        const preset = button.dataset.quality as QualityPresetName | undefined;
        if (!preset) return;
        this.handlers.onQualityPreset(preset);
        this.syncAll();
      });
    }

    this.adaptiveInput = must<HTMLInputElement>('#pf-adaptive-toggle');
    this.adaptiveInput.addEventListener('change', () => {
      this.state.quality.adaptive = this.adaptiveInput.checked;
      this.handlers.onAdaptiveToggle(this.adaptiveInput.checked);
    });
    this.qualityNote = must<HTMLElement>('#pf-quality-note');
    this.qualityButtons = [
      ...must<HTMLElement>('#quality-presets').querySelectorAll<HTMLButtonElement>('[data-quality]'),
    ];
  }

  private syncControls(): void {
    if (this.adaptiveInput) this.adaptiveInput.checked = this.state.quality.adaptive;
    for (const button of this.qualityButtons) {
      button.classList.toggle('active', button.dataset.quality === this.state.quality.preset);
    }
    for (const input of this.debugInputs) {
      const key = input.dataset.debug as keyof DebugSettings | undefined;
      if (key) input.checked = Boolean(this.state.debug[key]);
    }
    for (const input of this.physicsInputs) {
      const key = input.dataset.physics as keyof PhysicsSettings | undefined;
      if (key) input.checked = Boolean(this.state.physics[key]);
    }
    this.waterSpeedValue.textContent = this.state.physics.waterSpeed.toFixed(2);
    this.waterDispersionValue.textContent = String(this.state.physics.waterDispersion);
    this.sandAngleValue.textContent = `${this.state.physics.sandAngle}°`;
    this.cantileverValue.textContent = `${this.state.physics.supportCantilever} 米`;
  }

  /** 颜色图例：每种体素一个代表色块，用来对照场景里认材质 */
  private renderLegend(): void {
    this.legend.innerHTML = '';
    for (const def of VOXEL_TYPES) {
      if (def.id === 0) continue;
      const chip = document.createElement('span');
      chip.className = 'legend-chip';
      chip.title = `${def.name}｜${def.description}`;
      chip.innerHTML =
        `<i style="background:${colorToHexString(def.color)}"></i>${def.name}`;
      this.legend.appendChild(chip);
    }
  }

  /** 每帧调用（节流到 200ms，避免面板本身影响帧率） */
  update(stats: PerformanceStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < 200) return;
    this.lastRefresh = now;

    this.cells.fps!.textContent = stats.fps.toFixed(0);
    this.cells.frame!.textContent = `${stats.frameMs.toFixed(1)} ms`;
    this.cells.draws!.textContent = String(stats.drawCalls);
    this.cells.tris!.textContent = stats.triangles.toLocaleString('en-US');
    this.cells.voxels!.textContent = stats.voxels.toLocaleString('en-US');
    this.cells.water!.textContent = stats.waterCells.toLocaleString('en-US');
    this.cells.chunks!.textContent = String(stats.chunkCount);
    this.cells.visible!.textContent = String(stats.visibleChunks);
    this.cells.meshed!.textContent = String(stats.meshedChunks);
    this.cells.dirty!.textContent = String(stats.dirtyChunks);
    this.cells.edit!.textContent = `${stats.editMs.toFixed(1)} ms`;
    this.cells.mesh!.textContent = `${stats.meshMs.toFixed(1)} ms`;
    this.cells.sim!.textContent = `水 ${stats.waterActive} / 沙 ${stats.sandActive}`;
    this.cells.history!.textContent = `${stats.undoCount} / ${stats.redoCount}`;
    this.cells.save!.textContent = stats.autoSaveMessage || '—';
    this.cells.renderer!.textContent = stats.renderer;
    this.cells.physics!.textContent = String(stats.physicsBodies);
    this.cells.buildings!.textContent = String(stats.buildings);
    this.cells['render-distance']!.textContent = `${stats.renderDistance} 区块`;
    this.cells.adaptive!.textContent = ADAPTIVE_LABELS[stats.adaptiveLevel];
    this.cells.quality!.textContent = QUALITY_PRESETS[stats.qualityPreset]?.label ?? stats.qualityPreset;
    this.cells.stacking!.textContent = stats.stacking;

    if (this.qualityNote) {
      const preset = QUALITY_PRESETS[stats.qualityPreset];
      const base = preset?.description ?? '';
      this.qualityNote.textContent = this.state.quality.manualOverride
        ? `${base}（手动调整过，自适应降级不再干预）`
        : base;
    }
  }

  /** 状态变化后强制刷新 */
  syncAll(): void {
    this.syncControls();
    this.lastRefresh = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }
}

/** 面板里显示的渲染配置摘要（便于截图反馈问题时带上环境信息） */
export const RENDER_SUMMARY = `像素比≤${RENDER_CONFIG.maxPixelRatio}｜水速默认${WATER_CONFIG.speed}｜安息角默认${SAND_CONFIG.angleOfRepose}°｜悬挑默认${SUPPORT_CONFIG.maxCantilever}m｜渲染距离${CULLING_CONFIG.renderDistance}区块`;
