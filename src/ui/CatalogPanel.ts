/**
 * 物品面板的浏览区（M4 第 2 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么从 BuildingPanel 里拆出来
 * ────────────────────────────────────────────────────────────
 * 物品库从 77 个涨到 387 个之后，面板要管的事情变成了三类互不相干的东西：
 * 1. **找东西**（分类 / 二级分类 / 搜索 / 排序 / 分页 / 收藏 / 最近使用 / 内容包）；
 * 2. **放置设置**（吸附、步长、旋转步长）；
 * 3. **对已选中实例的操作**（旋转、删除、复制、对准）。
 * 塞在一个类里的时候，`renderGrid()` 顺手就要去改标签页与详情框，谁都说不清
 * "改这行代码会动到哪块界面"。所以浏览区独立成这个控制器：
 * **它只读目录数据、只写 #catalog-\* 节点，其它一概不碰**。
 *
 * ────────────────────────────────────────────────────────────
 * 与内容包（contentPacks.ts）的分工
 * ────────────────────────────────────────────────────────────
 * 包 → 分类的映射、读写 localStorage、计数、摘要**全部在 contentPacks.ts 里**，
 * 这里只负责"调它 + 显示结果"。这里再写一套"哪些分类属于哪个包"必然会出现两边不一致，
 * 而症状是"某个物品在包里算得到、在面板里翻不到"这类极难查的问题。
 * 唯一的例外是**标签页上的数量**：那里必须用"过滤之后"的数，不能直接用
 * `categoryCounts()`（它数的是整个目录），否则关掉交通包之后标签仍写着 28，
 * 玩家点进去却一页空 —— 数字必须和玩家实际能翻到的数量对得上。
 */

import { BUILDING_CATALOG, getBuildingDef } from '../data/buildingCatalog';
import { BUILDING_CATEGORIES } from '../data/buildingCategories';
import { colorToHexString } from '../data/voxelTypes';
import {
  CONTENT_PACKS,
  describePacks,
  filterByPacks,
  loadEnabledPacks,
  packCounts,
  saveEnabledPacks,
  type ContentPackId,
} from '../data/contentPacks';
import type { BuildingDef } from '../building/types';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface CatalogPanelHandlers {
  /** 玩家选中了一个物品（Engine 会把它设为"当前要放置的模型"） */
  onSelect(def: BuildingDef): void;
  /** 内容包启用状态变化（Engine 需要知道，因为它会影响"能不能放"） */
  onPacksChange(enabled: readonly ContentPackId[]): void;
  /** 收藏列表变化（Engine 负责持久化） */
  onFavoritesChange(ids: readonly string[]): void;
  /** 玩家用了一个物品（Engine 记进"最近使用"并持久化） */
  onUse(def: BuildingDef): void;
}

export interface CatalogPanelStats {
  /** 当前选中的物品 id（用来高亮卡片） */
  selectedId: string | null;
  /** 最近使用过的物品 id（新的在前，最多 12 个） */
  recentIds: readonly string[];
  /** 收藏的物品 id */
  favoriteIds: readonly string[];
  /** 世界里每种物品各有多少个（卡片上显示「已放 3 个」） */
  placedCounts: Readonly<Record<string, number>>;
}

/** 每页卡片数。24 个 ≈ 手机上一屏半，翻页成本低到可以忽略 */
/**
 * 每次往列表里追加多少个卡片（**不是**分页大小）。
 *
 * 老版本用"每页 24 个 + 上一页/下一页"，理由是"手机上滚 387 个卡片既难点准又掉帧"。
 * 那个理由本身没错，但实现方式带来了两个真实问题（用户反馈的原话是"选择步骤太多、
 * 没法直观看到全部物品"）：
 * 1. **看全部 394 个要翻 17 页** —— 每翻一次都是"点下一页 → 找 → 再点"，找东西的成本很高；
 * 2. **玩家不知道后面还有什么** —— 分页天然隐藏总量，而"我到底有哪些建筑可以用"
 *    是这个界面上最常被问的问题。
 *
 * 现在改成**连续长列表 + 触底自动追加**：
 * - DOM 仍然是一批一批建的（每次 24 个），所以首屏依然很快；
 * - 往下滚就自动加载下一批，没有"翻页"这个动作；
 * - 兜底留一个"显示更多"按钮：IntersectionObserver 不可用（老浏览器）时也能用。
 * 这个折中同时保住了原来那条性能理由和"能看到全部"这两件事。
 */
const PAGE_SIZE = 24;
/** 搜索防抖：敲字时先攒 120ms，避免每个字符都全量搜一遍 + 重排 DOM */
const SEARCH_DEBOUNCE_MS = 120;
/** update() 节流：面板刷新不该跟渲染帧同频 */
const REFRESH_THROTTLE_MS = 200;
/** 最近使用最多显示多少个 */
const RECENT_LIMIT = 12;
/** 颜色搜索的每通道容差（±32 ≈ ±12.5%，宽带足够又不会把整屏同类色都算命中） */
const COLOR_TOLERANCE = 32;

/** 两个虚拟分类（不是真实 category，只用于标签页） */
const ALL = '全部';
const FAV = '收藏';

const HOVER_HINT = '把鼠标停在物品上可以看到它的完整参数。';
const ALL_PACKS_OFF = '所有内容包都关掉了：在下面的「内容包」里打开至少一个';

type SortMode = 'default' | 'name' | 'mass' | 'size';
const SORT_MODES: readonly SortMode[] = ['default', 'name', 'mass', 'size'];

interface ParsedQuery {
  /** 文字词（空格分词，全部命中才算匹配） */
  text: string[];
  /** 颜色词（`#rrggbb` / `#rgb`） */
  colors: [number, number, number][];
}

/**
 * 搜索用的"干草堆"：name / id / category / subcategory / tags / description。
 *
 * 缓存起来是因为搜索要在 387 个物品上逐词跑，而拼接字符串是这里面最贵的一步；
 * 目录是模块级常量、不会变，所以缓存一次就够。懒建而不是模块加载时建：
 * 没人打开面板就不该付这份钱。
 */
let haystackCache: Map<string, string> | null = null;

function haystackOf(def: BuildingDef): string {
  return `${def.name} ${def.id} ${def.category} ${def.subcategory ?? ''} ${def.tags.join(' ')} ${def.description}`.toLowerCase();
}

function haystacks(): Map<string, string> {
  if (!haystackCache) {
    haystackCache = new Map(BUILDING_CATALOG.map((def) => [def.id, haystackOf(def)]));
  }
  return haystackCache;
}

/**
 * 子序列匹配：把查询的字符按顺序在目标里找得到就算命中。
 *
 * 为什么要它 —— 中文玩家经常只记得大概的字（「石墙」→「混凝土石墙」），
 * 而英文 id 又常被当作快捷键式的检索串（「swq」→「stone_wall_q」）。
 * 只做 `includes` 这两类都会搜不到。
 *
 * ⚠ 子序列匹配会放宽命中范围，所以调用方必须把它的结果**排在 includes 之后**
 * （见 `scoreDef` 的 rank）：精确命中永远优先。不然搜「桌」的时候，
 * 说明文字里"桌"字出现在中段的某个大件会挤到真正的桌子前面。
 */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j += 1) {
    if (hay[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/** `#rrggbb` / `#rgb` → RGB；不是颜色就返回 null（当作普通关键词处理） */
function parseColorToken(token: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(token);
  if (!match) return null;
  let hex = match[1]!;
  if (hex.length === 3) hex = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  const value = Number.parseInt(hex, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function colorMatches(color: number, rgb: [number, number, number]): boolean {
  return (
    Math.abs(((color >> 16) & 0xff) - rgb[0]) <= COLOR_TOLERANCE &&
    Math.abs(((color >> 8) & 0xff) - rgb[1]) <= COLOR_TOLERANCE &&
    Math.abs((color & 0xff) - rgb[2]) <= COLOR_TOLERANCE
  );
}

function parseQuery(raw: string): ParsedQuery | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const text: string[] = [];
  const colors: [number, number, number][] = [];
  for (const token of trimmed.split(/\s+/)) {
    const rgb = parseColorToken(token);
    if (rgb) colors.push(rgb);
    else text.push(token);
  }
  return { text, colors };
}

/**
 * 单个物品对查询的匹配度：-1 = 不命中，0 = 全部词都是 includes 命中，1 = 至少一个词靠子序列。
 */
function scoreDef(def: BuildingDef, query: ParsedQuery): number {
  const hay = haystacks().get(def.id) ?? haystackOf(def);
  let fuzzy = false;
  for (const word of query.text) {
    if (hay.includes(word)) continue;
    if (isSubsequence(word, hay)) {
      fuzzy = true;
      continue;
    }
    return -1;
  }
  for (const rgb of query.colors) {
    if (!colorMatches(def.color, rgb)) return -1;
  }
  return fuzzy ? 1 : 0;
}

/** 文本转义：目录数据是可信的，但自定义物品的名字来自玩家输入，统一转义一次不留隐患 */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 缺字段一律显示「—」：界面上出现 undefined 比显示一个短横线糟糕得多 */
function fmt(value: string | number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || value === '') return '—';
  return typeof value === 'number' ? value.toFixed(digits) : value;
}

/** 缩略图：主色 + 稍微压暗的渐变，emoji 由 .item-card .thumb 的 flex 居中 */
function thumbGradient(color: number): string {
  const base = colorToHexString(color);
  const r = Math.round(((color >> 16) & 0xff) * 0.55);
  const g = Math.round(((color >> 8) & 0xff) * 0.55);
  const b = Math.round((color & 0xff) * 0.55);
  const dark = colorToHexString((r << 16) | (g << 8) | b);
  return `linear-gradient(135deg, ${base} 0%, ${base} 55%, ${dark} 100%)`;
}

/**
 * 物品目录面板：分类 / 二级分类 / 搜索 / 排序 / 分页 / 收藏 / 最近使用 / 内容包。
 *
 * 三个刻意的取舍（都写在这里免得以后被当成疏漏）：
 * 1. **分页而不是长滚动** —— 手机上滚 387 个卡片既难点准又掉帧，每页 24 个刚好；
 * 2. **只建当前页的 DOM** —— `renderGrid()` 永远只创建 ≤24 张卡片，翻页时重建，
 *    这样物品数再翻一倍也不会让面板变卡；
 * 3. **搜索 / 换分类一律回到第 1 页** —— 不回第 1 页的话玩家会停在一个
 *    已经变空的页上，看起来就是"搜不到"（这是搜索类界面最常见的一个坑）。
 */
export class CatalogPanel {
  private readonly searchInput: HTMLInputElement;
  private readonly tabsContainer: HTMLElement;
  private readonly subsContainer: HTMLElement;
  private readonly sortSelect: HTMLSelectElement;
  private readonly favOnlyInput: HTMLInputElement;
  private readonly recentContainer: HTMLElement;
  /** 「最近使用」那一行的容器（空时整行隐藏，省一屏高度） */
  private recentWrap: HTMLElement | null = null;
  private readonly packsContainer: HTMLElement;
  private readonly packNote: HTMLElement;
  private readonly countLabel: HTMLElement;
  private readonly gridContainer: HTMLElement;
  private readonly emptyLabel: HTMLElement;
  private readonly pagerContainer: HTMLElement;
  private readonly hoverBox: HTMLElement;

  /** 当前一级分类（真实分类 id，或 ALL / FAV） */
  private category: string = ALL;
  /** 当前二级分类（null = 不限） */
  private subcategory: string | null = null;
  /**
   * 当前往列表里挂了多长（不是页码）。
   *
   * 用"已挂多少张"而不是"第几页"来表示滚动进度：长列表的语义是**累积**的，
   * 翻页的语义是**替换**的 —— 这也是"翻页会让人迷路、长列表不会"的根因。
   */
  private visibleCount = PAGE_SIZE;
  /** 追加用的哨兵观察器（没有 IntersectionObserver 时为 null，走"显示更多"按钮） */
  private sentinelObserver: IntersectionObserver | null = null;
  /** 已经生效的查询串（防抖之后）；`this.searchInput.value` 才是玩家正在敲的 */
  private query = '';
  private sortMode: SortMode = 'default';
  private favOnly = false;

  /** 启用中的内容包 —— 这是"可见物品"的唯一来源 */
  private enabled: Set<ContentPackId> = loadEnabledPacks();
  private favoriteIds: readonly string[] = [];
  private favoriteSet = new Set<string>();
  private recentIds: readonly string[] = [];
  private selectedId: string | null = null;
  private placedCounts: Readonly<Record<string, number>> = {};
  /** 上一次 update() 的统计指纹：没变就不重建 DOM（见 update()） */
  private statsSignature = '';

  /**
   * ⚠ 初值必须是 -Infinity 而不是 0。
   * `performance.now()` 在页面启动后的头 200ms 内小于 200，用 0 当基线的话
   * `now - 0 < 200` 会把**第一次** update() 直接吞掉，面板就一直停在构造时的空状态。
   * （项目里 PerformancePanel 就踩过这个坑。）
   */
  private lastRefresh = Number.NEGATIVE_INFINITY;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** 登记过的监听器，dispose() 时逐个摘掉 */
  private readonly listeners: { target: EventTarget; type: string; handler: EventListener }[] = [];

  constructor(private readonly handlers: CatalogPanelHandlers) {
    this.searchInput = must<HTMLInputElement>('#catalog-search');
    this.tabsContainer = must<HTMLElement>('#catalog-tabs');
    this.subsContainer = must<HTMLElement>('#catalog-subs');
    this.sortSelect = must<HTMLSelectElement>('#catalog-sort');
    this.favOnlyInput = must<HTMLInputElement>('#catalog-fav-only');
    this.recentContainer = must<HTMLElement>('#catalog-recent');
    // 可选节点：缺了不影响功能（面板会退化成"没有最近使用这一行"），所以用 querySelector
    this.recentWrap = document.querySelector<HTMLElement>('#catalog-recent-wrap');
    this.packsContainer = must<HTMLElement>('#catalog-packs');
    this.packNote = must<HTMLElement>('#catalog-pack-note');
    this.countLabel = must<HTMLElement>('#catalog-count');
    this.gridContainer = must<HTMLElement>('#catalog-grid');
    this.emptyLabel = must<HTMLElement>('#catalog-empty');
    this.pagerContainer = must<HTMLElement>('#catalog-pager');
    this.hoverBox = must<HTMLElement>('#catalog-hover');

    // 关包的后果必须写在开关旁边：如果玩家以为"关包 = 删东西"，他是不敢碰这个开关的
    this.packNote.textContent = '关掉一个内容包只会把它从面板里藏起来，世界里的东西不会消失。';
    this.hoverBox.textContent = HOVER_HINT;

    this.bindEvents();
    this.renderAll();
  }

  // ------------------------------------------------------------------ 对外接口

  /** 每帧或按需调用（内部 200ms 节流） */
  update(stats: CatalogPanelStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_THROTTLE_MS) return;
    this.lastRefresh = now;

    // 指纹没变 = 这一帧没有任何东西会让界面长得不一样，直接跳过重建
    const signature =
      `${stats.selectedId ?? ''}|${stats.recentIds.join(',')}|${stats.favoriteIds.join(',')}|` +
      JSON.stringify(stats.placedCounts);
    if (signature === this.statsSignature) return;
    this.statsSignature = signature;

    this.selectedId = stats.selectedId;
    this.setRecentIds(stats.recentIds);
    this.setFavoriteIds(stats.favoriteIds);
    this.placedCounts = stats.placedCounts;
    this.renderAll();
  }

  /** 外部同步（读档后） */
  syncState(patch: { favoriteIds?: readonly string[]; recentIds?: readonly string[] }): void {
    if (this.disposed) return;
    if (patch.favoriteIds) this.setFavoriteIds(patch.favoriteIds);
    if (patch.recentIds) this.setRecentIds(patch.recentIds);
    this.renderAll();
  }

  /** 当前筛选出来的物品（测试与统计用）—— 与界面看到的完全一致（含搜索与排序） */
  get visibleItems(): readonly BuildingDef[] {
    return this.computeList();
  }

  /** 当前启用中的内容包 */
  get enabledPacks(): readonly ContentPackId[] {
    return [...this.enabled];
  }

  /**
   * 重新从存储里读内容包开关并重渲染。
   *
   * 为什么需要这个方法：内容包现在有**两个**入口 —— 这个面板里的开关，
   * 和设置区的 `ContentPackUI`。两边读同一个 storage 键，但各自持有一份内存副本。
   * 没有它的话，在另一个面板改了开关，这个面板要等刷新页面才跟上，
   * 玩家会以为"开关失灵"。所以由 `Engine` 在任一边变化时调用它。
   */
  reloadPacks(): void {
    if (this.disposed) return;
    this.enabled = loadEnabledPacks();
    this.visibleCount = PAGE_SIZE;
    this.renderAll();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 哨兵必须断开：它挂着 DOM 节点，不断开会让"已销毁的面板"继续被回调唤醒
    this.disconnectSentinel();
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const { target, type, handler } of this.listeners) {
      target.removeEventListener(type, handler);
    }
    this.listeners.length = 0;
  }

  // ------------------------------------------------------------------ 事件

  private on(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.listeners.push({ target, type, handler });
  }

  private bindEvents(): void {
    // 搜索：防抖 120ms。387 个物品的纯字符串匹配本身远低于 50ms 的预算，
    // 但"每敲一个字就重排一次 DOM"是白花的钱 —— 敲「石墙」两个字，
    // 不防抖就要重建两次网格（每次 24 张卡片连同缩略图样式）。
    this.on(this.searchInput, 'input', () => {
      if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        if (this.disposed) return;
        this.query = this.searchInput.value;
        this.visibleCount = PAGE_SIZE; // 不回第 1 页会停在一个空页上，看着像"搜不到"
        this.renderAll();
      }, SEARCH_DEBOUNCE_MS);
    });

    this.on(this.sortSelect, 'change', () => {
      const value = this.sortSelect.value as SortMode;
      this.sortMode = SORT_MODES.includes(value) ? value : 'default';
      this.visibleCount = PAGE_SIZE;
      this.renderGrid();
    });

    this.on(this.favOnlyInput, 'change', () => {
      this.favOnly = this.favOnlyInput.checked;
      this.visibleCount = PAGE_SIZE;
      this.renderAll();
    });

    // 全部用容器上的委托：卡片每次翻页都被重建，逐张挂监听会漏摘（dispose 也就没法干净）
    this.on(this.tabsContainer, 'click', (ev) => {
      const button = (ev.target as HTMLElement | null)?.closest('button');
      const next = button?.dataset.category;
      if (!next) return;
      this.category = next;
      this.subcategory = null; // 二级分类属于上一个一级分类，跟着一起清掉
      this.visibleCount = PAGE_SIZE;
      this.renderAll();
    });

    this.on(this.subsContainer, 'click', (ev) => {
      const button = (ev.target as HTMLElement | null)?.closest('button');
      const next = button?.dataset.sub;
      if (next === undefined) return;
      this.subcategory = next === '' ? null : next;
      this.visibleCount = PAGE_SIZE;
      this.renderAll();
    });

    this.on(this.packsContainer, 'change', (ev) => {
      const input = ev.target as HTMLInputElement | null;
      const packId = input?.dataset.packId as ContentPackId | undefined;
      if (!input || !packId) return;
      // 只认已知的包 id：DOM 被改过 / 旧版页面残留的开关不该能写入 enabled
      if (!CONTENT_PACKS.some((pack) => pack.id === packId)) return;
      const next = new Set(this.enabled);
      if (input.checked) next.add(packId);
      else next.delete(packId);
      this.enabled = next;
      saveEnabledPacks(next); // 失败（隐私模式 / 配额满）也不阻塞界面，下次默认值兜底
      this.visibleCount = PAGE_SIZE;
      // 立刻重渲染，不能等下一次 update()：节流窗口里界面会停在旧状态，看起来像开关没生效
      this.renderAll();
      this.handlers.onPacksChange([...next]);
    });

    this.on(this.gridContainer, 'click', (ev) => {
      const target = ev.target as HTMLElement | null;
      const star = target?.closest('[data-fav-toggle]');
      if (star) {
        // 星标在卡片按钮内部，它自己也会冒泡成"点了卡片" —— 必须在这里截断，
        // 否则"收藏一下"就会顺手把玩家正在摆的东西换成别的东西。
        ev.stopPropagation();
        ev.preventDefault();
        this.toggleFavorite(star.closest('[data-def-id]')?.getAttribute('data-def-id') ?? '');
        return;
      }
      const card = target?.closest('[data-def-id]');
      const defId = card?.getAttribute('data-def-id');
      if (!defId) return;
      this.selectDef(defId);
    });

    // 最近使用的小卡片同样走委托：它们每帧都可能被 update() 重建
    this.on(this.recentContainer, 'click', (ev) => {
      const defId = (ev.target as HTMLElement | null)?.closest('[data-def-id]')?.getAttribute('data-def-id');
      if (defId) this.selectDef(defId);
    });

    this.on(this.pagerContainer, 'click', (ev) => {
      const button = (ev.target as HTMLElement | null)?.closest('button');
      if (button?.dataset.page !== 'more') return;
      this.loadMore();
    });

    // 悬停 / 键盘聚焦都显示完整参数：触屏没有 hover，但外接键盘与桌面端有
    this.on(this.gridContainer, 'mouseover', (ev) => this.showHoverFromEvent(ev));
    this.on(this.gridContainer, 'focusin', (ev) => this.showHoverFromEvent(ev));
    this.on(this.gridContainer, 'mouseout', () => this.resetHover());
    this.on(this.gridContainer, 'focusout', () => this.resetHover());
    this.on(this.recentContainer, 'mouseover', (ev) => this.showHoverFromEvent(ev));
    this.on(this.recentContainer, 'focusin', (ev) => this.showHoverFromEvent(ev));
  }

  private selectDef(defId: string): void {
    const def = getBuildingDef(defId);
    if (!def) return;
    this.selectedId = def.id;
    this.markSelected();
    this.handlers.onSelect(def);
    this.handlers.onUse(def);
  }

  private toggleFavorite(defId: string): void {
    if (!defId || !getBuildingDef(defId)) return;
    const next = new Set(this.favoriteSet);
    if (next.has(defId)) next.delete(defId);
    else next.add(defId);
    this.setFavoriteIds([...next]);
    this.renderAll();
    this.handlers.onFavoritesChange([...this.favoriteIds]);
  }

  private setFavoriteIds(ids: readonly string[]): void {
    this.favoriteIds = [...ids];
    this.favoriteSet = new Set(this.favoriteIds);
  }

  private setRecentIds(ids: readonly string[]): void {
    this.recentIds = [...ids].slice(0, RECENT_LIMIT);
  }

  private showHoverFromEvent(ev: Event): void {
    const target = ev.target as HTMLElement | null;
    const card = target?.closest('[data-def-id]');
    const defId = card?.getAttribute('data-def-id');
    if (!defId) return;
    const def = getBuildingDef(defId);
    if (def) this.hoverBox.innerHTML = renderDetail(def);
  }

  private resetHover(): void {
    this.hoverBox.textContent = HOVER_HINT;
  }

  // ------------------------------------------------------------------ 过滤

  /**
   * 内容包过滤后的物品，再叠加"只看收藏"。
   *
   * 收藏的 id 作为 `keepIds` 传给 `filterByPacks`：玩家收藏了交通包里的船，
   * 之后把交通包关掉，那条船不该从收藏夹里消失 —— 否则他连"这是什么"都查不到。
   * （contentPacks.ts 的注释里就是这么约定的。）
   */
  private baseItems(): BuildingDef[] {
    const visible = filterByPacks(BUILDING_CATALOG, this.enabled, this.favoriteSet);
    return this.favOnly ? visible.filter((def) => this.favoriteSet.has(def.id)) : visible;
  }

  /** 一级分类 + 二级分类过滤（不含搜索，标签页计数与二级分类表也用它） */
  private scopedByCategory(): BuildingDef[] {
    const base = this.baseItems();
    let list = base;
    if (this.category === FAV) list = base.filter((def) => this.favoriteSet.has(def.id));
    else if (this.category !== ALL) list = base.filter((def) => def.category === this.category);
    if (this.subcategory) list = list.filter((def) => (def.subcategory ?? '') === this.subcategory);
    return list;
  }

  /** 搜索 + 排序后的完整列表（不分页） */
  private computeList(): BuildingDef[] {
    const scoped = this.scopedByCategory();
    const query = parseQuery(this.query);
    if (!query) return this.sortByMode(scoped);

    const ranked: { def: BuildingDef; rank: number }[] = [];
    for (const def of scoped) {
      const rank = scoreDef(def, query);
      if (rank >= 0) ranked.push({ def, rank });
    }
    const compare = this.modeComparator();
    // rank 优先于排序方式：子序列命中的结果必须排在 includes 命中之后（精确命中优先），
    // 否则换了排序方式，"石墙"这种精确命中就会被一堆模糊命中挤下去。
    ranked.sort((a, b) => a.rank - b.rank || compare(a.def, b.def));
    return ranked.map((item) => item.def);
  }

  private modeComparator(): (a: BuildingDef, b: BuildingDef) => number {
    switch (this.sortMode) {
      case 'name':
        return (a, b) => a.name.localeCompare(b.name, 'zh');
      case 'mass':
        return (a, b) => a.mass - b.mass;
      case 'size':
        return (a, b) =>
          a.size[0] * a.size[1] * a.size[2] - b.size[0] * b.size[1] * b.size[2];
      default:
        // 默认保持目录顺序：那是按"盖房子最常用的先出现"排过的，比任何字母序都有用
        return () => 0;
    }
  }

  private sortByMode(list: BuildingDef[]): BuildingDef[] {
    const compare = this.modeComparator();
    // Array.prototype.sort 在 ES2019 之后是稳定排序，同值时保持目录顺序
    return list.slice().sort(compare);
  }

  // ------------------------------------------------------------------ 渲染

  private renderAll(): void {
    if (this.disposed) return;
    const base = this.baseItems();
    this.renderTabs(base);
    this.renderSubs(base);
    this.renderRecent();
    this.syncPacks();
    this.renderGrid();
  }

  /**
   * 标签页：11 个一级分类 + 全部 + 收藏。
   *
   * 数量用的是**过滤之后**的数组手数一遍，而不是 `categoryCounts()`：
   * 后者数的是整个目录，关掉内容包之后会显示玩家翻不到的数字。
   * 搜索框的内容**不参与**这里的计数（它是跨分类的收窄条件）——
   * 否则搜一次「石墙」，其它标签全变 0，玩家就再也看不出"别的东西在哪一类"。
   */
  private renderTabs(base: readonly BuildingDef[]): void {
    const counts = new Map<string, number>();
    for (const def of base) counts.set(def.category, (counts.get(def.category) ?? 0) + 1);
    const favorites = base.filter((def) => this.favoriteSet.has(def.id)).length;

    this.tabsContainer.innerHTML = '';
    const entries: { id: string; label: string; count: number; virtual: boolean }[] = [
      { id: ALL, label: `${ALL} ${base.length}`, count: base.length, virtual: true },
      ...BUILDING_CATEGORIES.map((info) => ({
        id: info.id,
        label: `${info.icon} ${info.name} ${counts.get(info.id) ?? 0}`,
        count: counts.get(info.id) ?? 0,
        virtual: false,
      })),
      { id: FAV, label: `★ ${FAV} ${favorites}`, count: favorites, virtual: true },
    ];

    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.category = entry.id;
      button.textContent = entry.label;
      // 0 个的分类禁掉：点进去只会看到一页空白，不如直接告诉玩家"这里没东西"
      if (!entry.virtual) button.disabled = entry.count === 0;
      if (entry.id === this.category) button.classList.add('active');
      this.tabsContainer.appendChild(button);
    }
  }

  /**
   * 二级分类：当前一级分类下出现过的 subcategory（去重）+ 一个「全部」。
   *
   * 「全部 / 收藏」两个虚拟分类下不显示二级分类条：那会是几十个跨分类的标签，
   * 手机上一屏塞不下，只会把面板顶得看不到物品。
   */
  private renderSubs(base: readonly BuildingDef[]): void {
    const hidden = this.category === ALL || this.category === FAV;
    const subs = new Set<string>();
    if (!hidden) {
      for (const def of base) {
        if (def.category !== this.category) continue;
        if (def.subcategory) subs.add(def.subcategory);
      }
    }

    if (hidden || subs.size === 0) {
      this.subsContainer.innerHTML = '';
      this.subsContainer.style.display = 'none';
      if (this.subcategory !== null) {
        // 换分类后旧的二级分类已经不存在，继续留着会把列表筛空（看着像"这个分类没有东西"）
        this.subcategory = null;
      }
      return;
    }

    const list = [...subs].sort((a, b) => a.localeCompare(b, 'zh'));
    if (this.subcategory !== null && !list.includes(this.subcategory)) this.subcategory = null;

    this.subsContainer.style.display = '';
    this.subsContainer.innerHTML = '';
    for (const id of ['', ...list]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.dataset.sub = id;
      button.textContent = id === '' ? '全部' : id;
      const active = id === '' ? this.subcategory === null : this.subcategory === id;
      if (active) button.classList.add('active');
      this.subsContainer.appendChild(button);
    }
  }

  /** 最近使用：小卡片，点击直接选中。被删掉的 id 要过滤，否则会点出一个不存在的模型 */
  private renderRecent(): void {
    const defs = this.recentIds
      .slice(0, RECENT_LIMIT)
      .map((id) => getBuildingDef(id))
      .filter((def): def is BuildingDef => def !== undefined);

    this.recentContainer.innerHTML = '';
    if (defs.length === 0) {
      // 没有最近使用就**整行隐藏**：这一行在物品列表正上方，
      // 空着的时候占掉的高度正好是"一屏少看两个物品"，不划算
      if (this.recentWrap) this.recentWrap.hidden = true;
      const empty = document.createElement('span');
      empty.className = 'dim';
      empty.textContent = '还没有用过的物品';
      this.recentContainer.appendChild(empty);
      return;
    }
    if (this.recentWrap) this.recentWrap.hidden = false;
    for (const def of defs) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.defId = def.id;
      if (def.id === this.selectedId) chip.classList.add('active');
      chip.innerHTML = `${def.icon} ${esc(def.name)}`;
      this.recentContainer.appendChild(chip);
    }
  }

  /** 内容包开关 + 摘要。开关状态从 this.enabled 画，不读 DOM（避免两边不同步） */
  private syncPacks(): void {
    const counts = packCounts(BUILDING_CATALOG);
    this.packsContainer.innerHTML = '';
    for (const pack of CONTENT_PACKS) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.packId = pack.id;
      input.checked = this.enabled.has(pack.id);
      label.appendChild(input);
      const text = document.createElement('span');
      text.textContent = `${pack.emoji} ${pack.name}（${counts[pack.id]} 项）`;
      label.appendChild(text);
      this.packsContainer.appendChild(label);
    }
    // 悬停看全量摘要（几个包开着、关着的包各有多少项）——不占面板高度
    this.packsContainer.title = describePacks(this.enabled, BUILDING_CATALOG);
  }

  /** 只按当前页重建卡片：387 个物品全建 DOM 在手机上会明显卡顿 */
  /**
   * 渲染列表。
   *
   * `append = true` 时只**追加**新增的那一批（触底加载走这条），
   * 否则从头重建（换分类 / 改搜索 / 改排序走这条）。
   *
   * 这里刻意不再有"页"的概念：`visibleCount` 是"当前挂了多长"，
   * 而它是**累积**的 —— 玩家往下滚，东西只会越来越多，不会突然换一批。
   */
  private renderGrid(append = false): void {
    // 旧哨兵先摘掉：它必须在列表**最后**，否则追加的卡片会落在它后面，
    // 观察器就会在"还没到底"的时候提前触发（表现是一进来就狂加载到全部）
    this.disconnectSentinel();
    const list = this.computeList();
    const total = list.length;
    if (this.visibleCount > total) this.visibleCount = total;

    if (!append) {
      this.gridContainer.innerHTML = '';
      for (let i = 0; i < Math.min(this.visibleCount, total); i += 1) {
        this.gridContainer.appendChild(this.buildCard(list[i]!));
      }
    } else {
      // 追加：从"已经挂了多少张"开始往后接。
      // 用 DOM 子节点数当已挂数量，而不是另存一个索引 —— 两处状态一定会不同步，
      // 而不同步的表现是"滚到底重复出现同一批物品"，很难查。
      const already = this.gridContainer.childElementCount;
      for (let i = already; i < total && i < this.visibleCount; i += 1) {
        this.gridContainer.appendChild(this.buildCard(list[i]!));
      }
    }

    const shown = Math.min(this.visibleCount, total);
    const selected = this.selectedId ? BUILDING_CATALOG.find((def) => def.id === this.selectedId) : undefined;
    this.countLabel.textContent =
      `共 ${BUILDING_CATALOG.length} 个物品｜当前筛选出 ${total} 个，已显示 ${shown} 个` +
      (selected ? `｜已选中「${selected.icon} ${selected.name}」→ 到场景里点地面放置` : '｜点一个物品即可开始放置');

    this.renderEmptyState(total);
    this.renderPager(total, shown);
  }

  private buildCard(def: BuildingDef): HTMLElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'item-card';
    card.dataset.defId = def.id;
    if (def.id === this.selectedId) card.classList.add('active');
    card.title = `${def.name}｜${def.category}${def.subcategory ? ` · ${def.subcategory}` : ''}`;

    const placed = this.placedCounts[def.id] ?? 0;
    const isFav = this.favoriteSet.has(def.id);
    card.innerHTML =
      `<span class="thumb" style="background:${thumbGradient(def.color)}">${def.icon}</span>` +
      `<span class="meta"><b>${esc(def.name)}</b>` +
      `<small>${esc(def.category)}${def.subcategory ? ` · ${esc(def.subcategory)}` : ''}</small>` +
      (placed > 0 ? `<small>已放 ${placed} 个</small>` : '') +
      `</span>`;

    // 星标用真实的 <span> 节点而不是拼进 HTML 字符串：
    // 1. 卡片本身是 <button>，按钮里嵌按钮是非法 HTML，浏览器会把内层拆出来、点击区域就飘了，
    //    所以用 role/tabindex 让它可聚焦、可被无障碍读到；
    // 2. 用节点而不是 HTML 片段，`data-fav-toggle` 一定能被 `closest()` 找到，
    //    委托点击不依赖浏览器对字符串的解析结果。
    const star = document.createElement('span');
    star.className = 'catalog-star';
    star.dataset.favToggle = '1';
    star.setAttribute('role', 'button');
    star.setAttribute('tabindex', '0');
    star.setAttribute('aria-label', isFav ? '取消收藏' : '收藏');
    star.style.marginLeft = 'auto';
    star.style.padding = '0 4px';
    star.style.fontSize = '14px';
    star.style.lineHeight = '1';
    star.style.cursor = 'pointer';
    star.textContent = isFav ? '★' : '☆';
    card.appendChild(star);
    return card;
  }

  private markSelected(): void {
    for (const card of this.gridContainer.querySelectorAll<HTMLElement>('.item-card')) {
      card.classList.toggle('active', card.getAttribute('data-def-id') === this.selectedId);
    }
  }

  /** 空态：三种原因分别给能直接照做的提示，而不是一句"没有结果" */
  private renderEmptyState(visible: number): void {
    if (visible > 0) {
      this.emptyLabel.textContent = '';
      return;
    }
    if (this.enabled.size === 0) {
      this.emptyLabel.textContent = ALL_PACKS_OFF;
      return;
    }
    const query = this.query.trim();
    if (query) {
      this.emptyLabel.textContent = `没有匹配「${query}」的物品，试试更短的关键词或换一个分类`;
      return;
    }
    if (this.favOnly || this.category === FAV) {
      this.emptyLabel.textContent = '还没有收藏任何物品（点卡片右上角的星标）';
      return;
    }
    this.emptyLabel.textContent = '这个分类下暂时没有可显示的物品，换个分类或打开一个内容包试试';
  }

  /**
   * 列表尾部：还有没显示完的就给一个"显示更多"，同时把哨兵挂上做触底自动加载。
   *
   * 为什么两种方式都留：`IntersectionObserver` 在少数环境里没有（老浏览器 / Node 断言里），
   * 而"滚到底什么也没发生"是最让人困惑的一种失败 —— 按钮是那条兜底路径。
   * 两者都只会让 `visibleCount` 往前走，不会打架（哨兵在按钮不可见时自然不触发）。
   */
  private renderPager(total: number, shown: number): void {
    this.disconnectSentinel();
    if (total === 0) {
      this.pagerContainer.innerHTML = '';
      this.pagerContainer.style.display = 'none';
      return;
    }
    if (shown >= total) {
      // 全部挂完了：给一句明确的收尾，而不是把整条隐藏掉（隐藏会让人以为还有下文）
      this.pagerContainer.style.display = '';
      this.pagerContainer.innerHTML = `<span class="page-info">已经到底了（${total} 个全在这）</span>`;
      return;
    }
    this.pagerContainer.style.display = '';
    this.pagerContainer.innerHTML =
      `<button type="button" data-page="more">显示更多（还有 ${total - shown} 个）</button>`;
    // 触底自动加载。
    //
    // ⚠ 观察器的 root 必须是**真正在滚的那个容器**：物品网格自己有
    // `max-height: 40vh; overflow-y: auto`，所以滚的是 `#catalog-grid` 而不是页面。
    // 第一版把哨兵放在网格外面、用默认 root（视口）—— 于是"在列表里滚到底"
    // 永远不会触发加载，看起来就像"加载坏了"。哨兵现在挂在网格内部，root 指定为网格。
    if (typeof IntersectionObserver === 'function') {
      const sentinel = document.createElement('span');
      sentinel.className = 'scroll-sentinel';
      sentinel.setAttribute('aria-hidden', 'true');
      this.gridContainer.appendChild(sentinel);
      this.sentinelObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) this.loadMore();
        },
        { root: this.gridContainer, rootMargin: '120px' },
      );
      this.sentinelObserver.observe(sentinel);
    }
  }

  /** 再挂一批（触底或点「显示更多」都走这里） */
  private loadMore(): void {
    if (this.disposed) return;
    const total = this.computeList().length;
    if (this.visibleCount >= total) return;
    this.visibleCount += PAGE_SIZE;
    this.renderGrid(true);
  }

  private disconnectSentinel(): void {
    this.sentinelObserver?.disconnect();
    this.sentinelObserver = null;
    // 节点也要摘掉：留着的话它会被算进 childElementCount，
    // 而 childElementCount 正是"已经挂了多少张"的依据 —— 那样每次追加都会错位一张
    this.gridContainer.querySelector('.scroll-sentinel')?.remove();
  }
}

/**
 * 完整参数（悬停 / 聚焦时显示）。
 *
 * 缺字段显示「—」而不是 `undefined`：387 个物品里大部分没有 `textureType` / `lodLevels`，
 * 直接拼字符串会让详情框里出现一屏的 undefined。
 */
export function renderDetail(def: BuildingDef): string {
  const size = def.size.map((value) => value.toFixed(2)).join(' × ');
  return (
    `<b>${def.icon} ${esc(def.name)}</b>　<small>id：${esc(def.id)}</small><br>` +
    `<span class="dim">分类：${esc(def.category)} · ${esc(def.subcategory ?? '—')} ｜ 类型：${esc(def.type)}</span><br>` +
    `<span class="dim">尺寸：${size} m ｜ 质量：${def.mass.toFixed(2)} kg ｜ ` +
    `摩擦：${def.friction.toFixed(2)} ｜ 弹性：${def.restitution.toFixed(2)}</span><br>` +
    `<span class="dim">可堆叠：${def.stackable === undefined ? '—' : def.stackable ? '是' : '否'} ｜ ` +
    `静态：${def.isStatic ? '是' : '否'} ｜ 纹理：${esc(fmt(def.textureType))} ｜ LOD：${fmt(def.lodLevels, 0)}</span><br>` +
    `<span class="dim">图标：${def.icon} ｜ 形状：${def.shape} ｜ 零件：${def.parts.length} 个</span><br>` +
    `<span class="dim">标签：${def.tags.length > 0 ? esc(def.tags.join('、')) : '—'}</span><br>` +
    `<span class="dim">${esc(def.description || '—')}</span>`
  );
}
