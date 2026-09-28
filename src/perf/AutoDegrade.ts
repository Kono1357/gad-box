/**
 * 自动降级策略（src/perf 模块 5/5）—— **它是已有 `AdaptiveQuality` 的扩展，不是替代品**。
 *
 * ────────────────────────────────────────────────────────────
 * 依赖方向（为什么 import 它，而不是各算各的）
 * ────────────────────────────────────────────────────────────
 * 两条路都可行，这里选了「import 它并委托」：
 *
 * - `AdaptiveQuality` 的迟滞常量（REDUCE_FPS 30 / MINIMAL_FPS 20 / RESTORE_FPS 35、
 *   REDUCE_HOLD_MS 1000、RESTORE_HOLD_MS 6000）**是模块私有的，没有 export**，
 *   想"复用常量"就得先把它们导出——那要改已有的文件，也会让别人多一份可以改的数字。
 * - 与其把数字抄一遍（两份数字迟早会漂移，画质就会随帧率横跳），
 *   不如**持有一个 `AdaptiveQuality` 实例，把帧率这一维整个委托给它**：
 *   渲染距离与 full/reduced/minimal 档位的判断、迟滞、手动覆盖语义，全部原样复用。
 * - 本模块只新增它没有的两维：**物理耗时** 与 **特效开关**，
 *   并为这两维按同样的迟滞思路写了自己的计时器（常量名都带 AUTO_DEGRADE_ 前缀，
 *   并在注释里写明与 AdaptiveQuality 哪个常量对齐，方便日后一起改）。
 *
 * 注意：`AutoDegrade` 内部那一份 `AdaptiveQuality` 就是唯一的决策源。
 * 如果调用方在别处还留着自己 new 的一个实例，请把它换掉（用 `quality` getter 取这一份），
 * 否则两个实例各记各的低帧计时，会出现"这边刚恢复、那边又降"的抖动。
 *
 * ────────────────────────────────────────────────────────────
 * 三条规则
 * ────────────────────────────────────────────────────────────
 * 1. FPS < 30（持续 1 秒）→ 降渲染距离（交给 AdaptiveQuality，档位 full→reduced→minimal）；
 * 2. FPS < 20（持续 1 秒）→ 关阴影与 AO；恢复要 FPS > 35 持续 6 秒（移动端再多要 5 FPS）；
 * 3. 物理单帧 > 8 ms（持续 1 秒）→ 降物理精度。
 *
 * ────────────────────────────────────────────────────────────
 * "降物理精度"具体降什么：**降分帧预算 / 减少子步，绝不降求解器迭代次数**
 * ────────────────────────────────────────────────────────────
 * 这一条很容易做错。降低求解器迭代（iterations）会让物理**行为**突变：
 * 原来能稳稳立住的塔，降级之后突然就倒了；玩家会以为是 bug，而且同一份存档
 * 在两个档位上表现不一致。
 *
 * 所以这里的动作是交给 `FrameScheduler.setBudget()`：把物理那些周期性杂活
 * （倒塌判定、应力、距离剔除、支撑索引）**每帧的预算调小**，
 * 结果只是它们跑得稀一点、散布得更开，**物理结果本身不变**——精度换的是"什么时候算完"，
 * 不是"算出来是什么"。
 *
 * 纯逻辑、零依赖：只 import 项目内同样零依赖的 `AdaptiveQuality`，
 * 不碰 three / Rapier / Engine，可以直接在 Node 里断言。
 */

import { AdaptiveQuality, ADAPTIVE_LABELS, type AdaptiveLevel } from '../world/AdaptiveQuality';

export interface DegradeInput {
  fps: number;
  /** 物理单帧耗时（毫秒） */
  physicsMs: number;
  /** 当前渲染距离（区块） */
  renderDistance: number;
  /** 基准渲染距离 */
  baseRenderDistance: number;
  /** 是否移动端 */
  isMobile: boolean;
}

export interface DegradeAction {
  kind: 'render-distance' | 'shadows' | 'ao' | 'physics-precision' | 'particles' | 'none';
  /** 新的值（render-distance 是新区块数，其余是开/关） */
  value: number | boolean;
  reason: string;
}

export interface DegradeResult {
  actions: DegradeAction[];
  /** 降级后的档位（与 AdaptiveQuality 的 full/reduced/minimal 一致） */
  level: 'full' | 'reduced' | 'minimal';
  /** 一句话说明（给 toast） */
  summary: string;
  /** 是否什么都没做 */
  noop: boolean;
}

// ── 与 AdaptiveQuality 对齐的常量 ─────────────────────────────────
// 这几个数字和 AdaptiveQuality 里的私有常量**必须一致**，改了要一起改。
// 之所以在这里重写一遍，是因为那边没导出（见文件头说明）。

/** 降级所需持续时间：对齐 AdaptiveQuality.REDUCE_HOLD_MS */
const AUTO_DEGRADE_REDUCE_HOLD_MS = 1000;
/** 恢复所需持续时间：对齐 AdaptiveQuality.RESTORE_HOLD_MS（恢复比降级慢得多，避免来回横跳） */
const AUTO_DEGRADE_RESTORE_HOLD_MS = 6000;
/** 关阴影/AO 的帧率阈值：对齐 AdaptiveQuality.MINIMAL_FPS */
const EFFECTS_OFF_FPS = 20;
/** 恢复阴影/AO 的帧率阈值：对齐 AdaptiveQuality.RESTORE_FPS（= 降级阈值 + 15，形成迟滞） */
const EFFECTS_ON_FPS = 35;
/** 移动端恢复阴影/AO 额外多要的 FPS 余量（手机上一开特效就掉帧，所以恢复更保守） */
const MOBILE_RESTORE_MARGIN_FPS = 5;

/** 物理耗时的触发阈值（毫秒）：超过它就降物理精度 */
const DEFAULT_PHYSICS_THRESHOLD_MS = 8;
/** 物理恢复的下沿：耗时掉到阈值的这个比例以下，才算"真的不忙了"（迟滞的另一半） */
const PHYSICS_RESTORE_RATIO = 0.75;
/** FrameScheduler 的基准每帧预算（毫秒），与它的构造函数默认值 2.5 一致 */
const DEFAULT_FRAME_BUDGET_MS = 2.5;
/**
 * 物理档位 → 分帧预算系数。
 * 0 = 不干预（1.0）；1 = 轻微收紧；2 = 收紧到 35%（再低就真的会让维护任务饿死，
 * 分帧调度里 0.5 ms 是它的下限）。
 */
const PHYSICS_BUDGET_SCALES = [1, 0.6, 0.35];

export class AutoDegrade {
  private readonly adaptive = new AdaptiveQuality();
  private readonly physicsThresholdMs: number;
  private readonly frameBudgetBaseMs: number;
  private enabledValue: boolean;
  private manualOverrideValue = false;

  /** 阴影/AO 当前是否被关掉（由本模块决定，供存档与 UI 读取） */
  private effectsOff = false;
  /** 物理档位：0 正常 / 1 收紧 / 2 最紧 */
  private physicsTier = 0;
  /** 最近一次下发过的渲染距离；-1 表示"没干预过，用世界基准值" */
  private appliedRenderDistance = -1;

  // 计时器哨兵统一用 -1（而不是 0），这样 nowMs 从 0 开始计时也不会失灵
  private effectsLowSince = -1;
  private effectsHighSince = -1;
  private physicsLowSince = -1;
  private physicsHighSince = -1;

  constructor(options: { physicsBudgetMs?: number; enabled?: boolean; frameBudgetMs?: number } = {}) {
    this.physicsThresholdMs =
      options.physicsBudgetMs && options.physicsBudgetMs > 0 ? options.physicsBudgetMs : DEFAULT_PHYSICS_THRESHOLD_MS;
    this.frameBudgetBaseMs =
      options.frameBudgetMs && options.frameBudgetMs > 0 ? options.frameBudgetMs : DEFAULT_FRAME_BUDGET_MS;
    this.enabledValue = options.enabled ?? true;
    this.adaptive.enabled = this.enabledValue;
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
    // 总开关同步给内部那一份 AdaptiveQuality：它自己也有 enabled，两处不一致会出现
    // "本模块以为关了、它却还在降渲染距离"的情况
    this.adaptive.enabled = enabled;
    if (!enabled) this.clearTimers();
  }

  /** 玩家手动改过画质后置位：自适应不再干预（与 AdaptiveQuality 的 manualOverride 语义一致） */
  setManualOverride(value: boolean): void {
    this.manualOverrideValue = value;
    this.adaptive.manualOverride = value;
    // 玩家刚手动改完画质时，之前累积的"低了 800ms"不该立刻生效，计时清零重来
    if (value) this.clearTimers();
  }

  get manualOverride(): boolean {
    return this.manualOverrideValue;
  }

  /** 内部持有的那一份 AdaptiveQuality（调用方应该用它，而不是再 new 一个） */
  get quality(): AdaptiveQuality {
    return this.adaptive;
  }

  /** 降级后的档位 */
  get currentLevel(): AdaptiveLevel {
    return this.adaptive.currentLevel;
  }

  /** 阴影/AO 是否处于关闭状态 */
  get shadowsDisabled(): boolean {
    return this.effectsOff;
  }

  /** 当前建议的 FrameScheduler 每帧预算（毫秒） */
  get currentPhysicsBudgetMs(): number {
    return this.budgetForTier(this.physicsTier);
  }

  /**
   * 每帧调用（内部自己做迟滞与节流）。
   *
   * 只有**状态真的翻转**时才会下发动作：同一个决定不会每帧重复返回，
   * 否则调用方每帧都要重建阴影、重设预算，反而把帧率拖下去。
   */
  update(input: DegradeInput, nowMs: number): DegradeResult {
    // 关掉 / 玩家手动覆盖：只读档位，什么都不做
    if (!this.enabledValue || this.manualOverrideValue) {
      return {
        actions: [],
        level: this.adaptive.currentLevel,
        summary: this.manualOverrideValue
          ? '画质已由玩家手动指定，自动降级不再干预'
          : '自动降级已关闭',
        noop: true,
      };
    }

    const actions: DegradeAction[] = [];
    const reasons: string[] = [];
    const fps = Number.isFinite(input.fps) && input.fps > 0 ? input.fps : 0;

    // ── 规则 1：FPS 维度，整条委托给 AdaptiveQuality（渲染距离 + 档位 + 迟滞）──
    const decision = this.adaptive.update(fps, input.baseRenderDistance, nowMs);
    if (decision && decision.renderDistance >= 0) {
      this.appliedRenderDistance = decision.renderDistance;
      // 把"从多少降到多少"写进 reason：toast 上只写新值，玩家不知道自己原来是多少
      const detail = `${decision.reason}（${input.renderDistance} → ${decision.renderDistance} 区块）`;
      actions.push({ kind: 'render-distance', value: decision.renderDistance, reason: detail });
      reasons.push(detail);
    }

    // ── 规则 2：FPS < 20 → 关阴影与 AO ──
    if (fps > 0) {
      if (fps < EFFECTS_OFF_FPS) {
        if (this.effectsLowSince < 0) this.effectsLowSince = nowMs;
        this.effectsHighSince = -1;
      } else if (fps > this.effectsRestoreFps(input.isMobile)) {
        if (this.effectsHighSince < 0) this.effectsHighSince = nowMs;
        this.effectsLowSince = -1;
      } else {
        // 迟滞区间（20 ≤ FPS ≤ 35）：两边计时都清掉，保持现状
        this.effectsLowSince = -1;
        this.effectsHighSince = -1;
      }
    }

    if (
      !this.effectsOff &&
      this.effectsLowSince >= 0 &&
      nowMs - this.effectsLowSince >= AUTO_DEGRADE_REDUCE_HOLD_MS
    ) {
      this.effectsOff = true;
      this.effectsLowSince = nowMs; // 重新计时 = 冷却，降级后这段时间内不会再次触发
      const reason = `帧率 ${fps.toFixed(0)} FPS 低于 ${EFFECTS_OFF_FPS}，关闭阴影与 AO`;
      actions.push({ kind: 'shadows', value: false, reason });
      actions.push({ kind: 'ao', value: false, reason });
      reasons.push(reason);
    } else if (
      this.effectsOff &&
      this.effectsHighSince >= 0 &&
      nowMs - this.effectsHighSince >= AUTO_DEGRADE_RESTORE_HOLD_MS
    ) {
      this.effectsOff = false;
      this.effectsHighSince = nowMs;
      const reason = `帧率稳定在 ${fps.toFixed(0)} FPS 以上，恢复阴影与 AO`;
      actions.push({ kind: 'shadows', value: true, reason });
      actions.push({ kind: 'ao', value: true, reason });
      reasons.push(reason);
    }

    // ── 规则 3：物理 > 8ms → 降物理精度（调 FrameScheduler 的预算）──
    if (input.physicsMs > this.physicsThresholdMs) {
      if (this.physicsLowSince < 0) this.physicsLowSince = nowMs;
      this.physicsHighSince = -1;
    } else if (input.physicsMs < this.physicsThresholdMs * PHYSICS_RESTORE_RATIO) {
      if (this.physicsHighSince < 0) this.physicsHighSince = nowMs;
      this.physicsLowSince = -1;
    } else {
      // 迟滞区间（6 ms ≤ 物理 ≤ 8 ms）：不动作
      this.physicsLowSince = -1;
      this.physicsHighSince = -1;
    }

    if (
      this.physicsTier < PHYSICS_BUDGET_SCALES.length - 1 &&
      this.physicsLowSince >= 0 &&
      nowMs - this.physicsLowSince >= AUTO_DEGRADE_REDUCE_HOLD_MS
    ) {
      this.physicsTier += 1;
      this.physicsLowSince = nowMs;
      const budget = this.budgetForTier(this.physicsTier);
      const reason = `物理单帧 ${input.physicsMs.toFixed(1)} ms 超过 ${this.physicsThresholdMs} ms，分帧预算降到 ${budget} ms`;
      actions.push({ kind: 'physics-precision', value: budget, reason });
      reasons.push(reason);
    } else if (
      this.physicsTier > 0 &&
      this.physicsHighSince >= 0 &&
      nowMs - this.physicsHighSince >= AUTO_DEGRADE_RESTORE_HOLD_MS
    ) {
      this.physicsTier -= 1;
      this.physicsHighSince = nowMs;
      const budget = this.budgetForTier(this.physicsTier);
      const reason = `物理耗时回落到 ${(this.physicsThresholdMs * PHYSICS_RESTORE_RATIO).toFixed(1)} ms 以下，分帧预算回升到 ${budget} ms`;
      actions.push({ kind: 'physics-precision', value: budget, reason });
      reasons.push(reason);
    }

    const level = this.adaptive.currentLevel;
    const noop = actions.length === 0;
    return {
      actions,
      level,
      summary: noop
        ? `画质档位「${ADAPTIVE_LABELS[level]}」，本帧无需调整`
        : `自动降级：${reasons.join('；')}（当前档位「${ADAPTIVE_LABELS[level]}」）`,
      noop,
    };
  }

  /** 供存档保存的设置 */
  snapshot(): { level: string; renderDistance: number; physicsBudgetMs: number } {
    return {
      level: this.adaptive.currentLevel,
      // -1 = 本局从未干预过渲染距离，读档时应继续用世界档位给的基准值
      renderDistance: this.appliedRenderDistance,
      // 这里是**当前生效的分帧预算**（要交给 FrameScheduler.setBudget 的那个数），
      // 不是构造参数里的触发阈值（那个是 8 ms）
      physicsBudgetMs: this.currentPhysicsBudgetMs,
    };
  }

  /** 面板/日志用：一行中文摘要 */
  describe(): string {
    const level = ADAPTIVE_LABELS[this.adaptive.currentLevel];
    const state = !this.enabledValue
      ? '已关闭'
      : this.manualOverrideValue
        ? '已让位给玩家手动设置'
        : `档位「${level}」｜渲染距离 ${this.appliedRenderDistance < 0 ? '未干预' : `${this.appliedRenderDistance} 区块`}｜` +
          `阴影/AO ${this.effectsOff ? '已关' : '开启'}｜物理分帧预算 ${this.currentPhysicsBudgetMs} ms（阈值 ${this.physicsThresholdMs} ms）`;
    return (
      `自动降级（${state}）：FPS<30 降渲染距离、FPS<${EFFECTS_OFF_FPS} 关阴影/AO` +
      `（恢复需 >${EFFECTS_ON_FPS} FPS 且持续 ${AUTO_DEGRADE_RESTORE_HOLD_MS / 1000} 秒）、` +
      `物理>${this.physicsThresholdMs} ms 降分帧预算；` +
      `降级需持续 ${AUTO_DEGRADE_REDUCE_HOLD_MS / 1000} 秒 —— 降级容易、恢复难，避免画质横跳`
    );
  }

  /** 回到初始状态（换地图 / 换质量预设时调用） */
  reset(): void {
    this.adaptive.reset();
    this.effectsOff = false;
    this.physicsTier = 0;
    this.appliedRenderDistance = -1;
    this.clearTimers();
  }

  private clearTimers(): void {
    this.effectsLowSince = -1;
    this.effectsHighSince = -1;
    this.physicsLowSince = -1;
    this.physicsHighSince = -1;
  }

  /** 恢复阴影/AO 的帧率要求：移动端更保守，多要 5 FPS 余量 */
  private effectsRestoreFps(isMobile: boolean): number {
    return isMobile ? EFFECTS_ON_FPS + MOBILE_RESTORE_MARGIN_FPS : EFFECTS_ON_FPS;
  }

  /** 档位 → 分帧预算（保留两位小数，避免出现 1.0499999 这种数写进存档） */
  private budgetForTier(tier: number): number {
    const scale = PHYSICS_BUDGET_SCALES[Math.max(0, Math.min(PHYSICS_BUDGET_SCALES.length - 1, tier))]!;
    return Math.max(0.5, Math.round(this.frameBudgetBaseMs * scale * 100) / 100);
  }
}
