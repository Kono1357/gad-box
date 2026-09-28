/**
 * 重置到初始状态（M5 第 1 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 这个模块最容易造成的伤害，就是"删多了"
 * ────────────────────────────────────────────────────────────
 * 所以有三条硬规矩，都体现在代码结构里而不只是写在注释里：
 *
 * 1. **绝不用 `storage.clear()`**。部署在 GitHub Pages 上时，同一个 origin 很可能是整个
 *    `<用户名>.github.io` —— 玩家在这个域下的其它页面（甚至别人的项目）也共用这份 localStorage。
 *    `clear()` 会把它们一起删掉，而"重置沙盘把别的数据删了"是最恶劣的一类 bug。
 *    所以这里只按 `god-sandbox-` 前缀逐个键删（见 `STORAGE_KEY_PREFIX`）。
 * 2. **必须二次确认，而且确认是一次性的**：`apply()` 不接受"光杆 storage"这种调用方式，
 *    必须传 `requestConfirm()` 返回的确认对象（里面有令牌）。令牌用过即废 ——
 *    连点两次按钮不会把同一批键删两遍，也不会出现"上次确认的对象被下一次误用"。
 * 3. **清的确是用户当时看到的那一份清单**：`apply()` 只清 `confirmation.plan.keys`，
 *    不在执行时重新扫描。否则"确认了 6 个键、实际删了 7 个"这种事就会发生 ——
 *    在确认和执行之间，别的模块完全可能刚写进去一个新键。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么键清单是手写的常量，而不是去 import 各个模块的常量
 * ────────────────────────────────────────────────────────────
 * 那些常量分散在 `data/`、`ui/`、`mobile/`、`group/` 里，`core/` 去 import 会把整棵 UI 树
 * （有的还带着 Three.js）拖进 core 模块的依赖里，属于层次倒挂。
 * 代价是清单可能与源码漂移，所以每个键都带一条 `search`：**在源码里能搜到的写法**，
 * 断言（`scripts/checks/errors.check.ts`）会拿它去 `src/**` 里逐个核对，漂移会被断言抓住。
 */

/** 本应用所有本地存储键的前缀。删除只按这个前缀逐个键来，**绝不调用 `storage.clear()`** */
export const STORAGE_KEY_PREFIX = 'god-sandbox-';

/** 一个键的出处与用途（`search` 供"清单没漂移"的断言用） */
export interface StorageKeySource {
  key: string;
  /** 谁写的（模块路径） */
  owner: string;
  /** 这个键里装的是什么（中文，二次确认文案直接引用） */
  content: string;
  /** 在源码里能搜到的写法（键名本身，或者拼出它的模板片段） */
  search: string;
  /** 属于哪一份存储 */
  where: 'localStorage' | 'sessionStorage';
}

/**
 * 当前代码里会写进存储的全部键（本批（M5 第 1 批）核对过一遍全仓 `src/`）。
 *
 * 顺序按"重要程度"排（存档在最前），因为确认文案会长这样列出来，玩家最该先看到存档。
 */
export const STORAGE_KEY_SOURCES: readonly StorageKeySource[] = Object.freeze([
  {
    key: 'god-sandbox-save-v3',
    owner: 'src/config.ts（SAVE_CONFIG.storageKey）',
    content: '当前存档（地形 / 建筑 / 分组 / 设置 / 相机）',
    search: 'god-sandbox-save-v3',
    where: 'localStorage',
  },
  {
    key: 'god-sandbox-save-v2',
    owner: 'src/config.ts（SAVE_CONFIG.legacyStorageKey）',
    content: '旧版存档（M1.5 的 v2 格式，仍会被读档兼容读取）',
    search: 'god-sandbox-save-v2',
    where: 'localStorage',
  },
  {
    key: 'god-sandbox-save-v1',
    owner: '历史键（当前代码已不读它，只剩注释里提到）',
    content: 'M1 时代的老存档键，清掉没有任何副作用',
    search: 'god-sandbox-save-v1',
    where: 'localStorage',
  },
  {
    key: 'god-sandbox-prefabs-v1',
    owner: 'src/group/PrefabSystem.ts（PREFAB_STORAGE_KEY）',
    content: '保存的预制件（成组物件）',
    search: 'god-sandbox-prefabs-v1',
    where: 'localStorage',
  },
  {
    key: 'god-sandbox-custom-items-v1',
    owner: 'src/data/customItems.ts（CUSTOM_ITEM_STORAGE_KEY）',
    content: '自定义物品（玩家自己造的方块/模型定义）',
    search: 'god-sandbox-custom-items-v1',
    where: 'localStorage',
  },
  {
    key: 'god-sandbox-physics-materials-v1',
    owner: 'src/data/physicsMaterials.ts（CUSTOM_MATERIALS_KEY）',
    content: '自定义物理材质（摩擦 / 弹性覆盖表）',
    search: 'god-sandbox-physics-materials-v1',
    where: 'localStorage',
  },
  {
    key: 'god-sandbox-content-packs-v1',
    owner: 'src/data/contentPacks.ts（CONTENT_PACK_STORAGE_KEY）',
    content: '内容包的启用开关',
    search: 'god-sandbox-content-packs-v1',
    where: 'localStorage',
  },
  {
    key: 'god-sandbox-content-packs-v1-prefs',
    owner: 'src/core/Engine.ts（`${CONTENT_PACK_STORAGE_KEY}-prefs`）',
    content: '物品面板的收藏与最近使用（**默认保留**：这是偏好不是世界状态）',
    search: 'CONTENT_PACK_STORAGE_KEY}-prefs',
    where: 'localStorage',
  },
  {
    key: 'god-sandbox-physics-sandbox-v1',
    owner: 'src/ui/PhysicsSandboxMode.ts（SANDBOX_MODE_STORAGE_KEY）',
    content: '物理沙盘子选项',
    search: 'god-sandbox-physics-sandbox-v1',
    where: 'localStorage',
  },
  {
    key: 'god-sandbox-gesture-tutorial-v1',
    owner: 'src/mobile/GestureTutorial.ts（GESTURE_TUTORIAL_STORAGE_KEY）',
    content: '手势教学"已经看过"的标记',
    search: 'god-sandbox-gesture-tutorial-v1',
    where: 'localStorage',
  },
  {
    key: 'god-sandbox-last-generation',
    owner: 'src/ui/MapTemplateUI.ts（STORAGE_KEY）',
    content: '上一次生成用的模板与参数（**存在 sessionStorage 里**，不会被 localStorage 的重置波及）',
    search: 'god-sandbox-last-generation',
    where: 'sessionStorage',
  },
]);

/** 默认保留的键（玩家偏好类，不属于"世界状态"） */
export const FAVORITES_PREF_KEY = 'god-sandbox-content-packs-v1-prefs';

/**
 * 最小的存储接口。
 *
 * 刻意不用 DOM 的 `Storage` 类型：断言要在 Node 里注入一个假的存储来验证
 * "只删前缀内的键、保留项生效、别人的键不动"，用最小结构类型就能注入。
 * 真实 `localStorage` 结构上是它的超集，直接传即可。
 */
export interface ResetStorage {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

export interface ResetOptions {
  /** 是否保留"收藏与最近使用"（默认 **true**：这是玩家偏好，重置世界不该顺手抹掉） */
  keepFavorites?: boolean;
}

/** 一次重置的计划（执行前给用户看的东西） */
export interface ResetPlan {
  /** 计划是否成立：`false` 表示存储根本读不了（隐私模式），此时的 keys 一律为空，且**不该弹确认框** */
  readable: boolean;
  /** 一行中文说明（面板 / 对话框直接用这句） */
  summary: string;
  /** 将被清除的键（按"已知键优先、未知键其后"排序） */
  keys: readonly string[];
  /** 会被保留的键（本次选项中要留的那些） */
  kept: readonly string[];
  /** 属于本应用、但当前存储里不存在的键（列出它们是为了说明"清单是完整的"） */
  missing: readonly string[];
  /** 不属于本应用前缀的键：**一个都不会被碰**，列出来是为了让用户确认这一点 */
  foreign: readonly string[];
  /** 每个待清除键的中文用途（确认文案用） */
  details: readonly { key: string; content: string }[];
  /** 额外的说明（例如 sessionStorage 那个键不在本次范围内） */
  notes: readonly string[];
}

/** 二次确认对象。`token` 是一次性的：用过就作废，避免同一个确认被重放 */
export interface ResetConfirmation {
  readonly required: true;
  /** 动作描述（中文）：这次到底要做什么 */
  readonly action: string;
  readonly title: string;
  /** 二次确认正文（中文）：列清楚会删什么、会留什么、不可撤销 */
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly token: string;
  readonly plan: ResetPlan;
}

export interface ResetResult {
  ok: boolean;
  /** 确认已经被删掉的键 */
  removed: readonly string[];
  /** 计划里本来就不存在的键（不是错误，如实分开列） */
  absent: readonly string[];
  /** 删除失败（抛异常）的键 */
  failed: readonly { key: string; reason: string }[];
  /** 这次刻意保留的键 */
  kept: readonly string[];
  /** 一行中文说明（执行后用这句） */
  message: string;
}

/**
 * 重置管理器。
 *
 * 用法（面板上的"重置到初始状态"按钮）：
 * ```ts
 * const confirmation = reset.requestConfirm(localStorage, { keepFavorites: checkbox.checked });
 * if (!confirm(confirmation.message)) return;          // 第一次确认（UI 弹框）
 * const result = reset.apply(localStorage, confirmation); // 第二次确认 = 把确认对象传回来
 * ```
 * **两次确认是刻意的**：第一次是 UI 上的"你确定吗"（人看的），
 * 第二次是把上一次得到的确认对象原样传回（代码看的）——
 * 只要有代码想绕过弹框直接清数据，就会卡在第二步拿不到令牌。
 */
export class ResetManager {
  private readonly defaults: Required<ResetOptions>;
  /** 当前有效的确认令牌（只保留最新一个：再点一次「重置」会让上一个作废） */
  private pendingToken: string | null = null;
  /** 令牌序号，保证同一个毫秒内连续调用也能拿到不同的令牌 */
  private tokenSeq = 0;

  constructor(options?: ResetOptions) {
    this.defaults = { keepFavorites: options?.keepFavorites ?? true };
  }

  /**
   * 扫描存储，算出"会删哪些、会留哪些"。
   *
   * 只做计划、不做任何修改 —— 用户在看到确认文案之前，一个字节都不该被删。
   */
  plan(storage: ResetStorage, options?: ResetOptions): ResetPlan {
    const keepFavorites = options?.keepFavorites ?? this.defaults.keepFavorites;
    const scanned = scanOwnKeys(storage);
    if (!scanned.ok) {
      return {
        readable: false,
        summary: `无法读取本地存储，重置未做任何改动：${scanned.reason}`,
        keys: [],
        kept: [],
        missing: [],
        foreign: [],
        details: [],
        notes: [scanned.reason],
      };
    }

    const present = new Set(scanned.own);
    const kept = keepFavorites && present.has(FAVORITES_PREF_KEY) ? [FAVORITES_PREF_KEY] : [];
    const keptSet = new Set(kept);

    // 已知键按 STORAGE_KEY_SOURCES 的顺序排在前面（存档最先看到），
    // 扫描到的"未知但是本应用前缀"的键（将来新增的模块）排在后面按字母序 —— 它们同样会被清掉，
    // 否则每加一个新键就得记得回来改这里，迟早会漏。
    const knownLocal = STORAGE_KEY_SOURCES.filter((source) => source.where === 'localStorage').map((s) => s.key);
    const knownAll = STORAGE_KEY_SOURCES.map((source) => source.key);
    const unknownOwn = scanned.own.filter((key) => !knownAll.includes(key)).sort();
    const candidates = [...knownLocal.filter((key) => present.has(key)), ...unknownOwn];

    const keys = candidates.filter((key) => !keptSet.has(key));
    const missing = knownLocal.filter((key) => !present.has(key));
    const details = keys.map((key) => ({
      key,
      content: STORAGE_KEY_SOURCES.find((source) => source.key === key)?.content ?? '未登记用途（本应用前缀下的新键，由将来新增的模块写入）',
    }));

    const notes: string[] = [];
    if (kept.length > 0) {
      notes.push(`按当前设置保留 ${kept.join('、')}（收藏与最近使用是玩家偏好，不是世界状态）。`);
    }
    notes.push(
      '会话级的 god-sandbox-last-generation 存在 sessionStorage 里，不在本次范围内；'
      + '要连它一起清，就对 sessionStorage 再跑一次 plan/apply（同一个类，注入不同的 storage）。',
    );
    notes.push(`同域下其它应用的键共 ${scanned.foreign.length} 个，一个都不会被触碰（本模块从不调用 storage.clear()）。`);

    const summary = keys.length === 0
      ? `没有需要清除的数据：本地存储里没有 ${STORAGE_KEY_PREFIX}* 的键${kept.length > 0 ? `（保留了 ${kept.join('、')}）` : ''}。`
      : `将清除 ${keys.length} 个「上帝沙盘」键（${keys.join('、')}）；`
        + `${kept.length > 0 ? `保留 ${kept.join('、')}；` : ''}`
        + `另有 ${scanned.foreign.length} 个其它应用的键不会被触碰。此操作不可撤销。`;

    return { readable: true, summary, keys, kept, missing, foreign: scanned.foreign, details, notes };
  }

  /** 执行前的中文说明（等价于 `plan().summary` 的显式入口，方便 UI 只拿文案） */
  describePlan(plan: ResetPlan): string {
    return plan.summary;
  }

  /**
   * 生成"需要二次确认的动作描述"。**这一步仍然不改任何数据。**
   *
   * 返回 `null` 的情况只有一种：连存储都读不了（隐私模式）。这时不该弹"确认清除"的框，
   * 因为不管用户点确定还是取消，结果都一样是失败 —— 直接如实告诉他就行。
   */
  requestConfirm(storage: ResetStorage, options?: ResetOptions): ResetConfirmation | null {
    const planned = this.plan(storage, options);
    // 存储读不了时不弹确认框：不管点确定还是取消，结果都一样是失败，弹了只会让人以为"能删但删不掉"
    if (!planned.readable) return null;

    this.tokenSeq += 1;
    this.pendingToken = `reset-${Date.now().toString(36)}-${this.tokenSeq}`;

    const willDelete = planned.keys.length === 0
      ? '本次没有可清除的键。'
      : `将删除 ${planned.keys.length} 个键：${planned.details.map((d) => `${d.key}（${d.content}）`).join('；')}。`;
    const willKeep = planned.kept.length === 0
      ? '不会保留任何键。'
      : `将保留 ${planned.kept.length} 个键：${planned.kept.join('、')}。`;

    return {
      required: true,
      action: `清除本地存储里的全部「上帝沙盘」数据（${planned.keys.length} 个键）${planned.kept.length > 0 ? `，保留 ${planned.kept.join('、')}` : ''}`,
      title: '重置到初始状态？',
      message:
        `${willDelete}${willKeep}`
        + `同域下其它应用的 ${planned.foreign.length} 个键不会被触碰（绝不调用 storage.clear()）。`
        + '删除后无法撤销：如果当前世界还需要，请先「导出 JSON」再重置。',
      confirmLabel: '确认重置',
      cancelLabel: '取消',
      token: this.pendingToken,
      plan: planned,
    };
  }

  /**
   * 执行重置。**必须传** `requestConfirm()` 返回的确认对象。
   *
   * 没有确认对象时如实拒绝（`ok: false` + 中文说明），而不是"顺手就清了" ——
   * 这条规矩的代价只是多一次调用，收益是"任何误点都不会删档"。
   */
  apply(storage: ResetStorage, confirmation?: ResetConfirmation): ResetResult {
    if (!confirmation) {
      return {
        ok: false,
        removed: [],
        absent: [],
        failed: [],
        kept: [],
        message: '需要二次确认：请先调用 requestConfirm() 并把返回的确认对象传进来（防止误点直接清档）。本次未做任何改动。',
      };
    }
    if (confirmation.token !== this.pendingToken) {
      return {
        ok: false,
        removed: [],
        absent: [],
        failed: [],
        kept: confirmation.plan.kept,
        message: '这次确认已经失效（令牌不匹配：可能已经执行过一次，或期间又点了别的重置）。本次未做任何改动，请重新确认。',
      };
    }
    // 令牌一次性：立刻作废，同一个确认对象不可能删两遍
    this.pendingToken = null;

    const scanned = scanOwnKeys(storage);
    if (!scanned.ok) {
      return {
        ok: false,
        removed: [],
        absent: [],
        failed: [],
        kept: confirmation.plan.kept,
        message: `读取本地存储失败，本次未做任何改动：${scanned.reason}`,
      };
    }
    const present = new Set(scanned.own);

    const removed: string[] = [];
    const absent: string[] = [];
    const failed: { key: string; reason: string }[] = [];
    for (const key of confirmation.plan.keys) {
      if (!present.has(key)) {
        absent.push(key);
        continue;
      }
      try {
        storage.removeItem(key);
        removed.push(key);
      } catch (error) {
        failed.push({ key, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    // 删完之后再扫一遍做**校验**：只报告"确认已经不在了"的键。
    // 不校验的话，"removeItem 没抛异常"会被当成"删掉了"，而实际上存储可能根本没变
    // （某些浏览器的隐私模式就是这样：接口在，写入被丢掉）。
    const after = scanOwnKeys(storage);
    const stillThere = after.ok ? new Set(after.own) : new Set<string>();
    const verified = removed.filter((key) => !stillThere.has(key));
    const notVerified = removed.filter((key) => stillThere.has(key));

    const keptPresent = confirmation.plan.kept.filter((key) => after.ok && after.own.includes(key));
    const ok = failed.length === 0 && notVerified.length === 0;
    const parts = [
      `已清除 ${verified.length} 个键`,
      absent.length > 0 ? `${absent.length} 个本来就不存在` : '',
      keptPresent.length > 0 ? `保留 ${keptPresent.join('、')}` : '',
      failed.length > 0 ? `${failed.length} 个删除失败（${failed.map((f) => `${f.key}：${f.reason}`).join('；')}）` : '',
      notVerified.length > 0 ? `${notVerified.length} 个删除后仍然存在（存储可能被禁用，改动没生效）` : '',
    ].filter((part) => part.length > 0);

    return {
      ok,
      removed: verified,
      absent,
      failed,
      kept: keptPresent,
      message: `${ok ? '重置完成' : '重置未完全成功'}：${parts.join('，')}。`
        + (stillThere.size === 0 ? '本地存储里已经没有本应用的数据了，刷新页面即回到初始状态。' : ''),
    };
  }

  /** 执行后的中文说明（等价于 `apply().message` 的显式入口） */
  describeResult(result: ResetResult): string {
    return result.message;
  }
}

// ---------------------------------------------------------------- 内部

/**
 * 扫一遍存储，分出"本应用的键"和"别人的键"。
 *
 * ⚠ 必须**先把键全收集完再删**：`key(i)` 是按索引取的，
 * 一边遍历一边 `removeItem` 会让后面的索引整体前移，结果漏删一半 —— 这是这类代码最常见的坑。
 * 这里只做"收集"，删除永远发生在 `apply()` 里、在收集完成之后。
 */
function scanOwnKeys(storage: ResetStorage): { ok: true; own: string[]; foreign: string[] } | { ok: false; reason: string } {
  let total = 0;
  try {
    total = storage.length;
  } catch (error) {
    return { ok: false, reason: `读取存储长度失败：${error instanceof Error ? error.message : String(error)}（隐私模式下 localStorage 会直接抛异常）` };
  }

  const own: string[] = [];
  const foreign: string[] = [];
  for (let i = 0; i < total; i += 1) {
    let key: string | null = null;
    try {
      key = storage.key(i);
    } catch (error) {
      return { ok: false, reason: `枚举存储键失败：${error instanceof Error ? error.message : String(error)}` };
    }
    if (typeof key !== 'string' || key.length === 0) continue;
    if (key.startsWith(STORAGE_KEY_PREFIX)) own.push(key);
    else foreign.push(key);
  }
  return { ok: true, own, foreign };
}
