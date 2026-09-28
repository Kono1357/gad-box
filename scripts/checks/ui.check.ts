/**
 * M5 第 2 批（主题切换 / 快捷键面板 / 面板管理）的断言。
 *
 * 跑法（含可运行的入口）：
 *   npx esbuild scripts/checks/ui.run.ts --bundle --format=esm --platform=node \
 *     --outfile=.verify/ui.mjs && node .verify/ui.mjs
 *
 * 这份断言写成 `runUiChecks(check)` 而不是自带 console/process.exit：
 * 既能被单独跑（ui.run.ts），也能被主验证脚本收进去共用同一个计数。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么这里手搓了一套假 DOM
 * ────────────────────────────────────────────────────────────
 * 这三个模块的**逻辑**（键位规范化、冲突检测、边界夹紧、状态持久化）全都不依赖真实渲染，
 * 但它们都从 DOM 拿东西。本轮不许加依赖（没有 jsdom），所以这里手搓了最小实现：
 * FakeElement / FakeStyle / makeFakeDocument / makeFakeMatchMedia / makeFakeStorage。
 * 目的不是"模拟浏览器"，而是**把这三段逻辑拉到光下**：
 * 拖到 -10000 会不会被夹回来、换小屏后记忆的位置会不会跑到屏幕外、
 * localStorage 抛异常时会不会连带把拖动搞崩 —— 这些以前只能靠手点碰运气。
 *
 * ────────────────────────────────────────────────────────────
 * 覆盖范围里**没有**的东西（别误以为测过了）
 * ────────────────────────────────────────────────────────────
 * - **真机上的拖拽手感**：指针捕获、`touch-action: none`、手指抖动阈值这些
 *   只有真触摸设备才说得准，Node 里造不出来，本文件测的是"位移 → 夹紧 → 落盘"这条链；
 * - 面板的**渲染结果**（长什么样、会不会盖住别的东西）：没有 CSS 引擎，测不了；
 * - 快捷键面板的**捕获态交互**（点 kbd → 按键 → 落盘）走的是浏览器事件，
 *   这里测的是它调用的那层 `setBinding()`（同一个函数，UI 只是入口）；
 * - `?` / F1 的开合：需要 window 上有真实的 keydown 派发与节点渲染，同样没测。
 */

import {
  DEFAULT_THEME_MODE,
  PREFERS_DARK_QUERY,
  THEME_STORAGE_KEY,
  THEME_VARS,
  ThemeSwitch,
  resolveThemeMode,
  type MediaQueryLike,
} from '../../src/ui/ThemeSwitch';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_GROUPS,
  SHORTCUT_STORAGE_KEY,
  ShortcutPanel,
  detectConflicts,
  displayKeySpec,
  isHoldSpec,
  keySpecFromEvent,
  normalizeKeySpec,
} from '../../src/ui/ShortcutPanel';
import {
  PANEL_EDGE_MARGIN,
  PANEL_LAYOUT_STORAGE_KEY,
  PanelManager,
  clampPanelPosition,
  type PanelStorageLike,
} from '../../src/ui/PanelManager';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

// ============================================================ 假环境（桩）

/** 可被装到 globalThis 上的那几个名字 */
type GlobalSlot = 'document' | 'window' | 'localStorage';

function setGlobal(name: GlobalSlot, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** 卸掉桩。每个小节开始时都调一次，避免小节之间互相污染（这是本工程踩过的坑） */
function clearGlobals(): void {
  const bag = globalThis as unknown as Record<string, unknown>;
  for (const name of ['document', 'window', 'localStorage'] as const) {
    try {
      delete bag[name];
    } catch {
      // 删不掉也不能影响后续断言：桩是 configurable 的，正常都删得掉
    }
  }
}

/** 假的 MediaQueryList：能改 matches、能手打 change 事件、能数订阅者 */
interface FakeMatchMedia extends MediaQueryLike {
  setMatches(value: boolean): void;
  emitChange(): void;
  listenerCount(): number;
}

function makeFakeMatchMedia(initialMatches: boolean): FakeMatchMedia {
  const listeners = new Set<() => void>();
  const media: FakeMatchMedia = {
    matches: initialMatches,
    setMatches(value: boolean): void {
      media.matches = value;
    },
    emitChange(): void {
      for (const listener of [...listeners]) listener();
    },
    listenerCount(): number {
      return listeners.size;
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return media;
}

/** 假的 Map 存储（键值对语义与 localStorage 一致） */
interface FakeStorage extends PanelStorageLike {
  dump(): Record<string, string>;
}

function makeFakeStorage(seed: Record<string, string> = {}): FakeStorage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

/** 每个方法都抛的存储：模拟隐私模式 / 配额满 / 被策略禁用 */
function makeThrowingStorage(): PanelStorageLike {
  const boom = (): never => {
    throw new Error('localStorage 被禁用了（测试桩）');
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

/** 假的 CSSStyleDeclaration：既要支持 setProperty/removeProperty，也要支持 el.style.left = '12px' */
class FakeStyle {
  private readonly props = new Map<string, string>();
  colorScheme = '';

  get position(): string {
    return this.props.get('position') ?? '';
  }
  set position(value: string) {
    this.props.set('position', value);
  }
  get left(): string {
    return this.props.get('left') ?? '';
  }
  set left(value: string) {
    this.props.set('left', value);
  }
  get top(): string {
    return this.props.get('top') ?? '';
  }
  set top(value: string) {
    this.props.set('top', value);
  }
  get display(): string {
    return this.props.get('display') ?? '';
  }
  set display(value: string) {
    this.props.set('display', value);
  }

  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
  removeProperty(name: string): void {
    this.props.delete(name);
  }
  get(name: string): string {
    return this.props.get(name) ?? '';
  }
}

interface FakeEventInit {
  target?: FakeElement;
  clientX?: number;
  clientY?: number;
  button?: number;
  pointerId?: number;
}

interface FakeEvent {
  type: string;
  target: FakeElement;
  clientX?: number;
  clientY?: number;
  button?: number;
  pointerId?: number;
  preventDefault(): void;
  stopPropagation(): void;
}

/** 最小元素实现：够 PanelManager / ThemeSwitch 用就行 */
class FakeElement {
  readonly tagName: string;
  id = '';
  className = '';
  textContent = '';
  type = '';
  title = '';
  placeholder = '';
  value = '';
  dataset: Record<string, string> = {};
  style = new FakeStyle();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  rect = { left: 0, top: 0, width: 0, height: 0 };
  offsetWidth = 0;
  offsetHeight = 0;
  clientWidth = 0;
  clientHeight = 0;
  isContentEditable = false;

  private readonly attrs = new Map<string, string>();
  private readonly classes = new Set<string>();
  private readonly listeners = new Map<string, ((event: FakeEvent) => void)[]>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get classList(): { add(c: string): void; remove(c: string): void; toggle(c: string, force?: boolean): void; contains(c: string): boolean } {
    const classes = this.classes;
    return {
      add: (name: string) => {
        classes.add(name);
      },
      remove: (name: string) => {
        classes.delete(name);
      },
      toggle: (name: string, force?: boolean) => {
        const next = force === undefined ? !classes.has(name) : force;
        if (next) classes.add(name);
        else classes.delete(name);
      },
      contains: (name: string) => classes.has(name),
    };
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child: FakeElement, reference: FakeElement | null): FakeElement {
    if (!reference) return this.appendChild(child);
    const index = this.children.indexOf(reference);
    if (index < 0) return this.appendChild(child);
    child.parent = this;
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
  }

  remove(): void {
    this.parent?.removeChild(this);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    if (this.attrs.has(name)) return this.attrs.get(name) as string;
    if (name.startsWith('data-')) {
      const key = datasetKey(name);
      if (key in this.dataset) return this.dataset[key];
    }
    return null;
  }

  hasAttribute(name: string): boolean {
    if (this.attrs.has(name)) return true;
    if (name.startsWith('data-')) return datasetKey(name) in this.dataset;
    return false;
  }

  matches(selector: string): boolean {
    const token = selector.trim();
    if (token === '*') return true;
    const attr = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(token);
    if (attr) {
      if (!this.hasAttribute(attr[1])) return false;
      return attr[2] === undefined || this.getAttribute(attr[1]) === attr[2];
    }
    return this.tagName === token.toUpperCase();
  }

  closest(selector: string): FakeElement | null {
    const tokens = selector.split(',').map((part) => part.trim());
    let node: FakeElement | null = this;
    while (node) {
      if (tokens.some((token) => node !== null && node.matches(token))) return node;
      node = node.parent;
    }
    return null;
  }

  private descendants(out: FakeElement[]): FakeElement[] {
    for (const child of this.children) {
      out.push(child);
      child.descendants(out);
    }
    return out;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const tokens = selector.split(',').map((part) => part.trim());
    return this.descendants([]).filter((el) => tokens.some((token) => el.matches(token)));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.rect;
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const list = this.listeners.get(type);
    if (list) list.push(listener);
    else this.listeners.set(type, [listener]);
  }

  removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  /** 手打事件：直接调本节点的监听（不做冒泡 —— 我们要的就是"target 不在手柄上"这种情形） */
  dispatch(type: string, init: FakeEventInit = {}): void {
    const event: FakeEvent = {
      type,
      target: init.target ?? this,
      clientX: init.clientX,
      clientY: init.clientY,
      button: init.button,
      pointerId: init.pointerId,
      preventDefault: () => {},
      stopPropagation: () => {},
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  setPointerCapture(): void {
    // 真实浏览器里会把后续 move/up 都送回来；假实现里不需要，只要不抛
  }

  releasePointerCapture(): void {
    // 同上
  }
}

/** `data-panel-handle` → `panelHandle`（DOMStringMap 的命名规则） */
function datasetKey(attribute: string): string {
  return attribute
    .slice(5)
    .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

interface FakeDocument {
  createElement(tag: string): FakeElement;
  getElementById(id: string): FakeElement | null;
  documentElement: FakeElement;
  head: FakeElement;
  body: FakeElement;
  activeElement: FakeElement | null;
}

function makeFakeDocument(viewport: { width: number; height: number } = { width: 1024, height: 768 }): FakeDocument {
  const documentElement = new FakeElement('html');
  documentElement.clientWidth = viewport.width;
  documentElement.clientHeight = viewport.height;
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const doc: FakeDocument = {
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: (id: string) => documentElement.descendants([]).find((el) => el.id === id) ?? null,
    documentElement,
    head,
    body,
    activeElement: null,
  };
  return doc;
}

/** 造一个带 [data-panel] 的面板元素（id + 视口坐标尺寸） */
function makeFakePanel(id: string, rect: { left: number; top: number; width: number; height: number }): FakeElement {
  const el = new FakeElement('aside');
  el.id = id;
  el.dataset.panel = id;
  el.rect = { ...rect };
  return el;
}

// ============================================================ 主题

function runThemeChecks(check: CheckFn): void {
  clearGlobals();

  // ---- 常量表 ----
  const darkKeys = Object.keys(THEME_VARS.dark).sort();
  const lightKeys = Object.keys(THEME_VARS.light).sort();
  check(
    '主题变量：dark / light 两套键集合完全一致（不一致会残留上一档的值）',
    darkKeys.join(',') === lightKeys.join(','),
    `dark ${darkKeys.length} 个键 / light ${lightKeys.length} 个键`,
  );
  check('主题变量：两套都非空', darkKeys.length > 0 && lightKeys.length > 0, `共 ${darkKeys.length} 个变量`);
  const requiredVars = ['--bg', '--panel', '--text', '--text-dim', '--accent', '--border'];
  const missingVars = requiredVars.filter((name) => !(name in THEME_VARS.dark) || !(name in THEME_VARS.light));
  check('主题变量：任务书点名的 6 个变量两套都有', missingVars.length === 0, missingVars.length ? `缺 ${missingVars.join(' ')}` : requiredVars.join(' '));
  const blankVars = [...Object.entries(THEME_VARS.dark), ...Object.entries(THEME_VARS.light)].filter(
    ([, value]) => typeof value !== 'string' || value.trim() === '',
  );
  check('主题变量：没有空值', blankVars.length === 0, blankVars.map(([name]) => name).join(' '));
  check('主题存储键：用 gad-box- 前缀', THEME_STORAGE_KEY.startsWith('gad-box-'), THEME_STORAGE_KEY);

  // ---- 纯函数解析 ----
  check(
    '主题解析：固定档位不受系统偏好影响',
    resolveThemeMode('dark', false) === 'dark' && resolveThemeMode('light', true) === 'light',
  );
  check('主题解析：auto + 系统深色 → dark', resolveThemeMode('auto', true) === 'dark');
  check('主题解析：auto + 系统浅色 → light', resolveThemeMode('auto', false) === 'light');

  // ---- 没有任何宿主环境 ----
  const bare = new ThemeSwitch(null);
  check('降级：无 document / 无 matchMedia 时构造不抛，档位为默认值', bare.mode === DEFAULT_THEME_MODE, `mode=${bare.mode}`);
  check('降级：探测不到系统偏好时 auto 解析成深色（不把界面翻成半成品浅色）', resolveThemeMode('auto', true) === 'dark' && bare.mode === 'dark');
  let bareThrew = false;
  try {
    bare.apply();
    bare.setMode('light');
    bare.dispose();
    bare.setMode('dark');
  } catch {
    bareThrew = true;
  }
  check('降级：无 document 时 apply / setMode / dispose 都不抛', !bareThrew);
  check('降级：dispose 之后 setMode 被忽略（不会再有回调）', bare.mode === 'light', `dispose 后仍是 ${bare.mode}`);

  // ---- 三档切换 ----
  const modes: ThemeSwitch = new ThemeSwitch(null);
  const seen: string[] = [];
  modes.setMode('light');
  const afterLight = modes.mode === 'light' && modes.resolved === 'light';
  modes.setMode('dark');
  const afterDark = modes.mode === 'dark' && modes.resolved === 'dark';
  modes.setMode('auto');
  const afterAuto = modes.mode === 'auto' && modes.resolved === 'dark';
  check('三档切换：light / dark / auto 都生效且 resolved 正确', afterLight && afterDark && afterAuto);
  check('三档切换：onChange 只有在档位真的变了才派发（这里没传回调，只验证不抛）', seen.length === 0);
  modes.dispose();

  // ---- localStorage 持久化与降级 ----
  const store = makeFakeStorage();
  setGlobal('localStorage', store as unknown as Storage);
  const stored = new ThemeSwitch(null);
  stored.setMode('light');
  check('存储：选定的档位写进 localStorage', store.getItem(THEME_STORAGE_KEY) === 'light', String(store.getItem(THEME_STORAGE_KEY)));
  const reloaded = new ThemeSwitch(null);
  check('存储：重新构造时读回上次的档位', reloaded.mode === 'light', `mode=${reloaded.mode}`);
  reloaded.dispose();
  stored.dispose();

  setGlobal('localStorage', makeFakeStorage({ [THEME_STORAGE_KEY]: 'neon（别的版本写进去的垃圾）' }));
  const junkStored = new ThemeSwitch(null);
  check('存储：读到认不出的档位时回落默认档，不抛', junkStored.mode === DEFAULT_THEME_MODE, `mode=${junkStored.mode}`);
  junkStored.dispose();

  setGlobal('localStorage', makeThrowingStorage());
  let throwingThrew = false;
  const resilient = new ThemeSwitch(null);
  try {
    resilient.setMode('light');
  } catch {
    throwingThrew = true;
  }
  check('降级：localStorage 全程抛异常时构造与切档都不抛', !throwingThrew);
  check('降级：写不进存储时档位仍在内存里生效', resilient.mode === 'light' && resilient.resolved === 'light');
  resilient.dispose();
  clearGlobals();

  // ---- auto 跟随系统（注入假 matchMedia）----
  const media = makeFakeMatchMedia(true);
  const queries: string[] = [];
  const events: string[] = [];
  setGlobal('window', {
    matchMedia: (query: string) => {
      queries.push(query);
      return media;
    },
  });
  const following = new ThemeSwitch(null, {
    onChange: (mode, resolved) => {
      events.push(`${mode}:${resolved}`);
    },
  });
  following.setMode('auto');
  check('auto 跟随：查询串用的是 prefers-color-scheme: dark', queries[0] === PREFERS_DARK_QUERY, queries[0]);
  check('auto 跟随：系统深色时 resolved = dark', following.resolved === 'dark');
  check('auto 跟随：系统变化监听只订阅一次', media.listenerCount() === 1, `${media.listenerCount()} 个订阅者`);

  media.setMatches(false);
  media.emitChange();
  check('auto 跟随：系统切到浅色时 resolved 立刻变成 light', following.resolved === 'light', `resolved=${following.resolved}`);
  check('auto 跟随：系统变化也派发 onChange（mode 仍是 auto）', events[events.length - 1] === 'auto:light', events.join(' → '));

  following.setMode('dark');
  const eventCount = events.length;
  media.setMatches(true);
  media.emitChange();
  check('固定档位：系统偏好变化不影响玩家选定的主题', following.resolved === 'dark', `resolved=${following.resolved}`);
  check('固定档位：系统偏好变化不派发 onChange', events.length === eventCount);

  following.dispose();
  check('dispose：摘掉 matchMedia 的 change 监听（不留悬挂引用）', media.listenerCount() === 0, `${media.listenerCount()} 个订阅者`);

  // ---- 注入 CSS 变量（假 document）----
  const doc = makeFakeDocument();
  setGlobal('document', doc);
  const themed = new ThemeSwitch(null);
  themed.setMode('light');
  const lightNames = Object.keys(THEME_VARS.light);
  const injectedLight = lightNames.filter((name) => doc.documentElement.style.get(name) === THEME_VARS.light[name]);
  check(
    'apply()：浅色档把全部变量写进 documentElement',
    injectedLight.length === lightNames.length,
    `写进去 ${injectedLight.length} / ${lightNames.length} 个`,
  );
  check('apply()：给 documentElement 打上 data-theme 属性', doc.documentElement.dataset.theme === 'light', `data-theme=${doc.documentElement.dataset.theme}`);
  check('apply()：设置了 color-scheme（滚动条等原生控件跟着变）', doc.documentElement.style.colorScheme === 'light');
  themed.setMode('dark');
  const injectedDark = lightNames.filter((name) => doc.documentElement.style.get(name) === THEME_VARS.dark[name]);
  check(
    'apply()：切回深色时同一批变量被整体覆盖（没有残留浅色值）',
    injectedDark.length === lightNames.length,
    `覆盖 ${injectedDark.length} / ${lightNames.length} 个`,
  );
  const styleTags = doc.head.children.filter((el) => el.id === 'gad-box-theme-style');
  check('apply()：主题样式表只注入一次（重复 apply 不会叠出多个 <style>）', styleTags.length === 1, `找到 ${styleTags.length} 个`);
  themed.dispose();
  clearGlobals();

  // ---- onChange 契约 ----
  const notified: string[] = [];
  const notifier = new ThemeSwitch(null, {
    onChange: (mode, resolved) => {
      notified.push(`${mode}:${resolved}`);
    },
  });
  notifier.setMode('light');
  notifier.setMode('light');
  notifier.setMode('auto');
  check(
    'onChange 契约：档位真的变了才回调（重复设置同一档不回调）',
    notified.join(' / ') === 'light:light / auto:dark',
    notified.join(' / '),
  );
  notifier.dispose();
}

// ============================================================ 快捷键

function runShortcutChecks(check: CheckFn): void {
  clearGlobals();

  // ---- 默认表 ----
  const ids = DEFAULT_SHORTCUTS.map((def) => def.id);
  check('默认表：id 无重复', new Set(ids).size === ids.length, `共 ${ids.length} 条`);
  const groupNames = new Set(DEFAULT_SHORTCUTS.map((def) => def.group));
  const missingGroups = SHORTCUT_GROUPS.filter((name) => !groupNames.has(name));
  check('默认表：任务书要求的 5 个分组都有', missingGroups.length === 0, SHORTCUT_GROUPS.join(' / '));
  const thinGroups = SHORTCUT_GROUPS.filter((name) => DEFAULT_SHORTCUTS.filter((def) => def.group === name).length < 4);
  check('默认表：每组至少 4 条', thinGroups.length === 0, thinGroups.length ? `太薄：${thinGroups.join(' ')}` : '每组 4 条以上');
  const nonCanonical = DEFAULT_SHORTCUTS.filter((def) => normalizeKeySpec(def.defaultKeys) !== def.defaultKeys);
  check(
    '默认表：键位都是规范形式（能原样规范化回去）',
    nonCanonical.length === 0,
    nonCanonical.map((def) => `${def.id}=${def.defaultKeys}`).join(' '),
  );

  const defaults: Record<string, string> = {};
  for (const def of DEFAULT_SHORTCUTS) defaults[def.id] = def.defaultKeys;
  const defaultConflicts = detectConflicts(defaults);
  const defaultErrors = defaultConflicts.filter((item) => item.severity === 'error');
  check('默认表：同一个键没有被绑给两个动作（无 error 级冲突）', defaultErrors.length === 0, defaultErrors.map((item) => item.message).join('；'));
  const expectedWarns = Object.values(defaults).filter((spec) => spec.startsWith('Shift+')).length;
  const defaultWarns = defaultConflicts.filter((item) => item.severity === 'warn');
  check(
    '默认表：修饰键前缀重叠（Shift 与 Shift+X）只报 warn 不报 error',
    defaultWarns.length === expectedWarns,
    `实际 ${defaultWarns.length} 条 / 期望 ${expectedWarns} 条（按住型 Shift 与 ${expectedWarns} 个 Shift+ 组合）`,
  );

  // ---- 按键 → 规范串 ----
  const ev = (code: string, ctrlKey = false, shiftKey = false, altKey = false) => ({ code, ctrlKey, shiftKey, altKey });
  check('按键映射：Ctrl+Z', keySpecFromEvent(ev('KeyZ', true)) === 'Ctrl+Z', String(keySpecFromEvent(ev('KeyZ', true))));
  check('按键映射：Ctrl+Shift+Z（修饰键顺序固定）', keySpecFromEvent(ev('KeyZ', true, true)) === 'Ctrl+Shift+Z');
  check('按键映射：Shift+Tab', keySpecFromEvent(ev('Tab', false, true)) === 'Shift+Tab');
  check('按键映射：Alt+1', keySpecFromEvent(ev('Digit1', false, false, true)) === 'Alt+1');
  check('按键映射：无修饰键只给主键', keySpecFromEvent(ev('KeyP')) === 'P');
  check('按键映射：? 键（Shift+Slash）→ Shift+/', keySpecFromEvent(ev('Slash', false, true)) === 'Shift+/');
  check('按键映射：方向键与功能键用 code 原名', keySpecFromEvent(ev('ArrowLeft')) === 'ArrowLeft' && keySpecFromEvent(ev('F2')) === 'F2');
  check('按键映射：` 与 [ ] , . 这些符号键认得出来', keySpecFromEvent(ev('Backquote')) === '`' && keySpecFromEvent(ev('BracketLeft')) === '[' && keySpecFromEvent(ev('Period')) === '.');
  check('按键映射：按下修饰键本身只返回它自己（按住 Shift 加速要能绑）', keySpecFromEvent(ev('ShiftLeft', false, true)) === 'Shift');
  check('按键映射：认不出的键返回 null（不把垃圾存进存储）', keySpecFromEvent(ev('LaunchMail')) === null);

  check('按键解析：容错 "ctrl + z" 这种写法', normalizeKeySpec('ctrl + z') === 'Ctrl+Z', String(normalizeKeySpec('ctrl + z')));
  check('按键解析：修饰键的书写顺序不影响结果', normalizeKeySpec('z+ctrl') === 'Ctrl+Z');
  check('按键解析：? 展开成 Shift+/', normalizeKeySpec('?') === 'Shift+/');
  check('按键解析：中文别名（空格 / 回车 / 方向）', normalizeKeySpec('空格') === 'Space' && normalizeKeySpec('回车') === 'Enter' && normalizeKeySpec('上') === 'ArrowUp');
  check('按键解析：拒绝认不出的键与空串', normalizeKeySpec('Foo') === null && normalizeKeySpec('') === null && normalizeKeySpec('   ') === null);
  check('按键解析：拒绝一个绑定里塞两个主键', normalizeKeySpec('A+B') === null);
  check('按键解析：拒绝两个修饰键的组合（Ctrl+Shift 不是键位）', normalizeKeySpec('Ctrl+Shift') === null);
  check('按键显示：Shift+/ 显示成 ?', displayKeySpec('Shift+/') === '?', displayKeySpec('Shift+/'));
  check('按键显示：方向键显示成箭头、空格显示成中文', displayKeySpec('ArrowLeft') === '←' && displayKeySpec('Space') === '空格');
  check('按住型判定：Shift 是按住型，Shift+Tab 不是', isHoldSpec('Shift') && !isHoldSpec('Shift+Tab'));

  // ---- 面板逻辑（无 DOM）----
  const panel = new ShortcutPanel(null);
  check(
    '面板：container = null 时构造不抛，绑定表等于默认表',
    Object.keys(panel.bindings).length === DEFAULT_SHORTCUTS.length && panel.bindings['undo'] === 'Ctrl+Z',
    `${Object.keys(panel.bindings).length} 条绑定`,
  );
  check('match()：Ctrl+Z 命中 undo', panel.match(ev('KeyZ', true)) === 'undo');
  check('match()：Ctrl+Shift+Z 命中 redo-alt（不是 undo）', panel.match(ev('KeyZ', true, true)) === 'redo-alt');
  check('match()：单键 P 命中暂停', panel.match(ev('KeyP')) === 'pause');
  check('match()：没绑过的组合返回 null', panel.match(ev('KeyZ', false, false, true)) === null && panel.match(ev('LaunchMail')) === null);

  const typingDoc = makeFakeDocument();
  setGlobal('document', typingDoc);
  typingDoc.activeElement = typingDoc.createElement('input');
  check('match()：焦点在输入框里时一律返回 null（打字不该触发快捷键）', panel.match(ev('KeyP')) === null);
  typingDoc.activeElement = typingDoc.createElement('textarea');
  check('match()：焦点在多行文本框里同样返回 null', panel.match(ev('KeyP')) === null);
  const focusedDiv = typingDoc.createElement('div');
  typingDoc.activeElement = focusedDiv;
  check('match()：焦点不在输入框时照常匹配', panel.match(ev('KeyP')) === 'pause');

  // ---- 改键与冲突 ----
  const conflictResult = panel.setBinding('undo', 'G');
  check('改键：撞到别人的键时被拒绝', conflictResult.ok === false, conflictResult.reason ?? '（没有原因，说明被静默覆盖了）');
  check('改键：拒绝原因里点明占用者的中文名', (conflictResult.reason ?? '').includes('吸附'), conflictResult.reason);
  check('改键：被拒绝后原绑定一个字节都没变', panel.bindings['undo'] === 'Ctrl+Z');
  const unknownId = panel.setBinding('no-such-action', 'Y');
  check('改键：不存在的动作 id 被拒绝并说明原因', unknownId.ok === false && typeof unknownId.reason === 'string', unknownId.reason);
  const badKeys = panel.setBinding('undo', 'Foo');
  check('改键：认不出的键位被拒绝并说明原因', badKeys.ok === false && typeof badKeys.reason === 'string', badKeys.reason);
  const changed = panel.setBinding('snap-anchors', 'Ctrl+U');
  check('改键：换成没人占用的键成功', changed.ok === true);
  check('改键：成功后 match() 认新键', panel.match(ev('KeyU', true)) === 'snap-anchors');
  check('改键：成功后旧键不再命中（不会两边都响）', panel.match(ev('KeyG')) === null);
  check('改键：改成自己原本的键不算冲突', panel.setBinding('undo', 'Ctrl+Z').ok === true);

  const conflicted = { ...defaults, undo: 'G', 'snap-anchors': 'G' };
  const handMade = detectConflicts(conflicted).filter((item) => item.severity === 'error');
  check('冲突扫描：人造冲突（同一个键两个动作）必须报出来', handMade.length === 1, handMade.map((item) => item.message).join('；'));
  check(
    '冲突扫描：消息里两个动作的中文名都在（能看懂是谁占了谁）',
    (handMade[0]?.message ?? '').includes('撤销') && (handMade[0]?.message ?? '').includes('吸附'),
    handMade[0]?.message,
  );

  // ---- 存储 ----
  const store = makeFakeStorage();
  setGlobal('localStorage', store as unknown as Storage);
  const persisted = new ShortcutPanel(null);
  persisted.setBinding('pause', 'Ctrl+Alt+P');
  const raw = store.getItem(SHORTCUT_STORAGE_KEY);
  check('存储：改键后写进 localStorage', typeof raw === 'string' && raw.includes('Ctrl+Alt+P'), raw ?? 'null');
  const reloaded = new ShortcutPanel(null);
  check(
    '存储：重新构造时读回自定义键位（match 也认）',
    reloaded.bindings['pause'] === 'Ctrl+Alt+P' && reloaded.match(ev('KeyP', true, false, true)) === 'pause',
  );
  reloaded.resetAll();
  const allDefault = Object.keys(reloaded.bindings).every((id) => reloaded.bindings[id] === defaults[id]);
  check('恢复默认：绑定表整体回到默认', allDefault && reloaded.bindings['pause'] === 'P');
  check('恢复默认：存储项被清掉（以后默认表改了玩家跟得上）', store.getItem(SHORTCUT_STORAGE_KEY) === null);
  check('恢复默认：清空后再改键仍然可用', reloaded.setBinding('pause', 'Ctrl+Alt+P').ok === true);

  setGlobal('localStorage', makeFakeStorage({ [SHORTCUT_STORAGE_KEY]: JSON.stringify({ undo: 'G', 'snap-anchors': 'G' }) }));
  const storedConflict = new ShortcutPanel(null);
  const storedErrors = storedConflict.conflicts().filter((item) => item.severity === 'error');
  check('冲突扫描：存储里自带的人造冲突会被面板报出来（不静默）', storedErrors.length === 1, storedErrors.map((item) => item.message).join('；'));

  setGlobal('localStorage', makeFakeStorage({ [SHORTCUT_STORAGE_KEY]: '{这不是 JSON' }));
  let junkThrew = false;
  let junkPanel: ShortcutPanel | null = null;
  try {
    junkPanel = new ShortcutPanel(null);
  } catch {
    junkThrew = true;
  }
  check('降级：存储里是坏 JSON 时不抛，按默认表走', !junkThrew && junkPanel?.bindings['undo'] === 'Ctrl+Z');

  setGlobal('localStorage', makeFakeStorage({ [SHORTCUT_STORAGE_KEY]: JSON.stringify({ 'ghost-id': 'X', undo: 'Foo', pause: 'Ctrl+Alt+P' }) }));
  const sanitized = new ShortcutPanel(null);
  check(
    '降级：存储里的未知 id 与非法键位被忽略，合法的那条照常生效',
    sanitized.bindings['pause'] === 'Ctrl+Alt+P' && sanitized.bindings['undo'] === 'Ctrl+Z' && !('ghost-id' in sanitized.bindings),
  );

  setGlobal('localStorage', makeThrowingStorage());
  let resilientThrew = false;
  const resilient = new ShortcutPanel(null);
  let resilientResult = { ok: false };
  try {
    resilientResult = resilient.setBinding('pause', 'Ctrl+Alt+P');
    resilient.resetAll();
  } catch {
    resilientThrew = true;
  }
  check('降级：localStorage 全程抛异常时构造 / 改键 / 恢复默认都不抛', !resilientThrew);
  check('降级：写不进存储时改键仍在内存里生效', resilientResult.ok === true);

  // ---- 无 DOM 的开合与销毁 ----
  clearGlobals();
  let openThrew = false;
  try {
    panel.open();
    panel.close();
    panel.toggle();
  } catch {
    openThrew = true;
  }
  check('降级：无 DOM 时 open / close / toggle 不抛，isOpen 恒为 false', !openThrew && panel.isOpen === false);
  panel.dispose();
  check('dispose：销毁后 match() 返回 null（不再分发按键）', panel.match(ev('KeyP')) === null);
  const afterDispose = panel.setBinding('undo', 'Ctrl+Q');
  check('dispose：销毁后改键被拒绝并说明原因', afterDispose.ok === false, afterDispose.reason);
}

// ============================================================ 面板管理

function runPanelChecks(check: CheckFn): void {
  clearGlobals();

  check('存储键：面板布局用 gad-box- 前缀', PANEL_LAYOUT_STORAGE_KEY.startsWith('gad-box-'), PANEL_LAYOUT_STORAGE_KEY);

  // ---- 边界夹紧（纯函数）----
  const base = { width: 300, height: 200, viewportWidth: 1000, viewportHeight: 700, margin: PANEL_EDGE_MARGIN };
  const farLeft = clampPanelPosition({ ...base, x: -10000, y: -10000 });
  check(
    '边界约束：拖到 -10000 会被夹回边距（面板不会跑出屏幕找不回来）',
    farLeft.x === PANEL_EDGE_MARGIN && farLeft.y === PANEL_EDGE_MARGIN,
    `(${farLeft.x}, ${farLeft.y})`,
  );
  const farRight = clampPanelPosition({ ...base, x: 5000, y: 5000 });
  check(
    '边界约束：拖出右下角会被夹到"整块还在视口里"',
    farRight.x === 1000 - 300 - PANEL_EDGE_MARGIN && farRight.y === 700 - 200 - PANEL_EDGE_MARGIN,
    `(${farRight.x}, ${farRight.y})`,
  );
  const notANumber = clampPanelPosition({ ...base, x: Number.NaN, y: Number.POSITIVE_INFINITY });
  check('边界约束：NaN / Infinity 一律回边距（写进 style 元素会直接消失）', notANumber.x === PANEL_EDGE_MARGIN && notANumber.y === PANEL_EDGE_MARGIN);
  const oversized = clampPanelPosition({ x: 400, y: 400, width: 2000, height: 1500, viewportWidth: 1000, viewportHeight: 700, margin: PANEL_EDGE_MARGIN });
  check('边界约束：面板比视口还大时贴左上角（比"能拖出去一半"更好找）', oversized.x === PANEL_EDGE_MARGIN && oversized.y === PANEL_EDGE_MARGIN);
  const inRange = clampPanelPosition({ ...base, x: 120, y: 90 });
  check('边界约束：本来就在可视范围内的位置原样保留', inRange.x === 120 && inRange.y === 90);
  const noViewport = clampPanelPosition({ ...base, x: -50, y: -50, viewportWidth: 0, viewportHeight: 0 });
  check('边界约束：量不到视口（0）时至少保证不小于边距', noViewport.x === PANEL_EDGE_MARGIN && noViewport.y === PANEL_EDGE_MARGIN);

  // ---- 无 DOM 降级 ----
  const bare = new PanelManager();
  let bareThrew = false;
  try {
    bare.attach(null);
    bare.getState('whatever');
    bare.resetPositions();
    bare.toggleCollapsed('whatever');
  } catch {
    bareThrew = true;
  }
  check('降级：无 DOM 时 attach(null) 与全部接口都不抛', !bareThrew);
  check('降级：没接管到任何面板时 states 为空数组', bare.states.length === 0);
  bare.dispose();

  // ---- 扫 DOM 并接管 ----
  const doc = makeFakeDocument({ width: 1200, height: 800 });
  setGlobal('document', doc);
  const storage = makeFakeStorage();
  const root = doc.createElement('div');
  const brush = makeFakePanel('brush-panel', { left: 20, top: 30, width: 300, height: 200 });
  root.appendChild(brush);

  const manager = new PanelManager({ storage });
  manager.attach(root);
  check('接管：扫到 [data-panel] 并登记状态', manager.states.length === 1 && manager.states[0].id === 'brush-panel', `${manager.states.length} 个面板`);
  const handle = brush.querySelector('[data-panel-handle]');
  const collapseButton = brush.querySelector('[data-panel-collapse]');
  check('接管：面板没有手柄时自动生成一条（并插在最前面）', handle !== null && brush.firstChild === handle);
  check('接管：自动生成折叠按钮', collapseButton !== null);
  check(
    '接管：没被拖过的面板位置是 null（交给 CSS 摆放，不强行写死坐标）',
    manager.states[0].x === null && manager.states[0].y === null,
    `x=${String(manager.states[0].x)}`,
  );

  // ---- 拖动 ----
  // 面板初始在 (20, 30)，尺寸 300×200；往右下拖 1000px —— 远远超出 1200×800 的视口
  const dragHandle = handle as FakeElement;
  dragHandle.dispatch('pointerdown', { target: dragHandle, clientX: 50, clientY: 40, button: 0, pointerId: 1 });
  dragHandle.dispatch('pointermove', { target: dragHandle, clientX: 1050, clientY: 1040, button: 0, pointerId: 1 });
  const dragMaxX = 1200 - 300 - PANEL_EDGE_MARGIN;
  const dragMaxY = 800 - 200 - PANEL_EDGE_MARGIN;
  check(
    '拖动：往右下拖出屏幕时被夹在可视范围内',
    brush.style.left === `${dragMaxX}px` && brush.style.top === `${dragMaxY}px`,
    `${brush.style.left} / ${brush.style.top}（期望 ${dragMaxX}px / ${dragMaxY}px）`,
  );

  dragHandle.dispatch('pointerup', { target: dragHandle, clientX: 1050, clientY: 1040, button: 0, pointerId: 1 });
  const afterDrag = JSON.parse(storage.getItem(PANEL_LAYOUT_STORAGE_KEY) ?? '[]') as { id: string; x: number; y: number }[];
  check(
    '拖动：松手后位置落盘（刷新 / 重开还能回到原处）',
    afterDrag[0]?.x === dragMaxX && afterDrag[0]?.y === dragMaxY,
    JSON.stringify(afterDrag[0] ?? null),
  );

  // 把假 rect 同步成"浏览器里应该有的样子"，再测一次极端拖动
  brush.rect = { left: dragMaxX, top: dragMaxY, width: 300, height: 200 };
  dragHandle.dispatch('pointerdown', { target: dragHandle, clientX: 400, clientY: 400, button: 0, pointerId: 2 });
  dragHandle.dispatch('pointermove', { target: dragHandle, clientX: -10000, clientY: -10000, button: 0, pointerId: 2 });
  check(
    '拖动：往屏幕外拖 10000px 仍被夹在边距上',
    brush.style.left === `${PANEL_EDGE_MARGIN}px` && brush.style.top === `${PANEL_EDGE_MARGIN}px`,
    `${brush.style.left} / ${brush.style.top}`,
  );
  dragHandle.dispatch('pointerup', { target: dragHandle, clientX: -10000, clientY: -10000, button: 0, pointerId: 2 });

  // ---- 阈值与误触 ----
  const leftBeforeTap = brush.style.left;
  dragHandle.dispatch('pointerdown', { target: dragHandle, clientX: 100, clientY: 100, button: 0, pointerId: 3 });
  dragHandle.dispatch('pointermove', { target: dragHandle, clientX: 102, clientY: 101, button: 0, pointerId: 3 });
  check('拖动：位移不到阈值（4px）不算拖动（点一下手柄不会挪面板）', brush.style.left === leftBeforeTap, brush.style.left);
  dragHandle.dispatch('pointerup', { target: dragHandle, clientX: 102, clientY: 101, button: 0, pointerId: 3 });

  const innerButton = doc.createElement('button');
  dragHandle.appendChild(innerButton);
  const leftBeforeButton = brush.style.left;
  dragHandle.dispatch('pointerdown', { target: innerButton, clientX: 100, clientY: 100, button: 0, pointerId: 4 });
  dragHandle.dispatch('pointermove', { target: innerButton, clientX: 900, clientY: 900, button: 0, pointerId: 4 });
  check('拖动：按在按钮上不会拖动面板（手柄里的按钮不会被误触）', brush.style.left === leftBeforeButton, brush.style.left);
  dragHandle.dispatch('pointerup', { target: innerButton, clientX: 900, clientY: 900, button: 0, pointerId: 4 });

  // ---- 折叠持久化 ----
  manager.toggleCollapsed('brush-panel');
  check('折叠：状态记为折叠且面板加上 collapsed 类（与其它面板同一套样式钩子）', manager.states[0].collapsed === true && brush.classList.contains('collapsed'));
  const collapsedDump = JSON.parse(storage.getItem(PANEL_LAYOUT_STORAGE_KEY) ?? '[]') as { collapsed: boolean }[];
  check('折叠：折叠状态落盘', collapsedDump[0]?.collapsed === true, JSON.stringify(collapsedDump[0] ?? null));

  const reopened = new PanelManager({ storage });
  reopened.attach(root);
  check(
    '记忆恢复：重新接管后面板的折叠状态与位置都还在',
    reopened.states[0].collapsed === true && brush.classList.contains('collapsed') && brush.style.left === `${PANEL_EDGE_MARGIN}px`,
    `collapsed=${reopened.states[0].collapsed} left=${brush.style.left}`,
  );

  // ---- 重置位置 ----
  reopened.resetPositions();
  check('重置位置：清掉内联 left / top（回到 CSS 摆放）', brush.style.left === '' && brush.style.top === '');
  check('重置位置：状态里的坐标变回 null', reopened.states[0].x === null && reopened.states[0].y === null);
  check('重置位置：折叠状态保留（这是两件事，不该一起被清掉）', reopened.states[0].collapsed === true);
  const resetDump = JSON.parse(storage.getItem(PANEL_LAYOUT_STORAGE_KEY) ?? '[]') as { x: number | null }[];
  check('重置位置：落盘写的是 null（刷新后不会把旧坐标读回来）', resetDump[0]?.x === null, JSON.stringify(resetDump[0] ?? null));

  // ---- 跨屏幕尺寸 ----
  const smallDoc = makeFakeDocument({ width: 400, height: 600 });
  setGlobal('document', smallDoc);
  const smallRoot = smallDoc.createElement('div');
  const smallPanel = makeFakePanel('brush-panel', { left: 0, top: 0, width: 300, height: 200 });
  smallRoot.appendChild(smallPanel);
  const legacyStorage = makeFakeStorage({
    [PANEL_LAYOUT_STORAGE_KEY]: JSON.stringify([{ id: 'brush-panel', collapsed: false, x: 1100, y: 700 }]),
  });
  const smallManager = new PanelManager({ storage: legacyStorage, onNotice: () => {} });
  smallManager.attach(smallRoot);
  check(
    '跨屏幕：大屏右下角的记忆坐标在小屏上被夹回可视范围',
    smallPanel.style.left === '92px' && smallPanel.style.top === '392px',
    `${smallPanel.style.left} / ${smallPanel.style.top}（期望 92px / 392px）`,
  );
  check(
    '跨屏幕：恢复记忆时会把定位方式改成 fixed（static 元素上的 left/top 是没效果的）',
    smallPanel.style.position === 'fixed',
    `position=${smallPanel.style.position}`,
  );
  smallManager.dispose();
  setGlobal('document', doc);

  // ---- 坏数据与存储失败 ----
  const junkManager = new PanelManager({ storage: makeFakeStorage({ [PANEL_LAYOUT_STORAGE_KEY]: '{坏数据' }), onNotice: () => {} });
  let junkThrew = false;
  try {
    junkManager.attach(root);
  } catch {
    junkThrew = true;
  }
  check('降级：存档是坏 JSON 时不抛，按默认位置摆放', !junkThrew);
  junkManager.dispose();

  const notices: string[] = [];
  const failing = new PanelManager({ storage: makeThrowingStorage(), onNotice: (message) => notices.push(message) });
  let failingThrew = false;
  try {
    failing.attach(root);
    failing.toggleCollapsed('brush-panel');
    failing.resetPositions();
  } catch {
    failingThrew = true;
  }
  check('降级：存储全程抛异常时 attach / 折叠 / 重置位置都不抛', !failingThrew);
  check('降级：存储失败会通过 onNotice 报一句中文（不静默）', notices.length > 0 && notices[0].includes('布局'), notices[0]);
  failing.dispose();

  // ---- 跳过不合格的元素 ----
  const skipNotices: string[] = [];
  const skipRoot = doc.createElement('div');
  const noId = new FakeElement('aside');
  noId.dataset.panel = '';
  skipRoot.appendChild(noId);
  const skipManager = new PanelManager({ storage: makeFakeStorage(), onNotice: (message) => skipNotices.push(message) });
  skipManager.attach(skipRoot);
  check(
    '稳健性：既没有 id 也没有 data-panel 值的元素被跳过并给出中文提示',
    skipManager.states.length === 0 && skipNotices.length === 1,
    skipNotices[0] ?? '（没有提示）',
  );
  skipManager.dispose();

  const dupRoot = doc.createElement('div');
  dupRoot.appendChild(makeFakePanel('same-id', { left: 0, top: 0, width: 100, height: 100 }));
  dupRoot.appendChild(makeFakePanel('same-id', { left: 0, top: 0, width: 100, height: 100 }));
  const dupManager = new PanelManager({ storage: makeFakeStorage(), onNotice: () => {} });
  dupManager.attach(dupRoot);
  check('稳健性：重复的面板 id 只接管第一个（id 是记忆的键，必须唯一）', dupManager.states.length === 1, `${dupManager.states.length} 个`);
  dupManager.dispose();

  // ---- 折叠 opt-out（折叠由 Engine 的 setTool 控制的那批面板）----
  const optRoot = doc.createElement('div');
  const optPanel = makeFakePanel('brush-panel', { left: 0, top: 0, width: 200, height: 120 });
  optPanel.setAttribute('data-panel-no-collapse', '');
  optPanel.classList.add('collapsed'); // 模拟 Engine 的 setTool 把它折叠了
  optRoot.appendChild(optPanel);
  const optNotices: string[] = [];
  const optManager = new PanelManager({ storage: makeFakeStorage(), onNotice: (message) => optNotices.push(message) });
  optManager.attach(optRoot);
  check(
    '折叠 opt-out：标了 data-panel-no-collapse 的面板不生成折叠按钮',
    optPanel.querySelector('[data-panel-collapse]') === null,
  );
  check('折叠 opt-out：折叠状态现读现取（如实反映 Engine 控制的结果）', optManager.states[0].collapsed === true);
  optManager.toggleCollapsed('brush-panel');
  check(
    '折叠 opt-out：本模块不去改它的折叠，而是给出中文提示',
    optPanel.classList.contains('collapsed') && optNotices.some((message) => message.includes('data-panel-no-collapse')),
    optNotices[0],
  );
  optManager.dispose();

  // ---- dispose ----
  const tempRoot = doc.createElement('div');
  const tempPanel = makeFakePanel('temp-panel', { left: 0, top: 0, width: 100, height: 100 });
  tempRoot.appendChild(tempPanel);
  const tempManager = new PanelManager({ storage: makeFakeStorage() });
  tempManager.attach(tempRoot);
  const tempHadHandle = tempPanel.querySelector('[data-panel-handle]') !== null;
  tempManager.dispose();
  check(
    'dispose：摘掉自动生成的手柄与折叠按钮，状态清空',
    tempHadHandle && tempPanel.querySelector('[data-panel-handle]') === null && tempManager.states.length === 0,
  );
  tempManager.attach(tempRoot);
  check('dispose：销毁后再 attach 不会重新接管（已失效的对象不该复活）', tempManager.states.length === 0);

  manager.dispose();
  reopened.dispose();
  clearGlobals();
}

/** 全部 UI 断言入口 */
export function runUiChecks(check: CheckFn): void {
  runThemeChecks(check);
  runShortcutChecks(check);
  runPanelChecks(check);
}
