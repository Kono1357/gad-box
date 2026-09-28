/**
 * 主题切换（深色 / 浅色 / 跟随系统）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么是「CSS 变量」而不是「直接改每个元素的颜色」
 * ────────────────────────────────────────────────────────────
 * 主题要改的是**几十个组件**的颜色，逐个元素去写 style 的话：
 * 每加一个新组件都得记得同步一次，漏一个是迟早的事，而且改完还得能撤回来。
 * 变量方案把这件事收敛成一处：`apply()` 只往 `document.documentElement` 上写 11 个变量，
 * 谁想跟随主题，谁在样式里引用 `var(--xxx)` 就行 —— 加组件不用再动这个文件。
 *
 * 变量名**刻意与 `src/style.css` 里 `:root` 已有的那套对齐**
 * （`--panel-bg` / `--panel-border` / `--text` / `--text-dim` / `--accent` / `--accent-2` / `--danger`）：
 * style.css 里已经有大量 `var(--accent)`、`var(--panel-bg)` 在用了，
 * 如果这里另起一套名字（比如只提供任务书要求的 `--panel`），那些地方就不会跟着变，
 * 切到浅色只会「一半白一半黑」。所以本文件同时给出：
 * - 任务书约定的短名：`--bg` / `--panel` / `--text` / `--text-dim` / `--accent` / `--border`
 * - style.css 已消费的别名：`--panel-bg` / `--panel-border` / `--accent-2` / `--danger` / `--shadow`
 * 两套名字在 dark / light 两张表里**键完全一致**（ui.check.ts 里有断言盯着这条）。
 *
 * ────────────────────────────────────────────────────────────
 * 颜色的对比度（不是拍脑袋调的）
 * ────────────────────────────────────────────────────────────
 * 用的是 WCAG 2.x 的相对亮度公式，算法照抄如下（gamma 展开后再加权求和）：
 *   通道 c（0~255）→ s = c/255；s ≤ 0.03928 时取 s/12.92，否则取 ((s+0.055)/1.055)^2.4
 *   相对亮度 L = 0.2126·R + 0.7152·G + 0.0722·B
 *   对比度 = (L亮 + 0.05) / (L暗 + 0.05)
 * 用这个公式算出的**实测值**（算完写在这里，不是引用的规范数字）：
 *
 *   深色档：正文 #d8e2ea / 背景 #0b0e11 = 14.73；正文 / 面板 #141a21 = 13.33
 *          次要文字 #8b9aa8 / 背景 = 6.71；/ 面板 = 6.07
 *          强调色 #7fd06a / 背景 = 10.26（强调色当按钮底色时，上面压深色字 #0b0e11 = 10.26）
 *   浅色档：正文 #16202a / 背景 #f2f4f7 = 14.96；正文 / 面板 #ffffff = 16.48
 *          次要文字 #55606d / 背景 = 5.81；/ 面板 = 6.40
 *          强调色 #2f7d22 / 背景 = 4.67（压白字 #ffffff = 5.15）
 *          次强调 #8a5200 / 背景 = 5.80
 *          危险色 #c0392b / 背景 = 4.94
 *
 * 两档的**正文与次要文字都 ≥ 4.5**（次要文字也没有为了"淡雅"而掉下去），
 * 强调色在浅色档是最紧的一项（4.67），所以浅色档没有更浅的绿色可选余地 ——
 * 再亮一档就会跌到 4 附近，链接/按钮文字就会糊。
 * **边框不在这个约束内**：边框只做分隔、不承担文字可读性，
 * 所以它只有 1.4~1.5（深 1.57 / 浅 1.39，对背景），这是明确的取舍 ——
 * 边框做到 3:1 会变成一圈抢眼的粗线，面板会显得很吵。
 *
 * ────────────────────────────────────────────────────────────
 * 降级
 * ────────────────────────────────────────────────────────────
 * 没有 `document`（Node 里跑断言）、没有 `matchMedia`（老浏览器 / 测试桩）、
 * 没有 `localStorage`（隐私模式 / 配额满 / 被策略禁掉）时**都不抛异常**：
 * - 没有 document → `apply()` 直接返回，模式仍然存在内存里，取值接口照常可用；
 * - 没有 matchMedia → `auto` 按深色解析（界面本来就是深色，比翻成半成品浅色强）；
 * - 没有 localStorage → 只在内存里记住本次会话的选择。
 *
 * 本文件不 import Three.js / Engine / 其它 UI：它只操作 DOM 与 localStorage，
 * 所以既能在浏览器里跑，也能在 Node 里 import 做断言。
 */

export type ThemeMode = 'dark' | 'light' | 'auto';

/** 解析后的实际主题：只有这两档。`auto` 是"输入方式"，不是一种主题 */
export type ResolvedTheme = 'dark' | 'light';

/**
 * 主题模式在 localStorage 里的键。
 *
 * 注意前缀是 `gad-box-`（本批次任务书指定的前缀），**不是**工程里既有数据用的
 * `god-sandbox-`（例如 `god-sandbox-content-packs-v1`）。这里不是笔误：
 * 前缀按任务书来，免得以后有人以为写错了去"修正"成 god-sandbox- 而把老玩家的设置读丢。
 */
export const THEME_STORAGE_KEY = 'gad-box-theme';

/** 系统深色偏好的媒体查询串。单独导出，断言里复用同一个字符串，避免两处写歪 */
export const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * 首次打开（localStorage 里没有记录）时用哪一档。
 *
 * 默认 `dark` 而**不是** `auto`，理由是当前这批颜色只覆盖了"引用变量的那部分组件"：
 * style.css 里还有一批写死的深色（`#topbar` 的渐变、`#toast`、`#main-menu` …），
 * 浅色档下它们仍是深底。老玩家一开页面就被系统偏好推到浅色、看到半深半白的界面，
 * 只会认为"更新把界面搞坏了"。等 style.css 整体迁到 `var()` 之后再把这个默认值改成 `auto`。
 */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark';

/**
 * 两套主题变量。dark / light 的**键集合必须一致**（缺一个键时另一档就会残留上一档的值）。
 *
 * 值的来源：
 * - dark 档与 style.css 现有 `:root` 的取值一致（`#0b0e11` / `--panel-bg` 的 rgba 等），
 *   这样"切主题"在默认档下不会让现有界面出现任何变化 —— 有变化就说明有别的地方被动了；
 * - light 档按上面注释里那份对比度表挑的色。
 */
export const THEME_VARS: Record<ResolvedTheme, Record<string, string>> = {
  dark: {
    // 页面底色 / 面板底色。面板比底色亮一点点（#141a21 vs #0b0e11），用来做层次
    '--bg': '#0b0e11',
    '--panel': '#141a21',
    // 半透明面板底（style.css 的 .panel 一直在用它）
    '--panel-bg': 'rgba(16, 20, 24, 0.88)',
    // 正文 / 次要文字
    '--text': '#d8e2ea',
    '--text-dim': '#8b9aa8',
    // 强调色（沙盘里的主色是绿色，工具高亮、进度条都用它）/ 次强调
    '--accent': '#7fd06a',
    '--accent-2': '#ffcc4d',
    // 分隔线
    '--border': '#2b3640',
    '--panel-border': '#2b3640',
    // 危险色（删除、警告）
    '--danger': '#ff6b5a',
    // 阴影：深色底上的阴影要更黑才看得出来
    '--shadow': 'rgba(0, 0, 0, 0.45)',
  },
  light: {
    // 浅色档不用纯白打底：纯白 + 纯黑字在户外强光下也够，但长时间看更累，
    // 而且面板（白）会和页面底（白）糊在一起，所以底色压到 #f2f4f7 留出层次
    '--bg': '#f2f4f7',
    '--panel': '#ffffff',
    '--panel-bg': 'rgba(255, 255, 255, 0.92)',
    '--text': '#16202a',
    '--text-dim': '#55606d',
    // 深绿：白底上 #7fd06a 的对比度只有 1.7 左右，字会糊，必须压暗（4.67，见表）
    '--accent': '#2f7d22',
    '--accent-2': '#8a5200',
    '--border': '#c9d2dc',
    '--panel-border': '#c9d2dc',
    '--danger': '#c0392b',
    // 浅色底的阴影要更淡，否则面板像贴了两层灰边
    '--shadow': 'rgba(15, 25, 35, 0.18)',
  },
};

/** 主题切换按钮的档位顺序（界面上的顺序 = 这里的顺序） */
const THEME_BUTTONS: readonly { mode: ThemeMode; label: string; hint: string }[] = [
  { mode: 'dark', label: '深色', hint: '始终使用深色主题' },
  { mode: 'light', label: '浅色', hint: '始终使用浅色主题' },
  { mode: 'auto', label: '跟随系统', hint: '跟随系统的深色 / 浅色偏好，系统切换时实时跟随' },
];

const THEME_STYLE_TAG_ID = 'gad-box-theme-style';

/**
 * 注入的样式表。
 *
 * 为什么不写进 style.css：本轮 style.css 由别的批次持有（并发编辑），
 * 所以主题自己的规则只能由本模块**注入一个 `<style>` 标签**。
 * 内容分三块：
 * 1. `:root[data-theme=...]` 两套变量 —— 与 `apply()` 的内联写入是**冗余的两道保险**：
 *    内联变量被别处清掉（比如某段代码整体替换了 `style` 属性）时，这里还能兜住；
 * 2. 浅色档下针对 style.css 里**写死的深色**做覆盖（逐条都注明了原位置）。
 *    这一块是过渡措施：等 style.css 整体迁到 `var()` 之后，整块删掉即可；
 * 3. 切换器自己的按钮样式（不能改 style.css，所以自带一份，且用变量取色）。
 */
const THEME_STYLE_TEXT = `
:root[data-theme='dark'] {
  --bg: ${THEME_VARS.dark['--bg']};
  --panel: ${THEME_VARS.dark['--panel']};
  --panel-bg: ${THEME_VARS.dark['--panel-bg']};
  --text: ${THEME_VARS.dark['--text']};
  --text-dim: ${THEME_VARS.dark['--text-dim']};
  --accent: ${THEME_VARS.dark['--accent']};
  --accent-2: ${THEME_VARS.dark['--accent-2']};
  --border: ${THEME_VARS.dark['--border']};
  --panel-border: ${THEME_VARS.dark['--panel-border']};
  --danger: ${THEME_VARS.dark['--danger']};
  --shadow: ${THEME_VARS.dark['--shadow']};
}
:root[data-theme='light'] {
  --bg: ${THEME_VARS.light['--bg']};
  --panel: ${THEME_VARS.light['--panel']};
  --panel-bg: ${THEME_VARS.light['--panel-bg']};
  --text: ${THEME_VARS.light['--text']};
  --text-dim: ${THEME_VARS.light['--text-dim']};
  --accent: ${THEME_VARS.light['--accent']};
  --accent-2: ${THEME_VARS.light['--accent-2']};
  --border: ${THEME_VARS.light['--border']};
  --panel-border: ${THEME_VARS.light['--panel-border']};
  --danger: ${THEME_VARS.light['--danger']};
  --shadow: ${THEME_VARS.light['--shadow']};
}
/* body 的底色在 style.css 里是写死的 #0b0e11（html,body 选择器），
   这里的选择器权重更高（多了 [data-theme] 属性），所以能盖住 —— 且只在浅色档生效 */
:root[data-theme='light'] body { background: var(--bg); color: var(--text); }
/* 以下对应 style.css 里写死深色的位置（行号按本批次读到的版本）：
   button:55 / input,select:88~93 / #topbar:124 / .detail-box:396 / #statusbar:541
   #toast:561 / #main-menu:587 / .menu-card:595 / .menu-hint:758 / #shortcut-help:1125
   .chip:966 / .slot-list li:1254 / #prefab-list img 之类:1013 */
:root[data-theme='light'] button { background: rgba(233, 238, 244, 0.95); color: var(--text); border-color: var(--border); }
:root[data-theme='light'] input, :root[data-theme='light'] select, :root[data-theme='light'] textarea {
  background: #ffffff; color: var(--text); border-color: var(--border);
}
:root[data-theme='light'] .panel, :root[data-theme='light'] #topbar, :root[data-theme='light'] #statusbar,
:root[data-theme='light'] #toast, :root[data-theme='light'] .menu-card, :root[data-theme='light'] .menu-hint,
:root[data-theme='light'] .detail-box, :root[data-theme='light'] .chip, :root[data-theme='light'] .slot-list li,
:root[data-theme='light'] #shortcut-help .shortcut-card {
  background: var(--panel-bg); color: var(--text);
}
:root[data-theme='light'] #topbar, :root[data-theme='light'] #statusbar,
:root[data-theme='light'] #brush-status, :root[data-theme='light'] #select-status { background: var(--bg); }
/* 遮罩层：深色档是"压暗画面"，浅色档要改成"压亮画面"，否则遮罩下面全黑 */
:root[data-theme='light'] #main-menu, :root[data-theme='light'] #shortcut-help { background: rgba(240, 244, 248, 0.86); }

/* 切换器自己 */
.gad-theme-switch { display: inline-flex; gap: 4px; align-items: center; }
.gad-theme-switch button {
  font: inherit; padding: 2px 8px; cursor: pointer;
  background: var(--panel-bg, rgba(16, 20, 24, 0.88));
  color: var(--text-dim, #8b9aa8);
  border: 1px solid var(--panel-border, #2b3640); border-radius: 4px;
}
.gad-theme-switch button[aria-pressed='true'] {
  color: var(--bg, #0b0e11); background: var(--accent, #7fd06a); border-color: var(--accent, #7fd06a);
}
`;

/** 判断字符串是否是合法档位（档位可能来自 localStorage，是玩家/其它版本写进去的任意字符串） */
function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light' || value === 'auto';
}

/**
 * 纯函数版的主题解析：`auto` 时看系统偏好。
 *
 * 单独导出是**为了能断言**（Node 里没有 matchMedia，只有把"系统偏好"当参数传进来才测得到）。
 */
export function resolveThemeMode(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'auto') return prefersDark ? 'dark' : 'light';
  return mode;
}

/** matchMedia 返回值里我们用得到的部分。手写成窄接口，测试里塞假对象不用满足整个 MediaQueryList */
export interface MediaQueryLike {
  matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
  /** Safari 14 之前只有这两个，留着做兜底 */
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
}

/** 取宿主上的 matchMedia（浏览器里在 window 上，测试里可以挂在 globalThis 上） */
function hostMatchMedia(query: string): MediaQueryLike | null {
  const host = globalThis as unknown as {
    window?: { matchMedia?: (q: string) => MediaQueryLike };
    matchMedia?: (q: string) => MediaQueryLike;
  };
  const asWindow = host.window;
  try {
    if (asWindow && typeof asWindow.matchMedia === 'function') return asWindow.matchMedia(query);
    if (typeof host.matchMedia === 'function') return host.matchMedia(query);
  } catch {
    // 某些环境的 matchMedia 会直接抛（老实现 + 非法查询串），当成"没有"处理
    return null;
  }
  return null;
}

/** 读 localStorage 里的档位；任何异常都当成"没存过" */
function readStoredMode(): ThemeMode | null {
  try {
    // 守卫必须写在 try **里面**：站点数据被禁用时，读 localStorage 这个属性本身就会抛
    // SecurityError（Chromium 有公开记录），而 `typeof` 只吞"未声明"、吞不掉 getter 抛的异常。
    // 这是兼容性审计 R1 的修法，别把它挪回 try 外面。
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 写档位。返回是否真的写进去了（写不进去时调用方仍保留内存里的模式，不抛） */
function writeStoredMode(mode: ThemeMode): boolean {
  try {
    // 同 readStoredMode：守卫要在 try 里面，属性访问本身就可能抛（R1）
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(THEME_STORAGE_KEY, mode);
    return true;
  } catch {
    // 隐私模式 / 配额满 / 被策略禁掉都会走到这里。静默降级：本次会话内主题照常工作
    return false;
  }
}

/** 只注入一次样式表。没有 document / head 时安静返回 */
function ensureThemeStyleTag(): void {
  if (typeof document === 'undefined') return;
  if (typeof document.getElementById !== 'function' || typeof document.createElement !== 'function') return;
  if (document.getElementById(THEME_STYLE_TAG_ID)) return;
  const head = document.head;
  if (!head || typeof head.appendChild !== 'function') return;
  const style = document.createElement('style');
  style.id = THEME_STYLE_TAG_ID;
  style.textContent = THEME_STYLE_TEXT;
  head.appendChild(style);
}

export interface ThemeSwitchOptions {
  /** 档位变化时回调（`resolved` 是解析后的实际主题）。auto 档下系统偏好变化时也会再派发一次 */
  onChange?: (mode: ThemeMode, resolved: ResolvedTheme) => void;
}

/**
 * 主题切换器。
 *
 * 用法：
 * ```ts
 * const theme = new ThemeSwitch(document.getElementById('theme-switch'), {
 *   onChange: (mode, resolved) => console.log(`主题：${mode} → ${resolved}`),
 * });
 * theme.mode;      // 'auto' / 'dark' / 'light'（原始档位）
 * theme.resolved;  // 实际生效的 'dark' / 'light'
 * theme.setMode('light');
 * theme.dispose();
 * ```
 *
 * 构造时就 `apply()` 一次：等到玩家手动点一次才生效的话，首帧会先按 CSS 默认色画一遍再跳变。
 */
export class ThemeSwitch {
  private readonly container: HTMLElement | null;
  private readonly onChange: ((mode: ThemeMode, resolved: ResolvedTheme) => void) | undefined;
  /** 按钮与它各自的点击回调成对保存：dispose 时要能**摘掉监听**，只把节点删掉是不够的 */
  private readonly buttons: { button: HTMLButtonElement; listener: () => void }[] = [];

  private currentMode: ThemeMode;
  private mediaQuery: MediaQueryLike | null = null;
  private mediaQueryBound = false;
  private disposed = false;

  constructor(buttonContainer: HTMLElement | null, options: ThemeSwitchOptions = {}) {
    this.container = buttonContainer;
    this.onChange = options.onChange;
    // localStorage 里存过就用存的；没有或读不出来就用默认档
    this.currentMode = readStoredMode() ?? DEFAULT_THEME_MODE;

    this.renderButtons();
    this.watchSystem();
    this.apply();
    this.syncButtons();
  }

  /** 当前档位（含 auto） */
  get mode(): ThemeMode {
    return this.currentMode;
  }

  /** 解析后的实际主题（auto 时看 prefers-color-scheme） */
  get resolved(): ResolvedTheme {
    return resolveThemeMode(this.currentMode, this.prefersDark());
  }

  /** 系统是否偏好深色。检测不到时按"是"处理（见文件头降级说明） */
  private prefersDark(): boolean {
    const query = this.ensureMediaQuery();
    if (!query) return true;
    return query.matches !== false;
  }

  /** 懒建 media query 并订阅变化（只订阅一次） */
  private ensureMediaQuery(): MediaQueryLike | null {
    if (this.mediaQuery) return this.mediaQuery;
    const query = hostMatchMedia(PREFERS_DARK_QUERY);
    if (!query) return null;
    this.mediaQuery = query;
    if (!this.mediaQueryBound) {
      this.mediaQueryBound = true;
      if (typeof query.addEventListener === 'function') query.addEventListener('change', this.handleSystemChange);
      else if (typeof query.addListener === 'function') query.addListener(this.handleSystemChange);
    }
    return query;
  }

  /**
   * 系统偏好变化。
   *
   * 只有 `auto` 档需要跟着变（固定档位下系统怎么变都不该影响玩家明确选定的主题）；
   * 但**监听本身一直挂着** —— 玩家随时可能切回 auto，那时不用重新订阅也不会有"漏掉的一次变化"。
   */
  private readonly handleSystemChange = (): void => {
    if (this.disposed) return;
    if (this.currentMode !== 'auto') return;
    this.apply();
    this.onChange?.(this.currentMode, this.resolved);
  };

  setMode(mode: ThemeMode): void {
    if (this.disposed) return;
    if (!isThemeMode(mode)) return; // 运行时传来的可能是任意字符串（存档 / URL 参数），挡在门口
    const changed = mode !== this.currentMode;
    this.currentMode = mode;
    writeStoredMode(mode);
    // 即使档位没变也重新 apply：系统偏好可能在两次调用之间变过
    this.apply();
    this.syncButtons();
    if (changed) this.onChange?.(mode, this.resolved);
  }

  /**
   * 把主题变量注入到 `document.documentElement`。
   *
   * 同时做三件事：
   * 1. 写 11 个 CSS 变量（内联，最高优先级）；
   * 2. 打 `data-theme` 属性 —— 注入的样式表和以后 style.css 里的 `[data-theme]` 选择器都认它；
   * 3. 设 `color-scheme` —— 让滚动条、原生下拉、日期选择器这些**浏览器自己画的控件**
   *    也跟着变，否则浅色档下会冒出一条黑色滚动条。
   */
  apply(): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (!root) return;

    ensureThemeStyleTag();

    const resolved = this.resolved;
    if (root.style && typeof root.style.setProperty === 'function') {
      const table = THEME_VARS[resolved];
      for (const name of Object.keys(table)) root.style.setProperty(name, table[name]);
      if ('colorScheme' in root.style) root.style.colorScheme = resolved;
    }
    if (root.dataset) root.dataset.theme = resolved;
  }

  /** 生成三个档位按钮。容器为 null（或没有 document）时**不生成任何节点**，但类照常可用 */
  private renderButtons(): void {
    const container = this.container;
    if (!container) return;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    if (!container.classList || !container.appendChild || !container.removeChild) return;

    container.classList.add('gad-theme-switch');
    // 清空容器：反复构造（热更新 / 重新初始化）时不该把按钮叠成两排
    while (container.firstChild) container.removeChild(container.firstChild);

    for (const def of THEME_BUTTONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = def.label;
      button.title = def.hint;
      button.setAttribute('aria-label', `主题：${def.label}`);
      button.setAttribute('aria-pressed', 'false');
      button.dataset.themeMode = def.mode;
      const listener = (): void => {
        this.setMode(def.mode);
      };
      button.addEventListener('click', listener);
      container.appendChild(button);
      this.buttons.push({ button, listener });
    }
  }

  /** 把 `aria-pressed` 同步到当前档位（视觉高亮由注入的样式表按 aria-pressed 取色） */
  private syncButtons(): void {
    if (this.buttons.length === 0) return;
    for (const entry of this.buttons) {
      const pressed = entry.button.dataset.themeMode === this.currentMode;
      entry.button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    }
  }

  /** 订阅系统偏好变化。容器为空时也要订阅 —— 模式仍然会随系统变，只是没有按钮可点 */
  private watchSystem(): void {
    this.ensureMediaQuery();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const query = this.mediaQuery;
    if (query) {
      if (typeof query.removeEventListener === 'function') query.removeEventListener('change', this.handleSystemChange);
      else if (typeof query.removeListener === 'function') query.removeListener(this.handleSystemChange);
    }
    this.mediaQuery = null;
    this.mediaQueryBound = false;
    for (const entry of this.buttons) {
      entry.button.removeEventListener('click', entry.listener);
      // 节点也摘掉：容器留着三个点不动的按钮会让人以为切换器还能用
      entry.button.remove?.();
    }
    this.buttons.length = 0;
  }
}
