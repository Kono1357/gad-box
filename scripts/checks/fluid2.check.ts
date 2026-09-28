/**
 * 第 2 批断言：流体渲染 / 表面重建 / 编辑工具 / 音效。
 *
 * ────────────────────────────────────────────────────────────
 * 这批能断什么、不能断什么
 * ────────────────────────────────────────────────────────────
 * 容器里没有 WebGL，所以"画出来好不好看"**断不了**（如实写在 README）。
 * 但下面这些都能断，而且它们才是真正容易出错的地方：
 * - 渲染器把粒子**分配**到正确的实例下标（写错就会出现"世界中心有一坨水"）；
 * - 距离剔除真的剔了、而且没把该画的一起剔掉；
 * - 表面重建产出的是一张**真实存在的网格**（顶点/索引/三角形数一致，不是退化三角形）——
 *   我第一版就是三个索引指向同一个顶点，画出来什么都没有；
 * - 编辑工具的节流、上限、冻结/解冻的几何判定；
 * - 音效在"没有 WebAudio 的环境"里如实降级（不假装在播）。
 */

import { FluidSystem } from '../../src/fluid/FluidSystem';
import { FluidRenderer } from '../../src/fluid/FluidRenderer';
import { FluidSurface } from '../../src/fluid/FluidSurface';
import { FluidEditor, TOOL_TICKS } from '../../src/fluid/FluidEditor';
import { FluidAudio } from '../../src/fluid/FluidAudio';
import { FLUID_PRESETS } from '../../src/fluid/FluidPresets';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

function makeSystem(overrides: { tier?: 'low' | 'mid' | 'high'; type?: 'water' | 'lava' } = {}): FluidSystem {
  return new FluidSystem({
    tier: overrides.tier ?? 'low',
    type: overrides.type ?? 'water',
    seed: 99,
  });
}

export function runFluidRenderChecks(check: CheckFn): void {
  // ---------------------------------------------------------------- 渲染器
  {
    const system = makeSystem({ tier: 'low' });
    const renderer = new FluidRenderer(
      { capacity: system.capacity, particleRadius: system.fluidConfig.particleRadius },
      system.fluidConfig,
    );
    check('渲染器：InstancedMesh 容量等于粒子上限（容量建好之后不能改）',
      renderer.meshRef.instanceMatrix.count === system.capacity,
      `${renderer.meshRef.instanceMatrix.count}`);
    check('渲染器：初始绘制数为 0（还没粒子）', renderer.instanceCount === 0);

    system.emitBox([-1, 2, -1], [1, 4, 1], 100);
    const stats = renderer.sync(system.pool);
    check('渲染器：没有相机时全部绘制', stats.drawn === system.activeCount, `${stats.drawn}/${system.activeCount}`);
    check('渲染器：实例数被写进 mesh.count（不是每帧重建 mesh）', renderer.instanceCount === stats.drawn);
    check('渲染器：没有溢出（容量就是上限）', stats.overflow === 0);

    // 距离剔除
    const far = renderer.sync(system.pool, { x: 1000, y: 1000, z: 1000 });
    check('渲染器：离相机很远时全部剔除（距离剔除生效）',
      far.drawn === 0 && far.culled === system.activeCount,
      `画了 ${far.drawn}，剔除 ${far.culled}`);
    const near = renderer.sync(system.pool, { x: 0, y: 3, z: 0 });
    check('渲染器：相机就在水里时全部绘制（不是把该画的也剔了）',
      near.drawn === system.activeCount, `${near.drawn}/${system.activeCount}`);

    // 矩阵内容：第一个实例应该落在第一个粒子的位置上
    const matrix = renderer.meshRef.instanceMatrix;
    const first = system.pool;
    const x = matrix.array[12] as number;
    const y = matrix.array[13] as number;
    const z = matrix.array[14] as number;
    let matched = false;
    for (let i = 0; i < first.highWater; i += 1) {
      if (first.alive[i] !== 1) continue;
      if (Math.abs(first.posX[i]! - x) < 1e-4 && Math.abs(first.posY[i]! - y) < 1e-4) {
        matched = true;
        break;
      }
    }
    check('渲染器：实例矩阵写的是真实粒子坐标（不是原点）',
      matched, `第一个实例在 (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);

    // 风格切换
    renderer.setStyle('surface');
    check('渲染器：切到"表面"风格后粒子变小变淡（表面才是主体）',
      renderer.meshRef.material.opacity < system.fluidConfig.opacity,
      `不透明度 ${renderer.meshRef.material.opacity}`);
    renderer.setStyle('particles');

    // 清空之后不该再画
    system.clear();
    const empty = renderer.sync(system.pool);
    check('渲染器：清空后绘制数归 0', empty.drawn === 0);

    renderer.dispose();
    check('渲染器：dispose 之后 group 里没有子节点（资源已释放）', renderer.group.children.length === 0);
  }

  // ---------------------------------------------------------------- 表面重建
  {
    const system = makeSystem({ tier: 'low' });
    const surface = new FluidSurface(system.fluidConfig, { maxResolution: 24, cellSize: 0.16 });
    // 一坨水（密集的球）
    for (let iz = -3; iz <= 3; iz += 1) {
      for (let iy = -3; iy <= 3; iy += 1) {
        for (let ix = -3; ix <= 3; ix += 1) {
          if (ix * ix + iy * iy + iz * iz > 9) continue;
          system.pool.spawn(ix * 0.16, 5 + iy * 0.16, iz * 0.16);
        }
      }
    }
    const first = surface.update(system.pool, 1000, true);
    check('表面：一坨密集的水能被重建出网格',
      first.rebuilt && first.triangles > 0, `${first.triangles} 个三角形（网格 ${first.resolution}³）`);
    check('表面：网格分辨率不超过设定上限',
      first.resolution <= 24, `${first.resolution}`);
    check('表面：网格范围只包住水（不是整个世界）—— 比降分辨率有效得多',
      first.cells < 24 * 24 * 24, `${first.cells} 个格子`);

    // 真网格的关键检查：顶点数、索引数、三角形数三者自洽，且索引不越界
    const geometry = surface.group.children[0] as unknown as { geometry: { getAttribute(name: string): { count: number } | undefined; getIndex(): { count: number; array: ArrayLike<number> } | null } };
    const position = geometry.geometry.getAttribute('position');
    const index = geometry.geometry.getIndex();
    const vertexCount = position?.count ?? 0;
    const indexCount = index?.count ?? 0;
    check('表面：三角形数 × 3 等于索引数', indexCount === first.triangles * 3, `${indexCount} vs ${first.triangles * 3}`);
    check('表面：顶点数 > 0 且索引都不越界（不是退化三角形）',
      vertexCount > 0 && (() => {
        const array = index!.array;
        for (let i = 0; i < array.length; i += 1) if ((array[i] as number) >= vertexCount) return false;
        return true;
      })(), `${vertexCount} 个顶点`);
    check('表面：三角形不是退化的（三个索引互不相同）',
      (() => {
        const array = index!.array;
        for (let i = 0; i < array.length; i += 3) {
          const a = array[i] as number;
          const b = array[i + 1] as number;
          const c = array[i + 2] as number;
          if (a === b || b === c || a === c) return false;
        }
        return true;
      })());

    // 节流：两次调用之间太近就不重建（但要说清原因）
    const throttled = surface.update(system.pool, 1010);
    check('表面：33 ms 内的第二次调用被节流，并说明原因',
      !throttled.rebuilt && (throttled.fallbackReason ?? '').includes('节流'),
      throttled.fallbackReason ?? '(没有原因)');
    const later = surface.update(system.pool, 1100);
    check('表面：超过间隔之后会真的重建', later.rebuilt, `${later.triangles} 个三角形`);

    // 太散的水：如实回退而不是"水没了"
    const sparse = makeSystem({ tier: 'low' });
    sparse.emitSphere(0, 5, 0, 3, 3);
    const sparseSurface = new FluidSurface(sparse.fluidConfig, { maxResolution: 24, cellSize: 0.16 });
    const sparseResult = sparseSurface.update(sparse.pool, 2000, true);
    check('表面：粒子太散时如实回退并说明原因（不静默变成"水没了"）',
      !sparseResult.rebuilt && (sparseResult.fallbackReason ?? '').length > 0 && sparseResult.triangles === 0,
      sparseResult.fallbackReason ?? '');

    // 空池
    const emptySystem = makeSystem({ tier: 'low' });
    const emptySurface = new FluidSurface(emptySystem.fluidConfig);
    const emptyResult = emptySurface.update(emptySystem.pool, 3000, true);
    check('表面：没有粒子时安全返回（不抛异常，且说清原因）',
      !emptyResult.rebuilt && emptyResult.fallbackReason === '没有粒子');

    surface.dispose();
    sparseSurface.dispose();
    emptySurface.dispose();
  }

  // ---------------------------------------------------------------- 编辑工具
  {
    const system = makeSystem({ tier: 'mid' });
    const editor = new FluidEditor(system, { radius: 2, pourAmount: 100, pourSpeed: 1.5 });

    // 节流：第一次执行，紧接着的第二次被挡
    const first = editor.apply(0, 5, 0, 1000, false);
    const tooSoon = editor.apply(0, 5, 0, 1010, false);
    check('编辑：泼水第一次真的生成了粒子', first.executed && first.spawned > 0, `${first.spawned} 个`);
    check('编辑：紧接着的第二次被节流挡掉（否则拖动时会生成几十万粒子）',
      !tooSoon.executed && tooSoon.spawned === 0);
    const later = editor.apply(0, 5, 0, 1000 + TOOL_TICKS.pour.intervalMs + 1, false);
    check('编辑：超过间隔之后又能生成', later.executed && later.spawned > 0, `${later.spawned} 个`);

    // 半径与总量：体积正比（半径翻倍 = 生成量约 8 倍）
    const smallSystem = makeSystem({ tier: 'mid' });
    const smallEditor = new FluidEditor(smallSystem, { radius: 1, pourAmount: 100 });
    smallEditor.apply(0, 5, 0, 0, false);
    const bigSystem = makeSystem({ tier: 'mid' });
    const bigEditor = new FluidEditor(bigSystem, { radius: 2, pourAmount: 100 });
    bigEditor.apply(0, 5, 0, 0, false);
    check('编辑：笔刷半径翻倍时单次生成量约 8 倍（体积正比，不是固定个数）',
      bigSystem.activeCount > smallSystem.activeCount * 4,
      `半径 1 米 → ${smallSystem.activeCount} 个；半径 2 米 → ${bigSystem.activeCount} 个`);

    // 抽水只影响范围内
    const drainSystem = makeSystem({ tier: 'mid' });
    drainSystem.emitBox([-1, 3, -1], [1, 5, 1], 200);
    drainSystem.emitSphere(10, 3, 10, 40, 0.5);
    const drainEditor = new FluidEditor(drainSystem, { radius: 2 });
    drainEditor.setTool('drain');
    const drained = drainEditor.apply(0, 4, 0, 0, false);
    check('编辑：抽水只清掉笔刷范围内的水（远处那团还在）',
      drained.removed > 0 && drainSystem.activeCount > 0,
      `移除 ${drained.removed}，剩余 ${drainSystem.activeCount}`);

    // 冻结 / 解冻
    const freezeSystem = makeSystem({ tier: 'mid' });
    freezeSystem.emitBox([-1, 3, -1], [1, 5, 1], 80);
    const freezeEditor = new FluidEditor(freezeSystem, { radius: 2 });
    freezeEditor.setTool('freeze');
    freezeEditor.apply(0, 4, 0, 0, false);
    const regions = freezeSystem.frozenRegions;
    check('编辑：冻结登记了一块区域（不是"把粒子冻住"而是"这块空间冻住"）',
      regions.length === 1, `${regions.length} 块`);
    freezeSystem.applyFrozenFlags();
    let frozenCount = 0;
    for (let i = 0; i < freezeSystem.pool.highWater; i += 1) if (freezeSystem.pool.frozen[i] === 1) frozenCount += 1;
    check('编辑：冻结范围内的粒子被标上冻结', frozenCount === freezeSystem.activeCount, `${frozenCount}/${freezeSystem.activeCount}`);

    // 之后流进来的水也会被冻住 —— 这是"闸门"语义的关键
    const before = freezeSystem.activeCount;
    freezeSystem.emitSphere(0, 4, 0, 20, 0.6);
    freezeSystem.applyFrozenFlags();
    let newlyFrozen = 0;
    for (let i = before; i < freezeSystem.pool.highWater; i += 1) {
      if (freezeSystem.pool.alive[i] === 1 && freezeSystem.pool.frozen[i] === 1) newlyFrozen += 1;
    }
    check('编辑：冻结之后流进来的水也被冻住（"闸门"语义的关键）', newlyFrozen > 0, `${newlyFrozen} 个`);

    freezeEditor.setTool('unfreeze');
    const unfrozen = freezeEditor.apply(0, 4, 0, 1000, false);
    check('编辑：解冻会删掉与笔刷相交的冻结区域',
      freezeSystem.frozenRegions.length === 0 && unfrozen.executed, `剩 ${freezeSystem.frozenRegions.length} 块`);
    check('编辑：不允许冻结时切换到冻结工具会被忽略（不静默生效）', (() => {
      const noFreeze = new FluidEditor(makeSystem({ tier: 'low' }), { allowFreeze: false });
      noFreeze.setTool('freeze');
      return noFreeze.tool !== 'freeze';
    })());

    // 上限说明
    const tinySystem = makeSystem({ tier: 'low' });
    const tinyEditor = new FluidEditor(tinySystem, { radius: 4, pourAmount: 2000 });
    tinySystem.emitSphere(0, 5, 0, tinySystem.capacity, 8);
    const limited = tinyEditor.apply(0, 5, 0, 0, false);
    check('编辑：到上限时给出中文原因（并说清怎么解决）',
      limited.message.includes('上限') || limited.message.includes('占满'), limited.message);
  }

  // ---------------------------------------------------------------- 音效
  {
    const audio = new FluidAudio(true);
    check('音效：没有 AudioContext 的环境里如实报 unsupported（不假装在播）',
      (!audio.isSupported && audio.state === 'unsupported') || (audio.isSupported && audio.state !== 'unsupported'),
      `支持=${audio.isSupported} 状态=${audio.state}`);
    // 没解锁时调 update 不该抛异常、也不该改变状态
    let threw = false;
    try {
      audio.update({ enabled: true, volume: 0.5, flowSpeed: 3, splash: 0.5, boiling: false });
    } catch {
      threw = true;
    }
    check('音效：没解锁时 update 不抛异常', !threw);
    check('音效：音量被夹在 0~1',
      (() => {
        audio.setVolume(5);
        const high = audio.volume;
        audio.setVolume(-1);
        return high === 1 && audio.volume === 0;
      })());
    audio.dispose();
    check('音效：dispose 之后状态回到可恢复的值',
      audio.state === 'suspended' || audio.state === 'unsupported', audio.state);
    check('音效：预设里岩浆有独立的视觉参数（音效里用它判断是否"沸腾"）',
      FLUID_PRESETS.lava.color !== FLUID_PRESETS.water.color && FLUID_PRESETS.lava.opacity === 1);
  }

  // ---------------------------------------------------------------- 渲染与模拟的联动（预算真的生效）
  {
    const system = makeSystem({ tier: 'mid' });
    const renderer = new FluidRenderer(
      { capacity: system.capacity, particleRadius: system.fluidConfig.particleRadius, spheres: false },
      system.fluidConfig,
    );
    // 手机档用方盒：三角形数应该远小于球体
    const geometry = renderer.meshRef.geometry;
    const triangles = (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
    check('渲染器：方盒粒子比球体省得多（手机端默认用方盒）',
      triangles <= 12, `${triangles} 个三角形`);
    renderer.dispose();
  }
}
