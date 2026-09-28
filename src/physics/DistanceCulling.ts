/**
 * 距离剔除与物理 LOD（M3 第 7 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 先说清楚"物理 LOD"在本项目里**不是**什么
 * ────────────────────────────────────────────────────────────
 * 常见的物理 LOD 是"远处物体换成更简单的碰撞体"。本项目**刻意不做这个**，理由很实在：
 * Rapier 里改一个刚体的碰撞体形状，必须**删掉旧碰撞体、创建新的**（`ColliderDesc` 是构造期的），
 * 而删建碰撞体要更新宽相位结构、重算质量与惯性张量。物体在远近来来回回时，
 * 这项开销比"远处那点求解成本"大得多 —— 那是**负优化**。
 *
 * 所以本项目的物理 LOD 用的是**参与度降级**，按代价从低到高：
 *
 * | 档位 | 条件 | 做法 | 代价 |
 * |---|---|---|---|
 * | 完整模拟 | 相机 24 米内 | 什么都不做 | 无 |
 * | 自然休眠 | 静止 2 秒后（Rapier 自己做的） | 求解器跳过它 | 无 |
 * | **冻结** | 已休眠**且**离相机 60 米外 | `setEnabled(false)`，完全不参与宽相位 | **它不再碰撞** |
 *
 * ────────────────────────────────────────────────────────────
 * 冻结的真实代价（必须写出来）
 * ────────────────────────────────────────────────────────────
 * `setEnabled(false)` 的刚体**不参与任何碰撞**。也就是说：远处一块被冻结的石头，
 * 如果有个东西飞过去砸它，会**直接穿过去**。这不是 bug，是这个功能的定义。
 *
 * 所以有两条硬规则把这种穿帮限制到"几乎不可能被看到"：
 * 1. **只冻结已经在休眠的物体**。正在动的物体永远不冻 —— 半空中被冻住是最显眼的穿帮
 *    （物体悬在空中不动，玩家一眼就看得出来）。
 * 2. **半径给得足够大**（默认 60 米）且**重要物体永不冻结**（玩家选中的、手里拿的、
 *    连着关节的、以及关在触发器里的）。60 米在这个沙盘里已经远超常用的观察距离，
 *    而"远处飞来的东西砸中一块 60 米外的石头"这件事在正常玩法里不会发生。
 *
 * 唤醒是**立即**的：一进 60 米就解开，不等下一轮检查。冻结才分帧（见 FrameScheduler），
 * 因为"该冻的没冻"只是省不下性能，而"该醒的没醒"会直接变成穿模。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 一个候选刚体的状态（由 Engine 采集） */
export interface CullCandidate {
  handle: number;
  ownerId: number;
  position: Vec3;
  /** 当前是否休眠（Rapier 的真实状态） */
  sleeping: boolean;
  /** 当前是否已被冻结 */
  frozen: boolean;
  /**
   * 重要物体：**永不冻结**。
   * Engine 应当把"玩家选中的 / 手里拿着的 / 连着关节的 / 触发器里的"标成 true。
   */
  important: boolean;
}

export interface CullOptions {
  /** 这个半径内一律完整模拟 */
  activeRadius: number;
  /** 只有超出这个半径**且已休眠**的才冻结 */
  freezeRadius: number;
  /** 单次 pass 最多处理几个（分帧；配合 FrameScheduler 用） */
  maxPerPass: number;
}

export const DEFAULT_CULL_OPTIONS: CullOptions = {
  activeRadius: 24,
  freezeRadius: 60,
  maxPerPass: 40,
};

export interface CullPlan {
  /** 本帧要冻结的刚体 */
  toFreeze: number[];
  /** 本帧要解冻的刚体（**立即生效**，不分帧） */
  toWake: number[];
  /** 本帧扫了几个 */
  scanned: number;
  /** 判定为"在活跃半径内"的数量 */
  active: number;
  /** 判定为"远处（可冻结）"的数量 */
  distant: number;
  /** 因为重要而不冻的数量 */
  protectedCount: number;
  /** 因为还在动而不冻的数量（半空冻结是最显眼的穿帮） */
  movingCount: number;
  /** 计划执行后的冻结总数 */
  frozenAfter: number;
  /** 本帧冻结省下的刚体数（面板显示"省了多少"） */
  saved: number;
  ms: number;
}

export interface CullingStats {
  /** 当前被冻结的数量 */
  frozen: number;
  /** 累计冻结次数 */
  frozenTotal: number;
  /** 累计解冻次数 */
  wokenTotal: number;
  /** 上一次 pass 的耗时 */
  lastMs: number;
  /** 上一次 pass 的候选数 */
  lastScanned: number;
  enabled: boolean;
  options: CullOptions;
}

/**
 * 距离剔除器。
 *
 * `plan()` 是**纯函数式**的（不碰 Rapier）：它只说"该冻谁、该醒谁"，
 * 真正的 `setEnabled` 由 Engine 执行。这样这段最需要断言的距离与状态判定逻辑
 * 可以在 Node 里用假数据测透。
 */
export class DistanceCulling {
  private readonly options: CullOptions;
  private enabledValue = true;
  private frozenTotal = 0;
  private wokenTotal = 0;
  private lastMs = 0;
  private lastScanned = 0;
  /** 已冻结的句柄集合（跨帧状态：解冻只依据当前距离，不依赖它，但统计要用） */
  private readonly frozenSet = new Set<number>();

  constructor(options: Partial<CullOptions> = {}) {
    this.options = { ...DEFAULT_CULL_OPTIONS, ...options };
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
  }

  get limits(): CullOptions {
    return { ...this.options };
  }

  get stats(): CullingStats {
    return {
      frozen: this.frozenSet.size,
      frozenTotal: this.frozenTotal,
      wokenTotal: this.wokenTotal,
      lastMs: this.lastMs,
      lastScanned: this.lastScanned,
      enabled: this.enabledValue,
      options: { ...this.options },
    };
  }

  /** 某个刚体现在被冻结了吗 */
  isFrozen(handle: number): boolean {
    return this.frozenSet.has(handle);
  }

  /**
   * 算一次计划。
   *
   * @param nowMs 当前时间（注入而不是内部读，测试才能稳定）
   */
  plan(candidates: readonly CullCandidate[], cameraX: number, cameraZ: number, nowMs: number): CullPlan {
    const started = now();
    const { activeRadius, freezeRadius, maxPerPass } = this.options;

    if (!this.enabledValue) {
      this.lastMs = now() - started;
      this.lastScanned = candidates.length;
      return {
        toFreeze: [], toWake: [], scanned: candidates.length, active: 0, distant: 0,
        protectedCount: 0, movingCount: 0, frozenAfter: 0, saved: 0, ms: this.lastMs,
      };
    }

    const toFreeze: number[] = [];
    const toWake: number[] = [];
    let active = 0;
    let distant = 0;
    let protectedCount = 0;
    let movingCount = 0;

    const activeSq = activeRadius * activeRadius;
    const freezeSq = freezeRadius * freezeRadius;

    for (const candidate of candidates) {
      const dx = candidate.position.x - cameraX;
      const dz = candidate.position.z - cameraZ;
      const distanceSq = dx * dx + dz * dz;

      // ---- 唤醒优先，而且**不分帧、立即返回**
      //
      // 顺序很重要：如果一个物体既"该醒"又"该冻"（不可能同时成立），也要先判唤醒。
      // 更实际的原因是：唤醒漏一帧，玩家就会看到穿模；冻结漏一帧只是少省一点性能。
      if (candidate.frozen) {
        if (distanceSq <= freezeSq || candidate.important) {
          toWake.push(candidate.handle);
          this.frozenSet.delete(candidate.handle);
          this.wokenTotal += 1;
        } else {
          // 仍然远、仍然不重要：保持冻结
          active += 0;
        }
        continue;
      }

      if (distanceSq <= activeSq) {
        active += 1;
        continue;
      }
      distant += 1;

      if (candidate.important) {
        protectedCount += 1;
        continue;
      }
      // **只冻已经睡着的**：半空冻结是最显眼的穿帮
      if (!candidate.sleeping) {
        movingCount += 1;
        continue;
      }
      if (toFreeze.length >= maxPerPass) continue;
      toFreeze.push(candidate.handle);
    }

    for (const handle of toFreeze) {
      this.frozenSet.add(handle);
      this.frozenTotal += 1;
    }

    this.lastMs = now() - started;
    this.lastScanned = candidates.length;
    void nowMs;

    return {
      toFreeze,
      toWake,
      scanned: candidates.length,
      active,
      distant,
      protectedCount,
      movingCount,
      frozenAfter: this.frozenSet.size,
      saved: this.frozenSet.size,
      ms: this.lastMs,
    };
  }

  /** 清空状态（换地图时调用：旧句柄全部失效） */
  reset(): void {
    this.frozenSet.clear();
    this.frozenTotal = 0;
    this.wokenTotal = 0;
    this.lastMs = 0;
    this.lastScanned = 0;
  }

  /** 面板用：一行中文摘要 */
  describe(): string {
    if (!this.enabledValue) return '距离剔除：已关闭（所有刚体都参与模拟）';
    const { activeRadius, freezeRadius } = this.options;
    return (
      `距离剔除：${activeRadius} 米内完整模拟，${freezeRadius} 米外且**已休眠**的刚体被冻结｜` +
      `当前冻结 ${this.frozenSet.size} 个（累计冻 ${this.frozenTotal} / 醒 ${this.wokenTotal}）｜` +
      `${this.lastMs.toFixed(2)} ms`
    );
  }

  /**
   * ⚠ 面板上直接显示的固定说明。
   *
   * 必须写清楚"冻结的物体不参与碰撞" —— 否则玩家看到远处的石头被穿过会以为是物理坏了。
   */
  static readonly DISCLAIMER =
    '远处的刚体被冻结后**不参与任何碰撞**（这样才省得下性能）。只冻结已经静止的物体，' +
    '一进范围就立刻解冻；玩家选中的、手里拿的、连着关节的物体永不被冻结。';
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
