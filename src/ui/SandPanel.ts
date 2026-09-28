/**
 * 沙土面板（M4 第二部分 · 第 3 批）。
 *
 * 面板上刻意**显示全部实测数字**：沙格数、干/湿/饱和各多少、平均湿度、
 * 一步耗时、活跃格数、最近一次沙崩的规模。
 * 与流体面板同一个理由：沙的问题（"怎么不倒"、"怎么全塌了"）只能靠数字定位。
 *
 * 结构照既有面板约定：`container === null` 时不建 DOM 但逻辑照跑（断言里就这么用），
 * 文案全中文，`dispose()` 之后任何方法都不抛异常。
 */

import type { SandSystem } from '../sand/SandSystem';
import type { SandEditor } from '../sand/SandEditor';
import { SAND_TOOL_LABELS, REPOSE_ANCHORS, type SandTool } from '../sand/SandPhysics';

export interface SandPanelHandlers {
  onToolChange(tool: SandTool): void;
  onRadiusChange(radius: number): void;
  onHeightChange(height: number): void;
  onToggleVisualizer(visible: boolean): void;
  onMarkAll(): void;
}

export class SandPanel {
  private readonly els: {
    count: HTMLElement | null;
    dry: HTMLElement | null;
    wet: HTMLElement | null;
    saturated: HTMLElement | null;
    moisture: HTMLElement | null;
    stepMs: HTMLElement | null;
    active: HTMLElement | null;
    collapse: HTMLElement | null;
    angle: HTMLElement | null;
    tools: HTMLElement | null;
    radius: HTMLInputElement | null;
    radiusLabel: HTMLElement | null;
    height: HTMLInputElement | null;
    heightLabel: HTMLElement | null;
    visualToggle: HTMLInputElement | null;
    markAll: HTMLElement | null;
    note: HTMLElement | null;
  };
  private disposed = false;
  private lastTextMs = 0;

  constructor(
    root: HTMLElement | null,
    private readonly sand: SandSystem,
    private readonly editor: SandEditor,
    private readonly handlers: SandPanelHandlers,
  ) {
    this.els = {
      count: null, dry: null, wet: null, saturated: null, moisture: null, stepMs: null,
      active: null, collapse: null, angle: null, tools: null, radius: null, radiusLabel: null,
      height: null, heightLabel: null, visualToggle: null, markAll: null, note: null,
    };
    if (root === null || typeof document === 'undefined') return;
    this.build();
    this.refresh(true);
  }

  private build(): void {
    const pick = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
    this.els.count = pick('sand-count');
    this.els.dry = pick('sand-dry');
    this.els.wet = pick('sand-wet');
    this.els.saturated = pick('sand-saturated');
    this.els.moisture = pick('sand-moisture');
    this.els.stepMs = pick('sand-step-ms');
    this.els.active = pick('sand-active');
    this.els.collapse = pick('sand-collapse');
    // ⚠ 这里原本找的是 `#sand-angle`，但地形笔刷面板里已经有一个同名的 range input ——
    // 重名会让"安息角说明"写到那个滑杆上（把它的文本清空），症状是笔刷滑杆看起来坏了。
    this.els.angle = pick('sand-repose-note');
    this.els.tools = pick('sand-tools');
    this.els.radius = pick('sand-radius');
    this.els.radiusLabel = pick('sand-radius-label');
    this.els.height = pick('sand-height');
    this.els.heightLabel = pick('sand-height-label');
    this.els.visualToggle = pick('sand-visual-toggle');
    this.els.markAll = pick('sand-mark-all');
    this.els.note = pick('sand-note');

    if (this.els.tools) {
      this.els.tools.innerHTML = '';
      for (const tool of Object.keys(SAND_TOOL_LABELS) as SandTool[]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.sandTool = tool;
        button.textContent = SAND_TOOL_LABELS[tool];
        button.title = TOOL_HINTS[tool];
        button.addEventListener('click', () => {
          this.handlers.onToolChange(tool);
          this.syncToolButtons();
        });
        this.els.tools.appendChild(button);
      }
      this.syncToolButtons();
    }

    if (this.els.radius) {
      this.els.radius.min = '1';
      this.els.radius.max = '12';
      this.els.radius.step = '1';
      this.els.radius.value = String(this.editor.radius);
      this.els.radius.addEventListener('input', () => {
        this.handlers.onRadiusChange(Number(this.els.radius?.value ?? '3'));
        this.updateLabels();
      });
    }
    if (this.els.height) {
      this.els.height.min = '1';
      this.els.height.max = '16';
      this.els.height.step = '1';
      this.els.height.value = String(this.editor.pileHeight);
      this.els.height.addEventListener('input', () => {
        this.handlers.onHeightChange(Number(this.els.height?.value ?? '6'));
        this.updateLabels();
      });
    }
    if (this.els.visualToggle) {
      this.els.visualToggle.checked = false;
      this.els.visualToggle.addEventListener('change', () => {
        this.handlers.onToggleVisualizer(this.els.visualToggle?.checked === true);
      });
    }
    if (this.els.markAll) {
      this.els.markAll.addEventListener('click', () => this.handlers.onMarkAll());
    }
    if (this.els.angle) {
      this.els.angle.textContent =
        `安息角：干沙 ${REPOSE_ANCHORS.dry}°｜湿沙 ${REPOSE_ANCHORS.wet}°｜饱和沙 ${REPOSE_ANCHORS.saturated}°（离散近似）`;
    }
    if (this.els.note) {
      this.els.note.textContent =
        '沙是有状态的格子：湿度决定安息角（干 34° / 湿 45° / 饱和 15°），' +
        '饱和沙会像泥流一样摊开。贴在水边的沙会自己吸水，没水的沙会慢慢干。' +
        '「凝固」把沙变成石头，这是唯一不可逆的操作。';
    }
    this.updateLabels();
  }

  private syncToolButtons(): void {
    if (!this.els.tools) return;
    for (const button of Array.from(this.els.tools.querySelectorAll<HTMLButtonElement>('button'))) {
      button.classList.toggle('active', button.dataset.sandTool === this.editor.tool);
    }
  }

  private updateLabels(): void {
    if (this.els.radiusLabel) this.els.radiusLabel.textContent = `${this.editor.radius} 格`;
    if (this.els.heightLabel) this.els.heightLabel.textContent = `${this.editor.pileHeight} 格`;
  }

  /** 刷新数字（按 400 ms 节流；`survey()` 会扫全世界，不能每帧做） */
  refresh(force = false): void {
    if (this.disposed) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && now - this.lastTextMs < 400) return;
    this.lastTextMs = now;
    const stats = this.sand.stats;
    const byState = stats.byState;
    const total = byState.dry + byState.wet + byState.saturated;
    if (this.els.count) this.els.count.textContent = `${total}`;
    if (this.els.dry) this.els.dry.textContent = `${byState.dry}`;
    if (this.els.wet) this.els.wet.textContent = `${byState.wet}`;
    if (this.els.saturated) this.els.saturated.textContent = `${byState.saturated}`;
    if (this.els.moisture) {
      this.els.moisture.textContent = total === 0 ? '—' : `${(stats.averageMoisture * 100).toFixed(0)}%`;
    }
    if (this.els.stepMs) {
      this.els.stepMs.textContent = stats.active === 0
        ? '0 ms（没有活跃沙）'
        : `${stats.ms.toFixed(2)} ms（${stats.moved} 格）`;
    }
    if (this.els.active) this.els.active.textContent = `${this.sand.activeCount}`;
    if (this.els.collapse) {
      const last = this.sand.recentCollapses[0];
      this.els.collapse.textContent = last
        ? `最近一次：${last.cells} 格（共记录 ${this.sand.recentCollapses.length} 次）`
        : '还没有记录到沙崩（搬动 ≥12 格才算一次）';
    }
  }

  syncControlsFromState(): void {
    if (this.els.radius) this.els.radius.value = String(this.editor.radius);
    if (this.els.height) this.els.height.value = String(this.editor.pileHeight);
    if (this.els.visualToggle) this.els.visualToggle.checked = true;
    this.updateLabels();
    this.syncToolButtons();
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

/** 每个工具的悬停提示（说清"它会做什么、是不是可逆"） */
const TOOL_HINTS: Record<SandTool, string> = {
  pile: '在笔刷位置堆出一个沙丘（中间高、边缘低）',
  dig: '把笔刷范围内的沙挖掉',
  wet: '把沙弄湿（变湿后能堆到 45°，但会慢慢风干）',
  dry: '把沙弄干（回到 34° 的干沙）',
  solidify: '把沙变成石头 —— 不可逆，用来做地基或挡土墙',
};
