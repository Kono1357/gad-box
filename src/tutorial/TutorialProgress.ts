/**
 * 教学完成度追踪 + 进度保存（M5 第 4 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 一件事必须先说清：`completionRatio` 在"没有可玩关卡"时是 `null`，不是 0
 * ────────────────────────────────────────────────────────────
 * 需求里点名了这一条，理由也确实成立：面板上写「0%」，玩家读到的是
 * **"我一关都没过"**；而真实情况可能是"这个构建里一关都没装"。
 * 两件事必须能区分开，所以这里返回 `null`，文案层写"暂无关卡"。
 * 同理，`totalCount` 为 0 时**不做除法** —— `0 / 0` 是 `NaN`，
 * `NaN` 一旦进了 `style.width = 'NaN%'` 就会让整个进度条消失（不报错，只是空着），
 * 那种 bug 在手机上极难定位。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么要能注入 storage / levelIds / now
 * ────────────────────────────────────────────────────────────
 * 这个类要在 Node 里被断言（无 localStorage、无 DOM）。三样东西必须可注入：
 * - `storage`：注入一个"写就抛异常"的假存储，才能验证**读写失败时降级**而不是崩；
 * - `levelIds`：注入空数组（或只装了一部分关卡的构建），才能验证 `completionRatio === null`；
 * - `now`：注入固定时间，才能验证"atMs 缺省时取当前时间"而不用等真实时钟。
 * 三者的缺省值都是真实实现，所以生产代码 `new TutorialProgress()` 就够了。
 *
 * ────────────────────────────────────────────────────────────
 * 存档格式：宽容地读，严格地写
 * ────────────────────────────────────────────────────────────
 * 读：接受 `{ v: 1, records: [...] }`（我们自己写的）、裸数组（早期手改过的）、
 * 以及 `{ id: atMs }` 这种对象映射；缺 `atMs` 的记 0（**0 = 存档里没写时间**，
 * 不拿"现在"冒充 —— 那会让玩家看到一条不存在的时间）。
 * 写：只写 `{ v: 1, records: [...] }`，并且**任何一步出错都不抛异常**：
 * 无痕模式 / 存储配额满 / Cookie 全禁，都只把 `lastError` 记下来，内存里的进度照常工作。
 *
 * ⚠ 导入是**整体替换**而不是合并：这样"导出 → 导入"才是恒等操作（往返一致），
 * 否则每导入一次就会把两边的记录并起来，重复导入同一次导出会越滚越多。
 */

import { TUTORIAL_CATALOG } from './TutorialCatalog';

/** localStorage 键名（需求指定的字样；带 `gad-box-` 前缀而不是 `god-sandbox-`，与需求一致） */
export const TUTORIAL_PROGRESS_STORAGE_KEY = 'gad-box-tutorial-progress';

/** 当前存档格式版本 */
export const TUTORIAL_PROGRESS_VERSION = 1;

/** 一条完成记录 */
export interface TutorialProgressRecord {
  id: string;
  /**
   * 通关时刻（毫秒）。0 表示**存档里没写时间**（读了别人的手改存档），
   * 不是"1970 年通的关"，也不是"现在通的关"。
   */
  atMs: number;
}

/** 只用到这三个方法的存储接口 —— 故意不直接用 `Storage` 类型，好让断言注入一个假对象 */
export interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TutorialProgressOptions {
  /** 存储；传 `null` 表示"不持久化"（无痕模式 / 断言用） */
  storage?: ProgressStorage | null;
  /** 可玩关卡的 id 列表；缺省取 `TUTORIAL_CATALOG`（传空数组＝这个构建里没有关卡） */
  levelIds?: readonly string[];
  /** 时间源；缺省 `Date.now`（不依赖 performance —— 它在某些 Worker 里没有） */
  now?: () => number;
}

/**
 * 取 localStorage；取不到返回 null。
 *
 * 必须用 try 包住：有些浏览器里**访问 `localStorage` 这个属性本身就会抛**
 * （Cookie 被完全禁用、某些企业策略、无痕模式的某些实现），不是只有读值才会抛。
 * 这一段与 `mobile/GestureTutorial.ts` 的做法一致。
 */
function resolveDefaultStorage(): ProgressStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 时间源缺省实现 */
function defaultNow(): number {
  return Date.now();
}

/** 从任意 JSON 值里读出一条合法记录；不合法返回 null（宁可不记，也不记垃圾） */
function parseRecord(raw: unknown): TutorialProgressRecord | null {
  if (typeof raw === 'string') {
    // 也接受 "关卡id" 这种写法（早期手写存档最省事的形式）
    const id = raw.trim();
    return id ? { id, atMs: 0 } : null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as { id?: unknown; atMs?: unknown };
  if (typeof candidate.id !== 'string') return null;
  const id = candidate.id.trim();
  if (!id) return null;
  const atMs = typeof candidate.atMs === 'number' && Number.isFinite(candidate.atMs)
    ? Math.max(0, candidate.atMs)
    : 0;
  return { id, atMs };
}

/** 把解析出来的记录去重（同一个 id 只留第一条＝首次通关时间） */
function dedupeRecords(records: readonly TutorialProgressRecord[]): TutorialProgressRecord[] {
  const seen = new Set<string>();
  const unique: TutorialProgressRecord[] = [];
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    unique.push(record);
  }
  return unique;
}

export class TutorialProgress {
  private readonly storage: ProgressStorage | null;
  private readonly levelIds: readonly string[];
  private readonly now: () => number;
  /** 完成顺序（数组序 = 玩家通关的先后顺序，面板要按这个顺序列出"最近通的关"） */
  private records: TutorialProgressRecord[] = [];
  private lastErrorText: string | null = null;

  constructor(options: TutorialProgressOptions = {}) {
    // `storage: null` 是显式传入的"不要持久化"，与"没传"（用默认实现）必须区分开，
    // 所以判断的是 `!== undefined` 而不是用 `??` —— `??` 会把显式的 null 也当成没传。
    this.storage = options.storage !== undefined ? options.storage : resolveDefaultStorage();
    this.levelIds = options.levelIds ?? TUTORIAL_CATALOG.map((level) => level.id);
    this.now = options.now ?? defaultNow;
    this.load();
  }

  /** 最近一次存储读写失败的说明；成功时为 null */
  get lastError(): string | null {
    return this.lastErrorText;
  }

  /** 可玩关卡总数（面板显示"共 N 关"） */
  get totalCount(): number {
    return this.levelIds.length;
  }

  /**
   * 已完成关卡数。
   *
   * **只数可玩列表里的**：存档里可能有别的构建留下的、或者已经被删掉的关卡 id，
   * 把它们算进来会让"3/2 关"这种数字出现在面板上。
   */
  get completedCount(): number {
    const completed = new Set(this.records.map((record) => record.id));
    let count = 0;
    for (const id of this.levelIds) {
      if (completed.has(id)) count += 1;
    }
    return count;
  }

  /**
   * 完成度 0~1。
   *
   * ⚠ **没有可玩关卡时返回 `null`**（而不是 0、也不是 NaN）：见文件头。
   * 调用方拿到 null 时应当显示"暂无关卡"，而不是画一条 0% 的进度条。
   */
  get completionRatio(): number | null {
    const total = this.totalCount;
    if (total <= 0) return null;
    return this.completedCount / total;
  }

  /** 已完成的关卡 id（按通关先后顺序；含不在可玩列表里的历史 id） */
  get completedIds(): readonly string[] {
    return this.records.map((record) => record.id);
  }

  /** 某一关的记录；没通关返回 undefined */
  recordOf(id: string): TutorialProgressRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  isCompleted(id: string): boolean {
    return this.records.some((record) => record.id === id);
  }

  /**
   * 记一次通关。
   *
   * @param atMs 通关时刻；非法（NaN / 非有限数 / 负数）时取当前时间
   * @returns 这次调用是否**新**记下一关（重复标记同一个 id 返回 false）
   *
   * 重复标记**不覆盖**首次时间：面板上"什么时候通的"用第一次才有意义，
   * 而"再点一次下一步"会把时间刷成现在，等于把记录改坏了。
   */
  markCompleted(id: string, atMs?: number): boolean {
    const key = typeof id === 'string' ? id.trim() : '';
    if (!key) return false;
    if (this.isCompleted(key)) return false;
    const time = typeof atMs === 'number' && Number.isFinite(atMs) && atMs >= 0 ? atMs : this.now();
    this.records.push({ id: key, atMs: time });
    this.save();
    return true;
  }

  /** 清空全部进度，并删除存储（删不掉/不存在都不抛异常） */
  reset(): void {
    this.records = [];
    this.lastErrorText = null;
    if (!this.storage) return;
    try {
      this.storage.removeItem(TUTORIAL_PROGRESS_STORAGE_KEY);
    } catch (error) {
      // ✅ 如实降级：内存里已经清空了，只是磁盘上还留着。写清原因，绝不吞掉不说。
      this.lastErrorText = `清除进度存档失败（${error instanceof Error ? error.message : String(error)}）`;
    }
  }

  /** 导出成 JSON 字符串（面板的"导出进度"按钮与断言往返用） */
  exportJson(): string {
    return JSON.stringify({
      v: TUTORIAL_PROGRESS_VERSION,
      records: this.records.map((record) => ({ id: record.id, atMs: record.atMs })),
    });
  }

  /**
   * 从 JSON 导入（**整体替换**，见文件头）。
   *
   * @returns 是否成功。失败时保持原有进度不变（半截数据不该把玩家的进度毁掉），
   *          并把原因写进 `lastError`。
   */
  importJson(json: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      this.lastErrorText = `进度存档不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`;
      return false;
    }

    const rawRecords = this.extractRecords(parsed);
    if (rawRecords === null) {
      this.lastErrorText = '进度存档格式不认识：既不是记录数组，也没有 records 字段';
      return false;
    }

    const records: TutorialProgressRecord[] = [];
    for (const raw of rawRecords) {
      const record = parseRecord(raw);
      if (record) records.push(record);
    }
    this.records = dedupeRecords(records);
    this.lastErrorText = null;
    this.save();
    return true;
  }

  /** 一行中文摘要（面板标题或 toast 用） */
  describe(): string {
    const ratio = this.completionRatio;
    if (ratio === null) return '教学进度：暂无关卡';
    const percent = Math.round(ratio * 100);
    return `教学进度：${this.completedCount} / ${this.totalCount} 关（${percent}%）`;
  }

  // ---------------------------------------------------------------- 内部
  /** 从各种历史格式里取出"记录数组"；取不到返回 null */
  private extractRecords(parsed: unknown): unknown[] | null {
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as { records?: unknown };
    const records = candidate.records;
    if (Array.isArray(records)) return records;
    // 也接受 `{ records: { '关卡id': atMs } }` 这种映射写法
    if (typeof records === 'object' && records !== null) {
      return Object.entries(records as Record<string, unknown>).map(([id, atMs]) => ({ id, atMs }));
    }
    return null;
  }

  /** 读存档。任何异常都降级成"没有进度"，绝不抛 */
  private load(): void {
    this.records = [];
    this.lastErrorText = null;
    if (!this.storage) return;
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(TUTORIAL_PROGRESS_STORAGE_KEY);
    } catch (error) {
      this.lastErrorText = `读取进度存档失败（${error instanceof Error ? error.message : String(error)}）`;
      return;
    }
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 存的是垃圾（手改坏了 / 别的程序占用了这个键）：当作没有进度，
      // **不覆盖**存储 —— 万一是可救的数据，下一次 markCompleted 才会写掉它
      this.lastErrorText = '进度存档不是合法 JSON，已按"没有进度"处理（不会覆盖它，直到下次通关）';
      return;
    }
    const rawRecords = this.extractRecords(parsed);
    if (rawRecords === null) {
      this.lastErrorText = '进度存档格式不认识，已按"没有进度"处理';
      return;
    }
    const records: TutorialProgressRecord[] = [];
    for (const entry of rawRecords) {
      const record = parseRecord(entry);
      if (record) records.push(record);
    }
    this.records = dedupeRecords(records);
  }

  /** 写存档。任何异常都只记 lastError：内存里的进度是权威的 */
  private save(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(TUTORIAL_PROGRESS_STORAGE_KEY, this.exportJson());
      this.lastErrorText = null;
    } catch (error) {
      this.lastErrorText = `保存进度失败（${error instanceof Error ? error.message : String(error)}）；本次进度只在内存里`;
    }
  }
}
