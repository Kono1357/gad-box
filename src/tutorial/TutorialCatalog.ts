/**
 * 教学关卡统一目录（M5 第 4 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 这个文件解决什么问题
 * ────────────────────────────────────────────────────────────
 * 项目里已经有**三套**各自独立的教学关卡表，它们是不同批次写的、互不知道对方存在：
 * | 来源 | 数量 | 表的形状 |
 * |---|---|---|
 * | `tutorial/TutorialLevel.ts`（M2，放置 + 关节 + 触发器） | 3 | `TUTORIAL_LEVELS` |
 * | `tutorial/PhysicsTutorial.ts`（M3，物理） | 6 | `PHYSICS_TUTORIAL_LEVELS` |
 * | `tutorial/FluidSandTutorial.ts`（M4，流体 / 沙土） | 6 | `TUTORIAL_LEVELS` |
 * 于是"一共有多少关、哪一关教什么、我想学流体该从哪关开始"没有任何地方能回答。
 *
 * 本文件**只做登记，不做搬运**：每一关都从原来的表里 `import` 出来再映射成
 * 统一的 `TutorialLevelMeta`，**绝不把 `name` / `goal` / `successHint` 抄成第二份**。
 * 抄一份的直接后果是"改了原表，目录还显示旧文案"，而且没人会发现 ——
 * 断言里专门有一条核对"目录里的文案与原表逐字段相等"，就是为了防这件事。
 *
 * ⚠ 两个同名关卡（流体关 `buoyancy`「浮力与船」与物理关 `phys_buoyancy`「浮力与船」）
 * 显示名一样、id 不同。这里**不做改名**：名字是各自表里的真名，改了反而对不上原表。
 * 面板上靠分类（流体 / 浮力）与 id 区分，见 `describeCatalog()`。
 *
 * ────────────────────────────────────────────────────────────
 * 分类与能力都是**推导**出来的，不是第二份手写表
 * ────────────────────────────────────────────────────────────
 * `requires`（这一关需要哪些能力）：
 * - 物理关：从每个 step 的 `goals[].kind` 推导（`PHYSICS_GOAL_REQUIREMENTS` 是穷举映射，
 *   引擎以后新增一种目标类型时 TS 会直接报错，逼着在这里补一行）；
 * - 建筑关：从每个 step 的 `goal` 推导（同样是穷举映射）；
 * - 流体 / 沙土关：⚠ **只能手工登记**。那六关的判定是闭包（`check(snapshot)`），
 *   数据里只有"建议工具"的中文串（如「泼水（FluidEditor.pour）」），
 *   靠中文字符串猜能力太脆（文案一改就失效），所以这里登记一次，
 *   并在断言里核对"六个 id 一个不漏"（漏登记的会落到兜底能力上，断言能抓到）。
 *
 * `category`（分类）：由 `requires` 按优先级推导，不另写一张表 ——
 * 两个字段各写一份必然有一天对不上。优先级是"越专精的能力越靠前"：
 * 浮力 > 沙土 > 关节 > 触发器 > **物理 > 流体** > 地形 > 建筑。
 * ⚠ 这里把 `physics` 排在 `fluid` / `building` 前面：几乎所有关卡都会用到"按下播放看它动"
 * 与"先放个东西"，若让 `building` 优先，11 关都会变成「建筑」分类。
 *
 * 由这条推导规则，现有 15 关只落到 5 个分类（物理 4 / 关节 4 / 流体 3 / 沙土 2 / 浮力 2）。
 * `基础`/`地形`/`建筑`/`触发器`/`综合` 这 5 个分类**目前是空的** ——
 * 这是推导出来的事实，不是漏登记；以后新增关卡只要在能力上登记，分类会自动跟上。
 */

// ⚠ 三张原表：`TutorialLevel.ts` 与 `FluidSandTutorial.ts` **都导出了 `TUTORIAL_LEVELS`
// 与 `TutorialLevel` 这两个同名符号**，所以必须起别名，否则这一行直接重名冲突。
import {
  TUTORIAL_LEVELS as FLUID_SAND_LEVELS,
  type TutorialLevel as FluidSandTutorialLevelRef,
} from './FluidSandTutorial';
import {
  TUTORIAL_LEVELS as BUILDING_LEVELS,
  type TutorialLevel as BuildingTutorialLevelRef,
  type TutorialStep,
} from './TutorialLevel';
import {
  PHYSICS_TUTORIAL_LEVELS,
  type PhysicsGoal,
  type PhysicsTutorialLevel,
} from './PhysicsTutorial';

/** 统一分类。⚠ 顺序就是面板上的显示顺序，见 `TUTORIAL_CATEGORY_ORDER` */
export type TutorialCategory =
  | '基础'
  | '地形'
  | '建筑'
  | '物理'
  | '关节'
  | '触发器'
  | '浮力'
  | '流体'
  | '沙土'
  | '综合';

/** 面板上的分类显示顺序（教学节奏：先基础后进阶，最后综合） */
export const TUTORIAL_CATEGORY_ORDER: readonly TutorialCategory[] = [
  '基础',
  '地形',
  '建筑',
  '物理',
  '关节',
  '触发器',
  '浮力',
  '流体',
  '沙土',
  '综合',
];

export interface TutorialLevelMeta {
  id: string;
  name: string;
  category: TutorialCategory;
  goal: string;
  successHint: string;
  /** 需要什么能力（找不到就显示"这一关需要 XX 功能"而不是空白） */
  requires: readonly string[];
}

// ============================================================================
// 能力（capability）
// ============================================================================

/**
 * 能力 id → 中文名。
 *
 * 为什么要有一层"能力 id"而不是直接写中文：面板要判断"当前引擎有没有这个功能"
 * （比如某个构建里没带流体系统），拿 id 比较才不会因为文案微调而失配。
 */
export const TUTORIAL_REQUIREMENT_LABELS: Record<string, string> = {
  building: '建筑放置（按 2 切到建筑工具）',
  terrain: '地形笔刷（按 1 切到地形工具）',
  physics: '刚体物理模拟（按播放键让它动起来）',
  joints: '关节系统（旋转 / 固定 / 绳索…）',
  trigger: '触发器与触发区',
  fluid: '流体（泼水 / 加水 / 冻结）',
  sand: '沙土物理（堆沙 / 湿沙）',
  buoyancy: '流体与刚体的耦合（浮力 / 阻力）',
  save: '本地存档（Ctrl+S）',
};

/**
 * 能力的稳定显示顺序。
 *
 * 用它把推导出来的能力列表排序：不然"先遍历到哪个 step 就写哪个"会让同一关的
 * `requires` 顺序取决于数据里 step 的书写顺序 —— 那种顺序不稳定，也不好比对。
 */
const REQUIREMENT_ORDER: readonly string[] = [
  'building',
  'terrain',
  'physics',
  'joints',
  'trigger',
  'fluid',
  'buoyancy',
  'sand',
  'save',
];

/** 按能力 id 排序（不在表里的能力排最后，保持它们之间的相对顺序） */
function sortRequirements(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    const ia = REQUIREMENT_ORDER.indexOf(a);
    const ib = REQUIREMENT_ORDER.indexOf(b);
    return (ia < 0 ? REQUIREMENT_ORDER.length : ia) - (ib < 0 ? REQUIREMENT_ORDER.length : ib);
  });
}

/** 能力 id → 中文说明；查不到时**如实显示 id**，绝不编一个像样的名字出来 */
export function describeRequirement(id: string): string {
  return TUTORIAL_REQUIREMENT_LABELS[id] ?? `「${id}」功能`;
}

/**
 * 当前构建缺少哪些能力。
 *
 * @param requires 关卡要求的能力
 * @param available 引擎实际提供的能力（Engine 传入；空数组＝什么都没有）
 */
export function missingRequirements(
  requires: readonly string[],
  available: readonly string[],
): string[] {
  const present = new Set(available);
  return requires.filter((id) => !present.has(id));
}

/**
 * 缺能力时给玩家看的一句话。
 *
 * 返回 `''` 表示什么都不缺（调用方按"空串＝不显示"处理，与项目的 HintBanner 约定一致）。
 * 这条文案就是需求里写的"这一关需要 XX 功能"——**绝不返回空白**：
 * 空白在界面上和"面板坏了"没法区分。
 *
 * 参数只要求 `{ requires }` 这一个字段（结构化类型）：
 * 教学关卡与内置示例（`tutorial/Examples.ts`）都能用它，
 * 不需要为了共用一句文案而让两个类型互相 import。
 */
export function describeMissingRequirements(
  level: { requires: readonly string[] },
  available: readonly string[],
): string {
  const missing = missingRequirements(level.requires, available);
  if (missing.length === 0) return '';
  return `这一关需要 ${missing.map(describeRequirement).join('、')} 功能（当前版本没有）`;
}

// ============================================================================
// 能力推导
// ============================================================================

/**
 * 物理目标类型 → 需要的能力（**穷举**映射）。
 *
 * 写成 `Record<PhysicsGoal['kind'], …>` 而不是 `Record<string, …>`：
 * 引擎以后新增一种 `PhysicsGoalKind`，这一行会**直接编译不过**，
 * 于是"教学目录忘了登记新能力"这件事在构建期就暴露了，而不是等玩家看到空白。
 */
const PHYSICS_GOAL_REQUIREMENTS: Record<PhysicsGoal['kind'], readonly string[]> = {
  'place-object': ['building'],
  'set-gravity': ['physics'],
  'set-material': ['physics'],
  'create-joint': ['joints'],
  'apply-force': ['physics'],
  'run-steps': ['physics'],
  'trigger-zone': ['trigger'],
  'see-collapse': ['physics'],
  'see-float': ['fluid', 'buoyancy'],
  manual: [],
};

/** 建筑教学步骤目标 → 需要的能力（同样是穷举映射） */
const BUILDING_STEP_REQUIREMENTS: Record<TutorialStep['goal'], readonly string[]> = {
  place: ['building'],
  joint: ['joints'],
  trigger: ['trigger'],
  interact: ['physics'],
  manual: [],
};

/**
 * 流体 / 沙土六关需要的能力。
 * ⚠ **手工登记**（原因见文件头）：只能靠这份表，所以断言里核对了六个 id 一个不漏。
 */
const FLUID_SAND_REQUIREMENTS: Record<string, readonly string[]> = {
  'flow-downhill': ['fluid'],
  // 浮力关要"往水里放个东西"，所以除了流体还要建筑放置
  buoyancy: ['fluid', 'buoyancy', 'building'],
  gate: ['fluid'],
  'sand-collapse': ['sand'],
  mudflow: ['sand', 'fluid'],
  // 洪水关要"看它把箱子冲得动"，所以还要刚体物理与放置
  flood: ['fluid', 'physics', 'building'],
};

/** 登记表里没有的流体/沙土关卡（新增关卡忘了登记时）用的兜底能力 —— 有值总比空白强 */
const FLUID_SAND_FALLBACK_REQUIREMENTS: readonly string[] = ['fluid'];

/**
 * 能力 → 分类的优先级表（谁在前听谁的）。
 *
 * 越专精的能力越靠前：浮力 / 沙土 / 关节这些"这一关独有的东西"才算这一关的分类，
 * 而 physics（按下播放）和 building（先放个东西）几乎人人都要，只能排在后面当兜底。
 *
 * ⚠ `trigger` 排在 `physics` **之后**，这一条不合直觉但有必要：
 * 触发器在现有教学关里几乎都是"量尺"而不是主题（例如摩擦力那一关用触发区判断
 * 滑块有没有滑过某个位置）。若把 trigger 提前，那关就会变成「触发器」分类 ——
 * 那是个会被一眼看成 bug 的结果。真有一关的主题就是触发器时，
 * 应当给它一个更专精的能力 id，而不是靠调这张表的顺序。
 */
const REQUIREMENT_CATEGORY_PRIORITY: readonly {
  requirement: string;
  category: TutorialCategory;
}[] = [
  { requirement: 'buoyancy', category: '浮力' },
  { requirement: 'sand', category: '沙土' },
  { requirement: 'joints', category: '关节' },
  { requirement: 'fluid', category: '流体' },
  { requirement: 'physics', category: '物理' },
  { requirement: 'trigger', category: '触发器' },
  { requirement: 'terrain', category: '地形' },
  { requirement: 'building', category: '建筑' },
  { requirement: 'save', category: '综合' },
];

/** 一个能力都没有时（理论上不会发生）落到"基础"，不返回空分类 */
const DEFAULT_CATEGORY: TutorialCategory = '基础';

/** 从能力推导分类（纯函数：同一个 requires 永远得到同一个分类） */
export function categoryForRequirements(requires: readonly string[]): TutorialCategory {
  const present = new Set(requires);
  for (const entry of REQUIREMENT_CATEGORY_PRIORITY) {
    if (present.has(entry.requirement)) return entry.category;
  }
  return DEFAULT_CATEGORY;
}

// ============================================================================
// 三张原表 → 统一目录
// ============================================================================

/** 流体 / 沙土关 → 目录条目（`name` / `goal` / `successHint` 原样引用，不改一个字） */
function fromFluidSand(level: FluidSandTutorialLevelRef): TutorialLevelMeta {
  const requires = FLUID_SAND_REQUIREMENTS[level.id] ?? FLUID_SAND_FALLBACK_REQUIREMENTS;
  return {
    id: level.id,
    name: level.name,
    category: categoryForRequirements(requires),
    goal: level.goal,
    successHint: level.successHint,
    requires,
  };
}

/** 物理关 → 目录条目 */
function fromPhysics(level: PhysicsTutorialLevel): TutorialLevelMeta {
  const requires = new Set<string>();
  for (const step of level.steps) {
    for (const goal of step.goals) {
      for (const id of PHYSICS_GOAL_REQUIREMENTS[goal.kind]) requires.add(id);
    }
  }
  const sorted = sortRequirements([...requires]);
  return {
    id: level.id,
    name: level.name,
    category: categoryForRequirements(sorted),
    // 原表里最接近"这一关要干什么"的是 summary（一句话主题），不是 completion（通关条件）
    goal: level.summary,
    successHint: level.completion,
    requires: sorted,
  };
}

/**
 * 建筑教学关（M2 那张表）→ 目录条目。
 *
 * 那张表**没有** `goal` / `successHint` 字段（它的字段叫 `description` / `teaching`），
 * 所以这里按语义映射并**如实拼出通关条件**，不编造：
 * - `goal` ← `teaching`（这个字段的语义就是"本关想教会什么"）；
 * - `successHint` ← "依次完成 N 个步骤；最后一步：<最后一步的原文>"。
 *   之所以要带上最后一步的原文：那一步通常就是"看物理跑起来"，是这一关的收尾动作，
 *   光写"完成 3 步"玩家不知道自己还差什么。
 */
function fromBuilding(level: BuildingTutorialLevelRef): TutorialLevelMeta {
  const requires = new Set<string>();
  for (const step of level.steps) {
    for (const id of BUILDING_STEP_REQUIREMENTS[step.goal]) requires.add(id);
  }
  const sorted = sortRequirements([...requires]);
  const lastStep = level.steps[level.steps.length - 1];
  const hint = lastStep
    ? `依次完成 ${level.steps.length} 个步骤；最后一步：${lastStep.text}`
    : `依次完成 ${level.steps.length} 个步骤`;
  return {
    id: level.id,
    name: level.name,
    category: categoryForRequirements(sorted),
    goal: level.teaching || level.description,
    successHint: hint,
    requires: sorted,
  };
}

/**
 * 全部教学关卡的统一目录：3 关建筑 + 6 关物理 + 6 关流体/沙土 = 15 关。
 *
 * 顺序刻意是"从易到难"：先建筑施工（放东西 / 连关节），再物理（为什么动），
 * 最后流体与沙土（两个附加的粒子系统）。它同时也是 `tutorialsByCategory()` 的稳定基础 ——
 * 同一分类内保持这里的先后顺序。
 */
export const TUTORIAL_CATALOG: readonly TutorialLevelMeta[] = [
  ...BUILDING_LEVELS.map(fromBuilding),
  ...PHYSICS_TUTORIAL_LEVELS.map(fromPhysics),
  ...FLUID_SAND_LEVELS.map(fromFluidSand),
];

/** 按 id 取关卡；找不到返回 undefined（调用方自己决定怎么兜底） */
export function getTutorial(id: string): TutorialLevelMeta | undefined {
  return TUTORIAL_CATALOG.find((level) => level.id === id);
}

/**
 * 按分类分组。
 *
 * 返回 `Map` 而不是普通对象：分类是中文键，`Map` 不经过 `Object.prototype` 的键名转换，
 * 也不会因为将来加一个叫 `__proto__` 的分类而出洋相。
 * **只包含真的有关卡的分**类 —— 空分类不放进 Map，避免面板渲染出一堆空标题。
 */
export function tutorialsByCategory(): Map<string, TutorialLevelMeta[]> {
  const grouped = new Map<string, TutorialLevelMeta[]>();
  // 先按声明顺序建好空桶：Map 的插入顺序 = 遍历顺序，这样面板上的分类顺序是稳定的
  for (const category of TUTORIAL_CATEGORY_ORDER) grouped.set(category, []);
  for (const level of TUTORIAL_CATALOG) {
    const bucket = grouped.get(level.category);
    if (bucket) bucket.push(level);
    else grouped.set(level.category, [level]);
  }
  // 删掉空桶（新建的 Map 里没有别的键，所以这里是安全的）
  for (const [category, levels] of grouped) {
    if (levels.length === 0) grouped.delete(category);
  }
  return grouped;
}

/** 一行中文摘要：共 N 关，覆盖 K 个分类（后面附上每个分类各几关，一行写完） */
export function describeCatalog(): string {
  const grouped = tutorialsByCategory();
  const total = TUTORIAL_CATALOG.length;
  if (total === 0) return '📚 教学目录：还没有任何关卡';
  const breakdown = TUTORIAL_CATEGORY_ORDER.filter((category) => grouped.has(category))
    .map((category) => `${category} ${grouped.get(category)?.length ?? 0}`)
    .join(' / ');
  return `📚 教学目录：共 ${total} 关，覆盖 ${grouped.size} 个分类（${breakdown}）`;
}

/** 某一关在总目录里的序号（从 1 起）；找不到返回 0 —— 面板显示"第 X / N 关"用 */
export function tutorialNumber(id: string): number {
  const index = TUTORIAL_CATALOG.findIndex((level) => level.id === id);
  return index < 0 ? 0 : index + 1;
}
