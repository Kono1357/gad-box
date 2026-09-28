import { BRUSH_CONFIG, WORLD_CONFIG } from '../config';
import { AIR, getVoxelDef } from '../data/voxelTypes';
import { mulberry32 } from '../core/random';
import type { VoxelGrid } from './VoxelGrid';
import type { VoxelHit } from './VoxelRaycast';

/** 笔刷形状 */
export type BrushShape = 'sphere' | 'cube' | 'cylinder' | 'plane' | 'single';

/** 衰减曲线 */
export type FalloffType = 'linear' | 'smooth' | 'constant' | 'inverse';

/** 笔刷模式 */
export type BrushMode =
  | 'raise'
  | 'lower'
  | 'smooth'
  | 'flatten'
  | 'paint'
  | 'dig'
  | 'fillWater'
  | 'erase'
  | 'noise'
  | 'scatter'
  | 'soften'
  | 'snap';

/** 笔刷的作用方向 */
export type BrushDirection = 'normal' | 'up' | 'down' | 'camera';

export interface BrushSettings {
  mode: BrushMode;
  shape: BrushShape;
  /** 半径 0.5 ~ 16，支持小数 */
  radius: number;
  /** 强度 0.1 ~ 1.0，支持小数 */
  strength: number;
  falloff: FalloffType;
  /** 密度 0~1：材质刷/挖洞/随机刷里"每个格子被处理的概率" */
  density: number;
  direction: BrushDirection;
  /** 用于抬升填充与材质刷的体素 id */
  material: number;
}

/** 一条体素变更记录（含水量），撤销重做与存档都基于它 */
export interface VoxelChange {
  /** 打包后的体素坐标 */
  key: number;
  before: number;
  after: number;
  /** 水量（0~255）；只有水相关的变化才记录 */
  waterBefore?: number;
  waterAfter?: number;
}

export interface BrushResult {
  changes: VoxelChange[];
  changed: number;
  ms: number;
  label: string;
}

/** 笔刷显示信息：给 UI 的坐标与影响范围预估 */
export interface BrushPreview {
  center: { x: number; y: number; z: number } | null;
  affected: number;
  valid: boolean;
}

export const BRUSH_MODE_LABELS: Record<BrushMode, string> = {
  raise: '抬升',
  lower: '下沉',
  smooth: '平滑',
  flatten: '抹平',
  paint: '材质刷',
  dig: '挖洞',
  fillWater: '填水',
  erase: '擦除',
  noise: '噪声刷',
  scatter: '随机刷',
  soften: '边缘软化',
  snap: '顶点捕捉',
};

export const BRUSH_SHAPE_LABELS: Record<BrushShape, string> = {
  sphere: '球形',
  cube: '立方',
  cylinder: '圆柱',
  plane: '平面',
  single: '单点',
};

export const FALLOFF_LABELS: Record<FalloffType, string> = {
  linear: '线性',
  smooth: '平滑',
  constant: '恒定',
  inverse: '反相',
};

export const DIRECTION_LABELS: Record<BrushDirection, string> = {
  normal: '法线',
  up: '+Y',
  down: '-Y',
  camera: '相机',
};

/** UI 里按钮的排列顺序（顺序会影响数字键 1~9 的映射） */
export const BRUSH_MODES: readonly BrushMode[] = [
  'raise',
  'lower',
  'smooth',
  'flatten',
  'paint',
  'dig',
  'erase',
  'fillWater',
  'noise',
  'scatter',
  'soften',
  'snap',
];

export const BRUSH_SHAPES: readonly BrushShape[] = ['sphere', 'cube', 'cylinder', 'plane', 'single'];

export const BRUSH_FALLOFFS: readonly FalloffType[] = ['linear', 'smooth', 'constant', 'inverse'];

export const BRUSH_DIRECTIONS: readonly BrushDirection[] = ['normal', 'up', 'down', 'camera'];

/** 每种笔刷形状在 3D 里用哪种颜色画线框（可视化时区分形状） */
export const BRUSH_SHAPE_COLORS: Record<BrushShape, number> = {
  sphere: 0x7fd06a,
  cube: 0x5aa9ff,
  cylinder: 0xffcc4d,
  plane: 0xff8f78,
  single: 0xffffff,
};

/** 坐标打包：x/z 各 8 位（支持到 256），y 6 位（支持到 64） */
export function packKey(x: number, y: number, z: number): number {
  return (x & 0xff) | ((z & 0xff) << 8) | ((y & 0x3f) << 16);
}

export function unpackKey(key: number): [number, number, number] {
  return [key & 0xff, (key >> 16) & 0x3f, (key >> 8) & 0xff];
}

/** 抬升/下沉时，强度 1.0 且衰减满值对应的高度层数 */
const MAX_COLUMN_AMOUNT = 6;

/** 顶点捕捉的台阶高度（米） */
const SNAP_STEP = 2;

/** 衰减曲线：中心 1 → 边缘 0 */
function falloffAt(t: number, type: FalloffType): number {
  const clamped = Math.max(0, Math.min(1, t));
  switch (type) {
    case 'constant':
      return 1;
    case 'inverse':
      // 反相：边缘最强、中心最弱，用来做"环形"效果
      return clamped;
    case 'smooth':
      return clamped * clamped * (3 - 2 * clamped);
    case 'linear':
    default:
      return clamped;
  }
}

/**
 * 随机取整：`value = 2.3` 时 30% 概率取 3、70% 概率取 2。
 *
 * 这是让"强度 0.1~1.0 的小数调节"真正有意义的关键 ——
 * 强度 0.12 的一次抬升会以 12% 的概率加 1 层，
 * 于是玩家能一格一格地微调地形，而不是"最小也是一整层"。
 */
function stochasticRound(value: number, rnd: () => number): number {
  const floor = Math.floor(value);
  const frac = value - floor;
  return floor + (rnd() < frac ? 1 : 0);
}

/** 一次编辑的变更集合：合并同一格子的多次写入 */
class ChangeSet {
  private readonly map = new Map<number, VoxelChange>();
  private readonly grid: VoxelGrid;

  constructor(grid: VoxelGrid) {
    this.grid = grid;
  }

  setVoxel(x: number, y: number, z: number, id: number): void {
    if (y <= WORLD_CONFIG.bedrockY) return; // 基岩保护
    if (!this.grid.inBounds(x, y, z)) return;
    const key = packKey(x, y, z);
    const existing = this.map.get(key);
    const previous = this.grid.getVoxel(x, y, z);
    // 记录"第一次改动前的状态"，后续同一格的重复写入只更新 after
    const waterBefore = existing ? existing.waterBefore : Math.round(this.grid.getWaterLevel(x, y, z) * 255);
    if (!this.grid.setVoxel(x, y, z, id)) return;
    const waterAfter = Math.round(this.grid.getWaterLevel(x, y, z) * 255);
    if (existing) {
      existing.after = id;
      existing.waterAfter = waterAfter;
    } else {
      this.map.set(key, { key, before: previous, after: id, waterBefore, waterAfter });
    }
  }

  setWater(x: number, y: number, z: number, level: number): void {
    if (y <= WORLD_CONFIG.bedrockY) return;
    if (!this.grid.inBounds(x, y, z)) return;
    const key = packKey(x, y, z);
    const existing = this.map.get(key);
    const previousType = this.grid.getVoxel(x, y, z);
    const previousWater = Math.round(this.grid.getWaterLevel(x, y, z) * 255);
    if (!this.grid.setWaterLevel(x, y, z, level)) return;
    const nextType = this.grid.getVoxel(x, y, z);
    const nextWater = Math.round(this.grid.getWaterLevel(x, y, z) * 255);
    if (existing) {
      existing.after = nextType;
      existing.waterAfter = nextWater;
    } else {
      this.map.set(key, {
        key,
        before: previousType,
        after: nextType,
        waterBefore: previousWater,
        waterAfter: nextWater,
      });
    }
  }

  get size(): number {
    return this.map.size;
  }

  finish(): VoxelChange[] {
    return [...this.map.values()];
  }
}

/**
 * 笔刷系统。
 *
 * 与 M1 的 TerrainEditor 相比，M1.5 的变化：
 * - **形状可选**（球 / 立方 / 圆柱 / 平面 / 单点），不再只有球；
 * - **强度改成 0.1~1.0 的小数**，配合随机取整实现"一格一格"的精细编辑；
 * - **密度**控制随机分布概率（材质刷 / 挖洞 / 随机刷）；
 * - **方向**决定笔刷中心相对命中面的偏移（法线 / +Y / -Y / 相机）；
 * - 新增 **噪声刷 / 随机刷 / 边缘软化 / 顶点捕捉** 四种模式；
 * - 一次拖动（按下到抬起）会合并成**一条**撤销记录，见 beginStroke / endStroke。
 */
export class BrushSystem {
  /** 一次拖动累积的变更 */
  private stroke: ChangeSet | null = null;
  /** 拖动过程中的随机源：每笔固定，保证同一笔的可重复性 */
  private rnd: () => number = mulberry32(1);
  private strokeSeed = 1;
  private lastMs = 0;

  constructor(private readonly grid: VoxelGrid) {}

  // ------------------------------------------------------------ 拖动事务

  /** 开始一次拖动（左键按下时调用） */
  beginStroke(): void {
    this.strokeSeed = (this.strokeSeed * 1103515245 + 12345) & 0x7fffffff;
    this.rnd = mulberry32(this.strokeSeed);
    this.stroke = new ChangeSet(this.grid);
  }

  /**
   * 结束一次拖动。返回合并后的全部变更 ——
   * **一整次拖动只产生一条撤销记录**，这正是玩家要的"撤销一次拖动恢复整体"。
   */
  endStroke(): { changes: VoxelChange[]; label: string } | null {
    const stroke = this.stroke;
    this.stroke = null;
    if (!stroke || stroke.size === 0) return null;
    return { changes: stroke.finish(), label: `笔刷拖动 · ${stroke.size} 格` };
  }

  get isStroking(): boolean {
    return this.stroke !== null;
  }

  // ------------------------------------------------------------ 应用

  /**
   * 应用一次笔刷。
   * @param hit 射线拾取结果
   * @param invert Shift 反向
   * @param cameraDirection 相机朝向（direction = 'camera' 时用）
   */
  apply(
    settings: BrushSettings,
    hit: VoxelHit,
    invert = false,
    cameraDirection?: readonly [number, number, number],
  ): BrushResult {
    const started = performance.now();
    if (!this.stroke) this.beginStroke(); // 兜底：没显式开始也能工作
    const changes = this.stroke!;
    const before = changes.size;

    const radius = Math.max(BRUSH_CONFIG.minRadius, Math.min(settings.radius, BRUSH_CONFIG.maxRadius));
    const mode = this.resolveMode(settings.mode, invert);
    const center = this.resolveCenter(hit, settings.direction, cameraDirection);

    switch (mode) {
      case 'raise':
      case 'lower':
        this.applyColumnShift(changes, settings, center, radius, mode === 'raise' ? 1 : -1);
        break;
      case 'smooth':
        this.applyRelax(changes, settings, center, radius, 'neighbor', hit);
        break;
      case 'flatten':
        this.applyRelax(changes, settings, center, radius, 'center', hit);
        break;
      case 'snap':
        this.applySnap(changes, settings, center, radius);
        break;
      case 'soften':
        this.applySoften(changes, settings, center, radius);
        break;
      case 'noise':
        this.applyNoise(changes, settings, center, radius);
        break;
      default:
        this.applyVolume(changes, settings, center, radius, mode);
        break;
    }

    this.lastMs = performance.now() - started;
    const changed = changes.size - before;
    return {
      changes: [],
      changed,
      ms: this.lastMs,
      label: `${BRUSH_MODE_LABELS[mode]} · ${BRUSH_SHAPE_LABELS[settings.shape]}`,
    };
  }

  /** 预估影响体素数（只用于 UI 显示，不实际修改） */
  estimateAffected(settings: BrushSettings): number {
    const r = settings.radius;
    switch (settings.shape) {
      case 'single':
        return 1;
      case 'plane':
        return Math.PI * r * r;
      case 'cube':
        return Math.pow(2 * r + 1, 3);
      case 'cylinder':
        return Math.PI * r * r * (2 * r + 1);
      case 'sphere':
      default:
        return (4 / 3) * Math.PI * r * r * r;
    }
  }

  // ------------------------------------------------------------------ 内部

  private resolveMode(mode: BrushMode, invert: boolean): BrushMode {
    if (!invert) return mode;
    switch (mode) {
      case 'raise':
        return 'lower';
      case 'lower':
        return 'raise';
      case 'paint':
        return 'erase';
      case 'dig':
        return 'paint';
      case 'fillWater':
        return 'erase';
      default:
        return mode;
    }
  }

  /** 笔刷中心的体素坐标：沿指定方向从命中格往外挪一格 */
  private resolveCenter(
    hit: VoxelHit,
    direction: BrushDirection,
    cameraDirection?: readonly [number, number, number],
  ): { x: number; y: number; z: number } {
    switch (direction) {
      case 'up':
        return { x: hit.x, y: hit.y + 1, z: hit.z };
      case 'down':
        return { x: hit.x, y: hit.y - 1, z: hit.z };
      case 'camera': {
        if (!cameraDirection) return { x: hit.x, y: hit.y, z: hit.z };
        // 取相机朝向里绝对值最大的那个轴，作为"往里推一格"的方向
        const [dx, dy, dz] = cameraDirection;
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        const az = Math.abs(dz);
        if (ay >= ax && ay >= az) return { x: hit.x, y: hit.y + (dy < 0 ? 1 : -1), z: hit.z };
        if (ax >= az) return { x: hit.x + (dx < 0 ? 1 : -1), y: hit.y, z: hit.z };
        return { x: hit.x, y: hit.y, z: hit.z + (dz < 0 ? 1 : -1) };
      }
      case 'normal':
      default:
        return { x: hit.x + hit.nx, y: hit.y + hit.ny, z: hit.z + hit.nz };
    }
  }

  /**
   * 遍历形状覆盖的**列**（用于按列操作的笔刷）。
   * 回调收到 (dx, dz, 归一化距离 t)，t ∈ [0,1]，1 表示圆心。
   */
  private forEachColumn(
    shape: BrushShape,
    radius: number,
    center: { x: number; z: number },
    callback: (x: number, z: number, t: number) => void,
  ): void {
    const grid = this.grid;
    const ri = Math.ceil(radius);

    if (shape === 'single') {
      callback(center.x, center.z, 1);
      return;
    }

    for (let dz = -ri; dz <= ri; dz++) {
      for (let dx = -ri; dx <= ri; dx++) {
        let distance: number;
        let t: number;
        if (shape === 'cube') {
          distance = Math.max(Math.abs(dx), Math.abs(dz));
          t = 1 - distance / radius;
        } else if (shape === 'cylinder' || shape === 'plane') {
          distance = Math.hypot(dx, dz);
          if (distance > radius) continue;
          t = 1 - distance / radius;
        } else {
          distance = Math.hypot(dx, dz);
          if (distance > radius) continue;
          t = 1 - distance / radius;
        }
        if (t < 0) continue;
        const x = center.x + dx;
        const z = center.z + dz;
        if (!grid.inHorizontalBounds(x, z)) continue;
        callback(x, z, t);
      }
    }
  }

  /** 遍历形状覆盖的**体素**（用于按体积操作的笔刷） */
  private forEachVoxel(
    shape: BrushShape,
    radius: number,
    center: { x: number; y: number; z: number },
    callback: (x: number, y: number, z: number, t: number) => void,
  ): void {
    const grid = this.grid;
    const ri = Math.ceil(radius);

    if (shape === 'single') {
      if (grid.inBounds(center.x, center.y, center.z)) callback(center.x, center.y, center.z, 1);
      return;
    }

    for (let dy = -ri; dy <= ri; dy++) {
      for (let dz = -ri; dz <= ri; dz++) {
        for (let dx = -ri; dx <= ri; dx++) {
          let distance: number;
          if (shape === 'cube') {
            distance = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
          } else if (shape === 'cylinder') {
            const horizontal = Math.hypot(dx, dz);
            if (horizontal > radius) continue;
            distance = Math.max(horizontal, Math.abs(dy));
          } else if (shape === 'plane') {
            if (dy !== 0) continue;
            distance = Math.hypot(dx, dz);
          } else {
            distance = Math.hypot(dx, dy, dz);
          }
          if (distance > radius) continue;

          const x = center.x + dx;
          const y = center.y + dy;
          const z = center.z + dz;
          if (!grid.inBounds(x, y, z)) continue;
          callback(x, y, z, 1 - distance / radius);
        }
      }
    }
  }

  /** 抬升 / 下沉：按列加高或削低 */
  private applyColumnShift(
    changes: ChangeSet,
    settings: BrushSettings,
    center: { x: number; y: number; z: number },
    radius: number,
    direction: 1 | -1,
  ): void {
    const rnd = this.rnd;
    const material = settings.material;
    const maxY = this.grid.sizeY - 1;

    this.forEachColumn(settings.shape, radius, center, (x, z, t) => {
      const falloff = falloffAt(t, settings.falloff);
      if (falloff <= 0) return;
      const amount = stochasticRound(falloff * settings.strength * MAX_COLUMN_AMOUNT, rnd);
      if (amount <= 0) return;

      const surface = this.grid.surfaceHeight(x, z);

      if (direction > 0) {
        const start = Math.max(WORLD_CONFIG.bedrockY + 1, surface + 1);
        const end = Math.min(surface + amount, maxY);
        for (let y = start; y <= end; y++) {
          if (this.grid.getVoxel(x, y, z) === AIR) changes.setVoxel(x, y, z, material);
        }
      } else {
        const from = Math.max(WORLD_CONFIG.bedrockY + 1, surface - amount + 1);
        for (let y = from; y <= surface; y++) changes.setVoxel(x, y, z, AIR);
      }
    });
  }

  /**
   * 平滑 / 抹平：让每列高度朝目标靠拢。
   * 先快照高度再统一写入，避免"边算边改"的连锁误差。
   */
  private applyRelax(
    changes: ChangeSet,
    settings: BrushSettings,
    center: { x: number; y: number; z: number },
    radius: number,
    goal: 'neighbor' | 'center',
    hit: VoxelHit,
  ): void {
    const rnd = this.rnd;
    const maxY = this.grid.sizeY - 1;
    const columns: Array<{ x: number; z: number; h: number; falloff: number }> = [];

    this.forEachColumn(settings.shape, radius, center, (x, z, t) => {
      columns.push({ x, z, h: this.grid.surfaceHeight(x, z), falloff: falloffAt(t, settings.falloff) });
    });
    if (columns.length === 0) return;

    // 抹平的目标高度：优先用命中格所在列，其次用笔刷中心列
    const centerHeight =
      goal === 'center'
        ? Math.max(this.grid.surfaceHeight(hit.x, hit.z), this.grid.surfaceHeight(center.x, center.z))
        : -1;
    if (goal === 'center' && centerHeight < 0) return;

    for (const column of columns) {
      if (column.h < 0) continue;

      let target: number;
      if (goal === 'center') {
        target = centerHeight;
      } else {
        let sum = 0;
        let count = 0;
        for (let oz = -1; oz <= 1; oz++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oz === 0) continue;
            const nh = this.grid.surfaceHeight(column.x + ox, column.z + oz);
            if (nh >= 0) {
              sum += nh;
              count++;
            }
          }
        }
        target = count > 0 ? sum / count : column.h;
      }

      const weighted = column.h + (target - column.h) * column.falloff * settings.strength;
      const newHeight = Math.max(
        WORLD_CONFIG.bedrockY + 1,
        Math.min(maxY, Math.round(weighted)),
      );
      this.moveColumn(changes, settings, column.x, column.z, column.h, newHeight, rnd);
    }
  }

  /** 顶点捕捉：把地表吸附到固定的台阶高度上，快速做出平台与阶梯地形 */
  private applySnap(
    changes: ChangeSet,
    settings: BrushSettings,
    center: { x: number; y: number; z: number },
    radius: number,
  ): void {
    const rnd = this.rnd;
    const maxY = this.grid.sizeY - 1;

    this.forEachColumn(settings.shape, radius, center, (x, z, t) => {
      const falloff = falloffAt(t, settings.falloff);
      if (falloff < 0.3) return; // 边缘不动，中间才吸附
      const h = this.grid.surfaceHeight(x, z);
      if (h < 0) return;
      const snapped = Math.round(h / SNAP_STEP) * SNAP_STEP;
      if (snapped === h) return;
      const target = Math.max(
        WORLD_CONFIG.bedrockY + 1,
        Math.min(maxY, Math.round(h + (snapped - h) * settings.strength)),
      );
      this.moveColumn(changes, settings, x, z, h, target, rnd);
    });
  }

  /** 把一列从 fromHeight 变成 toHeight（多退少补） */
  private moveColumn(
    changes: ChangeSet,
    settings: BrushSettings,
    x: number,
    z: number,
    fromHeight: number,
    toHeight: number,
    rnd: () => number,
  ): void {
    if (toHeight === fromHeight) return;
    if (toHeight > fromHeight) {
      const surfaceType = this.grid.getVoxel(x, fromHeight, z);
      const fillType = surfaceType === AIR ? settings.material : surfaceType;
      for (let y = fromHeight + 1; y <= toHeight; y++) {
        if (this.grid.getVoxel(x, y, z) === AIR) {
          if (rnd() <= Math.max(0.15, settings.density)) changes.setVoxel(x, y, z, fillType);
        }
      }
    } else {
      for (let y = toHeight + 1; y <= fromHeight; y++) {
        if (rnd() <= Math.max(0.15, settings.density)) changes.setVoxel(x, y, z, AIR);
      }
    }
  }

  /** 按体积操作：材质刷 / 挖洞 / 擦除 / 填水 */
  private applyVolume(
    changes: ChangeSet,
    settings: BrushSettings,
    center: { x: number; y: number; z: number },
    radius: number,
    mode: BrushMode,
  ): void {
    const rnd = this.rnd;
    const density = Math.max(0, Math.min(1, settings.density));

    this.forEachVoxel(settings.shape, radius, center, (x, y, z, t) => {
      const falloff = falloffAt(t, settings.falloff);
      if (falloff <= 0) return;
      // 密度与衰减共同决定概率：边缘更稀，符合"刷子"的感觉
      if (rnd() > density * Math.max(0.25, falloff)) return;

      const current = this.grid.getVoxel(x, y, z);
      switch (mode) {
        case 'paint':
          if (current !== AIR && current !== settings.material) changes.setVoxel(x, y, z, settings.material);
          break;
        case 'dig':
          // 挖洞：只挖实心方块，留下的水不会突然消失
          if (current !== AIR && getVoxelDef(current).solid) changes.setVoxel(x, y, z, AIR);
          break;
        case 'erase':
          // 擦除：连水一起清掉
          if (current !== AIR) changes.setVoxel(x, y, z, AIR);
          break;
        case 'fillWater':
          if (current === AIR) changes.setWater(x, y, z, 1);
          break;
        default:
          break;
      }
    });
  }

  /**
   * 噪声刷：按三维噪声决定"补一块还是挖一块"，
   * 用来把平台表面打成粗糙的岩石感，或者反过来把坑洼填平。
   */
  private applyNoise(
    changes: ChangeSet,
    settings: BrushSettings,
    center: { x: number; y: number; z: number },
    radius: number,
  ): void {
    const material = settings.material;
    const seed = this.strokeSeed & 0xffff;

    this.forEachVoxel(settings.shape, radius, center, (x, y, z, t) => {
      const falloff = falloffAt(t, settings.falloff);
      if (falloff <= 0) return; // 注意：回调里不能用 continue

      // 哈希噪声：同一笔里稳定，换一笔就变
      const n = hash3(x, y, z, seed);
      const signed = (n - 0.5) * 2; // -1 ~ 1
      const threshold = (1 - settings.density) * 0.9;
      if (Math.abs(signed) < threshold) return;

      const current = this.grid.getVoxel(x, y, z);
      const amount = falloff * settings.strength;
      if (signed > 0 && current === AIR && amount > 0.1) {
        if (hash3(x + 7, y + 3, z + 11, seed) < amount) changes.setVoxel(x, y, z, material);
      } else if (signed < 0 && current !== AIR && getVoxelDef(current).solid) {
        if (hash3(x + 13, y + 5, z + 17, seed) < amount) changes.setVoxel(x, y, z, AIR);
      }
    });
  }

  /**
   * 边缘软化：形态学"开运算"的简化版 ——
   * 把孤立的凸块削掉、把窄缝填上，于是平台边缘和斜坡过渡更自然。
   */
  private applySoften(
    changes: ChangeSet,
    settings: BrushSettings,
    center: { x: number; y: number; z: number },
    radius: number,
  ): void {
    const material = settings.material;
    const operations: Array<{ x: number; y: number; z: number; id: number }> = [];

    this.forEachVoxel(settings.shape, radius, center, (x, y, z, t) => {
      const falloff = falloffAt(t, settings.falloff);
      if (falloff < settings.strength * 0.5) return;
      if (y <= WORLD_CONFIG.bedrockY) return;

      const current = this.grid.getVoxel(x, y, z);
      const solid = current !== AIR && getVoxelDef(current).solid;

      // 统计同一层 4 个水平邻居的实心情况
      let solidNeighbors = 0;
      const neighbors: number[] = [];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const id = this.grid.getVoxel(x + dx, y, z + dz);
        neighbors.push(id);
        if (id !== AIR && getVoxelDef(id).solid) solidNeighbors++;
      }

      if (solid && solidNeighbors <= 1) {
        operations.push({ x, y, z, id: AIR }); // 孤立凸块 → 削掉
      } else if (!solid && current === AIR && solidNeighbors >= 3) {
        operations.push({ x, y, z, id: material }); // 窄缝 → 填上
      }
    });

    for (const op of operations) changes.setVoxel(op.x, op.y, op.z, op.id);
  }
}

/** 三维整数哈希 → 0~1 */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1442695040888963407) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}
