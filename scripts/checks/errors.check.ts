/**
 * 错误处理 / 安全模式 / 损坏存档导出 / 重置（M5 第 1 批）的纯逻辑断言。
 *
 * 为什么不写进 `scripts/verify.ts`：那个文件是并发编辑的公共入口，加进去必然冲突。
 * 这里导出一个 `runErrorChecks(check)`，跑法见同目录的 `errors.run.ts`：
 *
 * ```bash
 * npx esbuild scripts/checks/errors.run.ts --bundle --format=esm --platform=node \
 *   --outfile=.verify/errors.mjs && node .verify/errors.mjs
 * ```
 *
 * ────────────────────────────────────────────────────────────
 * 这批断言在防什么
 * ────────────────────────────────────────────────────────────
 * 这四个模块都运行在"已经出事"的路径上，所以它们的错法都特别隐蔽：
 * - 采集器自己抛异常 → 现场是"什么错误都没有"，看起来一切正常；
 * - 环形缓冲用 `shift()` → 恰恰在错误最密集的那一秒把主线程再压一遍；
 * - 去重键拼错 → 每帧一条，50 条缓冲 1 秒被同一类错误刷满，原始错误被挤出去；
 * - 安全模式返回清单而不判 active → "没开安全模式却把画质关到最低"；
 * - 重置删多了 → 把同域下别人的数据删了（这是这批里唯一**不可逆**的破坏）。
 * 所以下面的断言分成"不变量"（数量守恒、顺序、副本）与"如实标注"（拿不到就 null / 中文说明）
 * 两类，而不是去比对界面外观。
 *
 * 两条如实标注的局限（写在断言里而不是藏起来）：
 * 1. 本文件在 Node 里跑，没有真正的浏览器：`window` 是注入的假目标（`makeFakeTarget`），
 *    验证的是**契约**（挂了哪些监听、派发后记了什么），不是真实浏览器的行为；
 * 2. "键清单没漂移"那条断言靠的是**在源码文本里搜字符串**：动态拼出来的键名
 *    （模板字符串）没法用正则可靠识别，所以用的是"每个键都在源码里留了可搜索的写法"这种弱一些
 *    但不会误报的判据。它抓不住"新增了键但没登记"，只能抓住"登记错了 / 键名改了"。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONTEXT_RESOURCE_ERROR,
  CONTEXT_UNHANDLED_REJECTION,
  CONTEXT_WEBGL_LOST,
  CONTEXT_WINDOW_ERROR,
  DEFAULT_MAX_RECORDS,
  ErrorHandler,
  STACK_LIMIT_CHARS,
  type ErrorScope,
} from '../../src/core/ErrorHandler';
import {
  SAFE_MODE_ERROR_THRESHOLD,
  SAFE_MODE_FLUID_PARTICLE_LIMIT,
  SAFE_MODE_REASON_LABELS,
  SAFE_MODE_RENDER_DISTANCE,
  SAFE_MODE_RESTRICTIONS,
  SafeMode,
  type SafeModeReason,
} from '../../src/core/SafeMode';
import {
  buildCorruptSaveExport,
  checksumFnv1a32,
  corruptSaveExportFileName,
  corruptSaveExportJson,
  describeCorruptSaveExport,
  downloadCorruptSaveExport,
} from '../../src/core/CorruptSaveExport';
import {
  FAVORITES_PREF_KEY,
  ResetManager,
  STORAGE_KEY_PREFIX,
  STORAGE_KEY_SOURCES,
  type ResetStorage,
} from '../../src/core/ResetManager';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 中文文案的最低要求：至少得有一个汉字（用来挡住"忘了写中文"的英文串） */
function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

/** 跑一段代码，只关心"抛没抛 + 抛了什么" */
function doesNotThrow(fn: () => void): { ok: boolean; detail: string } {
  try {
    fn();
    return { ok: true, detail: '' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 假的"能挂监听的目标"（Node 里没有 window，用它验证事件链路）。
 *
 * 派发时传的是**普通对象**而不是真的 Event：这正是要验证的东西 ——
 * 采集器必须按字段取值（不能依赖 `instanceof ErrorEvent`），
 * 否则跨 realm / 老浏览器里会一条都收不到。
 */
interface FakeTarget {
  listeners: Map<string, ((event: unknown) => void)[]>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  dispatch(type: string, event: unknown): void;
  has(type: string): boolean;
  count(): number;
}

function makeFakeTarget(): FakeTarget {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  return {
    listeners,
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    has(type) {
      return (listeners.get(type) ?? []).length > 0;
    },
    count() {
      let total = 0;
      for (const list of listeners.values()) total += list.length;
      return total;
    },
  };
}

/** 内存版存储：注入给 ResetManager，用来断言"删了哪些、留了哪些、别人的键动没动" */
interface FakeStorage extends ResetStorage {
  map: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function makeStorage(entries: Record<string, string>): FakeStorage {
  const map = new Map<string, string>(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
  };
}

/** 隐私模式下的存储：连 length 都读不了 */
function makeHostileStorage(): ResetStorage {
  return {
    get length(): number {
      throw new Error('隐私模式下拒绝访问');
    },
    key() {
      return null;
    },
    removeItem() {
      /* 到不了这里 */
    },
  };
}

/** 造一份"本应用全套键"的存储内容 */
function fullOwnEntries(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const source of STORAGE_KEY_SOURCES) {
    if (source.where === 'localStorage') entries[source.key] = `${source.key}-value`;
  }
  return entries;
}

/** 递归收集 src 下的 .ts 文本（"键清单没漂移"的断言要用） */
function readSourceText(dir: string, excludeSuffix: string): { ok: boolean; text: string; files: number; reason: string } {
  const chunks: string[] = [];
  let files = 0;
  try {
    const walk = (current: string): void => {
      for (const entry of readdirSync(current)) {
        const path = join(current, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (entry.endsWith('.ts')) {
          // ⚠ 必须排除**声明这份清单的那个文件本身**：它里面写着全部键名，
          // 不排除的话"每个键都能在源码里搜到"这条断言等于自己搜自己，永远是绿的。
          if (path.endsWith(excludeSuffix)) continue;
          chunks.push(readFileSync(path, 'utf8'));
          files += 1;
        }
      }
    };
    walk(dir);
    return { ok: true, text: chunks.join('\n'), files, reason: '' };
  } catch (error) {
    return { ok: false, text: chunks.join('\n'), files, reason: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

export function runErrorChecks(check: CheckFn): void {
  // ==================================================================
  // 0. 环境事实（后面的断言按它分两条路，先如实记下来）
  // ==================================================================
  const globals = globalThis as unknown as { window?: unknown };
  const hadWindow = 'window' in globals;
  const previousWindow = globals.window;
  check(
    '环境事实：本进程有没有全局 window（决定"捕获"那组断言走真实事件还是注入的假目标）',
    true,
    hadWindow ? '有 window：按真实事件目标断言' : '没有 window（Node 默认如此）：注入假目标验证，另有断言专门验证"没有 window 时不抛异常"',
  );

  // ==================================================================
  // 1. 没有 window 时的降级 + 手动上报
  // ==================================================================
  const installedWithoutWindow = doesNotThrow(() => {
    const handler = new ErrorHandler();
    handler.install();
    handler.uninstall();
  });
  check(
    '没有 window 时 install() / uninstall() 不抛异常（采集器自己不能在启动阶段把应用搞崩）',
    installedWithoutWindow.ok,
    installedWithoutWindow.detail || (hadWindow ? '本进程有 window，走的是真实目标那条路' : '安静降级，什么也没挂'),
  );

  const manual = new ErrorHandler({ maxRecords: 8 });
  const first = manual.capture('读档', new Error('存档损坏'));
  check(
    'capture() 的记录是 manual 类型，message 是原始消息（不翻译，否则搜不到）',
    first.kind === 'manual' && first.message === '存档损坏' && first.count === 1 && first.id === 1,
    `kind=${first.kind} message=${JSON.stringify(first.message)} count=${first.count}`,
  );
  check(
    'Error 对象带上了栈（能拿到就必须记下来）',
    typeof first.stack === 'string' && first.stack.includes('Error'),
    `stack=${first.stack === null ? 'null' : first.stack.split('\n')[0] ?? ''}`,
  );

  const longStack = new Error('长栈');
  longStack.stack = `Error: 长栈\n${'    at somewhere (file.ts:1:1)\n'.repeat(400)}`;
  const truncated = manual.capture('长栈测试', longStack);
  check(
    `超长栈被截断到 ${STACK_LIMIT_CHARS} 字符并写明原始长度（不能让人以为这是完整栈）`,
    truncated.stack !== null
      && truncated.stack.includes('栈信息已截断')
      && truncated.stack.includes(String(longStack.stack.length))
      && truncated.stack.length < longStack.stack.length + 200
      && truncated.stack.startsWith(longStack.stack.slice(0, 100)),
    `原文 ${longStack.stack.length} 字符 → 记录 ${truncated.stack?.length ?? 0} 字符`,
  );
  const shortStackError = new Error('短栈');
  shortStackError.stack = 'Error: 短栈\n    at a.ts:1:1';
  const shortStack = manual.capture('短栈测试', shortStackError);
  check(
    '短栈原样保留（不能被"顺手截断"的逻辑改掉）',
    shortStack.stack === shortStackError.stack,
    `stack=${shortStack.stack ?? 'null'}`,
  );

  const unknownCases = doesNotThrow(() => {
    manual.capture('字符串', 'pläin string');
    manual.capture('空', undefined);
    manual.capture('对象', { code: 42 });
    manual.capture('循环对象', (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })());
    manual.capture('', null);
  });
  const unknownRecords = manual.records.filter((record) => record.atMs > 0);
  check(
    '非 Error 的异常值（字符串 / undefined / 循环对象 / null）都能得到可读消息且不抛异常',
    unknownCases.ok && unknownRecords.length >= 5,
    unknownCases.detail || `共 ${unknownRecords.length} 条记录`,
  );
  const circular = manual.records.find((record) => record.context === '循环对象');
  check(
    '循环引用对象不会把采集器带崩，而且如实说"无法序列化"（不拿 [object Object] 冒充线索）',
    circular !== undefined && circular.message.includes('无法序列化') && hasChinese(circular.message),
    circular ? `message=${circular.message}` : '没找到那条记录',
  );
  const nullCase = manual.records.find((record) => record.message.includes('null'));
  check(
    'capture(context, null) 明确写"捕获到的值是 null"（不写空字符串冒充消息）',
    nullCase !== undefined && hasChinese(nullCase.message),
    nullCase ? `message=${nullCase.message}` : '没找到那条记录',
  );
  const emptyContext = manual.capture('   ', new Error('context 是空白'));
  check(
    '空的 context 会退化成「未标注位置」（面板上不会出现一条没有出处的记录）',
    emptyContext.context === '未标注位置' && hasChinese(emptyContext.context),
    `context=${emptyContext.context}`,
  );

  // ==================================================================
  // 2. 去重 / 顺序 / 副本 / 环形缓冲
  // ==================================================================
  const dedupe = new ErrorHandler({ maxRecords: 10 });
  for (let i = 0; i < 3; i += 1) dedupe.capture('主循环', new Error('每帧都炸'));
  dedupe.capture('其它位置', new Error('每帧都炸'));
  dedupe.capture('主循环', new Error('就炸一次'));
  const dedupeRecords = dedupe.records;
  const repeated = dedupeRecords.find((record) => record.context === '主循环' && record.message === '每帧都炸');
  check(
    '同一 message + context 只留一条记录、count 累加到 3',
    dedupeRecords.length === 3 && repeated !== undefined && repeated.count === 3,
    `共 ${dedupeRecords.length} 条，重复那条 count=${repeated?.count ?? '未找到'}`,
  );
  check(
    '同一条 message 出现在不同 context 时是两条记录（去重键必须带 context）',
    dedupeRecords.filter((record) => record.message === '每帧都炸').length === 2,
    `同消息条数=${dedupeRecords.filter((record) => record.message === '每帧都炸').length}`,
  );
  check(
    'total 是累计发生次数（含重复），records.length 才是去重后的种类数',
    dedupe.total === 5 && dedupeRecords.length === 3,
    `total=${dedupe.total} records=${dedupeRecords.length}`,
  );
  check(
    'records 是"新的在前"（最近一条排在第一）',
    dedupeRecords[0]?.message === '就炸一次' && dedupeRecords[dedupeRecords.length - 1]?.message === '每帧都炸',
    `首=${dedupeRecords[0]?.message} 末=${dedupeRecords[dedupeRecords.length - 1]?.message}`,
  );
  const copy = dedupe.records;
  const mutable = copy[0] as { count: number; message: string };
  mutable.count = 999;
  mutable.message = '被外部改过';
  const afterMutation = dedupe.records[0]!;
  check(
    'records 返回的是副本：外部改它不会污染内部记录（否则面板上的计数会永久错掉）',
    afterMutation.count === 1 && afterMutation.message === '就炸一次',
    `count=${afterMutation.count} message=${afterMutation.message}`,
  );

  // maxRecords 上限 + 环形（真的没有调用 shift）
  const arrayProto = Array.prototype as unknown as { shift: () => unknown };
  const originalShift = arrayProto.shift;
  let shiftCalls = 0;
  arrayProto.shift = function patchedShift(this: unknown) {
    shiftCalls += 1;
    return originalShift.call(this);
  };
  let ringRecords: number;
  let ringNewest: string;
  try {
    const ring = new ErrorHandler({ maxRecords: 4 });
    for (let i = 1; i <= 10; i += 1) ring.capture('环形', new Error(`第 ${i} 条`));
    ringRecords = ring.records.length;
    ringNewest = ring.records[0]?.message ?? '';
    const report = JSON.parse(ring.exportReport()) as { dropped: number; total: number; distinct: number };
    check(
      'maxRecords 生效：写满之后条数不再增长（环形覆盖，不是无限增长）',
      ringRecords === 4,
      `容量 4，写了 10 条不同错误，records=${ringRecords}`,
    );
    check(
      '环形溢出不调用 Array.prototype.shift（错误最密集时不该再搬动整个数组）',
      shiftCalls === 0,
      `本次区间内 shift 调用 ${shiftCalls} 次`,
    );
    check(
      '溢出之后最新的那条仍在缓冲里（不会把刚发生的丢掉）',
      ringNewest === '第 10 条',
      `最新=${ringNewest}`,
    );
    check(
      '被覆盖掉的条数如实记录在报告里（不假装"全记下来了"）',
      report.dropped === 6 && report.distinct === 4 && report.total === 10,
      `dropped=${report.dropped} distinct=${report.distinct} total=${report.total}`,
    );
  } finally {
    arrayProto.shift = originalShift;
  }

  const invalidCapacity = new ErrorHandler({ maxRecords: Number.NaN });
  for (let i = 0; i < DEFAULT_MAX_RECORDS + 3; i += 1) invalidCapacity.capture('容量兜底', new Error(`x${i}`));
  check(
    'maxRecords 非法（NaN）时回到默认容量，不会退化成"一条都不留"',
    invalidCapacity.records.length === DEFAULT_MAX_RECORDS,
    `records=${invalidCapacity.records.length}（默认 ${DEFAULT_MAX_RECORDS}）`,
  );

  const summary = dedupe.summarize();
  check(
    'summarize() 是一行中文摘要：含类数、累计次数与最近一条',
    hasChinese(summary) && summary.includes('3') && summary.includes('5') && summary.includes('就炸一次') && !summary.includes('\n'),
    summary,
  );
  const emptySummary = new ErrorHandler().summarize();
  check(
    '没有任何错误时 summarize() 也说中文（不留空白行）',
    hasChinese(emptySummary) && emptySummary.length > 0,
    emptySummary,
  );

  const parsedReport = (() => {
    try {
      const text = dedupe.exportReport();
      return { ok: true, value: JSON.parse(text) as Record<string, unknown>, chars: text.length };
    } catch (error) {
      return { ok: false, value: null, chars: 0, error: error instanceof Error ? error.message : String(error) };
    }
  })();
  const reportRecords = Array.isArray(parsedReport.value?.records) ? (parsedReport.value!.records as unknown[]) : [];
  check(
    'exportReport() 的输出能被 JSON.parse（否则"导出报告"这条排查路是断的）',
    parsedReport.ok && parsedReport.chars > 100,
    parsedReport.ok ? `${parsedReport.chars} 字符，records=${reportRecords.length}` : `解析失败：${parsedReport.error ?? ''}`,
  );
  check(
    '报告里带上了口径说明（limits / notes / 环境信息），读的人才能判断"这是不是全部错误"',
    Array.isArray(parsedReport.value?.notes)
      && (parsedReport.value!.notes as string[]).length >= 3
      && hasChinese((parsedReport.value!.notes as string[])[0] ?? '')
      && (parsedReport.value!.limits as { maxRecords?: number } | undefined)?.maxRecords === 10
      && parsedReport.value?.environment !== undefined,
    `notes=${(parsedReport.value?.notes as string[] | undefined)?.length ?? 0} 条，limits.maxRecords=${
      (parsedReport.value?.limits as { maxRecords?: number } | undefined)?.maxRecords ?? '缺失'
    }`,
  );
  const environment = parsedReport.value?.environment as { userAgent: string | null } | undefined;
  check(
    '环境信息拿不到时是 null 而不是假字符串，并且报告里写明了原因',
    environment !== undefined
      && (typeof environment.userAgent === 'string' || environment.userAgent === null)
      && ((parsedReport.value!.notes as string[]).some((note) => note.includes('userAgent') && note.includes('null')) || environment.userAgent !== null),
    environment?.userAgent === null ? 'userAgent 为 null，notes 里已说明原因' : `userAgent=${String(environment?.userAgent).slice(0, 40)}`,
  );

  // ==================================================================
  // 3. onError 回调
  // ==================================================================
  const callbackHandler = new ErrorHandler({ maxRecords: 8 });
  callbackHandler.capture('注册之前', new Error('历史错误'));
  const seen: { message: string; count: number }[] = [];
  callbackHandler.onError((error) => seen.push({ message: error.message, count: error.count }));
  check(
    '注册回调**不会**补触发已经采到的旧错误（否则打开面板会弹一屏历史错误）',
    seen.length === 0,
    `注册后立刻收到 ${seen.length} 条`,
  );
  callbackHandler.capture('注册之后', new Error('新错误'));
  callbackHandler.capture('注册之后', new Error('新错误'));
  callbackHandler.capture('注册之后', new Error('另一条新错误'));
  check(
    '只有第一次出现的新错误触发回调（重复的不触发：每帧弹一次提示会把 UI 卡死）',
    seen.length === 2 && seen[0]?.message === '新错误' && seen[1]?.message === '另一条新错误',
    `收到 ${seen.length} 条：${seen.map((item) => `${item.message}#${item.count}`).join(' / ')}`,
  );
  check(
    '重复的错误虽然不触发回调，但 count 照样累加（"又发生了几次"仍然查得到）',
    callbackHandler.records.find((record) => record.message === '新错误')?.count === 2,
    `count=${callbackHandler.records.find((record) => record.message === '新错误')?.count ?? '未找到'}`,
  );

  const resilient = new ErrorHandler({ maxRecords: 8 });
  resilient.onError(() => {
    throw new Error('回调自己炸了');
  });
  const resilientOk = doesNotThrow(() => {
    resilient.capture('回调异常路径', new Error('第一条'));
    resilient.capture('回调异常路径', new Error('第二条'));
  });
  check(
    '回调里抛异常不会中断采集（后续错误照样记下来，否则 UI 的 bug 会把现场彻底吞掉）',
    resilientOk.ok && resilient.total === 2,
    resilientOk.detail || `total=${resilient.total}`,
  );

  const duplicateCallback = new ErrorHandler();
  let callbackCount = 0;
  const sameCallback = (): void => {
    callbackCount += 1;
  };
  duplicateCallback.onError(sameCallback);
  duplicateCallback.onError(sameCallback);
  duplicateCallback.capture('重复注册', new Error('一次'));
  check(
    '同一个回调注册两次只会收到一次通知（否则面板会重复渲染）',
    callbackCount === 1,
    `触发 ${callbackCount} 次`,
  );

  // ==================================================================
  // 4. 真实事件链路（注入假 window / 假 canvas）
  // ==================================================================
  const fakeCanvas = makeFakeTarget();
  const fakeWindow = makeFakeTarget();
  globals.window = fakeWindow;

  const eventHandler = new ErrorHandler({ maxRecords: 20 });
  const installTwice = doesNotThrow(() => {
    eventHandler.install(fakeCanvas as unknown as ErrorScope);
    eventHandler.install(fakeCanvas as unknown as ErrorScope);
  });
  check(
    '把 canvas 作为 scope 传入时：error / unhandledrejection 仍然挂到 window（这两个只在 window 上派发）',
    installTwice.ok && fakeWindow.has('error') && fakeWindow.has('unhandledrejection'),
    `canvas 监听数=${fakeCanvas.count()}，window 监听数=${fakeWindow.count()}`,
  );
  check(
    'webglcontextlost 挂在 canvas 上、**不**挂 window（两处都挂会让同一次丢失被记两条）',
    fakeCanvas.has('webglcontextlost') && !fakeWindow.has('webglcontextlost'),
    `canvas 有=${fakeCanvas.has('webglcontextlost')} window 有=${fakeWindow.has('webglcontextlost')}`,
  );
  check(
    'install() 重复调用不会重复挂监听（重复挂会让同一条错误被记两条、count 翻倍）',
    fakeCanvas.count() === 3 && fakeWindow.count() === 2,
    `canvas=${fakeCanvas.count()}（期望 3）window=${fakeWindow.count()}（期望 2）`,
  );

  fakeWindow.dispatch('error', { error: new Error('真异常'), message: '真异常' });
  const fromEvent = eventHandler.records[0]!;
  check(
    'window 的 error 事件被捕获，kind=error、context 是中文的「窗口错误事件」',
    fromEvent.kind === 'error' && fromEvent.context === CONTEXT_WINDOW_ERROR && fromEvent.message === '真异常' && hasChinese(fromEvent.context),
    `kind=${fromEvent.kind} context=${fromEvent.context} message=${fromEvent.message}`,
  );
  check(
    'error 事件的 { error } 形态带上了栈',
    typeof fromEvent.stack === 'string' && fromEvent.stack.includes('Error'),
    `stack=${fromEvent.stack?.split('\n')[0] ?? 'null'}`,
  );

  fakeWindow.dispatch('error', { message: 'Script error.', filename: 'https://example.com/app.js', lineno: 12, colno: 34 });
  const messageOnly = eventHandler.records[0]!;
  check(
    'error 事件的 { message } 形态（跨域脚本脱敏后就是这样）保留原始消息',
    messageOnly.message === 'Script error.' && messageOnly.context === CONTEXT_WINDOW_ERROR,
    `message=${JSON.stringify(messageOnly.message)}`,
  );
  check(
    '只剩 message 时用事件里的 filename:line:col 当位置（这是事件给的真实数据，不是编的）',
    messageOnly.stack === '位置：https://example.com/app.js:12:34',
    `stack=${messageOnly.stack ?? 'null'}`,
  );

  fakeWindow.dispatch('error', { message: '', target: { tagName: 'SCRIPT', src: 'https://example.com/assets/app.js' } });
  const resource = eventHandler.records[0]!;
  check(
    '资源加载失败单独归类（否则面板上是一堆"没有消息的错误"，看不出是脚本没加载上）',
    resource.context === CONTEXT_RESOURCE_ERROR
      && resource.message.includes('script')
      && resource.message.includes('app.js')
      && resource.stack === null
      && hasChinese(resource.message),
    `context=${resource.context} message=${resource.message}`,
  );

  fakeWindow.dispatch('unhandledrejection', { reason: new Error('异步炸了') });
  const rejection = eventHandler.records[0]!;
  check(
    'unhandledrejection 被捕获，kind=unhandledrejection、context 是中文',
    rejection.kind === 'unhandledrejection'
      && rejection.context === CONTEXT_UNHANDLED_REJECTION
      && rejection.message === '异步炸了'
      && hasChinese(rejection.context),
    `kind=${rejection.kind} context=${rejection.context}`,
  );

  fakeCanvas.dispatch('webglcontextlost', { statusMessage: 'GPU 进程崩溃' });
  const contextLost = eventHandler.records[0]!;
  check(
    'webglcontextlost 被捕获（黑屏但控制台一条错误都没有，就是这种情况）',
    contextLost.context === CONTEXT_WEBGL_LOST
      && contextLost.kind === 'error'
      && contextLost.message.includes('GPU 进程崩溃')
      && hasChinese(contextLost.message),
    `context=${contextLost.context} message=${contextLost.message}`,
  );
  check(
    'WebGL 上下文丢失的 stack 是 null（它不是异常，没有栈；写空串会被读成"有栈但是空的"）',
    contextLost.stack === null,
    `stack=${String(contextLost.stack)}`,
  );

  const beforeUninstall = eventHandler.total;
  eventHandler.uninstall();
  fakeWindow.dispatch('error', { error: new Error('卸载之后不该再被记到') });
  fakeCanvas.dispatch('webglcontextlost', {});
  check(
    'uninstall() 摘掉了全部监听：之后再派发事件不再产生记录',
    eventHandler.total === beforeUninstall && fakeCanvas.count() === 0 && fakeWindow.count() === 0,
    `卸载前 total=${beforeUninstall}，卸载后 total=${eventHandler.total}，残留监听=${fakeCanvas.count() + fakeWindow.count()}`,
  );
  const afterUninstallCapture = doesNotThrow(() => {
    eventHandler.capture('卸载之后', new Error('手动上报仍然可用'));
  });
  check(
    'uninstall() 只摘监听、不影响手动上报（引擎内部 try/catch 的 capture 仍然有效）',
    afterUninstallCapture.ok && eventHandler.total === beforeUninstall + 1,
    afterUninstallCapture.detail || `total=${eventHandler.total}`,
  );

  if (hadWindow) globals.window = previousWindow;
  else delete globals.window;

  // ==================================================================
  // 5. SafeMode
  // ==================================================================
  const safeMode = new SafeMode();
  check(
    '未进入安全模式时 restrictions 是**空清单**（防止"没开安全模式却把画质关到最低"）',
    safeMode.state.active === false
      && safeMode.state.reason === null
      && safeMode.state.since === null
      && safeMode.restrictions.length === 0,
    `active=${safeMode.state.active} restrictions=${safeMode.restrictions.length}`,
  );
  const inactiveText = safeMode.describe();
  check(
    '未进入安全模式时 describe() 也说中文（不留空字符串）',
    hasChinese(inactiveText) && inactiveText.includes('未开启'),
    inactiveText,
  );

  safeMode.enter('webgl-unavailable', 'WebGL 上下文创建失败，显卡驱动可能有问题');
  const activeState = safeMode.state;
  const restrictions = safeMode.restrictions;
  check(
    'enter() 之后 active=true、原因与说明都在、since 是时间戳',
    activeState.active && activeState.reason === 'webgl-unavailable'
      && activeState.detail.length > 0
      && typeof activeState.since === 'number' && activeState.since > 0,
    `reason=${activeState.reason} since=${String(activeState.since)}`,
  );
  check(
    '安全模式下的限制清单非空，且每项都有 key / label / value / reason 四个部分',
    restrictions.length >= 6
      && restrictions.every((item) => item.key.length > 0 && item.label.length > 0 && item.reason.length > 20)
      && restrictions.every((item) => typeof item.value === 'string' || typeof item.value === 'number' || typeof item.value === 'boolean'),
    `清单 ${restrictions.length} 项：${restrictions.map((item) => item.key).join(', ')}`,
  );
  check(
    '清单里每条的 label 与 reason 都是中文（面板直接显示这两句）',
    restrictions.every((item) => hasChinese(item.label) && hasChinese(item.reason)),
    restrictions.filter((item) => !hasChinese(item.label) || !hasChinese(item.reason)).map((item) => item.key).join(',') || '全部中文',
  );
  const particleRule = restrictions.find((item) => item.key === 'fluid-particle-limit');
  check(
    `清单里有"流体粒子上限"这类具体项，且给的是安全模式下的确定值（${SAFE_MODE_FLUID_PARTICLE_LIMIT}）`,
    particleRule !== undefined
      && particleRule.value === SAFE_MODE_FLUID_PARTICLE_LIMIT
      && particleRule.reason.includes('3000'),
    particleRule ? `${particleRule.label} = ${String(particleRule.value)}；理由里引用了正常上限的出处` : '没找到这一项',
  );
  const renderDistanceRule = restrictions.find((item) => item.key === 'render-distance');
  check(
    `渲染距离降到最小档（${SAFE_MODE_RENDER_DISTANCE}，与 QualityPreset / CULLING_CONFIG 的下限一致）`,
    renderDistanceRule?.value === SAFE_MODE_RENDER_DISTANCE,
    renderDistanceRule ? `${renderDistanceRule.label} = ${String(renderDistanceRule.value)}` : '没找到这一项',
  );
  check(
    '清单里有关掉阴影、关掉自动模拟、关掉自动降级这三项（安全模式的核心动作）',
    restrictions.some((item) => item.key === 'shadows' && item.value === false)
      && restrictions.some((item) => item.key === 'auto-simulation' && item.value === false)
      && restrictions.some((item) => item.key === 'auto-degrade' && item.value === false),
    restrictions.map((item) => `${item.key}=${String(item.value)}`).join(' '),
  );
  check(
    '每一项都给了 Engine 该走的入口（清单和实际动作能对上，不会"写了却没做"）',
    restrictions.every((item) => item.entry.length > 5 && hasChinese(item.entry)),
    restrictions[0] ? `例：${restrictions[0].entry}` : '清单为空',
  );
  check(
    '限制清单是冻结的常量：调用方改不动它（改了就会"面板说的和实际做的不一样"）',
    Object.isFrozen(SAFE_MODE_RESTRICTIONS),
    `isFrozen=${Object.isFrozen(SAFE_MODE_RESTRICTIONS)}`,
  );
  const activeText = safeMode.describe();
  check(
    'describe() 是中文一行：含原因标签、已开启时长与关闭项数',
    hasChinese(activeText) && activeText.includes('安全模式已开启')
      && activeText.includes('WebGL') && activeText.includes(String(restrictions.length))
      && !activeText.includes('\n'),
    activeText,
  );

  const firstSince = safeMode.state.since;
  safeMode.enter('too-many-errors', '短时间内错误太多');
  check(
    '重复 enter() 会更新理由，但**保留最早的 since**（否则"已开启多久"会被重置成 0 秒，让人以为刚刚才崩）',
    safeMode.state.reason === 'too-many-errors' && safeMode.state.since === firstSince,
    `reason=${safeMode.state.reason} since 是否保持=${String(safeMode.state.since === firstSince)}`,
  );
  const stateCopy = safeMode.state as { active: boolean };
  stateCopy.active = false;
  check(
    'state 返回的是副本：外部改它不影响内部状态',
    safeMode.state.active === true,
    `外部改了副本之后内部 active=${safeMode.state.active}`,
  );
  safeMode.exit();
  safeMode.exit();
  check(
    'exit() 之后状态清空、清单回到空、describe() 回到"未开启"（重复调用安全）',
    safeMode.state.active === false
      && safeMode.restrictions.length === 0
      && safeMode.describe().includes('未开启'),
    safeMode.describe(),
  );

  const reasons: SafeModeReason[] = ['webgl-unavailable', 'world-load-failed', 'save-corrupt', 'too-many-errors', 'manual'];
  check(
    '五个进入理由都有中文标签（面板与报告不会漏掉任何一种）',
    reasons.every((reason) => hasChinese(SAFE_MODE_REASON_LABELS[reason])),
    reasons.map((reason) => SAFE_MODE_REASON_LABELS[reason]).join(' / '),
  );
  check(
    '没有理由/空说明时 enter() 也留得下一句中文（reason 空说明会退化成理由标签）',
    (() => {
      const fallback = new SafeMode();
      fallback.enter('manual', '   ');
      return fallback.state.detail.length > 0 && hasChinese(fallback.state.detail);
    })(),
    '空 detail 退化成理由标签',
  );
  check(
    `错误阈值是个明确的数字常量（接线时用它判断"错误太多就进安全模式"）`,
    typeof SAFE_MODE_ERROR_THRESHOLD === 'number' && SAFE_MODE_ERROR_THRESHOLD >= 1,
    `SAFE_MODE_ERROR_THRESHOLD=${SAFE_MODE_ERROR_THRESHOLD}`,
  );

  // ==================================================================
  // 6. CorruptSaveExport
  // ==================================================================
  const corruptRaw = '{"version":3,"chunks":[{"cx":0,"cz":0,"voxels":{"e":"rle","d":"AA==';
  const corruptSaveStorage = makeStorage({ 'god-sandbox-save-v3': corruptRaw, 'other-app': '不许动' });
  const exportPayload = buildCorruptSaveExport({
    key: 'god-sandbox-save-v3',
    raw: corruptSaveStorage.getItem('god-sandbox-save-v3'),
    exportedAt: 1735689600000,
  });
  check(
    '坏存档：不抛异常、给出一条中文问题说明、原文副本逐字符相同',
    exportPayload.raw.text === corruptRaw
      && exportPayload.raw.lengthChars === corruptRaw.length
      && exportPayload.raw.truncated === false
      && exportPayload.diagnosis.problems.length >= 1
      && exportPayload.diagnosis.problems.every((problem) => hasChinese(problem))
      && exportPayload.diagnosis.readable === false,
    `problems=${exportPayload.diagnosis.problems.length} 条：${exportPayload.diagnosis.problems[0] ?? ''}`,
  );
  check(
    '导出**不改原数据**：假存储里那份坏字符串一字未变（本函数连存储句柄都没有）',
    corruptSaveStorage.getItem('god-sandbox-save-v3') === corruptRaw
      && corruptSaveStorage.map.get('other-app') === '不许动',
    `存储内容=${corruptSaveStorage.map.size} 个键，原文是否原样=${String(corruptSaveStorage.getItem('god-sandbox-save-v3') === corruptRaw)}`,
  );
  const exportAgain = buildCorruptSaveExport({
    key: 'god-sandbox-save-v3',
    raw: corruptRaw,
    exportedAt: 1735689600000,
  });
  check(
    '同样的输入导出两次结果逐字节相同（可复现，才能拿两份报告对比）',
    JSON.stringify(exportAgain) === JSON.stringify(exportPayload),
    '两次导出的 JSON 完全一致',
  );
  const exportJson = corruptSaveExportJson(exportPayload);
  const reparsed = (() => {
    try {
      return { ok: true, value: JSON.parse(exportJson) as { raw: { text: string }; errors: { parse: string | null } } };
    } catch (error) {
      return { ok: false, value: null, error: error instanceof Error ? error.message : String(error) };
    }
  })();
  check(
    '导出的 JSON 能被 JSON.parse 回来，且原文与解析错误都在里面（这是"可下载的副本"的前提）',
    reparsed.ok && reparsed.value?.raw.text === corruptRaw && typeof reparsed.value?.errors.parse === 'string',
    reparsed.ok ? `parse 错误已记录：${reparsed.value?.errors.parse ?? ''}` : `解析失败：${reparsed.error ?? ''}`,
  );
  check(
    '报告带上了时间戳、版本信息与格式标识（拿到文件的开发者能判断该怎么读它）',
    exportPayload.exportedAt === 1735689600000
      && exportPayload.exportedAtIso.startsWith('2025-01-01')
      && exportPayload.formatVersion === 1
      && exportPayload.supportedSaveVersion !== null
      && exportPayload.version.saveVersion === null,
    `exportedAtIso=${exportPayload.exportedAtIso} supportedSaveVersion=${String(exportPayload.supportedSaveVersion)}`,
  );
  check(
    'checksumFnv1a32 与原文对应：同串稳定、改一个字符就变（它是"副本=原文"的证据）',
    checksumFnv1a32(corruptRaw) === exportPayload.raw.checksumFnv1a32
      && checksumFnv1a32(corruptRaw) !== checksumFnv1a32(`${corruptRaw}x`)
      && /^[0-9a-f]{8}$/.test(exportPayload.raw.checksumFnv1a32 ?? ''),
    `checksum=${String(exportPayload.raw.checksumFnv1a32)}（改动后=${checksumFnv1a32(`${corruptRaw}x`)}）`,
  );

  const truncatedExport = buildCorruptSaveExport({ key: 'god-sandbox-save-v3', raw: corruptRaw, maxRawChars: 10 });
  check(
    '调用方要求截断时如实记 truncated / keptChars，并在 notes 里说明"被截掉的部分不存在"',
    truncatedExport.raw.truncated === true
      && truncatedExport.raw.keptChars === 10
      && truncatedExport.raw.text === corruptRaw.slice(0, 10)
      && truncatedExport.raw.lengthChars === corruptRaw.length
      && truncatedExport.notes.some((note) => note.includes('截断')),
    `truncated=${truncatedExport.raw.truncated} keptChars=${truncatedExport.raw.keptChars} 原文=${truncatedExport.raw.lengthChars}`,
  );
  check(
    '默认不截断（损坏的存档正是最需要逐字符原样的证据）',
    exportPayload.raw.truncated === false && exportPayload.raw.keptChars === corruptRaw.length,
    `truncated=${exportPayload.raw.truncated}，明文写在 notes 里=${exportPayload.notes.some((note) => note.includes('未截断'))}`,
  );

  const healthyRaw = JSON.stringify({
    version: 3,
    seed: 1001,
    savedAt: 1735689500000,
    worldSize: 'standard',
    sizeX: 128,
    sizeY: 32,
    sizeZ: 128,
    chunks: [{ cx: 0, cz: 0, voxels: { e: 'raw', d: 'AA==' } }],
    buildings: [{ id: 1, defId: 'x' }],
  });
  const healthyExport = buildCorruptSaveExport({ key: 'god-sandbox-save-v3', raw: healthyRaw });
  check(
    '能读的存档标成 readable，并把版本 / 种子 / 尺寸 / 区块数都读出来（导出时顺带当体检报告）',
    healthyExport.diagnosis.readable === true
      && healthyExport.version.saveVersion === 3
      && healthyExport.version.seed === 1001
      && healthyExport.version.sizeX === 128
      && healthyExport.version.chunkCount === 1
      && healthyExport.version.buildingCount === 1
      && healthyExport.diagnosis.problems.length === 0,
    `readable=${healthyExport.diagnosis.readable} 种子=${String(healthyExport.version.seed)} 区块=${String(healthyExport.version.chunkCount)}`,
  );
  const tooNewExport = buildCorruptSaveExport({ key: 'god-sandbox-save-v3', raw: JSON.stringify({ version: 99, chunks: [] }) });
  check(
    '版本高于程序支持的存档会被指出来（GitHub Pages 上回退版本时很常见），而不是笼统说"损坏"',
    tooNewExport.diagnosis.readable === false
      && tooNewExport.diagnosis.problems.some((problem) => problem.includes('99') && hasChinese(problem)),
    tooNewExport.diagnosis.problems[0] ?? '没有问题说明',
  );
  const noChunksExport = buildCorruptSaveExport({ key: 'god-sandbox-save-v3', raw: JSON.stringify({ version: 3 }) });
  check(
    '缺 chunks 的存档会被指出来（版本号对得上但没有地形数据）',
    noChunksExport.diagnosis.readable === false
      && noChunksExport.diagnosis.problems.some((problem) => problem.includes('chunks')),
    noChunksExport.diagnosis.problems[0] ?? '没有问题说明',
  );
  const arrayExport = buildCorruptSaveExport({ key: 'god-sandbox-save-v3', raw: '[1,2,3]' });
  check(
    'JSON 能解析但顶层不是对象时说明具体是什么类型（"顶层是数组"比"损坏"有用得多）',
    arrayExport.diagnosis.problems.some((problem) => problem.includes('数组')),
    arrayExport.diagnosis.problems.join(' / ') || '没有问题说明',
  );
  const emptyExport = buildCorruptSaveExport({ key: 'god-sandbox-save-v3', raw: null, readError: 'SecurityError: 拒绝访问' });
  check(
    '读不到原文（getItem 返回 null）时如实说"读不到"，并把读取异常原样保留',
    emptyExport.raw.text === null
      && emptyExport.raw.lengthChars === 0
      && emptyExport.raw.checksumFnv1a32 === null
      && emptyExport.errors.read === 'SecurityError: 拒绝访问'
      && emptyExport.notes.some((note) => note.includes('null')),
    `problems=${emptyExport.diagnosis.problems.length} 条`,
  );
  const exportDescription = describeCorruptSaveExport(exportPayload);
  check(
    'describeCorruptSaveExport() 是一行中文：说清键名、体积、问题条数与"原数据不会被动"',
    hasChinese(exportDescription)
      && exportDescription.includes('god-sandbox-save-v3')
      && exportDescription.includes('副本')
      && !exportDescription.includes('\n'),
    exportDescription,
  );
  const fileName = corruptSaveExportFileName(exportPayload);
  check(
    '文件名带键名与时间戳、以 .json 结尾（连着导两次不会互相覆盖）',
    fileName.startsWith('god-sandbox-corrupt-save-') && fileName.endsWith('.json')
      && fileName.includes('2025-01-01') && !fileName.includes(':'),
    fileName,
  );
  const downloadResult = downloadCorruptSaveExport(exportPayload);
  check(
    'Node 里下载如实失败，并指向 corruptSaveExportJson()（不假装"导出成功"）',
    downloadResult.ok === false && hasChinese(downloadResult.message) && downloadResult.chars === null
      && downloadResult.message.includes('corruptSaveExportJson'),
    downloadResult.message,
  );

  // ==================================================================
  // 7. ResetManager
  // ==================================================================
  const reset = new ResetManager();
  const storage = makeStorage({ ...fullOwnEntries(), 'other-app-data': '别人的数据', 'vite-plugin-x': '也是别人的' });
  const before = JSON.stringify([...storage.map.entries()]);
  const plan = reset.plan(storage);
  check(
    'plan() 只做计划、不改任何数据（用户看到确认文案之前一个字节都不该被删）',
    JSON.stringify([...storage.map.entries()]) === before,
    `存储 ${storage.map.size} 个键，plan 之后内容未变`,
  );
  check(
    'plan() 列出了全部 god-sandbox-* 键，并把"属于本应用但当前不存在"的键单独列出来',
    plan.readable
      && plan.keys.length + plan.kept.length === STORAGE_KEY_SOURCES.filter((source) => source.where === 'localStorage').length
      && plan.missing.length === 0
      && plan.keys.every((key) => key.startsWith(STORAGE_KEY_PREFIX)),
    `将清 ${plan.keys.length} 个 / 保留 ${plan.kept.length} 个 / 不存在 ${plan.missing.length} 个`,
  );
  check(
    '别人的键被识别为 foreign 且不在删除清单里（绝不调用 storage.clear() 的证据）',
    plan.foreign.length === 2
      && plan.foreign.includes('other-app-data')
      && !plan.keys.includes('other-app-data')
      && plan.notes.some((note) => note.includes('clear')),
    `foreign=${plan.foreign.join('、')}`,
  );
  check(
    '默认保留"收藏与最近使用"（偏好不是世界状态，重置世界不该顺手抹掉）',
    plan.kept.length === 1 && plan.kept[0] === FAVORITES_PREF_KEY && !plan.keys.includes(FAVORITES_PREF_KEY),
    `kept=${plan.kept.join('、') || '空'}`,
  );
  const planWithoutFavorites = reset.plan(storage, { keepFavorites: false });
  check(
    '显式不保留时会连 prefs 一起清（选项真的起作用，不是摆设）',
    planWithoutFavorites.keys.includes(FAVORITES_PREF_KEY) && planWithoutFavorites.kept.length === 0,
    `keys 含 prefs=${String(planWithoutFavorites.keys.includes(FAVORITES_PREF_KEY))}`,
  );
  check(
    'plan().summary 是中文，且说清了"清几个、留几个、不可撤销"',
    hasChinese(plan.summary) && plan.summary.includes('不可撤销') && plan.summary.includes('不') ,
    plan.summary,
  );

  const noConfirmation = reset.apply(storage);
  check(
    'apply() 不带确认对象时拒绝执行：ok=false + 中文说明 + 存储一字未动',
    noConfirmation.ok === false
      && hasChinese(noConfirmation.message)
      && noConfirmation.message.includes('二次确认')
      && noConfirmation.removed.length === 0
      && JSON.stringify([...storage.map.entries()]) === before,
    noConfirmation.message,
  );

  const confirmation = reset.requestConfirm(storage);
  check(
    'requestConfirm() 返回需要二次确认的动作描述（中文标题 + 正文 + 按钮文案）',
    confirmation !== null
      && confirmation.required === true
      && hasChinese(confirmation.title)
      && hasChinese(confirmation.message)
      && hasChinese(confirmation.confirmLabel)
      && hasChinese(confirmation.cancelLabel)
      && confirmation.token.length > 0,
    confirmation ? `${confirmation.title}：${confirmation.message.slice(0, 60)}…` : '没有返回确认对象',
  );
  check(
    '确认文案里逐个列出会被删除的键与用途（玩家能看清楚要删什么，而不是只看一个数字）',
    confirmation !== null
      && confirmation.plan.keys.every((key) => confirmation.message.includes(key))
      && confirmation.plan.keys.length > 0
      && confirmation.message.includes(FAVORITES_PREF_KEY)
      && confirmation.message.includes('撤销'),
    confirmation ? `正文长度 ${confirmation.message.length} 字符，键全部出现=${String(confirmation.plan.keys.every((key) => confirmation.message.includes(key)))}` : '没有返回确认对象',
  );
  const result = reset.apply(storage, confirmation ?? undefined);
  const remainingOwn = [...storage.map.keys()].filter((key) => key.startsWith(STORAGE_KEY_PREFIX));
  check(
    '带确认执行：全部 god-sandbox-* 该清的都清了、一个不漏（边遍历边删的坑）',
    result.ok === true
      && result.removed.length === confirmation?.plan.keys.length
      && remainingOwn.length === 1
      && remainingOwn[0] === FAVORITES_PREF_KEY,
    `removed=${result.removed.length} 剩余本应用键=${remainingOwn.join('、') || '无'}`,
  );
  check(
    '别人的键在重置之后仍然在、值也没变（这是不可逆破坏里最要命的那条）',
    storage.map.get('other-app-data') === '别人的数据' && storage.map.get('vite-plugin-x') === '也是别人的',
    `剩余键：${[...storage.map.keys()].join('、')}`,
  );
  check(
    '保留项生效：被保留的键仍然存在，且被明确报告为"保留"',
    result.kept.includes(FAVORITES_PREF_KEY) && storage.map.has(FAVORITES_PREF_KEY),
    `result.kept=${result.kept.join('、') || '空'}`,
  );
  check(
    '执行后的说明是中文，且给出"清了几条 / 留了什么"的实际结果',
    hasChinese(result.message) && result.message.includes('重置完成') && /\d/.test(result.message),
    result.message,
  );
  const replay = reset.apply(storage, confirmation ?? undefined);
  check(
    '确认令牌是一次性的：同一个确认对象第二次 apply 被拒（连点两次按钮不会重复删）',
    replay.ok === false && hasChinese(replay.message) && replay.message.includes('失效'),
    replay.message,
  );

  const staleStorage = makeStorage(fullOwnEntries());
  const staleConfirmation = reset.requestConfirm(staleStorage);
  const freshConfirmation = reset.requestConfirm(staleStorage);
  const staleApplied = reset.apply(staleStorage, staleConfirmation ?? undefined);
  check(
    '再点一次「重置」会作废上一个确认（避免上一次的确认对象被误用到新的清单上）',
    staleApplied.ok === false
      && staleConfirmation !== null
      && freshConfirmation !== null
      && staleConfirmation.token !== freshConfirmation.token,
    staleApplied.message,
  );
  const freshApplied = reset.apply(staleStorage, freshConfirmation ?? undefined);
  check(
    '用最新的确认对象执行则成功（上面那次失败不是因为"存储被禁用了"）',
    freshApplied.ok === true && freshApplied.removed.length > 0,
    freshApplied.message,
  );

  const hostile = new ResetManager();
  const hostilePlan = hostile.plan(makeHostileStorage());
  const hostileConfirmation = hostile.requestConfirm(makeHostileStorage());
  check(
    '隐私模式下（连 length 都读不了）plan 如实标 readable=false、不弹确认框、apply 不抛异常',
    hostilePlan.readable === false
      && hostileConfirmation === null
      && hasChinese(hostilePlan.summary)
      && doesNotThrow(() => {
        hostile.apply(makeHostileStorage());
      }).ok,
    hostilePlan.summary,
  );
  const emptyStorage = makeStorage({ 'other-app-data': '不属于本应用' });
  const emptyPlan = reset.plan(emptyStorage);
  check(
    '存储里没有本应用的键时说"没有需要清除的数据"（而不是弹一个要删 0 个键的确认框）',
    emptyPlan.readable === true && emptyPlan.keys.length === 0 && emptyPlan.summary.includes('没有需要清除的数据'),
    emptyPlan.summary,
  );
  const prefsOnlyStorage = makeStorage({ [FAVORITES_PREF_KEY]: '{"favorites":["a"]}' });
  const prefsOnlyPlan = reset.plan(prefsOnlyStorage);
  const prefsOnlyConfirm = reset.requestConfirm(prefsOnlyStorage);
  const prefsOnlyResult = reset.apply(prefsOnlyStorage, prefsOnlyConfirm ?? undefined);
  check(
    '只勾了"保留收藏"时，计划里 0 个待删键、执行后 prefs 仍在（不该为了删 0 条去动它）',
    prefsOnlyPlan.keys.length === 0
      && prefsOnlyConfirm !== null
      && prefsOnlyResult.ok === true
      && prefsOnlyStorage.map.has(FAVORITES_PREF_KEY),
    `keys=${prefsOnlyPlan.keys.length} kept=${prefsOnlyResult.kept.join('、') || '空'}`,
  );

  // ==================================================================
  // 8. 键清单没漂移（防"我记错了键名"）
  // ==================================================================
  const sources = readSourceText('src', 'core/ResetManager.ts');
  const missingHints = sources.ok
    ? STORAGE_KEY_SOURCES.filter((source) => !sources.text.includes(source.search)).map((source) => source.key)
    : [];
  check(
    '键清单与源码对得上：每个登记过的键都能在 src/ 里（声明清单那文件之外）搜到对应的写法',
    sources.ok ? missingHints.length === 0 : true,
    sources.ok
      ? (missingHints.length === 0
        ? `核对了 ${sources.files} 个 .ts 文件，${STORAGE_KEY_SOURCES.length} 个键全部命中`
        : `对不上的键：${missingHints.join('、')}`)
      : `读不到 src/（工作目录不是项目根？）：${sources.reason} —— 本环境按"跳过"记，**不是**核对通过`,
  );
  const duplicateKeys = STORAGE_KEY_SOURCES.map((source) => source.key).filter(
    (key, index, all) => all.indexOf(key) !== index,
  );
  check(
    '已知键没有重复登记，且全部以 god-sandbox- 前缀开头（前缀是删除范围的唯一依据）',
    duplicateKeys.length === 0 && STORAGE_KEY_SOURCES.every((source) => source.key.startsWith(STORAGE_KEY_PREFIX)),
    duplicateKeys.length > 0 ? `重复：${duplicateKeys.join('、')}` : `前缀统一为 ${STORAGE_KEY_PREFIX}`,
  );
  check(
    '登记在案的每个键都写了"谁写的 + 装的是什么"（二次确认文案要逐条显示，缺了就只能显示键名）',
    STORAGE_KEY_SOURCES.every((source) => source.owner.length > 0 && source.content.length > 0 && hasChinese(source.content)),
    `${STORAGE_KEY_SOURCES.length} 个键都有中文用途说明`,
  );
  check(
    'sessionStorage 里的那个键被单独标注（不会被 localStorage 的重置顺手当成"没清干净"）',
    STORAGE_KEY_SOURCES.some((source) => source.where === 'sessionStorage')
      && STORAGE_KEY_SOURCES.find((source) => source.where === 'sessionStorage')?.key === 'god-sandbox-last-generation',
    `sessionStorage 键=${STORAGE_KEY_SOURCES.filter((source) => source.where === 'sessionStorage').map((source) => source.key).join('、') || '没登记'}`,
  );
}
