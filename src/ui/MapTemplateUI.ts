/**
 * 地图模板选择界面（M4 补充 4 + 补充 5）：8 张模板卡片 + 参数滑杆 + 生成/预览 + 回滚入口。
 *
 * ────────────────────────────────────────────────────────────
 * 三条刻意的设计（都写在这里，免得以后被当成疏漏）
 * ────────────────────────────────────────────────────────────
 * 1. **缩略图懒加载**：8 个模板各算一次预览 ≈ 每个 20~30 ms。一次全算就是 200 ms 的
 *    连续主线程占用 —— 而那正是用户反馈的「生成时卡顿」的同类问题，不该由面板制造出来。
 *    所以卡片进入视口（IntersectionObserver）才 `buildPreview()`；
 *    Node / 老浏览器没有 IntersectionObserver 时**降级为直接算**（宁可慢，不能空着）。
 * 2. **滑杆范围只来自 `TEMPLATE_PARAM_LIMITS`**：面板不自己写 min/max。
 *    两边各写一份，迟早出现「滑杆能拖到 3，但校验只认到 2」这种自相矛盾的状态。
 * 3. **非法参数不静默夹回**：`setParam()` 原样存下来，由 `validateTemplateParams()`
 *    报错 → 界面标红 + 禁用生成。悄悄夹回会让玩家以为自己的调整生效了（其实没有）——
 *    而「我拖了但它没用」比「它告诉我这个值不行」难查得多。
 *
 * ────────────────────────────────────────────────────────────
 * 这个类不碰什么（边界）
 * ────────────────────────────────────────────────────────────
 * 它**不生成世界、不写体素、不认识流水线**：只读模板数据 + 调 handlers。
 * 生成是世界的事，面板只负责「把玩家的意图说清楚」。
 * `container` 传 null 时进入**无 DOM 模式**：状态与校验照常工作（Node 下测的就是这条路径），
 * 只是不画界面 —— 逻辑测试不该因为「没有浏览器」而只能跳过。
 */

import {
  DEFAULT_TEMPLATE_ID,
  getMapTemplate,
  MAP_TEMPLATES,
  TEMPLATE_PARAM_LIMITS,
  TERRAIN_TYPE_LABELS,
  validateTemplateParams,
  type MapTemplate,
  type MapTemplateParams,
} from '../data/mapTemplates';
import { buildPreview, renderPreviewCanvas, type PreviewData } from '../world/GenerationPreview';

export interface TemplateOverrides {
  [param: string]: number;
}

export interface MapTemplateUIHandlers {
  onGenerate(request: { templateId: string; seed: number; overrides: TemplateOverrides }): void;
  onPreview(request: { templateId: string; seed: number; overrides: TemplateOverrides }): void;
  onRollback?(reason: string): void;
}

/** 回滚记录：只存参数与种子 —— 见 ROLLBACK_NOTE */
interface LastGenerationRecord {
  templateId: string;
  seed: number;
  overrides: TemplateOverrides;
  /** 写入时间（毫秒）；旧存档可能没有，缺失时为 null，不编一个数出来 */
  at: number | null;
}

/** sessionStorage 的键（自起名字，与其它模块的前缀不冲突） */
const STORAGE_KEY = 'god-sandbox-last-generation';
/** 缩略图采样分辨率：卡片上就一百多像素宽，48×48 已经看不出块 */
const THUMB_RESOLUTION = 48;
/** 缩略图元素边长（CSS 像素） */
const THUMB_SIZE = 132;

/** 参数顺序与中文名（顺序固定，免得每次打开面板滑杆位置都在变） */
type ParamKey = keyof typeof TEMPLATE_PARAM_LIMITS;
const PARAM_KEYS: readonly ParamKey[] = [
  'heightScale',
  'waterRatio',
  'treeDensity',
  'buildingDensity',
  'itemDensity',
];

const PARAM_LABELS: Record<ParamKey, string> = {
  heightScale: '地形起伏',
  waterRatio: '水体比例',
  treeDensity: '树木密度',
  buildingDensity: '建筑密度',
  itemDensity: '小物品密度',
};

/**
 * 每个参数的「基准是多少」。
 *
 * 这些文字不是随便写的，逐条对应代码：
 * - 起伏：`GenerationPipeline.terrainParamsWithRatios()` 里 `amplitude = 基准 × (0.4 + 1.2 × 倍率)`；
 * - 水位：同处的 `waterLevel = 世界档区间的最低值 + 区间 × (0.15 + 0.5 × 倍率)`；
 * - 树：`ObjectPlacer.place()` 里 `baseCount = 面积 / 40 × 密度`；
 * - 建筑：`GenerationPipeline` 阶段 6 传 `targetCount = round(6 × 密度)`；
 * - 小物品：`BuildingPlanner.furnish()` 里 `perPlot = round(密度 × 3)`。
 * 改了上面任何一处，这段文案要跟着改 —— 否则面板就在骗人。
 */
const PARAM_BASELINES: Record<ParamKey, string> = {
  heightScale: '倍率：实际振幅 = 世界档基准振幅 ×（0.4 + 1.2 × 本值），×1 约为基准起伏',
  waterRatio: '水位落在世界档高度区间的 15% ~ 65% 处：本值越大水面越高（0.05 ≈ 几乎没有水）',
  treeDensity: '倍率：基准是每 40 平方米一个「基础单位」，×1 = 按基准撒，×0 = 完全不种',
  buildingDensity: '倍率：基准是 6 块地，算法取 round(6 × 本值)',
  itemDensity: '倍率：基准是每块地 3 个小物品，算法取 round(本值 × 3)',
};

/**
 * 回滚的边界，必须写在按钮旁边（用户要求）。
 * 体素不进快照的原因不是懒：标准档 96×24×96 的体素数据是几 MB 级，
 * 存进 sessionStorage 既超配额（通常 5MB）又会拖慢每次生成 —— 所以只能回滚参数。
 */
const ROLLBACK_NOTE = '回滚只恢复「模板与种子等参数」，不会回滚已经生成的体素（体素快照太占内存）。';

const APPROX_NOTE = '所有缩略图与预览都是「近似预览」：降采样 + 高度场，不是真实生成的体素。';

/** 建立 DOM 节点的小工具（面板只读自己的节点，不上 style.css：少一处会和别处冲突的地方） */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  styles?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (styles) Object.assign(node.style, styles);
  return node;
}

/** 数字格式化：非有限数一律显示「不可用」，不显示 NaN */
function fmtNum(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '不可用';
}

export class MapTemplateUI {
  /** 是否真的建 DOM。container 为 null、或极端环境下没有 document 时，逻辑照跑、界面不画 */
  private readonly domEnabled: boolean;

  private templateId: string = DEFAULT_TEMPLATE_ID;
  private seedValue: number = getMapTemplate(DEFAULT_TEMPLATE_ID)?.params.seed ?? 0;
  private readonly overrides: TemplateOverrides = {};
  private problems: string[] = [];

  private busy = false;
  private busyLabel = '';
  private statusText = '';
  private lastRecord: LastGenerationRecord | null;

  private readonly listeners: { target: EventTarget; type: string; handler: EventListener }[] = [];
  private observer: IntersectionObserver | null = null;
  /** 每张卡片是否已经算过缩略图（懒加载的账本，避免滚动来回时反复重算） */
  private readonly thumbDone: boolean[] = MAP_TEMPLATES.map(() => false);
  /** 每张卡片已经拿到的预览数据（限制清单要用） */
  private readonly thumbData: (PreviewData | null)[] = MAP_TEMPLATES.map(() => null);

  // DOM 引用（无 DOM 模式下全是 null）
  private cardsBox: HTMLElement | null = null;
  private cards: HTMLElement[] = [];
  private thumbs: HTMLCanvasElement[] = [];
  private paramRows = new Map<ParamKey, { row: HTMLElement; range: HTMLInputElement; value: HTMLElement; hint: HTMLElement }>();
  private paramsTitle: HTMLElement | null = null;
  private problemsBox: HTMLElement | null = null;
  private seedInput: HTMLInputElement | null = null;
  private generateButton: HTMLButtonElement | null = null;
  private previewButton: HTMLButtonElement | null = null;
  private rollbackButton: HTMLButtonElement | null = null;
  private busyBox: HTMLElement | null = null;
  private statusBox: HTMLElement | null = null;
  private limitationsBox: HTMLElement | null = null;

  private disposed = false;

  constructor(
    container: HTMLElement | null,
    private readonly handlers: MapTemplateUIHandlers,
  ) {
    this.domEnabled = container !== null && typeof document !== 'undefined';
    this.lastRecord = this.loadRecord();

    if (this.domEnabled && container) {
      this.buildDom(container);
      this.refresh();
    }
  }

  // ------------------------------------------------------------------ 对外接口

  /** 选中某个模板（未知 id 会被忽略并记一条状态，不会把界面切成半截状态） */
  setSelected(templateId: string): void {
    const template = getMapTemplate(templateId);
    if (!template) {
      this.setStatus(`没有这个模板：${templateId}`);
      return;
    }
    this.templateId = template.id;
    // 换模板时把覆盖值清掉、种子换成模板默认：上一个模板的调整（例如「树密度 1.8」）
    // 套到别的模板上没有意义，留着只会让玩家以为新模板就是这个密度
    for (const key of PARAM_KEYS) delete this.overrides[key];
    this.seedValue = template.params.seed;
    this.refresh();
    const index = MAP_TEMPLATES.findIndex((item) => item.id === template.id);
    // 选中的卡片一定是玩家刚点过的（在视口里），所以这里算缩略图不违背「懒加载」的初衷
    if (index >= 0) this.ensureThumbnail(index);
  }

  setBusy(busy: boolean, label?: string): void {
    this.busy = busy;
    this.busyLabel = label ?? '';
    this.refresh();
  }

  /** 重新把状态画到界面上（dispose 之后调用是安全的空操作） */
  refresh(): void {
    if (this.disposed || !this.domEnabled) return;
    this.syncCards();
    this.syncParams();
    this.syncButtons();
    this.syncLimitations();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { target, type, handler } of this.listeners) target.removeEventListener(type, handler);
    this.listeners.length = 0;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  // ------------------------------------------------------------------ 状态查询（给 Engine / 测试用）

  get currentTemplateId(): string {
    return this.templateId;
  }

  get currentSeed(): number {
    return this.seedValue;
  }

  /** 当前参数（模板默认值 + 覆盖值 + 当前种子），与 `validateTemplateParams` 的入参完全一致 */
  getParams(): MapTemplateParams {
    const template = this.template();
    const merged: MapTemplateParams = { ...template.params, seed: this.seedValue };
    const raw = merged as unknown as Record<string, number>;
    for (const key of PARAM_KEYS) {
      const value = this.overrides[key];
      if (typeof value === 'number') raw[key] = value;
    }
    return merged;
  }

  /** 当前参数的问题列表 —— 与 `validateTemplateParams(getParams())` 是同一份结果 */
  getProblems(): readonly string[] {
    return validateTemplateParams(this.getParams());
  }

  /** 当前参数里与模板默认值不同的那几项（Engine 用得上：只把差异当覆盖传下去也行） */
  getOverrides(): TemplateOverrides {
    const overrides: TemplateOverrides = {};
    for (const key of PARAM_KEYS) {
      const value = this.overrides[key];
      if (typeof value === 'number') overrides[key] = value;
    }
    return overrides;
  }

  get hasRollbackRecord(): boolean {
    return this.lastRecord !== null;
  }

  /** 没有可回滚记录时的中文原因（写日志用，不编数字） */
  get rollbackUnavailableReason(): string {
    return '没有可回滚的记录：sessionStorage 不可用、被清空，或还没有点过「生成」';
  }

  /**
   * 设置某个参数。**不做区间夹取**（见文件头第 3 条）：越界值会被校验标红并禁用生成。
   * 滑杆自己带着 min/max，所以正常拖动永远不会越界；越界只可能来自程序调用或旧存档。
   */
  setParam(key: string, value: number): void {
    if (!PARAM_KEYS.includes(key as ParamKey)) {
      this.setStatus(`未知参数：${key}（只认 ${PARAM_KEYS.join(' / ')}）`);
      return;
    }
    this.overrides[key] = value;
    this.refresh();
  }

  setSeed(seed: number): void {
    this.seedValue = Number.isFinite(seed) ? Math.floor(seed) : this.seedValue;
    this.refresh();
  }

  /**
   * 把当前参数记为「上一次成功生成」——Engine 在生成真正成功后调用它。
   *
   * 为什么还要这个显式入口：面板自己**不知道生成成不成功**，只能在点「生成」时先记一份
   * （记的是「提交过的参数」）。Engine 生成成功后调这个方法，能把记录纠正为「确实成功的那一份」。
   */
  rememberLastSuccess(): void {
    this.saveRecord({
      templateId: this.templateId,
      seed: this.seedValue,
      overrides: this.getOverrides(),
      at: Date.now(),
    });
    this.refresh();
  }

  // ------------------------------------------------------------------ DOM 构建

  private buildDom(container: HTMLElement): void {
    container.textContent = '';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '8px';

    const head = el('div', undefined, { display: 'flex', flexDirection: 'column', gap: '2px' });
    head.appendChild(el('b', '地图模板（M4）：选一套参数，先生成预览再决定'));
    head.appendChild(el('small', APPROX_NOTE, { opacity: '0.72' }));
    container.appendChild(head);

    // ---- 8 张卡片
    this.cardsBox = el('div', undefined, {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))',
      gap: '6px',
    });
    container.appendChild(this.cardsBox);
    for (let index = 0; index < MAP_TEMPLATES.length; index += 1) {
      this.cardsBox.appendChild(this.buildCard(index));
    }
    this.on(this.cardsBox, 'click', (event) => {
      const id = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-template-id]')
        ?.dataset.templateId;
      if (id) this.setSelected(id);
    });

    // ---- 参数区
    const params = el('div', undefined, {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      borderTop: '1px solid rgba(255,255,255,0.14)',
      paddingTop: '6px',
    });
    container.appendChild(params);
    this.paramsTitle = el('b', '参数（基准见每行小字）');
    params.appendChild(this.paramsTitle);

    for (const key of PARAM_KEYS) {
      const limit = TEMPLATE_PARAM_LIMITS[key];
      const row = el('div', undefined, { display: 'flex', flexDirection: 'column', gap: '0' });
      const line = el('div', undefined, { display: 'flex', alignItems: 'center', gap: '6px' });
      line.appendChild(el('span', PARAM_LABELS[key], { minWidth: '76px', fontSize: '12px' }));
      const range = el('input');
      range.type = 'range';
      range.min = String(limit.min);
      range.max = String(limit.max);
      range.step = String(limit.step);
      range.style.flex = '1 1 auto';
      line.appendChild(range);
      const value = el('span', '—', { minWidth: '52px', textAlign: 'right', fontSize: '12px' });
      line.appendChild(value);
      row.appendChild(line);
      const hint = el('small', PARAM_BASELINES[key], { opacity: '0.62', fontSize: '10px' });
      row.appendChild(hint);
      params.appendChild(row);
      this.paramRows.set(key, { row, range, value, hint });

      this.on(range, 'input', () => {
        const parsed = Number(range.value);
        if (!Number.isFinite(parsed)) return;
        this.overrides[key] = parsed;
        // 拖动时只刷新文案与校验，**不要**回写 range.value：回写会让手指和滑杆打架
        this.syncParams();
        this.syncButtons();
      });
    }

    this.problemsBox = el('small', '', { color: '#ff8a7a', fontSize: '11px' });
    params.appendChild(this.problemsBox);

    // ---- 种子
    const seedRow = el('div', undefined, { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' });
    seedRow.appendChild(el('span', '种子', { minWidth: '76px', fontSize: '12px' }));
    this.seedInput = el('input');
    this.seedInput.type = 'number';
    this.seedInput.style.width = '110px';
    seedRow.appendChild(this.seedInput);
    const randomButton = el('button', '随机种子');
    randomButton.type = 'button';
    const timeButton = el('button', '用当前时间当种子');
    timeButton.type = 'button';
    seedRow.appendChild(randomButton);
    seedRow.appendChild(timeButton);
    params.appendChild(seedRow);
    // 「用当前时间当种子」的说明必须写清楚：Date.now() 只保证「和上一次大概率不同」，
    // 它可预测、也可能同一毫秒内重复，**不是真随机**
    params.appendChild(
      el('small', '「随机种子」用 Math.random()；「当前时间」用 Date.now()，只保证大概率换了一张图，不是真随机。', {
        opacity: '0.62',
        fontSize: '10px',
      }),
    );

    this.on(this.seedInput, 'change', () => {
      const parsed = Number(this.seedInput?.value);
      if (Number.isFinite(parsed)) this.setSeed(parsed);
      else this.syncParams();
    });
    this.on(randomButton, 'click', () => {
      this.setSeed(Math.floor(Math.random() * 1_000_000));
    });
    this.on(timeButton, 'click', () => {
      this.setSeed(Date.now());
    });

    // ---- 操作按钮
    const actions = el('div', undefined, { display: 'flex', gap: '6px', flexWrap: 'wrap' });
    params.appendChild(actions);
    this.generateButton = el('button', '生成');
    this.generateButton.type = 'button';
    this.previewButton = el('button', '预览');
    this.previewButton.type = 'button';
    this.rollbackButton = el('button', '回到上一次的模板与种子');
    this.rollbackButton.type = 'button';
    actions.appendChild(this.generateButton);
    actions.appendChild(this.previewButton);
    actions.appendChild(this.rollbackButton);

    this.busyBox = el('small', '', { fontSize: '11px', opacity: '0.85' });
    this.statusBox = el('small', '', { fontSize: '11px', opacity: '0.7' });
    params.appendChild(this.busyBox);
    params.appendChild(this.statusBox);

    // ---- 回滚边界说明（压在按钮下面）
    params.appendChild(el('small', ROLLBACK_NOTE, { opacity: '0.62', fontSize: '10px' }));

    // ---- 当前模板的预览限制清单
    const limitBox = el('div', undefined, {
      borderTop: '1px solid rgba(255,255,255,0.14)',
      paddingTop: '4px',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
    });
    limitBox.appendChild(el('b', '预览做不到的事（如实陈列）', { fontSize: '12px' }));
    this.limitationsBox = el('div', '', { fontSize: '10px', opacity: '0.72', whiteSpace: 'pre-wrap' });
    limitBox.appendChild(this.limitationsBox);
    container.appendChild(limitBox);

    this.on(this.generateButton, 'click', () => {
      this.requestGenerate();
    });
    this.on(this.previewButton, 'click', () => {
      this.requestPreview();
    });
    this.on(this.rollbackButton, 'click', () => {
      this.requestRollback();
    });

    this.setupLazyThumbs();
  }

  private buildCard(index: number): HTMLElement {
    const template = MAP_TEMPLATES[index]!;
    const card = el('button');
    card.type = 'button';
    card.dataset.templateId = template.id;
    Object.assign(card.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      textAlign: 'left',
      padding: '4px',
      cursor: 'pointer',
      // 卡片底色用模板自己的调色板做渐变（不引图片资源；这与 mapTemplates 里
      // 缩略图颜色的用途是一致的，所以直接复用 palette）
      background: templateGradientOf(template),
      color: '#10161c',
      border: '2px solid transparent',
      borderRadius: '6px',
    });

    const title = el('span', `${template.emoji} ${template.name}`, { fontSize: '12px', fontWeight: 'bold' });
    card.appendChild(title);
    card.appendChild(el('small', `${TERRAIN_TYPE_LABELS[template.terrainType]}·${template.recommended}`, {
      fontSize: '10px',
      opacity: '0.8',
    }));

    const canvas = el('canvas');
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    Object.assign(canvas.style, {
      width: '100%',
      height: 'auto',
      aspectRatio: '1 / 1',
      background: 'rgba(0,0,0,0.25)',
      borderRadius: '4px',
    });
    card.appendChild(canvas);
    card.appendChild(el('small', '缩略图 = 模板默认参数的近似预览（改参数后点「预览」）', {
      fontSize: '9px',
      opacity: '0.7',
    }));

    this.cards.push(card);
    this.thumbs.push(canvas);
    return card;
  }

  /**
   * 懒加载：卡片进视口才算缩略图。
   * 没有 IntersectionObserver（老浏览器 / Node）时降级为**直接算** ——
   * 空白卡片比多花 200 ms 更糟：玩家会以为面板坏了。
   */
  private setupLazyThumbs(): void {
    if (typeof IntersectionObserver === 'function') {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const id = (entry.target as HTMLElement).dataset.templateId;
            const index = MAP_TEMPLATES.findIndex((template) => template.id === id);
            if (index >= 0) this.ensureThumbnail(index);
          }
        },
        { rootMargin: '80px' },
      );
      for (const card of this.cards) this.observer.observe(card);
      return;
    }
    for (let index = 0; index < this.cards.length; index += 1) this.ensureThumbnail(index);
  }

  /** 算并画某张卡片的缩略图（已经算过就直接返回；算失败时如实写「预览不可用」） */
  private ensureThumbnail(index: number): void {
    if (!this.domEnabled || this.disposed || this.thumbDone[index]) return;
    const template = MAP_TEMPLATES[index];
    const canvas = this.thumbs[index];
    if (!template || !canvas) return;
    this.thumbDone[index] = true;
    try {
      const data = buildPreview({
        templateId: template.id,
        seed: template.params.seed,
        resolution: THUMB_RESOLUTION,
      });
      this.thumbData[index] = data;
      renderPreviewCanvas(canvas, data, { showPlots: true, showNature: true, showWater: true });
    } catch (error) {
      // 预览算不出来就说算不出来（原因原样写出来），不画一张假图顶上
      canvas.title = `预览不可用：${error instanceof Error ? error.message : String(error)}`;
      this.thumbData[index] = null;
    }
    if (template.id === this.templateId) this.syncLimitations();
  }

  // ------------------------------------------------------------------ 同步显示

  private syncCards(): void {
    for (let index = 0; index < this.cards.length; index += 1) {
      const card = this.cards[index]!;
      const active = MAP_TEMPLATES[index]!.id === this.templateId;
      card.style.borderColor = active ? '#ffd166' : 'transparent';
      card.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  private syncParams(): void {
    if (!this.domEnabled) return;
    const template = this.template();
    this.problems = validateTemplateParams(this.getParams());
    const invalidKeys = new Set(
      this.problems
        .map((problem) => PARAM_KEYS.find((key) => problem.startsWith(key)))
        .filter((key): key is ParamKey => key !== undefined),
    );

    if (this.paramsTitle) {
      this.paramsTitle.textContent =
        `${template.emoji} ${template.name} 的参数（都是倍率，基准见每行小字）`;
    }
    for (const key of PARAM_KEYS) {
      const entry = this.paramRows.get(key);
      if (!entry) continue;
      const value = (this.getParams() as unknown as Record<string, number>)[key] ?? 0;
      const limit = TEMPLATE_PARAM_LIMITS[key];
      entry.value.textContent = `${fmtNum(value)}（${limit.min}~${limit.max}）`;
      // 玩家正在拖的滑杆不要回写，否则会出现「滑杆被抢」的手感
      if (document.activeElement !== entry.range) {
        const text = String(value);
        if (entry.range.value !== text) entry.range.value = text;
      }
      const invalid = invalidKeys.has(key);
      entry.value.style.color = invalid ? '#ff8a7a' : '';
      entry.hint.style.color = invalid ? '#ff8a7a' : '';
    }
    if (this.seedInput && document.activeElement !== this.seedInput) {
      const text = String(this.seedValue);
      if (this.seedInput.value !== text) this.seedInput.value = text;
    }
    if (this.problemsBox) {
      this.problemsBox.textContent =
        this.problems.length === 0 ? '' : `参数有问题，不能生成：${this.problems.join('；')}`;
    }
  }

  private syncButtons(): void {
    if (!this.domEnabled) return;
    const blocked = this.busy || this.problems.length > 0;
    if (this.generateButton) {
      this.generateButton.disabled = blocked;
      this.generateButton.title = blocked && !this.busy ? '参数非法：先修好上面标红的那几项' : '';
    }
    if (this.previewButton) {
      this.previewButton.disabled = blocked;
      this.previewButton.title = blocked && !this.busy ? '参数非法：先修好上面标红的那几项' : '';
    }
    if (this.rollbackButton) {
      this.rollbackButton.disabled = this.busy || this.lastRecord === null;
      this.rollbackButton.title = this.lastRecord === null ? this.rollbackUnavailableReason : ROLLBACK_NOTE;
    }
    if (this.busyBox) {
      this.busyBox.textContent = this.busy ? `正在：${this.busyLabel || '忙'}（生成期间两个按钮都禁用）` : '';
    }
    if (this.statusBox) this.statusBox.textContent = this.statusText;
  }

  private syncLimitations(): void {
    if (!this.domEnabled || !this.limitationsBox) return;
    const index = MAP_TEMPLATES.findIndex((template) => template.id === this.templateId);
    const data = index >= 0 ? this.thumbData[index] : null;
    if (!data) {
      this.limitationsBox.textContent = '这张卡片的缩略图还没算（懒加载：滚到卡片可见时才算）。点「预览」也可以用当前参数算一次。';
      return;
    }
    const lines = data.limitations.map((text, order) => `${order + 1}. ${text}`);
    lines.push(
      `（采样 ${data.resolution}×${data.resolution}｜地表 y ${data.minHeight} ~ ${data.maxHeight}｜` +
        `建筑地块 ${data.plots.length} 块｜自然物点 ${data.natureMarks.length} 个 —— 这些数字都来自本次预览计算）`,
    );
    this.limitationsBox.textContent = lines.join('\n');
  }

  private setStatus(text: string): void {
    this.statusText = text;
    if (this.domEnabled && this.statusBox) this.statusBox.textContent = text;
  }

  // ------------------------------------------------------------------ 动作

  /**
   * 等价于点界面上那个「生成」按钮。
   *
   * 做成公开方法而不是只挂在按钮上：**按钮的禁用状态与这里的行为必须是同一条路径**，
   * 否则「按钮灰了但其实还能生成」这类问题永远测不出来（Node 里没有按钮可点）。
   * @returns 是否真的提交了（参数非法或正忙时返回 false，并且不会调 handler）
   */
  requestGenerate(): boolean {
    if (this.busy) return false;
    if (this.getProblems().length > 0) {
      this.setStatus(`参数非法，没有生成：${this.getProblems().join('；')}`);
      return false;
    }
    const request = {
      templateId: this.templateId,
      seed: this.seedValue,
      overrides: this.getOverrides(),
    };
    // 记一份「提交过的参数」：面板不知道生成成不成，所以这是「可回滚」的乐观来源；
    // Engine 生成成功后调 rememberLastSuccess() 会把记录纠正为确实成功的那一份
    this.saveRecord({ ...request, at: Date.now() });
    this.setStatus(`已提交生成：${this.templateId}｜种子 ${this.seedValue}`);
    this.handlers.onGenerate(request);
    this.refresh();
    return true;
  }

  /** 等价于点「预览」（同样走公开路径，便于测试与 Engine 复用） */
  requestPreview(): boolean {
    if (this.busy) return false;
    if (this.getProblems().length > 0) {
      this.setStatus(`参数非法，没有预览：${this.getProblems().join('；')}`);
      return false;
    }
    const request = {
      templateId: this.templateId,
      seed: this.seedValue,
      overrides: this.getOverrides(),
    };
    this.setStatus(`已请求预览：${this.templateId}｜种子 ${this.seedValue}`);
    this.handlers.onPreview(request);
    return true;
  }

  /** 补充 5：回到上一次的模板与种子（只回滚参数，不回滚体素） */
  requestRollback(): boolean {
    if (this.busy) return false;
    const record = this.lastRecord ?? this.loadRecord();
    if (!record) {
      // 降级路径：没有记录就明确说没有，而不是把界面恢复成某个「猜的参数」
      this.setStatus(this.rollbackUnavailableReason);
      this.handlers.onRollback?.(this.rollbackUnavailableReason);
      return false;
    }
    this.lastRecord = record;
    this.templateId = record.templateId;
    for (const key of PARAM_KEYS) delete this.overrides[key];
    for (const key of PARAM_KEYS) {
      const value = record.overrides[key];
      if (typeof value === 'number' && Number.isFinite(value)) this.overrides[key] = value;
    }
    this.seedValue = record.seed;
    this.refresh();
    const when = record.at === null ? '时间未记录' : new Date(record.at).toLocaleString('zh-CN');
    const reason =
      `回滚到上一次生成：模板 ${record.templateId}｜种子 ${record.seed}｜记录于 ${when}` +
      `（只回滚参数与种子，不回滚体素）`;
    this.setStatus(reason);
    this.handlers.onRollback?.(reason);
    // 回滚之后**重新生成**：玩家的意图是「回到刚才那张图」，只改滑杆不动世界等于没回滚
    this.handlers.onGenerate({
      templateId: this.templateId,
      seed: this.seedValue,
      overrides: this.getOverrides(),
    });
    return true;
  }

  // ------------------------------------------------------------------ 存储

  /**
   * 读上次的参数。
   * 读失败（隐私模式 / 被清空 / JSON 坏了 / 结构不对）一律降级成「没有可回滚的记录」，
   * **不抛异常**：为了一个可选的回滚功能而让整个面板打不开是不划算的。
   */
  private loadRecord(): LastGenerationRecord | null {
    try {
      // 守卫在 try 里面：禁用站点数据时读属性本身就会抛（兼容性审计 R1）
      if (typeof sessionStorage === 'undefined') return null;
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Partial<LastGenerationRecord>;
      if (typeof record.templateId !== 'string' || !getMapTemplate(record.templateId)) return null;
      if (typeof record.seed !== 'number' || !Number.isFinite(record.seed)) return null;
      const overrides: TemplateOverrides = {};
      if (typeof record.overrides === 'object' && record.overrides !== null) {
        for (const [key, value] of Object.entries(record.overrides)) {
          if (typeof value === 'number' && Number.isFinite(value)) overrides[key] = value;
        }
      }
      const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : null;
      return { templateId: record.templateId, seed: record.seed, overrides, at };
    } catch {
      return null;
    }
  }

  private saveRecord(record: LastGenerationRecord): void {
    this.lastRecord = record;
    try {
      // 同 loadRecord：守卫要在 try 里面（R1）
      if (typeof sessionStorage === 'undefined') return;
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch {
      // 配额满 / 隐私模式：内存里那份仍然可用（本次会话内回滚照样能工作），只是刷新页面后没了
    }
  }

  // ------------------------------------------------------------------ 杂项

  private template(): MapTemplate {
    return getMapTemplate(this.templateId) ?? MAP_TEMPLATES[0]!;
  }

  private on(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.listeners.push({ target, type, handler });
  }
}

/** 卡片底色：直接复用模板调色板（与 `templateGradient()` 同一个思路，这里要的是节点内的元素质感） */
function templateGradientOf(template: MapTemplate): string {
  const stops = template.palette.map((color, index) => {
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    return `${hex} ${((index / Math.max(1, template.palette.length - 1)) * 100).toFixed(0)}%`;
  });
  return `linear-gradient(135deg, ${stops.join(', ')})`;
}
