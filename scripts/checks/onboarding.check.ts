/**
 * M5 第 3+4 批断言：教学目录 / 完成度 / 新手引导 / 示例场景 / 帮助中心。
 *
 * 这一批最容易犯的错有两类，断言就是照着它们写的：
 * 1. **抄了第二份数据**（目录里把流体 6 关的文案重抄一遍、示例里写一个不存在的 defId）。
 *    这种错不会让程序崩，只会让"改了原表、界面还显示旧文案"悄悄发生。
 *    所以这里反复做"逐字段与原表相等"的核对，而不是只看 id 在不在。
 * 2. **边界数字是编的**（粒子数超上限、坐标越界、完成度在无关卡时变成 NaN）。
 *    `validateExample()` 把上限核对逻辑搬进了数据层，这里对 12 个示例全跑一遍要求零问题。
 *
 * 另外，本文件**不使用真 DOM**：所有模块都在 Node（无 `document`、无 `localStorage`）下构造。
 * 需要验证"能画出东西"的地方用一个最小的假 DOM（`FakeElement`），
 * 它只实现本批代码真正用到的那几个接口（appendChild / textContent / style / dataset /
 * addEventListener），不假装自己是个浏览器。
 */

import {
  TUTORIAL_CATALOG,
  TUTORIAL_CATEGORY_ORDER,
  TUTORIAL_REQUIREMENT_LABELS,
  categoryForRequirements,
  describeCatalog,
  describeMissingRequirements,
  describeRequirement,
  getTutorial,
  missingRequirements,
  tutorialNumber,
  tutorialsByCategory,
} from '../../src/tutorial/TutorialCatalog';
import {
  TUTORIAL_PROGRESS_STORAGE_KEY,
  TutorialProgress,
  type ProgressStorage,
} from '../../src/tutorial/TutorialProgress';
import {
  ONBOARDING_STEPS,
  ONBOARDING_STORAGE_KEY,
  Onboarding,
  emptyOnboardingState,
  type OnboardingState,
} from '../../src/tutorial/Onboarding';
import {
  EXAMPLE_SCENES,
  buildSandColumns,
  defaultFloorY,
  describeExample,
  describeSandShape,
  fluidCountFor,
  getExample,
  objectCounts,
  sandCellCount,
  sandCellCountFor,
  validateExample,
} from '../../src/tutorial/Examples';
import {
  HELP_CATEGORIES,
  HELP_EXAMPLE_BY_CATEGORY,
  HELP_TOPICS,
  HelpCenter,
  searchHelpTopics,
} from '../../src/ui/HelpCenter';
import { TUTORIAL_LEVELS as FLUID_SAND_LEVELS } from '../../src/tutorial/FluidSandTutorial';
import { PHYSICS_TUTORIAL_LEVELS } from '../../src/tutorial/PhysicsTutorial';
import { TUTORIAL_LEVELS as BUILDING_LEVELS } from '../../src/tutorial/TutorialLevel';
import { fluidCapacity, sandCellCapacity } from '../../src/perf/StressTestScenes';

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

/**
 * 读仓库根目录的 index.html，取出所有 `id="..."`。
 *
 * 用来核对新手引导的 `anchor` 选择器是不是真的指到了某个元素 ——
 * 指错地方比不指还糟（玩家会盯着一个无关的面板找半天），而这种错
 * 单看代码是发现不了的。用 `process.cwd()` 而不是 `import.meta.url`：
 * 断言会被 esbuild 打包到 `.verify/` 下，相对 import.meta.url 的路径会指到别处去。
 * 文件读不到时返回 null（断言里按"跳过这一项"处理，不让读取失败污染整轮结果）。
 */
function readIndexHtmlIds(): Set<string> | null {
  try {
    const path = resolve(process.cwd(), 'index.html');
    if (!existsSync(path)) return null;
    const html = readFileSync(path, 'utf8');
    const ids = new Set<string>();
    for (const match of html.matchAll(/id="([^"]+)"/g)) ids.add(match[1]!);
    return ids;
  } catch {
    return null;
  }
}

/** 需求点名的流体 / 沙土 6 关 id —— 用 id 断言"目录确实收录了它们" */
const FLUID_SAND_IDS: readonly string[] = [
  'flow-downhill',
  'buoyancy',
  'gate',
  'sand-collapse',
  'mudflow',
  'flood',
];

/** 手机端粒子上限（`particleLimitFor('high', true)` = 3000，见 FluidPresets.ts） */
const MOBILE_PARTICLE_BUDGET = 3000;

const CHINESE = /[\u4e00-\u9fa5]/;

// ============================================================================
// 假存储 / 假 DOM（只实现本批代码真正用到的那几个接口）
// ============================================================================

interface FakeStorage {
  storage: ProgressStorage | null;
  map: Map<string, string>;
  writes: number;
  removes: number;
}

/** 可用的内存存储（顺便记下写/删次数，用来验证"真的写进去了"） */
function memoryStorage(initial: Record<string, string> = {}): FakeStorage {
  const map = new Map<string, string>(Object.entries(initial));
  const box: FakeStorage = {
    map,
    writes: 0,
    removes: 0,
    storage: {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        box.writes += 1;
        map.set(key, value);
      },
      removeItem: (key) => {
        box.removes += 1;
        map.delete(key);
      },
    },
  };
  return box;
}

/** 写就抛的存储（无痕模式 / 配额满） */
function failingWriteStorage(): FakeStorage {
  const box: FakeStorage = {
    map: new Map(),
    writes: 0,
    removes: 0,
    storage: {
      getItem: () => null,
      setItem: () => {
        box.writes += 1;
        throw new Error('模拟：配额已满');
      },
      removeItem: () => {
        throw new Error('模拟：删不掉');
      },
    },
  };
  return box;
}

/** 读就抛的存储（有些浏览器里"访问 localStorage"本身就会抛） */
function failingReadStorage(): ProgressStorage {
  return {
    getItem: () => {
      throw new Error('模拟：存储被禁用');
    },
    setItem: () => undefined,
    removeItem: () => undefined,
  };
}

/** 假 DOM 元素：只实现 appendChild / textContent / style / dataset / addEventListener */
class FakeElement {
  readonly tagName: string;
  children: FakeElement[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  id = '';
  type = '';
  open = false;
  disabled = false;
  title = '';
  placeholder = '';
  value = '';
  private text = '';

  constructor(tagName: string, readonly ownerDocument: FakeDocument) {
    this.tagName = tagName;
  }

  get textContent(): string {
    return this.text;
  }

  /** 和真 DOM 一样：写 textContent 会把子节点清掉（本批代码依赖这个语义清列表） */
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    const list = this.listeners[type] ?? [];
    list.push(handler);
    this.listeners[type] = list;
  }

  removeEventListener(type: string, handler: (ev: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== handler);
  }

  /** 触发某个事件（断言里点按钮用） */
  fire(type: string): void {
    for (const handler of this.listeners[type] ?? []) handler({ type });
  }

  /** 深度优先找出所有满足条件的后代（含自身） */
  find(predicate: (el: FakeElement) => boolean, out: FakeElement[] = []): FakeElement[] {
    if (predicate(this)) out.push(this);
    for (const child of this.children) child.find(predicate, out);
    return out;
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

// ============================================================================

export function runOnboardingChecks(check: CheckFn): void {
  // =========================================================== 1 教学目录
  {
    check(
      '目录：至少 12 关（需求下限）',
      TUTORIAL_CATALOG.length >= 12,
      `实际 ${TUTORIAL_CATALOG.length} 关`,
    );

    const ids = TUTORIAL_CATALOG.map((level) => level.id);
    const uniqueIds = new Set(ids);
    check('目录：id 互不重复', uniqueIds.size === ids.length, `去重后 ${uniqueIds.size} / ${ids.length}`);
    check(
      '目录：id 都是非空字符串（没有 undefined 混进来）',
      ids.every((id) => typeof id === 'string' && id.trim().length > 0),
    );

    // ---- 真的收录了流体 / 沙土 6 关，而且文案与原表逐字段相等（＝没有抄第二份）
    const fluidMismatch: string[] = [];
    for (const level of FLUID_SAND_LEVELS) {
      const meta = getTutorial(level.id);
      if (
        !meta ||
        meta.name !== level.name ||
        meta.goal !== level.goal ||
        meta.successHint !== level.successHint
      ) {
        fluidMismatch.push(level.id);
      }
    }
    check(
      '目录：流体/沙土 6 关全部收录，且 name/goal/successHint 与原表逐字段相等（证明不是抄的第二份）',
      fluidMismatch.length === 0 && FLUID_SAND_LEVELS.length === 6,
      fluidMismatch.length > 0 ? `对不上：${fluidMismatch.join('、')}` : `核对了 ${FLUID_SAND_LEVELS.length} 关`,
    );
    check(
      '目录：需求点名的 6 个流体/沙土 id 一个不少',
      FLUID_SAND_IDS.every((id) => getTutorial(id) !== undefined),
      FLUID_SAND_IDS.filter((id) => getTutorial(id) === undefined).join('、') || '全部命中',
    );
    check(
      '目录：流体/沙土关的 requires 是**登记表里**的值（不是兜底值，说明六个 id 都登记了）',
      FLUID_SAND_IDS.every((id) => (getTutorial(id)?.requires.length ?? 0) > 0),
    );

    // ---- M3 物理关也收录了（同样逐字段核对）
    const physicsMismatch = PHYSICS_TUTORIAL_LEVELS.filter((level) => {
      const meta = getTutorial(level.id);
      return !meta || meta.name !== level.name || meta.goal !== level.summary || meta.successHint !== level.completion;
    }).map((level) => level.id);
    check(
      '目录：物理 6 关全部收录，且 goal/completion 直接引用原表字段',
      physicsMismatch.length === 0 && PHYSICS_TUTORIAL_LEVELS.length === 6,
      physicsMismatch.length > 0 ? `对不上：${physicsMismatch.join('、')}` : `核对了 ${PHYSICS_TUTORIAL_LEVELS.length} 关`,
    );
    check(
      '目录：M2 建筑 3 关也收录了（三张表都进目录，不是只收拾了两张）',
      BUILDING_LEVELS.length === 3 && BUILDING_LEVELS.every((level) => getTutorial(level.id) !== undefined),
      `建筑关 ${BUILDING_LEVELS.length} 个`,
    );
    check(
      '目录：总关数 = 三张原表的关数之和（没有凭空多出/漏掉关卡）',
      TUTORIAL_CATALOG.length === FLUID_SAND_LEVELS.length + PHYSICS_TUTORIAL_LEVELS.length + BUILDING_LEVELS.length,
      `${TUTORIAL_CATALOG.length} = ${FLUID_SAND_LEVELS.length} + ${PHYSICS_TUTORIAL_LEVELS.length} + ${BUILDING_LEVELS.length}`,
    );

    // ---- 每一关的文案必须齐全且是中文
    const missingText = TUTORIAL_CATALOG.filter(
      (level) =>
        !CHINESE.test(level.name) ||
        !CHINESE.test(level.goal) ||
        !CHINESE.test(level.successHint) ||
        level.name.trim() === '' ||
        level.goal.trim() === '' ||
        level.successHint.trim() === '',
    ).map((level) => level.id);
    check(
      '目录：每一关都有中文的 name / goal / successHint，没有空白项',
      missingText.length === 0,
      missingText.join('、') || '全部齐全',
    );
    check(
      '目录：每一关的 requires 至少一条，且每条都有中文说明（缺功能时不会显示空白）',
      TUTORIAL_CATALOG.every(
        (level) => level.requires.length > 0 && level.requires.every((id) => TUTORIAL_REQUIREMENT_LABELS[id] !== undefined),
      ),
      TUTORIAL_CATALOG.filter((level) => level.requires.length === 0).map((level) => level.id).join('、') || '全部 OK',
    );
    check(
      '目录：分类都在需求给的那 10 个里',
      TUTORIAL_CATALOG.every((level) => TUTORIAL_CATEGORY_ORDER.includes(level.category)),
    );

    // ---- 分类分组
    const grouped = tutorialsByCategory();
    let groupedTotal = 0;
    for (const levels of grouped.values()) groupedTotal += levels.length;
    check('目录：tutorialsByCategory 分组后总数不变（不多不少）', groupedTotal === TUTORIAL_CATALOG.length, `${groupedTotal} / ${TUTORIAL_CATALOG.length}`);
    check('目录：分组里没有空分类（不渲染空标题）', [...grouped.values()].every((levels) => levels.length > 0));
    const order = [...grouped.keys()];
    const expectedOrder = TUTORIAL_CATEGORY_ORDER.filter((category) => grouped.has(category));
    check(
      '目录：分类顺序与 TUTORIAL_CATEGORY_ORDER 一致（面板顺序稳定）',
      order.length === expectedOrder.length && order.every((category, index) => category === expectedOrder[index]),
      order.join(' / '),
    );
    const categoryCounts = TUTORIAL_CATALOG.reduce<Record<string, number>>((acc, level) => {
      acc[level.category] = (acc[level.category] ?? 0) + 1;
      return acc;
    }, {});
    check(
      '目录：每一关都被分进了某个分类，且每个分类的关数加起来等于总数',
      Object.values(categoryCounts).reduce((sum, n) => sum + n, 0) === TUTORIAL_CATALOG.length,
      Object.entries(categoryCounts).map(([name, n]) => `${name} ${n}`).join(' / '),
    );

    // ---- describeCatalog / getTutorial / tutorialNumber
    const summary = describeCatalog();
    check(
      '目录：describeCatalog 是一行中文，含"共 N 关，覆盖 K 个分类"',
      summary.includes(`共 ${TUTORIAL_CATALOG.length} 关，覆盖 ${grouped.size} 个分类`) && !summary.includes('\n'),
      summary,
    );
    check('目录：getTutorial 查不到时返回 undefined（不抛异常）', getTutorial('不存在的关卡') === undefined);
    check('目录：tutorialNumber 是 1 起的序号，查不到返回 0', tutorialNumber(TUTORIAL_CATALOG[0]!.id) === 1 && tutorialNumber('没有这个') === 0);

    // ---- 能力推导
    check(
      '能力：categoryForRequirements 是纯函数（同样输入永远同样输出）',
      categoryForRequirements(['sand', 'fluid']) === categoryForRequirements(['fluid', 'sand']),
    );
    check(
      '能力：专精能力优先（沙土 > 关节 > 物理）',
      categoryForRequirements(['sand']) === '沙土' &&
        categoryForRequirements(['joints', 'physics']) === '关节' &&
        categoryForRequirements(['physics', 'building']) === '物理',
    );
    check('能力：一个能力都没有时落到"基础"，不返回空字符串', categoryForRequirements([]) === '基础');
    check(
      '能力：missingRequirements 只报缺的那几条',
      missingRequirements(['fluid', 'sand'], ['fluid']).join(',') === 'sand',
    );
    check(
      '能力：describeRequirement 对已知 id 给中文名、对未知 id 原样回显（都不返回空白）',
      CHINESE.test(describeRequirement('fluid')) &&
        describeRequirement('没有登记过的能力').includes('没有登记过的能力') &&
        describeRequirement('没有登记过的能力').length > 0,
      `${describeRequirement('fluid')} / ${describeRequirement('没有登记过的能力')}`,
    );
    check(
      '能力：缺功能时给出"这一关需要 XX 功能"的中文提示，不缺时为空串',
      (() => {
        const level = TUTORIAL_CATALOG[0]!;
        const message = describeMissingRequirements(level, []);
        const ok = describeMissingRequirements(level, [...level.requires]) === '';
        return message.includes('这一关需要') && message.includes('功能') && ok;
      })(),
    );
  }

  // =========================================================== 2 完成度
  {
    check(
      '进度：localStorage 键名就是需求指定的 gad-box-tutorial-progress',
      TUTORIAL_PROGRESS_STORAGE_KEY === 'gad-box-tutorial-progress',
      TUTORIAL_PROGRESS_STORAGE_KEY,
    );

    const four = ['a', 'b', 'c', 'd'];
    const progress = new TutorialProgress({ storage: null, levelIds: four, now: () => 1000 });
    check(
      '进度：新建时完成度是 0（有可玩关卡时不是 null）',
      progress.completedCount === 0 && progress.completionRatio === 0,
      `ratio=${progress.completionRatio}`,
    );
    check('进度：markCompleted 返回 true 表示新记下一关', progress.markCompleted('a') === true);
    check(
      '进度：完成度按"已完成 / 可玩"算（1/4 = 0.25）',
      progress.completedCount === 1 && progress.completionRatio === 0.25,
      `ratio=${progress.completionRatio}`,
    );
    progress.markCompleted('b');
    progress.markCompleted('c');
    progress.markCompleted('d');
    check('进度：全部完成时 ratio 恰好 1', progress.completionRatio === 1 && progress.completedCount === 4);
    check(
      '进度：重复标记同一个 id 返回 false，且不会把计数刷成 5',
      progress.markCompleted('a') === false && progress.completedCount === 4,
    );
    check('进度：空 id / 纯空白 id 不记录（返回 false）', progress.markCompleted('') === false && progress.markCompleted('   ') === false);
    const timeFirst = progress.recordOf('a')?.atMs;
    progress.markCompleted('a', 9999);
    check(
      '进度：重复标记不覆盖首次通关时间（面板上的"什么时候通的"不会被刷成现在）',
      progress.recordOf('a')?.atMs === timeFirst,
      `atMs=${timeFirst}`,
    );

    // ---- 没有可玩关卡 → null（而不是 0 / NaN）
    const empty = new TutorialProgress({ storage: null, levelIds: [] });
    check(
      '进度：**没有可玩关卡时 completionRatio 是 null**（不是 0、也不是 NaN）',
      empty.completionRatio === null && !Number.isNaN(empty.completionRatio),
      `ratio=${String(empty.completionRatio)}`,
    );
    check('进度：没有可玩关卡时 totalCount 为 0、describe 说明"暂无关卡"', empty.totalCount === 0 && empty.describe().includes('暂无关卡'));
    check(
      '进度：无关卡时标记完成也不会让 ratio 从 null 变成数字（守卫不能只在构造函数里）',
      (() => {
        empty.markCompleted('随便一个');
        return empty.completionRatio === null;
      })(),
    );

    // ---- 可玩列表之外的 id 不计入完成度
    const scoped = new TutorialProgress({ storage: null, levelIds: ['x'] });
    scoped.markCompleted('不在列表里');
    check(
      '进度：不在可玩列表里的完成记录不计入完成度（不会出现 3/2 关这种数字）',
      scoped.completedCount === 0 && scoped.completionRatio === 0 && scoped.isCompleted('不在列表里'),
    );

    // ---- 导出 / 导入往返
    const exported = progress.exportJson();
    const restored = new TutorialProgress({ storage: null, levelIds: four });
    check('进度：导入合法 JSON 返回 true', restored.importJson(exported) === true);
    check(
      '进度：导出 → 导入往返后完成记录完全一致（逐个 id 与顺序都比）',
      restored.completedIds.join(',') === progress.completedIds.join(','),
      `${restored.completedIds.join(',')} / ${progress.completedIds.join(',')}`,
    );
    check('进度：往返后再次导出，字符串完全相等（恒等）', restored.exportJson() === exported);
    check('进度：导入的 atMs 被如实保留', restored.recordOf('a')?.atMs === progress.recordOf('a')?.atMs);

    // ---- 导入坏数据
    const survivor = new TutorialProgress({ storage: null, levelIds: four });
    survivor.markCompleted('a', 5);
    const badResult = survivor.importJson('{ 这不是 JSON');
    check(
      '进度：导入非法 JSON 返回 false，且**不动**已有进度（半截数据不该毁掉玩家的记录）',
      badResult === false && survivor.isCompleted('a'),
    );
    check('进度：导入失败时 lastError 有中文原因', typeof survivor.lastError === 'string' && survivor.lastError.length > 0, String(survivor.lastError));
    check('进度：导入"格式不认识"的 JSON 也返回 false 而不是抛异常', survivor.importJson('{"别的字段":1}') === false);

    // ---- 宽容读取
    const lenient = new TutorialProgress({ storage: null, levelIds: four });
    lenient.importJson('["a", {"id":"b","atMs":7}, null, {"id":""}, 42, {"id":"a","atMs":99}]');
    check(
      '进度：读档宽容（接受裸数组 / 缺 atMs / 垃圾项），去重后只留首次记录',
      lenient.isCompleted('a') && lenient.isCompleted('b') && lenient.completedIds.length === 2,
      lenient.completedIds.join(','),
    );
    check('进度：缺 atMs 的记录记 0（＝存档里没写时间，不拿"现在"冒充）', lenient.recordOf('b')?.atMs === 7 && lenient.recordOf('a')?.atMs === 0);
    check('进度：atMs 传非法值时取 now()（不会存进 NaN）', (() => {
      const p = new TutorialProgress({ storage: null, levelIds: ['z'], now: () => 4242 });
      p.markCompleted('z', Number.NaN);
      return p.recordOf('z')?.atMs === 4242;
    })());

    // ---- 持久化与降级
    const disk = memoryStorage();
    const saved = new TutorialProgress({ storage: disk.storage, levelIds: four });
    saved.markCompleted('a', 11);
    check('进度：写存档用的是需求指定的键 gad-box-tutorial-progress', disk.map.has(TUTORIAL_PROGRESS_STORAGE_KEY));
    check('进度：markCompleted 之后确实写了存储（不是只改内存）', disk.writes >= 1, `写入 ${disk.writes} 次`);
    const reread = new TutorialProgress({ storage: disk.storage, levelIds: four });
    check(
      '进度：换一个实例从同一份存储读回来，进度还在（真的持久化了）',
      reread.isCompleted('a') && reread.completedCount === 1,
    );
    saved.reset();
    check('进度：reset 会删掉存储里的键', !disk.map.has(TUTORIAL_PROGRESS_STORAGE_KEY) && saved.completedCount === 0);

    const brokenWrite = failingWriteStorage();
    const degraded = new TutorialProgress({ storage: brokenWrite.storage, levelIds: four });
    const degradedOk = (() => {
      try {
        return degraded.markCompleted('a', 1) === true && degraded.isCompleted('a');
      } catch {
        return false;
      }
    })();
    check(
      '进度：**存储写失败时降级**（内存里照常记住，不抛异常）',
      degradedOk && degraded.completedCount === 1,
    );
    check('进度：写失败时 lastError 有中文说明', (degraded.lastError ?? '').includes('保存'));
    check('进度：存储删不掉时 reset 也不抛异常', (() => {
      try {
        degraded.reset();
        return degraded.completedCount === 0;
      } catch {
        return false;
      }
    })());

    check('进度：**存储读失败时降级**（构造不抛、按"没有进度"处理）', (() => {
      try {
        const p = new TutorialProgress({ storage: failingReadStorage(), levelIds: four });
        return p.completedCount === 0 && (p.lastError ?? '').includes('读取');
      } catch {
        return false;
      }
    })());
    check('进度：存储里是垃圾 JSON 时构造不抛、按"没有进度"处理', (() => {
      try {
        const p = new TutorialProgress({ storage: memoryStorage({ [TUTORIAL_PROGRESS_STORAGE_KEY]: '{{{坏数据' }).storage, levelIds: four });
        return p.completedCount === 0 && p.lastError !== null;
      } catch {
        return false;
      }
    })());
    check('进度：Node 里不传 storage（没有 localStorage）也能构造', (() => {
      try {
        const p = new TutorialProgress();
        return p.totalCount === TUTORIAL_CATALOG.length && p.completedCount === 0;
      } catch {
        return false;
      }
    })());
    check('进度：默认 levelIds 取自教学目录（15 关）', new TutorialProgress({ storage: null }).totalCount === TUTORIAL_CATALOG.length);
    check('进度：describe 是一行中文，含"已完成数 / 总数"', (() => {
      const p = new TutorialProgress({ storage: null, levelIds: ['a', 'b'] });
      p.markCompleted('a', 1);
      const text = p.describe();
      return !text.includes('\n') && text.includes('1 / 2') && CHINESE.test(text);
    })());
  }

  // =========================================================== 3 新手引导
  {
    check(
      '引导：localStorage 键名就是需求指定的 gad-box-onboarding-done',
      ONBOARDING_STORAGE_KEY === 'gad-box-onboarding-done',
      ONBOARDING_STORAGE_KEY,
    );

    const allTrue: OnboardingState = {
      movedCamera: true,
      placedBuilding: true,
      editedTerrain: true,
      openedPanel: 'brush-panel',
      usedFluidTool: true,
      usedSandTool: true,
      savedOnce: true,
    };

    check(
      '引导：步数在 5 ~ 7 之间（需求范围）',
      ONBOARDING_STEPS.length >= 5 && ONBOARDING_STEPS.length <= 7,
      `实际 ${ONBOARDING_STEPS.length} 步`,
    );
    check('引导：步骤 id 互不重复', new Set(ONBOARDING_STEPS.map((step) => step.id)).size === ONBOARDING_STEPS.length);
    check(
      '引导：每一步都有中文标题与正文，且正文够具体（≥20 字）',
      ONBOARDING_STEPS.every(
        (step) => CHINESE.test(step.title) && CHINESE.test(step.body) && step.body.length >= 20,
      ),
      ONBOARDING_STEPS.filter((step) => step.body.length < 20).map((step) => step.id).join('、') || '全部 OK',
    );
    check(
      '引导：anchor 要么是 null，要么是 #id / [属性] 形式的选择器',
      ONBOARDING_STEPS.every(
        (step) => step.anchor === null || step.anchor.startsWith('#') || step.anchor.startsWith('['),
      ),
      ONBOARDING_STEPS.filter((step) => step.anchor !== null).map((step) => String(step.anchor)).join('、'),
    );
    check(
      '引导：每个 #id 形式的 anchor 都指向 index.html 里真实存在的元素（高亮不会指到空气）',
      (() => {
        const ids = readIndexHtmlIds();
        if (!ids) return true; // 读不到 index.html（例如换了个工作目录）时不误报
        const bad = ONBOARDING_STEPS.map((step) => step.anchor)
          .filter((anchor): anchor is string => anchor !== null && anchor.startsWith('#'))
          .filter((anchor) => !ids.has(anchor.slice(1)));
        return bad.length === 0;
      })(),
      (() => {
        const ids = readIndexHtmlIds();
        if (!ids) return '（没读到 index.html，跳过）';
        return (
          ONBOARDING_STEPS.map((step) => step.anchor)
            .filter((anchor): anchor is string => anchor !== null && anchor.startsWith('#'))
            .filter((anchor) => !ids.has(anchor.slice(1)))
            .join('、') || '全部命中'
        );
      })(),
    );
    check(
      '引导：保存那一步的 anchor 指向工具栏里真实的"保存"按钮（[data-action="save"]）',
      (() => {
        const step = ONBOARDING_STEPS.find((item) => item.id === 'save');
        if (!step || step.anchor !== '[data-action="save"]') return false;
        try {
          const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
          return html.includes('data-action="save"');
        } catch {
          return true; // 读不到 index.html 时不误报
        }
      })(),
    );

    // ---- 每一步的 isDone 只认一个状态字段（逐项打开验证）
    // 顺序**刻意与 ONBOARDING_STEPS 一致**（视角 → 地形 → 建筑 → 面板 → 流体 → 沙土 → 存档）：
    // 下面按"第 i 个字段 ↔ 第 i 步"逐项验证，顺序对不上就会立刻红。
    const FIELD_KEYS: readonly { key: string; value: unknown }[] = [
      { key: 'movedCamera', value: true },
      { key: 'editedTerrain', value: true },
      { key: 'placedBuilding', value: true },
      { key: 'openedPanel', value: 'brush-panel' },
      { key: 'usedFluidTool', value: true },
      { key: 'usedSandTool', value: true },
      { key: 'savedOnce', value: true },
    ];
    check(
      '引导：状态字段个数与步骤数一一对应（不多不少）',
      FIELD_KEYS.length === ONBOARDING_STEPS.length,
      `字段 ${FIELD_KEYS.length} / 步骤 ${ONBOARDING_STEPS.length}`,
    );
    const stateWithOnly = (key: string, value: unknown): OnboardingState => {
      const state = emptyOnboardingState();
      (state as unknown as Record<string, unknown>)[key] = value;
      return state;
    };
    for (let i = 0; i < ONBOARDING_STEPS.length; i += 1) {
      const field = FIELD_KEYS[i]!;
      const state = stateWithOnly(field.key, field.value);
      const hitTrue = ONBOARDING_STEPS.filter((step) => step.isDone(state)).map((step) => step.id);
      check(
        `引导：只打开「${field.key}」时，只有第 ${i + 1} 步「${ONBOARDING_STEPS[i]!.title}」算达成`,
        hitTrue.length === 1 && hitTrue[0] === ONBOARDING_STEPS[i]!.id,
        hitTrue.join('、') || '（没有任何一步达成 —— 判定漏了）',
      );
    }
    check(
      '引导：什么都没做时，没有任何一步算达成（不会一进来就跳过全部）',
      ONBOARDING_STEPS.every((step) => !step.isDone(emptyOnboardingState())),
    );
    check(
      '引导：7 个字段与 7 个步骤是**一一对应**（每个字段认领的步骤互不相同，没有两个字段认领同一步）',
      (() => {
        const claimed = FIELD_KEYS.map((field) => {
          const state = stateWithOnly(field.key, field.value);
          return ONBOARDING_STEPS.filter((step) => step.isDone(state)).map((step) => step.id).join(',');
        });
        return claimed.every((id) => id !== '') && new Set(claimed).size === claimed.length;
      })(),
      FIELD_KEYS.map((field) => {
        const state = stateWithOnly(field.key, field.value);
        return `${field.key}→${ONBOARDING_STEPS.filter((step) => step.isDone(state)).map((step) => step.id).join('+') || '×'}`;
      }).join(' '),
    );

    // ---- 状态机
    const fresh = new Onboarding({ storage: null });
    check('引导：从没完成过时 needsOnboarding 为 true', fresh.needsOnboarding === true);
    check('引导：还没开始时 active 为 false，且 update 不推进', (() => {
      const before = fresh.update(allTrue, 16);
      return fresh.active === false && fresh.index === 0 && before.justCompleted === false;
    })());
    fresh.start();
    check('引导：start 之后 active 为 true、从第 1 步开始', fresh.active === true && fresh.index === 0);
    check('引导：update 返回的 step 就是 ONBOARDING_STEPS 里的同一步（按引用相等）', fresh.update(emptyOnboardingState(), 16).step === ONBOARDING_STEPS[0]);

    // 逐帧喂"全满足"，收集 justCompleted 的次数
    let completions = 0;
    let frames = 0;
    while (fresh.active && frames < 100) {
      const result = fresh.update(allTrue, 16);
      if (result.justCompleted) completions += 1;
      frames += 1;
    }
    check(
      '引导：状态全满足时逐帧走完全部步骤，**justCompleted 恰好为 true 一次**',
      completions === 1 && frames === ONBOARDING_STEPS.length,
      `共 ${frames} 帧、justCompleted ${completions} 次`,
    );
    check('引导：走完之后 active 为 false', fresh.active === false);
    check('引导：完成后 needsOnboarding 变成 false', fresh.needsOnboarding === false);
    check(
      '引导：完成之后再调 update 不会第二次报 justCompleted、也不改步号',
      (() => {
        const index = fresh.index;
        const result = fresh.update(allTrue, 16);
        return result.justCompleted === false && fresh.index === index;
      })(),
    );

    // ---- 跳过
    const skipper = new Onboarding({ storage: null });
    skipper.start();
    skipper.update(emptyOnboardingState(), 16);
    skipper.update(emptyOnboardingState(), 16);
    const indexBeforeSkip = skipper.index;
    skipper.skip();
    const afterSkip = skipper.update(allTrue, 16);
    check(
      '引导：跳过后再调 update **不再推进**（也不会报 justCompleted）',
      skipper.active === false && skipper.index === indexBeforeSkip && afterSkip.justCompleted === false,
      `步号 ${indexBeforeSkip} → ${skipper.index}`,
    );
    check('引导：跳过也算"看过"，needsOnboarding 为 false（不会每次开屏都弹）', skipper.needsOnboarding === false);

    // ---- 重看
    const reviewer = new Onboarding({ storage: null });
    reviewer.start();
    reviewer.skip();
    reviewer.restart();
    check(
      '引导：restart 之后从头开始、active 为 true，但不清掉"看过"的标记',
      reviewer.active === true && reviewer.index === 0 && reviewer.needsOnboarding === false,
    );
    check('引导：next() 手动推进一步', (() => {
      const before = reviewer.index;
      reviewer.next();
      return reviewer.index === before + 1;
    })());
    check('引导：最后一步调 next() 等于走完（active 变 false、不再报完成事件）', (() => {
      const last = new Onboarding({ storage: null });
      last.start();
      for (let i = 0; i < ONBOARDING_STEPS.length - 1; i += 1) last.next();
      last.next();
      return last.active === false && last.update(allTrue, 16).justCompleted === false;
    })());

    // ---- 计时与 dispose
    check('引导：dtMs 为负数时计时不会变成负数（系统时间跳变也没事）', (() => {
      const p = new Onboarding({ storage: null });
      p.start();
      p.update(emptyOnboardingState(), -1000);
      return p.stepElapsedMs === 0;
    })());
    check('引导：dispose 之后 update 不再推进、active 为 false', (() => {
      const p = new Onboarding({ storage: null });
      p.start();
      p.dispose();
      const result = p.update(allTrue, 16);
      return p.active === false && p.index === 0 && result.justCompleted === false;
    })());
    check('引导：describe 是一行中文', (() => {
      const p = new Onboarding({ storage: null });
      const before = p.describe();
      p.start();
      const during = p.describe();
      return CHINESE.test(before) && CHINESE.test(during) && !during.includes('\n') && during.includes('1 /');
    })());

    // ---- 持久化
    const disk = memoryStorage();
    const saver = new Onboarding({ storage: disk.storage, now: () => 777 });
    saver.start();
    while (saver.active) saver.update(allTrue, 16);
    check('引导：完成时写的是需求指定的键 gad-box-onboarding-done', disk.map.has(ONBOARDING_STORAGE_KEY));
    check('引导：存档里带完成时间与步数（可统计"走到第几步放弃"）', (() => {
      const raw = disk.map.get(ONBOARDING_STORAGE_KEY) ?? '';
      const parsed = JSON.parse(raw) as { done?: boolean; steps?: number; atMs?: number; skipped?: boolean };
      return parsed.done === true && parsed.atMs === 777 && parsed.steps === ONBOARDING_STEPS.length - 1;
    })());
    check(
      '引导：换一个实例读同一份存储，needsOnboarding 为 false（真的持久化了）',
      new Onboarding({ storage: disk.storage }).needsOnboarding === false,
    );
    const skipDisk = memoryStorage();
    const skipSaver = new Onboarding({ storage: skipDisk.storage, now: () => 5 });
    skipSaver.start();
    skipSaver.skip();
    check('引导：跳过也写存档，并记下 skipped=true', (() => {
      const raw = skipDisk.map.get(ONBOARDING_STORAGE_KEY) ?? '';
      return (JSON.parse(raw) as { skipped?: boolean }).skipped === true;
    })());
    check('引导：**存储写失败时降级**（不抛异常，本次启动内照样算"看过"）', (() => {
      try {
        const p = new Onboarding({ storage: failingWriteStorage().storage });
        p.start();
        while (p.active) p.update(allTrue, 16);
        return p.needsOnboarding === false && (p.lastError ?? '').includes('记录');
      } catch {
        return false;
      }
    })());
    check('引导：存储读失败时降级（当作没看过，宁可再教一次）', (() => {
      try {
        const p = new Onboarding({ storage: failingReadStorage() });
        return p.needsOnboarding === true && (p.lastError ?? '').includes('读取');
      } catch {
        return false;
      }
    })());
    check('引导：存储里是垃圾 JSON 时构造不抛、当作没看过', (() => {
      try {
        const p = new Onboarding({ storage: memoryStorage({ [ONBOARDING_STORAGE_KEY]: 'not json' }).storage });
        return p.needsOnboarding === true;
      } catch {
        return false;
      }
    })());
    check('引导：Node 里不传 storage 也能构造（无 localStorage）', (() => {
      try {
        return new Onboarding().needsOnboarding === true;
      } catch {
        return false;
      }
    })());
  }

  // =========================================================== 4 示例场景
  {
    check('示例：至少 11 个（需求下限）', EXAMPLE_SCENES.length >= 11, `实际 ${EXAMPLE_SCENES.length} 个`);
    check('示例：id 互不重复', new Set(EXAMPLE_SCENES.map((scene) => scene.id)).size === EXAMPLE_SCENES.length);
    check(
      '示例：每个都有中文 name / emoji / description / focus，没有空字段',
      EXAMPLE_SCENES.every(
        (scene) =>
          CHINESE.test(scene.name) &&
          CHINESE.test(scene.description) &&
          CHINESE.test(scene.focus) &&
          scene.emoji.trim() !== '' &&
          scene.blindSpots.length > 0,
      ),
      EXAMPLE_SCENES.filter((scene) => scene.blindSpots.length === 0).map((scene) => scene.id).join('、') || '全部 OK',
    );

    // ---- 逐场景校验（defId / 越界 / 上限 / 盒子装得下）
    const problems: string[] = [];
    for (const scene of EXAMPLE_SCENES) {
      for (const problem of validateExample(scene)) problems.push(`${scene.id}：${problem}`);
    }
    check(
      '示例：12 个内置场景逐个校验零问题（defId 真实存在、坐标不越界、用量不超上限）',
      problems.length === 0,
      problems.slice(0, 4).join('；') || '全部通过',
    );

    // ---- 上限（把需求点名的三组数字单独再断言一次）
    const overFluid = EXAMPLE_SCENES.filter((scene) => {
      const fluid = scene.plan.fluid;
      if (!fluid) return false;
      return fluidCountFor(scene, false) > fluidCapacity(fluid.preset, false, false);
    }).map((scene) => scene.id);
    check('示例：桌面粒子数都不超过 fluidCapacity（最高 20000）', overFluid.length === 0, overFluid.join('、') || '全部在上限内');
    const overMobileFluid = EXAMPLE_SCENES.filter((scene) => {
      const fluid = scene.plan.fluid;
      return fluid ? fluidCountFor(scene, true) > MOBILE_PARTICLE_BUDGET : false;
    }).map((scene) => scene.id);
    check('示例：移动端（降级后）粒子数都不超过 3000', overMobileFluid.length === 0, overMobileFluid.join('、') || '全部在上限内');
    const overSand = EXAMPLE_SCENES.filter((scene) => sandCellCount(scene) > sandCellCapacity()).map((scene) => scene.id);
    check(
      `示例：沙格数都不超过 SAND_CONFIG.maxActivePerStep（${sandCellCapacity()}）`,
      overSand.length === 0,
      overSand.join('、') || '全部在上限内',
    );
    const overDynamic = EXAMPLE_SCENES.filter((scene) => objectCounts(scene).dynamicCount > 300).map((scene) => scene.id);
    check('示例：动态刚体都不超过手机上限 300（手机没法"少放几个"而不破坏场景）', overDynamic.length === 0, overDynamic.join('、') || '全部在上限内');
    const overStatic = EXAMPLE_SCENES.filter((scene) => objectCounts(scene).staticCount > 800).map((scene) => scene.id);
    check('示例：静态刚体都不超过手机上限 800', overStatic.length === 0, overStatic.join('、') || '全部在上限内');

    // ---- 降级说明：超上限的场景必须写清"移动端会降级到 X"
    const degraded = EXAMPLE_SCENES.filter((scene) => {
      const fluid = scene.plan.fluid;
      return fluid ? fluidCountFor(scene, true) < fluidCountFor(scene, false) : false;
    });
    check(
      '示例：真的有场景会降级（否则"降级说明"这条规则就没人验证）',
      degraded.length > 0,
      degraded.map((scene) => scene.id).join('、'),
    );
    check(
      '示例：每个会降级的场景，describeExample 都写明了"移动端会降级到 X"',
      degraded.every((scene) => {
        const text = describeExample(scene);
        return text.includes('移动端会降级到') && text.includes(String(fluidCountFor(scene, true)));
      }),
      degraded.map((scene) => describeExample(scene)).join(' ｜ '),
    );
    check(
      '示例：不会降级的场景不写"移动端"三个字（说了就是撒谎）',
      EXAMPLE_SCENES.filter((scene) => {
        const fluid = scene.plan.fluid;
        const isDegraded = fluid ? fluidCountFor(scene, true) < fluidCountFor(scene, false) : false;
        return !isDegraded && describeExample(scene).includes('移动端');
      }).length === 0,
    );
    check(
      '示例：describeExample 是一行中文，含世界档位与物体数',
      EXAMPLE_SCENES.every((scene) => {
        const text = describeExample(scene);
        return CHINESE.test(text) && !text.includes('\n') && text.includes('物体') && text.includes(scene.name);
      }),
    );
    check('示例：getExample 查不到时返回 undefined（不抛异常）', getExample('没有这个场景') === undefined);
    check(
      '示例：每个场景都写了生成顺序（steps 非空且是中文）',
      EXAMPLE_SCENES.every((scene) => scene.plan.steps.length > 0 && CHINESE.test(scene.plan.steps.join(''))),
    );
    check(
      '示例：每个场景的 requires 都非空、每条能力都有中文说明（缺功能时不会显示空白）',
      EXAMPLE_SCENES.every(
        (scene) => scene.requires.length > 0 && scene.requires.every((id) => id in TUTORIAL_REQUIREMENT_LABELS),
      ),
      EXAMPLE_SCENES.filter((scene) => scene.requires.some((id) => !(id in TUTORIAL_REQUIREMENT_LABELS)))
        .map((scene) => scene.id)
        .join('、') || '全部 OK',
    );
    check(
      '示例：缺能力时能给出一句中文提示（用教学目录那套能力文案，不另写一份）',
      (() => {
        const scene = EXAMPLE_SCENES[0]!;
        const message = describeMissingRequirements(scene, []);
        return message.includes('这一关需要') && message.includes('功能');
      })(),
    );

    // ---- 沙的排布（Engine 直接遍历它落格，所以枚举本身必须自洽）
    const mound = EXAMPLE_SCENES.find((scene) => scene.plan.sand?.shape === 'mound')?.plan.sand;
    check('示例：圆丘排布里没有两根柱子落在同一个位置（角不会重复放柱）', (() => {
      if (!mound) return false;
      const keys = buildSandColumns(mound).map((column) => `${column.x},${column.z}`);
      return new Set(keys).size === keys.length;
    })());
    check('示例：圆丘是"中间最高、往外每圈矮 2 格"（有坡面才谈得上安息角）', (() => {
      if (!mound || mound.shape !== 'mound') return false;
      const columns = buildSandColumns(mound);
      const center = columns.filter((column) => column.x === mound.origin[0] && column.z === mound.origin[2]);
      const tops = columns.map((column) => column.height);
      return center.length === 1 && center[0]!.height === mound.height && Math.max(...tops) === mound.height;
    })());
    check('示例：沙格数是逐柱累加（圆丘各圈高度不同，不能用 柱数 × 高度 糊弄）', (() => {
      const scene = EXAMPLE_SCENES.find((item) => item.plan.sand?.shape === 'mound');
      if (!scene || !scene.plan.sand || scene.plan.sand.shape !== 'mound') return false;
      const sum = buildSandColumns(scene.plan.sand).reduce((total, column) => total + column.height, 0);
      return sum === sandCellCount(scene) && sum !== buildSandColumns(scene.plan.sand).length * scene.plan.sand.height;
    })());
    check('示例：没有沙的场景 sandCellCount 与降级后的格数都是 0', (() => {
      const scene = EXAMPLE_SCENES.find((item) => item.plan.sand === null);
      return scene ? sandCellCount(scene) === 0 && sandCellCountFor(scene, true) === 0 : false;
    })());
    check('示例：describeSandShape 对两种排布都给出中文说明', (() => {
      const grid = EXAMPLE_SCENES.map((scene) => scene.plan.sand).find((sand) => sand?.shape === 'grid');
      const texts = [mound, grid].filter((sand) => sand !== undefined).map((sand) => describeSandShape(sand!));
      return texts.length > 0 && texts.every((text) => CHINESE.test(text));
    })());
    check('示例：网格排布的柱数就是 columns（与压力测试那套排布一致）', (() => {
      const grid = EXAMPLE_SCENES.map((scene) => scene.plan.sand).find((sand) => sand?.shape === 'grid');
      if (!grid || grid.shape !== 'grid') return true; // 当前 12 个示例都用圆丘：没有网格场景时这条不失败
      return buildSandColumns(grid).length === grid.columns;
    })());

    // ---- 关节
    const totalJoints = EXAMPLE_SCENES.reduce((sum, scene) => sum + scene.plan.joints.length, 0);
    check('示例：至少有一个场景带关节（示例要能演示关节，不能全是静态摆件）', totalJoints >= 8, `共 ${totalJoints} 个关节`);
    check(
      '示例：每个关节的两端要么是合法下标、要么是空串（连世界）',
      EXAMPLE_SCENES.every((scene) =>
        scene.plan.joints.every((joint) =>
          [joint.bodyA, joint.bodyB].every((ref) => {
            if (ref === '') return true;
            const index = Number(ref);
            return Number.isInteger(index) && index >= 0 && index < scene.plan.objects.length;
          }),
        ),
      ),
    );
    check(
      '示例：世界档位都是合法档位（不会用一个不存在的 sizeId）',
      EXAMPLE_SCENES.every((scene) => ['novice', 'standard', 'large'].includes(scene.size)),
    );
    check(
      '示例：地面高度取自该档位的地形基准高度 baseHeight（不是拍出来的数）',
      EXAMPLE_SCENES.every((scene) => scene.plan.ground.y === defaultFloorY(scene.size)),
      EXAMPLE_SCENES.filter((scene) => scene.plan.ground.y !== defaultFloorY(scene.size))
        .map((scene) => `${scene.id}: ${scene.plan.ground.y} ≠ ${defaultFloorY(scene.size)}`)
        .join('、') || `新手 ${defaultFloorY('novice')} / 标准 ${defaultFloorY('standard')} / 大型 ${defaultFloorY('large')}`,
    );
  }

  // =========================================================== 5 帮助中心
  {
    check('帮助：至少 25 条（需求下限）', HELP_TOPICS.length >= 25, `实际 ${HELP_TOPICS.length} 条`);
    check('帮助：id 互不重复', new Set(HELP_TOPICS.map((topic) => topic.id)).size === HELP_TOPICS.length);
    check(
      '帮助：每条都在 HELP_CATEGORIES 的 7 个分类里',
      HELP_TOPICS.every((topic) => HELP_CATEGORIES.includes(topic.category)),
      [...new Set(HELP_TOPICS.map((topic) => topic.category))].join('、'),
    );
    check(
      '帮助：每个分类都有条目（面板上不会出现空分类）',
      HELP_CATEGORIES.every((category) => HELP_TOPICS.some((topic) => topic.category === category)),
      HELP_CATEGORIES.filter((category) => !HELP_TOPICS.some((topic) => topic.category === category)).join('、') || '全部有内容',
    );
    check(
      '帮助：问题与答案都是中文，且答案够具体（≥30 字）',
      HELP_TOPICS.every(
        (topic) => CHINESE.test(topic.question) && CHINESE.test(topic.answer) && topic.answer.length >= 30,
      ),
      HELP_TOPICS.filter((topic) => topic.answer.length < 30).map((topic) => topic.id).join('、') || '全部够具体',
    );

    // ---- 搜索
    check('帮助：空查询返回全部条目', searchHelpTopics('').length === HELP_TOPICS.length);
    check('帮助：只有空白（含全角空格）的查询也返回全部', searchHelpTopics('  \u3000 ').length === HELP_TOPICS.length);
    check('帮助：搜「水」能命中（中文包含匹配）', searchHelpTopics('水').length > 0, `命中 ${searchHelpTopics('水').length} 条`);
    check(
      '帮助：搜「冻结」第一条就是"怎么把水冻住当墙"那条',
      searchHelpTopics('冻结')[0]?.id === 'fluid-freeze',
      searchHelpTopics('冻结')[0]?.question ?? '（一条都没命中）',
    );
    check(
      '帮助：搜「重力」能命中改重力那条',
      searchHelpTopics('重力').some((topic) => topic.id === 'physics-gravity'),
    );
    check(
      '帮助：多词是 AND 语义（搜「水 冻结」的结果里两个词都得出现）',
      (() => {
        const hits = searchHelpTopics('水 冻结');
        return hits.length > 0 && hits.length <= searchHelpTopics('水').length &&
          hits.every((topic) => `${topic.question}${topic.answer}`.includes('水') && `${topic.question}${topic.answer}`.includes('冻结'));
      })(),
    );
    check('帮助：没有结果时返回空数组、不抛异常', (() => {
      try {
        const hits = searchHelpTopics('zzz绝对不存在的关键词zzz');
        return Array.isArray(hits) && hits.length === 0;
      } catch {
        return false;
      }
    })());
    check('帮助：搜索不区分大小写（JSON 与 json 结果一致）', searchHelpTopics('JSON').length === searchHelpTopics('json').length);
    check(
      '帮助：命中位置更靠前的排在前面（问题里命中优先于答案里命中）',
      searchHelpTopics('重力')[0]?.question.includes('重力') === true,
    );
    check(
      '帮助：大部分条目的 related 非空（"点了能跳到对应面板"这条路真的接得上）',
      HELP_TOPICS.filter((topic) => (topic.related?.length ?? 0) > 0).length >= HELP_TOPICS.length / 2,
      `${HELP_TOPICS.filter((topic) => (topic.related?.length ?? 0) > 0).length} / ${HELP_TOPICS.length} 条有关联项`,
    );
    check(
      '帮助：related 里的每一项都是非空字符串（不会渲染出空标签）',
      HELP_TOPICS.every((topic) => (topic.related ?? []).every((item) => typeof item === 'string' && item.trim() !== '')),
    );

    // ---- 面板（Node 无 DOM）
    check('帮助：无容器（Node）下构造不抛异常', (() => {
      try {
        const panel = new HelpCenter(null);
        panel.dispose();
        return true;
      } catch {
        return false;
      }
    })());
    check('帮助：无容器时 search / setCategory / render 都能用（只是画不出来）', (() => {
      try {
        const panel = new HelpCenter(null);
        const hits = panel.search('水');
        panel.setCategory('流体');
        panel.render();
        const ok = hits.length > 0 && panel.currentCategory === '流体' && panel.currentQuery === '水';
        panel.dispose();
        return ok;
      } catch {
        return false;
      }
    })());
    check('帮助：无容器时 dispose 之后再用也不抛异常', (() => {
      try {
        const panel = new HelpCenter(null);
        panel.dispose();
        panel.render();
        panel.search('重力');
        return true;
      } catch {
        return false;
      }
    })());
    check(
      '帮助：分类过滤生效（setCategory("流体") 之后只剩流体类）',
      (() => {
        const panel = new HelpCenter(null);
        panel.setCategory('流体');
        const hits = panel.search('');
        return hits.length > 0 && hits.every((topic) => topic.category === '流体');
      })(),
    );

    // ---- 假 DOM 下的渲染（验证"真的画得出来"）
    const doc = new FakeDocument();
    const container = doc.createElement('div');
    let opened: string | null = null;
    const panel = new HelpCenter(
      container as unknown as HTMLElement,
      { onOpenExample: (id) => { opened = id; } },
    );
    check(
      '帮助：假 DOM 下渲染出"搜索框 + 列表"，且列表里每个条目一个可折叠节点',
      (() => {
        const search = container.find((el) => el.tagName === 'input');
        const details = container.find((el) => el.tagName === 'details');
        return search.length === 1 && details.length === HELP_TOPICS.length;
      })(),
      `details ${container.find((el) => el.tagName === 'details').length} 个 / 条目 ${HELP_TOPICS.length} 条`,
    );
    check('帮助：点「打开示例」会回调真实存在的示例 id', (() => {
      const buttons = container.find((el) => el.tagName === 'button' && el.textContent.includes('打开示例'));
      if (buttons.length === 0) return false;
      buttons[0]!.fire('click');
      return opened !== null && getExample(opened) !== undefined;
    })(), `回调收到 ${String(opened)}`);
    check(
      '帮助：每个分类配的示例 id 都真实存在',
      HELP_CATEGORIES.every((category) => {
        const id = HELP_EXAMPLE_BY_CATEGORY[category];
        return typeof id === 'string' && getExample(id) !== undefined;
      }),
      HELP_CATEGORIES.filter((category) => getExample(HELP_EXAMPLE_BY_CATEGORY[category] ?? '') === undefined).join('、') || '全部存在',
    );
    check('帮助：搜索之后列表重画成命中条数（不是只改状态）', (() => {
      panel.search('存档');
      const details = container.find((el) => el.tagName === 'details');
      return details.length === searchHelpTopics('存档').length && details.length > 0;
    })());
    check('帮助：dispose 之后容器被清空、再调 render 不抛异常', (() => {
      try {
        panel.dispose();
        panel.render();
        return container.children.length === 0;
      } catch {
        return false;
      }
    })());
  }
}
