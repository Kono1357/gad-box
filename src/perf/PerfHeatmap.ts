/**
 * 负载热力图（src/perf 新增模块 · 性能压力测试配套 1/2）。
 *
 * 编号说明：仓库里已有的 5 个 perf 模块自称「1/5 … 5/5」，本批新增的两个不并入那套编号
 * —— 改了分母就要回头改那 5 个文件的头注释（会碰到并发编辑的边界），而这里只新增不改。
 *
 * ────────────────────────────────────────────────────────────
 * 它回答什么问题
 * ────────────────────────────────────────────────────────────
 * 压力测试里最常见的现象不是"整体帧率掉了"，而是"**往东边那一片堆东西，帧率就掉**"。
 * 帧率是全局数字，回答不了"是哪一片在拖"；而物件的位置数据是现成的
 * （流体粒子、沙格、刚体都有坐标）。把数量按俯视格子加起来，就能看出负载堆在哪里。
 *
 * 三件事：**分箱（computeHeatmap）→ 画图（renderHeatmap）→ 说清它不知道什么（limitations）**。
 *
 * ────────────────────────────────────────────────────────────
 * ⚠ 这张图**不是**逐区域的耗时图（本模块最容易被误读的地方，写在最前面）
 * ────────────────────────────────────────────────────────────
 * 每一格的数字是"这一格里加权后的物件数"，**不是**"这一格每帧花了多少毫秒"。
 * 逐区域的耗时在前端根本拿不到，原因是结构性的、不是"还没实现"：
 * - WebGL 没有"按屏幕区域计时"的接口。`EXT_disjoint_timer_query` 只在部分设备上存在，
 *   而且它按**绘制调用**计时，不是按世界坐标分区；区块合批之后连"哪个 draw 属于哪一格"都没有；
 * - 帧耗时是整条主线程 + GPU 的合计量。物理求解、网格重建这些阶段内部不会带上
 *   "这次计算是替哪一格干的"，所以事后无法拆回去。
 * 因此任何"图上数字 = 毫秒"的读法都是错的。`limitations` 逐条写清，并且
 * `renderHeatmap` 会把「负载估计（加权物件数），不是每帧实际耗时」这句话**画进画布里**
 * —— 这张图会被截图单独传播，角标不能只活在面板的说明文字里。
 *
 * ────────────────────────────────────────────────────────────
 * 权重：只有"刚体 4"是估计值
 * ────────────────────────────────────────────────────────────
 * 一个刚体的每帧开销远大于一个流体粒子（刚体要走求解器与约束，粒子主要是积分 + 邻域查询），
 * 所以刚体按 4 计。**这个 4 是估计值，不是测量值**：没有做过"同样数量下逐项测耗时"的标定，
 * 设备与场景一变它就偏了。流体 / 沙土 / 地形 / 其它都给 1，含义只是"一个物件算一次"
 * 这个统一口径，**不代表**它们真实开销相等（地形按 1 计很可能高估，见 limitations）。
 * 想把口径换成别的数，调用方可以在每个物件上给显式 `weight` 覆盖。
 *
 * ────────────────────────────────────────────────────────────
 * 与 `data/contentStats.ts` 的关系：照做法、不照代码
 * ────────────────────────────────────────────────────────────
 * `contentStats` 里已经有一套"俯视分箱 + 守恒夹取"的做法，这里刻意**不 import 它**：
 * 它的口径是"内容使用统计"（按 defId 归类、算覆盖率、和目录比对），
 * 而这里只关心**负载**（按 kind 加权）。把两者耦在一起，将来任一边改口径都会牵动另一边，
 * 而且 contentStats 会连带把整个 `buildingCatalog` 拉进性能面板的依赖里 —— 那是纯浪费。
 * 所以这里自己实现 `positiveInt` / `usableSize` / `binIndexOf`，语义与它一致（含边界格的处理），
 * 代价是两份相似的代码，收益是两条口径可以各自演进。
 *
 * 纯逻辑、零依赖：不 import three / Rapier / Engine / DOM 节点，
 * 所以 `computeHeatmap` / `describeHeatmap` / `hottestCells` 可以直接在 Node 里断言
 * （`renderHeatmap` 也只在真的拿到 2D 上下文时才画）。
 */

/** 世界里一个参与负载统计的物件（流体粒子 / 沙格 / 刚体 / 地形块都结构上满足它） */
export interface HeatmapObject {
  /** 世界坐标 X（米） */
  x: number;
  /** 世界坐标 Z（米） */
  z: number;
  /** 世界坐标 Y。**当前不参与计算**（俯视分箱只用 X / Z），留着是为了调用方能原样
   *  把自己的物体对象传进来，而不是"这里漏读了高度" */
  y?: number;
  /** 物件种类。只影响权重口径，不影响坐标 */
  kind: 'fluid' | 'sand' | 'rigid' | 'terrain' | 'other';
  /** 显式权重，覆盖种类默认值。非有限值或负数会被忽略并回落到种类默认值 */
  weight?: number;
}

export interface HeatmapOptions {
  /** 列数（X 方向），默认 8。非法值（0 / 负数 / NaN / Infinity）回落到默认 */
  cols?: number;
  /** 行数（Z 方向），默认 8 */
  rows?: number;
  /** 分箱原点 X（世界坐标，Engine 里通常传 -sizeX / 2）。**不填按 0**；
   *  填了却不是有限数则整张图判为不可用（见文件头与 unavailableReason） */
  originX?: number;
  /** 分箱原点 Z（世界坐标，通常传 -sizeZ / 2） */
  originZ?: number;
  /** 世界 X 方向尺寸（米）。**必填**（不填无法分箱） */
  sizeX?: number;
  /** 世界 Z 方向尺寸（米）。**必填** */
  sizeZ?: number;
}

export interface HeatmapData {
  cols: number;
  rows: number;
  /** 每格的负载（0 起；单位是"加权物件数"，不是毫秒）。行主序：row 0 = z 最小端。
   *  分箱不可用时长度为 0（**不编造假格子**，见 unavailableReason） */
  cells: Float32Array;
  maxLoad: number;
  /** 各类的贡献（诊断"这一片是水多还是箱子多"） */
  byKind: Record<string, number>;
  /** 拿不到数据时的中文原因；正常为 null */
  unavailableReason: string | null;
  /** 必须如实陈列这张图**不能**回答的问题 */
  limitations: string[];
  /**
   * 下面四个是**分箱几何的回显**，不在最初约定的字段清单里，但 `hottestCells` 必须靠它
   * 把格子换算回世界坐标 —— 与其让调用方自己再传一遍尺寸（那就有了两个可能对不上的事实），
   * 不如把这一趟用到的几何原样带出来。分箱不可用时全是 0。
   */
  originX: number;
  originZ: number;
  sizeX: number;
  sizeZ: number;
}

/** 热力图里的一个热点。`x` / `z` 是**格子中心**的世界坐标，不是格子左上角 */
export interface HottestCell {
  col: number;
  row: number;
  load: number;
  x: number;
  z: number;
}

/** 默认 8 × 8：手机上一格约 24px，既看得清密集区又不至于每格都空着（与内容统计面板一致） */
const DEFAULT_COLS = 8;
const DEFAULT_ROWS = 8;
/** `hottestCells` 默认返回几个 */
const DEFAULT_HOTTEST_COUNT = 5;

/**
 * 单边格子数上限。防呆而非口径：`cols = 1e9` 会在 `new Float32Array` 时直接把页面卡死，
 * 而调用方看到的只是"浏览器崩了"这种毫无线索的现场。夹到 512（= 26 万格）足够任何用途。
 */
const MAX_BINS_DIM = 512;

/** "一个物件算一次"的单位权重 */
const UNIT_WEIGHT = 1;
/**
 * 刚体权重。
 * ⚠ 这是**估计值**：一个刚体要走求解器（约束、接触、休眠判定），确实是每帧的大头，
 * 但"4 倍"没有经过实测标定。改它之前先想清楚：改了这张图的含义就变了，
 * 而且它不会因此变成"实测值"。
 */
const WEIGHT_RIGID = 4;

const KIND_WEIGHTS: Record<HeatmapObject['kind'], number> = {
  fluid: UNIT_WEIGHT,
  sand: UNIT_WEIGHT,
  rigid: WEIGHT_RIGID,
  // 地形按 1 计（不是 0）：给 0 会让一整类物件在图和统计里彻底消失，
  // 而"0"与"没统计"在面板上无法区分。代价是稳态下很可能高估 —— 写进 limitations 了。
  terrain: UNIT_WEIGHT,
  other: UNIT_WEIGHT,
};

/** byKind 里预置的种类：面板不需要处理"某个 key 不存在"（合计也因此永远可算） */
const KNOWN_KINDS: readonly HeatmapObject['kind'][] = ['fluid', 'sand', 'rigid', 'terrain', 'other'];

/** 种类名 → 中文（byKind 的 key 是给代码用的，面板上必须显示中文） */
const KIND_LABELS: Record<string, string> = {
  fluid: '流体',
  sand: '沙土',
  rigid: '刚体',
  terrain: '地形',
  other: '其它',
};

/**
 * 这张图**不能**回答什么。至少四条，其中第一条是核心：它不是每帧实际耗时。
 *
 * 为什么不放在面板的 help 里而是放在数据结构上：这段文字会被导出（JSON / 报告 / 截图），
 * 而"数字看着很专业但其实是估计"这件事最容易被转述丢掉。让每份导出都带着它，
 * 就不依赖"谁记得把它抄过去"。
 *
 * 文案里刻意**不出现 ASCII 字母**（不写 GPU / CPU / NaN 之类），
 * 这样"全是中文"这条自检可以直接按字符判，不用维护一张例外表。
 */
const LIMITATIONS: readonly string[] = [
  '这不是每帧实际耗时：每格的数字是"加权物件数"（负载估计），逐区域的显卡与主线程耗时在前端拿不到，所以本图不能回答"哪一片慢了多少毫秒"。',
  '权重系数是估计值，不是标定值：刚体按 4 倍计，这个 4 凭经验定的、没有做过逐项实测标定；流体与沙土都按 1 计只是"一个物件算一次"的口径，不代表两者真实开销相等。',
  '不含相机因素：视野之外的物件实际开销小得多（视锥剔除、渲染距离都会把它剔掉），而本图只按世界坐标统计，与相机朝向、剔除、距离都无关。',
  '地形按 1 计很可能高估：地形网格只在编辑时重建，稳态下几乎没有每帧开销，但它在这里和流体粒子一样按一个物件计。',
  '越界的物件被夹进边界格：坐标超出世界范围或不是有限数的物件**不丢弃**（丢弃会让"各格之和 === 加权总数"这条自检失效），代价是边界格会比实际更热。',
  '世界尺寸或原点没给就无法分箱：此时这张图不画任何格子，只在不可用原因里说明缺的是哪个值 —— 拿不到范围就不会有点。',
];

/** 没有 CSS 尺寸时的兜底画布尺寸（CSS 还没加载 / 面板被隐藏时 clientWidth 是 0） */
const FALLBACK_W = 320;
const FALLBACK_H = 200;
/** devicePixelRatio 上限：手机上 3 倍已经看不出差别，再往上只是白烧像素 */
const MAX_DPR = 3;

const BG_COLOR = '#0e141a';
const GRID_COLOR = 'rgba(255, 255, 255, 0.08)';
const TEXT_COLOR = '#dfe7ee';
const DIM_TEXT = 'rgba(223, 231, 238, 0.6)';
const WARN_COLOR = '#ff8a6b';
const PANEL_BG = 'rgba(8, 12, 16, 0.78)';
const RAMP_H = 8;

/**
 * 冷 → 热的色带（蓝 → 青 → 黄 → 红）。
 *
 * 停靠点与 `ContentStatsUI` 的色带一致 —— 同一套面板里两张热力图颜色含义不同会误导人。
 * 但**代码是刻意抄一份而不是 import 它**：那张图的口径是"内容使用统计"，这张是"负载"，
 * 为了共用四个颜色常量把两个模块耦起来，是把"颜色一致"这种视觉约定升级成了代码依赖。
 */
const HEAT_RAMP: readonly { t: number; rgb: readonly [number, number, number] }[] = [
  { t: 0, rgb: [18, 49, 79] },
  { t: 0.4, rgb: [38, 138, 168] },
  { t: 0.7, rgb: [232, 196, 74] },
  { t: 1, rgb: [214, 64, 48] },
];

/** 单色（灰阶）色带：投影仪 / 黑白截图 / 需要和另一张彩色图并排时用 */
const MONO_RAMP: readonly { t: number; rgb: readonly [number, number, number] }[] = [
  { t: 0, rgb: [26, 30, 35] },
  { t: 1, rgb: [214, 226, 238] },
];

/** 比例（0~1）→ 颜色字符串。超出范围夹住；非有限值按 0（宁可画最冷色，也不要 NaN 颜色） */
function rampColor(ramp: readonly { t: number; rgb: readonly [number, number, number] }[], ratio: number): string {
  const t = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  let lower = ramp[0]!;
  let upper = ramp[ramp.length - 1]!;
  for (let i = 0; i < ramp.length - 1; i += 1) {
    const a = ramp[i]!;
    const b = ramp[i + 1]!;
    if (t >= a.t && t <= b.t) {
      lower = a;
      upper = b;
      break;
    }
  }
  const span = upper.t - lower.t;
  const k = span > 0 ? (t - lower.t) / span : 0;
  const r = Math.round(lower.rgb[0] + (upper.rgb[0] - lower.rgb[0]) * k);
  const g = Math.round(lower.rgb[1] + (upper.rgb[1] - lower.rgb[1]) * k);
  const b = Math.round(lower.rgb[2] + (upper.rgb[2] - lower.rgb[2]) * k);
  return `rgb(${r}, ${g}, ${b})`;
}

/** 正整数化：非法值一律回落到默认（宁可给一张 8 × 8 的图，也不要 NaN 尺寸的图） */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  // ⚠ 先取整再判大小：cols = 0.5 取整后是 0，而 0 会让 sizeX / cols 变成 Infinity
  const floored = Math.floor(value);
  if (floored < 1) return fallback;
  return Math.min(MAX_BINS_DIM, floored);
}

/** 尺寸能不能用来分箱（0 / 负数 / NaN / Infinity / 没给 都不行） */
function usableSize(size: number | undefined): boolean {
  return typeof size === 'number' && Number.isFinite(size) && size > 0;
}

/**
 * 某个坐标落在第几格（0 .. cells-1）。
 *
 * 三种越界处理（与 `contentStats.binIndexOf` 同一套语义，取舍也同一套）：
 * - 非有限值（存档坏掉 / 物件没初始化）→ 第 0 格；
 * - 小于原点 → 第 0 格；大于等于 原点 + 尺寸（**包括正好等于 sizeX**）→ 最后一格；
 * - 其余按 `floor((value - origin) / size * cells)`。
 *
 * 为什么夹住而不是丢弃：丢弃会让 `sum(cells) === 加权总数` 失效，
 * 而那正是分箱唯一能自检的地方。代价是越界物件落在边界格上会让那张格子偏热，已写进 limitations。
 */
function binIndexOf(value: number, origin: number, size: number, cells: number): number {
  if (!Number.isFinite(value)) return 0;
  const ratio = (value - origin) / size;
  if (!Number.isFinite(ratio)) return 0;
  const cell = Math.floor(ratio * cells);
  if (cell < 0) return 0;
  if (cell >= cells) return cells - 1;
  return cell;
}

/** 单个物件的权重：显式值优先；非法值回落到种类默认（负权重会让合计出现负数，图直接失去意义） */
function resolveWeight(object: HeatmapObject): number {
  const explicit = object.weight;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return explicit;
  // 运行时可能传进来没登记过的 kind 字符串（纯 JS 调用方不受类型约束）：
  // 按单位权重计，并且**原样记进 byKind**，不静默塞进 other —— 否则那一类会凭空消失
  return KIND_WEIGHTS[object.kind] ?? UNIT_WEIGHT;
}

/** 尺寸/原点文案：坏值是 NaN 还是 Infinity 直接写出来，调试时真正有用的是"到底是哪个值坏了" */
function describeNumber(value: number | undefined): string {
  if (value === undefined) return '未提供';
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  return String(value);
}

/**
 * 俯视分箱：把物件按世界坐标落进 cols × rows 的格子，按种类加权。
 *
 * 复杂度：对物件**一趟 O(n)**（算权重、累加 byKind、落格子），
 * 最后扫一遍格子数组取最大值（O(cols·rows)）。不做节流 —— 调用频率由 UI 决定，
 * 纯函数保持可断言的简单语义。
 *
 * 分箱不可用时（世界尺寸或原点不合法）返回 **cells 长度为 0** 的图，
 * 而不是一张"每格都是 0 的假图"：假图会被当成"真的分过箱，只是没东西"，
 * 与"根本没分箱"完全是两回事。`byKind` 仍然照常统计 —— 它不依赖分箱，是能拿到的真数据。
 */
export function computeHeatmap(objects: readonly HeatmapObject[], options: HeatmapOptions = {}): HeatmapData {
  const cols = positiveInt(options.cols, DEFAULT_COLS);
  const rows = positiveInt(options.rows, DEFAULT_ROWS);
  const sizeX = options.sizeX;
  const sizeZ = options.sizeZ;
  // 原点不填按 0（调用方的坐标本身就是 0 .. size 的口径）；**填了却非法则整张图不可用**，
  // 而不是静默按 0 处理 —— 世界对象坏掉时静默归零会把整张图整体平移，
  // 那种图看着完全正常，但每一格都是错的。
  const originX = options.originX === undefined ? 0 : options.originX;
  const originZ = options.originZ === undefined ? 0 : options.originZ;

  const sizeOk = usableSize(sizeX) && usableSize(sizeZ);
  const originOk = Number.isFinite(originX) && Number.isFinite(originZ);
  const canBin = sizeOk && originOk;

  const cells = canBin ? new Float32Array(cols * rows) : new Float32Array(0);
  const byKind: Record<string, number> = {};
  for (const kind of KNOWN_KINDS) byKind[kind] = 0;

  const usableX = sizeX as number;
  const usableZ = sizeZ as number;

  for (const object of objects) {
    const weight = resolveWeight(object);
    byKind[object.kind] = (byKind[object.kind] ?? 0) + weight;

    if (!canBin) continue; // 不编造格子：分不了箱就只统计 byKind
    const col = binIndexOf(object.x, originX, usableX, cols);
    const row = binIndexOf(object.z, originZ, usableZ, rows);
    const index = row * cols + col;
    cells[index] = cells[index]! + weight;
  }

  // 最大值放在最后扫：跑循环时逐格取最大也对（负载只增不减），但那个正确性需要读者推一遍；
  // 这里多花 O(格数) 换一眼能看懂
  let maxLoad = 0;
  for (let i = 0; i < cells.length; i += 1) {
    const load = cells[i]!;
    if (load > maxLoad) maxLoad = load;
  }

  const reason = canBin
    ? null
    : `世界范围不可用（sizeX=${describeNumber(sizeX)}、sizeZ=${describeNumber(sizeZ)}、` +
      `originX=${describeNumber(originX)}、originZ=${describeNumber(originZ)}）：` +
      '分箱要求 sizeX / sizeZ 都是大于 0 的有限数，且 originX / originZ 是有限数。' +
      '尺寸或原点拿不到时这里不会画格子，也不会把越界物件堆到某个格子上去凑一张图';

  return {
    cols: canBin ? cols : 0,
    rows: canBin ? rows : 0,
    cells,
    maxLoad,
    byKind,
    unavailableReason: reason,
    // 拷一份给调用方：这份清单是"这张图的说明书"，被谁改了一处就少一条
    limitations: [...LIMITATIONS],
    originX: canBin ? originX : 0,
    originZ: canBin ? originZ : 0,
    sizeX: canBin ? usableX : 0,
    sizeZ: canBin ? usableZ : 0,
  };
}

/**
 * 最热的几格，按负载降序（相同负载按 row / col 升序，保证同样的输入永远得到同样的顺序）。
 *
 * 只返回负载大于 0 的格子：把 0 负载的格子也算"热点"会让面板列出一串"0"，
 * 读起来像"这些格子有问题但看不出来"。分箱不可用时返回空数组（不编造热点）。
 *
 * 排序用 `slice` 后的数组，不动 `data` 里的任何东西 —— 调用方很可能同时还在用原图。
 */
export function hottestCells(data: HeatmapData, count = DEFAULT_HOTTEST_COUNT): HottestCell[] {
  if (!Number.isFinite(count)) return [];
  const wanted = Math.floor(count);
  if (wanted <= 0) return [];
  const cols = data.cols;
  const rows = data.rows;
  if (cols <= 0 || rows <= 0) return [];
  if (data.cells.length < cols * rows) return [];

  const cellW = data.sizeX / cols;
  const cellD = data.sizeZ / rows;
  const picked: HottestCell[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const load = data.cells[row * cols + col]!;
      if (!(load > 0)) continue;
      picked.push({
        col,
        row,
        load,
        // 格子中心：物体落格用的是左闭右开区间，报"格子中心"比报左上角更接近"这一格在哪"
        x: data.originX + (col + 0.5) * cellW,
        z: data.originZ + (row + 0.5) * cellD,
      });
    }
  }
  picked.sort((a, b) => b.load - a.load || a.row - b.row || a.col - b.col);
  return picked.slice(0, wanted);
}

/**
 * 这张图的一行中文摘要。
 *
 * 摘要里**必须**带着"加权物件数、估计值、不是每帧实际耗时"这几个字：
 * 这个字符串会出现在面板、控制台、导出的报告里，是玩家最可能只读到的一句话。
 */
export function describeHeatmap(data: HeatmapData): string {
  if (data.unavailableReason !== null) {
    return `负载热力图：不可用 —— ${data.unavailableReason}`;
  }

  const parts: { label: string; value: number }[] = [];
  let weightedTotal = 0;
  for (const kind of Object.keys(data.byKind)) {
    const value = data.byKind[kind]!;
    weightedTotal += value;
    // 0 的种类不列出来（"刚体 0"这种条目只会让摘要变长）；未登记的 kind 原样用 key，便于发现漏登记
    if (value > 0) parts.push({ label: KIND_LABELS[kind] ?? kind, value });
  }
  // 按贡献降序：摘要里最有信息量的是"主要是谁"，而不是字母序
  parts.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'zh'));
  const composition =
    parts.length > 0
      ? `构成：${parts.map((part) => `${part.label} ${part.value.toFixed(0)}`).join('、')}`
      : '这次没有传进来任何可统计的物件';

  const hottest = hottestCells(data, 1)[0];
  const hottestText =
    hottest === undefined
      ? '最热的一格：没有（每一格都是 0）'
      : `最热的一格：第 ${hottest.col + 1} 列 / 第 ${hottest.row + 1} 行，负载 ${hottest.load.toFixed(0)}，` +
        `位置约 (${hottest.x.toFixed(1)}, ${hottest.z.toFixed(1)})`;

  return (
    `负载热力图：${data.cols} × ${data.rows} 格（${data.sizeX.toFixed(1)} × ${data.sizeZ.toFixed(1)} 米，` +
    `原点 ${data.originX.toFixed(1)}, ${data.originZ.toFixed(1)}）｜` +
    `${hottestText}｜加权合计 ${weightedTotal.toFixed(0)}（单位：加权物件数，估计值，不是每帧实际耗时）｜${composition}` +
    // 摘要里补上两条最容易在转述中丢掉的限定：权重是估计的、不含相机因素。
    // 图会被截图传播，而这句话所在的 DOM 节点不会跟着走，所以两处都要有。
    '。限定：权重系数是估计值（刚体按 4 倍计，未做实测标定）；不含相机朝向与视锥剔除，视野外的物件实际开销更小'
  );
}

/** 逐字累加折行（调用前必须先设好 `ctx.font`，否则量出来的宽度是别的字号的） */
function wrapByChar(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const ch of text) {
    const next = current + ch;
    if (current !== '' && ctx.measureText(next).width > maxWidth) {
      lines.push(current);
      current = ch;
    } else {
      current = next;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/**
 * 居中文字块：一行标题 + 一段说明，按画布宽度逐字换行。
 * 逐字换行对中文是正确的做法（中文没有词间空格），这段文字只在"画不出图"时出现。
 */
function drawCenteredText(
  ctx: CanvasRenderingContext2D,
  title: string,
  cssW: number,
  cssH: number,
  detail: string,
  titleColor: string,
): void {
  const maxWidth = Math.max(40, cssW - 24);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.font = '600 13px system-ui, -apple-system, "PingFang SC", sans-serif';
  const titleLines = wrapByChar(ctx, title, maxWidth);
  ctx.font = '11px system-ui, -apple-system, "PingFang SC", sans-serif';
  const detailLines = wrapByChar(ctx, detail, maxWidth);

  const lineH = 17;
  const totalH = (titleLines.length + detailLines.length + 1) * lineH;
  let y = Math.max(lineH, (cssH - totalH) / 2 + lineH);

  ctx.fillStyle = titleColor;
  ctx.font = '600 13px system-ui, -apple-system, "PingFang SC", sans-serif';
  for (const text of titleLines) {
    ctx.fillText(text, cssW / 2, y);
    y += lineH;
  }
  ctx.fillStyle = DIM_TEXT;
  ctx.font = '11px system-ui, -apple-system, "PingFang SC", sans-serif';
  for (const text of detailLines) {
    ctx.fillText(text, cssW / 2, y);
    y += lineH;
  }
}

/**
 * 左下角的说明角标（半透明底板 + 一行文字）。
 *
 * 为什么**无论有没有数据都要画**：这张图会被截图、会被贴在问题反馈里单独传播，
 * "数字是什么单位"这句话必须跟着图走。只写在面板的另一个 DOM 节点里，
 * 截图一裁就没了，读图的人会顺理成章地把色块当成耗时。
 */
function drawCornerNote(ctx: CanvasRenderingContext2D, text: string, cssW: number, cssH: number): void {
  const padX = 6;
  const padY = 4;
  const lineH = 13;
  ctx.font = '10px system-ui, -apple-system, "PingFang SC", sans-serif';
  const lines = wrapByChar(ctx, text, Math.max(80, cssW - 24 - padX * 2));
  let width = 0;
  for (const line of lines) width = Math.max(width, ctx.measureText(line).width);
  const boxW = width + padX * 2;
  const boxH = lines.length * lineH + padY * 2;

  ctx.fillStyle = PANEL_BG;
  ctx.fillRect(4, cssH - boxH - 4, boxW, boxH);
  ctx.fillStyle = WARN_COLOR;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let y = cssH - boxH - 4 + padY;
  for (const line of lines) {
    ctx.fillText(line, 4 + padX, y);
    y += lineH;
  }
}

/**
 * 右上角的色标：一条由冷到热的色带 + 0 / 中值 / 最大 + 「最多 N 个加权物件/格」。
 *
 * 为什么必须有它：一张纯色块的热力图如果不说"最热 = 多少"，读图的人无法判断
 * "这一格是挤爆了还是才放了两个"，那这张图就只能当装饰。
 *
 * 为什么在**右上**而不是常见的右下：右下留给"这不是每帧实际耗时"那句角标。
 * 两者都在底部时，窄画布上文字会互相压住（角标是按逐字折行的，宽度不可控），
 * 一上一下才是任何画布尺寸下都不会撞的两个角。
 */
function drawScale(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  maxLoad: number,
  ramp: readonly { t: number; rgb: readonly [number, number, number] }[],
): void {
  const title = maxLoad > 0 ? `最多 ${maxLoad.toFixed(0)} 个加权物件/格` : '最多 0 个（这次没有物件）';
  const subtitle = '估计值，不是毫秒';
  ctx.font = '600 11px system-ui, -apple-system, "PingFang SC", sans-serif';
  const titleWidth = ctx.measureText(title).width;
  const rampW = Math.min(120, Math.max(60, cssW * 0.38));
  const padX = 8;
  const boxW = Math.max(rampW, titleWidth) + padX * 2;
  const boxH = RAMP_H + 46;
  const boxX = cssW - boxW - 8;
  const boxY = 8;

  // 半透明底板：不然色带会和它下面那一格的温度颜色混在一起，刻度就读不出来了
  ctx.fillStyle = PANEL_BG;
  ctx.fillRect(boxX, boxY, boxW, boxH);

  const rampX = boxX + padX;
  const rampY = boxY + 20;
  for (let i = 0; i < rampW; i += 1) {
    ctx.fillStyle = rampColor(ramp, rampW > 1 ? i / (rampW - 1) : 1);
    ctx.fillRect(rampX + i, rampY, 1, RAMP_H);
  }

  // 三个刻度：0 / 一半 / 最大。中间刻度只在最大值 >= 2 时有意义（0 和 1 之间没有"一半"）
  ctx.strokeStyle = TEXT_COLOR;
  ctx.lineWidth = 1;
  const ticks = maxLoad >= 2 ? [0, 0.5, 1] : [0, 1];
  ctx.beginPath();
  for (const t of ticks) {
    const x = Math.round(rampX + t * rampW) + 0.5;
    ctx.moveTo(x, rampY + RAMP_H);
    ctx.lineTo(x, rampY + RAMP_H + 4);
  }
  ctx.stroke();

  ctx.fillStyle = TEXT_COLOR;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, rampX, boxY + 14);

  ctx.fillStyle = DIM_TEXT;
  ctx.font = '10px system-ui, -apple-system, "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('0', rampX, rampY + RAMP_H + 13);
  ctx.textAlign = 'right';
  ctx.fillText(`${maxLoad.toFixed(0)}`, rampX + rampW, rampY + RAMP_H + 13);
  if (maxLoad >= 2) {
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(maxLoad / 2)}`, rampX + rampW / 2, rampY + RAMP_H + 13);
  }
  ctx.textAlign = 'left';
  ctx.fillText(subtitle, rampX, boxY + boxH - 5);
}

/** 当前设备像素比（Node 里没有 window，取 1 让纯逻辑断言也能跑） */
function currentDpr(): number {
  if (typeof window === 'undefined') return 1;
  const dpr = window.devicePixelRatio;
  if (!Number.isFinite(dpr) || dpr < 1) return 1;
  return Math.min(MAX_DPR, dpr);
}

/**
 * 把热力图画进 canvas。
 *
 * 安全策略（本模块唯一的"外部世界"就是这张 canvas，所以每条退出路径都写清楚）：
 * - `canvas` 为 null（HTML 片段还没接上）→ 直接返回；
 * - `getContext` 返回 null（上下文已被别的模块拿走）或直接抛异常（某些环境）→ 直接返回；
 * - CSS 尺寸为 0（面板被 `display:none` 隐藏）→ 返回，不做一次无用的位图分配。
 * 三种情况都**不抛异常**：一张图画不出来不该让整个压力测试面板停摆。
 */
export function renderHeatmap(
  canvas: HTMLCanvasElement,
  data: HeatmapData,
  opts: { showLegend?: boolean; colormap?: 'heat' | 'mono' } = {},
): void {
  if (!canvas) return;

  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    // 有的环境（被别的上下文占用 / 非浏览器）直接抛，而不是返回 null。两种都当"没有上下文"
    ctx = null;
  }
  if (!ctx) return;

  const cssW = canvas.clientWidth || FALLBACK_W;
  const cssH = canvas.clientHeight || FALLBACK_H;
  if (cssW <= 0 || cssH <= 0) return;

  // 高分屏：位图按 dpr 放大、再用 setTransform 把坐标系拉回 CSS 像素，
  // 否则 canvas 里的文字（刻度、角标）在高分屏上会被拉伸成模糊的一团
  const dpr = currentDpr();
  const bitmapW = Math.max(1, Math.round(cssW * dpr));
  const bitmapH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== bitmapW || canvas.height !== bitmapH) {
    canvas.width = bitmapW;
    canvas.height = bitmapH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, cssW, cssH);

  const ramp = opts.colormap === 'mono' ? MONO_RAMP : HEAT_RAMP;
  const showLegend = opts.showLegend !== false;
  // 角标文案：单位与"不是耗时"这两件事必须写全，缺一个就会被读成耗时图
  const note = '负载估计（加权物件数）：流体 / 沙土 / 地形 / 其它 = 1、刚体 = 4（估计值）。这不是每帧实际耗时。';

  if (data.unavailableReason !== null) {
    // 拿不到范围就**一格都不画**：画一张"每格都是 0 的 8 × 8"会被当成真的分过箱
    drawCenteredText(ctx, '负载热力图不可用', cssW, cssH, data.unavailableReason, WARN_COLOR);
    drawCornerNote(ctx, note, cssW, cssH);
    return;
  }

  const cols = data.cols;
  const rows = data.rows;
  if (cols <= 0 || rows <= 0 || data.cells.length < cols * rows) {
    drawCenteredText(
      ctx,
      '负载热力图不可用',
      cssW,
      cssH,
      '分箱尺寸或格子数据不完整（这不是"没有负载"，是数据本身对不上）',
      WARN_COLOR,
    );
    drawCornerNote(ctx, note, cssW, cssH);
    return;
  }

  const cellW = cssW / cols;
  const cellH = cssH / rows;
  const empty = !(data.maxLoad > 0);

  if (!empty) {
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const load = data.cells[row * cols + col]!;
        ctx.fillStyle = rampColor(ramp, load / data.maxLoad);
        ctx.fillRect(col * cellW, row * cellH, cellW, cellH);
      }
    }
  }

  // 网格线：格子太小（< 6px）时画线只会糊成一片灰，索性不画
  if (cellW >= 6 && cellH >= 6) {
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let col = 1; col < cols; col += 1) {
      const x = Math.round(col * cellW) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssH);
    }
    for (let row = 1; row < rows; row += 1) {
      const y = Math.round(row * cellH) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
    }
    ctx.stroke();
  }

  if (empty) {
    // 全 0 时**不逐格涂冷色**：一张铺满深蓝的格网会被读成"有数据，只是都很冷"，
    // 而事实是"这一趟没有任何可统计的物件"。网格线照画（它表达"分箱是几 × 几"，不是数据），
    // 中间用文字把原因说清楚。
    drawCenteredText(
      ctx,
      '这一片还没有负载',
      cssW,
      cssH,
      `分箱是 ${cols} × ${rows}，但每一格的负载都是 0 —— 这次没有传进来任何可统计的物件。` +
        '注意：这只是"没有物件"，不等于"这里不卡"（本图本来就不测耗时）。',
      TEXT_COLOR,
    );
  }

  // 画布太小时色标与角标会挤到一起（两者的宽度都随文字走，算不准），
  // 这时**宁可少画一个色标**：两块文字叠在一起，读的人只会以为图坏了
  const legendRoom = cssW >= 160 && cssH >= 90;
  if (showLegend && legendRoom) drawScale(ctx, cssW, data.maxLoad, ramp);
  drawCornerNote(ctx, note, cssW, cssH);
}

/*
 * ────────────────────────────────────────────────────────────
 * 接线示例（Engine / 面板里怎么用；不在这里执行，只作为文档）
 * ────────────────────────────────────────────────────────────
 * ```ts
 * // 1) 收集物件：把三套系统的位置原样喂进来，不要在这里做任何"估算"
 * const objects: HeatmapObject[] = [];
 * for (const p of this.fluid.particles) objects.push({ x: p.x, z: p.z, kind: 'fluid' });
 * for (const s of this.sand.cells) objects.push({ x: s.x, z: s.z, kind: 'sand' });
 * for (const b of this.physics.bodies) objects.push({ x: b.translation().x, z: b.translation().z, kind: 'rigid' });
 *
 * // 2) 分箱：⚠ originX / originZ 必须传（世界以原点为中心，不传会让负坐标全被夹进第 0 列）
 * const heat = computeHeatmap(objects, {
 *   cols: 8, rows: 8,
 *   originX: this.world.originX, originZ: this.world.originZ,
 *   sizeX: this.world.sizeX, sizeZ: this.world.sizeZ,
 * });
 *
 * // 3) 画图（每 200ms 一次就够，别每帧画）+ 摘要
 * renderHeatmap(this.heatmapCanvas, heat, { showLegend: true, colormap: 'heat' });
 * this.heatmapNote.textContent = describeHeatmap(heat);
 * ```
 * 拿不到 `world.originX` / `sizeX` 时**不要瞎填**：不传尺寸的结果是一张
 * `unavailableReason` 非空的空图（面板会显示原因），而不是一张错的图。
 */
