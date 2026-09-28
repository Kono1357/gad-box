/**
 * 内置示例场景（M5 第 3 批）：一键加载一个"能立刻看懂某个系统"的小世界。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么是"纯数据 + build 计划"，而不是一份摆好的存档
 * ────────────────────────────────────────────────────────────
 * 和 `data/stressTestMaps.ts`、`perf/StressTestScenes.ts` 同一套思路：
 * **存配方，不存快照**。12 个场景里"围一圈石头""铺一圈墙""堆一个沙丘"这类东西
 * 如果写成 JSON，每个都是几百个坐标；而它们是规则的，用纯函数现算即可 ——
 * 同一份数据在任何设备上算出的布局完全一致（可复现），体积也小得多。
 * 所以每个场景的 `plan.objects` 是**模块加载时由纯函数算好的数组**，
 * `plan.sand` 更是只写了"几圈、多高、间距多少"，具体哪一格由
 * `buildSandColumns()` 现算 —— 那个函数也是**导出**的，Engine 直接遍历它就行，
 * 不需要在引擎里再抄一遍排布规则（两处各写一遍必然会漂移）。
 *
 * ────────────────────────────────────────────────────────────
 * 所有上限数字都是 import 来的，不是凭记忆写的
 * ────────────────────────────────────────────────────────────
 * | 上限 | 出处 |
 * |---|---|
 * | 流体粒子 | `fluidCapacity(preset, isMobile, isLowEnd)`（`perf/StressTestScenes.ts`） |
 * | 沙 | `sandCellCapacity()` = `SAND_CONFIG.maxActivePerStep` = 8000（`config.ts`） |
 * | 动态刚体 | `rigidCapacity(isMobile)`（桌面 800 / 手机 300） |
 * | 静态刚体 | 800 / 2000 —— ⚠ Engine 的 `performanceLimits()` 是私有方法、没导出常量，只能在这里抄一份，见 `STATIC_LIMIT_*` |
 * 于是"某个示例是不是超了"不靠人肉记忆，`validateExample()` 会逐条算出来；
 * 断言里对全部内置场景跑一遍并要求**零问题**，数据写错一个 defId 或越界一米都会被抓住。
 *
 * ────────────────────────────────────────────────────────────
 * 坐标约定（两个系统不一样，这里写清楚，免得摆出来的东西"跑偏"）
 * ────────────────────────────────────────────────────────────
 * - **物体与流体用世界坐标**：X / Z 以原点为中心（±sizeX/2），Y 从 0 起，1 单位 = 1 米；
 *   和 `BuildingDef` 的原点约定一致（`position` 是**底面中心**）。
 * - **沙用世界坐标，但 Engine 落格时要换算**：体素格坐标 = 世界 X/Z + 半宽
 *   （`gridX = Math.round(worldX + sizeX / 2)`），Y 不变。这一条是从现有
 *   `Engine.applyStressPlan()` 的沙分支反推出来的（那里直接对着体素格坐标写数字）——
 *   这里用世界坐标是为了"同一个场景里所有数字都是同一套坐标"，换算只在一处做。
 *
 * ────────────────────────────────────────────────────────────
 * 每个示例都自带"地面整平"要求
 * ────────────────────────────────────────────────────────────
 * 空白世界的地形是**随机的**（`TerrainGenerator` 按种子生成），所以任何手工摆的场景
 * 都可能被一座山穿过。所以每个 `plan.ground` 都写明"把半径 R 的一片地整平到 y"：
 * `y` 取的是该档位的地形基准高度 `WORLD_SIZES[size].terrain.baseHeight`
 * （新手 7 / 标准 10 / 大型 13），不是拍出来的数 —— 引擎按"整平到 baseHeight"
 * 生成出来的地，仍然像那一档该有的地形，只是示例占的这一片是平的。
 *
 * ────────────────────────────────────────────────────────────
 * 如实说明：这些示例"看不到"什么
 * ────────────────────────────────────────────────────────────
 * 每个场景都带 `blindSpots`，写清它**测不到 / 演示不了**的东西。
 * 最要紧的两条：模型只能绕 Y 轴旋转（`BuildingPiece` 只有 `rotationY`），
 * 所以拼不出真正倾斜的构件；沙只有"方阵"和"圆丘"两种排布，
 * 拼不出任意形状的沙堡。这些都在下面各自的 `blindSpots` 里写明了。
 */

import { getBuildingDef } from '../data/buildingCatalog';
import type { JointConfig } from '../data/jointTypes';
import { getFluidPreset, type FluidType } from '../fluid/FluidPresets';
import { getWorldSize, type WorldSizeId } from '../worldSize';
import {
  fluidCapacity,
  fluidVolumeM3,
  rigidCapacity,
  sandCellCapacity,
} from '../perf/StressTestScenes';

// ============================================================================
// 上限（能 import 的都 import，import 不到的写清出处）
// ============================================================================

/**
 * 静态刚体上限。出处：`Engine.performanceLimits()`（桌面 `staticMax: 2000`、
 * 移动 `staticMax: 800`）。那个方法是**私有**的、没有导出常量，
 * 与 `perf/StressTestScenes.ts` 里 `RIGID_LIMIT_*` 的处境一样，只能抄一份；
 * 那边改了这里必须跟着改（全局搜 `STATIC_LIMIT_DESKTOP` 能找到这两处）。
 */
const STATIC_LIMIT_DESKTOP = 2000;
const STATIC_LIMIT_MOBILE = 800;

/** 静态物体允许比地面低多少米（墙体/地基这类东西底面正好落在地面上，留一点浮点容差） */
const STATIC_BELOW_GROUND_TOLERANCE = 1;

// ============================================================================
// 数据结构
// ============================================================================

/** 一个要摆的物体（`position` 是**底面中心**，与 BuildingDef 约定一致） */
export interface ExampleObjectSpec {
  defId: string;
  position: [number, number, number];
  rotationY: number;
  /** 静态 = 钉住不动；动态 = 受物理影响（会掉、会浮、会被冲走） */
  mode: 'static' | 'dynamic';
}

/** 流体：在哪个盒子里生成多少粒子 */
export interface ExampleFluidPlan {
  preset: FluidType;
  /** 桌面端粒子数 */
  count: number;
  /** 生成盒 [minX, minY, minZ, maxX, maxY, maxZ]（世界坐标） */
  box: [number, number, number, number, number, number];
}

/** 一根沙柱（由 `buildSandColumns()` 现算；Engine 按它逐格写沙） */
export interface SandColumn {
  /** 世界坐标（Engine 落格时 x/z 各加半宽，见文件头） */
  x: number;
  y: number;
  z: number;
  /** 这跟柱子有几格高 */
  height: number;
}

/**
 * 沙的排布计划。
 *
 * 两种排布都是**列阵**（每一列从 `origin.y` 往上叠 `height` 格），
 * 因为项目里的沙就是"体素格"，没有别的形状可表达：
 * - `grid`：与压力测试一致，每行 8 列、列距 `spacing` 往 +Z 铺开；
 * - `mound`：以 `origin` 为底中心的**同心方环**圆丘 —— 环 r 的柱高 = `height - 2r`（最小 1），
 *   柱子在半边长为 `r × spacing` 的方环上按 `spacing` 均匀分布（每环 8r 根）。
 *   这是"能拼出坡面"的最简办法，用来演示安息角/滑坡。
 */
export type ExampleSandPlan =
  | {
      shape: 'grid';
      /** 柱数（每行 8 根） */
      columns: number;
      height: number;
      spacing: number;
      origin: [number, number, number];
    }
  | {
      shape: 'mound';
      /** 圈数（0 表示只有中心一根） */
      rings: number;
      height: number;
      spacing: number;
      origin: [number, number, number];
    };

/** 地面整平要求 */
export interface ExampleGroundPlan {
  /** 整平后的地面高度（米）。取该档位的 `terrain.baseHeight`，见文件头 */
  y: number;
  /** 以世界原点为中心，这个半径内的地要整平 */
  radius: number;
}

export interface ExamplePlan {
  /** 加载前先把这一片地整平（不做的话示例会被随机地形穿过，见文件头） */
  ground: ExampleGroundPlan;
  /** 要摆的物体（静态在前、动态在后不是必须的，但 `joints` 的下标指向这个数组） */
  objects: readonly ExampleObjectSpec[];
  /** 物体之间的关节（下标字符串，`''` 表示连到世界 —— 与 combos.ts 的约定一致） */
  joints: readonly JointConfig[];
  fluid: ExampleFluidPlan | null;
  sand: ExampleSandPlan | null;
  /** 生成的先后顺序（中文，Engine 按这个顺序执行；写出来是为了"生成顺序"本身可被审查） */
  steps: readonly string[];
}

export interface ExampleScene {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** 教什么 / 看什么 */
  focus: string;
  size: WorldSizeId;
  plan: ExamplePlan;
  /** 需要哪些能力（引擎没有就显示提示而不是空白） */
  requires: readonly string[];
  /**
   * 移动端用量系数（桌面恒为 1）。
   * ⚠ 这个数是**人为定的**：需求只说了"移动端要降级"，没说降多少。
   * 定成 0.5 的理由与 `perf/StressTestScenes.ts` 的 `LOW_END_EXTRA_SCALE` 一样 ——
   * 让它可见、可改，而不是散在生成代码里成为一个说不清来历的魔数。
   * 只有真的会超上限的场景才设成 0.5，其余保持 1（不做无意义的降级）。
   */
  mobileScale: number;
  /** 这个示例看不到什么（如实写明） */
  blindSpots: readonly string[];
}

// ============================================================================
// 纯函数：把一个档位的地面高度算出来（不写死数字）
// ============================================================================

/** 该档位的地形基准高度 —— 示例的"地面"就整平到它 */
export function defaultFloorY(sizeId: WorldSizeId): number {
  return getWorldSize(sizeId).terrain.baseHeight;
}

/** 该档位的世界半宽/半深（用于越界校验） */
function halfExtents(sizeId: WorldSizeId): { halfX: number; halfZ: number; sizeY: number } {
  const preset = getWorldSize(sizeId);
  return { halfX: preset.sizeX / 2, halfZ: preset.sizeZ / 2, sizeY: preset.sizeY };
}

// ============================================================================
// 纯函数：常用摆法
// ============================================================================

/** 摆一个物体（`position` 是底面中心；动态/静态由 mode 决定） */
function at(
  defId: string,
  position: [number, number, number],
  mode: 'static' | 'dynamic' = 'static',
  rotationY = 0,
): ExampleObjectSpec {
  return { defId, position, rotationY, mode };
}

/**
 * 围一圈正方形的墙（做水池 / 沙池 / 房间）。
 *
 * @param half 墙**中心线**到中心的距离（米）—— 内墙面比它再往内半个墙厚
 * @param center 方池中心的水平位置 [x, z]（缺省世界原点）
 *
 * 拐角处四面墙会**互相重叠**（不是"刚好相切"）。这是一个刻意的让步：
 * 要做到零重叠，拐角必然留缝，而缝会让水从角上漏光 ——
 * 对静态刚体来说重叠不会产生分离力（Rapier 只在动态体之间推开），
 * 所以"重叠"在这里的代价只是几个 AABB 相交，而"有缝"的代价是演示直接失败。
 */
function squareWalls(
  defId: string,
  half: number,
  y: number,
  center: [number, number] = [0, 0],
): ExampleObjectSpec[] {
  const def = getBuildingDef(defId);
  const length = def?.size[0] ?? 4;
  const thickness = def?.size[2] ?? 0.4;
  const span = 2 * half;
  const perSide = Math.max(1, Math.round(span / length));
  // 同一侧相邻两块之间的中心距：让首尾两块正好顶到两端
  const step = perSide > 1 ? (span - length) / (perSide - 1) : 0;
  const specs: ExampleObjectSpec[] = [];
  for (let side = 0; side < 4; side += 1) {
    // 0/1 = 南北（沿 X 排），2/3 = 东西（旋转 90° 后沿 Z 排）
    const rotated = side >= 2;
    const sign = side % 2 === 0 ? -1 : 1;
    for (let i = 0; i < perSide; i += 1) {
      const offset = perSide > 1 ? -span / 2 + length / 2 + i * step : 0;
      if (rotated) {
        specs.push(
          at(defId, [center[0] + sign * (half - thickness / 2), y, center[1] + offset], 'static', Math.PI / 2),
        );
      } else {
        specs.push(at(defId, [center[0] + offset, y, center[1] + sign * (half - thickness / 2)]));
      }
    }
  }
  return specs;
}

/** 在半径为 radius 的圆上均匀摆 count 个物体（围一圈石头用），圆心可偏移 */
function ring(
  defId: string,
  count: number,
  radius: number,
  y: number,
  center: [number, number] = [0, 0],
): ExampleObjectSpec[] {
  const specs: ExampleObjectSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    specs.push(at(defId, [center[0] + Math.cos(angle) * radius, y, center[1] + Math.sin(angle) * radius]));
  }
  return specs;
}

/** 沿一条直线摆 count 个物体（多米诺 / 栅栏用） */
function line(
  defId: string,
  count: number,
  start: [number, number, number],
  step: [number, number, number],
  mode: 'static' | 'dynamic' = 'static',
  rotationY = 0,
): ExampleObjectSpec[] {
  const specs: ExampleObjectSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    specs.push(
      at(
        defId,
        [start[0] + step[0] * i, start[1] + step[1] * i, start[2] + step[2] * i],
        mode,
        rotationY,
      ),
    );
  }
  return specs;
}

/** 一层层往上叠的方块塔（测堆叠与支撑）；返回底面在 baseY 的方块 */
function blockTower(
  defId: string,
  cols: number,
  rows: number,
  layers: number,
  center: [number, number],
  baseY: number,
): ExampleObjectSpec[] {
  const def = getBuildingDef(defId);
  const [sx, sy, sz] = def?.size ?? [1, 1.1, 1];
  // 每块之间留 2 毫米缝：肉眼是贴着的，AABB 判定上完全不重叠（和 stressTestMaps 同一做法）
  const gap = 0.002;
  const specs: ExampleObjectSpec[] = [];
  for (let layer = 0; layer < layers; layer += 1) {
    for (let c = 0; c < cols; c += 1) {
      for (let r = 0; r < rows; r += 1) {
        specs.push(
          at(
            defId,
            [
              center[0] + (c - (cols - 1) / 2) * (sx + gap),
              baseY + layer * (sy + gap),
              center[1] + (r - (rows - 1) / 2) * (sz + gap),
            ],
            'dynamic',
          ),
        );
      }
    }
  }
  return specs;
}

/** 一个物体下标 → 关节体的字符串形式（`''` 表示世界） */
function body(index: number | null): string {
  return index === null ? '' : String(index);
}

// ============================================================================
// 场景
// ============================================================================

// ---------------------------------------------------------------- 1 沙漠绿洲
const DESERT_SIZE: WorldSizeId = 'standard';
const DESERT_FLOOR = defaultFloorY(DESERT_SIZE);
const desertOasis: ExampleScene = {
  id: 'desert_oasis',
  name: '沙漠绿洲',
  emoji: '🏜️',
  description: '棕榈与巨石围着一小滩水，旁边堆着一座沙丘。',
  focus:
    '看沙与水的关系：往沙丘上倒水，水会顺着坡往下渗、最后在低处积成水洼；' +
    '用「湿沙」把沙丘弄湿再冲，沙会被搬走又在别处堆起来（泥流）。',
  size: DESERT_SIZE,
  mobileScale: 1,
  requires: ['fluid', 'sand', 'building'],
  blindSpots: [
    '沙不会真的"吸水"：只有水粒子直接碰到沙格时才会变湿，蒸发/下渗都没做',
    '沙丘是规则排布的一圈圈方环，不是随机起伏的天然沙丘',
  ],
  plan: {
    ground: { y: DESERT_FLOOR, radius: 24 },
    objects: [
      ...ring('rock_boulder', 6, 12, DESERT_FLOOR),
      at('tree_palm', [-13, DESERT_FLOOR, 2]),
      at('tree_palm', [13, DESERT_FLOOR, -2]),
      at('cactus_small_column', [5, DESERT_FLOOR, 12]),
      at('cactus_small_column', [-5, DESERT_FLOOR, -12]),
      ...line('light_block', 2, [-5, DESERT_FLOOR, 6], [10, 0, 0], 'dynamic'),
    ],
    joints: [],
    fluid: {
      preset: 'water',
      count: 1200,
      box: [-2.6, DESERT_FLOOR, -2.6, 2.6, DESERT_FLOOR + 0.8, 2.6],
    },
    sand: { shape: 'mound', rings: 3, height: 8, spacing: 2, origin: [-12, DESERT_FLOOR, -12] },
    steps: ['整平地面', '摆巨石与棕榈', '倒一滩水', '堆沙丘'],
  },
};

// ------------------------------------------------------------ 2 水车与河流
const RIVER_SIZE: WorldSizeId = 'standard';
const RIVER_FLOOR = defaultFloorY(RIVER_SIZE);
/** 河道两岸墙的中心线（墙厚 0.4 → 净宽 3.6 米） */
const RIVER_WALL_Z = 2.0;
/**
 * 河道的物体顺序是**刻意排好的**（关节用下标引用物体，排错了就会连到墙上）：
 * 0..7 北岸墙、8..15 南岸墙、16/17 上下游堵头、18 水车、19 水泵、20 阀门、21..23 三条船。
 */
const RIVER_TURBINE_INDEX = 18;
const RIVER_VALVE_INDEX = 20;
const riverObjects: ExampleObjectSpec[] = [
  // 南北两岸各 8 块石墙（4 米一块，x 从 -14 到 14 → 合起来正好 32 米长）
  ...line('wall_stone', 8, [-14, RIVER_FLOOR, -RIVER_WALL_Z], [4, 0, 0]),
  ...line('wall_stone', 8, [-14, RIVER_FLOOR, RIVER_WALL_Z], [4, 0, 0]),
  // 上下游各堵一块（旋转 90° 让墙顺着河道宽度方向横过来）
  at('wall_stone', [-16.2, RIVER_FLOOR, 0], 'static', Math.PI / 2),
  at('wall_stone', [16.2, RIVER_FLOOR, 0], 'static', Math.PI / 2),
  at('water_turbine', [0, RIVER_FLOOR, -0.85]),
  at('water_pump', [-12, RIVER_FLOOR, -1.2]),
  at('valve_gate', [14, RIVER_FLOOR, 0]),
  ...line('boat_row', 3, [-8, RIVER_FLOOR + 0.4, 0], [11, 0, 0], 'dynamic', Math.PI / 2),
];
const waterwheelRiver: ExampleScene = {
  id: 'waterwheel_river',
  name: '水车与河流',
  emoji: '💧',
  description: '一条 32 米长的河道，中间架着水车，上游有水泵、下游有闸阀。',
  focus:
    '看流动与关节：水车用一个旋转关节（带电机）钉在自己的轴上，水流过来时它就转；' +
    '把上游的水泵按住，水位差越大流得越急，急流能把三条小船推着走。',
  size: RIVER_SIZE,
  mobileScale: 0.5,
  requires: ['fluid', 'physics', 'joints', 'building'],
  blindSpots: [
    '水车的转速是**电机给的固定值**，不是"被水推着转"——耦合只把流体的阻力与浮力施加到刚体上，还没有反过来驱动关节电机',
    '河床是整平过的平地，不是被水冲刷出来的 V 形谷',
  ],
  plan: {
    ground: { y: RIVER_FLOOR, radius: 30 },
    objects: riverObjects,
    joints: [
      {
        type: 'revolute',
        bodyA: body(null),
        bodyB: body(RIVER_TURBINE_INDEX),
        anchor: [0, RIVER_FLOOR + 1.57, -0.85],
        axis: [0, 0, 1],
        motorSpeed: 1.2,
        label: '水车主轴（电机驱动）',
      },
      {
        // 阀门：沿竖直方向滑动（闸门升降），限位 0~1.2 米
        type: 'prismatic',
        bodyA: body(null),
        bodyB: body(RIVER_VALVE_INDEX),
        anchor: [14, RIVER_FLOOR + 0.74, 0],
        axis: [0, 1, 0],
        limits: { min: 0, max: 1.2 },
        label: '阀门升降',
      },
    ],
    fluid: {
      preset: 'water',
      count: 5000,
      box: [-15.6, RIVER_FLOOR, -1.6, 15.6, RIVER_FLOOR + 1.0, 1.6],
    },
    sand: null,
    steps: ['整平地面', '砌 32 米河道', '摆水车 / 水泵 / 阀门', '连两个关节', '注水', '放三条小船'],
  },
};

// ------------------------------------------------------------ 3 沙堡与海
const CASTLE_SIZE: WorldSizeId = 'standard';
const CASTLE_FLOOR = defaultFloorY(CASTLE_SIZE);
const sandcastleSea: ExampleScene = {
  id: 'sandcastle_sea',
  name: '沙堡与海',
  emoji: '🏖️',
  description: '沙滩上堆着一座沙堡，右边是海（一小片水）与一道防波堤。',
  focus:
    '看侵蚀与浮力：把沙堡堆到海水能打到的位置，看浪一层层把沙冲走、又在坡脚下堆起来；' +
    '把小船放进海里，对比同样大小的方块（它是实心的，会沉）。',
  size: CASTLE_SIZE,
  mobileScale: 0.5,
  requires: ['fluid', 'sand', 'buoyancy', 'building'],
  blindSpots: [
    '海水不会自动涨潮：只有你自己再倒水，水位才会变化',
    '沙堡是同心方环的圆丘，"城堡的墙与塔"要玩家自己用沙或方块搭',
  ],
  plan: {
    ground: { y: CASTLE_FLOOR, radius: 26 },
    objects: [
      // 防波堤：4 块石墙旋转 90°，沿 Z 排成一条线，挡住海的那一侧
      ...line('wall_stone', 4, [9, CASTLE_FLOOR, -6], [0, 0, 4], 'static', Math.PI / 2),
      at('tree_palm', [-16, CASTLE_FLOOR, 10]),
      at('tree_palm', [-13, CASTLE_FLOOR, 13]),
      // 沙堡旁边散着三块巨石（圆心偏移到沙丘那一侧，免得挡住海）
      ...ring('rock_boulder', 3, 8, CASTLE_FLOOR, [-14, 6]),
      at('boat_row', [14, CASTLE_FLOOR + 0.4, 0], 'dynamic'),
      at('light_block', [13, CASTLE_FLOOR + 0.5, 4], 'dynamic'),
      at('light_block', [15, CASTLE_FLOOR + 0.5, -4], 'dynamic'),
    ],
    joints: [],
    fluid: {
      preset: 'water',
      count: 4500,
      box: [11, CASTLE_FLOOR, -6, 17, CASTLE_FLOOR + 0.8, 6],
    },
    sand: { shape: 'mound', rings: 4, height: 12, spacing: 2, origin: [-14, CASTLE_FLOOR, -2] },
    steps: ['整平沙滩', '堆沙堡', '倒海水', '摆防波堤与小船'],
  },
};

// ------------------------------------------------------------ 4 洪水街道
const FLOOD_SIZE: WorldSizeId = 'standard';
const FLOOD_FLOOR = defaultFloorY(FLOOD_SIZE);
const floodStreet: ExampleScene = {
  id: 'flood_street',
  name: '洪水街道',
  emoji: '🌊',
  description: '两排共 12 堵墙夹出一条街，街上散着 12 个箱子和 3 块门板。',
  focus:
    '看大水量下的耦合：把水灌满街道，看箱子被冲得翻滚、门板漂起来 —— ' +
    '这是"流体冲击力"最直观的一课，也是移动端最容易掉帧的场景（粒子数在手机上会降级）。',
  size: FLOOD_SIZE,
  mobileScale: 0.5,
  requires: ['fluid', 'physics', 'building'],
  blindSpots: [
    '水不会冲坏墙：墙是静态刚体，只有动态的箱子/门板会被推走',
    '房子只有"一堵墙"，看不出窗户门洞对水流的引导',
  ],
  plan: {
    ground: { y: FLOOD_FLOOR, radius: 30 },
    objects: [
      // 街道两侧各 6 堵墙（z = ±4），墙沿 X 连成一排房子
      ...line('wall_stone', 6, [-10, FLOOD_FLOOR, -4], [4, 0, 0]),
      ...line('wall_stone', 6, [-10, FLOOD_FLOOR, 4], [4, 0, 0]),
      // 街上的箱子（动态）：水一来就会被推走
      ...line('light_block', 6, [-8, FLOOD_FLOOR, -2.4], [3.2, 0, 0], 'dynamic'),
      ...line('light_block', 6, [-8, FLOOD_FLOOR, 2.4], [3.2, 0, 0], 'dynamic'),
      ...line('door_wood', 3, [-6, FLOOD_FLOOR, 0], [6, 0, 0], 'dynamic'),
    ],
    joints: [],
    fluid: {
      preset: 'water',
      count: 6000,
      // 盒子只比水量高一点（约 0.3 米深）：盒子给太高的话水会先"下成一场雨"再落地
      box: [-14, FLOOD_FLOOR, -3, 14, FLOOD_FLOOR + 0.6, 3],
    },
    sand: null,
    steps: ['整平地面', '立两排房子', '街上摆箱子与门板', '灌水'],
  },
};

// ------------------------------------------------------------ 5 多米诺骨牌
const DOMINO_SIZE: WorldSizeId = 'novice';
const DOMINO_FLOOR = defaultFloorY(DOMINO_SIZE);
/** 多米诺用「钢格栅门」（1 × 2.1 × 0.08）：又薄又高，是库里最像骨牌的东西 */
const DOMINO_DEF = 'door_grille_steel';
/** 间距 0.85 米 < 牌高 2.1 米 —— 这是"一张能推倒下一张"的必要条件 */
const DOMINO_STEP = 0.85;
const DOMINO_COUNT = 20;
const domino: ExampleScene = {
  id: 'domino',
  name: '多米诺',
  emoji: '🁢',
  description: '20 块薄板排成一条 16 米的长队，队伍一头摆着起手坡与一个球。',
  focus:
    '看连锁与动量：让起手坡上的球滚过去撞第一块 —— 或者按 3 切到选择工具、' +
    '选中最靠坡的那一块、把它往前挪一点再放下（它就不稳了）—— 之后它会撞倒下一张、' +
    '下一张再撞下一张：只要间距小于板高，倒下的链就不会停在中间。',
  size: DOMINO_SIZE,
  mobileScale: 1,
  requires: ['physics', 'building'],
  blindSpots: [
    '模型只能绕 Y 轴旋转，排不出"拐弯的多米诺"；想摆造型请玩家自己一块块挪',
    '薄板碰撞用的是 AABB 近似，"轻轻擦过要不要倒"的临界情况会和真实骨牌不同',
  ],
  plan: {
    ground: { y: DOMINO_FLOOR, radius: 16 },
    objects: [
      at('ramp_wood', [0, DOMINO_FLOOR, -12]),
      at('ball_soccer', [0, DOMINO_FLOOR + 1.2, -11.2], 'dynamic'),
      ...line(
        DOMINO_DEF,
        DOMINO_COUNT,
        [0, DOMINO_FLOOR, -9.5],
        [0, 0, DOMINO_STEP],
        'dynamic',
      ),
    ],
    joints: [],
    fluid: null,
    sand: null,
    steps: ['整平地面', '摆起手坡与球', '一块块摆多米诺'],
  },
};

// ---------------------------------------------------------- 6 斜坡滚球对比
const RAMP_SIZE: WorldSizeId = 'novice';
const RAMP_FLOOR = defaultFloorY(RAMP_SIZE);
const rollingBallRamp: ExampleScene = {
  id: 'rolling_ball_ramp',
  name: '斜坡滚球',
  emoji: '🎳',
  description: '三条坡度与材质都不同的坡道平行摆开，每条坡上各放一个球。',
  focus:
    '看摩擦与坡度：木坡、混凝土坡道、钢格栅坡道 —— 同样一个球从坡顶滚下来的速度不一样。' +
    '想看更极端的对比，用「物理」面板把坡道材质换成冰，再滚一次。',
  size: RAMP_SIZE,
  mobileScale: 1,
  requires: ['physics', 'building'],
  blindSpots: [
    '坡度由模型自带，数据里改不了倾角：想更陡只能换一个模型或把坡道叠起来',
    '球的模型是足球（22 厘米），不是理想球体，滚动会有轻微不规则',
  ],
  plan: {
    ground: { y: RAMP_FLOOR, radius: 16 },
    objects: [
      at('ramp_wood', [-6, RAMP_FLOOR, -4]),
      at('ramp_concrete', [0, RAMP_FLOOR, -4]),
      at('ramp_grating_steel', [6, RAMP_FLOOR, -4]),
      at('ball_soccer', [-6, RAMP_FLOOR + 1.6, -1.4], 'dynamic'),
      at('ball_soccer', [0, RAMP_FLOOR + 1.6, -1.4], 'dynamic'),
      at('ball_soccer', [6, RAMP_FLOOR + 1.6, -1.4], 'dynamic'),
      // 坡脚铺一排矮墙把球拦住（4 块沿 X 连起来，正好盖住三条坡的落点），
      // 免得球滚出画面之后玩家找不到它 —— "球滚哪去了"是最常见的困惑
      ...line('wall_stone', 4, [-8, RAMP_FLOOR, 8], [4, 0, 0]),
    ],
    joints: [],
    fluid: null,
    sand: null,
    steps: ['整平地面', '摆三条坡道', '坡顶放球', '坡脚拦墙'],
  },
};

// -------------------------------------------------------------- 7 吊桥
const BRIDGE_SIZE: WorldSizeId = 'standard';
const BRIDGE_FLOOR = defaultFloorY(BRIDGE_SIZE);
/** 两根石柱（1×4×1）立在 x = ±6 */
const BRIDGE_PILLAR_X = 6;
const drawbridge: ExampleScene = {
  id: 'drawbridge',
  name: '吊桥',
  emoji: '🌉',
  description: '两根 4 米高的石柱之间吊着一块木桥面，桥面先坠、再被绳子拉住。',
  focus:
    '看绳索关节的"只能拉、不能推"：松手（按播放）后桥面会一直往下坠，' +
    '坠到绳子拉直才被吊住 —— 所以吊桥的桥面是"挂着"的，不是"架着"的。',
  size: BRIDGE_SIZE,
  mobileScale: 1,
  requires: ['joints', 'physics', 'building'],
  blindSpots: [
    '绳子是"长度约束"不是真绳子：它不会弯曲、不会缠在柱子上，也不怕被剪断',
    '柱顶到桥面的绳长是写死的 6.4 米：把柱子挪走，桥面就悬不到那个高度了',
  ],
  plan: {
    ground: { y: BRIDGE_FLOOR, radius: 20 },
    objects: [
      at('pillar_stone', [-BRIDGE_PILLAR_X, BRIDGE_FLOOR, 0]),
      at('pillar_stone', [BRIDGE_PILLAR_X, BRIDGE_FLOOR, 0]),
      at('floor_wood', [0, BRIDGE_FLOOR + 3.2, 0], 'dynamic'),
      at('light_block', [-9, BRIDGE_FLOOR + 0.6, 0], 'dynamic'),
      at('light_block', [9, BRIDGE_FLOOR + 0.6, 0], 'dynamic'),
    ],
    joints: [
      {
        type: 'rope',
        bodyA: body(2),
        bodyB: body(0),
        anchor: [-BRIDGE_PILLAR_X, BRIDGE_FLOOR + 4, 0],
        length: 6.4,
        label: '左吊索',
      },
      {
        type: 'rope',
        bodyA: body(2),
        bodyB: body(1),
        anchor: [BRIDGE_PILLAR_X, BRIDGE_FLOOR + 4, 0],
        length: 6.4,
        label: '右吊索',
      },
    ],
    fluid: null,
    sand: null,
    steps: ['整平地面', '立两根石柱', '摆桥面与桥头箱', '连两根吊索'],
  },
};

// -------------------------------------------------------------- 8 沙漏
const HOURGLASS_SIZE: WorldSizeId = 'standard';
const HOURGLASS_FLOOR = defaultFloorY(HOURGLASS_SIZE);
/** 下箱 8×8（中心线半径 4），墙高 3 米 */
const HOURGLASS_HALF = 4;
/** 上箱底板顶面：正好压在下箱墙上（下箱墙 3 米高） */
const HOURGLASS_DECK_Y = HOURGLASS_FLOOR + 3;
/** 上箱底板：8×8 的 2 米小砖，中间挖掉 2×2 = 4 块，留一个 4×4 的"颈" */
const hourglassDeck: ExampleObjectSpec[] = (() => {
  const specs: ExampleObjectSpec[] = [];
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      if (i === 1 || i === 2) {
        if (j === 1 || j === 2) continue; // 中间 4 块不铺 = 落沙口
      }
      specs.push(at('floor_stone_tile', [-3 + i * 2, HOURGLASS_DECK_Y - 0.12, -3 + j * 2]));
    }
  }
  return specs;
})();
const hourglass: ExampleScene = {
  id: 'hourglass',
  name: '沙漏',
  emoji: '⏳',
  description: '上下两个 8 米见方的箱子，上箱底板中间有个 4 米的落沙口。',
  focus:
    '看落沙与堆积：沙从上箱漏下来，在下箱堆成一个锥形丘 —— ' +
    '每漏走一格，上箱的沙面就塌一块，这就是沙的"边坡失稳"最直观的样子。',
  size: HOURGLASS_SIZE,
  mobileScale: 1,
  requires: ['sand', 'physics', 'building'],
  blindSpots: [
    '"颈"是上箱底板中间挖出来的 4 米方孔，不是锥形窄口：模型库里没有能拼出闭合漏斗的斜角件',
    '沙砾不会磨圆、也不会把孔堵住：沙只有"安息角"一条规则',
  ],
  plan: {
    ground: { y: HOURGLASS_FLOOR, radius: 18 },
    objects: [
      ...squareWalls('wall_stone', HOURGLASS_HALF, HOURGLASS_FLOOR),
      ...hourglassDeck,
      // 上箱砌两层（6 米高）：沙丘最高 6 格 = 6 米，正好被箱壁挡住
      ...squareWalls('wall_stone', HOURGLASS_HALF, HOURGLASS_DECK_Y),
      ...squareWalls('wall_stone', HOURGLASS_HALF, HOURGLASS_DECK_Y + 3),
    ],
    joints: [],
    fluid: null,
    sand: {
      shape: 'mound',
      rings: 2,
      height: 6,
      spacing: 1.5,
      origin: [0, HOURGLASS_DECK_Y, 0],
    },
    steps: ['整平地面', '砌下箱', '铺上箱底板（中间留口）', '砌上箱', '装沙'],
  },
};

// ----------------------------------------------------------- 9 水池与船
const POOL_SIZE: WorldSizeId = 'standard';
const POOL_FLOOR = defaultFloorY(POOL_SIZE);
const poolAndBoat: ExampleScene = {
  id: 'pool_and_boat',
  name: '水池与船',
  emoji: '⛵',
  description: '一个 8 米见方的水池，里面漂着两条小船，池底压着一块混凝土地基。',
  focus:
    '看浮力：小船（空心、轻）浮在水面，混凝土地基（47520 公斤）直接沉底 —— ' +
    '浮不浮起来只取决于"排开的水有多重"，和它有多大没关系。',
  size: POOL_SIZE,
  mobileScale: 0.5,
  requires: ['fluid', 'buoyancy', 'physics', 'building'],
  blindSpots: [
    '吃水深度是按 AABB 体积近似算的，不是逐面压力积分：薄壳结构（真正空心的船）算不出来',
    '水不会从池壁渗出去，也不会因为蒸发变少',
  ],
  plan: {
    ground: { y: POOL_FLOOR, radius: 22 },
    objects: [
      ...squareWalls('wall_stone', 4, POOL_FLOOR),
      at('boat_row', [0, POOL_FLOOR + 0.4, -1.6], 'dynamic'),
      at('boat_row', [0, POOL_FLOOR + 0.4, 1.6], 'dynamic', Math.PI / 2),
      at('light_block', [2.8, POOL_FLOOR + 0.6, 2.8], 'dynamic'),
      at('foundation_concrete', [-1, POOL_FLOOR, -1], 'dynamic'),
    ],
    joints: [],
    fluid: {
      preset: 'water',
      count: 6000,
      box: [-3.4, POOL_FLOOR, -3.4, 3.4, POOL_FLOOR + 1.0, 3.4],
    },
    sand: null,
    steps: ['整平地面', '砌水池', '灌水', '放船与地基'],
  },
};

// ------------------------------------------------------------- 10 岩浆池
const LAVA_SIZE: WorldSizeId = 'standard';
const LAVA_FLOOR = defaultFloorY(LAVA_SIZE);
const lavaPool: ExampleScene = {
  id: 'lava_pool',
  name: '岩浆池',
  emoji: '🌋',
  description: '石墙围出一个 8 米见方的岩浆池，旁边立着一簇水晶和一座石喷泉。',
  focus:
    '看"换一种流体"的差别：岩浆比水重也黏得多，丢进去的东西浮得更高、动得更慢；' +
    '面板上把预设切成蜂蜜再对比一次，就能看出"密度"和"黏性"是两个独立参数。',
  size: LAVA_SIZE,
  mobileScale: 1,
  requires: ['fluid', 'buoyancy', 'physics', 'building'],
  blindSpots: [
    '岩浆不会点燃、也不会让东西融化：只有密度、黏性与温度之外的表现都没有做',
    '岩浆不会冷却成岩石 —— 想固化请用沙土面板的「凝固」工具（那是对沙生效的）',
  ],
  plan: {
    ground: { y: LAVA_FLOOR, radius: 20 },
    objects: [
      ...squareWalls('wall_stone', 4, LAVA_FLOOR),
      ...ring('rock_boulder', 4, 9, LAVA_FLOOR),
      at('crystal_cluster', [8, LAVA_FLOOR, 8]),
      at('fountain_stone', [-8, LAVA_FLOOR, -8]),
      at('light_block', [0, LAVA_FLOOR + 1.2, -1], 'dynamic'),
      at('light_block', [1.2, LAVA_FLOOR + 2.4, 0.6], 'dynamic'),
    ],
    joints: [],
    fluid: {
      preset: 'lava',
      count: 3000,
      box: [-3.4, LAVA_FLOOR, -3.4, 3.4, LAVA_FLOOR + 0.8, 3.4],
    },
    sand: null,
    steps: ['整平地面', '砌岩浆池', '围石头与水晶', '灌岩浆', '丢两个方块'],
  },
};

// ----------------------------------------------------------- 11 综合小镇
const TOWN_SIZE: WorldSizeId = 'standard';
const TOWN_FLOOR = defaultFloorY(TOWN_SIZE);
/** 小城里四扇门的门框位置（x, z）—— 门板挂在自己的门框旁边，用旋转关节连到世界 */
const TOWN_DOORS: readonly [number, number, number][] = [
  [-12, -8, 0],
  [-12, 8, Math.PI],
  [12, -8, 0],
  [12, 8, Math.PI],
];
const townObjects: ExampleObjectSpec[] = [
  // 路面：6 块木地板铺成一条 24 米的街
  ...line('floor_wood', 6, [-10, TOWN_FLOOR, 0], [4, 0, 0]),
  // 四扇门：门框静态，门板动态 + 旋转关节（门轴连到世界，与 combos.ts 的 door_kit 一致）
  ...TOWN_DOORS.flatMap(([x, z, rotationY]) => [
    at('door_frame', [x, TOWN_FLOOR, z], 'static', rotationY),
    at('door_wood', [x, TOWN_FLOOR, z + 0.06], 'dynamic', rotationY),
  ]),
  // 小水塘的四块矮墙（中心在 (-6, 6)，半边长 2.4 → 净空 4.4×4.4）
  ...squareWalls('wall_stone', 2.4, TOWN_FLOOR, [-6, 6]),
  // 水车 + 水泵 + 两个齿轮（齿轮用来演示"一个推一个"）
  at('water_turbine', [-4, TOWN_FLOOR, -6]),
  at('water_pump', [8, TOWN_FLOOR, -6]),
  at('gear_pair', [4, TOWN_FLOOR + 0.5, -6], 'dynamic'),
  at('gear', [6, TOWN_FLOOR + 0.5, -6], 'dynamic'),
  at('boat_row', [-6, TOWN_FLOOR + 0.4, 6], 'dynamic'),
  ...line('light_block', 3, [2, TOWN_FLOOR, 6], [1.2, 0, 0], 'dynamic'),
];
/**
 * 小镇物体的下标（关节要按下标引用，所以这里把关键位置写成常量，改数据时一眼能看到影响）：
 * 0..5 路面、6..13 四扇门（门框/门板成对）、14..17 水塘四块墙、18 水车、19 水泵、20/21 齿轮、22 小船、23..25 方块。
 */
const TOWN_TURBINE_INDEX = 18;
const TOWN_GEAR_PAIR_INDEX = 20;
const TOWN_GEAR_INDEX = 21;
const combinedTown: ExampleScene = {
  id: 'combined_town',
  name: '综合小镇',
  emoji: '🏘️',
  description: '一条小街、四扇会开的门、一组齿轮、一条小船、一小片水和一个沙丘。',
  focus:
    '看东西怎么被串起来：门是"旋转关节 + 静态门框"，齿轮是"每个都钉在自己轴上转"，' +
    '小船浮在水上，沙丘在旁边 —— 这是把前面每个示例的机制放进同一个世界的样子。',
  size: TOWN_SIZE,
  mobileScale: 1,
  requires: ['building', 'joints', 'fluid', 'sand', 'physics'],
  blindSpots: [
    '门不会自动开：示例里没有接触发器与逻辑连线（那要在「逻辑连线」面板里手动画）',
    '齿轮没有咬合传动保证：靠几何相切 + 接触求解，转久了会打滑',
  ],
  plan: {
    ground: { y: TOWN_FLOOR, radius: 36 },
    objects: townObjects,
    joints: [
      // 四扇门：每个门板绕自己门框的竖轴转（objects 下标：门框在 6/8/10/12，门板在 7/9/11/13）
      ...TOWN_DOORS.map(([x, z], index) => {
        const doorIndex = 6 + index * 2 + 1;
        return {
          type: 'revolute' as const,
          // 与 combos.ts 的 door_kit 一样：门轴一端连世界、另一端连门板
          bodyA: body(null),
          bodyB: body(doorIndex),
          anchor: [x, TOWN_FLOOR + 1.02, z] as [number, number, number],
          axis: [0, 1, 0] as [number, number, number],
          limits: { min: 0, max: 1.57 },
          label: `第 ${index + 1} 扇门`,
        };
      }),
      // 两个齿轮：各自钉在世界坐标的轴上（轴取 +Z：垂直于排列方向才会"一个推一个"）
      {
        type: 'revolute',
        bodyA: body(null),
        bodyB: body(TOWN_GEAR_PAIR_INDEX),
        anchor: [4, TOWN_FLOOR + 0.62, -6],
        axis: [0, 0, 1],
        label: '齿轮组',
      },
      {
        type: 'revolute',
        bodyA: body(null),
        bodyB: body(TOWN_GEAR_INDEX),
        anchor: [6, TOWN_FLOOR + 0.62, -6],
        axis: [0, 0, 1],
        label: '单齿轮',
      },
      // 水车主轴也给个电机：小镇里"会转的东西"一眼就能找到
      {
        type: 'revolute',
        bodyA: body(null),
        bodyB: body(TOWN_TURBINE_INDEX),
        anchor: [-4, TOWN_FLOOR + 1.57, -6],
        axis: [0, 0, 1],
        motorSpeed: 1.2,
        label: '水车主轴（电机驱动）',
      },
    ],
    fluid: {
      preset: 'water',
      count: 1500,
      box: [-8, TOWN_FLOOR, 4, -4, TOWN_FLOOR + 0.6, 8],
    },
    sand: { shape: 'mound', rings: 2, height: 5, spacing: 2, origin: [16, TOWN_FLOOR, -16] },
    steps: ['整平地面', '铺街与门', '砌水塘注水', '装水车与齿轮', '堆沙丘', '连门与齿轮的关节'],
  },
};

// ------------------------------------------------------------ 12 积木塔
const TOWER_SIZE: WorldSizeId = 'novice';
const TOWER_FLOOR = defaultFloorY(TOWER_SIZE);
const blockTowerScene: ExampleScene = {
  id: 'block_tower',
  name: '积木塔',
  emoji: '🧱',
  description: '3×3 底、3 层高的方块塔（27 块）立在四根 4 米石柱中间，柱顶压着两根木梁。',
  focus:
    '看堆叠与支撑：方块塔是"自由堆叠"（一个关节都没有），抽掉任何一块都会影响整层。' +
    '按 3 切到选择工具、删掉角落那根石柱，看木梁怎么把载荷重新分配（或者直接塌掉）。',
  size: TOWER_SIZE,
  mobileScale: 1,
  requires: ['physics', 'building'],
  blindSpots: [
    '没有真正的有限元：支撑比与接触力是近似值，只能说"哪个更危险"，不能说"应力是多少 MPa"',
    '塔自身是稳定的（27 块）：想看到倒塌得自己抽掉支撑或把重力调大',
  ],
  plan: {
    ground: { y: TOWER_FLOOR, radius: 14 },
    objects: [
      at('pillar_stone', [-2.5, TOWER_FLOOR, -2.5]),
      at('pillar_stone', [2.5, TOWER_FLOOR, -2.5]),
      at('pillar_stone', [-2.5, TOWER_FLOOR, 2.5]),
      at('pillar_stone', [2.5, TOWER_FLOOR, 2.5]),
      ...blockTower('light_block', 3, 3, 3, [0, 0], TOWER_FLOOR),
      // 木梁压在四根柱顶（柱高 4 米）上，从方块塔顶上横过去（塔顶 3.31 米，留出净空）
      at('beam_wood', [0, TOWER_FLOOR + 4, -2.5]),
      at('beam_wood', [0, TOWER_FLOOR + 4, 2.5]),
    ],
    joints: [],
    fluid: null,
    sand: null,
    steps: ['整平地面', '立四根石柱', '叠 5 层方块', '压两根木梁'],
  },
};

// ============================================================================
// 场景表（12 个）
// ============================================================================

export const EXAMPLE_SCENES: readonly ExampleScene[] = [
  desertOasis,
  waterwheelRiver,
  sandcastleSea,
  floodStreet,
  domino,
  rollingBallRamp,
  drawbridge,
  hourglass,
  poolAndBoat,
  lavaPool,
  combinedTown,
  blockTowerScene,
];

/** 按 id 取示例；找不到返回 undefined（调用方自己决定怎么兜底） */
export function getExample(id: string): ExampleScene | undefined {
  return EXAMPLE_SCENES.find((scene) => scene.id === id);
}

// ============================================================================
// 沙的排布（导出给 Engine 用，避免引擎里再抄一份）
// ============================================================================

/**
 * 把沙的计划展开成一根根沙柱（纯函数，可复现）。
 *
 * Engine 的用法（世界坐标 → 体素格坐标的换算见文件头）：
 * ```ts
 * for (const column of buildSandColumns(plan.sand)) {
 *   const gx = Math.round(column.x + grid.halfX);
 *   const gz = Math.round(column.z + grid.halfZ);
 *   for (let dy = 0; dy < column.height; dy += 1) {
 *     grid.setVoxel(gx, Math.floor(column.y) + dy, gz, sandId);
 *   }
 * }
 * ```
 */
export function buildSandColumns(plan: ExampleSandPlan): SandColumn[] {
  const [ox, oy, oz] = plan.origin;
  if (plan.shape === 'grid') {
    const columns: SandColumn[] = [];
    for (let i = 0; i < plan.columns; i += 1) {
      columns.push({
        x: ox + (i % 8) * plan.spacing,
        y: oy,
        z: oz + Math.floor(i / 8) * plan.spacing,
        height: plan.height,
      });
    }
    return columns;
  }

  const columns: SandColumn[] = [{ x: ox, y: oy, z: oz, height: Math.max(1, plan.height) }];
  for (let r = 1; r <= plan.rings; r += 1) {
    const d = r * plan.spacing;
    // 越往上一圈越矮：每升一圈矮 2 格，最后至少留 1 格 —— 这样才有坡面
    const height = Math.max(1, plan.height - 2 * r);
    for (let i = -r; i <= r; i += 1) {
      const offset = i * plan.spacing;
      // 南北两条边（整条都要）
      columns.push({ x: ox + offset, y: oy, z: oz - d, height });
      columns.push({ x: ox + offset, y: oy, z: oz + d, height });
      // 东西两条边（去掉四个角，角已经由南北边放过了，避免同一个位置叠两根柱）
      if (i > -r && i < r) {
        columns.push({ x: ox - d, y: oy, z: oz + offset, height });
        columns.push({ x: ox + d, y: oy, z: oz + offset, height });
      }
    }
  }
  return columns;
}

/** 沙格总数（桌面用量）—— 逐柱累加，不是 `columns × height`（圆丘每圈高度不同） */
export function sandCellCount(scene: ExampleScene): number {
  const plan = scene.plan.sand;
  if (!plan) return 0;
  let total = 0;
  for (const column of buildSandColumns(plan)) total += column.height;
  return total;
}

/** 某档位下这个示例的沙格数（沙的预算是单步 8000 格；不超就不降级） */
export function sandCellCountFor(scene: ExampleScene, isMobile: boolean): number {
  const cells = sandCellCount(scene);
  if (!isMobile) return cells;
  const budget = sandCellCapacity();
  if (cells <= budget) return cells;
  return Math.max(1, Math.round(cells * scene.mobileScale));
}

/** 某档位下这个示例的粒子数（超上限时按 `mobileScale` 降级，再被真实上限夹一次） */
export function fluidCountFor(scene: ExampleScene, isMobile: boolean): number {
  const fluid = scene.plan.fluid;
  if (!fluid) return 0;
  const raw = isMobile ? Math.round(fluid.count * scene.mobileScale) : fluid.count;
  const ceiling = fluidCapacity(fluid.preset, isMobile, false);
  return Math.max(0, Math.min(raw, ceiling));
}

/** 物体数量（按物理模式分开数） */
export function objectCounts(scene: ExampleScene): { staticCount: number; dynamicCount: number } {
  let staticCount = 0;
  let dynamicCount = 0;
  for (const spec of scene.plan.objects) {
    if (spec.mode === 'dynamic') dynamicCount += 1;
    else staticCount += 1;
  }
  return { staticCount, dynamicCount };
}

/**
 * 这批粒子在静止密度下是多少立方米。
 *
 * 直接复用 `perf/StressTestScenes.fluidVolumeM3()`（它按流体的真实粒子半径算），
 * **不在这里自己写 0.16³** —— 那个数一旦某个预设改了半径就错了，
 * 而错误的表现只是"面板上写的体积偏了一点"，没人会去核对。
 */
export function fluidVolume(scene: ExampleScene, isMobile: boolean): number {
  const fluid = scene.plan.fluid;
  if (!fluid) return 0;
  return fluidVolumeM3(fluid.preset, fluidCountFor(scene, isMobile));
}

// ============================================================================
// 校验
// ============================================================================

/**
 * 逐条校验一个示例是否"真的能生成出来"。
 *
 * 返回中文问题列表（空数组 = 没问题）。内置的 12 个场景必须是空的 ——
 * 这是这个文件最重要的保证：**上限、越界、写错的 defId 全部在断言里被抓住**，
 * 而不是等玩家点了「打开示例」之后看到半个世界。
 *
 * 校验的是**桌面档**；移动档额外检查"降级之后确实落在移动上限里"。
 */
export function validateExample(scene: ExampleScene): string[] {
  const problems: string[] = [];
  const { halfX, halfZ, sizeY } = halfExtents(scene.size);
  const sizeName = getWorldSize(scene.size).name;
  const ground = scene.plan.ground;

  // ---- 地面
  if (!Number.isFinite(ground.y) || ground.y <= 0 || ground.y >= sizeY) {
    problems.push(`地面高度 ${ground.y} 不在 0 ~ ${sizeY} 之间（世界高度 ${sizeY}）`);
  }
  if (!Number.isFinite(ground.radius) || ground.radius <= 0) {
    problems.push(`整平半径 ${ground.radius} 不合法`);
  } else if (ground.radius > halfX || ground.radius > halfZ) {
    problems.push(`整平半径 ${ground.radius} 超出了世界的一半（${halfX} × ${halfZ}）`);
  }

  // ---- 物体
  const counts = objectCounts(scene);
  for (let i = 0; i < scene.plan.objects.length; i += 1) {
    const spec = scene.plan.objects[i]!;
    if (!getBuildingDef(spec.defId)) {
      problems.push(`第 ${i} 个物体用了建筑库里没有的 defId「${spec.defId}」`);
    }
    const [x, y, z] = spec.position;
    if (Math.abs(x) > halfX || Math.abs(z) > halfZ) {
      problems.push(`第 ${i} 个物体（${spec.defId}）越界：(${x}, ${z}) 超出 ±${halfX} / ±${halfZ}（${sizeName}）`);
    }
    if (y < 0 || y > sizeY) {
      problems.push(`第 ${i} 个物体（${spec.defId}）的 y=${y} 不在 0 ~ ${sizeY} 之间`);
    }
    // 动态物体必须站在地面上或更高（否则一生成就在地里，会被弹飞）
    if (spec.mode === 'dynamic' && y < ground.y - 0.001) {
      problems.push(`第 ${i} 个动态物体（${spec.defId}）在 y=${y}，低于地面 ${ground.y}`);
    }
    // 静态物体允许略微低于地面（墙/地基的底面正好落在地面上）
    if (spec.mode === 'static' && y < ground.y - STATIC_BELOW_GROUND_TOLERANCE) {
      problems.push(
        `第 ${i} 个静态物体（${spec.defId}）在 y=${y}，比地面 ${ground.y} 低了超过 ${STATIC_BELOW_GROUND_TOLERANCE} 米`,
      );
    }
  }
  if (counts.dynamicCount > rigidCapacity(false)) {
    problems.push(`动态物体 ${counts.dynamicCount} 个，超过桌面上限 ${rigidCapacity(false)}`);
  }
  if (counts.staticCount > STATIC_LIMIT_DESKTOP) {
    problems.push(`静态物体 ${counts.staticCount} 个，超过桌面上限 ${STATIC_LIMIT_DESKTOP}`);
  }
  // 移动端：动态物体不降级（没法"少放几个"而不破坏场景），所以必须一开始就在手机上限内
  if (counts.dynamicCount > rigidCapacity(true)) {
    problems.push(
      `动态物体 ${counts.dynamicCount} 个，超过**手机**上限 ${rigidCapacity(true)} —— 手机没法"少放几个"而不破坏场景，必须改数据`,
    );
  }
  if (counts.staticCount > STATIC_LIMIT_MOBILE) {
    problems.push(`静态物体 ${counts.staticCount} 个，超过手机上限 ${STATIC_LIMIT_MOBILE}`);
  }

  // ---- 关节
  for (let i = 0; i < scene.plan.joints.length; i += 1) {
    const joint = scene.plan.joints[i]!;
    for (const [slot, ref] of [['bodyA', joint.bodyA], ['bodyB', joint.bodyB]] as const) {
      if (ref === '') continue;
      const index = Number(ref);
      if (!Number.isInteger(index) || index < 0 || index >= scene.plan.objects.length) {
        problems.push(`第 ${i} 个关节的 ${slot}="${ref}" 不是合法的物体下标`);
      }
    }
    const [ax, ay, az] = joint.anchor;
    if (Math.abs(ax) > halfX || Math.abs(az) > halfZ || ay < 0 || ay > sizeY) {
      problems.push(`第 ${i} 个关节的锚点 (${ax}, ${ay}, ${az}) 在世界之外`);
    }
  }

  // ---- 流体
  const fluid = scene.plan.fluid;
  if (fluid) {
    const [minX, minY, minZ, maxX, maxY, maxZ] = fluid.box;
    if (!(maxX > minX && maxY > minY && maxZ > minZ)) {
      problems.push(`流体盒不是一个有效的盒子：${fluid.box.join(', ')}`);
    }
    if (Math.abs(minX) > halfX || Math.abs(maxX) > halfX || Math.abs(minZ) > halfZ || Math.abs(maxZ) > halfZ) {
      problems.push(`流体盒超出了世界范围（±${halfX} / ±${halfZ}）：${fluid.box.join(', ')}`);
    }
    if (minY < ground.y - 0.001 || maxY > sizeY) {
      problems.push(`流体盒的 y 区间 [${minY}, ${maxY}] 超出了地面 ${ground.y} ~ 世界顶 ${sizeY}`);
    }
    const desktopCeiling = fluidCapacity(fluid.preset, false, false);
    if (fluid.count <= 0) problems.push('流体粒子数必须大于 0');
    if (fluid.count > desktopCeiling) {
      problems.push(`流体 ${fluid.count} 个粒子，超过桌面「${fluid.preset}」上限 ${desktopCeiling}`);
    }
    // 盒子必须装得下这些粒子（密度超过 100% 时 emitBox 会放弃一部分，看起来像"水少了"）
    const boxVolume = (maxX - minX) * (maxY - minY) * (maxZ - minZ);
    const waterVolume = fluidVolumeM3(fluid.preset, fluid.count);
    if (waterVolume > boxVolume) {
      problems.push(
        `流体盒只有 ${boxVolume.toFixed(1)} 米³，装不下 ${waterVolume.toFixed(1)} 米³ 的水（会少放粒子）`,
      );
    }
    // 移动端降级不能降成 0 或负数
    if (fluidCountFor(scene, true) <= 0) problems.push('移动端降级后粒子数变成了 0');
    if (fluidCountFor(scene, true) > fluidCapacity(fluid.preset, true, false)) {
      problems.push('移动端降级后仍然超过手机上限（降级系数没起作用）');
    }
  } else if (fluidCountFor(scene, true) !== 0) {
    problems.push('没有流体计划，但 fluidCountFor 算出了非零值');
  }

  // ---- 沙
  const sand = scene.plan.sand;
  if (sand) {
    if (sand.spacing <= 0) problems.push(`沙的列距 ${sand.spacing} 必须大于 0`);
    if (sand.height <= 0) problems.push(`沙柱高度 ${sand.height} 必须大于 0`);
    for (const column of buildSandColumns(sand)) {
      if (Math.abs(column.x) > halfX || Math.abs(column.z) > halfZ) {
        problems.push(`有一根沙柱在 (${column.x}, ${column.z})，超出了 ±${halfX} / ±${halfZ}`);
        break;
      }
      if (column.y + column.height > sizeY) {
        problems.push(`有一根沙柱顶到了 y=${column.y + column.height}，超过世界高 ${sizeY}`);
        break;
      }
      if (column.y < ground.y - STATIC_BELOW_GROUND_TOLERANCE) {
        problems.push(`有一根沙柱的底 y=${column.y} 比地面 ${ground.y} 低太多`);
        break;
      }
    }
    const cells = sandCellCount(scene);
    if (cells > sandCellCapacity()) {
      problems.push(`沙 ${cells} 格，超过单步预算 ${sandCellCapacity()} 格`);
    }
    if (sandCellCountFor(scene, true) > sandCellCapacity()) {
      problems.push('移动端降级后沙格数仍然超过单步预算');
    }
  }

  return problems;
}

// ============================================================================
// 描述
// ============================================================================

/** 数值保留 1 位小数（避免 0.30000000000000004 这种浮点尾巴出现在界面上） */
function one(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/**
 * 一行中文摘要（面板卡片与 toast 用）。
 *
 * **降级信息只在真的降级时出现**：桌面数本来就在手机上限内的场景不写这句话，
 * 免得玩家以为"所有示例在手机上都会缩水"（那是假的）。
 */
export function describeExample(scene: ExampleScene): string {
  const size = getWorldSize(scene.size);
  const counts = objectCounts(scene);
  const parts: string[] = [`${scene.emoji} ${scene.name}（${size.name}）`];
  parts.push(`物体 ${counts.staticCount + counts.dynamicCount}（静态 ${counts.staticCount} / 动态 ${counts.dynamicCount}）`);
  if (scene.plan.fluid) {
    const desktop = fluidCountFor(scene, false);
    // 用预设自己的中文名（水 / 油 / 蜂蜜 / 岩浆 / 牛奶）而不是一律写"水"：
    // 岩浆池那个场景写"水 3000 粒子"就是在说假话
    parts.push(`${getFluidPreset(scene.plan.fluid.preset).name} ${desktop} 粒子（约 ${one(fluidVolume(scene, false))} 米³）`);
    const mobile = fluidCountFor(scene, true);
    if (mobile < desktop) parts.push(`移动端会降级到 ${mobile} 粒子`);
  }
  if (scene.plan.sand) {
    const desktop = sandCellCountFor(scene, false);
    parts.push(`沙 ${desktop} 格`);
    const mobile = sandCellCountFor(scene, true);
    if (mobile < desktop) parts.push(`移动端会降级到 ${mobile} 格`);
  }
  parts.push(`看：${scene.focus}`);
  return parts.join('｜');
}

/** 沙的排布用一句话说清（面板上不好画图，用文字把形状交代清楚） */
export function describeSandShape(plan: ExampleSandPlan): string {
  if (plan.shape === 'grid') {
    return `方阵：${plan.columns} 根沙柱（每行 8 根），每根 ${plan.height} 格，列距 ${plan.spacing} 米`;
  }
  return `圆丘：中心 1 根 + ${plan.rings} 圈方环，中心 ${plan.height} 格高，每往外一圈矮 2 格，间距 ${plan.spacing} 米`;
}
