/**
 * 自适应画质降级。
 *
 * 目标（需求 问题 6.9）：
 * - FPS 低于 30 → 自动降低渲染距离；
 * - FPS 低于 20 → 继续降级并关掉部分特效；
 * - 玩家手动改过画质后不再自动干预。
 *
 * 设计要点：**只在稳定越界一段时间后才动作**，而且**降级容易、恢复难**。
 * 理由：帧率抖动是常态，一掉到 29 就降级、一回到 31 又升回去，画质会一直闪；
 * 而频繁改渲染距离会让区块反复卸载/重建，反而更卡。
 * 所以：降级需要连续 1 秒低于阈值，恢复需要连续 6 秒高于阈值 + 5 FPS 余量。
 */

export type AdaptiveLevel = 'full' | 'reduced' | 'minimal';

export interface AdaptiveDecision {
  level: AdaptiveLevel;
  renderDistance: number;
  reason: string;
}

/** 降级阈值 */
const REDUCE_FPS = 30;
const MINIMAL_FPS = 20;
/** 恢复阈值（比降级高 5 FPS，形成迟滞） */
const RESTORE_FPS = 35;

/** 触发降级需要持续多久（毫秒） */
const REDUCE_HOLD_MS = 1000;
/** 触发恢复需要持续多久（毫秒） */
const RESTORE_HOLD_MS = 6000;

export class AdaptiveQuality {
  /** 总开关（玩家可关） */
  enabled = true;
  /** 玩家手动改过画质后置位 → 不再自动干预 */
  manualOverride = false;

  private level: AdaptiveLevel = 'full';
  private scale = 1;
  private lowSince = 0;
  private highSince = 0;
  private lastDecision: AdaptiveDecision | null = null;
  private appliedCount = 0;

  get currentLevel(): AdaptiveLevel {
    return this.level;
  }

  get currentScale(): number {
    return this.scale;
  }

  get decisions(): number {
    return this.appliedCount;
  }

  get lastApplied(): AdaptiveDecision | null {
    return this.lastDecision;
  }

  /** 世界换了、或玩家换了预设时重置 */
  reset(): void {
    this.level = 'full';
    this.scale = 1;
    this.lowSince = 0;
    this.highSince = 0;
    this.lastDecision = null;
  }

  /** 玩家手动指定降级档位（UI 里的"自动/强制"切换） */
  setLevel(level: AdaptiveLevel): AdaptiveDecision {
    this.level = level;
    this.scale = level === 'full' ? 1 : level === 'reduced' ? 0.7 : 0.45;
    this.lowSince = 0;
    this.highSince = 0;
    return { level: this.level, renderDistance: -1, reason: '手动指定' };
  }

  /**
   * 每帧调用。
   * @param fps 当前帧率
   * @param baseRenderDistance 世界档位给的基准渲染距离
   * @returns 需要应用的新设置；不需要变时返回 null
   */
  update(fps: number, baseRenderDistance: number, now = performance.now()): AdaptiveDecision | null {
    if (!this.enabled || this.manualOverride) return null;
    if (fps <= 0) return null;

    // 低帧率计时
    if (fps < REDUCE_FPS) {
      if (this.lowSince === 0) this.lowSince = now;
      this.highSince = 0;
    } else if (fps > RESTORE_FPS) {
      if (this.highSince === 0) this.highSince = now;
      this.lowSince = 0;
    } else {
      // 处于迟滞区间：两边计时都清掉，保持现状
      this.lowSince = 0;
      this.highSince = 0;
      return null;
    }

    // 降级
    if (this.lowSince > 0 && now - this.lowSince >= REDUCE_HOLD_MS) {
      const target: AdaptiveLevel = fps < MINIMAL_FPS ? 'minimal' : 'reduced';
      if (this.level !== target) {
        this.level = target;
        this.scale = target === 'reduced' ? 0.7 : 0.45;
        this.lowSince = now;
        this.appliedCount++;
        this.lastDecision = {
          level: target,
          renderDistance: Math.max(3, Math.round(baseRenderDistance * this.scale)),
          reason: `帧率 ${fps.toFixed(0)} FPS 偏低，渲染距离降到 ${Math.round(this.scale * 100)}%`,
        };
        return this.lastDecision;
      }
      // 已经到最低档还卡：不再继续降，避免把世界剥成眼前一小块
      return null;
    }

    // 恢复
    if (this.highSince > 0 && now - this.highSince >= RESTORE_HOLD_MS && this.level !== 'full') {
      const next: AdaptiveLevel = this.level === 'minimal' ? 'reduced' : 'full';
      this.level = next;
      this.scale = next === 'full' ? 1 : 0.7;
      this.highSince = now;
      this.appliedCount++;
      this.lastDecision = {
        level: next,
        renderDistance: Math.max(3, Math.round(baseRenderDistance * this.scale)),
        reason: `帧率回到 ${fps.toFixed(0)} FPS，画质回升到${next === 'full' ? '完整' : '中等'}`,
      };
      return this.lastDecision;
    }

    return null;
  }
}

export const ADAPTIVE_LABELS: Record<AdaptiveLevel, string> = {
  full: '完整',
  reduced: '中等',
  minimal: '最低',
};
