/**
 * 物理爆炸保护（补充 6）：**找出出问题的那一个物体，冻住它，并如实告诉玩家。**
 *
 * ## 为什么需要它
 *
 * Rapier 在极端情况下会"穿模后被弹飞"：一个箱子挤进地形里，求解器为了把它推出来
 * 给了一个荒谬的速度，于是下一帧它已经在几十米外，再下一帧它撞上城堡，整座建筑
 * 像被炸开。玩家看到的不是"我的塔搭得不对"，而是"这游戏有 bug" —— 而实际上链式
 * 崩塌本身是对的，错的是**第一个物体的那一帧数据**。
 *
 * 所以这里做的是**兜底，不是修复**：
 * - 只冻结**那一个**物体（`GuardReport.freeze` 交给 Engine 去切 fixed/static 并归零速度），
 *   不让异常通过碰撞往外扩散；
 * - 每一次判定的实测值 / 阈值 / 帧号都记进日志，面板上能说清"是什么、什么时候、超了多少"；
 * - 玩家可以手动解冻（`clear()`）—— 有时候"飞出去"的正是他想看的场面。
 *
 * ## 为什么阈值必须按尺寸缩放
 *
 * 用绝对米数做阈值是错的：同一个 2 米阈值，对 0.5 米的木箱意味着"允许瞬移 4 个身位"，
 * 对 8 米的城堡却意味着"稍微滑一下就算异常"。所以三条阈值都乘上物体尺寸：
 * - 位移：`尺寸 × positionJumpFactor`（一帧走了几倍身位）
 * - 速度：`尺寸 × velocityFactor`（每秒走几倍身位）
 * - 角速度：**绝对值**（转多快和大小无关：0.5 米的箱子和 8 米的塔转 60 rad/s 都是疯了）
 *
 * ## 纯逻辑、零依赖
 *
 * 不 import Rapier / Three.js / DOM，不读全局时钟（时间由调用方通过 `nowMs` 传进来），
 * 不用 `Math.random()`。所以这个文件可以在 Node 里直接单测，而"真的动手冻结"那一步
 * 留给 Engine —— 本类只负责**判断 + 记账**。
 */

/** 三维向量（与项目其它纯逻辑模块保持一致的形状） */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 一个物体的采样（由 Engine 每帧喂进来） */
export interface BodySample {
  handle: number;
  ownerId: number;
  position: Vec3;
  velocity: Vec3;
  angularVelocity: Vec3;
  /** 物体尺寸（米），用于按尺寸而不是绝对值定阈值 */
  size: number;
}

export interface GuardLimits {
  /** 单帧位移超过「尺寸 × 这个倍数」判为跳变 */
  positionJumpFactor: number;
  /** 速度超过「尺寸 × 这个倍数（每秒）」判为超速 */
  velocityFactor: number;
  /** 角速度上限（rad/s），绝对值 */
  maxAngularVelocity: number;
  /** 连续异常多少帧后才真的冻结（避免一次抖动就冻） */
  framesBeforeFreeze: number;
  /** 同一物体被冻结后的解冻冷却（毫秒） */
  unfreezeCooldownMs: number;
}

/**
 * 默认阈值。每一个数字的理由都写在这里，避免以后有人"凭感觉调参"把保护调成噪音：
 *
 * - `positionJumpFactor = 4`：60Hz 下一帧的正常位移是 `速度/60`。一个以 10 m/s 下落的
 *   0.5 米箱子一帧走 0.17 米，而阈值是 `0.5 × 4 = 2` 米 —— 相当于要 120 m/s 才会误报。
 *   真正的"弹飞"是几十米，远超 4 个身位。留 4 倍是给"大物体被冲量推走 / 快速滚动"这类
 *   合法情况的余量；再小就会误伤爆炸场面。
 * - `velocityFactor = 40`：每秒 40 倍身位。0.5 米的箱子 = 20 m/s（自由落体 20 米才有
 *   这个速度），8 米的城堡 = 320 m/s。本项目没有火箭和爆炸推进器，正常玩法到不了；
 *   到了就说明求解器已经发散。
 * - `maxAngularVelocity = 60`：约 9.5 圈/秒。真实滚动的箱子一般不到 20 rad/s，
 *   60 只有求解器在互相打架时才会出现。
 * - `framesBeforeFreeze = 3`：单帧异常可能只是接触求解的正常抖动（相邻两帧位置来回
 *   跳一点点很常见），**连续 3 帧**才是真的失控。3 帧 @60Hz = 50ms，玩家感觉不到延迟，
 *   但足够把偶然抖动滤掉。
 * - `unfreezeCooldownMs = 3000`：同一物体 3 秒内只记一条日志。一个发散的刚体是**每帧**
 *   都违规的：60 帧/秒 × 3 秒 = 180 条，日志和面板都会被刷爆，真正有价值的那条反而看不见。
 */
export const DEFAULT_GUARD_LIMITS: GuardLimits = {
  positionJumpFactor: 4,
  velocityFactor: 40,
  maxAngularVelocity: 60,
  framesBeforeFreeze: 3,
  unfreezeCooldownMs: 3000,
};

export type GuardReason = 'position-jump' | 'velocity' | 'angular-velocity' | 'non-finite';

/** 原因 → 中文短语（面板 / 日志 / 弹提示共用，避免三处各写一份文案） */
export const GUARD_REASON_LABELS: Record<GuardReason, string> = {
  'position-jump': '单帧位置跳变',
  velocity: '速度失控',
  'angular-velocity': '转速失控',
  'non-finite': '数值损坏（NaN / Infinity）',
};

export interface GuardViolation {
  handle: number;
  ownerId: number;
  reason: GuardReason;
  /** 实测值（位移米 / 速度 m/s / 角速度 rad/s） */
  measured: number;
  /** 阈值 */
  threshold: number;
  frame: number;
  atMs: number;
  /** 中文说明（日志与提示直接用） */
  detail: string;
}

export interface GuardReport {
  /** 本次要冻结的物体（Engine 负责真的切 fixed/static 并归零速度） */
  freeze: { handle: number; reason: GuardReason; detail: string }[];
  /** 本次新增的违规记录 */
  violations: GuardViolation[];
  /** 连续异常计数（还没到冻结阈值）的物体数 */
  pending: number;
}

/**
 * 日志上限。
 *
 * 用「数组 + 丢弃最旧」而不是下标环形：违规是**稀疏事件**（不是每帧都发生），
 * 200 次 `shift()` 的成本可以忽略，换来的是 `log()` 的倒序读取不需要做环形下标换算
 * —— 少一处能算错的地方。真正需要环形的场景（每帧都写）在 PhysicsRecorder 里。
 */
export const GUARD_LOG_LIMIT = 200;

/** 尺寸兜底：采样里没给尺寸（0 / NaN / 负数）时按 1 米算，绝不拿 0 当阈值 */
const FALLBACK_SIZE = 1;

/** 多久没被采样过就把状态丢掉（帧数）：句柄会被 Rapier 回收，状态不能无限留着 */
const STALE_TICKS = 300;

/** 每个物体的追踪状态 */
interface BodyState {
  /** 上一帧的位置（用于算跳变）；null = 还没有基准 */
  prev: Vec3 | null;
  /** 上一次被采样到的内部帧号（用于判断"是不是连续帧"） */
  lastSeenTick: number;
  /** 连续异常帧数 */
  consecutive: number;
  /** 是否已经被冻结（冻结只上报一次，幂等） */
  frozen: boolean;
  /** 上一次真的写进日志的时间；冷却判据 */
  lastLogMs: number;
}

/**
 * 物理爆炸保护。
 *
 * 用法（Engine 每帧）：
 * ```ts
 * const report = guard.update(samples, nowMs);
 * for (const item of report.freeze) {
 *   physics.freezeBody(item.handle);      // 切 fixed 并归零速度
 *   toast(`#${item.handle} 数值异常，已冻结：${item.detail}`);
 * }
 * ```
 */
export class PhysicsGuard {
  private limitsValue: GuardLimits;
  private enabledFlag = true;
  private readonly states = new Map<number, BodyState>();
  /** 违规日志（时间正序，末尾最新） */
  private readonly violations: GuardViolation[] = [];
  /** 内部帧号：只在 update() 里 +1，用来算跳变和老化 */
  private tick = 0;
  private scannedCount = 0;
  /** 累计冻结次数（同一物体解冻后再冻会再算一次） */
  private frozenCount = 0;
  /**
   * 累计违规**次数**：每一次判定命中都算，包括被冷却压掉、没写进日志的那些。
   *
   * 口径和 `log().length` 刻意不同：日志是"去重后给玩家看的最近 200 条"，
   * 而这个数是"到底抖了多少次"。一个发散的刚体 3 秒能抖 180 次，但日志只有 1 条 ——
   * 面板上两个数都显示，玩家才知道"只报了一条"不等于"只错了一次"。
   */
  private violationCount = 0;

  constructor(limits: Partial<GuardLimits> = {}) {
    this.limitsValue = { ...DEFAULT_GUARD_LIMITS };
    this.setLimits(limits);
  }

  /** 当前阈值（返回副本：调用方改了不该反过来污染保护逻辑） */
  get limits(): GuardLimits {
    return { ...this.limitsValue };
  }

  /** 改阈值。非法值（NaN / 负数 / 0）一律忽略，保留原值 —— 宁可不动，也不要一个 0 阈值 */
  setLimits(patch: Partial<GuardLimits>): void {
    const next: GuardLimits = { ...this.limitsValue };
    if (patch.positionJumpFactor !== undefined) {
      next.positionJumpFactor = positive(patch.positionJumpFactor, next.positionJumpFactor);
    }
    if (patch.velocityFactor !== undefined) {
      next.velocityFactor = positive(patch.velocityFactor, next.velocityFactor);
    }
    if (patch.maxAngularVelocity !== undefined) {
      next.maxAngularVelocity = positive(patch.maxAngularVelocity, next.maxAngularVelocity);
    }
    if (patch.framesBeforeFreeze !== undefined) {
      // 至少 1 帧：0 会让"立即冻结一切"变成默认行为
      next.framesBeforeFreeze = Math.max(1, Math.round(positive(patch.framesBeforeFreeze, next.framesBeforeFreeze)));
    }
    if (patch.unfreezeCooldownMs !== undefined) {
      // 冷却允许是 0（= 每次都记日志），但不允许负数 / NaN
      const value = patch.unfreezeCooldownMs;
      next.unfreezeCooldownMs = Number.isFinite(value) && value >= 0 ? value : next.unfreezeCooldownMs;
    }
    this.limitsValue = next;
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(enabled: boolean): void {
    this.enabledFlag = enabled;
  }

  /**
   * 每帧调用一次，喂入本帧所有动态刚体的采样。
   *
   * 关掉时直接返回空报告并且**不计 scanned** —— 面板上的"扫过多少采样"必须反映
   * 真实的工作量，关掉了还涨数字就是骗人。
   */
  update(samples: readonly BodySample[], nowMs: number): GuardReport {
    const report: GuardReport = { freeze: [], violations: [], pending: 0 };
    if (!this.enabledFlag) return report;

    const atMs = Number.isFinite(nowMs) ? nowMs : 0;
    this.tick += 1;
    const limits = this.limitsValue;

    for (const sample of samples) {
      this.scannedCount += 1;

      // 没有句柄的采样没法冻结、也没法记账（handle 是唯一的身份），直接跳过。
      // 不"顺手修一个"句柄出来：猜出来的身份比没有身份更危险。
      if (!Number.isFinite(sample.handle)) continue;
      const handle = sample.handle;

      let state = this.states.get(handle);
      if (!state) {
        state = { prev: null, lastSeenTick: 0, consecutive: 0, frozen: false, lastLogMs: Number.NEGATIVE_INFINITY };
        this.states.set(handle, state);
      }

      const size = safeSize(sample.size);
      const violation = this.detect(sample, state, size, atMs);

      if (violation) {
        // 违规次数先记上：每一次判定命中都算，与"有没有写进日志"无关
        this.violationCount += 1;

        // 冷却期内**不重复记录**（一个发散刚体是每帧都违规的，不拦就是 60 条/秒），
        // 但计数与冻结判定照旧 —— 冷却只影响日志，不影响保护本身。
        if (atMs - state.lastLogMs >= limits.unfreezeCooldownMs) {
          state.lastLogMs = atMs;
          this.record(violation);
          report.violations.push(violation);
        }

        state.consecutive += 1;
        // non-finite 是唯一"不等帧数"的情况：这种数据一旦进 Rapier 会让整个世界崩掉
        if (violation.reason === 'non-finite') state.consecutive = limits.framesBeforeFreeze;

        if (!state.frozen && state.consecutive >= limits.framesBeforeFreeze) {
          state.frozen = true;
          this.frozenCount += 1;
          report.freeze.push({ handle, reason: violation.reason, detail: violation.detail });
        }
      } else {
        state.consecutive = 0;
      }

      state.prev = cloneVec(sample.position);
      state.lastSeenTick = this.tick;
    }

    // 只在冻结阈值边缘的（还没冻的）物体数 —— 面板上"正在抖动的物体"就是这个数
    for (const state of this.states.values()) {
      if (!state.frozen && state.consecutive > 0 && state.lastSeenTick === this.tick) report.pending += 1;
    }

    this.pruneStale();
    return report;
  }

  /**
   * 玩家手动解冻某个物体（清掉它的违规计数）。
   *
   * 位置基准（`prev`）也一起清掉：解冻往往伴随引擎把物体摆回原位 / 传送到别处，
   * 那一帧的位移是**人为的**，不该被算成跳变（否则玩家一点解冻就又立刻被冻上）。
   * 冷却时间戳刻意**保留**，理由同上：免得"冻 → 解冻 → 马上又冻"把日志刷爆。
   *
   * @returns 是否确实有这么一个被追踪的物体
   */
  clear(handle: number): boolean {
    const state = this.states.get(handle);
    if (!state) return false;
    state.prev = null;
    state.lastSeenTick = 0;
    state.consecutive = 0;
    state.frozen = false;
    return true;
  }

  /** 全部清空（换地图时）：日志、状态、计数一起归零 */
  reset(): void {
    this.states.clear();
    this.violations.length = 0;
    this.tick = 0;
    this.scannedCount = 0;
    this.frozenCount = 0;
    this.violationCount = 0;
  }

  /** 异常日志（最多保留 N 条，按时间倒序取：最新的在前） */
  log(limit = GUARD_LOG_LIMIT): readonly GuardViolation[] {
    const wanted = Math.max(0, Math.min(Math.floor(Number.isFinite(limit) ? limit : GUARD_LOG_LIMIT), this.violations.length));
    if (wanted === 0) return [];
    // 倒序：面板要的是"最近发生了什么"，不是按时间正序从头看
    return this.violations.slice(this.violations.length - wanted).reverse();
  }

  /**
   * 统计：扫过多少采样、冻了多少次、违规多少次、当前冻结着几个。
   * 注意 `violations` 是**次数**（含冷却期没写进日志的），通常大于 `log().length`。
   */
  get stats(): { scanned: number; frozen: number; violations: number; frozenNow: number } {
    let frozenNow = 0;
    for (const state of this.states.values()) if (state.frozen) frozenNow += 1;
    return {
      scanned: this.scannedCount,
      frozen: this.frozenCount,
      violations: this.violationCount,
      frozenNow,
    };
  }

  /** 面板用：一行中文摘要 */
  describe(): string {
    if (!this.enabledFlag) {
      return '物理爆炸保护：已关闭（异常物体不会被自动冻结，飞出去的东西要自己删）';
    }
    const snapshot = this.stats;
    const last = this.violations.length > 0 ? this.violations[this.violations.length - 1] : null;
    const tail = last ? `｜最近一次：${last.detail}` : '';
    return (
      `物理爆炸保护：启用｜扫过 ${snapshot.scanned} 个采样｜` +
      `冻结 ${snapshot.frozen} 次（当前 ${snapshot.frozenNow} 个）｜` +
      `违规 ${snapshot.violations} 次（日志留 ${this.violations.length} 条）${tail}`
    );
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 判一个采样有没有问题。四项检查按"严重程度"排序，返回**第一个**命中的：
   * 数值损坏 > 位置跳变 > 超速 > 转速失控。
   *
   * 只报第一个而不是全报：一个 NaN 的物体同时"速度也是 NaN"，报四条只是噪音。
   */
  private detect(sample: BodySample, state: BodyState, size: number, atMs: number): GuardViolation | null {
    const limits = this.limitsValue;
    const { handle, ownerId, position, velocity, angularVelocity } = sample;
    const frame = this.tick;

    // 1) 数值损坏：位置 / 速度 / 角速度里任何一个不是有限数就立即冻结。
    //    measured / threshold 记 0：NaN 写进日志会让导出的 JSON 直接坏掉，
    //    而"实测值"在这里本来就无从谈起（数据已经不可比了）。
    if (!isFiniteVec(position) || !isFiniteVec(velocity) || !isFiniteVec(angularVelocity)) {
      return {
        handle,
        ownerId,
        reason: 'non-finite',
        measured: 0,
        threshold: 0,
        frame,
        atMs,
        detail: `刚体 #${handle}（对象 ${ownerId}）的位置或速度里出现了 NaN / Infinity，已立即冻结（这种数据进 Rapier 会让整个世界崩掉）`,
      };
    }

    // 2) 位置跳变：只有"上一帧也见过它"时才能算位移。
    //    中间断过帧（物体是新生成的 / 被引擎瞬移过）就跳过这一项 —— 那种位移是人为的。
    if (state.prev && state.lastSeenTick === frame - 1) {
      const dist = distance(state.prev, position);
      const threshold = size * limits.positionJumpFactor;
      if (dist > threshold) {
        return {
          handle,
          ownerId,
          reason: 'position-jump',
          measured: dist,
          threshold,
          frame,
          atMs,
          detail:
            `刚体 #${handle}（对象 ${ownerId}）一帧移动了 ${dist.toFixed(2)} 米，` +
            `超过阈值 ${threshold.toFixed(2)} 米（尺寸 ${size.toFixed(2)} 米 × ${limits.positionJumpFactor}）`,
        };
      }
    }

    // 3) 超速
    const speed = length(velocity);
    const speedThreshold = size * limits.velocityFactor;
    if (speed > speedThreshold) {
      return {
        handle,
        ownerId,
        reason: 'velocity',
        measured: speed,
        threshold: speedThreshold,
        frame,
        atMs,
        detail:
          `刚体 #${handle}（对象 ${ownerId}）速度 ${speed.toFixed(1)} m/s，` +
          `超过阈值 ${speedThreshold.toFixed(1)} m/s（尺寸 ${size.toFixed(2)} 米 × ${limits.velocityFactor}）`,
      };
    }

    // 4) 转速失控（绝对值：和尺寸无关）
    const spin = length(angularVelocity);
    if (spin > limits.maxAngularVelocity) {
      return {
        handle,
        ownerId,
        reason: 'angular-velocity',
        measured: spin,
        threshold: limits.maxAngularVelocity,
        frame,
        atMs,
        detail:
          `刚体 #${handle}（对象 ${ownerId}）角速度 ${spin.toFixed(1)} rad/s，` +
          `超过上限 ${limits.maxAngularVelocity} rad/s`,
      };
    }

    return null;
  }

  /** 写日志 + 维护 200 条上限（丢最旧的）。次数统计不在这里，见 update() */
  private record(violation: GuardViolation): void {
    this.violations.push(violation);
    while (this.violations.length > GUARD_LOG_LIMIT) this.violations.shift();
  }

  /**
   * 老化清理：长时间没被采样、且当前没被冻结的物体，状态直接丢掉。
   *
   * 必须做的原因不是内存（一个状态几十字节），而是**句柄会被 Rapier 回收**：
   * 玩家删掉一片箱子之后，同一个 handle 可能被一个新物体拿到，留着旧状态就会
   * 拿"上辈子的位置"当基准，一帧就误判成跳变。所以宁可丢掉基准重新开始。
   */
  private pruneStale(): void {
    if (this.tick % STALE_TICKS !== 0) return;
    for (const [handle, state] of this.states) {
      if (state.frozen) continue;
      if (this.tick - state.lastSeenTick > STALE_TICKS) this.states.delete(handle);
    }
  }
}

// ---------------------------------------------------------------- 小工具（纯函数）

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 尺寸兜底：拿不到有效尺寸就按 1 米算，绝不返回 0（0 会让阈值恒为 0，冻掉一切） */
function safeSize(size: number): number {
  return Number.isFinite(size) && size > 0 ? size : FALLBACK_SIZE;
}

function isFiniteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** 采样里的位置是调用方的对象，复制一份，免得它下一帧原地改数把基准也改了 */
function cloneVec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function distance(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}
