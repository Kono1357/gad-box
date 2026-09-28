/**
 * 帧采样录制（src/perf 新增模块 · 性能压力测试配套 2/2）。
 *
 * 编号说明：仓库里已有的 5 个 perf 模块自称「1/5 … 5/5」，本批新增的两个不并入那套编号
 * —— 改了分母就要回头改那 5 个文件的头注释，而这里只新增不改。
 *
 * ────────────────────────────────────────────────────────────
 * ⚠ 这个模块**不做任何测量**
 * ────────────────────────────────────────────────────────────
 * 每一帧的毫秒数、阶段拆解、粒子数、刚体数，**全部是调用方（Engine 的帧循环）喂进来的**。
 * 它只负责：留一段环形缓冲、按时间顺序保存、如实报告丢了多少帧、导出成 JSON / CSV。
 * 所以导出的文件里不该出现"本模块测出"这种说法 —— 帧耗时的可信度取决于喂进来的那个数，
 * 这个模块既不能验证也不能提升它。
 *
 * ────────────────────────────────────────────────────────────
 * 环形缓冲：定长数组 + 写指针（不用 `shift()`）
 * ────────────────────────────────────────────────────────────
 * `shift()` 会把后面所有元素往前搬，是 O(n) 的；每帧调一次等于白送一次数组拷贝，
 * 而这个模块存在的意义恰恰是"录制时几乎不增加开销"。满了就覆盖最旧的，并把
 * **覆盖掉多少帧如实记在 `droppedFrames` 里**：静默丢弃是最坏的选择 ——
 * 导出的帧数与玩家实际玩的时间对不上，而文件里看不出为什么。
 *
 * 写指针与"窗口里最旧那一帧的绝对序号"是分开算的（`written - count`），
 * 所以覆盖回绕之后帧序号仍然连续，能和日志 / 慢帧记录对上。
 *
 * ────────────────────────────────────────────────────────────
 * 两处"宁可说不可用，也不给一个像样的数字"
 * ────────────────────────────────────────────────────────────
 * 1. **`avgFps` 没有样本时是 `null`，不是 0**。0 帧/秒会被读成"卡到不动了"，
 *    而真相是"还没开始采样"。同理 `p95Ms` / `minFps` 也都可以是 `null`。
 * 2. **时长由帧时间戳算，不由 `start` / `stop` 的挂钟算**。契约里 `stop()` 不接参数，
 *    所以它只能取模块自己的时钟（`performance.now()`）；而 `start(nowMs)` 的时间戳是
 *    **调用方给的**，两边基准可能根本不同（一个是 `Date.now()`，一个是 `performance.now()`），
 *    相减毫无意义。`durationMs` 因此一律取"第一个样本到最后一个样本"的跨度，
 *    并在 `exportJson().stoppedAtMs` 的注释里写明它与 `startedAtMs` 不可相减。
 *
 * 纯逻辑、零依赖：不 import three / Rapier / Engine / DOM（只从 `FrameProfiler` 借
 * 阶段名 → 中文标签那一个函数，那也是纯逻辑），可以直接在 Node 里断言。
 */

import { phaseLabel } from './FrameProfiler';

export interface RecordedFrame {
  /** 帧的时间戳（毫秒）。同一份录制里必须是同一个时钟源的读数 */
  t: number;
  /** 帧耗时（毫秒） */
  ms: number;
  /** 这一帧各阶段的耗时（阶段名 → 毫秒）。缺失的阶段**不要填 0**，直接不给这个 key */
  phases: Record<string, number>;
  /** 采样时的粒子数 */
  particles: number;
  /** 采样时的刚体数 */
  bodies: number;
}

export interface RecorderOptions {
  /** 环形缓冲容量（帧）。默认 600（60 FPS 下约 10 秒）；非法值回落到 1 .. 100000 */
  capacity?: number;
}

/** `summarize()` 的完整结果。带 `| null` 的字段表示"这次算不出来"，不是 0 */
export interface RecorderSummary {
  /** 当前窗口里的帧数（≤ capacity） */
  frames: number;
  /** 第一个样本到最后一个样本的时间戳跨度（毫秒）。不足 2 帧时为 0 */
  durationMs: number;
  /** 平均帧率。没有样本、或时间戳跨度不成立时为 null */
  avgFps: number | null;
  /** 按**最慢的一帧**折算的帧率（1000 / 最慢帧耗时）。没有有效帧耗时时为 null */
  minFps: number | null;
  /** p95 帧耗时（最近秩法，不插值）。没有样本时为 null */
  p95Ms: number | null;
  /** 最慢的几帧（最多 5 条），含中文阶段标签 */
  slowest: { index: number; ms: number; worstPhase: string }[];
  /** 窗口里最大的帧耗时；0 表示没有样本 */
  maxMs: number;
  /**
   * 因环形覆盖而**丢掉的最旧帧数**（= 累计写入 - 窗口帧数）。
   * 这个数字必须出现在摘要里：它是"导出看起来完整、实际缺了一段"的唯一线索。
   */
  droppedFrames: number;
  /** 环形容量 */
  capacity: number;
  /** 累计写入过的帧数（含已被覆盖的） */
  totalRecorded: number;
}

/** `exportJson()` 的结构。整个对象可以直接 `JSON.stringify` */
export interface RecorderExport {
  /** 导出格式版本。字段含义变了就 +1，读的人据此判断能不能按老格式解 */
  version: number;
  /** 开始录制的时刻（调用方传给 `start` 的值）。没开始过、或传进来的不是有限数时为 0 */
  startedAtMs: number;
  /**
   * 停止录制的时刻。**与 `startedAtMs` 不可相减**：`stop()` 不接参数，
   * 这里取的是模块自己的时钟，基准可能与调用方给的不同。时长请看 `summary.durationMs`。
   */
  stoppedAtMs: number | null;
  capacity: number;
  frames: RecordedFrame[];
  summary: RecorderSummary;
}

/** 默认容量 600 帧：60 FPS 下约 10 秒，够覆盖一次压力测试的操作回合，内存也只有几万个数字 */
const DEFAULT_CAPACITY = 600;
/**
 * 容量上限。防呆：`capacity = 1e9` 会在构造时就把内存吃光，
 * 而调用方看到的只是"页面崩了"。10 万帧（约 27 分钟 @60FPS）足够任何用途。
 */
const MAX_CAPACITY = 100_000;
/** `slowest` 最多返回几条 */
const SLOWEST_LIMIT = 5;
/** CSV 里数字保留几位小数 */
const CSV_DECIMALS = 2;
/** 导出格式版本 */
const EXPORT_VERSION = 1;
/** 这一帧没有任何阶段数据时，`worstPhase` 显示的中文占位 */
const NO_PHASE_LABEL = '未记录阶段耗时';

/**
 * 把时间戳规整成有限数。
 *
 * 为什么必须做：`JSON.stringify` 会把 `NaN` 和 `Infinity` 写成 `null`，
 * 导出文件里出现 `null` 是**查不出原因**的（读的人无法分辨"当时没数据"和"当时算错了"）。
 */
function finiteOr(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 帧耗时规整：非有限值或**负数**一律按 0 记（与 `FrameProfiler.push` 同一条规矩）。
 * 负的帧耗时不可能存在，出现它说明上游时钟坏了；而让负数流进 p95 / 最慢帧 / 最低帧率，
 * 整份摘要就没有意义了。宁可显示"这一帧是 0 毫秒"，也不要显示"这一帧是 -30 毫秒"。
 */
function durationOr(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 计数规整：非有限或负值按 0，小数向下取整（计数本身就该是整数） */
function countOr(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/** 容量规整：非法值按默认；0 / 负数夹到 1（能装 1 帧的缓冲比偷偷换成 600 帧更好解释） */
function capacityOf(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CAPACITY;
  if (!Number.isFinite(value)) return DEFAULT_CAPACITY;
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  return Math.min(MAX_CAPACITY, floored);
}

/** 分位数（最近秩法，与 `FrameProfiler` 同一套语义）：升序数组里取下标，不做插值 */
function pickPercentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

/** CSV 单元格消毒：阶段名里的逗号 / 引号 / 换行会直接破坏列结构 */
function sanitizeCell(text: string): string {
  return text.replace(/,/g, '，').replace(/"/g, '').replace(/[\r\n]/g, ' ');
}

/** 内部快照的一帧：比 `RecordedFrame` 多一个绝对帧序号 */
interface IndexedFrame extends RecordedFrame {
  /** 从录制器创建起累计的帧序号（覆盖回绕之后仍然连续） */
  index: number;
}

export class PerfRecorder {
  private readonly capacityValue: number;

  // ── 环形缓冲：五组定长数组 + 一个写指针（与 FrameProfiler 同一套写法） ──
  private readonly tRing: number[];
  private readonly msRing: number[];
  /** 保存调用方给的 phases 引用：**不拷贝**（每帧拷一个对象就是给热路径加开销）；
   *  `snapshot()` 读出时再深拷一份，外部改到原对象也不会改坏导出 */
  private readonly phaseRing: (Record<string, number> | undefined)[];
  private readonly particleRing: number[];
  private readonly bodyRing: number[];
  /** 下一次写入的位置 */
  private head = 0;
  /** 当前窗口里的帧数（≤ capacity） */
  private countValue = 0;
  /** 累计写入过的帧数（不因回绕清零）：绝对帧序号与丢帧数都由它推出来 */
  private written = 0;
  private recordingFlag = false;
  private startedAtMs = 0;
  private stoppedAtMs: number | null = null;

  constructor(options: RecorderOptions = {}) {
    this.capacityValue = capacityOf(options.capacity);
    const size = this.capacityValue;
    this.tRing = new Array<number>(size).fill(0);
    this.msRing = new Array<number>(size).fill(0);
    this.phaseRing = new Array<Record<string, number> | undefined>(size).fill(undefined);
    this.particleRing = new Array<number>(size).fill(0);
    this.bodyRing = new Array<number>(size).fill(0);
  }

  /** 环形容量（帧） */
  get capacity(): number {
    return this.capacityValue;
  }

  /** 是否正在录制。热路径上的 `sample()` 第一件事就是看它 */
  get recording(): boolean {
    return this.recordingFlag;
  }

  /** 当前窗口里的帧数 */
  get count(): number {
    return this.countValue;
  }

  /** 因环形覆盖丢掉的最旧帧数（= 累计写入 - 窗口帧数） */
  get droppedFrames(): number {
    return this.written - this.countValue;
  }

  /**
   * 开始录制。
   *
   * 重复调用 = **重新开始**（清空已有样本并重置时刻），不是"接着录"：
   * 保留上一次的帧会让 `durationMs` 变成两段录制拼接出来的假跨度，
   * 而"开始录制"和"从这一刻起量"在玩家眼里本来就是同一个动作。
   *
   * `nowMs` 不是有限数时按 0 记 —— 不把 `NaN` 存进去，否则导出 JSON 里会出现
   * `null`，而 `null` 在这个字段上的含义应该是"没开始录"（两件事混在一起就查不清了）。
   */
  start(nowMs: number): void {
    this.clear();
    this.recordingFlag = true;
    this.startedAtMs = finiteOr(nowMs, 0);
    this.stoppedAtMs = null;
  }

  /**
   * 停止录制。窗口里的样本保留（导出用的就是它们），只是不再接受新帧。
   * 未在录制时调用是**空操作**（不会覆盖上一次的 `stoppedAtMs`）。
   */
  stop(): void {
    if (!this.recordingFlag) return;
    this.recordingFlag = false;
    this.stoppedAtMs = currentNow();
  }

  /**
   * 记一帧。**每帧调用**，所以未录制时必须几乎零开销：第一行就返回，
   * 不碰任何数组、不分配对象、不看 `frame` 的字段。
   *
   * 录制中也是零分配的：只把标量写进定长数组、把 `phases` 的**引用**存下来。
   * 唯一的规整是"非有限值或负数按 0"，它不产生新对象（见 `durationOr`）。
   *
   * ⚠ 这条零分配是有代价的，调用方必须知道：**不要在后续帧里改同一个 phases 对象**。
   * 存引用意味着"先 `sample()` 再改那个对象"，录制内容会跟着变（导出时读到的是改后的值）。
   * 帧循环里两种做法都安全：每帧新建一个 `{ ... }`，或者一直不复用这个对象。
   */
  sample(frame: RecordedFrame): void {
    if (!this.recordingFlag) return;

    const slot = this.head;
    this.tRing[slot] = finiteOr(frame.t, 0);
    this.msRing[slot] = durationOr(frame.ms);
    this.phaseRing[slot] = frame.phases;
    this.particleRing[slot] = countOr(frame.particles, 0);
    this.bodyRing[slot] = countOr(frame.bodies, 0);

    this.head = (this.head + 1) % this.capacityValue;
    if (this.countValue < this.capacityValue) this.countValue += 1;
    this.written += 1;
  }

  /**
   * 清空样本。**不改录制状态与开始时刻**：
   * clear 的语义是"把已经采到的样本倒掉"，而不是"重新开始一次录制"
   * （想重新计时就 `stop()` + `start()`）。这样在没有 stop 的情况下清空，
   * `durationMs` 仍会随新样本继续正常算。
   */
  clear(): void {
    this.head = 0;
    this.countValue = 0;
    this.written = 0;
    this.phaseRing.fill(undefined);
    this.tRing.fill(0);
    this.msRing.fill(0);
    this.particleRing.fill(0);
    this.bodyRing.fill(0);
  }

  /**
   * 摘要。每次调用都重算（窗口最多几万帧，重算是毫秒级；而维护增量状态在
   * clear / 回绕 / 阶段名动态出现时极易算错 —— 面板上显示一个错的数字比慢一点更糟）。
   */
  summarize(): RecorderSummary {
    return this.summarizeOf(this.snapshot());
  }

  /** 一行中文摘要。玩家只读这一句，所以"帧率是折算的"必须写进去 */
  describe(): string {
    const state = this.recordingFlag ? '录制中' : '已停止';
    const summary = this.summarize();
    const dropped =
      summary.droppedFrames > 0
        ? `｜⚠ 环形缓冲已满，覆盖丢弃最旧 ${summary.droppedFrames} 帧（这部分不在导出里）`
        : '｜没有覆盖丢弃';

    if (summary.frames === 0) {
      return (
        `帧录制：${state}｜窗口里还没有任何帧（容量 ${this.capacityValue} 帧，累计写入 0）` +
        '｜帧率、分位数、最慢帧都不可用（没有样本时不给 0，0 会被读成"卡到不动"）'
      );
    }

    const avg =
      summary.avgFps === null
        ? '平均帧率不可用（样本不足以算出时间跨度）'
        : `平均 ${summary.avgFps.toFixed(1)} 帧/秒`;
    const min =
      summary.minFps === null
        ? '最低帧率不可用（没有有效的帧耗时）'
        : `按最慢帧折算最低 ${summary.minFps.toFixed(1)} 帧/秒`;
    const p95 = summary.p95Ms === null ? 'p95 不可用' : `p95 ${summary.p95Ms.toFixed(1)} 毫秒`;
    const worst = summary.slowest[0];
    const worstText =
      worst === undefined
        ? ''
        : `｜最慢 #${worst.index} ${worst.ms.toFixed(1)} 毫秒（${worst.worstPhase}）`;

    return (
      `帧录制：${state}｜窗口内 ${summary.frames} 帧 / 容量 ${this.capacityValue}，` +
      `累计写入 ${summary.totalRecorded} 帧｜时长 ${(summary.durationMs / 1000).toFixed(1)} 秒（按帧时间戳首尾差算）｜` +
      `${avg}｜${min}｜${p95}${worstText}${dropped}` +
      '｜帧率是按帧时间戳折算的，不是浏览器上报的帧率；帧耗时本身由调用方喂进来，本模块不做测量'
    );
  }

  /**
   * 导出 JSON（可直接 `JSON.stringify`）。
   *
   * 导出的是**快照拷贝**：`phases` 逐层拷过，不与环形缓冲共享对象 ——
   * 否则调用方在 `JSON.stringify` 之后再动一次原来那个 phases 对象，
   * 导出结果会跟着变，而改动发生在导出之后这件事没人看得出来。
   * （这只保护"改导出结果"，不保护"录完之后又改了调用方自己那个 phases 对象"——见 `sample()`。）
   */
  exportJson(): RecorderExport {
    const frames = this.snapshot();
    return {
      version: EXPORT_VERSION,
      startedAtMs: this.startedAtMs,
      stoppedAtMs: this.stoppedAtMs,
      capacity: this.capacityValue,
      frames: frames.map((frame) => ({
        t: frame.t,
        ms: frame.ms,
        phases: frame.phases,
        particles: frame.particles,
        bodies: frame.bodies,
      })),
      summary: this.summarizeOf(frames),
    };
  }

  /**
   * 导出 CSV。
   *
   * - 开头若干行 `#` 中文注释（Excel 打开时会当成整行文本，不会串列）；
   * - 表头与列名用中文；阶段名用 `phaseLabel` 的中文标签，**没登记过标签的阶段名原样出现**
   *   （这是 `phaseLabel` 的约定：一眼能看出漏登记，比悄悄显示一个占位名有用）；
   * - 数字一律保留两位小数（含计数列）：列宽一致比省两个字符更值得；
   * - 某一帧缺少某个阶段时该格留**空**，不填 0 —— 填 0 会被读成"这一阶段真的耗时 0 毫秒"；
   * - **结尾不加换行**：加了之后 `split('\n')` 会多出一个空字符串，
   *   "行数 = 注释 + 表头 + 帧数"这条自检就失效了。
   */
  exportCsv(): string {
    const frames = this.snapshot();

    // 阶段列取"这一整段录制里出现过的所有阶段名"，按首次出现的顺序（不是字母序：
    // 首现顺序通常就是帧循环里的执行顺序，读起来和阶段拆解对得上）
    const phaseNames: string[] = [];
    const seen = new Set<string>();
    for (const frame of frames) {
      for (const name of Object.keys(frame.phases)) {
        if (seen.has(name)) continue;
        seen.add(name);
        phaseNames.push(name);
      }
    }

    const header = [
      '帧序号',
      '时间戳(毫秒)',
      '帧耗时(毫秒)',
      '粒子数',
      '刚体数',
      ...phaseNames.map((name) => `${sanitizeCell(phaseLabel(name))}(毫秒)`),
    ];

    const lines: string[] = [];
    lines.push('# 上帝沙盘模拟器 帧录制导出（一行一帧，按时间先后）');
    lines.push('# 帧耗时与阶段耗时由调用方每帧喂进来，本模块不做任何测量');
    lines.push(
      `# 环形容量 ${this.capacityValue} 帧，累计写入 ${this.written} 帧，因覆盖已丢弃最旧 ${this.droppedFrames} 帧`,
    );
    lines.push('# 缺失的阶段耗时留空，不填 0（填 0 会被读成"这一阶段真的耗时 0 毫秒"）');
    lines.push(header.join(','));

    for (const frame of frames) {
      const cells = [
        frame.index.toFixed(CSV_DECIMALS),
        frame.t.toFixed(CSV_DECIMALS),
        frame.ms.toFixed(CSV_DECIMALS),
        frame.particles.toFixed(CSV_DECIMALS),
        frame.bodies.toFixed(CSV_DECIMALS),
      ];
      for (const name of phaseNames) {
        const ms = frame.phases[name];
        cells.push(ms === undefined ? '' : ms.toFixed(CSV_DECIMALS));
      }
      lines.push(cells.join(','));
    }

    return lines.join('\n');
  }

  // ── 内部 ────────────────────────────────────────────────────

  /** 第 k 个样本（0 = 窗口内最旧）对应的缓冲槽位 */
  private slotAt(k: number): number {
    const start = this.countValue < this.capacityValue ? 0 : this.head;
    return (start + k) % this.capacityValue;
  }

  /**
   * 按时间顺序拷一份窗口内的样本。`phases` 在**这里**深拷并过滤非有限值：
   * 把阶段耗时读成 `NaN`（上游算错了）时直接不写这个 key，
   * 而不是写个 0 —— 0 会变成"这一阶段耗时 0 毫秒"这个假事实流进摘要与导出。
   */
  private snapshot(): IndexedFrame[] {
    const out: IndexedFrame[] = new Array<IndexedFrame>(this.countValue);
    // 窗口里最旧那一帧的绝对序号：累计写入 - 窗口帧数（覆盖回绕之后依然连续）
    const base = this.written - this.countValue;
    for (let k = 0; k < this.countValue; k += 1) {
      const slot = this.slotAt(k);
      const phases: Record<string, number> = {};
      const raw = this.phaseRing[slot];
      if (raw) {
        for (const name of Object.keys(raw)) {
          const ms = raw[name]!;
          if (Number.isFinite(ms)) phases[name] = ms;
        }
      }
      out[k] = {
        index: base + k,
        t: this.tRing[slot]!,
        ms: this.msRing[slot]!,
        phases,
        particles: this.particleRing[slot]!,
        bodies: this.bodyRing[slot]!,
      };
    }
    return out;
  }

  /** 对一份已拷好的快照做统计（`summarize` 与 `exportJson` 共用，避免两处口径漂移） */
  private summarizeOf(frames: readonly IndexedFrame[]): RecorderSummary {
    const n = frames.length;
    const base = {
      capacity: this.capacityValue,
      totalRecorded: this.written,
      droppedFrames: this.droppedFrames,
    };

    if (n === 0) {
      return {
        ...base,
        frames: 0,
        durationMs: 0,
        avgFps: null,
        minFps: null,
        p95Ms: null,
        maxMs: 0,
        slowest: [],
      };
    }

    const sorted = new Array<number>(n);
    let maxMs = 0;
    for (let i = 0; i < n; i += 1) {
      const ms = frames[i]!.ms;
      sorted[i] = ms;
      if (ms > maxMs) maxMs = ms;
    }
    sorted.sort((a, b) => a - b);

    const first = frames[0]!;
    const last = frames[n - 1]!;
    const span = last.t - first.t;
    const durationMs = Number.isFinite(span) && span > 0 ? span : 0;

    // 帧率按**间隔数**算：(n - 1) 个间隔除以跨度。直接拿 n 除会把首帧也算成一个间隔，
    // 把帧率系统性地算高 1/n（120 帧时会高出近 1 FPS，看的人会以为优化生效了）。
    const avgFps = durationMs > 0 ? (n - 1) / (durationMs / 1000) : null;
    // "最低帧率"是由最慢帧折算的，不是"某段窗口内实测的最低帧率"——注释与 describe 都写明
    const minFps = maxMs > 0 ? 1000 / maxMs : null;

    const byMs = frames.slice().sort((a, b) => b.ms - a.ms || a.index - b.index);
    const slowest = byMs.slice(0, SLOWEST_LIMIT).map((frame) => ({
      index: frame.index,
      ms: frame.ms,
      worstPhase: worstPhaseLabel(frame.phases),
    }));

    return {
      ...base,
      frames: n,
      durationMs,
      avgFps,
      minFps,
      p95Ms: pickPercentile(sorted, 0.95),
      maxMs,
      slowest,
    };
  }
}

/**
 * 这一帧里耗时最高的阶段 → 中文标签（没有阶段数据时给中文占位）。
 *
 * 为什么用中文：这个字符串会出现在面板与导出报告里，`mesh` / `sim` 这种 key 对玩家等于没说。
 * 标签表集中在 `FrameProfiler.PHASE_LABELS`，这里只借用查询函数，不自己维护第二张表。
 */
function worstPhaseLabel(phases: Record<string, number>): string {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const name of Object.keys(phases)) {
    const ms = phases[name]!;
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = name;
    }
  }
  return best === null ? NO_PHASE_LABEL : phaseLabel(best);
}

/** `stop()` 只能用模块自己的时钟（契约里它不接参数），见文件头第 2 条 */
function currentNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
