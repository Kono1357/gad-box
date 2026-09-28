/**
 * 第 8 批断言：流体存档（量化/压缩/往返）+ 六个教学关卡。
 *
 * 存档这一块最容易"看起来能存"其实丢数据，所以断言分三层：
 * 1. **结构层**：魔数、版本、粒子数（必须**精确相等** —— 少一个都是 bug，不是精度问题）；
 * 2. **精度层**：位置误差在 1/512 米量级、速度误差在 1/64 米/秒量级；
 * 3. **健壮层**：损坏/缺字段/版本不符的载荷要**明确报中文错误**，而不是静默返回空。
 */

import { ParticlePool } from '../../src/fluid/ParticlePool';
import { FluidSave, POSITION_QUANTUM, VELOCITY_QUANTUM, type FluidSavePayload } from '../../src/save/FluidSave';
import { World } from '../../src/core/World';
import { TerrainGenerator } from '../../src/voxel/TerrainGenerator';
import { getWorldSize } from '../../src/worldSize';
import { SandSystem } from '../../src/sand/SandSystem';
import { getVoxelId } from '../../src/data/voxelTypes';
import {
  FluidSandTutorial,
  TUTORIAL_LEVELS,
  type TutorialSnapshot,
} from '../../src/tutorial/FluidSandTutorial';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

const SAND = getVoxelId('sand');

/** 造一个装了 n 个粒子（带速度）的池子 */
function poolWith(n: number, seed = 1): ParticlePool {
  const pool = new ParticlePool(Math.max(n + 10, 100));
  let state = seed;
  const rnd = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = 0; i < n; i += 1) {
    pool.spawn(rnd() * 10 - 5, rnd() * 4 + 1, rnd() * 10 - 5, rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2);
  }
  return pool;
}

/** 一个"什么都很正常"的基线快照（每个字段都设成"远未通关"） */
function emptySnapshot(): TutorialSnapshot {
  return {
    nowMs: 0,
    fluidParticles: 0,
    fluidSpread: 0,
    fluidSpeed: 0,
    frozenRegions: 0,
    frozenParticles: 0,
    submergedBodies: 0,
    sinkingBodies: 0,
    pushedBodies: 0,
    lastCollapseCells: 0,
    collapseCount: 0,
    erodedCells: 0,
    depositedCells: 0,
    usedFluidTools: [],
    usedSandTools: [],
  };
}

export function runSaveTutorialChecks(check: CheckFn): void {
  // ---------------------------------------------------------------- 存档：往返
  {
    const pool = poolWith(400, 7);
    const payload = FluidSave.encode(pool, 'water', undefined, undefined, 12345);
    check('存档：载荷带魔数与版本（可以识别"这是不是流体存档"）',
      payload.magic !== undefined && payload.v === 1, `magic=${payload.magic} v=${payload.v}`);
    check('存档：粒子数被如实记下',
      payload.count === pool.count, `${payload.count} / ${pool.count}`);
    check('存档：包围盒覆盖全部粒子的范围',
      payload.bounds.maxX > payload.bounds.minX && payload.bounds.maxY > payload.bounds.minY);

    // 读回到一个新池子
    const restored = new ParticlePool(500);
    const count = FluidSave.decode(payload, restored);
    check('存档：读回来的粒子数**精确相等**（少一个都是 bug，不是精度问题）',
      count === pool.count && restored.count === pool.count,
      `${count} / ${pool.count}`);
    check('存档：读档失败时 lastError 为 null（成功不该留错误信息）', FluidSave.lastError === null);

    // 精度：逐粒子比对（按顺序，因为写与读都是顺序的）
    let maxPosError = 0;
    let maxVelError = 0;
    const originals: number[][] = [];
    for (let i = 0; i < pool.highWater; i += 1) {
      if (pool.alive[i] !== 1) continue;
      originals.push([pool.posX[i]!, pool.posY[i]!, pool.posZ[i]!, pool.velX[i]!, pool.velY[i]!, pool.velZ[i]!]);
    }
    const readBack: number[][] = [];
    for (let i = 0; i < restored.highWater; i += 1) {
      if (restored.alive[i] !== 1) continue;
      readBack.push([restored.posX[i]!, restored.posY[i]!, restored.posZ[i]!, restored.velX[i]!, restored.velY[i]!, restored.velZ[i]!]);
    }
    check('存档：读回来的粒子顺序与写入一致（同一个下标不该换人）',
      originals.length === readBack.length, `${originals.length} / ${readBack.length}`);
    for (let i = 0; i < Math.min(originals.length, readBack.length); i += 1) {
      const a = originals[i]!;
      const b = readBack[i]!;
      maxPosError = Math.max(maxPosError, Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
      maxVelError = Math.max(maxVelError, Math.abs(a[3]! - b[3]!), Math.abs(a[4]! - b[4]!), Math.abs(a[5]! - b[5]!));
    }
    // 位置误差取决于包围盒跨度：跨度 8 米时 1 个量化单位 ≈ 8/65535 ≈ 1.2e-4 米
    check('存档：位置误差在量化精度内（小于 1 厘米）',
      maxPosError < 0.01, `最大误差 ${maxPosError.toExponential(2)} 米（POSITION_QUANTUM=${POSITION_QUANTUM}）`);
    check('存档：速度误差在量化精度内（小于 0.02 米/秒）',
      maxVelError < VELOCITY_QUANTUM * 1.01, `最大误差 ${maxVelError.toFixed(5)} 米/秒（量子 ${VELOCITY_QUANTUM}）`);
    // 宏观一致性：加起来的速度不能反号（量化不能把流向搞反）
    const sumOriginal = originals.reduce((sum, item) => sum + item[3]!, 0);
    const sumRestored = readBack.reduce((sum, item) => sum + item[3]!, 0);
    check('存档：动量方向没有被量化搞反（总速度的符号一致）',
      Math.sign(sumOriginal) === Math.sign(sumRestored) || Math.abs(sumOriginal) < 1e-6,
      `${sumOriginal.toFixed(3)} → ${sumRestored.toFixed(3)}`);
  }

  // ---------------------------------------------------------------- 存档：压缩率
  {
    const pool = poolWith(3000, 11);
    const payload = FluidSave.encode(pool, 'water');
    const stats = FluidSave.measure(payload);
    // 原始 = 未量化的 float32 大小：6 个量 × 4 字节 = 24 字节/粒子
    check('压缩：原始大小按未量化的 float32 算（24 字节/粒子）',
      stats.rawBytes === 3000 * 24, `${stats.rawBytes}`);
    check('压缩：打包后比原始小（有量化 + RLE，不该膨胀）',
      stats.packedBytes < stats.rawBytes, `${(stats.packedBytes / 1024).toFixed(1)} KB vs ${(stats.rawBytes / 1024).toFixed(1)} KB`);
    check('压缩：压缩率被如实报告（不是编一个"压缩了 90%"）',
      stats.ratio > 0 && stats.ratio <= 1, `${(stats.ratio * 100).toFixed(0)}%`);
    check('压缩：describe() 给出中文摘要（含粒子数、大小、类型）',
      FluidSave.describe(payload).includes('流体存档') && FluidSave.describe(payload).includes('3000'),
      FluidSave.describe(payload));
  }

  // ---------------------------------------------------------------- 存档：健壮性
  {
    const pool = new ParticlePool(100);
    pool.spawn(1, 2, 3);
    const good = FluidSave.encode(pool, 'water');

    check('健壮：版本不符时明确报错（不静默返回空）',
      FluidSave.decode({ ...good, v: 99 }, new ParticlePool(100)) === -1 &&
      (FluidSave.lastError ?? '').includes('版本'), FluidSave.lastError ?? '');
    check('健壮：魔数不对时明确报错（提示"是不是粘错了 JSON"）',
      FluidSave.decode({ ...good, magic: 0x12345678 }, new ParticlePool(100)) === -1 &&
      (FluidSave.lastError ?? '').includes('不是流体存档'), FluidSave.lastError ?? '');
    check('健壮：粒子数据损坏时明确报错（长度不符）', (() => {
      const broken: FluidSavePayload = { ...good, particles: { e: 'raw', d: 'AAAA' } };
      return FluidSave.decode(broken, new ParticlePool(100)) === -1 && (FluidSave.lastError ?? '').includes('长度');
    })(), FluidSave.lastError ?? '');
    check('健壮：空载荷（0 个粒子）是合法的，读回来是 0 而不是报错', (() => {
      const emptyPool = new ParticlePool(100);
      const emptyPayload = FluidSave.encode(emptyPool, 'water');
      const restored = FluidSave.decode(emptyPayload, new ParticlePool(100));
      return restored === 0 && FluidSave.lastError === null;
    })());
    check('健壮：读档是"替换"不是"叠加"（先清空再写）', (() => {
      const target = new ParticlePool(200);
      for (let i = 0; i < 50; i += 1) target.spawn(0, 0, 0);
      FluidSave.decode(good, target);
      return target.count === 1;
    })(), '目标池里原有 50 个，读档后应该只剩存档里的 1 个');
    check('健壮：读档之后还能继续生成粒子（池子的空闲链表没被搞坏）', (() => {
      const target = new ParticlePool(100);
      FluidSave.decode(good, target);
      return target.spawn(9, 9, 9) >= 0 && target.count === 2;
    })());
    check('健壮：null 载荷不抛异常', (() => {
      try {
        return FluidSave.decode(null as unknown as FluidSavePayload, new ParticlePool(10)) === -1;
      } catch {
        return false;
      }
    })());
  }

  // ---------------------------------------------------------------- 存档：含沙的湿度
  {
    const world = new World(3, 'novice', null);
    const preset = getWorldSize('novice').terrain;
    TerrainGenerator.generate(world.grid, {
      seed: 3, waterLevel: -99, baseHeight: 8, amplitude: 0, minHeight: 8, maxHeight: 8,
      snowLine: preset.snowLine, noiseScale: preset.noiseScale,
    });
    const sand = new SandSystem(world.grid);
    for (let x = 20; x < 24; x += 1) {
      for (let z = 20; z < 24; z += 1) {
        world.grid.setVoxel(x, 9, z, SAND);
        sand.setMoisture(x, 9, z, 0.75);
      }
    }
    const pool = new ParticlePool(100);
    const payload = FluidSave.encode(pool, 'water', sand, world.grid);
    check('存档：沙的湿度被一起存下来（稀疏存储，只存非零的）',
      payload.sand !== null && FluidSave.describe(payload).includes('含沙的湿度'));

    // 读回到一个"干"的世界，湿度应该被恢复
    const world2 = new World(3, 'novice', null);
    TerrainGenerator.generate(world2.grid, {
      seed: 3, waterLevel: -99, baseHeight: 8, amplitude: 0, minHeight: 8, maxHeight: 8,
      snowLine: preset.snowLine, noiseScale: preset.noiseScale,
    });
    const sand2 = new SandSystem(world2.grid);
    for (let x = 20; x < 24; x += 1) {
      for (let z = 20; z < 24; z += 1) world2.grid.setVoxel(x, 9, z, SAND);
    }
    const target = new ParticlePool(100);
    FluidSave.decode(payload, target, sand2, world2.grid);
    check('存档：沙的湿度读回来正确（误差在 1/255 内）',
      Math.abs(sand2.moistureAt(22, 9, 22) - 0.75) < 1 / 255,
      `${sand2.moistureAt(22, 9, 22).toFixed(4)}（原 0.75）`);
  }

  // ---------------------------------------------------------------- 教学关卡：结构与进度
  {
    check('关卡：一共 6 关（需求要求至少 6 个）', TUTORIAL_LEVELS.length === 6, `${TUTORIAL_LEVELS.length}`);
    check('关卡：每关都有中文名、目标、通关说明与建议工具',
      TUTORIAL_LEVELS.every((level) =>
        level.name.length > 0 && level.goal.length > 0 && level.successHint.length > 0 &&
        level.suggestedTools.length > 0));
    check('关卡：id 唯一（面板与进度记录都按 id 记）',
      new Set(TUTORIAL_LEVELS.map((level) => level.id)).size === TUTORIAL_LEVELS.length);
    check('关卡：六个关卡覆盖需求点名的六件事',
      TUTORIAL_LEVELS.map((level) => level.id).join(',') ===
      'flow-downhill,buoyancy,gate,sand-collapse,mudflow,flood',
      TUTORIAL_LEVELS.map((level) => level.name).join('、'));

    const tutorial = new FluidSandTutorial();
    check('关卡：初始在第 1 关、未完成', tutorial.state.levelIndex === 0 && !tutorial.state.completed);
    check('关卡：一开始就有中文提示（不是空白）', tutorial.state.hint.length > 0, tutorial.state.hint);
    // 空快照不该过关（这是最重要的反面断言：不能"什么都不做就通关"）
    const idle = tutorial.update(emptySnapshot(), 1000);
    check('关卡：什么都不做时不会通关（第 1 关）', !idle.completed, idle.hint);
  }

  // ---------------------------------------------------------------- 教学关卡：逐关判定
  {
    // 关卡 1：倒够水 + 铺开 + 静下来 + 持续够久
    const t1 = new FluidSandTutorial();
    const spreadDone: TutorialSnapshot = { ...emptySnapshot(), fluidParticles: 200, fluidSpread: 4, fluidSpeed: 0.2 };
    check('关卡 1：水铺开且安静下来之后要**持续**一段时间才算过关（防抖）',
      !t1.update(spreadDone, 500).completed, '只过了 0.5 秒不该通关');
    check('关卡 1：持续够久之后通关', t1.update(spreadDone, 2500).completed);
    check('关卡 1：通关提示是中文且说明达成条件',
      t1.state.hint.includes('通关') && TUTORIAL_LEVELS[0]!.successHint.length > 0, t1.state.hint);

    // 关卡 2：浮力（有浸没物体 + 没有正在下沉 + 持续 2 秒）
    const t2 = new FluidSandTutorial();
    t2.reset(1);
    const floating: TutorialSnapshot = { ...emptySnapshot(), fluidParticles: 300, submergedBodies: 1, sinkingBodies: 0 };
    check('关卡 2：物体浮住且不再下沉时通关（持续 2 秒）', t2.update(floating, 2000).completed);
    const t2b = new FluidSandTutorial();
    t2b.reset(1);
    check('关卡 2：物体正在下沉时不通关（教的就是"密度决定沉浮"）',
      !t2b.update({ ...floating, sinkingBodies: 1 }, 3000).completed);

    // 关卡 3：闸门
    const t3 = new FluidSandTutorial();
    t3.reset(2);
    check('关卡 3：只造了冻结区但里面没水时不通关',
      !t3.update({ ...emptySnapshot(), frozenRegions: 1, frozenParticles: 3 }, 1000).completed);
    check('关卡 3：冻结区里有足够粒子时通关',
      t3.update({ ...emptySnapshot(), frozenRegions: 1, frozenParticles: 40 }, 1000).completed);

    // 关卡 4：沙崩
    const t4 = new FluidSandTutorial();
    t4.reset(3);
    check('关卡 4：小规模滑落（< 12 格）不算"沙崩"',
      !t4.update({ ...emptySnapshot(), collapseCount: 3, lastCollapseCells: 5 }, 1000).completed);
    check('关卡 4：规模够大的沙崩通关',
      t4.update({ ...emptySnapshot(), collapseCount: 4, lastCollapseCells: 30 }, 1000).completed);

    // 关卡 5：泥流（同一帧里既有侵蚀又有沉积）
    const t5 = new FluidSandTutorial();
    t5.reset(4);
    check('关卡 5：只有侵蚀没有淤积时不通关',
      !t5.update({ ...emptySnapshot(), erodedCells: 5, depositedCells: 0 }, 1000).completed);
    check('关卡 5：只有淤积没有侵蚀时不通关',
      !t5.update({ ...emptySnapshot(), erodedCells: 0, depositedCells: 5 }, 1000).completed);
    check('关卡 5：两者同时发生才通关（这才是"泥流"的完整闭环）',
      t5.update({ ...emptySnapshot(), erodedCells: 2, depositedCells: 1 }, 1000).completed);

    // 关卡 6：洪水
    const t6 = new FluidSandTutorial();
    t6.reset(5);
    check('关卡 6：水多但没推动东西时不通关',
      !t6.update({ ...emptySnapshot(), fluidParticles: 800, submergedBodies: 1, pushedBodies: 0 }, 1000).completed);
    check('关卡 6：有物体被水流推动时通关',
      t6.update({ ...emptySnapshot(), fluidParticles: 800, submergedBodies: 1, pushedBodies: 1 }, 1000).completed);
  }

  // ---------------------------------------------------------------- 教学关卡：进度与跳关
  {
    const tutorial = new FluidSandTutorial();
    // 手动跳关
    const before = tutorial.state.levelIndex;
    tutorial.next();
    check('关卡：可以手动跳到下一关（玩家不该被卡住）',
      tutorial.state.levelIndex === before + 1);
    // 全部跳完
    for (let i = 0; i < 10; i += 1) tutorial.next();
    check('关卡：跳到最后不会越界（返回 false 并停在第 6 关）',
      tutorial.state.levelIndex === TUTORIAL_LEVELS.length - 1);
    check('关卡：手动跳关不会虚报完成度（completedCount 不含跳过的关）',
      tutorial.completedCount === 0, `${tutorial.completedCount}`);

    // 通关之后状态稳定
    const done = new FluidSandTutorial();
    done.reset(0);
    done.update({ ...emptySnapshot(), fluidParticles: 200, fluidSpread: 4, fluidSpeed: 0.1 }, 3000);
    check('关卡：通关后再 update 仍然是"已通关"（不会退回未完成）',
      done.update(emptySnapshot(), 1000).completed);
    check('关卡：reset() 能回到第 1 关重新开始', (() => {
      done.reset();
      return done.state.levelIndex === 0 && !done.state.completed;
    })());
    check('关卡：进度提示在未达成时会说明"还差什么"', (() => {
      const t = new FluidSandTutorial();
      const state = t.update({ ...emptySnapshot(), fluidParticles: 10 }, 100);
      return state.hint.includes('水') || state.hint.includes('粒子');
    })());
    check('关卡：allDone 只在六关全部完成后为 true（跳关不算）', (() => {
      const t = new FluidSandTutorial();
      for (let i = 0; i < 8; i += 1) t.next();
      return !t.state.allDone;
    })());
  }
}
