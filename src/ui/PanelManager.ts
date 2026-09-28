/**
 * 面板管理：拖动 + 折叠 + 位置记忆。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么是"扫 DOM"而不是"每个面板各注册一次"
 * ────────────────────────────────────────────────────────────
 * 这个工程里的面板有二十来个（笔刷、建筑、物理、时间轴、压力、内容包…），
 * 而且还在陆续加。要让每个面板都记得"我要被拖动 / 我要被记住位置"，
 * 迟早会漏一个；漏了的表现是"这个面板拖不动"，玩家只能来问。
 *
 * 所以约定反过来：**面板只要带上 `data-panel` 就会被自动接管**，
 * 需要的话再自己提供三个可选钩子：
 * - `data-panel-handle`：自定义拖动手柄（不给就在面板顶部自动生成一条）；
 * - `data-panel-collapse`：自定义折叠按钮（不给就在手柄右端自动生成一个）；
 * - `data-panel-no-collapse`：**声明"折叠不归你管"**（见下面 PanelRecord.ownsCollapse 的说明）。
 *   工程里有一批面板的 `.collapsed` 是 Engine 按当前工具在控制的，
 *   那种面板加上这个属性，本模块就只管拖动与位置。
 * 新增面板不用改这个文件，这是它存在的全部意义。
 *
 * ────────────────────────────────────────────────────────────
 * 三个容易踩的坑，以及这里的做法
 * ────────────────────────────────────────────────────────────
 * 1. **手机上也要能拖** → 用 pointer 事件（不是 mouse），并给手柄 `touch-action: none`。
 *    只监听 mousedown 的话，手机上手指一拖就是滚页面，手柄完全没反应。
 * 2. **拖手柄不能误触面板里的按钮** → 手柄是**独立元素**（自带的那条或作者给的），
 *    而且 pointerdown 时会再挡一道：落点在 `button / input / select / textarea / a`
 *    或任何带 `data-no-drag` 的元素上就直接不进入拖动。
 *    按钮的点击还要靠"位移阈值"（4px）兜底：手指按住手柄微微一抖不该被当成拖动。
 * 3. **拖出屏幕就找不回来** → 位置在**拖动过程中每一帧都夹**（不是松手才夹），
 *    并且夹的规则是"左/上边距至少 margin、右/下不越界"，
 *    所以面板不可能被拖成看不见的状态。恢复记忆时同样要夹一次 ——
 *    玩家可能在 24 寸屏上把面板拖到右下角，第二天用手机打开（视口小得多），
 *    不夹的话那个面板就在屏幕外。
 *
 * ────────────────────────────────────────────────────────────
 * 存储
 * ────────────────────────────────────────────────────────────
 * key 是 `gad-box-panel-layout-v1`（`gad-box-` 前缀按本批次任务书；工程里既有的
 * 自定义物品 / 预制件用的是 `god-sandbox-` 前缀，两者并存不冲突，见 ThemeSwitch 里的同类说明）。
 * 存的内容是 `PanelState[]`：ids + 折叠状态 + 位置。
 * localStorage 读不到 / 写不进去（隐私模式、配额满、被策略禁用）时**全部降级为"本次会话内有效"**，
 * 不抛异常、不影响拖动本身。
 *
 * 本文件不 import Three.js / Engine：只碰 DOM 与存储，Node 里也能构造（attach(null)）。
 */

export interface PanelState {
  id: string;
  collapsed: boolean;
  /** 视口坐标（px）。null = 还没被拖过，位置交给 CSS */
  x: number | null;
  y: number | null;
}

/**
 * 存储接口（只要这三件事）。
 *
 * 手写窄接口而不是直接用 `Storage`：断言里塞一个 Map 实现的假存储就能测持久化，
 * 不用去装全局 localStorage，也不会污染别的断言。
 */
export interface PanelStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** 布局存储键（`gad-box-` 前缀） */
export const PANEL_LAYOUT_STORAGE_KEY = 'gad-box-panel-layout-v1';

/** 面板与视口边缘至少留多少像素。8px 是"看得出来贴边了，但又不像浮在半空"的距离 */
export const PANEL_EDGE_MARGIN = 8;

/**
 * 拖动阈值（px）：位移没超过它就不算拖动。
 * 手指按在手柄上会抖 1~3px，没有阈值的话"想点一下手柄"会把面板挪一小格。
 */
export const PANEL_DRAG_THRESHOLD = 4;

/** 取不到真实视口时的兜底尺寸（只有测试桩 / 极端环境会走到） */
export const DEFAULT_VIEWPORT = { width: 1024, height: 768 } as const;

/** 自动生成的手柄 / 折叠按钮的类名（样式内联，不去碰 style.css） */
const HANDLE_CLASS = 'gad-panel-handle';
const COLLAPSE_CLASS = 'gad-panel-collapse';

/** 视口里"点这些不算拖动"的元素 */
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, a, [data-no-drag]';

export interface PanelClampInput {
  x: number;
  y: number;
  /** 面板尺寸；未知时传 0 */
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  /** 与视口边缘的最小距离 */
  margin: number;
}

/**
 * 把位置夹回可视范围（纯函数，断言直接喂人造数据）。
 *
 * 规则：`margin ≤ x ≤ max(margin, 视口宽 - 面板宽 - margin)`。
 * - 面板比视口还大 → 上界退回 `margin`，也就是贴左上角。
 *   比"允许拖出去一半"更好：超大面板出界后玩家同样找不回来，而贴角至少还能操作；
 * - `x` 是 NaN / Infinity 时一律回 `margin`：这两种值写进 `style.left` 会让元素**直接消失**
 *   （浏览器把非法值丢掉，元素回到 auto 位置），比夹紧糟糕得多。
 */
export function clampPanelPosition(input: PanelClampInput): { x: number; y: number } {
  const margin = Number.isFinite(input.margin) ? Math.max(0, input.margin) : 0;

  const clampAxis = (value: number, size: number, viewport: number): number => {
    if (!Number.isFinite(value)) return margin;
    const safeSize = Number.isFinite(size) && size > 0 ? size : 0;
    const safeViewport = Number.isFinite(viewport) && viewport > 0 ? viewport : 0;
    // 视口取不到（0）时只保证"不小于 margin"，不做右/下边界的猜测
    const maxValue = safeViewport > 0 ? Math.max(margin, safeViewport - safeSize - margin) : Number.POSITIVE_INFINITY;
    return Math.min(Math.max(value, margin), maxValue);
  };

  return { x: clampAxis(input.x, input.width, input.viewportWidth), y: clampAxis(input.y, input.height, input.viewportHeight) };
}

/** 当前视口尺寸；量不到就退 DEFAULT_VIEWPORT */
function readViewportSize(): { width: number; height: number } {
  if (typeof document !== 'undefined' && document.documentElement) {
    const root = document.documentElement;
    const width = typeof root.clientWidth === 'number' ? root.clientWidth : 0;
    const height = typeof root.clientHeight === 'number' ? root.clientHeight : 0;
    if (width > 0 && height > 0) return { width, height };
  }
  const host = globalThis as unknown as { innerWidth?: number; innerHeight?: number };
  if (typeof host.innerWidth === 'number' && host.innerWidth > 0 && typeof host.innerHeight === 'number' && host.innerHeight > 0) {
    return { width: host.innerWidth, height: host.innerHeight as number };
  }
  return { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height };
}

/** 元素尺寸（拖动时用来算边界）。量不到就当 0，夹紧上界会因此更宽松但仍不会跑出屏幕 */
function readElementSize(el: HTMLElement): { width: number; height: number } {
  if (typeof el.getBoundingClientRect === 'function') {
    const rect = el.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) return { width: rect.width, height: rect.height };
  }
  return { width: el.offsetWidth ?? 0, height: el.offsetHeight ?? 0 };
}

/** 位置来源：优先用 rect（视口坐标），量不到时退回内联 left/top */
function readElementPosition(el: HTMLElement): { x: number; y: number } {
  if (typeof el.getBoundingClientRect === 'function') {
    const rect = el.getBoundingClientRect();
    if (rect) return { x: rect.left, y: rect.top };
  }
  const left = Number.parseFloat(el.style.left);
  const top = Number.parseFloat(el.style.top);
  return { x: Number.isFinite(left) ? left : 0, y: Number.isFinite(top) ? top : 0 };
}

export interface PanelManagerOptions {
  /**
   * 存储实现。三种取值：
   * - 不传 → 用全局 localStorage（拿不到就降级为不持久化）；
   * - 传对象 → 用它（断言里塞 Map 假存储）；
   * - 传 `null` → 明确表示"不要持久化"。
   */
  storage?: PanelStorageLike | null;
  /** 存储键，默认 PANEL_LAYOUT_STORAGE_KEY */
  storageKey?: string;
  /** 与视口边缘的最小距离，默认 PANEL_EDGE_MARGIN */
  margin?: number;
  /**
   * 读 / 写存储失败、或跳过某个节点时的中文提示。
   * 不传就只在 console 里留一条 warn —— 这些情况都不该打断游戏，但必须留痕。
   */
  onNotice?: (message: string) => void;
}

/**
 * 单个面板的内部记录。
 *
 * `ownsCollapse`：折叠状态归不归我们管。
 * 工程里有一批面板的折叠是**工具切换**在控制的（Engine 的 `setTool()` 会按当前工具
 * 给 `#brush-panel` / `#building-panel` 之类加 `.collapsed`）。如果我们也去记它、恢复它，
 * 玩家切一次工具，面板就会被从"记忆里的折叠状态"和"工具要求的状态"来回拽，
 * 表现是"面板自己乱开合"。所以这类面板用 `data-panel-no-collapse` opt-out：
 * 我们只管拖动与位置，折叠状态**只观测不写**。
 */
interface PanelRecord {
  id: string;
  el: HTMLElement;
  handle: HTMLElement;
  collapseButton: HTMLElement | null;
  /** 折叠状态是否由本模块接管（false = 由工具切换等外部逻辑控制） */
  ownsCollapse: boolean;
  /** 自动生成、dispose 时要摘掉的节点（作者自己提供的节点不动） */
  created: HTMLElement[];
  session: DragSession | null;
}

/** 一次拖动过程的状态 */
interface DragSession {
  pointerId: number;
  originX: number;
  originY: number;
  startLeft: number;
  startTop: number;
  width: number;
  height: number;
  moved: boolean;
}

/**
 * 每个 record 的监听记账表。
 *
 * 放在模块级的 WeakMap 而不是 record 的字段里：PanelRecord 是"接管的现场记录"，
 * 监听引用只服务于 attach/detach 这一对操作，塞进 record 只会让状态对象变脏。
 * 声明在类**之前**：类的静态初始化不会用它，但"先声明后使用"读起来不会让人担心暂时性死区。
 */
const recordListeners = new WeakMap<
  PanelRecord,
  { el: HTMLElement; type: string; listener: (event: Event) => void }[]
>();

/** 建节点失败（没有 document / createElement）时安静返回 null，让调用方走兜底分支 */
function safeCreate(factory: () => HTMLElement): HTMLElement | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  try {
    return factory();
  } catch {
    return null;
  }
}

/**
 * 面板管理器。
 *
 * 用法：
 * ```ts
 * const panels = new PanelManager();
 * panels.attach(document.getElementById('app'));  // 扫 [data-panel]
 * panels.states;            // 当前状态快照（副本）
 * panels.resetPositions();  // 把位置恢复成 CSS 里的默认摆放（折叠状态保留）
 * panels.dispose();
 * ```
 */
export class PanelManager {
  private readonly storageKey: string;
  private readonly margin: number;
  private readonly onNotice: ((message: string) => void) | undefined;
  private storage: PanelStorageLike | null;

  private readonly records: PanelRecord[] = [];
  /** 内存里的状态：即使存储不可用，拖动 / 折叠在本次会话里也照常生效 */
  private readonly stateById = new Map<string, PanelState>();
  private disposed = false;

  constructor(options: PanelManagerOptions = {}) {
    this.storageKey = options.storageKey ?? PANEL_LAYOUT_STORAGE_KEY;
    this.margin = Number.isFinite(options.margin) ? Math.max(0, options.margin as number) : PANEL_EDGE_MARGIN;
    this.onNotice = options.onNotice;
    this.storage = resolveStorage(options.storage);
  }

  /** 当前所有被接管面板的状态（**副本**：外部拿到的数组改不动内部记录） */
  get states(): readonly PanelState[] {
    return this.records.map((record) => this.snapshot(record));
  }

  /** 某个面板的状态快照。opt-out 面板的 collapsed 现读现取（它由外部逻辑控制） */
  private snapshot(record: PanelRecord): PanelState {
    const state = this.readState(record.id);
    if (record.ownsCollapse) return { ...state };
    const live = record.el.classList ? record.el.classList.contains('collapsed') : false;
    return { ...state, collapsed: live };
  }

  /** 某个面板的状态（没被接管时返回一个默认状态，不抛） */
  getState(id: string): PanelState {
    return { ...this.readState(id) };
  }

  /**
   * 扫描并接管。
   *
   * 可重复调用：内部先把上一批摘干净再接新的（面板会被别的系统整块替换掉，
   * 比如换工具时重建侧栏），所以重复 attach 不该留下重复的监听。
   */
  attach(root: ParentNode | null): void {
    if (this.disposed) return;
    this.detachAll();
    if (!root || typeof root.querySelectorAll !== 'function') return;

    const stored = this.readStored();
    let elements: Element[];
    try {
      elements = Array.from(root.querySelectorAll('[data-panel]'));
    } catch {
      return;
    }

    const viewport = readViewportSize();
    for (const element of elements) {
      const el = element as HTMLElement;
      // 鸭子类型判一下：拿到的可能不是元素（SVG、文档片段），缺这些成员就跳过
      if (!el.style || typeof el.addEventListener !== 'function' || !el.dataset) continue;

      const id = el.id || el.dataset.panel || '';
      if (!id) {
        this.report('有个 [data-panel] 元素既没有 id 也没有 data-panel 值，已跳过（位置记忆需要一个稳定的名字）');
        continue;
      }
      if (this.records.some((record) => record.id === id)) {
        this.report(`面板 id「${id}」重复，后面那个已跳过（id 是位置记忆的键，必须唯一）`);
        continue;
      }

      const record = this.install(id, el);
      this.records.push(record);

      // 状态来源：存储里优先，其次沿用上一批的内存状态（重复 attach 时不至于丢折叠状态）
      const saved = stored.get(id) ?? this.stateById.get(id);
      const state: PanelState = {
        id,
        // opt-out 面板不认存储里的折叠状态（那个值不是我们写的，也不是我们能决定的）
        collapsed: record.ownsCollapse && saved?.collapsed === true,
        x: typeof saved?.x === 'number' && Number.isFinite(saved.x) ? saved.x : null,
        y: typeof saved?.y === 'number' && Number.isFinite(saved.y) ? saved.y : null,
      };
      this.stateById.set(id, state);

      if (record.ownsCollapse) this.applyCollapsed(record, state.collapsed);
      if (state.x !== null && state.y !== null) {
        // 先确保定位方式：static 元素上的 left/top **完全没有效果**，
        // 少了这一句，刷新之后记忆的位置就"读出来了但没生效"
        ensurePositionMode(el);
        // 恢复记忆时也要夹一次：换设备 / 转屏后视口可能比当初小得多，不夹就跑到屏幕外了
        const size = readElementSize(el);
        const clamped = clampPanelPosition({
          x: state.x,
          y: state.y,
          width: size.width,
          height: size.height,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          margin: this.margin,
        });
        this.setPosition(record, clamped.x, clamped.y);
        this.stateById.set(id, { ...state, x: clamped.x, y: clamped.y });
      }
    }
  }

  /** 把所有面板的位置恢复成"没被拖过"（交给 CSS 摆放）。**折叠状态保留** */
  resetPositions(): void {
    if (this.disposed) return;
    for (const record of this.records) {
      const state = this.readState(record.id);
      if (record.el.style && typeof record.el.style.removeProperty === 'function') {
        record.el.style.removeProperty('left');
        record.el.style.removeProperty('top');
      } else if (record.el.style) {
        record.el.style.left = '';
        record.el.style.top = '';
      }
      this.stateById.set(record.id, { ...state, x: null, y: null });
    }
    // 位置置空之后要落盘，否则刷新一次旧坐标又回来了
    this.persist();
  }

  /** 折叠 / 展开某个面板（作者自己接线时也能用） */
  toggleCollapsed(id: string): void {
    if (this.disposed) return;
    const record = this.records.find((item) => item.id === id);
    if (!record) return;
    if (!record.ownsCollapse) {
      this.report(`面板「${id}」标了 data-panel-no-collapse，它的开合由工具切换控制，这里不改（只管拖动）`);
      return;
    }
    const state = this.readState(id);
    const collapsed = !state.collapsed;
    this.stateById.set(id, { ...state, collapsed });
    this.applyCollapsed(record, collapsed);
    this.persist();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachAll();
    this.stateById.clear();
  }

  // ---------------------------------------------------------------- 内部：接管

  /** 给一个面板装上手柄与折叠按钮，并挂上拖动监听 */
  private install(id: string, el: HTMLElement): PanelRecord {
    const created: HTMLElement[] = [];
    let handle = el.querySelector<HTMLElement>('[data-panel-handle]');
    if (!handle) {
      handle = safeCreate(createHandle);
      if (handle) {
        created.push(handle);
        // 插到最前面：手柄必须在面板顶部，插到末尾的话它会跑到内容下面，拖不到
        if (typeof el.insertBefore === 'function' && el.firstChild) el.insertBefore(handle, el.firstChild);
        else if (typeof el.appendChild === 'function') el.appendChild(handle);
      } else {
        // 连节点都建不出来（没有 document 的极端环境）：退化成"整块面板当手柄"。
        // 会误触按钮的风险由 pointerdown 的 INTERACTIVE_SELECTOR 那道判断挡住。
        // 注意 el 不进 created —— 它不是我们建的，dispose 时不能摘。
        handle = el;
      }
    }

    // 折叠：opt-out 的面板连按钮都不给 —— 给一个按了不管用的按钮比没有按钮更糟
    const ownsCollapse = typeof el.hasAttribute === 'function' ? !el.hasAttribute('data-panel-no-collapse') : true;
    let collapseButton: HTMLElement | null = null;
    if (ownsCollapse) {
      collapseButton = el.querySelector<HTMLElement>('[data-panel-collapse]');
      if (!collapseButton) {
        const made = safeCreate(createCollapseButton);
        if (made) {
          collapseButton = made;
          created.push(made);
          if (typeof handle.appendChild === 'function') handle.appendChild(made);
        }
      }
    }

    const record: PanelRecord = { id, el, handle, collapseButton, ownsCollapse, created, session: null };

    const onPointerDown = (event: Event): void => this.handlePointerDown(record, event as PointerEvent);
    const onPointerMove = (event: Event): void => this.handlePointerMove(record, event as PointerEvent);
    const onPointerUp = (event: Event): void => this.handlePointerEnd(record, event as PointerEvent);
    const onCollapseClick = (event: Event): void => {
      // 折叠按钮在手柄里面：不挡一道的话，点它同时会被当成"开始拖动"
      event.stopPropagation();
      this.toggleCollapsed(id);
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);
    // 记账的监听挂在 record 上（dispose 时按同样的引用摘掉）
    const listeners: { el: HTMLElement; type: string; listener: (event: Event) => void }[] = [
      { el: handle, type: 'pointerdown', listener: onPointerDown },
      { el: handle, type: 'pointermove', listener: onPointerMove },
      { el: handle, type: 'pointerup', listener: onPointerUp },
      { el: handle, type: 'pointercancel', listener: onPointerUp },
    ];
    if (collapseButton) {
      collapseButton.addEventListener('click', onCollapseClick);
      listeners.push({ el: collapseButton, type: 'click', listener: onCollapseClick });
    }
    recordListeners.set(record, listeners);

    return record;
  }

  private handlePointerDown(record: PanelRecord, event: PointerEvent): void {
    if (this.disposed) return;
    if (event.button !== undefined && event.button !== 0) return; // 鼠标只认左键（中键留给相机旋转）

    const target = event.target as Element | null;
    if (target && typeof target.closest === 'function' && target.closest(INTERACTIVE_SELECTOR)) return;

    const el = record.el;
    ensurePositionMode(el);

    const size = readElementSize(el);
    const at = readElementPosition(el);
    record.session = {
      pointerId: event.pointerId ?? 0,
      originX: event.clientX ?? 0,
      originY: event.clientY ?? 0,
      startLeft: at.x,
      startTop: at.y,
      width: size.width,
      height: size.height,
      moved: false,
    };

    // 指针捕获：手指移出面板范围后依然收得到 move/up，否则拖快了会"半路断掉"
    if (typeof record.handle.setPointerCapture === 'function' && event.pointerId !== undefined) {
      try {
        record.handle.setPointerCapture(event.pointerId);
      } catch {
        // 某些实现（或指针已经抬起）会抛，忽略即可：拖动仍然可用，只是没有捕获
      }
    }
  }

  private handlePointerMove(record: PanelRecord, event: PointerEvent): void {
    const session = record.session;
    if (!session) return;
    const dx = (event.clientX ?? 0) - session.originX;
    const dy = (event.clientY ?? 0) - session.originY;

    if (!session.moved) {
      if (Math.abs(dx) < PANEL_DRAG_THRESHOLD && Math.abs(dy) < PANEL_DRAG_THRESHOLD) return;
      session.moved = true;
    }

    // 触摸环境下防止拖动时顺手把页面滚了（手柄上的 touch-action: none 是第一道，这里是第二道）
    if (typeof event.preventDefault === 'function') event.preventDefault();

    const viewport = readViewportSize();
    // 拖动过程中**每一帧都夹**：等到松手才夹的话，玩家会看到面板跟着手指跑出屏幕再跳回来
    const clamped = clampPanelPosition({
      x: session.startLeft + dx,
      y: session.startTop + dy,
      width: session.width,
      height: session.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      margin: this.margin,
    });
    this.setPosition(record, clamped.x, clamped.y);
  }

  private handlePointerEnd(record: PanelRecord, event: PointerEvent): void {
    const session = record.session;
    if (!session) return;
    record.session = null;
    if (typeof record.handle.releasePointerCapture === 'function' && event.pointerId !== undefined) {
      try {
        record.handle.releasePointerCapture(event.pointerId);
      } catch {
        // 没捕获过就会抛，忽略
      }
    }
    // 只是点了一下手柄（没超过阈值）：不落盘，位置也没变
    if (!session.moved) return;
    this.persist();
  }

  private setPosition(record: PanelRecord, x: number, y: number): void {
    record.el.style.left = `${Math.round(x)}px`;
    record.el.style.top = `${Math.round(y)}px`;
    const state = this.readState(record.id);
    this.stateById.set(record.id, { ...state, x: Math.round(x), y: Math.round(y) });
  }

  private applyCollapsed(record: PanelRecord, collapsed: boolean): void {
    if (record.el.classList && typeof record.el.classList.toggle === 'function') {
      record.el.classList.toggle('collapsed', collapsed);
    }
    const button = record.collapseButton;
    if (button) {
      button.textContent = collapsed ? '▸' : '▾';
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      button.setAttribute('aria-label', collapsed ? '展开面板' : '折叠面板');
      button.title = collapsed ? '展开' : '折叠';
    }
  }

  /** 摘掉所有记录（重复 attach / dispose 都走这里） */
  private detachAll(): void {
    for (const record of this.records) {
      const listeners = recordListeners.get(record) ?? [];
      for (const entry of listeners) entry.el.removeEventListener(entry.type, entry.listener);
      recordListeners.delete(record);
      // 只摘自己生成的节点：作者写在 HTML 里的手柄 / 按钮是人家的结构，不能动
      for (const node of record.created) {
        if (typeof node.remove === 'function') node.remove();
      }
      record.created.length = 0;
      record.session = null;
    }
    this.records.length = 0;
  }

  // ---------------------------------------------------------------- 内部：状态与存储

  private readState(id: string): PanelState {
    const existing = this.stateById.get(id);
    if (existing) return existing;
    // 没接管过的 id：给一个"没有任何自定义"的默认状态，读接口就不会返回 undefined
    return { id, collapsed: false, x: null, y: null };
  }

  /** 读存储。整份数据坏了就当空的（面板回到 CSS 默认位置，比抛异常好） */
  private readStored(): Map<string, PanelState> {
    const result = new Map<string, PanelState>();
    const storage = this.storage;
    if (!storage) return result;
    let raw: string | null = null;
    try {
      raw = storage.getItem(this.storageKey);
    } catch {
      this.report('布局存档读不出来（localStorage 被禁用？），已按默认位置摆放面板');
      return result;
    }
    if (!raw) return result;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.report('布局存档不是合法的 JSON，已忽略（下次拖动会重新写入）');
      return result;
    }
    if (!Array.isArray(parsed)) return result;

    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Partial<PanelState>;
      if (typeof record.id !== 'string' || record.id === '') continue;
      result.set(record.id, {
        id: record.id,
        collapsed: record.collapsed === true,
        x: typeof record.x === 'number' && Number.isFinite(record.x) ? record.x : null,
        y: typeof record.y === 'number' && Number.isFinite(record.y) ? record.y : null,
      });
    }
    return result;
  }

  /** 落盘。写不进去（配额满 / 隐私模式）只提示，不影响本次会话里已经生效的位置 */
  private persist(): void {
    const storage = this.storage;
    if (!storage) return;
    const payload: PanelState[] = this.records.map((record) => this.snapshot(record));
    try {
      storage.setItem(this.storageKey, JSON.stringify(payload));
    } catch {
      this.report('布局存不进去了（存储配额满或被禁用），本次会话内的位置仍然有效');
    }
  }

  private report(message: string): void {
    if (this.onNotice) {
      this.onNotice(message);
      return;
    }
    if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(`[PanelManager] ${message}`);
  }
}

/** 存储解析：见 PanelManagerOptions.storage 的说明 */
function resolveStorage(injected: PanelStorageLike | null | undefined): PanelStorageLike | null {
  if (injected === null) return null;
  if (injected) return injected;
  try {
    // 守卫在 try 里面：隐私模式/禁用站点数据时，**访问** localStorage 本身就可能抛
    // SecurityError，`typeof` 挡不住它（兼容性审计 R1）
    if (typeof localStorage === 'undefined') return null;
    // 探一次：读写方法同样可能抛（配额、策略）
    localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY);
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * 确保面板是 fixed 定位。
 *
 * 拖动与位置恢复都需要它，理由：
 * - `static`（CSS 默认）的元素设 left / top **没有任何效果**，玩家会觉得"手柄点了没反应"；
 * - `absolute` 是相对最近的定位祖先，而我们的坐标全部来自 `getBoundingClientRect()`
 *   （视口坐标），两者原点不同，直接用会整体偏一个父容器左上角的距离；
 * - `fixed` 以视口为原点，正好与 rect / 夹紧算法是同一套坐标。
 * 已经处理过的面板再调用是空操作（读到 fixed 就返回），所以重复 attach 不会反复写内联样式。
 */
function ensurePositionMode(el: HTMLElement): void {
  if (readPositionMode(el) === 'fixed') return;
  el.style.position = 'fixed';
}

/** 面板当前的定位方式；没有 getComputedStyle（测试桩）时看内联值 */
function readPositionMode(el: HTMLElement): string {
  const inline = el.style?.position ?? '';
  if (typeof getComputedStyle === 'function') {
    try {
      const computed = getComputedStyle(el).position;
      if (computed) return computed;
    } catch {
      // 元素不在文档里时某些实现会抛，退回内联值
    }
  }
  return inline;
}

/** 自动生成的手柄：一条实心横条，手机上够粗才按得准 */
function createHandle(): HTMLElement {
  const handle = document.createElement('div');
  handle.className = HANDLE_CLASS;
  handle.setAttribute('data-panel-handle', '');
  Object.assign(handle.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '6px',
    height: '18px',
    padding: '0 6px',
    cursor: 'move',
    background: 'var(--panel-bg, rgba(16, 20, 24, 0.88))',
    borderBottom: '1px solid var(--panel-border, #2b3640)',
    // 手机上必须显式关掉浏览器的手势接管，否则手指一拖就变成滚页面，pointermove 直接断
    touchAction: 'none',
    userSelect: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  return handle;
}

/** 自动生成的折叠按钮 */
function createCollapseButton(): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = COLLAPSE_CLASS;
  button.setAttribute('data-panel-collapse', '');
  button.textContent = '▾';
  button.setAttribute('aria-expanded', 'true');
  Object.assign(button.style, {
    minWidth: '22px',
    lineHeight: '16px',
    padding: '0 4px',
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--text-dim, #8b9aa8)',
    border: '1px solid var(--panel-border, #2b3640)',
    borderRadius: '3px',
    touchAction: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  return button;
}
