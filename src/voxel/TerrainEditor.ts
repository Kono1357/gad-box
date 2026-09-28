import type { VoxelGrid } from './VoxelGrid';
import { AIR, getVoxelId } from '../data/voxelTypes';
import type { VoxelHit } from './VoxelRaycast';

/** 用户在 UI 上能选的 7 种笔刷 */
export type BrushType =
  | 'raise'
  | 'lower'
  | 'smooth'
  | 'flatten'
  | 'paint'
  | 'dig'
  | 'fillWater';

/** 笔刷内部实际执行的 9 种模式：7 种笔刷 + Shift 反向派生的 2 种 */
type BrushMode = BrushType | 'fillSolid' | 'drainWater';

export type FalloffType = 'linear' | 'smooth' | 'constant';

export interface BrushSettings {
  type: BrushType;
  /** 半径：1~16 米（体素） */
  radius: number;
  /** 强度：1~10 */
  strength: number;
  /** 衰减曲线 */
  falloff: FalloffType;
  /** 材质刷 / 抬升填充使用的体素 id */
  material: number;
}

/** 一条体素变更记录：撤销重做与存档都基于它 */
export interface VoxelChange {
  /** 打包后的体素全局坐标（19 位整数） */
  key: number;
  before: number;
  after: number;
}

export interface BrushResult {
  changes: VoxelChange[];
  /** 实际被改动的体素数 */
  changed: number;
  /** 本次编辑耗时（毫秒） */
  ms: number;
  /** 实际生效的模式描述，显示在底部状态条 */
  label: string;
}

export const BRUSH_LABELS: Record<BrushType, string> = {
  raise: '抬升',
  lower: '下沉',
  smooth: '平滑',
  flatten: '抹平',
  paint: '材质刷',
  dig: '挖洞',
  fillWater: '填水',
};

const MODE_LABELS: Record<BrushMode, string> = {
  ...BRUSH_LABELS,
  fillSolid: '填实（挖洞反向）',
  drainWater: '抽水（填水反向）',
};

const WATER = getVoxelId('water');

/** 坐标打包：x,z ∈ [0,128) 各 7 位，y ∈ [0,32) 5 位，共 19 位 */
export function packKey(x: number, y: number, z: number): number {
  return (x & 127) | ((z & 127) << 7) | ((y & 31) << 14);
}

export function unpackKey(key: number): [number, number, number] {
  return [key & 127, (key >> 14) & 31, (key >> 7) & 127];
}

/** Shift 反向时的模式映射：抬升↔下沉、挖洞↔填实、材质刷↔挖洞、填水↔抽水 */
function resolveMode(type: BrushType, invert: boolean): BrushMode {
  if (!invert) return type;
  switch (type) {
    case 'raise':
      return 'lower';
    case 'lower':
      return 'raise';
    case 'dig':
      return 'fillSolid';
    case 'paint':
      return 'dig'; // 材质刷反向 = 擦除
    case 'fillWater':
      return 'drainWater';
    default:
      return type; // 平滑 / 抹平没有反向
  }
}

/** 衰减曲线：中心 1 → 边缘 0 */
function falloffAt(distance: number, radius: number, type: FalloffType): number {
  if (radius <= 0) return 1;
  const t = Math.max(0, 1 - distance / radius);
  switch (type) {
    case 'constant':
      return 1;
    case 'smooth':
      return t * t * (3 - 2 * t);
    case 'linear':
    default:
      return t;
  }
}

/**
 * 一次编辑的变更集合。
 *
 * 关键点：同一次笔刷里同一个体素可能被反复写（例如先挖后填），
 * 这里只记录**第一次写入前的旧值**和**最终值**，
 * 这样撤销一条命令就能精确回到编辑前的状态，也不会浪费内存。
 */
class EditSession {
  private readonly before = new Map<number, number>();
  private readonly after = new Map<number, number>();
  private touched = 0;

  constructor(private readonly grid: VoxelGrid) {}

  set(x: number, y: number, z: number, id: number): void {
    const current = this.grid.getVoxel(x, y, z);
    if (current === id) return;
    const key = packKey(x, y, z);
    if (!this.before.has(key)) this.before.set(key, current);
    if (!this.grid.setVoxel(x, y, z, id)) return;
    this.after.set(key, id);
    this.touched++;
  }

  get changeCount(): number {
    return this.touched;
  }

  finish(): VoxelChange[] {
    const changes: VoxelChange[] = [];
    for (const [key, before] of this.before) {
      const after = this.after.get(key);
      if (after === undefined || after === before) continue;
      changes.push({ key, before, after });
    }
    return changes;
  }
}

/**
 * 地形编辑器：把笔刷设置 + 拾取结果变成一批体素变更。
 *
 * 两类作用方式（这是刻意的设计选择，不是偷懒）：
 * - **按列**：抬升 / 下沉 / 平滑 / 抹平 —— 像 WorldEdit 的地形笔刷，
 *   以"某一列的地表高度"为操作对象，手感可预测，且天然不会挖出奇怪的侧洞；
 * - **按球**：挖洞 / 材质刷 / 填水 / 填实 / 抽水 —— 真正的球形范围操作。
 *
 * 所有模式都不会动 y = 0 的基岩层，保证世界永远有底。
 */
export class TerrainEditor {
  constructor(private readonly grid: VoxelGrid) {}

  /**
   * 应用一次笔刷。
   * @param hit 射线拾取结果（决定笔刷中心）
   * @param invert Shift 反向
   */
  apply(settings: BrushSettings, hit: VoxelHit, invert = false): BrushResult {
    const started = performance.now();
    const mode = resolveMode(settings.type, invert);
    const session = new EditSession(this.grid);
    const radius = Math.max(1, Math.min(settings.radius, 16));

    switch (mode) {
      case 'raise':
        this.applyColumnShift(session, hit.x, hit.z, radius, settings, +1);
        break;
      case 'lower':
        this.applyColumnShift(session, hit.x, hit.z, radius, settings, -1);
        break;
      case 'smooth':
        this.applyRelax(session, hit.x, hit.z, radius, settings, 'neighbor');
        break;
      case 'flatten':
        this.applyRelax(session, hit.x, hit.z, radius, settings, 'center');
        break;
      default:
        this.applySphere(session, hit.x, hit.y, hit.z, radius, mode, settings.material);
        break;
    }

    const changes = session.finish();
    return {
      changes,
      changed: changes.length,
      ms: performance.now() - started,
      label: MODE_LABELS[mode],
    };
  }

  // ------------------------------------------------------------------ 列式

  /**
   * 抬升 / 下沉：按列整体加高或削低。
   * 高度增量 = 衰减 × 强度 × 0.6（强度 10、中心最满时一次约 6 层）。
   */
  private applyColumnShift(
    session: EditSession,
    centerX: number,
    centerZ: number,
    radius: number,
    settings: BrushSettings,
    direction: 1 | -1,
  ): void {
    const grid = this.grid;
    const maxY = grid.sizeY - 1;

    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const distance = Math.hypot(dx, dz);
        if (distance > radius) continue;

        const x = centerX + dx;
        const z = centerZ + dz;
        if (!grid.inHorizontalBounds(x, z)) continue;

        const falloff = falloffAt(distance, radius, settings.falloff);
        const amount = Math.max(1, Math.round(falloff * settings.strength * 0.6));
        const surface = grid.surfaceHeight(x, z);

        if (direction > 0) {
          const start = Math.max(0, surface + 1);
          const end = Math.min(surface + amount, maxY);
          for (let y = start; y <= end; y++) {
            if (grid.getVoxel(x, y, z) === AIR) session.set(x, y, z, settings.material);
          }
        } else {
          // 保留 y = 0 基岩层
          const from = Math.max(1, surface - amount + 1);
          for (let y = from; y <= surface; y++) session.set(x, y, z, AIR);
        }
      }
    }
  }

  /**
   * 平滑 / 抹平：让每一列的地表高度朝目标高度靠拢。
   * - `neighbor`：目标是周围一圈列的平均高度（地形变柔和）
   * - `center`：目标是笔刷中心列的高度（压成一个平台）
   *
   * 先快照所有列的高度再统一写入，避免"边算边改"造成的连锁误差。
   */
  private applyRelax(
    session: EditSession,
    centerX: number,
    centerZ: number,
    radius: number,
    settings: BrushSettings,
    goal: 'neighbor' | 'center',
  ): void {
    const grid = this.grid;
    const maxY = grid.sizeY - 1;

    const columns: Array<{ x: number; z: number; h: number; falloff: number }> = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const distance = Math.hypot(dx, dz);
        if (distance > radius) continue;
        const x = centerX + dx;
        const z = centerZ + dz;
        if (!grid.inHorizontalBounds(x, z)) continue;
        columns.push({
          x,
          z,
          h: grid.surfaceHeight(x, z),
          falloff: falloffAt(distance, radius, settings.falloff),
        });
      }
    }
    if (columns.length === 0) return;

    const centerHeight = grid.surfaceHeight(centerX, centerZ);
    if (goal === 'center' && centerHeight < 0) return;

    for (const column of columns) {
      if (column.h < 0) continue; // 空列不参与

      let targetHeight: number;
      if (goal === 'center') {
        targetHeight = centerHeight;
      } else {
        // 3×3 邻域的平均地表高度
        let sum = 0;
        let count = 0;
        for (let oz = -1; oz <= 1; oz++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oz === 0) continue;
            const nh = grid.surfaceHeight(column.x + ox, column.z + oz);
            if (nh >= 0) {
              sum += nh;
              count++;
            }
          }
        }
        targetHeight = count > 0 ? sum / count : column.h;
      }

      // 强度决定"靠拢多少"：强度 10 = 一步到位
      const t = Math.min(1, (column.falloff * settings.strength) / 10);
      const newHeight = Math.max(
        1,
        Math.min(maxY, Math.round(column.h + (targetHeight - column.h) * t)),
      );
      if (newHeight === column.h) continue;

      if (newHeight > column.h) {
        // 加高：沿用该列原有地表材质，避免整片变成石头
        const surfaceType = grid.getVoxel(column.x, column.h, column.z);
        const fillType = surfaceType === AIR ? settings.material : surfaceType;
        for (let y = column.h + 1; y <= newHeight; y++) {
          if (grid.getVoxel(column.x, y, column.z) === AIR) session.set(column.x, y, column.z, fillType);
        }
      } else {
        for (let y = newHeight + 1; y <= column.h; y++) {
          session.set(column.x, y, column.z, AIR);
        }
      }
    }
  }

  // ------------------------------------------------------------------ 球式

  /** 球形范围操作：挖洞 / 材质刷 / 填水 / 填实 / 抽水 */
  private applySphere(
    session: EditSession,
    centerX: number,
    centerY: number,
    centerZ: number,
    radius: number,
    mode: BrushMode,
    material: number,
  ): void {
    const grid = this.grid;
    const r2 = radius * radius;

    for (let dy = -radius; dy <= radius; dy++) {
      const y = centerY + dy;
      if (y <= 0 || y >= grid.sizeY) continue; // 基岩保护

      for (let dz = -radius; dz <= radius; dz++) {
        const z = centerZ + dz;
        if (z < 0 || z >= grid.sizeZ) continue;

        for (let dx = -radius; dx <= radius; dx++) {
          const x = centerX + dx;
          if (x < 0 || x >= grid.sizeX) continue;
          if (dx * dx + dy * dy + dz * dz > r2) continue;

          const current = grid.getVoxel(x, y, z);
          switch (mode) {
            case 'dig':
              if (current !== AIR) session.set(x, y, z, AIR);
              break;
            case 'paint':
              if (current !== AIR && current !== material) session.set(x, y, z, material);
              break;
            case 'fillWater':
              if (current === AIR) session.set(x, y, z, WATER);
              break;
            case 'fillSolid':
              if (current === AIR) session.set(x, y, z, material);
              break;
            case 'drainWater':
              if (current === WATER) session.set(x, y, z, AIR);
              break;
            default:
              break;
          }
        }
      }
    }
  }
}
