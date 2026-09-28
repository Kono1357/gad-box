/**
 * 时间控制（M3 第 6 批）。
 *
 * `core/Time.ts` 是**累加器**（固定步长、暂停时消费单步、单帧最多追赶几步），
 * 这个文件是**策略层**：决定"允许哪些倍速"、"倍速怎么变成物理子步"、
 * "什么时候算超预算"、"回溯时物理该不该推进"。
 *
 * ────────────────────────────────────────────────────────────
 * 倍速的实现方式：改**缩放**而不是改**步长**
 * ────────────────────────────────────────────────────────────
 * 4 倍速有两种做法：
 * - A. 把时间步从 1/60 改成 1/240 —— 错。物理的行为**依赖时间步**，
 *   改步长会让"同样一堵墙、1 倍速不倒、4 倍速倒了"，玩家会觉得物理是随机的；
 * - B. 保持 1/60 不变，让每帧推进**更多步**（子步加倍）—— 对。
 *   这是本项目采用的做法，也是 `Time.advance` 里累加器的自然结果。
 *
 * 慢速档（0.5 / 0.25）同理：步长不变，只是每帧推进的步数变少 ——
 * 这是观察碰撞过程最有用的档位（一颗球落到地上的那一帧在 1 倍速下根本看不清）。
 *
 * 代价写清楚：4 倍速时每帧最多 4 倍子步，物理耗时也约 4 倍。
 * 所以 `maxSubsteps` 有硬上限，超预算时 `budget().over` 会如实置位、面板标红。
 */

import type { Time } from '../core/Time';

/** 允许的倍速档（用户要求：1/2/4 倍速 + 0.5/0.25 慢速） */
export const TIME_SCALES = [0.25, 0.5, 1, 2, 4] as const;
export type TimeScale = (typeof TIME_SCALES)[number];

export const TIME_SCALE_LABELS: Record<number, string> = {
  0.25: '0.25×（极慢，看碰撞细节）',
  0.5: '0.5×（慢速观察）',
  1: '1×（正常）',
  2: '2×（快进）',
  4: '4×（快速看结果）',
};

/** 单帧物理耗时预算（毫秒）。用户给的验收线是"物理求解耗时小于 5ms" */
export const DEFAULT_STEP_BUDGET_MS = 5;

export interface TimeControlOptions {
  /** 单帧物理耗时预算（毫秒） */
  budgetMs?: number;
  /**
   * 倍速上限对应的最大子步数。
   * 4 倍速 + 1/60 步长 = 每帧最多 4 步（60 FPS 下）；
   * 掉到 20 FPS 时同一倍速需要 12 步才能跟上，所以上限取 12。
   */
  maxSubstepsAt4x?: number;
}

export interface TimeAdvanceResult {
  /** 本帧实际推了几步 */
  steps: number;
  /** 当前倍速 */
  scale: number;
  /** 是否处于回溯（回溯时 steps 恒为 0，物理不推进） */
  rewinding: boolean;
  /** 本帧物理耗时（毫秒） */
  stepMs: number;
  /** 是否超过预算 */
  overBudget: boolean;
}

export interface TimeControlStats {
  paused: boolean;
  scale: number;
  rewinding: boolean;
  elapsed: number;
  stepCount: number;
  lastSteps: number;
  stepMs: number;
  budgetMs: number;
  overBudget: boolean;
  /** 连续超预算帧数（面板用来判断"是真的太重还是偶尔抖一下"） */
  overBudgetStreak: number;
}

export class TimeControl {
  private rewindingValue = false;
  private lastSteps = 0;
  private stepMsValue = 0;
  private overBudgetStreak = 0;
  private readonly budgetMs: number;
  private readonly maxSubstepsAt4x: number;
  /** 进入回溯前的暂停状态，退出时要还原（玩家可能是在暂停时点开的回溯） */
  private pausedBeforeRewind = false;

  constructor(
    private readonly time: Time,
    options: TimeControlOptions = {},
  ) {
    this.budgetMs = options.budgetMs ?? DEFAULT_STEP_BUDGET_MS;
    this.maxSubstepsAt4x = options.maxSubstepsAt4x ?? 12;
  }

  // ------------------------------------------------------------------ 倍速

  /**
   * 当前倍速。
   *
   * **刻意从 `Time` 读、不自己缓存**：倍速有两条写入路径（这个类的按钮、
   * `UISystem` 的工具栏按钮），缓存一份就一定会出现"工具栏显示 2×、面板显示 1×"
   * 这种两个真值来源的经典问题。`Time.scale` 是唯一真值，这里只做读取与校验。
   */
  get scale(): number {
    return this.time.scale;
  }

  /**
   * 设置倍速。
   *
   * 只接受 `TIME_SCALES` 里的值：面板是按钮组，理论上给不出别的值，
   * 但存档、URL 参数、调试面板都可能塞进任意数字，而 `0` 或负数会让累加器
   * 永远推不动（表现为"物理卡死"），所以在这里拦住并记日志。
   */
  setScale(scale: number): boolean {
    const found = TIME_SCALES.find((value) => Math.abs(value - scale) < 1e-9);
    if (found === undefined) {
      console.warn(`[时间] 不支持的倍速 ${scale}，可选：${TIME_SCALES.join(' / ')}`);
      return false;
    }
    this.time.setScale(found);
    return true;
  }

  /** 更快一档 / 更慢一档（快捷键用） */
  stepScale(direction: 1 | -1): number {
    const index = TIME_SCALES.indexOf(this.time.scale as TimeScale);
    const next = Math.min(TIME_SCALES.length - 1, Math.max(0, index + direction));
    this.setScale(TIME_SCALES[next]!);
    return this.scale;
  }

  /** 4 倍速时每帧最多允许几步（子步上限随倍速放大） */
  get effectiveMaxSubsteps(): number {
    const base = this.time.maxSubSteps;
    const factor = Math.max(1, this.time.scale);
    return Math.min(this.maxSubstepsAt4x, Math.round(base * factor));
  }

  // ------------------------------------------------------------------ 暂停 / 单步

  get paused(): boolean {
    return this.time.paused;
  }

  setPaused(paused: boolean): void {
    this.time.setPaused(paused);
  }

  togglePause(): boolean {
    this.time.togglePause();
    return this.time.paused;
  }

  /** 暂停下推进 N 步（单步按钮 / 快捷键） */
  requestStep(count = 1): void {
    // 单步在"播放中"也有意义（想看清下一帧），但那时按帧走会让人以为坏了，
    // 所以约定：单步会**自动暂停**。这条约定写在这里，避免各处实现不一致。
    if (!this.time.paused) this.time.setPaused(true);
    this.time.requestStep(count);
  }

  // ------------------------------------------------------------------ 回溯

  get rewinding(): boolean {
    return this.rewindingValue;
  }

  /**
   * 进入回溯模式：**物理停住**（`steps` 恒为 0），渲染由调用方按历史帧回写位姿。
   *
   * 为什么要显式暂停：回溯时每帧都会把世界里的物体位姿改写成历史值，
   * 如果物理还在推进，两边会互相打架 —— 表现为物体在历史位置和当前位置之间抖。
   */
  beginRewind(): void {
    if (this.rewindingValue) return;
    this.pausedBeforeRewind = this.time.paused;
    this.rewindingValue = true;
    this.time.setPaused(true);
  }

  /** 退出回溯：还原进入之前的暂停状态（不强行播放） */
  endRewind(): void {
    if (!this.rewindingValue) return;
    this.rewindingValue = false;
    this.time.setPaused(this.pausedBeforeRewind);
  }

  // ------------------------------------------------------------------ 推进

  /**
   * 推进一帧。
   *
   * @param realDelta 真实帧间隔（秒）
   * @param onStep 每个固定步的回调（物理 / 水 / 沙都挂在这里）
   */
  advance(realDelta: number, onStep: (dt: number) => void): TimeAdvanceResult {
    if (this.rewindingValue) {
      // 回溯期间只消费"单步请求"之外的一切：不推进、不累加
      this.lastSteps = 0;
      this.stepMsValue = 0;
      return {
        steps: 0,
        scale: this.time.scale,
        rewinding: true,
        stepMs: 0,
        overBudget: false,
      };
    }

    const started = now();
    const steps = this.time.advance(realDelta, onStep);
    const stepMs = now() - started;

    this.lastSteps = steps;
    this.stepMsValue = stepMs;
    if (stepMs > this.budgetMs && steps > 0) this.overBudgetStreak += 1;
    else this.overBudgetStreak = 0;

    return {
      steps,
      scale: this.time.scale,
      rewinding: false,
      stepMs,
      overBudget: stepMs > this.budgetMs && steps > 0,
    };
  }

  // ------------------------------------------------------------------ 统计

  get stats(): TimeControlStats {
    return {
      paused: this.time.paused,
      scale: this.time.scale,
      rewinding: this.rewindingValue,
      elapsed: this.time.elapsed,
      stepCount: this.time.stepCount,
      lastSteps: this.lastSteps,
      stepMs: this.stepMsValue,
      budgetMs: this.budgetMs,
      overBudget: this.stepMsValue > this.budgetMs && this.lastSteps > 0,
      overBudgetStreak: this.overBudgetStreak,
    };
  }

  /** 面板用：一行中文摘要 */
  describe(): string {
    const stats = this.stats;
    const parts = [
      stats.paused ? '暂停' : '播放',
      TIME_SCALE_LABELS[stats.scale] ?? `${stats.scale}×`,
      `已模拟 ${stats.elapsed.toFixed(1)} 秒 / ${stats.stepCount} 步`,
      `本帧 ${stats.stepMs.toFixed(2)} ms（预算 ${stats.budgetMs} ms）`,
    ];
    if (stats.rewinding) parts.unshift('回溯中');
    if (stats.overBudgetStreak >= 3) parts.push(`⚠ 连续 ${stats.overBudgetStreak} 帧超预算`);
    return parts.join('｜');
  }

  reset(): void {
    this.time.reset();
    this.lastSteps = 0;
    this.stepMsValue = 0;
    this.overBudgetStreak = 0;
    this.rewindingValue = false;
    this.time.setScale(1);
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
