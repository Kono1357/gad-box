/**
 * 流体编辑工具（M4 第二部分 · 第 2 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 全部通过"上帝视角的笔刷"操作
 * ────────────────────────────────────────────────────────────
 * 这个项目没有第一人称实体，所有交互都是"光标位置 + 笔刷半径"。
 * 所以流体工具的输入只有两样：**笔刷中心（世界坐标）** 和 **笔刷半径**，
 * 加上一个"按住了/点了一下"的开关。这样它和地形笔刷的手感是一致的。
 *
 * 六个工具：
 * - `pour`（泼水）：点一下生成一批（按住会连续，但内部有节流，见 `TICK_MS`）
 * - `drain`（抽水）：移除笔刷范围内的粒子
 * - `add`（加水）：按住持续生成（比泼水更缓，用来"注满一个池子"）
 * - `remove`（减水）：按住持续移除
 * - `freeze`（冻结）：把笔刷范围**登记成冻结区域**（不是"把粒子冻住"，
 *   而是"这块空间里的流体都不动"。区别在于：之后流进来的水也会被冻住 —— 这才是闸门）
 * - `unfreeze`（解冻）：删掉与笔刷相交的冻结区域
 *
 * ────────────────────────────────────────────────────────────
 * 为什么工具要节流
 * ────────────────────────────────────────────────────────────
 * 拖动鼠标时指针事件每秒能来 100+ 次。要是每次都生成一整批粒子，
 * 手一抖就是几十万粒子（然后被上限挡住、留下一大团静止的水）。
 * 所以每个工具都有一个最小间隔：泼水 80 ms、加水 60 ms、抽水/减水 40 ms。
 * 这些数字写在 `TOOL_TICKS` 里，一眼能看出每个工具的节奏差异。
 */

import type { FluidSystem, FrozenRegion } from './FluidSystem';
import { targetSpacing } from './FluidPresets';

export type FluidTool = 'pour' | 'drain' | 'add' | 'remove' | 'freeze' | 'unfreeze';

/** 每个工具的最小执行间隔（毫秒）与单次量纲 */
export const TOOL_TICKS: Record<FluidTool, { intervalMs: number; /** 单次生成/移除的"批次系数" */ batch: number }> = {
  pour: { intervalMs: 80, batch: 1 },
  drain: { intervalMs: 40, batch: 1 },
  add: { intervalMs: 60, batch: 0.6 },
  remove: { intervalMs: 40, batch: 1 },
  freeze: { intervalMs: 200, batch: 1 },
  unfreeze: { intervalMs: 200, batch: 1 },
};

export interface FluidToolResult {
  /** 这次实际做了什么（中文，直接显示给玩家） */
  message: string;
  /** 生成的粒子数（生成类工具） */
  spawned: number;
  /** 移除的粒子数（移除类工具） */
  removed: number;
  /** 因为到了粒子上限而没生成的 */
  rejected: number;
  /** 这次是否真的执行了（被节流挡掉时为 false） */
  executed: boolean;
}

const EMPTY_RESULT: FluidToolResult = { message: '', spawned: 0, removed: 0, rejected: 0, executed: false };

export interface FluidEditorOptions {
  /** 笔刷半径（米）。与地形笔刷共用一个数值 */
  radius: number;
  /** 一次"泼"在笔刷中心生成多少粒子 */
  pourAmount: number;
  /** 初始速度（+Y 向上），让泼出去的水有个抛物线 */
  pourSpeed: number;
  /** 是否允许冻结（关掉可以简化面板） */
  allowFreeze?: boolean;
}

export class FluidEditor {
  private toolValue: FluidTool = 'pour';
  private readonly lastRunAt: Partial<Record<FluidTool, number>> = {};
  private radiusValue: number;
  private pourAmount: number;
  private pourSpeed: number;
  private readonly allowFreeze: boolean;
  /** 累计统计（面板显示"这个会话里倒进去多少水"） */
  private totalSpawned = 0;
  private totalRemoved = 0;

  constructor(
    private readonly system: FluidSystem,
    options: Partial<FluidEditorOptions> = {},
  ) {
    this.radiusValue = options.radius ?? 2;
    this.pourAmount = options.pourAmount ?? 120;
    this.pourSpeed = options.pourSpeed ?? 1.5;
    this.allowFreeze = options.allowFreeze ?? true;
  }

  get tool(): FluidTool {
    return this.toolValue;
  }

  get radius(): number {
    return this.radiusValue;
  }

  get amounts(): { pourAmount: number; pourSpeed: number } {
    return { pourAmount: this.pourAmount, pourSpeed: this.pourSpeed };
  }

  get totals(): { spawned: number; removed: number } {
    return { spawned: this.totalSpawned, removed: this.totalRemoved };
  }

  setTool(tool: FluidTool): void {
    if (tool === 'freeze' || tool === 'unfreeze') {
      if (!this.allowFreeze) return;
    }
    this.toolValue = tool;
  }

  /** 笔刷半径限制在 0.5~16 米（与地形笔刷一致的下限，上限更小一点免得一泼就是半个世界） */
  setRadius(radius: number): void {
    this.radiusValue = Math.max(0.5, Math.min(16, radius));
  }

  setPourAmount(amount: number): void {
    this.pourAmount = Math.max(10, Math.min(4000, Math.floor(amount)));
  }

  setPourSpeed(speed: number): void {
    this.pourSpeed = Math.max(0, Math.min(12, speed));
  }

  /**
   * 在某个位置应用当前工具。
   *
   * @param held 是否是"按住"状态（false = 单击）。冻结这类工具不看它；
   *   生成/移除类工具都看 —— 但**都会走节流**，所以按住也只是按固定节奏出量。
   * @returns 本次的结果（含中文说明，直接可显示）
   */
  apply(x: number, y: number, z: number, nowMs: number, held: boolean): FluidToolResult {
    const tick = TOOL_TICKS[this.toolValue];
    const last = this.lastRunAt[this.toolValue] ?? Number.NEGATIVE_INFINITY;
    if (nowMs - last < tick.intervalMs) return { ...EMPTY_RESULT, message: '' };
    this.lastRunAt[this.toolValue] = nowMs;

    const radius = this.radiusValue;
    // 单次生成量：与笔刷半径的**体积**成正比（半径翻倍 = 体积 8 倍）。
    // 这不只是"手感"问题：固定数量时大笔刷撒出来是一层薄膜（密度远低于静止密度），
    // 于是水会立刻塌成一团 —— 体积正比才能真正"填满笔刷范围"。
    const volumeRatio = (radius * radius * radius) / 8; // 以半径 2 米为基准
    const batchCount = Math.max(4, Math.round(this.pourAmount * tick.batch * volumeRatio));

    switch (this.toolValue) {
      case 'pour':
      case 'add': {
        const result = this.system.emitSphere(x, y, z, batchCount, radius, [
          0,
          this.toolValue === 'pour' ? this.pourSpeed : this.pourSpeed * 0.3,
          0,
        ]);
        this.totalSpawned += result.spawned;
        const message =
          result.rejected > 0
            ? `生成了 ${result.spawned} 个粒子，${result.rejected} 个没放下（${this.describeLimit()}）`
            : `生成了 ${result.spawned} 个粒子`;
        return { message, spawned: result.spawned, removed: 0, rejected: result.rejected, executed: true };
      }
      case 'drain':
      case 'remove': {
        const removed = this.system.removeInSphere(x, y, z, radius);
        this.totalRemoved += removed;
        return {
          message: removed > 0 ? `移除了 ${removed} 个粒子` : '这个范围内没有粒子',
          spawned: 0,
          removed,
          rejected: 0,
          executed: true,
        };
      }
      case 'freeze': {
        const region = this.freezeAt(x, y, z, radius);
        return {
          message: `已冻结这一块（${region.label}）——这块空间里的流体会静止，之后流进来的也会被冻住`,
          spawned: 0, removed: 0, rejected: 0, executed: true,
        };
      }
      case 'unfreeze': {
        const removed = this.unfreezeAt(x, y, z, radius);
        return {
          message: removed > 0 ? `解冻了 ${removed} 块区域` : '这里没有冻结区域',
          spawned: 0, removed: 0, rejected: 0, executed: true,
        };
      }
      default:
        return { ...EMPTY_RESULT, message: '' };
    }
    void held;
  }

  /** 造一个以笔刷为中心的立方冻结区（边长 = 2×半径） */
  freezeAt(x: number, y: number, z: number, radius?: number): FrozenRegion {
    const r = radius ?? this.radiusValue;
    return this.system.addFrozenRegion({
      minX: x - r,
      maxX: x + r,
      minY: Math.max(0, y - r),
      maxY: y + r,
      minZ: z - r,
      maxZ: z + r,
      label: `冻结区 ${this.system.frozenRegions.length + 1}（半径 ${r.toFixed(1)} 米）`,
    });
  }

  /** 解冻与笔刷范围相交的区域；返回解冻的块数 */
  unfreezeAt(x: number, y: number, z: number, radius?: number): number {
    const r = radius ?? this.radiusValue;
    const doomed = this.system.frozenRegions.filter((region) =>
      region.minX <= x + r && region.maxX >= x - r &&
      region.minY <= y + r && region.maxY >= y - r &&
      region.minZ <= z + r && region.maxZ >= z - r,
    );
    let removed = 0;
    for (const region of doomed) if (this.system.removeFrozenRegion(region.id)) removed += 1;
    return removed;
  }

  /** 上限说明（中文，用来解释"为什么没放下"） */
  private describeLimit(): string {
    const stats = this.system.poolStats;
    if (stats.alive >= this.system.capacity) {
      const target = targetSpacing(this.system.fluidConfig);
      const side = Math.cbrt(this.system.capacity) * target;
      return `已经到粒子上限 ${this.system.capacity}（大约相当于 ${side.toFixed(1)} 米见方的一池水），先用"抽水/减水"清掉一些`;
    }
    return '这一处已经被水占满，换个位置或者先把水抽掉一些';
  }
}
