/**
 * 错误采集器（M5 第 1 批：错误处理 + 安全模式 + 重置）。
 *
 * ────────────────────────────────────────────────────────────
 * 它要解决的是"玩家说崩了，而我们什么都看不到"
 * ────────────────────────────────────────────────────────────
 * 这个项目部署在 GitHub Pages 上，没有服务端、没有日志上报。
 * 玩家能提供的只有一句"刚才卡了一下"或"黑屏了"，开发者手上什么都没有。
 * 所以这里做的第一件事不是"修复错误"，而是**把现场留下来**：
 * 消息、栈、发生位置（中文 context）、发生时间、发生次数，
 * 以及一个能被 `JSON.parse` 回去的报告（面板上的「导出错误报告」就调它）。
 *
 * ────────────────────────────────────────────────────────────
 * 四条刻意的取舍（都写在下面每个方法的注释里，这里只列结论）
 * ────────────────────────────────────────────────────────────
 * 1. **环形缓冲、绝不 `shift()`**：`Array.shift()` 在长数组上要搬动全部元素，
 *    而错误最密集的时候（每帧都抛）恰恰是最不该再花 CPU 的时候。写满就覆盖最旧的一条。
 * 2. **同一 message + context 只留一条，重复累加 `count`**：
 *    一个每帧抛出的错误如果每次都存一条，50 条的缓冲会在 1 秒内被同一条错误刷满，
 *    真正"第一次出现的那个原始错误"反而被挤出缓冲 —— 那是这个模块最该记住的东西。
 * 3. **拿不到就说拿不到**：取不到栈就是 `null`（不编造、不写空字符串冒充）；
 *    太长就截断并在结尾写明截掉了多少字符（用户看到的是"被截断的栈"，不是"完整的栈"）。
 * 4. **采集器自己绝不能抛异常**：它是在"已经出事"的路径上跑的。
 *    所以 `install()` 在 Node / 没有 window 时安静降级，回调里的异常一律吃掉。
 *
 * 类型层面的一个约束：`CapturedError.kind` 只有 `'error' | 'unhandledrejection' | 'manual'`
 * 三个取值（接口约定的形状）。`webglcontextlost` 并不是 JS 异常，它是 DOM 事件，
 * 没有第四个取值可放，所以它归到 `'error'`，靠 `context`（`'WebGL 上下文丢失'`）区分 ——
 * 面板与报告都按 context 分类，不看 kind。
 */

/** 单条栈信息保留的最大字符数 */
export const STACK_LIMIT_CHARS = 2000;
/** 环形缓冲默认保留多少条**不同**的错误 */
export const DEFAULT_MAX_RECORDS = 50;
/** `summarize()` 里一条消息最多显示多少字符（面板只有一行，长了会把面板撑开） */
const SUMMARY_MESSAGE_CHARS = 60;
/** `context` 没传或传空串时的兜底文案 */
export const CONTEXT_UNSPECIFIED = '未标注位置';
/** window 的 `error` 事件 */
export const CONTEXT_WINDOW_ERROR = '窗口错误事件';
/** window 的 `unhandledrejection` 事件 */
export const CONTEXT_UNHANDLED_REJECTION = '未处理的 Promise 拒绝';
/** canvas 的 `webglcontextlost` 事件 */
export const CONTEXT_WEBGL_LOST = 'WebGL 上下文丢失';
/** 资源（script / img / link）加载失败：也是 error 事件，但没有消息，单独一个 context 才看得出来 */
export const CONTEXT_RESOURCE_ERROR = '资源加载失败';

export type CapturedErrorKind = 'error' | 'unhandledrejection' | 'manual';

/** 一条错误记录的对外形状（面板与导出报告都读它） */
export interface CapturedError {
  /** 自增序号，从 1 开始，**不重复使用**（面板上用来对项目） */
  id: number;
  /**
   * 捕获时刻（`Date.now()` 的毫秒数）。
   *
   * 用真实时间而不是 `performance.now()`：报告会被贴进问题反馈里给别人看，
   * "什么时候出的问题"必须是能对得上日历的时间戳；`performance.now()` 是"页面打开后多久"，
   * 只有本机这一份上下文时才读得懂。
   * 名字保持 `atMs`（而不是 `at`）是为了让人一眼看出单位是毫秒。
   */
  atMs: number;
  kind: CapturedErrorKind;
  /**
   * 原始错误消息，**不翻译、不改写**。
   * 翻译过的消息在搜索引擎与会话里都搜不到，等于把唯一的线索抹掉了。
   */
  message: string;
  /** 栈信息；拿不到就是 `null`。超过 `STACK_LIMIT_CHARS` 会截断，截断处会写明原始长度 */
  stack: string | null;
  /** 出错位置的中文描述（面板显示）。它同时是去重键的一半 —— 同一条消息在两处抛出算两条 */
  context: string;
  /** 同一 message + context 出现的次数（去重后累加；第一条从 1 开始） */
  count: number;
}

export interface ErrorHandlerOptions {
  /** 最多保留多少条**不同**的错误，默认 `DEFAULT_MAX_RECORDS`。非法值（0 / 负数 / NaN / 小数）一律回到默认 */
  maxRecords?: number;
}

/**
 * 能被挂监听的"事件目标"。
 *
 * 之所以不直接用 `Window` 类型：断言（`scripts/checks/errors.check.ts`）要在 Node 里
 * 注入一个假目标来验证"捕获 / 去重 / 卸载"这条链路，用最小结构类型就能注入，
 * 不需要真的起一个浏览器。两个方法都做成可选，是为了让 `{}`（老浏览器里被阉割的对象）
 * 也能传进来而不炸 —— 见到不可用的目标就安静返回，见 `install()`。
 */
export interface ErrorScope {
  addEventListener?(type: string, listener: (event: Event) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener?(type: string, listener: (event: Event) => void, options?: boolean | AddEventListenerOptions): void;
}

/**
 * 错误采集器。
 *
 * 用起来只有三步：`install()` → 引擎内部 try/catch 里调 `capture('读档失败', error)` → `uninstall()`。
 * 它不碰 DOM、不碰引擎，只记数据，所以可以在 Node 里把整条链路断言一遍。
 */
export class ErrorHandler {
  /** 缓冲容量（条数）。存成字段而不是每次读 `buffer.length`：写满后 `buffer.length` 仍是容量，但语义上"容量"是个固定契约 */
  private readonly capacity: number;
  /**
   * 环形缓冲：`head` 指向**下一个要写入的位置**，`size` 是当前有效条数。
   * 写满之后新记录覆盖 `head` 处最旧的那条（`dropped` 计数），**不调用 `shift()`**。
   */
  private readonly buffer: (CapturedError | null)[];
  private head = 0;
  private size = 0;
  /** 因为缓冲写满而被覆盖掉的记录数（导出报告里如实写出，不假装"全都记下来了"） */
  private dropped = 0;
  private nextId = 1;
  /** 累计发生次数（含重复），也就是 `total` */
  private occurrences = 0;
  private readonly callbacks: ((error: CapturedError) => void)[] = [];
  /** 已经挂上的监听。卸载时必须用**同一个** handler 与同一个 capture 值才摘得掉，所以这里记全 */
  private readonly listeners: {
    target: ErrorScope;
    type: string;
    handler: (event: Event) => void;
    options: AddEventListenerOptions;
  }[] = [];

  constructor(options?: ErrorHandlerOptions) {
    this.capacity = normalizeCapacity(options?.maxRecords);
    // 预填 null：环形缓冲不能留空洞（`undefined` 与"没有记录"在读取时要区分得开）
    this.buffer = new Array<CapturedError | null>(this.capacity).fill(null);
  }

  // ---------------------------------------------------------------- 安装

  /**
   * 装 window.onerror / unhandledrejection（浏览器里）；Node 里安全降级。
   *
   * 关于 `scope`：它默认是 `window`。传别的目标（通常是 **canvas**）时行为是"两边都挂"：
   * - `error` / `unhandledrejection` **只在 window 上派发**，所以无论 scope 是什么都会挂一份到 window
   *   —— 否则会出现最糟的情况：`install()` 看起来成功了，但所有 JS 异常一条都收不到；
   * - `webglcontextlost` 挂在传入的 scope（canvas）上，**不**同时挂 window：
   *   两处都挂会让同一次上下文丢失变成两条记录、`count` 翻倍，而"到底丢了几次上下文"
   *   正是这个数字要如实回答的问题。
   *
   * 重复调用是安全的：同一个目标只会挂一次（重复挂会让同一条错误被记两条、`count` 翻倍）。
   */
  install(scope?: ErrorScope): void {
    const win = browserWindow();
    const target = scope ?? win;
    if (!target || typeof target.addEventListener !== 'function') {
      // Node（就是断言运行的环境）：没有事件目标可挂。这里**必须安静返回**而不是抛异常，
      // 因为采集器是"出事时用的东西"，它自己不能在启动阶段把应用搞崩。
      return;
    }
    if (this.listeners.some((entry) => entry.target === target)) return;

    this.attach(target, ['error', 'unhandledrejection', 'webglcontextlost']);
    if (win && win !== target) this.attach(win, ['error', 'unhandledrejection']);
  }

  /**
   * 摘掉 `install()` 挂上的全部监听。
   *
   * 重复调用安全。**不清除 `onError` 回调**：回调是 UI 的注册，不是监听的实现细节 ——
   * 二者生命周期不一样（引擎 dispose 时要摘监听，但面板可能还在）。
   */
  uninstall(): void {
    for (const { target, type, handler, options } of this.listeners) {
      target.removeEventListener?.(type, handler, options);
    }
    this.listeners.length = 0;
  }

  private attach(target: ErrorScope, types: readonly string[]): void {
    const add = target.addEventListener;
    if (typeof add !== 'function') return;
    for (const type of types) {
      const handler = this.handlerFor(type);
      /**
       * `capture: true` 有两个理由，少一个都会出问题：
       * ① 资源加载失败（script / img / link）的 error 事件**不冒泡**，不走捕获阶段就收不到，
       *    而 GitHub Pages 上一个 chunk 没加载上，正是"页面看起来卡死了"的常见原因；
       * ② 卸载时必须用**同样的 capture 值**才摘得掉（`options` 一起存进 `listeners` 就是为了这个），
       *    否则表现为"引擎已经 dispose，旧引擎还在收错误"，还会把已释放的 UI 写崩。
       */
      const options: AddEventListenerOptions = { capture: true };
      // 用 call 把 this 绑回目标本身：直接把方法取出来当函数调用会触发 Illegal invocation
      add.call(target, type, handler, options);
      this.listeners.push({ target, type, handler, options });
    }
  }

  /** 事件类型 → 处理器。三个处理器都是字段级箭头函数，反复 attach 拿到的都是同一个引用，卸载才对得上 */
  private handlerFor(type: string): (event: Event) => void {
    if (type === 'unhandledrejection') return this.handleUnhandledRejection;
    if (type === 'webglcontextlost') return this.handleWebglContextLost;
    return this.handleErrorEvent;
  }

  // ---------------------------------------------------------------- 采集

  /** 手动上报（引擎内部的 try/catch 用它）。`kind` 固定是 `'manual'`，用来和浏览器自动捕获的区分开 */
  capture(context: string, error: unknown): CapturedError {
    const detail = describeUnknown(error);
    return this.record('manual', normalizeContext(context), detail.message, detail.stack);
  }

  /**
   * 所有入口的公共落库逻辑：先查重（message + context 相同就是同一条），
   * 命中就 `count += 1`，没命中才占用一个环形槽位。
   *
   * 命中时**位置不动**（不会跳到最前面）：面板上它还在原地把 count 往上加，
   * 比"同一条错误在列表里来回跳"好读 —— 列表的顺序表达的是"第一次出现的先后"。
   */
  private record(
    kind: CapturedErrorKind,
    context: string,
    message: string,
    stack: string | null,
  ): CapturedError {
    const existing = this.findExisting(message, context);
    if (existing) {
      existing.count += 1;
      this.occurrences += 1;
      // 重复**不**通知回调：见 onError() 的注释（否则每帧抛出的错误会把提示刷爆）
      return copyOf(existing);
    }

    const record: CapturedError = {
      id: this.nextId,
      atMs: Date.now(),
      kind,
      message,
      stack,
      context,
      count: 1,
    };
    this.nextId += 1;
    this.occurrences += 1;

    if (this.buffer[this.head] !== null) this.dropped += 1;
    this.buffer[this.head] = record;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;

    this.notify(copyOf(record));
    return copyOf(record);
  }

  /**
   * 查重。
   *
   * 逐条比较两个字段，而不是拼一个 `${message}|${context}` 的字符串键：
   * 消息里本来就可能有 `|`、`\n`、`\u0000`（错误消息是外部数据），
   * 拼字符串会造出"两条不同的错误拼成同一个键"的碰撞，那比慢一点糟得多。
   * 缓冲最多 50 条，线性扫一遍的成本可以忽略。
   */
  private findExisting(message: string, context: string): CapturedError | null {
    for (let i = 0; i < this.size; i += 1) {
      const record = this.buffer[this.slotFromNewest(i)];
      if (record && record.message === message && record.context === context) return record;
    }
    return null;
  }

  /** 第 i 新的记录在缓冲里的槽位（i = 0 是最新的那条） */
  private slotFromNewest(i: number): number {
    // + capacity 是把负数（head 为 0 且 i > 0 时会出现）搬回正数区，JS 的 % 对负数会给负结果
    return (this.head - 1 - i + this.capacity * 2) % this.capacity;
  }

  // ---------------------------------------------------------------- 读取

  /**
   * 最近的记录，**新的在前**。
   *
   * 返回的是**副本**：调用方（面板 / 导出）拿到的是普通对象，改了也影响不到环形缓冲里的内部记录。
   * 否则一个 UI bug（比如把 count 归零）会让"发生了几次"这个数字永久错掉，而且查不出来。
   */
  get records(): readonly CapturedError[] {
    const out: CapturedError[] = [];
    for (let i = 0; i < this.size; i += 1) {
      const record = this.buffer[this.slotFromNewest(i)];
      if (record) out.push(copyOf(record));
    }
    return out;
  }

  /**
   * 累计发生次数（**含重复**，即所有记录的 `count` 之和）。
   *
   * 不取"记录条数"：面板上"共 3 类 / 累计 7 次"里的 7 才是现场有多糟的真实度量，
   * 而"3"只是去重后的种类数 —— 需要种类数的地方直接读 `records.length`。
   */
  get total(): number {
    return this.occurrences;
  }

  /** 最新一条（内部用，避免为了取一条而构造整个数组） */
  private newest(): CapturedError | null {
    if (this.size === 0) return null;
    return this.buffer[this.slotFromNewest(0)] ?? null;
  }

  /** 一行中文摘要（面板显示） */
  summarize(): string {
    const latest = this.newest();
    if (!latest) return '还没有捕获到错误（这是好消息）。';
    return (
      `共 ${this.size} 类错误 / 累计 ${this.occurrences} 次；` +
      `最近一次：${latest.context} —— ${shorten(latest.message, SUMMARY_MESSAGE_CHARS)}`
    );
  }

  /**
   * 导出 JSON 字符串（「导出错误报告」按钮与问题反馈都读它）。
   *
   * 报告里除了记录本身，还**必须**带上口径说明（`limits` / `notes`）：
   * 一份被截断过栈、被覆盖过旧记录的报告，如果不说这两件事，
   * 读的人会以为"这就是全部错误" —— 那比没有报告更糟。
   */
  exportReport(): string {
    const records = this.records;
    const notes: string[] = [
      `同一条错误（message + context 完全相同）只保留一条记录，重复次数记在该条的 count 字段里。`,
      `栈信息超过 ${STACK_LIMIT_CHARS} 字符会被截断，截断处的文字里写明了原始长度。`,
      `缓冲最多保留 ${this.capacity} 类错误，写满后覆盖最旧的一类；本报告生成时已被覆盖 ${this.dropped} 条。`,
    ];
    const environment = readEnvironment();
    if (environment.userAgent === null) notes.push('userAgent 为 null：当前环境没有 navigator（不是浏览器）。');
    if (environment.href === null) notes.push('location 为 null：当前环境没有 location（不是浏览器页面）。');

    const payload = {
      format: REPORT_FORMAT,
      formatVersion: REPORT_FORMAT_VERSION,
      exportedAt: Date.now(),
      exportedAtIso: new Date().toISOString(),
      /** 累计发生次数（含重复） */
      total: this.occurrences,
      /** 去重后的种类数 */
      distinct: this.size,
      /** 被环形缓冲覆盖掉的记录数 */
      dropped: this.dropped,
      environment,
      limits: { maxRecords: this.capacity, stackLimitChars: STACK_LIMIT_CHARS },
      notes,
      records,
    };
    return JSON.stringify(payload, null, 2);
  }

  /**
   * 注册"新错误"回调（UI 弹提示用）。
   *
   * 两条刻意的规则：
   * - **注册之前的旧错误不会补触发** —— 否则打开面板的瞬间会把历史错误全弹一遍；
   * - **同一条错误重复发生时不触发**（只有第一次出现时触发）—— 一个每帧抛出的错误
   *   每帧弹一次提示，会把 UI 自己卡死，而"又发生了多少次"看记录里的 `count` 就够了。
   *
   * 回调里的异常一律吃掉：UI 的 bug 不该断掉错误采集 —— 否则第一个 UI 异常之后，
   * 后面所有真实错误都收不到了，而现场看起来只是"没报错"。
   */
  onError(callback: (error: CapturedError) => void): void {
    if (this.callbacks.includes(callback)) return; // 同一个回调注册两次会弹两次提示
    this.callbacks.push(callback);
  }

  private notify(record: CapturedError): void {
    for (const callback of this.callbacks) {
      try {
        callback(record);
      } catch {
        // 见 onError 的注释：静默吃掉
      }
    }
  }

  // ---------------------------------------------------------------- 事件处理器

  /**
   * window 的 `error` 事件。
   *
   * 两种形态都要认（浏览器在不同情况下给的东西不一样）：
   * - 有 `error` 对象：JS 异常走这条，能拿到栈；
   * - 只有 `message` 字符串：跨域脚本的异常被浏览器脱敏后就是这样，**拿不到栈就是拿不到**，
   *   这时只能把事件里的 `filename:line:col` 当作位置信息（那是事件给的真实数据，不是编的）；
   * - 两者都没有：资源加载失败（script / img 没加载上）就是这种形态，单独归到
   *   `CONTEXT_RESOURCE_ERROR`，否则面板上会是一堆"没有消息的错误"，看不出是脚本没加载上。
   */
  private handleErrorEvent = (event: Event): void => {
    const raw = event as unknown as {
      error?: unknown;
      message?: unknown;
      filename?: unknown;
      lineno?: unknown;
      colno?: unknown;
      target?: unknown;
    };

    if (raw.error !== undefined && raw.error !== null) {
      const detail = describeUnknown(raw.error);
      this.record('error', CONTEXT_WINDOW_ERROR, detail.message, detail.stack);
      return;
    }

    const target = raw.target;
    const isResource = target !== undefined && target !== null && target !== browserWindow();
    if (isResource) {
      this.record(
        'error',
        CONTEXT_RESOURCE_ERROR,
        `资源加载失败：${describeEventTarget(target)}（浏览器没有给出错误消息）`,
        null,
      );
      return;
    }

    const message =
      typeof raw.message === 'string' && raw.message.length > 0
        ? raw.message
        : 'error 事件里既没有 error 也没有 message（浏览器没有提供任何详情）';
    this.record('error', CONTEXT_WINDOW_ERROR, message, positionFromEvent(raw));
  };

  /** window 的 `unhandledrejection`：`reason` 可以是任何东西，所以统一走 describeUnknown */
  private handleUnhandledRejection = (event: Event): void => {
    const raw = event as unknown as { reason?: unknown };
    const detail = describeUnknown(raw.reason);
    this.record('unhandledrejection', CONTEXT_UNHANDLED_REJECTION, detail.message, detail.stack);
  };

  /**
   * canvas 的 `webglcontextlost`。
   *
   * 它必须在这里捕获：上下文丢了之后 Three.js 画不出任何东西，画面是黑的，
   * 玩家看到的就是"崩了"，而控制台里一条错误都没有 —— 没有这条记录，这种问题无从查起。
   * `stack` 给 `null`：这不是异常，没有栈；写空字符串会让人以为"栈取到了但是空的"。
   */
  private handleWebglContextLost = (event: Event): void => {
    const raw = event as unknown as { statusMessage?: unknown };
    const status =
      typeof raw.statusMessage === 'string' && raw.statusMessage.length > 0
        ? `：${raw.statusMessage}`
        : '（浏览器没有给出 statusMessage）';
    this.record('error', CONTEXT_WEBGL_LOST, `WebGL 上下文丢失${status}`, null);
  };
}

/** 导出报告的标识与版本（读的人据此判断字段含义有没有变） */
export const REPORT_FORMAT = 'god-sandbox/error-report';
export const REPORT_FORMAT_VERSION = 1;

// ---------------------------------------------------------------- 工具

/** 容量的合法化：非法值一律回到默认，宁可"保守的正确"也不要"精确的 NaN" */
function normalizeCapacity(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 1) return DEFAULT_MAX_RECORDS;
  return Math.floor(requested);
}

function normalizeContext(context: string): string {
  if (typeof context !== 'string') return CONTEXT_UNSPECIFIED;
  const trimmed = context.trim();
  return trimmed.length > 0 ? trimmed : CONTEXT_UNSPECIFIED;
}

/** 记录对外的副本（内部记录绝不能被外部改到，原因见 `records` 的注释） */
function copyOf(record: CapturedError): CapturedError {
  return {
    id: record.id,
    atMs: record.atMs,
    kind: record.kind,
    message: record.message,
    stack: record.stack,
    context: record.context,
    count: record.count,
  };
}

/**
 * 把 `unknown` 变成"消息 + 栈"。
 *
 * 不用 `instanceof Error` 作唯一判据：Worker / iframe 里抛出来的 Error 跨了 realm，
 * `instanceof` 会返回 false（这是很常见的"明明有 Error 却识别不出来"的坑），
 * 所以对象形态统一按 name / message / stack 三个字段尽力取。
 */
export function describeUnknown(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    // message 为空串的 Error 也存在（`new Error()`），这时至少要带上类名，否则记录里是一条空白消息
    const message = error.message.length > 0 ? error.message : `${error.name}（message 为空）`;
    return { message, stack: clipStack(error.stack ?? null) };
  }
  if (typeof error === 'string') return { message: error, stack: null };
  if (error === null) return { message: '未知错误：捕获到的值是 null', stack: null };
  if (error === undefined) return { message: '未知错误：捕获到的值是 undefined', stack: null };

  if (typeof error === 'object') {
    const candidate = error as { name?: unknown; message?: unknown; stack?: unknown };
    const name = typeof candidate.name === 'string' && candidate.name.length > 0 ? candidate.name : null;
    const message =
      typeof candidate.message === 'string' && candidate.message.length > 0 ? candidate.message : null;
    const stack = typeof candidate.stack === 'string' ? candidate.stack : null;
    if (name || message) {
      return { message: name && message ? `${name}：${message}` : (name ?? message ?? '未知错误'), stack: clipStack(stack) };
    }
    return { message: `未知错误（对象）：${safeStringify(error)}`, stack: null };
  }

  // number / boolean / bigint / symbol / function：用 String() 而不是模板字符串，
  // 模板字符串遇到 symbol 会抛 TypeError —— 在错误采集路径上再抛一次是最糟的
  return { message: String(error), stack: null };
}

/**
 * 栈截断。
 *
 * `null` 原样返回（**不**用空字符串冒充"没有栈"：面板要能区分"拿不到"与"是空的"）。
 * 截断后追加一行说明，因为返回值比上限长一点是可以接受的 ——
 * 让人以为"这就是完整栈"才是真的有害。
 */
function clipStack(stack: string | null): string | null {
  if (stack === null) return null;
  if (stack.length <= STACK_LIMIT_CHARS) return stack;
  const dropped = stack.length - STACK_LIMIT_CHARS;
  return `${stack.slice(0, STACK_LIMIT_CHARS)}\n…（栈信息已截断：原文 ${stack.length} 字符，只保留前 ${STACK_LIMIT_CHARS} 字符，省略 ${dropped} 字符）`;
}

/** 事件里的 `filename:line:col`；缺任何一个都不拼（半截位置比没有位置更容易把人带错方向） */
function positionFromEvent(raw: { filename?: unknown; lineno?: unknown; colno?: unknown }): string | null {
  const filename = typeof raw.filename === 'string' && raw.filename.length > 0 ? raw.filename : null;
  if (!filename) return null;
  const line = typeof raw.lineno === 'number' && Number.isFinite(raw.lineno) ? raw.lineno : null;
  const column = typeof raw.colno === 'number' && Number.isFinite(raw.colno) ? raw.colno : null;
  if (line === null) return `位置：${filename}`;
  return column === null ? `位置：${filename}:${line}` : `位置：${filename}:${line}:${column}`;
}

/** 资源加载失败时尽力说出"是哪个资源"，拿不到就说拿不到 */
function describeEventTarget(target: unknown): string {
  if (typeof target !== 'object' || target === null) return '未知资源';
  const el = target as { tagName?: unknown; src?: unknown; href?: unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '未知标签';
  const url = typeof el.src === 'string' ? el.src : typeof el.href === 'string' ? el.href : null;
  return url ? `${tag} ${shorten(url, 120)}` : `${tag}（没有 src/href）`;
}

/** 截断文案（只用于显示，不改原始数据） */
function shorten(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/** 序列化任意对象；循环引用 / 含不可序列化字段的对象都不能把采集器带崩 */
function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? shorten(text, 200) : '无法序列化';
  } catch {
    try {
      const text = String(value);
      // `String(obj)` 对普通对象给的是 "[object Object]"，一个字的线索都没有 ——
      // 与其在面板上显示这种"看起来有内容其实没内容"的东西，不如直说序列化失败了。
      return text === '[object Object]'
        ? '无法序列化（循环引用，或字段本身不可转成 JSON）'
        : shorten(text, 200);
    } catch {
      return '无法序列化（连 String() 都失败了）';
    }
  }
}

/** 报告里的环境信息。拿不到就是 `null`，并在 `notes` 里说明原因 */
function readEnvironment(): { userAgent: string | null; href: string | null; language: string | null } {
  return {
    userAgent: typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' ? navigator.userAgent : null,
    href: typeof location !== 'undefined' && typeof location.href === 'string' ? location.href : null,
    language: typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : null,
  };
}

/**
 * 浏览器 window（Node 里返回 `null`）。
 *
 * 走 `globalThis.window` 而不是裸 `window` 标识符：断言（Node）里既能验证"没有 window 时不抛异常"，
 * 也能注入一个假 window 验证真实的事件链路 —— 用裸标识符的话后者没法测。
 */
function browserWindow(): ErrorScope | null {
  const candidate = (globalThis as { window?: unknown }).window;
  if (!candidate || typeof candidate !== 'object') return null;
  const scope = candidate as ErrorScope;
  return typeof scope.addEventListener === 'function' ? scope : null;
}
