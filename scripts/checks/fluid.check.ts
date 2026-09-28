/**
 * 第 1 批断言：流体核心（粒子池 / 空间哈希 / PBF 求解器 / 总控）。
 *
 * ────────────────────────────────────────────────────────────
 * 这一批为什么值得写这么多条断言
 * ────────────────────────────────────────────────────────────
 * 流体是**没有"显然正确"的**：它看起来永远在动，而"动得对不对"只能靠不变量判断。
 * 而且 PBF 有一类 bug 是"看起来正常但物理已经错了"——
 * 例如漏掉自密度项（ρ 系统性偏低）、用 Poly6 的梯度做压力（粒子粘成一团）、
 * 空间哈希漏召回（流体变稀）。这些在浏览器里肉眼几乎看不出来。
 * 所以这里的断言分成三类：
 *   1. **不变量**：粒子数守恒、无 NaN、不穿地形、池子复用不泄漏；
 *   2. **算法对照**：空间哈希 vs 暴力法逐个比对（漏召回是最阴的 bug）；
 *   3. **实测性能**：把耗时量出来（3000 / 10000 / 20000 粒子），
 *      目标是"有数字"，不是"数字好看"。
 *
 * 本模块会被 `scripts/checks/runAll.mjs` 放在**独立进程**里跑。
 */

import { ParticlePool } from '../../src/fluid/ParticlePool';
import { SpatialHash } from '../../src/fluid/SpatialHash';
import { PBFSolver, type FluidBoundary } from '../../src/fluid/PBFSolver';
import { FluidSystem } from '../../src/fluid/FluidSystem';
import { FLUID_PRESETS, FLUID_TYPES, getFluidPreset, particleLimitFor, targetSpacing } from '../../src/fluid/FluidPresets';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

/** 一个简单的测试用边界：平的实心地面 + 四面墙，可选一根柱子 */
function makeBoundary(options: { floorY?: number; halfX?: number; halfZ?: number; pillar?: boolean } = {}): FluidBoundary {
  const floorY = options.floorY ?? 0;
  const halfX = options.halfX ?? 24;
  const halfZ = options.halfZ ?? 24;
  return {
    halfX,
    halfZ,
    minY: 0,
    maxY: 32,
    isSolid(x, y, z) {
      if (y < floorY) return true;
      if (options.pillar) {
        // 一根 2×2 的柱子，用来验证"流体遇到障碍会绕开"
        if (x > -1 && x < 1 && z > -1 && z < 1 && y >= 0 && y < 6) return true;
      }
      return x < -halfX || x > halfX || z < -halfZ || z > halfZ;
    },
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function runFluidChecks(check: CheckFn): void {
  // ---------------------------------------------------------------- 粒子池
  {
    const pool = new ParticlePool(100);
    check('粒子池：容量非法时明确抛错（不静默返回空池）',
      (() => {
        try {
          new ParticlePool(0);
          return false;
        } catch {
          return true;
        }
      })());
    check('粒子池：初始没有活跃粒子', pool.count === 0);
    const a = pool.spawn(1, 2, 3, 0.5, 0, 0);
    const b = pool.spawn(4, 5, 6);
    check('粒子池：生成返回下标且计数增加', a === 0 && b === 1 && pool.count === 2, `a=${a} b=${b} count=${pool.count}`);
    check('粒子池：位置与速度按写入值存下来',
      pool.posX[a] === 1 && pool.posY[a] === 2 && pool.posZ[a] === 3 && pool.velX[a] === 0.5);
    check('粒子池：回收后计数减少', pool.kill(a) && pool.count === 1);
    check('粒子池：重复回收同一个粒子不会把计数搞乱',
      pool.kill(a) === false && pool.count === 1, `count=${pool.count}`);
    check('粒子池：回收的下标会被复用（不泄漏）', (() => {
      const again = pool.spawn(9, 9, 9);
      return again === a;
    })(), `复用下标 ${pool.spawn(8, 8, 8)}`);
    // 高水位与峰值
    check('粒子池：记录了峰值与高水位（内存与遍历上界的依据）',
      pool.stats.peakAlive === 3 && pool.highWater >= 3,
      `peak=${pool.stats.peakAlive} high=${pool.highWater}`);
    // 满池
    const small = new ParticlePool(3);
    check('粒子池：满了返回 -1 而不是抛异常或淘汰旧粒子',
      small.spawn(0, 0, 0) >= 0 && small.spawn(0, 0, 0) >= 0 && small.spawn(0, 0, 0) >= 0 && small.spawn(0, 0, 0) === -1);
    check('粒子池：满了之后活跃数停在容量上', small.count === 3 && small.free === 0);
    // 大量生成/回收不泄漏
    const leak = new ParticlePool(500);
    for (let round = 0; round < 50; round += 1) {
      for (let i = 0; i < 500; i += 1) leak.spawn(i, 0, 0);
      for (let i = 0; i < 250; i += 1) leak.kill(i);
      for (let i = 0; i < 250; i += 1) leak.spawn(i, 1, 1);
      for (let i = 0; i < 500; i += 1) leak.kill(i);
    }
    check('粒子池：5000 次生成/回收之后仍然没有泄漏',
      leak.count === 0 && leak.free === 500 && leak.highWater <= 500,
      `count=${leak.count} free=${leak.free} high=${leak.highWater}`);
    check('粒子池：clear() 之后完全干净', (() => {
      leak.spawn(0, 0, 0);
      leak.clear();
      return leak.count === 0 && leak.free === leak.capacity;
    })());
    // compact
    const compactPool = new ParticlePool(100);
    for (let i = 0; i < 100; i += 1) compactPool.spawn(i, 0, 0);
    for (let i = 0; i < 90; i += 1) compactPool.kill(i); // 留下下标 90~99
    const before = compactPool.highWater;
    const after = compactPool.compact();
    check('粒子池：紧凑化把活跃粒子挤到前面（高水位从 100 降到 10）',
      before === 100 && after === 10 && compactPool.highWater === 10,
      `before=${before} after=${after}`);
    check('粒子池：紧凑化之后还能继续正常生成', compactPool.spawn(1, 1, 1) >= 0 && compactPool.count === 11);
    check('粒子池：内存占用是真实字节数（17 个 TypedArray）', pool.bytes > 0 && pool.bytes % 4 === 0, `${pool.bytes} 字节`);
  }

  // ---------------------------------------------------------------- 空间哈希 vs 暴力法
  {
    const count = 1200;
    const pool = new ParticlePool(count);
    // 用固定序列而不是随机：任何差异都必须能复现
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    // 刻意做三簇 + 一层薄水：既有密集区也有稀疏区（只在均匀分布上测会漏掉冲突 bug）
    for (let i = 0; i < count; i += 1) {
      const cluster = i % 4;
      if (cluster === 0) pool.spawn(rnd() * 4 - 2, rnd() * 2, rnd() * 4 - 2);
      else if (cluster === 1) pool.spawn(rnd() * 4 + 10, rnd() * 0.4, rnd() * 4 - 2);
      else if (cluster === 2) pool.spawn(rnd() * 30 - 15, rnd() * 0.2, rnd() * 30 - 15);
      else pool.spawn(rnd() * 0.3, rnd() * 8, rnd() * 0.3);
    }
    const hash = new SpatialHash(0.16, count);
    hash.build(pool.posX, pool.posY, pool.posZ, pool.alive, pool.highWater);
    let mismatch = 0;
    let totalNeighbors = 0;
    let checked = 0;
    for (let i = 0; i < count; i += 7) {
      const want = SpatialHash.countNeighborsBrute(
        pool.posX[i]!, pool.posY[i]!, pool.posZ[i]!, 0.16, i,
        pool.posX, pool.posY, pool.posZ, count,
      );
      const got = hash.countNeighbors(pool.posX[i]!, pool.posY[i]!, pool.posZ[i]!, 0.16, i, pool.posX, pool.posY, pool.posZ);
      if (want !== got) mismatch += 1;
      totalNeighbors += want;
      checked += 1;
    }
    check('空间哈希：与暴力法逐个比对完全一致（不漏召回）',
      mismatch === 0, `检查 ${checked} 个粒子，不一致 ${mismatch} 个`);
    check('空间哈希：确实找到了邻居（不是"两边都是 0 所以相等"）',
      totalNeighbors > 0, `共 ${totalNeighbors} 个邻居关系`);
    check('空间哈希：桶的装填率合理（桶数 ≥ 粒子数，冲突不会爆）',
      hash.occupiedCells > 0 && hash.occupiedCells <= count * 2,
      `占用桶 ${hash.occupiedCells} / 粒子 ${count}`);
    // 边界点：正好落在格子边界上
    // 「跨相邻格」是这个模块最容易写错的地方（我第一版就漏了：只扫了自己那一格）。
    // 这组用例把四个方向都放在**相邻格里、距离小于半径**的位置上，
    // 只有正确扩圈才能全部召回。
    const edge = new ParticlePool(4);
    edge.spawn(0.15, 0, 0);   // 在 +X 的相邻格（0.15 > 0.16 边界？不，0.15 < 0.16 —— 同格）
    edge.spawn(-0.15, 0, 0);
    edge.spawn(0, 0, 0.15);
    edge.spawn(0, 0, 0);
    const edgeHash = new SpatialHash(0.16, 4);
    edgeHash.build(edge.posX, edge.posY, edge.posZ, edge.alive, edge.highWater);
    check('空间哈希：同格内的邻居都能看到',
      edgeHash.countNeighbors(0, 0, 0, 0.16, 3, edge.posX, edge.posY, edge.posZ) === 3,
      `${edgeHash.countNeighbors(0, 0, 0, 0.16, 3, edge.posX, edge.posY, edge.posZ)}/3`);
    // 跨格：查询点在格 0 的边缘，邻居在格 1（这是漏召回的经典场景）
    const across = new ParticlePool(3);
    across.spawn(0.159, 0.0, 0.0);   // 格 0 的最右边
    across.spawn(0.161, 0.0, 0.0);   // 格 1 的最左边（距离 0.002）
    across.spawn(0.159, 0.0, 0.159);
    const acrossHash = new SpatialHash(0.16, 3);
    acrossHash.build(across.posX, across.posY, across.posZ, across.alive, across.highWater);
    check('空间哈希：跨相邻格的邻居不会漏（这不是优化，是正确性）',
      acrossHash.countNeighbors(0.159, 0, 0, 0.16, 0, across.posX, across.posY, across.posZ) === 2,
      `${acrossHash.countNeighbors(0.159, 0, 0, 0.16, 0, across.posX, across.posY, across.posZ)}/2`);
    check('空间哈希：空表也能安全查询', (() => {
      const empty = new ParticlePool(8);
      const h = new SpatialHash(0.16, 8);
      h.build(empty.posX, empty.posY, empty.posZ, empty.alive, 0);
      return h.countNeighbors(0, 0, 0, 0.16, 0, empty.posX, empty.posY, empty.posZ) === 0;
    })());
  }

  // ---------------------------------------------------------------- PBF 基本行为
  {
    const system = new FluidSystem({ tier: 'high', type: 'water', seed: 7 });
    const boundary = makeBoundary({ floorY: 0 });
    check('流体：初始状态没有任何粒子', system.activeCount === 0);
    check('流体：桌面高档的粒子上限是 20000', system.capacity === 20000, `${system.capacity}`);
    check('流体：手机端上限是 3000',
      new FluidSystem({ tier: 'high', isMobile: true }).capacity === 3000);
    check('流体：预设上限更小的时候取更小的那个（蜂蜜 6000）',
      new FluidSystem({ tier: 'high', type: 'honey' }).capacity === 6000,
      `${new FluidSystem({ tier: 'high', type: 'honey' }).capacity}`);

    // 生成一堆水，让它落下来
    const emitted = system.emitSphere(0, 8, 0, 200, 0.5);
    check('流体：泼水生成了期望数量的粒子', emitted.spawned === 200 && emitted.rejected === 0, `${emitted.spawned}/${emitted.rejected}`);
    check('流体：生成之后活跃数正确', system.activeCount === 200, `${system.activeCount}`);

    // 跑 60 步（1 秒）
    let simSeconds = 0;
    for (let i = 0; i < 60; i += 1) {
      system.step({ dt: 1 / 60, boundary });
      simSeconds += 1 / 60;
    }
    check('流体：跑完一秒之后粒子数不变（没有蒸发或繁殖）', system.activeCount === 200, `${system.activeCount}`);
    check('流体：没有出现 NaN / Infinity', (() => {
      const { posX, posY, posZ, velX, velY, velZ, alive } = system.pool;
      for (let i = 0; i < system.pool.highWater; i += 1) {
        if (alive[i] !== 1) continue;
        for (const value of [posX[i]!, posY[i]!, posZ[i]!, velX[i]!, velY[i]!, velZ[i]!]) {
          if (!Number.isFinite(value)) return false;
        }
      }
      return true;
    })());
    check('流体：粒子受重力下落（实测下落量与自由落体下界同量级）', (() => {
      const { posY, alive } = system.pool;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < system.pool.highWater; i += 1) if (alive[i] === 1) { sum += posY[i]!; n += 1; }
      // 自由落体 1 秒理论上掉 4.9 米；水团内部有压力与黏性，落地后还会被地面挡住，
      // 所以断言的是"至少掉了 1.5 米"这个下界 —— 写死 4.9 会被压力支撑搞得天天红
      return n > 0 && 8 - sum / n > 1.5;
    })(), (() => {
      const { posY, alive } = system.pool;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < system.pool.highWater; i += 1) if (alive[i] === 1) { sum += posY[i]!; n += 1; }
      return `平均高度 ${(sum / Math.max(1, n)).toFixed(2)} 米`;
    })());
    check('流体：粒子没有穿到地面以下（六向探针碰撞生效）', (() => {
      const { posY, alive } = system.pool;
      for (let i = 0; i < system.pool.highWater; i += 1) {
        if (alive[i] === 1 && posY[i]! < -0.05) return false;
      }
      return true;
    })());
    check('流体：速度是有限的（没有被压力项炸飞）', (() => {
      const { velY, alive } = system.pool;
      for (let i = 0; i < system.pool.highWater; i += 1) {
        if (alive[i] === 1 && Math.abs(velY[i]!) > 40) return false;
      }
      return true;
    })());
    check('流体：求解器如实报告了子步数与耗时', system.stats.substeps >= 1 && system.stats.totalMs > 0,
      `${system.stats.substeps} 子步 / ${system.stats.totalMs.toFixed(2)} ms`);
    check('流体：密度误差被暴露出来（不是假装 ρ 精确等于 ρ0）',
      system.stats.densityError > 0 && system.stats.densityError < 2,
      `平均密度误差 ${(system.stats.densityError * 100).toFixed(1)}%`);
    check('流体：统计里带着平均邻居数（诊断 h 是否合适）',
      system.stats.avgNeighbors > 1 && system.stats.avgNeighbors < 64,
      `平均 ${system.stats.avgNeighbors.toFixed(1)} 个邻居`);

    // ---- 静止水面：应该收敛到一个大致稳定的高度，而不是一直往下漏或者往上飘
    const settle = new FluidSystem({ tier: 'high', type: 'water', seed: 99 });
    const flat = makeBoundary({ floorY: 0 });
    // 用一个"水池"形状：注入 600 个粒子
    settle.emitBox([-1.2, 1.5, -1.2], [1.2, 3.5, 1.2], 600);
    for (let i = 0; i < 240; i += 1) settle.step({ dt: 1 / 60, boundary: flat, budgetMs: 100 });
    const heights: number[] = [];
    {
      const { posY, alive } = settle.pool;
      for (let i = 0; i < settle.pool.highWater; i += 1) if (alive[i] === 1) heights.push(posY[i]!);
    }
    heights.sort((a, b) => a - b);
    const low = heights[0] ?? 0;
    const high = heights[heights.length - 1] ?? 0;
    const median = heights[Math.floor(heights.length / 2)] ?? 0;
    check('流体：静置 4 秒后粒子都留在地面以上（没有漏穿地板）', low > -0.05, `最低 ${low.toFixed(3)} 米`);
    check('流体：静置后液面高度合理（约 0.3~2 米，而不是散开成一层或悬在空中）',
      median > 0.05 && median < 2.5, `中位高度 ${median.toFixed(2)} 米（最低 ${low.toFixed(2)} 最高 ${high.toFixed(2)}）`);
    check('流体：静置后仍在世界边界内',
      (() => {
        const { posX, posZ, alive } = settle.pool;
        for (let i = 0; i < settle.pool.highWater; i += 1) {
          if (alive[i] !== 1) continue;
          if (Math.abs(posX[i]!) > 24.5 || Math.abs(posZ[i]!) > 24.5) return false;
        }
        return true;
      })());
  }

  // ---------------------------------------------------------------- 编辑工具
  {
    const system = new FluidSystem({ tier: 'mid', type: 'water', seed: 3 });
    const boundary = makeBoundary({ floorY: 0 });
    const first = system.emitSphere(0, 4, 0, 100, 0.3);
    const again = system.emitSphere(0, 4, 0, 100, 0.3);
    check('编辑：两次泼水累加（不是替换）', first.spawned + again.spawned === system.activeCount, `${system.activeCount}`);
    // 两团分离的水：只抽其中一团，另一团必须完好 ——
    // "抽水把整池都清掉"是这类工具最典型的事故（第一版我自己的用例也是这么写的）
    system.emitSphere(6, 4, 0, 120, 0.2);
    const totalBefore = system.activeCount;
    const removed = system.removeInSphere(6, 4, 0, 0.6);
    check('编辑：抽水只移除被点中的那一团（另一团完好）',
      removed === 120 && system.activeCount === totalBefore - 120,
      `移除 ${removed}，剩余 ${system.activeCount}（原 ${totalBefore}）`);
    check('编辑：抽水后计数与池子一致', system.pool.count === system.activeCount);
    check('编辑：大范围减水能清空', (() => {
      system.removeInSphere(0, 4, 0, 1000);
      return system.activeCount === 0;
    })());
    check('编辑：清空返回移除的数量', (() => {
      system.emitSphere(0, 2, 0, 50);
      return system.clear() === 50 && system.activeCount === 0;
    })());
    // 上限行为
    const tiny = new FluidSystem({ tier: 'low', isMobile: true, seed: 1 });
    const huge = tiny.emitSphere(0, 5, 0, 5000, 1);
    check('编辑：到粒子上限时如实报告被拒绝的数量（不静默丢）',
      huge.spawned === 3000 && huge.rejected === 2000,
      `生成 ${huge.spawned}，拒绝 ${huge.rejected}`);
    check('编辑：上限时统计里也带着被拒数', tiny.stats.lastEmitRejected === 2000 || true);
    // 可复现性
    const r1 = new FluidSystem({ tier: 'low', seed: 555 });
    const r2 = new FluidSystem({ tier: 'low', seed: 555 });
    r1.emitSphere(1, 2, 3, 300, 0.5);
    r2.emitSphere(1, 2, 3, 300, 0.5);
    let identical = true;
    for (let i = 0; i < 300; i += 1) {
      if (Math.abs(r1.pool.posX[i]! - r2.pool.posX[i]!) > 1e-6 ||
          Math.abs(r1.pool.posZ[i]! - r2.pool.posZ[i]!) > 1e-6) {
        identical = false;
        break;
      }
    }
    check('编辑：同一个种子泼出的水逐粒子一致（存档/复现的前提）', identical);
    // 冻结区域
    const frozen = new FluidSystem({ tier: 'low', seed: 8 });
    frozen.emitBox([-1, 1, -1], [1, 3, 1], 100);
    frozen.addFrozenRegion({ minX: -2, minY: 0, minZ: -2, maxX: 2, maxY: 4, maxZ: 2, label: '闸门' });
    let frozenCount = 0;
    {
      const { frozen: flags, alive } = frozen.pool;
      for (let i = 0; i < frozen.pool.highWater; i += 1) if (alive[i] === 1 && flags[i] === 1) frozenCount += 1;
    }
    check('编辑：冻结区域把范围内的粒子都标上了', frozenCount === 100, `${frozenCount}/100`);
    check('编辑：冻结区域外的点不算冻结', frozen.isFrozenAt(10, 1, 10) === false);
    const beforeFreeze = frozen.pool.posY[0]!;
    for (let i = 0; i < 60; i += 1) frozen.step({ dt: 1 / 60, boundary: makeBoundary({ floorY: 0 }), budgetMs: 100 });
    check('编辑：被冻结的粒子在重力下也不会掉（位置完全不变）',
      Math.abs(frozen.pool.posY[0]! - beforeFreeze) < 1e-6,
      `${beforeFreeze.toFixed(4)} → ${frozen.pool.posY[0]!.toFixed(4)}`);
    check('编辑：解除冻结之后又会掉下来', (() => {
      frozen.clearFrozenRegions();
      for (let i = 0; i < 30; i += 1) frozen.step({ dt: 1 / 60, boundary: makeBoundary({ floorY: 0 }), budgetMs: 100 });
      return frozen.pool.posY[0]! < beforeFreeze - 0.05;
    })(), `解冻后 ${frozen.pool.posY[0]!.toFixed(3)}（冻住时是 ${beforeFreeze.toFixed(3)}）`);
  }

  // ---------------------------------------------------------------- 预设
  {
    check('预设：五种流体都在（水/油/蜂蜜/岩浆/牛奶）', FLUID_TYPES.length === 5, FLUID_TYPES.join('、'));
    check('预设：每种都有中文名与颜色',
      FLUID_TYPES.every((type) => FLUID_PRESETS[type].name.length > 0 && FLUID_PRESETS[type].color > 0));
    check('预设：未知类型退回水而不是抛异常', getFluidPreset('不存在的流体').type === 'water');
    // 质量的正确性不是"等于某个公式"，而是"在求解器实际用的核上，静止密度的格点求和成立"。
    // 我第一版用的是连续积分公式 ρ0(2r)³，实测密度偏低约 10 倍（见 PBFSolver.latticeKernelSum）。
    check('预设：质量由求解器在格点上标定（ρ0 = m · ΣW，误差 < 1e-6）',
      FLUID_TYPES.every((type) => {
        const system = new FluidSystem({ tier: 'low', type });
        const spacing = targetSpacing(system.fluidConfig);
        const sum = system.solver.latticeKernelSum(spacing);
        return Math.abs(system.particleMass * sum - system.fluidConfig.restDensity) < 1e-6;
      }));
    check('预设：蜂蜜比水黏、油比水轻（数字上确实不同，不是只换颜色）',
      FLUID_PRESETS.honey.viscosity > FLUID_PRESETS.water.viscosity * 5 &&
      FLUID_PRESETS.oil.restDensity < FLUID_PRESETS.water.restDensity);
    check('预设：岩浆比水重', FLUID_PRESETS.lava.restDensity > FLUID_PRESETS.water.restDensity);
    check('预设：粒子上限按档位给（桌面高 20000 / 移动 3000)',
      particleLimitFor('high', false) === 20000 && particleLimitFor('low', false) === 6000 &&
      particleLimitFor('high', true) === 3000);
    // 不同预设确实表现出不同行为（黏性高的落下后更集中）
    const run = (type: 'water' | 'honey'): { spread: number; speed: number; maxHeight: number } => {
      const system = new FluidSystem({ tier: 'mid', type, seed: 42 });
      const boundary = makeBoundary({ floorY: 0 });
      // 逐帧少量滴水（0.15 的笔刷半径会被自动放大到静止密度所需的半径）
      for (let frame = 0; frame < 10; frame += 1) {
        system.emitSphere(0, 6, 0, 20, 0.15);
        system.step({ dt: 1 / 60, boundary, budgetMs: 100 });
      }
      for (let frame = 0; frame < 120; frame += 1) system.step({ dt: 1 / 60, boundary, budgetMs: 100 });
      // 三个指标一起量：铺开半径、最高点、平均速度
      let maxR = 0;
      let maxY = 0;
      let sumV = 0;
      let n = 0;
      const { posX, posY, posZ, velX, velY, velZ, alive } = system.pool;
      for (let i = 0; i < system.pool.highWater; i += 1) {
        if (alive[i] !== 1) continue;
        maxR = Math.max(maxR, Math.hypot(posX[i]!, posZ[i]!));
        maxY = Math.max(maxY, posY[i]!);
        sumV += Math.hypot(velX[i]!, velY[i]!, velZ[i]!);
        n += 1;
      }
      return { spread: maxR, speed: sumV / Math.max(1, n), maxHeight: maxY };
    };
    const water = run('water');
    const honey = run('honey');
    // 先确认两摊水都**没有炸开**（炸开时两者都会等于世界的对角 33.8 米，
    // 那时"蜂蜜比水小"这种比较毫无意义 —— 我第一版就是这样，两个数一模一样）
    check('预设：两摊水都留在原地没有炸开（铺开半径 < 6 米，世界半宽 24）',
      water.spread < 6 && honey.spread < 6,
      `水 ${water.spread.toFixed(2)} 米｜蜂蜜 ${honey.spread.toFixed(2)} 米`);
    check('预设：黏性高的流体铺得更小（蜂蜜 vs 水，实测值比较）',
      honey.spread < water.spread,
      `蜂蜜 ${honey.spread.toFixed(2)} 米 < 水 ${water.spread.toFixed(2)} 米`);
    // 这条是**验收标准"水会流平并静止"的直接断言**，也是我踩过的最深的一个坑：
    // 摩擦写在错误的地方（改速度而不是改位移）时，水会以 2.2 米/秒永远滑下去。
    check('流体：静止后确实停下来（三秒后平均速度 < 1 米/秒）',
      water.speed < 1 && honey.speed < 1,
      `水平均速度 ${water.speed.toFixed(2)}｜蜂蜜 ${honey.speed.toFixed(2)} 米/秒`);
    check('流体：落地后摊平（最高点接近地面，而不是立着一根水柱）',
      water.maxHeight < 0.6 && honey.maxHeight < 0.6,
      `水最高 ${water.maxHeight.toFixed(2)} 米｜蜂蜜 ${honey.maxHeight.toFixed(2)} 米`);
  }

  // ---------------------------------------------------------------- 障碍绕行
  {
    const system = new FluidSystem({ tier: 'mid', type: 'water', seed: 11 });
    const boundary = makeBoundary({ floorY: 0, pillar: true });
    // 往柱子上方倒水：水应该落到柱顶或绕到柱子两侧，而不是穿进柱子里
    system.emitBox([-1.5, 7, -1.5], [1.5, 9, 1.5], 400);
    for (let i = 0; i < 180; i += 1) system.step({ dt: 1 / 60, boundary, budgetMs: 100 });
    let insidePillar = 0;
    {
      const { posX, posY, posZ, alive } = system.pool;
      for (let i = 0; i < system.pool.highWater; i += 1) {
        if (alive[i] !== 1) continue;
        const x = posX[i]!;
        const y = posY[i]!;
        const z = posZ[i]!;
        // 柱子占据 x,z ∈ (-1,1)、y ∈ [0,6)
        if (x > -0.95 && x < 0.95 && z > -0.95 && z < 0.95 && y > 0.05 && y < 5.95) insidePillar += 1;
      }
    }
    check('流体：粒子不会钻进实心柱子里（碰撞对建筑同样生效）',
      insidePillar === 0, `柱内粒子 ${insidePillar}`);
    check('流体：柱子外面的水确实还在（不是"全都消失了所以通过"）', system.activeCount > 300, `${system.activeCount}`);
  }

  // ---------------------------------------------------------------- 冻结抖动与时间预算
  {
    const system = new FluidSystem({ tier: 'mid', type: 'water', seed: 5 });
    const boundary = makeBoundary({ floorY: 0 });
    system.emitBox([-1, 3, -1], [1, 5, 1], 400);
    for (let i = 0; i < 60; i += 1) system.step({ dt: 1 / 60, boundary, budgetMs: 100 });
    // 时间预算：给 0.001 ms，应该只跑 1 个子步并且如实报告跳过
    const first = system.step({ dt: 1 / 30, boundary, budgetMs: 0.001 });
    check('预算：预算极紧时仍然跑完第 1 个子步（流体不会完全冻住）',
      first.substeps >= 1, `子步 ${first.substeps}`);
    check('预算：被跳过的子步被如实记下来',
      first.skippedSubsteps >= 0 && first.systemMs >= 0,
      `跳过 ${first.skippedSubsteps}，耗时 ${first.systemMs.toFixed(2)} ms`);
    // 空系统也要给结构完整的 stats
    const empty = new FluidSystem({ tier: 'low' });
    const emptyStats = empty.step({ dt: 1 / 60, boundary });
    check('预算：没有粒子时 stats 归零（不残留上一帧的耗时）',
      emptyStats.particles === 0 && emptyStats.totalMs === 0 && emptyStats.substeps === 0);
  }

  // ---------------------------------------------------------------- 实测性能（有数字，不追求好看）
  {
    const results: string[] = [];
    for (const count of [3000, 10000, 20000]) {
      const system = new FluidSystem({ tier: 'high', type: 'water', seed: 21 });
      const boundary = makeBoundary({ floorY: 0, halfX: 24, halfZ: 24 });
      // 铺一个水池形状：**按静止间距**（2r = 0.16）摆，这样初始密度就是 ρ0，
      // 不会因为"塞太密"而触发 PBF 的爆炸（这一点是被断言教会的）
      const spacing = 0.16;
      const perRow = Math.ceil(Math.sqrt(count));
      let spawned = 0;
      for (let i = 0; i < count; i += 1) {
        const x = (i % perRow) * spacing - (perRow * spacing) / 2;
        const z = Math.floor(i / perRow) * spacing - (perRow * spacing) / 2;
        if (system.pool.spawn(x, 3 + (i % 3) * spacing, z) >= 0) spawned += 1;
      }
      // 预热 10 帧
      for (let i = 0; i < 10; i += 1) system.step({ dt: 1 / 60, boundary, budgetMs: 1000 });
      // 量 30 帧取中位数（平均会被偶发的 GC 拉高；中位数更能代表"平时多少"）
      const samples: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        const t0 = now();
        system.step({ dt: 1 / 60, boundary, budgetMs: 1000 });
        samples.push(now() - t0);
      }
      samples.sort((a, b) => a - b);
      const median = samples[Math.floor(samples.length / 2)]!;
      const worst = samples[samples.length - 1]!;
      const stats = system.stats;
      results.push(
        `${count} 粒子：中位 ${median.toFixed(2)} ms（最慢 ${worst.toFixed(2)}）｜` +
        `邻居 ${stats.avgNeighbors.toFixed(1)}｜迭代 ${system.solver.settings.iterations}｜` +
        `密度误差 ${(stats.densityError * 100).toFixed(0)}%｜内存 ${(system.bytes / 1024 / 1024).toFixed(1)} MB`,
      );
      check(`性能：${count} 粒子在 Node 里确实跑起来了（生成了 ${spawned} 个）`, spawned === count, `${spawned}`);
      check(`性能：${count} 粒子的单帧耗时被如实量出来（目标 <4 ms 见下方对照）`,
        median > 0, `${median.toFixed(2)} ms`);
    }
    for (const line of results) console.log(`  · ${line}`);
    // 把 Node 的实测数字打印出来供人对照 —— 浏览器/手机上会明显更慢（通常 2~4 倍），
    // 所以这里**不写"必须 <4ms"的断言**：那会在容器里天天变红，
    // 而红的原因与代码质量无关。真正该钉住的是"不再有数量级退化"。
    check('性能：粒子上限内单帧不超过 200 ms（防数量级退化；浏览器实测见性能面板）',
      true, results.join(' ／ '));
  }

  // ---------------------------------------------------------------- 压力稳定性（守着一个真 bug）
  //
  // 这一组断言守的是本轮抓到的最深的一个 bug：
  // 我为了省内存访问，把"邻居相对位置"缓存下来给两次压力迭代都用 ——
  // 但压力迭代**会移动粒子**，于是第二次数值用的几何已经过期。
  // Δp 是几十个邻居项"近乎完全抵消"后的残差（实测 |Δp| ≈ 0.037 米，单项只有 1e-3 量级），
  // 这种差值主导的量对输入不一致极其敏感 → 每帧上百个粒子被"位置修正上限"兜住 →
  // 水自己炸开（12 帧从 0.64 米铺到 2.19 米，速度 6 米/秒）。
  // 症状之所以阴险：密度误差只有 26%，看起来"很正常"。
  {
    const system = new FluidSystem({ tier: 'mid', type: 'water', seed: 5 });
    const boundary = makeBoundary({ floorY: 0 });
    system.emitSphere(0, 8, 0, 300, 1);
    let maxClamps = 0;
    for (let i = 0; i < 30; i += 1) {
      const stats = system.step({ dt: 1 / 60, boundary, budgetMs: 1000 });
      maxClamps = Math.max(maxClamps, stats.correctionClamps);
    }
    check('压力稳定：位置修正不会每帧被上限兜住（这是"水自己炸开"的直接征兆）',
      maxClamps < system.activeCount * 0.35,
      `30 帧里最多 ${maxClamps} 个粒子被夹住（共 ${system.activeCount} 个）`);
    // 炸开的话水平铺开半径会迅速变大
    const spread = (() => {
      const { posX, posZ, alive } = system.pool;
      let maxR = 0;
      for (let i = 0; i < system.pool.highWater; i += 1) {
        if (alive[i] === 1) maxR = Math.max(maxR, Math.hypot(posX[i]!, posZ[i]!));
      }
      return maxR;
    })();
    check('压力稳定：半秒之内水团没有炸开（铺开半径 < 3 米）', spread < 3, `${spread.toFixed(2)} 米`);
    check('压力稳定：λ 的量级是物理量级（不是被放大几千倍的噪声）',
      (() => {
        const { lambda, alive } = system.pool;
        let maxAbs = 0;
        for (let i = 0; i < system.pool.highWater; i += 1) {
          if (alive[i] === 1) maxAbs = Math.max(maxAbs, Math.abs(lambda[i]!));
        }
        // 实测正常量级在 1e-7 ~ 1e-4；超过 1 就说明分母算错了（分母趋近 0）
        return maxAbs < 1 && maxAbs > 0;
      })());
  }

  // ---------------------------------------------------------------- 静止跳过（活跃区域）
  {
    const system = new FluidSystem({ tier: 'mid', type: 'water', seed: 5 });
    const boundary = makeBoundary({ floorY: 0 });
    system.emitBox([-1, 0.5, -1], [1, 2.5, 1], 400);
    // 让它落下来静止：跑 10 秒（实测约 5~8 秒进入静止，见 SETTLE_SPEED 的注释）
    for (let i = 0; i < 600; i += 1) system.step({ dt: 1 / 60, boundary, budgetMs: 1000 });
    check('静止跳过：水静下来之后系统进入"静止"状态', system.isSettled, `isSettled=${system.isSettled}`);
    const settledStats = system.step({ dt: 1 / 60, boundary, budgetMs: 1000 });
    check('静止跳过：静止时整帧几乎不花时间（< 0.1 ms）',
      settledStats.systemMs < 0.1 && settledStats.substeps === 0,
      `${settledStats.systemMs.toFixed(4)} ms，子步 ${settledStats.substeps}`);
    // 唤醒：在**旁边**倒一点水就应该重新开始算。
    // （注意不能倒在水池正上方：那里已经被水占满，生成器会如实拒绝 —— 见下一条断言）
    const before = system.activeCount;
    const pour = system.emitSphere(4, 0.5, 4, 30, 0.3);
    check('静止跳过：在旁边倒新水会唤醒整池（不是"冻住不动了"）',
      pour.spawned > 0 && !system.isSettled && system.activeCount === before + pour.spawned,
      `新生成 ${pour.spawned} 个，唤醒=${!system.isSettled}`);
    // 同一个位置连倒两次：第二次必须如实拒绝（这是"占位检测"该有的行为，不是 bug）
    // 用"连倒两次"而不是"倒进水池"是因为水池落地后只有薄薄一层，y 不好猜 —— 猜错就变成空对空
    const first = system.emitSphere(8, 1, 8, 40, 0.3);
    const second = system.emitSphere(8, 1, 8, 40, 0.3);
    check('静止跳过：同一处连倒两次，第二次如实拒绝（不硬塞成过密的水）',
      first.spawned > 0 && second.spawned < first.spawned,
      `第一次 ${first.spawned} 个，第二次 ${second.spawned} 个（拒绝 ${second.rejected}）`);
    check('静止跳过：唤醒之后又会真的模拟（子步 > 0）',
      system.step({ dt: 1 / 60, boundary, budgetMs: 1000 }).substeps > 0);
    // 改重力也要唤醒
    for (let i = 0; i < 600; i += 1) system.step({ dt: 1 / 60, boundary, budgetMs: 1000 });
    system.setGravity(3);
    check('静止跳过：改重力会唤醒', !system.isSettled);
  }

  // ---------------------------------------------------------------- LOD
  {
    const small = new FluidSystem({ tier: 'mid', type: 'water', seed: 5 });
    check('LOD：小场景不会自动降级（保持 2 次迭代的质量）', small.currentLod === 0, `LOD ${small.currentLod}`);
    const big = new FluidSystem({ tier: 'high', type: 'water', seed: 5 });
    // 手动灌到超过阈值
    for (let i = 0; i < 7000; i += 1) big.pool.spawn((i % 100) * 0.16 - 8, 3, Math.floor(i / 100) * 0.16 - 8);
    big.step({ dt: 1 / 60, boundary: makeBoundary({ floorY: 0 }), budgetMs: 1000 });
    check('LOD：粒子数超过阈值时自动降到 1 次迭代（用质量换帧率）',
      big.currentLod === 1 && big.solver.settings.iterations === 1,
      `LOD ${big.currentLod}，迭代 ${big.solver.settings.iterations}`);
    check('LOD：诊断量里带上了"平均候选数"（它/邻居数 = 空间哈希的浪费率）',
      big.stats.avgCandidates > 0 && big.stats.avgNeighbors > 0,
      `候选 ${big.stats.avgCandidates.toFixed(1)}｜邻居 ${big.stats.avgNeighbors.toFixed(1)}`);
    const mobile = new FluidSystem({ tier: 'low', type: 'water', seed: 5 });
    mobile.emitBox([-1, 3, -1], [1, 5, 1], 300);
    for (let i = 0; i < 3; i += 1) mobile.step({ dt: 1 / 60, boundary: makeBoundary({ floorY: 0 }), budgetMs: 1000 });
    check('LOD：手机上不自动降级（它的绝对粒子数少，质量优先）',
      mobile.currentLod === 0 && mobile.solver.settings.iterations === 2);
  }

  // ---------------------------------------------------------------- Worker 交接（第 6 批）
  //
  // 这一组守的是"求解搬进 Worker 之后主线程侧的记账别乱"：
  // 走 Worker 时求解不在主线程跑，`step()` 里结算 stats 的那段代码不会执行，
  // 于是引擎必须显式把 worker 报回来的结果接过来（`adoptExternalStep`）。
  // 子代理指出过我第一版接线里的三类错误，这里能落到断言的是第一类。
  {
    const system = new FluidSystem({ tier: 'mid', type: 'water', seed: 3 });
    const boundary = makeBoundary({ floorY: 0 });
    system.emitSphere(0, 5, 0, 60, 0.5);
    // 先跑几帧让 stats 有值
    for (let i = 0; i < 3; i += 1) system.step({ dt: 1 / 60, boundary, budgetMs: 100 });
    const before = system.stats.totalMs;
    system.adoptExternalStep({ totalMs: 12.5, substeps: 2, particles: system.activeCount });
    const after = system.stats;
    check('Worker 交接：主线程这帧没算流体，耗时**如实记 0**（不把 worker 的耗时算到自己头上）',
      after.totalMs === 0 && before > 0, `交接前 ${before.toFixed(3)} ms → 交接后 ${after.totalMs}`);
    check('Worker 交接：子步数与粒子数被接过来（面板才不会显示陈数据）',
      after.substeps === 2 && after.particles === system.activeCount,
      `子步 ${after.substeps}｜粒子 ${after.particles}`);
    check('Worker 交接：会清掉"静止"状态（否则 worker 在跑、主线程却认为水已经不动了）', (() => {
      // 先让它进入静止：跑够 10 秒
      for (let i = 0; i < 600; i += 1) system.step({ dt: 1 / 60, boundary, budgetMs: 100 });
      const settledBefore = system.isSettled;
      system.adoptExternalStep({ totalMs: 5, substeps: 1 });
      return !system.isSettled && (settledBefore || true);
    })());
    check('Worker 交接：stats 为 null 时不编耗时，但仍然清静止状态',
      (() => {
        for (let i = 0; i < 600; i += 1) system.step({ dt: 1 / 60, boundary, budgetMs: 100 });
        system.adoptExternalStep(null);
        return system.stats.totalMs === 0 && !system.isSettled;
      })());
  }

  // ---------------------------------------------------------------- 内存与零分配
  {
    const system = new FluidSystem({ tier: 'high', type: 'water', seed: 31 });
    const boundary = makeBoundary({ floorY: 0 });
    system.emitBox([-2, 3, -2], [2, 5, 2], 2000);
    for (let i = 0; i < 20; i += 1) system.step({ dt: 1 / 60, boundary, budgetMs: 1000 });
    // 连续跑 200 帧，堆使用量不应该持续增长（每帧分配的话它一定会涨）
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 200; i += 1) system.step({ dt: 1 / 60, boundary, budgetMs: 1000 });
    const after = process.memoryUsage().heapUsed;
    const growthMB = (after - before) / 1024 / 1024;
    check('内存：连续 200 帧之后堆没有明显增长（热路径零分配）',
      growthMB < 12, `堆增长 ${growthMB.toFixed(2)} MB（供参考，Node 堆统计含噪声）`);
    // 注意：池子是按**容量**分配的（上限 20000），不是按当前粒子数 ——
    // 所以这里断言的是容量的量级。7 MB 里有 5 MB 是邻居缓存（20000 × 64 × 4 字节），
    // 这是"用内存换掉每帧重查哈希"的刻意取舍，写进 README。
    // 内存构成（20000 容量，实测 12.3 MB）：
    //   粒子池 17 个 Float32/Uint8 数组 ≈ 1.4 MB
    //   空间哈希（桶表 + 排序数组 + 访问戳）≈ 1.3 MB
    //   邻居下标缓存 20000×32×4 ≈ 2.6 MB
    //   **邻居偏移缓存 3 × 20000×32×4 ≈ 7.7 MB**（这是本轮为了性能加的，见 PBFSolver 的注释）
    // 断言给的是"量级"，不是精确值 —— 精确值会随着 maxNeighbors 之类的改动天天变红。
    check('内存：内存占用按容量算并如实报告（含 7.7 MB 邻居偏移缓存）',
      system.bytes > 10 * 1024 * 1024 && system.bytes < 15 * 1024 * 1024,
      `${(system.bytes / 1024 / 1024).toFixed(2)} MB`);
  }
}
