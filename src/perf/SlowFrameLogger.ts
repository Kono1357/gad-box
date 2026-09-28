/**
 * 慢帧记录（src/perf 模块 2/5）。
 *
 * ────────────────────────────────────────────────────────────
 * 它和 FrameProfiler 的分工
 * ────────────────────────────────────────────────────────────
 * FrameProfiler 回答的是"最近两秒的分布长什么样"（统计视角，会被新帧冲掉）；
 * SlowFrameLogger 回答的是"**刚才那几次卡顿到底发生在什么时候、当时世界里有什么**"
 * （事件视角，耐久保留，能导出成文本让玩家贴进问题反馈）。
 *
 * 两者是互补的：直方图能看出"有尖峰"，但看不出尖峰对应的是一次爆炸、
 * 还是一次地形生成；慢帧记录带着当时的最慢阶段与区块/刚体数，
 * 才能让人按着记录去复现。
 *
 * ────────────────────────────────────────────────────────────
 * 两个刻意的设计
 * ────────────────────────────────────────────────────────────
 * 1. **去重不丢信息**。同一个原因（同一个最慢阶段）在 dedupeMs 内只留一条，
 *    但那一条上会累加 `repeat` 计数。否则连续 30 帧都在卡的时候，
 *    玩家只会看到"一条慢帧"，以为没事——而实际上那是持续性的问题。
 *    去重窗口从**首次记录的时刻**算起（不是从上次重复算起）：
 *    如果按"安静期"算，一个持续存在的问题会在记录一次之后彻底消失不见。
 *
 * 2. **阈值/开关都可以随时改**，因为面板上有滑块和开关。
 *    `enabled=false` 时每帧调用它是完全空转的（先判开关再算阶段），
 *    所以调用方不必在外部再包一层判断。
 *
 * 纯逻辑、零依赖：不 import three / Rapier / Engine，可以直接在 Node 里断言。
 */

export interface SlowFrameRecord {
  index: number;
  ms: number;
  /** 超出预算多少毫秒 */
  over: number;
  /** 这一帧最慢的阶段（用来直接回答"是谁慢"） */
  worstPhase?: { name: string; ms: number };
  context?: string;
  atMs: number;
  /** 当时的世界概况（区块数 / 刚体数 / 物体数），便于复现 */
  world?: { chunks?: number; bodies?: number; objects?: number };
  /**
   * 同一原因在去重窗口内重复出现的次数（≥1，只有累加到 2 以上才显示）。
   * 有了它，"1 条记录"才不会把"连续卡了 30 帧"说成"偶尔卡一下"。
   */
  repeat?: number;
}

export interface SlowFrameLoggerOptions {
  /** 慢帧阈值（毫秒），默认 16.7 */
  thresholdMs?: number;
  /** 最多保留多少条，默认 100（环形） */
  capacity?: number;
  /** 同一"原因"多少毫秒内不重复记（避免刷屏），默认 500 */
  dedupeMs?: number;
}

/** 没有上报阶段的帧，去重/聚合时统一归到这一档 */
const NO_PHASE = '(无阶段)';

export class SlowFrameLogger {
  private thresholdValue: number;
  private readonly capacityValue: number;
  private readonly dedupeMsValue: number;
  private enabledValue = true;

  // ── 环形缓冲：定长数组 + 写指针（同 FrameProfiler，不用 shift） ──
  private readonly ring: SlowFrameRecord[];
  /** 与 ring 平行的去重键；淘汰时必须一并删掉 map 里的键，否则计数会累加到看不见的记录上 */
  private readonly keys: (string | undefined)[];
  private head = 0;
  private retained = 0;
  /** 累计写入的记录条数（去重后；已被容量淘汰的仍计入），clear() 时清零 */
  private totalCount = 0;
  /** 去重索引：键 → 当前仍保留的那条记录 */
  private readonly lastByKey = new Map<string, SlowFrameRecord>();

  constructor(options: SlowFrameLoggerOptions = {}) {
    this.thresholdValue = options.thresholdMs && options.thresholdMs > 0 ? options.thresholdMs : 16.7;
    this.capacityValue = Math.max(1, Math.floor(options.capacity ?? 100));
    this.dedupeMsValue = Math.max(0, options.dedupeMs ?? 500);
    this.ring = new Array<SlowFrameRecord>(this.capacityValue);
    this.keys = new Array<string | undefined>(this.capacityValue).fill(undefined);
  }

  get thresholdMs(): number {
    return this.thresholdValue;
  }

  setThreshold(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.thresholdValue = ms;
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
  }

  /** 保留容量 */
  get capacity(): number {
    return this.capacityValue;
  }

  /** 当前保留的条数（≤ capacity） */
  get count(): number {
    return this.retained;
  }

  /**
   * 每帧调用；超过阈值才记录。返回是否记下了。
   *
   * 返回值语义：**只要这次慢帧被"看见"了就返回 true** ——
   * 新建一条是真，撞上去重、计数 +1 也是真（信息确实进了日志）；
   * 只有"没超阈值 / 开关关掉"才返回 false。
   */
  record(
    frame: {
      index: number;
      ms: number;
      phases?: Record<string, number>;
      context?: string;
      world?: SlowFrameRecord['world'];
    },
    nowMs: number,
  ): boolean {
    if (!this.enabledValue) return false;
    const ms = frame.ms;
    if (!Number.isFinite(ms) || ms <= this.thresholdValue) return false;

    const worstPhase = worstOf(frame.phases);
    // 去重键只取"最慢阶段"：同一个阶段就是同一个根因，
    // 场景（context）不同不改根因，所以不进键，只跟着记录一起存下来。
    const key = worstPhase ? worstPhase.name : NO_PHASE;

    const existing = this.lastByKey.get(key);
    if (existing && nowMs - existing.atMs <= this.dedupeMsValue) {
      existing.repeat = (existing.repeat ?? 1) + 1;
      return true;
    }

    const record: SlowFrameRecord = {
      index: frame.index,
      ms,
      over: ms - this.thresholdValue,
      atMs: nowMs,
      repeat: 1,
    };
    if (worstPhase) record.worstPhase = worstPhase;
    if (frame.context !== undefined) record.context = frame.context;
    if (frame.world) record.world = frame.world;

    this.push(record, key);
    this.totalCount += 1;
    return true;
  }

  /** 写入环形缓冲，必要时淘汰最旧的一条（并把它从去重索引里摘掉） */
  private push(record: SlowFrameRecord, key: string): void {
    const slot = this.head;
    const evictedKey = this.keys[slot];
    if (evictedKey !== undefined && this.lastByKey.get(evictedKey) === this.ring[slot]) {
      this.lastByKey.delete(evictedKey);
    }
    this.ring[slot] = record;
    this.keys[slot] = key;
    this.lastByKey.set(key, record);
    this.head = (this.head + 1) % this.capacityValue;
    if (this.retained < this.capacityValue) this.retained += 1;
  }

  /** 最近的记录（新的在前） */
  recent(count = this.retained): SlowFrameRecord[] {
    const wanted = Math.max(0, Math.min(Math.floor(count), this.retained));
    const out: SlowFrameRecord[] = new Array(wanted);
    for (let i = 0; i < wanted; i += 1) {
      const slot = (this.head - 1 - i + this.capacityValue * 2) % this.capacityValue;
      out[i] = this.ring[slot]!;
    }
    return out;
  }

  /**
   * 按"最慢阶段"聚合：哪种操作最容易造成慢帧。
   *
   * `count` 是**实际发生次数**（把 repeat 一起算进去），不是记录条数 ——
   * 我们想知道的是"物理求解导致了 12 次卡顿"，而不是"有 3 条记录提到物理"。
   * `averageMs` 同理按发生次数加权。
   */
  byWorstPhase(): { phase: string; count: number; averageMs: number }[] {
    const counts = new Map<string, number>();
    const sums = new Map<string, number>();
    for (let i = 0; i < this.retained; i += 1) {
      const slot = (this.head - 1 - i + this.capacityValue * 2) % this.capacityValue;
      const record = this.ring[slot]!;
      const phase = record.worstPhase ? record.worstPhase.name : NO_PHASE;
      const repeat = Math.max(1, record.repeat ?? 1);
      counts.set(phase, (counts.get(phase) ?? 0) + repeat);
      sums.set(phase, (sums.get(phase) ?? 0) + record.ms * repeat);
    }
    const out: { phase: string; count: number; averageMs: number }[] = [];
    for (const [phase, count] of counts) {
      out.push({ phase, count, averageMs: (sums.get(phase) ?? 0) / Math.max(1, count) });
    }
    out.sort((a, b) => b.count - a.count || b.averageMs - a.averageMs);
    return out;
  }

  get total(): number {
    return this.totalCount;
  }

  clear(): void {
    // 先把长度截到 0 再撑回 capacity：等于用一个定长数组装回"全空"，
    // 又不必往里面塞一个假记录（塞假记录会让"槽位为空"和"槽位有一条真记录"分不清）。
    this.ring.length = 0;
    this.ring.length = this.capacityValue;
    this.keys.fill(undefined);
    this.lastByKey.clear();
    this.head = 0;
    this.retained = 0;
    this.totalCount = 0;
  }

  /** 导出成 JSON（生成日志/问题反馈用）；记录按新的在前，与 recent() 一致 */
  export(): { thresholdMs: number; total: number; records: SlowFrameRecord[] } {
    return {
      thresholdMs: this.thresholdValue,
      total: this.totalCount,
      records: this.recent(this.retained),
    };
  }

  /** 面板用：一行中文摘要 */
  describe(): string {
    if (!this.enabledValue) return `慢帧记录：已关闭（阈值 ${this.thresholdValue.toFixed(1)} ms）`;
    if (this.totalCount === 0) return `慢帧记录：暂无（阈值 ${this.thresholdValue.toFixed(1)} ms）`;
    const byPhase = this.byWorstPhase();
    const top = byPhase.length > 0 ? byPhase[0]! : null;
    const kept = this.retained < this.totalCount ? `保留最近 ${this.retained} 条` : `保留 ${this.retained} 条`;
    const repeats = this.recent(this.retained).reduce((sum, r) => sum + Math.max(1, r.repeat ?? 1), 0);
    return (
      `慢帧记录：共 ${this.totalCount} 条（${kept}，阈值 ${this.thresholdValue.toFixed(1)} ms）｜` +
      `累计发生 ${repeats} 次` +
      (top ? `｜最常出现在「${top.phase}」（${top.count} 次，均 ${top.averageMs.toFixed(1)} ms）` : '')
    );
  }
}

/** 找出阶段列表里最慢的那个；没有 phases 或全为非有限值时返回 null */
function worstOf(phases: Record<string, number> | undefined): { name: string; ms: number } | null {
  if (!phases) return null;
  let best: { name: string; ms: number } | null = null;
  for (const name of Object.keys(phases)) {
    const ms = phases[name]!;
    if (!Number.isFinite(ms)) continue;
    if (!best || ms > best.ms) best = { name, ms };
  }
  return best;
}
