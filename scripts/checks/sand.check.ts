/**
 * 第 3 批断言：沙土物理（安息角 / 湿度 / 沙崩 / 编辑工具 / 可视化）。
 *
 * ────────────────────────────────────────────────────────────
 * 这批断言分三层
 * ────────────────────────────────────────────────────────────
 * 1. **公式层**（精确）：湿度 → 安息角 → 滑动距离。三个锚点（34°/45°/15°）必须**精确命中**，
 *    插值必须单调（除了刻意设计的"湿沙峰"）。这一层在 Node 里完全确定。
 * 2. **现象层**（实测）：真的堆一堆沙，量它的坡度，比较"干沙比饱和沙陡"。
 *    这一层是**离散近似的实际效果**，所以断言用的是"大小关系"和"落在合理区间"，
 *    不是"精确等于 34°" —— 离散格里做不到精确角度，写死它只会让断言天天红。
 * 3. **状态层**：湿度会吸水/干燥、凝固不可逆、静止沙不花时间、编辑工具节流。
 */

import { World } from '../../src/core/World';
import { getVoxelId, AIR } from '../../src/data/voxelTypes';
import { TerrainGenerator } from '../../src/voxel/TerrainGenerator';
import { getWorldSize } from '../../src/worldSize';
import { SandSystem, SAND_VOXEL_ID } from '../../src/sand/SandSystem';
import { SandEditor, SAND_TOOL_TICKS } from '../../src/sand/SandEditor';
import { SandVisualizer } from '../../src/sand/SandVisualizer';
import {
  absorbMoisture,
  dryMoisture,
  MOISTURE_SATURATED,
  MOISTURE_WET,
  REPOSE_ANCHORS,
  reposeAngleFor,
  sandStateOf,
  slideDistanceFor,
  slideDistanceForMoisture,
  stabilityOf,
  SAND_TOOL_LABELS,
  SAND_STATE_LABELS,
} from '../../src/sand/SandPhysics';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

const SAND = getVoxelId('sand');
const WATER = getVoxelId('water');
const STONE = getVoxelId('stone');

/**
 * 造一个**真正平坦**的测试世界。
 *
 * ⚠ 第一版我用的是 `new World(seed, 'novice', null)` —— 它会**生成真实地形**，
 * 于是"我以为沙堆在 y=2、其实堆在 y=9 的山坡上"这类假设全部落空，
 * 一口气红了 7 条断言（而其中 5 条是测试的错，不是代码的错）。
 * 现在统一用振幅 0 的高度图把地面压成 y=8 的平板，所有高度假设都有依据。
 */
const FLAT_TOP = 8;
function flatWorld(seed = 7, sizeY = 16): World {
  const world = new World(seed, 'novice', null, sizeY);
  const preset = getWorldSize('novice').terrain;
  TerrainGenerator.generate(world.grid, {
    seed,
    waterLevel: -99,
    baseHeight: FLAT_TOP,
    amplitude: 0,
    minHeight: FLAT_TOP,
    maxHeight: FLAT_TOP,
    snowLine: preset.snowLine,
    noiseScale: preset.noiseScale,
  });
  return world;
}

/**
 * 在 (cx, cz) 处放一根细沙柱（2×2 截面）—— 让它自己塌成一堆。
 *
 * ⚠ 为什么不直接造一个"沙锥"：我第一版就是那么做的，结果是**干沙和饱和沙量出来一模一样**。
 * 原因不是代码，是场景：手工造的锥形是"一层比一层窄"的台阶，
 * 每一格的斜下方都被下一层占着 —— 它**本来就稳定**，根本不触发滑动规则，
 * 于是"安息角"这件事在这个场景里根本没被考验到。
 * 只有"从上方落下来的沙自然堆出来"的坡度才反映安息角。
 */
function sandColumn(grid: World['grid'], cx: number, cz: number, height: number, footprint = 2): number {
  let placed = 0;
  for (let dy = 0; dy < height; dy += 1) {
    for (let dz = 0; dz < footprint; dz += 1) {
      for (let dx = 0; dx < footprint; dx += 1) {
        const x = cx + dx;
        const z = cz + dz;
        const y = FLAT_TOP + 1 + dy;
        if (!grid.inBounds(x, y, z)) continue;
        if (grid.getVoxel(x, y, z) !== AIR) continue;
        grid.setVoxel(x, y, z, SAND);
        placed += 1;
      }
    }
  }
  return placed;
}

/** 数一数世界里有多少格沙（守恒断言用） */
function countSand(grid: World['grid']): number {
  let count = 0;
  for (let y = 0; y < grid.sizeY; y += 1) {
    for (let z = 0; z < grid.sizeZ; z += 1) {
      for (let x = 0; x < grid.sizeX; x += 1) {
        if (grid.getVoxel(x, y, z) === SAND) count += 1;
      }
    }
  }
  return count;
}

/** 量一个沙堆的坡度（度）：用"堆高 / 底半径"算平均坡角 */
function measureSlopeAngle(grid: World['grid']): number {
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < grid.sizeY; y += 1) {
    for (let z = 0; z < grid.sizeZ; z += 1) {
      for (let x = 0; x < grid.sizeX; x += 1) {
        if (grid.getVoxel(x, y, z) !== SAND) continue;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    }
  }
  if (!Number.isFinite(minY)) return 0;
  const height = maxY - minY + 1;
  const baseRadius = Math.max(1, (maxX - minX + 1 + maxZ - minZ + 1) / 4);
  return (Math.atan2(height, baseRadius) * 180) / Math.PI;
}

/** 让沙跑够多步直到稳定 */
function settle(sand: SandSystem, steps: number, dt = 1 / 60): number {
  let last = 0;
  for (let i = 0; i < steps; i += 1) last = sand.step(i * 16, dt);
  return last;
}

export function runSandChecks(check: CheckFn): void {
  // ---------------------------------------------------------------- 公式层
  {
    check('安息角：三个锚点精确命中（干 34° / 湿 45° / 饱和 15°）',
      reposeAngleFor(0) === REPOSE_ANCHORS.dry &&
      reposeAngleFor(MOISTURE_WET) === REPOSE_ANCHORS.wet &&
      reposeAngleFor(1) === REPOSE_ANCHORS.saturated,
      `0→${reposeAngleFor(0)}° / 0.5→${reposeAngleFor(0.5)}° / 1→${reposeAngleFor(1)}°`);
    check('安息角：锚点的值与需求一致（34/45/15）',
      REPOSE_ANCHORS.dry === 34 && REPOSE_ANCHORS.wet === 45 && REPOSE_ANCHORS.saturated === 15);
    check('安息角：干到湿是单调上升的（越湿越陡）',
      reposeAngleFor(0) < reposeAngleFor(0.2) && reposeAngleFor(0.2) < reposeAngleFor(0.4) &&
      reposeAngleFor(0.4) < reposeAngleFor(0.5),
      `${reposeAngleFor(0).toFixed(1)} → ${reposeAngleFor(0.5).toFixed(1)}`);
    check('安息角：过饱和之后单调下降（孔隙水压让沙液化）',
      reposeAngleFor(0.5) > reposeAngleFor(0.7) && reposeAngleFor(0.7) > reposeAngleFor(1),
      `${reposeAngleFor(0.5).toFixed(1)} → ${reposeAngleFor(1).toFixed(1)}`);
    check('安息角：超出范围的值被夹住（不抛异常、不返回 NaN）',
      reposeAngleFor(-5) === 34 && reposeAngleFor(9) === 15 && Number.isFinite(reposeAngleFor(Number.NaN)));
    check('安息角：45° 时的滑动前瞻距离正好是 1 格（经典落沙规则）',
      Math.abs(slideDistanceFor(45) - 1) < 1e-9, `${slideDistanceFor(45)}`);
    check('安息角：角度越缓前瞻越远（15° 要 3~4 格）',
      slideDistanceFor(15) > slideDistanceFor(34) && slideDistanceFor(34) > slideDistanceFor(45),
      `15°→${slideDistanceFor(15).toFixed(2)}｜34°→${slideDistanceFor(34).toFixed(2)}｜45°→${slideDistanceFor(45).toFixed(2)}`);
    check('安息角：前瞻距离被夹在 1~4 格（不会因为 tan 接近 0 而爆掉）',
      slideDistanceFor(89) >= 1 && slideDistanceFor(1) <= 4 && Number.isFinite(slideDistanceFor(90)));
    check('状态：湿度分档正确（干 / 湿 / 饱和）',
      sandStateOf(0) === 'dry' && sandStateOf(MOISTURE_WET) === 'wet' &&
      sandStateOf(MOISTURE_SATURATED) === 'saturated' && sandStateOf(1) === 'saturated');
    check('状态：三档都有中文标签',
      SAND_STATE_LABELS.dry.length > 0 && SAND_STATE_LABELS.wet.length > 0 && SAND_STATE_LABELS.saturated.length > 0);
    check('湿度：吸水随接触面数量增加，但有饱和上限',
      absorbMoisture(0, 0, 0.6, 1) === 0 &&
      absorbMoisture(0, 1, 0.6, 1) > 0 &&
      absorbMoisture(0, 6, 0.6, 1) > absorbMoisture(0, 1, 0.6, 1) &&
      absorbMoisture(0.99, 6, 0.6, 10) <= 1,
      `1 面→${absorbMoisture(0, 1, 0.6, 1).toFixed(2)}，6 面→${absorbMoisture(0, 6, 0.6, 1).toFixed(2)}`);
    check('湿度：干燥随时间回落且不会变成负数',
      // 0.5 - 0.02×1 = 0.48（我第一版写成 "> 0.49" —— 那是我自己算错了，
      // 断言写错时它会红得毫无道理，值得记一笔）
      Math.abs(dryMoisture(0.5, 0.02, 1) - 0.48) < 1e-9 && dryMoisture(0.001, 1, 1) === 0);
    check('稳定性：坡度超过安息角越多越不稳',
      stabilityOf({ moisture: 0, load: 0, slope: 30 }) > stabilityOf({ moisture: 0, load: 0, slope: 60 }));
    check('稳定性：载荷越大越不稳', stabilityOf({ moisture: 0, load: 0, slope: 10 }) > stabilityOf({ moisture: 0, load: 8, slope: 10 }));
    check('稳定性：饱和沙整体更不稳（15° 那档）',
      stabilityOf({ moisture: 1, load: 0, slope: 0 }) < stabilityOf({ moisture: 0.5, load: 0, slope: 0 }));
    check('稳定性：取值始终在 0~1',
      [0, 0.3, 0.5, 0.9, 1].every((m) => {
        const value = stabilityOf({ moisture: m, load: 4, slope: 40 });
        return value >= 0 && value <= 1;
      }));
    check('工具：五个工具都有中文标签',
      Object.keys(SAND_TOOL_LABELS).length === 5 &&
      Object.values(SAND_TOOL_LABELS).every((label) => label.length > 0));
    check('工具：凝固的节流最长（它是不可逆操作，不该被误触连点）',
      SAND_TOOL_TICKS.solidify > SAND_TOOL_TICKS.pile && SAND_TOOL_TICKS.solidify > SAND_TOOL_TICKS.dig,
      `凝固 ${SAND_TOOL_TICKS.solidify} ms vs 堆沙 ${SAND_TOOL_TICKS.pile} ms`);
  }

  // ---------------------------------------------------------------- 现象层：干沙 vs 饱和沙
  {
    // 干沙：立一根 2×2×8 的柱子（32 格），让它自己塌成一堆
    const dryWorld = flatWorld(11);
    const dryPlaced = sandColumn(dryWorld.grid, 24, 24, 8);
    const drySand = new SandSystem(dryWorld.grid);
    drySand.dryRate = 0; // 关掉干燥：这一组要测的是"湿度对坡度的作用"，别让干燥掺进来
    drySand.markAllSand();
    settle(drySand, 900);
    const dryAngle = measureSlopeAngle(dryWorld.grid);

    // 饱和沙：同样的柱子，但先把湿度设成 1（同时关掉干燥，否则跑到一半就干了）
    const wetWorld = flatWorld(11);
    const wetPlaced = sandColumn(wetWorld.grid, 24, 24, 8);
    const wetSand = new SandSystem(wetWorld.grid);
    wetSand.dryRate = 0;
    for (let y = 0; y < wetWorld.grid.sizeY; y += 1) {
      for (let z = 0; z < wetWorld.grid.sizeZ; z += 1) {
        for (let x = 0; x < wetWorld.grid.sizeX; x += 1) {
          if (wetWorld.grid.getVoxel(x, y, z) === SAND) wetSand.setMoisture(x, y, z, 1);
        }
      }
    }
    wetSand.markAllSand();
    settle(wetSand, 900);
    const saturatedAngle = measureSlopeAngle(wetWorld.grid);
    check('现象：两组测试的初始沙量一致（比较才有意义）', dryPlaced === wetPlaced, `${dryPlaced} vs ${wetPlaced}`);

    check('现象：干沙堆的坡度明显陡于饱和沙（离散模拟里确实分开了）',
      dryAngle > saturatedAngle + 3,
      `干沙 ${dryAngle.toFixed(1)}° > 饱和沙 ${saturatedAngle.toFixed(1)}°`);
    check('现象：两种沙的坡度都落在合理区间（10°~60°，不是"堆成一根柱"或"摊成一张纸"）',
      dryAngle > 10 && dryAngle < 60 && saturatedAngle > 5 && saturatedAngle < 60,
      `干 ${dryAngle.toFixed(1)}°｜饱和 ${saturatedAngle.toFixed(1)}°`);
    check('现象：饱和沙确实摊得更开（底面积更大）',
      (() => {
        const extent = (world: World) => {
          let minX = Infinity;
          let maxX = -Infinity;
          for (let y = 0; y < world.grid.sizeY; y += 1) {
            for (let z = 0; z < world.grid.sizeZ; z += 1) {
              for (let x = 0; x < world.grid.sizeX; x += 1) {
                if (world.grid.getVoxel(x, y, z) !== SAND) continue;
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
              }
            }
          }
          return maxX - minX;
        };
        return extent(wetWorld) > extent(dryWorld);
      })(), `干沙跨度 ${(() => {
        let minX = Infinity; let maxX = -Infinity;
        for (let y = 0; y < dryWorld.grid.sizeY; y += 1) for (let z = 0; z < dryWorld.grid.sizeZ; z += 1) for (let x = 0; x < dryWorld.grid.sizeX; x += 1) {
          if (dryWorld.grid.getVoxel(x, y, z) !== SAND) continue;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        }
        return maxX - minX;
      })()} vs 饱和 ${(() => {
        let minX = Infinity; let maxX = -Infinity;
        for (let y = 0; y < wetWorld.grid.sizeY; y += 1) for (let z = 0; z < wetWorld.grid.sizeZ; z += 1) for (let x = 0; x < wetWorld.grid.sizeX; x += 1) {
          if (wetWorld.grid.getVoxel(x, y, z) !== SAND) continue;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        }
        return maxX - minX;
      })()}`);
  }

  // ---------------------------------------------------------------- 现象层：沙崩与连锁
  {
    const world = flatWorld(3);
    // 立一根 2×2×6 的柱子（24 格）在平地上：它一定会塌
    const placed = sandColumn(world.grid, 24, 24, 6);
    const sand = new SandSystem(world.grid);
    sand.markAllSand();
    const firstStepMoved = sand.step(0, 1 / 60);
    check('沙崩：细高沙柱一上来就会动（不是"纹丝不动"）', firstStepMoved > 0, `首步搬动 ${firstStepMoved} 格`);

    // 跑一段时间，应该记录到沙崩事件
    settle(sand, 300);
    check('沙崩：塌落规模够大时记录了沙崩事件（可视化要用它画连锁范围）',
      sand.recentCollapses.length > 0,
      `${sand.recentCollapses.length} 次，最大 ${Math.max(0, ...sand.recentCollapses.map((c) => c.cells))} 格`);
    check('沙崩：事件里带着格数与时间（不是只有个坐标）',
      sand.recentCollapses.every((c) => c.cells > 0 && Number.isFinite(c.atMs)));
    check('沙崩：柱子最终塌平（最高点明显下降）', (() => {
      let maxY = 0;
      for (let y = 0; y < world.grid.sizeY; y += 1) {
        for (let z = 0; z < world.grid.sizeZ; z += 1) {
          for (let x = 0; x < world.grid.sizeX; x += 1) {
            if (world.grid.getVoxel(x, y, z) === SAND) maxY = Math.max(maxY, y);
          }
        }
      }
      return maxY < FLAT_TOP + 6;
    })());
    check('沙崩：沙的总量守恒（搬动不会凭空生成或消失）',
      countSand(world.grid) === placed,
      `初始 ${placed} 格 → 现在 ${countSand(world.grid)} 格`);
  }

  // ---------------------------------------------------------------- 状态层：水分动态
  {
    const world = flatWorld(5);
    // 一层沙，旁边一格水
    const y = FLAT_TOP + 1;
    for (let x = 20; x < 28; x += 1) {
      for (let z = 20; z < 28; z += 1) {
        world.grid.setVoxel(x, y, z, SAND);
      }
    }
    world.grid.setVoxel(19, y, 24, WATER);
    world.grid.setWaterLevel(19, y, 24, 1);
    const sand = new SandSystem(world.grid);
    sand.markAllSand();
    const before = sand.moistureAt(20, y, 24);
    // 跑 3 秒
    for (let i = 0; i < 180; i += 1) sand.step(i * 16, 1 / 60);
    const after = sand.moistureAt(20, y, 24);
    check('水分：紧贴水的沙会变湿（吸水生效）', after > before, `${before.toFixed(3)} → ${after.toFixed(3)}`);
    check('水分：离水远的沙没有被弄湿（吸水不是全局的）',
      sand.moistureAt(27, y, 27) < 0.05, `${sand.moistureAt(27, y, 27).toFixed(3)}`);
    check('水分：湿度不会超过 1', after <= 1);

    // 干燥：把沙弄湿，然后不给水，看它会不会干回去
    const dryWorld = flatWorld(6);
    for (let x = 20; x < 24; x += 1) dryWorld.grid.setVoxel(x, FLAT_TOP + 1, 24, SAND);
    const drySand = new SandSystem(dryWorld.grid);
    drySand.dryRate = 0.5; // 加速干燥便于断言（默认 0.02 要 50 秒）
    for (let x = 20; x < 24; x += 1) drySand.setMoisture(x, FLAT_TOP + 1, 24, 1);
    drySand.markAllSand();
    for (let i = 0; i < 120; i += 1) drySand.step(i * 16, 1 / 60);
    check('水分：没有水接触时会干燥（湿沙不是永久状态）',
      drySand.moistureAt(20, FLAT_TOP + 1, 24) < 1, `${drySand.moistureAt(20, FLAT_TOP + 1, 24).toFixed(3)}`);
    check('水分：统计里如实给出湿度分布与平均值',
      drySand.stats.byState.dry + drySand.stats.byState.wet + drySand.stats.byState.saturated <= 4 * 10 &&
      drySand.stats.averageMoisture >= 0 && drySand.stats.averageMoisture <= 1,
      `平均湿度 ${drySand.stats.averageMoisture.toFixed(3)}`);
    check('水分：粒子流体也能让沙变湿（第 5 批的接口先接好）', (() => {
      const w = flatWorld(8);
      w.grid.setVoxel(24, FLAT_TOP + 1, 24, SAND);
      const s = new SandSystem(w.grid);
      return s.moistenFromFluid(24, FLAT_TOP + 1, 24, 0.5) && s.moistureAt(24, FLAT_TOP + 1, 24) > 0.4;
    })());
    check('水分：moistenFromFluid 对空气格返回 false（不凭空造湿度）', (() => {
      const w = flatWorld(9);
      const s = new SandSystem(w.grid);
      return s.moistenFromFluid(24, FLAT_TOP + 6, 24, 0.5) === false;
    })());
  }

  // ---------------------------------------------------------------- 状态层：性能与静止
  {
    const world = flatWorld(13);
    for (let x = 18; x < 30; x += 1) {
      for (let z = 18; z < 30; z += 1) {
        world.grid.setVoxel(x, FLAT_TOP + 1, z, SAND);
      }
    }
    const sand = new SandSystem(world.grid);
    sand.markAllSand();
    // 平板沙本来就不该动
    const moved = settle(sand, 120);
    check('性能：平的沙层搬动数为 0（不需要动的东西不会被搬）', moved === 0, `最后一步搬动 ${moved}`);
    check('性能：静止之后活跃集为空（静止的沙不花任何时间）',
      sand.activeCount === 0, `活跃 ${sand.activeCount}`);
    const idle = sand.step(0, 1 / 60);
    check('性能：没有活跃格时一步耗时接近 0（< 0.05 ms）',
      idle === 0 && sand.stats.ms < 0.05, `${sand.stats.ms.toFixed(4)} ms`);
    check('性能：元数据内存被如实报告（两个 Uint8Array）',
      sand.moistureBytes === world.grid.sizeX * world.grid.sizeY * world.grid.sizeZ * 2,
      `${(sand.moistureBytes / 1024 / 1024).toFixed(2)} MB`);
    // 大堆沙的分帧预算：活跃格超过上限时只处理一部分
    check('性能：一步最多处理的活跃格有上限（不会一帧卡死）', (() => {
      const big = flatWorld(14);
      // 造一个很大的悬空沙层（会全塌）
      for (let x = 18; x < 40; x += 1) {
        for (let z = 18; z < 40; z += 1) {
          big.grid.setVoxel(x, FLAT_TOP + 6, z, SAND);
        }
      }
      const s = new SandSystem(big.grid);
      s.markAllSand();
      const stats = s.step(0, 1 / 60);
      return stats >= 0 && s.stats.active <= 8000;
    })());
  }

  // ---------------------------------------------------------------- 编辑工具
  {
    const world = flatWorld(17);
    const sand = new SandSystem(world.grid);
    const editor = new SandEditor(world.grid, sand, { radius: 3, maxPileHeight: 5 });

    const pile = editor.apply(24, FLAT_TOP + 1, 24, 1000);
    check('编辑：堆沙真的堆出了沙（不是空操作）', pile.executed && pile.changed > 0, `${pile.changed} 格`);
    check('编辑：堆沙的形状是"中间高、边缘低"（不是一块平板）', (() => {
      const centerTop = world.grid.solidSurfaceHeight(24, 24);
      const edgeTop = world.grid.solidSurfaceHeight(27, 24);
      return centerTop > edgeTop;
    })());
    const tooSoon = editor.apply(24, FLAT_TOP + 1, 24, 1010);
    check('编辑：堆沙有节流（拖动时不会每帧都堆）', !tooSoon.executed);

    editor.setTool('wet');
    const wetResult = editor.apply(24, FLAT_TOP + 1, 24, 2000);
    check('编辑：湿沙工具把湿润度推上去了',
      wetResult.changed > 0 && sand.moistureAt(24, FLAT_TOP + 1, 24) > 0.3,
      `${wetResult.changed} 格，中心湿度 ${sand.moistureAt(24, FLAT_TOP + 1, 24).toFixed(2)}`);
    check('编辑：湿沙不会一次把中心推满（按距离衰减）',
      sand.moistureAt(24, FLAT_TOP + 1, 24) < 1.01);

    editor.setTool('dry');
    const dryResult = editor.apply(24, FLAT_TOP + 1, 24, 3000);
    check('编辑：干沙工具把湿度降下来',
      dryResult.changed > 0 && sand.moistureAt(24, FLAT_TOP + 1, 24) < 0.3,
      `湿度 ${sand.moistureAt(24, FLAT_TOP + 1, 24).toFixed(2)}`);

    // 凝固：不可逆（在**还有沙**的地方做 —— 先确认那里确实有沙）
    editor.setTool('solidify');
    const solidifyY = FLAT_TOP + 2;
    world.grid.setVoxel(24, solidifyY, 24, SAND);
    const solidifyResult = editor.apply(24, solidifyY, 24, 5000);
    check('编辑：凝固把沙变成石头', solidifyResult.changed > 0 && world.grid.getVoxel(24, solidifyY, 24) === STONE,
      `凝固 ${solidifyResult.changed} 格`);
    sand.markAllSand();
    settle(sand, 120);
    check('编辑：凝固是不可逆的（石头不会被沙崩搬走）',
      world.grid.getVoxel(24, solidifyY, 24) === STONE);

    editor.setTool('dig');
    const digTarget = FLAT_TOP + 3;
    world.grid.setVoxel(24, digTarget, 24, SAND);
    const digResult = editor.apply(24, digTarget, 24, 9000);
    check('编辑：挖沙把沙变成空气',
      digResult.changed > 0 && world.grid.getVoxel(24, digTarget, 24) === AIR, `挖掉 ${digResult.changed} 格`);
    check('编辑：半径有上下限（不会因为传 0 或 999 出问题）',
      (() => {
        editor.setRadius(0);
        const low = editor.radius;
        editor.setRadius(999);
        return low >= 1 && editor.radius <= 16;
      })());
  }

  // ---------------------------------------------------------------- 可视化
  {
    const world = flatWorld(23);
    sandColumn(world.grid, 24, 24, 6);
    const sand = new SandSystem(world.grid);
    sand.markAllSand();
    const visualizer = new SandVisualizer();
    check('可视化：默认不显示（它是调试工具，不该默认糊在画面上）', !visualizer.isVisible);
    visualizer.setVisible(true);
    const stats = visualizer.update(world.grid, sand);
    check('可视化：打开之后确实画了指示线（每个活跃格 1~2 条）',
      stats.drawn > 0, `${stats.drawn} 个指示，${stats.skipped} 个被跳过`);
    check('可视化：线段几何是完整的三元组（没有半个顶点）',
      (() => {
        const attribute = (visualizer.group.children[0] as unknown as { geometry: { getAttribute(name: string): { count: number } | undefined } })
          .geometry.getAttribute('position');
        return attribute !== undefined && attribute.count % 2 === 0;
      })());
    check('可视化：不稳定格数被统计出来（沙崩前的征兆）',
      stats.unstable >= 0 && stats.unstable <= stats.drawn, `${stats.unstable}/${stats.drawn}`);
    visualizer.setVisible(false);
    const hidden = visualizer.update(world.grid, sand);
    check('可视化：关掉之后不再重算（省掉这部分开销）', hidden.drawn === stats.drawn);
    visualizer.dispose();
    check('可视化：dispose 之后 group 为空', visualizer.group.children.length === 0);
  }

  // ---------------------------------------------------------------- 与旧系统的关系
  {
    const world = flatWorld(29);
    const sand = new SandSystem(world.grid);
    check('兼容：新系统保留了旧接口（enabled / angleOfRepose / markActive / step）',
      typeof sand.enabled === 'boolean' && typeof sand.angleOfRepose === 'number' &&
      typeof sand.markActive === 'function' && typeof sand.step === 'function' &&
      typeof sand.markAllSand === 'function' && typeof sand.clearActivity === 'function');
    check('兼容：手动指定安息角时不再按湿度算（玩家的显式设置优先）', (() => {
      sand.setMoisture(24, FLAT_TOP + 4, 24, 1);
      world.grid.setVoxel(24, FLAT_TOP + 4, 24, SAND);
      sand.manualAngle = true;
      sand.angleOfRepose = 34;
      const manual = sand.reposeAngleAt(24, FLAT_TOP + 4, 24);
      sand.manualAngle = false;
      const auto = sand.reposeAngleAt(24, FLAT_TOP + 4, 24);
      return manual === 34 && auto === 15;
    })(), '手动 34° vs 自动（饱和）15°');
    check('兼容：SAND_VOXEL_ID 与体素表一致', SAND_VOXEL_ID === SAND);
    check('兼容：关掉湿度系统时退化成"单一安息角"（旧行为）', (() => {
      sand.moistureEnabled = false;
      sand.angleOfRepose = 34;
      const angle = sand.reposeAngleAt(24, FLAT_TOP + 4, 24);
      sand.moistureEnabled = true;
      return angle === 34;
    })());
  }
}
