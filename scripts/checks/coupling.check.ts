/**
 * 第 4 批断言：流体-刚体双向耦合。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么这批断言可以做到"很确定"
 * ────────────────────────────────────────────────────────────
 * 耦合逻辑被设计成**只依赖一个流体场接口**（`FluidField`），于是测试里可以注入
 * "恒定密度 + 恒定流速"的假场，把浮力/阻力/冲击的公式逐条算清楚 ——
 * 不需要先跑一个 PBF 求解器（那会给断言引入求解器的噪声，
 * 于是"耦合对不对"永远说不清，只能"看起来在动"）。
 *
 * 关键判据都选了**可计算的**形式：
 * - 浮力：给定 ρ、V、g，力的 Y 分量应该精确等于 ρVg（相对误差 < 1e-6）；
 * - 阻力：力与相对速度**反号**、与 |v_rel|² 成正比；
 * - 冲击：力与 v_rel² 成正比（把速度翻倍，冲击分量应该变成约 4 倍）；
 * - 扶正力矩：浮心偏离重心时，力矩方向必须把物体**扳回去**（不是越推越歪）；
 * - 沉浮：密度比决定 sinking，而不是看力的正负。
 */

import {
  COUPLING_PRESETS,
  COUPLING_PRESET_LABELS,
  FluidRigidCoupling,
  UniformFluidField,
  type CouplingBody,
  type FluidField,
} from '../../src/physics/FluidRigidCoupling';
import { DragSystem, DEFAULT_DRAG_CONFIG } from '../../src/physics/DragSystem';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

/** 一个 1×1×1 米的立方体（体积 1 m³，便于手算） */
function cubeBody(overrides: Partial<CouplingBody> = {}): CouplingBody {
  return {
    handle: 1,
    ownerId: 1,
    center: { x: 0, y: 0, z: 0 },
    half: { x: 0.5, y: 0.5, z: 0.5 },
    mass: 500,
    velocity: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

export function runCouplingChecks(check: CheckFn): void {
  // ---------------------------------------------------------------- 浮力
  {
    const coupling = new FluidRigidCoupling('realistic');
    // 完全浸没在密度 1000 的水里：V=1 m³ → 浮力 = 1000 × 1 × 9.81 = 9810 N
    const field = new UniformFluidField(1, { x: 0, y: 0, z: 0 }, 1000);
    const [force] = coupling.compute([cubeBody()], field, 1 / 60);
    check('浮力：完全浸没时的浮力精确等于 ρ·V·g（9810 N）',
      force !== undefined && Math.abs(force.force.y - 9810) < 0.01,
      `${force?.force.y.toFixed(2)} N（期望 9810）`);
    check('浮力：只有 Y 方向有浮力（水平方向在静水里为 0）',
      force !== undefined && Math.abs(force.force.x) < 1e-6 && Math.abs(force.force.z) < 1e-6,
      `(${force?.force.x.toFixed(6)}, ${force?.force.z.toFixed(6)})`);
    check('浮力：浸没比例与排开体积被如实算出来',
      force !== undefined && Math.abs(force.ratio - 1) < 1e-9 && Math.abs(force.displacedVolume - 1) < 1e-9,
      `ratio=${force?.ratio} displaced=${force?.displacedVolume}`);
    check('浮力：半浸时浮力减半（0.5 比例 → 4905 N）', (() => {
      // 用一个"只有下半空间是水"的场：物体中心在 y=0，采样点分别在 ±0.5
      const halfField = new UniformFluidField(1, { x: 0, y: 0, z: 0 }, 1000, Number.NEGATIVE_INFINITY, 0);
      const [halfForce] = coupling.compute([cubeBody()], halfField, 1 / 60);
      return Math.abs(halfForce!.force.y - 4905) < 0.01;
    })(), `${coupling.compute([cubeBody()], new UniformFluidField(1, { x: 0, y: 0, z: 0 }, 1000, Number.NEGATIVE_INFINITY, 0), 1 / 60)[0]!.force.y.toFixed(2)} N`);
    check('浮力：完全在流体之外时力为 0（不凭空受力）', (() => {
      const dry = new UniformFluidField(0, { x: 0, y: 0, z: 0 }, 1000);
      const [none] = coupling.compute([cubeBody()], dry, 1 / 60);
      return none!.force.y === 0 && none!.ratio === 0;
    })());
    check('浮力：浮力系数可调（夸张预设 1.35 倍 → 13243 N）', (() => {
      const ex = new FluidRigidCoupling('exaggerated');
      const [f] = ex.compute([cubeBody()], new UniformFluidField(1, {}, 1000), 1 / 60);
      return Math.abs(f!.force.y - 9810 * 1.35) < 0.02;
    })(), `${new FluidRigidCoupling('exaggerated').compute([cubeBody()], new UniformFluidField(1, {}, 1000), 1 / 60)[0]!.force.y.toFixed(1)} N`);
  }

  // ---------------------------------------------------------------- 沉浮判据
  {
    const coupling = new FluidRigidCoupling('realistic');
    const field = new UniformFluidField(1, {}, 1000);
    // 1 m³ 体积：500 kg → 密度 500 < 1000 → 浮；1500 kg → 沉
    const light = coupling.compute([cubeBody({ mass: 500 })], field, 1 / 60)[0]!;
    const heavy = coupling.compute([cubeBody({ mass: 1500 })], field, 1 / 60)[0]!;
    check('沉浮：物体密度 < 流体密度 → 判定为"浮"（sinking=false）', light.sinking === false);
    check('沉浮：物体密度 > 流体密度 → 判定为"沉"（sinking=true）', heavy.sinking === true);
    check('沉浮：判据是密度比，不是看力的正负（两者的浮力都是向上的）',
      light.force.y > 0 && heavy.force.y > 0 && Math.abs(light.force.y - heavy.force.y) < 0.01,
      `轻 ${light.force.y.toFixed(0)} N vs 重 ${heavy.force.y.toFixed(0)} N`);
    check('沉浮：浮力与物体质量无关（只与排开体积和流体密度有关）',
      Math.abs(light.force.y - heavy.force.y) < 0.01);
  }

  // ---------------------------------------------------------------- 阻力
  {
    const coupling = new FluidRigidCoupling('realistic');
    // 流体静止、物体向右 2 m/s → 阻力应该向左（与相对速度反向）
    const field = new UniformFluidField(1, { x: 0, y: 0, z: 0 }, 1000);
    const moving = coupling.compute([cubeBody({ velocity: { x: 2, y: 0, z: 0 } })], field, 1 / 60)[0]!;
    check('阻力：方向与相对速度相反（物体向右走 → 受力向左）',
      moving.force.x < 0, `force.x = ${moving.force.x.toFixed(1)} N`);
    // 流速 0、物体速度 2 与 4：阻力应该约 4 倍（二次阻力）
    const slow = coupling.compute([cubeBody({ velocity: { x: 2, y: 0, z: 0 } })], field, 1 / 60)[0]!;
    const fast = coupling.compute([cubeBody({ velocity: { x: 4, y: 0, z: 0 } })], field, 1 / 60)[0]!;
    const ratio = Math.abs(fast.force.x / slow.force.x);
    check('阻力：速度翻倍时阻力约 4 倍（二次阻力关系）',
      ratio > 3.5 && ratio < 4.5, `比值 ${ratio.toFixed(2)}`);
    // 物体静止、水在流 → 力应该顺着水流方向（"被水推着走"）
    const flow = coupling.compute(
      [cubeBody({ velocity: { x: 0, y: 0, z: 0 } })],
      new UniformFluidField(1, { x: 2, y: 0, z: 0 }, 1000),
      1 / 60,
    )[0]!;
    check('推动：水在流而物体静止时，力顺着水流方向（+X）',
      flow.force.x > 0, `${flow.force.x.toFixed(1)} N`);
    check('推动：水流越大推力越大',
      coupling.compute([cubeBody()], new UniformFluidField(1, { x: 6, y: 0, z: 0 }, 1000), 1 / 60)[0]!.force.x >
      coupling.compute([cubeBody()], new UniformFluidField(1, { x: 2, y: 0, z: 0 }, 1000), 1 / 60)[0]!.force.x);
    check('阻力：物体与流体同速时近似无力（相对速度为零）', (() => {
      const same = coupling.compute([cubeBody({ velocity: { x: 3, y: 0, z: 0 } })], new UniformFluidField(1, { x: 3, y: 0, z: 0 }, 1000), 1 / 60)[0]!;
      return Math.abs(same.force.x) < 1;
    })());
  }

  // ---------------------------------------------------------------- 冲击
  {
    const coupling = new FluidRigidCoupling('realistic');
    // 迎面动压与 v² 成正比：3 m/s 与 6 m/s 的冲击分量应该约 4 倍
    const slow = coupling.compute([cubeBody()], new UniformFluidField(1, { x: 3, y: 0, z: 0 }, 1000), 1 / 60)[0]!;
    const fast = coupling.compute([cubeBody()], new UniformFluidField(1, { x: 6, y: 0, z: 0 }, 1000), 1 / 60)[0]!;
    check('冲击：动压与流速平方成正比（速度翻倍 → 动压 4 倍）',
      Math.abs(fast.dynamicPressure / slow.dynamicPressure - 4) < 0.01,
      `${slow.dynamicPressure.toFixed(0)} Pa → ${fast.dynamicPressure.toFixed(0)} Pa`);
    check('冲击：动压的绝对值符合 ρv²/2（3 m/s → 4500 Pa）',
      Math.abs(slow.dynamicPressure - 0.5 * 1000 * 9) < 0.01,
      `${slow.dynamicPressure.toFixed(1)} Pa`);
    check('冲击：静止的水里没有动压（v=0 → 0 Pa）',
      coupling.compute([cubeBody()], new UniformFluidField(1, {}, 1000), 1 / 60)[0]!.dynamicPressure === 0);
    check('冲击：夸张预设的冲击力明显更大（同一水流下比较）', (() => {
      const realistic = new FluidRigidCoupling('realistic');
      const exaggerated = new FluidRigidCoupling('exaggerated');
      const field = new UniformFluidField(1, { x: 5, y: 0, z: 0 }, 1000);
      const a = realistic.compute([cubeBody()], field, 1 / 60)[0]!.force.x;
      const b = exaggerated.compute([cubeBody()], field, 1 / 60)[0]!.force.x;
      return b > a * 1.5;
    })());
  }

  // ---------------------------------------------------------------- 扶正力矩
  {
    const coupling = new FluidRigidCoupling('realistic');
    // 做一个"水面只覆盖一侧"的场：物体右边浸没、左边没有 →
    // 浮心偏右 → 力矩应该把物体往回扳（Z 轴负向）
    const oneSided: FluidField = {
      fullnessAt(x) {
        return x > 0 ? 1 : 0;
      },
      velocityAt: () => ({ x: 0, y: 0, z: 0 }),
      densityAt: () => 1000,
    };
    const [force] = coupling.compute([cubeBody()], oneSided, 1 / 60);
    check('力矩：浸没偏在一侧时，浮心也跟着偏（不是永远取物体中心）',
      force !== undefined && force.centerOfBuoyancy.x > force.ratio * 0 + 0.1,
      `浮心 x = ${force?.centerOfBuoyancy.x.toFixed(3)}（物体中心 x = 0）`);
    check('力矩：浮心偏移产生了非零力矩（这是"船会自己摆正"的物理来源）',
      force !== undefined && Math.abs(force.torque.z) > 1,
      `torque.z = ${force?.torque.z.toFixed(1)} N·m`);
    check('力矩：力矩方向把物体扳回平衡（浸没在 +X 侧 → 绕 Z 的负向力矩）',
      force !== undefined && force.torque.z < 0, `${force?.torque.z.toFixed(1)}`);
    check('力矩：完全浸没且居中时没有扶正力矩（对称）',
      Math.abs(coupling.compute([cubeBody()], new UniformFluidField(1, {}, 1000), 1 / 60)[0]!.torque.z) < 1e-6);
  }

  // ---------------------------------------------------------------- 角速度阻力
  {
    const coupling = new FluidRigidCoupling('realistic');
    const field = new UniformFluidField(1, {}, 1000);
    const spinning = coupling.compute([cubeBody({ angularVelocity: { x: 0, y: 3, z: 0 } })], field, 1 / 60)[0]!;
    check('角阻力：自转的物体会受到反向力矩（在水里转不快）',
      spinning.torque.y < 0, `torque.y = ${spinning.torque.y.toFixed(2)} N·m`);
    check('角阻力：转得越快力矩越大',
      Math.abs(coupling.compute([cubeBody({ angularVelocity: { x: 0, y: 9, z: 0 } })], field, 1 / 60)[0]!.torque.y) >
      Math.abs(spinning.torque.y));
    check('角阻力：流体之外没有角阻力（空气不算流体）',
      coupling.compute([cubeBody({ angularVelocity: { x: 0, y: 3, z: 0 } })], new UniformFluidField(0, {}, 1000), 1 / 60)[0]!.torque.y === 0);
  }

  // ---------------------------------------------------------------- 安全阀（力上限）
  {
    const coupling = new FluidRigidCoupling('realistic');
    // 极端水流（100 m/s）会算出巨大的力，必须被夹住
    const extreme = coupling.compute([cubeBody()], new UniformFluidField(1, { x: 100, y: 0, z: 0 }, 1000), 1 / 60)[0]!;
    check('安全阀：极端水流下力被上限夹住（不把物体射到天上）',
      extreme.clamped && Math.abs(extreme.force.x) <= COUPLING_PRESETS.realistic.maxForce + 1,
      `${extreme.force.x.toFixed(0)} N（上限 ${COUPLING_PRESETS.realistic.maxForce}）`);
    check('安全阀：被夹住的物体数量被如实统计（面板上能看到）',
      coupling.stats.clamped === 1, `${coupling.stats.clamped}`);
    check('安全阀：正常水流不会被夹（常态下这个数字应该是 0）', (() => {
      const normal = new FluidRigidCoupling('realistic');
      normal.compute([cubeBody()], new UniformFluidField(1, { x: 1, y: 0, z: 0 }, 1000), 1 / 60);
      return normal.stats.clamped === 0;
    })());
  }

  // ---------------------------------------------------------------- 迭代与预设
  {
    const realistic = new FluidRigidCoupling('realistic');
    const game = new FluidRigidCoupling('game');
    const exaggerated = new FluidRigidCoupling('exaggerated');
    check('预设：三档都存在且各有中文名',
      Object.keys(COUPLING_PRESETS).length === 3 &&
      Object.values(COUPLING_PRESET_LABELS).every((label) => label.length > 0));
    check('预设：真实档迭代 3 次、游戏与夸张 2 次（需求要求 2~3 次）',
      realistic.settings.iterations === 3 && game.settings.iterations === 2 && exaggerated.settings.iterations === 2);
    check('预设：真实档浮力系数为 1（按阿基米德），夸张档 > 1',
      realistic.settings.buoyancyScale === 1 && exaggerated.settings.buoyancyScale > 1);
    check('预设：游戏档阻力小于真实档（玩家在水里还能推动东西）',
      game.settings.drag.dragCoefficient < realistic.settings.drag.dragCoefficient);
    check('预设：迭代次数可运行时改（面板要能调）', (() => {
      game.setConfig({ iterations: 3 });
      const after = game.settings.iterations;
      game.setPreset('game');
      return after === 3 && game.settings.iterations === 2;
    })());
    check('预设：describe() 给出中文摘要，含预设名与统计',
      realistic.describe().includes('耦合') && realistic.describe().includes('真实'), realistic.describe());
    check('预设：切换预设会转发到 DragSystem（调一次就生效）', (() => {
      const c = new FluidRigidCoupling('realistic');
      c.setPreset('exaggerated');
      return c.settings.drag.impactScale === 4;
    })());
  }

  // ---------------------------------------------------------------- 统计与边界
  {
    const coupling = new FluidRigidCoupling('game');
    const field = new UniformFluidField(1, {}, 1000);
    const stats = coupling.compute([cubeBody(), cubeBody({ handle: 2, ownerId: 2, mass: 2000 })], field, 1 / 60);
    check('统计：物体数、浸没数、会沉数都被算出来',
      coupling.stats.bodies === 2 && coupling.stats.submerged === 2 && coupling.stats.sinking === 1,
      `物体 ${coupling.stats.bodies}｜浸没 ${coupling.stats.submerged}｜沉 ${coupling.stats.sinking}`);
    check('统计：每个物体都有一条结果（顺序与输入一致）',
      stats.length === 2 && stats[0]!.handle === 1 && stats[1]!.handle === 2);
    check('统计：耗时被如实记录', coupling.stats.ms >= 0);
    check('边界：空物体列表不抛异常且统计归零', (() => {
      const empty = new FluidRigidCoupling('game');
      const result = empty.compute([], field, 1 / 60);
      return result.length === 0 && empty.stats.bodies === 0 && empty.stats.averageRatio === 0;
    })());
    check('边界：dt 为 0 也不抛异常（暂停时可能传 0）', (() => {
      const c = new FluidRigidCoupling('game');
      return c.compute([cubeBody()], field, 0).length === 1;
    })());
    check('边界：质量极小的物体不会算出 Infinity',
      coupling.compute([cubeBody({ mass: 0.0001 })], field, 1 / 60).every((f) =>
        Number.isFinite(f.force.x) && Number.isFinite(f.force.y) && Number.isFinite(f.torque.y)));
  }

  // ---------------------------------------------------------------- DragSystem 单独可用
  {
    const drag = new DragSystem({ ...DEFAULT_DRAG_CONFIG });
    check('DragSystem：可以独立使用（不依赖耦合系统）',
      typeof drag.compute === 'function' && drag.settings.dragCoefficient === DEFAULT_DRAG_CONFIG.dragCoefficient);
    check('DragSystem：未浸没时返回零力（早退，不做无谓计算）', (() => {
      const r = drag.compute({ handle: 1, ownerId: 1, center: { x: 0, y: 0, z: 0 }, half: { x: 0.5, y: 0.5, z: 0.5 }, mass: 100, velocity: { x: 5, y: 0, z: 0 }, submersion: 0 }, 1000, { x: 0, y: 0, z: 0 });
      return r.force.x === 0 && r.dynamicPressure === 0;
    })());
    check('DragSystem：配置可改（面板要能调阻力系数）', (() => {
      drag.setConfig({ dragCoefficient: 3 });
      return drag.settings.dragCoefficient === 3;
    })());
    check('DragSystem：迎流面积取最大截面（1×1×1 的箱子 → 1 m²，阻力与面积成正比）', (() => {
      const a = drag.compute({ handle: 1, ownerId: 1, center: { x: 0, y: 0, z: 0 }, half: { x: 0.5, y: 0.5, z: 0.5 }, mass: 100, velocity: { x: 2, y: 0, z: 0 }, submersion: 1 }, 1000, { x: 0, y: 0, z: 0 });
      const b = drag.compute({ handle: 1, ownerId: 1, center: { x: 0, y: 0, z: 0 }, half: { x: 1, y: 0.5, z: 0.5 }, mass: 100, velocity: { x: 2, y: 0, z: 0 }, submersion: 1 }, 1000, { x: 0, y: 0, z: 0 });
      return Math.abs(b.force.x / a.force.x - 2) < 0.05;
    })());
  }
}
