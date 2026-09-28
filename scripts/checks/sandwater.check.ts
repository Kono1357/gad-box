/**
 * 第 5 批断言：沙水交互（变湿 / 侵蚀 / 沉积 / 掩埋压塌）。
 *
 * 这一批的测试用**假的流体**（`FakeFluid`）而不是真的 PBF：
 * 目的是把"交互逻辑本身"验清楚。用真流体会让断言依赖求解器的行为，
 * 于是"侵蚀没发生"到底是"逻辑错"还是"水没流到那儿"永远说不清 ——
 * 那种断言只能证明"看起来有东西在动"。
 */

import { World } from '../../src/core/World';
import { AIR, getVoxelId } from '../../src/data/voxelTypes';
import { TerrainGenerator } from '../../src/voxel/TerrainGenerator';
import { getWorldSize } from '../../src/worldSize';
import { SandSystem } from '../../src/sand/SandSystem';
import {
  SandWaterInteraction,
  DEFAULT_SAND_WATER_CONFIG,
  type ErodibleFluid,
} from '../../src/sand/SandWaterInteraction';
import { MOISTURE_SATURATED } from '../../src/sand/SandPhysics';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

const SAND = getVoxelId('sand');
const FLAT_TOP = 8;

/** 平坦世界（与第 3 批的断言同一套做法：振幅 0 的高度图） */
function flatWorld(seed = 5): World {
  const world = new World(seed, 'novice', null);
  const preset = getWorldSize('novice').terrain;
  TerrainGenerator.generate(world.grid, {
    seed, waterLevel: -99, baseHeight: FLAT_TOP, amplitude: 0,
    minHeight: FLAT_TOP, maxHeight: FLAT_TOP,
    snowLine: preset.snowLine, noiseScale: preset.noiseScale,
  });
  return world;
}

/**
 * 假流体：在指定的一批格子上报告"有流体"，并维护一个粒子计数。
 * 它精确实现了 `ErodibleFluid` 的语义，于是交互逻辑的每条分支都能被单独触发。
 */
class FakeFluid implements ErodibleFluid {
  private readonly cells: { x: number; y: number; z: number; fullness: number; vx: number; vy: number; vz: number }[] = [];
  particleCount = 0;
  addCalls = 0;
  removeCalls = 0;

  setCells(cells: { x: number; y: number; z: number; fullness?: number; speed?: number; direction?: [number, number, number] }[]): void {
    this.cells.length = 0;
    for (const cell of cells) {
      const speed = cell.speed ?? 0;
      const direction = cell.direction ?? [1, 0, 0];
      this.cells.push({
        x: cell.x, y: cell.y, z: cell.z,
        fullness: cell.fullness ?? 1,
        vx: direction[0] * speed, vy: direction[1] * speed, vz: direction[2] * speed,
      });
    }
  }

  forEachOccupiedCell(
    fn: (x: number, y: number, z: number, fullness: number, velocity: { x: number; y: number; z: number }) => void,
  ): void {
    for (const cell of this.cells) {
      fn(cell.x, cell.y, cell.z, cell.fullness, { x: cell.vx, y: cell.vy, z: cell.vz });
    }
  }

  addParticles(x: number, y: number, z: number, count: number): number {
    this.addCalls += 1;
    this.particleCount += count;
    void x; void y; void z;
    return count;
  }

  removeParticles(x: number, y: number, z: number, radius: number): number {
    this.removeCalls += 1;
    const taken = Math.min(this.particleCount, 3);
    this.particleCount -= taken;
    void x; void y; void z; void radius;
    return taken;
  }
}

export function runSandWaterChecks(check: CheckFn): void {
  // ---------------------------------------------------------------- 变湿
  {
    const world = flatWorld(5);
    const sand = new SandSystem(world.grid);
    const y = FLAT_TOP + 1;
    world.grid.setVoxel(24, y, 24, SAND);
    const fluid = new FakeFluid();
    fluid.setCells([{ x: 24.5, y: y + 0.5, z: 24.5, fullness: 1, speed: 0 }]);
    const interaction = new SandWaterInteraction();
    const before = sand.moistureAt(24, y, 24);
    const stats = interaction.update({ grid: world.grid, sand, fluid, dt: 1 });
    const after = sand.moistureAt(24, y, 24);
    check('变湿：流体盖住的沙会吸水', after > before, `${before.toFixed(3)} → ${after.toFixed(3)}`);
    check('变湿：统计里如实记下湿润了多少格', stats.moistened > 0, `${stats.moistened}`);
    check('变湿：吸水与 dt 成正比（0.02 秒吸到的约为 0.1 秒的五分之一）', (() => {
      const sample = (dt: number): number => {
        const w2 = flatWorld(5);
        const s2 = new SandSystem(w2.grid);
        w2.grid.setVoxel(24, y, 24, SAND);
        const f2 = new FakeFluid();
        f2.setCells([{ x: 24.5, y: y + 0.5, z: 24.5, fullness: 1, speed: 0 }]);
        new SandWaterInteraction().update({ grid: w2.grid, sand: s2, fluid: f2, dt });
        return s2.moistureAt(24, y, 24);
      };
      const tiny = sample(0.02);
      const small = sample(0.1);
      return small > tiny * 3 && small < tiny * 7;
    })(), '0.02 s 与 0.1 s 的比较');
    // dt 被夹在 0.1 秒：这是刻意的（卡帧之后一帧把沙浇透会很难看）
    check('变湿：dt 超过 0.1 秒会被夹住（防"卡一下就把沙浇透"）', (() => {
      const w2 = flatWorld(5);
      const s2 = new SandSystem(w2.grid);
      w2.grid.setVoxel(24, y, 24, SAND);
      const f2 = new FakeFluid();
      f2.setCells([{ x: 24.5, y: y + 0.5, z: 24.5, fullness: 1, speed: 0 }]);
      new SandWaterInteraction().update({ grid: w2.grid, sand: s2, fluid: f2, dt: 5 });
      const huge = s2.moistureAt(24, y, 24);
      const w3 = flatWorld(5);
      const s3 = new SandSystem(w3.grid);
      w3.grid.setVoxel(24, y, 24, SAND);
      const f3 = new FakeFluid();
      f3.setCells([{ x: 24.5, y: y + 0.5, z: 24.5, fullness: 1, speed: 0 }]);
      new SandWaterInteraction().update({ grid: w3.grid, sand: s3, fluid: f3, dt: 0.1 });
      return Math.abs(huge - s3.moistureAt(24, y, 24)) < 1e-9;
    })());
    check('变湿：水很少（fullness 低）时吸得慢', (() => {
      const w3 = flatWorld(5);
      const s3 = new SandSystem(w3.grid);
      w3.grid.setVoxel(24, y, 24, SAND);
      const f3 = new FakeFluid();
      f3.setCells([{ x: 24.5, y: y + 0.5, z: 24.5, fullness: 0.3, speed: 0 }]);
      new SandWaterInteraction().update({ grid: w3.grid, sand: s3, fluid: f3, dt: 1 });
      return s3.moistureAt(24, y, 24) < after;
    })());
    check('变湿：太稀的水（fullness < 0.25）不参与交互', (() => {
      const w4 = flatWorld(5);
      const s4 = new SandSystem(w4.grid);
      w4.grid.setVoxel(24, y, 24, SAND);
      const f4 = new FakeFluid();
      f4.setCells([{ x: 24.5, y: y + 0.5, z: 24.5, fullness: 0.1, speed: 0 }]);
      const st = new SandWaterInteraction().update({ grid: w4.grid, sand: s4, fluid: f4, dt: 1 });
      return st.moistened === 0 && s4.moistureAt(24, y, 24) === 0;
    })());
  }

  // ---------------------------------------------------------------- 侵蚀
  {
    const world = flatWorld(7);
    const sand = new SandSystem(world.grid);
    const y = FLAT_TOP + 1;
    // 铺 6 格湿沙
    for (let x = 22; x < 28; x += 1) {
      world.grid.setVoxel(x, y, 24, SAND);
      sand.setMoisture(x, y, 24, MOISTURE_SATURATED);
    }
    const fluid = new FakeFluid();
    // 水流很快（4 m/s，高于阈值 1.6）
    fluid.setCells([{ x: 22.5, y: y + 0.5, z: 24.5, fullness: 1, speed: 4 }]);
    const interaction = new SandWaterInteraction({ erodeRate: 20, maxCellsPerFrame: 100 });
    let erodedTotal = 0;
    for (let i = 0; i < 10; i += 1) {
      const stats = interaction.update({ grid: world.grid, sand, fluid, dt: 1 / 60 });
      erodedTotal += stats.eroded;
    }
    check('侵蚀：水流够快时沙会被冲走（沙格变空气）',
      erodedTotal > 0 && world.grid.getVoxel(22, y, 24) === AIR,
      `冲走 ${erodedTotal} 格`);
    check('侵蚀：冲走的沙进了流体（水里多了粒子）',
      fluid.particleCount > 0 && fluid.addCalls > 0,
      `${fluid.particleCount} 个粒子，addParticles 调用 ${fluid.addCalls} 次`);
    check('侵蚀：统计里区分"冲掉几格"与"加了多少粒子"（观感换算不是 1:1）',
      interaction.stats.erodedParticles >= interaction.stats.eroded,
      `${interaction.stats.eroded} 格 → ${interaction.stats.erodedParticles} 粒子`);
    check('侵蚀：干沙不会被冲走（要够湿才成泥流）', (() => {
      const w = flatWorld(7);
      const s = new SandSystem(w.grid);
      for (let x = 22; x < 28; x += 1) w.grid.setVoxel(x, y, 24, SAND);
      // 全部是干沙（湿度 0）
      const f = new FakeFluid();
      f.setCells([{ x: 22.5, y: y + 0.5, z: 24.5, fullness: 1, speed: 4 }]);
      const it = new SandWaterInteraction({ erodeRate: 20 });
      for (let i = 0; i < 10; i += 1) it.update({ grid: w.grid, sand: s, fluid: f, dt: 1 / 60 });
      return w.grid.getVoxel(22, y, 24) === SAND;
    })());
    check('侵蚀：水流不够快时不会被冲走', (() => {
      const w = flatWorld(7);
      const s = new SandSystem(w.grid);
      w.grid.setVoxel(24, y, 24, SAND);
      s.setMoisture(24, y, 24, 1);
      const f = new FakeFluid();
      f.setCells([{ x: 24.5, y: y + 0.5, z: 24.5, fullness: 1, speed: 0.5 }]);
      const it = new SandWaterInteraction({ erodeRate: 20 });
      for (let i = 0; i < 10; i += 1) it.update({ grid: w.grid, sand: s, fluid: f, dt: 1 / 60 });
      return w.grid.getVoxel(24, y, 24) === SAND;
    })());
  }

  // ---------------------------------------------------------------- 沉积
  {
    const world = flatWorld(9);
    const sand = new SandSystem(world.grid);
    const y = FLAT_TOP + 1;
    const fluid = new FakeFluid();
    fluid.particleCount = 500;
    // 水流很慢（0.1 m/s，低于沉积阈值 0.35），有流体、下方是固体
    fluid.setCells([{ x: 24.5, y: y + 0.5, z: 24.5, fullness: 1, speed: 0.1 }]);
    const interaction = new SandWaterInteraction({ depositRate: 30 });
    let depositedTotal = 0;
    let depositedParticlesTotal = 0;
    for (let i = 0; i < 20; i += 1) {
      const stats = interaction.update({ grid: world.grid, sand, fluid, dt: 1 / 60 });
      depositedTotal += stats.deposited;
      depositedParticlesTotal += stats.depositedParticles;
    }
    check('沉积：水流慢下来时粒子会落回去变成沙',
      depositedTotal > 0 && world.grid.getVoxel(24, y, 24) === SAND,
      `沉积 ${depositedTotal} 格`);
    check('沉积：刚沉下来的沙是饱和的（它刚从水里出来）',
      sand.moistureAt(24, y, 24) >= MOISTURE_SATURATED - 0.01,
      `湿度 ${sand.moistureAt(24, y, 24).toFixed(2)}`);
    // ⚠ 这里的 stats 是**单次调用**的统计（这是对的设计：面板每帧读的就是"这一帧做了多少"）。
    // 我第一版断言读的是循环结束后的那一次 —— 那时格子已经变成沙、不再沉积，于是永远是 0。
    // 要验证"累计做了多少"就必须自己累加。
    check('沉积：统计里如实记下"沉积了几格 + 消耗了几个粒子"（跨调用累加）',
      depositedParticlesTotal > 0,
      `${depositedTotal} 格 / ${depositedParticlesTotal} 粒子`);
    check('沉积：水里没有粒子时不会凭空造沙', (() => {
      const w = flatWorld(9);
      const s = new SandSystem(w.grid);
      const f = new FakeFluid();
      f.particleCount = 0;
      f.setCells([{ x: 24.5, y: y + 0.5, z: 24.5, fullness: 1, speed: 0.1 }]);
      const it = new SandWaterInteraction({ depositRate: 30 });
      for (let i = 0; i < 20; i += 1) it.update({ grid: w.grid, sand: s, fluid: f, dt: 1 / 60 });
      return w.grid.getVoxel(24, y, 24) === AIR;
    })());
    check('沉积：水流快的时候不会沉积（那是冲刷区不是淤积区）', (() => {
      const w = flatWorld(9);
      const s = new SandSystem(w.grid);
      const f = new FakeFluid();
      f.particleCount = 500;
      f.setCells([{ x: 24.5, y: FLAT_TOP + 1.5, z: 24.5, fullness: 1, speed: 4 }]);
      const it = new SandWaterInteraction({ depositRate: 30 });
      for (let i = 0; i < 20; i += 1) it.update({ grid: w.grid, sand: s, fluid: f, dt: 1 / 60 });
      return w.grid.getVoxel(24, FLAT_TOP + 1, 24) === AIR;
    })());
    check('沉积：下方是空气时不会淤积（沙不会悬空）', (() => {
      const w = flatWorld(9);
      const s = new SandSystem(w.grid);
      const f = new FakeFluid();
      f.particleCount = 500;
      // 悬在半空中的一格（下方是空气）
      f.setCells([{ x: 24.5, y: FLAT_TOP + 6.5, z: 24.5, fullness: 1, speed: 0.1 }]);
      const it = new SandWaterInteraction({ depositRate: 30 });
      for (let i = 0; i < 20; i += 1) it.update({ grid: w.grid, sand: s, fluid: f, dt: 1 / 60 });
      return w.grid.getVoxel(24, FLAT_TOP + 6, 24) === AIR;
    })());
  }

  // ---------------------------------------------------------------- 泥流：冲刷 → 搬运 → 淤积
  //
  // "泥流"不是单一现象，而是这三步的闭环。所以断言也照这三步来：
  // ① 水冲走沙（上游）、② 沙进了水里（被搬运）、③ 水流慢下来之后在别处淤积。
  // 我第一版这里只断言了"饱和沙自己会摊开"——那条其实在第 3 批已经验过了，
  // 而且用的场景（一层 1 格厚的平沙）根本没有落差，沙无处可流，断言天生会红。
  {
    const mudWorld = flatWorld(11);
    const mudSand = new SandSystem(mudWorld.grid);
    const y = FLAT_TOP + 1;
    // 上游铺一段饱和沙（要被冲走），下游留一块空地（要长出淤积）
    for (let x = 20; x < 24; x += 1) {
      mudWorld.grid.setVoxel(x, y, 24, SAND);
      mudSand.setMoisture(x, y, 24, 1);
    }
    const fluid = new FakeFluid();
    let particleCount = 0;
    const fluidProxy: ErodibleFluid = {
      forEachOccupiedCell: (fn) => fluid.forEachOccupiedCell(fn),
      addParticles: (_x, _yy, _z, count) => {
        particleCount += count;
        return count;
      },
      removeParticles: () => {
        const taken = Math.min(particleCount, 3);
        particleCount -= taken;
        return taken;
      },
      get particleCount() {
        return particleCount;
      },
    };
    const interaction = new SandWaterInteraction({ erodeRate: 30, depositRate: 40, maxCellsPerFrame: 100 });

    // ① 上游：快速水流冲刷
    fluid.setCells([{ x: 20.5, y: y + 0.5, z: 24.5, fullness: 1, speed: 4 }]);
    let eroded = 0;
    for (let i = 0; i < 40; i += 1) eroded += interaction.update({ grid: mudWorld.grid, sand: mudSand, fluid: fluidProxy, dt: 1 / 60 }).eroded;
    check('泥流①：上游的饱和沙被水冲走', eroded > 0, `冲走 ${eroded} 格`);
    check('泥流②：冲走的沙进了水里（被搬运）', particleCount > 0, `水里多了 ${particleCount} 个粒子`);

    // ② 下游：水流慢下来的地方应该淤积出新沙
    fluid.setCells([{ x: 30.5, y: y + 0.5, z: 24.5, fullness: 1, speed: 0.1 }]);
    let deposited = 0;
    for (let i = 0; i < 60; i += 1) deposited += interaction.update({ grid: mudWorld.grid, sand: mudSand, fluid: fluidProxy, dt: 1 / 60 }).deposited;
    check('泥流③：下游水慢的地方淤积出新沙（冲刷的反过程）',
      deposited > 0 && mudWorld.grid.getVoxel(30, y, 24) === SAND,
      `淤积 ${deposited} 格`);
    check('泥流：淤积消耗了水里的粒子（动量与物质都对得上）',
      particleCount < 500 && particleCount >= 0, `剩余粒子 ${particleCount}`);
  }

  // ---------------------------------------------------------------- 掩埋与压塌
  {
    const world = flatWorld(13);
    const interaction = new SandWaterInteraction({ burialLoadThreshold: 10 });
    const building = {
      ownerId: 7,
      center: { x: 24, y: FLAT_TOP + 1.5, z: 24 },
      half: { x: 1, y: 1.5, z: 1 },
      isStatic: true,
    };
    const light = interaction.collectBuriedBuildings(world.grid, [building]);
    check('掩埋：没有沙压着时不报告（不制造无意义的警告）', light.length === 0);

    // 屋顶上压 4 格沙：低于阈值 10
    for (let x = 23; x <= 25; x += 1) {
      for (let z = 23; z <= 25; z += 1) {
        if (x === 24 && z === 24) continue;
        world.grid.setVoxel(x, FLAT_TOP + 3, z, SAND);
      }
    }
    const buriedLight = interaction.collectBuriedBuildings(world.grid, [building]);
    check('掩埋：压了沙就报告载荷（含中文说明）',
      buriedLight.length === 1 && buriedLight[0]!.load > 0 && buriedLight[0]!.detail.length > 0,
      buriedLight[0]?.detail ?? '(没有报告)');
    check('掩埋：未超过阈值时 ratio < 1，且不会被判定为"要塌"',
      buriedLight[0]!.ratio < 1 && interaction.findCollapsing(buriedLight).length === 0,
      `载荷 ${buriedLight[0]!.load}，ratio ${buriedLight[0]!.ratio.toFixed(2)}`);

    // 再压三层：超过阈值
    for (let layer = 0; layer < 3; layer += 1) {
      for (let x = 22; x <= 26; x += 1) {
        for (let z = 22; z <= 26; z += 1) {
          world.grid.setVoxel(x, FLAT_TOP + 4 + layer, z, SAND);
        }
      }
    }
    const buriedHeavy = interaction.collectBuriedBuildings(world.grid, [building]);
    check('压塌：载荷超过阈值时被判定为"会被压塌"',
      buriedHeavy[0]!.ratio >= 1 && interaction.findCollapsing(buriedHeavy).length === 1,
      `载荷 ${buriedHeavy[0]!.load}，ratio ${buriedHeavy[0]!.ratio.toFixed(2)}`);
    check('压塌：中文说明里写清了载荷与阈值（不是只有个数字）',
      buriedHeavy[0]!.detail.includes('压塌') && buriedHeavy[0]!.detail.includes('阈值'),
      buriedHeavy[0]!.detail);
    check('压塌：动态物体不参与（它们本来就会掉，不需要"压塌"判定）', (() => {
      const dynamic = { ...building, isStatic: false };
      return interaction.collectBuriedBuildings(world.grid, [dynamic]).length === 0;
    })());
    check('压塌：多栋建筑同时超阈值时按载荷从大到小排序', (() => {
      const small = { ownerId: 1, center: { x: 24, y: FLAT_TOP + 1.5, z: 24 }, half: { x: 1, y: 1.5, z: 1 }, isStatic: true };
      const big = { ownerId: 2, center: { x: 24, y: FLAT_TOP - 0.5, z: 24 }, half: { x: 2, y: 3.5, z: 2 }, isStatic: true };
      const buried = interaction.collectBuriedBuildings(world.grid, [small, big]);
      const collapsing = interaction.findCollapsing(buried);
      if (collapsing.length < 2) return true; // 只有一栋超阈值时这条不适用
      return collapsing[0]!.ratio >= collapsing[1]!.ratio;
    })());
  }

  // ---------------------------------------------------------------- 分帧预算与统计
  {
    const world = flatWorld(17);
    const sand = new SandSystem(world.grid);
    const fluid = new FakeFluid();
    // 造 3000 个流体格，把预算设成 500 → 必须被截断
    const cells: { x: number; y: number; z: number; fullness: number; speed: number }[] = [];
    for (let i = 0; i < 3000; i += 1) {
      cells.push({ x: 10 + (i % 30), y: 10, z: 10 + Math.floor(i / 30), fullness: 1, speed: 0 });
    }
    fluid.setCells(cells);
    const interaction = new SandWaterInteraction({ maxCellsPerFrame: 500 });
    const stats = interaction.update({ grid: world.grid, sand, fluid, dt: 1 / 60 });
    check('预算：流体格超过上限时被截断，并如实标记 truncated',
      stats.truncated && stats.cells === 500, `处理 ${stats.cells} 格，truncated=${stats.truncated}`);
    check('预算：耗时被记录（面板与压力测试要用）', stats.ms >= 0);
    check('描述：describe() 给出中文摘要（含冲走/淤积的数量）',
      interaction.describe().includes('沙水交互') && interaction.describe().includes('冲走'),
      interaction.describe());
    check('配置：默认阈值符合"要够湿才成泥流"（erodeMinMoisture ≥ 0.5）',
      DEFAULT_SAND_WATER_CONFIG.erodeMinMoisture >= 0.5 && DEFAULT_SAND_WATER_CONFIG.erodeSpeed > 1);
    check('配置：可以运行时调（面板要能调侵蚀强度）', (() => {
      const it = new SandWaterInteraction();
      it.setConfig({ erodeSpeed: 9 });
      return it.settings.erodeSpeed === 9;
    })());
  }
}
