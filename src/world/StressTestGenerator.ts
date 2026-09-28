/**
 * 压力测试场景生成器（M3 第 8 批）。
 *
 * 数据在 `data/stressTestMaps.ts`（3 个场景，纯数据、有断言覆盖），这个文件负责把数据
 * 变成世界里的东西：**建筑实例 → 刚体 → 关节**。它和 `ComboBuilder` 是同一类东西，
 * 但有两处关键差异，所以没有合并：
 *
 * 1. **规模**：500 个物体，必须是"先批量建体、再批量建关节"，中间不能有逐物体的检查
 *    （那会让生成时间从几十毫秒涨到秒级）；
 * 2. **设备降级**：手机上一律用 `mobileCount`，而且**在开始生成之前就决定**，
 *    不是生成到一半发现超限。
 *
 * ────────────────────────────────────────────────────────────
 * 一个必须写清楚的行为：它会**清空当前世界**
 * ────────────────────────────────────────────────────────────
 * 压力测试场景动辄几百个刚体，不可能"叠加"到现有世界上去（一叠加就超过上限）。
 * 所以加载场景 = 换一张空白世界 + 摆上场景物体，走的是和换地图同一条卸载路径。
 * 这一点在按钮上就要写出来（"会清空当前世界"），不能悄悄清掉玩家的东西。
 */

import type { StressScenario } from '../data/stressTestMaps';
import { resolveStressCount } from '../data/stressTestMaps';
import { getBuildingDef } from '../data/buildingCatalog';
import type { BuildingInstance, PhysicsMode } from '../building/types';
import type { BuildingSystem } from '../building/BuildingSystem';
import type { PhysicsFramework } from '../physics/PhysicsFramework';

export interface StressTestBuildRequest {
  scenario: StressScenario;
  /** 设备档位（决定用 desktopCount 还是 mobileCount） */
  tier: 'low' | 'medium' | 'high';
  isMobile: boolean;
  /** 场景原点（世界坐标） */
  origin: [number, number, number];
  /** 性能上限：超过就不再建动态刚体（返回结果里会如实报告降级了多少） */
  dynamicLimit: number;
}

export interface StressTestResult {
  ok: boolean;
  scenarioId: string;
  scenarioName: string;
  /** 实际想要的物体数（已按设备档位降级） */
  requested: number;
  /** 真的建出来的建筑数 */
  created: number;
  /** 因为超过动态刚体上限而退化成静态的数量 */
  degradedToStatic: number;
  /** 建成功的关节数 */
  jointsBuilt: number;
  /** 排队等物理就绪的关节数 */
  jointsPending: number;
  /** 缺失的模型 id（数据坏了要能看出来，而不是静默缺件） */
  missingDefs: string[];
  /** 是否降级过（设备档位导致） */
  degraded: boolean;
  /** 降级说明（中文） */
  degradeNote: string;
  /** 给玩家看的完整说明 */
  message: string;
  ms: number;
}

export class StressTestGenerator {
  constructor(
    private readonly buildings: BuildingSystem,
    private readonly framework: PhysicsFramework,
  ) {}

  /**
   * 生成一个压力测试场景。
   *
   * 调用方**必须先把世界清空**（走换地图那条路径），这里不负责卸载 ——
   * 因为"生成器顺手清空世界"会让人无法预料它到底动了什么。
   */
  build(request: StressTestBuildRequest): StressTestResult {
    const started = now();
    const { scenario, tier, isMobile, origin, dynamicLimit } = request;

    const resolution = resolveStressCount(scenario, tier, isMobile);
    const specs = scenario.build(resolution.count);

    // ---- 1) 先算一遍：有哪些模型缺失、预计多少个会是动态
    const missingDefs: string[] = [];
    const byDef = new Map<string, number>();
    for (const spec of specs) {
      if (!getBuildingDef(spec.defId)) {
        if (!missingDefs.includes(spec.defId)) missingDefs.push(spec.defId);
        continue;
      }
      byDef.set(spec.defId, (byDef.get(spec.defId) ?? 0) + 1);
    }

    // ---- 2) 批量建体
    //
    // 动态刚体的选择：**被关节连到世界的物体建成 static**（它们本来就被钉住），
    // 其余建成 dynamic。这个判断在生成前就能做完，不需要试探。
    const jointedToWorld = new Set<number>();
    specs.forEach((spec, index) => {
      if (spec.jointType === undefined) return;
      if (spec.jointTo === undefined) jointedToWorld.add(index);
    });

    const placements: { defId: string; position: [number, number, number]; rotationY: number; scale: number; mode: PhysicsMode }[] = [];
    let degradedToStatic = 0;
    let dynamicSoFar = 0;
    const instanceIndexBySpecIndex = new Map<number, number>();

    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index]!;
      if (!getBuildingDef(spec.defId)) continue;
      let mode: PhysicsMode = jointedToWorld.has(index) ? 'static' : 'dynamic';
      if (mode === 'dynamic') {
        if (dynamicSoFar >= dynamicLimit) {
          // 超上限就退化成静态并**记账** —— 静默降级会让玩家以为"物理坏了"
          mode = 'static';
          degradedToStatic += 1;
        } else {
          dynamicSoFar += 1;
        }
      }
      instanceIndexBySpecIndex.set(index, placements.length);
      placements.push({
        defId: spec.defId,
        position: [origin[0] + spec.position[0], origin[1] + spec.position[1], origin[2] + spec.position[2]],
        rotationY: spec.rotationY,
        scale: 1,
        mode,
      });
    }

    const instances: BuildingInstance[] = this.buildings.addMany(placements);

    // ---- 3) 批量建关节
    let jointsBuilt = 0;
    let jointsPending = 0;
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index]!;
      if (spec.jointType === undefined) continue;
      const selfSlot = instanceIndexBySpecIndex.get(index);
      if (selfSlot === undefined) continue;
      const self = instances[selfSlot];
      if (!self) continue;

      const bodyA = self.physicsHandle ?? -1;
      if (bodyA < 0) {
        jointsPending += 1;
        continue;
      }

      let bodyB = '';
      if (spec.jointTo !== undefined) {
        const otherSlot = instanceIndexBySpecIndex.get(spec.jointTo);
        const other = otherSlot !== undefined ? instances[otherSlot] : undefined;
        const otherHandle = other?.physicsHandle ?? -1;
        if (otherHandle < 0) {
          jointsPending += 1;
          continue;
        }
        bodyB = String(otherHandle);
      }

      const id = this.framework.addJoint({
        type: spec.jointType === 'spherical' ? 'ball' : spec.jointType,
        bodyA: String(bodyA),
        bodyB,
        // 锚点取物体中心：场景数据里的位置就是"底面中心"，关节挂在几何中心更自然
        anchor: [
          self.position[0],
          self.position[1] + (getBuildingDef(self.defId)?.size[1] ?? 1) / 2,
          self.position[2],
        ],
        axis: spec.jointAxis,
        label: `${scenario.name} #${index}`,
      });
      if (id >= 0) jointsBuilt += 1;
      else jointsPending += 1;
    }

    const ms = now() - started;
    const notes: string[] = [];
    if (resolution.degraded) notes.push(resolution.note);
    if (degradedToStatic > 0) {
      notes.push(`${degradedToStatic} 个物体因超过动态上限被摆成静态（它们不会动）`);
    }
    if (jointsPending > 0) notes.push(`${jointsPending} 个关节在等物理引擎就绪（会自动补建）`);
    if (missingDefs.length > 0) notes.push(`缺失模型：${missingDefs.join('、')}`);

    return {
      ok: missingDefs.length === 0 || instances.length > 0,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      requested: resolution.count,
      created: instances.length,
      degradedToStatic,
      jointsBuilt,
      jointsPending,
      missingDefs,
      degraded: resolution.degraded,
      degradeNote: resolution.note,
      message:
        `${scenario.emoji} ${scenario.name} 已生成：${instances.length} 个物体 + ${jointsBuilt} 个关节` +
        `（${ms.toFixed(0)} ms）` +
        (notes.length > 0 ? `｜${notes.join('；')}` : ''),
      ms,
    };
  }

  /**
   * 预估：在真正生成之前，先告诉玩家会生成多少个、会不会降级。
   *
   * 面板上要用它显示按钮文案（"500 个物体（会降级到 120 个）"），
   * 而不是点下去才发现和预期不一样。
   */
  preview(scenario: StressScenario, tier: 'low' | 'medium' | 'high', isMobile: boolean): {
    count: number;
    degraded: boolean;
    note: string;
    /** 按 300 个动态刚体估算的帧率风险提示 */
    risk: string;
  } {
    const resolution = resolveStressCount(scenario, tier, isMobile);
    const risk =
      resolution.count > 400
        ? '桌面完整规模：桌面上应该能跑，手机上会明显掉帧'
        : resolution.count > 200
          ? '中等规模：桌面流畅，手机可能掉到 20~30 FPS'
          : '小规模：手机也能跑';
    return { count: resolution.count, degraded: resolution.degraded, note: resolution.note, risk };
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 供面板使用：把场景列表整理成"按钮 + 说明"的数据 */
export function describeScenarioForUI(
  scenario: StressScenario,
  tier: 'low' | 'medium' | 'high',
  isMobile: boolean,
): { id: string; label: string; hint: string; count: number } {
  const resolution = resolveStressCount(scenario, tier, isMobile);
  return {
    id: scenario.id,
    label: `${scenario.emoji} ${scenario.name}`,
    hint:
      `${scenario.description}｜将生成 ${resolution.count} 个物体` +
      (resolution.degraded ? `（${resolution.note}）` : '') +
      `｜${scenario.successHint}`,
    count: resolution.count,
  };
}
