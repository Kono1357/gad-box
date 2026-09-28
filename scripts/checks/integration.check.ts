/**
 * M5 引擎集成断言（第 5 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 这份断言在防什么（和前面几份不一样的地方）
 * ────────────────────────────────────────────────────────────
 * M5 的 11 个模块各自都有断言（errors / ui / onboarding 三份），而且都是绿的 ——
 * 但它们在**集成之前**全绿也是可能的：模块写得再好，没有任何生产代码 import 它就等于没做。
 * 本轮的交付要求正是"接进引擎与页面"，所以这一份断言盯的是**接线本身**：
 *
 * 1. 页面上真的有那些节点（面板、气泡、容器）—— 少一个节点就少一个入口，模块再好玩家也看不到；
 * 2. 引擎源码里真的调了那些方法（install / uninstall / enter / capture / apply 等）——
 *    用源码文本断言，因为 Node 里起不了 Engine（要 WebGL + Rapier + Three）；
 * 3. **两侧对得上**：安全模式清单里的每一项都必须在 `applySafeModeRestrictions()` 的 switch 里
 *    有对应处理；教学目录里的每一关都必须能在三个运行器里找到。这两条是"清单式"集成最容易漏的地方
 *    （加了数据忘了接线），而且漏了在界面上看不出来（只是"某一项没生效"）。
 *
 * ────────────────────────────────────────────────────────────
 * 如实说明这份断言测不到的东西
 * ────────────────────────────────────────────────────────────
 * - **不在浏览器里跑**：没有 jsdom，所以"节点真的画出来了吗""点击真的连通了吗"测不到。
 *   源码断言只能证明"代码里调了"，不能证明"运行时没抛异常"—— 后者要靠人工打开页面验证；
 * - 源码断言用的是**文本包含**：把 `this.errorHandler.install(` 改写成两行的写法会让它失败，
 *   但那种改写确实值得被人看一眼，所以这里选择"宁可误报一次"；
 * - 数字口径：`EXAMPLE_SCENES.length` / `TUTORIAL_CATALOG.length` 都是从真数据读的，
 *   不是抄来的常量 —— 加一个示例/关卡不会让这里失败，反而是"漏接线"才会失败。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ONBOARDING_STEPS,
  ONBOARDING_STORAGE_KEY,
  Onboarding,
  type OnboardingStorage,
} from '../../src/tutorial/Onboarding';
import { EXAMPLE_SCENES, fluidCountFor, sandCellCountFor, validateExample } from '../../src/tutorial/Examples';
import { allHelpTopics, searchHelpTopics, HELP_CATEGORIES, HELP_EXAMPLE_BY_CATEGORY } from '../../src/ui/HelpCenter';
import { TUTORIAL_CATALOG, tutorialsByCategory, getTutorial } from '../../src/tutorial/TutorialCatalog';
import { TutorialProgress, TUTORIAL_PROGRESS_STORAGE_KEY, type ProgressStorage } from '../../src/tutorial/TutorialProgress';
import { SAFE_MODE_RESTRICTIONS } from '../../src/core/SafeMode';
import { DEFAULT_SHORTCUTS } from '../../src/ui/ShortcutPanel';
import { fluidCapacity, rigidCapacity, sandCellCapacity } from '../../src/perf/StressTestScenes';
import { TUTORIAL_LEVELS as BUILDING_LEVELS } from '../../src/tutorial/TutorialLevel';
import { PHYSICS_TUTORIAL_LEVELS } from '../../src/tutorial/PhysicsTutorial';
import { TUTORIAL_LEVELS as FLUID_LEVELS } from '../../src/tutorial/FluidSandTutorial';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 读一个仓库根目录下的文件；读不到返回 null（换工作目录时不该误报） */
function readProjectFile(relative: string): string | null {
  try {
    return readFileSync(resolve(process.cwd(), relative), 'utf8');
  } catch {
    return null;
  }
}

/** 内存版存储（断言用；与浏览器 localStorage 的这三个方法一致） */
function makeFakeStorage(): OnboardingStorage & ProgressStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
  };
}

/** 中文文案的最低要求：至少有一个汉字（挡住"忘了写中文"的英文串） */
function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

export function runIntegrationChecks(check: CheckFn): void {
  // =========================================================================
  // 1. 新手引导（第 3 批）——步数 / 跳过 / 持久化
  // =========================================================================
  {
    check(
      '集成·引导：步骤数落在 5~7 之间（需求给的范围，不是随手写的数）',
      ONBOARDING_STEPS.length >= 5 && ONBOARDING_STEPS.length <= 7,
      `共 ${ONBOARDING_STEPS.length} 步`,
    );

    const storage = makeFakeStorage();
    const onboarding = new Onboarding({ storage, now: () => 1_700_000_000_000 });
    check('集成·引导：没看过时 needsOnboarding 为 true（首屏会弹）', onboarding.needsOnboarding === true);

    onboarding.start();
    check('集成·引导：start() 之后 active 为 true（气泡该显示）', onboarding.active === true);

    // 跳过之后：不再推进、且不再需要引导
    const indexBeforeSkip = onboarding.index;
    onboarding.skip();
    const stepAfterSkip = onboarding.step.id;
    const updated = onboarding.update(
      {
        movedCamera: true,
        placedBuilding: true,
        editedTerrain: true,
        openedPanel: 'brush-panel',
        usedFluidTool: true,
        usedSandTool: true,
        savedOnce: true,
      },
      1000,
    );
    check(
      '集成·引导：跳过之后 active 为 false，且 update() 不再推进一步（状态全满足也不动）',
      onboarding.active === false && onboarding.index === indexBeforeSkip && updated.justCompleted === false,
      `跳过后停在「${stepAfterSkip}」`,
    );
    check(
      '集成·引导：跳过也算"看过"（needsOnboarding 变 false，下次进来不再弹）',
      onboarding.needsOnboarding === false,
    );

    // 跳过会写存档：新实例（同一个存储）应当"已看过"
    const reopened = new Onboarding({ storage });
    check(
      '集成·引导：跳过状态真的落到存储里（gad-box-onboarding-done）',
      reopened.needsOnboarding === false && storage.getItem(ONBOARDING_STORAGE_KEY) !== null,
      `键 ${ONBOARDING_STORAGE_KEY}`,
    );

    // 走完（而不是跳过）也要写存档，并且 restart() 不清存档（否则会变成每次启动都弹）
    const walked = makeFakeStorage();
    const walkthrough = new Onboarding({ storage: walked, steps: ONBOARDING_STEPS.slice(0, 2) });
    walkthrough.start();
    const full = {
      movedCamera: true,
      placedBuilding: true,
      editedTerrain: true,
      openedPanel: 'brush-panel',
      usedFluidTool: true,
      usedSandTool: true,
      savedOnce: true,
    };
    let completedTimes = 0;
    for (let i = 0; i < 5; i += 1) {
      if (walkthrough.update(full, 16).justCompleted) completedTimes += 1;
    }
    check(
      '集成·引导：状态一次全满足时逐帧走完，justCompleted 只报一次',
      completedTimes === 1 && walkthrough.active === false,
      `justCompleted 触发 ${completedTimes} 次`,
    );
    const restartSource = readProjectFile('src/tutorial/Onboarding.ts');
    check(
      '集成·引导：restart() 不删存储（重看一次不该变成"每次启动都弹"）',
      restartSource !== null && /restart\(\): void \{[\s\S]{0,400}?this\.start\(\);/.test(restartSource),
      restartSource === null ? '（没读到源码，跳过）' : 'Onboarding.restart 直接调 start()',
    );
  }

  // =========================================================================
  // 2. 教学进度（第 4 批）——持久化往返
  // =========================================================================
  {
    const storage = makeFakeStorage();
    const levelIds = TUTORIAL_CATALOG.map((level) => level.id).slice(0, 3);
    const progress = new TutorialProgress({ storage, levelIds, now: () => 1234 });
    check(
      '集成·进度：初始为 0 完成（比例 0，不是 null —— 有关卡时必须有比例）',
      progress.completedCount === 0 && progress.completionRatio === 0,
      progress.describe(),
    );

    const first = levelIds[0]!;
    check('集成·进度：markCompleted 第一次返回 true（新记下一关）', progress.markCompleted(first) === true);
    check('集成·进度：重复标记同一关返回 false（不会覆盖首次时间）', progress.markCompleted(first) === false);

    const json = progress.exportJson();
    const roundTrip = new TutorialProgress({ storage: makeFakeStorage(), levelIds });
    check(
      '集成·进度：exportJson → importJson 往返后完成数与 id 完全一致',
      roundTrip.importJson(json) === true &&
        roundTrip.completedCount === progress.completedCount &&
        roundTrip.isCompleted(first) === true,
      `${json.slice(0, 60)}…`,
    );

    const reopened = new TutorialProgress({ storage, levelIds });
    check(
      '集成·进度：写进存储的进度能被新实例读回来（键 gad-box-tutorial-progress）',
      reopened.completedCount === 1 && storage.getItem(TUTORIAL_PROGRESS_STORAGE_KEY) !== null,
      `键 ${TUTORIAL_PROGRESS_STORAGE_KEY}`,
    );

    reopened.reset();
    check(
      '集成·进度：reset() 之后存储里的键被删除（清空进度不会留下残留）',
      storage.getItem(TUTORIAL_PROGRESS_STORAGE_KEY) === null && reopened.completedCount === 0,
    );
  }

  // =========================================================================
  // 3. 示例场景（第 3 批）——数量 / 自检 / 上限
  // =========================================================================
  {
    check(
      '集成·示例：内置示例至少有 11 个（需求的下限）',
      EXAMPLE_SCENES.length >= 11,
      `共 ${EXAMPLE_SCENES.length} 个：${EXAMPLE_SCENES.map((scene) => scene.id).join('、')}`,
    );

    const ids = EXAMPLE_SCENES.map((scene) => scene.id);
    check('集成·示例：id 唯一（重复 id 会让 getExample 取到错的那一个）', new Set(ids).size === ids.length);

    // 逐个跑数据自检：与 Engine.loadExampleScene() 里调的是同一个函数
    const bad: string[] = [];
    for (const scene of EXAMPLE_SCENES) {
      const problems = validateExample(scene);
      if (problems.length > 0) bad.push(`${scene.id}：${problems[0]!}`);
    }
    check(
      '集成·示例：每个示例都通过 validateExample（Engine 加载前的那道自检）',
      bad.length === 0,
      bad.length === 0 ? `${EXAMPLE_SCENES.length} 个全部通过` : bad.join('；'),
    );

    // 粒子数不超上限：桌面与移动两条口径都要过（移动端会按 mobileScale 降级）
    const overFluid: string[] = [];
    const overSand: string[] = [];
    const overRigid: string[] = [];
    for (const scene of EXAMPLE_SCENES) {
      const fluid = scene.plan.fluid;
      if (fluid) {
        if (fluidCountFor(scene, false) > fluidCapacity(fluid.preset, false, false)) {
          overFluid.push(`${scene.id}（桌面 ${fluidCountFor(scene, false)}）`);
        }
        if (fluidCountFor(scene, true) > fluidCapacity(fluid.preset, true, false)) {
          overFluid.push(`${scene.id}（移动 ${fluidCountFor(scene, true)}）`);
        }
      }
      if (scene.plan.sand && sandCellCountFor(scene, true) > sandCellCapacity()) {
        overSand.push(`${scene.id}（移动 ${sandCellCountFor(scene, true)} 格）`);
      }
      const dynamic = scene.plan.objects.filter((spec) => spec.mode === 'dynamic').length;
      // 动态物体在移动端不降级，所以必须一开始就在手机上限内
      if (dynamic > rigidCapacity(true)) overRigid.push(`${scene.id}（${dynamic} 个动态）`);
    }
    check(
      '集成·示例：粒子数（桌面与移动两条口径）都不超过该预设的上限',
      overFluid.length === 0,
      overFluid.length === 0 ? '全部在上限内' : overFluid.join('；'),
    );
    check(
      '集成·示例：沙格数不超过单步预算（移动端口径）',
      overSand.length === 0,
      overSand.length === 0 ? `预算 ${sandCellCapacity()} 格，全部在上限内` : overSand.join('；'),
    );
    check(
      '集成·示例：动态刚体数不超过手机上限（手机没法"少放几个"而不破坏场景）',
      overRigid.length === 0,
      overRigid.length === 0 ? `手机上限 ${rigidCapacity(true)}，全部在上限内` : overRigid.join('；'),
    );

    // 帮助中心的「打开示例」靠分类 → 示例 id 的映射，映射写歪就会指向不存在的示例
    const danglingExamples = Object.entries(HELP_EXAMPLE_BY_CATEGORY)
      .filter(([, exampleId]) => !EXAMPLE_SCENES.some((scene) => scene.id === exampleId))
      .map(([category, exampleId]) => `${category} → ${exampleId}`);
    check(
      '集成·示例：帮助中心的分类 → 示例映射全部指向真实存在的示例',
      danglingExamples.length === 0,
      danglingExamples.length === 0 ? `${Object.keys(HELP_EXAMPLE_BY_CATEGORY).length} 条映射全部命中` : danglingExamples.join('；'),
    );
  }

  // =========================================================================
  // 4. 帮助中心（第 3 批）——中文搜索 / 示例联动
  // =========================================================================
  {
    check(
      '集成·帮助：条目数量与分类都是非空的（面板渲染不出空白）',
      allHelpTopics().length > 0 && HELP_CATEGORIES.length > 0,
      `${allHelpTopics().length} 条 / ${HELP_CATEGORIES.length} 个分类`,
    );

    const hitWater = searchHelpTopics('水');
    check(
      '集成·帮助：中文单词查询「水」能命中条目',
      hitWater.length > 0,
      `命中 ${hitWater.length} 条：${hitWater.slice(0, 2).map((topic) => topic.question).join('、')}`,
    );

    // 多片段是 AND 语义：两个词都要命中才返回
    const hitBoth = searchHelpTopics('水 冻结');
    check(
      '集成·帮助：中文多词查询（"水 冻结"）按 AND 命中，且结果不比单词更多',
      hitBoth.length > 0 && hitBoth.length <= hitWater.length,
      `"水 冻结" 命中 ${hitBoth.length} 条 / "水" 命中 ${hitWater.length} 条`,
    );

    const hitNothing = searchHelpTopics('这个词肯定不存在zzz');
    check('集成·帮助：查不到时返回空数组（面板据此显示"换个词试试"）', hitNothing.length === 0);

    const missingExampleButton = allHelpTopics()
      .filter((topic) => !HELP_EXAMPLE_BY_CATEGORY[topic.category])
      .map((topic) => topic.category);
    check(
      '集成·帮助：每个分类都配了示例按钮（否则那一类帮助里没有"打开示例"）',
      missingExampleButton.length === 0,
      missingExampleButton.length === 0 ? '全部分类都有示例' : missingExampleButton.join('、'),
    );

    const untranslated = allHelpTopics().filter((topic) => !hasChinese(topic.question) || !hasChinese(topic.answer));
    check(
      '集成·帮助：每条帮助的问题与答案都是中文（没有漏译的英文条目）',
      untranslated.length === 0,
      untranslated.length === 0 ? `${allHelpTopics().length} 条全中文` : untranslated.map((t) => t.id).join('、'),
    );
  }

  // =========================================================================
  // 5. 关卡目录（第 4 批）——目录与三个运行器对得上
  // =========================================================================
  {
    check(
      '集成·关卡：目录至少 15 关（建筑 3 + 物理 6 + 流体 6）',
      TUTORIAL_CATALOG.length >= 15,
      `共 ${TUTORIAL_CATALOG.length} 关`,
    );

    const categories = tutorialsByCategory();
    check(
      '集成·关卡：分类分组非空且每个分类都有中文名（面板不会渲染出空标题）',
      categories.size > 0 && [...categories.keys()].every((name) => hasChinese(name)),
      [...categories.entries()].map(([name, levels]) => `${name} ${levels.length}`).join(' / '),
    );

    // 三个运行器的 id 集合必须刚好等于目录的 id 集合：多了说明目录漏登记，少了说明有死关卡
    const runnerIds = new Set<string>([
      ...BUILDING_LEVELS.map((level) => level.id),
      ...PHYSICS_TUTORIAL_LEVELS.map((level) => level.id),
      ...FLUID_LEVELS.map((level) => level.id),
    ]);
    const catalogIds = TUTORIAL_CATALOG.map((level) => level.id);
    const onlyInCatalog = catalogIds.filter((id) => !runnerIds.has(id));
    const onlyInRunners = [...runnerIds].filter((id) => !catalogIds.includes(id));
    check(
      '集成·关卡：目录里的每一关都能在三个运行器（建筑 / 物理 / 流体）里找到实现',
      onlyInCatalog.length === 0,
      onlyInCatalog.length === 0 ? `${catalogIds.length} 关全部有运行器` : `目录里有、运行器没有：${onlyInCatalog.join('、')}`,
    );
    check(
      '集成·关卡：反过来也不漏（运行器里的每一关都登记进了目录，玩家能在面板上找到它）',
      onlyInRunners.length === 0,
      onlyInRunners.length === 0 ? '运行器里的关卡全部已登记' : `运行器里有、目录没有：${onlyInRunners.join('、')}`,
    );

    const sample = getTutorial(catalogIds[0]!);
    check(
      '集成·关卡：每关都带 goal 与 successHint（面板与提示都要能说出"这关干什么"）',
      sample !== undefined && hasChinese(sample.goal) &&
        TUTORIAL_CATALOG.every((level) => hasChinese(level.goal) && hasChinese(level.successHint)),
      sample ? `${sample.name}：${sample.successHint}` : '取不到第一关',
    );
  }

  // =========================================================================
  // 6. 安全模式清单（第 1 批）——清单与引擎的落实动作对得上
  // =========================================================================
  {
    check(
      '集成·安全模式：清单是非空的，且 entry 字段都是非空字符串（面板要显示"引擎该走哪个入口"）',
      SAFE_MODE_RESTRICTIONS.length > 0 &&
        SAFE_MODE_RESTRICTIONS.every((item) => typeof item.entry === 'string' && item.entry.length > 0),
      `共 ${SAFE_MODE_RESTRICTIONS.length} 项`,
    );

    const keys = SAFE_MODE_RESTRICTIONS.map((item) => item.key);
    check(
      '集成·安全模式：清单里的 key 不重复（重复会让面板显示两遍、引擎也只按最后一个处理）',
      new Set(keys).size === keys.length,
      keys.join('、'),
    );

    const engineSource = readProjectFile('src/core/Engine.ts');
    if (engineSource === null) {
      check('集成·安全模式：能读到 Engine.ts 以核对清单是否逐项落实', true, '（没读到源码，跳过）');
    } else {
      // 逐项核对：清单里的每个 key 都必须在 applySafeModeRestrictions 的 switch 里有 case
      const missing = keys.filter((key) => !engineSource.includes(`case '${key}'`));
      check(
        '集成·安全模式：清单里的每一项都在 applySafeModeRestrictions() 里被处理（一项都不能落空）',
        missing.length === 0,
        missing.length === 0 ? `${keys.length} 项全部有对应动作` : `引擎里没处理：${missing.join('、')}`,
      );

      check(
        '集成·安全模式：引擎用的是清单自己的值（item.value），而不是另写一套常量',
        /applySafeModeRestrictions\(\): void \{[\s\S]*?item\.value/.test(engineSource),
      );

      check(
        '集成·安全模式：进入安全模式时会先备份当前开关（退出时才能还原）',
        engineSource.includes('this.safeModeRestore = {') && engineSource.includes('private exitSafeMode()'),
      );

      check(
        '集成·安全模式：粒子上限有"直接不生成"的门（fluidEmissionHeadroom），不是生成完再删',
        engineSource.includes('private fluidEmissionHeadroom(') &&
          engineSource.includes('this.fluidEmissionHeadroom(') &&
          engineSource.includes('private trimFluidToLimit('),
      );
    }
  }

  // =========================================================================
  // 7. 引擎接线（第 1~4 批）——源码级核对
  // =========================================================================
  {
    const engineSource = readProjectFile('src/core/Engine.ts');
    if (engineSource === null) {
      check('集成·引擎：能读到 Engine.ts', true, '（没读到源码，跳过）');
    } else {
      check(
        '集成·错误：构造函数里装了采集器（install），dispose() 第一件事是 uninstall()',
        engineSource.includes('this.errorHandler.install(') &&
          /dispose\(\): void \{[\s\S]{0,900}?this\.errorHandler\.uninstall\(\);/.test(engineSource),
      );
      check(
        '集成·错误：换世界失败与读档损坏两条路径都进了安全模式（world-load-failed / save-corrupt）',
        engineSource.includes("'world-load-failed'") && engineSource.includes("'save-corrupt'"),
      );
      check(
        '集成·错误：读档失败时会当场留一份损坏存档现场（lastCorruptExport）',
        engineSource.includes('this.lastCorruptExport = buildCorruptSaveExport('),
      );
      // 存储句柄这里**不匹配 `window.localStorage` 字面量**：兼容性审计 R1 修好之后，
      // 引擎改用它自己的 `this.resetStorage()`（会把"读属性就抛"的环境降级成不可读，
      // 而不是在按钮上炸掉）。断言要锁的是**三步的顺序**，不是取存储的写法。
      check(
        '集成·错误：重置走"requestConfirm → confirmDialog.ask → apply"三步（不是直接删）',
        /requestConfirm\(this\.resetStorage\(\)/.test(engineSource) &&
          engineSource.includes('this.confirmDialog.ask({') &&
          /this\.resetManager\.apply\(this\.resetStorage\(\), confirmation\)/.test(engineSource),
      );
      check(
        '集成·错误：重置用的存储句柄是受保护取法（读属性就抛的环境不会把按钮炸掉；R1）',
        engineSource.includes('private resetStorage(): ResetStorage {') &&
          !/requestConfirm\(window\.localStorage/.test(engineSource),
      );
      check(
        '集成·主题：ThemeSwitch 在引擎里被构造（构造即 apply，避免首帧跳变）',
        engineSource.includes('new ThemeSwitch(document.getElementById('),
      );
      check(
        '集成·快捷键：面板替换了旧的 ShortcutHelp（引擎不再 import / 构造它，只留注释说明）',
        engineSource.includes('new ShortcutPanel(document.getElementById(') &&
          !engineSource.includes("from '../ui/ShortcutHelp'") &&
          !engineSource.includes('new ShortcutHelp('),
      );
      check(
        '集成·快捷键：handleShortcut 通过 shortcuts.match() 分发（改键之后引擎不用改代码）',
        engineSource.includes('this.shortcuts.match({') && engineSource.includes('private runShortcutAction('),
      );
      check(
        '集成·面板：PanelManager 接管了 [data-panel]（attach 在构造函数里调过一次）',
        engineSource.includes('this.panelManager.attach('),
      );
      check(
        '集成·引导：每帧把界面状态喂给 onboarding.update()',
        engineSource.includes('this.onboarding.update(this.collectOnboardingState(), dtMs)'),
      );
      check(
        '集成·引导：帮助面板里有「重看新手引导」按钮的接线（onboarding.restart）',
        engineSource.includes("bind('onboarding-restart'") &&
          engineSource.includes("document.getElementById('help-restart-onboarding')"),
      );
      check(
        '集成·帮助：HelpCenter 接了 onOpenExample（每条帮助都能一键打开示例）',
        engineSource.includes("new HelpCenter(document.getElementById('help-center-body')") &&
          engineSource.includes('onOpenExample:'),
      );
      check(
        '集成·示例：一键加载复用 switchWorld + applyExamplePlan（示例自检不通过就中止，不假装成功）',
        engineSource.includes('async loadExampleScene(') &&
          engineSource.includes('this.applyExamplePlan(scene)') &&
          engineSource.includes('const problems = validateExample(scene)'),
      );
      check(
        '集成·关卡：流体教学接上了（setFluidTutorialActive / nextTutorialLevel / resetFluidTutorial 都有调用点）',
        engineSource.includes('this.setFluidTutorialActive(true)') &&
          engineSource.includes('this.nextTutorialLevel()') &&
          engineSource.includes('this.resetFluidTutorial()'),
      );
      check(
        '集成·关卡：通关会记进 TutorialProgress（建筑 / 物理 / 流体三条路都记）',
        (engineSource.match(/this\.tutorialProgress\.markCompleted\(/g) ?? []).length >= 3,
        `markCompleted 调用点 ${(engineSource.match(/this\.tutorialProgress\.markCompleted\(/g) ?? []).length} 处`,
      );
      check(
        '集成·提示：三个关键功能各有一条一次性提示（gad-box-hint-*）',
        engineSource.includes('gad-box-hint-') &&
          engineSource.includes("'fluid-tool'") &&
          engineSource.includes("'sand-tool'") &&
          engineSource.includes("'stress-scene'"),
      );
    }

    // ---- index.html：节点真的在页面上
    const html = readProjectFile('index.html');
    if (html === null) {
      check('集成·页面：能读到 index.html', true, '（没读到，跳过）');
    } else {
      const requiredIds = [
        'error-panel',
        'error-safe-banner',
        'error-restrictions',
        'error-summary',
        'error-list',
        'error-export-report',
        'error-export-corrupt',
        'error-reset',
        'error-reset-confirm-button',
        'theme-switch',
        'shortcut-panel',
        'help-panel',
        'help-center-body',
        'help-restart-onboarding',
        'tutorial-catalog-panel',
        'tutorial-catalog-body',
        'fluid-tutorial-status',
        'example-list',
        'onboarding-tip',
        'onboarding-title',
        'onboarding-body',
        'onboarding-next',
        'onboarding-skip',
        'onboarding-restart',
      ];
      const missingIds = requiredIds.filter((id) => !html.includes(`id="${id}"`));
      check(
        '集成·页面：M5 需要的节点全部在 index.html 里（少一个就少一个入口）',
        missingIds.length === 0,
        missingIds.length === 0 ? `${requiredIds.length} 个节点齐全` : `缺：${missingIds.join('、')}`,
      );

      // 引导气泡必须"能点透"：整层 pointer-events:none，只有卡片本身 auto
      check(
        '集成·页面：引导气泡层是 pointer-events:none（引导时玩家照样能操作世界）',
        /id="onboarding-tip"[\s\S]{0,400}?pointer-events:\s*none/.test(html) &&
          /id="onboarding-card"[\s\S]{0,400}?pointer-events:\s*auto/.test(html),
      );

      // 面板管理：C1 那批（折叠由 setTool 控制）必须带 data-panel-no-collapse
      const noCollapseIds = ['brush-panel', 'building-panel', 'placement-panel', 'selection-panel', 'fluid-panel', 'sand-panel'];
      const badNoCollapse = noCollapseIds.filter((id) => {
        const match = new RegExp(`<aside id="${id}"[^>]*>`).exec(html);
        return !match || !match[0].includes('data-panel-no-collapse');
      });
      check(
        '集成·页面：折叠由工具切换控制的面板都标了 data-panel-no-collapse（两边抢折叠会自己乱开合）',
        badNoCollapse.length === 0,
        badNoCollapse.length === 0 ? `${noCollapseIds.length} 个面板都标了` : `漏标：${badNoCollapse.join('、')}`,
      );

      const panelCount = (html.match(/data-panel="/g) ?? []).length;
      check(
        '集成·页面：被 PanelManager 接管的面板数量足够多（M5 要求给现有侧栏面板加上 data-panel）',
        panelCount >= 15,
        `共 ${panelCount} 个 [data-panel] 元素`,
      );

      check(
        '集成·页面：旧的 #shortcut-help 只读速查表已经不在了（两套键位文案同时存在会互相矛盾）',
        !html.includes('id="shortcut-help"'),
      );

      // 页面上有按钮、引擎里没有接线 = 一个按下去没反应的死按钮。
      // 这是集成阶段最容易留下的东西（面板写好了、按钮忘了接），所以逐个 id 去引擎源码里找一遍。
      const buttonIds = [
        'error-enter-safe',
        'error-exit-safe',
        'error-export-report',
        'error-export-corrupt',
        'error-reset',
        'error-reset-confirm-button',
        'error-reset-cancel',
        'help-restart-onboarding',
        'help-reset-panels',
        'fluid-tutorial-next',
        'fluid-tutorial-restart',
        'fluid-tutorial-exit',
        'tutorial-progress-reset',
        'onboarding-next',
        'onboarding-skip',
        'onboarding-restart',
      ];
      const engineText = readProjectFile('src/core/Engine.ts');
      if (engineText === null) {
        check('集成·页面：M5 新增的按钮都在引擎里有接线（没有死按钮）', true, '（没读到源码，跳过）');
      } else {
        // 判据是"这个 id 在引擎源码里作为字面量出现过"。为什么不用更精确的
        // `getElementById('xxx')`：引擎里的接线走的是两个局部小工具函数
        // （`on(id, listener)` / `bind(id, listener)`），id 是**变量**，
        // 那种写法在源码文本里根本搜不到 `getElementById('字面量')`。
        // 代价是"id 只出现在注释里"也会算通过 —— 所以这条断言的方向是
        // "拦住忘了接线的按钮"，而不是"证明按钮一定能点动"（那要真浏览器）
        const deadButtons = buttonIds.filter(
          (id) => html.includes(`id="${id}"`) && !engineText.includes(`'${id}'`),
        );
        check(
          '集成·页面：M5 新增的按钮都在引擎里有接线（按下去没反应的死按钮一个都不能留）',
          deadButtons.length === 0,
          deadButtons.length === 0 ? `${buttonIds.length} 个按钮全部有接线` : `没有接线：${deadButtons.join('、')}`,
        );
      }
    }
  }

  // =========================================================================
  // 8. 快捷键表（第 2 批）——与引擎行为的差异已被显式处理
  // =========================================================================
  {
    const ids = DEFAULT_SHORTCUTS.map((def) => def.id);
    check('集成·快捷键：动作 id 唯一（重复 id 会让改键改到另一个动作上）', new Set(ids).size === ids.length);

    check(
      '集成·快捷键：每条都有中文标签（面板上不出现英文 id）',
      DEFAULT_SHORTCUTS.every((def) => hasChinese(def.label)),
    );

    check(
      '集成·快捷键：H 已登记为帮助中心（帮助面板要能用键盘开合）',
      DEFAULT_SHORTCUTS.some((def) => def.id === 'help-center' && def.defaultKeys === 'H'),
    );

    // 这条记录的是"接线时核出的真实差异"：Ctrl+Shift+R 在引擎里从来没生效过，
    // 所以那条绑定被删掉了（详见 ShortcutPanel 里那段说明）。它一旦被谁加回来，
    // 就说明有人没看到那段注释 —— 那正是这条断言要拦住的事。
    check(
      '集成·快捷键：没有登记 Ctrl+Shift+R（它改键前就是失效的，接活等于新增无确认的破坏性快捷键）',
      !DEFAULT_SHORTCUTS.some((def) => def.defaultKeys === 'Ctrl+Shift+R'),
    );

    const engineSource = readProjectFile('src/core/Engine.ts');
    check(
      '集成·快捷键：Engine 里那条"重新生成地形"仍然存在（只是没有键位入口），没有顺手删掉',
      engineSource === null || engineSource.includes('regenerateTerrain(): void {'),
      engineSource === null ? '（没读到源码，跳过）' : '方法保留为公开入口',
    );
  }
}
