/**
 * 物理音效（补充 9）：**全部用 Web Audio 现场合成，不引入任何一个音频文件。**
 *
 * ## 为什么不放素材
 *
 * 本项目至今零音频素材，包体已经 1 MB gzip —— 再塞几个 mp3/ogg，"仍可部署到
 * GitHub Pages 且手机上能打开"这条约束就要开始动摇（一次撞击音 3 个采样率、
 * 至少几百 KB）。而物理音效需要的是**数量**（轻重撞击、摩擦、倒塌、落水、马达、
 * 触发器），不是**音质**。所以这里用振荡器 + 白噪声 + 滤波器现场合成：
 * 一个文件、零字节素材、参数可调、可以单测断言。
 *
 * ## 诚实取舍（这一点必须写在最前面）
 *
 * 这些是**合成音效，不是实录**。目标是"玩家能听出发生了什么"：
 * 轻碰是短促的高频咔哒、重击是低沉的闷响、倒塌是低频轰鸣加噪声。
 * 它**不像真实录音**，也不打算像 —— 用合成音去模仿木头/金属/水的真实频谱，
 * 投入产出比极低，而"有反馈"这件事本身才是玩家要的（这一点和震动反馈同一个思路：
 * HapticFeedback 也从不为"手感真实"做妥协性的 hack）。
 *
 * ## 浏览器这条硬约束（务必读）
 *
 * `AudioContext` 在**没有用户手势**的情况下创建会处于 `suspended`，并且
 * Chrome 会在控制台警告"The AudioContext was not allowed to start"。
 * 所以本类：
 * - **构造函数里绝不创建 AudioContext**（那是最容易被 autoplay 策略抓住的时机）；
 * - 第一次 `play()` 才创建，并同时调一次 `resume()`（异步解锁）；
 * - 解锁没成功时**如实把次数记进 `blocked`**，`describe()` 里直接告诉玩家
 *   「浏览器拦截了自动播放，请先点一下页面」，而不是假装播过了。
 *
 * 关于"第一次算不算 blocked"的口径（写清楚免得以后被当成 bug）：
 * 被挂起的上下文里 `currentTime` 是不前进的，所以第一次 `play()` 调度下去的音
 * 在解锁之后**仍然会响**。因此第一次遇到 `suspended` 时我们照常调度、返回 true，
 * 只在**下一次仍然是 suspended** 时才判定"解锁失败"、计入 `blocked` 并返回 false。
 * 也就是说：被真的拦住时，最多会漏报一次，但绝不会一直误报 —— 宁可少报一次，
 * 也不要每次都冤枉浏览器。
 *
 * ## 零 import
 *
 * 不 import 任何东西（不 import 项目里的模块，也不 import 类型包）。
 * Node 下 `typeof window === 'undefined'` → `isSupported === false`，
 * 所有 `play()` 返回 false 并计入 `unsupported`，`new PhysicsAudio()` 不抛异常。
 */

export type PhysicsSoundKind =
  | 'impact-light' // 轻碰
  | 'impact-heavy' // 重击
  | 'friction' // 摩擦
  | 'collapse' // 倒塌（低频轰鸣）
  | 'splash' // 落水
  | 'motor' // 马达启动
  | 'trigger'; // 触发器触发（短促提示）

export interface SoundSpec {
  kind: PhysicsSoundKind;
  /** 中文说明 */
  label: string;
  /** 合成参数（面板可显示，也便于测试断言） */
  spec: {
    /** 波形 */
    wave: 'sine' | 'square' | 'sawtooth' | 'triangle' | 'noise';
    /** 起始频率（Hz）与结束频率（Hz），相等表示不变调 */
    freqFrom: number;
    freqTo: number;
    /** 时长（秒） */
    duration: number;
    /** 音量 0~1 */
    gain: number;
    /** 噪声成分占比 0~1（0 = 纯音，1 = 纯噪声） */
    noiseMix: number;
    /** 低通截止起始（Hz） */
    filterFrom: number;
    /** 低通截止结束（Hz） */
    filterTo: number;
  };
}

/**
 * 音效参数表。
 *
 * 每个音都按"**听感上的物理直觉**"来定，理由逐条写在下面：
 * - 轻碰 / 重击的区别靠三件事一起做：**频率下移多少**（撞击越重，能量越往低频走）、
 *   **时长**（重击有尾音）、**噪声占比**（真实撞击的"啪"本质是一段被低通的噪声）。
 *   只改音量的话，轻重听起来只是"远近不同"，而不是"轻重不同"。
 * - 摩擦、落水用**纯噪声 / 高比例噪声**：它们的物理本质就是宽带随机过程，
 *   振荡器只会做出"电子音"。
 * - 倒塌是**最长的一个（1.1 秒）**，专门用来表达"这件事还在继续"：
 *   它和重击在时长上差了 3 倍，长音一响玩家就知道不是一次撞击而是一整片塌下来。
 * - 马达用 `square`（方波谐波丰富，像小电机）+ 频率**上扫**（45 → 120 Hz）表达启动。
 * - 触发器是唯一的**高频上行**提示音（880 → 1320 Hz，纯音无噪声），
 *   和所有物理音都拉开距离 —— 它是"逻辑事件"不是"碰撞事件"，不该混在一起。
 *
 * `wave: 'noise'` 的音（摩擦）不创建振荡器，`freqFrom/freqTo` 因此填 0 表示"不参与合成"。
 */
export const PHYSICS_SOUNDS: Record<PhysicsSoundKind, SoundSpec> = {
  'impact-light': {
    kind: 'impact-light',
    label: '轻碰 · 短促高频咔哒',
    spec: {
      wave: 'triangle',
      freqFrom: 320,
      freqTo: 140,
      duration: 0.08,
      gain: 0.35,
      noiseMix: 0.35,
      filterFrom: 4200,
      filterTo: 900,
    },
  },
  'impact-heavy': {
    kind: 'impact-heavy',
    label: '重击 · 低沉闷响带尾音',
    spec: {
      wave: 'sine',
      freqFrom: 120,
      freqTo: 45,
      duration: 0.32,
      gain: 0.7,
      noiseMix: 0.45,
      filterFrom: 1600,
      filterTo: 200,
    },
  },
  friction: {
    kind: 'friction',
    label: '摩擦 · 低通白噪声',
    spec: {
      wave: 'noise',
      // 纯噪声：不用振荡器，频率字段不参与合成
      freqFrom: 0,
      freqTo: 0,
      duration: 0.22,
      gain: 0.22,
      noiseMix: 1,
      filterFrom: 2600,
      filterTo: 1200,
    },
  },
  collapse: {
    kind: 'collapse',
    label: '倒塌 · 低频轰鸣（最长的一个）',
    spec: {
      wave: 'sawtooth',
      freqFrom: 90,
      freqTo: 28,
      duration: 1.1,
      gain: 0.85,
      noiseMix: 0.55,
      filterFrom: 700,
      filterTo: 90,
    },
  },
  splash: {
    kind: 'splash',
    label: '落水 · 高频噪声下扫',
    spec: {
      wave: 'sine',
      freqFrom: 900,
      freqTo: 200,
      duration: 0.28,
      gain: 0.4,
      noiseMix: 0.75,
      filterFrom: 5200,
      filterTo: 700,
    },
  },
  motor: {
    kind: 'motor',
    label: '马达启动 · 方波上扫',
    spec: {
      wave: 'square',
      freqFrom: 45,
      freqTo: 120,
      duration: 0.5,
      gain: 0.3,
      noiseMix: 0.25,
      filterFrom: 900,
      filterTo: 1800,
    },
  },
  trigger: {
    kind: 'trigger',
    label: '触发器 · 短促纯音上行提示',
    spec: {
      wave: 'sine',
      freqFrom: 880,
      freqTo: 1320,
      duration: 0.12,
      gain: 0.3,
      noiseMix: 0,
      filterFrom: 8000,
      filterTo: 6000,
    },
  },
};

export interface PhysicsAudioOptions {
  enabled?: boolean;
  /** 主音量 0~1 */
  volume?: number;
  /** 同时最多几个音（超过就丢弃最旧的） */
  maxVoices?: number;
}

/** 统计快照（调试面板用） */
export interface PhysicsAudioStats {
  /** 被要求播几次 */
  asked: number;
  /** 真的播出去几次 */
  played: number;
  /** 被丢掉的次数（同名 60ms 内重复 + 因 maxVoices 抢占失败） */
  throttled: number;
  /** 当前环境播不了（Node / 没有 Web Audio / 合成抛异常） */
  unsupported: number;
  /** 浏览器拦截了自动播放（AudioContext 一直是 suspended） */
  blocked: number;
}

/**
 * 同名音效的最小间隔（毫秒）。
 *
 * 60ms 的理由：500 个箱子同时落地，物理上它们会在同一个时间窗里产生几百次接触 ——
 * 每一次都合成一个音，等于瞬间创建几百个振荡器，CPU 直接打满（比画面卡更糟，
 * 因为音频线程卡住会连带主线程一起抖）。而人耳在这个密度下也分不出"500 声"，
 * 只会听到一堵噪音墙。60ms 刚好是"能听成连续敲击"的下限（约 16 次/秒）。
 */
const THROTTLE_MS = 60;

/** 默认最多同时 8 个音：手机音频线程的甜点区，再多就听不出层次、只剩音量 */
const DEFAULT_MAX_VOICES = 8;

/**
 * 不受节流限制的种类。
 * **倒塌必须响**：它是一次"事件"而不是连续碰撞噪声（一次垮塌只会触发几次），
 * 丢掉它等于把玩家最需要知道的事情吞掉 —— 和 HapticFeedback 里
 * "place-fail / error 不受节流"是同一个道理：漏报比多响一次严重得多。
 */
const THROTTLE_EXEMPT: ReadonlySet<PhysicsSoundKind> = new Set<PhysicsSoundKind>(['collapse']);

/**
 * 撞击类音效：它们之间按 `intensity` 竞争，**丢弃时先丢最弱的那个**（而不是最早的）。
 * 理由：一堵墙塌下来的时候，同时进音的有"大片中小碰撞"和"最后那一下大的"；
 * 按时间丢会把"那一下大的"丢掉，玩家听到的是一堆碎响却听不到重击。
 */
const IMPACT_KINDS: ReadonlySet<PhysicsSoundKind> = new Set<PhysicsSoundKind>(['impact-light', 'impact-heavy']);

/** 白噪声 buffer 的长度（秒）。最长的音是 1.1 秒的倒塌，靠 loop 续上，所以 1 秒够用 */
const NOISE_SECONDS = 1;

/**
 * `exponentialRampToValueAtTime` 的"静音"目标值。
 *
 * **这个坑必须记住：指数斜坡的 target 不能是 0**，Web Audio 规范里
 * `exponentialRampToValueAtTime(0, t)` 会抛 `RangeError`（指数曲线永远到不了 0），
 * 所以所有"渐弱到静音"的地方一律用 0.0001（-80 dB，人耳听不见）。
 */
const SILENT = 0.0001;

/** 频率的合法范围：低于 20 Hz 听不见还会让某些实现行为诡异，高于 18 kHz 手机上没意义 */
const MIN_FREQ = 20;
const MAX_FREQ = 18000;

/** 主音量留的余量：多个音叠加时不至于削波（8 个 0.7 的音同时响就是爆音） */
const MASTER_HEADROOM = 0.9;

/** `playImpact` 的可听下限（m/s）：低于它的接触不播，也不计 asked */
const IMPACT_MIN_SPEED = 0.35;

/** 判为"重击"的速度阈值（m/s）：约等于 1 米高度自由落体的撞击速度 */
const HEAVY_SPEED = 2.2;

/** `playImpact` 里把速度折算成 0~1 强度的参考速度（m/s）：5 米落下约 10 m/s，取 6 是全强 */
const IMPACT_FULL_SPEED = 6;

/** 超过这个质量（kg）的物体，即使速度不大也按重击算（大石头蹭一下也闷） */
const HEAVY_MASS_KG = 120;

/** AudioContext 构造器类型（浏览器里可能是 webkit 前缀那个） */
type AudioContextCtor = new () => AudioContext;

/** 一个正在响的音 */
interface ActiveVoice {
  kind: PhysicsSoundKind;
  /** 用于撞击类之间的优先级比较（非撞击类填 0） */
  intensity: number;
  /** 记的是调用方传来的 nowMs（不是音频时钟），只用于比较先后 */
  startedAtMs: number;
  gain: GainNode;
  sources: (OscillatorNode | AudioBufferSourceNode)[];
}

/**
 * 拿到 `AudioContext` 构造器，拿不到返回 null。任何环境下调用都不抛异常。
 *
 * **每次都现查**而不是构造时缓存：Embedded WebView 里 `AudioContext` 有可能晚一步
 * 才挂上，缓存住会永久判成"不支持"（和 HapticFeedback 对 navigator.vibrate 的处理一致）。
 */
function getAudioContextCtor(): AudioContextCtor | null {
  try {
    // Node / 服务端渲染：没有 window，直接判不支持（这是本文件"Node 下不崩"的关键）
    if (typeof window === 'undefined') return null;
    const scope = window as unknown as {
      AudioContext?: AudioContextCtor;
      webkitAudioContext?: AudioContextCtor;
    };
    return scope.AudioContext ?? scope.webkitAudioContext ?? null;
  } catch {
    // 某些被裁剪过的 WebView 连读 window.AudioContext 都会抛
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function safeFreq(value: number): number {
  return clamp(value, MIN_FREQ, MAX_FREQ);
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

/**
 * 物理音效。
 *
 * 用法（Engine 从 Rapier 拿到接触冲量之后）：
 * ```ts
 * audio.playImpact(contactImpulse, massKg);       // 撞击：自动选轻重、自动节流
 * audio.play('collapse', 0.9);                    // 倒塌：一定响
 * ```
 */
export class PhysicsAudio {
  private enabledFlag: boolean;
  private volumeFlag: number;
  private readonly maxVoices: number;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** 白噪声 buffer：只生成一次并复用（每帧 new 一个 1 秒 buffer 是纯浪费） */
  private noiseBuffer: AudioBuffer | null = null;

  private readonly voices: ActiveVoice[] = [];
  /** 每种音上一次真的播出去的时间（被节流 / 没播成的不算，否则节流会越拖越久） */
  private readonly lastPlayMs = new Map<PhysicsSoundKind, number>();
  /** 连续看到 suspended 的次数：> 1 次才判定"解锁失败"（见文件头口径说明） */
  private suspendedStreak = 0;

  private askedCount = 0;
  private playedCount = 0;
  private throttledCount = 0;
  private unsupportedCount = 0;
  private blockedCount = 0;
  private disposed = false;

  constructor(options: PhysicsAudioOptions = {}) {
    this.enabledFlag = options.enabled ?? true;
    this.volumeFlag = clamp01(options.volume ?? 0.6);
    const requested = options.maxVoices ?? DEFAULT_MAX_VOICES;
    this.maxVoices = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : DEFAULT_MAX_VOICES;
    // 刻意**不**在这里创建 AudioContext：见文件头的 autoplay 说明
  }

  /** 浏览器是否支持 Web Audio（不是"用户有没有开"） */
  get isSupported(): boolean {
    return getAudioContextCtor() !== null;
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    const changed = this.enabledFlag !== enabled;
    this.enabledFlag = enabled;
    // 刚关掉时把正在响的都掐断：一个 1.1 秒的倒塌轰鸣不该继续响完
    if (changed && !enabled) this.stopAll();
  }

  setVolume(volume: number): void {
    this.volumeFlag = clamp01(volume);
    if (this.master) {
      try {
        this.master.gain.value = this.volumeFlag * MASTER_HEADROOM;
      } catch {
        /* 极少数实现会抛：音量没设上也不该把这一帧打挂 */
      }
    }
  }

  /**
   * 播放一次。`intensity` 0~1 会调制音量与音高（重击更低沉更响）。
   * 返回是否真的播了。
   */
  play(kind: PhysicsSoundKind, intensity = 1, atMs?: number): boolean {
    return this.playInternal(kind, intensity, atMs ?? nowMs(), false);
  }

  /**
   * 按碰撞冲量选音效并播放 —— Engine 从 Rapier 的接触力拿强度后调这个。
   *
   * 换算口径（写清楚，免得调参时两边理解不一致）：
   * - `speed = impulse / mass`：冲量除以质量就是**速度改变量**（m/s），
   *   这才是"撞得多狠"的直接度量；只用冲量的话，一根羽毛撞出同样冲量会听起来像炮弹。
   * - 低于 `IMPACT_MIN_SPEED`（0.35 m/s）**直接返回 false 且不计 asked**：
   *   静置的箱子每帧都在产生微小接触冲量，把它们算进统计，面板上的数字就变成噪声了。
   * - `speed ≥ HEAVY_SPEED`（2.2 m/s，约 1 米高自由落体）或质量 ≥ 120 kg 走重击。
   */
  playImpact(impulse: number, massKg: number): boolean {
    if (this.disposed) return false;
    if (!Number.isFinite(impulse) || impulse <= 0) return false;
    const mass = Number.isFinite(massKg) && massKg > 0 ? massKg : 1;
    const speed = impulse / mass;
    if (speed < IMPACT_MIN_SPEED) return false;

    const intensity = clamp01(speed / IMPACT_FULL_SPEED);
    const heavy = speed >= HEAVY_SPEED || mass >= HEAVY_MASS_KG;
    return this.play(heavy ? 'impact-heavy' : 'impact-light', intensity);
  }

  /** 停止所有声音（切地图 / 暂停时用） */
  stopAll(): void {
    const ctx = this.ctx;
    if (!ctx) {
      this.voices.length = 0;
      return;
    }
    // 复制一份再遍历：releaseVoice 会改动 this.voices
    for (const voice of [...this.voices]) this.stopVoice(voice, ctx, false);
    this.voices.length = 0;
  }

  get stats(): PhysicsAudioStats {
    return {
      asked: this.askedCount,
      played: this.playedCount,
      throttled: this.throttledCount,
      unsupported: this.unsupportedCount,
      blocked: this.blockedCount,
    };
  }

  /**
   * 面板上手动试听。
   *
   * 与 `play()` 的区别：**忽略总开关与节流**（用户明确点了"试听"，
   * 就算他之前把音效关了，这一下也该响给他听），但同样计入统计。
   * 它天然发生在 click 回调里，正好也满足 autoplay 对用户手势的要求。
   */
  preview(kind: PhysicsSoundKind): boolean {
    return this.playInternal(kind, 1, nowMs(), true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll();
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    if (ctx) {
      try {
        // close() 返回 Promise：不接住会变成 unhandled rejection
        void ctx.close().catch(() => undefined);
      } catch {
        /* 已经关掉了 */
      }
    }
  }

  /** 面板用：一行中文摘要 */
  describe(): string {
    if (!getAudioContextCtor()) {
      return '物理音效：当前环境不支持 Web Audio（Node 里跑测试就是这个结果，属正常）';
    }
    if (!this.enabledFlag) {
      const snapshot = this.stats;
      return `物理音效：已关闭（请求 ${snapshot.asked} 次，一次都没播）`;
    }
    const snapshot = this.stats;
    const parts = [
      `物理音效：已开启`,
      `主音量 ${Math.round(this.volumeFlag * 100)}%`,
      `同时 ${this.voices.length}/${this.maxVoices} 个音`,
      `请求 ${snapshot.asked}（播放 ${snapshot.played}，丢弃 ${snapshot.throttled}）`,
    ];
    if (snapshot.blocked > 0) {
      // 如实说：这不是 bug，是浏览器策略，玩家点一下页面就能解决
      parts.push(
        `浏览器拦截了自动播放 ${snapshot.blocked} 次 —— 请先点一下页面（点任意位置即可），音效才会响`,
      );
    }
    if (snapshot.unsupported > 0) parts.push(`合成失败 ${snapshot.unsupported} 次`);
    return parts.join('｜');
  }

  // ---------------------------------------------------------------- 内部

  private playInternal(kind: PhysicsSoundKind, intensity: number, atMs: number, force: boolean): boolean {
    if (this.disposed) return false;

    // 面板 / JSON 配置可能拼出一个不存在的 kind 出来，兜一下：绝不去访问 undefined.spec
    const entry: SoundSpec | undefined = PHYSICS_SOUNDS[kind];
    if (!entry) return false;

    this.askedCount += 1;

    // 用户主动关掉：不播、不计节流（asked 与 played 的差额面板自己能看出来）
    if (!force && !this.enabledFlag) return false;

    // 节流：同名音效 60ms 内不重复播（collapse 免节流，见 THROTTLE_EXEMPT 的说明）
    if (!force && !THROTTLE_EXEMPT.has(kind)) {
      const last = this.lastPlayMs.get(kind);
      if (last !== undefined && atMs - last < THROTTLE_MS) {
        this.throttledCount += 1;
        return false;
      }
    }

    const ctx = this.ensureContext();
    if (!ctx || !this.master) {
      // 环境不支持 / 构造 AudioContext 失败：这是"播不了"，不是"被拦了"
      this.unsupportedCount += 1;
      return false;
    }

    // ---- 解锁与 blocked 判定（口径见文件头）----
    if (ctx.state === 'suspended') {
      try {
        // 异步解锁；这次不 await（play 是同步 API）。被挂起的上下文里 currentTime
        // 不前进，所以下面调度下去的音在解锁之后仍然会响。
        void ctx.resume().catch(() => undefined);
      } catch {
        /* 忽略：下面按状态判定 */
      }
      this.suspendedStreak += 1;
      if (this.suspendedStreak > 1) {
        this.blockedCount += 1;
        return false;
      }
    } else {
      this.suspendedStreak = 0;
      if (ctx.state === 'closed') {
        // 上下文被关掉了（dispose 之后又被调用？）：当成"播不了"，并丢掉这个死引用
        this.ctx = null;
        this.master = null;
        this.unsupportedCount += 1;
        return false;
      }
    }

    try {
      // ---- maxVoices：超过就停掉一个（撞击类之间先丢最弱的）----
      if (this.voices.length >= this.maxVoices) {
        const victim = this.pickVictim(kind, clamp01(intensity));
        if (!victim) {
          // 场上都是比它更响的撞击 → 这一次轻响忍了（丢弃，不算播放）
          this.throttledCount += 1;
          return false;
        }
        this.stopVoice(victim, ctx, true);
      }

      this.startVoice(ctx, this.master, entry, clamp01(intensity), atMs);
    } catch {
      // 极少数 WebView 的 AudioParam 实现会抛（比如把 0 传给指数斜坡）。
      // 一次合成失败只算"这一次没播成"，绝不能把物理主循环带崩。
      this.unsupportedCount += 1;
      return false;
    }

    this.playedCount += 1;
    this.lastPlayMs.set(kind, atMs);
    return true;
  }

  /** 懒创建 AudioContext + 主音量节点（第一次 play 时才建，避开 autoplay 警告） */
  private ensureContext(): AudioContext | null {
    if (this.disposed) return null;
    if (this.ctx && this.master) return this.ctx;

    const Ctor = getAudioContextCtor();
    if (!Ctor) return null;

    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.volumeFlag * MASTER_HEADROOM;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      return ctx;
    } catch {
      // 无痕模式 / 音频设备被占用：建不出来就如实当"不支持"
      this.ctx = null;
      this.master = null;
      return null;
    }
  }

  /**
   * 白噪声 buffer：**1 秒，只生成一次并复用**。
   * 每帧 new 一个 AudioBuffer 再填满随机数，在手机上就是每帧几百 KB 的垃圾，
   * 而且填充本身是同步的 48000 次循环 —— 绝对不能在帧循环里做。
   */
  private noiseBufferOf(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) channel[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
    return buffer;
  }

  /**
   * 合成并调度一个音。图结构：
   *
   * ```
   * 振荡器 ──▶ 音调增益 ┐
   *                     ├──▶ 低通滤波 ──▶ 包络增益 ──▶ 主音量 ──▶ 输出
   * 噪声源 ──▶ 噪声增益 ┘
   * ```
   *
   * 包络：极短 attack（1~6ms，避免"咔"的爆音） + 指数 decay 到 SILENT。
   */
  private startVoice(
    ctx: AudioContext,
    master: GainNode,
    entry: SoundSpec,
    intensity: number,
    atMs: number,
  ): void {
    const s = entry.spec;
    // 往后挪一点点：t0 === currentTime 时起始的 setValueAtTime 有被截掉的风险
    const t0 = ctx.currentTime + 0.005;
    const duration = clamp(s.duration, 0.02, 4);
    const peak = clamp(s.gain * this.volumeFlag * MASTER_HEADROOM * (0.35 + 0.65 * intensity), SILENT * 2, 1);
    // intensity 也调音高：越重越低（1 → 0.88 倍，0 → 1.12 倍）
    const pitch = 1.12 - 0.24 * intensity;
    const attack = Math.max(0.001, Math.min(0.006, duration * 0.2));

    // 包络增益
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(SILENT, t0);
    envelope.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    // 指数斜坡的 target 不能是 0（见 SILENT 的说明）
    envelope.gain.exponentialRampToValueAtTime(SILENT, t0 + duration);
    envelope.connect(master);

    // 低通滤波：频率下滑是"能量在衰减"的听感来源，比单纯改音量自然得多
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(safeFreq(s.filterFrom), t0);
    filter.frequency.exponentialRampToValueAtTime(safeFreq(s.filterTo), t0 + duration);
    filter.connect(envelope);

    const sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
    const stopAt = t0 + duration + 0.02;

    // 音调成分（wave === 'noise' 是纯噪声，不建振荡器）
    if (s.wave !== 'noise' && s.noiseMix < 1) {
      const osc = ctx.createOscillator();
      osc.type = s.wave;
      const from = safeFreq((s.freqFrom > 0 ? s.freqFrom : 200) * pitch);
      const to = safeFreq((s.freqTo > 0 ? s.freqTo : s.freqFrom > 0 ? s.freqFrom : 200) * pitch);
      osc.frequency.setValueAtTime(from, t0);
      osc.frequency.exponentialRampToValueAtTime(to, t0 + duration);
      const toneGain = ctx.createGain();
      toneGain.gain.value = 1 - s.noiseMix;
      osc.connect(toneGain);
      toneGain.connect(filter);
      osc.start(t0);
      osc.stop(stopAt);
      sources.push(osc);
    }

    // 噪声成分：摩擦/落水靠它，撞击的"啪"也有一半来自它
    const noiseAmount = s.wave === 'noise' ? 1 : s.noiseMix;
    if (noiseAmount > 0) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBufferOf(ctx);
      noise.loop = true; // 1 秒 buffer，靠 loop 覆盖 1.1 秒的倒塌
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = noiseAmount;
      noise.connect(noiseGain);
      noiseGain.connect(filter);
      noise.start(t0);
      noise.stop(stopAt);
      sources.push(noise);
    }

    const voice: ActiveVoice = { kind: entry.kind, intensity, startedAtMs: atMs, gain: envelope, sources };
    this.voices.push(voice);

    // 一个音只挂一个 onended（两个源是同时停的，挂两个会重复释放）。
    // onended 里把自己从活跃集合里摘掉 —— 这是 maxVoices 能长期正确的关键。
    const primary = sources[0];
    if (primary) {
      primary.onended = () => {
        this.releaseVoice(voice);
      };
    }
  }

  /**
   * 选被抢占的倒霉蛋。
   *
   * 默认规则：**停掉最早的一个**（对摩擦、马达这类持续音来说，"最早"就是最该让位的）。
   * 但撞击类之间按 `intensity` 排序：丢掉当前最弱的撞击，而不是最早的 ——
   * 否则"最后那一下大的"会被前面一堆碎响挤掉，玩家听不到重点。
   * 如果场上正在响的撞击都比新来的响，那这一次轻响就干脆不播（返回 null）。
   */
  private pickVictim(kind: PhysicsSoundKind, intensity: number): ActiveVoice | null {
    if (IMPACT_KINDS.has(kind)) {
      let weakest: ActiveVoice | null = null;
      for (const voice of this.voices) {
        if (!IMPACT_KINDS.has(voice.kind)) continue;
        if (weakest === null || voice.intensity < weakest.intensity) weakest = voice;
      }
      if (weakest) return weakest.intensity < intensity ? weakest : null;
      // 场上没有撞击音（都是摩擦/马达之类）→ 落到下面的默认规则
    }
    return this.voices.length > 0 ? this.voices[0] : null;
  }

  /** 停掉一个音（release 后从活跃集合移除） */
  private stopVoice(voice: ActiveVoice, ctx: AudioContext, immediate: boolean): void {
    const index = this.voices.indexOf(voice);
    if (index >= 0) this.voices.splice(index, 1);
    try {
      const t = ctx.currentTime;
      const release = immediate ? 0.008 : 0.03;
      const param = voice.gain.gain;
      param.cancelScheduledValues(t);
      // 撤掉原来的包络之后，用一个明确的当前值重新起一段短渐弱，避免"啪"的爆音
      param.setValueAtTime(Math.max(param.value, SILENT), t);
      param.exponentialRampToValueAtTime(SILENT, t + release);
      for (const source of voice.sources) {
        try {
          source.stop(t + release + 0.005);
        } catch {
          /* 已经停过 / 还没 start：忽略 */
        }
      }
    } catch {
      // 抢占是"尽力而为"：失败也只是多响了一小会儿，绝不能把这一帧打挂
    }
  }

  /** 从活跃集合摘掉（onended / 抢占后调用，重复调用是安全的） */
  private releaseVoice(voice: ActiveVoice): void {
    const index = this.voices.indexOf(voice);
    if (index < 0) return;
    this.voices.splice(index, 1);
    try {
      voice.gain.disconnect();
      for (const source of voice.sources) source.disconnect();
    } catch {
      /* 已经断开 */
    }
  }
}
