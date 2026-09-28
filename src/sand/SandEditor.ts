/**
 * 沙土编辑工具（M4 第二部分 · 第 3 批）。
 *
 * 与流体工具同一套思路：上帝视角的笔刷，输入只有"笔刷中心 + 半径"。
 * 五个工具：
 * - `pile`（堆沙）：在笔刷范围内往**地表之上**堆沙（不会堆到地下）
 * - `dig`（挖沙）：把范围内的沙挖掉
 * - `wet`（湿沙）：把范围内的沙弄湿（湿度往 1 推）
 * - `dry`（干沙）：把范围内的沙弄干
 * - `solidify`（凝固）：把沙变成石头 —— 这是**唯一不可逆**的工具
 *
 * ────────────────────────────────────────────────────────────
 * 为什么"堆沙"要自己找地表，而不是直接填一个球
 * ────────────────────────────────────────────────────────────
 * 直接填球的话，笔刷中心在地面以下时沙会出现在地里（玩家看不到），
 * 而中心在地面以上时又会形成一块悬空的沙板（然后整块塌下来）。
 * 所以堆沙的做法是：对范围内的每一列**从地表往上堆**，
 * 堆多少由"笔刷强度 × 到中心的距离衰减"决定 —— 结果是一个自然的沙丘形状。
 */

import type { VoxelGrid } from '../voxel/VoxelGrid';
import { AIR, getVoxelId } from '../data/voxelTypes';
import type { SandTool } from './SandPhysics';

const SAND = getVoxelId('sand');

/** 每个工具的最小执行间隔（毫秒）。拖动时指针事件远多于这个频率，必须节流 */
export const SAND_TOOL_TICKS: Record<SandTool, number> = {
  pile: 90,
  dig: 50,
  wet: 60,
  dry: 60,
  solidify: 300,
};

export interface SandToolResult {
  /** 中文说明（直接可显示） */
  message: string;
  /** 改动的格数 */
  changed: number;
  /** 这次是否真的执行了（被节流挡掉时为 false） */
  executed: boolean;
}

export interface SandEditorOptions {
  /** 笔刷半径（米/格） */
  radius: number;
  /** 堆沙的最大高度（格） */
  maxPileHeight: number;
}

export class SandEditor {
  private toolValue: SandTool = 'pile';
  private radiusValue: number;
  private maxPileHeight: number;
  private readonly lastRunAt: Partial<Record<SandTool, number>> = {};
  private totalChanged = 0;

  constructor(
    private readonly grid: VoxelGrid,
    private readonly sand: {
      markActive(x: number, y: number, z: number): void;
      setMoisture(x: number, y: number, z: number, value: number): boolean;
      moistureAt(x: number, y: number, z: number): number;
      solidify(x: number, y: number, z: number, radius: number): number;
      refreshStabilityAt(x: number, y: number, z: number): void;
    },
    options: Partial<SandEditorOptions> = {},
  ) {
    this.radiusValue = options.radius ?? 3;
    this.maxPileHeight = options.maxPileHeight ?? 6;
  }

  get tool(): SandTool {
    return this.toolValue;
  }

  get radius(): number {
    return this.radiusValue;
  }

  get pileHeight(): number {
    return this.maxPileHeight;
  }

  get totals(): number {
    return this.totalChanged;
  }

  setTool(tool: SandTool): void {
    this.toolValue = tool;
  }

  setRadius(radius: number): void {
    this.radiusValue = Math.max(1, Math.min(16, radius));
  }

  setPileHeight(height: number): void {
    this.maxPileHeight = Math.max(1, Math.min(16, Math.floor(height)));
  }

  /**
   * 在某个位置应用当前工具。
   * @param nowMs 当前时间（用于节流）
   */
  apply(x: number, y: number, z: number, nowMs: number): SandToolResult {
    const interval = SAND_TOOL_TICKS[this.toolValue];
    const last = this.lastRunAt[this.toolValue] ?? Number.NEGATIVE_INFINITY;
    if (nowMs - last < interval) return { message: '', changed: 0, executed: false };
    this.lastRunAt[this.toolValue] = nowMs;

    switch (this.toolValue) {
      case 'pile':
        return this.pile(x, y, z);
      case 'dig':
        return this.dig(x, y, z);
      case 'wet':
        return this.setMoistureInRadius(x, y, z, 1, '湿沙');
      case 'dry':
        return this.setMoistureInRadius(x, y, z, 0, '干沙');
      case 'solidify': {
        const changed = this.sand.solidify(x, y, z, Math.max(1, Math.round(this.radiusValue * 0.6)));
        this.totalChanged += changed;
        return {
          message: changed > 0
            ? `凝固了 ${changed} 格沙（变成石头，不可逆）`
            : '这个范围里没有沙可以凝固',
          changed,
          executed: true,
        };
      }
      default:
        return { message: '', changed: 0, executed: false };
    }
  }

  /**
   * 堆沙：对每一列从地表往上堆，高度按到中心的距离衰减。
   *
   * 衰减用 `cos(π/2 · d/r)` 而不是线性：它在中部更平、边缘更快收，
   * 堆出来的形状更像自然沙丘（线性衰减会得到一个圆锥，看起来像人工沙堆）。
   */
  private pile(x: number, y: number, z: number): SandToolResult {
    const grid = this.grid;
    const radius = Math.round(this.radiusValue);
    let changed = 0;
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const distance = Math.hypot(dx, dz);
        if (distance > radius) continue;
        const nx = x + dx;
        const nz = z + dz;
        if (!grid.inHorizontalBounds(nx, nz)) continue;
        // 以笔刷中心所在高度为参考，但**不能低于地表**：
        // 地表是这一列最高的固体格，从它上面开始堆
        const columnTop = Math.max(grid.solidSurfaceHeight(nx, nz), y - 1);
        const falloff = Math.cos((distance / Math.max(1, radius)) * (Math.PI / 2));
        const height = Math.max(1, Math.round(this.maxPileHeight * falloff));
        for (let dy = 1; dy <= height; dy += 1) {
          const ny = columnTop + dy;
          if (ny >= grid.sizeY) break;
          if (grid.getVoxel(nx, ny, nz) !== AIR) continue;
          grid.setVoxel(nx, ny, nz, SAND);
          // 新堆的沙是"松"的：先记为干沙，靠沙崩自己找角度
          this.sand.refreshStabilityAt(nx, ny, nz);
          changed += 1;
        }
        this.sand.markActive(nx, columnTop + 1, nz);
      }
    }
    this.totalChanged += changed;
    return {
      message: changed > 0 ? `堆了 ${changed} 格沙` : '这里堆不下（上方被挡住或到了世界顶部）',
      changed,
      executed: true,
    };
  }

  /** 挖沙：把球内的沙变空气 */
  private dig(x: number, y: number, z: number): SandToolResult {
    const grid = this.grid;
    const radius = this.radiusValue;
    const r2 = radius * radius;
    const ri = Math.ceil(radius);
    let changed = 0;
    for (let dy = -ri; dy <= ri; dy += 1) {
      for (let dz = -ri; dz <= ri; dz += 1) {
        for (let dx = -ri; dx <= ri; dx += 1) {
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (!grid.inBounds(nx, ny, nz)) continue;
          if (grid.getVoxel(nx, ny, nz) !== SAND) continue;
          grid.setVoxel(nx, ny, nz, AIR);
          changed += 1;
        }
      }
    }
    // 挖走之后上方的沙会失去支撑 → 全部唤醒
    this.sand.markActive(x, y, z);
    this.sand.markActive(x, y + 1, z);
    this.totalChanged += changed;
    return {
      message: changed > 0 ? `挖掉 ${changed} 格沙` : '这个范围里没有沙',
      changed,
      executed: true,
    };
  }

  /** 湿沙 / 干沙：把球内每格沙的湿度推向目标值 */
  private setMoistureInRadius(x: number, y: number, z: number, target: number, label: string): SandToolResult {
    const grid = this.grid;
    const radius = this.radiusValue;
    const r2 = radius * radius;
    const ri = Math.ceil(radius);
    let changed = 0;
    for (let dy = -ri; dy <= ri; dy += 1) {
      for (let dz = -ri; dz <= ri; dz += 1) {
        for (let dx = -ri; dx <= ri; dx += 1) {
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (!grid.inBounds(nx, ny, nz)) continue;
          if (grid.getVoxel(nx, ny, nz) !== SAND) continue;
          // 按距离衰减地推：中心一次到底，边缘只推一点（边缘突变会在画面上很明显）
          const falloff = 1 - Math.sqrt(d2) / Math.max(1, radius);
          const current = this.sand.moistureAt(nx, ny, nz);
          const next = current + (target - current) * Math.max(0.25, falloff);
          if (this.sand.setMoisture(nx, ny, nz, next)) changed += 1;
        }
      }
    }
    this.totalChanged += changed;
    return {
      message: changed > 0 ? `把 ${changed} 格沙变${label === '湿沙' ? '湿' : '干'}了` : `这里没有沙可以变${label}`,
      changed,
      executed: true,
    };
  }
}
