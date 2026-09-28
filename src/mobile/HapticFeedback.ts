/**
 * 震动反馈（补充 5）—— 手机上"手比眼睛快"的那一层反馈。
 *
 * ## 为什么要有这一层
 *
 * 触摸屏没有鼠标点击的"咔哒"声，也没有指针对齐的精度：手指按住的地方就是落点，
 * 挡住的地方看不见。所以**播放震动**是手机上唯一"不占屏幕"的确认手段：
 * 放置成功短震一下、失败双短震、拿起物体长震 —— 玩家不用回头看 HUD 就知道
 * 刚才那一下成没成。三种核心反馈是用户点名要的，另外补了切地图 / 撤销 / 错误。
 *
 * ## 浏览器这条硬约束（务必读）
 *
 * `navigator.vibrate()` **只能在用户手势（user activation）之后调用**：
 * 触摸 / 点击 / 键盘事件的处理器里才算数，定时器、加载回调、`requestAnimationFrame`
 * 里调用会被浏览器静默忽略（Chrome 还会在控制台警告"Blocked call to navigator.vibrate
 * because the user hasn't interacted with the page yet"）。
 * 所以：
 * - 本类**只在被调用时震**，绝不自己拼一个 gesture；
 * - **没有**"第一次手势先攒着、之后补震一次"之类的 hack —— 那种做法要么骗不过浏览器，
 *   要么在真正的手势里重复震两次，都是自找的 bug（这一点写在 `play()` 的注释里）；
 * - 调用方保证：所有 `play()` 都发生在 TouchInput / 按钮回调的调用链上。
 *
 * 另外要诚实说明：**iOS Safari 至今不支持 `navigator.vibrate`**，
 * 所以 iPhone 上 `isSupported === false`，震动会被静默跳过 ——
 * 这不是 bug，是平台限制，别去写"iPhone 用 audio 播一声"之类的替代品（那是另一件事）。
 *
 * ## 其它设计点
 *
 * 1. **零依赖**：不 import 任何东西（尤其不 import DeviceCapability —— 那边也会探测
 *    `navigator.vibrate`，但两边刻意不互相 import，避免模块之间绕来绕去；
 *    DeviceProfile.canVibrate 只用来决定"要不要 new 本类"）。
 * 2. **Node 里 import 不能崩**：`typeof navigator === 'undefined'` 时
 *    `isSupported === false`，`play()` 返回 false 并把次数记进 `stats.unsupported`。
 *    `navigator.vibrate` 在部分浏览器（无权限 / 无痕模式）会**抛异常**，
 *    所以调用点一律 try/catch，异常同样计入 `unsupported`。
 * 3. **节流**：连续放置（连续堆叠 / 拖动中反复落点）时若每一下都震，手机会变成
 *    按摩棒，还费电。默认 40ms 内的重复震动不再播，计入 `throttled`。
 *    但 **`place-fail` 与 `error` 不受节流限制** —— 失败反馈丢了玩家会以为放成功了，
 *    这种"漏报"比多震一下严重得多，宁可多震。
 * 4. 图案都是毫秒数，`[震, 停, 震, 停, ...]`，必须是整数：某些实现会因为
 *    非整数项直接抛 TypeError。
 */

/** 反馈种类 */
export type HapticKind = 'place-ok' | 'place-fail' | 'pickup' | 'switch-map' | 'undo' | 'error';

export interface HapticPattern {
  /** 震动/停顿序列（毫秒）：[震, 停, 震, 停, ...] */
  pattern: number[];
  /** 中文说明，面板里显示 */
  label: string;
}

/**
 * 震动图案表。
 *
 * 定值的理由（时长都在 10~120ms 这一档，手机线性马达才能听出区别）：
 * - `place-ok` `[18]`：18ms 是"咔"一声的程度。**刻意短**，因为它会被连续触发
 *   （连续堆叠、快速摆一排），长了就变成连续嗡嗡声；
 * - `place-fail` `[22, 60, 22]`：失败必须和成功**一耳朵分得出来**，所以用两下短震；
 *   中间 60ms 的停顿是关键 —— 太短两下会糊成一下长的；
 * - `pickup` `[70]`：拿起是"抓住一个东西"的重量感，明显长于放置；
 *   和 `place-ok` 的 18ms 拉开 4 倍差距，手感上不会混；
 * - `switch-map` `[10, 40, 10, 40, 10]`：三连极短震 = "档位跳了三格"的节奏感，
 *   总长 110ms，不会拖慢切地图；
 * - `undo` `[12]`：撤销是轻量回退，比放置还轻一点，暗示"这一步退回去了"；
 * - `error` `[120]`：长震 = 出事了。和 `place-fail`（两下短震）区分开：
 *   前者是"操作被拒绝"，后者是"系统级错误 / 存档失败"。
 */
export const HAPTIC_PATTERNS: Record<HapticKind, HapticPattern> = {
  'place-ok': { pattern: [18], label: '放置成功 · 短震一下' },
  'place-fail': { pattern: [22, 60, 22], label: '放置失败 · 双短震' },
  pickup: { pattern: [70], label: '拿起物体 · 长震' },
  'switch-map': { pattern: [10, 40, 10, 40, 10], label: '切换地图 · 三连轻震' },
  undo: { pattern: [12], label: '撤销 · 极轻震' },
  error: { pattern: [120], label: '错误 · 长震警告' },
};

/** 不受节流限制的种类：失败反馈不能丢 */
const THROTTLE_EXEMPT: ReadonlySet<HapticKind> = new Set<HapticKind>(['place-fail', 'error']);

export interface HapticFeedbackOptions {
  /** 总开关（默认 true，但**只在真的支持 navigator.vibrate 时才实际震动**） */
  enabled?: boolean;
  /** 最小间隔（毫秒），默认 40 —— 连续放置时不要每一下都震 */
  minIntervalMs?: number;
}

/** 统计快照（调试面板用） */
export interface HapticStats {
  /** 总共被要求震了几次 */
  asked: number;
  /** 真的震出去了几次 */
  played: number;
  /** 因为节流被丢掉几次 */
  throttled: number;
  /** 没能震成几次（不支持 / 抛异常 / 浏览器拒绝） */
  unsupported: number;
}

/** 默认最小间隔（毫秒） */
const DEFAULT_MIN_INTERVAL_MS = 40;

/**
 * `navigator.vibrate` 的最小接口。
 * 单独抽出来是为了能返回 null（不支持时），也方便测试塞假对象。
 */
interface VibrationNavigator {
  vibrate(pattern: number | number[]): boolean;
}

/** 拿到"能震动"的 navigator，拿不到返回 null。任何环境调用都不抛异常。 */
function getVibrationNavigator(): VibrationNavigator | null {
  try {
    if (typeof navigator === 'undefined') return null;
    if (typeof navigator.vibrate !== 'function') return null;
    return navigator;
  } catch {
    // 某些内嵌 WebView 连读 navigator.vibrate 都会抛
    return null;
  }
}

/**
 * 震动反馈。
 *
 * 用法（**必须在用户手势的调用链里**）：
 * ```ts
 * // TouchInput 的 tap 回调里
 * const ok = placement.tryPlace(point);
 * haptics.play(ok ? 'place-ok' : 'place-fail');
 * ```
 */
export class HapticFeedback {
  private enabledFlag: boolean;
  private readonly minIntervalMs: number;
  /** 上一次**真的震出去**的时间戳（被节流 / 没支持的不算，否则节流会越拖越久） */
  private lastPlayMs: number | null = null;
  private askedCount = 0;
  private playedCount = 0;
  private throttledCount = 0;
  private unsupportedCount = 0;
  private disposed = false;

  constructor(options: HapticFeedbackOptions = {}) {
    this.enabledFlag = options.enabled ?? true;
    const requested = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.minIntervalMs = Number.isFinite(requested) && requested > 0 ? requested : 0;
  }

  /**
   * 浏览器是否支持震动（不是"用户有没有开"）。
   *
   * 刻意**每次都现查**而不是构造时缓存：Embedded WebView 里 `navigator.vibrate`
   * 有可能晚一步才挂上，缓存住会永久判成"不支持"；现查的成本只是一次属性判断。
   */
  get isSupported(): boolean {
    return getVibrationNavigator() !== null;
  }

  /** 当前是否开启（与 isSupported 无关：关掉只是"不要震"，不代表设备不支持） */
  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    const changed = this.enabledFlag !== enabled;
    this.enabledFlag = enabled;
    // 刚关掉时把正在播的震动掐断：一个 120ms 的长震不该继续抖完
    if (changed && !enabled) this.cancelVibration();
  }

  /**
   * 触发一次震动。
   *
   * 被节流或用户关闭时**不震动**，但会如实记进 stats（面板才能看出"为什么没震"）。
   *
   * 这里**不做**任何"补手势"的尝试：`navigator.vibrate` 要求 user activation，
   * 而 user activation 是浏览器给的、不能伪造。与其写一段"攒着等下次手势一起震"的
   * 逻辑（结果是下次手势里震两下、顺序还错），不如把责任写清楚：
   * **调用方必须把手势回调当调用点**。
   *
   * @returns 是否真的震动成功
   */
  play(kind: HapticKind): boolean {
    return this.playInternal(kind, false);
  }

  /**
   * 面板上手动试一下。
   *
   * 与 `play()` 的区别：**忽略总开关与节流**（用户明确点了"试一下"，
   * 就算他之前把总开关关了，这一下也应该震给他听），但同样计入 stats。
   * 它天然发生在 click / touch 回调里，满足 user activation 要求。
   */
  preview(kind: HapticKind): boolean {
    return this.playInternal(kind, true);
  }

  /** 统计（调试面板用）。返回快照，调用方改了不会污染内部计数 */
  get stats(): HapticStats {
    return {
      asked: this.askedCount,
      played: this.playedCount,
      throttled: this.throttledCount,
      unsupported: this.unsupportedCount,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 离开页面 / 重开一局：别让上一局的长震继续抖
    this.cancelVibration();
  }

  // ---------------------------------------------------------------- 内部

  private playInternal(kind: HapticKind, force: boolean): boolean {
    if (this.disposed) return false;

    const entry = HAPTIC_PATTERNS[kind];
    // 类型上 kind 一定命中，但面板可能拿字符串拼一个 kind 出来（JS / JSON 配置），
    // 兜一下：未知种类直接不震，绝不去访问 undefined.pattern
    if (!entry) return false;

    this.askedCount += 1;

    // 用户主动关掉：不震、不计节流（计入"asked 但没 played"，面板可自行相减看出）
    if (!force && !this.enabledFlag) return false;

    const nav = getVibrationNavigator();
    if (!nav) {
      this.unsupportedCount += 1;
      return false;
    }

    const now = Date.now();
    if (!force && !THROTTLE_EXEMPT.has(kind)) {
      if (this.lastPlayMs !== null && now - this.lastPlayMs < this.minIntervalMs) {
        // 太密了：丢掉这一下（place-fail / error 走不到这里，它们免节流）
        this.throttledCount += 1;
        return false;
      }
    }

    try {
      // 注意用 nav.vibrate(...) 而不是把函数取出来单调用：部分实现要求 this 是 navigator
      const result = nav.vibrate(entry.pattern);
      if (result === false) {
        // 浏览器明确拒绝（非法图案 / 无权限 / 被静默屏蔽）：算"没震成"
        this.unsupportedCount += 1;
        return false;
      }
    } catch {
      // 无权限的浏览器会直接抛；异常也只是"没震成"，不能往上冒
      this.unsupportedCount += 1;
      return false;
    }

    this.playedCount += 1;
    this.lastPlayMs = now;
    return true;
  }

  /**
   * 打断当前震动（`vibrate(0)` 是标准里的"取消"写法）。
   *
   * 这不算一次播放：不动任何计数。无权限时它同样可能抛，忽略即可 ——
   * 一次"打扫"失败没有值得上报的东西。
   */
  private cancelVibration(): void {
    const nav = getVibrationNavigator();
    if (!nav) return;
    try {
      nav.vibrate(0);
    } catch {
      /* 忽略 */
    }
  }
}
