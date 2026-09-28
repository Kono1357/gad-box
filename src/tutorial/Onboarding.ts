/**
 * 首次进入的交互引导（M5 第 3 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 它和已有的两套教学有什么不一样（别搞混，也别重复做）
 * ────────────────────────────────────────────────────────────
 * | 模块 | 教什么 | 什么时候出现 |
 * |---|---|---|
 * | `mobile/GestureTutorial.ts` | 手机上的四个**手势**（单指拖动 / 轻点 / 双指 / 长按） | 触屏设备第一次 |
 * | `tutorial/TutorialCatalog.ts` 那 15 关 | 每关一个**具体玩法**（放门、连关节、倒水…） | 玩家主动点「教学」 |
 * | **本文件** | 第一次进游戏"这个世界能干什么"：视角、地形、建筑、面板、流体、沙土、存档 | 第一次进游戏（跳过也算看过） |
 * 所以这里**不复用** `GESTURE_STEPS`：那四条是触屏手势，桌面玩家没有"单指拖动"这个概念；
 * 这里也不判定任何玩法是否通关 —— 那是关卡表的事。
 *
 * ────────────────────────────────────────────────────────────
 * 关键设计：`update()` 一帧都不碰 DOM
 * ────────────────────────────────────────────────────────────
 * 需求点名了这一条，理由很实在：引导一旦自己查 DOM，就没法在 Node 里断言
 * "做到第几步、什么时候算完成"。所以本文件把 DOM 彻底推给调用方：
 * Engine 每帧组装一份 `OnboardingState` 喂进 `update()`，拿到返回的 `step`
 * 后自己决定要不要高亮 `step.anchor`、要不要显示 `step.body`。
 * 于是这一整个文件在 Node 里 `new Onboarding()` 跑断言时没有任何 DOM 依赖。
 *
 * 还有一个副作用很好的地方：状态是**外部喂进来的**，所以玩家在引导开始前
 * 就已经做过的事（比如他先转了视角才点开始）也会被如实算数 —— 不需要在
 * 引导里再记一遍"玩家干过什么"，那第二份状态迟早和引擎里的那份对不上。
 *
 * ────────────────────────────────────────────────────────────
 * 7 步 ↔ 7 个状态字段，一一对应
 * ────────────────────────────────────────────────────────────
 * 每一步的 `isDone` **只读一个字段**，不做组合判断。这既让断言可以"逐项打开验证"
 * （打开第 i 个字段只可能让第 i 步达成），也让玩家看到的行为可预测：
 * 做了 X，这一格就亮，不会出现"明明做了却没反应"。
 * 顺序也是依赖顺序：先会看（视角）→ 会改（地形 / 建筑）→ 会见（面板）
 * → 会玩两个粒子系统（流体 / 沙土）→ 会存（存档）。
 *
 * ────────────────────────────────────────────────────────────
 * 完成状态存 localStorage，跳过也算"看过"
 * ────────────────────────────────────────────────────────────
 * 键名 `gad-box-onboarding-done`（需求指定）。记录里同时写了 `skipped` 与走到的步数，
 * 只用于统计，**不影响是否再弹** —— 玩家明确点了「跳过」，下次进来还弹一次是骚扰。
 * 读写失败（无痕模式 / 配额满 / JSON 坏了）一律降级成"没看过"，宁可多教一次也绝不抛异常。
 */

/** 外部每帧喂进来的界面状态（Engine 组装） */
export interface OnboardingState {
  /** 玩家是否移动过镜头（旋转 / 平移 / 缩放 / 键盘移动都算） */
  movedCamera: boolean;
  /** 是否放过一个建筑 */
  placedBuilding: boolean;
  /** 是否改过地形（笔刷留下过改动） */
  editedTerrain: boolean;
  /** 当前打开的哪个面板（null = 一个面板都没开过） */
  openedPanel: string | null;
  /** 是否用过流体工具 */
  usedFluidTool: boolean;
  /** 是否用过沙土工具 */
  usedSandTool: boolean;
  /** 是否保存过一次（Ctrl+S / 工具栏 💾 / 自动保存都算） */
  savedOnce: boolean;
}

/** 一个"什么都没做"的初始状态。Engine 每帧在这个基础上填真值，断言也用它当基线 */
export function emptyOnboardingState(): OnboardingState {
  return {
    movedCamera: false,
    placedBuilding: false,
    editedTerrain: false,
    openedPanel: null,
    usedFluidTool: false,
    usedSandTool: false,
    savedOnce: false,
  };
}

export interface OnboardingStep {
  id: string;
  title: string;
  body: string;
  /** 高亮目标的选择器（可为 null） */
  anchor: string | null;
  /** 完成条件：由外部每帧喂进来的界面状态判定 */
  isDone(state: OnboardingState): boolean;
}

/**
 * 7 步引导。
 *
 * `anchor` 里的选择器**必须**是 index.html 里真实存在的 id（写文案时逐个核对过）：
 * 指错地方比不指还糟 —— 玩家会盯着一个无关的面板找半天。
 * 其中「打开一个面板」与「保存」两步的 anchor 分别是工具栏与保存按钮，
 * 它们会让玩家自己选开哪个面板，而不是被按头开某一个。
 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'camera',
    title: '先看一眼这个世界',
    body:
      '按住鼠标中键拖动可以转视角，滚轮拉近拉远，按住右键拖动是平移（手机上用两根手指）。' +
      '先随便转两下，找到你感兴趣的那块地。',
    anchor: '#viewport',
    isDone: (state) => state.movedCamera,
  },
  {
    id: 'terrain',
    title: '把地面捏成你想要的样子',
    body:
      '按 1 切到地形笔刷，按住左键在地面上拖，就能把地抬高；按住 Shift 拖是往下挖。' +
      '左边「🖌 笔刷」面板里可以换形状与笔刷模式，Alt+滚轮调半径。',
    anchor: '#brush-panel',
    isDone: (state) => state.editedTerrain,
  },
  {
    id: 'building',
    title: '往世界里放个东西',
    body:
      '按 2 切到建筑工具，在左边「🏠 建筑」面板里挑一个模型（搜索框输入「木箱」试试），' +
      '再把鼠标移到地面上点一下，它就会落在高亮框里。放下去之后按播放键就能看它掉下来。',
    anchor: '#building-panel',
    isDone: (state) => state.placedBuilding,
  },
  {
    id: 'panel',
    title: '这些面板才是沙盘的全貌',
    body:
      '工具栏上每一组按钮背后都是一张面板：物理、关节、组合、蓝图、性能……' +
      '现在随便点开一个看看，里面每一个开关都能改这个世界的规则。',
    anchor: '#main-toolbar',
    isDone: (state) => state.openedPanel !== null,
  },
  {
    id: 'fluid',
    title: '倒一摊水试试',
    body:
      '按 4 切到流体工具，在「💧 流体」面板里选「泼水」，然后按住左键往下倒 —— ' +
      '水会自己流、自己找平，还会把箱子浮起来。面板里的「冻结」能把水冻住当闸门用。',
    anchor: '#fluid-panel',
    isDone: (state) => state.usedFluidTool,
  },
  {
    id: 'sand',
    title: '再堆一堆沙',
    body:
      '按 5 切到沙土工具，选「堆沙」堆一个高一点的沙柱，松手看它塌下来 —— ' +
      '沙有安息角，堆太高就会连锁滑坡。用「湿沙」把沙弄湿，它就能被水冲成泥流。',
    anchor: '#sand-panel',
    isDone: (state) => state.usedSandTool,
  },
  {
    id: 'save',
    title: '记得存下来',
    body:
      '按 Ctrl+S（或点工具栏的 💾）把这个世界存到浏览器里，下次打开还在。' +
      '想带走的话点 ⬇ 导出成 JSON 文件。存好之后，右上角「🎓 教学」里有 15 关可以照着玩。',
    anchor: '[data-action="save"]',
    isDone: (state) => state.savedOnce,
  },
];

/** localStorage 键名（需求指定的字样） */
export const ONBOARDING_STORAGE_KEY = 'gad-box-onboarding-done';

/** 当前存档格式版本 */
export const ONBOARDING_STORAGE_VERSION = 1;

/** 只用到这三个方法的存储接口（注入假存储才能在 Node 里验证降级路径） */
export interface OnboardingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface OnboardingOptions {
  /** 存储；传 `null` 表示不持久化（断言 / 无痕模式）；缺省用 localStorage */
  storage?: OnboardingStorage | null;
  /** 时间源；缺省 `Date.now` */
  now?: () => number;
  /** 步骤表；缺省 `ONBOARDING_STEPS`（断言"步数必须 5~7"时不用改它） */
  steps?: readonly OnboardingStep[];
}

/** 存档里记的东西（`skipped` / `steps` 只用于统计，不影响是否再弹） */
interface StoredOnboardingState {
  v: number;
  done: boolean;
  skipped: boolean;
  /** 完成时走到了第几步（0 起；跳过的会小于总步数） */
  steps: number;
  atMs: number;
}

/** `update()` 的返回值：当前该显示哪一步 + 这一次调用是否刚好把引导走完 */
export interface OnboardingUpdate {
  step: OnboardingStep;
  justCompleted: boolean;
}

/** 取 localStorage；取不到返回 null（有些浏览器里"访问这个属性"本身就会抛） */
function resolveDefaultStorage(): OnboardingStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function defaultNow(): number {
  return Date.now();
}

/**
 * 引导状态机。
 *
 * 典型接法（每帧一次，DOM 由 Engine 按返回的 step 渲染）：
 * ```ts
 * if (!this.onboarding.active && this.onboarding.needsOnboarding) this.onboarding.start();
 * ...
 * const { step, justCompleted } = this.onboarding.update(this.collectOnboardingState(), dtMs);
 * this.hintBanner.show(step.title, step.body);        // 显示
 * this.highlight.guide(step.anchor);                  // 高亮（anchor 为 null 就不高亮）
 * if (justCompleted) this.showToast('引导完成，随时可以在帮助中心重看', 3000);
 * ```
 */
export class Onboarding {
  private readonly storage: OnboardingStorage | null;
  private readonly now: () => number;
  private readonly steps: readonly OnboardingStep[];
  /** 当前步（私有字段名刻意不叫 index：公开的 `index` 是个 getter，重名会直接编译不过） */
  private cursor = 0;
  private activeFlag = false;
  /** 这一步行为了多久（毫秒）—— 面板可以据此显示"你已经停在这一步 12 秒了" */
  private elapsed = 0;
  /** 以前看过（走完或跳过）→ 不需要再自动弹出 */
  private finishedBefore = false;
  private disposed = false;
  /** 最近一次存储读写的失败说明（与其它字段一起声明，免得读者以为它晚于构造函数才有值） */
  private lastErrorText: string | null = null;

  constructor(options: OnboardingOptions = {}) {
    // 显式传 `storage: null` 与"没传"是两件事：前者是"不要持久化"，后者是"用 localStorage"。
    // 所以判断 `!== undefined`，不能用 `??`。
    this.storage = options.storage !== undefined ? options.storage : resolveDefaultStorage();
    this.now = options.now ?? defaultNow;
    this.steps = options.steps && options.steps.length > 0 ? options.steps : ONBOARDING_STEPS;
    this.finishedBefore = this.readFinishedFlag();
  }

  /** 当前步骤（索引始终夹在合法范围内，任何情况下都不会返回 undefined） */
  get step(): OnboardingStep {
    return this.steps[Math.min(this.cursor, this.steps.length - 1)]!;
  }

  /** 当前步序号（0 起） */
  get index(): number {
    return this.cursor;
  }

  /** 总步数 */
  get total(): number {
    return this.steps.length;
  }

  /** 是否正在进行（面板据此决定显示还是隐藏） */
  get active(): boolean {
    return this.activeFlag && !this.disposed;
  }

  /** 这一步行为了多久（毫秒） */
  get stepElapsedMs(): number {
    return this.elapsed;
  }

  /** 从没完成过 → true（跳过也算"看过"，见文件头） */
  get needsOnboarding(): boolean {
    return !this.finishedBefore;
  }

  /** 步骤表（面板画进度点用；不要改它） */
  get allSteps(): readonly OnboardingStep[] {
    return this.steps;
  }

  /** 最近一次存储读写失败的说明；成功时为 null */
  get lastError(): string | null {
    return this.lastErrorText;
  }

  /** 开始（从头开始）。已经完成过的玩家也可以主动重看 */
  start(): void {
    if (this.disposed) return;
    this.cursor = 0;
    this.elapsed = 0;
    this.activeFlag = true;
  }

  /**
   * 跳过。
   *
   * 跳过＝"我看过了"，会写存档，下次进来不再自动弹（理由见文件头）。
   * 同时把当前步号记进存档：将来想统计"玩家最常在哪一步放弃"就靠它。
   */
  skip(): void {
    if (this.disposed) return;
    this.finish(true);
  }

  /**
   * 重看（帮助中心里的「再看一次新手引导」按钮）。
   *
   * 刻意**不清**存档：玩家看到一半关掉页面，下次仍是"已看过"，
   * 不会因为他点了一下「重看」就变成每次启动都弹 —— 那是最烦人的一种 bug。
   * 真的走完（或再次跳过）时才会覆盖存档、刷新时间戳。
   */
  restart(): void {
    if (this.disposed) return;
    this.start();
  }

  /** 手动下一步（面板上的「下一步」按钮）。最后一步调它＝走完引导 */
  next(): void {
    if (this.disposed || !this.activeFlag) return;
    this.advance();
  }

  /**
   * 每帧推进。
   *
   * @param state 外部组装好的界面状态（玩家做过什么）
   * @param dtMs 距上一帧的毫秒数（负数按 0 处理：系统时间跳变不该把计时器拉成负数）
   * @returns 当前该显示的步骤 + 这一次是否刚好把引导走完
   *
   * 三条规则，都是刻意的：
   * 1. **不在引导中直接返回，什么都不做**（未 `start()` / 已跳过 / 已完成）；
   * 2. **一帧最多推进一步**：就算状态一次全满足，也要按步骤数一帧一步走完。
   *    这样的好处是每一步的文案都真的被显示过一帧，玩家不会"还没看清就过去了"；
   * 3. `justCompleted` **只会为 true 一次**（完成的那一刻），
   *    调用方可以放心拿它去弹 toast 或写存档，不会重复触发。
   */
  update(state: OnboardingState, dtMs: number): OnboardingUpdate {
    if (this.disposed || !this.activeFlag) {
      return { step: this.step, justCompleted: false };
    }
    this.elapsed += Math.max(0, Number.isFinite(dtMs) ? dtMs : 0);

    if (!this.step.isDone(state)) {
      return { step: this.step, justCompleted: false };
    }

    const isLast = this.cursor >= this.steps.length - 1;
    if (!isLast) {
      this.advance();
      return { step: this.step, justCompleted: false };
    }

    this.finish(false);
    return { step: this.step, justCompleted: true };
  }

  /** 卸载（Engine 销毁时调）。之后所有方法都不再改动状态，也不会写存储 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeFlag = false;
  }

  /** 一行中文摘要（调试 / 日志用） */
  describe(): string {
    if (!this.activeFlag) {
      return this.finishedBefore ? '新手引导：已看过（未显示）' : '新手引导：未开始';
    }
    return `新手引导：第 ${this.cursor + 1} / ${this.steps.length} 步「${this.step.title}」`;
  }

  // ---------------------------------------------------------------- 内部
  /** 前进一步；已经在最后一步时返回 false（由调用方决定要不要收尾） */
  private advance(): void {
    if (this.cursor >= this.steps.length - 1) {
      this.finish(false);
      return;
    }
    this.cursor += 1;
    this.elapsed = 0;
  }

  /** 收尾：停掉引导、记下"看过"，并写存档 */
  private finish(skipped: boolean): void {
    this.activeFlag = false;
    this.finishedBefore = true;
    this.persist(skipped);
  }

  /** 写存档。任何异常都只记 lastError：功能照常，绝不抛 */
  private persist(skipped: boolean): void {
    if (!this.storage) return;
    const payload: StoredOnboardingState = {
      v: ONBOARDING_STORAGE_VERSION,
      done: true,
      skipped,
      steps: this.cursor,
      atMs: this.now(),
    };
    try {
      this.storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(payload));
      this.lastErrorText = null;
    } catch (error) {
      this.lastErrorText =
        `记录引导完成状态失败（${error instanceof Error ? error.message : String(error)}）；` +
        '本次启动不再提示，但下次打开可能会再弹一次';
    }
  }

  /** 读"以前看过没有"。任何异常（JSON 坏了 / 存储不可用）都兜底成 false */
  private readFinishedFlag(): boolean {
    if (!this.storage) return false;
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(ONBOARDING_STORAGE_KEY);
    } catch (error) {
      this.lastErrorText = `读取引导存档失败（${error instanceof Error ? error.message : String(error)}）`;
      return false;
    }
    if (!raw) return false;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return false;
      // 只要 done === true 就算看过；`skipped` / `steps` 不参与判断（见文件头）
      return (parsed as StoredOnboardingState).done === true;
    } catch {
      this.lastErrorText = '引导存档不是合法 JSON，已按"没看过"处理（大不了再教一次）';
      return false;
    }
  }
}
