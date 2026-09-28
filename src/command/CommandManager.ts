import type { BuildingInstance } from '../building/types';
import type { BuildingSystem } from '../building/BuildingSystem';
import type { VoxelChange } from '../voxel/BrushSystem';
import { unpackKey } from '../voxel/BrushSystem';
import type { VoxelGrid } from '../voxel/VoxelGrid';

/** 一次位移/旋转的前后状态 */
export interface TransformChange {
  id: number;
  beforePosition: [number, number, number];
  afterPosition: [number, number, number];
  beforeRotation: number;
  afterRotation: number;
}

/** 一条可撤销的操作 */
export interface EditCommand {
  /** 显示给用户的操作名 */
  label: string;
  /** 分组名：同一批操作（例如一次"框选后统一微调"）归到一组 */
  group: string;
  /** 体素改动（含水量） */
  voxelChanges: VoxelChange[];
  /** 新增的建筑（撤销时删除） */
  buildingsAdded: BuildingInstance[];
  /** 删除的建筑（撤销时恢复） */
  buildingsRemoved: BuildingInstance[];
  /** 位移/旋转变更 */
  transforms: TransformChange[];
  /** 时间戳 */
  time: number;
}

/** 给历史面板用的摘要 */
export interface CommandSummary {
  index: number;
  label: string;
  group: string;
  time: number;
  voxelChanges: number;
  buildingsAdded: number;
  buildingsRemoved: number;
  transforms: number;
}

/** 默认保留 100 步（验收要求 ≥ 50） */
export const DEFAULT_HISTORY_LIMIT = 100;

/**
 * 撤销 / 重做管理器。
 *
 * M2 相比上一轮的三点扩展：
 * 1. **变换变更**：微调位置、旋转、拿起放下都会进历史，不再只有"增删"；
 * 2. **分组**：每条命令带一个 `group` 名，历史面板可以按批读
 *    （一次框选后微调 20 个物体，是"一条"记录而不是 20 条）；
 * 3. **可回溯**：`jumpTo(index)` 一次退回到任意历史位置 ——
 *    这正是"点历史列表里的任意一步直接回退"背后的实现（内部反复 undo/redo）。
 *
 * 存的依然是**数据快照**而不是命令对象：地形笔刷一次能动几千个体素，
 * 任何"逻辑回放"都不如直接把旧值写回去可靠。
 */
export class CommandManager {
  private readonly undoStack: EditCommand[] = [];
  private readonly redoStack: EditCommand[] = [];

  constructor(
    private readonly grid: () => VoxelGrid,
    private readonly buildings: BuildingSystem,
    private readonly limit: number = DEFAULT_HISTORY_LIMIT,
  ) {}

  /**
   * 登记一次**已经生效**的编辑。
   * @returns 是否真的入栈（没有任何变化就不占历史）
   */
  push(command: {
    label: string;
    group?: string;
    voxelChanges?: VoxelChange[];
    buildingsAdded?: readonly BuildingInstance[];
    buildingsRemoved?: readonly BuildingInstance[];
    transforms?: readonly TransformChange[];
  }): boolean {
    const voxelChanges = command.voxelChanges ?? [];
    const added = [...(command.buildingsAdded ?? [])];
    const removed = [...(command.buildingsRemoved ?? [])];
    const transforms = [...(command.transforms ?? [])];

    if (voxelChanges.length === 0 && added.length === 0 && removed.length === 0 && transforms.length === 0) {
      return false;
    }

    this.undoStack.push({
      label: command.label,
      group: command.group ?? '',
      voxelChanges,
      buildingsAdded: added,
      buildingsRemoved: removed,
      transforms,
      time: Date.now(),
    });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    return true;
  }

  undo(): EditCommand | null {
    const command = this.undoStack.pop();
    if (!command) return null;
    this.applyCommand(command, 'before');
    this.redoStack.push(command);
    return command;
  }

  redo(): EditCommand | null {
    const command = this.redoStack.pop();
    if (!command) return null;
    this.applyCommand(command, 'after');
    this.undoStack.push(command);
    return command;
  }

  /**
   * 回退/前进到"第 index 步已应用"的状态。
   * index = -1 表示回到最初。内部就是反复 undo / redo，所以每一步语义完全一致。
   * @returns 实际执行的操作次数
   */
  jumpTo(index: number): number {
    // 可到达的最远位置 = 已应用的步数 + 可以重做的步数
    // （之前只按 undoStack 的长度钳制，导致"回溯之后再点后面某一步"永远前进不了）
    const maxReachable = this.undoStack.length - 1 + this.redoStack.length;
    const target = Math.max(-1, Math.min(index, maxReachable));
    let steps = 0;
    while (this.undoStack.length - 1 > target && steps < this.limit + 10) {
      if (!this.undo()) break;
      steps++;
    }
    while (this.undoStack.length - 1 < target && steps < this.limit + 10) {
      if (!this.redo()) break;
      steps++;
    }
    return steps;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  get redoCount(): number {
    return this.redoStack.length;
  }

  /** 当前处在第几步（-1 = 还没有任何操作） */
  get cursor(): number {
    return this.undoStack.length - 1;
  }

  get nextUndoLabel(): string | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1]!.label : null;
  }

  get nextRedoLabel(): string | null {
    return this.redoStack.length > 0 ? this.redoStack[this.redoStack.length - 1]!.label : null;
  }

  /** 历史摘要（从旧到新），直接喂给 HistoryPanel */
  listHistory(): CommandSummary[] {
    return this.undoStack.map((command, index) => ({
      index,
      label: command.label,
      group: command.group,
      time: command.time,
      voxelChanges: command.voxelChanges.length,
      buildingsAdded: command.buildingsAdded.length,
      buildingsRemoved: command.buildingsRemoved.length,
      transforms: command.transforms.length,
    }));
  }

  /** 历史里累计的变更条数（调试用） */
  get changeCount(): number {
    let total = 0;
    for (const command of this.undoStack) total += command.voxelChanges.length + command.transforms.length;
    for (const command of this.redoStack) total += command.voxelChanges.length + command.transforms.length;
    return total;
  }

  // ---------------------------------------------------------------- 内部

  private applyCommand(command: EditCommand, side: 'before' | 'after'): void {
    // 1) 体素：先写类型再写水量（和水/沙模拟保持一致的方向）
    this.applyVoxels(command.voxelChanges, side);

    // 2) 建筑增删
    if (side === 'before') {
      this.buildings.removeMany(command.buildingsAdded.map((instance) => instance.id));
      this.buildings.restore(command.buildingsRemoved);
    } else {
      this.buildings.removeMany(command.buildingsRemoved.map((instance) => instance.id));
      this.buildings.restore(command.buildingsAdded);
    }

    // 3) 变换
    for (const change of command.transforms) {
      const position = side === 'before' ? change.beforePosition : change.afterPosition;
      const rotation = side === 'before' ? change.beforeRotation : change.afterRotation;
      this.buildings.setTransform(change.id, position, rotation);
    }

    // 4) 让物理刚体跟上（撤销后位置变了，刚体还停在原地就穿帮了）
    for (const id of [
      ...command.buildingsAdded.map((instance) => instance.id),
      ...command.buildingsRemoved.map((instance) => instance.id),
      ...command.transforms.map((change) => change.id),
    ]) {
      this.buildings.syncToPhysics(id);
    }
  }

  private applyVoxels(changes: readonly VoxelChange[], side: 'before' | 'after'): void {
    const grid = this.grid();
    for (const change of changes) {
      const [x, y, z] = unpackKey(change.key);
      const type = side === 'before' ? change.before : change.after;
      const water = side === 'before' ? change.waterBefore : change.waterAfter;
      grid.setVoxel(x, y, z, type);
      if (water !== undefined && water > 0) grid.setWaterLevel(x, y, z, water / 255);
    }
  }
}
