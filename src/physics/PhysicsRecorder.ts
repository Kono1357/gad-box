/**
 * 物理动画录制与回放（补充 5 + 补充 7）：**最近 10 秒可以倒回去看，也能导出成文件。**
 *
 * 玩家在沙盘里搭了一分钟，塔一倒就没了，想看"是哪一块先动的"—— 没有录制就只能凭记忆。
 * 这个文件负责把最近一段时间的**位姿历史**留下来，供回放和导出分析。
 *
 * ## 三个设计要点（都是被手机逼出来的）
 *
 * ### 1. 扁平数值数组，不是对象数组
 *
 * 一帧里 800 个刚体，如果每个刚体存成 `{handle, position:{x,y,z}, rotation:[...]}`，
 * 那是每帧 800 个临时对象、600 帧就是 **48 万个对象**。手机上的 GC 压力足以造成
 * 肉眼可见的卡顿（而且是那种"平时没事，塔一倒就掉帧"的诡异卡顿）。
 * 所以每帧只有一个大 `number[]`，每个物体固定占 **8 个数**：
 *
 * ```
 * [handle, x, y, z, qx, qy, qz, qw,   handle, x, y, z, qx, qy, qz, qw, ...]
 * ```
 *
 * 600 帧就是 600 个数组，分配的**次数**降了 800 倍。代价是读的时候要按下标算偏移，
 * 这一点由 `frameAt()` / `trackOf()` 内部消化，调用方不用管。
 *
 * ### 2. `capture()` 里只做"塞进去"这一件事
 *
 * 不排序、不去重、不查重、不做单位换算：它每帧都会被调用，而它在手机上跑的是物理
 * 主循环。所以 `capture()` 里没有任何一处遍历整段录制的代码。
 *
 * ### 3. 容量用环形，满了丢最旧的一帧
 *
 * 不是"满了就清空重来"—— 那样录制会周期性丢掉全部内容，玩家永远回放不到刚才那一下。
 * 环形保证"最近 10 秒"这个语义始终成立。
 *
 * ## 关于 `estimatedBytes` 的诚实说明
 *
 * 它是 `frameCount × Σdata.length × 8` 字节，也就是**只算数值本身的字节数**。
 * JS 数组真实占用还有额外的开销：每个数组对象本身（几十字节）、以及 double 数组
 * 在部分引擎里可能没有走连续存储。所以面板上显示的是"数据粗估"，
 * 比真实 RSS 小一些 —— 这是刻意选的口径：它可复算、可对比，不做无根据的加价。
 *
 * ## 纯逻辑、零依赖
 *
 * 不 import Rapier / Three.js / DOM，不读全局时钟（帧号与时间都由调用方传进来，
 * 只有 `createdAtMs` 用了 `Date.now()`）。所以能在 Node 里直接单测。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 一帧里所有动态物体的位姿（紧凑数组，不是对象数组 —— 见上方内存说明） */
export interface RecordedFrame {
  /** 帧序号（相对录制开始的步数） */
  frame: number;
  /** 模拟时间（秒） */
  time: number;
  /** 扁平化：[handle, x, y, z, qx, qy, qz, qw, ...] 每物体 8 个数 */
  data: number[];
}

export interface RecordedClip {
  /** 格式版本，便于以后兼容 */
  version: 1;
  name: string;
  /** 录制时的固定步长（秒），回放要按它推进 */
  timestep: number;
  /** 采样到的物体 handle → 可读名字（导出时带上，读的人才知道是什么） */
  labels: Record<number, string>;
  frames: RecordedFrame[];
  /** 元信息 */
  createdAtMs: number;
  /** 每帧间隔的步数（1 = 每步都记） */
  strideSteps: number;
}

export interface RecorderOptions {
  /** 最多录多少帧（默认 600 = 10 秒 @60Hz） */
  capacity?: number;
  /** 每隔多少物理步记一帧（默认 1） */
  strideSteps?: number;
  /** 估算单个刚体占多少字节，用于内存提示（默认 8 个 float = 32 字节 + 句柄开销） */
  bytesPerBody?: number;
}

/** 每个物体固定 8 个数：句柄 + 位置 3 + 四元数 4（改成别的值就必须同时改版本号） */
export const NUMBERS_PER_BODY = 8;

/** 当前支持的录制格式版本 */
const CLIP_VERSION = 1;

/** JS 数值按 double 算，一个 8 字节 */
const BYTES_PER_NUMBER = 8;

/**
 * 默认容量 600 帧。
 * 600 = 10 秒 × 60Hz。10 秒是"回到出事之前"够用的长度（一次垮塌通常 2~4 秒），
 * 而 600 帧 × 800 体 × 8 数的粗估约 31 MB —— 手机上再往上加就要开始担心了。
 */
const DEFAULT_CAPACITY = 600;

/**
 * 默认每体字节数 40 = 8 个 float（32 字节）+ 8 字节的"句柄/数组开销"余量。
 * 只用于**满容量预计占用**这种前瞻提示，不参与 `estimatedBytes` 的如实口径。
 */
const DEFAULT_BYTES_PER_BODY = 40;

/** 默认步长 1/60：本项目物理固定步长就是 60Hz，回放按它推进才和录制时一致 */
const DEFAULT_TIMESTEP = 1 / 60;

/** 导入结果：要么整段接受，要么整段拒绝 —— 没有第三种 */
export type ImportResult = { ok: true; clip: RecordedClip } | { ok: false; reason: string };

export class PhysicsRecorder {
  private readonly capacityValue: number;
  private readonly bytesPerBody: number;
  /** 每帧间隔的步数；import 会采用文件里的值（导出即所见） */
  private stride: number;

  /** 环形缓冲：长度增到 capacity 之后不再增长 */
  private readonly frames: RecordedFrame[] = [];
  /** 下一帧的写入位置（满的时候它指向的就是最旧的那一帧） */
  private head = 0;
  /** 当前帧数（≤ capacity） */
  private count = 0;
  /** Σ data.length，用于 estimatedBytes；环形淘汰时同步减掉，所以不用每次遍历 */
  private numbers = 0;

  private recording = false;
  private clipName = '';
  private timestepValue = DEFAULT_TIMESTEP;
  private createdAt = 0;
  /** 开始录制时的物理步号（stride 以它为基准取模，而不是绝对步号） */
  private startStep: number | null = null;
  private labels = new Map<number, string>();
  /** 单帧最多见过多少个物体（用于"满容量预计占用"） */
  private maxBodies = 0;

  constructor(options: RecorderOptions = {}) {
    const requested = options.capacity ?? DEFAULT_CAPACITY;
    // 容量至少 1 帧：0 会让"环形"退化成"什么都不存"，那种情况应该由调用方不要 new 本类
    this.capacityValue = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : DEFAULT_CAPACITY;
    this.stride = safeStride(options.strideSteps ?? 1);
    const perBody = options.bytesPerBody ?? DEFAULT_BYTES_PER_BODY;
    this.bytesPerBody = Number.isFinite(perBody) && perBody > 0 ? perBody : DEFAULT_BYTES_PER_BODY;
  }

  get capacity(): number {
    return this.capacityValue;
  }

  get frameCount(): number {
    return this.count;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  /**
   * 已用内存粗估（字节）= Σ每帧数值个数 × 8。
   *
   * 只算数值本身，不含数组对象开销（见文件头说明）。面板上要写"粗估"两个字，
   * 不能当成真实堆占用给用户看。
   */
  get estimatedBytes(): number {
    return this.numbers * BYTES_PER_NUMBER;
  }

  /** 录制名（面板显示用） */
  get name(): string {
    return this.clipName;
  }

  /**
   * 开始一段新录制。
   *
   * **会丢掉上一次的内容**（包括还没导出的）—— 录制是"最近 10 秒"，两段录制没有
   * 合理合并方式（时间轴对不上），所以不做追加。
   */
  start(name: string, timestep: number): void {
    this.frames.length = 0;
    this.head = 0;
    this.count = 0;
    this.numbers = 0;
    this.maxBodies = 0;
    this.labels.clear();
    this.startStep = null;
    this.clipName = name.trim() === '' ? '未命名录制' : name.trim();
    this.timestepValue = Number.isFinite(timestep) && timestep > 0 ? timestep : DEFAULT_TIMESTEP;
    this.createdAt = Date.now();
    this.recording = true;
  }

  /**
   * 停止录制。**不清空已录内容** —— 玩家按下"停止"接着往往就是要回放或导出，
   * 停了就丢数据等于让人白录。
   */
  stop(): void {
    this.recording = false;
  }

  /**
   * 每帧喂入；不在录制状态时是空操作。
   *
   * 这里的每一步都是常数级：算 offset、push 8 个数、写环形槽位、记账。
   * 不做任何"遍历已录内容"的活（那是回放和导出才该付的成本）。
   *
   * 注意：录下来的就是当时发生的事，**不做校验也不做修正** —— 哪怕当时是 NaN，
   * 那也正是要回放给玩家看的东西。代价是这种录制导出后会被 `import()` 以
   * "数值必须有限"为由拒绝，这是两个环节各自的正确口径，不是矛盾。
   *
   * @param frame 相对录制开始的帧序号（调用方给，本类不猜）
   * @param time 模拟时间（秒）
   * @param bodies 本帧的动态刚体位姿
   * @param stepCount 物理步计数（用于 stride 抽帧）
   */
  capture(
    frame: number,
    time: number,
    bodies: readonly { handle: number; position: Vec3; rotation: [number, number, number, number] }[],
    stepCount: number,
  ): void {
    if (!this.recording) return;

    if (this.startStep === null) this.startStep = Number.isFinite(stepCount) ? stepCount : 0;
    if (this.stride > 1 && Number.isFinite(stepCount)) {
      const offset = stepCount - this.startStep;
      if (offset % this.stride !== 0) return;
    }

    const data: number[] = [];
    for (const body of bodies) {
      const handle = body.handle;
      // 没有句柄的采样在回放时无法定位到任何物体，收进来只会变成一段谁也认不出的轨迹
      if (!Number.isFinite(handle)) continue;
      const p = body.position;
      const q = body.rotation;
      data.push(handle, p.x, p.y, p.z, q[0], q[1], q[2], q[3]);
      // 标签只补不覆盖：Engine 若已经给了可读名字（setLabel），别被这行冲掉
      if (!this.labels.has(handle)) this.labels.set(handle, `刚体 #${handle}`);
    }

    const entry: RecordedFrame = { frame, time, data };
    if (this.count < this.capacityValue) {
      this.frames.push(entry);
      this.count += 1;
      this.head = this.count % this.capacityValue;
    } else {
      // 满了：覆盖最旧的那一帧（环形），并把它占的数值个数从账上减掉
      const evicted = this.frames[this.head];
      this.numbers -= evicted.data.length;
      this.frames[this.head] = entry;
      this.head = (this.head + 1) % this.capacityValue;
    }
    this.numbers += data.length;

    if (bodies.length > this.maxBodies) this.maxBodies = bodies.length;
  }

  /** 给某个物体一个可读名字（导出后读文件的人才知道 #12 是什么） */
  setLabel(handle: number, label: string): void {
    if (!Number.isFinite(handle)) return;
    const text = label.trim();
    this.labels.set(handle, text === '' ? `刚体 #${handle}` : text);
  }

  /** 取某一帧（越界返回 null，绝不返回 undefined 让调用方去猜） */
  frameAt(index: number): RecordedFrame | null {
    if (!Number.isFinite(index)) return null;
    const i = Math.floor(index);
    if (i < 0 || i >= this.count) return null;
    return this.frameAtRaw(i);
  }

  /**
   * 取某个物体在整段录制里的运动轨迹（回放画线用）。
   *
   * 这是 O(帧数 × 每帧物体数) 的扫描，只有面板/回放会调，所以不建索引 ——
   * 建索引意味着 capture() 里要多干活，那是绝对不能碰的主循环成本。
   * 返回的数组长度 = **这个物体出现过的帧数**（中途被删掉的话就比总帧数短）。
   */
  trackOf(handle: number): Vec3[] {
    const track: Vec3[] = [];
    if (!Number.isFinite(handle)) return track;
    for (let i = 0; i < this.count; i++) {
      const frame = this.frameAtRaw(i);
      const data = frame.data;
      for (let k = 0; k + NUMBERS_PER_BODY <= data.length; k += NUMBERS_PER_BODY) {
        if (data[k] === handle) {
          track.push({ x: data[k + 1], y: data[k + 2], z: data[k + 3] });
          break; // 同一帧里同一个句柄只会出现一次
        }
      }
    }
    return track;
  }

  /** 全部清空（换地图 / 关面板） */
  clear(): void {
    this.frames.length = 0;
    this.head = 0;
    this.count = 0;
    this.numbers = 0;
    this.maxBodies = 0;
    this.labels.clear();
    this.startStep = null;
    this.recording = false;
    this.clipName = '';
    this.createdAt = 0;
  }

  /**
   * 导出成可直接 `JSON.stringify` 的对象。
   *
   * 返回的是**深拷贝**：导出的对象是给序列化器 / 外部代码用的，它被改成什么样都不该
   * 反过来污染正在录的数据。拷贝的成本只在这一个动作上付（玩家点"导出"时），不影响帧循环。
   */
  export(): RecordedClip {
    const frames: RecordedFrame[] = [];
    for (let i = 0; i < this.count; i++) {
      const frame = this.frameAtRaw(i);
      frames.push({ frame: frame.frame, time: frame.time, data: [...frame.data] });
    }
    return {
      version: CLIP_VERSION,
      name: this.clipName,
      timestep: this.timestepValue,
      labels: this.labelsToObject(),
      frames,
      createdAtMs: this.createdAt,
      strideSteps: this.stride,
    };
  }

  /**
   * 导入并校验。
   *
   * 校验口径（全部通过才接受，**绝不部分接受**，**绝不抛出**）：
   * - `version` 必须严格等于 1；
   * - `frames` 必须是数组，帧数不能超过本机容量（超过了也没法完整装进环形缓冲，
   *   截断就是部分接受，所以直接拒绝并说清楚）；
   * - 每帧必须是对象，`frame` / `time` 必须是有限数字；
   * - 每帧 `data` 必须是数组、长度是 8 的整数倍、**每个数都必须是有限数字**；
   * - `timestep` 必须是正的有限数；`strideSteps` 若存在必须是正整数；
   * - `labels` 若存在必须是"数字键 → 字符串值"的对象。
   *
   * 通过校验后会把这段录制**载入本实例**（之后 `frameAt()` / `export()` 都能用），
   * 同时把整段 clip 返回给调用方。任何一步不过都返回中文原因，且本实例的状态
   * 一个字节都不动。
   */
  import(data: unknown): ImportResult {
    try {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return fail('导入的内容不是一段录制对象（期望一个 JSON 对象）');
      }
      const raw = data as Record<string, unknown>;

      if (raw.version !== CLIP_VERSION) {
        return fail(`录制格式版本是 ${String(raw.version)}，本版本只认 ${CLIP_VERSION}，无法读取`);
      }
      if (!Array.isArray(raw.frames)) return fail('录制里的 frames 不是数组');

      const rawFrames = raw.frames;
      if (rawFrames.length > this.capacityValue) {
        return fail(
          `录制共 ${rawFrames.length} 帧，超过本机容量 ${this.capacityValue} 帧，无法完整载入（不做截断）`,
        );
      }

      // ---- 先全部校验并拷贝，任何一项不过就整体拒绝 ----
      const frames: RecordedFrame[] = [];
      for (let i = 0; i < rawFrames.length; i++) {
        const rawFrame: unknown = rawFrames[i];
        if (typeof rawFrame !== 'object' || rawFrame === null || Array.isArray(rawFrame)) {
          return fail(`第 ${i} 帧不是对象`);
        }
        const f = rawFrame as Record<string, unknown>;
        if (typeof f.frame !== 'number' || !Number.isFinite(f.frame)) {
          return fail(`第 ${i} 帧的 frame 不是有限数字（回放要用它对齐时间轴）`);
        }
        if (typeof f.time !== 'number' || !Number.isFinite(f.time)) {
          return fail(`第 ${i} 帧的 time 不是有限数字`);
        }
        if (!Array.isArray(f.data)) return fail(`第 ${i} 帧的 data 不是数组`);
        const rawNumbers = f.data;
        if (rawNumbers.length % NUMBERS_PER_BODY !== 0) {
          return fail(
            `第 ${i} 帧的 data 有 ${rawNumbers.length} 个数，不是 ${NUMBERS_PER_BODY} 的整数倍` +
              `（每个物体必须是「句柄 + 位置 3 + 四元数 4」）`,
          );
        }
        const numbers: number[] = [];
        for (let k = 0; k < rawNumbers.length; k++) {
          const value: unknown = rawNumbers[k];
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            return fail(`第 ${i} 帧 data[${k}] 不是有限数字（NaN / Infinity / 非数字会让回放算出乱飞的位置）`);
          }
          numbers.push(value);
        }
        frames.push({ frame: f.frame, time: f.time, data: numbers });
      }

      const timestep = raw.timestep;
      if (typeof timestep !== 'number' || !Number.isFinite(timestep) || timestep <= 0) {
        return fail('录制的 timestep（固定步长）不是正的有限数字，回放无法按它推进');
      }

      let stride = 1;
      if (raw.strideSteps !== undefined) {
        const value = raw.strideSteps;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
          return fail('录制的 strideSteps 不是正整数');
        }
        stride = value;
      }

      let name = '导入的录制';
      if (raw.name !== undefined) {
        if (typeof raw.name !== 'string') return fail('录制的 name 不是字符串');
        name = raw.name.trim() === '' ? '导入的录制' : raw.name;
      }

      let createdAtMs = 0; // 0 = 未知（老文件可能没有），面板按 0 处理即可，不编一个时间出来
      if (raw.createdAtMs !== undefined) {
        const value = raw.createdAtMs;
        if (typeof value !== 'number' || !Number.isFinite(value)) return fail('录制的 createdAtMs 不是有限数字');
        createdAtMs = value;
      }

      const labels: Record<number, string> = {};
      if (raw.labels !== undefined) {
        const value = raw.labels;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return fail('录制的 labels 不是「数字键 → 名字」的对象');
        }
        for (const [key, label] of Object.entries(value as Record<string, unknown>)) {
          const parsed = Number(key);
          if (!Number.isFinite(parsed)) return fail(`录制的 labels 里键「${key}」不是数字`);
          if (typeof label !== 'string') return fail(`录制的 labels 里「${key}」对应的名字不是字符串`);
          labels[parsed] = label;
        }
      }

      const clip: RecordedClip = {
        version: CLIP_VERSION,
        name,
        timestep,
        labels,
        frames,
        createdAtMs,
        strideSteps: stride,
      };
      this.loadClip(clip);
      return { ok: true, clip };
    } catch (error) {
      // 校验逻辑本身不该抛，但导出的数据是外部来的：这段 try 是最后一道闸
      return fail(`读取录制时出现意外错误：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 面板用：一行中文摘要，含内存占用 */
  describe(): string {
    if (this.count === 0) {
      // 变量名刻意不叫 window：那会遮住浏览器全局对象，读代码的人会误会
      const spanSeconds = this.capacityValue * this.timestepValue;
      return `尚未录制（容量 ${this.capacityValue} 帧 ≈ ${spanSeconds.toFixed(1)} 秒）`;
    }
    const head = this.recording ? '录制中' : '已停止';
    const seconds = this.count * this.timestepValue;
    const usedMB = this.estimatedBytes / 1048576;
    const projection =
      this.maxBodies > 0
        ? `｜满容量预计 ${((this.capacityValue * this.maxBodies * this.bytesPerBody) / 1048576).toFixed(1)} MB` +
          `（按每体 ${this.bytesPerBody} 字节 × 单帧最多 ${this.maxBodies} 个物体）`
        : '';
    return (
      `${head}「${this.clipName}」：${this.count}/${this.capacityValue} 帧 ≈ ${seconds.toFixed(1)} 秒｜` +
      `数据 ${usedMB.toFixed(2)} MB（数组粗估）${projection}`
    );
  }

  // ---------------------------------------------------------------- 内部

  /** 环形下标 → 时间正序下标（i = 0 是最旧的一帧） */
  private frameAtRaw(index: number): RecordedFrame {
    const capacity = this.capacityValue;
    return this.frames[(this.head - this.count + index + capacity * 2) % capacity];
  }

  private labelsToObject(): Record<number, string> {
    const out: Record<number, string> = {};
    for (const [handle, label] of this.labels) out[handle] = label;
    return out;
  }

  /** 把一段已校验的录制装进环形缓冲（不校验，调用方保证已经校验过） */
  private loadClip(clip: RecordedClip): void {
    this.frames.length = 0;
    let numbers = 0;
    let maxBodies = 0;
    for (const frame of clip.frames) {
      const copy: number[] = [...frame.data];
      this.frames.push({ frame: frame.frame, time: frame.time, data: copy });
      numbers += copy.length;
      const bodies = copy.length / NUMBERS_PER_BODY;
      if (bodies > maxBodies) maxBodies = bodies;
    }
    this.count = this.frames.length;
    // 未满时 head 必须等于 count（下一个空槽）；正好满时 head 归 0（下一帧覆盖最旧的）
    this.head = this.count % this.capacityValue;
    this.numbers = numbers;
    this.maxBodies = maxBodies;
    this.labels = new Map<number, string>();
    for (const [key, label] of Object.entries(clip.labels)) {
      const handle = Number(key);
      if (Number.isFinite(handle)) this.labels.set(handle, label);
    }
    this.clipName = clip.name;
    this.timestepValue = clip.timestep;
    this.createdAt = clip.createdAtMs;
    this.stride = safeStride(clip.strideSteps);
    this.startStep = null;
    this.recording = false;
  }
}

// ---------------------------------------------------------------- 小工具（纯函数）

function fail(reason: string): ImportResult {
  return { ok: false, reason };
}

function safeStride(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.max(1, Math.floor(value));
}
