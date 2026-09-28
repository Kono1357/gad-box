/**
 * 物理组合面板（ComboPanel）。
 *
 * 「组合」= **已经接好关节 / 触发器 / 连线的成品**：20 个预设分别是"会开的门""会转的风车"
 * "投石机"这类装置，`objects` 摆好位置、`joints` 把铰链/滑轨/绳子/弹簧/电机全部配好参数。
 * 玩家不需要自己调锚点、轴方向、限位与电机力，点一下「摆放」就能直接看到物理效果，
 * 这也是新玩家理解关节玩法的入口（教学关卡教的就是这些装置的手工做法）。
 *
 * 本面板的职责边界（很重要，别越界）：
 * - **只做展示 + 选择**：搜索、分类过滤、卡片信息、已摆数量、错误提示；
 * - **不负责建造**：真正的生成（实例化模型 + 建关节）由 Engine 在 `onSpawnCombo` 回调里做，
 *   所以这个文件里既不 import Engine，也不 import three / Rapier —— 它只碰 DOM 与纯数据。
 * - 卡片上的**静态**信息由 `ComboCardInfo` 提供（Engine 可以从 `buildComboCards(COMBOS)` 拿到，
 *   也可以自己算好再喂进来），动态部分（已摆数量、错误）由 `update()` 喂。
 *
 * 刷新策略：`update()` 每帧都可能被调用，但它的输入是低频的字符串状态，所以**对比签名、变了才刷**，
 * 而不是像 PrefabPanel 那样按时间节流 —— 节流会在"最后一次状态变化刚发生"时把刷新吞掉，
 * 那时候玩家正好盯着面板看（例如刚摆放失败要读错误原因）。
 */

import type { Combo } from '../data/combos';
import { JOINT_TYPE_LABELS } from '../data/jointTypes';
import { getBuildingDef } from '../data/buildingCatalog';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

/** 把文本塞进 innerHTML 前先转义（组合名/描述来自数据文件，但仍然是外部文本） */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 分类过滤里的「不过滤」项，也是分类按钮组的第一项 */
const ALL_CATEGORIES = '全部';
/** combos.ts 里没填分类时的兜底分类 */
const DEFAULT_CATEGORY = '机械';
/** 卡片上最多列几个模型显示名，超出的只报总数 */
const MAX_MODEL_NAMES = 4;

export interface ComboPanelHandlers {
  /** 玩家点了「摆放」——Engine 负责真正生成这个组合 */
  onSpawnCombo(combo: Combo): void;
  /** 玩家点了卡片想看详情（Engine 可以顺手把相机对准预览位置，没有就传空实现） */
  onPreviewCombo?(combo: Combo): void;
  /** 面板打开/关闭状态变化（Engine 用来暂停手势之类） */
  onVisibilityChange?(open: boolean): void;
}

/** 每个组合的**静态**信息（从 combos.ts 算出来，Engine 只喂动态部分） */
export interface ComboCardInfo {
  id: string;
  name: string;
  /** 一句话说明，来自 combos.ts 里的描述字段；没有就由 ComboPanel 用零件数凑一句 */
  summary: string;
  /** 零件数量 */
  objectCount: number;
  /** 关节数量 */
  jointCount: number;
  /** 用到了哪些关节类型（中文标签），来自 src/data/jointTypes.ts 的 JOINT_TYPE_LABELS */
  jointTypes: string[];
  /** 涉及的主要模型显示名（最多 4 个，超出显示「等 N 种」） */
  modelNames: string[];
  /** 分类标签（如果 combos.ts 里有 category 之类的字段就用；没有就全部归到「机械」） */
  category: string;
}

/** 运行时状态（Engine 每帧/按需喂进来） */
export interface ComboPanelStats {
  /** 当前世界里已经摆了几个（Engine 统计） */
  placedCounts: Record<string, number>;
  /** 上一次摆摆放失败的原因（没有则 undefined） */
  lastError?: string;
  /** 是否处于物理沙盘模式（只影响标题旁的小字提示） */
  sandboxMode?: boolean;
}

/** 取模型显示名：优先用模型库里的中文名，查不到就退回 defId（总比空白强） */
function modelDisplayName(defId: string): string {
  return getBuildingDef(defId)?.name ?? defId;
}

/** 组合用到了几种不同的模型（按 defId 去重，用来判断要不要显示「等 N 种」） */
function countDistinctModels(combo: Combo): number {
  return new Set(combo.objects.map((piece) => piece.defId)).size;
}

/** 组合用到的关节类型中文标签（按出现顺序去重） */
function collectJointLabels(combo: Combo): string[] {
  const labels: string[] = [];
  for (const joint of combo.joints) {
    const label = JOINT_TYPE_LABELS[joint.type];
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** 组合涉及的主要模型显示名（按出现顺序去重，最多 MAX_MODEL_NAMES 个） */
function collectModelNames(combo: Combo): string[] {
  const names: string[] = [];
  for (const piece of combo.objects) {
    const name = modelDisplayName(piece.defId);
    if (!names.includes(name)) names.push(name);
    if (names.length >= MAX_MODEL_NAMES) break;
  }
  return names;
}

/**
 * 把 combos.ts 的原始数据一次性算成卡片信息。
 *
 * 导出来是给 Engine 少写点胶水代码用的：`panel.setCombos(buildComboCards(COMBOS), COMBOS)`。
 * Engine 也可以自己算（比如想去重掉某些测试组合），面板照样能收。
 */
export function buildComboCards(combos: readonly Combo[]): ComboCardInfo[] {
  return combos.map((combo) => ({
    id: combo.id,
    name: combo.name,
    summary: combo.description || `${combo.objects.length} 个零件拼好的成品，放下去就能直接跑物理。`,
    objectCount: combo.objects.length,
    jointCount: combo.joints.length,
    jointTypes: collectJointLabels(combo),
    modelNames: collectModelNames(combo),
    category: combo.category || DEFAULT_CATEGORY,
  }));
}

/**
 * 「物理组合」面板。
 *
 * 交互取舍：
 * 1. **卡片只负责"看"，摆放必须点按钮** —— 手机上手指扫过卡片列表太容易误触，
 *    而"把一个完整装置丢进世界"这个动作要么不做、要么明确做（沿用 PrefabPanel 的取舍）；
 * 2. **卡片整批重建，事件用委托** —— 组合数量固定为 20，重建很便宜，
 *    但逐个绑监听会随着以后加组合线性变慢，所以列表上只挂一份委托监听；
 * 3. **摆放失败的原因写进状态行** —— 失败往往是因为位置上已经有东西或者不在地面上，
 *    不告诉玩家原因的话，点下去"什么都没发生"最让人迷惑。
 */
export class ComboPanel {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly categories: HTMLElement;
  private readonly status: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  /** 标题旁的小字（物理沙盘模式提示），由面板自己创建，index.html 里不需要写 */
  private readonly sandboxNote: HTMLElement;

  private cards: ComboCardInfo[] = [];
  private readonly comboById = new Map<string, Combo>();
  private categoryNames: string[] = [ALL_CATEGORIES];
  private activeCategory: string = ALL_CATEGORIES;
  private query = '';
  private placedCounts: Record<string, number> = {};
  private lastError: string | undefined;
  private sandboxMode = false;
  /** 上一次 update() 的状态签名，用来判断"有没有真的变化" */
  private lastSignature = '';
  /** 首次 setCombos 时要自动激活第一个分类 */
  private awaitingFirstSet = true;
  /** 上一次悬停预览过的卡片 id，避免同一个卡片反复回调 Engine */
  private previewedId: string | null = null;
  private disposed = false;

  constructor(private readonly handlers: ComboPanelHandlers) {
    this.root = must<HTMLElement>('#combo-panel');
    this.list = must<HTMLElement>('#combo-list', this.root);
    this.search = must<HTMLInputElement>('#combo-search', this.root);
    this.categories = must<HTMLElement>('#combo-categories', this.root);
    this.status = must<HTMLElement>('#combo-status', this.root);
    this.closeButton = must<HTMLButtonElement>('#combo-close', this.root);

    // 复用现有样式：卡片列表用 #prefab-panel 那套 .map-list 双列网格，
    // 分类按钮组用 .chip-list 横向换行。index.html 里已经写了也不冲突（add 不会去重样式之外的语义）。
    this.list.classList.add('map-list');
    this.categories.classList.add('chip-list');

    // 「物理沙盘模式」的小字提示：面板自己插一个 <p>，不用额外占一个 id。
    // 插到搜索框前面（搜索框的父节点就一定是它所在的容器，直接插到 root 下会因为
    // 搜索框被包在 <details> 里而报 NotFoundError）
    this.sandboxNote = document.createElement('p');
    this.sandboxNote.className = 'inline-label dim';
    const noteParent = this.search.parentElement ?? this.root;
    noteParent.insertBefore(this.sandboxNote, this.search);

    if (!this.search.placeholder) this.search.placeholder = '搜索组合（名称 / 说明 / 模型）';

    this.search.addEventListener('input', this.handleSearchInput);
    this.categories.addEventListener('click', this.handleCategoryClick);
    this.list.addEventListener('click', this.handleListClick);
    this.list.addEventListener('mouseover', this.handleListHover);
    this.closeButton.addEventListener('click', this.handleCloseClick);
  }

  private readonly handleSearchInput = (): void => {
    // 统一转小写：英文与拼音大小写不敏感，中文 toLowerCase 后原样保留，直接 includes 即可
    this.query = this.search.value.trim().toLowerCase();
    this.renderList();
  };

  private readonly handleCategoryClick = (ev: MouseEvent): void => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>('[data-combo-category]');
    if (!button) return;
    const name = button.dataset.comboCategory;
    if (!name || name === this.activeCategory) return;
    this.activeCategory = name;
    this.syncCategoryButtons();
    this.renderList();
  };

  private readonly handleListClick = (ev: MouseEvent): void => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const card = target.closest<HTMLElement>('[data-combo-id]');
    if (!card) return;
    const combo = this.comboById.get(card.dataset.comboId ?? '');
    if (!combo) return;

    // 卡片上只有「摆放」按钮会真的建造；点卡片空白处 = 看详情
    if (target.closest('[data-place]')) {
      this.handlers.onSpawnCombo(combo);
      return;
    }
    this.handlers.onPreviewCombo?.(combo);
  };

  private readonly handleListHover = (ev: MouseEvent): void => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const card = target.closest<HTMLElement>('[data-combo-id]');
    if (!card) return;
    const id = card.dataset.comboId ?? '';
    if (!id || id === this.previewedId) return;
    this.previewedId = id;
    const combo = this.comboById.get(id);
    if (combo) this.handlers.onPreviewCombo?.(combo);
  };

  private readonly handleCloseClick = (): void => {
    this.close();
  };

  /** 首次渲染（构造后由 Engine 调一次） */
  setCombos(cards: ComboCardInfo[], combos: Combo[]): void {
    if (this.disposed) return;

    this.comboById.clear();
    for (const combo of combos) this.comboById.set(combo.id, combo);

    // 兜底：Engine 只喂了 combos（cards 为空）时，面板自己把静态信息算出来，
    // 否则玩家会看到一个永远空着的面板，还以为是数据没加载
    const source = cards.length > 0 ? cards : buildComboCards(combos);
    this.cards = source.map((card) => this.fillMissingFields(card));

    // 分类从数据里聚合：第一项固定是「全部」，其余按数据里首次出现的顺序
    this.categoryNames = [ALL_CATEGORIES];
    for (const card of this.cards) {
      if (!this.categoryNames.includes(card.category)) this.categoryNames.push(card.category);
    }
    if (this.awaitingFirstSet) {
      // 契约要求：首次 setCombos 把第一个分类设为激活（聚合结果第一项就是「全部」）
      this.activeCategory = this.categoryNames[0] ?? ALL_CATEGORIES;
      this.awaitingFirstSet = false;
    } else if (!this.categoryNames.includes(this.activeCategory)) {
      // 重新喂数据后原来的分类可能已经不存在了，退回「全部」
      this.activeCategory = ALL_CATEGORIES;
    }

    this.renderCategories();
    this.renderList();
    this.renderStatus();
    // 签名清空：下一次 update() 一定会把「已摆 N 个」写进新卡片
    this.lastSignature = '';
  }

  /** 卡片缺字段时用 combos.ts 的原始数据补齐（Engine 传半成品卡片的容错） */
  private fillMissingFields(card: ComboCardInfo): ComboCardInfo {
    const combo = this.comboById.get(card.id);
    const fallback = combo ? buildComboCards([combo])[0]! : undefined;
    return {
      id: card.id,
      name: card.name || fallback?.name || card.id,
      summary:
        card.summary ||
        fallback?.summary ||
        `${card.objectCount} 个零件拼好的成品，放下去就能直接跑物理。`,
      objectCount: card.objectCount || fallback?.objectCount || 0,
      jointCount: card.jointCount ?? fallback?.jointCount ?? 0,
      jointTypes: card.jointTypes?.length ? card.jointTypes : (fallback?.jointTypes ?? []),
      modelNames: card.modelNames?.length ? card.modelNames : (fallback?.modelNames ?? []),
      category: card.category || fallback?.category || DEFAULT_CATEGORY,
    };
  }

  /** 每帧调用（内部对比签名，状态没变直接返回） */
  update(stats: ComboPanelStats): void {
    if (this.disposed) return;

    const counts = Object.keys(stats.placedCounts)
      .sort()
      .map((id) => `${id}:${stats.placedCounts[id] ?? 0}`)
      .join(',');
    const signature = `${stats.sandboxMode ? '1' : '0'}|${stats.lastError ?? ''}|${counts}`;
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    this.placedCounts = stats.placedCounts;
    this.lastError = stats.lastError;
    this.sandboxMode = Boolean(stats.sandboxMode);

    this.sandboxNote.textContent = this.sandboxMode
      ? '物理沙盘模式：组合放下后立刻参与物理模拟'
      : '';
    this.renderStatus();
    this.renderPlacedCounts();
  }

  private syncCategoryButtons(): void {
    for (const button of this.categories.querySelectorAll<HTMLButtonElement>('[data-combo-category]')) {
      button.classList.toggle('active', button.dataset.comboCategory === this.activeCategory);
    }
  }

  private renderCategories(): void {
    this.categories.innerHTML = '';
    for (const name of this.categoryNames) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.dataset.comboCategory = name;
      button.classList.toggle('active', name === this.activeCategory);
      button.textContent = name;
      this.categories.appendChild(button);
    }
  }

  private renderStatus(): void {
    if (this.lastError) {
      this.status.textContent = `⚠ ${this.lastError}`;
      this.status.style.color = 'var(--danger)';
      return;
    }
    this.status.style.color = '';
    this.status.textContent = this.cards.length > 0
      ? `共 ${this.cards.length} 个组合 · 点「摆放」放到光标位置`
      : '组合数据还没加载';
  }

  /** 卡片上的「已摆 N 个」徽标：只改文字，不重建卡片（每帧重建会丢滚动位置与选中态） */
  private renderPlacedCounts(): void {
    for (const card of this.list.querySelectorAll<HTMLElement>('[data-combo-id]')) {
      const badge = card.querySelector<HTMLElement>('[data-count]');
      if (!badge) continue;
      const placed = this.placedCounts[card.dataset.comboId ?? ''] ?? 0;
      badge.textContent = placed > 0 ? `已摆 ${placed} 个` : '未摆放';
    }
  }

  /** 搜索：名称 / 说明 / 模型名，大小写不敏感 */
  private matches(card: ComboCardInfo): boolean {
    if (this.activeCategory !== ALL_CATEGORIES && card.category !== this.activeCategory) return false;
    if (!this.query) return true;
    const haystack = `${card.name} ${card.summary} ${card.modelNames.join(' ')}`.toLowerCase();
    return haystack.includes(this.query);
  }

  private renderList(): void {
    this.list.innerHTML = '';
    const visible = this.cards.filter((card) => this.matches(card));

    if (visible.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = this.cards.length === 0
        ? '还没有组合数据（Engine 调 setCombos 后才会出现卡片）'
        : '没有匹配的组合，换个关键词或者切回「全部」试试';
      this.list.appendChild(empty);
      return;
    }

    for (const card of visible) this.list.appendChild(this.buildCard(card));
  }

  private buildCard(card: ComboCardInfo): HTMLElement {
    const combo = this.comboById.get(card.id);
    const placed = this.placedCounts[card.id] ?? 0;

    // 模型名：卡片最多记 4 个，超出的用原始数据算出"共几种"
    const totalModels = combo ? countDistinctModels(combo) : card.modelNames.length;
    const shownNames = card.modelNames.slice(0, MAX_MODEL_NAMES).join('、');
    const modelText = totalModels > MAX_MODEL_NAMES
      ? `${shownNames} 等 ${totalModels} 种`
      : shownNames;
    const jointText = card.jointTypes.length > 0
      ? card.jointTypes.map((label) => `<i>${escapeHtml(label)}</i>`).join('')
      : '<i>无关节</i>';

    const el = document.createElement('div');
    el.className = 'map-card';
    el.dataset.comboId = card.id;
    // .map-card 原本是给 <button> 用的，这里换成一个包着按钮的 <div>（按钮不能嵌套按钮），
    // 所以补一点内联的底色与描边，视觉上仍然是同一张卡片
    el.style.cssText =
      'background:rgba(24,30,36,.9);border:1px solid var(--panel-border);cursor:pointer';
    el.innerHTML =
      `<span class="map-thumb" style="font-size:24px">${escapeHtml(combo?.thumbnail ?? '⚙️')}</span>` +
      `<span class="map-body">` +
      `<span class="map-title"><b>${escapeHtml(card.name)}</b>` +
      `<em class="diff">${escapeHtml(card.category)}</em>` +
      `<em class="size" data-count="1">${placed > 0 ? `已摆 ${placed} 个` : '未摆放'}</em></span>` +
      `<span class="map-desc">${escapeHtml(card.summary)}</span>` +
      `<span class="map-tags">${jointText}</span>` +
      `<span class="map-tip">🧱 ${card.objectCount} 个零件 / ${card.jointCount} 个关节` +
      `${modelText ? ` · ${escapeHtml(modelText)}` : ''}</span>` +
      `<button type="button" data-place="1" title="把这个组合摆到光标位置">摆放</button>` +
      `</span>`;
    return el;
  }

  open(): void {
    if (this.disposed || this.isOpen) return;
    this.root.classList.toggle('visible', true);
    this.handlers.onVisibilityChange?.(true);
  }

  close(): void {
    if (this.disposed || !this.isOpen) return;
    this.root.classList.toggle('visible', false);
    this.previewedId = null;
    this.handlers.onVisibilityChange?.(false);
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  get isOpen(): boolean {
    return this.root.classList.contains('visible');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.search.removeEventListener('input', this.handleSearchInput);
    this.categories.removeEventListener('click', this.handleCategoryClick);
    this.list.removeEventListener('click', this.handleListClick);
    this.list.removeEventListener('mouseover', this.handleListHover);
    this.closeButton.removeEventListener('click', this.handleCloseClick);
    this.list.innerHTML = '';
    this.sandboxNote.remove();
  }
}
