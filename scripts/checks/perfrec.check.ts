/**
 * 性能热力图（`src/perf/PerfHeatmap.ts`）与帧录制（`src/perf/PerfRecorder.ts`）的纯逻辑断言
 * （性能压力测试配套）。
 *
 * 为什么不写进 `scripts/verify.ts`：那个文件是并发编辑的公共入口，加进去必然冲突。
 * 这里导出一个 `runPerfRecorderChecks(check)`，跑法见同目录的 `perfrec.run.ts`：
 *
 * ```bash
 * npx esbuild scripts/checks/perfrec.run.ts --bundle --format=esm --platform=node \
 *   --outfile=.verify/perfrec.mjs && node .verify/perfrec.mjs
 * ```
 *
 * ────────────────────────────────────────────────────────────
 * 这批断言的重点：**防止性能数据自己骗人**
 * ────────────────────────────────────────────────────────────
 * perf 相关的东西最容易"看起来专业但数字是假的"，所以这里的断言分三类：
 * 1. **不变量**：分箱守恒（各格之和 === 加权总数）、byKind 守恒、环形缓冲回绕后序号连续；
 * 2. **"拿不到就说拿不到"**：尺寸缺失 / 原点非法时必须是 0 格 + 中文原因，
 *    没有样本时 `avgFps` 必须是 `null` 而不是 0，缺失的阶段在 CSV 里必须留空而不是填 0；
 * 3. **口径必须写在图上**：`limitations` 至少 4 条、全是中文、必须包含"不是每帧实际耗时"，
 *    并且那句话真的会被 `renderHeatmap` 画进画布里（截图单独传播时也不会被误读）。
 *
 * 假 canvas 与 `ContentStatsUI` 的断言用同一套做法：记录 `fillRect` / `fillText` 的调用，
 * 验证的是**契约**（画了什么、画了几格），不是外观。这里不是浏览器渲染测试。
 */

import {
  computeHeatmap,
  describeHeatmap,
  hottestCells,
  renderHeatmap,
} from '../../src/perf/PerfHeatmap';
import type { HeatmapData, HeatmapObject } from '../../src/perf/PerfHeatmap';
import { PerfRecorder } from '../../src/perf/PerfRecorder';
import type { RecordedFrame } from '../../src/perf/PerfRecorder';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 造一个参与负载统计的物件。weight 省略时不传这个字段（走种类默认权重） */
function obj(x: number, z: number, kind: HeatmapObject['kind'], weight?: number): HeatmapObject {
  return weight === undefined ? { x, z, kind } : { x, z, kind, weight };
}

/** 造一帧录制样本 */
function frame(t: number, ms: number, phases: Record<string, number> = {}, particles = 0, bodies = 0): RecordedFrame {
  return { t, ms, phases, particles, bodies };
}

/** 某一格的负载 */
function cellAt(data: HeatmapData, col: number, row: number): number {
  return data.cells[row * data.cols + col]!;
}

/** 各格负载之和 */
function cellSum(data: HeatmapData): number {
  let sum = 0;
  for (let i = 0; i < data.cells.length; i += 1) sum += data.cells[i]!;
  return sum;
}

/** 各类贡献之和 */
function kindSum(data: HeatmapData): number {
  let sum = 0;
  for (const kind of Object.keys(data.byKind)) sum += data.byKind[kind]!;
  return sum;
}

/** 有没有中文汉字 */
function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text);
}

/** 有没有 ASCII 字母（limitations 的文案刻意不出现它们，"全是中文"这条自检才能按字符判） */
function hasAsciiLetter(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

/** 主验证用的坐标：4 列 4 行、格子 10 × 5 米、原点在负半轴（与 Engine 的世界一致） */
const GRID_OPTIONS = { cols: 4, rows: 4, originX: -20, originZ: -10, sizeX: 40, sizeZ: 20 };

// ---------------------------------------------------------------------------
// 假 canvas（与 ContentStatsUI 的断言同一套做法）
// ---------------------------------------------------------------------------

interface FakeFill {
  color: string;
  w: number;
  h: number;
}

interface FakeCtx {
  font: string;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  textAlign: string;
  textBaseline: string;
  fills: FakeFill[];
  fillTexts: string[];
  strokes: number;
  reset(): void;
  /** 尺寸正好是 (w, h) 的矩形画了几次 —— 用来数"画了几格" */
  countRects(w: number, h: number): number;
  /** 所有画上去的文字按调用顺序拼起来（逐字折行是按顺序切片的，拼回来就是原文） */
  text(): string;
  setTransform(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(): void;
  lineTo(): void;
  stroke(): void;
  fillText(text: string): void;
  measureText(text: string): { width: number };
}

function makeCtx(): FakeCtx {
  const fills: FakeFill[] = [];
  const fillTexts: string[] = [];
  return {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: '',
    textBaseline: '',
    fills,
    fillTexts,
    strokes: 0,
    reset(): void {
      fills.length = 0;
      fillTexts.length = 0;
      this.strokes = 0;
    },
    countRects(w: number, h: number): number {
      return fills.filter((fill) => fill.w === w && fill.h === h).length;
    },
    text(): string {
      return fillTexts.join('');
    },
    setTransform(): void {},
    // 位置不记录：这些断言关心的是"画了几格、什么颜色、写了什么字"，不是坐标
    fillRect(_x: number, _y: number, w: number, h: number): void {
      fills.push({ color: this.fillStyle, w, h });
    },
    beginPath(): void {},
    moveTo(): void {},
    lineTo(): void {},
    stroke(): void {
      this.strokes += 1;
    },
    fillText(text: string): void {
      fillTexts.push(text);
    },
    // 中文逐字折行要用它量宽度：粗略按"每字 6px"估，够本断言用（与 ContentStatsUI 的断言一致）
    measureText(text: string): { width: number } {
      return { width: text.length * 6 };
    },
  };
}

interface FakeCanvasOptions {
  ctx: FakeCtx | null;
  /** 让 getContext 直接抛异常：有的环境不返回 null 而是抛 */
  throws?: boolean;
  clientWidth?: number;
  clientHeight?: number;
}

/** 造一块假 canvas。320 × 200 配上 8 × 8 的分箱正好是 40 × 25 的格子，方便数格子 */
function makeCanvas(options: FakeCanvasOptions): HTMLCanvasElement {
  const canvas = {
    clientWidth: options.clientWidth ?? 320,
    clientHeight: options.clientHeight ?? 200,
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext(): FakeCtx | null {
      if (options.throws === true) throw new Error('上下文已经被别的模块拿走');
      return options.ctx;
    },
  };
  return canvas as unknown as HTMLCanvasElement;
}

/** 临时把 devicePixelRatio 装到全局上，跑完还原（不做全局清理会污染后续断言） */
function withDevicePixelRatio(dpr: number, run: () => void): void {
  const globals = globalThis as unknown as { window?: unknown };
  const previous = globals.window;
  globals.window = { devicePixelRatio: dpr, addEventListener(): void {}, removeEventListener(): void {} };
  try {
    run();
  } finally {
    globals.window = previous;
  }
}

/** 包一层 try/catch：断言"这段代码不抛异常" */
function doesNotThrow(run: () => void): { ok: boolean; detail: string } {
  try {
    run();
    return { ok: true, detail: '没有抛异常' };
  } catch (error: unknown) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function runPerfRecorderChecks(check: CheckFn): void {
  // ==================================================================
  // 〇、先把"未录制时 sample 的开销"量掉
  // ==================================================================
  // 这一段刻意放在**最前面**，而不是跟其它录制断言排在一起：
  // 后面那些热力图断言会造出大量临时对象，等它们跑完再测，量到的主要是 V8
  // 在回收那些垃圾的时间 —— 那与 `sample()` 本身无关，却会让这条断言随天气飘。
  // 先测干净堆上的开销，测的还是同一段代码，只是不受别人产生的垃圾干扰。
  const idleRecorder = new PerfRecorder({ capacity: 16 });
  const probe = frame(0, 16.7, { physics: 3 }, 120, 8);
  // 预热 3 轮整循环：把 JIT 的分层编译成本排除在计时之外。
  // 只预热几百次是不够的 —— 那时量到的还是解释执行的速度，不是这段代码真正的开销。
  const measureLoop = (run: () => void): number[] => {
    for (let warm = 0; warm < 3; warm += 1) {
      for (let i = 0; i < 10_000; i += 1) run();
    }
    const costs: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const start = performance.now();
      for (let i = 0; i < 10_000; i += 1) run();
      costs.push(performance.now() - start);
    }
    return costs;
  };
  // 计时循环里只做 sample：测试用的帧对象在循环外构造一次，构造开销不算进这次测量
  const idleSampleCosts = measureLoop(() => idleRecorder.sample(probe));
  const idleSampleCheapest = Math.min(...idleSampleCosts);
  // 同一个循环里调一次空函数的耗时：给这条断言一个参照。
  // 单看一个"0.08 毫秒"没法判断是快是慢，和"一次空调用"比才有意义。
  const noop = (): void => {};
  const noopCheapest = Math.min(...measureLoop(() => noop()));

  // ==================================================================
  // 一、热力图：分不出箱时不编造格子
  // ==================================================================

  const empty = computeHeatmap([], GRID_OPTIONS);
  check(
    '热力图：空物件时 maxLoad 是 0（不是 NaN，也没有编造热点）',
    empty.maxLoad === 0,
    `maxLoad=${empty.maxLoad}`,
  );
  check(
    '热力图：空物件时 cells 长度 = cols × rows，且每一格都是 0',
    empty.cells.length === empty.cols * empty.rows && cellSum(empty) === 0,
    `cells.length=${empty.cells.length}，cols×rows=${empty.cols * empty.rows}，合计=${cellSum(empty)}`,
  );
  check(
    '热力图：可以分箱时 unavailableReason 是 null（有数据就不该报不可用）',
    empty.unavailableReason === null,
    `unavailableReason=${String(empty.unavailableReason)}`,
  );
  check(
    '热力图：byKind 预置了五个种类且都是 0（面板不用处理 key 缺失）',
    Object.keys(empty.byKind).length === 5 &&
      ['fluid', 'sand', 'rigid', 'terrain', 'other'].every((kind) => empty.byKind[kind] === 0),
    `keys=${Object.keys(empty.byKind).join('、')}`,
  );

  // 缺世界尺寸：**这一条是这批断言里最重要的**，因为"没给范围"最容易被悄悄糊过去
  const noSize = computeHeatmap([obj(0, 0, 'fluid'), obj(1, 1, 'rigid')]);
  check(
    '热力图：没给世界尺寸时 unavailableReason 是中文，并说明缺的是哪个值',
    noSize.unavailableReason !== null &&
      hasChinese(noSize.unavailableReason) &&
      noSize.unavailableReason.includes('sizeX'),
    noSize.unavailableReason ?? '(null)',
  );
  check(
    '热力图：没给尺寸时 cells 长度为 0 —— 不编造格子',
    noSize.cells.length === 0 && noSize.maxLoad === 0,
    `cells.length=${noSize.cells.length}，maxLoad=${noSize.maxLoad}`,
  );
  check(
    '热力图：没给尺寸时 cols / rows 都是 0（一张"8 × 8 全是 0 的图"会被当成真的分过箱）',
    noSize.cols === 0 && noSize.rows === 0,
    `cols=${noSize.cols}，rows=${noSize.rows}`,
  );
  check(
    '热力图：没给尺寸时 byKind 仍然照常统计（它不依赖分箱，是能拿到的真数据）',
    noSize.byKind.fluid === 1 && noSize.byKind.rigid === 4 && kindSum(noSize) === 5,
    `fluid=${noSize.byKind.fluid}，rigid=${noSize.byKind.rigid}，合计=${kindSum(noSize)}`,
  );
  check(
    '热力图：只给 sizeX 不给 sizeZ 仍然判为不可用（半个范围分不了箱）',
    computeHeatmap([], { sizeX: 40 }).unavailableReason !== null,
    String(computeHeatmap([], { sizeX: 40 }).unavailableReason),
  );

  const badSizes: { label: string; options: Parameters<typeof computeHeatmap>[1] }[] = [
    { label: 'sizeX = 0', options: { sizeX: 0, sizeZ: 20 } },
    { label: 'sizeX = 负数', options: { sizeX: -40, sizeZ: 20 } },
    { label: 'sizeZ = NaN', options: { sizeX: 40, sizeZ: Number.NaN } },
    { label: 'sizeZ = Infinity', options: { sizeX: 40, sizeZ: Number.POSITIVE_INFINITY } },
  ];
  for (const bad of badSizes) {
    const data = computeHeatmap([obj(0, 0, 'fluid')], bad.options);
    check(
      `热力图：${bad.label} 判为不可用，且 cells 里没有格子`,
      data.unavailableReason !== null && hasChinese(data.unavailableReason) && data.cells.length === 0,
      `cells.length=${data.cells.length}`,
    );
  }

  check(
    '热力图：原点显式给了 NaN 判为不可用（不静默按 0 平移整张图）',
    computeHeatmap([obj(0, 0, 'fluid')], { sizeX: 40, sizeZ: 20, originX: Number.NaN }).unavailableReason !== null,
    String(computeHeatmap([], { sizeX: 40, sizeZ: 20, originX: Number.NaN }).unavailableReason),
  );
  check(
    '热力图：原点不填按 0 处理（这是允许的默认值，不是不可用）',
    computeHeatmap([obj(5, 5, 'fluid')], { sizeX: 40, sizeZ: 20 }).unavailableReason === null,
    String(computeHeatmap([obj(5, 5, 'fluid')], { sizeX: 40, sizeZ: 20 }).unavailableReason),
  );
  check(
    '热力图：不可用时 describeHeatmap 里带着原因原文（不会只说一句"不可用"）',
    (() => {
      const text = describeHeatmap(noSize);
      return hasChinese(text) && noSize.unavailableReason !== null && text.includes(noSize.unavailableReason);
    })(),
    describeHeatmap(noSize).slice(0, 60),
  );
  check(
    '热力图：不可用时 hottestCells 返回空数组（不编造热点）',
    hottestCells(noSize).length === 0,
    `返回 ${hottestCells(noSize).length} 条`,
  );

  // ==================================================================
  // 二、热力图：守恒与权重口径
  // ==================================================================

  const mixed: HeatmapObject[] = [
    obj(-15, 0, 'rigid'),
    obj(5, -5, 'fluid'),
    obj(5, -5, 'fluid'),
    obj(5, -5, 'fluid'),
    obj(15, 5, 'sand'),
    obj(15, 5, 'terrain'),
  ];
  const grid = computeHeatmap(mixed, GRID_OPTIONS);
  const expectedWeighted = 4 + 1 + 1 + 1 + 1 + 1;
  check(
    '热力图：各格负载之和 === 物件加权和（分箱守恒）',
    cellSum(grid) === expectedWeighted,
    `各格之和=${cellSum(grid)}，手算加权和=${expectedWeighted}`,
  );
  check(
    '热力图：各类贡献之和 === 加权总数（byKind 守恒）',
    kindSum(grid) === expectedWeighted,
    `byKind 之和=${kindSum(grid)}，手算=${expectedWeighted}`,
  );
  check(
    '热力图：流体 / 沙土 / 地形按 1 计，刚体按 4 计（刚体的 4 是估计值，不是测量值）',
    grid.byKind.fluid === 3 && grid.byKind.sand === 1 && grid.byKind.terrain === 1 && grid.byKind.rigid === 4,
    `fluid=${grid.byKind.fluid}、sand=${grid.byKind.sand}、terrain=${grid.byKind.terrain}、rigid=${grid.byKind.rigid}`,
  );
  check(
    '热力图：地形按 1 计而不是 0（给 0 会让一整类物件在图和统计里彻底消失）',
    grid.byKind.terrain === 1,
    `terrain=${grid.byKind.terrain}`,
  );
  check(
    '热力图：显式 weight 覆盖种类默认值',
    (() => {
      const data = computeHeatmap([obj(0, 0, 'fluid', 7)], { sizeX: 40, sizeZ: 20 });
      return cellSum(data) === 7 && data.byKind.fluid === 7;
    })(),
    `合计=${cellSum(computeHeatmap([obj(0, 0, 'fluid', 7)], { sizeX: 40, sizeZ: 20 }))}`,
  );
  check(
    '热力图：显式 weight = 0 被尊重（调用方明确说这一项不计负载）',
    cellSum(computeHeatmap([obj(0, 0, 'fluid', 0)], { sizeX: 40, sizeZ: 20 })) === 0,
    `合计=${cellSum(computeHeatmap([obj(0, 0, 'fluid', 0)], { sizeX: 40, sizeZ: 20 }))}`,
  );
  check(
    '热力图：非法 weight（NaN / 负数）回落到种类默认值，不产生 NaN 格子',
    (() => {
      const data = computeHeatmap(
        [obj(0, 0, 'rigid', Number.NaN), obj(0, 0, 'rigid', -3)],
        { sizeX: 40, sizeZ: 20 },
      );
      return cellSum(data) === 8 && Number.isFinite(data.maxLoad);
    })(),
    `合计=${cellSum(computeHeatmap([obj(0, 0, 'rigid', Number.NaN), obj(0, 0, 'rigid', -3)], { sizeX: 40, sizeZ: 20 }))}`,
  );
  check(
    '热力图：越界物件被夹进边界格而不是丢弃（丢一个守恒就断了）',
    (() => {
      // 一个在 +X 之外、一个在 -Z 之外 → 分别夹到 (col 3, row 0) 与 (col 0, row 3) 两个角落
      const data = computeHeatmap([obj(9999, -9999, 'rigid'), obj(-9999, 9999, 'rigid')], GRID_OPTIONS);
      return cellSum(data) === 8 && cellAt(data, 3, 0) === 4 && cellAt(data, 0, 3) === 4 && data.maxLoad === 4;
    })(),
    (() => {
      const data = computeHeatmap([obj(9999, -9999, 'rigid'), obj(-9999, 9999, 'rigid')], GRID_OPTIONS);
      return `各格之和=${cellSum(data)}，(col 3, row 0)=${cellAt(data, 3, 0)}，(col 0, row 3)=${cellAt(data, 0, 3)}`;
    })(),
  );

  // ==================================================================
  // 三、热力图：边界与坐标换算
  // ==================================================================

  const atRightEdge = computeHeatmap([obj(-20 + 40, 0, 'rigid')], GRID_OPTIONS);
  check(
    '热力图：x 正好等于 originX + sizeX 落在最后一列，不溢出成第 cols 格',
    cellAt(atRightEdge, 3, 2) === 4 && atRightEdge.cells.length === 16,
    `最后一列=${cellAt(atRightEdge, 3, 2)}，cells.length=${atRightEdge.cells.length}`,
  );
  check(
    '热力图：同一个位置的物件不会串格（都落在同一格里，负载相加）',
    (() => {
      const data = computeHeatmap([obj(0, 0, 'fluid'), obj(0, 0, 'rigid')], GRID_OPTIONS);
      let nonEmpty = 0;
      for (let i = 0; i < data.cells.length; i += 1) if (data.cells[i]! > 0) nonEmpty += 1;
      return nonEmpty === 1 && cellSum(data) === 5;
    })(),
    `非空格数=${(() => {
      const data = computeHeatmap([obj(0, 0, 'fluid'), obj(0, 0, 'rigid')], GRID_OPTIONS);
      let n = 0;
      for (let i = 0; i < data.cells.length; i += 1) if (data.cells[i]! > 0) n += 1;
      return n;
    })()}`,
  );
  check(
    '热力图：x 走列、z 走行（世界 +X 落在最右列、+Z 落在最后一行）',
    cellAt(grid, 3, 3) === 2,
    `(col 3, row 3)=${cellAt(grid, 3, 3)}`,
  );
  check(
    '热力图：原点为负时坐标正确平移（不传 origin 会让左半边全被夹进第 0 列）',
    (() => {
      // x = +5、originX = -20、sizeX = 40 → ratio 0.625 → 第 2 列；若把原点当 0 会落进第 0 列
      const data = computeHeatmap([obj(5, -5, 'fluid')], GRID_OPTIONS);
      return cellAt(data, 2, 1) === 1 && cellAt(data, 0, 1) === 0;
    })(),
    `第 2 列=${cellAt(computeHeatmap([obj(5, -5, 'fluid')], GRID_OPTIONS), 2, 1)}`,
  );
  check(
    '热力图：y 不参与分箱（同样的 x / z 即便高度不同也落在同一格）',
    (() => {
      const data = computeHeatmap([{ x: 0, z: 0, y: 100, kind: 'fluid' }, { x: 0, z: 0, y: -100, kind: 'fluid' }], GRID_OPTIONS);
      return cellSum(data) === 2 && data.cells.length === 16;
    })(),
    `合计=${cellSum(computeHeatmap([{ x: 0, z: 0, y: 100, kind: 'fluid' }], GRID_OPTIONS))}`,
  );
  check(
    '热力图：cols / rows 非法（0 / 负数 / NaN）回落到默认 8 × 8',
    (() => {
      const cases = [0, -3, Number.NaN];
      return cases.every((value) => {
        const data = computeHeatmap([], { ...GRID_OPTIONS, cols: value, rows: value });
        return data.cols === 8 && data.rows === 8;
      });
    })(),
    `cols=${computeHeatmap([], { ...GRID_OPTIONS, cols: 0 }).cols}`,
  );
  check(
    '热力图：cols = 0.5 也回落到默认（先取整再判大小，否则格子宽度会变成 Infinity）',
    computeHeatmap([], { ...GRID_OPTIONS, cols: 0.5 }).cols === 8,
    `cols=${computeHeatmap([], { ...GRID_OPTIONS, cols: 0.5 }).cols}`,
  );

  // ==================================================================
  // 四、热力图：hottestCells
  // ==================================================================

  const hottest = hottestCells(grid);
  check(
    '热力图：hottestCells 按负载降序（三格：4 / 3 / 2 —— 沙土与地形同格合计是 2）',
    hottest.length === 3 && hottest[0]!.load === 4 && hottest[1]!.load === 3 && hottest[2]!.load === 2,
    hottest.map((cell) => `${cell.load}`).join(' → '),
  );
  check(
    '热力图：hottestCells 最多返回 count 条',
    hottestCells(grid, 2).length === 2 && hottestCells(grid, 0).length === 0,
    `count=2 → ${hottestCells(grid, 2).length} 条，count=0 → ${hottestCells(grid, 0).length} 条`,
  );
  check(
    '热力图：hottestCells 的坐标是格子中心的世界坐标（换算正确）',
    hottest[0]!.col === 0 &&
      hottest[0]!.row === 2 &&
      hottest[0]!.x === -15 &&
      hottest[0]!.z === 2.5 &&
      hottest[1]!.x === 5 &&
      hottest[1]!.z === -2.5,
    `第一格 (col ${hottest[0]!.col}, row ${hottest[0]!.row}) → 世界 (${hottest[0]!.x}, ${hottest[0]!.z})；第二格 (${hottest[1]!.x}, ${hottest[1]!.z})`,
  );
  check(
    '热力图：hottestCells 跳过 0 负载的格子（0 不是热点）',
    !hottestCells(empty, 16).some((cell) => cell.load === 0),
    `空图返回 ${hottestCells(empty, 16).length} 条`,
  );
  check(
    '热力图：hottestCells 负载相同时按行、再按列升序（顺序稳定，可截图比对）',
    (() => {
      const data = computeHeatmap([obj(5, -5, 'rigid'), obj(-15, 0, 'rigid')], GRID_OPTIONS);
      const cells = hottestCells(data, 2);
      return cells.length === 2 && cells[0]!.row === 1 && cells[1]!.row === 2;
    })(),
    (() => {
      const data = computeHeatmap([obj(5, -5, 'rigid'), obj(-15, 0, 'rigid')], GRID_OPTIONS);
      return hottestCells(data, 2)
        .map((cell) => `row ${cell.row}`)
        .join(' → ');
    })(),
  );

  // ==================================================================
  // 五、热力图：limitations（这张图不能回答什么）
  // ==================================================================

  const limitations = grid.limitations;
  check(
    '热力图：limitations 至少 4 条',
    limitations.length >= 4,
    `共 ${limitations.length} 条`,
  );
  check(
    '热力图：limitations 每条都含中文汉字',
    limitations.every((text) => hasChinese(text)),
    limitations.filter((text) => !hasChinese(text)).join(' / ') || '全部含中文',
  );
  check(
    '热力图：limitations 的文案里没有 ASCII 字母（"全是中文"这条自检才能按字符判）',
    !limitations.some((text) => hasAsciiLetter(text)),
    limitations.filter((text) => hasAsciiLetter(text)).join(' / ') || '没有 ASCII 字母',
  );
  check(
    '热力图：limitations 明确写了"不是每帧实际耗时"',
    limitations.some((text) => text.includes('不是每帧实际耗时')),
    limitations.find((text) => text.includes('不是每帧实际耗时'))?.slice(0, 40) ?? '(没找到)',
  );
  check(
    '热力图：limitations 点明了"权重是估计值，不是标定值"',
    limitations.some((text) => text.includes('估计值') && text.includes('标定')),
    limitations.find((text) => text.includes('标定'))?.slice(0, 40) ?? '(没找到)',
  );
  check(
    '热力图：limitations 点明了"不含相机因素"',
    limitations.some((text) => text.includes('相机')),
    limitations.find((text) => text.includes('相机'))?.slice(0, 40) ?? '(没找到)',
  );
  check(
    '热力图：limitations 点明了"世界尺寸或原点没给就无法分箱"',
    limitations.some((text) => text.includes('无法分箱')),
    limitations.find((text) => text.includes('无法分箱'))?.slice(0, 40) ?? '(没找到)',
  );
  check(
    '热力图：limitations 每次返回的都是新数组（调用方改一处不会少一条）',
    (() => {
      const first = grid.limitations;
      const before = first.length;
      first.length = 0;
      const second = computeHeatmap([], GRID_OPTIONS).limitations;
      return second.length === before;
    })(),
    `清掉一份之后新的一份仍有 ${computeHeatmap([], GRID_OPTIONS).limitations.length} 条`,
  );
  check(
    '热力图：describeHeatmap 里带着"加权物件数 / 估计值 / 不是每帧实际耗时"这几个字',
    hasChinese(describeHeatmap(grid)) &&
      describeHeatmap(grid).includes('加权物件数') &&
      describeHeatmap(grid).includes('不是每帧实际耗时'),
    describeHeatmap(grid).slice(0, 80),
  );

  // ==================================================================
  // 六、热力图：renderHeatmap（假 canvas，只验证契约）
  // ==================================================================

  // 渲染断言统一用 8 × 8：320 × 200 的假画布正好切成 40 × 25 的格子，可以直接数矩形
  const renderGrid = computeHeatmap(mixed, { ...GRID_OPTIONS, cols: 8, rows: 8 });
  const renderEmpty = computeHeatmap([], { ...GRID_OPTIONS, cols: 8, rows: 8 });

  const nullCanvas = doesNotThrow(() => renderHeatmap(null as unknown as HTMLCanvasElement, renderGrid));
  check('热力图：renderHeatmap 传 null canvas 不抛异常（HTML 片段没接上也不能崩）', nullCanvas.ok, nullCanvas.detail);

  const nullCtx = doesNotThrow(() => renderHeatmap(makeCanvas({ ctx: null }), renderGrid));
  check('热力图：getContext 返回 null 时安全返回，不抛异常', nullCtx.ok, nullCtx.detail);

  const throwingCtx = doesNotThrow(() => renderHeatmap(makeCanvas({ ctx: null, throws: true }), renderGrid));
  check('热力图：getContext 直接抛异常时也不抛出去', throwingCtx.ok, throwingCtx.detail);

  const zeroSize = doesNotThrow(() => renderHeatmap(makeCanvas({ ctx: makeCtx(), clientWidth: 0, clientHeight: 0 }), renderGrid));
  check('热力图：画布尺寸为 0（面板被隐藏）时安全返回，不做无用的位图分配', zeroSize.ok, zeroSize.detail);

  const paintedCtx = makeCtx();
  renderHeatmap(makeCanvas({ ctx: paintedCtx }), renderGrid);
  check(
    '热力图：有负载时逐格着色，格子数 = cols × rows（8 × 8 → 64 个 40 × 25 的矩形）',
    paintedCtx.countRects(40, 25) === 64,
    `40 × 25 的矩形画了 ${paintedCtx.countRects(40, 25)} 个`,
  );
  check(
    '热力图：画进 canvas 的角标里写着"这不是每帧实际耗时"（截图单独传播也不会被误读）',
    paintedCtx.text().includes('这不是每帧实际耗时'),
    paintedCtx.text().slice(0, 60),
  );
  check(
    '热力图：默认画出色标色带（一条 1 像素宽的渐变色带）',
    paintedCtx.countRects(1, 8) > 0,
    `1 × 8 的色带格子画了 ${paintedCtx.countRects(1, 8)} 个`,
  );
  check(
    '热力图：高分屏按 devicePixelRatio 放大位图（2 倍 → 640 × 400）',
    (() => {
      const canvas = makeCanvas({ ctx: makeCtx() });
      withDevicePixelRatio(2, () => renderHeatmap(canvas, renderGrid));
      return canvas.width === 640 && canvas.height === 400;
    })(),
    (() => {
      const canvas = makeCanvas({ ctx: makeCtx() });
      withDevicePixelRatio(2, () => renderHeatmap(canvas, renderGrid));
      return `${canvas.width} × ${canvas.height}`;
    })(),
  );
  check(
    '热力图：devicePixelRatio 封顶 3 倍（8 倍屏不会白烧 64 倍像素）',
    (() => {
      const canvas = makeCanvas({ ctx: makeCtx() });
      withDevicePixelRatio(8, () => renderHeatmap(canvas, renderGrid));
      return canvas.width === 960 && canvas.height === 600;
    })(),
    (() => {
      const canvas = makeCanvas({ ctx: makeCtx() });
      withDevicePixelRatio(8, () => renderHeatmap(canvas, renderGrid));
      return `${canvas.width} × ${canvas.height}`;
    })(),
  );
  check(
    '热力图：关闭图例后不画色带（showLegend: false）',
    (() => {
      const ctx = makeCtx();
      renderHeatmap(makeCanvas({ ctx }), renderGrid, { showLegend: false });
      return ctx.countRects(1, 8) === 0;
    })(),
    (() => {
      const ctx = makeCtx();
      renderHeatmap(makeCanvas({ ctx }), renderGrid, { showLegend: false });
      return `1 × 8 的矩形 ${ctx.countRects(1, 8)} 个`;
    })(),
  );
  check(
    '热力图：画布过小时不画色标（宁可少一个装饰，也不要两块文字叠在一起看不清）',
    (() => {
      const ctx = makeCtx();
      renderHeatmap(makeCanvas({ ctx, clientWidth: 120, clientHeight: 60 }), renderGrid);
      return ctx.countRects(1, 8) === 0 && ctx.text().includes('这不是每帧实际耗时');
    })(),
    '120 × 60 的画布上只有角标，没有色带',
  );
  check(
    '热力图：describeHeatmap 里也带着"权重是估计值"与"不含相机因素"的限定（图会被截图，文字不会跟着走）',
    describeHeatmap(renderGrid).includes('估计值') && describeHeatmap(renderGrid).includes('相机'),
    describeHeatmap(renderGrid).slice(-60),
  );
  check(
    '热力图：单色色带与彩色色带对同一格给出的颜色不同（投影 / 黑白截图用）',
    (() => {
      const heatCtx = makeCtx();
      const monoCtx = makeCtx();
      renderHeatmap(makeCanvas({ ctx: heatCtx }), renderGrid, { colormap: 'heat' });
      renderHeatmap(makeCanvas({ ctx: monoCtx }), renderGrid, { colormap: 'mono' });
      const heatColors = new Set(heatCtx.fills.map((fill) => fill.color));
      const monoColors = new Set(monoCtx.fills.map((fill) => fill.color));
      return heatColors.size > 1 && monoColors.size > 1 && [...heatColors].some((color) => !monoColors.has(color));
    })(),
    '两套色带的颜色集合不同',
  );

  const emptyCtx = makeCtx();
  renderHeatmap(makeCanvas({ ctx: emptyCtx }), renderEmpty);
  check(
    '热力图：maxLoad === 0 时画的是说明文字，而不是把每格涂成冷色',
    emptyCtx.countRects(40, 25) === 0 && emptyCtx.text().includes('还没有负载'),
    `格子矩形 ${emptyCtx.countRects(40, 25)} 个，文字「${emptyCtx.text().slice(0, 30)}」`,
  );
  check(
    '热力图：maxLoad === 0 时的说明文字里写清了"没有物件"不等于"这里不卡"',
    emptyCtx.text().includes('不是每帧实际耗时') && emptyCtx.text().includes('没有传进来任何可统计的物件'),
    emptyCtx.text().slice(0, 80),
  );
  check(
    '热力图：不可用时只画原因、不画任何格子',
    (() => {
      const ctx = makeCtx();
      renderHeatmap(makeCanvas({ ctx }), noSize);
      return ctx.countRects(40, 25) === 0 && ctx.text().includes('世界范围不可用');
    })(),
    (() => {
      const ctx = makeCtx();
      renderHeatmap(makeCanvas({ ctx }), noSize);
      return `格子 ${ctx.countRects(40, 25)} 个：${ctx.text().slice(0, 40)}`;
    })(),
  );

  // ==================================================================
  // 七、录制器：热路径与环形缓冲
  // ==================================================================

  // 这一段的两个数字在函数开头量好了（见"〇"）：干净堆上的最小值才算 sample 自己的开销
  const costs = idleSampleCosts;
  const cheapest = idleSampleCheapest;
  check(
    '录制：未开始录制时 sample 是零开销（10000 次调用 < 1 毫秒）',
    cheapest < 1,
    `五轮：${costs.map((cost) => cost.toFixed(3)).join(' / ')} 毫秒，取最小 ${cheapest.toFixed(3)} 毫秒` +
      `（同一环境里一次空函数调用的下限是 ${noopCheapest.toFixed(3)} 毫秒 / 万次）`,
  );
  check(
    '录制：未录制时的 sample 与"调一次空函数"同一量级（不是"接近 0"的口头承诺）',
    cheapest < noopCheapest * 3 + 0.1,
    `sample ${cheapest.toFixed(3)} 毫秒 vs 空函数 ${noopCheapest.toFixed(3)} 毫秒（每万次）`,
  );
  check(
    '录制：未开始时 sample 不改动任何状态（count 仍然是 0）',
    idleRecorder.count === 0 && idleRecorder.droppedFrames === 0 && idleRecorder.recording === false,
    `count=${idleRecorder.count}，recording=${String(idleRecorder.recording)}`,
  );
  check(
    '录制：没有样本时 summarize 的 avgFps / minFps / p95Ms 都是 null（不是 0）',
    (() => {
      const summary = idleRecorder.summarize();
      return summary.avgFps === null && summary.minFps === null && summary.p95Ms === null && summary.frames === 0;
    })(),
    (() => {
      const summary = idleRecorder.summarize();
      return `avgFps=${String(summary.avgFps)}，minFps=${String(summary.minFps)}，p95Ms=${String(summary.p95Ms)}`;
    })(),
  );
  check(
    '录制：没有样本时 describe 是中文，并说明"没有样本"，不编造帧率',
    hasChinese(idleRecorder.describe()) && idleRecorder.describe().includes('还没有任何帧'),
    idleRecorder.describe().slice(0, 60),
  );

  const growRecorder = new PerfRecorder({ capacity: 8 });
  growRecorder.start(1000);
  check('录制：start 之后 recording 为真、count 从 0 开始', growRecorder.recording && growRecorder.count === 0, `count=${growRecorder.count}`);
  growRecorder.sample(frame(0, 16));
  growRecorder.sample(frame(16, 17));
  const afterTwo = growRecorder.count;
  growRecorder.stop();
  growRecorder.sample(frame(32, 18));
  check(
    '录制：start 之后 count 随采样增长，stop 之后 sample 不再增长',
    afterTwo === 2 && growRecorder.count === 2 && growRecorder.recording === false,
    `两帧后 count=${afterTwo}，stop 并再采一帧后 count=${growRecorder.count}`,
  );
  check(
    '录制：重复 start 是"重新开始"（清空旧样本，不把两段录制拼成一个假跨度）',
    (() => {
      const recorder = new PerfRecorder({ capacity: 8 });
      recorder.start(0);
      recorder.sample(frame(0, 16));
      recorder.start(5000);
      return recorder.count === 0 && recorder.summarize().durationMs === 0;
    })(),
    '重新 start 之后 count 归零',
  );

  // 环形覆盖：容量 4、写 10 帧，帧耗时按序号递增 → 留下的应该是最后 4 帧
  const ring = new PerfRecorder({ capacity: 4 });
  ring.start(0);
  for (let i = 0; i < 10; i += 1) ring.sample(frame(i * 10, i + 1, { physics: i + 0.5 }, i, i + 1));
  const ringSummary = ring.summarize();
  check(
    '录制：超过容量时环形覆盖，count 停在容量（不做 shift 的 O(n) 搬移）',
    ring.count === 4,
    `count=${ring.count}`,
  );
  check(
    '录制：丢帧数被如实报告（= 累计写入 - 容量，不是静默丢弃）',
    ringSummary.droppedFrames === 6 && ringSummary.totalRecorded === 10 && ringSummary.capacity === 4,
    `丢弃 ${ringSummary.droppedFrames} 帧 / 累计写入 ${ringSummary.totalRecorded} 帧 / 容量 ${ringSummary.capacity}`,
  );
  check(
    '录制：覆盖之后留下的是最新的一批帧（最旧的被丢掉）',
    (() => {
      const frames = ring.exportJson().frames;
      return frames.length === 4 && frames[0]!.ms === 7 && frames[3]!.ms === 10;
    })(),
    `窗口内帧耗时=${ring.exportJson().frames.map((item) => item.ms).join('、')}`,
  );
  check(
    '录制：覆盖之后 describe 里明确写出"覆盖丢弃 N 帧"（导出缺了一段必须能看出来）',
    ring.describe().includes('覆盖丢弃最旧 6 帧'),
    ring.describe().slice(0, 80),
  );
  check(
    '录制：丢帧数也如实出现在 CSV 的注释行里',
    ring.exportCsv().includes('丢弃最旧 6 帧'),
    ring
      .exportCsv()
      .split('\n')
      .filter((line) => line.includes('丢弃'))
      .join(' | '),
  );
  check(
    '录制：clear 之后 count 与丢帧数都归零，且不影响录制状态',
    (() => {
      const recorder = new PerfRecorder({ capacity: 4 });
      recorder.start(0);
      for (let i = 0; i < 7; i += 1) recorder.sample(frame(i, 16));
      recorder.clear();
      return recorder.count === 0 && recorder.droppedFrames === 0 && recorder.recording === true;
    })(),
    'clear 后 count=0、droppedFrames=0、仍在录制',
  );

  // ==================================================================
  // 八、录制器：统计口径
  // ==================================================================

  const statsRecorder = new PerfRecorder({ capacity: 64 });
  statsRecorder.start(0);
  const statFrames: { t: number; ms: number }[] = [];
  for (let i = 0; i < 20; i += 1) {
    const t = i * 16.7;
    const ms = i + 1;
    statFrames.push({ t, ms });
    // 阶段拆解固定成"物理占大头"：这样最慢那几帧的 worstPhase 必然都是"物理求解"，
    // 断言才能真的验证"标签是中文"，而不是碰运气命中一个平局
    statsRecorder.sample(frame(t, ms, { physics: ms * 0.8, render: ms * 0.2 }));
  }
  const stats = statsRecorder.summarize();
  const handSpan = statFrames[19]!.t - statFrames[0]!.t;
  const handAvgFps = (statFrames.length - 1) / (handSpan / 1000);
  check(
    '录制：avgFps 与手算一致（(帧数 - 1) / 时间戳跨度秒数，首帧不算成一个间隔）',
    stats.avgFps !== null && Math.abs(stats.avgFps - handAvgFps) < 1e-9,
    `实现 ${String(stats.avgFps)}，手算 ${handAvgFps.toFixed(4)}`,
  );
  check(
    '录制：durationMs 是第一个样本到最后一个样本的跨度',
    Math.abs(stats.durationMs - handSpan) < 1e-9,
    `实现 ${stats.durationMs}，手算 ${handSpan.toFixed(3)}`,
  );
  check(
    '录制：minFps = 1000 / 最慢帧耗时（由最慢帧折算，不是实测的窗口最低帧率）',
    stats.minFps !== null && Math.abs(stats.minFps - 1000 / 20) < 1e-9,
    `实现 ${String(stats.minFps)}，手算 ${(1000 / 20).toFixed(2)}`,
  );
  check(
    '录制：只有 1 帧时 avgFps 是 null（跨度是 0，不能除以 0）',
    (() => {
      const recorder = new PerfRecorder({ capacity: 4 });
      recorder.start(0);
      recorder.sample(frame(0, 16));
      return recorder.summarize().avgFps === null && recorder.summarize().durationMs === 0;
    })(),
    '单帧样本 → avgFps=null',
  );
  check(
    '录制：p95Ms 与手算的最近秩结果一致（升序取下标，不插值）',
    (() => {
      const sorted = statFrames.map((item) => item.ms).sort((a, b) => a - b);
      const expected = sorted[Math.ceil(0.95 * sorted.length) - 1]!;
      return stats.p95Ms === expected;
    })(),
    `实现 ${String(stats.p95Ms)}，手算 ${statFrames.map((item) => item.ms).sort((a, b) => a - b)[18]}`,
  );
  check(
    '录制：slowest 按帧耗时降序、最多 5 条',
    stats.slowest.length === 5 &&
      stats.slowest.every((item, index) => index === 0 || stats.slowest[index - 1]!.ms >= item.ms),
    `共 ${stats.slowest.length} 条：${stats.slowest.map((item) => item.ms.toFixed(1)).join('、')}`,
  );
  check(
    '录制：slowest 的 worstPhase 是中文阶段标签（physics → 物理求解）',
    stats.slowest[0]!.ms === 20 &&
      stats.slowest[0]!.worstPhase === '物理求解' &&
      stats.slowest.every((item) => hasChinese(item.worstPhase)),
    `最慢 5 帧的最慢阶段=${stats.slowest.map((item) => item.worstPhase).join('、')}`,
  );
  check(
    '录制：slowest 的 index 是绝对帧序号（覆盖回绕之后仍然连续，能和日志对上）',
    (() => {
      const frames = ring.summarize().slowest.map((item) => item.index);
      return frames.length === 4 && frames[0] === 9 && frames[3] === 6;
    })(),
    `回绕后窗口里的序号=${ring.summarize().slowest.map((item) => item.index).join('、')}`,
  );
  check(
    '录制：没有阶段数据的帧 worstPhase 给中文占位（不留空、也不假装是某个阶段）',
    (() => {
      const recorder = new PerfRecorder({ capacity: 4 });
      recorder.start(0);
      recorder.sample(frame(0, 30, {}));
      return recorder.summarize().slowest[0]!.worstPhase === '未记录阶段耗时';
    })(),
    '无阶段数据的帧 → 未记录阶段耗时',
  );
  check(
    '录制：没登记中文标签的阶段名原样显示（便于一眼看出漏登记，与 phaseLabel 的约定一致）',
    (() => {
      const recorder = new PerfRecorder({ capacity: 4 });
      recorder.start(0);
      recorder.sample(frame(0, 30, { wobble: 5 }));
      return recorder.summarize().slowest[0]!.worstPhase === 'wobble';
    })(),
    '未登记阶段名 → 原样显示 wobble',
  );
  check(
    '录制：存在 NaN 阶段耗时的帧不会把 0 当事实写进导出（直接不给这个 key）',
    (() => {
      const recorder = new PerfRecorder({ capacity: 4 });
      recorder.start(0);
      recorder.sample(frame(0, 16, { physics: Number.NaN, mesh: 5 }));
      const phases = recorder.exportJson().frames[0]!.phases;
      return phases.mesh === 5 && !('physics' in phases);
    })(),
    'physics=NaN 被丢掉，mesh=5 保留',
  );
  check(
    '录制：负的帧耗时按 0 记（负数流进 p95 / 最慢帧会让整个摘要失去意义）',
    (() => {
      const recorder = new PerfRecorder({ capacity: 4 });
      recorder.start(0);
      recorder.sample(frame(0, -30));
      const summary = recorder.summarize();
      return summary.frames === 1 && summary.maxMs === 0 && summary.minFps === null;
    })(),
    '负帧耗时 → 0，minFps=null',
  );
  check(
    '录制：start 传了非有限时间戳时导出里不会出现 NaN（JSON 里会变成 null，那是另一种含义）',
    (() => {
      const recorder = new PerfRecorder({ capacity: 4 });
      recorder.start(Number.NaN);
      recorder.sample(frame(0, 16));
      const exported = recorder.exportJson();
      return exported.startedAtMs === 0 && Number.isFinite(exported.startedAtMs);
    })(),
    'startedAtMs=0（表示拿不到可用时间戳）',
  );
  check(
    '录制：stop 之后 stoppedAtMs 有值、未 stop 时为 null（且它不能与 startedAtMs 相减）',
    (() => {
      const recorder = new PerfRecorder({ capacity: 4 });
      recorder.start(0);
      const beforeStop = recorder.exportJson().stoppedAtMs;
      recorder.stop();
      return beforeStop === null && recorder.exportJson().stoppedAtMs !== null;
    })(),
    '未 stop=null，stop 后=模块自己的时钟读数',
  );
  check(
    '录制：容量非法时不会崩，且有下限 1（0 / 负数 → 1，NaN → 默认值）',
    new PerfRecorder({ capacity: 0 }).capacity === 1 &&
      new PerfRecorder({ capacity: -5 }).capacity === 1 &&
      new PerfRecorder({ capacity: Number.NaN }).capacity === 600 &&
      new PerfRecorder({ capacity: 1e9 }).capacity === 100_000,
    `0→${new PerfRecorder({ capacity: 0 }).capacity}，-5→${new PerfRecorder({ capacity: -5 }).capacity}，NaN→${new PerfRecorder({ capacity: Number.NaN }).capacity}，1e9→${new PerfRecorder({ capacity: 1e9 }).capacity}`,
  );

  // ==================================================================
  // 九、录制器：导出
  // ==================================================================

  const exportedJson = statsRecorder.exportJson();
  const reparsed = (() => {
    try {
      return JSON.parse(JSON.stringify(exportedJson)) as typeof exportedJson;
    } catch {
      return null;
    }
  })();
  check(
    '录制：exportJson 能被 JSON.parse 回来（结构可直接 stringify）',
    reparsed !== null && reparsed.frames.length === exportedJson.frames.length,
    reparsed === null ? 'parse 失败' : `parse 回 ${reparsed.frames.length} 帧`,
  );
  check(
    '录制：exportJson 的帧数与窗口帧数一致，并带 version / capacity / summary',
    exportedJson.frames.length === statsRecorder.count &&
      exportedJson.version === 1 &&
      exportedJson.capacity === statsRecorder.capacity &&
      exportedJson.summary.frames === statsRecorder.count,
    `frames=${exportedJson.frames.length}，version=${exportedJson.version}，capacity=${exportedJson.capacity}`,
  );
  check(
    '录制：exportJson 的帧里没有 NaN / Infinity（JSON 里会变成 null，读的人查不出原因）',
    (() => {
      const text = JSON.stringify(exportedJson.frames);
      return (
        !text.includes('null') &&
        exportedJson.frames.every(
          (item) => Number.isFinite(item.t) && Number.isFinite(item.ms) && Number.isFinite(item.particles) && Number.isFinite(item.bodies),
        )
      );
    })(),
    JSON.stringify(exportedJson.frames[0]),
  );
  check(
    '录制：exportJson 导出的是快照拷贝（改导出结果不会改坏录制里的帧）',
    (() => {
      const recorder = new PerfRecorder({ capacity: 4 });
      recorder.start(0);
      recorder.sample(frame(0, 16, { physics: 5 }));
      const exported = recorder.exportJson();
      exported.frames[0]!.phases.physics = 999;
      exported.frames[0]!.ms = 999;
      const again = recorder.exportJson().frames[0]!;
      return again.ms === 16 && again.phases.physics === 5;
    })(),
    '改导出结果不影响下一次导出',
  );
  check(
    '录制：hot path 存的是 phases 引用（零分配的代价：录完之后再改那个对象会改到录制）—— 如实记录这条取舍',
    (() => {
      const recorder = new PerfRecorder({ capacity: 4 });
      recorder.start(0);
      const phases = { physics: 5 };
      recorder.sample(frame(0, 16, phases));
      phases.physics = 777; // 调用方在本帧之后复用了同一个对象：录制内容会跟着变
      return recorder.exportJson().frames[0]!.phases.physics === 777;
    })(),
    '调用方复用 phases 对象时录制会跟着变（所以 sample 的注释里写着"不要复用"）',
  );

  const csv = statsRecorder.exportCsv();
  const csvLines = csv.split('\n');
  check(
    '录制：exportCsv 的行数 = 中文注释行 + 表头 + 帧数',
    (() => {
      const comments = csvLines.filter((line) => line.startsWith('#')).length;
      const dataLines = csvLines.filter((line) => !line.startsWith('#')).length;
      return comments >= 1 && dataLines === statsRecorder.count + 1;
    })(),
    `共 ${csvLines.length} 行（注释 ${csvLines.filter((line) => line.startsWith('#')).length}、数据 ${csvLines.filter((line) => !line.startsWith('#')).length}）`,
  );
  check(
    '录制：exportCsv 能被按逗号切开，且每行列数一致（阶段列按整段录制里出现过的阶段并集）',
    (() => {
      const rows = csvLines.filter((line) => !line.startsWith('#')).map((line) => line.split(','));
      const width = rows[0]!.length;
      return width === 7 && rows.every((row) => row.length === width);
    })(),
    (() => {
      const rows = csvLines.filter((line) => !line.startsWith('#')).map((line) => line.split(','));
      return `表头 ${rows[0]!.length} 列：${rows[0]!.join(' | ')}`;
    })(),
  );
  check(
    '录制：exportCsv 的注释行（# 开头，便于 Excel 忽略）与表头都是中文',
    csvLines[0]!.startsWith('#') &&
      hasChinese(csvLines[0]!) &&
      hasChinese(csvLines.filter((line) => !line.startsWith('#'))[0]!),
    `${csvLines[0]!.slice(0, 40)} ／ ${csvLines.filter((line) => !line.startsWith('#'))[0]!.slice(0, 40)}`,
  );
  check(
    '录制：exportCsv 的数字一律保留两位小数',
    (() => {
      const rows = csvLines.filter((line) => !line.startsWith('#')).slice(1);
      return rows.every((line) => {
        const cells = line.split(',');
        return cells.slice(0, 5).every((cell) => /^-?\d+\.\d{2}$/.test(cell));
      });
    })(),
    csvLines.filter((line) => !line.startsWith('#'))[2]!,
  );
  check(
    '录制：exportCsv 里缺失的阶段留空，不填 0（填 0 会被读成"这一阶段真的耗时 0 毫秒"）',
    (() => {
      const recorder = new PerfRecorder({ capacity: 4 });
      recorder.start(0);
      recorder.sample(frame(0, 16, { physics: 4 }));
      recorder.sample(frame(16, 16, { mesh: 2 }));
      const rows = recorder
        .exportCsv()
        .split('\n')
        .filter((line) => !line.startsWith('#'));
      const first = rows[1]!.split(',');
      const second = rows[2]!.split(',');
      // 表头顺序是「帧序号, 时间戳, 帧耗时, 粒子数, 刚体数, 物理求解, 区块重建」
      return rows[0]!.includes('物理求解(毫秒)') && rows[0]!.includes('区块重建(毫秒)') && first[6] === '' && second[5] === '';
    })(),
    '缺的那一格是空字符串，不是 0.00',
  );
  check(
    '录制：exportCsv 用中文阶段标签当列名（不是 physics / render 这种代码 key）',
    csvLines.some((line) => line.includes('物理求解(毫秒)')) &&
      csvLines.some((line) => line.includes('渲染提交(毫秒)')) &&
      !csvLines.some((line) => line.includes('physics') || line.includes('render')),
    csvLines.find((line) => line.includes('物理求解'))?.slice(0, 70) ?? '(没找到)',
  );
  check(
    '录制：有样本时 describe 是中文，且说明帧率是折算出来的（不是浏览器上报的帧率）',
    hasChinese(statsRecorder.describe()) &&
      statsRecorder.describe().includes('折算') &&
      statsRecorder.describe().includes('本模块不做测量'),
    statsRecorder.describe().slice(0, 90),
  );

  // ==================================================================
  // 十、纯逻辑：在 Node 里（没有 DOM、没有 WebGL）也能跑
  // ==================================================================

  const pureOk = doesNotThrow(() => {
    const data = computeHeatmap([{ x: 0, z: 0, kind: 'rigid' }], { sizeX: 10, sizeZ: 10, originX: -5, originZ: -5 });
    const summary = new PerfRecorder({ capacity: 2 });
    summary.start(0);
    summary.sample(frame(0, 16, { physics: 1 }, 1, 1));
    const text = [
      describeHeatmap(data),
      String(hottestCells(data, 3).length),
      String(data.limitations.length),
      summary.describe(),
      summary.exportCsv(),
      JSON.stringify(summary.exportJson()),
    ].join('｜');
    if (text.length === 0) throw new Error('三个纯逻辑入口都没返回内容');
  });
  check(
    '纯逻辑：热力图与录制器的全部纯逻辑入口在 Node 里调用都不抛异常（不依赖 DOM / WebGL）',
    pureOk.ok,
    pureOk.detail,
  );
  check(
    '纯逻辑：渲染之外的所有入口都不需要 canvas（computeHeatmap / describe / hottestCells / 录制全套）',
    (() => {
      const data = computeHeatmap([obj(0, 0, 'sand')], { sizeX: 4, sizeZ: 4 });
      return describeHeatmap(data).length > 0 && hottestCells(data, 1).length === 1 && data.limitations.length >= 4;
    })(),
    '在 Node 里算出负载、热点与限制清单',
  );
}
