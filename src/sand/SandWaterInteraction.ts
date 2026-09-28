/**
 * 沙水交互（M4 第二部分 · 第 5 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 这一层把"沙"和"流体"两套系统接起来，做四件事
 * ────────────────────────────────────────────────────────────
 * 1. **变湿**：粒子流体盖住的沙会吸水（调用 `SandSystem.moistenFromFluid`）。
 *    湿沙的安息角变陡（45°），饱和沙变平（15°）—— 这在第 3 批已经实现了，
 *    这里做的是"把水的存在告诉沙"。
 * 2. **侵蚀（泥流）**：水流够快、且沙已经湿透时，沙格会被冲走 ——
 *    沙格变空气，同时往流体里加几个粒子（"沙被冲起来变成了浑水"）。
 * 3. **沉积**：水流慢下来之后，浑水里的粒子会**落回去变成沙**。
 *    这是侵蚀的反过程，两者合起来才是"泥流"该有的样子（冲走 → 淤积）。
 * 4. **沙掩埋建筑与压塌**：数一栋建筑上方/周围压了多少格沙，
 *    超过阈值就报告"要被压塌了"，并把载荷交给调用方（Engine）去决定要不要弄塌。
 *
 * ────────────────────────────────────────────────────────────
 * 三处必须写明白的取舍
 * ────────────────────────────────────────────────────────────
 * 1. **体素 ↔ 粒子的换算不守恒**。1 立方米体素按静止间距算应该是 244 个粒子，
 *    但那样"冲掉一格沙"就会瞬间多出 244 个粒子 —— 几百格就是上限爆掉。
 *    所以这里用一个**观感换算**（默认 1 格 → 6 个粒子）。
 *    代价是"冲走的沙"在流体里比实际少得多（浑水看起来偏淡）；
 *    收益是它能稳定地跑，而不是一冲就崩。这一条写进 README。
 * 2. **侵蚀是概率事件**（`erodeRate × dt`），不是确定性阈值。
 *    确定性地"到速度就冲走"会让河床在一瞬间被削平，看起来像 bug；
 *    概率化之后表现是"水慢慢把岸边啃掉"。
 * 3. **压塌是启发式**：载荷阈值是从"稳定性 = f(湿度, 载荷, 坡度)"反推的经验值，
 *    不是结构力学。它保证"沙压得够多就会塌"，不保证"塌在正确的格子上"。
 */

import type { VoxelGrid } from '../voxel/VoxelGrid';
import { AIR, getVoxelId } from '../data/voxelTypes';
import type { SandSystem } from './SandSystem';
import { MOISTURE_SATURATED } from './SandPhysics';

const SAND = getVoxelId('sand');

export interface SandWaterConfig {
  /** 侵蚀的流速阈值（米/秒）：低于它不会冲走沙 */
  erodeSpeed: number;
  /** 侵蚀速率（每秒，满概率）：每个候选格每帧被冲走的概率 = 速率 × dt */
  erodeRate: number;
  /** 冲掉一格沙往流体里加多少粒子（观感换算，见文件头第 1 条） */
  particlesPerErodedCell: number;
  /** 侵蚀要求的最低湿度（干沙不会被水冲走，湿沙才成泥流） */
  erodeMinMoisture: number;
  /** 沉积的流速阈值（米/秒）：低于它才会淤积 */
  depositSpeed: number;
  /** 沉积速率（每秒） */
  depositRate: number;
  /** 沉积一格要吃掉几个粒子（与 particlesPerErodedCell 不必相等 —— 淤积比冲刷"黏"） */
  particlesPerDepositedCell: number;
  /** 吸水速率（每秒）：流体盖住的沙每帧湿润多少 */
  moistenRate: number;
  /** 每帧最多处理多少个流体格（分帧预算） */
  maxCellsPerFrame: number;
  /** 建筑被压塌的载荷阈值（格）：上方压了多少格沙 */
  burialLoadThreshold: number;
}

export const DEFAULT_SAND_WATER_CONFIG: SandWaterConfig = {
  erodeSpeed: 1.6,
  erodeRate: 0.9,
  particlesPerErodedCell: 6,
  erodeMinMoisture: 0.55,
  depositSpeed: 0.35,
  depositRate: 0.5,
  particlesPerDepositedCell: 3,
  moistenRate: 1.4,
  maxCellsPerFrame: 1500,
  burialLoadThreshold: 18,
};

export interface SandWaterStats {
  /** 检查了多少个流体格 */
  cells: number;
  /** 湿润了多少格沙 */
  moistened: number;
  /** 冲掉了多少格沙 */
  eroded: number;
  /** 因为侵蚀而加进流体的粒子数 */
  erodedParticles: number;
  /** 沉积了多少格沙 */
  deposited: number;
  /** 因为沉积而移除的粒子数 */
  depositedParticles: number;
  /** 是否因为预算被截断（true = 这一帧没处理完所有流体格） */
  truncated: boolean;
  /** 耗时（毫秒） */
  ms: number;
}

/** 被沙压住的建筑（第 5 批的报告项；压塌由调用方决定） */
export interface BuriedBuilding {
  ownerId: number;
  /** 上方压了多少格沙 */
  load: number;
  /** 载荷 / 阈值（≥1 表示超过阈值） */
  ratio: number;
  /** 沙压的中心（世界坐标） */
  center: { x: number; y: number; z: number };
  /** 这句话直接用中文念出来 */
  detail: string;
}

/** 流体侧需要暴露的最小接口（方便测试注入假的流体） */
export interface ErodibleFluid {
  /** 流体场：遍历有流体的格子 */
  forEachOccupiedCell(fn: (x: number, y: number, z: number, fullness: number, velocity: { x: number; y: number; z: number }) => void): void;
  /** 往流体里加粒子（侵蚀用）。@returns 实际加入的数量 */
  addParticles(x: number, y: number, z: number, count: number): number;
  /** 从流体里移除粒子（沉积用）。@returns 实际移除的数量 */
  removeParticles(x: number, y: number, z: number, radius: number): number;
  /** 当前粒子数（沉积要求"水里得有粒子"） */
  readonly particleCount: number;
}

/** 建筑侧需要暴露的最小接口（引擎里的 BuildingInstance 能满足） */
export interface BuriableBuilding {
  ownerId: number;
  center: { x: number; y: number; z: number };
  half: { x: number; y: number; z: number };
  /** 是否静态（静态的才谈"被压塌"；动态的本来就会掉） */
  isStatic: boolean;
}

export class SandWaterInteraction {
  private config: SandWaterConfig;
  private lastStats: SandWaterStats = {
    cells: 0, moistened: 0, eroded: 0, erodedParticles: 0, deposited: 0, depositedParticles: 0, truncated: false, ms: 0,
  };
  private randomState = 0x9e3779b9;

  constructor(config: Partial<SandWaterConfig> = {}) {
    this.config = { ...DEFAULT_SAND_WATER_CONFIG, ...config };
  }

  get settings(): SandWaterConfig {
    return this.config;
  }

  get stats(): SandWaterStats {
    return this.lastStats;
  }

  setConfig(partial: Partial<SandWaterConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /** 内部随机数（自实现 mulberry32；固定种子保证同一场景可复现） */
  private random(): number {
    this.randomState = (this.randomState + 0x6d2b79f5) >>> 0;
    let t = this.randomState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * 推进一次沙水交互。
   *
   * @param dt 步长（秒）。水分与侵蚀速率都按秒算 —— 传帧间隔的话帧率一变行为就变
   */
  update(input: {
    grid: VoxelGrid;
    sand: SandSystem;
    fluid: ErodibleFluid;
    dt: number;
    /** 期望的流体静止间距的立方（换算粒子与体素用；默认按 0.16 米） */
    particleVolume?: number;
  }): SandWaterStats {
    const started = now();
    const { grid, sand, fluid, dt } = input;
    const config = this.config;
    const clampedDt = Math.max(0, Math.min(0.1, dt));
    let cells = 0;
    let moistened = 0;
    let eroded = 0;
    let erodedParticles = 0;
    let deposited = 0;
    let depositedParticles = 0;
    let truncated = false;

    fluid.forEachOccupiedCell((cx, cy, cz, fullness, velocity) => {
      if (cells >= config.maxCellsPerFrame) {
        truncated = true;
        return;
      }
      cells += 1;
      if (fullness < 0.25) return; // 太稀的格子（飞溅的水花）不参与交互

      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
      // 检查格子中心与它下方一格：水"盖住"的沙通常在这两个位置
      const candidates: [number, number, number][] = [
        [Math.floor(cx), Math.floor(cy), Math.floor(cz)],
        [Math.floor(cx), Math.floor(cy) - 1, Math.floor(cz)],
      ];

      for (const [vx, vy, vz] of candidates) {
        if (!grid.inBounds(vx, vy, vz)) continue;
        const id = grid.getVoxel(vx, vy, vz);
        if (id === SAND) {
          // ---- 1) 变湿：水盖着沙就吸水
          const moisture = sand.moistureAt(vx, vy, vz);
          if (moisture < 1) {
            const amount = config.moistenRate * fullness * clampedDt;
            if (sand.moistenFromFluid(vx, vy, vz, amount)) moistened += 1;
          }
          // ---- 2) 侵蚀：水流够快 + 沙够湿 → 冲走
          const currentMoisture = sand.moistureAt(vx, vy, vz);
          if (speed > config.erodeSpeed && currentMoisture >= config.erodeMinMoisture) {
            // 概率化：确定性阈值会让河床一瞬间被削平
            const chance = config.erodeRate * clampedDt * Math.min(2, speed / config.erodeSpeed);
            if (this.random() < chance) {
              grid.setVoxel(vx, vy, vz, AIR);
              const added = fluid.addParticles(vx + 0.5, vy + 0.5, vz + 0.5, config.particlesPerErodedCell);
              eroded += 1;
              erodedParticles += added;
            }
          }
        } else if (id === AIR && vy > 0) {
          // ---- 3) 沉积：水流很慢 + 水里还有粒子 → 落下变成沙
          //
          // 要求"下方是固体"（沙不会悬空淤积），并且要有水（否则是空气里的粒子，
          // 那是飞溅的水珠，不该变成沙）
          if (speed <= config.depositSpeed && fluid.particleCount > 0 && fullness > 0.3) {
            const below = grid.getVoxel(vx, vy - 1, vz);
            if (below !== AIR) {
              const chance = config.depositRate * clampedDt;
              if (this.random() < chance) {
                const removed = fluid.removeParticles(vx + 0.5, vy + 0.5, vz + 0.5, 0.5);
                if (removed > 0) {
                  grid.setVoxel(vx, vy, vz, SAND);
                  // 沉积下来的沙是**饱和**的（它刚从水里出来）
                  sand.setMoisture(vx, vy, vz, MOISTURE_SATURATED);
                  sand.markActive(vx, vy, vz);
                  deposited += 1;
                  depositedParticles += removed;
                }
              }
            }
          }
        }
      }
    });

    this.lastStats = {
      cells, moistened, eroded, erodedParticles, deposited, depositedParticles, truncated,
      ms: now() - started,
    };
    return this.lastStats;
  }

  /**
   * 统计被沙压住的建筑（第 5 批的"沙掩埋建筑与压塌"）。
   *
   * 载荷 = 建筑顶面以上、建筑水平范围内的**沙格数**（只往上数 12 格 ——
   * 再多的沙对"压塌"没有额外意义，而往上数到天花板在大档是白扫）。
   *
   * ⚠ 这是**启发式**：它不区分"沙压在承重墙上"还是"沙压在屋顶边缘"，
   * 也不算力矩。阈值是从稳定性公式反推的经验值。README 的取舍清单里有这一条。
   */
  collectBuriedBuildings(
    grid: VoxelGrid,
    buildings: readonly BuriableBuilding[],
    loadThreshold = this.config.burialLoadThreshold,
  ): BuriedBuilding[] {
    const out: BuriedBuilding[] = [];
    for (const building of buildings) {
      if (!building.isStatic) continue;
      const minX = Math.floor(building.center.x - building.half.x);
      const maxX = Math.ceil(building.center.x + building.half.x);
      const minZ = Math.floor(building.center.z - building.half.z);
      const maxZ = Math.ceil(building.center.z + building.half.z);
      const topY = Math.floor(building.center.y + building.half.y);
      let load = 0;
      for (let y = topY; y < Math.min(grid.sizeY, topY + 12); y += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
          for (let x = minX; x <= maxX; x += 1) {
            if (!grid.inBounds(x, y, z)) continue;
            if (grid.getVoxel(x, y, z) === SAND) load += 1;
          }
        }
      }
      if (load === 0) continue;
      const ratio = load / Math.max(1, loadThreshold);
      out.push({
        ownerId: building.ownerId,
        load,
        ratio,
        center: { ...building.center },
        detail:
          ratio >= 1
            ? `建筑 #${building.ownerId} 顶上有 ${load} 格沙（阈值 ${loadThreshold}）—— 会被压塌`
            : `建筑 #${building.ownerId} 顶上有 ${load} 格沙（阈值 ${loadThreshold}）—— 还在承受范围内`,
      });
    }
    return out;
  }

  /**
   * 压塌的判定：**只有超过阈值的**才返回，并且按载荷从大到小排序。
   *
   * 排序是有意义的：一帧里如果有三栋房子同时超阈值，先塌哪一栋在视觉上
   * 应该由"压得最狠的那栋"开始（那也正是玩家预期看到的顺序）。
   */
  findCollapsing(buried: readonly BuriedBuilding[]): BuriedBuilding[] {
    return buried.filter((item) => item.ratio >= 1).sort((a, b) => b.ratio - a.ratio);
  }

  describe(): string {
    const s = this.lastStats;
    return (
      `沙水交互：流体格 ${s.cells}｜湿润 ${s.moistened}｜冲走 ${s.eroded} 格（+${s.erodedParticles} 粒子）｜` +
      `淤积 ${s.deposited} 格（−${s.depositedParticles} 粒子）｜${s.ms.toFixed(2)} ms` +
      (s.truncated ? '｜⚠ 触发分帧预算（这一帧没处理完）' : '')
    );
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
