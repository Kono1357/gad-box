/**
 * 手势教学浮层（补充 6）—— 手机上第一次打开时教四个手势。
 *
 * ## 为什么要做这个
 *
 * 桌面版有一套鼠标 + 键盘的操作习惯（左键拖拽转视角、滚轮缩放），移植到手机上
 * 全部变成了手势。玩家第一次打开时屏幕上只有一个沙盘，**没有任何提示告诉他
 * "两根手指可以转镜头"** —— 于是他就一直用默认视角玩，然后觉得"这游戏视角不能动"。
 * 所以第一次进游戏要教一次：单指拖动瞄准 / 轻点放置 / 双指转镜头 / 长按拿起。
 *
 * ## 诚实取舍
 *
 * 1. **只在触屏设备的第一次自动弹出，桌面端永远不弹。** 本类**不自己判断设备**：
 *    `hasCompletedBefore` 只报"以前学没学过"，是否弹出由调用方（Engine）结合
 *    `DeviceCapability` 的 `isTouchDevice` 决定。桌面端用手势教学纯属添乱 ——
 *    鼠标玩家没有"单指拖动"这个概念。
 * 2. **不阻塞操作**：覆盖层 `pointer-events: none`，只有卡片本身 `auto`。
 *    所以教学卡片在屏幕上时玩家**照样能拖镜头、能放置**（这恰恰是重点：
 *    教学最好的用法是"边做边学"，玩家做完 `drag` 就自动进下一步），
 *    卡片之外的地方一律点得动，不会出现"点了没反应，其实是被透明层吃了"。
 * 3. **"做到了就自动下一步"**：Engine 把 TouchInput 的手势事件转发给
 *    `notifyGesture()`，跟当前步骤的 `gesture` 对上了就推进。
 *    匹配不上**不重置进度** —— 玩家在学"轻点放置"时随手转了下镜头，
 *    不该把他打回第一步。
 * 4. **完成状态存在 localStorage**（key `god-sandbox-gesture-tutorial-v1`），
 *    读不到 / JSON 坏了 / 浏览器禁用了 storage（Safari 无痕）一律兜底成
 *    "没学过" → 大不了再教一次，**绝不抛异常**。
 * 5. **自建 DOM**：不改 index.html，也不用任何 `#id` 选择器查元素（那个文件不归本模块管），
 *    全部 `createElement` + 内联样式，风格与 `src/ui/HintBanner.ts` 一致。
 * 6. **Node 下 import 与 new 都不崩**：没有 `document` 时整棵 DOM 跳过，
 *    状态机照常工作（`show()` / `notifyGesture()` 有效，只是画不出来），
 *    这样验证脚本能在 Node 里断言"完成时回调了几次、第几步"。
 */

/** 一步教学 */
export interface GestureTutorialStep {
  id: string;
  /** 指令标题，例如「单指拖动瞄准」 */
  title: string;
  /** 说明文字 */
  text: string;
  /** 用哪个 emoji/图形示意 */
  icon: string;
  /**
   * 这个手势在 TouchInput 里对应的事件名（'drag' | 'tap' | 'orbit' | 'longpress' 等），
   * 用于"做到了就自动下一步"。
   * 名字对齐 `src/mobile/TouchInput.ts` 的 `GestureName`，改那边要同步改这里。
   */
  gesture: string;
}

/**
 * 教学步骤（顺序 = 依赖顺序：先会瞄准，才会放置；先会放置，才谈得上拿起）。
 *
 * 文案刻意"说结果不说操作"：「光标跟着手指走」而不是「touchmove 事件」——
 * 玩家只关心屏幕上的东西怎么动。
 */
export const GESTURE_STEPS: GestureTutorialStep[] = [
  {
    id: 'aim',
    title: '单指拖动瞄准',
    text: '一根手指按住屏幕拖动，地上的高亮框会跟着手指走，那就是落点。',
    icon: '👆',
    gesture: 'drag',
  },
  {
    id: 'place',
    title: '轻点放置',
    text: '光标对准位置后轻点一下，物体就落在高亮框里。放不下时会震两下提醒你。',
    icon: '📍',
    gesture: 'tap',
  },
  {
    id: 'orbit',
    title: '双指转镜头',
    text: '两根手指一起拖动可以旋转视角，捏合是拉近拉远。找不到方向时先转一圈看看。',
    icon: '✌️',
    gesture: 'orbit',
  },
  {
    id: 'pickup',
    title: '长按拿起',
    text: '按住一个物体约半秒不放就能把它拿起来，再点一次放下（放回地面也行）。',
    icon: '🤏',
    gesture: 'longpress',
  },
];

export interface GestureTutorialHandlers {
  /** 全部完成 */
  onFinished(skipped: boolean): void;
  /** 玩家点「跳过教学」 */
  onSkip(): void;
}

/** localStorage 键名：带版本号，以后文案大改可以换 v2 再教一次 */
export const GESTURE_TUTORIAL_STORAGE_KEY = 'god-sandbox-gesture-tutorial-v1';

/** 卡片距屏幕底部的距离：要躲开两个虚拟摇杆（底座 112px + 边距 18px） */
const CARD_BOTTOM_OFFSET = 'calc(env(safe-area-inset-bottom, 0px) + 140px)';

/** 层级 60：高过提示条(45) 与主菜单(50)；但它是"不阻塞"的一层，高一点也无所谓 */
const CARD_Z_INDEX = '60';

/** 项目深色主题：与 src/style.css 的 :root 变量保持一致 */
const COLOR_CARD_BG = 'rgba(16, 20, 24, 0.94)';
const COLOR_CARD_BORDER = '#2b3640';
const COLOR_TEXT = '#d8e2ea';
const COLOR_TEXT_DIM = '#8b9aa8';
const COLOR_ACCENT = '#7fd06a';
const COLOR_DOT_IDLE = '#3a4550';
const FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/** 手机可点面积要求：所有按钮不低于 44px 高 */
const BUTTON_MIN_HEIGHT = '44px';

/** 持久化记录（存 JSON，方便以后加字段） */
interface StoredTutorialState {
  completed: boolean;
  /** 是"跳过的"还是"学完的"，只用于统计，不影响是否再教 */
  skipped?: boolean;
  steps?: number;
  completedAt?: number;
}

/** 自建 DOM 的引用集合（Node 下整块为 null） */
interface TutorialDom {
  overlay: HTMLDivElement;
  card: HTMLDivElement;
  dots: HTMLDivElement[];
  stepText: HTMLSpanElement;
  icon: HTMLSpanElement;
  title: HTMLDivElement;
  text: HTMLDivElement;
  prevButton: HTMLButtonElement;
  nextButton: HTMLButtonElement;
  skipButton: HTMLButtonElement;
}

/** 内联样式统一走这里 */
function style(el: HTMLElement, patch: Record<string, string>): void {
  Object.assign(el.style, patch);
}

/**
 * 取 localStorage，取不到返回 null。
 *
 * 注意必须用 try 包住：**有些浏览器里"访问 localStorage 这个属性"本身就会抛**
 * （Cookie 被完全禁用、某些企业策略 / 无痕模式），不是只有读值才会抛。
 */
function getStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 读"以前学过没有"。任何异常（JSON 坏了 / storage 不可用）都兜底为 false。 */
function readCompletedFlag(): boolean {
  try {
    const storage = getStorage();
    if (!storage) return false;
    const raw = storage.getItem(GESTURE_TUTORIAL_STORAGE_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return false;
    return (parsed as StoredTutorialState).completed === true;
  } catch {
    // 存的是垃圾数据 / storage 被禁用：当作"没学过"，宁可多教一次也不抛异常
    return false;
  }
}

/**
 * 手势教学浮层。
 *
 * Engine 里的典型接法：
 * ```ts
 * const tutorial = new GestureTutorial({ onFinished: () => {}, onSkip: () => {} });
 * if (device.isTouchDevice && !tutorial.hasCompletedBefore) tutorial.show();
 * touch.on('drag', () => tutorial.notifyGesture('drag')); // 四个手势都转发
 * ```
 */
export class GestureTutorial {
  private readonly dom: TutorialDom | null;
  private index = 0;
  private visibleFlag = false;
  private disposed = false;

  constructor(private readonly handlers: GestureTutorialHandlers) {
    // 没有 document（Node / Worker）就完全不碰 DOM：状态机照样能跑，只是画不出来
    this.dom = typeof document === 'undefined' ? null : this.buildDom();
  }

  /**
   * 是否应该显示（从未完成过 && 是触屏设备）—— 由调用方决定是否调 show()，
   * 这个 getter 只报"以前学没学过"（触屏判断在调用方 / DeviceCapability 那边）。
   */
  get hasCompletedBefore(): boolean {
    return readCompletedFlag();
  }

  /** 显示（从第一步开始，重置状态） */
  show(): void {
    if (this.disposed) return;
    this.index = 0;
    this.visibleFlag = true;
    if (this.dom) this.dom.overlay.style.display = 'block';
    this.render();
  }

  /**
   * 收起。
   *
   * **刻意不写存档**：只有"走完全部步骤"或"点了跳过教学"才算学过。
   * 外部（比如打开主菜单）临时收起一下，不该被当成"玩家已经学会了"。
   */
  hide(): void {
    if (this.disposed || !this.visibleFlag) return;
    this.visibleFlag = false;
    if (this.dom) this.dom.overlay.style.display = 'none';
  }

  get isVisible(): boolean {
    return this.visibleFlag;
  }

  get currentStep(): GestureTutorialStep | null {
    if (this.index < 0 || this.index >= GESTURE_STEPS.length) return null;
    return GESTURE_STEPS[this.index] ?? null;
  }

  get stepIndex(): number {
    return this.index;
  }

  /**
   * 由 Engine 在收到手势时调用：如果这个手势正是当前步骤要教的，就自动推进。
   * @returns 是否发生了一次推进
   */
  notifyGesture(gesture: string): boolean {
    if (this.disposed || !this.visibleFlag) return false;
    const step = this.currentStep;
    if (!step) return false;
    if (step.gesture !== gesture) return false; // 不匹配：什么都不做，尤其**不重置进度**
    this.advance();
    return true;
  }

  /** 手动下一步（玩家点「我懂了」） */
  next(): void {
    if (this.disposed || !this.visibleFlag) return;
    this.advance();
  }

  /** 回到上一步 */
  prev(): void {
    if (this.disposed || !this.visibleFlag) return;
    if (this.index === 0) return;
    this.index -= 1;
    this.render();
  }

  /**
   * 清掉"已学过"的存档并把步骤拨回第一步。
   *
   * 它**不**回调 `onFinished` / `onSkip`（那两条是"玩家结束教学"的事件，
   * reset 是"重置状态"，混在一起会让调用方收到假的完成事件），
   * 也会顺带收起浮层（如果正显示着）。
   */
  reset(): void {
    if (this.disposed) return;
    this.index = 0;
    this.hide();
    try {
      getStorage()?.removeItem(GESTURE_TUTORIAL_STORAGE_KEY);
    } catch {
      /* 存不了就存不了：下次再教一遍而已 */
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visibleFlag = false;
    this.dom?.overlay.remove();
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 推进一格；已经是最后一步就收工。
   *
   * 收工顺序：先收起浮层 → 写存档 → 回调。先写存档再回调，
   * 是因为回调里 Engine 可能会立刻改 UI / 播动画，那时候"学过"这件事应该已经落盘了。
   */
  private advance(): void {
    const nextIndex = this.index + 1;
    if (nextIndex >= GESTURE_STEPS.length) {
      this.finish(false);
      return;
    }
    this.index = nextIndex;
    this.render();
  }

  /** 结束教学：skip 只影响存档里的一个标记与回调参数 */
  private finish(skipped: boolean): void {
    this.hide();
    this.markCompleted(skipped);
    if (skipped) this.handlers.onSkip();
    this.handlers.onFinished(skipped);
  }

  /** 写"学过了"。任何异常都咽掉：存档失败最多是下次再教一遍 */
  private markCompleted(skipped: boolean): void {
    try {
      const storage = getStorage();
      if (!storage) return;
      const record: StoredTutorialState = {
        completed: true,
        skipped,
        steps: GESTURE_STEPS.length,
        completedAt: Date.now(),
      };
      storage.setItem(GESTURE_TUTORIAL_STORAGE_KEY, JSON.stringify(record));
    } catch {
      /* 配额满 / 无痕模式：忽略 */
    }
  }

  /** 把当前步骤画到 DOM 上（Node 下 dom 为 null，直接返回） */
  private render(): void {
    const dom = this.dom;
    if (!dom) return;
    const step = this.currentStep;
    if (!step) return;

    dom.icon.textContent = step.icon;
    dom.title.textContent = step.title;
    dom.text.textContent = step.text;
    dom.stepText.textContent = `第 ${this.index + 1} / ${GESTURE_STEPS.length} 步`;

    for (let i = 0; i < dom.dots.length; i += 1) {
      const dot = dom.dots[i]!;
      dot.style.background = i <= this.index ? COLOR_ACCENT : COLOR_DOT_IDLE;
      dot.style.transform = i === this.index ? 'scale(1.4)' : 'scale(1)';
    }

    // 第一步没有"上一步"可回：禁用 + 压暗，但保留占位，免得按钮行左右乱跳
    const atFirst = this.index === 0;
    dom.prevButton.disabled = atFirst;
    dom.prevButton.style.opacity = atFirst ? '0.4' : '1';

    // 「我懂了」的文案全程不变：按钮不该在手指底下换字换宽（最后一步点了就是"完成"）
  }

  /**
   * 建 DOM。
   *
   * 结构：覆盖层（fixed 全屏、`pointer-events: none`）
   *   └ 卡片（`pointer-events: auto`，只有它吃事件）
   *       ├ 进度行：圆点 + 「第 2 / 4 步」
   *       ├ 图标 / 标题 / 说明
   *       └ 按钮行：上一步 · 我懂了 · 跳过教学
   */
  private buildDom(): TutorialDom {
    const overlay = document.createElement('div');
    overlay.setAttribute('aria-hidden', 'false');
    style(overlay, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      right: '0px',
      bottom: '0px',
      // 关键：覆盖层不吃事件，只有卡片自己吃 —— 教学期间玩家照样能操作沙盘
      pointerEvents: 'none',
      zIndex: CARD_Z_INDEX,
      display: 'none',
    });

    const card = document.createElement('div');
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', '手势教学');
    style(card, {
      position: 'absolute',
      left: '50%',
      // 居中偏下：不盖住顶部工具栏，也躲开底部两个摇杆
      bottom: CARD_BOTTOM_OFFSET,
      transform: 'translateX(-50%)',
      width: 'min(88vw, 360px)',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      padding: '12px 14px 14px',
      background: COLOR_CARD_BG,
      border: `1px solid ${COLOR_CARD_BORDER}`,
      borderRadius: '14px',
      boxShadow: '0 10px 28px rgba(0, 0, 0, 0.5)',
      backdropFilter: 'blur(3px)',
      WebkitBackdropFilter: 'blur(3px)',
      color: COLOR_TEXT,
      fontFamily: FONT_STACK,
      textAlign: 'left',
      // 只有卡片本身接收点击
      pointerEvents: 'auto',
    });

    // ---- 进度行：左边圆点，右边「第 N / 4 步」 ----
    const header = document.createElement('div');
    style(header, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
    });

    const dotsRow = document.createElement('div');
    dotsRow.setAttribute('aria-hidden', 'true'); // 进度用文字报给读屏就够，圆点是装饰
    style(dotsRow, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
    });

    const dots: HTMLDivElement[] = [];
    for (let i = 0; i < GESTURE_STEPS.length; i += 1) {
      const dot = document.createElement('div');
      style(dot, {
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: COLOR_DOT_IDLE,
        transition: 'background 160ms ease, transform 160ms ease',
      });
      dots.push(dot);
      dotsRow.appendChild(dot);
    }

    const stepText = document.createElement('span');
    style(stepText, {
      color: COLOR_TEXT_DIM,
      fontSize: '11px',
      lineHeight: '1.2',
      whiteSpace: 'nowrap',
    });

    header.appendChild(dotsRow);
    header.appendChild(stepText);

    // ---- 图标 ----
    const icon = document.createElement('span');
    style(icon, {
      fontSize: '30px',
      lineHeight: '1.1',
      textAlign: 'center',
    });

    // ---- 标题 ----
    const title = document.createElement('div');
    style(title, {
      color: COLOR_ACCENT,
      fontSize: '15px',
      fontWeight: '700',
      lineHeight: '1.3',
      textAlign: 'center',
    });

    // ---- 说明：内容会随步骤变，标成 polite 让读屏播报新的一步 ----
    const text = document.createElement('div');
    text.setAttribute('aria-live', 'polite');
    style(text, {
      color: COLOR_TEXT,
      fontSize: '12.5px',
      lineHeight: '1.6',
    });

    // ---- 按钮行 ----
    const buttons = document.createElement('div');
    style(buttons, {
      display: 'flex',
      alignItems: 'stretch',
      gap: '8px',
      marginTop: '2px',
    });

    // 上一步：次要按钮（描边）
    const prevButton = this.createButton('上一步', false);
    prevButton.addEventListener('click', () => this.prev());

    // 我懂了：主按钮（实心强调色），也是"下一步"
    const nextButton = this.createButton('我懂了', true);
    nextButton.addEventListener('click', () => this.next());

    // 跳过教学：次要按钮，点了算"学过"（不再自动弹）
    const skipButton = this.createButton('跳过教学', false);
    skipButton.addEventListener('click', () => this.finish(true));

    buttons.appendChild(prevButton);
    buttons.appendChild(nextButton);
    buttons.appendChild(skipButton);

    card.appendChild(header);
    card.appendChild(icon);
    card.appendChild(title);
    card.appendChild(text);
    card.appendChild(buttons);
    overlay.appendChild(card);

    // 自建元素直接挂 body：不改 index.html，Engine 也不用管挂载点
    if (document.body) document.body.appendChild(overlay);
    else document.documentElement.appendChild(overlay);

    return { overlay, card, dots, stepText, icon, title, text, prevButton, nextButton, skipButton };
  }

  /** 造一个按钮：`primary` = 实心强调色，否则描边 */
  private createButton(label: string, primary: boolean): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    style(button, {
      flex: '1 1 0',
      // 44px：无障碍最小触控目标，手指才点得准
      minHeight: BUTTON_MIN_HEIGHT,
      padding: '0 8px',
      appearance: 'none',
      background: primary ? 'rgba(127, 208, 106, 0.18)' : 'transparent',
      color: primary ? COLOR_ACCENT : COLOR_TEXT_DIM,
      border: `1px solid ${primary ? COLOR_ACCENT : COLOR_CARD_BORDER}`,
      borderRadius: '10px',
      fontFamily: FONT_STACK,
      fontSize: '12.5px',
      lineHeight: '1.2',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    });
    return button;
  }
}
