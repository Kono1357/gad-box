/**
 * 世界加载器（问题 4.1 / 4.4 / 4.5 + 补充 3）。
 *
 * 换一张地图在 M1.5 里是**同步一坨**：解析 → 生成地形 → 种树 → 摆建筑 → 建物理体，
 * 全部在一个事件回调里跑完。大世界档要几百毫秒，浏览器在这期间**一帧都画不出来**，
 * 玩家看到的是「点完之后界面死住一下」。
 *
 * 这个模块把换图拆成**有名字、有权重的阶段**，每个阶段之间让出一帧（`requestAnimationFrame`）
 * 给浏览器画进度条，于是「卡住一下」变成「看得见的进度」。
 *
 * 同时它承担两件容易做错的事：
 * - **顺序保证**：卸载必须在加载之前全部完成，加载必须在重建之前完成，任何一环抛错都要
 *   留下一份可读的报告，而不是把页面丢在半死状态。
 * - **淡入淡出**：换图前把画面淡到黑、换完再淡回来（补充 3），这样即使中间有 1~2 帧的
 *   空白也不会闪。淡变由 `LoadingOverlay` 负责，这里只负责在正确的时机通知它。
 */

/** 一个加载阶段 */
export interface LoadStage {
  /** 稳定 id（日志 / 断言用） */
  id: string;
  /** 中文名，显示在进度条下面 */
  label: string;
  /** 权重，用于算总进度；默认 1 */
  weight?: number;
  /** 这一步做什么。可以是同步的，也可以返回 Promise。 */
  run: () => void | Promise<void>;
}

/** 一个阶段的结果 */
export interface LoadStageResult {
  id: string;
  label: string;
  ok: boolean;
  ms: number;
  /** 阶段里可以顺手报一句人类可读的说明 */
  detail?: string;
}

export interface LoadReport {
  label: string;
  stages: LoadStageResult[];
  ok: boolean;
  /** 第一个失败的阶段 id；全成功时 undefined */
  failedStage?: string;
  error?: string;
  ms: number;
  summary: string;
}

export interface WorldLoaderHandlers {
  /** 进度回调（0..1），阶段开始时与结束各触发一次；阶段内部报子进度时也会触发 */
  onProgress?(progress: number, stage: LoadStage, index: number): void;
  /** 阶段内部的子进度（补充给进度条的细粒度说明），例如「建筑规划 5/9」 */
  onSubProgress?(fraction: number, detail: string, stage: LoadStage, index: number): void;
  /** 阶段结束回调，可用来往日志里追加一行 */
  onStageDone?(result: LoadStageResult): void;
  /** 全部结束后触发（无论成败） */
  onFinished?(report: LoadReport): void;
}

export interface LoadPlan {
  /** 人类可读的名字，例如「山谷村落」 */
  label: string;
  stages: readonly LoadStage[];
}

/** 阶段之间的让帧：给浏览器一次绘制机会，进度条才能真的动起来 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

export class WorldLoader {
  private running = false;
  private currentProgress = 0;
  private currentStage = '';
  private readonly history: LoadReport[] = [];

  /**
   * 当前阶段的「基准权重」与「自身权重」。
   *
   * 为什么需要它们：M4 之前一个阶段就是一个整块（0% 或 100%），
   * 而 9 阶段地图生成里「地形」「自然物」「建筑」「小物品」各占几百毫秒，
   * 进度条会长时间停在同一个百分比上。`reportSubProgress` 让阶段内部
   * 把自己的细粒度进度折算进总进度，于是进度条是连续走的。
   */
  private baseWeight = 0;
  private stageWeight = 1;
  private totalWeight = 1;
  private stageIndex = 0;
  private currentSubDetail = '';
  /**
   * 当前阶段的完整 LoadStage。
   * 单独存一份是因为 `run` 是必填字段，而报子进度时手上只有 `id`/`label` —— 
   * 现场造一个缺 `run` 的对象会让类型不成立（这是好事：LoadStage 本来就不是"只有名字"的东西）。
   */
  private currentStageRef: LoadStage = { id: '', label: '', run: () => {} };

  constructor(private readonly handlers: WorldLoaderHandlers = {}) {}

  get isLoading(): boolean {
    return this.running;
  }

  /** 0..1 */
  get progress(): number {
    return this.currentProgress;
  }

  /** 当前阶段的中文名 */
  get stageLabel(): string {
    return this.currentStage;
  }

  /** 当前阶段内部的细粒度说明（没有子进度时为空串） */
  get stageDetail(): string {
    return this.currentSubDetail;
  }

  /**
   * 阶段内部报到总进度里。
   *
   * `fraction` 会先 clamp 到 0..1 —— 一个阶段报出 1.2 会让总进度超过 100%，
   * 那比不报进度更糟（进度条会弹回去）。
   * 不在加载中调用时直接忽略，不抛异常：调用方常常是异步回调，
   * 阶段可能早已结束（例如玩家中途又点了换图）。
   */
  reportSubProgress(fraction: number, detail = ''): void {
    if (!this.running) return;
    const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    this.currentProgress = (this.baseWeight + clamped * this.stageWeight) / this.totalWeight;
    if (detail) this.currentSubDetail = detail;
    this.handlers.onProgress?.(this.currentProgress, this.currentStageRef, this.stageIndex);
    this.handlers.onSubProgress?.(clamped, detail, this.currentStageRef, this.stageIndex);
  }

  get reports(): readonly LoadReport[] {
    return this.history;
  }

  /**
   * 顺序执行一个计划。
   *
   * 关键行为：**任何一个阶段抛错都会停止后续阶段**（半加载的世界比旧世界更危险），
   * 并把失败阶段如实返回。调用方（Engine）拿到 `ok: false` 后应当提示玩家并保持
   * 「已卸载」状态而不是装作无事发生。
   */
  async run(plan: LoadPlan): Promise<LoadReport> {
    if (this.running) {
      const busy: LoadReport = {
        label: plan.label,
        stages: [],
        ok: false,
        error: '上一轮加载还没结束',
        ms: 0,
        summary: '已有加载在进行中，本次请求被忽略',
      };
      return busy;
    }

    this.running = true;
    const started = now();
    const results: LoadStageResult[] = [];
    const totalWeight = plan.stages.reduce((sum, stage) => sum + (stage.weight ?? 1), 0) || 1;
    this.totalWeight = totalWeight;
    let doneWeight = 0;
    let failedStage: string | undefined;
    let errorText: string | undefined;

    try {
      for (let index = 0; index < plan.stages.length; index += 1) {
        const stage = plan.stages[index]!;
        this.currentStage = stage.label;
        this.stageIndex = index;
        this.baseWeight = doneWeight;
        this.stageWeight = stage.weight ?? 1;
        this.currentStageRef = stage;
        this.currentSubDetail = '';
        this.currentProgress = doneWeight / totalWeight;
        this.handlers.onProgress?.(this.currentProgress, stage, index);

        const stageStart = now();
        let ok = true;
        let detail: string | undefined;
        try {
          const value = stage.run();
          if (value && typeof (value as Promise<void>).then === 'function') await value;
        } catch (error) {
          ok = false;
          failedStage = stage.id;
          errorText = error instanceof Error ? error.message : String(error);
          detail = `失败：${errorText}`;
        }

        const result: LoadStageResult = { id: stage.id, label: stage.label, ok, ms: now() - stageStart, detail };
        results.push(result);
        this.handlers.onStageDone?.(result);

        if (!ok) {
          // 失败也要把进度推完，否则进度条会停在中间让人以为还活着
          doneWeight = totalWeight;
          this.currentProgress = 1;
          break;
        }

        doneWeight += stage.weight ?? 1;
        this.currentProgress = doneWeight / totalWeight;
        // 阶段之间让出一帧：进度条要真的画出来
        await nextFrame();
      }
    } finally {
      this.running = false;
      this.currentStage = '';
      if (this.currentProgress >= 1) this.currentProgress = 1;
    }

    const ms = now() - started;
    const ok = failedStage === undefined;
    const report: LoadReport = {
      label: plan.label,
      stages: results,
      ok,
      failedStage,
      error: errorText,
      ms,
      summary: ok
        ? `「${plan.label}」加载完成：${results.length} 个阶段 / ${ms.toFixed(0)} ms`
        : `「${plan.label}」在「${results.find((r) => r.id === failedStage)?.label ?? failedStage}」阶段失败：${errorText}`,
    };

    this.history.push(report);
    while (this.history.length > 10) this.history.shift();
    this.handlers.onFinished?.(report);
    return report;
  }

  /** 换世界时重置进度（淡出阶段用） */
  reset(): void {
    if (this.running) return;
    this.currentProgress = 0;
    this.currentStage = '';
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * 把「卸载清单」包成一个阶段，让卸载也出现在进度条里。
 *
 * 之所以不把卸载放在加载阶段之前单独跑：玩家点「换地图」到新地图出现之间，
 * 卸载是必经的一道，它也要花时间（大世界几十毫秒），必须一起进进度条。
 */
export function unloadStage(label: string, run: () => string, weight = 1): LoadStage {
  return { id: 'unload', label, weight, run: () => { void run(); } };
}
