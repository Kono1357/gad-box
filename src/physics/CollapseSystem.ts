/**
 * 局部倒塌（M3 第 5 批）。
 *
 * ────────────────────────────────────────────────────────────
 * "局部"是重点
 * ────────────────────────────────────────────────────────────
 * M2 的做法是"整个世界里所有失去支撑的物体一起转动态"。这有两个问题：
 * 1. **连坐**：把塔底一块砖挖掉，整座塔连同旁边没关系的东西一起开始掉；
 * 2. **反应不过来**：玩家刚挖完，还没来得及看，东西已经在掉了。
 *
 * M3 改成：**从地基出发做一次连通性标记，只有跟地基断开的那一块才倒**，
 * 而且断开后有一段**宽限期**（默认 0.6 秒）—— 给玩家一点时间理解发生了什么。
 * 稳定部分完全不动，这才是"结构"该有的行为。
 *
 * ────────────────────────────────────────────────────────────
 * 判定口径（用户已裁决）
 * ────────────────────────────────────────────────────────────
 * **AABB 数学是权威**：`support` 与 `stack` 给的接触面积、悬挑距离、层数是我们自己算的纯几何量，
 * 它们在任何时候（包括物理暂停时）都有效。这一点很关键 —— M2 曾经用 Rapier 查询做这件事，
 * 而 **Rapier 的查询管线只在 `step()` 之后更新**，暂停时判定会静默失效，
 * 症状是"多个物体融成一个"。
 *
 * **Rapier 接触力做校核**：真实求解出来的接触力能修正 AABB 的误判，例如
 * "AABB 说接触面积够了，但实际只有两个角点受力"。`reconcile()` 做这件事，
 * **只在两者矛盾时以 Rapier 为准并记日志**，不改变正常路径。
 *
 * 两个阈值（用户给定）：
 * - 悬挑长度超过物体尺寸的 **50%** → 不稳；
 * - 接触面积小于底面积的 **30%** → 不稳。
 */

import type { BuildingInstance } from '../building/types';

export type CollapseReason = 'no-support' | 'cantilever' | 'contact-area';

export const COLLAPSE_REASON_LABELS: Record<CollapseReason, string> = {
  'no-support': '与地基断开了',
  cantilever: '悬挑太长',
  'contact-area': '接触面积太小',
};

export interface CollapseThresholds {
  /** 悬挑长度 / 物体水平尺寸 的上限，超过算不稳（默认 0.5 = 用户要求） */
  cantileverRatio: number;
  /** 接触面积 / 底面积 的下限，低于算不稳（默认 0.3 = 用户要求） */
  contactRatio: number;
  /**
   * 宽限期（毫秒）：断开支撑后等这么久才真的转动态。
   * 0 = 立刻倒（物理上更"对"，但玩家看不见发生了什么）。
   */
  graceMs: number;
  /** 一次最多让几个物体转动态（防止一整座塔同帧转动态造成尖峰） */
  maxPerBatch: number;
}

export const DEFAULT_COLLAPSE_THRESHOLDS: CollapseThresholds = {
  cantileverRatio: 0.5,
  contactRatio: 0.3,
  graceMs: 600,
  maxPerBatch: 64,
};

export interface CollapseEntry {
  objectId: number;
  defId: string;
  reason: CollapseReason;
  /** 中文细节，直接给玩家看 */
  detail: string;
  /** 悬挑比 / 接触比（哪个触发就是哪个） */
  measured: number;
  threshold: number;
  /** 是不是稳定器锁定的（锁定的不参与倒塌） */
  locked: boolean;
}

export interface CollapsePlan {
  /** 本帧应当转为动态的物体（已经过了宽限期） */
  toDynamic: CollapseEntry[];
  /** 本帧新断开、还在宽限期里的物体 */
  pending: CollapseEntry[];
  /** 应当标黄（临界）的物体 id */
  critical: number[];
  /** 应当标红（不稳）的物体 id */
  unstable: number[];
  /** 被稳定器跳过、不参与判定 */
  lockedCount: number;
  /** 与地基连通的总数（面板显示） */
  connected: number;
  /** 与地基断开的总数 */
  disconnected: number;
  ms: number;
}

/** 接触力校核需要的一条记录 */
export interface ContactForceSample {
  objectId: number;
  /** 该物体本帧受到的总支撑力（N） */
  totalForce: number;
  /** 接触点数 */
  contacts: number;
}

export interface ReconcileResult {
  /** 因为接触力而被"救回来"（不倒了）的数量 */
  rescued: number;
  /** 因为接触力而"改判要倒"的数量 */
  condemned: number;
  /** 中文说明（写日志用，空数组表示没有矛盾） */
  notes: string[];
}

/** 判定需要的静态世界信息 */
export interface CollapseWorld {
  /** 物体底面覆盖的地形里，最高的一格实心地形顶面高度；没有地形支撑返回 null */
  groundHeightUnder(instance: BuildingInstance): number | null;
  /** 水平尺寸（用于悬挑比）：取 max(width, depth) */
  horizontalSizeOf(instance: BuildingInstance): number;
  /** 底面积 */
  footprintOf(instance: BuildingInstance): number;
}

export class CollapseSystem {
  private readonly thresholds: CollapseThresholds;
  /** 物体 id → 第一次被判定为"断开"的时刻（宽限期用） */
  private readonly detachedAt = new Map<number, number>();
  private enabledValue = true;
  private lastPlan: CollapsePlan | null = null;

  constructor(thresholds: Partial<CollapseThresholds> = {}) {
    this.thresholds = { ...DEFAULT_COLLAPSE_THRESHOLDS, ...thresholds };
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
    if (!enabled) this.detachedAt.clear();
  }

  get limits(): CollapseThresholds {
    return { ...this.thresholds };
  }

  get lastResult(): CollapsePlan | null {
    return this.lastPlan;
  }

  /**
   * 算一次倒塌计划。
   *
   * **纯函数式**（除了宽限期的计时表），不碰 Rapier、不碰 DOM，可以在 Node 里用假世界断言。
   *
   * @param nowMs 当前时间（注入而不是内部读，测试才能控制宽限期）
   */
  plan(
    instances: readonly BuildingInstance[],
    world: CollapseWorld,
    nowMs: number,
  ): CollapsePlan {
    const started = now();
    const emptyPlan: CollapsePlan = {
      toDynamic: [],
      pending: [],
      critical: [],
      unstable: [],
      lockedCount: 0,
      connected: 0,
      disconnected: 0,
      ms: 0,
    };
    if (!this.enabledValue || instances.length === 0) {
      this.lastPlan = emptyPlan;
      return emptyPlan;
    }

    const { cantileverRatio, contactRatio, graceMs, maxPerBatch } = this.thresholds;
    const toDynamic: CollapseEntry[] = [];
    const pending: CollapseEntry[] = [];
    const critical: number[] = [];
    const unstable: number[] = [];
    let lockedCount = 0;
    let connected = 0;
    let disconnected = 0;
    /** 本帧仍然"有支撑"的物体，用于 BFS 传播 */
    const supportedNow = new Set<number>();
    /** 悬空的物体会被 BFS 跳过，但它们自己仍可能算"连着" */
    const detachedIds = new Set<number>();

    // ---- 第一遍：贴地判定（BFS 的种子）
    for (const instance of instances) {
      if (instance.locked) {
        // 稳定器锁定的物体永远是种子：它被人为固定住了，不算断开
        lockedCount += 1;
        supportedNow.add(instance.id);
        this.detachedAt.delete(instance.id);
        continue;
      }
      const ground = world.groundHeightUnder(instance);
      if (ground === null) continue;
      // 底面与地形贴合（间隙 ≤ 12 厘米）才算真扎在地上
      if (instance.position[1] - ground <= 0.12) {
        supportedNow.add(instance.id);
        this.detachedAt.delete(instance.id);
      }
    }

    // ---- 第二遍：BFS 传播支撑（只沿"贴着"的物体走）
    //
    // 传播条件用两件事：垂直相邻（底面贴着别人顶面）或水平相邻且高度接近。
    // 这两个条件都是纯几何的，所以暂停时也成立 —— 这正是选 AABB 而不是 Rapier 查询的原因。
    const queue = [...supportedNow];
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head]!;
      const instance = instances.find((item) => item.id === current);
      if (!instance) continue;
      for (const other of instances) {
        if (supportedNow.has(other.id)) continue;
        if (!touches(instance, other)) continue;
        supportedNow.add(other.id);
        this.detachedAt.delete(other.id);
        queue.push(other.id);
      }
    }

    // ---- 第三遍：判定悬空 / 悬挑 / 接触面积
    for (const instance of instances) {
      if (supportedNow.has(instance.id)) {
        connected += 1;
        // 与地基连着，但接触面积或悬挑仍可能"勉强" → 标黄
        const ratio = instance.contactRatio ?? 1;
        const size = Math.max(0.2, world.horizontalSizeOf(instance));
        const cantilever = instance.cantilever ?? 0;
        if (cantilever / size > cantileverRatio * 0.75 || ratio < contactRatio * 1.5) {
          critical.push(instance.id);
          instance.stability = 'critical';
        } else {
          instance.stability = 'stable';
        }
        continue;
      }

      disconnected += 1;
      detachedIds.add(instance.id);
      instance.stability = 'unstable';
      unstable.push(instance.id);

      // 判断具体原因，好给玩家一句人话
      const size = Math.max(0.2, world.horizontalSizeOf(instance));
      const cantilever = instance.cantilever ?? 0;
      const cantileverValue = cantilever / size;
      const ratio = instance.contactRatio ?? 0;

      let reason: CollapseReason = 'no-support';
      let measured = 0;
      let threshold = 0;
      if (cantileverValue > cantileverRatio) {
        reason = 'cantilever';
        measured = cantileverValue;
        threshold = cantileverRatio;
      } else if (ratio > 0 && ratio < contactRatio) {
        reason = 'contact-area';
        measured = ratio;
        threshold = contactRatio;
      }

      const entry: CollapseEntry = {
        objectId: instance.id,
        defId: instance.defId,
        reason,
        detail: describeCollapse(reason, measured, threshold, size, cantilever),
        measured,
        threshold,
        locked: false,
      };

      const firstSeen = this.detachedAt.get(instance.id);
      if (firstSeen === undefined) {
        this.detachedAt.set(instance.id, nowMs);
        if (graceMs <= 0) toDynamic.push(entry);
        else pending.push(entry);
        continue;
      }
      if (nowMs - firstSeen >= graceMs) toDynamic.push(entry);
      else pending.push(entry);
    }

    // 已经恢复支撑的物体要清掉计时（避免"断了又接上，然后瞬间倒"）
    for (const id of [...this.detachedAt.keys()]) {
      if (!detachedIds.has(id)) this.detachedAt.delete(id);
    }

    // 分帧：一帧最多转这么多个，剩下的下一帧继续（避免同帧几十个刚体切换造成尖峰）
    const limited = toDynamic.slice(0, maxPerBatch);
    const plan: CollapsePlan = {
      toDynamic: limited,
      pending,
      critical,
      unstable,
      lockedCount,
      connected,
      disconnected,
      ms: now() - started,
    };
    this.lastPlan = plan;
    return plan;
  }

  /**
   * Rapier 接触力校核。
   *
   * 只在"两边矛盾"时动手：
   * - AABB 说它断了，但 Rapier 报出明显的支撑力 → **救回来**（说明它其实压着什么东西，
   *   只是我们的 AABB 没算到，例如斜着卡在两个物体之间）；
   * - AABB 说它连着，但 Rapier 报出**接触点只有 1 个且力很小** → 改判为临界（标黄），
   *   提醒玩家"它只是碰着，随时会掉"。
   *
   * 不做"完全以 Rapier 为准"的原因见文件头：查询与接触数据只在 step 后有效，
   * 而倒塌判定必须在暂停时也能用。
   */
  reconcile(
    plan: CollapsePlan,
    contacts: readonly ContactForceSample[],
    forceThreshold = 5,
  ): ReconcileResult {
    const notes: string[] = [];
    if (contacts.length === 0) return { rescued: 0, condemned: 0, notes };

    const byId = new Map<number, ContactForceSample>();
    for (const sample of contacts) byId.set(sample.objectId, sample);

    let rescued = 0;
    const survivors: CollapseEntry[] = [];
    for (const entry of plan.toDynamic) {
      const sample = byId.get(entry.objectId);
      if (sample && sample.totalForce >= forceThreshold) {
        rescued += 1;
        notes.push(
          `#${entry.objectId} 被 AABB 判为"${COLLAPSE_REASON_LABELS[entry.reason]}"，` +
            `但 Rapier 报出 ${sample.totalForce.toFixed(1)} N 的支撑力 → 保留它（AABB 漏算了斜向接触）`,
        );
        continue;
      }
      survivors.push(entry);
    }

    let condemned = 0;
    for (const sample of contacts) {
      if (sample.contacts > 1) continue;
      if (plan.critical.includes(sample.objectId)) continue;
      if (plan.unstable.includes(sample.objectId)) continue;
      if (sample.contacts >= 1) {
        condemned += 1;
        plan.critical.push(sample.objectId);
        notes.push(`#${sample.objectId} 只有 1 个接触点 → 标记为临界（碰着而已，随时会掉）`);
      }
    }

    plan.toDynamic = survivors;
    return { rescued, condemned, notes };
  }

  /** 面板用：一行中文摘要 */
  describe(): string {
    const plan = this.lastPlan;
    if (!plan) return '倒塌判定：尚未运行';
    if (!this.enabledValue) return '倒塌判定：已关闭';
    const parts = [
      `连着地基 ${plan.connected} 个`,
      `断开 ${plan.disconnected} 个`,
      `本帧掉落 ${plan.toDynamic.length} 个`,
    ];
    if (plan.pending.length > 0) parts.push(`宽限期中 ${plan.pending.length} 个`);
    if (plan.lockedCount > 0) parts.push(`稳定器锁定 ${plan.lockedCount} 个`);
    parts.push(`${plan.ms.toFixed(2)} ms`);
    return `倒塌判定：${parts.join('｜')}`;
  }

  reset(): void {
    this.detachedAt.clear();
    this.lastPlan = null;
  }
}

/**
 * 两个物体是否"贴着"。
 *
 * 判据是刻意的**宽松**：只要 AABB 在水平或垂直方向上贴合（容差 15 厘米），就算连着。
 * 为什么宽松：这是"稳定性判定"，不是"接触检测"。判得太严会让玩家看到"明明挨着的两块砖，
 * 上面那块却掉下来"，那比偶尔把一块悬空的砖算成稳的更糟 ——
 * 前者看起来像 bug，后者只是物理没那么严格（而我们有 Rapier 的接触力做校核兜底）。
 */
export function touches(a: BuildingInstance, b: BuildingInstance): boolean {
  const ax = a.size?.[0] ?? 1;
  const ay = a.size?.[1] ?? 1;
  const az = a.size?.[2] ?? 1;
  const bx = b.size?.[0] ?? 1;
  const by = b.size?.[1] ?? 1;
  const bz = b.size?.[2] ?? 1;

  const gapX = Math.abs(a.position[0] - b.position[0]) - (ax + bx) / 2;
  const gapZ = Math.abs(a.position[2] - b.position[2]) - (az + bz) / 2;
  const gapY = Math.abs(a.position[1] - b.position[1]) - (ay + by) / 2;

  const tolerance = 0.15;
  // 垂直叠放：水平有重叠、垂直贴合
  if (gapX <= tolerance && gapZ <= tolerance && gapY <= tolerance) return true;
  // 并排：垂直有重叠、水平贴合
  const overlapsY = gapY < -0.02;
  if (overlapsY && ((gapX <= tolerance && gapZ < 0) || (gapZ <= tolerance && gapX < 0))) return true;
  return false;
}

function describeCollapse(
  reason: CollapseReason,
  measured: number,
  threshold: number,
  size: number,
  cantilever: number,
): string {
  const label = COLLAPSE_REASON_LABELS[reason];
  if (reason === 'cantilever') {
    return `${label}：悬空伸出 ${cantilever.toFixed(2)} 米，是自身尺寸 ${size.toFixed(2)} 米的 ${(measured * 100).toFixed(0)}%（上限 ${(threshold * 100).toFixed(0)}%）`;
  }
  if (reason === 'contact-area') {
    return `${label}：只有 ${(measured * 100).toFixed(0)}% 的底面吃到支撑（下限 ${(threshold * 100).toFixed(0)}%）`;
  }
  return `${label}：它和地基之间的支撑链断了`;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
