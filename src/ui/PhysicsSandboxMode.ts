/**
 * 物理沙盘模式（补充 2）—— 一键把世界切成「随便玩物理」的状态。
 *
 * 为什么需要这个模式：正常规则是为"造东西"服务的 ——
 * 放置要校验支撑、建筑默认是静态的、水与沙一直在跑、笔刷随时会被误触。
 * 但当玩家想验证"这个拱桥结构到底会不会塌"的时候，这些规则全都在碍事。
 * 所以这里是**一组规则的打包开关**，而不是一个新的物理引擎。
 *
 * 三条设计原则（写清楚，免得以后当成 bug 改）：
 *
 * 1. **面板只算「应该发生什么」，不动世界**：真正改刚体、暂停模拟、关笔刷的是 Engine。
 *    本文件返回 `PhysicsSandboxEffect`（一份中文的效果清单），Engine 照着做。
 *    这样开关逻辑可以在 Node 里单测，"改世界"这件事只有一个地方发生。
 * 2. **诚实展示**：`#sandbox-effects` 逐条列出 Engine 会做的每一件事，
 *    包括**没做**的（例如"水与沙照常模拟"）。玩家点开关之前就该知道会发生什么，
 *    而不是点完发现建筑掉了才来问为什么。
 * 3. **总开关不进 localStorage，子选项进**：刷新页面直接掉进沙盘模式
 *    （东西全掉下来）是不可接受的意外；但"我习惯关掉引导提示"这种偏好应当记住。
 *
 * 存档兼容（问题 4 / 补充 7）：设置用 `snapshot()` 导出、`applySettings()` 恢复，
 * 形状都是 `PhysicsSandboxSettings`，跨平台（手机 / 桌面）一致。
 */

export interface PhysicsSandboxSettings {
  /** 沙盘模式是否开启 */
  enabled: boolean;
  /** 开启时是否自动把所有建筑转成动态刚体（会掉下来） */
  forceDynamic: boolean;
  /** 开启时是否自动开启调试可视化 */
  autoDebugDraw: boolean;
  /** 开启时是否暂停水/沙模拟（专心玩刚体） */
  pauseFluid: boolean;
  /** 开启时放置不再需要支撑（可以随便摆空中） */
  freePlacement: boolean;
  /** 显示一句引导提示 */
  showHint: boolean;
}

/**
 * 默认设置。默认值就是"最保守、最不破坏玩家成果"的那一档：
 * - `enabled: false` —— 模式当然默认关；
 * - `forceDynamic: false` —— 一开启就让所有建筑掉下来太暴力了，要玩家自己勾；
 * - `autoDebugDraw: true` —— 沙盘模式的意义就是"看得见物理"，这个默认开；
 * - `pauseFluid: false` —— 水与沙往往是玩家花时间摆的，不能悄悄停掉；
 * - `freePlacement: true` —— "可以摆在空中"正是沙盘模式的卖点；
 * - `showHint: true` —— 默认给一句引导，玩家自己会关。
 */
export const DEFAULT_SANDBOX_SETTINGS: PhysicsSandboxSettings = {
  enabled: false,
  forceDynamic: false,
  autoDebugDraw: true,
  pauseFluid: false,
  freePlacement: true,
  showHint: true,
};

export interface PhysicsSandboxHandlers {
  /** 模式开关变化 —— Engine 负责实际改世界 */
  onToggle(settings: PhysicsSandboxSettings): void;
  /** 某个子选项变化 */
  onSettingsChange(settings: PhysicsSandboxSettings): void;
}

/** 交给 Engine 的「进入/退出沙盘模式要做什么」清单（Engine 照着做） */
export interface PhysicsSandboxEffect {
  /** 关掉笔刷工具 */
  disableBrush: boolean;
  /** 打开关节/触发器/逻辑可视化 */
  enableDebugDraw: boolean;
  /** 暂停水与沙 */
  pauseFluid: boolean;
  /** 放置不再校验支撑 */
  freePlacement: boolean;
  /** 建议的提示文案（中文，Engine 直接 showToast） */
  hint: string;
}

/** 子选项键名（不含总开关）—— index.html 里 `data-sandbox` 的属性值必须逐字来自这里 */
export const PHYSICS_SANDBOX_OPTION_KEYS: readonly (keyof PhysicsSandboxSettings)[] = [
  'forceDynamic',
  'autoDebugDraw',
  'pauseFluid',
  'freePlacement',
  'showHint',
];

/** 子选项的中文名（HTML 里的 label 文案 + 告警信息都用它） */
export const PHYSICS_SANDBOX_OPTION_LABELS: Record<keyof PhysicsSandboxSettings, string> = {
  enabled: '沙盘模式总开关',
  forceDynamic: '建筑全部转成动态刚体（会掉下来）',
  autoDebugDraw: '自动打开调试可视化',
  pauseFluid: '暂停水与沙模拟',
  freePlacement: '放置不再需要支撑（可以摆在空中）',
  showHint: '显示引导提示',
};

/**
 * 子选项的持久化键名。带版本号：以后语义变了可以换 v2，老键自然失效。
 * ⚠ 只存子选项，**不存 `enabled`** —— 见文件头原则 3。
 */
export const SANDBOX_MODE_STORAGE_KEY = 'god-sandbox-physics-sandbox-v1';

/** 退出时的提示文案（`enabled: false` 时给 Engine 的 hint） */
const HINT_EXIT = '已退出物理沙盘模式：笔刷、放置校验、水与沙模拟都回到正常规则。';

/** 进入时的提示文案：把玩家勾了什么都念一遍 */
function buildEnableHint(settings: PhysicsSandboxSettings): string {
  const parts: string[] = ['笔刷已关闭'];
  if (settings.forceDynamic) parts.push('所有建筑已转为动态刚体（会掉下来）');
  if (settings.autoDebugDraw) parts.push('已打开关节 / 触发器 / 逻辑连线可视化');
  if (settings.pauseFluid) parts.push('水与沙模拟已暂停');
  if (settings.freePlacement) parts.push('放置不再需要支撑，可以摆在空中');
  return `物理沙盘模式已开启：${parts.join('、')}。随便玩，玩坏了用撤销找回来。`;
}

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

function isOptionKey(value: string | undefined): value is keyof PhysicsSandboxSettings {
  return value !== undefined && (PHYSICS_SANDBOX_OPTION_KEYS as readonly string[]).includes(value);
}

/** 只保留已知键 + 布尔值：存档被别人手改过时也不会把脏数据放进状态里 */
function sanitize(partial: Partial<PhysicsSandboxSettings>): Partial<PhysicsSandboxSettings> {
  const clean: Partial<PhysicsSandboxSettings> = {};
  if (typeof partial.enabled === 'boolean') clean.enabled = partial.enabled;
  if (typeof partial.forceDynamic === 'boolean') clean.forceDynamic = partial.forceDynamic;
  if (typeof partial.autoDebugDraw === 'boolean') clean.autoDebugDraw = partial.autoDebugDraw;
  if (typeof partial.pauseFluid === 'boolean') clean.pauseFluid = partial.pauseFluid;
  if (typeof partial.freePlacement === 'boolean') clean.freePlacement = partial.freePlacement;
  if (typeof partial.showHint === 'boolean') clean.showHint = partial.showHint;
  return clean;
}

/**
 * 由一个键名动态拼 patch（checkbox 的 `data-sandbox` 是运行时字符串）。
 * `{ [key]: value }` 这种计算属性写成对象字面量时 TS 推不出具体键，
 * 所以在这里收口一次断言 —— 键名已经过 `isOptionKey()` 校验，值是 `boolean`。
 */
function optionPatch<K extends keyof PhysicsSandboxSettings>(
  key: K,
  value: boolean,
): Partial<PhysicsSandboxSettings> {
  return { [key]: value } as Partial<PhysicsSandboxSettings>;
}

/**
 * 「物理沙盘模式」控制器 + 面板。
 *
 * ```ts
 * const sandbox = new PhysicsSandboxMode({
 *   onToggle: (settings) => engine.applySandboxEffect(sandbox.describeEffect()),
 *   onSettingsChange: (settings) => engine.savePrefs(settings),
 * });
 * // 存档恢复（问题 4）：把 enabled 一起传进来，Engine 才会收到 onToggle
 * sandbox.applySettings(saved.sandbox);
 * ```
 */
export class PhysicsSandboxMode {
  private readonly panel: HTMLElement;
  private readonly toggleInput: HTMLInputElement;
  private readonly optionsContainer: HTMLElement;
  private readonly optionInputs: HTMLInputElement[];
  private readonly statusCell: HTMLElement;
  private readonly effectsCell: HTMLElement;
  /** 设置的真源（对外一律给副本，见 settings / snapshot） */
  private readonly state: PhysicsSandboxSettings;
  private disposed = false;

  constructor(private readonly handlers: PhysicsSandboxHandlers) {
    this.panel = must<HTMLElement>('#sandbox-panel');
    this.toggleInput = must<HTMLInputElement>('#sandbox-toggle');
    this.optionsContainer = must<HTMLElement>('#sandbox-options');
    this.statusCell = must<HTMLElement>('#sandbox-status');
    this.effectsCell = must<HTMLElement>('#sandbox-effects');
    this.optionInputs = [
      ...this.optionsContainer.querySelectorAll<HTMLInputElement>('input[data-sandbox]'),
    ];
    this.state = { ...DEFAULT_SANDBOX_SETTINGS };

    // 先把上次会话的子选项捡回来（失败就当没存），再绑事件 ——
    // 顺序很重要：先恢复再绑定，可以少一次多余的 change 通知。
    this.restore();
    this.bind();
    this.syncControls();
    this.renderStatus();
    this.renderEffects(this.describeEffect());
  }

  // ---------------------------------------------------------------- 读写

  get settings(): PhysicsSandboxSettings {
    return { ...this.state };
  }

  get isEnabled(): boolean {
    return this.state.enabled;
  }

  /** 切换开关，返回 Engine 应该执行的效果清单 */
  toggle(): PhysicsSandboxEffect {
    return this.setEnabled(!this.state.enabled);
  }

  /**
   * 设置总开关，返回 Engine 应该执行的效果清单。
   *
   * 说明：**即使值没变也会通知 `onToggle`**。理由是"从存档恢复"这条路径 ——
   * 存档说 enabled=true、当前也恰好是 true 时如果静默跳过，Engine 就不会去改世界，
   * 于是面板显示"已开启"而世界还是正常规则。而重复执行同一份效果是幂等的
   * （关笔刷、开可视化、暂停模拟都可以重复执行），所以宁可多通知一次。
   */
  setEnabled(enabled: boolean): PhysicsSandboxEffect {
    this.state.enabled = enabled;
    this.persist();
    this.syncControls();
    const effect = this.describeEffect();
    this.renderStatus();
    this.renderEffects(effect);
    this.handlers.onToggle(this.settings);
    return effect;
  }

  /** 改动某个子选项（也可以带上 `enabled`，那会走 `onToggle` 通道） */
  patch(patch: Partial<PhysicsSandboxSettings>): void {
    const clean = sanitize(patch);
    if (Object.keys(clean).length === 0) return;
    Object.assign(this.state, clean);
    this.persist();
    this.syncControls();
    const effect = this.describeEffect();
    this.renderStatus();
    this.renderEffects(effect);
    if (typeof clean.enabled === 'boolean') this.handlers.onToggle(this.settings);
    else this.handlers.onSettingsChange(this.settings);
  }

  /**
   * 从存档恢复设置（问题 4 / 补充 7：设置要跨平台一致）。
   *
   * 存档里带了 `enabled` 就走 `onToggle`，让 Engine 把世界也改过来 ——
   * 否则会出现"面板已开启、世界还是正常规则"的不一致状态；
   * 只带子选项就走 `onSettingsChange`。脏数据（非布尔、不认识的键）一律忽略。
   */
  applySettings(settings: Partial<PhysicsSandboxSettings>): void {
    this.patch(settings);
  }

  /** 导出设置（存档用）—— 返回副本，调用方改它不会影响面板 */
  snapshot(): PhysicsSandboxSettings {
    return { ...this.state };
  }

  /** 计算当前设置对应的效果清单（不改变开关状态，只读） */
  describeEffect(): PhysicsSandboxEffect {
    const settings = this.state;
    if (!settings.enabled) {
      // 关掉时所有 effect 字段都是 false：Engine 拿到这份清单就是"什么都别做"。
      // hint 不受 showHint 影响 —— 退出这件事必须让玩家知道，否则他会以为笔刷坏了。
      return {
        disableBrush: false,
        enableDebugDraw: false,
        pauseFluid: false,
        freePlacement: false,
        hint: HINT_EXIT,
      };
    }
    return {
      disableBrush: true,
      enableDebugDraw: settings.autoDebugDraw,
      pauseFluid: settings.pauseFluid,
      freePlacement: settings.freePlacement,
      // 玩家把引导提示关了就不给文案：Engine 的写法是 showToast(effect.hint)，
      // 不能因为面板想"体贴"而违背这个设置。效果清单本身照旧逐条列出。
      hint: settings.showHint ? buildEnableHint(settings) : '',
    };
  }

  // ---------------------------------------------------------------- 绑定

  private bind(): void {
    this.toggleInput.addEventListener('change', this.onToggleChange);
    // 子选项走事件委托绑在容器上：index.html 以后加/减 checkbox 不用改这个文件
    this.optionsContainer.addEventListener('change', this.onOptionChange);
    this.auditOptions();
  }

  private readonly onToggleChange = (): void => {
    this.setEnabled(this.toggleInput.checked);
  };

  private readonly onOptionChange = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const key = input.dataset.sandbox;
    if (!isOptionKey(key)) {
      console.warn(`[沙盘模式] 未知的子选项 data-sandbox="${key ?? ''}"，已忽略`);
      return;
    }
    this.patch(optionPatch(key, input.checked));
  };

  /** 构造期体检：HTML 里的 data-sandbox 与接口键名不一致的话，在这里喊出来 */
  private auditOptions(): void {
    const seen = new Set<string>();
    for (const input of this.optionInputs) {
      const key = input.dataset.sandbox;
      if (!isOptionKey(key)) {
        console.warn(`[沙盘模式] #sandbox-options 里有未知的 data-sandbox="${key ?? ''}"`);
        continue;
      }
      seen.add(key);
    }
    for (const key of PHYSICS_SANDBOX_OPTION_KEYS) {
      if (seen.has(key)) continue;
      console.warn(
        `[沙盘模式] #sandbox-options 缺少 data-sandbox="${key}"（${PHYSICS_SANDBOX_OPTION_LABELS[key]}）`,
      );
    }
  }

  // ---------------------------------------------------------------- 渲染

  /** 把内部状态写回 DOM：总开关、子选项的勾选与禁用态 */
  private syncControls(): void {
    this.toggleInput.checked = this.state.enabled;
    this.panel.classList.toggle('sandbox-on', this.state.enabled);
    for (const input of this.optionInputs) {
      const key = input.dataset.sandbox;
      if (!isOptionKey(key)) continue;
      input.checked = this.state[key];
      // 模式没开时子选项没有任何作用，灰掉比"点了没反应"诚实
      input.disabled = !this.state.enabled;
    }
  }

  private renderStatus(): void {
    if (!this.state.enabled) {
      this.statusCell.textContent = '已关闭：世界按正常规则运行';
      return;
    }
    const on: string[] = ['笔刷已关闭'];
    if (this.state.forceDynamic) on.push('建筑为动态刚体');
    if (this.state.autoDebugDraw) on.push('调试可视化开着');
    if (this.state.pauseFluid) on.push('水与沙已暂停');
    if (this.state.freePlacement) on.push('放置免支撑');
    this.statusCell.textContent = `已开启：${on.join(' / ')}`;
  }

  /**
   * 效果清单：把 Engine 会做的每一件事用中文逐条列出来。
   *
   * 这一块刻意**把"没做的事"也写出来**（"水与沙照常模拟"）——
   * 玩家看到的必须是真相，而不是"看起来很多好处"的宣传语。
   */
  private renderEffects(effect: PhysicsSandboxEffect): void {
    const rows: { on: boolean; text: string }[] = this.state.enabled
      ? [
          { on: effect.disableBrush, text: '关掉笔刷工具' },
          { on: effect.enableDebugDraw, text: '打开关节 / 触发器 / 逻辑连线可视化' },
          { on: effect.pauseFluid, text: '暂停水与沙模拟' },
          { on: effect.freePlacement, text: '放置不再校验支撑（可以摆在空中）' },
          { on: this.state.forceDynamic, text: '把所有建筑转成动态刚体（会掉下来）' },
        ]
      : [
          { on: false, text: '笔刷工具保持可用' },
          { on: false, text: '调试可视化保持原样' },
          { on: false, text: '水与沙照常模拟' },
          { on: false, text: '放置仍然需要支撑' },
          { on: false, text: '建筑保持原来的静态 / 动态状态' },
        ];

    const items = rows.map(
      // `inline-label` 是这个项目里"一行说明文字"的既有写法（ResourcePanel 的 hint() 同款），
      // 关闭的那条加 `.dim` 变暗 —— 玩家一眼能分出"会做"和"不会做"
      (row) => `<p class="inline-label${row.on ? '' : ' dim'}">· ${row.text}</p>`,
    );
    if (!this.state.enabled) {
      items.unshift(
        '<p class="inline-label">物理沙盘模式已关闭：Engine 不会改动世界</p>',
      );
    }
    items.push(
      effect.hint
        ? `<p class="inline-label dim">提示：${effect.hint}</p>`
        : '<p class="inline-label dim">提示：已关闭（设置里关掉了引导提示）</p>',
    );
    this.effectsCell.innerHTML = items.join('');
  }

  // ---------------------------------------------------------------- 持久化

  /**
   * 只把子选项写进 localStorage（不写 `enabled`）。
   * 整个流程都在 try/catch 里：无痕模式 / 配额满 / 隐私设置禁用存储时，
   * `localStorage` 会直接抛异常 —— 那就当没存，绝不能因此让面板起不来。
   */
  private persist(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(SANDBOX_MODE_STORAGE_KEY, JSON.stringify(this.storedShape()));
    } catch {
      // 存不了就算了，本次会话照常用
    }
  }

  private restore(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(SANDBOX_MODE_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      // 只认子选项：老存档里万一带了 enabled 也故意丢掉（见文件头原则 3）
      const clean = sanitize(parsed as Partial<PhysicsSandboxSettings>);
      delete clean.enabled;
      Object.assign(this.state, clean);
    } catch {
      // 存档坏了就当没有，用默认值
    }
  }

  private storedShape(): Partial<PhysicsSandboxSettings> {
    const out: Partial<PhysicsSandboxSettings> = {};
    out.forceDynamic = this.state.forceDynamic;
    out.autoDebugDraw = this.state.autoDebugDraw;
    out.pauseFluid = this.state.pauseFluid;
    out.freePlacement = this.state.freePlacement;
    out.showHint = this.state.showHint;
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.toggleInput.removeEventListener('change', this.onToggleChange);
    this.optionsContainer.removeEventListener('change', this.onOptionChange);
    this.panel.classList.remove('sandbox-on');
  }
}
