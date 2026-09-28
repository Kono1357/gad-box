/**
 * 应力可视化（M3 补充 2）。
 *
 * ⚠️ **必须先说清楚这不是有限元分析。**
 *
 * 真实的应力要解弹性力学方程：材料杨氏模量、泊松比、截面惯性矩、节点位移……
 * 那需要一整套求解器（几百 KB 到几 MB）和大量计算，与本项目"纯前端、能部署 GitHub Pages、
 * 手机上 30 FPS"的约束直接冲突。所以这里做的是**启发式的受力指示**：
 *
 * ```
 * 应力 ≈ 0.55 × (1 − 支撑充分度)   ← 接触面积越小，同样的重量压得越集中
 *      + 0.30 × 承重比例          ← 头顶压着的东西越多越危险
 *      + 0.15 × 悬挑比例          ← 伸出去越长，越靠远端受力
 * ```
 *
 * 它能回答："我这座桥/这个悬挑看起来合理吗？"
 * 它**不能**回答："这根梁会不会在 3.2 秒后断"、"最大应力在哪个截面"。
 *
 * ────────────────────────────────────────────────────────────
 * 着色怎么落地（不额外开 draw call）
 * ────────────────────────────────────────────────────────────
 * 建筑渲染是按 (模型, 镜像) 合批的 InstancedMesh，颜色走 `instanceColor`，
 * 稳定性着色已经占用了这条通道。应力复用同一条通道，通过给渲染器一个**着色提供者**接管：
 * 开应力就不需要第二套 mesh、也不需要额外 draw call ——
 * 代价是两者不能同时显示（面板上互斥，写清了）。
 */

import type { BuildingInstance } from '../building/types';

export type StressScheme = 'heat' | 'mono';

export const STRESS_SCHEME_LABELS: Record<StressScheme, string> = {
  heat: '热力图（白 → 黄 → 红）',
  mono: '单色（白 → 灰，适合截图）',
};

export interface StressEntry {
  objectId: number;
  defId: string;
  /** 0~1，越大越危险 */
  stress: number;
  /** 接触点数（来自 Rapier 接触报告，未知时为 -1） */
  contacts: number;
  supportRatio: number;
  loadLayers: number;
  cantileverRatio: number;
}

export interface StressOptions {
  /** 结果刷新间隔（毫秒），默认 250 */
  refreshMs?: number;
  /** 超过这个值算"危险"，默认 0.55 */
  dangerThreshold?: number;
}

export interface StressSummary {
  count: number;
  max: number;
  average: number;
  overThreshold: number;
  /** 既超阈值、接触点又少（≤1）的数量 —— 这才是"真的危险" */
  dangerous: number;
  worst: StressEntry[];
  ms: number;
}

export interface StressInputs {
  instances: readonly BuildingInstance[];
}

export class StressVisualizer {
  private enabledValue = false;
  private schemeValue: StressScheme = 'heat';
  private thresholdValue: number;
  private readonly refreshMs: number;
  private entries: StressEntry[] = [];
  private byId = new Map<number, StressEntry>();
  private contactOverride = new Map<number, number>();
  private summaryValue: StressSummary = {
    count: 0, max: 0, average: 0, overThreshold: 0, dangerous: 0, worst: [], ms: 0,
  };
  private lastComputeMs = Number.NEGATIVE_INFINITY;

  constructor(options: StressOptions = {}) {
    this.refreshMs = Math.max(0, options.refreshMs ?? 250);
    this.thresholdValue = clamp01(options.dangerThreshold ?? 0.55);
  }

  get enabled(): boolean { return this.enabledValue; }
  setEnabled(enabled: boolean): void { this.enabledValue = enabled; }
  get scheme(): StressScheme { return this.schemeValue; }
  setScheme(scheme: StressScheme): void { this.schemeValue = scheme; }
  get threshold(): number { return this.thresholdValue; }
  setThreshold(value: number): void { this.thresholdValue = clamp01(value); }
  get summary(): StressSummary { return this.summaryValue; }
  get all(): readonly StressEntry[] { return this.entries; }
  stressOf(objectId: number): number { return this.byId.get(objectId)?.stress ?? 0; }

  /** 由调用方在 compute 之前塞入 Rapier 的接触点数（没有就留空） */
  setContactCounts(contacts: ReadonlyMap<number, number>): void {
    this.contactOverride = new Map(contacts);
  }

  /**
   * 算一遍应力。
   *
   * 节流放在**计算之前**：应力是可视化，人眼分辨不出 250 毫秒差别，
   * 而遍历 + 排序全部建筑在 500 个物体时是要花时间的。节流放在算完之后只是少写几次 DOM。
   */
  compute(inputs: StressInputs, nowMs: number): StressSummary {
    if (this.refreshMs > 0 && nowMs - this.lastComputeMs < this.refreshMs && this.entries.length > 0) {
      return this.summaryValue;
    }
    this.lastComputeMs = nowMs;
    const started = now();

    const entries: StressEntry[] = [];
    for (const instance of inputs.instances) {
      const supportRatio = clamp01(instance.contactRatio ?? 1);
      const size = Math.max(0.2, Math.max(instance.size?.[0] ?? 1, instance.size?.[2] ?? 1));
      const cantileverRatio = clamp01((instance.cantilever ?? 0) / size);
      const loadLayers = Math.max(0, instance.stackLayer ?? 0);
      const loadRatio = clamp01(loadLayers / 8);
      const contacts = this.contactOverride.get(instance.id) ?? -1;
      const stress = clamp01(0.55 * (1 - supportRatio) + 0.3 * loadRatio + 0.15 * cantileverRatio);
      entries.push({
        objectId: instance.id,
        defId: instance.defId,
        stress,
        contacts,
        supportRatio,
        loadLayers,
        cantileverRatio,
      });
    }
    entries.sort((a, b) => b.stress - a.stress);

    this.entries = entries;
    this.byId = new Map(entries.map((entry) => [entry.objectId, entry]));

    const top = entries[0];
    const max = top ? top.stress : 0;
    const average = entries.length > 0
      ? entries.reduce((sum, entry) => sum + entry.stress, 0) / entries.length
      : 0;
    this.summaryValue = {
      count: entries.length,
      max,
      average,
      overThreshold: entries.filter((entry) => entry.stress > this.thresholdValue).length,
      dangerous: entries.filter(
        (entry) => entry.stress > this.thresholdValue && entry.contacts >= 0 && entry.contacts <= 1,
      ).length,
      worst: entries.slice(0, 6),
      ms: now() - started,
    };
    return this.summaryValue;
  }

  /**
   * 应力 → 着色乘数（乘在物体原色上）。
   *
   * 关键：**低应力必须是纯白 [1,1,1]**，也就是"不染色"。如果低应力染成蓝色，
   * 整座建筑会变成一片蓝色海洋，玩家反而看不出哪里危险 ——
   * 和稳定性着色同一个原则：只让"有问题的"显形。
   */
  tintFor(objectId: number): [number, number, number] {
    return this.tintForStress(this.stressOf(objectId));
  }

  tintForStress(stress: number): [number, number, number] {
    const value = clamp01(stress);
    const start = this.thresholdValue * 0.5;
    if (value <= start) return [1, 1, 1];
    const span = Math.max(0.001, 1 - start);
    const t = clamp01((value - start) / span);

    if (this.schemeValue === 'mono') {
      const gray = 1 - t * 0.55;
      return [gray, gray, gray];
    }
    // 热力图：白 → 黄 → 红
    if (t < 0.5) {
      const k = t / 0.5;
      return [1, 1 - k * 0.2, 1 - k * 0.85];
    }
    const k = (t - 0.5) / 0.5;
    return [1, 0.8 - k * 0.5, 0.15 * (1 - k)];
  }

  colorForStress(stress: number): string {
    const [r, g, b] = this.tintForStress(stress);
    const toByte = (value: number): number => Math.round(clamp01(value) * 255);
    return `rgb(${toByte(r)}, ${toByte(g)}, ${toByte(b)})`;
  }

  /** 面板图例的 CSS 渐变（0 → 0.25 → 0.5 → 0.75 → 1） */
  legendGradient(): string {
    const stops = [0, 0.25, 0.5, 0.75, 1].map(
      (value) => `${this.colorForStress(value)} ${(value * 100).toFixed(0)}%`,
    );
    return `linear-gradient(90deg, ${stops.join(', ')})`;
  }

  describe(): string {
    if (!this.enabledValue) return '应力可视化：已关闭';
    const summary = this.summaryValue;
    if (summary.count === 0) return '应力可视化：世界里还没有物体';
    return (
      `应力可视化（${STRESS_SCHEME_LABELS[this.schemeValue]}）：${summary.count} 个物体，` +
      `最高 ${(summary.max * 100).toFixed(0)}%，平均 ${(summary.average * 100).toFixed(0)}%，` +
      `${summary.overThreshold} 个超过阈值 ${(this.thresholdValue * 100).toFixed(0)}%｜` +
      `${summary.ms.toFixed(2)} ms｜⚠ 近似指示，不是有限元分析`
    );
  }

  /** ⚠ 面板上直接显示的固定诚实声明 */
  static readonly DISCLAIMER =
    '应力是由支撑面积与承重层数推算的**近似指示**，用于观察结构是否合理；它不是有限元分析，不能预测断裂时间或截面受力。';

  reset(): void {
    this.entries = [];
    this.byId.clear();
    this.contactOverride.clear();
    this.summaryValue = { count: 0, max: 0, average: 0, overThreshold: 0, dangerous: 0, worst: [], ms: 0 };
    this.lastComputeMs = Number.NEGATIVE_INFINITY;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
