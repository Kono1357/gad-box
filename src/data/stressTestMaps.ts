/**
 * 压力测试场景的数据表（不含生成逻辑 —— 真正的生成由 Engine 做）。
 *
 * ## 为什么"场景"也只是一份数据
 *
 * 和 `maps.ts` 的思路一致：**不存物体快照，存"生成配方"**。
 * 500 个箱子的完整位姿如果存成 JSON 就是几百 KB，而它们是规则的
 * （10×10 底、每层 1.101 米、位置完全能算出来），所以这里只描述
 * "怎么排"，由 `build(count)` 现算 —— 同一份数据在任何设备上算出的布局都一致。
 *
 * 与 `MapDefinition` 的字段对应关系（便于以后统一处理）：
 * `id` / `name` / `emoji` / `description` / `size` 五个字段含义完全相同，
 * 另外三个是压力测试特有的：`desktopCount` / `mobileCount`（数量）与 `build`（布局）。
 *
 * ## 所有 defId 都是核对过的真实 id
 *
 * 取值来自 `BUILDING_CATALOG`（`src/data/buildings/structure.ts` + `props.ts`，
 * 本轮共 77 个模型），核对命令见本文件末尾注释。
 * `position` 是**底面中心**（与 BuildingDef 的原点约定一致，见 `src/building/types.ts`）。
 */

import type { WorldSizeId } from '../worldSize';

export type StressScenarioId = 'box_tower_500' | 'gear_train_100' | 'drawbridge_50';

export interface StressObjectSpec {
  /** 用哪个建筑模型（必须真实存在于 buildingCatalog，先去核对） */
  defId: string;
  /** 相对场景原点的偏移 */
  position: [number, number, number];
  rotationY: number;
  /** 形成关节时的伙伴下标；没有关节就不填 */
  jointTo?: number;
  jointType?: 'fixed' | 'revolute' | 'prismatic' | 'spherical' | 'rope' | 'spring';
  /** 关节轴 */
  jointAxis?: [number, number, number];
}

export interface StressScenario {
  id: StressScenarioId;
  name: string;
  emoji: string;
  /** 中文说明：这个场景测什么 */
  description: string;
  /** 推荐世界档位 */
  size: WorldSizeId;
  /** 桌面端物体总数（你声明的目标数量） */
  desktopCount: number;
  /** 移动端降级后的数量 */
  mobileCount: number;
  /** 生成函数：按 count 生成物体列表（纯数据，不碰引擎） */
  build(count: number): StressObjectSpec[];
  /** 完成判据的中文描述（面板显示） */
  successHint: string;
}

/**
 * 关节名对照：本文件的 `'spherical'` 就是 `jointTypes.ts` 里的 `'ball'`
 * （同一个球关节，需求文档用前者、引擎类型用后者）。
 * 本文件实际只用到 `'revolute'` 与（可选的）`'rope'`，两者名字一致，不需要转换。
 */

// ============================================================
// 场景 1：500 箱子塔
// ============================================================

/**
 * 箱子用 `light_block`（光源方块，1.0 × 1.1 × 1.0）。
 *
 * 为什么是它：模型库里**没有**专门的"箱子 / 木箱"——
 * 逐个核对过 `src/data/buildings/*.ts` 的 size，只有 light_block 是 1×1×1 量级的立方体
 * （`cabinet_wood` 1×1.2×0.56、`fridge` 0.7×1.8×0.8 都是薄柜子，叠起来像纸牌屋）。
 */
const TOWER_DEF_ID = 'light_block';
/** light_block 的包围盒（宽 × 高 × 深），与 props.ts 中的 size 一致 */
const TOWER_SIZE: readonly [number, number, number] = [1.0, 1.1, 1.0];
/** 每层 10 × 10 = 100 个：正好 5 层凑满 500，是需求里给的排布 */
const TOWER_COLUMNS = 10;
const TOWER_ROWS = 10;
/** 水平留 2 毫米缝：肉眼看起来是贴着的，AABB 判定上却完全不重叠（不会"穿模"） */
const TOWER_GAP_XZ = 0.002;
/** 层间留 1 毫米缝（需求原文：贴合或留 1 毫米缝）—— 留缝比贴合更安全，浮点误差不会让判定翻转 */
const TOWER_GAP_Y = 0.001;

/** 把第 index 个（共 total 个）排在以原点为中心的一行上 */
function centeredOffset(index: number, total: number, size: number, gap: number): number {
  return (index - (total - 1) / 2) * (size + gap);
}

function buildBoxTower(count: number): StressObjectSpec[] {
  const perLayer = TOWER_COLUMNS * TOWER_ROWS;
  const specs: StressObjectSpec[] = [];
  for (let i = 0; i < count; i++) {
    const layer = Math.floor(i / perLayer);
    const inLayer = i % perLayer;
    const column = inLayer % TOWER_COLUMNS;
    const row = Math.floor(inLayer / TOWER_COLUMNS);
    specs.push({
      defId: TOWER_DEF_ID,
      position: [
        centeredOffset(column, TOWER_COLUMNS, TOWER_SIZE[0], TOWER_GAP_XZ),
        layer * (TOWER_SIZE[1] + TOWER_GAP_Y),
        centeredOffset(row, TOWER_ROWS, TOWER_SIZE[2], TOWER_GAP_XZ),
      ],
      rotationY: 0,
      // 塔是"自由堆叠"：一个关节都不加，倒了就是倒了（这正是要测的东西）
    });
  }
  return specs;
}

// ============================================================
// 场景 2：100 齿轮传动链
// ============================================================

/** 齿轮（0.95 × 0.25 × 0.95，机械类） */
const GEAR_DEF_ID = 'gear';
/** 齿轮直径 0.95 = 中心距：相邻齿轮的 AABB 恰好相切（重叠 0，判定上绝不穿模） */
const GEAR_PITCH = 0.95;
/**
 * 关节轴取水平 +Z：齿轮链条沿 +X 排开，轴必须**垂直于链条方向**才能"一个推一个"地传动。
 * 轴取 Y（竖直）会变成一排各自打转的陀螺，取 Z 才是齿轮传动。
 */
const GEAR_AXIS: readonly [number, number, number] = [0, 0, 1];
/** 抬到 0.5 米是因为齿轮立起来后半径 0.475 —— 贴地会把轴压进地里 */
const GEAR_Y = 0.5;

function buildGearTrain(count: number): StressObjectSpec[] {
  const specs: StressObjectSpec[] = [];
  for (let i = 0; i < count; i++) {
    specs.push({
      defId: GEAR_DEF_ID,
      // 沿 +X 排成一条直线，整体以原点为中心（100 个齿轮总长约 95 米 → 推荐大型档）
      position: [(i - (count - 1) / 2) * GEAR_PITCH, GEAR_Y, 0],
      rotationY: 0,
      // 不填 jointTo = 连到静态世界：每个齿轮被"钉"在自己的轴上原位自转，
      // 动力靠齿面接触（或由引擎给奇数号齿轮加电机）一级级传下去
      jointType: 'revolute',
      jointAxis: [GEAR_AXIS[0], GEAR_AXIS[1], GEAR_AXIS[2]],
    });
  }
  return specs;
}

// ============================================================
// 场景 3：50 座吊桥同时放下
// ============================================================

/** 桥面：木地板（4 × 0.25 × 4）—— 模型库里最像"一块桥板"的构件 */
const BRIDGE_DECK_DEF_ID = 'floor_wood';
/** 支柱：石柱（1 × 4 × 1） */
const BRIDGE_PILLAR_DEF_ID = 'pillar_stone';
/** 桥面宽度（X 向）= 4（floor_wood 的 size[0]） */
const BRIDGE_DECK_WIDTH = 4;
/** 支柱宽度 = 1（pillar_stone 的 size[0]） */
const BRIDGE_PILLAR_WIDTH = 1;
/** 支柱中心距 = 桥面宽 + 柱宽 = 5 时，桥面两端与两根柱子**正好相切**（零重叠） */
const BRIDGE_SPAN = BRIDGE_DECK_WIDTH + BRIDGE_PILLAR_WIDTH;
/** 柱高 4 米，桥面挂在柱顶下方 0.4 米：上下摆动时不会与柱顶相撞 */
const BRIDGE_DECK_Y = 3.6;
/** 相邻两座桥的横向间距：柱宽 1 + 桥面间隙，留 0.5 米空隙 */
const BRIDGE_CELL_X = 6.5;
/** 行距 = 桥面进深 4 + 1 米空隙 */
const BRIDGE_CELL_Z = 5;
/** 桥面转动轴：水平 +Z（垂直于桥面跨度方向）—— 吊桥绕它"放下" */
const BRIDGE_AXIS: readonly [number, number, number] = [0, 0, 1];

/**
 * 一座桥 = 3 个物体：**支柱 A → 支柱 B → 桥面**（顺序是刻意的）。
 *
 * 顺序理由：桥面的 `jointTo` 指向支柱 A（同组**更小**的下标），
 * 这样引擎按数组顺序建刚体时，关节的另一端一定已经存在，不需要"延迟建关节"。
 *
 * `count` 不是 3 的倍数时，最后一组只生成组内实际需要的部件（50 = 16 座整桥 + 1 组只有两根柱）。
 */
function buildDrawbridges(count: number): StressObjectSpec[] {
  const groups = Math.ceil(count / 3);
  // 排成接近正方形的网格，避免 50 座桥拉成一条 300 米的线
  const perRow = Math.max(1, Math.ceil(Math.sqrt(groups)));
  const rowCount = Math.ceil(groups / perRow);
  // 桥是从 baseX 向 +X 延伸 5 米的，所以居中偏移要把"跨度"也算进去
  const offsetX = -((perRow - 1) * BRIDGE_CELL_X + BRIDGE_SPAN) / 2;
  const offsetZ = -((rowCount - 1) * BRIDGE_CELL_Z) / 2;

  const specs: StressObjectSpec[] = [];
  for (let i = 0; i < count; i++) {
    const group = Math.floor(i / 3);
    const part = i % 3;
    const column = group % perRow;
    const rowIndex = Math.floor(group / perRow);
    const baseX = offsetX + column * BRIDGE_CELL_X;
    const baseZ = offsetZ + rowIndex * BRIDGE_CELL_Z;
    if (part === 0) {
      // 支柱 A（铰点这一侧）
      specs.push({ defId: BRIDGE_PILLAR_DEF_ID, position: [baseX, 0, baseZ], rotationY: 0 });
    } else if (part === 1) {
      // 支柱 B
      specs.push({ defId: BRIDGE_PILLAR_DEF_ID, position: [baseX + BRIDGE_SPAN, 0, baseZ], rotationY: 0 });
    } else {
      // 桥面：夹在两根柱子中间，绕 +Z 轴铰接在支柱 A 上
      specs.push({
        defId: BRIDGE_DECK_DEF_ID,
        position: [baseX + BRIDGE_SPAN / 2, BRIDGE_DECK_Y, baseZ],
        rotationY: 0,
        jointTo: group * 3,
        jointType: 'revolute',
        jointAxis: [BRIDGE_AXIS[0], BRIDGE_AXIS[1], BRIDGE_AXIS[2]],
      });
    }
  }
  return specs;
}

// ============================================================
// 场景表
// ============================================================

/**
 * 移动端的动态刚体预算（需求里给的 300）。
 * 桌面数一律超过它，所以手机上**必然降级**，`resolveStressCount` 的 note 会如实写出来。
 */
const MOBILE_DYNAMIC_BODY_BUDGET = 300;

export const STRESS_SCENARIOS: readonly StressScenario[] = [
  {
    id: 'box_tower_500',
    name: '500 箱子塔',
    emoji: '🏗️',
    description:
      '500 个方块叠成 10×10 底、5 层的塔（移动端 120 个 = 2 层）。用来测最基础也最吃性能的东西：' +
      '大量刚体的接触求解、堆叠稳定性与休眠。塔越高越容易晃，任何一处求解不到位都会从上层开始塌。',
    size: 'standard',
    desktopCount: 500,
    mobileCount: 120,
    build: buildBoxTower,
    successHint:
      '整塔立住即为通过：静置 10 秒后塔顶水平位移小于 0.2 米算"稳"；' +
      '再把重力切到木星跑一遍，塌掉的层数就是这套迭代次数的极限。',
  },
  {
    id: 'gear_train_100',
    name: '100 齿轮传动链',
    emoji: '⚙️',
    description:
      '100 个齿轮沿一条直线排成传动链（移动端 30 个），每个齿轮都用旋转关节钉在静态世界里，' +
      '关节轴水平且垂直于链条。用来测关节数量对性能的影响，以及动力能否一级级传到链尾。',
    // 100 个齿轮总长约 95 米：新手档 48 米、标准档 96 米都放不下，必须大型档
    size: 'large',
    desktopCount: 100,
    mobileCount: 30,
    build: buildGearTrain,
    successHint:
      '给每隔一个的齿轮加电机（相邻两个转向相反），链尾的齿轮能在 5 秒内转起来就算通过；' +
      '数一数有多少个齿轮"发呆不转"，那就是接触求解漏掉的地方。',
  },
  {
    id: 'drawbridge_50',
    name: '50 座吊桥同时放下',
    emoji: '🌉',
    description:
      '50 件物体（移动端 12 件）排成一片吊桥：每 3 件一组 = 两根石柱 + 一块木桥面，' +
      '桥面用旋转关节铰接在左柱上。用来测大量**同类型关节同时动作**时的表现，' +
      '也是"吊桥放下"这类机关玩法的基准场景。',
    size: 'standard',
    desktopCount: 50,
    mobileCount: 12,
    build: buildDrawbridges,
    successHint:
      '所有桥面能在 2 秒内同时转到水平位、且不掉出两根柱子之间就算通过；' +
      '如果有的桥面转得慢或穿过了柱子，说明子步数不够或关节没限制住。',
  },
];

/** 按 id 取场景；找不到返回 undefined（调用方自己决定要不要兜底） */
export function getStressScenario(id: string): StressScenario | undefined {
  return STRESS_SCENARIOS.find((scenario) => scenario.id === id);
}

/**
 * 按设备档位决定用哪个数量，并如实说明是否降级。
 *
 * 规则（与需求一致，`tier` 只影响文案，不影响数量 —— 因为**桌面数一律超过
 * 手机 300 个动态刚体的预算**，任何档位的手机都必须降级）：
 * - 桌面（`!isMobile`）→ `desktopCount`，`degraded: false`；
 * - 手机（`isMobile`）→ `mobileCount`，`degraded: true`（低配 / 中配 / 高配都降）。
 */
export function resolveStressCount(
  scenario: StressScenario,
  tier: 'low' | 'medium' | 'high',
  isMobile: boolean,
): { count: number; degraded: boolean; note: string } {
  const tierName = tier === 'low' ? '低配' : tier === 'medium' ? '中配' : '高配';
  if (!isMobile) {
    return {
      count: scenario.desktopCount,
      degraded: false,
      note: `桌面端（${tierName}）：${scenario.desktopCount} 个物体，未降级`,
    };
  }
  const caution = tier === 'low' ? '；低配设备若掉帧，请再手动折半' : '';
  return {
    count: scenario.mobileCount,
    degraded: true,
    note:
      `移动端降级：${scenario.desktopCount} → ${scenario.mobileCount} 个` +
      `（手机动态刚体上限 ${MOBILE_DYNAMIC_BODY_BUDGET}）${caution}`,
  };
}

// ============================================================
// defId 核对记录（写下来，避免以后有人凭记忆改数据）
// ============================================================
//
// 命令（在 /root/work/god-sandbox 下执行）：
//
//   node -e "import('./src/data/buildingCatalog.ts')" 不能直接跑，先用 esbuild 打包成 mjs：
//
//   npx esbuild --bundle --format=esm --platform=node --log-level=error \
//     --outfile=/tmp/probe/catalog.mjs /tmp/probe/entry.ts
//   # entry.ts: export { BUILDING_CATALOG } from '<repo>/src/data/buildingCatalog';
//   node -e "import('/tmp/probe/catalog.mjs').then(m => console.log(
//     m.BUILDING_CATALOG.map(d => [d.id, d.category, d.size.join('x')].join('\t')).join('\n')))"
//
// 输出中与本文件相关的三行（已确认存在）：
//   light_block     奇幻   1x1.1x1     —— 场景 1 的"箱子"（库里唯一的 1×1×1 立方体）
//   gear            机械   0.95x0.25x0.95 —— 场景 2 的齿轮
//   floor_wood      结构   4x0.25x4    —— 场景 3 的桥面
//   pillar_stone    结构   1x4x1       —— 场景 3 的支柱
