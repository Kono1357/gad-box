import { BRUSH_CONFIG } from '../config';
import { AIR, VOXEL_TYPES, colorToHexString, getVoxelDef } from '../data/voxelTypes';
import type { BrushDirection, BrushMode, BrushShape, FalloffType } from '../voxel/BrushSystem';
import {
  BRUSH_DIRECTIONS,
  BRUSH_FALLOFFS,
  BRUSH_MODES,
  BRUSH_SHAPES,
  BRUSH_MODE_LABELS,
  BRUSH_SHAPE_LABELS,
  DIRECTION_LABELS,
  FALLOFF_LABELS,
} from '../voxel/BrushSystem';
import type { AppState } from '../appState';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface BrushUIHandlers {
  onBrushChange(): void;
}

/** BrushUI 每帧收到的信息（内部节流刷新） */
export interface BrushUIStats {
  /** 笔刷落点体素坐标 */
  pointer: { x: number; y: number; z: number } | null;
  /** 上一次笔刷影响的体素数 */
  affected: number;
  /** 上一次编辑耗时（毫秒） */
  editMs: number;
  /** 预计影响的体素数 */
  estimated: number;
}

/**
 * 笔刷面板。
 *
 * M1.5 的笔刷参数比 M1 多了形状、密度、方向三组，
 * 全部用「点一下切换」的按钮组表达，手机上也能单手操作。
 * 数值型参数（半径 / 强度 / 密度）用滑块，并且支持 **Alt/Ctrl + 滚轮** 微调 ——
 * 这是"精细编辑"的关键：滑块拖不准的时候可以直接滚。
 */
export class BrushUI {
  private readonly modeButtons: HTMLButtonElement[] = [];
  private readonly shapeButtons: HTMLButtonElement[] = [];
  private readonly falloffButtons: HTMLButtonElement[] = [];
  private readonly directionButtons: HTMLButtonElement[] = [];
  private readonly materialButtons: HTMLButtonElement[] = [];
  private readonly radiusSlider: HTMLInputElement;
  private readonly strengthSlider: HTMLInputElement;
  private readonly densitySlider: HTMLInputElement;
  private readonly radiusValue: HTMLElement;
  private readonly strengthValue: HTMLElement;
  private readonly densityValue: HTMLElement;
  private readonly cells: {
    summary: HTMLElement;
    coord: HTMLElement;
    affected: HTMLElement;
    estimated: HTMLElement;
    ms: HTMLElement;
  };
  private lastRefresh = 0;
  private disposed = false;

  constructor(
    private readonly state: AppState,
    private readonly handlers: BrushUIHandlers,
  ) {
    this.buildButtonGroup('#brush-modes', BRUSH_MODES, BRUSH_MODE_LABELS, this.modeButtons, (mode) => {
      this.state.brush.mode = mode as BrushMode;
    });
    this.buildButtonGroup('#brush-shapes', BRUSH_SHAPES, BRUSH_SHAPE_LABELS, this.shapeButtons, (shape) => {
      this.state.brush.shape = shape as BrushShape;
    });
    this.buildButtonGroup(
      '#brush-falloffs',
      BRUSH_FALLOFFS,
      FALLOFF_LABELS,
      this.falloffButtons,
      (falloff) => {
        this.state.brush.falloff = falloff as FalloffType;
      },
    );
    this.buildButtonGroup(
      '#brush-directions',
      BRUSH_DIRECTIONS,
      DIRECTION_LABELS,
      this.directionButtons,
      (direction) => {
        this.state.brush.direction = direction as BrushDirection;
      },
    );

    this.materialButtons.push(...this.buildMaterialGrid());

    this.radiusSlider = must<HTMLInputElement>('#radius-slider');
    this.strengthSlider = must<HTMLInputElement>('#strength-slider');
    this.densitySlider = must<HTMLInputElement>('#density-slider');
    this.radiusValue = must<HTMLElement>('#radius-value');
    this.strengthValue = must<HTMLElement>('#strength-value');
    this.densityValue = must<HTMLElement>('#density-value');

    this.cells = {
      summary: must<HTMLElement>('#brush-summary'),
      coord: must<HTMLElement>('#bs-coord'),
      affected: must<HTMLElement>('#bs-count'),
      estimated: must<HTMLElement>('#bs-estimate'),
      ms: must<HTMLElement>('#bs-ms'),
    };

    this.radiusSlider.min = String(BRUSH_CONFIG.minRadius);
    this.radiusSlider.max = String(BRUSH_CONFIG.maxRadius);
    this.radiusSlider.step = '0.5';
    this.strengthSlider.min = String(BRUSH_CONFIG.minStrength);
    this.strengthSlider.max = String(BRUSH_CONFIG.maxStrength);
    this.strengthSlider.step = '0.05';
    this.densitySlider.min = '0';
    this.densitySlider.max = '1';
    this.densitySlider.step = '0.05';

    this.radiusSlider.addEventListener('input', this.handleRadius);
    this.strengthSlider.addEventListener('input', this.handleStrength);
    this.densitySlider.addEventListener('input', this.handleDensity);

    this.syncAll();
  }

  private buildButtonGroup(
    containerSelector: string,
    keys: readonly string[],
    labels: Record<string, string>,
    sink: HTMLButtonElement[],
    apply: (key: string) => void,
  ): void {
    const container = must<HTMLElement>(containerSelector);
    container.innerHTML = '';
    for (const key of keys) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.key = key;
      button.textContent = labels[key] ?? key;
      button.addEventListener('click', () => {
        apply(key);
        this.handlers.onBrushChange();
        this.syncAll();
      });
      container.appendChild(button);
      sink.push(button);
    }
  }

  private buildMaterialGrid(): HTMLButtonElement[] {
    const container = must<HTMLElement>('#material-grid');
    container.innerHTML = '';
    const buttons: HTMLButtonElement[] = [];
    for (const def of VOXEL_TYPES) {
      if (def.id === AIR) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.material = String(def.id);
      button.title = `${def.name}｜${def.description}`;
      button.innerHTML =
        `<span class="swatch" style="background:${colorToHexString(def.color)}"></span>` +
        `<span class="label">${def.name}</span>`;
      button.addEventListener('click', () => {
        this.state.brush.material = def.id;
        this.handlers.onBrushChange();
        this.syncAll();
      });
      container.appendChild(button);
      buttons.push(button);
    }
    return buttons;
  }

  private handleRadius = (): void => {
    this.state.brush.radius = Number(this.radiusSlider.value);
    this.handlers.onBrushChange();
    this.radiusValue.textContent = this.state.brush.radius.toFixed(1);
  };

  private handleStrength = (): void => {
    this.state.brush.strength = Number(this.strengthSlider.value);
    this.handlers.onBrushChange();
    this.strengthValue.textContent = this.state.brush.strength.toFixed(2);
  };

  private handleDensity = (): void => {
    this.state.brush.density = Number(this.densitySlider.value);
    this.handlers.onBrushChange();
    this.densityValue.textContent = this.state.brush.density.toFixed(2);
  };

  /** Alt + 滚轮调半径，Ctrl + 滚轮调强度（由 Engine 转发） */
  adjustRadius(delta: number): void {
    const brush = this.state.brush;
    brush.radius = clamp(
      round(brush.radius + delta * BRUSH_CONFIG.radiusStep, 1),
      BRUSH_CONFIG.minRadius,
      BRUSH_CONFIG.maxRadius,
    );
    this.radiusSlider.value = String(brush.radius);
    this.radiusValue.textContent = brush.radius.toFixed(1);
    this.handlers.onBrushChange();
  }

  adjustStrength(delta: number): void {
    const brush = this.state.brush;
    brush.strength = clamp(
      round(brush.strength + delta * BRUSH_CONFIG.strengthStep, 2),
      BRUSH_CONFIG.minStrength,
      BRUSH_CONFIG.maxStrength,
    );
    this.strengthSlider.value = String(brush.strength);
    this.strengthValue.textContent = brush.strength.toFixed(2);
    this.handlers.onBrushChange();
  }

  /** 数字键 1~9 与 0 / - / = 切换模式 */
  selectModeByIndex(index: number): boolean {
    const mode = BRUSH_MODES[index];
    if (!mode) return false;
    this.state.brush.mode = mode;
    this.handlers.onBrushChange();
    this.syncAll();
    return true;
  }

  cycleShape(delta: number): void {
    const current = BRUSH_SHAPES.indexOf(this.state.brush.shape);
    const next = (current + delta + BRUSH_SHAPES.length) % BRUSH_SHAPES.length;
    this.state.brush.shape = BRUSH_SHAPES[next]!;
    this.handlers.onBrushChange();
    this.syncAll();
  }

  /** 每帧调用（节流） */
  update(stats: BrushUIStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < 120) return;
    this.lastRefresh = now;

    this.cells.coord.textContent = stats.pointer
      ? `${stats.pointer.x}, ${stats.pointer.y}, ${stats.pointer.z}`
      : '--';
    this.cells.affected.textContent = String(stats.affected);
    this.cells.estimated.textContent = stats.estimated.toLocaleString('en-US');
    this.cells.ms.textContent = stats.editMs.toFixed(1);
  }

  /** 状态变化后强制刷新按钮高亮 */
  syncAll(): void {
    const brush = this.state.brush;
    for (const button of this.modeButtons) button.classList.toggle('active', button.dataset.key === brush.mode);
    for (const button of this.shapeButtons) button.classList.toggle('active', button.dataset.key === brush.shape);
    for (const button of this.falloffButtons) button.classList.toggle('active', button.dataset.key === brush.falloff);
    for (const button of this.directionButtons) button.classList.toggle('active', button.dataset.key === brush.direction);
    for (const button of this.materialButtons) {
      button.classList.toggle('active', Number(button.dataset.material) === brush.material);
    }

    this.radiusSlider.value = String(brush.radius);
    this.strengthSlider.value = String(brush.strength);
    this.densitySlider.value = String(brush.density);
    this.radiusValue.textContent = brush.radius.toFixed(1);
    this.strengthValue.textContent = brush.strength.toFixed(2);
    this.densityValue.textContent = brush.density.toFixed(2);

    const material = getVoxelDef(brush.material);
    this.cells.summary.textContent =
      `${BRUSH_MODE_LABELS[brush.mode]} · ${BRUSH_SHAPE_LABELS[brush.shape]} · ${material.name}`;
    this.lastRefresh = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.radiusSlider.removeEventListener('input', this.handleRadius);
    this.strengthSlider.removeEventListener('input', this.handleStrength);
    this.densitySlider.removeEventListener('input', this.handleDensity);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}
