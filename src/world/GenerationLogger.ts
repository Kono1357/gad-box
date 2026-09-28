/**
 * 生成日志（M4 第 5 批）。
 *
 * 一次世界生成会产生几十上百条"做了什么"的信息：每个阶段的耗时、种了多少棵树、
 * 修掉了多少冲突、哪几步退化了密度……如果只在控制台 `console.log` 一遍，
 * 玩家遇到"这张图怎么这么空"时**没有任何可查证的线索**。
 *
 * 所以这个模块做三件事：
 * 1. **结构化记录**（阶段 + 计数 + 备注），而不是散落的字符串；
 * 2. **可导出**（JSON），玩家可以把它贴给我，我就能复现他那次生成；
 * 3. **如实记录失败与降级** —— 尤其是"某个阶段重试了几次、把密度降到了多少"，
 *    这类信息最容易被漏掉，而它恰恰是"地图看起来不对"的根因。
 *
 * 设计上刻意**不 import 任何东西**（连 `performance` 都不直接用，时间由调用方传入），
 * 这样它能在 Node 里被完整断言。
 */

export type GenerationStageId =
  | 'heightmap'
  | 'water'
  | 'sand'
  | 'surface'
  | 'nature'
  | 'planning'
  | 'buildings'
  | 'items'
  | 'conflicts';

export const STAGE_LABELS: Record<GenerationStageId, string> = {
  heightmap: '高度图生成',
  water: '水体填充',
  sand: '沙地生成',
  surface: '地表材质分配',
  nature: '自然物体生成',
  planning: '建筑规划',
  buildings: '建筑生成',
  items: '小物品生成',
  conflicts: '冲突检测与修复',
};

/** 一个阶段的记录 */
export interface StageRecord {
  id: GenerationStageId;
  label: string;
  /** 耗时（毫秒） */
  ms: number;
  /** 创建了多少物体 */
  created: number;
  /** 删掉了多少（含被冲突修复删掉的） */
  removed: number;
  /** 挪动了多少 */
  moved: number;
  /** 发现多少冲突 */
  conflicts: number;
  /** 修掉多少冲突 */
  resolved: number;
  /** 修不掉的冲突 */
  unresolved: number;
  /** 失败原因（中文）；成功时为 undefined */
  error?: string;
  /** 备注（中文）。用于记录"因为密度太高重试了 2 次"这类信息 */
  note?: string;
  /**
   * 这一步是不是与别的阶段**共用同一次遍历**。
   *
   * 诚实性字段：`water` / `sand` / `surface` 三个阶段在地形那一趟遍历里一起完成，
   * 它们的耗时无法单独拆开。与其把总耗时随便摊到三个头上（那是编数字），
   * 不如标出来"共用"，让看日志的人知道这三个数字是同一次遍历的。
   */
  sharedPass?: boolean;
}

/** 一次完整生成的日志 */
export interface GenerationLog {
  /** 世界种子 */
  seed: number;
  /** 世界尺寸描述（例如「标准 96×24×96」） */
  sizeLabel: string;
  /** 用了哪套参数（生成参数可调，日志要记下来才能复现） */
  paramsSummary: string;
  stages: StageRecord[];
  /** 总耗时（毫秒） */
  totalTime: number;
  /** 最终物体总数（含自然物/建筑/物品） */
  totalObjects: number;
  /** 各阶段耗时之和（用来对比总耗时，差值就是"阶段之间"的开销） */
  stageTime: number;
  /** 有没有阶段失败过 */
  hasFailure: boolean;
  /** 有没有降级过密度 */
  degraded: boolean;
  /** 结束时间戳（毫秒，调用方给的真实时钟） */
  finishedAtMs: number;
  /** 生成器版本（格式变了要能看出来，便于以后兼容日志） */
  version: 1;
}

export interface GenerationLoggerOptions {
  seed: number;
  sizeLabel: string;
  paramsSummary?: string;
}

export class GenerationLogger {
  private readonly stages: StageRecord[] = [];
  private readonly seed: number;
  private readonly sizeLabel: string;
  private readonly paramsSummary: string;
  /** 正在记录的阶段（用于跨阶段累计"创建了多少"） */
  private openStage: { id: GenerationStageId; startedAt: number } | null = null;

  constructor(options: GenerationLoggerOptions) {
    this.seed = options.seed;
    this.sizeLabel = options.sizeLabel;
    this.paramsSummary = options.paramsSummary ?? '';
  }

  /** 开始一个阶段（重复调用会先结束上一个未结束的阶段） */
  begin(id: GenerationStageId, nowMs: number): void {
    if (this.openStage) this.end(nowMs, { note: '（上一个阶段没有显式结束，已自动收尾）' });
    this.openStage = { id, startedAt: nowMs };
  }

  /** 结束当前阶段并记录 */
  end(nowMs: number, counts: Partial<Omit<StageRecord, 'id' | 'label' | 'ms'>> = {}): StageRecord | null {
    const open = this.openStage;
    if (!open) return null;
    this.openStage = null;
    const record: StageRecord = {
      id: open.id,
      label: STAGE_LABELS[open.id],
      ms: Math.max(0, nowMs - open.startedAt),
      created: counts.created ?? 0,
      removed: counts.removed ?? 0,
      moved: counts.moved ?? 0,
      conflicts: counts.conflicts ?? 0,
      resolved: counts.resolved ?? 0,
      unresolved: counts.unresolved ?? 0,
      error: counts.error,
      note: counts.note,
      sharedPass: counts.sharedPass,
    };
    this.stages.push(record);
    return record;
  }

  /**
   * 记一个"共用遍历"的阶段。
   *
   * 用于 `water` / `sand` / `surface`：它们与 `heightmap` 在同一个循环里完成，
   * 单独计时会得到三个近乎为 0 的假数字。所以它们的 `ms` 记 0 并标 `sharedPass: true`，
   * 真实耗时算在 `heightmap` 那一步里。
   */
  recordShared(id: GenerationStageId, counts: Partial<StageRecord> = {}): StageRecord {
    const record: StageRecord = {
      id,
      label: STAGE_LABELS[id],
      ms: 0,
      created: counts.created ?? 0,
      removed: counts.removed ?? 0,
      moved: counts.moved ?? 0,
      conflicts: counts.conflicts ?? 0,
      resolved: counts.resolved ?? 0,
      unresolved: counts.unresolved ?? 0,
      note: counts.note ?? '与高度图共用同一次遍历，耗时算在高度图那一步',
      sharedPass: true,
    };
    this.stages.push(record);
    return record;
  }

  /**
   * 往**已有**阶段上累加计数，而不是新开一个阶段。
   *
   * 为什么需要它：建筑规划之后还有"第二遍自然物剔除"—— 把落在新圈出的地块里的
   * 树删掉。第一版我给这一步也 `begin('planning')/end()`，于是日志里出现**两条**
   * "建筑规划"，而且第二条写死 `removed: 0`（实际删掉的树一个都没记上）。
   * 那是两处错：阶段数从 9 变成 10（"9 阶段流水线"这个说法就不成立了），
   * 以及**数字是假的** —— 玩家看到"删了 0 个"会以为一棵树都没被清掉。
   *
   * 所以：删除数累加进规划阶段那一条，耗时也算在规划里（它本来就是规划的一部分）。
   */
  addCounts(
    id: GenerationStageId,
    counts: Partial<Pick<StageRecord, 'created' | 'removed' | 'moved' | 'conflicts' | 'resolved' | 'unresolved'>>,
  ): void {
    const record = this.stages.find((item) => item.id === id);
    if (!record) {
      // 阶段还没记录过：先补一条 0 耗时的记录，并说明为什么它是空的，
      // 而不是静默丢掉这几个数字
      this.stages.push({
        id,
        label: STAGE_LABELS[id],
        ms: 0,
        created: counts.created ?? 0,
        removed: counts.removed ?? 0,
        moved: counts.moved ?? 0,
        conflicts: counts.conflicts ?? 0,
        resolved: counts.resolved ?? 0,
        unresolved: counts.unresolved ?? 0,
        note: '这条记录是在阶段结束后补的（计数来自后续步骤），耗时无从归属故记 0',
      });
      return;
    }
    record.created += counts.created ?? 0;
    record.removed += counts.removed ?? 0;
    record.moved += counts.moved ?? 0;
    record.conflicts += counts.conflicts ?? 0;
    record.resolved += counts.resolved ?? 0;
    record.unresolved += counts.unresolved ?? 0;
  }

  /** 补一条纯备注（不算阶段，例如"因为冲突太多把树密度降到了 0.6"） */
  note(stageId: GenerationStageId, text: string): void {
    const record = this.stages.find((item) => item.id === stageId);
    if (record) {
      record.note = record.note ? `${record.note}；${text}` : text;
    } else {
      // 阶段还没记录：临时挂在一个"未命名"阶段上会让人困惑，所以直接追加一条 0 耗时的备注阶段
      this.stages.push({
        id: stageId,
        label: STAGE_LABELS[stageId],
        ms: 0,
        created: 0,
        removed: 0,
        moved: 0,
        conflicts: 0,
        resolved: 0,
        unresolved: 0,
        note: text,
      });
    }
  }

  /** 汇总成最终日志 */
  finish(nowMs: number, totalObjects: number): GenerationLog {
    if (this.openStage) this.end(nowMs);
    const stageTime = this.stages.reduce((sum, stage) => sum + stage.ms, 0);
    return {
      seed: this.seed,
      sizeLabel: this.sizeLabel,
      paramsSummary: this.paramsSummary,
      stages: [...this.stages],
      // 总耗时用第一个阶段开始的时间无法得知（logger 不持有它），所以由调用方传入的
      // nowMs 减去"阶段耗时之和"会得到错误的数 —— 这里如实把 totalTime 记为阶段耗时之和，
      // 并在字段注释里说明它与墙钟时间的差别
      totalTime: stageTime,
      stageTime,
      totalObjects,
      hasFailure: this.stages.some((stage) => stage.error !== undefined),
      degraded: this.stages.some((stage) => (stage.note ?? '').includes('降')),
      finishedAtMs: nowMs,
      version: 1,
    };
  }

  get records(): readonly StageRecord[] {
    return this.stages;
  }

  /** 控制台逐行打印（诊断用） */
  toConsoleLines(log: GenerationLog): string[] {
    const lines = [
      `[生成] ${log.sizeLabel}｜种子 ${log.seed}｜阶段耗时合计 ${log.stageTime.toFixed(0)} ms｜最终 ${log.totalObjects} 个物体`,
    ];
    if (log.paramsSummary) lines.push(`[生成] 参数：${log.paramsSummary}`);
    for (const stage of log.stages) {
      const counts: string[] = [];
      if (stage.created > 0) counts.push(`新建 ${stage.created}`);
      if (stage.removed > 0) counts.push(`删除 ${stage.removed}`);
      if (stage.moved > 0) counts.push(`移动 ${stage.moved}`);
      if (stage.conflicts > 0) counts.push(`冲突 ${stage.conflicts}`);
      if (stage.resolved > 0) counts.push(`修复 ${stage.resolved}`);
      if (stage.unresolved > 0) counts.push(`未解决 ${stage.unresolved}`);
      lines.push(
        `[生成] ${stage.sharedPass ? '↔' : '·'} ${stage.label}：${stage.ms.toFixed(0)} ms` +
          (counts.length > 0 ? `｜${counts.join(' ')}` : '') +
          (stage.note ? `｜${stage.note}` : '') +
          (stage.error ? `｜✗ ${stage.error}` : ''),
      );
    }
    return lines;
  }

  reset(): void {
    this.stages.length = 0;
    this.openStage = null;
  }
}

/** 可导出成 JSON 的日志（与 `GenerationLog` 相同，单独一个函数是为了强调"可以直接 JSON.stringify"） */
export function exportGenerationLog(log: GenerationLog): string {
  return JSON.stringify(log, null, 2);
}

/** 面板用：一行中文摘要 */
export function describeGenerationLog(log: GenerationLog): string {
  const failed = log.stages.filter((stage) => stage.error !== undefined).length;
  return (
    `${log.sizeLabel}｜${log.stages.length} 个阶段｜${log.stageTime.toFixed(0)} ms｜` +
    `${log.totalObjects} 个物体` +
    (failed > 0 ? `｜⚠ ${failed} 个阶段失败` : '') +
    (log.degraded ? '｜已降级密度' : '')
  );
}
