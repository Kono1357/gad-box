import type { BuildingInstance } from '../building/types';

/**
 * 连续堆叠工具（补充 3）。
 *
 * 用法：按住 **Shift** 放置，放下一个之后不清空选择、继续按同一个模型往上叠；
 * `Esc` 或面板上的「停止」结束这一轮。
 *
 * 与撤销的配合是这里唯一需要想清楚的地方（补充 3.7）：
 * - `merge`（默认）：整轮连续堆叠**合并成一步撤销** —— 玩家心里"这是一次操作"；
 * - `each`：每放一个都是一步 —— 适合想逐步微调的情况。
 * 合并的做法是等这一轮结束时，把过程中收集到的实例一次性交给 CommandManager，
 * 而不是每放一个就 push 一次。
 */
export class QuickStackTool {
  private active = false;
  private instances: BuildingInstance[] = [];
  private startedAt = 0;

  constructor(private mergeIntoOneStep = true) {}

  get isActive(): boolean {
    return this.active;
  }

  get count(): number {
    return this.instances.length;
  }

  get elapsedMs(): number {
    return this.active ? performance.now() - this.startedAt : 0;
  }

  setMergeIntoOneStep(merge: boolean): void {
    this.mergeIntoOneStep = merge;
  }

  get mergesIntoOneStep(): boolean {
    return this.mergeIntoOneStep;
  }

  /** 开始一轮（第一次按 Shift 放置时调用） */
  begin(): void {
    if (this.active) return;
    this.active = true;
    this.instances = [];
    this.startedAt = performance.now();
  }

  /** 记录一个刚放下的物体 */
  record(instance: BuildingInstance): void {
    if (!this.active) this.begin();
    // 避免重复登记同一个实例（比如中途撤销又重做）
    if (!this.instances.some((existing) => existing.id === instance.id)) {
      this.instances.push(instance);
    }
  }

  /**
   * 结束这一轮，返回需要一次性登记到历史的实例集合。
   * @returns 需要合并登记的实例；'each' 模式或只有 1 个时返回空数组
   */
  finish(): BuildingInstance[] {
    if (!this.active) return [];
    const collected = this.mergeIntoOneStep && this.instances.length > 1 ? [...this.instances] : [];
    this.active = false;
    this.instances = [];
    this.startedAt = 0;
    return collected;
  }

  /** 中止这一轮（不登记合并命令，让引擎按 `each` 语义处理） */
  cancel(): void {
    this.active = false;
    this.instances = [];
    this.startedAt = 0;
  }

  /** 这一轮里放下的所有实例（引擎需要在 Esc 时知道放了什么） */
  get placed(): readonly BuildingInstance[] {
    return this.instances;
  }
}
